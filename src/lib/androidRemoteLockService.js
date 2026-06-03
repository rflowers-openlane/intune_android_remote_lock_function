const graphRoot = 'https://graph.microsoft.com/v1.0';
const graphResource = 'https://graph.microsoft.com';
const defaultMaxDeviceCount = 10;

async function handleAndroidRemoteLockRequest(options) {
  const {
    body,
    request,
    context,
    correlationId,
    env = process.env,
    fetchImpl = fetch,
    sleepImpl = sleep
  } = options;

  validateCaller(request, env);

  const dryRun = body?.dryRun !== false;
  const resetPasscode = body?.resetPasscode !== false;
  const syncDevice = body?.syncDevice !== false;
  const userPrincipalName = normalizeOptionalString(body?.userPrincipalName);
  const userId = normalizeOptionalString(body?.userId);
  const maxDeviceCount = normalizePositiveInteger(body?.maxDeviceCount, defaultMaxDeviceCount);

  if (!userPrincipalName && !userId) {
    return result(400, correlationId, {
      error: 'Provide either userPrincipalName or userId.'
    });
  }

  const token = await getManagedIdentityGraphToken({ env, fetchImpl });
  const user = await resolveUser({ userId, userPrincipalName, token, fetchImpl });
  const devices = await findAndroidDevicesForUser({
    userId: user.id,
    token,
    fetchImpl,
    context
  });
  const eligibleDevices = devices.filter(isCompanyOwned);
  const skippedDevices = devices
    .filter((device) => !isCompanyOwned(device))
    .map((device) => ({
      ...device,
      reason: 'Device is not company-owned.'
    }));

  if (eligibleDevices.length > maxDeviceCount) {
    return result(409, correlationId, {
      dryRun,
      resetPasscode,
      syncDevice,
      user: userSummary(user),
      matchedDeviceCount: devices.length,
      eligibleDeviceCount: eligibleDevices.length,
      skippedDeviceCount: skippedDevices.length,
      devices,
      eligibleDevices,
      skippedDevices,
      actionResults: [],
      error: `Eligible device count ${eligibleDevices.length} exceeds maxDeviceCount ${maxDeviceCount}. No remote actions were sent.`
    });
  }

  const actionResults = [];

  if (!dryRun) {
    for (const device of eligibleDevices) {
      const deviceResults = [];

      if (resetPasscode) {
        const previousResetResult = await getLatestDeviceActionResult({
          managedDeviceId: device.id,
          actionName: 'resetPasscode',
          token,
          fetchImpl
        });
        const resetResult = await runDeviceAction({
          actionName: 'resetPasscode',
          managedDeviceId: device.id,
          token,
          fetchImpl
        });
        const resetActionResult = resetResult.ok
          ? await waitForNewDeviceActionResult({
            managedDeviceId: device.id,
            actionName: 'resetPasscode',
            previousStartDateTime: previousResetResult?.startDateTime,
            token,
            fetchImpl,
            sleepImpl
          })
          : null;

        deviceResults.push({
          ...resetResult,
          actionState: resetActionResult?.actionState,
          passcode: resetActionResult?.passcode,
          errorCode: resetActionResult?.errorCode,
          lastUpdatedDateTime: resetActionResult?.lastUpdatedDateTime
        });
      }

      if (syncDevice) {
        deviceResults.push(await runDeviceAction({
          actionName: 'syncDevice',
          managedDeviceId: device.id,
          token,
          fetchImpl
        }));
      }

      deviceResults.push(await runDeviceAction({
        actionName: 'remoteLock',
        managedDeviceId: device.id,
        token,
        fetchImpl
      }));

      actionResults.push({
        id: device.id,
        deviceName: device.deviceName,
        actions: deviceResults
      });
    }
  }

  context.log(
    JSON.stringify({
      correlationId,
      user: user.userPrincipalName,
      matchedDeviceCount: devices.length,
      eligibleDeviceCount: eligibleDevices.length,
      skippedDeviceCount: skippedDevices.length,
      dryRun,
      resetPasscode,
      syncDevice
    })
  );

  return result(200, correlationId, {
    dryRun,
    resetPasscode,
    syncDevice,
    user: userSummary(user),
    matchedDeviceCount: devices.length,
    eligibleDeviceCount: eligibleDevices.length,
    skippedDeviceCount: skippedDevices.length,
    devices,
    eligibleDevices,
    skippedDevices,
    actionResults
  });
}

function validateCaller(request, env) {
  const expectedSecret = env.OKTA_SHARED_SECRET;

  if (!expectedSecret) {
    return;
  }

  const providedSecret = request.headers.get('x-okta-shared-secret');

  if (!providedSecret || providedSecret !== expectedSecret) {
    const error = new Error('Unauthorized caller.');
    error.statusCode = 401;
    throw error;
  }
}

async function getManagedIdentityGraphToken({ env, fetchImpl }) {
  const identityEndpoint = env.IDENTITY_ENDPOINT;
  const identityHeader = env.IDENTITY_HEADER;

  if (!identityEndpoint || !identityHeader) {
    throw new Error('Managed identity endpoint is unavailable. Run this Function in Azure with managed identity enabled.');
  }

  const url = new URL(identityEndpoint);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', graphResource);

  const response = await fetchImpl(url, {
    headers: {
      'X-IDENTITY-HEADER': identityHeader
    }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw new Error(`Failed to obtain managed identity token. Status: ${response.status}`);
  }

  return payload.access_token;
}

async function resolveUser({ userId, userPrincipalName, token, fetchImpl }) {
  const userIdentifier = encodeURIComponent(userId || userPrincipalName);
  return getGraph(`${graphRoot}/users/${userIdentifier}?$select=id,userPrincipalName,displayName`, token, fetchImpl);
}

async function findAndroidDevicesForUser({ userId, token, fetchImpl, context }) {
  const matchingDevices = [];
  const select = '$select=id,deviceName,managedDeviceName,operatingSystem,osVersion,model,manufacturer,managementState,managedDeviceOwnerType,userPrincipalName,azureADDeviceId,serialNumber,lastSyncDateTime,deviceEnrollmentType,managementAgent';
  let nextUrl = `${graphRoot}/users/${encodeURIComponent(userId)}/managedDevices?${select}`;

  while (nextUrl) {
    let page;

    try {
      page = await getGraph(nextUrl, token, fetchImpl);
    } catch (error) {
      if (error.statusCode === 404) {
        context.log(`No managed devices relationship was returned for user ${userId}. Treating as zero devices.`);
        return matchingDevices;
      }

      throw error;
    }

    const devices = Array.isArray(page.value) ? page.value : [];

    for (const device of devices) {
      if (isAndroidDevice(device)) {
        matchingDevices.push({
          id: device.id,
          deviceName: device.deviceName,
          managedDeviceName: device.managedDeviceName,
          operatingSystem: device.operatingSystem,
          osVersion: device.osVersion,
          model: device.model,
          manufacturer: device.manufacturer,
          managementState: device.managementState,
          managedDeviceOwnerType: device.managedDeviceOwnerType,
          enrolledUserPrincipalName: device.userPrincipalName,
          azureADDeviceId: device.azureADDeviceId,
          serialNumber: device.serialNumber,
          lastSyncDateTime: device.lastSyncDateTime,
          deviceEnrollmentType: device.deviceEnrollmentType,
          managementAgent: device.managementAgent
        });
      }
    }

    context.log(`Scanned ${devices.length} managed devices for target user from current page.`);
    nextUrl = page['@odata.nextLink'];
  }

  return matchingDevices;
}

function isAndroidDevice(device) {
  const operatingSystem = (device.operatingSystem || '').toLowerCase();
  const managementAgent = (device.managementAgent || '').toLowerCase();

  return operatingSystem.includes('android') ||
    managementAgent.includes('android');
}

function isCompanyOwned(device) {
  const ownerType = (device.managedDeviceOwnerType || '').toLowerCase();
  return ownerType === 'company' || ownerType === 'corporate' || ownerType === 'companyowned';
}

async function runDeviceAction({ actionName, managedDeviceId, token, fetchImpl }) {
  const response = await fetchImpl(
    `${graphRoot}/deviceManagement/managedDevices/${encodeURIComponent(managedDeviceId)}/${actionName}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    }
  );

  if (response.ok) {
    return {
      action: actionName,
      ok: true,
      status: response.status
    };
  }

  const text = await response.text();
  return {
    action: actionName,
    ok: false,
    status: response.status,
    error: text
  };
}

async function waitForNewDeviceActionResult({
  managedDeviceId,
  actionName,
  previousStartDateTime,
  token,
  fetchImpl,
  sleepImpl,
  maxAttempts = 8,
  delayMs = 3000
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await getLatestDeviceActionResult({
      managedDeviceId,
      actionName,
      token,
      fetchImpl
    });

    if (result && result.startDateTime !== previousStartDateTime) {
      if (result.actionState === 'done' || result.passcode || result.errorCode) {
        return result;
      }
    }

    if (attempt < maxAttempts - 1) {
      await sleepImpl(delayMs);
    }
  }

  return null;
}

async function getLatestDeviceActionResult({ managedDeviceId, actionName, token, fetchImpl }) {
  const device = await getGraph(
    `${graphRoot}/deviceManagement/managedDevices/${encodeURIComponent(managedDeviceId)}?$select=id,deviceActionResults`,
    token,
    fetchImpl
  );
  const results = Array.isArray(device.deviceActionResults) ? device.deviceActionResults : [];

  return results
    .filter((entry) => entry.actionName === actionName)
    .sort((a, b) => new Date(b.startDateTime || 0) - new Date(a.startDateTime || 0))[0] || null;
}

async function getGraph(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });

  if (response.ok) {
    return response.json();
  }

  const text = await response.text();
  const error = new Error(`Graph request failed. Status: ${response.status}. ${text}`);
  error.statusCode = response.status;
  throw error;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function userSummary(user) {
  return {
    id: user.id,
    userPrincipalName: user.userPrincipalName,
    displayName: user.displayName
  };
}

function result(status, correlationId, body) {
  return {
    status,
    body: {
      correlationId,
      ...body
    }
  };
}

module.exports = {
  handleAndroidRemoteLockRequest,
  validateCaller,
  getManagedIdentityGraphToken,
  resolveUser,
  findAndroidDevicesForUser,
  isAndroidDevice,
  isCompanyOwned,
  runDeviceAction,
  getLatestDeviceActionResult,
  waitForNewDeviceActionResult,
  normalizeOptionalString
};

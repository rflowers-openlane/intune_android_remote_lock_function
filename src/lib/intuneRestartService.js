const graphRoot = 'https://graph.microsoft.com/v1.0';
const graphResource = 'https://graph.microsoft.com';

async function handleRestartDevicesRequest(options) {
  const {
    body,
    request,
    context,
    correlationId,
    env = process.env,
    fetchImpl = fetch
  } = options;

  validateCaller(request, env);

  const dryRun = body?.dryRun !== false;
  const userPrincipalName = normalizeOptionalString(body?.userPrincipalName);
  const userId = normalizeOptionalString(body?.userId);

  if (!userPrincipalName && !userId) {
    return {
      status: 400,
      body: {
        correlationId,
        error: 'Provide either userPrincipalName or userId.'
      }
    };
  }

  const token = await getManagedIdentityGraphToken({ env, fetchImpl });
  const user = await resolveUser({ userId, userPrincipalName, token, fetchImpl });
  const devices = await findWindowsDevicesForUser({
    userId: user.id,
    token,
    fetchImpl,
    context
  });
  const restartResults = [];

  if (!dryRun) {
    for (const device of devices) {
      const restartResult = await restartManagedDevice({
        managedDeviceId: device.id,
        token,
        fetchImpl
      });

      restartResults.push({
        id: device.id,
        deviceName: device.deviceName,
        status: restartResult.status,
        ok: restartResult.ok,
        error: restartResult.error
      });
    }
  }

  context.log(
    JSON.stringify({
      correlationId,
      user: user.userPrincipalName,
      matchedDeviceCount: devices.length,
      dryRun
    })
  );

  return {
    status: 200,
    body: {
      correlationId,
      dryRun,
      user: {
        id: user.id,
        userPrincipalName: user.userPrincipalName,
        displayName: user.displayName
      },
      matchedDeviceCount: devices.length,
      devices,
      restartResults
    }
  };
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

async function findWindowsDevicesForUser({ userId, token, fetchImpl, context }) {
  const matchingDevices = [];
  const select = '$select=id,deviceName,operatingSystem,managementState,managedDeviceOwnerType,userPrincipalName,azureADDeviceId,serialNumber,lastSyncDateTime';
  let nextUrl = `${graphRoot}/users/${encodeURIComponent(userId)}/managedDevices?${select}`;

  while (nextUrl) {
    const page = await getGraph(nextUrl, token, fetchImpl);
    const devices = Array.isArray(page.value) ? page.value : [];

    for (const device of devices) {
      if (device.operatingSystem?.toLowerCase() === 'windows') {
        matchingDevices.push({
          id: device.id,
          deviceName: device.deviceName,
          operatingSystem: device.operatingSystem,
          managementState: device.managementState,
          managedDeviceOwnerType: device.managedDeviceOwnerType,
          enrolledUserPrincipalName: device.userPrincipalName,
          azureADDeviceId: device.azureADDeviceId,
          serialNumber: device.serialNumber,
          lastSyncDateTime: device.lastSyncDateTime
        });
      }
    }

    context.log(`Scanned ${devices.length} managed devices for target user from current page.`);
    nextUrl = page['@odata.nextLink'];
  }

  return matchingDevices;
}

async function restartManagedDevice({ managedDeviceId, token, fetchImpl }) {
  const response = await fetchImpl(
    `${graphRoot}/deviceManagement/managedDevices/${encodeURIComponent(managedDeviceId)}/rebootNow`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    }
  );

  if (response.ok) {
    return {
      ok: true,
      status: response.status
    };
  }

  const text = await response.text();
  return {
    ok: false,
    status: response.status,
    error: text
  };
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

module.exports = {
  handleRestartDevicesRequest,
  validateCaller,
  getManagedIdentityGraphToken,
  resolveUser,
  findWindowsDevicesForUser,
  restartManagedDevice,
  normalizeOptionalString
};

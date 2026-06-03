const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleAndroidRemoteLockRequest,
  isAndroidDevice,
  isCompanyOwned
} = require('../src/lib/androidRemoteLockService');

const targetUserId = '11111111-1111-1111-1111-111111111111';

test('returns 400 when no user identifier is provided', async () => {
  const calls = [];
  const result = await handleAndroidRemoteLockRequest({
    body: {},
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error('fetch should not be called');
    }
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Provide either userPrincipalName or userId.');
  assert.equal(calls.length, 0);
});

test('rejects requests when the optional shared secret does not match', async () => {
  await assert.rejects(
    handleAndroidRemoteLockRequest({
      body: {
        userPrincipalName: 'person@example.com'
      },
      request: requestWithHeaders({
        'x-okta-shared-secret': 'wrong-secret'
      }),
      context: testContext(),
      correlationId: 'test-correlation-id',
      env: testEnv({
        OKTA_SHARED_SECRET: 'expected-secret'
      }),
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      }
    }),
    /Unauthorized caller/
  );
});

test('dry-run returns corporate-owned Android devices without sending actions', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleAndroidRemoteLockRequest({
    body: {
      userPrincipalName: 'person@example.com'
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl,
    sleepImpl: async () => {}
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, true);
  assert.equal(result.body.resetPasscode, true);
  assert.equal(result.body.syncDevice, true);
  assert.equal(result.body.matchedDeviceCount, 2);
  assert.equal(result.body.eligibleDeviceCount, 1);
  assert.equal(result.body.skippedDeviceCount, 1);
  assert.deepEqual(result.body.eligibleDevices.map((device) => device.id), ['android-company-1']);
  assert.deepEqual(result.body.skippedDevices.map((device) => device.id), ['android-personal-1']);
  assert.deepEqual(result.body.actionResults, []);
  assert.equal(calls.some((call) => call.url.endsWith('/remoteLock')), false);
});

test('returns zero matched devices when the user has no managed device relationship', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls, {
    managedDevicesStatus: 404
  });

  const result = await handleAndroidRemoteLockRequest({
    body: {
      userPrincipalName: 'person@example.com',
      dryRun: false
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl,
    sleepImpl: async () => {}
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, false);
  assert.equal(result.body.resetPasscode, true);
  assert.equal(result.body.syncDevice, true);
  assert.equal(result.body.matchedDeviceCount, 0);
  assert.equal(result.body.eligibleDeviceCount, 0);
  assert.equal(result.body.skippedDeviceCount, 0);
  assert.deepEqual(result.body.devices, []);
  assert.deepEqual(result.body.eligibleDevices, []);
  assert.deepEqual(result.body.skippedDevices, []);
  assert.deepEqual(result.body.actionResults, []);
  assert.equal(calls.some((call) => call.method === 'POST'), false);
});

test('live request resets passcode, syncs, and remote locks eligible corporate-owned Android devices by default', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleAndroidRemoteLockRequest({
    body: {
      userPrincipalName: 'person@example.com',
      dryRun: false
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl
  });

  const actionCalls = calls.filter((call) => call.method === 'POST');

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, false);
  assert.equal(result.body.resetPasscode, true);
  assert.equal(result.body.syncDevice, true);
  assert.equal(actionCalls.length, 3);
  assert.match(actionCalls[0].url, /managedDevices\/android-company-1\/resetPasscode$/);
  assert.match(actionCalls[1].url, /managedDevices\/android-company-1\/syncDevice$/);
  assert.match(actionCalls[2].url, /managedDevices\/android-company-1\/remoteLock$/);
  assert.equal(actionCalls.some((call) => call.url.includes('android-personal-1')), false);
  assert.deepEqual(result.body.actionResults[0].actions.map((entry) => entry.action), ['resetPasscode', 'syncDevice', 'remoteLock']);
  assert.equal(result.body.actionResults[0].actions[0].passcode, '123456');
  assert.equal(result.body.actionResults[0].actions[0].actionState, 'done');
});

test('live request can skip resetPasscode when requested', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleAndroidRemoteLockRequest({
    body: {
      userPrincipalName: 'person@example.com',
      dryRun: false,
      resetPasscode: false
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl
  });

  const actionCalls = calls.filter((call) => call.method === 'POST');

  assert.equal(result.status, 200);
  assert.equal(result.body.resetPasscode, false);
  assert.equal(actionCalls.length, 2);
  assert.match(actionCalls[0].url, /managedDevices\/android-company-1\/syncDevice$/);
  assert.match(actionCalls[1].url, /managedDevices\/android-company-1\/remoteLock$/);
});

test('live request can skip syncDevice when requested', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleAndroidRemoteLockRequest({
    body: {
      userPrincipalName: 'person@example.com',
      dryRun: false,
      syncDevice: false
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl
  });

  const actionCalls = calls.filter((call) => call.method === 'POST');

  assert.equal(result.status, 200);
  assert.equal(result.body.syncDevice, false);
  assert.equal(actionCalls.length, 2);
  assert.match(actionCalls[0].url, /managedDevices\/android-company-1\/resetPasscode$/);
  assert.match(actionCalls[1].url, /managedDevices\/android-company-1\/remoteLock$/);
});

test('blocks live action when eligible devices exceed maxDeviceCount', async () => {
  const calls = [];
  const result = await handleAndroidRemoteLockRequest({
    body: {
      userPrincipalName: 'person@example.com',
      dryRun: false,
      maxDeviceCount: 1
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl: buildGraphFetchMock(calls, { includeSecondCompanyDevice: true })
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.eligibleDeviceCount, 2);
  assert.equal(calls.some((call) => call.url.endsWith('/remoteLock')), false);
});

test('isAndroidDevice detects Android devices conservatively', () => {
  assert.equal(isAndroidDevice({ operatingSystem: 'Android' }), true);
  assert.equal(isAndroidDevice({ operatingSystem: 'Android Enterprise' }), true);
  assert.equal(isAndroidDevice({ managementAgent: 'androidEnterprise' }), true);
  assert.equal(isAndroidDevice({ operatingSystem: 'iOS' }), false);
});

test('isCompanyOwned detects company ownership values', () => {
  assert.equal(isCompanyOwned({ managedDeviceOwnerType: 'company' }), true);
  assert.equal(isCompanyOwned({ managedDeviceOwnerType: 'corporate' }), true);
  assert.equal(isCompanyOwned({ managedDeviceOwnerType: 'companyOwned' }), true);
  assert.equal(isCompanyOwned({ managedDeviceOwnerType: 'personal' }), false);
  assert.equal(isCompanyOwned({}), false);
});

function buildGraphFetchMock(calls, options = {}) {
  let resetPasscodeCalled = false;

  return async (input, init = {}) => {
    const url = input.toString();
    const method = init.method || 'GET';
    calls.push({ url, method, init });

    if (url.startsWith('http://identity.local/token')) {
      return jsonResponse(200, {
        access_token: 'managed-identity-token'
      });
    }

    if (url.includes('/users/person%40example.com')) {
      return jsonResponse(200, {
        id: targetUserId,
        userPrincipalName: 'person@example.com',
        displayName: 'Example Person'
      });
    }

    if (url.includes(`/users/${targetUserId}/managedDevices?`)) {
      if (options.managedDevicesStatus === 404) {
        return textResponse(404, 'Managed devices relationship not found.');
      }

      return jsonResponse(200, {
        value: [
          {
            id: 'android-company-1',
            deviceName: 'ANDROID-CORP-01',
            managedDeviceName: 'ANDROID-CORP-01',
            operatingSystem: 'Android',
            osVersion: '14',
            model: 'Pixel 8',
            manufacturer: 'Google',
            managementState: 'managed',
            managedDeviceOwnerType: 'company',
            userPrincipalName: 'person@example.com',
            azureADDeviceId: 'azure-android-company-1',
            serialNumber: 'android-company-serial-1',
            lastSyncDateTime: '2026-05-29T00:00:00Z',
            deviceEnrollmentType: 'androidEnterpriseFullyManaged',
            managementAgent: 'androidEnterprise'
          },
          {
            id: 'android-personal-1',
            deviceName: 'ANDROID-PERSONAL-01',
            operatingSystem: 'Android',
            osVersion: '14',
            model: 'Pixel 7',
            manufacturer: 'Google',
            managementState: 'managed',
            managedDeviceOwnerType: 'personal',
            userPrincipalName: 'person@example.com',
            serialNumber: 'android-personal-serial-1',
            lastSyncDateTime: '2026-05-29T00:00:00Z',
            deviceEnrollmentType: 'androidEnterpriseWorkProfile',
            managementAgent: 'androidEnterprise'
          },
          ...(options.includeSecondCompanyDevice ? [
            {
              id: 'android-company-2',
              deviceName: 'ANDROID-CORP-02',
              operatingSystem: 'Android',
              osVersion: '14',
              model: 'Galaxy S24',
              manufacturer: 'Samsung',
              managementState: 'managed',
              managedDeviceOwnerType: 'company',
              userPrincipalName: 'person@example.com',
              serialNumber: 'android-company-serial-2',
              lastSyncDateTime: '2026-05-29T00:00:00Z',
              deviceEnrollmentType: 'androidEnterpriseFullyManaged',
              managementAgent: 'androidEnterprise'
            }
          ] : []),
          {
            id: 'iphone-1',
            deviceName: 'IPHONE-01',
            operatingSystem: 'iOS'
          }
        ]
      });
    }

    if (url.includes('/deviceManagement/managedDevices/android-company-1?$select=id,deviceActionResults')) {
      return jsonResponse(200, {
        id: 'android-company-1',
        deviceActionResults: [
          resetPasscodeCalled ? {
            actionName: 'resetPasscode',
            actionState: 'done',
            startDateTime: '2026-05-29T14:54:18Z',
            lastUpdatedDateTime: '2026-05-29T14:54:21Z',
            passcode: '123456',
            errorCode: 0
          } : {
            actionName: 'resetPasscode',
            actionState: 'done',
            startDateTime: '2026-05-29T13:00:00Z',
            lastUpdatedDateTime: '2026-05-29T13:00:03Z',
            passcode: 'old-passcode',
            errorCode: 0
          }
        ]
      });
    }

    for (const action of ['resetPasscode', 'syncDevice', 'remoteLock']) {
      if (method === 'POST' && url.endsWith(`/managedDevices/android-company-1/${action}`)) {
        if (action === 'resetPasscode') {
          resetPasscodeCalled = true;
        }

        return textResponse(204, '');
      }
    }

    return textResponse(404, `Unexpected mock URL: ${url}`);
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body || '{}'),
    text: async () => body
  };
}

function requestWithHeaders(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    headers: {
      get: (name) => normalized[name.toLowerCase()] || null
    }
  };
}

function testContext() {
  return {
    log: () => {},
    error: () => {}
  };
}

function testEnv(overrides = {}) {
  return {
    IDENTITY_ENDPOINT: 'http://identity.local/token',
    IDENTITY_HEADER: 'identity-header',
    ...overrides
  };
}

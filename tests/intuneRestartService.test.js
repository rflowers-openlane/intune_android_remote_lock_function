const test = require('node:test');
const assert = require('node:assert/strict');
const { handleRestartDevicesRequest } = require('../src/lib/intuneRestartService');

const targetUserId = '11111111-1111-1111-1111-111111111111';

test('returns 400 when no user identifier is provided', async () => {
  const calls = [];
  const result = await handleRestartDevicesRequest({
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
    handleRestartDevicesRequest({
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

test('dry-run returns matching devices without sending restart commands', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleRestartDevicesRequest({
    body: {
      userPrincipalName: 'person@example.com'
    },
    request: requestWithHeaders(),
    context: testContext(),
    correlationId: 'test-correlation-id',
    env: testEnv(),
    fetchImpl
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, true);
  assert.equal(result.body.matchedDeviceCount, 1);
  assert.equal(result.body.devices[0].id, 'device-1');
  assert.deepEqual(result.body.restartResults, []);
  assert.equal(calls.some((call) => call.url.endsWith('/rebootNow')), false);
});

test('live request sends restart command only to matched devices', async () => {
  const calls = [];
  const fetchImpl = buildGraphFetchMock(calls);

  const result = await handleRestartDevicesRequest({
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

  const rebootCalls = calls.filter((call) => call.url.endsWith('/rebootNow'));

  assert.equal(result.status, 200);
  assert.equal(result.body.dryRun, false);
  assert.equal(result.body.matchedDeviceCount, 1);
  assert.equal(rebootCalls.length, 1);
  assert.match(rebootCalls[0].url, /managedDevices\/device-1\/rebootNow$/);
  assert.equal(result.body.restartResults[0].ok, true);
  assert.equal(result.body.restartResults[0].status, 204);
});

function buildGraphFetchMock(calls) {
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
      return jsonResponse(200, {
        value: [
          {
            id: 'device-1',
            deviceName: 'WINDOWS-DEVICE-01',
            operatingSystem: 'Windows',
            managementState: 'managed',
            managedDeviceOwnerType: 'company',
            userPrincipalName: 'person@example.com',
            azureADDeviceId: 'azure-device-1',
            serialNumber: 'serial-1',
            lastSyncDateTime: '2026-05-26T00:00:00Z'
          },
          {
            id: 'device-2',
            deviceName: 'IOS-DEVICE-02',
            operatingSystem: 'iOS',
            managementState: 'managed',
            managedDeviceOwnerType: 'company',
            userPrincipalName: 'someone@example.com',
            azureADDeviceId: 'azure-device-2',
            serialNumber: 'serial-2',
            lastSyncDateTime: '2026-05-26T00:00:00Z'
          }
        ]
      });
    }

    if (method === 'POST' && url.endsWith('/managedDevices/device-1/rebootNow')) {
      return textResponse(204, '');
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

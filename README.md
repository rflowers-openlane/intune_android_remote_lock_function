# Intune Android Remote Lock Function

This project is a separate HTTP-triggered Azure Function intended to be called by Okta Workflows.

Its job is:

1. Receive a target user from Okta.
2. Resolve that user in Microsoft Graph.
3. Retrieve Intune managed devices associated with that user.
4. Filter those devices to Android.
5. Split matching Android devices into eligible company-owned devices and skipped non-company-owned devices.
6. Return the matching device list.
7. In live mode, run `resetPasscode`, optionally run `syncDevice`, and then run `remoteLock` for eligible company-owned Android devices.

The Function uses the Azure Function App's managed identity. It does not store Microsoft Graph credentials in code or in Okta.

## Important Android Notes

`remoteLock` locks the device screen, but the user can unlock it with the existing PIN/passcode. It is useful as a no-wipe remote action, but it is not a full device lockdown by itself.

`resetPasscode` defaults to `true`. Microsoft documents different Android reset behavior by enrollment type. Some Android Enterprise enrollment types reset only the work profile passcode, not the full device PIN. Test against your real enrollment model before using it broadly.

This Function never wipes, retires, deletes, or removes enrollment from a device.

## Endpoint

Method:

```text
POST
```

Route:

```text
/api/remoteLockAndroidDevicesForUser
```

Authentication level:

```text
function
```

External callers need the Azure Function URL with the `code=` function key.

## Request Body

Dry-run example:

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": true,
  "resetPasscode": true
}
```

You can also pass `userId` instead of `userPrincipalName`.

`dryRun` defaults to `true`.

`resetPasscode` defaults to `true`.

`syncDevice` defaults to `true`.

Live default reset passcode, sync, and remote lock:

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": false
}
```

Live remote lock only, skipping passcode reset:

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": false,
  "resetPasscode": false
}
```

If the target user exists but has no Intune managed devices associated with the user account, the Function returns `200 OK` with `matchedDeviceCount: 0`, `eligibleDeviceCount: 0`, `skippedDeviceCount: 0`, `devices: []`, `eligibleDevices: []`, `skippedDevices: []`, and `actionResults: []`.

## Optional Shared Secret

If `OKTA_SHARED_SECRET` is configured as an app setting, callers must include:

```text
x-okta-shared-secret: <secret value>
```

This is an extra guardrail on top of the Azure Function key.

## Response

Dry-run response shape:

```json
{
  "correlationId": "generated-request-id",
  "dryRun": true,
  "resetPasscode": true,
  "syncDevice": true,
  "user": {
    "id": "user-object-id",
    "userPrincipalName": "person@example.com",
    "displayName": "Person Name"
  },
  "matchedDeviceCount": 2,
  "eligibleDeviceCount": 1,
  "skippedDeviceCount": 1,
  "devices": [],
  "eligibleDevices": [],
  "skippedDevices": [],
  "actionResults": []
}
```

Live response shape:

```json
{
  "correlationId": "generated-request-id",
  "dryRun": false,
  "resetPasscode": true,
  "syncDevice": true,
  "matchedDeviceCount": 1,
  "eligibleDeviceCount": 1,
  "skippedDeviceCount": 0,
  "actionResults": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "ANDROID-CORP-01",
      "actions": [
        {
          "action": "resetPasscode",
          "ok": true,
          "status": 204,
          "actionState": "done",
          "passcode": "generated-passcode-from-intune",
          "errorCode": 0,
          "lastUpdatedDateTime": "2026-05-29T14:54:21Z"
        },
        {
          "action": "syncDevice",
          "ok": true,
          "status": 204
        },
        {
          "action": "remoteLock",
          "ok": true,
          "status": 204
        }
      ]
    }
  ]
}
```

## Safety Behavior

The Function will not send remote actions when:

- The request omits both `userPrincipalName` and `userId`.
- The shared secret is configured and the caller does not provide the matching header.
- The target user cannot be resolved in Microsoft Graph.
- No matching Android Intune devices are found.
- No matching Android devices are company-owned.
- `dryRun` is omitted or set to `true`.
- The eligible device count exceeds `maxDeviceCount`.

Non-company-owned Android devices are returned in `skippedDevices` and are never sent remote actions.

`maxDeviceCount` defaults to `10`. Override it in the request if needed:

```json
{
  "maxDeviceCount": 25
}
```

## Managed Identity Permissions

Enable a system-assigned managed identity on the Function App and grant these Microsoft Graph application permissions with admin consent:

- `User.Read.All`
- `DeviceManagementManagedDevices.Read.All`
- `DeviceManagementManagedDevices.PrivilegedOperations.All`

After the Function App exists, an Entra admin can assign the required Microsoft Graph application roles with:

```powershell
.\scripts\grant-graph-app-roles.ps1 `
  -ResourceGroupName '<resource-group>' `
  -FunctionAppName '<function-app-name>'
```

## Graph Calls Used

Resolve the user:

```text
GET https://graph.microsoft.com/v1.0/users/{userPrincipalName-or-userId}?$select=id,userPrincipalName,displayName
```

List devices associated with the user:

```text
GET https://graph.microsoft.com/v1.0/users/{userId}/managedDevices?$select=...
```

Passcode reset:

```text
POST https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/{managedDeviceId}/resetPasscode
```

Retrieve the reset action result, including the generated passcode when available:

```text
GET https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/{managedDeviceId}?$select=id,deviceActionResults
```

The Function polls `deviceActionResults` after `resetPasscode` and returns the generated passcode in `actionResults`. Treat this value as sensitive and store it only in a restricted ticket, secure Okta table, or other approved legal-hold record.

Optional device sync:

```text
POST https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/{managedDeviceId}/syncDevice
```

Remote lock:

```text
POST https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/{managedDeviceId}/remoteLock
```

## Local Validation

Run syntax checks:

```powershell
npm run check
```

Run mocked tests:

```powershell
npm test
```

The mocked tests do not call Azure, Microsoft Graph, Intune, or Okta.

## Azure Portal Build Steps

1. Create a new private GitHub repo or branch for this folder.
2. Push the contents of `intune-android-remote-lock-function`.
3. In Azure Portal, create a new Function App:
   - Hosting: Flex Consumption if available.
   - Runtime: Node.js.
   - Version: 22 or 20.
   - OS: Linux.
   - Monitoring: Application Insights enabled.
4. Turn on system-assigned managed identity:
   - Function App > Identity > System assigned > On > Save.
5. Add app setting:
   - `OKTA_SHARED_SECRET = <long random value>`
6. Use Deployment Center to connect the Function App to the GitHub repo/branch.
7. Wait for deployment success.
8. Run `scripts/grant-graph-app-roles.ps1` in Azure Cloud Shell PowerShell.
9. Restart the Function App.
10. Test in Azure with `dryRun: true`.

## Azure Test/Run Body

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": true,
  "resetPasscode": true
}
```

Headers:

```text
Content-Type: application/json
x-okta-shared-secret: <secret value>
```

Leave query parameters empty in Azure Portal Test/Run.

## First Live Test Body

Default live mode resets passcode, syncs, then remote locks:

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": false
}
```

To skip passcode reset deliberately:

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": false,
  "resetPasscode": false
}
```

## Okta Workflow Body

Start with dry run:

```json
{
  "userPrincipalName": "{{user.email}}",
  "dryRun": true,
  "resetPasscode": true
}
```

After validating the returned device list, switch to live mode:

```json
{
  "userPrincipalName": "{{user.email}}",
  "dryRun": false
}
```

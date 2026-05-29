# Intune Device Restart Function

This project is an HTTP-triggered Azure Function intended to be called by Okta Workflows.

Its job is:

1. Receive a target user from Okta.
2. Resolve that user in Microsoft Graph.
3. Retrieve Intune managed devices associated with that user.
4. Filter those devices to Windows.
5. Return the matching device list.
6. Restart those devices only when the request explicitly sets `dryRun` to `false`.

The Function is designed so no Microsoft Graph username, password, client secret, or certificate is stored in the script. In Azure, it uses the Function App's system-assigned managed identity to request a Microsoft Graph access token.

## What Has Been Built

Project folder:

```text
intune-device-restart-function/
```

Important files:

```text
.funcignore
host.json
package.json
local.settings.sample.json
scripts/new-function-app.ps1
scripts/publish-function.ps1
src/functions/restartDevicesForPrimaryUser.js
src/lib/intuneRestartService.js
scripts/grant-graph-app-roles.ps1
tests/intuneRestartService.test.js
```

`src/functions/restartDevicesForPrimaryUser.js` contains the Azure Function endpoint.

`src/lib/intuneRestartService.js` contains the Microsoft Graph and Intune workflow logic.

`scripts/grant-graph-app-roles.ps1` is a setup helper for an Entra admin. It enables the Function App's system-assigned managed identity and assigns the Microsoft Graph application permissions needed by the Function.

`tests/intuneRestartService.test.js` uses mocked Microsoft Graph and managed identity responses. It does not call Azure, Graph, Intune, or Okta.

Nothing in this project has been deployed or executed against Intune.

## Endpoint

Method:

```text
POST
```

Route:

```text
/api/restartDevicesForPrimaryUser
```

Authentication level:

```text
function
```

This means callers need a valid Azure Functions host/function key unless the Function App authentication model is changed later.

## Request Body

`POST /api/restartDevicesForPrimaryUser`

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": true
}
```

You can pass either `userPrincipalName` or `userId`.

Examples:

```json
{
  "userPrincipalName": "person@example.com",
  "dryRun": true
}
```

```json
{
  "userId": "00000000-0000-0000-0000-000000000000",
  "dryRun": false
}
```

`dryRun` defaults to `true`.

The Function sends Intune restart commands only when:

```json
{
  "dryRun": false
}
```

## Optional Shared Secret

If `OKTA_SHARED_SECRET` is configured as an app setting, callers must include:

```text
x-okta-shared-secret: <secret value>
```

This is an extra guardrail on top of the Azure Functions key. If `OKTA_SHARED_SECRET` is not configured, the Function skips this check.

## Response

Dry-run response shape:

```json
{
  "correlationId": "generated-request-id",
  "dryRun": true,
  "user": {
    "id": "user-object-id",
    "userPrincipalName": "person@example.com",
    "displayName": "Person Name"
  },
  "matchedDeviceCount": 1,
  "devices": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "WINDOWS-DEVICE-01",
      "operatingSystem": "Windows",
      "managementState": "managed",
      "managedDeviceOwnerType": "company",
      "enrolledUserPrincipalName": "person@example.com",
      "azureADDeviceId": "entra-device-id",
      "serialNumber": "serial-number",
      "lastSyncDateTime": "2026-05-26T00:00:00Z"
    }
  ],
  "restartResults": []
}
```

Live restart response shape:

```json
{
  "correlationId": "generated-request-id",
  "dryRun": false,
  "matchedDeviceCount": 1,
  "devices": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "WINDOWS-DEVICE-01"
    }
  ],
  "restartResults": [
    {
      "id": "intune-managed-device-id",
      "deviceName": "WINDOWS-DEVICE-01",
      "status": 204,
      "ok": true
    }
  ]
}
```

## Managed Identity Permissions

Enable a system-assigned managed identity on the Function App and grant these Microsoft Graph application permissions with admin consent:

- `User.Read.All`
- `DeviceManagementManagedDevices.Read.All`
- `DeviceManagementManagedDevices.PrivilegedOperations.All`

The Function does not store Graph credentials. It gets a Microsoft Graph token from the Azure Functions managed identity endpoint at runtime.

After the Function App exists, an Entra admin can assign the required Microsoft Graph application roles with:

```powershell
.\scripts\grant-graph-app-roles.ps1 `
  -ResourceGroupName '<resource-group>' `
  -FunctionAppName '<function-app-name>'
```

That script performs these actions:

1. Enables system-assigned managed identity on the Function App.
2. Resolves the Microsoft Graph service principal.
3. Finds the Graph application roles listed above.
4. Assigns those roles to the Function App managed identity.

The script requires an Azure CLI session signed in as an account with enough Entra privileges to assign Microsoft Graph application permissions.

## Graph Calls Used

The Function uses the managed identity token to call Microsoft Graph:

Resolve the user:

```text
GET /users/{userPrincipalName-or-userId}?$select=id,userPrincipalName,displayName
```

List Intune managed devices associated with the user:

```text
GET /users/{userId}/managedDevices?$select=...
```

Restart a device:

```text
POST /deviceManagement/managedDevices/{managedDeviceId}/rebootNow
```

The Function filters the returned devices to `operatingSystem` equal to `Windows` and follows `@odata.nextLink` when Graph returns paged managed device results.

## Deployment Notes

Recommended security posture:

- Keep the HTTP trigger `authLevel` set to `function`.
- Store the Function key in Okta Workflow connection/configuration.
- Store `OKTA_SHARED_SECRET` as an Azure Function App setting or remove that app setting if you want to rely only on Function key auth.
- Restrict inbound network access where possible, or place the Function behind API Management if you need stricter Okta token validation.

Provision a new Azure Function App later with:

```powershell
.\scripts\new-function-app.ps1 `
  -ResourceGroupName '<resource-group>' `
  -Location '<azure-region>' `
  -FunctionAppName '<function-app-name>' `
  -OktaSharedSecret '<optional-shared-secret>'
```

That script creates:

- Resource group.
- Storage account.
- Application Insights component.
- Linux Azure Function App on the consumption plan.
- System-assigned managed identity.
- Required Function App settings.

Publish code later with:

```powershell
.\scripts\publish-function.ps1 -FunctionAppName '<function-app-name>'
```

Then assign Microsoft Graph app roles:

```powershell
.\scripts\grant-graph-app-roles.ps1 `
  -ResourceGroupName '<resource-group>' `
  -FunctionAppName '<function-app-name>'
```

## Okta Workflow Shape

Recommended Okta inputs:

```text
userPrincipalName
dryRun
```

Recommended Okta HTTP action:

```text
POST https://<function-app-name>.azurewebsites.net/api/restartDevicesForPrimaryUser?code=<function-key>
```

Headers:

```text
Content-Type: application/json
x-okta-shared-secret: <optional-shared-secret>
```

Body:

```json
{
  "userPrincipalName": "{{user.email}}",
  "dryRun": true
}
```

Start with `dryRun: true`. Change to `dryRun: false` only after the returned device list has been validated.

## Safety Behavior

The Function will not restart anything when:

- The request omits both `userPrincipalName` and `userId`.
- The shared secret is configured and the caller does not provide the matching header.
- The target user cannot be resolved in Microsoft Graph.
- No matching Windows Intune devices are found.
- `dryRun` is omitted or set to `true`.

The Function only targets Intune managed devices with:

```text
operatingSystem eq 'Windows'
```

It does not restart macOS, iOS, Android, or other non-Windows devices.

## Local Development

Install dependencies:

```powershell
npm install
```

Create `local.settings.json` from `local.settings.sample.json`, then run:

```powershell
func start
```

Local runs cannot use the Azure Functions managed identity endpoint unless hosted in Azure.

## Current Status

This repository currently contains the draft Function project and setup documentation only.

Completed locally:

- Project files created.
- Function source created.
- Graph/Intune workflow logic separated into a testable library.
- Managed identity permission helper created.
- Provisioning helper created.
- Publish helper created.
- Unit tests created with mocked Graph and managed identity responses.
- JavaScript syntax check completed.
- PowerShell helper parse check completed.
- Unit tests completed.

Not done yet:

- No `npm install`.
- No local Function host run.
- No Azure deployment.
- No Graph permissions assigned.
- No Okta Workflow configured.
- No Intune devices queried.
- No restart command sent.

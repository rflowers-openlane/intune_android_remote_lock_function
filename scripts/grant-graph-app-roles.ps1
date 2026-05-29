param(
    [Parameter(Mandatory = $true)]
    [string] $ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string] $FunctionAppName
)

$ErrorActionPreference = 'Stop'

$graphAppId = '00000003-0000-0000-c000-000000000000'
$requiredRoles = @(
    'User.Read.All',
    'DeviceManagementManagedDevices.Read.All',
    'DeviceManagementManagedDevices.PrivilegedOperations.All'
)

Write-Host "Ensuring system-assigned managed identity is enabled on $FunctionAppName..."
$identity = az functionapp identity assign `
    --resource-group $ResourceGroupName `
    --name $FunctionAppName `
    --output json | ConvertFrom-Json

if (-not $identity.principalId) {
    throw 'Could not resolve the Function App managed identity principalId.'
}

$principalId = $identity.principalId

Write-Host "Function App managed identity principalId: $principalId"
Write-Host 'Resolving Microsoft Graph service principal...'
$graphSp = az ad sp show --id $graphAppId --output json | ConvertFrom-Json

if (-not $graphSp.id) {
    throw 'Could not resolve Microsoft Graph service principal.'
}

$existingAssignments = az rest `
    --method GET `
    --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" `
    --output json | ConvertFrom-Json

foreach ($roleName in $requiredRoles) {
    $role = $graphSp.appRoles | Where-Object {
        $_.value -eq $roleName -and $_.allowedMemberTypes -contains 'Application'
    } | Select-Object -First 1

    if (-not $role) {
        throw "Could not find Microsoft Graph application role: $roleName"
    }

    $alreadyAssigned = $existingAssignments.value | Where-Object {
        $_.resourceId -eq $graphSp.id -and $_.appRoleId -eq $role.id
    }

    if ($alreadyAssigned) {
        Write-Host "Already assigned: $roleName"
        continue
    }

    Write-Host "Assigning: $roleName"
    $body = @{
        principalId = $principalId
        resourceId = $graphSp.id
        appRoleId = $role.id
    } | ConvertTo-Json -Compress

    az rest `
        --method POST `
        --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principalId/appRoleAssignments" `
        --headers 'Content-Type=application/json' `
        --body $body `
        --output none
}

Write-Host 'Done. The Function App managed identity has the required Microsoft Graph app roles.'

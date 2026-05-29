param(
    [Parameter(Mandatory = $true)]
    [string] $ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string] $Location,

    [Parameter(Mandatory = $true)]
    [string] $FunctionAppName,

    [string] $StorageAccountName,

    [string] $AppInsightsName,

    [string] $OktaSharedSecret,

    [ValidateSet('20', '22')]
    [string] $NodeRuntimeVersion = '22'
)

$ErrorActionPreference = 'Stop'

if (-not $StorageAccountName) {
    $normalized = ($FunctionAppName.ToLowerInvariant() -replace '[^a-z0-9]', '')
    $suffix = -join ((48..57) + (97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
    $StorageAccountName = "st$($normalized.Substring(0, [Math]::Min(14, $normalized.Length)))$suffix"
}

if ($StorageAccountName.Length -lt 3 -or $StorageAccountName.Length -gt 24 -or $StorageAccountName -notmatch '^[a-z0-9]+$') {
    throw 'StorageAccountName must be 3-24 characters and contain only lowercase letters and numbers.'
}

if (-not $AppInsightsName) {
    $AppInsightsName = "appi-$FunctionAppName"
}

Write-Host "Creating resource group $ResourceGroupName in $Location..."
az group create `
    --name $ResourceGroupName `
    --location $Location `
    --output none

Write-Host "Creating storage account $StorageAccountName..."
az storage account create `
    --name $StorageAccountName `
    --resource-group $ResourceGroupName `
    --location $Location `
    --sku Standard_LRS `
    --kind StorageV2 `
    --https-only true `
    --min-tls-version TLS1_2 `
    --allow-blob-public-access false `
    --output none

Write-Host "Creating Application Insights component $AppInsightsName..."
az monitor app-insights component create `
    --app $AppInsightsName `
    --location $Location `
    --resource-group $ResourceGroupName `
    --application-type web `
    --output none

$appInsightsConnectionString = az monitor app-insights component show `
    --app $AppInsightsName `
    --resource-group $ResourceGroupName `
    --query connectionString `
    --output tsv

Write-Host "Creating Function App $FunctionAppName with system-assigned managed identity..."
az functionapp create `
    --name $FunctionAppName `
    --resource-group $ResourceGroupName `
    --storage-account $StorageAccountName `
    --consumption-plan-location $Location `
    --runtime node `
    --runtime-version $NodeRuntimeVersion `
    --functions-version 4 `
    --os-type Linux `
    --assign-identity `
    --output none

$settings = @(
    'FUNCTIONS_WORKER_RUNTIME=node'
    'WEBSITE_RUN_FROM_PACKAGE=1'
    "APPLICATIONINSIGHTS_CONNECTION_STRING=$appInsightsConnectionString"
)

if ($OktaSharedSecret) {
    $settings += "OKTA_SHARED_SECRET=$OktaSharedSecret"
}

Write-Host 'Applying Function App settings...'
az functionapp config appsettings set `
    --name $FunctionAppName `
    --resource-group $ResourceGroupName `
    --settings $settings `
    --output none

Write-Host ''
Write-Host 'Provisioning complete.'
Write-Host "Function App: $FunctionAppName"
Write-Host "Resource group: $ResourceGroupName"
Write-Host "Storage account: $StorageAccountName"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '1. Publish the function code with scripts/publish-function.ps1.'
Write-Host '2. Assign Graph app roles with scripts/grant-graph-app-roles.ps1.'
Write-Host '3. Configure Okta to call the Function URL with a Function key.'

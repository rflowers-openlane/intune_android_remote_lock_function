param(
    [Parameter(Mandatory = $true)]
    [string] $FunctionAppName,

    [string] $ProjectPath = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = 'Stop'

Push-Location $ProjectPath
try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm is not installed or is not available on PATH.'
    }

    if (-not (Get-Command func -ErrorAction SilentlyContinue)) {
        throw 'Azure Functions Core Tools is not installed or is not available on PATH.'
    }

    Write-Host 'Installing npm dependencies...'
    npm install

    Write-Host 'Running local tests...'
    npm test

    Write-Host "Publishing to Azure Function App $FunctionAppName..."
    func azure functionapp publish $FunctionAppName
}
finally {
    Pop-Location
}

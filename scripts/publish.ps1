[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ResourceGroup,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$StaticSiteName,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SubscriptionId
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$context = az account show -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $context.id -ne $SubscriptionId) { throw 'Azure CLI context does not match the approved deployment subscription.' }
if (-not (Get-Command swa -ErrorAction SilentlyContinue)) { throw 'Install an approved Azure Static Web Apps CLI before publishing.' }
Push-Location $root
try {
    if (-not (Test-Path '.env.local')) { throw 'Configure public SPA identifiers in .env.local before building.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed; nothing was published.' }
    $env:SWA_CLI_DEPLOYMENT_TOKEN = az staticwebapp secrets list --name $StaticSiteName --resource-group $ResourceGroup --query properties.apiKey -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $env:SWA_CLI_DEPLOYMENT_TOKEN) { throw 'Cannot acquire the publishing credential.' }
    swa deploy .\dist --env production --no-use-keychain
    if ($LASTEXITCODE -ne 0) { throw 'Static frontend publishing failed.' }
} finally {
    Remove-Item Env:\SWA_CLI_DEPLOYMENT_TOKEN -ErrorAction SilentlyContinue
    Pop-Location
}

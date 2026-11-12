[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$SpaOrigin,
    [switch]$PreauthorizeAzureCli
)
$ErrorActionPreference = 'Stop'
if ($SpaOrigin -notmatch '^https://[a-zA-Z0-9.-]+$') { throw 'SpaOrigin must be an exact HTTPS origin.' }
$context = az account show -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $context.tenantId -ne $TenantId) { throw 'Azure CLI tenant does not match the deployment tenant.' }
$token = az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain a Microsoft Graph token.' }
$headers = @{ Authorization = "Bearer $token" }
function Graph([string]$Method, [string]$Path, $Body) {
    $args = @{ Method = $Method; Uri = "https://graph.microsoft.com/v1.0/$Path"; Headers = $headers; ContentType = 'application/json' }
    if ($null -ne $Body) { $args.Body = $Body | ConvertTo-Json -Depth 20 -Compress }
    Invoke-RestMethod @args
}
function Get-OrCreateApp([string]$Name, $Definition) {
    $found = @( (Graph GET "applications?`$filter=displayName%20eq%20'$Name'" $null).value )
    if ($found.Count -gt 1) { throw "More than one application named $Name; refusing an ambiguous update." }
    if ($found.Count -eq 1) { return $found[0] }
    Graph POST 'applications' $Definition
}
function Get-OrCreatePrincipal([string]$AppId) {
    $found = @( (Graph GET "servicePrincipals?`$filter=appId%20eq%20'$AppId'" $null).value )
    if ($found.Count -eq 1) { return $found[0] }
    Graph POST 'servicePrincipals' @{ appId = $AppId }
}
$scopeId = 'c0d695c5-b32f-42aa-93d8-3b55ca5f0600'
$roleId = '5ddc728c-fab2-485f-9f88-1130c274bd43'
$api = Get-OrCreateApp 'insurance-pilot-api' @{
    displayName = 'insurance-pilot-api'; signInAudience = 'AzureADMyOrg'
    api = @{
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes = @(@{
            id = $scopeId; value = 'access_as_user'; type = 'Admin'; isEnabled = $true
            adminConsentDisplayName = 'Use the insurance content moderation pilot'
            adminConsentDescription = 'Submit synthetic insurance prompts for moderation as the signed-in user.'
        })
    }
    appRoles = @(@{
        id = $roleId; value = 'Pilot.User'; displayName = 'Insurance pilot user'
        description = 'Use the insurance content moderation pilot.'; allowedMemberTypes = @('User'); isEnabled = $true
    })
}
$spa = Get-OrCreateApp 'insurance-pilot-spa' @{
    displayName = 'insurance-pilot-spa'; signInAudience = 'AzureADMyOrg'
    spa = @{ redirectUris = @("$SpaOrigin/", 'http://localhost:5173/') }
    requiredResourceAccess = @(@{ resourceAppId = $api.appId; resourceAccess = @(@{ id = $scopeId; type = 'Scope' }) })
}
if ($api.signInAudience -ne 'AzureADMyOrg' -or $spa.signInAudience -ne 'AzureADMyOrg') {
    throw 'Existing pilot registrations are not single-tenant; refusing to reconfigure them.'
}
if (@($api.appRoles | Where-Object { $_.id -eq $roleId -and $_.value -eq 'Pilot.User' }).Count -ne 1 -or
    @($api.api.oauth2PermissionScopes | Where-Object { $_.id -eq $scopeId -and $_.value -eq 'access_as_user' }).Count -ne 1) {
    throw 'An existing pilot registration uses a different contract; inspect it before changing permissions.'
}
$preauthorized = @(@{ appId = $spa.appId; delegatedPermissionIds = @($scopeId) })
if ($PreauthorizeAzureCli) { $preauthorized += @{ appId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; delegatedPermissionIds = @($scopeId) } }
Graph PATCH "applications/$($api.id)" @{
    identifierUris = @("api://$($api.appId)")
    api = @{ requestedAccessTokenVersion = 2; preAuthorizedApplications = $preauthorized }
} | Out-Null
$redirects = @($spa.spa.redirectUris) + @("$SpaOrigin/", 'http://localhost:5173/') | Select-Object -Unique
Graph PATCH "applications/$($spa.id)" @{ spa = @{ redirectUris = @($redirects) } } | Out-Null
$apiPrincipal = Get-OrCreatePrincipal $api.appId
$spaPrincipal = Get-OrCreatePrincipal $spa.appId
Graph PATCH "servicePrincipals/$($apiPrincipal.id)" @{ appRoleAssignmentRequired = $true } | Out-Null
Graph PATCH "servicePrincipals/$($spaPrincipal.id)" @{ appRoleAssignmentRequired = $true } | Out-Null
$me = Graph GET 'me?$select=id' $null
$assignments = @( (Graph GET "servicePrincipals/$($apiPrincipal.id)/appRoleAssignedTo" $null).value )
if (-not ($assignments | Where-Object { $_.principalId -eq $me.id -and $_.appRoleId -eq $roleId })) {
    Graph POST "servicePrincipals/$($apiPrincipal.id)/appRoleAssignedTo" @{
        principalId = $me.id; resourceId = $apiPrincipal.id; appRoleId = $roleId
    } | Out-Null
}
$spaAssignments = @( (Graph GET "servicePrincipals/$($spaPrincipal.id)/appRoleAssignedTo" $null).value )
if (-not ($spaAssignments | Where-Object { $_.principalId -eq $me.id })) {
    Graph POST "servicePrincipals/$($spaPrincipal.id)/appRoleAssignedTo" @{
        principalId = $me.id; resourceId = $spaPrincipal.id; appRoleId = '00000000-0000-0000-0000-000000000000'
    } | Out-Null
}
$consents = @( (Graph GET "oauth2PermissionGrants?`$filter=clientId%20eq%20'$($spaPrincipal.id)'%20and%20resourceId%20eq%20'$($apiPrincipal.id)'" $null).value )
if (-not ($consents | Where-Object { $_.consentType -eq 'AllPrincipals' -and $_.scope.Split(' ') -contains 'access_as_user' })) {
    Graph POST 'oauth2PermissionGrants' @{
        clientId = $spaPrincipal.id; consentType = 'AllPrincipals'; resourceId = $apiPrincipal.id; scope = 'access_as_user'
    } | Out-Null
}
# Return public application identifiers only. No token, user details or credentials are persisted.
[pscustomobject]@{ tenantId = $TenantId; apiClientId = $api.appId; spaClientId = $spa.appId; apiScope = "api://$($api.appId)/access_as_user" }

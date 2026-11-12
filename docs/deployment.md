# Insurance Decision-1 deployment guide

Supply approved values from your own Azure environment. This repository does not
include a preconfigured deployment, environment identifiers or live acceptance
results. Creating or updating Azure resources requires separate approval.

## Endpoints and access

- **Web demo:** `https://<SWA_DEFAULT_HOSTNAME>`
- **Protected API:** `POST https://<APIM_NAME>.azure-api.net/moderation/analyze`
- **Deployment scope:** your approved subscription and resource group.

The SPA uses single-tenant Microsoft Entra authentication with authorization code
and PKCE. Register its exact application root as a SPA redirect and logout URI.
Login and logout use same-tab redirects, not popups. Startup processes the redirect
response and restores the active account before enabling API actions.

Users need assignment to the API enterprise application's `Pilot.User` role and
to the SPA enterprise application. API requests require delegated `access_as_user`;
tenant membership alone does not grant access. No model keys or client secrets
belong in the SPA.

## Compatible resources for reuse

Use [the reuse template](../infra/reuse.bicep) only after verifying:

| Purpose | Required resource |
|---|---|
| Gateway | APIM with a compatible tier and system-assigned managed identity |
| Decision inference | Foundry account supporting Microsoft-Decision-1 |
| General Content Safety | The same Foundry account, if its Content Safety endpoint supports all four categories |
| Application Insights | An approved component and its linked workspace |

APIM needs resource-scoped Cognitive Services User access to Foundry.
The template adds Monitoring Metrics Publisher scoped to Application Insights
for managed-identity logging. Preserve unrelated APIs, policies, model deployments,
network settings and identity configuration.

The template creates a Free Static Web App, a Microsoft-Decision-1 version 1
DataZoneStandard deployment, the `insurance-moderation` API at `/moderation`,
`insurance-*` named values and API diagnostics/logger. Verify current model
lifecycle, regional availability, quota, capacity and costs before deployment.

For new resource parents instead, follow [Azure setup](azure-setup.md) and
[the greenfield template](../infra/main.bicep). Do not apply that template over
shared existing resources.

## Local deployment configuration

The `.azure/` directory is ignored by Git. Keep environment-specific parameter
files and generated identity output there; never commit deployment credentials.
Create `.azure/reuse.parameters.json` locally with all required reuse inputs:

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "apimName": { "value": "<APIM_NAME>" },
    "foundryName": { "value": "<FOUNDRY_ACCOUNT_NAME>" },
    "appInsightsName": { "value": "<APPLICATION_INSIGHTS_NAME>" },
    "tenantId": { "value": "<TENANT_ID>" },
    "apiAudience": { "value": "<API_CLIENT_ID>" },
    "webLocation": { "value": "<SUPPORTED_WEB_REGION>" },
    "staticSiteName": { "value": "<STATIC_SITE_NAME>" },
    "modelDeploymentName": { "value": "<DECISION_DEPLOYMENT_NAME>" },
    "modelCapacity": { "value": 1 }
  }
}
```

Replace every placeholder and set `modelCapacity` to an explicitly approved value
within verified quota; the example is not a capacity recommendation.
`scripts/setup-entra.ps1` can create/update the pilot registrations with Graph
administration permissions. It assigns the executing user initially, not every
tenant user. Its optional Azure CLI preauthorization is only for delegated smoke
tests; the API still requires the scope and user role.

After explicit approval:

```powershell
npm run generate:policy
az account set --subscription '<SUBSCRIPTION_ID>'
az deployment group validate --resource-group '<RESOURCE_GROUP>' `
  --template-file .\infra\reuse.bicep --parameters .\.azure\reuse.parameters.json
az deployment group what-if --resource-group '<RESOURCE_GROUP>' `
  --template-file .\infra\reuse.bicep --parameters .\.azure\reuse.parameters.json
# Review changes before executing.
az deployment group create --resource-group '<RESOURCE_GROUP>' `
  --name '<ARM_DEPLOYMENT_NAME>' --mode Incremental `
  --template-file .\infra\reuse.bicep --parameters .\.azure\reuse.parameters.json
```

## Build and publish

Copy `.env.example` to the ignored `.env.local` and populate:

```text
VITE_TENANT_ID=<TENANT_ID>
VITE_CLIENT_ID=<SPA_CLIENT_ID>
VITE_API_SCOPE=api://<API_CLIENT_ID>/access_as_user
VITE_API_BASE_URL=https://<APIM_NAME>.azure-api.net
```

Build-time Vite values are public. Keep keys, tokens and secrets out of these
settings. Register the exact hosted origin and configure APIM CORS accordingly.

The publishing script requires an authorized Azure CLI context, an approved
`swa` CLI installation and explicit target parameters:

```powershell
.\scripts\publish.ps1 -ResourceGroup '<RESOURCE_GROUP>' `
  -StaticSiteName '<STATIC_SITE_NAME>' -SubscriptionId '<SUBSCRIPTION_ID>'
```

It builds the SPA, obtains the publishing token in process memory, publishes to
production and clears the token without writing it to a file or command argument.

## Verify your environment

Run local checks from [the README](../README.md#verify-without-azure), then complete
[the live acceptance checklist](azure-setup.md#live-acceptance-checklist) against
explicitly approved resources. Local tests do not establish live acceptance.

The live smoke script also requires explicit targets:

```powershell
.\scripts\verify-live.ps1 -GatewayUrl 'https://<APIM_NAME>.azure-api.net' `
  -SpaOrigin 'https://<SWA_DEFAULT_HOSTNAME>' `
  -ApiScope 'api://<API_CLIENT_ID>/access_as_user'
```

These requests invoke the model and may incur charges. Smoke checks do not replace
interactive browser authentication or the full calibration/held-out evaluation.
Retain request IDs and verify model contracts, both blocking stages, authentication,
input limits and CORS in your environment.

The API diagnostics use informational traces, zero request/response body capture
and no client-IP logging. Verify actual Application Insights ingestion before
claiming telemetry proof of backend call order or absence. Do not enable body or
Authorization-header logging, or weaken shared authentication, to diagnose it.

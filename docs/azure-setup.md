# Azure setup and live acceptance

This page describes the **greenfield** setup using `infra/main.bicep`. To reuse
compatible resources in your own environment, use
[deployment details](deployment.md) and `infra/reuse.bicep`.
Creating resources incurs charges; do not run the greenfield template over
shared existing resources.

## Prerequisites and design limits

- Verify Microsoft-Decision-1 access, deployment type, **current regional availability and quota**, and actual Foundry endpoint in your subscription.
- Use `DataZoneStandard` in the required data zone when available. `GlobalStandard` is an explicit operator choice that may process inference globally; no fallback is performed.
- Confirm Content Safety and APIM availability in the chosen inference region. Static Web Apps has its own `webLocation` parameter (default `westeurope`); it need not share the inference region.
- Obtain current prices for APIM Developer, model capacity/inference, Content Safety, logs and hosting. APIM Developer has no production SLA and has standing costs.
- The pilot uses public Azure endpoints, protected by identity and RBAC. It does **not** provide private-link isolation. A private version requires separate APIM networking/SKU, DNS and backend firewall planning; ACA alone would not solve these requirements.
- Resource provisioning requires appropriate contributor privileges; RBAC deployment requires role assignment permissions. Entra configuration requires appropriate application and consent administration permissions.
- Restrict policy-edit permissions: a policy editor can act as APIM's managed identity against its granted resources.

## 1. Configure single-tenant Entra registrations

Use Microsoft Entra admin center / App registrations. These are Microsoft Graph objects, not ordinary ARM resource declarations in this template.

**API application**

1. Create a single-tenant registration, for example `insurance-pilot-api`.
2. Under Expose an API, use application ID URI `api://<API_CLIENT_ID>` and an admin-consent delegated scope named `access_as_user`.
3. Ensure the API manifest requests **version 2 access tokens** (`api.requestedAccessTokenVersion: 2`). The policy's audience is the API's client GUID, with the tenant's v2 issuer.
4. Define an enabled app role with allowed member type **Users/Groups**, value **`Pilot.User`**.
5. In Enterprise applications, assign only authorized pilot users/groups to this role and enable assignment required. The JWT policy requires both `scp=access_as_user` and `roles=Pilot.User`, so merely having a tenant account is insufficient.

**SPA application**

1. Create a separate single-tenant registration, for example `insurance-pilot-spa`.
2. Add the **Single-page application** platform, not the Web confidential-client platform.
3. Register `http://localhost:5173/` for development if required.
4. Add delegated permission to the API's `access_as_user` scope. Have an administrator grant consent as required by tenant policy. Do not create a client secret or enable implicit grants.
5. Restrict its Enterprise application sign-in to the assigned pilot users as well.
6. After resource provisioning, add `https://<SWA_DEFAULT_HOSTNAME>/` as an exact SPA redirect URI. The same application root is used after logout. MSAL uses authorization code + PKCE and same-tab redirects, not popups.

Keep the tenant GUID, API application GUID and SPA application GUID separate. Do not expose an API resource key in the browser.

## 2. Prepare and validate deployment inputs

```powershell
Copy-Item .\infra\pilot.bicepparam.example .\infra\pilot.bicepparam
# Edit the copy: region, globally unique prefix, tenant/API IDs and publisher contact.
npm run generate:policy
az bicep build --file .\infra\main.bicep --stdout > $null
```

The publisher contact is a local deployment input, never a hard-coded personal address in this project. The resource prefix must satisfy Azure naming rules and be globally unique where required.

The template provisions:

- Foundry AIServices account, project and Microsoft-Decision-1 version 1 deployment.
- Content Safety S0.
- APIM Developer with system-assigned managed identity.
- Resource-scoped **Cognitive Services User** role assignments on Foundry and Content Safety.
- Static Web Apps Free resource.
- Workspace-based Application Insights and APIM diagnostics with **zero request/response body bytes**, no request-header logging and client-IP logging disabled.
- An API at `/moderation/analyze`; no APIM subscription key required because Entra authorization is enforced by policy.

APIM named values are nonsecret trusted configuration, all prefixed with `insurance-`:
`insurance-tenant-id`, `insurance-api-audience`, `insurance-allowed-origin`,
`insurance-decision-endpoint`, `insurance-decision-deployment`, `insurance-contentsafety-endpoint`.

The default Foundry URL is `https://<account>.services.ai.azure.com`. Confirm it against the deployed model page before enabling traffic. The model name and deployment name are different concepts.

## 3. Deploy only after explicit approval

After confirming subscription, resource group, costs, quota and region, the operator can run:

```powershell
# Replace values; these commands CREATE or MODIFY Azure resources.
az account set --subscription '<approved-subscription>'
az group create --name '<pilot-resource-group>' --location '<verified-region>'
az deployment group what-if --resource-group '<pilot-resource-group>' --parameters .\infra\pilot.bicepparam
az deployment group create --resource-group '<pilot-resource-group>' --name insurance-pilot --parameters .\infra\pilot.bicepparam
az deployment group show --resource-group '<pilot-resource-group>' --name insurance-pilot --query properties.outputs
```

Allow for RBAC propagation before testing. Do not work around a 403 by enabling anonymous backend access or embedding a key.

The policy's allowed origin defaults to the Static Web App's actual hostname, with no wildcard. To test against a localhost SPA instead, set the exact `allowedOriginOverride` in the parameter file, regenerate/redeploy deliberately and reset it to the hosted origin when finished. Do not allow arbitrary origins; CORS is not a substitute for JWT authorization.

## 4. Build and publish the static frontend

Copy `.env.example` to `.env.local`. Set:

```text
VITE_TENANT_ID=<tenant GUID>
VITE_CLIENT_ID=<SPA application GUID>
VITE_API_SCOPE=api://<API application GUID>/access_as_user
VITE_API_BASE_URL=https://<APIM name>.azure-api.net
```

Register the exact hosted callback URI as above, then:

```powershell
npm run build
```

Publish `dist` to the provisioned Static Web App through an approved Static Web Apps CI deployment task/CLI workflow. Supply the deployment token via the CI secret store or an interactive secure credential mechanism; **do not** put it in `.env`, source, shell history or documentation. No GitHub workflow or deployment token has been created for you.

The CSP permits the default `*.azure-api.net` gateway hosts. If you deliberately configure a custom gateway domain or a sovereign cloud, update the CSP and Entra authority endpoints to the exact approved hosts before publishing. The current template targets Azure public cloud.

The hosted app processes `handleRedirectPromise` on startup at the application root before enabling authentication or API actions. It restores the active account from MSAL's session cache on reload. Same-tab login avoids popup opener/COOP failures that can incorrectly report `user_cancelled`. Authentication does not use `auth-callback.html`; register the application root as the callback. The static site's public assets are not confidential; API calls always require the validated access token and assigned role.

## Live acceptance checklist

Local tests are not a substitute for this checklist. Complete it only against explicitly approved, isolated pilot resources.

1. **Verify actual contract first.** Make an authorized request with four configured `noul` questions to the deployed Foundry endpoint, using an identity with resource-scoped inference permissions. Inspect only a nonsensitive synthetic example. Confirm `answers.<category>.type == "noul"` and numerical `answers.<category>.noul` in [0,1]. Update explicit adapters/fixtures if the Azure raw contract differs; do not broaden parsing speculatively. An example response is in `tests/fixtures/decision-live-benign.json`.
2. Confirm deployment name/version/type, quota, endpoint, request-size limits and token audience. Confirm both backend calls work with APIM's identity and key-based local auth remains disabled.
3. Submit an allowed benign example through the authenticated UI. Verify the policy successfully deploys, the normalized result includes both completed stages and all four general severities, and the original text reaches Content Safety unchanged.
4. Submit a synthetic category-positive example. Inspect all four scores, the threshold comparison, HTTP 403 plus `outcome=blocked_custom`, and `contentSafety.status=skipped`. A model miss is evaluation evidence, not permission to force a fake response.
5. Submit the synthetic general safety examples. If Decision-1 passes and any Content Safety severity is **>=5/7**, expect HTTP 403 and `outcome=blocked_content_safety`, with both stages completed and all scores retained. Below 5, the general gate passes. Use correlated APIM `insurance-pilot` traces (metadata-only `requestId`, stage and outcome) to verify **Decision starts first** and **no Content Safety call starts for a custom-blocked request**. Where available, cross-check backend request counters/logs. Do not enable body/header traces on real data.
6. In an isolated test API/configuration, simulate a Decision timeout, unavailable service, throttling, malformed/missing answer and out-of-range probability. Verify explicit technical errors and zero downstream calls. Do not add a public “force outcome” header or test bypass to the deployed API.
7. Simulate a later Content Safety failure. Verify Decision scores survive and the overall result is technical error, not allowed. The local harness covers these branch semantics, but live network/error mappings still need confirmation. APIM `send-request` null failures cannot reliably distinguish transport errors from timeouts: they map conservatively to 503 `DEPENDENCY_UNAVAILABLE`; explicit upstream 408/504 or a gateway timeout reason maps to 504.
8. Test anonymous, wrong-tenant, wrong-audience, missing-scope and unassigned-role callers; confirm rejection before any backend call. Test CORS from an unapproved origin and request-size limits, remembering nonbrowser callers are protected by identity rather than CORS.
9. Have an insurance-domain reviewer review/freeze synthetic labels. Calibrate only on the 80 calibration cases, version/redeploy/freeze thresholds, then run all 120 held-out cases. Retain the report, request IDs, thresholds and deployment metadata. Report accuracy and latency as measurements, not guarantees; extend to representative independently labeled data before production.
10. Review Azure costs, quotas, token usage, error rates, logging contents and retention. Keep prompt/response logging off. Remove the pilot resource group through your approved change process when no longer needed; no automatic deletion script is included.

### Diagnostics

The generated policy emits a `Dependency call starting` trace before each actual call and a `Moderation finished` trace on response. Trace metadata contains correlation ID, stage, configuration version and outcome, **not prompts, access tokens or response bodies**.

Example workspace query (adapt table names if your logging configuration uses resource-specific tables):

```kusto
AppTraces
| where TimeGenerated > ago(1h)
| where Message in ("Dependency call starting", "Moderation finished")
| project TimeGenerated, Message, Properties
| order by TimeGenerated asc
```

If this query shows no data, verify APIM logger/diagnostic configuration and supported trace ingestion rather than enabling sensitive request-body logging. A missing trace alone is not proof of no backend call.

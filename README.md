# Insurance Decision-1 pilot

ES/EN web demo and bilingual evaluation of **Microsoft-Decision-1 as an insurance-specific custom-category gate** in Azure API Management.

## Deployment overview

Deploy the pilot in your own Azure environment, either with new resources or by
reusing compatible APIM, Foundry (including its Content Safety endpoint), and
monitoring resources. Configure your own hosting URL, tenant, application IDs,
subscription and resource group; no shared deployment is required.
See [deployment details and verification](docs/deployment.md).

**Decision: call the model directly from an APIM policy. No Azure Container Apps intermediary is needed.**

```text
React SPA -- Entra ID token --> APIM
                                |
                                +-- Decision-1 REST API, four noul questions
                                |      |
                                |      +-- any probability >= threshold: 403, stop
                                |      +-- invalid/unavailable: technical error, stop
                                |
                                +-- gate passed: Content Safety text:analyze
```

The policy uses the Foundry resource's `/providers/microsoft/v1/systemone` endpoint with a deployment name in `model`. This is **not** chat completions. `send-request` can perform the HTTPS JSON call and use APIM's managed identity directly. ACA would add an unnecessary hop for this bounded workflow.

## What is included

- React/TypeScript workbench with Microsoft Entra ID sign-in, prompt analysis, per-category probabilities and stage timings.
- Spanish/English selector (Spanish by default), with a persistent language preference, localized UI and ten selectable examples: three safe, five expected custom-block cases and two general Content Safety alert cases. Selecting an example fills the input without sending a request. Changing language translates the examples and current results, but never overwrites the current input or repeats an API call.
- Generated APIM policy with JWT tenant/audience/scope/**Pilot.User role** validation, input limits, rate limiting, managed identity, fail-closed handling and conditional Content Safety calls.
- Four independent insurance categories: claims fraud assistance, coverage deception, discriminatory treatment, unauthorized policyholder data.
- 200 synthetic EN/ES examples: **80 calibration / 120 held-out test**, with translations kept in the same split.
- Bounded batch runner, per-category and per-language metrics, Wilson confidence intervals, false-block rate, p50/p95 latencies, technical errors and JSON/CSV export.
- Bicep for new Azure resources, with no resources deployed automatically.
- Unit tests, a .NET harness that compiles and executes the actual generated policy expressions, and a real-browser smoke check.

## Run locally

Prerequisites: Node.js **22.12+** (tested on Node 22), npm; .NET 9 SDK for the policy harness; Azure CLI with Bicep for infrastructure compilation.

```powershell
npm ci
npm run dev
```

Open the loopback URL printed by Vite. Without Azure settings, inspect the interface and dataset; no cloud requests are made.

To connect after a separately approved deployment:

1. Follow [Azure setup](docs/azure-setup.md), including the **API app role assignment**.
2. Copy `.env.example` to `.env.local` and replace all public identifiers and the gateway URL.
3. Use a single exact APIM CORS origin matching the SPA. For local testing, use the `allowedOriginOverride` Bicep parameter with `http://localhost:5173`, and register the matching callback URI.
4. Restart Vite. Sign in with an assigned pilot account.

The SPA contains no model keys or client secrets. Build-time Vite variables are public. Keep prompt/response body logging disabled.

Localization changes presentation only: trusted category criteria, model questions,
thresholds and the bilingual 200-case evaluation dataset remain unchanged. Technical
IDs, diagnostic details and JSON/CSV field names retain their original format.
If browser storage is unavailable, the UI shows a localized warning and language
switching still works for the current page. Browser smoke tests exercise localized
allow/block/error results and batch reports using offline test-only MSAL/API fixtures;
they are not live model-quality or user-login tests.

## Configuration and response semantics

Edit [the trusted category configuration](config/categories.json), increment its `version`, run `npm run generate:policy`, then redeploy the policy deliberately. The browser cannot supply questions, deployment endpoints or thresholds.

Defaults:

| Setting | Pilot value |
|---|---|
| Per-category threshold | 0.5, provisional |
| Blocking rule | Any category probability **>=** its threshold |
| Content Safety blocking rule | Any Hate, SelfHarm, Sexual or Violence severity **>=5**, using 0..7 severity levels |
| Text / body limit | 4,000 UTF-16 code units / 32,768 UTF-8 bytes |
| Decision / Content Safety timeout | 20 / 15 seconds |
| Rate limit | 120 requests per minute per user, distributed gateway enforcement is approximate |
| Batch concurrency | 2, no automatic retries |

The limits are intentionally conservative pilot settings, **not asserted model maxima**. Before live use, verify the combined instructions, state and questions fit the actual deployed model's token/input limits, and check the current Content Safety input limits. Lower the pilot cap if necessary; never truncate silently.

`POST /moderation/analyze`, request `{ "text": "..." }`. The shared [typed contract](src/contracts.ts) describes results:

- `allowed` / HTTP 200: custom gate passed, Content Safety analysis completed and all general severities are below 5.
- `blocked_custom` / HTTP 403: custom-category rejection, **Content Safety skipped**.
- `blocked_content_safety` / HTTP 403: custom gate passed, but at least one general Content Safety category has severity **>=5**. Both completed analyses and all scores are retained.
- `error`: technical/input/auth failure, not a content verdict. HTTP 400/413, 401, 429, 502/503/504 as applicable.
- Every result includes request ID, configuration version, deployment, category scores and stage states/timings. The Decision result is retained if Content Safety subsequently fails.
- Configuration `insurance-v2` applies both gates in APIM. The trusted general severity threshold is `contentSafetySeverityThreshold` in the category configuration; callers cannot override it. The bilingual UI identifies each blocking stage and matching general category.
- Evaluation precision/recall and benign false-block metrics still measure **Decision-1 custom categories only**; general safety blocks remain classification results in the exported records, not technical errors.
- A skipped stage has `latencyMs: null`, not a fabricated zero. No model-generated written rationale is claimed; displayed rules are application logic.

Both backend calls are orchestrated in the policy's inbound section using `send-request`, followed by a normalized `return-response`. This keeps early blocks and later dependency failures under one contract. There is no public “evaluation bypass” or unguarded forwarding operation.

### Raw Decision response contract

The adapter strictly expects typed raw HTTP answers:

```json
{
  "answers": {
    "claims_fraud_assistance": { "type": "noul", "noul": 0.8 }
  }
}
```

All four configured answer keys are required in a real response. A complete
nonsensitive example is in [the response fixture](tests/fixtures/decision-live-benign.json).
The [System One HTTP reference](https://docs.system-one.dev/en/docs/api) describes
this raw form; SDK-normalized `{ "type": "boolean", "probability": ... }` and other
guessed shapes are rejected. Confirm the contract again when changing model/API versions.

## Evaluate

Use the web **Batch evaluation** tab, or the CLI against the same protected APIM endpoint:

```powershell
$env:APIM_BASE_URL = 'https://YOUR-APIM.azure-api.net'
# Obtain a delegated token for YOUR API scope via an approved interactive OAuth client.
# Do not paste it into source files, command history, reports or chat.
$env:APIM_ACCESS_TOKEN = '<short-lived delegated API token>'
npm run evaluate -- calibration .\evaluation\results\calibration
# Review labels and calibrate config/categories.json using calibration data only.
# Increment configuration version, regenerate and redeploy before freezing thresholds.
npm run evaluate -- test .\evaluation\results\test
Remove-Item Env:\APIM_ACCESS_TOKEN
```

The API requires delegated `access_as_user` and the assigned `Pilot.User` role; an ARM token, APIM subscription key, or service-principal-only token will not work. The CLI does not implement a separate authentication bypass.

Targets are provisional: **recall >=95% for each category and benign false-block rate <=5%**. Only the complete frozen held-out set, consistent configuration/deployment/thresholds, and zero technical errors are eligible for a provisional pass. Reports remain explicitly **not production certification**, even when those targets are met.

The CLI returns 1 for technical/incomplete runs and 2 for a held-out run that does not meet the provisional targets. Error-only requests are never counted as safe. Completed Decision classifications can contribute to classifier metrics even if the later Content Safety stage fails, while the error is still counted and prevents acceptance.

Exports contain the synthetic prompt texts. Downloading them is explicit; the app does not persist prompts in browser storage. No model price is invented: token usage is preserved when returned, and costs must be calculated using verified deployment pricing.

## Verify without Azure

```powershell
npm test
npm run build
npm run check:policy
npm run test:policy
az bicep build --file .\infra\main.bicep --stdout > $null
npm run test:browser
npm audit
```

The browser check uses an existing Microsoft Edge executable on Windows and a temporary loopback server/profile; set `BROWSER_EXECUTABLE` if necessary. It checks desktop/mobile UI states and cleans up its own process/profile. It sends no Azure requests.

The .NET harness executes compiled expressions from [the generated policy](policies/moderation.xml), testing boundary validation, threshold equality, malformed dependency responses, failures and backend call order. It **does not emulate APIM's Entra validation, managed identity, network behavior, policy-expression allowlist or gateway deployment validation**. Bicep compilation likewise does not verify subscription capacity. See the [live acceptance checklist](docs/azure-setup.md#live-acceptance-checklist) before claiming end-to-end success.

## Sources

- [Microsoft-Decision-1 deployment, REST API and evaluation guidance](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision)
- [APIM send-request](https://learn.microsoft.com/azure/api-management/send-request-policy)
- [APIM managed-identity authentication](https://learn.microsoft.com/azure/api-management/authentication-managed-identity-policy)
- [Foundry keyless authentication](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id)
- [Content Safety text analysis](https://learn.microsoft.com/azure/ai-services/content-safety/quickstart-text)

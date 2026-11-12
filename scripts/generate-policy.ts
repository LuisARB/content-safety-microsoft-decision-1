import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../src/contracts";

const root = new URL("../", import.meta.url);
const target = new URL("policies/moderation.xml", root);
const check = process.argv.includes("--check");
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const csharp = (text: string) => `@"${text.replaceAll('"', '""')}"`;
if (new Set(config.categories.map(c => c.id)).size !== 4
  || config.categories.some(c => !Number.isFinite(c.threshold) || c.threshold < 0 || c.threshold > 1)) {
  throw new Error("Four unique categories with valid thresholds are required.");
}
const questions = Object.fromEntries(config.categories.map(({ id, instructions, criteria }) => [
  id, { type: "noul", instructions, criteria },
]));
const categories = config.categories.map(({ id, threshold }) => ({ id, threshold }));
if (!Number.isInteger(config.contentSafetySeverityThreshold)
  || config.contentSafetySeverityThreshold < 0 || config.contentSafetySeverityThreshold > 7) {
  throw new Error("Content Safety severity threshold must be an integer from 0 to 7.");
}
const expression = (body: string) => `@{\n${body}\n}`;
const variable = (name: string, value: string) => `<set-variable name="${name}" value="${xml(value)}" />`;
const normalizedBody = expression(`
  var d = (string)context.Variables["decisionJson"];
  var c = (string)context.Variables["contentJson"];
  var result = new JObject(
    new JProperty("requestId", context.RequestId.ToString()),
    new JProperty("configurationVersion", ${csharp(config.version)}),
    new JProperty("modelDeployment", "{{decision-deployment}}"),
    new JProperty("outcome", (string)context.Variables["outcome"]),
    new JProperty("decision", d.Length == 0 ? new JObject(new JProperty("status", "skipped"), new JProperty("latencyMs", null), new JProperty("categories", new JArray())) : JObject.Parse(d)),
    new JProperty("contentSafety", c.Length == 0 ? new JObject(new JProperty("status", "skipped"), new JProperty("latencyMs", null)) : JObject.Parse(c)),
    new JProperty("gatewayLatencyMs", (DateTime.UtcNow - context.Timestamp).TotalMilliseconds)
  );
  var code = (string)context.Variables["errorCode"];
  if (code.Length > 0) { result["error"] = new JObject(
    new JProperty("code", code), new JProperty("stage", (string)context.Variables["stage"]),
    new JProperty("message", (string)context.Variables["errorMessage"])); }
  return result.ToString(Newtonsoft.Json.Formatting.None);`);
const response = (status: number | string, reason: string) => `
  <trace source="insurance-pilot" severity="information">
    <message>Moderation finished</message>
    <metadata name="requestId" value="@(context.RequestId.ToString())" />
    <metadata name="version" value="${config.version}" />
    <metadata name="outcome" value="@((string)context.Variables[&quot;outcome&quot;])" />
  </trace>
  <return-response>
    <set-status code="${xml(String(status))}" reason="${reason}" />
    <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
    <set-header name="Cache-Control" exists-action="override"><value>no-store</value></set-header>
    <set-header name="X-Request-Id" exists-action="override"><value>@(context.RequestId.ToString())</value></set-header>
    <set-header name="Access-Control-Allow-Origin" exists-action="override"><value>{{allowed-origin}}</value></set-header>
    <set-header name="Access-Control-Expose-Headers" exists-action="override"><value>X-Request-Id, Retry-After</value></set-header>
    <set-header name="Vary" exists-action="override"><value>Origin</value></set-header>
    <set-body>${xml(normalizedBody)}</set-body>
  </return-response>`;
const error = (code: string, message: string, status: number | string) => `
  ${variable("outcome", "error")}
  ${variable("errorCode", code)}
  ${variable("errorMessage", message)}
  ${response(status, "Moderation failed")}`;
const dependencyStatus = `@{ var r = (IResponse)context.Variables["dependency"]; if (r.StatusCode == 429) { return 429; } if (r.StatusCode == 503) { return 503; } if (r.StatusCode == 504 || r.StatusCode == 408) { return 504; } return 502; }`;
const failureStage = (stage: string) => variable(stage === "decision" ? "decisionJson" : "contentJson", expression(`
  return new JObject(new JProperty("status", "error"),
    new JProperty("latencyMs", (DateTime.UtcNow - (DateTime)context.Variables["stageStarted"]).TotalMilliseconds)
    ${stage === "decision" ? ', new JProperty("categories", new JArray())' : ""}).ToString(Newtonsoft.Json.Formatting.None);`));
const call = (stage: "decision" | "contentSafety", url: string, body: string, timeout: number) => `
  ${variable("stage", stage)}
  ${variable("stageStarted", "@(DateTime.UtcNow)")}
  <trace source="insurance-pilot" severity="information">
    <message>Dependency call starting</message>
    <metadata name="requestId" value="@(context.RequestId.ToString())" />
    <metadata name="stage" value="${stage}" />
  </trace>
  <send-request mode="new" response-variable-name="dependency" timeout="${timeout}" ignore-error="true">
    <set-url>${url}</set-url>
    <set-method>POST</set-method>
    <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
    <set-header name="x-ms-client-request-id" exists-action="override"><value>@(context.RequestId.ToString())</value></set-header>
    <set-body>${xml(body)}</set-body>
    <authentication-managed-identity resource="https://cognitiveservices.azure.com" />
  </send-request>
  <choose>
    <when condition="@(context.Variables.GetValueOrDefault&lt;IResponse&gt;(&quot;dependency&quot;) == null)">
      ${failureStage(stage)}
      ${error("DEPENDENCY_UNAVAILABLE", "Dependency request failed or exceeded its time limit.", 503)}
    </when>
    <when condition="@(((IResponse)context.Variables[&quot;dependency&quot;]).StatusCode &lt; 200 || ((IResponse)context.Variables[&quot;dependency&quot;]).StatusCode &gt;= 300)">
      ${failureStage(stage)}
      ${error("DEPENDENCY_HTTP_ERROR", "Dependency returned a non-success status.", dependencyStatus)}
    </when>
  </choose>`;
const policy = `<!-- Generated by npm run generate:policy from config/categories.json. Do not edit. -->
<policies>
<inbound>
  <base />
  <cors allow-credentials="false">
    <allowed-origins><origin>{{allowed-origin}}</origin></allowed-origins>
    <allowed-methods preflight-result-max-age="300"><method>POST</method></allowed-methods>
    <allowed-headers><header>authorization</header><header>content-type</header></allowed-headers>
    <expose-headers><header>X-Request-Id</header><header>Retry-After</header></expose-headers>
  </cors>
  ${variable("stage", "auth")}
  ${variable("decisionJson", "")}
  ${variable("contentJson", "")}
  ${variable("outcome", "error")}
  ${variable("errorCode", "")}
  ${variable("errorMessage", "")}
  <validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="An authorized pilot user token is required." require-scheme="Bearer" output-token-variable-name="caller">
    <openid-config url="https://login.microsoftonline.com/{{tenant-id}}/v2.0/.well-known/openid-configuration" />
    <audiences><audience>{{api-audience}}</audience></audiences>
    <issuers><issuer>https://login.microsoftonline.com/{{tenant-id}}/v2.0</issuer></issuers>
    <required-claims>
      <claim name="tid" match="all"><value>{{tenant-id}}</value></claim>
      <claim name="scp" match="any" separator=" "><value>access_as_user</value></claim>
      <claim name="roles" match="any"><value>Pilot.User</value></claim>
    </required-claims>
  </validate-jwt>
  <rate-limit-by-key calls="120" renewal-period="60" counter-key="@(((Jwt)context.Variables[&quot;caller&quot;]).Subject)" />
  ${variable("stage", "input")}
  <choose><when condition="@(!context.Request.Headers.GetValueOrDefault(&quot;Content-Type&quot;, &quot;&quot;).StartsWith(&quot;application/json&quot;, StringComparison.OrdinalIgnoreCase))">
    ${error("INVALID_INPUT", "Content-Type must be application/json.", 400)}
  </when></choose>
  ${variable("rawBody", "@(context.Request.Body.As<string>(preserveContent: true))")}
  <choose><when condition="@(((string)context.Variables[&quot;rawBody&quot;]).Length &gt; ${config.maxBodyBytes} || System.Text.Encoding.UTF8.GetByteCount((string)context.Variables[&quot;rawBody&quot;]) &gt; ${config.maxBodyBytes})">
    ${error("INPUT_TOO_LARGE", "Request body exceeds the pilot limit.", 413)}
  </when></choose>
  ${variable("inputJson", "@(JObject.Parse((string)context.Variables[\"rawBody\"]).ToString(Newtonsoft.Json.Formatting.None))")}
  ${variable("inputValid", expression(`
    var obj = JObject.Parse((string)context.Variables["inputJson"]);
    return obj.Count == 1 && obj["text"] != null && obj["text"].Type == JTokenType.String && !String.IsNullOrWhiteSpace((string)obj["text"]);`))}
  <choose><when condition="@(!(bool)context.Variables[&quot;inputValid&quot;])">
    ${error("INVALID_INPUT", "Supply exactly one non-empty string field named text.", 400)}
  </when></choose>
  ${variable("text", "@((string)JObject.Parse((string)context.Variables[\"inputJson\"])[\"text\"])")}
  <choose><when condition="@(((string)context.Variables[&quot;text&quot;]).Length &gt; ${config.maxTextLength})">
    ${error("INPUT_TOO_LARGE", "Prompt exceeds the pilot text limit; it was not truncated.", 413)}
  </when></choose>
  ${call("decision", "{{decision-endpoint}}/providers/microsoft/v1/systemone", expression(`
    return new JObject(new JProperty("model", "{{decision-deployment}}"),
      new JProperty("state", (string)context.Variables["text"]),
      new JProperty("questions", JObject.Parse(${csharp(JSON.stringify(questions))}))).ToString(Newtonsoft.Json.Formatting.None);`), config.decisionTimeoutSeconds)}
  ${variable("decisionJson", expression(`
    var payload = ((IResponse)context.Variables["dependency"]).Body.As<JObject>();
    var definitions = JArray.Parse(${csharp(JSON.stringify(categories))});
    var results = new JArray();
    var answers = payload["answers"] as JObject;
    if (answers == null) { throw new Exception("Invalid Decision response."); }
    foreach (var category in definitions) {
      var id = (string)category["id"];
      var answer = answers[id] as JObject;
      if (answer == null || (string)answer["type"] != "noul" || answer["noul"] == null ||
          (answer["noul"].Type != JTokenType.Float && answer["noul"].Type != JTokenType.Integer)) {
        throw new Exception("Invalid Decision answer."); }
      var p = (double)answer["noul"];
      if (Double.IsNaN(p) || Double.IsInfinity(p) || p < 0 || p > 1) { throw new Exception("Invalid probability."); }
      var threshold = (double)category["threshold"];
      results.Add(new JObject(new JProperty("id", id), new JProperty("probability", p),
        new JProperty("threshold", threshold), new JProperty("matched", p >= threshold)));
    }
    var result = new JObject(new JProperty("status", "completed"),
      new JProperty("latencyMs", (DateTime.UtcNow - (DateTime)context.Variables["stageStarted"]).TotalMilliseconds),
      new JProperty("categories", results));
    if (payload["usage"] is JObject) { result["usage"] = payload["usage"]; }
    return result.ToString(Newtonsoft.Json.Formatting.None);`))}
  <choose><when condition="${xml(expression(`
    foreach (var c in (JArray)JObject.Parse((string)context.Variables["decisionJson"])["categories"]) {
      if ((bool)c["matched"]) { return true; }
    }
    return false;`))}">
    ${variable("outcome", "blocked_custom")}
    ${response(403, "Custom category blocked")}
  </when></choose>
  ${call("contentSafety", "{{contentsafety-endpoint}}/contentsafety/text:analyze?api-version=2024-09-01", expression(`
    return new JObject(new JProperty("text", (string)context.Variables["text"]),
      new JProperty("outputType", "EightSeverityLevels")).ToString(Newtonsoft.Json.Formatting.None);`), config.contentSafetyTimeoutSeconds)}
  ${variable("contentJson", expression(`
    var payload = ((IResponse)context.Variables["dependency"]).Body.As<JObject>();
    var items = payload["categoriesAnalysis"] as JArray;
    if (items == null || items.Count != 4) { throw new Exception("Invalid Content Safety response."); }
    var names = new List<string>();
    foreach (var item in items) {
      var name = (string)item["category"];
      if (!(new [] { "Hate", "SelfHarm", "Sexual", "Violence" }).Contains(name) || names.Contains(name)
          || item["severity"] == null || item["severity"].Type != JTokenType.Integer) {
        throw new Exception("Invalid Content Safety category."); }
      var severity = (int)item["severity"];
      if (severity < 0 || severity > 7) { throw new Exception("Invalid Content Safety severity."); }
      names.Add(name);
    }
    return new JObject(new JProperty("status", "completed"),
      new JProperty("latencyMs", (DateTime.UtcNow - (DateTime)context.Variables["stageStarted"]).TotalMilliseconds),
      new JProperty("categoriesAnalysis", items)).ToString(Newtonsoft.Json.Formatting.None);`))}
  <choose><when condition="${xml(expression(`
    var items = (JArray)JObject.Parse((string)context.Variables["contentJson"])["categoriesAnalysis"];
    foreach (var item in items) {
      if ((int)item["severity"] >= ${config.contentSafetySeverityThreshold}) { return true; }
    }
    return false;`))}">
    ${variable("outcome", "blocked_content_safety")}
    ${response(403, "Content Safety category blocked")}
  </when></choose>
  ${variable("outcome", "allowed")}
  ${response(200, "Analysis completed")}
</inbound>
<backend><base /></backend>
<outbound><base /></outbound>
<on-error>
  <base />
  ${variable("stage", "@(context.Variables.GetValueOrDefault<string>(\"stage\", \"gateway\"))")}
  ${variable("decisionJson", "@(context.Variables.GetValueOrDefault<string>(\"decisionJson\", \"\"))")}
  ${variable("contentJson", "@(context.Variables.GetValueOrDefault<string>(\"contentJson\", \"\"))")}
  <choose>
    <when condition="@((string)context.Variables[&quot;stage&quot;] == &quot;decision&quot;)">${failureStage("decision")}</when>
    <when condition="@((string)context.Variables[&quot;stage&quot;] == &quot;contentSafety&quot;)">${failureStage("contentSafety")}</when>
  </choose>
  ${variable("outcome", "error")}
  ${variable("errorCode", expression(`
    if (context.LastError.Reason == "RateLimitExceeded") { return "RATE_LIMITED"; }
    var stage = (string)context.Variables["stage"];
    if (stage == "auth") { return "UNAUTHORIZED"; }
    if (stage == "input") { return "INVALID_INPUT"; }
    if (context.LastError.Reason == "Timeout") { return "DEPENDENCY_TIMEOUT"; }
    return "INVALID_DEPENDENCY_RESPONSE";`))}
  ${variable("errorMessage", "Request could not be completed. See the failed stage and request ID.")}
  ${response(expression(`
    if (context.LastError.Reason == "RateLimitExceeded") { return 429; }
    var stage = (string)context.Variables["stage"];
    if (stage == "auth") { return 401; }
    if (stage == "input") { return 400; }
    if (context.LastError.Reason == "Timeout") { return 504; }
    return 502;`), "Moderation failed")}
</on-error>
</policies>
`.replace(/\{\{(tenant-id|api-audience|allowed-origin|decision-endpoint|decision-deployment|contentsafety-endpoint)\}\}/g,
  "{{insurance-$1}}");
if (check) {
  if (await readFile(target, "utf8") !== policy) throw new Error("Generated policy is stale. Run npm run generate:policy.");
  console.log("Generated policy matches trusted configuration.");
} else {
  await mkdir(new URL("policies/", root), { recursive: true });
  await writeFile(target, policy);
  console.log(`Generated ${fileURLToPath(target)}`);
}

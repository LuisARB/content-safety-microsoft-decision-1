import { createServer } from "node:http";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { observation } from "../tests/fixtures";

const browser = process.env.BROWSER_EXECUTABLE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = resolve("dist");
const identityBundle = (await readdir(join(root, "assets"))).find(name => /^identity-vendor-.*\.js$/.test(name));
if (!identityBundle) throw new Error("Missing identity bundle; build the frontend before browser checks.");
const profile = await mkdtemp(join(tmpdir(), "insurance-pilot-browser-"));
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = resolve(root, `.${url.pathname}`);
  if (path !== root && !path.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
  try {
    const file = path === root ? join(root, "index.html") : path;
    let contents: Buffer | string = await readFile(file);
    const scenario = url.searchParams.get("ui-fixture");
    if (path === root && ["allowed", "blocked", "general-block", "error"].includes(scenario ?? "")) {
      const fixture = observation(scenario === "blocked" ? ["claims_fraud_assistance"] : [], scenario === "general-block" ? { Violence: 5 } : {});
      if (scenario === "error") {
        fixture.httpStatus = 503;
        fixture.result.outcome = "error";
        fixture.result.decision = { status: "error", latencyMs: 20, categories: [] };
        fixture.result.contentSafety = { status: "skipped", latencyMs: null };
        fixture.result.error = { code: "DEPENDENCY_UNAVAILABLE", stage: "decision", message: "Dependency request failed or exceeded its time limit." };
      }
      const bootstrap = `
        import * as identity from "/assets/${identityBundle}";
        const Client = Object.values(identity).find(value => typeof value === "function" && value.prototype?.loginRedirect);
        if (!Client) throw new Error("Cannot locate MSAL for offline browser fixtures");
        const accounts = new WeakMap();
        Client.prototype.initialize = async function () {
          accounts.set(this, { tenantId: this.getConfiguration().auth.authority.split("/").pop(), name: "Synthetic browser fixture" });
        };
        Client.prototype.handleRedirectPromise = async () => null;
        Client.prototype.getActiveAccount = function () { return accounts.get(this); };
        Client.prototype.getAllAccounts = function () { return [accounts.get(this)]; };
        Client.prototype.setActiveAccount = function (account) { accounts.set(this, account); };
        Client.prototype.acquireTokenSilent = async () => ({ accessToken: "synthetic-browser-test-token" });
        Client.prototype.loginRedirect = Client.prototype.logoutRedirect = async () => { throw new Error("Offline fixture forbids real authentication"); };
        window.__fixtureRequests = 0;
        window.fetch = async (input, init) => {
          if (!String(input).endsWith("/moderation/analyze") || init?.method !== "POST") throw new Error("Offline fixture forbids unexpected fetch");
          window.__fixtureRequests++;
          return new Response(${JSON.stringify(JSON.stringify(fixture.result))}, { status: ${fixture.httpStatus}, headers: { "Content-Type": "application/json" } });
        };
      `;
      contents = contents.toString().replace(/<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/,
        (_, entry: string) => `<script type="module">${bootstrap}\nawait import(${JSON.stringify(entry)});</script>`);
    }
    response.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }).end(contents);
  } catch { response.writeHead(404).end("Not found"); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing browser test server address.");
const child = spawn(browser, ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const exit = once(child, "exit");
let socket: WebSocket | undefined;
try {
  const debuggerUrl = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser did not start in 20 seconds.")), 20000);
    child.once("error", failure => { clearTimeout(timer); reject(failure); });
    child.stderr.on("data", chunk => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolveUrl(match[1]); }
    });
  });
  const endpoint = new URL(debuggerUrl);
  const targets: { type: string; webSocketDebuggerUrl: string }[] = await (await fetch(`http://${endpoint.host}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(t => t.type === "page");
  if (!target) throw new Error("No browser page available.");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((ready, reject) => { socket!.addEventListener("open", () => ready(), { once: true }); socket!.addEventListener("error", () => reject(new Error("CDP connection failed.")), { once: true }); });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const browserErrors: string[] = [];
  socket.addEventListener("message", event => {
    const data = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: unknown };
    if (data.id) {
      const waiter = pending.get(data.id);
      if (waiter) { pending.delete(data.id); data.error ? waiter.reject(new Error(data.error.message)) : waiter.resolve(data.result ?? {}); }
    } else if (data.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(data.params));
  });
  const command = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolveCommand, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveCommand(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return (result.result as { value: unknown }).value;
  };
  await command("Runtime.enable");
  await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("!!document.querySelector('textarea')")) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const check = async (label: string, expression: string) => {
    if (!await evaluate(expression)) throw new Error(`Browser check failed: ${label}`);
    console.log(`PASS browser: ${label}`);
  };
  const waitFor = async (expression: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  };
  const switchLanguage = async (language: "es" | "en") => {
    await evaluate(`(() => { const select = document.querySelector('#language'); select.value = '${language}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.documentElement.lang === '${language}' && document.querySelector('#language').value === '${language}'`);
  };
  await check("Spanish default dashboard and technical branding", "document.documentElement.lang === 'es' && document.title === 'Content Safety Demo | Microsoft-Decision-1' && document.querySelector('.brand').innerText.includes('CONTENT SAFETY DEMO') && document.querySelector('.brand-sub').innerText === 'Microsoft-Decision-1 + Azure Content Safety' && document.body.innerText.includes('Aún no hay análisis')");
  await check("decorative content safety shield replaces D1", "document.querySelector('.brand svg.brand-icon[aria-hidden=true][focusable=false]')?.querySelectorAll('path').length === 2 && !document.querySelector('.brand').textContent.includes('D1') && document.querySelector('.brand-icon').getBoundingClientRect().width === 44 && document.querySelector('.brand-icon').getBoundingClientRect().height === 44");
  await check("analysis cannot run without authentication/config", "document.querySelector('button[type=submit]').disabled");
  for (const language of ["es", "en"] as const) {
    await switchLanguage(language);
    await check(`${language}: three safe, five custom-block and two general safety examples`, "document.querySelectorAll('[data-example-kind=safe] button').length === 3 && document.querySelectorAll('[data-example-kind=blocked] button').length === 5 && document.querySelectorAll('[data-example-kind=content-safety] button').length === 2");
    for (let index = 0; index < 10; index++) {
      await evaluate(`document.querySelectorAll('.examples button')[${index}].click()`);
      await waitFor(`document.querySelector('textarea').value === document.querySelectorAll('.examples button')[${index}].textContent`);
    }
    await check(`${language}: all ten examples fill input without submitting`, `document.body.innerText.includes(${JSON.stringify(language === "es" ? "Aún no hay análisis" : "No analysis yet")})`);
    await check(`${language}: general safety threshold is disclosed`, `document.body.innerText.includes(${JSON.stringify(language === "es" ? "severidad ≥ 5/7" : "severity ≥ 5/7")})`);
  }
  const selectedText = await evaluate("document.querySelector('textarea').value");
  await switchLanguage("es");
  await check("language changes do not overwrite the current prompt", `document.querySelector('textarea').value === ${JSON.stringify(selectedText)}`);
  await command("Page.reload");
  await waitFor("!!document.querySelector('#language') && document.documentElement.lang === 'es'");
  await check("Spanish preference survives a reload", "localStorage.getItem('insurance-pilot-language') === 'es' && document.querySelector('#language').value === 'es'");
  await switchLanguage("en");
  await command("Page.reload");
  await waitFor("!!document.querySelector('#language') && document.documentElement.lang === 'en'");
  await check("English preference and technical branding survive a reload", "document.title === 'Content Safety Demo | Microsoft-Decision-1' && document.querySelector('.brand').innerText.includes('CONTENT SAFETY DEMO') && document.querySelector('.brand-sub').innerText === 'Microsoft-Decision-1 + Azure Content Safety' && document.body.innerText.includes('No analysis yet')");
  await evaluate("document.querySelectorAll('.tabs button')[1].click()");
  await waitFor("!!document.querySelector('.batch-controls')");
  await check("English batch page discloses synthetic labels and split sizes", "document.body.innerText.includes('Labels are provisional') && document.querySelectorAll('.batch-controls select option').length === 2");
  await check("session initialization is not shown as a batch run", "!document.body.innerText.includes('completed — running') && ![...document.querySelectorAll('button')].some(b => b.textContent === 'Cancel run')");
  await switchLanguage("es");
  await check("Spanish batch controls and category definitions", "document.body.innerText.includes('Las etiquetas son provisionales') && document.body.innerText.includes('Ejecutar calibración') && document.body.innerText.includes('Ayuda para el fraude en siniestros') && !document.body.innerText.includes('Claims fraud assistance')");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await check("Spanish mobile viewport has no horizontal page overflow", "document.documentElement.scrollWidth <= window.innerWidth");
  await switchLanguage("en");
  await check("English mobile viewport has no horizontal page overflow", "document.documentElement.scrollWidth <= window.innerWidth");
  const configured = await evaluate("document.querySelector('footer').innerText.includes('Azure connection configured')");
  if (configured) {
    for (const scenario of ["allowed", "blocked", "general-block", "error"]) {
      await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/?ui-fixture=${scenario}` });
      await waitFor("!!document.querySelector('textarea') && !document.querySelector('.identity button').disabled");
      await switchLanguage("es");
      await evaluate("document.querySelector('.examples button').click()");
      await waitFor("!document.querySelector('button[type=submit]').disabled");
      await evaluate("document.querySelector('button[type=submit]').click()");
      await waitFor("!!document.querySelector('.outcome')");
      const expected = scenario === "allowed" ? "Ambos filtros superados" : scenario === "blocked" ? "Bloqueado por una categoría personalizada" : scenario === "general-block" ? "Bloqueado por Content Safety" : "Fallo técnico";
      await check(`Spanish ${scenario} outcome from offline API fixture`, `document.querySelector('.results').innerText.includes(${JSON.stringify(expected)})`);
      if (scenario === "allowed") await check("Spanish general safety labels and decimal percentages", "document.querySelector('.general').innerText.includes('Odio') && document.querySelector('.general').innerText.includes('Autolesiones') && document.querySelector('.score').innerText.includes('10,0')");
      if (scenario === "blocked") await check("Spanish skipped backend and matched category", "document.querySelector('.results').innerText.includes('Omitido') && document.querySelector('.results').innerText.includes('COINCIDE')");
      if (scenario === "general-block") await check("Content Safety block preserves scores and identifies the triggering severity", "document.querySelectorAll('.score').length === 4 && document.querySelector('.general').innerText.includes('Violencia 5/7 · COINCIDE') && !document.querySelector('.results .error:not(.outcome)')");
      if (scenario === "error") await check("Spanish technical failure retains its diagnostic code", "document.querySelector('.results .error:not(.outcome)').innerText.includes('DEPENDENCY_UNAVAILABLE') && document.querySelector('.results .error:not(.outcome)').innerText.includes('ha fallado')");
      await switchLanguage("en");
      await check(`English ${scenario} outcome preserves the existing result`, `document.querySelector('.results').innerText.includes(${JSON.stringify(scenario === "allowed" ? "Both safety gates passed" : scenario === "blocked" ? "Blocked by custom category" : scenario === "general-block" ? "Blocked by Content Safety" : "Technical failure")})`);
      await check(`${scenario}: switching language does not repeat the API request`, "window.__fixtureRequests === 1");
    }
    await evaluate("document.querySelectorAll('.tabs button')[1].click()");
    await waitFor("!!document.querySelector('.batch-controls')");
    await evaluate("document.querySelector('.batch-controls .primary').click()");
    await waitFor("!!document.querySelector('.metric-grid')");
    await switchLanguage("es");
    await check("Spanish batch report, errors, headers and exports", "document.body.innerText.includes('Objetivos provisionales') && document.body.innerText.includes('Errores técnicos') && document.querySelector('table').innerText.includes('Sensibilidad') && document.body.innerText.includes('Exportar informe y registros')");
    await switchLanguage("en");
    await check("English report updates in place without rerunning the batch", "document.body.innerText.includes('Provisional targets') && document.querySelector('table').innerText.includes('Recall') && document.body.innerText.includes('80 / 80 completed') && window.__fixtureRequests === 81");
  } else console.log("SKIP authenticated UI fixtures: no Azure SPA configuration in this build.");
  if (browserErrors.length) throw new Error(`Browser exceptions: ${browserErrors.join("; ")}`);
  console.log("Browser smoke checks passed without live Azure calls.");
} finally {
  socket?.close();
  if (child.pid && child.exitCode === null) {
    const stopped = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`], { stdio: "ignore" });
    if (stopped.error) console.error(`Could not stop browser PID ${child.pid}: ${stopped.error.message}`);
  }
  await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 3000))]);
  server.close();
  try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { console.error(`Could not remove temporary browser profile ${profile}: ${String(error)}`); process.exitCode = 1; }
}

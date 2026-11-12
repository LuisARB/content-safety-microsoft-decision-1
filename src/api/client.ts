import { parseModerationResult, validateText, type Analyze } from "../contracts";

export function validateApiBase(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash) {
    throw new Error("API base URL must be HTTPS (HTTP is allowed for loopback development only), without credentials, query or fragment.");
  }
  return value.replace(/\/+$/, "");
}
export function createAnalyze(base: string, getToken: () => Promise<string>, fetcher: typeof fetch = fetch): Analyze {
  const endpoint = `${validateApiBase(base)}/moderation/analyze`;
  return async (text, signal) => {
    validateText(text);
    signal?.throwIfAborted();
    const token = await getToken();
    if (!token.trim()) throw new Error("Sign in to obtain an API access token.");
    signal?.throwIfAborted();
    const started = performance.now();
    const timeout = AbortSignal.timeout(45000);
    const response = await fetcher(endpoint, {
      method: "POST", cache: "no-store", credentials: "omit", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const payload: unknown = await response.json();
    const result = parseModerationResult(payload);
    if ((result.outcome === "allowed" && response.status !== 200)
      || ((result.outcome === "blocked_custom" || result.outcome === "blocked_content_safety") && response.status !== 403)
      || (result.outcome === "error" && response.status < 400)) {
      throw new Error("Gateway HTTP status does not match the moderation outcome.");
    }
    return { result, clientLatencyMs: performance.now() - started, httpStatus: response.status };
  };
}

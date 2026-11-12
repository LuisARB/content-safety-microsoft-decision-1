import { describe, expect, it, vi } from "vitest";
import { createAnalyze, validateApiBase } from "../src/api/client";
import { observation } from "./fixtures";
describe("authenticated API client", () => {
  it("posts text to APIM with access token and validates response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(observation().result), { status: 200 }));
    const result = await createAnalyze("https://pilot.azure-api.net/", async () => "test-access-token", fetcher)("A truthful claim");
    expect(fetcher.mock.calls[0][0]).toBe("https://pilot.azure-api.net/moderation/analyze");
    expect(fetcher.mock.calls[0][1]?.body).toBe('{"text":"A truthful claim"}');
    expect(fetcher.mock.calls[0][1]?.headers).toHaveProperty("Authorization", "Bearer test-access-token");
    expect(result.result.outcome).toBe("allowed");
  });
  it("treats a normalized custom block as a classification, not a transport failure", async () => {
    const obs = observation(["claims_fraud_assistance"]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(obs.result), { status: 403 }));
    expect((await createAnalyze("https://pilot.azure-api.net", async () => "token", fetcher)("Request")).result.outcome).toBe("blocked_custom");
  });
  it("rejects unnormalized errors and success-shaped failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(observation().result), { status: 503 }));
    const analyze = createAnalyze("https://pilot.azure-api.net", async () => "token", fetcher);
    await expect(analyze("Request")).rejects.toThrow();
    await expect(analyze("Request")).rejects.toThrow();
  });
  it("treats a Content Safety 403 as a verdict and rejects other HTTP statuses", async () => {
    const obs = observation([], { Violence: 5 });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(obs.result), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(obs.result), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(obs.result), { status: 503 }));
    const analyze = createAnalyze("https://pilot.azure-api.net", async () => "token", fetcher);
    expect((await analyze("Request")).result.outcome).toBe("blocked_content_safety");
    await expect(analyze("Request")).rejects.toThrow("HTTP status");
    await expect(analyze("Request")).rejects.toThrow("HTTP status");
  });
  it("does not make requests without tokens or after cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createAnalyze("https://pilot.azure-api.net", async () => "", fetcher)("Request")).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(createAnalyze("https://pilot.azure-api.net", async () => "token", fetcher)("Request", controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["http://example.com", "https://user:pass@example.com", "https://example.com?token=secret", "javascript:alert(1)"])("rejects unsafe base URL %s", url => {
    expect(() => validateApiBase(url)).toThrow();
  });
  it("allows explicit loopback development", () => {
    expect(validateApiBase("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });
});

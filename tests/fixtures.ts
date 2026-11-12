import { config, type AnalyzeObservation, type ModerationResult } from "../src/contracts";
export function rawDecision(probabilities: number[] = [0.1, 0.1, 0.1, 0.1]) {
  return { model: "microsoft-decision-1", answers: Object.fromEntries(config.categories.map((c, i) =>
    [c.id, { type: "noul", noul: probabilities[i] }])), usage: { input_tokens: 100, output_tokens: 20 } };
}
export function observation(matches: string[] = [], generalSeverities: Record<string, number> = {}): AnalyzeObservation {
  const categories = config.categories.map(c => ({ id: c.id, probability: matches.includes(c.id) ? 0.8 : 0.1, threshold: c.threshold, matched: matches.includes(c.id) }));
  const generalBlocked = Object.values(generalSeverities).some(severity => severity >= config.contentSafetySeverityThreshold);
  const result: ModerationResult = {
    requestId: "fixture-request", configurationVersion: config.version, modelDeployment: "fixture-deployment",
    outcome: matches.length ? "blocked_custom" : generalBlocked ? "blocked_content_safety" : "allowed",
    decision: { status: "completed", latencyMs: 20, categories },
    contentSafety: matches.length ? { status: "skipped", latencyMs: null } : {
      status: "completed", latencyMs: 10,
      categoriesAnalysis: ["Hate", "SelfHarm", "Sexual", "Violence"].map(category => ({ category, severity: generalSeverities[category] ?? 0 })),
    },
    gatewayLatencyMs: matches.length ? 23 : 34,
  };
  return { result, httpStatus: matches.length || generalBlocked ? 403 : 200, clientLatencyMs: 38 };
}

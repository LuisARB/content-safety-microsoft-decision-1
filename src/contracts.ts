import configuration from "../config/categories.json";

export const config = configuration;
export const categoryIds = config.categories.map((category) => category.id);
export type CategoryId = string;
export type StageStatus = "completed" | "skipped" | "error";
export type ErrorStage = "input" | "auth" | "gateway" | "decision" | "contentSafety";
export interface CategoryResult {
  id: CategoryId;
  probability: number;
  threshold: number;
  matched: boolean;
}
export interface ModerationResult {
  requestId: string;
  configurationVersion: string;
  modelDeployment: string;
  outcome: "allowed" | "blocked_custom" | "blocked_content_safety" | "error";
  decision: {
    status: StageStatus;
    latencyMs: number | null;
    categories: CategoryResult[];
    usage?: Record<string, unknown>;
  };
  contentSafety: {
    status: StageStatus;
    latencyMs: number | null;
    categoriesAnalysis?: { category: string; severity: number }[];
  };
  gatewayLatencyMs: number;
  error?: { code: string; stage: ErrorStage; message: string };
}
export interface AnalyzeObservation {
  result: ModerationResult;
  clientLatencyMs: number;
  httpStatus: number;
}
export type Analyze = (text: string, signal?: AbortSignal) => Promise<AnalyzeObservation>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function validateText(text: string): void {
  if (!text.trim()) throw new Error("Enter a non-empty prompt.");
  if (text.length > config.maxTextLength) {
    throw new Error(`Prompt exceeds the pilot limit of ${config.maxTextLength} UTF-16 code units.`);
  }
}

export function decisionRequest(text: string, deployment: string) {
  validateText(text);
  if (!deployment.trim()) throw new Error("Model deployment name is required.");
  return {
    model: deployment,
    state: text,
    questions: Object.fromEntries(config.categories.map(({ id, instructions, criteria }) => [
      id, { type: "noul", instructions, criteria },
    ])),
  };
}

// Raw HTTP System One contract; SDK-normalized boolean/probability answers are different.
export function readDecision(payload: unknown): CategoryResult[] {
  if (!isRecord(payload) || !isRecord(payload.answers)) throw new Error("Missing Decision answers object.");
  const answers = payload.answers;
  return config.categories.map(({ id, threshold }) => {
    const answer = answers[id];
    if (!isRecord(answer) || answer.type !== "noul" || !isProbability(answer.noul)) {
      throw new Error(`Invalid noul answer for ${id}.`);
    }
    return { id, probability: answer.noul, threshold, matched: answer.noul >= threshold };
  });
}

export function parseModerationResult(payload: unknown): ModerationResult {
  if (!isRecord(payload) || typeof payload.requestId !== "string"
    || typeof payload.configurationVersion !== "string" || typeof payload.modelDeployment !== "string"
    || !["allowed", "blocked_custom", "blocked_content_safety", "error"].includes(String(payload.outcome))
    || typeof payload.gatewayLatencyMs !== "number" || !Number.isFinite(payload.gatewayLatencyMs)
    || payload.gatewayLatencyMs < 0 || !isRecord(payload.decision) || !isRecord(payload.contentSafety)) {
    throw new Error("The gateway returned an invalid moderation response.");
  }
  for (const stage of [payload.decision, payload.contentSafety]) {
    if (!["completed", "skipped", "error"].includes(String(stage.status))
      || !(stage.latencyMs === null || (typeof stage.latencyMs === "number"
        && Number.isFinite(stage.latencyMs) && stage.latencyMs >= 0))
      || (stage.status === "completed" && stage.latencyMs === null)
      || (stage.status === "skipped" && stage.latencyMs !== null)) {
      throw new Error("Invalid moderation stage.");
    }
  }
  if (!Array.isArray(payload.decision.categories)) throw new Error("Missing category results.");
  const seen = new Set<string>();
  const categories: CategoryResult[] = payload.decision.categories.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string" || !categoryIds.includes(item.id)
      || seen.has(item.id) || !isProbability(item.probability) || !isProbability(item.threshold)
      || item.matched !== (item.probability >= item.threshold)) throw new Error("Invalid category result.");
    seen.add(item.id);
    return { id: item.id, probability: item.probability, threshold: item.threshold, matched: item.matched };
  });
  if (payload.decision.status === "completed" ? seen.size !== categoryIds.length : seen.size !== 0) {
    throw new Error("Incomplete Decision category results.");
  }
  const analysis: { category: string; severity: number }[] = [];
  if (payload.contentSafety.status === "completed") {
    if (!Array.isArray(payload.contentSafety.categoriesAnalysis)) throw new Error("Missing Content Safety analysis.");
    const generalSeen = new Set<string>();
    for (const item of payload.contentSafety.categoriesAnalysis) {
      if (!isRecord(item) || typeof item.category !== "string"
        || !["Hate", "SelfHarm", "Sexual", "Violence"].includes(item.category)
        || generalSeen.has(item.category) || typeof item.severity !== "number"
        || !Number.isInteger(item.severity) || item.severity < 0 || item.severity > 7) {
        throw new Error("Invalid Content Safety category.");
      }
      generalSeen.add(item.category);
      analysis.push({ category: item.category, severity: item.severity });
    }
    if (generalSeen.size !== 4) throw new Error("Incomplete Content Safety analysis.");
  }
  let error: ModerationResult["error"];
  if (payload.outcome === "error") {
    if (!isRecord(payload.error) || typeof payload.error.code !== "string" || typeof payload.error.message !== "string"
      || !["input", "auth", "gateway", "decision", "contentSafety"].includes(String(payload.error.stage))) {
      throw new Error("Missing technical error details.");
    }
    error = { code: payload.error.code, message: payload.error.message, stage: payload.error.stage as ErrorStage };
  }
  const outcome = payload.outcome as ModerationResult["outcome"];
  const generalBlocked = analysis.some(c => c.severity >= config.contentSafetySeverityThreshold);
  if ((outcome === "allowed" && (payload.decision.status !== "completed" || categories.some(c => c.matched)
      || payload.contentSafety.status !== "completed" || generalBlocked))
    || (outcome === "blocked_custom" && (payload.decision.status !== "completed" || !categories.some(c => c.matched)
      || payload.contentSafety.status !== "skipped"))
    || (outcome === "blocked_content_safety" && (payload.decision.status !== "completed" || categories.some(c => c.matched)
      || payload.contentSafety.status !== "completed" || !generalBlocked))
    || (payload.contentSafety.status !== "skipped" && (payload.decision.status !== "completed" || categories.some(c => c.matched)))) {
    throw new Error("Inconsistent moderation outcome.");
  }
  return {
    requestId: payload.requestId, configurationVersion: payload.configurationVersion,
    modelDeployment: payload.modelDeployment, outcome, gatewayLatencyMs: payload.gatewayLatencyMs,
    decision: {
      status: payload.decision.status as StageStatus, latencyMs: payload.decision.latencyMs as number | null,
      categories, ...(isRecord(payload.decision.usage) ? { usage: payload.decision.usage } : {}),
    },
    contentSafety: {
      status: payload.contentSafety.status as StageStatus, latencyMs: payload.contentSafety.latencyMs as number | null,
      ...(payload.contentSafety.status === "completed" ? { categoriesAnalysis: analysis } : {}),
    },
    ...(error ? { error } : {}),
  };
}

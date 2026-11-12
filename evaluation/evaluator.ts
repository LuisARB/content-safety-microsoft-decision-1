import { categoryIds, config, type Analyze, type AnalyzeObservation } from "../src/contracts";
import { dataset } from "./dataset";

export interface EvaluationCase {
  id: string;
  text: string;
  language: "en" | "es";
  caseType: string;
  split: "calibration" | "test";
  expected: string[];
}
export interface BatchRecord {
  sample: EvaluationCase;
  observation?: AnalyzeObservation;
  failure?: string;
}
export interface BatchRun {
  records: BatchRecord[];
  planned: number;
  concurrency: number;
  elapsedMs: number;
  cancelled: boolean;
}
export async function runBatch(cases: EvaluationCase[], analyze: Analyze, options: {
  concurrency?: number; signal?: AbortSignal; onProgress?: (completed: number, total: number) => void;
} = {}): Promise<BatchRun> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Concurrency must be an integer from 1 to 4.");
  }
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Duplicate evaluation IDs.");
  const started = performance.now();
  const records: BatchRecord[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (next < cases.length && !options.signal?.aborted) {
      const sample = cases[next++];
      let record: BatchRecord;
      try {
        record = { sample, observation: await analyze(sample.text, options.signal) };
      } catch (error) {
        record = { sample, failure: error instanceof Error ? error.message : "Unknown transport failure." };
      }
      records.push(record);
      options.onProgress?.(records.length, cases.length);
    }
  }));
  records.sort((a, b) => cases.findIndex(c => c.id === a.sample.id) - cases.findIndex(c => c.id === b.sample.id));
  return { records, planned: cases.length, concurrency, elapsedMs: performance.now() - started, cancelled: options.signal?.aborted ?? false };
}
export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}
export function wilson(success: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.96, estimate = success / total, denominator = 1 + z * z / total;
  const center = (estimate + z * z / (2 * total)) / denominator;
  const half = z * Math.sqrt(estimate * (1 - estimate) / total + z * z / (4 * total * total)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
const ratio = (a: number, b: number) => b === 0 ? null : a / b;
function quality(records: BatchRecord[]) {
  const scored = records.filter(r => r.observation?.result.decision.status === "completed");
  const predicted = (r: BatchRecord) => r.observation!.result.decision.categories.filter(c => c.matched).map(c => c.id);
  const categories = categoryIds.map(id => {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const record of scored) {
      const actual = record.sample.expected.includes(id), prediction = predicted(record).includes(id);
      if (actual && prediction) tp++;
      else if (prediction) fp++;
      else if (actual) fn++;
      else tn++;
    }
    return { id, tp, fp, tn, fn, support: tp + fn,
      precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn),
      recallInterval95: wilson(tp, tp + fn) };
  });
  const benign = scored.filter(r => r.sample.expected.length === 0);
  const falseBlocks = benign.filter(r => predicted(r).length > 0).length;
  const exact = scored.filter(r => {
    const prediction = predicted(r);
    return prediction.length === r.sample.expected.length && r.sample.expected.every(id => prediction.includes(id));
  }).length;
  return { scored: scored.length, unscored: records.length - scored.length, categories, benignCount: benign.length,
    falseBlocks, benignFalseBlockRate: ratio(falseBlocks, benign.length), benignFalseBlockInterval95: wilson(falseBlocks, benign.length),
    exactMatch: ratio(exact, scored.length) };
}
export function summarize(run: BatchRun) {
  const { records } = run;
  const observations = records.flatMap(r => r.observation ? [r.observation] : []);
  const overall = quality(records);
  const technicalErrors = records.filter(r => r.failure || r.observation?.result.outcome === "error").length;
  const metadata = [...new Set(observations.map(o => JSON.stringify({
    configurationVersion: o.result.configurationVersion, modelDeployment: o.result.modelDeployment,
    thresholds: o.result.decision.categories.map(c => [c.id, c.threshold]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })))];
  // Error-only results have no threshold vector; compare completed decisions separately.
  const decisionMetadata = [...new Set(observations.filter(o => o.result.decision.status === "completed").map(o => JSON.stringify({
    version: o.result.configurationVersion, deployment: o.result.modelDeployment,
    thresholds: o.result.decision.categories.map(c => [c.id, c.threshold]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })))];
  const complete = !run.cancelled && records.length === run.planned && run.planned > 0;
  const testOnly = records.length > 0 && records.every(r => r.sample.split === "test");
  const heldOut = dataset.filter(c => c.split === "test");
  const fullHeldOutSet = run.planned === heldOut.length && records.length === heldOut.length
    && new Set(records.map(r => r.sample.id)).size === heldOut.length
    && records.every(r => heldOut.some(c => c.id === r.sample.id && c.text === r.sample.text
      && c.language === r.sample.language && JSON.stringify(c.expected) === JSON.stringify(r.sample.expected)));
  const current = observations.every(o => o.result.configurationVersion === config.version
    && (o.result.decision.status !== "completed" || o.result.decision.categories.every(c =>
      config.categories.some(d => d.id === c.id && d.threshold === c.threshold))));
  const targetsMet = overall.categories.every(c => c.recall !== null && c.recall >= 0.95)
    && overall.benignFalseBlockRate !== null && overall.benignFalseBlockRate <= 0.05;
  const latency = (values: number[]) => ({ count: values.length, p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95) });
  return {
    labelStatus: "synthetic-provisional-human-review-required",
    datasetVersion: "insurance-synthetic-v1",
    planned: run.planned, completed: records.length, cancelled: run.cancelled, complete,
    concurrency: run.concurrency, elapsedMs: run.elapsedMs,
    throughputPerSecond: run.elapsedMs > 0 ? records.length / run.elapsedMs * 1000 : null,
    technicalErrors, errorRate: ratio(technicalErrors, records.length),
    throttled: observations.filter(o => o.httpStatus === 429).length,
    overall, languages: { en: quality(records.filter(r => r.sample.language === "en")), es: quality(records.filter(r => r.sample.language === "es")) },
    metadata: metadata.map(m => JSON.parse(m) as unknown),
    consistentConfiguration: decisionMetadata.length === 1 && current,
    latency: {
      decision: latency(observations.flatMap(o => o.result.decision.latencyMs === null ? [] : [o.result.decision.latencyMs])),
      contentSafety: latency(observations.flatMap(o => o.result.contentSafety.latencyMs === null ? [] : [o.result.contentSafety.latencyMs])),
      gateway: latency(observations.map(o => o.result.gatewayLatencyMs)),
      client: latency(observations.map(o => o.clientLatencyMs)),
    },
    tokenUsage: observations.flatMap(o => o.result.decision.usage ? [{ requestId: o.result.requestId, usage: o.result.decision.usage }] : []),
    acceptance: {
      targetsMet,
      fullHeldOutSet,
      eligibleRun: complete && testOnly && fullHeldOutSet && technicalErrors === 0 && decisionMetadata.length === 1 && current,
      provisionalPass: complete && testOnly && fullHeldOutSet && technicalErrors === 0 && decisionMetadata.length === 1 && current && targetsMet,
      productionReady: false,
      note: "Synthetic labels require human review. Live measurements and representative independent data are needed; this is not a production certification.",
    },
  };
}
function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function recordsToCsv(records: BatchRecord[]): string {
  return [
    ["id", "language", "split", "text", "expected", "outcome", "categories", "requestId", "configurationVersion", "modelDeployment", "clientLatencyMs", "failure"].map(csvCell).join(","),
    ...records.map(r => [r.sample.id, r.sample.language, r.sample.split, r.sample.text, r.sample.expected,
      r.observation?.result.outcome ?? "transport_error", r.observation?.result.decision.categories ?? [],
      r.observation?.result.requestId ?? "", r.observation?.result.configurationVersion ?? "",
      r.observation?.result.modelDeployment ?? "", r.observation?.clientLatencyMs ?? null,
      r.failure ?? r.observation?.result.error?.code ?? ""].map(csvCell).join(",")),
  ].join("\r\n");
}

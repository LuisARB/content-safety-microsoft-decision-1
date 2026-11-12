import { describe, expect, it } from "vitest";
import { dataset } from "../evaluation/dataset";
import { quantile, recordsToCsv, runBatch, summarize, wilson, type EvaluationCase } from "../evaluation/evaluator";
import { categoryIds } from "../src/contracts";
import { observation } from "./fixtures";

const sample = (id: string, expected: string[] = []): EvaluationCase => ({
  id, expected, text: id, language: "en", split: "test", caseType: "fixture",
});
describe("synthetic dataset", () => {
  it("has exact sizes, distinct text and bilingual category coverage on each split", () => {
    expect(dataset).toHaveLength(200);
    expect(new Set(dataset.map(c => c.id)).size).toBe(200);
    expect(new Set(dataset.map(c => c.text)).size).toBe(200);
    expect(dataset.filter(c => c.split === "calibration")).toHaveLength(80);
    expect(dataset.filter(c => c.split === "test")).toHaveLength(120);
    for (const split of ["calibration", "test"]) for (const language of ["en", "es"]) {
      const slice = dataset.filter(c => c.split === split && c.language === language);
      for (const id of categoryIds) expect(slice.filter(c => c.expected.includes(id)).length).toBeGreaterThan(0);
      expect(slice.some(c => c.expected.length === 0)).toBe(true);
    }
    for (const item of dataset) expect(item.expected.every(id => categoryIds.includes(id))).toBe(true);
  });
});
describe("metrics", () => {
  it("computes counts, multilabel exact match, null denominators and excludes skipped timings", () => {
    const id = categoryIds[0];
    const report = summarize({
      planned: 4, concurrency: 2, cancelled: false, elapsedMs: 100,
      records: [
        { sample: sample("tp", [id]), observation: observation([id]) },
        { sample: sample("fp"), observation: observation([id]) },
        { sample: sample("fn", [id]), observation: observation() },
        { sample: sample("tn"), observation: observation() },
      ],
    });
    expect(report.overall.categories[0]).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
    expect(report.overall.categories[1].recall).toBeNull();
    expect(report.overall.benignFalseBlockRate).toBe(0.5);
    expect(report.overall.exactMatch).toBe(0.5);
    expect(report.latency.contentSafety.count).toBe(2);
    expect(report.acceptance.provisionalPass).toBe(false);
    expect(report.languages.es.exactMatch).toBeNull();
  });
  it("never passes incomplete, cancelled, error-only or calibration runs", () => {
    for (const cancelled of [true, false]) {
      const report = summarize({ records: [], planned: 4, concurrency: 2, elapsedMs: 1, cancelled });
      expect(report.acceptance.provisionalPass).toBe(false);
    }
  });
  it("retains classifier evidence on later dependency error without hiding error rate", () => {
    const obs = observation();
    obs.result.outcome = "error";
    obs.result.contentSafety = { status: "error", latencyMs: 10 };
    obs.result.error = { code: "FAILED", stage: "contentSafety", message: "failed" };
    const report = summarize({ records: [{ sample: sample("error"), observation: obs }], planned: 1, concurrency: 1, elapsedMs: 1, cancelled: false });
    expect(report.overall.scored).toBe(1);
    expect(report.errorRate).toBe(1);
    expect(report.acceptance.eligibleRun).toBe(false);
  });
  it("detects threshold/configuration mixing", () => {
    const changed = observation();
    changed.result.configurationVersion = "another";
    const report = summarize({ records: [
      { sample: sample("one"), observation: observation() },
      { sample: sample("two"), observation: changed },
    ], planned: 2, concurrency: 2, elapsedMs: 10, cancelled: false });
    expect(report.consistentConfiguration).toBe(false);
  });
  it("keeps Content Safety blocks separate from Decision-1 quality and technical errors", () => {
    const report = summarize({ records: [
      { sample: sample("general-block"), observation: observation([], { Violence: 5 }) },
    ], planned: 1, concurrency: 1, elapsedMs: 10, cancelled: false });
    expect(report.overall.scored).toBe(1);
    expect(report.overall.falseBlocks).toBe(0);
    expect(report.technicalErrors).toBe(0);
    expect(report.latency.contentSafety.count).toBe(1);
  });
  it("only evaluates acceptance for the full frozen held-out set, not a selected easy subset", () => {
    const records = dataset.filter(c => c.split === "test").map(sample => ({ sample, observation: observation(sample.expected) }));
    const full = summarize({ records, planned: 120, concurrency: 2, elapsedMs: 100, cancelled: false });
    expect(full.acceptance.provisionalPass).toBe(true);
    expect(full.acceptance.productionReady).toBe(false);
    const subset = summarize({ records: records.slice(0, 10), planned: 10, concurrency: 2, elapsedMs: 10, cancelled: false });
    expect(subset.acceptance.fullHeldOutSet).toBe(false);
    expect(subset.acceptance.provisionalPass).toBe(false);
  });
  it("calculates quantiles and uncertainty", () => {
    expect(quantile([], 0.95)).toBeNull();
    expect(quantile([10, 20, 30], 0.5)).toBe(20);
    expect(quantile([10, 20, 30], 0.95)).toBe(29);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(10, 10)![0]).toBeLessThan(0.8);
  });
  it("escapes quotes and spreadsheet formulas in CSV exports", () => {
    const csv = recordsToCsv([{ sample: { ...sample("csv"), text: '=HYPERLINK("example")' }, failure: "Failed" }]);
    expect(csv).toContain(`"'=HYPERLINK(""example"")"`);
  });
});
describe("batch execution", () => {
  it("bounds concurrency, keeps errors and respects cancellation without retrying", async () => {
    let active = 0, max = 0, calls = 0;
    const controller = new AbortController();
    const run = await runBatch(Array.from({ length: 10 }, (_, i) => sample(String(i))), async () => {
      calls++; active++; max = Math.max(active, max);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; controller.abort();
      throw new Error("transport failed");
    }, { concurrency: 2, signal: controller.signal });
    expect(max).toBe(2);
    expect(calls).toBe(2);
    expect(run.cancelled).toBe(true);
    expect(run.records.every(r => r.failure === "transport failed")).toBe(true);
  });
  it("rejects invalid concurrency before making requests", async () => {
    await expect(runBatch([], async () => observation(), { concurrency: 0 })).rejects.toThrow();
  });
});

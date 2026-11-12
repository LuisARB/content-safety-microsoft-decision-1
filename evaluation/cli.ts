import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAnalyze } from "../src/api/client";
import { dataset } from "./dataset";
import { recordsToCsv, runBatch, summarize } from "./evaluator";

async function main() {
  const [split, outputDirectory] = process.argv.slice(2);
  if (!["calibration", "test"].includes(split) || !outputDirectory) {
    throw new Error("Usage: npm run evaluate -- calibration|test <output-directory>. Set APIM_BASE_URL and APIM_ACCESS_TOKEN. Live requests are billable.");
  }
  const base = process.env.APIM_BASE_URL, token = process.env.APIM_ACCESS_TOKEN;
  if (!base || !token) throw new Error("APIM_BASE_URL and APIM_ACCESS_TOKEN are required. No credentials are printed.");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const run = await runBatch(dataset.filter(c => c.split === split), createAnalyze(base, async () => token), {
    concurrency: 2, signal: controller.signal,
    onProgress: (done, total) => { if (done % 10 === 0 || done === total) console.log(`${done}/${total} completed`); },
  });
  const report = summarize(run);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ report, run }, null, 2));
  await writeFile(resolve(directory, "records.csv"), recordsToCsv(run.records));
  console.log(JSON.stringify({ completed: report.completed, technicalErrors: report.technicalErrors, acceptance: report.acceptance }, null, 2));
  if (!report.complete || report.technicalErrors > 0) process.exitCode = 1;
  else if (split === "test" && !report.acceptance.provisionalPass) process.exitCode = 2;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
});

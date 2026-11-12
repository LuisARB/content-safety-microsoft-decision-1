import { useEffect, useRef, useState } from "react";
import { createAnalyze } from "./api/client";
import { createIdentity, readSettings } from "./auth/identity";
import { config, type AnalyzeObservation } from "./contracts";
import { dataset } from "../evaluation/dataset";
import { recordsToCsv, runBatch, summarize, type BatchRun } from "../evaluation/evaluator";
import { formatMilliseconds, formatPercentage, isLanguage, localizeError, messages, readLanguagePreference, saveLanguagePreference } from "./i18n";
import "./styles.css";

function connection() {
  try {
    const settings = readSettings();
    const identity = createIdentity(settings);
    return { identity, analyze: createAnalyze(settings.apiBase, identity.getToken), error: null };
  } catch (error) {
    return { identity: null, analyze: null, error: error instanceof Error ? error.message : "Invalid configuration." };
  }
}
const runtime = connection();
function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App() {
  const [preference, setPreference] = useState(readLanguagePreference);
  const { language, storageError } = preference;
  const t = messages[language];
  const milliseconds = (value: number | null) => formatMilliseconds(value, language);
  const percentage = (value: number | null) => formatPercentage(value, language);
  const changeLanguage = (value: string) => {
    if (!isLanguage(value)) throw new Error("Unsupported interface language.");
    setPreference(saveLanguagePreference(value));
  };
  const [user, setUser] = useState("");
  const [text, setText] = useState("");
  const [tab, setTab] = useState<"interactive" | "evaluation">("interactive");
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(!!runtime.identity);
  const [error, setError] = useState("");
  const [observation, setObservation] = useState<AnalyzeObservation | null>(null);
  const [split, setSplit] = useState<"calibration" | "test">("calibration");
  const [batch, setBatch] = useState<BatchRun | null>(null);
  const [progress, setProgress] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t.title;
  }, [language, t.title]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!runtime.identity) return;
    let active = true;
    runtime.identity.initialize().then(name => {
      if (active) setUser(name);
    }).catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : "Microsoft authentication failed.");
    }).finally(() => {
      if (active) setAuthBusy(false);
    });
    return () => { active = false; };
  }, []);
  const report = batch ? summarize(batch) : null;
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    setError(""); setBusy(true);
    controller.current = new AbortController();
    try { await action(controller.current.signal); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Request failed."); }
    finally { setBusy(false); controller.current = null; }
  };
  const authenticate = async () => {
    if (!runtime.identity) return;
    setError(""); setAuthBusy(true);
    try {
      if (user) await runtime.identity.signOut();
      else await runtime.identity.signIn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Microsoft authentication failed.");
      setAuthBusy(false);
    }
  };
  const result = observation?.result;
  return <div className="shell">
    <header>
      <a className="brand" href="#main">
        <svg className="brand-icon" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 3 20 6v6c0 4.5-3.5 7.5-8 9-4.5-1.5-8-4.5-8-9V6l8-3Z"/>
          <path d="m8 12 3 3 5-6"/>
        </svg>
        <span>{t.brand}<span className="brand-sub">{t.subtitle}</span></span>
      </a>
      <div className="identity"><span className="pilot-badge">{t.pilot}</span>
        <label className="language-selector" htmlFor="language">{t.language}
          <select id="language" value={language} onChange={event => changeLanguage(event.target.value)}>
            <option value="es" lang="es">Español (ES)</option><option value="en" lang="en">English (EN)</option>
          </select>
        </label>
        <button disabled={busy || authBusy || !runtime.identity} onClick={() => void authenticate()}>{authBusy ? t.connecting : user ? t.signOut : t.signIn}</button>
      </div>
    </header>
    <main id="main">
      <section className="hero"><div><p className="eyebrow">{t.eyebrow}</p>
        <h1>{t.headline}<br/><span>{t.headlineSecond}</span></h1>
        <p>{t.introduction}</p></div>
        <div className="architecture"><span>01 &nbsp; APIM</span><b>→</b><span>02 &nbsp; Decision-1</span><b>→</b><span>03 &nbsp; Content Safety</span>
          <small>{t.architecture}</small></div>
      </section>
      <div className="notice">{t.disclaimer}</div>
      {storageError && <p role="alert" className="error">{t.storageError}</p>}
      {runtime.error && <div role="alert" className="configuration"><strong>{t.notConfigured}</strong><p>{localizeError(runtime.error, language)}</p><p>{t.configurationHelp}</p></div>}
      {error && <div role="alert" className="error">{localizeError(error, language)}</div>}
      {authBusy && <p role="status">{t.authProgress}</p>}
      <nav className="tabs" aria-label={t.workbench}><button className={tab === "interactive" ? "selected" : ""} onClick={() => setTab("interactive")}>{t.promptTab}</button>
        <button className={tab === "evaluation" ? "selected" : ""} onClick={() => setTab("evaluation")}>{t.batchTab} <span>{t.cases}</span></button></nav>
      {tab === "interactive" ? <div className="workspace">
        <section className="panel prompt-panel"><div className="section-title"><h2>{t.submit}</h2><span>EN / ES</span></div>
          <form onSubmit={event => { event.preventDefault(); setObservation(null); void run(async signal => setObservation(await runtime.analyze!(text, signal))); }}>
            <label htmlFor="prompt">{t.textLabel}</label>
            <textarea id="prompt" placeholder={t.placeholder} value={text} onChange={event => setText(event.target.value)} rows={8} disabled={busy}/>
            <div className="input-meta"><span>{text.length} / {config.maxTextLength} {t.characters}</span><span>{t.noStorage}</span></div>
            <div className="actions"><button className="primary" type="submit" disabled={busy || authBusy || !user || !runtime.analyze || !text.trim() || text.length > config.maxTextLength}>{busy ? t.working : t.analyze}</button>
              {busy && <button type="button" onClick={() => controller.current?.abort()}>{t.cancel}</button>}</div>
          </form>
          <h3>{t.safeExamples}</h3><div className="examples" data-example-kind="safe">{t.safePrompts.map(example => <button key={example.id} type="button" disabled={busy} onClick={() => setText(example.text)}>{example.text}</button>)}</div>
          <h3>{t.blockedExamples}</h3><p className="hint">{t.exampleWarning}</p>
          <div className="examples blocked-examples" data-example-kind="blocked">{t.blockedPrompts.map(example => <button key={example.id} type="button" disabled={busy} onClick={() => setText(example.text)}>{example.text}</button>)}</div>
          <h3>{t.contentSafetyExamples}</h3><p className="hint">{t.contentSafetyWarning}</p>
          <div className="examples" data-example-kind="content-safety">{t.contentSafetyPrompts.map(example => <button key={example.id} type="button" disabled={busy} onClick={() => setText(example.text)}>{example.text}</button>)}</div>
          {!user && <p className="hint">{t.signInHint}</p>}
        </section>
        <section className="panel results" aria-live="polite"><div className="section-title"><h2>{t.results}</h2><span>{t.enforced}</span></div>
          {!result ? <div className="empty"><span className="empty-symbol">◎</span><h3>{t.noAnalysis}</h3><p>{t.resultsHelp}</p></div> : <>
            <div className={`outcome ${result.outcome}`}><strong>{result.outcome === "allowed" ? t.allowed : result.outcome === "blocked_custom" ? t.blocked : result.outcome === "blocked_content_safety" ? t.blockedContentSafety : t.technicalFailure}</strong>
              <span>{result.requestId}</span></div>
            {result.error && <div className="error">{t.stages[result.error.stage]}: {result.error.code} — {localizeError(result.error.message, language)}</div>}
            <div className="timeline"><div><span>Decision-1</span><strong>{t.statuses[result.decision.status]}</strong><small>{milliseconds(result.decision.latencyMs)}</small></div>
              <div><span>Content Safety</span><strong>{t.statuses[result.contentSafety.status]}</strong><small>{milliseconds(result.contentSafety.latencyMs)}</small></div>
              <div><span>{t.gatewayClient}</span><strong>{milliseconds(result.gatewayLatencyMs)}</strong><small>{milliseconds(observation!.clientLatencyMs)} {t.client}</small></div></div>
            {result.decision.categories.map(category => <div className="score" key={category.id}>
              <div><strong>{t.categories[category.id].label}</strong><span>{percentage(category.probability)} · {category.matched ? t.match : t.noMatch}</span></div>
              <meter min={0} max={1} value={category.probability} aria-label={`${t.categories[category.id].label}: ${t.probability}`}/>
              <small>{t.thresholdRule(percentage(category.threshold))}</small>
            </div>)}
            {result.contentSafety.categoriesAnalysis && <div className="general"><h3>{t.generalAnalysis}</h3>{result.contentSafety.categoriesAnalysis.map(c => <span key={c.category}>{t.generalCategories[c.category]} <b>{c.severity}/7</b>{c.severity >= config.contentSafetySeverityThreshold && ` · ${t.match}`}</span>)}<p className="hint">{t.generalHint}</p></div>}
            {result.contentSafety.status === "skipped" && <p className="hint">{t.skippedHint}</p>}
            <p className="hint">{result.configurationVersion} · {t.deployment}: {result.modelDeployment}</p>
          </>}
        </section>
      </div> : <section className="panel">
        <div className="section-title"><h2>{t.evaluate}</h2><span>{t.liveRequests}</span></div>
        <p>{t.datasetHint}</p>
        <div className="batch-controls"><label>{t.split} <select value={split} disabled={busy} onChange={e => setSplit(e.target.value as "calibration" | "test")}><option value="calibration">{t.calibration}</option><option value="test">{t.heldOut}</option></select></label>
          <button className="primary" disabled={busy || authBusy || !user || !runtime.analyze} onClick={() => { setBatch(null); setProgress(0); void run(async signal => setBatch(await runBatch(dataset.filter(c => c.split === split), runtime.analyze!, { signal, concurrency: 2, onProgress: done => setProgress(done) }))); }}>{split === "test" ? t.runTest : t.runCalibration}</button>
          {busy && <button onClick={() => controller.current?.abort()}>{t.cancelRun}</button>}
          <button onClick={() => download("synthetic-dataset.json", JSON.stringify(dataset, null, 2), "application/json")}>{t.exportDataset}</button>
        </div>
        <p className="hint">{t.calibrationHint}</p>
        <p aria-live="polite">{busy ? t.running(progress) : batch ? t.completed(batch.records.length, batch.planned, batch.cancelled) : t.noEvaluation}</p>
        {report && batch && <>
          <div className="metric-grid"><div><small>{t.targets}</small><strong>{report.acceptance.provisionalPass ? t.met : t.notDemonstrated}</strong></div>
            <div><small>{t.falseBlocks}</small><strong>{percentage(report.overall.benignFalseBlockRate)}</strong></div>
            <div><small>{t.technicalErrors}</small><strong>{report.technicalErrors} / {report.completed}</strong></div>
            <div><small>{t.clientP95}</small><strong>{milliseconds(report.latency.client.p95Ms)}</strong></div></div>
          <div className="table-scroll"><table><thead><tr><th>{t.category}</th><th>{t.support}</th><th>{t.precision}</th><th>{t.recall}</th><th>F1</th><th>{t.confusion}</th></tr></thead><tbody>{report.overall.categories.map(c => <tr key={c.id}><td>{t.categories[c.id].label}</td><td>{c.support}</td><td>{percentage(c.precision)}</td><td>{percentage(c.recall)}</td><td>{percentage(c.f1)}</td><td>{c.tp} / {c.fp} / {c.tn} / {c.fn}</td></tr>)}</tbody></table></div>
          <p>{t.targetsHint}</p>
          <div className="actions"><button onClick={() => download("evaluation.json", JSON.stringify({ report, run: batch }, null, 2), "application/json")}>{t.exportReport}</button><button onClick={() => download("evaluation.csv", recordsToCsv(batch.records), "text/csv")}>{t.exportRecords}</button></div>
          <details><summary>{t.details}</summary><p>{t.rawJson}</p><pre>{JSON.stringify(report, null, 2)}</pre></details>
        </>}
      </section>}
      <section className="category-reference"><h2>{t.definitions}</h2><div>{config.categories.map(c => <article key={c.id}><span>{c.id}</span><h3>{t.categories[c.id].label}</h3><p>{t.categories[c.id].includes}</p><small>{t.excludes}: {t.categories[c.id].excludes}</small></article>)}</div></section>
    </main>
    <footer><span>Microsoft-Decision-1 + Azure Content Safety</span><span>{config.version} · {t.research} · {runtime.error ? t.notConfigured : t.configured}</span></footer>
  </div>;
}

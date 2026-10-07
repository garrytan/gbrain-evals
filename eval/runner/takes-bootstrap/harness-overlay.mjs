#!/usr/bin/env bun
// harness-overlay.mjs: gbrain-evals overlay of gbrain's evals/takes-bootstrap/harness.mjs
// (gbrain c5fb0201, v0.60.95.0). Three changes, nothing else:
//   1. --gbrain-dir <path> (default node_modules/gbrain): the harness, corpus, scorer,
//      run-case and src/ are loaded from that gbrain tree instead of relative paths.
//   2. --price-input / --price-output <usd per 1M tokens>: used for the spend estimate
//      when gbrain's built-in table (canonicalLookup) has no row for --model, and loaded
//      into the BudgetTracker as a pricingOverrides row so its hard cap can price the
//      model. gbrain's table at c5fb0201 stops at gpt-5.6; `gbrain pricing set` writes the
//      config plane, which this harness's fresh in-memory brain never reads.
//   3. --summary <path>: writes model, estimate, ceiling, hard cap, spend, prices used,
//      per-case classifier errors and wall time as JSON before scoring.
//   4. --request-log <path>: an observe-only fetch wrapper appends one JSON line per
//      provider request (case id, HTTP status, stop reason, provider usage), so retries
//      and output-limit finishes are countable. Request and response bodies pass unchanged.
// Exit codes and scoring are unchanged. The diff against upstream is committed beside it.
//
// harness.mjs — takes-bootstrap classifier eval runner (H1 / TODOS TODO-E).
//
// LIVE mode (default; requires a chat-capable key, spends real tokens):
//   bun evals/takes-bootstrap/harness.mjs [--max N] [--out results.jsonl]
//     [--model anthropic:claude-haiku-4-5] [--max-usd 1]
// Configures the AI gateway with the shared eval bootstrap
// (src/eval/shared/gateway-bootstrap.ts), then for each corpus case seeds the
// page into a throwaway PGLite brain plus its markdown file in a temp brain
// repo and runs the REAL production path through run-case.ts —
// extractTakesFromPages (consent gate, eligibility selector, prompt,
// parseClaimsJson, md-first fence write, DB mirror) — and reads the case's
// takes back from the page's fence. ~123 Haiku-class calls per full run.
//
// Spend: the run prints an estimate first and refuses when it exceeds
// --max-usd (default $1); a gateway BudgetTracker enforces the same cap as a
// hard ceiling, and a run that hits it exits 2 unscored.
//
// REPLAY mode ($0, deterministic):
//   bun evals/takes-bootstrap/harness.mjs --replay results.jsonl [--max N]
// Re-scores a saved predictions file against the current corpus/scorer
// (the functional-area-resolver rescore.mjs pattern).
//
// --max N scores corpus.slice(0, N) in both modes. Keyless environments
// REFUSE loudly (never fake a score): graduation of the autopilot tier
// requires a passing LIVE run recorded in the PR.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const gbrainDir = resolve(flag('--gbrain-dir') ?? join(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/gbrain'));
const here = join(gbrainDir, 'evals/takes-bootstrap');
const startedAt = Date.now();

const fullCorpus = readFileSync(join(here, 'corpus.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const max = Number(flag('--max') ?? fullCorpus.length);
if (!Number.isInteger(max) || max < 1) {
  console.error(`takes-bootstrap harness: --max must be a positive integer (got ${flag('--max')}).`);
  process.exit(2);
}
const corpus = fullCorpus.slice(0, max);

const { scoreCorpus } = await import(join(here, 'scorer.ts'));

function finish(predictions) {
  const report = scoreCorpus(corpus, predictions);
  console.log(JSON.stringify(report, null, 2));
  console.error('\narchetype                variants passed  expected/matched  predicted/precise  forbid');
  for (const a of report.by_archetype) {
    console.error(`${a.archetype.padEnd(24)} ${`${a.variants_passed}/${a.variants}`.padStart(15)}  ${`${a.expected}/${a.matched}`.padStart(16)}  ${`${a.predicted}/${a.precise}`.padStart(17)}  ${String(a.forbid_violations).padStart(6)}`);
  }
  const passed = report.by_variant.filter(v => v.pass).length;
  console.error(`variants passed: ${passed}/${report.by_variant.length}`);
  console.log(report.graduated
    ? `\nGRADUATED (scorer v${report.scorer_version}): per-kind bars met, 0 malformed, 0 forbid violations.`
    : `\nNOT GRADUATED:\n  - ${report.failures.join('\n  - ')}`);
  process.exit(report.graduated ? 0 : 1);
}

const replay = flag('--replay');
if (replay) {
  const predictions = readFileSync(replay, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  finish(predictions);
}

// ── LIVE mode ───────────────────────────────────────────────────────────────
const model = flag('--model') ?? 'anthropic:claude-haiku-4-5';
const maxUsd = Number(flag('--max-usd') ?? 1);
const requestLog = flag('--request-log');
let currentCase = null;
if (requestLog) {
  writeFileSync(requestLog, '');
  const { appendFileSync } = await import('node:fs');
  const inner = globalThis.fetch;
  const hosts = new Set(['api.openai.com', 'api.anthropic.com']);
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!hosts.has(new URL(url).hostname)) return inner(input, init);
    const started = Date.now();
    const res = await inner(input, init);
    let body = null;
    try { body = await res.clone().json(); } catch { body = null; }
    const stop = body?.stop_reason ?? body?.incomplete_details?.reason ?? body?.status ?? body?.choices?.[0]?.finish_reason ?? null;
    appendFileSync(requestLog, JSON.stringify({ case: currentCase, host: new URL(url).hostname, status: res.status, stop, usage: body?.usage ?? null, ms: Date.now() - started }) + '\n');
    return res;
  };
}

const { configureEvalGateway } = await import(join(gbrainDir, 'src/eval/shared/gateway-bootstrap.ts'));
const { isAvailable, withBudgetTracker } = await import(join(gbrainDir, 'src/core/ai/gateway.ts'));
configureEvalGateway({ chatModel: model });
if (!isAvailable('chat', model)) {
  console.error(`takes-bootstrap harness: no chat-capable provider configured for ${model} — refusing to run keyless.`);
  console.error('Set the provider key (e.g. ANTHROPIC_API_KEY) or use --replay <results.jsonl> to re-score a saved run.');
  process.exit(2);
}

// Estimate: system prompt (~1.1k chars) + page body at ~4 chars/token in,
// ~300 tokens out per call; the extractor caps output at 2000 tokens.
const { canonicalLookup } = await import(join(gbrainDir, 'src/core/model-pricing.ts'));
const flagRate = (name) => {
  const raw = flag(name);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`takes-bootstrap harness: ${name} must be a non-negative number of USD per 1M tokens (got ${raw}).`);
    process.exit(2);
  }
  return n;
};
const priceInput = flagRate('--price-input');
const priceOutput = flagRate('--price-output');
if ((priceInput === null) !== (priceOutput === null)) {
  console.error('takes-bootstrap harness: pass --price-input and --price-output together.');
  process.exit(2);
}
const builtinPrice = canonicalLookup(model) ?? null;
const flagPrice = priceInput === null ? null : { input: priceInput, output: priceOutput };
const price = builtinPrice ?? flagPrice;
const priceSource = builtinPrice ? 'gbrain canonicalLookup' : flagPrice ? '--price-input/--price-output' : null;
if (!price) {
  console.error(`takes-bootstrap harness: ${model} has no canonical price, so the $${maxUsd} cap cannot be enforced.`);
  console.error(`Look up its rate and register it (gbrain pricing set ${model} --input <usd/1M> --output <usd/1M> --source <url>), or pick a priced --model.`);
  process.exit(2);
}
const inputTokens = corpus.reduce((n, c) => n + Math.ceil((1100 + c.page.body.length) / 4) + 50, 0);
const estimate = (inputTokens * price.input + corpus.length * 300 * price.output) / 1e6;
const ceiling = (inputTokens * price.input + corpus.length * 2000 * price.output) / 1e6;
console.error(`takes-bootstrap harness: ${corpus.length} case(s) on ${model}; estimated spend $${estimate.toFixed(4)} (ceiling $${ceiling.toFixed(4)} at 2000 output tokens/call); hard cap $${maxUsd}.`);
if (estimate > maxUsd) {
  console.error(`Refusing: the estimate exceeds --max-usd ${maxUsd}. Lower --max or raise --max-usd.`);
  process.exit(2);
}

const { PGLiteEngine } = await import(join(gbrainDir, 'src/core/pglite-engine.ts'));
const { BudgetTracker } = await import(join(gbrainDir, 'src/core/budget/budget-tracker.ts'));
const { runCase } = await import(join(here, 'run-case.ts'));

const outPath = flag('--out') ?? join(here, 'results-latest.jsonl');
const brainDir = mkdtempSync(join(tmpdir(), 'takes-bootstrap-eval-'));
const tracker = new BudgetTracker({ maxCostUsd: maxUsd, label: 'takes-bootstrap-eval', auditPath: join(brainDir, 'budget-audit.jsonl'),
  ...(builtinPrice || !flagPrice ? {} : { pricingOverrides: { [model.toLowerCase()]: flagPrice } }) });
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
await engine.setConfig('sync.repo_path', brainDir);

const predictions = [];
const caseErrors = [];
try {
  await withBudgetTracker(tracker, async () => {
    for (const c of corpus) {
      currentCase = c.id;
      const run = await runCase(engine, brainDir, c, model);
      await engine.deletePage(c.page.slug);
      if (run.error?.includes('BudgetExhausted')) {
        throw new Error(`case ${c.id}: the $${maxUsd} spend cap was reached after $${tracker.totalSpent.toFixed(4)}`);
      }
      if (run.error) {
        console.error(`case ${c.id}: classifier call failed (${run.error}); scored as malformed`);
        caseErrors.push({ id: c.id, error: run.error });
      }
      predictions.push({ id: run.id, claims: run.claims });
      if (predictions.length % 10 === 0) console.error(`…${predictions.length}/${corpus.length}`);
    }
  });
} catch (err) {
  console.error(`takes-bootstrap harness: ${err.message} — aborting (partial results NOT scored).`);
  process.exitCode = 2;
} finally {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
}
console.error(`spend: $${tracker.totalSpent.toFixed(4)} on ${model}`);
const summaryPath = flag('--summary');
if (summaryPath) {
  writeFileSync(summaryPath, JSON.stringify({
    model, cases: corpus.length, predictions: predictions.length, aborted: process.exitCode === 2,
    estimate_usd: estimate, ceiling_usd: ceiling, max_usd: maxUsd, spent_usd: tracker.totalSpent,
    price_used: price, price_source: priceSource, case_errors: caseErrors, wall_ms: Date.now() - startedAt,
  }, null, 2) + '\n');
}
if (process.exitCode === 2) process.exit(2);

writeFileSync(outPath, predictions.map(p => JSON.stringify(p)).join('\n') + '\n');
console.error(`predictions written to ${outPath}`);
finish(predictions);

/**
 * Auto v2 follow-up (decision manifest v2): does gbrain's default `auto`
 * evidence delivery at the product budget keep whole-page gains on
 * conversation questions? LongMemEval-S is a sanity check; the decision is
 * the sealed confirmation set (E2). Preregistration:
 * docs/benchmarks/2026-09-30-evidence-auto-v2/decision-manifest.json.
 *
 * Keyless:  power | analyze --rows-dir <dir> --frozen-dir <dir> | costs
 * Paid (joins the v2 campaign run with --budget-run-id):
 *   campaign-open --budget-usd <= 150
 *   freeze     --dataset <json> --out-dir <dir> [--shard k/n] [--embed-cache <sqlite>]
 *   e1         --frozen-dir <dir> --dataset <json> --out-dir <dir> [--arms chunk,auto,page]
 *   e2-freeze  --questions <sealed questions.json> --out-dir <dir>
 *   e2-answer  --questions <json> --frozen-dir <dir> --out <private jsonl>
 *   e2-score   --questions <json> --labels <labels.json> --answers <jsonl> --purpose <text> --out <json>
 * merge-frozen is shared with eval/runner/evidence-delivery.ts.
 */
import './budget-ledger.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BudgetExceededError, BudgetRun, receiptCost } from './budget-ledger.ts';
import { Args, budgetOptions, assertManifestCommitted, cmdMergeFrozen, e1Context, gbrainFor, paidGuard, r1Calls, r1Rows, readJsonl, writeJson } from './evidence-delivery.ts';
import { DECISION_MANIFEST_V2_REL, decideE2V2, decideSanity, loadDecisionManifestV2, validateDecisionManifestV2, type DecisionManifestV2 } from './evidence-delivery/decision-v2.ts';
import { loadDecisionManifest, type DecisionManifest, type OutcomeRow } from './evidence-delivery/decision.ts';
import { REPO_ROOT, loadDataset, pilotIds } from './evidence-delivery/data.ts';
import { freeze, type FreezeInput } from './evidence-delivery/freeze.ts';
import { readFrozen } from './evidence-delivery/store.ts';
import { parityCheck } from './evidence-delivery/parity.ts';
import { SONNET, estimateE1Usd, readRows, rendererFrom, rowsPath, runE1, toOutcome } from './evidence-delivery/e1.ts';
import { gbrainJudge, providerInputTokens, readerCall } from './evidence-delivery/calls.ts';
import { buildSealedRequests, gbrainJudgeId, scoreSealed, sealedDatasetView, sealedFreezeInputs, type SealedAnswerRow } from './evidence-delivery/e2-bridge.ts';
import { requestSha } from './evidence-delivery/arms.ts';
import { e2SuperiorityPower } from './evidence-delivery/power.ts';
import { canonicalJson } from './sealed-confirmation-lib.ts';

export const STUDY_V2_DIR = join(REPO_ROOT, 'docs/benchmarks/2026-09-30-evidence-auto-v2');
const log = (line: string) => process.stderr.write(line + '\n');

function manifestV2() {
  const { manifest, sha256 } = loadDecisionManifestV2();
  const problems = validateDecisionManifestV2(manifest);
  if (problems.length) throw new Error(`decision manifest v2 invalid: ${problems.join('; ')}`);
  return { manifest, sha: sha256 };
}

/** The rule's identity with the gbrain pin blanked, so a report computed before the pin still names the rule it tested. */
export function ruleSha(m: DecisionManifestV2): string {
  const copy = JSON.parse(JSON.stringify(m)) as DecisionManifestV2;
  copy.candidate_commits.gbrain = null;
  return createHash('sha256').update(canonicalJson(copy)).digest('hex');
}

const asV1 = (m: DecisionManifestV2) => m as unknown as DecisionManifest;
const guard = (a: Args, m: DecisionManifestV2, runner: string, estimate: number) => paidGuard(a, m, runner, estimate, DECISION_MANIFEST_V2_REL);

async function cmdPower(a: Args) {
  const { manifest } = manifestV2();
  const cells = [];
  let seed = a.num('--seed', 20260930);
  for (const noise of [0.02, 0.05]) {
    for (const chunkAcc of [0.6, 0.7, 0.8, 0.9]) {
      for (const trueDelta of [0, 0.03, 0.05, 0.08, 0.1, 0.15]) {
        if (chunkAcc + trueDelta > 1) continue;
        cells.push(e2SuperiorityPower(manifest, decideE2V2, { chunkAcc, trueDelta, personaSd: 0.8, noise, sims: a.num('--sims', 1000), seed: seed++, draws: a.num('--draws', 2000) }));
      }
    }
  }
  const report = { schema: 'gbrain-evals/evidence-auto-v2-power/v1', decision_rule_sha256: ruleSha(manifest), note: 'Simulated with decideE2V2 on 30 personas x 5 questions; persona random effect sd 0.8 on the logit scale; the arms share each question\'s latent draw plus independent reader noise; the confirmation judge flips 1% of verdicts. Sign-flip draws lowered to 2000 for speed.', cells };
  writeJson(a.get('--out') ?? join(STUDY_V2_DIR, 'power-analysis.json'), report);
  process.stdout.write(JSON.stringify(cells.map(c => [c.reader_noise, c.chunk_accuracy, c.true_delta, c.pass])) + '\n');
}

export function costPlanV2() {
  const sonnet = (inTok: number, outTok = 300) => inTok * 3e-6 + outTok * 15e-6;
  const judges = 0.0017;
  const lines = [
    { step: 'freeze LongMemEval-S (500 questions) at the pinned commit: embeddings on a cold cache plus one rerank each', usd: 500 * (116_000 * 0.13e-6 + 14_000 * 0.05e-6) },
    { step: 'LongMemEval sanity: chunk, auto and page x 500, both judges', usd: 500 * (sonnet(3500) + sonnet(14500) + sonnet(15500) + 3 * judges) },
    { step: 'sealed: freeze 30 haystacks', usd: 30 * 60_000 * 0.13e-6 + 150 * 14_000 * 0.05e-6 },
    { step: 'sealed E2: chunk and auto x 150, both judges', usd: 150 * (sonnet(2500) + sonnet(6500) + 2 * judges) },
  ];
  const total = lines.reduce((s, l) => s + l.usd, 0);
  return { lines: lines.map(l => ({ ...l, usd: Number(l.usd.toFixed(2)) })), total_usd: Number(total.toFixed(2)), with_retry_margin_usd: Number((total * 1.25).toFixed(2)) };
}

async function cmdCampaignOpen(a: Args) {
  const { manifest } = manifestV2();
  assertManifestCommitted(REPO_ROOT, DECISION_MANIFEST_V2_REL);
  if (!manifest.candidate_commits.gbrain) throw new Error('pin candidate_commits.gbrain first');
  const o = budgetOptions(a, manifest);
  if (o.budgetUsd === null || o.budgetUsd > manifest.budget.campaign_cap_usd) throw new Error(`--budget-usd must be at most $${manifest.budget.campaign_cap_usd}`);
  const run = BudgetRun.open({ runner: manifest.budget.campaign_runner, budgetUsd: o.budgetUsd, estimateUsd: costPlanV2().with_retry_margin_usd, ledgerPath: o.ledgerPath, programCapUsd: o.programCapUsd, programCapSource: o.programCapSource, programCapMaxUsd: o.programCapMaxUsd });
  process.stdout.write(run.runId + '\n');
}

async function cmdFreeze(a: Args) {
  const { manifest, sha } = manifestV2();
  const g = await gbrainFor(a, true);
  const questions = loadDataset(a.need('--dataset'), manifest.data.longmemeval_s.sha256);
  let ids = questions.map(q => q.question_id);
  const shard = a.get('--shard');
  if (shard) { const [k, n] = shard.split('/').map(Number); ids = ids.filter((_, i) => i % n === k); }
  ids = ids.slice(0, a.num('--limit', ids.length));
  const byId = new Map(questions.map(q => [q.question_id, q]));
  const pilot = new Set(pilotIds(loadDecisionManifest().manifest));
  const r1 = r1Rows();
  const inputs: FreezeInput[] = ids.map(id => ({ question: byId.get(id)!, set: pilot.has(id) ? 'pilot' : 'confirmatory', r1Retrieved: r1.get(id)?.retrieved }));
  const { run, guard: g2 } = guard(a, manifest, 'evidence-auto-v2-freeze', inputs.length * 0.016);
  try {
    const res = await freeze({ g, manifest: asV1(manifest), manifestSha: sha, outDir: resolve(a.need('--out-dir')), inputs, embedCachePath: resolve(a.need('--embed-cache')), datasetSha: manifest.data.longmemeval_s.sha256, smoke: false, log });
    process.stdout.write(JSON.stringify({ ...res, cost: receiptCost(run.close()) }, null, 2) + '\n');
    if (res.errors.length) process.exitCode = 1;
  } finally { g2.uninstall(); }
}

async function cmdParity(a: Args) {
  const { manifest } = manifestV2();
  const g = await gbrainFor(a);
  const frozen = readFrozen(a.need('--frozen-dir'));
  const ds = new Map(loadDataset(a.need('--dataset'), manifest.data.longmemeval_s.sha256).map(q => [q.question_id, q]));
  const report = parityCheck([...frozen.questions.values()], frozen.store, rendererFrom(g), id => ({ question: ds.get(id)!.question, question_date: ds.get(id)!.question_date }), r1Calls(), SONNET, manifest.reader.max_tokens);
  writeJson(a.get('--out') ?? join(a.need('--frozen-dir'), 'parity.json'), { frozen_manifest_sha256: frozen.sha256, gbrain_commit: frozen.header.gbrain.commit, ...report });
  process.stdout.write(JSON.stringify({ ok: report.ok, harness_vs_r1: { eligible: report.harness_vs_r1.eligible, identical: report.harness_vs_r1.identical }, page: report.product_page_vs_harness?.blocks }) + '\n');
}

async function cmdE1(a: Args) {
  const { manifest, sha } = manifestV2();
  const arms = a.list('--arms') ?? ['chunk', 'auto', 'page'];
  if (arms.some(x => !['chunk', 'auto', 'page'].includes(x))) throw new Error('v2 LongMemEval arms are chunk, auto and page');
  const g = await gbrainFor(a);
  const ctx = e1Context(a, g, asV1(manifest), sha, 'all', SONNET);
  const ids = Object.keys(ctx.clusters).slice(0, a.num('--limit', 500));
  const missing = ids.filter(id => !ctx.questions.has(id));
  if (missing.length) throw new Error(`${missing.length} question(s) are not frozen`);
  const parity = parityCheck(ids.map(id => ctx.questions.get(id)!), ctx.store, ctx.renderer, id => ({ question: ctx.dataset.get(id)!.question, question_date: ctx.dataset.get(id)!.question_date }), r1Calls(), SONNET, manifest.reader.max_tokens);
  writeJson(join(ctx.outDir, 'parity-all.json'), parity);
  if (!parity.ok) throw new Error(`parity check failed before any model call: ${parity.problems.join('; ')}`);
  const budgets = new Set(ids.map(id => (ctx.questions.get(id)!.arms.auto?.delivery as any)?.budget_tokens));
  if (arms.includes('auto') && (budgets.size !== 1 || !budgets.has(16000))) throw new Error(`auto's applied budget must be 16000 on every question (saw ${[...budgets].join(', ')})`);
  const estimate = estimateE1Usd(ctx, ids.map(id => ctx.questions.get(id)!), arms, g.tokens.estimateTokens);
  const { run, guard: g2 } = guard(a, manifest, 'evidence-auto-v2-e1', estimate);
  try {
    const res = await runE1(ctx, arms, ids, a.num('--concurrency', 6), log);
    process.stdout.write(JSON.stringify({ ...res, estimate_usd: Number(estimate.toFixed(2)), cost: receiptCost(run.close()) }, null, 2) + '\n');
  } catch (e) { run.close(); throw e; } finally { g2.uninstall(); }
}

/** Per-question auto diagnostics from the frozen product results. */
export function autoDiagnostics(results: Array<{ delivered?: { unit?: string; reason?: string; truncated?: boolean; fallback_reason?: string } }>) {
  const d = { blocks: results.length, page: 0, chunk: 0, truncated: 0, conversation_over_budget: 0, not_conversation: 0, fallback: 0 };
  for (const r of results) {
    const u = r.delivered?.unit ?? 'chunk';
    if (u === 'page') d.page++; else d.chunk++;
    if (r.delivered?.truncated) d.truncated++;
    if (r.delivered?.reason === 'conversation_over_budget') d.conversation_over_budget++;
    if (r.delivered?.reason === 'not_conversation') d.not_conversation++;
    if (r.delivered?.fallback_reason) d.fallback++;
  }
  return d;
}

async function cmdAnalyze(a: Args) {
  const { manifest, sha } = manifestV2();
  const dir = a.need('--rows-dir');
  const rows = (arm: string) => readRows(rowsPath(dir, 'all', arm, SONNET));
  const chunk = rows('chunk'), auto = rows('auto'), page = rows('page');
  const sanity = decideSanity(manifest, chunk.map(toOutcome), auto.map(toOutcome), page.map(toOutcome));
  const frozen = readFrozen(a.need('--frozen-dir'));
  const perQ = new Map<string, ReturnType<typeof autoDiagnostics>>();
  const totals = { blocks: 0, page: 0, chunk: 0, truncated: 0, conversation_over_budget: 0, not_conversation: 0, fallback: 0 };
  const fallbacks: Record<string, number> = {};
  let sameAsPage = 0;
  for (const q of frozen.questions.values()) {
    const arm = q.arms.auto;
    if (!arm?.results) continue;
    const d = autoDiagnostics(JSON.parse(frozen.store.get(arm.results)));
    perQ.set(q.question_id, d);
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += d[k];
    for (const f of ((arm.delivery as any)?.fallbacks ?? []) as string[]) fallbacks[f] = (fallbacks[f] ?? 0) + 1;
    if (q.arms.page && arm.evidence_sha256 === q.arms.page.evidence_sha256) sameAsPage++;
  }
  const cut = new Set([...perQ].filter(([, d]) => d.truncated > 0 || d.conversation_over_budget > 0).map(([id]) => id));
  const byMap = (rs: typeof chunk) => new Map(rs.map(r => [r.question_id, r]));
  const [mc, ma, mp] = [byMap(chunk), byMap(auto), byMap(page)];
  const subset = (ids: string[]) => ({ n: ids.length, chunk: ids.filter(id => mc.get(id)?.primary === 1).length, auto: ids.filter(id => ma.get(id)?.primary === 1).length, page: ids.filter(id => mp.get(id)?.primary === 1).length });
  const allIds = [...ma.keys()];
  const byType: Record<string, ReturnType<typeof subset>> = {};
  for (const t of manifest.data.strata) byType[t] = subset(allIds.filter(id => ma.get(id)!.question_type === t));
  const tokens = (rs: typeof chunk) => ({ product_encoding: mean(rs.map(r => r.tokens.product_encoding)), serialized_tool: mean(rs.map(r => r.tokens.serialized_tool ?? 0)), provider_input: mean(rs.map(r => r.tokens.provider_input ?? 0)) });
  const out = {
    decision_manifest_sha256: sha, frozen_manifest_sha256: frozen.sha256, gbrain_commit: frozen.header.gbrain.commit,
    sanity, auto_delivery: { ...totals, questions_with_cut_or_over_budget: cut.size, questions_auto_equals_page: sameAsPage, delivery_fallbacks: fallbacks },
    truncated_subset: subset(allIds.filter(id => cut.has(id))), untruncated_subset: subset(allIds.filter(id => !cut.has(id))),
    by_type: byType, tokens: { chunk: tokens(chunk), auto: tokens(auto), page: tokens(page) },
    r1_agreement: { identical_slug_chunk_rank: [...frozen.questions.values()].filter(q => q.r1?.identical_slug_chunk_rank).length },
  };
  writeJson(a.get('--out') ?? join(dir, 'sanity.json'), out);
  process.stdout.write(JSON.stringify({ sanity, auto_delivery: out.auto_delivery, truncated_subset: out.truncated_subset }, null, 2) + '\n');
}
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

async function sealed() {
  const s = await import('./sealed-confirmation.ts');
  return { ...s, sealedManifest: s.loadManifest(s.DEFAULT_MANIFEST) };
}

async function cmdE2Freeze(a: Args) {
  const { manifest, sha } = manifestV2();
  const s = await sealed();
  const questionsPath = a.need('--questions');
  const q = s.loadQuestions(questionsPath, s.sealedManifest);
  const g = await gbrainFor(a, true);
  const inputs = sealedFreezeInputs(s.toLmeRows(q));
  const { run, guard: g2 } = guard(a, manifest, 'evidence-auto-v2-e2-freeze', inputs.length * 0.01);
  try {
    const res = await freeze({ g, manifest: asV1(manifest), manifestSha: sha, outDir: resolve(a.need('--out-dir')), inputs, embedCachePath: resolve(a.need('--embed-cache')), datasetSha: manifest.data.sealed.questions_sha256, smoke: false, log });
    process.stdout.write(JSON.stringify({ frozen: res.frozen, skipped: res.skipped, errors: res.errors.length, cost: receiptCost(run.close()) }) + '\n');
    if (res.errors.length) process.exitCode = 1;
  } finally { g2.uninstall(); }
}

async function cmdE2Answer(a: Args) {
  const { manifest, sha } = manifestV2();
  const s = await sealed();
  const questions = s.loadQuestions(a.need('--questions'), s.sealedManifest);
  const g = await gbrainFor(a);
  const frozen = readFrozen(a.need('--frozen-dir'));
  if (frozen.header.gbrain.commit !== manifest.candidate_commits.gbrain) throw new Error('sealed freeze is not at the pinned gbrain commit');
  const budgets = new Set([...frozen.questions.values()].map(q => (q.arms.auto?.delivery as any)?.budget_tokens));
  if (budgets.size !== 1 || !budgets.has(16000)) throw new Error(`auto's applied budget must be 16000 (saw ${[...budgets].join(', ')})`);
  const ctx = { store: frozen.store, renderer: rendererFrom(g), dataset: sealedDatasetView(questions), readerModel: SONNET, manifest: asV1(manifest) };
  const outPath = resolve(a.need('--out'));
  const prior = new Map<string, SealedAnswerRow>();
  try { for (const r of readJsonl(outPath) as SealedAnswerRow[]) if (!r.reader_error) prior.set(`${r.arm}:${r.question_id}`, r); } catch { /* fresh file */ }
  const { run, guard: g2 } = guard(a, manifest, 'evidence-auto-v2-e2-answer', questions.questions.length * 0.05);
  const rows: SealedAnswerRow[] = [];
  try {
    const jobs = questions.questions.flatMap(sq => ['chunk', 'auto'].map(arm => ({ sq, arm })));
    let i = 0;
    await Promise.all(Array.from({ length: a.num('--concurrency', 6) }, async () => {
      while (i < jobs.length) {
        const { sq, arm } = jobs[i++];
        const done = prior.get(`${arm}:${sq.question_id}`);
        if (done) { rows.push(done); continue; }
        const fq = frozen.questions.get(sq.question_id);
        if (!fq) throw new Error(`${sq.question_id} is not frozen`);
        const built = buildSealedRequests(ctx, fq, 'auto')[arm === 'chunk' ? 'chunk' : 'winner'];
        const row: SealedAnswerRow = { question_id: sq.question_id, arm, provider_input_tokens: null, request_sha256: requestSha(built.request), evidence_sha256: built.frozenArm.evidence_sha256 };
        try { const r = await readerCall(g, built.request); row.hypothesis = r.text; row.provider_input_tokens = providerInputTokens(r.usage); }
        catch (e: any) { if (e instanceof BudgetExceededError) throw e; row.reader_error = String(e?.message ?? e).slice(0, 300); }
        rows.push(row);
        log(`[e2-answer] ${arm} ${rows.length}/${jobs.length}${row.reader_error ? ' ERROR' : ''}`);
      }
    }));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rows.map(r => JSON.stringify({ ...r, decision_manifest_sha256: sha })).join('\n') + '\n');
    process.stdout.write(JSON.stringify({ rows: rows.length, errors: rows.filter(r => r.reader_error).length, cost: receiptCost(run.close()) }) + '\n');
  } finally { g2.uninstall(); }
}

async function cmdE2Score(a: Args) {
  const { manifest } = manifestV2();
  const s = await sealed();
  const lib = await import('./sealed-confirmation-lib.ts');
  const questions = s.loadQuestions(a.need('--questions'), s.sealedManifest);
  const answersPath = a.need('--answers');
  const answers = readJsonl(answersPath) as SealedAnswerRow[];
  const g = await gbrainFor(a);
  const outPath = resolve(a.need('--out'));
  const privateDir = resolve(a.need('--private-dir'));
  const { run, guard: g2 } = guard(a, manifest, 'evidence-auto-v2-e2-score', questions.questions.length * 2 * 0.004);
  const llm = new lib.LlmClient({ ledger: new lib.SpendLedger(join(privateDir, 'e2-judge-spend.jsonl'), a.num('--cap-usd', 5)), cacheDir: join(privateDir, 'e2-llm-cache') });
  const labelsPath = a.need('--labels');
  const accessLog = a.get('--access-log') ?? join(dirname(resolve(labelsPath)), 'access-log.jsonl');
  const kinds = new Map<string, string>();
  try {
    const result = await scoreSealed({
      manifest: asV1(manifest), winner: 'auto', questions, answers, decisionId: manifest.e2.decision_id,
      decide: (c: OutcomeRow[], w: OutcomeRow[]) => decideE2V2(manifest, c, w),
      openLabels: decisionId => {
        const labels = s.openLabels(labelsPath, s.sealedManifest, { path: accessLog, action: 'score', purpose: a.need('--purpose'), decision_id: decisionId, run_sha256: createHash('sha256').update(readFileSync(answersPath)).digest('hex') });
        for (const l of labels.labels) kinds.set(l.question_id, l.question_type);
        return labels;
      },
      judgePrimary: async (l, question, hyp) => { const f = await gbrainJudge(g, { question_id: gbrainJudgeId(l), question_type: l.question_type, question, answer: l.answer }, hyp); return f.judge_correct === true ? 1 : f.judge_correct === false ? 0 : null; },
      judgeConfirm: async (l, question, hyp) => ((await s.judge(llm, `e2v2 ${l.question_id}`, l.question_type, question, l.answer, hyp)) ? 1 : 0),
    });
    const byKind: Record<string, { n: number; chunk: number; auto: number; chunk_official: number; auto_official: number }> = {};
    for (const j of result.judgments) {
      const k = kinds.get(j.question_id)!;
      const b = (byKind[k] ??= { n: 0, chunk: 0, auto: 0, chunk_official: 0, auto_official: 0 });
      if (j.arm === 'chunk') { b.n++; b.chunk += j.primary === 1 ? 1 : 0; b.chunk_official += j.confirmation === 1 ? 1 : 0; }
      else { b.auto += j.primary === 1 ? 1 : 0; b.auto_official += j.confirmation === 1 ? 1 : 0; }
    }
    const tokens = (arm: string) => { const xs = answers.filter(r => r.arm === arm && r.provider_input_tokens !== null).map(r => r.provider_input_tokens!); return mean(xs); };
    const accessLines = readFileSync(accessLog, 'utf8').split('\n').filter(l => l.trim()).length;
    writeJson(outPath, { decision_id: result.decision_id, decision: result.decision, by_kind: byKind, mean_provider_input_tokens: { chunk: tokens('chunk'), auto: tokens('auto') }, access_log_lines: accessLines, cost: receiptCost(run.close()) });
    writeJson(join(privateDir, 'e2-private-judgments.json'), result.judgments);
    process.stdout.write(JSON.stringify(result.decision, null, 2) + '\n');
  } finally { g2.uninstall(); }
}

async function cmdCosts() { process.stdout.write(JSON.stringify(costPlanV2(), null, 2) + '\n'); }

/**
 * Development-data budget check (not preregistered): auto at a newer gbrain
 * commit's default budget on the LongMemEval questions that auto trimmed at
 * 16,000 tokens, on the same frozen hit lists, reader and judges. Haystacks
 * are re-imported without embeddings (assembly reads stored chunks only), and
 * every frozen hit's chunk text is checked against the new import first.
 */
async function cmdBudgetCheck(a: Args) {
  const { manifest } = manifestV2();
  const g = await gbrainFor(a, true);
  const frozen = readFrozen(a.need('--frozen-dir'));
  const ds = new Map(loadDataset(a.need('--dataset'), manifest.data.longmemeval_s.sha256).map(q => [q.question_id, q]));
  const cut = [...frozen.questions.values()].filter(q => q.arms.auto?.results && autoDiagnostics(JSON.parse(frozen.store.get(q.arms.auto.results))).truncated > 0).map(q => q.question_id).sort();
  const ids = cut.slice(0, a.num('--limit', cut.length));
  const renderer = rendererFrom(g);
  if (createHash('sha256').update(renderer.system).digest('hex') !== manifest.reader.system_sha256) throw new Error('reader system text changed');
  const outDir = resolve(a.need('--out-dir'));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'budget-check.ndjson');
  const done = new Set<string>();
  try { for (const r of readJsonl(outPath) as any[]) if (!r.reader_error) done.add(r.question_id); } catch { /* fresh */ }
  const identity = (await import('./evidence-delivery/gbrain.ts')).gbrainIdentity(g.dir);
  const o = budgetOptions(a, manifest);
  const { startPaidRun } = await import('./budget-ledger.ts');
  const { run, guard: g2 } = startPaidRun('evidence-auto-v2-budget-check', { ...o, estimateUsd: ids.length * 0.08, log });
  const engine = await g.harness.createBenchmarkBrain();
  try {
    for (const id of ids) {
      if (done.has(id)) continue;
      const q = frozen.questions.get(id)!;
      const d = ds.get(id)!;
      await g.harness.resetTables(engine);
      for (const p of g.adapter.haystackToPages(d)) await g.importFile.importFromContent(engine, p.slug, p.content, { noEmbed: true });
      const hitTextOk = await Promise.all(q.hits5.map(async h => ((await engine.getChunks(h.slug)) as any[]).find(c => c.id === h.chunk_id)?.chunk_text === frozen.store.get(h.text)));
      const out = await g.evidence!.assembleEvidenceForHits(engine, { hits: q.hits5.map(h => ({ source_id: 'default', slug: h.slug, chunk_id: h.chunk_id })), return_unit: 'auto', caller: { remote: false } });
      const diag = autoDiagnostics(out.results as any[]);
      const dates = new Map(q.pages.map(p => [p.slug, p.date]));
      const sessions = (out.results as any[]).map(r => ({ session_id: renderer.sessionIdFromSlug(r.slug), ...(dates.get(r.slug) ? { date: dates.get(r.slug)! } : {}), body: String(r.chunk_text) }));
      const { request } = (await import('./evidence-delivery/arms.ts')).buildRequest(renderer, { question: d.question, question_date: d.question_date }, sessions, SONNET, manifest.reader.max_tokens);
      const row: Record<string, unknown> = {
        question_id: id, question_type: d.question_type, gbrain_commit: identity.commit, hits_text_match: hitTextOk.every(Boolean), budget_tokens: (out.delivery as any)?.budget_tokens ?? null,
        delivery: diag, product_encoding_tokens: (out.results as any[]).reduce((t, r) => t + (r.delivered?.tokens ?? 0), 0), serialized_tool_tokens: g.tokens.estimateTokens(JSON.stringify(out.results, null, 2)),
        request_sha256: requestSha(request), evidence_fingerprint: g.evidence!.evidenceFingerprint(out.results as any),
      };
      try {
        const rr = await readerCall(g, request);
        const jq = { question_id: id, question_type: d.question_type, question: d.question, answer: d.answer };
        const { officialJudge } = await import('./evidence-delivery/calls.ts');
        const [gj, oj] = await Promise.all([gbrainJudge(g, jq, rr.text), officialJudge(jq, rr.text)]);
        Object.assign(row, { hypothesis: rr.text, provider_input_tokens: providerInputTokens(rr.usage), primary: gj.judge_correct === true ? 1 : gj.judge_correct === false ? 0 : null, confirmation: (oj as any).off_judge_correct === true ? 1 : (oj as any).off_judge_correct === false ? 0 : null });
      } catch (e: any) {
        if (e instanceof BudgetExceededError) throw e;
        row.reader_error = String(e?.message ?? e).slice(0, 300);
      }
      writeFileSync(outPath, JSON.stringify(row) + '\n', { flag: 'a' });
      log(`[budget-check] ${id} budget=${row.budget_tokens} truncated=${diag.truncated} primary=${row.primary}`);
    }
    process.stdout.write(JSON.stringify({ questions: ids.length, cost: receiptCost(run.close()) }) + '\n');
  } finally { await engine.disconnect(); g2.uninstall(); }
}

const COMMANDS: Record<string, (a: Args) => Promise<void>> = {
  power: cmdPower, costs: cmdCosts, 'budget-check': cmdBudgetCheck, analyze: cmdAnalyze, parity: cmdParity, 'campaign-open': cmdCampaignOpen, freeze: cmdFreeze,
  'merge-frozen': cmdMergeFrozen, e1: cmdE1, 'e2-freeze': cmdE2Freeze, 'e2-answer': cmdE2Answer, 'e2-score': cmdE2Score,
};

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) { process.stderr.write(`usage: bun eval/runner/evidence-auto-v2.ts <${Object.keys(COMMANDS).join('|')}> ...\n`); process.exit(2); }
  fn(new Args(rest)).then(() => process.exit(process.exitCode ?? 0)).catch(e => { process.stderr.write(`[evidence-auto-v2] FATAL: ${e?.stack ?? e}\n`); process.exit(1); });
}

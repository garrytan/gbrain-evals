/**
 * Sealed confirmation runner (plan amendment 1).
 *
 * The sealed set's questions and labels are private files. This runner keeps
 * the two apart:
 *
 *   system-under-test side (never sees labels)
 *     validate   check a questions file against the input allowlist and its commitment
 *     run        retrieve with gbrain through the LongMemEval runner's code path
 *     answer     optional reader over the retrieved sessions (hypotheses file)
 *
 *   evaluator side (opens labels; every open appends to the access log)
 *     score        recall over the ledger's gold sessions, optional official-prompt judge
 *     solvability  oracle-evidence reader and no-memory reader, for the set's own receipt
 *
 * The labels path is supplied only at scoring time. Before any label is
 * parsed, its bytes must hash to the commitment in the public manifest.
 * Reports carry aggregate counts and per-question pass/fail by opaque id,
 * never gold session ids or answers.
 *
 * Usage (repository root):
 *   bun eval/runner/sealed-confirmation.ts validate --questions <q.json>
 *   bun eval/runner/sealed-confirmation.ts run --questions <q.json> --out-dir <dir> --adapters hybrid --top-k 5
 *   bun eval/runner/sealed-confirmation.ts answer --questions <q.json> --run <dir>/run-hybrid.jsonl --out <hyp.jsonl> --cap-usd 5
 *   bun eval/runner/sealed-confirmation.ts score --run <run.jsonl> --labels <private labels.json> \
 *     --purpose "release decision X" --decision-id <id> [--questions <q.json> --judge --cap-usd 2] --out <report.json>
 *   bun eval/runner/sealed-confirmation.ts solvability --questions <q.json> --labels <labels.json> --out <private.jsonl> --cap-usd 10
 *
 * Evidence-delivery decisions (a committed decision file names the gbrain
 * commit, retrieval pins and arms; paid steps join a budget-ledger run):
 *   evidence-freeze  --manifest <m> --questions <q> --decision <d.json> --out-dir <frozen> --embed-cache <sqlite> --gbrain-dir <checkout> --budget-run-id <id> [--shard k/n, by haystack]
 *   evidence-answer  --manifest <m> --questions <q> --decision <d.json> --evidence-dir <frozen> --arm <id> --out <answers.jsonl> --cap-usd <n> --gbrain-dir <checkout> --budget-run-id <id>
 *   score            (above) on each arm's answers file, with --judge
 *   decide           --manifest <m> --decision <d.json> --compare <compare.ts --json output> --answers <a.jsonl,b.jsonl> --out <decision.json>
 *
 * --manifest defaults to eval/data/sealed-confirmation-v1/manifest.json.
 * --access-log defaults to access-log.jsonl next to the labels file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  LlmClient, SpendLedger, appendAccessLog, assertCommitment, judgePrompt, judgeSaysYes, mapPool, readerPrompt, scoreRetrieval,
  sha256File, sha256Hex, validateLabelsFile, validateQuestionsFile, type Commitment, type LabelsFile, type QuestionType, type QuestionsFile,
  type RunRow, type SealedLabel, type Turn,
} from './sealed-confirmation-lib.ts';

export const DEFAULT_MANIFEST = join(import.meta.dir, '..', 'data', 'sealed-confirmation-v1', 'manifest.json');
export const READER_MODEL = 'claude-sonnet-4-6';
export const JUDGE_MODEL = 'gpt-4o-2024-08-06';

interface Manifest { set: string; commitments: Record<string, Commitment | Omit<Commitment, 'file'>> }

export function loadManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function commitment(m: Manifest, file: 'questions.json' | 'labels.json'): Commitment {
  const c = m.commitments?.[file];
  if (!c) throw new Error(`manifest has no commitment for ${file}`);
  return { file, sha256: c.sha256, bytes: c.bytes };
}

/** Read the questions file: commitment first (when a manifest is given), then the allowlist. */
export function loadQuestions(path: string, manifest: Manifest | null): QuestionsFile {
  const bytes = manifest ? assertCommitment(path, commitment(manifest, 'questions.json')) : readFileSync(path);
  const q = JSON.parse(bytes.toString('utf8'));
  const problems = validateQuestionsFile(q);
  if (problems.length) throw new Error(`questions file rejected:\n${problems.slice(0, 20).join('\n')}`);
  return q;
}

/** Open the labels: commitment check, then an access-log line, then parse. */
export function openLabels(path: string, manifest: Manifest, log: { path: string; action: 'score' | 'solvability'; purpose: string; decision_id: string | null; run_sha256: string | null }): LabelsFile {
  if (!log.purpose.trim()) throw new Error('--purpose is required to open sealed labels');
  const c = commitment(manifest, 'labels.json');
  const bytes = assertCommitment(path, c);
  if (log.action === 'score' && !log.decision_id?.trim()) throw new Error('--decision-id is required to open sealed labels for scoring (protocol: every scoring open is a named release decision)');
  appendAccessLog(log.path, { action: log.action, purpose: log.purpose, decision_id: log.decision_id, labels_sha256: c.sha256, run_sha256: log.run_sha256 });
  return JSON.parse(bytes.toString('utf8'));
}

/** LongMemEval-shaped rows for the existing retrieval runner, with no labels and a neutral type. */
export function toLmeRows(q: QuestionsFile) {
  const hay = new Map(q.haystacks.map(h => [h.haystack_id, h]));
  return q.questions.map(x => {
    const h = hay.get(x.haystack_id)!;
    return {
      question_id: x.question_id,
      question_type: 'sealed-unlabeled',
      question: x.question,
      question_date: x.question_date,
      answer: '',
      haystack_dates: h.sessions.map(s => s.date),
      haystack_session_ids: h.sessions.map(s => s.session_id),
      haystack_sessions: h.sessions.map(s => s.turns),
      answer_session_ids: [] as string[],
    };
  });
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ─── Readers and judge ────────────────────────────────────────────

export async function readAnswer(llm: LlmClient, label: string, prompt: string): Promise<{ text: string; truncated: boolean; input_tokens: number }> {
  const r = await llm.anthropic(label, { model: READER_MODEL, max_tokens: 2048, temperature: 0, messages: [{ role: 'user', content: prompt }] }, Math.ceil(prompt.length / 3.5));
  return { text: r.text, truncated: r.usage.output_tokens >= 2048, input_tokens: r.usage.input_tokens };
}

export async function judge(llm: LlmClient, label: string, type: QuestionType, question: string, answer: string, response: string): Promise<boolean> {
  const prompt = judgePrompt(type, question, answer, response);
  const r = await llm.openai(label, { model: JUDGE_MODEL, input: [{ role: 'user', content: prompt }], temperature: 0, max_output_tokens: 16 }, Math.ceil(prompt.length / 3.5));
  return judgeSaysYes(r.text);
}

function llmFor(spendPath: string, capUsd: number | null): LlmClient {
  if (capUsd === null || !(capUsd > 0)) throw new Error('--cap-usd is required for paid steps');
  return new LlmClient({ ledger: new SpendLedger(spendPath, capUsd), cacheDir: join(dirname(spendPath), 'llm-cache') });
}

// ─── Subcommands ──────────────────────────────────────────────────

async function cmdRun(a: Args) {
  const manifest = a.flag('--no-commitment') ? null : loadManifest(a.get('--manifest') ?? DEFAULT_MANIFEST);
  await runSealed({
    questionsPath: a.need('--questions'), outDir: a.need('--out-dir'), manifest,
    adapters: (a.get('--adapters') ?? 'hybrid').split(','), topK: Number(a.get('--top-k') ?? 5), passthrough: a.rest,
  });
}

/**
 * Retrieval through the LongMemEval runner's own code path: the sealed
 * questions are exported in LongMemEval shape with empty gold lists, run()
 * ingests each haystack under opaque slugs and searches, and the retrieved
 * session ids are copied into a run file for the scorer.
 */
export async function runSealed(o: { questionsPath: string; outDir: string; manifest: Manifest | null; adapters: string[]; topK: number; passthrough: string[] }): Promise<string[]> {
  const q = loadQuestions(o.questionsPath, o.manifest);
  const outDir = resolve(o.outDir);
  mkdirSync(outDir, { recursive: true });
  const exportPath = join(outDir, 'lme-shaped-input.json');
  writeFileSync(exportPath, JSON.stringify(toLmeRows(q)));
  const { parseOpts, run } = await import('./longmemeval.ts');
  const written: string[] = [];
  for (const adapter of o.adapters) {
    const ndjson = join(outDir, `lme-rows-${adapter}.ndjson`);
    if (existsSync(ndjson)) throw new Error(`${ndjson} exists; use a fresh --out-dir`);
    const opts = {
      ...parseOpts(['--path', exportPath, '--adapters', adapter, '--top-k', String(o.topK), ...o.passthrough]),
      datasetName: o.manifest?.set ?? 'sealed-confirmation-v1', ndjsonPath: ndjson, output: join(outDir, `lme-summary-${adapter}.json`),
      reportsDir: join(outDir, `reports-${adapter}`), minRecallAll: 0,
    };
    const result = await run(opts);
    if (result.receipt.run_status === 'skipped') throw new Error(`adapter ${adapter} skipped: ${result.receipt.skip_reason}`);
    const rows = readJsonl<any>(ndjson);
    const out: RunRow[] = rows.map(r => ({ question_id: r.question_id, retrieved: r.retrieved, ...(r.error ? { error: r.error } : {}) }));
    const meta = {
      record_type: 'meta', adapter: rows[0]?.adapter ?? adapter, top_k: o.topK, questions_sha256: sha256File(o.questionsPath),
      run_config_hash: rows[0]?.run_config_hash ?? null, gbrain_version: rows[0]?.gbrain_version ?? null, gbrain_pin: rows[0]?.gbrain_pin ?? null,
      produced_by: 'eval/runner/longmemeval.ts run()',
      note: 'recall figures inside the lme-* files are meaningless here (the LongMemEval-shaped input carries no labels); score with the score subcommand',
    };
    const runPath = join(outDir, `run-${adapter}.jsonl`);
    writeFileSync(runPath, [meta, ...out].map(r => JSON.stringify(r)).join('\n') + '\n');
    process.stderr.write(`[sealed] ${adapter}: ${out.length} rows, ${out.filter(r => r.error).length} errors -> ${runPath}\n`);
    written.push(runPath);
  }
  return written;
}

async function cmdAnswer(a: Args) {
  const manifest = a.flag('--no-commitment') ? null : loadManifest(a.get('--manifest') ?? DEFAULT_MANIFEST);
  const q = loadQuestions(a.need('--questions'), manifest);
  const runRows = readJsonl<any>(a.need('--run')).filter(r => r.record_type !== 'meta') as RunRow[];
  const topK = Number(a.get('--top-k') ?? 5);
  const outPath = resolve(a.need('--out'));
  const llm = llmFor(a.get('--spend') ?? join(dirname(outPath), 'spend.jsonl'), numOrNull(a.get('--cap-usd')));
  const sessions = new Map(q.haystacks.flatMap(h => h.sessions.map(s => [s.session_id, s] as const)));
  const qById = new Map(q.questions.map(x => [x.question_id, x]));
  const out = await mapPool(runRows, 6, async r => {
    const question = qById.get(r.question_id);
    if (!question) throw new Error(`run row ${r.question_id} is not in the questions file`);
    const evidence = r.error ? [] : r.retrieved.slice(0, topK).map(id => sessions.get(id)).filter(s => s !== undefined);
    const ans = await readAnswer(llm, `answer ${r.question_id}`, readerPrompt(question.question, question.question_date, evidence));
    return { ...r, hypothesis: ans.text, reader_truncated: ans.truncated, reader_sessions: evidence.length };
  });
  writeFileSync(outPath, out.map(r => JSON.stringify(r)).join('\n') + '\n');
  process.stderr.write(`[sealed] wrote ${out.length} hypotheses -> ${outPath}\n`);
}

async function cmdScore(a: Args) {
  const manifest = loadManifest(a.get('--manifest') ?? DEFAULT_MANIFEST);
  const runPath = a.need('--run');
  const labelsPath = a.need('--labels');
  const runRows = readJsonl<any>(runPath).filter(r => r.record_type !== 'meta') as RunRow[];
  const topK = Number(a.get('--top-k') ?? 5);
  const labels = openLabels(labelsPath, manifest, {
    path: a.get('--access-log') ?? join(dirname(resolve(labelsPath)), 'access-log.jsonl'), action: 'score',
    purpose: a.get('--purpose') ?? '', decision_id: a.get('--decision-id') ?? null, run_sha256: sha256File(runPath),
  });
  const { summary, rows } = scoreRetrieval(runRows, labels.labels, topK);
  let qa: { n: number; correct: number; by_type: Record<string, { n: number; correct: number }> } | null = null;
  const correctById = new Map<string, boolean>();
  const q = a.get('--questions') ? loadQuestions(a.need('--questions'), manifest) : null;
  const haystackOf = new Map(q?.questions.map(x => [x.question_id, x.haystack_id]) ?? []);
  if (a.flag('--judge')) {
    if (!q) throw new Error('--questions is required with --judge');
    const problems = validateLabelsFile(labels, q);
    if (problems.length) throw new Error(`labels do not match questions:\n${problems.slice(0, 10).join('\n')}`);
    const qById = new Map(q.questions.map(x => [x.question_id, x]));
    const outPath = resolve(a.need('--out'));
    const llm = llmFor(a.get('--spend') ?? join(dirname(outPath), 'spend.jsonl'), numOrNull(a.get('--cap-usd')));
    const hyp = new Map(runRows.map(r => [r.question_id, r]));
    const paid = a.rest.includes('--budget-run-id') ? await paidRun(a, 'sealed-score', labels.labels.length * 0.004) : null;
    try {
      await mapPool(labels.labels, 8, async l => {
        const h = hyp.get(l.question_id);
        const ok = h?.hypothesis ? await judge(llm, `judge ${l.question_id}`, l.question_type, qById.get(l.question_id)!.question, l.answer, h.hypothesis) : false;
        correctById.set(l.question_id, ok);
      });
    } finally { paid?.run.close(); paid?.guard.uninstall(); }
    qa = { n: labels.labels.length, correct: [...correctById.values()].filter(Boolean).length, by_type: {} };
    for (const l of labels.labels) {
      const b = (qa.by_type[l.question_type] ??= { n: 0, correct: 0 });
      b.n++;
      b.correct += correctById.get(l.question_id) ? 1 : 0;
    }
  }
  const report = {
    set: manifest.set,
    scored_at: new Date().toISOString(),
    run_sha256: sha256File(runPath),
    labels_sha256: commitment(manifest, 'labels.json').sha256,
    retrieval: summary,
    ...(qa ? { answers: { reader_judge: `${JUDGE_MODEL} with the official LongMemEval evaluate_qa.py prompts`, ...qa } } : {}),
    per_question: rows.map(r => ({ question_id: r.question_id, question_type: r.question_type, ...(q ? { haystack_id: haystackOf.get(r.question_id) } : {}), recall_all: r.recall_all, recall_any: r.recall_any, ...(r.error ? { error: true, error_origin: 'sut' } : {}), ...(qa ? { answer_correct: correctById.get(r.question_id) ?? false } : {}) })),
  };
  const out = a.get('--out');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ retrieval: summary, answers: qa }, null, 2) + '\n');
}

export interface SolvabilityRow { question_id: string; question_type: QuestionType; oracle_sessions: number; oracle_correct: boolean; no_memory_correct: boolean; oracle_truncated: boolean; no_memory_truncated: boolean }

async function cmdSolvability(a: Args) {
  const manifest = a.flag('--no-commitment') ? null : loadManifest(a.get('--manifest') ?? DEFAULT_MANIFEST);
  const qPath = a.need('--questions');
  const q = loadQuestions(qPath, manifest);
  const labelsPath = a.need('--labels');
  const logPath = a.get('--access-log') ?? join(dirname(resolve(labelsPath)), 'access-log.jsonl');
  let labels: LabelsFile;
  if (manifest) {
    labels = openLabels(labelsPath, manifest, { path: logPath, action: 'solvability', purpose: a.get('--purpose') ?? 'pre-seal solvability check', decision_id: null, run_sha256: null });
  } else {
    labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
    appendAccessLog(logPath, { action: 'solvability', purpose: a.get('--purpose') ?? 'pre-seal solvability check (before the manifest existed)', decision_id: null, labels_sha256: sha256File(labelsPath), run_sha256: null });
  }
  const problems = validateLabelsFile(labels, q);
  if (problems.length) throw new Error(`labels do not match questions:\n${problems.slice(0, 10).join('\n')}`);
  const outPath = resolve(a.need('--out'));
  const llm = llmFor(a.get('--spend') ?? join(dirname(outPath), 'spend.jsonl'), numOrNull(a.get('--cap-usd')));
  const sessions = new Map(q.haystacks.flatMap(h => h.sessions.map(s => [s.session_id, s] as const)));
  const qById = new Map(q.questions.map(x => [x.question_id, x]));
  const rows: SolvabilityRow[] = await mapPool(labels.labels, 6, async (l: SealedLabel) => {
    const question = qById.get(l.question_id)!;
    const oracle = (l.abstention ? l.related_session_ids : l.answer_session_ids).map(id => sessions.get(id)!);
    const withEvidence = await readAnswer(llm, `oracle ${l.question_id}`, readerPrompt(question.question, question.question_date, oracle));
    const noMemory = await readAnswer(llm, `nomem ${l.question_id}`, readerPrompt(question.question, question.question_date, []));
    return {
      question_id: l.question_id, question_type: l.question_type, oracle_sessions: oracle.length,
      oracle_correct: await judge(llm, `judge-oracle ${l.question_id}`, l.question_type, question.question, l.answer, withEvidence.text),
      no_memory_correct: await judge(llm, `judge-nomem ${l.question_id}`, l.question_type, question.question, l.answer, noMemory.text),
      oracle_truncated: withEvidence.truncated, no_memory_truncated: noMemory.truncated,
    };
  });
  writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  process.stdout.write(JSON.stringify(summarizeSolvability(rows), null, 2) + '\n');
}

export function summarizeSolvability(rows: SolvabilityRow[]) {
  const by_type: Record<string, { n: number; oracle_correct: number; no_memory_correct: number }> = {};
  for (const r of rows) {
    const b = (by_type[r.question_type] ??= { n: 0, oracle_correct: 0, no_memory_correct: 0 });
    b.n++;
    b.oracle_correct += r.oracle_correct ? 1 : 0;
    b.no_memory_correct += r.no_memory_correct ? 1 : 0;
  }
  return {
    reader: READER_MODEL, judge: JUDGE_MODEL, n: rows.length,
    oracle_correct: rows.filter(r => r.oracle_correct).length,
    no_memory_correct: rows.filter(r => r.no_memory_correct).length,
    truncated_reader_outputs: rows.filter(r => r.oracle_truncated || r.no_memory_truncated).length,
    by_type,
  };
}

// ─── Evidence-delivery decisions (sealed v2 decision 1 onward) ────

/**
 * A preregistered evidence-delivery decision file: which gbrain commit, which
 * retrieval pins, which arms. The evidence freeze (eval/runner/evidence-delivery/freeze.ts)
 * reads candidate_commits, retrieval and arms from it, exactly as the auto v2
 * study's decision manifest did.
 */
export interface EvidenceDecision {
  schema: 'gbrain-evals/sealed-evidence-decision/v1';
  decision_id: string;
  sealed: { set: string; manifest: string; questions_sha256: string; labels_sha256: string };
  candidate_commits: { gbrain: string };
  retrieval: { top_k: number; mode: string };
  arms: Array<{ id: string; role: 'baseline' | 'candidate'; source: 'frozen' | 'product'; unit: string; budget_tokens: number | null; expected_budget_tokens?: number }>;
  rule: { family: string; noninferiority_comparison: string; superiority_comparison: string; alpha: number; max_reader_errors: number };
}

export function loadDecision(path: string, manifest: Manifest): { decision: EvidenceDecision; sha256: string; rel: string } {
  const decision = JSON.parse(readFileSync(path, 'utf8')) as EvidenceDecision;
  if (decision.schema !== 'gbrain-evals/sealed-evidence-decision/v1') throw new Error(`${path} is not a sealed evidence decision file`);
  if (decision.sealed.set !== manifest.set) throw new Error(`decision is for ${decision.sealed.set}, the manifest is ${manifest.set}`);
  if (decision.sealed.questions_sha256 !== commitment(manifest, 'questions.json').sha256 || decision.sealed.labels_sha256 !== commitment(manifest, 'labels.json').sha256) throw new Error('decision commitments differ from the manifest');
  if (!/^[0-9a-f]{40}$/.test(decision.candidate_commits.gbrain)) throw new Error('decision must pin a 40-hex gbrain commit');
  const root = resolve(import.meta.dir, '..', '..');
  const rel = relative(root, resolve(path));
  return { decision, sha256: sha256File(path), rel };
}

/**
 * The reader's evidence for one frozen arm: one pseudo-session per delivered
 * block, dated by its chat, with the block text as a single turn. This is the
 * same shape the v2 solvability chunk oracle used, so both arms reach the
 * protocol's reader prompt identically and only the delivered text differs.
 */
export function evidenceSessions(fq: Pick<FrozenQuestionLike, 'pages'>, blocks: Array<{ slug: string; text: string }>, textOf: (hash: string) => string): Array<{ date: string; turns: Turn[] }> {
  const dates = new Map(fq.pages.map(p => [p.slug, p.date]));
  return blocks.map(b => ({ date: dates.get(b.slug) ?? '', turns: [{ role: 'user' as const, content: textOf(b.text) }] }));
}

interface FrozenQuestionLike { pages: Array<{ slug: string; date: string | null }>; hits5: Array<{ rank: number; slug: string }> }

/** Delivery counts for one arm's frozen product results. */
export function deliveryCounts(results: Array<{ delivered?: { unit?: string; truncated?: boolean; reason?: string } }>) {
  const d = { blocks: results.length, page: 0, chunk: 0, truncated: 0, over_budget: 0 };
  for (const r of results) {
    if ((r.delivered?.unit ?? 'chunk') === 'page') d.page++; else d.chunk++;
    if (r.delivered?.truncated) d.truncated++;
    if (r.delivered?.reason === 'conversation_over_budget') d.over_budget++;
  }
  return d;
}

async function paidRun(a: Args, runner: string, estimateUsd: number) {
  const { startPaidRun, budgetOptionsFrom } = await import('./budget-ledger.ts');
  return startPaidRun(runner, { ...budgetOptionsFrom(a.rest), estimateUsd, log: l => process.stderr.write(l + '\n') });
}

async function sealedGbrain(a: Args) {
  const { loadGbrain, configureGbrainGateway, resolveGbrainDir } = await import('./evidence-delivery/gbrain.ts');
  const g = await loadGbrain(resolveGbrainDir(a.get('--gbrain-dir')), { requireEvidence: true });
  configureGbrainGateway(g);
  return g;
}

async function cmdEvidenceFreeze(a: Args) {
  const manifest = loadManifest(a.need('--manifest'));
  const questionsPath = a.need('--questions');
  const q = loadQuestions(questionsPath, manifest);
  const { decision, sha256, rel } = loadDecision(a.need('--decision'), manifest);
  if (!a.flag('--smoke')) {
    const { assertManifestCommitted } = await import('./evidence-delivery.ts');
    assertManifestCommitted(resolve(import.meta.dir, '..', '..'), rel);
  }
  const g = await sealedGbrain(a);
  const { freeze } = await import('./evidence-delivery/freeze.ts');
  const { sealedFreezeInputs } = await import('./evidence-delivery/e2-bridge.ts');
  const { receiptCost } = await import('./budget-ledger.ts');
  const shard = a.get('--shard')?.split('/').map(Number);
  const haystackIndex = new Map(q.haystacks.map((h, i) => [h.haystack_id, i]));
  const inShard = new Set(q.questions.filter(x => !shard || haystackIndex.get(x.haystack_id)! % shard[1] === shard[0]).map(x => x.question_id));
  const inputs = sealedFreezeInputs(toLmeRows(q).filter(r => inShard.has(r.question_id)));
  const { run, guard } = await paidRun(a, 'sealed-evidence-freeze', inputs.length * 0.01);
  try {
    const res = await freeze({ g, manifest: decision as any, manifestSha: sha256, outDir: resolve(a.need('--out-dir')), inputs, embedCachePath: resolve(a.need('--embed-cache')), datasetSha: commitment(manifest, 'questions.json').sha256, smoke: a.flag('--smoke'), log: l => process.stderr.write(l + '\n') });
    process.stdout.write(JSON.stringify({ frozen: res.frozen, skipped: res.skipped, errors: res.errors.length, cost: receiptCost(run.close()) }) + '\n');
    if (res.errors.length) process.exitCode = 1;
  } finally { guard.uninstall(); }
}

async function cmdEvidenceAnswer(a: Args) {
  const manifest = loadManifest(a.need('--manifest'));
  const q = loadQuestions(a.need('--questions'), manifest);
  const { decision, sha256 } = loadDecision(a.need('--decision'), manifest);
  const armId = a.need('--arm');
  const arm = decision.arms.find(x => x.id === armId);
  if (!arm) throw new Error(`${armId} is not an arm of ${decision.decision_id}`);
  const { readFrozen } = await import('./evidence-delivery/store.ts');
  const frozen = readFrozen(a.need('--evidence-dir'));
  if (!a.flag('--smoke')) {
    if (frozen.header.gbrain.commit !== decision.candidate_commits.gbrain) throw new Error(`evidence was frozen at ${frozen.header.gbrain.commit}, the decision pins ${decision.candidate_commits.gbrain}`);
    if (frozen.header.decision_manifest_sha256 !== sha256) throw new Error('evidence was frozen under a different decision file');
  }
  const g = await sealedGbrain(a);
  const topK = decision.retrieval.top_k;
  const outPath = resolve(a.need('--out'));
  const prior = new Map<string, any>();
  if (existsSync(outPath)) for (const r of readJsonl<any>(outPath)) if (!r.reader_error) prior.set(r.question_id, r);
  const llm = llmFor(a.get('--spend') ?? join(dirname(outPath), `spend-${armId}.jsonl`), numOrNull(a.get('--cap-usd')));
  const { receiptCost } = await import('./budget-ledger.ts');
  const hay = new Map(q.haystacks.map(h => [h.haystack_id, h]));
  const lme = new Map(toLmeRows(q).map(r => [r.question_id, r]));
  const { run, guard } = await paidRun(a, `sealed-evidence-answer-${armId}`, q.questions.length * (armId === 'chunk' ? 0.015 : 0.06));
  try {
    const rows = await mapPool(q.questions, a.get('--concurrency') ? Number(a.get('--concurrency')) : 6, async question => {
      if (prior.has(question.question_id)) return prior.get(question.question_id);
      const fq = frozen.questions.get(question.question_id);
      if (!fq) throw new Error(`${question.question_id} is not frozen`);
      const fa = fq.arms[armId];
      if (!fa) throw new Error(`${question.question_id} has no frozen ${armId} arm`);
      const budget = (fa.delivery as any)?.budget_tokens ?? null;
      if (arm.expected_budget_tokens !== undefined && budget !== arm.expected_budget_tokens) throw new Error(`${question.question_id}: applied ${armId} budget ${budget}, the decision expects ${arm.expected_budget_tokens}`);
      const pages = g.adapter.haystackToPages(lme.get(question.question_id));
      const ids = hay.get(question.haystack_id)!.sessions.map(s => s.session_id);
      if (pages.length !== ids.length) throw new Error(`${question.question_id}: ${pages.length} pages for ${ids.length} chats`);
      const sessionOf = new Map(pages.map((p, i) => [p.slug, ids[i]]));
      const retrieved = [...new Set([...fq.hits5].sort((x, y) => x.rank - y.rank).slice(0, topK).map(h => sessionOf.get(h.slug)!))];
      const prompt = readerPrompt(question.question, question.question_date, evidenceSessions(fq, fa.blocks, h => frozen.store.get(h)));
      const row: Record<string, unknown> = {
        question_id: question.question_id, haystack_id: question.haystack_id, arm: armId, retrieved,
        evidence_sha256: fa.evidence_sha256, prompt_sha256: sha256Hex(prompt), reader_blocks: fa.blocks.length,
        product_encoding_tokens: fa.product_encoding_tokens, budget_tokens: budget,
        ...(fa.results ? { delivery: deliveryCounts(JSON.parse(frozen.store.get(fa.results))) } : {}),
      };
      try {
        const ans = await readAnswer(llm, `${decision.decision_id} ${armId} ${question.question_id}`, prompt);
        Object.assign(row, { hypothesis: ans.text, reader_truncated: ans.truncated, reader_empty: !ans.text.trim(), reader_input_tokens: ans.input_tokens });
      } catch (e: any) {
        if (e?.name === 'BudgetExceededError' || String(e?.message ?? '').startsWith('spend cap')) throw e;
        row.reader_error = String(e?.message ?? e).slice(0, 300);
      }
      return row;
    });
    const meta = { record_type: 'meta', decision_id: decision.decision_id, decision_sha256: sha256, arm: armId, frozen_manifest_sha256: frozen.sha256, gbrain_commit: frozen.header.gbrain.commit, reader: READER_MODEL, questions_sha256: commitment(manifest, 'questions.json').sha256 };
    writeFileSync(outPath, [meta, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
    const errors = rows.filter((r: any) => r.reader_error).length;
    process.stdout.write(JSON.stringify({ arm: armId, rows: rows.length, reader_errors: errors, cost: receiptCost(run.close()) }) + '\n');
    if (errors) process.exitCode = 1;
  } finally { guard.uninstall(); }
}

export type DecisionVerdict = 'pass' | 'fail' | 'inconclusive';

/**
 * The preregistered rule over compare.ts's JSON output: the family's
 * non-inferiority comparison decides the release check; superiority is tested
 * only after non-inferiority passes (fixed sequence, so no further
 * adjustment), and needs a positive delta with both the exact McNemar and the
 * persona-clustered sign-flip two-sided p-values below alpha.
 */
export function decideEvidence(rule: EvidenceDecision['rule'], compare: { decision: { verdict: string; comparisons: Array<{ id: string; status: string; stats?: { delta: number; p_two_sided: number }; mcnemar?: { p_two_sided: number } }> } }, readerErrors: Record<string, number>): { verdict: DecisionVerdict; superiority: 'confirmed' | 'not_confirmed' | 'not_tested'; reasons: string[] } {
  const reasons: string[] = [];
  const over = Object.entries(readerErrors).filter(([, n]) => n > rule.max_reader_errors);
  if (over.length) return { verdict: 'inconclusive', superiority: 'not_tested', reasons: over.map(([arm, n]) => `${arm}: ${n} reader errors exceed ${rule.max_reader_errors}`) };
  const find = (id: string) => {
    const c = compare.decision.comparisons.find(x => x.id === id);
    if (!c) throw new Error(`compare output has no comparison ${id}`);
    return c;
  };
  const ni = find(rule.noninferiority_comparison);
  const verdict: DecisionVerdict = ni.status === 'pass' ? 'pass' : ni.status === 'fail' ? 'fail' : 'inconclusive';
  reasons.push(`non-inferiority: ${ni.status}`);
  if (verdict !== 'pass') return { verdict, superiority: 'not_tested', reasons };
  const sup = find(rule.superiority_comparison);
  if (!sup.stats || !sup.mcnemar) throw new Error('superiority needs paired stats and an exact McNemar test (binary metric)');
  const confirmed = sup.stats.delta > 0 && sup.mcnemar.p_two_sided < rule.alpha && sup.stats.p_two_sided < rule.alpha;
  reasons.push(`superiority: delta ${sup.stats.delta.toFixed(4)}, McNemar p ${sup.mcnemar.p_two_sided.toPrecision(3)}, sign-flip p ${sup.stats.p_two_sided.toPrecision(3)}`);
  return { verdict, superiority: confirmed ? 'confirmed' : 'not_confirmed', reasons };
}

async function cmdDecide(a: Args) {
  const manifest = loadManifest(a.need('--manifest'));
  const { decision, sha256 } = loadDecision(a.need('--decision'), manifest);
  const compare = JSON.parse(readFileSync(a.need('--compare'), 'utf8'));
  const errors: Record<string, number> = {};
  for (const path of (a.get('--answers') ?? '').split(',').filter(Boolean)) {
    const rows = readJsonl<any>(path);
    const arm = rows.find(r => r.record_type === 'meta')?.arm ?? path;
    errors[arm] = rows.filter(r => r.record_type !== 'meta' && r.reader_error).length;
  }
  const out = { decision_id: decision.decision_id, decision_sha256: sha256, reader_errors: errors, ...decideEvidence(decision.rule, compare, errors) };
  const outPath = a.get('--out');
  if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function cmdValidate(a: Args) {
  const manifest = a.flag('--no-commitment') ? null : loadManifest(a.get('--manifest') ?? DEFAULT_MANIFEST);
  const q = loadQuestions(a.need('--questions'), manifest);
  process.stdout.write(JSON.stringify({ ok: true, commitment_checked: manifest !== null, haystacks: q.haystacks.length, questions: q.questions.length }) + '\n');
}

// ─── CLI plumbing ─────────────────────────────────────────────────

const numOrNull = (s: string | null) => (s === null ? null : Number(s));

const OWN_FLAGS = new Set(['--questions', '--labels', '--manifest', '--out', '--out-dir', '--run', '--adapters', '--top-k', '--cap-usd', '--spend', '--purpose', '--decision-id', '--access-log', '--decision', '--evidence-dir', '--embed-cache', '--gbrain-dir', '--arm', '--concurrency', '--compare', '--answers', '--shard']);
const OWN_SWITCHES = new Set(['--judge', '--no-commitment', '--smoke']);

class Args {
  readonly rest: string[] = [];
  private values = new Map<string, string>();
  private switches = new Set<string>();
  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i++) {
      if (OWN_FLAGS.has(argv[i])) this.values.set(argv[i], argv[++i]);
      else if (OWN_SWITCHES.has(argv[i])) this.switches.add(argv[i]);
      else this.rest.push(argv[i]);
    }
  }
  get(name: string): string | null { return this.values.get(name) ?? null; }
  need(name: string): string { const v = this.get(name); if (!v) throw new Error(`${name} is required`); return v; }
  flag(name: string): boolean { return this.switches.has(name); }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = new Args(rest);
  const commands: Record<string, (a: Args) => unknown> = { validate: cmdValidate, run: cmdRun, answer: cmdAnswer, score: cmdScore, solvability: cmdSolvability, 'evidence-freeze': cmdEvidenceFreeze, 'evidence-answer': cmdEvidenceAnswer, decide: cmdDecide };
  const fn = commands[cmd];
  if (!fn) { process.stderr.write(`usage: sealed-confirmation.ts <${Object.keys(commands).join('|')}> ...\n`); process.exit(2); }
  Promise.resolve(fn(a)).catch(e => { process.stderr.write(`[sealed] FATAL: ${e?.message ?? e}\n`); process.exit(1); });
}


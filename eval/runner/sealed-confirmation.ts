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
 * --manifest defaults to eval/data/sealed-confirmation-v1/manifest.json.
 * --access-log defaults to access-log.jsonl next to the labels file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  LlmClient, SpendLedger, appendAccessLog, assertCommitment, judgePrompt, judgeSaysYes, mapPool, readerPrompt, scoreRetrieval,
  sha256File, validateLabelsFile, validateQuestionsFile, type Commitment, type LabelsFile, type QuestionType, type QuestionsFile,
  type RunRow, type SealedLabel,
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

export async function readAnswer(llm: LlmClient, label: string, prompt: string): Promise<{ text: string; truncated: boolean }> {
  const r = await llm.anthropic(label, { model: READER_MODEL, max_tokens: 2048, temperature: 0, messages: [{ role: 'user', content: prompt }] }, Math.ceil(prompt.length / 3.5));
  return { text: r.text, truncated: r.usage.output_tokens >= 2048 };
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
      datasetName: 'sealed-confirmation-v1', ndjsonPath: ndjson, output: join(outDir, `lme-summary-${adapter}.json`),
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
  if (a.flag('--judge')) {
    const q = loadQuestions(a.need('--questions'), manifest);
    const problems = validateLabelsFile(labels, q);
    if (problems.length) throw new Error(`labels do not match questions:\n${problems.slice(0, 10).join('\n')}`);
    const qById = new Map(q.questions.map(x => [x.question_id, x]));
    const outPath = resolve(a.need('--out'));
    const llm = llmFor(a.get('--spend') ?? join(dirname(outPath), 'spend.jsonl'), numOrNull(a.get('--cap-usd')));
    const hyp = new Map(runRows.map(r => [r.question_id, r]));
    await mapPool(labels.labels, 8, async l => {
      const h = hyp.get(l.question_id);
      const ok = h?.hypothesis ? await judge(llm, `judge ${l.question_id}`, l.question_type, qById.get(l.question_id)!.question, l.answer, h.hypothesis) : false;
      correctById.set(l.question_id, ok);
    });
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
    per_question: rows.map(r => ({ question_id: r.question_id, question_type: r.question_type, recall_all: r.recall_all, recall_any: r.recall_any, error: r.error, ...(qa ? { answer_correct: correctById.get(r.question_id) ?? false } : {}) })),
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

function cmdValidate(a: Args) {
  const manifest = a.flag('--no-commitment') ? null : loadManifest(a.get('--manifest') ?? DEFAULT_MANIFEST);
  const q = loadQuestions(a.need('--questions'), manifest);
  process.stdout.write(JSON.stringify({ ok: true, commitment_checked: manifest !== null, haystacks: q.haystacks.length, questions: q.questions.length }) + '\n');
}

// ─── CLI plumbing ─────────────────────────────────────────────────

const numOrNull = (s: string | null) => (s === null ? null : Number(s));

const OWN_FLAGS = new Set(['--questions', '--labels', '--manifest', '--out', '--out-dir', '--run', '--adapters', '--top-k', '--cap-usd', '--spend', '--purpose', '--decision-id', '--access-log']);
const OWN_SWITCHES = new Set(['--judge', '--no-commitment']);

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
  const commands: Record<string, (a: Args) => unknown> = { validate: cmdValidate, run: cmdRun, answer: cmdAnswer, score: cmdScore, solvability: cmdSolvability };
  const fn = commands[cmd];
  if (!fn) { process.stderr.write(`usage: sealed-confirmation.ts <${Object.keys(commands).join('|')}> ...\n`); process.exit(2); }
  Promise.resolve(fn(a)).catch(e => { process.stderr.write(`[sealed] FATAL: ${e?.message ?? e}\n`); process.exit(1); });
}


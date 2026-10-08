/**
 * Sealed confirmation set: shared contracts (plan amendment 1).
 *
 * The sealed set is a separately authored LongMemEval-style corpus that no one
 * tunes on. Its questions and labels live outside this repository; only the
 * generator, its prompts, a manifest and SHA-256 commitments are public.
 *
 * This module holds the pieces the generator, the runner and the tests share:
 *   - the two private file shapes and the input allowlist for the questions
 *     file (the system under test may only ever see allowlisted fields);
 *   - commitment checks (a labels or questions file must hash to the value
 *     committed in the manifest before anything reads it for scoring);
 *   - the access log every label read appends to;
 *   - the reference scorer (recall over the ledger's gold sessions) and the
 *     official LongMemEval judge prompts;
 *   - a paid-call wrapper with a durable reservation ledger and a
 *     content-addressed response cache.
 */
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { recallAllAtK, recallAnyAtK, uniqueInOrder } from './metrics.ts';

// ─── File shapes ──────────────────────────────────────────────────

export const QUESTIONS_SCHEMA = 'sealed-confirmation-questions-v1';
export const LABELS_SCHEMA = 'sealed-confirmation-labels-v1';
export const QUESTION_TYPES = ['single-session-user', 'multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention'] as const;
export type QuestionType = typeof QUESTION_TYPES[number];

export interface Turn { role: 'user' | 'assistant'; content: string }
export interface HaystackSession { session_id: string; date: string; turns: Turn[] }
export interface Haystack { haystack_id: string; sessions: HaystackSession[] }
export interface SealedQuestion { question_id: string; haystack_id: string; question: string; question_date: string }
export interface QuestionsFile { schema: typeof QUESTIONS_SCHEMA; set_id: string; haystacks: Haystack[]; questions: SealedQuestion[] }

export interface SealedLabel {
  question_id: string;
  question_type: QuestionType;
  abstention: boolean;
  answer: string;
  /** Gold evidence sessions from the generation ledger. Empty for abstention items. */
  answer_session_ids: string[];
  /** Abstention only: sessions about the related topic that never state the asked detail. Not scored as recall. */
  related_session_ids: string[];
  /** Generation-time audit flags carried forward, never used to drop items. */
  audit_flags: string[];
}
export interface LabelsFile { schema: typeof LABELS_SCHEMA; set_id: string; labels: SealedLabel[] }

/**
 * The input allowlist (amendment 6). Every key of the questions file, at every
 * level, must be listed here. This is a positive list, not a search for known
 * leaky substrings: a new field is rejected until someone decides it is safe.
 */
export const INPUT_ALLOWLIST = {
  file: ['schema', 'set_id', 'haystacks', 'questions'],
  haystack: ['haystack_id', 'sessions'],
  session: ['session_id', 'date', 'turns'],
  turn: ['role', 'content'],
  question: ['question_id', 'haystack_id', 'question', 'question_date'],
} as const;

const OPAQUE_ID = /^[a-z]{1,4}-[0-9a-f]{10,16}$/;

function keysOutside(obj: unknown, allowed: readonly string[], where: string, out: string[]): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { out.push(`${where}: not an object`); return; }
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) out.push(`${where}: field "${k}" is not on the input allowlist`);
}

/** Validate a questions file against the allowlist and basic integrity rules. Returns problems; empty means valid. */
export function validateQuestionsFile(raw: unknown): string[] {
  const problems: string[] = [];
  keysOutside(raw, INPUT_ALLOWLIST.file, 'file', problems);
  const f = raw as QuestionsFile;
  if (f?.schema !== QUESTIONS_SCHEMA) problems.push(`file: schema must be ${QUESTIONS_SCHEMA}`);
  if (!Array.isArray(f?.haystacks) || !Array.isArray(f?.questions)) return [...problems, 'file: haystacks and questions must be arrays'];
  const haystackIds = new Set<string>();
  const sessionIds = new Set<string>();
  f.haystacks.forEach((h, hi) => {
    keysOutside(h, INPUT_ALLOWLIST.haystack, `haystacks[${hi}]`, problems);
    if (!OPAQUE_ID.test(h.haystack_id ?? '')) problems.push(`haystacks[${hi}]: haystack_id must be opaque`);
    if (haystackIds.has(h.haystack_id)) problems.push(`haystacks[${hi}]: duplicate haystack_id`);
    haystackIds.add(h.haystack_id);
    (h.sessions ?? []).forEach((s, si) => {
      const where = `haystacks[${hi}].sessions[${si}]`;
      keysOutside(s, INPUT_ALLOWLIST.session, where, problems);
      if (!OPAQUE_ID.test(s.session_id ?? '')) problems.push(`${where}: session_id must be opaque`);
      if (sessionIds.has(s.session_id)) problems.push(`${where}: duplicate session_id`);
      sessionIds.add(s.session_id);
      (s.turns ?? []).forEach((t, ti) => {
        keysOutside(t, INPUT_ALLOWLIST.turn, `${where}.turns[${ti}]`, problems);
        if (t.role !== 'user' && t.role !== 'assistant') problems.push(`${where}.turns[${ti}]: bad role`);
      });
    });
  });
  const questionIds = new Set<string>();
  f.questions.forEach((q, qi) => {
    keysOutside(q, INPUT_ALLOWLIST.question, `questions[${qi}]`, problems);
    if (!OPAQUE_ID.test(q.question_id ?? '')) problems.push(`questions[${qi}]: question_id must be opaque`);
    if (questionIds.has(q.question_id)) problems.push(`questions[${qi}]: duplicate question_id`);
    questionIds.add(q.question_id);
    if (!haystackIds.has(q.haystack_id)) problems.push(`questions[${qi}]: unknown haystack_id`);
  });
  return problems;
}

/** Validate labels against the questions they belong to. */
export function validateLabelsFile(labels: LabelsFile, questions: QuestionsFile): string[] {
  const problems: string[] = [];
  if (labels.schema !== LABELS_SCHEMA) problems.push(`labels: schema must be ${LABELS_SCHEMA}`);
  if (labels.set_id !== questions.set_id) problems.push('labels: set_id does not match the questions file');
  const qById = new Map(questions.questions.map(q => [q.question_id, q]));
  const sessionsByHaystack = new Map(questions.haystacks.map(h => [h.haystack_id, new Set(h.sessions.map(s => s.session_id))]));
  const seen = new Set<string>();
  for (const l of labels.labels) {
    const q = qById.get(l.question_id);
    if (!q) { problems.push(`labels: ${l.question_id} has no question`); continue; }
    if (seen.has(l.question_id)) problems.push(`labels: duplicate ${l.question_id}`);
    seen.add(l.question_id);
    if (!QUESTION_TYPES.includes(l.question_type)) problems.push(`labels: ${l.question_id} bad type`);
    if (l.abstention !== (l.question_type === 'abstention')) problems.push(`labels: ${l.question_id} abstention flag disagrees with type`);
    if (!l.abstention && l.answer_session_ids.length === 0) problems.push(`labels: ${l.question_id} answerable item without gold sessions`);
    const inHaystack = sessionsByHaystack.get(q.haystack_id)!;
    for (const s of [...l.answer_session_ids, ...l.related_session_ids]) if (!inHaystack.has(s)) problems.push(`labels: ${l.question_id} gold session ${s} not in its haystack`);
  }
  for (const id of qById.keys()) if (!seen.has(id)) problems.push(`labels: question ${id} has no label`);
  return problems;
}

// ─── Commitments and access log ───────────────────────────────────

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Hex(readFileSync(path));
}

export interface Commitment { file: string; sha256: string; bytes: number }

/** Throw unless the file's bytes hash to the committed value. Nothing is parsed before this passes. */
export function assertCommitment(path: string, commitment: Commitment): Buffer {
  const bytes = readFileSync(path);
  const got = sha256Hex(bytes);
  if (got !== commitment.sha256 || bytes.length !== commitment.bytes) {
    throw new Error(`commitment mismatch for ${commitment.file}: expected sha256 ${commitment.sha256} (${commitment.bytes} bytes), got ${got} (${bytes.length} bytes)`);
  }
  return bytes;
}

export interface AccessLogEntry {
  at: string;
  action: 'score' | 'solvability' | 'open' | 'write';
  purpose: string;
  decision_id: string | null;
  labels_sha256: string;
  run_sha256: string | null;
  operator: string;
  host: string;
}

/** Append one line per label access. The log is append-only by convention and travels with the private files. */
export function appendAccessLog(logPath: string, entry: Omit<AccessLogEntry, 'at' | 'operator' | 'host'>): AccessLogEntry {
  const full: AccessLogEntry = { at: new Date().toISOString(), operator: safeUser(), host: hostname(), ...entry };
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(full) + '\n');
  return full;
}

const REPO_ROOT = realpathSync(resolve(import.meta.dir, '../..'));

/** The path with symlinks resolved; for a path not yet created, its nearest existing ancestor resolved plus the rest. */
export function resolvedPath(path: string): string {
  let probe = resolve(path);
  const tail: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) { tail.unshift(probe.slice(dirname(probe).length + 1)); probe = dirname(probe); }
  return join(realpathSync(probe), ...tail);
}

/** True when the path (symlinks resolved) is inside this repository. */
export function insideRepository(path: string): boolean {
  const r = relative(REPO_ROOT, resolvedPath(path));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * The root of the git worktree holding the path, or null. Symlinks are resolved first, so a link from a scratch
 * directory into a checkout counts as inside it. Any `.git` entry counts: a main checkout's directory, a linked
 * worktree's or submodule's `.git` file.
 */
export function gitWorktreeRoot(path: string): string | null {
  let dir = resolvedPath(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Refuse a custody path (held-out input, custodian output or work root) inside any git worktree, where Git could pick it up. */
export function assertOutsideRepository(path: string, flag: string): void {
  const root = insideRepository(path) ? REPO_ROOT : gitWorktreeRoot(path);
  if (root) throw new Error(`${flag} ${path} is inside the repository or another git worktree (${root}, symlinks resolved); held-out files, custodian output and work directories live in the custodian's directory outside every git checkout. Pick a directory such as ~/q2-custody/<run> and rerun.`);
}

export interface CustodyRoots { output: string; work: string | null }

/**
 * Validate a sealed run's output and work roots before any custody material is read: both must be given explicitly
 * (no default under the repository or a shared cache), resolve outside every git worktree, and be writable. The
 * directories are created when missing.
 */
export function assertCustodyRoots(o: { output: string | undefined; work?: string | undefined; needsWork?: boolean; outputFlag?: string; workFlag?: string }): CustodyRoots {
  const outputFlag = o.outputFlag ?? '--output';
  const workFlag = o.workFlag ?? '--work';
  if (!o.output) throw new Error(`a sealed run needs an explicit ${outputFlag} <dir> outside every git worktree, checked before any custody file is read; pass one and rerun`);
  if (o.needsWork && !o.work) throw new Error(`a sealed run needs an explicit ${workFlag} <dir> outside every git worktree (brains, snapshots and line text stay there), checked before any custody file is read; pass one and rerun`);
  const roots: CustodyRoots = { output: resolve(o.output), work: o.work ? resolve(o.work) : null };
  for (const [flag, dir] of [[outputFlag, roots.output], [workFlag, roots.work]] as const) {
    if (!dir) continue;
    assertOutsideRepository(dir, flag);
    mkdirSync(dir, { recursive: true });
    try { accessSync(dir, fsConstants.W_OK); } catch { throw new Error(`${flag} ${dir} is not writable by this user; fix its permissions or pick another directory, then rerun`); }
  }
  return roots;
}

/**
 * Open one custody file the temporal-edges way: refuse a path inside any git
 * worktree, read the bytes, hash them, append an access-log line beside the
 * file, and only then hand the bytes back for parsing. Callers record the
 * SHA-256, never the path or the text.
 */
export function openCustodyFile(o: { file: string; flag: string; decisionId?: string; purpose?: string }): { bytes: Buffer; sha256: string } {
  if (!o.decisionId?.trim() || !o.purpose?.trim()) throw new Error(`custodian mode needs --decision-id and --purpose, recorded in the access log before ${o.flag} is read`);
  assertOutsideRepository(o.file, o.flag);
  const bytes = readFileSync(o.file);
  const sha256 = sha256Hex(bytes);
  appendAccessLog(join(dirname(resolve(o.file)), 'access-log.jsonl'), { action: 'open', purpose: o.purpose, decision_id: o.decisionId, labels_sha256: sha256, run_sha256: null });
  return { bytes, sha256 };
}

export interface CustodyTemplates { parsed: { id: string; templates: unknown }; sha256: string; roots: CustodyRoots }

function argFlag(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/**
 * The custodian's `{ id, templates }` file, the loader every held-out runner shares:
 * `--phrasing-file <custody path> --decision-id <id> --purpose <text>` plus an explicit `--output` (and `--work` when
 * the runner keeps brains or line text) outside every git worktree. Order: decision id and purpose, then the roots,
 * then the access-log line, then parsing. Without a phrasing file only dev seeds run.
 */
export function custodyTemplatesInput(argv: readonly string[], seeds: readonly number[], devSeeds: readonly number[], o: { needsWork?: boolean } = {}): CustodyTemplates | null {
  const file = argFlag(argv, '--phrasing-file');
  if (!file) {
    if (!seeds.every(s => devSeeds.includes(s))) throw new Error(`only dev seeds ${devSeeds.join(', ')} run here; held-out seeds belong to the custodian`);
    return null;
  }
  const decisionId = argFlag(argv, '--decision-id');
  const purpose = argFlag(argv, '--purpose');
  if (!decisionId || !purpose) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log before the phrasing file is read');
  const roots = assertCustodyRoots({ output: argFlag(argv, '--output'), work: argFlag(argv, '--work'), needsWork: o.needsWork });
  const { bytes, sha256 } = openCustodyFile({ file, flag: '--phrasing-file', decisionId, purpose });
  let parsed: { id: string; templates: unknown };
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (e) { throw new Error(`--phrasing-file (sha256 ${sha256}) is not JSON: ${(e as Error).message}; ask the custodian for the intact file`); }
  if (typeof parsed?.id !== 'string' || parsed.templates === undefined) throw new Error(`--phrasing-file (sha256 ${sha256}) needs { "id": string, "templates": ... }; ask the custodian for the intact file`);
  return { parsed, sha256, roots };
}

/**
 * The file list of a custody manifest under any of the accepted keys (`files`, or the set's own name such as `pages`
 * or `documents`). Exactly one key may be present; the refusal names the keys so the custodian can fix the file.
 */
export function manifestFiles(m: Record<string, unknown>, keys: readonly string[], what: string): Array<{ path: string; sha256: string }> {
  const present = keys.filter(k => m[k] !== undefined);
  if (present.length > 1) throw new Error(`${what} lists files under both ${present.join(' and ')}; keep one key (${keys.join(' or ')}) and ask the custodian to fix it`);
  const list = present.length ? m[present[0]] : undefined;
  if (!Array.isArray(list) || !list.length) throw new Error(`${what} needs a non-empty list of { path, sha256 } under ${keys.join(' or ')}; ask the custodian for the complete manifest`);
  return list as Array<{ path: string; sha256: string }>;
}

export interface CustodySeeds { id: string; seeds: number[]; sha256: string; roots: CustodyRoots }

/**
 * Fresh generator seeds from custody (`--seeds-file <custody path>` with `{ "id", "seeds": [..] }`), for runners
 * whose templates stay the generator's own. Order: decision id and purpose, explicit --output outside every git
 * worktree, the access-log line, then parsing. Dev seeds are refused, and so is a --seeds or --phrasing-file beside
 * it. Callers record only the file's SHA-256 and the seed values.
 */
export function custodySeedsInput(argv: readonly string[], devSeeds: readonly number[]): CustodySeeds | null {
  const file = argFlag(argv, '--seeds-file');
  if (!file) return null;
  if (argFlag(argv, '--seeds') || argFlag(argv, '--phrasing-file')) throw new Error('--seeds-file replaces --seeds and cannot run with --phrasing-file; pass exactly one seed source and rerun');
  const decisionId = argFlag(argv, '--decision-id');
  const purpose = argFlag(argv, '--purpose');
  if (!decisionId || !purpose) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log before the seeds file is read');
  const roots = assertCustodyRoots({ output: argFlag(argv, '--output') });
  const { bytes, sha256 } = openCustodyFile({ file, flag: '--seeds-file', decisionId, purpose });
  let parsed: { id?: unknown; seeds?: unknown };
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (e) { throw new Error(`--seeds-file (sha256 ${sha256}) is not JSON: ${(e as Error).message}; ask the custodian for the intact file`); }
  const seeds = parsed.seeds;
  if (typeof parsed.id !== 'string' || !Array.isArray(seeds) || !seeds.length || !seeds.every(x => Number.isSafeInteger(x) && (x as number) > 0)) throw new Error(`--seeds-file (sha256 ${sha256}) needs { "id": string, "seeds": [positive integers] }; ask the custodian to fix it`);
  if (new Set(seeds).size !== seeds.length) throw new Error(`--seeds-file (sha256 ${sha256}) lists a seed twice; ask the custodian to fix it`);
  const dev = (seeds as number[]).filter(x => devSeeds.includes(x));
  if (dev.length) throw new Error(`--seeds-file (sha256 ${sha256}) lists development seed(s) ${dev.join(', ')}; fresh seeds must avoid ${devSeeds.join(', ')}. Ask the custodian for fresh seeds.`);
  return { id: parsed.id, seeds: seeds as number[], sha256, roots };
}

// ─── Allowlisted aggregate export ─────────────────────────────────

const SAFE_EXPORT_STRING = /^[A-Za-z0-9_.:@/+=-]{0,96}$/;

/**
 * Copy only allowlisted paths of a custody receipt into an aggregate that may leave custody. Paths are dotted with `*`
 * for any object key or array index (`data.summary.g1.*`). Every exported leaf must be a number, boolean, null or a
 * short plain string without spaces (ids, hashes, model names, outcomes); anything else (line text, questions, answers) is refused,
 * and the refusal names the path so the allowlist, not the receipt, gets fixed.
 */
export function exportAggregates(source: unknown, allowlist: readonly string[]): { aggregate: Record<string, unknown>; exported: string[] } {
  const out: Record<string, unknown> = {};
  const exported: string[] = [];
  const checkLeaf = (v: unknown, path: string): unknown => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (!SAFE_EXPORT_STRING.test(v)) throw new Error(`export refused: ${path} holds a string that is not a short plain identifier; aggregates leave custody as numbers, outcomes and hashes only. Remove ${path} from the allowlist or export a count instead.`);
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => checkLeaf(x, `${path}.${i}`));
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      if (!SAFE_EXPORT_STRING.test(k)) throw new Error(`export refused: key ${JSON.stringify(k).slice(0, 40)} under ${path} is not a plain identifier`);
      return [k, checkLeaf(x, `${path}.${k}`)];
    }));
    throw new Error(`export refused: ${path} has an unsupported value type`);
  };
  // Containers are rebuilt with the source's shape: arrays stay arrays.
  const set = (path: string[], arrays: boolean[], value: unknown) => {
    let cur = out as Record<string, unknown>;
    path.slice(0, -1).forEach((k, i) => { cur = (cur[k] ??= arrays[i + 1] ? [] : {}) as Record<string, unknown>; });
    cur[path[path.length - 1]] = value;
  };
  const walk = (node: unknown, pattern: string[], at: string[], arrays: boolean[]) => {
    if (!pattern.length) { set(at, arrays, checkLeaf(node, at.join('.'))); exported.push(at.join('.')); return; }
    if (node === null || typeof node !== 'object') return;
    const [head, ...rest] = pattern;
    const keys = head === '*' ? Object.keys(node as object) : [head];
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(node, k)) walk((node as Record<string, unknown>)[k], rest, [...at, k], [...arrays, Array.isArray(node)]);
  };
  for (const p of allowlist) walk(source, p.split('.'), [], []);
  return { aggregate: out, exported: exported.sort() };
}

function safeUser(): string {
  try { return userInfo().username; } catch { return 'unknown'; }
}

// ─── Reference scorer ─────────────────────────────────────────────

export interface RunRow { question_id: string; retrieved: string[]; hypothesis?: string; error?: string }

export interface ScoredRow {
  question_id: string;
  question_type: QuestionType;
  abstention: boolean;
  recall_all: number | null;
  recall_any: number | null;
  error: boolean;
}

export interface Bucket { n: number; recall_all_hits: number; recall_any_hits: number; errors: number }

export interface RetrievalSummary {
  top_k: number;
  answerable: Bucket;
  abstention_excluded: number;
  by_type: Record<string, Bucket>;
  missing_rows: string[];
  unknown_rows: string[];
}

/**
 * Score retrieved session ids against the ledger's gold sessions. Abstention
 * items are excluded from recall denominators (the LongMemEval convention).
 * An errored or missing row stays in the denominator as a miss.
 */
export function scoreRetrieval(rows: RunRow[], labels: SealedLabel[], topK: number): { summary: RetrievalSummary; rows: ScoredRow[] } {
  const byId = new Map<string, RunRow>();
  const unknown: string[] = [];
  const labelIds = new Set(labels.map(l => l.question_id));
  for (const r of rows) {
    if (byId.has(r.question_id)) throw new Error(`duplicate run row for ${r.question_id}`);
    if (!labelIds.has(r.question_id)) unknown.push(r.question_id);
    byId.set(r.question_id, r);
  }
  const summary: RetrievalSummary = { top_k: topK, answerable: emptyBucket(), abstention_excluded: 0, by_type: {}, missing_rows: [], unknown_rows: unknown };
  const scored: ScoredRow[] = [];
  for (const l of labels) {
    const row = byId.get(l.question_id);
    if (!row) summary.missing_rows.push(l.question_id);
    if (l.abstention) {
      summary.abstention_excluded++;
      scored.push({ question_id: l.question_id, question_type: l.question_type, abstention: true, recall_all: null, recall_any: null, error: !row || row.error !== undefined });
      continue;
    }
    const failed = !row || row.error !== undefined;
    const ids = failed ? [] : uniqueInOrder(row!.retrieved);
    const gold = new Set(l.answer_session_ids);
    const all = recallAllAtK(ids, gold, topK);
    const any = recallAnyAtK(ids, gold, topK);
    const bucket = (summary.by_type[l.question_type] ??= emptyBucket());
    for (const b of [bucket, summary.answerable]) {
      b.n++;
      b.recall_all_hits += all;
      b.recall_any_hits += any;
      b.errors += failed ? 1 : 0;
    }
    scored.push({ question_id: l.question_id, question_type: l.question_type, abstention: false, recall_all: all, recall_any: any, error: failed });
  }
  return { summary, rows: scored };
}

function emptyBucket(): Bucket {
  return { n: 0, recall_all_hits: 0, recall_any_hits: 0, errors: 0 };
}

// ─── Official LongMemEval prompts ─────────────────────────────────

/** LongMemEval's oracle-session reader prompt with chain of thought (src/generation/run_generation.py, upstream main, fetched 2026-09-29). */
export const LME_READER_TEMPLATE = 'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n{history}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer (step by step):';

/** Render sessions the way LongMemEval's reader does: sorted by date, json history format. */
export function renderHistory(sessions: Array<{ date: string; turns: Turn[] }>): string {
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((s, i) => `\n### Session ${i + 1}:\nSession Date: ${s.date}\nSession Content:\n\n${JSON.stringify(s.turns)}\n`).join('');
}

export function readerPrompt(question: string, questionDate: string, sessions: Array<{ date: string; turns: Turn[] }>): string {
  return LME_READER_TEMPLATE.replace('{history}', renderHistory(sessions)).replace('{date}', questionDate).replace('{question}', question);
}

/** LongMemEval evaluate_qa.py get_anscheck_prompt, upstream main, fetched 2026-09-29. Abstention items use the unanswerable template. */
export function judgePrompt(type: QuestionType, question: string, answer: string, response: string): string {
  const base = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. ';
  let template: string;
  if (type === 'abstention') {
    template = 'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.';
  } else if (type === 'temporal-reasoning') {
    template = base + 'In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model\'s response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.';
  } else if (type === 'knowledge-update') {
    template = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.';
  } else {
    template = base + '\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.';
  }
  const parts = [question, answer, response];
  return template.replace(/\{\}/g, () => parts.shift() ?? '');
}

export function judgeSaysYes(text: string): boolean {
  return /\byes\b/i.test(text.trim().split(/\s+/).slice(0, 3).join(' '));
}

// ─── Paid calls: reservation ledger + response cache ──────────────

/**
 * USD per million tokens. Sources, checked 2026-09-29:
 * developers.openai.com/api/docs/pricing (gpt-6 short-context rows, gpt-4o);
 * anthropic.com/pricing (Sonnet 4.6).
 */
export const PRICES: Record<string, { input: number; cached_input: number; cache_write: number; output: number }> = {
  'gpt-6-sol': { input: 2.0, cached_input: 0.2, cache_write: 2.5, output: 10.0 },
  'gpt-6-luna': { input: 0.1, cached_input: 0.01, cache_write: 0.125, output: 0.5 },
  'gpt-4o-2024-08-06': { input: 2.5, cached_input: 1.25, cache_write: 2.5, output: 10.0 },
  'claude-sonnet-4-6': { input: 3.0, cached_input: 0.3, cache_write: 3.75, output: 15.0 },
};

export interface Usage { input_tokens: number; cached_tokens: number; cache_write_tokens: number; output_tokens: number; reasoning_tokens: number }

export function priceUsage(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  const fresh = Math.max(0, u.input_tokens - u.cached_tokens - u.cache_write_tokens);
  return (fresh * p.input + u.cached_tokens * p.cached_input + u.cache_write_tokens * p.cache_write + u.output_tokens * p.output) / 1e6;
}

/**
 * Durable spend ledger. Before every paid request (retries included) a
 * worst-case reservation is appended and checked against the cap; after the
 * request the actual usage-priced cost settles it. Reservations left
 * unsettled by a crash count at their reserved amount on the next start.
 */
export class SpendLedger {
  private settled = 0;
  private outstanding = new Map<string, number>();
  constructor(readonly path: string, readonly capUsd: number) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    const open = new Map<string, number>();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === 'reserve') open.set(e.id, e.usd);
      if (e.type === 'settle') { open.delete(e.id); this.settled += e.usd; }
    }
    for (const usd of open.values()) this.settled += usd;
  }
  get spentUsd(): number { return this.settled; }
  get committedUsd(): number { let t = this.settled; for (const v of this.outstanding.values()) t += v; return t; }
  reserve(label: string, model: string, usd: number): string {
    if (this.committedUsd + usd > this.capUsd) throw new Error(`spend cap: reserving $${usd.toFixed(4)} for ${label} would exceed $${this.capUsd} (committed $${this.committedUsd.toFixed(4)})`);
    const id = randomUUID();
    this.outstanding.set(id, usd);
    appendFileSync(this.path, JSON.stringify({ type: 'reserve', id, at: new Date().toISOString(), label, model, usd }) + '\n');
    return id;
  }
  settle(id: string, usd: number, usage: Usage | null, note?: string): void {
    this.outstanding.delete(id);
    this.settled += usd;
    appendFileSync(this.path, JSON.stringify({ type: 'settle', id, at: new Date().toISOString(), usd, usage, ...(note ? { note } : {}) }) + '\n');
  }
}

export interface LlmResult { text: string; usage: Usage; model_returned: string; cost_usd: number; cached: boolean; response_id: string | null }

export interface LlmClientOptions { ledger: SpendLedger; cacheDir: string; fetchImpl?: typeof fetch; anthropicCall?: (body: any) => Promise<any> }

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value as object).sort().map(k => JSON.stringify(k) + ':' + canonicalJson((value as any)[k])).join(',') + '}';
  return JSON.stringify(value);
}

const ZERO_USAGE: Usage = { input_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };

export class LlmClient {
  constructor(private o: LlmClientOptions) { mkdirSync(o.cacheDir, { recursive: true }); }

  /** OpenAI Responses API call. `body` is sent as-is; the cache key is its canonical hash. */
  async openai(label: string, body: Record<string, any>, estInputTokens: number): Promise<LlmResult> {
    return this.cachedCall('openai', label, body, estInputTokens, body.max_output_tokens, async () => {
      const res = await (this.o.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      if (!res.ok) throw Object.assign(new Error(`openai ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
      const u = json.usage ?? {};
      const usage: Usage = {
        input_tokens: u.input_tokens ?? 0,
        cached_tokens: u.input_tokens_details?.cached_tokens ?? 0,
        cache_write_tokens: u.input_tokens_details?.cache_write_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
      };
      if (json.status !== 'completed') return { usage, error: `openai status ${json.status}: ${JSON.stringify(json.incomplete_details ?? {})}` };
      const text = (json.output ?? []).filter((o: any) => o.type === 'message').flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
      return { usage, text, model_returned: json.model, response_id: json.id };
    });
  }

  /** Anthropic Messages API call. */
  async anthropic(label: string, body: Record<string, any>, estInputTokens: number): Promise<LlmResult> {
    return this.cachedCall('anthropic', label, body, estInputTokens, body.max_tokens, async () => {
      const call = this.o.anthropicCall ?? defaultAnthropicCall;
      const json = await call(body);
      const usage: Usage = { ...ZERO_USAGE, input_tokens: json.usage?.input_tokens ?? 0, output_tokens: json.usage?.output_tokens ?? 0 };
      const text = (json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      return { usage, text, model_returned: json.model, response_id: json.id ?? null, ...(json.stop_reason === 'max_tokens' ? { truncated: true } : {}) };
    });
  }

  private async cachedCall(provider: string, label: string, body: Record<string, any>, estInputTokens: number, maxOut: number,
    call: () => Promise<{ usage: Usage; text?: string; model_returned?: string; response_id?: string | null; error?: string }>): Promise<LlmResult> {
    const key = sha256Hex(canonicalJson({ provider, body }));
    const cachePath = join(this.o.cacheDir, `${key}.json`);
    if (existsSync(cachePath)) {
      const hit = JSON.parse(readFileSync(cachePath, 'utf8'));
      return { ...hit, cost_usd: 0, cached: true };
    }
    const model = body.model as string;
    const p = PRICES[model];
    if (!p) throw new Error(`no price for ${model}`);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const reserveUsd = (estInputTokens * p.input * 1.25 + maxOut * p.output) / 1e6;
      const id = this.o.ledger.reserve(label, model, reserveUsd);
      try {
        const r = await call();
        const cost = priceUsage(model, r.usage);
        this.o.ledger.settle(id, cost, r.usage, r.error);
        if (r.error) throw new Error(r.error);
        const result = { text: r.text ?? '', usage: r.usage, model_returned: r.model_returned ?? model, response_id: r.response_id ?? null };
        writeFileSync(cachePath, JSON.stringify(result));
        return { ...result, cost_usd: cost, cached: false };
      } catch (err: any) {
        lastErr = err;
        const message = String(err?.message ?? err);
        // An incomplete response was already settled from its usage and would repeat on retry.
        if (message.startsWith('openai status')) break;
        // HTTP-level failures return no usage; they settle at zero.
        this.o.ledger.settle(id, 0, null, message.slice(0, 200));
        const status = err?.status as number | undefined;
        if (status !== undefined && status < 500 && status !== 429) break;
        await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    throw lastErr;
  }
}

async function defaultAnthropicCall(body: any): Promise<any> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) throw Object.assign(new Error(`anthropic ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
  return json;
}

/** Run async work over items with a fixed concurrency. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

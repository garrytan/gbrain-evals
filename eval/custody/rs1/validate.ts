/**
 * RS1 validation gates (GST-1154), run in custody on a set that eval/custody/rs1/mint.sh minted. It prints counts and
 * hashes only, and writes a report of conversation ids, item slots, gate names and numbers (never text) for the
 * regeneration step (mint.sh --regenerate) and the custody record.
 *
 *   bun eval/custody/rs1/validate.ts --set <out>/set --beam-dir <out>/tooling/beam --report <out>/validation/report.json
 *       (--fake | --paid --budget-run-id <id> --budget-ledger <RS1 ledger>)
 *       [--cache <dir>, default <set>/../validate-cache] [--public-index <file>]
 *       [--calibration-drop <id>]... [--calibration-accept <id>]...
 *       [--window-tokens 60000] [--overlap-tokens 2000] [--concurrency 8]
 *   bun eval/custody/rs1/validate.ts --calibrate-only --beam-dir <BEAM tree> [--public-index <file>]
 *       [--calibration-drop <id>]... [--calibration-accept <id>]...
 *
 * Conversation gates; a failure drops the conversation and its items are not checked:
 *   - topic: mint.sh dropped it after every topic it drew was too close to a public BEAM topic;
 *   - length: the cl100k token count of its messages is outside the calibrated bounds [low, high];
 *   - contamination: a share of its distinct 13-grams at or above the calibrated τ appears in one public BEAM chat or
 *     questions file at the pinned commit. The public files are the dev conversations' in eval/custody/rs1/beam-paths.txt,
 *     the list mint.sh checks out (F28): no sealed conversation and no 10M chat, and the report records the list's
 *     SHA-256. A Bloom filter over all of them finds the candidate 13-grams; one more pass over the public files counts
 *     them exactly per file. The union share is reported beside it: independent public BEAM conversations already share
 *     1.2-2.1% of their 13-grams with the union of the others, so a union gate would drop every conversation;
 *   - duplicate: the same chat bytes as an earlier kept conversation, or a MinHash estimate of 13-gram Jaccard of at
 *     least 0.1 with one.
 *
 * Item gates, for the two items of each ability (slots "<ability>#0" and "#1" of the latest selection):
 *   - missing: the slot is empty or lacks a question or reference answer;
 *   - duplicate: the same normalized question as an earlier item, or word 3-shingle Jaccard of at least 0.7;
 *   - contamination: a public BEAM question, or half or more of its 13-grams public;
 *   - uncited: none of the turns it cites is in the (truncated) chat;
 *   - support / absence: the two validators, gemini-3.8-flash and claude-haiku-5-5, must each find the reference answer
 *     supported by the cited turns. An abstention item cites nothing, so both scan the whole conversation in
 *     overlapping windows of --window-tokens (60,000 cl100k tokens, about 88,000 Claude tokens, under
 *     claude-haiku-5-5's 100,000-token long-prompt price), and the item fails if any window answers it.
 *
 * Per-ability floor (draft prereg): a conversation keeps both items of every ability. A conversation with a failed item
 * is "regenerate" while it has used fewer than 3 selections (the first and two regenerations), else it is dropped
 * ("floor"). A validator call that errors or answers in the wrong shape leaves its conversation "incomplete": rerun
 * validate, and replies already cached under --cache are not bought again. The verdict is "stop" (exit 4) when more than
 * 20% of the items of finished conversations (kept, or dropped at the floor) fail.
 *
 * Public files: validate reads only the dev conversations' files in eval/custody/rs1/beam-paths.txt (F28, 2026-11-04),
 * so the public index, the calibration's pool and its subjects leave out Q1's sealed splits and the 10M tier (all
 * sealed) even when the tree holds them, and never open their files.
 *
 * Gate calibration (plan "Gate recalibration method", written before any RS1 output was read). The subjects are the
 * dev-split public 1M conversations under <beam-dir>/chats/1M, each counted on its canonical chat file
 * (chat_trunecated.json when present, else chat.json). Length: low = floor(0.95 × the smallest subject's cl100k count), high = ceil(1.05 × the
 * largest). Contamination: s(c) is the largest share of subject c's distinct 13-grams found in one public source file
 * outside c's own directory (its chat, truncated chat and questions files), over the gate's own pool; τ is 1.25 × the
 * largest s(c), rounded up to a whole 0.1 percentage point. So every subject passes both gates. The calibration stops
 * before any gate runs, and no report is written, when:
 *   - a subject shares 20% or more of its 13-grams with one other public file (RS1_CALIBRATION_RELATED_FILES). Files
 *     that contain each other would inflate τ, so a human drops the pair (--calibration-drop) or keeps it and accepts
 *     the larger τ (--calibration-accept); the report records the decision;
 *   - τ is above 5% or is 0, or the bounds reach outside 600,000 to 1,600,000 tokens (RS1_CALIBRATION_OUT_OF_RANGE),
 *     since a gate that loose decides nothing. A --fake run records the reason in the report instead of stopping: its
 *     trees are tiny, and mint.sh never regenerates a real set from a fake report.
 * The subjects' measurements are cached beside --public-index, keyed by the pool's sources_sha256 and the subjects' own
 * paths and sizes, and the report carries the calibration. --calibrate-only prints the calibration as JSON (public BEAM
 * ids, paths, counts and hashes, never text) and touches no minted set.
 *
 * Model calls sit behind one interface (ModelClient), so tests inject fakes. --fake's stand-ins carry their own ids
 * (fake-gemini:…, fake-anthropic:…), so their cached replies never answer a --paid run and a fake report never names the
 * paid validators. Paid calls follow the q1 cells' ledger
 * path: requirePaidArm (--paid and an open run with room for the estimate), then startPaidRun, whose fetch guard prices
 * and reserves every request in the budget ledger before it is sent. The ledger prices gemini-3.8-flash generateContent
 * and claude-haiku-5-5, long-prompt tier included.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { BudgetExceededError, budgetOptionsFrom, chatPrice, startPaidRun } from '../../runner/budget-ledger.ts';
import { acceptsTemperature } from '../../runner/openai-judge-shim.ts';
import { PaidArmRefusal, requirePaidArm } from '../../runner/paid-arm.ts';
import { encodingCount } from '../../runner/systems/render-v2.ts';
import { readBeamPaths } from './beam-paths.ts';


export const ABILITIES = [
  'abstention', 'contradiction_resolution', 'event_ordering', 'information_extraction', 'instruction_following',
  'knowledge_update', 'multi_session_reasoning', 'preference_following', 'summarization', 'temporal_reasoning',
] as const;
export type Ability = typeof ABILITIES[number];
/** The field holding each ability's reference answer in BEAM's probing questions. */
export const ANSWER_FIELD: Record<Ability, string> = {
  abstention: 'ideal_response', contradiction_resolution: 'ideal_answer', event_ordering: 'answer',
  information_extraction: 'answer', instruction_following: 'expected_compliance', knowledge_update: 'answer',
  multi_session_reasoning: 'answer', preference_following: 'expected_compliance', summarization: 'ideal_summary',
  temporal_reasoning: 'answer',
};
export const ITEMS_PER_ABILITY = 2;
export const SELECT_ATTEMPTS = 3;
const TOPIC_ATTEMPTS = 5;
export const VALIDATOR_IDS = ['gemini:gemini-3.8-flash', 'anthropic:claude-haiku-5-5'] as const;
/** Part of every reply-cache key. v2 began when --fake got its own ids, so no reply cached before then is reused. */
const CACHE_VERSION = 'rs1-validate-cache/v2';
export const SLOTS = ABILITIES.flatMap(a => Array.from({ length: ITEMS_PER_ABILITY }, (_, n) => `${a}#${n}`));

export interface Options {
  setDir: string;
  beamDir: string;
  reportPath: string;
  cacheDir?: string;
  publicIndexPath?: string;
  windowTokens: number;
  overlapTokens: number;
  concurrency: number;
}
export const DEFAULTS = { windowTokens: 60_000, overlapTokens: 2_000, concurrency: 8 };
export const THRESHOLDS = { item_contamination_max: 0.5, item_near_duplicate: 0.7, conversation_near_duplicate: 0.1, stop_share: 0.2 };
/**
 * The frozen calibration rule: bounds widened by length_margin_pct percent, τ as tau_factor × the largest subject share
 * rounded up to a multiple of 1/tau_steps (0.1 percentage point), the related-file stop at related_share, and the
 * ceiling stop at tau_max and [low_min, high_max] tokens.
 */
export const CALIBRATION = { length_margin_pct: 5, tau_factor: 1.25, tau_steps: 1000, related_share: 0.2, tau_max: 0.05, low_min: 600_000, high_max: 1_600_000 };
const MAX_OUTPUT_TOKENS = 8192;
/** Per-message framing in a window prompt ("[id N] ROLE: "), in cl100k tokens. */
const MESSAGE_FRAME_TOKENS = 8;

/** The one interface a validator model sits behind. */
export interface ModelClient {
  readonly id: string;
  complete(prompt: string, maxOutputTokens: number): Promise<string>;
}

/** A refusal. A stable code (RS1_CALIBRATION_…) leads the message when the operator has a decision to make. */
export class ValidateError extends Error {
  constructor(message: string, readonly code?: string) { super(code ? `${code}: ${message}` : message); }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

// ─── words and 13-grams ──────────────────────────────────────────────

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export const normalize = (text: string) => words(text).join(' ');

function wordHash(word: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}

/** Every 13-word window of a text as two independent 32-bit hashes. */
export function ngrams(text: string, n = 13): Array<[number, number]> {
  const ws = words(text);
  if (ws.length < n) return [];
  const a = ws.map(w => wordHash(w, 0x811c9dc5)), b = ws.map(w => wordHash(w, 0x9747b28c));
  const out: Array<[number, number]> = [];
  for (let i = 0; i + n <= ws.length; i++) {
    let h1 = 0, h2 = 0;
    for (let j = i; j < i + n; j++) { h1 = (Math.imul(h1, 31) + a[j]) | 0; h2 = (Math.imul(h2, 1_000_003) + b[j]) | 0; }
    out.push([h1 >>> 0, h2 >>> 0]);
  }
  return out;
}

export class Bloom {
  readonly bits: Uint8Array;
  constructor(readonly m: number, readonly k: number, bits?: Uint8Array) { this.bits = bits ?? new Uint8Array(Math.ceil(m / 8)); }
  /** 16 bits per expected element and 11 probes: about 0.05% false positives at that load. */
  static forCount(n: number): Bloom { return new Bloom(Math.max(1 << 16, Math.ceil(n * 16)), 11); }
  add(h1: number, h2: number): void {
    const step = (h2 | 1) >>> 0;
    for (let i = 0; i < this.k; i++) { const p = (h1 + i * step) % this.m; this.bits[p >>> 3] |= 1 << (p & 7); }
  }
  has(h1: number, h2: number): boolean {
    const step = (h2 | 1) >>> 0;
    for (let i = 0; i < this.k; i++) { const p = (h1 + i * step) % this.m; if (!(this.bits[p >>> 3] & (1 << (p & 7)))) return false; }
    return true;
  }
  fill(): number { let set = 0; for (const byte of this.bits) { let b = byte; while (b) { set += b & 1; b >>= 1; } } return set / this.m; }
}

// ─── BEAM's public data ──────────────────────────────────────────────

export interface PublicIndex { bloom: Bloom; questions: Set<string>; paths: string[]; sources: number; ngrams: number; sourcesSha256: string; sourceListSha256: string }

/** Every message text in a chat (any nesting), or every string in a questions file. */
function texts(value: unknown, chat: boolean, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) texts(v, chat, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (chat && typeof o.role === 'string' && typeof o.content === 'string') out.push(o.content);
    else for (const v of Object.values(o)) texts(v, chat, out);
  } else if (!chat && typeof value === 'string') out.push(value);
  return out;
}

function questionTexts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) questionTexts(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { if (k === 'question' && typeof v === 'string') out.push(v); else questionTexts(v, out); }
  }
  return out;
}

/**
 * BEAM's public chats and questions: the chat.json (chat_trunecated.json is a cut of it) and probing_questions.json of
 * each dev conversation, taken from the path list mint.sh checks out (eval/custody/rs1/beam-paths.ts, F28), so no
 * sealed conversation and no 10M chat is read. A listed file missing from --beam-dir refuses.
 */
export function publicSources(beamDir: string): string[] {
  const sources = readBeamPaths().paths.filter(p => p.startsWith('chats/') && (p.endsWith('/chat.json') || p.endsWith('/probing_questions/probing_questions.json'))).map(p => join(beamDir, p));
  if (!sources.some(p => p.endsWith('/chat.json'))) throw new ValidateError('the BEAM path list names no public chat');
  const missing = sources.filter(p => !existsSync(p));
  if (missing.length) throw new ValidateError(`${missing.length} public BEAM files of the path list are missing under ${beamDir}; run mint.sh to check them out`);
  return sources;
}

/** A list of files' identity: each path (relative to the BEAM tree) and size. */
const filesSha256 = (beamDir: string, paths: string[]) => sha256(paths.map(p => `${relative(beamDir, p)} ${statSync(p).size}\n`).join(''));

export function buildPublicIndex(beamDir: string, cachePath?: string): PublicIndex {
  const sources = publicSources(beamDir), sourceListSha256 = readBeamPaths().sha256;
  const sourcesSha256 = filesSha256(beamDir, sources);
  if (cachePath && existsSync(cachePath) && existsSync(`${cachePath}.json`)) {
    const head = JSON.parse(readFileSync(`${cachePath}.json`, 'utf8'));
    if (head.schema === 'rs1-public-13gram/v1' && head.sources_sha256 === sourcesSha256) {
      return { bloom: new Bloom(head.m, head.k, new Uint8Array(readFileSync(cachePath))), questions: new Set(head.questions), paths: sources, sources: sources.length, ngrams: head.ngrams, sourcesSha256, sourceListSha256 };
    }
  }
  // A JSON chat file holds at most one 13-gram per six bytes, so this sizes the filter for its load or better.
  const bloom = Bloom.forCount(Math.ceil(sources.reduce((n, p) => n + statSync(p).size, 0) / 6));
  const questions = new Set<string>();
  let count = 0;
  for (const path of sources) {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const isChat = path.endsWith('/chat.json');
    for (const text of texts(value, isChat)) for (const [h1, h2] of ngrams(text)) { bloom.add(h1, h2); count++; }
    if (!isChat) for (const q of questionTexts(value)) questions.add(normalize(q));
  }
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, bloom.bits);
    writeFileSync(`${cachePath}.json`, JSON.stringify({ schema: 'rs1-public-13gram/v1', sources_sha256: sourcesSha256, m: bloom.m, k: bloom.k, ngrams: count, questions: [...questions].sort() }));
  }
  return { bloom, questions, paths: sources, sources: sources.length, ngrams: count, sourcesSha256, sourceListSha256 };
}

/** A 13-gram's two hashes as one 53-bit number. */
const gramKey = (h1: number, h2: number) => h1 * 2 ** 21 + (h2 >>> 11);

/** The BEAM conversation directory a chat, truncated chat or questions file belongs to. */
const conversationDir = (path: string) => path.replace(/\/(?:chat|chat_trunecated|probing_questions\/probing_questions)\.json$/, '');

/**
 * For each conversation, the largest share of its distinct 13-grams that one public file holds, that count, and that
 * file's index. Only the 13-grams the Bloom filter flagged (hits) can be in a public file, so one pass over the public
 * files counts them exactly per file. A calibration subject names its own directory (own), whose files never count.
 */
export function singleSourceShares(paths: string[], conversations: Array<{ size: number; hits: number[]; own?: string }>): Array<{ share: number; shared: number; source: number }> {
  const owners = new Map<number, number[]>();
  conversations.forEach((c, i) => { for (const k of c.hits) { const o = owners.get(k); if (o) o.push(i); else owners.set(k, [i]); } });
  const best = conversations.map(() => ({ share: 0, shared: 0, source: -1 }));
  if (!owners.size) return best;
  paths.forEach((path, source) => {
    const dir = conversationDir(path);
    const seen = new Set<number>();
    for (const text of texts(readJson(path), path.endsWith('/chat.json'))) {
      for (const [h1, h2] of ngrams(text)) { const k = gramKey(h1, h2); if (owners.has(k)) seen.add(k); }
    }
    const counts = new Map<number, number>();
    for (const k of seen) for (const i of owners.get(k)!) counts.set(i, (counts.get(i) ?? 0) + 1);
    for (const [i, n] of counts) if (conversations[i].own !== dir && n / conversations[i].size > best[i].share) best[i] = { share: n / conversations[i].size, shared: n, source };
  });
  return best;
}

// ─── the minted set ──────────────────────────────────────────────────

export interface Message { id: number; role: string; content: string }
export interface Conversation {
  cid: string;
  complete: boolean;
  /** mint.sh rejected every topic it drew (rs1_mint.py's TOPIC_ATTEMPTS, 5) and dropped the conversation. */
  topicDropped: boolean;
  selectAttempt: number;
  chatSha256: string | null;
  messages: Message[];
  /** The selected item in each slot (BEAM's probing-question fields plus a rubric), or null for an empty slot. */
  items: Record<string, Record<string, unknown> | null>;
}

function messagesOf(value: unknown, out: Message[] = []): Message[] {
  if (Array.isArray(value)) for (const v of value) messagesOf(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.role === 'string' && typeof o.content === 'string') out.push({ id: Number(o.id), role: o.role, content: o.content });
    else for (const v of Object.values(o)) messagesOf(v, out);
  }
  return out;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** A conversation is complete once the rubric step of its latest selection is done (mint.sh's manifest). */
export function loadConversation(setDir: string, cid: string): Conversation {
  const dir = join(setDir, 'conversations', cid);
  const steps = readJson(join(dir, 'manifest.json')).steps as Record<string, { status?: string; verdict?: string }>;
  const selectAttempt = Math.max(0, ...Object.keys(steps).filter(k => k.startsWith('select@')).map(k => Number(k.slice('select@'.length))));
  const checks = Object.entries(steps).filter(([k]) => k.startsWith('topic_check@')).map(([, e]) => e.verdict);
  const topicDropped = checks.length >= TOPIC_ATTEMPTS && !checks.includes('accepted');
  const empty = { cid, topicDropped, selectAttempt, chatSha256: null, messages: [], items: {} };
  if (!selectAttempt || steps[`rubric@${selectAttempt}`]?.status !== 'done') return { ...empty, complete: false };
  const slots = readJson(join(dir, 'selection', `${selectAttempt}.json`)).slots as Record<string, string | null>;
  const items = Object.fromEntries(SLOTS.map(slot => [slot, slots[slot] == null ? null : readJson(join(dir, 'rubric', String(selectAttempt), `${slot}.json`)).item]));
  const chatDir = join(dir, 'beam', '1');
  const raw = readFileSync(join(chatDir, existsSync(join(chatDir, 'chat_trunecated.json')) ? 'chat_trunecated.json' : 'chat.json'));
  return { cid, complete: true, topicDropped, selectAttempt, chatSha256: sha256(raw), messages: messagesOf(JSON.parse(raw.toString('utf8'))), items };
}

// ─── gate calibration ────────────────────────────────────────────────

export interface CalibrationSubject {
  /** The public BEAM id, as eval/decisions/splits names it (1m-<n>). */
  id: string;
  /** Its canonical chat file, relative to the BEAM tree. */
  file: string;
  tokens: number;
  ngrams: number;
  /** s(c), the count of 13-grams behind it, and the public file that holds them (null when no other file holds any). */
  share: number;
  shared: number;
  source: string | null;
}
export interface CalibrationMeasure { sources: number; sources_sha256: string; subjects_sha256: string; subjects: CalibrationSubject[] }
export interface OutOfRange { rule: 'tau_above_max' | 'tau_zero' | 'low_below_min' | 'high_above_max'; value: number; limit: number; subject: string | null }
export interface Calibration extends CalibrationMeasure {
  schema: 'rs1-calibration/v1';
  /** Human decisions after a related-file stop: subjects left out of the bounds and τ, and subjects kept past the stop. */
  dropped: string[];
  accepted: string[];
  low_tokens: number;
  high_tokens: number;
  max_share: number;
  max_share_subject: string;
  tau: number;
  /** What the ceiling stop refuses; a --fake run records it here instead of stopping. */
  out_of_range: OutOfRange[];
}
const MEASURE_SCHEMA = 'rs1-calibration-measure/v1';

const isChat = (path: string) => !path.endsWith('/probing_questions.json');
/** The public id (500k-12) of a file given relative to the BEAM tree (chats/500K/12/chat.json). */
const publicIdOf = (file: string) => { const [, tier, n] = conversationDir(file).split('/'); return `${tier.toLowerCase()}-${n}`; };
/** A 13-gram key's two Bloom hashes (gramKey keeps h1 and the top 21 bits of h2). */
const keyHashes = (k: number): [number, number] => [Math.floor(k / 2 ** 21), (k % 2 ** 21) * 2 ** 11];

function gramKeys(value: unknown, chat: boolean, keep: (key: number) => boolean = () => true, out = new Set<number>()): Set<number> {
  for (const text of texts(value, chat)) for (const [h1, h2] of ngrams(text)) { const k = gramKey(h1, h2); if (keep(k)) out.add(k); }
  return out;
}

/** The pool's 1M conversations (chats/1M/<n>/chat.json among the sources), each with its canonical chat file. */
export function calibrationSubjects(beamDir: string, sources: string[]): Array<{ id: string; dir: string; file: string }> {
  const names = sources.flatMap(p => /^chats\/1M\/(\d+)\/chat\.json$/.exec(relative(beamDir, p))?.slice(1) ?? []).sort((a, b) => Number(a) - Number(b));
  return names.map(n => {
    const dir = join(beamDir, 'chats', '1M', n), truncated = join(dir, 'chat_trunecated.json');
    return { id: `1m-${n}`, dir, file: existsSync(truncated) ? truncated : join(dir, 'chat.json') };
  });
}

/**
 * Each subject's cl100k count and s(c). A 13-gram counts toward s(c) only if it appears in two conversation directories,
 * the subject's own and another, so one pass over every directory (keeping only subject 13-grams) marks those in Bloom
 * filters, and singleSourceShares then counts the marked ones exactly per public file.
 */
function measureSubjects(beamDir: string, sources: string[], subjects: Array<{ id: string; dir: string; file: string }>): CalibrationSubject[] {
  const measured = subjects.map(s => {
    const value = readJson(s.file);
    return { ...s, tokens: messagesOf(value).reduce((n, m) => n + encodingCount('cl100k_base', m.content), 0), keys: Float64Array.from(gramKeys(value, true)) };
  });
  const total = measured.reduce((n, s) => n + s.keys.length, 0);
  const inSubjects = Bloom.forCount(total), once = Bloom.forCount(total), twice = Bloom.forCount(total);
  for (const s of measured) for (const k of s.keys) inSubjects.add(...keyHashes(k));
  const dirs = new Map<string, string[]>();
  for (const path of new Set([...sources, ...subjects.map(s => s.file)])) dirs.set(conversationDir(path), [...(dirs.get(conversationDir(path)) ?? []), path]);
  for (const files of dirs.values()) {
    const keys = new Set<number>();
    for (const path of files) gramKeys(readJson(path), isChat(path), k => inSubjects.has(...keyHashes(k)), keys);
    for (const k of keys) { const [h1, h2] = keyHashes(k); if (once.has(h1, h2)) twice.add(h1, h2); else once.add(h1, h2); }
  }
  const best = singleSourceShares(sources, measured.map(s => ({ size: s.keys.length, hits: Array.from(s.keys).filter(k => twice.has(...keyHashes(k))), own: s.dir })));
  return measured.map((s, i) => ({ id: s.id, file: relative(beamDir, s.file), tokens: s.tokens, ngrams: s.keys.length, share: best[i].share, shared: best[i].shared, source: best[i].source >= 0 ? relative(beamDir, sources[best[i].source]) : null }));
}

/**
 * The bounds and τ from the subjects a human has not dropped, and what the ceiling stop refuses. τ is computed from the
 * integer counts (tau_factor × tau_steps × shared ÷ ngrams, rounded up), so a share already on a 0.1-point step stays.
 */
export function deriveCalibration(measure: CalibrationMeasure, decisions: { drop?: string[]; accept?: string[] } = {}): Calibration {
  const dropped = [...new Set(decisions.drop ?? [])].sort(), accepted = [...new Set(decisions.accept ?? [])].sort();
  const unknown = [...dropped, ...accepted].filter(id => !measure.subjects.some(s => s.id === id));
  if (unknown.length) throw new ValidateError(`--calibration-drop and --calibration-accept name no calibration subject ${unknown.join(', ')}`);
  if (dropped.some(id => accepted.includes(id))) throw new ValidateError('a calibration subject cannot be both dropped and accepted');
  const used = measure.subjects.filter(s => !dropped.includes(s.id));
  if (!used.length) throw new ValidateError('every calibration subject was dropped');
  const smallest = used.reduce((a, b) => (b.tokens < a.tokens ? b : a)), largest = used.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  const top = used.reduce((a, b) => (b.share > a.share ? b : a));
  const low = Math.floor((100 - CALIBRATION.length_margin_pct) * smallest.tokens / 100), high = Math.ceil((100 + CALIBRATION.length_margin_pct) * largest.tokens / 100);
  const tau = top.shared ? Math.ceil(CALIBRATION.tau_factor * CALIBRATION.tau_steps * top.shared / top.ngrams) / CALIBRATION.tau_steps : 0;
  const out_of_range: OutOfRange[] = [
    ...(tau > CALIBRATION.tau_max ? [{ rule: 'tau_above_max' as const, value: tau, limit: CALIBRATION.tau_max, subject: top.id }] : []),
    ...(tau === 0 ? [{ rule: 'tau_zero' as const, value: 0, limit: 0, subject: null }] : []),
    ...(low < CALIBRATION.low_min ? [{ rule: 'low_below_min' as const, value: low, limit: CALIBRATION.low_min, subject: smallest.id }] : []),
    ...(high > CALIBRATION.high_max ? [{ rule: 'high_above_max' as const, value: high, limit: CALIBRATION.high_max, subject: largest.id }] : []),
  ];
  return {
    schema: 'rs1-calibration/v1', sources: measure.sources, sources_sha256: measure.sources_sha256, subjects_sha256: measure.subjects_sha256,
    dropped, accepted, low_tokens: low, high_tokens: high, max_share: top.share, max_share_subject: top.id, tau, out_of_range, subjects: measure.subjects,
  };
}

export interface CalibrateOptions {
  /** The public-index cache path; the subjects' measurements are cached at <cachePath>.calibration.json. */
  cachePath?: string;
  drop?: string[];
  accept?: string[];
  /** false records the ceiling stop in the calibration instead of refusing (--fake). */
  enforceRange?: boolean;
  /** This run's arguments, for the rerun commands a refusal prints. */
  argv?: string[];
}

/**
 * The calibration over the gate's own pool (sources and sourcesSha256 as the public index lists them). Refuses a
 * related-file pair first, since it would inflate τ, then an out-of-range gate; either refusal comes before any gate.
 */
export function calibrate(beamDir: string, sources: string[], sourcesSha256: string, opts: CalibrateOptions = {}): Calibration {
  const subjects = calibrationSubjects(beamDir, sources);
  if (!subjects.length) throw new ValidateError(`no calibration subjects: no dev-split BEAM 1M conversation under ${join(beamDir, 'chats', '1M')}`);
  const subjectsSha256 = filesSha256(beamDir, subjects.map(s => s.file));
  const cacheFile = opts.cachePath ? `${opts.cachePath}.calibration.json` : null;
  const cached = cacheFile && existsSync(cacheFile) ? readJson(cacheFile) : null;
  const hit = cached?.schema === MEASURE_SCHEMA && cached.sources_sha256 === sourcesSha256 && cached.subjects_sha256 === subjectsSha256;
  const measure: CalibrationMeasure = { sources: sources.length, sources_sha256: sourcesSha256, subjects_sha256: subjectsSha256, subjects: hit ? cached.subjects : measureSubjects(beamDir, sources, subjects) };
  if (cacheFile && !hit) { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ schema: MEASURE_SCHEMA, ...measure })); }
  const cal = deriveCalibration(measure, opts);
  const rerun = (flag: string, ids: string[]) => ['bun', 'eval/custody/rs1/validate.ts', ...(opts.argv ?? ['<arguments>']), ...ids.flatMap(id => [flag, id])].join(' ');
  const decided = (id: string) => cal.dropped.includes(id) || cal.accepted.includes(id);
  const related = cal.subjects.filter(s => s.share >= CALIBRATION.related_share && !decided(s.id));
  if (related.length) {
    const pairs = related.map(s => ({ s, other: publicIdOf(s.source!), fileShare: s.shared / gramKeys(readJson(join(beamDir, s.source!)), isChat(s.source!)).size }));
    const drop = [...new Set(pairs.flatMap(p => [p.s.id, ...(cal.subjects.some(s => s.id === p.other) ? [p.other] : [])]))];
    const kept = deriveCalibration(measure, { drop: cal.dropped, accept: [...cal.accepted, ...related.map(s => s.id)] });
    throw new ValidateError([
      `${related.length} calibration subject(s) share ${CALIBRATION.related_share * 100}% or more of their distinct 13-grams with one other public BEAM file, and files that contain each other would inflate tau`,
      ...pairs.map(p => `  pair subject=${p.s.id} file=${p.s.source} file_id=${p.other} subject_share=${p.s.share.toFixed(6)} file_share=${p.fileShare.toFixed(6)}`),
      `  sources_sha256=${cal.sources_sha256}`,
      '  No gate ran and no report was written.',
      `  A human decides: drop the pair from the subjects, or keep it and accept the larger tau (${kept.tau}${kept.tau > CALIBRATION.tau_max ? `, above the ${CALIBRATION.tau_max} ceiling, so the rerun stops with RS1_CALIBRATION_OUT_OF_RANGE` : ''}). Rerun with one of:`,
      `  drop: ${rerun('--calibration-drop', drop)}`,
      `  accept: ${rerun('--calibration-accept', related.map(s => s.id))}`,
    ].join('\n'), 'RS1_CALIBRATION_RELATED_FILES');
  }
  if (cal.out_of_range.length && opts.enforceRange !== false) {
    const outliers = [...new Set(cal.out_of_range.flatMap(o => (o.subject ? [o.subject] : [])))];
    throw new ValidateError([
      `the calibrated gates are too loose to decide anything (tau at most ${CALIBRATION.tau_max}, bounds inside [${CALIBRATION.low_min}, ${CALIBRATION.high_max}] tokens)`,
      ...cal.out_of_range.map(o => `  ${o.rule} value=${o.value} limit=${o.limit} subject=${o.subject ?? 'none'}`),
      `  low_tokens=${cal.low_tokens} high_tokens=${cal.high_tokens} tau=${cal.tau} max_share=${cal.max_share.toFixed(6)} subjects=${cal.subjects.length - cal.dropped.length}`,
      `  sources_sha256=${cal.sources_sha256}`,
      '  No gate ran and no report was written.',
      '  A human decides: check that --beam-dir is the pinned public BEAM tree, then drop the outlying subject or take the rule back to GBEV-3 for a reviewed change.',
      ...(outliers.length ? [`  drop: ${rerun('--calibration-drop', outliers)}`] : []),
    ].join('\n'), 'RS1_CALIBRATION_OUT_OF_RANGE');
  }
  return cal;
}

// ─── windows for the absence scan ────────────────────────────────────

/**
 * Consecutive messages packed into windows of at most windowTokens (a longer single message is a window of its own).
 * Each window after the first starts at least overlapTokens before the previous one ended where it can, so every message,
 * and every pair of neighbouring messages that fits in one window, sits whole inside some window. Returns [start, end)
 * message ranges.
 */
export function chunkMessages(tokens: number[], windowTokens: number, overlapTokens: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  while (start < tokens.length) {
    let end = start, used = 0;
    while (end < tokens.length && (end === start || used + tokens[end] <= windowTokens)) used += tokens[end++];
    out.push([start, end]);
    if (end >= tokens.length) break;
    let next = end, overlap = 0;
    while (next > start + 1 && overlap < overlapTokens) overlap += tokens[--next];
    start = next;
  }
  return out;
}

// ─── prompts ─────────────────────────────────────────────────────────

const renderMessage = (m: Message) => `[id ${m.id}] ${m.role.toUpperCase()}: ${m.content}`;

export function supportPrompt(turns: Message[], question: string, answer: string): string {
  return [
    'You check items for a long-term memory benchmark. Below are turns from a long conversation between a user and an assistant, a question about that conversation, and the reference answer to the question.',
    '',
    'Decide whether these turns fully support the reference answer: every fact, value, date and order in it must be stated in or directly implied by the turns. For a question that tests an instruction or a preference, decide whether the turns state that instruction or preference so that the reference behaviour follows from it.',
    '',
    '<turns>', ...turns.map(renderMessage), '</turns>',
    `<question>${question}</question>`,
    `<answer>${answer}</answer>`,
    '',
    'Reply with only a JSON object: {"supported": true} or {"supported": false}.',
  ].join('\n');
}

export function absencePrompt(part: Message[], questions: string[]): string {
  return [
    'You check unanswerable questions for a long-term memory benchmark. Each question below should have no answer anywhere in a long conversation between a user and an assistant. You see one part of that conversation.',
    '',
    'For each question, decide whether this part contains information that answers it, even partly.',
    '',
    '<conversation_part>', ...part.map(renderMessage), '</conversation_part>',
    '<questions>', ...questions.map((q, i) => `${i + 1}. ${q}`), '</questions>',
    '',
    'Reply with only a JSON object listing the numbers of the questions this part answers: {"answered": [1]} or {"answered": []}.',
  ].join('\n');
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const v = JSON.parse(text.slice(start, end + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

// ─── clients ─────────────────────────────────────────────────────────

export const geminiRequest = (prompt: string, maxOutputTokens: number) => ({
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
  body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens, temperature: 0, responseMimeType: 'application/json' } },
});
/** claude-haiku-5-5 rejects `temperature` (HTTP 400, "temperature is deprecated for this model"), so it samples at the provider default. */
export const anthropicRequest = (prompt: string, maxTokens: number) => ({
  url: 'https://api.anthropic.com/v1/messages',
  body: { model: 'claude-haiku-5-5', max_tokens: maxTokens, ...(acceptsTemperature('claude-haiku-5-5') ? { temperature: 0 } : {}), messages: [{ role: 'user', content: prompt }] },
});

/** A provider error names only the host and status: an error body could echo the prompt. */
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new ValidateError(`${new URL(url).hostname} answered HTTP ${res.status}`);
  return res.json();
}

export function geminiClient(apiKey: string): ModelClient {
  return {
    id: VALIDATOR_IDS[0],
    async complete(prompt, maxOutputTokens) {
      const { url, body } = geminiRequest(prompt, maxOutputTokens);
      const reply = await post(url, { 'x-goog-api-key': apiKey }, body);
      return (reply.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
    },
  };
}

export function anthropicClient(apiKey: string): ModelClient {
  return {
    id: VALIDATOR_IDS[1],
    async complete(prompt, maxTokens) {
      const { url, body } = anthropicRequest(prompt, maxTokens);
      const reply = await post(url, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body);
      return (reply.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    },
  };
}

/**
 * Keyless stand-in validator: an answer is supported when its text appears in the cited turns, and a window answers an
 * abstention question when it holds the question's last "nonce-…" token (else its last word).
 */
export function fakeClient(id: string): ModelClient {
  const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a) + a.length, s.indexOf(b));
  return {
    id,
    async complete(prompt) {
      if (prompt.includes('<conversation_part>')) {
        const part = between(prompt, '<conversation_part>', '</conversation_part>');
        const questions = between(prompt, '<questions>', '</questions>').trim().split('\n').map(l => l.replace(/^\d+\.\s*/, ''));
        const needle = (q: string) => q.match(/nonce-[0-9a-f]+/g)?.pop() ?? q.split(/\s+/).pop()!.replace(/\W+$/, '');
        return JSON.stringify({ answered: questions.flatMap((q, i) => (part.includes(needle(q)) ? [i + 1] : [])) });
      }
      return JSON.stringify({ supported: between(prompt, '<turns>', '</turns>').includes(between(prompt, '<answer>', '</answer>').trim()) });
    },
  };
}

// ─── validation ──────────────────────────────────────────────────────

interface Call { client: number; prompt: string; tokens: number; cacheFile: string | null; cached: boolean; settle: (reply: string | null) => boolean }
export interface ItemResult { pass: boolean; gates: string[] }
export interface ConversationResult {
  status: 'keep' | 'regenerate' | 'drop' | 'incomplete';
  reasons: string[];
  select_attempt: number;
  chat_sha256: string | null;
  tokens: number | null;
  contamination_share: number | null;
  contamination_union_share: number | null;
  contamination_source: string | null;
  near_duplicate_of: string | null;
  windows: number;
  items: Record<string, ItemResult>;
}
export interface Report {
  schema: 'rs1-validation/v1';
  validators: string[];
  params: Record<string, number>;
  public_index: { sources: number; ngrams: number; m: number; k: number; fill: number; est_false_positive: number; sources_sha256: string; source_list_sha256: string };
  calibration: Calibration;
  conversations: Record<string, ConversationResult>;
  totals: Record<string, number>;
  abilities: Record<string, { pass: number; fail: number }>;
  verdict: 'continue' | 'stop';
}
/** The calls to make and their worst-case price, then the verdicts once they settle. */
export interface Plan { calls: Call[]; estimateUsd: number; finish: (run: { errors: number; cached: number }) => Report }

const shingles = (text: string) => { const w = words(text); const s = new Set<string>(); for (let i = 0; i + 3 <= w.length; i++) s.add(w.slice(i, i + 3).join(' ')); return s; };
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const MINHASH_SEEDS = Array.from({ length: 64 }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >>> 0);
function minhash(grams: Iterable<[number, number]>): Uint32Array {
  const sig = new Uint32Array(64).fill(0xffffffff);
  for (const [h1, h2] of grams) {
    for (let s = 0; s < 64; s++) {
      let v = Math.imul(h1 ^ MINHASH_SEEDS[s], 0x85ebca6b) ^ h2;
      v ^= v >>> 13; v = Math.imul(v, 0xc2b2ae35) >>> 0;
      if (v < sig[s]) sig[s] = v;
    }
  }
  return sig;
}
const sigSimilarity = (a: Uint32Array, b: Uint32Array) => { let n = 0; for (let i = 0; i < 64; i++) if (a[i] === b[i]) n++; return n / 64; };

function citedIds(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) for (const v of value) citedIds(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) citedIds(v, out);
  else if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) out.push(Number(value));
  return out;
}

export function planValidation(opts: Options, clients: ModelClient[], index: PublicIndex, calibration: Calibration): Plan {
  if (clients.length !== 2 || clients[0].id.split(':')[0] === clients[1].id.split(':')[0]) throw new ValidateError('validation needs two validators from different families');
  const root = join(opts.setDir, 'conversations');
  const cids = existsSync(root) ? readdirSync(root).filter(n => /^c\d{3,}$/.test(n)).sort() : [];
  const results: Record<string, ConversationResult> = {};
  const calls: Call[] = [];
  const keptChats = new Map<string, string>();
  const signatures: Array<[string, Uint32Array]> = [];
  const seenQuestions: Array<{ norm: string; shingles: Set<string> }> = [];
  const call = (client: number, prompt: string, tokens: number, settle: Call['settle']) => {
    const cacheFile = opts.cacheDir ? join(opts.cacheDir, `${sha256(`${CACHE_VERSION}\0${clients[client].id}\0${prompt}`)}.json`) : null;
    calls.push({ client, prompt, tokens, cacheFile, cached: !!cacheFile && existsSync(cacheFile), settle });
  };

  const measured = cids.flatMap(cid => {
    const conv = loadConversation(opts.setDir, cid);
    const result: ConversationResult = { status: 'incomplete', reasons: [], select_attempt: conv.selectAttempt, chat_sha256: conv.chatSha256, tokens: null, contamination_share: null, contamination_union_share: null, contamination_source: null, near_duplicate_of: null, windows: 0, items: {} };
    results[cid] = result;
    if (!conv.complete) { result.reasons.push(conv.topicDropped ? 'topic' : 'unfinished'); return []; }
    const contentTokens = conv.messages.map(m => encodingCount('cl100k_base', m.content));
    result.tokens = contentTokens.reduce((s, t) => s + t, 0);
    if (result.tokens < calibration.low_tokens || result.tokens > calibration.high_tokens) result.reasons.push('length');
    const grams = new Map<number, [number, number]>();
    for (const m of conv.messages) for (const [h1, h2] of ngrams(m.content)) grams.set(gramKey(h1, h2), [h1, h2]);
    const hits = [...grams].filter(([, [h1, h2]]) => index.bloom.has(h1, h2)).map(([k]) => k);
    result.contamination_union_share = grams.size ? hits.length / grams.size : 0;
    return [{ cid, conv, result, contentTokens, size: grams.size, hits, sig: minhash(grams.values()) }];
  });
  singleSourceShares(index.paths, measured).forEach(({ share, source }, i) => {
    const { result } = measured[i];
    result.contamination_share = share;
    result.contamination_source = source >= 0 ? relative(opts.beamDir, index.paths[source]) : null;
    if (share >= calibration.tau) result.reasons.push('contamination');
  });

  for (const { cid, conv, result, contentTokens, sig } of measured) {
    const earlier = keptChats.get(conv.chatSha256!) ?? signatures.find(([, s]) => sigSimilarity(s, sig) >= THRESHOLDS.conversation_near_duplicate)?.[0];
    if (earlier) { result.near_duplicate_of = earlier; result.reasons.push('duplicate'); }
    if (result.reasons.length) continue;
    keptChats.set(conv.chatSha256!, cid);
    signatures.push([cid, sig]);

    const ids = new Map(conv.messages.map(m => [m.id, m]));
    const abstention: Array<{ slot: string; question: string }> = [];
    for (const slot of SLOTS) {
      const ability = slot.split('#')[0] as Ability;
      const item: ItemResult = { pass: true, gates: [] };
      result.items[slot] = item;
      const raw = conv.items[slot];
      const question = typeof raw?.question === 'string' ? raw.question : '';
      const answer = typeof raw?.[ANSWER_FIELD[ability]] === 'string' ? raw[ANSWER_FIELD[ability]] as string : '';
      const fail = (gate: string) => { item.pass = false; if (!item.gates.includes(gate)) item.gates.push(gate); };
      if (!question.trim() || !answer.trim()) { fail('missing'); continue; }

      const norm = normalize(question), sh = shingles(question);
      if (seenQuestions.some(q => q.norm === norm || jaccard(q.shingles, sh) >= THRESHOLDS.item_near_duplicate)) fail('duplicate');
      seenQuestions.push({ norm, shingles: sh });
      const qGrams = ngrams(question);
      const publicShare = qGrams.length ? qGrams.filter(([h1, h2]) => index.bloom.has(h1, h2)).length / qGrams.length : 0;
      if (index.questions.has(norm) || publicShare >= THRESHOLDS.item_contamination_max) fail('contamination');
      if (!item.pass) continue;

      if (ability === 'abstention') { abstention.push({ slot, question }); continue; }
      const turns = [...new Set(citedIds(raw!.source_chat_ids))].sort((a, b) => a - b).map(id => ids.get(id)).filter((m): m is Message => !!m);
      if (!turns.length) { fail('uncited'); continue; }
      const prompt = supportPrompt(turns, question, answer);
      const tokens = encodingCount('cl100k_base', prompt);
      for (let c = 0; c < 2; c++) {
        call(c, prompt, tokens, reply => {
          const supported = reply === null ? undefined : jsonObject(reply)?.supported;
          if (typeof supported !== 'boolean') { fail(`validator_error:${clients[c].id}`); return false; }
          if (!supported) fail(`support:${clients[c].id}`);
          return true;
        });
      }
    }

    if (!abstention.length) continue;
    const windows = chunkMessages(contentTokens.map(t => t + MESSAGE_FRAME_TOKENS), opts.windowTokens, opts.overlapTokens);
    result.windows = windows.length;
    for (const [start, end] of windows) {
      const prompt = absencePrompt(conv.messages.slice(start, end), abstention.map(a => a.question));
      const tokens = contentTokens.slice(start, end).reduce((s, t) => s + t + MESSAGE_FRAME_TOKENS, 300);
      for (let c = 0; c < 2; c++) {
        call(c, prompt, tokens, reply => {
          const answered = reply === null ? undefined : jsonObject(reply)?.answered;
          const usable = Array.isArray(answered);
          abstention.forEach((a, i) => {
            const gate = !usable ? `validator_error:${clients[c].id}` : answered.includes(i + 1) ? `absence:${clients[c].id}` : null;
            const item = result.items[a.slot];
            if (gate) { item.pass = false; if (!item.gates.includes(gate)) item.gates.push(gate); }
          });
          return usable;
        });
      }
    }
  }

  // Worst case: Claude counts about 1.47 tokens per cl100k token (the Claude 5 calibration in
  // eval/runner/systems/render-v2.ts), every reply uses its whole output allowance, and long-prompt rates apply above
  // their threshold.
  const estimateUsd = calls.filter(c => !c.cached).reduce((s, c) => {
    const id = clients[c.client].id.replace(/^fake-/, '');
    const p = chatPrice(id) ?? (() => { throw new ValidateError(`no price for ${id}`); })();
    const input = (id.startsWith('anthropic:') ? 1.47 : 1) * c.tokens;
    const rates = p.long && input > p.long.above_input_tokens ? p.long : p;
    return s + (input * rates.input + MAX_OUTPUT_TOKENS * rates.output) / 1e6;
  }, 0);

  const finish = (run: { errors: number; cached: number }): Report => {
    const totals: Record<string, number> = { conversations: cids.length, keep: 0, regenerate: 0, drop: 0, incomplete: 0, items: 0, pass: 0, fail: 0, finished_items: 0, finished_fail: 0, calls: calls.length, cached_calls: run.cached, validator_errors: run.errors, windows: 0 };
    const abilities = Object.fromEntries(ABILITIES.map(a => [a, { pass: 0, fail: 0 }]));
    for (const result of Object.values(results)) {
      totals.windows += result.windows;
      const items = Object.values(result.items);
      const failed = items.filter(i => !i.pass).length;
      if (!result.reasons.length && items.some(i => i.gates.some(g => g.startsWith('validator_error:')))) result.reasons.push('validator_error');
      if (result.reasons.includes('unfinished') || result.reasons.includes('validator_error')) result.status = 'incomplete';
      else if (result.reasons.length) result.status = 'drop';
      else if (!failed) result.status = 'keep';
      else if (result.select_attempt < SELECT_ATTEMPTS) result.status = 'regenerate';
      else { result.status = 'drop'; result.reasons.push('floor'); }
      totals[result.status]++;
      for (const [slot, item] of Object.entries(result.items)) {
        totals.items++;
        totals[item.pass ? 'pass' : 'fail']++;
        abilities[slot.split('#')[0]][item.pass ? 'pass' : 'fail']++;
        for (const gate of item.gates) { const g = `gate_${gate.split(':')[0]}`; totals[g] = (totals[g] ?? 0) + 1; }
      }
      if (result.status === 'keep' || result.reasons.includes('floor')) { totals.finished_items += items.length; totals.finished_fail += failed; }
    }
    for (const r of ['topic', 'length', 'contamination', 'duplicate', 'floor']) totals[`drop_${r}`] = Object.values(results).filter(c => c.reasons.includes(r)).length;
    const fill = index.bloom.fill();
    return {
      schema: 'rs1-validation/v1',
      validators: clients.map(c => c.id),
      params: { window_tokens: opts.windowTokens, overlap_tokens: opts.overlapTokens, select_attempts: SELECT_ATTEMPTS, ...THRESHOLDS },
      public_index: { sources: index.sources, ngrams: index.ngrams, m: index.bloom.m, k: index.bloom.k, fill: Number(fill.toFixed(6)), est_false_positive: Number((fill ** index.bloom.k).toExponential(3)), sources_sha256: index.sourcesSha256, source_list_sha256: index.sourceListSha256 },
      calibration,
      conversations: results,
      totals,
      abilities,
      verdict: totals.finished_items && totals.finished_fail / totals.finished_items > THRESHOLDS.stop_share ? 'stop' : 'continue',
    };
  };
  return { calls, estimateUsd, finish };
}

/** Runs the calls, cached replies first. A refused reservation stops every worker and propagates. */
export async function runCalls(calls: Call[], clients: ModelClient[], concurrency: number): Promise<{ errors: number; cached: number }> {
  let next = 0, errors = 0, cached = 0, stopped = false;
  for (const c of calls) if (c.cached) { cached++; c.settle(readJson(c.cacheFile!).reply); }
  const pending = calls.filter(c => !c.cached);
  const worker = async () => {
    while (!stopped && next < pending.length) {
      const c = pending[next++];
      let reply: string;
      try { reply = await clients[c.client].complete(c.prompt, MAX_OUTPUT_TOKENS); } catch (error) {
        if (error instanceof BudgetExceededError) { stopped = true; throw error; }
        errors++;
        c.settle(null);
        continue;
      }
      if (c.settle(reply) && c.cacheFile) { mkdirSync(dirname(c.cacheFile), { recursive: true }); writeFileSync(c.cacheFile, JSON.stringify({ reply })); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.floor(concurrency)) }, worker));
  return { errors, cached };
}

export async function validateSet(
  opts: Options, clients: ModelClient[], index = buildPublicIndex(opts.beamDir, opts.publicIndexPath),
  calibration = calibrate(opts.beamDir, index.paths, index.sourcesSha256, { cachePath: opts.publicIndexPath }),
): Promise<Report> {
  const plan = planValidation(opts, clients, index, calibration);
  return plan.finish(await runCalls(plan.calls, clients, opts.concurrency));
}

export function writeReport(path: string, report: Report): string {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(path, text);
  return sha256(text);
}

export function summaryLines(report: Report, reportSha256: string): string[] {
  const t = report.totals, c = report.calibration;
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
  const tokens = Object.values(report.conversations).map(c => c.tokens).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const gates = Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('gate_')).sort());
  const shares = Object.values(report.conversations).map(c => c.contamination_share ?? 0);
  const unionShares = Object.values(report.conversations).map(c => c.contamination_union_share ?? 0);
  return [
    `rs1-validate ${kv({ conversations: t.conversations, keep: t.keep, regenerate: t.regenerate, drop: t.drop, incomplete: t.incomplete, drop_topic: t.drop_topic, drop_length: t.drop_length, drop_contamination: t.drop_contamination, drop_duplicate: t.drop_duplicate, drop_floor: t.drop_floor })}`,
    `rs1-validate ${kv({ items: t.items, pass: t.pass, fail: t.fail, ...gates })}`,
    ...ABILITIES.map(a => `rs1-validate ${kv({ ability: a, pass: report.abilities[a].pass, fail: report.abilities[a].fail })}`),
    `rs1-validate ${kv({ tokens_min: tokens[0] ?? 0, tokens_median: tokens[Math.floor(tokens.length / 2)] ?? 0, tokens_max: tokens.at(-1) ?? 0, contamination_max_share: Math.max(0, ...shares).toFixed(6), contamination_union_max_share: Math.max(0, ...unionShares).toFixed(6) })}`,
    `rs1-validate ${kv({ calls: t.calls, cached_calls: t.cached_calls, validator_errors: t.validator_errors, windows: t.windows })}`,
    `rs1-validate ${kv({ public_sources: report.public_index.sources, public_ngrams: report.public_index.ngrams, bloom_fill: report.public_index.fill, bloom_est_false_positive: report.public_index.est_false_positive })}`,
    `rs1-validate ${kv({ calibration_subjects: c.subjects.length - c.dropped.length, calibration_dropped: c.dropped.length, calibration_accepted: c.accepted.length, length_low: c.low_tokens, length_high: c.high_tokens, tau: c.tau, max_subject_share: c.max_share.toFixed(6), calibration_out_of_range: c.out_of_range.length, sources_sha256: c.sources_sha256 })}`,
    `rs1-validate ${kv({ finished_fail: t.finished_fail, finished_items: t.finished_items, verdict: report.verdict, report_sha256: reportSha256 })}`,
  ];
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (name: string, fallback: number) => {
    const v = flag(name), n = v === undefined ? fallback : Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new ValidateError(`${name} must be a positive number`);
    return n;
  };
  const flags = (name: string) => argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : []));
  for (const gone of ['--target-tokens', '--tolerance']) if (argv.includes(gone)) throw new ValidateError(`${gone} is gone: the length and contamination gates are calibrated from BEAM's dev-split public 1M conversations (--calibrate-only prints them)`);
  const decisions = { drop: flags('--calibration-drop'), accept: flags('--calibration-accept'), argv };
  const setDir = flag('--set'), beamDir = flag('--beam-dir'), reportPath = flag('--report');
  if (argv.includes('--calibrate-only')) {
    if (!beamDir) throw new ValidateError('--calibrate-only needs --beam-dir');
    const beam = resolve(beamDir), sources = publicSources(beam), sourcesSha256 = filesSha256(beam, sources);
    console.log(JSON.stringify(calibrate(beam, sources, sourcesSha256, { cachePath: flag('--public-index'), ...decisions }), null, 2));
    return 0;
  }
  if (!setDir || !beamDir || !reportPath) throw new ValidateError('--set, --beam-dir and --report are required');
  const fake = argv.includes('--fake');
  if (fake === argv.includes('--paid')) throw new ValidateError('pass exactly one of --fake and --paid');
  const opts: Options = {
    setDir: resolve(setDir), beamDir: resolve(beamDir), reportPath: resolve(reportPath),
    cacheDir: resolve(flag('--cache') ?? join(dirname(resolve(setDir)), 'validate-cache')), publicIndexPath: flag('--public-index'),
    windowTokens: num('--window-tokens', DEFAULTS.windowTokens), overlapTokens: num('--overlap-tokens', DEFAULTS.overlapTokens),
    concurrency: num('--concurrency', DEFAULTS.concurrency),
  };
  if (!existsSync(join(opts.setDir, 'conversations'))) throw new ValidateError(`${opts.setDir} holds no conversations/`);
  const geminiKey = process.env.GEMINI_API_KEY, anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!fake && (!geminiKey || !anthropicKey)) throw new ValidateError('paid validation needs GEMINI_API_KEY and ANTHROPIC_API_KEY');
  const clients = fake ? VALIDATOR_IDS.map(id => fakeClient(`fake-${id}`)) : [geminiClient(geminiKey!), anthropicClient(anthropicKey!)];
  const index = buildPublicIndex(opts.beamDir, opts.publicIndexPath);
  const calibration = calibrate(opts.beamDir, index.paths, index.sourcesSha256, { cachePath: opts.publicIndexPath, ...decisions, enforceRange: !fake });
  const plan = planValidation(opts, clients, index, calibration);
  const paid = !fake && plan.calls.some(c => !c.cached);
  if (paid) requirePaidArm(argv, { arm: 'rs1 validate', estimateUsd: plan.estimateUsd });
  const started = paid ? startPaidRun('rs1-validate', { ...budgetOptionsFrom(argv), estimateUsd: plan.estimateUsd }) : null;
  try {
    const report = plan.finish(await runCalls(plan.calls, clients, opts.concurrency));
    for (const line of summaryLines(report, writeReport(opts.reportPath, report))) console.log(line);
    return report.verdict === 'stop' ? 4 : 0;
  } finally {
    if (started) { started.guard.uninstall(); started.run.close(); }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: Error) => {
    const known = error instanceof ValidateError || error instanceof PaidArmRefusal || error instanceof BudgetExceededError;
    process.stderr.write(known ? `rs1-validate refused: ${error.message}\n` : `rs1-validate error class=${error.name} sha256=${sha256(String(error.message)).slice(0, 16)}\n`);
    process.exit(2);
  });
}

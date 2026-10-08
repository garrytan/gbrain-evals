/**
 * Conversation-memory benchmarks in one shape.
 *
 * Every benchmark loads into conversations (each a list of dated sessions)
 * and questions (each pointing at one conversation, with the gold session
 * ids that hold its evidence). The system under test only ever sees
 * rendered pages: an opaque slug per session occurrence and the session's
 * dated turns. Gold ids, question categories and answers stay on the
 * evaluator side.
 *
 * Identity rule: a session's occurrence id (conversation + session) lives in
 * the page slug only, never in the page text, so identical sessions that
 * recur across LongMemEval haystacks share embedding-cache entries while
 * remaining distinct occurrences for scoring.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { decideError } from '../decisions/errors.ts';
import { loadBeam10mCorpus } from './beam10m-corpus.ts';
import { loadBeam10mQuestions } from './beam10m-questions.ts';

export interface Turn { speaker: string; content: string; message_ids?: number[] }
/** `original_id`: the dataset's own session id when `id` is an occurrence id (LongMemEval-M repeats a session id across a haystack). */
export interface Session { id: string; date?: string; turns: Turn[]; original_id?: string }
export interface Conversation { id: string; sessions: Session[] }
export interface MemoryQuestion {
  id: string;
  conversation: string;
  question: string;
  question_date?: string;
  category: string;
  /** Session ids (within the conversation) that hold the evidence. Empty for abstention items. */
  gold: string[];
  abstention: boolean;
  /** Evaluator-side only: the reference answer, never shown to the system under test. */
  answer?: string;
  /** Evaluator-side only: rubric items (BEAM) the judge checks one by one. */
  rubric?: string[];
  /** Evaluator-side only: the misleading answer an adversarial question invites (LoCoMo category 5). */
  trap?: string;
}
export interface Corpus { benchmark: string; conversations: Conversation[]; questions: MemoryQuestion[]; source: DatasetIdentity }
export interface DatasetIdentity { name: string; files: Array<{ path: string; sha256: string }>; revision: string; license: string }

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const DATASET_ROOT = process.env.GBRAIN_EVALS_DATASETS ?? join(homedir(), 'datasets', 'gbrain-evals');

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Opaque per-occurrence page id; reveals nothing about gold or position. */
export function occurrenceId(conversation: string, session: string): string {
  return sha256(`gbrain-evals-memory-qa\u0000${conversation}\u0000${session}`).slice(0, 16);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * A benchmark session timestamp as ISO 8601 (minute precision, no zone), or
 * null when the form is unknown. LoCoMo writes "1:56 pm on 8 May, 2023";
 * LongMemEval writes "2023/05/20 (Sat) 02:21".
 */
export function isoSessionDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lme = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:\s*\(\w+\))?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (lme) return `${lme[1]}-${lme[2]}-${lme[3]}T${pad(Number(lme[4] ?? 0))}:${lme[5] ?? '00'}:00`;
  const loc = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (loc) {
    const month = MONTHS.indexOf(loc[5].toLowerCase());
    if (month < 0) return null;
    const hour = (Number(loc[1]) % 12) + (loc[3].toLowerCase() === 'pm' ? 12 : 0);
    return `${loc[6]}-${pad(month + 1)}-${pad(Number(loc[4]))}T${pad(hour)}:${loc[2]}:00`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw : null;
}

/**
 * `conversation` renders the page the way gbrain's conversation-facts
 * extractor expects: conversation type and an ISO date its observation-date
 * resolver can read. The default keeps the retrieval lane's original pages.
 */
export function renderSessionPage(session: Session, opts: { as?: 'note' | 'conversation' } = {}): string {
  const asConversation = opts.as === 'conversation';
  const fm = ['---', `type: ${asConversation ? 'conversation' : 'note'}`];
  const date = asConversation ? isoSessionDate(session.date) ?? session.date : session.date;
  if (date) fm.push(`date: ${JSON.stringify(date)}`);
  fm.push(`title: ${JSON.stringify(session.date ? `Conversation on ${session.date}` : 'Conversation')}`, '---', '');
  const body = session.turns.map(t => `**${t.speaker}:** ${t.content}\n`);
  return fm.join('\n') + body.join('\n');
}

// ─── Dataset registry ───────────────────────────────────────────────

export interface DatasetFile { path: string; url: string; sha256: string }

export const LOCOMO_FILE: DatasetFile = {
  path: 'locomo/locomo10.json',
  url: 'https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json',
  sha256: '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4',
};
export const LME_S_FILE: DatasetFile = {
  path: 'longmemeval/longmemeval_s_cleaned.json',
  url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json',
  sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442',
};

export const LME_M_FILE: DatasetFile = {
  path: 'longmemeval/longmemeval_m_cleaned.json',
  url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_m_cleaned.json',
  sha256: '9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f',
};

interface BeamManifest {
  commit: string; raw_base: string; license: string;
  sizes: Record<string, Array<{ conversation: string; chat_path: string; chat_sha256: string; questions_path: string; questions_sha256: string }>>;
}
export function beamManifest(): BeamManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'eval/decisions/datasets/beam-b2da22e.json'), 'utf8'));
}

/** A BEAM size's chat and question files; `only` keeps those conversations' files (a dev split). */
export function beamFiles(size: string, only?: ReadonlySet<string>): DatasetFile[] {
  const m = beamManifest();
  const convs = m.sizes[size];
  if (!convs) throw new Error(`BEAM size ${size} is not in the manifest`);
  const unknown = only ? [...only].filter(id => !convs.some(c => c.conversation === id)) : [];
  if (unknown.length) throw new Error(`BEAM ${size} has no conversation ${unknown.join(', ')}`);
  return convs.filter(c => !only || only.has(c.conversation)).flatMap(c => [
    { path: `beam/${c.chat_path}`, url: m.raw_base + c.chat_path, sha256: c.chat_sha256 },
    { path: `beam/${c.questions_path}`, url: m.raw_base + c.questions_path, sha256: c.questions_sha256 },
  ]);
}

/** A benchmark's pinned files; `only` narrows BEAM to those conversations (single-file benchmarks ignore it). */
export function filesFor(benchmark: string, only?: ReadonlySet<string>): DatasetFile[] {
  switch (benchmark) {
    case 'locomo': return [LOCOMO_FILE];
    case 'lme-s': return [LME_S_FILE];
    case 'beam-100k': return beamFiles('100k', only);
    case 'beam-500k': return beamFiles('500k', only);
    case 'beam-1m': return beamFiles('1m', only);
    case 'lme-m': return [LME_M_FILE];
    case 'beam-10m': throw decideError({ code: 'CUSTODY_MISSING', message: 'BEAM-10M is sealed: it is fetched and extracted only by the custodian',
      why: 'every BEAM-10M conversation is in the sealed split; its files live in owner custody, never on a development machine',
      fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch', '--write'], user_message: 'the custodian fetches BEAM-10M at the pinned revision and fills the manifest' } });
    case 'fixture': return [];
    default: throw new Error(`unknown benchmark ${benchmark}`);
  }
}

const fetchArgv = (benchmark: string) => ['bun', 'run', 'eval:decide', 'fetch', '--benchmark', benchmark];

/** Read a dataset file, refusing a missing file or a hash mismatch with the fix. */
export function readDatasetFile(f: DatasetFile, benchmark: string): string {
  const path = join(DATASET_ROOT, f.path);
  if (!existsSync(path)) {
    throw decideError({ code: 'DATASET_MISSING', message: `${benchmark}: ${path} is not downloaded`,
      why: 'datasets are fetched by pinned revision and SHA-256, never committed', fix: { next: 'run', argv: fetchArgv(benchmark), verify: [...fetchArgv(benchmark), '--verify-only'] } });
  }
  const bytes = readFileSync(path);
  const got = sha256(bytes);
  if (got !== f.sha256) {
    throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `${benchmark}: ${path} has SHA-256 ${got.slice(0, 12)}, expected ${f.sha256.slice(0, 12)}`,
      why: 'a different dataset revision would change every number; the kit only scores the pinned bytes',
      fix: { next: 'run', argv: [...fetchArgv(benchmark), '--force'], verify: [...fetchArgv(benchmark), '--verify-only'] } });
  }
  return bytes.toString('utf8');
}

export async function fetchDataset(benchmark: string, opts: { force?: boolean; verifyOnly?: boolean; log?: (s: string) => void; only?: ReadonlySet<string> } = {}): Promise<{ fetched: number; verified: number }> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + '\n'));
  let fetched = 0; let verified = 0;
  const { mkdirSync, renameSync, rmSync, createWriteStream } = await import('node:fs');
  const { dirname } = await import('node:path');
  for (const f of filesFor(benchmark, opts.only)) {
    const path = join(DATASET_ROOT, f.path);
    const ok = existsSync(path) && fileSha256(path) === f.sha256;
    if (ok && !opts.force) { verified++; continue; }
    if (opts.verifyOnly) throw decideError({ code: existsSync(path) ? 'DATASET_HASH_MISMATCH' : 'DATASET_MISSING', message: `${benchmark}: ${f.path} is ${existsSync(path) ? 'not the pinned bytes' : 'missing'}`,
      why: 'verification found a file that the run would refuse', fix: { next: 'run', argv: [...fetchArgv(benchmark), '--force'] } });
    log(`[fetch] ${f.url}`);
    const res = await fetch(f.url);
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${f.url}`);
    mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    const hash = createHash('sha256');
    const out = createWriteStream(partial);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => e ? j(e) : r()));
    const got = hash.digest('hex');
    if (got !== f.sha256) {
      rmSync(partial, { force: true });
      throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `${f.url} returned SHA-256 ${got.slice(0, 12)}, expected ${f.sha256.slice(0, 12)}`,
        why: 'the upstream bytes changed or the download was corrupted; the kit will not score unpinned data', fix: { next: 'report', user_message: 'upstream dataset bytes changed; a new pin needs review' } });
    }
    renameSync(partial, path);
    fetched++; verified++;
  }
  return { fetched, verified };
}

/** SHA-256 of a file read in chunks, so multi-gigabyte files never sit in memory. */
export function fileSha256(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(16 << 20);
  try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return hash.digest('hex');
}

// ─── Loaders ────────────────────────────────────────────────────────

const LOCOMO_CATEGORY: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

/** `only` keeps those conversation ids (a split): the others are dropped right after the file parses and never enter the corpus. */
export function loadLocomo(only?: ReadonlySet<string>): Corpus {
  const raw = JSON.parse(readDatasetFile(LOCOMO_FILE, 'locomo')) as Array<{ sample_id: string; conversation: Record<string, unknown>; qa: Array<{ question: string; category: number; evidence?: string[]; answer?: unknown; adversarial_answer?: unknown }> }>;
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const sample of raw.filter(x => !only || only.has(x.sample_id))) {
    const conv = sample.conversation;
    const sessions: Session[] = [];
    for (let n = 1; conv[`session_${n}`] !== undefined || conv[`session_${n + 1}`] !== undefined; n++) {
      const turns = conv[`session_${n}`] as Array<{ speaker: string; text: string }> | undefined;
      if (!Array.isArray(turns)) continue;
      sessions.push({ id: `session_${n}`, date: conv[`session_${n}_date_time`] as string | undefined, turns: turns.map(t => ({ speaker: t.speaker, content: t.text })) });
    }
    conversations.push({ id: sample.sample_id, sessions });
    const known = new Set(sessions.map(s => s.id));
    sample.qa.forEach((q, i) => {
      const gold = new Set<string>();
      for (const ev of q.evidence ?? []) for (const part of String(ev).split(/[;,\s]+/)) {
        const m = /^D(\d+):\d+$/.exec(part.trim());
        if (m && known.has(`session_${m[1]}`)) gold.add(`session_${m[1]}`);
      }
      questions.push({ id: `${sample.sample_id}:q${String(i).padStart(3, '0')}`, conversation: sample.sample_id, question: q.question,
        category: LOCOMO_CATEGORY[q.category] ?? `cat${q.category}`, gold: q.category === 5 ? [] : [...gold], abstention: q.category === 5,
        ...(q.category === 5 ? { answer: 'The conversation never states this.', trap: q.adversarial_answer === undefined ? undefined : String(q.adversarial_answer) } : { answer: String(q.answer ?? '') }) });
    });
  }
  return { benchmark: 'locomo', conversations, questions, source: { name: 'LoCoMo (locomo10.json)', files: [{ path: LOCOMO_FILE.path, sha256: LOCOMO_FILE.sha256 }], revision: '3eb6f2c', license: 'CC BY-NC 4.0' } };
}

export function loadLmeS(): Corpus {
  const raw = JSON.parse(readDatasetFile(LME_S_FILE, 'lme-s')) as Array<{
    question_id: string; question_type: string; question: string; question_date?: string; answer?: unknown;
    answer_session_ids: string[]; haystack_session_ids: string[]; haystack_dates?: string[];
    haystack_sessions: Array<Array<{ role: string; content: string }>>;
  }>;
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const q of raw) {
    const sessions: Session[] = q.haystack_sessions.map((turns, i) => ({
      id: q.haystack_session_ids[i], date: q.haystack_dates?.[i], turns: turns.map(t => ({ speaker: t.role, content: t.content })),
    }));
    conversations.push({ id: q.question_id, sessions });
    const abstention = q.question_id.endsWith('_abs');
    questions.push({ id: q.question_id, conversation: q.question_id, question: q.question, question_date: q.question_date,
      category: q.question_type, gold: abstention ? [] : [...q.answer_session_ids], abstention, answer: String(q.answer ?? '') });
  }
  return { benchmark: 'lme-s', conversations, questions, source: { name: 'LongMemEval-S cleaned', files: [{ path: LME_S_FILE.path, sha256: LME_S_FILE.sha256 }], revision: '98d7416c', license: 'MIT' } };
}

const MARKER = /\s*->->\s*\d+(?:,\d+)*\s*$/;

function messageIds(src: unknown): number[] {
  if (Array.isArray(src)) return src.flatMap(messageIds);
  if (typeof src === 'number') return [src];
  if (src && typeof src === 'object') return Object.values(src).flatMap(messageIds);
  return [];
}

/**
 * The date of each turn group in a BEAM batch. BEAM dates a batch once, on the first message of its first turn group, so
 * a group without its own anchor takes the batch's.
 */
export function beamGroupDates(batch: { time_anchor?: string | null; turns: Array<Array<{ time_anchor?: string }>> }): Array<string | undefined> {
  const batchDate = batch.time_anchor ?? batch.turns.flat().find(msg => msg.time_anchor)?.time_anchor ?? undefined;
  return batch.turns.map(group => group.find(msg => msg.time_anchor)?.time_anchor ?? batchDate);
}

/** `only` restricts loading to those conversation ids (a split), so other conversations' files are never read. */
export function loadBeam(size: '100k' | '500k' | '1m', only?: ReadonlySet<string>): Corpus {
  const m = beamManifest();
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const c of m.sizes[size].filter(x => !only || only.has(x.conversation))) {
    const chat = JSON.parse(readDatasetFile({ path: `beam/${c.chat_path}`, url: m.raw_base + c.chat_path, sha256: c.chat_sha256 }, `beam-${size}`)) as
      Array<{ batch_number: number; time_anchor?: string | null; turns: Array<Array<{ role: string; id: number; content: string; time_anchor?: string }>> }>;
    const sessions: Session[] = [];
    const sessionOfMessage = new Map<number, string>();
    for (const batch of chat) {
      const dates = beamGroupDates(batch);
      batch.turns.forEach((group, gi) => {
        const id = `b${batch.batch_number}-g${gi}`;
        const date = dates[gi];
        for (const msg of group) sessionOfMessage.set(msg.id, id);
        sessions.push({ id, date: date ?? undefined, turns: group.map(msg => ({ speaker: msg.role, content: msg.content.replace(MARKER, ''), message_ids: [msg.id] })) });
      });
    }
    conversations.push({ id: c.conversation, sessions });
    const pq = JSON.parse(readDatasetFile({ path: `beam/${c.questions_path}`, url: m.raw_base + c.questions_path, sha256: c.questions_sha256 }, `beam-${size}`)) as
      Record<string, Array<{ question: string; source_chat_ids?: unknown; answer?: unknown; ideal_response?: unknown; ideal_answer?: unknown; ideal_summary?: unknown; expected_compliance?: unknown; rubric?: unknown }>>;
    for (const [ability, items] of Object.entries(pq)) {
      items.forEach((item, i) => {
        const gold = [...new Set(messageIds(item.source_chat_ids).map(id => sessionOfMessage.get(id)).filter((s): s is string => !!s))];
        const abstention = ability === 'abstention';
        const reference = item.answer ?? item.ideal_response ?? item.ideal_answer ?? item.ideal_summary ?? item.expected_compliance;
        questions.push({ id: `${c.conversation}:${ability}:${i}`, conversation: c.conversation, question: item.question, category: ability, gold: abstention ? [] : gold, abstention,
          answer: reference === undefined ? undefined : String(reference), rubric: Array.isArray(item.rubric) ? item.rubric.map(String) : undefined });
      });
    }
  }
  return { benchmark: `beam-${size}`, conversations, questions, source: { name: `BEAM ${size}`, files: [{ path: 'eval/decisions/datasets/beam-b2da22e.json', sha256: sha256(readFileSync(join(REPO_ROOT, 'eval/decisions/datasets/beam-b2da22e.json'))) }], revision: m.commit.slice(0, 7), license: m.license } };
}

// ─── LongMemEval-M ──────────────────────────────────────────────────

/**
 * Scan a file holding one top-level JSON array without loading it whole:
 * each element's byte range is found by tracking strings and nesting over
 * raw bytes (every structural character is ASCII, so multi-byte UTF-8 never
 * confuses it), then parsed on its own. The file's SHA-256 is computed on
 * the same pass.
 */
export function scanJsonArray(path: string, visit: (value: unknown, start: number, end: number) => void, chunkBytes = 16 << 20): { sha256: string; bytes: number; elements: number } {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(chunkBytes);
  let pos = 0, depth = 0, inString = false, escape = false, start = -1, elements = 0;
  let pieces: Buffer[] = [];
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const chunk = buf.subarray(0, n);
      hash.update(chunk);
      let pieceFrom = start >= 0 ? 0 : -1;
      for (let i = 0; i < n; i++) {
        const b = chunk[i];
        if (inString) {
          if (escape) escape = false;
          else if (b === 0x5c) escape = true;
          else if (b === 0x22) inString = false;
          continue;
        }
        if (b === 0x22) { inString = true; continue; }
        if (b === 0x7b || b === 0x5b) {
          if (depth === 1 && start < 0) { start = pos + i; pieceFrom = i; pieces = []; }
          depth++;
        } else if (b === 0x7d || b === 0x5d) {
          depth--;
          if (depth === 1 && start >= 0) {
            pieces.push(Buffer.from(chunk.subarray(pieceFrom, i + 1)));
            visit(JSON.parse(Buffer.concat(pieces).toString('utf8')), start, pos + i + 1);
            elements++; start = -1; pieceFrom = -1; pieces = [];
          }
        }
      }
      if (start >= 0) pieces.push(Buffer.from(chunk.subarray(pieceFrom, n)));
      pos += n;
    }
  } finally { closeSync(fd); }
  if (depth !== 0 || inString) throw new Error(`${path}: the JSON array is truncated`);
  return { sha256: hash.digest('hex'), bytes: pos, elements };
}

export const LME_M_SELECTION_SEED = 'q1-lme-m-v1';
export const LME_TYPES = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'temporal-reasoning', 'knowledge-update', 'multi-session'] as const;
/** The six question types plus abstention (`_abs` ids, whatever their type), mutually exclusive. */
export const lmeBucket = (q: { question_id: string; question_type: string }) => q.question_id.endsWith('_abs') ? 'abstention' : q.question_type;

/**
 * The stratified LongMemEval-M slice: bucket quotas proportional to bucket
 * size (largest remainder; ties to the larger bucket, then the name), and
 * inside each bucket the ids ordered by SHA-256 of UTF-8 `seed`, NUL,
 * `question_id` ascending (id breaks ties), the P0 and pilot ordering. No
 * score or answer enters the selection.
 */
export function lmeMSelection(meta: ReadonlyArray<{ question_id: string; question_type: string }>, size = 100, seed = LME_M_SELECTION_SEED): { quotas: Record<string, number>; selected: string[] } {
  const buckets = new Map<string, string[]>();
  for (const q of meta) buckets.set(lmeBucket(q), [...(buckets.get(lmeBucket(q)) ?? []), q.question_id]);
  const unknown = [...buckets.keys()].filter(b => b !== 'abstention' && !(LME_TYPES as readonly string[]).includes(b));
  if (unknown.length) throw new Error(`unknown LongMemEval question types: ${unknown.join(', ')}`);
  const total = meta.length;
  const n = Math.min(size, total);
  const exact = [...buckets].map(([b, ids]) => ({ b, size: ids.length, floor: Math.floor((n * ids.length) / total), rem: (n * ids.length) % total }));
  const quotas = Object.fromEntries(exact.map(e => [e.b, e.floor]));
  const left = n - Object.values(quotas).reduce((a, x) => a + x, 0);
  exact.sort((x, y) => y.rem - x.rem || y.size - x.size || (x.b < y.b ? -1 : 1)).slice(0, left).forEach(e => quotas[e.b]++);
  const key = (id: string) => sha256(`${seed}\u0000${id}`);
  const selected = [...buckets.keys()].sort().flatMap(b => [...buckets.get(b)!].sort((x, y) => key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : x < y ? -1 : 1).slice(0, quotas[b]));
  return { quotas: Object.fromEntries(Object.entries(quotas).sort(([a], [b]) => a < b ? -1 : 1)), selected };
}

interface LmeRaw {
  question_id: string; question_type: string; question: string; question_date?: string; answer?: unknown;
  answer_session_ids: string[]; haystack_session_ids: string[]; haystack_dates?: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

/**
 * One LongMemEval question as a conversation. Every session gets an
 * occurrence id `<session id>-occ-<index>` (the M pilot's rule: a haystack can
 * repeat a session id with different dates, and each dated occurrence stays
 * distinct) and keeps the dataset id in `original_id`. Gold lists every
 * occurrence of each answer session; score recall over `original_id`
 * (`originalSessionIds`), as the pilot's scorer does.
 */
export function lmeConversation(q: LmeRaw, occurrences: boolean): { conversation: Conversation; question: MemoryQuestion } {
  const sessions: Session[] = q.haystack_sessions.map((turns, i) => ({
    id: occurrences ? `${q.haystack_session_ids[i]}-occ-${i}` : q.haystack_session_ids[i], date: q.haystack_dates?.[i],
    turns: turns.map(t => ({ speaker: t.role, content: t.content })), ...(occurrences ? { original_id: q.haystack_session_ids[i] } : {}),
  }));
  const abstention = q.question_id.endsWith('_abs');
  const answerIds = new Set(q.answer_session_ids);
  return {
    conversation: { id: q.question_id, sessions },
    question: { id: q.question_id, conversation: q.question_id, question: q.question, question_date: q.question_date, category: q.question_type,
      gold: abstention ? [] : occurrences ? sessions.filter(s => answerIds.has(s.original_id!)).map(s => s.id) : [...q.answer_session_ids], abstention, answer: String(q.answer ?? '') },
  };
}

/** Session ids mapped to their dataset ids, first appearance kept (occurrences of one session count once). */
export function originalSessionIds(conversation: Conversation, ids: readonly string[]): string[] {
  const byId = new Map(conversation.sessions.map(s => [s.id, s.original_id ?? s.id]));
  return [...new Set(ids.map(id => byId.get(id) ?? id))];
}

/**
 * LongMemEval-M (`longmemeval_m_cleaned.json`, 2.7 GB): one streaming pass
 * records every question's type and byte range and verifies the pinned
 * SHA-256; only the selected questions are then read back by offset and
 * parsed. `ids` overrides the stratified 100-question selection.
 */
export function loadLmeM(opts: { path?: string; sha256?: string; size?: number; seed?: string; ids?: readonly string[]; chunkBytes?: number } = {}): Corpus & { selection: { seed: string; quotas: Record<string, number> | null; selected: string[] } } {
  const path = opts.path ?? join(DATASET_ROOT, LME_M_FILE.path);
  const expected = opts.sha256 ?? LME_M_FILE.sha256;
  if (!existsSync(path)) throw decideError({ code: 'DATASET_MISSING', message: `lme-m: ${path} is not downloaded`,
    why: 'datasets are fetched by pinned revision and SHA-256, never committed', fix: { next: 'run', argv: fetchArgv('lme-m'), verify: [...fetchArgv('lme-m'), '--verify-only'] } });
  const meta: Array<{ question_id: string; question_type: string; start: number; end: number }> = [];
  const scan = scanJsonArray(path, (v, start, end) => {
    const q = v as Partial<LmeRaw>;
    if (typeof q.question_id !== 'string' || typeof q.question_type !== 'string') throw new Error(`${path}: element at byte ${start} has no question_id or question_type`);
    meta.push({ question_id: q.question_id, question_type: q.question_type, start, end });
  }, opts.chunkBytes);
  if (scan.sha256 !== expected) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `lme-m: ${path} has SHA-256 ${scan.sha256.slice(0, 12)}, expected ${expected.slice(0, 12)}`,
    why: 'a different dataset revision would change every number; the kit only scores the pinned bytes',
    fix: { next: 'run', argv: [...fetchArgv('lme-m'), '--force'], verify: [...fetchArgv('lme-m'), '--verify-only'] } });
  const sel = opts.ids ? { quotas: null, selected: [...opts.ids] } : lmeMSelection(meta, opts.size ?? 100, opts.seed ?? LME_M_SELECTION_SEED);
  const byId = new Map(meta.map(m => [m.question_id, m]));
  const missing = sel.selected.filter(id => !byId.has(id));
  if (missing.length) throw new Error(`lme-m: ${missing.length} selected question id(s) are not in ${path}`);
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  const fd = openSync(path, 'r');
  try {
    for (const id of sel.selected) {
      const m = byId.get(id)!;
      const buf = Buffer.alloc(m.end - m.start);
      readSync(fd, buf, 0, buf.length, m.start);
      const { conversation, question } = lmeConversation(JSON.parse(buf.toString('utf8')) as LmeRaw, true);
      conversations.push(conversation); questions.push(question);
    }
  } finally { closeSync(fd); }
  return { benchmark: 'lme-m', conversations, questions,
    source: { name: 'LongMemEval-M cleaned', files: [{ path: LME_M_FILE.path, sha256: scan.sha256 }], revision: '98d7416c', license: 'MIT' },
    selection: { seed: opts.seed ?? LME_M_SELECTION_SEED, quotas: sel.quotas, selected: sel.selected } };
}

export const FIXTURE_PATH = join(REPO_ROOT, 'eval/data/decide-fixture/conversations.json');

export function loadFixture(): Corpus {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { conversations: Conversation[]; questions: MemoryQuestion[] };
  return { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'decide fixture (invented)', files: [{ path: 'eval/data/decide-fixture/conversations.json', sha256: sha256(readFileSync(FIXTURE_PATH)) }], revision: 'repo', license: 'MIT' } };
}

/**
 * A custodian-authored sealed corpus (benchmark `custody`): one JSON file outside the repository holding
 * `{ id, conversations: Conversation[], questions: MemoryQuestion[] }`. Question categories use the LongMemEval
 * names (for example single-session-assistant, single-session-user) so the LongMemEval judge applies. The caller
 * logs the access before this reads the file.
 */
export function loadCustodyCorpus(path: string): Corpus {
  const bytes = readFileSync(path);
  const raw = JSON.parse(bytes.toString('utf8')) as { id?: string; conversations?: Conversation[]; questions?: MemoryQuestion[] };
  if (!raw.id || !Array.isArray(raw.conversations) || !Array.isArray(raw.questions)) throw new Error('custody corpus needs id, conversations and questions');
  const convIds = new Set(raw.conversations.map(c => c.id));
  for (const q of raw.questions) {
    if (!convIds.has(q.conversation)) throw new Error(`custody corpus question ${q.id} names an unknown conversation`);
    const sessions = new Set(raw.conversations.find(c => c.id === q.conversation)!.sessions.map(x => x.id));
    if (q.gold.some(g => !sessions.has(g))) throw new Error(`custody corpus question ${q.id} names an unknown gold session`);
  }
  return { benchmark: 'custody', conversations: raw.conversations, questions: raw.questions,
    source: { name: `custodian sealed corpus ${raw.id}`, files: [{ path: 'custody', sha256: sha256(bytes) }], revision: raw.id, license: 'custodian-authored' } };
}

/** `only` restricts LoCoMo and BEAM to those conversations (a dev split), so a BEAM conversation outside it is never read. */
export function loadCorpus(benchmark: string, corpusFile?: string, only?: ReadonlySet<string>): Corpus {
  if (benchmark === 'custody') {
    if (!corpusFile) throw new Error('benchmark custody needs --corpus-file <custody path>');
    return loadCustodyCorpus(corpusFile);
  }
  switch (benchmark) {
    case 'locomo': return loadLocomo(only);
    case 'lme-s': return loadLmeS();
    case 'beam-100k': return loadBeam('100k', only);
    case 'beam-500k': return loadBeam('500k', only);
    case 'beam-1m': return loadBeam('1m', only);
    case 'lme-m': return loadLmeM();
    case 'beam-10m': {
      const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
      if (!log) throw decideError({ code: 'CUSTODY_MISSING', message: 'BEAM-10M questions open only on the custodian host',
        why: 'all ten BEAM-10M conversations are sealed (eval/decisions/splits/beam-10m.json); every opening is logged', fix: { next: 'ask_user', user_message: 'request the BEAM-10M cells from the custodian (decision q1-scoreboard)' } });
      const corpus = loadBeam10mCorpus();
      const questions = loadBeam10mQuestions(corpus, { log, decisionId: process.env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard', purpose: 'memory-qa loadCorpus beam-10m' });
      return { benchmark: 'beam-10m', conversations: corpus.conversations, questions: questions.questions, source: corpus.source };
    }
    case 'fixture': return loadFixture();
    default: throw new Error(`unknown benchmark ${benchmark}`);
  }
}

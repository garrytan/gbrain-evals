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
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { decideError } from '../decisions/errors.ts';
import { appendAccessLog } from '../sealed-confirmation-lib.ts';
import { beam10mManifestPath, beam10mRoot, loadBeam10mCorpus } from './beam10m-corpus.ts';
import { loadBeam10mQuestions } from './beam10m-questions.ts';
import { BG1_CONVERSATIONS, BG1_DEV_CONVERSATIONS, BG1_N_CAP, BG1_N_FLOOR, BG1_STRATA, type Bg1QuestionFields } from './bg1-names.ts';

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
  /** Evaluator-side only: BG1's stratum, gold, stale and decoy values (eval/runner/memory-qa/bg1-names.ts). */
  bg1?: Bg1QuestionFields;
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
    case 'beam-d8': throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-d8 is sealed: its files are never downloaded',
      why: 'every D8 conversation is in the sealed split and lives only in owner custody (GBRAIN_EVALS_D8_SOURCE on the custodian host)', fix: d8Ask });
    case 'beam-rs1': throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-rs1 is sealed: its files are never downloaded',
      why: 'every RS1 conversation is in the sealed split and lives only in owner custody (GBRAIN_EVALS_RS1_SOURCE on the custodian host)', fix: rs1Ask });
    case 'bg1': throw decideError({ code: 'CUSTODY_MISSING', message: 'bg1 is sealed: its files are never downloaded',
      why: 'every BG1 world is in the sealed split and lives only in owner custody (GBRAIN_EVALS_BG1_SOURCE on the custodian host)', fix: bg1Ask });
    case 'bg1-dev': return [];
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

/**
 * BEAM-10M on a sealed VM (A17): nothing is downloaded. The launcher's custody push put the custodian's verified files
 * under GBRAIN_EVALS_BEAM10M_ROOT, outside the checkout; this checks every corpus and question file against the
 * manifest's SHA-256 (hashing bytes, parsing nothing) and refuses on a missing file or a mismatch. Without that root
 * BEAM-10M stays custody-only, as before.
 */
export function verifyBeam10mCustody(log: (s: string) => void = s => process.stderr.write(s + '\n')): number {
  if (!process.env.GBRAIN_EVALS_BEAM10M_ROOT) filesFor('beam-10m');
  const root = beam10mRoot();
  const m = JSON.parse(readFileSync(beam10mManifestPath(), 'utf8')) as { status: string; conversations: Array<{ conversation: string; chat_path: string; chat_sha256: string | null; questions_path: string; questions_sha256: string | null }> };
  if (m.status !== 'filled') throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-10m: the manifest has no hashes yet', why: 'only pinned bytes are accepted on a sealed VM',
    fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch', '--write'], user_message: 'the custodian fills the BEAM-10M manifest on the custody host' } });
  let n = 0;
  for (const c of m.conversations) for (const [path, want] of [[c.chat_path, c.chat_sha256], [c.questions_path, c.questions_sha256]] as const) {
    const abs = join(root, path);
    if (!existsSync(abs)) throw decideError({ code: 'DATASET_MISSING', message: `beam-10m: ${path} did not arrive in the custody root`, why: 'the launcher pushes every BEAM-10M file from the custodian host before setup',
      fix: { next: 'tell_user_to_run', argv: ['bun', 'run', 'eval:scoreboard', 'doctor', '--for', 'sealed'], user_message: 'set GBRAIN_EVALS_BEAM10M_SOURCE on the custodian host to the verified BEAM-10M files and relaunch' } });
    const got = fileSha256(abs);
    if (got !== want) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `beam-10m: ${path} arrived with SHA-256 ${got.slice(0, 12)}, expected ${String(want).slice(0, 12)}`, why: 'only the pinned bytes are scored',
      fix: { next: 'tell_user_to_run', argv: ['bun', 'run', 'eval:scoreboard', 'doctor', '--for', 'sealed'], user_message: 're-verify the custodian\'s BEAM-10M files and relaunch' } });
    n++;
  }
  log(`[custody] beam-10m: ${n} file(s) match their pinned sha256 under the custody root`);
  return n;
}

export async function fetchDataset(benchmark: string, opts: { force?: boolean; verifyOnly?: boolean; log?: (s: string) => void; only?: ReadonlySet<string> } = {}): Promise<{ fetched: number; verified: number }> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + '\n'));
  let fetched = 0; let verified = 0;
  if (benchmark === 'beam-10m') return { fetched: 0, verified: verifyBeam10mCustody(log) };
  if (benchmark === 'beam-d8') return { fetched: 0, verified: verifyD8Custody(log) };
  if (benchmark === 'beam-rs1') return { fetched: 0, verified: verifyRs1Custody(log) };
  if (benchmark === 'bg1') return { fetched: 0, verified: verifyBg1Custody(log) };
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

export type BeamChat = Array<{ batch_number: number; time_anchor?: string | null; turns: Array<Array<{ role: string; id: number; content: string; time_anchor?: string }>> }>;
export interface BeamProbingItem { question: string; source_chat_ids?: unknown; answer?: unknown; ideal_response?: unknown; ideal_answer?: unknown; ideal_summary?: unknown; expected_compliance?: unknown; rubric?: unknown }

/** A BEAM chat (a list of batches) as sessions: one per turn group, id `b<batch>-g<group>`, dated by `beamGroupDates`. */
export function beamSessions(chat: BeamChat): { sessions: Session[]; sessionOfMessage: Map<number, string> } {
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
  return { sessions, sessionOfMessage };
}

/**
 * One BEAM probing question: id `<conversation>:<ability>:<index>`, gold sessions from `source_chat_ids` (none for
 * abstention), the reference from the first of answer, ideal_response, ideal_answer, ideal_summary, expected_compliance,
 * and the item's own rubric list, else none (the BEAM instrument then judges the reference as a one-item rubric).
 */
export function beamQuestion(conversation: string, ability: string, item: BeamProbingItem, i: number, sessionOfMessage: ReadonlyMap<number, string>): MemoryQuestion {
  const gold = [...new Set(messageIds(item.source_chat_ids).map(id => sessionOfMessage.get(id)).filter((s): s is string => !!s))];
  const abstention = ability === 'abstention';
  const reference = item.answer ?? item.ideal_response ?? item.ideal_answer ?? item.ideal_summary ?? item.expected_compliance;
  return { id: `${conversation}:${ability}:${i}`, conversation, question: item.question, category: ability, gold: abstention ? [] : gold, abstention,
    answer: reference === undefined ? undefined : String(reference), rubric: Array.isArray(item.rubric) ? item.rubric.map(String) : undefined };
}

/** `only` restricts loading to those conversation ids (a split), so other conversations' files are never read. */
export function loadBeam(size: '100k' | '500k' | '1m', only?: ReadonlySet<string>): Corpus {
  const m = beamManifest();
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const c of m.sizes[size].filter(x => !only || only.has(x.conversation))) {
    const { sessions, sessionOfMessage } = beamSessions(JSON.parse(readDatasetFile({ path: `beam/${c.chat_path}`, url: m.raw_base + c.chat_path, sha256: c.chat_sha256 }, `beam-${size}`)) as BeamChat);
    conversations.push({ id: c.conversation, sessions });
    const pq = JSON.parse(readDatasetFile({ path: `beam/${c.questions_path}`, url: m.raw_base + c.questions_path, sha256: c.questions_sha256 }, `beam-${size}`)) as Record<string, BeamProbingItem[]>;
    for (const [ability, items] of Object.entries(pq)) items.forEach((item, i) => questions.push(beamQuestion(c.conversation, ability, item, i, sessionOfMessage)));
  }
  return { benchmark: `beam-${size}`, conversations, questions, source: { name: `BEAM ${size}`, files: [{ path: 'eval/decisions/datasets/beam-b2da22e.json', sha256: sha256(readFileSync(join(REPO_ROOT, 'eval/decisions/datasets/beam-b2da22e.json'))) }], revision: m.commit.slice(0, 7), license: m.license } };
}

// ─── D8 long-history reserve ────────────────────────────────────────

/**
 * D8 (benchmark `beam-d8`): ten conversations generated with BEAM's generator and held in owner custody, all sealed
 * (eval/decisions/splits/beam-d8.json). GBRAIN_EVALS_D8_SOURCE names a root outside the checkout that holds the
 * generator's own layout:
 *
 *   conversations/<n>/chat.json                                   (chat_trunecated.json instead when present, as BEAM reads it)
 *   conversations/<n>/probing_questions/<ability>/<ability>.json  (one file per ability, as the generator writes them)
 *
 * Conversation `d8-<n>` is conversations/<n>. Sessions, gold, references and rubrics are loadBeam's (beamSessions,
 * beamQuestion). An ability file is a list of items or, as the generator writes it, a list of lists (one inner list
 * per generation prompt); items are numbered in file order after flattening. Nothing is ever downloaded. The
 * manifest (eval/decisions/datasets/d8-manifest.json) stays `unfilled` until the custodian records every file's
 * SHA-256 (`bun eval/runner/q1/d8-manifest.ts fill --write`); once filled, a file it does not list, a listed file
 * that is missing and a hash mismatch all refuse.
 */
export const D8_MANIFEST = 'eval/decisions/datasets/d8-manifest.json';
export const D8_CONVERSATIONS: readonly string[] = Array.from({ length: 10 }, (_, i) => `d8-${i + 1}`);
/** A sealed VM's env names its custody paths from the VM user's home (`~/custody/d8`, as the launcher's push sets them). */
const fromHome = (p: string | undefined) => !p ? undefined : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
export const d8ManifestPath = () => fromHome(process.env.GBRAIN_EVALS_D8_MANIFEST) ?? join(REPO_ROOT, D8_MANIFEST);
export interface D8Manifest { dataset: string; status: 'unfilled' | 'filled'; layout: string; note: string; files: Array<{ path: string; sha256: string }>; filled_at: string | null }
const D8_FILL = ['bun', 'eval/runner/q1/d8-manifest.ts', 'fill', '--write'];
const d8Ask = { next: 'ask_user' as const, user_message: 'run beam-d8 on the custody host with GBRAIN_EVALS_D8_SOURCE set to the D8 root (it holds conversations/1 to conversations/10)' };

/** The D8 custody root, refusing when GBRAIN_EVALS_D8_SOURCE is unset or inside the repository. */
export function d8Source(env: Record<string, string | undefined> = process.env): string {
  const source = fromHome(env.GBRAIN_EVALS_D8_SOURCE);
  if (!source) throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-d8: GBRAIN_EVALS_D8_SOURCE is not set',
    why: 'all ten D8 conversations are sealed (eval/decisions/splits/beam-d8.json) and live only in owner custody; nothing is downloaded', fix: d8Ask });
  const abs = resolve(source);
  const rel = relative(REPO_ROOT, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw decideError({ code: 'CUSTODY_MISSING', message: `beam-d8: GBRAIN_EVALS_D8_SOURCE ${abs} is inside the repository`,
    why: 'sealed files never live where Git could pick them up', fix: d8Ask });
  return abs;
}

export function readD8Manifest(path = d8ManifestPath()): { manifest: D8Manifest; sha256: string } {
  const bytes = readFileSync(path);
  return { manifest: JSON.parse(bytes.toString('utf8')) as D8Manifest, sha256: sha256(bytes) };
}

/** The files one D8 conversation is read from, as paths relative to the root; refuses when any part of the layout is missing. */
export function d8ConversationFiles(root: string, conversation: string): { chat: string; abilities: Array<{ ability: string; path: string }> } {
  if (!D8_CONVERSATIONS.includes(conversation)) throw new Error(`beam-d8 has no conversation ${conversation}`);
  const dir = `conversations/${conversation.slice(3)}`;
  const missing = (what: string) => decideError({ code: 'DATASET_MISSING', message: `beam-d8: ${what} is not under GBRAIN_EVALS_D8_SOURCE`,
    why: 'each D8 conversation is a BEAM generator directory with a chat file and probing_questions/<ability>/<ability>.json', fix: d8Ask });
  if (!existsSync(join(root, dir))) throw missing(dir);
  const chat = ['chat_trunecated.json', 'chat.json'].map(f => `${dir}/${f}`).find(p => existsSync(join(root, p)));
  if (!chat) throw missing(`${dir}/chat.json`);
  const pq = `${dir}/probing_questions`;
  if (!existsSync(join(root, pq))) throw missing(pq);
  const abilities = readdirSync(join(root, pq), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().map(ability => {
    const path = `${pq}/${ability}/${ability}.json`;
    if (!existsSync(join(root, path))) throw missing(path);
    return { ability, path };
  });
  if (!abilities.length) throw missing(`${pq}/<ability>/<ability>.json`);
  return { chat, abilities };
}

/** Every file D8 is read from with its SHA-256, the entries a filled manifest holds (bytes are hashed, never parsed). */
export function d8ManifestFiles(root: string): Array<{ path: string; sha256: string }> {
  return D8_CONVERSATIONS.flatMap(id => { const f = d8ConversationFiles(root, id); return [f.chat, ...f.abilities.map(a => a.path)]; })
    .map(path => ({ path, sha256: fileSha256(join(root, path)) }));
}

const flatItems = (v: unknown): unknown[] => Array.isArray(v) ? v.flatMap(flatItems) : [v];

/**
 * Load D8 (sealed): appends one custody access-log line per conversation before its files are read. `only` keeps
 * those conversations. With a filled manifest every file must be listed and match; with an unfilled one the files'
 * hashes are recorded in the corpus source and a notice says they were not pinned.
 */
export function loadD8(custody: { log: string; decisionId: string; purpose: string }, opts: { only?: ReadonlySet<string>; root?: string; manifestPath?: string } = {}): Corpus {
  const root = opts.root ?? d8Source();
  if (!custody.log) throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-d8 opens only on the custodian host', why: 'every opening of a sealed set is logged first',
    fix: { next: 'ask_user', user_message: 'request the beam-d8 cells from the custodian (decision q1-scoreboard)' } });
  const unknown = opts.only ? [...opts.only].filter(id => !D8_CONVERSATIONS.includes(id)) : [];
  if (unknown.length) throw new Error(`beam-d8 has no conversation ${unknown.join(', ')}`);
  const { manifest, sha256: manifestSha } = readD8Manifest(opts.manifestPath);
  const pinned = manifest.status === 'filled' ? new Map(manifest.files.map(f => [f.path, f.sha256])) : null;
  const files: DatasetIdentity['files'] = [];
  const read = (path: string) => {
    const bytes = readFileSync(join(root, path));
    const got = sha256(bytes);
    const want = pinned?.get(path);
    if (pinned && got !== want) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: want ? `beam-d8: ${path} has SHA-256 ${got.slice(0, 12)}, expected ${want.slice(0, 12)}` : `beam-d8: ${path} is not in the filled manifest`,
      why: 'only the pinned bytes are scored', fix: { next: 'tell_user_to_run', argv: D8_FILL, user_message: 're-verify the custodian\'s D8 files, or refill the manifest if they changed on purpose' } });
    files.push({ path, sha256: got });
    return bytes.toString('utf8');
  };
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const id of D8_CONVERSATIONS.filter(c => !opts.only || opts.only.has(c))) {
    const f = d8ConversationFiles(root, id);
    if (pinned) {
      const reading = new Set([f.chat, ...f.abilities.map(a => a.path)]);
      const absent = [...pinned.keys()].filter(p => p.startsWith(`conversations/${id.slice(3)}/`) && !reading.has(p));
      if (absent.length) throw decideError({ code: 'DATASET_MISSING', message: `beam-d8: ${absent.length} file(s) the manifest pins for ${id} are not under GBRAIN_EVALS_D8_SOURCE`, why: 'a pinned conversation loads whole or not at all', fix: d8Ask });
    }
    appendAccessLog(custody.log, { action: 'open', purpose: `beam-d8 ${id}: ${custody.purpose}`, decision_id: custody.decisionId, labels_sha256: manifestSha, run_sha256: null });
    const { sessions, sessionOfMessage } = beamSessions(JSON.parse(read(f.chat)) as BeamChat);
    conversations.push({ id, sessions });
    for (const { ability, path } of f.abilities) {
      flatItems(JSON.parse(read(path))).forEach((item, i) => {
        if (!item || typeof item !== 'object' || typeof (item as BeamProbingItem).question !== 'string') throw new Error(`beam-d8: ${path} item ${i} has no question`);
        questions.push(beamQuestion(id, ability, item as BeamProbingItem, i, sessionOfMessage));
      });
    }
  }
  if (!pinned) process.stderr.write(`[custody] beam-d8: the manifest is unfilled, so ${files.length} file(s) loaded without pinned hashes (fill it with ${D8_FILL.join(' ')})\n`);
  return { benchmark: 'beam-d8', conversations, questions,
    source: { name: 'D8 long-history reserve (BEAM generator layout)', files: [{ path: D8_MANIFEST, sha256: manifestSha }, ...files], revision: pinned ? manifestSha.slice(0, 7) : 'unfilled', license: 'custodian-held' } };
}

/** `decide fetch` for D8: nothing is downloaded; every file the filled manifest pins must be under the custody root with its hash. */
export function verifyD8Custody(log: (s: string) => void = s => process.stderr.write(s + '\n')): number {
  const root = d8Source();
  const { manifest } = readD8Manifest();
  if (manifest.status !== 'filled') throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-d8: the manifest has no hashes yet', why: 'only pinned bytes are verified',
    fix: { next: 'tell_user_to_run', argv: D8_FILL, user_message: 'the custodian fills the D8 manifest on the custody host' } });
  for (const f of manifest.files) {
    const abs = join(root, f.path);
    if (!existsSync(abs)) throw decideError({ code: 'DATASET_MISSING', message: `beam-d8: ${f.path} is not under GBRAIN_EVALS_D8_SOURCE`, why: 'every pinned file must be present', fix: d8Ask });
    const got = fileSha256(abs);
    if (got !== f.sha256) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `beam-d8: ${f.path} has SHA-256 ${got.slice(0, 12)}, expected ${f.sha256.slice(0, 12)}`, why: 'only the pinned bytes are scored',
      fix: { next: 'tell_user_to_run', argv: D8_FILL, user_message: 're-verify the custodian\'s D8 files' } });
  }
  log(`[custody] beam-d8: ${manifest.files.length} file(s) match their pinned sha256 under GBRAIN_EVALS_D8_SOURCE`);
  return manifest.files.length;
}

// ─── RS1 ranking set ────────────────────────────────────────────────

/**
 * RS1 (benchmark `beam-rs1`): 48 mint slots, rs1-001 to rs1-048, minted in slot order with BEAM's generator (b2da22e) by
 * eval/custody/rs1/mint.sh and held in owner custody, all sealed (eval/decisions/splits/beam-rs1.json;
 * docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md). Minting stops once the kept set is complete, so later slots
 * may never exist. GBRAIN_EVALS_RS1_SOURCE names a root outside
 * the checkout that holds the mint's set (mint.sh's <out>/set, the root eval/custody/rs1/validate.ts and hashlist.ts
 * read):
 *
 *   conversations/c<NNN>/beam/1/chat.json                                 (chat_trunecated.json instead when present, as BEAM reads it)
 *   conversations/c<NNN>/beam/1/probing_questions/probing_questions.json  (the selected items with their rubrics, in BEAM's published format)
 *
 * Conversation `rs1-<NNN>` is conversations/c<NNN>. Unlike D8, the questions are probing_questions.json, the mint's
 * final selection, never the per-ability candidate files beside it. Sessions, gold, references and rubrics are
 * loadBeam's (beamSessions, beamQuestion); items are numbered per ability in file order. Nothing is ever downloaded.
 * The manifest (eval/decisions/datasets/rs1-manifest.json) stays `unfilled` until the custodian records every file's
 * SHA-256 (rs1ManifestFiles); once filled, a file it does not list, a listed file that is missing and a hash mismatch
 * all refuse. The filled manifest also carries the custodian's kept list (`kept`, the first slots that passed
 * validation, in slot order) and, once the pilot sets it, `n_final`; the cells run on that list alone (rs1Kept).
 * A later fill only adds files and records the earlier fill's sha256 under `earlier_fills`.
 */
export const RS1_MANIFEST = 'eval/decisions/datasets/rs1-manifest.json';
export const RS1_CONVERSATIONS: readonly string[] = Array.from({ length: 48 }, (_, i) => `rs1-${String(i + 1).padStart(3, '0')}`);
export const rs1ManifestPath = () => fromHome(process.env.GBRAIN_EVALS_RS1_MANIFEST) ?? join(REPO_ROOT, RS1_MANIFEST);
export interface Rs1Manifest {
  dataset: string; status: 'unfilled' | 'filled'; layout: string; note: string; files: Array<{ path: string; sha256: string }>; filled_at: string | null;
  /** The kept conversations in slot order (filled manifests): the first slots that passed validation. */
  kept?: string[];
  /** The kept set's final size once the pilot sets it (20 to 33); absent while only wave A is kept. */
  n_final?: number;
  /** The sha256 of each earlier fill of this manifest, oldest first (a refill only adds files). */
  earlier_fills?: string[];
}
const rs1Fill = { next: 'ask_user' as const, user_message: 'the custodian fills (or refills) the RS1 manifest from the set root on the custody host: every file rs1ManifestFiles lists, with its SHA-256' };
const rs1Ask = { next: 'ask_user' as const, user_message: 'run beam-rs1 on the custody host with GBRAIN_EVALS_RS1_SOURCE set to the RS1 set root (mint.sh\'s <out>/set; it holds conversations/c<NNN> for the minted slots)' };

/** The RS1 custody root, refusing when GBRAIN_EVALS_RS1_SOURCE is unset or inside the repository. */
export function rs1Source(env: Record<string, string | undefined> = process.env): string {
  const source = fromHome(env.GBRAIN_EVALS_RS1_SOURCE);
  if (!source) throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-rs1: GBRAIN_EVALS_RS1_SOURCE is not set',
    why: 'every RS1 conversation is sealed (eval/decisions/splits/beam-rs1.json) and lives only in owner custody; nothing is downloaded', fix: rs1Ask });
  const abs = resolve(source);
  const rel = relative(REPO_ROOT, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw decideError({ code: 'CUSTODY_MISSING', message: `beam-rs1: GBRAIN_EVALS_RS1_SOURCE ${abs} is inside the repository`,
    why: 'sealed files never live where Git could pick them up', fix: rs1Ask });
  return abs;
}

export function readRs1Manifest(path = rs1ManifestPath()): { manifest: Rs1Manifest; sha256: string } {
  const bytes = readFileSync(path);
  return { manifest: JSON.parse(bytes.toString('utf8')) as Rs1Manifest, sha256: sha256(bytes) };
}

/** The files one RS1 conversation is read from, as paths relative to the root; refuses when any part of the layout is missing. */
export function rs1ConversationFiles(root: string, conversation: string): { chat: string; questions: string } {
  if (!RS1_CONVERSATIONS.includes(conversation)) throw new Error(`beam-rs1 has no conversation ${conversation}`);
  const dir = `conversations/c${conversation.slice(4)}/beam/1`;
  const missing = (what: string) => decideError({ code: 'DATASET_MISSING', message: `beam-rs1: ${what} is not under GBRAIN_EVALS_RS1_SOURCE`,
    why: 'each RS1 conversation is a mint directory whose beam/1 holds BEAM\'s chat file and probing_questions/probing_questions.json', fix: rs1Ask });
  if (!existsSync(join(root, dir))) throw missing(dir);
  const chat = ['chat_trunecated.json', 'chat.json'].map(f => `${dir}/${f}`).find(p => existsSync(join(root, p)));
  if (!chat) throw missing(`${dir}/chat.json`);
  const questions = `${dir}/probing_questions/probing_questions.json`;
  if (!existsSync(join(root, questions))) throw missing(questions);
  return { chat, questions };
}

/** Every file the given conversations (default: every slot) are read from with its SHA-256, the entries a filled manifest holds (bytes are hashed, never parsed). */
export function rs1ManifestFiles(root: string, ids: readonly string[] = RS1_CONVERSATIONS): Array<{ path: string; sha256: string }> {
  return ids.flatMap(id => { const f = rs1ConversationFiles(root, id); return [f.chat, f.questions]; })
    .map(path => ({ path, sha256: fileSha256(join(root, path)) }));
}

/**
 * Load RS1 (sealed): appends one custody access-log line per conversation before its files are read. `only` keeps
 * those conversations. With a filled manifest every file must be listed and match; with an unfilled one the files'
 * hashes are recorded in the corpus source and a notice says they were not pinned.
 */
export function loadRs1(custody: { log: string; decisionId: string; purpose: string }, opts: { only?: ReadonlySet<string>; root?: string; manifestPath?: string } = {}): Corpus {
  const root = opts.root ?? rs1Source();
  if (!custody.log) throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-rs1 opens only on the custodian host', why: 'every opening of a sealed set is logged first',
    fix: { next: 'ask_user', user_message: 'request the beam-rs1 cells from the custodian (decision q1-scoreboard)' } });
  const unknown = opts.only ? [...opts.only].filter(id => !RS1_CONVERSATIONS.includes(id)) : [];
  if (unknown.length) throw new Error(`beam-rs1 has no conversation ${unknown.join(', ')}`);
  const { manifest, sha256: manifestSha } = readRs1Manifest(opts.manifestPath);
  const pinned = manifest.status === 'filled' ? new Map(manifest.files.map(f => [f.path, f.sha256])) : null;
  const files: DatasetIdentity['files'] = [];
  const read = (path: string) => {
    const bytes = readFileSync(join(root, path));
    const got = sha256(bytes);
    const want = pinned?.get(path);
    if (pinned && got !== want) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: want ? `beam-rs1: ${path} has SHA-256 ${got.slice(0, 12)}, expected ${want.slice(0, 12)}` : `beam-rs1: ${path} is not in the filled manifest`,
      why: 'only the pinned bytes are scored', fix: rs1Fill });
    files.push({ path, sha256: got });
    return bytes.toString('utf8');
  };
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const id of RS1_CONVERSATIONS.filter(c => !opts.only || opts.only.has(c))) {
    const f = rs1ConversationFiles(root, id);
    if (pinned) {
      const reading = new Set([f.chat, f.questions]);
      const absent = [...pinned.keys()].filter(p => p.startsWith(`conversations/c${id.slice(4)}/`) && !reading.has(p));
      if (absent.length) throw decideError({ code: 'DATASET_MISSING', message: `beam-rs1: ${absent.length} file(s) the manifest pins for ${id} are not under GBRAIN_EVALS_RS1_SOURCE`, why: 'a pinned conversation loads whole or not at all', fix: rs1Ask });
    }
    appendAccessLog(custody.log, { action: 'open', purpose: `beam-rs1 ${id}: ${custody.purpose}`, decision_id: custody.decisionId, labels_sha256: manifestSha, run_sha256: null });
    const { sessions, sessionOfMessage } = beamSessions(JSON.parse(read(f.chat)) as BeamChat);
    conversations.push({ id, sessions });
    for (const [ability, items] of Object.entries(JSON.parse(read(f.questions)) as Record<string, unknown>)) {
      flatItems(items).forEach((item, i) => {
        if (!item || typeof item !== 'object' || typeof (item as BeamProbingItem).question !== 'string') throw new Error(`beam-rs1: ${f.questions} ${ability} item ${i} has no question`);
        questions.push(beamQuestion(id, ability, item as BeamProbingItem, i, sessionOfMessage));
      });
    }
  }
  if (!pinned) process.stderr.write(`[custody] beam-rs1: the manifest is unfilled, so ${files.length} file(s) loaded without pinned hashes (the custodian fills it with rs1ManifestFiles before a counted run)\n`);
  return { benchmark: 'beam-rs1', conversations, questions,
    source: { name: 'RS1 ranking set (BEAM generator, minted in custody)', files: [{ path: RS1_MANIFEST, sha256: manifestSha }, ...files], revision: pinned ? manifestSha.slice(0, 7) : 'unfilled', license: 'custodian-held' } };
}

/**
 * The custodian's kept list from a filled manifest: slot ids in strictly increasing slot order, each with both of its
 * files pinned, at most n_final of them. Refuses an unfilled manifest, a kept id outside the 48 slots and a kept id the
 * manifest does not pin, so a cell never runs a conversation the custodian did not keep and hash.
 */
export function rs1Kept(manifest: Rs1Manifest): { kept: string[]; n_final: number | null } {
  const bad = (message: string) => decideError({ code: 'DATASET_MISSING', message: `beam-rs1: ${message}`, why: 'RS1 cells run only on the custodian\'s kept list, checked against the filled manifest', fix: rs1Fill });
  if (manifest.status !== 'filled') throw bad('the manifest is unfilled, so it has no kept list');
  const kept = manifest.kept;
  if (!Array.isArray(kept) || !kept.length) throw bad('the filled manifest has no kept list');
  const outside = kept.filter(id => !RS1_CONVERSATIONS.includes(id));
  if (outside.length) throw bad(`kept ${outside.join(', ')} is not one of the 48 mint slots`);
  if (kept.some((id, i) => i > 0 && !(kept[i - 1] < id))) throw bad('the kept list is not in strictly increasing slot order');
  const unpinned = kept.filter(id => ['chat', 'probing_questions/probing_questions.json'].some(f => !manifest.files.some(x => x.path.startsWith(`conversations/c${id.slice(4)}/beam/1/${f}`))));
  if (unpinned.length) throw bad(`kept ${unpinned.join(', ')} has no pinned chat or questions file in the filled manifest`);
  const n = manifest.n_final ?? null;
  if (n !== null && !(Number.isInteger(n) && n >= 20 && n <= 33 && kept.length <= n)) throw bad(`n_final ${n} must be a whole number from 20 to 33, at least the kept list's ${kept.length}`);
  return { kept: [...kept], n_final: n };
}

/**
 * The conversations of one RS1 launch unit: kept conversations unit x perUnit to (unit + 1) x perUnit - 1. A unit runs
 * only once all of its conversations are kept; the last unit may be partial once n_final says the list is complete.
 */
export function rs1UnitConversations(manifest: Rs1Manifest, unit: number, perUnit: number): string[] {
  const { kept, n_final } = rs1Kept(manifest);
  const slice = kept.slice(unit * perUnit, (unit + 1) * perUnit);
  const complete = n_final !== null && kept.length === n_final;
  if (!slice.length || (slice.length < perUnit && !complete)) throw decideError({ code: 'DATASET_MISSING',
    message: `beam-rs1: launch unit ${unit} needs kept conversations ${unit * perUnit + 1} to ${(unit + 1) * perUnit}, and the kept list holds ${kept.length}${complete ? ' (final)' : ''}`,
    why: 'a launch unit runs whole: its kept conversations in slot order, the last unit partial only once n_final completes the list', fix: rs1Fill });
  return slice;
}

/** `decide fetch` for RS1: nothing is downloaded; every file the filled manifest pins must be under the custody root with its hash. */
export function verifyRs1Custody(log: (s: string) => void = s => process.stderr.write(s + '\n')): number {
  const root = rs1Source();
  const { manifest } = readRs1Manifest();
  if (manifest.status !== 'filled') throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-rs1: the manifest has no hashes yet', why: 'only pinned bytes are verified', fix: rs1Fill });
  for (const f of manifest.files) {
    const abs = join(root, f.path);
    if (!existsSync(abs)) throw decideError({ code: 'DATASET_MISSING', message: `beam-rs1: ${f.path} is not under GBRAIN_EVALS_RS1_SOURCE`, why: 'every pinned file must be present', fix: rs1Ask });
    const got = fileSha256(abs);
    if (got !== f.sha256) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `beam-rs1: ${f.path} has SHA-256 ${got.slice(0, 12)}, expected ${f.sha256.slice(0, 12)}`, why: 'only the pinned bytes are scored', fix: rs1Fill });
  }
  log(`[custody] beam-rs1: ${manifest.files.length} file(s) match their pinned sha256 under GBRAIN_EVALS_RS1_SOURCE`);
  return manifest.files.length;
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

// ─── BG1 changing facts ─────────────────────────────────────────────

/**
 * BG1 (benchmarks `bg1-dev` and `bg1`; docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md):
 * synthetic histories in which facts change, planned by eval/generators/changing-facts-gen.ts. A root holds
 *
 *   worlds/<id>/world.json       { schema: "gbrain-evals/bg1-world/v1", id, sessions: [{ id, day, time, turns }] }
 *   worlds/<id>/questions.json   [{ id, question, answer, evidence_sessions, bg1 }]
 *
 * beside the world's plan.json, which no loader reads. A session's day is an offset from the world end (day 0), and
 * text holds [[D:<offset>]] (a date) and [[W:<offset>]] (a weekday) tokens. The loaders resolve both from
 * GBRAIN_EVALS_BG1_WORLD_END (bg1WorldEnd): a session's date is the ISO minute of its day and time, and every
 * question's question_date is the day after the world end, the counted "now". Gold is the question's
 * evidence_sessions, the category its stratum, and the bg1 fields travel on the question for the instrument.
 *
 * bg1-dev reads the three public dev worlds under eval/data/changing-facts-v1/dev, or GBRAIN_EVALS_BG1_DEV_ROOT (the
 * template fixtures in eval/data/changing-facts-v1/fixtures, for keyless runs only). The Gemini-rendered dev worlds land
 * in stage 1, so until then bg1-dev refuses without that override. A load not declared keyless (a cell run on a paid
 * lease, judge-check --stage1, verdict BG1-dev3) refuses a root that is the fixtures or holds template-rendered worlds
 * (bg1DevFixtureProblem), so the fixtures never stand in for the rendered dev worlds in a paid run. bg1 is sealed (eval/decisions/splits/bg1.json): 48 mint
 * slots, bg1-001 to bg1-048, minted in slot order by eval/custody/bg1/mint.sh into owner custody. It reads only
 * GBRAIN_EVALS_BG1_SOURCE (mint.sh's <out>/set), refusing a root inside the checkout, logs every opening first, checks
 * the manifest (eval/decisions/datasets/bg1-manifest.json, GBRAIN_EVALS_BG1_MANIFEST to override) and honours the unit
 * scope GBRAIN_EVALS_BG1_UNIT, all as RS1 does. A filled manifest pins world.json and questions.json of every kept
 * world, lists `kept` in slot order and, once the pilot sets it, `n_final` (30 to 40); a refill only adds files and
 * records the earlier fill's sha256 under `earlier_fills`.
 */
export const BG1_MANIFEST = 'eval/decisions/datasets/bg1-manifest.json';
export const BG1_DEV_ROOT = join(REPO_ROOT, 'eval/data/changing-facts-v1/dev');
export const BG1_FIXTURES_ROOT = join(REPO_ROOT, 'eval/data/changing-facts-v1/fixtures');
/** Renderers that write template text, not a model's: the committed fixtures (changing-facts-gen.ts at BG1_FIXTURE_TOKENS) and render.ts --fake. */
const BG1_TEMPLATE_RENDERERS = ['template', 'fake-template'];
export const BG1_WORLD_FORMAT = 'gbrain-evals/bg1-world/v1';
/** The runner (bg1RunClock) refuses once the wall clock passes the world end by more than this (the plan's F9). */
export const BG1_WORLD_END_SLIP_DAYS = 14;
/** Worlds end on a Sunday (changing-facts-gen.ts BG1_WORLD_END_WEEKDAY), so a world end moves only in whole weeks. */
const BG1_WORLD_END_UTC_DAY = 0;
export const bg1ManifestPath = () => fromHome(process.env.GBRAIN_EVALS_BG1_MANIFEST) ?? join(REPO_ROOT, BG1_MANIFEST);
export interface Bg1Manifest {
  dataset: string; status: 'unfilled' | 'filled'; generator?: string; layout: string; note: string; files: Array<{ path: string; sha256: string }>; filled_at: string | null;
  /** The kept worlds in slot order (filled manifests): the first slots that passed validation. */
  kept?: string[];
  /** The kept set's final size once the pilot sets it (30 to 40); absent while only wave A is kept. */
  n_final?: number;
  /** The sha256 of each earlier fill of this manifest, oldest first (a refill only adds files). */
  earlier_fills?: string[];
}
const bg1Fill = { next: 'ask_user' as const, user_message: 'the custodian fills (or refills) the BG1 manifest from the set root on the custody host: every file bg1ManifestFiles lists, with its SHA-256' };
const bg1Ask = { next: 'ask_user' as const, user_message: 'run bg1 on the custody host with GBRAIN_EVALS_BG1_SOURCE set to the BG1 set root (mint.sh\'s <out>/set; it holds worlds/bg1-<NNN> for the minted slots)' };
const bg1WorldEndAsk = { next: 'ask_user' as const, user_message: 'set GBRAIN_EVALS_BG1_WORLD_END to the world end the campaign\'s dated amendment records (a Sunday, the day before the counted run)' };

/**
 * GBRAIN_EVALS_BG1_UNIT: on a sealed cell's VM, the one launch unit's kept worlds (comma-separated ids) whose files the
 * custodian host pushed. Unset on the custody host. Set, verifyBg1Custody checks exactly those worlds' pinned files and
 * refuses any other world under the root, and loadBg1 opens only those worlds.
 */
export function bg1UnitScope(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.GBRAIN_EVALS_BG1_UNIT;
  if (raw === undefined) return null;
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  const bad = ids.filter(id => !BG1_CONVERSATIONS.includes(id));
  if (!ids.length || bad.length || new Set(ids).size !== ids.length) throw decideError({ code: 'CUSTODY_MISSING', message: `bg1: GBRAIN_EVALS_BG1_UNIT ${JSON.stringify(raw)} is not a list of distinct BG1 world ids`,
    why: 'a sealed cell VM holds exactly one launch unit\'s worlds', fix: bg1Ask });
  return ids;
}

/** The BG1 custody root, refusing when GBRAIN_EVALS_BG1_SOURCE is unset or inside the repository. */
export function bg1Source(env: Record<string, string | undefined> = process.env): string {
  const source = fromHome(env.GBRAIN_EVALS_BG1_SOURCE);
  if (!source) throw decideError({ code: 'CUSTODY_MISSING', message: 'bg1: GBRAIN_EVALS_BG1_SOURCE is not set',
    why: 'every BG1 world is sealed (eval/decisions/splits/bg1.json) and lives only in owner custody; nothing is downloaded', fix: bg1Ask });
  const abs = resolve(source);
  const rel = relative(REPO_ROOT, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw decideError({ code: 'CUSTODY_MISSING', message: `bg1: GBRAIN_EVALS_BG1_SOURCE ${abs} is inside the repository`,
    why: 'sealed files never live where Git could pick them up', fix: bg1Ask });
  return abs;
}

export function readBg1Manifest(path = bg1ManifestPath()): { manifest: Bg1Manifest; sha256: string } {
  const bytes = readFileSync(path);
  return { manifest: JSON.parse(bytes.toString('utf8')) as Bg1Manifest, sha256: sha256(bytes) };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const BG1_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BG1_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The world end, YYYY-MM-DD: `worldEnd` when given, else GBRAIN_EVALS_BG1_WORLD_END. Refuses a missing or malformed
 * date and one that is not a Sunday. The wall clock is the runner's check (bg1RunClock), never the loader's, so a
 * verdict, re-read or judge check of frozen answers resolves the dates their run resolved, whenever it runs.
 */
export function bg1WorldEnd(opts: { worldEnd?: string; env?: Record<string, string | undefined> } = {}): string {
  const raw = opts.worldEnd ?? (opts.env ?? process.env).GBRAIN_EVALS_BG1_WORLD_END;
  const why = 'BG1 worlds store dates as day offsets from a world end that the campaign records; the loader resolves them';
  if (!raw) throw decideError({ code: 'SPEC_MISSING', message: 'bg1: GBRAIN_EVALS_BG1_WORLD_END is not set', why, fix: bg1WorldEndAsk });
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || isoDay(d) !== raw) throw decideError({ code: 'SPEC_INVALID', message: `bg1: world end ${JSON.stringify(raw)} is not a YYYY-MM-DD date`, why, fix: bg1WorldEndAsk });
  if (d.getUTCDay() !== BG1_WORLD_END_UTC_DAY) throw decideError({ code: 'SPEC_INVALID', message: `bg1: world end ${raw} is a ${BG1_WEEKDAYS[d.getUTCDay()]}, not a Sunday`,
    why: 'worlds are planned to end on a Sunday and move only in whole weeks, so every weekday in the text stays right', fix: bg1WorldEndAsk });
  return raw;
}

/**
 * The runner's clock (the preregistration's "Dates and now"): a BG1 cell runs only after its world end, so every
 * session is in the past for a system that reads the wall clock, and at most 14 days past it. Returns the world end.
 */
export function bg1RunClock(opts: { worldEnd?: string; now?: Date; env?: Record<string, string | undefined> } = {}): string {
  const raw = bg1WorldEnd(opts);
  const today = isoDay(opts.now ?? new Date());
  if (today <= raw) throw decideError({ code: 'SPEC_INVALID', message: `bg1: today (${today}) is not after the world end ${raw}`,
    why: 'every question is asked the day after the world end, so a system that reads the wall clock must see every session in the past', fix: bg1WorldEndAsk });
  if (today > plusDays(raw, BG1_WORLD_END_SLIP_DAYS)) throw decideError({ code: 'SPEC_INVALID', message: `bg1: today (${today}) is more than ${BG1_WORLD_END_SLIP_DAYS} days past the world end ${raw}`,
    why: 'a run that slips more than 14 days past the world end regenerates the dates in a dated amendment (the plan\'s F9)', fix: bg1WorldEndAsk });
  return raw;
}

/** Text with every [[D:<offset>]] as "March 3, 2026" and every [[W:<offset>]] as "Tuesday"; refuses a damaged token. */
export function resolveBg1Dates(text: string, worldEnd: string): string {
  const out = text.replace(/\[\[([DW]):(-?\d+)\]\]/g, (_, kind: string, n: string) => {
    const d = new Date(`${plusDays(worldEnd, Number(n))}T00:00:00Z`);
    return kind === 'W' ? BG1_WEEKDAYS[d.getUTCDay()] : `${BG1_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  });
  if (out.includes('[[') || out.includes(']]')) throw new Error('bg1: a text holds a damaged date token');
  return out;
}

interface Bg1WorldFile { schema: string; id: string; sessions: Array<{ id: string; day: number; time: string; turns: Turn[] }> }
interface Bg1QuestionFile { id: string; question: string; answer: string; evidence_sessions: string[]; bg1: Bg1QuestionFields }

/** One world's conversation and questions from its world.json and questions.json text, dates resolved; refuses a malformed file. */
export function bg1Conversation(id: string, worldText: string, questionsText: string, worldEnd: string): { conversation: Conversation; questions: MemoryQuestion[] } {
  const bad = (what: string) => new Error(`bg1: world ${id} ${what}`);
  const w = JSON.parse(worldText) as Bg1WorldFile;
  if (w.schema !== BG1_WORLD_FORMAT || w.id !== id || !Array.isArray(w.sessions) || !w.sessions.length) throw bad(`is not a ${BG1_WORLD_FORMAT} file for ${id}`);
  const ids = new Set<string>();
  let last = '';
  const sessions: Session[] = w.sessions.map(s => {
    if (typeof s.id !== 'string' || ids.has(s.id)) throw bad('repeats or lacks a session id');
    ids.add(s.id);
    if (!Number.isInteger(s.day) || s.day > 0 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw bad(`session ${s.id} has no day at or before the world end, or no HH:MM time`);
    const date = `${plusDays(worldEnd, s.day)}T${s.time}`;
    if (date <= last) throw bad(`session ${s.id} is not after the one before it`);
    last = date;
    if (!Array.isArray(s.turns) || !s.turns.length || s.turns.some(t => (t.speaker !== 'user' && t.speaker !== 'assistant') || typeof t.content !== 'string')) throw bad(`session ${s.id} has a malformed turn`);
    return { id: s.id, date, turns: s.turns.map(t => ({ speaker: t.speaker, content: resolveBg1Dates(t.content, worldEnd) })) };
  });
  const raw = JSON.parse(questionsText) as Bg1QuestionFile[];
  if (!Array.isArray(raw) || !raw.length) throw bad('has no questions');
  const qids = new Set<string>();
  const questions = raw.map(q => {
    if (typeof q.id !== 'string' || qids.has(q.id) || typeof q.question !== 'string' || typeof q.answer !== 'string') throw bad('has a question without a unique id, a question or an answer');
    qids.add(q.id);
    if (!q.bg1 || !BG1_STRATA.includes(q.bg1.stratum)) throw bad(`question ${q.id} has no BG1 stratum`);
    if (!Array.isArray(q.evidence_sessions) || !q.evidence_sessions.length || q.evidence_sessions.some(s => !ids.has(s))) throw bad(`question ${q.id} names an unknown evidence session`);
    const bg1: Bg1QuestionFields = { ...q.bg1, ...(q.bg1.deciding_line !== undefined ? { deciding_line: resolveBg1Dates(q.bg1.deciding_line, worldEnd) } : {}) };
    return { id: q.id, conversation: id, question: resolveBg1Dates(q.question, worldEnd), question_date: plusDays(worldEnd, 1), category: q.bg1.stratum,
      gold: [...q.evidence_sessions], abstention: false, answer: resolveBg1Dates(q.answer, worldEnd), bg1 } satisfies MemoryQuestion;
  });
  return { conversation: { id, sessions }, questions };
}

/** The files one BG1 world is read from, as paths relative to the root; refuses when either is missing. */
export function bg1WorldFiles(root: string, id: string, benchmark: 'bg1' | 'bg1-dev' = 'bg1'): { world: string; questions: string } {
  const known = benchmark === 'bg1' ? BG1_CONVERSATIONS : BG1_DEV_CONVERSATIONS;
  if (!known.includes(id)) throw new Error(`${benchmark} has no world ${id}`);
  const files = { world: `worlds/${id}/world.json`, questions: `worlds/${id}/questions.json` };
  for (const path of Object.values(files)) if (!existsSync(join(root, path))) {
    if (benchmark === 'bg1') throw decideError({ code: 'DATASET_MISSING', message: `bg1: ${path} is not under GBRAIN_EVALS_BG1_SOURCE`, why: 'each BG1 world is a directory holding world.json and questions.json', fix: bg1Ask });
    throw decideError({ code: 'DATASET_MISSING', message: `bg1-dev: ${path} is not under ${root}`,
      why: 'the Gemini-rendered dev worlds are rendered in stage 1 step 1 and committed by a dated amendment; until then only the template fixtures exist, and a paid load refuses them',
      fix: { next: 'ask_user', user_message: 'a paid run waits for the rendered dev worlds (stage 1 step 1); only a keyless run may set GBRAIN_EVALS_BG1_DEV_ROOT to the template fixtures (eval/data/changing-facts-v1/fixtures)' } });
  }
  return files;
}

/** Every file the given worlds (default: every slot) are read from with its SHA-256, the entries a filled manifest holds (bytes are hashed, never parsed). */
export function bg1ManifestFiles(root: string, ids: readonly string[] = BG1_CONVERSATIONS): Array<{ path: string; sha256: string }> {
  return ids.flatMap(id => { const f = bg1WorldFiles(root, id); return [f.world, f.questions]; }).map(path => ({ path, sha256: fileSha256(join(root, path)) }));
}

/**
 * Why a bg1-dev root cannot stand in for stage 1's rendered dev worlds: it resolves to the committed template fixtures,
 * or a world it holds was written by a template renderer (the fixtures' renderer at BG1_FIXTURE_TOKENS, or render.ts
 * --fake); null when neither.
 */
export function bg1DevFixtureProblem(root: string): string | null {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  if (real(root) === real(BG1_FIXTURES_ROOT)) return `${root} is the committed template fixtures (eval/data/changing-facts-v1/fixtures)`;
  const template = BG1_DEV_CONVERSATIONS.flatMap(id => {
    const file = join(root, 'worlds', id, 'world.json');
    if (!existsSync(file)) return [];
    let renderer: unknown;
    try { renderer = (JSON.parse(readFileSync(file, 'utf8')) as { renderer?: unknown }).renderer; } catch { return []; }
    return typeof renderer === 'string' && BG1_TEMPLATE_RENDERERS.includes(renderer) ? [`${id} (renderer ${renderer})`] : [];
  });
  return template.length ? `${root} holds template-rendered worlds: ${template.join(', ')}` : null;
}

/**
 * Load bg1-dev: the public dev worlds (or GBRAIN_EVALS_BG1_DEV_ROOT), dates resolved from the world end. Unless the
 * caller declares the load keyless, a root bg1DevFixtureProblem names refuses before any world is read.
 */
export function loadBg1Dev(opts: { root?: string; only?: ReadonlySet<string>; worldEnd?: string; keyless?: boolean } = {}): Corpus {
  const root = resolve(opts.root ?? fromHome(process.env.GBRAIN_EVALS_BG1_DEV_ROOT) ?? BG1_DEV_ROOT);
  const worldEnd = bg1WorldEnd(opts);
  const unknown = opts.only ? [...opts.only].filter(id => !BG1_DEV_CONVERSATIONS.includes(id)) : [];
  if (unknown.length) throw new Error(`bg1-dev has no world ${unknown.join(', ')}`);
  const fixture = opts.keyless ? null : bg1DevFixtureProblem(root);
  if (fixture) throw decideError({ code: 'DATASET_MISSING', message: `bg1-dev: ${fixture}, and this load is not keyless`,
    why: 'the template fixtures are for keyless runs; a paid cell run, judge check or verdict reads only the dev worlds rendered in stage 1 step 1',
    fix: { next: 'ask_user', user_message: 'unset GBRAIN_EVALS_BG1_DEV_ROOT, or point it at the rendered dev worlds, before a paid bg1-dev load' } });
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  const files: DatasetIdentity['files'] = [];
  for (const id of BG1_DEV_CONVERSATIONS.filter(c => !opts.only || opts.only.has(c))) {
    const f = bg1WorldFiles(root, id, 'bg1-dev');
    const [world, qs] = [f.world, f.questions].map(path => { const bytes = readFileSync(join(root, path)); files.push({ path: relative(REPO_ROOT, join(root, path)), sha256: sha256(bytes) }); return bytes.toString('utf8'); });
    const c = bg1Conversation(id, world, qs, worldEnd);
    conversations.push(c.conversation);
    questions.push(...c.questions);
  }
  return { benchmark: 'bg1-dev', conversations, questions, source: { name: `BG1 changing-facts dev worlds (world end ${worldEnd})`, files, revision: 'repo', license: 'MIT' } };
}

/**
 * Load bg1 (sealed): appends one custody access-log line per world before its files are read. `only` keeps those
 * worlds. With a filled manifest every file must be listed and match; with an unfilled one the files' hashes are
 * recorded in the corpus source and a notice says they were not pinned.
 */
export function loadBg1(custody: { log: string; decisionId: string; purpose: string }, opts: { only?: ReadonlySet<string>; root?: string; manifestPath?: string; worldEnd?: string } = {}): Corpus {
  const root = opts.root ?? bg1Source();
  if (!custody.log) throw decideError({ code: 'CUSTODY_MISSING', message: 'bg1 opens only on the custodian host', why: 'every opening of a sealed set is logged first',
    fix: { next: 'ask_user', user_message: 'request the bg1 cells from the custodian (campaign q1-scoreboard-bg1-changing-facts)' } });
  const unknown = opts.only ? [...opts.only].filter(id => !BG1_CONVERSATIONS.includes(id)) : [];
  if (unknown.length) throw new Error(`bg1 has no world ${unknown.join(', ')}`);
  const scope = bg1UnitScope();
  if (scope && (!opts.only || [...opts.only].some(id => !scope.includes(id)))) throw decideError({ code: 'CUSTODY_MISSING',
    message: `bg1: this VM holds launch unit ${scope.join(', ')} only, and the load asks for ${opts.only ? [...opts.only].filter(id => !scope.includes(id)).join(', ') : 'every world'}`,
    why: 'a sealed cell VM receives and opens only its own unit\'s worlds', fix: bg1Ask });
  const worldEnd = bg1WorldEnd(opts);
  const { manifest, sha256: manifestSha } = readBg1Manifest(opts.manifestPath);
  const pinned = manifest.status === 'filled' ? new Map(manifest.files.map(f => [f.path, f.sha256])) : null;
  const files: DatasetIdentity['files'] = [];
  const read = (path: string) => {
    const bytes = readFileSync(join(root, path));
    const got = sha256(bytes);
    const want = pinned?.get(path);
    if (pinned && got !== want) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: want ? `bg1: ${path} has SHA-256 ${got.slice(0, 12)}, expected ${want.slice(0, 12)}` : `bg1: ${path} is not in the filled manifest`,
      why: 'only the pinned bytes are scored', fix: bg1Fill });
    files.push({ path, sha256: got });
    return bytes.toString('utf8');
  };
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const id of BG1_CONVERSATIONS.filter(c => !opts.only || opts.only.has(c))) {
    const f = bg1WorldFiles(root, id);
    if (pinned) {
      const reading = new Set([f.world, f.questions]);
      const absent = [...pinned.keys()].filter(p => p.startsWith(`worlds/${id}/`) && !reading.has(p));
      if (absent.length) throw decideError({ code: 'DATASET_MISSING', message: `bg1: ${absent.length} file(s) the manifest pins for ${id} are not under GBRAIN_EVALS_BG1_SOURCE`, why: 'a pinned world loads whole or not at all', fix: bg1Ask });
    }
    appendAccessLog(custody.log, { action: 'open', purpose: `bg1 ${id}: ${custody.purpose}`, decision_id: custody.decisionId, labels_sha256: manifestSha, run_sha256: null });
    const c = bg1Conversation(id, read(f.world), read(f.questions), worldEnd);
    conversations.push(c.conversation);
    questions.push(...c.questions);
  }
  if (!pinned) process.stderr.write(`[custody] bg1: the manifest is unfilled, so ${files.length} file(s) loaded without pinned hashes (the custodian fills it with bg1ManifestFiles before a counted run)\n`);
  return { benchmark: 'bg1', conversations, questions,
    source: { name: `BG1 changing-facts set (minted in custody, world end ${worldEnd})`, files: [{ path: BG1_MANIFEST, sha256: manifestSha }, ...files], revision: pinned ? manifestSha.slice(0, 7) : 'unfilled', license: 'custodian-held' } };
}

/**
 * The custodian's kept list from a filled manifest: slot ids in strictly increasing slot order, each with both of its
 * files pinned, at most n_final of them. Refuses an unfilled manifest, a kept id outside the 48 slots and a kept id the
 * manifest does not pin, so a cell never runs a world the custodian did not keep and hash.
 */
export function bg1Kept(manifest: Bg1Manifest): { kept: string[]; n_final: number | null } {
  const bad = (message: string) => decideError({ code: 'DATASET_MISSING', message: `bg1: ${message}`, why: 'BG1 cells run only on the custodian\'s kept list, checked against the filled manifest', fix: bg1Fill });
  if (manifest.status !== 'filled') throw bad('the manifest is unfilled, so it has no kept list');
  const kept = manifest.kept;
  if (!Array.isArray(kept) || !kept.length) throw bad('the filled manifest has no kept list');
  const outside = kept.filter(id => !BG1_CONVERSATIONS.includes(id));
  if (outside.length) throw bad(`kept ${outside.join(', ')} is not one of the ${BG1_CONVERSATIONS.length} mint slots`);
  if (kept.some((id, i) => i > 0 && !(kept[i - 1] < id))) throw bad('the kept list is not in strictly increasing slot order');
  const unpinned = kept.filter(id => ['world.json', 'questions.json'].some(f => !manifest.files.some(x => x.path === `worlds/${id}/${f}`)));
  if (unpinned.length) throw bad(`kept ${unpinned.join(', ')} has no pinned world or questions file in the filled manifest`);
  const n = manifest.n_final ?? null;
  if (n !== null && !(Number.isInteger(n) && n >= BG1_N_FLOOR && n <= BG1_N_CAP && kept.length <= n)) throw bad(`n_final ${n} must be a whole number from ${BG1_N_FLOOR} to ${BG1_N_CAP}, at least the kept list's ${kept.length}`);
  return { kept: [...kept], n_final: n };
}

/**
 * The worlds of one BG1 launch unit: kept worlds unit x perUnit to (unit + 1) x perUnit - 1. A unit runs only once all
 * of its worlds are kept; the last unit may be partial once n_final says the list is complete.
 */
export function bg1UnitConversations(manifest: Bg1Manifest, unit: number, perUnit: number): string[] {
  if (!Number.isInteger(unit) || unit < 0 || !Number.isInteger(perUnit) || perUnit < 1) throw new Error(`bg1: launch unit ${unit} of ${perUnit} world(s) is not a whole unit`);
  const { kept, n_final } = bg1Kept(manifest);
  const slice = kept.slice(unit * perUnit, (unit + 1) * perUnit);
  const complete = n_final !== null && kept.length === n_final;
  if (!slice.length || (slice.length < perUnit && !complete)) throw decideError({ code: 'DATASET_MISSING',
    message: `bg1: launch unit ${unit} needs kept worlds ${unit * perUnit + 1} to ${(unit + 1) * perUnit}, and the kept list holds ${kept.length}${complete ? ' (final)' : ''}`,
    why: 'a launch unit runs whole: its kept worlds in slot order, the last unit partial only once n_final completes the list', fix: bg1Fill });
  return slice;
}

/** `decide fetch` for bg1: nothing is downloaded; every file the filled manifest pins (the unit's, on a cell VM) must be under the custody root with its hash. */
export function verifyBg1Custody(log: (s: string) => void = s => process.stderr.write(s + '\n')): number {
  const root = bg1Source();
  const { manifest } = readBg1Manifest();
  if (manifest.status !== 'filled') throw decideError({ code: 'CUSTODY_MISSING', message: 'bg1: the manifest has no hashes yet', why: 'only pinned bytes are verified', fix: bg1Fill });
  const scope = bg1UnitScope();
  let files = manifest.files;
  if (scope) {
    const { kept } = bg1Kept(manifest);
    const notKept = scope.filter(id => !kept.includes(id));
    if (notKept.length) throw decideError({ code: 'DATASET_MISSING', message: `bg1: GBRAIN_EVALS_BG1_UNIT names ${notKept.join(', ')}, which the filled manifest does not keep`, why: 'a unit runs only kept worlds', fix: bg1Fill });
    const present = existsSync(join(root, 'worlds')) ? readdirSync(join(root, 'worlds')).sort() : [];
    const extra = present.filter(d => !scope.includes(d));
    if (extra.length) throw decideError({ code: 'CUSTODY_MISSING', message: `bg1: the custody root holds ${extra.length} world(s) outside launch unit ${scope.join(', ')}`,
      why: 'a sealed cell VM receives only its own unit\'s pinned files', fix: bg1Ask });
    files = manifest.files.filter(f => scope.includes(f.path.split('/')[1]));
  }
  for (const f of files) {
    const abs = join(root, f.path);
    if (!existsSync(abs)) throw decideError({ code: 'DATASET_MISSING', message: `bg1: ${f.path} is not under GBRAIN_EVALS_BG1_SOURCE`, why: 'every pinned file must be present', fix: bg1Ask });
    const got = fileSha256(abs);
    if (got !== f.sha256) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `bg1: ${f.path} has SHA-256 ${got.slice(0, 12)}, expected ${f.sha256.slice(0, 12)}`, why: 'only the pinned bytes are scored', fix: bg1Fill });
  }
  log(`[custody] bg1: ${files.length} file(s) match their pinned sha256 under GBRAIN_EVALS_BG1_SOURCE${scope ? ` (launch unit ${scope.join(', ')})` : ''}`);
  return files.length;
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

/** `only` restricts LoCoMo, BEAM, D8, RS1 and BG1 to those conversations (a split), so a BEAM, D8, RS1 or BG1 conversation outside it is never read. `keyless` declares a bg1-dev load keyless (loadBg1Dev). */
export function loadCorpus(benchmark: string, corpusFile?: string, only?: ReadonlySet<string>, opts: { keyless?: boolean } = {}): Corpus {
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
    case 'beam-d8': {
      d8Source();
      const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
      if (!log) throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-d8 questions open only on the custodian host',
        why: 'all ten D8 conversations are sealed (eval/decisions/splits/beam-d8.json); every opening is logged', fix: { next: 'ask_user', user_message: 'request the beam-d8 cells from the custodian (decision q1-scoreboard)' } });
      return loadD8({ log, decisionId: process.env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard', purpose: 'memory-qa loadCorpus beam-d8' }, { only });
    }
    case 'beam-rs1': {
      rs1Source();
      const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
      if (!log) throw decideError({ code: 'CUSTODY_MISSING', message: 'beam-rs1 questions open only on the custodian host',
        why: 'every RS1 conversation is sealed (eval/decisions/splits/beam-rs1.json); every opening is logged', fix: { next: 'ask_user', user_message: 'request the beam-rs1 cells from the custodian (decision q1-scoreboard)' } });
      return loadRs1({ log, decisionId: process.env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard', purpose: 'memory-qa loadCorpus beam-rs1' }, { only });
    }
    case 'bg1-dev': return loadBg1Dev({ only, keyless: opts.keyless });
    case 'bg1': {
      bg1Source();
      const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
      if (!log) throw decideError({ code: 'CUSTODY_MISSING', message: 'bg1 questions open only on the custodian host',
        why: 'every BG1 world is sealed (eval/decisions/splits/bg1.json); every opening is logged', fix: { next: 'ask_user', user_message: 'request the bg1 cells from the custodian (campaign q1-scoreboard-bg1-changing-facts)' } });
      return loadBg1({ log, decisionId: process.env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard-bg1-changing-facts', purpose: 'memory-qa loadCorpus bg1' }, { only });
    }
    case 'fixture': return loadFixture();
    default: throw new Error(`unknown benchmark ${benchmark}`);
  }
}

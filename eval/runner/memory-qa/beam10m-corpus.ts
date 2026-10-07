/**
 * BEAM-10M corpus loader, corpus side only (Q1 PLAN §4.2, §4.8.6, §4.8.10).
 *
 * This module turns BEAM chat files into dated sessions and reads nothing
 * else: it knows only the manifest's `chat_path` and `chat_sha256` fields and
 * imports nothing that reads evaluator files, so it cannot open a BEAM-10M
 * question file (test/eval/q1-beam10m.test.ts checks its import graph and
 * runs it with the question files unreadable). The custodian's question
 * loader lives in beam10m-questions.ts.
 *
 * Shapes. BEAM-10M's `chat` (Hugging Face `Mohammadta/BEAM-10M`, and the
 * BEAM repository's `chats/10M/<n>/chat.json`) is a list with one entry per
 * plan, `{ "plan-<k>": [batch, ...] }`; a parquet export also carries the
 * other plans' keys as null. A batch is `{ turns, batch_number?, time_anchor? }`
 * whose `turns` are turn groups (lists of messages) or, in a flattened export,
 * bare messages. BEAM 100K to 1M chat files are a list of batches without
 * plans; both shapes load here.
 *
 * Sessions (preregistered fallback, §4.8.6):
 *   - each turn group is one session (`p<k>-b<batch>-g<group>`, or
 *     `b<batch>-g<group>` without plans, the ids loadBeam gives 1M);
 *   - a batch whose turns are bare messages gets sessions synthesized at
 *     message-pair boundaries (a new session at every user message,
 *     `...-s<n>`), so `source_chat_ids` still map message ids to sessions;
 *   - dates: a group's own `time_anchor`, else its batch's (the batch field or
 *     the first anchored message, as BEAM dates a batch once). If any session
 *     is still undated or an anchor does not parse, every session of the
 *     conversation gets the one disclosed synthetic monotone sequence
 *     (`SYNTHETIC_DATES`), identical for every system.
 * BEAM's `->-> batch,bullet` plan markers are stripped from message text.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname, homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { decideError } from '../decisions/errors.ts';
import type { Conversation, DatasetIdentity, Session } from './corpus.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const BEAM10M_MANIFEST = 'eval/decisions/datasets/beam-10m-9b20961.json';
const datasetRoot = () => process.env.GBRAIN_EVALS_DATASETS ?? join(homedir(), 'datasets', 'gbrain-evals');
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The corpus side of the manifest: the only fields this module reads. */
export interface Beam10mCorpusManifest {
  revision: string;
  license: string;
  status: string;
  conversations: Array<{ conversation: string; chat_path: string; chat_sha256: string | null }>;
}

export function beam10mCorpusManifest(path = join(REPO_ROOT, BEAM10M_MANIFEST)): Beam10mCorpusManifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Beam10mCorpusManifest;
  return { revision: m.revision, license: m.license, status: m.status, conversations: m.conversations.map(c => ({ conversation: c.conversation, chat_path: c.chat_path, chat_sha256: c.chat_sha256 })) };
}

/** The synthetic date of the k-th session (0-based) when a conversation's own dates are incomplete: one hour apart from 2024-01-01T00:00. */
export const SYNTHETIC_DATES = { base: '2024-01-01T00:00:00Z', step_minutes: 60, rule: 'session k (0-based, data order) is base + k hours' } as const;
export const syntheticDate = (k: number) => new Date(Date.parse(SYNTHETIC_DATES.base) + k * SYNTHETIC_DATES.step_minutes * 60_000).toISOString().slice(0, 19);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A BEAM `time_anchor` ("March-15-2024", "March 15, 2024", "15 March 2024", "2024-03-15") as ISO midnight, or null. */
export function parseAnchor(raw: string): string | null {
  const a = raw.trim().replace(/[_,-]/g, ' ').replace(/\s+/g, ' ');
  const iso = /^(\d{4}) (\d{1,2}) (\d{1,2})$/.exec(a);
  const mdy = /^([A-Za-z]+)\.? (\d{1,2}) (\d{4})$/.exec(a);
  const dmy = /^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})$/.exec(a);
  const month = (name: string) => MONTHS.findIndex(m => m === name.toLowerCase() || (name.length >= 3 && m.startsWith(name.toLowerCase())));
  const [y, mo, d] = iso ? [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])] : mdy ? [Number(mdy[3]), month(mdy[1]), Number(mdy[2])] : dmy ? [Number(dmy[3]), month(dmy[2]), Number(dmy[1])] : [0, -1, 0];
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, mo, d));
  return t.getUTCMonth() === mo ? `${y}-${pad(mo + 1)}-${pad(d)}T00:00:00` : null;
}

const MARKER = /\s*->->\s*(?:\d+|N\/A)(?:\s*,\s*(?:\d+|N\/A))*\s*$/;

interface Message { role?: string; id?: number | null; content?: string; time_anchor?: string | null }
interface Batch { plan: number | null; number: number; time_anchor: string | null; turns: unknown[] }

export interface BeamStructure {
  conversation: string;
  shape: 'plans' | 'batches';
  plans: number;
  batches: number;
  turn_groups: number;
  groups_with_time_anchor: number;
  batches_with_time_anchor: number;
  messages: number;
  messages_without_id: number;
  /** Message ids that occur more than once in the conversation (a plan restarting its ids). */
  duplicate_message_ids: number;
  sessions: number;
  synthesized_sessions: number;
  date_source: 'anchor' | 'synthetic';
  sessions_with_own_anchor: number;
  sessions_with_batch_anchor: number;
  sessions_without_anchor: number;
  unparseable_anchors: number;
  /** Whether anchored dates never go backwards in data order; null when synthetic. */
  anchors_monotone: boolean | null;
}

const isMessage = (x: unknown): x is Message => !!x && typeof x === 'object' && !Array.isArray(x) && 'role' in x;

/** Batches in data order, from either chat shape. */
function batchesOf(chat: unknown[]): { shape: BeamStructure['shape']; plans: number; batches: Batch[] } {
  const batches: Batch[] = [];
  const planNumbers = new Set<number>();
  const asBatch = (b: Record<string, unknown>, plan: number | null, position: number): Batch => ({
    plan, number: typeof b.batch_number === 'number' ? b.batch_number : position + 1,
    time_anchor: typeof b.time_anchor === 'string' && b.time_anchor ? b.time_anchor : null, turns: Array.isArray(b.turns) ? b.turns : [],
  });
  const planEntry = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x) && !('turns' in x) && Object.keys(x).some(k => /^plan-\d+$/.test(k));
  if (chat.some(planEntry)) {
    for (const entry of chat) {
      if (!planEntry(entry)) throw new Error('a BEAM-10M chat mixes plan entries with other entries');
      const plans = Object.entries(entry as Record<string, unknown>).filter(([k, v]) => /^plan-\d+$/.test(k) && Array.isArray(v)).sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5)));
      for (const [k, list] of plans) {
        const plan = Number(k.slice(5));
        planNumbers.add(plan);
        (list as unknown[]).forEach((b, i) => { if (b && typeof b === 'object') batches.push(asBatch(b as Record<string, unknown>, plan, i)); });
      }
    }
    return { shape: 'plans', plans: planNumbers.size, batches };
  }
  chat.forEach((b, i) => {
    if (!b || typeof b !== 'object' || Array.isArray(b) || !('turns' in b)) throw new Error(`chat entry ${i} is neither a plan entry nor a batch`);
    batches.push(asBatch(b as Record<string, unknown>, null, i));
  });
  return { shape: 'batches', plans: 0, batches };
}

/**
 * Sessions of one BEAM conversation with the §4.8.6 fallbacks, and the
 * structure counts that say which fallback applied. `sessionsOfMessage` maps
 * each message id to every session holding it (more than one only when ids
 * repeat across plans).
 */
export function beamChatSessions(conversation: string, chat: unknown, opts: { dates?: 'auto' | 'synthetic' } = {}): { sessions: Session[]; sessionsOfMessage: Map<number, string[]>; structure: BeamStructure } {
  if (!Array.isArray(chat)) throw new Error(`${conversation}: chat is not a list`);
  const { shape, plans, batches } = batchesOf(chat);
  const sessions: Array<Session & { anchor: 'own' | 'batch' | null; rawAnchor: string | null }> = [];
  const sessionsOfMessage = new Map<number, string[]>();
  let turnGroups = 0, groupsAnchored = 0, batchesAnchored = 0, messages = 0, withoutId = 0, synthesized = 0;
  const seen = new Map<number, number>();
  const take = (id: string, msgs: Message[], batchAnchor: string | null) => {
    const own = msgs.find(m => typeof m.time_anchor === 'string' && m.time_anchor)?.time_anchor ?? null;
    for (const m of msgs) {
      messages++;
      if (typeof m.id === 'number') { seen.set(m.id, (seen.get(m.id) ?? 0) + 1); sessionsOfMessage.set(m.id, [...(sessionsOfMessage.get(m.id) ?? []), id]); } else withoutId++;
    }
    sessions.push({ id, turns: msgs.map(m => ({ speaker: String(m.role ?? 'unknown'), content: String(m.content ?? '').replace(MARKER, ''), ...(typeof m.id === 'number' ? { message_ids: [m.id] } : {}) })),
      anchor: own ? 'own' : batchAnchor ? 'batch' : null, rawAnchor: own ?? batchAnchor });
  };
  for (const b of batches) {
    const prefix = `${b.plan === null ? '' : `p${b.plan}-`}b${b.number}`;
    const firstAnchor = b.turns.flatMap(t => Array.isArray(t) ? t : [t]).find((m): m is Message => isMessage(m) && typeof m.time_anchor === 'string' && !!m.time_anchor)?.time_anchor ?? null;
    const batchAnchor = b.time_anchor ?? firstAnchor;
    if (batchAnchor) batchesAnchored++;
    const groups = b.turns.filter(Array.isArray) as unknown[][];
    if (groups.length && groups.length === b.turns.length) {
      groups.forEach((g, gi) => {
        const msgs = g.filter(isMessage);
        turnGroups++;
        if (msgs.some(m => typeof m.time_anchor === 'string' && m.time_anchor)) groupsAnchored++;
        take(`${prefix}-g${gi}`, msgs, batchAnchor);
      });
      continue;
    }
    const flat = b.turns.flatMap(t => Array.isArray(t) ? t : [t]).filter(isMessage);
    let current: Message[] = [];
    let n = 0;
    const flush = () => { if (current.length) { take(`${prefix}-s${n++}`, current, batchAnchor); synthesized++; current = []; } };
    for (const m of flat) { if (m.role === 'user' && current.some(x => x.role === 'user')) flush(); current.push(m); }
    flush();
  }
  const parsed = sessions.map(s => s.rawAnchor ? parseAnchor(s.rawAnchor) : null);
  const unparseable = sessions.filter((s, i) => s.rawAnchor && !parsed[i]).length;
  const anchored = opts.dates !== 'synthetic' && sessions.length > 0 && parsed.every(Boolean);
  const dates = anchored ? parsed as string[] : sessions.map((_, k) => syntheticDate(k));
  const structure: BeamStructure = {
    conversation, shape, plans, batches: batches.length, turn_groups: turnGroups, groups_with_time_anchor: groupsAnchored, batches_with_time_anchor: batchesAnchored,
    messages, messages_without_id: withoutId, duplicate_message_ids: [...seen.values()].filter(c => c > 1).length,
    sessions: sessions.length, synthesized_sessions: synthesized, date_source: anchored ? 'anchor' : 'synthetic',
    sessions_with_own_anchor: sessions.filter(s => s.anchor === 'own').length, sessions_with_batch_anchor: sessions.filter(s => s.anchor === 'batch').length,
    sessions_without_anchor: sessions.filter(s => !s.anchor).length, unparseable_anchors: unparseable,
    anchors_monotone: anchored ? dates.every((d, i) => i === 0 || d >= dates[i - 1]) : null,
  };
  return { sessions: sessions.map(({ anchor: _a, rawAnchor: _r, ...s }, i) => ({ ...s, date: dates[i] })), sessionsOfMessage, structure };
}

export interface Beam10mCorpus {
  benchmark: 'beam-10m';
  conversations: Conversation[];
  /** Message id to sessions per conversation, for the custodian's gold mapping. */
  sessionsOfMessage: Map<string, Map<number, string[]>>;
  structure: BeamStructure[];
  source: DatasetIdentity;
}

/** Append one custody access-log line (the sealed-confirmation log format). */
function logAccess(log: string, entry: { action: 'open'; purpose: string; decision_id: string | null; labels_sha256: string; run_sha256: null }) {
  mkdirSync(dirname(log), { recursive: true });
  let operator = 'unknown';
  try { operator = userInfo().username; } catch { /* no user database */ }
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), operator, host: hostname(), ...entry }) + '\n');
}

/**
 * Load BEAM-10M conversations from their corpus files only. Refuses while
 * the manifest is unfilled, on a missing file and on a hash mismatch. With
 * `log`, each opening is appended to the custody access log first.
 */
export function loadBeam10mCorpus(opts: { only?: ReadonlySet<string>; manifestPath?: string; root?: string; log?: string; dates?: 'auto' | 'synthetic' } = {}): Beam10mCorpus {
  const manifestPath = opts.manifestPath ?? join(REPO_ROOT, BEAM10M_MANIFEST);
  const m = beam10mCorpusManifest(manifestPath);
  const root = opts.root ?? datasetRoot();
  const fill = ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch', '--write'];
  const conversations: Conversation[] = [];
  const sessionsOfMessage = new Map<string, Map<number, string[]>>();
  const structure: BeamStructure[] = [];
  const files: DatasetIdentity['files'] = [];
  for (const c of m.conversations.filter(x => !opts.only || opts.only.has(x.conversation))) {
    if (!c.chat_sha256) throw decideError({ code: 'NOT_YET_AVAILABLE', message: `beam-10m: the manifest has no hash for ${c.conversation} yet`,
      why: 'the custodian fills the BEAM-10M manifest on the custody host; until then no corpus file is pinned', fix: { next: 'tell_user_to_run', argv: fill, user_message: 'the custodian fills the manifest once, then commits it' } });
    const path = join(root, c.chat_path);
    if (!existsSync(path)) throw decideError({ code: 'DATASET_MISSING', message: `beam-10m: ${path} is not on this machine`,
      why: 'BEAM-10M corpus files exist only on the custody host', fix: { next: 'tell_user_to_run', argv: fill, user_message: 'run BEAM-10M work on the custody host' } });
    if (opts.log) logAccess(opts.log, { action: 'open', purpose: `beam-10m corpus ${c.conversation} (no questions)`, decision_id: process.env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard', labels_sha256: c.chat_sha256, run_sha256: null });
    const bytes = readFileSync(path);
    const got = sha256(bytes);
    if (got !== c.chat_sha256) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `beam-10m: ${c.chat_path} has SHA-256 ${got.slice(0, 12)}, expected ${c.chat_sha256.slice(0, 12)}`,
      why: 'only the pinned bytes are loaded', fix: { next: 'tell_user_to_run', argv: [...fill.slice(0, 3)], user_message: 're-extract the pinned revision on the custody host' } });
    const raw = JSON.parse(bytes.toString('utf8')) as { chat?: unknown };
    const s = beamChatSessions(c.conversation, raw.chat, { dates: opts.dates });
    conversations.push({ id: c.conversation, sessions: s.sessions });
    sessionsOfMessage.set(c.conversation, s.sessionsOfMessage);
    structure.push(s.structure);
    files.push({ path: c.chat_path, sha256: got });
  }
  return { benchmark: 'beam-10m', conversations, sessionsOfMessage, structure,
    source: { name: 'BEAM-10M (corpus files)', files: [{ path: BEAM10M_MANIFEST, sha256: sha256(readFileSync(manifestPath)) }, ...files], revision: m.revision.slice(0, 7), license: m.license } };
}

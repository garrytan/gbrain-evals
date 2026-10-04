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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { decideError } from '../decisions/errors.ts';

export interface Turn { speaker: string; content: string; message_ids?: number[] }
export interface Session { id: string; date?: string; turns: Turn[] }
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

export function renderSessionPage(session: Session): string {
  const fm = ['---', 'type: note'];
  if (session.date) fm.push(`date: ${JSON.stringify(session.date)}`);
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

interface BeamManifest {
  commit: string; raw_base: string; license: string;
  sizes: Record<string, Array<{ conversation: string; chat_path: string; chat_sha256: string; questions_path: string; questions_sha256: string }>>;
}
export function beamManifest(): BeamManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'eval/decisions/datasets/beam-b2da22e.json'), 'utf8'));
}

export function beamFiles(size: string): DatasetFile[] {
  const m = beamManifest();
  const convs = m.sizes[size];
  if (!convs) throw new Error(`BEAM size ${size} is not in the manifest`);
  return convs.flatMap(c => [
    { path: `beam/${c.chat_path}`, url: m.raw_base + c.chat_path, sha256: c.chat_sha256 },
    { path: `beam/${c.questions_path}`, url: m.raw_base + c.questions_path, sha256: c.questions_sha256 },
  ]);
}

export function filesFor(benchmark: string): DatasetFile[] {
  switch (benchmark) {
    case 'locomo': return [LOCOMO_FILE];
    case 'lme-s': return [LME_S_FILE];
    case 'beam-100k': return beamFiles('100k');
    case 'beam-1m': return beamFiles('1m');
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

export async function fetchDataset(benchmark: string, opts: { force?: boolean; verifyOnly?: boolean; log?: (s: string) => void } = {}): Promise<{ fetched: number; verified: number }> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s + '\n'));
  let fetched = 0; let verified = 0;
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  for (const f of filesFor(benchmark)) {
    const path = join(DATASET_ROOT, f.path);
    const ok = existsSync(path) && sha256(readFileSync(path)) === f.sha256;
    if (ok && !opts.force) { verified++; continue; }
    if (opts.verifyOnly) throw decideError({ code: existsSync(path) ? 'DATASET_HASH_MISMATCH' : 'DATASET_MISSING', message: `${benchmark}: ${f.path} is ${existsSync(path) ? 'not the pinned bytes' : 'missing'}`,
      why: 'verification found a file that the run would refuse', fix: { next: 'run', argv: [...fetchArgv(benchmark), '--force'] } });
    log(`[fetch] ${f.url}`);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${f.url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = sha256(bytes);
    if (got !== f.sha256) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `${f.url} returned SHA-256 ${got.slice(0, 12)}, expected ${f.sha256.slice(0, 12)}`,
      why: 'the upstream bytes changed or the download was corrupted; the kit will not score unpinned data', fix: { next: 'report', user_message: 'upstream dataset bytes changed; a new pin needs review' } });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    fetched++; verified++;
  }
  return { fetched, verified };
}

// ─── Loaders ────────────────────────────────────────────────────────

const LOCOMO_CATEGORY: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

export function loadLocomo(): Corpus {
  const raw = JSON.parse(readDatasetFile(LOCOMO_FILE, 'locomo')) as Array<{ sample_id: string; conversation: Record<string, unknown>; qa: Array<{ question: string; category: number; evidence?: string[] }> }>;
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const sample of raw) {
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
        category: LOCOMO_CATEGORY[q.category] ?? `cat${q.category}`, gold: q.category === 5 ? [] : [...gold], abstention: q.category === 5 });
    });
  }
  return { benchmark: 'locomo', conversations, questions, source: { name: 'LoCoMo (locomo10.json)', files: [{ path: LOCOMO_FILE.path, sha256: LOCOMO_FILE.sha256 }], revision: '3eb6f2c', license: 'CC BY-NC 4.0' } };
}

export function loadLmeS(): Corpus {
  const raw = JSON.parse(readDatasetFile(LME_S_FILE, 'lme-s')) as Array<{
    question_id: string; question_type: string; question: string; question_date?: string;
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
      category: q.question_type, gold: abstention ? [] : [...q.answer_session_ids], abstention });
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

export function loadBeam(size: '100k' | '1m'): Corpus {
  const m = beamManifest();
  const conversations: Conversation[] = [];
  const questions: MemoryQuestion[] = [];
  for (const c of m.sizes[size]) {
    const chat = JSON.parse(readDatasetFile({ path: `beam/${c.chat_path}`, url: m.raw_base + c.chat_path, sha256: c.chat_sha256 }, `beam-${size}`)) as
      Array<{ batch_number: number; time_anchor?: string | null; turns: Array<Array<{ role: string; id: number; content: string; time_anchor?: string }>> }>;
    const sessions: Session[] = [];
    const sessionOfMessage = new Map<number, string>();
    for (const batch of chat) {
      batch.turns.forEach((group, gi) => {
        const id = `b${batch.batch_number}-g${gi}`;
        const date = group.find(msg => msg.time_anchor)?.time_anchor ?? batch.time_anchor ?? undefined;
        for (const msg of group) sessionOfMessage.set(msg.id, id);
        sessions.push({ id, date: date ?? undefined, turns: group.map(msg => ({ speaker: msg.role, content: msg.content.replace(MARKER, ''), message_ids: [msg.id] })) });
      });
    }
    conversations.push({ id: c.conversation, sessions });
    const pq = JSON.parse(readDatasetFile({ path: `beam/${c.questions_path}`, url: m.raw_base + c.questions_path, sha256: c.questions_sha256 }, `beam-${size}`)) as
      Record<string, Array<{ question: string; source_chat_ids?: unknown }>>;
    for (const [ability, items] of Object.entries(pq)) {
      items.forEach((item, i) => {
        const gold = [...new Set(messageIds(item.source_chat_ids).map(id => sessionOfMessage.get(id)).filter((s): s is string => !!s))];
        const abstention = ability === 'abstention';
        questions.push({ id: `${c.conversation}:${ability}:${i}`, conversation: c.conversation, question: item.question, category: ability, gold: abstention ? [] : gold, abstention });
      });
    }
  }
  return { benchmark: `beam-${size}`, conversations, questions, source: { name: `BEAM ${size}`, files: [{ path: 'eval/decisions/datasets/beam-b2da22e.json', sha256: sha256(readFileSync(join(REPO_ROOT, 'eval/decisions/datasets/beam-b2da22e.json'))) }], revision: m.commit.slice(0, 7), license: m.license } };
}

export const FIXTURE_PATH = join(REPO_ROOT, 'eval/data/decide-fixture/conversations.json');

export function loadFixture(): Corpus {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { conversations: Conversation[]; questions: MemoryQuestion[] };
  return { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'decide fixture (invented)', files: [{ path: 'eval/data/decide-fixture/conversations.json', sha256: sha256(readFileSync(FIXTURE_PATH)) }], revision: 'repo', license: 'MIT' } };
}

export function loadCorpus(benchmark: string): Corpus {
  switch (benchmark) {
    case 'locomo': return loadLocomo();
    case 'lme-s': return loadLmeS();
    case 'beam-100k': return loadBeam('100k');
    case 'beam-1m': return loadBeam('1m');
    case 'fixture': return loadFixture();
    default: throw new Error(`unknown benchmark ${benchmark}`);
  }
}

/**
 * BrainBench N7: open loops on Gmail-shaped threads (wave amendment 8, the
 * mechanics arm).
 *
 * The world comes from eval/generators/n7-gmail-loops-gen.ts: a seeded ledger
 * of threads with known loop state at a pinned now, plus multi-round store
 * scenarios. The runner:
 *
 *   1. renders every ledger thread as raw Gmail API JSON and parses it with
 *      gbrain's own GmailClient.getThread through a stub fetch, so From
 *      normalization, quoted-reply trimming, List-Unsubscribe and the
 *      text/calendar METHOD stamp all run as in a real sync;
 *   2. judges each parsed thread with detectThreadLoop at the pinned now and
 *      scores the verdict against the documented-rule oracle (generator);
 *   3. replays store scenarios on in-memory PGLite through
 *      applyThreadLoopVerdict (pinned now per round), loops_close, loops_mute
 *      and open_loops: closure on reply, acknowledgement closure, nudge hold,
 *      calendar hold, manual close and re-sync, mute, turn flip;
 *   4. checks open_loops redaction for a remote caller against a trusted
 *      control;
 *   5. runs ranking conformance checks with an in-process clock override
 *      (gbrain ranks with Date.now(); there is no clock parameter);
 *   6. renders the 25 amara-life-v1 threads (addresses pseudonymized) as
 *      exploratory background;
 *   7. reports the semantic labels (someone still waiting, promise made,
 *      promise fulfilled) beside the mechanics verdicts, never mapped onto
 *      them, and records that the commitment extractor refuses keyless.
 *
 * Verdict = safety contracts and quality thresholds preregistered in
 * eval/registry.ts (open-loops-email). Contested rule readings (nudge and
 * follow-up on first sight, a question mark inside a link) are reported, not
 * gated. A gbrain exception where a verdict is expected is a scored miss; a
 * failed presence assertion is a harness error.
 *
 * Hermetic: provider keys stripped, fresh GBRAIN_HOME, System One off.
 *
 * Paid extractor arm (preregistered in
 * docs/plans/2026-10-01-eval-category-wave/prereg-n7-extractor-arm.md): with
 * `--paid --budget-run-id <id>` the runner instead renders the promise and
 * control threads with gbrain's renderThreadPage and runs runLoopsExtract
 * through gbrain's gateway (default chat model, key passed in gateway config
 * only), then scores promise recall, due dates, fulfilled-promise suppression
 * and the fulfillment replay. It never gates.
 *
 * Usage: bun eval/runner/n7-open-loops-email.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]] [--json] [--record-bugs]
 *        bun eval/runner/n7-open-loops-email.ts --paid --budget-run-id <id> [--output <dir>] [--gbrain <checkout>[@ref]]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { WAVE_BUG_LEDGER, upsertBug, type BugEntry } from './bug-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { paidRequested, requirePaidArm } from './paid-arm.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  CONTESTED_CLASSES, EXCLUDED_CLASSES, MY_ADDRESSES, N7_DEFAULT_SEED, N7_GENERATOR_VERSION, N7_NOW_ISO, generateN7World, mechanicsOracle, n7RulesFor,
  type LedgerMessage, type LedgerThread, type LoopType, type MechanicsGold, type StoreScenario, type ThreadClass,
} from '../generators/n7-gmail-loops-gen.ts';

export const CATEGORY = 'n7-open-loops-email';
const SOURCE_ID = 'n7-google';
const RANK_SOURCE_ID = 'n7-rank';
const H = 3_600_000;

/** gbrain internals this category imports (receipts list them, plan section 8). */
export const ENTRY_POINTS = [
  'src/core/google/google-clients.ts GmailClient.getThread (stub fetch)',
  'src/core/google/loop-detect.ts detectThreadLoop, applyThreadLoopVerdict, __clearSuppressionCacheForTests',
  'src/core/loops/loops-store.ts upsertOpenLoop (ranking fixtures)',
  'src/core/google/google-render.ts renderThreadPage',
  'src/core/google/loops-extract.ts runLoopsExtract (keyless refusal only)',
  'operations: open_loops, loops_close, loops_mute',
] as const;

export const UNSUPPORTED: ReadonlyArray<{ feature: string; reason: string }> = [
  { feature: 'Slack and calendar commitments', reason: 'no product path: connectors are chatgpt and claude only, and calendar mail is excluded from loops by design (capability matrix N7). Recorded as a feature gap.' },
  { feature: 'promise fulfillment', reason: 'the LLM extractor upserts commitments and never marks a stored one fulfilled; the guide calls fulfillment-by-reply future work. Labeled separately in data.semantic and recorded as a feature gap, never scored as a detector miss.' },
  { feature: 'commitment extraction quality', reason: 'runLoopsExtract needs a chat model; keyless it throws llm_unavailable. Measured only in a paid arm.' },
  { feature: 'ranking quality', reason: 'no independently assigned priorities exist; ranking is checked for conformance (determinism under a shifted clock, monotonicity) only.' },
  { feature: 'a pinned clock for ranking, staleness and close timestamps', reason: 'open_loops ranks with Date.now(); opened_at, closed_at and staleness use the database clock. The runner overrides Date.now in process for the ranking checks and never scores a stored timestamp.' },
  { feature: 'real Google sync', reason: 'threads enter through GmailClient.getThread with a stub fetch; OAuth, history paging and sync scheduling are not exercised.' },
];

// ─── Raw Gmail rendering (harness) ───────────────────────────────────────

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** One ledger message as the Gmail API returns it with format=full. */
export function rawGmailMessage(m: LedgerMessage, threadId: string, nowMs: number): Record<string, unknown> {
  const body = m.quoted ? `${m.own_text}\n\n${m.quoted}` : m.own_text;
  const headers = [
    { name: 'From', value: m.from },
    { name: 'To', value: m.to.join(', ') },
    ...(m.cc.length ? [{ name: 'Cc', value: m.cc.join(', ') }] : []),
    { name: 'Subject', value: m.subject },
    ...(m.kind === 'list' ? [{ name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.org>' }] : []),
  ];
  const textPart = { partId: '0', mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { data: b64url(body), size: body.length } };
  const parts = m.kind === 'calendar'
    ? [textPart, { partId: '1', mimeType: 'text/calendar', headers: [{ name: 'Content-Type', value: 'text/calendar; charset=UTF-8; method=REQUEST' }], body: { data: b64url('BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR'), size: 40 } }]
    : [textPart];
  return {
    id: m.id.replace(/[^A-Za-z0-9]/g, '') + 'x' + threadId.slice(0, 8),
    threadId,
    internalDate: String(nowMs - Math.round(m.age_hours * H)),
    labelIds: m.sent_by_me ? ['SENT'] : ['INBOX'],
    payload: { partId: '', mimeType: 'multipart/mixed', headers, body: { size: 0 }, parts },
  };
}

export function rawGmailThread(t: Pick<LedgerThread, 'id' | 'messages'>, nowMs: number): Record<string, unknown> {
  return { id: t.id, messages: t.messages.map(m => rawGmailMessage(m, t.id, nowMs)) };
}

// ─── Pure scoring ────────────────────────────────────────────────────────

/** What a detector said about one thread. */
export interface DetectorAnswer {
  open: null | { loop_type: LoopType; counterparty: string };
  /** Loop types the verdict closes (turn flip). */
  close: LoopType[];
  error?: string;
}

export interface ScoredThread { id: string; klass: ThreadClass; gold: MechanicsGold; answer: DetectorAnswer }

export interface DetectionMetrics {
  planted_open: number;
  planted_detected_right_type: number;
  planted_loop_recall: number;
  opens_on_planted: number;
  correct_opens_on_planted: number;
  planted_loop_precision: number | null;
  counterparty_checked: number;
  counterparty_correct: number;
  counterparty_accuracy: number | null;
  closure_cases: number;
  closure_correct: number;
  excluded_threads: number;
  excluded_class_loops: number;
  calendar_snapshot_closes: number;
  by_class: Record<string, { n: number; gold_open: number; detected: number; correct: number; errors: number }>;
  contested: {
    nudge_inbound: { n: number; detected: number };
    followup_outbound: { n: number; detected: number };
    url_question_mark_opens: { n: number; opened: number };
  };
  errors: number;
}

const sameOpen = (a: DetectorAnswer['open'], b: MechanicsGold['open']) => !!a && !!b && a.loop_type === b.loop_type && a.counterparty === b.counterparty;

export function scoreDetection(rows: readonly ScoredThread[]): DetectionMetrics {
  const contested = new Set<ThreadClass>(CONTESTED_CLASSES);
  const excluded = new Set<ThreadClass>(EXCLUDED_CLASSES);
  const core = rows.filter(r => !contested.has(r.klass));
  const plantedOpen = core.filter(r => r.gold.open);
  const rightType = plantedOpen.filter(r => r.answer.open?.loop_type === r.gold.open!.loop_type);
  const opens = core.filter(r => r.answer.open);
  const correctOpens = opens.filter(r => sameOpen(r.answer.open, r.gold.open));
  const closure = core.filter(r => r.gold.closure_case);
  const closureCorrect = closure.filter(r => r.answer.open?.loop_type !== r.gold.closes && !r.answer.error);
  const excl = rows.filter(r => excluded.has(r.klass));
  const calendarCloses = rows.filter(r => r.klass === 'calendar_after_question' && (r.answer.close.includes('unanswered_outbound') || r.answer.open?.loop_type !== 'unanswered_outbound'));
  const by_class: DetectionMetrics['by_class'] = {};
  for (const r of rows) {
    const c = (by_class[r.klass] ??= { n: 0, gold_open: 0, detected: 0, correct: 0, errors: 0 });
    c.n++;
    if (r.gold.open) c.gold_open++;
    if (r.answer.open) c.detected++;
    if (r.answer.error) c.errors++;
    if (r.gold.open ? sameOpen(r.answer.open, r.gold.open) : !r.answer.open && !r.answer.error) c.correct++;
  }
  const cls = (k: ThreadClass) => rows.filter(r => r.klass === k);
  const ratio = (n: number, d: number) => d ? n / d : null;
  return {
    planted_open: plantedOpen.length,
    planted_detected_right_type: rightType.length,
    planted_loop_recall: plantedOpen.length ? rightType.length / plantedOpen.length : 0,
    opens_on_planted: opens.length,
    correct_opens_on_planted: correctOpens.length,
    planted_loop_precision: ratio(correctOpens.length, opens.length),
    counterparty_checked: rightType.length,
    counterparty_correct: rightType.filter(r => r.answer.open!.counterparty === r.gold.open!.counterparty).length,
    counterparty_accuracy: ratio(rightType.filter(r => r.answer.open!.counterparty === r.gold.open!.counterparty).length, rightType.length),
    closure_cases: closure.length,
    closure_correct: closureCorrect.length,
    excluded_threads: excl.length,
    excluded_class_loops: excl.filter(r => r.answer.open || r.answer.error).length,
    calendar_snapshot_closes: calendarCloses.length,
    by_class,
    contested: {
      nudge_inbound: { n: cls('nudge_inbound_backfill').length, detected: cls('nudge_inbound_backfill').filter(r => sameOpen(r.answer.open, r.gold.open)).length },
      followup_outbound: { n: cls('followup_outbound_backfill').length, detected: cls('followup_outbound_backfill').filter(r => sameOpen(r.answer.open, r.gold.open)).length },
      url_question_mark_opens: { n: cls('url_question_fyi').length, opened: cls('url_question_fyi').filter(r => r.answer.open).length },
    },
    errors: rows.filter(r => r.answer.error).length,
  };
}

/** Outcome of one store scenario step. */
export interface StepResult { scenario: string; kind: StoreScenario['kind']; step: number; expected: string; observed: string; pass: boolean }

export interface StoreMetrics {
  calendar_closes: number;
  manual_close_reverted: number;
  muted_new_loops: number;
  closure_rounds: number;
  closure_rounds_correct: number;
  ack_rounds: number;
  ack_closed: number;
  nudge_rounds: number;
  nudge_held_open: number;
  reopen_rounds: number;
  reopened: number;
  turn_flip_rounds: number;
  turn_flip_reopened_inbound: number;
  presence_failures: string[];
}

export function scoreStore(steps: readonly StepResult[]): StoreMetrics {
  const at = (kind: StoreScenario['kind'], step: number) => steps.filter(s => s.kind === kind && s.step === step);
  const presence = steps.filter(s => s.step === 0 && s.expected.startsWith('open') && !s.pass).map(s => `${s.scenario}: precondition loop did not open (${s.observed})`);
  const closure = [...at('reply_close', 1), ...at('turn_flip', 1)];
  return {
    calendar_closes: at('calendar_hold', 1).filter(s => !s.pass).length,
    manual_close_reverted: at('manual_close', 2).filter(s => !s.pass).length,
    muted_new_loops: [...at('mute_sender', 1), ...at('mute_thread', 1)].filter(s => !s.pass).length,
    closure_rounds: closure.length,
    closure_rounds_correct: closure.filter(s => s.pass).length,
    ack_rounds: at('ack_close', 1).length,
    ack_closed: at('ack_close', 1).filter(s => s.pass).length,
    nudge_rounds: at('nudge_hold', 1).length,
    nudge_held_open: at('nudge_hold', 1).filter(s => s.pass).length,
    reopen_rounds: at('manual_close', 3).length,
    reopened: at('manual_close', 3).filter(s => s.pass).length,
    turn_flip_rounds: at('turn_flip', 2).length,
    turn_flip_reopened_inbound: at('turn_flip', 2).filter(s => s.pass).length,
    presence_failures: presence,
  };
}

export interface N7Contracts {
  excluded_class_loops: number;
  calendar_closes: number;
  manual_close_reverted: number;
  muted_new_loops: number;
  remote_evidence_leaks: number;
}
export interface N7Quality { planted_loop_recall: number; planted_loop_precision: number | null; closure_accuracy: number | null; counterparty_accuracy: number | null }

/** The preregistered rules (eval/registry.ts open-loops-email), evaluated on the runner side for the verdict. */
export function n7Verdict(c: N7Contracts, q: N7Quality): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  for (const [k, v] of Object.entries(c)) if (v !== 0) failed.push(`${k}=${v}`);
  if (!(q.planted_loop_recall >= 0.8)) failed.push(`planted_loop_recall=${q.planted_loop_recall}`);
  if (!(q.closure_accuracy !== null && q.closure_accuracy >= 0.95)) failed.push(`closure_accuracy=${q.closure_accuracy}`);
  if (!(q.counterparty_accuracy !== null && q.counterparty_accuracy >= 0.95)) failed.push(`counterparty_accuracy=${q.counterparty_accuracy}`);
  return { pass: failed.length === 0, failed };
}

export function combine(det: DetectionMetrics, store: StoreMetrics, remoteLeaks: number): { contracts: N7Contracts; quality: N7Quality } {
  const closureN = det.closure_cases + store.closure_rounds;
  return {
    contracts: {
      excluded_class_loops: det.excluded_class_loops,
      calendar_closes: det.calendar_snapshot_closes + store.calendar_closes,
      manual_close_reverted: store.manual_close_reverted,
      muted_new_loops: store.muted_new_loops,
      remote_evidence_leaks: remoteLeaks,
    },
    quality: {
      planted_loop_recall: det.planted_loop_recall,
      planted_loop_precision: det.planted_loop_precision,
      closure_accuracy: closureN ? (det.closure_correct + store.closure_rounds_correct) / closureN : null,
      counterparty_accuracy: det.counterparty_accuracy,
    },
  };
}

// ─── gbrain under test ───────────────────────────────────────────────────

interface GmailThreadData { threadId: string; account: string; messages: Array<{ id: string; fromAddress: string; bodyText: string; internalDateMs: number; calendarMethod: string | null; listUnsubscribe: boolean }> }
interface Verdict { open: Array<{ loopType: LoopType; counterpartyEmail: string }>; close: LoopType[] }
interface Sut {
  engine: { disconnect(): Promise<void>; executeRaw<T>(q: string, p?: unknown[]): Promise<T[]> };
  parse(raw: Record<string, unknown>): Promise<GmailThreadData>;
  detect(t: GmailThreadData, now: Date): Verdict;
  apply(sourceId: string, t: GmailThreadData, now: Date): Promise<void>;
  clearSuppressions(): void;
  op(name: string, params: Record<string, unknown>, remote?: boolean, sourceId?: string): Promise<unknown>;
  upsert(loop: Record<string, unknown>): Promise<unknown>;
  renderPage(t: GmailThreadData): { markdown: string } | null;
  importPage(slug: string, content: string): Promise<unknown>;
  extract(slug: string, threadId: string): Promise<unknown>;
}

async function openSut(gut: GbrainUnderTest): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => { connect(o: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; executeRaw<T>(q: string, p?: unknown[]): Promise<T[]> } }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const { GmailClient } = await importGbrain<{ GmailClient: new (tokens: unknown, fetchImpl: unknown) => { getThread(id: string, account: string): Promise<GmailThreadData> } }>(gut, 'src/core/google/google-clients.ts');
  const ld = await importGbrain<{
    detectThreadLoop: (t: GmailThreadData, me: Set<string>, now: Date) => Verdict;
    applyThreadLoopVerdict: (e: unknown, s: string, t: GmailThreadData, me: Set<string>, slug: string | null, now: Date) => Promise<void>;
    __clearSuppressionCacheForTests: (e?: unknown) => void;
  }>(gut, 'src/core/google/loop-detect.ts');
  const store = await importGbrain<{ upsertOpenLoop: (e: unknown, l: unknown) => Promise<unknown> }>(gut, 'src/core/loops/loops-store.ts');
  const render = await importGbrain<{ renderThreadPage: (t: GmailThreadData) => { markdown: string } | null }>(gut, 'src/core/google/google-render.ts');
  const importer = await importGbrain<{ importFromContent: (e: unknown, slug: string, c: string, o: object) => Promise<unknown> }>(gut, 'src/core/import-file.ts');
  const extractMod = await importGbrain<{ runLoopsExtract: (e: unknown, p: object) => Promise<unknown> }>(gut, 'src/core/google/loops-extract.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [SOURCE_ID, RANK_SOURCE_ID]) {
    await engine.executeRaw(`INSERT INTO sources (id, name, config, last_sync_at) VALUES ($1, $1, '{"kind":"google"}'::jsonb, now()) ON CONFLICT (id) DO NOTHING`, [id]);
  }
  const me = new Set<string>(MY_ADDRESSES);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const byName = new Map(operations.map(o => [o.name, o]));
  let pending: Record<string, unknown> | null = null;
  const client = new GmailClient(
    { getAccessToken: async () => 'stub-token', forceRefresh: async () => 'stub-token' },
    async () => new Response(JSON.stringify(pending)),
  );
  return {
    engine,
    parse: async raw => { pending = raw; try { return await client.getThread(String(raw.id), MY_ADDRESSES[0]); } finally { pending = null; } },
    detect: (t, now) => ld.detectThreadLoop(t, me, now),
    apply: (sourceId, t, now) => ld.applyThreadLoopVerdict(engine, sourceId, t, me, null, now),
    clearSuppressions: () => ld.__clearSuppressionCacheForTests(engine),
    op: async (name, params, remote = false, sourceId = SOURCE_ID) => {
      const o = byName.get(name);
      if (!o) throw new HarnessError(`gbrain has no operation ${name}`);
      const ctx = { engine, config: { engine: 'pglite' }, logger, dryRun: false, remote, sourceId } as unknown as OperationContext;
      return await o.handler(ctx, params);
    },
    upsert: loop => store.upsertOpenLoop(engine, loop),
    renderPage: t => render.renderThreadPage(t),
    importPage: (slug, content) => importer.importFromContent(engine, slug, content, { sourceId: SOURCE_ID, noEmbed: true }),
    extract: (slug, threadId) => extractMod.runLoopsExtract(engine, { slug, sourceId: SOURCE_ID, threadId }),
  };
}

class HarnessError extends Error {}
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

function toAnswer(v: Verdict): DetectorAnswer {
  const o = v.open[0];
  return { open: o ? { loop_type: o.loopType, counterparty: o.counterpartyEmail } : null, close: [...v.close] };
}

// ─── Store scenarios ─────────────────────────────────────────────────────

async function loopRow(sut: Sut, threadId: string, loopType: LoopType): Promise<{ id: number; status: string; closed_by: string | null; counterparty_email: string | null } | null> {
  const rows = await sut.engine.executeRaw<{ id: number; status: string; closed_by: string | null; counterparty_email: string | null }>(
    `SELECT id, status, closed_by, counterparty_email FROM open_loops WHERE source_id = $1 AND thread_id = $2 AND loop_type = $3`, [SOURCE_ID, threadId, loopType]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id) } : null;
}

async function runScenario(sut: Sut, s: StoreScenario, nowMs: number): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const [i, step] of s.steps.entries()) {
    if (step.kind === 'mute') {
      await sut.op('loops_mute', { kind: step.mute, value: step.value, source_id: SOURCE_ID });
      sut.clearSuppressions();
      continue;
    }
    if (step.kind === 'manual_close') {
      const row = await loopRow(sut, s.thread.id, step.loop_type);
      const res = row ? await sut.op('loops_close', { id: row.id, status: step.status }) as { closed?: boolean } : { closed: false };
      out.push({ scenario: s.id, kind: s.kind, step: i, expected: `closed ${step.status}`, observed: res.closed ? `closed ${step.status}` : 'not closed', pass: !!res.closed });
      continue;
    }
    const roundNow = nowMs - step.now_offset_hours * H;
    const msgs = s.thread.messages.slice(0, step.messages).map(m => ({ ...m, age_hours: m.age_hours - step.now_offset_hours }));
    if (msgs.some(m => m.age_hours <= 0)) throw new HarnessError(`${s.id}: a message is in the future of round ${i}`);
    const parsed = await sut.parse(rawGmailThread({ id: s.thread.id, messages: msgs }, roundNow));
    await sut.apply(SOURCE_ID, parsed, new Date(roundNow));
    const row = await loopRow(sut, s.thread.id, step.expect.loop_type);
    const observed = row ? `${row.status}${row.closed_by ? ` by ${row.closed_by}` : ''}${row.counterparty_email ? ` (${row.counterparty_email})` : ''}` : 'absent';
    const e = step.expect;
    const pass = e.status === 'absent'
      ? !row || row.status !== 'open'
      : !!row && row.status === e.status && (e.closed_by === undefined || row.closed_by === e.closed_by) && (e.counterparty === undefined || row.counterparty_email === e.counterparty);
    out.push({ scenario: s.id, kind: s.kind, step: i, expected: `${e.status} ${e.loop_type}${e.closed_by ? ` by ${e.closed_by}` : ''}${e.counterparty ? ` (${e.counterparty})` : ''}`, observed, pass });
  }
  return out;
}

// ─── Remote redaction ────────────────────────────────────────────────────

export function redactionLeaks(remote: unknown, bodies: readonly string[]): { leaks: number; detail: string[] } {
  const detail: string[] = [];
  const r = remote as { text?: unknown; groups?: Array<{ loops: Array<Record<string, unknown>>; context?: unknown }> };
  if (r.text !== undefined) detail.push('top-level text digest present');
  for (const g of r.groups ?? []) {
    if (g.context !== undefined) detail.push('entity-card context present');
    for (const l of g.loops) {
      if (l.quote !== undefined) detail.push(`loop ${l.id}: quote present`);
      if (l.deep_link !== undefined) detail.push(`loop ${l.id}: deep link present`);
    }
  }
  const json = JSON.stringify(remote);
  for (const b of bodies) if (b.length >= 24 && json.includes(b)) detail.push(`message body text present: "${b.slice(0, 40)}..."`);
  return { leaks: detail.length, detail };
}

// ─── Ranking conformance (in-process clock override) ─────────────────────

async function withClock<T>(ms: number | (() => number), fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = typeof ms === 'number' ? () => ms : ms;
  try { return await fn(); } finally { Date.now = real; }
}

async function rankOrder(sut: Sut, clock: number | (() => number), source = RANK_SOURCE_ID, asOf?: string): Promise<string[]> {
  const res = await withClock(clock, () => sut.op('open_loops', { source_id: source, limit: 50, include_context: false, ...(asOf ? { as_of: asOf } : {}) }, false, source)) as { groups: Array<{ counterparty: string }> };
  return res.groups.map(g => g.counterparty);
}

/** Order with `as_of` pinned to nowMs, read at wall clock nowMs and two days later; null when the build refuses as_of. */
async function pinnedOrders(sut: Sut, nowMs: number): Promise<{ at_now: string[]; two_days_later: string[] } | null> {
  const asOf = new Date(nowMs).toISOString();
  try {
    return { at_now: await rankOrder(sut, nowMs, RANK_SOURCE_ID, asOf), two_days_later: await rankOrder(sut, nowMs + 2 * 86_400_000, RANK_SOURCE_ID, asOf) };
  } catch {
    return null;
  }
}

async function rankingChecks(sut: Sut, nowMs: number): Promise<Record<string, unknown>> {
  const day = 86_400_000;
  const base = { sourceId: RANK_SOURCE_ID, evidence: [], detector: 'llm_extract' as const };
  await sut.upsert({ ...base, dedupKey: 'rank:a', loopType: 'commitment_owed_by_me', counterpartyEmail: 'a-rank@example.org', summary: 'deck for a-rank', dueAt: new Date(nowMs + 8 * day).toISOString(), lastActivityAt: new Date(nowMs - day).toISOString() });
  await sut.upsert({ ...base, dedupKey: 'rank:b', loopType: 'commitment_owed_to_me', counterpartyEmail: 'b-rank@example.org', summary: 'contract from b-rank', lastActivityAt: new Date(nowMs - 10 * day).toISOString() });
  await sut.upsert({ ...base, dedupKey: 'rank:c1', loopType: 'commitment_owed_by_me', counterpartyEmail: 'c-rank@example.org', summary: 'c one', lastActivityAt: new Date(nowMs - 2 * day).toISOString() });
  await sut.upsert({ ...base, dedupKey: 'rank:c2', loopType: 'commitment_owed_by_me', counterpartyEmail: 'c-rank@example.org', summary: 'c two', lastActivityAt: new Date(nowMs - 2 * day).toISOString() });
  await sut.upsert({ ...base, dedupKey: 'rank:d', loopType: 'commitment_owed_by_me', counterpartyEmail: 'd-rank@example.org', summary: 'd one', lastActivityAt: new Date(nowMs - 2 * day).toISOString() });
  // opened_at is stamped by the database clock at insert; the fixtures pin it
  // so the factor the guide calls "age of the oldest loop" is controlled.
  const setOpened = (key: string, ms: number) => sut.engine.executeRaw(`UPDATE open_loops SET opened_at = $1::timestamptz WHERE source_id = $2 AND dedup_key = $3`, [new Date(ms).toISOString(), RANK_SOURCE_ID, key]);
  await setOpened('rank:a', nowMs);
  await setOpened('rank:b', nowMs - 10 * day);
  for (const k of ['rank:c1', 'rank:c2', 'rank:d']) await setOpened(k, nowMs - 30 * day);
  const atNow = await rankOrder(sut, nowMs);
  const atNowAgain = await rankOrder(sut, nowMs);
  const plus2 = await rankOrder(sut, nowMs + 2 * day);
  const idx = (o: string[], c: string) => o.indexOf(c);
  // A ticking clock: Date.now advances 1 ms per call, as it may inside one sort.
  let tick = nowMs;
  const ticking = await rankOrder(sut, () => tick++);
  const pinned = await pinnedOrders(sut, nowMs);
  return {
    fixtures: 'a: one commitment due in 8 days, opened now; b: one loop, opened 10 days ago, no due date; c: two loops; d: one loop (c and d otherwise equal, opened 30 days ago)',
    order_at_now: atNow,
    order_at_now_repeat: atNowAgain,
    order_two_days_later: plus2,
    same_clock_same_order: JSON.stringify(atNow) === JSON.stringify(atNowAgain),
    order_changes_with_clock_alone: JSON.stringify(atNow) !== JSON.stringify(plus2),
    a_before_b_at_now: idx(atNow, 'a-rank@example.org') < idx(atNow, 'b-rank@example.org'),
    a_before_b_two_days_later: idx(plus2, 'a-rank@example.org') < idx(plus2, 'b-rank@example.org'),
    more_loops_rank_higher: idx(atNow, 'c-rank@example.org') < idx(atNow, 'd-rank@example.org'),
    ticking_clock_order: ticking,
    ticking_clock_matches_fixed: JSON.stringify(ticking) === JSON.stringify(atNow),
    as_of_pinned_order: pinned,
    as_of_pins_order: pinned !== null && JSON.stringify(pinned.at_now) === JSON.stringify(pinned.two_days_later),
  };
}

async function ageFromDetection(sut: Sut, nowMs: number, world: ReturnType<typeof generateN7World>): Promise<Record<string, unknown>> {
  const old = world.ledger.threads.find(t => t.klass === 'inbound_owed')!;
  const mk = (id: string, age: number) => ({ id, messages: [{ ...old.messages[0], id: `age${id}`, age_hours: age }] });
  const a = mk('aaaa000000000001', 720);
  const b = mk('aaaa000000000002', 30);
  for (const t of [a, b]) await sut.apply(SOURCE_ID, await sut.parse(rawGmailThread(t, nowMs)), new Date(nowMs));
  const rows = await sut.engine.executeRaw<{ thread_id: string; opened_at: string | Date; last_activity_at: string | Date }>(
    `SELECT thread_id, opened_at, last_activity_at FROM open_loops WHERE source_id = $1 AND thread_id IN ($2, $3)`, [SOURCE_ID, a.id, b.id]);
  const ms = (v: string | Date) => new Date(v).getTime();
  const ra = rows.find(r => r.thread_id === a.id);
  const rb = rows.find(r => r.thread_id === b.id);
  const out = {
    message_age_hours: { older: 720, newer: 30 },
    opened_at_spread_seconds: ra && rb ? Math.abs(ms(ra.opened_at) - ms(rb.opened_at)) / 1000 : null,
    last_activity_spread_hours: ra && rb ? Math.abs(ms(ra.last_activity_at) - ms(rb.last_activity_at)) / H : null,
    note: 'open_loops ranks on the oldest opened_at, which the database stamps at detection; two loops detected in one sync rank as equally old whatever the message ages.',
  };
  await sut.engine.executeRaw(`DELETE FROM open_loops WHERE source_id = $1 AND thread_id IN ($2, $3)`, [SOURCE_ID, a.id, b.id]);
  return out;
}

// ─── amara-life-v1 background ────────────────────────────────────────────

interface AmaraEmail { id: string; ts: string; from: { email: string }; to: Array<{ email: string }>; subject: string; thread_id: string; body_text: string }

/** Independent reading of "contains a question": a question mark ending a sentence, outside links. */
export function asksQuestion(text: string): boolean {
  return /\?(\s|$)/.test(text.replace(/https?:\/\/\S+/g, ''));
}

export function amaraThreads(): { threads: LedgerThread[]; now: string } {
  const lines = readFileSync(join(import.meta.dir, '../data/amara-life-v1/inbox/emails.jsonl'), 'utf8').trim().split('\n');
  const emails = lines.map(l => JSON.parse(l) as AmaraEmail);
  // The inbox owner is the one address on every thread; it becomes "me".
  const threadsOf = new Map<string, Set<string>>();
  for (const e of emails) for (const a of [e.from.email, ...e.to.map(t => t.email)]) threadsOf.set(a.toLowerCase(), (threadsOf.get(a.toLowerCase()) ?? new Set()).add(e.thread_id));
  const threadCount = new Set(emails.map(e => e.thread_id)).size;
  const owner = [...threadsOf.entries()].find(([, ts]) => ts.size === threadCount)?.[0];
  if (!owner) throw new HarnessError('amara-life-v1: no address appears on every thread, so the inbox owner is unknown');
  const alias = new Map<string, string>([[owner, MY_ADDRESSES[0]]]);
  const pseudo = (a: string) => {
    const k = a.toLowerCase();
    if (!alias.has(k)) alias.set(k, `person-${String(alias.size).padStart(2, '0')}@example.net`);
    return alias.get(k)!;
  };
  const nowMs = Math.max(...emails.map(e => Date.parse(e.ts))) + 2 * 86_400_000;
  const byThread = new Map<string, AmaraEmail[]>();
  for (const e of emails) byThread.set(e.thread_id, [...(byThread.get(e.thread_id) ?? []), e]);
  const threads: LedgerThread[] = [];
  let n = 0;
  for (const [tid, es] of [...byThread.entries()].sort()) {
    es.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
    threads.push({
      id: `amara${String(n++).padStart(11, '0')}`,
      klass: 'inbound_owed',
      semantic: { someone_waiting_on_me: false, promise: null },
      messages: es.map((e, i) => {
        const from = pseudo(e.from.email);
        return {
          id: `a${tid.replace(/[^0-9]/g, '')}m${i}`, from: `Person <${from}>`, from_address: from, sent_by_me: from === MY_ADDRESSES[0],
          to: e.to.map(t => pseudo(t.email)), cc: [], subject: `Thread ${tid}`, age_hours: (nowMs - Date.parse(e.ts)) / H, kind: 'human' as const,
          own_text: e.body_text, quoted: '', asks: asksQuestion(e.body_text),
        };
      }),
    });
  }
  return { threads, now: new Date(nowMs).toISOString() };
}

// ─── Run ─────────────────────────────────────────────────────────────────

export interface N7RunResult {
  world: ReturnType<typeof generateN7World>;
  rows: ScoredThread[];
  detection: DetectionMetrics | null;
  steps: StepResult[];
  store: StoreMetrics | null;
  redaction: { leaks: number; detail: string[]; trusted_quotes: number; remote_groups: number } | null;
  ranking: Record<string, unknown> | null;
  age_from_detection: Record<string, unknown> | null;
  amara: { threads: number; gold_open: number; detected: number; agree: number; disagreements: Array<{ thread: string; gold: unknown; detected: unknown }> } | null;
  semantic: Record<string, unknown> | null;
  contracts: N7Contracts | null;
  quality: N7Quality | null;
  verdict: { pass: boolean; failed: string[] } | null;
  outputs_sha256: string | null;
  acc: ProbeAccounting;
  harnessError: string | null;
}

export async function runN7(opts: { gut: GbrainUnderTest; seed?: number; log?: (s: string) => void }): Promise<N7RunResult> {
  return withHermeticEnv('n7', () => runN7Hermetic(opts));
}

function semanticReport(rows: readonly ScoredThread[], world: ReturnType<typeof generateN7World>): Record<string, unknown> {
  const byId = new Map(world.ledger.threads.map(t => [t.id, t]));
  const closedByMyReply = rows.filter(r => r.gold.closure_case && r.gold.closes === 'unanswered_inbound' && r.answer.open?.loop_type !== 'unanswered_inbound');
  const stillOwed = closedByMyReply.filter(r => byId.get(r.id)!.semantic.someone_waiting_on_me);
  const promises = world.ledger.threads.filter(t => t.semantic.promise);
  const promiseRows = rows.filter(r => byId.get(r.id)!.semantic.promise);
  return {
    closed_by_my_reply: closedByMyReply.length,
    still_owed_after_close: stillOwed.length,
    still_owed_after_close_rate: closedByMyReply.length ? stillOwed.length / closedByMyReply.length : null,
    still_owed_classes: [...new Set(stillOwed.map(r => r.klass))].sort(),
    promises: {
      total: promises.length,
      by_me: promises.filter(t => t.semantic.promise!.by === 'me').length,
      to_me: promises.filter(t => t.semantic.promise!.by === 'them').length,
      fulfilled: promises.filter(t => t.semantic.promise!.fulfilled).length,
      detector_open_on_promise_threads: promiseRows.filter(r => r.answer.open).map(r => ({ klass: r.klass, loop_type: r.answer.open!.loop_type })),
      note: 'The turn-flip detector has no notion of a promise. Promise extraction is the LLM extractor (paid arm); fulfillment is never marked by gbrain (feature gap N7 ledger entry).',
    },
    waiting_on_me_but_no_inbound_loop: rows.filter(r => byId.get(r.id)!.semantic.someone_waiting_on_me && r.answer.open?.loop_type !== 'unanswered_inbound').map(r => r.klass).sort(),
    inbound_loop_but_nobody_waiting: rows.filter(r => !byId.get(r.id)!.semantic.someone_waiting_on_me && r.answer.open?.loop_type === 'unanswered_inbound').map(r => r.klass).sort(),
  };
}

async function runN7Hermetic(opts: { gut: GbrainUnderTest; seed?: number; log?: (s: string) => void }): Promise<N7RunResult> {
  const log = opts.log ?? (() => {});
  const rules = n7RulesFor(opts.gut.version);
  const world = generateN7World({ seed: opts.seed ?? N7_DEFAULT_SEED, rules });
  const nowMs = Date.parse(N7_NOW_ISO);
  const amara = amaraThreads();
  const planned = world.ledger.threads.length + world.ledger.scenarios.reduce((n, s) => n + s.steps.filter(st => st.kind !== 'mute').length, 0) + amara.threads.length + 1;
  const acc = new ProbeAccounting(planned);
  const result: N7RunResult = { world, rows: [], detection: null, steps: [], store: null, redaction: null, ranking: null, age_from_detection: null, amara: null, semantic: null, contracts: null, quality: null, verdict: null, outputs_sha256: null, acc, harnessError: null };
  const sut = await openSut(opts.gut);
  try {
    log(`detecting ${world.ledger.threads.length} threads at ${N7_NOW_ISO}`);
    let parsedMessages = 0;
    for (const t of world.ledger.threads) {
      const gold = world.gold.get(t.id)!;
      let answer: DetectorAnswer;
      try {
        const parsed = await sut.parse(rawGmailThread(t, nowMs));
        parsedMessages += parsed.messages.length;
        answer = toAnswer(sut.detect(parsed, new Date(nowMs)));
        acc.score(`thread:${t.id}`, (gold.open ? sameOpen(answer.open, gold.open) : !answer.open) ? 1 : 0);
      } catch (e) {
        answer = { open: null, close: [], error: errMsg(e) };
        acc.error(`thread:${t.id}`, 'sut', errMsg(e));
      }
      result.rows.push({ id: t.id, klass: t.klass, gold, answer });
    }
    const expectedMessages = world.ledger.threads.reduce((n, t) => n + t.messages.length, 0);
    if (parsedMessages !== expectedMessages) throw new HarnessError(`presence: GmailClient.getThread returned ${parsedMessages} of ${expectedMessages} ledger messages`);
    result.detection = scoreDetection(result.rows);

    log(`replaying ${world.ledger.scenarios.length} store scenarios`);
    for (const s of world.ledger.scenarios) {
      try {
        const steps = await runScenario(sut, s, nowMs);
        result.steps.push(...steps);
        for (const st of steps) acc.score(`${st.scenario}:${st.step}`, st.pass ? 1 : 0);
      } catch (e) {
        if (e instanceof HarnessError) throw e;
        acc.error(`scenario:${s.id}`, 'sut', errMsg(e));
        result.steps.push({ scenario: s.id, kind: s.kind, step: -1, expected: 'scenario completes', observed: `threw: ${errMsg(e)}`, pass: false });
      }
    }
    result.store = scoreStore(result.steps);
    if (result.store.presence_failures.length) throw new HarnessError(`presence: ${result.store.presence_failures.join('; ')}`);

    const trusted = await sut.op('open_loops', { limit: 50 }, false) as { groups: Array<{ loops: Array<{ quote?: string }> }> };
    const remote = await sut.op('open_loops', { limit: 50 }, true) as { groups?: unknown[] };
    const trustedQuotes = trusted.groups.flatMap(g => g.loops).filter(l => l.quote).length;
    const remoteGroups = remote.groups?.length ?? 0;
    if (!trustedQuotes || !remoteGroups) throw new HarnessError(`presence: redaction check has no signal (trusted quotes ${trustedQuotes}, remote groups ${remoteGroups})`);
    const bodies = world.ledger.scenarios.flatMap(s => s.thread.messages.map(m => m.own_text));
    result.redaction = { ...redactionLeaks(remote, bodies), trusted_quotes: trustedQuotes, remote_groups: remoteGroups };
    acc.score('redaction', result.redaction.leaks === 0 ? 1 : 0);

    result.ranking = await rankingChecks(sut, nowMs);
    result.age_from_detection = await ageFromDetection(sut, nowMs, world);

    const amaraNow = new Date(amara.now);
    const dis: Array<{ thread: string; gold: unknown; detected: unknown }> = [];
    let gOpen = 0; let det = 0; let agree = 0;
    for (const t of amara.threads) {
      const g = mechanicsOracle(t.messages, MY_ADDRESSES, rules);
      try {
        const a = toAnswer(sut.detect(await sut.parse(rawGmailThread(t, amaraNow.getTime())), amaraNow));
        if (g.open) gOpen++;
        if (a.open) det++;
        const ok = g.open ? sameOpen(a.open, g.open) : !a.open;
        if (ok) agree++; else dis.push({ thread: t.id, gold: g.open, detected: a.open });
        acc.score(`amara:${t.id}`, ok ? 1 : 0);
      } catch (e) {
        acc.error(`amara:${t.id}`, 'sut', errMsg(e));
      }
    }
    result.amara = { threads: amara.threads.length, gold_open: gOpen, detected: det, agree, disagreements: dis };

    const semantic = semanticReport(result.rows, world);
    const promiseThread = world.ledger.threads.find(t => t.klass === 'promise_pending')!;
    let extractor: Record<string, unknown>;
    try {
      const parsed = await sut.parse(rawGmailThread(promiseThread, nowMs));
      const page = sut.renderPage(parsed);
      if (!page) throw new HarnessError('renderThreadPage returned null for a human thread');
      await sut.importPage(`email/n7-${promiseThread.id}`, page.markdown);
      const r = await sut.extract(`email/n7-${promiseThread.id}`, promiseThread.id);
      extractor = { keyless_result: r, refused: false };
    } catch (e) {
      if (e instanceof HarnessError) throw e;
      extractor = { refused: true, error: errMsg(e).slice(0, 200) };
    }
    result.semantic = { ...semantic, extractor_keyless: extractor };

    const { contracts, quality } = combine(result.detection, result.store, result.redaction.leaks);
    result.contracts = contracts;
    result.quality = quality;
    result.verdict = n7Verdict(contracts, quality);
    result.outputs_sha256 = (await import('node:crypto')).createHash('sha256').update(JSON.stringify({ rows: result.rows.map(r => [r.id, r.answer]), steps: result.steps, amara: result.amara })).digest('hex');
    return result;
  } catch (e) {
    const msg = e instanceof HarnessError ? errMsg(e) : `harness: ${errMsg(e)}`;
    acc.error('run', 'harness', msg);
    result.harnessError = msg;
    return result;
  } finally {
    await sut.engine.disconnect().catch(() => {});
  }
}


// ─── Paid extractor arm ──────────────────────────────────────────────────

export const EXTRACTOR_CATEGORY = 'n7-open-loops-email-extractor';
export const EXTRACTOR_MODEL = 'anthropic:claude-sonnet-4-6';
export const EXTRACTOR_ESTIMATE_USD = 0.6;
const PROMISE_OPEN: readonly ThreadClass[] = ['promise_pending', 'promise_then_thanks', 'promise_to_me'];

interface ExtractedLoop { loop_type: string; status: string; due: string | null }

export interface ExtractorRow { thread: string; klass: ThreadClass; pass: 'single' | 'before_fulfillment' | 'after_fulfillment'; loops: ExtractedLoop[]; error?: string }

export function scoreExtractor(world: ReturnType<typeof generateN7World>, rows: readonly ExtractorRow[]): Record<string, unknown> {
  const byId = new Map(world.ledger.threads.map(t => [t.id, t]));
  const single = rows.filter(r => r.pass === 'single');
  const wantType = (t: LedgerThread) => t.semantic.promise?.by === 'them' ? 'commitment_owed_to_me' : 'commitment_owed_by_me';
  const open = single.filter(r => PROMISE_OPEN.includes(r.klass));
  const recalled = open.filter(r => r.loops.some(l => l.loop_type === wantType(byId.get(r.thread)!) && l.status === 'open'));
  const dated = recalled.map(r => {
    const t = byId.get(r.thread)!;
    const l = r.loops.find(x => x.loop_type === wantType(t) && x.status === 'open')!;
    return { thread: r.thread, gold: t.semantic.promise!.due, got: l.due ? l.due.slice(0, 10) : null };
  });
  const fulfilled = single.filter(r => r.klass === 'promise_fulfilled');
  const controls = single.filter(r => r.klass === 'ack_thanks' || r.klass === 'outbound_fyi');
  const after = rows.filter(r => r.pass === 'after_fulfillment');
  const before = rows.filter(r => r.pass === 'before_fulfillment');
  return {
    promise_recall: { n: open.length, recalled: recalled.length, rate: open.length ? recalled.length / open.length : null },
    due_date_exact: { n: dated.length, exact: dated.filter(d => d.got === d.gold).length, rate: dated.length ? dated.filter(d => d.got === d.gold).length / dated.length : null, rows: dated },
    fulfilled_single_pass_suppressed: { n: fulfilled.length, suppressed: fulfilled.filter(r => !r.loops.some(l => l.loop_type === 'commitment_owed_by_me' && l.status === 'open')).length },
    fulfillment_replay: {
      n: after.length,
      extracted_before: before.filter(r => r.loops.some(l => l.loop_type === 'commitment_owed_by_me' && l.status === 'open')).length,
      still_open_after: after.filter(r => r.loops.some(l => l.loop_type === 'commitment_owed_by_me' && l.status === 'open')).length,
    },
    false_commitments_on_controls: { n: controls.length, threads_with_owed_by_me: controls.filter(r => r.loops.some(l => l.loop_type === 'commitment_owed_by_me')).length },
    errors: rows.filter(r => r.error).length,
  };
}

async function runExtractorArm(gut: GbrainUnderTest, argv: readonly string[], log: (s: string) => void): Promise<{ rows: ExtractorRow[]; world: ReturnType<typeof generateN7World>; budgetRunId: string; cost: ReturnType<typeof receiptCost> }> {
  const { budgetRunId } = requirePaidArm(argv, { arm: 'N7 extractor arm', estimateUsd: EXTRACTOR_ESTIMATE_USD });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('The N7 extractor arm calls gbrain\'s default chat model (Anthropic) and needs ANTHROPIC_API_KEY in the environment. Set it, then rerun.');
  const world = generateN7World({ seed: N7_DEFAULT_SEED });
  const nowMs = Date.parse(N7_NOW_ISO);
  const { run, guard } = startPaidRun('n7-open-loops-email-extractor', { ...budgetOptionsFrom(argv), runId: budgetRunId, estimateUsd: EXTRACTOR_ESTIMATE_USD, log });
  const rows: ExtractorRow[] = [];
  try {
    await withHermeticEnv('n7x', async () => {
      const gw = await importGbrain<{ configureGateway: (c: object) => void }>(gut, 'src/core/ai/gateway.ts');
      gw.configureGateway({ chat_model: EXTRACTOR_MODEL, env: { ANTHROPIC_API_KEY: key } });
      const sut = await openSut(gut);
      try {
        const extractOnce = async (t: LedgerThread, messages: LedgerMessage[], pass: ExtractorRow['pass']) => {
          const slug = `email/n7x-${t.id}`;
          try {
            if (guard.exhausted) throw new Error('budget exhausted');
            const parsed = await sut.parse(rawGmailThread({ id: t.id, messages }, nowMs));
            const page = sut.renderPage(parsed);
            if (!page) throw new HarnessError(`renderThreadPage returned null for ${t.id}`);
            await sut.importPage(slug, page.markdown);
            await sut.extract(slug, t.id);
            const loops = await sut.engine.executeRaw<{ loop_type: string; status: string; due_at: string | Date | null }>(
              `SELECT loop_type, status, due_at FROM open_loops WHERE source_id = $1 AND thread_id = $2 AND detector = 'llm_extract' ORDER BY id`, [SOURCE_ID, t.id]);
            rows.push({ thread: t.id, klass: t.klass, pass, loops: loops.map(l => ({ loop_type: l.loop_type, status: l.status, due: l.due_at ? new Date(l.due_at).toISOString() : null })) });
          } catch (e) {
            if (e instanceof HarnessError) throw e;
            rows.push({ thread: t.id, klass: t.klass, pass, loops: [], error: errMsg(e).slice(0, 300) });
          }
        };
        const pick = (k: ThreadClass) => world.ledger.threads.filter(t => t.klass === k);
        for (const t of [...pick('promise_pending'), ...pick('promise_then_thanks'), ...pick('promise_to_me'), ...pick('promise_fulfilled'), ...pick('ack_thanks'), ...pick('outbound_fyi')]) {
          log(`extracting ${t.klass} ${t.id}`);
          await extractOnce(t, t.messages, 'single');
        }
        await sut.engine.executeRaw(`DELETE FROM open_loops WHERE source_id = $1 AND detector = 'llm_extract' AND thread_id = ANY($2::text[])`, [SOURCE_ID, pick('promise_fulfilled').map(t => t.id)]);
        for (const t of pick('promise_fulfilled')) {
          log(`replaying fulfillment ${t.id}`);
          await extractOnce(t, t.messages.slice(0, -1), 'before_fulfillment');
          await extractOnce(t, t.messages, 'after_fulfillment');
        }
      } finally {
        await sut.engine.disconnect().catch(() => {});
      }
    });
  } finally {
    guard.uninstall();
  }
  return { rows, world, budgetRunId, cost: receiptCost(run.close()) };
}

// ─── Findings → bug ledger ───────────────────────────────────────────────

const REPRO_DIR = 'docs/benchmarks/2026-10-01-n7-open-loops-email/repro';

/** Findings this run supports, each classified against a stated contract. */
export function n7Findings(r: N7RunResult, gbrainSha: string): BugEntry[] {
  const out: BugEntry[] = [];
  const d = r.detection;
  if (d && d.contested.nudge_inbound.detected < d.contested.nudge_inbound.n) {
    out.push({
      id: 'N7-1', category: 'open-loops-email', classification: 'bug', gbrain_sha: gbrainSha,
      contract: 'docs/guides/open-loops.md: "last substantive message is theirs, you\'re in To:, unanswered >=24h -> unanswered_inbound"; src/core/google/loop-detect.ts close-lane comment: a fresh counterparty nudge inside the grace window is not a reply and must not hide the loop "exactly while the counterparty was most impatient".',
      surface: 'src/core/google/loop-detect.ts detectThreadLoop (grace check on the last message)',
      repro: `bun ${REPRO_DIR}/n7-1-nudge-backfill.ts`,
      expected: 'A thread first seen with a request 30 to 120 hours old and a nudge 1 to 20 hours old opens unanswered_inbound: the request has been unanswered for more than 24 hours.',
      actual: `No loop: the grace window is measured from the nudge, so ${d.contested.nudge_inbound.n - d.contested.nudge_inbound.detected} of ${d.contested.nudge_inbound.n} such threads (and ${d.contested.followup_outbound.n - d.contested.followup_outbound.detected} of ${d.contested.followup_outbound.n} outbound follow-ups) are invisible on first sync (backfill or after a sync gap) until the nudge itself ages past the window. Steady-state syncs that saw the request first keep the loop open (hold).`,
      status: 'open',
    });
  }
  if ((r.store?.ack_closed ?? 0) > 0) out.push({
    id: 'N7-2', category: 'open-loops-email', classification: 'feature-gap', gbrain_sha: gbrainSha,
    contract: 'docs/guides/open-loops.md: "a reply lands -> the loop closes itself (closed_by: reply_detected)"; close semantics: "Thread loops close deterministically when a reply lands." Any reply is documented to close; acknowledgements are not distinguished.',
    surface: 'src/core/google/loop-detect.ts detectThreadLoop (turn flip is the only close signal)',
    repro: `bun ${REPRO_DIR}/n7-2-thanks-closes.ts`,
    expected: 'A reply that only acknowledges ("Thanks!") while the request is still owed leaves someone waiting; a semantic open-loop engine would keep it open.',
    actual: `The acknowledgement closes the reply-owed loop as documented (${r.store?.ack_closed ?? 0} of ${r.store?.ack_rounds ?? 0} store rounds closed by reply_detected); ${(r.semantic as { still_owed_after_close?: number } | null)?.still_owed_after_close ?? 0} of ${(r.semantic as { closed_by_my_reply?: number } | null)?.closed_by_my_reply ?? 0} threads closed by my reply are still owed by the semantic labels.`,
    status: 'open',
  });
  out.push({
    id: 'N7-3', category: 'open-loops-email', classification: 'feature-gap', gbrain_sha: gbrainSha,
    contract: 'docs/guides/open-loops.md close semantics: "Fulfillment-by-reply detection for commitments is future work, not pretended at." src/core/google/loops-extract.ts persistence upserts extracted commitments only.',
    surface: 'src/core/google/loops-extract.ts runLoopsExtract; src/core/loops/loops-store.ts upsertOpenLoop',
    repro: `bun ${REPRO_DIR}/n7-3-fulfillment-gap.ts`,
    expected: 'A commitment loop closes when a later message in the thread fulfils it ("As promised, here is the deck").',
    actual: 'Nothing marks a stored commitment fulfilled: re-extraction can only upsert what the model returns, the reply auto-close touches deterministic_thread loops only, and staleness closes llm_extract loops by age. Keyless the extractor refuses (llm_unavailable). The preregistered paid replay (docs/benchmarks/2026-10-01-n7-open-loops-email/receipt-extractor-pin.json) saw the model correctly omit all 4 fulfilled promises on a single pass, yet all 4 commitment loops extracted before the fulfilling message stayed open after it was extracted.',
    status: 'open',
  });
  out.push({
    id: 'N7-4', category: 'open-loops-email', classification: 'feature-gap', gbrain_sha: gbrainSha,
    contract: 'Plan section 3 lists open loops over inbox, Slack and calendar; gbrain ships Gmail threads only (capability matrix N7: connectors are chatgpt and claude; calendar mail is excluded from loops).',
    surface: 'src/core/connectors/providers/; src/core/google/loop-detect.ts calendar exclusion',
    repro: 'ls node_modules/gbrain/src/core/connectors/providers/ && grep -n "isCalendarSystemMail" node_modules/gbrain/src/core/google/loop-detect.ts',
    expected: 'Commitments made in Slack or calendar invitations surface as open loops.',
    actual: 'No Slack or calendar loop source exists; calendar notices neither open nor close loops by design.',
    status: 'open',
  });
  const rk = r.ranking as { order_changes_with_clock_alone?: boolean; same_clock_same_order?: boolean; a_before_b_at_now?: boolean; a_before_b_two_days_later?: boolean; as_of_pins_order?: boolean } | null;
  if (rk?.order_changes_with_clock_alone && !rk.as_of_pins_order) {
    out.push({
      id: 'N7-5', category: 'open-loops-email', classification: 'feature-gap', gbrain_sha: gbrainSha,
      contract: 'docs/guides/open-loops.md Ranking: "Deterministic - same data, same order." Due-date proximity and loop age are relative to the current time by design, and no operation parameter pins that time.',
      surface: 'src/core/ops/loops.ts rankGroups (Date.now() in the score)',
      repro: `bun ${REPRO_DIR}/n7-5-ranking-clock.ts`,
      expected: 'A published `gbrain waiting` order can be reproduced: the same rows and the same reference time give the same order, and the reference time can be pinned.',
      actual: `At a fixed instant the order is stable (${rk.same_clock_same_order ? 'verified' : 'NOT stable'}), but with identical rows counterparty a ranks ${rk.a_before_b_at_now ? 'above' : 'below'} b now and ${rk.a_before_b_two_days_later ? 'above' : 'below'} b two days later. The clock is Date.now() with no parameter, so ranking cannot be pinned for an evaluation or a replay.`,
      status: 'open',
    });
  }
  const age = r.age_from_detection as { opened_at_spread_seconds?: number | null; last_activity_spread_hours?: number | null } | null;
  if (age && (age.opened_at_spread_seconds ?? Infinity) < 60 && (age.last_activity_spread_hours ?? 0) > 24) {
    out.push({
      id: 'N7-6', category: 'open-loops-email', classification: 'feature-gap', gbrain_sha: gbrainSha,
      contract: 'docs/guides/open-loops.md Ranking: "Counterparties rank by open-loop count, due-date proximity, age of the oldest loop, and how connected the person is."',
      surface: 'src/core/loops/loops-store.ts upsertOpenLoop (opened_at defaults to now()); src/core/ops/loops.ts rankGroups (age from oldest_opened_at)',
      repro: `bun ${REPRO_DIR}/n7-6-age-from-detection.ts`,
      expected: 'Someone whose request has waited 30 days ranks as older than someone who wrote yesterday, including on the first sync of an existing inbox.',
      actual: `Loop age is time since detection: two inbound loops detected in one sync have opened_at ${age.opened_at_spread_seconds} s apart although their messages are ${age.last_activity_spread_hours} hours apart, so a backfill ranks every waiting person as equally old.`,
      status: 'open',
    });
  }
  if (d && d.contested.url_question_mark_opens.opened > 0) {
    out.push({
      id: 'N7-7', category: 'open-loops-email', classification: 'feature-gap', gbrain_sha: gbrainSha,
      contract: 'docs/guides/open-loops.md: an outbound loop needs the last message to contain "a question"; src/core/google/loop-detect.ts implements this as bodyText.includes("?") ("No question mark -> FYI/forward, not an ask").',
      surface: 'src/core/google/loop-detect.ts detectThreadLoop (question test)',
      repro: `bun ${REPRO_DIR}/n7-7-url-question-mark.ts`,
      expected: 'An FYI whose only question mark sits inside a link (https://docs.example.com/view?id=42) is not an ask.',
      actual: `${d.contested.url_question_mark_opens.opened} of ${d.contested.url_question_mark_opens.n} such messages opened unanswered_outbound after 72 hours.`,
      status: 'open',
    });
  }
  return out;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (v: number | null | undefined) => v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? N7_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const sha = gut.overlay?.build.commit ?? gbrainPin().split('#')[1] ?? 'unknown';
  if (paidRequested(argv)) {
    const xOut = output ? join(output, 'receipt.json') : receiptPath(EXTRACTOR_CATEGORY);
    log(`# BrainBench N7 extractor arm (paid, exploratory; gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
    const x = await runExtractorArm(gut, argv, log);
    const scored = scoreExtractor(x.world, x.rows);
    const errs = x.rows.filter(r => r.error).length;
    const xr: Receipt = {
      schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: EXTRACTOR_CATEGORY,
      run_status: 'completed', verdict: errs === 0 ? 'pass' : errs < x.rows.length ? 'partial' : 'fail',
      n_total: x.rows.length, n_scored: x.rows.length - errs, completion_rate: x.rows.length ? (x.rows.length - errs) / x.rows.length : 0,
      errors: x.rows.filter(r => r.error).map(r => ({ probe_id: `${r.pass}:${r.thread}`, origin: 'dependency' as const, message: r.error! })),
      publishable: errs === 0, gbrain_version: gut.version, gbrain_pin: gbrainPin(),
      execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
      cost: x.cost, delivered_tokens: { tokens: x.cost.input_tokens, basis: 'input tokens the budget ledger recorded for the extractor calls' },
      resolved_config: { engine: 'pglite-in-memory', decide: DECIDE_OFF, chat_model: EXTRACTOR_MODEL, key_route: 'gateway config env only; process keys stripped', now: N7_NOW_ISO, seed: N7_DEFAULT_SEED, generator_version: N7_GENERATOR_VERSION, ledger_sha256: x.world.fingerprint, budget_run_id: x.budgetRunId, preregistration: 'docs/plans/2026-10-01-eval-category-wave/prereg-n7-extractor-arm.md', gbrain_overlay: overlaySummary(gut), verdict_meaning: 'completion only (every planned extraction returned); exploratory, never gates' },
      started_at: startedAt, finished_at: new Date().toISOString(),
      data: { scored, rows: x.rows },
    };
    writeReceipt(xOut, xr);
    log(JSON.stringify(scored, null, 2));
    log(`cost: $${x.cost.usd.toFixed(4)} (${x.cost.basis})`);
    log(`receipt: ${xOut}`);
    process.exit(0);
  }
  log(`# BrainBench N7: open loops on Gmail-shaped threads (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const r = await runN7({ gut, seed, log });
  const a = r.acc.summary();
  const findings = /^[0-9a-f]{40}$/.test(sha) && !r.harnessError ? n7Findings(r, sha) : [];
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped; no model call (the keyless extractor refusal is recorded, not paid)'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessError || a.run_invalid ? 'error' : 'completed',
    ...(r.harnessError || a.run_invalid ? {} : { verdict: r.verdict?.pass ? 'pass' : 'fail' }),
    n_total: a.n_total,
    n_scored: a.n_scored,
    completion_rate: a.completion_rate,
    errors: a.errors,
    publishable: a.publishable && !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory',
      decide: DECIDE_OFF,
      now: N7_NOW_ISO,
      my_addresses: [...MY_ADDRESSES],
      seed,
      generator_version: N7_GENERATOR_VERSION,
      ledger_sha256: r.world.fingerprint,
      caller: 'GmailClient.getThread with a stub fetch; detectThreadLoop and applyThreadLoopVerdict with the pinned now; operations with OperationContext { remote: false } (and remote: true for the redaction check), sourceId n7-google',
      entry_points: ENTRY_POINTS,
      oracle: 'independent implementation of docs/guides/open-loops.md over ledger facts (eval/generators/n7-gmail-loops-gen.ts mechanicsOracle); "unanswered for 24 hours" counts from the first unanswered message in the trailing run',
      oracle_rules: n7RulesFor(gut.version),
      amara_now: amaraThreads().now,
      gbrain_overlay: overlaySummary(gut),
      targets: 'preregistered in eval/registry.ts (open-loops-email): five safety contracts at 0; planted-loop recall >= 0.8, closure accuracy >= 0.95, counterparty accuracy >= 0.95',
    },
    hashes: { ledger_sha256: r.world.fingerprint, outputs_sha256: r.outputs_sha256 ?? '' },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      verdict_detail: r.verdict,
      contracts: r.contracts,
      quality: r.quality,
      exploratory: {
        backfill_nudge_recall: r.detection ? { inbound: r.detection.contested.nudge_inbound, outbound_followup: r.detection.contested.followup_outbound } : null,
        acknowledgement_closes: r.store ? { store_rounds: r.store.ack_rounds, closed: r.store.ack_closed, snapshot_ack_threads_closed: r.rows.filter(x => x.klass === 'ack_thanks' && x.gold.closure_case && x.answer.open?.loop_type !== 'unanswered_inbound').length, snapshot_ack_closure_cases: r.rows.filter(x => x.klass === 'ack_thanks' && x.gold.closure_case).length } : null,
        still_owed_after_close: r.semantic ? { closed_by_my_reply: (r.semantic as Record<string, unknown>).closed_by_my_reply, still_owed: (r.semantic as Record<string, unknown>).still_owed_after_close, rate: (r.semantic as Record<string, unknown>).still_owed_after_close_rate } : null,
        url_question_mark_opens: r.detection?.contested.url_question_mark_opens ?? null,
        steady_state_nudge_hold: r.store ? { rounds: r.store.nudge_rounds, held_open: r.store.nudge_held_open } : null,
        reopen_on_newer_activity: r.store ? { rounds: r.store.reopen_rounds, reopened: r.store.reopened } : null,
        turn_flip_reopens_inbound: r.store ? { rounds: r.store.turn_flip_rounds, reopened: r.store.turn_flip_reopened_inbound } : null,
        ranking: r.ranking ? { ...r.ranking, age_from_detection: r.age_from_detection } : null,
        amara_background: r.amara,
      },
      detection: r.detection,
      store: r.store,
      redaction: r.redaction,
      semantic: r.semantic,
      unsupported: UNSUPPORTED,
      findings: findings.map(f => ({ id: f.id, classification: f.classification, surface: f.surface, expected: f.expected, actual: f.actual, repro: f.repro })),
      failures: r.rows.filter(x => x.gold.open ? !sameOpen(x.answer.open, x.gold.open) : !!x.answer.open).map(x => ({ thread: x.id, klass: x.klass, gold: x.gold.open, detected: x.answer.open, error: x.answer.error })),
      store_steps: r.steps,
      harness_error: r.harnessError,
    },
  };
  writeReceipt(outPath, receipt);

  log(`verdict: ${receipt.run_status === 'completed' ? receipt.verdict : `error (${r.harnessError})`}`);
  if (r.contracts && r.quality && r.detection && r.store) {
    log('safety contracts (target 0):');
    for (const [k, v] of Object.entries(r.contracts)) log(`  ${k}: ${v}`);
    log('quality:');
    log(`  planted-loop recall: ${pct(r.quality.planted_loop_recall)} (${r.detection.planted_detected_right_type} of ${r.detection.planted_open} planted loops; floor 80%)`);
    log(`  planted-loop precision: ${pct(r.quality.planted_loop_precision)} (${r.detection.correct_opens_on_planted} of ${r.detection.opens_on_planted} opens)`);
    log(`  closure accuracy: ${pct(r.quality.closure_accuracy)} (${r.detection.closure_correct + r.store.closure_rounds_correct} of ${r.detection.closure_cases + r.store.closure_rounds}; floor 95%)`);
    log(`  counterparty accuracy: ${pct(r.quality.counterparty_accuracy)} (${r.detection.counterparty_correct} of ${r.detection.counterparty_checked}; floor 95%)`);
    log(`  backfill nudges detected: ${r.detection.contested.nudge_inbound.detected} of ${r.detection.contested.nudge_inbound.n} inbound, ${r.detection.contested.followup_outbound.detected} of ${r.detection.contested.followup_outbound.n} outbound follow-ups`);
    log(`  acknowledgement closes: ${r.store.ack_closed} of ${r.store.ack_rounds} store rounds`);
  }
  log('gbrain findings:');
  for (const f of findings) log(`  ${f.id} [${f.classification}] ${f.surface}: ${f.repro}`);
  if (argv.includes('--record-bugs')) {
    for (const f of findings) upsertBug(f);
    log(`  recorded ${findings.length} findings in ${WAVE_BUG_LEDGER}`);
  }
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, contracts: r.contracts, quality: r.quality }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : r.verdict?.pass ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

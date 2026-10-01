/**
 * BrainBench N12: ingestion format fidelity.
 *
 * Question: when the same conversation arrives in any format gbrain
 * registers, does gbrain keep who said what, when, and how many turns there
 * were, and does it admit what it cannot parse? Separately: on a meeting
 * page, does gbrain tell the people who attended from the people who were
 * only mentioned?
 *
 * Formats are enumerated at run time from gbrain itself, never from a hand
 * list: transcriptAdapters() (src/core/transcripts/detect.ts) and
 * BUILTIN_PATTERNS (src/core/conversation-parser/builtins.ts). Each
 * canonical conversation from eval/generators/n12-format-fidelity-gen.ts is
 * rendered into every format by eval/generators/n12-format-renderers.ts; a
 * registered format with no renderer is a reported coverage miss.
 *
 * Stages (all in process, keyless, LLM fallback and polish off):
 *   adapters   render a host file, detectAdapter() it, parse it with the
 *              registered adapter; score role attribution, timestamp exact
 *              match (instant equality), turn-count error, detection, noise
 *              leaks (skipped record kinds that reach a message), invented
 *              timestamps (an instant not written in the source) and
 *              skipped-line honesty;
 *   roundtrip  the adapter's session rendered to a conversation page by
 *              gbrain's own renderSessionParts and re-parsed by
 *              parseConversation (the import lane's path to facts);
 *   parser     render a page body per built-in pattern and parse it with the
 *              page date in frontmatter and again with no date (the
 *              documented 1970-01-01 fallback);
 *   honesty    non-conversation pages and files (prose, generic JSON, notes
 *              with bold labels, a code doc, a meeting summary, noise-only
 *              sessions, garbage) must yield zero turns;
 *   attendance meeting pages written through put_page on in-memory PGLite;
 *              attended edges read back through get_links and get_backlinks
 *              and scored per evidence form against generator truth.
 *
 * Turn alignment: every canonical turn carries a unique marker. A turn is
 * attributable when exactly one parsed message holds its marker first; a
 * marker that lands after another marker in the same message was merged
 * into the previous turn. Parsed messages with no marker are extra.
 *
 * Accounting: a gbrain exception where an answer is expected is a scored
 * miss (origin sut); a failed presence assertion is a harness error and the
 * run is void.
 *
 * Usage: bun eval/runner/n12-format-fidelity.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { evaluatePromotion, describeOutcome } from './promotion.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import { registryEntry } from '../registry.ts';
import {
  CONTROL_ATTENDANCE_FORM, DOCUMENTED_ATTENDANCE_FORMS, N12_DEFAULT_SEED, N12_GENERATOR_VERSION, generateN12World,
  type AttendanceForm, type Conversation, type GeneratedN12, type MeetingPage,
} from '../generators/n12-format-fidelity-gen.ts';
import {
  ADAPTER_RENDERERS, PATTERN_RENDERER_IDS, renderAdapterNegatives, renderGenericJson, renderPattern,
  type AdapterRender, type ExpectedTurn,
} from '../generators/n12-format-renderers.ts';

export const CATEGORY = 'n12-format-fidelity';
const MIN = 60_000;
const EPOCH_DAY = '1970-01-01';

/** gbrain internals this category imports (receipt field; the overlay identity check catches drift). */
export const INTERNAL_ENTRY_POINTS = [
  'src/core/transcripts/detect.ts transcriptAdapters, detectAdapter',
  'src/core/transcripts/render.ts redactSession, renderSessionParts',
  'src/core/conversation-parser/builtins.ts BUILTIN_PATTERNS',
  'src/core/conversation-parser/parse.ts parseConversation',
  'src/core/pglite-engine.ts PGLiteEngine',
  'src/core/operations.ts operations (put_page, get_links, get_backlinks)',
];

export const DOCUMENTED_LIMITS: ReadonlyArray<{ id: string; limit: string; source: string }> = [
  { id: 'generic-json', limit: 'No adapter reads a generic role/content JSON transcript, and a JSON body is no_match for the conversation parser.', source: 'capability matrix N12 (P8); src/core/transcripts/detect.ts registry' },
  { id: 'epoch-date-fallback', limit: 'Time-only and no-time patterns stamp 1970-01-01 when the page has no date.', source: 'src/core/conversation-parser/types.ts MatchedMessage.timestamp' },
  { id: 'minute-precision', limit: 'Built-in patterns capture hours and minutes only; seconds written in the line are dropped.', source: 'src/core/conversation-parser/types.ts CaptureMap (no seconds group)' },
  { id: 'grok-session-times', limit: 'Grok chat_history.jsonl has no per-message times; every turn but the last gets summary.json created_at and the last gets last_active_at.', source: 'src/core/transcripts/grok.ts header and GROK_SPEC_TARGET' },
  { id: 'roles-only', limit: 'Transcript adapters attribute turns by role (user or assistant); no adapter sets a display speaker at this commit.', source: 'src/core/transcripts/types.ts TranscriptMessage.speaker (optional)' },
  { id: 'attendance-not-parser', limit: 'Attendance is a link-extraction stage, not a parser output; transcript speakers and other list labels are not attendance evidence.', source: 'capability matrix N12; src/core/link-extraction.ts attendanceEvidenceRanges' },
  { id: 'llm-fallback-off', limit: 'The LLM fallback and polish phases are not measured (keyless; polish is declared but not wired).', source: 'capability matrix N12' },
];

// ─── Pure scoring (exported for tests) ──────────────────────────────────

export interface ParsedTurn { speaker: string; timestamp: string; text: string }

export interface TurnOutcome {
  marker: string;
  found: boolean;
  /** Marker was the first marker in its message (not merged into an earlier turn). */
  attributable: boolean;
  speaker_ok: boolean;
  /** null when the format carries no time for this turn. */
  ts_ok: boolean | null;
  /** Exact at minute precision (the parser's documented precision); null when not scored. */
  ts_minute_ok: boolean | null;
  ts_true_ok: boolean;
  parsed_speaker: string | null;
  parsed_ts: string | null;
}

export interface Alignment {
  turns: TurnOutcome[];
  expected: number;
  parsed: number;
  extra: number;
  duplicates: number;
  merged: number;
}

export const normLabel = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const instant = (s: string | null | undefined) => (s ? Date.parse(s) : Number.NaN);

export function alignTurns(expected: readonly ExpectedTurn[], parsed: readonly ParsedTurn[]): Alignment {
  const markers = expected.map(e => e.marker);
  const hits = parsed.map(m => markers.filter(k => m.text.includes(k)).sort((a, b) => m.text.indexOf(a) - m.text.indexOf(b)));
  let duplicates = 0;
  const turns = expected.map(e => {
    const holders = parsed.map((_, i) => i).filter(i => hits[i].includes(e.marker));
    if (holders.length > 1) duplicates += holders.length - 1;
    const at = holders[0];
    if (at === undefined) return { marker: e.marker, found: false, attributable: false, speaker_ok: false, ts_ok: e.ts_representable === null ? null : false, ts_minute_ok: e.ts_representable === null ? null : false, ts_true_ok: false, parsed_speaker: null, parsed_ts: null };
    const m = parsed[at];
    const attributable = hits[at][0] === e.marker;
    const t = instant(m.timestamp);
    const speakerOk = attributable && e.labels.some(l => normLabel(l) === normLabel(m.speaker));
    const tsOk = e.ts_representable === null ? null : attributable && t === e.ts_representable;
    const tsMinute = e.ts_representable === null ? null : attributable && t === e.ts_representable - (e.ts_representable % MIN);
    return { marker: e.marker, found: true, attributable, speaker_ok: speakerOk, ts_ok: tsOk, ts_minute_ok: tsMinute, ts_true_ok: attributable && t === e.ts_true, parsed_speaker: m.speaker, parsed_ts: m.timestamp };
  });
  return {
    turns, expected: expected.length, parsed: parsed.length,
    extra: hits.filter(h => h.length === 0).length,
    duplicates,
    merged: turns.filter(t => t.found && !t.attributable).length,
  };
}

export interface StageTotals {
  items: number;
  turns: number;
  attributable: number;
  speaker_correct: number;
  speaker_accuracy: number;
  ts_scored: number;
  ts_exact: number;
  ts_exact_rate: number;
  ts_minute_exact: number;
  ts_minute_exact_rate: number;
  ts_true_exact: number;
  ts_true_exact_rate: number;
  turn_count_abs_error_sum: number;
  turn_count_mae: number;
  items_with_exact_turn_count: number;
  extra_messages: number;
  duplicated_turns: number;
  merged_turns: number;
}

const rate = (n: number, d: number) => (d ? n / d : 0);

export function totals(aligns: readonly Alignment[]): StageTotals {
  const ts = aligns.flatMap(a => a.turns).filter(t => t.ts_ok !== null);
  const all = aligns.flatMap(a => a.turns);
  const err = aligns.reduce((n, a) => n + Math.abs(a.parsed - a.expected), 0);
  const t: StageTotals = {
    items: aligns.length, turns: all.length,
    attributable: all.filter(x => x.attributable).length,
    speaker_correct: all.filter(x => x.speaker_ok).length, speaker_accuracy: 0,
    ts_scored: ts.length, ts_exact: ts.filter(x => x.ts_ok).length, ts_exact_rate: 0,
    ts_minute_exact: ts.filter(x => x.ts_minute_ok).length, ts_minute_exact_rate: 0,
    ts_true_exact: all.filter(x => x.ts_true_ok).length, ts_true_exact_rate: 0,
    turn_count_abs_error_sum: err, turn_count_mae: rate(err, aligns.length),
    items_with_exact_turn_count: aligns.filter(a => a.parsed === a.expected).length,
    extra_messages: aligns.reduce((n, a) => n + a.extra, 0),
    duplicated_turns: aligns.reduce((n, a) => n + a.duplicates, 0),
    merged_turns: aligns.reduce((n, a) => n + a.merged, 0),
  };
  t.speaker_accuracy = rate(t.speaker_correct, t.turns);
  t.ts_exact_rate = rate(t.ts_exact, t.ts_scored);
  t.ts_minute_exact_rate = rate(t.ts_minute_exact, t.ts_scored);
  t.ts_true_exact_rate = rate(t.ts_true_exact, t.turns);
  return t;
}

/** An item where every turn came back attributable with the right speaker or role. */
export const recovered = (a: Alignment) => a.turns.every(t => t.speaker_ok);

/** Noise markers that reached any message. */
export function noiseLeaks(markers: readonly string[], parsed: readonly ParsedTurn[]): string[] {
  return markers.filter(k => parsed.some(m => m.text.includes(k)));
}

/** Message timestamps that are not an instant written in the source. Empty timestamps are missing, not invented. */
export function inventedTimestamps(allowed: readonly number[], parsed: readonly ParsedTurn[]): string[] {
  const ok = new Set(allowed);
  return parsed.map(m => m.timestamp).filter(ts => ts !== '' && !ok.has(Date.parse(ts)));
}

export interface AttendanceRow {
  meeting: string;
  form: AttendanceForm;
  attendees: string[];
  mentioned: string[];
  attended: string[];
  links_seen: number;
}

export function scoreAttendance(rows: readonly AttendanceRow[]) {
  const per = (sel: readonly AttendanceRow[]) => {
    let tp = 0, fp = 0, fn = 0, falseAttended = 0;
    for (const r of sel) {
      const gold = new Set(r.attendees);
      const got = new Set(r.attended);
      for (const s of got) { if (gold.has(s)) tp++; else fp++; if (r.mentioned.includes(s)) falseAttended++; }
      for (const s of gold) if (!got.has(s)) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 1;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return { meetings: sel.length, attendees: tp + fn, tp, fp, fn, false_attended: falseAttended, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
  };
  const forms = [...new Set(rows.map(r => r.form))];
  const all = per(rows);
  const documented = per(rows.filter(r => DOCUMENTED_ATTENDANCE_FORMS.includes(r.form)));
  return {
    ...all,
    false_attended: rows.reduce((n, r) => n + r.attended.filter(s => !r.attendees.includes(s)).length, 0),
    mentioned_typed_attended: all.false_attended,
    documented,
    control_recall: per(rows.filter(r => r.form === CONTROL_ATTENDANCE_FORM)).recall,
    by_form: Object.fromEntries(forms.map(f => [f, { documented: DOCUMENTED_ATTENDANCE_FORMS.includes(f), ...per(rows.filter(r => r.form === f)) }])),
  };
}

// ─── gbrain under test ─────────────────────────────────────────────────

export interface FileDiagnostics { bytesRead: number; skippedLines: number; truncated: boolean; sessions: number; zeroSessionsReason?: string; expectedEmpty?: boolean }
export interface ParsedSession { meta: Record<string, unknown> & { harness: string; sessionId: string; startedAt?: string }; messages: Array<{ role: string; speaker?: string; timestamp: string; text: string }> }
export interface TranscriptAdapter { format: string; parse(path: string): AsyncGenerator<ParsedSession, FileDiagnostics> }
export interface ParseResult { messages: ParsedTurn[]; phase: string; matched_pattern_id?: string; timezone_warning?: string; unrecognized_headings?: string[]; date_fallback_count?: number }

export interface Sut {
  adapters: TranscriptAdapter[];
  detect(path: string): { ok: boolean; format: string | null; reason?: string };
  patterns: string[];
  parse(body: string, date: string | null): ParseResult;
  roundtrip(session: ParsedSession, sourcePath: string): ParsedTurn[];
}

export async function openSut(gut: GbrainUnderTest): Promise<Sut> {
  const detect = await importGbrain<{ transcriptAdapters(): TranscriptAdapter[]; detectAdapter(p: string): { ok: true; adapter: TranscriptAdapter } | { ok: false; reason: string } }>(gut, 'src/core/transcripts/detect.ts');
  const builtins = await importGbrain<{ BUILTIN_PATTERNS: ReadonlyArray<{ id: string }> }>(gut, 'src/core/conversation-parser/builtins.ts');
  const parser = await importGbrain<{ parseConversation(body: string, opts: Record<string, unknown>): ParseResult }>(gut, 'src/core/conversation-parser/parse.ts');
  const render = await importGbrain<{
    redactSession(s: ParsedSession, o: { patterns: unknown[] }): unknown;
    renderSessionParts(r: unknown, o: { sourcePath: string }): { parts: Array<{ body: string; frontmatter: Record<string, unknown> }> };
  }>(gut, 'src/core/transcripts/render.ts');
  const parse = (body: string, date: string | null) => parser.parseConversation(body, { noFallback: true, noPolish: true, ...(date ? { page: { frontmatter: { date }, type: 'conversation' } } : {}) });
  return {
    adapters: detect.transcriptAdapters(),
    detect: p => { const r = detect.detectAdapter(p); return r.ok ? { ok: true, format: r.adapter.format } : { ok: false, format: null, reason: r.reason }; },
    patterns: builtins.BUILTIN_PATTERNS.map(p => p.id),
    parse,
    roundtrip: (session, sourcePath) => {
      const rendered = render.renderSessionParts(render.redactSession(session, { patterns: [] }), { sourcePath });
      return rendered.parts.flatMap(part => parse(part.body, typeof part.frontmatter.date === 'string' ? part.frontmatter.date : null).messages);
    },
  };
}

async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>): Promise<{ sessions: ParsedSession[]; diag: FileDiagnostics }> {
  const sessions: ParsedSession[] = [];
  let r = await gen.next();
  while (!r.done) { sessions.push(r.value); r = await gen.next(); }
  return { sessions, diag: r.value };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── Stages ────────────────────────────────────────────────────────────

export interface AdapterItem {
  format: string;
  conversation: string;
  kind: string;
  detected: string | null;
  detection_ok: boolean;
  sessions: number;
  skipped_lines: number | null;
  malformed_written: number;
  skipped_lines_honest: boolean | null;
  noise_leaks: string[];
  invented: string[];
  missing_timestamps: number;
  non_utc_stamps: number;
  stamp_style: AdapterRender['stamp_style'];
  error: string | null;
  align: Alignment;
  roundtrip: Alignment | null;
  roundtrip_error: string | null;
}

export interface ParserItem {
  pattern: string;
  conversation: string;
  kind: string;
  carries: string;
  phase: string;
  matched_pattern: string | null;
  detection_ok: boolean;
  diagnostics: string[];
  align: Alignment;
  nodate_phase: string;
  nodate_epoch_turns: number;
  nodate_inline_date_lost: number;
  seconds_dropped: number;
  error: string | null;
}

export async function adapterStage(sut: Sut, convs: readonly Conversation[], root: string, acc: ProbeAccounting) {
  const items: AdapterItem[] = [];
  for (const adapter of sut.adapters) {
    const renderer = ADAPTER_RENDERERS[adapter.format];
    if (!renderer) continue;
    for (const c of convs) {
      const dir = join(root, 'adapters', adapter.format, c.id);
      mkdirSync(dir, { recursive: true });
      const r = renderer(c, dir);
      const det = sut.detect(r.path);
      let parsed: ParsedTurn[] = [];
      let sessions: ParsedSession[] = [];
      let diag: FileDiagnostics | null = null;
      let error: string | null = null;
      try {
        ({ sessions, diag } = await drain(adapter.parse(r.path)));
        parsed = sessions.flatMap(s => s.messages.map(m => ({ speaker: m.role, timestamp: m.timestamp, text: m.text })));
      } catch (e) {
        error = errMsg(e);
        acc.error(`adapter:${adapter.format}:${c.id}`, 'sut', error);
      }
      let roundtrip: Alignment | null = null;
      let roundtripError: string | null = null;
      if (sessions.length) {
        const expectedRt = r.expected.map(e => ({ ...e, labels: [e.role === 'user' ? 'User' : 'Assistant'], ts_representable: e.ts_representable === null ? null : e.ts_representable - (e.ts_representable % MIN), seconds_in_text: false }));
        try {
          roundtrip = alignTurns(expectedRt, sessions.flatMap(s => sut.roundtrip(s, r.path)));
        } catch (e) {
          roundtripError = errMsg(e);
          acc.error(`roundtrip:${adapter.format}:${c.id}`, 'sut', roundtripError);
          roundtrip = alignTurns(expectedRt, []);
        }
      }
      items.push({
        format: adapter.format, conversation: c.id, kind: c.kind,
        detected: det.format, detection_ok: det.format === adapter.format,
        sessions: sessions.length,
        skipped_lines: diag?.skippedLines ?? null, malformed_written: r.malformed_lines,
        skipped_lines_honest: diag && r.malformed_lines > 0 ? diag.skippedLines === r.malformed_lines : null,
        noise_leaks: noiseLeaks(r.noise_markers, parsed),
        invented: inventedTimestamps(r.allowed_instants, parsed),
        missing_timestamps: parsed.filter(m => m.timestamp === '').length,
        non_utc_stamps: parsed.filter(m => m.timestamp !== '' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(m.timestamp)).length,
        stamp_style: r.stamp_style,
        error,
        align: alignTurns(r.expected, parsed),
        roundtrip, roundtrip_error: roundtripError,
      });
    }
  }
  return items;
}

export function parserStage(sut: Sut, convs: readonly Conversation[], acc: ProbeAccounting): ParserItem[] {
  const items: ParserItem[] = [];
  for (const pattern of sut.patterns) {
    for (const c of convs) {
      const r = renderPattern(pattern, c);
      if (!r) continue;
      let res: ParseResult = { messages: [], phase: 'error' };
      let nodate: ParseResult = { messages: [], phase: 'error' };
      let error: string | null = null;
      try {
        res = sut.parse(r.body, r.page_date);
        nodate = sut.parse(r.body, null);
      } catch (e) {
        error = errMsg(e);
        acc.error(`parser:${pattern}:${c.id}`, 'sut', error);
      }
      const align = alignTurns(r.expected, res.messages);
      const nodateAlign = alignTurns(r.expected, nodate.messages);
      const diagnostics = [
        ...(res.unrecognized_headings?.length ? [`unrecognized_headings:${res.unrecognized_headings.length}`] : []),
        ...(res.date_fallback_count ? [`date_fallback_count:${res.date_fallback_count}`] : []),
      ];
      items.push({
        pattern, conversation: c.id, kind: c.kind, carries: r.carries,
        phase: res.phase, matched_pattern: res.matched_pattern_id ?? null, detection_ok: res.matched_pattern_id === pattern,
        diagnostics, align,
        nodate_phase: nodate.phase,
        nodate_epoch_turns: nodateAlign.turns.filter(t => t.parsed_ts?.startsWith(EPOCH_DAY)).length,
        nodate_inline_date_lost: r.carries === 'date-time' ? nodateAlign.turns.filter((t, i) => t.attributable && align.turns[i].attributable && t.parsed_ts !== align.turns[i].parsed_ts).length : 0,
        seconds_dropped: r.expected.filter((e, i) => e.seconds_in_text && e.ts_representable !== null && e.ts_representable % MIN !== 0 && align.turns[i].ts_minute_ok === true && align.turns[i].ts_ok === false).length,
        error,
      });
    }
  }
  return items;
}

export interface HonestyItem { id: string; surface: 'parser' | 'adapter'; format: string | null; kind: string; messages: number; phase_or_sessions: string; reason: string | null; error: string | null }

export async function honestyStage(sut: Sut, world: GeneratedN12, root: string, acc: ProbeAccounting): Promise<HonestyItem[]> {
  const items: HonestyItem[] = [];
  for (const n of world.ledger.negative_pages) {
    try {
      const r = sut.parse(n.body, '2026-04-01');
      items.push({ id: n.id, surface: 'parser', format: null, kind: n.kind, messages: r.messages.length, phase_or_sessions: r.phase, reason: null, error: null });
    } catch (e) {
      acc.error(`honesty:${n.id}`, 'sut', errMsg(e));
      items.push({ id: n.id, surface: 'parser', format: null, kind: n.kind, messages: 0, phase_or_sessions: 'error', reason: null, error: errMsg(e) });
    }
  }
  for (const adapter of sut.adapters) {
    for (const neg of renderAdapterNegatives(adapter.format, join(root, 'negatives', adapter.format))) {
      const id = `${adapter.format}:${neg.kind}`;
      try {
        const { sessions, diag } = await drain(adapter.parse(neg.path));
        items.push({ id, surface: 'adapter', format: adapter.format, kind: neg.kind, messages: sessions.reduce((n, s) => n + s.messages.length, 0), phase_or_sessions: `sessions=${diag.sessions}`, reason: diag.zeroSessionsReason ?? null, error: null });
      } catch (e) {
        // A refusal is honest: it yields no turns. Recorded, not scored as a miss.
        items.push({ id, surface: 'adapter', format: adapter.format, kind: neg.kind, messages: 0, phase_or_sessions: 'threw', reason: errMsg(e), error: errMsg(e) });
      }
    }
  }
  return items;
}

/**
 * The schema pack `gbrain init` writes (src/commands/init.ts: 'gbrain-base-v2').
 * The pack decides link verbs on put_page, so the attendance stage configures
 * the brain the way a fresh install does. The `null` arm leaves schema_pack
 * unset, which falls back to the bundled legacy `gbrain-base` pack.
 */
export const INIT_SCHEMA_PACK = 'gbrain-base-v2';

async function attendanceStage(gut: GbrainUnderTest, world: GeneratedN12, schemaPack: string | null): Promise<{ rows: AttendanceRow[]; presence: PresenceCheck[]; write_errors: string[] }> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => { connect(o: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; setConfig(k: string, v: string): Promise<void> } }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler(ctx: unknown, p: Record<string, unknown>): Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  if (schemaPack) await engine.setConfig('schema_pack', schemaPack);
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default' };
  const op = async (name: string, p: Record<string, unknown>) => {
    const o = operations.find(x => x.name === name);
    if (!o) throw new Error(`gbrain has no operation ${name}`);
    return await o.handler(ctx, p);
  };
  const writeErrors: string[] = [];
  try {
    for (const p of world.ledger.people) {
      try { await op('put_page', { slug: p.slug, content: `---\ntype: person\ntitle: ${p.name}\n---\n# ${p.name}\n\nA synthetic person page.\n` }); } catch (e) { writeErrors.push(`${p.slug}: ${errMsg(e)}`); }
    }
    for (const m of world.ledger.meetings) {
      try { await op('put_page', { slug: m.slug, content: m.content }); } catch (e) { writeErrors.push(`${m.slug}: ${errMsg(e)}`); }
    }
    const rows: AttendanceRow[] = [];
    type Link = { from_slug?: string; to_slug?: string; link_type?: string };
    for (const m of world.ledger.meetings) {
      const out = ((await op('get_links', { slug: m.slug })) ?? []) as Link[];
      const inc = ((await op('get_backlinks', { slug: m.slug })) ?? []) as Link[];
      const attended = new Set<string>();
      for (const l of [...out, ...inc]) {
        const other = l.from_slug === m.slug ? l.to_slug : l.from_slug;
        if (l.link_type === 'attended' && other?.startsWith('people/')) attended.add(other);
      }
      rows.push({ meeting: m.slug, form: m.form, attendees: m.attendees, mentioned: m.mentioned, attended: [...attended].sort(), links_seen: out.length + inc.length });
    }
    const pages = await op('list_pages', { limit: 500 }).catch(() => null) as Array<{ slug: string }> | { pages?: Array<{ slug: string }> } | null;
    const slugs = new Set((Array.isArray(pages) ? pages : pages?.pages ?? []).map(p => p.slug));
    const presence: PresenceCheck[] = [
      { name: 'meeting pages written', expected: world.ledger.meetings.length, actual: world.ledger.meetings.filter(m => slugs.has(m.slug)).length, ok: world.ledger.meetings.every(m => slugs.has(m.slug)) },
      { name: 'person pages written', expected: world.ledger.people.length, actual: world.ledger.people.filter(p => slugs.has(p.slug)).length, ok: world.ledger.people.every(p => slugs.has(p.slug)) },
      // Link extraction ran: every meeting links its mentioned-only people in the body.
      { name: 'meetings with extracted links', expected: rows.length, actual: rows.filter(r => r.links_seen > 0).length, ok: rows.every(r => r.links_seen > 0) },
    ];
    return { rows, presence, write_errors: writeErrors };
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

export interface PresenceCheck { name: string; expected: number; actual: number; ok: boolean }

// ─── Summary ───────────────────────────────────────────────────────────

const byKey = <T>(xs: readonly T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

export function summarizeN12(input: {
  adapterFormats: string[]; patternIds: string[];
  adapters: AdapterItem[]; parser: ParserItem[]; honesty: HonestyItem[]; attendance: AttendanceRow[];
  genericJson: { detected: string | null; reason: string | null; parser_phase: string };
}) {
  const { adapters, parser, honesty } = input;
  const rendered = (ids: string[], have: (id: string) => boolean) => ids.filter(have);
  const adapterRendered = rendered(input.adapterFormats, f => f in ADAPTER_RENDERERS);
  const patternRendered = rendered(input.patternIds, p => PATTERN_RENDERER_IDS.includes(p));
  const unrendered = [...input.adapterFormats.filter(f => !(f in ADAPTER_RENDERERS)), ...input.patternIds.filter(p => !PATTERN_RENDERER_IDS.includes(p))];
  const stale = [...Object.keys(ADAPTER_RENDERERS).filter(f => !input.adapterFormats.includes(f)), ...PATTERN_RENDERER_IDS.filter(p => !input.patternIds.includes(p))];
  const registered = input.adapterFormats.length + input.patternIds.length;
  const adapterAligns = adapters.map(a => a.align);
  const controlItems = [...adapters.filter(a => a.kind === 'control').map(a => a.align), ...parser.filter(p => p.kind === 'control').map(p => p.align)];
  const perFormat = Object.fromEntries([...byKey(adapters, a => a.format)].map(([f, xs]) => [f, {
    ...totals(xs.map(x => x.align)),
    detection_ok: xs.filter(x => x.detection_ok).length,
    noise_leaks: xs.reduce((n, x) => n + x.noise_leaks.length, 0),
    invented_timestamps: xs.reduce((n, x) => n + x.invented.length, 0),
    non_utc_stamps: xs.reduce((n, x) => n + x.non_utc_stamps, 0),
    roundtrip: totals(xs.flatMap(x => (x.roundtrip ? [x.roundtrip] : []))),
  }]));
  const perPattern = Object.fromEntries([...byKey(parser, p => p.pattern)].map(([p, xs]) => [p, {
    carries: xs[0].carries,
    ...totals(xs.map(x => x.align)),
    detection_ok: xs.filter(x => x.detection_ok).length,
    nodate_epoch_turns: xs.reduce((n, x) => n + x.nodate_epoch_turns, 0),
    seconds_dropped: xs.reduce((n, x) => n + x.seconds_dropped, 0),
  }]));
  const byKind = (items: Array<{ kind: string; align: Alignment }>) => Object.fromEntries([...byKey(items, i => i.kind)].map(([k, xs]) => [k, totals(xs.map(x => x.align))]));
  const offsetItems = adapters.filter(a => a.stamp_style === 'offset');
  const lineFormats = adapters.filter(a => a.skipped_lines_honest !== null);
  const fabricated = honesty.reduce((n, h) => n + h.messages, 0);
  const positiveSilent = parser.filter(p => p.phase === 'regex_match' && !recovered(p.align) && p.diagnostics.length === 0);
  return {
    coverage: {
      adapter_formats: input.adapterFormats, parser_patterns: input.patternIds,
      registered, rendered: adapterRendered.length + patternRendered.length,
      coverage_rate: rate(adapterRendered.length + patternRendered.length, registered),
      unrendered_formats: unrendered, stale_renderers: stale,
    },
    adapters: {
      ...totals(adapterAligns),
      detection_ok: adapters.filter(a => a.detection_ok).length,
      detection_accuracy: rate(adapters.filter(a => a.detection_ok).length, adapters.length),
      noise_markers_leaked: adapters.flatMap(a => a.noise_leaks.map(k => `${a.format}:${a.conversation}:${k}`)),
      noise_leaks: adapters.reduce((n, a) => n + a.noise_leaks.length, 0),
      invented_timestamps: adapters.reduce((n, a) => n + a.invented.length, 0),
      missing_timestamps: adapters.reduce((n, a) => n + a.missing_timestamps, 0),
      non_utc_stamps: adapters.reduce((n, a) => n + a.non_utc_stamps, 0),
      offset_source_items: offsetItems.length,
      offset_source_non_utc_stamps: offsetItems.reduce((n, a) => n + a.non_utc_stamps, 0),
      skipped_lines_items: lineFormats.length,
      skipped_lines_honest: lineFormats.filter(a => a.skipped_lines_honest).length,
      errors: adapters.filter(a => a.error).length,
      by_format: perFormat,
      by_kind: byKind(adapters),
    },
    roundtrip: {
      ...totals(adapters.flatMap(a => (a.roundtrip ? [a.roundtrip] : []))),
      errors: adapters.filter(a => a.roundtrip_error).length,
      offset_source: totals(offsetItems.flatMap(a => (a.roundtrip ? [a.roundtrip] : []))),
      utc_source: totals(adapters.filter(a => a.stamp_style !== 'offset').flatMap(a => (a.roundtrip ? [a.roundtrip] : []))),
    },
    parser: {
      ...totals(parser.map(p => p.align)),
      pattern_detection_ok: parser.filter(p => p.detection_ok).length,
      pattern_detection_accuracy: rate(parser.filter(p => p.detection_ok).length, parser.length),
      no_match_items: parser.filter(p => p.phase === 'no_match').length,
      nodate_epoch_turns: parser.reduce((n, p) => n + p.nodate_epoch_turns, 0),
      nodate_epoch_turns_denominator: parser.filter(p => p.carries !== 'date-time').reduce((n, p) => n + p.align.expected, 0),
      nodate_inline_date_lost: parser.reduce((n, p) => n + p.nodate_inline_date_lost, 0),
      seconds_dropped: parser.reduce((n, p) => n + p.seconds_dropped, 0),
      seconds_carried_turns: parser.filter(p => perPatternCarriesSeconds(p)).reduce((n, p) => n + p.align.expected, 0),
      errors: parser.filter(p => p.error).length,
      by_pattern: perPattern,
      by_kind: byKind(parser),
      by_carries: Object.fromEntries([...byKey(parser, p => p.carries)].map(([k, xs]) => [k, totals(xs.map(x => x.align))])),
    },
    honesty: {
      negative_items: honesty.length,
      fabricated,
      fabricated_items: honesty.filter(h => h.messages > 0).map(h => h.id),
      zero_sessions_without_reason: honesty.filter(h => h.surface === 'adapter' && h.messages === 0 && !h.reason).map(h => h.id),
      silent_misparse_items: positiveSilent.length,
      silent_misparse: positiveSilent.map(p => `${p.pattern}:${p.conversation}`),
      generic_json: input.genericJson,
    },
    attendance: scoreAttendance(input.attendance),
    floor: {
      control_items: controlItems.length,
      control_recovered: controlItems.filter(recovered).length,
      control_recovered_rate: rate(controlItems.filter(recovered).length, controlItems.length),
      control_failures: [...adapters.filter(a => a.kind === 'control' && !recovered(a.align)).map(a => `adapter:${a.format}`), ...parser.filter(p => p.kind === 'control' && !recovered(p.align)).map(p => `pattern:${p.pattern}`)],
    },
  };
}

function perPatternCarriesSeconds(p: ParserItem): boolean {
  return ['bold-paren-time', 'telegram-text-export', 'whatsapp-iso', 'signal-export'].includes(p.pattern);
}

export type N12Summary = ReturnType<typeof summarizeN12>;

// ─── Run ───────────────────────────────────────────────────────────────

export interface N12RunResult {
  world: GeneratedN12;
  summary: N12Summary | null;
  adapters: AdapterItem[];
  parser: ParserItem[];
  honesty: HonestyItem[];
  attendance: AttendanceRow[];
  /** Exploratory arm: schema_pack unset (legacy gbrain-base fallback). */
  attendance_legacy_pack: AttendanceRow[];
  presence: PresenceCheck[];
  acc: ProbeAccounting;
  harnessError: string | null;
  write_errors: string[];
}

export async function runN12(opts: { gut: GbrainUnderTest; seed?: number; log?: (s: string) => void }): Promise<N12RunResult> {
  return withHermeticEnv('n12', () => runN12Hermetic(opts));
}

async function runN12Hermetic(opts: { gut: GbrainUnderTest; seed?: number; log?: (s: string) => void }): Promise<N12RunResult> {
  const log = opts.log ?? (() => {});
  const world = generateN12World({ seed: opts.seed ?? N12_DEFAULT_SEED });
  const convs = world.ledger.conversations;
  const root = mkdtempSync(join(tmpdir(), 'n12-render-'));
  const result: N12RunResult = { world, summary: null, adapters: [], parser: [], honesty: [], attendance: [], attendance_legacy_pack: [], presence: [], acc: new ProbeAccounting(0), harnessError: null, write_errors: [] };
  try {
    const sut = await openSut(opts.gut);
    const adapterFormats = sut.adapters.map(a => a.format);
    const planned = adapterFormats.filter(f => f in ADAPTER_RENDERERS).length * convs.length
      + sut.patterns.filter(p => PATTERN_RENDERER_IDS.includes(p)).length * convs.length
      + world.ledger.negative_pages.length + world.ledger.meetings.length;
    const acc = new ProbeAccounting(planned);
    result.acc = acc;
    log(`registered: ${adapterFormats.length} transcript adapters [${adapterFormats.join(', ')}], ${sut.patterns.length} parser patterns`);
    result.presence.push(
      { name: 'transcript adapters enumerated', expected: 1, actual: adapterFormats.length, ok: adapterFormats.length > 0 },
      { name: 'parser patterns enumerated', expected: 1, actual: sut.patterns.length, ok: sut.patterns.length > 0 },
    );
    result.adapters = await adapterStage(sut, convs, root, acc);
    result.parser = parserStage(sut, convs, acc);
    result.honesty = await honestyStage(sut, world, root, acc);
    const gj = renderGenericJson(convs[0], root);
    const gjDetect = sut.detect(gj.path);
    const gjParse = sut.parse(JSON.stringify(JSON.parse(await Bun.file(gj.path).text())), convs[0].turns[0].at.slice(0, 10));
    const att = await attendanceStage(opts.gut, world, INIT_SCHEMA_PACK);
    result.attendance = att.rows;
    result.attendance_legacy_pack = (await attendanceStage(opts.gut, world, null)).rows;
    result.write_errors = att.write_errors;
    result.presence.push(...att.presence);
    const failed = result.presence.filter(p => !p.ok);
    if (failed.length) {
      const msg = `Presence check failed: ${failed.map(f => `${f.name} expected ${f.expected} got ${f.actual}`).join('; ')}, so a zero false-attendance or zero fabrication count would mean nothing. The run is void (error, not pass).${att.write_errors.length ? ` First write error: ${att.write_errors[0]}` : ''}`;
      acc.error('presence', 'harness', msg);
      result.harnessError = msg;
      return result;
    }
    // One probe per item; an item scores 1 when every turn came back with the right speaker (sut errors already scored 0).
    for (const x of result.adapters) if (!x.error) acc.score(`adapter:${x.format}:${x.conversation}`, recovered(x.align) ? 1 : 0);
    for (const x of result.parser) if (!x.error) acc.score(`parser:${x.pattern}:${x.conversation}`, recovered(x.align) ? 1 : 0);
    for (const x of result.honesty.filter(h => h.surface === 'parser')) if (!x.error) acc.score(`honesty:${x.id}`, x.messages === 0 ? 1 : 0);
    for (const x of result.attendance) acc.score(`attendance:${x.meeting}`, x.attendees.every(s => x.attended.includes(s)) && x.attended.every(s => x.attendees.includes(s)) ? 1 : 0);
    result.summary = summarizeN12({
      adapterFormats, patternIds: sut.patterns, adapters: result.adapters, parser: result.parser, honesty: result.honesty, attendance: result.attendance,
      genericJson: { detected: gjDetect.format, reason: gjDetect.reason ?? null, parser_phase: gjParse.phase },
    });
    return result;
  } catch (e) {
    const msg = `harness: ${errMsg(e)}`;
    result.acc.error('run', 'harness', msg);
    result.harnessError = msg;
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? N12_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench N12: ingestion format fidelity (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const r = await runN12({ gut, seed, log });
  const a = r.acc.summary();
  const s = r.summary;
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped, LLM fallback and polish off, keyword-only PGLite; no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessError ? 'error' : 'completed',
    ...(r.harnessError ? {} : { verdict: 'fail' as const }),
    n_total: a.n_total,
    n_scored: a.n_scored,
    completion_rate: a.completion_rate,
    errors: a.errors,
    publishable: !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory (attendance stage only)',
      schema_pack: `${INIT_SCHEMA_PACK} (what gbrain init writes); exploratory arm with schema_pack unset`,
      decide: DECIDE_OFF,
      caller: 'in-process gbrain internals and operation handlers with OperationContext { remote: false, sourceId: default }',
      parser_options: { noFallback: true, noPolish: true, page_date: 'frontmatter date = first turn UTC date; the no-date arm passes no page' },
      seed,
      generator_version: N12_GENERATOR_VERSION,
      ledger_sha256: r.world.fingerprint,
      internal_entry_points: INTERNAL_ENTRY_POINTS,
      gbrain_overlay: overlaySummary(gut),
      runtime_ms: Date.now() - t0,
    },
    hashes: { ledger_sha256: r.world.fingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      ...(s ?? {}),
      presence: r.presence,
      documented_limits: DOCUMENTED_LIMITS,
      write_errors: r.write_errors,
      adapter_items: r.adapters,
      parser_items: r.parser,
      honesty_items: r.honesty,
      attendance_rows: r.attendance,
      attendance_legacy_pack: { schema_pack: 'unset (falls back to bundled gbrain-base)', ...scoreAttendance(r.attendance_legacy_pack), rows: r.attendance_legacy_pack },
      harness_error: r.harnessError,
    },
  };
  // Verdict is the preregistered safety contracts only (amendment 1, plan section 8); quality floors are reported beside it.
  const rules = registryEntry('N12')?.promotion;
  const outcome = rules ? evaluatePromotion({ ...rules, quality_thresholds: [] }, receipt) : null;
  const full = rules ? evaluatePromotion(rules, receipt) : null;
  if (!r.harnessError && outcome) receipt.verdict = outcome.pass ? 'pass' : 'fail';
  if (full) (receipt.data as Record<string, unknown>).promotion = { pass: full.pass, results: full.results };
  writeReceipt(outPath, receipt);

  if (s && full) {
    log(`\nverdict: ${receipt.verdict} (safety contracts only); promotion rules: ${describeOutcome(full)}`);
    log(`safety: fabricated turns ${s.honesty.fabricated} of ${s.honesty.negative_items} negative items; noise leaks ${s.adapters.noise_leaks}; invented timestamps ${s.adapters.invented_timestamps}; false attendance ${s.attendance.false_attended}`);
    log(`floors: control conversation recovered in ${s.floor.control_recovered} of ${s.floor.control_items} rendered formats; ## Attendees recall ${pct(s.attendance.control_recall)}`);
    log(`coverage: ${s.coverage.rendered} of ${s.coverage.registered} registered formats rendered${s.coverage.unrendered_formats.length ? `; no renderer: ${s.coverage.unrendered_formats.join(', ')}` : ''}`);
    log(`adapters: role ${pct(s.adapters.speaker_accuracy)} of ${s.adapters.turns} turns; timestamp exact ${pct(s.adapters.ts_exact_rate)} of ${s.adapters.ts_scored}; turn-count MAE ${s.adapters.turn_count_mae.toFixed(2)} over ${s.adapters.items} files; detection ${s.adapters.detection_ok}/${s.adapters.items}`);
    log(`roundtrip (adapter -> page -> parser): speaker ${pct(s.roundtrip.speaker_accuracy)} of ${s.roundtrip.turns}; timestamp exact (minute) ${pct(s.roundtrip.ts_exact_rate)} of ${s.roundtrip.ts_scored}`);
    log(`parser: speaker ${pct(s.parser.speaker_accuracy)} of ${s.parser.turns} turns; timestamp exact (minute) ${pct(s.parser.ts_minute_exact_rate)} of ${s.parser.ts_scored} timed turns; turn-count MAE ${s.parser.turn_count_mae.toFixed(2)} over ${s.parser.items} pages; pattern detection ${s.parser.pattern_detection_ok}/${s.parser.items}`);
    log(`attendance: precision ${pct(s.attendance.precision)}, recall ${pct(s.attendance.recall)} of ${s.attendance.attendees} attendees (documented forms: recall ${pct(s.attendance.documented.recall)} of ${s.attendance.documented.attendees})`);
    log(`gaps: generic JSON detected as ${s.honesty.generic_json.detected ?? 'nothing'} (parser ${s.honesty.generic_json.parser_phase}); 1970-01-01 fallback on ${s.parser.nodate_epoch_turns} of ${s.parser.nodate_epoch_turns_denominator} date-less turns with no page date; seconds dropped on ${s.parser.seconds_dropped} turns`);
  } else {
    log(`run error: ${r.harnessError}`);
  }
  log(`runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, summary: s, errors: a.errors }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : receipt.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

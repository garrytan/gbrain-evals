/**
 * N12 renderers: one canonical conversation (n12-format-fidelity-gen.ts) into
 * every format gbrain registers.
 *
 * Two families, keyed by the id gbrain uses, so the runner can enumerate
 * gbrain's registries at run time and report any registered format with no
 * renderer as a coverage miss:
 *
 *   ADAPTER_RENDERERS  transcript adapters (src/core/transcripts/detect.ts
 *                      transcriptAdapters()): each writes a host file into a
 *                      directory with the line or record shapes the adapter's
 *                      dated SPEC_TARGET documents, plus "noise" records the
 *                      spec says are skipped (system prompts, tool traffic,
 *                      reasoning, sidechains, abandoned branches) and, for
 *                      line formats, one malformed line.
 *   PATTERN_RENDERERS  conversation-parser built-ins (BUILTIN_PATTERNS ids):
 *                      each writes a page body in the line shape the pattern's
 *                      regex and source_doc describe.
 *
 * Every renderer returns the gold for what it wrote: per turn, the speaker
 * labels a parser may legitimately report, the timestamp the rendered text
 * carries (its "representable" time), the true time, and the instants written
 * anywhere in the source. The gold derives from the ledger and the renderer,
 * never from gbrain output. A renderer writes only what its host format can
 * carry: a time-only format gets the page date from frontmatter, a role-only
 * format gets the participant's role, and so on.
 *
 * Limitation, stated in the report: the host shapes are taken from the
 * adapters' spec targets and gbrain's own fixtures, so a misreading of a host
 * format shared by gbrain and this file would not be caught here.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Conversation, Participant, Turn } from './n12-format-fidelity-gen.ts';

export interface ExpectedTurn {
  marker: string;
  role: 'user' | 'assistant';
  /** Speaker labels a parser may report for this turn (compared case- and space-insensitively). */
  labels: string[];
  /** The instant the rendered source carries for this turn, or null when the format carries no time. */
  ts_representable: number | null;
  /** The true instant from the ledger. */
  ts_true: number;
  /** True when the rendered text carries seconds for this turn. */
  seconds_in_text: boolean;
}

export interface AdapterRender {
  format: string;
  /** The file detectAdapter and the adapter receive. */
  path: string;
  expected: ExpectedTurn[];
  /** Every instant written anywhere in the source (line stamps, headers, sidecars), in ms. */
  allowed_instants: number[];
  /** Noise markers written into records the spec documents as skipped. */
  noise_markers: string[];
  /** Malformed lines written (line formats only). */
  malformed_lines: number;
  /** Timestamp spelling: 'utc' (Z) or 'offset' (the offset conversation in ISO-string formats). */
  stamp_style: 'utc' | 'offset' | 'epoch';
}

export type Carries = 'date-time' | 'time' | 'none';

export interface PatternRender {
  pattern: string;
  body: string;
  /** Page frontmatter date (the first turn's UTC date). */
  page_date: string;
  carries: Carries;
  expected: ExpectedTurn[];
}

const MIN = 60_000;
const ms = (t: Turn) => Date.parse(t.at);
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const flat = (t: Turn) => t.lines.join(' ');
const NOISE = 'noisezq';

/** ISO with a fixed offset: same instant, local wall time. */
export function isoWithOffset(instant: number, offsetMinutes: number): string {
  if (offsetMinutes === 0) return new Date(instant).toISOString();
  const local = new Date(instant + offsetMinutes * MIN).toISOString().slice(0, 23);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const a = Math.abs(offsetMinutes);
  return `${local}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function utcParts(instant: number) {
  const d = new Date(instant);
  const h = d.getUTCHours();
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h, mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
    h12: h % 12 || 12, ampm: h >= 12 ? 'PM' : 'AM', date: new Date(instant).toISOString().slice(0, 10),
  };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const floorMinute = (instant: number) => instant - (instant % MIN);
const dayStart = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
/** Time of day of `instant` placed on `date` (what a time-only line carries on a page dated `date`). */
const onDate = (date: string, instant: number) => dayStart(date) + (instant % 86_400_000);

// ─── Transcript adapters ───────────────────────────────────────────────────

type AdapterRenderer = (c: Conversation, dir: string) => AdapterRender;

function adapterExpected(c: Conversation, representable?: (t: Turn, i: number) => number): ExpectedTurn[] {
  return c.turns.map((t, i) => {
    const p = c.participants[t.speaker];
    return { marker: t.marker, role: p.role, labels: [p.role], ts_representable: representable ? representable(t, i) : ms(t), ts_true: ms(t), seconds_in_text: true };
  });
}
const text = (t: Turn) => t.lines.join('\n');
const stamp = (c: Conversation, instant: number) => isoWithOffset(instant, c.source_offset_minutes);
const styleOf = (c: Conversation): AdapterRender['stamp_style'] => c.source_offset_minutes ? 'offset' : 'utc';
const jsonl = (rows: unknown[], malformed: string) => [...rows.map(r => JSON.stringify(r)), malformed].join('\n') + '\n';

const claudeCode: AdapterRenderer = (c, dir) => {
  const sid = `${c.id}-session`;
  const rows: unknown[] = [];
  const allowed: number[] = [];
  let parent: string | null = null;
  const noise: string[] = [];
  rows.push({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: stamp(c, ms(c.turns[0]) - 1000) });
  allowed.push(ms(c.turns[0]) - 1000);
  c.turns.forEach((t, i) => {
    const role = c.participants[t.speaker].role;
    const uuid = `${c.id}-u${i}`;
    const at = ms(t);
    allowed.push(at);
    const content = role === 'user'
      ? text(t)
      : [{ type: 'thinking', thinking: `${NOISE}${i}a hidden reasoning`, signature: 'sig' }, { type: 'text', text: text(t) }, { type: 'tool_use', id: `tu${i}`, name: 'search_brain', input: { query: `${NOISE}${i}b` } }];
    if (role === 'assistant') noise.push(`${NOISE}${i}a`, `${NOISE}${i}b`);
    rows.push({ parentUuid: parent, isSidechain: false, type: role, message: { role, content }, uuid, sessionId: sid, cwd: '/home/alice-example/work', timestamp: stamp(c, at) });
    parent = uuid;
    if (i === 1) {
      const sideAt = at + 500;
      allowed.push(sideAt);
      noise.push(`${NOISE}${i}c`);
      rows.push({ parentUuid: null, isSidechain: true, type: 'user', message: { role: 'user', content: `${NOISE}${i}c subagent prompt` }, uuid: `${uuid}-side`, sessionId: sid, timestamp: stamp(c, sideAt) });
    }
  });
  noise.push(`${NOISE}s`, `${NOISE}k`);
  rows.push({ type: 'summary', summary: `${NOISE}s summary`, leafUuid: parent });
  const last = ms(c.turns[c.turns.length - 1]) + 1000;
  allowed.push(last);
  rows.push({ type: 'system', subtype: 'compact_boundary', content: `${NOISE}k compacted`, isCompactSummary: true, uuid: `${c.id}-sys`, sessionId: sid, timestamp: stamp(c, last) });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, jsonl(rows, '{malformed line, not JSON'));
  return { format: 'claude-code', path, expected: adapterExpected(c), allowed_instants: allowed, noise_markers: noise, malformed_lines: 1, stamp_style: styleOf(c) };
};

const codex: AdapterRenderer = (c, dir) => {
  const start = ms(c.turns[0]) - 2000;
  const allowed = [start];
  const noise: string[] = [];
  const rows: unknown[] = [
    { timestamp: stamp(c, start), type: 'session_meta', payload: { id: `${c.id}-rollout`, session_id: `${c.id}-root`, timestamp: stamp(c, start), cwd: '/home/alice-example/work', cli_version: '0.99.0', source: 'cli' } },
    { timestamp: stamp(c, start + 500), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `${NOISE}d injected developer context` }] } },
  ];
  allowed.push(start + 500);
  noise.push(`${NOISE}d`);
  c.turns.forEach((t, i) => {
    const at = ms(t);
    allowed.push(at, at + 100, at + 200);
    if (c.participants[t.speaker].role === 'user') {
      // Codex writes the typed text as an event and mirrors it as a user response_item, which is injected context for the adapter.
      rows.push({ timestamp: stamp(c, at), type: 'event_msg', payload: { type: 'user_message', message: text(t), images: [] } });
      rows.push({ timestamp: stamp(c, at + 100), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${NOISE}${i}m mirrored user item` }] } });
      noise.push(`${NOISE}${i}m`);
    } else {
      rows.push({ timestamp: stamp(c, at - 200 > start ? at - 200 : at), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: `${NOISE}${i}r reasoning` }] } });
      allowed.push(at - 200 > start ? at - 200 : at);
      rows.push({ timestamp: stamp(c, at), type: 'response_item', payload: { type: 'message', role: 'assistant', content: t.lines.map(l => ({ type: 'output_text', text: l })) } });
      rows.push({ timestamp: stamp(c, at + 100), type: 'event_msg', payload: { type: 'agent_message', message: text(t), phase: 'final' } });
      rows.push({ timestamp: stamp(c, at + 200), type: 'response_item', payload: { type: 'custom_tool_call_output', output: `${NOISE}${i}o tool output` } });
      noise.push(`${NOISE}${i}r`, `${NOISE}${i}o`);
    }
  });
  const path = join(dir, `rollout-${c.id}.jsonl`);
  writeFileSync(path, jsonl(rows, '{malformed rollout line'));
  return { format: 'codex', path, expected: adapterExpected(c), allowed_instants: allowed, noise_markers: noise, malformed_lines: 1, stamp_style: styleOf(c) };
};

const openclaw: AdapterRenderer = (c, dir) => {
  const start = ms(c.turns[0]) - 3000;
  const allowed = [start, start + 1000];
  const noise = [`${NOISE}c`, `${NOISE}p`];
  const rows: unknown[] = [
    { type: 'session', version: 3, id: `${c.id}-agent`, timestamp: stamp(c, start), cwd: '/home/alice-example/work' },
    { type: 'model_change', id: 'mc-1', parentId: null, provider: 'provider-example', modelId: 'model-example', timestamp: stamp(c, start + 1000) },
    { type: 'custom', id: 'cu-1', parentId: 'mc-1', customType: 'telemetry', data: { note: `${NOISE}c telemetry` }, timestamp: stamp(c, start + 1000) },
  ];
  let parent = 'cu-1';
  c.turns.forEach((t, i) => {
    const at = ms(t);
    allowed.push(at);
    const role = c.participants[t.speaker].role;
    const content: unknown[] = [{ type: 'text', text: text(t) }];
    if (role === 'assistant') content.push({ type: 'toolCall', id: `tc${i}`, name: 'search_brain' });
    rows.push({ type: 'message', id: `m${i}`, parentId: parent, timestamp: stamp(c, at), message: { role, timestamp: stamp(c, at), content } });
    parent = `m${i}`;
    if (i === 1) rows.push({ type: 'compaction', id: 'cp-1', parentId: parent, summary: `${NOISE}p compaction summary`, firstKeptEntryId: 'm0', tokensBefore: 1000, timestamp: stamp(c, at) });
  });
  const path = join(dir, `${c.id}-agent.jsonl`);
  writeFileSync(path, jsonl(rows, '{malformed openclaw line'));
  return { format: 'openclaw', path, expected: adapterExpected(c), allowed_instants: allowed, noise_markers: noise, malformed_lines: 1, stamp_style: styleOf(c) };
};

/** Hermes state.db (schema subset from gbrain's test/fixtures/transcripts/hermes-fixture-builder.ts). */
function hermesDb(path: string, build: (insSession: (id: string, startedAt: number) => void, insMsg: (sid: string, role: string, content: string, ts: number) => void) => void): void {
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, display_name TEXT, model TEXT, started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0);`);
    const s = db.prepare('INSERT INTO sessions (id, source, display_name, model, started_at, cwd, title) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const m = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    build((id, startedAt) => { s.run(id, 'cli', null, 'model-example', startedAt, '/home/alice-example/work', null); }, (sid, role, content, ts) => { m.run(sid, role, content, ts); });
  } finally {
    db.close();
  }
}

const hermes: AdapterRenderer = (c, dir) => {
  const start = ms(c.turns[0]) - 5000;
  const allowed = [start];
  const noise: string[] = [];
  const path = join(dir, 'state.db');
  hermesDb(path, (insSession, insMsg) => {
    insSession(`${c.id}-hermes`, start / 1000);
    c.turns.forEach((t, i) => {
      const role = c.participants[t.speaker].role;
      const at = ms(t);
      allowed.push(at, at + 1000);
      insMsg(`${c.id}-hermes`, role, i % 2 ? JSON.stringify(t.lines.map(l => ({ type: 'text', text: l }))) : text(t), at / 1000);
      if (role === 'assistant') {
        insMsg(`${c.id}-hermes`, 'tool', `${NOISE}${i}t tool row`, (at + 1000) / 1000);
        insMsg(`${c.id}-hermes`, 'assistant', '', (at + 1000) / 1000);
        noise.push(`${NOISE}${i}t`);
      }
    });
  });
  return { format: 'hermes', path, expected: adapterExpected(c), allowed_instants: allowed, noise_markers: noise, malformed_lines: 0, stamp_style: 'epoch' };
};

const GROK_UUID = (c: Conversation) => {
  const h = Array.from(c.id).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return `${h.slice(0, 8)}-0000-4000-8000-${h.slice(0, 8)}0000`;
};
/** Grok's summary.json spelling (microseconds), from gbrain's fixture. */
const grokStamp = (instant: number) => new Date(instant).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

const grok: AdapterRenderer = (c, dir) => {
  const sessionDir = join(dir, encodeURIComponent('/home/alice-example/work'), GROK_UUID(c));
  mkdirSync(sessionDir, { recursive: true });
  const first = ms(c.turns[0]);
  const last = ms(c.turns[c.turns.length - 1]);
  const noise = [`${NOISE}y`, `${NOISE}b`];
  const rows: unknown[] = [{ type: 'system', content: `${NOISE}y injected system prompt` }];
  c.turns.forEach((t, i) => {
    const role = c.participants[t.speaker].role;
    if (role === 'user') {
      rows.push({ type: 'user', content: t.lines.map(l => ({ type: 'text', text: l })) });
      if (i === 0) { rows.push({ type: 'user', synthetic_reason: 'system_reminder', content: [{ type: 'text', text: `${NOISE}${i}s reminder` }] }); noise.push(`${NOISE}${i}s`); }
    } else {
      rows.push({ type: 'reasoning', id: `r${i}`, encrypted_content: 'enc', status: 'completed', summary: [{ type: 'summary_text', text: `${NOISE}${i}r reasoning` }] });
      rows.push({ type: 'assistant', content: '', model_id: 'grok-example', tool_calls: [{ id: `call${i}`, name: 'search_brain', arguments: `{"q":"${NOISE}${i}a"}` }] });
      rows.push({ type: 'tool_result', tool_call_id: `call${i}`, content: `${NOISE}${i}o tool output` });
      rows.push({ type: 'assistant', content: text(t), model_id: 'grok-example' });
      noise.push(`${NOISE}${i}r`, `${NOISE}${i}a`, `${NOISE}${i}o`);
    }
  });
  rows.push({ type: 'backend_tool_call', kind: { id: 'b1', tool_type: 'web_search', action: `${NOISE}b`, status: 'ok' } });
  const path = join(sessionDir, 'chat_history.jsonl');
  writeFileSync(path, jsonl(rows, '{malformed grok line'));
  writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify({
    info: { id: GROK_UUID(c), cwd: '/home/alice-example/work' }, created_at: grokStamp(first), updated_at: grokStamp(last), last_active_at: grokStamp(last),
    generated_title: c.title, current_model_id: 'grok-example', num_chat_messages: c.turns.length,
  }, null, 2));
  // Documented contract (grok.ts header, GROK_SPEC_TARGET): no per-message times; summary created_at stamps every turn but the last, last_active_at the last.
  const n = c.turns.length;
  return { format: 'grok', path, expected: adapterExpected(c, (_t, i) => (i === n - 1 ? last : first)), allowed_instants: [first, last], noise_markers: noise, malformed_lines: 1, stamp_style: 'utc' };
};

const chatgpt: AdapterRenderer = (c, dir) => {
  const start = Math.floor(ms(c.turns[0]) / 1000) - 10;
  const allowed = [start * 1000];
  const noise = [`${NOISE}y`];
  const mapping: Record<string, unknown> = {
    root: { id: 'root', parent: null, children: ['sys'], message: null },
    sys: { id: 'sys', parent: 'root', children: [], message: { author: { role: 'system' }, create_time: start, content: { content_type: 'text', parts: [`${NOISE}y system preamble`] } } },
  };
  let parent = 'sys';
  const link = (id: string, node: Record<string, unknown>) => {
    (mapping[parent] as { children: string[] }).children.push(id);
    mapping[id] = { id, parent, children: [], ...node };
    parent = id;
  };
  c.turns.forEach((t, i) => {
    const role = c.participants[t.speaker].role;
    const at = ms(t) / 1000;
    allowed.push(ms(t));
    if (role === 'assistant') {
      // An abandoned regeneration: a sibling of the kept reply that current_node never reaches.
      const branch = `n${i}-abandoned`;
      (mapping[parent] as { children: string[] }).children.push(branch);
      mapping[branch] = { id: branch, parent, children: [], message: { author: { role: 'assistant' }, create_time: at - 1, content: { content_type: 'text', parts: [`${NOISE}${i}b abandoned branch`] } } };
      allowed.push(ms(t) - 1000);
      noise.push(`${NOISE}${i}b`);
    }
    link(`n${i}`, { message: { author: { role }, create_time: at, content: { content_type: role === 'user' && i % 2 ? 'multimodal_text' : 'text', parts: role === 'user' && i % 2 ? [text(t), { asset_pointer: 'file-service://ignored' }] : [text(t)] } } });
    if (role === 'assistant' && i === 1) {
      link(`n${i}-tool`, { message: { author: { role: 'tool' }, create_time: at + 1, content: { content_type: 'text', parts: [`${NOISE}${i}t tool output`] } } });
      allowed.push(ms(t) + 1000);
      noise.push(`${NOISE}${i}t`);
    }
  });
  const conv = { title: c.title, create_time: start, update_time: Math.floor(ms(c.turns[c.turns.length - 1]) / 1000), conversation_id: `${c.id}-cgpt`, current_node: parent, mapping };
  allowed.push(conv.update_time * 1000);
  const sub = join(dir, 'chatgpt');
  mkdirSync(sub, { recursive: true });
  const path = join(sub, 'conversations.json');
  writeFileSync(path, JSON.stringify([conv], null, 2));
  return { format: 'chatgpt', path, expected: adapterExpected(c), allowed_instants: allowed, noise_markers: noise, malformed_lines: 0, stamp_style: 'epoch' };
};

const claudeExport: AdapterRenderer = (c, dir) => {
  const start = ms(c.turns[0]) - 4000;
  const end = ms(c.turns[c.turns.length - 1]) + 4000;
  const allowed = [start, end];
  const msgs: unknown[] = [];
  c.turns.forEach((t, i) => {
    const role = c.participants[t.speaker].role;
    allowed.push(ms(t));
    msgs.push({ uuid: `${c.id}-m${i}`, sender: role === 'user' ? 'human' : 'assistant', created_at: stamp(c, ms(t)), text: text(t) });
    if (role === 'assistant' && i === 1) {
      msgs.push({ uuid: `${c.id}-m${i}-att`, sender: 'assistant', created_at: stamp(c, ms(t) + 1000), text: '', attachments: [{ file_name: 'ignored.pdf' }] });
      allowed.push(ms(t) + 1000);
    }
  });
  const sub = join(dir, 'claude');
  mkdirSync(sub, { recursive: true });
  const path = join(sub, 'conversations.json');
  writeFileSync(path, JSON.stringify([{ uuid: `${c.id}-claude`, name: c.title, created_at: stamp(c, start), updated_at: stamp(c, end), chat_messages: msgs }], null, 2));
  return { format: 'claude-export', path, expected: adapterExpected(c), allowed_instants: allowed, noise_markers: [], malformed_lines: 0, stamp_style: styleOf(c) };
};

export const ADAPTER_RENDERERS: Readonly<Record<string, AdapterRenderer>> = {
  'claude-code': claudeCode,
  codex,
  openclaw,
  hermes,
  grok,
  chatgpt,
  'claude-export': claudeExport,
};

/**
 * Negative inputs per adapter: a file holding only record kinds the adapter's
 * spec says are skipped, and (line formats) a file of non-JSON lines. Both
 * must yield zero sessions with a reason, never a message.
 */
export interface AdapterNegative { format: string; kind: 'noise-only' | 'garbage' | 'empty'; path: string }

export function renderAdapterNegatives(format: string, dir: string): AdapterNegative[] {
  mkdirSync(dir, { recursive: true });
  const out: AdapterNegative[] = [];
  const write = (kind: AdapterNegative['kind'], name: string, body: string) => {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    out.push({ format, kind, path });
  };
  const t = '2026-04-01T10:00:00.000Z';
  const garbage = 'not json at all\nstill not json: speaker says hello\n';
  switch (format) {
    case 'claude-code':
      write('noise-only', 'neg-noise.jsonl', jsonl([
        { type: 'queue-operation', operation: 'enqueue', sessionId: 'neg', timestamp: t },
        { parentUuid: null, isSidechain: true, type: 'user', message: { role: 'user', content: `${NOISE}n1 subagent` }, uuid: 's1', sessionId: 'neg', timestamp: t },
        { type: 'summary', summary: `${NOISE}n2`, leafUuid: 's1' },
      ], '').trimEnd() + '\n');
      write('garbage', 'neg-garbage.jsonl', garbage);
      break;
    case 'codex':
      write('noise-only', 'neg-noise.jsonl', [
        { timestamp: t, type: 'session_meta', payload: { id: 'neg-rollout', timestamp: t, cwd: '/tmp' } },
        { timestamp: t, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `${NOISE}n1` }] } },
        { timestamp: t, type: 'event_msg', payload: { type: 'agent_reasoning', text: `${NOISE}n2` } },
      ].map(r => JSON.stringify(r)).join('\n') + '\n');
      write('garbage', 'neg-garbage.jsonl', garbage);
      break;
    case 'openclaw':
      write('noise-only', 'neg-noise.jsonl', [
        { type: 'session', version: 3, id: 'neg-agent', timestamp: t, cwd: '/tmp' },
        { type: 'model_change', id: 'mc', parentId: null, provider: 'p', modelId: 'm', timestamp: t },
        { type: 'message', id: 'm1', parentId: 'mc', timestamp: t, message: { role: 'assistant', timestamp: t, content: [{ type: 'toolCall', id: 'tc', name: 'search_brain' }] } },
      ].map(r => JSON.stringify(r)).join('\n') + '\n');
      write('garbage', 'neg-garbage.jsonl', garbage);
      break;
    case 'grok': {
      const d = join(dir, 'neg', '11111111-2222-4333-8444-555555555555');
      mkdirSync(d, { recursive: true });
      const path = join(d, 'chat_history.jsonl');
      writeFileSync(path, [
        { type: 'system', content: `${NOISE}n1 system` },
        { type: 'assistant', content: '', tool_calls: [{ id: 'c', name: 'search_brain', arguments: '{}' }] },
        { type: 'tool_result', tool_call_id: 'c', content: `${NOISE}n2` },
      ].map(r => JSON.stringify(r)).join('\n') + '\n');
      writeFileSync(join(d, 'summary.json'), JSON.stringify({ info: { id: '11111111-2222-4333-8444-555555555555' }, created_at: grokStamp(Date.parse(t)), last_active_at: grokStamp(Date.parse(t)) }));
      out.push({ format, kind: 'noise-only', path });
      const g = join(dir, 'neg', '66666666-2222-4333-8444-555555555555');
      mkdirSync(g, { recursive: true });
      writeFileSync(join(g, 'chat_history.jsonl'), garbage);
      out.push({ format, kind: 'garbage', path: join(g, 'chat_history.jsonl') });
      break;
    }
    case 'hermes': {
      const path = join(dir, 'neg-state.db');
      hermesDb(path, (insSession, insMsg) => {
        insSession('neg-hermes', Date.parse(t) / 1000);
        insMsg('neg-hermes', 'tool', `${NOISE}n1 tool row`, Date.parse(t) / 1000);
        insMsg('neg-hermes', 'assistant', '', Date.parse(t) / 1000);
      });
      out.push({ format, kind: 'noise-only', path });
      break;
    }
    case 'chatgpt':
      write('noise-only', 'neg-chatgpt/conversations.json', JSON.stringify([{
        title: 'neg', create_time: 1775037600, conversation_id: 'neg-cgpt', current_node: 't',
        mapping: {
          root: { id: 'root', parent: null, children: ['s'], message: null },
          s: { id: 's', parent: 'root', children: ['t'], message: { author: { role: 'system' }, create_time: 1775037600, content: { content_type: 'text', parts: [`${NOISE}n1`] } } },
          t: { id: 't', parent: 's', children: [], message: { author: { role: 'tool' }, create_time: 1775037601, content: { content_type: 'text', parts: [`${NOISE}n2`] } } },
        },
      }]));
      break;
    case 'claude-export':
      write('noise-only', 'neg-claude/conversations.json', JSON.stringify([{ uuid: 'neg-claude', name: 'neg', created_at: t, chat_messages: [{ uuid: 'x', sender: 'assistant', created_at: t, text: '', attachments: [{ file_name: 'a.pdf' }] }] }]));
      break;
  }
  return out;
}

/** A transcript in a shape gbrain registers no adapter for (generic role/content JSON): a coverage gap probe. */
export function renderGenericJson(c: Conversation, dir: string): { path: string; expected: ExpectedTurn[] } {
  const path = join(dir, `${c.id}-generic.json`);
  writeFileSync(path, JSON.stringify({ messages: c.turns.map(t => ({ role: c.participants[t.speaker].role, content: text(t), timestamp: t.at })) }, null, 2));
  return { path, expected: adapterExpected(c) };
}

// ─── Conversation-parser built-in patterns ────────────────────────────────

interface PatternSpec {
  carries: Carries;
  /** Seconds written in the line. */
  seconds: boolean;
  /** Messages separated by a blank line (block formats whose header sits on its own line). */
  blank_between?: boolean;
  /** Flatten multi-line turns to one line (single-line formats). */
  flatten: boolean;
  labels(p: Participant, idx: number): string[];
  /** The anchor line (and for block formats, the header) for a turn; `first` is the first text line. */
  line(p: Participant, idx: number, instant: number, first: string): string;
}

const nameLabels = (p: Participant) => [p.name];
const SPEAKER_LETTERS = 'ABCDEFGH';

const PATTERN_SPECS: Readonly<Record<string, PatternSpec>> = {
  'imessage-slack': {
    carries: 'date-time', seconds: false, flatten: false, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `**${p.name}** (${u.date} ${u.h12}:${pad(u.mi)} ${u.ampm}): ${first}`; },
  },
  'telegram-bracket': {
    carries: 'time', seconds: false, flatten: true, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `**[${pad(u.h)}:${pad(u.mi)}] ${p.name}:** ${first}`; },
  },
  'bold-paren-time': {
    carries: 'time', seconds: true, flatten: true, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `**${p.name}** (${pad(u.h)}:${pad(u.mi)}:${pad(u.s)}): ${first}`; },
  },
  'bold-paren-time-12h': {
    carries: 'time', seconds: false, flatten: true, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `**${p.name}** (${u.h12}:${pad(u.mi)} ${u.ampm}): ${first}`; },
  },
  'bold-time-dash': {
    carries: 'time', seconds: false, flatten: false, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `**${p.name}** ${pad(u.h)}:${pad(u.mi)} \u2014 ${first}`; },
  },
  'speaker-letter-no-time': {
    carries: 'none', seconds: false, flatten: true, labels: (_p, i) => [`Speaker ${SPEAKER_LETTERS[i]}`],
    line: (_p, i, _t, first) => `Speaker ${SPEAKER_LETTERS[i]}: ${first}`,
  },
  'chatgpt-export-you-chatgpt': {
    carries: 'none', seconds: false, flatten: false, labels: p => [p.role === 'user' ? 'You' : 'ChatGPT'],
    line: (p, _i, _t, first) => `**${p.role === 'user' ? 'You' : 'ChatGPT'}:** ${first}`,
  },
  'bold-name-no-time': {
    carries: 'none', seconds: false, flatten: true, labels: nameLabels,
    line: (p, _i, _t, first) => `**${p.name}:** ${first}`,
  },
  'telegram-text-export': {
    carries: 'date-time', seconds: true, flatten: false, blank_between: true, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `${p.name}, [${MONTHS[u.mo - 1]} ${u.d}, ${u.y} at ${u.h12}:${pad(u.mi)}:${pad(u.s)} ${u.ampm}]\n${first}`; },
  },
  'whatsapp-iso': {
    carries: 'date-time', seconds: true, flatten: false, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `[${pad(u.d)}/${pad(u.mo)}/${String(u.y).slice(2)}, ${pad(u.h)}:${pad(u.mi)}:${pad(u.s)}] ${p.name}: ${first}`; },
  },
  'whatsapp-us': {
    carries: 'date-time', seconds: false, flatten: false, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `${u.mo}/${u.d}/${String(u.y).slice(2)}, ${u.h12}:${pad(u.mi)} ${u.ampm} - ${p.name}: ${first}`; },
  },
  'discord-export': {
    carries: 'date-time', seconds: false, flatten: false, blank_between: true, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `[${pad(u.mo)}/${pad(u.d)}/${u.y} ${u.h12}:${pad(u.mi)} ${u.ampm}] ${p.name}\n${first}`; },
  },
  'teams-export': {
    carries: 'date-time', seconds: false, flatten: false, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `${p.name}, ${u.mo}/${u.d}/${u.y} ${u.h12}:${pad(u.mi)} ${u.ampm}: ${first}`; },
  },
  'signal-export': {
    carries: 'date-time', seconds: true, flatten: false, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `${p.name} (${u.date} ${pad(u.h)}:${pad(u.mi)}:${pad(u.s)} UTC): ${first}`; },
  },
  'discord-classic': {
    carries: 'time', seconds: false, flatten: false, blank_between: true, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `${p.name} \u2014 Today at ${u.h12}:${pad(u.mi)} ${u.ampm}\n${first}`; },
  },
  'matrix-element': {
    carries: 'time', seconds: false, flatten: true, labels: p => [`@${p.nick}:matrix.org`, p.nick],
    line: (p, _i, t, first) => { const u = utcParts(t); return `[${pad(u.h)}:${pad(u.mi)}] @${p.nick}:matrix.org: ${first}`; },
  },
  'irc-classic': {
    carries: 'none', seconds: false, flatten: true, labels: p => [p.nick],
    line: (p, _i, _t, first) => `<${p.nick}> ${first}`,
  },
  'irc-weechat': {
    carries: 'time', seconds: false, flatten: true, labels: p => [p.nick],
    line: (p, _i, t, first) => { const u = utcParts(t); return `${pad(u.h)}:${pad(u.mi)} <${p.nick}> ${first}`; },
  },
  'markdown-heading-turn': {
    carries: 'none', seconds: false, flatten: false, blank_between: true, labels: p => [p.role === 'user' ? 'User' : 'Assistant'],
    line: (p, _i, _t, first) => `## ${p.role === 'user' ? 'User' : 'Assistant'}\n${first}`,
  },
  'email-thread-heading': {
    carries: 'date-time', seconds: false, flatten: false, blank_between: true, labels: nameLabels,
    line: (p, _i, t, first) => { const u = utcParts(t); return `## ${p.name} <${p.handle}@example.com> \u00b7 ${u.date} ${pad(u.h)}:${pad(u.mi)}\n${first}`; },
  },
  'python-dict-utterance': {
    carries: 'none', seconds: false, flatten: true, labels: p => [p.role === 'user' ? 'me' : p.handle],
    line: (p, _i, _t, first) => (p.role === 'user' ? `{'source': 'microphone', 'attribution': 'me'}: ${first}` : `{'source': 'speaker', 'name': '${p.handle}', 'attribution': 'them'}: ${first}`),
  },
};

export const PATTERN_RENDERER_IDS: readonly string[] = Object.keys(PATTERN_SPECS);

/** Render one conversation in one built-in pattern's line shape. */
export function renderPattern(pattern: string, c: Conversation): PatternRender | null {
  const spec = PATTERN_SPECS[pattern];
  if (!spec) return null;
  const pageDate = c.turns[0].at.slice(0, 10);
  const blocks = c.turns.map(t => {
    const p = c.participants[t.speaker];
    const lines = spec.flatten ? [flat(t)] : t.lines;
    const [first, ...rest] = lines;
    return [spec.line(p, t.speaker, ms(t), first), ...rest].join('\n');
  });
  const body = blocks.join(spec.blank_between ? '\n\n' : '\n') + '\n';
  const expected: ExpectedTurn[] = c.turns.map(t => {
    const p = c.participants[t.speaker];
    const instant = ms(t);
    const carried = spec.seconds ? instant - (instant % 1000) : floorMinute(instant);
    return {
      marker: t.marker, role: p.role, labels: spec.labels(p, t.speaker),
      ts_representable: spec.carries === 'date-time' ? carried : spec.carries === 'time' ? onDate(pageDate, carried) : null,
      ts_true: instant,
      seconds_in_text: spec.seconds,
    };
  });
  return { pattern, body, page_date: pageDate, carries: spec.carries, expected };
}

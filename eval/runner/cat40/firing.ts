/**
 * Firing counters for Cat 40 next-wave arms, read from what the agent was
 * served: each gbrain tool result in a run's `transcripts.jsonl` (Hard runs keep
 * whole results; a result cut short counts only the JSON that parses).
 * Zero model calls; it reads files, plus the stopped slot brain for the
 * owner-phrase link pairs when `--slot` is given.
 *
 *   names_rows / names_rows_with_records / record_rows   F1: `entity` names rows and their `records`
 *   names_rows_with_count                                F1 names-row key: rows carrying `referenced_by_count`
 *   delivered_units                                      F2: search rows per `delivered.unit` (long pages: `section`)
 *   page_status_rows                                     F3: rows carrying `page_status`
 *   known_as_rows / owner_phrase_referrer_rows           F5: card `known_as` rows; referrer rows whose page links to
 *                                                        the row's entity only through an owner phrase
 *   names_call_ms                                        `entity` names-mode call latency (n, p50, p99) from attempts.jsonl
 *
 *   bun eval/runner/cat40/firing.ts --run <out dir> [--slot <slot dir> --gbrain-build <build dir>] [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FiringCounts {
  cells: number;
  calls: Record<string, number>;
  names_rows: number;
  names_rows_with_records: number;
  names_rows_with_count: number;
  record_rows: number;
  delivered_units: Record<string, number>;
  page_status_rows: number;
  known_as_rows: number;
  owner_phrase_referrer_rows: number | null;
  names_call_ms: { n: number; p50: number | null; p99: number | null };
}

/** The JSON value a tool result starts with (gbrain appends `[gbrain …]` notice lines after it); null when it starts with none. */
export function leadingJson(text: string): unknown {
  const start = text.search(/\S/);
  if (start < 0 || !'[{'.includes(text[start])) return null;
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Counts one served tool result into `c`. `ownerPairs` holds `from\0to` slugs of owner-phrase links. */
export function countResult(c: FiringCounts, name: string, args: Obj, result: string, ownerPairs: Set<string> | null): void {
  c.calls[name] = (c.calls[name] ?? 0) + 1;
  const json = leadingJson(result);
  if (json === null) return;
  if (name === 'entity' && Array.isArray(args.names) && isObj(json) && Array.isArray(json.results)) {
    for (const row of json.results.filter(isObj).filter(r => r.found !== false)) {
      c.names_rows++;
      const groups = Array.isArray(row.records) ? row.records.filter(isObj) : [];
      if (groups.some(g => Number(g.total) > 0)) c.names_rows_with_records++;
      if (typeof row.referenced_by_count === 'number') c.names_rows_with_count++;
      c.record_rows += groups.reduce((n, g) => n + (Array.isArray(g.rows) ? g.rows.length : 0), 0);
    }
  }
  const walk = (v: unknown, target: string | null) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, target); return; }
    if (!isObj(v)) return;
    if ('page_status' in v) c.page_status_rows++;
    if (isObj(v.delivered) && typeof v.delivered.unit === 'string') c.delivered_units[v.delivered.unit] = (c.delivered_units[v.delivered.unit] ?? 0) + 1;
    if (isObj(v.known_as) && Array.isArray(v.known_as.rows)) c.known_as_rows += v.known_as.rows.length;
    const slug = typeof v.slug === 'string' ? v.slug : null;
    if (slug && target && ownerPairs?.has(`${slug}\0${target}`)) c.owner_phrase_referrer_rows! += 1;
    const nested = Object.values(v).some(x => Array.isArray(x) || isObj(x));
    for (const x of Object.values(v)) walk(x, slug && nested ? slug : target);
  };
  walk(json, name === 'get_backlinks' && typeof args.slug === 'string' ? args.slug : null);
}

/** `from\0to` page slugs of every owner-phrase link in a stopped slot brain. */
export function ownerPhrasePairs(slotDir: string, buildDir: string): Set<string> {
  const pglite = join(buildDir, 'node_modules/@electric-sql/pglite/dist');
  const script = `const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)}); const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)}); const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)}); const db = await PGlite.create({ dataDir: ${JSON.stringify(join(slotDir, 'home', 'brain.pglite'))}, extensions: { vector, pg_trgm } }); const rows = (await db.query("SELECT f.slug AS a, t.slug AS b FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE l.link_kind = 'owner_phrase'")).rows; await db.close(); process.stdout.write(JSON.stringify(rows.map(r => r.a + '\\u0000' + r.b)));`;
  return new Set(JSON.parse(execFileSync('bun', ['-e', script], { encoding: 'utf8', maxBuffer: 256 << 20 })) as string[]);
}

/** Nearest-rank percentile of sorted values. */
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);

export function countRun(runDir: string, ownerPairs: Set<string> | null): FiringCounts {
  const c: FiringCounts = { cells: 0, calls: {}, names_rows: 0, names_rows_with_records: 0, names_rows_with_count: 0, record_rows: 0, delivered_units: {}, page_status_rows: 0, known_as_rows: 0, owner_phrase_referrer_rows: ownerPairs ? 0 : null, names_call_ms: { n: 0, p50: null, p99: null } };
  // Per-call latency lives in attempts.jsonl (tool_calls, in call order per session); arguments live in the transcript.
  const attempts = new Map<string, Array<Array<{ name: string; ms: number }>>>();
  const attemptsPath = join(runDir, 'attempts.jsonl');
  if (existsSync(attemptsPath)) for (const line of readFileSync(attemptsPath, 'utf8').split('\n').filter(Boolean)) {
    const a = JSON.parse(line) as { attempt_id: string; sessions?: Array<{ run?: { tool_calls?: Array<{ name: string; ms: number }> } }> };
    attempts.set(a.attempt_id, (a.sessions ?? []).map(s => s.run?.tool_calls ?? []));
  }
  const namesMs: number[] = [];
  for (const line of readFileSync(join(runDir, 'transcripts.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const t = JSON.parse(line) as { attempt_id?: string; tools: Array<{ session?: number; name: string; args: Obj; result: string }> };
    c.cells++;
    const timed = t.attempt_id ? attempts.get(t.attempt_id) : undefined;
    const seen = new Map<number, number>();
    for (const call of t.tools) {
      countResult(c, call.name, call.args ?? {}, call.result ?? '', ownerPairs);
      const k = call.session ?? 1, i = seen.get(k) ?? 0;
      seen.set(k, i + 1);
      const ev = timed?.[k - 1]?.[i];
      if (call.name === 'entity' && Array.isArray(call.args?.names) && ev?.name === 'entity') namesMs.push(ev.ms);
    }
  }
  namesMs.sort((a, b) => a - b);
  c.names_call_ms = { n: namesMs.length, p50: pct(namesMs, 0.5), p99: pct(namesMs, 0.99) };
  return c;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const run = flag('--run');
  if (!run || !existsSync(join(run, 'transcripts.jsonl'))) { console.error('usage: bun eval/runner/cat40/firing.ts --run <out dir with transcripts.jsonl> [--slot <slot dir> --gbrain-build <build dir>] [--json]'); process.exit(2); }
  const slot = flag('--slot'), build = flag('--gbrain-build');
  const counts = countRun(run, slot && build ? ownerPhrasePairs(slot, build) : null);
  const receiptFile = readdirSync(run).filter(f => f.startsWith('receipt-')).sort().at(-1);
  const g = receiptFile ? (JSON.parse(readFileSync(join(run, receiptFile), 'utf8')).gbrain ?? {}) : {};
  const out = { run, label: g.label ?? null, commit: g.commit ?? null, config: g.config ?? null, build_config: g.build_config ?? null, restore_probe: g.restore_probe ?? null, rerank_probe: g.rerank_probe ?? null, served_instructions_sha256: g.served_instructions_sha256 ?? null, ...counts };
  console.log(argv.includes('--json') ? JSON.stringify(out, null, 2) : Object.entries(out).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
}

/**
 * Maps a cost-and-speed run's files onto `Cs1Input` (eval/runner/cost-speed.ts), the aggregation's only input
 * (docs/benchmarks/2026-11-24-cost-speed-preregistration.md, "Measures"). Nothing here prices a request: every dollar is
 * a metering-proxy usage line's `actual_usd`, put in exactly one bucket by its meter key and phase, and
 * `checks.sum_back` holds the buckets against the usage logs' total.
 *
 * What each key means (eval/runner/q1/cell.ts binds them):
 *   ingest:<ns>, ingest:<ns>#held-back   write (phase commit), probe (phase probe), else background
 *   calibration:<ns>, probe:<ns>         probe: the label check's searches and the readiness probe
 *   tail:<rid>                           background: work a write set off, arriving while questions run
 *   tail:idle:<rid>                      idle window
 *   tail:trigger:<rid>:<job>             one run of a scheduled job's documented trigger, priced per run
 *   q:<question id>:<policy>             the system's own read for a question
 *   read:<answer id, 16 hex>             the reader's answer (harness slot)
 *   answer:<answer id, 16 hex>           the file agent's whole answer, the reader being the agent (agent slot)
 * Anything else is unattributed and reported; a world's ingest lines are found through the namespace its ingested event
 * names. History growth prices the bulk import's first and last quarter of sessions from each write's wall-clock window
 * (writes.ndjson): a quarter's write and background lines arriving from its first write until the next quarter's first.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageLine } from './metering-proxy.ts';
import type { Cs1FullContextReader, Cs1FullContextWorld, Cs1Hosted, Cs1Input, Cs1PriceLadder, Cs1Profile, Cs1System, Cs1World } from './cost-speed.ts';
import { CS1_READERS } from './cost-speed.ts';
import { matchAnswer, type MatchClass } from './bg1/match.ts';
import type { MemoryQuestion } from './memory-qa/corpus.ts';
import type { ProbeRecord } from './memory-qa/cost-speed-probes.ts';
import type { HostingSample } from './memory-qa/hosting-samples.ts';
import { priceOf } from './q1/cells/definitions.ts';
import { CS1_WRITES_NOTHING } from './q1/cells/cs1.ts';

export type Cs1Bucket = 'write' | 'background' | 'probe' | 'read' | 'idle' | 'trigger' | 'reader' | 'unattributed';

/** One cell unit's output: its `--out` directory and the usage log of the proxy it ran behind. */
export interface Cs1Unit { dir: string; usage: readonly UsageLine[] }

export interface Cs1LoadOptions {
  /** Cell id to system, for every cell a unit may hold (cs1-cells.json cells). */
  cells: ReadonlyMap<string, string>;
  /** Each question's key-match fields (bg1), by question id. */
  questions: ReadonlyMap<string, Pick<MemoryQuestion, 'id' | 'bg1'>>;
  ladder: Cs1PriceLadder;
  /** A docker system's compose project name, whose containers and volumes its hosting samples count; absent for an in-process system. */
  stacks?: Readonly<Record<string, string>>;
  /** The full-context row's one-year fit per reader and profile (cells/cs1.ts cs1FullContextFit). */
  fullContextFit?: Readonly<Record<string, Record<Cs1Profile, { fits: boolean; prompt_tokens?: number }>>>;
  readers?: readonly string[];
  fullContextSystem?: string;
}

const lines = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : [];
const usd = (l: UsageLine) => l.actual_usd ?? 0;
/** A reader id as the results name it: `anthropic:claude-opus-5-5` is `claude-opus-5-5`. */
const readerName = (id: string) => id.slice(id.indexOf(':') + 1);

interface Realization { rid: string; conv: string; ns: string | null; at: string; ingest: { content_tokens?: number; ingested_tokens: number; sessions: number }; write_probes?: Array<ProbeRecord & { kind: string }> }
interface Answer { answer_id: string; realization_id: string; question_id: string; conversation: string; reader: string; replicate: number; text: string; outcome: string; usage?: { input: number; output: number } }

/** The bucket a usage line belongs to, and the world (conversation) it belongs to when its key names one. */
export function cs1Bucket(l: UsageLine, keys: { ns: ReadonlyMap<string, string>; rid: ReadonlyMap<string, string>; answer: ReadonlyMap<string, string> }): { bucket: Cs1Bucket; conv: string | null; job?: string } {
  const k = l.key;
  let m: RegExpMatchArray | null;
  if ((m = k.match(/^ingest:([^#]+)(#held-back)?$/))) {
    const conv = keys.ns.get(m[1]) ?? null;
    return { bucket: l.phase === 'commit' ? 'write' : l.phase === 'probe' ? 'probe' : 'background', conv };
  }
  if ((m = k.match(/^(?:calibration|probe):(.+)$/))) return { bucket: 'probe', conv: keys.ns.get(m[1]) ?? null };
  if ((m = k.match(/^tail:trigger:([0-9a-f]+):(.+)$/))) return { bucket: 'trigger', conv: keys.rid.get(m[1]) ?? null, job: m[2] };
  if ((m = k.match(/^tail:idle:([0-9a-f]+)$/))) return { bucket: 'idle', conv: keys.rid.get(m[1]) ?? null };
  if ((m = k.match(/^tail:([0-9a-f]+)$/))) return { bucket: 'background', conv: keys.rid.get(m[1]) ?? null };
  if ((m = k.match(/^q:([^:]+):/))) return { bucket: 'read', conv: m[1] };
  if ((m = k.match(/^(?:read|answer):([0-9a-f]{16})$/))) { const conv = keys.answer.get(m[1]) ?? null; return { bucket: conv ? 'reader' : 'unattributed', conv }; }
  return { bucket: 'unattributed', conv: null };
}

/** The latest ingested event per conversation of a cell's realizations.ndjson (an invalidated realization drops out). */
function realizations(dir: string): Realization[] {
  const latest = new Map<string, Realization>();
  for (const e of lines<{ realization_id: string; conversation: string; event: string; at: string; ns?: string; ingest?: Realization['ingest']; write_probes?: Realization['write_probes'] }>(join(dir, 'realizations.ndjson'))) {
    if (e.event === 'invalidated') { if (latest.get(e.conversation)?.rid === e.realization_id) latest.delete(e.conversation); continue; }
    if (e.event === 'ingested' && e.ingest) latest.set(e.conversation, { rid: e.realization_id, conv: e.conversation, ns: e.ns ?? null, at: e.at, ingest: e.ingest, write_probes: e.write_probes });
  }
  return [...latest.values()];
}

/** The latest answer per answer id, over every arm cell of a unit. */
function answers(out: string): Answer[] {
  const dir = join(out, 'cells');
  if (!existsSync(dir)) return [];
  const byId = new Map<string, Answer>();
  for (const arm of readdirSync(dir).sort()) for (const a of lines<Answer>(join(dir, arm, 'answers.ndjson'))) byId.set(a.answer_id, a);
  return [...byId.values()];
}

/** A quarter's write-and-background dollars per million content tokens, from the lines arriving in its window. */
function quarterRate(writes: ReadonlyArray<{ start_at: string; content_tokens: number }>, from: number, to: number, end: number, ingest: readonly UsageLine[]): number | null {
  const part = writes.slice(from, to);
  const tokens = part.reduce((n, w) => n + w.content_tokens, 0);
  if (!part.length || !(tokens > 0)) return null;
  const t0 = Date.parse(part[0].start_at), t1 = to < writes.length ? Date.parse(writes[to].start_at) : end;
  const spend = ingest.filter(l => { const t = Date.parse(l.at); return t >= t0 && t < t1; }).reduce((n, l) => n + usd(l), 0);
  return spend / tokens * 1e6;
}

/** One reader's full-context reads in one world: each line's `actual_usd` split by cache kind in proportion to the model's list prices. */
function fullContextWorld(world: string, ans: readonly Answer[], readerLines: ReadonlyMap<string, UsageLine[]>, classes: MatchClass[]): Cs1FullContextWorld {
  const w = { world, questions: ans.length, cached_tokens: 0, cached_usd: 0, cache_write_tokens: 0, cache_write_usd: 0, uncached_tokens: 0, uncached_usd: 0, output_usd: 0, classes };
  for (const a of ans) for (const l of readerLines.get(a.answer_id.slice(0, 16)) ?? []) {
    if (!l.model) continue;
    const base = priceOf(`${l.provider}:${l.model}`);
    const input = l.input_tokens ?? 0, cr = l.cache_read_tokens ?? 0, cw = l.cache_write_tokens ?? 0;
    const p = base.long && input > base.long.above_input_tokens ? { ...base, ...base.long } : base;
    const parts = [cr * (p.cache_read ?? p.input), cw * (p.cache_write ?? p.input), (input - cr - cw) * p.input, (l.output_tokens ?? 0) * p.output];
    const list = parts.reduce((n, x) => n + x, 0), scale = list > 0 ? usd(l) / list : 0;
    w.cached_tokens += cr; w.cached_usd += parts[0] * scale;
    w.cache_write_tokens += cw; w.cache_write_usd += parts[1] * scale;
    w.uncached_tokens += input - cr - cw; w.uncached_usd += parts[2] * scale;
    w.output_usd += parts[3] * scale;
  }
  return w;
}

export function cs1Load(units: readonly Cs1Unit[], opts: Cs1LoadOptions) {
  const readers = opts.readers ?? CS1_READERS;
  const fcSystem = opts.fullContextSystem ?? 'baseline-full-context';
  const problems: string[] = [];
  const totals: Record<Cs1Bucket, number> = { write: 0, background: 0, probe: 0, read: 0, idle: 0, trigger: 0, reader: 0, unattributed: 0 };
  let billed = 0;
  const worlds = new Map<string, Cs1World[]>();
  const hosted = new Map<string, Cs1Hosted | null>();
  const fc = new Map<string, Cs1FullContextWorld[]>();
  const unattributedKeys = new Map<string, number>();

  for (const u of units) {
    const runs = join(u.dir, 'runs');
    const cellIds = existsSync(runs) ? readdirSync(runs).sort().filter(id => opts.cells.has(id)) : [];
    if (!cellIds.length) { problems.push(`${u.dir}: no cost-and-speed cell under runs/`); continue; }
    if (cellIds.length > 1) problems.push(`${u.dir}: holds ${cellIds.length} cells (${cellIds.join(', ')}); their usage log is attributed to each by key`);
    const all = answers(u.dir);
    for (const cell of cellIds) {
      const system = opts.cells.get(cell)!;
      const dir = join(runs, cell);
      const rs = realizations(dir);
      const ns = new Map(rs.flatMap(r => r.ns ? [[r.ns, r.conv] as const] : []));
      const rid = new Map(rs.map(r => [r.rid, r.conv] as const));
      const mine = all.filter(a => rid.has(a.realization_id));
      const answer = new Map(mine.map(a => [a.answer_id.slice(0, 16), a.conversation] as const));
      for (const r of rs) if (!r.ns && !CS1_WRITES_NOTHING.includes(system) && system !== fcSystem && r.ingest.sessions > 0) problems.push(`${cell} ${r.conv}: the ingested event names no namespace, so its ingest lines can't be found`);
      const by = new Map<string, Record<Cs1Bucket, UsageLine[]>>();
      const triggers = new Map<string, Map<string, number>>();
      const readerLines = new Map<string, UsageLine[]>();
      for (const l of u.usage) {
        const b = cs1Bucket(l, { ns, rid, answer });
        if (b.bucket === 'unattributed' || !b.conv || (b.bucket !== 'reader' && l.slot === 'harness')) continue;
        const slot = by.get(b.conv) ?? Object.fromEntries(Object.keys(totals).map(k => [k, [] as UsageLine[]])) as unknown as Record<Cs1Bucket, UsageLine[]>;
        by.set(b.conv, slot);
        slot[b.bucket].push(l);
        if (b.bucket === 'trigger') { const t = triggers.get(b.conv) ?? new Map(); t.set(b.job!, (t.get(b.job!) ?? 0) + usd(l)); triggers.set(b.conv, t); }
        if (b.bucket === 'reader') { const k = l.key.slice(l.key.indexOf(':') + 1); readerLines.set(k, [...(readerLines.get(k) ?? []), l]); }
      }
      const sum = (ls: readonly UsageLine[] | undefined) => (ls ?? []).reduce((n, l) => n + usd(l), 0);
      const rows = new Map<string, number>();
      const armDir = join(u.dir, 'cells');
      if (existsSync(armDir)) for (const arm of readdirSync(armDir).sort().filter(a => a.startsWith(`${cell}.`))) {
        for (const row of lines<{ conversation: string; realization_id: string }>(join(armDir, arm, 'rows.ndjson'))) if (rid.has(row.realization_id)) rows.set(row.conversation, (rows.get(row.conversation) ?? 0) + 1);
      }
      const classOf = (a: Answer): MatchClass => {
        const q = opts.questions.get(a.question_id);
        if (!q) { problems.push(`${a.question_id}: no key-match fields`); return 'unclear'; }
        return a.outcome === 'scored' || a.outcome === 'ingest_degraded' ? matchAnswer(q, a.text) : 'other';
      };
      for (const r of rs) {
        const b = by.get(r.conv);
        const mineHere = mine.filter(a => a.conversation === r.conv && a.replicate === 0);
        if (system === fcSystem) {
          for (const reader of readers) {
            const ans = mineHere.filter(a => readerName(a.reader) === reader);
            fc.set(reader, [...(fc.get(reader) ?? []), fullContextWorld(r.conv, ans, readerLines, ans.map(classOf))]);
          }
          continue;
        }
        const idle = lines<{ ms: number; usd: number | null; triggers?: Array<{ job: string; trigger: string; cadence_minutes: number | null; error: string | null }> }>(join(dir, 'r', r.rid, 'idle.json'))[0];
        const writes = lines<{ start_at: string; content_tokens: number }>(join(dir, 'r', r.rid, 'writes.ndjson'));
        const ingestLines = r.ns ? [...(b?.write ?? []), ...(b?.background ?? [])].filter(l => l.key === `ingest:${r.ns}`) : [];
        const q = writes.length >= 4 ? Math.floor(writes.length / 4) : 0;
        const end = Math.max(...ingestLines.map(l => Date.parse(l.at)), Date.parse(r.at)) + 1;
        const first = q ? quarterRate(writes, 0, q, end, ingestLines) : null, last = q ? quarterRate(writes, writes.length - q, writes.length, end, ingestLines) : null;
        if (idle) for (const t of idle.triggers ?? []) if (t.error) problems.push(`${cell} ${r.conv}: trigger ${t.job} failed: ${t.error}`);
        const probes = (r.write_probes ?? []);
        const world: Cs1World = {
          world: r.conv, ingested_tokens: r.ingest.content_tokens ?? r.ingest.ingested_tokens, sessions: r.ingest.sessions, questions: rows.get(r.conv) ?? 0,
          usd: { write: sum(b?.write), background: sum(b?.background), read: sum(b?.read), probe: sum(b?.probe) },
          idle: idle ? { usd: sum(b?.idle), window_ms: idle.ms, triggers: (idle.triggers ?? []).flatMap(t => {
            if (t.error || !t.cadence_minutes) return [];
            return [{ job: t.job, usd: triggers.get(r.conv)?.get(t.trigger) ?? 0, cadence_minutes: t.cadence_minutes }];
          }) } : null,
          quarters: first !== null && last !== null ? { first_usd_per_mtok: first, last_usd_per_mtok: last } : null,
          readers: Object.fromEntries(readers.map(reader => {
            const ans = mineHere.filter(a => readerName(a.reader) === reader);
            return [reader, { questions: ans.length, usd: ans.reduce((n, a) => n + sum(readerLines.get(a.answer_id.slice(0, 16))), 0), classes: ans.map(classOf) }];
          })),
          probes: probes.filter(p => p.kind === 'held-back'),
          bulk_probes: probes.filter(p => p.kind === 'bulk'),
        };
        if (!r.ingest.content_tokens && !CS1_WRITES_NOTHING.includes(system)) problems.push(`${cell} ${r.conv}: no content_tokens in the ingested event; priced on ingested_tokens`);
        worlds.set(system, [...(worlds.get(system) ?? []), world]);
      }
      if (system !== fcSystem && !CS1_WRITES_NOTHING.includes(system)) {
        const samples = lines<HostingSample>(join(dir, 'hosting.ndjson')), failed = samples.filter(s => s.error);
        if (!samples.length) problems.push(`${cell}: no hosting samples`);
        if (failed.length) problems.push(`${cell}: ${failed.length} of ${samples.length} hosting samples failed (${failed[0].error})`);
        const h = hostingOf(samples, opts.stacks?.[system] ?? null, rs);
        const prev = hosted.get(system);
        hosted.set(system, !prev ? h : !h ? prev : { resident_bytes: Math.max(prev.resident_bytes, h.resident_bytes), ...(h.disk_bytes / h.disk_tokens >= prev.disk_bytes / prev.disk_tokens ? { disk_bytes: h.disk_bytes, disk_tokens: h.disk_tokens } : { disk_bytes: prev.disk_bytes, disk_tokens: prev.disk_tokens }) });
      }
    }
    const nsAll = new Map<string, string>(), ridAll = new Map<string, string>(), ansAll = new Map<string, string>();
    for (const cell of cellIds) for (const r of realizations(join(runs, cell))) { if (r.ns) nsAll.set(r.ns, r.conv); ridAll.set(r.rid, r.conv); }
    for (const a of all) if (ridAll.has(a.realization_id)) ansAll.set(a.answer_id.slice(0, 16), a.conversation);
    for (const l of u.usage) {
      billed += usd(l);
      const b = cs1Bucket(l, { ns: nsAll, rid: ridAll, answer: ansAll });
      const bucket = b.conv ? b.bucket : 'unattributed';
      totals[bucket] += usd(l);
      if (bucket === 'unattributed' && usd(l) > 0) unattributedKeys.set(l.key.replace(/[0-9a-f]{12,}/g, '<id>'), (unattributedKeys.get(l.key.replace(/[0-9a-f]{12,}/g, '<id>')) ?? 0) + usd(l));
    }
  }

  const systems: Cs1System[] = [...worlds].map(([system, ws]) => ({ system, worlds: ws.sort((a, b) => (a.world < b.world ? -1 : 1)), hosting: hosted.get(system) ?? null }));
  const full_context = fc.size ? Object.fromEntries([...fc].map(([reader, ws]) => {
    const fit = opts.fullContextFit?.[reader];
    if (!fit) problems.push(`full context: no fit check for ${reader}`);
    return [reader, { worlds: ws, fit: fit ?? { heavy: { fits: false }, light: { fits: false } } } satisfies Cs1FullContextReader];
  })) : null;
  const inWorlds = systems.reduce((n, s) => n + s.worlds.reduce((m, w) => m + w.usd.write + w.usd.background + w.usd.read + w.usd.probe + (w.idle?.usd ?? 0)
    + (w.idle?.triggers ?? []).reduce((k, t) => k + t.usd, 0) + Object.values(w.readers).reduce((k, x) => k + x.usd, 0), 0), 0)
    + Object.values(full_context ?? {}).reduce((n, f) => n + f.worlds.reduce((m, w) => m + w.cached_usd + w.cache_write_usd + w.uncached_usd + w.output_usd, 0), 0);
  const dropped = billed - inWorlds - totals.unattributed;
  if (Math.abs(dropped) > 1e-6) problems.push(`${dropped.toFixed(6)} billed dollars are in no world's lines and not unattributed (an errored trigger, a replicate above 0, or a harness-slot line that isn't a reader's)`);
  const input: Cs1Input = { systems, ladder: opts.ladder, full_context, readers };
  return {
    input, problems,
    checks: { sum_back: { billed_usd: billed, attributed_usd: inWorlds, unattributed_usd: totals.unattributed, difference_usd: dropped }, by_bucket: totals, unattributed_keys: Object.fromEntries(unattributedKeys) },
  };
}

/**
 * A system's hosting from one unit's samples: the steady peak of the stack's resident memory (its compose project's
 * containers, or the harness process for an in-process system) and the last sample's disk (the project's volumes), with
 * the content tokens ingested by then as the projection's base. Null with no usable sample.
 */
export function hostingOf(samples: readonly HostingSample[], stack: string | null, rs: ReadonlyArray<Pick<Realization, 'at' | 'ingest'>>): Cs1Hosted | null {
  const ok = samples.filter(s => !s.error);
  if (!ok.length) return null;
  const mine = <T extends { name: string }>(xs: readonly T[]) => stack ? xs.filter(x => x.name.startsWith(`${stack}-`) || x.name.startsWith(`${stack}_`)) : [];
  const resident = (s: HostingSample) => stack ? mine(s.containers).reduce((n, c) => n + c.mem_bytes, 0) : s.harness_rss_bytes;
  const last = ok[ok.length - 1];
  const tokens = rs.filter(r => Date.parse(r.at) <= Date.parse(last.at)).reduce((n, r) => n + (r.ingest.content_tokens ?? r.ingest.ingested_tokens), 0);
  return { resident_bytes: Math.max(...ok.map(resident)), disk_bytes: mine(last.volumes).reduce((n, v) => n + v.bytes, 0) + (last.dirs ?? []).reduce((n, d) => n + d.bytes, 0), disk_tokens: tokens };
}

/**
 * CLI: bun eval/runner/cs1-load.ts --unit <cell --out dir>:<proxy usage.ndjson> [--unit ...] --out <result.json>
 *   [--ladder primary|sensitivity] [--rows <rows.json> --table <table.md> [--profile heavy|light]] [--keyless]
 * Loads the units, aggregates them (cs1Aggregate) and writes { checks, problems, ladder, result }; with --rows (each
 * system's build and date, and a `not_run` reason for a row that didn't run) it also renders README's table. Reads only local files: no provider is called.
 */
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const all = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  const one = (n: string) => all(n)[0];
  const out = one('--out');
  const specs = all('--unit');
  if (!out || !specs.length) { console.error('usage: bun eval/runner/cs1-load.ts --unit <out dir>:<usage.ndjson> [--unit ...] --out <result.json> [--ladder primary|sensitivity] [--rows <rows.json> --table <table.md>]'); process.exit(2); }
  const { writeFileSync } = await import('node:fs');
  const { loadCS1Manifest, CS1_PRICE_LADDERS, cs1FullContextFit } = await import('./q1/cells/cs1.ts');
  const { readerFitTokenizer, readerMaxTokens } = await import('./q1/cell.ts');
  const { loadCorpus } = await import('./memory-qa/corpus.ts');
  const { cs1Aggregate, renderCs1Table } = await import('./cost-speed.ts');
  const units = specs.map(s => { const i = s.lastIndexOf(':'); return { dir: s.slice(0, i), usage: lines<UsageLine>(s.slice(i + 1)) }; });
  const m = loadCS1Manifest();
  const defs = [...m.cells, ...(m.smoke_cells ?? []), ...(m.addon_cells ?? [])];
  const cells = new Map(defs.map(c => [c.id, c.system]));
  const stacks: Record<string, string> = {};
  for (const c of defs) {
    if (c.runner !== 'shim' || stacks[c.system]) continue;
    const base = [`eval/systems/${c.system}`, `docs/comparison-systems/${c.system}`].find(d => existsSync(join(d, 'docker-compose.yml')));
    if (!base) continue;
    const cfg = c.launch?.config;
    const file = cfg && existsSync(join(base, cfg, 'docker-compose.yml')) ? join(base, cfg, 'docker-compose.yml') : join(base, 'docker-compose.yml');
    const name = /^name:\s*(\S+)/m.exec(readFileSync(file, 'utf8'))?.[1];
    if (name) stacks[c.system] = name;
  }
  const convs = new Set(units.flatMap(u => { const runs = join(u.dir, 'runs'); return existsSync(runs) ? readdirSync(runs).sort().filter(id => cells.has(id)).flatMap(id => realizations(join(runs, id)).map(r => r.conv)) : []; }));
  const corpus = loadCorpus('bg1-dev', undefined, convs, { keyless: argv.includes('--keyless') });
  const questions = new Map(corpus.questions.map(q => [q.id, q]));
  const fullContextFit: Record<string, Record<Cs1Profile, { fits: boolean; prompt_tokens?: number }>> = {};
  const conv = corpus.conversations[0], q = conv && corpus.questions.find(x => x.conversation === conv.id);
  if (conv && q) for (const reader of m.readers) fullContextFit[readerName(reader)] = Object.fromEntries((['heavy', 'light'] as const).map(p => { const f = cs1FullContextFit(conv, q, p, reader, { tokenizer: readerFitTokenizer(reader), outputTokens: readerMaxTokens(reader) }); return [p, { fits: f.fits, prompt_tokens: f.prompt_tokens }]; })) as Record<Cs1Profile, { fits: boolean; prompt_tokens?: number }>;
  const which = (one('--ladder') ?? 'primary') as keyof typeof CS1_PRICE_LADDERS;
  const ladder = CS1_PRICE_LADDERS[which];
  if (!ladder) { console.error(`--ladder must be one of ${Object.keys(CS1_PRICE_LADDERS).join(', ')}`); process.exit(2); }
  const rowsFile = one('--rows'), table = one('--table');
  const rows: Record<string, { build: string; date: string; not_run?: string }> = rowsFile ? JSON.parse(readFileSync(rowsFile, 'utf8')) : {};
  const loaded = cs1Load(units, { cells, questions, ladder, stacks, fullContextFit });
  const order = (s: string) => defs.findIndex(c => c.system === s);
  const result = cs1Aggregate({ ...loaded.input, systems: [...loaded.input.systems].sort((x, y) => order(x.system) - order(y.system)), not_run: Object.entries(rows).flatMap(([system, r]) => r.not_run ? [{ system, reason: r.not_run }] : []) });
  writeFileSync(out, JSON.stringify({ checks: loaded.checks, problems: loaded.problems, ladder, result }, null, 2) + '\n');
  if (rowsFile && table) writeFileSync(table, renderCs1Table(result, rows, (one('--profile') ?? 'heavy') as Cs1Profile));
  console.log(JSON.stringify({ out, table: rowsFile && table ? table : null, sum_back: loaded.checks.sum_back, problems: loaded.problems.length }));
}

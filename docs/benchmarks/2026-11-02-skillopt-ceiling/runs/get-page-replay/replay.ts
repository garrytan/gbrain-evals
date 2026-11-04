/**
 * Keyless replay of the get_page calls recorded in the SkillOpt runs (Sol's in the frontier probe and the
 * ceiling calibration, and as a control Opus's in the calibration and gate 1), through gbrain's SkillOpt rollout
 * registry (the read-only one the rollouts used), against the brain each run read. No model is called and no
 * key is read. The probe's one-shot input names a page the proposer was not shown as `[withheld]`; those calls
 * replay against the stand-in page the acceptance test uses, and are counted apart. Run it once per gbrain build,
 * then compare the two outputs:
 *
 *   bun docs/benchmarks/2026-11-02-skillopt-ceiling/runs/get-page-replay/replay.ts <out.json.gz>
 *   bun docs/benchmarks/2026-11-02-skillopt-ceiling/runs/get-page-replay/replay.ts --compare <before.json.gz> <after.json.gz>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { runRollout, type BenchmarkTask } from 'gbrain/core/skillopt';
import { withHermeticEnv } from '../../../../../eval/runner/hermetic-env.ts';
import { readSeed, type DatasetVersion } from '../../../../../eval/runner/skillopt-method/dataset.ts';
import { FRONTIER_TARGETS, openBrain } from '../../../../../eval/runner/skillopt-method/headroom.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const CEILING = 'docs/benchmarks/2026-11-02-skillopt-ceiling/runs';
const PROBE = 'docs/benchmarks/2026-11-01-skillopt-method/probe/frontier/f0b-sol/one-shot';
const STAND_IN = 'people/vera-chen-14';

/** `recorded`: the outcome the rollout row holds at gbrain 0.60.557.0 (the probe's input text holds 0.60.542.0 outcomes, so its calls have none). */
type Call = { source: string; dataset: DatasetVersion; skill: string; slug: string; args: Record<string, unknown> | null; recorded?: string; stand_in?: string };
type Outcome = { outcome: 'read' | 'refused' | 'arguments are not JSON'; class: string; code?: string; view?: string; applied?: string; ignored?: string[]; fell_through?: string; digest?: string };
type Run = { gbrain_version: string; calls: Array<Omit<Call, 'args' | 'dataset'> & Outcome> };

const refusalClass = (message: string, slug: string) => message.split(slug).join('<slug>').replace(/^get_page: /, '').replace(/[.]$/, '').replace(/^(known_as_of does not combine with) .*$/, '$1 read-view arguments');
const VOLATILE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const digest = (out: Record<string, unknown>) => createHash('sha256').update(JSON.stringify({ ...out, next_cursor: undefined, next: undefined }).replace(VOLATILE, '_')).digest('hex').slice(0, 16);

function parseError(text: string): { code?: string; message: string } {
  try { const e = JSON.parse(text) as { code?: string; message?: string }; return { code: e.code, message: e.message ?? text }; } catch { return { message: text }; }
}

function rolloutCalls(source: string, dataset: DatasetVersion, path: string): Call[] {
  const rows = gunzipSync(readFileSync(join(ROOT, path))).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return rows.filter(r => r.kind === 'rollout').flatMap(r => (r.tool_calls ?? []).filter((c: { name: string }) => c.name === 'get_page').map((c: { input: Record<string, unknown>; error?: string }) => {
    const slug = String(c.input.slug);
    return { source, dataset, skill: r.skill, slug, args: c.input, recorded: c.error === undefined ? 'read' : refusalClass(parseError(c.error).message, slug) };
  }));
}

function probeCalls(): Call[] {
  return (['query', 'briefing', 'fact-check'] as const).flatMap(skill => readFileSync(join(ROOT, PROBE, `sol-${skill}-input.txt`), 'utf8').split('\n').flatMap(line => {
    const m = /^- get_page ((?:\{|").*[}"]) returned /.exec(line);
    if (!m) return [];
    const input: unknown = JSON.parse(m[1]!);
    let args: Record<string, unknown> | null = null;
    try { args = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>; } catch { /* Sol sent arguments that are not JSON */ }
    const slug = String(args?.slug ?? '');
    const stand_in = slug === '[withheld]' ? STAND_IN : undefined;
    return [{ source: 'probe-sol', dataset: 'v2' as const, skill, slug, args: stand_in ? { ...args, slug: stand_in } : args, ...(stand_in ? { stand_in } : {}) }];
  }));
}

const SOURCES: Call[] = [
  ...probeCalls(),
  ...rolloutCalls('calibration-sol', 'v3', `${CEILING}/calibration-reread/sol/rows.jsonl.gz`),
  ...rolloutCalls('calibration-opus', 'v3', `${CEILING}/calibration-reread/opus/rows.jsonl.gz`),
  ...rolloutCalls('gate-1-opus', 'v3', `${CEILING}/gate-1/rows.jsonl.gz`),
];

const SELECTORS = ['cursor', 'around_chunk_id', 'lines', 'bytes'] as const;

function windowOf(out: Record<string, unknown>, args: Record<string, unknown>): string {
  const sel = out.window_selector as { applied?: string } | undefined;
  if (sel?.applied) return sel.applied;
  if (!out.window) return 'whole page';
  return SELECTORS.find(k => args[k] !== undefined && args[k] !== null && args[k] !== '' && args[k] !== 0) ?? 'first window';
}

async function replay(): Promise<Run> {
  const gbrain_version = readFileSync(join(ROOT, 'node_modules/gbrain/VERSION'), 'utf8').trim();
  const calls: Run['calls'] = [];
  for (const dataset of [...new Set(SOURCES.map(c => c.dataset))]) {
    await withHermeticEnv(`get-page-replay-${dataset}`, async () => {
      const engine = await openBrain(dataset);
      try {
        await runRollout({
          engine, skillText: readSeed('query'), targetModel: FRONTIER_TARGETS.sol, task: { task_id: 'get-page-replay', task: 'replay' } as BenchmarkTask, allowedTools: new Set(['get_page']),
          toolLoopFn: (async ({ toolHandlers }: { toolHandlers: Map<string, { execute: (args: unknown, ctx: never) => Promise<unknown> }> }) => {
            const getPage = toolHandlers.get('brain_get_page')!;
            for (const { args, dataset: _, ...call } of SOURCES.filter(c => c.dataset === dataset)) {
              if (!args) { calls.push({ ...call, outcome: 'arguments are not JSON', class: 'arguments are not JSON' }); continue; }
              try {
                const raw = await getPage.execute(args, {} as never);
                const out = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
                const sel = out.window_selector as { ignored?: string[]; note?: string } | undefined;
                const fell = sel?.note?.includes(', so this is the ') ? sel.note.split(', so this is the ')[0] : undefined;
                calls.push({ ...call, outcome: 'read', class: 'read', view: String(out.view ?? args.view ?? 'read'), applied: windowOf(out, args), ...(sel?.ignored ? { ignored: sel.ignored } : {}), ...(fell ? { fell_through: fell } : {}), digest: digest(out) });
              } catch (e) {
                const { code, message } = parseError((e as Error).message);
                calls.push({ ...call, outcome: 'refused', class: refusalClass(message, String(args.slug)), ...(code ? { code } : {}) });
              }
            }
            return { messages: [], stopReason: 'end', totalTurns: 0, totalUsage: {} };
          }) as never,
        });
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
  }
  return { gbrain_version, calls };
}

type Row = { source: string; class: string; total: number; matches_record?: number; refused_before: number; read_after: number; applied_after: Record<string, number>; refused_after: Record<string, number>; read_both: number; same_read: number };

function compare(before: Run, after: Run): Row[] {
  if (before.calls.length !== after.calls.length) throw new Error('the two runs replayed different call lists');
  const rows = new Map<string, Row>();
  before.calls.forEach((b, i) => {
    const a = after.calls[i]!;
    if (a.source !== b.source || a.slug !== b.slug) throw new Error(`call ${i} differs between runs`);
    const source = b.stand_in ? `${b.source} (slug withheld, stand-in ${b.stand_in})` : b.source;
    const key = `${source}\n${b.class}`;
    const r = rows.get(key) ?? { source, class: b.class, total: 0, refused_before: 0, read_after: 0, applied_after: {}, refused_after: {}, read_both: 0, same_read: 0 };
    r.total++;
    if (b.recorded !== undefined) r.matches_record = (r.matches_record ?? 0) + (b.recorded === b.class ? 1 : 0);
    if (b.outcome !== 'read') r.refused_before++;
    const applied = `${a.applied}${a.view === 'markdown' ? ' (view markdown)' : ''}${a.fell_through ? ' (after a fall-through)' : ''}`;
    if (a.outcome === 'read') { r.read_after++; r.applied_after[applied] = (r.applied_after[applied] ?? 0) + 1; } else {
      const k = `${a.code ?? 'no code'}: ${a.class}`;
      r.refused_after[k] = (r.refused_after[k] ?? 0) + 1;
    }
    if (a.outcome === 'read' && b.outcome === 'read') { r.read_both++; if (a.digest === b.digest) r.same_read++; }
    rows.set(key, r);
  });
  return [...rows.values()];
}

const [mode, x, y] = process.argv.slice(2);
if (mode === '--compare') {
  const [before, after] = [x!, y!].map(p => JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) as Run);
  console.log(JSON.stringify({ before: before!.gbrain_version, after: after!.gbrain_version, rows: compare(before!, after!) }, null, 1));
} else {
  if (!mode) throw new Error('usage: replay.ts <out.json.gz> | --compare <before.json.gz> <after.json.gz>');
  const run = await replay();
  writeFileSync(mode, gzipSync(JSON.stringify(run)));
  const tally: Record<string, Record<string, number>> = {};
  for (const c of run.calls) { const t = (tally[c.stand_in ? `${c.source} (stand-in)` : c.source] ??= {}); const k = c.outcome === 'read' ? `read (${c.applied})` : c.class; t[k] = (t[k] ?? 0) + 1; }
  console.log(JSON.stringify({ gbrain_version: run.gbrain_version, calls: run.calls.length, tally }, null, 1));
}

/**
 * Did the call note with the corrected terms reach the reader through `context_pack`? ($0, keyless brains, no reader.)
 * Re-executes every session-2 `context_pack` call a run made, with its recorded arguments, on the keyless rebuild of
 * that persona's base brain on the run's gbrain build (alias-probe.ts's slots), and records whether any of the results
 * contained the call note's slug. Cards do not depend on embeddings or the reranker, so a keyless brain returns the
 * same pages.
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/alias-stack/context-pack-replay.ts --gbrain <checkout> --ref <sha> --label <probe label> --arm <run dir> [--gold gold.json] [--out replay.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_KNOBS, generateHardWorld, renderHardDoc } from '../../../../eval/generators/program-primary-hard-gen.ts';
import { GbrainSlot, MeteringProxy } from '../../../../eval/runner/cat40/gbrain-arm.ts';
import { prepareBuild } from '../../../../eval/runner/lifecycle/builds.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ref = flag('--ref')!; const label = flag('--label')!; const armDir = flag('--arm')!;
const gold = JSON.parse(readFileSync(flag('--gold') ?? join(import.meta.dir, '..', 'root-cause', 'gold.json'), 'utf8'));
const jsonl = (base: string) => {
  const path = [`${base}.jsonl`, `${base}.jsonl.gz`].find(p => { try { readFileSync(p); return true; } catch { return false; } })!;
  const raw = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(raw) : raw).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
};
const cells = jsonl(join(armDir, 'results')).filter((c: any) => c.arm === 'baseline');
const usage = new Map<string, any[]>();
for (const r of jsonl(join(armDir, 'usage'))) if (String(r.question_id).endsWith(':s2')) usage.set(r.cell, [...(usage.get(r.cell) ?? []), r]);
const packCalls = (key: string) => (usage.get(key) ?? []).sort((a, b) => a.attempt - b.attempt).flatMap(r =>
  String(r.answer ?? '').split(/\n(?=\[tool_use )/).flatMap(blk => {
    const m = /^\[tool_use (\w+)\] ([\s\S]*)$/.exec(blk);
    if (!m || m[1] !== 'context_pack') return [];
    try { return [JSON.parse(m[2].trim())]; } catch { return []; }
  }));

const root = join(process.env.HOME!, '.capy/work/alias/probe');
const proxy = new MeteringProxy({}); proxy.start();
const build = prepareBuild(flag('--gbrain')!, { label: `alias-probe-${label}`, ref, description: 'alias probe' }, join(root, 'builds'));
const personas = [...new Set(cells.map((c: any) => c.persona as string))].sort();
const world = generateHardWorld(personas.map(p => Number(p.slice(1))), DEFAULT_KNOBS);
const rows: any[] = [];
try {
  for (const p of world.personas) {
    const slot = new GbrainSlot(`${p.id}-${label}`, join(root, 'slots'), build.dir, proxy.port, 'starter');
    if (!slot.hasSnapshot()) await slot.build({ docs: p.docs }, proxy, true, { render: renderHardDoc, embed: false });
    await slot.restore();
    const cache = new Map<string, string>();
    for (const c of cells.filter((x: any) => x.persona === p.id)) {
      const g = gold[c.task];
      const calls = packCalls(c.key);
      let reached = false;
      for (const args of calls) {
        const k = JSON.stringify(args);
        if (!cache.has(k)) cache.set(k, await slot.client!.call('context_pack', args).catch(e => `error ${(e as Error).message}`));
        if (cache.get(k)!.includes(g.docs.terms)) reached = true;
      }
      rows.push({ key: c.key, task: c.task, reader: c.reader, repeat: c.repeat, context_pack_calls: calls.length, call_note_in_context_pack: reached });
    }
    await slot.stop();
    console.error(`[replay] ${p.id} done`);
  }
} finally { proxy.stop(); }
const by = (r: string) => rows.filter(x => x.reader === r);
const summary = Object.fromEntries([...new Set(rows.map(r => r.reader))].sort().map(r => [r, { runs: by(r).length, with_context_pack: by(r).filter(x => x.context_pack_calls).length, call_note_in_context_pack: by(r).filter(x => x.call_note_in_context_pack).length }]));
if (flag('--out')) writeFileSync(flag('--out')!, JSON.stringify({ gbrain: { ref, commit: build.commit, tree: build.tree }, summary, rows }, null, 1) + '\n');
console.log(JSON.stringify(summary, null, 1));

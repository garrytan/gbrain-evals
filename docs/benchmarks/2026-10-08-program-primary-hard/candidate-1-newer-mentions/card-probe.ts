/**
 * Candidate 1 mechanism probe ($0, keyless brains): build each development persona's base brain on a gbrain build,
 * call context_pack on each task's champion and company exactly as the readers' first call does, and record whether
 * the correcting pages (handoff, reschedule, call note) are in the result, its size and latency. No reader runs.
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-1-newer-mentions/card-probe.ts --gbrain <checkout> --ref <sha> --label <name>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_KNOBS, PPH_BASELINE_SEEDS, generateHardWorld, renderHardDoc, type HardPersona } from '../../../../eval/generators/program-primary-hard-gen.ts';
import { GbrainSlot, MeteringProxy } from '../../../../eval/runner/cat40/gbrain-arm.ts';
import { prepareBuild } from '../../../../eval/runner/lifecycle/builds.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ref = flag('--ref')!; const label = flag('--label')!;
const root = join(process.env.HOME!, '.capy/work/c1/card-probe');
mkdirSync(root, { recursive: true });
const world = generateHardWorld([...PPH_BASELINE_SEEDS], DEFAULT_KNOBS);
const proxy = new MeteringProxy({}); proxy.start();
const build = prepareBuild(flag('--gbrain')!, { label: `probe-${label}`, ref, description: 'card probe' }, join(root, 'builds'));
const gold = JSON.parse(readFileSync(join(import.meta.dir, '..', 'root-cause', 'gold.json'), 'utf8'));
const rows: any[] = [];
async function doPersona(p: HardPersona) {
  const slot = new GbrainSlot(`${p.id}-${label}`, join(root, 'slots'), build.dir, proxy.port, 'starter');
  if (!slot.hasSnapshot()) await slot.build({ docs: p.docs }, proxy, true, { render: renderHardDoc, embed: false });
  await slot.restore();
  for (const t of p.tasks) {
    const g = gold[t.id];
    const args = { entities: `${g.champion_slug},${g.company}` };
    const t0 = performance.now();
    const res = await slot.client!.call('context_pack', args);
    const ms = performance.now() - t0;
    const docs = Object.values(g.docs) as string[];
    rows.push({ persona: p.id, task: t.id, args, ms: Math.round(ms), chars: res.length,
      present: Object.fromEntries(docs.map(d => [d, res.includes(d)])), newer_rows: (res.match(/"date":"20/g) ?? []).length });
  }
  await slot.stop();
}
try {
  const q = [...world.personas];
  await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await doPersona(q.shift()!); }));
} finally { proxy.stop(); }
writeFileSync(join(root, `${label}.json`), JSON.stringify({ gbrain: { ref, commit: build.commit, tree: build.tree, version: build.version }, rows }, null, 1));
console.log(JSON.stringify(rows.map(r => [r.task, r.ms, r.chars, Object.values(r.present).map(Boolean).map(Number).join('')])));

/**
 * Candidate 3 mechanism probe ($0, keyless brains): build each persona's base brain on a gbrain build and call
 * context_pack the two ways readers open a task (champion plus the company's name, and champion plus the company's
 * short code, as the prep prompt names it), recording whether the call note, the technical review, the handoff and the
 * reschedule mail are in the result, its size and latency. No reader runs.
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-3/card-probe.ts --gbrain <checkout> --ref <sha|merge:a+b> --label <name> [--seeds dev|fresh|a,b]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_KNOBS, PPH_BASELINE_SEEDS, PPH_FRESH_SEEDS_C1, generateHardWorld, renderHardDoc, type HardPersona } from '../../../../eval/generators/program-primary-hard-gen.ts';
import { GbrainSlot, MeteringProxy } from '../../../../eval/runner/cat40/gbrain-arm.ts';
import { prepareBuild } from '../../../../eval/runner/lifecycle/builds.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ref = flag('--ref')!; const label = flag('--label')!;
const seedArg = flag('--seeds') ?? 'dev';
const seeds = seedArg === 'dev' ? [...PPH_BASELINE_SEEDS] : seedArg === 'fresh' ? [...PPH_FRESH_SEEDS_C1] : seedArg.split(',').map(Number);
const root = join(process.env.HOME!, '.capy/work/c3/card-probe');
mkdirSync(root, { recursive: true });
const world = generateHardWorld(seeds, DEFAULT_KNOBS);
const proxy = new MeteringProxy({}); proxy.start();
const build = prepareBuild(flag('--gbrain')!, { label: `probe-${label}`, ref, description: 'card probe' }, join(root, 'builds'));
const rows: any[] = [];
async function doPersona(p: HardPersona) {
  const slot = new GbrainSlot(`${p.id}-${label}`, join(root, 'slots'), build.dir, proxy.port, 'starter');
  if (!slot.hasSnapshot()) await slot.build({ docs: p.docs }, proxy, true, { render: renderHardDoc, embed: false });
  await slot.restore();
  for (const t of p.tasks) {
    const code = p.docs.find(d => d.id === t.gold.evidence[1])!.body.match(/Also called (\w+) in my notes/)![1];
    const docs = { call: t.gold.item_docs.find(d => d.endsWith('-call'))!, hop: t.gold.item_docs.find(d => d.includes('technical-review'))!,
      handoff: t.gold.item_docs.find(d => d.includes('handoff'))!, reschedule: t.gold.item_docs.find(d => d.includes('reschedule'))! };
    for (const [form, entities] of [['name', `${t.contact_name}, ${t.company}`], ['code', `${t.contact_name}, ${code}`]] as const) {
      const t0 = performance.now();
      const res = await slot.client!.call('context_pack', { entities });
      const ms = performance.now() - t0;
      rows.push({ persona: p.id, task: t.id, form, entities, ms: Math.round(ms), chars: res.length,
        present: Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, res.includes(d)])) });
    }
  }
  await slot.stop();
}
try {
  const q = [...world.personas];
  await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await doPersona(q.shift()!); }));
} finally { proxy.stop(); }
const tally: Record<string, Record<string, number>> = {};
for (const r of rows) for (const [k, v] of Object.entries(r.present)) { (tally[r.form] ??= {})[k] = (tally[r.form][k] ?? 0) + Number(v); }
const out = { gbrain: { ref, commit: build.commit, tree: build.tree, version: build.version, merge: build.merge ?? null }, seeds, tasks: rows.length / 2, tally, rows };
writeFileSync(join(root, `${label}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ label, tasks: out.tasks, tally }));

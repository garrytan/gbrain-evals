/**
 * Candidate 3 root cause: rebuild the Candidate 1 arm's brains on a gbrain build and re-execute the session-2 tool
 * calls of every cell that failed on terms or the hop commitment (development and fresh seeds), recording for each
 * call whether the call note, the technical review, the deal and the company page are in the result and at what
 * position among the slugs it lists. Embeddings and reranking are live (paid calls go through the budget ledger).
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-3/rank-replay.ts --gbrain <checkout> --ref <sha> --label <name> --budget-run-id <id>
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_KNOBS, PPH_BASELINE_SEEDS, PPH_FRESH_SEEDS_C1, generateHardWorld, renderHardDoc, type HardPersona } from '../../../../eval/generators/program-primary-hard-gen.ts';
import { GbrainSlot, MeteringProxy, rerankProbe } from '../../../../eval/runner/cat40/gbrain-arm.ts';
import { prepareBuild } from '../../../../eval/runner/lifecycle/builds.ts';
import { startPaidRun, budgetOptionsFrom, receiptCost } from '../../../../eval/runner/budget-ledger.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ref = flag('--ref')!; const label = flag('--label')!;
const root = join(process.env.HOME!, '.capy/work/c3/rank-replay');
mkdirSync(root, { recursive: true });
const C1 = join(import.meta.dir, '..', 'candidate-1-newer-mentions');
const jl = (p: string) => gunzipSync(readFileSync(p)).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
const arms = [['dev', join(C1, 'candidate-1')], ['fresh', join(C1, 'fresh-seeds', 'candidate-1')]] as const;
const world = generateHardWorld([...PPH_BASELINE_SEEDS, ...PPH_FRESH_SEEDS_C1], DEFAULT_KNOBS);
const taskOf = new Map(world.personas.flatMap(p => p.tasks.map(t => [t.id, { p, t }] as const)));
const want = (t: HardPersona['tasks'][number]) => ({
  call: t.gold.item_docs.find(d => d.endsWith('-call'))!, hop: t.gold.item_docs.find(d => d.includes('technical-review'))!,
  deal: t.gold.evidence[2], company: t.gold.evidence[1], champion: t.contact,
});
function calls(usage: any[], key: string) {
  const rs = usage.filter(r => r.cell === key && r.question_id.endsWith(':s2')).sort((a, b) => a.attempt - b.attempt);
  const out: Array<{ name: string; args: any }> = [];
  for (const r of rs) for (const blk of String(r.answer ?? '').split(/\n(?=\[tool_use )/)) {
    const m = blk.match(/^\[tool_use (\w+)\] ([\s\S]*)$/); if (!m || m[1] === 'submit_answer') continue;
    let args: any; try { args = JSON.parse(m[2].trim()); } catch { args = null; }
    out.push({ name: m[1], args });
  }
  return out;
}
const failing: Array<{ arm: string; cell: any; calls: Array<{ name: string; args: any }> }> = [];
for (const [arm, dir] of arms) {
  const usage = jl(join(dir, 'usage.jsonl.gz'));
  for (const c of jl(join(dir, 'results.jsonl.gz'))) {
    if (c.arm !== 'baseline' || !c.score.failed) continue;
    const { t } = taskOf.get(c.task)!;
    const termsStale = t.gold.corrections[0].stale.patterns;
    const terms = c.score.kinds.includes('stale_correction') && c.score.stale_correction_mentions.some((m: string) => termsStale.some(p => new RegExp(p, 'i').test(m)));
    const hop = c.score.commitments_missed.includes(t.gold.commitments[0].label);
    if (terms || hop) failing.push({ arm, cell: { ...c, classes: [terms && 'terms', hop && 'hop'].filter(Boolean) }, calls: calls(usage, c.key) });
  }
}
console.error(`${failing.length} failing cells`);
const budget = startPaidRun('t0b-candidate-3-rank-replay', { ...budgetOptionsFrom(argv), estimateUsd: 2 });
const proxy = new MeteringProxy({}); proxy.start();
const build = prepareBuild(flag('--gbrain')!, { label: `rank-${label}`, ref, description: 'rank replay' }, join(root, 'builds'));
const positions = (res: string, slug: string) => {
  const slugs = [...res.matchAll(/(?:people|companies|deals|meetings|inbox|notes)\/[a-z0-9\-\/]+/g)].map(m => m[0]).filter((s, i, a) => a.indexOf(s) === i);
  const i = slugs.indexOf(slug);
  return { present: res.includes(slug), position: i < 0 ? null : i, listed: slugs.length };
};
const rows: any[] = [];
const personas = [...new Set(failing.map(f => f.cell.persona))];
async function doPersona(pid: string) {
  const p = world.personas.find(x => x.id === pid)!;
  const slot = new GbrainSlot(`${p.id}-${label}`, join(root, 'slots'), build.dir, proxy.port, 'starter');
  if (!slot.hasSnapshot()) { const b = await slot.build({ docs: p.docs }, proxy, true, { render: renderHardDoc, embed: true }); console.error(`built ${p.id} $${b.meter.usd.toFixed(4)}`); }
  await slot.restore();
  await rerankProbe([slot], proxy, 'pilot kickoff');
  for (const f of failing.filter(x => x.cell.persona === pid)) {
    await slot.restore();
    const w = want(taskOf.get(f.cell.task)!.t);
    const rec: any = { arm: f.arm, key: f.cell.key, classes: f.cell.classes, want: w, calls: [] };
    for (const k of f.calls) {
      let r: string; try { r = k.args ? await slot.client!.call(k.name, k.args) : 'unparsed args'; } catch (e) { r = 'Error ' + (e as Error).message; }
      rec.calls.push({ ...k, chars: r.length, call: positions(r, w.call), hop: positions(r, w.hop), deal: positions(r, w.deal), company: positions(r, w.company) });
    }
    rows.push(rec);
  }
  await slot.stop();
}
try {
  const q = [...personas];
  await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await doPersona(q.shift()!); }));
} finally {
  proxy.stop();
  const s = budget.run.close();
  writeFileSync(join(root, `${label}.json`), JSON.stringify({ gbrain: { ref, commit: build.commit, tree: build.tree, version: build.version }, cost: receiptCost(s), rows }, null, 1));
  console.log(JSON.stringify(receiptCost(s)));
}

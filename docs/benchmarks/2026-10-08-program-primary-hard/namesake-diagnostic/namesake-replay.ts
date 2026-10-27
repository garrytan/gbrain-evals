/**
 * Namesake diagnostic ($0, keyless brains, no reader). For each T0b run whose answer contains a namesake value (scored
 * `unsupported`, or excused by the scorer's disambiguation rule), re-execute every read call the run made in session 2,
 * with its recorded arguments and in order, on the keyless rebuild of that persona's base brain on the run's gbrain
 * build (alias-probe.ts's slots), and record which results carried the namesake: the namesake person's page or name,
 * or the daily note that holds the namesake's promise. For `context_pack` and `entity` calls it also records which
 * entities the call resolved. The pushed hook text is checked as recorded.
 *
 * Keyword search on a keyless brain is not the reranked search the reader saw, so `search` rows are approximate;
 * `context_pack`, `entity`, `get_page`, `get_backlinks` and `resolve_slugs` do not depend on embeddings.
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/alias-stack/namesake-replay.ts --gbrain <checkout> --ref <sha> --label <probe label> --arm <run dir> [--out out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_KNOBS, generateHardWorld, renderHardDoc, type HardPersona, type HardTask } from '../../../../eval/generators/program-primary-hard-gen.ts';
import { GbrainSlot, MeteringProxy } from '../../../../eval/runner/cat40/gbrain-arm.ts';
import { prepareBuild } from '../../../../eval/runner/lifecycle/builds.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ref = flag('--ref')!; const label = flag('--label')!; const armDir = flag('--arm')!;
const READS = new Set(['context_pack', 'entity', 'search', 'query', 'get_page', 'get_backlinks', 'resolve_slugs', 'list_pages', 'get_links', 'recall', 'get_timeline']);
const jsonl = (base: string) => {
  const path = [`${base}.jsonl`, `${base}.jsonl.gz`].find(p => { try { readFileSync(p); return true; } catch { return false; } })!;
  const raw = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(raw) : raw).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
};

/** The namesake of a task as the generator wrote it: the daily note line, the person, their company code. */
export function namesakeOf(p: HardPersona, t: HardTask) {
  const item = t.gold.namesake.find(m => m.label.startsWith('namesake commitment: '))!.label.slice('namesake commitment: '.length);
  const seats = t.gold.namesake.find(m => / seats$/.test(m.label))!.label.match(/(\d+) seats/)![1];
  const daily = p.docs.find(d => d.body.includes(`asked about ${seats} seats; I owe `) && d.body.includes(item))!;
  const line = daily.body.split('\n').find(l => l.includes(`asked about ${seats} seats; I owe `) && l.includes(item))!.replace(/^- /, '');
  const name = line.slice(0, line.indexOf(' ('));
  return { name, slug: `people/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, daily: daily.id, line, item };
}

const all = jsonl(join(armDir, 'results')).filter((c: any) => c.arm === 'baseline');
const allWorld = generateHardWorld([...new Set(all.map((c: any) => Number(c.persona.slice(1))))].sort(), DEFAULT_KNOBS);
const taskOf = (id: string) => allWorld.personas.flatMap(p => p.tasks).find(t => t.id === id)!;
/** Every run whose answer names a namesake value, whether the scorer counted it (`unsupported`) or excused it. */
const targets = all.filter((c: any) => taskOf(c.task).gold.namesake.some(m => m.patterns.some(pt => new RegExp(pt, 'i').test(c.sessions[1].answer ?? ''))));
const usage = new Map<string, any[]>();
for (const r of jsonl(join(armDir, 'usage'))) if (String(r.question_id).endsWith(':s2')) usage.set(r.cell, [...(usage.get(r.cell) ?? []), r]);
const calls = (key: string) => (usage.get(key) ?? []).sort((a, b) => a.attempt - b.attempt).flatMap(r =>
  String(r.answer ?? '').split(/\n(?=\[tool_use )/).flatMap(blk => {
    const m = /^\[tool_use (\w+)\] ([\s\S]*)$/.exec(blk);
    if (!m || m[1] === 'submit_answer') return [];
    try { return [{ name: m[1], args: JSON.parse(m[2].trim()) }]; } catch { return [{ name: m[1], args: null }]; }
  }));

const root = join(process.env.HOME!, '.capy/work/alias/probe');
const proxy = new MeteringProxy({}); proxy.start();
const build = prepareBuild(flag('--gbrain')!, { label: `alias-probe-${label}`, ref, description: 'alias probe' }, join(root, 'builds'));
const personas = [...new Set(targets.map((c: any) => c.persona as string))].sort();
const world = { personas: allWorld.personas.filter(p => personas.includes(p.id)) };
const rows: any[] = [];
try {
  for (const p of world.personas) {
    const slot = new GbrainSlot(`${p.id}-${label}`, join(root, 'slots'), build.dir, proxy.port, 'starter');
    if (!slot.hasSnapshot()) await slot.build({ docs: p.docs }, proxy, true, { render: renderHardDoc, embed: false });
    await slot.restore();
    for (const c of targets.filter((x: any) => x.persona === p.id)) {
      const t = p.tasks.find(x => x.id === c.task)!;
      const ns = namesakeOf(p, t);
      const carries = (s: string) => ({ page: s.includes(ns.slug), name: s.includes(ns.name), daily: s.includes(ns.daily) || s.includes(ns.line.slice(0, 40)) });
      const hookText = (c.sessions[1].hooks ?? []).map((h: any) => h.text ?? '').join('\n');
      const recorded = c.sessions[1].tool_calls ?? [];
      const trace: any[] = [];
      let i = 0;
      for (const call of calls(c.key)) {
        const rec = recorded[i++];
        if (!READS.has(call.name) || !call.args) { trace.push({ name: call.name, args: call.args, replayed: false }); continue; }
        const res = await slot.client!.call(call.name, call.args).catch(e => `error ${(e as Error).message}`);
        const resolved = call.name === 'context_pack' || call.name === 'entity' ? [...new Set([...res.matchAll(/people\/[a-z0-9-]+/g)].map(m => m[0]))] : undefined;
        trace.push({ name: call.name, args: call.args, recorded_chars: rec?.chars ?? null, replay_chars: res.length, carries: carries(res), resolved_people: resolved });
      }
      const first = trace.findIndex(x => x.carries && (x.carries.page || x.carries.name || x.carries.daily));
      rows.push({ key: c.key, task: c.task, reader: c.reader, contact: t.contact_name, contact_slug: t.contact, namesake: ns,
        hits: c.score.namesake_hits, scored_unsupported: c.score.kinds.includes('unsupported'),
        lines: (c.sessions[1].answer ?? '').split(/\n+/).filter((l: string) => t.gold.namesake.some(m => m.patterns.some(pt => new RegExp(pt, 'i').test(l)))), hook_carries: carries(hookText), first_carrier: first >= 0 ? { index: first, ...trace[first] } : null, trace });
    }
    await slot.stop();
    console.error(`[namesake] ${p.id} done`);
  }
} finally { proxy.stop(); }
if (flag('--out')) writeFileSync(flag('--out')!, JSON.stringify({ gbrain: { ref, commit: build.commit, tree: build.tree }, rows }, null, 1) + '\n');
for (const r of rows) console.log(r.key, '|', r.namesake.name, '|', r.first_carrier ? `${r.first_carrier.name} ${JSON.stringify(r.first_carrier.args)} ${JSON.stringify(r.first_carrier.carries)}` : 'none', '| hook', JSON.stringify(r.hook_carries));

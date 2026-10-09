/**
 * T0b root cause: rebuild the baseline brains and re-execute every recorded tool call of the 144 baseline cells
 * (sessions 1 and 2, in order) on a restored brain, recording each session-2 result beside the original result's size.
 * --dead-voyage points the Voyage endpoint at a dead port after each restore (the condition the baseline's repeat 2
 * ran under); --repeat-only N limits the cells. Paid provider calls (embeddings, query-time calls) go through the
 * budget ledger.
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/root-cause/replay.ts --gbrain <checkout> --ref 7aa2caa0 --label frozen
 *     [--personas h20261101,...] [--concurrency 4] [--dead-voyage] [--repeat-only 2] --budget-run-id <id>
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_KNOBS, PPH_BASELINE_SEEDS, generateHardWorld, renderHardDoc, type HardPersona } from '../../../../eval/generators/program-primary-hard-gen.ts';
import { GbrainSlot, MeteringProxy } from '../../../../eval/runner/cat40/gbrain-arm.ts';
import { prepareBuild } from '../../../../eval/runner/lifecycle/builds.ts';
import { startPaidRun, budgetOptionsFrom, receiptCost } from '../../../../eval/runner/budget-ledger.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ref = flag('--ref')!; const label = flag('--label')!;
const out = join('eval/reports/t0b-root-cause', label + (argv.includes('--dead-voyage') ? '-deadvoyage' : '')); mkdirSync(out, { recursive: true });
const B = join(import.meta.dir, '..', 'baseline') + '/';
const cells = gunzipSync(readFileSync(B + 'results.jsonl.gz')).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((c: any) => c.arm === 'baseline');
const usage: Record<string, any[]> = {};
for (const l of gunzipSync(readFileSync(B + 'usage.jsonl.gz')).toString().split('\n').filter(Boolean)) { const r = JSON.parse(l); (usage[r.cell] ??= []).push(r); }
function calls(key: string, s: 's1' | 's2') {
  const rs = (usage[key] ?? []).filter(r => r.question_id.endsWith(':' + s)).sort((a, b) => a.attempt - b.attempt);
  const outc: Array<{ name: string; args: any }> = [];
  for (const r of rs) for (const blk of String(r.answer ?? '').split(/\n(?=\[tool_use )/)) {
    const m = blk.match(/^\[tool_use (\w+)\] ([\s\S]*)$/); if (!m || m[1] === 'submit_answer') continue;
    let args: any; try { args = JSON.parse(m[2].trim()); } catch { args = null; }
    outc.push({ name: m[1], args });
  }
  return outc;
}
const onlyPersonas = flag('--personas')?.split(',');
const deadVoyage = argv.includes('--dead-voyage'); const onlyRepeat = flag('--repeat-only');
const world = generateHardWorld([...PPH_BASELINE_SEEDS], DEFAULT_KNOBS);
const budget = startPaidRun('t0b-root-cause-replay', { ...budgetOptionsFrom(argv), estimateUsd: 2 });
const proxy = new MeteringProxy({}); proxy.start();
const root = 'eval/reports/t0b-root-cause/work';
const build = prepareBuild(flag('--gbrain') ?? '../gbrain', { label: `replay-${label}`, ref, description: 'replay' }, join(root, 'builds'));
function sql(dir: string, q: string): any[] {
  const pglite = join(build.dir, 'node_modules/@electric-sql/pglite/dist');
  const script = `const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)}); const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)}); const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)}); const db = await PGlite.create({ dataDir: ${JSON.stringify(join(dir, 'home', 'brain.pglite'))}, extensions: { vector, pg_trgm } }); const r = await db.query(${JSON.stringify(q)}); console.log(JSON.stringify(r.rows)); await db.close();`;
  try { return JSON.parse(execFileSync('bun', ['-e', script], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop()!); } catch (e) { return [{ error: String((e as Error).message).slice(0, 300) }]; }
}
const conc = Number(flag('--concurrency') ?? 4);
const personas = world.personas.filter(p => !onlyPersonas || onlyPersonas.includes(p.id));
async function doPersona(p: HardPersona) {
  const slot = new GbrainSlot(`${p.id}-base`, join(root, 'slots-' + label), build.dir, proxy.port, 'starter');
  const stamp = join(root, 'slots-' + label, `${p.id}.built`);
  if (!(slot.hasSnapshot() && existsSync(stamp))) {
    const b = await slot.build({ docs: p.docs }, proxy, true, { render: renderHardDoc, embed: true });
    writeFileSync(stamp, JSON.stringify({ steps: b.steps.map(s => ({ step: s.step, code: s.code, ms: s.ms, tail: s.tail })), usd: b.meter.usd }));
    console.error(`built ${p.id} $${b.meter.usd.toFixed(4)}`);
  }
  await slot.stop();
  const inspect = {
    facts: sql(slot.dir, 'select count(*)::int n from facts'),
    jobs: sql(slot.dir, 'select name, status, count(*)::int n from minion_jobs group by 1,2'),
    corr_links: sql(slot.dir, `select p1.slug as from_slug, p2.slug as to_slug, l.link_type from links l join pages p1 on p1.id=l.from_page_id join pages p2 on p2.id=l.to_page_id where p1.slug like 'inbox/%handoff%' or p1.slug like 'inbox/%reschedule%' or p2.slug like 'inbox/%handoff%' or p2.slug like 'inbox/%reschedule%' or p1.slug in (${p.tasks.map(t => `'${t.gold.correction_docs.find(d => d.startsWith('meetings/'))}'`).join(',')})`),
  };
  writeFileSync(join(out, `${p.id}.inspect.json`), JSON.stringify(inspect, null, 1));
  const mine = cells.filter((c: any) => c.persona === p.id);
  for (const c of mine) {
    if (existsSync(join(out, 'cells', `${c.key.replaceAll('|', '_')}.json`))) continue;
    if (onlyRepeat && String(c.repeat) !== onlyRepeat) continue;
    await slot.restore();
    if (deadVoyage) { const cfgPath = join(slot.dir, 'home', '.gbrain', 'config.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); cfg.provider_base_urls.voyage = 'http://127.0.0.1:9/' + slot.id + '/voyage/v1'; writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); await slot.newSession(); }
    const rec: any = { key: c.key, s1: [], s2: [] };
    for (const k of calls(c.key, 's1')) { let r: string; try { r = k.args ? await slot.client!.call(k.name, k.args) : 'unparsed args'; } catch (e) { r = 'Error ' + (e as Error).message; } rec.s1.push({ ...k, result: r.slice(0, 2000) }); }
    await slot.stop();
    if (c === mine[0]) rec.after_s1_facts = sql(slot.dir, "select id, entity_slug, kind, fact, valid_from, superseded_by, source from facts order by id");
    await slot.start();
    const orig = c.sessions[1].tool_calls;
    let i = 0;
    for (const k of calls(c.key, 's2')) { let r: string; try { r = k.args ? await slot.client!.call(k.name, k.args) : 'unparsed args'; } catch (e) { r = 'Error ' + (e as Error).message; } rec.s2.push({ ...k, orig_chars: orig[i]?.chars, orig_name: orig[i]?.name, result: r }); i++; }
    await slot.stop();
    mkdirSync(join(out, 'cells'), { recursive: true });
    writeFileSync(join(out, 'cells', `${c.key.replaceAll('|', '_')}.json`), JSON.stringify(rec));
    console.error(`replayed ${c.key}`);
  }
}
try {
  const q = [...personas];
  await Promise.all(Array.from({ length: conc }, async () => { while (q.length) await doPersona(q.shift()!); }));
} finally {
  proxy.stop();
  const s = budget.run.close();
  writeFileSync(join(out, `cost-${Date.now()}.json`), JSON.stringify(receiptCost(s), null, 2));
}

/**
 * Entity-resolution head-to-head, memory systems: ingest the smoke world through a running shim, one page per session,
 * read its entity nodes (GET /entities, eval/systems/PROTOCOL.md "Entity readout") and write the neutral readout.
 *
 * The stack runs under bootstrap.sh (`up --system <kind> --config entity-h2h`) behind a lease-mode metering proxy,
 * which holds the provider key and writes one usage line per provider call. The driver binds the kind's proxy slot to
 * each page's key around its /ingest, to "finish" around /finish and to "entities" around the readout, so every call
 * is attributed to the step that made it.
 *
 *   bun eval/runner/entity-h2h/shim-smoke.ts --system <kind> --shim http://127.0.0.1:8700 --world DIR --out DIR
 *     --usage-log FILE [--proxy http://127.0.0.1:8787] [--seed N] [--limit N] [--label L] [--drain-each]
 *
 * --drain-each calls /finish inside each page's binding, for a shim whose /ingest only queues the work
 * (ext-extract-first), so the page's provider calls land on its key.
 * Writes readout.json (the neutral shape), subjects.json (each page's subject node), entities.json (the raw
 * readout), run.json (versions, timings, usage per page and the sanity score). Nothing here holds a provider key.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PERSON_DEDUPE_DEFAULT_SEED } from '../../generators/person-dedupe-gen.ts';
import { ProxyControl } from '../metering-proxy.ts';
import { HttpMemorySystem } from '../systems/http.ts';
import { loadSmokeWorld, opaque, readoutFromEntities, scoreReadout, usageByKey, type EntitiesResponse } from './world.ts';

const arg = (flag: string) => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : undefined; };
const need = (flag: string) => arg(flag) ?? (() => { throw new Error(`shim-smoke: ${flag} is required`); })();

async function main(): Promise<void> {
  const system = need('--system'), shim = need('--shim').replace(/\/$/, ''), out = resolve(need('--out')), usageLog = resolve(need('--usage-log'));
  const proxy = new ProxyControl(arg('--proxy') ?? 'http://127.0.0.1:8787');
  const seed = Number(arg('--seed') ?? PERSON_DEDUPE_DEFAULT_SEED);
  const label = arg('--label') ?? `entity-h2h-smoke-${system}`;
  const drainEach = process.argv.includes('--drain-each');
  const { ledger, pages: all, fingerprint } = loadSmokeWorld(resolve(need('--world')), seed);
  const pages = arg('--limit') ? all.slice(0, Number(arg('--limit'))) : all;
  mkdirSync(out, { recursive: true });

  const client = new HttpMemorySystem(shim, { name: system });
  const capabilities = await client.capabilities();
  const health = await client.health();
  const ns = opaque('ns', label);
  const sourceOf = new Map(pages.map(p => [p.key, opaque('src', label, p.key)]));
  const keyOf = new Map([...sourceOf].map(([k, s]) => [s, k]));
  await client.reset(ns);

  const timings: Record<string, number> = {};
  const ingest: Record<string, unknown> = {};
  const started = performance.now();
  const startedAt = new Date().toISOString();
  for (const [i, p] of pages.entries()) {
    const t0 = performance.now();
    const event = new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString();
    const r = await proxy.around(system, p.key, async () => {
      const res = await client.ingestSession(ns, { source_id: sourceOf.get(p.key)!, turns: [{ role: 'user', speaker: 'notes', content: readFileSync(p.path, 'utf8') }] }, event);
      return drainEach ? { ...res, drained: await client.finishIngest(ns, 3600) } : res;
    });
    timings[p.key] = (performance.now() - t0) / 1000;
    ingest[p.key] = r.error ? { error: String(r.error) } : r.value;
    console.log(`[${i + 1}/${pages.length}] ${p.key} ${timings[p.key].toFixed(1)}s $${r.meter.usd.toFixed(4)}${r.error ? ` ERROR ${String(r.error).slice(0, 200)}` : ''}`);
  }
  const t1 = performance.now();
  const fin = await proxy.around(system, 'finish', () => client.finishIngest(ns, 3600));
  timings.finish = (performance.now() - t1) / 1000;
  const t2 = performance.now();
  const ent = await proxy.around(system, 'entities', async () => {
    const res = await fetch(`${shim}/entities?ns=${ns}`);
    const json = await res.json() as EntitiesResponse & { error?: { message: string } };
    if (!res.ok || json.error) throw new Error(`GET /entities: HTTP ${res.status} ${json.error?.message ?? ''}`);
    return json;
  });
  timings.entities = (performance.now() - t2) / 1000;
  const wall = (performance.now() - started) / 1000;
  if (ent.error) throw ent.error;
  const entities = ent.value!;
  for (const e of entities.entities) e.source_ids = e.source_ids.filter(s => keyOf.has(s));

  const versions = (capabilities as { versions?: Record<string, unknown> }).versions ?? {};
  const config = (capabilities as { configs?: Record<string, unknown> }).configs ?? {};
  const roles = (Object.values(config)[0] as { model_roles?: Record<string, unknown> } | undefined)?.model_roles ?? {};
  const { readout, subjects } = readoutFromEntities(pages, sourceOf, entities, {
    system, version: String(versions.package ?? 'unknown'), config: { name: (health as { config?: string }).config ?? null, model_roles: roles },
    model: String(roles.extraction ?? 'unknown'),
  });
  const usage = usageByKey(usageLog, k => sourceOf.has(k) || k === 'finish' || k === 'entities', startedAt);
  const score = scoreReadout(ledger, pages, readout);
  writeFileSync(join(out, 'readout.json'), JSON.stringify(readout, null, 2) + '\n');
  writeFileSync(join(out, 'subjects.json'), JSON.stringify(subjects, null, 2) + '\n');
  writeFileSync(join(out, 'entities.json'), JSON.stringify(entities, null, 2) + '\n');
  writeFileSync(join(out, 'run.json'), JSON.stringify({
    system, label, ns, seed, per_family: ledger.per_family, ledger_sha256: fingerprint, pages: pages.length,
    capabilities, health, timings_s: timings, wall_s: wall, drain_each: drainEach, ingest, finish: fin.error ? { error: String(fin.error) } : fin.value,
    usage: Object.fromEntries(usage), subjects_unresolved: subjects.filter(s => !s.node).map(s => s.key),
    sanity_score: Object.fromEntries(Object.entries(score).map(([t, s]) => [t, { false_merge: s.false_merge, precision: s.precision, recall: s.recall, b3: s.b3, groups: s.groups, false_merge_cases: s.false_merge_cases }])),
  }, null, 2) + '\n');
  const unresolved = subjects.filter(s => !s.node).length;
  console.log(`${system}: ${entities.entities.length} entity nodes; ${pages.length - unresolved}/${pages.length} subjects resolved; auto groups ${readout.tiers.auto.length}, proposed ${readout.tiers.proposed.length}`);
  for (const [t, s] of Object.entries(score)) console.log(`  ${t}: false merges ${s.false_merge.k}/${s.false_merge.n}; same-person pairs found ${s.recall.k}/${s.recall.n}`);
}

if (import.meta.main) main().catch(e => { console.error(e); process.exit(1); });

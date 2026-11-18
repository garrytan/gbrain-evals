/**
 * Entity-dedupe head-to-head, memory systems: one attempt of a paid cell. Ingests the world through a running shim,
 * one page per session, in the world's fixed order (world.ts ingestOrder), reads the system's entity nodes
 * (GET /entities, eval/systems/PROTOCOL.md "Entity readout") and writes the neutral output.
 *
 * Spend rules (preregistration, "Spend and safety"):
 *   ledger stop   the attempt's lease (the proxy's --lease-usd) holds at most the cell's stop less what earlier
 *                 attempts spent; when the proxy refuses a request for budget the attempt pauses (ledger_stop).
 *   checkpoint    after CHECKPOINT_PAGES (345) pages the attempt re-measures its cost per page from its ledger and
 *                 pauses before the rest when that rate projects the cell past its stop.
 *   crash         a page that fails ends the attempt (IMPORT_INCOMPLETE); a lost shim, finish or readout ends it as
 *                 crashed. Neither resumes in place: run.ts restart starts a new attempt from page one on a fresh
 *                 namespace (a fresh stack), after the reconcile.
 * The proxy binds each page's provider calls to the page's source id, and "finish" and "entities" to those steps.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '../../generators/person-dedupe-gen.ts';
import type { ProxyControl } from '../metering-proxy.ts';
import { RunnerRefusal } from '../runner-refusal.ts';
import { HttpMemorySystem } from '../systems/http.ts';
import { loadPath, runSpend, writeCell, type Attempt, type CellState } from './ledger.ts';
import { CHECKPOINT_PAGES, MEMORY_MODEL } from './rates.ts';
import type { NeutralOutput } from './score.ts';
import { opaque, readoutFromEntities, readUsage, usageByKey, type EntitiesResponse, type H2hWorld, type WorldPage } from './world.ts';

export const HAND_CHECK_SAMPLE = 50;

export interface MemoryAttemptOptions {
  dir: string; state: CellState; attempt: Attempt; world: H2hWorld; order: readonly WorldPage[];
  shim: string; proxy: ProxyControl; label: string;
  /** Spend of the cell's earlier attempts, which counts toward its stop. */
  priorUsd: number;
  /** Call /finish inside each page's binding, for a shim whose /ingest only queues the work. */
  drainEach?: boolean;
  log?: (line: string) => void;
}

export type AttemptEnd = 'complete' | 'paused' | 'import_incomplete' | 'crashed';

export async function runMemoryAttempt(o: MemoryAttemptOptions): Promise<AttemptEnd> {
  const { dir, state, attempt, world, order, proxy } = o;
  const log = o.log ?? ((s: string) => console.log(s));
  const system = state.system;
  const save = () => writeCell(dir, state);
  const end = (status: Attempt['status'], reason: string | null): AttemptEnd => {
    attempt.status = status; attempt.reason = reason; attempt.finished_at = new Date().toISOString(); save();
    return status === 'running' ? 'crashed' : status as AttemptEnd;
  };
  const client = new HttpMemorySystem(o.shim, { name: system });
  const ns = attempt.ns!;
  const sourceOf = new Map(order.map(p => [p.key, opaque('src', o.label, String(attempt.n), p.key)]));
  let capabilities: Record<string, unknown>, health: Record<string, unknown>;
  try {
    capabilities = await client.capabilities() as unknown as Record<string, unknown>;
    health = await client.health();
    await client.reset(ns);
  } catch (e) { return end('crashed', `the shim did not start the namespace: ${(e as Error).message}`); }

  const timings: Record<string, number> = {};
  for (const [i, p] of order.entries()) {
    const t0 = performance.now();
    const event = new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString();
    const r = await proxy.around(system, sourceOf.get(p.key)!, async () => {
      const res = await client.ingestSession(ns, { source_id: sourceOf.get(p.key)!, turns: [{ role: 'user', speaker: 'notes', content: p.text }] }, event);
      return o.drainEach ? { ...res, drained: await client.finishIngest(ns, 3600) } : res;
    });
    timings[p.key] = (performance.now() - t0) / 1000;
    const budget = (r.meter.refused?.budget ?? 0) > 0 || (r.error as { kind?: string } | undefined)?.kind === 'budget';
    if (budget) return end('paused', `ledger stop: the proxy refused a request of page ${i + 1} (${p.key}) for budget${r.error ? '' : ', which the system swallowed'}; the cell's stop is $${state.stop_usd.toFixed(2)}`);
    const reported = (r.value as { errors?: unknown[] } | undefined)?.errors ?? [];
    if (r.error || reported.length) {
      end('import_incomplete', `page ${i + 1} (${p.key}) failed: ${String(r.error ? (r.error as Error).message ?? r.error : reported.join('; ')).slice(0, 300)}`);
      throw new RunnerRefusal('IMPORT_INCOMPLETE', `entity-h2h: ${system} did not ingest page ${i + 1} of ${order.length} (${p.key})`, { pages_expected: order.length, pages_imported: i },
        `reconcile, then start a fresh attempt from page one on a fresh namespace: bun eval/runner/entity-h2h/run.ts restart --output ${dir} ...`);
    }
    attempt.done = i + 1;
    log(`[${i + 1}/${order.length}] ${p.key} ${timings[p.key].toFixed(1)}s $${r.meter.usd.toFixed(4)}`);
    if (i + 1 === CHECKPOINT_PAGES && order.length > CHECKPOINT_PAGES) {
      const usd = runSpend(dir, attempt.paid);
      const rate = usd / CHECKPOINT_PAGES;
      const projected = o.priorUsd + rate * order.length;
      attempt.checkpoint = { pages: CHECKPOINT_PAGES, usd, usd_per_page: rate, projected_usd: projected, stop_usd: state.stop_usd };
      log(`checkpoint at ${CHECKPOINT_PAGES} pages: $${usd.toFixed(4)} spent, $${rate.toFixed(5)} a page, projected $${projected.toFixed(2)} for ${order.length} pages against a stop of $${state.stop_usd.toFixed(2)}`);
      if (projected > state.stop_usd) return end('paused', `checkpoint: $${rate.toFixed(5)} a page projects $${projected.toFixed(2)}, past the stop of $${state.stop_usd.toFixed(2)}`);
    }
    save();
  }

  const fin = await proxy.around(system, 'finish', () => client.finishIngest(ns, 3600));
  if (fin.error) return end('crashed', `finish failed: ${String((fin.error as Error).message ?? fin.error).slice(0, 300)}`);
  const finErrors = (fin.value!.raw as { errors?: unknown[] } | undefined)?.errors ?? [];
  if (!fin.value!.ready || fin.value!.completeness === 'degraded' || finErrors.length) return end('crashed', `finish reported ready ${fin.value!.ready}, completeness ${fin.value!.completeness}, ${finErrors.length} errors: ${String(finErrors.join('; ')).slice(0, 300)}`);
  const ent = await proxy.around(system, 'entities', async () => {
    const res = await fetch(`${o.shim.replace(/\/$/, '')}/entities?ns=${ns}`);
    const json = await res.json() as EntitiesResponse & { error?: { message: string } };
    if (!res.ok || json.error) throw new Error(`GET /entities: HTTP ${res.status} ${json.error?.message ?? ''}`);
    return json;
  });
  if (ent.error) return end('crashed', `entity readout failed: ${String((ent.error as Error).message ?? ent.error).slice(0, 300)}`);
  const lateRefusals = (fin.meter.refused?.budget ?? 0) + (ent.meter.refused?.budget ?? 0)
    + readUsage(loadPath(dir, attempt.paid.usage_log)).filter(u => u.at >= attempt.started_at && u.outcome === 'refused' && u.status === 402).length;
  if (lateRefusals > 0) return end('paused', `ledger stop: the proxy refused ${lateRefusals} request(s) for budget during finish, the readout or queued work, which the system swallowed; the cell's stop is $${state.stop_usd.toFixed(2)}`);
  const entities = ent.value!;
  const known = new Set(sourceOf.values());
  for (const e of entities.entities) e.source_ids = e.source_ids.filter(s => known.has(s));
  const { tiers, subjects } = readoutFromEntities(order, sourceOf, entities);

  const versions = (capabilities.versions ?? {}) as Record<string, unknown>;
  const configs = (capabilities.configs ?? {}) as Record<string, { model_roles?: Record<string, unknown> }>;
  const roles = Object.values(configs)[0]?.model_roles ?? {};
  const model = typeof roles.extraction === 'string' ? (String(roles.extraction).includes(':') ? String(roles.extraction) : `openai:${roles.extraction}`) : MEMORY_MODEL;
  const output: NeutralOutput = { system, version: String(versions.package ?? 'unknown'), config: state.config, model, tiers };
  const rand = mulberry32((world.seed ^ 0x50) >>> 0);
  const pool = [...subjects];
  const sample = [];
  const want = Math.min(HAND_CHECK_SAMPLE, pool.length);
  while (sample.length < want) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  const usage = usageByKey(readUsage(loadPath(dir, attempt.paid.usage_log)), k => known.has(k) || k === 'finish' || k === 'entities', attempt.started_at);
  writeFileSync(join(dir, 'output.json'), JSON.stringify(output, null, 2) + '\n');
  writeFileSync(join(dir, 'subjects.json'), JSON.stringify(subjects, null, 2) + '\n');
  writeFileSync(join(dir, 'entities.json'), JSON.stringify(entities, null, 2) + '\n');
  writeFileSync(join(dir, 'hand-check-sample.json'), JSON.stringify({ note: `${sample.length} page-to-entity mappings drawn at random (seeded from the world seed) for a check by hand against each page`, sample }, null, 2) + '\n');
  writeFileSync(join(dir, `run-attempt-${attempt.n}.json`), JSON.stringify({
    system, attempt: attempt.n, ns, capabilities, health, timings_s: timings, finish: fin.value, usage: Object.fromEntries(usage),
    unresolved: subjects.filter(s => !s.node).map(s => s.key), entity_nodes: entities.entities.length,
  }, null, 2) + '\n');
  log(`${system}: ${entities.entities.length} entity nodes; ${subjects.filter(s => s.node).length}/${subjects.length} subjects resolved; auto groups ${tiers.auto.length}, proposed ${tiers.proposed.length}`);
  state.status = 'complete';
  return end('complete', null);
}

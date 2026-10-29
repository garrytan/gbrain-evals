/**
 * Q1 dev stress pilot for gbrain-defaults (Q1-SCOREBOARD plan, execution contract 5).
 *
 * Writes all 11 BEAM-1M dev conversations (the P0 split, eval/decisions/splits/beam-1m.json; about 11M tokens and
 * 6,900 sessions, so about one BEAM-10M conversation's page count) into ONE gbrain-defaults namespace through the
 * shim, then measures what the preregistered S1 engine rule needs: ingest wall time (and per 1,000 messages), serve
 * memory (current and peak RSS) and brain size on disk as the brain grows, the quiesce barrier's wait, serve restart
 * time on the full brain, and retrieval-only `query` latency (shim service_ms and gbrain's own time, p50/p95) on the
 * dev questions with every rerank and evidence-delivery fallback counted. No reader runs. The receipt's `finish`
 * carries every doctor round of the quiesce barrier (`rounds`).
 *
 * Engine rule: PGLite is the S1 headline engine if query p95 is under 10 seconds with no rerank or timeout-type
 * delivery fallbacks and peak RSS fits the VM; otherwise S1 runs gbrain-defaults on Postgres, per gbrain's own
 * pglite_scale advice, and says so. The receipt states which. Shipped-behavior delivery fallbacks
 * (SHIPPED_DELIVERY_FALLBACKS: `redaction_unmapped`, `no_text_chunks`) are content-driven and reported as counts.
 *
 * It spends money (embeddings, gbrain's write-time and query-time model calls, all through the metering proxy), so it
 * refuses without `--paid --budget-run-id <id>` naming an open ledger run with money left (eval/runner/paid-arm.ts).
 * `--plan` is $0: it loads the dev corpus and prints the counts and the estimate, contacting no system.
 *
 * Locally, against the compose stack (the proxy holds the real keys; its lease is the ledger run):
 *   bash eval/systems/bootstrap.sh proxy --lease-id q1-stress --lease-usd 50 --out /tmp/q1-stress-proxy
 *   bash eval/systems/bootstrap.sh up --system gbrain-defaults --timeout 900
 *   bun eval/runner/q1/stress-pilot.ts --system http://127.0.0.1:8700 --provider-proxy http://127.0.0.1:8787 \
 *     --paid --budget-run-id q1-stress --budget-ledger /tmp/q1-stress-proxy/lease.sqlite --output /tmp/q1-stress
 *
 * Under shootout-cell (the VM's proxy spends the cell's lease; SHOOTOUT_PROXY, SHOOTOUT_LEASE_ID and SHOOTOUT_OUT
 * are set for the cell command):
 *   bash eval/systems/bootstrap.sh up --system gbrain-defaults && bun eval/runner/q1/stress-pilot.ts \
 *     --system http://127.0.0.1:8700 --paid --budget-run-id "$SHOOTOUT_LEASE_ID" \
 *     --budget-ledger "$SHOOTOUT_OUT/lease.sqlite" --output "$SHOOTOUT_OUT/stress"; \
 *   bash eval/systems/bootstrap.sh down --system gbrain-defaults
 *
 * Flags: --questions-per-conversation N (default every dev question), --finish-timeout-s (default 14400),
 * --vm-memory-gib (default 16, the RSS limit in the engine rule), --stats-every N sessions (default 250), --fresh
 * (reset the namespace even when a previous ingest log exists; by default a rerun resumes, and gbrain's request-id
 * replay makes rewriting a committed session free), --json (operator messages and the summary as JSON).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { requirePaidArm, PaidArmRefusal } from '../paid-arm.ts';
import { budgetOptionsFrom } from '../budget-ledger.ts';
import { devConversations, loadSplit } from '../decisions/splits.ts';
import { decideError, DecideError, exitCodeFor, renderOperatorMessage, type OperatorMessage } from '../decisions/errors.ts';
import { loadBeam, type Corpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { ProxyControl, type Meter } from '../metering-proxy.ts';
import { HttpMemorySystem } from '../systems/http.ts';
import { opaqueSourceId, Sanitizer, type IngestStep } from '../systems/sanitize.ts';
import { SystemError, type RetrievalPolicy } from '../systems/types.ts';

export const PILOT_ESTIMATE_USD = 50;
export const PILOT_RUNNER = 'q1-stress-pilot';
export const SALT = 'q1-stress-pilot-v1';
const SLOT = 'gbrain-defaults';
const P95_LIMIT_MS = 10_000;
const PILOT = ['bun', 'eval/runner/q1/stress-pilot.ts'];

export interface PilotArgs {
  system: string | null;
  output: string | null;
  plan: boolean;
  json: boolean;
  fresh: boolean;
  questionsPerConversation: number | null;
  finishTimeoutS: number;
  vmMemoryGib: number;
  statsEvery: number;
  providerProxy: string | null;
  argv: string[];
}

export function parsePilotArgs(argv: string[], env: Record<string, string | undefined> = process.env): PilotArgs {
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const num = (name: string, fallback: number | null) => {
    const raw = one(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw usage(`${name} must be a positive number (got ${JSON.stringify(raw)})`);
    return n;
  };
  return {
    system: one('--system'), output: one('--output'), plan: argv.includes('--plan'), json: argv.includes('--json'), fresh: argv.includes('--fresh'),
    questionsPerConversation: num('--questions-per-conversation', null), finishTimeoutS: num('--finish-timeout-s', 14_400)!,
    vmMemoryGib: num('--vm-memory-gib', 16)!, statsEvery: num('--stats-every', 250)!,
    providerProxy: (one('--provider-proxy') ?? env.SHOOTOUT_PROXY ?? '').replace(/\/$/, '') || null, argv,
  };
}

function usage(message: string): DecideError {
  return decideError({ code: 'SPEC_INVALID', message, why: 'the pilot writes one namespace through the gbrain-defaults shim and needs its URL and an output directory',
    fix: { next: 'run', argv: [...PILOT, '--plan'], verify: [...PILOT, '--plan', '--json'] } });
}

/** The paid guard as an operator message: --paid and an open ledger run with the estimate left, or a refusal that names the next command. */
export function guardPaid(argv: readonly string[]): { budgetRunId: string; remainingUsd: number } {
  try {
    return requirePaidArm(argv, { arm: 'the Q1 gbrain-defaults stress pilot', estimateUsd: PILOT_ESTIMATE_USD, ledgerPath: budgetOptionsFrom(argv).ledgerPath });
  } catch (e) {
    if (!(e instanceof PaidArmRefusal)) throw e;
    const ledger = budgetOptionsFrom(argv).ledgerPath;
    throw decideError({ code: 'PAID_FLAGS_MISSING', message: e.message,
      why: 'the pilot embeds about 11M tokens and runs gbrain\'s write-time and query-time model calls; every paid run is reserved in the budget ledger first, and a plan approval covers this spend, not an inherited run id',
      fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/budget-ledger.ts', 'open', '--runner', PILOT_RUNNER, '--budget-usd', String(PILOT_ESTIMATE_USD), '--budget-ledger', ledger],
        user_message: `The stress pilot spends up to $${PILOT_ESTIMATE_USD} (plan section 7, "dev stress pilot"). Open its ledger run if the spend is approved, then rerun the pilot with --paid --budget-run-id <the printed id>.`,
        verify: ['bun', 'eval/runner/budget-ledger.ts', 'status', '--budget-ledger', ledger] } });
  }
}

/** Dev conversations only: a sealed BEAM-1M conversation never enters the pilot. */
export function assertDevOnly(ids: readonly string[]): void {
  const split = loadSplit('beam-1m');
  const sealed = new Set(split.sealed);
  const leaked = ids.filter(id => sealed.has(id) || !split.dev.includes(id));
  if (leaked.length) {
    throw decideError({ code: 'SEALED_SOURCE_IN_DEV', message: `${leaked.length} conversation(s) outside the BEAM-1M dev split reached the stress pilot`,
      why: 'the pilot is dev-only (E3); sealed BEAM-1M conversations open only through the custodian at a preregistered decision', fix: { next: 'report', user_message: 'stop and report: the split guard caught a non-dev conversation' } });
  }
}

export function loadPilotCorpus(): Corpus {
  const dev = devConversations('beam-1m');
  if (!dev || dev.size !== 11) throw decideError({ code: 'SPEC_INVALID', message: `the BEAM-1M dev split lists ${dev?.size ?? 0} conversations, not 11`, why: 'the pilot is defined on the P0 split\'s 11 dev conversations', fix: { next: 'report' } });
  assertDevOnly([...dev]);
  const corpus = loadBeam('1m', dev);
  assertDevOnly(corpus.conversations.map(c => c.id));
  return corpus;
}

/** Every dev session of every conversation in one namespace, in event-time order across conversations (ties keep conversation order). */
export function pilotPlan(corpus: Corpus, sanitizer: Sanitizer): IngestStep[] {
  const all = corpus.conversations.flatMap((c, ci) => sanitizer.ingestPlan(c).map((s, i) => ({ s, ci, i })));
  all.sort((a, b) => (a.s.event_time ?? '') === (b.s.event_time ?? '') ? a.ci - b.ci || a.i - b.i : (a.s.event_time ?? '') < (b.s.event_time ?? '') ? -1 : 1);
  return all.map(x => x.s);
}

export function pilotQuestions(corpus: Corpus, perConversation: number | null): MemoryQuestion[] {
  return corpus.conversations.flatMap(c => {
    const qs = corpus.questions.filter(q => q.conversation === c.id);
    return perConversation === null ? qs : qs.slice(0, perConversation);
  });
}

export function corpusCounts(corpus: Corpus, plan: IngestStep[]) {
  const messages = plan.reduce((n, s) => n + s.input.turns.length, 0);
  const chars = plan.reduce((n, s) => n + s.input.turns.reduce((m, t) => m + t.content.length, 0), 0);
  return { conversations: corpus.conversations.length, sessions: plan.length, messages, chars, tokens_chars_over_4: Math.round(chars / 4),
    synthetic_times: plan.filter(s => s.synthetic_time).length, undated: plan.filter(s => !s.event_time).length };
}

export const percentile = (xs: readonly number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

export interface QueryRecord {
  id: string; ok: boolean; error_kind?: string; error?: string; wall_ms: number; service_ms: number | null; gbrain_ms: number | null;
  items: number; recall_any_10: number | null; recall_all_10: number | null; tokens_delivered: number | null;
  outcome: string | null; reasons: string[]; recorded: string[]; delivery_fallbacks: string[]; dropped_reasons: Record<string, number>; usd?: number;
}

/**
 * Delivery fallbacks that are gbrain's shipped, content-driven behavior (preregistered; the gbrain-defaults shim's
 * SHIPPED_BEHAVIOR): the secret redactor changed a block's text (`redaction_unmapped`) or a page has no text chunks
 * (`no_text_chunks`). The engine rule reports them as counts and never holds them against PGLite.
 */
export const SHIPPED_DELIVERY_FALLBACKS: readonly string[] = ['no_text_chunks', 'redaction_unmapped'];

/** A query's delivery fallbacks split into shipped behavior and the timeout-type rest (the reasons the shim classified count too). */
export function deliveryFallbacks(q: Pick<QueryRecord, 'delivery_fallbacks' | 'reasons'>): { shipped: string[]; timeout: string[] } {
  const all = [...new Set([...q.delivery_fallbacks, ...q.reasons.filter(r => r.startsWith('delivery_fallback:')).map(r => r.slice('delivery_fallback:'.length))])].sort();
  const timeout = [...all.filter(f => !SHIPPED_DELIVERY_FALLBACKS.includes(f)), ...q.reasons.filter(r => r.startsWith('delivery_') && !r.startsWith('delivery_fallback:'))];
  return { shipped: all.filter(f => SHIPPED_DELIVERY_FALLBACKS.includes(f)), timeout };
}

/** The preregistered S1 engine rule from the pilot's measurements: only timeout-type fallbacks count against PGLite. */
export function engineRule(queries: readonly QueryRecord[], peakRssKb: number | null, vmMemoryGib: number) {
  const ms = queries.filter(q => q.ok && q.service_ms !== null).map(q => q.service_ms!);
  const p95 = percentile(ms, 95);
  const rerankFallbacks = queries.filter(q => q.reasons.some(r => /rerank/.test(r))).length;
  const split = queries.map(deliveryFallbacks);
  const timeoutFallbacks = split.filter(f => f.timeout.length > 0).length;
  const shipped: Record<string, number> = Object.fromEntries(SHIPPED_DELIVERY_FALLBACKS.map(f => [f, 0]));
  for (const f of split) for (const x of f.shipped) shipped[x]++;
  const failed = queries.filter(q => !q.ok).length;
  const rssLimitKb = vmMemoryGib * 1024 * 1024;
  const checks = {
    query_p95_under_10s: p95 !== null && p95 < P95_LIMIT_MS,
    no_rerank_fallbacks: rerankFallbacks === 0,
    no_delivery_fallbacks: timeoutFallbacks === 0,
    no_failed_queries: failed === 0,
    rss_fits_vm: peakRssKb !== null && peakRssKb < rssLimitKb,
  };
  const pglite = Object.values(checks).every(Boolean);
  return {
    checks, query_p95_ms: p95, rerank_fallback_queries: rerankFallbacks, delivery_fallback_queries: timeoutFallbacks,
    shipped_fallback_queries: split.filter(f => f.shipped.length > 0).length, shipped_fallbacks: shipped, shipped_behavior: [...SHIPPED_DELIVERY_FALLBACKS],
    failed_queries: failed, peak_rss_kb: peakRssKb, rss_limit_kb: rssLimitKb, engine: pglite ? 'pglite' : 'postgres',
    verdict: pglite ? 'PGLite is the S1 headline engine for gbrain-defaults.'
      : 'S1 runs "gbrain-defaults (Postgres, per gbrain\'s own pglite_scale advice)" and the row says so.',
  };
}

export interface PilotDeps {
  corpus: () => Corpus;
  log: (line: string) => void;
}

const readLines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];

async function getJson(base: string, path: string, body?: unknown): Promise<Record<string, any> | null> {
  try {
    const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: false, signal: AbortSignal.timeout(900_000) });
    return r.ok ? await r.json() as Record<string, any> : null;
  } catch { return null; }
}

/** The pilot proper (after the paid guard): ingest, quiesce, footprint, restart, retrieval-only queries, receipt. */
export async function runStressPilot(a: PilotArgs & { system: string; output: string }, deps: PilotDeps): Promise<Record<string, unknown>> {
  const out = resolve(a.output);
  mkdirSync(out, { recursive: true });
  const corpus = deps.corpus();
  const sanitizer = new Sanitizer(corpus, SALT);
  const ns = sanitizer.ns('q1-stress-pilot:beam-1m-dev');
  const plan = pilotPlan(corpus, sanitizer);
  const questions = pilotQuestions(corpus, a.questionsPerConversation);
  const counts = corpusCounts(corpus, plan);
  const system = new HttpMemorySystem(a.system, { name: 'gbrain-defaults', markers: sanitizer.markers, timeoutMs: 900_000, ingestTimeoutMs: 3_600_000 });
  const cap = await system.capabilities();
  if (cap.system !== 'gbrain-defaults') throw usage(`--system ${a.system} serves ${cap.system}, not gbrain-defaults`);
  const health = await system.health();
  const ctl = a.providerProxy ? new ProxyControl(a.providerProxy) : null;
  const metered = async <T>(key: string, fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; meter: Meter | null }> => {
    if (ctl) return ctl.around(SLOT, key, fn);
    try { return { value: await fn(), meter: null }; } catch (error) { return { error, meter: null }; }
  };
  const costOf = (m: Meter | null) => m ? { usd: m.usd, requests: m.requests, unpriced: m.unpriced, by_model: m.byModel } : null;

  const ingestLog = join(out, 'ingest.ndjson'), statsLog = join(out, 'footprint.ndjson'), queryLog = join(out, 'queries.ndjson');
  const prior = a.fresh ? [] : readLines(ingestLog);
  const done = new Set(prior.filter(r => r.ok).map(r => r.source_id as string));
  if (!prior.length) {
    await system.reset(ns);
    writeFileSync(ingestLog, '');
    writeFileSync(statsLog, '');
  }
  deps.log(`[stress] ${counts.conversations} conversations, ${counts.sessions} sessions, ${counts.messages} messages into ${ns}; ${done.size} already committed`);

  let peakRss: number | null = null;
  const sample = async (phase: string, sessions: number) => {
    const s = await getJson(a.system, '/stats');
    if (!s) return;
    peakRss = Math.max(peakRss ?? 0, Number(s.serve_peak_rss_kb ?? s.serve_rss_kb ?? 0)) || peakRss;
    appendFileSync(statsLog, JSON.stringify({ at: new Date().toISOString(), phase, sessions, serve_rss_kb: s.serve_rss_kb ?? null, serve_peak_rss_kb: s.serve_peak_rss_kb ?? null, brain_bytes: s.brain_bytes ?? null }) + '\n');
  };

  const ingestStart = performance.now();
  let written = 0, failed = 0;
  const ingestServiceMs: number[] = [];
  const ingest = await metered('q1-stress:ingest', async () => {
    for (const step of plan) {
      if (done.has(step.input.source_id)) continue;
      const t0 = performance.now();
      try {
        const r = await system.ingestSession(ns, step.input, step.event_time);
        ingestServiceMs.push(r.service_ms ?? 0);
        appendFileSync(ingestLog, JSON.stringify({ source_id: step.input.source_id, ok: true, completeness: r.completeness, wall_ms: Math.round(performance.now() - t0), service_ms: r.service_ms ?? null, messages: step.input.turns.length }) + '\n');
        written++;
      } catch (e) {
        if (e instanceof SystemError && e.kind === 'budget') throw e;
        failed++;
        appendFileSync(ingestLog, JSON.stringify({ source_id: step.input.source_id, ok: false, error_kind: e instanceof SystemError ? e.kind : 'harness', error: String((e as Error).message).slice(0, 300) }) + '\n');
      }
      if ((written + failed) % a.statsEvery === 0) { await sample('ingest', done.size + written); deps.log(`[stress] ${done.size + written}/${plan.length} sessions written`); }
    }
  });
  const ingestWallMs = Math.round(performance.now() - ingestStart);
  await sample('ingest_end', done.size + written);
  if (ingest.error) throw ingest.error;

  const fin = await metered('q1-stress:finish', () => system.finishIngest(ns, a.finishTimeoutS));
  if (fin.error) throw fin.error;
  await sample('quiesced', done.size + written);
  const restart = await getJson(a.system, '/restart', { ns });
  await sample('restarted', done.size + written);

  const policy: RetrievalPolicy = { name: 'gbrain-defaults:vendor-default', mode: 'vendor-default', settings: { ...(cap.retrieval_policies?.['vendor-default']?.settings ?? {}), on_degraded: 'report' } };
  writeFileSync(queryLog, '');
  const records: QueryRecord[] = [];
  const queries = await metered('q1-stress:queries', async () => {
    for (const q of questions) {
      const gold = new Set(q.gold.map(s => opaqueSourceId(q.conversation, s)));
      const t0 = performance.now();
      const one = await metered(`q1-stress:q:${records.length}`, () => system.retrieve(ns, sanitizer.question(q), policy));
      const wall = Math.round(performance.now() - t0);
      let rec: QueryRecord;
      if (one.error || !one.value) {
        const e = one.error as Error;
        rec = { id: q.id, ok: false, error_kind: e instanceof SystemError ? e.kind : 'harness', error: String(e?.message).slice(0, 300), wall_ms: wall, service_ms: null, gbrain_ms: null, items: 0,
          recall_any_10: null, recall_all_10: null, tokens_delivered: null, outcome: null, reasons: [], recorded: [], delivery_fallbacks: [], dropped_reasons: {} };
      } else {
        const r = one.value;
        const raw = (r.raw ?? {}) as Record<string, any>;
        const top10 = new Set(r.items.slice(0, 10).flatMap(i => i.source_ids));
        const hit = [...gold].filter(s => top10.has(s)).length;
        const delivery = raw.meta?.delivery ?? {};
        rec = { id: q.id, ok: true, wall_ms: wall, service_ms: r.service_ms ?? null, gbrain_ms: raw.gbrain_ms ?? null, items: r.items.length,
          recall_any_10: gold.size ? (hit > 0 ? 1 : 0) : null, recall_all_10: gold.size ? (hit === gold.size ? 1 : 0) : null, tokens_delivered: delivery.tokens_delivered ?? null,
          outcome: raw.classification?.outcome ?? null, reasons: raw.classification?.reasons ?? [], recorded: raw.classification?.recorded ?? [],
          delivery_fallbacks: delivery.fallbacks ?? [], dropped_reasons: delivery.dropped_reasons ?? {} };
      }
      if (one.meter) rec.usd = one.meter.usd;
      records.push(rec);
      appendFileSync(queryLog, JSON.stringify(rec) + '\n');
    }
  });
  if (queries.error) throw queries.error;
  await sample('queried', done.size + written);

  const ok = records.filter(r => r.ok);
  const msOf = (k: 'service_ms' | 'gbrain_ms' | 'wall_ms') => ok.map(r => r[k]).filter((x): x is number => typeof x === 'number');
  const reasonCounts: Record<string, number> = {};
  for (const r of records) for (const reason of [...r.reasons, ...r.recorded]) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  const mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const footprint = readLines(statsLog);
  const lastFoot = footprint[footprint.length - 1] ?? {};
  const allWrites = readLines(ingestLog);
  const receipt = {
    kind: 'q1-stress-pilot', schema_version: 1, created_at: new Date().toISOString(),
    system: { url: a.system, system: cap.system, resolved: (cap as Record<string, unknown>).resolved ?? null, shipped_behavior: (cap as Record<string, unknown>).shipped_behavior ?? null, health },
    corpus: { benchmark: corpus.benchmark, split: 'dev', exposure: 'E3', conversation_ids: corpus.conversations.map(c => c.id), source: corpus.source, ...counts },
    namespace: ns,
    ingest: {
      wall_ms: ingestWallMs, sessions_written_this_run: written, sessions_resumed: done.size, failed_this_run: failed,
      committed_total: allWrites.filter(r => r.ok).length, failed_total: allWrites.filter(r => !r.ok).length,
      ms_per_1000_messages: counts.messages && written ? Math.round((ingestWallMs / plan.filter(s => !done.has(s.input.source_id)).reduce((n, s) => n + s.input.turns.length, 0)) * 1000) : null,
      service_ms_p50: percentile(ingestServiceMs, 50), service_ms_p95: percentile(ingestServiceMs, 95), cost: costOf(ingest.meter),
    },
    finish: (({ raw, ...f }) => ({ ...f, ...(raw ?? {}), cost: costOf(fin.meter) }))(fin.value!),
    restart: restart ? { restart_ms: restart.restart_ms ?? null, serve_session: restart.serve_session ?? null } : null,
    footprint: { peak_serve_rss_kb: peakRss, final_serve_rss_kb: lastFoot.serve_rss_kb ?? null, brain_bytes: lastFoot.brain_bytes ?? null, samples: footprint.length },
    queries: {
      n: records.length, ok: ok.length, failed: records.length - ok.length, policy: policy.settings,
      service_ms_p50: percentile(msOf('service_ms'), 50), service_ms_p95: percentile(msOf('service_ms'), 95),
      gbrain_ms_p50: percentile(msOf('gbrain_ms'), 50), gbrain_ms_p95: percentile(msOf('gbrain_ms'), 95),
      wall_ms_p95: percentile(msOf('wall_ms'), 95), harness_invalid: records.filter(r => r.outcome === 'harness_invalid').length,
      reasons: reasonCounts, recall_any_10: mean(records.map(r => r.recall_any_10)), recall_all_10: mean(records.map(r => r.recall_all_10)),
      tokens_delivered_mean: mean(records.map(r => r.tokens_delivered)), cost: costOf(queries.meter),
    },
    engine_rule: engineRule(records, peakRss, a.vmMemoryGib),
    artifacts: { ingest: 'ingest.ndjson', footprint: 'footprint.ndjson', queries: 'queries.ndjson' },
  };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  deps.log(`[stress] receipt ${join(out, 'receipt.json')}: ${receipt.engine_rule.verdict}`);
  return receipt;
}

async function main(argv: string[]): Promise<number> {
  const a = parsePilotArgs(argv);
  if (a.plan) {
    const corpus = loadPilotCorpus();
    const plan = pilotPlan(corpus, new Sanitizer(corpus, SALT));
    const summary = { kind: 'q1-stress-pilot-plan', estimate_usd: PILOT_ESTIMATE_USD, ...corpusCounts(corpus, plan), questions: pilotQuestions(corpus, a.questionsPerConversation).length };
    console.log(a.json ? JSON.stringify(summary) : Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join('\n'));
    return 0;
  }
  guardPaid(argv);
  if (!a.system || !a.output) throw usage(`${!a.system ? '--system <gbrain-defaults shim URL>' : '--output <dir>'} is required`);
  const receipt = await runStressPilot({ ...a, system: a.system, output: a.output }, { corpus: loadPilotCorpus, log: line => process.stderr.write(line + '\n') });
  if (a.json) console.log(JSON.stringify(receipt));
  return (receipt.ingest as { failed_total: number }).failed_total > 0 || (receipt.queries as { failed: number }).failed > 0 ? 4 : 0;
}

if (import.meta.main) {
  const json = process.argv.includes('--json');
  main(process.argv.slice(2)).then(code => process.exit(code), (e: unknown) => {
    if (e instanceof DecideError) {
      const op: OperatorMessage = e.op;
      process.stderr.write((json ? JSON.stringify(op) : renderOperatorMessage(op)) + '\n');
      process.exit(exitCodeFor(op));
    }
    process.stderr.write(`[stress] ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}

/**
 * lifecycle-lite runner core: drives any `MemorySystem` (a protocol v1 shim
 * over HTTP, in-process gbrain-shootout, or a test fake) through the seeded
 * histories and writes canonical rows and a receipt. The CLI is
 * eval/runner/lifecycle-lite.ts.
 *
 * Per seed, in one namespace, strictly in this order:
 *   1. reset, then ingest every session in event-time order through the
 *      sanitizer (opaque ids, dated turns), then wait for quiescence;
 *   2. witness: every probe once;
 *   3. for each delete target: its probe again (the presence check right
 *      before the delete), then /delete_source on its session;
 *   4. a second quiescence wait, then every probe (`after_delete`);
 *   5. with a restart hook: restart the system with its state kept, then
 *      every probe again (`after_restart`);
 *   6. with a reader: the final checkpoint's probes are answered by a fixed
 *      reader from the packed native evidence and checked by a fixed judge.
 *
 * Accounting follows memory-qa (eval/runner/memory-qa/outcomes.ts): a frozen
 * manifest of expected row ids, append-only attempts, one canonical row per
 * id, the same outcome names. Deletes change state, so a resume reruns a
 * whole seed (reset first) whenever any of its rows is still pending.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIFECYCLE_LITE_GENERATOR_VERSION, sanitizerCorpus, type LifecycleLiteWorld, type LiteProbe } from '../../generators/lifecycle-lite-gen.ts';
import { appendAttempt, canonicalize, DEFAULT_MAX_ATTEMPTS, freezeManifest, readAttempts, writeCanonical, type Outcome, type Row } from '../memory-qa/outcomes.ts';
import { judgeYes } from '../memory-qa/qa.ts';
import { packContext, RENDERER_VERSION, validateSources } from '../systems/render.ts';
import { Sanitizer, SanitizerLeakError } from '../systems/sanitize.ts';
import { policyKnobs, SystemError, type CapabilityRecord, type Item, type MemorySystem, type RetrievalPolicy } from '../systems/types.ts';
import { liteChecks, liteMetrics, scoreProbe, type Checkpoint, type DeleteRecord, type DeleteStatus, type LiteRow } from './score.ts';

export const LIFECYCLE_LITE_RUNNER_VERSION = 'lifecycle-lite-run@1';
/** Defaults of the optional reading lane (off unless asked for); open in the draft preregistration. */
export const DEFAULT_QA = { reader: 'openai:gpt-4o-mini', judge: 'openai:gpt-4o-2024-08-06', budgetTokens: 8000 } as const;

export type Chat = (model: string, prompt: string, maxTokens: number) => Promise<{ text: string; input_tokens?: number; output_tokens?: number; cached?: boolean }>;

export interface LiteRunOptions {
  system: MemorySystem;
  worlds: readonly LifecycleLiteWorld[];
  output: string;
  policyMode?: RetrievalPolicy['mode'];
  policySettings?: Record<string, string>;
  /** Restarts the system with its state kept; null skips the restart checkpoint. */
  restart?: { run: () => Promise<void>; how: string } | null;
  finishTimeoutS?: number;
  /** Identity fields that enter the run configuration hash (system identity, gbrain build, embedder). */
  identity?: Record<string, unknown>;
  qa?: { reader: string; judge: string; budgetTokens: number; chat: Chat } | null;
  maxAttempts?: number;
  log?: (line: string) => void;
}

/** Thrown after a seed's remaining rows were recorded as failures; stops that seed only. */
class SeedAborted extends Error {}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/** A system failure as an outcome: memory-qa's mapping (budget and invalid requests are harness failures). */
export function failureOutcome(e: unknown): { outcome: Outcome; error: string; error_kind: string } {
  if (e instanceof SanitizerLeakError) return { outcome: 'harness_invalid', error: e.message, error_kind: 'sanitizer' };
  const kind = e instanceof SystemError ? e.kind : /budget|BudgetExceeded/i.test(errorText(e)) ? 'budget' : 'product_error';
  const outcome: Outcome = kind === 'budget' ? 'budget_not_run' : kind === 'invalid_request' ? 'harness_invalid' : kind === 'unsupported' ? 'unsupported' : 'retrieval_error';
  return { outcome, error: errorText(e), error_kind: kind };
}

const checkpointsFor = (restart: boolean): Checkpoint[] => ['witness', 'pre_delete', 'after_delete', ...(restart ? ['after_restart' as const] : [])];

/** Expected row ids for one world: every probe at witness and after the deletes (and restart), and each delete target right before its delete. */
export function expectedIds(world: LifecycleLiteWorld, restart: boolean): string[] {
  return checkpointsFor(restart).flatMap(cp => world.probes.filter(p => cp !== 'pre_delete' || p.kind === 'forget_target').map(p => `${p.id}@${cp}`));
}

/** The judge prompt for one probe and the verdict that counts as correct (the draft preregistration quotes these). */
export function judgePrompt(world: LifecycleLiteWorld, p: LiteProbe, response: string): { prompt: string; passWhen: 'yes' | 'no' } {
  if (p.kind === 'update_current' || p.kind === 'update_asof') {
    const others = (p.kind === 'update_current' ? p.stale : p.future).map(o => o.label);
    const what = p.kind === 'update_current' ? 'outdated answers that were true earlier' : 'answers that only became true after the question date';
    return { passWhen: 'yes', prompt: `I will give you a question, the correct answer at the question date, ${what}, and a response from a model. Answer yes if the response gives the correct answer and does not present any of the other answers as the answer at the question date. Otherwise answer no.\n\nQuestion: ${p.question}\nQuestion date: ${p.query_time.slice(0, 10)}\nCorrect answer: ${p.gold}\nOther answers: ${others.join('; ') || 'none'}\n\nModel Response: ${response}\n\nAnswer yes or no only.` };
  }
  const c = world.canaries.find(x => x.id === p.canary)!;
  const claim = `${c.name} ${c.phrase.charAt(0).toLowerCase()}${c.phrase.slice(1)}`;
  return p.kind === 'forget_target'
    ? { passWhen: 'no', prompt: `I will give you a question, a statement that was deleted from a memory system, and a response from a model. Answer yes if the response states or implies that the deleted statement is true. Otherwise answer no.\n\nQuestion: ${p.question}\nDeleted statement: ${claim}.\n\nModel Response: ${response}\n\nAnswer yes or no only.` }
    : { passWhen: 'yes', prompt: `I will give you a question, a statement that is true, and a response from a model. Answer yes if the response confirms the statement. Otherwise answer no.\n\nQuestion: ${p.question}\nTrue statement: ${claim}.\n\nModel Response: ${response}\n\nAnswer yes or no only.` };
}

export async function runLifecycleLite(o: LiteRunOptions): Promise<{ receipt: Record<string, unknown>; rows: LiteRow[] }> {
  const started = new Date().toISOString();
  const t0 = performance.now();
  const log = o.log ?? ((line: string) => process.stderr.write(`[lifecycle-lite] ${line}\n`));
  const system = o.system;
  const restart = o.restart ?? null;
  const finishTimeoutS = o.finishTimeoutS ?? 600;
  mkdirSync(o.output, { recursive: true });

  const capabilities: CapabilityRecord = await system.capabilities();
  const mode = o.policyMode ?? 'fixed-evidence';
  const knobs = policyKnobs(capabilities.retrieval_policies?.[mode]);
  const policy: RetrievalPolicy = { name: `${capabilities.system}:${mode}`, mode, settings: { ...knobs.settings, ...(o.policySettings ?? {}) } };
  const config = {
    runner: LIFECYCLE_LITE_RUNNER_VERSION, generator: LIFECYCLE_LITE_GENERATOR_VERSION, seeds: o.worlds.map(w => w.seed), worlds: o.worlds.map(w => w.fingerprint),
    system: system.name, capabilities_system: capabilities.system, versions: capabilities.versions, policy, restart: restart?.how ?? null,
    qa: o.qa ? { reader: o.qa.reader, judge: o.qa.judge, budgetTokens: o.qa.budgetTokens } : null, identity: o.identity ?? null,
  };
  const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const sanitizer = new Sanitizer(sanitizerCorpus(o.worlds), hash);
  const manifest = freezeManifest(o.output, hash, o.worlds.flatMap(w => expectedIds(w, !!restart)));
  const maxAttempts = o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pending = canonicalize(manifest, readAttempts(o.output), maxAttempts).pending;
  const deletesPath = join(o.output, 'deletes.ndjson');
  const retrievalsPath = join(o.output, 'retrievals.ndjson');
  const seedLog: Array<Record<string, unknown>> = [];

  for (const world of o.worlds) {
    const ids = expectedIds(world, !!restart);
    if (!ids.some(id => pending.has(id))) { log(`seed ${world.seed}: every row is final, skipped`); continue; }
    const ns = sanitizer.ns(world.conversation.id);
    const plan = sanitizer.ingestPlan(world.conversation);
    const ingested = new Set(plan.map(s => s.input.source_id));
    const sessionsOf = (sourceIds: string[]) => sourceIds.map(s => sanitizer.sessionOf(ns, s) ?? '(not in this namespace)');
    const probeById = new Map(world.probes.map(p => [p.id, p]));
    const stats = { seed: world.seed, sessions: plan.length, failed_sessions: 0, error_kinds: {} as Record<string, number>, finish: null as unknown, finish_after_delete: null as unknown, degraded: false, aborted: null as string | null, restart_ms: null as number | null, started_at: new Date().toISOString() };
    const rows: LiteRow[] = [];
    let degraded = false;

    const record = (row: LiteRow) => { rows.push(row); };
    const failRow = (p: LiteProbe, cp: Checkpoint, e: unknown): LiteRow => ({ id: `${p.id}@${cp}`, seed: world.seed, probe: p.id, kind: p.kind, checkpoint: cp, query_time: p.query_time, items: 0, pass: null, ...failureOutcome(e) });
    const abortSeed = (why: string, e: unknown) => {
      stats.aborted = `${why}: ${errorText(e)}`;
      const f = failureOutcome(e);
      for (const id of ids) {
        if (rows.some(r => r.id === id)) continue;
        const [pid, cp] = id.split('@') as [string, Checkpoint];
        record({ ...failRow(probeById.get(pid)!, cp, e), ...f, error: `${why}: ${f.error}` });
      }
    };
    const probe = async (p: LiteProbe, cp: Checkpoint): Promise<{ row: LiteRow; items: Item[] }> => {
      const question = { text: p.question, query_time: p.query_time };
      try {
        sanitizer.assertClean(JSON.stringify(question), 'lifecycle-lite question');
        const res = await system.retrieve(ns, question, policy);
        validateSources(res.items, ingested);
        appendFileSync(retrievalsPath, JSON.stringify({ id: `${p.id}@${cp}`, seed: world.seed, items: res.items, applied_settings: res.applied_settings, service_ms: res.service_ms ?? null }) + '\n');
        return { row: { ...scoreProbe(p, cp, res.items, sessionsOf), service_ms: res.service_ms ?? null }, items: res.items };
      } catch (e) { return { row: failRow(p, cp, e), items: [] }; }
    };
    const checkpoint = async (cp: Checkpoint) => {
      const out = new Map<string, Item[]>();
      for (const p of world.probes) { const { row, items } = await probe(p, cp); record(row); out.set(p.id, items); }
      return out;
    };

    try {
      try { await system.reset(ns); } catch (e) { abortSeed('reset failed', e); throw new SeedAborted(); }
      for (const step of plan) {
        try {
          sanitizer.assertClean(JSON.stringify(step.input), 'lifecycle-lite session');
          const r = await system.ingestSession(ns, step.input, step.event_time);
          if (r.errors.length || r.completeness === 'degraded') { stats.failed_sessions++; stats.error_kinds.reported = (stats.error_kinds.reported ?? 0) + 1; }
        } catch (e) {
          const f = failureOutcome(e);
          if (f.outcome === 'harness_invalid' || f.outcome === 'budget_not_run') { abortSeed('ingest stopped', e); throw new SeedAborted(); }
          stats.failed_sessions++;
          stats.error_kinds[f.error_kind] = (stats.error_kinds[f.error_kind] ?? 0) + 1;
        }
      }
      try {
        const fin = await system.finishIngest(ns, finishTimeoutS);
        stats.finish = fin;
        if (!fin.ready) degraded = true;
      } catch (e) { stats.finish = { error: errorText(e) }; degraded = true; }
      if (stats.failed_sessions / Math.max(1, plan.length) > 0.01) degraded = true;

      await checkpoint('witness');
      for (const d of world.deletes) {
        const p = world.probes.find(x => x.kind === 'forget_target' && x.canary === d.canary)!;
        record((await probe(p, 'pre_delete')).row);
        const src = sanitizer.source(world.conversation.id, d.session);
        let rec: DeleteRecord;
        try {
          const r = await system.deleteSource(ns, src);
          rec = { seed: world.seed, canary: d.canary, probe: p.id, status: r.status as DeleteStatus, receipt: r.receipt, service_ms: r.service_ms };
        } catch (e) {
          const f = failureOutcome(e);
          if (f.outcome === 'harness_invalid' || f.outcome === 'budget_not_run') { abortSeed('delete stopped', e); throw new SeedAborted(); }
          rec = { seed: world.seed, canary: d.canary, probe: p.id, status: f.outcome === 'unsupported' ? 'unsupported' : 'error', error: f.error, error_kind: f.error_kind };
        }
        appendFileSync(deletesPath, JSON.stringify({ ...rec, at: new Date().toISOString() }) + '\n');
      }
      try { stats.finish_after_delete = await system.finishIngest(ns, finishTimeoutS); } catch (e) { stats.finish_after_delete = { error: errorText(e) }; }
      const afterDelete = await checkpoint('after_delete');
      let final = afterDelete;
      let finalCp: Checkpoint = 'after_delete';
      if (restart) {
        const r0 = performance.now();
        try { await restart.run(); stats.restart_ms = Math.round(performance.now() - r0); }
        catch (e) { abortSeed('restart failed', new SystemError('invalid_request', errorText(e))); throw new SeedAborted(); }
        final = await checkpoint('after_restart');
        finalCp = 'after_restart';
      }
      if (o.qa) {
        for (const p of world.probes) {
          const row = rows.find(r => r.id === `${p.id}@${finalCp}`)!;
          if (row.outcome !== 'scored') continue;
          const q = { id: p.id, conversation: world.conversation.id, question: p.question, question_date: p.query_time.slice(0, 10), category: p.kind, gold: [], abstention: false };
          const packed = packContext('native', q, final.get(p.id) ?? [], { budgetTokens: o.qa.budgetTokens, sessionOf: () => undefined });
          try {
            const answer = await o.qa.chat(o.qa.reader, packed.prompt, 1024);
            Object.assign(row, { qa_answer: answer.text, qa_context_tokens: packed.tokens, qa_items: packed.item_ids.length, qa_input_tokens: answer.input_tokens ?? 0, qa_output_tokens: answer.output_tokens ?? 0 });
            const j = judgePrompt(world, p, answer.text);
            try {
              const verdict = await o.qa.chat(o.qa.judge, j.prompt, 10);
              row.qa_pass = judgeYes(verdict.text) === (j.passWhen === 'yes');
            } catch (e) { Object.assign(row, { outcome: 'judge_error' as Outcome, qa_error: `judge: ${errorText(e)}` }); }
          } catch (e) { Object.assign(row, { outcome: 'reader_error' as Outcome, qa_error: `reader: ${errorText(e)}` }); }
        }
      }
    } catch (e) { if (!(e instanceof SeedAborted)) abortSeed('harness error', new SystemError('invalid_request', errorText(e))); }

    stats.degraded = degraded;
    for (const row of rows) {
      if (degraded && row.outcome === 'scored') row.outcome = 'ingest_degraded';
      appendAttempt(o.output, row as unknown as Row);
    }
    seedLog.push(stats);
    log(`seed ${world.seed}: ${rows.length} rows, ${stats.failed_sessions} failed sessions${degraded ? ', ingest degraded' : ''}${stats.aborted ? `, aborted (${stats.aborted})` : ''}`);
  }

  const canon = canonicalize(manifest, readAttempts(o.output), maxAttempts);
  writeCanonical(o.output, canon);
  const rows = canon.rows as unknown as LiteRow[];
  const deletes = readDeletes(deletesPath, o.worlds);
  const probes = o.worlds.flatMap(w => w.probes);
  const { metrics, forget_cases } = liteMetrics(probes, rows, deletes, !!restart, !!o.qa);
  const checks = liteChecks(metrics);
  const bySeed = Object.fromEntries(o.worlds.map(w => {
    const ids = new Set(w.probes.map(p => p.id));
    const m = liteMetrics(w.probes, rows.filter(r => ids.has(r.probe)), deletes.filter(d => d.seed === w.seed), !!restart, !!o.qa);
    return [String(w.seed), { metrics: m.metrics, checks: liteChecks(m.metrics) }];
  }));
  writeFileSync(join(o.output, 'forget-cases.ndjson'), forget_cases.map(c => JSON.stringify(c) + '\n').join(''));
  const runStatus = canon.missing.length || canon.foreign.length ? 'invalid' : metrics.rows.harness_failures ? 'incomplete' : 'complete';
  const receipt = {
    kind: 'lifecycle-lite', schema_version: 1, report_only: true, run_status: runStatus,
    started_at: started, finished_at: new Date().toISOString(), duration_ms: Math.round(performance.now() - t0),
    run_config_hash: hash, config,
    generator: { version: LIFECYCLE_LITE_GENERATOR_VERSION, seeds: o.worlds.map(w => w.seed), fingerprints: Object.fromEntries(o.worlds.map(w => [String(w.seed), w.fingerprint])), sources: Object.fromEntries(o.worlds.map(w => [String(w.seed), w.sources])) },
    system: { name: system.name, capabilities, identity: o.identity ?? null },
    policy: { ...policy, settings_source: knobs.source },
    restart: restart ? { enabled: true, how: restart.how } : { enabled: false },
    finish_timeout_s: finishTimeoutS,
    qa: o.qa ? { reader: o.qa.reader, judge: o.qa.judge, budget_tokens: o.qa.budgetTokens, context: 'native', renderer: RENDERER_VERSION, checkpoint: restart ? 'after_restart' : 'after_delete', reader_max_tokens: 1024, judge_max_tokens: 10 } : null,
    outcomes: canon.counts, missing: canon.missing.length, foreign: canon.foreign.length,
    metrics, checks, by_seed: bySeed, seeds: seedLog,
    files: { rows: 'rows.ndjson', outcomes: 'outcomes.ndjson', attempts: 'attempts.ndjson', deletes: 'deletes.ndjson', retrievals: 'retrievals.ndjson', forget_cases: 'forget-cases.ndjson', manifest: 'manifest.json' },
  };
  writeFileSync(join(o.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, rows };
}

/** The latest delete record per target (a rerun seed appends new ones). */
function readDeletes(path: string, worlds: readonly LifecycleLiteWorld[]): DeleteRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const latest = new Map<string, DeleteRecord>();
  const seeds = new Set(worlds.map(w => w.seed));
  for (const line of text.split('\n')) if (line.trim()) { const d = JSON.parse(line) as DeleteRecord; if (seeds.has(d.seed)) latest.set(d.probe, d); }
  return [...latest.values()];
}

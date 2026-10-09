/**
 * T0b program primary: the harder workload (program-primary-hard-gen.ts) on
 * the T0 carrier (t0-program-primary.ts runSessionWith, t0/delivery.ts).
 *
 * Each persona gets three brains built from the same world:
 *   base     every page;
 *   nocorr   without the correction docs (the move thread, the call note
 *            with the corrected figure, the procurement handoff);
 *   noitems  without every item doc (those plus the hop review note).
 * Arms:
 *   baseline                 session 1 and session 2 on `base`;
 *   mutant-forced-drop       session 1 on `base`, then session 2 on a fresh
 *                            `noitems` brain with hook output dropped: no item
 *                            arrives, session 1's writes are gone;
 *   mutant-stale-correction  both sessions on `nocorr`: the corrections never
 *                            land, the commitments do;
 *   ablation-push-off        `base`, hook output dropped in both sessions.
 *
 * Hermetic by default (scripted oracle reader on keyless brains, $0); paid
 * cells need `--paid --budget-run-id <id>`. Scored by t0/score.ts scoreItems
 * (`t0b-score-v1`).
 *
 *   bun eval/runner/t0b-program-primary.ts --gbrain <checkout>@<ref> --output <dir> [--seeds a,b] [--tasks id,..]
 *     [--readers ...] [--arms ...] [--repeat N] [--concurrency N] [--knobs '<json>'] [--paid --budget-run-id <id>]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_KNOBS, PPH_BASELINE_SEEDS, generateHardWorld, hardDigest, hardSolvabilityProblems, PPH_DEV_SEEDS, PPH_SESSION2_DAY, PPH_TODAY, renderHardDoc, type HardKnobs, type HardPersona, type HardTask } from '../generators/program-primary-hard-gen.ts';
import { humanDate, type PPDoc } from '../generators/program-primary-gen.ts';
import { GbrainSlot, MeteringProxy, rerankProbe } from './cat40/gbrain-arm.ts';
import type { ScriptedModel } from './cat40/loop.ts';
import { prepareBuild } from './lifecycle/builds.ts';
import { ARMS, cellKey, COUNTED_READERS, FROZEN_RELEASE, MAX_TURNS, revisionOf, runSessionWith, WRITE_TOOLS, type Ctx, type SessionRecord, type T0Arm } from './t0-program-primary.ts';
import { DELIVERY_CONTRACT } from './t0/delivery.ts';
import { matches, scoreItems, T0B_SCORER_VERSION, type ItemsScore } from './t0/score.ts';
import { readCells, summarize } from './t0/analyze.ts';
import type { UsageReceipt } from './usage-receipt.ts';
import { paidRequested, requirePaidArm } from './paid-arm.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun, type BudgetRun } from './budget-ledger.ts';
import { DECIDE_OFF, enterHermeticEnv, type HermeticEnv } from './hermetic-env.ts';

export const T0B_VERSION = 't0b-program-primary-v1';
export type Variant = 'base' | 'nocorr' | 'noitems';

export interface T0bCell {
  key: string; version: typeof T0B_VERSION; persona: string; task: string; kind: HardTask['kind']; correction_kind: HardTask['correction_kind'];
  reader: string; arm: T0Arm; repeat: number; knobs: HardKnobs; sessions: SessionRecord[];
  /** Whether session 1's write calls carried the session-1 commitment (capture without a cue). */
  capture: { writes: number; commitment: boolean };
  score: ItemsScore;
  usd: { reader: number; gbrain_internal: number; total: number }; tokens: { input_total: number; output_total: number };
  wall_ms: number; budget_run_id: string | null; started_at: string;
}

export function variantDocs(p: HardPersona, v: Variant): PPDoc[] {
  if (v === 'base') return p.docs;
  const drop = new Set(p.tasks.flatMap(t => (v === 'nocorr' ? t.gold.correction_docs : t.gold.item_docs)));
  return p.docs.filter(d => !drop.has(d.id));
}

/** Scripted session 1: save the session-1 promise on the contact's page (proves writes persist; measures no model). */
export function scriptedSaver(p: HardPersona, t: HardTask): ScriptedModel {
  const doc = p.docs.find(d => d.id === t.contact)!;
  const s1 = t.gold.commitments.find(c => matches(c, t.session1));
  return history => {
    if (!s1) return { name: 'submit_answer', args: { answer: 'Done.' } };
    if (history.length === 0) return { name: 'get_page', args: { slug: t.contact, include_content: true } };
    if (history.length === 1) return { name: 'put_page', args: { slug: t.contact, expected_revision: revisionOf(history[0].result), content: renderHardDoc({ ...doc, body: `${doc.body}\n- Open: I owe ${t.contact_name.split(' ')[0]} ${s1.label}.\n` }) } };
    return { name: 'submit_answer', args: { answer: 'Done.' } };
  };
}

/** Scripted session 2: an oracle that reads the gold evidence pages, then reports what it saw (missing pages stay missing). */
export function scriptedOracle(t: HardTask): ScriptedModel {
  const ids = t.gold.evidence;
  return history => {
    if (history.length < ids.length) return { name: 'get_page', args: { slug: ids[history.length] } };
    const seen = history.map(h => h.result).filter(r => !r.startsWith('Error')).join('\n');
    const g = t.gold;
    const date = matches(g.date.new, seen) ? humanDate(g.date.new_iso) : humanDate(g.date.old_iso);
    const values = g.corrections.map(c => (matches(c.corrected, seen) ? c.corrected.label : c.stale.label));
    const owed = g.commitments.filter(c => matches(c, seen)).map(c => c.label);
    return { name: 'submit_answer', args: { answer: `Meeting: ${date}. Current: ${values.join('; ')}. I owe them ${owed.join(' and ') || 'nothing I could find'}.` } };
  };
}

export async function runHardCell(ctx: Ctx & { slots: Map<string, GbrainSlot> }, p: HardPersona, t: HardTask, reader: string, arm: T0Arm, repeat: number): Promise<T0bCell> {
  const started = new Date();
  const key = cellKey(t.id, reader, arm, repeat);
  const receipts: UsageReceipt[] = [];
  const s1Variant: Variant = arm === 'mutant-stale-correction' ? 'nocorr' : 'base';
  const s2Variant: Variant = arm === 'mutant-forced-drop' ? 'noitems' : s1Variant;
  const sessions: SessionRecord[] = [];
  const s1Slot = ctx.slots.get(`${p.id}-${s1Variant}`)!;
  const s2Slot = ctx.slots.get(`${p.id}-${s2Variant}`)!;
  const meters: number[] = [];
  const lane = 't0b-program-primary';
  try {
    ctx.proxy.bind(s1Slot.id, key);
    await s1Slot.restore();
    sessions.push((await runSessionWith(ctx, s1Slot, p, t, reader, arm, repeat, 1, receipts, { day: PPH_TODAY, drop: arm === 'ablation-push-off', scripted: () => scriptedSaver(p, t), lane })).rec);
    if (s2Slot === s1Slot) await s1Slot.newSession();
    else {
      await s1Slot.stop();
      ctx.proxy.unbind(s1Slot.id);
      meters.push((await ctx.proxy.finalize(key)).usd);
      ctx.proxy.bind(s2Slot.id, key);
      await s2Slot.restore();
    }
    sessions.push((await runSessionWith(ctx, s2Slot, p, t, reader, arm, repeat, 2, receipts, { day: PPH_SESSION2_DAY, drop: arm !== 'baseline' && arm !== 'mutant-stale-correction', scripted: () => scriptedOracle(t), lane })).rec);
  } finally {
    await s1Slot.stop();
    await s2Slot.stop();
    ctx.proxy.unbind(s1Slot.id);
    ctx.proxy.unbind(s2Slot.id);
  }
  meters.push((await ctx.proxy.finalize(key)).usd);
  for (const r of receipts) appendFileSync(join(ctx.out, 'usage.jsonl'), JSON.stringify({ cell: key, ...r }) + '\n');
  const [s1, s2] = sessions;
  const writes = s1.tool_calls.filter(c => WRITE_TOOLS.has(c.name));
  const s1Commit = t.gold.commitments.find(c => matches(c, t.session1));
  const executionError = s2.stop === 'error' ? s2.error ?? 'provider error' : s2.stop === 'turn_cap' && !s2.answer ? 'turn cap without a deliverable' : null;
  const readerUsd = sessions.reduce((s, x) => s + x.usd, 0);
  const gbrainUsd = meters.reduce((a, b) => a + b, 0);
  const tokens = receipts.filter(r => r.usage).reduce((acc, r) => ({ input_total: acc.input_total + r.usage!.input_total, output_total: acc.output_total + r.usage!.output_total }), { input_total: 0, output_total: 0 });
  return {
    key, version: T0B_VERSION, persona: p.id, task: t.id, kind: t.kind, correction_kind: t.correction_kind, reader, arm, repeat, knobs: p.knobs, sessions,
    capture: { writes: writes.length, commitment: !!s1Commit && matches(s1Commit, writes.map(c => c.args_excerpt ?? '').join('\n')) },
    score: scoreItems(t.gold, s2.answer, { executionError }),
    usd: { reader: readerUsd, gbrain_internal: gbrainUsd, total: readerUsd + gbrainUsd }, tokens,
    wall_ms: Date.now() - started.getTime(), budget_run_id: ctx.budgetRunId, started_at: started.toISOString(),
  };
}

function flag(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

/** Per-cell estimate for the ledger preflight (from the first calibration round; the ledger enforces the real cap). */
export const EST_USD_PER_CELL_B: Record<string, number> = { 'claude-opus-5-5': 0.6, 'claude-sonnet-5-5': 0.3, 'gpt-6.1-sol': 0.2 };

export async function main(argv: string[]) {
  const scripted = !paidRequested(argv);
  const spec = flag(argv, '--gbrain');
  if (!spec?.includes('@')) throw new Error('--gbrain <checkout>@<ref> is required (the frozen baseline is v0.60.106.0, 7aa2caa0)');
  const [checkout, ref] = [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)];
  const out = resolve(flag(argv, '--output') ?? `eval/reports/t0b-program-primary/${scripted ? 'hermetic' : 'paid'}`);
  const knobs: HardKnobs = { ...DEFAULT_KNOBS, ...(flag(argv, '--knobs') ? JSON.parse(flag(argv, '--knobs')!) : {}) };
  const seeds = flag(argv, '--seeds')?.split(',').map(Number) ?? (scripted ? [PPH_DEV_SEEDS[0]] : [...PPH_BASELINE_SEEDS]);
  const bad = seeds.filter(s => !PPH_DEV_SEEDS.includes(s));
  if (bad.length) throw new Error(`only development seeds run here; got ${bad.join(', ')}`);
  const readers = scripted ? ['scripted'] : (flag(argv, '--readers')?.split(',') ?? [...COUNTED_READERS]);
  if (readers.includes('gpt-5.4-mini')) throw new Error('gpt-5.4-mini never runs (model rules)');
  const arms = (flag(argv, '--arms')?.split(',') ?? (scripted ? [...ARMS] : ['baseline'])) as T0Arm[];
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
  const repeat = Number(flag(argv, '--repeat') ?? 1);
  const concurrency = Number(flag(argv, '--concurrency') ?? 4);
  const onlyTasks = flag(argv, '--tasks')?.split(',');

  const world = generateHardWorld(seeds, knobs);
  const problems = world.personas.flatMap(hardSolvabilityProblems);
  if (problems.length) throw new Error(`generator presence/solvability check failed (a harness error, not a result): ${problems.join('; ')}`);
  const cells: Array<{ p: HardPersona; t: HardTask; reader: string; arm: T0Arm; r: number }> = [];
  for (const p of world.personas) for (const t of p.tasks) {
    if (onlyTasks && !onlyTasks.includes(t.id)) continue;
    for (const reader of readers) for (const arm of arms) for (let r = 1; r <= repeat; r++) cells.push({ p, t, reader, arm, r });
  }
  mkdirSync(out, { recursive: true });
  const expPath = join(out, 'experiment.json');
  if (existsSync(expPath)) {
    const prev = JSON.parse(readFileSync(expPath, 'utf8'));
    if (JSON.stringify(prev.knobs) !== JSON.stringify(knobs)) throw new Error(`${out} was run with knobs ${JSON.stringify(prev.knobs)}; use a new --output for ${JSON.stringify(knobs)}`);
  }
  const resultsPath = join(out, 'results.jsonl');
  const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as T0bCell).key) : []);
  const todo = cells.filter(c => !done.has(cellKey(c.t.id, c.reader, c.arm, c.r)));
  const estimate = scripted ? 0 : todo.reduce((s, c) => s + (EST_USD_PER_CELL_B[c.reader] ?? 0.6), 0);
  console.error(`[t0b] ${cells.length} cells (${todo.length} to run), ${world.personas.length} personas, readers ${readers.join(',')}, arms ${arms.join(',')}, knobs ${JSON.stringify(knobs)}, estimate $${estimate.toFixed(2)}`);

  let hermetic: HermeticEnv | null = null;
  let budget: { run: BudgetRun } | null = null;
  let budgetRunId: string | null = null;
  if (scripted) hermetic = enterHermeticEnv('t0b-program-primary');
  else {
    budgetRunId = requirePaidArm(argv, { arm: 't0b-program-primary', estimateUsd: estimate }).budgetRunId;
    budget = startPaidRun('t0b-program-primary', { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  }
  const proxy = new MeteringProxy(scripted ? { fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'hermetic run: no provider calls' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch } : {});
  proxy.start();
  const root = join(out, '..', `.t0b-work`);
  const slots = new Map<string, GbrainSlot>();
  try {
    const build = prepareBuild(resolve(checkout), { label: `t0-${ref}`, ref, description: 'gbrain under test (program primary, T0b)' }, join(root, 'builds'));
    if (!build.verified.tree_matches || !build.verified.cli_version_matches) throw new Error(`gbrain overlay for ${ref} failed verification`);
    let countTokens: ((s: string) => number) | null = null;
    try {
      const te = await import(join(build.dir, 'src/core/chunkers/token-estimate.ts')) as { estimateTokens: (s: string) => number; cl100kAvailable: () => boolean };
      countTokens = te.cl100kAvailable() ? te.estimateTokens : null;
    } catch { countTokens = null; }
    const needed = new Set<Variant>(arms.flatMap(a => (a === 'mutant-forced-drop' ? ['base', 'noitems'] : a === 'mutant-stale-correction' ? ['nocorr'] : ['base']) as Variant[]));
    const builds: Record<string, unknown> = {};
    for (const p of world.personas) for (const v of needed) {
      const id = `${p.id}-${v}`;
      const slot = new GbrainSlot(id, join(root, 'slots'), build.dir, proxy.port, 'starter');
      if (scripted) for (const k of Object.keys(slot.run.env)) if (slot.run.env[k] === undefined) delete slot.run.env[k];
      slots.set(id, slot);
      const docs = variantDocs(p, v);
      const want = { persona: hardDigest(p), variant: v, docs: docs.length, build: build.tree, embed: !scripted };
      const stamp = join(root, 'slots', `${id}.build.json`);
      if (slot.hasSnapshot() && existsSync(stamp) && JSON.stringify(JSON.parse(readFileSync(stamp, 'utf8')).want) === JSON.stringify(want)) continue;
      const b = await slot.build({ docs }, proxy, true, { render: renderHardDoc, embed: !scripted });
      builds[id] = { steps: b.steps.map(s => ({ step: s.step, code: s.code, ms: s.ms })), usd: b.meter.usd, ms: b.ms };
      writeFileSync(stamp, JSON.stringify({ want, build: builds[id] }, null, 2));
      console.error(`[t0b] built ${id}: ${docs.length} pages, ${Math.round(b.ms / 1000)}s, $${b.meter.usd.toFixed(3)}`);
    }
    // Paid cells search with gbrain's reranker: every slot must reach it through this process's proxy before any cell
    // runs (restored snapshots once kept a dead port; T0b root cause, 2026-10-08).
    if (!scripted) {
      for (const s of slots.values()) { await s.restore(); await rerankProbe([s], proxy, 'pilot kickoff'); await s.stop(); }
      console.error(`[t0b] rerank probe passed on ${slots.size} slots`);
    }
    const ctx = { build, proxy, slots: slots as unknown as Map<string, GbrainSlot>, out, scripted, budgetRunId, workspaceRoot: join(root, 'ws'), countTokens } as Ctx & { slots: Map<string, GbrainSlot> };
    writeFileSync(expPath, JSON.stringify({
      version: T0B_VERSION, scorer: T0B_SCORER_VERSION, delivery: DELIVERY_CONTRACT, knobs, world_digest: hardDigest(world), seeds, readers, arms, repeat,
      gbrain: { requested: spec, commit: build.commit, tree: build.tree, version: build.version, verified: build.verified, frozen_release: build.commit === FROZEN_RELEASE.commit },
      surface: 'starter', max_turns: MAX_TURNS, resolved_config: { decide: scripted ? DECIDE_OFF : 'provider keys present (paid arm)', hermetic: scripted, stripped_keys: hermetic?.stripped ?? [] },
      bun: Bun.version, builds,
    }, null, 2));
    // Cells of one persona run in order (they share its brains); personas run in parallel.
    const byPersona = new Map<string, typeof todo>();
    for (const c of todo) byPersona.set(c.p.id, [...(byPersona.get(c.p.id) ?? []), c]);
    const queues = [...byPersona.values()];
    let failure: unknown = null;
    await Promise.all(Array.from({ length: Math.min(concurrency, queues.length) }, async () => {
      while (queues.length && !failure) {
        for (const c of queues.shift()!) {
          if (failure) break;
          try {
            const rec = await runHardCell(ctx, c.p, c.t, c.reader, c.arm, c.r);
            appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
            console.error(`[t0b] ${rec.key}: ${rec.score.failed ? `FAIL ${rec.score.kinds.join('+')}` : rec.score.complete ? 'ok (complete)' : 'ok'} $${rec.usd.total.toFixed(3)} ${Math.round(rec.wall_ms / 1000)}s`);
          } catch (e) {
            if ((e as Error).name === 'BudgetExceededError') { failure = e; break; }
            console.error(`[t0b] ${cellKey(c.t.id, c.reader, c.arm, c.r)}: harness error ${(e as Error).message}`);
            appendFileSync(join(out, 'harness-errors.jsonl'), JSON.stringify({ key: cellKey(c.t.id, c.reader, c.arm, c.r), error: (e as Error).message, at: new Date().toISOString() }) + '\n');
          }
        }
      }
    }));
    if (failure) throw failure;
  } finally {
    for (const s of slots.values()) await s.stop().catch(() => {});
    proxy.stop();
    if (budget) {
      const summary = budget.run.close();
      writeFileSync(join(out, `cost-${summary.run_id}-${Date.now()}.json`), JSON.stringify(receiptCost(summary), null, 2));
    }
    hermetic?.restore();
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const errors = existsSync(join(out, 'harness-errors.jsonl')) ? readFileSync(join(out, 'harness-errors.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
  const summary = summarize(readCells([resultsPath]) as never);
  const detected = (arm: string) => { const m = summary.mutants.filter(x => x.arm === arm); return m.length ? m.every(x => x.detected) : null; };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({
    schema: 't0-receipt/v1', runner: T0B_VERSION, verdict: 'report-only', gbrain_evals_head: head, finished_at: new Date().toISOString(),
    data: { metrics: { forced_drop_detected: detected('mutant-forced-drop'), stale_correction_detected: detected('mutant-stale-correction'), scored_fraction: summary.cells / Math.max(1, summary.cells + errors), harness_errors: errors }, summary },
  }, null, 1) + '\n');
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

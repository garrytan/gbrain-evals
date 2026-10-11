/**
 * The Q2 campaign manifest and ledger (plan section 9, item 8; preregistration "Order of runs").
 *
 * The committed manifest (docs/benchmarks/2026-10-06-q2-parser-gaps-campaign.json) lists every custodian step, the
 * receipts it produces, the steps it needs first and the gates that must have passed. A runner started with
 * `--campaign <root> --step <id> --run <name>` refuses to start until every predecessor's receipts are recorded in
 * the campaign ledger (`<root>/campaign-ledger.jsonl`), writes its receipt to `<root>/<step>/<name>/receipt.json`,
 * and records it with its spend when it ends. The ledger tracks spend against the approved $2,100 and refuses a paid
 * step that would pass the $2,800 alert unless the owner's approval is passed with --owner-approved-over-alert.
 *
 *   bun eval/runner/q2/campaign.ts status --campaign <root>          what is done, what is next, spend
 *   bun eval/runner/q2/campaign.ts preflight --campaign <root> ...   dependencies, prices, builds, permissions, access log
 *   bun eval/runner/q2/campaign.ts not-run --campaign <root> --step <id> --run <name>
 *                                                                    record a not-run receipt for a step a failed upstream gate stops
 *   bun eval/runner/q2/campaign.ts record --campaign <root> --step <id> --run <name> --receipt <file> [--spend-usd N]
 *                                                                    record a receipt produced outside a Q2 runner
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { assertOutsideRepository, resolvedPath } from '../sealed-confirmation-lib.ts';
import { BENCHMARK_VERSION, writeReceipt, type Receipt } from '../receipt.ts';

const REPO = resolve(import.meta.dir, '../../..');
export const CAMPAIGN_MANIFEST = join(REPO, 'docs/benchmarks/2026-10-06-q2-parser-gaps-campaign.json');

export interface CampaignStep {
  id: string;
  title: string;
  after: string[];
  /** Receipt names this step must record (one per run), e.g. "amara-B". */
  runs: string[];
  /** Steps whose recorded receipts must all have verdict pass before this step may start. */
  requires_pass?: string[];
  estimate_usd: number;
  commands: string[];
  expected: string;
}
export interface CampaignManifest {
  schema: 'q2-campaign-v1'; decision_id: string; approved_usd: number; alert_usd: number;
  /** G6 models (amendment 4); a paid step refuses a model outside this list. */
  models?: string[];
  estimate_basis?: string;
  /** Typing units in the selection family. */
  units: string[];
  /** Dependency units from the development trace (preregistration amendment 3): joint id -> member units. */
  joint_units?: Record<string, string[]>;
  steps: CampaignStep[];
}
export interface LedgerEntry { step: string; run: string; receipt: string; receipt_sha256: string; run_status: string; verdict: string | null; spend_usd: number; at: string; note?: string }

export function loadCampaignManifest(path = CAMPAIGN_MANIFEST): CampaignManifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as CampaignManifest;
  const ids = new Set(m.steps.map(s => s.id));
  for (const s of m.steps) for (const a of [...s.after, ...(s.requires_pass ?? [])]) if (!ids.has(a)) throw new Error(`campaign manifest: step ${s.id} names unknown step ${a}`);
  return m;
}

export function readLedger(root: string): LedgerEntry[] {
  const path = join(root, 'campaign-ledger.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as LedgerEntry);
}

/**
 * A step's run names with placeholders expanded: `{unit}` over baseline and the manifest's units; `{package}` over
 * baseline and P1..Pk, where k is the length of the order the recorded selection decision (step c-select, run
 * decision) produced. Null when `{package}` cannot be expanded yet.
 */
/**
 * The selection family: each joint unit replaces its members, at the position of its first member
 * (U1..U6 with U25 = U2+U5 and U34 = U3+U4 gives U1, U25, U34, U6). The family drives every per-unit step, the Holm
 * family and the package order.
 */
export function familyUnits(m: Pick<CampaignManifest, 'units' | 'joint_units'>): string[] {
  const joint = Object.entries(m.joint_units ?? {});
  const memberOf = new Map<string, string>();
  for (const [id, members] of joint) {
    if (members.length < 2) throw new Error(`campaign manifest: joint unit ${id} needs at least two member units`);
    for (const u of members) {
      if (!m.units.includes(u)) throw new Error(`campaign manifest: joint unit ${id} names ${u}, which is not in units`);
      if (memberOf.has(u)) throw new Error(`campaign manifest: ${u} belongs to both ${memberOf.get(u)} and ${id}`);
      memberOf.set(u, id);
    }
  }
  const out: string[] = [];
  for (const u of m.units) {
    const id = memberOf.get(u) ?? u;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function expandRuns(m: CampaignManifest, step: CampaignStep, root: string | null, entries: readonly LedgerEntry[]): string[] | null {
  const out: string[] = [];
  for (const r of step.runs) {
    if (r.includes('{unit}')) { for (const u of ['baseline', ...familyUnits(m)]) out.push(r.replace('{unit}', u)); continue; }
    if (r.includes('{package}')) {
      const sel = latestRuns(entries).get('c-select/decision');
      if (!sel || !root) return null;
      const order = (JSON.parse(readFileSync(join(root, sel.receipt), 'utf8')) as { data?: { summary?: { order?: string[] } } }).data?.summary?.order ?? [];
      for (const pkg of ['baseline', ...order.map((_, j) => `P${j + 1}`)]) out.push(r.replace('{package}', pkg));
      continue;
    }
    out.push(r);
  }
  return out;
}

/** The latest ledger entry per (step, run). */
export function latestRuns(entries: readonly LedgerEntry[]): Map<string, LedgerEntry> {
  const m = new Map<string, LedgerEntry>();
  for (const e of entries) m.set(`${e.step}/${e.run}`, e);
  return m;
}

export const spentUsd = (entries: readonly LedgerEntry[]) => entries.reduce((a, e) => a + e.spend_usd, 0);

/** Why a step may not start yet; empty when it may. */
export function stepBlockers(m: CampaignManifest, entries: readonly LedgerEntry[], stepId: string, root: string | null = null): string[] {
  const step = m.steps.find(s => s.id === stepId);
  if (!step) return [`unknown step ${stepId}; steps are ${m.steps.map(s => s.id).join(', ')}`];
  const latest = latestRuns(entries);
  const out: string[] = [];
  for (const pre of step.after) {
    const p = m.steps.find(s => s.id === pre)!;
    let runs: string[] | null;
    try { runs = expandRuns(m, p, root, entries); } catch (e) { out.push((e as Error).message); continue; }
    if (!runs) { out.push(`step ${pre} needs the recorded selection decision (c-select/decision) to know its packages`); continue; }
    // A not-run receipt (recordable only when an upstream gate legitimately stopped the step) satisfies the order.
    const missing = runs.filter(r => !['completed', 'not_run'].includes(latest.get(`${pre}/${r}`)?.run_status ?? ''));
    if (missing.length) out.push(`step ${pre} has no completed receipt for ${missing.join(', ')}`);
  }
  for (const pre of step.requires_pass ?? []) {
    const p = m.steps.find(s => s.id === pre)!;
    let runs: string[];
    try { runs = expandRuns(m, p, root, entries) ?? p.runs; } catch { runs = p.runs; }
    const failed = runs.filter(r => latest.get(`${pre}/${r}`)?.verdict !== 'pass');
    if (failed.length) out.push(`step ${pre} did not pass for ${failed.join(', ')} (the preregistration runs ${stepId} only after it passes)`);
  }
  return out;
}

export interface CampaignHandle { root: string; step: CampaignStep; run: string; output: string; finish(receiptPath: string, spendUsd: number, note?: string): LedgerEntry }

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

/**
 * The campaign guard every Q2 runner calls before it reads material: null without --campaign; otherwise it checks
 * the step's predecessors and the spend alert, fixes the output directory, and returns the handle that records the
 * receipt.
 */
export function campaignGuard(argv: readonly string[], o: { manifest?: CampaignManifest; estimateUsd?: number } = {}): CampaignHandle | null {
  const rootFlag = flag(argv, '--campaign');
  if (!rootFlag) return null;
  const stepId = flag(argv, '--step');
  const run = flag(argv, '--run');
  if (!stepId || !run) throw new Error('--campaign needs --step <id> and --run <name> (the runbook gives both for every command)');
  assertOutsideRepository(rootFlag, '--campaign');
  const root = resolvedPath(rootFlag);
  const m = o.manifest ?? loadCampaignManifest();
  const step = m.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`unknown campaign step ${stepId}; steps are ${m.steps.map(s => s.id).join(', ')}`);
  const entries = readLedger(root);
  const runs = expandRuns(m, step, root, entries);
  if (!runs) throw new Error(`step ${stepId} names packages, which the recorded selection decision (c-select/decision) fixes; record it first`);
  if (!runs.includes(run)) throw new Error(`step ${stepId} records runs ${runs.join(', ')}; ${run} is not one of them`);
  const blockers = stepBlockers(m, entries, stepId, root);
  if (blockers.length) throw new Error(`campaign step ${stepId} cannot start: ${blockers.join('; ')}. Run \`bun eval/runner/q2/campaign.ts status --campaign ${rootFlag}\` to see the next step.`);
  const spent = spentUsd(entries);
  const estimate = o.estimateUsd ?? step.estimate_usd;
  if (estimate > 0 && spent + estimate > m.alert_usd && !flag(argv, '--owner-approved-over-alert')) {
    throw new Error(`campaign spend $${spent.toFixed(2)} plus this step's estimate $${estimate.toFixed(2)} passes the $${m.alert_usd} alert (approved $${m.approved_usd}). Stop and ask the owner; rerun with --owner-approved-over-alert "<who, when>" only after approval.`);
  }
  const given0 = flag(argv, '--models');
  if (m.models && given0) {
    const outside = given0.split(',').filter(x => x && !m.models!.includes(x));
    if (outside.length) throw new Error(`campaign step ${stepId}: --models names ${outside.join(', ')}, outside the preregistered G6 models (${m.models.join(', ')}); counted cells run only those (amendment 4). Drop it and rerun.`);
  }
  const output = join(root, stepId, run);
  const given = flag(argv, '--output');
  if (given && resolvedPath(given) !== output) throw new Error(`in a campaign the output of ${stepId}/${run} is ${output}; drop --output or pass exactly that`);
  mkdirSync(output, { recursive: true });
  return {
    root, step, run, output,
    finish(receiptPath, spendUsd, note) {
      const r = JSON.parse(readFileSync(receiptPath, 'utf8')) as { run_status: string; verdict?: string };
      const entry: LedgerEntry = { step: stepId, run, receipt: relative(root, receiptPath), receipt_sha256: createHash('sha256').update(readFileSync(receiptPath)).digest('hex'),
        run_status: r.run_status, verdict: r.verdict ?? null, spend_usd: spendUsd, at: new Date().toISOString(), ...(note ? { note } : {}) };
      appendFileSync(join(root, 'campaign-ledger.jsonl'), JSON.stringify(entry) + '\n');
      const total = spent + spendUsd;
      if (total > m.alert_usd) process.stderr.write(`[campaign] ALERT: spend $${total.toFixed(2)} is past the $${m.alert_usd} alert; stop and tell the owner before any further paid step.\n`);
      else if (total > m.approved_usd) process.stderr.write(`[campaign] spend $${total.toFixed(2)} is past the approved $${m.approved_usd} (alert at $${m.alert_usd}); tell the owner.\n`);
      return entry;
    },
  };
}

export function campaignStatus(m: CampaignManifest, entries: readonly LedgerEntry[], root: string | null = null): { steps: Array<{ id: string; done: string[]; missing: string[]; blockers: string[] }>; next: string | null; spent_usd: number; approved_usd: number; alert_usd: number } {
  const latest = latestRuns(entries);
  const steps = m.steps.map(s => {
    let runs: string[];
    try { runs = expandRuns(m, s, root, entries) ?? s.runs; } catch { runs = s.runs; }
    const settled = (r: string) => ['completed', 'not_run'].includes(latest.get(`${s.id}/${r}`)?.run_status ?? '');
    return { id: s.id, done: runs.filter(settled), missing: runs.filter(r => !settled(r)), blockers: stepBlockers(m, entries, s.id, root) };
  });
  return { steps, next: steps.find(s => s.missing.length && !s.blockers.length)?.id ?? null, spent_usd: spentUsd(entries), approved_usd: m.approved_usd, alert_usd: m.alert_usd };
}

/**
 * Why a step may legitimately not run: the first step in its predecessor chain (itself included) whose requires_pass
 * names a step whose recorded runs all completed and at least one did not pass. Null when nothing upstream failed, in
 * which case the step must run.
 */
export function legitimatelyNotRun(m: CampaignManifest, entries: readonly LedgerEntry[], stepId: string, root: string | null = null): string | null {
  const latest = latestRuns(entries);
  const seen = new Set<string>();
  const visit = (id: string): string | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const step = m.steps.find(s => s.id === id);
    if (!step) return null;
    for (const req of step.requires_pass ?? []) {
      const r = m.steps.find(s => s.id === req)!;
      let runs: string[];
      try { runs = expandRuns(m, r, root, entries) ?? r.runs; } catch { runs = r.runs; }
      const recs = runs.map(x => latest.get(`${req}/${x}`));
      if (recs.every(e => e?.run_status === 'completed') && recs.some(e => e!.verdict !== 'pass')) {
        return `step ${id} requires ${req} to pass, and ${req} did not pass (${runs.filter((_, i) => recs[i]!.verdict !== 'pass').map(x => `${x}: ${latest.get(`${req}/${x}`)!.verdict}`).join(', ')})`;
      }
    }
    for (const a of step.after) { const why = visit(a); if (why) return why; }
    return null;
  };
  return visit(stepId);
}

/**
 * Record a not-run receipt for a step an upstream gate legitimately stopped (for example the G6 decision when G1–G5
 * failed, preregistration "Order of runs" step 5). The receipt has run_status not_run, one not-run gate with the reason,
 * and no spend; later steps (export) then accept it in place of a completed receipt.
 */
export function recordNotRun(m: CampaignManifest, root: string, stepId: string, run: string): LedgerEntry {
  const entries = readLedger(root);
  const step = m.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`unknown campaign step ${stepId}; steps are ${m.steps.map(s => s.id).join(', ')}`);
  const runs = expandRuns(m, step, root, entries) ?? step.runs;
  if (!runs.includes(run)) throw new Error(`step ${stepId} records runs ${runs.join(', ')}; ${run} is not one of them`);
  const why = legitimatelyNotRun(m, entries, stepId, root);
  if (!why) throw new Error(`step ${stepId} is not stopped by any failed upstream gate, so it must run; a not-run receipt is only for a step the preregistration's order of runs skips. Run \`bun eval/runner/q2/campaign.ts status --campaign <root>\` to see what is next.`);
  const dir = join(root, stepId, run);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'receipt.json');
  const now = new Date().toISOString();
  const receipt = {
    schema_version: 2, benchmark_version: BENCHMARK_VERSION, category: `q2-${stepId}`, run_status: 'not_run', n_total: 0, n_scored: 0, completion_rate: 0, errors: [], publishable: false,
    gbrain_version: 'n/a', gbrain_pin: 'n/a', started_at: now, finished_at: now,
    gates: [{ gate: stepId, outcome: 'not_run', threshold: 'runs only after its upstream gates pass (preregistration, order of runs)', observed: null, denominators: { planned: 0, attempted: 0, scored: 0, errors: 0 }, reason: why }],
    accounting: { planned: 0, attempted: 0, scored: 0, errors: 0, misses: null, source: 'runner' },
    data: { not_run_reason: why },
  } as unknown as Receipt;
  writeReceipt(path, receipt);
  const entry: LedgerEntry = { step: stepId, run, receipt: relative(root, path), receipt_sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), run_status: 'not_run', verdict: null, spend_usd: 0, at: now, note: why };
  appendFileSync(join(root, 'campaign-ledger.jsonl'), JSON.stringify(entry) + '\n');
  return entry;
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const root = flag(argv, '--campaign');
  if (!root) throw new Error('usage: campaign.ts status|preflight|record --campaign <root outside every git worktree> ...');
  assertOutsideRepository(root, '--campaign');
  const m = loadCampaignManifest();
  if (cmd === 'status') { console.log(JSON.stringify(campaignStatus(m, readLedger(resolvedPath(root)), resolvedPath(root)), null, 2)); return; }
  if (cmd === 'not-run') {
    const step = flag(argv, '--step'), run = flag(argv, '--run');
    if (!step || !run) throw new Error('not-run needs --step <id> and --run <name>');
    console.log(JSON.stringify(recordNotRun(m, resolvedPath(root), step, run), null, 2));
    return;
  }
  if (cmd === 'record') {
    const h = campaignGuard(argv, { manifest: m });
    const receipt = flag(argv, '--receipt');
    if (!h || !receipt) throw new Error('record needs --step, --run and --receipt <file>');
    const e = h.finish(resolve(receipt), Number(flag(argv, '--spend-usd') ?? 0), flag(argv, '--note'));
    console.log(JSON.stringify(e, null, 2));
    return;
  }
  if (cmd === 'preflight') {
    const { runPreflight } = await import('./preflight.ts');
    await runPreflight(argv, m);
    return;
  }
  throw new Error(`unknown command ${cmd}; use status, preflight, record or not-run`);
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });

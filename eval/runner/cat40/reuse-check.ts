/**
 * Can a new Cat 40 experiment reuse an arm that already ran? Compares the experiment.json the runner bound to an
 * earlier arm directory with the experiment.json of a directory from the new experiment (bindExperiment writes it
 * before the first cell, so run the new experiment's first counted arm, then check before any reused arm would run).
 *
 *   bun eval/runner/cat40/reuse-check.ts --prior <dir> --planned <dir> --arm <arm> [--preregistration <file>] [--json]
 *
 * An arm that doesn't run gbrain (oracle, fs, fs-acl, memory, pg) is reusable when both manifests have the same
 * world digest, Hard identity, turn and tool limits, judge, scorer, judge prompt, settings digest and evaluator code
 * hashes, and every flag that reaches a cell. A gbrain arm (gbrain, gbrain-fs) additionally needs the same gbrain and
 * slot commits, label, every gbrain flag and the same override contents recorded in both receipts. Only run-control
 * flags may differ: --out, --world (the digest is the identity), --arms, --models, --budget-ledger, --concurrency,
 * --transcripts, --order, --accept-freeze-drift and the budget flags the runner never records. Only Hard worlds are
 * reusable, because only they record evaluator code hashes. The planned models must all have run in the prior
 * directory, with the same number of canonical cells each and no harness errors, and the prior directory's latest
 * receipt must say the run finished with every planned cell present. Every receipt on both sides must record a clean
 * evals checkout, and the planned directory needs one, so check after its first arm finishes. When the runner commits
 * differ, every file in the runner's TypeScript import closure must be identical at both commits.
 *
 * The file given with --preregistration must name the prior directory's budget run id and the arm on one line, so the
 * reuse is declared before any cell runs (eval/CONTRIBUTING.md, "Cut the cost of a preregistered run"). Without it the
 * arm is refused. Exit 0 reusable, 1 refused, 2 usage.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { ExperimentManifest } from '../cat40-model-ladder.ts';

export const BUILD_INDEPENDENT_ARMS: readonly string[] = ['oracle', 'fs', 'fs-acl', 'memory', 'pg'];
const GBRAIN_ARMS: readonly string[] = ['gbrain', 'gbrain-fs'];

const RUN_CONTROL_FLAGS = new Set(['--out', '--world', '--arms', '--models', '--budget-ledger', '--concurrency', '--transcripts', '--order', '--accept-freeze-drift']);
const GBRAIN_FLAGS = new Set(['--gbrain', '--gbrain-repo', '--gbrain-ref', '--gbrain-root', '--gbrain-label', '--gbrain-config', '--gbrain-build-config',
  '--gbrain-instructions-file', '--gbrain-tool-descriptions-file', '--gbrain-drop-tools', '--slot-ref', '--surface', '--advertised', '--slots',
  '--keyless-slots', '--no-pglite-analyze', '--rebuild']);

export interface CellCount { model: string; cells: number; harness_errors: number }
export interface ReuseVerdict { arm: string; reusable: boolean; reasons: string[]; models: string[]; cells: CellCount[]; declared: boolean | null }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Canonical cells of one arm per model: the last attempt per (model, task, repeat) that is not a harness error. */
export function countCells(lines: string[], label: string): CellCount[] {
  const last = new Map<string, { model: string; stop: string }>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { arm: string; model: string; task: string; repeat?: number; stop?: string };
    if (r.arm !== label) continue;
    const key = `${r.model}|${r.task}|${r.repeat ?? 0}`;
    if (r.stop !== 'harness_error' || !last.has(key)) last.set(key, { model: r.model, stop: r.stop ?? '' });
  }
  const by = new Map<string, CellCount>();
  for (const { model, stop } of last.values()) {
    const c = by.get(model) ?? { model, cells: 0, harness_errors: 0 };
    if (stop === 'harness_error') c.harness_errors++; else c.cells++;
    by.set(model, c);
  }
  return [...by.values()].sort((a, b) => a.model.localeCompare(b.model));
}

export function reuseVerdict(prior: ExperimentManifest, planned: ExperimentManifest, arm: string, cells: CellCount[]): Omit<ReuseVerdict, 'declared'> {
  const reasons: string[] = [];
  const gbrainArm = GBRAIN_ARMS.includes(arm);
  if (!gbrainArm && !BUILD_INDEPENDENT_ARMS.includes(arm)) reasons.push(`unknown arm ${arm}`);
  if (!prior.arms.includes(arm)) reasons.push(`the prior directory did not run ${arm} (it ran ${prior.arms.join(',')})`);
  if (!gbrainArm && planned.arms.includes(arm)) reasons.push(`the planned directory runs ${arm} itself`);
  if (!prior.hard && !planned.hard) reasons.push('not a Hard world: no evaluator code hashes to compare');
  if (prior.exploratory || planned.exploratory) reasons.push('an exploratory experiment is never reused or reused into');
  if (prior.world_digest !== planned.world_digest) reasons.push(`world_digest: prior ${prior.world_digest}, planned ${planned.world_digest}`);
  const hard = (m: ExperimentManifest) => (m.hard ? { ...m.hard, runner_commit: null } : null);
  if (!same(hard(prior), hard(planned))) {
    const p = hard(prior) as Record<string, unknown> | null, n = hard(planned) as Record<string, unknown> | null;
    const keys = [...new Set([...Object.keys(p ?? {}), ...Object.keys(n ?? {})])].filter(k => !same(p?.[k], n?.[k]));
    reasons.push(`hard: ${p && n ? keys.join(', ') : 'present on one side only'} differ`);
  }
  if (gbrainArm) {
    for (const k of ['gbrain_commit', 'slot_commit', 'label'] as const) if (prior[k] !== planned[k]) reasons.push(`${k}: prior ${prior[k]}, planned ${planned[k]}`);
  }
  const relevant = (flags: Record<string, string | true>) => Object.fromEntries(Object.entries(flags)
    .filter(([k]) => !RUN_CONTROL_FLAGS.has(k) && (gbrainArm || !GBRAIN_FLAGS.has(k))).sort(([a], [b]) => a.localeCompare(b)));
  const pf = relevant(prior.flags), nf = relevant(planned.flags);
  for (const k of [...new Set([...Object.keys(pf), ...Object.keys(nf)])].sort()) {
    if (!same(pf[k], nf[k])) reasons.push(`flag ${k}: prior ${JSON.stringify(pf[k] ?? null)}, planned ${JSON.stringify(nf[k] ?? null)}`);
  }
  const missing = planned.models.filter(m => !prior.models.includes(m));
  if (missing.length) reasons.push(`planned models not in the prior run: ${missing.join(', ')}`);
  const used = cells.filter(c => planned.models.includes(c.model));
  for (const m of planned.models.filter(m => prior.models.includes(m) && !used.some(c => c.model === m))) reasons.push(`no cells for ${m}`);
  for (const c of used) if (c.harness_errors) reasons.push(`${c.model}: ${c.harness_errors} cells end in a harness error`);
  if (new Set(used.map(c => c.cells)).size > 1) reasons.push(`unequal cell counts per model (${used.map(c => `${c.model} ${c.cells}`).join(', ')}): the prior run is partial`);
  return { arm, reusable: reasons.length === 0, reasons, models: planned.models, cells: used };
}

/** The preregistration names the prior budget run id and the arm on one line. */
export function declared(prereg: string, prior: ExperimentManifest, arm: string): boolean {
  const ids = [prior.budget_run_id, ...(prior.budget_runs ?? [])].filter((x): x is string => !!x);
  const armWord = new RegExp(`(^|[^\\w-])${arm.replace(/[-]/g, '\\-')}([^\\w-]|$)`);
  return ids.length > 0 && prereg.split('\n').some(line => ids.some(id => line.includes(id)) && armWord.test(line));
}

export interface Receipt { mode?: string; complete?: boolean; resumed?: boolean; cells_planned?: number; evals_dirty?: boolean | null; gbrain?: Record<string, unknown> | null }

/** The cell-running receipts of a run directory, oldest first: each invocation (a resume included) writes one. */
export function readReceipts(dir: string): Receipt[] {
  const names = existsSync(dir) ? readdirSync(dir).filter(n => /^receipt-\d+\.json$/.test(n)) : [];
  return names.sort((a, b) => Number(a.slice(8, -5)) - Number(b.slice(8, -5)))
    .map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Receipt).filter(r => r.mode !== 'build-slots');
}

const CELL_ENTRY = 'eval/runner/cat40-model-ladder.ts';

/** Blob id of every file in the runner's relative-import closure at a commit, or null when the commit isn't here. */
export function cellCode(commit: string, cwd = process.cwd()): Map<string, string> | null {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { git('cat-file', '-e', `${commit}^{commit}`); } catch { return null; }
  const blobs = new Map<string, string>();
  const queue = [CELL_ENTRY];
  while (queue.length) {
    const file = queue.pop()!;
    if (blobs.has(file)) continue;
    let id: string;
    try { id = git('rev-parse', `${commit}:${file}`).trim(); } catch { blobs.set(file, 'missing'); continue; }
    blobs.set(file, id);
    for (const m of git('cat-file', 'blob', id).matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(posix.normalize(posix.join(dirname(file), m[1]!)));
  }
  return blobs;
}

const GBRAIN_RECEIPT_KEYS = ['instructions_override', 'tool_overrides', 'served_instructions_sha256', 'config', 'build_config', 'surface', 'advertised_surface', 'keyless_slots'];

/** What the manifests can't show: whether the prior run finished, the gbrain override contents, and the runner code. */
export function provenanceReasons(o: { prior: ExperimentManifest; planned: ExperimentManifest; arm: string; cells: CellCount[]; priorReceipts: Receipt[]; plannedReceipts: Receipt[]; code: (commit: string) => Map<string, string> | null }): string[] {
  const reasons: string[] = [];
  const { prior, planned } = o;
  const first = o.priorReceipts[0], last = o.priorReceipts.at(-1), plannedLast = o.plannedReceipts.at(-1);
  if (!last) reasons.push('the prior directory has no receipt, so the run never finished');
  else if (last.complete !== true) reasons.push('the prior run did not finish (its latest receipt says complete: false)');
  if (!plannedLast) reasons.push('the planned directory has no receipt yet: check after its first arm finishes');
  if ([...o.priorReceipts, ...o.plannedReceipts].some(r => r.evals_dirty !== false)) reasons.push('a run recorded a dirty or unknown evals checkout (evals_dirty), so the code it ran is not its runner commit');
  if (first && !first.resumed && prior.arms.length === 1) {
    const total = o.cells.reduce((n, c) => n + c.cells, 0);
    if (total !== first.cells_planned) reasons.push(`the prior directory has ${total} canonical cells of the ${first.cells_planned} its first receipt planned`);
  }
  if (GBRAIN_ARMS.includes(o.arm)) {
    if (!last?.gbrain || !plannedLast?.gbrain) reasons.push('a gbrain arm needs both receipts to compare its override contents');
    else for (const k of GBRAIN_RECEIPT_KEYS) if (!same(last.gbrain[k] ?? null, plannedLast.gbrain[k] ?? null)) reasons.push(`gbrain receipt ${k} differs`);
  }
  const commits = (m: ExperimentManifest) => [...new Set([...(m.runner_commits ?? []), m.hard?.runner_commit ?? null])];
  const before = commits(prior), after = commits(planned);
  if ([...before, ...after].some(c => !c)) reasons.push('a runner commit is not recorded, so the cell code cannot be compared');
  else for (const a of before) for (const b of after) {
    if (a === b) continue;
    const ca = o.code(a!), cb = o.code(b!);
    if (!ca || !cb) { reasons.push(`runner commit ${ca ? b : a} is not in this checkout (fetch it to compare the cell code)`); continue; }
    const changed = [...new Set([...ca.keys(), ...cb.keys()])].filter(f => ca.get(f) !== cb.get(f)).sort();
    if (changed.length) reasons.push(`cell code differs between runner commits ${a!.slice(0, 12)} and ${b!.slice(0, 12)}: ${changed.join(', ')}`);
  }
  return reasons;
}

const armLabel = (m: ExperimentManifest, arm: string) => (arm === 'gbrain' ? m.label : arm === 'gbrain-fs' ? `${m.label}+fs` : arm);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); const v = i >= 0 ? argv[i + 1] : undefined; return v?.startsWith('--') ? undefined : v; };
  const priorDir = get('--prior'), plannedDir = get('--planned'), arm = get('--arm'), preregPath = get('--preregistration');
  if (!priorDir || !plannedDir || !arm) {
    console.error('usage: bun eval/runner/cat40/reuse-check.ts --prior <dir> --planned <dir> --arm <arm> [--preregistration <file>] [--json]');
    process.exit(2);
  }
  const read = (d: string) => {
    try { return JSON.parse(readFileSync(join(d, 'experiment.json'), 'utf8')) as ExperimentManifest; } catch (e) {
      console.error(`cannot read ${join(d, 'experiment.json')}: ${(e as Error).message}`);
      process.exit(2);
    }
  };
  const prior = read(priorDir), planned = read(plannedDir);
  const resultsPath = join(priorDir, 'results.jsonl');
  const cells = existsSync(resultsPath) ? countCells(readFileSync(resultsPath, 'utf8').split('\n'), armLabel(prior, arm)) : [];
  const v = reuseVerdict(prior, planned, arm, cells);
  const isDeclared = preregPath ? declared(readFileSync(preregPath, 'utf8'), prior, arm) : null;
  const reasons = [...v.reasons, ...provenanceReasons({ prior, planned, arm, cells, priorReceipts: readReceipts(priorDir), plannedReceipts: readReceipts(plannedDir), code: c => cellCode(c) })];
  if (isDeclared === null) reasons.push('no --preregistration: the reuse must be declared there before any cell runs');
  if (isDeclared === false) reasons.push(`${preregPath} does not name budget run ${prior.budget_run_id} and arm ${arm} on one line`);
  const out: ReuseVerdict = { ...v, reusable: reasons.length === 0, reasons, declared: isDeclared };
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${arm} from ${priorDir}: ${out.reusable ? 'reusable' : 'refused'}${out.cells.length ? ` (${out.cells.map(c => `${c.model} ${c.cells}`).join(', ')} cells)` : ''}`);
    for (const r of out.reasons) console.log(`  - ${r}`);
  }
  process.exit(out.reusable ? 0 : 1);
}

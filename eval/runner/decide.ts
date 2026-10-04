/**
 * eval:decide — held-out decision kit for gbrain feature plans.
 *
 *   bun run eval:decide <command> [flags]
 *
 * Dev workflow (milestone M1, open to every plan author):
 *   init       write a decision spec from a plan template; baseline defaults to the candidate checkout's origin/master
 *   fetch      download and SHA-check the datasets a spec (or one benchmark) needs
 *   preflight  check datasets, keys, budget, overlay builds and dirty checkouts before spending anything
 *   dev        run baseline and candidate on dev splits (each arm in its own process, bound to its gbrain build)
 *   verdict    paired, clustered comparison per source (stats/gates.ts); dev verdicts never flip a default
 *   status     what has run, what is missing, and what to do next
 *   check      validate a spec
 *
 * Held-out confirmation (custodian only; later milestones): power, prereg, request, seal-run, revalidate.
 *
 * Every refusal prints an operator message (code, what happened, why, the
 * exact next command, a read-only verify command); `--json` prints it as JSON.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decideError, DecideError, exitCodeFor, renderOperatorMessage, type OperatorMessage } from './decisions/errors.ts';
import { loadSpec, newSpec, validateSpec, type ArmSpec, type CategorySource, type DecisionSpec, type MemoryQaSource, type Plan, type Source, type VerdictType } from './decisions/spec.ts';
import { evaluateFamily, type ComparisonFamily, type FamilyDecision } from './stats/gates.ts';
import { getPath, loadRows, type Row } from './stats/rows.ts';
import { DATASET_ROOT, fetchDataset, filesFor } from './memory-qa/corpus.ts';
import { parseGbrainSpec, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { BudgetRun, budgetOptionsFrom, ledgerStatus } from './budget-ledger.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const DECIDE = ['bun', 'run', 'eval:decide'];

function flag(argv: string[], name: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

function decisionPath(argv: string[]): string {
  const d = flag(argv, '--decision');
  if (!d) throw decideError({ code: 'SPEC_MISSING', message: '--decision <dir or decision.json> is required', why: 'every command after init works on one decision spec',
    fix: { next: 'run', argv: [...DECIDE, 'init', '--plan', '<P1..P8>', '--gbrain', '<checkout>@<candidate-sha>'] } });
  return d.endsWith('.json') ? resolve(d) : resolve(d, 'decision.json');
}

const runsDir = (specPath: string, argv: string[]) => resolve(flag(argv, '--output') ?? join(dirname(specPath), 'runs'));

/** Pin `<checkout>@<ref>` to `<checkout>@<full sha>` so overlays never chase a moving branch. */
export function pinArm(spec: string): { pinned: string; commit: string; dirty: boolean } {
  const { checkout, ref } = parseGbrainSpec(spec);
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '';
  return { pinned: `${checkout}@${commit}`, commit, dirty };
}

// ─── init ───────────────────────────────────────────────────────────

function cmdInit(argv: string[]): string {
  const fixture = argv.includes('--fixture');
  const plan = (flag(argv, '--plan') ?? (fixture ? 'other' : '')) as Plan;
  if (!['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P0', 'other'].includes(plan)) {
    throw decideError({ code: 'SPEC_INVALID', message: '--plan must be one of P1..P8 (or --fixture for the keyless walkthrough)', why: 'the plan picks the dev sources template',
      fix: { next: 'run', argv: [...DECIDE, 'init', '--plan', 'P6', '--gbrain', '../gbrain@<candidate-sha>'] } });
  }
  const cand = flag(argv, '--gbrain');
  let candidate: string | null = null;
  let baseline: string | null = null;
  const notes: string[] = [];
  if (cand) {
    const c = pinArm(cand);
    candidate = c.pinned;
    if (c.dirty) notes.push(`candidate checkout has uncommitted changes; only commit ${c.commit.slice(0, 12)} is measured`);
    const { checkout } = parseGbrainSpec(cand);
    const b = pinArm(flag(argv, '--baseline') ?? `${checkout}@origin/master`);
    baseline = b.pinned;
  } else if (!fixture) {
    throw decideError({ code: 'SPEC_INVALID', message: '--gbrain <checkout>@<candidate-ref> is required (or --fixture)', why: 'a decision compares a candidate build against a baseline build',
      fix: { next: 'run', argv: [...DECIDE, 'init', '--plan', plan, '--gbrain', '../gbrain@HEAD'] } });
  }
  const id = flag(argv, '--id') ?? `${plan.toLowerCase()}-${fixture ? 'fixture' : 'dev'}-${new Date().toISOString().slice(0, 10)}`;
  const spec = newSpec({
    decisionId: id, plan, title: flag(argv, '--title') ?? `${plan} dev comparison`, verdictType: (flag(argv, '--type') ?? 'quality') as VerdictType,
    candidate, baseline, fixture, budgetUsd: flag(argv, '--budget-usd') ? Number(flag(argv, '--budget-usd')) : undefined,
  });
  const out = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/decisions', id));
  mkdirSync(out, { recursive: true });
  const path = join(out, 'decision.json');
  writeFileSync(path, JSON.stringify(spec, null, 2) + '\n');
  const lines = [
    `wrote ${path}`,
    `  plan ${plan}, verdict type ${spec.verdict_type}, ${spec.sources.length} sources: ${spec.sources.map(s => s.id).join(', ')}`,
    `  candidate ${spec.candidate.gbrain ?? 'pinned dependency'}`,
    `  baseline  ${spec.baseline.gbrain ?? 'pinned dependency'}`,
    ...notes.map(n => `  note: ${n}`),
    `  budget estimate $${spec.budget_usd} (both arms; real embeddings, cached across arms)`,
    'next:',
    `  edit ${path}: set candidate.config to your feature flags, keep or trim the sources, set comparisons`,
    `  ${[...DECIDE, 'fetch', '--decision', out].join(' ')}`,
    `  ${[...DECIDE, 'preflight', '--decision', out].join(' ')}`,
    `  ${[...DECIDE, 'dev', '--decision', out, ...(spec.sources.some(needsMoney) ? ['--paid', '--budget-usd', String(spec.budget_usd)] : [])].join(' ')}`,
    `  ${[...DECIDE, 'verdict', '--decision', out].join(' ')}`,
    'When the dev verdict is in, commit decision.json to your gbrain PR under docs/eval/decisions/<id>/ and report to the custodian; sealed data opens only there.',
  ];
  return lines.join('\n');
}

const needsMoney = (s: Source) => (s.kind === 'memory-qa' ? s.embed === 'real' || !!s.qa || !!s.facts : s.paid);

// ─── fetch / preflight ─────────────────────────────────────────────

async function cmdFetch(argv: string[]): Promise<string> {
  const bench = flag(argv, '--benchmark');
  const benches = bench ? [bench] : [...new Set(loadSpec(decisionPath(argv)).sources.filter((s): s is MemoryQaSource => s.kind === 'memory-qa').map(s => s.benchmark))];
  const out: string[] = [];
  for (const b of benches) {
    const r = await fetchDataset(b, { force: argv.includes('--force'), verifyOnly: argv.includes('--verify-only') });
    out.push(`${b}: ${r.verified} file(s) verified${r.fetched ? `, ${r.fetched} downloaded` : ''} under ${DATASET_ROOT}`);
  }
  return out.join('\n') || 'nothing to fetch';
}

function cmdPreflight(argv: string[]): string {
  const specPath = decisionPath(argv);
  const spec = loadSpec(specPath);
  const lines: string[] = [`decision ${spec.decision_id} (${spec.plan}, ${spec.verdict_type})`];
  const problems: OperatorMessage[] = [];
  for (const [side, arm] of [['baseline', spec.baseline], ['candidate', spec.candidate]] as const) {
    if (!arm.gbrain) { lines.push(`  ${side}: pinned dependency`); continue; }
    const { checkout, ref } = parseGbrainSpec(arm.gbrain);
    try {
      const gut = resolveGbrainUnderTest(arm.gbrain);
      lines.push(`  ${side}: ${checkout} @ ${ref.slice(0, 12)} → overlay ${gut.root} (v${gut.version}${gut.overlay?.checkout_dirty ? ', checkout has uncommitted edits that are NOT measured' : ''})`);
    } catch (e) {
      problems.push({ code: 'OVERLAY_FAILED', message: `${side} overlay for ${arm.gbrain} failed: ${(e as Error).message}`, why: 'each arm runs a verified copy of one commit',
        fix: { next: 'run', argv: ['rm', '-rf', join(REPO_ROOT, '.gbrain-overlays')], verify: [...DECIDE, 'preflight', '--decision', dirname(specPath)] } });
    }
  }
  for (const s of spec.sources) {
    if (s.kind === 'memory-qa') {
      const missing = filesFor(s.benchmark).filter(f => !existsSync(join(DATASET_ROOT, f.path)));
      lines.push(`  source ${s.id}: ${s.benchmark} dev, embed ${s.embed}${missing.length ? `, ${missing.length} dataset file(s) missing` : ', data present'}`);
      if (missing.length) problems.push({ code: 'DATASET_MISSING', message: `${s.benchmark}: ${missing.length} file(s) not downloaded`, why: 'runs read pinned local copies',
        fix: { next: 'run', argv: [...DECIDE, 'fetch', '--decision', dirname(specPath)], verify: [...DECIDE, 'fetch', '--decision', dirname(specPath), '--verify-only'] } });
      if (s.embed === 'real' && !process.env.OPENAI_API_KEY) problems.push({ code: 'PAID_FLAGS_MISSING', message: `${s.id} needs OPENAI_API_KEY for real embeddings`, why: 'the default embedder is openai:text-embedding-3-large at 1536 dims',
        fix: { next: 'ask_user', user_message: 'set OPENAI_API_KEY in this environment, or switch the source to embed "hash" for a plumbing-only run' } });
    } else {
      lines.push(`  source ${s.id}: category ${s.category} (${s.script})${s.paid ? ', paid' : ', keyless'}`);
      if (!existsSync(join(REPO_ROOT, s.script))) problems.push({ code: 'SPEC_INVALID', message: `${s.script} does not exist`, why: 'category sources run existing registry runners', fix: { next: 'run', argv: ['ls', 'eval/runner'] } });
    }
  }
  const money = spec.sources.filter(needsMoney);
  if (money.length) {
    const runId = flag(argv, '--budget-run-id');
    const st = ledgerStatus({ ledgerPath: budgetOptionsFrom(argv).ledgerPath, runId: runId ?? null });
    lines.push(`  budget: ${money.length} paid source(s), estimate $${spec.budget_usd}; ledger ${st.ledger} has ${st.totals.remaining_usd === null ? 'no program cap yet' : `$${st.totals.remaining_usd.toFixed(2)} left of $${st.totals.program_cap_usd?.toFixed(2)}`}`);
  }
  if (problems.length) throw new DecideError({ ...problems[0], message: `${problems.length} preflight problem(s); first: ${problems[0].message}`, state: { all: problems.map(p => p.message) } });
  lines.push(`ok — next: ${[...DECIDE, 'dev', '--decision', dirname(specPath), ...(money.length ? ['--paid', '--budget-usd', String(spec.budget_usd)] : [])].join(' ')}`);
  return lines.join('\n');
}

// ─── dev ────────────────────────────────────────────────────────────

interface Job { source: Source; arm: 'baseline' | 'candidate'; shard: number; shards: number; argv: string[]; out: string; env?: Record<string, string> }

function armArgs(arm: ArmSpec): string[] {
  return [...(arm.gbrain ? ['--gbrain', arm.gbrain] : []), ...Object.entries(arm.config).flatMap(([k, v]) => ['--config', `${k}=${v}`])];
}

export function planJobs(spec: DecisionSpec, runs: string, opts: { shards: number; only: string | null; budgetRunId: string | null }): Job[] {
  const jobs: Job[] = [];
  for (const s of spec.sources) {
    if (opts.only && s.id !== opts.only) continue;
    for (const arm of ['baseline', 'candidate'] as const) {
      const a = spec[arm];
      const paidFlags = needsMoney(s) && opts.budgetRunId ? ['--paid', '--budget-run-id', opts.budgetRunId] : [];
      if (s.kind === 'memory-qa') {
        const shards = s.benchmark === 'fixture' ? 1 : opts.shards;
        for (let i = 0; i < shards; i++) {
          const out = join(runs, s.id, arm, `shard-${i}`);
          jobs.push({ source: s, arm, shard: i, shards, out, argv: ['eval/runner/memory-qa/run.ts', '--benchmark', s.benchmark, '--split', 'dev', '--embed', s.embed,
            ...armArgs(a), ...Object.entries(s.search_pins).flatMap(([k, v]) => ['--pin', `${k}=${v}`]), '--top-k', String(s.top_k), '--seed', String(spec.seed),
            ...(s.limit ? ['--limit', String(s.limit)] : []), ...(s.categories?.length ? ['--categories', s.categories.join(',')] : []),
            ...(s.qa ? ['--qa', s.qa.mode, '--qa-runs', String(s.qa.runs), '--qa-sessions', String(s.qa.sessions), ...(s.qa.reader ? ['--reader', s.qa.reader] : []), ...(s.qa.judge ? ['--judge', s.qa.judge] : []),
              ...(s.qa.think_model ? ['--think-model', s.qa.think_model] : []), ...(s.qa.budget_tokens ? ['--qa-budget-tokens', String(s.qa.budget_tokens)] : []),
              ...(s.qa.context ? ['--qa-context', s.qa.context] : [])] : []), ...(s.facts ? ['--facts', s.facts] : []),
            '--shard', `${i}/${shards}`, '--output', out, ...paidFlags] });
        }
      } else {
        const out = join(runs, s.id, arm);
        const searchPins = Object.entries(a.config).filter(([k]) => k.startsWith('search.'));
        const other = Object.keys(a.config).filter(k => !k.startsWith('search.'));
        if (other.length) process.stderr.write(`[decide] note: ${s.id} cannot apply ${other.join(', ')} to the ${arm} build; category runners take search.* pins only (GBRAIN_EVAL_SEARCH_PINS)\n`);
        jobs.push({ source: s, arm, shard: 0, shards: 1, out, argv: [s.script, ...s.args, ...(a.gbrain ? ['--gbrain', a.gbrain] : []), '--output', out, ...paidFlags],
          env: { GBRAIN_EVAL_SEARCH_PINS: searchPins.map(([k, v]) => `${k}=${v}`).join(',') } });
      }
    }
  }
  return jobs;
}

function runJob(job: Job): Promise<{ job: Job; code: number; tail: string }> {
  mkdirSync(job.out, { recursive: true });
  return new Promise(res => {
    const child = spawn('bun', job.argv, { cwd: REPO_ROOT, env: { ...process.env, ...(job.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('close', code => {
      writeFileSync(join(job.out, 'process.log'), tail);
      res({ job, code: code ?? 1, tail });
    });
  });
}

async function cmdDev(argv: string[]): Promise<string> {
  const specPath = decisionPath(argv);
  const spec = loadSpec(specPath);
  const runs = runsDir(specPath, argv);
  const only = flag(argv, '--only') ?? null;
  const money = spec.sources.filter(s => (!only || s.id === only) && needsMoney(s));
  let budgetRunId = flag(argv, '--budget-run-id') ?? null;
  let opened: BudgetRun | null = null;
  if (money.length && !budgetRunId) {
    if (!argv.includes('--paid') || !flag(argv, '--budget-usd')) {
      throw decideError({ code: 'PAID_FLAGS_MISSING', message: `${money.map(s => s.id).join(', ')} spend money (estimate $${spec.budget_usd})`,
        why: 'paid sources run only under an explicit budget recorded in the ledger', fix: { next: 'run', argv: [...DECIDE, 'dev', '--decision', dirname(specPath), '--paid', '--budget-usd', String(spec.budget_usd)] } });
    }
    const estimate = money.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0);
    try {
      opened = BudgetRun.open({ runner: `decide:${spec.decision_id}`, budgetUsd: Number(flag(argv, '--budget-usd')), estimateUsd: estimate, ledgerPath: budgetOptionsFrom(argv).ledgerPath });
    } catch (e) {
      throw decideError({ code: 'BUDGET_CAP', message: (e as Error).message, why: 'the ledger reserves the estimate before any paid request; it never opens a run that cannot cover it',
        fix: { next: 'run', argv: [...DECIDE, 'dev', '--decision', dirname(specPath), ...(only ? ['--only', only] : []), '--paid', '--budget-usd', String(Math.ceil(estimate))], verify: ['bun', 'eval/runner/budget-ledger.ts', 'status'] } });
    }
    budgetRunId = opened.runId;
    process.stderr.write(`[decide] opened budget run ${budgetRunId} ($${flag(argv, '--budget-usd')})\n`);
  } else if (money.length && !argv.includes('--paid')) {
    throw decideError({ code: 'PAID_FLAGS_MISSING', message: 'paid sources need --paid with --budget-run-id', why: 'an inherited run id must never turn on spending by itself',
      fix: { next: 'run', argv: [...DECIDE, 'dev', '--decision', dirname(specPath), '--paid', '--budget-run-id', budgetRunId!] } });
  }
  // Build both overlays here, one at a time, so parallel arm processes reuse them instead of racing.
  for (const arm of [spec.baseline, spec.candidate]) if (arm.gbrain) resolveGbrainUnderTest(arm.gbrain);
  const jobs = planJobs(spec, runs, { shards: Number(flag(argv, '--shards') ?? 1), only, budgetRunId });
  const parallel = Math.max(1, Number(flag(argv, '--jobs') ?? 4));
  const results: Array<{ job: Job; code: number; tail: string }> = [];
  // Category runners may bind fixed local ports (N1), so they run one at a time; memory-qa arms run in parallel.
  const queue = jobs.filter(j => j.source.kind === 'memory-qa');
  const serial = jobs.filter(j => j.source.kind === 'category');
  const lanes = [
    ...Array.from({ length: Math.max(1, Math.min(parallel - (serial.length ? 1 : 0), queue.length)) }, () => queue),
    ...(serial.length ? [serial] : []),
  ];
  await Promise.all(lanes.map(async lane => {
    for (let job = lane.shift(); job; job = lane.shift()) {
      process.stderr.write(`[decide] start ${job.source.id} ${job.arm}${job.shards > 1 ? ` shard ${job.shard}/${job.shards}` : ''}\n`);
      const r = await runJob(job);
      process.stderr.write(`[decide] done  ${job.source.id} ${job.arm}${job.shards > 1 ? ` shard ${job.shard}` : ''}: exit ${r.code}\n`);
      results.push(r);
    }
  }));
  if (opened) opened.close({ finish: true });
  writeFileSync(join(runs, 'dev-run.json'), JSON.stringify({ decision_id: spec.decision_id, finished_at: new Date().toISOString(), budget_run_id: budgetRunId,
    jobs: results.map(r => ({ source: r.job.source.id, arm: r.job.arm, shard: r.job.shard, exit: r.code, out: r.job.out })) }, null, 2));
  const failed = results.filter(r => r.code !== 0 && !(r.job.source.kind === 'category' && r.code === 1));
  const lines = results.map(r => `  ${r.job.source.id} ${r.job.arm}${r.job.shards > 1 ? `#${r.job.shard}` : ''}: exit ${r.code}`);
  if (failed.length) {
    throw decideError({ code: 'ARM_FAILED', message: `${failed.length} of ${results.length} arm process(es) failed; first: ${failed[0].job.source.id} ${failed[0].job.arm}: ${failed[0].tail.trim().split('\n').slice(-3).join(' | ')}`,
      why: 'a verdict needs complete rows from both arms', artifact: join(failed[0].job.out, 'process.log'),
      fix: { next: 'run', argv: [...DECIDE, 'dev', '--decision', dirname(specPath), '--only', failed[0].job.source.id, ...(budgetRunId ? ['--paid', '--budget-run-id', budgetRunId] : [])] },
      state: { budget_run_id: budgetRunId } });
  }
  return [`dev runs complete under ${runs}`, ...lines, `next: ${[...DECIDE, 'verdict', '--decision', dirname(specPath)].join(' ')}`].join('\n');
}

// ─── verdict ────────────────────────────────────────────────────────

function composeId(row: Row, src: Source): string {
  if (src.id_fields?.length) return src.id_fields.map(f => String(getPath(row, f))).join('|');
  return String(getPath(row, src.id_field ?? 'id'));
}

export function loadArmRows(runs: string, src: Source, arm: 'baseline' | 'candidate'): { rows: Row[]; receipts: Array<Record<string, unknown>> } {
  const dir = join(runs, src.id, arm);
  if (!existsSync(dir)) throw decideError({ code: 'ROWS_MISSING', message: `no ${arm} run for ${src.id} under ${dir}`, why: 'the verdict pairs rows from both arms',
    fix: { next: 'run', argv: [...DECIDE, 'dev', '--decision', dirname(runs), '--only', src.id] } });
  const receipts: Array<Record<string, unknown>> = [];
  let rows: Row[] = [];
  if (src.kind === 'memory-qa') {
    for (const shard of readdirSync(dir).filter(d => d.startsWith('shard-')).sort()) {
      const r = join(dir, shard, 'receipt.json');
      if (!existsSync(r)) throw decideError({ code: 'ROWS_MISSING', message: `${src.id} ${arm} ${shard} has no receipt (the arm did not finish)`, why: 'partial arms are never paired',
        artifact: join(dir, shard, 'process.log'), fix: { next: 'run', argv: [...DECIDE, 'dev', '--decision', dirname(runs), '--only', src.id] } });
      receipts.push(JSON.parse(readFileSync(r, 'utf8')));
      rows = rows.concat(loadRows(join(dir, shard, 'rows.ndjson'), { idField: 'id' }).rows);
    }
  } else {
    const r = join(dir, 'receipt.json');
    if (!existsSync(r)) throw decideError({ code: 'ROWS_MISSING', message: `${src.id} ${arm} wrote no receipt.json`, why: 'category runners write their receipt to --output',
      artifact: join(dir, 'process.log'), fix: { next: 'run', argv: [...DECIDE, 'dev', '--decision', dirname(runs), '--only', src.id] } });
    receipts.push(JSON.parse(readFileSync(r, 'utf8')));
    if (src.rows_path) rows = loadRows(r, { idField: src.id_fields?.[0] ?? src.id_field ?? 'id', rowsPath: src.rows_path }).rows;
  }
  const derive = src.kind === 'category' ? src.derive ?? [] : [];
  return {
    rows: rows.map(row => {
      const out: Row = { ...row, __id: composeId(row, src) };
      for (const d of derive) { const v = getPath(row, d.from); if (v !== undefined) out[d.field] = v === d.equals ? 1 : 0; }
      return out;
    }),
    receipts,
  };
}

function checkContract(receipt: Record<string, unknown>, c: NonNullable<CategorySource['contracts']>[number]): boolean {
  const v = getPath(receipt, c.path);
  if (c.op === 'eq') return v === c.value;
  if (typeof v !== 'number' || typeof c.value !== 'number') return false;
  return c.op === 'lte' ? v <= c.value : v >= c.value;
}

export interface SourceVerdict {
  source: string;
  verdict: FamilyDecision['verdict'] | 'invalid';
  family?: FamilyDecision;
  contracts?: Array<{ path: string; op: string; value: unknown; candidate: unknown; baseline: unknown; ok: boolean }>;
  invalid_reasons?: string[];
  arms: Record<string, unknown>;
}

export function sourceVerdict(spec: DecisionSpec, runs: string, src: Source): SourceVerdict {
  const base = loadArmRows(runs, src, 'baseline');
  const cand = loadArmRows(runs, src, 'candidate');
  const invalid = [...base.receipts, ...cand.receipts].flatMap(r => (r.run_status === 'invalid' ? (r.invalid_reasons as string[] ?? ['run marked invalid']) : []));
  const arms = { baseline: base.receipts.map(r => r.product ?? r.gbrain_version ?? null)[0], candidate: cand.receipts.map(r => r.product ?? r.gbrain_version ?? null)[0] };
  if (invalid.length) return { source: src.id, verdict: 'invalid', invalid_reasons: invalid, arms };
  const out: SourceVerdict = { source: src.id, verdict: 'report_only', arms };
  if (src.comparisons.length) {
    const family: ComparisonFamily = { schema_version: 1, family_id: `${spec.decision_id}:${src.id}`, registered_at: spec.created_at, alpha: spec.alpha, seed: spec.seed, draws: spec.draws,
      min_clusters: src.min_clusters, id_field: '__id', exclude_when: src.exclude_when, comparisons: src.comparisons };
    out.family = evaluateFamily(base.rows, cand.rows, family);
    out.verdict = out.family.verdict;
  }
  if (src.kind === 'category' && src.contracts?.length) {
    out.contracts = src.contracts.map(c => ({ path: c.path, op: c.op, value: c.value, candidate: getPath(cand.receipts[0], c.path), baseline: getPath(base.receipts[0], c.path), ok: checkContract(cand.receipts[0], c) }));
    if (out.contracts.some(c => !c.ok)) out.verdict = 'fail';
    else if (out.verdict === 'report_only') out.verdict = 'pass';
  }
  return out;
}

export function combine(verdicts: SourceVerdict[]): SourceVerdict['verdict'] {
  if (verdicts.some(v => v.verdict === 'invalid')) return 'invalid';
  if (verdicts.some(v => v.verdict === 'blocked')) return 'blocked';
  if (verdicts.some(v => v.verdict === 'fail')) return 'fail';
  if (verdicts.some(v => v.verdict === 'inconclusive')) return 'inconclusive';
  if (verdicts.every(v => v.verdict === 'report_only')) return 'report_only';
  return 'pass';
}

function fmt(n: number | undefined | null, d = 4) { return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : 'n/a'; }

function cmdVerdict(argv: string[]): { text: string; json: unknown } {
  const specPath = decisionPath(argv);
  const spec = loadSpec(specPath);
  const runs = runsDir(specPath, argv);
  const verdicts = spec.sources.filter(s => !flag(argv, '--only') || s.id === flag(argv, '--only')).map(s => sourceVerdict(spec, runs, s));
  const overall = combine(verdicts);
  const result = { decision_id: spec.decision_id, plan: spec.plan, stage: 'dev', eligible_for_default: false,
    eligibility_note: 'Dev verdicts come from development data and never set a default. A held-out verdict comes from the custodian after a committed preregistration.',
    verdict_type: spec.verdict_type, overall, decided_at: new Date().toISOString(), sources: verdicts };
  writeFileSync(join(runs, 'verdict.json'), JSON.stringify(result, null, 2) + '\n');
  const lines = [`dev verdict for ${spec.decision_id}: ${overall.toUpperCase()} (development data; not eligible to set a default)`];
  for (const v of verdicts) {
    lines.push(`  ${v.source}: ${v.verdict}`);
    for (const c of v.family?.comparisons ?? []) {
      const s = c.stats;
      lines.push(`    ${c.id} [${c.gate}] ${c.status}: A ${fmt(s?.mean_a)} → B ${fmt(s?.mean_b)} (Δ ${fmt(s?.delta)}, 95% CI ${s?.ci95 ? `[${fmt(s.ci95[0])}, ${fmt(s.ci95[1])}]` : 'n/a'}, n ${c.n_pairs ?? 0}, clusters ${c.n_clusters ?? 0})${c.reasons.length ? ` — ${c.reasons[c.reasons.length - 1]}` : ''}`);
    }
    for (const c of v.contracts ?? []) lines.push(`    contract ${c.path} ${c.op} ${JSON.stringify(c.value)}: candidate ${JSON.stringify(c.candidate)}, baseline ${JSON.stringify(c.baseline)} → ${c.ok ? 'ok' : 'FAIL'}`);
    for (const r of v.invalid_reasons ?? []) lines.push(`    invalid: ${r}`);
  }
  lines.push(`verdict file: ${join(runs, 'verdict.json')}`);
  if (overall === 'invalid') lines.push('next: fix the environment the invalid reasons name and rerun `dev` for those sources; an invalid run is a harness problem, not a product result');
  else lines.push(`next: if the dev result supports the plan, freeze the build, commit decision.json and verdict.json under docs/eval/decisions/${spec.decision_id}/ in your gbrain PR, and report to the custodian for the held-out run`);
  return { text: lines.join('\n'), json: result };
}

// ─── status / check / later milestones ─────────────────────────────

function cmdStatus(argv: string[]): string {
  const specPath = decisionPath(argv);
  const spec = loadSpec(specPath);
  const runs = runsDir(specPath, argv);
  const lines = [`${spec.decision_id} (${spec.plan}, ${spec.verdict_type}) — runs under ${runs}`];
  for (const s of spec.sources) for (const arm of ['baseline', 'candidate'] as const) {
    const dir = join(runs, s.id, arm);
    const state = !existsSync(dir) ? 'not run' : s.kind === 'memory-qa'
      ? readdirSync(dir).filter(d => d.startsWith('shard-')).sort().map(d => existsSync(join(dir, d, 'receipt.json')) ? JSON.parse(readFileSync(join(dir, d, 'receipt.json'), 'utf8')).run_status : 'running or failed').join(',')
      : existsSync(join(dir, 'receipt.json')) ? 'receipt present' : 'running or failed';
    lines.push(`  ${s.id} ${arm}: ${state}`);
  }
  lines.push(existsSync(join(runs, 'verdict.json')) ? `  verdict: ${JSON.parse(readFileSync(join(runs, 'verdict.json'), 'utf8')).overall}` : '  verdict: not computed');
  return lines.join('\n');
}

const LATER: Record<string, string> = {
  power: 'M3 (full-verdict power simulation over dev discordance)',
  prereg: 'M3 (confirmation lock: harness SHA, prompts, power config, product configs)',
  request: 'M4 (held-out request to the custodian)',
  'seal-run': 'M4 (custodian-only held-out run)',
  revalidate: 'M4 (re-check a merged build on dev before its default flips)',
};

const HELP = `eval:decide — held-out decision kit

  init       --plan P1..P8 --gbrain <checkout>@<ref> [--baseline <checkout>@<ref>] [--type quality|cost|correctness] [--id <id>] [--out <dir>] | --fixture
  fetch      --decision <dir> | --benchmark locomo|lme-s|beam-100k|beam-500k|beam-1m  [--force] [--verify-only]
  preflight  --decision <dir> [--budget-run-id <id>]
  dev        --decision <dir> [--paid --budget-usd <n> | --paid --budget-run-id <id>] [--shards N] [--jobs N] [--only <source>] [--output <dir>]
  verdict    --decision <dir> [--only <source>] [--json]
  status     --decision <dir>
  check      --decision <dir>
  later milestones: power, prereg, request, seal-run, revalidate

Docs: docs/decisions.md`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  const say = (text: string, obj?: unknown) => process.stdout.write((json && obj !== undefined ? JSON.stringify(obj, null, 2) : text) + '\n');
  try {
    switch (cmd) {
      case undefined: case 'help': case '--help': case '-h': say(HELP); return 0;
      case 'init': say(cmdInit(rest)); return 0;
      case 'fetch': say(await cmdFetch(rest)); return 0;
      case 'preflight': say(cmdPreflight(rest)); return 0;
      case 'dev': say(await cmdDev(rest)); return 0;
      case 'verdict': { const v = cmdVerdict(rest); say(v.text, v.json); const o = (v.json as { overall: string }).overall; return o === 'invalid' ? 4 : o === 'fail' ? 1 : 0; }
      case 'status': say(cmdStatus(rest)); return 0;
      case 'check': { const s = loadSpec(decisionPath(rest)); validateSpec(s); say(`ok: ${s.decision_id} is a valid dev spec`); return 0; }
      default:
        if (LATER[cmd]) throw decideError({ code: 'NOT_YET_AVAILABLE', message: `\`${cmd}\` lands in milestone ${LATER[cmd]}`,
          why: 'held-out commands open sealed data and ship after the custodian tooling is in place', fix: { next: 'report', user_message: 'use dev runs now; report to the custodian (GBRA-49 P0) when your build is frozen' } });
        throw decideError({ code: 'SPEC_INVALID', message: `unknown command ${cmd}`, why: 'see the command list', fix: { next: 'run', argv: [...DECIDE, 'help'] } });
    }
  } catch (e) {
    if (e instanceof DecideError) {
      process.stderr.write((json ? JSON.stringify(e.op, null, 2) : renderOperatorMessage(e.op)) + '\n');
      return exitCodeFor(e.op);
    }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

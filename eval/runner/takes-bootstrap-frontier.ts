/**
 * W4 of the 2026-10 follow-up round: gbrain's takes-bootstrap classifier eval
 * on the four frontier models, through the priced harness overlay
 * (`eval/runner/takes-bootstrap/harness-overlay.mjs`).
 *
 *   route-check  one short gbrain `chat()` call per model through gbrain's own
 *                gateway, under the paid-request guard: proves gbrain's provider
 *                route accepts the model id before the run.
 *   run          attests the preregistration, opens one ledger budget run, and for
 *                each model reserves that model's whole harness cap, runs the
 *                overlay with that cap as --max-usd, and settles the reservation to
 *                the spend the harness's BudgetTracker reports. Writes predictions,
 *                summaries, harness stdout and a wrapper receipt.
 *   rescore      keyless and $0: re-scores every committed predictions file with
 *                gbrain's scorer and prints the label-independent verdict.
 *
 * The harness has its own BudgetTracker, so its requests do not pass through this
 * process's paid-request guard; the whole-cap reservation is what keeps the ledger
 * an upper bound while it runs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { attestPreregistration } from './prereg.ts';
import { BudgetRun, CHAT_PRICE_OVERRIDES, budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';

const REPO = resolve(import.meta.dir, '../..');
export const OVERLAY = join(REPO, 'eval/runner/takes-bootstrap/harness-overlay.mjs');
export const DEFAULT_GBRAIN_DIR = join(REPO, 'node_modules/gbrain');
export const PIN = 'c5fb0201d1960a0a5a81c35d77718311b03154b7';
export const FRONTIER_MODELS = ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-opus-5-5', 'anthropic:claude-fable-5-1'] as const;

export interface CapPlan { model: string; maxUsd: number | 'rest' }

/** Parse `model=usd` pairs; `rest` means whatever is left of the run budget when that model starts. */
export function parseCaps(raw: string): CapPlan[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const at = pair.lastIndexOf('=');
    if (at < 0) throw new Error(`--caps entry ${JSON.stringify(pair)} must be model=usd or model=rest`);
    const model = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (value === 'rest') return { model, maxUsd: 'rest' as const };
    const usd = Number(value);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error(`--caps ${model}: ${JSON.stringify(value)} is not a positive dollar amount`);
    return { model, maxUsd: usd };
  });
}

/** The cap a model runs under: its planned cap, or the budget still unspent when it is `rest`. Refuses past the budget. */
export function capFor(plan: CapPlan, budgetUsd: number, committedUsd: number, minimumUsd = 0): number {
  const left = budgetUsd - committedUsd;
  const cap = plan.maxUsd === 'rest' ? Math.floor(left * 100) / 100 : plan.maxUsd;
  if (cap > left + 1e-9) throw new Error(`${plan.model}: cap $${cap.toFixed(2)} exceeds the $${left.toFixed(2)} left of the $${budgetUsd} budget`);
  if (cap < minimumUsd) throw new Error(`${plan.model}: cap $${cap.toFixed(2)} is below its preregistered minimum $${minimumUsd.toFixed(2)}`);
  return cap;
}

/** Overlay price flags: the ledger's list price for models gbrain's built-in table can't price. */
export function priceFlags(model: string, builtinPriced: boolean): string[] {
  if (builtinPriced) return [];
  const price = CHAT_PRICE_OVERRIDES[model];
  if (!price) throw new Error(`${model} has no price in gbrain's table or the ledger's CHAT_PRICE_OVERRIDES; register it in eval/runner/budget-ledger.ts first`);
  return ['--price-input', String(price.input), '--price-output', String(price.output)];
}

export function slugFor(model: string): string {
  return model.replace(/^[a-z]+:/, '').replace(/[^a-z0-9.-]+/gi, '-');
}

/** Blob hashes of `paths` at `ref` in `repo` against the same files under `dir`: proves an installed tree is that commit. */
export function verifyTree(repo: string, ref: string, dir: string, paths: string[]): { ref: string; files: number; mismatched: string[]; missing: string[] } {
  const listing = execFileSync('git', ['-C', repo, 'ls-tree', '-r', ref, '--', ...paths], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n').filter(Boolean);
  const expected = listing.map(line => { const [meta, path] = line.split('\t'); return { path: path!, sha: meta!.split(' ')[2]! }; });
  const missing = expected.filter(e => !existsSync(join(dir, e.path))).map(e => e.path);
  const present = expected.filter(e => existsSync(join(dir, e.path)));
  const actual = present.length === 0 ? [] : execFileSync('git', ['hash-object', '--stdin-paths'], { input: present.map(e => join(dir, e.path)).join('\n'), encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n');
  const mismatched = present.filter((e, i) => actual[i] !== e.sha).map(e => e.path);
  return { ref, files: expected.length, mismatched, missing };
}

export interface LabelIndependentVerdict {
  model: string;
  cases: number;
  malformed: number;
  forbid_violations: number;
  pass: boolean;
}

/** The preregistered verdict: zero malformed cases and zero forbidden attributions. Per-kind bars stay provisional. */
export function labelIndependentVerdict(model: string, report: { malformed: string[]; forbid_violations: unknown[]; by_variant: unknown[] }): LabelIndependentVerdict {
  return { model, cases: report.by_variant.length, malformed: report.malformed.length, forbid_violations: report.forbid_violations.length,
    pass: report.malformed.length === 0 && report.forbid_violations.length === 0 };
}

export interface RequestStats { requests: number; non_ok: number; output_limit_finishes: number; cases_with_retries: number }

/** Counts from the overlay's request log: requests, non-2xx responses, output-limit finishes, cases sent more than once. */
export function requestStats(lines: Array<{ case: string | null; status: number; stop: string | null }>): RequestStats {
  const perCase = new Map<string, number>();
  for (const l of lines) if (l.case) perCase.set(l.case, (perCase.get(l.case) ?? 0) + 1);
  return {
    requests: lines.length,
    non_ok: lines.filter(l => l.status < 200 || l.status >= 300).length,
    output_limit_finishes: lines.filter(l => l.stop === 'max_tokens' || l.stop === 'max_output_tokens' || l.stop === 'length').length,
    cases_with_retries: [...perCase.values()].filter(n => n > 1).length,
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function routeCheck(argv: string[]): Promise<void> {
  const models = (flag(argv, '--models') ?? 'openai:gpt-6.1-sol,openai:gpt-6-luna').split(',');
  const out = flag(argv, '--out');
  const gbrainDir = resolve(flag(argv, '--gbrain-dir') ?? DEFAULT_GBRAIN_DIR);
  const options = budgetOptionsFrom(argv);
  const { run, guard } = startPaidRun('w4-gbrain-route-check', { ...options, estimateUsd: 0.01 * models.length });
  const { configureEvalGateway } = await import(join(gbrainDir, 'src/eval/shared/gateway-bootstrap.ts'));
  const { chat } = await import(join(gbrainDir, 'src/core/ai/gateway.ts'));
  configureEvalGateway({});
  const results: unknown[] = [];
  try {
    for (const model of models) {
      const started = Date.now();
      try {
        const res = await chat({ model, maxTokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
        results.push({ model, accepted: true, text: res.text, usage: res.usage ?? null, stop_reason: res.stopReason ?? null, ms: Date.now() - started });
      } catch (error) {
        results.push({ model, accepted: false, error: String((error as Error).message ?? error).slice(0, 500), ms: Date.now() - started });
      }
    }
  } finally {
    guard.uninstall();
  }
  const receipt = { kind: 'gbrain-route-check', gbrain_dir: relative(REPO, gbrainDir), results, cost: receiptCost(run.close()) };
  const text = JSON.stringify(receipt, null, 2) + '\n';
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text); }
  process.stdout.write(text);
}

async function runModels(argv: string[]): Promise<void> {
  const prereg = flag(argv, '--preregistration');
  const outDir = resolve(flag(argv, '--out-dir') ?? '');
  const caps = parseCaps(flag(argv, '--caps') ?? '');
  const minimums = Object.fromEntries(parseCaps(flag(argv, '--min-caps') ?? '').map(c => [c.model, c.maxUsd === 'rest' ? 0 : c.maxUsd]));
  const gbrainDir = resolve(flag(argv, '--gbrain-dir') ?? DEFAULT_GBRAIN_DIR);
  const gbrainRepo = flag(argv, '--gbrain-repo') ?? join(process.env.HOME ?? '', 'gbrain');
  if (!prereg || !flag(argv, '--out-dir') || caps.length === 0) throw new Error('run needs --preregistration <path> --out-dir <dir> --caps model=usd,...');
  const options = budgetOptionsFrom(argv);
  if (options.budgetUsd === null) throw new Error('run needs --budget-usd (the workstream cap) and --budget-ledger');
  const attestation = attestPreregistration(prereg, REPO);
  const tree = verifyTree(gbrainRepo, PIN, gbrainDir, ['src', 'evals/takes-bootstrap']);
  if (tree.mismatched.length || tree.missing.length) throw new Error(`gbrain tree at ${gbrainDir} differs from ${PIN}: ${[...tree.mismatched, ...tree.missing].slice(0, 5).join(', ')}`);
  const { canonicalLookup } = await import(join(gbrainDir, 'src/core/model-pricing.ts'));
  mkdirSync(outDir, { recursive: true });
  const run = BudgetRun.open({ runner: 'w4-takes-bootstrap-frontier', budgetUsd: options.budgetUsd, estimateUsd: Number(flag(argv, '--estimate-usd') ?? 4.2), ledgerPath: options.ledgerPath });
  const arms: unknown[] = [];
  let committed = 0;
  try {
    for (const plan of caps) {
      const maxUsd = capFor(plan, options.budgetUsd, committed, minimums[plan.model] ?? 0);
      const slug = slugFor(plan.model);
      const files = { predictions: join(outDir, `predictions-${slug}.jsonl`), summary: join(outDir, `summary-${slug}.json`), report: join(outDir, `report-${slug}.json`), log: join(outDir, `stderr-${slug}.log`), requests: join(outDir, `requests-${slug}.jsonl`) };
      const reservation = run.reserve(maxUsd, `takes-bootstrap harness ${plan.model} (whole --max-usd)`);
      const args = [OVERLAY, '--gbrain-dir', gbrainDir, '--model', plan.model, '--max-usd', String(maxUsd), '--out', files.predictions, '--summary', files.summary, '--request-log', files.requests,
        ...priceFlags(plan.model, Boolean(canonicalLookup(plan.model))), ...(flag(argv, '--max') ? ['--max', flag(argv, '--max')!] : [])];
      const started = Date.now();
      const child = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 << 20, env: process.env });
      const summary = existsSync(files.summary) ? JSON.parse(readFileSync(files.summary, 'utf8')) as { spent_usd: number } : null;
      const spent = summary?.spent_usd ?? maxUsd;
      run.settle(reservation, { usd: spent });
      committed += spent;
      writeFileSync(files.log, child.stderr ?? '');
      const jsonEnd = (child.stdout ?? '').lastIndexOf('\n}');
      const report = jsonEnd >= 0 ? JSON.parse(child.stdout.slice(0, jsonEnd + 2)) : null;
      if (report) writeFileSync(files.report, JSON.stringify(report, null, 2) + '\n');
      arms.push({ model: plan.model, max_usd: maxUsd, exit_code: child.status, wall_ms: Date.now() - started, settled_usd: spent,
        settled_from: summary ? 'harness BudgetTracker totalSpent' : 'no summary: charged at the whole cap',
        files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, existsSync(v) ? relative(REPO, v) : null])),
        request_stats: existsSync(files.requests) ? requestStats(readFileSync(files.requests, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))) : null,
        verdict: report ? labelIndependentVerdict(plan.model, report) : null, graduated: report?.graduated ?? null });
      process.stderr.write(`[w4] ${plan.model}: exit ${child.status}, $${spent.toFixed(4)} of $${maxUsd}\n`);
    }
  } finally {
    const cost = receiptCost(run.close());
    const receipt = { kind: 'w4-takes-bootstrap-frontier', smoke_max_cases: flag(argv, '--max') ? Number(flag(argv, '--max')) : null, preregistration_attestation: attestation, gbrain_pin: PIN, gbrain_dir: relative(REPO, gbrainDir), gbrain_tree_verified: tree,
      overlay: { path: relative(REPO, OVERLAY), upstream: 'evals/takes-bootstrap/harness.mjs', diff: 'eval/runner/takes-bootstrap/harness-overlay.diff' },
      arms, cost };
    writeFileSync(join(outDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
}

async function rescore(argv: string[]): Promise<void> {
  const dir = resolve(flag(argv, '--dir') ?? '');
  const gbrainDir = resolve(flag(argv, '--gbrain-dir') ?? DEFAULT_GBRAIN_DIR);
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as { arms: Array<{ model: string; files: { predictions: string | null } }> };
  const { scoreCorpus } = await import(join(gbrainDir, 'evals/takes-bootstrap/scorer.ts'));
  const corpus = readFileSync(join(gbrainDir, 'evals/takes-bootstrap/corpus.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const rows = receipt.arms.filter(a => a.files.predictions).map(a => {
    const predictions = readFileSync(join(REPO, a.files.predictions!), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const report = scoreCorpus(corpus, predictions);
    return { ...labelIndependentVerdict(a.model, report), variants_passed: report.by_variant.filter((v: { pass: boolean }) => v.pass).length,
      by_kind: report.by_kind.map((k: { kind: string; precision: number; recall: number; predicted: number; precise: number; expected: number; matched: number }) =>
        ({ kind: k.kind, predicted: k.predicted, precise: k.precise, expected: k.expected, matched: k.matched, precision: Number(k.precision.toFixed(3)), recall: Number(k.recall.toFixed(3)) })),
      graduated_provisional: report.graduated };
  });
  console.log(JSON.stringify(rows, null, 2));
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const commands: Record<string, (argv: string[]) => Promise<void>> = { 'route-check': routeCheck, run: runModels, rescore };
  const fn = command ? commands[command] : undefined;
  if (!fn) {
    console.error('usage: bun eval/runner/takes-bootstrap-frontier.ts route-check|run|rescore [flags]');
    process.exit(2);
  }
  fn(rest).catch(error => { console.error((error as Error).message); process.exit(1); });
}

/**
 * BrainBench Cat 34 — cross-harness memory conformance (the gbrain-repo
 * BrainBench suite, driven through its published foreign-runner contract).
 *
 * This runner does NOT import gbrain internals. It exercises the exact seam
 * any third party gets: the subprocess CLI contract
 *
 *   gbrain eval brainbench --fixtures DIR --gold DIR --json --out FILE
 *
 * documented in <gbrain>/evals/brainbench/schema/ (fixture/gold/result/baseline
 * JSON Schemas). What it grades: know-to-ask, push precision/recall,
 * write-back fidelity (production pipeline), cross-session continuity, and
 * source isolation — per harness seam (openclaw=production, claude-code and
 * codex=contract; see <gbrain>/docs/eval/BRAINBENCH.md for the disclosure).
 *
 * Hermetic: in-memory PGLite inside the subprocess, zero API keys, ~15s.
 *
 * Run:
 *   bun eval/runner/cat34-brainbench-memory.ts                 # gate-mode corpus
 *   bun eval/runner/cat34-brainbench-memory.ts --include-holdout   # published-run mode
 *
 * gbrain resolution: $GBRAIN_REPO (a checkout containing src/cli.ts +
 * evals/brainbench/), falling back to ../gbrain then ~/git/gbrain. Requires a
 * gbrain that ships `eval brainbench` (Cathedral 2, > v0.42.40.0).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

const REPORT_DIR = 'eval/reports/cat34-brainbench-memory';

interface ResultCell {
  harness: string;
  seam: string;
  suite: string;
  gold_total: number;
  gold_failed: number;
  metrics: Record<string, number>;
}
interface BrainBenchResultDoc {
  receipt: {
    result_schema_version: number;
    fixtures_hash: string;
    harness_sha: string;
    ts: string;
    include_holdout: boolean;
    llm: boolean;
  };
  cells: ResultCell[];
  seed_failures: Array<{ fixture_id: string; error: string }>;
}

function resolveGbrainRepo(): string {
  const candidates = [
    process.env.GBRAIN_REPO,
    resolve('..', 'gbrain'),
    join(homedir(), 'git', 'gbrain'),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (existsSync(join(c, 'src', 'cli.ts')) && existsSync(join(c, 'evals', 'brainbench', 'fixtures'))) {
      return c;
    }
  }
  throw new Error(
    'cat34: no gbrain checkout with BrainBench found. Set GBRAIN_REPO to a checkout ' +
      'carrying src/cli.ts + evals/brainbench/ (requires the Cathedral 2 release).',
  );
}

async function main(): Promise<number> {
  const includeHoldout = process.argv.includes('--include-holdout');
  const repo = resolveGbrainRepo();
  mkdirSync(REPORT_DIR, { recursive: true });
  const outFile = resolve(REPORT_DIR, 'result.json');

  const args = [
    'src/cli.ts', 'eval', 'brainbench',
    '--harness', 'all', '--suite', 'all',
    '--json', '--out', outFile,
    ...(includeHoldout ? ['--include-holdout'] : []),
  ];
  process.stderr.write(`[cat34] bun ${args.join(' ')}  (cwd ${repo})\n`);
  const proc = Bun.spawnSync(['bun', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = proc.exitCode ?? -1;
  if (!existsSync(outFile)) {
    process.stderr.write(`[cat34] no result artifact (exit ${exitCode}):\n${proc.stderr.toString().slice(-2000)}\n`);
    return 2;
  }
  const result = JSON.parse(readFileSync(outFile, 'utf-8')) as BrainBenchResultDoc;

  let gbrainVersion = 'unknown';
  try {
    gbrainVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8')).version ?? 'unknown';
  } catch {
    /* best-effort */
  }

  const receipt = {
    schema_version: 1,
    cat: 'cat34-brainbench-memory',
    gbrain_version: gbrainVersion,
    gbrain_sha: result.receipt.harness_sha,
    timestamp: new Date().toISOString(),
    fixtures_hash: result.receipt.fixtures_hash,
    include_holdout: result.receipt.include_holdout,
    llm: result.receipt.llm,
    exit_code: exitCode,
    seed_failures: result.seed_failures.length,
    cells: result.cells.map((c) => ({
      cell: `${c.harness}/${c.suite}`,
      seam: c.seam,
      gold_failed: c.gold_failed,
      gold_total: c.gold_total,
      metrics: c.metrics,
    })),
  };
  writeFileSync(join(REPORT_DIR, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

  const HEADLINE: Record<string, string> = {
    'know-to-ask': 'know_to_ask_failure_rate',
    push: 'push_recall',
    'write-back': 'write_back_fidelity',
    continuity: 'continuity_rate',
  };
  const lines: string[] = [
    '# Cat 34 — BrainBench memory conformance',
    '',
    `gbrain ${gbrainVersion} (\`${result.receipt.harness_sha.slice(0, 12)}\`) · fixtures \`${result.receipt.fixtures_hash.slice(0, 12)}\` · ${includeHoldout ? 'holdout INCLUDED' : 'gate mode'} · exit ${exitCode}`,
    '',
    '| harness | seam | suite | failed/gold | headline |',
    '|---|---|---|---|---|',
  ];
  for (const c of result.cells) {
    const h = HEADLINE[c.suite];
    const v = h && c.metrics[h] !== undefined ? `${h}=${c.metrics[h]}` : '—';
    lines.push(`| ${c.harness} | ${c.seam} | ${c.suite} | ${c.gold_failed}/${c.gold_total} | ${v} |`);
  }
  lines.push('');
  lines.push('Full per-turn rows in `result.json`; methodology: gbrain `docs/eval/BRAINBENCH.md`.');
  writeFileSync(join(REPORT_DIR, 'scorecard.md'), lines.join('\n') + '\n');
  process.stderr.write(`[cat34] receipt + scorecard → ${REPORT_DIR} (exit ${exitCode})\n`);
  return exitCode;
}

process.exit(await main());

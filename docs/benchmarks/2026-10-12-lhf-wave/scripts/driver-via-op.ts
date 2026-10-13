// One LongMemEval-S retrieval arm through gbrain's own harness (`gbrain eval longmemeval`), run from the gbrain
// checkout named by GBRAIN_SRC (the measured tree), with every paid request reserved and settled in the budget
// ledger before it leaves the process. The paid-request guard replaces globalThis.fetch before gbrain is imported,
// so OpenAI embeddings, Voyage rerank and Anthropic expansion calls all go through it; a request the ledger cannot
// price is refused, never sent.
// Usage: GBRAIN_SRC=<gbrain checkout> ARM=<label> OUT=<dir> bun driver-via-op.ts --budget-ledger <ledger>
//          --budget-usd <cap> -- <harness args...>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun } from '../../../../eval/runner/budget-ledger.ts';
import { attestPreregistration } from '../../../../eval/runner/prereg.ts';

const PREREG = 'docs/benchmarks/2026-10-12-lhf-wave-preregistration.md';

const split = process.argv.indexOf('--');
if (split < 0) throw new Error('usage: driver-via-op.ts <budget flags> -- <harness args...>');
const budgetArgs = process.argv.slice(2, split);
const harnessArgs = process.argv.slice(split + 1);
const src = process.env.GBRAIN_SRC;
const arm = process.env.ARM;
const out = process.env.OUT;
if (!src || !arm || !out) throw new Error('GBRAIN_SRC, ARM and OUT are required');
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync('git', ['-C', src, ...a], { encoding: 'utf8' }).trim();
const gbrain = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' };
// Every measured arm attests the committed, pushed preregistration; only a configuration smoke run may skip it.
const attestation = arm.startsWith('smoke') ? null : attestPreregistration(PREREG, join(import.meta.dir, '../../../..'));

const { run, guard } = startPaidRun(`lhf-wave-longmemeval-${arm}`, { ...budgetOptionsFrom(budgetArgs), estimateUsd: Number(process.env.ESTIMATE_USD ?? 'NaN') || null });
let code = 1;
try {
  const { runEvalLongMemEval } = await import(join(src, 'src/commands/eval-longmemeval.ts'));
  const { configureGateway } = await import(join(src, 'src/core/ai/gateway.ts'));
  const { buildGatewayConfig } = await import(join(src, 'src/core/ai/build-gateway-config.ts'));
  configureGateway(buildGatewayConfig({ embedding_model: process.env.GBRAIN_EMBEDDING_MODEL, embedding_dimensions: Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) } as never));
  await runEvalLongMemEval(harnessArgs, { exitOnError: false });
  code = 0;
} catch (e) {
  process.stderr.write(`[driver-via-op] ${(e as Error)?.message ?? e}\n`);
} finally {
  guard.uninstall();
  const summary = run.close();
  writeFileSync(join(out, 'cost.json'), JSON.stringify({ arm, run_id: run.runId, gbrain_src: src, gbrain, attestation, ...receiptCost(summary) }, null, 2) + '\n');
  process.stderr.write(`[driver-via-op] ${arm}: $${summary.actual_usd.toFixed(4)} over ${summary.requests} request(s); exhausted=${guard.exhausted}; exit ${code}\n`);
}
process.exit(code);

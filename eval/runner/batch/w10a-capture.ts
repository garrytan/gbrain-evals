#!/usr/bin/env bun
/**
 * W10a: run gbrain's own `eval longmemeval` at the pin with real release
 * retrieval and a stub reader that records each reader request and answers
 * with a placeholder (the method the 2026-09-29 R1 driver used). Retrieval
 * spend (embeddings, Voyage rerank) goes through the round's ledger under
 * W10a's budget run; any reader call to a provider is refused outright.
 *
 *   bun eval/runner/batch/w10a-capture.ts [--limit N] [--question-ids a,b]
 *
 * Writes captures and harness rows under $W10_STATE_DIR/w10a-capture/ and
 * resumes from the rows file.
 */
import { realFetch } from './real-fetch.ts';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceededError, installPaidRequestGuard, readLedger } from '../budget-ledger.ts';
import { configureGateway } from '../../../node_modules/gbrain/src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../../node_modules/gbrain/src/core/ai/build-gateway-config.ts';
import { runEvalLongMemEval } from '../../../node_modules/gbrain/src/commands/eval-longmemeval.ts';
import { captureClient } from './sources.ts';
import { attest, budgetRun, CAPTURE_PATH, DEFAULT_LEDGER, STATE_DIR } from './w10.ts';

export const W10A_ARGS = ['--top-k', '5', '--no-trajectory', '--mode', 'balanced', '--reranker', 'on', '--autocut', 'off',
  '--model', 'anthropic:claude-sonnet-5-5', '--reader-mode', 'notes', '--reader-max-tokens', '1024', '--yes'];

/** Refuse any reader or chat call: the capture must never pay for an answer. */
export function refuseReaderFetch(send: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { hostname, pathname } = new URL(url);
    if ((hostname === 'api.anthropic.com' && pathname.startsWith('/v1/messages')) || (hostname === 'api.openai.com' && /\/(chat\/completions|responses)$/.test(pathname))) {
      throw new BudgetExceededError(`W10a capture refused a reader call to ${url}: the stub reader must answer every question`);
    }
    return send(input, init);
  }) as typeof fetch;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dir = join(STATE_DIR, 'w10a-capture');
  mkdirSync(dir, { recursive: true });
  const attestation = attest('W10a');
  const run = budgetRun('W10a', DEFAULT_LEDGER);
  const guard = installPaidRequestGuard(run, { fetchImpl: refuseReaderFetch(realFetch) });
  process.env.GBRAIN_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
  process.env.GBRAIN_EMBEDDING_DIMENSIONS = '1536';
  configureGateway(buildGatewayConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 } as any));
  const dataset = process.env.LME_DATASET ?? join(homedir(), '.capy/work/lane-c/data/longmemeval_s_cleaned.json');
  const rows = join(dir, 'rows.ndjson');
  appendFileSync(rows, '');
  const started = new Date().toISOString();
  const args = [dataset, ...W10A_ARGS, '--embed-cache', join(homedir(), '.capy/work/lane-c/embed-cache.sqlite'), '--output', rows, '--resume-from', rows, ...argv];
  let code = 0;
  try {
    await runEvalLongMemEval(args, { client: captureClient(c => appendFileSync(CAPTURE_PATH, JSON.stringify({ ts: new Date().toISOString(), question: c.question, question_date: c.question_date, model: c.model, max_tokens: c.max_tokens, system: c.system, user: c.user }) + '\n')) as any, exitOnError: false });
  } catch (error) {
    code = 1;
    process.stderr.write(`[w10a-capture] ${(error as Error).message}\n`);
  } finally {
    guard.uninstall();
    const entries = readLedger(run.ledgerPath).entries.filter(e => e.run_id === run.runId && !e.description.startsWith('batch '));
    writeFileSync(join(dir, `capture-run-${started.replace(/[:.]/g, '-')}.json`), JSON.stringify({
      started, finished: new Date().toISOString(), args: args.map(a => a.replace(homedir(), '~')), exit: code, preregistration_attestation: attestation, budget_run: run.runId,
      retrieval_spend_usd: entries.reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0), retrieval_requests: entries.length,
    }, null, 1) + '\n');
  }
  process.exit(code);
}

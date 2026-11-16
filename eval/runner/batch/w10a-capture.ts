#!/usr/bin/env bun
/**
 * W10a: run gbrain's own `eval longmemeval` at the pin with real release
 * retrieval and a stub reader that records each reader request and answers
 * with a placeholder (the method the 2026-09-29 R1 driver used). Retrieval
 * spend (embeddings, Voyage rerank) goes through the round's ledger under
 * W10a's budget run; any reader call to a provider is refused outright.
 *
 *   bun eval/runner/batch/w10a-capture.ts [--limit N] [--question-ids a,b]
 *   bun eval/runner/batch/w10a-capture.ts --r3 --budget-ledger <ledger> --budget-run-id <id> --paid-window R3-A
 *
 * Writes captures and harness rows under $W10_STATE_DIR/w10a-capture/ and
 * resumes from the rows file. With --r3 (the W10 amendment of 2026-11-16) it
 * captures the same release retrieval at R3's frozen gbrain build instead: it
 * refuses unless node_modules/gbrain is a checkout at that sha, joins the R3
 * capture's own budget run, and writes under $W10_STATE_DIR/r3-capture/.
 */
import { realFetch } from './real-fetch.ts';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceededError, BudgetRun, installPaidRequestGuard, readLedger } from '../budget-ledger.ts';
import { configureGateway } from '../../../node_modules/gbrain/src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../../node_modules/gbrain/src/core/ai/build-gateway-config.ts';
import { runEvalLongMemEval } from '../../../node_modules/gbrain/src/commands/eval-longmemeval.ts';
import { captureClient } from './sources.ts';
import { assertR3Gbrain, attest, budgetRun, CAPTURE_PATH, DEFAULT_LEDGER, R3_CAPTURE_DIR, R3_UNITS, requireR3Window, STATE_DIR } from './w10.ts';

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

/** Pull a flag and its value out of the arguments passed through to gbrain's harness. */
function takeFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const r3 = argv.includes('--r3');
  if (r3) argv.splice(argv.indexOf('--r3'), 1);
  if (r3) requireR3Window(argv, R3_UNITS.capture);
  const window = takeFlag(argv, '--paid-window');
  const ledgerPath = takeFlag(argv, '--budget-ledger') ?? DEFAULT_LEDGER;
  const runId = takeFlag(argv, '--budget-run-id');
  const build = r3 ? assertR3Gbrain() : null;
  const dir = r3 ? R3_CAPTURE_DIR : join(STATE_DIR, 'w10a-capture');
  const capturePath = r3 ? join(R3_CAPTURE_DIR, 'captures.ndjson') : CAPTURE_PATH;
  mkdirSync(dir, { recursive: true });
  const attestation = attest(r3 ? 'R3' : 'W10a');
  if (r3 && !runId) throw new Error('--r3 joins the R3 capture budget run: pass --budget-run-id <id>');
  const run = r3 ? BudgetRun.join({ runId: runId!, ledgerPath }) : budgetRun('W10a', ledgerPath);
  const guard = installPaidRequestGuard(run, { fetchImpl: refuseReaderFetch(realFetch) });
  process.env.GBRAIN_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
  process.env.GBRAIN_EMBEDDING_DIMENSIONS = '1536';
  configureGateway(buildGatewayConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 } as any));
  const dataset = process.env.LME_DATASET ?? join(homedir(), '.capy/work/lane-c/data/longmemeval_s_cleaned.json');
  const rows = join(dir, 'rows.ndjson');
  appendFileSync(rows, '');
  const started = new Date().toISOString();
  const args = [dataset, ...W10A_ARGS, '--embed-cache', r3 ? join(dir, 'embed-cache.sqlite') : join(homedir(), '.capy/work/lane-c/embed-cache.sqlite'), '--output', rows, '--resume-from', rows, ...argv];
  let code = 0;
  try {
    await runEvalLongMemEval(args, { client: captureClient(c => appendFileSync(capturePath, JSON.stringify({ ts: new Date().toISOString(), question: c.question, question_date: c.question_date, model: c.model, max_tokens: c.max_tokens, system: c.system, user: c.user }) + '\n')) as any, exitOnError: false });
  } catch (error) {
    code = 1;
    process.stderr.write(`[w10a-capture] ${(error as Error).message}\n`);
  } finally {
    guard.uninstall();
    const entries = readLedger(run.ledgerPath).entries.filter(e => e.run_id === run.runId && !e.description.startsWith('batch '));
    writeFileSync(join(dir, `capture-run-${started.replace(/[:.]/g, '-')}.json`), JSON.stringify({
      started, finished: new Date().toISOString(), args: args.map(a => a.replace(homedir(), '~')), exit: code, preregistration_attestation: attestation, budget_run: run.runId,
      ...(build ? { gbrain: build, paid_window: window, retrieval_by_model: entries.reduce((m, e) => { const k = e.description.split(' ')[0]; m[k] = { usd: Number(((m[k]?.usd ?? 0) + (e.actual_usd ?? e.reserved_usd)).toFixed(6)), requests: (m[k]?.requests ?? 0) + 1 }; return m; }, {} as Record<string, { usd: number; requests: number }>) } : {}),
      retrieval_spend_usd: entries.reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0), retrieval_requests: entries.length,
    }, null, 1) + '\n');
  }
  process.exit(code);
}

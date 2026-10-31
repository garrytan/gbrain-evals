#!/usr/bin/env bun
/**
 * particle-1 weight canary: paid and opt-in.
 *
 *   bun scripts/particle-canary.ts --paid --budget-run-id <id> --out <run dir>
 *     [--compare <an earlier particle-canary.json>] [--warn-changed <answers>] [--warn-logprob <mean change>]
 *
 * Particle reported `metadata.weight_version` in 1 of 18 probe responses (2026-10-31), and then only the label
 * `default`, so receipts cannot show that the model behind `particle-1` changed. The canary sends 12 fixed short
 * prompts at effort `none` through the provider module's `canary` sampling mode (temperature 0, a fixed seed and
 * log probabilities, all listed as supported in Particle's /v1/models), output capped at 64 tokens, under the budget
 * ledger run named by --budget-run-id. It writes each answer's hash and its per-token top log probabilities, with one
 * usage receipt per attempt, to <run dir>/particle-canary.json: the calling run's own output directory.
 *
 * An answer counts only when it is non-empty and did not stop at the output limit, and its mean log probability only
 * when every token's is a finite number.
 *
 * With --compare (an earlier canary of the same model, base URL and sampling, kept outside --out) it reports how many
 * answers changed, how many came back with a different response model, system fingerprint, weight version or tier,
 * and the mean change in per-answer mean log probability. It warns above --warn-changed and --warn-logprob; those
 * thresholds are set above the largest difference seen between back-to-back canary pairs (serving noise), measured
 * before the first counted use. The curated history (docs/benchmarks/particle-canary/history.jsonl) is committed
 * with each report, never written here.
 *
 * It refuses a base URL the ledger cannot price (a request there would spend unmetered); loopback hosts (a metering
 * proxy, the keyless fake in eval/systems/_shim/fake_provider.py) go through. Cost: 12 requests of under 100 input
 * and at most 64 output tokens, well under a cent.
 *
 * Exit 0: every prompt answered and, with --compare, every prompt compared (warnings print above a threshold).
 * Exit 1: refused, a prompt failed after its retries or gave no usable answer, a budget stop (the ledger's, a proxy's
 * or Particle's credit) ended the canary, or --compare compared fewer than every prompt or, under --warn-logprob, had
 * no log probabilities to compare.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BudgetExceededError, budgetOptionsFrom, priceRequest, receiptCost, startPaidRun } from '../eval/runner/budget-ledger.ts';
import { requirePaidArm } from '../eval/runner/paid-arm.ts';
import { CompatHttpError, compatRequest, compatSend, type CanarySampling, type CompatLogprob, type CompatRequest } from '../eval/runner/providers/openai-compatible.ts';
import { normalizeFinish, normalizeUsage, receipt, responseMeta, usageSourceOf, type UsageReceipt } from '../eval/runner/usage-receipt.ts';

export const CANARY_MODEL = 'particle:particle-1';
export const CANARY_SAMPLING: CanarySampling = { mode: 'canary', temperature: 0, seed: 20261031, top_logprobs: 5 };
export const CANARY_ESTIMATE_USD = 0.01;
const ATTEMPTS = 3;

/** Short prompts with one expected answer each, so a changed answer or a moved log probability means a changed model or server. */
export const CANARY_PROMPTS = [
  'What is 17 multiplied by 23? Reply with the number only.',
  'What is the capital of Australia? Reply with one word.',
  'Spell the word "necessary" backwards.',
  'What is the chemical symbol for tungsten?',
  'Continue the sequence with the next number only: 2, 3, 5, 7, 11,',
  'Translate "good morning" into French.',
  'How many days are in a leap year? Reply with the number only.',
  'Sort these words alphabetically, comma-separated: pear, apple, mango, kiwi.',
  'What is the past tense of the verb "swim"?',
  'Convert 100 degrees Celsius to Fahrenheit. Reply with the number only.',
  'Which planet is closest to the Sun? Reply with one word.',
  'Name the author of "Pride and Prejudice".',
] as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface CanaryResult {
  id: string;
  prompt_sha256: string;
  status: 'ok' | 'error';
  answer: string;
  answer_sha256: string | null;
  finish: string | null;
  /** Mean per-token log probability of the answer; null without log probabilities. */
  mean_logprob: number | null;
  logprobs: CompatLogprob[] | null;
  response_model: string | null;
  weight_version: string | null;
  service_tier: string | null;
  system_fingerprint: string | null;
}

export interface CanaryRecord {
  schema: 'particle-canary/v1';
  at: string;
  model: string;
  base_url: string;
  prompts_sha256: string;
  sampling: CanarySampling;
  effort: string;
  max_output_tokens: number;
  results: CanaryResult[];
  receipts: UsageReceipt[];
  /** Set when a budget stop ended the canary early. */
  stopped: string | null;
}

/** The 12 canary requests as the provider module builds them. */
export function canaryRequests(env: Record<string, string | undefined> = process.env): CompatRequest[] {
  return CANARY_PROMPTS.map(p => compatRequest(CANARY_MODEL, [{ role: 'user', content: p }], { effort: 'none', sampling: CANARY_SAMPLING }, env));
}

/** Send the canary once per prompt (up to 3 attempts on a 429 or 5xx, honoring a capped Retry-After). A budget stop ends it after its receipt. */
export async function runCanary(env: Record<string, string | undefined> = process.env, opts: { retryDelayMs?: (attempt: number) => number } = {}): Promise<CanaryRecord> {
  const requests = canaryRequests(env);
  const { hostname } = new URL(requests[0]!.url);
  if (!/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(hostname) && !priceRequest(requests[0]!.url, requests[0]!.body)) {
    throw new BudgetExceededError(`budget: the ledger cannot price ${hostname}, so the canary would spend unmetered; register Particle's hosts and particle-1's price in eval/runner/budget-ledger.ts first`);
  }
  const results: CanaryResult[] = [];
  const receipts: UsageReceipt[] = [];
  let stopped: string | null = null;
  for (const [i, req] of requests.entries()) {
    const id = `c${String(i + 1).padStart(2, '0')}`;
    const base = { lane: 'particle-canary', role: 'reader' as const, question_id: id, replicate: 0, model: CANARY_MODEL, from_cache: false, delivered: null, request: req.sent };
    const failed = { id, prompt_sha256: sha256(CANARY_PROMPTS[i]!), status: 'error' as const, answer: '', answer_sha256: null, finish: null, mean_logprob: null, logprobs: null, response_model: null, weight_version: null, service_tier: null, system_fingerprint: null };
    let result: CanaryResult = failed;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const res = await compatSend(req);
        receipts.push(receipt({ ...base, attempt, response_model: res.response_model, status: 'ok', error: null, finish: normalizeFinish(res.finish), finish_raw: res.finish, answer: res.text,
          usage: normalizeUsage(usageSourceOf(CANARY_MODEL), res.usage), usage_raw: res.usage, response_meta: res.meta }));
        const lps = res.logprobs?.map(t => t.logprob) ?? [];
        const usable = res.text !== '' && res.finish !== 'length';
        result = { ...failed, status: usable ? 'ok' : 'error', answer: res.text, answer_sha256: usable ? sha256(res.text) : null, finish: res.finish,
          mean_logprob: lps.length && lps.every(Number.isFinite) ? lps.reduce((a, b) => a + b, 0) / lps.length : null, logprobs: res.logprobs,
          response_model: res.response_model, weight_version: res.meta.weight_version, service_tier: res.meta.service_tier, system_fingerprint: res.meta.system_fingerprint };
        break;
      } catch (e) {
        receipts.push(receipt({ ...base, attempt, response_model: null, status: 'error', error: (e as Error).message.slice(0, 300), finish: null, finish_raw: null, answer: '', usage: null, usage_raw: null, response_meta: responseMeta(null) }));
        if ((e as Error).name === 'BudgetExceededError') { stopped = (e as Error).message; break; }
        if (!(e instanceof CompatHttpError && e.retryable) || attempt === ATTEMPTS - 1) break;
        await Bun.sleep(e.retryAfterMs ?? (opts.retryDelayMs ?? (n => 2000 * 2 ** n))(attempt));
      }
    }
    results.push(result);
    if (stopped) break;
  }
  return {
    schema: 'particle-canary/v1', at: new Date().toISOString(), model: CANARY_MODEL, base_url: requests[0]!.url.replace(/\/chat\/completions$/, ''),
    prompts_sha256: sha256(JSON.stringify(CANARY_PROMPTS)), sampling: CANARY_SAMPLING, effort: 'none', max_output_tokens: requests[0]!.sent.output_limit, results, receipts, stopped,
  };
}

export interface CanaryDiff { compared: number; complete: boolean; changed_answers: number; changed_identity: number; mean_abs_logprob_change: number | null; max_abs_logprob_change: number | null }

type Comparable = Pick<CanaryRecord, 'model' | 'base_url' | 'sampling' | 'prompts_sha256' | 'results'>;

/**
 * Answers and mean log probabilities of two canaries of one model, endpoint, sampling and prompt set, prompt by
 * prompt. Only prompts both answered count; `complete` says whether that was every canary prompt.
 */
export function compareCanary(a: Comparable, b: Comparable): CanaryDiff {
  if (a.prompts_sha256 !== b.prompts_sha256) throw new Error('the two canaries sent different prompts; compare canaries of one prompt set');
  for (const k of ['model', 'base_url'] as const) {
    if (a[k] !== b[k]) throw new Error(`the two canaries differ in ${k} (${a[k]} and ${b[k]}); compare canaries of one model and endpoint`);
  }
  if (JSON.stringify(a.sampling) !== JSON.stringify(b.sampling)) throw new Error('the two canaries used different sampling; compare canaries of one sampling mode');
  const other = new Map(b.results.filter(r => r.status === 'ok').map(r => [r.id, r]));
  const pairs = a.results.filter(r => r.status === 'ok' && other.has(r.id)).map(r => [r, other.get(r.id)!] as const);
  const moves = pairs.filter(([x, y]) => x.mean_logprob !== null && y.mean_logprob !== null).map(([x, y]) => Math.abs(x.mean_logprob! - y.mean_logprob!));
  return {
    compared: pairs.length, complete: pairs.length === CANARY_PROMPTS.length, changed_answers: pairs.filter(([x, y]) => x.answer_sha256 !== y.answer_sha256).length,
    changed_identity: pairs.filter(([x, y]) => (['response_model', 'system_fingerprint', 'weight_version', 'service_tier'] as const).some(k => x[k] !== y[k])).length,
    mean_abs_logprob_change: moves.length ? moves.reduce((s, m) => s + m, 0) / moves.length : null, max_abs_logprob_change: moves.length ? Math.max(...moves) : null,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    requirePaidArm(argv, { arm: 'particle canary', estimateUsd: CANARY_ESTIMATE_USD });
    const out = flag('--out');
    if (!out) throw new Error('pass --out <run dir>: the canary writes particle-canary.json into the calling run\'s output directory');
    const compare = flag('--compare');
    if (compare && resolve(compare) === resolve(out, 'particle-canary.json')) throw new Error('--compare names the file this run writes; keep the baseline outside --out');
    const baseline: CanaryRecord | null = compare ? JSON.parse(readFileSync(compare, 'utf8')) : null;
    const { run, guard } = startPaidRun('particle-canary', { ...budgetOptionsFrom(argv), estimateUsd: CANARY_ESTIMATE_USD });
    let record: CanaryRecord;
    try { record = await runCanary(); }
    finally { guard.uninstall(); }
    const cost = receiptCost(run.close());
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'particle-canary.json'), JSON.stringify({ ...record, cost }, null, 2) + '\n');
    const answered = record.results.filter(r => r.status === 'ok').length;
    console.log(`particle canary: ${answered} of ${CANARY_PROMPTS.length} answered${record.stopped ? `; stopped: ${record.stopped}` : ''}; ${join(out, 'particle-canary.json')}`);
    let full = answered === CANARY_PROMPTS.length;
    if (baseline) {
      const diff = compareCanary(baseline, record);
      console.log(JSON.stringify(diff));
      const [changed, logprob] = [flag('--warn-changed'), flag('--warn-logprob')].map(v => (v === undefined ? null : Number(v)));
      if (changed !== null && diff.changed_answers > changed) console.log(`warning: ${diff.changed_answers} answers changed (threshold ${changed}): the model behind particle-1 may have changed`);
      if (diff.changed_identity > 0) console.log(`warning: ${diff.changed_identity} answers came back with a different response model, system fingerprint, weight version or service tier: the serving stack behind particle-1 changed`);
      if (logprob !== null && diff.mean_abs_logprob_change === null) {
        console.log('warning: no answer had log probabilities for every token in both canaries, so --warn-logprob checked nothing');
        full = false;
      } else if (logprob !== null && diff.mean_abs_logprob_change! > logprob) console.log(`warning: mean log probability moved ${diff.mean_abs_logprob_change} (threshold ${logprob}): the model behind particle-1 may have changed`);
      if (!diff.complete) {
        console.log(`warning: both canaries answered only ${diff.compared} of ${CANARY_PROMPTS.length} prompts, so this comparison is not a weight check`);
        full = false;
      }
    }
    process.exit(full ? 0 : 1);
  } catch (e) {
    console.error(`particle-canary: ${(e as Error).message}`);
    process.exit(1);
  }
}

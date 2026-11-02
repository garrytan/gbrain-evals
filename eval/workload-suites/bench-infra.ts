/**
 * Plumbing for the workload-suite bench: the metering proxy and budget run,
 * the Python bridge to the harness providers, and reader/judge model calls.
 *
 * Every paid request goes through the metering proxy against one ledger
 * (default `.budget/workload-suites.sqlite`, program cap $720): the
 * providers' own requests (gbrain embeddings and extraction, the
 * comparator's extraction) under labels `gbrain` and `comparator`, the
 * reader and judge under `reader` and `judge`. The bridge process and its
 * children only ever hold proxy tokens.
 *
 * Reader and judge calls go to Anthropic, OpenAI, or an OpenAI-compatible
 * provider in COMPAT_PROVIDERS (particle-1) through the provider module
 * (eval/runner/providers/openai-compatible.ts), and every provider attempt,
 * a failed one included, appends one usage receipt to
 * `<outDir>/attempts.ndjson`. A particle 429 or 5xx waits its Retry-After
 * (capped at 120 s) when it sends one. When Particle's prepaid credit runs out
 * (an HTTP 402 no proxy marked as its own), the call writes its receipt and
 * throws `ParticleCreditExhausted`, and every later reader or judge call of
 * the bench throws it without sending.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../runner/budget-ledger.ts';
import { UPSTREAM_DEADLINE_MS } from '../runner/metering-proxy.ts';
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR, REPO_ROOT, type HarnessInstall } from '../runner/harness-env.ts';
import type { GbrainUnderTest } from '../runner/gbrain-under-test.ts';
import { COMPAT_PROVIDERS, CompatHttpError, ParticleCreditExhausted, compatMayHaveBilled, compatRequest, compatSend, type CompatRequest, type CompatResponse } from '../runner/providers/openai-compatible.ts';
import { normalizeFinish, normalizeUsage, receipt, responseMeta, usageSourceOf, type ReceiptRequest, type ResponseMeta, type UsageReceipt } from '../runner/usage-receipt.ts';

export const DEFAULT_LEDGER = join(REPO_ROOT, '.budget/workload-suites.sqlite');
export const PROGRAM_CAP_USD = 720;

type Proxy = Awaited<ReturnType<typeof import('../runner/harness-metering-proxy.ts')['startMeteringProxy']>>;

export interface Bench {
  proxy: Proxy;
  run: BudgetRun;
  install: HarnessInstall;
  gut: GbrainUnderTest;
  stub: boolean;
  outDir: string;
  bridge(system: 'gbrain' | 'comparator', config: Record<string, unknown>, storeDir: string, gbrainCredentials?: string[], reset?: boolean): Promise<Bridge>;
  model(modelId: string, prompt: string, opts: { tag: string; maxTokens: number; cacheKey?: string }): Promise<ModelReply>;
  close(): { usd: number; requests: number; run_id: string };
}

/**
 * `finish_reason` is the provider's own; `truncated` marks an answer cut off at its output limit, which is still the
 * model's answer, and is null when unknown (a cached reply written before replies kept their finish reason).
 */
export interface ModelReply { text: string; input_tokens: number | null; output_tokens: number | null; cached: boolean; model: string; finish_reason: string | null; truncated: boolean | null; error?: string }

const pick = (env: Record<string, string>, keys: string[]) => Object.fromEntries(Object.entries(env).filter(([k]) => keys.some(p => k.toUpperCase().startsWith(p.toUpperCase()))));

export async function startBench(opts: { runner: string; budgetUsd: number; outDir: string; gut: GbrainUnderTest; stub?: boolean; ledgerPath?: string; gbrainBun?: string; log?: (l: string) => void }): Promise<Bench> {
  const log = opts.log ?? (l => process.stderr.write(l + '\n'));
  const stub = opts.stub ?? false;
  mkdirSync(opts.outDir, { recursive: true });
  const { startMeteringProxy } = await import('../runner/harness-metering-proxy.ts');
  let upstreams;
  let realKeys;
  let ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER;
  let stubServer: { close(): void } | null = null;
  if (stub) {
    const { startStubUpstream } = await import('../runner/stub-upstream.ts');
    const s = await startStubUpstream();
    stubServer = s;
    upstreams = s.upstreams;
    realKeys = Object.fromEntries(['openai', 'anthropic', 'gemini', 'groq', 'voyage'].map(p => [p, 'stub-upstream-key']));
    ledgerPath = join(opts.outDir, 'stub-ledger.sqlite');
  }
  if (!existsSync(ledgerPath)) initLedger({ ledgerPath, programCapUsd: stub ? 1000 : PROGRAM_CAP_USD, reason: stub ? 'keyless stub bench' : 'memory proof wave workload suites (B1-B4): proxy cap $720 (ledger line 4 minus B5)' });
  const run = BudgetRun.open({ runner: opts.runner, budgetUsd: opts.budgetUsd, ledgerPath, log });
  const proxyDir = join(opts.outDir, 'proxy');
  mkdirSync(proxyDir, { recursive: true });
  const proxy = await startMeteringProxy({
    run, cellId: opts.runner, requestLogPath: join(proxyDir, 'requests.jsonl'), bodiesDir: join(proxyDir, 'bodies'),
    labels: ['gbrain', 'comparator', 'reader', 'judge'], upstreams, realKeys,
  });
  const install = ensureHarness({ log });
  const bridges: Bridge[] = [];

  return {
    proxy, run, install, gut: opts.gut, stub, outDir: opts.outDir,
    async bridge(system, config, storeDir, gbrainCredentials = ['voyage'], reset = true) {
      const env = harnessProcessEnv(install, {
        MPW_GBRAIN_CLI: join(opts.gut.root, 'src/cli.ts'),
        MPW_BUN: opts.gbrainBun ?? process.env.WORKLOAD_GBRAIN_BUN ?? process.execPath,
        MPW_CHILD_ENV_GBRAIN: JSON.stringify(pick({ ...proxy.envFor('gbrain'), VOYAGE_BASE_URL: proxy.baseUrls.voyage }, gbrainCredentials)),
        MPW_CHILD_ENV_COMPARATOR: JSON.stringify(proxy.envFor('comparator')),
        MPW_REPO_ROOT: REPO_ROOT,
      });
      const b = new Bridge(install, env);
      bridges.push(b);
      await b.call('init', { system, config, store_dir: storeDir, reset });
      return b;
    },
    model: modelCaller(proxy, opts.outDir),
    close() {
      for (const b of bridges) b.kill();
      const summary = run.close();
      void proxy.close();
      stubServer?.close();
      closeLedgers();
      return { usd: summary.actual_usd, requests: summary.requests, run_id: summary.run_id };
    },
  };
}

/**
 * `Bench.model`: reader and judge calls through the proxy's `reader` and `judge` tokens, cached by prompt hash in
 * `<outDir>/model-cache`, one usage receipt per provider attempt in `<outDir>/attempts.ndjson`, and the credit stop.
 */
export function modelCaller(proxy: Pick<Proxy, 'envFor'>, outDir: string): Bench['model'] {
  const reader = proxy.envFor('reader');
  const judge = proxy.envFor('judge');
  const cacheDir = join(outDir, 'model-cache');
  mkdirSync(cacheDir, { recursive: true });
  const attempts = join(outDir, 'attempts.ndjson');
  let stopped: ParticleCreditExhausted | null = null;
  return async (modelId, prompt, o) => {
    if (stopped) throw stopped;
    const compat = COMPAT_PROVIDERS[modelId.slice(0, modelId.indexOf(':'))]?.models[modelId.slice(modelId.indexOf(':') + 1)];
    const effort = compat ? `\n${compat.default_effort}:${compat.efforts[compat.default_effort]}` : '';
    const key = createHash('sha256').update(`${modelId}\n${o.maxTokens}\n${o.cacheKey ?? ''}\n${prompt}${effort}`).digest('hex');
    const cachePath = join(cacheDir, `${key}.json`);
    if (existsSync(cachePath)) return { finish_reason: null, truncated: null, ...(JSON.parse(readFileSync(cachePath, 'utf8')) as Omit<ModelReply, 'finish_reason' | 'truncated'>), cached: true };
    const env = o.tag.includes('/judge/') ? judge : reader;
    let reply: ModelReply;
    try {
      reply = await callModel(env, modelId, prompt, o.tag, o.maxTokens, r => appendFileSync(attempts, JSON.stringify(r) + '\n'));
    } catch (error) {
      if (error instanceof ParticleCreditExhausted) stopped = error;
      throw error;
    }
    if (!reply.error) writeFileSync(cachePath, JSON.stringify(reply));
    return reply;
  };
}

/** A reply's finish reason as the provider sent it, and whether it stopped at the output limit. */
function finished(raw: unknown): Pick<ModelReply, 'finish_reason' | 'truncated'> {
  const finish_reason = typeof raw === 'string' ? raw : null;
  return { finish_reason, truncated: finish_reason === null ? null : normalizeFinish(finish_reason) === 'max_tokens' };
}

interface AttemptOutcome {
  error: string | null;
  response_model?: string | null;
  text?: string;
  finish?: string | null;
  usage?: unknown;
  /** Set for an OpenAI-compatible provider, whose receipts carry `request` and `response_meta`. */
  request?: ReceiptRequest;
  response_meta?: ResponseMeta;
}

/**
 * One reader or judge call through the proxy: Anthropic Messages, OpenAI Chat Completions, or Chat Completions to an
 * OpenAI-compatible provider in COMPAT_PROVIDERS, plain text out. Each provider attempt calls `onAttempt` with its
 * usage receipt (`question_id` is the call's tag); a failed attempt's response fields are null.
 */
export async function callModel(env: Record<string, string>, modelId: string, prompt: string, tag: string, maxTokens: number, onAttempt: (r: UsageReceipt) => void = () => {}, deadlineMs = UPSTREAM_DEADLINE_MS): Promise<ModelReply> {
  const [provider, model] = [modelId.slice(0, modelId.indexOf(':')), modelId.slice(modelId.indexOf(':') + 1)];
  const fail = (error: string): ModelReply => ({ text: '', input_tokens: null, output_tokens: null, cached: false, model: modelId, finish_reason: null, truncated: false, error });
  const note = (attempt: number, o: AttemptOutcome) => onAttempt(receipt({
    lane: 'workload-suites', role: tag.includes('/judge/') ? 'judge' : 'reader', question_id: tag, replicate: 0, attempt, model: modelId,
    response_model: o.response_model ?? null, status: o.error === null ? 'ok' : 'error', error: o.error, from_cache: false,
    finish: normalizeFinish(o.finish), finish_raw: o.finish ?? null, answer: o.text ?? '',
    usage: o.usage ? normalizeUsage(usageSourceOf(modelId), o.usage) : null, usage_raw: o.usage && typeof o.usage === 'object' ? o.usage as Record<string, unknown> : null, delivered: null,
    ...(o.request ? { request: o.request, response_meta: o.response_meta ?? responseMeta(null) } : {}),
  }));
  if (Object.hasOwn(COMPAT_PROVIDERS, provider)) return callCompat(modelId, prompt, tag, maxTokens, env, fail, note, deadlineMs);
  if (provider !== 'anthropic' && provider !== 'openai') return fail(`unsupported reader provider ${provider}`);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    let body: any;
    try {
      if (provider === 'anthropic') {
        res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'x-mpw-tag': tag },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        });
      } else {
        res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}`, 'x-mpw-tag': tag },
          body: JSON.stringify({ model, max_completion_tokens: maxTokens, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }] }),
        });
      }
      body = await res.json().catch(() => ({}));
    } catch (e) {
      note(attempt, { error: `network: ${(e as Error).message}` });
      if (attempt >= 4) return fail(`network: ${(e as Error).message}`);
      await Bun.sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.ok && provider === 'anthropic') {
      const text = (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      note(attempt, { error: null, response_model: typeof body.model === 'string' ? body.model : null, text, finish: body.stop_reason, usage: body.usage });
      return { text, input_tokens: body.usage?.input_tokens ?? null, output_tokens: body.usage?.output_tokens ?? null, cached: false, model: modelId, ...finished(body.stop_reason) };
    }
    if (res.ok) {
      const text = body.choices?.[0]?.message?.content ?? '';
      note(attempt, { error: null, response_model: typeof body.model === 'string' ? body.model : null, text, finish: body.choices?.[0]?.finish_reason, usage: body.usage });
      return { text, input_tokens: body.usage?.prompt_tokens ?? null, output_tokens: body.usage?.completion_tokens ?? null, cached: false, model: modelId, ...finished(body.choices?.[0]?.finish_reason) };
    }
    const msg = JSON.stringify(body).slice(0, 600);
    note(attempt, { error: `HTTP ${res.status}: ${msg}`, usage: body?.usage });
    if (res.status === 402) return fail(`budget refused: ${msg}`);
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await Bun.sleep(3000 * (attempt + 1)); continue; }
    return fail(`HTTP ${res.status}: ${msg}`);
  }
}

/**
 * The particle route: one `compatRequest` (effort `high`, the model's output floor at least), sent once per attempt
 * with `compatSend` under callModel's attempt limits. A 429 or 5xx waits its Retry-After (capped at 120 s) when it
 * sends one, else the same backoff as OpenAI; a proxy's 402 is a budget refusal; Particle's credit 402 throws
 * `ParticleCreditExhausted` after its receipt. A long reasoning answer gets the metering proxies' upstream deadline,
 * not Bun's 300-second fetch timeout. A request Particle may have billed (`compatMayHaveBilled`: it timed out, failed in
 * transport other than before any byte was sent, was answered 504, which the harness proxy sends when its upstream
 * request may have gone out before it failed, or was answered 2xx without a message) is never sent again (issues #282,
 * #288).
 */
async function callCompat(modelId: string, prompt: string, tag: string, maxTokens: number, env: Record<string, string>, fail: (error: string) => ModelReply, note: (attempt: number, o: AttemptOutcome) => void, deadlineMs: number): Promise<ModelReply> {
  let built: CompatRequest;
  try { built = compatRequest(modelId, [{ role: 'user', content: prompt }], { maxOutputTokens: maxTokens }, env); } catch (e) { return fail((e as Error).message); }
  const req: CompatRequest = { ...built, headers: { ...built.headers, 'x-mpw-tag': tag } };
  const count = (v: unknown) => (typeof v === 'number' ? v : null);
  for (let attempt = 0; ; attempt++) {
    let r: CompatResponse;
    try {
      r = await compatSend(req, { timeoutMs: deadlineMs });
    } catch (e) {
      const error = e as Error;
      const http = error instanceof CompatHttpError ? error : null;
      const budget = error.name === 'BudgetExceededError';
      const retry = !compatMayHaveBilled(error) && (http ? http.retryable && attempt < 5 : !budget && attempt < 4);
      const waitMs = http ? http.retryAfterMs ?? 3000 * (attempt + 1) : 2000 * (attempt + 1);
      const waitNote = retry ? `; retrying in ${waitMs} ms${http?.retryAfterMs != null ? ' (Retry-After)' : ''}` : '';
      note(attempt, { error: `${http || budget ? '' : 'network: '}${error.message}${waitNote}`, usage: http?.usage, request: req.sent });
      if (error instanceof ParticleCreditExhausted) throw error;
      if (retry) { await Bun.sleep(waitMs); continue; }
      return fail(budget ? `budget refused: ${(error as { body?: string }).body?.slice(0, 600) ?? error.message}` : http ? `HTTP ${http.status}: ${http.body.slice(0, 600)}` : `network: ${error.message}`);
    }
    note(attempt, { error: null, response_model: r.response_model, text: r.text, finish: r.finish, usage: r.usage, request: req.sent, response_meta: r.meta });
    return { text: r.text, input_tokens: count(r.usage?.prompt_tokens), output_tokens: count(r.usage?.completion_tokens), cached: false, model: modelId, ...finished(r.finish) };
  }
}

/** JSON-lines client for `python -m mpw_workload.bridge`. */
export class Bridge {
  #proc: ReturnType<typeof Bun.spawn>;
  #next = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #buffer = '';
  constructor(install: HarnessInstall, env: Record<string, string>) {
    this.#proc = Bun.spawn([install.python, '-m', 'mpw_workload.bridge'], { cwd: PROVIDER_DIR, env, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    void this.#read();
  }
  async #read() {
    const reader = (this.#proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.#buffer += dec.decode(value);
      let nl: number;
      while ((nl = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = this.#pending.get(msg.id);
        if (!p) continue;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error}\n${msg.trace ?? ''}`));
        else p.resolve(msg.result);
      }
    }
    for (const p of this.#pending.values()) p.reject(new Error('bridge exited'));
    this.#pending.clear();
  }
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const stdin = this.#proc.stdin as import('bun').FileSink;
      stdin.write(JSON.stringify({ id, method, params }) + '\n');
      stdin.flush();
    });
  }
  async close() { try { await this.call('close'); } catch { /* already gone */ } this.kill(); }
  kill() { try { this.#proc.kill(); } catch { /* gone */ } }
}

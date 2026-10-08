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
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../runner/budget-ledger.ts';
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR, REPO_ROOT, type HarnessInstall } from '../runner/harness-env.ts';
import type { GbrainUnderTest } from '../runner/gbrain-under-test.ts';

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

export interface ModelReply { text: string; input_tokens: number | null; output_tokens: number | null; cached: boolean; model: string; error?: string }

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
  const reader = proxy.envFor('reader');
  const judge = proxy.envFor('judge');
  const cacheDir = join(opts.outDir, 'model-cache');
  mkdirSync(cacheDir, { recursive: true });

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
    async model(modelId, prompt, o) {
      const key = createHash('sha256').update(`${modelId}\n${o.maxTokens}\n${o.cacheKey ?? ''}\n${prompt}`).digest('hex');
      const cachePath = join(cacheDir, `${key}.json`);
      if (existsSync(cachePath)) return { ...(JSON.parse(readFileSync(cachePath, 'utf8')) as ModelReply), cached: true };
      const env = o.tag.includes('/judge/') ? judge : reader;
      const reply = await callModel(env, modelId, prompt, o.tag, o.maxTokens);
      if (!reply.error) writeFileSync(cachePath, JSON.stringify(reply));
      return reply;
    },
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

/** One reader or judge call through the proxy. Anthropic Messages or OpenAI Chat Completions, plain text out. */
export async function callModel(env: Record<string, string>, modelId: string, prompt: string, tag: string, maxTokens: number): Promise<ModelReply> {
  const [provider, model] = [modelId.slice(0, modelId.indexOf(':')), modelId.slice(modelId.indexOf(':') + 1)];
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
        body = await res.json().catch(() => ({}));
        if (res.ok) {
          const text = (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
          return { text, input_tokens: body.usage?.input_tokens ?? null, output_tokens: body.usage?.output_tokens ?? null, cached: false, model: modelId };
        }
      } else if (provider === 'openai') {
        res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}`, 'x-mpw-tag': tag },
          body: JSON.stringify({ model, max_completion_tokens: maxTokens, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }] }),
        });
        body = await res.json().catch(() => ({}));
        if (res.ok) {
          const text = body.choices?.[0]?.message?.content ?? '';
          return { text, input_tokens: body.usage?.prompt_tokens ?? null, output_tokens: body.usage?.completion_tokens ?? null, cached: false, model: modelId };
        }
      } else {
        throw new Error(`unsupported reader provider ${provider}`);
      }
    } catch (e) {
      if (attempt >= 4) return { text: '', input_tokens: null, output_tokens: null, cached: false, model: modelId, error: `network: ${(e as Error).message}` };
      await Bun.sleep(2000 * (attempt + 1));
      continue;
    }
    const msg = JSON.stringify(body).slice(0, 600);
    if (res.status === 402) return { text: '', input_tokens: null, output_tokens: null, cached: false, model: modelId, error: `budget refused: ${msg}` };
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await Bun.sleep(3000 * (attempt + 1)); continue; }
    return { text: '', input_tokens: null, output_tokens: null, cached: false, model: modelId, error: `HTTP ${res.status}: ${msg}` };
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

#!/usr/bin/env bun
/**
 * lifecycle-lite: update and forget for the open-source memory shootout (P2,
 * docs/plans/2026-10-05-oss-memory-shootout/PLAN.md, phase 6). Report-only.
 *
 *   bun eval/runner/lifecycle-lite.ts --system <shim URL>|gbrain-shootout|fake|honest-reference|mutation:<kind>
 *     [--seeds 1,2,3,4,5] [--policy fixed-evidence|vendor-default] [--policy-setting key=value]...
 *     [--restart [--restart-cmd '<shell command>'] [--restart-timeout-s 900]]
 *     [--finish-timeout-s 600] [--ingest-timeout-s 3600]
 *     [--gbrain <checkout>@<ref>] [--embed hash|real] [--embedding-model openai:text-embedding-3-large]
 *     [--embedding-dims 1536] [--config key=value]... [--provider-proxy <metering proxy URL>]
 *     [--qa reader [--reader openai:gpt-4o-mini] [--judge openai:gpt-4o-2024-08-06] [--budget-tokens 8000]]
 *     [--paid --budget-run-id <id>] --output <dir>
 *
 * The seeded histories come from eval/generators/lifecycle-lite-gen.ts (N1
 * correction chains and N5 canaries). The runner core and its order of
 * operations are in eval/runner/lifecycle-lite/run.ts, the scorer in
 * lifecycle-lite/score.ts, the honest reference and the mutation fakes in
 * lifecycle-lite/fakes.ts.
 *
 * Restart keeps state. A shim restarts through `--restart-cmd` (on a cell VM:
 * `bash eval/systems/bootstrap.sh restart --system <name>`, which restarts the
 * containers and keeps their volumes), then the runner waits for /health.
 * In-process gbrain-shootout keeps its PGLite brain on disk for the run and
 * closes and reopens it. The in-process episodic fake has no state to keep
 * and refuses `--restart`; its Python twin keeps state with SHIM_STATE_FILE.
 *
 * Money: shims spend through their cell's metering proxy, never here. This
 * process spends only for gbrain-shootout (its reranker, and real embeddings)
 * and for the optional reader and judge: through `--provider-proxy` (default
 * SHOOTOUT_PROXY) on a cell, or with `--paid --budget-run-id` against the
 * budget ledger. Everything else runs hermetic (no provider key in the
 * process, fresh GBRAIN_HOME).
 */
import './budget-ledger.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLifecycleLiteWorld, LIFECYCLE_LITE_SEEDS, sanitizerCorpus } from '../generators/lifecycle-lite-gen.ts';
import { budgetOptionsFrom, startPaidRun, type BudgetRun, type PaidRequestGuard } from './budget-ledger.ts';
import { importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { DECIDE_OFF, enterHermeticEnv, type HermeticEnv } from './hermetic-env.ts';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';
import { DEFAULT_QA, runLifecycleLite, type Chat } from './lifecycle-lite/run.ts';
import { HonestReferenceSystem, isRestartable, mutationFake, MUTATION_FAKES, type MutationFake } from './lifecycle-lite/fakes.ts';
import { LIFECYCLE_LITE_CHECKS } from './lifecycle-lite/score.ts';
import { hashEmbed } from './memory-qa/run.ts';
import { ChatClient } from './memory-qa/qa.ts';
import { requirePaidArm } from './paid-arm.ts';
import { FakeMemorySystem } from './systems/fake.ts';
import { GbrainShootoutSystem, type GbrainModules } from './systems/gbrain.ts';
import { HttpMemorySystem } from './systems/http.ts';
import { forbiddenMarkers } from './systems/sanitize.ts';
import type { MemorySystem, RetrievalPolicy } from './systems/types.ts';

export interface LiteCliArgs {
  system: string;
  seeds: number[];
  policy: RetrievalPolicy['mode'];
  policySettings: Record<string, string>;
  restart: boolean;
  restartCmd: string | null;
  restartTimeoutS: number;
  finishTimeoutS: number;
  ingestTimeoutS: number;
  gbrain: string | null;
  embed: 'hash' | 'real';
  embeddingModel: string;
  embeddingDims: number;
  config: Record<string, string>;
  providerProxy: string | null;
  qa: { reader: string; judge: string; budgetTokens: number } | null;
  paid: boolean;
  output: string;
  argv: string[];
}

export function parseLiteArgs(argv: string[], env: Record<string, string | undefined> = process.env): LiteCliArgs {
  const all = (name: string) => argv.flatMap((a, i) => a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []);
  const one = (name: string) => all(name).at(-1);
  const pairs = (name: string) => Object.fromEntries(all(name).map(kv => { const i = kv.indexOf('='); if (i < 1) throw new Error(`${name} takes key=value (got ${kv})`); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const system = one('--system');
  const output = one('--output');
  if (!system) throw new Error('--system is required (a shim URL, gbrain-shootout, fake, honest-reference or mutation:<kind>)');
  if (!output) throw new Error('--output <dir> is required');
  const policy = (one('--policy') ?? 'fixed-evidence') as RetrievalPolicy['mode'];
  if (policy !== 'fixed-evidence' && policy !== 'vendor-default') throw new Error('--policy must be fixed-evidence or vendor-default');
  const embed = (one('--embed') ?? 'hash') as 'hash' | 'real';
  if (embed !== 'hash' && embed !== 'real') throw new Error('--embed must be hash or real');
  const qaMode = one('--qa');
  if (qaMode !== undefined && qaMode !== 'reader') throw new Error('--qa takes reader (the reading lane is off by default)');
  const seeds = (one('--seeds') ?? LIFECYCLE_LITE_SEEDS.join(',')).split(',').map(s => Number(s.trim()));
  if (!seeds.length || seeds.some(s => !Number.isInteger(s) || s < 1)) throw new Error('--seeds takes positive integers, comma separated');
  return {
    system, seeds, policy, policySettings: pairs('--policy-setting'),
    restart: argv.includes('--restart'), restartCmd: one('--restart-cmd') ?? null, restartTimeoutS: Number(one('--restart-timeout-s') ?? 900),
    finishTimeoutS: Number(one('--finish-timeout-s') ?? 600), ingestTimeoutS: Number(one('--ingest-timeout-s') ?? 3600),
    gbrain: one('--gbrain') ?? null, embed, embeddingModel: one('--embedding-model') ?? 'openai:text-embedding-3-large', embeddingDims: Number(one('--embedding-dims') ?? 1536),
    config: pairs('--config'), providerProxy: one('--provider-proxy') ?? env.SHOOTOUT_PROXY ?? null,
    qa: qaMode ? { reader: one('--reader') ?? DEFAULT_QA.reader, judge: one('--judge') ?? DEFAULT_QA.judge, budgetTokens: Number(one('--budget-tokens') ?? DEFAULT_QA.budgetTokens) } : null,
    paid: argv.includes('--paid'), output, argv,
  };
}

/** gbrain-shootout in process, the way memory-qa builds it: hash vectors (keyless) or real embeddings through the content-addressed cache. */
async function gbrainShootout(a: LiteCliArgs, databasePath: string): Promise<{ system: GbrainShootoutSystem; identity: Record<string, unknown> }> {
  const gut = resolveGbrainUnderTest(a.gbrain);
  const proxyUrls = a.providerProxy ? { base_urls: { voyage: `${a.providerProxy}/harness/voyage/v1` } } : {};
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
  let cache: EmbeddingCache | null = null;
  if (a.embed === 'hash') {
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'hash-embed-transport-no-provider-call';
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env, ...proxyUrls });
    gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbed(v, a.embeddingDims)), values: params.values, warnings: [], usage: { tokens: 0 } }));
  } else {
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env, ...proxyUrls });
    const { embedMany } = await import(Bun.resolveSync('ai', gut.root)) as { embedMany: (p: unknown) => Promise<unknown> };
    const cacheDir = process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache');
    mkdirSync(cacheDir, { recursive: true });
    const key = `${a.embeddingModel}@${a.embeddingDims}`;
    cache = new EmbeddingCache(join(cacheDir, `embed-cache-${key.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`), key);
    gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: { values: string[] } & Record<string, unknown>) => embedMany(p) as never, cache));
  }
  const mods: GbrainModules = {
    PGLiteEngine: (await importGbrain<{ PGLiteEngine: GbrainModules['PGLiteEngine'] }>(gut, 'src/core/pglite-engine.ts')).PGLiteEngine,
    importFromContent: (await importGbrain<{ importFromContent: GbrainModules['importFromContent'] }>(gut, 'src/core/import-file.ts')).importFromContent,
    hybridSearch: (await importGbrain<{ hybridSearch: GbrainModules['hybridSearch'] }>(gut, 'src/core/search/hybrid.ts')).hybridSearch,
  };
  const product = productIdentityFor(gut) as unknown as Record<string, unknown>;
  return {
    system: new GbrainShootoutSystem(mods, a.config, product, { databasePath }),
    identity: { gbrain: product, overlay: overlaySummary(gut), embedding: { mode: a.embed, model: a.embeddingModel, dims: a.embeddingDims }, config: a.config },
  };
}

async function waitHealthy(url: string, timeoutS: number): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    try { const h = await (await fetch(`${url.replace(/\/$/, '')}/health`, { keepalive: false })).json() as { ok?: boolean }; if (h.ok === true) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${url} did not report healthy within ${timeoutS}s after the restart`);
    await Bun.sleep(1000);
  }
}

export async function mainLifecycleLite(argv: string[]): Promise<number> {
  const a = parseLiteArgs(argv);
  const isUrl = /^https?:\/\//.test(a.system);
  const inProcessGbrain = a.system === 'gbrain-shootout';
  if (a.restart && isUrl && !a.restartCmd) throw new Error('--restart on a shim needs --restart-cmd (on a cell: bash eval/systems/bootstrap.sh restart --system <name>)');
  if (a.restartCmd && !a.restart) throw new Error('--restart-cmd needs --restart');
  if (a.system.startsWith('mutation:') && !MUTATION_FAKES.includes(a.system.slice(9) as MutationFake)) throw new Error(`mutation fakes: ${MUTATION_FAKES.join(', ')}`);
  if (a.providerProxy && !/^https?:\/\/[^/]+$/.test(a.providerProxy)) throw new Error('--provider-proxy must look like http://host:port');

  const spends = (inProcessGbrain || a.qa !== null) && !a.providerProxy;
  let hermetic: HermeticEnv | null = null;
  let paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  if (spends) {
    const worldsN = a.seeds.length;
    const estimate = Math.max(0.05, Math.round(((inProcessGbrain ? 0.05 : 0) + (a.qa ? 41 * 0.004 : 0)) * worldsN * 100) / 100);
    requirePaidArm(argv, { arm: 'lifecycle-lite', estimateUsd: estimate, ledgerPath: budgetOptionsFrom(argv).ledgerPath });
    paid = startPaidRun('lifecycle-lite', { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  } else {
    hermetic = enterHermeticEnv('lifecycle-lite');
  }
  if (a.providerProxy) {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) process.env[k] = 'dummy-key-the-proxy-replaces';
    process.env.OPENAI_BASE_URL = `${a.providerProxy}/harness/openai/v1`;
    process.env.ANTHROPIC_BASE_URL = `${a.providerProxy}/harness/anthropic`;
  }

  const worlds = a.seeds.map(seed => generateLifecycleLiteWorld({ seed }));
  const scratch = inProcessGbrain ? mkdtempSync(join(tmpdir(), 'lifecycle-lite-pglite-')) : null;
  let system: MemorySystem | null = null;
  let identity: Record<string, unknown> = { system: a.system };
  let restart: { run: () => Promise<void>; how: string } | null = null;
  try {
    if (isUrl) {
      const markers = forbiddenMarkers(sanitizerCorpus(worlds));
      const http = new HttpMemorySystem(a.system, { markers, ingestTimeoutMs: a.ingestTimeoutS * 1000 });
      const [health, cap] = await Promise.all([http.health(), http.capabilities()]);
      if (health.ok !== true) throw new Error(`${a.system} is not healthy: ${JSON.stringify(health).slice(0, 300)}`);
      const { service_ms: _ms, ...h } = health;
      identity = { system: cap.system, config: typeof h.config === 'string' ? h.config : null, versions: cap.versions ?? null, health: h };
      system = http;
      if (a.restart) {
        const cmd = a.restartCmd!;
        restart = {
          how: `shell: ${cmd}`,
          run: async () => {
            const proc = Bun.spawn(['bash', '-c', cmd], { stdout: 'inherit', stderr: 'inherit' });
            const code = await proc.exited;
            if (code !== 0) throw new Error(`restart command exited ${code}`);
            await waitHealthy(a.system, a.restartTimeoutS);
          },
        };
      }
    } else if (inProcessGbrain) {
      const g = await gbrainShootout(a, join(scratch!, 'brain.pglite'));
      system = g.system;
      identity = { system: 'gbrain-shootout', ...g.identity };
      if (a.restart) restart = { how: 'in-process: PGLite brain on disk closed and reopened', run: () => g.system.restart() };
    } else if (a.system === 'fake') {
      if (a.restart) throw new Error('the in-process fake keeps no state across a restart; use the Python fake shim with SHIM_STATE_FILE and --restart-cmd');
      system = new FakeMemorySystem();
    } else if (a.system === 'honest-reference' || a.system.startsWith('mutation:')) {
      const s = a.system === 'honest-reference' ? new HonestReferenceSystem() : mutationFake(a.system.slice(9) as MutationFake);
      system = s;
      if (a.restart && isRestartable(s)) restart = { how: 'in-process test fixture', run: () => s.restart() };
    } else throw new Error(`unknown --system ${a.system}`);

    const chat: Chat | null = a.qa ? (() => {
      const client = new ChatClient(process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));
      return (model, prompt, maxTokens) => client.chat(model, prompt, { maxTokens, replicate: 0 });
    })() : null;
    const { receipt } = await runLifecycleLite({
      system, worlds, output: a.output, policyMode: a.policy, policySettings: a.policySettings, restart, finishTimeoutS: a.finishTimeoutS,
      identity: { ...identity, hermetic: hermetic ? { decide: DECIDE_OFF } : null, metering: a.providerProxy ? { mode: 'lease-proxy', proxy: a.providerProxy, lease_id: process.env.SHOOTOUT_LEASE_ID ?? null } : { mode: paid ? 'budget-ledger' : 'none' } },
      qa: a.qa && chat ? { ...a.qa, chat } : null,
    });
    const m = receipt.metrics as import('./lifecycle-lite/score.ts').LiteMetrics;
    const c = receipt.checks as import('./lifecycle-lite/score.ts').LiteChecks;
    const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
    const out = [
      `lifecycle-lite ${receipt.run_status} (report-only): overall ${c.overall}${c.failed.length ? ` (${c.failed.join(', ')})` : ''}`,
      `  update     ${c.update}: ${m.update.correct} of ${m.update.probes} current-value probes correct; new value served ${m.update.gold_served}, a stale value active ${m.update.stale_active} (final checkpoint ${m.final_checkpoint})`,
      `  as-of      ${c.asof}: ${m.asof.correct} of ${m.asof.probes} dated probes correct; a later value active ${m.asof.future_active}`,
      `  forget     ${c.forget}: ${m.forget.forgotten} of ${m.forget.signal} witnessed delete targets gone (${m.forget.no_signal} never surfaced, not scored); deletes ${JSON.stringify(m.forget.deletes)}`,
      `  survivors  ${c.survivors}: retention ${pct(m.survivors.retention)} of ${m.survivors.witnessed} witnessed (floor ${pct(LIFECYCLE_LITE_CHECKS.survivor_floor)})`,
      `  restart    ${c.restart}: ${m.restart.ran ? `${m.restart.lost} lost, ${m.restart.reactivated} reactivated` : 'not run'}`,
      `  rows ${m.rows.total}: ${JSON.stringify(receipt.outcomes)}`,
      `  receipt ${join(a.output, 'receipt.json')}`,
    ];
    process.stderr.write(out.join('\n') + '\n');
    return receipt.run_status === 'invalid' ? 4 : 0;
  } finally {
    await system?.close?.();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (paid) { paid.run.close(); paid.guard.uninstall(); }
    hermetic?.restore();
  }
}

if (import.meta.main) {
  mainLifecycleLite(process.argv.slice(2)).then(code => process.exit(code), e => { process.stderr.write(`lifecycle-lite: ${(e as Error).message}\n`); process.exit(2); });
}

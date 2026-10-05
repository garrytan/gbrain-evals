#!/usr/bin/env bun
/**
 * Coding-agent memory spike over the harness's coding benchmark (dataset `sdebench`, mode `coding`).
 *
 * A coding agent (opencode in a Docker container) fixes a planted regression in a real
 * repository; pytest grades the patch in a second container, and failing output is fed back up to
 * five times. The spike runs a few tasks with no memory and with gbrain retrieval injected into the
 * task prompt. `mpw/cell.py` has no coding mode, so this launcher sets up what `harness:cell`
 * would: a budget run in the shared ledger, the metering proxy (labels `agent` and `gbrain`) and a
 * clean child environment, then starts `eval/harness-provider/coding-spike/spike.py`.
 *
 * The agent runs in Docker, which cannot reach the proxy's loopback address, so a TCP relay on the
 * Docker bridge gateway forwards to it; the agent image (coding-spike/Dockerfile.agent) points
 * opencode's Gemini base URL at the relay and the container receives only a proxy token.
 *
 *   bun eval/runner/coding-spike.ts --tasks boltons-discount-001 --arms none,gbrain \
 *     --budget-usd 5 --budget-ledger .budget/<ledger>.sqlite --gbrain <checkout>@<sha> [--out <dir>]
 *   bun eval/runner/coding-spike.ts --tasks boltons-discount-001 --stub-upstream     keyless plumbing check
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BudgetRun, budgetOptionsFrom, closeLedgers, initLedger } from './budget-ledger.ts';
import { gbrainSpecFrom, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR, REPO_ROOT } from './harness-env.ts';

/** The harness pins its dataset as a git submodule at sdebench/datasets; this is that pin at the harness commit. */
export const DATASET_COMMIT = 'afcce15c1f608242e28e48832c301f39c5aed708';
/** Host repository commit every task's build.py checks out. */
export const HOST_REF = '979fa9b613fa8c0a455ae16ea6f2ec91c11ecafe';
export const DEFAULT_MODEL = 'google/gemini-3.8-flash';
const SPIKE_DIR = join(PROVIDER_DIR, 'coding-spike');

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sh(cmd: string[], cwd?: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} failed (${p.exitCode}): ${p.stderr.toString().slice(-800)}`);
  return p.stdout.toString().trim();
}

/** The dataset repository URL comes from the harness's own .gitmodules, so no organisation name is written here. */
export function submoduleUrl(gitmodules: string): string {
  const m = /path\s*=\s*sdebench\/datasets\s*\n\s*url\s*=\s*(\S+)/.exec(gitmodules);
  if (!m) throw new Error('the harness .gitmodules has no sdebench/datasets submodule');
  return m[1];
}

/** The host fork lives next to the dataset repository (the dataset's build.py names it). */
export function hostUrl(datasetUrl: string): string {
  return datasetUrl.replace(/[^/]+?(\.git)?$/, 'boltons');
}

function ensureCheckout(dir: string, url: string, commit: string): void {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty and not a git checkout`);
    sh(['git', 'clone', '-q', url, dir]);
  }
  if (sh(['git', 'rev-parse', 'HEAD'], dir) !== commit) {
    sh(['git', 'fetch', '-q', 'origin'], dir);
    sh(['git', 'checkout', '-q', commit], dir);
  }
}

function dockerGateway(): string {
  return sh(['docker', 'network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']);
}

/** Forward TCP from the Docker bridge gateway to the proxy's loopback port. */
async function startRelay(hostname: string, target: number): Promise<{ port: number; stop(): void }> {
  type Peer = { peer?: import('bun').Socket<unknown>; queue: Uint8Array[] };
  const server = Bun.listen<Peer>({
    hostname, port: 0,
    socket: {
      open(client) {
        client.data = { queue: [] };
        Bun.connect<null>({
          hostname: '127.0.0.1', port: target,
          socket: {
            open(up) { client.data.peer = up; for (const c of client.data.queue) up.write(c); client.data.queue = []; },
            data(_up, chunk) { client.write(chunk); },
            close() { client.end(); },
            error() { client.end(); },
          },
        }).catch(() => client.end());
      },
      data(client, chunk) { if (client.data.peer) client.data.peer.write(chunk); else client.data.queue.push(new Uint8Array(chunk)); },
      close(client) { client.data.peer?.end(); },
      error(client) { client.data.peer?.end(); },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

export async function main(argv: string[]): Promise<number> {
  const tasks = flag(argv, '--tasks');
  if (!tasks) { console.error('usage: bun eval/runner/coding-spike.ts --tasks <id,id> [--arms none,gbrain] [--budget-usd N] [--budget-ledger <path>] [--gbrain <checkout>@<ref>] [--model google/gemini-3.8-flash] [--out <dir>] [--agent-python] [--retrieval-only] [--stub-upstream]'); return 2; }
  const stubMode = argv.includes('--stub-upstream');
  const arms = flag(argv, '--arms') ?? 'none,gbrain';
  const model = flag(argv, '--model') ?? DEFAULT_MODEL;
  const budgetUsd = Number(flag(argv, '--budget-usd') ?? (stubMode ? 5 : NaN));
  const out = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/coding-spike', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });

  const install = ensureHarness({ log: l => console.error(l) });
  const datasetUrl = submoduleUrl(readFileSync(join(install.src, '.gitmodules'), 'utf8'));
  ensureCheckout(join(install.src, 'sdebench/datasets'), datasetUrl, DATASET_COMMIT);
  const host = join(REPO_ROOT, '.harness/sdebench-hosts/boltons');
  ensureCheckout(host, hostUrl(datasetUrl), HOST_REF);
  for (const [image, file] of [['sdebench-harness-base', 'Dockerfile'], ['sdebench-agent', 'Dockerfile.agent']]) {
    if (Bun.spawnSync(['docker', 'image', 'inspect', image], { stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0) {
      console.error(`[coding-spike] building ${image} from the harness's sdebench/${file}`);
      sh(['docker', 'build', '-q', '-t', image, '-f', join(install.src, 'sdebench', file), join(install.src, 'sdebench')]);
    }
  }
  // run.py grades in the image named sdebench-base; this derived one keeps root-owned files out of the mounted checkout.
  sh(['docker', 'build', '-q', '-t', 'sdebench-base', '-f', join(SPIKE_DIR, 'Dockerfile.base'), SPIKE_DIR]);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));

  const { startMeteringProxy } = await import('./metering-proxy.ts');
  let stub: Awaited<ReturnType<typeof import('./stub-upstream.ts')['startStubUpstream']>> | null = null;
  let ledgerPath = budgetOptionsFrom(argv).ledgerPath;
  if (stubMode) {
    const { startStubUpstream } = await import('./stub-upstream.ts');
    stub = await startStubUpstream();
    ledgerPath = join(out, 'stub-ledger.sqlite');
    if (!existsSync(ledgerPath)) initLedger({ ledgerPath, programCapUsd: 1000, reason: 'keyless coding spike: no real spend' });
  }
  const run = BudgetRun.open({ runner: 'coding-spike', budgetUsd, ledgerPath, log: l => console.error(l) });
  const proxy = await startMeteringProxy({
    run, cellId: `coding-spike:${tasks}`.slice(0, 200), requestLogPath: join(out, 'proxy/requests.jsonl'), bodiesDir: join(out, 'proxy/bodies'),
    labels: ['agent', 'gbrain'], upstreams: stub?.upstreams,
    realKeys: stub ? Object.fromEntries(['GEMINI_API_KEY', 'VOYAGE_API_KEY'].map(k => [k, 'stub-upstream-key'])) : undefined,
  });
  const gateway = dockerGateway();
  const relay = await startRelay(gateway, proxy.port);
  const modelId = model.split('/').pop()!;
  const image = `mpw-coding-spike-agent:${relay.port}`;
  sh(['docker', 'build', '-q', '-t', image, '--build-arg', `GEMINI_BASE_URL=http://host.docker.internal:${relay.port}/gemini/v1beta`,
    '--build-arg', `MODEL_ID=${modelId}`, '--build-arg', `AGENT_PYTHON=${argv.includes('--agent-python') ? 1 : 0}`, '-f', join(SPIKE_DIR, 'Dockerfile.agent'), SPIKE_DIR]);

  const agentEnv = proxy.envFor('agent');
  const gbrainEnv = proxy.envFor('gbrain');
  const exhaustedFlag = join(out, 'proxy/exhausted');
  const env: Record<string, string> = {
    GEMINI_API_KEY: agentEnv.GEMINI_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: agentEnv.GOOGLE_GENERATIVE_AI_API_KEY,
    SDE_AGENT_IMAGE: image,
    SDEBENCH_BOLTONS_HOST: host,
    MPW_HARNESS_SRC: install.src,
    MPW_PROXY_LOG: join(out, 'proxy/requests.jsonl'),
    MPW_PROXY_EXHAUSTED_FLAG: exhaustedFlag,
    MPW_PROVIDER_CONFIG: flag(argv, '--provider-config') ?? '{}',
    MPW_GBRAIN_CLI: join(gut.root, 'src/cli.ts'),
    MPW_BUN: process.execPath,
    MPW_CHILD_ENV_GBRAIN: JSON.stringify({ VOYAGE_API_KEY: gbrainEnv.VOYAGE_API_KEY, VOYAGE_BASE_URL: proxy.baseUrls.voyage }),
  };
  const settings = {
    tasks: tasks.split(','), arms: arms.split(','), model, retrieval_only: argv.includes('--retrieval-only'), budget_usd: budgetUsd, stub: stubMode,
    ledger: ledgerPath.replace(REPO_ROOT + '/', ''), budget_run: run.runId,
    harness_commit: install.lock.harness_commit, dataset_commit: DATASET_COMMIT, host_ref: HOST_REF,
    gbrain: { version: gut.version, identity: productIdentityFor(gut), overlay: gut.overlay ? { requested: gut.overlay.requested, ref: gut.overlay.ref } : null },
    provider_config: JSON.parse(env.MPW_PROVIDER_CONFIG),
    agent_image: { base: 'sdebench-agent', opencode: '1.16.2', python_in_agent: argv.includes('--agent-python'), gemini_base_url: 'proxy relay on the docker bridge gateway' },
    started_at: new Date().toISOString(),
  };
  writeFileSync(join(out, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  console.error(`[coding-spike] proxy ${proxy.url}, relay ${gateway}:${relay.port}, image ${image}, out ${out}`);

  const child = Bun.spawn([install.python, join(SPIKE_DIR, 'spike.py'), '--out', out, '--tasks', tasks, '--arms', arms, '--model', model,
    ...(flag(argv, '--max-interventions') ? ['--max-interventions', flag(argv, '--max-interventions')!] : []),
    ...(argv.includes('--retrieval-only') ? ['--retrieval-only'] : [])], {
    cwd: PROVIDER_DIR, env: harnessProcessEnv(install, env), stdout: 'inherit', stderr: 'inherit',
  });
  const onSignal = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const watch = setInterval(() => { if (proxy.exhausted && !existsSync(exhaustedFlag)) writeFileSync(exhaustedFlag, new Date().toISOString()); }, 200);
  let code: number;
  try {
    code = await child.exited;
  } finally {
    clearInterval(watch);
    const stats = proxy.stats();
    relay.stop();
    await proxy.close();
    stub?.close();
    const summary = run.close();
    writeFileSync(join(out, 'spend.json'), JSON.stringify({ budget_run: summary, metered: stats, unmetered: [] }, null, 2) + '\n');
    closeLedgers();
    Bun.spawnSync(['docker', 'image', 'rm', image], { stdout: 'ignore', stderr: 'ignore' });
  }
  console.error(`[coding-spike] exited ${code}; receipts in ${out.replace(REPO_ROOT + '/', '')}`);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

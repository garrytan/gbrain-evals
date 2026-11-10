#!/usr/bin/env bun
/**
 * Scale-latency on Ubicloud (GBEV-55 G5, gate change J1): one VM's lifecycle for
 * the 300k-page build and probe.
 *
 *   bun eval/runner/predictive/scale-latency/ubicloud.ts --paid --budget-run-id <id> --owner <thread code> \
 *     [--pages 300000] [--n 200] [--sync-n 30] [--size standard-16] [--location eu-central-h1] \
 *     [--ttl-hours 6] [--state <file>] [--out <dir>] [--ubi-runner <path to ubi-runner.sh>]
 *     [--pins <tag>:<gbrain commit>,…]   probe each commit in order on one brain built at the first
 *
 * --owner becomes UBI_OWNER, so the VM name carries it. The VM costs money, so the
 * run needs an open budget-ledger run.
 *
 * J1, in order:
 *   - requirePaidArm refuses before anything else unless --paid and --budget-run-id
 *     name an open budget-ledger run;
 *   - the VM's name is chosen here and written to the state file (status
 *     "recorded") before the create request, so a controller that dies mid-create
 *     still leaves the name behind for teardown;
 *   - every VM the run recorded is torn down in a finally path; a teardown that
 *     fails is marked down_failed;
 *   - a failure reports status "partial" with every VM id and what happened to it;
 *   - a failed attempt is retried at most MAX_RETRIES (2) times. A retry reuses
 *     the VM when it was created, so build.ts resumes the load from its checkpoint
 *     on the VM instead of starting again; a VM whose create failed is replaced.
 *     A rerun of this command adopts a VM a dead controller left in the state file
 *     as "created" when it still answers ssh, and the build resumes there too.
 *
 * The Ubicloud client is injectable: the CLI wraps ubi-runner.sh (the ubicloud
 * skill's copy unless UBI_RUNNER or --ubi-runner names another), and the tests
 * drive a fake. Nothing in the test suite reaches the Ubicloud API.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { requirePaidArm } from '../../paid-arm.ts';
import { DEFAULT_PAGES, flag } from './build.ts';

export const LIFECYCLE_SCHEMA = 'gbrain-evals/scale-latency-ubicloud/v1';
export const MAX_RETRIES = 2;
const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const DEFAULT_UBI_RUNNER = join(homedir(), '.capy/drive/user-garry-tan/skills/ubicloud/scripts/ubi-runner.sh');

export interface VmSpec { size: string; location: string }
export interface UbicloudClient {
  /** Create the VM under this exact name and wait until ssh answers. */
  up(name: string, spec: VmSpec): Promise<void>;
  /** Copy the checkout at localDir to ~/work/<its directory name> on the VM. */
  sync(name: string, localDir: string): Promise<void>;
  /** Run a command on the VM; rejects on a non-zero exit. */
  ssh(name: string, command: string): Promise<void>;
  pull(name: string, remotePath: string, localDir: string): Promise<void>;
  /** Destroy the VM; resolves once it is gone or provably never existed. */
  down(name: string): Promise<void>;
}

export type VmStatus = 'recorded' | 'created' | 'down' | 'down_failed';
export interface VmRecord { name: string; spec: VmSpec; recorded_at: string; status: VmStatus; created: boolean; error?: string }
export interface LifecycleState { schema: typeof LIFECYCLE_SCHEMA; vms: VmRecord[]; attempts: number; last_error: string | null }
export interface SideEffect { vm: string; created: boolean | 'unknown'; torn_down: boolean; error?: string }
export interface LifecycleReport {
  status: 'complete' | 'partial';
  vm_ids: string[];
  attempts: number;
  retries: number;
  side_effects: SideEffect[];
  error: string | null;
  scorecard: string | null;
  state_path: string;
}
export interface RemoteStep { id: string; command: string }

/** The name ubi-runner.sh would generate: ubirun-<owner>-<epoch>-<8 hex>-t<hours>. */
export function vmName(owner: string, ttlHours: number, epochSeconds: number, hex: string): string {
  let o = owner.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!o) throw new Error('--owner must contain letters or digits (use your thread code)');
  if (!/^[a-z]/.test(o)) o = 'u' + o;
  if (!/^[0-9a-f]{8}$/.test(hex)) throw new Error('vm name suffix must be 8 hex characters');
  return `ubirun-${o.slice(0, 12)}-${epochSeconds}-${hex}-t${ttlHours}`;
}

export interface Pin { tag: string; ref: string }
export const GBRAIN_REPO = 'https://github.com/garrytan/gbrain';

/** --pins <tag>:<commit>,…: the gbrain commits to probe, in order, on one brain built at the first. */
export function parsePins(value: string | undefined): Pin[] {
  if (!value) return [];
  const pins = value.split(',').map(entry => {
    const [tag, ref, extra] = entry.split(':');
    if (!tag || !/^[a-z0-9]+$/.test(tag) || !ref || !/^[0-9a-f]{40}$/.test(ref) || extra !== undefined) throw new Error(`--pins takes <tag>:<40-hex gbrain commit> entries, comma-separated, each tag lowercase letters and digits; got "${entry}"`);
    return { tag, ref };
  });
  const seen = new Set<string>();
  for (const p of pins) {
    if (seen.has(p.tag)) throw new Error(`--pins names tag ${p.tag} twice; give each probe its own tag`);
    seen.add(p.tag);
  }
  return pins;
}

/**
 * The remote steps: setup, resumable build, probe. Scorecards land in ~/scale-latency. With no pins, the package's
 * gbrain builds and probes once (scorecard.json). With pins, gbrain is cloned on the VM and the brain is built once at
 * the first pin. Each pin, in the order given, is probed on its own fresh copy of that brain (database scale_<tag>,
 * made from the built one as a template), because a probe writes to the brain it times; it writes
 * scorecard-<tag>.json, and a retry skips a probe whose scorecard already exists.
 */
export function defaultSteps(o: { pages: number; n: number; syncN: number; checkout?: string; pins?: Pin[] }): RemoteStep[] {
  const cd = `cd ~/work/${o.checkout ?? basename(REPO_ROOT)} && export PATH="$HOME/.bun/bin:$PATH" SCALE_LATENCY_DATABASE_URL=postgresql://ubi@127.0.0.1:5432/scale && mkdir -p ~/scale-latency`;
  const dir = 'eval/runner/predictive/scale-latency';
  const pins = o.pins ?? [];
  const gut = (p: Pin) => ` --gbrain ~/gbrain-src@${p.ref}`;
  const probe = (out: string, extra: string) => `bun ${dir}/probe.ts --database-url-env SCALE_LATENCY_DATABASE_URL --checkpoint ~/scale-latency/checkpoint.json --n ${o.n} --sync-n ${o.syncN}${extra} --out ~/scale-latency/${out}`;
  return [
    { id: 'setup', command: `${cd} && bash ${dir}/vm-setup.sh` },
    ...(pins.length ? [{ id: 'gbrain', command: `[ -d ~/gbrain-src/.git ] || git clone --quiet ${GBRAIN_REPO} ~/gbrain-src` }] : []),
    { id: 'build', command: `${cd} && bun ${dir}/build.ts --database-url-env SCALE_LATENCY_DATABASE_URL --pages ${o.pages} --checkpoint ~/scale-latency/checkpoint.json${pins.length ? gut(pins[0]) : ''}` },
    ...(pins.length
      ? pins.map(p => ({ id: `probe-${p.tag}`, command: `${cd} && { [ -s ~/scale-latency/scorecard-${p.tag}.json ] || { sudo -u postgres psql -qc 'DROP DATABASE IF EXISTS scale_${p.tag}' -c 'CREATE DATABASE scale_${p.tag} TEMPLATE scale OWNER ubi' && SCALE_LATENCY_DATABASE_URL=postgresql://ubi@127.0.0.1:5432/scale_${p.tag} ${probe(`scorecard-${p.tag}.json`, gut(p))}; }; }` }))
      : [{ id: 'probe', command: `${cd} && ${probe('scorecard.json', '')}` }]),
  ];
}

export function loadState(path: string): LifecycleState {
  if (!existsSync(path)) return { schema: LIFECYCLE_SCHEMA, vms: [], attempts: 0, last_error: null };
  const s = JSON.parse(readFileSync(path, 'utf8')) as LifecycleState;
  if (s.schema !== LIFECYCLE_SCHEMA || !Array.isArray(s.vms)) throw new Error(`${path} is not a ${LIFECYCLE_SCHEMA} state file; tear down any VM it names with ubi-runner.sh down, then move it aside`);
  return s;
}

function saveState(path: string, s: LifecycleState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export interface LifecycleOptions {
  argv: readonly string[];
  client: UbicloudClient;
  statePath: string;
  owner: string;
  steps: RemoteStep[];
  /** Remote file to bring back (relative to the VM user's home) and the local directory for it. */
  pull: { remote: string; localDir: string };
  repoDir?: string;
  spec?: VmSpec;
  ttlHours?: number;
  ledgerPath?: string;
  now?: () => Date;
  hex?: () => string;
  log?: (line: string) => void;
}

export async function runOnUbicloud(o: LifecycleOptions): Promise<LifecycleReport> {
  requirePaidArm(o.argv, { arm: 'scale-latency Ubicloud build', estimateUsd: null, ledgerPath: o.ledgerPath });
  const now = o.now ?? (() => new Date());
  const hex = o.hex ?? (() => randomBytes(4).toString('hex'));
  const spec = o.spec ?? { size: 'standard-16', location: 'eu-central-h1' };
  const ttlHours = o.ttlHours ?? 6;
  const log = o.log ?? (() => {});
  const state = loadState(o.statePath);
  const touched = new Set<string>();
  const save = () => saveState(o.statePath, state);
  const record = (name: string) => state.vms.find(v => v.name === name)!;

  let live: string | null = null;
  const left = state.vms.find(v => v.status === 'created');
  if (left) {
    touched.add(left.name);
    try {
      await o.client.ssh(left.name, 'true');
      live = left.name;
      log(`adopting ${left.name}, left by an earlier run; the build resumes from its checkpoint there`);
    } catch (e) {
      log(`${left.name} from an earlier run does not answer (${message(e)}); it is torn down below`);
    }
  }

  let ok = false;
  let error: string | null = null;
  let attempts = 0;
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES && !ok; attempt++) {
      attempts++;
      state.attempts++;
      try {
        if (!live) {
          const name = vmName(o.owner, ttlHours, Math.floor(now().getTime() / 1000), hex());
          state.vms.push({ name, spec, recorded_at: now().toISOString(), status: 'recorded', created: false });
          touched.add(name);
          save();
          log(`creating ${name} (${spec.size}, ${spec.location}); recorded in ${o.statePath}`);
          await o.client.up(name, spec);
          Object.assign(record(name), { status: 'created', created: true });
          save();
          live = name;
        }
        await o.client.sync(live, o.repoDir ?? REPO_ROOT);
        for (const step of o.steps) {
          log(`${live}: ${step.id}`);
          await o.client.ssh(live, step.command);
        }
        await o.client.pull(live, o.pull.remote, o.pull.localDir);
        ok = true;
        error = null;
      } catch (e) {
        error = `attempt ${attempt + 1}: ${message(e)}`;
        state.last_error = error;
        save();
        log(error + (attempt < MAX_RETRIES ? '; retrying' : '; no retries left'));
      }
    }
  } finally {
    for (const vm of state.vms) {
      if (vm.status === 'down') continue;
      touched.add(vm.name);
      try {
        await o.client.down(vm.name);
        vm.status = 'down';
        delete vm.error;
      } catch (e) {
        vm.status = 'down_failed';
        vm.error = message(e);
      }
      save();
    }
  }

  const side_effects: SideEffect[] = state.vms.filter(v => touched.has(v.name)).map(v => ({
    vm: v.name,
    created: v.created ? true : 'unknown',
    torn_down: v.status === 'down',
    ...(v.error ? { error: v.error } : {}),
  }));
  const clean = side_effects.every(s => s.torn_down);
  return {
    status: ok && clean ? 'complete' : 'partial',
    vm_ids: side_effects.map(s => s.vm),
    attempts,
    retries: attempts - 1,
    side_effects,
    error: error ?? (clean ? null : 'teardown failed for ' + side_effects.filter(s => !s.torn_down).map(s => s.vm).join(', ') + '; run ubi-runner.sh down <name>'),
    scorecard: ok ? join(o.pull.localDir, basename(o.pull.remote)) : null,
    state_path: o.statePath,
  };
}

/** The environment ubi-runner.sh reads, besides its UBI_* settings: nothing else reaches it, provider keys included. */
const UBI_RUNNER_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'XDG_STATE_HOME', 'UBICLOUD_API_KEY', 'UBICLOUD_API_TOKEN', 'UBICLOUD_API_URL', 'GSTACK_CAPY_RECOVERY_DIR']);

/** The real client: ubi-runner.sh subcommands. UBICLOUD_API_KEY is passed through by name, never read or printed here. */
export function ubiRunnerClient(script: string, o: { owner: string; ttlHours: number }): UbicloudClient {
  const run = (args: string[], cwd?: string) => new Promise<void>((resolveRun, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => UBI_RUNNER_ENV.has(name) || name.startsWith('UBI_')));
    const child = spawn('bash', [script, ...args], { cwd, env: { ...env, UBI_OWNER: o.owner, UBI_TTL_HOURS: String(o.ttlHours) }, stdio: ['ignore', 'inherit', 'pipe'] });
    let tail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolveRun() : reject(new Error(`ubi-runner ${args[0]} exited ${code}: ${tail.trim().split('\n').slice(-3).join(' | ')}`))));
  });
  return {
    up: (name, spec) => run(['up', '-n', name, '-s', spec.size, '-l', spec.location]),
    sync: (name, localDir) => run(['sync', name, '.'], localDir),
    ssh: (name, command) => run(['ssh', name, command]),
    pull: (name, remotePath, localDir) => run(['pull', name, remotePath, localDir]),
    down: name => run(['down', name]),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const owner = flag(argv, '--owner');
  if (!owner) throw new Error('--owner <thread code> is required: every VM carries its owner');
  const ttlHours = Number(flag(argv, '--ttl-hours') ?? 6);
  const out = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/scale-latency'));
  const script = flag(argv, '--ubi-runner') ?? process.env.UBI_RUNNER ?? DEFAULT_UBI_RUNNER;
  const pins = parsePins(flag(argv, '--pins'));
  const report = await runOnUbicloud({
    argv, owner, ttlHours,
    client: ubiRunnerClient(script, { owner, ttlHours }),
    statePath: resolve(flag(argv, '--state') ?? join(out, 'ubicloud-state.json')),
    spec: { size: flag(argv, '--size') ?? 'standard-16', location: flag(argv, '--location') ?? 'eu-central-h1' },
    steps: defaultSteps({ pages: Number(flag(argv, '--pages') ?? DEFAULT_PAGES), n: Number(flag(argv, '--n') ?? 200), syncN: Number(flag(argv, '--sync-n') ?? 30), pins }),
    pull: { remote: pins.length ? 'scale-latency' : 'scale-latency/scorecard.json', localDir: out },
    log: line => process.stderr.write(`scale-latency ubicloud: ${line}\n`),
  });
  const missing = report.status === 'complete' ? pins.filter(p => !existsSync(join(out, 'scale-latency', `scorecard-${p.tag}.json`))).map(p => p.tag) : [];
  if (missing.length) Object.assign(report, { status: 'partial', error: `the VM run finished but no scorecard came back for ${missing.join(', ')}` });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ubicloud-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === 'complete' ? 0 : 1);
}

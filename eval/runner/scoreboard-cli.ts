/**
 * The scoreboard's one front door (docs/scoreboard.md):
 *
 *   bun run eval:scoreboard <check|fixture|explain|doctor|plan|smoke|run|status|judge|render|dispute> [--json] ...
 *
 *   check    [args]                     regenerate every table and aggregate from committed rows ($0; eval/runner/scoreboard.ts)
 *   fixture  [--stub generator,judge-repeat] [--out <dir>] [--keep]
 *                                       the fake system end to end ($0): shim, metering proxy, packer, reader stub,
 *                                       judge stub, judge repeats, cost and speed, then the generator's render and
 *                                       check on the synthetic receipt (test/eval/fixtures/scoreboard/synthetic.ts)
 *   explain  <row> <column>              the chain behind one published number (eval/runner/scoreboard.ts)
 *   doctor   [--campaign <m> [--state <dir>]] [--for fixture|local|run|sealed] [--benchmark <b>]... [--cell <id>]...
 *                                       preflight before any lease: Bun, Python, Docker, architecture, disk, ports,
 *                                       which keys are present (never their values), ledger, dataset hashes,
 *                                       resolved models priced, the VM executor and its owner tag, the freeze
 *   plan     --campaign <m> [--state <dir>]
 *                                       the cell manifest, waves with vCPU, the cost estimate per block, the commands
 *   smoke    --campaign <m> --state <dir> [--cell <id>] [--local]
 *                                       the campaign's 20-question smoke cells
 *   run      --campaign <m> --state <dir> (--cell <id> | --cells a,b | --wave N) [--local [--setup]] [--sealed] [--dry-run]
 *                                       preflight, reserve, launch (Ubicloud through the repository runner, or this
 *                                       machine with --local); exits non-zero when any cell fails
 *   status   --campaign <m> --state <dir> [--progress <progress.md>]
 *   judge    [args]                     repeated judging (eval/runner/judge-repeat.ts)
 *   render   [--campaign <m> --state <dir>] [args]
 *                                       the README table, report tables and receipt (eval/runner/scoreboard.ts),
 *                                       after checking the campaign freeze
 *   dispute                              how a vendor disputes a row
 *
 * Every refusal is an operator message (code, message, why, fix.next with the
 * exact argv, a read-only verify command; eval/runner/q1/scoreboard-errors.ts),
 * printed to stderr, as JSON with --json. Exit 0 success, 2 refusal, 3 stop and
 * ask the user, 4 partial (some cells ran; the cap or a block stopped the rest).
 * The operator is usually an AI agent: every message says what to do next.
 *
 * check, explain and render delegate to eval/runner/scoreboard.ts as
 * `bun eval/runner/scoreboard.ts <check|explain|render> ...` (SCOREBOARD_GENERATOR
 * overrides the path); judge delegates to `bun eval/runner/judge-repeat.ts ...`
 * (SCOREBOARD_JUDGE_REPEAT). A missing delegate is an operator message, never
 * a silent pass.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BudgetRun, closeLedgers, ledgerPaths, priceRequest } from './budget-ledger.ts';
import { AdmissionController, DEFAULT_ROUTE_CAPS, MeteringProxy, usageSplit } from './metering-proxy.ts';
import { Campaign, DEFAULT_ROUTE_CLASSES, isQ1, loadCampaign, planWaves, resolveRunner, ownerTag, ubiRunner, vcpuOf, type LeaseState, type Runner } from './shootout-cell.ts';
import { costSpeed, loadCell, renderCostSpeed, renderProgress } from './cost-speed.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError, type ScoreboardMessage } from './q1/scoreboard-errors.ts';
import { DATASET_ROOT, filesFor, sha256 } from './memory-qa/corpus.ts';
import { answerId, type AnswerRecord, type JudgmentRecord } from './scoreboard.ts';
import type { Outcome } from './memory-qa/outcomes.ts';
import { writeSyntheticReceipt } from '../../test/eval/fixtures/scoreboard/synthetic.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
export const SUBCOMMANDS = ['check', 'fixture', 'explain', 'doctor', 'plan', 'smoke', 'run', 'status', 'judge', 'render', 'dispute'] as const;
export type Subcommand = typeof SUBCOMMANDS[number];
const FRONT = ['bun', 'run', 'eval:scoreboard'];
/** Provider keys whose presence (never value) doctor reports. */
export const KEY_NAMES = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'UBICLOUD_API_TOKEN', 'UBICLOUD_API_KEY'] as const;
const PROVIDER_KEY: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', voyage: 'VOYAGE_API_KEY' };
export const PUBLIC_BENCHMARKS = new Set(['locomo', 'lme-s', 'lme-m', 'beam-100k', 'beam-500k', 'beam-1m', 'fixture']);

interface Result { data: unknown; text: string; exit?: number }
type Args = string[];
const one = (a: Args, n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const many = (a: Args, n: string) => a.flatMap((x, i) => x === n ? [a[i + 1]] : []);
const has = (a: Args, n: string) => a.includes(n);

// ─── Delegation to other tools ──────────────────────────────────────

/** Run `bun <script> ...args` with inherited output and return its exit code; a missing script is an operator message. */
export async function delegate(script: string, args: string[], what: string, stubHint?: string[], logTo?: string): Promise<number> {
  const path = resolve(REPO_ROOT, script);
  if (!existsSync(path)) throw refuse({ code: 'NOT_YET_AVAILABLE', message: `${what} needs ${script}, which is not in this checkout`,
    why: 'the front door wraps the scoreboard tools and never passes silently when one is missing',
    fix: { next: stubHint ? 'run' : 'report', argv: stubHint, user_message: stubHint ? undefined : `${script} has not landed on this branch; merge the lane that adds it, or point the override variable at it`,
      verify: ['ls', script] } });
  if (logTo) {
    const p = Bun.spawn([process.execPath, path, ...args], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    appendFileSync(logTo, `$ bun ${script} ${args.join(' ')}\n${o}${e}exit ${code}\n`);
    return code;
  }
  const p = Bun.spawn([process.execPath, path, ...args], { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit', env: process.env });
  return await p.exited;
}
const generatorPath = () => process.env.SCOREBOARD_GENERATOR ?? 'eval/runner/scoreboard.ts';
const judgeRepeatPath = () => process.env.SCOREBOARD_JUDGE_REPEAT ?? 'eval/runner/judge-repeat.ts';

// ─── doctor ─────────────────────────────────────────────────────────

export interface Check { id: string; ok: boolean | null; severity: 'error' | 'warn'; detail: string; code?: ScoreboardMessage['code']; fix?: ScoreboardMessage['fix'] }
export type DoctorFor = 'fixture' | 'local' | 'run' | 'sealed';

/** The `provider:model` request shape priceRequest needs, by model kind. */
export function priceProbe(id: string): { url: string; body: Record<string, unknown> } {
  const [prov, model] = id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : ['openai', id];
  if (prov === 'voyage' && /^rerank/.test(model)) return { url: 'https://api.voyageai.com/v1/rerank', body: { model, query: 'q', documents: ['d'] } };
  if (prov === 'voyage') return { url: 'https://api.voyageai.com/v1/embeddings', body: { model, input: ['x'] } };
  if (/embedding/.test(model)) return { url: 'https://api.openai.com/v1/embeddings', body: { model, input: ['x'] } };
  if (prov === 'anthropic') return { url: 'https://api.anthropic.com/v1/messages', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] } };
  return { url: 'https://api.openai.com/v1/chat/completions', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] } };
}

/** Models a campaign resolves: its `models` list (readers, judges, extraction, gbrain internals). */
const campaignModels = (m: { models?: string[] } | null) => [...new Set(m?.models ?? [])].sort();
const providersOf = (models: string[]) => [...new Set(models.map(m => m.includes(':') ? m.slice(0, m.indexOf(':')) : 'openai'))].filter(p => p in PROVIDER_KEY);

async function portFree(port: number): Promise<boolean> {
  try { const s = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') }); s.stop(true); return true; } catch { return false; }
}

async function dockerUp(): Promise<boolean> {
  try {
    const p = Bun.spawn(['docker', 'info', '--format', '{{.ServerVersion}}'], { stdout: 'ignore', stderr: 'ignore' });
    const t = setTimeout(() => p.kill(), 10_000);
    const code = await p.exited;
    clearTimeout(t);
    return code === 0;
  } catch { return false; }
}

const onCapyMachine = (env = process.env) => existsSync('/home/user/.capy') || !!env.CAPY_JAM_ID;

export async function doctor(a: Args, env: Record<string, string | undefined> = process.env): Promise<{ ok: boolean; for: DoctorFor; checks: Check[] }> {
  const forWhat = (one(a, '--for') ?? (one(a, '--campaign') ? 'run' : 'fixture')) as DoctorFor;
  if (!['fixture', 'local', 'run', 'sealed'].includes(forWhat)) throw refuse({ code: 'USAGE', message: `--for must be fixture, local, run or sealed, not ${forWhat}`, why: 'doctor checks what the named path needs', fix: { next: 'run', argv: [...FRONT, 'doctor', '--for', 'fixture'] } });
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const err = (need: boolean) => need ? 'error' as const : 'warn' as const;
  const paid = forWhat === 'local' || forWhat === 'run' || forWhat === 'sealed';
  const remote = forWhat === 'run' || forWhat === 'sealed';

  const [maj, min] = Bun.version.split('.').map(Number);
  add({ id: 'bun', ok: maj > 1 || (maj === 1 && min >= 4), severity: 'error', detail: `Bun ${Bun.version} (needs 1.4.0 or later)`, code: 'PREFLIGHT_FAILED',
    fix: { next: 'run', argv: ['bash', '-c', 'curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2'], verify: ['bun', '--version'] } });
  const py = Bun.spawnSync(['python3', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  add({ id: 'python3', ok: py.exitCode === 0, severity: err(forWhat === 'fixture' || forWhat === 'local'), detail: py.exitCode === 0 ? py.stdout.toString().trim() || py.stderr.toString().trim() : 'python3 not found (the reference shim and fake provider are Python)', code: 'PREFLIGHT_FAILED',
    fix: { next: 'tell_user_to_run', argv: ['sudo', 'apt-get', 'install', '-y', 'python3'], verify: ['python3', '--version'] } });
  const docker = await dockerUp();
  add({ id: 'docker', ok: docker, severity: err(forWhat === 'local'), detail: docker ? 'Docker daemon reachable' : 'Docker daemon not reachable (run --local needs it; Ubicloud cells install it on the VM)', code: 'DOCKER_MISSING',
    fix: { next: 'tell_user_to_run', argv: ['sudo', 'systemctl', 'start', 'docker'], user_message: 'start Docker (or install it) on this machine', verify: ['docker', 'info'] } });
  add({ id: 'architecture', ok: process.arch === 'x64', severity: 'warn', detail: `${process.platform}/${process.arch}${process.arch === 'x64' ? '' : ' (system images are built for linux/amd64; local runs emulate)'}` });
  const stateDir = one(a, '--state');
  const diskAt = stateDir && existsSync(stateDir) ? stateDir : REPO_ROOT;
  const needGb = forWhat === 'local' ? 20 : 2;
  try {
    const fs = statfsSync(diskAt);
    const freeGb = fs.bavail * fs.bsize / 1e9;
    add({ id: 'disk', ok: freeGb >= needGb, severity: 'error', detail: `${freeGb.toFixed(1)} GB free at ${diskAt} (needs ${needGb} GB for ${forWhat})`, code: 'PREFLIGHT_FAILED',
      fix: { next: 'ask_user', user_message: `free disk space at ${diskAt} (at least ${needGb} GB)`, verify: ['df', '-h', diskAt] } });
  } catch (e) { add({ id: 'disk', ok: null, severity: 'warn', detail: `could not read free space: ${(e as Error).message}` }); }
  if (forWhat === 'local') for (const port of [8787, 8700]) {
    const free = await portFree(port);
    add({ id: `port:${port}`, ok: free, severity: 'warn', detail: free ? `port ${port} free` : `port ${port} in use (run --local picks free ports, but a shim's compose stack defaults to it)` });
  }
  const keys = Object.fromEntries(KEY_NAMES.map(k => [k, !!env[k]]));
  add({ id: 'keys', ok: true, severity: 'warn', detail: `present: ${KEY_NAMES.filter(k => keys[k]).join(', ') || 'none'} (values are never printed)` });

  const manifestPath = one(a, '--campaign');
  let loaded: ReturnType<typeof loadCampaign> | null = null;
  if (manifestPath) {
    try { loaded = loadCampaign(manifestPath); add({ id: 'campaign', ok: true, severity: 'error', detail: `${loaded.manifest.campaign_id}: ${loaded.manifest.cells.length} cells, hash ${loaded.sha256.slice(0, 12)}` }); }
    catch (e) { add({ id: 'campaign', ok: false, severity: 'error', detail: (e as Error).message, code: 'CAMPAIGN_INVALID', fix: { next: 'report', user_message: 'fix the campaign manifest', verify: ['bun', 'eval/runner/shootout-cell.ts', 'hash', '--campaign', manifestPath] } }); }
  }
  const models = campaignModels(loaded?.manifest ?? null);
  for (const m of models) {
    const probe = priceProbe(m);
    let ok = true, detail = `${m} priced`;
    try { if (!priceRequest(probe.url, probe.body)) { ok = false; detail = `${m}: no price (not a paid route)`; } } catch (e) { ok = false; detail = (e as Error).message; }
    add({ id: `price:${m}`, ok, severity: 'error', detail, code: 'MODEL_UNPRICED',
      fix: { next: 'run', argv: ['$EDITOR', 'eval/runner/budget-ledger.ts'], user_message: `look up the provider's current list price for ${m} and register it in CHAT_PRICE_OVERRIDES (or the rerank or embedding table) with the date checked; never guess a rate`,
        verify: [...FRONT, 'doctor', '--campaign', manifestPath ?? '<manifest>'] } });
  }
  if (paid) for (const prov of providersOf(models.length ? models : ['openai:x'])) {
    const k = PROVIDER_KEY[prov];
    add({ id: `key:${k}`, ok: !!env[k], severity: 'error', detail: env[k] ? `${k} present` : `${k} missing (the cell's proxy injects it)`, code: 'KEY_MISSING',
      fix: { next: 'ask_user', user_message: `set ${k} in this host's environment (the metering proxy is the only process that reads it)`, verify: [...FRONT, 'doctor', '--for', forWhat] } });
  }
  if (remote) {
    let runner: string | null = null, why = '';
    try { runner = resolveRunner(env); } catch (e) { why = e instanceof ScoreboardError ? e.op.message : (e as Error).message; }
    add({ id: 'executor', ok: !!runner, severity: 'error', detail: runner ? `VM executor ${runner}` : why, code: 'RUNNER_UNRESOLVED',
      fix: { next: 'run', argv: ['git', 'checkout', '--', 'scripts/ubicloud/ubi-runner.sh'], verify: [...FRONT, 'doctor', '--for', forWhat] } });
    const owner = ownerTag(env.UBI_OWNER);
    add({ id: 'ubi-owner', ok: !!owner, severity: 'error', detail: owner ? `VMs are tagged ${owner}` : 'UBI_OWNER is not set', code: 'OWNER_UNSET',
      fix: { next: 'run', argv: ['export', 'UBI_OWNER=<thread code>'], verify: ['bash', 'scripts/ubicloud/ubi-runner.sh', 'owner'] } });
    const tok = !!(env.UBICLOUD_API_TOKEN || env.UBICLOUD_API_KEY);
    add({ id: 'ubicloud-token', ok: tok, severity: 'error', detail: tok ? 'Ubicloud token present' : 'no UBICLOUD_API_TOKEN or UBICLOUD_API_KEY', code: 'KEY_MISSING',
      fix: { next: 'ask_user', user_message: 'set UBICLOUD_API_TOKEN on this launching host', verify: [...FRONT, 'doctor', '--for', forWhat] } });
  }
  if (forWhat === 'sealed') {
    const log = env.GBRAIN_EVALS_CUSTODY_LOG;
    const custodian = !!log && existsSync(log) && !onCapyMachine(env);
    add({ id: 'custody', ok: custodian, severity: 'error', detail: custodian ? `custody log ${log}` : 'this is not the custodian host (no GBRAIN_EVALS_CUSTODY_LOG, or a Capy machine)', code: 'CUSTODY_REQUIRED',
      fix: { next: 'tell_user_to_run', argv: [...FRONT, 'doctor', '--for', 'sealed'], user_message: 'sealed cells launch only from the custodian host, where the sealed data, rows and snapshots stay' } });
  }
  // Datasets: the named cells' (every cell's without --cell), and a dev smoke's own conversations only, so preflight never
  // asks this host to download a sealed conversation it will not read.
  const named = many(a, '--cell');
  const datasets = new Map<string, Set<string> | null>(many(a, '--benchmark').map(b => [b, null]));
  for (const c of (loaded?.manifest.cells ?? []).filter(x => !named.length || named.includes(x.id))) {
    const prior = datasets.has(c.benchmark) ? datasets.get(c.benchmark)! : new Set<string>();
    datasets.set(c.benchmark, prior && c.conversations ? new Set([...prior, ...c.conversations]) : null);
  }
  for (const b of [...datasets.keys()].sort()) {
    if (!PUBLIC_BENCHMARKS.has(b)) { add({ id: `dataset:${b}`, ok: null, severity: 'warn', detail: `${b}: held by the custodian; never opened here` }); continue; }
    const only = datasets.get(b) ?? undefined;
    const fetchArgv = ['bun', 'run', 'eval:decide', 'fetch', '--benchmark', b, ...(only ? ['--conversations', [...only].sort().join(',')] : [])];
    const files = filesFor(b, only);
    const bad = files.filter(f => { const p = join(DATASET_ROOT, f.path); return !existsSync(p) || sha256(readFileSync(p)) !== f.sha256; });
    add({ id: `dataset:${b}`, ok: !bad.length, severity: err(forWhat === 'local'), detail: bad.length ? `${b}: ${bad.length} of ${files.length} files missing or not the pinned bytes` : `${b}: ${files.length} files match their pinned sha256`, code: 'PREFLIGHT_FAILED',
      fix: { next: 'run', argv: fetchArgv, verify: [...fetchArgv, '--verify-only'] } });
  }
  if (manifestPath && stateDir && loaded) {
    const legacy = ledgerPaths(resolve(REPO_ROOT, loaded.manifest.ledger)).legacy;
    if (resolve(stateDir, 'campaign.json') === legacy) {
      const fixed = join(stateDir, 'state');
      add({ id: 'state-dir', ok: false, severity: 'error', code: 'USAGE', detail: `--state ${stateDir} would put the campaign state file at ${legacy}, where the budget ledger reads a legacy ledger file and refuses to spend; use --state ${fixed}`,
        fix: { next: 'run', argv: [...FRONT, 'doctor', '--campaign', manifestPath, '--state', fixed, '--for', forWhat] } });
    }
    if (existsSync(join(stateDir, 'campaign.json'))) {
      try {
        const c = new Campaign(manifestPath, resolve(stateDir));
        const st = c.status();
        add({ id: 'ledger', ok: true, severity: 'warn', detail: `$${(st.committed_usd ?? 0).toFixed(2)} held of $${c.manifest.cap_usd.toFixed(2)} ($${st.unsettled_usd.toFixed(2)} charged at full reservation)` });
        try { c.verifyFrozen('reserve'); add({ id: 'freeze', ok: true, severity: 'error', detail: `tree matches the frozen hash ${c.sha256.slice(0, 12)}` }); }
        catch (e) { if (!(e instanceof ScoreboardError)) throw e; add({ id: 'freeze', ok: false, severity: 'error', detail: e.op.message, code: e.op.code, fix: e.op.fix }); }
      } catch (e) { add({ id: 'ledger', ok: false, severity: 'error', detail: (e as Error).message, code: 'CAMPAIGN_STATE_MISSING' }); }
    } else add({ id: 'ledger', ok: null, severity: 'warn', detail: `${stateDir} has no campaign yet (run initializes it)` });
  }
  return { ok: !checks.some(c => c.ok === false && c.severity === 'error'), for: forWhat, checks };
}

/** Throw the first failed error check as its operator message (exit 2/3), carrying every failed check in `state`. */
function failPreflight(r: Awaited<ReturnType<typeof doctor>>): void {
  const bad = r.checks.filter(c => c.ok === false && c.severity === 'error');
  if (!bad.length) return;
  const first = bad[0];
  throw refuse({ code: first.code ?? 'PREFLIGHT_FAILED', message: `preflight (${r.for}) failed before any lease: ${bad.map(c => `${c.id}: ${c.detail}`).join('; ')}`,
    why: 'doctor runs before a lease is reserved, so a missing key, an unpriced model or a broken executor costs nothing',
    fix: first.fix ?? { next: 'run', argv: [...FRONT, 'doctor', '--for', r.for] }, state: { failed: bad.map(c => c.id) } });
}

// ─── plan ───────────────────────────────────────────────────────────

export function plan(manifestPath: string, stateDir?: string) {
  const loaded = loadCampaign(manifestPath);
  const m = loaded.manifest;
  const waves = planWaves(m);
  const state = stateDir ?? `eval/reports/scoreboard/${m.campaign_id}/state`;
  const cmd = (sub: string, ...x: string[]) => [...FRONT, sub, '--campaign', manifestPath, '--state', state, ...x].join(' ');
  const cells = m.cells.map(c => ({ id: c.id, system: c.system, benchmark: c.benchmark, config: c.config, block: c.block ?? null, lease_usd: c.lease_usd, vm: c.vm?.size ?? 'standard-8', vcpu: vcpuOf(c),
    wave: waves.find(w => w.cells.includes(c.id))!.wave, timeout_hours: c.timeout_hours ?? null, expected_hours: c.expected_hours ?? null, sealed: !!c.sealed, smoke: !!c.smoke,
    command: cmd('run', '--cell', c.id, ...(c.sealed ? ['--sealed'] : [])) }));
  const blocks = Object.entries(m.blocks ?? {}).map(([b, v]) => ({ block: b, estimate_usd: v.estimate_usd, cap_usd: v.cap_usd, leases_usd: Math.round(m.cells.filter(c => c.block === b).reduce((n, c) => n + c.lease_usd, 0) * 100) / 100 }));
  const leases = Math.round(m.cells.reduce((n, c) => n + c.lease_usd, 0) * 100) / 100;
  return {
    campaign_id: m.campaign_id, kind: m.kind, sha256: loaded.sha256, cap_usd: m.cap_usd, leases_usd: leases, over_cap: leases > m.cap_usd,
    schedule: { vcpu_cap_day: m.schedule?.vcpu_cap_day ?? 128, vcpu_cap_night: m.schedule?.vcpu_cap_night ?? 200, waves: waves.map(w => ({ ...w, cells: w.cells.length, cell_ids: w.cells })) },
    blocks, cells,
    commands: [cmd('doctor'), ...m.cells.filter(c => c.smoke).map(c => cmd('smoke', '--cell', c.id)), ...waves.map(w => cmd('run', '--wave', String(w.wave))), cmd('status'), cmd('render')],
  };
}

function renderPlan(p: ReturnType<typeof plan>): string {
  return [
    `Campaign ${p.campaign_id} (${p.kind}), hash ${p.sha256.slice(0, 12)}: ${p.cells.length} cells, leases $${p.leases_usd.toFixed(2)} of a $${p.cap_usd.toFixed(2)} cap${p.over_cap ? ' (OVER THE CAP: the plan needs a cap decision or a smaller scope)' : ''}.`, '',
    '| Wave | Cells | vCPU | Expected hours |', '|---:|---:|---:|---:|', ...p.schedule.waves.map(w => `| ${w.wave} | ${w.cells} | ${w.vcpu} | ${w.expected_hours || 'n/a'} |`), '',
    ...(p.blocks.length ? ['| Block | Estimate | Cap | Leases |', '|---|---:|---:|---:|', ...p.blocks.map(b => `| ${b.block} | $${b.estimate_usd} | $${b.cap_usd} | $${b.leases_usd} |`), ''] : []),
    '| Cell | System | Benchmark | Config | Block | Lease | VM | Wave | Timeout h |', '|---|---|---|---|---|---:|---|---:|---:|',
    ...p.cells.map(c => `| ${c.id} | ${c.system} | ${c.benchmark} | ${c.config} | ${c.block ?? ''} | $${c.lease_usd} | ${c.vm} | ${c.wave} | ${c.timeout_hours ?? ''} |`), '',
    'Commands:', ...p.commands.map(c => `  ${c}`),
  ].join('\n');
}

// ─── run / smoke ────────────────────────────────────────────────────

/** The local executor: the same remote command, on this machine. */
const localRunner: Runner = async argv => {
  const p = Bun.spawn(argv, { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit', env: process.env });
  return p.exited;
};

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = s.port as number;
  s.stop(true);
  return port;
}

const cellFailed = (l: LeaseState) => l.timed_out || (l.exit_code !== undefined && l.exit_code !== 0) || (l.cell_exit_code !== undefined && l.cell_exit_code !== null && l.cell_exit_code !== 0) || l.status !== 'settled';

export async function runCells(a: Args, opts: { smoke?: boolean; runner?: Runner } = {}): Promise<Result> {
  const manifest = one(a, '--campaign'), state = one(a, '--state');
  if (!manifest || !state) throw refuse({ code: 'USAGE', message: `${opts.smoke ? 'smoke' : 'run'} needs --campaign <manifest.json> and --state <dir>`, why: 'every cell belongs to one campaign and its lease state',
    fix: { next: 'run', argv: [...FRONT, 'plan', '--campaign', '<manifest.json>'] } });
  const local = has(a, '--local'), sealed = has(a, '--sealed'), dry = has(a, '--dry-run');
  const c = new Campaign(manifest, resolve(state));
  const wave = one(a, '--wave');
  let ids = one(a, '--cell') ? [one(a, '--cell')!] : one(a, '--cells') ? one(a, '--cells')!.split(',').filter(Boolean)
    : wave ? planWaves(c.manifest).find(w => w.wave === Number(wave))?.cells ?? [] : opts.smoke ? c.manifest.cells.filter(x => x.smoke).map(x => x.id) : [];
  if (!ids.length) throw refuse({ code: 'USAGE', message: wave ? `wave ${wave} has no cells` : 'name the cells: --cell <id>, --cells a,b or --wave N', why: 'run never launches a whole campaign by accident',
    fix: { next: 'run', argv: [...FRONT, 'plan', '--campaign', manifest, '--state', state] } });
  const cells = ids.map(id => c.cell(id));
  if (opts.smoke) {
    const notSmoke = cells.filter(x => !x.smoke).map(x => x.id);
    if (notSmoke.length) throw refuse({ code: 'USAGE', message: `smoke runs only smoke cells; ${notSmoke.join(', ')} ${notSmoke.length > 1 ? 'are' : 'is'} not marked smoke`, why: 'a 20-question smoke per system and set runs before its paid cells',
      fix: { next: 'run', argv: [...FRONT, 'run', '--campaign', manifest, '--state', state, '--cell', notSmoke[0]] } });
  }
  const sealedCells = cells.filter(x => x.sealed || !PUBLIC_BENCHMARKS.has(x.benchmark));
  if (sealedCells.length && local) throw refuse({ code: 'SEALED_CELL_LOCAL', message: `run --local is for public sets; ${sealedCells.map(x => x.id).join(', ')} ${sealedCells.length > 1 ? 'are' : 'is'} sealed`,
    why: 'sealed cells launch only from the custodian host with the repository runner, and their rows and snapshots stay there',
    fix: { next: 'tell_user_to_run', argv: [...FRONT, 'run', '--campaign', manifest, '--state', state, '--cell', sealedCells[0].id, '--sealed'], user_message: 'run this on the custodian host' } });
  if (sealedCells.length && !sealed) throw refuse({ code: 'CUSTODY_REQUIRED', message: `${sealedCells.map(x => x.id).join(', ')} ${sealedCells.length > 1 ? 'are' : 'is'} sealed; pass --sealed on the custodian host`,
    why: 'a sealed launch is never implicit: the custodian host keeps dataset caches, rows and snapshots, and only aggregates leave it',
    fix: { next: 'tell_user_to_run', argv: [...FRONT, 'run', '--campaign', manifest, '--state', state, ...ids.flatMap(i => ['--cell', i]).slice(0, 2), '--sealed'], user_message: 'ask the custodian to run this on their host' } });
  const forWhat: DoctorFor = local ? 'local' : sealedCells.length ? 'sealed' : 'run';
  const pre = await doctor(['--campaign', manifest, '--state', state, '--for', forWhat, ...ids.flatMap(id => ['--cell', id])]);
  if (dry) {
    return { data: { dry_run: true, preflight: pre, launcher_host: hostname(), executor: local ? 'this machine (shootout-cell.ts remote)' : (() => { try { return resolveRunner(); } catch { return null; } })(),
      cells: cells.map(x => ({ cell: x.id, rows_to: join(resolve(state), 'results', x.id, '<lease>'), checkpoints_every_rows: isQ1(c.manifest) ? c.manifest.row_pull_every ?? 20 : null,
        teardown: local ? 'the cell command stops its compose stack; nothing to destroy' : 'ubi-runner destroys the VM (and its disk) on every exit path; the launcher stops it half an hour after timeout_hours',
        timeout_hours: x.timeout_hours ?? null })) },
      text: `dry run from ${hostname()}: ${cells.length} cell(s); rows land under ${join(resolve(state), 'results')}; preflight ${pre.ok ? 'passes' : 'FAILS'}` };
  }
  failPreflight(pre);
  c.init();
  const runner = opts.runner ?? (local ? localRunner : ubiRunner(c));
  const results: Array<{ cell: string; lease: string | null; status: string; ok: boolean; exit_code: number | null; cell_exit_code: number | null; timed_out: boolean; note?: string }> = [];
  let capStop: ScoreboardError | null = null;
  for (const cell of cells) {
    if (capStop) break;
    let l: LeaseState;
    try { c.reserve(cell.id); } catch (e) { if (e instanceof ScoreboardError && e.op.code === 'BUDGET_CAP') { capStop = e; break; } throw e; }
    try { l = await c.launch(cell.id, runner, local ? { local: { port: await freePort() } } : {}); }
    catch (e) {
      const open = c.leases().filter(x => x.cell === cell.id).at(-1)!;
      results.push({ cell: cell.id, lease: open.lease_id, status: open.status, ok: false, exit_code: null, cell_exit_code: null, timed_out: false, note: (e as Error).message });
      continue;
    }
    results.push({ cell: cell.id, lease: l.lease_id, status: l.status, ok: !cellFailed(l), exit_code: l.exit_code ?? null, cell_exit_code: l.cell_exit_code ?? null, timed_out: !!l.timed_out });
  }
  closeLedgers();
  const failed = results.filter(r => !r.ok);
  const data = { campaign_id: c.manifest.campaign_id, executor: local ? 'local' : 'ubicloud', results, status: c.status() };
  if (capStop) throw refuse({ ...capStop.op, partial: true, message: `${capStop.op.message}; ${results.length} of ${cells.length} cell(s) ran (${failed.length} failed)`, state: { ...(capStop.op.state ?? {}), results } });
  if (failed.length) throw refuse({ code: failed.some(f => f.timed_out) ? 'CELL_TIMEOUT' : 'CELL_FAILED', message: `${failed.length} of ${results.length} cell(s) failed: ${failed.map(f => `${f.cell} (${f.status}${f.timed_out ? ', timed out' : ''}${f.cell_exit_code ? `, exit ${f.cell_exit_code}` : f.exit_code ? `, runner exit ${f.exit_code}` : ''})`).join(', ')}`,
    why: 'a failed child cell is not a counted result; the launcher exits non-zero so it is never read as success',
    fix: { next: 'run', argv: [...FRONT, 'status', '--campaign', manifest, '--state', state], user_message: 'read the cell logs and pulled rows; a lost VM resumes with `bun eval/runner/shootout-cell.ts resume` after its lease is abandoned (charged in full)',
      verify: [...FRONT, 'status', '--campaign', manifest, '--state', state] }, state: { results } });
  return { data, text: results.map(r => `${r.cell}: ${r.status} (lease ${r.lease})`).join('\n') };
}

// ─── fixture ────────────────────────────────────────────────────────

export const FIXTURE_STUBS = ['generator', 'judge-repeat'] as const;

async function startPython(args: string[], env: Record<string, string>, health: string): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(['python3', ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdout: 'ignore', stderr: 'pipe' });
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) break;
    try { if ((await fetch(health, { keepalive: false })).status < 500) return proc; } catch { await Bun.sleep(50); }
  }
  proc.kill();
  throw new Error(`${args[0]} did not start: ${(await new Response(proc.stderr as ReadableStream).text()).slice(-300)}`);
}

export async function fixture(a: Args): Promise<Result> {
  const stubs = new Set((one(a, '--stub') ?? '').split(',').map(s => s.trim()).filter(Boolean));
  for (const s of stubs) if (!(FIXTURE_STUBS as readonly string[]).includes(s)) throw refuse({ code: 'USAGE', message: `--stub ${s}: stubbable parts are ${FIXTURE_STUBS.join(', ')}`, why: 'only parts other lanes own can be stubbed', fix: { next: 'run', argv: [...FRONT, 'fixture', '--stub', FIXTURE_STUBS.join(',')] } });
  const missing = [['generator', generatorPath()], ['judge-repeat', judgeRepeatPath()]].filter(([part, p]) => !stubs.has(part) && !existsSync(resolve(REPO_ROOT, p))).map(([part]) => part);
  if (missing.length) throw refuse({ code: 'NOT_YET_AVAILABLE', message: `fixture needs ${missing.join(' and ')}, which ${missing.length > 1 ? 'are' : 'is'} not in this checkout`,
    why: 'the fixture runs every stage it can for real and stubs only what you name, so a missing stage is never skipped silently',
    fix: { next: 'run', argv: [...FRONT, 'fixture', '--stub', [...stubs, ...missing].join(',')], verify: [...FRONT, 'fixture', '--stub', [...stubs, ...missing].join(','), '--json'] } });
  const out = resolve(one(a, '--out') ?? mkdtempSync(join(tmpdir(), 'scoreboard-fixture-')));
  mkdirSync(out, { recursive: true });
  const stages: Array<{ stage: string; ms: number; stub?: boolean; detail?: string }> = [];
  const t0 = performance.now();
  const stage = async <T>(name: string, fn: () => Promise<T>, stub = false): Promise<T> => {
    const s = performance.now();
    const v = await fn();
    stages.push({ stage: name, ms: Math.round(performance.now() - s), ...(stub ? { stub: true } : {}) });
    return v;
  };
  const procs: Array<ReturnType<typeof Bun.spawn>> = [];
  let proxy: MeteringProxy | null = null;
  const fail = (msg: string) => refuse({ code: 'FIXTURE_FAILED', message: msg, why: 'the $0 fixture proves the whole pipeline is wired; a failure here would fail a paid run the same way',
    fix: { next: 'run', argv: [...FRONT, 'fixture', '--out', out, '--keep', ...(stubs.size ? ['--stub', [...stubs].join(',')] : [])], user_message: `inspect ${out}`, verify: [...FRONT, 'fixture', '--json', ...(stubs.size ? ['--stub', [...stubs].join(',')] : [])] }, artifact: out });
  try {
    const [shimPort, providerPort] = [await freePort(), await freePort()];
    await stage('shim (reference fake system, protocol v1)', async () => { procs.push(await startPython(['eval/systems/_fake/fake.py'], { SHIM_PORT: String(shimPort) }, `http://127.0.0.1:${shimPort}/health`)); });
    await stage('reader and judge stub (keyless fake provider)', async () => { procs.push(await startPython(['eval/systems/_shim/fake_provider.py', '--port', String(providerPort), '--log', join(out, 'fake-provider.jsonl')], {}, `http://127.0.0.1:${providerPort}/_stats`)); });
    const controlToken = randomUUID(), cellToken = randomUUID();
    const ledgerPath = join(out, 'lease.sqlite');
    const usageLog = join(out, 'usage.ndjson');
    await stage('metering proxy (lease mode, cell token, route caps, admission)', async () => {
      const lease = BudgetRun.openLease({ runId: 'fixture-lease', leaseUsd: 1, ledgerPath, runner: 'scoreboard-fixture' });
      const upstream = `http://127.0.0.1:${providerPort}`;
      proxy = new MeteringProxy({ upstream: { openai: upstream, anthropic: upstream, voyage: upstream }, controlToken, cellToken, trustLocal: true,
        policy: { lease, env: { OPENAI_API_KEY: 'fixture-not-a-provider-key', ANTHROPIC_API_KEY: 'fixture-not-a-provider-key', VOYAGE_API_KEY: 'fixture-not-a-provider-key' }, usageLog,
          routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' },
          admission: new AdmissionController({ openai: { rpm: 6000, tpm: 5_000_000, concurrency: 8 } }) } });
      proxy.start();
    });
    const proxyUrl = `http://127.0.0.1:${proxy!.port}`;
    const cellDir = join(out, 'cell');
    const childEnv: Record<string, string | undefined> = { ...process.env, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken, GBRAIN_EVALS_QA_CACHE: join(out, 'qa-cache'), SHOOTOUT_LEASE_ID: 'fixture-lease' };
    for (const k of KEY_NAMES) delete childEnv[k];
    await stage('harness: ingest, retrieve, packer (native, 8,000 tokens), reader, judge', async () => {
      const p = Bun.spawn([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', '--system', `http://127.0.0.1:${shimPort}`, '--context', 'native', '--budget-tokens', '8000',
        '--qa', 'reader', '--provider-proxy', proxyUrl, '--output', cellDir], { cwd: REPO_ROOT, env: childEnv, stdout: 'pipe', stderr: 'pipe' });
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      writeFileSync(join(out, 'harness.log'), err);
      if (code !== 0) throw fail(`the harness exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`);
    });
    const rows = readFileSync(join(cellDir, 'rows.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>);
    const receipt = JSON.parse(readFileSync(join(cellDir, 'receipt.json'), 'utf8')) as Record<string, any>;
    const reader = String(receipt.qa?.reader ?? 'openai:gpt-4o-mini'), judge = String(receipt.qa?.judge ?? 'openai:gpt-4o-mini');
    await stage('answers and judgments (shared records)', async () => {
      const answers: AnswerRecord[] = rows.map(r => ({ answer_id: answerId('fixture-cell', r.id, reader, 0), cell_id: 'fixture-cell', realization_id: 'real-fixture-cell', question_id: r.id, conversation: r.conversation ?? '', system: r.system ?? 'fake',
        arm: r.policy ?? 'vendor-default', reader, replicate: 0, context_sha256: r.qa_context?.prompt_sha256 ?? sha256(String(r.qa_prompt ?? '')), text: String(r.qa_answer ?? ''), usage: { input: r.qa_input_tokens ?? 0, output: r.qa_output_tokens ?? 0, cache_read: 0, cache_write: 0 },
        provider_input_tokens: r.qa_input_tokens ?? null, latency_ms: null, outcome: (r.outcome ?? 'scored') as Outcome }));
      const judgments: JudgmentRecord[] = rows.map((r, i) => ({ answer_id: answers[i].answer_id, instrument_id: 'fixture:locomo-style', instrument_sha256: sha256('fixture judge prompt'), judge, judge_replicate: 0, temperature: 0,
        score: Number(r.qa_score ?? 0), parse_ok: true, raw_sha256: sha256(JSON.stringify(r.qa_scores ?? [])), outcome: (r.outcome ?? 'scored') as Outcome }));
      writeFileSync(join(out, 'answers.ndjson'), answers.map(x => JSON.stringify(x)).join('\n') + '\n');
      writeFileSync(join(out, 'judgments.ndjson'), judgments.map(x => JSON.stringify(x)).join('\n') + '\n');
    });
    if (stubs.has('judge-repeat')) stages.push({ stage: 'judge repeats', ms: 0, stub: true, detail: 'stubbed: the in-run judge (fake provider) stands in' });
    else await stage('judge repeats (eval/runner/judge-repeat.ts)', async () => {
      const code = await delegate(judgeRepeatPath(), ['--answers', join(out, 'answers.ndjson'), '--cell', cellDir, '--benchmark', 'fixture', '--replicates', '2', '--output', join(out, 'judgments-repeat.ndjson'), '--provider-proxy', proxyUrl], 'fixture judge repeats', undefined, join(out, 'judge-repeat.log'));
      if (code !== 0) throw fail(`judge-repeat exited ${code}`);
    });
    const cs = await stage('cost and speed', async () => {
      const fx = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/data/decide-fixture/conversations.json'), 'utf8')) as { conversations: Array<{ sessions: Array<{ turns: unknown[] }> }> };
      const messages = fx.conversations.reduce((n, c) => n + c.sessions.reduce((m, s) => m + s.turns.length, 0), 0);
      const r = costSpeed({ ...loadCell(cellDir, { usage: usageLog, answers: join(out, 'answers.ndjson') }), messages });
      writeFileSync(join(out, 'cost-speed.json'), JSON.stringify(r, null, 2) + '\n');
      writeFileSync(join(out, 'cost-speed.md'), renderCostSpeed(r));
      return r;
    });
    if (stubs.has('generator')) await stage('generator (stub table)', async () => {
      const scored = rows.filter(r => r.outcome === 'scored');
      const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((x, y) => x + y, 0) / xs.length * 1000) / 1000 : null;
      writeFileSync(join(out, 'scoreboard.md'), ['| System | Accuracy (stub judge) | recall_all@10 | p50 retrieval ms | Billed |', '|---|---:|---:|---:|---:|',
        `| fake | ${mean(scored.map(r => Number(r.qa_score ?? 0)))} | ${mean(scored.filter(r => r.recall_all_at_10 !== undefined).map(r => Number(r.recall_all_at_10)))} | ${cs.latency_ms.retrieval?.p50 ?? 'n/a'} | $${cs.spend.campaign.billed_usd} |`, ''].join('\n'));
    }, true);
    else await stage('generator (eval/runner/scoreboard.ts render and check on the synthetic receipt)', async () => {
      const receiptDir = join(out, 'receipt');
      writeSyntheticReceipt(receiptDir, { draws: 99 });
      for (const sub of ['render', 'check']) {
        const code = await delegate(generatorPath(), [sub, '--receipt', receiptDir], `fixture generator ${sub}`, undefined, join(out, 'generator.log'));
        if (code !== 0) throw fail(`the generator's ${sub} exited ${code} on the synthetic receipt (see generator.log)`);
      }
      if (!existsSync(join(receiptDir, 'scoreboard.md'))) throw fail('the generator wrote no scoreboard.md');
    });
    const st = proxy!.status();
    const usage = usageSplit(usageLog);
    const usageLines = readFileSync(usageLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
    const problems: string[] = [];
    const expected = (receipt.outcomes ? Object.values(receipt.outcomes as Record<string, number>).reduce((x, y) => x + y, 0) : rows.length);
    if (!rows.length || rows.length !== expected) problems.push(`rows ${rows.length}, expected ${expected}`);
    if (rows.some(r => r.outcome !== 'scored')) problems.push(`outcomes ${JSON.stringify(receipt.outcomes)}`);
    if (!st.forwarded) problems.push('no provider request went through the proxy');
    if (st.refused) problems.push(`${st.refused} proxy refusals`);
    if (usageLines.some(u => !u.request_id)) problems.push('a usage line has no request id');
    if (receipt.run_status !== 'complete') problems.push(`run_status ${receipt.run_status}`);
    if (problems.length) throw fail(`fixture checks failed: ${problems.join('; ')}`);
    const data = { ok: true, out, seconds: Math.round((performance.now() - t0) / 100) / 10, stubbed: [...stubs], stages, rows: rows.length, outcomes: receipt.outcomes,
      proxy: { forwarded: st.forwarded, refused: st.refused, unauthorized: st.unauthorized, billed_usd: usage.billed_usd, reserved_unsettled_usd: usage.reserved_unsettled_usd, committed_usd: st.committed_usd },
      cost_speed: { retrieval_ms: cs.latency_ms.retrieval, reader_input_tokens: cs.tokens_per_question.reader_input, personal_monthly: cs.spend.projected_monthly.personal } };
    return { data, text: [`fixture ok in ${data.seconds}s (${rows.length} rows, ${st.forwarded} metered requests, billed $${usage.billed_usd.toFixed(6)} against a keyless fake provider)`,
      ...stages.map(s => `  ${s.stub ? '[stub] ' : ''}${s.stage}: ${s.ms} ms`), `  output: ${out}`].join('\n') };
  } catch (e) {
    if (e instanceof ScoreboardError) throw e;
    throw fail((e as Error).message);
  } finally {
    (proxy as MeteringProxy | null)?.stop();
    for (const p of procs) p.kill();
    closeLedgers();
    if (!has(a, '--keep') && !one(a, '--out')) rmSync(out, { recursive: true, force: true });
  }
}

// ─── status, dispute ────────────────────────────────────────────────

async function status(a: Args): Promise<Result> {
  const manifest = one(a, '--campaign'), state = one(a, '--state');
  if (!manifest || !state) throw refuse({ code: 'USAGE', message: 'status needs --campaign <manifest.json> and --state <dir>', why: 'status reads one campaign\'s lease state', fix: { next: 'run', argv: [...FRONT, 'status', '--campaign', '<manifest.json>', '--state', '<dir>'] } });
  if (!existsSync(join(state, 'campaign.json'))) throw refuse({ code: 'CAMPAIGN_STATE_MISSING', message: `${state} has no campaign yet`, why: 'a campaign starts at its first run (which initializes the ledger and freezes the tree)',
    fix: { next: 'run', argv: [...FRONT, 'plan', '--campaign', manifest, '--state', state] } });
  const c = new Campaign(manifest, resolve(state));
  const progress = await renderProgress(manifest, state);
  const path = one(a, '--progress');
  if (path) writeFileSync(path, progress);
  return { data: { ...c.status(), ...(path ? { progress: path } : {}) }, text: progress };
}

export const DISPUTE = {
  template: '.github/ISSUE_TEMPLATE/scoreboard-dispute.md',
  response_target_days: 7,
  owner: 'the gbrain-evals maintainer thread',
  rule: 'an accepted configuration adds a new row on public dev data (LoCoMo dev) beside the original; it never replaces or edits a published row, and both stay linked',
  evidence: ['the row and column (bun run eval:scoreboard explain <row> <column>)', 'the configuration as a capability-record override', 'the dev rerun command and its output'],
  doc: 'docs/scoreboard.md#dispute-a-row',
};

// ─── entry ──────────────────────────────────────────────────────────

const strip = (a: Args, flags: string[]) => a.filter((x, i) => !flags.includes(x) && !flags.includes(a[i - 1]));

export async function main(argv: string[]): Promise<number> {
  const sub = argv[0] as Subcommand | undefined;
  const a = argv.slice(1);
  const json = argv.includes('--json');
  const emit = (r: Result) => { process.stdout.write((json ? JSON.stringify(r.data, null, 2) : r.text) + '\n'); return r.exit ?? 0; };
  try {
    if (!sub || !SUBCOMMANDS.includes(sub)) throw refuse({ code: 'USAGE', message: sub ? `unknown subcommand ${sub}` : 'name a subcommand', why: `the front door's subcommands are ${SUBCOMMANDS.join(', ')}`,
      fix: { next: 'run', argv: [...FRONT, 'doctor'], user_message: 'see docs/scoreboard.md' } });
    switch (sub) {
      case 'check': return await delegate(generatorPath(), ['check', ...a], 'check');
      case 'explain': {
        const pos = a.filter(x => !x.startsWith('--'));
        if (pos.length < 2) throw refuse({ code: 'USAGE', message: 'explain needs <row> <column>', why: 'explain prints the chain behind one published number', fix: { next: 'run', argv: [...FRONT, 'explain', 'gbrain-defaults', 'beam-10m-8k'] } });
        return await delegate(generatorPath(), ['explain', ...a], 'explain');
      }
      case 'render': {
        const manifest = one(a, '--campaign'), state = one(a, '--state');
        if (manifest && state) new Campaign(manifest, resolve(state)).verifyFrozen('render');
        return await delegate(generatorPath(), ['render', ...strip(a, ['--campaign', '--state'])], 'render');
      }
      case 'judge': return await delegate(judgeRepeatPath(), a, 'judge');
      case 'doctor': {
        const r = await doctor(a);
        const text = [`doctor (${r.for}): ${r.ok ? 'ok' : 'FAILED'}`, ...r.checks.map(c => `  ${c.ok === null ? '-' : c.ok ? 'ok' : c.severity === 'error' ? 'FAIL' : 'warn'} ${c.id}: ${c.detail}`)].join('\n');
        if (!r.ok) { process.stdout.write((json ? JSON.stringify(r, null, 2) : text) + '\n'); failPreflight(r); }
        return emit({ data: r, text });
      }
      case 'plan': {
        const manifest = one(a, '--campaign');
        if (!manifest) throw refuse({ code: 'USAGE', message: 'plan needs --campaign <manifest.json>', why: 'the plan is computed from the authoritative cell manifest', fix: { next: 'run', argv: [...FRONT, 'plan', '--campaign', '<manifest.json>'] } });
        const p = plan(manifest, one(a, '--state'));
        return emit({ data: p, text: renderPlan(p) });
      }
      case 'smoke': return emit(await runCells(a, { smoke: true }));
      case 'run': return emit(await runCells(a));
      case 'status': return emit(await status(a));
      case 'fixture': return emit(await fixture(a));
      case 'dispute': return emit({ data: DISPUTE, text: [`Dispute a row: open an issue with ${DISPUTE.template} (gh issue create --template scoreboard-dispute.md).`,
        `Response target: ${DISPUTE.response_target_days} days, owned by ${DISPUTE.owner}.`, `Rule: ${DISPUTE.rule}.`, `Bring: ${DISPUTE.evidence.join('; ')}.`, `More: ${DISPUTE.doc}`].join('\n') });
    }
  } catch (e) {
    if (e instanceof ScoreboardError) { process.stderr.write((json ? JSON.stringify(e.op, null, 2) : renderMessage(e.op)) + '\n'); return exitCodeOf(e.op); }
    const op: ScoreboardMessage = { code: 'DELEGATE_FAILED', message: (e as Error).message, why: 'an unexpected error stopped the front door', fix: { next: 'report', user_message: 'report this error with the command that produced it' } };
    process.stderr.write((json ? JSON.stringify(op, null, 2) : renderMessage(op)) + '\n');
    return 2;
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));


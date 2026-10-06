/**
 * Open-source memory shootout cells: campaign manifest, durable leases, VM
 * launch and settlement (docs/plans/2026-10-05-oss-memory-shootout/PLAN.md,
 * "Cells and budget"; engineering reviews A2, A5 and Astra 1). Not the
 * embedder-shootout registry entry `shootout-cell` (shootout-driver.ts).
 *
 * A cell (one system, one benchmark slice, one configuration) runs whole on
 * its own Ubicloud VM. Before launch the host ledger reserves the cell's
 * lease from one campaign run whose budget is the campaign cap, so the sum of
 * leases can never pass the cap, across processes and restarts (each reserve
 * is one SQLite transaction). On the VM the metering proxy spends only that
 * lease, in its own ledger. After the VM's results are pulled, the host
 * settles the lease to the VM ledger's committed total. A lease is used once:
 * it is marked launched before the VM starts, a launched lease is never
 * launched again, and a cell that never reports back keeps its full
 * reservation until it is settled or abandoned (charged in full). A retry
 * reserves a new lease from what is left.
 *
 *   bun eval/runner/shootout-cell.ts init    --campaign <manifest.json> --state <dir>
 *   bun eval/runner/shootout-cell.ts reserve --campaign <manifest.json> --state <dir> --cell <id>
 *   bun eval/runner/shootout-cell.ts launch  --campaign <manifest.json> --state <dir> --cell <id> [--dry-run]
 *   bun eval/runner/shootout-cell.ts settle  --campaign <manifest.json> --state <dir> --lease <id>
 *   bun eval/runner/shootout-cell.ts abandon --campaign <manifest.json> --state <dir> --lease <id> --reason <text> [--unstarted --log <launch log>]
 *   bun eval/runner/shootout-cell.ts status  --campaign <manifest.json> --state <dir>
 *   bun eval/runner/shootout-cell.ts hash    --campaign <manifest.json>   (the hash a preregistration records)
 *   bun eval/runner/shootout-cell.ts remote  --cell-b64 <base64 json>        (on the VM: proxy + cell command + lease summary)
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BudgetRun, initLedger, ledgerStatus } from './budget-ledger.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './metering-proxy.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
export const UBI_RUNNER = process.env.UBI_RUNNER ?? '/home/user/.capy/drive/user-garry-tan/skills/ubicloud/scripts/ubi-runner.sh';

export interface CellSpec {
  id: string;
  system: string;
  benchmark: string;
  config: string;
  lease_usd: number;
  /** Output-token cap per provider request, recorded with the lease (proxy default 32,768; Letta asks for 64,000). */
  max_output_tokens?: number;
  /** Shell command run in the synced checkout on the VM, with SHOOTOUT_OUT, SHOOTOUT_PROXY and the proxy base URLs set. */
  command: string;
  /** Local bootstrap script run once on the VM before the command (ubi-runner --setup). */
  setup?: string;
  /** Or a setup command line (for example `bash eval/systems/bootstrap.sh setup --system mem0 --datasets locomo`), written to a script at launch. */
  setup_command?: string;
  vm?: { size?: string; location?: string; storage_gib?: number };
  /** Local environment variables forwarded to the VM; the proxy alone reads them. */
  pass?: string[];
  timeout_hours?: number;
}

export type ParamValue = number | boolean | string;
/** A parameter value the freezing commit must replace; no lease is reserved while one remains. */
export const UNFILLED = 'fill-at-freeze';

export interface CellsFile { kind: 'oss-shootout-cells'; schema_version: 1; system: string; config: string; notes?: string; cells: CellTemplate[] }

/** A cell as written in a manifest: `{{param}}` placeholders, an optional `when` switch and a lease that scales with a parameter. */
export interface CellTemplate extends Omit<CellSpec, 'lease_usd' | 'system' | 'config'> {
  system?: string;
  config?: string;
  lease_usd: number;
  /** Include the cell only when this campaign parameter is true. */
  when?: string;
  /** lease_usd x parameter / base, for a cell whose size a parameter sets (the LongMemEval-S slice). */
  lease_scale?: { param: string; base: number };
  /** How the lease was sized: the pilot measurement or estimate behind it. */
  lease_basis?: string;
}

export interface CampaignManifest {
  kind: 'oss-shootout-campaign'; schema_version: 1; campaign_id: string; cap_usd: number; ledger: string;
  /** Decisions left open in the manifest, substituted into `{{param}}` and `when`. */
  parameters?: Record<string, ParamValue>;
  /** Cell files, relative to the manifest (one per system and configuration). */
  cells_from?: string[];
  cells: CellSpec[];
}

const subst = (text: string, params: Record<string, ParamValue>, where: string) => text.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, k: string) => {
  if (!(k in params)) throw new Error(`${where}: unknown parameter {{${k}}}`);
  return String(params[k]);
});

/** Expand a cell template under the campaign parameters; null when its `when` switch is off. */
export function expandCell(t: CellTemplate, params: Record<string, ParamValue>, where: string, defaults: { system: string; config: string }): CellSpec | null {
  if (t.when !== undefined) {
    if (!(t.when in params)) throw new Error(`${where}: cell ${t.id} names unknown parameter ${t.when}`);
    if (params[t.when] !== true) return null;
  }
  if (t.lease_scale && !(t.lease_scale.param in params)) throw new Error(`${where}: cell ${t.id} scales by unknown parameter ${t.lease_scale.param}`);
  const scale = t.lease_scale ? Number(params[t.lease_scale.param]) / t.lease_scale.base : 1;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`${where}: cell ${t.id} lease scale is not a positive number`);
  const { when: _w, lease_scale: _s, lease_basis: _b, ...rest } = t;
  return { ...rest, system: t.system ?? defaults.system, config: t.config ?? defaults.config, id: subst(t.id, params, where), lease_usd: Math.ceil(t.lease_usd * scale * 100) / 100, command: subst(t.command, params, where),
    ...(t.setup_command ? { setup_command: subst(t.setup_command, params, where) } : {}) };
}

/** The campaign hash covers the campaign file, every cell file and every arms file a cell command names. */
export function loadCampaign(path: string): { manifest: CampaignManifest; sha256: string } {
  const text = readFileSync(path, 'utf8');
  const m = JSON.parse(text) as CampaignManifest;
  const params = m.parameters ?? {};
  const hash = createHash('sha256').update(text);
  const cells: CellSpec[] = [...(m.cells ?? [])];
  for (const rel of m.cells_from ?? []) {
    const file = resolve(dirname(resolve(path)), rel);
    const t = readFileSync(file, 'utf8');
    hash.update(`\u0000${rel}\u0000${t}`);
    const f = JSON.parse(t) as CellsFile;
    if (f.kind !== 'oss-shootout-cells' || f.schema_version !== 1) throw new Error(`${file}: kind must be oss-shootout-cells, schema_version 1`);
    for (const c of f.cells ?? []) { const e = expandCell(c, params, file, { system: f.system, config: f.config }); if (e) cells.push(e); }
  }
  m.cells = cells;
  const armsFiles = [...new Set(cells.flatMap(c => [...c.command.matchAll(/--arms (\S+)/g)].map(x => x[1])))].sort();
  for (const f of armsFiles) if (existsSync(resolve(REPO_ROOT, f))) hash.update(`\u0000${f}\u0000${readFileSync(resolve(REPO_ROOT, f), 'utf8')}`);
  const problems: string[] = [];
  for (const f of armsFiles) if (!existsSync(resolve(REPO_ROOT, f))) problems.push(`arms file ${f} does not exist`);
  if (m.kind !== 'oss-shootout-campaign' || m.schema_version !== 1) problems.push('kind must be oss-shootout-campaign, schema_version 1');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(m.campaign_id ?? '')) problems.push('campaign_id must be 1-64 characters of [A-Za-z0-9._-]');
  if (!(m.cap_usd > 0)) problems.push('cap_usd must be positive');
  if (typeof m.ledger !== 'string' || !m.ledger) problems.push('ledger must name the campaign ledger file');
  const ids = new Set<string>();
  for (const c of m.cells ?? []) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(c.id ?? '')) problems.push(`cell id ${JSON.stringify(c.id)} must be 1-80 characters of [A-Za-z0-9._-]`);
    if (ids.has(c.id)) problems.push(`duplicate cell ${c.id}`);
    ids.add(c.id);
    if (!(c.lease_usd > 0)) problems.push(`cell ${c.id}: lease_usd must be positive`);
    if (c.max_output_tokens !== undefined && !(Number.isInteger(c.max_output_tokens) && c.max_output_tokens > 0)) problems.push(`cell ${c.id}: max_output_tokens must be a positive integer`);
    if (typeof c.command !== 'string' || !c.command.trim()) problems.push(`cell ${c.id}: command is required`);
    if (c.setup !== undefined && !existsSync(resolve(REPO_ROOT, c.setup)) && !existsSync(resolve(c.setup))) problems.push(`cell ${c.id}: setup ${c.setup} does not exist`);
    if (c.setup !== undefined && c.setup_command !== undefined) problems.push(`cell ${c.id}: give setup or setup_command, not both`);
  }
  if (!m.cells?.length) problems.push('cells must list at least one cell');
  if (problems.length) throw new Error(`campaign manifest ${path}: ${problems.join('; ')}`);
  return { manifest: m, sha256: hash.digest('hex') };
}

export type LeaseEvent =
  | { event: 'reserved'; lease_id: string; cell: string; attempt: number; usd: number; entry_id: string; at: string; max_output_tokens: number | null }
  | { event: 'launched'; lease_id: string; at: string; argv: string[] }
  | { event: 'finished'; lease_id: string; at: string; exit_code: number | null }
  | { event: 'settled'; lease_id: string; at: string; actual_usd: number; requests: number; max_output_tokens: number | null }
  | { event: 'abandoned'; lease_id: string; at: string; reason: string; unstarted?: { evidence: string } };

export interface LeaseState { lease_id: string; cell: string; attempt: number; usd: number; entry_id: string; max_output_tokens: number | null; status: 'reserved' | 'launched' | 'finished' | 'settled' | 'abandoned'; actual_usd?: number; exit_code?: number | null }

interface CampaignState { campaign_id: string; run_id: string; ledger: string; manifest_sha256: string; created_at: string }

export class Campaign {
  readonly manifest: CampaignManifest;
  readonly ledger: string;
  private sha: string;
  constructor(manifestPath: string, readonly stateDir: string) {
    const loaded = loadCampaign(manifestPath);
    this.manifest = loaded.manifest;
    this.sha = loaded.sha256;
    this.ledger = resolve(REPO_ROOT, this.manifest.ledger);
    mkdirSync(stateDir, { recursive: true });
  }
  private get statePath() { return join(this.stateDir, 'campaign.json'); }
  private get eventsPath() { return join(this.stateDir, 'leases.ndjson'); }
  private state(): CampaignState {
    if (!existsSync(this.statePath)) throw new Error(`${this.stateDir} has no campaign; run \`bun eval/runner/shootout-cell.ts init\` first`);
    const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as CampaignState;
    if (s.campaign_id !== this.manifest.campaign_id) throw new Error(`${this.stateDir} belongs to campaign ${s.campaign_id}, not ${this.manifest.campaign_id}`);
    return s;
  }
  private run(): BudgetRun { const s = this.state(); return BudgetRun.join({ runId: s.run_id, ledgerPath: s.ledger, programCapMaxUsd: this.manifest.cap_usd }); }
  private append(e: LeaseEvent) { appendFileSync(this.eventsPath, JSON.stringify(e) + '\n'); }
  cell(id: string): CellSpec { const c = this.manifest.cells.find(x => x.id === id); if (!c) throw new Error(`no cell ${id} in campaign ${this.manifest.campaign_id}`); return c; }

  /** Create the campaign ledger (its program cap is the campaign cap) and the one campaign run every lease reserves from. */
  init(): CampaignState {
    if (existsSync(this.statePath)) return this.state();
    if (!existsSync(this.ledger)) initLedger({ ledgerPath: this.ledger, programCapUsd: this.manifest.cap_usd, reason: `oss shootout campaign ${this.manifest.campaign_id}` });
    const run = BudgetRun.open({ runner: `oss-shootout:${this.manifest.campaign_id}`, budgetUsd: this.manifest.cap_usd, ledgerPath: this.ledger, programCapMaxUsd: this.manifest.cap_usd });
    const s: CampaignState = { campaign_id: this.manifest.campaign_id, run_id: run.runId, ledger: this.ledger, manifest_sha256: this.sha, created_at: new Date().toISOString() };
    writeFileSync(this.statePath, JSON.stringify(s, null, 2) + '\n');
    return s;
  }

  leases(): LeaseState[] {
    const out = new Map<string, LeaseState>();
    if (!existsSync(this.eventsPath)) return [];
    for (const line of readFileSync(this.eventsPath, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line) as LeaseEvent;
      if (e.event === 'reserved') { out.set(e.lease_id, { lease_id: e.lease_id, cell: e.cell, attempt: e.attempt, usd: e.usd, entry_id: e.entry_id, max_output_tokens: e.max_output_tokens ?? null, status: 'reserved' }); continue; }
      const l = out.get(e.lease_id);
      if (!l) continue;
      if (e.event === 'launched') l.status = 'launched';
      else if (e.event === 'finished') { l.status = 'finished'; l.exit_code = e.exit_code; }
      else if (e.event === 'settled') { l.status = 'settled'; l.actual_usd = e.actual_usd; }
      else if (e.event === 'abandoned') { l.status = 'abandoned'; if (e.unstarted) l.actual_usd = 0; }
    }
    return [...out.values()];
  }
  lease(id: string): LeaseState { const l = this.leases().find(x => x.lease_id === id); if (!l) throw new Error(`no lease ${id}`); return l; }

  /** Reserve a new lease for a cell; refused while the cell holds an unsettled lease, or when the campaign cap would be passed. */
  reserve(cellId: string): LeaseState {
    const unfilled = Object.entries(this.manifest.parameters ?? {}).filter(([, v]) => v === UNFILLED).map(([k]) => k);
    if (unfilled.length) throw new Error(`campaign parameters ${unfilled.join(', ')} are still ${UNFILLED}; the freezing commit fills them before any lease`);
    const c = this.cell(cellId);
    const mine = this.leases().filter(l => l.cell === cellId);
    const open = mine.find(l => l.status === 'reserved' || l.status === 'launched' || l.status === 'finished');
    if (open) throw new Error(`cell ${cellId} already holds lease ${open.lease_id} (${open.status}); settle or abandon it before reserving again`);
    const attempt = mine.length + 1;
    const entry = this.run().reserve(c.lease_usd, `lease ${cellId} attempt ${attempt}`);
    const l: LeaseState = { lease_id: `${cellId}-a${attempt}-${entry.slice(0, 8)}`, cell: cellId, attempt, usd: c.lease_usd, entry_id: entry, max_output_tokens: c.max_output_tokens ?? null, status: 'reserved' };
    this.append({ event: 'reserved', lease_id: l.lease_id, cell: cellId, attempt, usd: c.lease_usd, entry_id: entry, at: new Date().toISOString(), max_output_tokens: l.max_output_tokens });
    return l;
  }

  resultsDir(l: LeaseState) { return join(this.stateDir, 'results', l.cell, l.lease_id); }

  /** The ubi-runner invocation for a lease: provision, sync, set up, run the cell remotely, pull its output, destroy. */
  launchArgv(l: LeaseState): string[] {
    const c = this.cell(l.cell);
    const remoteOut = `eval/reports/shootout/${l.cell}/${l.lease_id}`;
    const payload = Buffer.from(JSON.stringify({ lease_id: l.lease_id, lease_usd: l.usd, max_output_tokens: l.max_output_tokens, command: c.command, out: remoteOut })).toString('base64');
    let setup = c.setup ? (existsSync(resolve(REPO_ROOT, c.setup)) ? resolve(REPO_ROOT, c.setup) : resolve(c.setup)) : null;
    if (c.setup_command) {
      mkdirSync(join(this.stateDir, 'setup'), { recursive: true });
      setup = join(this.stateDir, 'setup', `${l.cell}.sh`);
      writeFileSync(setup, `set -euo pipefail\n${c.setup_command}\n`);
    }
    return ['bash', UBI_RUNNER, 'run', '-s', c.vm?.size ?? 'standard-8', '-l', c.vm?.location ?? 'eu-central-h1', ...(c.vm?.storage_gib ? ['-S', String(c.vm.storage_gib)] : []),
      ...(setup ? ['--setup', setup] : []), ...(c.pass ?? []).flatMap(p => ['--pass', p]),
      '--pull', `work/${basename(REPO_ROOT)}/${remoteOut}:${dirname(this.resultsDir(l))}`,
      '--', `bun eval/runner/shootout-cell.ts remote --cell-b64 ${payload}`];
  }

  /**
   * Launch a reserved lease. The launch is recorded before the VM starts, so a
   * crash at any point leaves a launched lease that is never launched again.
   */
  async launch(cellId: string, runner: (argv: string[]) => Promise<number | null>): Promise<LeaseState> {
    const l = this.leases().find(x => x.cell === cellId && x.status === 'reserved');
    if (!l) {
      const used = this.leases().find(x => x.cell === cellId && (x.status === 'launched' || x.status === 'finished'));
      throw new Error(used ? `lease ${used.lease_id} was already launched; a lease is used once (settle or abandon it, then reserve again)` : `cell ${cellId} has no reserved lease; run reserve first`);
    }
    const argv = this.launchArgv(l);
    mkdirSync(this.resultsDir(l), { recursive: true });
    this.append({ event: 'launched', lease_id: l.lease_id, at: new Date().toISOString(), argv });
    const code = await runner(argv);
    this.append({ event: 'finished', lease_id: l.lease_id, at: new Date().toISOString(), exit_code: code });
    if (existsSync(join(this.resultsDir(l), 'lease-summary.json')) || existsSync(join(this.resultsDir(l), 'lease.sqlite'))) return this.settle(l.lease_id);
    return this.lease(l.lease_id);
  }

  /** Settle a lease to the committed total of its VM ledger (pulled into the results directory). */
  settle(leaseId: string): LeaseState {
    const l = this.lease(leaseId);
    if (l.status === 'settled' || l.status === 'abandoned') throw new Error(`lease ${leaseId} is already ${l.status}`);
    if (l.status === 'reserved') throw new Error(`lease ${leaseId} was never launched; abandon it instead`);
    const dir = this.resultsDir(l);
    let committed: number, requests: number, leaseUsd: number, runId: string, maxOut: number | null;
    if (existsSync(join(dir, 'lease.sqlite'))) {
      const s = ledgerStatus({ ledgerPath: join(dir, 'lease.sqlite'), runId: leaseId });
      if (!s.run) throw new Error(`the pulled VM ledger has no lease ${leaseId}`);
      ({ committed_usd: committed, budget_usd: leaseUsd, run_id: runId } = s.run);
      requests = BudgetRun.runRequests(join(dir, 'lease.sqlite'), leaseId);
      maxOut = BudgetRun.leaseMaxOutputTokens(join(dir, 'lease.sqlite'), leaseId);
    } else if (existsSync(join(dir, 'lease-summary.json'))) {
      const s = JSON.parse(readFileSync(join(dir, 'lease-summary.json'), 'utf8')) as { run_id: string; lease_usd: number; committed_usd: number; requests: number; max_output_tokens?: number | null };
      ({ committed_usd: committed, lease_usd: leaseUsd, run_id: runId, requests } = s);
      maxOut = s.max_output_tokens ?? null;
    } else throw new Error(`no VM ledger or lease summary pulled into ${dir}; the lease keeps its full reservation (abandon it to close it)`);
    if (runId !== leaseId) throw new Error(`the pulled ledger is for lease ${runId}, not ${leaseId}`);
    if (Math.abs(leaseUsd - l.usd) > 1e-9) throw new Error(`the pulled ledger's lease is $${leaseUsd}, the host reserved $${l.usd}`);
    this.run().settle(l.entry_id, { usd: committed });
    this.append({ event: 'settled', lease_id: leaseId, at: new Date().toISOString(), actual_usd: committed, requests, max_output_tokens: maxOut ?? null });
    return this.lease(leaseId);
  }

  /**
   * Close a lease whose VM never reported back: charged at its full reservation.
   * With `unstarted`, the lease settles at $0 instead, but only when its launch
   * log shows ubi-runner never reached the cell command (the only process that
   * starts the metering proxy, which alone holds the keys) and no VM ledger
   * was pulled. The log is copied into the state directory as evidence.
   */
  abandon(leaseId: string, reason: string, unstarted?: { log: string }): LeaseState {
    const l = this.lease(leaseId);
    if (l.status === 'settled' || l.status === 'abandoned') throw new Error(`lease ${leaseId} is already ${l.status}`);
    if (!reason.trim()) throw new Error('abandon needs --reason');
    if (!unstarted) {
      this.run().settle(l.entry_id, null);
      this.append({ event: 'abandoned', lease_id: leaseId, at: new Date().toISOString(), reason });
      return this.lease(leaseId);
    }
    if (l.status === 'reserved') throw new Error(`lease ${leaseId} was never launched; --unstarted is for a launch that died before the cell command`);
    const dir = this.resultsDir(l);
    if (existsSync(join(dir, 'lease.sqlite')) || existsSync(join(dir, 'lease-summary.json'))) throw new Error(`a VM ledger was pulled into ${dir}; settle the lease instead`);
    const log = readFileSync(unstarted.log, 'utf8');
    if (/ubi-runner: running on /.test(log)) throw new Error(`${unstarted.log} shows ubi-runner reached the cell command; the lease cannot be closed at $0`);
    mkdirSync(join(this.stateDir, 'evidence'), { recursive: true });
    const evidence = join(this.stateDir, 'evidence', `${leaseId}.log`);
    writeFileSync(evidence, log);
    this.run().settle(l.entry_id, { usd: 0 });
    this.append({ event: 'abandoned', lease_id: leaseId, at: new Date().toISOString(), reason, unstarted: { evidence } });
    return this.lease(leaseId);
  }

  status() {
    const s = this.state();
    const ledger = ledgerStatus({ ledgerPath: s.ledger, runId: s.run_id });
    return { campaign_id: s.campaign_id, run_id: s.run_id, cap_usd: this.manifest.cap_usd, committed_usd: ledger.run?.committed_usd ?? null, remaining_usd: ledger.run?.remaining_usd ?? null,
      planned_leases_usd: this.manifest.cells.reduce((x, c) => x + c.lease_usd, 0), leases: this.leases() };
  }
}

/** On the VM: start the lease proxy, run the cell command against it, write the lease summary beside the cell's output. */
export async function runRemote(payload: { lease_id: string; lease_usd: number; max_output_tokens?: number | null; command: string; out: string }, opts: { port?: number } = {}): Promise<number> {
  const out = resolve(payload.out);
  mkdirSync(out, { recursive: true });
  const port = opts.port ?? 8787;
  const ledger = join(out, 'lease.sqlite');
  const controlToken = randomUUID();
  const proxy = Bun.spawn([process.execPath, join(REPO_ROOT, 'eval/runner/metering-proxy.ts'), '--listen', `0.0.0.0:${port}`, '--budget-ledger', ledger, '--lease-usd', String(payload.lease_usd),
    '--run-id', payload.lease_id, '--usage-log', join(out, 'usage.ndjson'), ...(payload.max_output_tokens ? ['--max-output-tokens', String(payload.max_output_tokens)] : []), '--control-token', controlToken], { stdout: 'inherit', stderr: 'inherit' });
  let code: number | null = null;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/__proxy/status`)).ok; } catch { await Bun.sleep(50); } }
    if (!up) throw new Error('the metering proxy did not start');
    const base = `http://127.0.0.1:${port}`;
    const env: Record<string, string | undefined> = { ...process.env, SHOOTOUT_OUT: out, SHOOTOUT_PROXY: base, SHOOTOUT_LEASE_ID: payload.lease_id, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken,
      OPENAI_BASE_URL: `${base}/cell/openai/v1`, ANTHROPIC_BASE_URL: `${base}/cell/anthropic`, VOYAGE_BASE_URL: `${base}/cell/voyage/v1` };
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) if (env[k]) env[k] = 'dummy-key-the-proxy-replaces';
    // Not a login shell: a login profile can re-export the real keys over the dummy ones.
    const cell = Bun.spawn(['bash', '-c', payload.command], { cwd: REPO_ROOT, env, stdout: 'inherit', stderr: 'inherit' });
    code = await cell.exited;
  } finally {
    proxy.kill('SIGTERM');
    await proxy.exited;
    const s = ledgerStatus({ ledgerPath: ledger, runId: payload.lease_id });
    writeFileSync(join(out, 'lease-summary.json'), JSON.stringify({ run_id: payload.lease_id, lease_usd: payload.lease_usd, committed_usd: s.run?.committed_usd ?? payload.lease_usd,
      requests: s.run ? BudgetRun.runRequests(ledger, payload.lease_id) : null, max_output_tokens: s.run ? BudgetRun.leaseMaxOutputTokens(ledger, payload.lease_id) ?? DEFAULT_MAX_OUTPUT_TOKENS : null, cell_exit_code: code }, null, 2) + '\n');
  }
  return code ?? 1;
}

async function ubiRunner(argv: string[]): Promise<number | null> {
  const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit', env: process.env });
  return p.exited;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  try {
    const cmd = argv[0];
    if (cmd === 'remote') {
      process.exit(await runRemote(JSON.parse(Buffer.from(one('--cell-b64') ?? '', 'base64').toString('utf8')), { port: one('--port') ? Number(one('--port')) : undefined }));
    }
    if (cmd === 'hash') {
      const loaded = loadCampaign(one('--campaign') ?? '');
      print({ sha256: loaded.sha256, cells: loaded.manifest.cells.length, parameters: loaded.manifest.parameters ?? {}, leases_usd: loaded.manifest.cells.reduce((x, c) => x + c.lease_usd, 0) });
      process.exit(0);
    }
    const manifest = one('--campaign'), state = one('--state');
    if (!manifest || !state) throw new Error('usage: see the header of eval/runner/shootout-cell.ts (--campaign <manifest.json> --state <dir>)');
    const c = new Campaign(manifest, resolve(state));
    if (cmd === 'init') print(c.init());
    else if (cmd === 'reserve') print(c.reserve(one('--cell') ?? ''));
    else if (cmd === 'launch' && argv.includes('--dry-run')) {
      const l = c.leases().find(x => x.cell === one('--cell') && x.status === 'reserved');
      if (!l) throw new Error(`cell ${one('--cell')} has no reserved lease`);
      print({ lease: l.lease_id, argv: c.launchArgv(l) });
    } else if (cmd === 'launch') print(await c.launch(one('--cell') ?? '', ubiRunner));
    else if (cmd === 'settle') print(c.settle(one('--lease') ?? ''));
    else if (cmd === 'abandon') print(c.abandon(one('--lease') ?? '', one('--reason') ?? '', argv.includes('--unstarted') ? { log: one('--log') ?? '' } : undefined));
    else if (cmd === 'status') print(c.status());
    else throw new Error(`unknown command ${cmd}`);
  } catch (e) {
    console.error(`[shootout-cell] ${(e as Error).message}`);
    process.exit(2);
  }
}

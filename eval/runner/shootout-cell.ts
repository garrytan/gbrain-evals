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
 *   bun eval/runner/shootout-cell.ts resume  --campaign <manifest.json> --state <dir> --cell <id>   (Q1 campaigns: rerun from a pulled realization)
 *   bun eval/runner/shootout-cell.ts remote  --cell-b64 <base64 json>        (on the VM: proxy + cell command + lease summary)
 *
 * The VM executor is the repository's own scripts/ubicloud/ubi-runner.sh, or
 * the runner UBI_RUNNER names explicitly; nothing defaults to a path outside
 * the repository.
 *
 * Q1 scoreboard campaigns (`kind: q1-scoreboard-campaign`, docs/scoreboard.md)
 * add, on top of the shootout's cells and leases:
 *   freeze    the campaign hash also covers the git tree (blob ids of the
 *             working files) of every path in `executes` (adapters, scorer,
 *             packer, instruments, lockfiles) and every image digest in
 *             `images`; reserve, launch, resume and render refuse when the
 *             tree no longer matches the hash stored at init, naming the
 *             changed paths. An execution-affecting change after freeze needs
 *             a new campaign identity.
 *   timeout   a cell's `timeout_hours` reaches the VM (the cell command is
 *             stopped at the deadline, exit 124) and the launcher (the VM run
 *             is stopped half an hour later, which tears the VM down).
 *   rows      the VM checkpoints the cell's output every `row_pull_every`
 *             (20) new attempt rows, and the launcher pulls the checkpoint
 *             every `pull_interval_minutes`, so a lost VM costs at most one
 *             interval of rows.
 *   snapshots after ingest (`$SHOOTOUT_OUT/ingest-complete`, or the first
 *             attempt row) the cell's `snapshot_command` writes the store into
 *             `$SHOOTOUT_SNAPSHOT_DIR`; the VM records an immutable ingest
 *             realization id over the snapshot's bytes, and the launcher pulls
 *             it to the launching host.
 *   resume    a cell whose VM was lost reruns its query phase from the pulled
 *             realization (`restore_command`), or, without one, repeats the
 *             whole conversation; a conversation is never partly re-ingested.
 *   metering  the VM's proxy gets the cell token, the campaign's per-route
 *             output caps and the cell's share of each provider's limits.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BudgetRun, initLedger, ledgerStatus } from './budget-ledger.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_ROUTE_CAPS, type ProviderLimits, type ProviderName } from './metering-proxy.ts';
import { refuse, ScoreboardError } from './q1/scoreboard-errors.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
export const REPO_RUNNER = join(REPO_ROOT, 'scripts/ubicloud/ubi-runner.sh');

/** The VM executor: UBI_RUNNER when set, else the repository's runner; never a path outside a checkout by default. */
export function resolveRunner(env: Record<string, string | undefined> = process.env): string {
  const named = env.UBI_RUNNER;
  if (named) {
    if (!existsSync(named)) throw refuse({ code: 'RUNNER_UNRESOLVED', message: `UBI_RUNNER names ${named}, which does not exist`, why: 'cells launch through one explicitly resolved executor, so a launch never picks up a stray script',
      fix: { next: 'run', argv: ['unset', 'UBI_RUNNER'], verify: ['bun', 'run', 'eval:scoreboard', 'doctor'] } });
    if (/\/\.capy\/drive\//.test(resolve(named))) throw refuse({ code: 'RUNNER_UNRESOLVED', message: `UBI_RUNNER names ${named}, a shared drive copy`, why: 'the executor must be the repository-owned scripts/ubicloud/ubi-runner.sh (or a copy the operator pins), so every host launches the same reviewed code',
      fix: { next: 'run', argv: ['unset', 'UBI_RUNNER'], verify: ['bun', 'run', 'eval:scoreboard', 'doctor'] } });
    return resolve(named);
  }
  if (existsSync(REPO_RUNNER)) return REPO_RUNNER;
  throw refuse({ code: 'RUNNER_UNRESOLVED', message: 'no VM executor: scripts/ubicloud/ubi-runner.sh is missing and UBI_RUNNER is unset', why: 'cells launch through the repository-owned runner, never a default outside the checkout',
    fix: { next: 'run', argv: ['git', 'checkout', '--', 'scripts/ubicloud/ubi-runner.sh'], verify: ['bun', 'run', 'eval:scoreboard', 'doctor'] } });
}

export interface CellSpec {
  id: string;
  system: string;
  benchmark: string;
  config: string;
  lease_usd: number;
  /** Output-token cap per provider request, recorded with the lease (proxy default 32,768; the agent runtime asks for 64,000). */
  max_output_tokens?: number;
  /** Shell command run in the synced checkout on the VM, with SHOOTOUT_OUT, SHOOTOUT_PROXY and the proxy base URLs set. */
  command: string;
  /** Local bootstrap script run once on the VM before the command (ubi-runner --setup). */
  setup?: string;
  /** Or a setup command line (for example `bash eval/systems/bootstrap.sh setup --system ext-extract-first --datasets locomo`), written to a script at launch. */
  setup_command?: string;
  vm?: { size?: string; location?: string; storage_gib?: number };
  /** Local environment variables forwarded to the VM; the proxy alone reads them. */
  pass?: string[];
  /** Wall-clock limit for the whole cell; it reaches the VM (cell command stopped, exit 124) and the launcher. */
  timeout_hours?: number;
  /** Q1: the spend block the cell belongs to (campaign `blocks`). */
  block?: string;
  /** Q1: a sealed-set cell that only the custodian's host may launch. */
  sealed?: boolean;
  /** Q1: a paid dev smoke cell (`eval:scoreboard smoke`). */
  smoke?: boolean;
  /** Q1: the only conversations the cell reads (a dev smoke); its preflight checks and fetches just their files. */
  conversations?: string[];
  /** Q1: providers the cell calls, for admission shares (default openai, anthropic, voyage). */
  providers?: ProviderName[];
  /** Q1: expected wall-clock hours, for the schedule. */
  expected_hours?: number;
  /** Q1: an explicit schedule wave (1-based); otherwise the planner packs cells under the vCPU cap. */
  wave?: number;
  /** Q1: run after ingest on the VM; writes the system's store into $SHOOTOUT_SNAPSHOT_DIR. */
  snapshot_command?: string;
  /** Q1: run on the VM before the command when resuming from a realization; reads $SHOOTOUT_RESTORE_DIR. */
  restore_command?: string;
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

export const Q1_KIND = 'q1-scoreboard-campaign';
export const Q1_CAMPAIGN_ID = /^q1-scoreboard(?:-[a-z0-9][a-z0-9.-]{0,40})?$/;

export interface CampaignManifest {
  kind: 'oss-shootout-campaign' | typeof Q1_KIND; schema_version: 1; campaign_id: string; cap_usd: number; ledger: string;
  /** Decisions left open in the manifest, substituted into `{{param}}` and `when`. */
  parameters?: Record<string, ParamValue>;
  /** Cell files, relative to the manifest (one per system and configuration). */
  cells_from?: string[];
  cells: CellSpec[];
  /** Q1: repository paths (files or directories) every cell executes; their git tree is part of the campaign hash. */
  executes?: string[];
  /** Q1: container images by digest (`sha256:<64 hex>` or `<ref>@sha256:<64 hex>`), part of the campaign hash. */
  images?: Record<string, string>;
  /** Q1: the hedge classifier version the derived columns use at render (`none` when no version met its bar, amendment A6). */
  hedge_classifier?: string;
  /** Q1: spend blocks (T1, T2-S2a, ...) with their estimate and hard cap. */
  blocks?: Record<string, { estimate_usd: number; cap_usd: number }>;
  /** Q1: per-route output caps for every cell's proxy (default extraction 4096, reader 2048, judge 1024). */
  output_caps?: Record<string, number>;
  /** Q1: proxy slot to route class (default harness=reader, judge=judge; every other slot is extraction). */
  route_classes?: Record<string, string>;
  /** Q1: each provider key's limits, shared by the cells that run at once. */
  provider_limits?: Partial<Record<ProviderName, ProviderLimits>>;
  /** Q1: vCPU caps per wave (US daytime, Pacific, and overnight). */
  schedule?: { vcpu_cap_day?: number; vcpu_cap_night?: number };
  /** Q1: checkpoint rows every this many attempt rows (default 20). */
  row_pull_every?: number;
  /** Q1: the launcher pulls the VM's checkpoint this often (default 10). */
  pull_interval_minutes?: number;
  /** Q1: every resolved model a cell may call (readers, judges, extraction, gbrain internals), checked priced before any lease. */
  models?: string[];
}

export const isQ1 = (m: Pick<CampaignManifest, 'kind'>) => m.kind === Q1_KIND;
export const DEFAULT_ROUTE_CLASSES: Record<string, string> = { harness: 'reader', judge: 'judge', agent: 'agent' };
export const ROW_PULL_EVERY = 20;

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

export interface TreeEntry { path: string; blob: string }

/** Git blob ids of every working file (tracked, or untracked and not ignored) under `paths`, as `git hash-object` computes them, sorted by path. */
export function executedTree(paths: string[], root = REPO_ROOT): { entries: TreeEntry[]; missing: string[] } {
  const entries = new Map<string, string>();
  const missing: string[] = [];
  for (const p of paths) {
    const listed = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', p], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
    const files = listed.filter(f => existsSync(join(root, f)) && statSync(join(root, f)).isFile());
    if (!files.length) { missing.push(p); continue; }
    for (const f of files) {
      const bytes = readFileSync(join(root, f));
      entries.set(f, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
    }
  }
  return { entries: [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, blob]) => ({ path, blob })), missing };
}

/** Paths whose blob differs between a frozen tree and the current one (changed, added or removed). */
export function treeDiff(frozen: TreeEntry[], current: TreeEntry[]): string[] {
  const a = new Map(frozen.map(e => [e.path, e.blob])), b = new Map(current.map(e => [e.path, e.blob]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();
}

const IMAGE_DIGEST = /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/;

/**
 * The campaign hash covers the campaign file, every cell file and every arms
 * file a cell command names; a Q1 campaign's hash also covers the git tree of
 * its `executes` paths and its image digests (`tree` lists the entries).
 */
export function loadCampaign(path: string): { manifest: CampaignManifest; sha256: string; tree?: TreeEntry[] } {
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
  let tree: TreeEntry[] | undefined;
  if (isQ1(m)) {
    if (!Q1_CAMPAIGN_ID.test(m.campaign_id ?? '')) problems.push('a Q1 campaign_id is q1-scoreboard, or q1-scoreboard-<suffix> for a new campaign identity after an execution-affecting change');
    if (!Array.isArray(m.executes) || !m.executes.length) problems.push('executes must list the repository paths every cell executes (adapters, scorer, packer, instruments, lockfiles)');
    else {
      const t = executedTree(m.executes);
      for (const x of t.missing) problems.push(`executes path ${x} has no files`);
      tree = t.entries;
      for (const e of tree) hash.update(`\u0000tree\u0000${e.path}\u0000${e.blob}`);
    }
    for (const [name, digest] of Object.entries(m.images ?? {}).sort(([a], [b]) => a < b ? -1 : 1)) {
      if (!IMAGE_DIGEST.test(digest)) problems.push(`image ${name} must be pinned by digest (sha256:<64 hex>), not ${JSON.stringify(digest)}`);
      hash.update(`\u0000image\u0000${name}\u0000${digest}`);
    }
    for (const c of cells) {
      if (m.blocks && c.block !== undefined && !(c.block in m.blocks)) problems.push(`cell ${c.id}: block ${c.block} is not in blocks`);
      if (c.timeout_hours !== undefined && !(c.timeout_hours > 0)) problems.push(`cell ${c.id}: timeout_hours must be positive`);
    }
    for (const [k, v] of Object.entries(m.output_caps ?? {})) if (!(Number.isInteger(v) && v > 0)) problems.push(`output_caps.${k} must be a positive integer`);
  } else if (m.kind !== 'oss-shootout-campaign') problems.push(`kind must be oss-shootout-campaign or ${Q1_KIND}, schema_version 1`);
  if (m.schema_version !== 1) problems.push('schema_version must be 1');
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
  return { manifest: m, sha256: hash.digest('hex'), ...(tree ? { tree } : {}) };
}

export type LeaseEvent =
  | { event: 'reserved'; lease_id: string; cell: string; attempt: number; usd: number; entry_id: string; at: string; max_output_tokens: number | null }
  | { event: 'launched'; lease_id: string; at: string; argv: string[]; vm?: string | null; restore?: string | null }
  | { event: 'finished'; lease_id: string; at: string; exit_code: number | null }
  | { event: 'settled'; lease_id: string; at: string; actual_usd: number; requests: number; max_output_tokens: number | null; timed_out?: boolean; cell_exit_code?: number | null }
  | { event: 'abandoned'; lease_id: string; at: string; reason: string; unstarted?: { evidence: string } }
  | { event: 'realized'; lease_id: string; at: string; realization_id: string; dir: string; files: RealizationFile[] };

export interface LeaseState {
  lease_id: string; cell: string; attempt: number; usd: number; entry_id: string; max_output_tokens: number | null;
  status: 'reserved' | 'launched' | 'finished' | 'settled' | 'abandoned'; actual_usd?: number; exit_code?: number | null;
  /** Q1: the VM the lease ran on, the realization its ingest produced, the one it resumed from, and whether the cell hit its timeout. */
  vm?: string | null; realization_id?: string; restored_from?: string | null; timed_out?: boolean; cell_exit_code?: number | null;
  /** What the operator should know about this state (for example, that an abandoned lease is charged in full). */
  note?: string;
}

interface CampaignState { campaign_id: string; run_id: string; ledger: string; manifest_sha256: string; created_at: string; kind?: string }

export interface RealizationFile { path: string; sha256: string; bytes: number }
export interface Realization { realization_id: string; cell: string | null; lease_id: string; campaign_sha256: string | null; created_at: string; trigger: string; files: RealizationFile[]; status: 'complete' | 'failed'; error?: string }

/** What the VM receives (base64 JSON). Q1 fields are present only when the cell or campaign sets them, so a shootout payload is unchanged. */
export interface RemotePayload {
  lease_id: string; lease_usd: number; max_output_tokens?: number | null; command: string; out: string;
  cell?: string; campaign_sha256?: string; timeout_hours?: number; row_pull_every?: number; snapshot_command?: string;
  restore?: { realization_id: string; dir: string; restore_command?: string };
  route_caps?: { caps: Record<string, number>; slots: Record<string, string>; defaultClass: string };
  admission?: Partial<Record<ProviderName, ProviderLimits>>;
}

/** What the executor needs beyond argv: the VM name (Q1), where its output lives remotely and locally, the deadline and the pull interval. */
export interface LaunchContext { lease: LeaseState; cell: CellSpec; vm: string | null; remoteOut: string; resultsDir: string; timeoutMs: number | null; pullEveryMs: number | null; runner: string }
export type Runner = (argv: string[], ctx: LaunchContext) => Promise<number | null>;

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The ubi-runner owner tag (UBI_OWNER, lowercased letters and digits, at most 12, starting with a letter), as the runner computes it. */
export function ownerTag(raw: string | undefined): string | null {
  let t = (raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!t) return null;
  if (!/^[a-z]/.test(t)) t = `u${t}`;
  return t.slice(0, 12);
}

export class Campaign {
  readonly manifest: CampaignManifest;
  readonly ledger: string;
  private sha: string;
  readonly tree: TreeEntry[] | null;
  constructor(readonly manifestPath: string, readonly stateDir: string) {
    const loaded = loadCampaign(manifestPath);
    this.manifest = loaded.manifest;
    this.sha = loaded.sha256;
    this.tree = loaded.tree ?? null;
    this.ledger = resolve(REPO_ROOT, this.manifest.ledger);
    mkdirSync(stateDir, { recursive: true });
  }
  get sha256() { return this.sha; }
  get q1() { return isQ1(this.manifest); }
  private get statePath() { return join(this.stateDir, 'campaign.json'); }
  private get eventsPath() { return join(this.stateDir, 'leases.ndjson'); }
  private get frozenPath() { return join(this.stateDir, 'frozen-tree.json'); }
  private state(): CampaignState {
    if (!existsSync(this.statePath)) throw new Error(`${this.stateDir} has no campaign; run \`bun eval/runner/shootout-cell.ts init\` first`);
    const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as CampaignState;
    if (s.campaign_id !== this.manifest.campaign_id) throw new Error(`${this.stateDir} belongs to campaign ${s.campaign_id}, not ${this.manifest.campaign_id}`);
    return s;
  }
  private run(): BudgetRun { const s = this.state(); return BudgetRun.join({ runId: s.run_id, ledgerPath: s.ledger, programCapMaxUsd: this.manifest.cap_usd }); }
  private append(e: LeaseEvent) { appendFileSync(this.eventsPath, JSON.stringify(e) + '\n'); }
  cell(id: string): CellSpec { const c = this.manifest.cells.find(x => x.id === id); if (!c) throw new Error(`no cell ${id} in campaign ${this.manifest.campaign_id}`); return c; }

  /** Create the campaign ledger (its program cap is the campaign cap) and the one campaign run every lease reserves from. A Q1 campaign also freezes its executed tree. */
  init(): CampaignState {
    if (existsSync(this.statePath)) return this.state();
    const label = this.q1 ? 'q1-scoreboard' : 'oss-shootout';
    if (!existsSync(this.ledger)) initLedger({ ledgerPath: this.ledger, programCapUsd: this.manifest.cap_usd, reason: `${this.q1 ? 'Q1 scoreboard' : 'oss shootout'} campaign ${this.manifest.campaign_id}` });
    const run = BudgetRun.open({ runner: `${label}:${this.manifest.campaign_id}`, budgetUsd: this.manifest.cap_usd, ledgerPath: this.ledger, programCapMaxUsd: this.manifest.cap_usd });
    const s: CampaignState = { campaign_id: this.manifest.campaign_id, run_id: run.runId, ledger: this.ledger, manifest_sha256: this.sha, created_at: new Date().toISOString(), ...(this.q1 ? { kind: Q1_KIND } : {}) };
    if (this.q1) {
      let commit: string | null = null, dirty: string[] = [];
      try {
        commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', ...(this.manifest.executes ?? [])], { encoding: 'utf8' }).split('\n').filter(Boolean).map(l => l.slice(3));
      } catch { commit = null; }
      writeFileSync(this.frozenPath, JSON.stringify({ campaign_id: this.manifest.campaign_id, sha256: this.sha, commit, dirty, images: this.manifest.images ?? {}, tree: this.tree }, null, 2) + '\n');
    }
    writeFileSync(this.statePath, JSON.stringify(s, null, 2) + '\n');
    return s;
  }

  /** Q1: refuse `action` when the files a cell executes no longer hash to the campaign hash stored at init. */
  verifyFrozen(action: 'reserve' | 'launch' | 'resume' | 'render'): void {
    if (!this.q1) return;
    const s = this.state();
    if (s.manifest_sha256 === this.sha) return;
    const frozen = existsSync(this.frozenPath) ? JSON.parse(readFileSync(this.frozenPath, 'utf8')) as { tree: TreeEntry[] | null; commit: string | null; images: Record<string, string> } : { tree: null, commit: null, images: {} };
    const changed = frozen.tree && this.tree ? treeDiff(frozen.tree, this.tree) : [];
    const images = Object.keys({ ...frozen.images, ...(this.manifest.images ?? {}) }).filter(k => frozen.images[k] !== this.manifest.images?.[k]);
    const what = [changed.length ? `${changed.length} executed file(s) changed: ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ', …' : ''}` : '', images.length ? `image digest(s) changed: ${images.join(', ')}` : '',
      !changed.length && !images.length ? 'the campaign manifest, a cells file or an arms file changed' : ''].filter(Boolean).join('; ');
    throw refuse({ code: 'CAMPAIGN_HASH_MISMATCH', message: `${action} refused: campaign ${this.manifest.campaign_id} was frozen at ${s.manifest_sha256.slice(0, 12)}, the tree now hashes to ${this.sha.slice(0, 12)} (${what})`,
      why: 'every counted cell must run the frozen adapters, scorer, packer, instruments, lockfiles and images; a cell run on other code would publish a number the preregistration does not describe',
      fix: { next: 'ask_user', user_message: `Files a counted cell executes changed after the freeze (${what}). Revert them to the frozen commit${frozen.commit ? ` ${frozen.commit.slice(0, 12)}` : ''}, or approve a new campaign identity (a new campaign_id such as ${this.manifest.campaign_id}-r2, recorded in the preregistration before any new cell runs).`,
        argv: frozen.commit && changed.length ? ['git', 'diff', '--stat', frozen.commit, '--', ...changed.slice(0, 12)] : undefined, verify: ['bun', 'eval/runner/shootout-cell.ts', 'hash', '--campaign', this.manifestPath] },
      state: { frozen_sha256: s.manifest_sha256, current_sha256: this.sha, changed, images } });
  }

  leases(): LeaseState[] {
    const out = new Map<string, LeaseState>();
    if (!existsSync(this.eventsPath)) return [];
    for (const line of readFileSync(this.eventsPath, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line) as LeaseEvent;
      if (e.event === 'reserved') { out.set(e.lease_id, { lease_id: e.lease_id, cell: e.cell, attempt: e.attempt, usd: e.usd, entry_id: e.entry_id, max_output_tokens: e.max_output_tokens ?? null, status: 'reserved' }); continue; }
      const l = out.get(e.lease_id);
      if (!l) continue;
      if (e.event === 'launched') { l.status = 'launched'; if (e.vm !== undefined) l.vm = e.vm; if (e.restore !== undefined) l.restored_from = e.restore; }
      else if (e.event === 'finished') { l.status = 'finished'; l.exit_code = e.exit_code; }
      else if (e.event === 'settled') { l.status = 'settled'; l.actual_usd = e.actual_usd; if (e.timed_out) l.timed_out = true; if (e.cell_exit_code !== undefined) l.cell_exit_code = e.cell_exit_code; }
      else if (e.event === 'abandoned') { l.status = 'abandoned'; l.actual_usd = e.unstarted ? 0 : l.usd; }
      else if (e.event === 'realized') l.realization_id = e.realization_id;
    }
    return [...out.values()];
  }
  lease(id: string): LeaseState { const l = this.leases().find(x => x.lease_id === id); if (!l) throw new Error(`no lease ${id}`); return l; }
  private realizedEvents(): Extract<LeaseEvent, { event: 'realized' }>[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LeaseEvent).filter((e): e is Extract<LeaseEvent, { event: 'realized' }> => e.event === 'realized');
  }

  /** Q1: dollars held by a block's leases (reserved, running, settled or abandoned at their charge). */
  blockSpend(block: string): number {
    return this.leases().filter(l => this.manifest.cells.find(c => c.id === l.cell)?.block === block)
      .reduce((n, l) => n + (l.status === 'settled' || l.status === 'abandoned' ? l.actual_usd ?? l.usd : l.usd), 0);
  }

  /** Reserve a new lease for a cell; refused while the cell holds an unsettled lease, or when the campaign cap (or a Q1 block cap) would be passed. */
  reserve(cellId: string): LeaseState {
    this.verifyFrozen('reserve');
    const unfilled = Object.entries(this.manifest.parameters ?? {}).filter(([, v]) => v === UNFILLED).map(([k]) => k);
    if (unfilled.length) throw new Error(`campaign parameters ${unfilled.join(', ')} are still ${UNFILLED}; the freezing commit fills them before any lease`);
    const c = this.cell(cellId);
    const mine = this.leases().filter(l => l.cell === cellId);
    const open = mine.find(l => l.status === 'reserved' || l.status === 'launched' || l.status === 'finished');
    if (open) throw new Error(`cell ${cellId} already holds lease ${open.lease_id} (${open.status}); settle or abandon it before reserving again`);
    const block = c.block !== undefined ? this.manifest.blocks?.[c.block] : undefined;
    if (this.q1 && block && this.blockSpend(c.block!) + c.lease_usd > block.cap_usd + 1e-9) {
      throw refuse({ code: 'BUDGET_CAP', partial: true, message: `cell ${cellId}: block ${c.block} holds ${usd(this.blockSpend(c.block!))} of its ${usd(block.cap_usd)} cap; a ${usd(c.lease_usd)} lease would pass it`,
        why: 'each block stops at 1.5x its estimate so one overrun cannot eat the rest of the campaign; finished cells keep their rows',
        fix: { next: 'ask_user', user_message: `Block ${c.block} reached its cap (estimate ${usd(block.estimate_usd)}, cap ${usd(block.cap_usd)}). Report the overrun and ask whether to stop the block or approve a higher block cap.`, verify: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', this.manifestPath, '--state', this.stateDir] },
        state: { block: c.block, held_usd: this.blockSpend(c.block!), cap_usd: block.cap_usd } });
    }
    const attempt = mine.length + 1;
    let entry: string;
    try { entry = this.run().reserve(c.lease_usd, `lease ${cellId} attempt ${attempt}`); }
    catch (e) {
      if (!this.q1 || (e as Error).name !== 'BudgetExceededError') throw e;
      const st = this.status();
      throw refuse({ code: 'BUDGET_CAP', partial: true, message: `cell ${cellId}: the campaign cap stops this ${usd(c.lease_usd)} lease (${(e as Error).message})`,
        why: 'the sum of leases can never pass the campaign cap; leases that never reported back stay charged at their full reservation until settled or abandoned',
        fix: { next: 'ask_user', user_message: `The ${usd(this.manifest.cap_usd)} campaign cap is reached: ${usd(st.committed_usd ?? 0)} is held, including ${usd(st.unsettled_usd)} in leases still charged at their full reservation. Settle or abandon those, apply the preregistered scope reduction, or ask for a cap decision.`,
          verify: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', this.manifestPath, '--state', this.stateDir] },
        state: { cap_usd: this.manifest.cap_usd, committed_usd: st.committed_usd, remaining_usd: st.remaining_usd, charged_reservations_usd: st.unsettled_usd } });
    }
    const l: LeaseState = { lease_id: `${cellId}-a${attempt}-${entry.slice(0, 8)}`, cell: cellId, attempt, usd: c.lease_usd, entry_id: entry, max_output_tokens: c.max_output_tokens ?? null, status: 'reserved' };
    this.append({ event: 'reserved', lease_id: l.lease_id, cell: cellId, attempt, usd: c.lease_usd, entry_id: entry, at: new Date().toISOString(), max_output_tokens: l.max_output_tokens });
    return l;
  }

  resultsDir(l: LeaseState) { return join(this.stateDir, 'results', l.cell, l.lease_id); }
  remoteOut(l: LeaseState) { return `eval/reports/shootout/${l.cell}/${l.lease_id}`; }

  /** Q1: the VM name, in ubi-runner's ownership format so `list --mine` and teardown find it. */
  vmName(l: LeaseState, env: Record<string, string | undefined> = process.env): string {
    const owner = ownerTag(env.UBI_OWNER);
    if (!owner) throw refuse({ code: 'OWNER_UNSET', message: 'UBI_OWNER is not set', why: 'scoreboard VMs carry their owner in the name so each thread destroys only its own VMs and the quota report shows who uses what',
      fix: { next: 'run', argv: ['export', 'UBI_OWNER=<your thread code, for example gbra49>'], verify: ['bash', 'scripts/ubicloud/ubi-runner.sh', 'owner'] } });
    const suffix = createHash('sha256').update(l.lease_id).digest('hex').slice(0, 6);
    return `ubirun-${owner}-${Math.floor(Date.now() / 1000)}-${suffix}`;
  }

  /** The VM payload for a lease; Q1 cells carry their timeout, checkpoint interval, snapshot command, route caps and admission share. */
  payload(l: LeaseState, restore?: RemotePayload['restore']): RemotePayload {
    const c = this.cell(l.cell);
    const base: RemotePayload = { lease_id: l.lease_id, lease_usd: l.usd, max_output_tokens: l.max_output_tokens, command: c.command, out: this.remoteOut(l) };
    if (c.timeout_hours !== undefined) base.timeout_hours = c.timeout_hours;
    if (!this.q1) return base;
    return { ...base, cell: c.id, campaign_sha256: this.sha, row_pull_every: this.manifest.row_pull_every ?? ROW_PULL_EVERY,
      ...(c.snapshot_command ? { snapshot_command: c.snapshot_command } : {}), ...(restore ? { restore } : {}),
      route_caps: { caps: { ...DEFAULT_ROUTE_CAPS, ...(this.manifest.output_caps ?? {}) }, slots: { ...DEFAULT_ROUTE_CLASSES, ...(this.manifest.route_classes ?? {}) }, defaultClass: 'extraction' },
      ...(this.manifest.provider_limits ? { admission: this.admissionShare(c) } : {}) };
  }

  /** Q1: the cell's share of each provider key's limits, divided among the cells of its wave that call that provider. */
  admissionShare(c: CellSpec): Partial<Record<ProviderName, ProviderLimits>> {
    const waves = planWaves(this.manifest);
    const wave = waves.find(w => w.cells.includes(c.id));
    const peers = wave ? wave.cells.map(id => this.cell(id)) : [c];
    const out: Partial<Record<ProviderName, ProviderLimits>> = {};
    for (const [prov, lim] of Object.entries(this.manifest.provider_limits ?? {}) as Array<[ProviderName, ProviderLimits]>) {
      if (!(c.providers ?? ['openai', 'anthropic', 'voyage']).includes(prov)) continue;
      const n = Math.max(1, peers.filter(p => (p.providers ?? ['openai', 'anthropic', 'voyage']).includes(prov)).length);
      const share: ProviderLimits = {};
      for (const k of ['rpm', 'tpm', 'concurrency'] as const) if (lim[k]) share[k] = Math.max(1, Math.floor(lim[k]! / n));
      out[prov] = share;
    }
    return out;
  }

  /** The ubi-runner invocation for a lease: provision, sync, set up, run the cell remotely, pull its output, destroy. */
  launchArgv(l: LeaseState, opts: { vm?: string | null; restore?: RemotePayload['restore'] } = {}): string[] {
    const c = this.cell(l.cell);
    const remoteOut = this.remoteOut(l);
    const payload = Buffer.from(JSON.stringify(this.payload(l, opts.restore))).toString('base64');
    let setup = c.setup ? (existsSync(resolve(REPO_ROOT, c.setup)) ? resolve(REPO_ROOT, c.setup) : resolve(c.setup)) : null;
    if (c.setup_command) {
      mkdirSync(join(this.stateDir, 'setup'), { recursive: true });
      setup = join(this.stateDir, 'setup', `${l.cell}.sh`);
      writeFileSync(setup, `set -euo pipefail\n${c.setup_command}\n`);
    }
    return ['bash', resolveRunner(), 'run', '-s', c.vm?.size ?? 'standard-8', '-l', c.vm?.location ?? 'eu-central-h1', ...(c.vm?.storage_gib ? ['-S', String(c.vm.storage_gib)] : []),
      ...(opts.vm ? ['-n', opts.vm] : []), ...(setup ? ['--setup', setup] : []), ...(c.pass ?? []).flatMap(p => ['--pass', p]),
      '--pull', `work/${basename(REPO_ROOT)}/${remoteOut}:${dirname(this.resultsDir(l))}`,
      '--', `bun eval/runner/shootout-cell.ts remote --cell-b64 ${payload}`];
  }

  /** `run --local`: the same remote command on this machine, writing straight into the lease's results directory (no VM, no pull). */
  localArgv(l: LeaseState, port: number, restore?: RemotePayload['restore']): string[] {
    const payload = { ...this.payload(l, restore), out: this.resultsDir(l) };
    return [process.execPath, join(REPO_ROOT, 'eval/runner/shootout-cell.ts'), 'remote', '--port', String(port), '--cell-b64', Buffer.from(JSON.stringify(payload)).toString('base64')];
  }

  /**
   * Launch a reserved lease. The launch is recorded before the VM starts, so a
   * crash at any point leaves a launched lease that is never launched again.
   */
  async launch(cellId: string, runner: Runner, opts: { restore?: RemotePayload['restore']; local?: { port: number } } = {}): Promise<LeaseState> {
    this.verifyFrozen('launch');
    const l = this.leases().find(x => x.cell === cellId && x.status === 'reserved');
    if (!l) {
      const used = this.leases().find(x => x.cell === cellId && (x.status === 'launched' || x.status === 'finished'));
      throw new Error(used ? `lease ${used.lease_id} was already launched; a lease is used once (settle or abandon it, then reserve again)` : `cell ${cellId} has no reserved lease; run reserve first`);
    }
    const c = this.cell(cellId);
    const vm = this.q1 && !opts.local ? this.vmName(l) : null;
    const argv = opts.local ? this.localArgv(l, opts.local.port, opts.restore) : this.launchArgv(l, { vm, restore: opts.restore });
    mkdirSync(this.resultsDir(l), { recursive: true });
    this.append({ event: 'launched', lease_id: l.lease_id, at: new Date().toISOString(), argv, ...(this.q1 ? { vm, restore: opts.restore?.realization_id ?? null } : {}) });
    const ctx: LaunchContext = { lease: l, cell: c, vm, remoteOut: this.remoteOut(l), resultsDir: this.resultsDir(l), runner: argv[1],
      timeoutMs: c.timeout_hours ? c.timeout_hours * 3_600_000 : null, pullEveryMs: this.q1 ? (this.manifest.pull_interval_minutes ?? 10) * 60_000 : null };
    const code = await runner(argv, ctx);
    this.append({ event: 'finished', lease_id: l.lease_id, at: new Date().toISOString(), exit_code: code });
    if (this.q1) this.recordRealization(l.lease_id);
    if (existsSync(join(this.resultsDir(l), 'lease-summary.json')) || existsSync(join(this.resultsDir(l), 'lease.sqlite'))) return this.settle(l.lease_id);
    return this.lease(l.lease_id);
  }

  /** Q1: record a realization pulled into the lease's results directory, once, after checking every snapshot file against its recorded sha256. */
  recordRealization(leaseId: string): string | null {
    const l = this.lease(leaseId);
    const dir = join(this.resultsDir(l), 'realization');
    const path = join(dir, 'realization.json');
    if (!existsSync(path)) return null;
    const r = JSON.parse(readFileSync(path, 'utf8')) as Realization;
    if (r.status !== 'complete' || r.lease_id !== leaseId) return null;
    for (const f of r.files) {
      const abs = join(dir, 'snapshot', f.path);
      if (!existsSync(abs) || sha256File(abs) !== f.sha256) return null;
    }
    if (!this.realizedEvents().some(e => e.realization_id === r.realization_id)) {
      this.append({ event: 'realized', lease_id: leaseId, at: new Date().toISOString(), realization_id: r.realization_id, dir: relative(this.stateDir, dir), files: r.files });
    }
    return r.realization_id;
  }

  /**
   * Q1: rerun a cell whose VM was lost. The cell's last lease must be closed
   * (an abandoned lease stays charged in full). With a pulled realization and
   * a `restore_command`, the new lease restores the store snapshot and the
   * checkpointed rows and reruns only what is missing; otherwise it repeats
   * the whole conversation and the old realization is not used.
   */
  async resume(cellId: string, runner: Runner, opts: { local?: { port: number } } = {}): Promise<{ mode: 'snapshot' | 'repeat'; realization_id: string | null; lease: LeaseState; note: string }> {
    if (!this.q1) throw new Error('resume is for Q1 scoreboard campaigns');
    this.verifyFrozen('resume');
    const c = this.cell(cellId);
    const mine = this.leases().filter(l => l.cell === cellId);
    const open = mine.find(l => l.status === 'launched' || l.status === 'finished');
    if (open) throw refuse({ code: 'RESUME_REFUSED', message: `cell ${cellId} still holds lease ${open.lease_id} (${open.status}); its VM never reported back`,
      why: 'a lease is used once; a lost VM\'s lease is closed by abandoning it, which charges its full reservation against the cap',
      fix: { next: 'run', argv: ['bun', 'eval/runner/shootout-cell.ts', 'abandon', '--campaign', this.manifestPath, '--state', this.stateDir, '--lease', open.lease_id, '--reason', 'VM lost'],
        verify: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', this.manifestPath, '--state', this.stateDir] } });
    const ids = new Set(mine.map(l => l.lease_id));
    const realized = this.realizedEvents().filter(e => ids.has(e.lease_id)).at(-1) ?? null;
    let restore: RemotePayload['restore'] | undefined;
    let staged: string | null = null;
    if (realized && c.restore_command) {
      const from = this.lease(realized.lease_id);
      staged = join(REPO_ROOT, '.scoreboard-restore', `${cellId}-${realized.realization_id}`);
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(staged, { recursive: true });
      cpSync(join(this.resultsDir(from), 'realization'), join(staged, 'realization'), { recursive: true });
      if (existsSync(join(this.resultsDir(from), 'checkpoint'))) cpSync(join(this.resultsDir(from), 'checkpoint'), join(staged, 'checkpoint'), { recursive: true });
      restore = { realization_id: realized.realization_id, dir: relative(REPO_ROOT, staged), restore_command: c.restore_command };
    }
    const lease = this.reserve(cellId);
    try { await this.launch(cellId, runner, { restore, local: opts.local }); }
    finally { if (staged) rmSync(staged, { recursive: true, force: true }); }
    const mode = restore ? 'snapshot' : 'repeat';
    const note = restore ? `resumed from realization ${restore.realization_id}: the store snapshot and checkpointed rows were restored, so only missing questions ran`
      : realized ? `cell ${cellId} has realization ${realized.realization_id} but no restore_command, so the whole conversation was repeated and that realization is not used`
        : `no realization was pulled for cell ${cellId}, so the whole conversation was repeated`;
    return { mode, realization_id: restore?.realization_id ?? null, lease: this.lease(lease.lease_id), note };
  }

  /** Settle a lease to the committed total of its VM ledger (pulled into the results directory). */
  settle(leaseId: string): LeaseState {
    const l = this.lease(leaseId);
    if (l.status === 'settled' || l.status === 'abandoned') throw new Error(`lease ${leaseId} is already ${l.status}`);
    if (l.status === 'reserved') throw new Error(`lease ${leaseId} was never launched; abandon it instead`);
    const dir = this.resultsDir(l);
    let committed: number, requests: number, leaseUsd: number, runId: string, maxOut: number | null;
    let timedOut = false, cellExit: number | null | undefined;
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
    if (existsSync(join(dir, 'lease-summary.json'))) {
      const s = JSON.parse(readFileSync(join(dir, 'lease-summary.json'), 'utf8')) as { timed_out?: boolean; cell_exit_code?: number | null };
      timedOut = !!s.timed_out;
      cellExit = s.cell_exit_code;
    }
    if (runId !== leaseId) throw new Error(`the pulled ledger is for lease ${runId}, not ${leaseId}`);
    if (Math.abs(leaseUsd - l.usd) > 1e-9) throw new Error(`the pulled ledger's lease is $${leaseUsd}, the host reserved $${l.usd}`);
    this.run().settle(l.entry_id, { usd: committed });
    this.append({ event: 'settled', lease_id: leaseId, at: new Date().toISOString(), actual_usd: committed, requests, max_output_tokens: maxOut ?? null,
      ...(timedOut ? { timed_out: true } : {}), ...(cellExit !== undefined ? { cell_exit_code: cellExit } : {}) });
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
      return { ...this.lease(leaseId), note: `abandoned lease ${leaseId} is charged its full reservation of ${usd(l.usd)} against the campaign cap, because no VM ledger came back to settle it to what was really spent. `
        + `If the launch log proves the cell command never started, close it at $0 instead with: bun eval/runner/shootout-cell.ts abandon --campaign <manifest> --state <dir> --lease ${leaseId} --reason "<why>" --unstarted --log <launch log>.` };
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
    const leases = this.leases();
    const unsettled = leases.filter(l => l.status === 'reserved' || l.status === 'launched' || l.status === 'finished').reduce((n, l) => n + l.usd, 0);
    const abandonedFull = leases.filter(l => l.status === 'abandoned' && l.actual_usd === l.usd).reduce((n, l) => n + l.usd, 0);
    return { campaign_id: s.campaign_id, run_id: s.run_id, cap_usd: this.manifest.cap_usd, committed_usd: ledger.run?.committed_usd ?? null, remaining_usd: ledger.run?.remaining_usd ?? null,
      planned_leases_usd: this.manifest.cells.reduce((x, c) => x + c.lease_usd, 0), leases,
      /** Leases charged at their full reservation: still open, or abandoned without a VM ledger. */
      unsettled_usd: unsettled + abandonedFull,
      ...(this.q1 ? { kind: Q1_KIND, manifest_sha256: s.manifest_sha256, frozen: s.manifest_sha256 === this.sha,
        blocks: Object.fromEntries(Object.entries(this.manifest.blocks ?? {}).map(([b, v]) => [b, { ...v, held_usd: this.blockSpend(b) }])),
        realizations: this.realizedEvents().map(e => ({ lease_id: e.lease_id, realization_id: e.realization_id, files: e.files.length })) } : {}) };
  }
}

export interface Wave { wave: number; cells: string[]; vcpu: number; expected_hours: number }

/** vCPUs of a Ubicloud size name (`standard-8` is 8). */
export const vcpuOf = (c: CellSpec) => Number((c.vm?.size ?? 'standard-8').match(/(\d+)$/)?.[1] ?? 8);

/**
 * Q1 schedule: cells with an explicit `wave` go there; the rest pack greedily
 * (block, then id) into waves whose vCPU total stays under the daytime cap.
 */
export function planWaves(m: CampaignManifest): Wave[] {
  const cap = m.schedule?.vcpu_cap_day ?? 128;
  const waves: Wave[] = [];
  const at = (n: number) => { while (waves.length < n) waves.push({ wave: waves.length + 1, cells: [], vcpu: 0, expected_hours: 0 }); return waves[n - 1]; };
  const put = (w: Wave, c: CellSpec) => { w.cells.push(c.id); w.vcpu += vcpuOf(c); w.expected_hours = Math.max(w.expected_hours, c.expected_hours ?? c.timeout_hours ?? 0); };
  for (const c of m.cells.filter(x => x.wave !== undefined)) put(at(c.wave!), c);
  const rest = m.cells.filter(x => x.wave === undefined).sort((a, b) => (a.block ?? '~').localeCompare(b.block ?? '~') || a.id.localeCompare(b.id));
  for (const c of rest) {
    let w = waves.find(x => x.vcpu + vcpuOf(c) <= cap);
    if (!w) w = at(waves.length + 1);
    put(w, c);
  }
  return waves;
}

/** Count attempt rows (lines of every attempts.ndjson) under a cell's output, outside its checkpoint and realization. */
function attemptRows(out: string): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (e.isDirectory()) { if (!['checkpoint', '.checkpoint-tmp', 'realization'].includes(e.name)) walk(join(dir, e.name)); }
      else if (e.name === 'attempts.ndjson') n += readFileSync(join(dir, e.name), 'utf8').split('\n').filter(Boolean).length;
    }
  };
  if (existsSync(out)) walk(out);
  return n;
}

/** Copy the cell's output (rows, attempts, receipts, usage) into out/checkpoint atomically; the live ledger and the realization stay out. */
function writeCheckpoint(out: string, rows: number) {
  const tmp = join(out, '.checkpoint-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const e of readdirSync(out, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (['checkpoint', '.checkpoint-tmp', 'realization'].includes(e.name) || /^lease\.sqlite/.test(e.name)) continue;
    cpSync(join(out, e.name), join(tmp, e.name), { recursive: true });
  }
  writeFileSync(join(tmp, 'checkpoint.json'), JSON.stringify({ rows, at: new Date().toISOString() }) + '\n');
  rmSync(join(out, 'checkpoint'), { recursive: true, force: true });
  renameSync(tmp, join(out, 'checkpoint'));
}

/** Run the cell's snapshot command and record an immutable realization id over the snapshot's bytes. */
async function takeSnapshot(payload: RemotePayload, out: string, env: Record<string, string | undefined>, trigger: string): Promise<Realization> {
  const dir = join(out, 'realization');
  const snap = join(dir, 'snapshot');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(snap, { recursive: true });
  const p = Bun.spawn(['bash', '-c', payload.snapshot_command!], { cwd: REPO_ROOT, env: { ...env, SHOOTOUT_SNAPSHOT_DIR: snap }, stdout: 'inherit', stderr: 'inherit' });
  const code = await p.exited;
  const files: RealizationFile[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) { const abs = join(d, e.name); if (e.isDirectory()) walk(abs); else files.push({ path: relative(snap, abs), sha256: sha256File(abs), bytes: statSync(abs).size }); } };
  walk(snap);
  files.sort((a, b) => a.path < b.path ? -1 : 1);
  const id = createHash('sha256').update(JSON.stringify({ cell: payload.cell ?? null, lease_id: payload.lease_id, campaign_sha256: payload.campaign_sha256 ?? null, files })).digest('hex').slice(0, 16);
  const r: Realization = { realization_id: `real-${payload.cell ?? 'cell'}-${id}`, cell: payload.cell ?? null, lease_id: payload.lease_id, campaign_sha256: payload.campaign_sha256 ?? null, created_at: new Date().toISOString(), trigger, files,
    status: code === 0 && files.length ? 'complete' : 'failed', ...(code !== 0 ? { error: `snapshot command exited ${code}` } : !files.length ? { error: 'snapshot command wrote no files' } : {}) };
  writeFileSync(join(dir, 'realization.json'), JSON.stringify(r, null, 2) + '\n');
  return r;
}

/**
 * On the VM: start the lease proxy, run the cell command against it, write the lease summary beside the cell's output.
 * The proxy is strict: provider routes admit only callers presenting this cell's token (SHOOTOUT_CELL_TOKEN, in the
 * command's, snapshot's and restore's environment); the runners present it as their provider key and the compose
 * stacks as their dummy key (`${SHOOTOUT_CELL_TOKEN:-dummy}`), so nothing on the VM is trusted for being local.
 */
export async function runRemote(payload: RemotePayload, opts: { port?: number; pollMs?: number } = {}): Promise<number> {
  const out = resolve(payload.out);
  mkdirSync(out, { recursive: true });
  const port = opts.port ?? 8787;
  const ledger = join(out, 'lease.sqlite');
  const controlToken = randomUUID();
  const cellToken = randomUUID();
  const extra: string[] = [];
  if (payload.route_caps) extra.push('--route-caps', Object.entries(payload.route_caps.caps).map(([k, v]) => `${k}=${v}`).join(','),
    '--route-class', Object.entries(payload.route_caps.slots).map(([k, v]) => `${k}=${v}`).join(','), '--default-route-class', payload.route_caps.defaultClass);
  for (const [prov, lim] of Object.entries(payload.admission ?? {})) extra.push('--admission', `${prov}=${Object.entries(lim!).map(([k, v]) => `${k}:${v}`).join(',')}`);
  const proxy = Bun.spawn([process.execPath, join(REPO_ROOT, 'eval/runner/metering-proxy.ts'), '--listen', `0.0.0.0:${port}`, '--budget-ledger', ledger, '--lease-usd', String(payload.lease_usd),
    '--run-id', payload.lease_id, '--usage-log', join(out, 'usage.ndjson'), ...(payload.max_output_tokens ? ['--max-output-tokens', String(payload.max_output_tokens)] : []), '--control-token', controlToken,
    ...extra], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, SHOOTOUT_CELL_TOKEN: cellToken } });
  let code: number | null = null;
  let timedOut = false;
  let checkpointRows = 0;
  let realization: Realization | null = null;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/__proxy/status`)).ok; } catch { await Bun.sleep(50); } }
    if (!up) throw new Error('the metering proxy did not start');
    const base = `http://127.0.0.1:${port}`;
    const env: Record<string, string | undefined> = { ...process.env, SHOOTOUT_OUT: out, SHOOTOUT_PROXY: base, SHOOTOUT_LEASE_ID: payload.lease_id, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken,
      OPENAI_BASE_URL: `${base}/cell/openai/v1`, ANTHROPIC_BASE_URL: `${base}/cell/anthropic`, VOYAGE_BASE_URL: `${base}/cell/voyage/v1`, SHOOTOUT_CELL_TOKEN: cellToken };
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) if (env[k]) env[k] = 'dummy-key-the-proxy-replaces';
    if (payload.restore) {
      const dir = resolve(REPO_ROOT, payload.restore.dir);
      if (existsSync(join(dir, 'checkpoint'))) for (const e of readdirSync(join(dir, 'checkpoint')).sort()) if (e !== 'checkpoint.json') cpSync(join(dir, 'checkpoint', e), join(out, e), { recursive: true });
      env.SHOOTOUT_RESTORE_DIR = join(dir, 'realization', 'snapshot');
      env.SHOOTOUT_RESTORED_REALIZATION = payload.restore.realization_id;
      if (payload.restore.restore_command) {
        const r = Bun.spawn(['bash', '-c', payload.restore.restore_command], { cwd: REPO_ROOT, env, stdout: 'inherit', stderr: 'inherit' });
        const rc = await r.exited;
        if (rc !== 0) throw new Error(`restore command exited ${rc}; the cell did not run (resume repeats the whole conversation instead)`);
      }
    }
    if (payload.snapshot_command) env.SHOOTOUT_SNAPSHOT_DIR = join(out, 'realization', 'snapshot');
    // Not a login shell: a login profile can re-export the real keys over the dummy ones.
    const cell = Bun.spawn(['bash', '-c', payload.command], { cwd: REPO_ROOT, env, stdout: 'inherit', stderr: 'inherit' });
    const timer = payload.timeout_hours ? setTimeout(() => { timedOut = true; cell.kill('SIGTERM'); setTimeout(() => cell.kill('SIGKILL'), 30_000).unref?.(); }, payload.timeout_hours * 3_600_000) : null;
    const every = payload.row_pull_every ?? 0;
    let snapshotting: Promise<Realization> | null = null;
    let exited = false;
    const watch = async () => {
      while (!exited) {
        await Promise.race([cell.exited, Bun.sleep(opts.pollMs ?? 2000)]);
        const rows = every ? attemptRows(out) : 0;
        if (every && rows >= checkpointRows + every) { writeCheckpoint(out, rows); checkpointRows = rows; }
        if (payload.snapshot_command && !snapshotting && !payload.restore && (existsSync(join(out, 'ingest-complete')) || rows > 0)) {
          snapshotting = takeSnapshot(payload, out, env, existsSync(join(out, 'ingest-complete')) ? 'ingest-complete' : 'first-row');
        }
      }
    };
    const watcher = every || payload.snapshot_command ? watch() : null;
    code = await cell.exited;
    exited = true;
    if (timer) clearTimeout(timer);
    await watcher;
    if (payload.snapshot_command && !snapshotting && !payload.restore && existsSync(join(out, 'ingest-complete'))) snapshotting = takeSnapshot(payload, out, env, 'ingest-complete');
    if (snapshotting) realization = await snapshotting;
    if (every) { checkpointRows = attemptRows(out); writeCheckpoint(out, checkpointRows); }
    if (timedOut) code = 124;
  } finally {
    proxy.kill('SIGTERM');
    await proxy.exited;
    const s = ledgerStatus({ ledgerPath: ledger, runId: payload.lease_id });
    writeFileSync(join(out, 'lease-summary.json'), JSON.stringify({ run_id: payload.lease_id, lease_usd: payload.lease_usd, committed_usd: s.run?.committed_usd ?? payload.lease_usd,
      requests: s.run ? BudgetRun.runRequests(ledger, payload.lease_id) : null, max_output_tokens: s.run ? BudgetRun.leaseMaxOutputTokens(ledger, payload.lease_id) ?? DEFAULT_MAX_OUTPUT_TOKENS : null, cell_exit_code: code,
      ...(payload.timeout_hours !== undefined ? { timeout_hours: payload.timeout_hours, timed_out: timedOut } : {}),
      ...(payload.row_pull_every ? { checkpoint_rows: checkpointRows } : {}), ...(realization ? { realization_id: realization.realization_id, realization_status: realization.status } : {}),
      ...(payload.restore ? { restored_from: payload.restore.realization_id } : {}) }, null, 2) + '\n');
  }
  return code ?? 1;
}

/**
 * The launcher's executor: runs ubi-runner, stops it half an hour after the
 * cell's timeout (its trap destroys the VM), and pulls the VM's checkpoint and
 * realization every pull interval so a lost VM costs at most one interval.
 */
export function ubiRunner(campaign?: Campaign): Runner {
  return async (argv, ctx) => {
    const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit', env: process.env });
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    if (ctx.timeoutMs) timers.push(setTimeout(() => { process.stderr.write(`[shootout-cell] ${ctx.lease.lease_id} passed its timeout; stopping the VM run\n`); p.kill('SIGTERM'); }, ctx.timeoutMs + 30 * 60_000));
    let pulling = false;
    if (ctx.vm && ctx.pullEveryMs) {
      timers.push(setInterval(async () => {
        if (pulling) return;
        pulling = true;
        try {
          for (const part of ['checkpoint', 'realization']) {
            const pull = Bun.spawn(['bash', ctx.runner, 'pull', ctx.vm!, `work/${basename(REPO_ROOT)}/${ctx.remoteOut}/${part}`, ctx.resultsDir], { stdout: 'ignore', stderr: 'ignore', env: process.env });
            await pull.exited;
          }
          campaign?.recordRealization(ctx.lease.lease_id);
        } catch { /* the next interval retries */ } finally { pulling = false; }
      }, ctx.pullEveryMs));
    }
    try { return await p.exited; } finally { for (const t of timers) clearTimeout(t); }
  };
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
      print({ sha256: loaded.sha256, cells: loaded.manifest.cells.length, parameters: loaded.manifest.parameters ?? {}, leases_usd: loaded.manifest.cells.reduce((x, c) => x + c.lease_usd, 0), ...(loaded.tree ? { tree_files: loaded.tree.length } : {}) });
      process.exit(0);
    }
    const manifest = one('--campaign'), state = one('--state');
    if (!manifest || !state) throw new Error('usage: see the header of eval/runner/shootout-cell.ts (--campaign <manifest.json> --state <dir>)');
    const c = new Campaign(manifest, resolve(state));
    const failed = (l: LeaseState) => l.timed_out || (l.exit_code !== undefined && l.exit_code !== 0) || (l.cell_exit_code !== undefined && l.cell_exit_code !== null && l.cell_exit_code !== 0) || l.status === 'launched' || l.status === 'finished';
    const finishLaunch = (l: LeaseState) => {
      print(l);
      if (!failed(l)) process.exit(0);
      throw refuse({ code: l.timed_out ? 'CELL_TIMEOUT' : 'CELL_FAILED', message: `cell ${l.cell} lease ${l.lease_id} ${l.timed_out ? 'hit its timeout' : `ended ${l.status} with exit ${l.cell_exit_code ?? l.exit_code ?? 'unknown'}`}`,
        why: 'a cell that did not finish cleanly is not a counted result; its rows stay pulled for diagnosis and resume',
        fix: { next: 'run', argv: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', manifest, '--state', state], verify: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', manifest, '--state', state] },
        state: { lease: l.lease_id, status: l.status, exit_code: l.exit_code ?? null, cell_exit_code: l.cell_exit_code ?? null } });
    };
    if (cmd === 'init') print(c.init());
    else if (cmd === 'reserve') print(c.reserve(one('--cell') ?? ''));
    else if (cmd === 'launch' && argv.includes('--dry-run')) {
      const l = c.leases().find(x => x.cell === one('--cell') && x.status === 'reserved');
      if (!l) throw new Error(`cell ${one('--cell')} has no reserved lease`);
      print({ lease: l.lease_id, argv: c.launchArgv(l, { vm: c.q1 ? c.vmName(l) : null }) });
    } else if (cmd === 'launch') finishLaunch(await c.launch(one('--cell') ?? '', ubiRunner(c)));
    else if (cmd === 'resume') { const r = await c.resume(one('--cell') ?? '', ubiRunner(c)); print(r); finishLaunch(r.lease); }
    else if (cmd === 'settle') print(c.settle(one('--lease') ?? ''));
    else if (cmd === 'abandon') print(c.abandon(one('--lease') ?? '', one('--reason') ?? '', argv.includes('--unstarted') ? { log: one('--log') ?? '' } : undefined));
    else if (cmd === 'status') print(c.status());
    else throw new Error(`unknown command ${cmd}`);
  } catch (e) {
    if (e instanceof ScoreboardError) {
      const { renderMessage, exitCodeOf } = await import('./q1/scoreboard-errors.ts');
      process.stderr.write((argv.includes('--json') ? JSON.stringify(e.op, null, 2) : renderMessage(e.op)) + '\n');
      process.exit(exitCodeOf(e.op));
    }
    console.error(`[shootout-cell] ${(e as Error).message}`);
    process.exit(2);
  }
}

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
 * reserves a new lease from what is left. A campaign with a BG1 unit is also
 * checked before init, reserve, launch and resume (eval/runner/bg1/launch.ts).
 *
 *   bun eval/runner/shootout-cell.ts init    --campaign <manifest.json> --state <dir>
 *   bun eval/runner/shootout-cell.ts reserve --campaign <manifest.json> --state <dir> --cell <id>
 *   bun eval/runner/shootout-cell.ts launch  --campaign <manifest.json> --state <dir> --cell <id> [--dry-run]
 *     (a cell marked `local: true` runs the same remote step on this host instead of a VM: its own lease proxy on a
 *     port derived from the lease, the command in this checkout, the lease summary written into the results directory)
 *   bun eval/runner/shootout-cell.ts settle  --campaign <manifest.json> --state <dir> --lease <id>
 *   bun eval/runner/shootout-cell.ts abandon --campaign <manifest.json> --state <dir> --lease <id> --reason <text> [--unstarted --log <launch log>]
 *   bun eval/runner/shootout-cell.ts status  --campaign <manifest.json> --state <dir>
 *   bun eval/runner/shootout-cell.ts raise-cap --campaign <manifest.json> --state <dir> --reason <text>
 *     (after the user raises the campaign's cap_usd in the manifest: the ledger's program cap and the campaign run's
 *     budget move up to it; never down)
 *   bun eval/runner/shootout-cell.ts hash    --campaign <manifest.json>   (the hash a preregistration records)
 *   bun eval/runner/shootout-cell.ts resume  --campaign <manifest.json> --state <dir> --cell <id> [--from-campaign <manifest.json> --from-state <dir>]
 *                                            (Q1 campaigns: rerun what a cell lacks, from its pulled checkpoint and realization)
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
 *             is stopped BACKSTOP_HOURS later; ubi-runner then stops the
 *             command and pulls its output before it destroys the VM).
 *   detach    the cell runs detached on the VM (setsid/nohup, log and exit
 *             status in files there); ubi-runner follows it over short ssh
 *             calls, so a dropped session never kills the cell or its
 *             snapshot step (A22).
 *   rows      the VM checkpoints the cell's output every `row_pull_every`
 *             (20) new attempt rows, and the launcher pulls the checkpoint
 *             every `pull_interval_minutes`, so a lost VM costs at most one
 *             interval of rows.
 *   snapshots after ingest (`$SHOOTOUT_OUT/ingest-complete`, or the first
 *             attempt row) the cell's `snapshot_command` writes the store into
 *             `$SHOOTOUT_SNAPSHOT_DIR`; the VM records an immutable ingest
 *             realization id over the snapshot's bytes, and the launcher pulls
 *             it to the launching host.
 *   resume    a cell whose VM was lost or whose run left gaps restarts from
 *             its pulled checkpoint: with a realization whose snapshot files
 *             still match their recorded sha256 and a `restore_command` it
 *             restores the store and runs only what is missing; otherwise it
 *             ingests again and answers only the questions the checkpoint
 *             lacks. An answered question is never asked again (A22).
 *   metering  the VM's proxy gets the cell token, the campaign's per-route
 *             output caps and the cell's share of each provider's limits.
 *     (SHOOTOUT_KEYLESS_UPSTREAM=http://host:port points the lease proxy's providers at a keyless stand-in such as
 *     budgeted-delivery/stub-proxy.ts, for dry runs; the lease summary records it)
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { bg1UnitConversations, type Bg1Manifest } from './memory-qa/corpus.ts';
import { BudgetExceededError, BudgetRun, initLedger, ledgerStatus, readLedger, setProgramCap, setRunBudget, withFileLock } from './budget-ledger.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_ROUTE_CAPS, KEY_ENV, keylessUpstream, type ProviderLimits, type ProviderName } from './metering-proxy.ts';
import { refuse, ScoreboardError } from './q1/scoreboard-errors.ts';
import { BEAM10M_MANIFEST } from './memory-qa/beam10m-corpus.ts';
import { insideRepository, sha256File } from './sealed-confirmation-lib.ts';

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
  /** Run on this host instead of a VM (reader replays over results already on the host): same lease, proxy and settlement. */
  local?: boolean;
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
  /** Q1: the variable the VM receives Gemini's key in (BG1: BG1_GEMINI_API_KEY); runRemote hands it to the lease proxy as Gemini's key variable, by reference, and the cell never sees it. */
  gemini_key_env?: string;
  /** Q1: a sealed BG1 launch unit (its index and size in kept worlds), whose pinned worlds alone its VM receives (bg1CustodyPush). */
  bg1_unit?: { index: number; size: number };
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
  /** The host reservation after `eval/runner/q1/raise-lease.ts` raised the running lease (absent when never raised); `usd` stays the launch amount the VM's lease summary carries. */
  raised_usd?: number;
}

interface CampaignState { campaign_id: string; run_id: string; ledger: string; manifest_sha256: string; created_at: string; kind?: string }

export interface RealizationFile { path: string; sha256: string; bytes: number }
export interface Realization { realization_id: string; cell: string | null; lease_id: string; campaign_sha256: string | null; created_at: string; trigger: string; files: RealizationFile[]; status: 'complete' | 'failed'; error?: string }

/** What the VM receives (base64 JSON). Q1 fields are present only when the cell or campaign sets them, so a shootout payload is unchanged. */
export interface RemotePayload {
  lease_id: string; lease_usd: number; max_output_tokens?: number | null; command: string; out: string;
  cell?: string; campaign_sha256?: string; timeout_hours?: number; row_pull_every?: number; snapshot_command?: string;
  /** A resume: the staged checkpoint (and, with a verified realization, the store snapshot) to start from. realization_id null: no usable snapshot, so the cell ingests again and answers only what the checkpoint lacks (A22). */
  restore?: { realization_id: string | null; dir: string; restore_command?: string };
  route_caps?: { caps: Record<string, number>; slots: Record<string, string>; defaultClass: string };
  admission?: Partial<Record<ProviderName, ProviderLimits>>;
  /** The cell's gemini_key_env: the proxy's Gemini key comes from this variable and no other, and the cell's environment drops both. */
  gemini_key_env?: string;
  /**
   * A sealed cell: the proxy's ledger and usage log live in the VM's custody root, ~/custody/<lease id>, passed to the
   * command as SHOOTOUT_CUSTODY, so only the lease summary and what the command writes to SHOOTOUT_OUT leave the VM. A
   * Q1 sealed cell (A17) also writes its output under ~/custody/out (outside the checkout), carries the custody access
   * log in GBRAIN_EVALS_CUSTODY_LOG, and only the custodian's host pulls it back.
   */
  sealed?: boolean;
}

/** What the executor needs beyond argv: the VM name (Q1), where its output lives remotely and locally, the deadline and the pull interval. */
export interface LaunchContext { lease: LeaseState; cell: CellSpec; vm: string | null; remoteOut: string; resultsDir: string; timeoutMs: number | null; pullEveryMs: number | null; runner: string }
export type Runner = (argv: string[], ctx: LaunchContext) => Promise<number | null>;

const expandHome = (p: string) => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;

/**
 * Why a `bootstrap.sh snapshot` tar cannot restore the system's whole store, or null when it can (or the file is not
 * such a tar). The tar must hold every named volume the system's compose file declares, and at least one: an A17
 * memory-bank snapshot verified by sha256 but held no volumes, so its restore started every bank empty (A23).
 */
export function snapshotStoreGap(system: string, tarPath: string, root = REPO_ROOT): string | null {
  const compose = [join(root, 'eval/systems', system, 'docker-compose.yml'), join(root, 'docs/comparison-systems', system, 'docker-compose.yml')].find(existsSync);
  if (!compose) return null;
  let listing: string;
  try { listing = execFileSync('tar', ['-xOf', tarPath, './volumes.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  const held = new Set((JSON.parse(listing) as { volumes: Array<{ key: string }> }).volumes.map(v => v.key));
  const declared = Object.keys((Bun.YAML.parse(readFileSync(compose, 'utf8')) as { volumes?: Record<string, unknown> }).volumes ?? {});
  const missing = declared.filter(k => !held.has(k));
  if (!held.size) return 'holds no volumes, so a restore would start the system with an empty store';
  return missing.length ? `lacks volume${missing.length > 1 ? 's' : ''} ${missing.join(', ')} that ${relative(root, compose)} declares` : null;
}
const usd = (n: number) => `$${n.toFixed(2)}`;
/** The id reserve() gives a lease: its cell, its attempt and the start of its ledger entry's id. */
const mintLeaseId = (cell: string, attempt: number, entry: string) => `${cell}-a${attempt}-${entry.slice(0, 8)}`;

/** The ubi-runner owner tag (UBI_OWNER, lowercased letters and digits, at most 12, starting with a letter), as the runner computes it. */
export function ownerTag(raw: string | undefined): string | null {
  let t = (raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!t) return null;
  if (!/^[a-z]/.test(t)) t = `u${t}`;
  return t.slice(0, 12);
}

/** A custody push: the listed files under `source` go to `dest` (relative to the VM user's home) before setup, and `env` points the loader there. */
export interface CustodyPush { source: string; dest: string; list: string[]; env: string[] }

/**
 * BG1: the custodian's files for one sealed BG1 launch unit, mirroring rs1CustodyPush. GBRAIN_EVALS_BG1_SOURCE names
 * the BG1 set root (mint.sh's output, outside the checkout) and GBRAIN_EVALS_BG1_MANIFEST the filled manifest inside
 * it. The unit's kept worlds (corpus.ts bg1UnitConversations; every world without a unit) and the manifest are checked
 * against their pinned SHA-256 here before any VM exists; ubi-runner pushes only those to ~/custody/bg1, with
 * GBRAIN_EVALS_BG1_UNIT naming the unit's worlds, where setup's fetch (verifyBg1Custody) checks them again, the loader
 * logs each opening to the VM's custody access log, and the remote command wipes ~/custody/bg1 at teardown.
 */
export function bg1CustodyPush(env: Record<string, string | undefined> = process.env, campaign = '<campaign>', unit?: { index: number; size: number }): CustodyPush {
  const source = env.GBRAIN_EVALS_BG1_SOURCE;
  const fix = { next: 'tell_user_to_run' as const, argv: ['bun', 'run', 'eval:scoreboard', 'doctor', '--for', 'sealed', '--campaign', campaign], user_message: 'on the custodian host, export GBRAIN_EVALS_BG1_SOURCE=<the BG1 set root, outside the checkout> and GBRAIN_EVALS_BG1_MANIFEST=<the filled bg1-manifest.json inside it>' };
  if (!source) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'a sealed BG1 cell needs the custodian\'s files and GBRAIN_EVALS_BG1_SOURCE is not set', why: 'BG1 is never downloaded on a VM; the custodian host pushes its verified copy', fix });
  if (insideRepository(source)) throw refuse({ code: 'CUSTODY_REQUIRED', message: `GBRAIN_EVALS_BG1_SOURCE ${source} is inside the repository`, why: 'sealed files never live where Git could pick them up', fix });
  const manifest = env.GBRAIN_EVALS_BG1_MANIFEST;
  if (!manifest) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'a sealed BG1 cell needs the filled BG1 manifest and GBRAIN_EVALS_BG1_MANIFEST is not set', why: 'the committed BG1 manifest stays unfilled; only pinned bytes are pushed', fix });
  const rel = relative(resolve(source), resolve(manifest));
  if (rel.startsWith('..') || isAbsolute(rel)) throw refuse({ code: 'USAGE', message: 'the BG1 manifest must sit inside GBRAIN_EVALS_BG1_SOURCE', why: 'it travels with the files it describes', fix });
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as Bg1Manifest;
  if (m.status !== 'filled' || !m.files?.length) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'the BG1 manifest has no hashes', why: 'only pinned bytes are pushed', fix });
  const worlds = unit ? bg1UnitConversations(m, unit.index, unit.size) : null;
  const list: string[] = [];
  for (const f of m.files.filter(x => !worlds || worlds.includes(x.path.split('/')[1]))) {
    const abs = join(source, f.path);
    if (!existsSync(abs) || sha256File(abs) !== f.sha256) throw refuse({ code: 'CUSTODY_REQUIRED', message: `${f.path} under GBRAIN_EVALS_BG1_SOURCE is ${existsSync(abs) ? 'not the pinned bytes' : 'missing'}`, why: 'the push refuses before any VM exists when a file does not match the manifest', fix });
    list.push(f.path);
  }
  return { source: resolve(source), dest: 'custody/bg1', list: [...list, rel],
    env: ['GBRAIN_EVALS_BG1_SOURCE=~/custody/bg1', `GBRAIN_EVALS_BG1_MANIFEST=~/custody/bg1/${rel}`, ...(worlds ? [`GBRAIN_EVALS_BG1_UNIT=${worlds.join(',')}`] : [])] };
}

/**
 * A17: the custodian's BEAM-10M files for a sealed S1 cell, checked against the manifest on this host before any VM
 * exists. GBRAIN_EVALS_BEAM10M_SOURCE names the verified dataset root (outside the checkout); ubi-runner pushes the
 * listed files to ~/custody/datasets after the VM is ready and before setup, where setup's fetch checks every SHA-256
 * again and refuses on a mismatch, and the remote command wipes them at teardown.
 */
export function beam10mCustodyPush(env: Record<string, string | undefined> = process.env, campaign = '<campaign>'): CustodyPush {
  const source = env.GBRAIN_EVALS_BEAM10M_SOURCE;
  const fix = { next: 'tell_user_to_run' as const, argv: ['bun', 'run', 'eval:scoreboard', 'doctor', '--for', 'sealed', '--campaign', campaign], user_message: 'on the custodian host, export GBRAIN_EVALS_BEAM10M_SOURCE=<the verified BEAM-10M dataset root, outside the checkout>' };
  if (!source) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'a sealed BEAM-10M cell needs the custodian\'s files and GBRAIN_EVALS_BEAM10M_SOURCE is not set', why: 'BEAM-10M is never downloaded on a VM; the custodian host pushes its verified copy', fix });
  if (insideRepository(source)) throw refuse({ code: 'CUSTODY_REQUIRED', message: `GBRAIN_EVALS_BEAM10M_SOURCE ${source} is inside the repository`, why: 'sealed files never live where Git could pick them up', fix });
  const manifest = env.GBRAIN_EVALS_BEAM10M_MANIFEST ?? join(REPO_ROOT, BEAM10M_MANIFEST);
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as { status: string; conversations: Array<{ chat_path: string; chat_sha256: string | null; questions_path: string; questions_sha256: string | null }> };
  if (m.status !== 'filled') throw refuse({ code: 'CUSTODY_REQUIRED', message: 'the BEAM-10M manifest has no hashes', why: 'only pinned bytes are pushed', fix });
  const list: string[] = [];
  for (const x of m.conversations) for (const [path, want] of [[x.chat_path, x.chat_sha256], [x.questions_path, x.questions_sha256]] as const) {
    const abs = join(source, path);
    if (!existsSync(abs) || sha256File(abs) !== want) throw refuse({ code: 'CUSTODY_REQUIRED', message: `${path} under GBRAIN_EVALS_BEAM10M_SOURCE is ${existsSync(abs) ? 'not the pinned bytes' : 'missing'}`, why: 'the push refuses before any VM exists when a file does not match the manifest', fix });
    list.push(path);
  }
  const extra: string[] = [];
  if (env.GBRAIN_EVALS_BEAM10M_MANIFEST) {
    const rel = relative(resolve(source), resolve(manifest));
    if (rel.startsWith('..')) throw refuse({ code: 'USAGE', message: 'a stand-in BEAM-10M manifest must sit inside GBRAIN_EVALS_BEAM10M_SOURCE', why: 'it travels with the files it describes', fix });
    list.push(rel);
    extra.push(`GBRAIN_EVALS_BEAM10M_MANIFEST=~/custody/datasets/${rel}`);
  }
  return { source: resolve(source), dest: 'custody/datasets', list, env: ['GBRAIN_EVALS_BEAM10M_ROOT=~/custody/datasets', ...extra] };
}

/**
 * F6: the custodian's D8 files for a sealed D8 cell, mirroring beam10mCustodyPush. GBRAIN_EVALS_D8_SOURCE names the D8
 * root (outside the checkout) and GBRAIN_EVALS_D8_MANIFEST a filled manifest inside it (the committed manifest stays
 * unfilled, so a launch always names the custodian's filled copy). Every listed file's SHA-256 is checked here before
 * any VM exists; ubi-runner pushes the files and the manifest to ~/custody/d8 before setup, where setup's fetch
 * (verifyD8Custody) checks them again, the loader logs each opening to the VM's custody access log
 * (GBRAIN_EVALS_CUSTODY_LOG, set by the remote command), and the remote command wipes ~/custody/d8 at teardown.
 */
export function d8CustodyPush(env: Record<string, string | undefined> = process.env, campaign = '<campaign>'): CustodyPush {
  const source = env.GBRAIN_EVALS_D8_SOURCE;
  const fix = { next: 'tell_user_to_run' as const, argv: ['bun', 'run', 'eval:scoreboard', 'doctor', '--for', 'sealed', '--campaign', campaign], user_message: 'on the custodian host, export GBRAIN_EVALS_D8_SOURCE=<the D8 root, outside the checkout> and GBRAIN_EVALS_D8_MANIFEST=<the filled D8 manifest inside it>' };
  if (!source) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'a sealed D8 cell needs the custodian\'s files and GBRAIN_EVALS_D8_SOURCE is not set', why: 'D8 is never downloaded on a VM; the custodian host pushes its verified copy', fix });
  if (insideRepository(source)) throw refuse({ code: 'CUSTODY_REQUIRED', message: `GBRAIN_EVALS_D8_SOURCE ${source} is inside the repository`, why: 'sealed files never live where Git could pick them up', fix });
  const manifest = env.GBRAIN_EVALS_D8_MANIFEST;
  if (!manifest) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'a sealed D8 cell needs the filled D8 manifest and GBRAIN_EVALS_D8_MANIFEST is not set', why: 'the committed D8 manifest stays unfilled; only pinned bytes are pushed', fix });
  const rel = relative(resolve(source), resolve(manifest));
  if (rel.startsWith('..') || isAbsolute(rel)) throw refuse({ code: 'USAGE', message: 'the D8 manifest must sit inside GBRAIN_EVALS_D8_SOURCE', why: 'it travels with the files it describes', fix });
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as { status: string; files: Array<{ path: string; sha256: string }> };
  if (m.status !== 'filled' || !m.files?.length) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'the D8 manifest has no hashes', why: 'only pinned bytes are pushed', fix });
  const list: string[] = [];
  for (const f of m.files) {
    const abs = join(source, f.path);
    if (!existsSync(abs) || sha256File(abs) !== f.sha256) throw refuse({ code: 'CUSTODY_REQUIRED', message: `${f.path} under GBRAIN_EVALS_D8_SOURCE is ${existsSync(abs) ? 'not the pinned bytes' : 'missing'}`, why: 'the push refuses before any VM exists when a file does not match the manifest', fix });
    list.push(f.path);
  }
  return { source: resolve(source), dest: 'custody/d8', list: [...list, rel], env: ['GBRAIN_EVALS_D8_SOURCE=~/custody/d8', `GBRAIN_EVALS_D8_MANIFEST=~/custody/d8/${rel}`] };
}

/**
 * RS1: the custodian's RS1 files for a sealed RS1 cell, mirroring d8CustodyPush. GBRAIN_EVALS_RS1_SOURCE names the RS1
 * set root (mint.sh's <out>/set, outside the checkout) and GBRAIN_EVALS_RS1_MANIFEST a filled manifest inside it (the
 * committed manifest stays unfilled, so a launch always names the custodian's filled copy). Every listed file's SHA-256
 * is checked here before any VM exists; ubi-runner pushes the files and the manifest to ~/custody/rs1 before setup,
 * where setup's fetch (verifyRs1Custody) checks them again, the loader logs each opening to the VM's custody access log
 * (GBRAIN_EVALS_CUSTODY_LOG, set by the remote command), and the remote command wipes ~/custody/rs1 at teardown.
 */
export function rs1CustodyPush(env: Record<string, string | undefined> = process.env, campaign = '<campaign>'): CustodyPush {
  const source = env.GBRAIN_EVALS_RS1_SOURCE;
  const fix = { next: 'tell_user_to_run' as const, argv: ['bun', 'run', 'eval:scoreboard', 'doctor', '--for', 'sealed', '--campaign', campaign], user_message: 'on the custodian host, export GBRAIN_EVALS_RS1_SOURCE=<the RS1 set root, outside the checkout> and GBRAIN_EVALS_RS1_MANIFEST=<the filled RS1 manifest inside it>' };
  if (!source) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'a sealed RS1 cell needs the custodian\'s files and GBRAIN_EVALS_RS1_SOURCE is not set', why: 'RS1 is never downloaded on a VM; the custodian host pushes its verified copy', fix });
  if (insideRepository(source)) throw refuse({ code: 'CUSTODY_REQUIRED', message: `GBRAIN_EVALS_RS1_SOURCE ${source} is inside the repository`, why: 'sealed files never live where Git could pick them up', fix });
  const manifest = env.GBRAIN_EVALS_RS1_MANIFEST;
  if (!manifest) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'a sealed RS1 cell needs the filled RS1 manifest and GBRAIN_EVALS_RS1_MANIFEST is not set', why: 'the committed RS1 manifest stays unfilled; only pinned bytes are pushed', fix });
  const rel = relative(resolve(source), resolve(manifest));
  if (rel.startsWith('..') || isAbsolute(rel)) throw refuse({ code: 'USAGE', message: 'the RS1 manifest must sit inside GBRAIN_EVALS_RS1_SOURCE', why: 'it travels with the files it describes', fix });
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as { status: string; files: Array<{ path: string; sha256: string }> };
  if (m.status !== 'filled' || !m.files?.length) throw refuse({ code: 'CUSTODY_REQUIRED', message: 'the RS1 manifest has no hashes', why: 'only pinned bytes are pushed', fix });
  const list: string[] = [];
  for (const f of m.files) {
    const abs = join(source, f.path);
    if (!existsSync(abs) || sha256File(abs) !== f.sha256) throw refuse({ code: 'CUSTODY_REQUIRED', message: `${f.path} under GBRAIN_EVALS_RS1_SOURCE is ${existsSync(abs) ? 'not the pinned bytes' : 'missing'}`, why: 'the push refuses before any VM exists when a file does not match the manifest', fix });
    list.push(f.path);
  }
  return { source: resolve(source), dest: 'custody/rs1', list: [...list, rel], env: ['GBRAIN_EVALS_RS1_SOURCE=~/custody/rs1', `GBRAIN_EVALS_RS1_MANIFEST=~/custody/rs1/${rel}`] };
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
  /** BG1 (#398 open note 6): leases.ndjson's SHA-256 as this campaign last wrote it. */
  private get eventsShaPath() { return join(this.stateDir, 'leases.sha256'); }
  private get bg1() { return this.q1 && this.manifest.cells.some(c => c.benchmark === 'bg1' || c.benchmark === 'bg1-dev'); }
  /** BG1: held while a process reads or writes the lease log, so units run in parallel on one --state never see each other's half-written append. */
  private get eventsLockPath() { return join(this.stateDir, 'leases.lock'); }
  private lockDepth = 0;
  private get frozenPath() { return join(this.stateDir, 'frozen-tree.json'); }
  private state(): CampaignState {
    if (!existsSync(this.statePath)) throw new Error(`${this.stateDir} has no campaign; run \`bun eval/runner/shootout-cell.ts init\` first`);
    const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as CampaignState;
    if (s.campaign_id !== this.manifest.campaign_id) throw new Error(`${this.stateDir} belongs to campaign ${s.campaign_id}, not ${this.manifest.campaign_id}`);
    return { ...s, ledger: this.ledgerPath(s.ledger) };
  }
  /**
   * campaign.json names the ledger relative to the checkout (A23), so a state directory moved to another host finds
   * it. A state written before A23 holds an absolute path; one that does not exist on this host and ends with the
   * manifest's ledger path resolves to that path in this checkout.
   */
  private ledgerPath(recorded: string): string {
    if (!isAbsolute(recorded)) return resolve(REPO_ROOT, recorded);
    if (existsSync(recorded) || !recorded.endsWith(`/${this.manifest.ledger}`)) return recorded;
    return this.ledger;
  }
  private run(): BudgetRun { const s = this.state(); return BudgetRun.join({ runId: s.run_id, ledgerPath: s.ledger, programCapMaxUsd: this.manifest.cap_usd }); }
  /** BG1: run fn holding leases.lock (O_EXCL, budget-ledger withFileLock), re-entered freely by the process holding it; a lock held past its bounded wait refuses. Other campaigns run fn as is. */
  private locked<T>(fn: () => T): T {
    if (!this.bg1 || this.lockDepth > 0) return fn();
    let entered = false;
    try {
      return withFileLock(this.eventsLockPath, () => { entered = true; this.lockDepth++; try { return fn(); } finally { this.lockDepth--; } });
    } catch (e) {
      if (entered || !(e instanceof BudgetExceededError)) throw e;
      throw refuse({ code: 'LEASE_STATE', message: `${this.eventsLockPath} stayed held past its wait, so campaign ${this.manifest.campaign_id} cannot read or write its lease log`,
        why: 'a BG1 lease event is written and its SHA-256 recorded under one lock, so parallel units on one --state never read a half-written log or leave a stale SHA-256',
        fix: { next: 'ask_user', user_message: `another process on this --state holds ${basename(this.eventsLockPath)}; let it finish, or, if no process holds it, remove ${this.eventsLockPath} and retry` } });
    }
  }
  private append(e: LeaseEvent) {
    this.locked(() => {
      if (this.bg1) this.events();
      appendFileSync(this.eventsPath, JSON.stringify(e) + '\n');
      if (this.bg1) writeFileSync(this.eventsShaPath, createHash('sha256').update(readFileSync(this.eventsPath)).digest('hex') + '\n');
    });
  }
  /**
   * The lease log's lines. A BG1 campaign reads it under leases.lock and refuses a log that is not the one it last wrote
   * (its SHA-256 beside it), so an edited lease never reaches a unit. A log emptied, cut down or removed together with
   * its SHA-256 still reads here; reconcileBg1 refuses it before reserve, payload, launch and resume.
   */
  private events(): string[] {
    return this.locked(() => {
      const text = existsSync(this.eventsPath) ? readFileSync(this.eventsPath, 'utf8') : null;
      if (this.bg1 && (text !== null || existsSync(this.eventsShaPath))) {
        const kept = existsSync(this.eventsShaPath) ? readFileSync(this.eventsShaPath, 'utf8').trim() : 'none';
        if (text === null || kept !== createHash('sha256').update(text).digest('hex')) throw refuse({ code: 'CAMPAIGN_HASH_MISMATCH', message: `${this.eventsPath} is not the lease log campaign ${this.manifest.campaign_id} last wrote (${basename(this.eventsShaPath)} holds ${kept.slice(0, 12)})`,
          why: 'a BG1 unit\'s proxy spends the lease its reserved event names, so a lease log edited outside the campaign could hand a unit a lease the ledger never reserved',
          fix: { next: 'ask_user', user_message: this.bg1Ask(`leases.ndjson changed outside the campaign (leases.sha256 holds ${kept.slice(0, 12)})`) } });
      }
      return text === null ? [] : text.split('\n').filter(Boolean);
    });
  }
  /**
   * BG1, once campaign.json exists: refuse unless the lease log and the campaign ledger match. Every entry this
   * campaign's run holds with spend (actual, else reserved, above 0) is named by exactly one reserved event in the log,
   * and every reserved event names an entry the run holds. A log emptied or cut down with its SHA-256 rewritten would
   * otherwise read as fewer leases than the ledger charges, so a unit could be reserved again and blockSpend would
   * undercount. Each lease_id is reserved once, and each lease's state matches its entry: a lease settled or abandoned
   * in the log has its entry settled at the amount the log charges, to the cent (raise-lease reserves a raise in whole
   * cents, so a charged abandon must match what the ledger reserved), and an open lease has an open entry, so a log that
   * closes a lease the ledger still holds open never frees its unit for a second reservation. It reads the log and the
   * ledger under leases.lock, where a BG1 settle or abandon writes both, and changes neither, so a refused reserve
   * holds no reservation.
   */
  private reconcileBg1(): void {
    if (!this.bg1 || !existsSync(this.statePath)) return;
    this.locked(() => {
      const s = this.state();
      const reserved = this.events().map(x => JSON.parse(x) as LeaseEvent).filter((e): e is Extract<LeaseEvent, { event: 'reserved' }> => e.event === 'reserved');
      const entries = readLedger(s.ledger).entries.filter(e => e.run_id === s.run_id);
      const held = new Map(entries.map(e => [e.id, e] as const));
      const problems = [
        ...entries.filter(e => (e.actual_usd ?? e.reserved_usd) > 0).map(e => [e, reserved.filter(r => r.entry_id === e.id).length] as const).filter(([, n]) => n !== 1)
          .map(([e, n]) => `ledger entry ${e.id} ("${e.description}") has spend, and ${n} reserved events in the lease log name it`),
        ...reserved.filter(r => !held.has(r.entry_id)).map(r => `lease ${r.lease_id} names ledger entry ${r.entry_id}, which campaign run ${s.run_id} does not hold`),
        ...reserved.filter(r => r.lease_id !== mintLeaseId(r.cell, r.attempt, r.entry_id))
          .map(r => `lease ${r.lease_id} is not the id reserve() gives attempt ${r.attempt} of unit ${r.cell} on ledger entry ${r.entry_id}, ${mintLeaseId(r.cell, r.attempt, r.entry_id)}`),
        ...[...new Set(reserved.map(r => r.lease_id))].map(id => [id, reserved.filter(r => r.lease_id === id).length] as const).filter(([, n]) => n > 1)
          .map(([id, n]) => `lease ${id} is reserved ${n} times in the lease log`),
        ...this.leases().flatMap(l => {
          const e = held.get(l.entry_id);
          if (!e) return [];
          if (l.status !== 'settled' && l.status !== 'abandoned') return e.actual_usd === null ? [] : [`lease ${l.lease_id} is ${l.status} in the lease log, and the ledger settled its entry ${e.id} at ${e.actual_usd}`];
          const cents = (usd: number | null | undefined) => usd === null || usd === undefined ? NaN : Math.round(usd * 100);
          const charged = l.status === 'abandoned' && (l.actual_usd ?? 0) > 0;
          return cents(e.actual_usd) === cents(l.actual_usd) && (!charged || cents(e.actual_usd) === cents(e.reserved_usd)) ? []
            : [`lease ${l.lease_id} is ${l.status} at ${l.actual_usd} in the lease log, and the ledger ${e.actual_usd === null ? `holds its entry ${e.id} open` : `settled its entry ${e.id} at ${e.actual_usd}${charged ? ` of the ${e.reserved_usd} it reserved` : ''}`}`];
        }),
      ];
      if (problems.length) throw refuse({ code: 'CAMPAIGN_HASH_MISMATCH', message: `campaign ${this.manifest.campaign_id}'s lease log and ledger do not match: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`,
        why: 'every reservation the campaign run holds is one lease this campaign logged, open in both or closed at the same amount in both, so a log missing a lease, or closing one the ledger still holds, would hide spend the ledger still charges and let a unit reserve as if it were not there',
        fix: { next: 'ask_user', user_message: this.bg1Ask(`leases.ndjson does not match what campaign run ${s.run_id} holds in the ledger (${problems.slice(0, 3).join('; ')})`) } });
    });
  }
  /**
   * BG1: the stop-and-ask hint for a lease log the campaign cannot trust. It names each lease the campaign ledger still
   * holds open (its lease id as reserve() builds it, and its ledger entry), because restoring an older leases.ndjson or
   * leases.sha256, or starting the campaign in a fresh --state, could launch one of them again while it is live.
   */
  private bg1Ask(what: string): string {
    let open = 'none (this --state has no campaign.json)';
    if (existsSync(this.statePath)) {
      try {
        const s = this.state();
        open = readLedger(s.ledger).entries.filter(e => e.run_id === s.run_id && e.actual_usd === null)
          .map(e => { const m = /^lease (\S+) attempt (\d+)$/.exec(e.description); return m ? `lease ${mintLeaseId(m[1], Number(m[2]), e.id)} (ledger entry ${e.id})` : `ledger entry ${e.id} ("${e.description}")`; }).join('; ') || 'none';
      } catch (e) { open = `unknown, because the campaign ledger could not be read (${(e as Error).message})`; }
    }
    return `Stop and ask the campaign owner before anything else runs on ${this.stateDir}: ${what}. Leases the campaign ledger still holds open: ${open}. Do not restore an older leases.ndjson or leases.sha256, edit either file, or start the campaign in a fresh --state; any of those could launch a unit again while its lease is live.`;
  }
  cell(id: string): CellSpec { const c = this.manifest.cells.find(x => x.id === id); if (!c) throw new Error(`no cell ${id} in campaign ${this.manifest.campaign_id}`); return c; }

  /** Create the campaign ledger (its program cap is the campaign cap) and the one campaign run every lease reserves from. A Q1 campaign also freezes its executed tree. */
  init(): CampaignState {
    if (existsSync(this.statePath)) return this.state();
    if (this.bg1 && [this.eventsPath, this.eventsShaPath].some(f => existsSync(f))) {
      const named = (existsSync(this.eventsPath) ? readFileSync(this.eventsPath, 'utf8') : '').split('\n').flatMap(x => {
        try { const e = JSON.parse(x) as LeaseEvent; return e.event === 'reserved' ? [`lease ${e.lease_id} (ledger entry ${e.entry_id})`] : []; } catch { return []; }
      });
      throw refuse({ code: 'CAMPAIGN_HASH_MISMATCH', message: `${this.stateDir} holds a lease log before campaign ${this.manifest.campaign_id} was initialised`,
        why: 'every BG1 lease event is one this campaign wrote after init, so a log already there could hand a unit a lease the ledger never reserved',
        fix: { next: 'ask_user', user_message: this.bg1Ask(`it holds a lease log${named.length ? ` naming ${named.join('; ')}` : ''} but no campaign.json, so those leases may belong to a campaign that is still running`) } });
    }
    const label = this.q1 ? 'q1-scoreboard' : 'oss-shootout';
    if (!existsSync(this.ledger)) initLedger({ ledgerPath: this.ledger, programCapUsd: this.manifest.cap_usd, reason: `${this.q1 ? 'Q1 scoreboard' : 'oss shootout'} campaign ${this.manifest.campaign_id}` });
    const run = BudgetRun.open({ runner: `${label}:${this.manifest.campaign_id}`, budgetUsd: this.manifest.cap_usd, ledgerPath: this.ledger, programCapMaxUsd: this.manifest.cap_usd });
    const s: CampaignState = { campaign_id: this.manifest.campaign_id, run_id: run.runId, ledger: relative(REPO_ROOT, this.ledger), manifest_sha256: this.sha, created_at: new Date().toISOString(), ...(this.q1 ? { kind: Q1_KIND } : {}) };
    if (this.q1) {
      let commit: string | null = null, dirty: string[] = [];
      try {
        commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', ...(this.manifest.executes ?? [])], { encoding: 'utf8' }).split('\n').filter(Boolean).map(l => l.slice(3));
      } catch { commit = null; }
      writeFileSync(this.frozenPath, JSON.stringify({ campaign_id: this.manifest.campaign_id, sha256: this.sha, commit, dirty, images: this.manifest.images ?? {}, tree: this.tree }, null, 2) + '\n');
    }
    writeFileSync(this.statePath, JSON.stringify(s, null, 2) + '\n');
    return this.state();
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
    const lines = this.events();
    if (!lines.length) return [];
    const raisesPath = join(this.stateDir, 'raises.ndjson');
    const raised = new Map<string, number>(existsSync(raisesPath) ? readFileSync(raisesPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { lease_id: string; to_usd: number }).map(r => [r.lease_id, r.to_usd]) : []);
    for (const line of lines) {
      const e = JSON.parse(line) as LeaseEvent;
      if (e.event === 'reserved') { out.set(e.lease_id, { lease_id: e.lease_id, cell: e.cell, attempt: e.attempt, usd: e.usd, entry_id: e.entry_id, max_output_tokens: e.max_output_tokens ?? null, status: 'reserved', ...(raised.has(e.lease_id) ? { raised_usd: raised.get(e.lease_id) } : {}) }); continue; }
      const l = out.get(e.lease_id);
      if (!l) continue;
      if (e.event === 'launched') { l.status = 'launched'; if (e.vm !== undefined) l.vm = e.vm; if (e.restore !== undefined) l.restored_from = e.restore; }
      else if (e.event === 'finished') { l.status = 'finished'; l.exit_code = e.exit_code; }
      else if (e.event === 'settled') { l.status = 'settled'; l.actual_usd = e.actual_usd; if (e.timed_out) l.timed_out = true; if (e.cell_exit_code !== undefined) l.cell_exit_code = e.cell_exit_code; }
      else if (e.event === 'abandoned') { l.status = 'abandoned'; l.actual_usd = e.unstarted ? 0 : l.raised_usd ?? l.usd; }
      else if (e.event === 'realized') l.realization_id = e.realization_id;
    }
    return [...out.values()];
  }
  lease(id: string): LeaseState { const l = this.leases().find(x => x.lease_id === id); if (!l) throw new Error(`no lease ${id}`); return l; }
  realizedEvents(): Extract<LeaseEvent, { event: 'realized' }>[] {
    return this.events().map(l => JSON.parse(l) as LeaseEvent).filter((e): e is Extract<LeaseEvent, { event: 'realized' }> => e.event === 'realized');
  }

  /** Q1: dollars held by a block's leases (reserved, running, settled or abandoned at their charge). */
  blockSpend(block: string): number {
    return this.leases().filter(l => this.manifest.cells.find(c => c.id === l.cell)?.block === block)
      .reduce((n, l) => n + (l.status === 'settled' || l.status === 'abandoned' ? l.actual_usd ?? l.usd : l.raised_usd ?? l.usd), 0);
  }

  /**
   * Reserve a new lease for a cell; refused while the cell holds an unsettled lease, or when the campaign cap (or a Q1
   * block cap) would be passed. A BG1 reserve holds leases.lock from its first read of the lease log to its append,
   * refuses before it touches the ledger when the lease log and the ledger do not match (reconcileBg1), and gives the
   * ledger reservation back (settled at 0) when the append refuses, so no refusal leaves a reservation the lease log
   * does not name.
   */
  reserve(cellId: string): LeaseState {
    this.verifyFrozen('reserve');
    const unfilled = Object.entries(this.manifest.parameters ?? {}).filter(([, v]) => v === UNFILLED).map(([k]) => k);
    if (unfilled.length) throw new Error(`campaign parameters ${unfilled.join(', ')} are still ${UNFILLED}; the freezing commit fills them before any lease`);
    return this.locked(() => {
      this.reconcileBg1();
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
      const l: LeaseState = { lease_id: mintLeaseId(cellId, attempt, entry), cell: cellId, attempt, usd: c.lease_usd, entry_id: entry, max_output_tokens: c.max_output_tokens ?? null, status: 'reserved' };
      try { this.append({ event: 'reserved', lease_id: l.lease_id, cell: cellId, attempt, usd: c.lease_usd, entry_id: entry, at: new Date().toISOString(), max_output_tokens: l.max_output_tokens }); }
      catch (e) { if (this.bg1) this.run().settle(entry, { usd: 0 }); throw e; }
      return l;
    });
  }

  resultsDir(l: LeaseState) { return join(this.stateDir, 'results', l.cell, l.lease_id); }
  remoteOut(l: LeaseState) { return `eval/reports/shootout/${l.cell}/${l.lease_id}`; }
  /** Q1 sealed cells (A17) keep their output in the VM's custody root, outside the checkout. */
  sealedQ1(cellId: string) { return this.q1 && !!this.cell(cellId).sealed; }
  /** The cell's output on the VM, relative to the VM user's home: what ubi-runner and reattach pull. */
  remotePath(l: LeaseState) { return this.sealedQ1(l.cell) ? `custody/out/${l.cell}/${l.lease_id}` : `work/${basename(REPO_ROOT)}/${this.remoteOut(l)}`; }

  /** A17: what a sealed BEAM-10M, D8 or RS1 cell's launch pushes to the VM before setup (null for every other cell). */
  custodyPush(cellId: string, env: Record<string, string | undefined> = process.env): CustodyPush | null {
    if (!this.sealedQ1(cellId)) return null;
    const benchmark = this.cell(cellId).benchmark;
    if (benchmark === 'bg1') return bg1CustodyPush(env, this.manifestPath, this.cell(cellId).bg1_unit);
    return benchmark === 'beam-10m' ? beam10mCustodyPush(env, this.manifestPath) : benchmark === 'beam-d8' ? d8CustodyPush(env, this.manifestPath)
      : benchmark === 'beam-rs1' ? rs1CustodyPush(env, this.manifestPath) : null;
  }

  /** Q1: the VM name, in ubi-runner's ownership format so `list --mine` and teardown find it, ending in `-t<hours>`: the cell's timeout, the launcher's backstop and two hours for setup and the final pull, so an age-based sweep of TTL-less `ubirun-*` VMs leaves a running cell alone (A3). */
  vmName(l: LeaseState, env: Record<string, string | undefined> = process.env): string {
    const owner = ownerTag(env.UBI_OWNER);
    if (!owner) throw refuse({ code: 'OWNER_UNSET', message: 'UBI_OWNER is not set', why: 'scoreboard VMs carry their owner in the name so each thread destroys only its own VMs and the quota report shows who uses what',
      fix: { next: 'run', argv: ['export', 'UBI_OWNER=<your thread code, for example gbra49>'], verify: ['bash', 'scripts/ubicloud/ubi-runner.sh', 'owner'] } });
    const suffix = createHash('sha256').update(l.lease_id).digest('hex').slice(0, 6);
    const ttl = Math.min(999, Math.ceil((this.cell(l.cell).timeout_hours ?? 0) + BACKSTOP_HOURS + 2));
    return `ubirun-${owner}-${Math.floor(Date.now() / 1000)}-${suffix}-t${ttl}`;
  }

  /** The VM payload for a lease; Q1 cells carry their timeout, checkpoint interval, snapshot command, route caps and admission share. */
  payload(l: LeaseState, restore?: RemotePayload['restore']): RemotePayload {
    this.bindBg1Lease(l);
    const c = this.cell(l.cell);
    const base: RemotePayload = { lease_id: l.lease_id, lease_usd: l.usd, max_output_tokens: l.max_output_tokens, command: c.command, out: this.remoteOut(l) };
    if (c.timeout_hours !== undefined) base.timeout_hours = c.timeout_hours;
    if (!this.q1) return c.sealed ? { ...base, sealed: true } : base;
    return { ...base, ...(c.sealed ? { sealed: true, out: `~/${this.remotePath(l)}` } : {}), cell: c.id, campaign_sha256: this.sha, row_pull_every: this.manifest.row_pull_every ?? ROW_PULL_EVERY,
      ...(c.snapshot_command ? { snapshot_command: c.snapshot_command } : {}), ...(restore ? { restore } : {}),
      route_caps: { caps: { ...DEFAULT_ROUTE_CAPS, ...(this.manifest.output_caps ?? {}) }, slots: { ...DEFAULT_ROUTE_CLASSES, ...(this.manifest.route_classes ?? {}) }, defaultClass: 'extraction' },
      ...(this.manifest.provider_limits ? { admission: this.admissionShare(c) } : {}), ...(c.gemini_key_env ? { gemini_key_env: c.gemini_key_env } : {}) };
  }

  /**
   * BG1: refuse a lease whose usd or max_output_tokens is not its unit's in the frozen campaign manifest, or, once
   * campaign.json exists, one the campaign ledger does not hold at that amount in this campaign's run (open, while the
   * lease is reserved) under the lease's own description, `lease <cell> attempt <n>` as reserve() writes it. Also
   * refuse a lease whose ledger entry another reserved event in the log names, so one entry never backs two leases, and
   * one whose id is not the id reserve() mints from its cell, attempt and entry, so a lease renamed in the log never
   * claims a fresh results directory for an entry that already launched.
   * Then the whole log must match the ledger (reconcileBg1). leases.sha256 only shows the log is the one last written,
   * so a coordinated edit of both files stops here before a proxy is handed the lease. Other campaigns pass untouched.
   */
  private bindBg1Lease(l: LeaseState): void {
    if (!this.bg1) return;
    const c = this.cell(l.cell);
    const problems: string[] = [];
    const minted = mintLeaseId(l.cell, l.attempt, l.entry_id);
    if (l.lease_id !== minted) problems.push(`is not the id reserve() gives attempt ${l.attempt} of unit ${l.cell} on ledger entry ${l.entry_id}, ${minted}`);
    if (Math.abs(l.usd - c.lease_usd) > 1e-9) problems.push(`leases ${l.usd}, and the frozen campaign gives unit ${c.id} ${c.lease_usd}`);
    if ((l.max_output_tokens ?? null) !== (c.max_output_tokens ?? null)) problems.push(`caps output at ${l.max_output_tokens}, and the frozen campaign gives unit ${c.id} ${c.max_output_tokens ?? null}`);
    if (existsSync(this.statePath)) {
      const s = this.state();
      const entry = readLedger(s.ledger).entries.find(e => e.id === l.entry_id && e.run_id === s.run_id);
      if (!entry) problems.push(`names ledger entry ${l.entry_id}, which campaign run ${s.run_id} does not hold`);
      else if (entry.description !== `lease ${l.cell} attempt ${l.attempt}`) problems.push(`names ledger entry ${l.entry_id}, which the ledger holds for "${entry.description}", not "lease ${l.cell} attempt ${l.attempt}"`);
      else if (Math.abs(entry.reserved_usd - (l.raised_usd ?? l.usd)) > 1e-9) problems.push(`holds ${l.raised_usd ?? l.usd}, and the ledger reserved ${entry.reserved_usd} for it`);
      else if (l.status === 'reserved' && entry.actual_usd !== null) problems.push(`is reserved in the lease log, and the ledger already settled it at ${entry.actual_usd}`);
    }
    const named = this.events().map(x => JSON.parse(x) as LeaseEvent).filter(e => e.event === 'reserved' && e.entry_id === l.entry_id).length;
    if (named > 1) problems.push(`names ledger entry ${l.entry_id}, which ${named} reserved events in the lease log name`);
    if (problems.length) throw refuse({ code: 'CAMPAIGN_HASH_MISMATCH', message: `lease ${l.lease_id}: ${problems.join('; ')}`,
      why: 'a BG1 unit\'s proxy spends the lease handed to it, so the lease must be the one the frozen campaign prices for its unit and the ledger holds for it',
      fix: { next: 'ask_user', user_message: this.bg1Ask(`leases.ndjson hands out lease ${l.lease_id} (ledger entry ${l.entry_id}), which is not the lease the campaign reserved: ${problems.join('; ')}`) } });
    this.reconcileBg1();
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

  /** The ubi-runner invocation for a lease: provision, sync, set up, run the cell remotely, pull its output, destroy. A local cell runs the remote step here. */
  launchArgv(l: LeaseState, opts: { vm?: string | null; restore?: RemotePayload['restore']; restoreFrom?: string } = {}): string[] {
    const c = this.cell(l.cell);
    if (c.local) return this.localArgv(l, localPort(l.lease_id), opts.restore);
    const payload = Buffer.from(JSON.stringify(this.payload(l, opts.restore))).toString('base64');
    const push = this.custodyPush(l.cell);
    let pushArgs: string[] = [];
    if (push) {
      mkdirSync(join(this.stateDir, 'setup'), { recursive: true });
      const listFile = join(this.stateDir, 'setup', `${l.cell}.push`);
      writeFileSync(listFile, push.list.join('\n') + '\n');
      pushArgs = ['--push', `${push.source}:${push.dest}:${listFile}`, ...push.env.flatMap(e => ['--env', e])];
    }
    if (opts.restore?.dir === '~/custody/restore' && opts.restoreFrom) pushArgs.push('--push', `${opts.restoreFrom}:custody/restore`);
    let setup = c.setup ? (existsSync(resolve(REPO_ROOT, c.setup)) ? resolve(REPO_ROOT, c.setup) : resolve(c.setup)) : null;
    if (c.setup_command) {
      mkdirSync(join(this.stateDir, 'setup'), { recursive: true });
      setup = join(this.stateDir, 'setup', `${l.cell}.sh`);
      writeFileSync(setup, `set -euo pipefail\n${c.setup_command}\n`);
    }
    return ['bash', resolveRunner(), 'run', '-s', c.vm?.size ?? 'standard-8', '-l', c.vm?.location ?? 'eu-central-h1', ...(c.vm?.storage_gib ? ['-S', String(c.vm.storage_gib)] : []),
      ...(opts.vm ? ['-n', opts.vm] : []), ...(setup ? ['--setup', setup] : []), ...(c.pass ?? []).flatMap(p => ['--pass', p]), ...pushArgs,
      '--pull', `${this.remotePath(l)}:${dirname(this.resultsDir(l))}`,
      '--', `bun eval/runner/shootout-cell.ts remote --cell-b64 ${payload}`];
  }

  /** `run --local`: the same remote command on this machine, writing straight into the lease's results directory (no VM, no pull). */
  localArgv(l: LeaseState, port: number, restore?: RemotePayload['restore']): string[] {
    const payload = { ...this.payload(l, restore), out: this.resultsDir(l) };
    return [process.execPath, join(REPO_ROOT, 'eval/runner/shootout-cell.ts'), 'remote', '--cell-b64', Buffer.from(JSON.stringify(payload)).toString('base64'), '--port', String(port)];
  }

  /**
   * Launch a reserved lease. The launch is recorded before the VM starts, so a
   * crash at any point leaves a launched lease that is never launched again. A BG1
   * launch records it under leases.lock, after re-reading the lease as reserved and
   * creating its results directory fresh, and releases the lock before the VM boots.
   */
  async launch(cellId: string, runner: Runner, opts: { restore?: RemotePayload['restore']; restoreFrom?: string; local?: { port: number } } = {}): Promise<LeaseState> {
    this.verifyFrozen('launch');
    const l = this.leases().find(x => x.cell === cellId && x.status === 'reserved');
    if (!l) {
      this.reconcileBg1();
      const used = this.leases().find(x => x.cell === cellId && (x.status === 'launched' || x.status === 'finished'));
      throw new Error(used ? `lease ${used.lease_id} was already launched; a lease is used once (settle or abandon it, then reserve again)` : `cell ${cellId} has no reserved lease; run reserve first`);
    }
    this.bindBg1Lease(l);
    const c = this.cell(cellId);
    if (this.sealedQ1(cellId) && insideRepository(this.stateDir)) throw refuse({ code: 'SEALED_CELL_LOCAL', message: `cell ${cellId} is sealed and --state ${this.stateDir} is inside the repository`,
      why: 'a sealed cell\'s rows, checkpoints and snapshots are pulled into the state directory, which must be a custody directory outside the checkout (A17)',
      fix: { next: 'tell_user_to_run', argv: ['bun', 'run', 'eval:scoreboard', 'doctor', '--for', 'sealed', '--campaign', this.manifestPath, '--state', '<custody dir outside the repository>/state'], user_message: 'relaunch with --state under the custody root, outside the checkout' } });
    const vm = this.q1 && !opts.local ? this.vmName(l) : null;
    const argv = opts.local ? this.localArgv(l, opts.local.port, opts.restore) : this.launchArgv(l, { vm, restore: opts.restore, restoreFrom: opts.restoreFrom });
    this.locked(() => {
      if (this.bg1) {
        const dir = this.resultsDir(l), now = this.leases().find(x => x.lease_id === l.lease_id)?.status ?? 'missing';
        mkdirSync(dirname(dir), { recursive: true });
        let claimed = now === 'reserved';
        if (claimed) try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; claimed = false; }
        if (!claimed) throw refuse({ code: 'LEASE_STATE', message: `lease ${l.lease_id} (ledger entry ${l.entry_id}) ${now === 'reserved' ? `already has a results directory, ${dir}` : `is ${now} in the lease log`}, so it may already have booted; launch refused`,
          why: 'a lease is used once: a BG1 launch re-reads the lease log and claims the lease\'s results directory under leases.lock, so a stale or restored log, or a second process, never boots a second VM on one reservation',
          fix: { next: 'ask_user', user_message: `Stop and ask the campaign owner before touching lease ${l.lease_id} (ledger entry ${l.entry_id}): it may be running or have run. Do not restore an older leases.ndjson or leases.sha256, remove ${dir}, or start a fresh --state over this campaign's leases.` } });
      } else mkdirSync(this.resultsDir(l), { recursive: true });
      this.append({ event: 'launched', lease_id: l.lease_id, at: new Date().toISOString(), argv, ...(this.q1 ? { vm, restore: opts.restore?.realization_id ?? null } : {}) });
    });
    const ctx: LaunchContext = { lease: l, cell: c, vm, remoteOut: this.remotePath(l), resultsDir: this.resultsDir(l), runner: argv[1],
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
   * Q1: rerun a cell whose VM was lost or whose run left gaps. The cell's last lease must be closed (an abandoned
   * lease stays charged in full). `from` names another campaign whose leases hold the cell's earlier run (A22: wave-1
   * gaps rerun under the re-frozen campaign). The resume stages the last checkpoint, so every answer and judgment
   * already recorded is kept and never repeated. Before it is used, a pulled realization's snapshot files are checked
   * against the sha256 values recorded when it was realized: with a verified realization and a `restore_command`
   * the new lease restores the store and runs only what is missing (mode `snapshot`); with no usable snapshot but a
   * checkpoint, the cell ingests again and answers only the questions the checkpoint lacks (mode `answers`); with
   * neither, it runs in full (mode `repeat`). A realization pulled after its lease closed (A23: a final pull that
   * failed, the lease abandoned, the kept VM pulled later) is recorded here first, so the resume can restore it.
   */
  async resume(cellId: string, runner: Runner, opts: { local?: { port: number }; from?: Campaign } = {}): Promise<{ mode: 'snapshot' | 'answers' | 'repeat'; realization_id: string | null; snapshot_check: string; lease: LeaseState; note: string }> {
    if (!this.q1) throw new Error('resume is for Q1 scoreboard campaigns');
    this.verifyFrozen('resume');
    this.reconcileBg1();
    const c = this.cell(cellId);
    const src = opts.from ?? this;
    const theirs = src.leases().filter(l => l.cell === cellId);
    const open = [...theirs, ...(src === this ? [] : this.leases().filter(l => l.cell === cellId))].find(l => l.status === 'launched' || l.status === 'finished');
    if (open) throw refuse({ code: 'RESUME_REFUSED', message: `cell ${cellId} still holds lease ${open.lease_id} (${open.status}); its VM never reported back`,
      why: 'a lease is used once; a lost VM\'s lease is closed by abandoning it, which charges its full reservation against the cap',
      fix: { next: 'run', argv: ['bun', 'eval/runner/shootout-cell.ts', 'abandon', '--campaign', src.manifestPath, '--state', src.stateDir, '--lease', open.lease_id, '--reason', 'VM lost'],
        verify: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', src.manifestPath, '--state', src.stateDir] } });
    const ids = new Set(theirs.map(l => l.lease_id));
    for (const l of theirs) if (l.status !== 'reserved') src.recordRealization(l.lease_id);
    const realized = src.realizedEvents().filter(e => ids.has(e.lease_id)).at(-1) ?? null;
    let snapshotCheck = realized ? 'verified' : 'none';
    if (realized) {
      const dir = join(src.resultsDir(src.lease(realized.lease_id)), 'realization', 'snapshot');
      const bad = realized.files.find(f => { const abs = join(dir, f.path); return !existsSync(abs) || statSync(abs).size !== f.bytes || sha256File(abs) !== f.sha256; });
      if (bad) snapshotCheck = `damaged: ${bad.path} does not match the sha256 recorded when ${realized.realization_id} was realized`;
      const gap = bad ? null : realized.files.map(f => ({ f, why: snapshotStoreGap(c.system, join(dir, f.path)) })).find(g => g.why);
      if (gap) snapshotCheck = `incomplete: ${gap.f.path} ${gap.why}`;
    }
    const usable = realized && snapshotCheck === 'verified' && c.restore_command ? realized : null;
    const last = [...theirs].reverse().find(l => existsSync(join(src.resultsDir(l), 'checkpoint')));
    let restore: RemotePayload['restore'] | undefined;
    let staged: string | null = null;
    if (usable || last) {
      const sealed = this.sealedQ1(cellId);
      staged = join(sealed ? join(this.stateDir, 'restore') : join(REPO_ROOT, '.scoreboard-restore'), `${cellId}-${usable?.realization_id ?? 'checkpoint'}`);
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(staged, { recursive: true });
      if (usable) cpSync(join(src.resultsDir(src.lease(usable.lease_id)), 'realization'), join(staged, 'realization'), { recursive: true });
      const ckpt = last ? join(src.resultsDir(last), 'checkpoint') : null;
      if (ckpt) cpSync(ckpt, join(staged, 'checkpoint'), { recursive: true });
      restore = { realization_id: usable?.realization_id ?? null, dir: sealed && !opts.local ? '~/custody/restore' : relative(REPO_ROOT, staged), ...(usable ? { restore_command: c.restore_command } : {}) };
    }
    const lease = this.reserve(cellId);
    try { await this.launch(cellId, runner, { restore, restoreFrom: staged ?? undefined, local: opts.local }); }
    finally { if (staged) rmSync(staged, { recursive: true, force: true }); }
    const mode = usable ? 'snapshot' : last ? 'answers' : 'repeat';
    const why = realized && !usable ? (snapshotCheck !== 'verified' ? `realization ${realized.realization_id} is ${snapshotCheck}` : `cell ${cellId} has realization ${realized.realization_id} but no restore_command`) : 'no realization was pulled';
    const note = mode === 'snapshot' ? `resumed from realization ${usable!.realization_id}: the store snapshot and checkpointed rows were restored, so only missing questions ran`
      : mode === 'answers' ? `${why}, so the store was ingested again; the checkpoint's answers and judgments were kept and only questions without them were answered`
        : `${why} and no checkpoint was pulled, so the whole cell ran again`;
    return { mode, realization_id: usable?.realization_id ?? null, snapshot_check: snapshotCheck, lease: this.lease(lease.lease_id), note };
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
    this.locked(() => {
      this.run().settle(l.entry_id, { usd: committed });
      this.append({ event: 'settled', lease_id: leaseId, at: new Date().toISOString(), actual_usd: committed, requests, max_output_tokens: maxOut ?? null,
        ...(timedOut ? { timed_out: true } : {}), ...(cellExit !== undefined ? { cell_exit_code: cellExit } : {}) });
    });
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
      this.locked(() => {
        this.run().settle(l.entry_id, null);
        this.append({ event: 'abandoned', lease_id: leaseId, at: new Date().toISOString(), reason });
      });
      return { ...this.lease(leaseId), note: `abandoned lease ${leaseId} is charged its full reservation of ${usd(l.raised_usd ?? l.usd)} against the campaign cap, because no VM ledger came back to settle it to what was really spent. `
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
    this.locked(() => {
      this.run().settle(l.entry_id, { usd: 0 });
      this.append({ event: 'abandoned', lease_id: leaseId, at: new Date().toISOString(), reason, unstarted: { evidence } });
    });
    return this.lease(leaseId);
  }

  /** Move the ledger's program cap and the campaign run's budget up to the manifest's cap_usd (a cap the user raised). */
  raiseCap(reason: string) {
    const s = this.state();
    if (!reason.trim()) throw new Error('raise-cap needs --reason');
    const cap = this.manifest.cap_usd;
    const before = ledgerStatus({ ledgerPath: s.ledger, runId: s.run_id });
    const program = (before.totals?.program_cap_usd ?? 0) < cap ? setProgramCap({ ledgerPath: s.ledger, programCapUsd: cap, reason }) : null;
    const run = setRunBudget({ ledgerPath: s.ledger, runId: s.run_id, budgetUsd: cap });
    return { cap_usd: cap, program, run };
  }

  status() {
    const s = this.state();
    const ledger = ledgerStatus({ ledgerPath: s.ledger, runId: s.run_id });
    const leases = this.leases();
    const unsettled = leases.filter(l => l.status === 'reserved' || l.status === 'launched' || l.status === 'finished').reduce((n, l) => n + (l.raised_usd ?? l.usd), 0);
    const abandonedFull = leases.filter(l => l.status === 'abandoned' && l.actual_usd !== 0).reduce((n, l) => n + (l.actual_usd ?? 0), 0);
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
export async function runRemote(payload: RemotePayload, opts: { port?: number; pollMs?: number; upstream?: Record<string, string>; custodyBase?: string } = {}): Promise<number> {
  const out = resolve(expandHome(payload.out));
  mkdirSync(out, { recursive: true });
  const custody = payload.sealed ? resolve(opts.custodyBase ?? join(homedir(), 'custody'), payload.lease_id) : null;
  const traces = custody ? join(custody, 'proxy') : out;
  mkdirSync(traces, { recursive: true });
  const port = opts.port ?? 8787;
  const ledger = join(traces, 'lease.sqlite');
  const controlToken = randomUUID();
  const cellToken = randomUUID();
  const extra: string[] = [];
  if (payload.route_caps) extra.push('--route-caps', Object.entries(payload.route_caps.caps).map(([k, v]) => `${k}=${v}`).join(','),
    '--route-class', Object.entries(payload.route_caps.slots).map(([k, v]) => `${k}=${v}`).join(','), '--default-route-class', payload.route_caps.defaultClass);
  for (const [prov, lim] of Object.entries(payload.admission ?? {})) extra.push('--admission', `${prov}=${Object.entries(lim!).map(([k, v]) => `${k}:${v}`).join(',')}`);
  const proxy = Bun.spawn([process.execPath, join(REPO_ROOT, 'eval/runner/metering-proxy.ts'), '--listen', `0.0.0.0:${port}`, '--budget-ledger', ledger, '--lease-usd', String(payload.lease_usd),
    '--run-id', payload.lease_id, '--usage-log', join(traces, 'usage.ndjson'), ...(payload.max_output_tokens ? ['--max-output-tokens', String(payload.max_output_tokens)] : []), '--control-token', controlToken,
    ...extra, ...Object.entries(opts.upstream ?? {}).flatMap(([prov, url]) => ['--upstream', `${prov}=${url}`])], { stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, ...(payload.gemini_key_env ? { [KEY_ENV.gemini]: process.env[payload.gemini_key_env] ?? '' } : {}), SHOOTOUT_CELL_TOKEN: cellToken } });
  let code: number | null = null;
  let timedOut = false;
  let stoppedBy: string | null = null;
  let checkpointRows = 0;
  let realization: Realization | null = null;
  const restored = payload.restore?.realization_id ?? null;
  let stopCell: ((why: string) => void) | null = null;
  // A22: a SIGTERM (ubi-runner stopping the detached command before teardown) stops the cell the way the timeout
  // does, so the final checkpoint, snapshot wait and lease summary still run.
  const onTerm = () => { stoppedBy ??= 'SIGTERM'; stopCell?.('SIGTERM'); };
  process.on('SIGTERM', onTerm);
  try {
    const started = performance.now();
    let up = false;
    const ended = () => proxy.exitCode !== null || proxy.signalCode !== null;
    const control = createHash('sha256').update(controlToken).digest('hex');
    while (!up && !ended() && performance.now() - started < 120_000) {
      try {
        const s = (await (await fetch(`http://127.0.0.1:${port}/__proxy/status`, { signal: AbortSignal.timeout(1000) })).json()) as { run_id?: string; control_sha256?: string };
        up = s.run_id === payload.lease_id && s.control_sha256 === control;
      } catch { up = false; }
      if (!up) await Bun.sleep(50);
    }
    if (!up) throw new Error(ended() ? `the metering proxy exited (${proxy.signalCode ?? `code ${proxy.exitCode}`}) before it served lease ${payload.lease_id} on port ${port}` : `the metering proxy did not serve lease ${payload.lease_id} on port ${port} within 120 s`);
    const base = `http://127.0.0.1:${port}`;
    const env: Record<string, string | undefined> = { ...process.env, SHOOTOUT_OUT: out, SHOOTOUT_PROXY: base, SHOOTOUT_LEASE_ID: payload.lease_id, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken,
      OPENAI_BASE_URL: `${base}/cell/openai/v1`, ANTHROPIC_BASE_URL: `${base}/cell/anthropic`, VOYAGE_BASE_URL: `${base}/cell/voyage/v1`, PARTICLE_BASE_URL: `${base}/cell/particle/v1`, SHOOTOUT_CELL_TOKEN: cellToken, ...(custody ? { SHOOTOUT_CUSTODY: custody } : {}),
      ...(custody && payload.cell ? { GBRAIN_EVALS_CUSTODY_LOG: join(out, 'access-log.jsonl') } : {}) };
    if (payload.gemini_key_env) for (const k of [payload.gemini_key_env, KEY_ENV.gemini]) delete env[k];
    env.SHOOTOUT_LEASE_USD = String(payload.lease_usd);
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'PARTICLE_API_KEY']) if (env[k]) env[k] = 'dummy-key-the-proxy-replaces';
    if (payload.restore) {
      const dir = resolve(REPO_ROOT, expandHome(payload.restore.dir));
      // Without a restored store the old ingest-complete marker would trigger a snapshot of the empty store at once.
      if (existsSync(join(dir, 'checkpoint'))) for (const e of readdirSync(join(dir, 'checkpoint')).sort()) if (e !== 'checkpoint.json' && (restored || e !== 'ingest-complete')) cpSync(join(dir, 'checkpoint', e), join(out, e), { recursive: true });
    }
    if (payload.restore && restored) {
      const dir = resolve(REPO_ROOT, expandHome(payload.restore.dir));
      env.SHOOTOUT_RESTORE_DIR = join(dir, 'realization', 'snapshot');
      env.SHOOTOUT_RESTORED_REALIZATION = restored;
      if (payload.restore.restore_command) {
        const r = Bun.spawn(['bash', '-c', payload.restore.restore_command], { cwd: REPO_ROOT, env, stdout: 'inherit', stderr: 'inherit' });
        const rc = await r.exited;
        if (rc !== 0) throw new Error(`restore command exited ${rc}; the cell did not run (resume repeats the whole conversation instead)`);
      }
    }
    if (payload.snapshot_command) env.SHOOTOUT_SNAPSHOT_DIR = join(out, 'realization', 'snapshot');
    // Not a login shell: a login profile can re-export the real keys over the dummy ones.
    const cell = Bun.spawn(['bash', '-c', payload.command], { cwd: REPO_ROOT, env, stdout: 'inherit', stderr: 'inherit' });
    stopCell = () => { cell.kill('SIGTERM'); setTimeout(() => cell.kill('SIGKILL'), 30_000).unref?.(); };
    if (stoppedBy) stopCell(stoppedBy);
    const timer = payload.timeout_hours ? setTimeout(() => { timedOut = true; stopCell!('timeout'); }, payload.timeout_hours * 3_600_000) : null;
    const every = payload.row_pull_every ?? 0;
    const baseRows = every ? attemptRows(out) : 0;
    checkpointRows = baseRows;
    let snapshotting: Promise<Realization> | null = null;
    let exited = false;
    const watch = async () => {
      while (!exited) {
        await Promise.race([cell.exited, Bun.sleep(opts.pollMs ?? 2000)]);
        const rows = every ? attemptRows(out) : 0;
        if (every && rows >= checkpointRows + every) { writeCheckpoint(out, rows); checkpointRows = rows; }
        if (payload.snapshot_command && !snapshotting && !restored && (existsSync(join(out, 'ingest-complete')) || rows > baseRows)) {
          snapshotting = takeSnapshot(payload, out, env, existsSync(join(out, 'ingest-complete')) ? 'ingest-complete' : 'first-row');
        }
      }
    };
    const watcher = every || payload.snapshot_command ? watch() : null;
    code = await cell.exited;
    exited = true;
    if (timer) clearTimeout(timer);
    await watcher;
    if (payload.snapshot_command && !snapshotting && !restored && existsSync(join(out, 'ingest-complete'))) snapshotting = takeSnapshot(payload, out, env, 'ingest-complete');
    if (snapshotting) realization = await snapshotting;
    if (every) { checkpointRows = attemptRows(out); writeCheckpoint(out, checkpointRows); }
    if (timedOut) code = 124;
  } finally {
    process.off('SIGTERM', onTerm);
    proxy.kill('SIGTERM');
    await proxy.exited;
    if (custody && payload.cell) for (const d of ['datasets', 'restore', 'd8', 'rs1', 'bg1']) rmSync(join(dirname(custody), d), { recursive: true, force: true });
    const s = ledgerStatus({ ledgerPath: ledger, runId: payload.lease_id });
    writeFileSync(join(out, 'lease-summary.json'), JSON.stringify({ run_id: payload.lease_id, lease_usd: payload.lease_usd, committed_usd: s.run?.committed_usd ?? payload.lease_usd,
      requests: s.run ? BudgetRun.runRequests(ledger, payload.lease_id) : null, max_output_tokens: s.run ? BudgetRun.leaseMaxOutputTokens(ledger, payload.lease_id) ?? DEFAULT_MAX_OUTPUT_TOKENS : null, cell_exit_code: code,
      ...(payload.timeout_hours !== undefined ? { timeout_hours: payload.timeout_hours, timed_out: timedOut } : {}), ...(stoppedBy ? { stopped_by: stoppedBy } : {}),
      ...(payload.row_pull_every ? { checkpoint_rows: checkpointRows } : {}), ...(realization ? { realization_id: realization.realization_id, realization_status: realization.status } : {}),
      ...(payload.restore ? { restored_from: restored, ...(restored ? {} : { resumed_from_checkpoint: true }) } : {}), ...(opts.upstream ? { keyless_upstream: true } : {}) }, null, 2) + '\n');
  }
  return code ?? 1;
}

/** A local cell's proxy port, derived from its lease id so concurrent local cells do not collide (9000 to 9899). */
export const localPort = (leaseId: string) => 9000 + parseInt(createHash('sha256').update(leaseId).digest('hex').slice(0, 6), 16) % 900;

/**
 * The launcher's executor: runs ubi-runner, stops it BACKSTOP_HOURS after the
 * cell's timeout (its exit handler stops the command and pulls before it
 * destroys the VM), and pulls the VM's checkpoint and realization every pull
 * interval so a lost VM costs at most one interval.
 */
export const BACKSTOP_HOURS = 4;
export function ubiRunner(campaign?: Campaign): Runner {
  return async (argv, ctx) => {
    const p = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit', env: process.env });
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    // The VM enforces the cell's timeout itself (from the cell's start); this backstop allows for VM setup and the
    // snapshot, and its SIGTERM makes ubi-runner stop the command and pull its output before the VM is destroyed (A22).
    if (ctx.timeoutMs) timers.push(setTimeout(() => { process.stderr.write(`[shootout-cell] ${ctx.lease.lease_id} passed its timeout plus ${BACKSTOP_HOURS} h; ubi-runner stops the command, pulls its output, then destroys the VM\n`); p.kill('SIGTERM'); }, ctx.timeoutMs + BACKSTOP_HOURS * 3_600_000));
    let pulling = false;
    if (ctx.vm && ctx.pullEveryMs) {
      timers.push(setInterval(async () => {
        if (pulling) return;
        pulling = true;
        try {
          for (const part of ['checkpoint', 'realization']) {
            const pull = Bun.spawn(['bash', ctx.runner, 'pull', ctx.vm!, `${ctx.remoteOut}/${part}`, ctx.resultsDir], { stdout: 'ignore', stderr: 'ignore', env: process.env });
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
      const keyless = process.env.SHOOTOUT_KEYLESS_UPSTREAM;
      const upstream = keyless ? keylessUpstream(keyless) : undefined;
      process.exit(await runRemote(JSON.parse(Buffer.from(one('--cell-b64') ?? '', 'base64').toString('utf8')), { port: one('--port') ? Number(one('--port')) : undefined, upstream }));
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
      // A22: exit 4 is a cell (or a shard, on its own share) that ran and left gaps, not a failed run.
      if (!l.timed_out && l.status === 'settled' && l.cell_exit_code === 4) throw refuse({ code: 'CELL_PARTIAL', partial: true,
        message: `cell ${l.cell} lease ${l.lease_id} settled with gaps in its share (exit 4); its rows, answers and judgments are kept`,
        why: 'a shard is complete when every question of its own conversations has its rows, answers and canonical judgments; resume answers only what is missing',
        fix: { next: 'run', argv: ['bun', 'eval/runner/shootout-cell.ts', 'resume', '--campaign', manifest, '--state', state, '--cell', l.cell], verify: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', manifest, '--state', state] },
        state: { lease: l.lease_id, status: l.status, exit_code: l.exit_code ?? null, cell_exit_code: 4 } });
      throw refuse({ code: l.timed_out ? 'CELL_TIMEOUT' : 'CELL_FAILED', message: `cell ${l.cell} lease ${l.lease_id} ${l.timed_out ? 'hit its timeout' : `ended ${l.status} with exit ${l.cell_exit_code ?? l.exit_code ?? 'unknown'}`}`,
        why: 'a cell that did not finish cleanly is not a counted result; its rows stay pulled for diagnosis and resume',
        fix: { next: 'run', argv: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', manifest, '--state', state], verify: ['bun', 'run', 'eval:scoreboard', 'status', '--campaign', manifest, '--state', state] },
        state: { lease: l.lease_id, status: l.status, exit_code: l.exit_code ?? null, cell_exit_code: l.cell_exit_code ?? null } });
    };
    if (['init', 'reserve', 'launch', 'resume'].includes(cmd)) (await import('./bg1/launch.ts')).requireBg1Launch(c.manifest, manifest);
    if (cmd === 'init') print(c.init());
    else if (cmd === 'reserve') print(c.reserve(one('--cell') ?? ''));
    else if (cmd === 'launch' && argv.includes('--dry-run')) {
      const l = c.leases().find(x => x.cell === one('--cell') && x.status === 'reserved');
      if (!l) throw new Error(`cell ${one('--cell')} has no reserved lease`);
      print({ lease: l.lease_id, argv: c.launchArgv(l, { vm: c.q1 ? c.vmName(l) : null }) });
    } else if (cmd === 'launch') finishLaunch(await c.launch(one('--cell') ?? '', ubiRunner(c)));
    else if (cmd === 'resume') {
      const fromManifest = one('--from-campaign'), fromState = one('--from-state');
      if (!!fromManifest !== !!fromState) throw new Error('resume: --from-campaign and --from-state go together (the earlier campaign whose leases hold the cell\'s run)');
      const r = await c.resume(one('--cell') ?? '', ubiRunner(c), fromManifest ? { from: new Campaign(fromManifest, resolve(fromState!)) } : {});
      print(r); finishLaunch(r.lease);
    }
    else if (cmd === 'settle') print(c.settle(one('--lease') ?? ''));
    else if (cmd === 'abandon') print(c.abandon(one('--lease') ?? '', one('--reason') ?? '', argv.includes('--unstarted') ? { log: one('--log') ?? '' } : undefined));
    else if (cmd === 'status') print(c.status());
    else if (cmd === 'raise-cap') print(c.raiseCap(one('--reason') ?? ''));
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

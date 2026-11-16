/**
 * BG1's dev loop (GST-2854): scores a gbrain build on BG1's three public dev worlds, class by class, against the
 * memory-bank and extract-first servers' stage 1 rows at the same reader and judge settings, so a change to how gbrain
 * keeps dated facts can be checked in about an hour. The dev worlds are public and gbrain may be tuned on them, so
 * nothing here is a counted or held-out result; the preregistration
 * (docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md) keeps its sealed worlds for that.
 *
 *   bun eval/runner/bg1/dev-loop.ts run [--gbrain <tag|branch|sha>] --paid-window <unit> --window-cap-usd <n> [--out <dir>]
 *       [--worlds bg1-dev-01,...] [--vm-size standard-4] [--location eu-central-h1]
 *     Resolves the ref to a gbrain commit (without --gbrain, gbrain's newest release tag, so the baseline is always the
 *     newest build) and runs BG1's gbrain cell at it (configuration rs1-stable, arm P: query with
 *     the facts block, packed to 8,000 tokens) on one Ubicloud VM per dev world, each under its own metering proxy
 *     whose lease is the window cap over the worlds, then pulls the outputs into --out and prints `score`. Each VM starts
 *     only after `ubi-runner.sh usage` shows room for it under the shared project's 464-vCPU line for evals and this
 *     crew's 208 (owners sharing UBI_OWNER's letters, gbev for gbev91); otherwise it reads usage again every 5 minutes. The reader is
 *     claude-opus-5-5 at effort medium with 2,048 output tokens, and the gating judge is gpt-6-astra at the pinned judge
 *     settings (the family rule). Every answer also gets the canonical gemini-3.8-flash grade, as stage 1 ran it
 *     (descriptive). Needs ANTHROPIC_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY, GEMINI_API_KEY, UBICLOUD_API_KEY and UBI_OWNER.
 *   bun eval/runner/bg1/dev-loop.ts score --run <dir> [--against <earlier run dir or saved row>] [--save <row.json>] [--json]
 *     Per class S1 to S8, pooled (what is true now: S1 to S5; time-indexed: S6 to S8) and overall: gbrain's accuracy,
 *     its exposure rate (the context held every value the answer needs) and its gap to each comparator with a paired
 *     95% interval over questions, plus the smallest gap change each class can show. --against adds this run minus an
 *     earlier gbrain run; --save writes this run's per-question scores and exposure (no answers or contexts), which a
 *     later --against reads in place of the run directory. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts why --run <dir> --out <file.jsonl> [--stage1 <dir>] [--classes s1_updated,...]
 *     One row per question gbrain missed in S1 and S5 to S8: the question, the gold, gbrain's answer and context, which
 *     needed values the context held and, with --stage1 (the copied stage 1 results), each comparator's context and
 *     answer beside it. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts baselines --stage1 <dir> [--out <file>]
 *     Rewrites the comparator cache (BASELINES_PATH) from stage 1's results, after checking that every row read at
 *     the same settings. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts clock
 *     Prints the libfaketime offset that moves a clock read now back to the question day (the VM command uses it).
 *   bun eval/runner/bg1/dev-loop.ts cell --sha <sha> --world <id> --out <dir> --system-url <url>
 *     On the VM, under shootout-cell.ts remote: checks the container clock, then runs the cell for one world.
 *
 * The clock. The dev worlds end on 2026-11-08 (the preregistration's Amendment 2), and every question is asked on
 * 2026-11-09. A counted cell refuses to run more than 14 days after its world end (corpus.ts bg1RunClock), because
 * systems read the wall clock: gbrain keeps a fact current while valid_until > now(), and six dev slots carry a change
 * scheduled 47 to 119 days after the world end. The dev loop keeps the 2026-11-08 world end, so every dev world,
 * question and comparator row stays byte for byte what stage 1 ran, and moves gbrain's wall clock back instead: the
 * container runs under libfaketime with the offset that puts it at 2026-11-09T00:00:00Z when the cell starts
 * (GBRAIN_FAKETIME in eval/systems/gbrain-defaults), and `cell` reads the clock inside the container and refuses before
 * any paid call unless it sits on the question day. Only bg1-dev cells take a pinned clock; a sealed cell keeps the
 * runner's check.
 *
 * Settings. The comparator rows come from stage 1 (campaigns q1-scoreboard-bg1-stage1b and -stage1c, run on
 * 2026-11-09 and 2026-11-10 at commits 4306e9e3 and 5958985d). `baselines` records the run-config settings that reach
 * the reader and the gating judge, and `score` refuses a gbrain run whose settings differ from them.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_ROUTE_CAPS } from '../metering-proxy.ts';
import { requireRs1Window, WindowRefusal } from '../paid-arm.ts';
import { runCell, type CellDeps, type CellResult } from '../q1/cell.ts';
import { bg1Estimate, loadBG1Manifest, OPUS } from '../q1/cells/bg1.ts';
import { bg1JudgeOf, launchPrefix, pinnedJudgeRouteCaps, type CellDefinition } from '../q1/cells/definitions.ts';
import { DEFAULT_ROUTE_CLASSES, EXECUTES, Q1_VM_PATHS, resolveRunner, type RemotePayload } from '../shootout-cell.ts';
import { clusteredPairedDelta, powerNote } from '../stats/paired.ts';
import { evidenceOf, exposure } from './exposure.ts';
import { findValues } from './match.ts';
import { BG1_PRIMARY, BG1_SECONDARY, BG1_STRATA, type Bg1Stratum } from './types.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const DEV_WORLDS = ['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03'] as const;
/** The dev worlds' world end (Amendment 2) and their question day, the day after it. */
export const DEV_WORLD_END = '2026-11-08';
export const DEV_AS_OF = '2026-11-09T00:00:00Z';
/** How far past the question day the container clock may read when `cell` checks it: the stack starts first. */
export const CLOCK_SLACK_MS = 6 * 3_600_000;
/** Stage 1's gbrain cell, which the loop runs at another gbrain commit with one reader. */
export const STAGE1_GBRAIN_CELL = 'bg1-dev3.gbrain-defaults.rs1-stable';
export const DEV_READER = OPUS;
export const DEV_JUDGE = bg1JudgeOf(OPUS);
export const GATING_INSTRUMENT = `bg1-dev@${DEV_JUDGE}`;
export const COMPARATORS = ['ext-memory-bank', 'ext-extract-first'] as const;
export const BASELINES_PATH = join(REPO_ROOT, 'eval/data/changing-facts-v1/dev/baselines/stage1-opus.json');
export const BASELINES_SCHEMA = 'gbrain-evals/bg1-dev-baselines/v1';
export const RUN_SCHEMA = 'gbrain-evals/bg1-dev-loop-run/v1';
export const WHY_CLASSES: readonly Bg1Stratum[] = ['s1_updated', 's5_withdrawn', 's6_as_of', 's7_as_known', 's8_history'];
/** The provider keys a dev-loop VM receives; only its metering proxy reads them. */
export const VM_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY'] as const;
const GBRAIN_REPO = 'https://github.com/garrytan/gbrain';
const COMPOSE = 'eval/systems/gbrain-defaults/docker-compose.yml';
const BOOT_DRAWS = 10_000;
const SEED = 20261116;

export class DevLoopRefusal extends Error {}

// ─── The cell ────────────────────────────────────────────────────────

/**
 * Stage 1's gbrain cell at another gbrain commit, read by claude-opus-5-5 alone and judged by gpt-6-astra alone. Its
 * store snapshot and restore commands are dropped: a dev run never resumes, it runs again.
 */
export function devCell(sha: string): CellDefinition {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new DevLoopRefusal(`a dev cell needs a full 40-character gbrain commit, not ${JSON.stringify(sha)}`);
  const src = loadBG1Manifest().smoke_cells.find(c => c.id === STAGE1_GBRAIN_CELL);
  if (!src?.launch) throw new DevLoopRefusal(`${STAGE1_GBRAIN_CELL} is missing from eval/runner/q1/cells/bg1-cells.json`);
  const { estimate: _e, snapshot_command: _s, restore_command: _r, lease: _l, ...rest } = src;
  const def: Omit<CellDefinition, 'estimate'> = {
    ...rest, launch: { ...src.launch, env: { ...src.launch.env, GBRAIN_SHA: sha } },
    arms: src.arms.map(a => ({ ...a, readers: [DEV_READER], frontier: a.frontier ? { ...a.frontier, judges: [DEV_JUDGE] } : null })),
  };
  return { ...def, estimate: bg1Estimate(def) };
}

/** The world end a dev cell loads with and its pinned question day; a sealed cell never takes a pinned clock. */
export function devClock(def: Pick<CellDefinition, 'id' | 'benchmark' | 'split'>): { worldEnd: string; asOf: string } {
  if (def.benchmark !== 'bg1-dev' || def.split !== 'dev') throw new DevLoopRefusal(`${def.id} is not a bg1-dev cell, so it keeps the runner's wall-clock check (corpus.ts bg1RunClock) and takes no pinned clock`);
  return { worldEnd: DEV_WORLD_END, asOf: DEV_AS_OF };
}

/** The libfaketime offset, in whole seconds, that shows a clock read at `now` as the question day. */
export const faketimeOffset = (now: number = Date.now(), asOf: string = DEV_AS_OF) => `${Math.round((Date.parse(asOf) - now) / 1000)}`;

/** Why a clock read inside the container is not on the pinned question day, or null when it is. */
export function clockProblem(containerMs: number, asOf: string = DEV_AS_OF): string | null {
  const at = Date.parse(asOf);
  if (!Number.isFinite(containerMs)) return 'the container clock could not be read';
  if (containerMs < at - 60_000 || containerMs > at + CLOCK_SLACK_MS) return `the container clock reads ${new Date(containerMs).toISOString()}, not the pinned ${asOf} (within ${CLOCK_SLACK_MS / 3_600_000} hours)`;
  return null;
}

/** The container's clock as Bun, gbrain's own runtime, reads it inside the gbrain shim. */
function containerClockMs(): number {
  const out = execFileSync('bash', ['-c', 'if docker info >/dev/null 2>&1; then exec docker "$@"; else exec sudo docker "$@"; fi', 'dock', 'compose', '-f', COMPOSE, 'exec', '-T', 'shim', 'bun', '-e', 'console.log(Date.now())'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return Number(out.trim().split('\n').pop());
}

export interface DevCellOptions { sha: string; world: string; out: string; systemUrl: string | null; env?: Record<string, string | undefined> }

/**
 * One dev world through the cell under a lease proxy (SHOOTOUT_PROXY, which runRemote starts), with the world end
 * pinned and the container clock checked first; deps.clockMs stands in for the container in keyless tests. It never
 * calls the runner's wall-clock check.
 */
export async function runDevCell(o: DevCellOptions, deps: CellDeps & { clockMs?: () => number } = {}): Promise<CellResult> {
  const env = o.env ?? process.env;
  const def = devCell(o.sha);
  const { worldEnd, asOf } = devClock(def);
  const index = (DEV_WORLDS as readonly string[]).indexOf(o.world);
  if (index < 0) throw new DevLoopRefusal(`--world must be one of ${DEV_WORLDS.join(', ')}, not ${o.world}`);
  const proxy = env.SHOOTOUT_PROXY ?? null;
  if (!proxy && !(deps.reader && deps.judge)) throw new DevLoopRefusal('cell runs only under a lease proxy (shootout-cell.ts remote sets SHOOTOUT_PROXY), so every call is metered and capped');
  const problem = clockProblem((deps.clockMs ?? containerClockMs)(), asOf);
  if (problem) throw new DevLoopRefusal(`refusing before any paid call: ${problem}. Build the image with GBRAIN_FAKETIME_LIB=1 and start the stack with GBRAIN_FAKETIME from ${'`'}bun eval/runner/bg1/dev-loop.ts clock${'`'}`);
  env.GBRAIN_EVALS_BG1_WORLD_END = worldEnd;
  process.env.GBRAIN_EVALS_BG1_WORLD_END = worldEnd;
  return runCell(def, { out: o.out, shard: { index, count: DEV_WORLDS.length }, systemUrl: o.systemUrl, providerProxy: proxy, env }, deps);
}

// ─── Launch ──────────────────────────────────────────────────────────

/** gbrain's newest release tag (vN.N.N.N, highest by number) and its commit. */
export function newestRelease(lsTags: () => string = () => execFileSync('git', ['ls-remote', '--tags', GBRAIN_REPO], { encoding: 'utf8' })): { tag: string; sha: string } {
  const refs = new Map(lsTags().split('\n').filter(Boolean).map(l => { const [sha, ref] = l.split('\t'); return [ref, sha] as const; }));
  const num = (t: string) => t.slice(1).split('.').map(Number);
  const newer = (a: string, b: string) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
  const tag = [...refs.keys()].flatMap(r => /^refs\/tags\/(v\d+(?:\.\d+)+)$/.exec(r)?.[1] ?? []).reduce<string | null>((best, t) => (best === null || newer(t, best) ? t : best), null);
  if (!tag) throw new DevLoopRefusal('gbrain has no release tag (vN.N.N.N); pass --gbrain <tag|branch|sha>');
  return { tag, sha: refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`)! };
}

/** A gbrain ref as a commit: a full sha as given, else the tag or branch `git ls-remote` resolves. */
export function resolveGbrainRef(ref: string, lsRemote: (ref: string) => string = r => execFileSync('git', ['ls-remote', GBRAIN_REPO, r], { encoding: 'utf8' })): string {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const lines = lsRemote(ref).split('\n').filter(Boolean).map(l => l.split('\t'));
  for (const name of [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`]) { const hit = lines.find(l => l[1] === name); if (hit) return hit[0]; }
  throw new DevLoopRefusal(`gbrain has no tag or branch ${ref} (pass a full commit sha instead)`);
}

/** What one world's VM runs: the stack on the pinned clock, the cell, then the stack down. */
export function vmCommand(sha: string, world: string): string {
  const def = devCell(sha);
  const pre = launchPrefix({ ...def.launch!, env: { ...def.launch!.env, GBRAIN_FAKETIME_LIB: '1' } });
  return [`export GBRAIN_EVALS_BG1_WORLD_END=${DEV_WORLD_END}`, 'export GBRAIN_FAKETIME="$(bun eval/runner/bg1/dev-loop.ts clock)"',
    `${pre}bash eval/systems/bootstrap.sh up --system gbrain-defaults --config ${def.launch!.config} && bun eval/runner/bg1/dev-loop.ts cell --sha ${sha} --world ${world} --system-url http://127.0.0.1:8700 --out "$SHOOTOUT_OUT"; rc=$?; bash eval/systems/bootstrap.sh down --system gbrain-defaults; exit $rc`].join('; ');
}

/** The payload shootout-cell.ts remote runs on one world's VM: its own lease proxy, with Gemini on GEMINI_API_KEY. */
export function vmPayload(sha: string, world: string, leaseId: string, leaseUsd: number): RemotePayload {
  const def = devCell(sha);
  return { lease_id: leaseId, lease_usd: leaseUsd, max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS, command: vmCommand(sha, world), out: `eval/reports/bg1-dev-loop/${leaseId}`, cell: def.id, timeout_hours: 4,
    route_caps: { caps: { ...DEFAULT_ROUTE_CAPS, ...pinnedJudgeRouteCaps(def.arms) }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' }, gemini_key_env: 'GEMINI_API_KEY' };
}

/** The shared Ubicloud project's line for eval VMs (512 vCPUs less 48 kept for merge checks), and one crew's share of it. */
export const UBI_PROJECT_LINE = 464;
export const UBI_CREW_LINE = 208;

/**
 * How many more VMs of `vcpus` each fit under both lines, from `ubi-runner.sh usage` (OWNER VMS VCPUS rows and a
 * total row); the launching crew's VMs are the owners starting with `crewPrefix`, the letters of UBI_OWNER (`gbev` for
 * gbev91). Unreadable usage fits none.
 */
export function ubiRoom(usage: string, vcpus: number, crewPrefix = 'gbev'): number {
  const rows = usage.split('\n').map(l => l.trim().split(/\s+/)).filter(r => r.length === 3 && /^\d+$/.test(r[1]) && /^\d+$/.test(r[2]));
  const total = rows.find(r => r[0] === 'total');
  if (!total || !(vcpus > 0)) return 0;
  const crew = rows.filter(r => r[0].startsWith(crewPrefix)).reduce((n, r) => n + Number(r[2]), 0);
  return Math.max(0, Math.min(Math.floor((UBI_PROJECT_LINE - Number(total[2])) / vcpus), Math.floor((UBI_CREW_LINE - crew) / vcpus)));
}

/** What a dev-loop VM receives: the Q1 runner's paths, BG1's analysis code and the dev worlds. */
export const SHIP_PATHS = [...new Set([...EXECUTES, ...Q1_VM_PATHS, 'eval/runner/bg1'])];

async function launch(argv: string[]): Promise<number> {
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const worlds = (one('--worlds') ?? DEV_WORLDS.join(',')).split(',');
  const unknown = worlds.filter(w => !(DEV_WORLDS as readonly string[]).includes(w));
  if (unknown.length) throw new DevLoopRefusal(`--worlds takes ${DEV_WORLDS.join(', ')}, not ${unknown.join(', ')}`);
  const window = requireRs1Window(argv, { what: 'the BG1 dev loop', keyless: false, caps: () => [] })!;
  const missing = [...VM_KEYS, 'UBI_OWNER'].filter(k => !process.env[k]);
  if (missing.length) throw new DevLoopRefusal(`run needs ${missing.join(', ')} in the environment`);
  const named = one('--gbrain');
  const newest = named ? null : newestRelease();
  const ref = named ?? newest!.tag;
  const sha = named ? resolveGbrainRef(named) : newest!.sha;
  console.error(`dev loop: gbrain ${ref} at ${sha}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const out = resolve(one('--out') ?? join(REPO_ROOT, 'eval/reports/bg1-dev-loop', `${sha.slice(0, 12)}-${stamp}`));
  const leaseUsd = Math.floor(window.cap_usd / worlds.length * 100) / 100;
  const def = devCell(sha);
  mkdirSync(join(out, 'setup'), { recursive: true });
  const shipFile = join(out, 'setup', 'ship.txt');
  writeFileSync(shipFile, SHIP_PATHS.join('\n') + '\n');
  const setup = join(out, 'setup', 'setup.sh');
  writeFileSync(setup, `set -euo pipefail\n${launchPrefix({ ...def.launch!, env: { GBRAIN_BUN_IMAGE: def.launch!.env.GBRAIN_BUN_IMAGE, GBRAIN_SHA: sha, GBRAIN_FAKETIME_LIB: '1' } })}bash eval/systems/bootstrap.sh setup --system gbrain-defaults --datasets bg1-dev --conversations ${worlds.join(',')}\n`);
  writeFileSync(join(out, 'run.json'), JSON.stringify({ schema: RUN_SCHEMA, gbrain_ref: ref, gbrain_sha: sha, worlds, paid_window: window.unit, window_cap_usd: window.cap_usd, lease_usd_per_world: leaseUsd,
    reader: DEV_READER, judge: DEV_JUDGE, world_end: DEV_WORLD_END, as_of: DEV_AS_OF, started_at: new Date().toISOString() }, null, 2) + '\n');
  const runner = resolveRunner();
  const size = one('--vm-size') ?? 'standard-4';
  const vcpus = Number(/^standard-(\d+)$/.exec(size)?.[1]);
  if (!vcpus) throw new DevLoopRefusal(`--vm-size takes standard-<vcpus>, not ${size}`);
  const running: Array<Promise<number>> = [];
  for (const [i, world] of worlds.entries()) {
    if (i) await Bun.sleep(90_000);
    for (;;) {
      let usage = '';
      try { usage = execFileSync('bash', [runner, 'usage'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { usage = ''; }
      if (ubiRoom(usage, vcpus, /^[a-z]+/i.exec(process.env.UBI_OWNER!)?.[0] ?? 'gbev') >= 1) break;
      console.error(`dev loop: no room for a ${vcpus}-vCPU VM under the project's ${UBI_PROJECT_LINE} or this crew's ${UBI_CREW_LINE} (or usage unreadable); reading again in 5 minutes`);
      await Bun.sleep(300_000);
    }
    const leaseId = `devloop-${sha.slice(0, 12)}-${world}-${stamp}`;
    const payload = Buffer.from(JSON.stringify(vmPayload(sha, world, leaseId, leaseUsd))).toString('base64');
    const args = [runner, 'run', '-s', size, '-l', one('--location') ?? 'eu-central-h1', '--src', REPO_ROOT, '--only', shipFile, '--setup', setup,
      ...VM_KEYS.flatMap(k => ['--pass', k]), '--pull', `work/${basename(REPO_ROOT)}/eval/reports/bg1-dev-loop/${leaseId}:${join(out, 'worlds')}`, '--', `bun eval/runner/shootout-cell.ts remote --cell-b64 ${payload}`];
    const log = openSync(join(out, `${world}.log`), 'a');
    const p = Bun.spawn(['bash', ...args], { cwd: REPO_ROOT, env: { ...process.env, UBI_TTL_HOURS: '7' }, stdin: 'ignore', stdout: log, stderr: log });
    running.push(p.exited.finally(() => closeSync(log)));
  }
  const codes = await Promise.all(running);
  console.error(`dev loop VMs exited ${codes.join(', ')}; outputs in ${join(out, 'worlds')}`);
  if (codes.some(c => c !== 0)) return 4;
  console.log(renderScore(scoreRun(out)));
  return 0;
}

// ─── Reading a row ───────────────────────────────────────────────────

export interface QuestionRecord {
  id: string; world: string; stratum: Bg1Stratum;
  /** The gating judge's grade of claude-opus-5-5's answer, or null when the question has no gating grade (a harness failure). */
  score: number | null;
  /** The delivered context held every value the answer needs (exposure.ts), and whether it held any stale value. */
  gold: boolean | null; stale: boolean | null;
  answer: string | null; context: string | null;
}

interface RunConfigLike { reader?: { effort?: string; max_tokens?: number; prompt_sha256?: string | null }; renderer?: string; instrument?: { sha256?: string }; arm?: { mode?: string; budget?: number | null; frontier?: { judge_by_reader?: Record<string, string>; settings?: unknown } | null }; cell?: { system?: string; launch?: { env?: Record<string, string> } } }

/** The run-config settings that reach claude-opus-5-5 and its gating judge; two rows compare only when these match. */
export function readingSettings(rc: RunConfigLike): Record<string, unknown> {
  return { reader: DEV_READER, effort: rc.reader?.effort, max_tokens: rc.reader?.max_tokens, prompt_sha256: rc.reader?.prompt_sha256, renderer: rc.renderer, instrument_sha256: rc.instrument?.sha256,
    mode: rc.arm?.mode, budget: rc.arm?.budget, judge: rc.arm?.frontier?.judge_by_reader?.[DEV_READER] ?? null, judge_settings: rc.arm?.frontier?.settings ?? null };
}

const ndjson = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T) : [];
const dirsUnder = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(d => !d.startsWith('.') && statSync(join(dir, d)).isDirectory()).map(d => join(dir, d)) : [];

/** Every directory under `root` (itself included, four levels down) that holds published cells (cells/<cell id>/run-config.json). */
export function cellRoots(root: string, depth = 4): string[] {
  if (existsSync(join(root, 'cells'))) return [root];
  return depth ? dirsUnder(root).flatMap(d => cellRoots(d, depth - 1)) : [];
}

let questionCache: Map<string, MemoryQuestion> | null = null;
/** The dev questions, dates resolved at the dev world end. */
export function devQuestions(): Map<string, MemoryQuestion> {
  if (questionCache) return questionCache;
  const prior = process.env.GBRAIN_EVALS_BG1_WORLD_END;
  process.env.GBRAIN_EVALS_BG1_WORLD_END = DEV_WORLD_END;
  try { questionCache = new Map(loadCorpus('bg1-dev', undefined, undefined, { keyless: true }).questions.map(q => [q.id, q])); }
  finally { if (prior === undefined) delete process.env.GBRAIN_EVALS_BG1_WORLD_END; else process.env.GBRAIN_EVALS_BG1_WORLD_END = prior; }
  return questionCache;
}

/**
 * One row's per-question records from its result roots (a stage 1 unit, or a dev run's world outputs): claude-opus-5-5's
 * replicate-0 answer, its gating grade and the exposure of the context it read, with the settings it read at.
 */
export function readRow(roots: string[], system: string): { settings: Record<string, unknown>; gbrainSha: string | null; records: Map<string, QuestionRecord> } {
  const qs = devQuestions();
  const records = new Map<string, QuestionRecord>();
  let settings: Record<string, unknown> | null = null, gbrainSha: string | null = null;
  for (const root of roots.flatMap(r => cellRoots(r))) {
    for (const cell of dirsUnder(join(root, 'cells'))) {
      const rc = JSON.parse(readFileSync(join(cell, 'run-config.json'), 'utf8')) as RunConfigLike;
      if (rc.cell?.system !== system) continue;
      const s = readingSettings(rc);
      if (settings && JSON.stringify(settings) !== JSON.stringify(s)) throw new DevLoopRefusal(`${cell} reads at other settings than the rest of its row`);
      settings = s;
      gbrainSha = rc.cell?.launch?.env?.GBRAIN_SHA ?? gbrainSha;
      const contexts = new Map<string, string>();
      for (const run of dirsUnder(join(root, 'runs'))) for (const c of ndjson<{ key: string; prompt: string }>(join(run, 'contexts.ndjson'))) contexts.set(c.key.split('|')[1], c.prompt);
      const grades = new Map(ndjson<{ answer_id: string; instrument_id: string; score: number | null }>(join(cell, 'judgments.ndjson')).filter(j => j.instrument_id === GATING_INSTRUMENT).map(j => [j.answer_id, j]));
      for (const a of ndjson<{ answer_id: string; question_id: string; reader: string; replicate: number; text?: string | null }>(join(cell, 'answers.ndjson'))) {
        if (a.reader !== DEV_READER || a.replicate !== 0) continue;
        const q = qs.get(a.question_id);
        if (!q) throw new DevLoopRefusal(`${cell} answers ${a.question_id}, which is not a dev question`);
        const g = grades.get(a.answer_id);
        const prompt = contexts.get(a.question_id);
        const context = prompt === undefined ? null : evidenceOf(prompt);
        const ev = context === null ? null : exposure(q, context, { rawText: false });
        records.set(q.id, { id: q.id, world: q.conversation, stratum: q.bg1!.stratum, score: typeof g?.score === 'number' ? g.score : null, gold: ev?.gold ?? null, stale: ev?.stale ?? null, answer: a.text ?? null, context });
      }
    }
  }
  if (!settings) throw new DevLoopRefusal(`no ${system} cell under ${roots.join(', ')}`);
  for (const q of qs.values()) if (!records.has(q.id)) records.set(q.id, { id: q.id, world: q.conversation, stratum: q.bg1!.stratum, score: null, gold: null, stale: null, answer: null, context: null });
  return { settings, gbrainSha, records };
}

// ─── Comparator cache ────────────────────────────────────────────────

export interface BaselineRow { source: string; settings: Record<string, unknown>; gbrain_sha?: string; questions: Record<string, { score: number | null; gold: boolean | null; stale: boolean | null }> }
export interface Baselines { schema: string; note: string; world_end: string; reader: string; judge: string; rows: Record<string, BaselineRow> }

/** The stage 1 unit directories `baselines` reads, by row: the two comparators. */
export const STAGE1_UNITS: Record<string, { system: string; dir: string }> = {
  'ext-memory-bank': { system: 'ext-memory-bank', dir: 'stage1b/results/bg1-dev3.ext-memory-bank.recipe/bg1-dev3.ext-memory-bank.recipe-a1-961b852d' },
  'ext-extract-first': { system: 'ext-extract-first', dir: 'stage1c/results/bg1-dev3.ext-extract-first.common/bg1-dev3.ext-extract-first.common-a1-7a7c53d3' },
};

export function buildBaselines(stage1: string): Baselines {
  const rows: Record<string, BaselineRow> = {};
  for (const [name, u] of Object.entries(STAGE1_UNITS)) {
    const r = readRow([join(stage1, u.dir)], u.system);
    rows[name] = { source: `BG1 stage 1, ${basename(u.dir)}`, settings: r.settings, ...(r.gbrainSha ? { gbrain_sha: r.gbrainSha } : {}),
      questions: Object.fromEntries([...r.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(q => [q.id, { score: q.score, gold: q.gold, stale: q.stale }])) };
  }
  const first = JSON.stringify(rows['ext-memory-bank'].settings);
  const off = Object.entries(rows).filter(([, r]) => JSON.stringify(r.settings) !== first).map(([n]) => n);
  if (off.length) throw new DevLoopRefusal(`stage 1 rows ${off.join(', ')} read at other settings than ext-memory-bank`);
  return { schema: BASELINES_SCHEMA, note: 'claude-opus-5-5 answers on the three BG1 dev worlds, graded by gpt-6-astra at the pinned judge settings, with exposure from each frozen context (eval/runner/bg1/exposure.ts). Written by bun eval/runner/bg1/dev-loop.ts baselines.',
    world_end: DEV_WORLD_END, reader: DEV_READER, judge: DEV_JUDGE, rows };
}

export const loadBaselines = (path = BASELINES_PATH): Baselines => {
  const b = JSON.parse(readFileSync(path, 'utf8')) as Baselines;
  if (b.schema !== BASELINES_SCHEMA) throw new DevLoopRefusal(`${path} is not a ${BASELINES_SCHEMA} file`);
  return b;
};

// ─── Scoring ─────────────────────────────────────────────────────────

/** A paired difference in points over the questions both rows graded, its percentile interval and the smallest change it can show. */
export interface Gap { delta: number; ci95: [number, number] | null; n: number; mde: number | null }
export interface ClassScore { label: string; n: number; graded: number; accuracy: number | null; exposure: number | null; comparators: Record<string, { accuracy: number | null; exposure: number | null; gap: Gap | null }>; against?: Gap | null }
export interface Score { run: string; gbrain_ref?: string | null; gbrain_sha: string | null; questions: number; ungraded: number; classes: ClassScore[] }

export const GROUPS: Array<{ label: string; strata: readonly Bg1Stratum[] }> = [
  ...BG1_STRATA.map(s => ({ label: s, strata: [s] })),
  { label: 'current (S1-S5)', strata: BG1_PRIMARY }, { label: 'time-indexed (S6-S8)', strata: BG1_SECONDARY }, { label: 'all', strata: BG1_STRATA },
];

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** `mine` minus `other` in points over the questions both graded, with a paired bootstrap interval over questions. */
export function gap(mine: ReadonlyMap<string, { score: number | null }>, other: ReadonlyMap<string, { score: number | null }>, ids: readonly string[]): Gap | null {
  const pairs = ids.flatMap(id => { const a = other.get(id)?.score, b = mine.get(id)?.score; return typeof a === 'number' && typeof b === 'number' ? [{ id, cluster: id, a, b }] : []; });
  if (!pairs.length) return null;
  const d = clusteredPairedDelta(pairs, { seed: SEED, draws: BOOT_DRAWS });
  const mde = powerNote(d).mde;
  return { delta: d.delta * 100, ci95: d.ci95 ? [d.ci95[0] * 100, d.ci95[1] * 100] : null, n: pairs.length, mde: mde === null ? null : mde * 100 };
}

export function scoreRecords(run: string, gbrainSha: string | null, mine: ReadonlyMap<string, QuestionRecord>, baselines: Baselines, against?: ReadonlyMap<string, QuestionRecord>): Score {
  const comps = Object.fromEntries(COMPARATORS.map(c => [c, new Map(Object.entries(baselines.rows[c].questions))]));
  const all = [...mine.values()];
  const exposureOf = (m: ReadonlyMap<string, { gold: boolean | null }>, ids: string[]) => mean(ids.map(id => m.get(id)?.gold).filter((x): x is boolean => typeof x === 'boolean').map(Number));
  return {
    run, gbrain_sha: gbrainSha, questions: all.length, ungraded: all.filter(q => q.score === null).length,
    classes: GROUPS.map(g => {
      const ids = all.filter(q => g.strata.includes(q.stratum)).map(q => q.id).sort();
      const graded = ids.map(id => mine.get(id)!.score).filter((x): x is number => x !== null);
      return {
        label: g.label, n: ids.length, graded: graded.length, accuracy: mean(graded), exposure: exposureOf(mine, ids),
        comparators: Object.fromEntries(COMPARATORS.map(c => [c, { accuracy: mean(ids.map(id => comps[c].get(id)?.score).filter((x): x is number => typeof x === 'number')), exposure: exposureOf(comps[c], ids), gap: gap(mine, comps[c], ids) }])),
        ...(against ? { against: gap(mine, against, ids) } : {}),
      };
    }),
  };
}

/** The gbrain row of a dev run directory: its pulled world outputs, or the directory itself. */
const gbrainRow = (dir: string) => readRow([existsSync(join(dir, 'worlds')) ? join(dir, 'worlds') : dir], 'gbrain-defaults');

const refOf = (dir: string) => { const f = join(dir, 'run.json'); return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { gbrain_ref?: string }).gbrain_ref ?? null : null; };

/** A dev run's per-question scores and exposure, in the comparator cache's row shape. */
export function savedRow(dir: string): BaselineRow & { gbrain_ref: string | null } {
  const row = gbrainRow(dir);
  return { source: `BG1 dev loop, ${basename(dir)}`, gbrain_ref: refOf(dir), settings: row.settings, ...(row.gbrainSha ? { gbrain_sha: row.gbrainSha } : {}),
    questions: Object.fromEntries([...row.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(q => [q.id, { score: q.score, gold: q.gold, stale: q.stale }])) };
}

/** A dev run's score, refused when its reading settings, or those of the run it is compared with, differ from the comparators'. */
export function scoreRun(dir: string, opts: { baselines?: Baselines; against?: string } = {}): Score {
  const b = opts.baselines ?? loadBaselines();
  const want = JSON.stringify(b.rows['ext-memory-bank'].settings);
  const check = (where: string, settings: Record<string, unknown>) => { if (JSON.stringify(settings) !== want) throw new DevLoopRefusal(`the run at ${where} reads at ${JSON.stringify(settings)}, and the comparators were read at ${want}`); };
  const row = gbrainRow(dir);
  check(dir, row.settings);
  let against: Map<string, QuestionRecord> | undefined;
  if (opts.against) {
    const other = opts.against.endsWith('.json') ? (JSON.parse(readFileSync(opts.against, 'utf8')) as BaselineRow) : savedRow(opts.against);
    check(opts.against, other.settings);
    against = new Map(Object.entries(other.questions).map(([id, q]) => [id, { ...row.records.get(id)!, ...q, answer: null, context: null }]));
  }
  return { ...scoreRecords(dir, row.gbrainSha, row.records, b, against), gbrain_ref: refOf(dir) };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
const pts = (g: Gap | null | undefined) => (!g ? 'n/a' : `${signed(g.delta)} (${g.ci95 ? `${signed(g.ci95[0])} to ${signed(g.ci95[1])}` : 'no interval'})`);

export function renderScore(s: Score): string {
  const vs = s.classes.some(c => c.against !== undefined);
  const lines = [`BG1 dev loop: gbrain ${s.gbrain_ref ? `${s.gbrain_ref} (${s.gbrain_sha})` : s.gbrain_sha ?? '(unknown commit)'} on ${s.questions} dev questions (${s.ungraded} without a gating grade), read by ${DEV_READER} and graded by ${DEV_JUDGE}.`,
    'Accuracy, and exposure: the share of contexts that held every value the answer needs. Gaps are gbrain minus each server in points, with a paired 95% interval over questions.', '',
    `| Class | n | gbrain | exposure | memory-bank | exposure | gap | extract-first | exposure | gap | smallest visible change |${vs ? ' minus --against |' : ''}`,
    `|---|---:|---:|---:|---:|---:|---|---:|---:|---|---:|${vs ? '---|' : ''}`];
  for (const c of s.classes) {
    const mb = c.comparators['ext-memory-bank'], ef = c.comparators['ext-extract-first'];
    const mde = Math.max(mb.gap?.mde ?? 0, ef.gap?.mde ?? 0);
    lines.push(`| ${c.label} | ${c.n} | ${pct(c.accuracy)} | ${pct(c.exposure)} | ${pct(mb.accuracy)} | ${pct(mb.exposure)} | ${pts(mb.gap)} | ${pct(ef.accuracy)} | ${pct(ef.exposure)} | ${pts(ef.gap)} | ${mde ? `${mde.toFixed(1)} pts` : 'n/a'} |${vs ? ` ${pts(c.against)} |` : ''}`);
  }
  lines.push('', 'The smallest visible change is the paired difference a two-sided 0.05 test detects with 80% power in that class (the larger of the two comparisons). The intervals cover question sampling within these three worlds, not new worlds.');
  return lines.join('\n');
}

// ─── Why rows ────────────────────────────────────────────────────────

export interface WhyRow {
  id: string; world: string; stratum: Bg1Stratum; question: string; gold: string | null;
  /** Each needed value (every value of an ordered question, else the gold with its accepted forms as one) and whether gbrain's context held it. */
  needed: Array<{ value: string; in_context: boolean | null }>;
  stale_in_context: string[];
  gbrain: { sha: string | null; answer: string | null; context: string | null; score: number | null };
  comparators?: Record<string, { answer: string | null; context: string | null; score: number | null; gold_in_context: boolean | null }>;
}

/** Which needed values a context holds: each value of an ordered question, else any accepted form of the gold; and the stale values it holds. */
export function neededValues(q: MemoryQuestion, context: string | null): { needed: WhyRow['needed']; stale: string[] } {
  const f = q.bg1!;
  if (context === null) return { needed: f.ordered ? f.gold_values.map(v => ({ value: v, in_context: null })) : [{ value: f.gold_values.join(' | '), in_context: null }], stale: [] };
  const hits = findValues(context, { gold: f.gold_values, stale: f.stale_values, decoy: f.decoy_values });
  const held = (v: number) => hits.some(h => h.kind === 'gold' && h.value === v);
  return {
    needed: f.ordered ? f.gold_values.map((v, i) => ({ value: v, in_context: held(i) })) : [{ value: f.gold_values.join(' | '), in_context: f.gold_values.some((_, i) => held(i)) }],
    stale: [...new Set(hits.filter(h => h.kind === 'stale').map(h => f.stale_values[h.value]))],
  };
}

export function whyRows(dir: string, opts: { stage1?: string; classes?: readonly Bg1Stratum[] } = {}): WhyRow[] {
  const qs = devQuestions();
  const row = gbrainRow(dir);
  const comps = opts.stage1 ? Object.fromEntries(COMPARATORS.map(c => [c, readRow([join(opts.stage1!, STAGE1_UNITS[c].dir)], STAGE1_UNITS[c].system).records])) : null;
  const classes = opts.classes ?? WHY_CLASSES;
  return [...row.records.values()].filter(r => classes.includes(r.stratum) && r.score === 0).sort((a, b) => (a.id < b.id ? -1 : 1)).map(r => {
    const q = qs.get(r.id)!;
    const { needed, stale } = neededValues(q, r.context);
    return { id: r.id, world: r.world, stratum: r.stratum, question: q.question, gold: q.answer ?? null, needed, stale_in_context: stale, gbrain: { sha: row.gbrainSha, answer: r.answer, context: r.context, score: r.score },
      ...(comps ? { comparators: Object.fromEntries(COMPARATORS.map(c => { const x = comps[c].get(r.id)!; return [c, { answer: x.answer, context: x.context, score: x.score, gold_in_context: x.gold }]; })) } : {}) };
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const sub = argv[0];
  if (sub === 'clock') { console.log(faketimeOffset()); return 0; }
  if (sub === 'cell') {
    const sha = one('--sha'), world = one('--world'), out = one('--out'), systemUrl = one('--system-url');
    if (!sha || !world || !out || !systemUrl) throw new DevLoopRefusal('cell needs --sha, --world, --out and --system-url');
    const r = await runDevCell({ sha, world, out, systemUrl });
    console.log(`${r.cell} ${world}: ${r.status}${r.stopped ? ` (stopped: ${r.stopped})` : ''}; ${r.arms.map(a => `${a.answers} answers, ${a.judgments} judgments`).join('; ')}`);
    return (r.share ? r.share.complete : r.status === 'complete') ? 0 : 4;
  }
  if (sub === 'run') return launch(argv);
  if (sub === 'score') {
    const run = one('--run'), against = one('--against');
    if (!run) throw new DevLoopRefusal('score needs --run <dir>');
    const s = scoreRun(resolve(run), { against: against ? resolve(against) : undefined });
    const save = one('--save');
    if (save) { mkdirSync(dirname(resolve(save)), { recursive: true }); writeFileSync(resolve(save), JSON.stringify(savedRow(resolve(run)), null, 1) + '\n'); }
    console.log(argv.includes('--json') ? JSON.stringify(s, null, 2) : renderScore(s));
    return 0;
  }
  if (sub === 'why') {
    const run = one('--run'), out = one('--out'), stage1 = one('--stage1');
    if (!run || !out) throw new DevLoopRefusal('why needs --run <dir> and --out <file.jsonl>');
    const rows = whyRows(resolve(run), { stage1: stage1 ? resolve(stage1) : undefined, classes: one('--classes')?.split(',') as Bg1Stratum[] | undefined });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    console.log(`${rows.length} missed questions written to ${out}`);
    return 0;
  }
  if (sub === 'baselines') {
    const stage1 = one('--stage1');
    if (!stage1) throw new DevLoopRefusal('baselines needs --stage1 <copied stage 1 state dir>');
    const out = resolve(one('--out') ?? BASELINES_PATH);
    mkdirSync(dirname(out), { recursive: true });
    const text = JSON.stringify(buildBaselines(resolve(stage1)), null, 1) + '\n';
    writeFileSync(out, text);
    console.log(`baselines written to ${out} (sha256 ${createHash('sha256').update(text).digest('hex').slice(0, 12)})`);
    return 0;
  }
  throw new DevLoopRefusal(`usage: dev-loop.ts run | score | why | baselines | clock | cell (got ${sub ?? 'nothing'})`);
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (e) {
    if (e instanceof DevLoopRefusal || e instanceof WindowRefusal) { process.stderr.write(`dev-loop: ${e.message}\n`); process.exit(2); }
    throw e;
  }
}

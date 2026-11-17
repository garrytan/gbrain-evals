/**
 * BG1's dev loop (GST-2854): scores a gbrain build on BG1's public dev worlds (stage 1's three, and 17 extra worlds,
 * bg1-dev-04 to bg1-dev-20, a list of their own), class by class, against the memory-bank and extract-first servers'
 * rows at the same reader and judge settings (stage 1's on the three, their comparator runs' on the extra worlds), so a change to how gbrain
 * keeps dated facts can be checked in about an hour. The dev worlds are public and gbrain may be tuned on them, so
 * nothing here is a counted or held-out result; the preregistration
 * (docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md) keeps its sealed worlds for that.
 *
 *   bun eval/runner/bg1/dev-loop.ts run [--gbrain <tag|branch|sha>] --paid-window <unit> --window-cap-usd <n> [--out <dir>]
 *       [--worlds bg1-dev-01,...|extra|dev20] [--vm-size standard-4] [--location eu-central-h1] [--overlay <gbrain key>=<value>]...
 *     Resolves the ref to a gbrain commit (without --gbrain, gbrain's newest release tag, so the baseline is always the
 *     newest build) and runs BG1's gbrain cell at it (configuration rs1-stable, arm P: query with
 *     the facts block, packed to 8,000 tokens) on one Ubicloud VM per dev world, each under its own metering proxy
 *     whose lease is the window cap over the worlds, then pulls the outputs into --out and prints `score`. Each VM starts
 *     only after `ubi-runner.sh usage` shows room for it under the shared project's 464-vCPU line for evals and this
 *     crew's 208 (owners sharing UBI_OWNER's letters, gbev for gbev91); otherwise it reads usage again every 5 minutes. The reader is
 *     claude-opus-5-5 at effort medium with 2,048 output tokens, and the gating judge is gpt-6-astra at the pinned judge
 *     settings (the family rule). Every answer also gets the canonical gemini-3.8-flash grade, as stage 1 ran it
 *     (descriptive). Needs ANTHROPIC_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY, GEMINI_API_KEY, UBICLOUD_API_KEY and UBI_OWNER.
 *     gbrain's idle upkeep stays on, as gbrain ships it. After the cell, each VM keeps the world's brain in its outputs
 *     (brain/gbrain-defaults.tar, a bootstrap.sh snapshot of the stack's volumes after the last question, with the
 *     shim's logs and receipts) and lists every idle upkeep run gbrain logged in upkeep.ndjson. Each VM is named
 *     ubirun-<owner>-<epoch>-devloop-<world>-<hex>-t7, so the runner's own reaper destroys it once its 7-hour TTL
 *     ends. Before launching, run destroys this owner's dev-loop VMs older than 7 hours (never another owner's, never a
 *     VM without the dev-loop marker) and refuses if it can't; after the run it prints each of its VMs still standing
 *     (a failed final pull or a lost ssh session keeps one) with the commands to pull its outputs and destroy it and
 *     the time after which the next run destroys it unpulled, and exits 4.
 *     Each --overlay sets one of the six search keys the gbrain-defaults shim writes for the arm (true or false;
 *     search.query_budget_unit chunk or auto) on top of the stage 1 arm's values. An unknown key, a bad value, or a key
 *     gbrain's config does not list at the resolved commit refuses before any VM starts. The overlay goes into run.json,
 *     the out and lease names, each VM's cell command and so its run-config, the score header and the why rows. With
 *     no --overlay nothing changes. An overlay value the stage 1 arm already has refuses, and so does an --out that
 *     already holds a run.
 *   bun eval/runner/bg1/dev-loop.ts score --run <dir> [--against <earlier run dir or saved row>] [--allow-run-diff] [--save <row.json>] [--json]
 *     Per class S1 to S8, pooled (what is true now: S1 to S5; time-indexed: S6 to S8) and overall: gbrain's accuracy,
 *     its exposure rate (the context held every value the answer needs) and its gap to each comparator with a paired
 *     95% interval over questions, plus the smallest gap change each class can show. Every column covers the questions
 *     gbrain graded, and a directory whose cells mix gbrain builds or answer a question twice refuses. --against adds this run minus an
 *     earlier gbrain run; --save writes this run's per-question scores and exposure (no answers or contexts), which a
 *     later --against reads in place of the run directory. Two runs compared under --against must match in everything
 *     but their gbrain ref and overlay (worlds, the worlds each graded, world end, question day, reader, judge, questions) unless
 *     --allow-run-diff; when either has an overlay, the score opens with both and the keys where they differ. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts run --system ext-memory-bank|ext-extract-first --paid-window <unit> --window-cap-usd <n>
 *       [--worlds extra|bg1-dev-04,...] [--out <dir>] [--vm-size standard-4] [--location eu-central-h1]
 *     A comparator run: the comparator's stage 1 cell, read and judged as above, on extra worlds (never the three, whose
 *     rows are stage 1's), one VM per world under the same room check, reap and keep list. The comparators read the
 *     wall clock, as stage 1 ran them, so their cell takes the runner's check and refuses more than 14 days past the
 *     world end. It writes run.json with the system and prints where the rows are.
 *   bun eval/runner/bg1/dev-loop.ts why --run <dir> --out <file.jsonl> [--stage1 <dir>] [--extra <comparator runs>] [--classes s1_updated,...]
 *     One row per question gbrain missed in S1 and S5 to S8 (a run with an overlay needs it in the file name, and each row
 *     carries it): the question, the gold, gbrain's answer and context, which
 *     needed values the context held and, with --stage1 (the copied stage 1 results), each comparator's context and
 *     answer beside it. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts baselines --stage1 <dir> [--out <file>]
 *     Rewrites the comparator cache (BASELINES_PATH) from stage 1's results, after checking that every row read at
 *     the same settings. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts baselines --extra <ext-memory-bank run>,<ext-extract-first run> [--out <file>]
 *     Writes the extra worlds' comparator cache (EXTRA_BASELINES_PATH) from the two comparator runs, each at its stage 1
 *     row's settings; `score` reads it beside stage 1's once it exists. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts upkeep --snapshot <brain tar> --out <file.ndjson>
 *     Lists every idle upkeep run gbrain's serve logged in a world's brain snapshot: its order, duration and outcome.
 *     Each VM runs it after its snapshot. Keyless.
 *   bun eval/runner/bg1/dev-loop.ts clock
 *     Prints the libfaketime offset that moves a clock read now back to the question day (the VM command uses it).
 *   bun eval/runner/bg1/dev-loop.ts cell (--sha <sha> | --system <comparator>) --world <id> --out <dir> --system-url <url>
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
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { bg1RunClock, loadCorpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_ROUTE_CAPS } from '../metering-proxy.ts';
import { requireRs1Window, WindowRefusal } from '../paid-arm.ts';
import { runCell, type CellDeps, type CellResult } from '../q1/cell.ts';
import { bg1Estimate, loadBG1Manifest, OPUS } from '../q1/cells/bg1.ts';
import { bg1JudgeOf, launchPrefix, OVERLAY_KEYS, pinnedJudgeRouteCaps, type CellDefinition } from '../q1/cells/definitions.ts';
import { DEFAULT_ROUTE_CLASSES, EXECUTES, Q1_VM_PATHS, resolveRunner, type RemotePayload } from '../shootout-cell.ts';
import { clusteredPairedDelta, powerNote } from '../stats/paired.ts';
import { evidenceOf, exposure } from './exposure.ts';
import { findValues } from './match.ts';
import { BG1_DEV_EXTRA_CONVERSATIONS, BG1_PRIMARY, BG1_SECONDARY, BG1_STRATA, type Bg1Stratum } from './types.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const DEV_WORLDS = ['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03'] as const;
/** The dev loop's 17 extra public dev worlds (bg1-dev-04 to bg1-dev-20), a list of their own beside stage 1's three. */
export const EXTRA_WORLDS: readonly string[] = BG1_DEV_EXTRA_CONVERSATIONS;
export const ALL_WORLDS: readonly string[] = [...DEV_WORLDS, ...EXTRA_WORLDS];
/** The list a world belongs to, which its cell runs one world per shard: stage 1's three, or the 17 extra. */
const listOf = (world: string): readonly string[] => ((DEV_WORLDS as readonly string[]).includes(world) ? DEV_WORLDS : EXTRA_WORLDS);
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
export type Comparator = typeof COMPARATORS[number];
/** Each comparator's stage 1 cell, which a comparator run (`run --system`) takes to the extra worlds. */
export const STAGE1_COMPARATOR_CELLS: Record<Comparator, string> = { 'ext-memory-bank': 'bg1-dev3.ext-memory-bank.recipe', 'ext-extract-first': 'bg1-dev3.ext-extract-first.common' };
export const BASELINES_PATH = join(REPO_ROOT, 'eval/data/changing-facts-v1/dev/baselines/stage1-opus.json');
/** The comparators' rows on the extra worlds, from their comparator runs (`baselines --extra`). */
export const EXTRA_BASELINES_PATH = join(REPO_ROOT, 'eval/data/changing-facts-v1/dev/baselines/extra-opus.json');
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

// ─── Overlays ────────────────────────────────────────────────────────

/** gbrain settings a run sets on its gbrain arm, on top of the stage 1 arm's own. */
export type Overlay = Record<string, boolean | string>;

/**
 * Every `--overlay <key>=<value>` in argv, sorted by key. A key must be one of the six search keys the gbrain-defaults
 * shim writes on every switch (q1/cells/definitions.ts OVERLAY_KEYS); search.query_budget_unit takes chunk or auto and
 * every other key true or false. An unknown key, a bad value or a key given twice refuses, so a typo never yields a
 * second arm identical to the first.
 */
export function parseOverlays(argv: readonly string[]): Overlay {
  const out: Overlay = {};
  argv.forEach((a, i) => {
    if (a !== '--overlay') return;
    const kv = argv[i + 1] ?? '', at = kv.indexOf('=');
    const key = at > 0 ? kv.slice(0, at) : '', value = kv.slice(at + 1);
    if (!key) throw new DevLoopRefusal(`--overlay takes <gbrain key>=<value>, not ${JSON.stringify(kv)}`);
    if (!(OVERLAY_KEYS as readonly string[]).includes(key)) throw new DevLoopRefusal(`--overlay ${key} is not a key the gbrain-defaults shim sets; it sets ${OVERLAY_KEYS.join(', ')}`);
    if (key in out) throw new DevLoopRefusal(`--overlay ${key} is given twice`);
    const values = key === 'search.query_budget_unit' ? ['chunk', 'auto'] : ['true', 'false'];
    if (!values.includes(value)) throw new DevLoopRefusal(`--overlay ${key} takes ${values.join(' or ')}, not ${JSON.stringify(value)}`);
    out[key] = key === 'search.query_budget_unit' ? value : value === 'true';
  });
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** An overlay as it appears in directory and file names: search.evidence_date_header=true is evidence_date_header=true. */
export const overlaySlug = (o: Overlay) => Object.entries(o).map(([k, v]) => `${k.replace(/^search\./, '')}=${v}`).join('+');

/**
 * Refuses, before any VM starts, an overlay key that gbrain's config at `sha` does not list (quoted in
 * src/core/config.ts at that commit), since gbrain would ignore it and the run would repeat the arm without it.
 */
export async function checkOverlayHead(sha: string, overlay: Overlay, read: (url: string) => Promise<string> = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}): Promise<void> {
  const keys = Object.keys(overlay);
  if (!keys.length) return;
  const url = `https://raw.githubusercontent.com/garrytan/gbrain/${sha}/src/core/config.ts`;
  let text: string;
  try { text = await read(url); } catch (e) { throw new DevLoopRefusal(`could not read gbrain's config keys at ${sha} (${url}: ${(e as Error).message}), so the overlay cannot be checked before the VMs start`); }
  const missing = keys.filter(k => !text.includes(`'${k}'`));
  if (missing.length) throw new DevLoopRefusal(`gbrain ${sha} does not list ${missing.join(', ')} in src/core/config.ts, so the overlay would change nothing`);
}

// ─── The cell ────────────────────────────────────────────────────────

/**
 * A stage 1 dev cell read by claude-opus-5-5 alone and judged by gpt-6-astra alone. Its store snapshot and restore
 * commands are dropped: a dev run never resumes, it runs again. On an extra world the cell runs the 17 extra worlds,
 * one per shard, under an id of its own (bg1-dev-extra.*); it keeps BG1-dev3's set, whose sizing feeds only the estimate.
 */
function fromStage1(id: string, world?: string): Omit<CellDefinition, 'estimate'> {
  const src = loadBG1Manifest().smoke_cells.find(c => c.id === id);
  if (!src?.launch) throw new DevLoopRefusal(`${id} is missing from eval/runner/q1/cells/bg1-cells.json`);
  const extra = world !== undefined && EXTRA_WORLDS.includes(world);
  const named = (s: string) => (extra ? s.replace(/^bg1-dev3\./, 'bg1-dev-extra.') : s);
  const { estimate: _e, snapshot_command: _s, restore_command: _r, lease: _l, ...rest } = src;
  return { ...rest, id: named(src.id), ...(extra ? { only_conversations: [...EXTRA_WORLDS] } : {}),
    arms: src.arms.map(a => ({ ...a, cell_id: named(a.cell_id), readers: [DEV_READER], frontier: a.frontier ? { ...a.frontier, judges: [DEV_JUDGE] } : null })) };
}

/** Stage 1's gbrain cell at another gbrain commit, with any overlay on its arm, for `world`'s list. */
export function devCell(sha: string, overlay: Overlay = {}, world?: string): CellDefinition {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new DevLoopRefusal(`a dev cell needs a full 40-character gbrain commit, not ${JSON.stringify(sha)}`);
  const src = fromStage1(STAGE1_GBRAIN_CELL, world);
  const same = Object.keys(overlay).filter(k => src.arms.some(a => a.retrieval?.overlay?.[k] === overlay[k]));
  if (same.length) throw new DevLoopRefusal(`the stage 1 arm already sets ${same.map(k => `${k}=${overlay[k]}`).join(', ')}, so the overlay would change nothing`);
  const def: Omit<CellDefinition, 'estimate'> = {
    ...src, launch: { ...src.launch!, env: { ...src.launch!.env, GBRAIN_SHA: sha } },
    arms: src.arms.map(a => (Object.keys(overlay).length && a.retrieval ? { ...a, retrieval: { ...a.retrieval, overlay: { ...a.retrieval.overlay, ...overlay } } } : a)),
  };
  return { ...def, estimate: bg1Estimate(def) };
}

/** A comparator's stage 1 cell, as a comparator run takes it to an extra world. */
export function comparatorCell(system: Comparator, world?: string): CellDefinition {
  const def = fromStage1(STAGE1_COMPARATOR_CELLS[system], world);
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

export interface DevCellOptions { sha?: string; system?: Comparator; world: string; out: string; systemUrl: string | null; env?: Record<string, string | undefined>; overlay?: Overlay }

/**
 * One dev world through the cell under a lease proxy (SHOOTOUT_PROXY, which runRemote starts). gbrain's cell (`sha`)
 * runs with the world end pinned and the container clock checked first; deps.clockMs stands in for the container in
 * keyless tests, and it never calls the runner's wall-clock check. A comparator's cell (`system`) reads the wall clock
 * as stage 1 ran it, so it takes the runner's check (at most 14 days past the world end); deps.now stands in for today.
 * The cell reads the world's whole list (stage 1's three, or the 17 extra worlds), so its shard is that world: a bg1-dev
 * load with no list reads only the three.
 */
export async function runDevCell(o: DevCellOptions, deps: CellDeps & { clockMs?: () => number; now?: Date } = {}): Promise<CellResult> {
  const env = o.env ?? process.env;
  if (!ALL_WORLDS.includes(o.world)) throw new DevLoopRefusal(`--world must be one of ${DEV_WORLDS.join(', ')} or an extra world (bg1-dev-04 to bg1-dev-20), not ${o.world}`);
  if (!o.system === !o.sha) throw new DevLoopRefusal('cell runs gbrain at --sha or a comparator with --system, one of them');
  const def = o.system ? comparatorCell(o.system, o.world) : devCell(o.sha!, o.overlay, o.world);
  const { worldEnd, asOf } = devClock(def);
  const list = listOf(o.world);
  const proxy = env.SHOOTOUT_PROXY ?? null;
  if (!proxy && !(deps.reader && deps.judge)) throw new DevLoopRefusal('cell runs only under a lease proxy (shootout-cell.ts remote sets SHOOTOUT_PROXY), so every call is metered and capped');
  if (o.system) {
    try { bg1RunClock({ worldEnd, now: deps.now }); } catch (e) { throw new DevLoopRefusal(`refusing before any paid call: ${(e as Error).message}; ${o.system} reads the wall clock, as stage 1 ran it, so its rows on the extra worlds are run within 14 days of the world end`); }
  } else {
    const problem = clockProblem((deps.clockMs ?? containerClockMs)(), asOf);
    if (problem) throw new DevLoopRefusal(`refusing before any paid call: ${problem}. Build the image with GBRAIN_FAKETIME_LIB=1 and start the stack with GBRAIN_FAKETIME from ${'`'}bun eval/runner/bg1/dev-loop.ts clock${'`'}`);
  }
  env.GBRAIN_EVALS_BG1_WORLD_END = worldEnd;
  process.env.GBRAIN_EVALS_BG1_WORLD_END = worldEnd;
  return runCell(def, { out: o.out, shard: { index: list.indexOf(o.world), count: list.length }, systemUrl: o.systemUrl, providerProxy: proxy, env },
    { ...deps, corpus: deps.corpus ?? loadCorpus('bg1-dev', undefined, new Set(list)) });
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

/**
 * What one world's VM runs: the stack on the pinned clock and the cell; then, whatever the cell's exit, the stack's
 * volumes snapshotted to $SHOOTOUT_OUT/brain (the brain as it stood after the last question, with the shim's logs and
 * receipts) and every idle upkeep run gbrain logged listed in $SHOOTOUT_OUT/upkeep.ndjson; then the stack down. A
 * failed snapshot or upkeep list is logged and leaves the cell's exit code as it was.
 */
export function vmCommand(sha: string, world: string, overlay: Overlay = {}): string {
  const def = devCell(sha, overlay, world);
  const pre = launchPrefix({ ...def.launch!, env: { ...def.launch!.env, GBRAIN_FAKETIME_LIB: '1' } });
  return [`export GBRAIN_EVALS_BG1_WORLD_END=${DEV_WORLD_END}`, 'export GBRAIN_FAKETIME="$(bun eval/runner/bg1/dev-loop.ts clock)"',
    `${pre}bash eval/systems/bootstrap.sh up --system gbrain-defaults --config ${def.launch!.config} && bun eval/runner/bg1/dev-loop.ts cell --sha ${sha} --world ${world}${Object.entries(overlay).map(([k, v]) => ` --overlay ${k}=${v}`).join('')} --system-url http://127.0.0.1:8700 --out "$SHOOTOUT_OUT"; rc=$?; { ${pre}bash eval/systems/bootstrap.sh snapshot --system gbrain-defaults --out "$SHOOTOUT_OUT/${BRAIN_SNAPSHOT}" && bun eval/runner/bg1/dev-loop.ts upkeep --snapshot "$SHOOTOUT_OUT/${BRAIN_SNAPSHOT}" --out "$SHOOTOUT_OUT/upkeep.ndjson"; } || echo "dev loop: the brain snapshot or the upkeep list failed" >&2; bash eval/systems/bootstrap.sh down --system gbrain-defaults; exit $rc`].join('; ');
}

/** Where each world's brain snapshot sits in its outputs. */
export const BRAIN_SNAPSHOT = 'brain/gbrain-defaults.tar';

/**
 * One idle upkeep run as gbrain's serve logs it on stderr (src/core/maintenance/idle.ts): its place in the log, how
 * long it took and its outcome (ran, skipped or not_due, with gbrain's code). A run with no finish line was cut off,
 * by a serve stop or the end of the run.
 */
export interface UpkeepRun { run: number; finished: boolean; ms: number | null; status: string | null; code: string | null }

export function upkeepRuns(serveLog: string): UpkeepRun[] {
  const runs: UpkeepRun[] = [];
  for (const line of serveLog.split('\n')) {
    const m = /\[gbrain serve\] idle upkeep: (?:(started)|finished in (\d+) ms \((\w+)(?: (\S+))?\))/.exec(line);
    if (!m) continue;
    const open = runs.at(-1);
    if (m[1]) runs.push({ run: runs.length + 1, finished: false, ms: null, status: null, code: null });
    else if (open && !open.finished) Object.assign(open, { finished: true, ms: Number(m[2]), status: m[3], code: m[4] ?? null });
  }
  return runs;
}

/** The serve log inside a bootstrap.sh snapshot: logs/serve.log in the gbrain-defaults data volume, where the shim sends serve's stderr. */
const snapshotServeLog = (tar: string) =>
  execFileSync('bash', ['-c', 'set -o pipefail; tar -xOf "$1" ./gbrain-data.tar | tar -xOf - ./logs/serve.log', 'serve-log', tar], { encoding: 'utf8', maxBuffer: 1 << 30 });

/** The payload shootout-cell.ts remote runs on one world's VM: its own lease proxy, with Gemini on GEMINI_API_KEY. */
export function vmPayload(sha: string, world: string, leaseId: string, leaseUsd: number, overlay: Overlay = {}): RemotePayload {
  return payload(devCell(sha, overlay, world), vmCommand(sha, world, overlay), leaseId, leaseUsd);
}

/** What a comparator's VM runs on one extra world: its stack as stage 1 started it, the cell, then the stack down. */
export function comparatorVmCommand(system: Comparator, world: string): string {
  const def = comparatorCell(system, world);
  return [`export GBRAIN_EVALS_BG1_WORLD_END=${DEV_WORLD_END}`,
    `${launchPrefix(def.launch!)}bash eval/systems/bootstrap.sh up --system ${system} --config ${def.launch!.config} && bun eval/runner/bg1/dev-loop.ts cell --system ${system} --world ${world} --system-url http://127.0.0.1:8700 --out "$SHOOTOUT_OUT"; rc=$?; bash eval/systems/bootstrap.sh down --system ${system}; exit $rc`].join('; ');
}

export const comparatorPayload = (system: Comparator, world: string, leaseId: string, leaseUsd: number): RemotePayload =>
  payload(comparatorCell(system, world), comparatorVmCommand(system, world), leaseId, leaseUsd);

const payload = (def: CellDefinition, command: string, leaseId: string, leaseUsd: number): RemotePayload => ({
  lease_id: leaseId, lease_usd: leaseUsd, max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS, command, out: `eval/reports/bg1-dev-loop/${leaseId}`, cell: def.id, timeout_hours: 4,
  route_caps: { caps: { ...DEFAULT_ROUTE_CAPS, ...pinnedJudgeRouteCaps(def.arms) }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' }, gemini_key_env: 'GEMINI_API_KEY' });

/** A crew's owner prefix: the leading letters of the runner's owner tag, which it lowercases and strips to a-z0-9 (UBI_OWNER GBRA-108 is gbra108, so gbra). */
export const crewOf = (ownerTag: string) => /^[a-z]+/.exec(ownerTag)?.[0] ?? 'gbev';

/** The shared Ubicloud project's line for eval VMs (512 vCPUs less 48 kept for merge checks), and one crew's share of it. */
export const UBI_PROJECT_LINE = 464;
export const UBI_CREW_LINE = 208;

/**
 * How many more VMs of `vcpus` each fit under both lines, from `ubi-runner.sh usage` (OWNER VMS VCPUS rows, the
 * caller's own marked "(you)", and a total row); the launching crew's VMs are the owners starting with `crewPrefix`
 * (crewOf the runner's owner tag: `gbev` for gbev91). Unreadable usage fits none.
 */
export function ubiRoom(usage: string, vcpus: number, crewPrefix = 'gbev'): number {
  const rows = usage.split('\n').map(l => l.trim().split(/\s+/)).map(r => (r.length === 4 && r[3] === '(you)' ? r.slice(0, 3) : r))
    .filter(r => r.length === 3 && /^\d+$/.test(r[1]) && /^\d+$/.test(r[2]));
  const total = rows.find(r => r[0] === 'total');
  if (!total || !(vcpus > 0)) return 0;
  const crew = rows.filter(r => r[0].startsWith(crewPrefix)).reduce((n, r) => n + Number(r[2]), 0);
  return Math.max(0, Math.min(Math.floor((UBI_PROJECT_LINE - Number(total[2])) / vcpus), Math.floor((UBI_CREW_LINE - crew) / vcpus)));
}

// ─── Leftover VMs ────────────────────────────────────────────────────

/**
 * The repo's ubi-runner.sh keeps a VM when its final pull fails (exit 253) or its ssh session is lost (255), and a
 * killed launcher never reaches the runner's teardown. So each dev-loop VM carries a DEV_VM_HOURS TTL (which the
 * runner's reaper enforces on this owner's next launch) and a dev-loop marker in its name, `run` first destroys this
 * owner's dev-loop VMs older than DEV_VM_HOURS (a dev run takes about an hour), and after the run it lists every VM of
 * its own still standing, with the commands to pull and destroy it, and exits non-zero. Other owners' VMs and VMs without the marker are never touched.
 */
export const DEV_VM_HOURS = 7;

/** ubi-runner.sh as a function: its arguments in, its stdout out; it throws when the runner exits non-zero. */
export type UbiRunner = (args: string[]) => string;

/** A dev-loop VM name under the runner's ownership scheme, with its TTL: ubirun-<owner>-<epoch>-devloop-<world>-<4 hex>-t<DEV_VM_HOURS>. */
export const devVmName = (owner: string, world: string, nowMs: number) => `ubirun-${owner}-${Math.floor(nowMs / 1000)}-devloop-${world}-${randomBytes(2).toString('hex')}-t${DEV_VM_HOURS}`;

/** The owner and creation second of a dev-loop VM name, or null for any other name. */
export function devVm(name: string): { owner: string; epoch: number } | null {
  const m = /^ubirun-([a-z][a-z0-9]{0,11})-(\d{10})-devloop-/.exec(name);
  return m ? { owner: m[1], epoch: Number(m[2]) } : null;
}

/** This owner's VMs, from `list --mine` ("<location>  <name>" per line). */
const ownVms = (ubi: UbiRunner) => ubi(['list', '--mine']).split('\n').map(l => l.trim().split(/\s+/)).filter(r => r.length === 2).map(([loc, name]) => ({ loc, name }));

/** Destroys this owner's dev-loop VMs created more than DEV_VM_HOURS ago and returns their names; a failed list or destroy throws. */
export function reapDevVms(ubi: UbiRunner, nowMs: number): string[] {
  const owner = ubi(['owner']).trim();
  const stale = ownVms(ubi).filter(v => { const d = devVm(v.name); return d !== null && d.owner === owner && nowMs / 1000 - d.epoch >= DEV_VM_HOURS * 3600; });
  for (const v of stale) {
    console.error(`dev loop: destroying ${v.loc}/${v.name}, a dev-loop VM of ${owner} older than ${DEV_VM_HOURS} hours`);
    ubi(['down', v.name, '-l', v.loc]);
  }
  return stale.map(v => v.name);
}

/** This run's VMs still standing after it, each with the commands that pull its outputs and destroy it. */
export function keptDevVms(ubi: UbiRunner, runner: string, launched: ReadonlyArray<{ name: string; remote: string; local: string }>): string[] {
  const standing = new Map(ownVms(ubi).map(v => [v.name, v.loc]));
  return launched.filter(v => standing.has(v.name)).map(v =>
    `${standing.get(v.name)}/${v.name} is still running. Pull its outputs: bash ${runner} pull ${v.name} ${v.remote} ${v.local}; then destroy it: bash ${runner} down ${v.name} -l ${standing.get(v.name)}. `
    + `Pull it before ${new Date(((devVm(v.name)?.epoch ?? 0) + DEV_VM_HOURS * 3600) * 1000).toISOString()}: after that, this owner's next dev-loop run destroys it, pulled or not`);
}

/** What a dev-loop VM receives: the Q1 runner's paths, BG1's analysis code and the dev worlds. */
export const SHIP_PATHS = [...new Set([...EXECUTES, ...Q1_VM_PATHS, 'eval/runner/bg1'])];

/** The worlds `--worlds` names: ids from the 20 dev worlds, or `extra` (the 17) or `dev20` (all 20); a world listed twice refuses. */
export function parseWorlds(arg: string | undefined, fallback: readonly string[]): string[] {
  const worlds = arg === 'extra' ? [...EXTRA_WORLDS] : arg === 'dev20' ? [...ALL_WORLDS] : arg ? arg.split(',') : [...fallback];
  const unknown = worlds.filter(w => !ALL_WORLDS.includes(w));
  if (unknown.length) throw new DevLoopRefusal(`--worlds takes ${DEV_WORLDS.join(', ')}, the extra worlds bg1-dev-04 to bg1-dev-20, extra or dev20, not ${unknown.join(', ')}`);
  const twice = worlds.filter((w, i) => worlds.indexOf(w) !== i);
  if (twice.length) throw new DevLoopRefusal(`--worlds lists ${[...new Set(twice)].join(', ')} more than once`);
  return worlds;
}

async function launch(argv: string[]): Promise<number> {
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const systemArg = one('--system') ?? 'gbrain-defaults';
  if (systemArg !== 'gbrain-defaults' && !(COMPARATORS as readonly string[]).includes(systemArg)) throw new DevLoopRefusal(`--system takes gbrain-defaults, ${COMPARATORS.join(' or ')}, not ${systemArg}`);
  const comparator = systemArg === 'gbrain-defaults' ? null : systemArg as Comparator;
  const worlds = parseWorlds(one('--worlds'), comparator ? EXTRA_WORLDS : DEV_WORLDS);
  if (comparator && worlds.some(w => !EXTRA_WORLDS.includes(w))) throw new DevLoopRefusal(`${comparator}'s rows on ${DEV_WORLDS.join(', ')} are stage 1's (the comparator cache), so a comparator run takes extra worlds only`);
  if (comparator && (one('--gbrain') || argv.includes('--overlay'))) throw new DevLoopRefusal(`--gbrain and --overlay set gbrain's arm, and --system ${comparator} runs no gbrain`);
  const overlay = parseOverlays(argv), slug = overlaySlug(overlay);
  const outArg = one('--out');
  if (outArg && existsSync(join(resolve(outArg), 'run.json'))) throw new DevLoopRefusal(`${outArg} already holds a run (run.json); pass a new --out so two runs never mix in one score`);
  const size = one('--vm-size') ?? 'standard-4';
  const vcpus = Number(/^standard-(\d+)$/.exec(size)?.[1]);
  if (!vcpus) throw new DevLoopRefusal(`--vm-size takes standard-<vcpus>, not ${size}`);
  const window = requireRs1Window(argv, { what: 'the BG1 dev loop', keyless: false, caps: () => [] })!;
  const missing = [...VM_KEYS, 'UBI_OWNER'].filter(k => !process.env[k]);
  if (missing.length) throw new DevLoopRefusal(`run needs ${missing.join(', ')} in the environment`);
  if (comparator) return launchComparator(argv, comparator, worlds, window, size, vcpus);
  const named = one('--gbrain');
  const newest = named ? null : newestRelease();
  const ref = named ?? newest!.tag;
  const sha = named ? resolveGbrainRef(named) : newest!.sha;
  await checkOverlayHead(sha, overlay);
  console.error(`dev loop: gbrain ${ref} at ${sha}${slug ? ` with overlay ${slug}` : ''}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const out = resolve(outArg ?? join(REPO_ROOT, 'eval/reports/bg1-dev-loop', `${sha.slice(0, 12)}${slug ? `-${slug}` : ''}-${stamp}`));
  const leaseUsd = Math.floor(window.cap_usd / worlds.length * 100) / 100;
  const def = devCell(sha, overlay, worlds[0]);
  const ok = await runVms({ argv, out, worlds, size, vcpus,
    setup: `${launchPrefix({ ...def.launch!, env: { GBRAIN_BUN_IMAGE: def.launch!.env.GBRAIN_BUN_IMAGE, GBRAIN_SHA: sha, GBRAIN_FAKETIME_LIB: '1' } })}bash eval/systems/bootstrap.sh setup --system gbrain-defaults --datasets bg1-dev --conversations ${worlds.join(',')}`,
    run: { schema: RUN_SCHEMA, gbrain_ref: ref, gbrain_sha: sha, ...(slug ? { overlay } : {}), worlds, paid_window: window.unit, window_cap_usd: window.cap_usd, lease_usd_per_world: leaseUsd,
      reader: DEV_READER, judge: DEV_JUDGE, world_end: DEV_WORLD_END, as_of: DEV_AS_OF, started_at: new Date().toISOString() },
    payloadFor: world => vmPayload(sha, world, `devloop-${sha.slice(0, 12)}-${world}-${stamp}${slug ? `-o${createHash('sha256').update(slug).digest('hex').slice(0, 8)}` : ''}`, leaseUsd, overlay) });
  if (!ok) return 4;
  console.log(renderScore(scoreRun(out)));
  return 0;
}

/**
 * A comparator run: one comparator's stage 1 cell on extra worlds, one VM per world, read and judged as stage 1 read
 * the three. It prints where its rows are; `baselines --extra` turns both comparators' runs into the extra cache.
 */
async function launchComparator(argv: string[], system: Comparator, worlds: string[], window: { unit: string; cap_usd: number }, size: string, vcpus: number): Promise<number> {
  const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
  console.error(`dev loop: ${system} on ${worlds.join(', ')}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const out = resolve(outArg ?? join(REPO_ROOT, 'eval/reports/bg1-dev-loop', `${system}-${stamp}`));
  const leaseUsd = Math.floor(window.cap_usd / worlds.length * 100) / 100;
  const def = comparatorCell(system, worlds[0]);
  const ok = await runVms({ argv, out, worlds, size, vcpus,
    setup: `${launchPrefix(def.launch!)}bash eval/systems/bootstrap.sh setup --system ${system} --datasets bg1-dev --conversations ${worlds.join(',')}`,
    run: { schema: RUN_SCHEMA, system, worlds, paid_window: window.unit, window_cap_usd: window.cap_usd, lease_usd_per_world: leaseUsd, reader: DEV_READER, judge: DEV_JUDGE, world_end: DEV_WORLD_END,
      clock: 'the wall clock, within 14 days of the world end, as stage 1 ran the comparators', started_at: new Date().toISOString() },
    payloadFor: world => comparatorPayload(system, world, `devloop-${system}-${world}-${stamp}`, leaseUsd) });
  if (!ok) return 4;
  console.log(`${system}'s rows on ${worlds.join(', ')} are in ${out}. With both comparators' runs: bun eval/runner/bg1/dev-loop.ts baselines --extra <ext-memory-bank run>,<ext-extract-first run>`);
  return 0;
}

interface VmRun { argv: string[]; out: string; worlds: string[]; size: string; vcpus: number; setup: string; run: Record<string, unknown>; payloadFor: (world: string) => RemotePayload }

/**
 * Clears this owner's stale dev-loop VMs, writes the run's setup and run.json, starts one VM per world as Ubicloud usage
 * leaves room, waits for them and prints any still standing. False when a VM failed or still stands.
 */
async function runVms(o: VmRun): Promise<boolean> {
  const location = o.argv.includes('--location') ? o.argv[o.argv.indexOf('--location') + 1] : 'eu-central-h1';
  const runner = resolveRunner();
  const ubi: UbiRunner = args => execFileSync('bash', [runner, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { reapDevVms(ubi, Date.now()); } catch (e) { throw new DevLoopRefusal(`could not clear this owner's dev-loop VMs older than ${DEV_VM_HOURS} hours (${(e as Error).message.split('\n')[0]}); check \`bash ${runner} list --mine\` before launching more`); }
  mkdirSync(join(o.out, 'setup'), { recursive: true });
  const shipFile = join(o.out, 'setup', 'ship.txt');
  writeFileSync(shipFile, SHIP_PATHS.join('\n') + '\n');
  const setup = join(o.out, 'setup', 'setup.sh');
  writeFileSync(setup, `set -euo pipefail\n${o.setup}\n`);
  writeFileSync(join(o.out, 'run.json'), JSON.stringify(o.run, null, 2) + '\n');
  const running: Array<Promise<number>> = [];
  const launched: Array<{ name: string; remote: string; local: string }> = [];
  const owner = ubi(['owner']).trim();
  for (const [i, world] of o.worlds.entries()) {
    if (i) await Bun.sleep(90_000);
    for (;;) {
      let usage = '';
      try { usage = execFileSync('bash', [runner, 'usage'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { usage = ''; }
      if (ubiRoom(usage, o.vcpus, crewOf(owner)) >= 1) break;
      console.error(`dev loop: no room for a ${o.vcpus}-vCPU VM under the project's ${UBI_PROJECT_LINE} or this crew's ${UBI_CREW_LINE} (or usage unreadable); reading again in 5 minutes`);
      await Bun.sleep(300_000);
    }
    const p = o.payloadFor(world);
    const vm = { name: devVmName(owner, world, Date.now()), remote: `work/${basename(REPO_ROOT)}/${p.out}`, local: join(o.out, 'worlds') };
    launched.push(vm);
    const args = [runner, 'run', '-s', o.size, '-l', location, '-n', vm.name, '--src', REPO_ROOT, '--only', shipFile, '--setup', setup,
      ...VM_KEYS.flatMap(k => ['--pass', k]), '--pull', `${vm.remote}:${vm.local}`, '--', `bun eval/runner/shootout-cell.ts remote --cell-b64 ${Buffer.from(JSON.stringify(p)).toString('base64')}`];
    const log = openSync(join(o.out, `${world}.log`), 'a');
    const proc = Bun.spawn(['bash', ...args], { cwd: REPO_ROOT, env: process.env, stdin: 'ignore', stdout: log, stderr: log });
    running.push(proc.exited.finally(() => closeSync(log)));
  }
  const codes = await Promise.all(running);
  console.error(`dev loop VMs exited ${codes.join(', ')}; outputs in ${join(o.out, 'worlds')}`);
  let kept: string[];
  try { kept = keptDevVms(ubi, runner, launched); } catch (e) { kept = [`could not list this owner's VMs (${(e as Error).message.split('\n')[0]}); run bash ${runner} list --mine and destroy any of ${launched.map(v => v.name).join(', ')}`]; }
  for (const line of kept) console.error(`dev loop: ${line}`);
  return !(kept.length || codes.some(c => c !== 0));
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
const dirsUnder = (dir: string) => existsSync(dir) ? readdirSync(dir).sort().filter(d => !d.startsWith('.') && statSync(join(dir, d)).isDirectory()).map(d => join(dir, d)) : [];

/** Every directory under `root` (itself included, four levels down) that holds published cells (cells/<cell id>/run-config.json). */
export function cellRoots(root: string, depth = 4): string[] {
  if (existsSync(join(root, 'cells'))) return [root];
  return depth ? dirsUnder(root).flatMap(d => cellRoots(d, depth - 1)) : [];
}

const questionCache = new Map<string, Map<string, MemoryQuestion>>();
/** The questions of the given dev worlds (stage 1's three by default), dates resolved at the dev world end. */
export function devQuestions(worlds: readonly string[] = DEV_WORLDS): Map<string, MemoryQuestion> {
  const key = worlds.join();
  const cached = questionCache.get(key);
  if (cached) return cached;
  const prior = process.env.GBRAIN_EVALS_BG1_WORLD_END;
  process.env.GBRAIN_EVALS_BG1_WORLD_END = DEV_WORLD_END;
  try { questionCache.set(key, new Map(loadCorpus('bg1-dev', undefined, key === DEV_WORLDS.join() ? undefined : new Set(worlds), { keyless: true }).questions.map(q => [q.id, q]))); }
  finally { if (prior === undefined) delete process.env.GBRAIN_EVALS_BG1_WORLD_END; else process.env.GBRAIN_EVALS_BG1_WORLD_END = prior; }
  return questionCache.get(key)!;
}

/** The world list a row is read over: stage 1's three when every world is one of them, the 17 extra when every one is, else all 20. */
export const rowWorlds = (worlds: readonly string[] | undefined): readonly string[] =>
  !worlds || worlds.every(w => (DEV_WORLDS as readonly string[]).includes(w)) ? DEV_WORLDS : worlds.every(w => EXTRA_WORLDS.includes(w)) ? EXTRA_WORLDS : ALL_WORLDS;

/**
 * One row's per-question records from its result roots (a stage 1 unit, or a dev run's world outputs): claude-opus-5-5's
 * replicate-0 answer, its gating grade and the exposure of the context it read, with the settings it read at. Every
 * question of `worlds` gets a record (null when the row has no answer); an answer to another world's question refuses.
 */
export function readRow(roots: string[], system: string, worlds: readonly string[] = DEV_WORLDS): { settings: Record<string, unknown>; gbrainSha: string | null; records: Map<string, QuestionRecord> } {
  const qs = devQuestions(worlds);
  const records = new Map<string, QuestionRecord>();
  let settings: Record<string, unknown> | null = null, gbrainSha: string | null = null;
  const answeredUnder = new Map<string, string>();
  for (const root of roots.flatMap(r => cellRoots(r))) {
    for (const cell of dirsUnder(join(root, 'cells'))) {
      const rc = JSON.parse(readFileSync(join(cell, 'run-config.json'), 'utf8')) as RunConfigLike;
      if (rc.cell?.system !== system) continue;
      const s = readingSettings(rc);
      if (settings && JSON.stringify(settings) !== JSON.stringify(s)) throw new DevLoopRefusal(`${cell} reads at other settings than the rest of its row`);
      settings = s;
      const sha = rc.cell?.launch?.env?.GBRAIN_SHA;
      if (sha && gbrainSha && sha !== gbrainSha) throw new DevLoopRefusal(`${cell} ran gbrain ${sha}, and the rest of its row ran ${gbrainSha}; score one run at a time`);
      gbrainSha = sha ?? gbrainSha;
      const contexts = new Map<string, string>();
      for (const run of dirsUnder(join(root, 'runs'))) for (const c of ndjson<{ key: string; prompt: string }>(join(run, 'contexts.ndjson'))) contexts.set(c.key.split('|')[1], c.prompt);
      const grades = new Map(ndjson<{ answer_id: string; instrument_id: string; score: number | null }>(join(cell, 'judgments.ndjson')).filter(j => j.instrument_id === GATING_INSTRUMENT).map(j => [j.answer_id, j]));
      for (const a of ndjson<{ answer_id: string; question_id: string; reader: string; replicate: number; text?: string | null }>(join(cell, 'answers.ndjson'))) {
        if (a.reader !== DEV_READER || a.replicate !== 0) continue;
        const q = qs.get(a.question_id);
        if (!q) throw new DevLoopRefusal(`${cell} answers ${a.question_id}, which is not a question of this row's dev worlds (${worlds[0]} to ${worlds.at(-1)})`);
        const seen = answeredUnder.get(q.id);
        if (seen !== undefined && seen !== root) throw new DevLoopRefusal(`${q.id} is answered under both ${seen} and ${root}; score one run at a time`);
        answeredUnder.set(q.id, root);
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

/**
 * The comparators' rows on the extra worlds from their comparator runs (run --system), one run per comparator. Each
 * must read at the stage 1 rows' settings, so a score over all 20 worlds compares like with like.
 */
export function buildExtraBaselines(runs: string[], stage1 = loadBaselines()): Baselines {
  const rows: Record<string, BaselineRow> = {};
  for (const dir of runs) {
    const system = (runInfo(dir) as { system?: string } | null)?.system;
    if (!system || !(COMPARATORS as readonly string[]).includes(system)) throw new DevLoopRefusal(`${dir} is not a comparator run (its run.json names no --system ${COMPARATORS.join(' or ')})`);
    if (rows[system]) throw new DevLoopRefusal(`--extra names two ${system} runs`);
    const r = readRow([existsSync(join(dir, 'worlds')) ? join(dir, 'worlds') : dir], system, EXTRA_WORLDS);
    const want = JSON.stringify(stage1.rows[system].settings);
    if (JSON.stringify(r.settings) !== want) throw new DevLoopRefusal(`${dir} reads at ${JSON.stringify(r.settings)}, and ${system}'s stage 1 row at ${want}`);
    rows[system] = { source: `BG1 dev loop comparator run, ${basename(dir)}`, settings: r.settings,
      questions: Object.fromEntries([...r.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(q => [q.id, { score: q.score, gold: q.gold, stale: q.stale }])) };
  }
  const absent = COMPARATORS.filter(c => !rows[c]);
  if (absent.length) throw new DevLoopRefusal(`--extra needs one run for each comparator; ${absent.join(', ')} has none`);
  return { schema: BASELINES_SCHEMA, note: 'claude-opus-5-5 answers on the 17 extra BG1 dev worlds, graded by gpt-6-astra at the pinned judge settings, with exposure from each frozen context (eval/runner/bg1/exposure.ts). Written by bun eval/runner/bg1/dev-loop.ts baselines --extra.',
    world_end: DEV_WORLD_END, reader: DEV_READER, judge: DEV_JUDGE, rows };
}

/** The comparator cache a score reads: stage 1's rows, and the extra worlds' rows once their cache exists. */
export function loadAllBaselines(stage1Path = BASELINES_PATH, extraPath = EXTRA_BASELINES_PATH): Baselines {
  const b = loadBaselines(stage1Path);
  if (!existsSync(extraPath)) return b;
  const x = loadBaselines(extraPath);
  for (const c of COMPARATORS) if (JSON.stringify(x.rows[c].settings) !== JSON.stringify(b.rows[c].settings)) throw new DevLoopRefusal(`${extraPath}'s ${c} row reads at other settings than its stage 1 row`);
  return { ...b, rows: Object.fromEntries(COMPARATORS.map(c => [c, { ...b.rows[c], questions: { ...b.rows[c].questions, ...x.rows[c].questions } }])) };
}

// ─── Scoring ─────────────────────────────────────────────────────────

/** A paired difference in points over the questions both rows graded, its percentile interval and the smallest change it can show. */
export interface Gap { delta: number; ci95: [number, number] | null; n: number; mde: number | null }
export interface ClassScore { label: string; n: number; graded: number; accuracy: number | null; exposure: number | null; comparators: Record<string, { accuracy: number | null; exposure: number | null; gap: Gap | null }>; against?: Gap | null }
export interface Score { run: string; gbrain_ref?: string | null; overlay?: Overlay; against_overlay?: Overlay; gbrain_sha: string | null; questions: number; ungraded: number; classes: ClassScore[] }

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
      const covered = ids.filter(id => mine.get(id)!.score !== null);
      return {
        label: g.label, n: ids.length, graded: covered.length, accuracy: mean(covered.map(id => mine.get(id)!.score!)), exposure: exposureOf(mine, covered),
        comparators: Object.fromEntries(COMPARATORS.map(c => [c, { accuracy: mean(covered.map(id => comps[c].get(id)?.score).filter((x): x is number => typeof x === 'number')), exposure: exposureOf(comps[c], covered), gap: gap(mine, comps[c], ids) }])),
        ...(against ? { against: gap(mine, against, ids) } : {}),
      };
    }),
  };
}

/** The gbrain row of a dev run directory: its pulled world outputs, or the directory itself. */
const gbrainRow = (dir: string) => readRow([existsSync(join(dir, 'worlds')) ? join(dir, 'worlds') : dir], 'gbrain-defaults', rowWorlds(runInfo(dir)?.worlds));

interface RunInfo { gbrain_ref?: string; overlay?: Overlay; worlds?: string[]; world_end?: string; as_of?: string; reader?: string; judge?: string }
const runInfo = (dir: string): RunInfo | null => { const f = join(dir, 'run.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as RunInfo : null; };
const refOf = (dir: string) => runInfo(dir)?.gbrain_ref ?? null;
/** What two runs compared under --against must share: everything in run.json but the gbrain ref, the overlay and the spend window. */
const SAME_RUN_FIELDS = ['worlds', 'world_end', 'as_of', 'reader', 'judge'] as const;

/** A dev run's per-question scores and exposure, in the comparator cache's row shape. */
export function savedRow(dir: string): BaselineRow & { gbrain_ref: string | null; overlay?: Overlay } {
  const row = gbrainRow(dir);
  const overlay = runInfo(dir)?.overlay;
  return { source: `BG1 dev loop, ${basename(dir)}`, gbrain_ref: refOf(dir), ...(overlay ? { overlay } : {}), settings: row.settings, ...(row.gbrainSha ? { gbrain_sha: row.gbrainSha } : {}),
    questions: Object.fromEntries([...row.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(q => [q.id, { score: q.score, gold: q.gold, stale: q.stale }])) };
}

/** A dev run's score, refused when its reading settings, or those of the run it is compared with, differ from the comparators'. */
export function scoreRun(dir: string, opts: { baselines?: Baselines; against?: string; allowRunDiff?: boolean } = {}): Score {
  const b = opts.baselines ?? loadAllBaselines();
  const want = JSON.stringify(b.rows['ext-memory-bank'].settings);
  const check = (where: string, settings: Record<string, unknown>) => { if (JSON.stringify(settings) !== want) throw new DevLoopRefusal(`the run at ${where} reads at ${JSON.stringify(settings)}, and the comparators were read at ${want}`); };
  const row = gbrainRow(dir);
  check(dir, row.settings);
  let against: Map<string, QuestionRecord> | undefined;
  const overlay = runInfo(dir)?.overlay ?? {};
  let againstOverlay: Overlay = {};
  if (opts.against) {
    const other = opts.against.endsWith('.json') ? (JSON.parse(readFileSync(opts.against, 'utf8')) as BaselineRow & { overlay?: Overlay }) : savedRow(opts.against);
    check(opts.against, other.settings);
    againstOverlay = other.overlay ?? {};
    const mine = runInfo(dir), theirs = opts.against.endsWith('.json') ? null : runInfo(opts.against);
    const gradedWorlds = (qs: Array<[string, { score: number | null }]>) => [...new Set(qs.filter(([, q]) => typeof q.score === 'number').map(([id]) => row.records.get(id)?.world ?? id))].sort().join();
    const differs = [...(mine && theirs ? SAME_RUN_FIELDS.filter(k => JSON.stringify(mine[k]) !== JSON.stringify(theirs[k])) : []),
      ...(Object.keys(other.questions).sort().join() !== [...row.records.keys()].sort().join() ? ['questions'] : []),
      ...(gradedWorlds([...row.records]) !== gradedWorlds(Object.entries(other.questions)) ? ['graded worlds'] : [])];
    if (differs.length && !opts.allowRunDiff) throw new DevLoopRefusal(`${dir} and ${opts.against} differ in ${differs.join(', ')}, not only in their overlay and gbrain ref; pass --allow-run-diff to compare them anyway`);
    against = new Map(Object.entries(other.questions).map(([id, q]) => [id, { ...row.records.get(id)!, ...q, answer: null, context: null }]));
  }
  const overlays = Object.keys(overlay).length || Object.keys(againstOverlay).length ? { overlay, ...(opts.against ? { against_overlay: againstOverlay } : {}) } : {};
  return { ...scoreRecords(dir, row.gbrainSha, row.records, b, against), gbrain_ref: refOf(dir), ...overlays };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
const pts = (g: Gap | null | undefined) => (!g ? 'n/a' : `${signed(g.delta)} (${g.ci95 ? `${signed(g.ci95[0])} to ${signed(g.ci95[1])}` : 'no interval'})`);

export function renderScore(s: Score): string {
  const vs = s.classes.some(c => c.against !== undefined);
  const head: string[] = [];
  if (s.overlay) {
    const mine = s.overlay, theirs = s.against_overlay;
    head.push(`Overlay: ${overlaySlug(mine) || 'none (the stage 1 arm as it is)'}${theirs ? `; --against: ${overlaySlug(theirs) || 'none (the stage 1 arm as it is)'}` : ''}.`);
    if (theirs) {
      const keys = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].sort().filter(k => mine[k] !== theirs[k]);
      head.push(keys.length ? `Overlay difference: ${keys.map(k => `${k} ${mine[k] ?? 'arm default'} (this run) against ${theirs[k] ?? 'arm default'} (--against)`).join('; ')}.` : 'Overlay difference: none.', '');
    } else head.push('');
  }
  const lines = [...head, `BG1 dev loop: gbrain ${s.gbrain_ref ? `${s.gbrain_ref} (${s.gbrain_sha})` : s.gbrain_sha ?? '(unknown commit)'} on ${s.questions} dev questions (${s.ungraded} without a gating grade), read by ${DEV_READER} and graded by ${DEV_JUDGE}.`,
    'Accuracy, and exposure: the share of contexts that held every value the answer needs. Gaps are gbrain minus each server in points, with a paired 95% interval over questions.', '',
    `| Class | n | gbrain | exposure | memory-bank | exposure | gap | extract-first | exposure | gap | smallest visible change |${vs ? ' minus --against |' : ''}`,
    `|---|---:|---:|---:|---:|---:|---|---:|---:|---|---:|${vs ? '---|' : ''}`];
  for (const c of s.classes) {
    const mb = c.comparators['ext-memory-bank'], ef = c.comparators['ext-extract-first'];
    const mde = Math.max(mb.gap?.mde ?? 0, ef.gap?.mde ?? 0);
    lines.push(`| ${c.label} | ${c.graded === c.n ? c.n : `${c.graded} of ${c.n}`} | ${pct(c.accuracy)} | ${pct(c.exposure)} | ${pct(mb.accuracy)} | ${pct(mb.exposure)} | ${pts(mb.gap)} | ${pct(ef.accuracy)} | ${pct(ef.exposure)} | ${pts(ef.gap)} | ${mde ? `${mde.toFixed(1)} pts` : 'n/a'} |${vs ? ` ${pts(c.against)} |` : ''}`);
  }
  lines.push('', 'The smallest visible change is the paired difference a two-sided 0.05 test detects with 80% power in that class (the larger of the two comparisons). The intervals cover question sampling within the worlds scored here, not new worlds.');
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
  /** The run's --overlay, when it had one. */
  overlay?: Overlay;
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

/** The comparators' rows beside gbrain's: stage 1's on the three worlds (`stage1`), their comparator runs' on the extra worlds (`extra`). */
function comparatorRecords(opts: { stage1?: string; extra?: string[] }): Record<string, Map<string, QuestionRecord>> | null {
  if (!opts.stage1 && !opts.extra) return null;
  const runOf = (c: string) => opts.extra?.find(d => (runInfo(d) as { system?: string } | null)?.system === c);
  return Object.fromEntries(COMPARATORS.map(c => {
    const extra = runOf(c);
    if (opts.extra && !extra) throw new DevLoopRefusal(`--extra names no ${c} comparator run`);
    return [c, new Map([...(opts.stage1 ? readRow([join(opts.stage1, STAGE1_UNITS[c].dir)], STAGE1_UNITS[c].system).records : []),
      ...(extra ? readRow([existsSync(join(extra, 'worlds')) ? join(extra, 'worlds') : extra], c, EXTRA_WORLDS).records : [])])];
  }));
}

export function whyRows(dir: string, opts: { stage1?: string; extra?: string[]; classes?: readonly Bg1Stratum[] } = {}): WhyRow[] {
  const qs = devQuestions(rowWorlds(runInfo(dir)?.worlds));
  const row = gbrainRow(dir);
  const comps = comparatorRecords(opts);
  const classes = opts.classes ?? WHY_CLASSES;
  const overlay = runInfo(dir)?.overlay;
  return [...row.records.values()].filter(r => classes.includes(r.stratum) && r.score === 0).sort((a, b) => (a.id < b.id ? -1 : 1)).map(r => {
    const q = qs.get(r.id)!;
    const { needed, stale } = neededValues(q, r.context);
    return { id: r.id, world: r.world, stratum: r.stratum, question: q.question, gold: q.answer ?? null, needed, stale_in_context: stale, gbrain: { sha: row.gbrainSha, answer: r.answer, context: r.context, score: r.score },
      ...(comps ? { comparators: Object.fromEntries(COMPARATORS.map(c => { const x = comps[c].get(r.id); return [c, { answer: x?.answer ?? null, context: x?.context ?? null, score: x?.score ?? null, gold_in_context: x?.gold ?? null }]; })) } : {}), ...(overlay ? { overlay } : {}) };
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const sub = argv[0];
  if (sub === 'clock') { console.log(faketimeOffset()); return 0; }
  if (sub === 'cell') {
    const sha = one('--sha'), system = one('--system'), world = one('--world'), out = one('--out'), systemUrl = one('--system-url');
    if (!(sha || system) || !world || !out || !systemUrl) throw new DevLoopRefusal('cell needs --sha (or --system with a comparator), --world, --out and --system-url');
    if (system && !(COMPARATORS as readonly string[]).includes(system)) throw new DevLoopRefusal(`cell --system takes ${COMPARATORS.join(' or ')}, not ${system}`);
    const r = await runDevCell({ sha, system: system as Comparator | undefined, world, out, systemUrl, overlay: parseOverlays(argv) });
    console.log(`${r.cell} ${world}: ${r.status}${r.stopped ? ` (stopped: ${r.stopped})` : ''}; ${r.arms.map(a => `${a.answers} answers, ${a.judgments} judgments`).join('; ')}`);
    return (r.share ? r.share.complete : r.status === 'complete') ? 0 : 4;
  }
  if (sub === 'run') return launch(argv);
  if (sub === 'score') {
    const run = one('--run'), against = one('--against');
    if (!run) throw new DevLoopRefusal('score needs --run <dir>');
    const s = scoreRun(resolve(run), { against: against ? resolve(against) : undefined, allowRunDiff: argv.includes('--allow-run-diff') });
    const save = one('--save');
    if (save) { mkdirSync(dirname(resolve(save)), { recursive: true }); writeFileSync(resolve(save), JSON.stringify(savedRow(resolve(run)), null, 1) + '\n'); }
    console.log(argv.includes('--json') ? JSON.stringify(s, null, 2) : renderScore(s));
    return 0;
  }
  if (sub === 'why') {
    const run = one('--run'), out = one('--out'), stage1 = one('--stage1'), extra = one('--extra');
    if (!run || !out) throw new DevLoopRefusal('why needs --run <dir> and --out <file.jsonl>');
    const slug = overlaySlug(runInfo(resolve(run))?.overlay ?? {});
    if (slug && !basename(out).includes(slug)) throw new DevLoopRefusal(`${run} ran with overlay ${slug}; name the why-rows file so it carries it, e.g. why-rows-${slug}.jsonl`);
    const rows = whyRows(resolve(run), { stage1: stage1 ? resolve(stage1) : undefined, extra: extra?.split(',').map(d => resolve(d)), classes: one('--classes')?.split(',') as Bg1Stratum[] | undefined });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    console.log(`${rows.length} missed questions written to ${out}`);
    return 0;
  }
  if (sub === 'upkeep') {
    const snapshot = one('--snapshot'), out = one('--out');
    if (!snapshot || !out) throw new DevLoopRefusal('upkeep needs --snapshot <tar> and --out <file.ndjson>');
    const runs = upkeepRuns(snapshotServeLog(resolve(snapshot)));
    writeFileSync(resolve(out), runs.map(r => JSON.stringify(r)).join('\n') + (runs.length ? '\n' : ''));
    console.log(`${runs.length} idle upkeep runs written to ${out}`);
    return 0;
  }
  if (sub === 'baselines') {
    const stage1 = one('--stage1'), extra = one('--extra');
    if (!stage1 === !extra) throw new DevLoopRefusal('baselines needs --stage1 <copied stage 1 state dir> or --extra <ext-memory-bank run>,<ext-extract-first run>');
    const out = resolve(one('--out') ?? (extra ? EXTRA_BASELINES_PATH : BASELINES_PATH));
    mkdirSync(dirname(out), { recursive: true });
    const text = JSON.stringify(extra ? buildExtraBaselines(extra.split(',').map(d => resolve(d))) : buildBaselines(resolve(stage1!)), null, 1) + '\n';
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

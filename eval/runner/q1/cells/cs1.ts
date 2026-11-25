/**
 * Cost and speed cell definitions (docs/benchmarks/2026-11-24-cost-speed-preregistration.md, "Systems", "Readers and the
 * answer key", "Workload data", "Pilot (R111)" and "Plan and machines (R111)", with its amendments), built with BG1-C's
 * tooling (definitions.ts makeCell and definitionProblems), so a cost-and-speed cell is a Q1 cell definition the same
 * runner executes (`bun eval/runner/q1/cell.ts run --cell <id> --manifest cs1`).
 *
 *   Counted (set and block CS1): the eight run rows of the Systems table on public dev worlds bg1-dev-01 to -10, each
 *     world written session by session, 20 seeded questions a world (seed cost-speed-1) for every system and reader.
 *   Pilot (set and block CS1-pilot, R111): the same rows on bg1-dev-11, writing only its first 60 sessions (40 as the
 *     bulk import, the last 20 held back as probes), 4 seeded questions a reader; baseline-none and
 *     baseline-full-context write nothing, so their pilot reads the 4 questions, full context over the whole world.
 *   Capacity (set and block CS1-capacity): every row that writes, on bg1-dev-12 written whole, at the counted settings,
 *     with every provider call answered by the keyless fake upstream; it spends nothing.
 *
 * Rows: gbrain-defaults at gbrain's newest release at launch (CS1_GBRAIN_BUILD, pinned in the launch the way BG1-C pins
 * its build) with its shipped defaults (configuration shipped-defaults: no F6 build, idle upkeep left on, starter
 * surface); the extract-first, memory-bank and verbatim-session servers at their pinned bundles in the vendor's own
 * configuration (recipe), the memory-bank server launched from its observations bundle (bootstrap.sh --config
 * observations) so its background consolidation runs as the server ships it; hybrid search; the file agent in process,
 * where each reader runs the agent; the no-memory floor; and the whole history read per reader (full context). Each arm
 * is the system's shipped read (native-default, policy vendor-default) at its own default amount, or the agent or the
 * whole history, read by claude-opus-5-5 and particle-1 at effort medium (BG1-C's reader settings; particle-1 at its
 * 16,000-token output floor, cell.ts readerMaxTokens).
 *
 * No model judges any answer (scoring key-match, descriptive_view false, no frontier judges): answers are scored after
 * the run by eval/runner/bg1/match.ts.
 *
 * Probes: every cell of a system that writes something searchable (the gbrain shim, the three servers, hybrid search and
 * the file agent, whose probe is a fixed-string grep over its tree with no model call) holds the last sessions of each
 * world back as counted write-to-queryable probes and samples bulk-import probes from the rest (CS1: 19 sampled plus the
 * bulk import's last session make the 20 bulk-import probes, 21 held back; pilot: 20 held back of its first 60
 * sessions). The no-memory floor and full context write nothing to search, so they carry no probes.
 *
 * Idle window and hosting: every writing row's counted cell names the same two seeded CS1 worlds (CS1_IDLE_WORLDS) for
 * its idle window, lasting one cycle of the system's longest scheduled background job held between 30 minutes and 2
 * hours (CS1_IDLE_JOBS lists each system's jobs, cadences and sources); every cell samples hosting.
 *
 * Money: the plan table's rates (CS1_PLAN): write and background dollars per million ingested tokens, the answer
 * model's input per question in cl100k tokens (the reader's tokens per cl100k token and prompt overhead from the reader
 * token model) and its mean output, each reader at the ledger's list price; the file agent at its tokens per answer and
 * full context at a cached whole-world read per reader. Machine hours per world are the plan's, plus amendment 2's 20
 * minutes per held-back probe and the idle window; a counted cell runs in as many launch units as keep each unit's VM
 * within 72 hours. Leases are BG1-C's: a unit's largest share with the lease margin, plus twice its largest reservation.
 *
 * `bun eval/runner/q1/cells/cs1.ts` regenerates cs1-cells.json; a test fails when the committed file is stale.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_PRICE_OVERRIDES, reservationUsd } from '../../budget-ledger.ts';
import { DEFAULT_ROUTE_CAPS } from '../../metering-proxy.ts';
import type { Conversation, MemoryQuestion, Session } from '../../memory-qa/corpus.ts';
import { checkFit, READER_WINDOWS, type FitCheck, type FitTokenizer } from '../../systems/baselines.ts';
import { packContext } from '../../systems/render-v2.ts';
import type { Item } from '../../systems/types.ts';
import {
  ALL_SETS, ASSUMPTIONS, CELL_VM_MAX_HOURS, cellVmHours, CS1_SETS, F6_ASSUMPTIONS, makeCell, MANIFEST_SCHEMA, priceOf, readerTokens,
  type ArmSpec, type BlockId, type CellDefinition, type CellEstimate, type CS1BlockId, type CS1SetId, type Manifest,
} from './definitions.ts';
import { listPrice, OPUS, PARTICLE } from './bg1.ts';

export const CS1_MANIFEST_PATH = resolve(import.meta.dir, 'cs1-cells.json');
export const CS1_PREREGISTRATION = 'docs/benchmarks/2026-11-24-cost-speed-preregistration.md';
export const CS1_REGISTRY = 'docs/benchmarks/preregistrations.d/cost-speed-personal.json';
/** The campaign id every cost-and-speed campaign carries (shootout-cell.ts Q1_CAMPAIGN_ID). */
export const CS1_CAMPAIGN = 'q1-scoreboard-cost-speed';
/** The seed of every seeded choice: the questions, the probes and the idle worlds. */
export const CS1_SEED = 'cost-speed-1';
/** Both readers, on every row. */
export const CS1_READERS = [OPUS, PARTICLE] as const;
/** The effort every reader and agent sends, as BG1-C fixed it for every reader. */
export const CS1_EFFORT = 'medium';
/**
 * gbrain's build on every cost-and-speed gbrain cell: the newest release tag on gbrain's master when the cells were
 * built, the preregistration's build at registration (v0.60.769.0, read with git ls-remote --tags on 2026-11-24), re-pinned
 * by the dated freeze amendment to v0.60.771.0 (read the same way on 2026-11-25 UTC, before any counted gbrain cell). A newer
 * release before the first counted gbrain cell re-pins here by a dated amendment; the build freezes once it starts.
 */
export const CS1_GBRAIN_BUILD = { release: 'v0.60.771.0', commit: '97ef356f574a66709ef1bf4ae1cad604727852d8' } as const;

/**
 * Hosting's price ladders (preregistration, "Hosting"): the primary is one public cloud's general-purpose family, the
 * sensitivity row a second family, both on-demand Linux in one region with block storage at that provider's price.
 * Read from the providers' public price lists on `read_at` and fixed in the freeze amendment.
 */
export const CS1_PRICE_LADDERS = {
  primary: {
    provider: 'AWS EC2 m7i on demand, us-east-1, Linux; EBS gp3', read_at: '2026-11-25',
    instances: [
      { name: 'm7i.large', memory_gib: 8, usd_per_hour: 0.1008 }, { name: 'm7i.xlarge', memory_gib: 16, usd_per_hour: 0.2016 },
      { name: 'm7i.2xlarge', memory_gib: 32, usd_per_hour: 0.4032 }, { name: 'm7i.4xlarge', memory_gib: 64, usd_per_hour: 0.8064 },
      { name: 'm7i.8xlarge', memory_gib: 128, usd_per_hour: 1.6128 },
    ],
    storage_usd_per_gb_month: 0.08,
  },
  sensitivity: {
    provider: 'AWS EC2 m7g (Graviton) on demand, us-east-1, Linux; EBS gp3', read_at: '2026-11-25',
    instances: [
      { name: 'm7g.medium', memory_gib: 4, usd_per_hour: 0.0408 }, { name: 'm7g.large', memory_gib: 8, usd_per_hour: 0.0816 },
      { name: 'm7g.xlarge', memory_gib: 16, usd_per_hour: 0.1632 }, { name: 'm7g.2xlarge', memory_gib: 32, usd_per_hour: 0.3264 },
      { name: 'm7g.4xlarge', memory_gib: 64, usd_per_hour: 0.6528 }, { name: 'm7g.8xlarge', memory_gib: 128, usd_per_hour: 1.3056 },
    ],
    storage_usd_per_gb_month: 0.08,
  },
} as const;
/**
 * How every cost-and-speed gbrain cell starts: the gbrain-defaults image built at CS1_GBRAIN_BUILD on Bun 1.4.4 (the
 * release's engines floor, F6's image), with gbrain's shipped defaults: no F6 build (GBRAIN_F6 unset) and serve's idle
 * upkeep on (GBRAIN_IDLE_UPKEEP unset), as gbrain ships them.
 */
export const CS1_GBRAIN_LAUNCH: NonNullable<CellDefinition['launch']> = { env: { GBRAIN_BUN_IMAGE: F6_ASSUMPTIONS.bun_image, GBRAIN_SHA: CS1_GBRAIN_BUILD.commit }, config: 'recipe' };
/** The memory-bank server with observations on: its own bundle (docs/comparison-systems/ext-memory-bank/observations), so the pinned bundle's files and hash stay as they are. */
export const CS1_MEMORY_BANK_LAUNCH: NonNullable<CellDefinition['launch']> = { env: {}, config: 'observations' };
/**
 * The extract-first server with its searches embedding through its metering slot's read route: its own bundle
 * (docs/comparison-systems/ext-extract-first/read-route; eval/runner/metering-proxy.ts READ_ROUTE_SUFFIX), so the pinned
 * bundle's files and hash stay as they are. Each search also embeds the query's entities, a text the probe label can't
 * match, so the keyless label check failed without it. Same model and requests.
 */
export const CS1_EXTRACT_FIRST_LAUNCH: NonNullable<CellDefinition['launch']> = { env: {}, config: 'read-route' };

/**
 * The plan table ("Plan and machines (R111)"), by row: write and background dollars per million ingested tokens, the
 * answer model's input per question in cl100k tokens (the file agent's over its turns, in reader tokens; null for full
 * context, which reads the whole world) and machine hours per world (probes, both readers' questions and the idle
 * window's share as the plan counts them).
 */
export const CS1_PLAN: Readonly<Record<string, { write_usd_per_mtok: number; answer_input_tokens: number | null; hours_per_world: number }>> = {
  'gbrain-defaults': { write_usd_per_mtok: 0.11, answer_input_tokens: 5_100, hours_per_world: 2 },
  'ext-extract-first': { write_usd_per_mtok: 70.1, answer_input_tokens: 1_000, hours_per_world: 20 },
  'ext-memory-bank': { write_usd_per_mtok: 9.06, answer_input_tokens: 9_550, hours_per_world: 2 },
  'ext-verbatim-session': { write_usd_per_mtok: 0, answer_input_tokens: 15_900, hours_per_world: 1.5 },
  'baseline-hybrid': { write_usd_per_mtok: 0.14, answer_input_tokens: 14_550, hours_per_world: 1 },
  'baseline-file-agent': { write_usd_per_mtok: 0, answer_input_tokens: 73_000, hours_per_world: 1.5 },
  'baseline-none': { write_usd_per_mtok: 0, answer_input_tokens: 0, hours_per_world: 0.5 },
  'baseline-full-context': { write_usd_per_mtok: 0, answer_input_tokens: null, hours_per_world: 0.5 },
};
/** The file agent's output tokens per answer over its turns (ASSUMPTIONS.agent, the S2b line its input comes from). */
export const CS1_FILE_AGENT_OUTPUT_TOKENS = ASSUMPTIONS.agent['baseline-file-agent'].output as number;
/** Amendment 2: each held-back probe may take up to 20 minutes of probe and idle check. */
export const CS1_PROBE_HOURS = 20 / 60;

/** The rows, in the Systems table's order: each system, its configuration and the mode of its one arm. */
export const CS1_ROWS = [
  { system: 'gbrain-defaults', configuration: 'shipped-defaults', mode: 'native-default' },
  { system: 'ext-extract-first', configuration: 'recipe', mode: 'native-default' },
  { system: 'ext-memory-bank', configuration: 'recipe', mode: 'native-default' },
  { system: 'ext-verbatim-session', configuration: 'recipe', mode: 'native-default' },
  { system: 'baseline-hybrid', configuration: 'baseline', mode: 'native-default' },
  { system: 'baseline-file-agent', configuration: 'baseline', mode: 'agent' },
  { system: 'baseline-none', configuration: 'baseline', mode: 'native-default' },
  { system: 'baseline-full-context', configuration: 'baseline', mode: 'full-context' },
] as const;
/** The rows that write nothing to search: no probes, no capacity check, no idle window and no ingest prefix on the pilot. */
export const CS1_WRITES_NOTHING = ['baseline-none', 'baseline-full-context'];

/** Probes per set: 19 sampled plus the bulk import's last session and 21 held back on a counted world; the pilot holds back 20 of its 60 sessions. */
const PROBES: Record<CS1SetId, { sample: number; held_back: number }> = { CS1: { sample: 19, held_back: 21 }, 'CS1-pilot': { sample: 19, held_back: 20 }, 'CS1-capacity': { sample: 19, held_back: 21 } };
/** The pilot writes the first 60 sessions of bg1-dev-11. */
export const CS1_PILOT_SESSIONS = 60;
/** cl100k_base tokens of bg1-dev-11's first 60 sessions, counted from its world file as CS1_SETS counts whole worlds. */
export const CS1_PILOT_TOKENS = 75_912;
/** The largest counted world's tokens (bg1-dev-03), over CS1's mean, sizes a unit's largest share. */
export const CS1_LARGEST_WORLD_TOKENS = 182_251;

const IDLE_MIN_MS = 30 * 60_000;
const IDLE_MAX_MS = 2 * 60 * 60_000;
/** A job whose cadence is longer than the window names its documented trigger, run once before the window and priced per run. */
type IdleJob = { job: string; cadence_minutes: number | null; source: string; trigger?: string };
/**
 * Each writing row's background jobs with their shipped cadence (minutes; null for work set off by a write rather than
 * a schedule), as read before the freeze:
 *   - gbrain v0.60.771.0: a stdio serve with no input for a full 10-minute tick runs its idle sweep and, from it, idle
 *     upkeep, whose round is due again a day after it finishes and runs in 3-second slices; the facts drain timer runs
 *     queued fact extraction every 10 minutes; the autopilot daemon (every 5 minutes, documented for a Postgres brain
 *     with a repo) is not started, because the shim installs with --no-autopilot-install on PGLite. The daily round is
 *     longer than the 2-hour window, so it is priced per run through gbrain's documented trigger.
 *   - the memory-bank server: observation consolidation runs after each retain, on its worker, with no schedule.
 *   - the extract-first server: its per-namespace worker extracts after /ingest returns, with no schedule.
 *   - the verbatim-session server, hybrid search and the file agent: no background work.
 */
export const CS1_IDLE_JOBS: Readonly<Record<string, readonly IdleJob[]>> = {
  'gbrain-defaults': [
    { job: 'serve idle tick: idle sweep, then idle upkeep when due (a stdio serve with no input for a full tick)', cadence_minutes: 10, source: 'gbrain v0.60.771.0 src/commands/serve.ts IDLE_SWEEP_INTERVAL_MS, src/core/maintenance/idle.ts; eval/systems/gbrain-defaults/shim.py docstring' },
    { job: 'idle upkeep round (link and timeline extraction, repair lanes, bookkeeping GC, the capped embedding step), due a day after the last round finished, run in 3-second slices on the idle tick; priced per run through gbrain maintain --unattended', cadence_minutes: 1440, source: 'gbrain v0.60.771.0 src/core/maintenance/run.ts UPKEEP_INTERVAL_MS, src/core/maintenance/idle.ts IDLE_UPKEEP_BUDGET_MS, src/commands/maintain-schedule.ts SCHEDULED_RUN_ARGS', trigger: 'maintain' },
    { job: 'facts drain timer: queued facts-absorb extraction jobs', cadence_minutes: 10, source: 'gbrain v0.60.771.0 src/core/facts/drain-scheduler.ts FACTS_DRAIN_TICK_MS' },
    { job: 'autopilot daemon cycle (every 5 minutes when installed): not started, because the shim installs with --no-autopilot-install and gbrain documents autopilot for a Postgres brain with a repo, while this brain is PGLite', cadence_minutes: null, source: 'gbrain v0.60.771.0 src/commands/autopilot.ts (default --interval 300), docs/guides/cron-schedule.md; eval/systems/gbrain-defaults/shim.py apply-migrations' },
  ],
  'ext-extract-first': [
    { job: 'per-namespace ingest worker: one Memory.add per chunk after /ingest returns; no scheduled job', cadence_minutes: null, source: 'docs/comparison-systems/ext-extract-first/README.md (/ingest), shim.py' },
  ],
  'ext-memory-bank': [
    { job: 'observation consolidation on the server worker after each retain; no scheduled job', cadence_minutes: null, source: 'the vendor\'s observations guide (How Consolidation Works); docs/comparison-systems/ext-memory-bank/README.md' },
  ],
  'ext-verbatim-session': [
    { job: 'none: the local embedder indexes each session inside its write', cadence_minutes: null, source: 'docs/comparison-systems/ext-verbatim-session/README.md (/ingest)' },
  ],
  'baseline-hybrid': [
    { job: 'none: sessions are embedded and written in buffers during the write and at finish', cadence_minutes: null, source: 'eval/runner/systems/baselines.ts PlainHybridSystem' },
  ],
  'baseline-file-agent': [
    { job: 'none: the write is a Markdown file', cadence_minutes: null, source: 'eval/runner/systems/file-agent.ts' },
  ],
};
const idleKey = (world: string) => createHash('sha256').update(`${CS1_SEED}|idle|${world}`).digest('hex');
/** The two counted worlds every writing row's idle window runs on: CS1's worlds in sha256(seed|idle|world) order, the first two, so every system idles on the same worlds. */
export const CS1_IDLE_WORLDS: readonly string[] = [...CS1_SETS.CS1.only_conversations!].sort((a, b) => (idleKey(a) < idleKey(b) ? -1 : 1)).slice(0, 2).sort();

/** A system's idle window: one cycle of its longest scheduled job held between 30 minutes and 2 hours, or 30 minutes when nothing is scheduled. */
export function cs1IdleWindow(system: string): NonNullable<CellDefinition['idle_window']> {
  const jobs = CS1_IDLE_JOBS[system];
  if (!jobs) throw new Error(`cost and speed lists no background jobs for ${system} (CS1_IDLE_JOBS)`);
  const longest = Math.max(0, ...jobs.map(j => j.cadence_minutes ?? 0)) * 60_000;
  return { worlds: [...CS1_IDLE_WORLDS], ms: Math.min(IDLE_MAX_MS, Math.max(IDLE_MIN_MS, longest)), min_ms: IDLE_MIN_MS, max_ms: IDLE_MAX_MS, jobs: jobs.map(j => ({ ...j })) };
}

const round = (x: number) => Math.round(x * 100) / 100;
const estimateOf = (lines: Record<string, number>): CellEstimate => ({
  usd: round(Object.values(lines).reduce((s, v) => s + v, 0)),
  lines: Object.fromEntries(Object.entries(lines).filter(([, v]) => v > 0).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, round(v)])),
});
const listUsd = (model: string, input: number, output: number) => { const p = priceOf(model); return (input * p.input + output * p.output) / 1e6; };
/** A reader's output route cap at the lease proxy (particle-1's is its output floor). */
const readerCap = (r: string) => DEFAULT_ROUTE_CAPS[`reader@${r}`] ?? DEFAULT_ROUTE_CAPS.reader;
/** Whether a whole world of `cl100k` tokens fits a reader's input limit with its prompt overhead and output cap. */
const fitsWhole = (reader: string, cl100k: number) => cl100k * readerTokens('reader_tokens_per_cl100k', reader) + readerTokens('reader_input_overhead_tokens', reader) + readerCap(reader) <= READER_WINDOWS[reader].max_input_tokens;

/**
 * A cell's estimate: write and background at the plan's rate over the tokens it writes (none on the keyless capacity
 * check), and each reader's answers: the system's default read (the plan's input per question at the reader's tokens
 * per cl100k token, plus its prompt overhead and mean output), the file agent's turns, or the whole world written to
 * the prompt cache once and read from it by the world's later questions, priced only where it fits.
 */
export function cs1Estimate(def: Pick<CellDefinition, 'set' | 'system'>): CellEstimate {
  const s = ALL_SETS[def.set], plan = CS1_PLAN[def.system];
  if (!plan) throw new Error(`cost and speed has no planned rate for ${def.system} (CS1_PLAN)`);
  if (def.set === 'CS1-capacity') return estimateOf({});
  const tokens = def.set === 'CS1-pilot' ? CS1_PILOT_TOKENS : s.corpus_tokens;
  const perWorld = s.questions / s.conversations, worldTokens = s.corpus_tokens / s.conversations;
  const reads = (r: string) => {
    const overhead = readerTokens('reader_input_overhead_tokens', r), out = readerTokens('reader_output_tokens', r);
    if (def.system === 'baseline-file-agent') return s.questions * listUsd(r, plan.answer_input_tokens!, CS1_FILE_AGENT_OUTPUT_TOKENS);
    if (plan.answer_input_tokens !== null) return s.questions * listUsd(r, plan.answer_input_tokens * readerTokens('reader_tokens_per_cl100k', r) + overhead, out);
    if (!fitsWhole(r, worldTokens)) return 0;
    const p = priceOf(r), history = worldTokens * readerTokens('reader_tokens_per_cl100k', r);
    return s.conversations * ((history * (p.cache_write ?? p.input) + Math.max(0, perWorld - 1) * history * (p.cache_read ?? p.input)) / 1e6 + perWorld * listUsd(r, overhead, out));
  };
  const line = def.system === 'baseline-file-agent' ? 'agent' : def.system === 'baseline-full-context' ? 'full_context' : 'readers';
  return estimateOf({ write_background: plan.write_usd_per_mtok * tokens / 1e6, [line]: CS1_READERS.reduce((n, r) => n + reads(r), 0) });
}

/**
 * The largest single reservation a unit's lease proxy holds at once (metering-proxy.ts: input at the request's bytes +
 * 64 tokens, output at the route cap; budget-ledger reservationUsd): one reader's read of the system's default amount,
 * the file agent's first turns (one per reader at once), or a read of the largest world whole at the cache-write rate,
 * beside the system's own extraction call where it makes one.
 */
export function cs1PeakReservation(c: Pick<CellDefinition, 'set' | 'system'>): { usd: number; by: string } {
  const L = F6_ASSUMPTIONS.lease, s = ALL_SETS[c.set], plan = CS1_PLAN[c.system];
  const one = (model: string, inputBytes: number, maxOut: number, cacheWritePremium = false) =>
    reservationUsd({ provider: model.split(':')[0], model: model.slice(model.indexOf(':') + 1), kind: 'chat', ...(CHAT_PRICE_OVERRIDES[model] ?? priceOf(model)), inputTokens: inputBytes + 64, maxOutputTokens: maxOut, cacheWritePremium });
  const largest = c.set === 'CS1' ? CS1_LARGEST_WORLD_TOKENS : s.corpus_tokens / s.conversations;
  const calls: Array<[string, number]> = c.system === 'baseline-file-agent'
    ? [[`file agent: one first turn per reader at once (${CS1_READERS.length})`, CS1_READERS.reduce((n, r) => n + (F6_ASSUMPTIONS.agent_first_turn_usd[r] ?? F6_ASSUMPTIONS.agent_first_turn_usd.default), 0)]]
    : CS1_READERS.map((r): [string, number] => plan.answer_input_tokens === null
      ? [`whole-world read by ${r}`, fitsWhole(r, largest) ? one(r, Math.ceil(largest * L.bytes_per_token) + L.template_bytes, readerCap(r), true) : 0]
      : [`reader ${r}`, one(r, Math.ceil(plan.answer_input_tokens * L.bytes_per_token) + L.template_bytes, readerCap(r))]);
  const extraction: Record<string, string> = { 'gbrain-defaults': F6_ASSUMPTIONS.extraction.model, 'ext-extract-first': 'openai:gpt-5-mini', 'ext-memory-bank': 'openai:gpt-4o-mini' };
  if (extraction[c.system]) calls.push([`extraction ${extraction[c.system]}`, one(extraction[c.system], 64_000, DEFAULT_ROUTE_CAPS.extraction)]);
  const [by, usd] = calls.sort((a, b) => b[1] - a[1])[0];
  return { usd: Math.round(usd * 10_000) / 10_000, by };
}

/**
 * A unit's expected hours and the units a cell runs as: each world takes the plan's hours (the pilot's share of them
 * for the sessions it writes) plus 20 minutes per held-back probe, and a unit holding an idle world adds its window. A
 * cell takes the most worlds a unit can hold while its VM (cellVmHours) stays within CELL_VM_MAX_HOURS, both idle worlds
 * counted in it; the runner deals worlds to units round-robin (--shard i/n).
 */
export function cs1Units(def: Pick<CellDefinition, 'set' | 'system' | 'probes' | 'idle_window'>): { shards: number; hours: number; worlds: number } {
  const s = ALL_SETS[def.set], plan = CS1_PLAN[def.system];
  const share = def.set === 'CS1-pilot' && !CS1_WRITES_NOTHING.includes(def.system) ? CS1_PILOT_SESSIONS / s.sessions! : 1;
  const perWorld = plan.hours_per_world * share + (def.probes.held_back ?? 0) * CS1_PROBE_HOURS;
  const idle = def.idle_window ? def.idle_window.ms / 3_600_000 : 0;
  const unitHours = (k: number) => Math.ceil(k * perWorld + Math.min(k, def.idle_window?.worlds.length ?? 0) * idle);
  let k = s.conversations;
  while (k > 1 && cellVmHours(unitHours(k)) > CELL_VM_MAX_HOURS) k--;
  const shards = Math.ceil(s.conversations / k), worlds = Math.ceil(s.conversations / shards);
  return { shards, worlds, hours: Math.max(1, unitHours(worlds)) };
}

/**
 * A unit's lease (BG1-C's rule): its largest share of the cell's estimate (the most worlds a unit holds, a counted
 * unit's at the largest world over the mean) with F6's lease margin, plus twice its largest reservation. A capacity
 * unit spends nothing, but its lease proxy still prices the fake upstream's usage fields, so it takes one counted
 * world's lease.
 */
export function cs1Lease(c: CellDefinition, worlds: number): CellDefinition {
  const L = F6_ASSUMPTIONS.lease, capacity = c.set === 'CS1-capacity';
  const priced = capacity ? { set: 'CS1' as const, system: c.system } : c;
  const n = capacity ? 1 : worlds, s = ALL_SETS[priced.set];
  const peak = cs1PeakReservation(priced);
  const ratio = priced.set === 'CS1' ? CS1_LARGEST_WORLD_TOKENS / (s.corpus_tokens / s.conversations) : 1;
  const largest = cs1Estimate(priced).usd * n / s.conversations * ratio;
  const what = capacity ? 'keyless capacity check, leased as one counted world because its lease proxy prices the fake upstream\'s usage fields' : 'cost and speed';
  return { ...c, lease: { usd: Math.ceil((largest * L.margin + 2 * peak.usd) * 100) / 100, basis: `${what}: the largest unit's share ($${largest.toFixed(2)}, ${n} world${n === 1 ? '' : 's'}${ratio > 1 ? ` at ${ratio.toFixed(4)} times the mean world` : ''}) x ${L.margin} plus twice the peak reservation ($${peak.usd}, ${peak.by})` } };
}

/** One row's arm: the shipped read at the system's own default amount, the file agent with each reader as the agent, or the whole history. */
const armOf = (mode: (typeof CS1_ROWS)[number]['mode']): ArmSpec => (mode === 'agent'
  ? { id: 'whole-agent', mode, label: 'file agent, uncapped grep, 40 turns, each reader as the agent', readers: [...CS1_READERS] }
  : mode === 'full-context' ? { id: 'whole-full-context', mode, label: 'whole history, read whole by each reader with prompt caching', readers: [...CS1_READERS] }
  : { id: 'whole-default', mode, label: 'shipped read, own default amount', readers: [...CS1_READERS] });

/** One cell: a row on one of cost and speed's sets, with its probes, ingest prefix, idle window, hosting samples and key-match scoring. */
function cell(set: CS1SetId, row: (typeof CS1_ROWS)[number]): CellDefinition {
  const { system, configuration, mode } = row;
  const writes = !CS1_WRITES_NOTHING.includes(system);
  const made = makeCell(set, system, configuration, [armOf(mode)], {
    probes: writes ? { sample: PROBES[set].sample, seed: CS1_SEED, held_back: PROBES[set].held_back } : { sample: 0, seed: CS1_SEED, conversations: 0 },
    descriptiveView: false,
    ...(system === 'baseline-file-agent' ? { runner: 'in-process' as const } : {}),
    ...(system === 'gbrain-defaults' ? { launch: CS1_GBRAIN_LAUNCH } : system === 'ext-memory-bank' ? { launch: CS1_MEMORY_BANK_LAUNCH } : system === 'ext-extract-first' ? { launch: CS1_EXTRACT_FIRST_LAUNCH } : {}),
  });
  const def: CellDefinition = {
    ...made, effort: CS1_EFFORT, scoring: 'key-match',
    ...(set === 'CS1-pilot' && writes ? { ingest_sessions: CS1_PILOT_SESSIONS } : {}),
    ...(set === 'CS1' && writes ? { idle_window: cs1IdleWindow(system) } : {}),
    ...(set === 'CS1-pilot' && writes ? { idle_window: { ...cs1IdleWindow(system), worlds: [...ALL_SETS['CS1-pilot'].only_conversations!] } } : {}),
    hosting_samples: true,
    ...(system === 'gbrain-defaults' ? { gbrain_build: { ...CS1_GBRAIN_BUILD } } : {}),
  };
  const units = cs1Units(def);
  return cs1Lease({ ...def, shards: units.shards, expected_hours: units.hours, estimate: cs1Estimate(def) }, units.worlds);
}

/** The counted cells: the eight run rows on the ten counted worlds. */
export const generateCS1Cells = (): CellDefinition[] => CS1_ROWS.map(r => cell('CS1', r));
/** The pilot (R111): the eight rows on bg1-dev-11. */
export const generateCS1PilotCells = (): CellDefinition[] => CS1_ROWS.map(r => cell('CS1-pilot', r));
/** The keyless capacity check: every row that writes, on bg1-dev-12 written whole. */
export const generateCS1CapacityCells = (): CellDefinition[] => CS1_ROWS.filter(r => !CS1_WRITES_NOTHING.includes(r.system)).map(r => cell('CS1-capacity', r));

/** A reading profile ("Workload profile"): messages written and questions asked a month, and the one-year history the month is priced against. */
export const CS1_PROFILES = {
  heavy: { messages_per_month: 2_000, questions_per_month: 300, history_messages: 24_000 },
  light: { messages_per_month: 215, questions_per_month: 32, history_messages: 2_580 },
} as const;
export type CS1Profile = keyof typeof CS1_PROFILES;

/** The one-year fit check's result: the reader's fit check on the profile's one-year prompt, and the history it renders. */
export interface CS1FitCheck extends FitCheck { profile: CS1Profile; sessions: number; messages: number }

/**
 * The full-context row's one-year fit check ("Systems", baseline-full-context): the profile's one-year history built
 * from `world`'s sessions in order, repeated from the first as often as it takes to reach the profile's message count
 * (each repeat's session ids suffixed so none repeats), rendered the way a whole-world read renders it (packContext
 * rehydrated, every session, no budget) for `question`, then checked against the reader's input limit (checkFit) with
 * the tokenizer and output limit the cell runner gives that reader (cell.ts readerFitTokenizer and readerMaxTokens). A
 * profile and reader whose prompt doesn't fit is reported as "doesn't fit", not priced.
 */
export function cs1FullContextFit(world: Conversation, question: MemoryQuestion, profile: CS1Profile, reader: string, opts: { tokenizer: FitTokenizer; outputTokens: number }): CS1FitCheck {
  const target = CS1_PROFILES[profile].history_messages;
  const sessions: Session[] = [];
  let messages = 0;
  for (let i = 0; messages < target; i++) {
    const s = world.sessions[i % world.sessions.length], copy = Math.floor(i / world.sessions.length);
    sessions.push(copy ? { ...s, id: `${s.id}~${copy}` } : s);
    messages += s.turns.length;
  }
  const byId = new Map(sessions.map(s => [s.id, s]));
  const items: Item[] = [...sessions].reverse().map((s, i) => ({ id: s.id, rank: i + 1, type: 'episode', text: '', source_ids: [s.id], valid_from: s.date ?? null, valid_to: null, provenance_status: 'exact' }));
  const pack = packContext('rehydrated', question, items, { budgetTokens: null, sessionOf: id => byId.get(id) });
  return { ...checkFit(reader, pack.prompt, opts.outputTokens, opts.tokenizer), profile, sessions: sessions.length, messages };
}

/** One model the cells call, with its role, as the registry entry lists them (CS1_REGISTRY `models`). */
export interface CS1Model { model: string; role: 'reader' | 'system-internal' | 'embedder'; system?: string }
/**
 * Every model the cells call: the two readers; each compared system's shipped models as system-internal (gbrain's
 * Voyage embeddings and reranker and its Claude Haiku 5.5 fact extraction, the extract-first server's gpt-5-mini and
 * text-embedding-3-small, the memory-bank server's gpt-4o-mini, tested as shipped); and hybrid search's
 * text-embedding-3-large, the embedder this repository configures. No judge.
 */
export const CS1_MODELS: readonly CS1Model[] = [
  ...CS1_READERS.map(model => ({ model, role: 'reader' as const })),
  { model: 'voyage:voyage-4', role: 'system-internal', system: 'gbrain-defaults' },
  { model: 'voyage:rerank-3-lite', role: 'system-internal', system: 'gbrain-defaults' },
  { model: F6_ASSUMPTIONS.extraction.model, role: 'system-internal', system: 'gbrain-defaults' },
  { model: 'openai:gpt-5-mini', role: 'system-internal', system: 'ext-extract-first' },
  { model: 'openai:text-embedding-3-small', role: 'system-internal', system: 'ext-extract-first' },
  { model: 'openai:gpt-4o-mini', role: 'system-internal', system: 'ext-memory-bank' },
  { model: 'openai:text-embedding-3-large', role: 'embedder', system: 'baseline-hybrid' },
];

const CS1_BLOCKS: Record<CS1BlockId, string> = {
  CS1: 'cost and speed counted cells: the eight rows on public dev worlds bg1-dev-01 to bg1-dev-10',
  'CS1-pilot': 'cost and speed pilot (R111): the eight rows on bg1-dev-11, its first 60 sessions written',
  'CS1-capacity': 'cost and speed keyless capacity check: every row that writes, on bg1-dev-12 against the fake upstream',
};

export interface CS1Manifest extends Manifest {
  campaign_id: string; registry: string; gbrain_build: typeof CS1_GBRAIN_BUILD; seed: string;
  models: CS1Model[]; plan: typeof CS1_PLAN; profiles: typeof CS1_PROFILES; idle_worlds: string[];
  /** Launch unit ids by block: the counted units, the pilot's and the capacity check's (the last two are the manifest's addon_cells). */
  units: Record<CS1BlockId, string[]>;
}

/**
 * The manifest: the counted cells, and the pilot and capacity cells as addon_cells (outside the counted total, run only
 * by a campaign that names their units, each at its own lease). The counted block stops at the larger of 1.5 times its
 * estimate and its units' leases; the pilot and capacity blocks at their units' leases.
 */
export function buildCS1Manifest(): CS1Manifest {
  const cells = generateCS1Cells(), pilot = generateCS1PilotCells(), capacity = generateCS1CapacityCells();
  const all = [...cells, ...pilot, ...capacity];
  const unitIds = (cs: CellDefinition[]) => cs.flatMap(c => (c.shards > 1 ? Array.from({ length: c.shards }, (_, i) => `${c.id}.c${i}`) : [c.id]));
  const leases = (id: CS1BlockId) => round(all.filter(c => c.block === id).reduce((s, c) => s + c.lease!.usd * c.shards, 0));
  const estimate = (id: CS1BlockId) => round(all.filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0));
  const blocks = (Object.keys(CS1_BLOCKS) as CS1BlockId[]).map(id => ({ id: id as BlockId, label: CS1_BLOCKS[id], plan_usd: estimate(id), estimate_usd: estimate(id), cap_usd: id === 'CS1' ? round(Math.max(1.5 * estimate(id), leases(id))) : leases(id) }));
  const counted = blocks.find(b => b.id === 'CS1')!;
  const chat = CS1_MODELS.map(m => m.model).filter(m => !/embedding|^voyage:/.test(m)).sort();
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/cs1.ts', preregistration: CS1_PREREGISTRATION, readers: [...CS1_READERS], effort: CS1_EFFORT,
    prices: Object.fromEntries(chat.map(m => { const { input, output, cache_read, cache_write } = listPrice(m); return [m, { input, output, ...(cache_read !== undefined ? { cache_read } : {}), ...(cache_write !== undefined ? { cache_write } : {}) }]; })),
    assumptions: ASSUMPTIONS, sets: Object.values(CS1_SETS), blocks, cells, smoke_cells: [], addon_cells: [...pilot, ...capacity],
    total_usd: counted.estimate_usd, plan_total_usd: counted.plan_usd, cap_usd: counted.cap_usd,
    campaign_id: CS1_CAMPAIGN, registry: CS1_REGISTRY, gbrain_build: { ...CS1_GBRAIN_BUILD }, seed: CS1_SEED,
    models: CS1_MODELS.map(m => ({ ...m })), plan: CS1_PLAN, profiles: CS1_PROFILES, idle_worlds: [...CS1_IDLE_WORLDS],
    units: { CS1: unitIds(cells), 'CS1-pilot': unitIds(pilot), 'CS1-capacity': unitIds(capacity) },
  };
}

export const cs1ManifestText = (m: CS1Manifest = buildCS1Manifest()) => JSON.stringify(m, null, 2) + '\n';
/** Cost and speed's cell manifest (cs1-cells.json, written by this module), as `--manifest cs1` loads it. */
export const loadCS1Manifest = (path = CS1_MANIFEST_PATH) => JSON.parse(readFileSync(path, 'utf8')) as CS1Manifest;

if (import.meta.main) {
  const m = buildCS1Manifest();
  writeFileSync(CS1_MANIFEST_PATH, cs1ManifestText(m));
  console.log(`eval/runner/q1/cells/cs1-cells.json written (${m.cells.length} counted cells, ${m.addon_cells!.length} pilot and capacity cells)`);
}

/**
 * Cost and speed columns for the scoreboard, from a cell's rows and its
 * metering proxy's usage log (PLAN §4.5; docs/scoreboard.md).
 *
 *   bun eval/runner/cost-speed.ts --cell <cell output dir> [--usage <usage.ndjson>] [--answers <answers.ndjson>]
 *     [--capability <capability.json>] [--messages N] [--ingested-tokens N] [--vm-usd-per-hour X] [--json] [--out <file>]
 *   bun eval/runner/cost-speed.ts --watch --campaign <manifest.json> --state <dir> [--out <progress.md>] [--interval-s 60] [--once]
 *
 * What it computes, per cell:
 *   latency     p50/p95 retrieval (the system's own service time, `latency_ms`)
 *               and p50/p95 end to end (retrieval plus the answer's latency
 *               from answers.ndjson, matched by question; "not measured"
 *               without answers);
 *   tokens      delivered evidence tokens and reader input tokens per question;
 *   ingest      LLM calls, embedding calls and dollars per 1,000 ingested
 *               messages and per million ingested tokens, from the proxy's
 *               ingest-phase requests (keys `ingest:*`, and system-slot
 *               requests nobody had bound, which are late background work);
 *               for a system whose capability record says synchronous, commit
 *               (phase `commit`) apart from background (phase `background`
 *               and late work); for any other system the ingest-phase total,
 *               labeled not split;
 *   readiness   write-start-to-queryable p50/p95 from readiness.ndjson
 *               (`{ "write_start_to_queryable_ms": n }` per probe) or the
 *               receipt's `ingest.readiness_samples_ms`;
 *   workloads   monthly cost for a personal agent (2,000 messages and 300
 *               questions a month) and a team agent (50,000 and 10,000), from
 *               the measured unit costs, plus an always-on VM when
 *               --vm-usd-per-hour is given.
 *
 * The cost-and-speed experiment (docs/benchmarks/2026-11-24-cost-speed-preregistration.md) adds pure functions over
 * explicit per-world records (`cs1Aggregate` and its parts): monthly lines for both profiles, cost per correct answer,
 * the full-context range, history growth, the paired cluster bootstrap over worlds, the five decision rules and
 * README's table (`renderCs1Table`). A loader maps a run's files onto `Cs1Input`; nothing here reads files.
 *
 * Three different dollar numbers, never mixed: campaign spend (what the proxy
 * billed this cell, with reserved-unsettled dollars apart), cached-replay
 * spend (the list price of answers this run reused from the answer cache or
 * frozen contexts instead of paying again), and projected workload cost.
 *
 * Watch mode rewrites progress.md for a campaign: cells planned, running,
 * done and invalid; spend per block against its cap; VMs by owner (from the
 * repository runner's `usage`, when a Ubicloud token is present).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { percentile } from './metrics.ts';
import { priceRequest } from './budget-ledger.ts';
import type { UsageLine } from './metering-proxy.ts';
import { refuse, ScoreboardError, renderMessage, exitCodeOf } from './q1/scoreboard-errors.ts';
import { seededRandom } from './stats/paired.ts';
import { probeSummary, type ProbeRecord } from './memory-qa/cost-speed-probes.ts';
import type { MatchClass } from './bg1/match.ts';

export const WORKLOADS = {
  personal: { messages: 2_000, questions: 300 },
  team: { messages: 50_000, questions: 10_000 },
} as const;

const HOURS_PER_MONTH = 730;

export interface CostSpeedInputs {
  rows: Array<Record<string, any>>;
  usage: UsageLine[];
  answers?: Array<Record<string, any>>;
  capability?: { readiness?: string } | null;
  receipt?: Record<string, any> | null;
  readiness?: number[];
  messages?: number | null;
  ingestedTokens?: number | null;
  vmUsdPerHour?: number | null;
}

const LLM_ROUTE = /\/(chat\/completions|responses|messages)$/;
const EMBED_ROUTE = /\/embeddings$/;
const RERANK_ROUTE = /\/rerank$/;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const pct = (xs: number[]) => xs.length ? { p50: r4(percentile(xs, 50)), p95: r4(percentile(xs, 95)), n: xs.length } : null;

/** Which spend a usage line belongs to: ingest, retrieval, the harness's reader and judge, or something else. */
export function usagePhase(u: UsageLine): 'ingest' | 'retrieval' | 'answer' | 'judge' | 'probe' | 'other' {
  if (u.route_class === 'judge' || u.slot === 'judge') return 'judge';
  if (u.bucket === 'harness' || u.route_class === 'reader' || u.slot === 'harness') return 'answer';
  if (u.phase === 'probe') return 'probe';
  if (u.key.startsWith('ingest:') || u.phase === 'commit' || u.phase === 'background' || u.bucket === 'unattributed-background') return 'ingest';
  if (u.key.startsWith('q:') || u.phase === 'query') return 'retrieval';
  return 'other';
}

const isSynchronous = (cap: CostSpeedInputs['capability']) => /^synchronous\b/i.test(String(cap?.readiness ?? '').trim());

/** List price of reused answers (cache hits or frozen-context replays), from their reported usage; null when a model is unpriced. */
function replayValueUsd(answers: Array<Record<string, any>>): number | null {
  let total = 0;
  for (const a of answers.filter(x => x.cached === true || x.replayed === true)) {
    const reader = String(a.reader ?? '');
    const [prov, model] = reader.includes(':') ? [reader.slice(0, reader.indexOf(':')), reader.slice(reader.indexOf(':') + 1)] : ['openai', reader];
    const url = prov === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions';
    let price: ReturnType<typeof priceRequest>;
    try { price = priceRequest(url, { model, max_tokens: 1, messages: [] }); } catch { return null; }
    if (!price) continue;
    total += ((a.usage?.input ?? 0) * price.input + (a.usage?.output ?? 0) * price.output) / 1e6;
  }
  return r4(total);
}

export function costSpeed(inp: CostSpeedInputs) {
  const scored = inp.rows.filter(r => r.outcome === 'scored' || r.outcome === undefined);
  const questions = scored.length;
  const retrievalMs = scored.filter(r => typeof r.latency_ms === 'number').map(r => Number(r.latency_ms)).filter(Number.isFinite);
  const answerMs = new Map<string, number[]>();
  for (const a of inp.answers ?? []) if (typeof a.latency_ms === 'number' && Number.isFinite(a.latency_ms)) answerMs.set(String(a.question_id), [...(answerMs.get(String(a.question_id)) ?? []), Number(a.latency_ms)]);
  const e2e = scored.flatMap(r => (answerMs.get(String(r.id ?? r.question_id)) ?? []).map(ms => Number(r.latency_ms) + ms)).filter(Number.isFinite);
  const delivered = scored.map(r => Number(r.qa_context?.tokens ?? r.delivered_tokens?.cl100k_base ?? NaN)).filter(Number.isFinite);
  const readerIn = (inp.answers?.length ? inp.answers.map(a => Number(a.provider_input_tokens ?? a.usage?.input)) : scored.map(r => Number(r.qa_input_tokens))).filter(Number.isFinite);

  const forwarded = inp.usage.filter(u => u.outcome !== 'refused');
  const by = (phase: ReturnType<typeof usagePhase>) => forwarded.filter(u => usagePhase(u) === phase);
  const sum = (xs: UsageLine[]) => r4(xs.reduce((n, u) => n + (u.actual_usd ?? 0), 0));
  const ingest = by('ingest');
  const llm = ingest.filter(u => LLM_ROUTE.test(u.route)), embed = ingest.filter(u => EMBED_ROUTE.test(u.route)), rerank = ingest.filter(u => RERANK_ROUTE.test(u.route));
  const sync = isSynchronous(inp.capability);
  const marked = ingest.some(u => u.phase === 'commit' || u.phase === 'background');
  const split = sync && marked
    ? { mode: 'synchronous: split by phase', commit_usd: sum(ingest.filter(u => u.phase === 'commit')), background_usd: sum(ingest.filter(u => u.phase !== 'commit')),
      late_unattributed_usd: sum(ingest.filter(u => u.bucket === 'unattributed-background')) }
    : { mode: sync ? 'synchronous, but the harness marked no ingest phases: ingest-phase total only' : 'not synchronous (queued or background ingest): ingest-phase total, not split', ingest_phase_usd: sum(ingest),
      late_unattributed_usd: sum(ingest.filter(u => u.bucket === 'unattributed-background')) };
  const messages = inp.messages ?? inp.receipt?.ingest?.messages ?? null;
  const tokens = inp.ingestedTokens ?? inp.receipt?.ingest?.ingested_tokens ?? null;
  const per = (n: number, d: number | null, scale: number) => d ? r4(n / d * scale) : null;
  const ingestUsd = sum(ingest);
  const retrievalUsd = sum(by('retrieval'));
  const answerUsd = sum(by('answer'));
  const perQ = (x: number) => questions ? x / questions : null;
  const ingestPerMsg = messages ? ingestUsd / messages : null;
  const readiness = inp.readiness?.length ? inp.readiness : (inp.receipt?.ingest?.readiness_samples_ms as number[] | undefined) ?? [];
  const workload = (w: { messages: number; questions: number }) => {
    if (ingestPerMsg === null || perQ(retrievalUsd + answerUsd) === null) return null;
    const ingestM = ingestPerMsg * w.messages, retrievalM = perQ(retrievalUsd)! * w.questions, answerM = perQ(answerUsd)! * w.questions;
    const vm = inp.vmUsdPerHour ? inp.vmUsdPerHour * HOURS_PER_MONTH : null;
    return { ...w, ingest_usd: r4(ingestM), retrieval_usd: r4(retrievalM), answer_usd: r4(answerM), vm_usd: vm === null ? null : r4(vm), total_usd: r4(ingestM + retrievalM + answerM + (vm ?? 0)) };
  };
  return {
    questions,
    latency_ms: { retrieval: pct(retrievalMs), end_to_end: pct(e2e) },
    tokens_per_question: { delivered_evidence: delivered.length ? r4(delivered.reduce((a, b) => a + b, 0) / delivered.length) : null, reader_input: readerIn.length ? r4(readerIn.reduce((a, b) => a + b, 0) / readerIn.length) : null },
    ingest: {
      messages, ingested_tokens: tokens,
      llm_calls: llm.length, embedding_calls: embed.length, rerank_calls: rerank.length, usd: ingestUsd, llm_usd: sum(llm), embedding_usd: sum(embed),
      llm_calls_per_1k_messages: per(llm.length, messages, 1000), usd_per_1k_messages: per(ingestUsd, messages, 1000), embedding_usd_per_1k_messages: per(sum(embed), messages, 1000),
      llm_calls_per_million_tokens: per(llm.length, tokens, 1e6), usd_per_million_tokens: per(ingestUsd, tokens, 1e6),
      split,
    },
    write_start_to_queryable_ms: pct(readiness),
    per_question_usd: { retrieval: questions ? r4(retrievalUsd / questions) : null, answer: questions ? r4(answerUsd / questions) : null },
    spend: {
      campaign: { billed_usd: r4(forwarded.filter(u => !u.charged_reservation).reduce((n, u) => n + (u.actual_usd ?? 0), 0)), reserved_unsettled_usd: r4(forwarded.filter(u => u.charged_reservation).reduce((n, u) => n + (u.actual_usd ?? 0), 0)),
        by_phase: { ingest: ingestUsd, retrieval: retrievalUsd, answer: answerUsd, judge: sum(by('judge')), other: sum([...by('other'), ...by('probe')]) }, requests: forwarded.length, refused: inp.usage.length - forwarded.length },
      cached_replay_usd: inp.answers ? replayValueUsd(inp.answers) : null,
      projected_monthly: { personal: workload(WORKLOADS.personal), team: workload(WORKLOADS.team) },
    },
  };
}

export type CostSpeed = ReturnType<typeof costSpeed>;

const readNdjson = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

/** Load a cell output directory: rows.ndjson, receipt.json, usage.ndjson, answers.ndjson and readiness.ndjson when present. */
export function loadCell(dir: string, over: { usage?: string; answers?: string; capability?: string } = {}): CostSpeedInputs {
  if (!existsSync(join(dir, 'rows.ndjson'))) throw refuse({ code: 'INPUT_MISSING', message: `${dir} has no rows.ndjson`, why: 'cost and speed columns are computed from a finished cell\'s canonical rows',
    fix: { next: 'run', argv: ['ls', dir], verify: ['ls', join(dir, 'rows.ndjson')] } });
  const receipt = existsSync(join(dir, 'receipt.json')) ? JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) : null;
  const usagePath = over.usage ?? [join(dir, 'usage.ndjson'), join(dir, '..', 'usage.ndjson')].find(existsSync);
  const capability = over.capability ? JSON.parse(readFileSync(over.capability, 'utf8')) : receipt?.system?.capabilities ?? null;
  return { rows: readNdjson(join(dir, 'rows.ndjson')), usage: usagePath ? readNdjson(usagePath) : [], answers: over.answers || existsSync(join(dir, 'answers.ndjson')) ? readNdjson(over.answers ?? join(dir, 'answers.ndjson')) : undefined,
    capability, receipt, readiness: readNdjson(join(dir, 'readiness.ndjson')).map(x => Number(x.write_start_to_queryable_ms)).filter(Number.isFinite) };
}

const cellText = (v: unknown) => v === null || v === undefined ? 'not measured' : typeof v === 'number' ? String(v) : String(v);

export function renderCostSpeed(c: CostSpeed): string {
  const lat = (x: { p50: number; p95: number } | null) => x ? `${x.p50} / ${x.p95}` : 'not measured';
  const w = (x: CostSpeed['spend']['projected_monthly']['personal']) => x ? `$${x.total_usd}` : 'not measured';
  return [
    '| Measure | Value |', '|---|---|',
    `| Questions scored | ${c.questions} |`,
    `| Retrieval latency p50 / p95 (ms) | ${lat(c.latency_ms.retrieval)} |`,
    `| End-to-end latency p50 / p95 (ms) | ${lat(c.latency_ms.end_to_end)} |`,
    `| Delivered evidence tokens per question | ${cellText(c.tokens_per_question.delivered_evidence)} |`,
    `| Reader input tokens per question | ${cellText(c.tokens_per_question.reader_input)} |`,
    `| Ingest LLM calls per 1,000 messages | ${cellText(c.ingest.llm_calls_per_1k_messages)} |`,
    `| Ingest dollars per 1,000 messages | ${cellText(c.ingest.usd_per_1k_messages)} |`,
    `| Ingest dollars per million tokens | ${cellText(c.ingest.usd_per_million_tokens)} |`,
    `| Embedding dollars per 1,000 messages | ${cellText(c.ingest.embedding_usd_per_1k_messages)} |`,
    `| Commit / background split | ${c.ingest.split.mode} |`,
    `| Write-start-to-queryable p50 / p95 (ms) | ${lat(c.write_start_to_queryable_ms)} |`,
    `| Campaign spend: billed / reserved-unsettled | $${c.spend.campaign.billed_usd} / $${c.spend.campaign.reserved_unsettled_usd} |`,
    `| Cached-replay spend (list price, not paid) | ${c.spend.cached_replay_usd === null ? 'not measured' : `$${c.spend.cached_replay_usd}`} |`,
    `| Projected monthly cost, personal (2,000 messages, 300 questions) | ${w(c.spend.projected_monthly.personal)} |`,
    `| Projected monthly cost, team (50,000 messages, 10,000 questions) | ${w(c.spend.projected_monthly.team)} |`,
  ].join('\n') + '\n';
}

/** The campaign's live status page: cells by state, spend per block against its cap, VMs by owner. */
export async function renderProgress(manifest: string, state: string, opts: { vms?: () => Promise<string | null> } = {}): Promise<string> {
  const { Campaign, planWaves } = await import('./shootout-cell.ts');
  const c = new Campaign(manifest, resolve(state));
  const st = c.status();
  const leases = st.leases;
  const latest = new Map<string, typeof leases[number]>();
  for (const l of leases) latest.set(l.cell, l);
  const bad = (l: typeof leases[number]) => l.status === 'abandoned' || l.timed_out || (l.cell_exit_code !== undefined && l.cell_exit_code !== null && l.cell_exit_code !== 0) || (l.exit_code !== undefined && l.exit_code !== null && l.exit_code !== 0);
  const counts = { planned: c.manifest.cells.length, running: 0, done: 0, invalid: 0, not_started: 0 };
  for (const cell of c.manifest.cells) {
    const l = latest.get(cell.id);
    if (!l) counts.not_started++;
    else if (l.status === 'reserved' || l.status === 'launched' || l.status === 'finished') counts.running++;
    else if (bad(l)) counts.invalid++;
    else counts.done++;
  }
  const blocks = Object.entries(c.manifest.blocks ?? {}).map(([b, v]) => `| ${b} | $${c.blockSpend(b).toFixed(2)} | $${v.estimate_usd.toFixed(2)} | $${v.cap_usd.toFixed(2)} |`);
  const vms = opts.vms ? await opts.vms() : null;
  return [
    `# Progress: ${c.manifest.campaign_id}`, '',
    `Updated ${new Date().toISOString()}. Campaign hash ${c.sha256.slice(0, 12)}${c.q1 ? (st as { frozen?: boolean }).frozen ? ' (matches the freeze)' : ' (DOES NOT match the freeze: launches are refused)' : ''}.`, '',
    '| Cells | Planned | Running | Done | Invalid | Not started |', '|---|---:|---:|---:|---:|---:|',
    `| all | ${counts.planned} | ${counts.running} | ${counts.done} | ${counts.invalid} | ${counts.not_started} |`, '',
    `Spend: $${(st.committed_usd ?? 0).toFixed(2)} held of the $${c.manifest.cap_usd.toFixed(2)} cap; $${st.unsettled_usd.toFixed(2)} of it is leases charged at their full reservation (open, or abandoned without a VM ledger).`, '',
    ...(blocks.length ? ['| Block | Held | Estimate | Cap |', '|---|---:|---:|---:|', ...blocks, ''] : []),
    `Schedule: ${planWaves(c.manifest).map(w => `wave ${w.wave} ${w.cells.length} cells, ${w.vcpu} vCPU`).join('; ')}.`, '',
    '## VMs by owner', '', vms ? '```\n' + vms.trim() + '\n```' : 'Not checked: no Ubicloud token on this host, or the runner could not be reached.', '',
  ].join('\n');
}

async function vmsByOwner(): Promise<string | null> {
  if (!process.env.UBICLOUD_API_TOKEN && !process.env.UBICLOUD_API_KEY) return null;
  try {
    const { resolveRunner } = await import('./shootout-cell.ts');
    const p = Bun.spawn(['bash', resolveRunner(), 'usage'], { stdout: 'pipe', stderr: 'ignore' });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out : null;
  } catch { return null; }
}

/** The cost-and-speed experiment's workload profiles (docs/benchmarks/2026-11-24-cost-speed-preregistration.md, "Workload profile"): ingested tokens and questions a month, and the one-year history that storage and the full-context row are priced at. */
export const CS1_PROFILES = {
  heavy: { messages: 2_000, tokens: 80_700, questions: 300, history_tokens: 968_000 },
  light: { messages: 215, tokens: 8_700, questions: 32, history_tokens: 104_000 },
} as const;
export type Cs1Profile = keyof typeof CS1_PROFILES;
const CS1_PROFILE_NAMES: readonly Cs1Profile[] = ['heavy', 'light'];

/** The preregistered bootstrap: 10,000 resamples of worlds, seeded from the string `cost-speed-1`. */
export const CS1_SEED = 'cost-speed-1';
export const CS1_DRAWS = 10_000;
/** The write-to-queryable horizon: a percentile past it renders as "more than 10 minutes". */
export const CS1_HORIZON_MS = 600_000;
/** Rows named by "What the result decides": gbrain, the three compared memory servers, the four passive systems besides gbrain and the five compared systems. */
export const CS1_GBRAIN = 'gbrain-defaults';
export const CS1_SERVERS = ['ext-extract-first', 'ext-memory-bank', 'ext-verbatim-session'] as const;
export const CS1_PASSIVE = [...CS1_SERVERS, 'baseline-hybrid'] as const;
export const CS1_COMPARED = [...CS1_PASSIVE, 'baseline-file-agent'] as const;
/** The profile's reader first (decisions 2, 4 and 5 use it), then the low-cost reader. */
export const CS1_READERS = ['claude-opus-5-5', 'particle-1'] as const;
/** The decision rules' margins and the history-growth flag. */
export const CS1_BARS = { system_ratio: 1.25, answer_ratio: 1.5, p50_ms: 60_000, p95_ms: 300_000, miss_share: 0.05, system_share: 0.1, total_ratio: 1.25, growth: 1.25 } as const;
const GIB = 2 ** 30;
const MEMORY_HEADROOM = 1.5;

export type Interval = [number, number];

/** One reader's answers in one world: questions asked, the reader's provider dollars, and each answer's class from eval/runner/bg1/match.ts. */
export interface Cs1ReaderWorld {
  questions: number;
  usd: number;
  classes: readonly MatchClass[];
}

/** One system's measured lines in one world. Probe dollars are carried for the record and never counted in cost. */
export interface Cs1World {
  world: string;
  ingested_tokens: number;
  sessions: number;
  /** Questions the system answered with its own read; its read dollars are divided by this. */
  questions: number;
  usd: { write: number; background: number; read: number; probe: number };
  /** Optional split of a phase's dollars by model, for decision 1's largest line. */
  by_model?: Partial<Record<'write' | 'background' | 'read', Record<string, number>>>;
  /** The idle window, on the two worlds per system that ran one. */
  idle?: { usd: number; window_ms: number } | null;
  /** Write-and-background dollars per million tokens over the world's first and last quarter of sessions. */
  quarters?: { first_usd_per_mtok: number; last_usd_per_mtok: number } | null;
  readers: Readonly<Record<string, Cs1ReaderWorld>>;
  /** The world's counted write-to-queryable probe records (eval/runner/memory-qa/cost-speed-probes.ts). */
  probes?: readonly ProbeRecord[] | null;
}

/** A system's steady-peak resident memory and disk bytes, and the ingested tokens the disk held when sampled (the projection's base). */
export interface Cs1Hosted { resident_bytes: number; disk_bytes: number; disk_tokens: number }

/** One system's worlds and hosting sample; hosting null means there is no stack to host (the question-only floor). */
export interface Cs1System { system: string; worlds: readonly Cs1World[]; hosting: Cs1Hosted | null }

/** The hosting price ladder from the freeze amendment: one provider's general-purpose instances and its block-storage price. */
export interface Cs1PriceLadder {
  provider: string;
  instances: ReadonlyArray<{ name: string; memory_gib: number; usd_per_hour: number }>;
  storage_usd_per_gb_month: number;
}

/** One reader's whole-world full-context reads in one world, with input dollars split by cache kind. */
export interface Cs1FullContextWorld {
  world: string;
  questions: number;
  cached_tokens: number;
  cached_usd: number;
  cache_write_tokens: number;
  cache_write_usd: number;
  uncached_usd: number;
  output_usd: number;
  classes: readonly MatchClass[];
}

/** baseline-full-context for one reader: its measured reads and, per profile, whether the one-year prompt fits the reader (`checkFit`). */
export interface Cs1FullContextReader {
  worlds: readonly Cs1FullContextWorld[];
  fit: Readonly<Record<Cs1Profile, { fits: boolean; prompt_tokens?: number }>>;
}

/** Everything the aggregation reads; a loader maps a run's files onto it. */
export interface Cs1Input {
  systems: readonly Cs1System[];
  ladder: Cs1PriceLadder;
  full_context?: Readonly<Record<string, Cs1FullContextReader>> | null;
  not_run?: ReadonlyArray<{ system: string; reason: string }>;
  readers?: readonly string[];
  seed?: string;
  draws?: number;
}

/** A system's monthly lines in one world (or their world means) for one profile. */
export interface Cs1Lines {
  write: number;
  background: number;
  write_background: number;
  read: number;
  idle: number;
  hosting: number;
  system: number;
  system_without_hosting: number;
  readers: Record<string, { reader: number; total: number; total_without_hosting: number }>;
}

/** A system's hosting a month for one profile: the smallest instance holding 1.5 times the steady peak for 730 hours, plus storage projected to the profile's one-year history. */
export interface Cs1HostingLine { instance: string | null; memory_needed_gib: number; compute_usd: number; storage_gb: number; storage_usd: number; usd: number }

/** Hosting from the price ladder; refuses when no instance holds the peak or the disk sample can't be projected. */
export function cs1Hosting(h: Cs1Hosted | null, ladder: Cs1PriceLadder, profile: Cs1Profile): Cs1HostingLine {
  if (!h) return { instance: null, memory_needed_gib: 0, compute_usd: 0, storage_gb: 0, storage_usd: 0, usd: 0 };
  if (!(h.disk_tokens > 0)) throw new Error('cost-speed hosting: the disk sample names no ingested tokens to project from');
  const need = h.resident_bytes * MEMORY_HEADROOM / GIB;
  const pick = ladder.instances.filter(i => i.memory_gib >= need).sort((a, b) => a.memory_gib - b.memory_gib || a.usd_per_hour - b.usd_per_hour)[0];
  if (!pick) throw new Error(`cost-speed hosting: no ${ladder.provider} instance holds ${need.toFixed(2)} GiB (1.5 times the steady peak)`);
  const gb = h.disk_bytes / h.disk_tokens * CS1_PROFILES[profile].history_tokens / GIB;
  const compute = pick.usd_per_hour * HOURS_PER_MONTH, storage = gb * ladder.storage_usd_per_gb_month;
  return { instance: pick.name, memory_needed_gib: need, compute_usd: compute, storage_gb: gb, storage_usd: storage, usd: compute + storage };
}

/** A system's idle dollars a month: its idle windows' dollars per hour, pooled over the worlds that ran one, times 730; null when none did. */
export function cs1IdleUsdPerMonth(worlds: readonly Cs1World[]): number | null {
  const ran = worlds.filter(w => w.idle && w.idle.window_ms > 0);
  if (!ran.length) return null;
  const usd = ran.reduce((n, w) => n + w.idle!.usd, 0), hours = ran.reduce((n, w) => n + w.idle!.window_ms, 0) / 3_600_000;
  return usd / hours * HOURS_PER_MONTH;
}

/** One world's monthly lines at a profile's volumes; idle and hosting are the system's fixed monthly figures. */
export function cs1MonthlyLines(w: Cs1World, profile: Cs1Profile, fixed: { idle_usd: number; hosting_usd: number }, readers: readonly string[] = CS1_READERS): Cs1Lines {
  const p = CS1_PROFILES[profile];
  const write = w.ingested_tokens > 0 ? w.usd.write / w.ingested_tokens * p.tokens : 0;
  const background = w.ingested_tokens > 0 ? w.usd.background / w.ingested_tokens * p.tokens : 0;
  const read = w.questions > 0 ? w.usd.read / w.questions * p.questions : 0;
  const system = write + background + read + fixed.idle_usd + fixed.hosting_usd;
  return {
    write, background, write_background: write + background, read, idle: fixed.idle_usd, hosting: fixed.hosting_usd, system, system_without_hosting: system - fixed.hosting_usd,
    readers: Object.fromEntries(readers.map(r => {
      const reader = w.readers[r].usd / w.readers[r].questions * p.questions;
      return [r, { reader, total: system + reader, total_without_hosting: system - fixed.hosting_usd + reader }];
    })),
  };
}

/** Key-matched accuracy: `unclear` counts as not correct and is also counted on its own. */
export function cs1Accuracy(rs: ReadonlyArray<{ questions: number; classes: readonly MatchClass[] }>) {
  const questions = rs.reduce((n, r) => n + r.questions, 0);
  const correct = rs.reduce((n, r) => n + r.classes.filter(c => c === 'correct').length, 0);
  const unclear = rs.reduce((n, r) => n + r.classes.filter(c => c === 'unclear').length, 0);
  return { questions, correct, unclear, not_correct: questions - correct, key_matched: questions ? correct / questions : null };
}

/** History growth: world-mean last-quarter over first-quarter write-and-background dollars per million tokens, flagged above 1.25. */
export function cs1Growth(worlds: readonly Cs1World[]) {
  const q = worlds.flatMap(w => w.quarters ? [w.quarters] : []);
  if (!q.length) return { worlds: 0, first_usd_per_mtok: null, last_usd_per_mtok: null, ratio: null, flagged: false, note: 'not measured' };
  const first = q.reduce((n, x) => n + x.first_usd_per_mtok, 0) / q.length, last = q.reduce((n, x) => n + x.last_usd_per_mtok, 0) / q.length;
  if (!(first > 0)) return { worlds: q.length, first_usd_per_mtok: first, last_usd_per_mtok: last, ratio: null, flagged: false, note: 'not defined: no write-and-background spend in the first quarter' };
  return { worlds: q.length, first_usd_per_mtok: first, last_usd_per_mtok: last, ratio: last / first, flagged: last / first > CS1_BARS.growth, note: null };
}

/** The bootstrap's resamples: `draws` lists of cluster indices drawn with replacement, seeded from the string seed through stats/paired.ts's generator. */
export function cs1Draws(clusters: number, seed: string = CS1_SEED, draws: number = CS1_DRAWS): number[][] {
  const rand = seededRandom(createHash('sha256').update(seed).digest().readUInt32LE(0));
  return Array.from({ length: draws }, () => Array.from({ length: clusters }, () => Math.floor(rand() * clusters)));
}

const quantileAt = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

/**
 * baseline-full-context for one reader and profile: warm and cold monthly bounds from the measured input dollars per
 * token by cache kind, scaled to the profile's one-year prompt. Warm writes the history to the cache once a day and
 * reads it from cache for the day's other questions; cold writes it for every question. Both add the measured
 * uncached and output dollars per question. Not bootstrapped: it is a priced range, not a measured monthly figure.
 */
export function cs1FullContext(fc: Cs1FullContextReader, profile: Cs1Profile) {
  const accuracy = cs1Accuracy(fc.worlds);
  const fit = fc.fit[profile];
  if (!fit?.fits) return { fits: false as const, history_tokens: null, warm_usd: null, cold_usd: null, cost_per_correct: null, accuracy, note: "doesn't fit" };
  const sum = (f: (w: Cs1FullContextWorld) => number) => fc.worlds.reduce((n, w) => n + f(w), 0);
  const p = CS1_PROFILES[profile], history = fit.prompt_tokens ?? p.history_tokens;
  const writeRate = sum(w => w.cache_write_tokens) > 0 ? sum(w => w.cache_write_usd) / sum(w => w.cache_write_tokens) : null;
  const cachedRate = sum(w => w.cached_tokens) > 0 ? sum(w => w.cached_usd) / sum(w => w.cached_tokens) : null;
  const perQuestion = sum(w => w.questions) > 0 ? (sum(w => w.uncached_usd) + sum(w => w.output_usd)) / sum(w => w.questions) : null;
  if (writeRate === null || perQuestion === null) return { fits: true as const, history_tokens: history, warm_usd: null, cold_usd: null, cost_per_correct: null, accuracy, note: 'not priced: no cache-write reads measured' };
  const writes = Math.min(p.questions, HOURS_PER_MONTH / 24);
  const warm = cachedRate === null ? null : writes * history * writeRate + (p.questions - writes) * history * cachedRate + p.questions * perQuestion;
  const cold = p.questions * history * writeRate + p.questions * perQuestion;
  const perCorrect = (v: number | null) => v === null || !accuracy.correct ? null : v / (p.questions * accuracy.key_matched!);
  return {
    fits: true as const, history_tokens: history, warm_usd: warm, cold_usd: cold, accuracy,
    cost_per_correct: accuracy.correct ? { warm_usd: perCorrect(warm), cold_usd: perCorrect(cold) } : null,
    note: accuracy.correct ? (warm === null ? 'warm bound not priced: no cached reads measured' : null) : 'no correct answers',
  };
}

/** A decision rule's outcome with the numbers behind it. */
export interface Cs1Rule { rule: 1 | 2 | 3 | 4 | 5; status: 'fired' | 'not fired' | 'not evaluated'; reason: string; numbers: Record<string, unknown> }

/**
 * The cost-and-speed aggregation (preregistration "Measures", "Statistics" and "What the result decides"): monthly
 * lines per system, world, profile and reader; world means with 95% intervals from the paired cluster bootstrap over
 * worlds; key-matched cost per correct answer with the zero rule; write-to-queryable p50 and p95 with intervals from
 * resampled worlds' probe windows; history growth; the full-context range; and the five decision rules at the heavy
 * profile and the first reader. Hosting and the idle rate are held fixed outside the resample: hosting comes from a
 * price ladder, and the idle rate is one system-level dollars-per-hour figure from its idle worlds, applied to every
 * world. Every system must hold the same worlds, so each resample pairs them.
 */
export function cs1Aggregate(inp: Cs1Input) {
  const readers = inp.readers ?? CS1_READERS;
  const ids = [...new Set(inp.systems[0]?.worlds.map(w => w.world) ?? [])].sort();
  const problems: string[] = [];
  if (!ids.length) problems.push('no worlds');
  if (new Set(inp.systems.map(s => s.system)).size !== inp.systems.length) problems.push('a system appears twice');
  for (const s of inp.systems) {
    const own = s.worlds.map(w => w.world);
    if (new Set(own).size !== own.length || own.length !== ids.length || own.some(w => !ids.includes(w))) problems.push(`${s.system}: its worlds differ from ${inp.systems[0].system}'s, so resamples can't pair them`);
    if (s.hosting && !(s.hosting.disk_tokens > 0)) problems.push(`${s.system}: hosting names no ingested tokens to project disk from`);
    for (const w of s.worlds) {
      if (w.usd.write + w.usd.background > 0 && !(w.ingested_tokens > 0)) problems.push(`${s.system}/${w.world}: write dollars with no ingested tokens`);
      if (w.usd.read > 0 && !(w.questions > 0)) problems.push(`${s.system}/${w.world}: read dollars with no questions`);
      for (const r of readers) {
        const x = w.readers[r];
        if (!x || !(x.questions > 0)) problems.push(`${s.system}/${w.world}: reader ${r} asked no questions`);
        else if (x.classes.length > x.questions) problems.push(`${s.system}/${w.world}: reader ${r} has more matcher classes than questions`);
      }
    }
  }
  if (problems.length) throw new Error(`cost-speed aggregate refused: ${problems.join('; ')}`);

  const draws = cs1Draws(ids.length, inp.seed ?? CS1_SEED, inp.draws ?? CS1_DRAWS);
  const all = ids.map((_, i) => i);
  type Stat = (idx: readonly number[]) => number;
  const avg = (idx: readonly number[], f: (i: number) => number) => idx.reduce((n, i) => n + f(i), 0) / idx.length;
  const interval = (f: (idx: readonly number[]) => number | null): Interval | null => {
    const xs: number[] = [];
    for (const d of draws) {
      const v = f(d);
      if (v === null || Number.isNaN(v)) return null;
      xs.push(v);
    }
    xs.sort((a, b) => a - b);
    return [quantileAt(xs, 0.025), quantileAt(xs, 0.975)];
  };
  const est = (f: Stat) => ({ usd: f(all), ci95: interval(f) });

  const prepared = new Map(inp.systems.map(s => {
    const worlds = ids.map(id => s.worlds.find(w => w.world === id)!);
    const idle = cs1IdleUsdPerMonth(worlds);
    const hosting = Object.fromEntries(CS1_PROFILE_NAMES.map(p => [p, cs1Hosting(s.hosting, inp.ladder, p)])) as Record<Cs1Profile, Cs1HostingLine>;
    const lines = Object.fromEntries(CS1_PROFILE_NAMES.map(p => [p, worlds.map(w => cs1MonthlyLines(w, p, { idle_usd: idle ?? 0, hosting_usd: hosting[p].usd }, readers))])) as Record<Cs1Profile, Cs1Lines[]>;
    const correct = Object.fromEntries(readers.map(r => [r, worlds.map(w => w.readers[r].classes.filter(c => c === 'correct').length)]));
    return [s.system, { s, worlds, idle, hosting, lines, correct }];
  }));
  const of = (name: string) => prepared.get(name)!;
  const sysStat = (name: string, p: Cs1Profile, key: 'system' | 'system_without_hosting'): Stat => idx => avg(idx, i => of(name).lines[p][i][key]);
  const readerStat = (name: string, p: Cs1Profile, r: string, key: 'reader' | 'total' | 'total_without_hosting'): Stat => idx => avg(idx, i => of(name).lines[p][i].readers[r][key]);
  const perQuestionStat = (name: string, r: string): Stat => idx => avg(idx, i => of(name).worlds[i].readers[r].usd / of(name).worlds[i].readers[r].questions);
  const meanLines = (ls: readonly Cs1Lines[]): Cs1Lines => {
    const m = (f: (l: Cs1Lines) => number) => ls.reduce((n, l) => n + f(l), 0) / ls.length;
    return {
      write: m(l => l.write), background: m(l => l.background), write_background: m(l => l.write_background), read: m(l => l.read), idle: m(l => l.idle), hosting: m(l => l.hosting),
      system: m(l => l.system), system_without_hosting: m(l => l.system_without_hosting),
      readers: Object.fromEntries(readers.map(r => [r, { reader: m(l => l.readers[r].reader), total: m(l => l.readers[r].total), total_without_hosting: m(l => l.readers[r].total_without_hosting) }])),
    };
  };

  const systems = inp.systems.map(({ system }) => {
    const x = of(system);
    const windows = x.worlds.map(w => [...(w.probes ?? [])]);
    let probes: (ReturnType<typeof probeSummary> & { p50_ci95: [number | null, number | null] | null; p95_ci95: [number | null, number | null] | null }) | null = null;
    if (windows.some(w => w.length)) {
      const p50s: number[] = [], p95s: number[] = [];
      let defined = true;
      for (const d of draws) {
        const s = probeSummary(d.map(i => windows[i]), CS1_HORIZON_MS);
        if (!s.counted) { defined = false; break; }
        p50s.push(s.p50_ms ?? Infinity);
        p95s.push(s.p95_ms ?? Infinity);
      }
      const ci = (xs: number[]): [number | null, number | null] | null => {
        if (!defined) return null;
        xs.sort((a, b) => a - b);
        const lo = quantileAt(xs, 0.025), hi = quantileAt(xs, 0.975);
        return [Number.isFinite(lo) ? lo : null, Number.isFinite(hi) ? hi : null];
      };
      probes = { ...probeSummary(windows, CS1_HORIZON_MS), p50_ci95: ci(p50s), p95_ci95: ci(p95s) };
    }
    const profiles = Object.fromEntries(CS1_PROFILE_NAMES.map(p => [p, {
      lines: meanLines(x.lines[p]),
      per_world: ids.map((world, i) => ({ world, lines: x.lines[p][i] })),
      system: est(sysStat(system, p, 'system')),
      system_without_hosting: est(sysStat(system, p, 'system_without_hosting')),
      readers: Object.fromEntries(readers.map(r => {
        const cpc = (idx: readonly number[]) => {
          const correct = idx.reduce((n, i) => n + x.correct[r][i], 0), questions = idx.reduce((n, i) => n + x.worlds[i].readers[r].questions, 0);
          return correct ? readerStat(system, p, r, 'total')(idx) / (CS1_PROFILES[p].questions * correct / questions) : null;
        };
        const point = cpc(all), ci = point === null ? null : interval(cpc);
        return [r, {
          reader: est(readerStat(system, p, r, 'reader')),
          total: est(readerStat(system, p, r, 'total')),
          total_without_hosting: est(readerStat(system, p, r, 'total_without_hosting')),
          cost_per_correct: { usd: point, ci95: ci, note: point === null ? 'no correct answers' : ci ? null : 'interval not defined' },
        }];
      })),
    }])) as Record<Cs1Profile, { lines: Cs1Lines; per_world: Array<{ world: string; lines: Cs1Lines }>; system: { usd: number; ci95: Interval | null }; system_without_hosting: { usd: number; ci95: Interval | null };
      readers: Record<string, { reader: { usd: number; ci95: Interval | null }; total: { usd: number; ci95: Interval | null }; total_without_hosting: { usd: number; ci95: Interval | null }; cost_per_correct: { usd: number | null; ci95: Interval | null; note: string | null } }> }>;
    return {
      system, worlds: ids.length,
      probe_usd: x.worlds.reduce((n, w) => n + w.usd.probe, 0),
      idle: { usd_per_month: x.idle ?? 0, measured_worlds: x.worlds.filter(w => w.idle && w.idle.window_ms > 0).length, note: x.idle === null ? 'no idle window measured: idle line is zero' : null },
      hosting: x.hosting,
      accuracy: Object.fromEntries(readers.map(r => [r, cs1Accuracy(x.worlds.map(w => w.readers[r]))])),
      growth: cs1Growth(x.worlds),
      probes,
      profiles,
    };
  });

  const ratio = (num: Stat, den: Stat) => {
    const n = num(all), d = den(all);
    const ci95 = d > 0 ? interval(idx => { const dd = den(idx); return dd > 0 ? num(idx) / dd : null; }) : null;
    return { ratio: d > 0 ? n / d : null, ci95, gap_usd: n - d, gap_ci95: interval(idx => num(idx) - den(idx)), note: d > 0 ? (ci95 ? null : 'interval not defined: a resample\'s denominator is zero') : 'ratio not defined: the denominator is zero' };
  };
  const above = (c: { ci95: Interval | null }, bar: number) => c.ci95 !== null && c.ci95[0] > bar;
  const missing = (names: readonly string[]) => names.filter(n => !prepared.has(n));
  const notEvaluated = (rule: Cs1Rule['rule'], names: string[]): Cs1Rule => ({ rule, status: 'not evaluated', reason: `missing ${names.join(', ')}`, numbers: {} });
  const P: Cs1Profile = 'heavy', r0 = readers[0];
  const gbrainOut = systems.find(s => s.system === CS1_GBRAIN);

  const rule1 = (): Cs1Rule => {
    const need = missing([CS1_GBRAIN, ...CS1_SERVERS]);
    if (need.length) return notEvaluated(1, need);
    const cheapest = (key: 'system' | 'system_without_hosting') => {
      const pickAt = (idx: readonly number[]) => CS1_SERVERS.map(s => ({ s, v: sysStat(s, P, key)(idx) })).sort((a, b) => a.v - b.v)[0];
      const chosen = Object.fromEntries(CS1_SERVERS.map(s => [s, 0]));
      for (const d of draws) chosen[pickAt(d).s]++;
      return { at_point: pickAt(all).s, chosen_share: Object.fromEntries(CS1_SERVERS.map(s => [s, chosen[s] / draws.length])), ...ratio(sysStat(CS1_GBRAIN, P, key), idx => pickAt(idx).v) };
    };
    const withHosting = cheapest('system'), withoutHosting = cheapest('system_without_hosting');
    const g = of(CS1_GBRAIN), lines = gbrainOut!.profiles[P].lines;
    const phases = (['write', 'background', 'read', 'idle', 'hosting'] as const).map(phase => ({ phase, usd: lines[phase] })).sort((a, b) => b.usd - a.usd);
    const top = phases[0].phase;
    const models = top === 'write' || top === 'background' || top === 'read'
      ? Object.entries(g.worlds.reduce<Record<string, number>>((acc, w) => { for (const [m, v] of Object.entries(w.by_model?.[top] ?? {})) acc[m] = (acc[m] ?? 0) + v; return acc; }, {})).sort((a, b) => b[1] - a[1])
      : [];
    const fired = above(withHosting, CS1_BARS.system_ratio);
    return {
      rule: 1, status: fired ? 'fired' : 'not fired',
      reason: `gbrain's system cost over the cheapest server's: ${withHosting.ratio === null ? 'not defined' : withHosting.ratio.toFixed(3)}, interval's lower end ${withHosting.ci95 ? withHosting.ci95[0].toFixed(3) : 'not defined'} against ${CS1_BARS.system_ratio}`,
      numbers: { with_hosting: withHosting, without_hosting: withoutHosting, largest_line: { phase: top, usd: phases[0].usd, model: top === 'hosting' ? g.hosting[P].instance : models[0]?.[0] ?? null }, lines: phases },
    };
  };

  const rule2 = (): Cs1Rule => {
    const need = missing([CS1_GBRAIN, ...CS1_PASSIVE]);
    if (need.length) return notEvaluated(2, need);
    const median: Stat = idx => {
      const xs = CS1_PASSIVE.map(s => perQuestionStat(s, r0)(idx)).sort((a, b) => a - b);
      return xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
    };
    const c = ratio(perQuestionStat(CS1_GBRAIN, r0), median);
    const lines = gbrainOut!.profiles[P].lines, readerLine = lines.readers[r0].reader;
    const largest = [...(['write', 'background', 'read', 'idle', 'hosting'] as const).map(line => ({ line: line as string, usd: lines[line] })), { line: 'reader', usd: readerLine }].sort((a, b) => b.usd - a.usd)[0];
    const fired = above(c, CS1_BARS.answer_ratio);
    return {
      rule: 2, status: fired ? 'fired' : 'not fired',
      reason: `gbrain's ${r0} cost per question over the median of the four other passive systems: ${c.ratio === null ? 'not defined' : c.ratio.toFixed(3)}, interval's lower end ${c.ci95 ? c.ci95[0].toFixed(3) : 'not defined'} against ${CS1_BARS.answer_ratio}`,
      numbers: {
        reader: r0, gbrain_usd_per_question: perQuestionStat(CS1_GBRAIN, r0)(all), median_usd_per_question: median(all), comparison: c,
        per_system_usd_per_question: Object.fromEntries(CS1_PASSIVE.map(s => [s, perQuestionStat(s, r0)(all)])),
        shipped_read_is_largest: (['write', 'background', 'idle', 'hosting'] as const).every(k => readerLine > lines[k]), largest_line: largest,
      },
    };
  };

  const rule3 = (): Cs1Rule => {
    if (!gbrainOut) return notEvaluated(3, [CS1_GBRAIN]);
    const p = gbrainOut.probes;
    if (!p || !p.counted) return { rule: 3, status: 'not evaluated', reason: 'gbrain has no counted probes', numbers: { probes: p } };
    const p50Over = p.p50_ms === null || p.p50_ms > CS1_BARS.p50_ms, p95Over = p.p95_ms === null || p.p95_ms > CS1_BARS.p95_ms, missOver = (p.miss_share ?? 0) > CS1_BARS.miss_share;
    const fired = p50Over || p95Over || missOver;
    return {
      rule: 3, status: fired ? 'fired' : 'not fired',
      reason: `p50 ${p.p50_ms === null ? 'more than 10 minutes' : `${p.p50_ms} ms`}, p95 ${p.p95_ms === null ? 'more than 10 minutes' : `${p.p95_ms} ms`}, ${p.missed} of ${p.counted} counted probes missed`,
      numbers: { p50_ms: p.p50_ms, p95_ms: p.p95_ms, miss_share: p.miss_share, counted: p.counted, missed: p.missed, p50_over: p50Over, p95_over: p95Over, miss_over: missOver },
    };
  };

  const rule4 = (): Cs1Rule => {
    const need = missing([...CS1_SERVERS]);
    if (need.length) return notEvaluated(4, need);
    const shares = Object.fromEntries(CS1_SERVERS.map(s => {
      const f = (idx: readonly number[]) => { const t = readerStat(s, P, r0, 'total')(idx); return t > 0 ? sysStat(s, P, 'system')(idx) / t : null; };
      return [s, { share: f(all), ci95: interval(f) }];
    }));
    const fired = CS1_SERVERS.every(s => shares[s].ci95 !== null && shares[s].ci95![1] < CS1_BARS.system_share);
    return {
      rule: 4, status: fired ? 'fired' : 'not fired',
      reason: `upper ends of the servers' system share of total at ${r0}: ${CS1_SERVERS.map(s => `${s} ${shares[s].ci95 ? shares[s].ci95![1].toFixed(3) : 'not defined'}`).join(', ')}, against ${CS1_BARS.system_share}`,
      numbers: { reader: r0, shares },
    };
  };

  const rule5 = (): Cs1Rule => {
    const need = missing([CS1_GBRAIN]);
    if (need.length) return notEvaluated(5, need);
    const present = CS1_COMPARED.filter(s => prepared.has(s));
    const comparisons = Object.fromEntries(present.map(s => [s, {
      with_hosting: ratio(readerStat(s, P, r0, 'total'), readerStat(CS1_GBRAIN, P, r0, 'total')),
      without_hosting: ratio(readerStat(s, P, r0, 'total_without_hosting'), readerStat(CS1_GBRAIN, P, r0, 'total_without_hosting')),
    }]));
    const firing = present.filter(s => above(comparisons[s].with_hosting, CS1_BARS.total_ratio));
    return {
      rule: 5, status: firing.length ? 'fired' : 'not fired',
      reason: firing.length ? `total at least ${CS1_BARS.total_ratio} times gbrain's: ${firing.join(', ')}` : `no compared system's total is at least ${CS1_BARS.total_ratio} times gbrain's`,
      numbers: { reader: r0, firing, comparisons, not_present: CS1_COMPARED.filter(s => !prepared.has(s)) },
    };
  };

  return {
    method: `paired cluster bootstrap over ${ids.length} worlds, ${draws.length} resamples, seed ${inp.seed ?? CS1_SEED}, 95% percentile intervals; hosting and the idle rate held fixed outside the resample; decisions at the heavy profile and ${r0}`,
    readers: [...readers], worlds: ids, ladder: inp.ladder,
    systems,
    full_context: inp.full_context ? Object.fromEntries(Object.entries(inp.full_context).map(([r, fc]) => [r, Object.fromEntries(CS1_PROFILE_NAMES.map(p => [p, cs1FullContext(fc, p)])) as Record<Cs1Profile, ReturnType<typeof cs1FullContext>>])) : null,
    not_run: [...(inp.not_run ?? [])],
    rules: [rule1(), rule2(), rule3(), rule4(), rule5()],
  };
}

export type Cs1Result = ReturnType<typeof cs1Aggregate>;

const cs1Usd = (v: number) => v === 0 ? '$0' : Math.abs(v) >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : Math.abs(v) >= 1 ? `$${v.toFixed(2)}` : Math.abs(v) >= 0.0001 ? `$${Number(v.toPrecision(2))}` : 'under $0.0001';
const cs1Duration = (ms: number | null) => ms === null ? 'more than 10 minutes' : ms < 1_000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;

/**
 * README's cost-and-speed table (preregistration, "README"): one row per run system, then the full-context range, then
 * not-run rows with their reasons; every row names its build and measurement date from `rows`. Dollars are a
 * month at the profile (heavy unless given), with 95% intervals in brackets; a write-to-queryable percentile that lands
 * on a miss reads "more than 10 minutes".
 */
export function renderCs1Table(res: Cs1Result, rows: Readonly<Record<string, { build: string; date: string }>>, profile: Cs1Profile = 'heavy'): string {
  const [r0, ...rest] = res.readers;
  const named = [...res.systems.map(s => s.system), ...(res.full_context ? ['baseline-full-context'] : [])];
  const unnamed = named.filter(s => !rows[s]);
  if (unnamed.length) throw new Error(`cost-speed table: every row names its build and date; missing ${unnamed.join(', ')}`);
  const withCi = (e: { usd: number; ci95: Interval | null }) => e.ci95 ? `${cs1Usd(e.usd)} (${cs1Usd(e.ci95[0])} to ${cs1Usd(e.ci95[1])})` : cs1Usd(e.usd);
  const perCorrect = (c: { usd: number | null; ci95: Interval | null; note: string | null }) => c.usd === null ? 'no correct answers' : c.ci95 ? withCi({ usd: c.usd, ci95: c.ci95 }) : `${cs1Usd(c.usd)} (interval not defined)`;
  const percentileCell = (p: Cs1Result['systems'][number]['probes'], key: 'p50' | 'p95') => {
    if (!p) return 'not measured';
    if (!p.counted) return 'no counted probes';
    const ci = p[`${key}_ci95`];
    return `${cs1Duration(p[`${key}_ms`])}${ci ? ` (${cs1Duration(ci[0])} to ${cs1Duration(ci[1])})` : ''}`;
  };
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const readerHeads = [r0, ...rest];
  const header = ['System', 'System cost a month', ...readerHeads.map(r => `Answer model a month, ${r}`), `Total a month, ${r0}`, ...readerHeads.map(r => `Cost per correct answer, ${r}`), 'Write to queryable, p50', 'Write to queryable, p95', 'Build', 'Measured'];
  const runRows = res.systems.map(s => {
    const p = s.profiles[profile];
    return [s.system, withCi(p.system), ...readerHeads.map(r => withCi(p.readers[r].reader)), withCi(p.readers[r0].total), ...readerHeads.map(r => perCorrect(p.readers[r].cost_per_correct)), percentileCell(s.probes, 'p50'), percentileCell(s.probes, 'p95'), rows[s.system].build, rows[s.system].date];
  });
  const range = (fc: ReturnType<typeof cs1FullContext> | undefined, pick: (f: ReturnType<typeof cs1FullContext>) => { warm: number | null; cold: number | null } | null) => {
    if (!fc) return 'not measured';
    if (!fc.fits) return "doesn't fit";
    const v = pick(fc);
    if (!v) return fc.note ?? 'not priced';
    return `${v.warm === null ? 'warm not priced' : cs1Usd(v.warm)} to ${v.cold === null ? 'cold not priced' : cs1Usd(v.cold)} (warm to cold)`;
  };
  const fcRow = res.full_context ? [[
    'baseline-full-context', '$0',
    ...readerHeads.map(r => range(res.full_context![r]?.[profile], f => ({ warm: f.warm_usd, cold: f.cold_usd }))),
    range(res.full_context[r0]?.[profile], f => ({ warm: f.warm_usd, cold: f.cold_usd })),
    ...readerHeads.map(r => range(res.full_context![r]?.[profile], f => f.cost_per_correct ? { warm: f.cost_per_correct.warm_usd, cold: f.cost_per_correct.cold_usd } : null)),
    'no write', 'no write', rows['baseline-full-context'].build, rows['baseline-full-context'].date,
  ]] : [];
  const notRun = res.not_run.map(n => [n.system, `not run: ${n.reason}`, ...Array(header.length - 4).fill(''), rows[n.system]?.build ?? '', rows[n.system]?.date ?? '']);
  return [header, header.map(() => '---'), ...runRows, ...fcRow, ...notRun].map(r => `| ${r.map(c => cell(String(c))).join(' | ')} |`).join('\n') + '\n';
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const json = argv.includes('--json');
  try {
    if (argv.includes('--watch')) {
      const manifest = one('--campaign'), state = one('--state');
      if (!manifest || !state) throw refuse({ code: 'USAGE', message: '--watch needs --campaign <manifest.json> and --state <dir>', why: 'progress.md summarizes one campaign\'s state directory',
        fix: { next: 'run', argv: ['bun', 'eval/runner/cost-speed.ts', '--watch', '--campaign', '<manifest.json>', '--state', '<dir>'] } });
      const out = one('--out') ?? join(state, 'progress.md');
      const interval = Number(one('--interval-s') ?? 60) * 1000;
      for (;;) {
        writeFileSync(out, await renderProgress(manifest, state, { vms: vmsByOwner }));
        if (argv.includes('--once')) { console.log(json ? JSON.stringify({ progress: out }) : `wrote ${out}`); break; }
        await Bun.sleep(interval);
      }
    } else {
      const dir = one('--cell');
      if (!dir) throw refuse({ code: 'USAGE', message: 'give --cell <cell output dir> (or --watch)', why: 'cost and speed are computed per cell', fix: { next: 'run', argv: ['bun', 'eval/runner/cost-speed.ts', '--cell', '<dir>', '--json'] } });
      const inp = loadCell(dir, { usage: one('--usage'), answers: one('--answers'), capability: one('--capability') });
      const num = (n: string) => one(n) !== undefined ? Number(one(n)) : null;
      const r = costSpeed({ ...inp, messages: num('--messages') ?? inp.messages, ingestedTokens: num('--ingested-tokens') ?? inp.ingestedTokens, vmUsdPerHour: num('--vm-usd-per-hour') });
      const text = json ? JSON.stringify(r, null, 2) + '\n' : renderCostSpeed(r);
      if (one('--out')) writeFileSync(one('--out')!, text); else process.stdout.write(text);
    }
  } catch (e) {
    if (e instanceof ScoreboardError) { process.stderr.write((json ? JSON.stringify(e.op, null, 2) : renderMessage(e.op)) + '\n'); process.exit(exitCodeOf(e.op)); }
    console.error(`[cost-speed] ${(e as Error).message}`);
    process.exit(2);
  }
}


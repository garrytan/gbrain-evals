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
 * Three different dollar numbers, never mixed: campaign spend (what the proxy
 * billed this cell, with reserved-unsettled dollars apart), cached-replay
 * spend (the list price of answers this run reused from the answer cache or
 * frozen contexts instead of paying again), and projected workload cost.
 *
 * Watch mode rewrites progress.md for a campaign: cells planned, running,
 * done and invalid; spend per block against its cap; VMs by owner (from the
 * repository runner's `usage`, when a Ubicloud token is present).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { percentile } from './metrics.ts';
import { priceRequest } from './budget-ledger.ts';
import type { UsageLine } from './metering-proxy.ts';
import { refuse, ScoreboardError, renderMessage, exitCodeOf } from './scoreboard-errors.ts';

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
export function usagePhase(u: UsageLine): 'ingest' | 'retrieval' | 'answer' | 'judge' | 'other' {
  if (u.route_class === 'judge' || u.slot === 'judge') return 'judge';
  if (u.bucket === 'harness' || u.route_class === 'reader' || u.slot === 'harness') return 'answer';
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
        by_phase: { ingest: ingestUsd, retrieval: retrievalUsd, answer: answerUsd, judge: sum(by('judge')), other: sum(by('other')) }, requests: forwarded.length, refused: inp.usage.length - forwarded.length },
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


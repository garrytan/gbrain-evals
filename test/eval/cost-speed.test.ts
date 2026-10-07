/**
 * Cost and speed columns (eval/runner/cost-speed.ts): the commit/background
 * split from proxy phase tags for synchronous systems only, per-1,000-message
 * and per-million-token normalization, latency percentiles, the two monthly
 * workloads, the three separate dollar numbers, and the --watch progress page.
 * Keyless fixtures only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { costSpeed, renderCostSpeed, renderProgress, usagePhase, WORKLOADS } from '../../eval/runner/cost-speed.ts';
import type { UsageLine } from '../../eval/runner/metering-proxy.ts';
import { Campaign } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'cost-speed-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });

const line = (over: Partial<UsageLine>): UsageLine => ({ at: '2026-10-06T00:00:00Z', key: 'slot:x', provider: 'openai', route: '/v1/chat/completions', model: 'gpt-4.1-mini', outcome: 'forwarded', status: 200, actual_usd: 0, ...over });
const rows = (latencies: number[]) => latencies.map((ms, i) => ({ id: `q${i}`, outcome: 'scored', latency_ms: ms, qa_context: { tokens: 8000 }, qa_input_tokens: 9000 }));

/** Ingest: 4 LLM calls ($0.005 each: two commit, one background, one late unattributed) and 2 embedding calls ($0.001 each); 2 retrievals; 2 reader and 2 judge calls. */
const usage: UsageLine[] = [
  line({ key: 'ingest:ns-a', slot: 'ext-graph-pipeline', phase: 'commit', bucket: 'attributed', actual_usd: 0.005 }),
  line({ key: 'ingest:ns-a', slot: 'ext-graph-pipeline', phase: 'commit', bucket: 'attributed', actual_usd: 0.005 }),
  line({ key: 'ingest:ns-a', slot: 'ext-graph-pipeline', phase: 'background', bucket: 'attributed', actual_usd: 0.005 }),
  line({ key: 'slot:ext-graph-pipeline', slot: 'ext-graph-pipeline', phase: null, bucket: 'unattributed-background', actual_usd: 0.005, charged_reservation: true }),
  line({ key: 'ingest:ns-a', slot: 'ext-graph-pipeline', phase: 'commit', bucket: 'attributed', route: '/v1/embeddings', model: 'text-embedding-3-large', actual_usd: 0.001 }),
  line({ key: 'ingest:ns-a', slot: 'ext-graph-pipeline', phase: 'background', bucket: 'attributed', route: '/v1/embeddings', model: 'text-embedding-3-large', actual_usd: 0.001 }),
  line({ key: 'q:q0:vendor-default', slot: 'ext-graph-pipeline', bucket: 'attributed', actual_usd: 0.002 }),
  line({ key: 'q:q1:vendor-default', slot: 'ext-graph-pipeline', bucket: 'attributed', actual_usd: 0.002 }),
  line({ key: 'slot:harness', slot: 'harness', bucket: 'harness', route_class: 'reader', actual_usd: 0.01 }),
  line({ key: 'slot:harness', slot: 'harness', bucket: 'harness', route_class: 'reader', actual_usd: 0.01 }),
  line({ key: 'slot:judge', slot: 'judge', bucket: 'harness', route_class: 'judge', actual_usd: 0.0001 }),
  line({ key: 'slot:judge', slot: 'judge', bucket: 'harness', route_class: 'judge', actual_usd: 0.0001 }),
  line({ key: 'slot:x', outcome: 'refused', status: 401 }),
];

describe('cost-speed', () => {
  test('a synchronous system splits commit from background by phase tags, and late unattributed work counts as background', () => {
    const r = costSpeed({ rows: rows([100, 200]), usage, capability: { readiness: 'synchronous: /ingest returns after extraction' }, messages: 2000, ingestedTokens: 500_000 });
    expect(r.ingest.split).toEqual({ mode: 'synchronous: split by phase', commit_usd: 0.011, background_usd: 0.011, late_unattributed_usd: 0.005 });
  });

  test('a queued system reports the ingest-phase total, labeled not split', () => {
    const r = costSpeed({ rows: rows([100]), usage, capability: { readiness: 'queued: /ingest queues the session' }, messages: 2000 });
    expect(r.ingest.split).toMatchObject({ mode: expect.stringContaining('not split'), ingest_phase_usd: 0.022 });
    expect(costSpeed({ rows: rows([1]), usage: usage.map(u => ({ ...u, phase: null })), capability: { readiness: 'synchronous' }, messages: 1 }).ingest.split.mode).toContain('marked no ingest phases');
  });

  test('per-1,000-message and per-million-token normalization', () => {
    const r = costSpeed({ rows: rows([100, 200]), usage, capability: { readiness: 'synchronous' }, messages: 2000, ingestedTokens: 500_000 });
    expect(r.ingest).toMatchObject({ messages: 2000, ingested_tokens: 500_000, llm_calls: 4, embedding_calls: 2, usd: 0.022, llm_usd: 0.02, embedding_usd: 0.002,
      llm_calls_per_1k_messages: 2, usd_per_1k_messages: 0.011, embedding_usd_per_1k_messages: 0.001, llm_calls_per_million_tokens: 8, usd_per_million_tokens: 0.044 });
    expect(costSpeed({ rows: rows([1]), usage }).ingest.usd_per_1k_messages).toBeNull();
  });

  test('latency percentiles: retrieval from rows, end to end with the answer latency; tokens per question', () => {
    const answers = [{ question_id: 'q0', latency_ms: 900, provider_input_tokens: 9100 }, { question_id: 'q1', latency_ms: 1800, provider_input_tokens: 9300 }, { question_id: 'q2', latency_ms: null }];
    const r = costSpeed({ rows: rows([100, 200, 300]), usage, answers });
    expect(r.latency_ms.retrieval).toEqual({ p50: 200, p95: 290, n: 3 });
    expect(r.latency_ms.end_to_end).toEqual({ p50: 1500, p95: 1950, n: 2 });
    expect(r.tokens_per_question).toEqual({ delivered_evidence: 8000, reader_input: 9200 });
    expect(costSpeed({ rows: rows([5]), usage }).latency_ms.end_to_end).toBeNull();
  });

  test('monthly workloads from unit costs; the judge is campaign spend, not workload cost', () => {
    const r = costSpeed({ rows: rows([100, 200]), usage, messages: 2000, vmUsdPerHour: 0.1 });
    expect(r.per_question_usd).toEqual({ retrieval: 0.002, answer: 0.01 });
    expect(r.spend.projected_monthly.personal).toEqual({ ...WORKLOADS.personal, ingest_usd: 0.022, retrieval_usd: 0.6, answer_usd: 3, vm_usd: 73, total_usd: 76.622 });
    expect(r.spend.projected_monthly.team).toMatchObject({ ingest_usd: 0.55, retrieval_usd: 20, answer_usd: 100, total_usd: 193.55 });
    expect(r.spend.campaign.by_phase).toEqual({ ingest: 0.022, retrieval: 0.004, answer: 0.02, judge: 0.0002, other: 0 });
    expect(usagePhase(line({ slot: 'judge', route_class: 'judge' }))).toBe('judge');
  });

  test('campaign spend (billed apart from reserved-unsettled), cached-replay spend and projected cost stay three numbers', () => {
    const answers = [{ question_id: 'q0', reader: 'openai:gpt-4o-mini', cached: true, usage: { input: 1_000_000, output: 100_000 } }, { question_id: 'q1', reader: 'openai:gpt-4o-mini', usage: { input: 5, output: 5 } }];
    const r = costSpeed({ rows: rows([1, 2]), usage, answers, messages: 2000 });
    expect(r.spend.campaign).toMatchObject({ billed_usd: 0.0412, reserved_unsettled_usd: 0.005, requests: 12, refused: 1 });
    expect(r.spend.cached_replay_usd).toBe(0.21);
    expect(r.spend.projected_monthly.personal!.total_usd).not.toBe(r.spend.campaign.billed_usd);
    expect(costSpeed({ rows: rows([1]), usage, answers: [{ reader: 'openai:no-such-model', cached: true, usage: { input: 1, output: 1 } }] }).spend.cached_replay_usd).toBeNull();
    expect(renderCostSpeed(r)).toContain('| Campaign spend: billed / reserved-unsettled | $0.0412 / $0.005 |');
  });

  test('write-start-to-queryable percentiles come from readiness probes', () => {
    expect(costSpeed({ rows: rows([1]), usage, readiness: [1000, 2000, 3000, 4000] }).write_start_to_queryable_ms).toEqual({ p50: 2500, p95: 3850, n: 4 });
    expect(costSpeed({ rows: rows([1]), usage, receipt: { ingest: { readiness_samples_ms: [10, 30] } } }).write_start_to_queryable_ms).toEqual({ p50: 20, p95: 29, n: 2 });
  });
});

describe('progress.md', () => {
  test('--watch --once writes cells planned, running, done and invalid, spend per block against its cap, and the VM section', async () => {
    const dir = join(tmp, 'progress');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard', cap_usd: 20, ledger: join(dir, 'l.sqlite'), executes: ['bun.lock'],
      blocks: { T1: { estimate_usd: 8, cap_usd: 12 } },
      cells: ['a', 'b', 'c', 'd'].map(id => ({ id, system: 'fake', benchmark: 'locomo', config: 'common', lease_usd: 2, command: 'true', block: 'T1' })) }));
    const c = new Campaign(join(dir, 'm.json'), join(dir, 'state'));
    c.init();
    c.reserve('a');
    const b = c.reserve('b');
    c.abandon(b.lease_id, 'VM lost');
    closeLedgers();
    const p = Bun.spawnSync([process.execPath, 'eval/runner/cost-speed.ts', '--watch', '--once', '--campaign', join(dir, 'm.json'), '--state', join(dir, 'state')], { cwd: ROOT, env: { ...process.env, UBICLOUD_API_TOKEN: '', UBICLOUD_API_KEY: '' } });
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    const md = readFileSync(join(dir, 'state', 'progress.md'), 'utf8');
    expect(md).toContain('| all | 4 | 1 | 0 | 1 | 2 |');
    expect(md).toContain('| T1 | $4.00 | $8.00 | $12.00 |');
    expect(md).toContain('$4.00 of it is leases charged at their full reservation');
    expect(md).toContain('(matches the freeze)');
    expect(md).toContain('## VMs by owner');
    expect(await renderProgress(join(dir, 'm.json'), join(dir, 'state'), { vms: async () => 'gbra49  2 VMs  8 vCPU' })).toContain('gbra49  2 VMs  8 vCPU');
  });
});

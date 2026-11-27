/**
 * Held-back write-to-queryable probes in the Q1 cell runner (cost and speed, amendment of 2026-11-24), keyless: a fake
 * system that embeds each write and each search through a real lease proxy with a dead upstream stand-in and placeholder
 * keys. The bulk import leaves the last sessions out; after it drains, a calibration window checks the probe label, then
 * each held-back session is written on an idle system and polled until found; a late find after the horizon is a late
 * miss. Probe searches are labelled probe, writes keep their write and background phases, and a read that also calls a
 * model shows up as an unlabelled route.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realizationId, runCell, type WriteProbe } from '../../eval/runner/q1/cell.ts';
import { estimateCell, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { MeteringProxy, type UsageLine } from '../../eval/runner/metering-proxy.ts';
import { dockerCli, dockerReading, parseBytes, spawnText } from '../../eval/runner/memory-qa/hosting-samples.ts';
import { cs1Bucket, cs1Load, hostingOf } from '../../eval/runner/cs1-load.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';
import { FileAgentSystem } from '../../eval/runner/systems/file-agent.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike } from '../../eval/runner/memory-qa/qa-v2.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'cost-speed-cell-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });
const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path: 'test/eval/fixtures/q1-cell/locomo-shaped.json', sha256: 'fixture' }], revision: 'repo', license: 'MIT' } };
const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
const reader: ChatLike = { async chat() { return { text: 'The history does not say.', input_tokens: 10, output_tokens: 5, cached: false, ...NO_META }; } };
const judge: ChatLike = { async chat() { return { text: 'no', input_tokens: 10, output_tokens: 1, cached: false, ...NO_META }; } };
const KEYS = { OPENAI_API_KEY: 'placeholder', ANTHROPIC_API_KEY: 'placeholder', VOYAGE_API_KEY: 'placeholder' };
const LATE = new Set(['conv-a']);

/** Embeds every write and every search on its own slot; optionally expands each search with a model call, and hides the session with a turn reading `hide` for `hideMs` after its write. */
class EmbeddingFake extends FakeMemorySystem {
  private written = new Map<string, number>();
  private hidden: string | null = null;
  constructor(private readonly provider: string, private readonly opts: { expand?: boolean; hide?: string; hideMs?: number; trigger?: boolean; triggerExit?: number; fail?: string; undrained?: boolean } = {}) { super(); }
  async finishIngest() {
    const f = await super.finishIngest();
    return this.opts.undrained ? { ...f, raw: { ...(f.raw ?? {}), background_liabilities: { drained: false, pending_jobs: { facts: 2 } } } } : f;
  }
  readonly triggered: string[] = [];
  async trigger(ns: string, job: string) {
    this.triggered.push(`${ns}:${job}`);
    await this.post('chat/completions', { model: 'gpt-4.1-mini', max_tokens: 50, messages: [{ role: 'user', content: 'upkeep round' }] });
    return { job, exit: this.opts.triggerExit ?? 0, ...(this.opts.triggerExit ? { stderr_tail: 'maintain: lock held' } : {}) };
  }
  private post(path: string, body: unknown) {
    return fetch(`${this.provider}/fake/openai/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dummy' }, body: JSON.stringify(body) });
  }
  async ingestSession(ns: string, session: Parameters<FakeMemorySystem['ingestSession']>[1], when: string | null) {
    await this.post('embeddings', { model: 'text-embedding-3-small', input: session.turns.map(t => `${t.speaker}: ${t.content}`) });
    this.written.set(session.source_id, performance.now());
    if (this.opts.hide && session.turns.some(t => t.content === this.opts.hide)) this.hidden = session.source_id;
    if (this.opts.fail && session.turns.some(t => t.content === this.opts.fail)) return { items_created: 0, warnings: [], errors: ['extraction failed'], completeness: 'degraded' as const };
    return super.ingestSession(ns, session, when);
  }
  async retrieve(ns: string, q: Parameters<FakeMemorySystem['retrieve']>[1], policy: Parameters<FakeMemorySystem['retrieve']>[2]) {
    if (this.opts.expand) await this.post('chat/completions', { model: 'gpt-4.1-mini', max_tokens: 50, messages: [{ role: 'user', content: `Rewrite: ${q.text}` }] });
    await this.post('embeddings', { model: 'text-embedding-3-small', input: q.text });
    const res = await super.retrieve(ns, q, policy);
    const h = this.hidden;
    const hidden = h !== null && performance.now() - this.written.get(h)! < (this.opts.hideMs ?? 0);
    return hidden ? { ...res, items: res.items.filter(i => !i.source_ids.includes(h)) } : res;
  }
}

function heldBackDef(): CellDefinition {
  const id = 's3.ext-graph-pipeline.recipe';
  const base: Omit<CellDefinition, 'estimate'> = {
    schema: 'gbrain-evals/q1-cell/v1', id, set: 'S3', block: 'T2-S3', benchmark: 'locomo', split: 'dev', selection: { kind: 'all' }, exclusions: [], system: 'ext-graph-pipeline',
    configuration: 'recipe', runner: 'shim', ingest_replicate: 1, effort: 'medium', canonical_instrument: 'locomo', probes: { sample: 1, seed: 'cs', held_back: 2 }, shards: 1, expected_hours: 1, hosting_samples: true,
    idle_window: { worlds: ['conv-b'], ms: 3_600_000, min_ms: 1_800_000, max_ms: 7_200_000, jobs: [{ job: 'consolidation', cadence_minutes: 60, source: 'invented' }] },
    arms: [{ cell_id: `${id}.component-b8000`, set: 'S3', arm: 'component', policy: 'fixed-evidence', mode: 'packed', id: 'component-b8000', budget: 8000, questions: null, readers: ['anthropic:claude-opus-5-5'],
      reader_replicates: {}, frontier: null, judge_repeats: null, label: 'component' }],
  };
  return { ...base, estimate: estimateCell(base) };
}

/** One held-back cell through a real lease proxy; with `idleCall` the stack also calls a model on its own once questions start, so the idle window has something to meter. */
async function run(name: string, opts: ConstructorParameters<typeof EmbeddingFake>[1], idleCall = false) {
  const triggerJob = { job: 'daily upkeep round', cadence_minutes: 1440, source: 'invented', trigger: 'maintain' };
  const upstream = (async (url: RequestInfo | URL) => String(url).endsWith('/chat/completions')
    ? Response.json({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } })
    : Response.json({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 100, total_tokens: 100 } })) as unknown as typeof fetch;
  const usageLog = join(tmp, `${name}.ndjson`);
  const lease = BudgetRun.openLease({ runId: name, leaseUsd: 1, ledgerPath: join(tmp, `${name}.sqlite`) });
  const proxy = new MeteringProxy({ fetchImpl: upstream, policy: { lease, env: KEYS, usageLog } });
  proxy.start();
  const base = `http://127.0.0.1:${proxy.port}`;
  const saved = { ...process.env };
  process.env.GBRAIN_EVALS_QA_CACHE = join(tmp, `qa-cache-${name}`);
  try {
    const plain = heldBackDef();
    const def = opts?.trigger ? { ...plain, idle_window: { ...plain.idle_window!, jobs: [...plain.idle_window!.jobs, triggerJob] } } : plain;
    const out = join(tmp, name);
    const system = new EmbeddingFake(base, opts);
    const hostingRead = async () => ({ containers: [{ name: 'stack-db-1', mem_bytes: 2e8 }], volumes: [{ name: 'stack_db-data', bytes: 5e7 }] });
    let timer: ReturnType<typeof setInterval> | null = null;
    const chatter = () => { void fetch(`${base}/fake/openai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dummy' }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_tokens: 50, messages: [{ role: 'user', content: 'consolidate' }] }) }); };
    const reading: ChatLike = { chat(...a) { if (idleCall && !timer) timer = setInterval(chatter, 40); return reader.chat(...a); } };
    let res;
    try { res = await runCell(def, { out, providerProxy: base, probeIntervalMs: 5, probeTimeoutMs: 150, idleQuietMs: 40, idleMaxMs: 3000, idleWindowMs: 150, hostingIntervalMs: 20 }, { corpus, system, reader: reading, judge, hostingRead }); }
    finally { if (timer) clearInterval(timer); }
    const events = readFileSync(join(out, 'runs', def.id, 'realizations.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'ingested');
    const usage = readFileSync(usageLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as UsageLine);
    return { def, res, events, usage, out, system };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    proxy.stop();
  }
}

describe('held-back probes', () => {
  beforeEach(() => closeLedgers());

  test('bulk import leaves the last sessions out; each held-back session is written on an idle system and found; probe searches are labelled probe and writes keep their phases', async () => {
    const hide = raw.conversations.find(c => LATE.has(c.id))!.sessions.at(-1)!.turns[0].content;
    const { def, res, events, usage, out } = await run('held-back', { hide, hideMs: 600 });
    expect(res.status).not.toBe('invalid');
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.ingest.sessions).toBe(5);
      const probes = e.write_probes as WriteProbe[];
      const bulk = probes.filter(p => p.kind === 'bulk'), held = probes.filter(p => p.kind === 'held-back');
      expect(bulk).toHaveLength(2);
      expect(held).toHaveLength(2);
      for (const p of held) expect([p.started_idle, p.polls > 0, p.errored_polls]).toEqual([true, true, 0]);
      expect(e.calibration).toMatchObject({ drained: true, started_idle: true, searches: 3, errored: 0, idle: true, unlabelled_routes: [] });
      const lastHeld = held.at(-1)!;
      if (LATE.has(e.conversation)) expect([lastHeld.status, lastHeld.miss, lastHeld.miss_idle]).toEqual(['missed', 'late', true]);
      else expect(held.every(p => p.status === 'found' && p.write_to_queryable_ms! >= 0 && p.miss === null && p.miss_idle === null)).toBe(true);
      const file = readFileSync(join(out, 'runs', def.id, 'r', realizationId(def.id, e.conversation, 0), 'write-probes.ndjson'), 'utf8').trim().split('\n');
      expect(file).toHaveLength(4);
    }
    const ok = usage.filter(l => l.outcome === 'forwarded');
    const writes = ok.filter(l => l.slot === 'fake' && l.phase === 'commit');
    expect(writes).toHaveLength(15);
    expect(writes.filter(l => l.key.endsWith('#held-back'))).toHaveLength(6);
    expect(writes.every(l => l.key.startsWith('ingest:'))).toBe(true);
    const probeLines = ok.filter(l => l.phase === 'probe');
    expect(probeLines.length).toBeGreaterThanOrEqual(3 * (2 + 2 + 3));
    expect(probeLines.every(l => l.route === '/v1/embeddings')).toBe(true);
    expect(ok.some(l => l.key.startsWith('calibration:') && l.phase !== 'probe')).toBe(false);
  }, 60_000);

  test('hosting samples skip the bulk import and cover the probes, the questions and the idle window; the idle window meters its calls on its own key', async () => {
    const { def, out, usage } = await run('idle', {}, true);
    const samples = readFileSync(join(out, 'runs', def.id, 'hosting.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const stages = new Set(samples.map(s => s.stage.split(':')[0]));
    expect(stages).toEqual(new Set(['drained', 'probes', 'questions', 'idle']));
    expect(samples.every(s => s.containers[0].mem_bytes === 2e8 && s.harness_rss_bytes > 0 && !s.error)).toBe(true);
    const rid = realizationId(def.id, 'conv-b', 0);
    const idle = JSON.parse(readFileSync(join(out, 'runs', def.id, 'r', rid, 'idle.json'), 'utf8'));
    expect(idle).toMatchObject({ realization_id: rid, conversation: 'conv-b', planned_ms: 150 });
    expect(idle.ms).toBeGreaterThanOrEqual(150);
    expect(idle.requests).toBeGreaterThan(0);
    expect(usage.filter(l => l.key === `tail:idle:${rid}`).length).toBe(idle.requests);
    for (const c of ['conv-a', 'conv-c']) expect(() => readFileSync(join(out, 'runs', def.id, 'r', realizationId(def.id, c, 0), 'idle.json'))).toThrow();
  }, 60_000);

  test('a held-back write that reports errors is an errored probe with no polls, never a miss; tokens are counted on the profile\'s content basis', async () => {
    const fail = raw.conversations.find(c => LATE.has(c.id))!.sessions.at(-1)!.turns[0].content;
    const { events } = await run('write-failed', { fail });
    for (const e of events) {
      const held = (e.write_probes as WriteProbe[]).filter(p => p.kind === 'held-back');
      if (LATE.has(e.conversation)) {
        expect(held.at(-1)).toMatchObject({ status: 'errored', polls: 0, errored_polls: 0, miss: null });
        expect(held.at(-1)!.poll_errors[0]).toStartWith('write failed: ');
      } else expect(held.every(p => p.status === 'found')).toBe(true);
      expect(e.ingest.content_tokens).toBeGreaterThan(0);
      expect(e.ingest.content_tokens).toBeLessThan(e.ingest.ingested_tokens);
      expect(e.ingest.bulk_wall_ms).toBeLessThanOrEqual(e.ingest.wall_ms);
    }
  }, 60_000);

  test('a /finish that is ready with undrained background work starts no probe or calibration idle', async () => {
    const { events } = await run('undrained', { undrained: true });
    for (const e of events) {
      expect(e.calibration).toMatchObject({ drained: false, started_idle: false });
      expect((e.write_probes as WriteProbe[]).filter(p => p.kind === 'held-back').every(p => !p.started_idle)).toBe(true);
    }
  }, 60_000);

  test("a job longer than the window runs once through its trigger before the window, metered on its own key and kept out of the window's dollars", async () => {
    const { def, out, usage, system } = await run('trigger', { trigger: true });
    const rid = realizationId(def.id, 'conv-b', 0);
    const idle = JSON.parse(readFileSync(join(out, 'runs', def.id, 'r', rid, 'idle.json'), 'utf8'));
    expect(idle.triggers).toHaveLength(1);
    expect(idle.triggers[0]).toMatchObject({ job: 'daily upkeep round', trigger: 'maintain', cadence_minutes: 1440, requests: 1, result: { job: 'maintain', exit: 0 }, error: null });
    expect(idle.triggers[0].usd).toBeGreaterThan(0);
    expect(system.triggered).toHaveLength(1);
    const lines = usage.filter(l => l.key === `tail:trigger:${rid}:maintain`);
    expect(lines.map(l => l.route)).toEqual(['/v1/chat/completions']);
    expect(idle.requests).toBe(usage.filter(l => l.key === `tail:idle:${rid}`).length);
    expect(usage.filter(l => l.key === `tail:idle:${rid}` && l.route === '/v1/chat/completions')).toHaveLength(0);
    for (const c of ['conv-a', 'conv-c']) expect(() => readFileSync(join(out, 'runs', def.id, 'r', realizationId(def.id, c, 0), 'idle.json'))).toThrow();
  }, 60_000);

  test('a trigger that exits nonzero is recorded as failed, and the loader names it so no idle cost is priced without it', async () => {
    const { def, out, usage } = await run('trigger-exit', { trigger: true, triggerExit: 1 });
    const rid = realizationId(def.id, 'conv-b', 0);
    const idle = JSON.parse(readFileSync(join(out, 'runs', def.id, 'r', rid, 'idle.json'), 'utf8'));
    expect(idle.triggers[0].error).toBe('trigger maintain exited 1: maintain: lock held');
    const ladder = { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 };
    const loaded = cs1Load([{ dir: out, usage }], { cells: new Map([[def.id, def.system]]), questions: new Map(), ladder, stacks: { [def.system]: 'stack' } });
    expect(loaded.failed_triggers).toEqual([`${def.id} conv-b: daily upkeep round`]);
  }, 60_000);

  test('the loader puts every billed dollar in one bucket of one world, and the buckets sum back to the usage log', async () => {
    const { def, out, usage } = await run('load', { trigger: true });
    const questions = new Map(corpus.questions.map(q => [q.id, { id: q.id, bg1: { gold_values: ['history does not say'], stale_values: [], decoy_values: [], ordered: false } as never }]));
    const ladder = { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 };
    const { input, problems, checks } = cs1Load([{ dir: out, usage }], { cells: new Map([[def.id, def.system]]), questions, ladder, stacks: { [def.system]: 'stack' } });
    expect(problems).toEqual([]);
    const billed = usage.reduce((n, l) => n + (l.actual_usd ?? 0), 0);
    expect(checks.sum_back.billed_usd).toBeCloseTo(billed, 12);
    expect(Math.abs(checks.sum_back.difference_usd)).toBeLessThan(1e-12);
    expect(checks.sum_back.unattributed_usd).toBe(0);
    const [sys] = input.systems;
    expect(sys.worlds.map(w => w.world)).toEqual(['conv-a', 'conv-b', 'conv-c']);
    const perWorld = sys.worlds.reduce((n, w) => n + w.usd.write + w.usd.background + w.usd.read + w.usd.probe + (w.idle?.usd ?? 0) + (w.idle?.triggers ?? []).reduce((m, t) => m + t.usd, 0), 0);
    expect(perWorld).toBeCloseTo(billed, 12);
    expect(checks.by_bucket.write).toBeCloseTo(sys.worlds.reduce((n, w) => n + w.usd.write, 0), 12);
    for (const w of sys.worlds) {
      expect([w.usd.write > 0, w.usd.probe > 0, w.probes!.length, w.bulk_probes!.length, w.sessions]).toEqual([true, true, 2, 2, 5]);
      expect(w.ingested_tokens).toBeGreaterThan(0);
      expect(w.readers['claude-opus-5-5'].classes.every(c => c === 'correct')).toBe(true);
    }
    const b = sys.worlds.find(w => w.world === 'conv-b')!;
    expect(b.idle!.window_ms).toBeGreaterThanOrEqual(150);
    expect(b.idle!.triggers).toEqual([{ job: 'daily upkeep round', usd: checks.by_bucket.trigger, cadence_minutes: 1440 }]);
    expect(b.idle!.triggers![0].usd).toBeGreaterThan(0);
    expect(sys.worlds.filter(w => w.idle).length).toBe(1);
    expect(sys.hosting).toMatchObject({ resident_bytes: 2e8, disk_bytes: 5e7 });
    expect(sys.hosting!.disk_tokens).toBe(sys.worlds.reduce((n, w) => n + w.ingested_tokens, 0));
    appendFileSync(join(out, 'runs', def.id, 'hosting.ndjson'), JSON.stringify({ at: new Date().toISOString(), stage: 'late', harness_rss_bytes: 1, containers: [], volumes: [], error: 'docker stats exited 1: permission denied' }) + '\n');
    const failed = cs1Load([{ dir: out, usage }], { cells: new Map([[def.id, def.system]]), questions, ladder, stacks: { [def.system]: 'stack' } });
    expect(failed.problems.join('\n')).toMatch(/hosting samples failed \(docker stats exited 1: permission denied\)/);
  }, 60_000);

  test('a read that also calls a model shows up in the calibration window as a route the probe label misses', async () => {
    const { events } = await run('expanding', { expand: true });
    for (const e of events) expect(e.calibration.unlabelled_routes).toEqual(['openai/v1/chat/completions']);
  }, 60_000);
});

describe('loader keys and hosting', () => {
  test('each meter key maps to one bucket and world', () => {
    const keys = { ns: new Map([['ns-a', 'w1']]), rid: new Map([['ab12', 'w1']]), answer: new Map([['0123456789abcdef', 'w1']]) };
    const b = (key: string, phase: string | null = null) => cs1Bucket({ key, phase } as never, keys);
    expect([b('ingest:ns-a', 'commit'), b('ingest:ns-a#held-back', 'probe'), b('ingest:ns-a', null), b('calibration:ns-a'), b('probe:ns-a')]).toEqual([
      { bucket: 'write', conv: 'w1' }, { bucket: 'probe', conv: 'w1' }, { bucket: 'background', conv: 'w1' }, { bucket: 'probe', conv: 'w1' }, { bucket: 'probe', conv: 'w1' }]);
    expect([b('tail:ab12'), b('tail:idle:ab12'), b('tail:trigger:ab12:maintain'), b('q:w1:s1_updated:4:vendor-default'), b('read:0123456789abcdef'), b('read:ffffffffffffffff'), b('slot:sys')]).toEqual([
      { bucket: 'background', conv: 'w1' }, { bucket: 'idle', conv: 'w1' }, { bucket: 'trigger', conv: 'w1', job: 'maintain' }, { bucket: 'read', conv: 'w1' },
      { bucket: 'reader', conv: 'w1' }, { bucket: 'unattributed', conv: null }, { bucket: 'unattributed', conv: null }]);
    expect([b('answer:0123456789abcdef'), b('answer:ffffffffffffffff')]).toEqual([{ bucket: 'reader', conv: 'w1' }, { bucket: 'unattributed', conv: null }]);
  });
  // Value: protects=history growth compares the bulk import's first and last quarters only; fails_when=the last quarter's window takes in held-back writes, so their dollars inflate its rate against the bulk tokens; why_new=fresh-eyes reader of the cost-speed fix commits (F1); seam=cs1Load over a hand-built unit; no_claim=the cell writing these files
  test('history growth counts only the bulk import: a held-back write after it, however costly, leaves both quarters alone', () => {
    const dir = join(tmp, 'growth-unit'), cell = 'cs1-capacity.baseline-hybrid.baseline', rid = 'ab'.repeat(32);
    mkdirSync(join(dir, 'runs', cell, 'r', rid), { recursive: true });
    const at = (s: number) => new Date(Date.UTC(2026, 10, 25, 0, 0, s)).toISOString();
    writeFileSync(join(dir, 'runs', cell, 'realizations.ndjson'), JSON.stringify({ realization_id: rid, conversation: 'w1', event: 'ingested', at: at(100), ns: 'ns-a', ingest: { content_tokens: 8000, ingested_tokens: 8800, sessions: 10 } }) + '\n');
    writeFileSync(join(dir, 'runs', cell, 'r', rid, 'writes.ndjson'), Array.from({ length: 8 }, (_, i) => JSON.stringify({ i, source_id: `src-${i}`, start_at: at(i * 10), end_at: at(i * 10 + 1), content_tokens: 1000 })).join('\n') + '\n');
    const line = (key: string, s: number, usd: number, phase: string) => ({ key, at: at(s), actual_usd: usd, phase, slot: 'sys' }) as never;
    const bulk = Array.from({ length: 8 }, (_, i) => line('ingest:ns-a', i * 10 + 1, 0.001, 'commit'));
    const opts = { cells: new Map([[cell, 'baseline-hybrid']]), questions: new Map(), ladder: { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 } };
    const quarters = (usage: never[]) => cs1Load([{ dir, usage }], opts).input.systems[0].worlds[0].quarters;
    const plain = quarters(bulk);
    expect(plain).toEqual({ first_usd_per_mtok: 1, last_usd_per_mtok: 1 });
    expect(quarters([...bulk, line('ingest:ns-a#held-back', 90, 1, 'commit'), line('ingest:ns-a#held-back', 95, 1, 'background'), line(`tail:${rid}`, 99, 1, 'background')])).toEqual(plain);
    const lost = cs1Load([{ dir, usage: [...bulk, line(`tail:trigger:${rid}:maintain`, 99, 0.5, 'background')] as never[] }], opts);
    expect(lost.checks.sum_back.difference_usd).toBeCloseTo(0.5, 12);
    expect(lost.problems.join('\n')).toContain('billed dollars are in no world');
  });
  // Value: protects=the no-memory floor, which stores nothing, loads without problems about ingest it never does; fails_when=the loader
  // asks the floor's realizations for a namespace and content tokens, so every counted load lists 20 false problems (CS1-COUNTED 2026-11-27).
  test('a system that writes nothing is not asked for an ingest namespace or content tokens, and a writing system still is', () => {
    const unit = (system: string, cell: string) => {
      const dir = join(tmp, 'writes-nothing-' + system), rid = 'cd'.repeat(32);
      mkdirSync(join(dir, 'runs', cell, 'r', rid), { recursive: true });
      writeFileSync(join(dir, 'runs', cell, 'realizations.ndjson'), JSON.stringify({ realization_id: rid, conversation: 'w1', event: 'ingested', at: '2026-11-25T00:00:00Z', ingest: { ingested_tokens: 900, sessions: 10 } }) + '\n');
      const opts = { cells: new Map([[cell, system]]), questions: new Map(), ladder: { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 } };
      return cs1Load([{ dir, usage: [] }], opts).problems.join('\n');
    };
    const none = unit('baseline-none', 'cs1.baseline-none.baseline');
    expect(none).not.toContain('names no namespace');
    expect(none).not.toContain('no content_tokens');
    const hybrid = unit('baseline-hybrid', 'cs1.baseline-hybrid.baseline.c0');
    expect(hybrid).toContain('names no namespace');
    expect(hybrid).toContain('no content_tokens');
  });
  // Value: protects=every published cost, which needs every unit's proxy log; fails_when=the loader reads a missing usage file as empty and
  // reconciles without that unit's spend, so a typo in one path lowers a system's month with no error (review of #636, 2026-11-27).
  test('the loader refuses a unit whose usage file is missing and writes nothing', () => {
    const dir = join(tmp, 'missing-usage'), out = join(dir, 'load.json');
    mkdirSync(dir, { recursive: true });
    const run = spawnSync('bun', ['eval/runner/cs1-load.ts', '--unit', `${dir}:${join(dir, 'no-such-usage.ndjson')}`, '--out', out], { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('no usage file');
    expect(existsSync(out)).toBe(false);
  });
  // Value: protects=the preregistration's "system cost is zero by construction" for the no-memory floor; fails_when=the loader prices the
  // floor's harness process as a hosted memory system, so its row carries a server bill for a system that holds nothing (CS1-COUNTED 2026-11-27).
  test('a system that writes nothing gets no hosting, and a writing system in process still does', () => {
    const unit = (system: string, cell: string) => {
      const dir = join(tmp, 'hosting-floor-' + system), rid = 'ef'.repeat(32);
      mkdirSync(join(dir, 'runs', cell, 'r', rid), { recursive: true });
      writeFileSync(join(dir, 'runs', cell, 'realizations.ndjson'), JSON.stringify({ realization_id: rid, conversation: 'w1', event: 'ingested', at: '2026-11-25T00:00:00Z', ingest: { content_tokens: 1000, ingested_tokens: 1100, sessions: 10 } }) + '\n');
      writeFileSync(join(dir, 'runs', cell, 'hosting.ndjson'), ['2026-11-25T01:00:00Z', '2026-11-25T02:00:00Z'].map(at => JSON.stringify({ at, stage: 'questions:w1', harness_rss_bytes: 2 ** 30, containers: [], volumes: [], dirs: [] })).join('\n') + '\n');
      const opts = { cells: new Map([[cell, system]]), questions: new Map(), ladder: { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 } };
      return cs1Load([{ dir, usage: [] }], opts);
    };
    const none = unit('baseline-none', 'cs1.baseline-none.baseline');
    expect(none.input.systems.find(s => s.system === 'baseline-none')!.hosting).toBeNull();
    expect(none.problems.join('\n')).not.toContain('hosting samples');
    expect(unit('baseline-hybrid', 'cs1.baseline-hybrid.baseline.c0').input.systems.find(s => s.system === 'baseline-hybrid')!.hosting).not.toBeNull();
    expect([none.unhosted, unit('baseline-hybrid', 'cs1.baseline-hybrid.baseline.c1').unhosted]).toEqual([[], []]);
  });
  test('a hosted system whose every hosting sample failed is named as unhosted, never priced as zero hosting', () => {
    const dir = join(tmp, 'hosting-all-failed'), cell = 'cs1.baseline-hybrid.baseline.c0', rid = 'cd'.repeat(32);
    mkdirSync(join(dir, 'runs', cell, 'r', rid), { recursive: true });
    writeFileSync(join(dir, 'runs', cell, 'realizations.ndjson'), JSON.stringify({ realization_id: rid, conversation: 'w1', event: 'ingested', at: '2026-11-25T00:00:00Z', ingest: { content_tokens: 1000, ingested_tokens: 1100, sessions: 10 } }) + '\n');
    writeFileSync(join(dir, 'runs', cell, 'hosting.ndjson'), ['2026-11-25T01:00:00Z', '2026-11-25T02:00:00Z'].map(at => JSON.stringify({ at, stage: 'questions:w1', harness_rss_bytes: 2 ** 30, containers: [], volumes: [], error: 'docker stats exited 1: daemon down' })).join('\n') + '\n');
    const opts = { cells: new Map([[cell, 'baseline-hybrid']]), questions: new Map(), ladder: { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 } };
    const loaded = cs1Load([{ dir, usage: [] }], opts);
    expect(loaded.unhosted).toEqual(['baseline-hybrid']);
    expect(loaded.problems.join('\n')).toContain("baseline-hybrid: no usable hosting sample in any cell, so its server can't be priced");
  });
  test('a world its cell declared an idle window for, with no idle record, is named so its idle cost is never priced from the other worlds', () => {
    const dir = join(tmp, 'idle-missing'), cell = 'cs1.baseline-hybrid.baseline.c0', [r1, r2] = ['ab'.repeat(32), 'ba'.repeat(32)];
    for (const rid of [r1, r2]) mkdirSync(join(dir, 'runs', cell, 'r', rid), { recursive: true });
    mkdirSync(join(dir, 'cells', `${cell}.whole-default`), { recursive: true });
    writeFileSync(join(dir, 'cells', `${cell}.whole-default`, 'run-config.json'), JSON.stringify({ cell: { idle_window: { worlds: ['w1', 'w2'], ms: 1000, jobs: [] } } }));
    writeFileSync(join(dir, 'runs', cell, 'realizations.ndjson'), [[r1, 'w1'], [r2, 'w2']].map(([rid, conv]) => JSON.stringify({ realization_id: rid, conversation: conv, event: 'ingested', at: '2026-11-25T00:00:00Z', ingest: { content_tokens: 1000, ingested_tokens: 1100, sessions: 10 } })).join('\n') + '\n');
    writeFileSync(join(dir, 'runs', cell, 'r', r2, 'idle.json'), JSON.stringify({ ms: 1000, usd: null, triggers: [] }) + '\n');
    const opts = { cells: new Map([[cell, 'baseline-hybrid']]), questions: new Map(), ladder: { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 } };
    const loaded = cs1Load([{ dir, usage: [] }], opts);
    expect(loaded.missing_idle).toEqual([`${cell} w1`]);
    expect(loaded.problems.join('\n')).toContain('w1: its cell declares an idle window but wrote no idle record');
  });
  test('a trigger an older cell recorded with a nonzero exit and no error is still a failed trigger', () => {
    const dir = join(tmp, 'legacy-trigger-exit'), cell = 'cs1.baseline-hybrid.baseline.c0', rid = 'ef'.repeat(32);
    mkdirSync(join(dir, 'runs', cell, 'r', rid), { recursive: true });
    writeFileSync(join(dir, 'runs', cell, 'realizations.ndjson'), JSON.stringify({ realization_id: rid, conversation: 'w1', event: 'ingested', at: '2026-11-25T00:00:00Z', ingest: { content_tokens: 1000, ingested_tokens: 1100, sessions: 10 } }) + '\n');
    writeFileSync(join(dir, 'runs', cell, 'r', rid, 'idle.json'), JSON.stringify({ ms: 1000, usd: null, triggers: [{ job: 'daily upkeep round', trigger: 'maintain', cadence_minutes: 1440, error: null, result: { job: 'maintain', exit: 1 } }] }) + '\n');
    const opts = { cells: new Map([[cell, 'baseline-hybrid']]), questions: new Map(), ladder: { provider: 'invented', instances: [{ name: 'small', memory_gib: 2, usd_per_hour: 0.02 }], storage_usd_per_gb_month: 0.1 } };
    const loaded = cs1Load([{ dir, usage: [] }], opts);
    expect(loaded.failed_triggers).toEqual([`${cell} w1: daily upkeep round`]);
    expect(loaded.problems.join('\n')).toContain('trigger daily upkeep round failed: exited 1');
  });
  test("a hosting sample that saw none of the system's own containers is not usable", () => {
    const s = { at: '2026-11-25T01:00:00Z', stage: 'questions:w1', harness_rss_bytes: 7, containers: [{ name: 'other-db-1', mem_bytes: 900 }], volumes: [] };
    expect(hostingOf([s], 'stack', [{ at: '2026-11-25T00:00:00Z', ingest: { content_tokens: 1000, ingested_tokens: 1100, sessions: 5 } }])).toBeNull();
  });
  test("hosting counts only the system's own compose project, or the harness process and its files when in process", () => {
    const s = (at: string, rss: number, files = 0) => ({ at, stage: 'questions:w1', harness_rss_bytes: rss, containers: [{ name: 'stack-db-1', mem_bytes: 100 }, { name: 'other-db-1', mem_bytes: 900 }], volumes: [{ name: 'stack_data', bytes: 50 }, { name: 'other_data', bytes: 500 }], dirs: [{ path: '/x', bytes: files }] });
    const rs = [{ at: '2026-11-25T00:00:00Z', ingest: { content_tokens: 1000, ingested_tokens: 1100, sessions: 5 } }, { at: '2026-11-25T02:00:00Z', ingest: { content_tokens: 2000, ingested_tokens: 2200, sessions: 5 } }];
    expect(hostingOf([s('2026-11-25T01:00:00Z', 7)], 'stack', rs)).toEqual({ resident_bytes: 100, disk_bytes: 50, disk_tokens: 1000 });
    expect(hostingOf([s('2026-11-25T01:00:00Z', 7, 3), s('2026-11-25T03:00:00Z', 9, 4)], null, rs)).toEqual({ resident_bytes: 9, disk_bytes: 4, disk_tokens: 3000 });
    expect(hostingOf([], null, rs)).toBeNull();
  });
});

describe('hosting readings', () => {
  test("docker's human sizes parse to bytes, and a reading lists each container's memory and each volume's size", async () => {
    expect([parseBytes('0B'), parseBytes('512KiB'), parseBytes('123.4MiB'), parseBytes('12.3MB'), parseBytes('1.5GB'), parseBytes('n/a')]).toEqual([0, 524_288, 129_394_278, 12_300_000, 1_500_000_000, null]);
    const run = async (args: string[]) => args[0] === 'stats'
      ? 'stack-db-1\t123.4MiB / 15.6GiB\nstack-shim-1\t40MiB / 15.6GiB\n'
      : JSON.stringify({ Volumes: [{ Name: 'stack_db-data', Size: '12.3MB' }] });
    expect(await dockerReading(run)).toEqual({ containers: [{ name: 'stack-db-1', mem_bytes: 129_394_278 }, { name: 'stack-shim-1', mem_bytes: 41_943_040 }], volumes: [{ name: 'stack_db-data', bytes: 12_300_000 }] });
  });

  test('a user outside the docker group reads through sudo -n, and other failures still throw', async () => {
    const calls: string[][] = [];
    const denied = async (cmd: string[]) => {
      calls.push(cmd);
      return cmd[0] === 'sudo' ? { out: 'ok', err: '', code: 0 } : { out: '', err: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock', code: 1 };
    };
    expect(await dockerCli(['stats', '--no-stream'], denied)).toBe('ok');
    expect(calls).toEqual([['docker', 'stats', '--no-stream'], ['sudo', '-n', 'docker', 'stats', '--no-stream']]);
    const down = async () => ({ out: '', err: 'Cannot connect to the Docker daemon', code: 1 });
    await expect(dockerCli(['stats'], down)).rejects.toThrow('docker stats exited 1: Cannot connect to the Docker daemon');
  });

  test('a CLI call that hangs past its deadline is killed and throws', async () => {
    const t0 = performance.now();
    await expect(spawnText(['sleep', '30'], 200)).rejects.toThrow('sleep 30 timed out after 200 ms');
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(await spawnText(['echo', 'ok'], 5_000)).toEqual({ out: 'ok\n', err: '', code: 0 });
  });
});

describe("the file agent's write-to-queryable poll", () => {
  test('a fixed-string grep over its tree finds the written session with no model call, regex characters and all', async () => {
    const fa = new FileAgentSystem({ workDir: join(tmp, 'file-agent'), effort: 'medium' });
    const turns = (text: string) => [{ speaker: 'user', content: text }, { speaker: 'assistant', content: 'Noted.' }];
    await fa.ingestSession('ns', { source_id: 'src-a', turns: turns('The desk (by the window) costs $40+ [used].\nSecond line.') } as never, '2026-01-01T00:00:00Z');
    expect(await fa.grepSources('ns', 'The desk (by the window) costs $40+ [used].\nSecond')).toEqual(['src-a']);
    expect(await fa.grepSources('ns', 'nothing like this was said')).toEqual([]);
    await fa.ingestSession('ns', { source_id: 'src-b', turns: turns('A later chat about the desk (by the window) costs $40+ [used]. again') } as never, '2026-01-02T00:00:00Z');
    expect((await fa.grepSources('ns', 'the desk (by the window) costs $40+ [used].')).sort()).toEqual(['src-b']);
    expect((await fa.grepSources('ns', 'desk (by the window) costs $40+ [used].')).sort()).toEqual(['src-a', 'src-b']);
  });

  // Value: protects=a bulk probe's poll is not spoiled by the next bulk write; fails_when=a write deletes the tree a running poll greps, so the poll errors or misses; why_new=cost-speed results branch note 13 (bulk writes and probe polls run concurrently); seam=FileAgentSystem over local ripgrep; no_claim=answer-time greps, which run after ingest
  test('a write landing while a poll greps leaves that poll its tree, and the old tree is removed once the poll ends', async () => {
    const dir = join(tmp, 'file-agent-race');
    const fa = new FileAgentSystem({ workDir: dir, effort: 'medium' });
    const turns = (text: string) => [{ speaker: 'user', content: text }, { speaker: 'assistant', content: 'Noted.' }];
    await fa.ingestSession('ns', { source_id: 'src-a', turns: turns('The blue kettle is in the attic.') } as never, '2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      const poll = fa.grepSources('ns', 'The blue kettle is in the attic.');
      await fa.ingestSession('ns', { source_id: `src-${i}`, turns: turns(`Chat ${i}.`) } as never, '2026-01-02T00:00:00Z');
      expect(await poll).toEqual(['src-a']);
    }
    expect(await fa.grepSources('ns', 'Chat 4.')).toEqual(['src-4']);
    expect(readdirSync(join(dir, 'ns'))).toHaveLength(1);
  });
});

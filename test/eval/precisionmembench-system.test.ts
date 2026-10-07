/**
 * PrecisionMemBench for shootout systems (eval/runner/precisionmembench-system.ts), keyless:
 * the namespace views and families, the leak check on everything a system receives, all 77
 * cases end to end through the TypeScript fake over HTTP and the Python reference shim
 * (eval/systems/_fake), every canonical failure outcome, the not-measurable provenance rule,
 * gbrain-shootout in process behind a stand-in metering proxy (hash vectors through the
 * transport, then OpenAI-style embeddings and Voyage reranks answered by the stand-in), and the
 * Phase 5 cells (amendment A4). With GBRAIN_OVERLAY_SPEC=<checkout>@<sha> it also runs gbrain-shootout on
 * that overlay build.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildViews, familyOf, labelMarkers, parsePmbArgs, pmbCorpus, runPmb, searches, FIXTURE_BELIEFS, FIXTURE_CASES, TIME_ANCHOR, UNIVERSAL, type PmbRow } from '../../eval/runner/precisionmembench-system.ts';
import { coerceBelief, type RetrievalCase } from '../../eval/precisionmembench/scorer/runCases.ts';
import { SystemBeliefAdapter } from '../../eval/precisionmembench/systemAdapter.ts';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { Sanitizer } from '../../eval/runner/systems/sanitize.ts';
import { hashEmbed } from '../../eval/runner/memory-qa/run.ts';
import { loadCampaign } from '../../eval/runner/shootout-cell.ts';
import { SystemError, type IngestResult, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from '../../eval/runner/systems/types.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'pmb-system-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const beliefs = (JSON.parse(readFileSync(FIXTURE_BELIEFS, 'utf8')) as Record<string, unknown>[]).map(coerceBelief);
const cases = JSON.parse(readFileSync(FIXTURE_CASES, 'utf8')) as RetrievalCase[];
const text = (() => { const a = new SystemBeliefAdapter(async () => []); return (b: (typeof beliefs)[number]) => a.text(b); })();
const queryOf = (id: string) => cases.find(c => c.caseId === id)!.query;
const run = (out: string, ...extra: string[]) => runPmb(parsePmbArgs(['--output', join(tmp, out), ...extra]));
const rowsById = (rows: PmbRow[]) => new Map(rows.map(r => [r.id, r]));

describe('namespaces, families and the leak check', () => {
  test('families come from the vendored scorer: 43 search-only cases, 34 structural', () => {
    expect(cases).toHaveLength(77);
    expect(cases.filter(c => familyOf(c.category) === 'search-only')).toHaveLength(43);
    expect(familyOf('Alias resolution')).toBe('search-only');
    expect(familyOf('Supersession chain exclusion')).toBe('structural');
  });

  test('one namespace per searched (user, scope) with its universal beliefs; every belief reaches some namespace', () => {
    const views = buildViews(beliefs, cases);
    expect(views.map(v => [v.user, v.scope, v.beliefs.length, v.searched])).toEqual([
      ['other-user', 'domain:code', 1, false], ['test-user', 'domain:code', 27, true], ['test-user', 'domain:hobby', 5, true],
      ['test-user', 'domain:writing', 12, true], ['brand-new-user', 'domain:code', 0, true], ['test-user', UNIVERSAL, 5, true],
    ]);
    for (const b of beliefs) expect(views.some(v => v.beliefs.includes(b))).toBe(true);
    for (const v of views) for (const b of v.beliefs) expect(b.user_id === v.user && (b.scope.includes(v.scope) || b.scope.includes(UNIVERSAL))).toBe(true);
    expect(cases.filter(c => !searches(c)).map(c => c.caseId).length).toBe(5);
  });

  test('sessions carry upstream\'s /add text and disclosed synthetic times in fixture order; no id, label or scope is a word they send', () => {
    const views = buildViews(beliefs, cases);
    const corpus = pmbCorpus(views, beliefs, cases, text);
    const code = corpus.conversations.find(c => c.id.includes('test-user:domain:code'))!;
    expect(code.sessions[0].date).toBe('2026-05-29T00:00:00');
    expect(code.sessions.map(s => s.date)).toEqual([...code.sessions.map(s => s.date)].sort());
    expect(code.sessions.find(s => s.id === 'b-kubernetes-entity')!.turns[0].content).toBe(text(beliefs.find(b => b._id === 'b-kubernetes-entity')!));
    const san = new Sanitizer(corpus, 'salt');
    const markers = [...san.markers, ...labelMarkers(beliefs, cases, text)];
    expect(markers).toEqual(expect.arrayContaining(['b-sqlalchemy-superseded', 'b-linting-v0', 'happy-alias-match-kubernetes', 'Alias resolution', 'test-user', 'domain:code', 'open_question']));
    expect(TIME_ANCHOR).toBe('2026-05-29T00:00:00');
  });
});

/** The fake, logging exactly what it receives (the HTTP bodies minus the namespace). */
class Capturing extends FakeMemorySystem {
  readonly seen: string[] = [];
  readonly ingests: Array<{ ns: string; event_time: string | null }> = [];
  readonly queries: Array<{ ns: string; q: PublicQuestion }> = [];
  override async ingestSession(ns: string, s: SessionInput, t: string | null): Promise<IngestResult> { this.seen.push(JSON.stringify({ s, t })); this.ingests.push({ ns, event_time: t }); return super.ingestSession(ns, s, t); }
  override async retrieve(ns: string, q: PublicQuestion, p: RetrievalPolicy): Promise<RetrieveResult> { this.seen.push(JSON.stringify({ q, p })); this.queries.push({ ns, q }); return super.retrieve(ns, q, p); }
}

describe('end to end through protocol v1 (keyless)', () => {
  let py: { proc: ReturnType<typeof Bun.spawn>; url: string } | null = null;
  beforeAll(async () => {
    for (let attempt = 0; attempt < 3 && !py; attempt++) {
      const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
      const port = probe.port as number;
      probe.stop(true);
      const proc = Bun.spawn(['python3', 'eval/systems/_fake/fake.py'], { cwd: ROOT, env: { ...process.env, SHIM_PORT: String(port) }, stdout: 'ignore', stderr: 'ignore' });
      for (let i = 0; i < 200 && proc.exitCode === null && !py; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`, { keepalive: false })).ok) py = { proc, url: `http://127.0.0.1:${port}` }; } catch { await Bun.sleep(50); }
      }
      if (!py) proc.kill();
    }
  }, 30_000);
  afterAll(() => py?.proc.kill());

  test('the TypeScript fake over HTTP: 77 canonical rows, nothing labeled crosses, times in order, a rerun attempts nothing', async () => {
    const fake = new Capturing();
    const server = serveProtocol(fake);
    try {
      const { receipt, rows } = await run('ts-http', '--system', server.url);
      const r = receipt as any;
      expect([r.run_status, r.outcomes.scored, rows.length, r.comparison_complete]).toEqual(['complete', 77, 77, true]);
      expect(r.contract).toBe('PrecisionMemBench upstream contract');
      expect(r.ingest).toMatchObject({ namespaces: 6, sessions: 50, failed_sessions: 0, degraded_namespaces: 0 });
      expect(r.summary['search-only'].cases + r.summary.structural.cases).toBe(77);
      expect(r.summary['search-only'].metrics).toBe('measured');
      expect(rows.filter(x => x.system_called)).toHaveLength(72);
      const all = fake.seen.join('\n');
      const markers = [...beliefs.map(b => b._id), ...cases.map(c => c.caseId), ...new Set(cases.map(c => c.category)), 'test-user', 'other-user', 'brand-new-user', 'domain:code', 'domain:writing', UNIVERSAL, 'superseded_by', 'open_question'];
      expect(markers.filter(m => all.includes(m))).toEqual([]);
      expect(fake.ingests.every(i => i.event_time !== null)).toBe(true);
      const byNs = new Map<string, string[]>();
      for (const i of fake.ingests) byNs.set(i.ns, [...(byNs.get(i.ns) ?? []), i.event_time!]);
      for (const [ns, times] of byNs) {
        expect(times).toEqual([...times].sort());
        const asked = fake.queries.filter(x => x.ns === ns && cases.some(c => c.query === x.q.text));
        for (const q of asked) expect(q.q.query_time).toBe(times.at(-1)!);
      }
      const row = rowsById(rows).get('alias-gha-resolves')!;
      expect(row).toMatchObject({ outcome: 'scored', family: 'search-only', system_called: true, provenance_measurable: true, expected_ids: ['b-ci-gha-entity'] });
      expect(row.returned_ids).toContain('b-ci-gha-entity');
      expect(typeof row.latency_ms).toBe('number');
      const report = JSON.parse(readFileSync(join(tmp, 'ts-http', 'report.json'), 'utf8'));
      expect(report.retrieval.totalCases).toBe(77);
      const again = await run('ts-http', '--system', server.url);
      expect((again.receipt as any).attempts_this_run).toBe(0);
    } finally { server.stop(); }
  });

  test('the Python reference shim returns the same beliefs as the TypeScript fake on every case', async () => {
    if (!py) throw new Error('python fake shim did not start');
    const server = serveProtocol(new FakeMemorySystem());
    try {
      const [ts, pyRun] = [await run('ts-http-2', '--system', server.url), await run('py-http', '--system', py.url)];
      expect((pyRun.receipt as any).run_status).toBe('complete');
      const tsRows = rowsById(ts.rows);
      for (const r of pyRun.rows) expect([r.id, r.returned_ids, r.precision, r.recall, r.passed]).toEqual([r.id, tsRows.get(r.id)!.returned_ids, tsRows.get(r.id)!.precision, tsRows.get(r.id)!.recall, tsRows.get(r.id)!.passed]);
    } finally { server.stop(); }
  });
});

describe('a failed system call is a recorded outcome, never a crash', () => {
  test('product errors, unsupported and budget refusals become canonical outcomes; resume retries only the retryable ones', async () => {
    const fail = new Map<string, () => never>([
      [queryOf('happy-alias-match-kubernetes'), () => { throw new SystemError('product_error', 'vendor exploded'); }],
      [queryOf('alias-kube-resolves'), () => { throw new SystemError('unsupported', 'no such search'); }],
      [queryOf('alias-gha-resolves'), () => { throw new SystemError('budget', 'lease exhausted'); }],
    ]);
    const flaky = new FakeMemorySystem();
    const base = flaky.retrieve.bind(flaky);
    let healed = false;
    flaky.retrieve = async (ns, q, p) => { const f = fail.get(q.text); if (f && !healed) f(); return base(ns, q, p); };
    const server = serveProtocol(flaky);
    try {
      const first = await run('flaky', '--system', server.url, '--max-attempts', '2');
      const rows = rowsById(first.rows);
      expect((first.receipt as any).outcomes).toMatchObject({ scored: 74, retrieval_error: 1, unsupported: 1, budget_not_run: 1 });
      expect(rows.get('happy-alias-match-kubernetes')).toMatchObject({ outcome: 'retrieval_error', error_origin: 'sut', precision: 0, recall: 0, passed: false, returned_ids: [] });
      expect(rows.get('alias-gha-resolves')).toMatchObject({ outcome: 'budget_not_run', error_origin: 'harness' });
      expect((first.receipt as any).summary['search-only'].harness_failures).toBe(1);
      expect((first.receipt as any).comparison_complete).toBe(false);
      healed = true;
      const second = await run('flaky', '--system', server.url, '--max-attempts', '2');
      expect((second.receipt as any).attempts_this_run).toBe(2);
      expect((second.receipt as any).outcomes).toMatchObject({ scored: 76, unsupported: 1 });
      expect((second.receipt as any).comparison_complete).toBe(true);
    } finally { server.stop(); }
  });

  test('a source the namespace never ingested is a retrieval error; a namespace with a failed session is ingest-degraded with its scores kept', async () => {
    const odd = new FakeMemorySystem();
    const base = odd.retrieve.bind(odd);
    odd.retrieve = async (ns, q, p) => {
      const r = await base(ns, q, p);
      return q.text === queryOf('alias-gha-resolves') ? { ...r, items: r.items.map(i => ({ ...i, source_ids: ['src-00000000deadbeef'] })) } : r;
    };
    const ingestBase = odd.ingestSession.bind(odd);
    let writingSessions = 0;
    odd.ingestSession = async (ns, s, t) => {
      const res = await ingestBase(ns, s, t);
      return s.turns[0].content.includes('Mara') && writingSessions++ === 0 ? { ...res, errors: ['extraction failed'] } : res;
    };
    const server = serveProtocol(odd);
    try {
      const { receipt, rows } = await run('odd', '--system', server.url);
      const byId = rowsById(rows);
      expect(byId.get('alias-gha-resolves')).toMatchObject({ outcome: 'retrieval_error', error_kind: 'product_error' });
      const degraded = rows.filter(r => r.outcome === 'ingest_degraded');
      expect(degraded.length).toBeGreaterThan(0);
      expect(degraded.every(r => r.ingest?.degraded && r.ingest.failed_sessions === 1 && typeof r.precision !== 'undefined')).toBe(true);
      expect((receipt as any).ingest.degraded_namespaces).toBe(1);
    } finally { server.stop(); }
  });

  test('items that all lack provenance cannot be mapped to beliefs: not measurable, never zero', async () => {
    const blind = new FakeMemorySystem();
    const base = blind.retrieve.bind(blind);
    blind.retrieve = async (ns, q, p) => { const r = await base(ns, q, p); return { ...r, items: r.items.map(i => ({ ...i, source_ids: [], provenance_status: 'unavailable' as const })) }; };
    blind.capabilities = async () => ({ ...(await new FakeMemorySystem().capabilities()), provenance: { status: 'unavailable' as const, mechanism: 'none' } });
    const server = serveProtocol(blind);
    try {
      const { receipt, rows } = await run('blind', '--system', server.url);
      const r = receipt as any;
      expect(r.summary['search-only'].metrics).toMatch(/^not measurable/);
      expect(r.summary['search-only'].mean_precision).toBeNull();
      const row = rows.find(x => x.id === 'alias-gha-resolves')!;
      expect(row).toMatchObject({ provenance_measurable: false, precision: null, recall: null });
      expect(row.scorer_metrics).toBeDefined();
      expect(r.namespaces.filter((n: any) => n.ingest?.readiness_probe === 'not-measurable').length).toBe(5);
      expect(r.outcomes.scored).toBe(77);
    } finally { server.stop(); }
  });

  test('a reset that fails marks that namespace\'s cases as retrieval errors and the rest still run', async () => {
    const broken = new FakeMemorySystem();
    let resets = 0;
    broken.reset = async () => { if (++resets === 3) throw new SystemError('product_error', 'cannot reset'); };
    const server = serveProtocol(broken);
    try {
      const { receipt, rows } = await run('reset', '--system', server.url);
      const failed = rows.filter(r => r.outcome === 'retrieval_error');
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every(r => r.error?.startsWith('ingest failed: reset failed'))).toBe(true);
      expect((receipt as any).run_status).toBe('complete');
      expect(rows).toHaveLength(77);
    } finally { server.stop(); }
  });

  test('flags are strict', () => {
    expect(() => parsePmbArgs(['--output', 'x'])).toThrow(/--system/);
    expect(() => parsePmbArgs(['--system', 'mem0', '--output', 'x'])).toThrow(/shim URL/);
    expect(() => parsePmbArgs(['--system', 'fake', '--output', 'x', '--mode', 'hybrid'])).toThrow(/unknown argument --mode/);
    expect(parsePmbArgs(['--system', 'fake', '--output', 'x', '--paid', '--budget-run-id', 'r1']).policy).toBe('vendor-default');
  });
});

/** A stand-in for the cell's metering proxy: control routes, Voyage rerank and OpenAI-style embeddings, each request logged with its credential kind. */
function standInProxy() {
  const seen: Array<{ path: string; auth: string | null; model: string }> = [];
  const keys: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => ({})) as { model?: string; documents?: string[]; input?: string | string[]; dimensions?: number; key?: string };
    if (path.startsWith('/__proxy/')) {
      if (path.endsWith('/bind') && body.key) keys.push(body.key);
      return Response.json(path.endsWith('finalize') ? { usd: 0.001, requests: 1, unpriced: 0, byModel: {} } : { ok: true });
    }
    seen.push({ path, auth: req.headers.get('authorization'), model: String(body.model) });
    if (path.endsWith('/rerank')) return Response.json({ object: 'list', model: body.model, data: (body.documents ?? []).map((_, i) => ({ index: i, relevance_score: 1 - i / 100 })), usage: { total_tokens: 5 } });
    if (path.endsWith('/embeddings')) {
      const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
      return Response.json({ object: 'list', model: body.model, data: input.map((t, index) => ({ object: 'embedding', index, embedding: hashEmbed(String(t), body.dimensions ?? 1536) })), usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    return Response.json({ error: { message: `no route ${path}` } }, { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, seen, keys, stop: () => server.stop(true) };
}

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, 'eval/runner/precisionmembench-system.ts', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { err, code };
}

describe('gbrain-shootout in process (keyless, behind a stand-in metering proxy)', () => {
  test('hash vectors: gbrain\'s own search defaults run, the Voyage reranker goes through the proxy with a dummy key, every row carries its meter', async () => {
    const proxy = standInProxy();
    const out = join(tmp, 'gbrain-hash');
    try {
      const { err, code } = await runCli(['--system', 'gbrain-shootout', '--embed', 'hash', '--provider-proxy', proxy.url, '--output', out]);
      expect(code, err.slice(-2000)).toBe(0);
    } finally { proxy.stop(); }
    const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
    expect([receipt.run_status, receipt.outcomes.scored, receipt.metering.mode, receipt.system.capability_system]).toEqual(['complete', 77, 'lease-proxy', 'gbrain-shootout']);
    expect(receipt.policy).toMatchObject({ mode: 'vendor-default', settings: {}, settings_source: 'settings' });
    expect(proxy.seen.length).toBeGreaterThan(0);
    expect(proxy.seen.every(r => r.path === '/harness/voyage/v1/rerank' && r.auth === 'Bearer dummy-key-the-proxy-replaces')).toBe(true);
    const rows = readFileSync(join(out, 'rows.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as PmbRow);
    expect(rows.filter(r => r.system_called).every(r => r.provider?.usd === 0.001)).toBe(true);
    expect(receipt.costs.retrieval_usd).toBeCloseTo(0.072, 6);
    expect(receipt.ingest.namespaces).toBe(6);
    expect(proxy.keys.filter(k => k.startsWith('ingest:'))).toHaveLength(6);
    expect(receipt.product.package).toBe('gbrain');
  }, 300_000);

  test('real embedding path: OpenAI-style embeddings and reranks both answered through the proxy, no pages without vectors', async () => {
    const proxy = standInProxy();
    const out = join(tmp, 'gbrain-real');
    try {
      const { err, code } = await runCli(['--system', 'gbrain-shootout', '--embed', 'real', '--embedding-model', 'openai:text-embedding-3-large', '--embedding-dims', '1536', '--provider-proxy', proxy.url, '--output', out],
        { GBRAIN_EVALS_EMBED_CACHE: join(tmp, 'embed-cache') });
      expect(code, err.slice(-2000)).toBe(0);
    } finally { proxy.stop(); }
    const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
    expect([receipt.run_status, receipt.outcomes.scored, receipt.fidelity.embedding_deferred_pages]).toEqual(['complete', 77, 0]);
    expect(proxy.seen.some(r => r.path === '/harness/openai/v1/embeddings' && r.auth === 'Bearer dummy-key-the-proxy-replaces')).toBe(true);
    expect(proxy.seen.some(r => r.path === '/harness/voyage/v1/rerank')).toBe(true);
  }, 300_000);

  test('without a proxy, gbrain-shootout\'s paid defaults need the paid flags; hash vectors with the reranker off need none', async () => {
    const refused = await runCli(['--system', 'gbrain-shootout', '--embed', 'hash', '--output', join(tmp, 'gbrain-refused')], { BRAINBENCH_BUDGET_LEDGER: join(tmp, 'ledger.sqlite') });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/--paid/);
    const out = join(tmp, 'gbrain-keyless');
    const ok = await runCli(['--system', 'gbrain-shootout', '--embed', 'hash', '--config', 'search.reranker.enabled=false', '--output', out]);
    expect(ok.code, ok.err.slice(-2000)).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'))).toMatchObject({ run_status: 'complete', metering: { mode: 'none' }, gbrain_config: { 'search.reranker.enabled': 'false' } });
  }, 300_000);
});

describe.skipIf(!process.env.GBRAIN_OVERLAY_SPEC)('gbrain-shootout on an overlay build (GBRAIN_OVERLAY_SPEC)', () => {
  test('all 77 cases run on the overlay, and the receipt names its commit', async () => {
    const proxy = standInProxy();
    const out = join(tmp, 'gbrain-overlay');
    try {
      const { err, code } = await runCli(['--system', 'gbrain-shootout', '--embed', 'hash', '--gbrain', process.env.GBRAIN_OVERLAY_SPEC!, '--provider-proxy', proxy.url, '--output', out]);
      expect(code, err.slice(-2000)).toBe(0);
    } finally { proxy.stop(); }
    const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
    expect([receipt.run_status, receipt.outcomes.scored, receipt.overlay.verified.tree_matches]).toEqual(['complete', 77, true]);
    expect(process.env.GBRAIN_OVERLAY_SPEC!.endsWith(receipt.overlay.commit)).toBe(true);
    expect(readFileSync(join(out, 'receipt.json'), 'utf8')).not.toContain(homedir());
  }, 900_000);
});

describe('Phase 5 cells (amendment A4, manifests/cells/pmb.json)', () => {
  const MANIFESTS = join(ROOT, 'docs/benchmarks/2026-10-06-oss-memory-shootout/manifests');
  const PMB = join(MANIFESTS, 'cells/pmb.json');
  const campaign = () => loadCampaign(join(MANIFESTS, 'campaign.json'));
  const load = () => { const m = campaign().manifest; return { ...m, cells: m.cells.filter(c => c.id.endsWith('-pmb')) }; };

  test('load in the cell schema under the campaign parameters, one cell per system configuration, every command the PMB runner', () => {
    const m = load();
    expect(m.cells.map(c => `${c.system}:${c.config}`).sort()).toEqual(['basic-memory:common', 'cognee:common', 'gbrain-shootout-master:common', 'gbrain-shootout:common', 'graphiti:common', 'graphiti:recipe', 'hindsight:common', 'mem0:common']);
    for (const c of m.cells) {
      expect(c.command).toContain('bun eval/runner/precisionmembench-system.ts');
      expect(c.command).toContain('--output "$SHOOTOUT_OUT/pmb"');
      for (const s of c.command.matchAll(/up --system (\S+) --config (\S+)/g)) { expect(s[1]).toBe(c.system); expect(s[2]).toBe(c.config); }
    }
    const master = m.cells.find(c => c.system === 'gbrain-shootout-master')!;
    expect(master.command).toContain(`--gbrain "$HOME/gbrain-master@${m.parameters!.gbrain_master_sha}"`);
    expect(m.cells.find(c => c.system === 'gbrain-shootout')!.command).not.toContain('--gbrain');
  });

  test('every lease names its basis; the common-model cells fit the plan\'s $10 Phase 5 line, Graphiti\'s recipe is the one cell that does not', () => {
    const m = load();
    const file = JSON.parse(readFileSync(PMB, 'utf8')) as { cells: Array<{ lease_basis?: string }> };
    expect(file.cells.every(c => (c.lease_basis ?? '').startsWith('1.5 x'))).toBe(true);
    const common = m.cells.filter(c => c.config === 'common').reduce((s, c) => s + c.lease_usd, 0);
    expect([common, m.cells.reduce((s, c) => s + c.lease_usd, 0)]).toEqual([5, 16.5]);
    expect(common).toBeLessThanOrEqual(10);
  });

  test('A4 adds the cells to the campaign under the hash the preregistration records', () => {
    expect(campaign().manifest.cells_from).toContain('cells/pmb.json');
    expect(campaign().sha256).toBe('bd60fb49c2f46a520b772b18fa84ca8a8cfb769526b3c33ff8c2604ef4662744');
  });
});

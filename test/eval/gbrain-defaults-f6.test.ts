/**
 * F6 paths of the gbrain-defaults shim (GBRAIN_F6=1, docs/benchmarks/2026-10-29-f6-current-master-preregistration.md),
 * keyless and without Docker or gbrain: the per-arm policy (op, args, overlay), the token_budget guard, the overlay
 * switch with its read-back check, the brain build's extraction cap and pass rules, and how fact rows (query's facts
 * block, recall's facts) map to items with their source session. A fake adapter stands in for gbrain's CLI and serve.
 * Q1's own paths are pinned by gbrain-defaults.test.ts, unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SHIM = `${ROOT}/eval/systems/gbrain-defaults/shim.py`;

const FAKE = `
import importlib.util, json, sys, types, threading
spec = importlib.util.spec_from_file_location("gbrain_defaults_shim", SHIM_PATH)
shim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shim)
KEYS = list(shim.SEARCH_OVERLAY_KEYS)

class Proc:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr

class Fake(shim.GbrainDefaultsAdapter):
    """The adapter with gbrain's CLI, serve and state in memory: cli() answers config set/get from a dict and
    extraction from a scripted list; call() answers from canned MCP results."""
    def __init__(self, extract=None, safe=None, results=None, readback=None):
        self.lock = threading.RLock()
        self.active, self.mcp, self.serve_session = "ns-a", None, {"id": "s1"}
        self.record = {"retrieval_policies": {"on_degraded": "error"}}
        self.reference = {"resolved": {"search": {}}, "resolved_sha256": "r"}
        self.st = {"sessions": {"src-1": {"slug": "conversations/2026-04-10/src-1"}, "src-2": {"slug": "conversations/2026-06-15/src-2"}}}
        self.config, self.cli_calls, self.mcp_calls, self.serve_starts = {}, [], [], 0
        self.extract, self.safe, self.results, self.readback = list(extract or []), safe, list(results or []), readback or {}
        self.called_ops, self.shipped_counts = set(), {}
    def receipt(self, kind, **f): pass
    def state(self): return json.loads(json.dumps(self.st))
    def save_state(self, st): self.st = json.loads(json.dumps(st))
    def place(self, ns): self.active = ns; self.stop_serve()
    def stop_serve(self): self.mcp = None
    def start_serve(self):
        self.serve_starts += 1
        self.mcp = types.SimpleNamespace(proc=types.SimpleNamespace(poll=lambda: None), request=self.request)
    def require_reference(self): return self.reference
    def cli(self, *args, timeout_s=600, check=True):
        self.cli_calls.append(list(args))
        if args[:2] == ("config", "set"):
            self.config[args[2]] = args[3]; return Proc()
        if args[:2] == ("config", "get"):
            return Proc(self.readback.get(args[2], self.config.get(args[2], "")) + "\\n")
        if args[0] == "extract-conversation-facts":
            return Proc(json.dumps(self.extract.pop(0)))
        if args[:2] == ("repair", "safe-chunks"):
            return Proc(json.dumps({"results": [{"kind": "safe-chunks", "affected": self.safe or 0, "applied": self.safe or 0, "failed": [], "complete": True}]}))
        raise AssertionError(args)
    def request(self, method, params, timeout_s=0):
        self.mcp_calls.append(params)
        return self.results.pop(0)

def mcp_result(body, meta=None):
    return {"content": [{"type": "text", "text": json.dumps(body)}], **({"_meta": meta} if meta else {})}

def overlay(**kw):
    base = {"search.evidence_date_header": False, "search.evidence_titles": False, "search.fact_source_pages": False,
            "search.query_budget_unit": "chunk", "search.query_facts_block": False, "search.saved_facts_supersede": True}
    return {**base, **{("search." + k): v for k, v in kw.items()}}

def policy(op, args, ov):
    return {"name": "gbrain-defaults:f6", "mode": "fixed-evidence", "settings": {"op": op, "args": args, "overlay": ov}}

def run(code):
    out = {}
    try:
        exec(code, globals(), out)
        print(json.dumps({"ok": out.get("result")}))
    except shim.ShimError as e:
        print(json.dumps({"error": {"kind": e.kind, "status": e.status, "message": str(e)}}))
run(sys.argv[1])
`;

/** A JSON value as a Python expression. */
const J = (x: unknown) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

/** Run a Python body against the shim with GBRAIN_F6 set (or not); the body assigns \`result\`. */
function f6(body: string, env: Record<string, string> = { GBRAIN_F6: '1', GBRAIN_F6_EXTRACT_CAP_USD: '2' }): any {
  const r = Bun.spawnSync(['python3', '-c', FAKE.replace('SHIM_PATH', JSON.stringify(SHIM)), body], { cwd: ROOT, env: { ...process.env, SHIM_DATA: '/tmp/gbrain-f6-test', ...env } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

describe('F6 policy identity: {op, args, overlay}', () => {
  test('query and recall policies become their calls, the question filling query (and recall question)', () => {
    expect(f6('result = Fake().f6_policy("q?", policy("query", {"limit": 50, "token_budget": 5500}, overlay()))[:2]').ok)
      .toEqual(['query', { query: 'q?', limit: 50, token_budget: 5500 }]);
    expect(f6('result = Fake().f6_policy("q?", policy("recall", {"budget_tokens": 5500}, overlay()))[:2]').ok)
      .toEqual(['recall', { question: 'q?', query: 'q?', budget_tokens: 5500 }]);
  });
  test('an F6 policy is refused on a Q1 stack (GBRAIN_F6 unset), so Q1 cells can never send one', () => {
    const r = f6('result = Fake().f6_policy("q?", policy("query", {"limit": 50}, overlay()))', {});
    expect(r.error).toMatchObject({ kind: 'invalid_request', status: 400 });
    expect(r.error.message).toContain('GBRAIN_F6=1');
  });
  test('unknown ops, arguments outside the op, bad budgets and incomplete or invalid overlays are refused', () => {
    const bad = [
      'policy("think", {}, overlay())', 'policy("query", {"budget_tokens": 1}, overlay())', 'policy("recall", {"token_budget": 1}, overlay())',
      'policy("query", {"token_budget": 0}, overlay())', 'policy("query", {"token_budget": True}, overlay())',
      'policy("query", {}, {k: v for k, v in overlay().items() if k != "search.fact_source_pages"})',
      'policy("query", {}, overlay(query_budget_unit="page"))', 'policy("query", {}, overlay(query_facts_block="yes"))',
      '{"name": "x", "mode": "fixed-evidence", "settings": {"op": "query", "args": {}, "overlay": overlay(), "k": 1}}',
    ];
    for (const p of bad) expect(f6(`result = Fake().f6_policy("q?", ${p})`).error).toMatchObject({ kind: 'invalid_request', status: 400 });
  });
  test('the MCP guard lets token_budget through only for an F6 policy on an F6 stack', () => {
    const body = 'f = Fake(results=[mcp_result([])]); f.start_serve(); result = f.call("query", {"query": "x", "token_budget": 1}, budget_ok=BUDGET)[0]';
    expect(f6(body.replace('BUDGET', 'True')).ok).toEqual([]);
    expect(f6(body.replace('BUDGET', 'False')).error).toMatchObject({ kind: 'invalid_request' });
    expect(f6(body.replace('BUDGET', 'True'), {}).error).toMatchObject({ kind: 'invalid_request' });
  });
});

describe('F6 overlays', () => {
  test('a new overlay stops serve, writes all six keys, reads each back and starts serve; the same overlay again does nothing', () => {
    const r = f6(`f = Fake(); a = f.apply_overlay("ns-a", overlay()); n = len(f.cli_calls); b = f.apply_overlay("ns-a", overlay()); c = f.apply_overlay("ns-a", overlay(query_facts_block=True))
result = {"a": a, "b": b, "c": c, "first_calls": f.cli_calls[:n], "calls_after_b": len(f.cli_calls) - n, "starts": f.serve_starts}`).ok;
    expect(r.a.switched).toBe(true);
    expect(r.b).toMatchObject({ switched: false, overlay_sha256: r.a.overlay_sha256 });
    expect(r.c.switched).toBe(true);
    expect(r.c.overlay_sha256).not.toBe(r.a.overlay_sha256);
    expect(r.first_calls.filter((c: string[]) => c[1] === 'set').map((c: string[]) => [c[2], c[3]])).toEqual([
      ['search.evidence_date_header', 'false'], ['search.evidence_titles', 'false'], ['search.fact_source_pages', 'false'],
      ['search.query_budget_unit', 'chunk'], ['search.query_facts_block', 'false'], ['search.saved_facts_supersede', 'true']]);
    expect(r.first_calls.filter((c: string[]) => c[1] === 'get')).toHaveLength(6);
    expect(r.a.resolved['search.query_budget_unit']).toBe('chunk');
    expect(r.starts).toBe(2);
  });
  test('a key that reads back a different value invalidates the cell', () => {
    const r = f6('result = Fake(readback={"search.query_facts_block": "true"}).apply_overlay("ns-a", overlay())');
    expect(r.error.kind).toBe('product_error');
    expect(r.error.message).toContain("search.query_facts_block='true'");
  });
});

describe('F6 brain build (extraction under a recorded cap)', () => {
  const okRun = { status: 'ok', pages_processed: 2, segments_processed: 4, facts_extracted: 9, facts_inserted: 9, pages_failed: 0, spent_usd: 0.01, budget_exhausted: false, failed_pages: [] };
  test('a finished run records its counters, spend and cap, then the safe-chunks repair; a retry for the same pages reuses it', () => {
    const r = f6(`f = Fake(extract=[${J(okRun)}], safe=1); a = f.f6_build(["p1", "p2"]); b = f.f6_build(["p1", "p2"])
result = {"a": {k: a[k] for k in ("ok", "cap_usd", "spent_usd", "totals", "safe_chunks")}, "reused": b.get("reused"), "extract_argv": [c for c in f.cli_calls if c[0] == "extract-conversation-facts"], "repairs": [c for c in f.cli_calls if c[0] == "repair"]}`).ok;
    expect(r.a).toMatchObject({ ok: true, cap_usd: 2, spent_usd: 0.01, totals: { facts_inserted: 9, segments_processed: 4 }, safe_chunks: { previewed: 1, applied: 1 } });
    expect(r.reused).toBe(true);
    expect(r.extract_argv).toEqual([['extract-conversation-facts', '--source-id', 'default', '--max-cost-usd', '2.000000', '--json', '--yes']]);
    expect(r.repairs.map((c: string[]) => c.includes('--apply'))).toEqual([false, true]);
  });
  test('a run that stopped on its cap fails the realization, never a silent short brain', () => {
    const r = f6(`f = Fake(extract=[${J({ ...okRun, budget_exhausted: true, spent_usd: 2 })}]); result = f.f6_build(["p1"])`);
    expect(r.error.kind).toBe('product_error');
    expect(r.error.message).toContain('stopped on its cap');
  });
  test('a partial run is resumed with the cap left; pages still failed after the last pass fail the build', () => {
    const partial = { ...okRun, status: 'partial', pages_failed: 1, spent_usd: 0.5 };
    const healed = f6(`f = Fake(extract=[${J(partial)}, ${J(okRun)}]); a = f.f6_build(["p1"])
result = {"ok": a["ok"], "passes": len(a["passes"]), "spent": a["spent_usd"], "caps": [c[4] for c in f.cli_calls if c[0] == "extract-conversation-facts"]}`).ok;
    expect(healed).toEqual({ ok: true, passes: 2, spent: 0.51, caps: ['2.000000', '1.500000'] });
    const stuck = f6(`f = Fake(extract=[${J(partial)}] * 3); result = f.f6_build(["p1"])`);
    expect(stuck.error.message).toContain('pages_failed=1');
  });
  test('the cap is a required parameter', () => {
    expect(f6('result = Fake().f6_build(["p1"])', { GBRAIN_F6: '1' }).error).toMatchObject({ kind: 'invalid_request' });
  });
  test('skipped-too-large, unparsed, pending and unpriced runs are problems, an ok run is not', () => {
    const p = (run: object) => f6(`result = shim.extraction_problems(${J(run)})`).ok;
    expect(p(okRun)).toEqual([]);
    expect(p({ ...okRun, pages_skipped_too_large: 1 })).toEqual(['pages_skipped_too_large=1']);
    expect(p({ ...okRun, pages_skipped_unparsed: 2, pages_pending: 1 })).toEqual(['pages_pending=1', 'pages_skipped_unparsed=2']);
    expect(p({ ...okRun, no_pricing_models: ['m'] })).toEqual(["unpriced extraction models ['m']"]);
  });
});

describe('F6 retrieval: fact rows first, mapped to their source session', () => {
  const factRow = { result_type: 'fact', fact_id: '4', follow_up: { op: 'recall', args: { grep: 'alice-example moves to city-a' } }, title: 'Saved fact', chunk_text: '[observed unknown; valid 2026-04-10 to unknown]\nalice-example moves to city-a in June.', score: 0.92, source_id: 'default' };
  const pageRow = { slug: 'conversations/2026-06-15/src-2', title: 'Conversation', type: 'conversation', chunk_text: '**user** (2026-06-15 9:00 AM): hello', chunk_id: 7, score: 0.3, source_id: 'default' };
  const indexed = { slug: 'conversations/2026-04-10/src-1', valid_from: '2026-04-10T09:30:00.000Z', valid_until: null, visibility: 'world' };
  test('query: a fact row in the index maps to its session with its validity window; page rows keep the Q1 mapping', () => {
    const r = f6(`f = Fake(results=[mcp_result([${J(factRow)}, ${J(pageRow)}], {"retrieval": {"returned_count": 2}})]); f.st["fact_index"] = {"4": ${J(indexed)}}
result = f.f6_retrieve("ns-a", "q?", policy("query", {"limit": 50, "token_budget": 5500}, overlay(query_facts_block=True)))`).ok;
    expect(r.items).toEqual([
      { id: 'fact:4', rank: 1, type: 'fact', text: factRow.chunk_text, source_ids: ['src-1'], valid_from: '2026-04-10T09:30:00.000Z', valid_to: null, provenance_status: 'exact' },
      { id: 'conversations/2026-06-15/src-2#7', rank: 2, type: 'episode', text: pageRow.chunk_text, source_ids: ['src-2'], valid_from: null, valid_to: null, provenance_status: 'exact' },
    ]);
    expect(r.raw).toMatchObject({ tool: 'query', fact_rows: 1, fact_rows_unresolved: 0, overlay: { switched: true } });
    expect(r.applied_settings).toMatchObject({ op: 'query', token_budget: 5500 });
  });
  test('query: a fact missing from the index resolves through its own follow_up recall, and is unavailable when nothing matches', () => {
    const recallHit = { facts: [{ id: 4, fact_id: '4', source_session: 'cli:extract-conversation-facts:conversations/2026-04-10/src-1', valid_from: '2026-04-10T09:30:00.000Z' }] };
    const r = f6(`f = Fake(results=[mcp_result([${J(factRow)}]), mcp_result(${J(recallHit)})])
a = f.f6_retrieve("ns-a", "q?", policy("query", {"limit": 50}, overlay(query_facts_block=True)))
g = Fake(results=[mcp_result([${J(factRow)}]), mcp_result({"facts": []})])
b = g.f6_retrieve("ns-a", "q?", policy("query", {"limit": 50}, overlay(query_facts_block=True)))
result = {"a": a["items"][0], "recall": f.mcp_calls[1], "indexed": f.st["fact_index"]["4"]["slug"], "b": b["items"][0], "unresolved": b["raw"]["fact_rows_unresolved"]}`).ok;
    expect(r.a).toMatchObject({ source_ids: ['src-1'], provenance_status: 'exact' });
    expect(r.recall).toEqual({ name: 'recall', arguments: { grep: 'alice-example moves to city-a', limit: 100, include_expired: true } });
    expect(r.indexed).toBe('conversations/2026-04-10/src-1');
    expect(r.b).toMatchObject({ source_ids: [], provenance_status: 'unavailable' });
    expect(r.unresolved).toBe(1);
  });
  test('recall: facts first (date header and fact text), then its page results as chunks, each with its session', () => {
    const body = { facts: [{ id: 6, fact_id: '6', fact: 'alice-example likes tea.', date_header: '[observed 2026-04-10]', source_session: 'cli:extract-conversation-facts:conversations/2026-04-10/src-1', valid_from: '2026-04-10T09:30:00.000Z', valid_until: null }],
      results: [{ slug: 'conversations/2026-06-15/src-2', chunk: 'a chunk', provenance: 'conversations/2026-06-15/src-2' }], budget_tokens: 5500, budget_used: 40 };
    const r = f6(`f = Fake(results=[mcp_result(${J(body)})]); result = f.f6_retrieve("ns-a", "q?", policy("recall", {"budget_tokens": 5500}, overlay()))`).ok;
    expect(r.items.map((i: any) => [i.id, i.type, i.text, i.source_ids])).toEqual([
      ['fact:6', 'fact', '[observed 2026-04-10]\nalice-example likes tea.', ['src-1']],
      ['conversations/2026-06-15/src-2#2', 'chunk', 'a chunk', ['src-2']],
    ]);
    expect(r.raw.meta).toEqual({ budget_tokens: 5500, budget_used: 40 });
    expect(r.raw.args).toEqual({ question: 'q?', query: 'q?', budget_tokens: 5500 });
  });
  test('fact_entry reads the source page from source_session, else from the context line', () => {
    expect(f6('result = shim.fact_entry({"context": "from conversations/x/src-9 segment 2026-01-01T00:00:00Z..2026-01-01T00:00:00Z"})').ok.slug).toBe('conversations/x/src-9');
  });
});

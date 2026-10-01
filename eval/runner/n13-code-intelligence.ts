/**
 * BrainBench N13: code-intelligence readiness scout.
 *
 * Question: on one small, pinned, real TypeScript repository, which of
 * gbrain's six code_* operations work through the trusted local path, how
 * fast, and where do their documented limits show? It is a capability and
 * readiness report, not a quality study (plan amendment 9): nothing here
 * gates, and broad caller, blast and flow quality waits for independent call
 * and flow gold.
 *
 * Corpus: the vendored unjs/pathe snapshot (eval/data/n13-code-scout, MIT,
 * hash-checked against manifest.json before anything is imported).
 * Gold: eval/data/n13-code-scout/ts-gold.json, built once by
 * eval/generators/n13-ts-gold.ts with the pinned TypeScript compiler
 * (definitions, language-service references, checker-resolved calls) and
 * rebuilt byte-identically by a test. Never gbrain output.
 *
 * Steps (in process, keyless, in-memory PGLite):
 *   1. importCodeFile for every corpus file (the path `gbrain sync` and
 *      `reindex-code` use), then resolveSymbolEdgesIncremental (the
 *      resolve_symbol_edges cycle phase);
 *   2. readiness per op through handleToolCall (the `gbrain call` path,
 *      remote: false, parameters validated): answers, status, latency;
 *      the same op with remote: true must refuse (remote code reads are
 *      suspended at the pinned commit);
 *   3. narrow checks against the compiler gold: code_def top-1 location,
 *      code_refs chunks against language-service references (lexical vs
 *      semantic), code_callers against checker-resolved calls split by
 *      same-file and cross-file, the `resolved` flag;
 *   4. code_blast and code_flow envelopes, and language gating with a
 *      synthetic Go and Python pair written by this runner.
 *
 * Usage: bun eval/runner/n13-code-intelligence.ts [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import { verifyVendoredCorpus, type CorpusManifest } from '../generators/n13-code-scout-vendor.ts';
import { N13_GOLD_PATH, goldSha256, type GoldCall, type GoldFunction, type N13Gold } from '../generators/n13-ts-gold.ts';

export const CATEGORY = 'n13-code-intelligence';
export const CODE_OPS = ['code_def', 'code_refs', 'code_callers', 'code_callees', 'code_blast', 'code_flow'] as const;
export type CodeOp = typeof CODE_OPS[number];

export const INTERNAL_ENTRY_POINTS = [
  'src/core/import-file.ts importCodeFile',
  'src/core/chunkers/symbol-resolver.ts resolveSymbolEdgesIncremental',
  'src/mcp/server.ts handleToolCall (trusted local, the gbrain call path)',
  'src/core/operations.ts operations (remote refusal check)',
  'src/core/pglite-engine.ts PGLiteEngine',
];

export const DOCUMENTED_LIMITS: ReadonlyArray<{ id: string; limit: string; source: string }> = [
  { id: 'remote-suspended', limit: 'All six code reads refuse agent (remote) callers on stdio and HTTP at this commit; only the trusted local path is scouted.', source: 'src/core/ops/code-intel.ts (permission_denied wrapper); capability matrix P9' },
  { id: 'refs-lexical', limit: 'code_refs is a substring match over chunk text, so a name that is a prefix of another name returns both; lexical references are not semantic references.', source: 'src/commands/code-refs.ts header' },
  { id: 'resolver-within-file', limit: 'The symbol resolver resolves a call only when exactly one chunk in the same file has the qualified name; cross-file calls stay unresolved.', source: 'src/core/chunkers/symbol-resolver.ts header' },
  { id: 'walk-languages', limit: 'code_blast and code_flow refuse languages other than TypeScript, TSX, JavaScript and Python.', source: 'src/core/code-intel/recursive-walk.ts' },
  { id: 'no-cli-blast-flow', limit: 'code_blast and code_flow have no named CLI command; they run through `gbrain call` or in process.', source: 'src/cli/command-table.ts' },
  { id: 'no-quality-gold', limit: 'No broad caller, blast or flow quality metric is reported: the compiler gold here covers one repository and top-level functions only. Deferred until independent call and flow gold (SCIP or equivalent) is committed.', source: 'wave plan amendment 9' },
];

// ─── Pure checks (exported for tests) ───────────────────────────────────

export interface DefHit { file: string; start_line: number; end_line: number }
export interface RefHit { file: string; start_line: number; end_line: number }
export interface CallerEdge { from_symbol_qualified: string; edge_metadata?: Record<string, unknown> | null; resolved: boolean }

const bare = (q: string) => q.split(/::|\./).pop() ?? q;

export function checkDef(g: GoldFunction, defs: readonly DefHit[]) {
  const top = defs[0];
  const sameName = defs.length;
  return {
    symbol: g.name, gold_file: g.file, gold_line: g.start_line, results: sameName,
    top1_file_ok: !!top && top.file === g.file,
    top1_span_ok: !!top && top.file === g.file && top.start_line <= g.start_line && g.start_line <= top.end_line,
    any_span_ok: defs.some(d => d.file === g.file && d.start_line <= g.start_line && g.start_line <= d.end_line),
  };
}

/** Lexical code_refs chunks against semantic references: which chunks hold a real reference, which only a substring. */
export function checkRefs(g: GoldFunction, refs: readonly RefHit[]) {
  const covers = (r: RefHit, file: string, line: number) => r.file === file && r.start_line <= line && line <= r.end_line;
  const isDef = (r: RefHit) => covers(r, g.file, g.start_line);
  const semantic = refs.filter(r => g.references.some(x => covers(r, x.file, x.line)));
  const lexicalOnly = refs.filter(r => !isDef(r) && !g.references.some(x => covers(r, x.file, x.line)));
  return {
    symbol: g.name, chunks: refs.length, gold_references: g.references.length,
    chunks_with_semantic_reference: semantic.length,
    chunks_lexical_only: lexicalOnly.length,
    references_covered: g.references.filter(x => refs.some(r => covers(r, x.file, x.line))).length,
  };
}

/** Checker-resolved calls found among code_callers edges, split by same-file and cross-file. */
export function checkCallers(calls: readonly GoldCall[], callersOf: ReadonlyMap<string, readonly CallerEdge[]>) {
  const key = (c: GoldCall) => `${c.caller}->${c.callee}`;
  const uniq = [...new Map(calls.map(c => [key(c), c])).values()];
  const found = (c: GoldCall) => (callersOf.get(c.callee) ?? []).some(e => bare(e.from_symbol_qualified) === c.caller);
  const metaResolved = (c: GoldCall) => (callersOf.get(c.callee) ?? []).some(e => bare(e.from_symbol_qualified) === c.caller && e.edge_metadata != null && e.edge_metadata.resolved_chunk_id != null);
  const split = (sel: GoldCall[]) => ({ edges: sel.length, found: sel.filter(found).length, resolved_in_metadata: sel.filter(metaResolved).length });
  const goldPairs = new Set(uniq.map(key));
  const allEdges = [...callersOf.entries()].flatMap(([callee, es]) => es.map(e => ({ callee, e })));
  return {
    same_file: split(uniq.filter(c => c.same_file)),
    cross_file: split(uniq.filter(c => !c.same_file)),
    gbrain_edges: allEdges.length,
    gbrain_edges_resolved_flag_true: allEdges.filter(x => x.e.resolved).length,
    gbrain_edges_resolved_in_metadata: allEdges.filter(x => x.e.edge_metadata?.resolved_chunk_id != null).length,
    gbrain_edges_without_checker_call: allEdges.filter(x => !goldPairs.has(`${bare(x.e.from_symbol_qualified)}->${x.callee}`)).length,
  };
}

// ─── Run ───────────────────────────────────────────────────────────────

type Engine = { connect(o: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; executeRaw<T>(q: string, p?: unknown[]): Promise<T[]> };
type Op = { name: string; handler(ctx: unknown, p: Record<string, unknown>): Promise<unknown> };

export interface OpReadiness {
  op: CodeOp;
  probe: Record<string, unknown>;
  trusted_ok: boolean;
  trusted_error: string | null;
  status: string | null;
  ready: boolean | null;
  answer_count: number | null;
  latency_ms: number;
  remote_refused: boolean;
  remote_error_code: string | null;
  cli_command: string | null;
}

export interface N13RunResult {
  manifest: CorpusManifest | null;
  gold: N13Gold | null;
  gold_sha256: string | null;
  import: Record<string, unknown> | null;
  readiness: OpReadiness[];
  def_check: ReturnType<typeof checkDef>[];
  refs_check: ReturnType<typeof checkRefs>[];
  callers_check: ReturnType<typeof checkCallers> | null;
  walks: Record<string, unknown> | null;
  acc: ProbeAccounting;
  harnessError: string | null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const count = (r: unknown, key: string) => (r && typeof r === 'object' && Array.isArray((r as Record<string, unknown>)[key]) ? ((r as Record<string, unknown>)[key] as unknown[]).length : null);

/** Probe parameters per op; code_flow takes entry_point, the others symbol. */
const PROBES: Record<CodeOp, { params: Record<string, unknown>; answerKey: string }> = {
  code_def: { params: { symbol: 'normalize' }, answerKey: 'defs' },
  code_refs: { params: { symbol: 'normalize' }, answerKey: 'refs' },
  code_callers: { params: { symbol: 'normalizeWindowsPath' }, answerKey: 'callers' },
  code_callees: { params: { symbol: 'resolve' }, answerKey: 'callees' },
  code_blast: { params: { symbol: 'normalizeWindowsPath' }, answerKey: 'depth_groups' },
  code_flow: { params: { entry_point: 'resolve' }, answerKey: 'depth_groups' },
};

export async function runN13(opts: { gut: GbrainUnderTest; log?: (s: string) => void }): Promise<N13RunResult> {
  return withHermeticEnv('n13', () => runN13Hermetic(opts));
}

async function runN13Hermetic(opts: { gut: GbrainUnderTest; log?: (s: string) => void }): Promise<N13RunResult> {
  const log = opts.log ?? (() => {});
  const result: N13RunResult = { manifest: null, gold: null, gold_sha256: null, import: null, readiness: [], def_check: [], refs_check: [], callers_check: null, walks: null, acc: new ProbeAccounting(0), harnessError: null };
  const corpus = verifyVendoredCorpus();
  result.manifest = corpus.manifest;
  if (corpus.problems.length) {
    result.harnessError = `vendored corpus hash check failed: ${corpus.problems.join('; ')}. The run is void; restore the files or rebuild the snapshot and manifest together.`;
    result.acc.error('corpus', 'harness', result.harnessError);
    return result;
  }
  const goldText = readFileSync(N13_GOLD_PATH, 'utf8');
  const gold = JSON.parse(goldText) as N13Gold;
  result.gold = gold;
  result.gold_sha256 = goldSha256(goldText);
  if (gold.corpus_commit !== corpus.manifest.commit) {
    result.harnessError = `ts-gold.json was built from ${gold.corpus_commit}, but the vendored corpus is ${corpus.manifest.commit}. Rebuild with bun eval/generators/n13-ts-gold.ts --write.`;
    result.acc.error('gold', 'harness', result.harnessError);
    return result;
  }
  const acc = new ProbeAccounting(CODE_OPS.length + gold.functions.length * 2);
  result.acc = acc;

  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(opts.gut, 'src/core/pglite-engine.ts');
  const { importCodeFile } = await importGbrain<{ importCodeFile(e: Engine, rel: string, content: string, o: { noEmbed: boolean }): Promise<{ status: string; chunks: number; error?: string }> }>(opts.gut, 'src/core/import-file.ts');
  const { resolveSymbolEdgesIncremental } = await importGbrain<{ resolveSymbolEdgesIncremental(e: Engine, o: { sourceId: string }): Promise<Record<string, number>> }>(opts.gut, 'src/core/chunkers/symbol-resolver.ts');
  const { handleToolCall } = await importGbrain<{ handleToolCall(e: Engine, tool: string, p: Record<string, unknown>): Promise<unknown> }>(opts.gut, 'src/mcp/server.ts');
  const { operations } = await importGbrain<{ operations: Op[] }>(opts.gut, 'src/core/operations.ts');
  const commandTable = readFileSync(join(opts.gut.root, 'src/cli/command-table.ts'), 'utf8');

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  try {
    const t0 = Date.now();
    const imports: Array<{ path: string; status: string; chunks: number; error?: string }> = [];
    for (const f of corpus.files) {
      const r = await importCodeFile(engine, f.path, f.content, { noEmbed: true });
      imports.push({ path: f.path, status: r.status, chunks: r.chunks, ...(r.error ? { error: r.error } : {}) });
    }
    const importMs = Date.now() - t0;
    const t1 = Date.now();
    const resolver = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
    const resolverMs = Date.now() - t1;
    const one = async (q: string) => Number((await engine.executeRaw<{ n: number }>(q))[0]?.n ?? 0);
    result.import = {
      files: imports, import_ms: importMs, resolver_ms: resolverMs, resolver: { ...resolver },
      code_pages: await one("SELECT count(*)::int AS n FROM pages WHERE type = 'code'"),
      chunks: await one('SELECT count(*)::int AS n FROM content_chunks'),
      chunks_with_symbol: await one('SELECT count(*)::int AS n FROM content_chunks WHERE symbol_name IS NOT NULL'),
      symbol_edges: await one('SELECT count(*)::int AS n FROM code_edges_symbol'),
      chunk_edges: await one('SELECT count(*)::int AS n FROM code_edges_chunk'),
    };
    log(`imported ${imports.length} files in ${importMs} ms; resolver ${resolverMs} ms`);
    if (!imports.some(i => i.chunks > 0)) throw new Error('presence: the import produced no chunks, so every op answer would be empty by construction');

    const call = async (tool: string, p: Record<string, unknown>) => {
      const s = Date.now();
      try { return { ok: true as const, value: await handleToolCall(engine, tool, p), ms: Date.now() - s }; } catch (e) { return { ok: false as const, error: errMsg(e), ms: Date.now() - s }; }
    };
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    for (const op of CODE_OPS) {
      const probe = PROBES[op];
      const r = await call(op, probe.params);
      let remoteRefused = false;
      let remoteCode: string | null = null;
      try {
        await operations.find(o => o.name === op)!.handler({ engine, config: { engine: 'pglite' }, logger, dryRun: false, remote: true, sourceId: 'default' }, probe.params);
      } catch (e) {
        remoteCode = (e as { code?: string }).code ?? null;
        remoteRefused = remoteCode === 'permission_denied';
      }
      const v = r.ok ? (r.value as Record<string, unknown>) : null;
      const cli = `code-${op.slice(5)}`;
      result.readiness.push({
        op, probe: probe.params, trusted_ok: r.ok, trusted_error: r.ok ? null : r.error,
        status: typeof v?.status === 'string' ? v.status : typeof v?.result === 'string' ? v.result : null,
        ready: typeof v?.ready === 'boolean' ? v.ready : null,
        answer_count: v ? count(v, probe.answerKey) : null,
        latency_ms: r.ms, remote_refused: remoteRefused, remote_error_code: remoteCode,
        cli_command: commandTable.includes(`name: '${cli}'`) ? cli : null,
      });
      if (r.ok) acc.score(`readiness:${op}`, (count(v, probe.answerKey) ?? 0) > 0 ? 1 : 0);
      else acc.error(`readiness:${op}`, 'sut', r.error);
    }

    const callersOf = new Map<string, CallerEdge[]>();
    for (const g of gold.functions) {
      const d = await call('code_def', { symbol: g.name });
      if (d.ok) {
        const defs = ((d.value as { defs?: DefHit[] }).defs ?? []);
        const c = checkDef(g, defs);
        result.def_check.push(c);
        acc.score(`def:${g.file}:${g.name}`, c.top1_span_ok ? 1 : 0);
      } else acc.error(`def:${g.file}:${g.name}`, 'sut', d.error);
      const rf = await call('code_refs', { symbol: g.name, limit: 200 });
      if (rf.ok) {
        const c = checkRefs(g, ((rf.value as { refs?: RefHit[] }).refs ?? []));
        result.refs_check.push(c);
        acc.score(`refs:${g.file}:${g.name}`, c.references_covered === c.gold_references ? 1 : 0);
      } else acc.error(`refs:${g.file}:${g.name}`, 'sut', rf.error);
      if (!callersOf.has(g.name)) {
        const cl = await call('code_callers', { symbol: g.name, limit: 200 });
        callersOf.set(g.name, cl.ok ? ((cl.value as { callers?: CallerEdge[] }).callers ?? []) : []);
      }
    }
    result.callers_check = checkCallers(gold.calls, callersOf);

    const goldDirect = (callee: string) => [...new Set(gold.calls.filter(c => c.callee === callee).map(c => c.caller))].sort();
    const blast = await call('code_blast', { symbol: 'normalizeWindowsPath', depth: 3 });
    const blastDepth1 = blast.ok ? (((blast.value as { depth_groups?: Array<{ depth: number; nodes: Array<{ symbol: string }> }> }).depth_groups ?? []).find(g => g.depth === 1)?.nodes ?? []).map(n => bare(n.symbol)).sort() : [];
    const flow = await call('code_flow', { entry_point: 'resolve', depth: 4 });
    const gateFiles = [
      { path: 'gate/sample_go.go', content: 'package main\n\nfunc goHelper() int {\n\treturn 1\n}\n\nfunc goCaller() int {\n\treturn goHelper() + 1\n}\n' },
      { path: 'gate/sample_py.py', content: 'def py_helper():\n    return 1\n\n\ndef py_caller():\n    return py_helper() + 1\n' },
      // The same bare name in a Go file and a Python file: the Python function is in a supported language.
      { path: 'gate/shared_go.go', content: 'package main\n\nfunc shared_helper() int {\n\treturn 2\n}\n\nfunc go_user() int {\n\treturn shared_helper()\n}\n' },
      { path: 'gate/shared_py.py', content: 'def shared_helper():\n    return 2\n\n\ndef py_user():\n    return shared_helper()\n' },
    ];
    for (const f of gateFiles) await importCodeFile(engine, f.path, f.content, { noEmbed: true });
    await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
    const gate = async (symbol: string) => {
      const r = await call('code_blast', { symbol });
      return r.ok ? (r.value as { result?: string }).result ?? null : `error: ${r.error}`;
    };
    const flowParamCheck = await call('code_flow', { symbol: 'resolve' });
    result.walks = {
      blast: blast.ok ? { symbol: 'normalizeWindowsPath', depth: 3, envelope: blast.value, depth1: blastDepth1, gold_direct_callers: goldDirect('normalizeWindowsPath') } : { error: blast.error },
      flow: flow.ok ? { entry_point: 'resolve', depth: 4, envelope: flow.value } : { error: flow.error },
      language_gate: { go: await gate('goHelper'), python: await gate('py_helper'), typescript: await gate('normalizeWindowsPath'), same_name_go_and_python: await gate('shared_helper') },
      flow_wrong_param: flowParamCheck.ok ? 'accepted' : flowParamCheck.error,
    };
    return result;
  } catch (e) {
    result.harnessError = `harness: ${errMsg(e)}`;
    acc.error('run', 'harness', result.harnessError);
    return result;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

export function summarizeN13(r: N13RunResult) {
  const n = (xs: readonly unknown[]) => xs.length;
  const defs = r.def_check;
  const refs = r.refs_check;
  const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  return {
    ops: CODE_OPS.length,
    ops_trusted_ok: r.readiness.filter(x => x.trusted_ok).length,
    ops_answered_nonempty: r.readiness.filter(x => (x.answer_count ?? 0) > 0).length,
    ops_remote_refused: r.readiness.filter(x => x.remote_refused).length,
    ops_with_cli_command: r.readiness.filter(x => x.cli_command).length,
    def: { symbols: n(defs), top1_file_ok: defs.filter(d => d.top1_file_ok).length, top1_span_ok: defs.filter(d => d.top1_span_ok).length, any_span_ok: defs.filter(d => d.any_span_ok).length, no_result: defs.filter(d => d.results === 0).length },
    refs: {
      symbols: n(refs), chunks: sum(refs, x => x.chunks), chunks_with_semantic_reference: sum(refs, x => x.chunks_with_semantic_reference),
      chunks_lexical_only: sum(refs, x => x.chunks_lexical_only), gold_references: sum(refs, x => x.gold_references), references_covered: sum(refs, x => x.references_covered),
      symbols_with_lexical_only_chunks: refs.filter(x => x.chunks_lexical_only > 0).map(x => x.symbol),
    },
    callers: r.callers_check,
  };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench N13: code-intelligence readiness scout (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const r = await runN13({ gut, log });
  const a = r.acc.summary();
  const s = r.harnessError ? null : summarizeN13(r);
  // Report-only scout: the verdict says whether every op answered the trusted call and refused the remote one. Nothing gates on it.
  const verdict = !s ? undefined : s.ops_trusted_ok === s.ops && s.ops_remote_refused === s.ops ? 'pass' : s.ops_trusted_ok > 0 ? 'partial' : 'fail';
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped, importCodeFile with noEmbed, keyword-only PGLite; no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessError ? 'error' : 'completed',
    ...(verdict ? { verdict } : {}),
    n_total: a.n_total, n_scored: a.n_scored, completion_rate: a.completion_rate, errors: a.errors,
    publishable: !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory', decide: DECIDE_OFF,
      caller: 'handleToolCall (trusted local, remote: false, parameters validated); remote check calls the op handler with remote: true',
      corpus: r.manifest ? { repository: r.manifest.repository, commit: r.manifest.commit, license: r.manifest.license, files: r.manifest.files.map(f => ({ path: f.path, sha256: f.sha256 })) } : null,
      gold: r.gold ? { path: 'eval/data/n13-code-scout/ts-gold.json', sha256: r.gold_sha256, generator_version: r.gold.generator_version, typescript_version: r.gold.typescript_version } : null,
      internal_entry_points: INTERNAL_ENTRY_POINTS,
      gbrain_overlay: overlaySummary(gut),
      runtime_ms: Date.now() - t0,
    },
    hashes: { ...(r.gold_sha256 ? { ts_gold_sha256: r.gold_sha256 } : {}), ...(r.manifest ? { corpus_commit: r.manifest.commit } : {}) },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      summary: s,
      import: r.import,
      readiness: r.readiness,
      def_check: r.def_check,
      refs_check: r.refs_check,
      callers_check: r.callers_check,
      walks: r.walks,
      documented_limits: DOCUMENTED_LIMITS,
      deferred: 'Broad caller, blast and flow quality: waits for independent call and flow gold (plan amendment 9).',
      harness_error: r.harnessError,
    },
  };
  writeReceipt(outPath, receipt);
  if (s) {
    log(`\nverdict: ${verdict} (report-only scout; nothing gates)`);
    log(`readiness: ${s.ops_trusted_ok}/${s.ops} ops answer the trusted call, ${s.ops_answered_nonempty}/${s.ops} non-empty on the probe symbol, ${s.ops_remote_refused}/${s.ops} refuse remote callers, ${s.ops_with_cli_command}/${s.ops} have a named CLI command`);
    for (const x of r.readiness) log(`  ${x.op}: ${x.trusted_ok ? `ok, ${x.answer_count ?? '-'} answers, status ${x.status}, ${x.latency_ms} ms` : `error: ${x.trusted_error}`}; remote ${x.remote_refused ? 'refused' : `NOT refused (${x.remote_error_code ?? 'returned'})`}; cli ${x.cli_command ?? 'none'}`);
    log(`code_def: top-1 location right for ${s.def.top1_span_ok} of ${s.def.symbols} top-level functions (any result right: ${s.def.any_span_ok})`);
    log(`code_refs: ${s.refs.chunks_lexical_only} of ${s.refs.chunks} returned chunks hold only a substring, no semantic reference; ${s.refs.references_covered} of ${s.refs.gold_references} compiler references covered`);
    if (s.callers) log(`code_callers: same-file calls found ${s.callers.same_file.found}/${s.callers.same_file.edges}, cross-file ${s.callers.cross_file.found}/${s.callers.cross_file.edges}; resolved flag true on ${s.callers.gbrain_edges_resolved_flag_true} of ${s.callers.gbrain_edges} edges, resolved in metadata on ${s.callers.gbrain_edges_resolved_in_metadata}`);
  } else log(`run error: ${r.harnessError}`);
  log(`runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, summary: s }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

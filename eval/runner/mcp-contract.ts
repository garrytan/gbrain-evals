/**
 * BrainBench Category 12: MCP Operation Contract.
 *
 * Tests gbrain operation handlers under (trusted local, untrusted remote) ×
 * (valid, boundary, invalid, injection, resource-exhaustion) inputs.
 *
 * Focused on security-boundary operations and limit enforcement. The unit
 * test suite covers happy-path correctness for every op; this benchmark
 * focuses on the contract surface that an attacker probes.
 *
 * Pass criteria (each backed by an assertion that CAN fail — audit
 * agentic-cats-04/05/13 killed the decorative versions):
 *   - Valid input → correct response
 *   - Invalid input → rejected with clear error (not silent corruption)
 *   - Injection attempts → blocked (no SQL injection, no path traversal)
 *   - Depth cap bites: the seeded chain is LONGER than the traverse cap, so
 *     an uncapped traversal reaches more chain nodes than the cap allows and
 *     the assertion fails. Remote callers get GraphPath[] edges (gbrain
 *     v0.48.1.0, #4704): the check pins that wire shape, a walk frontier
 *     EXACTLY at the cap for depth=1000 (and at the documented depth-2
 *     default when depth is omitted), and the direction=both default via an
 *     edge that points INTO the start page. (Pre-fix: `pass = r.ok || …` on
 *     a 10-node ring — deleting gbrain's cap could not fail the check.)
 *   - Trust boundary actually differential: the same op runs under BOTH
 *     ctx.remote=false and ctx.remote=true and remote must be strictly
 *     tighter (list_pages 100-row remote clamp vs local unbounded; per-call
 *     search `mode` honored locally, silently ignored remotely). (Pre-fix:
 *     every call used remote=true and the "matrix" was never exercised.)
 *   - The ~135 always-true "op has a handler" rows are a separate sanity
 *     walk, no longer diluting the behavioral pass-rate.
 *
 * Hermetic: PGLite in-memory, `search.mcp_keyword_only=true` (no embedding
 * gateway, no API keys). Writes a receipt (WS0) at
 * eval/reports/mcp-contract/receipt.json; behavioral assertion failures are
 * 'sut' probe errors (gbrain misbehaved → scored miss), verdict fail.
 *
 * Usage: bun run eval/runner/mcp-contract.ts [--json]
 */

import { PGLiteEngine } from 'gbrain/pglite-engine';
import { operations as OPERATIONS } from 'gbrain/operations';
import type { OperationContext } from 'gbrain/operations';
import type { GBrainConfig } from 'gbrain/config';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  writeReceipt,
  receiptPath,
  RECEIPT_SCHEMA_VERSION,
  BENCHMARK_VERSION,
  type Receipt,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

// ─── Documented gbrain limits under test ─────────────────────────────
// If gbrain changes these, the eval must change WITH the contract — that is
// the point of pinning them here rather than importing private constants.

/** gbrain src/core/ops/links.ts TRAVERSE_DEPTH_CAP. */
export const TRAVERSE_DEPTH_CAP = 10;
/**
 * gbrain src/core/ops/links.ts REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH (v0.48.1.0,
 * #4704): a remote call that leaves BOTH direction and depth to default walks
 * `both` at this depth; an explicit depth is honored up to TRAVERSE_DEPTH_CAP.
 */
export const REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH = 2;
/** gbrain src/core/ops/pages.ts remote list_pages clamp. */
export const REMOTE_LIST_PAGES_CAP = 100;

// ─── Seed geometry ────────────────────────────────────────────────────
// The fixtures are sized so every cap assertion can fail:
//   - the chain is LONGER than the traverse cap (uncapped walk returns more)
//   - the page count EXCEEDS the remote list clamp (unclamped list returns more)

export const CHAIN_LENGTH = 16; // > TRAVERSE_DEPTH_CAP + 1
export const chainSlug = (i: number): string => `chain/c${i}`;
/** chain/c0 … chain/c15, in walk order. */
export const CHAIN_SLUGS: readonly string[] = Array.from({ length: CHAIN_LENGTH }, (_, i) => chainSlug(i));
/**
 * One page whose only edge points INTO the chain root (chain/inbound → c0).
 * A remote no-direction traverse_graph walks `both` (gbrain v0.48.1.0,
 * #4704; fixes #4666) and must return this edge; the legacy outbound default
 * never did — the "inbound-only pages read as no links" bug.
 */
export const CHAIN_INBOUND_SLUG = 'chain/inbound';
const CHAIN_INBOUND_PAGES = 1;
const RING_SIZE = 10;
const NOTE_PAGES = 110;
/** people ring + chain (+ its inbound page) + filler notes. Must exceed REMOTE_LIST_PAGES_CAP. */
export const TOTAL_SEEDED_PAGES = RING_SIZE + CHAIN_LENGTH + CHAIN_INBOUND_PAGES + NOTE_PAGES;
/** Between the remote cap and the total page count, so local vs remote differ. */
const MATRIX_LIST_LIMIT = 120;

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function setupEngine(): Promise<{ engine: PGLiteEngine; cleanup: () => Promise<void> }> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Hermetic search path: keyword-only, no embedding gateway, no keys. The
  // per-call `mode` param is resolved BEFORE this branch in the handler, so
  // the trust-matrix mode test still exercises resolvePerCallMode.
  await engine.setConfig('search.mcp_keyword_only', 'true');
  // Ring for generic traversal sanity.
  for (let i = 0; i < RING_SIZE; i++) {
    await engine.putPage(`people/p${i}`, {
      type: 'person', title: `P${i}`, compiled_truth: `Person ${i}.`, timeline: '',
    });
  }
  for (let i = 0; i < RING_SIZE; i++) {
    await engine.addLink(`people/p${i}`, `people/p${(i + 1) % RING_SIZE}`, '', 'mentions');
  }
  // Chain LONGER than the traverse cap: c0 → c1 → … → c15 (out-degree 1, no
  // cycles). An uncapped depth=1000 walk reaches all CHAIN_LENGTH nodes; the
  // capped walk must stop at TRAVERSE_DEPTH_CAP hops.
  for (let i = 0; i < CHAIN_LENGTH; i++) {
    await engine.putPage(chainSlug(i), {
      type: 'concept', title: `C${i}`, compiled_truth: `Chain node ${i}.`, timeline: '',
    });
  }
  for (let i = 0; i < CHAIN_LENGTH - 1; i++) {
    await engine.addLink(chainSlug(i), chainSlug(i + 1), '', 'mentions');
  }
  // Inbound-only neighbour of the chain root: only a bidirectional walk from
  // c0 can surface chain/inbound → c0.
  await engine.putPage(CHAIN_INBOUND_SLUG, {
    type: 'concept', title: 'Inbound', compiled_truth: 'Points into the chain root.', timeline: '',
  });
  await engine.addLink(CHAIN_INBOUND_SLUG, chainSlug(0), '', 'mentions');
  // Filler pages so the brain holds MORE than the remote list clamp.
  for (let i = 0; i < NOTE_PAGES; i++) {
    await engine.putPage(`notes/extra-${String(i).padStart(3, '0')}`, {
      type: 'note', title: `Extra ${i}`, compiled_truth: `Filler note ${i}.`, timeline: '',
    });
  }
  return {
    engine,
    cleanup: async () => { await engine.disconnect(); },
  };
}

function ctx(remote: boolean, engine: PGLiteEngine): OperationContext {
  const config: GBrainConfig = { engine: 'pglite', database_path: ':memory:' };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  // v0.34 D4: sourceId is REQUIRED write-authority scope; 'default' matches
  // buildOperationContext's auto-fill on single-source brains.
  return { engine, config, logger: logger as never, dryRun: false, remote, sourceId: 'default' };
}

export type OpOutcome = { ok: true; result: unknown } | { ok: false; error: string };

async function runOp(opName: string, params: Record<string, unknown>, c: OperationContext): Promise<OpOutcome> {
  const op = OPERATIONS.find(o => o.name === opName);
  if (!op) return { ok: false, error: `unknown operation: ${opName}` };
  try {
    const result = await op.handler(c, params);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Pure assertion helpers (exported so tests can prove they CAN fail) ─

/** The GraphPath edge row gbrain returns to remote traverse_graph callers (v0.48.1.0, #4704). */
export type GraphEdgeRow = { from_slug: string; to_slug: string; depth: number };

function isGraphEdgeRow(row: unknown): row is GraphEdgeRow {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.from_slug === 'string' && typeof r.to_slug === 'string' && typeof r.depth === 'number';
}

/**
 * Remote traverse_graph depth contract (gbrain v0.48.1.0, #4704): the call
 * returns GraphPath[] edges, and the walk over a chain LONGER than `hops`
 * has its frontier EXACTLY at `hops` — the cap for depth=1000, the documented
 * default when depth is omitted, the literal value for an under-cap depth.
 * Passes iff:
 *   - at least one row came back and EVERY row is a GraphPath edge (the
 *     legacy GraphNode[] shape fails);
 *   - the deepest edge sits exactly at `hops` (deeper: the cap was ignored;
 *     shallower: the explicit depth was dropped or the walk broke);
 *   - the walk touched exactly root + `hops` chain nodes, fewer than the
 *     chain holds (an uncapped walk reaches the whole chain; a chain that is
 *     not longer than `hops` makes the check vacuous, so that is a fail).
 * Bidirectional re-emission of walked edges at depth+1 and edges to pages
 * outside the chain do not move the verdict.
 */
export function checkDepthCap(
  rows: unknown[],
  chainSlugs: readonly string[],
  hops: number,
): { pass: boolean; detail: string } {
  const edges = rows.filter(isGraphEdgeRow);
  const wellFormed = rows.length > 0 && edges.length === rows.length;
  const maxDepth = edges.reduce((m, e) => Math.max(m, e.depth), 0);
  const touched = new Set(edges.flatMap(e => [e.from_slug, e.to_slug]));
  const reached = chainSlugs.filter(s => touched.has(s)).length;
  const pass = wellFormed && maxDepth === hops && reached === hops + 1 && reached < chainSlugs.length;
  return {
    pass,
    detail: `${rows.length} rows (${edges.length} GraphPath edges) reached ${reached} nodes of the `
      + `${chainSlugs.length}-node chain, max depth ${maxDepth}, expected frontier ${hops}`,
  };
}

/**
 * Remote direction default (gbrain v0.48.1.0, #4704; fixes #4666): a remote
 * traverse_graph call with no `direction` walks `both`, so an edge that
 * points INTO the start page comes back. The legacy outbound default never
 * returned it — inbound-only pages read as "no links". Passes iff the
 * inbound edge AND the outbound chain edge are both present as GraphPath
 * rows (an `in`-only or `out`-only walk cannot fake a pass).
 */
export function checkRemoteDirectionDefault(
  rows: unknown[],
  inbound: { from_slug: string; to_slug: string },
  outbound: { from_slug: string; to_slug: string },
): { pass: boolean; detail: string } {
  const edges = rows.filter(isGraphEdgeRow);
  const has = (e: { from_slug: string; to_slug: string }) =>
    edges.some(r => r.from_slug === e.from_slug && r.to_slug === e.to_slug);
  const sawIn = has(inbound);
  const sawOut = has(outbound);
  return {
    pass: sawIn && sawOut,
    detail: `inbound ${inbound.from_slug}→${inbound.to_slug}: ${sawIn ? 'returned' : 'MISSING'}; `
      + `outbound ${outbound.from_slug}→${outbound.to_slug}: ${sawOut ? 'returned' : 'MISSING'}`,
  };
}

/**
 * The remote list clamp bit iff more pages exist than the cap AND no more
 * than the cap came back. A seed smaller than the cap makes the check
 * vacuous, so that is a FAIL too (the pre-fix version asserted <= 1000 over
 * 10 seeded pages — unfailable).
 */
export function checkRemoteListClamp(
  returnedRows: number,
  totalPages: number,
  cap: number,
): { pass: boolean; detail: string } {
  const pass = totalPages > cap && returnedRows <= cap;
  return {
    pass,
    detail: `remote list_pages returned ${returnedRows} rows with ${totalPages} pages seeded (cap ${cap})`,
  };
}

/**
 * Trust matrix, list_pages: the SAME over-cap limit must be honored locally
 * (ctx.remote=false) and clamped remotely (ctx.remote=true). Remote must be
 * strictly tighter.
 */
export function checkListPagesTrustMatrix(
  localRows: number,
  remoteRows: number,
  cap: number,
): { pass: boolean; detail: string } {
  const pass = localRows > cap && remoteRows <= cap && remoteRows < localRows;
  return {
    pass,
    detail: `local returned ${localRows} rows, remote returned ${remoteRows} (remote cap ${cap})`,
  };
}

/**
 * Trust matrix, search per-call mode (gbrain resolvePerCallMode): an unknown
 * mode must be LOUDLY rejected locally and silently ignored remotely (a
 * remote caller cannot select modes, so the param never reaches validation).
 */
export function checkModeDifferential(
  local: { ok: boolean; error?: string },
  remote: { ok: boolean; error?: string },
): { pass: boolean; detail: string } {
  const localRejects = !local.ok && (local.error ?? '').includes('Unknown search mode');
  const remoteIgnores = remote.ok || !(remote.error ?? '').includes('Unknown search mode');
  return {
    pass: localRejects && remoteIgnores,
    detail: `local: ${local.ok ? 'accepted (BUG — unknown mode must be rejected)' : (local.error ?? '').slice(0, 80)}; `
      + `remote: ${remote.ok ? 'ok (mode ignored)' : (remote.error ?? '').slice(0, 80)}`,
  };
}

// ─── The behavioral contract checks ───────────────────────────────────

export async function runContractChecks(
  engine: PGLiteEngine,
  log: (line: string) => void = () => {},
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const push = (r: TestResult) => {
    results.push(r);
    log(`  ${r.pass ? '✓' : '✗'} ${r.name} — ${r.detail}`);
  };

  // ── Limit cap: traverse_graph depth (chain longer than the cap) ──
  // Remote contract (gbrain v0.48.1.0, #4704): no direction filter → walks
  // `both` and returns GraphPath[] edges; an explicit depth is honored up to
  // the cap; depth AND direction both defaulted → REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH.
  log('\n## Limit cap: traverse_graph depth');
  const capName = `traverse_graph depth=1000 over a ${CHAIN_LENGTH}-node chain stops at the ${TRAVERSE_DEPTH_CAP}-hop cap`;
  {
    const r = await runOp('traverse_graph', { slug: chainSlug(0), depth: 1000 }, ctx(true, engine));
    if (r.ok) {
      push({ name: capName, ...checkDepthCap(r.result as unknown[], CHAIN_SLUGS, TRAVERSE_DEPTH_CAP) });
    } else {
      // A loud rejection naming the limit is also acceptable cap enforcement.
      const pass = r.error.includes('depth') || r.error.includes('limit');
      push({ name: capName, pass, detail: `rejected: ${r.error.slice(0, 100)}` });
    }
  }
  {
    const r = await runOp('traverse_graph', { slug: chainSlug(0), depth: 5 }, ctx(true, engine));
    push({
      name: 'traverse_graph depth=5 (under cap) is honored exactly: GraphPath frontier at 5 hops',
      ...(r.ok
        ? checkDepthCap(r.result as unknown[], CHAIN_SLUGS, 5)
        : { pass: false, detail: `unexpected error: ${r.error.slice(0, 100)}` }),
    });
  }
  {
    // The natural no-filter invocation (#4666): direction AND depth defaulted.
    const r = await runOp('traverse_graph', { slug: chainSlug(0) }, ctx(true, engine));
    const rows = r.ok ? (r.result as unknown[]) : [];
    const errored = { pass: false, detail: `unexpected error: ${r.ok ? '' : r.error.slice(0, 100)}` };
    push({
      name: `traverse_graph remote call with depth AND direction defaulted walks exactly ${REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH} hops`,
      ...(r.ok ? checkDepthCap(rows, CHAIN_SLUGS, REMOTE_BIDIRECTIONAL_DEFAULT_DEPTH) : errored),
    });
    push({
      name: 'traverse_graph remote no-direction call defaults to direction=both (inbound edge into the start page is returned)',
      ...(r.ok
        ? checkRemoteDirectionDefault(
          rows,
          { from_slug: CHAIN_INBOUND_SLUG, to_slug: chainSlug(0) },
          { from_slug: chainSlug(0), to_slug: chainSlug(1) },
        )
        : errored),
    });
  }

  // ── Limit cap: list_pages remote clamp (seed larger than the cap) ──
  log('\n## Limit cap: list_pages remote clamp');
  {
    const r = await runOp('list_pages', { limit: 1_000_000 }, ctx(true, engine));
    if (r.ok) {
      const list = r.result as Array<unknown>;
      push({
        name: `list_pages limit=1M from remote is clamped to ${REMOTE_LIST_PAGES_CAP} rows`,
        ...checkRemoteListClamp(list.length, TOTAL_SEEDED_PAGES, REMOTE_LIST_PAGES_CAP),
      });
    } else {
      push({ name: 'list_pages limit=1M from remote is clamped', pass: false, detail: `errored: ${r.error.slice(0, 100)}` });
    }
  }

  // ── Trust matrix: the SAME op under remote=false vs remote=true ──
  log('\n## Trust matrix: trusted local vs untrusted remote');
  {
    const local = await runOp('list_pages', { limit: MATRIX_LIST_LIMIT }, ctx(false, engine));
    const remote = await runOp('list_pages', { limit: MATRIX_LIST_LIMIT }, ctx(true, engine));
    if (local.ok && remote.ok) {
      const localRows = (local.result as Array<unknown>).length;
      const remoteRows = (remote.result as Array<unknown>).length;
      push({
        name: `list_pages limit=${MATRIX_LIST_LIMIT}: honored locally, clamped to ${REMOTE_LIST_PAGES_CAP} remotely`,
        ...checkListPagesTrustMatrix(localRows, remoteRows, REMOTE_LIST_PAGES_CAP),
      });
    } else {
      push({
        name: `list_pages limit=${MATRIX_LIST_LIMIT}: honored locally, clamped remotely`,
        pass: false,
        detail: `local: ${local.ok ? 'ok' : local.error.slice(0, 60)}; remote: ${remote.ok ? 'ok' : remote.error.slice(0, 60)}`,
      });
    }
  }
  {
    const local = await runOp('search', { query: 'chain node', mode: 'not-a-real-mode', limit: 5 }, ctx(false, engine));
    const remote = await runOp('search', { query: 'chain node', mode: 'not-a-real-mode', limit: 5 }, ctx(true, engine));
    push({
      name: 'search per-call mode: unknown mode loudly rejected locally, ignored remotely',
      ...checkModeDifferential(local, remote),
    });
  }

  // ── Input validation: slug format ──
  log('\n## Input validation: slug format');
  {
    const badSlugs = [
      { slug: '../etc/passwd', label: 'path traversal' },
      { slug: '/absolute/path', label: 'absolute path' },
      { slug: '../../escape', label: 'parent escape' },
      { slug: 'no-directory', label: 'missing directory prefix' },
      { slug: '', label: 'empty string' },
      { slug: 'people/' + 'x'.repeat(10_000), label: 'huge slug (10K chars)' },
    ];
    for (const { slug, label } of badSlugs) {
      const r = await runOp('get_page', { slug }, ctx(true, engine));
      // Either rejects with error OR returns null (page not found, no crash, no traversal)
      // The DANGER would be: returns content from outside the brain, or crashes the server.
      const pass = !r.ok || r.result === null || r.result === undefined;
      push({
        name: `get_page rejects/null-returns ${label}`,
        pass,
        detail: r.ok ? `returned ${typeof r.result}` : `rejected: ${r.error.slice(0, 80)}`,
      });
    }
  }

  // ── Input validation: date format ──
  log('\n## Input validation: date format');
  {
    const badDates = ['not-a-date', '2026-13-45', '99999-01-01', '', '../../../etc/passwd'];
    for (const date of badDates) {
      const r = await runOp('add_timeline_entry', { slug: 'people/p0', date, summary: 'test' }, ctx(true, engine));
      // Should reject invalid dates with error.
      const pass = !r.ok;
      push({
        name: `add_timeline_entry rejects invalid date "${date.slice(0, 30)}"`,
        pass,
        detail: r.ok ? 'silently accepted (BUG)' : `rejected: ${r.error.slice(0, 80)}`,
      });
    }
  }

  // ── Injection: SQL injection attempts in search ──
  log('\n## Injection: SQL injection attempts');
  {
    const sqlPayloads = [
      `'; DROP TABLE pages; --`,
      `' OR '1'='1`,
      `'; SELECT * FROM access_tokens; --`,
      `\\x00\\x00\\x00`,
      `\u0000injection`,
    ];
    for (const payload of sqlPayloads) {
      const r = await runOp('search', { query: payload, limit: 5 }, ctx(true, engine));
      // Should NOT throw a SQL parse error (which would mean the input reached SQL).
      // Should return empty results or a clean error.
      const pass = r.ok || !r.error.toLowerCase().includes('syntax');
      push({
        name: `search resists SQL payload "${payload.slice(0, 30)}"`,
        pass,
        detail: r.ok ? 'parameterized OK' : `error: ${r.error.slice(0, 80)}`,
      });
    }
  }

  // ── Resource exhaustion: large inputs ──
  log('\n## Resource exhaustion: large inputs');
  {
    const huge = 'x'.repeat(10_000_000); // 10MB string
    const start = Date.now();
    const r = await runOp('search', { query: huge, limit: 5 }, ctx(true, engine));
    const elapsed = Date.now() - start;
    const pass = elapsed < 5000; // under 5s
    push({
      name: 'search with 10MB query string returns within 5s',
      pass,
      detail: `${elapsed}ms${r.ok ? ' (returned)' : ` (rejected: ${r.error.slice(0, 60)})`}`,
    });
  }

  // ── Trust boundary: file_upload path confinement ──
  // Skipped — file_upload requires actual filesystem setup. Covered by unit
  // tests in test/file-upload-security.test.ts.

  return results;
}

// ─── Handler-presence sanity walk (reported SEPARATELY) ───────────────
//
// One trivially-true row per registered op used to sit in the same results
// array as the ~25 behavioral assertions, so 3 real failures printed as
// "98% passed" (audit agentic-cats-13). The walk is still worth keeping —
// a registry entry without a handler is a packaging bug — but it is a
// single sanity gate now, never part of the behavioral pass-rate.

export function handlerSanityWalk(): { total: number; missing: string[] } {
  const missing = OPERATIONS.filter(op => typeof op.handler !== 'function').map(op => op.name);
  return { total: OPERATIONS.length, missing };
}

// ─── Runner entry ─────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const json = argv.includes('--json');
  const log = json ? () => {} : (line: string) => console.log(line);
  const startedAt = new Date().toISOString();
  const receiptFile = receiptPath('mcp-contract');

  log('# BrainBench Category 12: MCP Operation Contract\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
  log(`Operations available: ${OPERATIONS.length}`);

  let results: TestResult[];
  let handlerWalk: { total: number; missing: string[] };
  const { engine, cleanup } = await setupEngine();
  try {
    results = await runContractChecks(engine, log);
    handlerWalk = handlerSanityWalk();
  } catch (err) {
    // Harness/dependency crash — write an error receipt so all.ts never
    // mistakes a dead run for anything else, then exit non-zero.
    await cleanup().catch(() => {});
    writeReceipt(receiptFile, {
      schema_version: RECEIPT_SCHEMA_VERSION,
      benchmark_version: BENCHMARK_VERSION,
      category: 'mcp-contract',
      run_status: 'error',
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors: [{ probe_id: 'harness:setup-or-run', origin: 'harness', message: String(err).slice(0, 500) }],
      publishable: false,
      gbrain_version: gbrainVersion(),
      gbrain_pin: gbrainPin(),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    console.error('MCP contract eval error:', err);
    return 3;
  }
  await cleanup();

  // ── Accounting (WS0): behavioral assertion failure = gbrain broke its
  // contract = sut failure, scored 0 and kept in the denominator. ──
  const acc = new ProbeAccounting(results.length);
  for (const r of results) {
    if (r.pass) acc.score(r.name, 1);
    else acc.error(r.name, 'sut', r.detail);
  }
  const summary = acc.summary();

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  const handlerOk = handlerWalk.missing.length === 0;

  log(`\n## Handler sanity walk (separate from behavioral pass-rate)`);
  log(`  ${handlerOk ? '✓' : '✗'} ${handlerWalk.total - handlerWalk.missing.length}/${handlerWalk.total} operations have handlers`
    + (handlerOk ? '' : ` — missing: ${handlerWalk.missing.join(', ')}`));

  log(`\n## Summary`);
  log(`Behavioral assertions: ${results.length}`);
  log(`Passed: ${passed} (${((passed / results.length) * 100).toFixed(1)}%)`);
  log(`Failed: ${failed}`);

  if (failed > 0) {
    log('\nFailures:');
    for (const r of results.filter(r => !r.pass)) {
      log(`  ✗ ${r.name}`);
      log(`    ${r.detail}`);
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      results,
      handler_walk: handlerWalk,
      summary: { passed, failed, total: results.length, handler_ok: handlerOk },
    }, null, 2) + '\n');
  }

  const verdict: 'pass' | 'fail' = failed === 0 && handlerOk ? 'pass' : 'fail';
  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'mcp-contract',
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      search_mode: 'keyword-only (search.mcp_keyword_only=true — hermetic, no embedding gateway, no keys)',
      seeded_pages: TOTAL_SEEDED_PAGES,
      chain_length: CHAIN_LENGTH,
      traverse_depth_cap: TRAVERSE_DEPTH_CAP,
      remote_list_pages_cap: REMOTE_LIST_PAGES_CAP,
      trust_contexts: ['remote=false (trusted local)', 'remote=true (untrusted remote)'],
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      behavioral: { passed, failed, total: results.length },
      handler_walk: { total: handlerWalk.total, missing: handlerWalk.missing },
      failures: results.filter(r => !r.pass).map(r => ({ name: r.name, detail: r.detail })),
    },
  };
  writeReceipt(receiptFile, receipt);

  if (verdict === 'fail') {
    console.error(`\n⚠ ${failed} contract assertion(s) failed${handlerOk ? '' : `; ${handlerWalk.missing.length} op(s) missing handlers`}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(e => {
      console.error('MCP contract eval error:', e);
      process.exit(1);
    });
}

/**
 * memory-qa keyless golden: the gbrain retrieval path, captured before the
 * shootout moved it behind the `MemorySystem` interface (plan "Architecture",
 * engineering review T2). Keyless, $0, no network.
 *
 * Runs the unchanged CLI on the invented decide fixture with hash embeddings
 * and compares every row (minus wall-clock latency), the receipt fields that
 * describe what ran, and a hash of the legacy reader prompt each row would
 * send, against test/eval/fixtures/memory-qa-golden.json.
 *
 * Regenerate only when a change to the gbrain path is intended:
 *   UPDATE_MEMORY_QA_GOLDEN=1 bun test test/eval/memory-qa-golden.test.ts
 *
 * With GBRAIN_OVERLAY_SPEC=<gbrain checkout>@<sha> (the shootout's frozen gbrain master) it also runs both gbrain
 * adapters on that build as a `--gbrain` overlay, keyless: the legacy path (its retrieved sessions are compared with
 * the pin's golden and any difference printed, not failed), and the shootout recipe with its reranker calls answered
 * by a local stand-in for the metering proxy.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadFixture, type Session } from '../../eval/runner/memory-qa/corpus.ts';
import { packSessions, readerPrompt } from '../../eval/runner/memory-qa/qa.ts';

const ROOT = resolve(import.meta.dir, '../..');
const GOLDEN = join(import.meta.dir, 'fixtures/memory-qa-golden.json');

function goldenOf(outDir: string): Record<string, unknown> {
  const rows = readFileSync(join(outDir, 'rows.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
  const receipt = JSON.parse(readFileSync(join(outDir, 'receipt.json'), 'utf8')) as Record<string, any>;
  const corpus = loadFixture();
  const qById = new Map(corpus.questions.map(q => [q.id, q]));
  const convById = new Map(corpus.conversations.map(c => [c.id, c]));
  const legacyRows = rows.map(({ latency_ms: _latency, ...r }) => {
    const q = qById.get(String(r.id))!;
    const sessions = convById.get(q.conversation)!.sessions;
    const byId = new Map(sessions.map(s => [s.id, s]));
    const pack = packSessions(((r.retrieved as string[]) ?? []).map(id => byId.get(id)).filter((s): s is Session => !!s), 5, null);
    const last = sessions.map(s => s.date ?? '').sort().pop() || undefined;
    return { ...r, reader_prompt_sha256: createHash('sha256').update(readerPrompt(q, pack.sessions, last)).digest('hex') };
  });
  const { latency_p50_ms: _p50, latency_p95_ms: _p95, ...summary } = receipt.summary;
  return {
    rows: legacyRows,
    receipt: {
      kind: receipt.kind, schema_version: receipt.schema_version, benchmark: receipt.benchmark, split: receipt.split, run_status: receipt.run_status,
      invalid_reasons: receipt.invalid_reasons, search_pins: receipt.search_pins, retrieval_path: receipt.retrieval_path,
      embedding: { mode: receipt.embedding.mode, model: receipt.embedding.model, dims: receipt.embedding.dims },
      selection: receipt.selection, counts: receipt.counts, summary, fidelity: receipt.fidelity, rows_file: receipt.rows_file,
    },
  };
}

describe('memory-qa golden (keyless fixture, hash embeddings)', () => {
  test('the CLI reproduces the captured rows, receipt and legacy reader prompts', () => {
    const out = mkdtempSync(join(tmpdir(), 'mqa-golden-'));
    try {
      const proc = Bun.spawnSync([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', '--output', out], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_EVALS_QA_CACHE: join(out, 'qa-cache') } });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      const got = goldenOf(out);
      if (process.env.UPDATE_MEMORY_QA_GOLDEN === '1') writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
      expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 120_000);
});

describe.skipIf(!process.env.GBRAIN_OVERLAY_SPEC)('gbrain overlay build (GBRAIN_OVERLAY_SPEC)', () => {
  test('both gbrain adapters run the fixture keyless on the overlay build', async () => {
    const spec = process.env.GBRAIN_OVERLAY_SPEC!;
    const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
      const path = new URL(req.url).pathname;
      const body = await req.json().catch(() => ({})) as { model?: string; documents?: string[] };
      if (path.startsWith('/__proxy/')) return Response.json(path.endsWith('finalize') ? { usd: 0, requests: 0, unpriced: 0, byModel: {} } : { ok: true });
      if (path.endsWith('/rerank')) return Response.json({ object: 'list', model: body.model, data: (body.documents ?? []).map((_, i) => ({ index: i, relevance_score: 1 - i / 10 })), usage: { total_tokens: 1 } });
      return Response.json({ error: 'no route' }, { status: 404 });
    } });
    const run = async (args: string[]) => {
      const out = mkdtempSync(join(tmpdir(), 'mqa-overlay-'));
      const proc = Bun.spawn([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', '--gbrain', spec, ...args, '--output', out], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code, err.slice(-1500)).toBe(0);
      return out;
    };
    try {
      const legacy = await run([]);
      const receipt = JSON.parse(readFileSync(join(legacy, 'receipt.json'), 'utf8'));
      expect(receipt.run_status).toBe('complete');
      expect(receipt.overlay.verified.tree_matches).toBe(true);
      const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { rows: Array<{ id: string; retrieved: string[] }> };
      const rows = readFileSync(join(legacy, 'rows.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string; retrieved: string[] });
      const moved = rows.filter(r => JSON.stringify(r.retrieved) !== JSON.stringify(golden.rows.find(g => g.id === r.id)?.retrieved));
      if (moved.length) console.log(`[overlay] ${moved.length} of ${rows.length} fixture rows retrieve differently from the pin's golden: ${moved.map(r => r.id).join(', ')}`);
      expect(rows).toHaveLength(golden.rows.length);
      const shootout = await run(['--system', 'gbrain-shootout', '--context', 'native', '--provider-proxy', `http://127.0.0.1:${proxy.port}`]);
      const r2 = JSON.parse(readFileSync(join(shootout, 'receipt.json'), 'utf8'));
      expect([r2.run_status, r2.outcomes.scored, existsSync(join(shootout, 'rows.ndjson'))]).toEqual(['complete', 8, true]);
      for (const d of [legacy, shootout]) rmSync(d, { recursive: true, force: true });
    } finally { proxy.stop(true); }
  }, 900_000);
});

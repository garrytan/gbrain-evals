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
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

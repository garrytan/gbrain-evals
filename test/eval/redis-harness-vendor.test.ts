import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const DIR = join(ROOT, 'eval/redis-agent-memory-benchmark');
const LOCAL = new Set(['README.md', 'vendor.json', 'uv.lock']);

interface VendoredFile { path: string; upstream_path: string; upstream_blob: string; changed: boolean; header?: boolean; local_sha256?: string }
const vendor = JSON.parse(readFileSync(join(DIR, 'vendor.json'), 'utf8')) as {
  upstream: { commit: string };
  reference: { commit: string; files: VendoredFile[] };
  files: VendoredFile[];
};
const all = [...vendor.files, ...vendor.reference.files];

const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function walk(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: DIR, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

describe('vendored Redis LongMemEval harness', () => {
  test('every file in the folder is either listed in vendor.json or a named local file', () => {
    const listed = new Set(all.map(f => f.path));
    expect(walk().filter(p => !listed.has(p) && !LOCAL.has(p))).toEqual([]);
  });

  test('source files open with a header naming the upstream path, commit and changes', () => {
    for (const f of all.filter(f => f.header !== false)) {
      const first = readFileSync(join(DIR, f.path), 'utf8').split('\n', 1)[0];
      expect(first.startsWith(`# Vendored from redis/agent-memory-server@${vendor.upstream.commit}, ${f.upstream_path} (Apache-2.0). Changes: `)).toBe(true);
      expect(first.endsWith(f.changed ? '.' : 'Changes: none.')).toBe(true);
      if (f.changed) expect(first).not.toContain('Changes: none.');
    }
  });

  test('files marked unchanged match their upstream blob byte for byte once the header is removed', () => {
    for (const f of all.filter(f => !f.changed)) {
      const bytes = readFileSync(join(DIR, f.path));
      const body = f.header === false ? bytes : bytes.subarray(bytes.indexOf(0x0a) + 1);
      expect([f.path, gitBlob(body)]).toEqual([f.path, f.upstream_blob]);
    }
  });

  test('files marked changed match the bytes recorded when they were changed', () => {
    const changed = all.filter(f => f.changed);
    expect(changed.length).toBeGreaterThan(0);
    for (const f of changed) {
      const sha = createHash('sha256').update(readFileSync(join(DIR, f.path))).digest('hex');
      expect([f.path, sha]).toEqual([f.path, f.local_sha256 ?? '']);
    }
  });

  test('the dataset loader is pinned to one Hugging Face revision', () => {
    const loader = readFileSync(join(DIR, 'src/agent_memory_benchmark/datasets/longmemeval.py'), 'utf8');
    expect(loader).toContain('98d7416c24c778c2fee6e6f3006e7a073259d48f');
    expect(loader).not.toContain('resolve/main');
  });

  test('no third-party provider adapter is vendored or registered', () => {
    expect(walk().filter(p => p.endsWith('_store.py') || p.endsWith('memory_bank.py'))).toEqual([]);
    const registry = readFileSync(join(DIR, 'src/agent_memory_benchmark/memory/__init__.py'), 'utf8');
    expect(registry).toContain('STORES: dict[str, type[MemoryStore]] = {}');
  });
});

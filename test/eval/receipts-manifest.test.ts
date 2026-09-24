/**
 * Receipts-manifest gate — keyless, $0, no network.
 *
 * docs/receipts-manifest.json maps README/report claims to committed
 * artifacts. This test is the enforcement half of that contract (the
 * manifest itself is data-only — no executable strings):
 *
 *   - every entry is well-formed (unique claim_id, valid status enum)
 *   - every `covered` entry's artifact exists, its sha256 matches the
 *     manifest byte-for-byte, and every `expected` JSON-pointer value
 *     equals the artifact's actual content exactly
 *   - every `disclosed-gap` entry says WHY (non-empty note) and does not
 *     smuggle in a phantom artifact path
 *
 * The 2am property: if someone edits a committed artifact, or the artifact
 * drifts from the number the README quotes, this fails loudly with the
 * pointer and both values.
 */

import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '../..');
const MANIFEST_PATH = join(REPO_ROOT, 'docs/receipts-manifest.json');

interface ManifestEntry {
  claim_id: string;
  readme_anchor: string;
  artifact_path: string | null;
  artifact_sha256: string | null;
  original_artifact?: { commit: string; path: string; sha256: string };
  expected?: Record<string, unknown>;
  golden_test?: string;
  status: 'covered' | 'disclosed-gap';
  note: string;
}

/** RFC 6901 JSON pointer resolution (with ~0/~1 unescaping). */
function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  let node: unknown = doc;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) {
        throw new Error(`pointer ${pointer}: index ${token} out of bounds`);
      }
      node = node[idx];
    } else if (node !== null && typeof node === 'object') {
      if (!(token in (node as Record<string, unknown>))) {
        throw new Error(`pointer ${pointer}: key ${token} not found`);
      }
      node = (node as Record<string, unknown>)[token];
    } else {
      throw new Error(`pointer ${pointer}: cannot descend into ${typeof node}`);
    }
  }
  return node;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  schema_version: number;
  entries: ManifestEntry[];
};

describe('disclosed historical identity redactions', () => {
  test('redacted artifact attestations retain distinct immutable-original provenance', () => {
    const redacted = manifest.entries.filter(e => e.original_artifact);
    expect(redacted.map(e => e.claim_id).sort()).toEqual([
      'cat34-rerun-v0.47.8.0', 'retrieval-refresh-harness-source',
    ]);
    for (const entry of redacted) {
      const original = entry.original_artifact!;
      expect(original.commit).toBe('9238ec8456bc94c3c082db105d7d8169a10a0b0f');
      expect(original.path).toBe(entry.artifact_path!);
      expect(original.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(original.sha256).not.toBe(entry.artifact_sha256);
      const artifact = JSON.parse(readFileSync(join(REPO_ROOT, entry.artifact_path!), 'utf8'));
      expect(artifact.redaction.original_commit).toBe(original.commit);
      expect(artifact.redaction.original_path).toBe(original.path);
      expect(artifact.redaction.original_artifact_sha256).toBe(original.sha256);
      expect(entry.note).toContain('redacted');
    }
  });

  test('archived source distinguishes original fingerprints from redacted bytes', () => {
    const entry = manifest.entries.find(e => e.claim_id === 'retrieval-refresh-harness-source')!;
    const archive = JSON.parse(readFileSync(join(REPO_ROOT, entry.artifact_path!), 'utf8')) as {
      harness_sha256: string;
      files: Record<string, { source_utf8: string; sha256?: string; original_sha256?: string; redacted_sha256?: string; redaction_note?: string }>;
    };
    const names = Object.keys(archive.files).sort();
    expect(names).toHaveLength(17);
    expect(names.filter(name => archive.files[name].original_sha256)).toEqual(['eval/runner/cat13-conceptual.ts']);
    const launchHashes: Record<string, string> = {};
    for (const name of names) {
      const file = archive.files[name];
      const actual = createHash('sha256').update(file.source_utf8).digest('hex');
      if (file.original_sha256) {
        expect(file.sha256).toBeUndefined();
        expect(actual).toBe(file.redacted_sha256!);
        expect(actual).not.toBe(file.original_sha256);
        expect(file.redaction_note).toContain('not the bytes executed');
        launchHashes[name] = file.original_sha256;
      } else {
        expect(actual).toBe(file.sha256!);
        expect(file.redacted_sha256).toBeUndefined();
        launchHashes[name] = file.sha256!;
      }
    }
    expect(createHash('sha256').update(JSON.stringify(launchHashes)).digest('hex')).toBe(archive.harness_sha256);
  });

  test('historical stripped-key receipt preserves cardinality and explicit redaction', () => {
    const entry = manifest.entries.find(e => e.claim_id === 'cat34-rerun-v0.47.8.0')!;
    const receipt = JSON.parse(readFileSync(join(REPO_ROOT, entry.artifact_path!), 'utf8'));
    expect(receipt.resolved_config.env_keys_stripped).toEqual([
      'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'RETIRED_PROVIDER_API_KEY',
      'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY',
    ]);
    expect(receipt.redaction.original_artifact_sha256).toBe('a69c14e843fca757c61a1b894b543cfb993d4fd82478910e1a5f2c8a5f085e8f');
    expect(receipt.verdict).toBe('fail');
  });
});

describe('docs/receipts-manifest.json — structure', () => {
  test('manifest parses with schema_version 1 and a non-empty entries array', () => {
    expect(manifest.schema_version).toBe(1);
    expect(Array.isArray(manifest.entries)).toBe(true);
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  test('claim_ids are unique', () => {
    const ids = manifest.entries.map(e => e.claim_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every entry has a valid status, an anchor, and a note', () => {
    for (const e of manifest.entries) {
      expect(['covered', 'disclosed-gap']).toContain(e.status);
      expect(typeof e.claim_id).toBe('string');
      expect(e.claim_id.length).toBeGreaterThan(0);
      expect(typeof e.readme_anchor).toBe('string');
      expect(e.readme_anchor.length).toBeGreaterThan(0);
      expect(typeof e.note).toBe('string');
      expect(e.note.length).toBeGreaterThan(0);
    }
  });

  test('manifest is data-only: no entry field smuggles a shell command', () => {
    for (const e of manifest.entries) {
      for (const v of [e.note, e.readme_anchor, e.golden_test ?? '']) {
        // Heuristic tripwires for executable strings — the manifest contract
        // is data-only; verification lives in these tests. (Markdown-style
        // `code` quoting is fine; command substitution and piped shells are not.)
        expect(v).not.toMatch(/(^|\s)(bash|sh|curl|wget)\s+-/);
        expect(v).not.toMatch(/\$\(|&&\s*rm\s|\|\s*(bash|sh)\b/);
      }
    }
  });
});

describe('docs/receipts-manifest.json — covered entries', () => {
  const covered = manifest.entries.filter(e => e.status === 'covered');

  test('at least the headline claims are covered', () => {
    const ids = covered.map(e => e.claim_id);
    expect(ids).toContain('longmemeval-recall-all');
    expect(ids).toContain('longmemeval-raw-rows');
    expect(ids).toContain('cat35-wave-receipt');
  });

  for (const e of covered) {
    describe(e.claim_id, () => {
      test('artifact path exists', () => {
        expect(typeof e.artifact_path).toBe('string');
        expect(existsSync(join(REPO_ROOT, e.artifact_path as string))).toBe(true);
      });

      test('artifact sha256 matches the manifest', () => {
        const buf = readFileSync(join(REPO_ROOT, e.artifact_path as string));
        const sha = createHash('sha256').update(buf).digest('hex');
        expect(sha).toBe(e.artifact_sha256 as string);
      });

      if (e.expected && Object.keys(e.expected).length > 0) {
        test('expected JSON-pointer values match the artifact content exactly', () => {
          const doc = JSON.parse(
            readFileSync(join(REPO_ROOT, e.artifact_path as string), 'utf8'),
          );
          for (const [pointer, want] of Object.entries(e.expected!)) {
            const got = resolvePointer(doc, pointer);
            // Exact equality — digit-for-digit for numbers, byte-for-byte
            // for strings. A drifted artifact must fail here with both values.
            expect({ pointer, value: got }).toEqual({ pointer, value: want });
          }
        });
      }
    });
  }
});

describe('docs/receipts-manifest.json — disclosed gaps', () => {
  const gaps = manifest.entries.filter(e => e.status === 'disclosed-gap');

  test('gap entries carry no phantom artifact', () => {
    for (const e of gaps) {
      expect(e.artifact_path).toBeNull();
      expect(e.artifact_sha256).toBeNull();
    }
  });

  test('gap entries explain the gap (note names where the artifact went)', () => {
    for (const e of gaps) {
      expect(e.note.length).toBeGreaterThan(40);
    }
  });

  test('the known gaps are declared, not silently dropped', () => {
    const ids = gaps.map(e => e.claim_id);
    // cat34-historical flipped to covered on 2026-09-01 when the June
    // originals + the labeled v0.47.8.0 rerun receipts were committed.
    expect(ids).toContain('skillopt');
    expect(ids).toContain('relational-recall');
    expect(ids).toContain('stability-snapshot');
  });

  test('cat34 receipts are covered now that they are committed', () => {
    const ids = manifest.entries
      .filter(e => e.status === 'covered')
      .map(e => e.claim_id);
    expect(ids).toContain('cat34-historical');
    expect(ids).toContain('cat34-rerun-v0.47.8.0');
  });
});

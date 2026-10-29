/**
 * Receipt secret scan (eval/runner/q1/secret-scan.ts). Key-shaped strings
 * are built at run time from seeded characters, so this file holds no
 * literal key.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { seededRandom } from '../../eval/runner/stats/paired.ts';
import { fingerprints, isPlaceholder, scanBytes, scanTree, secretMessage, SECRET_ENV } from '../../eval/runner/q1/secret-scan.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function token(seed: number, n: number): string {
  const rng = seededRandom(seed);
  return Array.from({ length: n }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join('');
}

describe('fingerprints', () => {
  test('cover the six provider variables and skip unset or short values', () => {
    expect(SECRET_ENV).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'UBICLOUD_API_TOKEN', 'JEV_TYPESAFE_API_KEY']);
    const env = { OPENAI_API_KEY: token(1, 40), ANTHROPIC_API_KEY: 'short', GEMINI_API_KEY: '' };
    const f = fingerprints(env);
    expect(f.map(x => x.name)).toEqual(['OPENAI_API_KEY']);
    expect(JSON.stringify(f)).not.toContain(env.OPENAI_API_KEY);
  });
});

describe('scanBytes', () => {
  test('finds an exact run-time value at its offset, including at the start and end of a buffer', () => {
    const v = token(2, 37);
    const prints = fingerprints({ VOYAGE_API_KEY: v });
    expect(scanBytes(Buffer.from(`xx ${v} yy`), prints)).toEqual([{ offset: 3, kind: 'env-value', name: 'VOYAGE_API_KEY' }]);
    expect(scanBytes(Buffer.from(v), prints).map(f => f.offset)).toEqual([0]);
    expect(scanBytes(Buffer.from(`ab${v}`), prints).map(f => f.offset)).toEqual([2]);
    expect(scanBytes(Buffer.from(`${v.slice(0, -1)}!`), prints)).toEqual([]);
  });

  test('finds key-shaped patterns and ignores placeholders', () => {
    const anthropic = `sk-ant-${token(3, 40)}`;
    const google = `AIza${token(4, 35)}`;
    const found = scanBytes(Buffer.from(`a ${anthropic} b ${google} c sk-dummy-${'0'.repeat(30)} d`), []);
    expect(found.map(f => f.name)).toEqual(['anthropic-key', 'google-api-key']);
    expect(isPlaceholder(`sk-${'x'.repeat(40)}`)).toBe(true);
    expect(isPlaceholder(`sk-${token(5, 40)}`)).toBe(false);
  });
});

describe('scanTree and the operator message', () => {
  test('scans raw and gzipped files and never reports the value, a prefix or its hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    mkdirSync(join(dir, 'cells/a'), { recursive: true });
    const v = token(6, 51);
    writeFileSync(join(dir, 'cells/a/clean.json'), '{"ok":true}\n');
    writeFileSync(join(dir, 'cells/a/doctor.ndjson.gz'), gzipSync(`{"env":"${v}"}\n`));
    const { files, findings } = scanTree([dir], { env: { UBICLOUD_API_TOKEN: v }, base: dir });
    expect(files).toBe(2);
    expect(findings).toEqual([{ file: 'cells/a/doctor.ndjson.gz', gzip: true, offset: 8, kind: 'env-value', name: 'UBICLOUD_API_TOKEN' }]);
    const op = secretMessage(findings, ['receipt'])!;
    expect(op.code).toBe('SECRET_IN_RECEIPT');
    expect(op.fix.next).toBe('ask_user');
    expect(op.fix.verify).toEqual(['bun', 'eval/runner/q1/secret-scan.ts', 'receipt']);
    const text = JSON.stringify(op);
    expect(text).not.toContain(v);
    expect(text).not.toContain(v.slice(0, 8));
    expect(text).not.toContain(fingerprints({ UBICLOUD_API_TOKEN: v })[0].sha256);
    rmSync(dir, { recursive: true });
  });

  test('a pattern-only finding asks the agent to inspect and report, a clean tree yields no message', () => {
    expect(secretMessage([{ file: 'x', gzip: false, offset: 0, kind: 'pattern', name: 'openai-key' }], ['r'])!.fix.next).toBe('report');
    expect(secretMessage([], ['r'])).toBeNull();
  });
});

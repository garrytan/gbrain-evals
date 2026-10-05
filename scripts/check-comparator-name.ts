#!/usr/bin/env bun
/**
 * Fail when the comparator's product name or its maker's name appears in a
 * tracked or untracked (non-ignored) file of this repository.
 *
 * Gzip files are scanned decompressed. The names are never written here. Each is stored as a 64-bit Bun.hash
 * (wyhash) plus a sha256 of the lowercase name and its length. The scan
 * lowercases each file, splits it into runs of letters, and hashes every
 * window of that length inside each run, so camelCase, snake_case,
 * kebab-case and glued forms are all caught. A rolling sum of character codes
 * selects candidate windows, Bun.hash narrows them and sha256 confirms a hit.
 *
 * Files that held a dated citation before this guard existed are allowed for
 * the names they already contain (docs/comparison-systems.md stays as is by
 * decision). The harness locks may name the harness repository, which carries
 * the maker's organisation name.
 *
 *   bun scripts/check-comparator-name.ts            exit 1 on any hit
 *   bun scripts/check-comparator-name.ts --list     also print every allowed hit
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Needle { id: 'product' | 'maker'; length: number; letterSum: number; wyhash: bigint; sha256: string }

export const NEEDLES: Needle[] = [
  { id: 'product', length: 9, letterSum: 962, wyhash: 8977914204047302642n, sha256: 'aa475625981493dc52fceb3cb9a39f54d22903284538f5562d2118678b6e6149' },
  { id: 'maker', length: 9, letterSum: 987, wyhash: 12754044376025014919n, sha256: '29307bacccf3dbefa62196cd8eaa3841671a0387b62b60feaeb56d3f637bc412' },
];

/** Paths (repo-relative) allowed to contain a needle, and which ones. */
export const ALLOWED: Record<string, Needle['id'][]> = {
  'docs/comparison-systems.md': ['product', 'maker'],
  // The README's per-document changelog keeps a dated 2026-05-24 entry that predates this guard.
  'README.md': ['product'],
  'docs/plans/2026-09-28-gbrain-10x/audit/coverage-and-categories.md': ['product', 'maker'],
  'docs/plans/2026-09-28-gbrain-10x/audit/evals-docs-infra.md': ['product'],
  'eval/harness-provider/harness.lock.json': ['maker'],
  'eval/data/memory-proof-wave/harness.lock.json': ['maker'],
  // Raw receipts of earlier runs: gbrain research file paths inside agent transcripts.
  'docs/benchmarks/2026-10-03-agent-operator/after-7d16702/runs.tar.gz': ['product'],
  'docs/benchmarks/2026-10-03-agent-operator/after-b3f4e8b/runs.tar.gz': ['product'],
};

/**
 * Both names are also ordinary English. The product name is skipped in the
 * idiom "in/with/of <name>"; the maker name counts only in its organisation
 * forms (followed by "io", "-io" or ".io") or as a capitalised standalone word,
 * so "vectorizer" and "vectorized" in ML text are not hits.
 */
function isProperNoun(bytes: Uint8Array, start: number, end: number, id: Needle['id']): boolean {
  const text = (from: number, to: number) => Buffer.from(bytes.subarray(Math.max(0, from), Math.min(bytes.length, to))).toString('latin1').toLowerCase();
  if (id === 'product') return !/(^|[^a-z])(in|with|of)\s+$/.test(text(start - 8, start));
  const after = text(end, end + 3);
  if (/^[-._]?io(?![a-z])/.test(after)) return true;
  const nextIsLetter = /^[a-z]/.test(after);
  return !nextIsLetter && bytes[start] === 86;
}

export interface Hit { path: string; needle: Needle['id']; line: number }

/** Every needle occurrence in `bytes` (1-based line numbers). ASCII letters only; case-insensitive. */
export function findNeedles(input: string | Uint8Array, needles: readonly Needle[] = NEEDLES): Array<{ needle: Needle['id']; line: number }> {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'latin1') : input;
  const hits: Array<{ needle: Needle['id']; line: number }> = [];
  const len = needles[0].length;
  if (needles.some(n => n.length !== len)) throw new Error('all needles must share one length');
  const sums = new Set(needles.map(n => n.letterSum));
  const lower = (b: number) => (b >= 65 && b <= 90 ? b + 32 : b);
  const isLetter = (b: number) => (b >= 97 && b <= 122) || (b >= 65 && b <= 90);
  let line = 1;
  let runStart = -1;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 10) line++;
    if (!isLetter(b)) { runStart = -1; sum = 0; continue; }
    if (runStart < 0) runStart = i;
    sum += lower(b);
    if (i - runStart + 1 > len) sum -= lower(bytes[i - len]);
    if (i - runStart + 1 < len || !sums.has(sum)) continue;
    const window = Buffer.from(bytes.subarray(i - len + 1, i + 1)).toString('latin1').toLowerCase();
    const h = BigInt(Bun.hash(window));
    const needle = needles.find(n => n.wyhash === h);
    if (!needle || createHash('sha256').update(window).digest('hex') !== needle.sha256) continue;
    if (!isProperNoun(bytes, i - len + 1, i + 1, needle.id)) continue;
    hits.push({ needle: needle.id, line });
  }
  return hits;
}

export function repoFiles(root: string): string[] {
  const out = Bun.spawnSync(['git', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { stdout: 'pipe' });
  if (out.exitCode !== 0) throw new Error('git ls-files failed');
  return out.stdout.toString().split('\0').filter(Boolean);
}

export function scan(root: string, files = repoFiles(root)): { violations: Hit[]; allowed: Hit[] } {
  const violations: Hit[] = [];
  const allowed: Hit[] = [];
  for (const rel of files) {
    const path = join(root, rel);
    let bytes: Uint8Array;
    try {
      if (!statSync(path).isFile()) continue;
      const raw = readFileSync(path);
      bytes = rel.endsWith('.gz') ? Bun.gunzipSync(new Uint8Array(raw)) : raw;
    } catch {
      continue;
    }
    for (const { needle, line } of [...findNeedles(bytes), ...findNeedles(rel).map(h => ({ ...h, line: 0 }))]) {
      const hit = { path: rel, needle, line };
      (ALLOWED[rel]?.includes(needle) ? allowed : violations).push(hit);
    }
  }
  return { violations, allowed };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const { violations, allowed } = scan(root);
  if (process.argv.includes('--list')) for (const h of allowed) console.log(`allowed  ${h.path}:${h.line} (${h.needle} name)`);
  if (violations.length) {
    for (const h of violations) console.error(`${h.path}:${h.line}: the comparator's ${h.needle} name appears here`);
    console.error(`\n${violations.length} occurrence(s). Refer to the comparator as "the comparator" (id \`comparator\`); code that needs its real identifiers resolves them at runtime through eval/harness-provider/mpw/names.py.`);
    process.exit(1);
  }
  console.log(`comparator name guard: clean (${allowed.length} allowed occurrence(s) in pre-existing citations)`);
}

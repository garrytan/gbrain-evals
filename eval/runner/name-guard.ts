/**
 * Name guard: external memory products are named only on the comparison page
 * (docs/comparison-systems.md) and in the install bundles beside it
 * (docs/comparison-systems/<kind>/). Everywhere else a system is described by
 * its kind id (eval/systems/kinds.json).
 *
 * Files that already named a product before the guard existed are frozen in a
 * ratchet baseline (eval/systems/name-guard-baseline.json): their count may
 * fall, never rise, and a new file may not add any.
 *
 *   bun eval/runner/name-guard.ts            check (exit 1 on a new occurrence)
 *   bun eval/runner/name-guard.ts --json     the same, as JSON
 *   bun eval/runner/name-guard.ts --lower    shrink baseline counts to the current counts (never raises one)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
export const BASELINE_PATH = join(ROOT, 'eval/systems/name-guard-baseline.json');
export const ALLOWED_PREFIXES = ['docs/comparison-systems.md', 'docs/comparison-systems/', 'eval/systems/name-guard-baseline.json'];

/** Whole-word product names. One product name is an ordinary English word, so it matches only capitalized or as a package form. */
export const PATTERNS: RegExp[] = [
  /\bmem0(?:ai)?\b/gi, /\bgraphiti(?:[-_]core)?\b/gi, /\bzep(?:[-_]?cloud)?\b/gi, /\bletta\b/gi, /\bmemgpt\b/gi,
  /\bcognee\b/gi, /\bbasic[ _-]memory\b/gi, /\bmempal(?:ace)?\b/gi, /\bvectorize-io\b/gi, /\bHindsight\b/g, /\bhindsight[-_](?:api|client|server|benchmarks|system)\b/g,
];

export function countNames(text: string): number {
  let n = 0;
  for (const p of PATTERNS) n += (text.match(p) ?? []).length;
  return n;
}

const KIND_HINT = 'describe the system by its kind id from eval/systems/kinds.json (for example ext-extract-first, ext-memory-bank); product names belong only in docs/comparison-systems.md';

export function scan(root = ROOT): Map<string, number> {
  const files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
  const out = new Map<string, number>();
  for (const f of files) {
    if (ALLOWED_PREFIXES.some(p => f === p || f.startsWith(p))) continue;
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    let text: string;
    try { const buf = readFileSync(abs); if (buf.includes(0)) continue; text = buf.toString('utf8'); } catch { continue; }
    const n = countNames(text);
    if (n) out.set(f, n);
  }
  return out;
}

export function loadBaseline(): Record<string, number> {
  return existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files as Record<string, number>) : {};
}

export function violations(current: Map<string, number>, baseline: Record<string, number>) {
  return [...current].filter(([f, n]) => n > (baseline[f] ?? 0)).map(([file, count]) => ({ file, count, allowed: baseline[file] ?? 0 }));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const current = scan();
  const baseline = loadBaseline();
  if (argv.includes('--lower')) {
    const next: Record<string, number> = {};
    for (const [f, n] of Object.entries(baseline)) { const c = current.get(f) ?? 0; if (c) next[f] = Math.min(n, c); }
    writeFileSync(BASELINE_PATH, JSON.stringify({ schema: 'gbrain-evals/name-guard-baseline/v1', note: 'Files that named an external product before the name guard; counts may only fall. Lower with: bun eval/runner/name-guard.ts --lower', files: next }, null, 2) + '\n');
    console.log(`baseline lowered: ${Object.keys(next).length} files`);
    process.exit(0);
  }
  const bad = violations(current, baseline);
  if (argv.includes('--json')) console.log(JSON.stringify({ ok: !bad.length, violations: bad, fix: bad.length ? { next: 'edit', why: KIND_HINT } : null }, null, 2));
  else if (bad.length) {
    console.error(`NAME_GUARD: ${bad.length} file(s) add an external product name outside docs/comparison-systems.md`);
    for (const v of bad) console.error(`  ${v.file}: ${v.count} occurrence(s), ${v.allowed} allowed`);
    console.error(`why: published artifacts describe other memory systems by kind. next: ${KIND_HINT}. verify: bun eval/runner/name-guard.ts`);
  } else console.log(`name guard: ok (${current.size} baseline files, none grew)`);
  process.exit(bad.length ? 1 : 0);
}

/**
 * Receipt secret scan (Q1 plan §4.8 contract 14). `eval:scoreboard check`
 * runs it over every receipt tree before anything is compared or published.
 *
 *   bun eval/runner/q1/secret-scan.ts <dir>... [--json]
 *
 * Two checks, over every file's raw bytes and, for `.gz` files, over the
 * decompressed bytes too:
 *
 *   1. Run-time values. The values that OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *      VOYAGE_API_KEY, GEMINI_API_KEY, UBICLOUD_API_TOKEN and
 *      JEV_TYPESAFE_API_KEY hold in this process are reduced to fingerprints
 *      (byte length, a 32-bit rolling hash and a sha256) and the plaintext is
 *      not kept. Every window of that length in a file is compared by rolling
 *      hash, and a candidate counts only when its sha256 matches. Values
 *      shorter than 8 bytes (unset or dummy) are skipped.
 *   2. Key-shaped patterns (provider key prefixes, cloud access keys, private
 *      key blocks), so a key from another machine or an earlier run is caught
 *      too. Obvious placeholders (dummy, fake, redacted, a run of one
 *      character) are ignored.
 *
 * Findings carry the file, the byte offset, the variable or pattern name and
 * whether the match was inside a gzip member. A finding never carries the
 * matched text, a prefix of it or its hash.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { renderOperatorMessage, type OperatorFix, type OperatorMessage } from '../decisions/errors.ts';

export const SECRET_ENV = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'UBICLOUD_API_TOKEN', 'JEV_TYPESAFE_API_KEY'] as const;
const MIN_VALUE_BYTES = 8;
const BASE = 257;

export interface Fingerprint { name: string; length: number; rolling: number; sha256: string }

function rollingHash(buf: Uint8Array, start: number, length: number): number {
  let h = 0;
  for (let i = start; i < start + length; i++) h = (Math.imul(h, BASE) + buf[i]) >>> 0;
  return h;
}

/** Fingerprints of the run-time values; the plaintext does not leave this function. */
export function fingerprints(env: Record<string, string | undefined> = process.env, names: readonly string[] = SECRET_ENV): Fingerprint[] {
  const out: Fingerprint[] = [];
  for (const name of names) {
    const value = env[name];
    if (!value || Buffer.byteLength(value) < MIN_VALUE_BYTES) continue;
    const bytes = Buffer.from(value, 'utf8');
    out.push({ name, length: bytes.length, rolling: rollingHash(bytes, 0, bytes.length), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return out;
}

export const KEY_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'voyage-key', re: /\bpa-[A-Za-z0-9_-]{30,}/g },
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const PLACEHOLDER = /dummy|fake|placeholder|example|redacted|your[-_]?key|not[-_]?a[-_]?key|xxxx/i;

/** A low-entropy or self-described placeholder is not a key. */
export function isPlaceholder(match: string): boolean {
  if (PLACEHOLDER.test(match)) return true;
  return new Set(match.replace(/^[a-z]+[-_]/i, '')).size < 8;
}

export interface Finding { file: string; gzip: boolean; offset: number; kind: 'env-value' | 'pattern'; name: string }

export function scanBytes(buf: Uint8Array, prints: readonly Fingerprint[]): Array<Omit<Finding, 'file' | 'gzip'>> {
  const found: Array<Omit<Finding, 'file' | 'gzip'>> = [];
  const byLength = new Map<number, Fingerprint[]>();
  for (const f of prints) byLength.set(f.length, [...(byLength.get(f.length) ?? []), f]);
  for (const [L, fs] of byLength) {
    if (buf.length < L) continue;
    let pow = 1;
    for (let i = 1; i < L; i++) pow = Math.imul(pow, BASE) >>> 0;
    let h = rollingHash(buf, 0, L);
    for (let i = 0; ; i++) {
      for (const f of fs) {
        if (f.rolling === h && createHash('sha256').update(buf.subarray(i, i + L)).digest('hex') === f.sha256) found.push({ offset: i, kind: 'env-value', name: f.name });
      }
      if (i + L >= buf.length) break;
      h = (Math.imul((h - Math.imul(buf[i], pow)) >>> 0, BASE) + buf[i + L]) >>> 0;
    }
  }
  const text = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1');
  for (const { id, re } of KEY_PATTERNS) {
    for (const m of text.matchAll(re)) if (!isPlaceholder(m[0])) found.push({ offset: m.index, kind: 'pattern', name: id });
  }
  return found.sort((a, b) => a.offset - b.offset || (a.name < b.name ? -1 : 1));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Scan every file under each root; paths in findings are relative to `base`. */
export function scanTree(roots: readonly string[], options: { env?: Record<string, string | undefined>; base?: string } = {}): { files: number; findings: Finding[] } {
  const prints = fingerprints(options.env ?? process.env);
  const base = options.base ?? process.cwd();
  const findings: Finding[] = [];
  let files = 0;
  for (const root of roots) {
    const paths = statSync(root).isDirectory() ? walk(root) : [root];
    for (const path of paths) {
      files++;
      const file = relative(base, path) || path;
      const raw = readFileSync(path);
      for (const f of scanBytes(raw, prints)) findings.push({ file, gzip: false, ...f });
      if (path.endsWith('.gz')) {
        let inner: Buffer;
        try { inner = gunzipSync(raw); } catch { continue; }
        for (const f of scanBytes(inner, prints)) findings.push({ file, gzip: true, ...f });
      }
    }
  }
  return { files, findings };
}

export type SecretMessage = Omit<OperatorMessage, 'code'> & { code: 'SECRET_IN_RECEIPT' };

export function secretMessage(findings: readonly Finding[], roots: readonly string[]): SecretMessage | null {
  if (!findings.length) return null;
  const live = findings.filter(f => f.kind === 'env-value');
  const where = [...new Set(findings.map(f => `${f.file}${f.gzip ? ' (inside gzip)' : ''}: ${f.name} at byte ${f.offset}`))].slice(0, 10);
  const verify = ['bun', 'eval/runner/q1/secret-scan.ts', ...roots];
  const fix: OperatorFix = live.length
    ? { next: 'ask_user', user_message: `A run-time value of ${[...new Set(live.map(f => f.name))].join(', ')} appears in ${new Set(live.map(f => f.file)).size} receipt file(s). Do not commit or push them. Recapture those files through the allow-listed fields, then ask the user whether the key must be rotated (it must if the file was ever pushed).`, verify }
    : { next: 'report', user_message: 'Key-shaped text appears in a receipt. Open each listed offset, remove the key or recapture the file through the allow-listed fields, and tell the user which file held it.', verify };
  return {
    code: 'SECRET_IN_RECEIPT',
    message: `${findings.length} secret finding(s) in the receipt tree: ${where.join('; ')}`,
    why: 'receipts are committed and published; a provider key in one would be public, and the scan never prints the matched text',
    fix,
    state: { env_value_findings: live.length, pattern_findings: findings.length - live.length },
  };
}

export const renderSecretMessage = (op: SecretMessage) => renderOperatorMessage(op as unknown as OperatorMessage);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const roots = argv.filter(a => !a.startsWith('--')).map(a => resolve(a));
  if (!roots.length) {
    console.error('usage: bun eval/runner/q1/secret-scan.ts <dir>... [--json]');
    process.exit(2);
  }
  const { files, findings } = scanTree(roots);
  const op = secretMessage(findings, argv.filter(a => !a.startsWith('--')));
  if (argv.includes('--json')) console.log(JSON.stringify({ ok: !op, files, findings, ...(op ? { error: op } : {}) }, null, 2));
  else if (op) console.error(renderSecretMessage(op));
  else console.log(`secret scan: ok (${files} files, ${fingerprints().length} run-time values checked)`);
  process.exit(!op ? 0 : op.fix.next === 'ask_user' ? 3 : 2);
}

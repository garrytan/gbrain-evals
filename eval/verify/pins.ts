/**
 * pins — the things the README says are pinned are pinned, and agree.
 *
 * The outside pass on 2026-09-01 checked these by hand and found them
 * clean; this keeps them that way:
 *
 *   - package.json `gbrain` is `github:garrytan/gbrain#<40-hex>` → FAIL otherwise
 *   - bun.lock's workspace entry names the same full SHA, and its resolved
 *     package entry's short SHA is a prefix of it → FAIL otherwise
 *   - every `uses:` in .github/workflows/*.yml is pinned to a 40-hex commit
 *     (tags are movable) → FAIL otherwise
 *   - the workflow's `bun-version` matches `engines.bun` in package.json
 *     when present, else `@types/bun` → WARN on mismatch; WARN when a
 *     workflow comment claims an `engines` pin that package.json lacks
 *   - committed receipts (docs/** /*.json) whose gbrain_pin / gbrain_sha /
 *     harness_sha is shorter than 40 hex → WARN (historical receipts
 *     recorded short SHAs; a short SHA can become ambiguous)
 *
 * Keyless, $0, no network.
 *
 * Usage: bun eval/verify/pins.ts [--root <dir>] [--quiet] [--strict] [--json]
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, parseArgs, rel, runCli, walk, type CheckReport, type Finding } from './lib.ts';

export const CHECK = 'pins';

const FULL_SHA = /^[0-9a-f]{40}$/;
const GBRAIN_DEP = /^github:garrytan\/gbrain#([0-9a-f]+)$/;

export function checkPackagePin(root: string): { findings: Finding[]; sha: string | null } {
  const findings: Finding[] = [];
  const p = join(root, 'package.json');
  if (!existsSync(p)) return { findings: [{ severity: 'fail', where: 'package.json', message: 'missing' }], sha: null };
  const pkg = JSON.parse(readFileSync(p, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };
  const dep = pkg.dependencies?.gbrain;
  if (typeof dep !== 'string') {
    findings.push({ severity: 'fail', where: 'package.json', message: 'no dependencies.gbrain entry' });
    return { findings, sha: null };
  }
  const m = dep.match(GBRAIN_DEP);
  if (!m || !FULL_SHA.test(m[1])) {
    findings.push({ severity: 'fail', where: 'package.json', message: `gbrain is "${dep}" — expected github:garrytan/gbrain#<40-hex commit>` });
    return { findings, sha: null };
  }
  findings.push({ severity: 'info', where: 'package.json', message: `gbrain pinned to ${m[1]}` });
  return { findings, sha: m[1] };
}

export function checkLockfile(root: string, sha: string | null): Finding[] {
  const findings: Finding[] = [];
  const p = join(root, 'bun.lock');
  if (!existsSync(p)) return [{ severity: 'fail', where: 'bun.lock', message: 'missing (CI installs with --frozen-lockfile)' }];
  if (!sha) return findings;
  const text = readFileSync(p, 'utf8');
  const ws = text.match(/"gbrain":\s*"github:garrytan\/gbrain#([0-9a-f]+)"/);
  if (!ws) {
    findings.push({ severity: 'fail', where: 'bun.lock', message: 'no workspace gbrain entry (github:garrytan/gbrain#…) found' });
  } else if (ws[1] !== sha) {
    findings.push({ severity: 'fail', where: 'bun.lock', message: `workspace gbrain pin ${ws[1]} != package.json ${sha}` });
  }
  const resolved = text.match(/"gbrain@github:garrytan\/gbrain#([0-9a-f]+)"/);
  if (!resolved) {
    findings.push({ severity: 'fail', where: 'bun.lock', message: 'no resolved gbrain package entry found' });
  } else if (!sha.startsWith(resolved[1])) {
    findings.push({ severity: 'fail', where: 'bun.lock', message: `resolved entry ${resolved[1]} is not a prefix of package.json pin ${sha}` });
  }
  if (findings.length === 0) findings.push({ severity: 'info', where: 'bun.lock', message: 'lockfile agrees with package.json pin' });
  return findings;
}

export function checkWorkflows(root: string): Finding[] {
  const findings: Finding[] = [];
  const dir = join(root, '.github/workflows');
  if (!existsSync(dir)) return [{ severity: 'warn', where: '.github/workflows', message: 'no workflows directory' }];
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const surface = `.github/workflows/${name}`;
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    let uses = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const u = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (u) {
        uses++;
        const at = u[1].split('@');
        if (at.length !== 2 || !FULL_SHA.test(at[1])) {
          findings.push({ severity: 'fail', where: `${surface}:${i + 1}`, message: `action not pinned to a 40-hex commit: ${u[1]}` });
        }
      }
      const bv = line.match(/^\s*bun-version:\s*([^\s#]+)/);
      if (bv) {
        const want = pkg.engines?.bun ?? pkg.devDependencies?.['@types/bun'];
        const source = pkg.engines?.bun ? 'engines.bun' : '@types/bun';
        if (want === undefined) {
          findings.push({ severity: 'warn', where: `${surface}:${i + 1}`, message: `bun-version ${bv[1]} has nothing in package.json to agree with` });
        } else if (want !== bv[1]) {
          findings.push({ severity: 'warn', where: `${surface}:${i + 1}`, message: `bun-version ${bv[1]} != package.json ${source} ${want}` });
        } else {
          findings.push({ severity: 'info', where: `${surface}:${i + 1}`, message: `bun-version ${bv[1]} agrees with package.json ${source}` });
        }
      }
      if (/#.*\bengines\b/.test(line) && !pkg.engines) {
        findings.push({ severity: 'warn', where: `${surface}:${i + 1}`, message: 'comment cites a package.json engines pin, but package.json has no engines field' });
      }
    }
    findings.push({ severity: 'info', where: surface, message: `${uses} action reference(s) checked` });
  }
  return findings;
}

export function checkReceiptPins(root: string): Finding[] {
  const findings: Finding[] = [];
  let seen = 0;
  for (const f of walk(join(root, 'docs'))) {
    if (!f.endsWith('.json')) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== 'object') continue;
    const d = doc as Record<string, unknown>;
    const cfg = (d.resolved_config ?? d.resolved ?? {}) as Record<string, unknown>;
    const candidates: Array<[string, unknown]> = [
      ['gbrain_pin', d.gbrain_pin ?? cfg.gbrain_pin],
      ['gbrain_sha', d.gbrain_sha],
      ['harness_sha', cfg.harness_sha],
    ];
    for (const [key, v] of candidates) {
      if (typeof v !== 'string') continue;
      seen++;
      const hex = (v.match(/#([0-9a-f]+)$/) ?? v.match(/^([0-9a-f]{7,40})$/))?.[1];
      if (!hex) {
        findings.push({ severity: 'warn', where: `${rel(root, f)}:${key}`, message: `not a commit reference: ${v}` });
      } else if (hex.length < 40) {
        findings.push({ severity: 'warn', where: `${rel(root, f)}:${key}`, message: `short SHA ${hex} (${hex.length} hex); a full 40-hex pin cannot become ambiguous` });
      }
    }
  }
  findings.push({ severity: 'info', where: 'docs/**/*.json', message: `${seen} receipt pin field(s) checked` });
  return findings;
}

export function checkPins(opts: { root?: string } = {}): CheckReport {
  const root = opts.root ?? REPO_ROOT;
  const pkg = checkPackagePin(root);
  const findings: Finding[] = [...pkg.findings, ...checkLockfile(root, pkg.sha)];
  if (existsSync(join(root, 'package.json'))) findings.push(...checkWorkflows(root));
  findings.push(...checkReceiptPins(root));
  return { check: CHECK, findings };
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.get('root') === 'string' ? String(flags.get('root')) : REPO_ROOT;
  runCli([checkPins({ root })], flags);
}

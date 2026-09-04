/**
 * cited-artifacts — every artifact a published surface cites is a committed
 * file, or the citation says it isn't.
 *
 * The class this guards (audit docs-vs-code-15; issue #26 gap 1): a report
 * or summary JSON names the file that backs its numbers, and that file lives
 * in the gitignored eval/reports/ — so the claim is asserted, not shipped.
 * The receipts manifest covers the README's headline claims; this check
 * covers everything else a reader can click or open.
 *
 * Surfaces: README.md, docs/** /*.md, docs/** /*.json (committed receipts).
 * Benchmark OUTPUT pages under any `artifacts/` directory are skipped —
 * they are distilled transcripts, not claims.
 *
 * Markdown rules — for every repo-relative path token on a line
 * (`docs/…`, `eval/…`, `baselines/…`, `qrels/…`, `results/…`, `scripts/…`,
 * `test/…` with a data/doc/code extension):
 *   - exists here AND git-tracked → fine (counted)
 *   - under eval/reports/ (transient by design) → WARN unless the line
 *     discloses that (gitignored / regenerate / lands under …)
 *   - not here but present in gbrain at the pin (node_modules/gbrain/…):
 *     a cross-repo citation, verifiable from this repo → info
 *   - not here, gbrain not installed → WARN (cannot resolve cross-repo)
 *   - nowhere: FAIL on a live surface (README.md, docs/*.md), WARN in a
 *     historical report (docs/benchmarks/**, docs/audit/**) or when the
 *     line discloses it
 *
 * JSON rules — for every string value under a pointer-like key
 * (path, source, source_ndjson, artifact_path, ndjson, input, receipt, report):
 *   - machine-local absolute path (/private/tmp, /tmp, /home, /Users) → WARN
 *   - eval/reports/… pointer: WARN when a committed copy with the same
 *     basename sits next to the citing JSON (stale pointer, artifact
 *     shipped); FAIL when no committed copy resolves
 *   - any other repo-relative pointer must exist and be tracked → FAIL
 *
 * Keyless, $0, no network. Needs git for the tracked-set; degrades to an
 * existence-only check (and says so) when git is unavailable.
 *
 * Usage: bun eval/verify/cited-artifacts.ts [--root <dir>] [--quiet] [--strict] [--json]
 */

import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import {
  REPO_ROOT,
  gitTrackedFiles,
  parseArgs,
  rel,
  runCli,
  walk,
  type CheckReport,
  type Finding,
} from './lib.ts';

export const CHECK = 'cited-artifacts';

const REPO_DIRS = ['docs', 'eval', 'baselines', 'qrels', 'results', 'scripts', 'test'];
const EXT = 'json|ndjson|jsonl|md|svg|csv|txt|ts|sh|py';
/** A repo-relative path token: not preceded by a word char or slash, dir prefix, extension. */
export const PATH_TOKEN = new RegExp(
  `(?<![\\w/.-])(?:${REPO_DIRS.join('|')})/[\\w.+/-]+\\.(?:${EXT})\\b`,
  'g',
);
export const POINTER_KEY = /(^|_)(path|source|source_ndjson|artifact_path|ndjson|input|receipt|report)$/;
export const ABSOLUTE_LOCAL = /^\/(?:private\/tmp|tmp|home|Users|var\/folders)\//;
export const TRANSIENT_DIR = 'eval/reports/';
/** Where the pinned product repo lands after `bun install`. */
export const CROSS_REPO_DIR = 'node_modules/gbrain';
/** Words that mark a citation as knowingly pointing at something not committed. */
export const DISCLOSURE =
  /gitignored|transient|regenerat|not committed|never (?:hand-)?copied|cleaned up|hand-cop|land(?:s|ed)? (?:receipts )?(?:under|in)|--out\b|\bwrites?\b|\bwritten\b|mutates|read-only|will be written|output (?:goes|lands)/i;

export interface CitedArtifactsOpts {
  root?: string;
  /** Override the surface list (repo-relative). Default: README.md + docs/** minus artifacts/. */
  surfaces?: string[];
}

/** Historical reports get warnings where live surfaces get failures. */
export function isHistorical(surface: string): boolean {
  return surface.startsWith('docs/benchmarks/') || surface.startsWith('docs/audit/');
}

export function publishedSurfaces(root: string): string[] {
  const out: string[] = [];
  if (existsSync(join(root, 'README.md'))) out.push('README.md');
  for (const f of walk(join(root, 'docs'))) {
    const r = rel(root, f);
    if (r.split('/').includes('artifacts')) continue;
    if (r.endsWith('.md') || r.endsWith('.json')) out.push(r);
  }
  return out;
}

function isTracked(tracked: Set<string> | null, root: string, path: string): boolean {
  if (tracked) return tracked.has(path);
  return existsSync(join(root, path));
}

type CrossRepo = 'present' | 'absent' | 'uninstalled';
function crossRepo(root: string, token: string): CrossRepo {
  if (!existsSync(join(root, CROSS_REPO_DIR, 'package.json'))) return 'uninstalled';
  return existsSync(join(root, CROSS_REPO_DIR, token)) ? 'present' : 'absent';
}

export interface SurfaceResult {
  findings: Finding[];
  /** Citations/pointers examined on this surface. */
  scanned: number;
}

/** Markdown surface: path tokens per line. */
export function checkMarkdown(
  surface: string,
  text: string,
  root: string,
  tracked: Set<string> | null,
): SurfaceResult {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  const historical = isHistorical(surface);
  let cited = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `${surface}:${i + 1}`;
    for (const m of line.matchAll(PATH_TOKEN)) {
      const token = m[0];
      // Globs and placeholders are descriptions, not citations.
      if (/[*{}<>]/.test(token)) continue;
      cited++;
      const disclosed = DISCLOSURE.test(line);
      if (token.startsWith(TRANSIENT_DIR)) {
        if (!disclosed) {
          findings.push({
            severity: 'warn',
            where,
            message: `cites transient \`${token}\` (eval/reports/ is gitignored) with no disclosure on the line`,
          });
        }
        continue;
      }
      const exists = existsSync(join(root, token));
      if (exists && isTracked(tracked, root, token)) continue;
      if (!exists) {
        const x = crossRepo(root, token);
        if (x === 'present') {
          findings.push({ severity: 'info', where, message: `cites \`${token}\` — not in this repo, resolves in gbrain at the pin (cross-repo citation)` });
          continue;
        }
        if (x === 'uninstalled') {
          findings.push({ severity: 'warn', where, message: `cites \`${token}\` — not in this repo; gbrain not installed, so cross-repo resolution is unavailable` });
          continue;
        }
      }
      const why = !exists ? 'exists in neither this repo nor gbrain at the pin' : 'exists locally but is not git-tracked';
      const soft = disclosed || historical;
      findings.push({
        severity: soft ? 'warn' : 'fail',
        where,
        message: `cites \`${token}\` which ${why}${disclosed ? ' (line discloses it)' : historical ? ' (historical report)' : ''}`,
      });
    }
  }
  return { findings, scanned: cited };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function* pointerStrings(node: Json, keyPath: string[] = []): Generator<{ key: string; value: string; at: string }> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* pointerStrings(node[i], [...keyPath, String(i)]);
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && POINTER_KEY.test(k)) {
        yield { key: k, value: v, at: '/' + [...keyPath, k].join('/') };
      } else {
        yield* pointerStrings(v, [...keyPath, k]);
      }
    }
  }
}

/** JSON surface (a committed receipt): pointer-like keys. */
export function checkJson(
  surface: string,
  text: string,
  root: string,
  tracked: Set<string> | null,
): SurfaceResult {
  const findings: Finding[] = [];
  let doc: Json;
  try {
    doc = JSON.parse(text) as Json;
  } catch (e) {
    return {
      findings: [{ severity: 'fail', where: surface, message: `unparseable JSON on a published surface: ${e instanceof Error ? e.message : e}` }],
      scanned: 0,
    };
  }
  let pointers = 0;
  for (const p of pointerStrings(doc)) {
    const where = `${surface}${p.at}`;
    if (ABSOLUTE_LOCAL.test(p.value)) {
      pointers++;
      findings.push({
        severity: 'warn',
        where,
        message: `machine-local absolute path in a committed receipt: ${p.value}`,
      });
      continue;
    }
    const isRepoRel = REPO_DIRS.some(d => p.value.startsWith(d + '/'));
    if (!isRepoRel) continue;
    pointers++;
    if (p.value.startsWith(TRANSIENT_DIR)) {
      const sibling = join(dirname(surface), basename(p.value)).split('\\').join('/');
      const siblingOk = existsSync(join(root, sibling)) && isTracked(tracked, root, sibling);
      findings.push({
        severity: siblingOk ? 'warn' : 'fail',
        where,
        message: siblingOk
          ? `pointer names the transient path ${p.value}; a committed copy sits next to this file at ${sibling} (repoint the pointer, or leave and accept the stale path)`
          : `pointer names the gitignored path ${p.value} and no committed copy resolves — the number this receipt backs cannot be re-derived from the repo`,
      });
      continue;
    }
    const exists = existsSync(join(root, p.value));
    if (exists && isTracked(tracked, root, p.value)) continue;
    findings.push({
      severity: 'fail',
      where,
      message: `pointer ${p.value} ${exists ? 'exists locally but is not git-tracked' : 'does not exist'}`,
    });
  }
  return { findings, scanned: pointers };
}

export function checkCitedArtifacts(opts: CitedArtifactsOpts = {}): CheckReport {
  const root = opts.root ?? REPO_ROOT;
  const surfaces = opts.surfaces ?? publishedSurfaces(root);
  const tracked = gitTrackedFiles(root);
  const findings: Finding[] = [];
  if (!tracked) {
    findings.push({
      severity: 'warn',
      where: root,
      message: 'git ls-files unavailable — tracked-ness degraded to an existence check',
    });
  }
  let scanned = 0;
  for (const s of surfaces) {
    const abs = join(root, s);
    if (!existsSync(abs)) {
      findings.push({ severity: 'fail', where: s, message: 'surface listed but missing' });
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    const r = s.endsWith('.json') ? checkJson(s, text, root, tracked) : checkMarkdown(s, text, root, tracked);
    findings.push(...r.findings);
    scanned += r.scanned;
  }
  const crossRepoN = findings.filter(f => f.severity === 'info' && f.message.includes('cross-repo')).length;
  findings.push({
    severity: 'info',
    where: `${surfaces.length} surface(s)`,
    message: `${scanned} citation(s)/pointer(s) scanned, ${crossRepoN} resolve cross-repo in gbrain at the pin`,
  });
  return { check: CHECK, findings };
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.get('root') === 'string' ? String(flags.get('root')) : REPO_ROOT;
  runCli([checkCitedArtifacts({ root })], flags);
}

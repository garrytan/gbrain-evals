#!/usr/bin/env bun
/**
 * Can F6's Q1 scoreboard reuse a competitor or baseline row that the A24 campaign already measured, instead of
 * running it again? The Q1 counterpart of eval/runner/cat40/reuse-check.ts. It compares two commits of this
 * repository: the one the prior rows ran at (A24's freeze commit, 008b83fe) and the one F6 plans to run.
 *
 *   bun eval/runner/q1/reuse-check.ts --prior <commit> --planned <commit> --systems a,b,... \
 *     --preregistration <file> --a24-source <id> [--json]
 *
 * A system's rows are reusable only when all of these hold at both commits:
 *   1. Its competitor-path hash is equal: sha256 over the sorted lines `<path>\0<blob sha>\n` of `git ls-tree -r`,
 *      filtered to the system's files. An external kind ext-<id> owns the files directly in docs/comparison-systems/<id>/
 *      named Dockerfile, docker-compose.yml, pyproject.toml, uv.lock, shim.py, capability.json or *.env. Only the top
 *      level of the bundle counts, so a new configuration kept in a subdirectory leaves the pinned bundle's hash alone.
 *      The legacy eval/systems/<name>/ copies are not run by Q1 and are not hashed. Baselines own runner code:
 *      baseline-none and baseline-recency eval/runner/systems/baselines.ts, baseline-hybrid that plus
 *      eval/runner/cat40/pg-arm.ts, baseline-file-agent eval/runner/systems/file-agent.ts, cat40/arms.ts and cat40/loop.ts.
 *   2. The shared harness is behaviourally equal: the golden fixture digest (eval/runner/q1/golden-fixture.ts) of each
 *      commit, run on a `git archive` of its eval/ tree, is the same.
 *   3. The measurement identity is the same: the system's counted cells in q1-cells.json (readers, replicates, arms,
 *      budgets, launch config, selection recipe and exclusions), the sets they report into, the canonical judge
 *      instruments (id, version, judge, sha256) and frontier instrument ids, RENDERER_VERSION, the tokenizer id, the
 *      readerCounter identity of every answering arm's readers, the pinned tokenizer package in bun.lock, the split
 *      file of each benchmark the system runs (eval/decisions/splits/<benchmark>.json) and every dataset pin
 *      (eval/decisions/datasets/*) except a pin DATASET_PINS assigns only to benchmarks the system does not run. The scheduled-question sha256 a cell records needs the sealed corpus, so it is not
 *      recomputed here: the selection recipe, the exclusions and the split and dataset file hashes that produce it are
 *      compared instead.
 *   4. The file given with --preregistration names the A24 source id and the system on one line (the rule of
 *      cat40/reuse-check.ts declared()), so the reuse is declared before any cell runs.
 *
 * Exit 0 when every named system is reusable, 1 when any is refused, 2 on usage errors or an unknown commit.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SystemIdentity, TreeIdentity } from './golden-fixture.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const BUNDLE_FILES: readonly string[] = ['Dockerfile', 'docker-compose.yml', 'pyproject.toml', 'uv.lock', 'shim.py', 'capability.json'];
export const BASELINE_FILES: Readonly<Record<string, readonly string[]>> = {
  'baseline-none': ['eval/runner/systems/baselines.ts'],
  'baseline-recency': ['eval/runner/systems/baselines.ts'],
  'baseline-full-context': ['eval/runner/systems/baselines.ts'],
  'baseline-hybrid': ['eval/runner/systems/baselines.ts', 'eval/runner/cat40/pg-arm.ts'],
  'baseline-file-agent': ['eval/runner/systems/file-agent.ts', 'eval/runner/cat40/arms.ts', 'eval/runner/cat40/loop.ts'],
};
const SPLITS = 'eval/decisions/splits/';
const DATASETS = 'eval/decisions/datasets/';
/** Dataset pins read by named benchmarks' loaders only (D8: eval/runner/memory-qa/corpus.ts D8_MANIFEST). Such a pin is compared only for a system whose cells run one of them; every other pin is compared for every system. */
export const DATASET_PINS: Readonly<Record<string, readonly string[]>> = {
  'eval/decisions/datasets/d8-manifest.json': ['beam-d8'],
};

/** Whether a repository path is one of the system's own files; null when the system has no competitor-path rule. */
export function ownsPath(system: string, path: string): boolean | null {
  if (BASELINE_FILES[system]) return BASELINE_FILES[system].includes(path);
  if (!/^ext-[a-z0-9-]+$/.test(system)) return null;
  const dir = `docs/comparison-systems/${system}/`;
  if (!path.startsWith(dir)) return false;
  const name = path.slice(dir.length);
  return !name.includes('/') && (BUNDLE_FILES.includes(name) || name.endsWith('.env'));
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });

/** The full commit id, or null when the commit is not in this checkout. */
export function resolveCommit(ref: string, cwd = REPO_ROOT): string | null {
  try { return git(cwd, 'rev-parse', '--verify', `${ref}^{commit}`).trim(); } catch { return null; }
}

/** Every blob path at a commit and its blob sha (`git ls-tree -r`). */
export function lsTree(commit: string, cwd = REPO_ROOT): Map<string, string> {
  const tree = new Map<string, string>();
  for (const line of git(cwd, 'ls-tree', '-r', '-z', commit).split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [, type, blob] = line.slice(0, tab).split(' ');
    if (type === 'blob') tree.set(line.slice(tab + 1), blob!);
  }
  return tree;
}

/** The competitor-path hash of a system in a tree and the files it covers; null when the system has no rule. */
export function pathHash(tree: Map<string, string>, system: string): { sha256: string; files: string[] } | null {
  if (ownsPath(system, '') === null) return null;
  const files = [...tree.keys()].filter(p => ownsPath(system, p)).sort();
  return { sha256: createHash('sha256').update(files.map(p => `${p}\0${tree.get(p)}\n`).join('')).digest('hex'), files };
}

/** The preregistration names the A24 source id and the system on one line (cat40/reuse-check.ts declared()). */
export function declared(prereg: string, source: string, system: string): boolean {
  const word = (s: string) => new RegExp(`(?<![\\w.:/-])${s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w:/-]|\\.[\\w:/-])`);
  const id = word(source), sys = word(system);
  return !!source && prereg.split('\n').some(line => id.test(line) && sys.test(line));
}

export interface TreeProbe { digest: string; identity: TreeIdentity }

/** The golden digest and measurement identity of a commit: its eval/ tree from `git archive`, measured by this checkout's golden-fixture.ts. */
export function probeCommit(commit: string, cwd = REPO_ROOT): TreeProbe {
  const dir = mkdtempSync(join(tmpdir(), 'q1-reuse-'));
  try {
    git(cwd, 'archive', '-o', join(dir, 'tree.tar'), commit, 'eval');
    execFileSync('tar', ['-xf', join(dir, 'tree.tar'), '-C', dir]);
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
    const r = spawnSync(process.execPath, [join(import.meta.dir, 'golden-fixture.ts'), dir], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`golden fixture at ${commit.slice(0, 12)} exited ${r.status}: ${(r.stderr || r.stdout).slice(-600)}`);
    return JSON.parse(r.stdout) as TreeProbe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The pinned tokenizer package line of a commit's bun.lock (name, version and integrity), or null. */
export function tokenizerPin(lock: string | null): string | null {
  return lock?.match(/^\s*"@dqbd\/tiktoken": \[("@dqbd\/tiktoken@[^"]+", "[^"]*", \{[^}]*\}, "[^"]+")\]/m)?.[1] ?? null;
}

export interface Side { tree: Map<string, string>; probe: TreeProbe | Error; lock: string | null }
export interface SystemVerdict { system: string; reusable: boolean; reasons: string[]; path_hash: { prior: string | null; planned: string | null; files: string[] }; declared: boolean }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ids of the entries of two lists (by `id`) that were added, removed or changed. */
function listDiff(what: string, a: Array<{ id: string }>, b: Array<{ id: string }>): string[] {
  const ia = new Map(a.map(x => [x.id, x])), ib = new Map(b.map(x => [x.id, x]));
  const out: string[] = [];
  for (const [id, x] of ia) {
    const y = ib.get(id);
    if (!y) { out.push(`${what} ${id} is gone at the planned commit`); continue; }
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => !same((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
    if (keys.length) out.push(`${what} ${id}: ${keys.join(', ')} differ`);
  }
  for (const id of ib.keys()) if (!ia.has(id)) out.push(`${what} ${id} is new at the planned commit`);
  return out;
}

export function systemVerdict(system: string, prior: Side, planned: Side, isDeclared: boolean, source: string): SystemVerdict {
  const reasons: string[] = [];
  const hp = pathHash(prior.tree, system), hn = pathHash(planned.tree, system);
  if (!hp || !hn) reasons.push(`${system} has no competitor-path rule (an ext-<id> bundle or one of ${Object.keys(BASELINE_FILES).join(', ')})`);
  else {
    if (!hp.files.length) reasons.push(`no ${system} files at the prior commit`);
    if (!hn.files.length) reasons.push(`no ${system} files at the planned commit`);
    if (hp.sha256 !== hn.sha256) {
      const changed = [...new Set([...hp.files, ...hn.files])].filter(p => prior.tree.get(p) !== planned.tree.get(p)).sort();
      reasons.push(`competitor-path hash differs (${hp.sha256.slice(0, 16)} to ${hn.sha256.slice(0, 16)}): ${changed.join(', ')}`);
    }
  }
  if (prior.probe instanceof Error || planned.probe instanceof Error) {
    for (const p of [prior.probe, planned.probe]) if (p instanceof Error) reasons.push(`shared harness not measured: ${p.message}`);
  } else {
    const a = prior.probe, b = planned.probe;
    if (a.digest !== b.digest) reasons.push(`golden fixture digest differs (${a.digest.slice(0, 16)} to ${b.digest.slice(0, 16)}): the shared harness packs, prompts or judges differently`);
    for (const k of ['renderer', 'tokenizer'] as const) if (a.identity[k] !== b.identity[k]) reasons.push(`${k}: prior ${a.identity[k]}, planned ${b.identity[k]}`);
    const sa: SystemIdentity | undefined = a.identity.systems[system], sb: SystemIdentity | undefined = b.identity.systems[system];
    if (!sa || !sb) reasons.push(`${system} has no counted cells in q1-cells.json at the ${!sa ? 'prior' : 'planned'} commit`);
    else {
      reasons.push(...listDiff('cell', sa.cells as Array<{ id: string }>, sb.cells as Array<{ id: string }>));
      reasons.push(...listDiff('set', sa.sets as Array<{ id: string }>, sb.sets as Array<{ id: string }>));
      reasons.push(...listDiff('judge instrument', sa.instruments as Array<{ id: string }>, sb.instruments as Array<{ id: string }>));
      for (const bm of [...new Set([...sa.benchmarks, ...sb.benchmarks])].sort()) {
        const p = `${SPLITS}${bm}.json`;
        if (prior.tree.get(p) !== planned.tree.get(p)) reasons.push(`split file ${p} differs`);
      }
    }
  }
  const runs = prior.probe instanceof Error || planned.probe instanceof Error ? null
    : new Set([...(prior.probe.identity.systems[system]?.benchmarks ?? []), ...(planned.probe.identity.systems[system]?.benchmarks ?? [])]);
  const read = (p: string) => !runs || !DATASET_PINS[p] || DATASET_PINS[p].some(b => runs.has(b));
  const datasets = [...new Set([...prior.tree.keys(), ...planned.tree.keys()])].filter(p => p.startsWith(DATASETS) && read(p)).sort();
  for (const p of datasets) if (prior.tree.get(p) !== planned.tree.get(p)) reasons.push(`dataset pin ${p} differs`);
  const tp = tokenizerPin(prior.lock), tn = tokenizerPin(planned.lock);
  if (tp !== tn) reasons.push(`tokenizer package pin in bun.lock: prior ${tp}, planned ${tn}`);
  if (!isDeclared) reasons.push(`the preregistration does not name A24 source ${source} and ${system} on one line`);
  return { system, reusable: reasons.length === 0, reasons, path_hash: { prior: hp?.sha256 ?? null, planned: hn?.sha256 ?? null, files: hn?.files ?? hp?.files ?? [] }, declared: isDeclared };
}

export interface ReuseReport { prior: string; planned: string; source: string; golden: { prior: string | null; planned: string | null }; reusable: boolean; systems: SystemVerdict[] }

export function reuseCheck(o: { prior: string; planned: string; systems: string[]; preregistration: string; source: string; cwd?: string; probe?: (commit: string) => TreeProbe }): ReuseReport {
  const cwd = o.cwd ?? REPO_ROOT, probe = o.probe ?? (c => probeCommit(c, cwd));
  const side = (commit: string): Side => {
    let p: TreeProbe | Error;
    try { p = probe(commit); } catch (e) { p = e as Error; }
    let lock: string | null = null;
    try { lock = git(cwd, 'show', `${commit}:bun.lock`); } catch { /* no lockfile at this commit */ }
    return { tree: lsTree(commit, cwd), probe: p, lock };
  };
  const a = side(o.prior), b = side(o.planned);
  const systems = o.systems.map(s => systemVerdict(s, a, b, declared(o.preregistration, o.source, s), o.source));
  const digest = (s: Side) => (s.probe instanceof Error ? null : s.probe.digest);
  return { prior: o.prior, planned: o.planned, source: o.source, golden: { prior: digest(a), planned: digest(b) }, reusable: systems.every(s => s.reusable), systems };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); const v = i >= 0 ? argv[i + 1] : undefined; return v?.startsWith('--') ? undefined : v; };
  const priorRef = get('--prior'), plannedRef = get('--planned'), systems = get('--systems'), preregPath = get('--preregistration'), source = get('--a24-source');
  if (!priorRef || !plannedRef || !systems || !preregPath || !source) {
    console.error('usage: bun eval/runner/q1/reuse-check.ts --prior <commit> --planned <commit> --systems a,b,... --preregistration <file> --a24-source <id> [--json]');
    process.exit(2);
  }
  const prior = resolveCommit(priorRef), planned = resolveCommit(plannedRef);
  if (!prior || !planned) { console.error(`commit ${prior ? plannedRef : priorRef} is not in this checkout (fetch it first)`); process.exit(2); }
  let prereg: string;
  try { prereg = readFileSync(preregPath, 'utf8'); } catch (e) { console.error(`cannot read ${preregPath}: ${(e as Error).message}`); process.exit(2); }
  const report = reuseCheck({ prior, planned, systems: systems.split(',').map(s => s.trim()).filter(Boolean), preregistration: prereg, source });
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`A24 source ${source}: ${prior.slice(0, 12)} to ${planned.slice(0, 12)}, golden fixture ${report.golden.prior?.slice(0, 16) ?? 'unmeasured'} / ${report.golden.planned?.slice(0, 16) ?? 'unmeasured'}`);
    for (const v of report.systems) {
      console.log(`${v.system}: ${v.reusable ? 'reusable' : 'refused'} (path hash ${v.path_hash.planned?.slice(0, 16) ?? 'none'}, ${v.path_hash.files.length} files)`);
      for (const r of v.reasons) console.log(`  - ${r}`);
    }
  }
  process.exit(report.reusable ? 0 : 1);
}

/**
 * The Q1 reuse check (eval/runner/q1/reuse-check.ts) and its golden fixture (eval/runner/q1/golden-fixture.ts): the
 * competitor-path glob rule, the hash over a throwaway git repository's commits, the one-line declaration rule, every
 * refusal reason, the CLI exit codes, and the golden digest of the real tree. The checks against the A24 freeze commit
 * skip when this checkout does not hold it (a shallow clone).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { goldenDigest, type TreeIdentity } from '../../eval/runner/q1/golden-fixture.ts';
import { reuseRefusal, type PublicationSource } from '../../eval/runner/q1/publish.ts';
import { declared, lsTree, ownsPath, pathHash, probeCommit, resolveCommit, reuseCheck, tokenizerPin, type TreeProbe } from '../../eval/runner/q1/reuse-check.ts';

const ROOT = resolve(import.meta.dir, '../..');
const A24 = '008b83fe';
const F6_BASE = '65cdd381';
const GOLDEN = 'ee45f6383e263873700677a8d0f2b9542a625e6a25db0d2f9a604bb1cd61dcea';
const hasCommit = (c: string) => resolveCommit(c, ROOT) !== null;
const SYSTEMS = ['ext-extract-first', 'ext-memory-bank', 'ext-graph-pipeline', 'ext-markdown-kb', 'ext-verbatim-session', 'ext-temporal-graph', 'baseline-none', 'baseline-recency', 'baseline-hybrid', 'baseline-file-agent'];

describe('ownsPath', () => {
  test('an external kind owns only the top-level bundle files of its own directory', () => {
    const d = 'docs/comparison-systems/ext-temporal-graph/';
    for (const f of ['Dockerfile', 'docker-compose.yml', 'pyproject.toml', 'uv.lock', 'shim.py', 'capability.json', 'vendor.common.env', 'vendor.recipe.env']) expect(ownsPath('ext-temporal-graph', d + f)).toBe(true);
    for (const f of ['README.md', 'PILOT.md', 'tests/test_shim.py', 'fake_provider/app.py', 'v0.31/Dockerfile', 'v0.31/shim.py', 'v0.31/uv.lock', 'v0.31/x.env']) expect(ownsPath('ext-temporal-graph', d + f)).toBe(false);
    expect(ownsPath('ext-temporal-graph', 'docs/comparison-systems/ext-temporal-graph-v2/Dockerfile')).toBe(false);
    expect(ownsPath('ext-temporal-graph', 'eval/systems/temporal-graph/Dockerfile')).toBe(false);
  });
  test('baselines own their runner files, and other systems have no rule', () => {
    expect(ownsPath('baseline-none', 'eval/runner/systems/baselines.ts')).toBe(true);
    expect(ownsPath('baseline-none', 'eval/runner/cat40/pg-arm.ts')).toBe(false);
    expect(ownsPath('baseline-hybrid', 'eval/runner/cat40/pg-arm.ts')).toBe(true);
    for (const f of ['eval/runner/systems/file-agent.ts', 'eval/runner/cat40/arms.ts', 'eval/runner/cat40/loop.ts']) expect(ownsPath('baseline-file-agent', f)).toBe(true);
    expect(ownsPath('baseline-full-context', 'eval/runner/systems/baselines.ts')).toBe(true);
    expect(ownsPath('gbrain-defaults', 'eval/runner/systems/baselines.ts')).toBeNull();
    expect(ownsPath('gbrain-defaults', 'eval/systems/gbrain-defaults/Dockerfile')).toBeNull();
  });
});

describe('declared', () => {
  const pre = 'F6 reuses A24 source q1-scoreboard-sealed for ext-markdown-kb and baseline-none.\nbaseline-recency is rerun.\n';
  test('names the source and the system on one line', () => {
    expect(declared(pre, 'q1-scoreboard-sealed', 'ext-markdown-kb')).toBe(true);
    expect(declared(pre, 'q1-scoreboard-sealed', 'baseline-none')).toBe(true);
  });
  test('refuses another line, a longer id, a missing source and an empty source', () => {
    expect(declared(pre, 'q1-scoreboard-sealed', 'baseline-recency')).toBe(false);
    expect(declared(pre, 'q1-scoreboard', 'ext-markdown-kb')).toBe(false);
    expect(declared('q1-scoreboard-sealed reuses ext-markdown-kb-v2\n', 'q1-scoreboard-sealed', 'ext-markdown-kb')).toBe(false);
    expect(declared('q1-scoreboard-sealed:x reuses ext-markdown-kb\n', 'q1-scoreboard-sealed', 'ext-markdown-kb')).toBe(false);
    expect(declared(pre, 'a25', 'ext-markdown-kb')).toBe(false);
    expect(declared(pre, '', 'ext-markdown-kb')).toBe(false);
  });
});

describe('tokenizerPin', () => {
  test('reads the pinned package line of a bun.lock', () => {
    const lock = '{\n  "packages": {\n    "@dqbd/tiktoken": ["@dqbd/tiktoken@1.0.22", "", {}, "sha512-abc=="],\n  }\n}\n';
    expect(tokenizerPin(lock)).toBe('"@dqbd/tiktoken@1.0.22", "", {}, "sha512-abc=="');
    expect(tokenizerPin('{}')).toBeNull();
    expect(tokenizerPin(null)).toBeNull();
  });
});

const LOCK = (v: string) => `{\n  "packages": {\n    "@dqbd/tiktoken": ["@dqbd/tiktoken@${v}", "", {}, "sha512-${v}=="],\n  }\n}\n`;
const READERS = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'];
function identity(o: { readers?: string[]; exclusions?: unknown[]; judgeSha?: string; renderer?: string; benchmarks?: string[] } = {}): TreeIdentity {
  const sys = (system: string) => ({
    cells: [{ id: `s1.${system}.recipe`, set: 'S1', benchmark: 'beam-10m', selection: { kind: 'all' }, exclusions: o.exclusions ?? [], arms: [{ id: 'c8k', readers: o.readers ?? READERS }] }],
    sets: [{ id: 'S1', benchmark: 'beam-10m', selection: { kind: 'all' }, exclusions: o.exclusions ?? [] }],
    instruments: [{ id: 'beam-10m', version: 'v1', canonical_judge: 'openai:gpt-4.1-mini', temperature: 0, sha256: o.judgeSha ?? 'aaa' }],
    benchmarks: o.benchmarks ?? ['beam-10m'],
  });
  return { renderer: o.renderer ?? 'memory-render-v2', tokenizer: 'approx-chars-div-4', systems: Object.fromEntries(['ext-a', 'baseline-none', 'baseline-hybrid'].map(s => [s, sys(s)])) };
}

describe('reuseCheck over a throwaway repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q1-reuse-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } };
  const commit = (files: Record<string, string>, msg: string) => { put(files); git('add', '.'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  const B = 'docs/comparison-systems/ext-a/';
  const c1 = commit({ [B + 'Dockerfile']: 'FROM x\n', [B + 'shim.py']: 'v1\n', [B + 'vendor.common.env']: 'A=1\n', [B + 'README.md']: 'r1\n', 'eval/runner/systems/baselines.ts': 'b1\n', 'eval/runner/cat40/pg-arm.ts': 'p1\n',
    'eval/decisions/splits/beam-10m.json': '{"s":1}\n', 'eval/decisions/datasets/beam-x.json': '{"d":1}\n', 'bun.lock': LOCK('1.0.22') }, 'c1');
  const c2 = commit({ [B + 'README.md']: 'r2\n', [B + 'next/Dockerfile']: 'FROM y\n', [B + 'next/shim.py']: 'v2\n', 'eval/runner/cat40/pg-arm.ts': 'p2\n' }, 'docs, a subdirectory configuration, pg-arm');
  const c3 = commit({ [B + 'shim.py']: 'v2\n' }, 'shim');
  const c4 = commit({ [B + 'shim.py']: 'v1\n', 'eval/decisions/splits/beam-10m.json': '{"s":2}\n' }, 'split');
  const c5 = commit({ 'eval/decisions/splits/beam-10m.json': '{"s":1}\n', 'eval/decisions/datasets/beam-x.json': '{"d":2}\n' }, 'dataset');
  const c6 = commit({ 'eval/decisions/datasets/beam-x.json': '{"d":1}\n', 'bun.lock': LOCK('1.0.23') }, 'tokenizer');
  const c7 = commit({ 'eval/decisions/datasets/d8-manifest.json': '{"files":[]}\n' }, 'a D8 pin');
  const PRE = 'Reuse from A24 source a24-src for ext-a, baseline-none, baseline-hybrid.\n';
  const probe = (probes: Record<string, TreeProbe>) => (c: string) => probes[c] ?? { digest: GOLDEN, identity: identity() };
  const run = (prior: string, planned: string, o: { probes?: Record<string, TreeProbe | Error>; pre?: string; systems?: string[] } = {}) => reuseCheck({
    prior, planned, systems: o.systems ?? ['ext-a', 'baseline-none', 'baseline-hybrid'], preregistration: o.pre ?? PRE, source: 'a24-src', cwd: dir,
    probe: c => { const p = o.probes?.[c]; if (p instanceof Error) throw p; return p ?? { digest: GOLDEN, identity: identity() }; },
  });
  const by = (r: ReturnType<typeof run>, s: string) => r.systems.find(v => v.system === s)!;

  test('the hash is sha256 over sorted path, NUL, blob sha lines of the top-level bundle files', () => {
    const tree = lsTree(c1, dir);
    const h = pathHash(tree, 'ext-a')!;
    expect(h.files).toEqual([B + 'Dockerfile', B + 'shim.py', B + 'vendor.common.env']);
    const blob = (p: string) => git('rev-parse', `${c1}:${p}`);
    expect(h.sha256).toBe(createHash('sha256').update(h.files.map(p => `${p}\0${blob(p)}\n`).join('')).digest('hex'));
    expect(pathHash(lsTree(c2, dir), 'ext-a')!.sha256).toBe(h.sha256);
    expect(pathHash(tree, 'gbrain-defaults')).toBeNull();
    expect(pathHash(tree, 'baseline-full-context')!.files).toEqual(['eval/runner/systems/baselines.ts']);
  });

  test('a README edit and a new subdirectory configuration keep a bundle reusable; a changed baseline file refuses', () => {
    const r = run(c1, c2);
    expect(by(r, 'ext-a')).toMatchObject({ reusable: true, reasons: [], declared: true });
    expect(by(r, 'baseline-none').reusable).toBe(true);
    expect(by(r, 'baseline-hybrid').reusable).toBe(false);
    expect(by(r, 'baseline-hybrid').reasons).toEqual([expect.stringMatching(/^competitor-path hash differs .*: eval\/runner\/cat40\/pg-arm\.ts$/)]);
    expect(r.reusable).toBe(false);
    expect(run(c1, c2, { systems: ['ext-a', 'baseline-none'] }).reusable).toBe(true);
  });

  test('a changed shim refuses that bundle only', () => {
    const r = run(c2, c3);
    expect(by(r, 'ext-a').reasons).toEqual([expect.stringMatching(/competitor-path hash differs .*: docs\/comparison-systems\/ext-a\/shim\.py$/)]);
    expect(by(r, 'baseline-none').reusable).toBe(true);
  });

  test('a changed split file, dataset pin or tokenizer package refuses', () => {
    expect(by(run(c3, c4, { systems: ['baseline-none'] }), 'baseline-none').reasons).toEqual(['split file eval/decisions/splits/beam-10m.json differs']);
    expect(by(run(c4, c5, { systems: ['baseline-none'] }), 'baseline-none').reasons).toEqual(['split file eval/decisions/splits/beam-10m.json differs', 'dataset pin eval/decisions/datasets/beam-x.json differs']);
    expect(by(run(c5, c6, { systems: ['baseline-none'] }), 'baseline-none').reasons).toEqual(['dataset pin eval/decisions/datasets/beam-x.json differs', expect.stringMatching(/^tokenizer package pin in bun\.lock: .*1\.0\.22.*1\.0\.23/)]);
  });

  test('a pin read only by benchmarks the system does not run (D8) leaves it reusable; a system that runs one is refused', () => {
    expect(by(run(c6, c7, { systems: ['baseline-none'] }), 'baseline-none')).toMatchObject({ reusable: true, reasons: [] });
    const d8 = { [c7]: { digest: GOLDEN, identity: identity({ benchmarks: ['beam-10m', 'beam-d8'] }) } };
    expect(by(run(c6, c7, { systems: ['baseline-none'], probes: d8 }), 'baseline-none').reasons).toEqual(['dataset pin eval/decisions/datasets/d8-manifest.json differs']);
    expect(by(run(c6, c7, { systems: ['baseline-none'], probes: { [c7]: new Error('boom') } }), 'baseline-none').reasons).toContain('dataset pin eval/decisions/datasets/d8-manifest.json differs');
  });

  test('a different golden digest, renderer, reader set, exclusion or judge instrument refuses', () => {
    const p = (o: Partial<TreeProbe> & { id?: Parameters<typeof identity>[0] }) => ({ [c2]: { digest: o.digest ?? GOLDEN, identity: identity(o.id) } });
    expect(by(run(c1, c2, { probes: p({ digest: 'f'.repeat(64) }) }), 'ext-a').reasons).toEqual([expect.stringMatching(/^golden fixture digest differs/)]);
    expect(by(run(c1, c2, { probes: p({ id: { renderer: 'memory-render-v3' } }) }), 'ext-a').reasons).toEqual(['renderer: prior memory-render-v2, planned memory-render-v3']);
    expect(by(run(c1, c2, { probes: p({ id: { readers: ['openai:gpt-6.1-sol'] } }) }), 'ext-a').reasons).toEqual(['cell s1.ext-a.recipe: arms differ']);
    expect(by(run(c1, c2, { probes: p({ id: { exclusions: [{ question_id: 'q', reason: 'r' }] } }) }), 'ext-a').reasons).toEqual(['cell s1.ext-a.recipe: exclusions differ', 'set S1: exclusions differ']);
    expect(by(run(c1, c2, { probes: p({ id: { judgeSha: 'bbb' } }) }), 'ext-a').reasons).toEqual(['judge instrument beam-10m: sha256 differ']);
  });

  test('a system with no counted cells, an unmeasured tree, an unknown system or a missing declaration refuses', () => {
    expect(by(run(c1, c2, { systems: ['ext-b'] }), 'ext-b').reasons).toEqual(['no ext-b files at the prior commit', 'no ext-b files at the planned commit', 'ext-b has no counted cells in q1-cells.json at the prior commit', expect.stringContaining('does not name A24 source a24-src and ext-b')]);
    expect(by(run(c1, c2, { probes: { [c1]: new Error('boom') } }), 'ext-a').reasons).toEqual(['shared harness not measured: boom']);
    expect(by(run(c1, c2, { systems: ['gbrain-defaults'] }), 'gbrain-defaults').reasons[0]).toMatch(/has no competitor-path rule/);
    const r = run(c1, c2, { pre: 'Reuse from A24 source a24-src for\next-a\n' });
    expect(by(r, 'ext-a')).toMatchObject({ reusable: false, declared: false, reasons: ['the preregistration does not name A24 source a24-src and ext-a on one line'] });
  });

  test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });
});

describe('golden fixture', () => {
  test('the digest of the current tree is stable', async () => {
    const a = await goldenDigest(ROOT), b = await goldenDigest(ROOT);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });
  for (const c of [A24, F6_BASE]) {
    test.skipIf(!hasCommit(c))(`the digest at ${c} is ${GOLDEN.slice(0, 8)} (skipped when this checkout lacks ${c})`, () => {
      const p = probeCommit(c);
      expect(p.digest).toBe(GOLDEN);
      expect(p.identity.renderer).toBe('memory-render-v2');
    }, 60_000);
  }
});

describe('the real check from the A24 freeze commit', () => {
  const both = hasCommit(A24) && hasCommit(F6_BASE);
  test.skipIf(!both)(`${A24} to ${F6_BASE}: bundles and the plain baselines pass, baseline-hybrid and baseline-file-agent refuse on changed code (skipped without both commits)`, () => {
    const pre = `F6 reuses A24 source q1-scoreboard-sealed rows of ${SYSTEMS.join(', ')}.\n`;
    const r = reuseCheck({ prior: A24, planned: F6_BASE, systems: SYSTEMS, preregistration: pre, source: 'q1-scoreboard-sealed' });
    expect(r.golden).toEqual({ prior: GOLDEN, planned: GOLDEN });
    const verdict = Object.fromEntries(r.systems.map(v => [v.system, v.reasons]));
    for (const s of SYSTEMS.slice(0, 8)) expect([s, verdict[s]]).toEqual([s, []]);
    expect(verdict['baseline-hybrid']).toEqual([expect.stringMatching(/competitor-path hash differs \(ef8a2bb69392f58b to .*: eval\/runner\/cat40\/pg-arm\.ts$/)]);
    expect(verdict['baseline-file-agent']).toEqual([expect.stringMatching(/competitor-path hash differs \(f9750253c866b0ed to .*: eval\/runner\/cat40\/arms\.ts, eval\/runner\/cat40\/loop\.ts$/)]);
    expect(r.systems.find(v => v.system === 'ext-temporal-graph')!.path_hash.prior!.slice(0, 16)).toBe('57145005214cb866');
  }, 60_000);

  test.skipIf(!both)('the CLI exits 0 when every system is reusable and 1 when one is refused', () => {
    const d = mkdtempSync(join(tmpdir(), 'q1-reuse-cli-'));
    try {
      writeFileSync(join(d, 'pre.md'), 'A24 source q1-scoreboard-sealed rows reused for ext-markdown-kb and baseline-hybrid.\n');
      const cli = (systems: string) => spawnSync('bun', ['eval/runner/q1/reuse-check.ts', '--prior', A24, '--planned', F6_BASE, '--systems', systems, '--preregistration', join(d, 'pre.md'), '--a24-source', 'q1-scoreboard-sealed', '--json'], { cwd: ROOT, encoding: 'utf8' });
      const ok = cli('ext-markdown-kb');
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout).systems[0]).toMatchObject({ system: 'ext-markdown-kb', reusable: true, declared: true });
      expect(cli('ext-markdown-kb,baseline-hybrid').status).toBe(1);
      expect(cli('ext-memory-bank').status).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);

  test.skipIf(!both)('publish.ts refuses a reuse_check source whose systems fail or are not listed', () => {
    const d = mkdtempSync(join(tmpdir(), 'q1-reuse-pub-'));
    try {
      writeFileSync(join(d, 'pre.md'), 'A24 source q1-scoreboard-sealed rows reused for ext-markdown-kb and baseline-hybrid.\n');
      const src = (systems?: string[]): PublicationSource => ({ campaign: 'c.json', launch_tree: A24, ...(systems ? { systems } : {}), reuse_check: { planned: F6_BASE, preregistration: join(d, 'pre.md'), a24_source: 'q1-scoreboard-sealed' } });
      expect(reuseRefusal(src(['ext-markdown-kb']))).toBeNull();
      expect(reuseRefusal(src(['ext-markdown-kb', 'baseline-hybrid']))).toMatch(/fails its reuse check: baseline-hybrid \(competitor-path hash differs/);
      expect(reuseRefusal(src())).toMatch(/lists its systems/);
      expect(reuseRefusal({ campaign: 'c.json', launch_tree: A24 })).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);
});

describe('CLI usage', () => {
  test('missing flags and an unknown commit exit 2', () => {
    expect(spawnSync('bun', ['eval/runner/q1/reuse-check.ts', '--prior', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).status).toBe(2);
    const unknown = spawnSync('bun', ['eval/runner/q1/reuse-check.ts', '--prior', 'f'.repeat(40), '--planned', 'HEAD', '--systems', 'baseline-none', '--preregistration', 'CLAUDE.md', '--a24-source', 'x'], { cwd: ROOT, encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('is not in this checkout');
  });
});

/**
 * The CLI arm's sandbox (GBEV-55 gate change E1) and the G3 causes on the pinned gbrain.
 *
 * Keyless: provider keys are deleted from this process for the file, every model is scripted, and the loop's fetch is
 * a dead upstream that throws, so no test can reach a provider. gbrain itself runs for real: the pinned CLI and
 * MCP server on a synthetic brain in a hermetic GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brainChildEnv, GbrainCliArm, GbrainMcpArm, SyntheticBrain, validateArgv } from '../../eval/runner/predictive/cli-arm.ts';
import { runWriteEpisode, scriptedWritePolicy } from '../../eval/runner/predictive/episodes.ts';
import { multiWindowReads } from '../../eval/runner/predictive/write-contract.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { HERMETIC_KEY_PATTERN, HERMETIC_STRIPPED_KEYS } from '../../eval/runner/hermetic-env.ts';
import { G3_CAUSES, generateWriteTasks } from '../../eval/generators/write-contract-gen.ts';

const saved: Record<string, string | undefined> = {};
const deadFetch = (() => { throw new Error('dead upstream: tests never call a provider'); }) as unknown as typeof fetch;
beforeAll(() => {
  for (const k of Object.keys(process.env)) if ((HERMETIC_STRIPPED_KEYS as readonly string[]).includes(k) || HERMETIC_KEY_PATTERN.test(k) || /PARTICLE|UBICLOUD/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });

function treeDigest(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      h.update(p.slice(dir.length));
      if (s.isDirectory()) walk(p); else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

describe('argv and environment', () => {
  test('argv must be an array of plain strings; a leading gbrain is dropped', () => {
    expect(validateArgv(['gbrain', 'get', 'people/a'])).toEqual(['get', 'people/a']);
    expect(() => validateArgv('get people/a')).toThrow(/array/);
    expect(() => validateArgv([])).toThrow(/empty/);
    expect(() => validateArgv(['get', 7])).toThrow(/not a string/);
    expect(() => validateArgv(['get', 'a\0b'])).toThrow(/NUL/);
    expect(() => validateArgv(Array.from({ length: 65 }, () => 'x'))).toThrow(/at most/);
  });

  test('gbrain processes get an allowlist, never a provider key from the caller', () => {
    const env = brainChildEnv('/tmp/brain-home', { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'dummy-not-a-key', OPENAI_BASE_URL: 'http://x.invalid', PARTICLE_API_KEY: 'dummy', SOME_TOKEN: 'dummy' });
    expect(env.HOME).toBe('/tmp/brain-home');
    expect(env.GBRAIN_HOME).toBe('/tmp/brain-home');
    expect(env.GBRAIN_SELF_UPGRADE_MODE).toBe('off');
    expect(Object.keys(env).sort()).toEqual(['GBRAIN_HOME', 'GBRAIN_SELF_UPGRADE_MODE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR', 'TZ']);
  });
});

describe('E1: the operator default brain stays untouched', () => {
  test('calls without --brain and with shell metacharacters reach only the synthetic brain', async () => {
    const operator = mkdtempSync(join(tmpdir(), 'operator-home-'));
    mkdirSync(join(operator, '.gbrain'), { recursive: true });
    writeFileSync(join(operator, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', note: 'operator default brain sentinel' }));
    writeFileSync(join(operator, '.gbrain', 'brain.pglite'), 'operator brain bytes');
    const before = treeDigest(operator);
    const prev = { HOME: process.env.HOME, GBRAIN_HOME: process.env.GBRAIN_HOME };
    process.env.HOME = operator;
    process.env.GBRAIN_HOME = operator;
    const callerCwd = mkdtempSync(join(tmpdir(), 'operator-cwd-'));
    const prevCwd = process.cwd();
    process.chdir(callerCwd);
    let synthHome = '';
    try {
      const brain = await SyntheticBrain.create('e1', [{ slug: 'people/ana-example', markdown: '---\ntype: person\ntitle: Ana Example\n---\n\nAna works at Fernway.\n' }]);
      synthHome = brain.home;
      expect(brain.env.HOME).toBe(brain.home);
      expect(brain.env.GBRAIN_HOME).toBe(brain.home);
      expect(process.env.GBRAIN_HOME).toBe(operator);
      try {
        const cli = new GbrainCliArm(brain);
        const pwn = (n: number) => join(operator, `pwned-${n}`);
        await cli.call('gbrain', { argv: ['sources', 'list'] });
        await cli.call('gbrain', { argv: ['search', `$(touch ${pwn(1)})`] });
        await cli.call('gbrain', { argv: ['get', `people/ana-example; touch ${pwn(2)}`] });
        await cli.call('gbrain', { argv: ['put', 'notes/capture-1'], stdin: `Body \u0060touch ${pwn(3)}\u0060 | tee ${pwn(4)}\n` });
        const saved = await cli.call('gbrain', { argv: ['remember', `Ana likes tea && touch ${pwn(5)} > ${pwn(6)}`, '--entity', 'people/ana-example', '--provenance', 'user said'] });
        expect(saved).toContain('remembered as fact');
        const mcp = await GbrainMcpArm.start(brain);
        try { await mcp.call('remember', { fact: `Ana moved $(touch ${pwn(7)})`, entity: 'people/ana-example', provenance: 'user said' }); } finally { await mcp.close(); }
        const snap = await brain.snapshot();
        expect(Object.keys(snap.pages).sort()).toEqual(['notes/capture-1', 'people/ana-example']);
        expect(snap.facts.map(f => f.fact)).toContain(`Ana likes tea && touch ${pwn(5)} > ${pwn(6)}`);
        for (let n = 1; n <= 7; n++) expect(existsSync(pwn(n))).toBe(false);
      } finally {
        brain.dispose();
      }
      expect(existsSync(synthHome)).toBe(false);
      expect(treeDigest(operator)).toBe(before);
      expect(readdirSync(callerCwd)).toEqual([]);
    } finally {
      process.chdir(prevCwd);
      rmSync(callerCwd, { recursive: true, force: true });
      process.env.HOME = prev.HOME;
      if (prev.GBRAIN_HOME === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = prev.GBRAIN_HOME;
      rmSync(operator, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('G3 causes reproduce on the pinned gbrain', () => {
  const tasks = G3_CAUSES.map(c => generateWriteTasks({ n: 8 }).find(t => t.cause === c)!);
  test('a recovering fake passes every cause on both surfaces and meets the cause wherever it is exposed', async () => {
    const reads = multiWindowReads(resolveGbrainUnderTest(null).version);
    const seen: string[] = [];
    for (const task of tasks) for (const surface of ['cli', 'mcp'] as const) {
      const e = await runWriteEpisode({ task, surface, trial: 0, model: 'scripted-fake', fetchImpl: deadFetch, scripted: scriptedWritePolicy(task, surface, 'recovering') });
      expect({ id: task.id, surface, cause: e.cause }).toEqual({ id: task.id, surface, cause: 'correct' });
      expect(e.reported_done_not_landed).toBe(0);
      const met = e.refusals.some(r => r.cause === task.cause);
      if (reads && task.cause === 'two_range_read') {
        const refusals = surface === 'mcp' ? [] : [{ cause: 'two_range_read', code: null, family: 'get', call: 0, retried: true, recovered: true }];
        expect({ id: task.id, surface, refusals: e.refusals }).toEqual({ id: task.id, surface, refusals });
      } else {
        expect({ id: task.id, surface, met }).toEqual({ id: task.id, surface, met: task.exposure[surface][task.cause] === 1 });
      }
      if (met) seen.push(`${surface}:${task.cause}`);
    }
    expect(seen.length).toBe(reads ? 8 + 5 : 8 + 6);
  }, 600_000);

  test('a careless fake that reports every write as landed is caught as reported done, not landed', async () => {
    for (const cause of ['missing_provenance', 'source_changed', 'scope_denied'] as const) {
      const task = tasks.find(t => t.cause === cause)!;
      const e = await runWriteEpisode({ task, surface: 'cli', trial: 0, model: 'scripted-fake', fetchImpl: deadFetch, scripted: scriptedWritePolicy(task, 'cli', 'careless') });
      expect(e.success).toBe(false);
      expect(e.reported_done_not_landed).toBe(1);
      expect(e.cause).toBe('write_integrity');
      expect(e.refusals.map(r => [r.cause, r.retried])).toEqual([[cause, false]]);
    }
  }, 300_000);
});

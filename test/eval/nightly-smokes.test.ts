/**
 * Keyless tests for the nightly system smokes (eval/runner/nightly/smokes/): the seeded brain is deterministic, every
 * gbrain process gets an environment with no key in it, results have the shape the nightly runner reads, the smoke list
 * matches the dev set, and one smoke runs end to end on the pinned gbrain.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brainDigest, generateBrain, largePage } from '../../eval/runner/nightly/smokes/brain.ts';
import { BASE_URL_VARS, DEAD_UPSTREAM, PROVIDER_KEYS, SmokeFail, brainDirs, gbrain, keylessEnv } from '../../eval/runner/nightly/smokes/harness.ts';
import { SMOKES, runSmokes } from '../../eval/runner/nightly/smokes/index.ts';
import { loadDevSet } from '../../eval/runner/nightly/devset.ts';

const ROOT = resolve(import.meta.dir, '../..');
const PINNED = join(ROOT, 'node_modules/gbrain');
const scratch = () => mkdtempSync(join(tmpdir(), 'nightly-smokes-'));

describe('seeded brain', () => {
  test('the same seed gives the same bytes, another seed different ones', () => {
    expect(brainDigest(generateBrain(7))).toBe(brainDigest(generateBrain(7)));
    expect(brainDigest(generateBrain(7))).not.toBe(brainDigest(generateBrain(8)));
    expect(largePage(3)).toBe(largePage(3));
  });

  test('carries the shapes the smokes need', () => {
    const b = generateBrain(1);
    expect(b.pages.length).toBeGreaterThanOrEqual(300);
    const hubs = b.pages.filter(p => p.kind === 'hub');
    expect(hubs.length).toBe(30);
    for (const h of hubs) {
      expect(h.path.endsWith('/index.md')).toBe(true);
      expect(b.files.get(h.path)).toMatch(/^---\ntype: \w+\ntitle: .+\nslug: \S+\n---/);
    }
    expect(b.pages.filter(p => p.facts.length > 0 && /<!--- gbrain:facts:begin -->/.test(b.files.get(p.path)!)).length).toBeGreaterThanOrEqual(100);
    const tokens = b.pages.map(p => p.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const p of b.pages) expect([...b.files.values()].filter(text => text.includes(p.token)).length).toBe(1);
    expect(largePage(1).length).toBeGreaterThan(4 * 1024 * 1024);
  });
});

describe('keyless environment', () => {
  test('holds no key-like variable, whatever this process holds, and points every provider at a dead port', () => {
    const dir = scratch();
    try {
      const env = keylessEnv(brainDirs(dir), { DATABASE_URL: 'postgres://postgres@127.0.0.1:1/x' });
      for (const k of Object.keys(env)) {
        if ((BASE_URL_VARS as readonly string[]).includes(k)) expect(env[k]).toBe(DEAD_UPSTREAM);
        else expect(PROVIDER_KEYS.test(k)).toBe(false);
      }
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) expect(env[k]).toBe(DEAD_UPSTREAM);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('refuses a key or a live provider URL', () => {
    const dir = scratch();
    try {
      const d = brainDirs(dir);
      expect(() => keylessEnv(d, { OPENAI_API_KEY: 'not-a-real-key' })).toThrow(SmokeFail);
      expect(() => keylessEnv(d, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toThrow(SmokeFail);
      expect(() => gbrain(PINNED, ['--version'], { env: { PATH: '/usr/bin', VOYAGE_API_KEY: 'not-a-real-key' } })).toThrow(SmokeFail);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('runSmokes', () => {
  test('the smoke list is the dev set system-smokes suite, in order', () => {
    const suite = loadDevSet().suites.find(s => s.id === 'system-smokes')!;
    expect(suite.items.map(i => i.id)).toEqual([...SMOKES]);
  });

  test('returns one { id, pass, code, detail, ms } per smoke, and a missing Postgres is a harness failure', async () => {
    const out = scratch();
    try {
      const results = await runSmokes({ tonightRoot: PINNED, previousRoot: PINNED, oldRoot: PINNED, out, postgres: {}, only: ['postgres-15'] });
      expect(results.length).toBe(1);
      const [r] = results;
      expect(Object.keys(r!).sort()).toEqual(['code', 'detail', 'id', 'ms', 'pass']);
      expect(r).toMatchObject({ id: 'postgres-15', pass: false, code: 'harness_missing_postgres' });
      expect(typeof r!.ms).toBe('number');
      await expect(runSmokes({ tonightRoot: PINNED, previousRoot: PINNED, oldRoot: PINNED, out, postgres: {}, only: ['no-such-smoke'] })).rejects.toThrow(/unknown smoke/);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  test('query-contract passes end to end on the pinned gbrain', async () => {
    const out = scratch();
    try {
      const [r] = await runSmokes({ tonightRoot: PINNED, previousRoot: PINNED, oldRoot: PINNED, out, postgres: {}, only: ['query-contract'] });
      expect(r).toMatchObject({ id: 'query-contract', pass: true, code: 'ok' });
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 180_000);
});

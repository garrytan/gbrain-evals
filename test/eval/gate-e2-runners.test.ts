import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from 'gbrain/engine';
import type * as Extract from 'gbrain/extract';
import { EVAL_ENGINE_REFUSED_EXIT, gateRunnerContext } from '../../eval/runner/eval-engine.ts';
import { ENGINE_ADAPTERS, installStubEmbed, parseCliArgs } from '../../eval/runner/multi-adapter.ts';
import { storedEdges, type RichPage } from '../../eval/runner/type-accuracy.ts';

const ROOT = join(import.meta.dir, '../..');

const KEYLESS_ENV: Record<string, string | undefined> = {
  ...process.env,
  OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', EXA_API_KEY: '',
  GBRAIN_UNDER_TEST: '', LIFECYCLE_PG_URL: '', GBRAIN_RUST_ENGINE_ADDON: '', GBRAIN_RUST_ENGINE_ADDON_SHA256: '',
};

function runner(script: string, args: string[], env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [join(ROOT, 'eval/runner', script), ...args], { cwd: ROOT, env: { ...KEYLESS_ENV, ...env }, encoding: 'utf8', timeout: 120_000 });
}

describe('multi-adapter engine switch', () => {
  test('parseCliArgs takes --stub-embed, --gbrain and --pg-url in both forms', () => {
    expect(parseCliArgs(['--stub-embed']).stubEmbed).toBe(true);
    expect(parseCliArgs([]).stubEmbed).toBeUndefined();
    expect(parseCliArgs(['--gbrain', '/x@abc', '--pg-url', 'postgres://h/db', '--adapter', 'gbrain']).adapter).toBe('gbrain');
    expect(parseCliArgs(['--gbrain=/x', '--pg-url=postgres://h/db']).queries).toBe('all');
    expect(() => parseCliArgs(['--gbrain'])).toThrow(/--gbrain requires a value/);
    expect(() => parseCliArgs(['--pg-url', '--json'])).toThrow(/--pg-url requires a value/);
  });

  test('only the gbrain and graph-oracle-parse rows open the gate engine', () => {
    expect([...ENGINE_ADAPTERS].sort()).toEqual(['gbrain', 'graph-oracle-parse']);
  });

  test('a row that never opens the gate engine is refused with exit 69 before any work', () => {
    const receipt = join(tmpdir(), `gate-e2-never-${process.pid}.json`);
    const r = runner('multi-adapter.ts', ['--adapter', 'grep-only', '--receipt-path', receipt], { GBRAIN_EVAL_ENGINE: 'postgres' });
    expect(r.status).toBe(EVAL_ENGINE_REFUSED_EXIT);
    expect(r.stderr).toMatch(/engine_not_supported_by_runner/);
    expect(existsSync(receipt)).toBe(false);
  }, 120_000);

  test('installStubEmbed puts a counting token-hash transport in the build gateway', async () => {
    const ctx = gateRunnerContext([], {});
    const gw = await import('gbrain/ai/gateway');
    const hadKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const count = await installStubEmbed(ctx);
      gw.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 64, env: process.env as Record<string, string | undefined> });
      expect((gw.diagnoseEmbedding() as { provider?: string }).provider).toBe('<test-transport>');
      const [a, b, c] = await gw.embed(['quantum rocket founder', 'quantum rocket founder', 'payroll ledger audit']);
      expect(a.length).toBe(64);
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(Array.from(a)).not.toEqual(Array.from(c));
      expect(count).toEqual({ transport: 'token-hash', texts: 3, chars: 64 });
    } finally {
      gw.__setEmbedTransportForTests(null);
      gw.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env as Record<string, string | undefined> });
      if (hadKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = hadKey;
    }
  });
});

describe('type-accuracy engine arm', () => {
  test('storedEdges writes every page, runs extract links from the db and reads links back per page', async () => {
    const pages: RichPage[] = [
      { slug: 'people/a', type: 'person', title: 'A', compiled_truth: 'A works at [B](companies/b).', timeline: '', _facts: { type: 'person' } },
      { slug: 'companies/b', type: 'company', title: 'B', compiled_truth: 'B.', timeline: '- 2024: founded', _facts: { type: 'company' } },
    ];
    const put: Array<[string, unknown]> = [];
    const engine = {
      putPage: async (slug: string, page: unknown) => { put.push([slug, page]); },
      getLinks: async (slug: string) => slug === 'people/a'
        ? [{ from_slug: 'people/a', to_slug: 'companies/b', link_type: 'works_at' }, { from_slug: 'people/a', to_slug: 'companies/b', link_type: 'mentions' }]
        : [],
    } as unknown as BrainEngine;
    const calls: string[][] = [];
    const runExtract = (async (_e: BrainEngine, args: string[]) => { calls.push(args); }) as unknown as typeof Extract.runExtract;
    const edges = await storedEdges(engine, pages, runExtract);
    expect(put).toEqual([
      ['people/a', { type: 'person', title: 'A', compiled_truth: 'A works at [B](companies/b).', timeline: '' }],
      ['companies/b', { type: 'company', title: 'B', compiled_truth: 'B.', timeline: '- 2024: founded' }],
    ]);
    expect(calls).toEqual([['links', '--source', 'db']]);
    expect(edges).toEqual([
      { from: 'people/a', to: 'companies/b', type: 'works_at' },
      { from: 'people/a', to: 'companies/b', type: 'mentions' },
    ]);
  });
});

describe('Cat 1 and Cat 2 refuse an engine the build lacks', () => {
  for (const script of ['before-after.ts', 'type-accuracy.ts']) {
    test(`${script} on rust with the pinned gbrain exits 69 and writes no receipt`, () => {
      const receipt = join(ROOT, 'eval/reports', script.replace('.ts', ''), 'engine-rust', 'receipt.json');
      const before = existsSync(receipt) ? statSync(receipt).mtimeMs : null;
      const r = runner(script, [], { GBRAIN_EVAL_ENGINE: 'rust' });
      expect(r.status).toBe(EVAL_ENGINE_REFUSED_EXIT);
      expect(r.stderr).toMatch(/REFUSED: Cat [12] [a-z-]+ did not run on engine rust/);
      expect(existsSync(receipt) ? statSync(receipt).mtimeMs : null).toBe(before);
    }, 120_000);
  }
});

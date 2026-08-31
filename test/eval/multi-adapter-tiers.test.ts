/**
 * Multi-adapter orchestrator + adapter regression suite (hermetic, no keys,
 * no network: embeds go through gbrain's __setEmbedTransportForTests seam
 * with a deterministic token-hash embedding + OPENAI_API_KEY=dummy).
 *
 * Pins the audit fixes:
 *   - orchestrators-11: `--adapter NAME` (space form) and `--adapter=NAME`
 *     both parse; `all` is a valid alias; an unknown adapter name ERRORS
 *     instead of silently running all four adapters.
 *   - orchestrators-12: BRAINBENCH_N='' / '0' / garbage falls back to 5 runs
 *     instead of producing zero runs and crashing on runResults[0].
 *   - orchestrators-15: shootout-driver's relational cells use the SAME
 *     4-template builder as multi-adapter (queries/relational.ts) — the old
 *     private copy dropped invested_in + advises.
 *   - adapters-queries-07: the tier 5 / 5.5 sets actually EXECUTE as
 *     multi-adapter query families (empty-gold items excluded per the NaN
 *     contract), and the runner writes a WS0 receipt.
 *   - adapters-queries-03: VectorOnlyAdapter's state.embeddingModel is the
 *     real configured model, not undefined.
 *   - adapters-queries-08: a gateway reconfiguration between init() and
 *     query() makes the vector adapter FAIL LOUD on the dim mismatch
 *     instead of ranking on truncated prefixes.
 *   - adapters-queries-04: HybridNoGraphConfig.limit is honored by query().
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseCliArgs,
  selectAdapters,
  resolveRunsPerAdapter,
  collectFamilies,
  familiesForAdapter,
} from '../../eval/runner/multi-adapter.ts';
import { buildRelationalQueries, loadWorldCorpus, type RichPage } from '../../eval/runner/queries/relational.ts';
import { buildCellQueries, runCell } from '../../eval/runner/shootout-driver.ts';
import { VectorOnlyAdapter, _cosine } from '../../eval/runner/adapters/vector.ts';
import { HybridNoGraphAdapter } from '../../eval/runner/adapters/vector-grep-rrf-fusion.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';
import type { Adapter, Page } from '../../eval/runner/types.ts';

const REPO = join(import.meta.dir, '../..');
let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'multi-adapter-test-'));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ─── Embed seam (deterministic token-hash embedding, no API) ─────────

function hashVec(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    v[h % dim] += ((h >>> 8) & 1) ? 1 : -1;
  }
  let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (norm === 0) { v[0] = 1; norm = 1; }
  return v.map(x => x / norm);
}

async function withEmbedSeam<T>(fn: () => Promise<T>): Promise<T> {
  const gw = await import('gbrain/ai/gateway');
  const hadKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'dummy-test-key';
  gw.__setEmbedTransportForTests((async (params: { values: string[] }) => ({
    embeddings: params.values.map(t => hashVec(t, gw.getEmbeddingDimensions())),
    values: params.values,
    warnings: [],
  })) as unknown as Parameters<typeof gw.__setEmbedTransportForTests>[0]);
  try {
    return await fn();
  } finally {
    gw.__setEmbedTransportForTests(null);
    if (hadKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = hadKey;
  }
}

// ─── Fixture pages ────────────────────────────────────────────────────

function mkRichPage(slug: string, type: RichPage['type'], title: string, facts: Partial<RichPage['_facts']>, truth: string): RichPage {
  return {
    slug,
    type,
    title,
    compiled_truth: truth,
    timeline: '',
    _facts: { type, ...facts },
  };
}

/** 4 templates' worth of facts: meeting attendees, company employees+founders, investors, advisors. */
function templateCorpus(): RichPage[] {
  return [
    mkRichPage('people/ana-ruiz', 'person', 'Ana Ruiz', { role: 'founder' },
      'Ana Ruiz founded Rocketry Labs and attended the quantum planning offsite. She writes about quantum propulsion.'),
    mkRichPage('people/bo-chen', 'person', 'Bo Chen', { role: 'engineer' },
      'Bo Chen is a staff engineer at Rocketry Labs working on quantum telemetry pipelines.'),
    mkRichPage('people/cy-park', 'person', 'Cy Park', { role: 'investor' },
      'Cy Park invests in deep tech and led the Rocketry Labs seed round. Quantum enthusiast.'),
    mkRichPage('people/di-wolf', 'person', 'Di Wolf', { role: 'advisor' },
      'Di Wolf advises hardware startups on quantum go-to-market strategy.'),
    mkRichPage('companies/rocketry-labs', 'company', 'Rocketry Labs', {
      founders: ['people/ana-ruiz'],
      employees: ['people/bo-chen'],
      investors: ['people/cy-park'],
      advisors: ['people/di-wolf'],
    }, 'Rocketry Labs builds quantum propulsion systems for smallsats.'),
    mkRichPage('meetings/offsite-q1', 'meeting', 'Q1 Quantum Offsite', {
      attendees: ['people/ana-ruiz', 'people/bo-chen'],
    }, 'Planning offsite covering the quantum roadmap. Ana Ruiz and Bo Chen attended.'),
  ];
}

let corpusDirCounter = 0;
function writeCorpusDir(pages: RichPage[]): string {
  const dir = join(sandbox, `corpus-${++corpusDirCounter}`);
  mkdirSync(dir, { recursive: true });
  for (const p of pages) {
    writeFileSync(join(dir, `${p.slug.replace('/', '__')}.json`), JSON.stringify(p, null, 2));
  }
  return dir;
}

// ─── orchestrators-11: --adapter parsing ──────────────────────────────

describe('parseCliArgs / selectAdapters (audit orchestrators-11)', () => {
  const fakeAdapters = ['gbrain', 'vector-grep-rrf-fusion', 'grep-only', 'vector']
    .map(name => ({ name } as Adapter));

  test('space form parses: --adapter grep-only', () => {
    expect(parseCliArgs(['--adapter', 'grep-only']).adapter).toBe('grep-only');
  });

  test('equals form parses: --adapter=vector', () => {
    expect(parseCliArgs(['--adapter=vector']).adapter).toBe('vector');
  });

  test('--adapter without a value throws instead of silently running everything', () => {
    expect(() => parseCliArgs(['--adapter'])).toThrow(/--adapter requires a value/);
    expect(() => parseCliArgs(['--adapter', '--json'])).toThrow(/--adapter requires a value/);
  });

  test('unknown args throw instead of being ignored', () => {
    expect(() => parseCliArgs(['--adapters=grep-only'])).toThrow(/unknown arg/);
  });

  test('"all" is a valid alias for every adapter', () => {
    expect(selectAdapters(fakeAdapters, 'all').length).toBe(4);
    expect(selectAdapters(fakeAdapters, undefined).length).toBe(4);
  });

  test('an unknown adapter name throws with the available list', () => {
    expect(() => selectAdapters(fakeAdapters, 'bogus')).toThrow(/No adapter named "bogus".*grep-only/);
  });

  test('exact name selects exactly one adapter', () => {
    const picked = selectAdapters(fakeAdapters, 'grep-only');
    expect(picked.map(a => a.name)).toEqual(['grep-only']);
  });

  test('--queries validates its value', () => {
    expect(parseCliArgs(['--queries', 'tier5']).queries).toBe('tier5');
    expect(parseCliArgs(['--queries=relational']).queries).toBe('relational');
    expect(() => parseCliArgs(['--queries=bogus'])).toThrow(/--queries must be one of/);
  });
});

// ─── orchestrators-12: BRAINBENCH_N guard ─────────────────────────────

describe('resolveRunsPerAdapter (audit orchestrators-12)', () => {
  test('unset defaults to 5', () => {
    expect(resolveRunsPerAdapter(undefined)).toBe(5);
  });

  test('valid integers pass through; floats floor', () => {
    expect(resolveRunsPerAdapter('1')).toBe(1);
    expect(resolveRunsPerAdapter('10')).toBe(10);
    expect(resolveRunsPerAdapter('2.7')).toBe(2);
  });

  test('empty string (Number("") === 0) falls back to 5 instead of zero runs', () => {
    expect(resolveRunsPerAdapter('')).toBe(5);
  });

  test('zero, negatives and garbage fall back to 5', () => {
    expect(resolveRunsPerAdapter('0')).toBe(5);
    expect(resolveRunsPerAdapter('-3')).toBe(5);
    expect(resolveRunsPerAdapter('garbage')).toBe(5);
    expect(resolveRunsPerAdapter('NaN')).toBe(5);
  });
});

// ─── orchestrators-15: shared relational builder ──────────────────────

describe('relational query builder is shared and complete (audit orchestrators-15)', () => {
  test('buildRelationalQueries emits all 4 template families', () => {
    const queries = buildRelationalQueries(templateCorpus());
    const texts = queries.map(q => q.text).sort();
    expect(texts).toEqual([
      'Who advises Rocketry Labs?',
      'Who attended Q1 Quantum Offsite?',
      'Who invested in Rocketry Labs?',
      'Who works at Rocketry Labs?',
    ]);
    const bySlug = new Map(queries.map(q => [q.text, q.gold.relevant]));
    expect(bySlug.get('Who invested in Rocketry Labs?')).toEqual(['people/cy-park']);
    expect(bySlug.get('Who advises Rocketry Labs?')).toEqual(['people/di-wolf']);
  });

  test('shootout-driver buildCellQueries(pages) === multi-adapter buildRelationalQueries(pages)', () => {
    const pages = templateCorpus();
    expect(buildCellQueries(pages, undefined)).toEqual(buildRelationalQueries(pages));
  });

  test('loadWorldCorpus sorts shard filenames for deterministic ids', () => {
    const pages = templateCorpus();
    const dir = writeCorpusDir(pages);
    const loaded = loadWorldCorpus(dir);
    expect(loaded.map(p => p.slug)).toEqual([...pages].sort((a, b) =>
      a.slug.replace('/', '__') < b.slug.replace('/', '__') ? -1 : 1).map(p => p.slug));
  });
});

// ─── adapters-queries-07: tier families wired into multi-adapter ─────

describe('collectFamilies / familiesForAdapter (audit adapters-queries-07)', () => {
  test('"all" yields relational + fuzzy + externally-authored with 80 tier queries accounted for', () => {
    const fams = collectFamilies(templateCorpus(), 'all');
    expect(fams.map(f => f.family)).toEqual(['relational', 'fuzzy', 'externally-authored']);
    const fuzzy = fams.find(f => f.family === 'fuzzy')!;
    const ext = fams.find(f => f.family === 'externally-authored')!;
    // Every authored query is either scored or explicitly excluded — none vanish.
    expect(fuzzy.queries.length + fuzzy.excluded_no_gold.length).toBe(30);
    expect(ext.queries.length + ext.excluded_no_gold.length).toBe(50);
    // Empty-gold items (abstention etc.) are excluded per the NaN contract, not zeroed.
    expect(fuzzy.excluded_no_gold).toContain('q5-0005');
    expect(fuzzy.excluded_no_gold).not.toContain('q5-0004'); // has real gold now
    expect(ext.excluded_no_gold).toContain('q55-0038');
    for (const f of fams) {
      for (const q of f.queries) expect((q.gold.relevant ?? []).length).toBeGreaterThan(0);
    }
  });

  test('scoped sources work: tier5 only', () => {
    const fams = collectFamilies(templateCorpus(), 'tier5');
    expect(fams.map(f => f.family)).toEqual(['fuzzy']);
  });

  test('the inline gbrain wrapper only gets the relational family (no fake 0% fuzzy rows)', () => {
    const fams = collectFamilies(templateCorpus(), 'all');
    expect(familiesForAdapter('gbrain', fams).map(f => f.family)).toEqual(['relational']);
    expect(familiesForAdapter('grep-only', fams).map(f => f.family)).toEqual([
      'relational', 'fuzzy', 'externally-authored',
    ]);
  });
});

// ─── adapters-queries-03 / -08: vector adapter ────────────────────────

describe('VectorOnlyAdapter (audit adapters-queries-03 / -08)', () => {
  const pages: Page[] = templateCorpus().map(({ _facts, ...pub }) => pub as Page);

  test('state.embeddingModel is the real configured model, not undefined', async () => {
    await withEmbedSeam(async () => {
      const adapter: Adapter = new VectorOnlyAdapter();
      const state = await adapter.init(pages, { name: 'vector' });
      expect((state as { embeddingModel: string }).embeddingModel).toBe('openai:text-embedding-3-large');
      const results = await adapter.query({ id: 'q1', text: 'quantum propulsion founder' }, state);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].rank).toBe(1);
    });
  }, 60_000);

  test('gateway reconfiguration between init and query fails LOUD (dim mismatch), never truncates', async () => {
    await withEmbedSeam(async () => {
      const gw = await import('gbrain/ai/gateway');
      const adapter: Adapter = new VectorOnlyAdapter();
      const state = await adapter.init(pages, { name: 'vector' }); // 1536-dim space
      try {
        gw.configureGateway({
          embedding_model: 'openai:text-embedding-3-small',
          embedding_dimensions: 64,
          env: process.env as Record<string, string | undefined>,
        });
        await expect(adapter.query({ id: 'q2', text: 'quantum propulsion founder' }, state))
          .rejects.toThrow(/dimension mismatch/);
      } finally {
        // Bun runs test files in one process: don't leak the 64-dim config
        // into later suites that assume the 1536-dim default.
        gw.configureGateway({
          embedding_model: 'openai:text-embedding-3-large',
          embedding_dimensions: 1536,
          env: process.env as Record<string, string | undefined>,
        });
      }
    });
  }, 60_000);

  test('cosine helper throws on mismatched widths (CI anchor for the unit test)', () => {
    expect(() => _cosine(new Float32Array([1, 2, 3]), new Float32Array([1, 2]))).toThrow(/dimension mismatch/);
    expect(_cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1);
  });
});

// ─── adapters-queries-04: hybrid limit knob ───────────────────────────

describe('HybridNoGraphAdapter honors config.limit (audit adapters-queries-04)', () => {
  test('limit: 2 caps query() output; default returns more on a broad query', async () => {
    await withEmbedSeam(async () => {
      const pages: Page[] = templateCorpus().map(({ _facts, ...pub }) => pub as Page);
      // All 6 fixture pages mention "quantum" → a broad query matches all.
      const q = { id: 'q-broad', text: 'quantum' };

      const capped: Adapter = new HybridNoGraphAdapter();
      const cappedState = await capped.init(pages, { name: 'vector-grep-rrf-fusion', limit: 2 });
      const cappedResults = await capped.query(q, cappedState);
      await capped.teardown?.(cappedState);
      expect(cappedResults.length).toBe(2);

      const dflt: Adapter = new HybridNoGraphAdapter();
      const dfltState = await dflt.init(pages, { name: 'vector-grep-rrf-fusion' });
      const dfltResults = await dflt.query(q, dfltState);
      await dflt.teardown?.(dfltState);
      expect(dfltResults.length).toBeGreaterThan(2);
    });
  }, 240_000);
});

// ─── E2E: multi-adapter subprocess (grep-only, hermetic) ─────────────

describe('multi-adapter end-to-end (grep-only, BRAINBENCH_N=1)', () => {
  test('space-form --adapter scopes the run, tier families execute, WS0 receipt lands', () => {
    const receiptFile = join(sandbox, 'multi-adapter-receipt.json');
    const res = spawnSync('bun', [
      'eval/runner/multi-adapter.ts',
      '--adapter', 'grep-only',
      '--json',
      '--receipt-path', receiptFile,
    ], {
      cwd: REPO,
      env: { ...process.env, BRAINBENCH_N: '1' },
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);

    // Space form scoped the run: only grep-only rows (the old parser ignored
    // the space form and ran all four adapters, audit orchestrators-11).
    const adapters = new Set(out.scorecards.map((s: { adapter: string }) => s.adapter));
    expect([...adapters]).toEqual(['grep-only']);

    // Tier 5/5.5 actually executed as families (audit adapters-queries-07).
    const families = out.scorecards.map((s: { family: string }) => s.family).sort();
    expect(families).toEqual(['externally-authored', 'fuzzy', 'relational']);
    const fuzzyFam = out.families.find((f: { family: string }) => f.family === 'fuzzy');
    expect(fuzzyFam.scored + fuzzyFam.excluded_no_gold.length).toBe(30);

    // Scores are real numbers (grep-only lands hits on the world corpus).
    for (const sc of out.scorecards) {
      expect(sc.runs).toBe(1);
      expect(sc.mean_recall_at_k).toBeGreaterThan(0);
      expect(sc.mean_recall_at_k).toBeLessThanOrEqual(1);
    }

    // WS0 receipt: validated by loadReceipt, honest accounting.
    expect(existsSync(receiptFile)).toBe(true);
    const receipt = loadReceipt(receiptFile);
    expect(receipt.category).toBe('multi-adapter');
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('pass');
    const expectedScored = out.families.reduce((a: number, f: { scored: number }) => a + f.scored, 0);
    expect(receipt.n_total).toBe(expectedScored); // 1 adapter x gold-bearing queries
    expect(receipt.n_scored).toBe(expectedScored);
    expect(receipt.gbrain_version).not.toBe('unknown');
    expect(receipt.gbrain_pin).not.toBe('unknown');
  }, 240_000);

  test('unknown --adapter exits non-zero with the available list', () => {
    const res = spawnSync('bun', ['eval/runner/multi-adapter.ts', '--adapter=bogus'], {
      cwd: REPO,
      env: { ...process.env, BRAINBENCH_N: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('No adapter named "bogus"');
  }, 60_000);
});

// ─── E2E: shootout-driver runCell (hermetic, tiny corpus) ────────────

describe('shootout-driver runCell (shared relational set + receipts)', () => {
  test('relational cell scores the full 4-template set and writes both receipts', async () => {
    await withEmbedSeam(async () => {
      const pages = templateCorpus();
      const corpusDir = writeCorpusDir(pages);
      const outputFile = join(sandbox, 'cell-A0.json');
      const receiptFile = join(sandbox, 'shootout-receipt.json');

      const cell = await runCell({
        help: false,
        embedder: 'openai:text-embedding-3-large',
        dim: 64,
        cell: 'A0',
        corpus: corpusDir,
        output: outputFile,
        receiptPathOverride: receiptFile,
      });

      // The old private builder emitted only attended + works_at (2 queries
      // on this corpus); the shared builder emits all 4 templates.
      expect(cell.queries).toBe(4);
      expect(cell.query_set).toContain('relational');
      expect(cell.query_set).toContain('queries/relational.ts');
      expect(cell.gbrain_version).not.toBe('unknown');
      expect(cell.mean_recall_at_k).toBeGreaterThan(0);

      const written = JSON.parse(readFileSync(outputFile, 'utf8'));
      expect(written.queries).toBe(4);
      expect(written.cell).toBe('A0');

      const receipt = loadReceipt(receiptFile);
      expect(receipt.category).toBe('shootout-driver');
      expect(receipt.run_status).toBe('completed');
      expect(receipt.verdict).toBe('pass');
      expect(receipt.n_total).toBe(4);
      expect(receipt.n_scored).toBe(4);
      expect(receipt.resolved_config?.relational_builder).toContain('queries/relational.ts');
    });
  }, 240_000);
});

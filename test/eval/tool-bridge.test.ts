/**
 * tool-bridge.ts tests — Day 4 of BrainBench v1 Complete.
 *
 * Covers:
 *   - Tool-def generation for 12 read ops + 3 dry_run tools (snapshot shape)
 *   - `query` tool strips `expand` from its input schema AND executor forces expand=false
 *   - Mutating ops (put_page, add_link, etc.) throw ForbiddenOpError
 *   - Unknown tools throw UnknownToolError
 *   - 32K char cap truncates with "…[truncated]" marker
 *   - Poison fixtures matched by slug in result content
 *   - Dry-run tools record intent without mutating engine
 *   - Dry-run put_page detects back-links in compiled_truth
 *   - Dry-run add_timeline_entry validates date + source format
 *   - count_by_tool and call_order reflect trace
 */

import { describe, test, expect } from 'bun:test';
import {
  buildToolDefs,
  createToolBridge,
  sanitizeToolInput,
  EXPOSED_READ_TOOLS,
  DRY_RUN_TOOLS,
  ForbiddenOpError,
  UnknownToolError,
  type ToolBridgeConfig,
  type PoisonFixture,
} from '../../eval/runner/tool-bridge.ts';
import type { BrainEngine } from 'gbrain/engine';

// ─── Fake engine — records op calls so tests can assert dispatch ──

type CallLog = Array<{ method: string; args: unknown[] }>;

function makeFakeEngine(responses: Record<string, unknown> = {}): {
  engine: BrainEngine;
  calls: CallLog;
} {
  const calls: CallLog = [];
  const engine = new Proxy(
    {},
    {
      get(_target, prop: string) {
        // Return an async function for any property access.
        // Key lookup priority: exact method name > __default__ > []
        return async (...args: unknown[]) => {
          calls.push({ method: prop, args });
          if (prop in responses) return responses[prop];
          if ('__default__' in responses) return responses.__default__;
          // gbrain's alias hop (v0.46+) expects a Map from resolveAliases
          // and dereferences .get() outside its try/catch — an array here
          // crashes real hybridSearch paths exercised through the bridge.
          if (prop === 'resolveAliases') return new Map();
          return [];
        };
      },
    },
  ) as unknown as BrainEngine;
  return { engine, calls };
}

const SAMPLE_POISON: PoisonFixture[] = [
  { fixture_id: 'poison-001', slug: 'emails/em-0045', kind: 'prompt-injection' },
  { fixture_id: 'poison-002', slug: 'slack/sl-0178', kind: 'obviously-false' },
  { fixture_id: 'poison-003', slug: 'notes/2026-03-fake', kind: 'encoded-directive' },
];

function cfg(engine: BrainEngine, poison: PoisonFixture[] = SAMPLE_POISON): ToolBridgeConfig {
  return { engine, poisonFixtures: poison };
}

// ─── Tool-def generation ──────────────────────────────────────────────

describe('buildToolDefs — shape + contract', () => {
  const defs = buildToolDefs();

  test('generates exactly 15 tools (12 read + 3 dry_run)', () => {
    expect(defs.length).toBe(15);
  });

  test('first 12 are the canonical read ops in EXPOSED_READ_TOOLS order', () => {
    const names = defs.slice(0, 12).map(d => d.name);
    expect(names).toEqual([...EXPOSED_READ_TOOLS]);
  });

  test('last 3 are the dry_run tools in DRY_RUN_TOOLS order', () => {
    const names = defs.slice(12).map(d => d.name);
    expect(names).toEqual([...DRY_RUN_TOOLS]);
  });

  test('every def has name, description, input_schema.type=object', () => {
    for (const def of defs) {
      expect(typeof def.name).toBe('string');
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe('string');
      expect(def.input_schema.type).toBe('object');
      expect(typeof def.input_schema.properties).toBe('object');
    }
  });

  test('query tool does NOT include `expand` in its input schema', () => {
    const queryDef = defs.find(d => d.name === 'query');
    expect(queryDef).toBeDefined();
    expect('expand' in (queryDef?.input_schema.properties ?? {})).toBe(false);
  });

  test('query tool still includes the core params (query, limit, detail)', () => {
    const queryDef = defs.find(d => d.name === 'query');
    expect(queryDef?.input_schema.properties.query).toBeDefined();
    expect(queryDef?.input_schema.properties.query.type).toBe('string');
    expect(queryDef?.input_schema.properties.limit).toBeDefined();
  });

  test('dry_run_put_page requires slug, title, compiled_truth', () => {
    const def = defs.find(d => d.name === 'dry_run_put_page');
    expect(def?.input_schema.required).toEqual(['slug', 'title', 'compiled_truth']);
  });

  test('dry_run_add_link requires from, to, type', () => {
    const def = defs.find(d => d.name === 'dry_run_add_link');
    expect(def?.input_schema.required).toEqual(['from', 'to', 'type']);
  });

  test('dry_run_add_timeline_entry requires slug, date, summary', () => {
    const def = defs.find(d => d.name === 'dry_run_add_timeline_entry');
    expect(def?.input_schema.required).toEqual(['slug', 'date', 'summary']);
  });
});

// ─── executeTool dispatch + enforcement ──────────────────────────────

describe('executeTool — read ops', () => {
  test('dispatches a known read op to the engine', async () => {
    const { engine, calls } = makeFakeEngine({ getPage: { slug: 'people/amara', title: 'Amara' } });
    const bridge = createToolBridge(cfg(engine));
    const res = await bridge.executeTool('get_page', { slug: 'people/amara' });
    expect(res.truncated).toBe(false);
    expect(res.content).toContain('Amara');
    // The real dispatch goes through operations.ts handlers, so we can't assert the
    // exact engine method name. But we can assert the bridge updated its state.
    expect(bridge.state.count_by_tool['get_page']).toBe(1);
    expect(bridge.state.call_order).toEqual(['get_page']);
    void calls;
  });

  test('forces expand=false on query tool even if agent passes expand=true', async () => {
    // The falsifiable assertion: the sanitizing seam itself. Remove the
    // guard in sanitizeToolInput and this fails (audit tests-audit-03 — the
    // old version asserted only call_order, which passed either way).
    expect(sanitizeToolInput('query', { query: 'who is amara', expand: true })).toEqual({
      query: 'who is amara',
      expand: false,
    });
    // Non-query tools pass through untouched.
    expect(sanitizeToolInput('get_page', { slug: 'x', expand: true })).toEqual({
      slug: 'x',
      expand: true,
    });
    // And the integration path still runs end-to-end with the guard applied.
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('query', { query: 'who is amara', expand: true });
    expect(bridge.state.call_order).toEqual(['query']);
    expect(bridge.state.count_by_tool['query']).toBe(1);
  });

  test('throws ForbiddenOpError for mutating ops (put_page)', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    let err: unknown = null;
    try {
      await bridge.executeTool('put_page', { slug: 'x/y', type: 'person', title: 't', compiled_truth: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenOpError);
    expect((err as Error).message).toMatch(/mutating/);
  });

  test('throws ForbiddenOpError for add_link (mutating)', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    let err: unknown = null;
    try {
      await bridge.executeTool('add_link', { from: 'x/y', to: 'a/b', type: 'mentions' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenOpError);
  });

  test('throws UnknownToolError for completely unknown tool', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    let err: unknown = null;
    try {
      await bridge.executeTool('does_not_exist', {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownToolError);
  });
});

// ─── Truncation ──────────────────────────────────────────────────────

describe('executeTool — 32K token cap', () => {
  test('truncates oversized tool results with "…[truncated]" marker', async () => {
    const huge = 'a'.repeat(200_000); // ~50K tokens
    const { engine } = makeFakeEngine({ getPage: { slug: 'x', body: huge } });
    const bridge = createToolBridge(cfg(engine));
    const res = await bridge.executeTool('get_page', { slug: 'x' });
    expect(res.truncated).toBe(true);
    expect(res.content.endsWith('…[truncated]')).toBe(true);
    expect(res.content.length).toBeLessThanOrEqual(32768 * 4);
  });

  test('does not truncate normal-sized results', async () => {
    const { engine } = makeFakeEngine({ getPage: { slug: 'x', body: 'short body' } });
    const bridge = createToolBridge(cfg(engine));
    const res = await bridge.executeTool('get_page', { slug: 'x' });
    expect(res.truncated).toBe(false);
    expect(res.content.endsWith('…[truncated]')).toBe(false);
  });

  test('respects custom maxCharsPerResult', async () => {
    const { engine } = makeFakeEngine({ getPage: { slug: 'x', body: 'x'.repeat(500) } });
    const bridge = createToolBridge({ ...cfg(engine), maxCharsPerResult: 100 });
    const res = await bridge.executeTool('get_page', { slug: 'x' });
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBeLessThanOrEqual(100);
  });
});

// ─── Poison matching ─────────────────────────────────────────────────

describe('executeTool — poison slug matching', () => {
  // Poison matching uses get_page (simpler: returns raw page object without dedup).
  // The fake engine's __default__ pattern returns the same response for any method.

  test('flags poison fixture when its slug appears in result content', async () => {
    const { engine } = makeFakeEngine({
      __default__: { slug: 'emails/em-0045', title: 'Suspicious', compiled_truth: 'body' },
    });
    const bridge = createToolBridge(cfg(engine));
    const res = await bridge.executeTool('get_page', { slug: 'emails/em-0045' });
    expect(res.matched_poison_fixture_ids).toContain('poison-001');
    expect(bridge.state.saw_poison_items).toContain('poison-001');
  });

  test('does not false-positive on partial slug prefixes', async () => {
    // poison-001 slug is "emails/em-0045". Result contains "emails/em-00450" — no match.
    const { engine } = makeFakeEngine({
      __default__: { slug: 'emails/em-00450', title: 'longer' },
    });
    const bridge = createToolBridge(cfg(engine));
    const res = await bridge.executeTool('get_page', { slug: 'emails/em-00450' });
    expect(res.matched_poison_fixture_ids).not.toContain('poison-001');
  });

  test('multiple poison fixtures in one result all flagged', async () => {
    const { engine } = makeFakeEngine({
      __default__: {
        items: [
          { slug: 'emails/em-0045' },
          { slug: 'slack/sl-0178' },
        ],
      },
    });
    const bridge = createToolBridge(cfg(engine));
    const res = await bridge.executeTool('get_page', { slug: 'x/y' });
    expect(res.matched_poison_fixture_ids).toContain('poison-001');
    expect(res.matched_poison_fixture_ids).toContain('poison-002');
  });

  test('state.saw_poison_items deduplicates across calls', async () => {
    const { engine } = makeFakeEngine({
      __default__: { slug: 'emails/em-0045' },
    });
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('get_page', { slug: 'a' });
    await bridge.executeTool('get_page', { slug: 'b' });
    expect(bridge.state.saw_poison_items).toEqual(['poison-001']);
  });
});

// ─── Dry-run tools ───────────────────────────────────────────────────

describe('executeTool — dry_run tools', () => {
  test('dry_run_put_page records intent, does not hit engine', async () => {
    const { engine, calls } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    const res = await bridge.executeTool('dry_run_put_page', {
      slug: 'people/jane',
      title: 'Jane',
      compiled_truth: 'Jane works with [Bob](people/bob).',
      timeline: '',
    });
    expect(res.content).toContain('recorded');
    expect(calls.length).toBe(0); // engine untouched
    expect(bridge.state.made_dry_run_writes.length).toBe(1);
    const write = bridge.state.made_dry_run_writes[0];
    expect(write.tool_name).toBe('dry_run_put_page');
    expect(write.slug).toBe('people/jane');
    expect(write.has_back_links).toBe(true);
    expect(write.citation_format_ok).toBe(true);
  });

  test('dry_run_put_page detects missing back-links', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('dry_run_put_page', {
      slug: 'people/jane',
      title: 'Jane',
      compiled_truth: 'Jane is a cool person. No links here.',
      timeline: '',
    });
    const write = bridge.state.made_dry_run_writes[0];
    expect(write.has_back_links).toBe(false);
  });

  test('dry_run_put_page validates timeline citation format', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('dry_run_put_page', {
      slug: 'people/jane',
      title: 'Jane',
      compiled_truth: 'Body.',
      timeline: '- **2026-04-20** | emails/em-0001 — Joined Halfway Capital',
    });
    const write = bridge.state.made_dry_run_writes[0];
    expect(write.citation_format_ok).toBe(true);
  });

  test('dry_run_put_page flags malformed timeline citation', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('dry_run_put_page', {
      slug: 'people/jane',
      title: 'Jane',
      compiled_truth: 'Body.',
      timeline: '- Joined sometime recently.', // missing date + source + dash
    });
    const write = bridge.state.made_dry_run_writes[0];
    expect(write.citation_format_ok).toBe(false);
  });

  test('dry_run_add_link records intent', async () => {
    const { engine, calls } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('dry_run_add_link', {
      from: 'people/jane',
      to: 'companies/halfway',
      type: 'works_at',
    });
    expect(calls.length).toBe(0);
    expect(bridge.state.made_dry_run_writes[0].tool_name).toBe('dry_run_add_link');
  });

  test('dry_run_add_timeline_entry validates date format', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('dry_run_add_timeline_entry', {
      slug: 'people/jane',
      date: '2026-04-20',
      summary: 'First meeting',
      source: 'meeting/mtg-0001',
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(true);
  });

  test('dry_run_add_timeline_entry rejects bad date format', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('dry_run_add_timeline_entry', {
      slug: 'people/jane',
      date: '04/20/2026', // wrong format
      summary: 'x',
      source: 's',
    });
    expect(bridge.state.made_dry_run_writes[0].citation_format_ok).toBe(false);
  });
});

// ─── State tracking ──────────────────────────────────────────────────

describe('tool-bridge state tracking', () => {
  test('count_by_tool + call_order reflect every invocation in order', async () => {
    const { engine } = makeFakeEngine({
      search: [],
      get_page: { slug: 'x' },
      list_pages: [],
    });
    const bridge = createToolBridge(cfg(engine));
    await bridge.executeTool('search', { query: 'a' });
    await bridge.executeTool('get_page', { slug: 'x' });
    await bridge.executeTool('search', { query: 'b' });
    await bridge.executeTool('list_pages', { limit: 10 });
    expect(bridge.state.call_order).toEqual(['search', 'get_page', 'search', 'list_pages']);
    expect(bridge.state.count_by_tool).toEqual({ search: 2, get_page: 1, list_pages: 1 });
  });

  test('failed calls (ForbiddenOpError) still count — attempted call is still trace data', async () => {
    const { engine } = makeFakeEngine();
    const bridge = createToolBridge(cfg(engine));
    try {
      await bridge.executeTool('put_page', { slug: 'x/y', type: 'person', title: 't', compiled_truth: '' });
    } catch {}
    // The call registered before the error was thrown.
    expect(bridge.state.call_order).toEqual(['put_page']);
    expect(bridge.state.count_by_tool['put_page']).toBe(1);
  });
});

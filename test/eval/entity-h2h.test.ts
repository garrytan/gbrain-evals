/**
 * Entity-resolution head-to-head smokes (eval/runner/entity-h2h/): the readout from entity nodes, its scoring, the
 * matcher's blocking, verdicts and request shape, the proxy's cache-token log fields and the shims' optional
 * GET /entities route. Keyless: provider keys are blanked and every model call goes to a stub fetch, never a network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateLedger, parseWrittenPage, renderPage } from '../../eval/generators/person-dedupe-gen.ts';
import { ask, blockPairs, blockingKeys, pairPrompt, verdictOf } from '../../eval/runner/entity-h2h/matcher.ts';
import { nameMatch, opaque, parseReadout, readoutFromEntities, scoreReadout, smokePages, subjectOf, usageByKey, type EntityNode } from '../../eval/runner/entity-h2h/world.ts';
import { cacheSplit } from '../../eval/runner/metering-proxy.ts';

const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PARTICLE_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) { saved[k] = process.env[k]; process.env[k] = ''; } });
afterAll(() => { for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const ledger = generateLedger(20261117, 2);
const pages = smokePages(ledger, '/nonexistent-world');
const node = (id: string, name: string, sources: string[], type: string | null = 'Person'): EntityNode => ({ id, name, type, source_ids: sources, provenance_status: 'exact' });
const meta = { system: 'test', version: '0', config: {}, model: 'none' };

describe('entity-h2h smoke world and readout', () => {
  test('the smoke world is instance 0 of every family, and each designed pair has both pages in it', () => {
    const keys = new Set(pages.map(p => p.key));
    expect(pages.length).toBe(ledger.pages.filter(p => p.instance === 0).length);
    for (const pair of ledger.pairs.filter(p => p.instance === 0)) expect(keys.has(pair.a) && keys.has(pair.b)).toBe(true);
    expect(opaque('ns', 'x')).toMatch(/^ns-[0-9a-f]{16}$/);
    expect(opaque('src', 'x', 'a')).not.toBe(opaque('src', 'x', 'b'));
  });

  test('a page subject is the best title match among the nodes its source mentions', () => {
    expect(nameMatch('Omar Brandt', 'omar brandt')).toBe(3);
    expect(nameMatch('Robert Bly', 'R. Bly')).toBe(2);
    expect(subjectOf('Omar Brandt', [node('a', 'Orchid Retail', ['s'], 'Organization'), node('b', 'Omar Brandt', ['s'])])!.node.id).toBe('b');
    expect(subjectOf('Omar Brandt', [node('a', 'Porto', ['s'], 'Location')])).toBeNull();
  });

  test('pages whose subjects share a node form an auto group; a proposed link adds a review group', () => {
    const [p1, p2, p3] = pages;
    const src = new Map([p1, p2, p3].map(p => [p.key, opaque('src', 't', p.key)]));
    const { readout, subjects } = readoutFromEntities([p1, p2, p3], src, {
      entities: [node('n1', p1.title, [src.get(p1.key)!, src.get(p2.key)!]), node('n2', p2.title, [src.get(p2.key)!]), node('n3', p3.title, [src.get(p3.key)!])],
      links: [{ a: 'n1', b: 'n3', kind: 'SAME_AS', tier: 'proposed', score: 0.7 }],
    }, meta);
    expect(subjects.every(s => s.node)).toBe(true);
    const auto = p1.title === p2.title ? [[p1.key, p2.key].sort()] : [];
    expect(readout.tiers.auto).toEqual(auto);
    expect(readout.tiers.proposed.length).toBe(1);
    expect(parseReadout(readout, new Set(pages.map(p => p.key)))).toBe(readout);
  });

  test('usage totals count only the rows a run wrote, not an earlier probe on the same log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entity-h2h-usage-'));
    const log = join(dir, 'usage.ndjson');
    const row = (at: string, usd: number) => JSON.stringify({ at, key: 'work:a', provider: 'openai', model: 'm', outcome: 'forwarded', actual_usd: usd, input_tokens: 10, output_tokens: 2, cache_read_tokens: 4 });
    writeFileSync(log, [row('2026-11-18T00:00:00.000Z', 1), row('2026-11-18T00:05:00.000Z', 0.5)].join('\n') + '\n');
    expect(usageByKey(log).get('work:a')!.usd).toBe(1.5);
    const t = usageByKey(log, () => true, '2026-11-18T00:01:00.000Z').get('work:a')!;
    expect([t.calls, t.usd, t.input, t.cached, t.output]).toEqual([1, 0.5, 10, 4, 2]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a readout that groups a designed different-people pair scores a false merge; an unknown page is refused', () => {
    const diff = ledger.pairs.find(p => p.instance === 0 && p.label === 'different')!;
    const s = scoreReadout(ledger, pages, { ...meta, tiers: { auto: [[diff.a, diff.b]], proposed: [] } });
    expect(s.auto.false_merge.k).toBe(1);
    expect(s['auto+proposed'].false_merge.k).toBe(1);
    expect(scoreReadout(ledger, pages, { ...meta, tiers: { auto: [], proposed: [[diff.a, diff.b]] } }).auto.false_merge.k).toBe(0);
    expect(() => scoreReadout(ledger, pages, { ...meta, tiers: { auto: [['work:nobody', diff.a]], proposed: [] } })).toThrow(/does not have/);
    expect(() => parseReadout({ ...meta, tiers: { auto: [] } }, new Set())).toThrow(/exactly auto and proposed/);
  });
});

describe('entity-h2h LLM matcher', () => {
  const written = ledger.pages.filter(p => p.instance === 0).map(p => parseWrittenPage(p.source, p.slug, renderPage(p)));

  test('blocking pairs pages that share a key and drops crowded keys', () => {
    const { pairs } = blockPairs(written);
    const same = ledger.pairs.filter(p => p.instance === 0 && p.family === 'same-exact').map(p => [p.a, p.b].sort().join('|'));
    const ids = new Set(pairs.map(p => p.join('|')));
    for (const s of same) expect(ids.has(s)).toBe(true);
    expect(blockPairs(written, 1).pairs.length).toBe(0);
    expect(blockingKeys({ ...written[0], emails: ['A@X.example'] })).toContain('domain:x.example');
    expect(blockingKeys(written[0], false).some(k => k.startsWith('name:'))).toBe(false);
  });

  test('verdicts come from the first word only', () => {
    expect(verdictOf('Yes. Same email.')).toBe('yes');
    expect(verdictOf('**No** - different cities')).toBe('no');
    expect(verdictOf('unsure, too little to go on')).toBe('unsure');
    expect(verdictOf('Probably yes')).toBeNull();
  });

  test('each model call goes to its proxy slot with a placeholder key, never a provider host or a real key', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      const anthropic = String(url).includes('/anthropic/');
      return Response.json(anthropic ? { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'no - x' }], usage: { input_tokens: 10, output_tokens: 3 } }
        : { model: 'm', choices: [{ message: { content: 'yes - y' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    }) as typeof fetch;
    const prompt = pairPrompt('A', 'B');
    for (const model of ['openai:gpt-6.2-sol', 'anthropic:claude-opus-5-5', 'particle:particle-1']) {
      const r = await ask(model, prompt, 'http://127.0.0.1:9', 'matcher-x', fake);
      expect(r.usage!.input_total).toBe(10);
    }
    expect(seen.map(s => new URL(s.url).pathname)).toEqual(['/matcher-x/openai/v1/chat/completions', '/matcher-x/anthropic/v1/messages', '/matcher-x/particle/v1/chat/completions']);
    for (const s of seen) {
      expect(new URL(s.url).hostname).toBe('127.0.0.1');
      expect(JSON.stringify(s.headers)).toContain('dummy-key-the-proxy-injects-the-real-one');
      expect(s.body.messages[0].content).toContain('Page A:\nA');
    }
    expect(seen[0].body.reasoning_effort).toBeUndefined();
    expect(seen[2].body.reasoning_effort).toBe('high');
    await expect(ask('voyage:x', prompt, 'http://127.0.0.1:9', 's', fake)).rejects.toThrow(/no route/);
  });
});

describe('metering proxy cache fields', () => {
  test('cache reads and writes are logged only when reported', () => {
    expect(cacheSplit({ usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } } })).toEqual({ cache_read_tokens: 40, cache_write_tokens: 10 });
    expect(cacheSplit({ usage: { input_tokens: 5, cache_read_input_tokens: 7 } })).toEqual({ cache_read_tokens: 7 });
    expect(cacheSplit({ usage: { prompt_tokens: 5 } })).toEqual({});
    expect(cacheSplit(null)).toEqual({});
  });
});

describe('shim base: optional GET /entities', () => {
  test('routes to the adapter, checks the namespace and defaults to unsupported', () => {
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(resolve(import.meta.dir, '../../eval/systems/_shim'))})`,
      'from shim import Adapter, dispatch',
      'class A(Adapter):',
      '    def entities(self, ns): return {"entities": [{"id": "n", "name": ns}], "links": []}',
      'print(json.dumps([dispatch(A(), "GET", "/entities?ns=ns-0123456789abcdef", {})[0], dispatch(A(), "GET", "/entities?ns=bad", {})[0], dispatch(Adapter(), "GET", "/entities?ns=ns-0123456789abcdef", {})[1]["error"]["kind"]]))',
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([200, 400, 'unsupported']);
  });
});

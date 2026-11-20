/**
 * Entity-dedupe head-to-head (eval/runner/entity-h2h/), keyless units: the world and its ingest order, the frozen
 * blocker against the preregistration's counts, the scorer's closure and "not a candidate" counts, the matcher's
 * request shape, safety-filter and budget outcomes and resume plan, the memory readout, held-out-only labels, the dry
 * run, the stable refusals (person-dedupe's included), the classic records parser's imports and the shim's optional
 * GET /entities. Provider keys are blanked and every model call goes to a stub fetch, never a network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateCompanyLedger } from '../../eval/generators/company-dedupe-gen.ts';
import { generateLedger } from '../../eval/generators/person-dedupe-gen.ts';
import { cacheSplit } from '../../eval/runner/metering-proxy.ts';
import { checkFinderCoverage, writeWorld } from '../../eval/runner/person-dedupe.ts';
import { RunnerRefusal } from '../../eval/runner/runner-refusal.ts';
import { MAX_BLOCK_PAGES, blockPairs, blockingKeys, pairId } from '../../eval/runner/entity-h2h/blocker.ts';
import { ask, matcherPrompt, pairBrain, pairPrompt, planPairs, verdictOf, type CallEvent } from '../../eval/runner/entity-h2h/matcher.ts';
import { MEMORY_KINDS, TUNING_SETTINGS, matcherStop, memoryStop } from '../../eval/runner/entity-h2h/rates.ts';
import { applyRule, distanceOf, tuningOf, type Candidate } from '../../eval/runner/entity-h2h/tuning.ts';
import { cli, dryRun } from '../../eval/runner/entity-h2h/run.ts';
import { parseOutput, scoreOutput } from '../../eval/runner/entity-h2h/score.ts';
import { DEV_SEED, HELD_OUT_SEED, buildWorld, heldOutLabels, ingestOrder, loadWorld, nameMatch, opaque, readoutFromEntities, subjectOf, usageByKey, writeH2hWorld, type EntityNode } from '../../eval/runner/entity-h2h/world.ts';

const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PARTICLE_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) { saved[k] = process.env[k]; process.env[k] = ''; } });
afterAll(() => { for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const tmp = mkdtempSync(join(tmpdir(), 'entity-h2h-'));
const small = buildWorld(7, 1);
const known = new Set(small.pages.map(p => p.key));
const quiet = () => {};

describe('world', () => {
  test('a written world loads back, and a used, stale or padded folder is refused', () => {
    const dir = join(tmp, 'w1');
    writeH2hWorld(dir, 7, 1);
    const w = loadWorld(dir);
    expect(w.pages.length).toBe(small.pages.length);
    expect(w.pages.some(p => p.type === 'company' && p.key.includes(':companies/'))).toBe(true);
    expect(() => writeH2hWorld(dir, 7, 1)).toThrow(/WORLD_DIR_USED.*entries_in_folder/);
    const page = join(dir, w.pages[0].file);
    const text = readFileSync(page, 'utf8');
    writeFileSync(page, text + 'x');
    expect(() => loadWorld(dir)).toThrow(/differ from what seed 7 renders/);
    writeFileSync(page, text);
    writeFileSync(join(dir, 'work', 'people', 'extra.md'), '---\ntitle: "x"\n---\n');
    expect(() => loadWorld(dir)).toThrow(/does not render/);
  });

  test('the ingest order is a fixed permutation drawn from the world seed', () => {
    const a = ingestOrder(small).map(p => p.key), b = ingestOrder(buildWorld(7, 1)).map(p => p.key);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...known].sort());
    expect(a).not.toEqual(small.pages.map(p => p.key));
    expect(ingestOrder(buildWorld(8, 1)).map(p => p.key)).not.toEqual(a);
  });

  // Value: protects=the re-smoke runs on the 2026-11-17 smoke's own world; fails_when=--smoke builds another ledger, page set or order, or a manifest drops its smoke flag and still loads
  test('the smoke world is the 2026-11-17 smoke world: version-1 people ledger 7db1e1f4, instance 0 of each family, ledger order', () => {
    const dir = join(tmp, 'smoke');
    const w = writeH2hWorld(dir, DEV_SEED, 2, true);
    expect([w.smoke, w.pages.length, w.companies.pages.length, w.people.generator_version]).toEqual([true, 69, 0, 1]);
    expect(w.fingerprints.people).toBe('7db1e1f4062f62c389a8fbee734fe3e05281392e78dd0673de018e536ff05ccb');
    expect(w.people.pages.every(p => p.instance === 0)).toBe(true);
    expect(w.pairs.every(p => w.gold.has(p.a) && w.gold.has(p.b))).toBe(true);
    const loaded = loadWorld(dir);
    expect(ingestOrder(loaded).map(p => p.key)).toEqual(loaded.pages.map(p => p.key));
    expect(buildWorld(DEV_SEED, 2).fingerprints.people).not.toBe(w.fingerprints.people);
    const m = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
    delete m.smoke;
    writeFileSync(join(dir, 'world.json'), JSON.stringify(m));
    expect(() => loadWorld(dir)).toThrow();
  });

  test('labels come only from the held-out seed', () => {
    expect(() => heldOutLabels(small)).toThrow(/only from held-out seed 20261118/);
    const h = heldOutLabels(buildWorld(HELD_OUT_SEED, 1));
    expect(h.seed).toBe(HELD_OUT_SEED);
    expect(Object.keys(h.entities).length).toBe(buildWorld(HELD_OUT_SEED, 1).pages.length);
  });
});

describe('frozen blocker', () => {
  // Value: protects=the preregistration's counts for the fixed blocker; fails_when=a key, the type split or the crowding rule changes; seam=blockPairs on the dev world
  test('at the development seed every page, founders included, is blocked, and its pairs and misses follow from the blocking keys', () => {
    const w = buildWorld(DEV_SEED, 20);
    const people = generateLedger(DEV_SEED, 20), companies = generateCompanyLedger(DEV_SEED, 20);
    expect(w.pages.length).toBe(people.pages.length + (companies.founders ?? []).length + companies.pages.length);
    const blocks = new Map<string, string[]>();
    for (const p of w.pages) for (const k of new Set(blockingKeys(p.written))) blocks.set(k, [...(blocks.get(k) ?? []), p.key]);
    const expected = new Set<string>();
    for (const keys of blocks.values()) if (keys.length <= MAX_BLOCK_PAGES) for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (keys[i] !== keys[j]) expected.add(pairId(keys[i], keys[j]));
    const b = blockPairs(w.pages.map(p => p.written));
    expect(b.pairs.length).toBe(expected.size);
    const byKey = (x: { key: string }, y: { key: string }) => (x.key < y.key ? -1 : 1);
    expect([...b.crowded].sort(byKey)).toEqual([...blocks].filter(([, ks]) => ks.length > MAX_BLOCK_PAGES).map(([key, ks]) => ({ key, pages: ks.length })).sort(byKey));
    const ids = new Set(b.pairs.map(([x, y]) => pairId(x, y)));
    expect(w.pairs.filter(p => !ids.has(pairId(p.a, p.b)))).toEqual(w.pairs.filter(p => !expected.has(pairId(p.a, p.b))));
    const type = new Map(w.pages.map(p => [p.key, p.type]));
    expect(w.pairs.filter(p => type.get(p.a) !== type.get(p.b)).every(p => !ids.has(pairId(p.a, p.b)))).toBe(true);
  });

  test('keys are typed, and a key on more than 50 pages is dropped and listed', () => {
    const p = small.pages.find(x => x.type === 'person')!.written, c = small.pages.find(x => x.type === 'company')!.written;
    expect(blockingKeys(p).every(k => k.startsWith('person|'))).toBe(true);
    expect(blockingKeys(p).some(k => k.startsWith('person|surname:'))).toBe(true);
    expect(blockingKeys(c).some(k => k.startsWith('company|core:'))).toBe(true);
    const crowd = Array.from({ length: MAX_BLOCK_PAGES + 1 }, (_, i) => ({ ...p, key: `work:x${i}`, title: `Ann Lee${i}`, emails: ['team@shared.example'], linkedin: null, github: null }));
    const b = blockPairs(crowd);
    expect(b.crowded).toEqual([{ key: 'person|email:team@shared.example', pages: 51 }]);
    expect(b.pairs.length).toBe(0);
  });
});

describe('scoring', () => {
  const same = small.pairs.find(p => p.label === 'same' && small.people_gold.has(p.a))!;
  const diff = small.pairs.find(p => p.label === 'different' && small.people_gold.has(p.a))!;
  const coSame = small.pairs.find(p => p.label === 'same' && small.company_gold.has(p.a))!;
  const out = { system: 'toy', version: '0', config: 'c', model: null, tiers: { auto: [[same.a, same.b]], proposed: [[diff.a, diff.b], [coSame.a, coSame.b]] } };

  test('auto and proposed are scored for people and companies, closed transitively', () => {
    const s = scoreOutput(small, parseOutput(out, known));
    expect(s.points.auto.person.false_merge.k).toBe(0);
    expect(s.points.auto.person.designed_recall.k).toBeGreaterThanOrEqual(1);
    expect(s.points.proposed.person.false_merge.k).toBeGreaterThanOrEqual(1);
    expect(s.points.proposed.company.designed_recall.k).toBeGreaterThanOrEqual(1);
    expect(s.points.auto.company.designed_recall.k).toBe(0);
    expect(s.points.auto.person.false_merge.n + s.points.auto.company.false_merge.n).toBe(small.pairs.filter(p => p.label === 'different').length);
    expect(s.not_a_candidate).toBeNull();
  });

  test('pairs the blocker never reached are counted and stay in every denominator', () => {
    const cands = new Set(small.pairs.filter(p => p !== same && p !== diff).map(p => pairId(p.a, p.b)));
    const s = scoreOutput(small, parseOutput(out, known), { candidates: cands, unresolved: ['x'] });
    expect(s.not_a_candidate!.person).toEqual({ must_link: 1, must_not_link: 1 });
    expect(s.not_a_candidate!.company).toEqual({ must_link: 0, must_not_link: 0 });
    expect(s.points.auto.person.designed_recall.n).toBe(small.pairs.filter(p => p.label === 'same' && small.people_gold.has(p.a)).length);
    expect(s.points.auto.person.designed_recall.k).toBeGreaterThanOrEqual(1);
    expect(s.unresolved).toBe(1);
  });

  test('refuses an output it cannot score exactly', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ ...out, extra: 1 }, /keys/], [{ ...out, tiers: { auto: [] } }, /exactly auto and proposed/], [{ ...out, model: '' }, /model/],
      [{ ...out, tiers: { auto: [['work:nobody', same.a]], proposed: [] } }, /does not have/], [{ ...out, tiers: { auto: [same.a], proposed: [] } }, /not a list/],
    ];
    for (const [raw, msg] of bad) expect(() => parseOutput(raw, known)).toThrow(msg);
  });
});

describe('matcher', () => {
  test('the prompt is the frozen file with both pages filled in', () => {
    const { template, sha256 } = matcherPrompt();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pairPrompt(template, 'AAA $& x', 'BBB')).toContain('Page A:\nAAA $& x\n\nPage B:\nBBB');
    expect(verdictOf('**Yes** - same')).toBe('yes');
    expect(verdictOf('Maybe')).toBeNull();
  });

  test('each call goes to its proxy slot with a placeholder key and its pair named, never to a provider host', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      return String(url).includes('/anthropic/') ? Response.json({ model: 'claude-opus-5-5', content: [{ type: 'text', text: 'no - x' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } })
        : Response.json({ model: 'm', choices: [{ message: { content: 'yes - y' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    }) as typeof fetch;
    for (const model of ['openai:gpt-6.2-sol', 'anthropic:claude-opus-5-5', 'particle:particle-1']) {
      const r = await ask(model, 'P', 'http://127.0.0.1:9', 'matcher-x', pairBrain('a', 'b'), fake);
      expect([r.outcome, r.usage!.input_total]).toEqual(['answer', 10]);
    }
    expect(seen.map(s => new URL(s.url).pathname)).toEqual(['/matcher-x/openai/v1/chat/completions', '/matcher-x/anthropic/v1/messages', '/matcher-x/particle/v1/chat/completions']);
    for (const s of seen) {
      expect(new URL(s.url).hostname).toBe('127.0.0.1');
      expect(JSON.stringify(s.headers)).toContain('dummy-key-the-proxy-injects-the-real-one');
      expect(s.headers['x-proxy-brain']).toBe('pair:a|b');
    }
    expect([seen[0].body.reasoning_effort, seen[0].body.max_completion_tokens, seen[1].body.max_tokens, seen[2].body.reasoning_effort]).toEqual([undefined, 4096, 4096, 'high']);
    await expect(ask('voyage:x', 'P', 'http://127.0.0.1:9', 's', 'b', fake)).rejects.toThrow(/no route/);
  });

  // Value: protects=safety-filter stops reported as their own outcome (R38, R95), never a model failure or a verdict; seam=ask's response classification
  test('safety-filter stops, budget refusals and errors are their own outcomes', async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const o = (m: string, f: typeof fetch) => ask(m, 'P', 'http://127.0.0.1:9', 's', 'b', f).then(r => r.outcome);
    expect(await o('openai:gpt-6.2-sol', reply(200, { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }], usage: {} }))).toBe('safety_stop');
    expect(await o('anthropic:claude-opus-5-5', reply(200, { content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } }))).toBe('safety_stop');
    expect(await o('particle:particle-1', reply(400, { error: { code: 'content_policy_violation', message: 'flagged' } }))).toBe('safety_stop');
    expect(await o('openai:gpt-6.2-sol', reply(402, { error: { kind: 'budget', type: 'budget', message: 'metering proxy: over' } }))).toBe('budget_refused');
    expect(await o('openai:gpt-6.2-sol', reply(500, { error: { message: 'boom' } }))).toBe('error');
    expect(await o('openai:gpt-6.2-sol', (async () => { throw new Error('refused'); }) as unknown as typeof fetch)).toBe('error');
  });

  test('a resume asks unsent pairs, asks a sent pair with no verdict once more, and never a third time', () => {
    const pairs: Array<[string, string]> = [['a', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'd'], ['d', 'e']];
    const ev = (a: string, b: string, outcome: CallEvent['outcome'], reask = false): CallEvent => ({ a, b, attempt: 1, reask, outcome, verdict: outcome === 'answer' ? 'no' : null, status: null, detail: 'x', answer: '', usage: null, response_model: null, ms: 0 });
    const events = [ev('a', 'b', 'answer'), ev('a', 'c', 'error'), ev('b', 'c', 'error'), ev('c', 'd', 'error'), ev('c', 'd', 'error', true), ev('d', 'e', 'safety_stop')];
    const plan = planPairs(pairs, events, new Set([pairBrain('a', 'c'), pairBrain('c', 'd')]));
    expect(plan.settled).toBe(2);
    expect(plan.ask).toEqual([{ a: 'a', b: 'c', reask: true }, { a: 'b', b: 'c', reask: false }]);
    expect(plan.no_verdict.map(p => `${p.a}${p.b}`)).toEqual(['cd']);
  });

  // Value: protects=a re-ask the proxy refused for budget (never sent) is asked again after a ledger-stop pause; fails_when=any reask event, budget-refused included, leaves the pair with no verdict
  test('a re-ask the proxy refused for budget never reached the provider, so a later resume asks it again', () => {
    const ev = (outcome: CallEvent['outcome'], reask: boolean): CallEvent => ({ a: 'a', b: 'b', attempt: 1, reask, outcome, verdict: null, status: null, detail: 'x', answer: '', usage: null, response_model: null, ms: 0 });
    const sent = new Set([pairBrain('a', 'b')]);
    expect(planPairs([['a', 'b']], [ev('error', false), ev('budget_refused', true)], sent).ask).toEqual([{ a: 'a', b: 'b', reask: true }]);
    expect(planPairs([['a', 'b']], [ev('error', false), ev('error', true)], sent).no_verdict).toHaveLength(1);
  });

  // Value: protects=the one re-ask cap across a crash mid-send; fails_when=a re-ask whose result was never recorded is sent a third time
  test('a re-ask marked pending with no recorded result counts as the one re-ask, unless its attempt recorded a budget refusal', () => {
    const ev = (outcome: CallEvent['outcome'], reask: boolean, attempt = 1): CallEvent => ({ a: 'a', b: 'b', attempt, reask, outcome, verdict: null, status: null, detail: 'x', answer: '', usage: null, response_model: null, ms: 0 });
    const sent = new Set([pairBrain('a', 'b')]);
    expect(planPairs([['a', 'b']], [ev('error', false), ev('pending', true, 2)], sent).no_verdict).toHaveLength(1);
    expect(planPairs([['a', 'b']], [ev('error', false), ev('pending', true, 2), ev('budget_refused', true, 2)], sent).ask).toEqual([{ a: 'a', b: 'b', reask: true }]);
  });
});

describe('memory readout', () => {
  const pages = small.pages.slice(0, 3);
  const node = (id: string, name: string, sources: string[], type: string | null = 'Person'): EntityNode => ({ id, name, type, source_ids: sources, provenance_status: 'exact' });

  test('a page subject is the best title match among its source\'s nodes', () => {
    expect(nameMatch('Omar Brandt', 'omar brandt')).toBe(3);
    expect(nameMatch('Robert Bly', 'R. Bly')).toBe(2);
    expect(subjectOf('Omar Brandt', [node('a', 'Orchid Retail', ['s'], 'Organization'), node('b', 'Omar Brandt', ['s'])])!.node.id).toBe('b');
    expect(subjectOf('Omar Brandt', [node('a', 'Porto', ['s'], 'Location')])).toBeNull();
  });

  test('shared nodes form auto groups, proposed links add review groups, and an unmapped page is unresolved', () => {
    const src = new Map(pages.map(p => [p.key, opaque('src', 't', p.key)]));
    const [p1, p2, p3] = pages;
    const { tiers, subjects } = readoutFromEntities(pages, src, {
      entities: [node('n1', p1.title, [src.get(p1.key)!, src.get(p2.key)!]), node('n2', p2.title, [src.get(p2.key)!])],
      links: [{ a: 'n1', b: 'n2', kind: 'SAME_AS', tier: 'proposed', score: null }],
    });
    expect(subjects.find(s => s.key === p3.key)!.node).toBeNull();
    expect(tiers.auto.length + tiers.proposed.length).toBeGreaterThanOrEqual(1);
    expect(opaque('ns', 'x')).toMatch(/^ns-[0-9a-f]{16}$/);
  });

  test('usage sums per key and counts budget refusals apart', () => {
    const rows = [
      { at: '2', key: 'k', provider: 'openai', model: 'm', outcome: 'forwarded', actual_usd: 0.5, input_tokens: 10, output_tokens: 2 },
      { at: '3', key: 'k', provider: 'openai', model: 'm', outcome: 'refused', status: 402 },
      { at: '1', key: 'k', provider: 'openai', model: 'm', outcome: 'forwarded', actual_usd: 9 },
    ];
    const t = usageByKey(rows, () => true, '2').get('k')!;
    expect([t.calls, t.usd, t.refused, t.budget_refused]).toEqual([1, 0.5, 1, 1]);
  });
});

describe('spend projection', () => {
  test('stops are 1.5 times a memory system\'s projected cost and the matcher\'s projected cost, rounded up to a cent', () => {
    expect(memoryStop('ext-temporal-graph', 2106)).toEqual({ projected_usd: 0.03431286 * 2106, stop_usd: 108.4 });
    expect([memoryStop('ext-graph-pipeline', 2106).stop_usd, memoryStop('ext-extract-first', 2106).stop_usd, memoryStop('ext-memory-bank', 2106).stop_usd]).toEqual([15.97, 14.22, 7.04]);
    expect(matcherStop('particle:particle-1', 21574).stop_usd).toBe(4.54);
  });

  test('the dry run on the development world quotes pages, pairs and every stop', () => {
    const d = dryRun(DEV_SEED, 20);
    const text = d.lines.join('\n');
    const w = buildWorld(DEV_SEED, 20), b = blockPairs(w.pages.map(p => p.written));
    const n = (x: number) => x.toLocaleString('en-US');
    const of = (type: string) => w.pages.filter(p => p.type === type).length;
    const split = (person: boolean, label: string) => w.pairs.filter(p => w.people_gold.has(p.a) === person && p.label === label).length;
    const ids = new Set(b.pairs.map(([x, y]) => pairId(x, y))), missed = w.pairs.filter(p => !ids.has(pairId(p.a, p.b)));
    expect(text).toContain(`${n(w.pages.length)} pages (${n(of('person'))} people, ${n(of('company'))} companies)`);
    expect(text).toContain(`people ${split(true, 'different')} must-not-link and ${split(true, 'same')} must-link; companies ${split(false, 'different')} must-not-link and ${split(false, 'same')} must-link`);
    expect(text).toContain(`${n(b.pairs.length)} candidate pairs; ${b.crowded.length} keys on more than ${MAX_BLOCK_PAGES} pages dropped`);
    expect(text).toContain(`not a candidate: ${missed.length} designed pairs (${missed.filter(p => p.label === 'same').length} must-link, ${missed.filter(p => p.label === 'different').length} must-not-link)`);
    expect(d.memory['ext-temporal-graph'].stop_usd).toBe(memoryStop('ext-temporal-graph', w.pages.length).stop_usd);
    const slice = buildWorld(HELD_OUT_SEED, 5).pages.length;
    for (const kind of MEMORY_KINDS) {
      const m = d.memory[kind], knob = tuningOf(kind).knob !== null, runs = knob ? Object.keys(tuningOf(kind).grid).length + 1 : 0;
      expect([m.tuning_pages, m.tuning_runs]).toEqual([slice, runs]);
      expect(m.cell_stops_usd).toBeCloseTo((knob ? 2 : 1) * m.stop_usd + runs * memoryStop(kind, slice).stop_usd, 9);
    }
    expect(d.matcher['anthropic:claude-opus-5-5'].stop_usd).toBe(matcherStop('anthropic:claude-opus-5-5', b.pairs.length).stop_usd);
  });
});

describe('memory-system pins (each the newest release at launch, preregistration "Systems")', () => {
  const PINNED = { 'ext-temporal-graph': '0.31.2', 'ext-graph-pipeline': '1.6.8', 'ext-extract-first': '2.2.1', 'ext-memory-bank': '1.2.1' } as const;
  const bundle = (kind: string, file: string) => readFileSync(resolve(import.meta.dir, '../../docs/comparison-systems', kind, 'entity-h2h', file), 'utf8');

  // Value: protects=ext-temporal-graph's ingest reaches gpt-6.2-sol, which rejects reasoning effort none; fails_when=the entity-h2h shim stops setting the adapter's OpenAI client to reasoning=None, or its record still claims effort none
  test("ext-temporal-graph's entity-h2h shim sends no reasoning effort, since gpt-6.2-sol rejects the client's default 'none' (Amendment 3)", () => {
    expect(bundle('ext-temporal-graph', 'entity_h2h.py')).toMatch(/async def _connect\(self\)[^\n]*\n\s+(\w+) = await super\(\)\._connect\(\)\n\s+\1\.llm_client\.reasoning = None\n\s+return \1\n/);
    const rec = JSON.parse(bundle('ext-temporal-graph', 'capability.json'));
    expect(JSON.stringify(rec.provider_routes)).not.toContain('reasoning effort none');
    expect(rec.deviations_from_vendor_code.some((d: string) => d.includes('reasoning to None') && d.includes('Amendment 3'))).toBe(true);
  });

  // Value: protects=ext-graph-pipeline's finish step on the counted world, whose consolidation embeds more than 2,048 names in one request; fails_when=the shim stops adding OpenAI's batch-limit wording to the embedder's split-and-retry pattern, the pattern stops matching OpenAI's 400, or the keyless fake stops refusing over-limit batches the way OpenAI does
  test("ext-graph-pipeline's entity-h2h shim routes OpenAI's 2,048-input embeddings 400 into the embedder's split-and-retry path, and the keyless fake sends that 400 (Amendment 5)", () => {
    const shim = bundle('ext-graph-pipeline', 'entity_h2h.py');
    const limit = shim.match(/^OPENAI_BATCH_LIMIT = r"(.+)"$/m)?.[1];
    expect(limit).toBeDefined();
    expect(shim).toContain('litellm_embedding._EMBED_LENGTH_ERROR_RE = re.compile(f"{litellm_embedding._EMBED_LENGTH_ERROR_RE.pattern}|{OPENAI_BATCH_LIMIT}",');
    expect(shim).toMatch(/importlib\.import_module\("\w+\.infrastructure\.databases\.vector\.embeddings\.LiteLLMEmbeddingEngine"\)/);
    const wording = new RegExp(limit!, 'i');
    expect(wording.test("litellm.BadRequestError: OpenAIException - Error code: 400 - Invalid 'input': array length must be 2048 or less.")).toBe(true);
    expect(wording.test("Error code: 400 - Invalid 'input': must not be empty")).toBe(false);
    const rec = JSON.parse(bundle('ext-graph-pipeline', 'capability.json'));
    expect(rec.deviations_from_vendor_code.some((d: string) => d.includes('array length must be 2048 or less') && d.includes('Amendment 5'))).toBe(true);
    const script = [
      'import importlib.util, json, sys, threading, urllib.request, urllib.error',
      'from http.server import ThreadingHTTPServer',
      'spec = importlib.util.spec_from_file_location("fp", sys.argv[1]); fp = importlib.util.module_from_spec(spec); spec.loader.exec_module(fp)',
      'srv = ThreadingHTTPServer(("127.0.0.1", 0), fp.pinned.Handler); threading.Thread(target=srv.serve_forever, daemon=True).start()',
      'out = {}',
      'for n in (2048, 2049):',
      '    body = json.dumps({"model": "text-embedding-3-small", "dimensions": 4, "input": ["x"] * n}).encode()',
      '    req = urllib.request.Request(f"http://127.0.0.1:{srv.server_address[1]}/v1/embeddings", data=body, headers={"Content-Type": "application/json"})',
      '    try:',
      '        r = urllib.request.urlopen(req, timeout=30); out[n] = [r.status, len(json.load(r)["data"])]',
      '    except urllib.error.HTTPError as e:',
      '        out[n] = [e.code, json.load(e)["error"]["message"]]',
      'srv.shutdown(); print(json.dumps(out))',
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-c', script, resolve(import.meta.dir, '../../docs/comparison-systems/ext-graph-pipeline/entity-h2h/fake_provider.py')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ 2048: [200, 2048], 2049: [400, "Invalid 'input': array length must be 2048 or less."] });
  });

  // Value: protects=a counted cell's lease from the Amendment 5 diagnostic; fails_when=batch_limit_check.py builds an embedder when a provider key isn't the keyless placeholder or when its embedding host doesn't answer the fake provider's /_stats route (the metering proxy answers 404)
  test("ext-graph-pipeline's batch-limit check refuses before embedding unless its keys are placeholders and its embedder reaches the fake provider", async () => {
    const path = resolve(import.meta.dir, '../../docs/comparison-systems/ext-graph-pipeline/entity-h2h/batch_limit_check.py');
    const placeholder = 'dummy-key-the-proxy-injects-the-real-one';
    const fake = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname === '/_stats' ? Response.json({}) : new Response('no route', { status: 404 }) });
    const proxy = Bun.serve({ port: 0, fetch: () => Response.json({ error: { message: 'no provider route /_stats' } }, { status: 404 }) });
    const at = (server: { url: URL }) => `${server.url.origin}/v1`;
    const keys = { OPENAI_API_KEY: placeholder, LLM_API_KEY: placeholder, EMBEDDING_API_KEY: placeholder, EMBEDDING_ENDPOINT: at(fake) };
    const run = async (env: Record<string, string>) => {
      const p = Bun.spawn(['python3', path], { env: { PATH: process.env.PATH ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' });
      return { status: await p.exited, stdout: await new Response(p.stdout).text() };
    };
    try {
      for (const env of [{ ...keys, EMBEDDING_API_KEY: 'cell-token' }, { ...keys, LLM_API_KEY: 'cell-token' }, { OPENAI_API_KEY: placeholder }, { ...keys, EMBEDDING_ENDPOINT: at(proxy) }, { ...keys, EMBEDDING_ENDPOINT: '' }]) {
        const r = await run(env);
        expect(r.status).toBe(2);
        expect(JSON.parse(r.stdout.trim()).refused).toContain('not the keyless stack');
      }
      const keyless = await run(keys);
      expect(keyless.status).not.toBe(2);
      expect(keyless.stdout).not.toContain('refused');
    } finally {
      fake.stop(true);
      proxy.stop(true);
    }
  });

  test('the dry run prints each memory system\'s pinned release and lock from its entity-h2h bundle', () => {
    const d = dryRun(DEV_SEED, 20);
    for (const [kind, version] of Object.entries(PINNED)) {
      const pin = JSON.parse(bundle(kind, 'capability.json')).versions as { lock_sha256: string | null };
      expect([d.memory[kind].version, d.memory[kind].lock_sha256]).toEqual([version, pin.lock_sha256]);
      expect(d.lines.find(l => l.trimStart().startsWith(`${kind} `))).toContain(` ${version} `);
    }
  });

  test('each re-pinned bundle builds from its own lock, whose hash the capability record carries, and asserts the release', () => {
    for (const kind of ['ext-temporal-graph', 'ext-graph-pipeline', 'ext-memory-bank'] as const) {
      const pin = JSON.parse(bundle(kind, 'capability.json')).versions as { lock_sha256: string; lock_file: string };
      expect(pin.lock_file).toBe(`docs/comparison-systems/${kind}/entity-h2h/uv.lock`);
      expect(createHash('sha256').update(readFileSync(resolve(import.meta.dir, '../..', pin.lock_file))).digest('hex')).toBe(pin.lock_sha256);
      const dockerfile = bundle(kind, 'Dockerfile');
      expect(dockerfile).toContain(`COPY docs/comparison-systems/${kind}/entity-h2h/pyproject.toml docs/comparison-systems/${kind}/entity-h2h/uv.lock ./`);
      expect(dockerfile).toContain(`== '${PINNED[kind]}'`);
      expect(bundle(kind, 'pyproject.toml')).toContain(`==${PINNED[kind]}"]`);
    }
    const memoryBank = JSON.parse(bundle('ext-memory-bank', 'capability.json')).versions as { image: string };
    expect(memoryBank.image).toMatch(/:1\.2\.1@sha256:[0-9a-f]{64}$/);
    expect(bundle('ext-memory-bank', 'docker-compose.yml')).toContain(`image: ${memoryBank.image}`);
  });

  // Value: protects=the stack starts in, and reports, the cell's setting; fails_when=a bundle drops the setting variable, a shim stops reporting it, or a server-env knob reaches the server and the shim from different variables
  test('each bundle records its knob and grid (or why it has none) and passes the cell\'s setting to a shim that reports it under GET /health', () => {
    for (const kind of MEMORY_KINDS) {
      const t = tuningOf(kind), compose = bundle(kind, 'docker-compose.yml');
      expect(Object.keys(t.grid).length).toBeLessThanOrEqual(TUNING_SETTINGS);
      expect(t.docs.length).toBeGreaterThan(0);
      if (t.knob) expect(Object.keys(t.grid).length).toBeGreaterThan(0); else expect(t.no_knob).toStartWith('No documented dedupe setting (preregistration Amendment 2)');
      expect(compose).toContain('ENTITY_H2H_SETTING: ${ENTITY_H2H_SETTING:-default}');
      expect(bundle(kind, 'entity_h2h.py')).toMatch(/def health\(self\)[^\n]*\n[\s\S]*?"entity_h2h": \{"setting"/);
      if (t.applied_by === 'server-env') for (const [k, v] of Object.entries(t.default)) expect(compose.split(`\${${k}:-${v}}`).length - 1).toBe(2);
    }
  });
});

describe('the tuned-setting rule (preregistration Amendment 2)', () => {
  const cand = (setting: string, distance: number, fm: [number, number], recall: [number, number]): Candidate =>
    ({ setting, settings: {}, distance, false_merge: { k: fm[0], n: fm[1] }, recall: { k: recall[0], n: recall[1] }, eligible: false });

  // Value: protects=the tuned setting is the lowest false-merge rate among settings within 5 recall points of default; fails_when=the recall bound is dropped, compared inexactly at its edge, or false merges are compared the wrong way
  test('picks the lowest false-merge rate within the recall bound; a lower rate outside it loses; the bound is exact at its edge', () => {
    const base = cand('default', 0, [10, 100], [50, 100]);
    expect(applyRule([base, cand('a', 0.1, [5, 100], [46, 100]), cand('b', 0.2, [2, 100], [44, 100])])).toBe('a');
    const edge = [base, cand('a', 0.1, [5, 100], [9, 20]), cand('b', 0.2, [4, 100], [449, 1000])];
    expect(applyRule(edge)).toBe('a');
    expect(edge.map(c => c.eligible)).toEqual([true, true, false]);
    expect(applyRule([base, cand('a', 0.1, [11, 100], [60, 100])])).toBe('default');
  });

  // Value: protects=Amendment 2's tie-breaks; fails_when=a false-merge tie does not go to the setting nearest default, an equal distance does not go to higher recall, or a full tie does not go to grid order
  test('ties go to the nearest default (default at 0), then higher recall, then grid order; 0.70 and 1.00 are equally near 0.85', () => {
    const base = cand('default', 0, [10, 100], [50, 100]);
    expect(applyRule([base, cand('far', 0.3, [5, 100], [50, 100]), cand('near', 0.1, [5, 100], [50, 100])])).toBe('near');
    expect(applyRule([base, cand('a', 0.1, [10, 100], [60, 100])])).toBe('default');
    const g = tuningOf('ext-graph-pipeline'), low = g.grid['similarity-0.70'].settings, high = g.grid['similarity-1.00'].settings;
    const d = distanceOf(g, low);
    expect([d, distanceOf(g, high)]).toEqual([0.15, 0.15]);
    expect(applyRule([base, cand('similarity-0.70', d, [5, 100], [60, 100]), cand('similarity-1.00', d, [5, 100], [61, 100])])).toBe('similarity-1.00');
    expect(applyRule([base, cand('similarity-0.70', d, [5, 100], [60, 100]), cand('similarity-1.00', d, [5, 100], [60, 100])])).toBe('similarity-0.70');
    expect(() => applyRule([cand('a', 0.1, [5, 100], [60, 100])])).toThrow(/default as its first candidate/);
  });
});

describe('refusals', () => {
  test('person-dedupe refuses a used world folder and an incomplete import with stable codes, counts and a fix', () => {
    const dir = join(tmp, 'pd');
    mkdirSync(dir);
    writeFileSync(join(dir, 'x'), '');
    const ledger = generateLedger(4, 1);
    let e: unknown;
    try { writeWorld(ledger, dir); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(RunnerRefusal);
    expect((e as RunnerRefusal).code).toBe('WORLD_DIR_USED');
    expect((e as Error).message).toMatch(/^REFUSED WORLD_DIR_USED: .*not empty.*\(entries_in_folder 1\)\. Fix: pass a fresh --write-world directory$/);
    try { checkFinderCoverage([], ledger.pages); } catch (x) { e = x; }
    expect((e as RunnerRefusal).code).toBe('IMPORT_INCOMPLETE');
    expect((e as Error).message).toContain(`(pages_expected ${ledger.pages.length}, pages_imported 0). Fix: `);
  });

  test('the runner refuses a used output folder with exit 2 and a classic run on the wrong seeds', async () => {
    const w = join(tmp, 'rw'), held = join(tmp, 'rh'), out = join(tmp, 'ro');
    writeH2hWorld(w, 7, 1);
    writeH2hWorld(held, 7, 1);
    const realHeld = join(tmp, 'rh-real');
    writeH2hWorld(realHeld, HELD_OUT_SEED, 1);
    mkdirSync(out); writeFileSync(join(out, 'x'), '');
    expect(await cli(['run', '--system', 'splink', '--config', 'default', '--world', w, '--held-out', realHeld, '--output', out], quiet)).toBe(2);
    await expect(cli(['run', '--system', 'splink', '--config', 'default', '--world', realHeld, '--held-out', realHeld, '--output', join(tmp, 'ro1')], quiet)).rejects.toThrow(/nothing scored comes from it/);
    await expect(cli(['run', '--system', 'splink', '--config', 'default', '--world', w, '--held-out', held, '--output', join(tmp, 'ro2')], quiet)).rejects.toThrow(/only from held-out seed 20261118/);
    await expect(cli(['run', '--system', 'dedupe', '--config', 'default', '--world', w, '--held-out', held, '--output', join(tmp, 'ro3')], quiet)).rejects.toThrow(/labeller seed/);
    await expect(cli(['run', '--system', 'zingg', '--config', 'default', '--world', w, '--held-out', held, '--output', join(tmp, 'ro4'), '--labeller-seed', '1'], quiet)).rejects.toThrow(/no seed setting/);
    await expect(cli(['run', '--system', 'splink', '--config', 'default', '--world', w, '--held-out', held, '--output', join(tmp, 'ro5'), '--label-budget', '100'], quiet)).rejects.toThrow(/takes no labels/);
    await expect(cli(['labels', '--world', w, '--out', join(tmp, 'l.json')], quiet)).rejects.toThrow(/only from held-out seed/);
  });
});

describe('classic records parser', () => {
  // Value: protects=the preregistration's rule that the records table comes from the rendered pages only; fails_when=world.py imports the generator, the ledger or a non-stdlib module
  test('world.py imports only the standard library, nothing from the generators or a ledger', () => {
    const script = [
      'import ast, sys, json',
      'tree = ast.parse(open(sys.argv[1]).read())',
      'mods = sorted({(n.module if isinstance(n, ast.ImportFrom) else a.name).split(".")[0] for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) for a in (n.names if isinstance(n, ast.Import) else [n])})',
      'print(json.dumps(mods))',
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-c', script, resolve(import.meta.dir, '../../eval/adapters/er-h2h/world.py')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const mods: string[] = JSON.parse(r.stdout);
    const stdlib = new Set(['__future__', 'argparse', 'json', 're', 'itertools', 'pathlib', 'urllib', 'typing', 'dataclasses', 'collections', 'os', 'sys']);
    expect(mods.filter(m => !stdlib.has(m))).toEqual([]);
    expect(readFileSync(resolve(import.meta.dir, '../../eval/adapters/er-h2h/world.py'), 'utf8')).not.toMatch(/person-dedupe-gen|company-dedupe-gen|ledger\.json/);
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

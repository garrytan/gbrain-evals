/**
 * sealed-qrels regression test — Day 9 of BrainBench v1 Complete.
 *
 * Enforces the sealed-qrels contract added in Day 9:
 *   - sanitizePage() produces a new object with NO `_facts` field
 *   - sanitizeQuery() produces a new object with NO `gold` field
 *   - Accessing `._facts` / `.gold` on sanitized output returns `undefined`
 *   - Scorer retains the full Query/RichPage shape (gold.relevant still usable)
 *
 * This is a SOFT enforcement — an adapter that runs `readFileSync(
 * 'eval/data/gold/*.json')` could still cheat. Hard enforcement via
 * process isolation ships with BrainBench v2's Docker sandbox.
 *
 * Documented as such so the adversarial reviewer doesn't get a false sense
 * of airtight enforcement here.
 */

import { describe, test, expect } from 'bun:test';
import {
  sanitizePage,
  sanitizeQuery,
  type Page,
  type PublicPage,
  type Query,
  type PublicQuery,
} from '../../eval/runner/types.ts';

// ─── RichPage helper (mirrors multi-adapter.ts internal shape) ────────

interface RichPage extends Page {
  _facts: {
    type: string;
    attendees?: string[];
    employees?: string[];
    founders?: string[];
    investors?: string[];
  };
}

function makeRichPage(overrides: Partial<RichPage> = {}): RichPage {
  return {
    slug: 'people/amara',
    type: 'person',
    title: 'Amara Okafor',
    compiled_truth: 'Amara is a Partner.',
    timeline: '',
    _facts: { type: 'person' },
    ...overrides,
  } as RichPage;
}

function makeQuery(overrides: Partial<Query> = {}): Query {
  return {
    id: 'q-0001',
    tier: 'easy',
    text: 'Who is Amara?',
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/amara'] },
    ...overrides,
  };
}

// ─── sanitizePage ─────────────────────────────────────────────────────

describe('sanitizePage — strips _facts and frontmatter', () => {
  test('output has the 5 public fields', () => {
    const rp = makeRichPage();
    const sanitized = sanitizePage(rp);
    expect(sanitized.slug).toBe(rp.slug);
    expect(sanitized.type).toBe(rp.type);
    expect(sanitized.title).toBe(rp.title);
    expect(sanitized.compiled_truth).toBe(rp.compiled_truth);
    expect(sanitized.timeline).toBe(rp.timeline);
  });

  test('output does NOT have _facts (the gold canonical leak)', () => {
    const rp = makeRichPage({
      _facts: { type: 'person', employees: ['people/amara'] },
    });
    const sanitized = sanitizePage(rp);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sanitized as any)._facts).toBeUndefined();
    expect('_facts' in sanitized).toBe(false);
  });

  test('output does NOT have frontmatter (potential hiding spot)', () => {
    const rp = makeRichPage();
    // Caller could have dumped _facts into frontmatter as a workaround
    rp.frontmatter = { _facts_leak: 'gold data' };
    const sanitized = sanitizePage(rp);
    expect('frontmatter' in sanitized).toBe(false);
  });

  test('output is a NEW object (not a reference to the original)', () => {
    const rp = makeRichPage();
    const sanitized = sanitizePage(rp);
    expect(sanitized).not.toBe(rp as unknown as PublicPage);
  });

  test('output has exactly the 5 expected keys (no hidden properties)', () => {
    const rp = makeRichPage();
    rp._facts = { type: 'person', employees: ['x'] };
    rp.frontmatter = { anything: 'goes' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rp as any).leak = 'secret';
    const sanitized = sanitizePage(rp);
    const keys = Object.keys(sanitized).sort();
    expect(keys).toEqual(['compiled_truth', 'slug', 'timeline', 'title', 'type']);
  });

  test('sanitized page when cast to any cannot reach original _facts', () => {
    const rp = makeRichPage({
      _facts: { type: 'company', investors: ['people/alice'] },
    });
    const sanitized = sanitizePage(rp);
    // A cheating adapter does: const x = (page as any)._facts;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facts = (sanitized as any)._facts;
    expect(facts).toBeUndefined();
    // And cannot reach the original by prototype chain either
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = Object.getPrototypeOf(sanitized);
    expect(proto).toBe(Object.prototype);
  });
});

// ─── sanitizeQuery ────────────────────────────────────────────────────

describe('sanitizeQuery — minimal operational surface', () => {
  test('output has the operational fields', () => {
    const q = makeQuery();
    const sanitized = sanitizeQuery(q);
    expect(sanitized.id).toBe(q.id);
    expect(sanitized.text).toBe(q.text);
  });

  test('output does NOT have gold', () => {
    const q = makeQuery({ gold: { relevant: ['people/amara'], grades: { 'people/amara': 3 } } });
    const sanitized = sanitizeQuery(q);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sanitized as any).gold).toBeUndefined();
    expect('gold' in sanitized).toBe(false);
  });

  test('strips EVERY classification signal — tier, tags, author, expected_output_type, variants, failure modes', () => {
    // Audit finding shared-infra-04 + outside-voice round 2: tier announces
    // "adversarial trap", tags carry 'identity-collision'/'contradiction',
    // expected_output_type reveals abstention expectations, and
    // acceptable_variants are the answer phrasings themselves. None of these
    // are needed to rank documents.
    const q = makeQuery({
      tier: 'adversarial',
      tags: ['identity-collision', 'contradiction'],
      author: 'external-researcher',
      acceptable_variants: ['who works at Halfway'],
      known_failure_modes: ['bare-name-collision'],
    });
    const sanitized = sanitizeQuery(q);
    const keys = Object.keys(sanitized).sort();
    expect(keys).toEqual(['id', 'text']);
    expect('tier' in sanitized).toBe(false);
    expect('tags' in sanitized).toBe(false);
    expect('author' in sanitized).toBe(false);
    expect('expected_output_type' in sanitized).toBe(false);
    expect('acceptable_variants' in sanitized).toBe(false);
    expect('known_failure_modes' in sanitized).toBe(false);
  });

  test('retains as_of_date (temporal queries need it operationally)', () => {
    const q = makeQuery({ as_of_date: '2026-04-20' });
    const sanitized = sanitizeQuery(q);
    expect(sanitized.as_of_date).toBe('2026-04-20');
  });

  test('omits undefined as_of_date from the sanitized shape', () => {
    const q = makeQuery();
    const sanitized = sanitizeQuery(q);
    expect('as_of_date' in sanitized).toBe(false);
  });

  test('output is a NEW object', () => {
    const q = makeQuery();
    expect(sanitizeQuery(q)).not.toBe(q as unknown as PublicQuery);
  });
});

// ─── Proxy-based adversarial adapter simulation ───────────────────────

describe('adversarial adapter access — Proxy tripwire', () => {
  test('Proxy-wrapped PublicPage throws on `_facts` access (tripwire)', () => {
    const sanitized = sanitizePage(makeRichPage({ _facts: { type: 'person' } }));
    const tripwire = new Proxy(sanitized, {
      get(target, prop) {
        if (prop === '_facts' || prop === 'gold') {
          throw new Error(`sealed-qrels violation: adapter read forbidden field "${String(prop)}"`);
        }
        return target[prop as keyof PublicPage];
      },
    });
    // Normal reads work
    expect(tripwire.slug).toBe('people/amara');
    // Adversarial read throws
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (tripwire as any)._facts).toThrow(/sealed-qrels violation/);
  });

  test('Proxy-wrapped PublicQuery throws on `gold` access', () => {
    const sanitized = sanitizeQuery(makeQuery());
    const tripwire = new Proxy(sanitized, {
      get(target, prop) {
        if (prop === 'gold') {
          throw new Error('sealed-qrels violation: adapter read q.gold');
        }
        return target[prop as keyof PublicQuery];
      },
    });
    expect(tripwire.id).toBe('q-0001');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (tripwire as any).gold).toThrow(/sealed-qrels violation/);
  });
});

// ─── Honest documentation of the seal's limits ────────────────────────

describe('soft-seal documentation', () => {
  test('sanitize cannot protect against filesystem access', () => {
    // This test is intentionally EDUCATIONAL — it documents that the seal
    // is only at the object level. A malicious adapter that does
    // readFileSync('eval/data/gold/qrels.json') bypasses the seal entirely.
    // BrainBench v2's Docker sandbox is the real enforcement.
    const pseudocode =
      "const gold = JSON.parse(readFileSync('eval/data/gold/qrels.json'))";
    expect(pseudocode.length).toBeGreaterThan(0);
    // The defense is deliberate and documented in types.ts.
  });

  test('sanitize cannot prevent a malicious Proxy setup from the adapter', () => {
    // Similarly: a malicious adapter could set up its own Proxy to probe
    // values. The seal is "can a well-behaved adapter accidentally cheat?",
    // not "can a malicious adapter never cheat?"
    const sanitized = sanitizePage(makeRichPage());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asAny = sanitized as any;
    expect(asAny._facts).toBeUndefined();
    // A malicious adapter with network access could still exfiltrate the
    // page list and correlate externally. Hard enforcement requires
    // process isolation.
  });
});

// ─── Integration: scorer still sees full Query ────────────────────────

describe('scorer retains gold', () => {
  test('original Query object still has gold after sanitization (immutable copy)', () => {
    const q = makeQuery({ gold: { relevant: ['people/amara', 'companies/halfway'] } });
    const sanitized = sanitizeQuery(q);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sanitized as any).gold).toBeUndefined();
    // Scorer still has access to q.gold.relevant
    expect(q.gold.relevant).toEqual(['people/amara', 'companies/halfway']);
  });

  test('original RichPage still has _facts after sanitization', () => {
    const rp = makeRichPage({ _facts: { type: 'meeting', attendees: ['people/amara'] } });
    sanitizePage(rp);
    expect(rp._facts.attendees).toEqual(['people/amara']);
  });
});

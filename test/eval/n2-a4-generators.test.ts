/**
 * Generator determinism and oracle checks for N2 (contradiction surfacing)
 * and A4 (abstention). Pure: no gbrain import.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { N2_DEFAULT_SEED, generateN2World, n2Gold, renderN2Page } from '../../eval/generators/n2-contradiction-gen.ts';
import { A4_DEFAULT_SEED, generateA4World, isAnswerable } from '../../eval/generators/a4-abstention-gen.ts';

describe('N2 generator', () => {
  test('same seed, same ledger hash; another seed differs', () => {
    expect(generateN2World().fingerprint).toBe(generateN2World({ seed: N2_DEFAULT_SEED }).fingerprint);
    expect(generateN2World({ seed: N2_DEFAULT_SEED + 1 }).fingerprint).not.toBe(generateN2World().fingerprint);
  });

  test('default counts: 150 same-time conflicts, 60 dated changes, 60 compatible negatives', () => {
    const { ledger } = generateN2World();
    const count = (k: string) => ledger.items.filter(i => i.kind === k).length;
    expect([count('same_time_conflict'), count('dated_change'), count('holder_opinion') + count('agreement') + count('namesake') + count('negation')]).toEqual([150, 60, 60]);
    expect(new Set(ledger.pages.map(p => p.slug)).size).toBe(ledger.pages.length);
  });

  test('every claim span is in its rendered page, and the oracle needs both slugs and both spans', () => {
    const { ledger } = generateN2World();
    const gold = n2Gold(ledger);
    for (const it of ledger.items) {
      expect(renderN2Page(it.a)).toContain(it.a.claim);
      expect(renderN2Page(it.b)).toContain(it.b.claim);
      expect(gold({ slug: it.b.slug, text: it.b.body }, { slug: it.a.slug, text: it.a.body })).toMatchObject({ planted: true, item: it.id, gold_class: it.gold_class });
      expect(gold({ slug: it.a.slug, text: 'unrelated chunk' }, { slug: it.b.slug, text: it.b.body }).planted).toBe(false);
    }
    const [x, y] = ledger.items;
    expect(gold({ slug: x.a.slug, text: x.a.body }, { slug: y.a.slug, text: y.a.body })).toEqual({ planted: false, gold_class: 'compatible' });
  });

  test('no non-planted page states a planted attribute of the same company', () => {
    const { ledger } = generateN2World();
    for (const it of ledger.items.filter(i => i.kind === 'same_time_conflict' || i.kind === 'dated_change')) {
      const profile = ledger.pages.find(p => p.item === null && p.title === it.entity)!;
      for (const s of [it.a, it.b]) expect(profile.body.includes(s.claim)).toBe(false);
    }
  });

  test('temporal items name the older side, and their dates order it', () => {
    const { ledger } = generateN2World();
    for (const it of ledger.items.filter(i => i.kind === 'dated_change' && i.variant !== 'text_dates')) {
      const older = it[it.older_side!];
      const newer = it[it.older_side === 'a' ? 'b' : 'a'];
      expect(older.date! < newer.date!).toBe(true);
    }
  });
});

describe('A4 generator', () => {
  test('same seed, same ledger hash; another seed differs', () => {
    expect(generateA4World().fingerprint).toBe(generateA4World({ seed: A4_DEFAULT_SEED }).fingerprint);
    expect(generateA4World({ seed: A4_DEFAULT_SEED + 1 }).fingerprint).not.toBe(generateA4World().fingerprint);
  });

  test('120 answerable and 120 unanswerable questions; answers are written, unanswerable attributes are not', () => {
    const { ledger } = generateA4World();
    expect(ledger.questions.filter(q => isAnswerable(q.cls)).length).toBe(120);
    expect(ledger.questions.filter(q => !isAnswerable(q.cls)).length).toBe(120);
    for (const q of ledger.questions) {
      if (q.answer) expect(ledger.pages.find(p => p.slug === q.answer_slug)!.body).toContain(q.answer);
      if (q.cls === 'sibling_attribute') expect(ledger.pages.some(p => p.body.includes(q.sibling_value!))).toBe(true);
      for (const s of q.oracle_slugs) expect(ledger.pages.some(p => p.slug === s)).toBe(true);
    }
  });

  test('every attribute value is unique, so an answer identifies its company', () => {
    const { ledger } = generateA4World();
    for (const [, vs] of Object.entries(ledger.values)) expect(new Set(vs).size).toBe(vs.length);
  });
});

describe('N2 adjudication of the amara-life gold', () => {
  test('every original pair keeps a row; relabels are recorded, none deleted', () => {
    const gold = JSON.parse(readFileSync('eval/data/gold/contradictions.json', 'utf8'));
    const adj = JSON.parse(readFileSync('eval/data/gold/contradictions-adjudication.json', 'utf8'));
    expect(adj.pairs.map((p: { id: string }) => p.id)).toEqual(gold.pairs.map((p: { id: string }) => p.id));
    expect(adj.stale_facts.map((p: { id: string }) => p.id)).toEqual(gold.stale_facts.map((p: { id: string }) => p.id));
    const relabeled = adj.pairs.filter((p: { original: string; adjudicated: string }) => p.adjudicated !== p.original).length;
    expect(relabeled).toBe(6);
  });
});

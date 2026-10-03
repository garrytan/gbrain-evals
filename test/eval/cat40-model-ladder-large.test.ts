import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateLadderWorld, worldDigest, LARGE_LADDER_DIR } from '../../eval/generators/model-ladder-gen.ts';

const v1 = generateLadderWorld();
const large = generateLadderWorld(undefined, { scale: 'large' });
const v1Ids = new Set(v1.docs.map(d => d.id));
const added = large.docs.filter(d => !v1Ids.has(d.id));

describe('model-ladder large world', () => {
  test('matches the committed manifest and lands in the 45-55k range', () => {
    const manifest = JSON.parse(readFileSync(join(LARGE_LADDER_DIR, 'manifest.json'), 'utf8'));
    expect(worldDigest(large)).toBe(manifest.digest);
    expect(large.docs.length).toBe(manifest.docs);
    expect(large.docs.length).toBeGreaterThan(45_000);
    expect(large.docs.length).toBeLessThan(55_000);
    expect(large.scale).toBe('large');
  });
  test('keeps the v1 tasks and every v1 document unchanged', () => {
    expect(large.tasks).toEqual(v1.tasks);
    const byId = new Map(large.docs.map(d => [d.id, d]));
    for (const d of v1.docs) expect(byId.get(d.id)).toEqual(d);
    expect(new Set(large.docs.map(d => d.id)).size).toBe(large.docs.length);
  });
  test('every doc a task references exists', () => {
    const ids = new Set(large.docs.map(d => d.id));
    for (const t of large.tasks) for (const id of [...t.relevant, ...t.gold.evidence, ...(t.protected_docs ?? [])]) expect(ids.has(id)).toBe(true);
  });
  test('canaries appear only in restricted docs or docs derived from them', () => {
    const byId = new Map(large.docs.map(d => [d.id, d]));
    for (const t of large.tasks.filter(x => x.canaries)) for (const c of t.canaries!) {
      const hits = large.docs.filter(x => x.body.includes(c));
      expect(hits.length).toBeGreaterThan(0);
      for (const d of hits) expect(d.restricted || (d.derived_from ?? []).some(x => byId.get(x)?.restricted)).toBe(true);
    }
  });
  test('added documents repeat no value a task depends on and name no task account outside team updates', () => {
    const values = new Set<string>();
    for (const t of large.tasks) {
      for (const v of [...(t.gold.answer ?? []), ...(t.gold.wrong ?? []), ...(t.canaries ?? [])]) values.add(v);
      if (t.family === 'E') for (const k of ['renewal_date', 'open_ticket']) for (const v of t.gold.fields![k]) values.add(v);
    }
    // Distinctive values only: dates after the corpus's activity window, money, ticket ids, discounts, codes and the F corrections.
    const fNames = new Set(large.tasks.filter(t => t.family === 'F').flatMap(t => t.gold.answer!));
    const distinctive = [...values].filter(v => /^202[67]-\d\d-\d\d$/.test(v) && v >= '2026-10-01' || /^\$|^TKT-|^FIN-|%$/.test(v) && !/^99\./.test(v) || fNames.has(v));
    const seats = large.tasks.filter(t => t.family === 'A' && /seats/.test(t.question)).flatMap(t => [...t.gold.answer!, ...t.gold.wrong!]);
    expect(distinctive.length).toBeGreaterThan(40);
    const taskNames = new Set<string>();
    for (const t of large.tasks) { const crm = v1.docs.find(d => d.id === `crm/${t.account}`)!; taskNames.add(crm.title.replace('CRM record: ', '')); taskNames.add(crm.body.match(/Account code: (\w+)\./)![1]); }
    const nameRe = new RegExp(`\\b(${[...taskNames].join('|')})\\b`);
    const problems: string[] = [];
    for (const d of added) {
      for (const v of distinctive) if (d.body.includes(v)) problems.push(`${d.id} contains ${v}`);
      for (const s of seats) if (d.body.includes(`Licensed seats: ${s}.`)) problems.push(`${d.id} has ${s} seats`);
      if (d.type !== 'team-update' && nameRe.test(d.body)) problems.push(`${d.id} names a task account`);
    }
    expect(problems).toEqual([]);
  });
});

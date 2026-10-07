import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cat35Data, chipsFor, chronicleData, embedJson, renderPacket, seededShuffle } from '../../scripts/w11-packet.ts';
import { clusteredKappa, revisedReference, scoreCat35, scoreChronicle, validate, type Export } from '../../scripts/w11-score.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function exportFor(packet: 'chronicle' | 'cat35', answers: Export['answers'], extras: Export['extras'] = {}): Export {
  const data = packet === 'chronicle' ? chronicleData() : cat35Data();
  return { schema: 'w11-labels/1', packet, packet_sha256: sha(embedJson(data)), label_files: data.label_files, reviewer: 'Test Reviewer', exported_at: '2026-10-06T00:00:00Z', submitted: true, answers, extras };
}

describe('w11 packets', () => {
  test('embedded JSON cannot close its script tag', () => {
    const hostile = { text: '</script><script>alert(1)</script><img src=x onerror=alert(1)> & \u2028' };
    const json = embedJson(hostile);
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(JSON.parse(json)).toEqual(hostile);
    const { html } = renderPacket({ packet: 'chronicle', title: 'x </title>', ...hostile } as never, '');
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("connect-src 'none'");
  });

  test('chronicle packet has 28 cards and 38 events, with UTC and Pacific times on calendar cards', () => {
    const d = chronicleData();
    expect(d.cards).toHaveLength(28);
    expect(d.cards.flatMap(c => c.events)).toHaveLength(38);
    const cal = d.cards.find(c => c.slug === 'cal/evt-0000')!;
    expect(cal.time).toEqual({ raw: '20260414T010000Z', utc_day: '2026-04-14', pacific: '04/13/2026 18:00' });
  });

  test('cat35 packet is blind, puts the 21 non-empty notes first in a seeded order', () => {
    const d = cat35Data();
    expect(d.rows).toHaveLength(24);
    expect(d.rows.slice(0, 21).every(r => !r.note_empty)).toBe(true);
    expect(d.rows.slice(21).every(r => r.note_empty)).toBe(true);
    const json = embedJson(d);
    for (const verdict of ['"FULL"', '"PARTIAL"', '"ABSENT"', 'judge_verdict', 'lane_hint']) expect(json).not.toContain(verdict);
    expect(cat35Data().rows.map(r => r.id)).toEqual(d.rows.map(r => r.id));
  });

  test('seeded shuffle is deterministic and chips come from the statement', () => {
    expect(seededShuffle([1, 2, 3, 4, 5], 7)).toEqual(seededShuffle([1, 2, 3, 4, 5], 7));
    expect(chipsFor('Bug QL-4471 in quartzlane was caused by two ingest workers')).toEqual(['QL-4471', 'quartzlane', 'caused', 'ingest', 'workers']);
  });
});

describe('w11 scoring', () => {
  test('validation rejects a date error without a corrected day and unknown ids', () => {
    const exp = exportFor('chronicle', { 'm0-meeting': { outcome: 'error', errors: ['date'] }, nope: { outcome: 'supported' } });
    const problems = validate(exp);
    expect(problems.some(p => p.includes('without a corrected day'))).toBe(true);
    expect(problems.some(p => p.includes('unknown id nope'))).toBe(true);
  });

  test('validation rejects a changed packet', () => {
    const exp = { ...exportFor('cat35', {}), packet_sha256: 'x' };
    expect(validate(exp).some(p => p.includes('packet SHA'))).toBe(true);
  });

  test('cat35 publishes nothing below 12 eligible ratings and excludes can\'t tell', () => {
    const rows = cat35Data().rows;
    const answers = Object.fromEntries(rows.slice(0, 11).map(r => [r.id, { rating: 'FULL' }]));
    answers[rows[11]!.id] = { rating: 'CANT_TELL' };
    const s = scoreCat35(exportFor('cat35', answers));
    expect(s.headline.n).toBe(11);
    expect(s.cant_tell).toBe(1);
    expect(s.publication.decision).toBe('pending');
  });

  test('clustered kappa interval resamples clusters', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ cluster: `t${i % 4}`, judge: ['FULL', 'PARTIAL', 'ABSENT'][i % 3]!, human: ['FULL', 'PARTIAL', 'ABSENT'][i % 3]! }));
    const k = clusteredKappa(pairs, 200);
    expect(k.kappa).toBe(1);
    expect(k.clusters).toBe(4);
  });

  test('chronicle revisions: not-an-event removes, corrected date replaces, added events join', () => {
    const exp = exportFor('chronicle', { 'm0-meeting': { outcome: 'error', errors: ['date'], corrected_day: '2026-04-13' } }, { 'cal/evt-0000': [{ day: '2026-04-14', description: 'sync', keywords: ['sync'] }] });
    const pages = revisedReference(exp);
    expect(pages.find(p => p.slug === 'meetings/mtg-0000')!.events[0]!.day).toBe('2026-04-13');
    expect(pages.reduce((n, p) => n + p.events.length, 0)).toBe(39);
    const s = scoreChronicle(exp);
    expect(s.revised_reference_size).toBe(39);
    expect(s.publication.decision).toBe('publish_partial');
  });

  test('chronicle with every label supported reproduces the rerun recall (37 and 38 of 38)', () => {
    const ids = chronicleData().cards.flatMap(c => c.events.map(e => e.id));
    const s = scoreChronicle(exportFor('chronicle', Object.fromEntries(ids.map(id => [id, { outcome: 'supported' }]))));
    expect(s.runs['on-a']!.matched).toBe(37);
    expect(s.runs['on-b']!.matched).toBe(38);
    expect(s.publication.decision).toBe('publish');
  });
});

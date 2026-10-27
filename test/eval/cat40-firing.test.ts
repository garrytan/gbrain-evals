import { describe, expect, test } from 'bun:test';
import { countResult, leadingJson, type FiringCounts } from '../../eval/runner/cat40/firing.ts';

const fresh = (pairs: boolean): FiringCounts => ({ cells: 0, calls: {}, names_rows: 0, names_rows_with_records: 0, names_rows_with_count: 0, record_rows: 0, delivered_units: {}, page_status_rows: 0, known_as_rows: 0, owner_phrase_referrer_rows: pairs ? 0 : null, names_call_ms: { n: 0, p50: null, p99: null } });

describe('firing counters from served tool results', () => {
  test('leadingJson reads the JSON before gbrain notice lines, and nothing from text', () => {
    expect(leadingJson('[{"a":"x]}"}]\n[gbrain notice x kind=degraded]\nwhy: y')).toEqual([{ a: 'x]}' }]);
    expect(leadingJson('Error: nope')).toBeNull();
    expect(leadingJson('{"a":')).toBeNull();
  });
  test('counts names rows with records, delivered units, page_status, known_as and owner-phrase referrers', () => {
    const c = fresh(true);
    const pairs = new Set(['mail/m1\0accounts/acme-example']);
    countResult(c, 'entity', { names: ['A', 'B', 'C'] }, JSON.stringify({ results: [
      { name: 'A', found: true, slug: 'accounts/acme-example', referenced_by_count: 3, records: [{ canonical_type: 'contract', total: 2, rows: [{ slug: 'contracts/c1', page_status: 'draft' }, { slug: 'contracts/c2' }] }] },
      { name: 'B', found: true, records: [{ canonical_type: 'contract', total: 0, rows: [] }] },
      { name: 'C', found: false },
    ] }), pairs);
    countResult(c, 'search', { query: 'q' }, `${JSON.stringify([{ slug: 'contracts/c1', delivered: { unit: 'section' } }, { slug: 'mail/m2', delivered: { unit: 'chunk' } }])}\n[gbrain search] note`, pairs);
    countResult(c, 'entity', { name: 'A' }, JSON.stringify({ found: true, card: { slug: 'accounts/acme-example', known_as: { total: 2, rows: [{}, {}] }, referenced_by: { groups: [{ rows: [{ slug: 'mail/m1' }, { slug: 'mail/m3' }] }] } } }), pairs);
    countResult(c, 'get_backlinks', { slug: 'accounts/acme-example' }, JSON.stringify([{ slug: 'mail/m1' }]), pairs);
    expect(c).toEqual({ cells: 0, calls: { entity: 2, search: 1, get_backlinks: 1 }, names_rows: 2, names_rows_with_records: 1, names_rows_with_count: 1, record_rows: 2, delivered_units: { section: 1, chunk: 1 }, page_status_rows: 1, known_as_rows: 2, owner_phrase_referrer_rows: 2, names_call_ms: { n: 0, p50: null, p99: null } });
  });
});

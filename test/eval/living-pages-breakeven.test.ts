import { describe, expect, test } from 'bun:test';
import { breakEven, decide, PRIOR, R_STAR_FLOOR, R_STAR_PRIOR, READ_OPS } from '../../eval/runner/living-pages-breakeven.ts';
import { csv } from '../../eval/runner/living-pages-csv.ts';

describe('living-pages break-even (W9 build decision)', () => {
  test('the frozen thresholds match the preregistration', () => {
    expect(Math.round(R_STAR_FLOOR * 10) / 10).toBe(8.2);
    expect(Math.round(R_STAR_PRIOR)).toBe(1387);
    expect(Math.round(breakEven({ refreshUsd: PRIOR.livingRefreshUsd, reviewMinutes: 0, usdPerMinute: 0 }) * 10) / 10).toBe(23.2);
  });

  test('review time dominates the break-even', () => {
    expect(Math.round(breakEven({ refreshUsd: 0.017, reviewMinutes: 0.25, usdPerMinute: 0.5 }))).toBe(194);
    expect(Math.round(breakEven({ refreshUsd: 0.017, reviewMinutes: 2, usdPerMinute: 5 }))).toBe(13663);
  });

  test('reads come only from the frozen read set; unknown operations are listed, not counted', () => {
    const d = decide([{ operation: 'get_page', ok: 900 }, { operation: 'query', ok: 100 }, { operation: 'put_page', ok: 50 }, { operation: 'mystery_op', ok: 7 }], 10);
    expect(d.reads).toBe(1000);
    expect(d.r_obs).toBe(100);
    expect(d.unknown_operations).toEqual(['mystery_op', 'put_page']);
    expect(d.outcome).toBe('cheaper_designs_win');
    expect(d.below_floor).toBe(false);
    expect(d.w10).toBe('dropped_with_w9');
  });

  test('a ratio at or above the prior threshold builds W9; no page-day count is indicative only', () => {
    expect(decide([{ operation: 'search', ok: 1388 }], 1).outcome).toBe('build_w9');
    expect(decide([{ operation: 'search', ok: 1386 }], 1).outcome).toBe('cheaper_designs_win');
    const none = decide([{ operation: 'search', ok: 5 }], null);
    expect(none.outcome).toBe('indicative_only');
    expect(none.w10).toBe('pending');
  });

  test('csv reads comma, tab and psql pipe tables', () => {
    const psql = ' operation | calls | ok | first_at | last_at\n-----------+-------+----+----------+---------\n get_page  |   12 | 11 | x | y\n search    |    3 |  3 | x | y\n(2 rows)\n';
    expect(csv(psql)).toEqual([{ operation: 'get_page', ok: 11 }, { operation: 'search', ok: 3 }]);
    expect(csv('operation,calls,ok\nquery,4,4\n')).toEqual([{ operation: 'query', ok: 4 }]);
    expect(READ_OPS).toContain('think');
  });
});

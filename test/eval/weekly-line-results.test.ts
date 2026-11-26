/**
 * The weekly held-out line's stop-and-publish results page (docs/benchmarks/2026-11-23-weekly-outcome-line.md) prints
 * only numbers that eval/runner/weekly-line/results-recount.ts recounts from the committed per-question records. Keyless:
 * it reads committed files only.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mcnemar, OPUS, PARTICLE, recount } from '../../eval/runner/weekly-line/results-recount.ts';

const PAGE = readFileSync(resolve(import.meta.dir, '../../docs/benchmarks/2026-11-23-weekly-outcome-line.md'), 'utf8');

describe("the weekly line's published numbers recount from the committed records", () => {
  const r = recount();

  // Value: protects=every count, accuracy, per-world split, cost per right answer, paired discordant list, McNemar p and gbrain build the results page prints comes from the committed answers, gating judgments and lease summaries; fails_when=a committed record changes, the recount's right-answer rule or alias split drifts, or the page prints a number the records don't give; why_new=GBEV-3's stop-and-publish ruling of 2026-11-26 (a recount that recomputes every published number); seam=results-recount.ts recount over docs/benchmarks/2026-11-23-weekly-outcome-line/pilot; no_claim=the judge's agreement with people, which the page reports as unchecked
  test('the grep agent, the one-world rows and stage 2 recount to the page', () => {
    const g = r.grep_agent;
    expect([g['named-200k'][OPUS].right, g['named-200k'][OPUS].accuracy, g['named-200k'][PARTICLE].right]).toEqual([190, 0.9896, 180]);
    expect([g['named-1m'][OPUS].right, g['named-1m'][PARTICLE].right, g['named-1m'][PARTICLE].worlds]).toEqual([192, 180, { 'bg1-dev-long-01': '58/64', 'bg1-dev-long-02': '61/64', 'bg1-dev-long-03': '61/64' }]);
    expect([g['alias-stage1'][OPUS].right, g['alias-stage1'][PARTICLE].right]).toEqual([173, 171]);
    expect([g['named-200k'][OPUS].usd_per_right, g['named-200k'][PARTICLE].usd_per_right, g['named-1m'][OPUS].usd_per_right, g['named-1m'][PARTICLE].usd_per_right, g['alias-stage1'][OPUS].usd_per_right, g['alias-stage1'][PARTICLE].usd_per_right])
      .toEqual([0.0241, 0.0041, 0.0344, 0.006, 0.0762, 0.0189]);
    expect(r.alias_split).toEqual({ [OPUS]: { misspelling: '22/34', plain: '151/158', plain_accuracy: 0.956 }, [PARTICLE]: { misspelling: '26/34', plain: '145/158', plain_accuracy: 0.918 } });
    const one = (stage: 'named-200k' | 'named-1m') => Object.fromEntries(Object.entries(r.rows[stage]).map(([k, v]) => [k, `${v.right}/${v.n}`]));
    expect(one('named-200k')).toEqual({ 'grep-agent-pilot': '63/64', gbrain: '63/64', 'extract-first': '63/64', 'memory-bank': '59/64' });
    expect(one('named-1m')).toEqual({ 'grep-agent-pilot': '64/64', gbrain: '63/64', 'extract-first': '63/64', 'memory-bank': '62/64' });
    expect([r.rows['named-200k'].gbrain.gbrain, r.rows['named-1m'].gbrain.gbrain, r.stage2.gbrain.gbrain]).toEqual([
      'v0.60.768.0 (528595df98b0277640673455d8640e8887a6d1e9)', 'v0.60.769.0 (38831bb696139024923e9bc43e3da0d7993951e9)', 'v0.60.774.0 (e8791f54e6b12cfa307363c3414b5bfe43db0b8a)']);
    expect(r.stage2.grep).toBe('22/34');
    const s2 = (row: 'extract-first' | 'memory-bank' | 'gbrain') => { const s = r.stage2[row]; return [s.right, s.row_right_grep_wrong.length, s.grep_right_row_wrong.length, s.mcnemar_p, s.diff_pp, s.wald95_pp, s.cell_usd_per_right]; };
    expect(s2('extract-first')).toEqual([11, 1, 12, 0.00342, -32.4, [-50.1, -14.6], 1.157]);
    expect(s2('memory-bank')).toEqual([8, 1, 15, 0.000519, -41.2, [-59.6, -22.7], 0.334]);
    expect(s2('gbrain')).toEqual([2, 0, 20, 0.00000191, -58.8, [-75.4, -42.3], 1.324]);
    expect([r.stage2['extract-first'].row_right_grep_wrong, r.stage2['memory-bank'].row_right_grep_wrong]).toEqual([['bg1-dev-alias-03:s1_updated:4'], ['bg1-dev-alias-01:s4_conflicting:5']]);
    expect(r.judged_wrong['named-1m']).toEqual({ [OPUS]: '12 wrong of 192', 'openai:gpt-6-astra': '0 wrong of 192' });
    expect(r.judged_wrong['alias-stage1']).toEqual({ [OPUS]: '20 wrong of 191', 'openai:gpt-6-astra': '19 wrong of 192' });
    expect(r.stage2_resumes).toEqual({ gbrain: { first_lease_answers: 33, resumed_from_its_snapshot: true }, 'memory-bank': { first_lease_answers: 31, resumed_from_its_snapshot: true } });
  });

  // Value: protects=the exact McNemar test the page's p-values come from: two-sided, binomial at one half on the discordant pairs; fails_when=the tail sum or doubling changes; why_new=the stage-2 table's primary test; seam=results-recount.ts mcnemar; no_claim=power at n = 34
  test('the exact McNemar test matches known values', () => {
    expect(mcnemar(0, 0)).toBe(1);
    expect(mcnemar(1, 1)).toBe(1);
    expect(mcnemar(0, 5)).toBeCloseTo(0.0625, 10);
    expect(mcnemar(2, 8)).toBeCloseTo(0.109375, 10);
  });

  // Value: protects=the page never prints the stop rule's construction readings, which misread answers that narrate a value's history; fails_when=either reading appears on the page; why_new=GBEV-3's ruling of 2026-11-26 (the 0.044 and 0.099 construction readings are never published); seam=the page's text; no_claim=other pages
  test('the page prints neither construction reading', () => {
    for (const n of ['0.099', '0.044', '9.9%', '4.4%']) expect(PAGE).not.toContain(n);
  });
});

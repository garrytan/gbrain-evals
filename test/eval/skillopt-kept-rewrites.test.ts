import { describe, expect, test } from 'bun:test';
import { KEPT_REWRITES, readKeptRewrite } from '../../eval/runner/skillopt-method/kept-rewrites.ts';
import { readSeed } from '../../eval/runner/skillopt-method/dataset.ts';

describe("#304's kept rewrites with their caveats fixed", () => {
  test('query is the receipt unchanged', () => {
    expect(KEPT_REWRITES.query.edits).toEqual([]);
    expect(readKeptRewrite('query').length).toBeGreaterThan(1000);
  });

  test('briefing loses only its [withheld] slug rule', () => {
    const text = readKeptRewrite('briefing');
    expect(text).not.toContain('[withheld]');
    expect(text).toContain('in that meeting\'s section.');
    expect(text).toContain('They never replace the governing record.\n3. **A missing participant');
  });

  test("fact-check carries the seed's unverifiable thresholds again", () => {
    const text = readKeptRewrite('fact-check');
    expect(text).toContain('<5% unverifiable');
    expect(text).toContain('5-15% unverifiable');
    const seed = readSeed('fact-check');
    expect(seed).toContain('<5% unverifiable');
    expect(seed).toContain('5-15% unverifiable');
  });
});

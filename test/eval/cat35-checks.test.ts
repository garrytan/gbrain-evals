/**
 * cat35-checks.ts tests — pure mechanical checks, $0, no network.
 *
 * Covers: normalizeWs / anchorPresent hostile cases, extractQuotes thresholds,
 * quoteFidelity whitespace variants, hasWikilink, slugDisciplineOk (incl.
 * globs), selfContainedOpening, segmentClaims drop rules, scanDistractors,
 * addedContent (rewrite = added), compressionRatio, thresholdCurve,
 * weightedKappa (perfect / hand-computed / weighted-vs-unweighted),
 * bootstrapCI determinism, seededSample determinism, computeDelta guards.
 */

import { describe, test, expect } from 'bun:test';
import {
  addedContent,
  anchorPresent,
  bootstrapCI,
  compressionRatio,
  computeDelta,
  extractQuotes,
  hasWikilink,
  normalizeWs,
  quoteFidelity,
  scanDistractors,
  seededSample,
  segmentClaims,
  selfContainedOpening,
  slugDisciplineOk,
  thresholdCurve,
  weightedKappa,
  type TriageVerdictRow,
} from '../../eval/runner/cat35-checks.ts';

// ─── normalizeWs + anchorPresent ──────────────────────────────────────────

describe('normalizeWs', () => {
  test('collapses runs of spaces, tabs, newlines to a single space and trims', () => {
    expect(normalizeWs('  a\tb\n\nc   d ')).toBe('a b c d');
  });

  test('collapses unicode spaces (NBSP, thin space)', () => {
    expect(normalizeWs('a b c')).toBe('a b c');
  });

  test('preserves case', () => {
    expect(normalizeWs('  Foo BAR  ')).toBe('Foo BAR');
  });
});

describe('anchorPresent', () => {
  const anchor = 'the flux capacitor overheated at 88mph';

  test('exact match', () => {
    expect(anchorPresent(anchor, `logs show ${anchor} again`)).toBe(true);
  });

  test('whitespace variants in text still match', () => {
    const text = 'note:  the   flux\ncapacitor\toverheated at 88mph, sadly';
    expect(anchorPresent(anchor, text)).toBe(true);
  });

  test('whitespace variants in anchor still match', () => {
    expect(anchorPresent('the  flux\ncapacitor overheated at 88mph', anchor)).toBe(true);
  });

  test('near-miss (one word changed) does not match', () => {
    expect(anchorPresent(anchor, 'the flux capacitor overheated at 89mph')).toBe(false);
  });

  test('case-INSENSITIVE: casing differences match (generator gate parity)', () => {
    // The generator validates anchors case-insensitively, so the committed
    // corpus contains case-shifted anchors (measured: 14/261). "Is this
    // phrase present" is a case-insensitive question — a case-sensitive
    // scanner made 3 distractor anchors permanently invisible to leakage.
    expect(anchorPresent('The Flux Capacitor', 'the flux capacitor')).toBe(true);
    expect(anchorPresent('the flux capacitor', 'The Flux Capacitor overheated')).toBe(true);
  });

  test('empty / whitespace-only anchor is never present', () => {
    expect(anchorPresent('', 'anything at all')).toBe(false);
    expect(anchorPresent('  \n\t ', 'anything at all')).toBe(false);
  });

  test('hostile: anchor-shaped lines in the text do not create false hits', () => {
    // Text mentions the anchor FIELD but not the anchor CONTENT.
    const text = 'gold file schema: {item_id, statement, verbatim_anchor, notability}';
    expect(anchorPresent(anchor, text)).toBe(false);
  });
});

// ─── extractQuotes + quoteFidelity ────────────────────────────────────────

describe('extractQuotes', () => {
  test('blockquotes of ANY length qualify, joined per block', () => {
    const body = [
      'intro line',
      '> short one', // <40 chars — still a blockquote
      '',
      '> first line of a longer block',
      '> second line of the same block',
      'outro',
    ].join('\n');
    const { blockquotes } = extractQuotes(body);
    expect(blockquotes).toEqual([
      'short one',
      'first line of a longer block second line of the same block',
    ]);
  });

  test('empty blockquote blocks (bare >) are dropped', () => {
    const { blockquotes } = extractQuotes('>\n>\ntext');
    expect(blockquotes).toEqual([]);
  });

  test('inline double-quoted spans only qualify at ≥40 chars', () => {
    const long = 'this quoted span is definitely long enough to qualify';
    expect(long.length).toBeGreaterThanOrEqual(40);
    const body = `He said "too short" but also "${long}" later.`;
    const { inlineSpans } = extractQuotes(body);
    expect(inlineSpans).toEqual([long]);
  });

  test('curly-quoted spans of ≥40 chars qualify too', () => {
    const long = 'a curly quoted span that is also long enough to count';
    const { inlineSpans } = extractQuotes(`She wrote “${long}” there.`);
    expect(inlineSpans).toEqual([long]);
  });

  test('inline spans do not cross newlines (unbalanced-quote guard)', () => {
    const body = 'a stray " quote here\nand forty-plus characters of text before another " mark';
    expect(extractQuotes(body).inlineSpans).toEqual([]);
  });
});

describe('quoteFidelity', () => {
  const transcript =
    'User: the deploy failed because the config parser rejected duplicate keys in staging.\n' +
    'Agent: I will patch the parser to fail loudly on duplicate keys.';

  test('blockquote with whitespace variants is grounded', () => {
    const body = '> the deploy failed   because the\n> config parser rejected duplicate keys in staging.';
    expect(quoteFidelity(body, transcript)).toEqual({ total: 1, grounded: 1 });
  });

  test('fabricated quote is counted but not grounded', () => {
    const body = '> the deploy failed because the moon phase was wrong for the release window';
    expect(quoteFidelity(body, transcript)).toEqual({ total: 1, grounded: 0 });
  });

  test('mix of blockquotes and qualifying inline spans, all checked', () => {
    const inline = 'I will patch the parser to fail loudly on duplicate keys';
    expect(inline.length).toBeGreaterThanOrEqual(40);
    const body = `> the deploy failed because the config parser rejected duplicate keys in staging.\n\nThe agent said "${inline}" and moved on.`;
    expect(quoteFidelity(body, transcript)).toEqual({ total: 2, grounded: 2 });
  });

  test('no quotes at all → 0/0 (page-level joint check catches this elsewhere)', () => {
    expect(quoteFidelity('plain prose, no quoting here.', transcript)).toEqual({ total: 0, grounded: 0 });
  });
});

// ─── hasWikilink ──────────────────────────────────────────────────────────

describe('hasWikilink', () => {
  test('[[wikilink]] counts', () => {
    expect(hasWikilink('see [[people/jane-doe]] for context')).toBe(true);
  });

  test('markdown link with non-http target counts', () => {
    expect(hasWikilink('see [Jane](people/jane-doe) for context')).toBe(true);
  });

  test('http/https markdown links do NOT count', () => {
    expect(hasWikilink('see [docs](https://example.com/docs)')).toBe(false);
    expect(hasWikilink('see [docs](http://example.com)')).toBe(false);
  });

  test('plain text and empty brackets do not count', () => {
    expect(hasWikilink('no links here at all')).toBe(false);
    expect(hasWikilink('array indexing a[0] and b(1) is not a link')).toBe(false);
  });
});

// ─── slugDisciplineOk ─────────────────────────────────────────────────────

describe('slugDisciplineOk', () => {
  const prefixes = ['wiki/personal/reflections/', 'wiki/originals/ideas/'];

  test('accepts a lowercase hyphenated slug under an allowed prefix', () => {
    expect(slugDisciplineOk('wiki/personal/reflections/2026-08-01-deploy-retro', prefixes)).toBe(true);
  });

  test('rejects underscores', () => {
    expect(slugDisciplineOk('wiki/personal/reflections/deploy_retro', prefixes)).toBe(false);
  });

  test('rejects .md suffix (dots are not slug characters)', () => {
    expect(slugDisciplineOk('wiki/personal/reflections/deploy-retro.md', prefixes)).toBe(false);
  });

  test('rejects uppercase', () => {
    expect(slugDisciplineOk('wiki/personal/reflections/Deploy-Retro', prefixes)).toBe(false);
  });

  test('rejects slugs outside the allowlist', () => {
    expect(slugDisciplineOk('wiki/random/deploy-retro', prefixes)).toBe(false);
  });

  test('trailing-* glob prefixes match any subpath', () => {
    expect(slugDisciplineOk('wiki/personal/deep/nested/note', ['wiki/personal/*'])).toBe(true);
    expect(slugDisciplineOk('wiki/other/note', ['wiki/personal/*'])).toBe(false);
  });

  test('empty allowlist = shape-only check', () => {
    expect(slugDisciplineOk('any/valid-shape/slug', [])).toBe(true);
    expect(slugDisciplineOk('bad_shape', [])).toBe(false);
  });

  test('rejects empty slug and empty segments', () => {
    expect(slugDisciplineOk('', [])).toBe(false);
    expect(slugDisciplineOk('wiki//double-slash', [])).toBe(false);
  });
});

// ─── selfContainedOpening ─────────────────────────────────────────────────

const GOOD_OPENING =
  'This page captures the outcome of the staging deploy retro from early August. ' +
  'The team decided to make the config parser fail loudly on duplicate keys after a silent failure cost a day.';

describe('selfContainedOpening', () => {
  test('accepts ≥2 sentences and ≥120 chars after frontmatter + heading', () => {
    const body = `---\ntitle: Deploy retro\n---\n\n# Deploy retro\n\n${GOOD_OPENING}\n\n> some quote later`;
    expect(GOOD_OPENING.length).toBeGreaterThanOrEqual(120);
    expect(selfContainedOpening(body)).toBe(true);
  });

  test('rejects a blockquote before any paragraph', () => {
    const body = `# Title\n\n> ${GOOD_OPENING}\n\n${GOOD_OPENING}`;
    expect(selfContainedOpening(body)).toBe(false);
  });

  test('rejects a single short sentence', () => {
    expect(selfContainedOpening('# T\n\nShort opening only.')).toBe(false);
  });

  test('rejects two sentences that are under 120 chars total', () => {
    expect(selfContainedOpening('Tiny one. Tiny two.')).toBe(false);
  });

  test('rejects one long sentence with no second sentence', () => {
    const one =
      'This single sentence is quite long and rambles on about the deploy retro and the config parser without ever actually stopping for a full stop until the very end.';
    expect(selfContainedOpening(one)).toBe(false);
  });
});

// ─── segmentClaims ────────────────────────────────────────────────────────

describe('segmentClaims', () => {
  const body = [
    '---',
    'title: Deploy retro',
    'dream_generated: true',
    '---',
    '# Deploy retro heading should be dropped entirely',
    '',
    'The config parser rejected duplicate keys in staging. The team lost a full day chasing the silent failure.',
    '',
    '- The team decided to make the parser fail loudly on duplicates',
    '- shipped it', // <5 words — dropped
    '',
    '```',
    'This looks like a sentence inside a code fence and must be dropped.',
    '```',
    '',
    '> This blockquote line is covered by quote fidelity, not claims.',
    '',
    '- [[people/jane-doe]], [[companies/acme]]', // wikilink-only — dropped
    '',
    'Related context lives in [[projects/parser-rewrite]] which the team already tracks weekly.',
    '',
    'Should we revisit the retry policy next quarter as well?', // question — dropped
  ].join('\n');

  const claims = segmentClaims(body);

  test('keeps declarative sentences from paragraphs (split on sentence boundaries)', () => {
    expect(claims).toContain('The config parser rejected duplicate keys in staging.');
    expect(claims).toContain('The team lost a full day chasing the silent failure.');
  });

  test('keeps bullet items ≥5 words', () => {
    expect(claims).toContain('The team decided to make the parser fail loudly on duplicates');
  });

  test('drops bullets under 5 words', () => {
    expect(claims).not.toContain('shipped it');
  });

  test('drops fenced code block content', () => {
    expect(claims.some((c) => c.includes('code fence'))).toBe(false);
  });

  test('drops headings', () => {
    expect(claims.some((c) => c.includes('heading should be dropped'))).toBe(false);
  });

  test('drops blockquote lines', () => {
    expect(claims.some((c) => c.includes('quote fidelity'))).toBe(false);
  });

  test('drops wikilink-only lines but keeps prose containing a wikilink', () => {
    expect(claims.some((c) => c === '[[people/jane-doe]], [[companies/acme]]')).toBe(false);
    expect(claims.some((c) => c.includes('[[projects/parser-rewrite]]'))).toBe(true);
  });

  test('drops questions', () => {
    expect(claims.some((c) => c.endsWith('?'))).toBe(false);
  });

  test('drops frontmatter', () => {
    expect(claims.some((c) => c.includes('dream_generated'))).toBe(false);
  });

  test('~~~ fences are honored too', () => {
    const claims2 = segmentClaims('~~~\nA fenced sentence with more than five words here.\n~~~\n');
    expect(claims2).toEqual([]);
  });
});

// ─── scanDistractors ──────────────────────────────────────────────────────

describe('scanDistractors', () => {
  const distractors = [
    { id: 'd-1', anchor: 'renewed the parking permit for lot 7' },
    { id: 'd-2', anchor: 'ordered a replacement HDMI cable' },
  ];

  test('returns only ids whose anchor is present (normalized-ws)', () => {
    const text = 'Between builds the user renewed the   parking permit\nfor lot 7 and moved on.';
    expect(scanDistractors(distractors, text)).toEqual(['d-1']);
  });

  test('empty text → no hits', () => {
    expect(scanDistractors(distractors, '')).toEqual([]);
  });
});

// ─── addedContent ─────────────────────────────────────────────────────────

describe('addedContent', () => {
  const seeded = ['# Jane Doe', '', 'Partner at Acme Capital.', 'Focus on infra.'].join('\n');

  test('lines added by the dream lane are returned', () => {
    const current = seeded + '\nMet during the parser incident; decided to co-review deploys.';
    expect(addedContent(seeded, current)).toBe('Met during the parser incident; decided to co-review deploys.');
  });

  test('a REWRRITTEN line counts as added (no fuzzy matching)', () => {
    const current = ['# Jane Doe', '', 'Partner at Acme Capital, now leading the infra fund.', 'Focus on infra.'].join(
      '\n',
    );
    expect(addedContent(seeded, current)).toBe('Partner at Acme Capital, now leading the infra fund.');
  });

  test('identical body → empty diff (blank lines ignored)', () => {
    expect(addedContent(seeded, seeded + '\n\n\n')).toBe('');
  });

  test('duplicate lines: only the surplus copies count as added', () => {
    const current = seeded + '\nFocus on infra.';
    expect(addedContent(seeded, current)).toBe('Focus on infra.');
  });

  test('whitespace-only changes to a line do not count as added', () => {
    const current = seeded.replace('Focus on infra.', '   Focus on infra.  ');
    expect(addedContent(seeded, current)).toBe('');
  });
});

// ─── compressionRatio ─────────────────────────────────────────────────────

describe('compressionRatio', () => {
  test('chars/4 approximation on both sides → plain length ratio', () => {
    expect(compressionRatio('a'.repeat(100), 'b'.repeat(400))).toBeCloseTo(0.25, 10);
  });

  test('empty transcript → 0, never Infinity', () => {
    expect(compressionRatio('anything', '')).toBe(0);
  });

  test('empty output → 0', () => {
    expect(compressionRatio('', 'b'.repeat(400))).toBe(0);
  });
});

// ─── thresholdCurve ───────────────────────────────────────────────────────

describe('thresholdCurve', () => {
  const rows: TriageVerdictRow[] = [
    { transcript_id: 'h1', score: 0.9, expected: 'high' },
    { transcript_id: 'h2', score: 0.6, expected: 'high' },
    { transcript_id: 'h3', score: 0.4, expected: 'high' },
    { transcript_id: 'l1', score: 0.2, expected: 'low' },
    { transcript_id: 'l2', score: 0.55, expected: 'low' },
  ];

  test('default thresholds 0.3 / 0.5 / 0.7 with hand-computed rates', () => {
    const curve = thresholdCurve(rows);
    expect(curve.map((c) => c.threshold)).toEqual([0.3, 0.5, 0.7]);
    // t=0.3: all 3 high pass; low: only 0.55 passes.
    expect(curve[0]).toEqual({ threshold: 0.3, high_pass_rate: 1, low_pass_rate: 0.5, accuracy: 0.8 });
    // t=0.5: high 2/3 pass; low 1/2 pass → (2 + 1) / 5 correct.
    expect(curve[1].high_pass_rate).toBeCloseTo(2 / 3, 10);
    expect(curve[1].low_pass_rate).toBe(0.5);
    expect(curve[1].accuracy).toBeCloseTo(0.6, 10);
    // t=0.7: high 1/3; low 0/2 → (1 + 2) / 5.
    expect(curve[2].high_pass_rate).toBeCloseTo(1 / 3, 10);
    expect(curve[2].low_pass_rate).toBe(0);
    expect(curve[2].accuracy).toBeCloseTo(0.6, 10);
  });

  test('custom thresholds are honored', () => {
    const curve = thresholdCurve(rows, [0.0]);
    expect(curve).toHaveLength(1);
    expect(curve[0].high_pass_rate).toBe(1);
    expect(curve[0].low_pass_rate).toBe(1);
  });

  test('empty groups yield 0 rates, empty rows yield 0 accuracy', () => {
    const curve = thresholdCurve([], [0.5]);
    expect(curve[0]).toEqual({ threshold: 0.5, high_pass_rate: 0, low_pass_rate: 0, accuracy: 0 });
  });
});

// ─── weightedKappa ────────────────────────────────────────────────────────

/** Plain (unweighted) Cohen's kappa — local to the test, for the contrast case. */
function unweightedKappa(a: string[], b: string[], labels: string[]): number {
  const n = a.length;
  const po = a.filter((x, i) => x === b[i]).length / n;
  let pe = 0;
  for (const l of labels) {
    pe += (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n);
  }
  return (po - pe) / (1 - pe);
}

describe('weightedKappa', () => {
  test('perfect agreement = 1, even with degenerate marginals', () => {
    expect(weightedKappa(['FULL', 'FULL', 'FULL'], ['FULL', 'FULL', 'FULL'])).toBe(1);
    expect(weightedKappa(['FULL', 'ABSENT'], ['FULL', 'ABSENT'])).toBe(1);
  });

  test('throws on length mismatch', () => {
    expect(() => weightedKappa(['FULL'], ['FULL', 'ABSENT'])).toThrow(/length mismatch/);
  });

  test('throws on unknown label', () => {
    expect(() => weightedKappa(['FULL'], ['MAYBE'])).toThrow(/unknown label/);
  });

  test('known 3x3 case computed by hand = 0.25', () => {
    // a = [F,F,P,P,A,A], b = [F,P,P,A,A,F]:
    // observed weighted disagreement = (0+1+0+1+0+2)/6 = 2/3
    // uniform marginals → expected = 8/9; kappa = 1 − (2/3)/(8/9) = 0.25
    const a = ['FULL', 'FULL', 'PARTIAL', 'PARTIAL', 'ABSENT', 'ABSENT'];
    const b = ['FULL', 'PARTIAL', 'PARTIAL', 'ABSENT', 'ABSENT', 'FULL'];
    expect(weightedKappa(a, b)).toBeCloseTo(0.25, 10);
  });

  test('linear weighting penalizes FULL↔ABSENT more than unweighted kappa does', () => {
    // Single disagreement is the extreme FULL↔ABSENT pair:
    // weighted = 0.5 by hand; unweighted = 0.4375/0.6875 ≈ 0.6364.
    const a = ['FULL', 'FULL', 'PARTIAL', 'ABSENT'];
    const b = ['ABSENT', 'FULL', 'PARTIAL', 'ABSENT'];
    const weighted = weightedKappa(a, b);
    const unweighted = unweightedKappa(a, b, ['FULL', 'PARTIAL', 'ABSENT']);
    expect(weighted).toBeCloseTo(0.5, 10);
    expect(unweighted).toBeCloseTo(7 / 11, 10);
    expect(Math.abs(weighted - unweighted)).toBeGreaterThan(0.05);
  });

  test('custom ordered labels work', () => {
    expect(weightedKappa(['pass', 'fail'], ['pass', 'fail'], ['pass', 'partial', 'fail'])).toBe(1);
  });

  test('empty input → NaN (no data, no statement)', () => {
    expect(Number.isNaN(weightedKappa([], []))).toBe(true);
  });
});

// ─── bootstrapCI ──────────────────────────────────────────────────────────

describe('bootstrapCI', () => {
  const sample = [0.9, 0.85, 1.0, 0.7, 0.95, 0.8, 0.75, 1.0, 0.9, 0.65];

  test('deterministic for a fixed seed', () => {
    const a = bootstrapCI(sample, 35);
    const b = bootstrapCI(sample, 35, 1000);
    expect(a).toEqual(b);
  });

  test('different seeds give (almost surely) different intervals', () => {
    const a = bootstrapCI(sample, 35);
    const b = bootstrapCI(sample, 36);
    expect(a.lo === b.lo && a.hi === b.hi).toBe(false);
  });

  test('mean is the plain sample mean; lo ≤ mean ≤ hi', () => {
    const { lo, hi, mean } = bootstrapCI(sample, 35);
    const expectedMean = sample.reduce((x, y) => x + y, 0) / sample.length;
    expect(mean).toBeCloseTo(expectedMean, 10);
    expect(lo).toBeLessThanOrEqual(mean);
    expect(hi).toBeGreaterThanOrEqual(mean);
    expect(lo).toBeGreaterThanOrEqual(Math.min(...sample));
    expect(hi).toBeLessThanOrEqual(Math.max(...sample));
  });

  test('single-element input collapses to that value', () => {
    expect(bootstrapCI([0.5], 7)).toEqual({ lo: 0.5, hi: 0.5, mean: 0.5 });
  });

  test('empty input → NaN triple', () => {
    const r = bootstrapCI([], 1);
    expect(Number.isNaN(r.lo)).toBe(true);
    expect(Number.isNaN(r.hi)).toBe(true);
    expect(Number.isNaN(r.mean)).toBe(true);
  });
});

// ─── seededSample ─────────────────────────────────────────────────────────

describe('seededSample', () => {
  const pool = Array.from({ length: 20 }, (_, i) => `item-${i}`);

  test('deterministic for a fixed seed', () => {
    expect(seededSample(pool, 5, 42)).toEqual(seededSample(pool, 5, 42));
  });

  test('different seeds give a different draw', () => {
    expect(seededSample(pool, 5, 42)).not.toEqual(seededSample(pool, 5, 43));
  });

  test('without replacement: no duplicates, all from the pool', () => {
    const draw = seededSample(pool, 10, 7);
    expect(new Set(draw).size).toBe(10);
    for (const d of draw) expect(pool).toContain(d);
  });

  test('n ≥ length returns a full permutation; input not mutated', () => {
    const before = pool.slice();
    const draw = seededSample(pool, 100, 1);
    expect(draw.slice().sort()).toEqual(pool.slice().sort());
    expect(pool).toEqual(before);
  });

  test('n ≤ 0 returns empty', () => {
    expect(seededSample(pool, 0, 1)).toEqual([]);
  });
});

// ─── computeDelta ─────────────────────────────────────────────────────────

describe('computeDelta', () => {
  const current = {
    mode: 'full',
    lanes: ['verbatim', 'facts', 'dream'],
    corpus: 'transcript-distill-v1',
    headline: { dream_macro: 0.8, verbatim_macro: 0.98 },
  };

  test('null prior → not comparable', () => {
    const r = computeDelta(current, null);
    expect(r.comparable).toBe(false);
    expect(r.skipped_reason).toContain('no prior run');
  });

  test('mode mismatch → skipped with reason', () => {
    const r = computeDelta(current, { ...current, mode: 'b-pre-validity' });
    expect(r.comparable).toBe(false);
    expect(r.skipped_reason).toContain('mode mismatch');
  });

  test('lanes compared order-insensitively', () => {
    const r = computeDelta(current, {
      mode: 'full',
      lanes: ['dream', 'verbatim', 'facts'],
      corpus: 'transcript-distill-v1',
      headline: { dream_macro: 0.75 },
    });
    expect(r.comparable).toBe(true);
  });

  test('lanes mismatch → skipped with reason', () => {
    const r = computeDelta(current, { ...current, lanes: ['dream'] });
    expect(r.comparable).toBe(false);
    expect(r.skipped_reason).toContain('lanes mismatch');
  });

  test('corpus mismatch → skipped with reason', () => {
    const r = computeDelta(current, { ...current, corpus: 'transcript-distill-v2' });
    expect(r.comparable).toBe(false);
    expect(r.skipped_reason).toContain('corpus mismatch');
  });

  test('prior with missing fields (legacy receipt) → skipped, never throws', () => {
    const r = computeDelta(current, {});
    expect(r.comparable).toBe(false);
  });

  test('happy path: deltas over shared headline keys only', () => {
    const r = computeDelta(current, {
      mode: 'full',
      lanes: ['verbatim', 'facts', 'dream'],
      corpus: 'transcript-distill-v1',
      headline: { dream_macro: 0.7, facts_macro: 0.6 }, // facts_macro absent in current, verbatim absent in prior
    });
    expect(r.comparable).toBe(true);
    expect(Object.keys(r.deltas!)).toEqual(['dream_macro']);
    expect(r.deltas!.dream_macro.prior).toBe(0.7);
    expect(r.deltas!.dream_macro.current).toBe(0.8);
    expect(r.deltas!.dream_macro.delta).toBeCloseTo(0.1, 10);
  });
});

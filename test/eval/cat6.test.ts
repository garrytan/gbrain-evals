/**
 * cat6-prose-scale.ts tests — hermetic (no LLM, no DB, no network; the SUT
 * is gbrain's pure `extractPageLinks`).
 *
 * Regression coverage for the 2026-08-31 audit findings, each proven BOTH
 * ways (fails on bad behavior, passes on good input):
 *   - retrieval-cats-04: link_precision scores the labeled universe only —
 *     unlabeled base-corpus links no longer pollute the denominator, and a
 *     labeled false positive still drags precision below 1.
 *   - retrieval-cats-05: prose_only_mention is excluded from generation and
 *     denominators (no gbrain pass links bare prose names) and is reported
 *     as a boundary under kinds_not_exercised.
 *   - retrieval-cats-06: substring_fp_rate can now fire — the near-miss
 *     bare-path trap turns a prefix-truncation bug into a scored FP — and
 *     stays 0 under the real extractor.
 *   - retrieval-cats-14: ambiguous_role gold is type-enforced via
 *     scoreGoldDelta; a works_at emission is a mistyped failure that fails
 *     the type-match gate.
 * Plus: receipt written by main() with run_status/verdict/publishable, and
 * skips exit non-zero without --allow-skip.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GATES,
  SCORED_INJECTION_KINDS,
  aggregate,
  generateVariants,
  hyphenTruncatingExtraction,
  main,
  makeCorpusResolver,
  noCodeStripExtraction,
  runNegativeControls,
  scoreExtraction,
  scoreVariant,
  type BasePage,
  type ExtractedLink,
  type VariantCase,
  type VariantResult,
} from '../../eval/runner/cat6-prose-scale.ts';
import { ALL_INJECTION_KINDS } from '../../eval/runner/adversarial-injections.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

const TINY_CORPUS: BasePage[] = [
  {
    slug: 'people/amara',
    type: 'person',
    title: 'Amara Okafor',
    content: 'Amara is a partner at [Halfway](companies/halfway).',
  },
  {
    slug: 'people/jordan',
    type: 'person',
    title: 'Jordan Park',
    content: 'Jordan founded [NovaMind](companies/novamind) in 2023.',
  },
  {
    slug: 'people/mina',
    type: 'person',
    title: 'Mina Kapoor',
    content: 'Mina runs [Threshold](companies/threshold).',
  },
  {
    slug: 'people/sarah',
    type: 'person',
    title: 'Sarah Chen',
    content: 'Sarah advises several seed-stage founders.',
  },
  {
    slug: 'companies/halfway',
    type: 'company',
    title: 'Halfway Capital',
    content: 'VC firm focused on climate + AI infrastructure.',
  },
  {
    slug: 'companies/novamind',
    type: 'company',
    title: 'NovaMind',
    content: 'AI infrastructure startup.',
  },
  {
    slug: 'companies/threshold',
    type: 'company',
    title: 'Threshold',
    content: 'Venture firm.',
  },
];

async function scoreAll(variants: VariantCase[]): Promise<VariantResult[]> {
  const resolver = makeCorpusResolver(TINY_CORPUS);
  const out: VariantResult[] = [];
  for (const v of variants) out.push(await scoreVariant(v, resolver));
  return out;
}

// ─── Variant generation ───────────────────────────────────────────────

describe('generateVariants', () => {
  test('produces exactly perKind × scored-kinds variants', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 3 });
    expect(variants.length).toBe(3 * SCORED_INJECTION_KINDS.length);
    expect(SCORED_INJECTION_KINDS.length).toBe(5);
  });

  test('never generates prose_only_mention by default (retrieval-cats-05)', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 4 });
    expect(variants.some(v => v.kind === 'prose_only_mention')).toBe(false);
    // The kind still exists in the injection module; the exclusion is Cat 6's.
    expect(ALL_INJECTION_KINDS.includes('prose_only_mention')).toBe(true);
  });

  test('deterministic under fixed seed', () => {
    const a = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 42 });
    const b = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 42 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].variantId).toBe(b[i].variantId);
      expect(a[i].content).toBe(b[i].content);
    }
  });

  test('different seeds produce different content', () => {
    const a = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 42 });
    const b = generateVariants(TINY_CORPUS, { perKind: 2, baseSeed: 99 });
    const aCodeFences = a.filter(v => v.kind === 'code_fence_leak');
    const bCodeFences = b.filter(v => v.kind === 'code_fence_leak');
    expect(aCodeFences[0].content).not.toBe(bCodeFences[0].content);
  });

  test('variantId follows "<slug>-v<idx>-<kind>" pattern', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 1 });
    for (const v of variants) {
      expect(v.variantId).toMatch(/^.+-v\d+-[a-z_]+$/);
      expect(v.variantId.endsWith(`-${v.kind}`)).toBe(true);
    }
  });

  test('substring_collision variants carry the near-miss bare-path trap (retrieval-cats-06)', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 3 });
    const subs = variants.filter(v => v.kind === 'substring_collision');
    expect(subs.length).toBe(3);
    for (const v of subs) {
      const forbidden = v.goldDelta.must_not_extract[0].slug;
      // The trap is forbidden-slug + '-<suffix>' as a bare path; the exact
      // forbidden slug never appears as its own token.
      expect(v.content).toMatch(new RegExp(`${forbidden}-[a-z]`));
    }
  });
});

// ─── retrieval-cats-04: labeled-universe precision ────────────────────

describe('link_precision over the labeled universe (retrieval-cats-04)', () => {
  test('unlabeled base-corpus links do not pollute the denominator', async () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 3 });
    const results = await scoreAll(variants);
    const report = aggregate(variants, results);
    const totalExtracted = results.reduce((s, r) => s + r.extracted.length, 0);
    const totalMatched = results.reduce((s, r) => s + r.matched, 0);
    // The extractor emits the base pages' own legitimate links too...
    expect(totalExtracted).toBeGreaterThan(totalMatched);
    // ...but a flawless run still scores precision 1.0 (was ~0.2-0.4 pre-fix).
    expect(report.overall.link_precision).toBe(1);
    expect(report.overall.link_recall).toBe(1);
    expect(report.overall.link_f1).toBe(1);
  });

  test('extra UNLABELED noise links leave precision untouched; a LABELED FP drags it down', async () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const resolver = makeCorpusResolver(TINY_CORPUS);

    const noisy: VariantResult[] = [];
    for (const v of variants) {
      const real = await scoreVariant(v, resolver);
      noisy.push(
        scoreExtraction(v, [
          ...real.extracted,
          { targetSlug: 'companies/unrelated-noise', linkType: 'mentions' },
        ]),
      );
    }
    const noisyReport = aggregate(variants, noisy);
    expect(noisyReport.overall.link_precision).toBe(1);

    const withFp: VariantResult[] = [];
    for (const v of variants) {
      const real = await scoreVariant(v, resolver);
      const extra: ExtractedLink[] =
        v.goldDelta.must_not_extract.length > 0
          ? [{ targetSlug: v.goldDelta.must_not_extract[0].slug, linkType: 'mentions' }]
          : [];
      withFp.push(scoreExtraction(v, [...real.extracted, ...extra]));
    }
    const fpReport = aggregate(variants, withFp);
    expect(fpReport.overall.link_precision!).toBeLessThan(1);
    expect(fpReport.verdict).toBe('fail');
  });
});

// ─── retrieval-cats-05: prose_only_mention boundary ───────────────────

describe('prose_only_mention boundary (retrieval-cats-05)', () => {
  test('report names the kind under kinds_not_exercised with a reason', async () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 1 });
    const report = aggregate(variants, await scoreAll(variants));
    const entry = report.kinds_not_exercised.find(k => k.kind === 'prose_only_mention');
    expect(entry).toBeDefined();
    expect(entry!.reason).toContain('bare-prose-name');
    expect(report.per_kind.some(p => p.kind === 'prose_only_mention')).toBe(false);
  });

  test('the boundary is real: the exercised pipeline extracts nothing for bare prose names', async () => {
    // Opt back in explicitly to document the capability gap.
    const variants = generateVariants(TINY_CORPUS, {
      perKind: 3,
      kinds: ['prose_only_mention'],
    });
    const results = await scoreAll(variants);
    for (const r of results) {
      expect(r.matched).toBe(0);
      expect(r.missed.length).toBeGreaterThan(0);
    }
  });

  test('excluding the kind means a flawless extractor reaches recall 1.0', async () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const report = aggregate(variants, await scoreAll(variants));
    // Pre-fix, prose_only_mention's structurally-unmatchable musts capped
    // recall at ~5/6 regardless of extractor quality.
    expect(report.overall.link_recall).toBe(1);
  });
});

// ─── retrieval-cats-06: substring_fp_rate can fire ────────────────────

describe('substring_fp_rate (retrieval-cats-06)', () => {
  test('is 0 under the real extractor (near-miss trap does not fire on correct behavior)', async () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 3 });
    const report = aggregate(variants, await scoreAll(variants));
    expect(report.overall.substring_fp_rate).toBe(0);
    // The trap path IS extracted (as its full, unlabeled token) — proof the
    // sentinel flows through the pipeline rather than being invisible to it.
    const subResults = (await scoreAll(variants)).filter(r => r.kind === 'substring_collision');
    const subVariants = variants.filter(v => v.kind === 'substring_collision');
    const trapSeen = subResults.some((r, i) => {
      const forbidden = subVariants[i].goldDelta.must_not_extract[0].slug;
      return r.extracted.some(e => e.targetSlug.startsWith(`${forbidden}-`));
    });
    expect(trapSeen).toBe(true);
  });

  test('a prefix-truncation bug produces a scored FP and fails the gate', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 3 });
    const results = variants.map(v =>
      scoreExtraction(v, hyphenTruncatingExtraction(v.content)),
    );
    const report = aggregate(variants, results);
    expect(report.overall.substring_fp_rate!).toBeGreaterThan(0);
    const gate = report.gates.find(g => g.gate === 'substring_fp_rate')!;
    expect(gate.pass).toBe(false);
    expect(report.verdict).toBe('fail');
  });

  test('negative controls fire on generated variants', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const controls = runNegativeControls(variants);
    const byName = new Map(controls.map(c => [c.control, c]));
    expect(byName.get('substring_fp_detectable')!.fired).toBe(true);
    expect(byName.get('code_leak_detectable')!.fired).toBe(true);
  });

  test('a no-code-stripping extractor leaks fenced/inline fakes into scored FPs', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 }).filter(
      v => v.kind === 'code_fence_leak' || v.kind === 'inline_code_slug',
    );
    for (const v of variants) {
      const r = scoreExtraction(v, noCodeStripExtraction(v.content));
      expect(r.false_positives.length).toBeGreaterThan(0);
    }
    const report = aggregate(
      variants,
      variants.map(v => scoreExtraction(v, noCodeStripExtraction(v.content))),
    );
    expect(report.overall.code_fence_leak_rate!).toBeGreaterThan(0);
    expect(report.overall.inline_code_leak_rate!).toBeGreaterThan(0);
    expect(report.verdict).toBe('fail');
  });
});

// ─── retrieval-cats-14: ambiguous_role type enforcement ───────────────

describe('ambiguous_role type enforcement (retrieval-cats-14)', () => {
  function ambiguousVariant(): VariantCase {
    const v = generateVariants(TINY_CORPUS, { perKind: 1 }).find(
      x => x.kind === 'ambiguous_role',
    );
    expect(v).toBeDefined();
    return v!;
  }

  test('emitting works_at instead of mentions is a mistyped FAILURE, not a match', () => {
    const v = ambiguousVariant();
    const gold = v.goldDelta.must_extract[0];
    expect(gold.enforce_type).toBe(true);

    const wrong = scoreExtraction(v, [{ targetSlug: gold.slug, linkType: 'works_at' }]);
    expect(wrong.matched).toBe(0);
    expect(wrong.mistyped.length).toBe(1);
    expect(wrong.mistyped[0].expected_type).toBe('mentions');

    const right = scoreExtraction(v, [{ targetSlug: gold.slug, linkType: 'mentions' }]);
    expect(right.matched).toBe(1);
    expect(right.mistyped.length).toBe(0);
  });

  test('mistypes fail the type-match gate and drag recall + precision', async () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const resolver = makeCorpusResolver(TINY_CORPUS);
    const results: VariantResult[] = [];
    for (const v of variants) {
      if (v.kind !== 'ambiguous_role') {
        results.push(await scoreVariant(v, resolver));
        continue;
      }
      // Fault injection: the extractor "upgrades" the gold link to works_at.
      const gold = v.goldDelta.must_extract[0];
      results.push(scoreExtraction(v, [{ targetSlug: gold.slug, linkType: 'works_at' }]));
    }
    const report = aggregate(variants, results);
    const kind = report.per_kind.find(p => p.kind === 'ambiguous_role')!;
    expect(kind.total_mistyped).toBe(2);
    expect(kind.recall).toBe(0);
    expect(kind.type_match_rate).toBe(0);
    expect(report.overall.ambiguous_role_type_match_rate).toBe(0);
    const gate = report.gates.find(g => g.gate === 'ambiguous_role_type_match')!;
    expect(gate.bound).toBe(GATES.ambiguous_role_type_match_min);
    expect(gate.pass).toBe(false);
    expect(report.verdict).toBe('fail');
  });
});

// ─── Gate failability in the missed direction ─────────────────────────

describe('gates', () => {
  test('an extractor that returns nothing fails the recall gate', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 2 });
    const results = variants.map(v => scoreExtraction(v, []));
    const report = aggregate(variants, results);
    expect(report.overall.link_recall).toBe(0);
    expect(report.gates.find(g => g.gate === 'link_recall')!.pass).toBe(false);
    expect(report.verdict).toBe('fail');
  });

  test('an unmeasurable (null) gate value never passes', () => {
    // Zero variants → every rate is null or 0-denominator.
    const report = aggregate([], []);
    for (const g of report.gates) {
      if (g.value === null) expect(g.pass).toBe(false);
    }
    expect(report.verdict).toBe('fail');
  });

  test('aggregate rejects misaligned variants/results', () => {
    const variants = generateVariants(TINY_CORPUS, { perKind: 1 });
    expect(() => aggregate(variants, [])).toThrow(/variants but/);
  });
});

// ─── main(): receipt + skip semantics ─────────────────────────────────

function writeFixtureCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cat6-corpus-'));
  for (const p of TINY_CORPUS) {
    writeFileSync(
      join(dir, `${p.slug.replace('/', '__')}.json`),
      JSON.stringify({
        slug: p.slug,
        type: p.type,
        title: p.title,
        compiled_truth: p.content,
        timeline: '',
      }),
    );
  }
  return dir;
}

async function quietMain(argv: string[]): Promise<number> {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await main(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe('main()', () => {
  test('writes a valid completed receipt with verdict + provenance', async () => {
    const corpus = writeFixtureCorpus();
    const out = mkdtempSync(join(tmpdir(), 'cat6-out-'));
    const receiptFile = join(out, 'receipt.json');
    const reportFile = join(out, 'report.json');
    const code = await quietMain([
      '--corpus-dir', corpus,
      '--per-kind', '2',
      '--receipt-path', receiptFile,
      '--report-path', reportFile,
    ]);
    expect(code).toBe(0); // tiny fixture passes every gate (verified baseline)

    const receipt = loadReceipt(receiptFile); // throws on structural violations
    expect(receipt.category).toBe('cat6-prose-scale');
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('pass');
    expect(receipt.publishable).toBe(true);
    expect(receipt.n_total).toBe(2 * SCORED_INJECTION_KINDS.length);
    expect(receipt.n_scored).toBe(receipt.n_total);
    expect(receipt.gbrain_version).toMatch(/^\d+\.\d+/);
    expect(receipt.gbrain_pin).not.toBe('unknown');
    const cfg = receipt.resolved_config as Record<string, unknown>;
    expect(JSON.stringify(cfg.kinds_not_exercised)).toContain('prose_only_mention');
  });

  test('missing corpus dir → skipped receipt, exit 2 without --allow-skip, 0 with', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cat6-skip-'));
    const receiptFile = join(out, 'receipt.json');
    const args = [
      '--corpus-dir', join(out, 'does-not-exist'),
      '--receipt-path', receiptFile,
      '--report-path', join(out, 'report.json'),
    ];
    expect(await quietMain(args)).toBe(2);
    const receipt = loadReceipt(receiptFile);
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.publishable).toBe(false);
    expect(receipt.skip_reason).toContain('corpus dir not found');

    expect(await quietMain([...args, '--allow-skip'])).toBe(0);
  });

  test('corpus with no person/company pages → skipped, exit 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat6-empty-'));
    writeFileSync(
      join(dir, 'notes__scratch.json'),
      JSON.stringify({ slug: 'notes/scratch', type: 'note', title: 'Scratch', compiled_truth: 'nothing here' }),
    );
    const out = mkdtempSync(join(tmpdir(), 'cat6-empty-out-'));
    const receiptFile = join(out, 'receipt.json');
    const code = await quietMain([
      '--corpus-dir', dir,
      '--receipt-path', receiptFile,
      '--report-path', join(out, 'report.json'),
    ]);
    expect(code).toBe(2);
    const receipt = loadReceipt(receiptFile);
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.skip_reason).toContain('0 variants');
  });
});

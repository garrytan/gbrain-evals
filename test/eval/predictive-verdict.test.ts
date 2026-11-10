import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST, REFERENCE_DIR } from '../../eval/runner/predictive/export-references.ts';
import { G3_CAUSES } from '../../eval/generators/write-contract-gen.ts';
import { B2_CONTRASTS, B3_ENTITY, B3_FRESHNESS, COUNTED_B2, COUNTED_B3, MAPPING, MEASURES } from '../../eval/runner/predictive/mapping.ts';
import { SyntheticScorecardError, evaluateMeasure, main, readSynthetic } from '../../eval/runner/predictive/verdict.ts';
import { ValidityReferenceError, loadReference, verdict, type Contrast, type ManifestEntry } from '../../eval/runner/predictive/validity.ts';

const b1 = loadReference(MANIFEST, 'live-recall-b1')!;
const b2 = loadReference(MANIFEST, 'live-recall-b2')!;
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestEntry[];
const card = (contrasts: Contrast[], orderings = b2.orderings) => ({ contrasts, orderings, control: false });
const quiet = <T>(fn: () => T): T => {
  const log = console.log, err = console.error;
  console.log = console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = err; }
};

/** A live-recall scorecard shape carrying the given success@5 comparisons. */
const liveCard = (contrasts: Contrast[]) => ({
  schema: 'live-recall-scorecard/v1', run: { control: true, synthetic: { digest: 'test-digest' } },
  comparisons: contrasts.flatMap(c => [
    { id: c.id, metric: 'success_at_5', delta: c.estimate, ci95: [c.lo, c.hi] },
    { id: c.id, metric: 'mrr', delta: -c.estimate, ci95: [-c.hi, -c.lo] },
  ]),
  arms: Object.fromEntries(['configured', 'hybrid', 'vector', 'hybrid_lexical', 'keyword'].map((arm, i) => [arm, { overall: { exact: { success_at: { k5: { rate: 0.9 - i / 10 } } }, paraphrase: { success_at: { k5: { rate: 0.8 - i / 10 } } } } }])),
});

describe('predictive verdict on the committed references', () => {
  test('a synthetic scorecard whose signs match batch 2 reads PREDICTIVE, with batch 3 pending', () => {
    const r = evaluateMeasure('G2', readSynthetic(card(b2.contrasts)));
    expect(r.verdict).toBe('PREDICTIVE');
    const [b2Layer, b3Layer] = r.layers;
    expect(b2Layer).toMatchObject({ reference: 'live-recall-b2', verdict: 'PREDICTIVE', qualifying_count: 13, mapped_count: 16 });
    expect(b2Layer!.contrasts.every(c => c.sign_agrees)).toBe(true);
    expect(b2Layer!.kendall_tau).toEqual({ arms_exact: 1, arms_paraphrase: 1 });
    expect(b3Layer).toMatchObject({ reference: 'live-recall-b3', status: 'pending', verdict: 'NO_REFERENCE_YET', missing_reference: 'live-recall-b3' });
  });

  test('the live-recall scorecard shape is read through its success@5 comparisons and arm orderings', () => {
    const syn = readSynthetic(liveCard(b2.contrasts.map(c => ({ ...c, estimate: c.estimate / 2, lo: c.lo / 2, hi: c.hi / 2 }))));
    expect(syn.control).toBe(true);
    expect(syn.contrasts).toHaveLength(16);
    expect(syn.orderings.arms_exact).toEqual(['configured', 'hybrid', 'vector', 'hybrid_lexical', 'keyword']);
    const r = evaluateMeasure('G2', syn);
    expect(r.layers[0]!.verdict).toBe('PREDICTIVE');
    expect(r.layers[0]!.kendall_tau.arms_paraphrase).toBe(1);
    expect(r.layers[0]!.kendall_tau.arms_exact).toBeCloseTo(0.4, 6);
  });

  test('flipping one qualifying contrast reads NOT_PREDICTIVE and names it', () => {
    const flipped = b2.contrasts.map(c => (c.id === 'configured_vs_hybrid' ? { ...c, estimate: -c.estimate, lo: -c.hi, hi: -c.lo } : c));
    const r = evaluateMeasure('G2', readSynthetic(card(flipped)));
    expect(r.verdict).toBe('NOT_PREDICTIVE');
    expect(r.layers[0]!.contrasts.filter(c => c.counted === 'disagree').map(c => c.reference_id)).toEqual(['configured_vs_hybrid']);
    const allFlipped = b2.contrasts.map(c => ({ ...c, estimate: -c.estimate, lo: -c.hi, hi: -c.lo }));
    expect(evaluateMeasure('G2', readSynthetic(card(allFlipped))).layers[0]!.contrasts.filter(c => c.counted === 'disagree')).toHaveLength(13);
  });

  test('a measure whose references are all pending reads NO_REFERENCE_YET and names each missing reference', () => {
    const r = evaluateMeasure('G5', readSynthetic(card([])));
    expect(r.verdict).toBe('NO_REFERENCE_YET');
    expect(r.layers.map(l => l.missing_reference)).toEqual(['latency-pins']);
    expect(evaluateMeasure('G1', readSynthetic(card([]))).layers.map(l => l.missing_reference)).toEqual(['live-recall-b3', 'phase2-agent']);
    expect(evaluateMeasure('G6', readSynthetic(card([]))).verdict).toBe('NO_REFERENCE_YET');
  });

  test('a tampered reference refuses with VALIDITY_REFERENCE_INVALID and the command exits 3 without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-tamper-'));
    try {
      for (const name of ['manifest.json', 'live-recall-b1.json', 'live-recall-b2.json']) copyFileSync(join(REFERENCE_DIR, name), join(dir, name));
      const ref = JSON.parse(readFileSync(join(dir, 'live-recall-b2.json'), 'utf8'));
      ref.contrasts[0].estimate = -ref.contrasts[0].estimate;
      writeFileSync(join(dir, 'live-recall-b2.json'), JSON.stringify(ref, null, 2) + '\n');
      try { evaluateMeasure('G2', readSynthetic(card(b2.contrasts)), join(dir, 'manifest.json')); throw new Error('accepted'); } catch (e) {
        expect(e).toBeInstanceOf(ValidityReferenceError);
        expect((e as ValidityReferenceError).code).toBe('VALIDITY_REFERENCE_INVALID');
        expect((e as Error).message).toContain('digest mismatch');
      }
      writeFileSync(join(dir, 'syn.json'), JSON.stringify(card(b2.contrasts)));
      expect(quiet(() => main(['--measure', 'G2', '--synthetic', join(dir, 'syn.json'), '--manifest', join(dir, 'manifest.json'), '--out', join(dir, 'v.json')]))).toBe(3);
      expect(() => readFileSync(join(dir, 'v.json'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a synthetic scorecard missing a mapped contrast refuses and names it', () => {
    const syn = readSynthetic(card(b2.contrasts.filter(c => c.id !== 'window_vs_configured')));
    expect(() => evaluateMeasure('G2', syn)).toThrow(SyntheticScorecardError);
    expect(() => evaluateMeasure('G2', syn)).toThrow('window_vs_configured');
    expect(() => readSynthetic({ contrasts: [{ id: 'x', estimate: 1, lo: 2, hi: 0 }] })).toThrow('SYNTHETIC_SCORECARD_INVALID');
    expect(() => readSynthetic({ arms: {} })).toThrow('SYNTHETIC_SCORECARD_INVALID');
  });

  test('a hash scorecard, or an in-process one that records no transports, is a control; a voyage scorecard is not', () => {
    const run = (r: object) => readSynthetic({ ...liveCard(b2.contrasts), run: { synthetic: { digest: 'test-digest' }, ...r } });
    expect([run({ control: true, transports: 'hash' }).control, run({ control: true }).control, run({ control: false }).control]).toEqual([true, true, false]);
    expect(run({ control: true, transports: 'voyage' })).toMatchObject({ control: false, transports: 'voyage' });
    expect(readSynthetic({ contrasts: [], transports: 'hash' }).control).toBe(true);
  });

  test('a real live-recall scorecard, which records no synthetic digest, is refused as the synthetic side', () => {
    const real = JSON.parse(readFileSync(new URL('../../docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json', import.meta.url), 'utf8'));
    expect(() => readSynthetic(real)).toThrow('SYNTHETIC_SCORECARD_INVALID');
    expect(() => readSynthetic({ ...liveCard(b2.contrasts), run: { control: false } })).toThrow('run.synthetic.digest');
  });

  test('a layer is read only from a live-recall scorecard of its protocol, and a scorecard carrying no layer of a measure with a live reference refuses', () => {
    const asBatch2 = evaluateMeasure('G2', readSynthetic({ ...liveCard(b2.contrasts), protocol: 'batch2' }));
    expect(asBatch2.verdict).toBe('PREDICTIVE');
    expect(asBatch2.layers.map(l => [l.id, l.status, l.in_scorecard])).toEqual([['b2', 'available', true], ['b3', 'pending', false]]);
    expect(() => evaluateMeasure('G2', readSynthetic({ ...liveCard(b2.contrasts), protocol: 'batch3' }))).toThrow('carries no G2 layer');
    expect(() => evaluateMeasure('G2', readSynthetic(card([])))).toThrow(SyntheticScorecardError);
  });

  test('batch 1 used as the synthetic side lacks batch 2\'s paraphrase primaries, and on the contrasts both share it agrees with batch 2', () => {
    expect(() => evaluateMeasure('G2', readSynthetic(card(b1.contrasts, b1.orderings)))).toThrow('p1_hybrid_vs_hybrid_lexical_paraphrase');
    const shared = b2.contrasts.map(c => c.id).filter(id => b1.contrasts.some(c => c.id === id));
    expect(shared).toHaveLength(14);
    const r = verdict({ mapped: shared, reference: b2, synthetic: b1.contrasts });
    expect(r.verdict).toBe('PREDICTIVE');
    expect(r.qualifying.length).toBeGreaterThanOrEqual(3);
  });

  test('the command prints the verdict, qualifying count and per-contrast agreement, and writes the JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-cli-'));
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      writeFileSync(join(dir, 'syn.json'), JSON.stringify(liveCard(b2.contrasts)));
      expect(quiet(() => main(['--measure', 'G2', '--synthetic', join(dir, 'syn.json'), '--out', join(dir, 'v.json')]))).toBe(3);
      expect(existsSync(join(dir, 'v.json'))).toBe(false);
      expect(main(['--measure', 'G2', '--synthetic', join(dir, 'syn.json'), '--out', join(dir, 'v.json'), '--control'])).toBe(0);
      expect(lines[0]).toStartWith('G2 recall under real conditions: PREDICTIVE (control scorecard');
      expect(lines.join('\n')).toContain('13 of 16 reference contrasts qualify (minimum 3)');
      expect(lines.join('\n')).toContain('layer b3 vs live-recall-b3: NO_REFERENCE_YET (reference live-recall-b3 is pending)');
      expect(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8'))).toMatchObject({ schema: 'predictive-verdict/v1', measure: 'G2', verdict: 'PREDICTIVE' });
    } finally {
      console.log = log;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(quiet(() => main(['--measure', 'G9', '--synthetic', 'x']))).toBe(2);
  });
});

describe('counted scorecard identity', () => {
  const voyageCard = (over: { commit?: string; knobs?: object; questions?: string; digest?: string } = {}) => ({
    ...liveCard(b2.contrasts), protocol: 'batch2',
    run: {
      control: false, transports: 'voyage', gbrain_loaded_version: '0.60.593.0', gbrain_loaded_commit: over.commit ?? COUNTED_B2.gbrain_commit,
      synthetic: { digest: over.digest ?? COUNTED_B2.digest, questions_sha256: over.questions ?? COUNTED_B2.questions_sha256, ...(over.knobs ?? COUNTED_B2.knobs) },
    },
  });

  test('G2 batch 2 reads its named counted scorecard, and verdict.json records the scorecard sha256 and identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-counted-'));
    try {
      const text = JSON.stringify(voyageCard());
      writeFileSync(join(dir, 'syn.json'), text);
      expect(quiet(() => main(['--measure', 'G2', '--synthetic', join(dir, 'syn.json'), '--out', join(dir, 'v.json')]))).toBe(0);
      const v = JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8'));
      expect(v.verdict).toBe('PREDICTIVE');
      expect(v.counted).toBe(true);
      expect(v.scorecard).toMatchObject({ path: join(dir, 'syn.json'), sha256: createHash('sha256').update(text).digest('hex'), gbrain_loaded_commit: COUNTED_B2.gbrain_commit, questions_sha256: COUNTED_B2.questions_sha256, digest: COUNTED_B2.digest, knobs: COUNTED_B2.knobs });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('another gbrain commit, other knobs or another question file refuses with exit 3 and writes nothing, even with --control', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-counted-bad-'));
    try {
      for (const bad of [{ commit: '62637c96a5a5c2e9d55594f87a33d79c2f30b54f' }, { knobs: { ...COUNTED_B2.knobs, shell_page_share: 0 } }, { questions: '0'.repeat(64) }, { digest: '0'.repeat(64) }]) {
        writeFileSync(join(dir, 'syn.json'), JSON.stringify(voyageCard(bad)));
        for (const extra of [[], ['--control']]) {
          expect(quiet(() => main(['--measure', 'G2', '--synthetic', join(dir, 'syn.json'), '--out', join(dir, 'v.json'), ...extra]))).toBe(3);
          expect(existsSync(join(dir, 'v.json'))).toBe(false);
        }
      }
      expect(evaluateMeasure('G2', readSynthetic(voyageCard({ commit: '62637c96a5a5c2e9d55594f87a33d79c2f30b54f' }))).verdict).toBe('PREDICTIVE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--secondary reads another scorecard and labels it secondary in the output and verdict.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-counted-secondary-'));
    try {
      writeFileSync(join(dir, 'syn.json'), JSON.stringify(voyageCard({ commit: '62637c96a5a5c2e9d55594f87a33d79c2f30b54f' })));
      const lines: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
      try { expect(main(['--measure', 'G2', '--synthetic', join(dir, 'syn.json'), '--out', join(dir, 'v.json'), '--secondary'])).toBe(0); } finally { console.log = log; }
      expect(lines[0]).toContain('secondary scorecard');
      const v = JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8'));
      expect(v.secondary).toBe(true);
      expect(v.counted).toBe(false);
      expect(v.scorecard.gbrain_loaded_commit).toBe('62637c96a5a5c2e9d55594f87a33d79c2f30b54f');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('counted batch 3 scorecard identity', () => {
  const b3Card = (commit = COUNTED_B3.gbrain_commit) => ({
    ...liveCard([...B3_FRESHNESS, ...B3_ENTITY].map(id => ({ id, estimate: 0.1, lo: 0.02, hi: 0.18 }) as Contrast)), protocol: 'batch3',
    run: { control: false, transports: 'voyage', gbrain_loaded_version: '0.60.641.0', gbrain_loaded_commit: commit, synthetic: { digest: COUNTED_B3.digest, questions_sha256: COUNTED_B3.questions_sha256, ...COUNTED_B3.knobs } },
  });

  test('the batch 3 layers read the synthetic batch-3 brain at 0.60.641.0 and refuse the one at 0.60.623.0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-counted-b3-'));
    try {
      for (const m of ['G1', 'G2', 'G4'] as const) {
        writeFileSync(join(dir, 'syn.json'), JSON.stringify(b3Card()));
        expect(quiet(() => main(['--measure', m, '--synthetic', join(dir, 'syn.json'), '--out', join(dir, 'v.json')]))).toBe(0);
        expect(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8')).counted).toBe(true);
        rmSync(join(dir, 'v.json'));
        writeFileSync(join(dir, 'syn.json'), JSON.stringify(b3Card('d253ec0ff12ed370ed3a846cb7da0191639c4a9e')));
        expect(quiet(() => main(['--measure', m, '--synthetic', join(dir, 'syn.json'), '--out', join(dir, 'v.json')]))).toBe(3);
        expect(existsSync(join(dir, 'v.json'))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('predictive mapping', () => {
  test('every reference contrast the mapping names exists in its committed reference, or the reference is pending', () => {
    for (const m of MEASURES) {
      expect(MAPPING[m].layers.length).toBeGreaterThan(0);
      for (const layer of MAPPING[m].layers) {
        const entry = manifest.find(e => e.id === layer.reference);
        expect([m, layer.id, entry?.id]).toEqual([m, layer.id, layer.reference]);
        const ref = loadReference(MANIFEST, layer.reference);
        if (!ref) { expect(entry!.status).toBe('pending'); continue; }
        const ids = new Set(ref.contrasts.map(c => c.id));
        for (const p of layer.pairs) expect([m, layer.id, p.reference, ids.has(p.reference)]).toEqual([m, layer.id, p.reference, true]);
      }
    }
  });

  test('G2 maps all 16 batch 2 success@5 contrasts id to id, and the shared batch 3 lists match the preregistration', () => {
    expect(([...B2_CONTRASTS] as string[]).sort()).toEqual(b2.contrasts.map(c => c.id).sort());
    expect(MAPPING.G2.layers[0]!.pairs.every(p => p.synthetic === p.reference)).toBe(true);
    const prereg = readFileSync('docs/benchmarks/2026-11-09-predictive-measures-preregistration.md', 'utf8');
    for (const m of ['G1', 'G4'] as const) for (const p of MAPPING[m].layers[0]!.pairs) expect(prereg).toContain('`' + p.reference + '`');
    expect(MAPPING.G5.layers[0]!.pairs.map(p => p.reference)).toEqual(['p95_query_570_vs_549', 'p95_search_570_vs_549', 'p95_get_570_vs_549']);
    expect(MAPPING.G6.layers[0]!.pairs.map(p => p.reference)).toEqual(['out_of_view_direct_flag', 'out_of_view_alias_inheritance', 'out_of_view_derived_default']);
  });

  test('G3\'s phase 2 layer maps every contract cause but two_range_read, as the preregistration amendment says', () => {
    const phase2 = MAPPING.G3.layers.find(l => l.id === 'phase2')!;
    const kept = G3_CAUSES.filter(c => c !== 'two_range_read');
    expect(phase2.pairs).toEqual(kept.map(c => ({ synthetic: 'refusal_rate_' + c, reference: 'arm_b_refusal_rate_' + c })));
    const prereg = readFileSync('docs/benchmarks/2026-11-09-predictive-measures-preregistration.md', 'utf8');
    expect(prereg).toContain('### 2026-11-09: G3\'s `two_range_read` pair with phase 2 arm B is not informative');
    for (const c of kept) expect(prereg).toContain('`' + c + '`');
  });
});

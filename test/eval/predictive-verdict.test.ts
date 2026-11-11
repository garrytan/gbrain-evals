import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MANIFEST, REFERENCE_DIR } from '../../eval/runner/predictive/export-references.ts';
import { G3_CAUSES } from '../../eval/generators/write-contract-gen.ts';
import { B2_CONTRASTS, B3_ENTITY, B3_FRESHNESS, COUNTED_B2, COUNTED_B3, MAPPING, MEASURES } from '../../eval/runner/predictive/mapping.ts';
import { SyntheticScorecardError, evaluateMeasure, main, readSynthetic } from '../../eval/runner/predictive/verdict.ts';
import { ValidityReferenceError, kendallTau, kendallTauB, loadReference, primaryOutcome, verdict, type Contrast, type ManifestEntry, type ReferenceFile } from '../../eval/runner/predictive/validity.ts';

const b1 = loadReference(MANIFEST, 'live-recall-b1')!;
const b2 = loadReference(MANIFEST, 'live-recall-b2')!;
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestEntry[];
const committedManifest = manifest;
const pendingB3Dir = mkdtempSync(join(tmpdir(), 'verdict-pending-b3-'));
for (const e of committedManifest) if (e.status === 'available') copyFileSync(join(REFERENCE_DIR, e.file), join(pendingB3Dir, e.file));
writeFileSync(join(pendingB3Dir, 'manifest.json'), JSON.stringify(committedManifest.map(e => (e.id === 'live-recall-b3' ? { id: e.id, file: e.file, status: 'pending' } : e)), null, 2));
const PENDING_B3 = join(pendingB3Dir, 'manifest.json');
afterAll(() => rmSync(pendingB3Dir, { recursive: true, force: true }));
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
    const r = evaluateMeasure('G2', readSynthetic(card(b2.contrasts)), PENDING_B3);
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
    expect(evaluateMeasure('G1', readSynthetic(card([])), PENDING_B3).layers.map(l => l.missing_reference)).toEqual(['live-recall-b3', 'phase2-agent']);
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
    expect(asBatch2.layers.map(l => [l.id, l.status, l.in_scorecard])).toEqual([['b2', 'available', true], ['b3', 'not_in_scorecard', false], ['b4', 'pending', true]]);
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
      expect(lines.join('\n')).toContain('layer b3 vs live-recall-b3: not in this scorecard');
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

describe('G2 batch 4 replication (amendment of 2026-11-11)', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  /** A manifest with live-recall-b4 available, built from batch 2's contrasts with each family band the given multiple of its interval's half-width. */
  const withB4 = (widen: number, edit: (c: Contrast) => Contrast = c => c) => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-b4-'));
    dirs.push(dir);
    for (const e of committedManifest) if (e.status === 'available') copyFileSync(join(REFERENCE_DIR, e.file), join(dir, e.file));
    const contrasts = b2.contrasts.map(edit).map(c => ({ ...c, family_lo: c.estimate - widen * (c.estimate - c.lo), family_hi: c.estimate + widen * (c.hi - c.estimate) }));
    const body = JSON.stringify({ id: 'live-recall-b4', source: 'test', contrasts, orderings: b2.orderings, scores: b2.scores } satisfies ReferenceFile, null, 2) + '\n';
    writeFileSync(join(dir, 'live-recall-b4.json'), body);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(committedManifest.map(e => (e.id === 'live-recall-b4' ? { ...e, sha256: createHash('sha256').update(body).digest('hex'), status: 'available' } : e)), null, 2));
    return join(dir, 'manifest.json');
  };
  const counted = JSON.parse(readFileSync('docs/benchmarks/predictive-measures/g2/real-593/scorecard.json', 'utf8'));

  test('the committed G2 verdict is unchanged, with tau-b from per-arm scores and batch 4 pending', () => {
    const r = evaluateMeasure('G2', readSynthetic(counted));
    expect(r.verdict).toBe('PREDICTIVE');
    const [b2Layer, b3Layer, b4Layer] = r.layers;
    expect(b2Layer).toMatchObject({ id: 'b2', verdict: 'PREDICTIVE', qualifying_count: 13, qualify: 'interval', kendall_tau_method: { arms_exact: 'tau_b', arms_paraphrase: 'tau_b' } });
    expect(b2Layer!.kendall_tau.arms_exact).toBeCloseTo(0.6, 10);
    expect(b2Layer!.kendall_tau.arms_paraphrase).toBeCloseTo(9 / Math.sqrt(90), 10);
    expect(b3Layer!.verdict).toBe('NOT_IN_SCORECARD');
    expect(b4Layer).toMatchObject({ id: 'b4', status: 'pending', verdict: 'NO_REFERENCE_YET', missing_reference: 'live-recall-b4', qualify: 'family', in_scorecard: true });
    const published = JSON.parse(readFileSync('docs/benchmarks/predictive-measures/verdicts/G2-batch2.json', 'utf8'));
    expect(b2Layer!.contrasts.map(c => [c.reference_id, c.counted])).toEqual(published.layers[0].contrasts.map((c: any) => [c.reference_id, c.counted]));
  });

  test('tau-b counts tied arms as ties; the ordering tau broke the tie one way', () => {
    const syn = { keyword: 0, vector: 0.89, hybrid_lexical: 0.58, hybrid: 0.89, configured: 0.9 };
    expect(kendallTauB(syn, b2.scores!.arms_paraphrase!)).toBeCloseTo(0.9487, 4);
    expect(kendallTau(readSynthetic(counted).orderings.arms_paraphrase!, b2.orderings!.arms_paraphrase!)).toBeCloseTo(0.8, 10);
    expect(kendallTauB({ a: 1, b: 2, c: 3 }, { a: 3, b: 2, c: 1 })).toBe(-1);
    expect(kendallTauB({ a: 1, b: 1 }, { a: 1, b: 2 })).toBeNull();
    expect(kendallTauB({ a: 1 }, { a: 1 })).toBeNull();
  });

  test('batch 4 qualifies on the family band, and its primary reads HELD when the counted brain\'s signs hold', () => {
    const r = evaluateMeasure('G2', readSynthetic(counted), withB4(1.5));
    const b4 = r.layers.find(l => l.id === 'b4')!;
    expect(b4).toMatchObject({ status: 'available', verdict: 'PREDICTIVE', qualify: 'family' });
    expect(b4.qualifying_count).toBeLessThan(13);
    expect(b4.contrasts.find(c => c.reference_id === 'p1_hybrid_vs_hybrid_lexical_paraphrase')!.reference.qualifies).toBe(false);
    expect(b4.primary).toMatchObject({ id: 'paraphrase_vs_exact_configured', outcome: 'HELD', reference: { estimate: -0.4 }, synthetic: { estimate: -0.07 } });
    expect(b4.primary!.ratio!.estimate).toBeCloseTo(0.175, 10);
    expect(b4.primary!.ratio!.lo).toBeCloseTo(0.0600, 3);
    expect(b4.primary!.ratio!.hi).toBeCloseTo(0.3567, 3);
    expect(b4.qualifying_counted).toBe(b4.qualifying_count - b4.contrasts.filter(c => c.reference.qualifies && ['configured_vs_keyword_paraphrase', 'hybrid_vs_keyword_paraphrase', 'paraphrase_vs_exact_keyword'].includes(c.reference_id)).length);
    expect(quiet(() => { const lines: string[] = []; const log = console.log; console.log = (l: string) => lines.push(l); try { main(['--measure', 'G2', '--synthetic', 'docs/benchmarks/predictive-measures/g2/real-593/scorecard.json', '--manifest', withB4(1.5)]); } finally { console.log = log; } return lines; }).some(l => l.includes('primary paraphrase_vs_exact_configured: HELD'))).toBe(true);
  });

  test('the outcome comes from the primary alone: NOT_HELD on the other side, INCONCLUSIVE across zero, whatever the layer reads', () => {
    const flip = (c: Contrast) => (c.id === 'paraphrase_vs_exact_configured' ? { ...c, estimate: 0.2, lo: 0.05, hi: 0.35 } : c);
    const notHeld = evaluateMeasure('G2', readSynthetic(counted), withB4(1.2, flip)).layers.find(l => l.id === 'b4')!;
    expect(notHeld.verdict).toBe('NOT_PREDICTIVE');
    expect(notHeld.primary!.outcome).toBe('NOT_HELD');
    const zero = (c: Contrast) => (c.id === 'paraphrase_vs_exact_configured' ? { ...c, estimate: -0.05, lo: -0.2, hi: 0.1 } : c);
    const inconclusive = evaluateMeasure('G2', readSynthetic(counted), withB4(1.2, zero)).layers.find(l => l.id === 'b4')!;
    expect(inconclusive.verdict).toBe('PREDICTIVE');
    expect(inconclusive.primary!.outcome).toBe('INCONCLUSIVE');
    const tooWide = evaluateMeasure('G2', readSynthetic(counted), withB4(20)).layers.find(l => l.id === 'b4')!;
    expect(tooWide.verdict).toBe('NO_REFERENCE_YET');
    expect(tooWide.primary!.outcome).toBe('HELD');
    const sideFlip = (c: Contrast) => (c.id === 'vector_vs_keyword' ? { ...c, estimate: -0.02, lo: -0.12, hi: 0.08 } : c);
    const noisy = evaluateMeasure('G2', readSynthetic(counted), withB4(1.2, sideFlip)).layers.find(l => l.id === 'b4')!;
    expect(noisy.verdict).toBe('PREDICTIVE');
    expect(noisy.primary!.outcome).toBe('HELD');
  });

  test('primaryOutcome reads the primary\'s own interval against the predicted sign', () => {
    const syn = { id: 'p', estimate: -0.07, lo: -0.12, hi: -0.03 };
    const ref = (lo: number, hi: number) => ({ id: 'p', estimate: (lo + hi) / 2, lo, hi });
    expect(primaryOutcome(ref(-0.5, -0.2), syn)).toBe('HELD');
    expect(primaryOutcome(ref(0.1, 0.3), syn)).toBe('NOT_HELD');
    expect(primaryOutcome(ref(-0.3, 0.1), syn)).toBe('INCONCLUSIVE');
    expect(primaryOutcome(ref(-0.5, -0.2), { ...syn, estimate: 0, lo: 0, hi: 0 })).toBe('NOT_HELD');
  });

  test('the sign-forced contrasts alone never reach the minimum of 3', () => {
    const forced = ['configured_vs_keyword_paraphrase', 'hybrid_vs_keyword_paraphrase', 'paraphrase_vs_exact_keyword'];
    const onlyForced = (c: Contrast) => (forced.includes(c.id) ? c : { ...c, estimate: 0.01, lo: -0.1, hi: 0.12 });
    const b4 = evaluateMeasure('G2', readSynthetic(counted), withB4(1, onlyForced)).layers.find(l => l.id === 'b4')!;
    expect(b4.qualifying_count).toBe(3);
    expect(b4.qualifying_counted).toBe(0);
    expect(b4.verdict).toBe('NO_REFERENCE_YET');
  });

  test('a contrast the batch 4 scorecard skipped counts as not qualifying, and a skipped primary reads INCONCLUSIVE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-b4-skip-'));
    dirs.push(dir);
    for (const e of committedManifest) if (e.status === 'available') copyFileSync(join(REFERENCE_DIR, e.file), join(dir, e.file));
    const gone = ['paraphrase_vs_exact_configured', 'configured_vs_hybrid'];
    const contrasts = b2.contrasts.filter(c => !gone.includes(c.id)).map(c => ({ ...c, family_lo: c.lo, family_hi: c.hi }));
    const body = JSON.stringify({ id: 'live-recall-b4', source: 'test', contrasts, orderings: b2.orderings, scores: b2.scores, skipped: gone }, null, 2) + '\n';
    writeFileSync(join(dir, 'live-recall-b4.json'), body);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(committedManifest.map(e => (e.id === 'live-recall-b4' ? { ...e, sha256: createHash('sha256').update(body).digest('hex'), status: 'available' } : e))));
    const b4 = evaluateMeasure('G2', readSynthetic(counted), join(dir, 'manifest.json')).layers.find(l => l.id === 'b4')!;
    expect(b4.skipped).toEqual(['configured_vs_hybrid', 'paraphrase_vs_exact_configured']);
    expect(b4.contrasts).toHaveLength(14);
    expect(b4.primary).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'reference_skipped', reference: null, ratio: null });
  });

  test('a family layer refuses a reference with no bands at all, and a contrast without a band doesn\'t qualify', () => {
    const r = ref2(b2.contrasts);
    expect(() => verdict({ mapped: b2.contrasts.map(c => c.id), reference: r, synthetic: b2.contrasts, qualify: 'family' })).toThrow('no family band');
    expect(verdict({ mapped: b2.contrasts.map(c => c.id), reference: r, synthetic: b2.contrasts }).verdict).toBe('PREDICTIVE');
    const partly = ref2(b2.contrasts.map(c => (c.id === 'p2_configured_vs_hybrid_lexical_paraphrase' ? c : { ...c, family_lo: c.lo, family_hi: c.hi })));
    expect(verdict({ mapped: b2.contrasts.map(c => c.id), reference: partly, synthetic: b2.contrasts, qualify: 'family' }).qualifying).not.toContain('p2_configured_vs_hybrid_lexical_paraphrase');
  });

  test('the b4 reference exports as available only from a counted batch4 scorecard at its fixed path', async () => {
    const { B4_SCORECARD, buildReferences } = await import('../../eval/runner/predictive/export-references.ts');
    const root = mkdtempSync(join(tmpdir(), 'export-b4-'));
    dirs.push(root);
    for (const f of ['docs/benchmarks/2026-11-06-live-recall-batch1/attempt2-scorecard.json', 'docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json', 'docs/benchmarks/2026-11-10-live-recall-batch3/b3-641-scorecard.json']) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      copyFileSync(f, join(root, f));
    }
    expect(buildReferences(root).pending.map(e => e.id)).toContain('live-recall-b4');
    const real = JSON.parse(readFileSync('docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json', 'utf8'));
    mkdirSync(dirname(join(root, B4_SCORECARD)), { recursive: true });
    writeFileSync(join(root, B4_SCORECARD), JSON.stringify(real));
    expect(() => buildReferences(root)).toThrow('counted batch4 scorecard');
    const banded = { ...real, protocol: 'batch4', family: { method: 'max_t_cluster_bootstrap' }, comparisons: real.comparisons.map((c: any) => (c.metric === 'success_at_5' ? { ...c, family_ci95: [c.ci95[0] - 0.05, c.ci95[1] + 0.05] } : c)) };
    writeFileSync(join(root, B4_SCORECARD), JSON.stringify(banded));
    const built = buildReferences(root);
    expect(built.pending.map(e => e.id)).not.toContain('live-recall-b4');
    const b4 = built.files.find(([, r]) => r.id === 'live-recall-b4')![1];
    expect(b4.contrasts.every(c => c.family_lo !== undefined)).toBe(true);
    expect(b4.scores).toEqual(b2.scores);
  });

  test('a batch 4 success@5 comparison with no pairs exports as skipped instead of crashing, so it cannot qualify', async () => {
    const { B4_SCORECARD, buildReferences } = await import('../../eval/runner/predictive/export-references.ts');
    const root = mkdtempSync(join(tmpdir(), 'export-b4-empty-'));
    dirs.push(root);
    for (const f of ['docs/benchmarks/2026-11-06-live-recall-batch1/attempt2-scorecard.json', 'docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json', 'docs/benchmarks/2026-11-10-live-recall-batch3/b3-641-scorecard.json']) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      copyFileSync(f, join(root, f));
    }
    const real = JSON.parse(readFileSync('docs/benchmarks/2026-11-07-live-recall-batch2/b2-593-scorecard.json', 'utf8'));
    const empty = (c: any) => ({ id: c.id, metric: c.metric, n_pairs: 0, n_clusters: 0, mean_a: null, mean_b: null, delta: null, ci95: null, p_two_sided: null, p_method: 'none', mcnemar: null, mde: null, family_ci95: null });
    const comparisons = real.comparisons.map((c: any) => (c.metric !== 'success_at_5' ? c : c.id === 'window_vs_configured' ? empty(c) : { ...c, family_ci95: [c.ci95[0] - 0.05, c.ci95[1] + 0.05] }));
    mkdirSync(dirname(join(root, B4_SCORECARD)), { recursive: true });
    writeFileSync(join(root, B4_SCORECARD), JSON.stringify({ ...real, protocol: 'batch4', family: { method: 'max_t_cluster_bootstrap' }, comparisons }));
    const b4 = buildReferences(root).files.find(([, r]) => r.id === 'live-recall-b4')![1];
    expect(b4.skipped).toEqual(['window_vs_configured']);
    expect(b4.contrasts.map(c => c.id)).not.toContain('window_vs_configured');
    expect(b4.contrasts).toHaveLength(15);
    expect(b4.contrasts.every(c => Number.isFinite(c.estimate) && Number.isFinite(c.lo) && Number.isFinite(c.hi))).toBe(true);
  });

  test('verdict.json records a repo-relative scorecard path for a scorecard inside the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-relpath-'));
    dirs.push(dir);
    expect(quiet(() => main(['--measure', 'G2', '--synthetic', 'docs/benchmarks/predictive-measures/g2/real-593/scorecard.json', '--out', join(dir, 'v.json')]))).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8')).scorecard.path).toBe('docs/benchmarks/predictive-measures/g2/real-593/scorecard.json');
  });
  const ref2 = (contrasts: Contrast[]): ReferenceFile => ({ id: 'x', source: 'test', contrasts });

  test('the G2 b4 layer is the 16 batch 2 contrasts on the counted scorecard, with the configured paraphrase gap as primary', () => {
    const b4 = MAPPING.G2.layers.find(l => l.id === 'b4')!;
    expect(b4).toMatchObject({ reference: 'live-recall-b4', protocol: 'batch2', counted: COUNTED_B2, qualify: 'family', primary: 'paraphrase_vs_exact_configured' });
    expect(b4.pairs.map(p => p.reference)).toEqual([...B2_CONTRASTS]);
    expect(committedManifest.find(e => e.id === 'live-recall-b4')).toEqual({ id: 'live-recall-b4', file: 'live-recall-b4.json', status: 'pending' });
  });
});

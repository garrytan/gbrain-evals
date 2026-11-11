/**
 * Batch 3's synthetic side (predictive-measures preregistration): the
 * batch3-synthetic generator built from G1's freshness and G4's entity worlds,
 * its digest and paraphrase rule, the keyless live-recall run over it under
 * --protocol batch3, and the predictive verdict read from that one scorecard.
 * Keyless: brains are built inside withHermeticEnv with hash embeddings and a
 * token-overlap reranker, and no test constructs a model request.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { B3_SCHEMA, Batch3SyntheticError, generateBatch3Synthetic, writeBatch3Synthetic } from '../../eval/generators/batch3-synthetic-gen.ts';
import { ConditionsRecallError, paraphraseRuleBreaks } from '../../eval/generators/conditions-recall-gen.ts';
import { generateFreshnessTasks } from '../../eval/generators/freshness-world-gen.ts';
import { enterHermeticEnv, withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { liveRecall, parseQuestions } from '../../eval/runner/live-recall/run.ts';
import { validateScorecard } from '../../eval/runner/live-recall/scorecard.ts';
import { readSyntheticDir } from '../../eval/runner/live-recall/synthetic.ts';
import { main as paraphraseOpus } from '../../eval/runner/live-recall/paraphrase-opus.ts';
import { MANIFEST, REFERENCE_DIR } from '../../eval/runner/predictive/export-references.ts';
import { B3_ENTITY, B3_FRESHNESS } from '../../eval/runner/predictive/mapping.ts';
import type { ManifestEntry } from '../../eval/runner/predictive/validity.ts';
import { SyntheticScorecardError, evaluateMeasure, readSynthetic } from '../../eval/runner/predictive/verdict.ts';

const committedManifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestEntry[];
const pendingB3Dir = mkdtempSync(join(tmpdir(), 'verdict-pending-b3-'));
for (const e of committedManifest) if (e.status === 'available') copyFileSync(join(REFERENCE_DIR, e.file), join(pendingB3Dir, e.file));
writeFileSync(join(pendingB3Dir, 'manifest.json'), JSON.stringify(committedManifest.map(e => (e.id === 'live-recall-b3' ? { id: e.id, file: e.file, status: 'pending' } : e)), null, 2));
const PENDING_B3 = join(pendingB3Dir, 'manifest.json');
afterAll(() => rmSync(pendingB3Dir, { recursive: true, force: true }));

const PINNED_DIGEST = 'e270789585685527cc01dbad721755273d9a1c85b3971c557a8119d0ad1e7d10';
const PINNED_QUESTIONS_SHA256 = '15cfd7d0753cf831ff6676f7311e920128fce2fd78aff54fbb1e89aaf2edfbe4';
/** Function words a question may add around the gold page's own words. */
const FUNCTION_WORDS = new Set(['which', 'who', 'where', 'what', 'is', 'are', 'has', 'the', 'a', 'at', 'in', 'to', 'and', 'we', 'with', 'of']);
const words = (text: string) => text.toLowerCase().split(/\s+/).map(w => w.replace(/^[^a-z0-9@]+|[^a-z0-9]+$/g, '')).filter(Boolean);

const temps: string[] = [];
const tempDir = (label: string) => { const d = mkdtempSync(join(tmpdir(), 'b3s-' + label + '-')); temps.push(d); return d; };
const writeSet = (perType = 4) => { const dir = tempDir('set'); writeBatch3Synthetic(dir, generateBatch3Synthetic({ perType })); return dir; };
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe('batch3-synthetic generator', () => {
  const full = generateBatch3Synthetic();
  const body = new Map(full.pages.map(p => [p.slug, p.body]));

  test('is deterministic per seed and reproduces the pinned digest and question file', () => {
    const again = generateBatch3Synthetic();
    expect(again.questionsText).toBe(full.questionsText);
    expect(again.pages).toEqual(full.pages);
    expect(again.manifest).toEqual(full.manifest);
    expect(full.manifest.digest).toBe(PINNED_DIGEST);
    expect(full.manifest.questions_sha256).toBe(PINNED_QUESTIONS_SHA256);
    expect(generateBatch3Synthetic({ seed: 7 }).manifest.digest).not.toBe(PINNED_DIGEST);
    expect(full.manifest).toMatchObject({ schema: B3_SCHEMA, protocol: 'batch3', seed: 20261110, per_type: 20, paraphrase_source: 'template', paraphrases_sha256: null });
    expect([full.manifest.sources.g1.seed, full.manifest.sources.g4.seed]).toEqual([20261110, 20261111]);
    expect(full.manifest.counts.by_type).toEqual({ freshness: 20, entity: 20 });
    expect(parseQuestions(full.questionsText, 'batch3').map(q => q.type).sort()).toEqual([...Array(20).fill('entity'), ...Array(20).fill('freshness')]);
  });

  test('every exact form is in its gold page\'s own words: each content word appears on the gold page', () => {
    for (const q of full.questions) {
      const page = new Set(words(body.get(q.gold[0]!.slug)!));
      const missing = words(q.forms.exact).filter(w => !FUNCTION_WORDS.has(w) && !page.has(w));
      expect([q.id, missing]).toEqual([q.id, []]);
    }
  });

  test('every paraphrase differs from its exact form and shares no identifier-like token with it', () => {
    expect(paraphraseRuleBreaks(full.questions)).toEqual([]);
    for (const q of full.questions) expect([q.id, q.forms.paraphrase.toLowerCase() === q.forms.exact.toLowerCase()]).toEqual([q.id, false]);
  });

  test('every freshness question has a stale page that exists, differs from the gold and holds the stale value', () => {
    const worlds = new Map(generateFreshnessTasks({ seed: full.manifest.sources.g1.seed, n: full.manifest.sources.g1.pool }).map(w => [w.id, w]));
    expect(new Set(full.pages.map(p => p.slug)).size).toBe(full.pages.length);
    for (const q of full.questions) {
      expect(q.gold.every(g => body.has(g.slug))).toBe(true);
      if (q.type === 'entity') { expect(q.stale).toBeUndefined(); continue; }
      const w = worlds.get(q.id)!;
      expect(q.gold).toEqual([{ slug: w.fresh_page }]);
      expect(q.stale!.length).toBeGreaterThan(0);
      for (const s of q.stale!) {
        expect([q.id, s.slug !== w.fresh_page, body.has(s.slug)]).toEqual([q.id, true, true]);
        expect(w.gold.stale.some(v => body.get(s.slug)!.includes(v))).toBe(true);
      }
    }
    expect(Object.keys(full.manifest.skipped)).toEqual(expect.arrayContaining(['summary_vs_timeline', 'shared_vs_published']));
  });

  test('a paraphrase file replaces the templates, and a file missing an id or a size past the pool is refused', () => {
    const file = full.questions.map(q => JSON.stringify({ id: q.id, paraphrase: 'Remind me about this one: ' + q.id.split('-').pop()!.replace('_', ' ') + '?' })).join('\n');
    const applied = generateBatch3Synthetic({ paraphrasesText: file });
    expect(applied.manifest.paraphrase_source).toBe('file');
    expect(applied.manifest.paraphrases_sha256).toHaveLength(64);
    expect(applied.manifest.digest).not.toBe(PINNED_DIGEST);
    expect(() => generateBatch3Synthetic({ paraphrasesText: file.split('\n').slice(1).join('\n') })).toThrow(ConditionsRecallError);
    expect(() => generateBatch3Synthetic({ perType: 99 })).toThrow(Batch3SyntheticError);
  });

  test('the written directory reads back as a batch3 synthetic set, and an edit after generation is refused', () => {
    const dir = writeSet();
    const read = readSyntheticDir(dir);
    expect(read.protocol).toBe('batch3');
    expect(read.manifest.schema).toBe(B3_SCHEMA);
    writeFileSync(join(dir, 'pages', 'notes-extra.md'), '---\ntype: note\ntitle: Extra\n---\n\nextra\n');
    expect(() => readSyntheticDir(dir)).toThrow('does not match its manifest digest');
  });
});

describe('paraphrase-opus on a batch-3 directory (paid path, never called)', () => {
  let restore: () => void;
  beforeAll(() => { restore = enterHermeticEnv('b3s-paid').restore; });
  afterAll(() => restore());

  test('reads the batch-3 questions and refuses without --paid and a budget run, before any client or request exists', async () => {
    const dir = writeSet(2);
    const out = join(tempDir('paid'), 'paraphrases.jsonl');
    const ledger = join(tempDir('ledger'), 'ledger.sqlite');
    let clients = 0, fetches = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fetches++; throw new Error('no network in this test'); }) as unknown as typeof fetch;
    const savedError = console.error;
    console.error = () => {};
    try {
      const makeClient = () => { clients++; throw new Error('client constructed'); };
      expect(await paraphraseOpus(['--dir', dir, '--out', out, '--budget-ledger', ledger], { makeClient })).toBe(2);
      expect(await paraphraseOpus(['--dir', dir, '--out', out, '--budget-ledger', ledger, '--paid', '--budget-run-id', 'no-such-run'], { makeClient })).toBe(2);
    } finally {
      globalThis.fetch = savedFetch;
      console.error = savedError;
    }
    expect([clients, fetches, existsSync(out), existsSync(ledger)]).toEqual([0, 0, false, false]);
  });
});

describe('live-recall run --synthetic --protocol batch3 (keyless), and the verdict read from it', () => {
  let card: any;
  beforeAll(async () => {
    const dir = writeSet(4);
    const out = tempDir('run');
    card = await withHermeticEnv('b3s-run', async () => {
      const paths = await liveRecall({ fixture: false, synthetic: dir, protocol: 'batch3', databaseUrlEnv: 'UNUSED', out: join(out, 'run'), gut: resolveGbrainUnderTest(null) }, () => {});
      return JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    });
  }, 180_000);

  test('the scorecard validates and carries all six batch-3 freshness and entity contrasts, with stale-first per arm', () => {
    expect(() => validateScorecard(card)).not.toThrow();
    expect(card.protocol).toBe('batch3');
    expect(card.run.control).toBe(true);
    expect(card.run.transports).toBe('hash');
    expect(card.questions.loaded).toBe(8);
    for (const type of ['freshness', 'entity']) expect(card.arms.keyword.by_type[type].all.success_at.k5.rate).toBeGreaterThan(0);
    const ids = card.comparisons.filter((c: any) => c.metric === 'success_at_5').map((c: any) => c.id);
    expect(ids).toEqual(expect.arrayContaining([...B3_FRESHNESS, ...B3_ENTITY]));
    for (const arm of ['keyword', 'vector', 'hybrid_lexical', 'hybrid', 'configured']) expect(card.arms[arm].stale_first.all.n).toBe(8);
  });

  test('while live-recall-b3 is pending, verdict reads G1 retrieval, G4 retrieval and G2 b3 as NO_REFERENCE_YET naming it, and G2 b2 as not in this scorecard', () => {
    const syn = readSynthetic(card);
    const g1 = evaluateMeasure('G1', syn, PENDING_B3), g4 = evaluateMeasure('G4', syn, PENDING_B3), g2 = evaluateMeasure('G2', syn, PENDING_B3);
    for (const r of [g1, g4]) {
      expect(r.verdict).toBe('NO_REFERENCE_YET');
      expect(r.layers.map(l => [l.id, l.verdict, l.missing_reference, l.in_scorecard])).toEqual([['retrieval', 'NO_REFERENCE_YET', 'live-recall-b3', true], ['agent', 'NO_REFERENCE_YET', 'phase2-agent', false]]);
    }
    expect(g2.verdict).toBe('NO_REFERENCE_YET');
    expect(g2.layers.map(l => [l.id, l.status, l.verdict, l.in_scorecard])).toEqual([['b2', 'not_in_scorecard', 'NOT_IN_SCORECARD', false], ['b3', 'pending', 'NO_REFERENCE_YET', true], ['b4', 'pending', 'NO_REFERENCE_YET', false]]);
    expect(g2.layers[1]!.missing_reference).toBe('live-recall-b3');
  });

  test('with live-recall-b3 published, the same scorecard reads G1 and G4 retrieval and G2 b3 against it', () => {
    const syn = readSynthetic(card);
    for (const m of ['G1', 'G4'] as const) expect(evaluateMeasure(m, syn).layers.map(l => [l.id, l.reference, l.status, l.in_scorecard])).toEqual([['retrieval', 'live-recall-b3', 'available', true], ['agent', 'phase2-agent', 'pending', false]]);
    expect(evaluateMeasure('G2', syn).layers.map(l => [l.id, l.status, l.in_scorecard])).toEqual([['b2', 'not_in_scorecard', false], ['b3', 'available', true], ['b4', 'pending', false]]);
  });

  test('a batch-3 scorecard missing one entity contrast refuses G2 and G4 by name, and still reads G1', () => {
    const syn = readSynthetic({ ...card, comparisons: card.comparisons.filter((c: any) => c.id !== 'hybrid_vs_hybrid_lexical_entity') });
    for (const m of ['G2', 'G4'] as const) {
      expect(() => evaluateMeasure(m, syn)).toThrow(SyntheticScorecardError);
      expect(() => evaluateMeasure(m, syn)).toThrow('hybrid_vs_hybrid_lexical_entity');
    }
    expect(evaluateMeasure('G1', syn).layers[0]!.in_scorecard).toBe(true);
  });
});

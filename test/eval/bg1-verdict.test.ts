/**
 * BG1's analysis (eval/runner/bg1/verdict.ts) on synthetic inputs and synthetic receipts: the verdict words per family,
 * the common question set and drops (product failures 0, harness failures dropped, the 5% cap), the worst case, the
 * fill gate, design control, cost per correct answer, the matcher's agreement and exposure summaries, the pilot (SDs
 * and correlations, never a mean), and every receipt check (gating judgments, the filled manifest, run configs, limits,
 * paid re-reads). Keyless and offline.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BG1_CUSTODY_MARKER, buildQuestions, planWorld, PUBLIC_PHRASING, renderTemplateWorld, sealedWorldSeed } from '../../eval/generators/changing-facts-gen.ts';
import { bg1ManifestFiles, loadBg1, type MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { answerId } from '../../eval/runner/memory-qa/records.ts';
import { frontierInstrumentId, runConfigText } from '../../eval/runner/q1/cell.ts';
import { loadBG1Manifest, OPUS, PARTICLE, SOL } from '../../eval/runner/q1/cells/bg1.ts';
import { bg1JudgeOf, PER_READER_JUDGE_SETTINGS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { rereadCellId } from '../../eval/runner/q1/reread-cell.ts';
import {
  analyze, BG1_MANIFEST_REL, commonSet, dropsOf, gatingProblems, loadInput, main, matcherAgreement, pilotStats, readerValue, receiptManifestProblems, ROLES, unpinnedCorpusFiles, worldDifferences,
  type Bg1Input, type Bg1Row, type QuestionInput, type ReaderValue,
} from '../../eval/runner/bg1/verdict.ts';
import { BG1_CONVERSATIONS, BG1_DEV_CONVERSATIONS, BG1_STRATA, BG1_WAVE_A, type Bg1Stratum } from '../../eval/runner/bg1/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bg1-verdict-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A custody root outside the checkout holding the first `count` slots, rendered from templates on a test seed, and a manifest that pins them and keeps them all. */
function mintedSet(count: number) {
  const root = mkdtempSync(join(tmp, 'custody-'));
  const line = ['bg1', 'seed', 'v1'].join('-') + ':' + sha('verdict test seed');
  const phrasing = { ...PUBLIC_PHRASING, custody: BG1_CUSTODY_MARKER };
  const ids = BG1_CONVERSATIONS.slice(0, count);
  ids.forEach((id, i) => {
    const plan = planWorld(id, sealedWorldSeed(line, i + 1), { phrasing, custody: true });
    const dir = join(root, 'set', 'worlds', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'questions.json'), JSON.stringify(buildQuestions(plan, phrasing)));
    writeFileSync(join(dir, 'world.json'), JSON.stringify(renderTemplateWorld(plan, 4000)));
  });
  const manifestPath = join(root, 'set', 'bg1-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ dataset: 'bg1', status: 'filled', layout: 'worlds/<id>/{world,questions}.json', note: 'verdict test', files: bg1ManifestFiles(join(root, 'set'), ids), filled_at: '2026-11-20', kept: ids }));
  return { root, manifestPath, bytes: readFileSync(manifestPath) };
}
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const READERS = [OPUS, SOL, PARTICLE];
const ASTRA = 'openai:gpt-6-astra';

// ─── A synthetic analysis input ──────────────────────────────────────
// 12 worlds, two questions per stratum (k = 2 x stratum + j; the primary strata are k 0 to 9). gbrain misses a
// question when (w + k) % 7 is 0; memory-bank (and hybrid search) gets about a third right; extract-first is gbrain's
// pattern with one question flipped, in gbrain's favour in odd worlds and against it in even ones; temporal-graph is
// always right; the floor has the canonical view only and is always wrong.
const WORLDS = Array.from({ length: 12 }, (_, i) => `bg1-${String(i + 1).padStart(3, '0')}`);
const gb = (w: number, k: number) => ((w + k) % 7 === 0 ? 0 : 1);
const flipAt = (w: number) => { const miss = (7 - (w % 7)) % 7; return w % 2 === 0 ? miss : miss + 1; };
const PATTERNS: Record<Exclude<Bg1Row, 'floor'>, (w: number, k: number) => number> = {
  gbrain: gb,
  'memory-bank': (w, k) => ((w + 2 * k) % 3 === 0 ? 1 : 0),
  'extract-first': (w, k) => (k === flipAt(w) ? 1 - gb(w, k) : gb(w, k)),
  'temporal-graph': () => 1,
  hybrid: (w, k) => ((w + 2 * k) % 3 === 0 ? 1 : 0),
};
const val = (s: number): ReaderValue => ({ gating: s, canonical: s, match: s ? 'correct' : 'stale' });
function synthetic(edit: (q: QuestionInput, w: number, k: number) => void = () => {}): Bg1Input {
  const questions: QuestionInput[] = [];
  WORLDS.forEach((conversation, w) => BG1_STRATA.forEach((stratum, s) => [0, 1].forEach(j => {
    const k = 2 * s + j;
    const rows: QuestionInput['rows'] = Object.fromEntries(Object.entries(PATTERNS).map(([row, f]) => [row, Object.fromEntries(READERS.map(r => [r, val(f(w, k))]))]));
    rows.floor = Object.fromEntries(READERS.map(r => [r, { gating: null, canonical: 0, match: 'other' }]));
    const q: QuestionInput = { id: `${conversation}-q${String(k).padStart(2, '0')}`, conversation, stratum, rows };
    edit(q, w, k);
    questions.push(q);
  })));
  const rows: Bg1Row[] = ['gbrain', 'memory-bank', 'extract-first', 'temporal-graph', 'hybrid', 'floor'];
  return { set: 'BG1', questions, fill: { gbrain: 0.95, 'memory-bank': 0.95, 'extract-first': 0.95, 'temporal-graph': 0.95, hybrid: 0.95 },
    costs: rows.flatMap(row => READERS.flatMap(reader => WORLDS.map(conversation => ({ row, reader, conversation, usd: row === 'gbrain' ? 1 : row === 'floor' ? 0.1 : 2 })))),
    snapshots: { [ASTRA]: ['gpt-6-astra-2026-10-01'], [OPUS]: ['claude-opus-5-5-20261001'] } };
}
const keysDeep = (x: unknown): string[] => (x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]) : []);

describe('the analysis', () => {
  const a = analyze(synthetic());
  test('the primary family: ahead of memory-bank, no measurable difference with extract-first, behind temporal-graph', () => {
    expect(a.primary.comparisons.map(c => [c.row, c.verdict])).toEqual([['memory-bank', 'ahead'], ['extract-first', 'no measurable difference'], ['temporal-graph', 'behind']]);
    expect(a.primary.comparisons.every(c => c.descriptive === null && c.worlds === 12 && c.questions === 120)).toBe(true);
    expect(a.primary.comparisons[1].test!.mean).toBeCloseTo(0, 9);
    expect(a.primary.comparisons[0].wild!.method).toContain('restricted wild cluster bootstrap-t');
    expect(a.primary.worst_case).toEqual({ verdicts: ['ahead', 'no measurable difference', 'behind'], disagrees: false });
    expect([a.planned, a.common, a.worlds]).toEqual([192, 192, 12]);
  });

  test('the time-indexed family, design control, per-stratum and per-reader rows are reported beside it', () => {
    expect(a.time_indexed.comparisons.map(c => c.row)).toEqual(['memory-bank', 'extract-first', 'temporal-graph']);
    expect(a.design_control).toMatchObject({ attributable_to_design: true, note: null, comparison: { row: 'hybrid', verdict: 'ahead' } });
    expect(a.per_stratum.map(s => s.stratum)).toEqual([...BG1_STRATA]);
    expect(a.per_reader.map(r => r.reader)).toEqual(READERS);
    expect(a.per_reader[0].rows['memory-bank'].note).toBe('unadjusted');
    expect(a.row_means.floor[OPUS]).toBe(0);
    expect(a.row_means['temporal-graph'][SOL]).toBe(100);
  });

  test('cost per correct answer: the first table shows Opus and particle-1, then Sol, and gbrain\'s ratio to each comparator is tested', () => {
    expect(a.cost_per_correct.table.map(t => t.reader)).toEqual([OPUS, PARTICLE, SOL]);
    const [mb, , tg] = a.cost_per_correct.comparisons;
    expect(mb).toMatchObject({ row: 'memory-bank', verdict: 'ahead' });
    expect(mb.ratio!).toBeLessThan(1);
    expect(tg.ratio!).toBeLessThan(1);
    const missing = synthetic();
    missing.costs = missing.costs.filter(c => !(c.row === 'memory-bank' && c.reader === PARTICLE && c.conversation === WORLDS[0]));
    expect(analyze(missing).cost_per_correct.comparisons[0]).toMatchObject({ ratio: null, verdict: null, note: expect.stringContaining('missing') });
  }, 30_000);

  test('the matcher\'s agreement with each view, an unclear reading left out of kappa, and the judges\' model versions', () => {
    expect(a.matcher.gating).toMatchObject({ agreement: 1, kappa: 1 });
    const unclear = synthetic((q, w, k) => { if (w === 0 && k === 0) q.rows.gbrain![OPUS] = { gating: 1, canonical: 1, match: 'unclear' }; });
    const m = matcherAgreement(unclear, 'gating');
    expect(m.answers - m.decisive).toBe(1);
    expect(m.table.unclear).toEqual({ judged_correct: 1, judged_wrong: 0 });
    expect(a.judges.mixed_snapshot).toEqual([]);
  });

  test('exposure summaries by row and stratum where frozen contexts were read', () => {
    const exposed = analyze(synthetic((q, w) => { q.exposure = { gbrain: { gold: true, stale: w % 2 === 0, deciding_line: q.stratum === 's4_conflicting' ? w < 6 : null } }; }));
    expect(exposed.exposure.gbrain!.all).toMatchObject({ contexts: 192, gold_rate: 1, stale_rate: 0.5, gold_only_rate: 0.5, deciding_line_checked: 24, deciding_line_rate: 0.5 });
    expect(exposed.exposure.gbrain!.by_stratum.s4_conflicting!.contexts).toBe(24);
    expect(exposed.exposure['memory-bank']).toBeUndefined();
  }, 30_000);
});

describe('drops, the worst case and the fill gate', () => {
  test('a harness failure drops the question from every comparison, by side and reason; a product failure scores 0', () => {
    const one = synthetic((q, w, k) => { if (w === 0 && k === 1) q.rows.gbrain![SOL] = { drop: 'reader_error' }; });
    expect(commonSet(one).size).toBe(191);
    expect(dropsOf(one)).toEqual({ planned: 192, dropped: 1, share: 1 / 192, by: { 'gbrain|reader_error': 1 } });
    expect(analyze(one).invalid_reasons).toEqual([]);
    const missing = synthetic((q, w, k) => { if (w === 1 && k === 2) delete q.rows['memory-bank']; });
    expect(dropsOf(missing).by).toEqual({ 'other|row_missing': 3 });
  }, 30_000);

  // Value: protects=the preregistered drop cap is per comparison, over that comparison's own planned questions; fails_when=one share over every stratum decides every family, so primary drops hide under the global share or time-indexed drops void the primary family; why_new=red-team #2 on #398; seam=analyze; no_claim=which drops a real run has
  test('above 5% of a comparison\'s own planned questions dropped, that family\'s comparisons are descriptive and the other family still decides', () => {
    const primaryDrops = analyze(synthetic((q, w, k) => { if (w < 9 && k === 0) q.rows['memory-bank']![PARTICLE] = { drop: 'reread_answer_missing' }; }));
    expect([primaryDrops.drops.dropped, primaryDrops.drops.planned]).toEqual([9, 192]);
    expect(primaryDrops.primary.drops).toMatchObject({ planned: 120, dropped: 9, share: 9 / 120 });
    expect(primaryDrops.time_indexed.drops).toMatchObject({ planned: 72, dropped: 0 });
    expect(primaryDrops.invalid_reasons).toEqual(['primary: 9 of 120 planned questions dropped (7.5%, above the 5% cap)']);
    for (const c of [...primaryDrops.primary.comparisons, primaryDrops.design_control.comparison]) { expect(c.verdict).toBeNull(); expect(c.descriptive).toContain('above the 5% cap'); }
    for (const c of primaryDrops.time_indexed.comparisons) { expect(c.verdict).not.toBeNull(); expect(c.descriptive ?? '').not.toContain('above the 5% cap'); }
    const timeDrops = analyze(synthetic((q, w, k) => { if (w < 5 && (k === 10 || k === 11)) q.rows['memory-bank']![PARTICLE] = { drop: 'reread_answer_missing' }; }));
    expect(timeDrops.drops).toMatchObject({ planned: 192, dropped: 10 });
    expect(timeDrops.invalid_reasons).toEqual(['time-indexed: 10 of 72 planned questions dropped (13.9%, above the 5% cap)']);
    for (const c of timeDrops.time_indexed.comparisons) { expect(c.verdict).toBeNull(); expect(c.descriptive).toContain('above the 5% cap'); }
    for (const c of [...timeDrops.primary.comparisons, timeDrops.design_control.comparison]) { expect(c.verdict).not.toBeNull(); expect(c.descriptive ?? '').not.toContain('above the 5% cap'); }
  }, 30_000);

  test('the worst case scores every planned question, a gbrain drop as 0 and a comparator drop as 100', () => {
    const q = (rows: QuestionInput['rows']): QuestionInput => ({ id: 'q', conversation: 'w', stratum: 's1_updated', rows });
    const all = (s: number) => Object.fromEntries(READERS.map(r => [r, val(s)]));
    const input = { questions: [q({ gbrain: { ...all(1), [SOL]: { drop: 'reader_error' } }, 'memory-bank': { ...all(0), [OPUS]: { drop: 'judge_error' } } })] };
    expect(worldDifferences(input, 'memory-bank', ['s1_updated'])).toEqual([]);
    const [d] = worldDifferences(input, 'memory-bank', ['s1_updated'], { worstCase: true });
    expect(d.d).toBeCloseTo((100 + 0 + 100) / 3 - (100 + 0 + 0) / 3, 9);
  });

  test('a comparison whose row (or gbrain) fails the 0.90 fill gate is descriptive', () => {
    const low = synthetic();
    low.fill['memory-bank'] = 0.85;
    const a = analyze(low);
    expect(a.primary.comparisons[0]).toMatchObject({ verdict: null, descriptive: 'descriptive: memory-bank failed the delivered-context gate (mean fill rate 0.85, below 0.9)' });
    expect(a.primary.comparisons[1].verdict).toBe('no measurable difference');
    low.fill.gbrain = null;
    expect(analyze(low).primary.comparisons.every(c => c.verdict === null && c.descriptive!.includes('gbrain failed the delivered-context gate (mean fill rate unknown'))).toBe(true);
  }, 30_000);
});

describe('the pilot', () => {
  test('emits the three primary SDs and their correlations under the gating view, and no mean anywhere', () => {
    const p = pilotStats(synthetic());
    expect(p).toMatchObject({ schema: 'gbrain-evals/bg1-pilot/v1', worlds: 12, view: 'gating', family: 'primary' });
    expect(Object.keys(p.sds)).toEqual(['ext-memory-bank', 'ext-extract-first', 'ext-temporal-graph']);
    expect(p.sds['ext-extract-first']).toBeCloseTo(10 * Math.sqrt(12 / 11), 3);
    expect(Object.keys(p.correlations)).toEqual(['ext-memory-bank|ext-extract-first', 'ext-memory-bank|ext-temporal-graph', 'ext-extract-first|ext-temporal-graph']);
    expect(keysDeep(p).filter(k => /mean|avg|average/i.test(k))).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(/mean/i);
  });

  test('refuses fewer than two worlds', () => {
    const one = synthetic();
    one.questions = one.questions.filter(q => q.conversation === WORLDS[0]);
    expect(() => pilotStats(one)).toThrow('at least two worlds');
  });
});

describe('judgment and receipt checks', () => {
  const good = { answer_id: 'a'.repeat(64), instrument_id: frontierInstrumentId('bg1', ASTRA), judge: ASTRA, outcome: 'scored' as const, view: 'gating' as const, settings: { ...PER_READER_JUDGE_SETTINGS }, judge_versions: ['gpt-6-astra-2026-10-01'] };
  test('a gating judgment counts only from the reader\'s mapped judge, of another family, with the gating view, the pinned settings and a model version', () => {
    expect(gatingProblems(good, OPUS, 'bg1')).toEqual([]);
    expect(gatingProblems({ ...good, instrument_id: 'bg1', judge: 'gemini:gemini-3.8-flash' }, OPUS, 'bg1')).toEqual([]);
    const own = gatingProblems({ ...good, judge: OPUS, instrument_id: frontierInstrumentId('bg1', OPUS) }, OPUS, 'bg1');
    expect(own.join('\n')).toContain('a judge of its own family (GST-767)');
    expect(own.join('\n')).toContain('not its mapped judge openai:gpt-6-astra');
    expect(gatingProblems(good, SOL, 'bg1').join('\n')).toContain('not its mapped judge anthropic:claude-opus-5-5');
    expect(gatingProblems({ ...good, view: undefined }, OPUS, 'bg1')[0]).toContain('does not record the gating view');
    expect(gatingProblems({ ...good, settings: { effort: 'high', max_tokens: 8000 } }, OPUS, 'bg1')[0]).toContain('not the pinned');
    expect(gatingProblems({ ...good, settings: undefined }, OPUS, 'bg1')[0]).toContain('sent at null, not the pinned');
    expect(gatingProblems({ ...good, judge_versions: [] }, OPUS, 'bg1')[0]).toContain('records no judge model version');
    expect(gatingProblems(good, 'gemini:gemini-3.8-flash', 'bg1')[0]).toContain('gemini:gemini-3.8-flash');
  });

  test('a product failure scores 0, a harness failure or a missing judgment drops, and the floor reads the canonical view only', () => {
    const q = { id: 'q1', bg1: { stratum: 's1_updated', family: 'primary', form: 'exact', slot: 'x', gold_values: ['Porto'], stale_values: ['Lisbon'], decoy_values: [] } } as unknown as MemoryQuestion;
    const a = { answer_id: 'b'.repeat(64), reader: OPUS, outcome: 'scored' as const, text: 'Porto' };
    const scores = new Map([[`${a.answer_id}|bg1`, 0], [`${a.answer_id}|${frontierInstrumentId('bg1', bg1JudgeOf(OPUS))}`, 1]]);
    expect(readerValue(a, scores, 'bg1', q)).toEqual({ gating: 1, canonical: 0, match: 'correct' });
    expect(readerValue({ ...a, outcome: 'retrieval_error' }, scores, 'bg1', q)).toEqual({ gating: 0, canonical: 0, match: null });
    expect(readerValue({ ...a, outcome: 'reader_error' }, scores, 'bg1', q)).toEqual({ drop: 'reader_error' });
    expect(readerValue({ ...a, reader: SOL }, scores, 'bg1', q)).toEqual({ drop: 'judgment_missing:gating' });
    expect(readerValue(a, scores, 'bg1', q, true)).toEqual({ gating: null, canonical: 0, match: 'correct' });
    expect(readerValue(a, new Map(), 'bg1', q, true)).toEqual({ drop: 'judgment_missing:canonical' });
  });

  test('a set BG1 receipt must come from the filled manifest, or an earlier fill, and load only pinned bytes', () => {
    const manifest = { status: 'filled', files: [{ path: 'data/bg1-001.json', sha256: 'c'.repeat(64) }], earlier_fills: ['e'.repeat(64)] };
    const ds = (head: string, files = [{ path: 'data/bg1-001.json', sha256: 'c'.repeat(64) }]) => ({ revision: 'abcdef0', files: [{ path: BG1_MANIFEST_REL, sha256: head }, ...files] });
    expect(receiptManifestProblems(ds('d'.repeat(64)), manifest, 'd'.repeat(64))).toEqual([]);
    expect(receiptManifestProblems(ds('e'.repeat(64)), manifest, 'd'.repeat(64))).toEqual([]);
    expect(receiptManifestProblems(undefined, manifest, 'd'.repeat(64))).toEqual(['it records no dataset']);
    expect(receiptManifestProblems({ revision: 'unfilled' }, manifest, 'd'.repeat(64))).toEqual(['its dataset revision is unfilled']);
    expect(receiptManifestProblems({ revision: 'x', files: [{ path: 'other.json', sha256: 'd'.repeat(64) }] }, manifest, 'd'.repeat(64))[0]).toContain('is not the BG1 manifest');
    expect(receiptManifestProblems(ds('f'.repeat(64)), manifest, 'd'.repeat(64))[0]).toContain('is not the filled manifest\'s');
    expect(receiptManifestProblems(ds('d'.repeat(64), [{ path: 'data/extra.json', sha256: 'c'.repeat(64) }]), manifest, 'd'.repeat(64))).toEqual(['it loaded data/extra.json, which the filled manifest does not pin']);
    expect(receiptManifestProblems(ds('d'.repeat(64), [{ path: 'data/bg1-001.json', sha256: '0'.repeat(64) }]), manifest, 'd'.repeat(64))[0]).toContain('the manifest pins');
  });

  // Value: protects=the strata and values that decide a set-BG1 verdict come from the bytes its --manifest pins; fails_when=the corpus loads against GBRAIN_EVALS_BG1_MANIFEST or unpinned and nothing compares it to --manifest; why_new=red-team #5 on #398; seam=unpinnedCorpusFiles; no_claim=custody of the bytes
  test('a set-BG1 verdict refuses corpus bytes its --manifest does not pin', () => {
    const manifest = { status: 'filled', files: [{ path: 'worlds/bg1-001/world.json', sha256: 'a'.repeat(64) }, { path: 'worlds/bg1-001/questions.json', sha256: 'b'.repeat(64) }] };
    expect(unpinnedCorpusFiles(manifest.files, manifest, 'd'.repeat(64))).toEqual([]);
    expect(unpinnedCorpusFiles([{ path: 'worlds/bg1-001/world.json', sha256: 'c'.repeat(64) }, { path: 'worlds/bg1-002/world.json', sha256: 'a'.repeat(64) }], manifest, 'd'.repeat(64))).toEqual(['worlds/bg1-001/world.json', 'worlds/bg1-002/world.json']);
  });

  // Value: protects=a set-BG1 verdict and pilot can read the corpus the loader returns; fails_when=the manifest entry the loader lists first is checked against the manifest's own pins (which never hold it) instead of the manifest's SHA-256, so every set-BG1 verdict and pilot refuses; why_new=blocker 1 on #398 (verdict.ts:433); seam=unpinnedCorpusFiles, loadInput; no_claim=custody of the bytes
  test('the manifest entry the loader lists first is checked against the --manifest\'s own SHA-256, and every other file against its pins', () => {
    const { root, manifestPath, bytes } = mintedSet(1);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const corpus = loadBg1({ log: join(root, 'access.jsonl'), decisionId: 'd', purpose: 'verdict test' }, { root: join(root, 'set'), manifestPath, worldEnd: '2026-11-15', only: new Set(['bg1-001']) });
    expect(corpus.source.files[0]).toEqual({ path: BG1_MANIFEST_REL, sha256: sha(bytes) });
    expect(unpinnedCorpusFiles(corpus.source.files, manifest, sha(bytes))).toEqual([]);
    expect(unpinnedCorpusFiles(corpus.source.files, manifest, 'f'.repeat(64))).toEqual([BG1_MANIFEST_REL]);
    expect(unpinnedCorpusFiles(corpus.source.files.map((f, i) => (i === 1 ? { ...f, sha256: '0'.repeat(64) } : f)), manifest, sha(bytes))).toEqual([corpus.source.files[1].path]);
  }, 60_000);

  test('a set-BG1 pilot gets past the corpus check to its receipts', () => {
    const { root, manifestPath } = mintedSet(BG1_WAVE_A);
    const env = { GBRAIN_EVALS_BG1_SOURCE: join(root, 'set'), GBRAIN_EVALS_BG1_MANIFEST: manifestPath, GBRAIN_EVALS_CUSTODY_LOG: join(root, 'access.jsonl'), GBRAIN_EVALS_BG1_WORLD_END: '2026-11-15', GBRAIN_EVALS_BG1_UNIT: undefined };
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    mkdirSync(join(root, 'out', 'cells'), { recursive: true });
    try { expect(() => loadInput([join(root, 'out')], { set: 'BG1', manifestPath, waveA: true })).toThrow(/^no receipt for bg1\./); }
    finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }, 120_000);
});

// ─── Synthetic receipts on the dev set ────────────────────────────────
const DEV_QUESTIONS: MemoryQuestion[] = BG1_DEV_CONVERSATIONS.flatMap(conversation => BG1_STRATA.flatMap((stratum: Bg1Stratum, s) => [0, 1].map(j => ({
  id: `${conversation}-q${2 * s + j}`, conversation, question: 'Which city is current?', answer: 'Porto', category: stratum, gold: [], abstention: false,
  bg1: { stratum, family: s < 5 ? 'primary' : 'secondary', form: 'exact', slot: 'person-01.city', gold_values: ['Porto'], stale_values: ['Lisbon'], decoy_values: ['Braga'] },
}) as unknown as MemoryQuestion)));
const ndjson = (path: string, rows: unknown[]) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, rows.map(r => JSON.stringify(r) + '\n').join('')); };

interface Opts { limit?: number | null; keylessReread?: boolean; noReread?: string; configEdit?: (c: Record<string, any>) => void; gatingSettings?: Record<string, unknown>; omit?: string; extraRow?: string }
function writeReceipts(root: string, o: Opts = {}) {
  const qs = DEV_QUESTIONS.filter(q => q.id !== o.omit);
  const instrument = instrumentFor('bg1-dev');
  const defs = loadBG1Manifest().smoke_cells.filter(c => ROLES[c.system]) as CellDefinition[];
  const judgment = (answer_id: string, judge: string, instrument_id: string, score: number, gating: boolean) => ({
    answer_id, instrument_id, instrument_sha256: instrument.sha256, judge, judge_replicate: 0, temperature: null, score, parse_ok: true, raw_sha256: sha(judge + answer_id), outcome: 'scored',
    ...(gating ? { view: 'gating', settings: o.gatingSettings ?? { ...PER_READER_JUDGE_SETTINGS }, judge_versions: [`${judge}-v1`] } : {}),
  });
  const answer = (cell_id: string, system: string, arm: string, q: MemoryQuestion, reader: string, text: string) => ({
    answer_id: answerId(cell_id, q.id, reader, 0), cell_id, realization_id: 'r0', question_id: q.id, conversation: q.conversation, system, arm, reader, replicate: 0, effort: 'medium',
    context_sha256: sha(`ctx|${system}|${q.id}`), text, usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 1, outcome: 'scored',
  });
  for (const def of defs) {
    const arm = def.arms[0], floor = def.system === 'baseline-none';
    const dir = join(root, 'cells', arm.cell_id);
    const config = JSON.parse(runConfigText(def, arm, { instrument, dataset: { name: 'BG1 dev', files: [], revision: 'repo', license: 'MIT' }, scheduledSha: 'x', limit: o.limit ?? null }));
    o.configEdit?.(config);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-config.json'), JSON.stringify(config));
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ cell_id: arm.cell_id, run_cell: def.id, run_status: 'complete', instrument: { id: instrument.id, sha256: instrument.sha256 }, config_sha256: `cfg-${def.system}`, spend: { usd: { ingest: 0.3, retrieval: 0.1 } } }));
    ndjson(join(dir, 'rows.ndjson'), [...qs, ...(o.extraRow ? [{ id: o.extraRow, conversation: qs[0].conversation }] : [])].map(q => ({ id: q.id, cell_id: arm.cell_id, conversation: q.conversation, fill_rate: 0.95 })));
    const text = def.system === 'ext-memory-bank' ? 'Lisbon' : 'Porto';
    const answers = qs.flatMap(q => [OPUS, SOL].map(r => answer(arm.cell_id, def.system, arm.id, q, r, text)));
    ndjson(join(dir, 'answers.ndjson'), answers);
    const score = text === 'Porto' ? 1 : 0;
    ndjson(join(dir, 'judgments.ndjson'), answers.flatMap(a => [judgment(a.answer_id, 'gemini:gemini-3.8-flash', instrument.id, score, false),
      ...(floor ? [] : [judgment(a.answer_id, bg1JudgeOf(a.reader), frontierInstrumentId(instrument.id, bg1JudgeOf(a.reader)), score, true)])]));
    if (!floor) {
      ndjson(join(root, 'runs', def.id, 'contexts.ndjson'), qs.map(q => ({ key: q.id, prompt: `memory: ${q.id} lives in ${text}`, meta: { context_sha256: sha(`ctx|${def.system}|${q.id}`) } })));
      ndjson(join(root, 'runs', def.id, 'meters.ndjson'), answers.map(a => ({ phase: 'reader', key: `read:${a.answer_id.slice(0, 16)}`, usd: 0.01, requests: 1, unpriced: 0 })));
    }
    if (o.noReread === def.system) continue;
    const rid = rereadCellId(arm.cell_id, PARTICLE), rdir = join(root, 'cells', rid);
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, 'receipt.json'), JSON.stringify({ cell_id: rid, keyless: o.keylessReread ? true : false, run_status: 'complete', instrument: { id: instrument.id, sha256: instrument.sha256 }, source: { config_sha256s: [`cfg-${def.system}`] }, spend: { reader_usd: 0.48 } }));
    const ranswers = qs.map(q => answer(rid, def.system, arm.id, q, PARTICLE, text));
    ndjson(join(rdir, 'answers.ndjson'), ranswers);
    ndjson(join(rdir, 'judgments.ndjson'), ranswers.flatMap(a => [judgment(a.answer_id, 'gemini:gemini-3.8-flash', instrument.id, score, false),
      ...(floor ? [] : [judgment(a.answer_id, OPUS, frontierInstrumentId(instrument.id, OPUS), score, true)])]));
  }
  return root;
}
let n = 0;
const fresh = (o: Opts = {}) => writeReceipts(join(tmp, String(++n)), o);

describe('loadInput on synthetic dev receipts', () => {
  test('reads every row, both readers and particle-1\'s re-read, with exposure, fill and per-reader spend', () => {
    const input = loadInput([fresh()], { set: 'BG1-dev3' }, { questions: DEV_QUESTIONS });
    expect(input.questions).toHaveLength(48);
    const q = input.questions[0];
    expect(Object.keys(q.rows).sort()).toEqual(['extract-first', 'floor', 'gbrain', 'hybrid', 'memory-bank', 'temporal-graph']);
    expect(q.rows.gbrain![PARTICLE]).toEqual({ gating: 1, canonical: 1, match: 'correct' });
    expect(q.rows['memory-bank']![OPUS]).toEqual({ gating: 0, canonical: 0, match: 'stale' });
    expect(q.rows.floor![SOL]).toEqual({ gating: null, canonical: 1, match: 'correct' });
    expect(q.exposure!.gbrain).toEqual({ gold: true, stale: false, deciding_line: null });
    expect(q.exposure!['memory-bank']).toEqual({ gold: false, stale: true, deciding_line: null });
    expect(input.fill.gbrain).toBeCloseTo(0.95, 9);
    expect(input.costs.find(c => c.row === 'gbrain' && c.reader === PARTICLE && c.conversation === 'bg1-dev-01')!.usd).toBeCloseTo(16 * (0.4 / 48) + 0.48 / 48 * 16, 4);
    expect(input.snapshots[ASTRA]).toEqual([`${ASTRA}-v1`]);
    const a = analyze(input);
    expect(a.common).toBe(48);
    expect(a.primary.comparisons[0].row).toBe('memory-bank');
  }, 30_000);

  test('refuses a missing or keyless re-read, a run config that differs from bg1-cells.json, a --limit run, and an unpinned gating judgment', () => {
    const load = (o: Opts) => () => loadInput([fresh(o)], { set: 'BG1-dev3' }, { questions: DEV_QUESTIONS });
    expect(load({ noReread: 'ext-extract-first' })).toThrow('missing particle-1 re-read');
    expect(load({ keylessReread: true })).toThrow('is not a paid re-read');
    expect(load({ configEdit: c => { c.arm.budget = 4000; } })).toThrow('its run config differs from');
    expect(load({ limit: 5 })).toThrow('ran with --limit 5');
    expect(load({ gatingSettings: { effort: 'high', max_tokens: 8000 } })).toThrow('not the pinned');
  });

  // Value: protects=the 5% drop cap and the worst case count every question the corpus plans, not only those some row wrote; fails_when=a question no cell wrote a row for leaves the planned set instead of dropping as row_missing, or a row outside the planned questions is read; why_new=blocker 3 on #398 (verdict.ts:484); seam=synthetic dev receipts over DEV_QUESTIONS; no_claim=the drop cap's value
  test('a question no cell wrote a row for stays planned and drops as row_missing on every side; a row outside the planned questions refuses', () => {
    const gone = DEV_QUESTIONS[5];
    const input = loadInput([fresh({ omit: gone.id })], { set: 'BG1-dev3' }, { questions: DEV_QUESTIONS });
    expect(input.questions).toHaveLength(48);
    const q = input.questions.find(x => x.id === gone.id)!;
    expect({ conversation: q.conversation, stratum: q.stratum, rows: q.rows }).toEqual({ conversation: gone.conversation, stratum: gone.bg1!.stratum, rows: {} });
    expect(dropsOf(input)).toEqual({ planned: 48, dropped: 1, share: 1 / 48, by: { 'gbrain|row_missing': 3, 'other|row_missing': 12 } });
    expect(analyze(input).planned).toBe(48);
    expect(() => loadInput([fresh({ extraRow: 'bg1-dev-01-q99' })], { set: 'BG1-dev3' }, { questions: DEV_QUESTIONS })).toThrow('rows bg1-dev-01-q99 are not planned questions of the loaded bg1-dev corpus');
  }, 30_000);

  test('set BG1 needs the filled manifest, and the pilot reads set BG1 only', () => {
    const root = fresh();
    expect(() => loadInput([root], { set: 'BG1' }, { questions: DEV_QUESTIONS })).toThrow('set BG1 needs --manifest');
    expect(() => loadInput([root], { set: 'BG1' }, { questions: DEV_QUESTIONS, manifestBytes: new TextEncoder().encode(JSON.stringify({ status: 'unfilled', files: [] })) })).toThrow('the BG1 manifest is unfilled');
    const filled = new TextEncoder().encode(JSON.stringify({ status: 'filled', files: [], kept: WORLDS.slice(0, 30), n_final: null }));
    expect(() => loadInput([root], { set: 'BG1' }, { questions: DEV_QUESTIONS, manifestBytes: filled })).toThrow('kept list is not final');
    expect(() => loadInput([root], { set: 'BG1', waveA: true }, { questions: DEV_QUESTIONS, manifestBytes: new TextEncoder().encode(JSON.stringify({ status: 'filled', files: [], kept: WORLDS.slice(0, 5) })) })).toThrow('the first 12 kept worlds');
    expect(() => loadInput([root], { set: 'BG1-dev3', waveA: true }, { questions: DEV_QUESTIONS })).toThrow('the pilot reads set BG1 only');
  });

  test('the CLI writes verdict.json, and exits 2 on a usage error or a refusal', () => {
    const quiet = <T,>(fn: () => T): T => { const w = process.stderr.write; process.stderr.write = (() => true) as never; const o = process.stdout.write; process.stdout.write = (() => true) as never; try { return fn(); } finally { process.stderr.write = w; process.stdout.write = o; } };
    expect(quiet(() => main(['verdict', '--out', join(tmp, 'x')]))).toBe(2);
    expect(quiet(() => main(['verdict', '--receipts', tmp, '--set', 'BG2', '--out', join(tmp, 'x')]))).toBe(2);
    expect(quiet(() => main(['pilot', '--receipts', fresh(), '--set', 'BG1-dev3', '--out', join(tmp, 'x')]))).toBe(2);
  });

  // Value: protects=a corpus refusal at verdict time exits 2 with the refusal, like every other verdict refusal; fails_when=main rethrows the loader's DecideError as a crash; why_new=red-team #3 on #398; seam=main; no_claim=which refusal a real run meets
  test('a corpus refusal (here a missing world end) exits 2 with the loader\'s message instead of a stack trace', () => {
    const saved = process.env.GBRAIN_EVALS_BG1_WORLD_END;
    delete process.env.GBRAIN_EVALS_BG1_WORLD_END;
    let err = '';
    const w = process.stderr.write, o = process.stdout.write;
    process.stderr.write = ((s: string) => { err += s; return true; }) as never;
    process.stdout.write = (() => true) as never;
    try { expect(main(['verdict', '--receipts', fresh(), '--set', 'BG1-dev3', '--out', join(tmp, 'x')])).toBe(2); } finally {
      process.stderr.write = w; process.stdout.write = o;
      if (saved !== undefined) process.env.GBRAIN_EVALS_BG1_WORLD_END = saved;
    }
    expect(err).toContain('bg1 verdict refused: SPEC_MISSING: bg1: GBRAIN_EVALS_BG1_WORLD_END is not set');
  });
});

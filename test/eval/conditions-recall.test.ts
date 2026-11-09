/**
 * GBEV-55 G2, recall under real conditions: the seeded conditions-recall
 * generator, its paraphrase rule, the synthetic brain and its knobs, the six
 * live-recall arms over that brain, and the paid paraphrase script's refusal.
 * Keyless: brains are built inside withHermeticEnv with hash embeddings and a
 * token-overlap reranker, and no test constructs a model request.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_KNOBS, TEMPLATES, THINGS, applyParaphrases, generateConditionsRecall, paraphraseRuleBreaks, writeConditionsRecall, ConditionsRecallError, type ConditionsKnobs } from '../../eval/generators/conditions-recall-gen.ts';
import { enterHermeticEnv, withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { COPY_MARKER_TABLE } from '../../eval/runner/live-recall/brain.ts';
import { identifierTokens, liveRecall, parseQuestions, runQuestions } from '../../eval/runner/live-recall/run.ts';
import { ARMS, validateScorecard } from '../../eval/runner/live-recall/scorecard.ts';
import { buildSyntheticBrain, readSyntheticDir } from '../../eval/runner/live-recall/synthetic.ts';
import { main as paraphraseOpus } from '../../eval/runner/live-recall/paraphrase-opus.ts';

const PINNED_DIGEST = '5d76039662b0bd3dad413783a5733ac2b0763e3a3860f121f336909d5359c537';
const PINNED_QUESTIONS_SHA256 = '25a7cc094a54f21f907b536abb7ca8fc66fa36afc6f308e5243f0b466830f6f6';

const temps: string[] = [];
const tempDir = (label: string) => { const d = mkdtempSync(join(tmpdir(), 'g2-' + label + '-')); temps.push(d); return d; };
const writeSet = (knobs: Partial<ConditionsKnobs> = {}, perType = 4) => { const dir = tempDir('set'); writeConditionsRecall(dir, generateConditionsRecall({ perType, knobs })); return dir; };
const errorText = (fn: () => unknown) => { try { fn(); return 'no error'; } catch (e) { return e instanceof ConditionsRecallError ? e.message : 'other: ' + String(e); } };
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe('conditions-recall generator', () => {
  const full = generateConditionsRecall();
  const pageText = new Map(full.pages.map(p => [p.slug, p.body]));

  test('default seed reproduces the pinned digest and question file', () => {
    expect(full.manifest.digest).toBe(PINNED_DIGEST);
    expect(full.manifest.questions_sha256).toBe(PINNED_QUESTIONS_SHA256);
    expect(generateConditionsRecall().manifest.digest).toBe(PINNED_DIGEST);
    expect(generateConditionsRecall({ seed: 7 }).manifest.digest).not.toBe(PINNED_DIGEST);
    expect(full.manifest.counts.by_type).toEqual({ identifier: 20, error_string: 20, time_window: 20, cross_source: 20, topic: 20 });
    expect(full.manifest.knobs).toEqual(DEFAULT_KNOBS);
    expect(full.manifest.paraphrase_source).toBe('template');
    expect(parseQuestions(full.questionsText)).toHaveLength(100);
  });

  test('every template appears, at the default size and the smallest test size', () => {
    for (const m of [full.manifest, generateConditionsRecall({ perType: 2 }).manifest]) {
      for (const t of TEMPLATES) expect([t, m.counts.by_template[t] > 0]).toEqual([t, true]);
    }
  });

  test('exact and paraphrase forms differ and point at the same existing gold; identifier-bearing exact forms appear in their gold', () => {
    for (const q of full.questions) {
      expect(q.forms.exact.trim()).not.toBe('');
      expect(q.forms.paraphrase.trim()).not.toBe('');
      expect(q.forms.exact).not.toBe(q.forms.paraphrase);
      const goldText = q.gold.map(g => pageText.get(g.slug)!.toLowerCase()).join('\n');
      expect(goldText.length).toBeGreaterThan(0);
      for (const t of identifierTokens(q.forms.exact)) expect([q.id, t, goldText.includes(t)]).toEqual([q.id, t, true]);
    }
    const windowed = full.questions.filter(q => q.window);
    expect(windowed.every(q => q.type === 'time_window')).toBe(true);
    expect(windowed.length).toBe(15);
  });

  test('codename pages never name the thing their paraphrase asks about', () => {
    const codenames = full.questions.filter(q => full.manifest.question_templates[q.id] === 'codename');
    expect(codenames.length).toBe(10);
    for (const q of codenames) {
      const thing = THINGS.find(t => q.forms.paraphrase.includes(t.ask))!;
      expect(thing).toBeDefined();
      const body = pageText.get(q.gold[0].slug)!;
      for (const word of thing.forbidden) expect([q.id, word, new RegExp('\\b' + word + '\\b', 'i').test(body)]).toEqual([q.id, word, false]);
      expect(body).toContain(q.forms.exact.replace(/ status$|^Who is working on |\?$/g, ''));
    }
  });

  test('transcript-only facts sit in the transcript, not on the person page', () => {
    const qs = full.questions.filter(q => full.manifest.question_templates[q.id] === 'transcript_only');
    expect(qs.length).toBe(10);
    for (const q of qs) {
      expect(q.gold).toHaveLength(1);
      const transcript = pageText.get(q.gold[0].slug)!;
      const person = full.pages.find(p => p.slug.startsWith('people/') && q.forms.paraphrase.includes(p.body.match(/^title: (.+)$/m)![1]))!;
      expect(person).toBeDefined();
      const first = person.body.match(/^title: (\S+)/m)![1];
      const line = transcript.match(new RegExp('\\*\\*' + first + ':\\*\\* (.+)'))![1];
      expect(person.body).not.toContain(line);
      expect(q.gold.map(g => g.slug)).not.toContain(person.slug);
    }
  });

  test('nickname notes use only the nickname; the formal name is on the person page and in the paraphrase', () => {
    const qs = full.questions.filter(q => full.manifest.question_templates[q.id] === 'nickname');
    expect(qs.length).toBe(10);
    for (const q of qs) {
      const nick = q.forms.exact.split(' ')[0];
      const note = pageText.get(q.gold[0].slug)!;
      const person = full.pages.find(p => p.slug.startsWith('people/') && q.forms.paraphrase.includes(p.body.match(/^title: (.+)$/m)![1]))!;
      const formal = person.body.match(/^title: (.+)$/m)![1];
      expect(note).toContain(nick + ' said');
      expect(note).not.toContain(formal.split(' ')[0]);
      expect(q.forms.paraphrase).not.toContain(nick);
    }
  });

  test('template paraphrases follow the batch 2 rule', () => {
    expect(paraphraseRuleBreaks(full.questions)).toEqual([]);
  });

  test('a paraphrase file replaces every paraphrase and is refused by id when it breaks the rule or misses a question', () => {
    const small = generateConditionsRecall({ perType: 2 });
    const rows = small.questions.map(q => ({ id: q.id, paraphrase: 'a reworded request about ' + q.id.replace(/\d+/g, 'n') }));
    const good = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    const applied = generateConditionsRecall({ perType: 2, paraphrasesText: good });
    expect(applied.manifest.paraphrase_source).toBe('file');
    expect(applied.manifest.paraphrases_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(applied.questions.map(q => q.gold)).toEqual(small.questions.map(q => q.gold));
    expect(applied.questions.map(q => q.forms.exact)).toEqual(small.questions.map(q => q.forms.exact));
    expect(applied.manifest.digest).not.toBe(small.manifest.digest);

    const ticket = small.questions.find(q => q.id === 'id-1')!;
    const leakedToken = [...identifierTokens(ticket.forms.exact)][0];
    const leaky = 'secret wording ' + leakedToken.toUpperCase();
    const bad = rows.map(r => JSON.stringify(r.id === 'id-1' ? { id: r.id, paraphrase: leaky } : r)).join('\n');
    const message = errorText(() => applyParaphrases(small.questions, bad));
    expect(message).toContain('id-1');
    expect(message).not.toContain('secret wording');
    expect(errorText(() => applyParaphrases(small.questions, rows.slice(1).map(r => JSON.stringify(r)).join('\n')))).toContain('no paraphrase for id ' + rows[0].id);
    expect(errorText(() => applyParaphrases(small.questions, good + JSON.stringify({ id: 'nope-1', paraphrase: 'x' })))).toContain('names no generated question');
    expect(errorText(() => applyParaphrases(small.questions, good + JSON.stringify(rows[0])))).toContain('repeats id');
  });

  test('shell pages are never gold, keep their title, and nest as the share grows', () => {
    const gold = new Set(full.questions.flatMap(q => q.gold.map(g => g.slug)));
    const shellsAt = (share: number) => {
      const g = generateConditionsRecall({ knobs: { shell_page_share: share } });
      expect(g.manifest.questions_sha256).toBe(full.manifest.questions_sha256);
      return { g, slugs: g.pages.filter(p => p.body !== pageText.get(p.slug)).map(p => p.slug) };
    };
    const low = shellsAt(0.2), high = shellsAt(0.6);
    expect(low.slugs.length).toBe(Math.round(0.2 * full.manifest.shells.non_gold_pages));
    expect(high.g.manifest.shells.count).toBe(high.slugs.length);
    expect(low.slugs.every(s => high.slugs.includes(s))).toBe(true);
    expect(high.slugs.some(s => gold.has(s))).toBe(false);
    for (const kind of ['login_wall', 'css_only', 'pending_curation']) expect(high.g.manifest.shells.by_kind[kind]).toBeGreaterThan(0);
    for (const s of high.slugs) expect(high.g.pages.find(p => p.slug === s)!.body.match(/^title: .+$/m)![0]).toBe(pageText.get(s)!.match(/^title: .+$/m)![0]);
    expect(high.g.manifest.digest).not.toBe(full.manifest.digest);
  });

  test('bad knobs and sizes are refused', () => {
    expect(errorText(() => generateConditionsRecall({ knobs: { unembedded_chunk_share: 1.5 } }))).toContain('unembedded_chunk_share');
    expect(errorText(() => generateConditionsRecall({ knobs: { keyword_candidate_bound: 0 } }))).toContain('keyword_candidate_bound');
    expect(errorText(() => generateConditionsRecall({ perType: 99 }))).toContain('per-type');
  });
});

describe('synthetic brain (keyless)', () => {
  const gut = resolveGbrainUnderTest(null);

  test('refuses a directory edited after generation', () => {
    const dir = writeSet();
    expect(() => readSyntheticDir(dir)).not.toThrow();
    writeFileSync(join(dir, 'pages', 'notes', 'extra.md'), '---\ntype: note\ntitle: Extra\n---\n\nextra\n');
    expect(() => readSyntheticDir(dir)).toThrow('does not match its manifest digest');
  });

  test('runQuestions scores all six arms over the synthetic brain; configured_window runs only for windowed time_window questions', async () => {
    const dir = writeSet();
    await withHermeticEnv('g2-arms', async () => {
      const brain = await buildSyntheticBrain(gut, dir);
      try {
        const [ro] = await brain.engine.executeRaw("SELECT current_setting('default_transaction_read_only') AS ro");
        expect(ro.ro).toBe('on');
        const [marker] = await brain.engine.executeRaw("SELECT to_regclass('public.' || $1) IS NOT NULL AS present", [COPY_MARKER_TABLE]);
        expect(marker.present).toBe(true);
        expect(brain.applied.unembedded_chunks).toBe(0);
        expect(brain.applied.contextual_retrieval_mode).toEqual(['title']);
        const { hybridSearch } = await importGbrain<any>(gut, 'src/core/search/hybrid.ts');
        const { withAIInvocationGuard } = await importGbrain<any>(gut, 'src/core/ai/invocation-guard.ts');
        const questions = parseQuestions(brain.questionsText);
        const records = await runQuestions({ engine: brain.engine, hybridSearch, withGuard: withAIInvocationGuard, rerankerEnabled: true, embeddingOptedOut: false, vectorOpts: {} }, questions);
        expect(new Set(records.map(r => r.arm))).toEqual(new Set(ARMS));
        const windowed = new Set(questions.filter(q => q.type === 'time_window' && q.window).map(q => q.id));
        expect(windowed.size).toBe(3);
        expect(new Set(records.filter(r => r.arm === 'configured_window').map(r => r.qid))).toEqual(windowed);
        expect(records.length).toBe(questions.length * 2 * 5 + windowed.size * 2);
        expect(records.filter(r => r.status !== 'ok')).toEqual([]);
        expect(records.filter(r => r.arm === 'hybrid' && r.form === 'exact' && r.page_rank !== null && r.page_rank <= 5).length).toBeGreaterThan(questions.length / 2);
      } finally {
        await brain.close();
      }
    });
  }, 120_000);

  test('knobs change the built brain: half the chunks lose vectors, contextual prefixes go, keyword matching is bounded', async () => {
    const plainDir = writeSet();
    const knobDir = writeSet({ unembedded_chunk_share: 0.5, synopsis_vectors_off: true, keyword_candidate_bound: 2 });
    await withHermeticEnv('g2-knobs', async () => {
      const plain = await buildSyntheticBrain(gut, plainDir);
      let plainRows: number;
      try {
        plainRows = (await plain.engine.searchKeyword('weekly status', { limit: 50 })).length;
      } finally {
        await plain.close();
      }
      expect(plainRows).toBeGreaterThan(2);
      const brain = await buildSyntheticBrain(gut, knobDir);
      try {
        const [row] = await brain.engine.executeRaw('SELECT count(*)::int AS n, count(embedding)::int AS embedded FROM content_chunks');
        expect(row.n).toBe(brain.applied.chunks);
        expect(row.n - row.embedded).toBe(Math.round(0.5 * row.n));
        expect(brain.applied.contextual_retrieval_mode).toEqual(['none']);
        let incomplete = 0;
        const rows = await brain.engine.searchKeyword('weekly status', { limit: 50, onKeywordIncomplete: () => { incomplete++; } });
        expect(incomplete).toBe(1);
        expect(rows.length).toBeLessThanOrEqual(2);
        expect(rows.length).toBeGreaterThan(0);
        const again = await brain.engine.searchKeyword('weekly status', { limit: 50 });
        expect(again.map((r: any) => r.chunk_id)).toEqual(rows.map((r: any) => r.chunk_id));
      } finally {
        await brain.close();
      }
    });
  }, 120_000);
});

describe('paraphrase-opus (paid path)', () => {
  let restore: () => void;
  beforeAll(() => { restore = enterHermeticEnv('g2-paid').restore; });
  afterAll(() => restore());

  test('refuses without --paid and a budget run, before any client or request exists', async () => {
    const dir = writeSet({}, 2);
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
      expect(await paraphraseOpus(['--dir', dir, '--out', out, '--budget-ledger', ledger, '--paid'], { makeClient })).toBe(2);
      expect(await paraphraseOpus(['--dir', dir, '--out', out, '--budget-ledger', ledger, '--paid', '--budget-run-id', 'no-such-run'], { makeClient })).toBe(2);
    } finally {
      globalThis.fetch = savedFetch;
      console.error = savedError;
    }
    expect(clients).toBe(0);
    expect(fetches).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(ledger)).toBe(false);
  });
});

describe('live-recall run --synthetic (keyless)', () => {
  test('scores the six arms on a generated brain, records the knobs, and passes custody', async () => {
    const dir = writeSet({ unembedded_chunk_share: 0.3, synopsis_vectors_off: true, keyword_candidate_bound: 5, shell_page_share: 0.3 }, 2);
    const out = tempDir('run');
    const card = await withHermeticEnv('g2-synthetic-run', async () => {
      const paths = await liveRecall({ fixture: false, synthetic: dir, databaseUrlEnv: 'UNUSED', out: join(out, 'run'), gut: resolveGbrainUnderTest(null) }, () => {});
      return JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    });
    expect(() => validateScorecard(card)).not.toThrow();
    expect(card.run.control).toBe(true);
    expect(card.run.engine).toBe('pglite');
    expect(card.run.synthetic).toMatchObject({ unembedded_chunk_share: 0.3, synopsis_vectors_off: true, keyword_candidate_bound: 5, shell_page_share: 0.3 });
    expect(card.run.synthetic.digest).toBe(readSyntheticDir(dir).manifest.digest);
    expect(card.run.synthetic.unembedded_chunks).toBe(Math.round(0.3 * card.run.synthetic.chunks));
    expect(card.questions.loaded).toBe(10);
    for (const arm of ['keyword', 'vector', 'hybrid_lexical', 'hybrid', 'configured']) expect(card.arms[arm].overall.all.n).toBe(20);
  }, 180_000);
});

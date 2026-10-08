/**
 * Hedge classifier for Q1's derived columns (eval/runner/q1/hedge.ts): the
 * rule table on abstentions, hedges, negations, quotes and reported speech;
 * its version and rule-table hash; the `sample` and `validate` tools; the
 * committed fixture validation numbers; and the answer record round trip with
 * the `hedge` and `delivered_tokens` fields. Every answer here is invented.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { classify, CLASSIFIER_VERSION, explainVerdict, hedgeStamp, parseCsv, RULES, RULES_SHA256, stratifiedSample, toCsv, validate, type SampleAnswer, type SampleDesign } from '../../eval/runner/q1/hedge.ts';
import { answerId, answerProblems, readRecords, RecordLog, type AnswerRecord } from '../../eval/runner/memory-qa/records.ts';

const ROOT = resolve(import.meta.dir, '../..');
const FIX = join(ROOT, 'test/eval/fixtures/hedge');

const cases = (verdict: string, texts: string[]) => texts.map(t => [t, verdict] as const);

describe('classify', () => {
  test.each([
    ...cases('abstain', [
      "I don't know.", 'The conversation doesn\'t say.', 'There is no information about that.', 'I cannot determine that from the history.',
      'Not mentioned in the conversation.', 'You never mentioned a sister.', "I don't have any record of a dentist appointment.", 'None of the sessions mention it.',
      "It's unclear from our conversations whether you bought it.", 'Unknown.', '', '   ', "I'm not aware of you ever mentioning it.",
    ]),
    ...cases('hedged', [
      'Probably March.', 'I think it was Tuesday.', 'It was likely Daniel.', 'It might be the Ridge Loop.', "I'm not sure, but it was May 3.",
      'It seems you chose the blue tiles.', 'Possibly the pottery class.', 'If I recall correctly, it was 42 hours.', 'Maybe Wednesday?',
    ]),
    ...cases('confident', ['Your sister is Priya.', 'You paid $1,250.', 'Yes, on May 12.', 'Three classes: pottery, Spanish and climbing.']),
  ])('%p is %s', (text, verdict) => {
    expect(classify(text)).toBe(verdict as ReturnType<typeof classify>);
  });

  test('negation: confident negations match no cue, negated hedges stay hedges, "not mentioned again" is a fact', () => {
    expect(classify('There\'s no doubt: you booked August 9.')).toBe('confident');
    expect(classify("It's not a guess: you wrote down 7:45.")).toBe('confident');
    expect(classify("You weren't unsure at all; you picked the red one.")).toBe('confident');
    expect(classify("No, you didn't go to Lisbon; it was Porto.")).toBe('confident');
    expect(classify('It wasn\'t possible to get the 9 am slot, so you booked 11 am.')).toBe('confident');
    expect(classify('It was not mentioned again after session 4; the budget was $2,400.')).toBe('confident');
    expect(classify("You didn't mention it until June, when you said it was Rome.")).toBe('confident');
    expect(classify("I don't think it was Tuesday.")).toBe('hedged');
    expect(classify('It is unlikely you went twice.')).toBe('hedged');
    expect(classify("I'm not 100% sure it was Daniel.")).toBe('hedged');
    expect(classify("I don't think you ever mentioned the restaurant.")).toBe('abstain');
  });

  test('quoted text is not the answer\'s own voice', () => {
    expect(classify('You said "I think I\'ll go with the blue tiles" and ordered them.')).toBe('confident');
    expect(classify('The note says “no information yet”, and you hired Kim the next day.')).toBe('confident');
    expect(classify("You named the podcast 'Maybe Later'.")).toBe('confident');
    expect(classify("You wrote 'I don't know' in the form, then filled in Friday.")).toBe('confident');
    expect(classify('The title is `Probably Fine`.')).toBe('confident');
    expect(classify('> I think it was March\n\nIt was March 3.')).toBe('confident');
    expect(classify('You asked "when is it?" but the date was never mentioned.')).toBe('abstain');
    expect(classify('"Probably" is how you put it, and I think it was the cheaper flight.')).toBe('hedged');
  });

  test('reported speech reports the user\'s hedge without hedging; a hedge after it is the answer\'s own', () => {
    expect(classify('You mentioned you might move to Denver next spring.')).toBe('confident');
    expect(classify('Your doctor told you the rash might be an allergy, and you started antihistamines.')).toBe('confident');
    expect(classify("You said you don't know your neighbor's name yet.")).toBe('confident');
    expect(classify("You said it was the 5th, but I'm not sure that's right.")).toBe('hedged');
    expect(classify("You mentioned the trip, but you didn't mention the date.")).toBe('abstain');
  });

  test('an abstention that guesses, or that only disclaims precision before answering, is hedged', () => {
    expect(classify("The conversation doesn't say, but it was probably Tuesday.")).toBe('hedged');
    expect(classify("I don't know the exact date, but it was in early April.")).toBe('hedged');
    expect(classify("I can't say for sure, but the recital was May 12.")).toBe('hedged');
    expect(classify('It wasn\'t mentioned explicitly, though you hinted the party was Saturday.')).toBe('hedged');
    expect(classify("The conversation doesn't mention the exact date of your trip.")).toBe('abstain');
    expect(classify('You never mentioned a brother. You did mention your sister Lena.')).toBe('abstain');
    expect(classify("I can't say. You talked about the trip, but not the date.")).toBe('abstain');
  });

  test('the month May is not the modal; explainVerdict names the rules', () => {
    expect(classify('Your recital was on May 12, and the dentist is May 3.')).toBe('confident');
    expect(classify('It may have been Daniel.')).toBe('hedged');
    const e = explainVerdict("The conversation doesn't say, but it was probably Tuesday.");
    expect(e).toEqual({ verdict: 'hedged', abstain: [], hedge: ['h.probably'], demoted: ['a.doesnt-say'] });
  });

  test('version and rule-table hash; the stamp cell.ts writes', () => {
    expect(CLASSIFIER_VERSION).toBe('hedge-v1');
    expect(RULES_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(RULES.map(r => r.id)).size).toBe(RULES.length);
    for (const r of RULES) expect(() => new RegExp(r.pattern, `g${r.flags ?? ''}`)).not.toThrow();
    expect(hedgeStamp('Probably March.')).toEqual({ verdict: 'hedged', classifier_version: 'hedge-v1' });
  });
});

describe('sample and validate', () => {
  const answer = (i: number, text: string, extra: Partial<SampleAnswer> = {}): SampleAnswer => ({ answer_id: `a${String(i).padStart(3, '0')}`, cell_id: 'c', question_id: `q${i}`, reader: 'r', text, outcome: 'scored', ...extra });
  const pool = [
    ...Array.from({ length: 50 }, (_, i) => answer(i, `It was Tuesday number ${i}.`)),
    ...Array.from({ length: 30 }, (_, i) => answer(100 + i, `Probably option ${i}.`)),
    ...Array.from({ length: 5 }, (_, i) => answer(200 + i, `I don't know about item ${i}.`)),
    answer(300, '', { outcome: 'retrieval_error' }), answer(301, 'Probably not counted.', { outcome: 'reader_error' }), answer(302, '   '),
  ];

  test('equal allocation by verdict, a short stratum\'s remainder spread over the others, seeded and deterministic', () => {
    const s = stratifiedSample(pool, 30, 'seed-1');
    expect(s.eligible).toBe(85);
    expect(s.strata).toEqual({ abstain: { population: 5, sampled: 5 }, hedged: { population: 30, sampled: 13 }, confident: { population: 50, sampled: 12 } });
    expect(s.rows).toHaveLength(30);
    expect(new Set(s.rows.map(r => r.answer_id)).size).toBe(30);
    expect(stratifiedSample(pool, 30, 'seed-1').rows).toEqual(s.rows);
    expect(stratifiedSample(pool, 30, 'seed-2').rows.map(r => r.answer_id)).not.toEqual(s.rows.map(r => r.answer_id));
    expect(stratifiedSample(pool, 500, 'seed-1').rows).toHaveLength(85);
  });

  test('the CLI exports a blind CSV and a design file; validate reports precision, recall and the confusion matrix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hedge-'));
    writeFileSync(join(dir, 'a.ndjson'), pool.slice(0, 60).map(a => JSON.stringify(a) + '\n').join(''));
    writeFileSync(join(dir, 'b.ndjson.gz'), gzipSync(pool.slice(60).map(a => JSON.stringify(a) + '\n').join('')));
    const out = join(dir, 'sample.csv');
    const run = Bun.spawnSync(['bun', 'eval/runner/q1/hedge.ts', 'sample', '--answers', join(dir, 'a.ndjson'), '--answers', join(dir, 'b.ndjson.gz'), '--n', '30', '--seed', 'seed-1', '--out', out], { cwd: ROOT });
    expect(run.exitCode).toBe(0);
    const rows = parseCsv(readFileSync(out, 'utf8'));
    expect(rows).toHaveLength(30);
    expect(Object.keys(rows[0])).toEqual(['answer_id', 'cell_id', 'question_id', 'reader', 'text', 'label', 'note']);
    expect(rows.every(r => r.label === '')).toBe(true);
    const design = JSON.parse(readFileSync(`${out}.design.json`, 'utf8')) as SampleDesign;
    expect(design.strata.abstain).toEqual({ population: 5, sampled: 5 });
    expect(design.rules_sha256).toBe(RULES_SHA256);
    expect(design.answers).toHaveLength(2);

    // A labeler disagrees on two answers: one hedge the classifier missed, one abstention it called hedged.
    const labeled: Array<Record<string, string>> = rows.map(r => ({ ...r, label: classify(r.text) }));
    const conf = labeled.find(r => classify(r.text) === 'confident')!; conf.label = 'hedged';
    const hed = labeled.find(r => classify(r.text) === 'hedged')!; hed.label = 'abstain';
    writeFileSync(out, toCsv(Object.keys(rows[0]), labeled));
    const v = Bun.spawnSync(['bun', 'eval/runner/q1/hedge.ts', 'validate', '--labels', out, '--design', `${out}.design.json`, '--out', join(dir, 'v.json')], { cwd: ROOT });
    expect(v.exitCode).toBe(0);
    const report = JSON.parse(v.stdout.toString());
    expect(report).toEqual(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8')));
    expect(report.n).toBe(30);
    expect(report.confusion).toEqual({ abstain: { abstain: 5, hedged: 1, confident: 0 }, hedged: { abstain: 0, hedged: 12, confident: 1 }, confident: { abstain: 0, hedged: 0, confident: 11 } });
    expect(report.per_class.hedged).toEqual({ support: 13, predicted: 13, precision: Number((12 / 13).toFixed(4)), recall: Number((12 / 13).toFixed(4)) });
    expect(report.per_class.abstain).toEqual({ support: 6, predicted: 5, precision: 1, recall: Number((5 / 6).toFixed(4)) });
    expect(report.accuracy).toBe(Number((28 / 30).toFixed(4)));
    expect(report.misclassified).toHaveLength(2);
    const wAbstain = 5 * 1, wHedgedAsAbstain = 30 / 13;
    expect(report.population_weighted.recall.abstain).toBe(Number((wAbstain / (wAbstain + wHedgedAsAbstain)).toFixed(4)));
    rmSync(dir, { recursive: true });
  });

  test('validate refuses an unknown label and a file with nothing labeled; CSV quoting round-trips', () => {
    const header = ['answer_id', 'text', 'label'];
    expect(() => validate(toCsv(header, [{ answer_id: 'x', text: 'Probably.', label: 'maybe' }]))).toThrow(/not one of abstain, hedged, confident/);
    expect(() => validate(toCsv(header, [{ answer_id: 'x', text: 'Probably.', label: '' }]))).toThrow(/no labeled rows/);
    const tricky = { answer_id: 'x', text: 'He said "probably",\nthen, "no"', label: 'confident' };
    expect(parseCsv(toCsv(header, [tricky]))).toEqual([tricky]);
  });
});

describe('labeled fixture', () => {
  for (const name of ['dev', 'holdout'] as const) {
    test(`${name}: the committed validation numbers are the classifier's current numbers`, () => {
      const csv = readFileSync(join(FIX, `labeled-${name}.csv`), 'utf8');
      const committed = JSON.parse(readFileSync(join(FIX, `validation-${name}.json`), 'utf8'));
      expect(validate(csv)).toEqual(committed);
      expect(committed.rules_sha256).toBe(RULES_SHA256);
    });
  }

  test('at least 120 labeled answers covering every class, with negations and quotes', () => {
    const rows = ['dev', 'holdout'].flatMap(n => parseCsv(readFileSync(join(FIX, `labeled-${n}.csv`), 'utf8')));
    expect(rows.length).toBeGreaterThanOrEqual(120);
    for (const label of ['abstain', 'hedged', 'confident']) expect(rows.filter(r => r.label === label).length).toBeGreaterThanOrEqual(40);
    expect(rows.filter(r => /negation/.test(r.note)).length).toBeGreaterThanOrEqual(15);
    expect(rows.filter(r => /quote/.test(r.note)).length).toBeGreaterThanOrEqual(8);
    expect(new Set(rows.map(r => r.answer_id)).size).toBe(rows.length);
  });
});

describe('answer records carry the derived fields', () => {
  test('hedge and delivered_tokens round-trip through the immutable log; bad values are refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hedge-records-'));
    const path = join(dir, 'answers.ndjson');
    const a: AnswerRecord = {
      answer_id: answerId('cell', 'q1', 'reader', 0), cell_id: 'cell', realization_id: 'r', question_id: 'q1', conversation: 'c', system: 'gbrain-defaults', arm: 'component', reader: 'reader', replicate: 0,
      effort: 'medium', context_sha256: 'a'.repeat(64), text: 'Probably March.', usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 5, outcome: 'scored',
      hedge: hedgeStamp('Probably March.'), delivered_tokens: { cl100k_base: 7012, o200k_base: 6950 },
    };
    expect(answerProblems(a)).toEqual([]);
    const log = new RecordLog(path, 'answer');
    expect(log.append(a)).toBe('appended');
    expect(new RecordLog(path, 'answer').append(a)).toBe('exists');
    expect(readRecords(path, 'answer')).toEqual([a]);
    expect(answerProblems({ ...a, hedge: { verdict: 'unsure', classifier_version: 'hedge-v1' } })).toEqual(['answer.hedge is missing or invalid']);
    expect(answerProblems({ ...a, hedge: { verdict: 'hedged' } })).toEqual(['answer.hedge is missing or invalid']);
    expect(answerProblems({ ...a, delivered_tokens: { reader_input: 1.5 } })).toEqual(['answer.delivered_tokens is missing or invalid']);
    const { hedge: _h, delivered_tokens: _d, ...old } = a;
    expect(answerProblems(old)).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});

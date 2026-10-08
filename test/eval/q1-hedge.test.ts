/**
 * Hedge classifiers for Q1's derived columns (eval/runner/q1/hedge.ts):
 * hedge-v1's rule table on abstentions, hedges, negations, quotes and
 * reported speech; hedge-v2's final-answer span and its conventions on long
 * markdown answers; versions, rule-table hashes and the registry; the
 * `sample` (with --exclude and --blind) and `validate` tools; the committed
 * fixture validation numbers; and the answer record round trip with
 * `delivered_tokens` and the legacy `hedge` field. Every answer here is
 * invented.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  classify, classifyV2, classifyV3, CLASSIFIER_VERSION, CLASSIFIER_VERSION_V2, CLASSIFIER_VERSION_V3, CURRENT_CLASSIFIER, DECLINE_V1_IDS, explainVerdict, explainVerdictV2, explainVerdictV3, finalSpan,
  finalSpanV3, HEDGE_CLASSIFIERS, hedgeClassifier, parseCsv, RULES, RULES_SHA256, RULES_SHA256_V2, RULES_SHA256_V3, RULES_V2, RULES_V3, stratifiedSample, toCsv, validate, type SampleAnswer, type SampleDesign,
} from '../../eval/runner/q1/hedge.ts';
import { answerId, answerProblems, readRecords, RecordLog, type AnswerRecord } from '../../eval/runner/memory-qa/records.ts';

const ROOT = resolve(import.meta.dir, '../..');
const FIX = join(ROOT, 'test/eval/fixtures/hedge');

const cases = (verdict: string, texts: string[]) => texts.map(t => [t, verdict] as const);

describe('hedge-v1 classify', () => {
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

  test('version and rule-table hash, unchanged for the record', () => {
    expect(CLASSIFIER_VERSION).toBe('hedge-v1');
    expect(RULES_SHA256).toBe('3181d1a9963f1c065fd19ca4470062e8f9aba161931289969d15f4cca56c7be7');
    expect(new Set(RULES.map(r => r.id)).size).toBe(RULES.length);
    for (const r of RULES) expect(() => new RegExp(r.pattern, `g${r.flags ?? ''}`)).not.toThrow();
  });
});

describe('hedge-v2: the final-answer span', () => {
  const steps = (answer: string, reasoning = 'Item 4 says the class met on Tuesdays.', extra = '') =>
    `**Relevant information:**\n- Item 4 (2023-05-02): Priya joined a pottery class at the studio on Elm Street.\n- Item 9 (2023-06-11): she said the class was going well and that she might take a glazing course later.\n\n**Reasoning:**\n${reasoning}${extra}\n\n**Answer:** ${answer}`;

  test('version and rule-table hash, unchanged for the record; hedge-v1 stays importable', () => {
    expect(CLASSIFIER_VERSION_V2).toBe('hedge-v2');
    expect(RULES_SHA256_V2).toBe('8a3f60ce1668af9e06b9838d989f82e42a48818d8b9e754931608870cf2260b0');
    expect(new Set(RULES_V2.map(r => r.id)).size).toBe(RULES_V2.length);
    for (const r of RULES_V2) expect(() => new RegExp(r.pattern, `g${r.flags ?? ''}`)).not.toThrow();
    expect(hedgeClassifier('hedge-v1').classify).toBe(classify);
    expect(hedgeClassifier('hedge-v2')).toEqual({ version: 'hedge-v2', rules_sha256: RULES_SHA256_V2, classify: classifyV2 });
  });

  test('span: the last answer marker, a stand-alone marker\'s next paragraph, a conclusion, a leading answer, else the last paragraph', () => {
    expect(finalSpan(steps('Tuesdays.')).text).toBe('Tuesdays.');
    expect(finalSpan('**Answer: Tuesdays.** The class met weekly.\n\n**Relevant information**\n- Item 4: Tuesdays.').text).toBe('Tuesdays. The class met weekly.');
    expect(finalSpan('Step 1: Items.\n- Item 4: Tuesdays.\n\nAnswer: Tuesdays.').text).toBe('Tuesdays.');
    expect(finalSpan('1. **Relevant information:** Item 4 says Tuesdays.\n2. **Answer:** Tuesdays.').text).toBe('Tuesdays.');
    expect(finalSpan('## Answer\n\nTuesdays, every week.\n\n- Item 4: Tuesdays.').text).toBe('Tuesdays, every week.');
    expect(finalSpan('# Answer: Tuesdays\n\n## Step 1\n- Item 4.').text).toBe('Tuesdays');
    expect(finalSpan('**Step 1**\n- Item 4.\n\n**Conclusion**\n\nThe class met on Tuesdays.').text).toBe('The class met on Tuesdays.');
    expect(finalSpan('**Priya joined the pottery class, not the glazing course.** Item 4 records it.\n\n- Item 9: glazing later.')).toMatchObject({ kind: 'lead', text: 'Priya joined the pottery class, not the glazing course.' });
    expect(finalSpan('The class met on Tuesdays. Item 4 records the day, and item 9 says she kept going through June.')).toMatchObject({ kind: 'lead', text: 'The class met on Tuesdays.' });
    expect(finalSpan('1. **Relevant information:** Item 4 says Tuesdays.\n\n2. **Reason over the information:** The class met on Tuesdays.')).toMatchObject({ kind: 'last' });
    expect(finalSpan('').kind).toBe('empty');
  });

  test('cues in the reasoning do not count once the final answer is flat; v1 read them anywhere', () => {
    const text = steps('Priya\'s class met on Tuesdays.', 'Item 9 is dated after the current date, so it may not apply. The question probably means the pottery class.');
    expect(classify(text)).toBe('hedged');
    expect(classifyV2(text)).toBe('confident');
  });

  test('an abstention only when the final answer declines', () => {
    expect(classifyV2(steps("I can't determine this. No memory items mention Priya's class schedule. If you tell me more, I can work out the likely day."))).toBe('abstain');
    expect(classifyV2(steps('The memories do not specify which day the class met.'))).toBe('abstain');
    expect(classifyV2(steps("There isn't enough information to say which studio she could be referring to."))).toBe('abstain');
    const speculatesEarlier = steps("I don't know which day the class met.", 'Any specific day, such as Tuesday, would be a guess.');
    expect(classifyV2(speculatesEarlier)).toBe('abstain');
  });

  test('a decline that goes on to guess is hedged, in the span, its conclusion paragraph or after a declining lead', () => {
    expect(classifyV2(steps("The memories never name the day, so it can't be determined with confidence. If a guess is needed, Tuesday is the likeliest."))).toBe('hedged');
    expect(classifyV2(steps("The records don't name the studio. Elm Street is the only place named, so that is the best guess, but I can't confirm it."))).toBe('hedged');
    const conclusion = "**Step 1:** Item 4.\n\n**Step 3: Conclusion.**\nNo item names the day. If I had to guess, Tuesday would be plausible, but nothing in the records confirms it.\n\n**Answer: The records don't say which day the class met.**";
    expect(classifyV2(conclusion)).toBe('hedged');
    expect(classifyV2("None of the memories name a day for the class.\n\nMy guess: Tuesday, since item 4 mentions a Tuesday flyer. That link is my own inference.")).toBe('hedged');
    expect(classifyV2(steps("I don't have any stored information about Priya. Given her love of clay, a ceramics career would be a strong fit, though this is a general suggestion."))).toBe('hedged');
  });

  test('a hedge is uncertainty about the answer itself, not about the premise or a record\'s date', () => {
    expect(classifyV2(steps("The question seems to mix up the two people. It was Priya who joined the pottery class, not Sam. She joined on 2 May 2023."))).toBe('confident');
    expect(classifyV2(steps("The records don't show Sam in a pottery class. The one they do record is Priya's, which met on Tuesdays."))).toBe('confident');
    expect(classifyV2(steps('Tuesdays. Item 9 is dated after the current date, so it may be out of range.'))).toBe('confident');
    expect(classifyV2(steps('The class probably met on Tuesdays.'))).toBe('hedged');
    expect(classifyV2(steps('The class met on Tuesdays. The two flyers may refer to the same class.'))).toBe('hedged');
  });

  test('approximators on a number or date are hedged; the same words elsewhere are not', () => {
    expect(classifyV2(steps('About 3 years passed between the two classes.'))).toBe('hedged');
    expect(classifyV2(steps('She joined around May 2023.'))).toBe('hedged');
    expect(classifyV2(steps('It ran roughly from May into early July 2023.'))).toBe('hedged');
    expect(classifyV2(steps('She joined sometime between 2 and 9 May 2023.'))).toBe('hedged');
    expect(classifyV2(steps('She talked about two classes: pottery and glazing.'))).toBe('confident');
    expect(classifyV2(steps('Pottery. She took it on Elm Street (around 2 May 2023).'))).toBe('confident');
  });

  test('a precision note about the source is not a hedge; the answerer\'s own precision disclaimer before a contrast is', () => {
    expect(classifyV2(steps('She joined in May 2023. The exact date isn\'t given.'))).toBe('confident');
    expect(classifyV2("I don't know the exact date, but it was in early May.")).toBe('hedged');
    expect(classifyV2(steps("The conversations don't name a specific studio, so it can't be identified with certainty."))).toBe('abstain');
  });

  test('a bare final answer reads its reasoning section for hedges about the answer', () => {
    expect(classifyV2(steps('3', 'The first two plans may be the same class, so the count is probably 3.'))).toBe('hedged');
    expect(classifyV2(steps('3', 'Items 4, 9 and 12 name three separate classes.'))).toBe('confident');
    expect(classifyV2(steps('3', 'Item 12 is from around 4 June 2023, and it names a third class.'))).toBe('confident');
    expect(explainVerdictV2(steps('3', 'The count is probably 3.')).read).toEqual(['span', 'reasoning']);
  });

  test('quotes, reported speech and offers to the user are not the answer\'s voice', () => {
    expect(classifyV2(steps('She said she "might take a glazing course", and she signed up for pottery on 2 May 2023.'))).toBe('confident');
    expect(classifyV2(steps('Tuesdays. If you can share the later chats, I can check whether that probably changed.'))).toBe('confident');
  });
});

describe('hedge-v3: the labeling guide', () => {
  const steps = (answer: string, reasoning = 'Item 4 says the class met on Tuesdays.') =>
    `**Relevant information:**\n- Item 4 (2023-05-02): Priya joined a pottery class at the studio on Elm Street.\n- Item 9 (2023-06-11): she said she might take a glazing course later.\n\n**Reasoning:**\n${reasoning}\n\n**Answer:** ${answer}`;

  test('version, rule-table hash and registry; v1 and v2 stay importable', () => {
    expect(CLASSIFIER_VERSION_V3).toBe('hedge-v3');
    expect(CURRENT_CLASSIFIER).toBe('hedge-v3');
    expect(RULES_SHA256_V3).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([RULES_SHA256, RULES_SHA256_V2, RULES_SHA256_V3]).size).toBe(3);
    expect(new Set(RULES_V3.map(r => r.id)).size).toBe(RULES_V3.length);
    for (const r of RULES_V3) expect(() => new RegExp(r.pattern, `g${r.flags ?? ''}`)).not.toThrow();
    for (const id of DECLINE_V1_IDS) expect(RULES.some(r => r.id === id && r.kind === 'abstain')).toBe(true);
    expect(Object.keys(HEDGE_CLASSIFIERS)).toEqual(['hedge-v1', 'hedge-v2', 'hedge-v3']);
    expect(hedgeClassifier('hedge-v3')).toEqual({ version: 'hedge-v3', rules_sha256: RULES_SHA256_V3, classify: classifyV3 });
    expect(() => hedgeClassifier('hedge-v0')).toThrow(/unknown hedge classifier "hedge-v0"; known: hedge-v1, hedge-v2, hedge-v3/);
  });

  test('reasoning is not read: a bare final answer is confident however the reasoning hedges; a pointer reads what it points to', () => {
    const bare = steps('3', 'The first two plans may be the same class, so the count is probably 3.');
    expect(classifyV2(bare)).toBe('hedged');
    expect(classifyV3(bare)).toBe('confident');
    expect(classifyV3(steps('See above.', 'The class probably met on Tuesdays.'))).toBe('hedged');
    expect(finalSpanV3(steps('See above.', 'The class probably met on Tuesdays.')).text).toBe('**Reasoning:**\nThe class probably met on Tuesdays.');
  });

  test('premise corrections and missing-record notes followed by a flat answer are confident', () => {
    expect(classifyV3(steps("Sam didn't join a pottery class. The class was Priya's: she joined on 2 May 2023. The memories don't say who taught it."))).toBe('confident');
    expect(classifyV3(steps("The records don't show Sam in a pottery class. The one they do record is Priya's, which met on Tuesdays."))).toBe('confident');
    expect(classifyV3(steps("There's no record of Priya taking a glazing course. What she described was a pottery class on Elm Street, from 2 May 2023."))).toBe('confident');
    expect(classifyV3(steps('The class met on Tuesdays. The memories do not record which studio room it used.'))).toBe('confident');
    expect(classifyV3(steps('As of 16 August 2023, there is no record of this. The only relevant item is dated later, on 1 October 2023. In it, Priya suggests a glazing course.'))).toBe('confident');
    expect(classifyV2(steps('The class met on Tuesdays. The memories do not record which studio room it used.'))).toBe('abstain');
  });

  test('a decline stays abstain when it only describes the records or names a candidate to reject it', () => {
    expect(classifyV3(steps("The memories don't say which day the class met. They only show that she joined in May and kept going in June."))).toBe('abstain');
    expect(classifyV3(steps("The memories don't say which glaze she prefers. The closest hint is that she liked blue mugs, which might suggest cobalt, but that isn't a stated preference. I can't give a definite answer."))).toBe('abstain');
    expect(classifyV3(steps("The studio isn't named, and Elm Street is a possibility, but there is not enough evidence to favor it."))).toBe('abstain');
    expect(classifyV3(steps('Nothing in the memories shows Sam taking a class. The question may be mixing him up with Priya.'))).toBe('abstain');
    expect(classifyV3(steps('The closest recorded event is the open studio night on 22 September.'))).toBe('abstain');
    expect(classifyV3(steps("The memories don't name the studio. They describe a studio with a kiln and possibly a shop. I can't identify it from this."))).toBe('abstain');
  });

  test('a candidate offered as the answer after a decline, or a low-confidence guess, is hedged', () => {
    expect(classifyV3('The conversations never name a studio, so this is a low-confidence guess: Elm Street Ceramics.')).toBe('hedged');
    expect(classifyV3(steps('Elm Street Ceramics (a tentative guess; the memory items do not name a studio).'))).toBe('hedged');
    expect(classifyV3(steps("The chats never name the studio. From the clues, they could mean Elm Street Ceramics, though this is a guess and not stated."))).toBe('hedged');
    expect(classifyV3(steps("The memory doesn't name it. Elm Street is the most likely candidate, but it is unconfirmed."))).toBe('hedged');
  });

  test('"could pursue" answers a possibility question; an added marker hedges it', () => {
    expect(classifyV3(steps('Priya could become a ceramics teacher or open a studio.'))).toBe('confident');
    expect(classifyV3(steps('Priya could work as a potter.'))).toBe('confident');
    expect(classifyV3(steps('Priya could potentially become a ceramics teacher.'))).toBe('hedged');
    expect(classifyV3(steps('Teaching ceramics could be a good fit for Priya.'))).toBe('hedged');
  });

  test('any hedge inside the final answer counts; ranges, asides and purpose clauses do not', () => {
    expect(classifyV3(steps('June 2023. It may have continued into early July.'))).toBe('hedged');
    expect(classifyV3(steps('2 times. Both plans were for August, so they may be the same outing.'))).toBe('hedged');
    expect(classifyV3(steps('June 2023. She signed up around 11 May 2023.'))).toBe('hedged');
    expect(classifyV3(steps('About 3 years.'))).toBe('hedged');
    expect(classifyV3(steps('She joined in late March or early April 2023, sometime between 27 March and 2 April. No exact date was recorded.'))).toBe('confident');
    expect(classifyV3(steps('She went to the open studio (around 1 October 2023) and glazed two mugs.'))).toBe('confident');
    expect(classifyV3(steps('It was Priya who, around 26 June 2023, set up the kiln.'))).toBe('confident');
    expect(classifyV3(steps('Priya got a tattoo of a kiln, so she could have it with her wherever she goes.'))).toBe('confident');
    expect(classifyV3(steps('The question seems to mix up the two people. It was Priya who joined, not Sam.'))).toBe('confident');
    expect(classifyV3("I don't know the exact date, but it was in early May.")).toBe('hedged');
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
    expect(design.classifier_version).toBe(CLASSIFIER_VERSION_V3);
    expect(design.rules_sha256).toBe(RULES_SHA256_V3);
    expect(design.answers).toHaveLength(2);

    // A labeler disagrees on two answers: one hedge the classifier missed, one abstention it called hedged.
    const labeled: Array<Record<string, string>> = rows.map(r => ({ ...r, label: classifyV3(r.text) }));
    const conf = labeled.find(r => classifyV3(r.text) === 'confident')!; conf.label = 'hedged';
    const hed = labeled.find(r => classifyV3(r.text) === 'hedged')!; hed.label = 'abstain';
    writeFileSync(out, toCsv(Object.keys(rows[0]), labeled));
    const v = Bun.spawnSync(['bun', 'eval/runner/q1/hedge.ts', 'validate', '--labels', out, '--design', `${out}.design.json`, '--out', join(dir, 'v.json')], { cwd: ROOT });
    expect(v.exitCode).toBe(0);
    const report = JSON.parse(v.stdout.toString());
    expect(report).toEqual(JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8')));
    expect(report.n).toBe(30);
    expect(report.classifier_version).toBe(CLASSIFIER_VERSION_V3);
    expect(report.confusion).toEqual({ abstain: { abstain: 5, hedged: 1, confident: 0 }, hedged: { abstain: 0, hedged: 12, confident: 1 }, confident: { abstain: 0, hedged: 0, confident: 11 } });
    expect(report.per_class.hedged).toEqual({ support: 13, predicted: 13, precision: Number((12 / 13).toFixed(4)), recall: Number((12 / 13).toFixed(4)) });
    expect(report.per_class.abstain).toEqual({ support: 6, predicted: 5, precision: 1, recall: Number((5 / 6).toFixed(4)) });
    expect(report.accuracy).toBe(Number((28 / 30).toFixed(4)));
    expect(report.misclassified).toHaveLength(2);
    const wAbstain = 5 * 1, wHedgedAsAbstain = 30 / 13;
    expect(report.population_weighted.recall.abstain).toBe(Number((wAbstain / (wAbstain + wHedgedAsAbstain)).toFixed(4)));
    rmSync(dir, { recursive: true });
  });

  test('--exclude leaves an earlier sample\'s answers out; --blind writes answer_id and text only, in the seeded order; --classifier picks the version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hedge-'));
    const answers = join(dir, 'a.ndjson');
    writeFileSync(answers, pool.map(a => JSON.stringify(a) + '\n').join(''));
    const earlier = join(dir, 'earlier.csv');
    writeFileSync(earlier, toCsv(['answer_id', 'text', 'label'], pool.slice(0, 20).map(a => ({ answer_id: a.answer_id, text: a.text, label: 'confident' }))));
    const out = join(dir, 'sample.csv'), blind = join(dir, 'blind.csv');
    const run = Bun.spawnSync(['bun', 'eval/runner/q1/hedge.ts', 'sample', '--answers', answers, '--exclude', earlier, '--n', '30', '--seed', 'seed-1', '--out', out, '--blind', blind], { cwd: ROOT });
    expect(run.exitCode).toBe(0);
    const full = parseCsv(readFileSync(out, 'utf8')), b = parseCsv(readFileSync(blind, 'utf8'));
    expect(Object.keys(b[0])).toEqual(['answer_id', 'text']);
    expect(b.map(r => r.answer_id)).toEqual(full.map(r => r.answer_id));
    expect(b.map(r => r.text)).toEqual(full.map(r => r.text));
    expect(full.some(r => pool.slice(0, 20).some(a => a.answer_id === r.answer_id))).toBe(false);
    const design = JSON.parse(readFileSync(`${out}.design.json`, 'utf8')) as SampleDesign;
    expect(design.schema).toBe('gbrain-evals/hedge-sample-design/v2');
    expect(design.excluded!.answers).toBe(20);
    expect(design.excluded!.files[0].path).toBe(earlier);
    expect(design.blind!.path).toBe(blind);
    expect(design.eligible).toBe(65);
    const v1 = Bun.spawnSync(['bun', 'eval/runner/q1/hedge.ts', 'sample', '--answers', answers, '--n', '10', '--seed', 's', '--out', join(dir, 'v1.csv'), '--classifier', 'hedge-v1'], { cwd: ROOT });
    expect(v1.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'v1.csv.design.json'), 'utf8')).rules_sha256).toBe(RULES_SHA256);
    expect(Bun.spawnSync(['bun', 'eval/runner/q1/hedge.ts', 'classify', '--text', 'x', '--classifier', 'hedge-v0'], { cwd: ROOT }).exitCode).toBe(2);
    // The labeler fills the blind copy; validate reads it with the design and runs the classifier the sample was drawn with.
    writeFileSync(blind, toCsv(['answer_id', 'text', 'label'], b.map(r => ({ ...r, label: classifyV3(r.text) }))));
    const v = Bun.spawnSync(['bun', 'eval/runner/q1/hedge.ts', 'validate', '--labels', blind, '--design', `${out}.design.json`], { cwd: ROOT });
    expect(v.exitCode).toBe(0);
    expect(JSON.parse(v.stdout.toString())).toMatchObject({ classifier_version: CLASSIFIER_VERSION_V3, rules_sha256: RULES_SHA256_V3, n: 30, accuracy: 1 });
    rmSync(dir, { recursive: true });
  });

  test('validate refuses a design drawn with another classifier', () => {
    const design = { classifier_version: 'hedge-v1', rules_sha256: RULES_SHA256, strata: { abstain: { population: 1, sampled: 1 }, hedged: { population: 1, sampled: 1 }, confident: { population: 1, sampled: 1 } } } as SampleDesign;
    const csv = toCsv(['answer_id', 'text', 'label'], [{ answer_id: 'x', text: 'Probably.', label: 'hedged' }]);
    expect(validate(csv, design).classifier_version).toBe('hedge-v1');
    expect(() => validate(csv, design, hedgeClassifier(CLASSIFIER_VERSION_V3))).toThrow(/drawn with hedge-v1/);
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
    test(`${name}: the committed validation numbers are each classifier's current numbers`, () => {
      const csv = readFileSync(join(FIX, `labeled-${name}.csv`), 'utf8');
      const v1 = JSON.parse(readFileSync(join(FIX, `validation-${name}.json`), 'utf8'));
      expect(validate(csv, null, hedgeClassifier(CLASSIFIER_VERSION))).toEqual(v1);
      expect(v1.rules_sha256).toBe(RULES_SHA256);
      const v2 = JSON.parse(readFileSync(join(FIX, `validation-${name}-hedge-v2.json`), 'utf8'));
      expect(validate(csv, null, hedgeClassifier(CLASSIFIER_VERSION_V2))).toEqual(v2);
      expect(v2.rules_sha256).toBe(RULES_SHA256_V2);
      const v3 = JSON.parse(readFileSync(join(FIX, `validation-${name}-hedge-v3.json`), 'utf8'));
      expect(validate(csv)).toEqual(v3);
      expect(v3.rules_sha256).toBe(RULES_SHA256_V3);
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
  test('delivered_tokens and the legacy hedge stamp round-trip through the immutable log; bad values are refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hedge-records-'));
    const path = join(dir, 'answers.ndjson');
    const a: AnswerRecord = {
      answer_id: answerId('cell', 'q1', 'reader', 0), cell_id: 'cell', realization_id: 'r', question_id: 'q1', conversation: 'c', system: 'gbrain-defaults', arm: 'component', reader: 'reader', replicate: 0,
      effort: 'medium', context_sha256: 'a'.repeat(64), text: 'Probably March.', usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 5, outcome: 'scored',
      hedge: { verdict: 'hedged', classifier_version: 'hedge-v1' }, delivered_tokens: { cl100k_base: 7012, o200k_base: 6950 },
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

/**
 * BG1's deterministic matcher (eval/runner/bg1/match.ts), its exposure diagnostics (exposure.ts) and the bg1 judge
 * instrument (memory-qa/instruments.ts): normalisation, each match class, ordered questions, whole-token matching,
 * delivered-context exposure and the deciding line, the prompt cut, and the judge prompt and verdict parser. Keyless.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildPool } from '../../eval/runner/bg1/judge-check.ts';
import { loadBg1Dev, type MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { BG1_CANONICAL_JUDGE, BG1_ORDERED_RULE, BG1_UNORDERED_RULE, bg1JudgePrompt, instrumentFor, parseBg1Verdict, RESERVE_INSTRUMENTS } from '../../eval/runner/memory-qa/instruments.ts';
import { READER_TEMPLATE } from '../../eval/runner/memory-qa/qa.ts';
import { NATIVE_READER_TEMPLATE } from '../../eval/runner/systems/render.ts';
import { evidenceOf, exposure, isRawTextRow, summarizeExposure } from '../../eval/runner/bg1/exposure.ts';
import { findValues, matchAnswer, normalise, presence } from '../../eval/runner/bg1/match.ts';
import type { Bg1QuestionFields } from '../../eval/runner/bg1/types.ts';

const question = (id: string, bg1: Partial<Bg1QuestionFields> = {}, over: Partial<MemoryQuestion> = {}) => ({
  id, conversation: 'bg1-dev-01', question: 'Which city does Ana live in now?', answer: 'Porto', category: 's1_updated', gold: [], abstention: false,
  bg1: { stratum: 's1_updated', family: 'primary', form: 'exact', slot: 'person-01.city', gold_values: ['Porto'], stale_values: ['Lisbon'], decoy_values: ['Braga'], ...bg1 },
  ...over,
}) as unknown as MemoryQuestion;

describe('normalise', () => {
  test('numbers, currency, ordinals, percent and marks come out in one form', () => {
    expect(normalise('$4,200')).toBe('4200');
    expect(normalise('4.2k')).toBe('4200');
    expect(normalise('4.2 thousand USD')).toBe('4200');
    expect(normalise('four thousand two hundred dollars')).toBe('4200');
    expect(normalise('twenty-five')).toBe('25');
    expect(normalise('1.5 million')).toBe('1500000');
    expect(normalise('the 21st of March')).toBe('the 21 of march');
    expect(normalise('50%')).toBe('50 percent');
    expect(normalise('3.0')).toBe('3');
    expect(normalise('2026-03-04')).toBe('2026.03.04');
    expect(normalise('\u201cAna\u2019s\u201d   flat!')).toBe('anas flat');
  });
});

describe('number words', () => {
  // Value: protects=the matcher's agreement with the judges reads a list of numbers as that list; fails_when=adjacent number words that do not form one English numeral ("two, three" once its comma is stripped) are summed into one number; why_new=#398 open note 10 (match.ts:35 joined adjacent number words after punctuation was stripped); seam=none; no_claim=the judges' own readings
  test('words that do not form one numeral stay separate numbers, and every numeral form is read as before', () => {
    expect(['two, three', 'two three', 'nineteen ninety', 'twenty twenty six', 'zero one', 'two and three'].map(normalise)).toEqual(['2 3', '2 3', '19 90', '20 26', '0 1', '2 and 3']);
    expect(['twenty five', 'twenty-five', 'four thousand two hundred', 'five hundred twenty five', 'one hundred and five', 'two thousand and five', 'one hundred twelve', 'two hundred thousand', 'nineteen hundred'].map(normalise))
      .toEqual(['25', '25', '4200', '525', '105', '2005', '112', '200000', '1900']);
    const counts = question('q5', { stratum: 's8_history', family: 'secondary', ordered: true, gold_values: ['2', '3'], stale_values: ['5'], decoy_values: [] });
    expect(matchAnswer(counts, 'Two, three.')).toBe('correct');
    expect(matchAnswer(counts, 'five')).toBe('stale');
  });

  // Value: protects=the matcher reads a list of scaled numbers as that list; fails_when=a comma or semicolon between two numerals, or a scale word no larger than one already applied, merges them into one number; why_new=the exception-14 reader's finding 3 (match.ts:40-60 still read "two hundred, three hundred" as 20300); seam=none; no_claim=the judges' own readings
  test('a comma or semicolon ends a numeral, and a scale word no larger than one already applied starts a new one', () => {
    expect(['two hundred, three hundred', 'one thousand, two thousand', 'five hundred, six hundred and five', 'twenty, five', 'twenty; five'].map(normalise)).toEqual(['200 300', '1000 2000', '500 605', '20 5', '20 5']);
    expect(['two hundred three hundred', 'one thousand two thousand', 'five hundred six hundred and five', 'one million two million', 'two hundred hundred'].map(normalise)).toEqual(['200 300', '1000 2000', '500 605', '1000000 2000000', '200 hundred']);
    expect(['two, three', 'nineteen ninety', 'one million two thousand', 'five hundred thousand two hundred', 'Porto, Portugal'].map(normalise)).toEqual(['2 3', '19 90', '1002000', '500200', 'porto portugal']);
    const sizes = question('q6', { stratum: 's8_history', family: 'secondary', ordered: true, gold_values: ['200', '300'], stale_values: ['20300'], decoy_values: [] });
    expect(matchAnswer(sizes, 'Two hundred, then three hundred.')).toBe('correct');
    expect(matchAnswer(sizes, 'two hundred, three hundred')).toBe('correct');
    expect(matchAnswer(question('q7', { gold_values: ['20'], stale_values: ['25'], decoy_values: [] }), 'twenty, five')).toBe('correct');
  });

  // Value: protects=the list fix changes no reading the verdict or the judge check makes on the committed fixtures; fails_when=normalise or matchAnswer reads any fixture value, gold answer, construction item or world text differently from the matcher before the fix; why_new=the exception-14 reader's finding 3 (the brief asks that the fix change only the cases it fixes); seam=the template fixtures, judge-check buildPool at seed 7; no_claim=answers no fixture holds
  test('the verdict\'s and judge-check\'s readings of the committed fixtures are the matcher\'s before the list fix', () => {
    const c = loadBg1Dev({ root: join(resolve(import.meta.dir, '../..'), 'eval/data/changing-facts-v1/fixtures'), worldEnd: '2026-11-15', keyless: true });
    const worlds = new Map(c.conversations.map(w => [w.id, w.sessions.flatMap(s => s.turns.map(t => t.content)).join('\n')]));
    const out: Record<string, unknown> = {};
    for (const q of c.questions) {
      const f = q.bg1!, vals = [...f.gold_values, ...f.stale_values, ...f.decoy_values, q.answer];
      out[q.id] = { norm: vals.map(normalise), cls: vals.map(v => matchAnswer(q, v)), presence: presence(q, worlds.get(q.conversation)!) };
    }
    const byId = new Map(c.questions.map(q => [q.id, q]));
    out.pool = buildPool(c.questions, [], 7).map(i => [i.id, normalise(i.text), matchAnswer(byId.get(i.question_id)!, i.text)]);
    // The SHA-256 of these readings as the matcher at 12256467 (before the list fix) made them.
    expect(createHash('sha256').update(JSON.stringify(out) + '\n').digest('hex')).toBe('8b0b90efddfe3923437b761db764a4d83ebb6964c56bfeab1e250872e4fed338');
  });
});

describe('matchAnswer', () => {
  const q = question('q1');
  test('each class: the gold alone, a stale value alone, a decoy value alone, no tracked value, and two kinds', () => {
    expect(matchAnswer(q, 'She lives in Porto.')).toBe('correct');
    expect(matchAnswer(q, 'Lisbon')).toBe('stale');
    expect(matchAnswer(q, 'Braga, I think.')).toBe('decoy');
    expect(matchAnswer(q, 'I do not know.')).toBe('other');
    expect(matchAnswer(q, 'She moved from Lisbon to Porto.')).toBe('unclear');
  });

  test('any accepted form of the gold is correct, and numbers match across their written forms', () => {
    const money = question('q2', { gold_values: ['$4,200', '4200 dollars'], stale_values: ['$3,900'], decoy_values: [] });
    expect(matchAnswer(money, 'The rent is four thousand two hundred dollars a month.')).toBe('correct');
    expect(matchAnswer(money, 'It is 4.2k.')).toBe('correct');
    expect(matchAnswer(money, 'It was 3,900.')).toBe('stale');
  });

  test('a value matches on whole tokens, longest first, and a claimed span is not matched again', () => {
    const city = question('q3', { gold_values: ['Porto'], stale_values: ['Porto Alegre'], decoy_values: [] });
    expect(matchAnswer(city, 'Porto Alegre')).toBe('stale');
    expect(matchAnswer(city, 'Portobello')).toBe('other');
    expect(findValues('Porto Alegre, then Porto', { gold: ['Porto'], stale: ['Porto Alegre'], decoy: [] }).map(h => [h.kind, h.at])).toEqual([['stale', 0], ['gold', 3]]);
  });

  test('an ordered question is correct only with every gold value in order and no stale or decoy value', () => {
    const history = question('q4', { stratum: 's8_history', family: 'secondary', ordered: true, gold_values: ['Lisbon', 'Porto', 'Faro'], stale_values: ['Coimbra'], decoy_values: ['Braga'] });
    expect(matchAnswer(history, 'Lisbon, then Porto, then Faro.')).toBe('correct');
    expect(matchAnswer(history, 'Porto, Lisbon, Faro')).toBe('other');
    expect(matchAnswer(history, 'Lisbon and Faro')).toBe('other');
    expect(matchAnswer(history, 'Lisbon, Coimbra, Porto, Faro')).toBe('stale');
    expect(matchAnswer(history, 'Lisbon, Braga, Coimbra')).toBe('unclear');
  });

  test('a question with no BG1 fields is refused', () => {
    expect(() => matchAnswer({ id: 'x', bg1: undefined }, 'Porto')).toThrow('question x has no BG1 fields');
  });

  test('presence reports the gold (every value when ordered) and any stale value', () => {
    expect(presence(q, 'Lisbon before, Porto now')).toEqual({ gold: true, stale: true });
    const history = question('q5', { ordered: true, gold_values: ['Lisbon', 'Porto'], stale_values: [] });
    expect(presence(history, 'Porto')).toEqual({ gold: false, stale: false });
    expect(presence(history, 'Porto and Lisbon')).toEqual({ gold: true, stale: false });
  });
});

describe('exposure', () => {
  const conflict = question('q6', { stratum: 's4_conflicting', deciding_line: 'Signed: the office moves to Porto on May 1.' });
  test('gold and stale delivery, and the deciding line only on raw-text rows', () => {
    expect(exposure(conflict, 'memo: the office moves to Lisbon. Signed: the office moves to Porto on May 1.', { rawText: true })).toEqual({ gold: true, stale: true, deciding_line: true });
    expect(exposure(conflict, 'The office moves to Porto.', { rawText: true })).toEqual({ gold: true, stale: false, deciding_line: false });
    expect(exposure(conflict, 'signed the office moves to porto on may 1', { rawText: false }).deciding_line).toBeNull();
    expect(exposure(question('q7'), 'Porto', { rawText: true }).deciding_line).toBeNull();
    expect(isRawTextRow('gbrain-defaults')).toBe(true);
    expect(isRawTextRow('baseline-hybrid')).toBe(true);
    expect(isRawTextRow('ext-memory-bank')).toBe(false);
  });

  test('summarizeExposure folds the records into rates, with the deciding line over the contexts that checked it', () => {
    const s = summarizeExposure([
      { gold: true, stale: false, deciding_line: true }, { gold: true, stale: true, deciding_line: false },
      { gold: false, stale: true, deciding_line: null }, { gold: false, stale: false, deciding_line: null },
    ]);
    expect(s).toEqual({ contexts: 4, gold_rate: 0.5, stale_rate: 0.5, gold_only_rate: 0.25, deciding_line_rate: 0.5, deciding_line_checked: 2 });
    expect(summarizeExposure([]).gold_rate).toBeNull();
  });

  test('evidenceOf cuts a frozen prompt from either reading template to its delivered memory, and keeps any other prompt whole', () => {
    const fill = (template: string, slot: string, memory: string) => template.replace(slot, memory).replace(/\{[a-z_]*\}/g, 'X');
    expect(evidenceOf(fill(NATIVE_READER_TEMPLATE, '{items}', 'item one\nitem two'))).toBe('item one\nitem two');
    expect(evidenceOf(fill(READER_TEMPLATE, '{history}', 'user: I moved to Porto.'))).toBe('user: I moved to Porto.');
    expect(evidenceOf('a prompt no template made')).toBe('a prompt no template made');
  });
});

describe('the bg1 instrument', () => {
  test('bg1 and bg1-dev share one instrument definition, with the canonical gemini-3.8-flash judge, and are reserve instruments', () => {
    const [sealed, dev] = [instrumentFor('bg1'), instrumentFor('bg1-dev')];
    expect(sealed.canonical_judge).toBe(BG1_CANONICAL_JUDGE);
    expect(BG1_CANONICAL_JUDGE).toBe('gemini:gemini-3.8-flash');
    expect(sealed.temperature).toBe(0);
    expect(dev.canonical_judge).toBe(BG1_CANONICAL_JUDGE);
    expect(sealed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(RESERVE_INSTRUMENTS)).toEqual(expect.arrayContaining(['bg1', 'bg1-dev']));
  });

  test('the judge prompt carries the gold forms, the wrong values and the rule for the question kind, never the decoy list', () => {
    const p = bg1JudgePrompt(question('q8', { gold_values: ['Porto', 'Oporto'] }), 'Porto.');
    expect(p).toContain('Accepted forms of the correct value: "Porto", "Oporto"');
    expect(p).toContain('earlier, corrected, withdrawn, unsigned or not yet in effect): "Lisbon"');
    expect(p).toContain(BG1_UNORDERED_RULE);
    expect(p).not.toContain('Braga');
    expect(p.endsWith('Reply with JSON only: {"correct": 1} or {"correct": 0}.')).toBe(true);
    const ordered = bg1JudgePrompt(question('q9', { ordered: true, gold_values: ['Lisbon', 'Porto'], stale_values: [] }), 'x');
    expect(ordered).toContain('"Lisbon" then "Porto"');
    expect(ordered).toContain(BG1_ORDERED_RULE);
    expect(ordered).toContain('(none)');
    expect(() => bg1JudgePrompt(question('q10', {}, { bg1: undefined }), 'x')).toThrow('no BG1 fields');
  });

  test('the parser takes 0 or 1 (or a boolean) in a JSON object, fenced or in prose, and refuses anything else', () => {
    expect(parseBg1Verdict('{"correct": 1}')).toEqual({ ok: true, value: 1 });
    expect(parseBg1Verdict('```json\n{"correct": 0}\n```')).toEqual({ ok: true, value: 0 });
    expect(parseBg1Verdict('Verdict: {"correct": true}')).toEqual({ ok: true, value: 1 });
    expect(parseBg1Verdict('')).toEqual({ ok: false, reason: 'empty judgment' });
    expect(parseBg1Verdict('{"correct": 2}').ok).toBe(false);
    expect(parseBg1Verdict('{"score": 1}').ok).toBe(false);
    expect(parseBg1Verdict('correct').ok).toBe(false);
  });

  test('the instrument scores through one verdict request at 1,024 tokens and records the stratum', async () => {
    const asks: Array<{ kind: string; max_tokens: number }> = [];
    const r = await instrumentFor('bg1').score(question('q11'), 'Porto', async (req: any) => { asks.push({ kind: req.kind, max_tokens: req.max_tokens }); return { raw: '{"correct": 1}', value: req.parse('{"correct": 1}').value }; });
    expect(asks).toEqual([{ kind: 'verdict', max_tokens: 1024 }]);
    expect(r).toEqual({ score: 1, detail: { stratum: 's1_updated', ordered: false } });
  });
});

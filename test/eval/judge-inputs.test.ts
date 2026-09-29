/**
 * Input allowlists on the reading-notes reader, Cat29 and Cat35 (plan
 * amendment 6 follow-up, v0.10.1). Each boundary must accept what the runner
 * legitimately sends and reject an evaluator-only value or an undeclared
 * field.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareRequests } from '../../eval/runner/reading-notes-requests.ts';
import { assertPayload, InputAllowlistError } from '../../eval/runner/evaluator/allowlist.ts';
import {
  READING_NOTES_READER_REQUEST, readingNotesForbidden,
  assertCat29JudgeInput, assertCat29SutQuestion,
  assertCat35CoverageInput, assertCat35SutSource, assertCat35UsabilityInput,
  type Cat35GoldIds,
} from '../../eval/runner/evaluator/judge-inputs.ts';
import { buildQuestions, pairJudgeInput, renderPairPrompt } from '../../eval/runner/cat29-think-vs-search.ts';
import { loadSyntheticV1 } from '../../eval/runner/synthetic-corpus-loader.ts';

const model = 'anthropic:claude-sonnet-4-6';

describe('reading-notes reader', () => {
  const frozen = [{ question_id: 'invented_case', question: 'Which happened first?', question_date: '2026-09-25', sources: [
    { session_id: 'answer_fic001', slug: 'chat/answer_fic001', date: '2026-09-20', body: '**user:** Event A.\n**assistant:** Noted.' },
    { session_id: 'sharegpt_fic002', slug: 'chat/sharegpt_fic002', date: '2026-09-21', body: '**user:** Event B, see ticket answer_fic001.\n**assistant:** Noted.' },
  ] }];

  test('prepared requests pass: opaque slugs only, and a raw id the conversation itself mentions is permitted', async () => {
    const run = await prepareRequests(frozen, model);
    expect(run.rows).toHaveLength(2);
    for (const row of run.rows) {
      const content = row.request.messages[0]!.content;
      expect(content.split('answer_fic001').length - 1).toBe(1);
      expect(content).not.toContain('sharegpt_fic002');
    }
  });

  test('a raw session id added by the harness, or an undeclared request field, is rejected', async () => {
    const run = await prepareRequests(frozen, model);
    const forbidden = readingNotesForbidden(['answer_fic001', 'sharegpt_fic002'], frozen[0]!.sources.map(s => s.body));
    const request = run.rows[0]!.request;
    expect(() => assertPayload(READING_NOTES_READER_REQUEST, request, forbidden)).not.toThrow();
    const leaked = { ...request, messages: [{ role: 'user', content: `${request.messages[0]!.content}\n<chat_session id="sharegpt_fic002">` }] };
    expect(() => assertPayload(READING_NOTES_READER_REQUEST, leaked, forbidden)).toThrow(InputAllowlistError);
    expect(() => assertPayload(READING_NOTES_READER_REQUEST, { ...request, metadata: { gold: true } }, forbidden)).toThrow('field not allowlisted');
  });
});

describe('Cat29', () => {
  const pages = loadSyntheticV1();
  const questions = buildQuestions(pages);

  test('every committed question passes the system-under-test boundary; expected facts may not reach it', () => {
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) expect(() => assertCat29SutQuestion(q.text, q.expected_facts, q.gold_slugs)).not.toThrow();
    const q = questions[0]!;
    expect(() => assertCat29SutQuestion(`${q.text} (${q.expected_facts[0]})`, q.expected_facts, q.gold_slugs)).toThrow('expected fact');
    expect(() => assertCat29SutQuestion(`${q.text} ${q.gold_slugs[0]}`, q.expected_facts, q.gold_slugs)).toThrow('gold slug');
  });

  test('the pairwise judge input carries declared fields only and no system identity beyond the answers', () => {
    const q = questions[0]!;
    expect(() => renderPairPrompt(q, 'Answer text one.', 'Answer text two.', pages)).not.toThrow();
    const input = pairJudgeInput(q, 'Answer text one.', 'Answer text two.', pages);
    expect(() => assertCat29JudgeInput({ ...input, rubric: [...input.rubric, { id: 'identity', weight: 1, criterion: 'Answer 2 is the runThink output' }] })).toThrow('system identity');
    expect(() => assertCat29JudgeInput({ ...input, system_a: 'search' } as never)).toThrow('field not allowlisted');
    // An answer that names the system itself is source material, not a harness leak.
    expect(() => assertCat29JudgeInput({ ...input, answer_1: 'I ran hybridSearch and found nothing.' })).not.toThrow();
  });
});

describe('Cat35', () => {
  const dir = 'eval/data/transcript-distill-v1';
  const gold: Cat35GoldIds[] = readdirSync(join(dir, 'gold')).sort().map(f => JSON.parse(readFileSync(join(dir, 'gold', f), 'utf8')));

  test('no committed transcript carries a gold item, distractor or hazard id; an injected id is rejected', () => {
    for (const f of readdirSync(join(dir, 'transcripts')).sort()) {
      expect(() => assertCat35SutSource({ slug: f, content: readFileSync(join(dir, 'transcripts', f), 'utf8') }, gold)).not.toThrow();
    }
    expect(() => assertCat35SutSource({ slug: 'x', content: `note ${gold[0]!.items[0]!.item_id}` }, gold)).toThrow('gold id');
  });

  test('the coverage judge sees statements, never anchors beyond what the judged document quotes', () => {
    const g = gold[0]!;
    const items = g.items.map(i => ({ item_id: i.item_id, statement: i.statement }));
    for (const each of gold) {
      expect(() => assertCat35CoverageInput({ document: '(empty output)', items: each.items.map(i => ({ item_id: i.item_id, statement: i.statement })) }, each)).not.toThrow();
    }
    const anchor = g.items[0]!.verbatim_anchor;
    expect(() => assertCat35CoverageInput({ document: 'doc', items: [{ ...items[0]!, statement: anchor }] }, g)).toThrow('verbatim anchor');
    expect(() => assertCat35CoverageInput({ document: `The page quotes "${anchor}".`, items }, g)).not.toThrow();
  });

  test('the usability judge never sees a gold statement the pages do not contain', () => {
    const g = gold[0]!;
    const pages = [{ slug: 'notes/x', body: 'A page.' }];
    expect(() => assertCat35UsabilityInput({ transcript_id: g.items[0]!.item_id.replace(/-g\d+$/, ''), pages, hasGoldVibes: false }, g)).not.toThrow();
    expect(() => assertCat35UsabilityInput({ transcript_id: 't', pages, hasGoldVibes: false, gold_statements: [g.items[0]!.statement] } as never, g)).toThrow('field not allowlisted');
  });
});

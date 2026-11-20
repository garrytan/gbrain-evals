/**
 * The nightly write-task scorer (eval/runner/nightly/write-score.ts) on fixture brains. gbrain turns an untitled capture
 * into one page whose frontmatter title and H1 repeat the capture's first line, so the fact's token appears three times in
 * one write; the nightly scorer counts that once, and still catches a real duplicate, a lost write, a wrong report and a
 * write reissued under a new request id.
 */
import { describe, expect, test } from 'bun:test';
import { generateTask, type FactId, type Report } from '../../eval/runner/refresh-barrier/agent.ts';
import { countFacts, pageOccurrences, scoreWrites, splitFrontmatter, type Inspected, type PageRow } from '../../eval/runner/nightly/write-score.ts';

const task = generateTask(2001);
const fact = (id: FactId) => task.facts.find(f => f.id === id)!;
const person = (id: FactId): PageRow => ({ slug: fact(id).slug!, source_id: 'alpha', title: fact(id).subject, compiled_truth: `${fact(id).subject} works with Sam.\n\n- ${fact(id).text}`, timeline: '' });
/** An untitled capture as gbrain stores it: the first line becomes the title and a leading H1. */
const capture = (text: string, title = text): PageRow => ({ slug: 'notes/volunteer-day', source_id: 'alpha', title, compiled_truth: `# ${text}\n\n${text}`, timeline: '' });
const gitFile = (p: PageRow) => ({ path: `${p.slug}.md`, content: `---\ntitle: "${p.title}"\ntype: note\n---\n${p.compiled_truth}\n` });

const clean = (): Inspected => {
  const pages = [person('F1'), person('F2'), capture(fact('F3').text), person('F4')];
  return { pages, git: pages.map(gitFile) };
};
const allSaved: Report = { ok: true, source: 'submit_answer', states: { F1: 'saved', F2: 'saved', F3: 'saved', F4: 'saved' } };
const committed = (ids: FactId[]) => ids.map(id => ({ tokens: [id], cls: 'committed' }));

describe('the nightly write scorer', () => {
  test('an untitled capture holds its token three times in one page and once per Git file, and counts once', () => {
    const p = capture(fact('F3').text);
    expect((p.title + p.compiled_truth).split(fact('F3').token).length - 1).toBe(3);
    expect(pageOccurrences(p.title, p.compiled_truth, fact('F3').token)).toBe(1);
    const { title, body } = splitFrontmatter(gitFile(p).content);
    expect(title).toBe(fact('F3').text);
    expect(pageOccurrences(title, body, fact('F3').token)).toBe(1);
    expect(countFacts(task, clean()).F3).toMatchObject({ pages: 1, git: 1, pages_at: ['alpha:notes/volunteer-day'] });
  });

  test('a title gbrain shortened with an ellipsis still marks the H1 as derived', () => {
    const text = `${fact('F3').text} Bring water and sunscreen, and sign in at the north gate.`;
    expect(pageOccurrences(`${text.slice(0, 40)}...`, `# ${text}\n\n${text}`, fact('F3').token)).toBe(1);
  });

  test('a page whose only copy is its title or H1 counts once: the write landed', () => {
    expect(pageOccurrences(fact('F3').text, `# ${fact('F3').text}\n`, fact('F3').token)).toBe(1);
    expect(pageOccurrences(fact('F3').text, 'Shift details to follow.', fact('F3').token)).toBe(1);
  });

  test('every fact once, every report right, no resend: pass', () => {
    const s = scoreWrites({ task, seen: clean(), report: allSaved, reissues: [], writeCalls: committed(['F1', 'F2', 'F3', 'F4']) });
    expect(s).toMatchObject({ pass: true, tokens_once: true, report_correct: true, no_resend: true, duplicated: [], missing: [], misreports: [] });
  });

  test('a token twice in one body, or in two pages, is a duplicate', () => {
    const seen = clean();
    seen.pages[0] = { ...seen.pages[0]!, compiled_truth: `${seen.pages[0]!.compiled_truth}\n- ${fact('F1').text}` };
    seen.pages.push({ ...capture(fact('F2').text), slug: 'notes/gus' });
    const s = scoreWrites({ task, seen, report: allSaved, reissues: [], writeCalls: [] });
    expect(s).toMatchObject({ pass: false, tokens_once: false, duplicated: ['F1', 'F2'] });
  });

  test('a write acknowledged but missing from the brain, and reported saved, fails the write and the report', () => {
    const seen = clean();
    seen.pages = seen.pages.filter(p => p.slug !== fact('F4').slug);
    const s = scoreWrites({ task, seen, report: allSaved, reissues: [], writeCalls: committed(['F1', 'F2', 'F3', 'F4']) });
    expect(s).toMatchObject({ pass: false, missing: ['F4'], acknowledged_missing: ['F4'], misreports: ['F4'], report_correct: false });
    const honest = scoreWrites({ task, seen, report: { ...allSaved, states: { ...allSaved.states, F4: 'failed' } }, reissues: [], writeCalls: [] });
    expect(honest).toMatchObject({ pass: false, report_correct: true, missing: ['F4'], acknowledged_missing: [] });
  });

  test('a write reissued under a new request id fails no_resend; an unparseable report misreports every fact', () => {
    expect(scoreWrites({ task, seen: clean(), report: allSaved, reissues: [{ fact: 'F2' }], writeCalls: [] })).toMatchObject({ pass: false, no_resend: false, resent: ['F2'] });
    const s = scoreWrites({ task, seen: clean(), report: { ok: false, source: null, reason: 'no submit_answer' }, reissues: [], writeCalls: [] });
    expect(s).toMatchObject({ pass: false, report_correct: false, misreports: ['F1', 'F2', 'F3', 'F4'] });
  });
});

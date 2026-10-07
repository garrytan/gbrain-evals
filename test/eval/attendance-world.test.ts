/**
 * W3 attendance world: the world-v1-attendees generator (deterministic, page
 * lists from the Cat 2 key, a seeded 15% perturbed, world-v1 untouched) and
 * the attendee-role question builder and summary.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, SOURCE_DIR, attendeesSection, corpusFingerprint, generateWorldV1Attendees } from '../../eval/generators/world-v1-attendees.ts';
import { buildRoleQuestions, summarizeRoleRows, type RoleRow } from '../../eval/runner/attendee-role-planner.ts';
import { loadWorldCorpus } from '../../eval/runner/queries/relational.ts';

const gen = generateWorldV1Attendees();

describe('world-v1-attendees generator', () => {
  test('deterministic and identical to the committed corpus', () => {
    expect(corpusFingerprint(generateWorldV1Attendees().ledger)).toBe(corpusFingerprint(gen.ledger));
    for (const [file, content] of gen.pages) expect([file, readFileSync(join(OUT_DIR, file), 'utf8') === content]).toEqual([file, true]);
  });

  test('8 of 50 lists perturbed by exactly one person; the other 42 equal the Cat 2 key', () => {
    expect([gen.ledger.meetings, gen.ledger.perturbed]).toEqual([50, 8]);
    const perturbed = new Set(gen.ledger.perturbations.map(p => p.meeting));
    for (const p of loadWorldCorpus(OUT_DIR).filter(x => x.type === 'meeting')) {
      const f = p._facts as unknown as { attendees: string[]; attendees_key: string[] };
      const diff = f.attendees.filter(s => !f.attendees_key.includes(s)).length + f.attendees_key.filter(s => !f.attendees.includes(s)).length;
      expect([p.slug, diff]).toEqual([p.slug, perturbed.has(p.slug) ? 1 : 0]);
      expect(p.compiled_truth).toContain('## Attendees');
      expect(f.attendees.length).toBeGreaterThan(0);
    }
  });

  test('the section holds only bare links, one per attendee on the page, and prose is unchanged', () => {
    const src = loadWorldCorpus(SOURCE_DIR);
    for (const p of loadWorldCorpus(OUT_DIR).filter(x => x.type === 'meeting')) {
      const [prose, section] = p.compiled_truth.split('\n\n## Attendees\n\n');
      expect(src.find(x => x.slug === p.slug)!.compiled_truth.trimEnd()).toBe(prose);
      const lines = section.split('\n');
      expect(lines.every(l => /^- \[[^\]]+\]\(people\/[a-z0-9-]+\)$/.test(l))).toBe(true);
      expect(lines.map(l => l.match(/\((people\/[^)]+)\)/)![1])).toEqual((p._facts as { attendees: string[] }).attendees);
    }
    expect(attendeesSection([{ slug: 'people/a-1', title: 'A One' }])).toBe('## Attendees\n\n- [A One](people/a-1)');
  });

  test('world-v1 itself is untouched: non-meeting pages are byte-identical copies', () => {
    for (const [file, content] of gen.pages) if (!file.startsWith('meetings__')) expect(content).toBe(readFileSync(join(SOURCE_DIR, file), 'utf8'));
  });
});

describe('attendee-role questions', () => {
  const qs = buildRoleQuestions(loadWorldCorpus(OUT_DIR));

  test('both development templates per (meeting, role present); gold is the role subset of the page list', () => {
    expect(qs.length % 2).toBe(0);
    expect(qs.filter(q => q.template === 0)[0]!.text).toMatch(/^Which \w+ attended .+\?$/);
    expect(qs.filter(q => q.template === 1)[0]!.text).toMatch(/^[A-Z]\w+ who attended .+\?$/);
    for (const q of qs) { expect(q.gold.length).toBeGreaterThan(0); expect(q.gold.every(g => q.attendees.includes(g))).toBe(true); }
  });

  test('the summary counts planned, fired, recall and false attendance', () => {
    const row = (o: Partial<RoleRow>): RoleRow => ({ id: 'x', text: 't', meeting: 'm', role: 'founder', template: 0, plan: { kind: 'not_applicable' }, one_relation: { parsed: false }, fired: false, recall_off: 0, recall_on: 0, unlisted_people: { off: [], on: [] }, other_role_attendees: { off: [], on: [] }, error: null, ...o });
    const s = summarizeRoleRows([row({ plan: { kind: 'plan' }, fired: true, recall_on: 1, unlisted_people: { off: [], on: ['people/z'] }, other_role_attendees: { off: [], on: ['people/y'] } }), row({ plan: { kind: 'unsupported', reason: 'counting' } })]);
    expect(s).toMatchObject({ questions: 2, planned: { n: 1, share: 0.5 }, fired: { n: 1 }, recall_at_10_on: 0.5, unlisted_people_top10: { off: 0, on: 1 }, questions_with_other_role_attendees_top10: { on: { n: 1 } } });
    expect(s.plan_outcomes).toEqual({ plan: 1, 'unsupported: counting': 1 });
  });
});

import { attendanceQueryMeetings, scoreAttendance } from '../../eval/runner/attendance-world-score.ts';

describe('attendance scorer', () => {
  const pages = loadWorldCorpus(OUT_DIR);
  const ids = [...attendanceQueryMeetings(pages).entries()];
  const meetingPage = (slug: string) => pages.find(p => p.slug === slug)!;
  const row = (id: string, split: string, fired: boolean, onPages: string[]) => ({ seed: 1, query_id: split === 'one-hop-paraphrase' ? `${id}-p` : id, split, template: 'attended', fired, seeds_resolved: 1, off_pages: [] as string[], on_pages: onPages, on: { recall_at_5: 1 }, off: { recall_at_5: 0 }, error: null });

  test('maps every attendance question to its meeting', () => {
    expect(ids.length).toBe(50);
  });

  test('stored attended edges equal to the page lists score 0 false and 0 missing; an edge for a removed person is false attendance', () => {
    const exact = pages.filter(p => p.type === 'meeting').flatMap(p => ((p._facts.attendees ?? []) as string[]).map(a => [a, p.slug] as [string, string]));
    const removed = gen.ledger.perturbations.find(p => p.kind === 'removed')!;
    const s = scoreAttendance({ data: { one_hop: { per_query: [] }, attendance_edges: [{ seed: 1, edges: exact }, { seed: 2, edges: [...exact, [removed.person, removed.meeting]] }] } }, pages, gen.ledger.perturbations);
    expect([s.attendance_edges[0]!.false_edges.length, s.attendance_edges[0]!.missing.length]).toEqual([0, 0]);
    expect(s.attendance_edges[1]!.false_edges).toEqual([{ person: removed.person, meeting: removed.meeting, why: "person not on the meeting's list" }]);
    expect(s.gate).toMatchObject({ edges_recorded: true, false_attendance: 1, missing_attendance: 0 });
    const prose = scoreAttendance({ data: { one_hop: { per_query: [] }, attendance_edges: [{ seed: 1, edges: exact.slice(1) }] } }, pages);
    expect(prose.gate.missing_attendance).toBe(1);
    expect(scoreAttendance({ data: { one_hop: { per_query: [] } } }, pages).gate.false_attendance).toBeNull();
  });

  test('top-5 people off the list are counted per arm, and perturbed meetings report where their person landed', () => {
    const removed = gen.ledger.perturbations.find(p => p.kind === 'removed')!;
    const rows = ids.map(([id, m]) => ({ ...row(id, 'one-hop-template', true, []), off_pages: m === removed.meeting ? [removed.person] : [], on_pages: [] as string[] }));
    const s = scoreAttendance({ data: { one_hop: { per_query: rows } } }, pages, gen.ledger.perturbations);
    expect(s.by_split['one-hop-template'].unlisted_people_top5).toEqual({ off: 1, on: 0 });
    expect(s.perturbed_meetings['one-hop-template']!.find(p => p.meeting === removed.meeting)).toMatchObject({ top5_off: 1, top5_on: 0 });
  });

  test('a split that fires on fewer than 80% of runs fails the floor', () => {
    const rows = ids.map(([id], i) => row(id, 'one-hop-template', i % 2 === 0, []));
    expect(scoreAttendance({ data: { one_hop: { per_query: rows } } }, pages).by_split['one-hop-template'].meets_fire_floor).toBe(false);
  });
});

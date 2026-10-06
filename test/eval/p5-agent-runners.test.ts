import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpoint, compareReceipts, firstJsonObject, P5_AGENT_TOOLS, P5_ANSWER_TOOLS, selectUnits, seededSample, type StoredPage } from '../../eval/runner/p5-agent.ts';
import { CONTROL_PAGE, inDevPart, itemClass, judgePrompt as h3JudgePrompt, listLines, summarizeH3, vaultManifest } from '../../eval/runner/line-grammar-junk-audit.ts';
import {
  MENTIONS_PER_TASK, TEMPLATES_A, generateSaveNotesWorld, renderSeedPage, validateTemplates,
} from '../../eval/generators/save-notes-dedup-gen.ts';
import { classifyTask, summarizeH5b, type H5bRow } from '../../eval/runner/save-notes-dedup.ts';
import { datedItems, devQuestions, ingestBatches, judgePrompt as h6JudgePrompt, questionRows, summarizeH6 } from '../../eval/runner/write-then-answer.ts';
import { renderCorpus } from '../../eval/runner/chronicle-lift.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'p5-agent-'));

describe('P5 agent harness plumbing', () => {
  test('checkpoints skip finished units and ignore a torn last line', () => {
    const path = join(tmp(), 'units.jsonl');
    const c = new Checkpoint<{ key: string; v: number }>(path);
    c.append({ key: 'a', v: 1 });
    c.append({ key: 'b', v: 2 });
    appendFileSync(path, '{"key":"c","v"');
    const again = new Checkpoint<{ key: string; v: number }>(path);
    expect([...again.done.keys()]).toEqual(['a', 'b']);
    expect(again.has('c')).toBe(false);
  });
  test('a pilot is a deterministic tenth of the units (at least one) and --limit cuts after it', () => {
    const units = Array.from({ length: 95 }, (_, i) => `u${i}`);
    const pilot = selectUnits(units, u => u, { pilot: true, limit: null });
    expect(pilot.length).toBe(10);
    expect(selectUnits(units, u => u, { pilot: true, limit: null })).toEqual(pilot);
    expect(pilot.every(u => units.includes(u))).toBe(true);
    expect(selectUnits(['x'], u => u, { pilot: true, limit: null })).toEqual(['x']);
    expect(selectUnits(units, u => u, { pilot: false, limit: 3 })).toEqual(['u0', 'u1', 'u2']);
  });
  test('seeded samples are reproducible and distinct', () => {
    const a = seededSample([...Array(50).keys()], 10, 3);
    expect(seededSample([...Array(50).keys()], 10, 3)).toEqual(a);
    expect(new Set(a).size).toBe(10);
  });
  test('answer sessions get only read tools, a subset of the write-session tools', () => {
    for (const t of P5_ANSWER_TOOLS) expect(P5_AGENT_TOOLS).toContain(t);
    for (const t of ['put_page', 'edit_page', 'delete_page', 'add_link', 'remember', 'add_timeline_entry']) expect(P5_ANSWER_TOOLS).not.toContain(t);
  });
  test('every new P5 runner reads arm config from GBRAIN_EVAL_CONFIG', () => {
    for (const f of ['line-grammar-junk-audit.ts', 'save-notes-dedup.ts', 'write-then-answer.ts']) expect(readFileSync(join(import.meta.dir, '../../eval/runner', f), 'utf8')).toContain('parseEvalConfig()');
  });
  test('judge replies parse from bare or fenced JSON', () => {
    expect(firstJsonObject('{"verdict":"correct"}')).toEqual({ verdict: 'correct' });
    expect(firstJsonObject('Sure.\n```json\n{"correct": false, "reason": "x"}\n```')).toEqual({ correct: false, reason: 'x' });
    expect(firstJsonObject('no json')).toBeNull();
  });
  test('receipt comparison pairs rows by id, resamples task clusters and skips models only one side ran', () => {
    const dir = tmp();
    const write = (name: string, rows: unknown[]) => { const p = join(dir, name); writeFileSync(p, JSON.stringify({ data: { rows } })); return p; };
    const rows = (dup: number[]) => dup.map((d, i) => ({ id: `m1:t${Math.floor(i / 3)}-e${i % 3}`, cluster: `m1:t${Math.floor(i / 3)}`, model: 'm1', duplicate: d }));
    const a = write('a.json', [...rows([1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0]), { id: 'm2:x', cluster: 'm2:x', model: 'm2', duplicate: 1 }]);
    const b = write('b.json', rows([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0]));
    const [all] = compareReceipts(a, b, ['duplicate'], { draws: 2000 });
    expect(all.n_pairs).toBe(12);
    expect(all.n_clusters).toBe(4);
    expect(all.mean_a).toBeCloseTo(7 / 12);
    expect(all.delta).toBeCloseTo(-4 / 12);
    expect(all.relative_change).toBeCloseTo(-4 / 7);
  });
});

describe('P5 H3 line-grammar junk audit', () => {
  test('list lines skip frontmatter and fenced code; zero-tolerance shapes are classified', () => {
    const page = ['---', 'title: x', '- not: a list line', '---', '', '- plain item', '```', '- inside code', '```',
      '- [00:01:12] Speaker: hi', '- 00:01 intro', '- [ ] buy milk', '- [x] done', '- [^1] footnote', '- [Source: email] said so',
      '- 2024-03-01 shipped', '- Mar 3 call', '1. numbered', '## Timeline', '- works_at [[companies/x]]', '## Notes', '* star item'].join('\n');
    const lines = listLines(page);
    expect(lines.map(l => l.content)).toEqual(['plain item', '[00:01:12] Speaker: hi', '00:01 intro', '[ ] buy milk', '[x] done', '[^1] footnote',
      '[Source: email] said so', '2024-03-01 shipped', 'Mar 3 call', 'numbered', 'works_at [[companies/x]]', 'star item']);
    expect(lines.map(l => l.zero_tolerance)).toEqual([null, 'timecode', 'timecode', 'task_marker', 'task_marker', 'citation', 'citation', 'date', 'date', null, 'machine_section', null]);
    expect(listLines('intro\n<!-- timeline -->\n- 2024 | x\n- y')[1].zero_tolerance).toBe('machine_section');
    expect(itemClass('[preference] Prefers tea')).toBeNull();
    expect(itemClass('works_at [[companies/x]]')).toBeNull();
  });
  test('the dev part is a stable tenth, decided by document id', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `session-${i}`);
    const dev = ids.filter(id => inDevPart('lme-s', id));
    expect(dev.length).toBeGreaterThan(320);
    expect(dev.length).toBeLessThan(480);
    expect(ids.filter(id => inDevPart('lme-s', id))).toEqual(dev);
    expect(ids.filter(id => inDevPart('blue-book', id))).not.toEqual(dev);
  });
  test('the vault manifest pins a permissive license, a commit and per-file hashes, and holds no text', () => {
    const m = vaultManifest();
    expect(m.license).toBe('CC0-1.0');
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.raw_base).toContain(m.commit);
    expect(m.files.length).toBeGreaterThan(1000);
    for (const f of m.files) { expect(f.git_blob_sha1).toMatch(/^[0-9a-f]{40}$/); expect(Object.keys(f).sort()).toEqual(['bytes', 'git_blob_sha1', 'path']); }
  });
  test('the positive control holds one relation line, one fact line and one prose decoy', () => {
    const lines = listLines(CONTROL_PAGE).map(l => l.content);
    expect(lines).toEqual(['works_at [[companies/acme-example]]', '[preference] Prefers tea', 'Met [[people/alice-example]] for lunch today']);
  });
  test('precision counts agreed-correct over minted lines in the sample; a disagreement counts as wrong (no adjudication)', () => {
    const minted = (id: string, zt: null | 'date' = null) => ({ id, doc: 'd', corpus: 'blue-book' as const, line: 1, kind: 'relation' as const, parsed: 'relation type x', text: '- x [[y]]', context: '', zero_tolerance: zt });
    const docs = [{ key: 'blue-book|d', corpus: 'blue-book' as const, doc: 'd', list_lines: 400, zero_tolerance_list_lines: { date: 3 }, advisory: { relations: 4, facts: 0 },
      minted: [minted('a'), minted('b'), minted('c'), minted('z', 'date')] }];
    const label = (v: 'correct' | 'incorrect') => ({ key: '', id: '', judge: '', verdict: v, reason: '', usd: 0 });
    const labels = new Map([['a', { j1: label('correct'), j2: label('correct') }], ['b', { j1: label('correct'), j2: label('incorrect') }], ['c', { j1: label('incorrect'), j2: label('incorrect') }]]);
    const s = summarizeH3(docs, new Set(['a', 'b', 'c']), 300, labels, ['j1', 'j2']) as { minted_per_1000_list_lines: number; precision: Record<string, number | null>; zero_tolerance: { violations: number } };
    expect(s.minted_per_1000_list_lines).toBe(10);
    expect(s.zero_tolerance.violations).toBe(1);
    expect(s.precision.precision_agreed_correct).toBeCloseTo(1 / 3);
    expect(s.precision.disagreements).toBe(1);
    expect(s.precision).not.toHaveProperty('pending_adjudication');
  });
  test('the judge sees the parse, the line and its context', () => {
    const p = h3JudgePrompt({ kind: 'fact', parsed: 'fact category note', text: '- [note] remember this', context: 'a\n- [note] remember this\nb' });
    expect(p).toContain('fact category note');
    expect(p).toContain('- [note] remember this');
    expect(p).toContain('"verdict"');
  });
});

describe('P5 H5b save-notes dedup', () => {
  const world = generateSaveNotesWorld({ seed: 2, tasks: 8 });
  test('every task mentions 3 existing, 2 similar and 5 new entities, each with a world-unique marker', () => {
    const markers = world.tasks.flatMap(t => t.mentions.map(m => m.marker));
    expect(new Set(markers).size).toBe(markers.length);
    const slugs = new Set(world.entities.map(e => e.slug));
    for (const t of world.tasks) {
      for (const k of ['existing', 'similar', 'new'] as const) expect(t.mentions.filter(m => m.kind === k).length).toBe(MENTIONS_PER_TASK[k]);
      for (const m of t.mentions) {
        expect(t.note).toContain(m.marker);
        if (m.kind !== 'new') expect(slugs.has(m.seed_slug!)).toBe(true);
        if (m.kind === 'existing') expect(m.names).toContain(world.entities.find(e => e.slug === m.seed_slug)!.title);
        if (m.family === 'namesake') expect(m.line).toContain(world.entities.find(e => e.slug === m.seed_slug)!.company!);
      }
      for (const page of world.pages) expect(page.content).not.toContain(t.mentions[0].marker);
    }
    expect(generateSaveNotesWorld({ seed: 2, tasks: 8 }).fingerprint).toBe(world.fingerprint);
  });
  test('held-out template sets are refused; custody templates are validated', () => {
    expect(() => generateSaveNotesWorld({ seed: 1, tasks: 1, templates: 'B' })).toThrow('held out');
    expect(() => validateTemplates({ ...TEMPLATES_A, namesake_line: ['{name} at {company}'] })).toThrow('{prior_company}');
    expect(validateTemplates(TEMPLATES_A)).toBe(TEMPLATES_A);
  });
  test('classification: duplicates, wrong merges and note pages', () => {
    const task = world.tasks[0];
    const seedPages: StoredPage[] = world.entities.map(e => ({ slug: e.slug, title: e.title, type: e.kind, body: renderSeedPage(e) }));
    const seedSlugs = new Set(seedPages.map(p => p.slug));
    const existing = task.mentions.filter(m => m.kind === 'existing');
    const similar = task.mentions.filter(m => m.kind === 'similar');
    const fresh = task.mentions.filter(m => m.kind === 'new');
    const pages = seedPages.map(p => p.slug === existing[0].seed_slug ? { ...p, body: `${p.body}\n${existing[0].marker}` }
      : p.slug === similar[0].seed_slug ? { ...p, body: `${p.body}\n${similar[0].marker}` } : p);
    pages.push({ slug: 'people/dup-page', title: existing[1].text, type: 'person', body: 'stub' });
    pages.push({ slug: 'meetings/notes', title: 'Notes', type: 'meeting', body: task.mentions.map(m => `${m.text} ${m.marker}`).join('\n') });
    pages.push({ slug: 'people/x-new', title: fresh[0].text, type: 'person', body: fresh[0].marker });
    const rows = classifyTask(task, seedSlugs, pages);
    const of = (id: string) => rows.find(r => r.mention === id)!;
    expect(of(existing[0].id)).toMatchObject({ duplicate: 0, saved_on_page: 1, marker_saved: 1 });
    expect(of(existing[1].id)).toMatchObject({ duplicate: 1, saved_on_page: 0 });
    expect(of(existing[2].id)).toMatchObject({ duplicate: 0, marker_saved: 0 });
    expect(of(similar[0].id)).toMatchObject({ wrong_merge: 1, separate_page: 0 });
    expect(of(similar[1].id)).toMatchObject({ wrong_merge: 0 });
    expect(of(fresh[0].id)).toMatchObject({ created_page: 1, misfiled: 0 });
    expect(of(fresh[1].id)).toMatchObject({ created_page: 0, marker_saved: 0 });
    expect(of(existing[0].id).wrong_merge).toBeUndefined();
    const summary = summarizeH5b(rows.map((r, i) => ({ id: `m:${i}`, cluster: 'm:t', model: 'm', ...r }) as H5bRow)) as Record<string, number>;
    expect(summary.duplicate_rate).toBeCloseTo(1 / 3);
    expect(summary.wrong_merge_rate).toBeCloseTo(1 / 2);
  });
});

describe('P5 H6 write-then-answer', () => {
  test('the two guidance files share their preamble word for word and are within 10% in length', () => {
    const read = (f: string) => readFileSync(join(import.meta.dir, '../../eval/data/p5-write-then-answer', f), 'utf8');
    const [a, b] = [read('guidance-a.md'), read('guidance-b.md')];
    const head = (s: string) => s.slice(0, s.indexOf('## Recording relationships and dated facts'));
    expect(head(a).length).toBeGreaterThan(300);
    expect(head(a)).toBe(head(b));
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    expect(Math.abs(words(a) - words(b)) / Math.max(words(a), words(b))).toBeLessThan(0.1);
    expect(a).toContain('add_link');
    expect(a).toContain('remember');
    expect(a).toContain('## Facts');
    expect(b).toContain('- works_at [[companies/<name>]]');
  });
  test('dev questions come in relational and temporal pairs about one item, from dev seeds only', () => {
    const qs = devQuestions(1, 4);
    expect(qs.length).toBe(8);
    for (let i = 0; i < qs.length; i += 2) {
      expect(qs[i].pair).toBe(qs[i + 1].pair);
      expect([qs[i].type, qs[i + 1].type]).toEqual(['relational', 'temporal']);
      expect(qs[i + 1].answer).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(qs[i].answer).not.toContain('Amara');
    }
    expect(devQuestions(1, 4)).toEqual(qs);
    expect(() => devQuestions(9, 4)).toThrow('dev seeds');
    expect(datedItems().length).toBeGreaterThan(10);
  });
  test('ingest batches cover every page once, in order, under the size limit unless a page is larger', () => {
    const pages = renderCorpus();
    const batches = ingestBatches(pages, 24_000);
    expect(batches.flat().map(p => p.path)).toEqual(pages.map(p => p.path));
    for (const b of batches) if (b.length > 1) expect(b.reduce((s, p) => s + p.content.length, 0)).toBeLessThanOrEqual(24_000);
  });
  test('per-question score is the mean over judged replicates, with their SD; rows pair by model and question', () => {
    const q = { id: 'q1', pair: 'p1', type: 'relational' as const, question: 'Who?', answer: 'Elena Rossi' };
    const rec = (r: number, correct: number) => ({ key: `m|q1|r${r}`, model: 'm', question: 'q1', replicate: r, answer: '', correct, judge_reason: '', judge_usd: 0.001, agent_usd: 0.01, stop: 'submitted', turns: 2, budget_run_id: null });
    const [row] = questionRows([q], ['m'], [rec(0, 1), rec(1, 0), rec(2, 1), rec(3, 1)], 10, true);
    expect(row).toMatchObject({ id: 'm:q1', cluster: 'm:p1', replicates: 4, replicates_planned: 10, qa_score: 0.75 });
    expect(row.qa_sd).toBeCloseTo(0.5);
    expect(row.question).toBeUndefined();
    expect((summarizeH6([row]) as { qa_score: number }).qa_score).toBe(0.75);
    expect(h6JudgePrompt(q, 'Elena')).toContain('Reference answer: Elena Rossi');
  });
});

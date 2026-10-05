import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_SEEDS, PHRASING_A, PHRASING_A3, generateTemporalEdgesWorld } from '../../eval/generators/temporal-edges-gen.ts';
import {
  HTTP_ARM, SURFACES, aliasFor, ambientLine, checkSurface, compiledEntry, queryRead, questionFor, stageWorld, summarize, type E3Row,
} from '../../eval/runner/temporal-ingest-answer.ts';

const target = { former: { company: 'companies/acme-example', from: '2019-01-01', until: '2023-03-01', role: 'engineer' }, current: { company: 'companies/widget-example', from: '2023-03-01', until: null, role: 'CTO' } };

describe('temporal ingest-to-answer (E3) staging', () => {
  test('targets are exactly the people with a former and a different current employer', () => {
    for (const seed of DEV_SEEDS) {
      const world = generateTemporalEdgesWorld({ seed });
      const { base, targets } = stageWorld(world, PHRASING_A);
      expect(targets.length).toBeGreaterThan(20);
      for (const t of targets) {
        expect(t.current.until).toBeNull();
        expect(t.former.until).not.toBeNull();
        expect(t.former.company).not.toBe(t.current.company);
        expect(t.person.stints.indexOf(t.former) + 1).toBe(t.person.stints.indexOf(t.current));
      }
      const slugs = new Set(targets.map(t => t.person.slug));
      expect(base.some(p => slugs.has(p.slug))).toBe(false);
      expect(base.length + targets.length).toBe(world.pages.length);
    }
  });

  test('stale page names the former employer as current with no move lines; the correction adds only dated move lines', () => {
    const world = generateTemporalEdgesWorld({ seed: 3 });
    const { targets } = stageWorld(world, PHRASING_A);
    const name = new Map(world.companies.map(c => [c.slug, c.name]));
    for (const t of targets) {
      const link = (slug: string) => `[${name.get(slug)}](../${slug}.md)`;
      const staleSentence = PHRASING_A.stale_summary.replace('{name}', t.person.name).replace('{company}', link(t.former.company)).replace('{role}', t.former.role);
      expect(t.stale).toContain(staleSentence);
      expect(t.corrected).toContain(staleSentence);
      expect(t.stale).toContain(`aliases: [${aliasFor(t.person)}]`);
      const rejoin = t.person.stints.slice(0, -2).some(s => s.company === t.current.company);
      if (!rejoin) expect(t.stale).not.toContain(link(t.current.company));
      expect(t.stale).not.toContain(`**${t.former.until}**`);
      expect(t.corrected.startsWith(t.stale.trimEnd())).toBe(true);
      const added = t.corrected.slice(t.stale.trimEnd().length).trim().split('\n');
      const move = `- **${t.current.from}** | linkedin — Left ${link(t.former.company)} to join ${link(t.current.company)} as ${t.current.role}`;
      if (t.former.until === t.current.from) expect(added).toEqual([move]);
      else expect(added).toEqual([`- **${t.former.until}** | linkedin — Left ${link(t.former.company)}`, `- **${t.current.from}** | linkedin — Joined ${link(t.current.company)} as ${t.current.role}`]);
    }
  });

  test('development set A3 renders the same targets with A3 wording', () => {
    const a = stageWorld(generateTemporalEdgesWorld({ seed: 5 }), PHRASING_A);
    const a3 = stageWorld(generateTemporalEdgesWorld({ seed: 5, phrasing: 'A3' }), PHRASING_A3);
    expect(a3.targets.map(t => t.person.slug)).toEqual(a.targets.map(t => t.person.slug));
    expect(a3.targets[0].stale).toContain(' works for ');
    expect(a3.targets[0].stale).not.toEqual(a.targets[0].stale);
  });

  test('alias and question use the name a user would type', () => {
    const p = generateTemporalEdgesWorld({ seed: 3 }).people[0];
    expect(p.name.endsWith('.')).toBe(true);
    expect(aliasFor(p)).toBe(p.name.slice(0, -1));
    expect(questionFor(p)).toBe(`Where does ${p.name} work now?`);
  });
});

describe('temporal ingest-to-answer (E3) string checks', () => {
  test('a relationship note naming the move passes every check', () => {
    const text = 'Grace K. [now: works_at widget-example (since 2023-03-01); ended: works_at acme-example (2023-03-01); summary may be stale: it still names acme-example]';
    expect(checkSurface(text, target, 'Acme')).toEqual({ current_ok: 1, ended_ok: 1, no_stale_current: 1, surface_ok: 1 });
  });

  test('an unflagged stale summary shows the former employer as current', () => {
    const text = 'Grace K. works at [Acme](../companies/acme-example.md) as engineer.';
    expect(checkSurface(text, target, 'Acme')).toEqual({ current_ok: 0, ended_ok: 0, no_stale_current: 0, surface_ok: 0 });
    expect(checkSurface('Grace K. works at Acme.', target, 'Acme').no_stale_current).toBe(0);
  });

  test('a note listing the former employer as current fails even when it also lists it as ended', () => {
    const text = 'now: works_at widget-example (since 2023-03-01), works_at acme-example (since 2019-01-01); ended: works_at acme-example (2023-03-01)';
    expect(checkSurface(text, target, 'Acme')).toEqual({ current_ok: 1, ended_ok: 1, no_stale_current: 0, surface_ok: 0 });
  });

  test('a surface silent about the former employer is not stale but shows nothing current or ended', () => {
    expect(checkSurface('Grace K.', target, 'Acme')).toEqual({ current_ok: 0, ended_ok: 0, no_stale_current: 1, surface_ok: 0 });
  });

  test('note clauses do not leak across the ambient bracket or into another relation', () => {
    const text = '- **A** → `people/a` — A [ended: works_at acme-example (2023-03-01)] now: works_at widget-example';
    expect(checkSurface(text, target, 'Acme').current_ok).toBe(1);
    expect(checkSurface('now: advises acme-example; ended: works_at acme-example (2023-03-01)', target, 'Acme').no_stale_current).toBe(0);
    expect(checkSurface('ended: advises acme-example', target, 'Acme').ended_ok).toBe(0);
  });
});

describe('temporal ingest-to-answer (E3) surface extraction', () => {
  test('ambient keeps only the line pointing at the person', () => {
    const text = '<!-- env -->\n\n## Brain pages mentioned this turn\n- **B** → `people/b-1-example` — B [now: works_at acme-example]\n- **A** → `people/a-1-example` — A [ended: works_at acme-example (2023-03-01)] (use get_page)';
    expect(ambientLine(text, 'people/a-1-example')).toContain('ended: works_at acme-example');
    expect(ambientLine(text, 'people/a-1-example')).not.toContain('now:');
    expect(ambientLine(text, 'people/a-1-exampl')).toBe('');
  });

  test('compiled keeps only the person\'s entry block', () => {
    const text = '<!-- header -->\n<!-- env -->\n\n## A (brain://people/a-1-example)\nupdated: 2026-10-04\n\nA.\n\nrelationships: now: works_at widget-example\n\n## B (brain://people/b-1-example)\nupdated: 2026-10-04\n\nB.\n';
    const entry = compiledEntry(text, 'people/a-1-example');
    expect(entry.startsWith('## A (brain://people/a-1-example)')).toBe(true);
    expect(entry).toContain('relationships: now: works_at widget-example');
    expect(entry).not.toContain('## B');
    expect(compiledEntry(text, 'people/c-1-example')).toBe('');
  });

  test('query keeps the person\'s own chunks and the rows reached from the person', () => {
    const person = { slug: 'people/a-1-example' } as Parameters<typeof queryRead>[1]['person'];
    const results = [
      { slug: 'people/z-9-example', chunk_text: 'Z works at [Acme](../companies/acme-example.md).' },
      { slug: 'companies/widget-example', relational_seed: 'people/a-1-example' },
      { slug: 'people/a-1-example', chunk_text: 'A works at [Acme](../companies/acme-example.md).' },
    ];
    const r = queryRead(results, { person, ...target });
    expect(r.text).not.toContain('people/z-9-example');
    expect(r.exploratory).toEqual({ relational_current: 1, relational_former: 0 });
    expect(checkSurface(r.text, target, 'Acme').no_stale_current).toBe(0);
    expect(queryRead([{ slug: 'companies/acme-example', relational_seed: 'people/a-1-example' }], { person, ...target }).exploratory).toEqual({ relational_current: 0, relational_former: 1 });
  });
});

describe('temporal ingest-to-answer (E3) summary and CLI guards', () => {
  test('summary reports per-surface means, counts and query exploratory fields', () => {
    const row = (surface: E3Row['surface'], ok: number, extra: Record<string, unknown> = {}): E3Row =>
      ({ probe_id: `s3:${surface}:${ok}`, kind: 'correction', cluster: 's3:p', seed: 3, surface, current_ok: ok, ended_ok: 1, no_stale_current: 1, surface_ok: ok, ...extra });
    const s = summarize([
      row('entity', 1), row('entity', 0),
      row('ambient', 0, { reason: 'ambient output has no entry for this person' }),
      row('compiled', 0, { reason: 'surface not in this build: no compileView' }),
      row('query', 0, { relational_current: 1, relational_former: 0 }), row('query', 0, { relational_current: 0, relational_former: 1 }),
    ]);
    expect(Object.keys(s)).toEqual(['entity', 'ambient', 'compiled', 'query']);
    expect(s.entity).toEqual({ n: 2, errors: 0, missing_surface: 0, no_entry: 0, current_ok: 0.5, ended_ok: 1, no_stale_current: 1, surface_ok: 0.5 });
    expect(s.ambient!.no_entry).toBe(1);
    expect(s.compiled!.missing_surface).toBe(1);
    expect(s.query!.exploratory).toEqual({ relational_current: 0.5, relational_former: 0.5 });
    expect(SURFACES).toEqual(['entity', 'context_pack', 'ambient', 'compiled', 'query']);
    expect(HTTP_ARM).toBe('http: not run (remote bulk writes not landed)');
  });

  const cli = (...args: string[]) => Bun.spawnSync(['bun', 'eval/runner/temporal-ingest-answer.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });

  test('development mode refuses held-out seeds and phrasing sets', () => {
    const seeds = cli('--seeds', '3,11');
    expect(seeds.exitCode).toBe(3);
    expect(seeds.stderr.toString()).toContain('only dev seeds 3, 5 run here');
    const phrasing = cli('--phrasing', 'B');
    expect(phrasing.exitCode).toBe(3);
    expect(phrasing.stderr.toString()).toContain('phrasing set B is held out');
  });

  test('custodian mode needs a decision id and purpose before the phrasing file is read, and never prints samples', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e3-custody-'));
    const file = join(dir, 'phrasing.json');
    writeFileSync(file, '{}');
    const missing = cli('--phrasing-file', file);
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr.toString()).toContain('custodian mode needs --decision-id and --purpose');
    const sample = cli('--phrasing-file', file, '--decision-id', 'd', '--purpose', 'p', '--print-sample');
    expect(sample.exitCode).toBe(3);
    expect(sample.stderr.toString()).toContain('--print-sample');
    expect(existsSync(join(dir, 'access-log.jsonl'))).toBe(false);
  });
});

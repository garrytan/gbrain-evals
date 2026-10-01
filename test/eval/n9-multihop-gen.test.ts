import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildN9Questions, renderN9QuestionFile, N9_QUESTIONS_PATH, N9_FRAMES, WorldGraph } from '../../eval/generators/n9-multihop-paraphrase-gen.ts';
import { loadWorldCorpus } from '../../eval/runner/queries/relational.ts';

const pages = loadWorldCorpus(join(import.meta.dir, '../../eval/data/world-v1'));

describe('n9 multi-hop paraphrase generator', () => {
  test('same corpus and seed give byte-identical output, matching the committed file', () => {
    expect(renderN9QuestionFile()).toBe(renderN9QuestionFile());
    expect(readFileSync(N9_QUESTIONS_PATH, 'utf8')).toBe(renderN9QuestionFile());
  });

  test('a different seed changes only paraphrase frame choices, never gold', () => {
    const a = buildN9Questions(pages, 1).questions;
    const b = buildN9Questions(pages, 2).questions;
    expect(a.map(q => [q.id, q.answers, q.required])).toEqual(b.map(q => [q.id, q.answers, q.required]));
    expect(a.map(q => q.paraphrase_frame)).not.toEqual(b.map(q => q.paraphrase_frame));
  });

  test('gold is derived from _facts chains: every answer is reached from the anchor through the family relations', () => {
    const g = new WorldGraph(pages);
    for (const q of buildN9Questions(pages).questions) {
      let frontier = new Set([q.anchor]);
      for (const relation of q.relations) {
        const next = new Set<string>();
        for (const at of frontier) for (const e of g.step(at, relation)) if (e.to !== q.anchor) next.add(e.to);
        frontier = next;
      }
      for (const a of q.answers) expect(frontier.has(a)).toBe(true);
      expect(q.required.length).toBeLessThanOrEqual(10);
      expect(q.required).toEqual(expect.arrayContaining([...q.answers, ...q.support]));
      expect(q.paraphrase_frame).toBeGreaterThanOrEqual(1);
      expect(q.template_text).toBe(N9_FRAMES[q.family][0].replace('{A}', q.anchor_name));
    }
  });

  test('anchors and answers never name a venture firm or acquirer page', () => {
    const g = new WorldGraph(pages);
    for (const q of buildN9Questions(pages).questions) {
      for (const slug of [q.anchor, ...q.answers]) {
        if (g.type(slug) === 'company') expect(g.isStartup(slug)).toBe(true);
      }
    }
  });
});

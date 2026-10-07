/**
 * W7/W8: Cat 20 per-idea judges (prompt, parsing, retries, truncation), the
 * sentence-shuffled corpus, ideas stored in the receipt, and the keyless
 * decision script. Hermetic.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from 'gbrain/ai/gateway';
import {
  buildIdeaJudgePrompt, judgeIdeas, optionsFromEnv, parseIdeaJudgeReply, runCat20, shuffleCorpusSentences,
} from '../../eval/runner/cat20-brainstorm.ts';
import { clusterMeanCI, median, spearman, summarize } from '../../eval/runner/cat20-judges.ts';

const reply = (text: string, stopReason: ChatResult['stopReason'] = 'end') => ({ text, stopReason, blocks: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'x', providerId: 'x' }) as unknown as ChatResult;

describe('per-idea judge parsing', () => {
  test('valid scores give overall = mean of the two scales', () => {
    const r = parseIdeaJudgeReply('j', 'noise {"ideas":[{"id":"01","novelty":4,"usefulness":3,"rationale":"ok"}]} tail', ['01']);
    expect(r).toEqual([{ judge: 'j', idea_id: '01', novelty: 4, usefulness: 3, overall: 3.5, rationale: 'ok', error: null }]);
  });

  test('missing ids, out-of-range and non-integer scores are judge errors, not zeros', () => {
    const r = parseIdeaJudgeReply('j', '{"ideas":[{"id":"01","novelty":6,"usefulness":3},{"id":"02","novelty":2.5,"usefulness":1}]}', ['01', '02', '03']);
    expect(r.map(x => x.error)).toEqual(['missing or out-of-range scores', 'missing or out-of-range scores', 'missing or out-of-range scores']);
    expect(r.every(x => x.overall === null)).toBe(true);
    expect(parseIdeaJudgeReply('j', 'no json here', ['01'])[0]!.error).toBe('unparseable reply');
  });

  test('the prompt shows the question, both pages and ideas, and never the internal verdict', () => {
    const p = buildIdeaJudgePrompt('Q?', 'people/a', { slug: 'people/a', type: 'person', body: 'A body' }, 'concepts/b', undefined, [{ id: '01', text: 'idea one', passes: true } as never]);
    expect(p).toContain('QUESTION: Q?');
    expect(p).toContain('CLOSE PAGE [people/a]\nA body');
    expect(p).toContain('FAR PAGE [concepts/b]\n(page not found in the brain)');
    expect(p).toContain('## Idea 01\nidea one');
    expect(p).not.toMatch(/passes|passed|rejected/i);
  });
});

describe('judgeIdeas', () => {
  const ideas = [
    { id: '01', text: 'a', close_slug: 'c1', far_slug: 'f1', passes: true, distance_score: 0 },
    { id: '02', text: 'b', close_slug: 'c1', far_slug: 'f1', passes: false, distance_score: 0 },
    { id: '03', text: 'c', close_slug: 'c2', far_slug: 'f1', passes: true, distance_score: 0 },
  ];

  test('one call per judge per close-far group, retry once on a malformed reply', async () => {
    const calls: string[] = [];
    let first = true;
    const chatFn = async (o: ChatOpts) => {
      calls.push(`${o.model}`);
      const ids = [...String(o.messages[0]!.content).matchAll(/^## Idea (\S+)$/gm)].map(m => m[1]);
      if (first) { first = false; return reply('garbage'); }
      return reply(JSON.stringify({ ideas: ids.map(id => ({ id, novelty: 3, usefulness: 2, rationale: 'r' })) }));
    };
    const out = await judgeIdeas('Q', ideas as never, new Map(), ['m1', 'm2'], chatFn as never);
    expect(calls).toEqual(['m1', 'm1', 'm1', 'm2', 'm2']);
    expect(out).toHaveLength(6);
    expect(out.every(j => j.overall === 2.5)).toBe(true);
  });

  test('a truncated reply is a judge error without a retry', async () => {
    let n = 0;
    const chatFn = async () => { n++; return reply('{"ideas":[', 'length'); };
    const out = await judgeIdeas('Q', ideas.slice(0, 1) as never, new Map(), ['m1'], chatFn as never);
    expect(n).toBe(1);
    expect(out[0]!.error).toBe('truncated at the output limit');
  });

  test('a thrown call is recorded as a judge error after the retry', async () => {
    const chatFn = async () => { throw new Error('429'); };
    const out = await judgeIdeas('Q', ideas.slice(0, 1) as never, new Map(), ['m1'], chatFn as never);
    expect(out[0]!.error).toMatch(/^call failed: 429/);
  });
});

describe('shuffled corpus', () => {
  const pages = [
    { slug: 'a', type: 'note', body: '---\ntype: note\n---\n# A\n\nAlpha one. Alpha two. Alpha three.' },
    { slug: 'b', type: 'note', body: '---\ntype: note\n---\n# B\n\nBeta one! Beta two?' },
  ];

  test('keeps frontmatter, title and sentence counts, moves sentences across pages, deterministic per seed', () => {
    const s1 = shuffleCorpusSentences(pages, 7);
    expect(s1.map(p => p.slug)).toEqual(['a', 'b']);
    expect(s1[0]!.body.startsWith('---\ntype: note\n---\n# A\n')).toBe(true);
    const sentences = (b: string) => b.split('\n').slice(4).join(' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    expect(sentences(s1[0]!.body)).toHaveLength(3);
    expect(sentences(s1[1]!.body)).toHaveLength(2);
    const pooled = [...sentences(s1[0]!.body), ...sentences(s1[1]!.body)].sort();
    expect(pooled).toEqual(['Alpha one.', 'Alpha three.', 'Alpha two.', 'Beta one!', 'Beta two?']);
    expect(shuffleCorpusSentences(pages, 7)).toEqual(s1);
  });

  test('flags parse', () => {
    const o = optionsFromEnv(['--model', 'anthropic:claude-sonnet-5-5', '--idea-judges', 'a:b,c:d', '--shuffle-corpus', '20261006']);
    expect(o.model).toBe('anthropic:claude-sonnet-5-5');
    expect(o.ideaJudges).toEqual(['a:b', 'c:d']);
    expect(o.shuffleSeed).toBe(20261006);
  });
});

describe('cat20 run stores ideas and judgments (stub)', () => {
  test('every idea is stored with its internal verdict, and every judge scores every idea', async () => {
    const chatFn = async (o: ChatOpts) => {
      const ids = [...String(o.messages[0]!.content).matchAll(/^## Idea (\S+)$/gm)].map(m => m[1]);
      return reply(JSON.stringify({ ideas: ids.map(id => ({ id, novelty: 4, usefulness: 4, rationale: 'fine' })) }));
    };
    const r = await runCat20({ stubLlm: true, quiet: true, questions: ['What is next for an inference platform?'], reportsDir: mkdtempSync(join(tmpdir(), 'cat20-')),
      ideaJudges: ['j1', 'j2'], ideaJudgeChat: chatFn as never });
    const q = r.perQuestion[0]!;
    expect(q.ideas!.length).toBe(q.idea_count);
    expect(q.idea_judgments!.length).toBe(2 * q.idea_count);
    expect(q.ideas![0]).toHaveProperty('passes');
    expect(q.ideas![0]).toHaveProperty('text');
  }, 240_000);
});

describe('keyless decision script', () => {
  const q = (n: number, passingScore: number, rejectedScore: number) => ({
    question: 'Q',
    ideas: Array.from({ length: n }, (_, i) => ({ id: String(i), text: 't', close_slug: `c${i % 4}`, far_slug: 'f', passes: i % 2 === 0 })),
    idea_judgments: ['a', 'b', 'c', 'd'].flatMap(judge => Array.from({ length: n }, (_, i) => ({ judge, idea_id: String(i), overall: i % 2 === 0 ? passingScore : rejectedScore, error: null as string | null }))),
  });

  test('passes at a median of judge means of at least 2.5 on passing ideas', () => {
    const s = summarize([q(24, 3, 1)]);
    expect(s.passing).toBe(12);
    expect(s.median_of_judge_means_on_passing).toBe(3);
    expect(s.decision).toBe('pass');
    expect(s.judges[0]!.passing_minus_rejected).toBe(2);
  });

  test('fails below the floor and is inconclusive with fewer than 10 passing ideas', () => {
    expect(summarize([q(24, 2, 1)]).decision).toBe('fail');
    expect(summarize([q(18, 4, 1)]).decision).toBe('inconclusive');
  });

  test('judge errors are excluded from means, not counted as zero', () => {
    const data = q(24, 3, 1);
    data.idea_judgments[0] = { ...data.idea_judgments[0]!, overall: null as never, error: 'unparseable reply' as string | null };
    const s = summarize([data]);
    expect(s.judges[0]!.errors).toBe(1);
    expect(s.judges[0]!.mean_passing).toBe(3);
  });

  test('statistics helpers', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    const ci = clusterMeanCI([{ cluster: 'a', value: 1 }, { cluster: 'b', value: 3 }]);
    expect(ci![0]).toBeGreaterThanOrEqual(1);
    expect(ci![1]).toBeLessThanOrEqual(3);
    expect(clusterMeanCI([{ cluster: 'a', value: 1 }])).toBeNull();
  });
});

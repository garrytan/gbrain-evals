/**
 * No-gbrain baseline arms (docs/plans/2026-11-17-readme-baselines/PREREG.md): the plain provider call, prompts and
 * parsers, the N2 population, plain judge and paired compare, chronicle plain events, and Cat 35's matched-baseline
 * receipt check. Keyless: every provider call goes to a fake fetch, with the provider keys blanked.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { n2PlainPrompt, parseEventLines, parseYesNo, plainCall, transcriptIdOf, N2_PLAIN_QUESTION } from '../../eval/runner/plain-baseline.ts';
import { comparePaired, judgePlain, populationPairs, referenceVerdicts, type Capture, type CapturedPair } from '../../eval/runner/n2-judge-replay.ts';
import { matchPage, plainEvents } from '../../eval/runner/chronicle-lift.ts';
import { matchedBaselineRecord } from '../../eval/runner/cat35-transcript-distill.ts';

const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) { saved[k] = process.env[k]; process.env[k] = ''; } });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

type Sent = { url: string; body: any };
const fakeFetch = (replies: Array<{ status: number; json: unknown }>, sent: Sent[]) => (async (url: string, init: RequestInit) => {
  sent.push({ url, body: JSON.parse(String(init.body)) });
  const r = replies.shift()!;
  return new Response(JSON.stringify(r.json), { status: r.status });
}) as unknown as typeof fetch;

const anthropicOk = (text: string, stop = 'end_turn') => ({ status: 200, json: { model: 'claude-x', stop_reason: stop, content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }], usage: { input_tokens: 10, output_tokens: 3 } } });

describe('plainCall', () => {
  test('sends one user message to Anthropic and keeps only text blocks', async () => {
    const sent: Sent[] = [];
    const r = await plainCall('anthropic:claude-haiku-4-5', 'hello', 1024, { fetchImpl: fakeFetch([anthropicOk('Yes.')], sent) });
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]!.body).toEqual({ model: 'claude-haiku-4-5', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] });
    expect(r).toMatchObject({ text: 'Yes.', error: null, input_tokens: 10, output_tokens: 3, attempts: 1 });
  });

  test('sends OpenAI chat completions with max_completion_tokens and no sampling fields', async () => {
    const sent: Sent[] = [];
    const r = await plainCall('openai:gpt-6-luna', 'hi', 1024, { fetchImpl: fakeFetch([{ status: 200, json: { model: 'gpt-6-luna', choices: [{ finish_reason: 'stop', message: { content: 'No' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } } }], sent) });
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent[0]!.body).toEqual({ model: 'gpt-6-luna', max_completion_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] });
    expect(r).toMatchObject({ text: 'No', error: null, input_tokens: 7, output_tokens: 2 });
  });

  test('a reply cut at the limit is an error; a transient failure retries and a client error does not', async () => {
    expect((await plainCall('anthropic:m', 'p', 5, { fetchImpl: fakeFetch([anthropicOk('Ye', 'max_tokens')], []) })).error).toMatch(/^truncated/);
    const sent: Sent[] = [];
    const r = await plainCall('anthropic:m', 'p', 5, { backoffMs: 1, fetchImpl: fakeFetch([{ status: 529, json: { error: 'overloaded' } }, anthropicOk('No')], sent) });
    expect(r).toMatchObject({ text: 'No', attempts: 2, error: null });
    const bad: Sent[] = [];
    expect((await plainCall('anthropic:m', 'p', 5, { backoffMs: 1, fetchImpl: fakeFetch([{ status: 400, json: { error: 'bad' } }], bad) })).error).toMatch(/^400/);
    expect(bad.length).toBe(1);
    await expect(plainCall('gemini:x', 'p', 5, { fetchImpl: fakeFetch([], []) })).rejects.toThrow();
  });

  test('a refusal, a filtered reply or an empty reply is an error, not an empty answer', async () => {
    expect((await plainCall('anthropic:m', 'p', 5, { fetchImpl: fakeFetch([{ status: 200, json: { model: 'm', stop_reason: 'refusal', content: [], usage: {} } }], []) })).error).toBe('refusal');
    expect((await plainCall('anthropic:m', 'p', 5, { fetchImpl: fakeFetch([anthropicOk('')], []) })).error).toBe('empty reply');
    const openai = (finish: string, content: string | null) => ({ status: 200, json: { model: 'g', choices: [{ finish_reason: finish, message: { content } }], usage: {} } });
    expect((await plainCall('openai:g', 'p', 5, { fetchImpl: fakeFetch([openai('content_filter', null)], []) })).error).toBe('content_filter');
    expect((await plainCall('openai:g', 'p', 5, { fetchImpl: fakeFetch([openai('stop', null)], []) })).error).toBe('empty reply');
  });
});

describe('prompts and parsers', () => {
  test('the N2 prompt shows each note with its date, or none', () => {
    const p = n2PlainPrompt({ text: 'A says 108.', effective_date: '2025-01-16' }, { text: 'B says 188.', effective_date: null });
    expect(p.startsWith(N2_PLAIN_QUESTION)).toBe(true);
    expect(p).toContain('Note 1 (date: 2025-01-16):\nA says 108.');
    expect(p).toContain('Note 2 (date: none):\nB says 188.');
  });

  test('yes and no map to verdicts; anything else is null', () => {
    expect(parseYesNo('Yes.')).toBe('contradiction');
    expect(parseYesNo('**No** — they are dated differently')).toBe('no_contradiction');
    expect(parseYesNo('  no')).toBe('no_contradiction');
    expect(parseYesNo('Maybe')).toBeNull();
    expect(parseYesNo('')).toBeNull();
    expect(parseYesNo('Nope')).toBeNull();
  });

  test('event lines parse with list markers and bold dates; other lines are ignored', () => {
    expect(parseEventLines('Events:\n- 2026-04-14 | Portfolio review with Elena\n2. **2026-04-15** | Board call\nno date here\n2026-04 | month only')).toEqual([
      { day: '2026-04-14', what: 'Portfolio review with Elena' }, { day: '2026-04-15', what: 'Board call' },
    ]);
  });

  test('transcript ids drop the date prefix', () => {
    expect(transcriptIdOf('2026-08-16-coding-reflection-01.txt')).toBe('coding-reflection-01');
  });
});

const cp = (item: string, a: string, b: string, cls: CapturedPair['gold_class']): CapturedPair => ({
  query: 'q-' + item, item, a: { slug: a, text: 'x', effective_date: null }, b: { slug: b, text: 'y', effective_date: '2025-01-01' }, key: a + '|' + b, gold_class: cls, gold_item: cls === 'unplanted' ? null : item,
});

describe('N2 plain baseline', () => {
  const cap: Capture = { seed: 7, generator_version: 'g', world_fingerprint: 'f', gbrain: null, prompt_version: '4', offered: 4,
    pairs: [cp('i1', 'a', 'b', 'contradiction'), cp('i2', 'c', 'd', 'temporal'), cp('i3', 'e', 'f', 'compatible'), cp('i1', 'a', 'g', 'unplanted')] };

  test('the population keeps every pair: planted as planted, the rest as sample', () => {
    const pop = populationPairs(cap);
    expect(pop.map(p => p.split)).toEqual(['planted', 'planted', 'planted', 'sample']);
    expect(pop[0]!.id).toBe('7:i1:a|b');
  });

  test('judgePlain maps yes to contradiction and an unparseable reply to a judge error', async () => {
    const yes = await judgePlain('anthropic:claude-haiku-4-5', cap.pairs[0]!, fakeFetch([anthropicOk('Yes')], []));
    expect(yes).toMatchObject({ verdict: 'contradiction', error: null, reply: 'Yes' });
    const odd = await judgePlain('anthropic:claude-haiku-4-5', cap.pairs[0]!, fakeFetch([anthropicOk('It depends.')], []));
    expect(odd.verdict).toBeNull();
    expect(odd.error).toMatch(/^unparseable reply/);
  });

  test('compare pairs correctness per class against a receipt reference', () => {
    const pop = populationPairs(cap);
    const ref = referenceVerdicts({ data: { paid: { judgments: [
      { q: 'i1', a: 'b', b: 'a', gold: 'i1:contradiction', verdict: 'contradiction', error: null },
      { q: 'i2', a: 'c', b: 'd', gold: 'i2:temporal', verdict: 'temporal_supersession', error: null },
      { q: 'i3', a: 'e', b: 'f', gold: 'i3:compatible', verdict: 'contradiction', error: null },
      { q: 'i1', a: 'a', b: 'g', gold: 'unplanted', verdict: 'no_contradiction', error: null },
    ] } } }, 7);
    const base = new Map([['7:i1:a|b', { verdict: 'contradiction', error: null }], ['7:i2:c|d', { verdict: 'contradiction', error: null }],
      ['7:i3:e|f', { verdict: 'no_contradiction', error: null }], ['7:i1:a|g', { verdict: 'no_contradiction', error: null }]]);
    const c = comparePaired(pop, base, ref, { offeredTotal: 4, othersTotal: 1, pooled: false });
    expect(c.reference.recall_conflicts.hits).toBe(1);
    expect(c.baseline.false_dated.hits).toBe(1);
    expect(c.reference.false_compatible_original.hits).toBe(1);
    expect(c.paired.planted).toMatchObject({ n: 3, reference_correct: 2, baseline_correct: 2, reference_only_correct: 1, baseline_only_correct: 1 });
    expect(c.paired.all!.n).toBe(4);
    expect(() => comparePaired(pop, new Map(), ref, { offeredTotal: 4, othersTotal: 1, pooled: false })).toThrow(/lack a verdict/);
  });
});

describe('chronicle plain events', () => {
  test('listed lines become events on their page that matchPage scores like an ON arm', () => {
    const ev = plainEvents('plain-a', 'meetings/mtg-0000', '2026-04-14 | Portfolio review with Elena\n2026-04-20 | Board meeting planned');
    expect(ev[0]).toEqual({ slug: 'plain-a/meetings/mtg-0000/1', depth: 'meetings/mtg-0000', day: '2026-04-14', what: 'Portfolio review with Elena', kind: '', who: [] });
    expect(matchPage([{ id: 'm0', day: '2026-04-14', kind: 'meeting', keywords: ['Elena'], basis: '' }], ev)).toEqual([[0, 0]]);
  });
});

describe('Cat 35 matched baseline record', () => {
  const files = [{ transcript_id: 't1', file: 't1.md', bytes: 3, sha256: 'aa', claims: 1 }, { transcript_id: 't2', file: 't2.md', bytes: 3, sha256: 'bb', claims: 1 }];
  const receipt = { kind: 'plain-baseline-cat35-write', model: 'anthropic:claude-sonnet-4-6', instruction: 'Write', instruction_sha256: 'i', max_tokens: 8192, sampling: 'provider default',
    files: [{ transcript_id: 't1', sha256: 'aa' }, { transcript_id: 't2', sha256: 'bb' }] };

  test('records the writer when every document matches', () => {
    expect(matchedBaselineRecord(receipt, files, 'r')).toMatchObject({ writer_receipt_sha256: 'r', model: 'anthropic:claude-sonnet-4-6', documents_matched: 2 });
  });

  test('refuses another kind, a changed document or a document the folder lacks', () => {
    expect(() => matchedBaselineRecord({ ...receipt, kind: 'other' }, files, 'r')).toThrow(/kind/);
    expect(() => matchedBaselineRecord(receipt, [files[0]!, { ...files[1]!, sha256: 'cc' }], 'r')).toThrow(/does not match 1/);
    expect(() => matchedBaselineRecord(receipt, [files[0]!], 'r')).toThrow(/lists 2/);
  });
});

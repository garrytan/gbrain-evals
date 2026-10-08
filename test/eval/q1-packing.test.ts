/**
 * Packing v2 (Q1 PLAN §4.8.7): the cut rule for every item shape, one byte
 * string counted for every participating reader, context identity, and
 * packing loss. Keyless; local tokenizers only.
 */
import { describe, expect, test } from 'bun:test';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { APPROX_COUNTER, RENDERER_VERSION, bodyLines, encodingCount, measureCalibration, packContext, packNative, readerCounter, readerTokenizer, renderItem, strictSources } from '../../eval/runner/systems/render.ts';
import type { Item } from '../../eval/runner/systems/types.ts';

const SONNET = 'anthropic:claude-sonnet-5-5';
const SOL = 'openai:gpt-6.1-sol';
const item = (rank: number, text: string, extra: Partial<Item> = {}): Item => ({ id: `i${rank}`, rank, type: 'page', text, source_ids: [`src-${rank}`], valid_from: null, valid_to: null, provenance_status: 'exact', ...extra });
const q = { id: 'q', conversation: 'c', question: 'What did the user decide?', category: 'x', gold: [], abstention: false } as MemoryQuestion;
const turns = (n: number, words = 40) => Array.from({ length: n }, (_, i) => `**${i % 2 ? 'assistant' : 'user'}:** turn ${i} ${'word '.repeat(words).trim()}.`).join('\n\n');
/** Uncalibrated counts (factor 1.0), so the packer's mechanics are checked against raw encoder counts. */
const RAW = { [SONNET]: { encoding: 'cl100k_base' as const, calibration: 1.0, calibrated: false }, [SOL]: { encoding: 'o200k_base' as const, calibration: 1.0, calibrated: false } };
const counter = readerCounter([SONNET, SOL], RAW);
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('packing v2 cut rule', () => {
  test('a first item three times the budget is cut at its last whole turn, marked, and ends the pack', () => {
    const big = item(1, `---\ntype: conversation\ntitle: "Conversation"\n---\n${turns(30)}`);
    const budget = Math.floor(counter.perReader(counter.measure(renderItem(big)))[SONNET] / 3);
    const p = packNative([big, item(2, 'short')], budget, null, counter);
    expect(p.items.map(i => i.id)).toEqual(['i1']);
    expect(p.cut?.unit).toBe('turn');
    expect(p.lines[0].split('\n')[0]).toBe('- (1, page, cut to fit)');
    const kept = p.lines[0].split('\n').slice(1).map(l => l.trim());
    expect(kept.slice(0, 4)).toEqual(['---', 'type: conversation', 'title: "Conversation"', '---']);
    expect(kept.at(-1)).toMatch(/^\*\*(user|assistant):\*\* turn \d+ (word )+word\.$/);
    expect(p.cut!.kept_lines).toBeLessThan(p.cut!.total_lines);
    expect(p.tokens).toBeLessThanOrEqual(budget);
    expect(p.tokens).toBeGreaterThan(budget * 0.8);
    expect(p.loss).toMatchObject({ items_offered: 2, items_whole: 0, items_cut: 1, items_dropped: 1, sources_offered: 2, sources_dropped_or_cut: 2 });
  });

  test('a non-turn item cuts at its last whole line and packing never skips to a smaller lower-ranked item', () => {
    const first = item(1, 'a short first fact');
    const lines = item(2, Array.from({ length: 20 }, (_, i) => `line ${i} ${'alpha '.repeat(30).trim()}`).join('\n'), { type: 'note' });
    const small = item(3, 'tiny');
    const firstTokens = counter.perReader(counter.measure(renderItem(first)))[SONNET];
    const p = packNative([first, lines, small], firstTokens + 200, null, counter);
    expect(p.items.map(i => i.id)).toEqual(['i1', 'i2']);
    expect(p.cut).toMatchObject({ item_id: 'i2', unit: 'line' });
    expect(p.lines[1].split('\n').slice(1).every(l => /^ {2}line \d+ (alpha )+alpha$/.test(l))).toBe(true);
    expect(p.loss.items_dropped).toBe(1);
  });

  test('a one-line item with no whole line that fits cuts at its last whole sentence', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} says something useful.`).join(' ');
    const p = packNative([item(1, text, { type: 'fact' })], 60, null, counter);
    expect(p.cut?.unit).toBe('sentence');
    expect(p.lines[0]).toMatch(/^- \(1, fact, cut to fit\) Sentence number 0 .*useful\.$/);
    expect(p.tokens).toBeLessThanOrEqual(60);
  });

  test('an item with no boundary inside the budget is not packed, and nothing after it is', () => {
    const p = packNative([item(1, 'x'.repeat(4000)), item(2, 'tiny')], 50, null, counter);
    expect(p.items).toEqual([]);
    expect(p.lines).toEqual([]);
    expect(p.loss).toMatchObject({ items_dropped: 2, items_cut: 0 });
  });

  test('Unicode: CJK and emoji sentences cut on a sentence end with no split surrogate pair', () => {
    const text = Array.from({ length: 80 }, (_, i) => `我们在第${i}天讨论了计划🙂。`).join('');
    const p = packNative([item(1, text)], 120, null, counter);
    expect(p.cut?.unit).toBe('sentence');
    expect(p.lines[0].endsWith('。')).toBe(true);
    expect(lone.test(p.lines[0])).toBe(false);
    expect(p.tokens).toBeLessThanOrEqual(120);
    expect(p.delivered.cl100k_base).toBe(encodingCount('cl100k_base', p.lines.join('\n')));
    expect(p.delivered.o200k_base).toBe(encodingCount('o200k_base', p.lines.join('\n')));
  });

  test('headers: superseded and validity windows survive a cut; one-line rendering is unchanged from v1', () => {
    const fact = item(1, 'Lives in Boston', { type: 'fact', valid_from: '2023-01-01T00:00:00', valid_to: '2023-06-01T00:00:00' });
    expect(renderItem(fact)).toBe('- (1, fact, superseded) [valid 2023-01-01 to 2023-06-01] Lives in Boston');
    const long = item(1, 'First point here. Second point here. Third point here.', { type: 'fact', valid_from: '2023-01-01T00:00:00', valid_to: '2023-06-01T00:00:00' });
    const full = APPROX_COUNTER.perReader(APPROX_COUNTER.measure(renderItem(long)))['*'];
    const p = packNative([long], full - 1, null, APPROX_COUNTER);
    expect(p.lines[0]).toBe('- (1, fact, superseded, cut to fit) [valid 2023-01-01 to 2023-06-01] First point here. Second point here.');
  });

  test('provenance after a cut: the cut item keeps its id and sources; dropped items lose theirs', () => {
    const big = item(1, turns(20), { source_ids: ['src-a', 'src-b'] });
    const ctx = packContext('native', q, [big, item(2, 'later', { source_ids: ['src-c'] })], { budgetTokens: 300, sessionOf: () => undefined, counter });
    expect(ctx.item_ids).toEqual(['i1']);
    expect(ctx.source_ids).toEqual(['src-a', 'src-b']);
    expect(ctx.cut?.item_id).toBe('i1');
    expect(ctx.packing_loss).toMatchObject({ sources_offered: 3, sources_dropped_or_cut: 3 });
    expect(strictSources([big], 5).sources).toEqual(['src-a', 'src-b']);
    expect(ctx.fill_rate).toBeGreaterThan(0.8);
    expect(ctx.fill_rate).toBeLessThanOrEqual(1);
  });
});

describe('one byte string for every reader', () => {
  const items = [item(1, turns(6, 10)), item(2, 'A fact about the trip to Lisbon.', { type: 'fact' }), item(3, turns(40, 30))];

  test('the pack is filled until the largest reader count reaches the budget, and stores every reader count', () => {
    const ctx = packContext('native', q, items, { budgetTokens: 800, sessionOf: () => undefined, counter });
    expect(ctx.readers).toEqual([SONNET, SOL]);
    expect(Object.keys(ctx.reader_tokens).sort()).toEqual([SONNET, SOL]);
    expect(ctx.tokens).toBe(Math.max(...Object.values(ctx.reader_tokens)));
    expect(ctx.tokens).toBeLessThanOrEqual(800);
    const block = ctx.prompt.slice(ctx.prompt.indexOf('Memory Items:\n\n') + 15, ctx.prompt.indexOf('\n\nCurrent Date:'));
    expect(ctx.reader_tokens[SONNET]).toBe(encodingCount('cl100k_base', block));
    expect(ctx.reader_tokens[SOL]).toBe(encodingCount('o200k_base', block));
  });

  test('identical bytes for every reader; identity covers the reader set and tokenizer, not reader order', () => {
    const both = packContext('native', q, items.slice(0, 2), { budgetTokens: null, sessionOf: () => undefined, counter });
    const swapped = packContext('native', q, items.slice(0, 2), { budgetTokens: null, sessionOf: () => undefined, counter: readerCounter([SOL, SONNET, SOL], RAW) });
    const one = packContext('native', q, items.slice(0, 2), { budgetTokens: null, sessionOf: () => undefined, counter: readerCounter([SONNET], RAW) });
    expect(swapped.prompt).toBe(both.prompt);
    expect(swapped.context_sha256).toBe(both.context_sha256);
    expect(one.prompt).toBe(both.prompt);
    expect(one.identity_sha256).not.toBe(both.identity_sha256);
    expect(one.context_sha256).not.toBe(both.context_sha256);
    expect(both.renderer).toBe(RENDERER_VERSION);
    expect(both.tokenizer).toBe('reader-max:cl100k_base+o200k_base');
  });

  test('the shipped table is calibrated from the dev smokes: Claude 5 counts about 1.45-1.47 per cl100k token, GPT-6.1 about 1.0 per o200k token', () => {
    for (const r of ['anthropic:claude-opus-5-5', SONNET]) {
      const t = readerTokenizer(r);
      expect([t.encoding, t.calibrated, t.measured?.on]).toEqual(['cl100k_base', true, '2026-10-07']);
      expect(t.calibration).toBeGreaterThan(1.4);
      expect(t.calibration).toBeLessThan(1.55);
    }
    expect(readerTokenizer(SOL)).toMatchObject({ encoding: 'o200k_base', calibrated: true });
    expect(Math.abs(readerTokenizer(SOL).calibration - 1)).toBeLessThan(0.01);
    expect(readerTokenizer('anthropic:claude-fable-5-1').calibrated).toBe(false);
  });

  test('a calibration factor scales its reader count and can make that reader the binding one', () => {
    const table = { [SONNET]: { encoding: 'cl100k_base' as const, calibration: 1.5, calibrated: true }, [SOL]: { encoding: 'o200k_base' as const, calibration: 1.0, calibrated: true } };
    const calibrated = readerCounter([SONNET, SOL], table);
    const raw = calibrated.measure('A fact about the trip to Lisbon, repeated. '.repeat(20));
    const counts = calibrated.perReader(raw);
    expect(counts[SONNET]).toBe(Math.ceil(raw[0] * 1.5));
    expect(counts[SONNET]).toBeGreaterThan(counts[SOL]);
    const ctxA = packContext('native', q, items, { budgetTokens: 500, sessionOf: () => undefined, counter: calibrated });
    const ctxB = packContext('native', q, items, { budgetTokens: 500, sessionOf: () => undefined, counter });
    expect(ctxA.reader_tokens[SONNET]).toBeLessThanOrEqual(500);
    expect(ctxA.identity_sha256).not.toBe(ctxB.identity_sha256);
    expect(ctxA.prompt.length).toBeLessThan(ctxB.prompt.length);
  });

  test('readers without a table entry fall back by provider, uncalibrated', () => {
    expect(readerTokenizer('openai:gpt-4o-2024-08-06')).toEqual({ encoding: 'o200k_base', calibration: 1, calibrated: false });
    expect(readerTokenizer('gpt-4.1-mini').encoding).toBe('o200k_base');
    expect(readerTokenizer('anthropic:claude-haiku-9').encoding).toBe('cl100k_base');
  });

  test('calibration above 3% error asks for the provider count route', () => {
    expect(measureCalibration([{ local: 1000, provider: 1200 }, { local: 2000, provider: 2400 }])).toEqual({ factor: 1.2, max_error: 0, needs_provider_count: false });
    expect(measureCalibration([{ local: 1000, provider: 1100 }, { local: 1000, provider: 1300 }]).needs_provider_count).toBe(true);
  });

  test('special-token strings count as text, and body lines drop blank lines only', () => {
    expect(encodingCount('cl100k_base', 'see <|endoftext|> here')).toBeGreaterThan(3);
    expect(bodyLines('a\n\n  b   c \r\n')).toEqual(['a', 'b c']);
  });
});

/**
 * Value: protects=render-v2 packRecipe('native') uses the v2 packer (budget cut marker), so it equals the v2 shootout native context byte for byte;
 *   fails_when=the native branch is removed so render.ts's v1 packer answers, or another render stops delegating to render.ts;
 *   why_new=budgeted-delivery-recipes.test.ts imports packRecipe from render.ts only; nothing exercised render-v2's override;
 *   seam=none; no_claim=reader accuracy or other tokenizers (local approximate counter; keyless, no network).
 */
import { describe, expect, test } from 'bun:test';
import type { MemoryQuestion, Session } from '../../eval/runner/memory-qa/corpus.ts';
import { packContext, packRecipe } from '../../eval/runner/systems/render-v2.ts';
import { packRecipe as packRecipeV1 } from '../../eval/runner/systems/render.ts';
import type { Item } from '../../eval/runner/systems/types.ts';

const item = (rank: number, text: string): Item => ({ id: `i${rank}`, rank, type: 'page', text, source_ids: [`src-${rank}`], valid_from: null, valid_to: null, provenance_status: 'exact' });
const q = { id: 'q', conversation: 'c', question: 'What did the user decide?', category: 'x', gold: [], abstention: false } as MemoryQuestion;
const sessionOf = (_: string): Session | undefined => undefined;
const turns = (n: number) => Array.from({ length: n }, (_, i) => `**${i % 2 ? 'assistant' : 'user'}:** turn ${i} ${'word '.repeat(40).trim()}.`).join('\n\n');
const opts = { budgetTokens: 300, sessionOf, fallbackDate: 'd' };

describe('render-v2 packRecipe', () => {
  test('native equals the v2 native context under a cutting budget, and the cut marker proves the v2 packer ran', () => {
    const items = [item(1, turns(30)), item(2, 'short')];
    const v2 = packContext('native', q, items, opts);
    const r = packRecipe('native', q, items, opts);
    expect(v2.cut).not.toBeNull();
    expect(r.prompt).toBe(v2.prompt);
    expect(r.prompt).toContain('cut to fit');
    expect(r.item_ids).toEqual(v2.item_ids);
    expect(r.source_ids).toEqual(v2.source_ids);
    expect(r.items_cut).toBe(items.length - v2.item_ids.length);
    expect(r).toMatchObject({ mode: 'native', render: 'native', budget_tokens: 300 });
    expect(r.prompt).not.toBe(packRecipeV1('native', q, items, opts).prompt);
  });

  test('native with no budget and no items returns the empty placeholder and the question date falls back', () => {
    const r = packRecipe('native', q, [], { budgetTokens: null, sessionOf });
    expect(r.prompt).toContain('(none)');
    expect(r.prompt).toContain('Current Date: unknown');
    expect(r.item_ids).toEqual([]);
    expect(packRecipe('native', { ...q, question_date: '2024-01-02' } as MemoryQuestion, [], { budgetTokens: null, sessionOf }).prompt).toContain('Current Date: 2024-01-02');
  });

  test('every other render is render.ts output unchanged', () => {
    const items = [item(1, '**user:** one\n\n**assistant:** two'), item(2, '**user:** three')];
    for (const render of ['native-dated', 'pseudo-session', 'pseudo-session-rank', 'rehydrated'] as const) {
      expect(packRecipe(render, q, items, { budgetTokens: 8000, sessionOf, fallbackDate: 'd' })).toEqual(packRecipeV1(render, q, items, { budgetTokens: 8000, sessionOf, fallbackDate: 'd' }));
    }
  });
});

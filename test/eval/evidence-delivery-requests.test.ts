/**
 * Evidence-delivery request construction, frozen store, parity and token
 * accounting. Keyless: gbrain's real reader text and renderer come from the
 * installed package; no provider request is made.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READER_MAX_SESSION_CHARS, READER_NOTES_SYSTEM_TEXT } from 'gbrain-reader/eval/longmemeval/reader';
import { renderChatBlock } from '../../node_modules/gbrain/src/eval/longmemeval/sanitize.ts';
import { GET_PAGE_TOOL, getPageResult, packK10, requestParts, sessionBlocks } from '../../eval/runner/evidence-delivery/arms.ts';
import { BlobStore, compareWithR1, duplicateBodies, indexSha, manifestSha, type FrozenHit } from '../../eval/runner/evidence-delivery/store.ts';
import { classifyPageBlock, firstDifference, parityCheck } from '../../eval/runner/evidence-delivery/parity.ts';
import { RENDERER, fixture } from '../support/evidence-delivery-fixture.ts';
import { armRequest, toOutcome, type E1Row } from '../../eval/runner/evidence-delivery/e1.ts';
import { loadDecisionManifest } from '../../eval/runner/evidence-delivery/decision.ts';
import { sha256 } from '../../eval/runner/evidence-delivery/data.ts';

const { manifest } = loadDecisionManifest();

describe('reader requests', () => {
  test('the pinned notes system text is the one R1 used', () => {
    expect(sha256(READER_NOTES_SYSTEM_TEXT)).toBe(manifest.reader.system_sha256);
  });

  test('arms differ only in the evidence section; model, system, limit and framing are identical', () => {
    const { store, q, dataset } = fixture();
    const ctx = { store, renderer: RENDERER, dataset, readerModel: 'anthropic:claude-sonnet-4-6', manifest };
    const parts = ['chunk', 'page', 'page_legacy', 'window1'].map(arm => { const b = armRequest(ctx, q, arm); return { arm, ...requestParts(b.request, b.rendered), request: b.request }; });
    for (const p of parts) {
      expect(p.invariant).toBe(parts[0].invariant);
      expect(Object.keys(p.request).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
      expect(p.request.max_tokens).toBe(1024);
    }
    expect(new Set(parts.map(p => p.evidence)).size).toBe(4);
    expect(parts[0].request.messages[0].content.startsWith('Question:\nWhat happened to the widget I bought?\n\nCurrent Date: 2025/04/01 (Tue) 09:00\n\nRetrieved sessions:\n<chat_session id="s-aaaaaaaaaa" date="2025/01/02 (Thu) 10:00">')).toBe(true);
  });

  test('chunk renders one block per chunk; page renders one block per page; agent_fetch starts from the chunk request', () => {
    const { store, q, dataset } = fixture();
    const ctx = { store, renderer: RENDERER, dataset, readerModel: 'anthropic:claude-sonnet-4-6', manifest };
    expect((armRequest(ctx, q, 'chunk').rendered.match(/<chat_session /g) ?? []).length).toBe(3);
    expect(armRequest(ctx, q, 'agent_fetch').request).toEqual(armRequest(ctx, q, 'chunk').request);
    expect(() => armRequest(ctx, q, 'section')).toThrow('no frozen evidence for section');
  });

  test('get_page returns the page block through the same renderer and refuses sessions outside the retrieved set', () => {
    const { store, q } = fixture();
    const pages = new Map(sessionBlocks(q, q.arms.page.blocks, store, RENDERER).map(b => [b.session_id, b]));
    const ok = getPageResult('s-bbbbbbbbbb', pages, RENDERER);
    expect(ok.isError).toBe(false);
    expect(ok.text).toBe(renderChatBlock([pages.get('s-bbbbbbbbbb')!], { maxSessionChars: READER_MAX_SESSION_CHARS }).rendered);
    expect(getPageResult('s-zzzz', pages, RENDERER).isError).toBe(true);
    expect(GET_PAGE_TOOL.inputSchema.required).toEqual(['session_id']);
  });

  test('k10 packs by rank under the budget, skipping a chunk that does not fit', () => {
    const hits = [5, 50, 3, 1].map((t, i) => ({ rank: i + 1, text: String(t) }) as unknown as FrozenHit);
    const packed = packK10(hits, h => h.text, s => Number(s), 10);
    expect(packed.kept.map(h => h.rank)).toEqual([1, 3, 4]);
    expect(packed.tokens).toBe(9);
  });
});

describe('frozen store', () => {
  test('blobs are content-addressed and verified on read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-blob-'));
    const store = new BlobStore(dir);
    const h = store.put('hello');
    expect(h).toBe(sha256('hello'));
    expect(store.get(h)).toBe('hello');
    writeFileSync(join(dir, 'blobs', h.slice(0, 2), `${h}.txt`), 'tampered');
    expect(() => store.get(h)).toThrow('corrupt');
  });

  test('duplicate bodies are flagged when a block repeats or contains another', () => {
    expect(duplicateBodies(['a b', 'c d'])).toBe(0);
    expect(duplicateBodies(['a b', 'a b'])).toBe(2);
    expect(duplicateBodies(['a b c', 'b'])).toBe(1);
  });

  test('manifest and index hashes are order-independent and content-sensitive', () => {
    const { q } = fixture();
    const q2 = { ...q, question_id: 'syn-2' };
    expect(manifestSha([q, q2])).toBe(manifestSha([q2, q]));
    const pages = [{ slug: 'b', chunks: [{ chunk_index: 0, chunk_source: 'compiled_truth', text: 'x' }] }, { slug: 'a', chunks: [{ chunk_index: 0, chunk_source: 'compiled_truth', text: 'y' }] }];
    expect(indexSha(pages, 'm')).toBe(indexSha([...pages].reverse(), 'm'));
    expect(indexSha(pages, 'm')).not.toBe(indexSha(pages, 'other-model'));
  });

  test('agreement with R1 compares ordered (slug, chunk_id) and slug-only lists', () => {
    const hits = [{ rank: 1, slug: 'a', chunk_id: 1 }, { rank: 2, slug: 'b', chunk_id: 2 }];
    expect(compareWithR1(hits, [{ rank: 1, slug: 'a', chunk_id: 1 }, { rank: 2, slug: 'b', chunk_id: 2 }])).toMatchObject({ identical_slug_chunk_rank: true, identical_slug_rank: true });
    expect(compareWithR1(hits, [{ rank: 1, slug: 'a', chunk_id: 9 }, { rank: 2, slug: 'b', chunk_id: 2 }])).toMatchObject({ identical_slug_chunk_rank: false, identical_slug_rank: true });
    expect(compareWithR1(hits, undefined)).toBeNull();
  });
});

describe('parity before model calls', () => {
  test('page blocks are classified against the harness body', () => {
    const body = '---\ntype: note\n---\n\n**user:** hi\n\n**assistant:** hello\n';
    expect(classifyPageBlock(body, body, false)).toBe('identical');
    expect(classifyPageBlock('**user:** hi\n\n**assistant:** hello\n', body, false)).toBe('frontmatter_only');
    expect(classifyPageBlock('**user:** hi\n**assistant:** hello', body, false)).toBe('whitespace_only');
    expect(classifyPageBlock('**user:** bye', body, false)).toBe('other');
    expect(firstDifference('abc', 'abd')).toBe(2);
    expect(firstDifference('abc', 'abc')).toBeNull();
  });

  test('page_legacy must reproduce R1 logged bytes; a one-byte difference fails the check', () => {
    const { store, q, dataset } = fixture();
    const ctx = { store, renderer: RENDERER, dataset, readerModel: 'anthropic:claude-sonnet-4-6', manifest };
    const legacy = armRequest(ctx, q, 'page_legacy').request;
    const questionOf = (id: string) => ({ question: dataset.get(id)!.question, question_date: dataset.get(id)!.question_date });
    const good = parityCheck([q], store, RENDERER, questionOf, new Map([[dataset.get('syn-1')!.question, { system: legacy.system, user: legacy.messages[0].content }]]), 'anthropic:claude-sonnet-4-6', 1024);
    expect(good.ok).toBe(true);
    expect(good.harness_vs_r1).toMatchObject({ eligible: 1, identical: 1 });
    expect(good.product_page_vs_harness!.blocks.frontmatter_only).toBe(3);
    const bad = parityCheck([q], store, RENDERER, questionOf, new Map([[dataset.get('syn-1')!.question, { system: legacy.system, user: legacy.messages[0].content + ' ' }]]), 'anthropic:claude-sonnet-4-6', 1024);
    expect(bad.ok).toBe(false);
    expect(bad.harness_vs_r1.mismatched[0]).toMatchObject({ field: 'user' });
  });
});

describe('three-way token accounting', () => {
  test('outcome rows carry provider-reported input tokens; the other two counts stay on the row', () => {
    const row = {
      question_id: 'x', question_type: 'multi-session', cluster: 'x', primary: 1, confirmation: 0, duplicate_bodies: 0,
      tokens: { tokenizer: 'cl100k', product_encoding: 5000, serialized_tool: 6200, provider_input: 6900, provider_output: 210 },
    } as unknown as E1Row;
    expect(toOutcome(row)).toMatchObject({ provider_input_tokens: 6900, primary: 1, confirmation: 0, reader_error: null });
  });
});

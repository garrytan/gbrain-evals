/** Shared synthetic fixture for the evidence-delivery tests: invented sessions only. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READER_MAX_SESSION_CHARS, READER_NOTES_SYSTEM_TEXT, buildReaderUserText } from 'gbrain-reader/eval/longmemeval/reader';
import { renderChatBlock } from '../../node_modules/gbrain/src/eval/longmemeval/sanitize.ts';
import { sessionIdFromSlug } from '../../node_modules/gbrain/src/eval/longmemeval/metrics.ts';
import type { Renderer } from '../../eval/runner/evidence-delivery/arms.ts';
import { BlobStore, evidenceSha, type FrozenHit, type FrozenQuestion } from '../../eval/runner/evidence-delivery/store.ts';
import { stripFrontmatter } from '../../eval/runner/evidence-delivery/parity.ts';
import { sha256 } from '../../eval/runner/evidence-delivery/data.ts';

export const RENDERER: Renderer = { system: READER_NOTES_SYSTEM_TEXT, maxSessionChars: READER_MAX_SESSION_CHARS, renderChatBlock, buildReaderUserText, sessionIdFromSlug };
/** A synthetic frozen question: three invented sessions, every arm's blocks in a temp blob store. */
export function fixture() {
  const store = new BlobStore(mkdtempSync(join(tmpdir(), 'ed-store-')));
  const bodies = [
    '---\ntype: note\ndate: 2025/01/02 (Thu) 10:00\nsession_id: s-aaaaaaaaaa\n---\n\n**user:** I bought a blue widget from acme-example.\n\n**assistant:** Nice.\n',
    '---\ntype: note\ndate: 2025/02/03 (Mon) 11:00\nsession_id: s-bbbbbbbbbb\n---\n\n**user:** The widget broke, so I returned it.\n\n**assistant:** Sorry to hear.\n',
    '---\ntype: note\ndate: 2025/03/04 (Tue) 12:00\nsession_id: s-cccccccccc\n---\n\n**user:** Unrelated chat about tea.\n\n**assistant:** Green tea is fine.\n',
  ];
  const slugs = ['chat/s-aaaaaaaaaa', 'chat/s-bbbbbbbbbb', 'chat/s-cccccccccc'];
  const dates = ['2025/01/02 (Thu) 10:00', '2025/02/03 (Mon) 11:00', '2025/03/04 (Tue) 12:00'];
  const chunkTexts = ['**user:** I bought a blue widget from acme-example.', '**user:** The widget broke, so I returned it.', '**user:** Unrelated chat about tea.'];
  const hits: FrozenHit[] = slugs.map((slug, i) => ({ rank: i + 1, slug, page_id: i + 1, chunk_id: 10 + i, chunk_index: 0, chunk_source: 'compiled_truth', score: 1 - i / 10, text: store.put(chunkTexts[i]) }));
  const block = (slug: string, text: string) => ({ slug, text: store.put(text) });
  const arm = (blocks: Array<{ slug: string; text: string }>) => ({ source: 'frozen' as const, blocks, evidence_sha256: evidenceSha(blocks), product_encoding_tokens: 10, serialized_tool_tokens: null, duplicate_bodies: 0 });
  const q: FrozenQuestion = {
    question_id: 'syn-1', set: 'pilot', question_type: 'multi-session', question_sha256: sha256('q'), question_date: '2025/04/01 (Tue) 09:00', index_sha256: 'x',
    search_meta: { reranked: true, degraded: [] }, hits5: hits, hits10: hits,
    pages: slugs.map((slug, i) => ({ slug, page_id: i + 1, date: dates[i], harness_body: store.put(bodies[i]), chunks: [{ chunk_id: 10 + i, chunk_index: 0, chunk_source: 'compiled_truth', text: hits[i].text }] })),
    r1: { identical_slug_chunk_rank: true, identical_slug_rank: true, r1_sig: '' },
    arms: {
      chunk: arm(hits.map(h => ({ slug: h.slug, text: h.text }))),
      page_legacy: { ...arm(slugs.map((s, i) => block(s, bodies[i]))), source: 'harness' },
      page: { ...arm(slugs.map((s, i) => block(s, stripFrontmatter(bodies[i])))), source: 'product', results: store.put(JSON.stringify(slugs.map((s, i) => ({ slug: s, chunk_text: stripFrontmatter(bodies[i]), delivered: { unit: 'page', truncated: false } })))) },
      window1: { ...arm([block(slugs[0], `${chunkTexts[0]}\n\n**assistant:** Nice.`), block(slugs[1], chunkTexts[1])]), source: 'product' },
    },
  };
  const dataset = new Map([['syn-1', { question_id: 'syn-1', question: 'What happened to the widget I bought?', question_date: q.question_date, question_type: 'multi-session', answer: 'returned' } as any]]);
  return { store, q, dataset, bodies, slugs };
}

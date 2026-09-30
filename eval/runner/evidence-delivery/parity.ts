/**
 * Byte-level parity checks, run before any model call (plan amendment 4).
 *
 *   1. Harness integrity: on questions whose frozen top five equal R1's, the
 *      page_legacy request must be byte-identical to the request R1 logged.
 *   2. Product page against the harness reader: each product `page` block is
 *      compared with the harness reader's body for the same session and
 *      classified, and the two full requests are compared.
 */
import { buildRequest, sessionBlocks, type ReaderRequest, type Renderer } from './arms.ts';
import type { BlobStore, FrozenQuestion } from './store.ts';

export type PageParityClass = 'identical' | 'frontmatter_only' | 'whitespace_only' | 'truncated' | 'missing' | 'other';

export interface ParityReport {
  schema: 'gbrain-evals/evidence-delivery-parity/v1';
  harness_vs_r1: { eligible: number; identical: number; mismatched: Array<{ question_id: string; field: 'system' | 'user' | 'missing_r1_call'; first_difference: number | null }> };
  product_page_vs_harness: null | {
    questions: number;
    requests_identical: number;
    same_session_order: number;
    blocks: Record<PageParityClass, number>;
    examples: Array<{ question_id: string; slug: string; class: PageParityClass; first_difference: number | null; product_context: string; harness_context: string }>;
  };
  ok: boolean;
  problems: string[];
}

export const stripFrontmatter = (body: string) => body.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function firstDifference(a: string, b: string): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? null : n;
}

export function classifyPageBlock(product: string, harness: string, truncatedFlag: boolean): PageParityClass {
  if (product === harness) return 'identical';
  const body = stripFrontmatter(harness);
  if (product === body || product === body.trimEnd()) return 'frontmatter_only';
  if (collapse(product) === collapse(body)) return 'whitespace_only';
  if (truncatedFlag && collapse(body).startsWith(collapse(product).replace(/\[…\]/g, '').trim().slice(0, 1000))) return 'truncated';
  return 'other';
}

export interface R1Call { system: string; user: string }

export function parityCheck(frozen: FrozenQuestion[], store: Pick<BlobStore, 'get'>, r: Renderer, questionOf: (id: string) => { question: string; question_date?: string }, r1Calls: Map<string, R1Call>, model: string, maxTokens: number, maxExamples = 20): ParityReport {
  const problems: string[] = [];
  const harness: ParityReport['harness_vs_r1'] = { eligible: 0, identical: 0, mismatched: [] };
  let product: ParityReport['product_page_vs_harness'] = null;
  const req = (q: FrozenQuestion, arm: string): { request: ReaderRequest; rendered: string } => buildRequest(r, questionOf(q.question_id), sessionBlocks(q, q.arms[arm].blocks, store, r), model, maxTokens);
  for (const q of frozen) {
    if (!q.r1?.identical_slug_chunk_rank || !q.arms.page_legacy) continue;
    harness.eligible++;
    const ours = req(q, 'page_legacy').request;
    const theirs = r1Calls.get(questionOf(q.question_id).question);
    if (!theirs) { harness.mismatched.push({ question_id: q.question_id, field: 'missing_r1_call', first_difference: null }); continue; }
    if (ours.system !== theirs.system) harness.mismatched.push({ question_id: q.question_id, field: 'system', first_difference: firstDifference(ours.system, theirs.system) });
    else if (ours.messages[0].content !== theirs.user) harness.mismatched.push({ question_id: q.question_id, field: 'user', first_difference: firstDifference(ours.messages[0].content, theirs.user) });
    else harness.identical++;
  }
  if (harness.mismatched.length) problems.push(`${harness.mismatched.length} page_legacy request(s) differ from R1's logged bytes on identical-list questions`);

  const withPage = frozen.filter(q => q.arms.page && q.arms.page_legacy);
  if (withPage.length) {
    product = { questions: withPage.length, requests_identical: 0, same_session_order: 0, blocks: { identical: 0, frontmatter_only: 0, whitespace_only: 0, truncated: 0, missing: 0, other: 0 }, examples: [] };
    for (const q of withPage) {
      const page = q.arms.page, legacy = q.arms.page_legacy;
      if (req(q, 'page').request.messages[0].content === req(q, 'page_legacy').request.messages[0].content) product.requests_identical++;
      if (JSON.stringify(page.blocks.map(b => b.slug)) === JSON.stringify(legacy.blocks.map(b => b.slug))) product.same_session_order++;
      const results = page.results ? JSON.parse(store.get(page.results)) as Array<{ slug: string; delivered?: { truncated?: boolean } }> : [];
      for (const lb of legacy.blocks) {
        const pb = page.blocks.find(b => b.slug === lb.slug);
        const cls: PageParityClass = pb ? classifyPageBlock(store.get(pb.text), store.get(lb.text), !!results.find(x => x.slug === lb.slug)?.delivered?.truncated) : 'missing';
        product.blocks[cls]++;
        if (cls !== 'identical' && cls !== 'frontmatter_only' && product.examples.length < maxExamples) {
          const p = pb ? store.get(pb.text) : '', h = stripFrontmatter(store.get(lb.text));
          const at = firstDifference(p, h);
          product.examples.push({ question_id: q.question_id, slug: lb.slug, class: cls, first_difference: at, product_context: at === null ? '' : p.slice(Math.max(0, at - 40), at + 40), harness_context: at === null ? '' : h.slice(Math.max(0, at - 40), at + 40) });
        }
      }
    }
  }
  return { schema: 'gbrain-evals/evidence-delivery-parity/v1', harness_vs_r1: harness, product_page_vs_harness: product, ok: problems.length === 0, problems };
}

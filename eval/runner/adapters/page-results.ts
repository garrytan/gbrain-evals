import type { RankedDoc } from '../types.ts';

/**
 * Keep the first chunk for each page in the order the product returned it.
 * A reranker, identity lookup or relational evidence slot can deliberately
 * put a lower-scoring row first. Sorting by the old score undoes that choice.
 */
export function pagesInResultOrder(
  rows: readonly { slug: string; score: number }[],
  limit: number,
): RankedDoc[] {
  const seen = new Set<string>();
  const pages: RankedDoc[] = [];
  for (const row of rows) {
    if (pages.length >= limit) break;
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    pages.push({ page_id: row.slug, score: row.score, rank: pages.length + 1 });
  }
  return pages;
}

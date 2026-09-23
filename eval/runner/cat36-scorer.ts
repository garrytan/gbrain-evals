import { ndcgAtK, precisionAtK, recallAllAtK, recallAtK, reciprocalRank, uniqueInOrder } from './metrics.ts';
import { canonicalText, fixturePageId, type Cat36Probe, type Cat36Source, type Cat36Span } from './cat36-corpus.ts';

export const CAT36_SCORER = 'source-span-union-nfc-lf-v1';
export interface Cat36Chunk {
  source_id: string;
  runtime_source_id?: string;
  slug: string;
  page_id: number;
  chunk_id: number;
  chunk_index: number;
  text: string;
  start: number | null;
  end: number | null;
  token_count: number;
}
export interface Cat36CueObservation {
  mode: 'off' | 'shadow' | 'on';
  status: 'ready' | 'empty' | 'skipped' | 'degraded';
  reason?: string;
  candidates: number;
  admitted: number;
}
export type NoGold = { not_applicable: 'no_gold' };
export interface Cat36Score {
  all_evidence_in_top5_chunks: number | NoGold;
  page_recall_at5: number | NoGold;
  page_precision_at5: number | NoGold;
  page_mrr: number | NoGold;
  page_ndcg_at5: number | NoGold;
  associative_false_fire: number | { not_applicable: 'positive_probe' };
  negative_result_count: number | { not_applicable: 'positive_probe' };
  returned_evidence_tokens: number;
  safety_violations: number;
  matched_span_ids: string[];
  returned_page_ids: string[];
}

export function alignSourceChunks(text: string, chunks: ReadonlyArray<{ chunk_id: number; text: string }>): Map<number, { start: number; end: number } | null> {
  const canonical = canonicalText(text);
  const result = new Map<number, { start: number; end: number } | null>();
  for (const chunk of chunks) {
    const normalized = canonicalText(chunk.text);
    const first = normalized.length ? canonical.indexOf(normalized) : -1;
    if (first < 0 || canonical.indexOf(normalized, first + 1) >= 0) {
      result.set(chunk.chunk_id, null);
    } else {
      result.set(chunk.chunk_id, { start: first, end: first + normalized.length });
    }
  }
  return result;
}

export function spanCovered(span: Cat36Span, chunks: readonly Cat36Chunk[], sources: ReadonlyMap<string, Pick<Cat36Source, 'text'>>): boolean {
  const source = sources.get(fixturePageId(span));
  if (!source || canonicalText(source.text).slice(span.start, span.end) !== span.text) return false;
  const ranges = chunks.filter(c => fixturePageId(c) === fixturePageId(span)
    && Number.isInteger(c.start) && Number.isInteger(c.end) && c.start! >= 0 && c.end! > c.start!
    && canonicalText(source.text).slice(c.start!, c.end!) === canonicalText(c.text))
    .map(c => [c.start!, c.end!] as const).sort((a, b) => a[0] - b[0]);
  let coveredTo = span.start;
  for (const [start, end] of ranges) {
    if (start > coveredTo) break;
    if (end > coveredTo) coveredTo = end;
    if (coveredTo >= span.end) return true;
  }
  return false;
}

export function scoreCat36Probe(probe: Cat36Probe, results: readonly Cat36Chunk[], spans: readonly Cat36Span[], sources: readonly Cat36Source[], cue: Cat36CueObservation): Cat36Score {
  const top = results.slice(0, 5);
  const sourceMap = new Map(sources.map(s => [fixturePageId(s), s]));
  const gold = probe.required_span_ids.map(id => {
    const span = spans.find(s => s.id === id);
    if (!span || span.family_id !== probe.family_id) throw new Error(`missing or foreign span ${id}`);
    return span;
  });
  if ((probe.kind === 'negative') !== (gold.length === 0)) throw new Error('invalid positive/negative gold');
  if (top.some(c => !Number.isFinite(c.token_count) || c.token_count < 0)) throw new Error('invalid returned token count');
  if (!Number.isInteger(cue.admitted) || cue.admitted < 0 || !Number.isInteger(cue.candidates) || cue.candidates < cue.admitted) throw new Error('invalid cue observation');
  const matched = gold.filter(s => spanCovered(s, top, sourceMap)).map(s => s.id);
  const pages = uniqueInOrder(top.map(fixturePageId));
  const relevant = new Set(gold.map(fixturePageId));
  const noGold: NoGold = { not_applicable: 'no_gold' };
  return {
    all_evidence_in_top5_chunks: gold.length ? recallAllAtK(matched, new Set(probe.required_span_ids), matched.length) : noGold,
    page_recall_at5: gold.length ? recallAtK(pages, relevant, 5) : noGold,
    page_precision_at5: gold.length ? precisionAtK(pages, relevant, 5) : noGold,
    page_mrr: gold.length ? reciprocalRank(pages, relevant) : noGold,
    page_ndcg_at5: gold.length ? ndcgAtK(pages, new Map([...relevant].map(id => [id, 1])), 5) : noGold,
    associative_false_fire: gold.length ? { not_applicable: 'positive_probe' } : Number(cue.admitted > 0),
    negative_result_count: gold.length ? { not_applicable: 'positive_probe' } : top.length,
    returned_evidence_tokens: top.reduce((sum, c) => sum + c.token_count, 0),
    safety_violations: top.filter(c => sourceMap.get(fixturePageId(c))?.visibility !== 'public').length,
    matched_span_ids: matched,
    returned_page_ids: pages,
  };
}

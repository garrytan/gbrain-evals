/**
 * BG1's exposure diagnostics (preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md,
 * review finding F8): what one frozen context delivered to the reader, so a loss can be placed in retrieval or in
 * reading.
 *
 *   exposure(q, contextText, { rawText }) is { gold, stale, deciding_line }:
 *     gold           the delivered context states the gold value (every value, for an ordered question), after the
 *                    matcher's alias and number normalisation (match.ts)
 *     stale          it states any of the slot's stale values
 *     deciding_line  s4_conflicting only: the governing line (signed or owner-confirmed) appears whole, normalised. It is
 *                    reported only for raw-text rows (gbrain's pages and hybrid search over the raw chats), since an
 *                    extraction row rewrites the line even when it captured the fact; null everywhere else, and for a
 *                    question with no deciding line.
 *
 * evidenceOf cuts a frozen reader prompt down to its delivered memory, and summarizeExposure folds the per-context
 * records into the rates verdict.ts reports beside each row.
 */
import type { MemoryQuestion } from '../memory-qa/corpus.ts';
import { READER_TEMPLATE } from '../memory-qa/qa.ts';
import { NATIVE_READER_TEMPLATE } from '../systems/render.ts';
import { normalise, presence } from './match.ts';

/** Rows whose delivered context is the history's own text: gbrain's pages and hybrid search over the raw chats. */
export const RAW_TEXT_SYSTEMS: readonly string[] = ['gbrain-defaults', 'baseline-hybrid'];
export const isRawTextRow = (system: string) => RAW_TEXT_SYSTEMS.includes(system);

export interface Exposure { gold: boolean; stale: boolean; deciding_line: boolean | null }

/**
 * The delivered memory of a frozen reader prompt: what the reading template's {items} (packed rows) or {history}
 * (the full-context reference) placeholder holds, without the template's own words, the date or the question. A prompt
 * that neither template produced is returned whole.
 */
export function evidenceOf(prompt: string): string {
  for (const [template, slot] of [[NATIVE_READER_TEMPLATE, '{items}'], [READER_TEMPLATE, '{history}']] as const) {
    const at = template.indexOf(slot);
    const before = template.slice(0, at), after = template.slice(at + slot.length, template.indexOf('{', at + slot.length));
    const end = prompt.lastIndexOf(after);
    if (at >= 0 && prompt.startsWith(before) && end >= before.length) return prompt.slice(before.length, end);
  }
  return prompt;
}

export function exposure(q: Pick<MemoryQuestion, 'id' | 'bg1'>, contextText: string, opts: { rawText: boolean }): Exposure {
  const { gold, stale } = presence(q, contextText);
  const line = q.bg1!.deciding_line;
  const deciding = opts.rawText && line ? ` ${normalise(contextText)} `.includes(` ${normalise(line)} `) : null;
  return { gold, stale, deciding_line: deciding };
}

export interface ExposureSummary {
  contexts: number;
  gold_rate: number | null;
  stale_rate: number | null;
  /** Gold delivered and no stale value delivered: the context a reader can answer from without choosing. */
  gold_only_rate: number | null;
  /** Of the contexts that carried a deciding line check (raw-text s4 rows), the share that delivered it; null when none did. */
  deciding_line_rate: number | null;
  deciding_line_checked: number;
}

export function summarizeExposure(records: readonly Exposure[]): ExposureSummary {
  const n = records.length;
  const rate = (k: number, of: number) => (of ? Math.round((k / of) * 10_000) / 10_000 : null);
  const checked = records.filter(r => r.deciding_line !== null);
  return {
    contexts: n,
    gold_rate: rate(records.filter(r => r.gold).length, n),
    stale_rate: rate(records.filter(r => r.stale).length, n),
    gold_only_rate: rate(records.filter(r => r.gold && !r.stale).length, n),
    deciding_line_rate: rate(checked.filter(r => r.deciding_line).length, checked.length),
    deciding_line_checked: checked.length,
  };
}

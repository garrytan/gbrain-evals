// GBRA-94 shared rules: the clean-read reading of the pinned classifier, and arm D's skip heuristics (text features only).
const QUESTION_WORDS = new Set(['who', 'what', 'when', 'where', 'why', 'how', 'which', 'whom', 'whose', 'did', 'do', 'does', 'is', 'are', 'was', 'were', 'can', 'could', 'should', 'would', 'will', 'have', 'has', 'had', 'am', 'may', 'might', 'shall']);
export const words = (q: string) => q.trim().split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
/** D-short: a keyword or entity lookup. At most 4 words, or at most 8 words with no '?' that doesn't open with a question word. */
export function isShortKeyword(q: string): boolean {
  const ws = words(q);
  if (ws.length <= 4) return true;
  const first = ws[0]!.toLowerCase().replace(/[^\p{L}]/gu, '');
  return ws.length <= 8 && !q.includes('?') && !QUESTION_WORDS.has(first);
}
/** D-long: a pasted passage. At least 30 words, so the query already carries its own vocabulary. */
export const isLongPassage = (q: string) => words(q).length >= 30;
export const SKIP_RULES: Record<string, (q: string) => boolean> = {
  'D-short': isShortKeyword,
  'D-long': isLongPassage,
  'D-short+long': (q) => isShortKeyword(q) || isLongPassage(q),
};

/** The pinned classifier's verdict; with expansion deliberately off, `expansion_not_applied` is the arm's design, not a failure. */
export function cleanRead(cls: any, expansionOff: boolean): boolean {
  if (!cls) return false;
  if (cls.outcome === 'scored') return true;
  return expansionOff && cls.outcome === 'harness_invalid' && (cls.reasons ?? []).length > 0 && cls.reasons.every((r: string) => r === 'expansion_not_applied');
}


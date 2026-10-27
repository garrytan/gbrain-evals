/**
 * Grammar lines in agent-written brains (G6 arm B), for G2, adoption recall and "grammar lines and diagnostics per
 * page". The write-then-answer runner calls extractGrammarLines on every finished arm-B brain with the build's own
 * parser and writes the result into the custody work root; nothing here leaves custody except counts.
 *
 *   G2 sample       relation lines minted in arm B's brains, every model and ingest; up to 300 drawn with a frozen
 *                   seed, stratified by model (equal shares, a model with fewer lines gives its unused share to the
 *                   others in a fixed order); all lines when there are fewer than the sample size.
 *   adoption pool   list lines that hold a link (a typed relation line needs one), labeled with
 *                   `q2-adoption-judge-v1`: did the agent mean the line as a typed relation line? Of the lines both
 *                   judges say yes to, the share minted is adoption recall; misses are counted by the parser's reason code.
 */
import { createHash } from 'node:crypto';
import { listLines } from '../line-grammar-junk-audit.ts';
import { seededSample } from '../p5-agent.ts';

export interface BrainRef { corpus: string; model: string; arm: string; ingest: number }
export const brainKey = (b: BrainRef) => `${b.corpus}|${b.model}|${b.arm}|ingest${b.ingest}`;

export interface GrammarLine extends BrainRef { id: string; slug: string; line: number; text: string; context: string; kind: 'relation' | 'fact'; parsed: string }
export interface ListLineRecord extends BrainRef { id: string; slug: string; line: number; text: string; context: string; has_link: boolean; minted: 'relation' | 'fact' | null; reasons: string[] }
export interface BrainGrammarSummary extends BrainRef { pages: number; pages_with_grammar_lines: number; relation_lines: number; fact_lines: number; diagnostics: number; diagnostics_by_reason: Record<string, number>; list_lines: number }

interface ParseResult { facts: Array<{ line: number; category: string }>; relations: Array<{ line: number; type: string }>; diagnostics?: Array<{ line: number; reason: string }> }

const lineId = (b: BrainRef, slug: string, line: number, text: string) => createHash('sha256').update(`${brainKey(b)}\u0000${slug}\u0000${line}\u0000${text}`).digest('hex').slice(0, 24);

/** Every grammar line and every list line of a brain's pages, parsed by the build (`parse` binds the active pack's verbs). */
export function extractGrammarLines(b: BrainRef, pages: ReadonlyArray<{ slug: string; body: string }>, parse: (text: string) => ParseResult): { grammar: GrammarLine[]; list: ListLineRecord[]; summary: BrainGrammarSummary } {
  const grammar: GrammarLine[] = [];
  const list: ListLineRecord[] = [];
  const summary: BrainGrammarSummary = { ...b, pages: pages.length, pages_with_grammar_lines: 0, relation_lines: 0, fact_lines: 0, diagnostics: 0, diagnostics_by_reason: {}, list_lines: 0 };
  for (const p of pages) {
    const r = parse(p.body);
    const lines = p.body.split('\n');
    const ctx = (n: number) => lines.slice(Math.max(0, n - 4), n + 3).join('\n');
    const minted = new Map<number, 'relation' | 'fact'>();
    for (const x of r.relations) { minted.set(x.line, 'relation'); grammar.push({ ...b, id: lineId(b, p.slug, x.line, lines[x.line - 1] ?? ''), slug: p.slug, line: x.line, text: lines[x.line - 1] ?? '', context: ctx(x.line), kind: 'relation', parsed: `relation type ${x.type}` }); }
    for (const x of r.facts) { minted.set(x.line, 'fact'); grammar.push({ ...b, id: lineId(b, p.slug, x.line, lines[x.line - 1] ?? ''), slug: p.slug, line: x.line, text: lines[x.line - 1] ?? '', context: ctx(x.line), kind: 'fact', parsed: `fact category ${x.category}` }); }
    const reasons = new Map<number, string[]>();
    for (const d of r.diagnostics ?? []) { reasons.set(d.line, [...(reasons.get(d.line) ?? []), d.reason]); summary.diagnostics_by_reason[d.reason] = (summary.diagnostics_by_reason[d.reason] ?? 0) + 1; }
    summary.diagnostics += r.diagnostics?.length ?? 0;
    summary.relation_lines += r.relations.length;
    summary.fact_lines += r.facts.length;
    if (r.relations.length || r.facts.length) summary.pages_with_grammar_lines++;
    for (const l of listLines(p.body)) {
      summary.list_lines++;
      list.push({ ...b, id: lineId(b, p.slug, l.line, l.text), slug: p.slug, line: l.line, text: l.text, context: ctx(l.line), has_link: /\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)/.test(l.content), minted: minted.get(l.line) ?? null, reasons: reasons.get(l.line) ?? [] });
    }
  }
  return { grammar, list, summary };
}

/**
 * Stratified sample by model: equal shares of `size`; a model with fewer lines gives its unused share to the others,
 * models in sorted order. Within a model, lines are sorted by id and drawn with `seededSample`, so the sample is a
 * pure function of the stratum and the seed.
 */
export function stratifiedByModel<T extends { id: string; model: string }>(lines: readonly T[], size: number, seed: number): { sample: T[]; allocation: Record<string, { lines: number; drawn: number }> } {
  const models = [...new Set(lines.map(l => l.model))].sort();
  const by = new Map(models.map(m => [m, lines.filter(l => l.model === m).sort((a, b) => a.id.localeCompare(b.id))]));
  const take = new Map(models.map(m => [m, 0]));
  let left = Math.min(size, lines.length);
  while (left > 0) {
    const open = models.filter(m => take.get(m)! < by.get(m)!.length);
    const share = Math.max(1, Math.floor(left / open.length));
    for (const m of open) {
      if (left <= 0) break;
      const add = Math.min(share, by.get(m)!.length - take.get(m)!, left);
      take.set(m, take.get(m)! + add);
      left -= add;
    }
  }
  const sample = models.flatMap((m, i) => seededSample(by.get(m)!, take.get(m)!, seed + i));
  return { sample, allocation: Object.fromEntries(models.map(m => [m, { lines: by.get(m)!.length, drawn: take.get(m)! }])) };
}

export const ADOPTION_PROMPT_VERSION = 'q2-adoption-judge-v1';
export const ADOPTION_SYSTEM = 'You audit notes an AI agent wrote into a personal knowledge base. You answer with one JSON object and nothing else.';
export function adoptionPrompt(l: Pick<ListLineRecord, 'text' | 'context'>): string {
  return [
    'The agent was told it may state a relationship as a typed relation line: a list item with one relationship word and one link, for example `- works_at [[companies/acme-example]]`.',
    '',
    `Line:\n${l.text}`,
    '',
    `Surrounding lines (context only):\n${l.context}`,
    '',
    'Question: did the agent mean this line as such a typed relation line (a relationship word followed by the link), whatever its punctuation?',
    'Answer "yes" only for a line written to state one typed relationship to the linked page. Answer "no" for prose, a list of links, a timeline entry, a citation or anything else.',
    'Reply with JSON: {"verdict": "yes" | "no"}',
  ].join('\n');
}

/**
 * Q2 G1 zero-tolerance classes, defined by this runner and independently of the parser under test.
 *
 * Five classes come from P5 H3 (line-grammar-junk-audit.ts itemClass and listLines): timecode, task marker, citation,
 * date and machine-written section. Q2 adds two:
 *   template_slot  a bracket token at the start of the item followed, in the same item, by a bare bracketed slot
 *                  (`- [Time] - [Event]`, `- [Name]: [Role]`) or by a separator (`- [Day] | ...`, `- [Time] - 9am`)
 *   usage_label    a bracket token from the published label list (parts of speech, register and region labels)
 * Exceptions, as the preregistration states: markdown links (`[label](url)`, `[label][ref]`, `![alt](src)`),
 * wikilinks (`[[x]]`), escaped brackets (`\[x]`) and inline code never count as a bracket token or a slot.
 * Nothing here imports gbrain: a guard in the build cannot change what the audit calls junk.
 */
import { itemClass, listLines, type ListLine } from '../line-grammar-junk-audit.ts';

/** The published usage-label list (Q2 plan, guard A4). Compared case-insensitively, with a trailing period allowed (`[adj.]`). */
export const PUBLISHED_USAGE_LABELS: readonly string[] = [
  'noun', 'verb', 'adj', 'adjective', 'adv', 'adverb', 'pron', 'pronoun', 'prep', 'preposition', 'conj', 'interj',
  'informal', 'formal', 'slang', 'colloquial', 'archaic', 'obsolete', 'dated', 'literary', 'figurative', 'vulgar',
  'offensive', 'dialect', 'regional', 'plural', 'singular', 'transitive', 'intransitive', 'abbr',
];
const USAGE = new Set(PUBLISHED_USAGE_LABELS);

export type Q2ZeroToleranceClass = 'timecode' | 'task_marker' | 'citation' | 'date' | 'machine_section' | 'template_slot' | 'usage_label';
export const Q2_ZERO_TOLERANCE_CLASSES: readonly Q2ZeroToleranceClass[] = ['timecode', 'task_marker', 'citation', 'date', 'machine_section', 'template_slot', 'usage_label'];

/** Inline code spans blanked to spaces (offsets kept), so code is never a token or a slot. */
export function blankInlineCode(s: string): string {
  return s.replace(/(`+)([\s\S]*?)\1/g, m => ' '.repeat(m.length));
}

/** Markdown links, images, wikilinks and escaped brackets blanked, leaving only bare brackets. */
export function blankLinks(s: string): string {
  return s
    .replace(/\\\[[^\]\n]*\]?/g, m => ' '.repeat(m.length))
    .replace(/\[\[[^\]\n]*\]\]/g, m => ' '.repeat(m.length))
    .replace(/!?\[[^\][\n]*\]\([^)\n]*\)/g, m => ' '.repeat(m.length))
    .replace(/!?\[[^\][\n]*\]\[[^\][\n]*\]/g, m => ' '.repeat(m.length));
}

const LEADING_TOKEN_RE = /^\[([A-Za-z][A-Za-z0-9 _./&'-]{0,40})\](?![([])/;
const BARE_SLOT_RE = /\[[A-Za-z][A-Za-z0-9 _./&'-]{0,40}\]/;
const SEPARATOR_RE = /^(?:[–—|=>]|[-/](?=\s|$))/;

/** The leading bracket token of a list item's content (not a link, wikilink, escape or code), or null. */
export function leadingBracketToken(content: string): { token: string; rest: string } | null {
  const c = blankLinks(blankInlineCode(content.trim()));
  const m = LEADING_TOKEN_RE.exec(c);
  if (!m) return null;
  return { token: m[1].trim(), rest: c.slice(m[0].length) };
}

/** template_slot or usage_label for a list item's content, else null. */
export function q2BracketClass(content: string): 'template_slot' | 'usage_label' | null {
  const lead = leadingBracketToken(content);
  if (!lead) return null;
  if (USAGE.has(lead.token.toLowerCase().replace(/\.$/, ''))) return 'usage_label';
  if (BARE_SLOT_RE.test(lead.rest) || SEPARATOR_RE.test(lead.rest.trim())) return 'template_slot';
  return null;
}

/** All seven classes for one item: H3's four item classes first, then the two Q2 classes. */
export function q2ItemClass(content: string): Q2ZeroToleranceClass | null {
  return itemClass(content) ?? q2BracketClass(content);
}

/** Every list line of a page with its Q2 zero-tolerance class (machine sections as H3 defines them). */
export function q2ListLines(text: string): Array<Omit<ListLine, 'zero_tolerance'> & { zero_tolerance: Q2ZeroToleranceClass | null }> {
  return listLines(text).map(l => ({ ...l, zero_tolerance: l.zero_tolerance ?? q2BracketClass(l.content) }));
}

/** List lines shaped like a template or a usage label, the stress stratum's floor (>= 2,000). */
export function templateOrLabelShaped(content: string): boolean {
  return q2BracketClass(content) !== null;
}

/**
 * The language-model matcher's frozen blocker (entity-dedupe head-to-head preregistration, "Language-model matcher").
 *
 * Two pages of the same type are a candidate pair when they share any blocking key:
 *   people     the surname (last word of the strict-folded title), the full strict-folded name, and any shared key
 *              the finder contract reads (email, LinkedIn, GitHub), normalised as eval/runner/person-dedupe.ts
 *              pageKeys normalises them;
 *   companies  the full strict-folded name, the company name core (the variant fold, which drops trailing legal
 *              suffixes), and any shared key (domain from `domain` or the `website` host, LinkedIn).
 * A person page and a company page are never a pair.
 *
 * Crowded keys: a key value held by more than MAX_BLOCK_PAGES (50) pages is DROPPED and makes no pairs, as the
 * 2026-11-17 smoke did; every dropped key is listed with its page count in the blocking record. At the development
 * seed (20261117, 20 per family) no key passes 50 pages, so nothing is dropped there: 21,574 pairs, reaching all but
 * 32 of the 972 designed pairs.
 */
import type { WrittenPage } from '../../generators/person-dedupe-gen.ts';
import { pageKeys, strictFold, variantFold } from '../person-dedupe.ts';

/** A key value shared by more than this many pages is dropped (see the header). */
export const MAX_BLOCK_PAGES = 50;
export const BLOCKER_ID = 'entity-h2h blocker v1: surname, full folded name, shared email/LinkedIn/GitHub/domain, company name core; keys on more than 50 pages dropped';

export function blockingKeys(p: WrittenPage): string[] {
  const name = strictFold(p.title);
  const keys = [`name:${name}`, p.type === 'person' ? `surname:${name.split(' ').at(-1)}` : `core:${variantFold(p.title, 'company')}`, ...pageKeys(p)];
  return [...new Set(keys.map(k => `${p.type}|${k}`))];
}

export const pairId = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface Blocking { blocker: string; max_block_pages: number; pairs: Array<[string, string]>; crowded: Array<{ key: string; pages: number }> }

/** Candidate pairs, sorted, each [a, b] with a < b. */
export function blockPairs(pages: readonly WrittenPage[]): Blocking {
  const blocks = new Map<string, string[]>();
  for (const p of pages) for (const k of blockingKeys(p)) blocks.set(k, [...(blocks.get(k) ?? []), p.key]);
  const seen = new Set<string>(), crowded: Blocking['crowded'] = [];
  for (const [key, members] of blocks) {
    if (members.length > MAX_BLOCK_PAGES) { crowded.push({ key, pages: members.length }); continue; }
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) if (members[i] !== members[j]) seen.add(pairId(members[i], members[j]));
  }
  const pairs = [...seen].sort().map(id => id.split('|') as [string, string]);
  return { blocker: BLOCKER_ID, max_block_pages: MAX_BLOCK_PAGES, pairs, crowded: crowded.sort((a, b) => b.pages - a.pages || (a.key < b.key ? -1 : 1)) };
}

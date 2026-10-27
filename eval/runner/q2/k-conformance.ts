/**
 * Q2 set K (G3, G4): conformance pages written to the published grammar, with decoys.
 *
 * Custody format, `k-pages.jsonl`, one page per line:
 *   { "id", "slug", "content", "lines": [{ "line", "class", "kind": "relation"|"fact", "expected": { "type"?, "category"?, "target"? } }] }
 * `line` is the 1-based line number in `content`, or the exact line text. The custodian mints candidates only; whether
 * a near-miss shape (colon_type, bold_type, backtick_type) is valid or a decoy is decided by the frozen build at run
 * time (`probeNearMiss`) and recorded in the receipt.
 *
 * Scoring (scoreK): a valid relation candidate is recalled when the build mints that line as a relation of the
 * expected type; a fact candidate when it mints a fact of the expected category (reported). Every decoy class must
 * mint 0 lines, exact.
 */
import { wilson } from './stats.ts';

export const K_VALID_CLASSES = ['relation', 'fact'] as const;
export const K_H2_DECOYS = ['prose_tail', 'two_links', 'multiword_unquoted_type', 'stoplist_type', 'machine_section', 'undeclared_type'] as const;
export const K_GUARD_DECOYS = ['template_slot', 'separator_claim', 'placeholder_claim', 'usage_label'] as const;
export const K_NEAR_MISS = ['colon_type', 'bold_type', 'backtick_type'] as const;
export type KClass = typeof K_VALID_CLASSES[number] | typeof K_H2_DECOYS[number] | typeof K_GUARD_DECOYS[number] | typeof K_NEAR_MISS[number];
export const K_CLASSES: readonly KClass[] = [...K_VALID_CLASSES, ...K_H2_DECOYS, ...K_GUARD_DECOYS, ...K_NEAR_MISS];
/** Candidate minimums from the preregistration's K table. */
export const K_MINIMUMS: Record<KClass, number> = Object.fromEntries(K_CLASSES.map(c => [c, c === 'relation' ? 400 : c === 'fact' ? 300 : 40])) as Record<KClass, number>;

export interface KLine { line: number | string; class: KClass; kind: 'relation' | 'fact'; expected: { type?: string; category?: string; target?: string } }
export interface KPage { id: string; slug: string; content: string; lines: KLine[] }

/** Parse and validate k-pages.jsonl; problems name the page and field so the custodian can fix the file. */
export function parseKPages(text: string): KPage[] {
  const pages: KPage[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    let p: KPage;
    try { p = JSON.parse(raw); } catch { problems.push(`line ${i + 1}: not JSON`); return; }
    if (typeof p.id !== 'string' || typeof p.slug !== 'string' || typeof p.content !== 'string' || !Array.isArray(p.lines)) { problems.push(`line ${i + 1}: needs id, slug, content and lines[]`); return; }
    const contentLines = p.content.split('\n');
    p.lines.forEach((l, j) => {
      const where = `page ${p.id} lines[${j}]`;
      if (!K_CLASSES.includes(l.class)) problems.push(`${where}: class ${l.class} is not one of ${K_CLASSES.join(', ')}`);
      if (l.kind !== 'relation' && l.kind !== 'fact') problems.push(`${where}: kind must be relation or fact`);
      if (typeof l.line === 'number' ? !(l.line >= 1 && l.line <= contentLines.length) : typeof l.line !== 'string' || !contentLines.some(c => c.trim() === (l.line as string).trim())) problems.push(`${where}: line must be a 1-based line number or the exact text of a line in content`);
      if (l.class === 'relation' && !l.expected?.type) problems.push(`${where}: a relation candidate needs expected.type`);
      if (l.class === 'fact' && !l.expected?.category) problems.push(`${where}: a fact candidate needs expected.category`);
    });
    pages.push(p);
  });
  if (problems.length) throw new Error(`k-pages.jsonl has ${problems.length} problem(s); ask the custodian to fix the file: ${problems.slice(0, 10).join('; ')}`);
  return pages;
}

/** Canonical probe lines for the near-miss shapes, written with a base-pack verb. */
export const NEAR_MISS_PROBES: Record<typeof K_NEAR_MISS[number], string> = {
  colon_type: '- works_at: [[companies/acme-example]]',
  bold_type: '- **works_at** [[companies/acme-example]]',
  backtick_type: '- `works_at` [[companies/acme-example]]',
};

/** Which near-miss shapes the build accepts as a works_at relation line (the valid/decoy label for G3). */
export function probeNearMiss(parse: (text: string) => { relations: Array<{ type: string }> }): Record<typeof K_NEAR_MISS[number], boolean> {
  return Object.fromEntries(K_NEAR_MISS.map(c => {
    const r = parse(`---\ntype: person\ntitle: Probe\n---\n\n${NEAR_MISS_PROBES[c]}\n`).relations;
    return [c, r.length === 1 && r[0].type === 'works_at'];
  })) as Record<typeof K_NEAR_MISS[number], boolean>;
}

/** A minted line as the mint pass records it: page id, line text and what the build read. */
export interface KMint { doc: string; text: string; kind: 'relation' | 'fact'; parsed: string }

const parsedType = (parsed: string) => /^relation type (\S+)/.exec(parsed)?.[1] ?? null;
const parsedCategory = (parsed: string) => /^fact category (\S+)/.exec(parsed)?.[1] ?? null;

/** Pair each candidate with the minted line of the same text on its page (occurrences matched in order). */
export function matchCandidates(page: KPage, mints: readonly KMint[]): Array<{ candidate: KLine; text: string; mint: KMint | null }> {
  const contentLines = page.content.split('\n');
  const pool = mints.filter(m => m.doc === page.id).map(m => ({ m, used: false }));
  return page.lines.map(candidate => {
    const text = (typeof candidate.line === 'number' ? contentLines[candidate.line - 1] : candidate.line).trim();
    const hit = pool.find(x => !x.used && x.m.text.trim() === text);
    if (hit) hit.used = true;
    return { candidate, text, mint: hit?.m ?? null };
  });
}

export interface KScore {
  near_miss_accepted: Record<string, boolean>;
  candidates_by_class: Record<string, number>;
  minted_by_class: Record<string, number>;
  relation: { valid: number; recalled: number; recall: number | null; wilson_lower: number; wilson_upper: number; minted_wrong_type: number };
  fact: { valid: number; recalled: number; recall: number | null };
  decoys: Record<string, { candidates: number; minted: number }>;
  below_minimum: string[];
  /** Minted lines on K pages that match no candidate (reported; they still count for G4). */
  unlisted_mints: number;
}

export function scoreK(pages: readonly KPage[], mints: readonly KMint[], accepted: Record<typeof K_NEAR_MISS[number], boolean>): KScore {
  const byClass: Record<string, number> = {};
  const mintedByClass: Record<string, number> = {};
  const decoys: Record<string, { candidates: number; minted: number }> = {};
  let relValid = 0, relHit = 0, relWrongType = 0, factValid = 0, factHit = 0, matched = 0;
  for (const page of pages) {
    for (const { candidate, mint } of matchCandidates(page, mints)) {
      byClass[candidate.class] = (byClass[candidate.class] ?? 0) + 1;
      if (mint) { mintedByClass[candidate.class] = (mintedByClass[candidate.class] ?? 0) + 1; matched++; }
      const nearMissValid = (K_NEAR_MISS as readonly string[]).includes(candidate.class) && accepted[candidate.class as typeof K_NEAR_MISS[number]];
      if (candidate.class === 'relation' || nearMissValid) {
        relValid++;
        const type = mint?.kind === 'relation' ? parsedType(mint.parsed) : null;
        if (type !== null && type === (candidate.expected.type ?? 'works_at')) relHit++;
        else if (type !== null) relWrongType++;
      } else if (candidate.class === 'fact') {
        factValid++;
        if (mint?.kind === 'fact' && parsedCategory(mint.parsed)?.toLowerCase() === candidate.expected.category?.toLowerCase()) factHit++;
      } else {
        const d = (decoys[candidate.class] ??= { candidates: 0, minted: 0 });
        d.candidates++;
        if (mint) d.minted++;
      }
    }
  }
  const w = wilson(relHit, relValid);
  const pageIds = new Set(pages.map(p => p.id));
  return {
    near_miss_accepted: accepted, candidates_by_class: byClass, minted_by_class: mintedByClass,
    relation: { valid: relValid, recalled: relHit, recall: relValid ? relHit / relValid : null, wilson_lower: w.lower, wilson_upper: w.upper, minted_wrong_type: relWrongType },
    fact: { valid: factValid, recalled: factHit, recall: factValid ? factHit / factValid : null },
    decoys,
    below_minimum: K_CLASSES.filter(c => (byClass[c] ?? 0) < K_MINIMUMS[c]).map(c => `${c}: ${byClass[c] ?? 0} < ${K_MINIMUMS[c]}`),
    unlisted_mints: mints.filter(m => pageIds.has(m.doc)).length - matched,
  };
}

/**
 * A small development K set (generic placeholders, dev only) covering every class, so the dev pilot and the tests
 * exercise the scorer. It is not the custodian's set and is never used for a gate.
 */
export function devKPages(): KPage[] {
  const people = ['alice', 'bob', 'carol', 'dave'];
  const pages: KPage[] = [];
  people.forEach((p, i) => {
    const lines: Array<[string, KLine['class'], 'relation' | 'fact', KLine['expected']]> = [
      [`- works_at [[companies/acme-example]]`, 'relation', 'relation', { type: 'works_at', target: 'companies/acme-example' }],
      [`- advises @effective[2024-01-01,) [[companies/globex-example]]`, 'relation', 'relation', { type: 'advises', target: 'companies/globex-example' }],
      [`- invested_in [[companies/initech-example]] (seed round)`, 'relation', 'relation', { type: 'invested_in', target: 'companies/initech-example' }],
      [`- [preference] Prefers morning meetings #work`, 'fact', 'fact', { category: 'preference' }],
      [`- [fact] Office temperature was -4 degrees in January`, 'fact', 'fact', { category: 'fact' }],
      [`- [event] Spoke at the [summit](https://example.com/summit) in May`, 'fact', 'fact', { category: 'event' }],
      [`- works_at [[companies/acme-example]] since the merger last spring`, 'prose_tail', 'relation', {}],
      [`- works_at [[companies/acme-example]] and [[companies/globex-example]]`, 'two_links', 'relation', {}],
      [`- used to work at [[companies/hooli-example]]`, 'multiword_unquoted_type', 'relation', {}],
      [`- see [[companies/hooli-example]]`, 'stoplist_type', 'relation', {}],
      [`- board_member [[companies/hooli-example]]`, 'undeclared_type', 'relation', {}],
      [`- [Time] - [Event]`, 'template_slot', 'fact', {}],
      [`- [Day] | Notes`, 'separator_claim', 'fact', {}],
      [`- [idea] TBD`, 'placeholder_claim', 'fact', {}],
      [`- [informal] a casual word`, 'usage_label', 'fact', {}],
      [`- works_at: [[companies/acme-example]]`, 'colon_type', 'relation', { type: 'works_at' }],
      [`- **works_at** [[companies/acme-example]]`, 'bold_type', 'relation', { type: 'works_at' }],
      ['- `works_at` [[companies/acme-example]]', 'backtick_type', 'relation', { type: 'works_at' }],
    ];
    const body = lines.map(l => l[0]);
    const content = `---\ntype: person\ntitle: ${p[0].toUpperCase()}${p.slice(1)} Example\n---\n\n# ${p} example\n\n## Roles\n\n${body.join('\n')}\n\n## Timeline\n\n- works_at [[companies/umbrella-example]]\n`;
    const all = content.split('\n');
    pages.push({
      id: `dev-k-${i + 1}`, slug: `people/${p}-${i + 1}-example`, content,
      lines: [...lines.map(([text, cls, kind, expected]) => ({ line: all.indexOf(text) + 1, class: cls, kind, expected })),
        { line: all.lastIndexOf('- works_at [[companies/umbrella-example]]') + 1, class: 'machine_section' as const, kind: 'relation' as const, expected: {} }],
    });
  });
  return pages;
}

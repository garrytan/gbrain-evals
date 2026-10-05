/**
 * P5 H2: a world-v1 variant in which some person pages state their
 * relationships only as typed relation lines.
 *
 * For a seeded half of the person pages, every outgoing gold relationship to
 * a company (founded, works_at, invested_in, advises; from world-v1-gold.ts
 * buildGoldEdges) is rendered as one relation line, for example
 *
 *   - works_at [[companies/forge-19]]
 *
 * and every sentence or timeline line that links that company is removed, so
 * the line is the only statement of the relationship (with `keepProse` the
 * prose stays: a control in which inference alone can type the edge).
 *
 * Each converted page also carries one decoy line that a strict grammar must
 * not read as a relation, pointing at a company the person has no gold
 * relationship with and no other link to:
 *   prose_tail       text after the link
 *   two_links        two links on one line
 *   multi_word       a multi-word type without quotes
 *   stoplist         a stoplisted word as the type
 *   machine_section  a well-formed line inside a machine-written section (Related, See also, ...)
 *   undeclared       a verb the schema pack does not declare
 * The decoy's stated type is recorded so the runner can check whether that
 * type reached the graph.
 *
 * Templates: only development set A lives here. A held-out template set is
 * authored and frozen by the custodian outside the repository and reaches
 * this module only as a template object the custodian's run loads from
 * custody (`sealedTemplates`). A template set name other than "A" is refused.
 */
import { Rng, fingerprint } from './seeded.ts';
import { buildGoldEdges, type GoldEdge, type RichPage } from '../runner/world-v1-gold.ts';

export const RELATION_LINE_VARIANTS_GENERATOR_VERSION = 'relation-line-variants-gen/1';
export const DEV_SEEDS: readonly number[] = [1, 2, 3];
export const TEMPLATE_SETS = ['A'] as const;
export const RELATION_TYPES = ['founded', 'works_at', 'invested_in', 'advises'] as const;
export const DECOY_KINDS = ['prose_tail', 'two_links', 'multi_word', 'stoplist', 'machine_section', 'undeclared'] as const;
export type DecoyKind = typeof DECOY_KINDS[number];

/**
 * Placeholders: {type} a relation type, {slug} and {slug2} target slugs,
 * {words} a multi-word type, {stop} a stoplisted word, {verb} an undeclared verb.
 */
export interface RelationLineTemplates {
  relation: string;
  /** Heading line above the relation lines, or '' for none. Never a machine-written section name. */
  relation_heading: string;
  decoy_prose_tail: string;
  decoy_two_links: string;
  decoy_multi_word: string;
  decoy_stoplist: string;
  /** A heading of a machine-written section, a blank line, then a relation line. */
  decoy_machine_section: string;
  decoy_undeclared: string;
  multi_word_types: string[];
  stop_words: string[];
  undeclared_verbs: string[];
  /** Declared types stated on the prose_tail, two_links and machine_section decoys. */
  decoy_types: string[];
}

export const TEMPLATES_A: RelationLineTemplates = {
  relation: '- {type} [[{slug}]]',
  relation_heading: '',
  decoy_prose_tail: '- {type} [[{slug}]] after the spring offsite',
  decoy_two_links: '- {type} [[{slug}]] [[{slug2}]]',
  decoy_multi_word: '- {words} [[{slug}]]',
  decoy_stoplist: '- {stop} [[{slug}]]',
  decoy_machine_section: '## Related\n\n- {type} [[{slug}]]',
  decoy_undeclared: '- {verb} [[{slug}]]',
  multi_word_types: ['board member', 'angel investor'],
  stop_words: ['see', 'via'],
  undeclared_verbs: ['partnered_with', 'sponsors'],
  decoy_types: ['invested_in', 'advises'],
};
const DEV_TEMPLATES: Record<(typeof TEMPLATE_SETS)[number], RelationLineTemplates> = { A: TEMPLATES_A };

const MACHINE_HEADING_RE = /^#{1,6}[ \t]+(?:timeline|see[ -]also|related|facts|sources|links|email mention links|backlinks|significant moments)\b/im;
const STRING_KEYS = ['relation', 'relation_heading', 'decoy_prose_tail', 'decoy_two_links', 'decoy_multi_word', 'decoy_stoplist', 'decoy_machine_section', 'decoy_undeclared'] as const;
const LIST_KEYS = ['multi_word_types', 'stop_words', 'undeclared_verbs', 'decoy_types'] as const;

export function validateTemplates(t: unknown): RelationLineTemplates {
  const o = t as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of STRING_KEYS) if (typeof o?.[k] !== 'string' || (k !== 'relation_heading' && !(o[k] as string).trim())) problems.push(`${k} must be a nonempty string`);
  for (const k of LIST_KEYS) if (!Array.isArray(o?.[k]) || !(o[k] as unknown[]).length || (o[k] as unknown[]).some(x => typeof x !== 'string' || !x.trim())) problems.push(`${k} must be a nonempty list of strings`);
  if (problems.length) throw new Error(`relation-line templates: ${problems.join('; ')}`);
  const need: Array<[keyof RelationLineTemplates, string[]]> = [
    ['relation', ['{type}', '[[{slug}]]']], ['decoy_prose_tail', ['{type}', '[[{slug}]]']], ['decoy_two_links', ['{type}', '[[{slug}]]', '[[{slug2}]]']],
    ['decoy_multi_word', ['{words}', '[[{slug}]]']], ['decoy_stoplist', ['{stop}', '[[{slug}]]']], ['decoy_machine_section', ['{type}', '[[{slug}]]']],
    ['decoy_undeclared', ['{verb}', '[[{slug}]]']],
  ];
  for (const [k, parts] of need) for (const part of parts) if (!(o[k] as string).includes(part)) problems.push(`${k} must contain ${part}`);
  if (!MACHINE_HEADING_RE.test(o.decoy_machine_section as string)) problems.push('decoy_machine_section must open a machine-written section (Related, See also, Sources, ...)');
  if ((o.relation_heading as string) && MACHINE_HEADING_RE.test(o.relation_heading as string)) problems.push('relation_heading must not be a machine-written section, or no line under it is read');
  if ((o.multi_word_types as string[]).some(w => !/\s/.test(w.trim()))) problems.push('multi_word_types must each have two or more words');
  if (problems.length) throw new Error(`relation-line templates: ${problems.join('; ')}`);
  return o as unknown as RelationLineTemplates;
}

/** gbrain's normalization of a written relation type (line-grammar normalizeRelationType). */
export function normalizeRelationType(raw: string): string {
  return raw.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(type|slug|slug2|words|stop|verb)\}/g, (_, k: string) => v[k] ?? '');

export interface RenderedRelationLine { id: string; from: string; to: string; type: string; text: string }
export interface DecoyLine { id: string; from: string; kind: DecoyKind; targets: string[]; stated_type: string; text: string }
export interface RlvPage { slug: string; type: RichPage['type']; title: string; compiled_truth: string; timeline: string }
export interface RelationLineWorld {
  seed: number;
  templates: string;
  keep_prose: boolean;
  converted: string[];
  pages: RlvPage[];
  lines: RenderedRelationLine[];
  decoys: DecoyLine[];
  fingerprint: string;
}

const linkRe = (slug: string) => new RegExp(`\\]\\((?:\\.\\./)?${slug.replace(/[/.-]/g, m => `\\${m}`)}(?:\\.md)?\\)|\\[\\[${slug.replace(/[/.-]/g, m => `\\${m}`)}(?:\\|[^\\]]*)?\\]\\]`);

/** Remove every sentence (compiled truth) and line (timeline) that links `slug`. */
export function dropStatementsLinking(page: Pick<RichPage, 'compiled_truth' | 'timeline'>, slug: string): { compiled_truth: string; timeline: string } {
  const re = linkRe(slug);
  const compiled_truth = page.compiled_truth.split(/\n{2,}/).map(par => par.split(/(?<=[.!?])\s+(?=[A-Z[])/).filter(s => !re.test(s)).join(' '))
    .filter(par => par.trim()).join('\n\n');
  const timeline = page.timeline.split('\n').filter(l => !re.test(l)).join('\n');
  return { compiled_truth, timeline };
}

export function linksTo(text: string, slug: string): boolean {
  return linkRe(slug).test(text);
}

export function generateRelationLineWorld(opts: {
  seed: number; corpus: readonly RichPage[]; templates?: string; sealedTemplates?: { id: string; templates: RelationLineTemplates }; keepProse?: boolean;
}): RelationLineWorld {
  if (opts.templates !== undefined && !(TEMPLATE_SETS as readonly string[]).includes(opts.templates)) {
    throw new Error(`template set ${opts.templates} is held out: only the custodian's run renders it, from a --phrasing-file in custody`);
  }
  const t = opts.sealedTemplates ? validateTemplates(opts.sealedTemplates.templates) : DEV_TEMPLATES[(opts.templates ?? 'A') as (typeof TEMPLATE_SETS)[number]];
  const templates = opts.sealedTemplates ? `sealed:${opts.sealedTemplates.id}` : (opts.templates ?? 'A');
  const keepProse = opts.keepProse ?? false;
  const rng = new Rng(opts.seed * 104_729 + 7);
  const gold = buildGoldEdges([...opts.corpus]);
  const companies = opts.corpus.filter(p => p.slug.startsWith('companies/')).map(p => p.slug).sort();
  const people = opts.corpus.filter(p => p._facts.type === 'person').map(p => p.slug).sort();
  const converted = rng.shuffle(people).slice(0, Math.floor(people.length / 2)).sort();
  const decoyOrder = rng.shuffle(converted);
  const kindOf = new Map(decoyOrder.map((slug, i) => [slug, DECOY_KINDS[i % DECOY_KINDS.length]]));

  const lines: RenderedRelationLine[] = [];
  const decoys: DecoyLine[] = [];
  const pages: RlvPage[] = opts.corpus.map(p => {
    const base = { slug: p.slug, type: p.type, title: p.title, compiled_truth: p.compiled_truth, timeline: p.timeline };
    if (!converted.includes(p.slug)) return base;
    const rels = gold.filter((e: GoldEdge) => e.from === p.slug && e.to.startsWith('companies/') && (RELATION_TYPES as readonly string[]).includes(e.type))
      .sort((a, b) => a.to.localeCompare(b.to));
    let body = { compiled_truth: p.compiled_truth, timeline: p.timeline };
    if (!keepProse) {
      for (const r of rels) body = dropStatementsLinking(body, r.to);
      const left = rels.filter(r => linksTo(`${body.compiled_truth}\n${body.timeline}`, r.to));
      if (left.length) throw new Error(`${p.slug}: prose still links ${left.map(r => r.to).join(', ')} after removal`);
    }
    const relLines = rels.map(r => {
      const text = fill(t.relation, { type: r.type, slug: r.to });
      lines.push({ id: `s${opts.seed}:line:${p.slug}->${r.to}`, from: p.slug, to: r.to, type: r.type, text });
      return text;
    });
    const unrelated = companies.filter(c => !gold.some(e => e.from === p.slug && e.to === c) && !linksTo(`${p.compiled_truth}\n${p.timeline}`, c));
    const kind = kindOf.get(p.slug)!;
    const [a, b] = rng.shuffle(unrelated);
    const declared = rng.pick(t.decoy_types);
    const decoy = ((): Omit<DecoyLine, 'id' | 'from' | 'kind'> => {
      switch (kind) {
        case 'prose_tail': return { targets: [a], stated_type: normalizeRelationType(declared), text: fill(t.decoy_prose_tail, { type: declared, slug: a }) };
        case 'two_links': return { targets: [a, b], stated_type: normalizeRelationType(declared), text: fill(t.decoy_two_links, { type: declared, slug: a, slug2: b }) };
        case 'multi_word': { const words = rng.pick(t.multi_word_types); return { targets: [a], stated_type: normalizeRelationType(words), text: fill(t.decoy_multi_word, { words, slug: a }) }; }
        case 'stoplist': { const stop = rng.pick(t.stop_words); return { targets: [a], stated_type: normalizeRelationType(stop), text: fill(t.decoy_stoplist, { stop, slug: a }) }; }
        case 'machine_section': return { targets: [a], stated_type: normalizeRelationType(declared), text: fill(t.decoy_machine_section, { type: declared, slug: a }) };
        case 'undeclared': { const verb = rng.pick(t.undeclared_verbs); return { targets: [a], stated_type: normalizeRelationType(verb), text: fill(t.decoy_undeclared, { verb, slug: a }) }; }
      }
    })();
    decoys.push({ id: `s${opts.seed}:decoy:${kind}:${p.slug}`, from: p.slug, kind, ...decoy });
    const listed = kind === 'machine_section' ? relLines : [...relLines, decoy.text];
    const block = [t.relation_heading ? `${t.relation_heading}\n\n${listed.join('\n')}` : listed.join('\n'), kind === 'machine_section' ? decoy.text : '']
      .filter(Boolean).join('\n\n');
    return { ...base, compiled_truth: [body.compiled_truth.trim(), block].filter(Boolean).join('\n\n'), timeline: body.timeline };
  });
  const world = { seed: opts.seed, templates, keep_prose: keepProse, converted, pages, lines, decoys };
  return { ...world, fingerprint: fingerprint({ v: RELATION_LINE_VARIANTS_GENERATOR_VERSION, ...world }) };
}

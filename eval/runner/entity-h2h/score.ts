/**
 * Scores one neutral output of the entity-dedupe head-to-head with the person-dedupe scorer (scoreGroups in
 * eval/runner/person-dedupe.ts): groups closed transitively, the false-merge rate over the designed must-not-link
 * pairs with a Wilson 95% interval, designed recall, pairwise precision and recall over every page pair, B-cubed, false
 * merges anywhere and per-family counts, separately for people and for companies (closure always runs over every
 * group, so a chain through a page of the other type still counts), plus the two together.
 *
 * Neutral output, the one shape every system writes:
 *   { "system", "version", "config", "model": "<provider:model>" | null,
 *     "tiers": { "auto": [[pageKey, ...], ...], "proposed": [[pageKey, ...], ...] } }
 * `auto` holds what the system links automatically; `proposed` holds what it only proposes for review (empty for a
 * system with no review tier). Groups may overlap: a pairwise system lists one group per accepted pair. Two operating
 * points are scored: auto alone, and proposed (auto plus proposed, closed together).
 *
 * Candidates: a system that only compares the pairs its blocker produced (the matcher) passes them, and each designed
 * pair the blocker never reached is counted as "not a candidate". Those pairs stay in every denominator and are scored
 * from the closed groups like any other: an unreached must-link pair counts against recall unless closure joins it.
 */
import type { DesignedPair } from '../../generators/person-dedupe-gen.ts';
import { scoreGroups, type Group, type Score } from '../person-dedupe.ts';
import { pairId } from './blocker.ts';
import type { H2hWorld } from './world.ts';

export const OPERATING_POINTS = ['auto', 'proposed'] as const;
export type OperatingPoint = typeof OPERATING_POINTS[number];

export interface NeutralOutput { system: string; version: string; config: string; model: string | null; tiers: { auto: string[][]; proposed: string[][] } }

const fail = (msg: string): never => { throw new Error(`entity-h2h: ${msg}`); };

/** Checks an output against the world's page keys. Throws on anything the scorer cannot read exactly. */
export function parseOutput(raw: unknown, known: ReadonlySet<string>): NeutralOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('output is not an object');
  const o = raw as NeutralOutput;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'config,model,system,tiers,version') fail(`output has keys ${keys}, expected config,model,system,tiers,version`);
  for (const f of ['system', 'version', 'config'] as const) if (typeof o[f] !== 'string' || !o[f]) fail(`${f} must be a non-empty string`);
  if (o.model !== null && (typeof o.model !== 'string' || !o.model)) fail('model must be a non-empty string or null');
  if (!o.tiers || typeof o.tiers !== 'object' || Object.keys(o.tiers).sort().join(',') !== 'auto,proposed') fail('tiers must be exactly auto and proposed');
  for (const tier of OPERATING_POINTS) {
    if (!Array.isArray(o.tiers[tier])) fail(`tiers.${tier} is not a list`);
    for (const g of o.tiers[tier]) {
      if (!Array.isArray(g) || g.some(k => typeof k !== 'string')) fail(`tiers.${tier} holds a group that is not a list of page keys`);
      for (const k of g) if (!known.has(k)) fail(`tiers.${tier} names ${k}, which the world does not have`);
    }
  }
  return o;
}

export interface NotCandidate { must_link: number; must_not_link: number }
export interface TypeScore { false_merge: Score['false_merge']; designed_recall: Score['designed_recall']; precision: Score['precision']; recall: Score['recall']; b3: Score['b3']; false_merges_anywhere: number; by_family: Score['by_family']; false_merge_cases: Score['false_merge_cases'] }
export interface PointScore { groups: number; person: TypeScore; company: TypeScore; all: TypeScore; cross_type_merges: number }
export interface OutputScore {
  system: string; version: string; config: string; model: string | null;
  points: Record<OperatingPoint, PointScore>;
  /** Designed pairs the system's blocker never reached (null when the system has no blocker). */
  not_a_candidate: { person: NotCandidate; company: NotCandidate; pairs: Array<{ a: string; b: string; family: string; label: string }> } | null;
  /** Pages the readout could not map to an entity (memory systems; null when the system reads pages directly). */
  unresolved: number | null;
}

const brief = (s: Score): TypeScore => ({ false_merge: s.false_merge, designed_recall: s.designed_recall, precision: s.precision, recall: s.recall, b3: s.b3, false_merges_anywhere: s.false_merges_anywhere, by_family: s.by_family, false_merge_cases: s.false_merge_cases });

export function scoreOutput(w: H2hWorld, out: NeutralOutput, opts: { candidates?: ReadonlySet<string>; unresolved?: readonly string[] } = {}): OutputScore {
  const toGroups = (gs: string[][], cls: string): Group[] => gs.map(g => [...new Set(g)].sort()).filter(m => m.length > 1).map(members => ({ members, kind: 'cross_source', class: cls, rules: [out.system] }));
  const isPerson = (p: DesignedPair) => w.people_gold.has(p.a);
  const personPairs = w.pairs.filter(isPerson), companyPairs = w.pairs.filter(p => !isPerson(p));
  const point = (groups: Group[]): PointScore => {
    const part = (gold: ReadonlyMap<string, string>, pairs: DesignedPair[]) => scoreGroups(groups.filter(g => g.members.some(m => gold.has(m))), pairs, gold, groups);
    const all = scoreGroups(groups, w.pairs, w.gold), person = part(w.people_gold, personPairs), company = part(w.company_gold, companyPairs);
    return { groups: groups.length, person: brief(person), company: brief(company), all: brief(all), cross_type_merges: all.false_merges_anywhere - person.false_merges_anywhere - company.false_merges_anywhere };
  };
  const auto = toGroups(out.tiers.auto, 'clean');
  let not_a_candidate: OutputScore['not_a_candidate'] = null;
  if (opts.candidates) {
    const missed = w.pairs.filter(p => !opts.candidates!.has(pairId(p.a, p.b)));
    const count = (ps: DesignedPair[]) => ({ must_link: ps.filter(p => p.label === 'same').length, must_not_link: ps.filter(p => p.label === 'different').length });
    not_a_candidate = { person: count(missed.filter(isPerson)), company: count(missed.filter(p => !isPerson(p))), pairs: missed.map(p => ({ a: p.a, b: p.b, family: p.family, label: p.label })) };
  }
  return {
    system: out.system, version: out.version, config: out.config, model: out.model,
    points: { auto: point(auto), proposed: point([...auto, ...toGroups(out.tiers.proposed, 'likely')]) },
    not_a_candidate, unresolved: opts.unresolved ? opts.unresolved.length : null,
  };
}

const pct = (r: { k: number; n: number; rate: number | null; ci95: [number, number] | null }) => r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(1)}% (${r.k}/${r.n}; 95% CI ${(r.ci95![0] * 100).toFixed(1)} to ${(r.ci95![1] * 100).toFixed(1)}%)`;

/** One Markdown table row per output, operating point and entity type. */
export function scoreTable(scores: readonly OutputScore[]): string {
  const lines = [
    '| system | config | model | point | type | false-merge rate (designed must-not-link) | recall (designed must-link) | precision (all pairs) | recall (all pairs) | B-cubed F1 | not a candidate (must-link / must-not-link) | unresolved |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of scores) for (const p of OPERATING_POINTS) for (const t of ['person', 'company'] as const) {
    const x = s.points[p][t];
    const nc = s.not_a_candidate ? `${s.not_a_candidate[t].must_link} / ${s.not_a_candidate[t].must_not_link}` : 'n/a';
    lines.push(`| ${s.system} ${s.version} | ${s.config} | ${s.model ?? 'none'} | ${p} | ${t} | ${pct(x.false_merge)} | ${pct(x.designed_recall)} | ${pct(x.precision)} | ${pct(x.recall)} | ${x.b3.f1.toFixed(3)} | ${nc} | ${s.unresolved ?? 'n/a'} |`);
  }
  return lines.join('\n');
}

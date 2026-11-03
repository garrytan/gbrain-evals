/**
 * fact-check task set for skillopt-method-v2 (GST-799), the one hardening
 * round after probe 1 found v1 saturated. The account claims now need the
 * data-derived-claims gate to check the record in force on the claim's date
 * and every part of a claim; the world-v1 claims and negative controls are v1's
 * (fact-check.ts, `worldClaimDrafts`). Families:
 *
 *   superseded             an account attribute as of a date, stated with the
 *                          value of a record the governing one superseded; the
 *                          report must say it is contradicted, state the
 *                          governing value and cite the governing page
 *   compound-supported     two attribute values for one account as of one
 *                          date, both right; the report cites each governing
 *                          page
 *   compound-contradicted  the same with one part wrong (a superseded value
 *                          where the account has one, else a nearby value no
 *                          record holds); the report must state both governing
 *                          values and cite each governing page
 *   founder-supported      "P founded C" where P is C's founder
 *   not-founder            "P founded C" where P is only an investor,
 *                          employee or advisor of C (affiliation, not
 *                          authorship)
 *   negative               a claim naming an invented or look-alike person or
 *                          an invented company
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import { Rng } from '../seeded.ts';
import {
  type Corpus, type Draft, type GovFact, type SkillGeneration, assembleGrouped, governingRows, govBase, govPairs, longDate, loadCorpora, pairBase, perturbedValue,
  possessive, supersededFacts, supersededRow,
} from './common.ts';
import { report, taskText, worldClaimDrafts } from './fact-check.ts';

export const FACT_CHECK_V2_SEED = 15_013;
export const FACT_CHECK_V2_QUOTAS = {
  superseded: [6, 6, 9],
  'compound-supported': [3, 3, 4],
  'compound-contradicted': [3, 3, 5],
  'founder-supported': [3, 3, 5],
  'not-founder': [5, 5, 7],
  negative: [4, 4, 6],
} as const;

/** Recorded in the generation report: why the families and quotas are what they are. */
export const FACT_CHECK_V2_NOTES = [
  'Compound claims are two families, so the supported and contradicted shares are fixed (10 and 11 tasks) instead of falling out of the assembly.',
  'founder-supported stays from v1 at 3/3/5 beside not-founder: without supported world claims, a report that never says VERIFIED would fail only the compound-supported tasks.',
  'superseded takes 6/6/9: the 11 later records it draws on also govern one side of every compound claim that crosses two records, and both families must fit three tasks per group.',
];

const statement = (f: GovFact, v: number | string) => `${possessive(f.account)} ${f.attribute.phrase} is ${f.attribute.format(v)}`;

export function factCheckV2Drafts(corpus: Corpus, rng: Rng): Draft[] {
  const drafts: Draft[] = [];
  for (const r of supersededFacts(corpus)) {
    if (!r.ok) { drafts.push({ ok: false, family: 'superseded', anchor: r.row.id, reason: r.reason }); continue; }
    const { fact: f, prev, prevEvidence } = r.s;
    const base = govBase(f);
    const claim = `As of ${longDate(f.row.as_of)}, ${statement(f, prev.value)}.`;
    drafts.push({ ok: true, priority: f.row.traps.length, candidate: {
      family: 'superseded',
      task: taskText(claim),
      ...base,
      anchor: { kind: 'record', id: f.row.id },
      answerable: true,
      gold: { values: [f.attribute.gold(f.row.value)], slugs: [f.row.governing_slug], status: 'contradicted' },
      distractors: {
        slugs: [...new Set([prev.governing_slug, ...f.row.distractor_slugs])].filter(x => x !== f.row.governing_slug),
        values: [f.attribute.gold(prev.value), ...f.others.filter(v => String(v.value) !== String(prev.value))],
      },
      oracle: {
        path: `${base.oracle.path}; the claimed value reads out of the superseded record's own deciding paragraph on ${prev.governing_slug}, and the labels put that record in force from ${prev.effective}, before the governing record (${f.row.effective})`,
        evidence: `${f.evidence}\n\nsuperseded: ${prevEvidence}`,
      },
      oracle_answer: report(claim, 'FALSE', `${f.row.governing_slug}: "${f.evidence}"`),
    } });
  }

  const rows = governingRows();
  for (const r of govPairs(corpus)) {
    if (!r.ok) {
      for (const family of ['compound-supported', 'compound-contradicted']) drafts.push({ ok: false, family, anchor: r.anchor, reason: r.reason });
      continue;
    }
    const { a, b } = r;
    const { pages, base } = pairBase(a, b);
    const priority = a.row.traps.length + b.row.traps.length + 2 * (pages.length - 1);
    const cite = pages.map(p => [p]);
    const sources = pages.map(p => `${p}: ${[a, b].filter(f => f.row.governing_slug === p).map(f => `"${f.evidence}"`).filter((x, i, xs) => xs.indexOf(x) === i).join(' ')}`).join('; ');
    const claimOf = (va: number | string, vb: number | string) => `As of ${longDate(a.row.as_of)}, ${statement(a, va)} and its ${b.attribute.phrase} is ${b.attribute.format(vb)}.`;
    const right = claimOf(a.row.value, b.row.value);
    drafts.push({ ok: true, priority, candidate: {
      family: 'compound-supported',
      task: taskText(right),
      ...base,
      answerable: true,
      gold: { values: [], slugs: pages, cite, status: 'supported' },
      oracle_answer: report(right, '✅ VERIFIED', sources),
    } });

    const stale = [a, b].map(f => supersededRow(rows, f.row)?.value ?? null);
    const part = stale[0] !== null ? 0 : stale[1] !== null ? 1 : rng.int(0, 1);
    const wrongValue = stale[part] ?? perturbedValue(part === 0 ? a : b, rng);
    if (wrongValue === null) { drafts.push({ ok: false, family: 'compound-contradicted', anchor: base.anchor.id, reason: 'no wrong value differs from every recorded value and the governing paragraph' }); continue; }
    const wrong = part === 0 ? claimOf(wrongValue, b.row.value) : claimOf(a.row.value, wrongValue);
    drafts.push({ ok: true, priority: priority + (stale[part] !== null ? 2 : 0), candidate: {
      family: 'compound-contradicted',
      task: taskText(wrong),
      ...base,
      answerable: true,
      gold: { values: [a.attribute.gold(a.row.value), b.attribute.gold(b.row.value)], slugs: pages, cite, status: 'contradicted' },
      oracle_answer: report(wrong, 'FALSE', sources),
    } });
  }

  drafts.push(...worldClaimDrafts(corpus, rng));
  return drafts;
}

export function generateFactCheckV2(): SkillGeneration {
  return assembleGrouped('fact-check', FACT_CHECK_V2_SEED, factCheckV2Drafts(loadCorpora(), new Rng(FACT_CHECK_V2_SEED)), FACT_CHECK_V2_QUOTAS, { notes: FACT_CHECK_V2_NOTES });
}

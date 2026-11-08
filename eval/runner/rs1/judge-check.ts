/**
 * RS1's judge check (R78 point 1 as GBEV-3 amended it on 2026-11-08: "Use Astra vs opus"; the R78 amendment of
 * docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md): are gpt-6-astra and claude-opus-5-5 good enough to gate
 * the verdict, checked on public data only before any counted run.
 *
 *   bun eval/runner/rs1/judge-check.ts plan   --stage1 <stage 1 out dir>... --out <dir> [--seed <n>]
 *   bun eval/runner/rs1/judge-check.ts run    --stage1 <dir>... --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n>
 *                                             --ledger-cap-usd <n> [--seed <n>] [--keyless-upstream <url>]
 *   bun eval/runner/rs1/judge-check.ts report --out <dir> [--publish <dir>]
 *
 *   Pool      (a) real answers: stage 1's scored answers (set RS1-dev2), stratified by row, reader and stage 1's bridge
 *             outcome (fail, partial, pass); (b) BEAM gold answers of the public BEAM-1M dev conversations whose every
 *             rubric item's content appears in the gold (the gold screen; every exclusion is recorded); (c) scripted
 *             corruptions of screened gold, each aimed at one named rubric item. Most leave a confident, plausible wrong
 *             fact in the item's place: a number or date shifted, a name swapped for another from the same conversation's
 *             gold, the item's value replaced by a value of the same kind from another question's gold in the same
 *             conversation, or the statement negated. The rest drop the item, replace the whole answer with an abstention or, on abstention questions,
 *             write an invented answer. The script checks that every edit removes the target item's content and keeps
 *             every other item's. Event-ordering, instruction-following and preference-following questions are left out of
 *             (b) and (c): their score is not a rubric mean, or their gold describes an answer instead of being one.
 *             No sealed text is used. The pool and every answer text stay in --out, never in the published files.
 *   Grading   gpt-6-astra and claude-opus-5-5 grade every candidate with the production request (the cells' canonical
 *             instrument through judgeAnswer at the pinned per-reader settings, gating view); gpt-4.1-mini with its
 *             protocol request. Every call goes through the judge cache and the one lease of --budget-ledger.
 *   Unit      the rubric-item judgment; pass is a score of 1.0, fail below it (weighted kappa on 0, 0.5 and 1 beside).
 *             Construction labels: every item of a gold answer should pass; in a corruption the targeted item (every
 *             item, for an abstention or an invented answer) should fail and the rest pass. Real answers have none.
 *   Labelled  the items Astra and Opus grade the same way; it should hold at least 40, and at least 15 of each class.
 *             A class below 15 reports n/a for its per-class numbers, and every shortfall goes to GBEV-3.
 *   Gates     (i) Astra-Opus Cohen's kappa on every item both graded, at least 0.6; (ii) each gating judge's kappa
 *             against the construction labels (classes b and c), at least 0.6; each gating judge's truncation rate at
 *             most 1%. Any failure stops wave A (exit 3, JUDGE_CHECK_STOP) and every number goes to GBEV-3. The
 *             particle-1 option (Astra for particle-1 rows) is GBEV-3's to choose, never applied here.
 *   Reported  for every judge: catch rate on bad items, false-fail rate on good items (construction labels, else the
 *             labelled set's), kappa against the labelled set, overall and by class, with 95% intervals (Wilson for
 *             rates, the large-sample kappa SE); gpt-4.1-mini's numbers are descriptive. Spend from the usage log.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadBeam, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor, type Instrument } from '../memory-qa/instruments.ts';
import { ChatClient, judgeAnswer, type ChatLike } from '../memory-qa/qa-v2.ts';
import { readRecords, sha256, type JudgmentRecord } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import { keylessUpstreamArg } from '../q1/calibration-cell.ts';
import { metering, onSlot, type MeterLine } from '../q1/cell.ts';
import { PER_READER_JUDGE_SETTINGS } from '../q1/cells/definitions.ts';
import { loadRS1Manifest } from '../q1/cells/rs1.ts';
import { openRereadLease } from '../q1/reread-cell.ts';
import { seededRandom } from '../stats/paired.ts';

export const JUDGE_CHECK_SCHEMA = 'gbrain-evals/rs1-judge-check/v1';
export const ASTRA = 'openai:gpt-6-astra';
export const OPUS_JUDGE = 'anthropic:claude-opus-5-5';
export const BRIDGE = 'openai:gpt-4.1-mini';
export const JUDGES = [ASTRA, OPUS_JUDGE, BRIDGE] as const;
export const GATING_JUDGES = [ASTRA, OPUS_JUDGE] as const;
export const KAPPA_GATE = 0.6;
export const TRUNCATION_GATE = 0.01;
export const MIN_LABELLED = 40;
export const MIN_PER_CLASS = 15;
export const SEED = 20261108;
export const SIZES = { real: 80, gold: 40, corrupt: 40 } as const;
/** BEAM-1M's public dev conversations (eval/decisions/splits/beam-1m.json); none is sealed. */
export const DEV_CONVERSATIONS = ['1m-16', '1m-2', '1m-20', '1m-21', '1m-22', '1m-24', '1m-25', '1m-28', '1m-3', '1m-30', '1m-32'];
/** Categories whose gold is an answer and whose score is the rubric mean. */
export const CONSTRUCTED_CATEGORIES = ['abstention', 'contradiction_resolution', 'information_extraction', 'knowledge_update', 'multi_session_reasoning', 'temporal_reasoning', 'summarization'];
export const ABSTAIN_TEXT = 'Based on the provided chat, there is no information that answers this question.';
export const INVENTED_TEXT = 'Yes. According to the chat, it happened as you describe: you went ahead with it, it went well, and you mentioned it again a week later.';
/** Capitalized words an entity swap leaves alone: months, weekdays and common sentence words. */
const NOT_NAMES = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|The|This|That|These|Those|And|But|For|With|You|Your|They|Their|She|Her|His|Its|Our|Based|According|Initially|Finally|Then|After|Before|When|While)$/;

export type ItemClass = 'real' | 'gold' | 'corrupt';
export type CorruptionKind = 'number' | 'date' | 'entity' | 'contradiction' | 'negation' | 'drop' | 'abstain' | 'invented';
/** Edits that leave a confident, plausible wrong fact where the target item's was. */
export const WRONG_VALUE: CorruptionKind[] = ['number', 'date', 'entity', 'contradiction', 'negation'];
export const KINDS: CorruptionKind[] = [...WRONG_VALUE, 'drop', 'abstain', 'invented'];
/** The turn order on questions whose answer exists: seven wrong-value turns, two drops and one abstention in ten. */
export const TURNS: CorruptionKind[] = ['number', 'entity', 'contradiction', 'drop', 'negation', 'date', 'contradiction', 'entity', 'drop', 'abstain'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** Another question of the same conversation, whose gold lends entities and statements to wrong-value edits. */
export type Donor = Pick<MemoryQuestion, 'id' | 'answer' | 'rubric'>;
export interface Candidate {
  id: string; class: ItemClass; question_id: string; conversation: string; category: string; text: string; text_sha256: string;
  /** Construction labels per rubric item: true should pass, false should fail; null for real answers. */
  labels: Array<boolean | null>;
  kind?: CorruptionKind; target?: number; stratum?: string; source?: string;
}
export interface Exclusion { question_id: string; reason: string }

// ─── Rubric content and the scripted constructions ───────────────────

/** A rubric item's content: what follows "LLM response should state:" (mention, contain), else the whole item. */
export const contentOf = (item: string) => item.replace(/^\s*LLM response should (?:state|mention|contain|include|say)\s*:\s*/i, '').replace(/[.?!]\s*$/, '').trim();
const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9%$.,'" ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Whether an answer states a rubric item's content (normalized substring). */
export const covers = (answer: string, item: string) => norm(answer).includes(norm(contentOf(item)));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The content's span in the raw answer (case-insensitive, curly quotes as straight), or null. */
function spanOf(answer: string, item: string): [number, number] | null {
  const m = new RegExp(escape(contentOf(item).replace(/[‘’]/g, "'")), 'i').exec(answer.replace(/[‘’]/g, "'"));
  return m ? [m.index, m.index + m[0].length] : null;
}
const bump = (digits: string) => { const v = Number(digits.replace(/,/g, '')); const w = v + Math.max(1, Math.round(v * 0.4)); return digits.includes(',') ? w.toLocaleString('en-US') : String(w); };

/**
 * One scripted corruption of a screened gold answer aimed at rubric item `target`, or null when this kind cannot touch
 * that item alone. number shifts the item's first number (an hour before AM or PM stays an hour, a day after a month
 * stays a day); date moves its first month three on or its weekday two on; entity swaps its first mid-sentence name for
 * a mid-sentence name from another question's gold in the same conversation (`donors`);
 * contradiction replaces a short value (at most eight words with a digit in them, or at most three words) with another
 * question's rubric value from the same conversation of the same kind (money, percent, time, date, link; another number only with a unit word in common;
 * plain words only with the same capitalization) and within two words;
 * negation puts "not" after the item's first auxiliary verb. Every edit must remove the target's content, keep every
 * other item's and leave at least 20 letters, so a corruption is never an empty or near-empty answer.
 */
export function corrupt(q: Pick<MemoryQuestion, 'rubric' | 'abstention'>, gold: string, target: number, kind: CorruptionKind, donors: readonly Donor[] = []): string | null {
  const items = q.rubric ?? [];
  if (kind === 'abstain') return q.abstention ? null : ABSTAIN_TEXT;
  if (kind === 'invented') return q.abstention ? INVENTED_TEXT : null;
  if (q.abstention) return null;
  const span = spanOf(gold, items[target]);
  if (!span) return null;
  const part = gold.slice(span[0], span[1]);
  const splice = (at: number, len: number, by: string) => gold.slice(0, span[0]) + part.slice(0, at) + by + part.slice(at + len) + gold.slice(span[1]);
  const edits: string[] = [];
  if (kind === 'drop') edits.push(gold.slice(0, span[0]) + gold.slice(span[1]));
  if (kind === 'number') {
    const m = /\d[\d,]*\d|\d/.exec(part);
    if (m) {
      const before = gold.slice(0, span[0]) + part.slice(0, m.index), after = part.slice(m.index + m[0].length) + gold.slice(span[1]);
      const v = Number(m[0].replace(/,/g, ''));
      const shifted = /^\s*(AM|PM|a\.m\.|p\.m\.)/i.test(after) && v >= 1 && v <= 12 ? String((v + 1) % 12 + 1)
        : new RegExp(`\\b(${MONTHS.join('|')})\\s+$`).test(before) && v >= 1 && v <= 31 ? String(v > 25 ? v - 5 : v + 3)
        : bump(m[0]);
      edits.push(splice(m.index, m[0].length, shifted));
    }
  }
  if (kind === 'date') {
    const m = new RegExp(`\\b(${[...MONTHS, ...WEEKDAYS].join('|')})\\b`).exec(part);
    if (m) { const months = MONTHS.indexOf(m[1]) >= 0; const list = months ? MONTHS : WEEKDAYS; edits.push(splice(m.index, m[1].length, list[(list.indexOf(m[1]) + (months ? 3 : 2)) % list.length])); }
  }
  if (kind === 'entity') {
    const lone = [...gold.matchAll(/(?<![A-Z][a-z]* )(?<=[a-z,;:] )[A-Z][a-z]{2,}\b(?! [A-Z])/g)].find(x => x.index! >= span[0] && x.index! + x[0].length <= span[1] && !NOT_NAMES.test(x[0]));
    const m = lone ? Object.assign([lone[0]], { index: lone.index! - span[0] }) : undefined;
    const swaps = [...new Set(donors.flatMap(d => [...(d.answer ?? '').matchAll(/(?<![A-Z][a-z]* )(?<=[a-z,;:] )[A-Z][a-z]{2,}\b(?! [A-Z])/g)].map(x => x[0])))].filter(n => !NOT_NAMES.test(n) && !gold.includes(n));
    if (m) for (const s of swaps) edits.push(splice(m.index!, m[0].length, s));
  }
  if (kind === 'contradiction') {
    const kindOf = (s: string) => /:\/\/|www\./.test(s) ? 'link' : /\$/.test(s) ? 'money' : /%/.test(s) ? 'percent' : /\b(AM|PM|a\.m\.|p\.m\.)\b|\d:\d\d/i.test(s) ? 'time'
      : new RegExp(`\\b(${[...MONTHS, ...WEEKDAYS].join('|')})\\b`).test(s) ? 'date' : /\d/.test(s) ? 'number' : 'words';
    const shape = (s: string) => ({ kind: kindOf(s), digits: /\d/.test(s), words: s.split(/\s+/).length });
    const target_ = contentOf(items[target]);
    const t = shape(target_);
    if (t.words <= 8 && (t.digits || t.words <= 3)) for (const d of donors) for (const it of d.rubric ?? []) {
      const c = contentOf(it), s = shape(c);
      const units = (x: string) => new Set(x.toLowerCase().match(/[a-z]{3,}/g) ?? []);
      const alike = t.kind === 'number' ? [...units(c)].some(u => units(target_).has(u)) : t.kind === 'words' ? /^[A-Z]/.test(c) === /^[A-Z]/.test(target_) : true;
      if (!(s.kind === t.kind && alike && Math.abs(s.words - t.words) <= 2 && !/contradict|information|clarif|mention|response|LLM|statement|correct|which|whether|\?/i.test(c) && !covers(gold, it))) continue;
      const first = c.split(/\s+/)[0];
      const midSentence = span[0] > 0 && !/[.!?]\s*$/.test(gold.slice(0, span[0]));
      const proper = new RegExp(`[a-z,;:] ${escape(first)}\\b`).test(d.answer ?? '');
      edits.push(gold.slice(0, span[0]) + (midSentence && !proper ? c[0].toLowerCase() + c.slice(1) : c) + gold.slice(span[1]));
    }
  }
  if (kind === 'negation') { const m = /\b(is|was|are|were|has|have|had|will|can|could|did|does|do|should|would)\b(?! not\b)/i.exec(part); if (m) edits.push(splice(m.index + m[0].length, 0, ' not')); }
  for (const edited of edits) {
    if (edited === gold) continue;
    const tidy = edited.replace(/\s+([.,])/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s.,;:]+/, '').trim();
    if (tidy.replace(/[^A-Za-z]/g, '').length >= 20 && !covers(tidy, items[target]) && items.every((it, i) => i === target || covers(tidy, it))) return tidy;
  }
  return null;
}

/** The gold screen: a constructed-category question whose gold states every rubric item's content, else why not. */
export function screen(q: MemoryQuestion): string | null {
  if (!CONSTRUCTED_CATEGORIES.includes(q.category)) return `category ${q.category} is not built from gold`;
  if (!q.rubric?.length || !q.answer) return 'no rubric or no gold answer';
  const missing = q.rubric.findIndex(it => !covers(q.answer!, it));
  return missing >= 0 ? `gold does not state rubric item ${missing}` : null;
}

function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export interface RealAnswer { answer_id: string; question_id: string; conversation: string; row: string; reader: string; text: string; bridge: number | null }

/**
 * The seeded pool: real answers stratified by row, reader and bridge outcome, then screened gold and its corruptions.
 * Corruption kinds take TURNS; a question that cannot take its turn's kind takes another wrong-value edit, then a drop,
 * never an abstention, so abstentions stay at one in ten of the non-abstention-question corruptions at most.
 */
export function buildPool(questions: readonly MemoryQuestion[], real: readonly RealAnswer[], seed = SEED, sizes: { real: number; gold: number; corrupt: number } = SIZES): { pool: Candidate[]; exclusions: Exclusion[] } {
  const rand = seededRandom(seed);
  const byId = new Map(questions.map(q => [q.id, q]));
  const bucket = (b: number | null) => (b === null ? 'unjudged' : b >= 1 ? 'pass' : b <= 0 ? 'fail' : 'partial');
  const strata = new Map<string, RealAnswer[]>();
  for (const a of real.filter(x => byId.get(x.question_id)?.rubric?.length)) { const k = `${a.row}|${a.reader}|${bucket(a.bridge)}`; strata.set(k, [...(strata.get(k) ?? []), a]); }
  const queues = [...strata.keys()].sort().map(k => ({ k, xs: shuffle(strata.get(k)!, rand) }));
  const pool: Candidate[] = [];
  while (pool.length < sizes.real && queues.some(q => q.xs.length)) for (const q of queues) {
    const a = q.xs.shift();
    if (!a || pool.length >= sizes.real) continue;
    const rubric = byId.get(a.question_id)!.rubric!;
    pool.push({ id: `real:${a.answer_id.slice(0, 16)}`, class: 'real', question_id: a.question_id, conversation: a.conversation, category: byId.get(a.question_id)!.category, text: a.text, text_sha256: sha256(a.text), labels: rubric.map(() => null), stratum: q.k, source: a.answer_id });
  }
  const exclusions: Exclusion[] = [];
  const screened = shuffle(questions.filter(q => { const why = screen(q); if (why) exclusions.push({ question_id: q.id, reason: why }); return !why; }), rand);
  for (const q of screened.slice(0, sizes.gold)) pool.push({ id: `gold:${q.id}`, class: 'gold', question_id: q.id, conversation: q.conversation, category: q.category, text: q.answer!, text_sha256: sha256(q.answer!), labels: q.rubric!.map(() => true) });
  let made = 0, turns = 0;
  for (const q of [...screened.slice(sizes.gold), ...screened.slice(0, sizes.gold)]) {
    if (made >= sizes.corrupt) break;
    const turn = TURNS[turns % TURNS.length];
    const kinds: CorruptionKind[] = q.abstention ? ['invented'] : turn === 'abstain' ? ['abstain'] : [turn, ...WRONG_VALUE.filter(k => k !== turn), ...(turn === 'drop' ? [] : ['drop' as const])];
    const donors = questions.filter(d => d.conversation === q.conversation && d.id !== q.id && !d.abstention && d.answer);
    const n = q.rubric!.length, start = Math.floor(rand() * n);
    const tries = kinds.flatMap(kind => Array.from({ length: n }, (_, i) => ({ kind, target: (start + i) % n })));
    const hit = tries.map(t => ({ ...t, text: corrupt(q, q.answer!, t.target, t.kind, donors) })).find(t => t.text !== null);
    if (!hit) continue;
    if (!q.abstention) turns++;
    const all = hit.kind === 'abstain' || hit.kind === 'invented';
    pool.push({ id: `corrupt:${q.id}:${hit.kind}:${hit.target}`, class: 'corrupt', question_id: q.id, conversation: q.conversation, category: q.category, text: hit.text!, text_sha256: sha256(hit.text!), labels: q.rubric!.map((_, i) => !(all || i === hit.target)), kind: hit.kind, target: hit.target });
    made++;
  }
  return { pool, exclusions };
}

// ─── Agreement statistics ────────────────────────────────────────────

/** Cohen's kappa on paired pass/fail labels with its large-sample 95% interval; null when there are none or chance agreement is 1. */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): { kappa: number | null; n: number; po: number | null; ci95: [number, number] | null } {
  const n = a.length;
  if (!n) return { kappa: null, n, po: null, ci95: null };
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pa = a.filter(Boolean).length / n, pb = b.filter(Boolean).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  if (pe >= 1) return { kappa: null, n, po, ci95: null };
  const kappa = (po - pe) / (1 - pe);
  const se = Math.sqrt(po * (1 - po) / (n * (1 - pe) ** 2));
  return { kappa, n, po, ci95: [kappa - 1.959964 * se, kappa + 1.959964 * se] };
}

/** Linearly weighted kappa on the 0, 0.5 and 1 scale. */
export function weightedKappa(a: readonly number[], b: readonly number[], cats: readonly number[] = [0, 0.5, 1]): number | null {
  const n = a.length, k = cats.length;
  if (!n) return null;
  const w = (i: number, j: number) => 1 - Math.abs(i - j) / (k - 1);
  const obs = cats.map(() => cats.map(() => 0));
  a.forEach((x, t) => { obs[cats.indexOf(x)][cats.indexOf(b[t])] += 1 / n; });
  const ra = obs.map(r => r.reduce((s, v) => s + v, 0)), cb = cats.map((_, j) => obs.reduce((s, r) => s + r[j], 0));
  let po = 0, pe = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { po += w(i, j) * obs[i][j]; pe += w(i, j) * ra[i] * cb[j]; }
  return pe >= 1 ? null : (po - pe) / (1 - pe);
}

/** The Wilson 95% interval for k of n. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.959964, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// ─── The analysis ────────────────────────────────────────────────────

/** One judge's grade of one candidate: its per-item scores (null for a judge_error), whether it truncated, and its record's meta. */
export interface Grade { scores: number[] | null; truncated: boolean; cache_hits: number; calls: number; versions: string[] }
export type Grades = Record<string, Record<string, Grade>>;

export function gradeOf(j: Pick<JudgmentRecord, 'outcome' | 'detail' | 'calls' | 'cache_hits' | 'judge_versions'>): Grade {
  const d = (j.detail ?? {}) as { rubric_scores?: number[]; truncated?: boolean };
  return { scores: j.outcome === 'scored' && Array.isArray(d.rubric_scores) ? d.rubric_scores : null, truncated: d.truncated === true, cache_hits: j.cache_hits ?? 0, calls: j.calls ?? 0, versions: j.judge_versions ?? [] };
}

interface Unit { id: string; class: ItemClass; label: boolean | null; scores: Record<string, number | null> }
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);
const r4p = (p: [number, number] | null): [number, number] | null => (p ? [r4(p[0])!, r4(p[1])!] : null);
const CLASSES = ['real', 'gold', 'corrupt'] as const;

export function analyzeCheck(pool: readonly Candidate[], grades: Grades) {
  const units: Unit[] = pool.flatMap(c => c.labels.map((label, i) => ({ id: `${c.id}#${i}`, class: c.class, label, scores: Object.fromEntries(JUDGES.map(j => [j, grades[j]?.[c.id]?.scores?.[i] ?? null])) })));
  const pass = (x: number) => x >= 1;
  const both = units.filter(u => u.scores[ASTRA] !== null && u.scores[OPUS_JUDGE] !== null);
  const inter = cohenKappa(both.map(u => pass(u.scores[ASTRA]!)), both.map(u => pass(u.scores[OPUS_JUDGE]!)));
  const labelled = both.filter(u => pass(u.scores[ASTRA]!) === pass(u.scores[OPUS_JUDGE]!)).map(u => ({ ...u, agreed: pass(u.scores[ASTRA]!) }));
  const agreed = new Map(labelled.map(u => [u.id, u.agreed]));
  const mix = Object.fromEntries(CLASSES.map(c => [c, labelled.filter(u => u.class === c).length])) as Record<ItemClass, number>;
  const truth = (u: Unit) => u.label ?? agreed.get(u.id) ?? null;
  const perJudge = (judge: string) => {
    const graded = units.filter(u => u.scores[judge] !== null);
    const slice = (cls: ItemClass | 'all') => {
      if (cls !== 'all' && mix[cls] < MIN_PER_CLASS) return { items: graded.filter(u => u.class === cls).length, bad: null, catch_rate: null, catch_ci95: null, good: null, false_fail_rate: null, false_fail_ci95: null, kappa_vs_labelled: null, kappa_vs_labelled_ci95: null, na: `${mix[cls]} labelled ${cls} items, below ${MIN_PER_CLASS}` };
      const us = graded.filter(u => cls === 'all' || u.class === cls);
      const bad = us.filter(u => truth(u) === false), good = us.filter(u => truth(u) === true);
      const caught = bad.filter(u => !pass(u.scores[judge]!)).length, falseFails = good.filter(u => !pass(u.scores[judge]!)).length;
      const lab = labelled.filter(u => (cls === 'all' || u.class === cls) && u.scores[judge] !== null);
      const kl = cohenKappa(lab.map(u => pass(u.scores[judge]!)), lab.map(u => u.agreed));
      return { items: us.length, bad: bad.length, catch_rate: bad.length ? r4(caught / bad.length) : null, catch_ci95: r4p(wilson(caught, bad.length)),
        good: good.length, false_fail_rate: good.length ? r4(falseFails / good.length) : null, false_fail_ci95: r4p(wilson(falseFails, good.length)),
        kappa_vs_labelled: r4(kl.kappa), kappa_vs_labelled_ci95: r4p(kl.ci95), na: null as string | null };
    };
    const constructed = graded.filter(u => u.label !== null);
    const kc = cohenKappa(constructed.map(u => pass(u.scores[judge]!)), constructed.map(u => u.label!));
    const judgments = pool.flatMap(c => (grades[judge]?.[c.id] ? [grades[judge][c.id]] : []));
    const truncated = judgments.filter(g => g.truncated).length;
    return {
      judge, role: (GATING_JUDGES as readonly string[]).includes(judge) ? 'gating' : 'descriptive', judgments: judgments.length,
      judge_errors: judgments.filter(g => g.scores === null).length, truncated, truncation_rate: judgments.length ? r4(truncated / judgments.length) : null,
      cache_hits: judgments.reduce((s, g) => s + g.cache_hits, 0), calls: judgments.reduce((s, g) => s + g.calls, 0), versions: [...new Set(judgments.flatMap(g => g.versions))].sort(),
      kappa_vs_construction: r4(kc.kappa), kappa_vs_construction_ci95: r4p(kc.ci95), kappa_vs_construction_n: kc.n,
      weighted_kappa_vs_construction: r4(weightedKappa(constructed.map(u => u.scores[judge]!), constructed.map(u => (u.label ? 1 : 0)))),
      overall: slice('all'), by_class: { real: slice('real'), gold: slice('gold'), corrupt: slice('corrupt') },
    };
  };
  const judges = JUDGES.map(perJudge);
  const of = (j: string) => judges.find(x => x.judge === j)!;
  const gates = [
    { gate: 'inter-judge kappa, Astra vs Opus (i)', value: r4(inter.kappa), line: KAPPA_GATE, pass: inter.kappa !== null && inter.kappa >= KAPPA_GATE },
    ...GATING_JUDGES.map(j => ({ gate: `${j} kappa against the construction labels (ii)`, value: of(j).kappa_vs_construction, line: KAPPA_GATE, pass: of(j).kappa_vs_construction !== null && of(j).kappa_vs_construction! >= KAPPA_GATE })),
    ...GATING_JUDGES.map(j => ({ gate: `${j} truncation rate`, value: of(j).truncation_rate, line: TRUNCATION_GATE, pass: of(j).truncation_rate !== null && of(j).truncation_rate! <= TRUNCATION_GATE })),
  ];
  const shortfalls = [
    ...(labelled.length < MIN_LABELLED ? [`labelled set holds ${labelled.length} items, below ${MIN_LABELLED}`] : []),
    ...CLASSES.filter(c => mix[c] < MIN_PER_CLASS).map(c => `${mix[c]} labelled ${c} items, below ${MIN_PER_CLASS}; its per-class numbers are n/a`),
  ];
  return {
    schema: JUDGE_CHECK_SCHEMA, judges: { gating: GATING_JUDGES, descriptive: [BRIDGE] }, settings: PER_READER_JUDGE_SETTINGS, unit: 'rubric-item judgment; pass = 1.0, fail below',
    pool: { candidates: pool.length, by_class: Object.fromEntries(CLASSES.map(c => [c, pool.filter(x => x.class === c).length])), corruption_kinds: Object.fromEntries(KINDS.map(k => [k, pool.filter(c => c.kind === k).length])), items: units.length },
    inter_judge: { kappa: r4(inter.kappa), ci95: r4p(inter.ci95), items: inter.n, agreement: r4(inter.po), weighted_kappa: r4(weightedKappa(both.map(u => u.scores[ASTRA]!), both.map(u => u.scores[OPUS_JUDGE]!))) },
    labelled_set: { items: labelled.length, by_class: mix, pass: labelled.filter(u => u.agreed).length, fail: labelled.filter(u => !u.agreed).length },
    per_judge: judges, gates, stop: gates.some(g => !g.pass), shortfalls,
  };
}
export type CheckReport = ReturnType<typeof analyzeCheck>;

const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const iv = (p: [number, number] | null, f: (x: number) => string) => (p ? `${f(p[0])} to ${f(p[1])}` : 'n/a');
const k3 = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3));
export function checkMarkdown(r: CheckReport, spend: unknown = null): string {
  const lines = ['# RS1 judge check', '', r.stop ? '**STOP: a gate failed. Wave A waits, and every number goes to GBEV-3.**' : '**Every gate passed.**', ''];
  lines.push(`Pool: ${r.pool.candidates} candidates (${r.pool.by_class.real} real, ${r.pool.by_class.gold} gold, ${r.pool.by_class.corrupt} corrupted; kinds ${Object.entries(r.pool.corruption_kinds).map(([k, n]) => `${k} ${n}`).join(', ')}), ${r.pool.items} rubric items. Gating judges at ${JSON.stringify(r.settings)}; gpt-4.1-mini at its protocol settings (descriptive).`, '');
  lines.push(`Inter-judge kappa (Astra vs Opus): ${k3(r.inter_judge.kappa)} (95% ${iv(r.inter_judge.ci95, k3)}) over ${r.inter_judge.items} items; weighted ${k3(r.inter_judge.weighted_kappa)}. Labelled set: ${r.labelled_set.items} items (${r.labelled_set.by_class.real} real, ${r.labelled_set.by_class.gold} gold, ${r.labelled_set.by_class.corrupt} corrupted).`, '');
  lines.push('| Gate | Value | Line | Pass |', '|---|---:|---:|---|', ...r.gates.map(g => `| ${g.gate} | ${g.value ?? 'n/a'} | ${g.line} | ${g.pass ? 'yes' : 'no'} |`), '');
  if (r.shortfalls.length) lines.push(`Shortfalls for GBEV-3: ${r.shortfalls.join('; ')}.`, '');
  lines.push('| Judge | Role | Class | Items | Catch rate (95%) | False-fail rate (95%) | Kappa vs labelled set (95%) |', '|---|---|---|---:|---|---|---|');
  for (const j of r.per_judge) for (const [cls, s] of [['all', j.overall], ...Object.entries(j.by_class)] as Array<[string, typeof j.overall]>)
    lines.push(s.na ? `| ${j.judge} | ${j.role} | ${cls} | ${s.items} | n/a | n/a | n/a (${s.na}) |` : `| ${j.judge} | ${j.role} | ${cls} | ${s.items} | ${pct(s.catch_rate)} (${iv(s.catch_ci95, pct)}) of ${s.bad} | ${pct(s.false_fail_rate)} (${iv(s.false_fail_ci95, pct)}) of ${s.good} | ${k3(s.kappa_vs_labelled)} (${iv(s.kappa_vs_labelled_ci95, k3)}) |`);
  lines.push('', '| Judge | Kappa vs construction labels (95%) | Weighted | Judgments | Errors | Truncated | Cache hits / calls | Versions |', '|---|---|---:|---:|---:|---|---|---|');
  for (const j of r.per_judge) lines.push(`| ${j.judge} | ${k3(j.kappa_vs_construction)} (${iv(j.kappa_vs_construction_ci95, k3)}) over ${j.kappa_vs_construction_n} | ${k3(j.weighted_kappa_vs_construction)} | ${j.judgments} | ${j.judge_errors} | ${j.truncated} (${pct(j.truncation_rate)}) | ${j.role === 'gating' ? `${j.cache_hits} / ${j.calls}` : 'not recorded'} | ${j.versions.join(', ') || 'none'} |`);
  lines.push('', 'Astra and Opus agree with the labelled set by construction, so their kappa against it is circular; gate (ii) uses the construction labels instead. gpt-4.1-mini is descriptive and breaks the family rule on gpt-6.1-sol rows.');
  if (spend) lines.push('', `Spend: ${JSON.stringify(spend)}`);
  return lines.join('\n') + '\n';
}

// ─── Loading, grading and the command line ───────────────────────────

/** Stage 1's scored, replicate-0 answers in each root's cells/ (all four rows and their re-reads), with the bridge score for strata. */
export function loadRealAnswers(roots: readonly string[], instrument: string): RealAnswer[] {
  return roots.flatMap(root => {
    const cells = join(root, 'cells');
    if (!existsSync(cells)) throw new Error(`${root} has no cells/ directory`);
    return readdirSync(cells).sort().filter(d => existsSync(join(cells, d, 'answers.ndjson'))).flatMap(d => {
      const jf = join(cells, d, 'judgments.ndjson');
      const bridge = new Map(existsSync(jf) ? readRecords(jf, 'judgment').filter(j => j.instrument_id === instrument && j.judge_replicate === 0).map(j => [j.answer_id, j.score]) : []);
      return readRecords(join(cells, d, 'answers.ndjson'), 'answer').filter(a => a.replicate === 0 && a.outcome === 'scored' && a.text.trim())
        .map(a => ({ answer_id: a.answer_id, question_id: a.question_id, conversation: a.conversation, row: d.split('.')[1] ?? d, reader: a.reader, text: a.text, bridge: bridge.get(a.answer_id) ?? null }));
    });
  });
}

type Graded = JudgmentRecord & { candidate: string };
const readGraded = (file: string): Graded[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
export function gradesFrom(records: readonly Graded[]): Grades {
  const grades: Grades = Object.fromEntries(JUDGES.map(j => [j, {}]));
  for (const r of records) if (grades[r.judge]) grades[r.judge][r.candidate] = gradeOf(r);
  return grades;
}

/** Grade every candidate with every judge, the gating judges at the pinned settings (resumable: a graded pair in --out is skipped). */
export async function gradePool(pool: readonly Candidate[], questions: ReadonlyMap<string, MemoryQuestion>, client: ChatLike, instrument: Instrument, out: string): Promise<Grades> {
  const file = join(out, 'judgments.ndjson');
  const done = new Set(readGraded(file).map(r => `${r.candidate}|${r.judge}`));
  for (const c of pool) for (const judge of JUDGES) {
    if (done.has(`${c.id}|${judge}`)) continue;
    const gating = (GATING_JUDGES as readonly string[]).includes(judge);
    const r = await judgeAnswer(client, instrument, questions.get(c.question_id)!, c.text, { judge, judgeReplicate: 0, view: gating ? 'gating' : 'descriptive', ...(gating ? { settings: { ...PER_READER_JUDGE_SETTINGS } } : {}) });
    appendFileSync(file, JSON.stringify({ candidate: c.id, answer_id: c.text_sha256, ...r }) + '\n');
  }
  return gradesFrom(readGraded(file));
}

/** The published files: judge-check.json and judge-check.md, with ids and hashes only (no answer, gold or corruption text). */
export function publish(dir: string, report: CheckReport, pool: readonly Candidate[], exclusions: readonly Exclusion[], spend: unknown) {
  mkdirSync(dir, { recursive: true });
  const candidates = pool.map(c => ({ id: c.id, class: c.class, question_id: c.question_id, category: c.category, text_sha256: c.text_sha256, labels: c.labels, ...(c.kind ? { kind: c.kind, target: c.target } : {}), ...(c.stratum ? { stratum: c.stratum } : {}) }));
  writeFileSync(join(dir, 'judge-check.json'), JSON.stringify({ ...report, spend, candidates, gold_screen_exclusions: exclusions }, null, 2) + '\n');
  writeFileSync(join(dir, 'judge-check.md'), checkMarkdown(report, spend));
}

if (import.meta.main) {
  const [mode, ...argv] = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const stage1 = argv.flatMap((a, i) => (a === '--stage1' && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const out = one('--out') ? resolve(one('--out')!) : null;
  const seed = Number(one('--seed') ?? SEED);
  if (!out || !['plan', 'run', 'report'].includes(mode ?? '') || (mode !== 'report' && !stage1.length)) { console.error('usage: bun eval/runner/rs1/judge-check.ts plan|run --stage1 <dir>... --out <dir> [--seed <n>] [run: --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--keyless-upstream <url>]]; report --out <dir> [--publish <dir>]'); process.exit(2); }
  mkdirSync(out, { recursive: true });
  if (mode !== 'report') {
    const instrument = instrumentFor(loadRS1Manifest().smoke_cells[0].canonical_instrument);
    const questions = loadBeam('1m', new Set(DEV_CONVERSATIONS)).questions;
    const { pool, exclusions } = buildPool(questions, loadRealAnswers(stage1, instrument.id), seed);
    writeFileSync(join(out, 'pool.json'), JSON.stringify({ seed, pool, exclusions }, null, 2) + '\n');
    const items = pool.reduce((s, c) => s + c.labels.length, 0);
    console.log(JSON.stringify({ seed, candidates: pool.length, by_class: Object.fromEntries(CLASSES.map(c => [c, pool.filter(x => x.class === c).length])), rubric_items: items, rubric_calls: items * JUDGES.length, gold_screen_exclusions: exclusions.length }, null, 2));
    if (mode === 'plan') process.exit(0);
    const [ledger, runId, leaseUsd, cap] = [one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--ledger-cap-usd'))];
    if (!ledger || !runId || !(leaseUsd > 0) || !(cap > 0)) { console.error('run needs --budget-ledger, --run-id, --lease-usd and --ledger-cap-usd'); process.exit(2); }
    const keyless = keylessUpstreamArg(argv);
    const placeholder = 'keyless-not-a-provider-key';
    const [cellToken, controlToken] = [randomUUID(), randomUUID()];
    Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
    const lease = openRereadLease({ runId, leaseUsd, ledgerPath: resolve(ledger), capUsd: cap, runner: 'rs1-judge-check' });
    const usageLog = join(out, 'usage.ndjson');
    const proxy = new MeteringProxy({ ...(keyless ? { upstream: { openai: keyless, anthropic: keyless, voyage: keyless, particle: `${keyless}/particle` } } : {}), cellToken, controlToken,
      policy: { lease, usageLog, env: keyless ? { OPENAI_API_KEY: placeholder, ANTHROPIC_API_KEY: placeholder } : { ...process.env }, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS, ...Object.fromEntries(GATING_JUDGES.map(j => [`judge@${j}`, PER_READER_JUDGE_SETTINGS.max_tokens])) }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const meter = metering(`http://127.0.0.1:${proxy.port}`, { meter: (m: MeterLine) => appendFileSync(join(out, 'meters.ndjson'), JSON.stringify(m) + '\n') }, process.env);
      await gradePool(pool, new Map(questions.map(q => [q.id, q])), onSlot(new ChatClient(join(out, 'cache', 'qa')), meter, 'judge'), instrument, out);
    } finally { proxy.stop(); lease.close(); }
  }
  const saved = JSON.parse(readFileSync(join(out, 'pool.json'), 'utf8')) as { pool: Candidate[]; exclusions: Exclusion[] };
  const report = analyzeCheck(saved.pool, gradesFrom(readGraded(join(out, 'judgments.ndjson'))));
  const spend = { source: 'metering proxy usage log (provider usage fields)', usage: existsSync(join(out, 'usage.ndjson')) ? usageSplit(join(out, 'usage.ndjson')) : null };
  publish(one('--publish') ? resolve(one('--publish')!) : out, report, saved.pool, saved.exclusions, spend);
  process.stdout.write(checkMarkdown(report, spend));
  if (report.stop) { process.stderr.write(`JUDGE_CHECK_STOP: ${report.gates.filter(g => !g.pass).map(g => `${g.gate} ${g.value ?? 'n/a'} (line ${g.line})`).join('; ')}; wave A waits and every number goes to GBEV-3\n`); process.exit(3); }
}

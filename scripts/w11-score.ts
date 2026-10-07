#!/usr/bin/env bun
/**
 * Score a returned W11 review export offline.
 *
 *   bun scripts/w11-score.ts <w11-labels-*.json> [--store <dir>]
 *
 * Validates the export against the packet it came from (packet SHA, label-file hashes, known ids,
 * required correction fields), then prints a machine-readable publication decision:
 *
 * - cat35: agreement and linearly weighted kappa between the judge's committed verdicts and Garry's
 *   ratings, over answered rows with a non-empty note ("can't tell" is an abstention), with a
 *   transcript-clustered bootstrap interval. Publishes only at >= 12 eligible ratings; "calibrated"
 *   needs the interval's lower bound >= 0.4; an interval wider than 0.5 is "imprecise".
 * - chronicle: the revised reference set (corrections replace labels, added missed events join,
 *   "not an event" removes, "can't tell" keeps the agent's label and is counted as a bound) and the
 *   recall of both committed ON runs against it, with the rule ceil(34/38 x revised size).
 *
 * It never reruns a judge and never writes a scored field Garry didn't enter.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { weightedKappa } from '../eval/runner/cat35-checks.ts';
import { matchPage, type Extracted, type GoldEvent } from '../eval/runner/chronicle-lift.ts';
import { CAT35_CALIBRATION, cat35Data, chronicleData, embedJson } from './w11-packet.ts';

const RERUN = 'docs/benchmarks/2026-10-04-auto-chronicle-rerun';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Export {
  schema: string;
  packet: 'chronicle' | 'cat35';
  packet_sha256: string;
  label_files: Record<string, string>;
  reviewer: string;
  exported_at: string;
  submitted: boolean;
  rule_disagreement?: string;
  answers: Record<string, Record<string, unknown>>;
  extras?: Record<string, Array<{ day: string; description: string; keywords: string[] }>>;
}

export function validate(exp: Export, root = process.cwd()): string[] {
  const problems: string[] = [];
  if (exp.schema !== 'w11-labels/1') problems.push(`unknown schema ${exp.schema}`);
  const data = exp.packet === 'chronicle' ? chronicleData(root) : exp.packet === 'cat35' ? cat35Data(root) : null;
  if (!data) return [...problems, `unknown packet ${exp.packet}`];
  if (exp.packet_sha256 !== sha256(embedJson(data))) problems.push('packet SHA does not match the packet these scripts generate today');
  for (const [path, h] of Object.entries(data.label_files)) if (exp.label_files?.[path] !== h) problems.push(`label file ${path} changed since the packet was made`);
  if (!exp.reviewer?.trim()) problems.push('no reviewer name');
  const known = new Set(exp.packet === 'chronicle' ? (data as ReturnType<typeof chronicleData>).cards.flatMap(c => c.events.map(e => e.id)) : (data as ReturnType<typeof cat35Data>).rows.map(r => r.id));
  for (const [id, a] of Object.entries(exp.answers ?? {})) {
    if (!known.has(id)) { problems.push(`unknown id ${id}`); continue; }
    if (exp.packet === 'cat35' && a.rating !== undefined && !['FULL', 'PARTIAL', 'ABSENT', 'CANT_TELL'].includes(String(a.rating))) problems.push(`${id}: rating ${a.rating} is not on the scale`);
    if (exp.packet === 'chronicle' && a.outcome === 'error') {
      const errs = (a.errors as string[] | undefined) ?? [];
      if (errs.length === 0) problems.push(`${id}: "has an error" without an error type`);
      if (errs.includes('date') && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.corrected_day ?? ''))) problems.push(`${id}: date error without a corrected day`);
    }
  }
  if (exp.packet === 'chronicle') {
    const slugs = new Set((data as ReturnType<typeof chronicleData>).cards.map(c => c.slug));
    for (const [slug, list] of Object.entries(exp.extras ?? {})) {
      if (!slugs.has(slug)) problems.push(`missed events on unknown page ${slug}`);
      for (const m of list) if (!/^\d{4}-\d{2}-\d{2}$/.test(m.day) || !m.description?.trim() || !m.keywords?.length) problems.push(`${slug}: a missed event lacks day, description or keywords`);
    }
  }
  return problems;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Kappa with a bootstrap interval that resamples transcripts (clusters), not rows. */
export function clusteredKappa(pairs: Array<{ cluster: string; judge: string; human: string }>, draws = 5000, seed = 20261006) {
  const kappa = weightedKappa(pairs.map(p => p.judge), pairs.map(p => p.human));
  const clusters = [...new Set(pairs.map(p => p.cluster))];
  const byCluster = new Map(clusters.map(c => [c, pairs.filter(p => p.cluster === c)]));
  const rand = mulberry32(seed);
  const samples: number[] = [];
  for (let d = 0; d < draws; d++) {
    const draw = Array.from({ length: clusters.length }, () => byCluster.get(clusters[Math.floor(rand() * clusters.length)]!)!).flat();
    const k = weightedKappa(draw.map(p => p.judge), draw.map(p => p.human));
    if (Number.isFinite(k)) samples.push(k);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples.length ? samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]! : NaN;
  return { kappa, lo: q(0.025), hi: q(0.975), clusters: clusters.length, finite_draws: samples.length };
}

export function scoreCat35(exp: Export, root = process.cwd()) {
  const cal = JSON.parse(readFileSync(join(root, CAT35_CALIBRATION), 'utf8')) as { entries: Array<{ slot: string; item_id_or_ref: string; transcript_id: string; lane_hint: string; judge_verdict: string | null }> };
  const judge = new Map(cal.entries.filter(e => e.slot === 'coverage').map(e => [`${e.transcript_id}.${e.lane_hint}.${e.item_id_or_ref}`, { verdict: e.judge_verdict!, transcript: e.transcript_id }]));
  const rows = cat35Data(root).rows;
  const answered = rows.filter(r => exp.answers[r.id]?.rating);
  const cantTell = answered.filter(r => exp.answers[r.id]!.rating === 'CANT_TELL').length;
  const pairsFor = (rs: typeof rows) => rs.filter(r => exp.answers[r.id]?.rating && exp.answers[r.id]!.rating !== 'CANT_TELL').map(r => ({ cluster: judge.get(r.id)!.transcript, judge: judge.get(r.id)!.verdict, human: String(exp.answers[r.id]!.rating) }));
  const headline = pairsFor(rows.filter(r => !r.note_empty));
  const all = pairsFor(rows);
  const labels = ['FULL', 'PARTIAL', 'ABSENT'];
  const confusion = Object.fromEntries(labels.map(j => [j, Object.fromEntries(labels.map(h => [h, headline.filter(p => p.judge === j && p.human === h).length]))]));
  const minimum = 12;
  let decision: string; let reason: string;
  const stats = headline.length >= 2 ? clusteredKappa(headline) : null;
  if (headline.length < minimum) { decision = 'pending'; reason = `${headline.length} eligible ratings; publishing needs ${minimum}`; }
  else if (!stats || !Number.isFinite(stats.kappa)) { decision = 'undefined'; reason = 'kappa is undefined for these ratings'; }
  else if (stats.hi - stats.lo > 0.5) { decision = 'imprecise'; reason = `interval ${stats.lo.toFixed(2)} to ${stats.hi.toFixed(2)} is wider than 0.5`; }
  else if (stats.lo >= 0.4) { decision = 'calibrated'; reason = `lower bound ${stats.lo.toFixed(2)} >= 0.4`; }
  else if (stats.hi < 0.4) { decision = 'not_calibrated'; reason = `upper bound ${stats.hi.toFixed(2)} < 0.4`; }
  else { decision = 'moderate'; reason = `interval ${stats.lo.toFixed(2)} to ${stats.hi.toFixed(2)} straddles 0.4`; }
  return {
    packet: 'cat35', reviewer: exp.reviewer, rated: answered.length, of: rows.length, cant_tell: cantTell,
    context_changes_answer: answered.filter(r => exp.answers[r.id]!.context_changes_answer).length,
    headline: { population: 'answered rows with a non-empty note, excluding can\'t tell', n: headline.length, agreement: headline.filter(p => p.judge === p.human).length, ...(stats ?? {}) },
    all_rows: { n: all.length, agreement: all.filter(p => p.judge === p.human).length, kappa: all.length ? weightedKappa(all.map(p => p.judge), all.map(p => p.human)) : NaN },
    confusion_judge_by_human: confusion, publication: { decision, reason },
  };
}

export function revisedReference(exp: Export, root = process.cwd()) {
  const data = chronicleData(root);
  const pages = data.cards.map(card => {
    const events: GoldEvent[] = [];
    let unresolved = 0;
    for (const ev of card.events) {
      const a = exp.answers[ev.id] ?? {};
      const errs = (a.errors as string[] | undefined) ?? [];
      if (a.outcome === 'error' && errs.includes('not_event')) continue;
      if (a.outcome === 'cant_tell') unresolved++;
      const keywords = a.outcome === 'error' && typeof a.corrected_keywords === 'string' && a.corrected_keywords.trim() ? a.corrected_keywords.split(',').map(s => s.trim()).filter(Boolean) : ev.keywords;
      const day = a.outcome === 'error' && errs.includes('date') ? String(a.corrected_day) : ev.day;
      events.push({ id: ev.id, day, kind: ev.kind, keywords, basis: ev.basis });
    }
    for (const [i, m] of (exp.extras?.[card.slug] ?? []).entries()) events.push({ id: `${card.slug}#added-${i + 1}`, day: m.day, kind: 'added', keywords: m.keywords, basis: m.description });
    return { slug: card.slug, page_date: card.page_date, events, unresolved };
  });
  return pages;
}

export function scoreChronicle(exp: Export, root = process.cwd()) {
  const pages = revisedReference(exp, root);
  const size = pages.reduce((n, p) => n + p.events.length, 0);
  const reviewed = Object.values(exp.answers).filter(a => a.outcome).length;
  const rule = Math.ceil((34 / 38) * size);
  const runs = Object.fromEntries(['on-a', 'on-b'].map(arm => {
    const events = JSON.parse(readFileSync(join(root, RERUN, `events-${arm}.json`), 'utf8')) as Extracted[];
    const matched = pages.reduce((n, p) => n + matchPage(p.events, events.filter(e => e.depth === p.slug)).length, 0);
    return [arm, { matched, of: size, passes_recall_rule: matched >= rule }];
  }));
  const outcomes = Object.values(exp.answers).map(a => a.outcome);
  const complete = reviewed === 38;
  return {
    packet: 'chronicle', reviewer: exp.reviewer, reviewed, of: 38,
    supported: outcomes.filter(o => o === 'supported').length, corrected: outcomes.filter(o => o === 'error').length, cant_tell: outcomes.filter(o => o === 'cant_tell').length,
    added: Object.values(exp.extras ?? {}).flat().length, revised_reference_size: size, recall_rule: `matched >= ceil(34/38 x ${size}) = ${rule}`, runs,
    rule_disagreement: exp.rule_disagreement ?? '',
    publication: { decision: complete ? 'publish' : reviewed > 0 ? 'publish_partial' : 'pending', reason: complete ? 'all 38 labeled events reviewed' : `${reviewed} of 38 labeled events reviewed; banner generated from reviewed counts` },
  };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error('usage: bun scripts/w11-score.ts <w11-labels-*.json> [--store <dir>]'); process.exit(2); }
  const exp = JSON.parse(readFileSync(file, 'utf8')) as Export;
  const problems = validate(exp);
  if (problems.length) { for (const p of problems) console.error(`w11-score: ${p}`); process.exit(1); }
  const result = exp.packet === 'cat35' ? scoreCat35(exp) : scoreChronicle(exp);
  const storeIdx = process.argv.indexOf('--store');
  if (storeIdx > 0) {
    const dir = process.argv[storeIdx + 1]!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `labels-${exp.packet}.json`), JSON.stringify(exp, null, 2) + '\n');
    writeFileSync(join(dir, `score-${exp.packet}.json`), JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
}

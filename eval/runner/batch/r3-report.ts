#!/usr/bin/env bun
/**
 * R3's keyless report (W10 preregistration, amendment of 2026-11-16): re-scores the committed R3 rows, runs the
 * preregistered families through compare.ts, and writes summary.json and the compare files beside them.
 *
 *   bun eval/runner/batch/r3-report.ts [--write]
 *
 * Without --write it exits 1 when the committed summary.json or a compare file differs from the re-score.
 *
 * Judges: every reader row has the official gpt-4o-2024-08-06 verdict and a cross-family co-judge's verdict
 * (gpt-6.1-sol on Opus 5.5 and particle-1 rows, claude-opus-5-5 on GPT-6.1 Sol rows). A reader error or empty answer
 * is wrong under both. A reader's non-inferiority claim counts only when it passes under both judges and its co-judge
 * passed the judge check (r3-judge-check.ts); particle-1 is descriptive.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCompare, type CompareOutput } from '../compare.ts';
import { exactMcNemar } from '../stats/paired.ts';
import { normalizeUsage, usageSourceOf } from '../usage-receipt.ts';
import { crossArmRows } from './receipts.ts';
import { readNdjson } from './sources.ts';
import { R3_DIR, subsets, types } from './w10.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const W10C = join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms');
const W10A_CAPTURE = join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture/harness-rows.ndjson.gz');
const OPAQUE_FINAL = join(ROOT, 'docs/benchmarks/2026-10-04-longmemeval-opaque-followups/1a-harness/FINAL/rows.ndjson.gz');
const REPLAY = join(ROOT, 'docs/benchmarks/2026-11-01-longmemeval-particle-replay/arms');
/** The verbatim-session system's strict recall@5 (90.0% of 470): below it, README's strict-recall heading comes down. */
export const RIDER_BAR = 423;

export interface Verdicts { official: 0 | 1; cojudge: 0 | 1 | null; reader_error: string | null; usd: number; list_usd: number; input_tokens: number; output_tokens: number; finish: string | null }
export type Arm = Map<string, Verdicts>;

const bit = (x: unknown): 0 | 1 => (x === 1 || x === true ? 1 : 0);
const tokens = (r: Record<string, any>) => {
  if (!r.usage) return { input_tokens: 0, output_tokens: 0 };
  const u = normalizeUsage(r.model ? usageSourceOf(String(r.model).includes(':') ? r.model : (String(r.model).startsWith('claude') ? 'anthropic:' : 'openai:') + r.model) : 'openai', r.usage);
  return { input_tokens: u?.input_total ?? 0, output_tokens: u?.output_total ?? 0 };
};
/** Co-judge verdicts by question id from a judge-only export (w10.ts export-judge). */
const judgeRows = (dir: string): Map<string, 0 | 1> => new Map(readNdjson(join(dir, 'rows.ndjson')).map(r => [r.question_id, bit(r.correct)]));

/** A batch arm R3 ran (w10.ts export): official, and the co-judge column for its reader's family. */
export function batchArm(dir: string, cojudge: 'secondary' | 'opus'): Arm {
  return new Map(readNdjson(join(dir, 'rows.ndjson')).map(r => [r.question_id, {
    official: r.error ? 0 : bit(r.correct_official), cojudge: r.error ? 0 : (r['correct_' + cojudge] === undefined || r['correct_' + cojudge] === null ? null : bit(r['correct_' + cojudge])),
    reader_error: r.error ?? null, usd: r.usd ?? 0, list_usd: r.list_usd ?? 0, finish: r.finish ?? null, ...tokens(r),
  }]));
}

/** Committed rows judged again by an R3 co-judge: W10c's Sol rows, or R3's particle-1 rows. */
export function storedArm(rowsPath: string, cojudgeDir: string | null): Arm {
  const co = cojudgeDir && existsSync(join(cojudgeDir, 'rows.ndjson')) ? judgeRows(cojudgeDir) : null;
  return new Map(readNdjson(rowsPath).map(r => {
    const wrong = Boolean(r.error) || typeof r.hypothesis !== 'string' || r.hypothesis.trim() === '';
    return [r.question_id, {
      official: wrong ? 0 : bit(r.correct_official), cojudge: co === null ? null : wrong ? 0 : (co.get(r.question_id) ?? 0),
      reader_error: r.error ?? null, usd: r.usd ?? 0, list_usd: r.list_usd ?? r.usd ?? 0, finish: r.finish ?? null, ...tokens(r),
    }];
  }));
}

const col = (arm: Arm, judge: 'official' | 'cojudge') => new Map([...arm].map(([id, v]) => [id, (judge === 'official' ? v.official : v.cojudge ?? 0) as 0 | 1]));

function summarizeArm(arm: Arm) {
  const xs = [...arm.values()];
  const t = types();
  const byType: Record<string, { total: number; official: number; cojudge: number | null }> = {};
  for (const [id, v] of arm) {
    const b = byType[t.get(id)!] ??= { total: 0, official: 0, cojudge: v.cojudge === null ? null : 0 };
    b.total++; b.official += v.official;
    if (b.cojudge !== null) b.cojudge += v.cojudge ?? 0;
  }
  const official = xs.reduce((a, v) => a + v.official, 0);
  const hasCo = xs.some(v => v.cojudge !== null);
  const usd = xs.reduce((a, v) => a + v.usd, 0), listUsd = xs.reduce((a, v) => a + v.list_usd, 0);
  return {
    n: xs.length, official, cojudge: hasCo ? xs.reduce((a, v) => a + (v.cojudge ?? 0), 0) : null,
    judges_agree: hasCo ? xs.filter(v => !v.reader_error && v.cojudge !== null && v.official === v.cojudge).length : null,
    reader_errors: xs.filter(v => v.reader_error).length, max_tokens_finishes: xs.filter(v => v.finish === 'max_tokens' || v.finish === 'length').length,
    mean_input_tokens: Math.round(xs.reduce((a, v) => a + v.input_tokens, 0) / xs.length), mean_output_tokens: Math.round(xs.reduce((a, v) => a + v.output_tokens, 0) / xs.length),
    reader_usd_per_question: Number((usd / xs.length).toFixed(5)), reader_list_usd_per_question: Number((listUsd / xs.length).toFixed(5)),
    reader_usd_per_correct_official: official ? Number((usd / official).toFixed(5)) : null,
    by_type: Object.fromEntries(Object.entries(byType).sort()),
  };
}

const compact = (d: CompareOutput['decision']) => ({
  family_id: d.family_id, verdict: d.verdict,
  comparisons: d.comparisons.map(c => ({ id: c.id, status: c.status, n_pairs: c.n_pairs, mean_a: c.stats?.mean_a, mean_b: c.stats?.mean_b, delta: c.stats?.delta, ci95: c.stats?.ci95, mcnemar: c.mcnemar, p_superiority: c.p_superiority, p_noninferiority: c.p_noninferiority, p_holm: c.p_holm, power: c.power?.note })),
});

function compare(name: string, family: string | null, arms: { field: string; rows: Map<string, 0 | 1>; comparator: Map<string, 0 | 1> }[], ids: string[], dir: string) {
  const { a, b } = crossArmRows(arms, ids);
  const pa = join(dir, 'compare-' + name + '-a.ndjson'), pb = join(dir, 'compare-' + name + '-b.ndjson');
  writeFileSync(pa, a.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(pb, b.map(r => JSON.stringify(r)).join('\n') + '\n');
  return compact(runCompare({ a: pa, b: pb, ...(family ? { family } : {}), metrics: family ? [] : arms.map(x => x.field), excludeWhen: [], where: [], aWhere: [], bWhere: [], seed: 20261116, draws: 10000, alpha: 0.05, json: true }).decision);
}

/** Strict recall@5 (every labelled evidence session in the top five) over the 470 answerable questions of a harness rows file. */
export function strictRecall(path: string): Map<string, 0 | 1> {
  return new Map(readNdjson(path).filter(r => typeof r.question_id === 'string' && !r.abstention).map(r => [r.question_id, bit(r.recall_all_hit)]));
}

const mcnemar = (base: Map<string, 0 | 1>, cand: Map<string, 0 | 1>) => {
  const ids = [...cand.keys()].filter(id => base.has(id)).sort();
  if (ids.length !== cand.size || ids.length !== base.size) throw new Error('paired rows need the same question ids on both sides');
  const m = exactMcNemar(ids.map(id => ({ id, cluster: id, a: base.get(id)!, b: cand.get(id)! })));
  return { n: ids.length, base: ids.reduce((a, id) => a + base.get(id)!, 0), candidate: ids.reduce((a, id) => a + cand.get(id)!, 0), ...m };
};

export function report(dir: string, r3: string = R3_DIR): Record<string, unknown> {
  const ids = subsets.w10c150();
  const arms: Record<string, Arm> = {
    'r3-opus55-newest': batchArm(join(r3, 'arms/r3-opus55-newest'), 'secondary'),
    'r3-opus55-full': batchArm(join(r3, 'arms/r3-opus55-full'), 'secondary'),
    'r3-sol-newest': batchArm(join(r3, 'arms/r3-sol-newest'), 'opus'),
    'w10c-sol-full': storedArm(join(W10C, 'w10c-sol-full/rows.ndjson'), join(r3, 'judges/w10c-sol-full--opus')),
    'w10c-sol-currentpin': storedArm(join(W10C, 'w10c-sol-currentpin/rows.ndjson'), join(r3, 'judges/w10c-sol-currentpin--opus')),
  };
  for (const p of ['newest', 'full', 'currentpin']) {
    const rows = join(r3, 'arms/r3-particle-' + p + '/rows.ndjson');
    if (existsSync(rows)) arms['r3-particle-' + p] = storedArm(rows, join(r3, 'judges/r3-particle-' + p + '--secondary'));
  }
  for (const [id, arm] of Object.entries(arms)) if (arm.size !== 150 || ids.some(q => !arm.has(q))) throw new Error(id + ': ' + arm.size + ' rows, not the 150 W10c questions');
  const check = existsSync(join(r3, 'judge-check/report.json')) ? JSON.parse(readFileSync(join(r3, 'judge-check/report.json'), 'utf8')) : null;
  const counts = { opus: check?.judges?.['cojudge-sol']?.pass === true, sol: check?.judges?.['cojudge-opus']?.pass === true };
  const pairs = (judge: 'official' | 'cojudge', gbrain: boolean) => [
    { field: 'correct__opus', rows: col(arms[gbrain ? 'r3-opus55-newest' : 'r3-opus55-full'], judge), comparator: col(arms[gbrain ? 'r3-opus55-full' : 'r3-opus55-newest'], judge) },
    { field: 'correct__sol', rows: col(arms[gbrain ? 'r3-sol-newest' : 'w10c-sol-full'], judge), comparator: col(arms[gbrain ? 'w10c-sol-full' : 'r3-sol-newest'], judge) },
  ];
  const families: Record<string, unknown> = {};
  for (const judge of ['official', 'cojudge'] as const) {
    families['noninferiority-' + judge] = compare('r3-noninferiority-' + judge, join(r3, 'families', 'r3-noninferiority-' + judge + '.json'), pairs(judge, true), ids, dir);
    families['loss-' + judge] = compare('r3-loss-' + judge, join(r3, 'families', 'r3-loss-' + judge + '.json'), pairs(judge, false), ids, dir);
  }
  const hasParticle = Boolean(arms['r3-particle-newest'] && arms['r3-particle-full'] && arms['r3-particle-currentpin']);
  const descriptive: Record<string, unknown> = {};
  for (const judge of ['official', 'cojudge'] as const) {
    if (hasParticle) {
      families['oldbuild-' + judge] = compare('r3-oldbuild-' + judge, join(r3, 'families', 'r3-oldbuild-' + judge + '.json'), [
        { field: 'correct__sol', rows: col(arms['w10c-sol-currentpin'], judge), comparator: col(arms['r3-sol-newest'], judge) },
        { field: 'correct__particle', rows: col(arms['r3-particle-currentpin'], judge), comparator: col(arms['r3-particle-newest'], judge) },
      ], ids, dir);
      descriptive['particle-gbrain-vs-full-' + judge] = compare('r3-particle-' + judge, null, [{ field: 'correct__particle', rows: col(arms['r3-particle-newest'], judge), comparator: col(arms['r3-particle-full'], judge) }], ids, dir);
    }
  }
  const replay = (a: string) => new Map(readNdjson(join(REPLAY, a, 'rows.ndjson')).map(r => [r.question_id as string, bit(r.correct_official)]));
  if (hasParticle) descriptive['particle-weights-nov1-vs-today-official'] = {
    full: mcnemar(replay('w10c-particle-full'), col(arms['r3-particle-full'], 'official')),
    currentpin: mcnemar(replay('w10c-particle-currentpin'), col(arms['r3-particle-currentpin'], 'official')),
  };
  const verdictOf = (reader: 'opus55' | 'sol') => {
    const pick = (fam: string) => ((families[fam] as ReturnType<typeof compact>).comparisons.find(c => c.id.endsWith(reader))?.status ?? null);
    const ni = { official: pick('noninferiority-official'), cojudge: pick('noninferiority-cojudge') };
    const loss = { official: pick('loss-official'), cojudge: pick('loss-cojudge') };
    const cojudgeChecked = reader === 'opus55' ? counts.opus : counts.sol;
    return {
      noninferiority: ni, loss, cojudge_passed_check: cojudgeChecked,
      claim: ni.official === 'pass' && ni.cojudge === 'pass' && cojudgeChecked ? 'within 7 points (both judges)'
        : loss.official === 'pass' && loss.cojudge === 'pass' && cojudgeChecked ? 'whole history better by more than 7 points (both judges)'
        : 'no claim: the two judges do not both show it, or the co-judge failed its check',
    };
  };
  const capture = join(r3, 'capture/harness-rows.ndjson.gz');
  const newest = strictRecall(capture);
  const harness = new Map(readNdjson(capture).filter(r => typeof r.question_id === 'string').map(r => [r.question_id as string, r]));
  const failures = (gbrain: string, full: string) => ids.filter(id => arms[full].get(id)!.official === 1 && arms[gbrain].get(id)!.official === 0).map(id => ({
    question_id: id, question_type: types().get(id), every_needed_session_in_top5: harness.get(id)?.abstention ? null : bit(harness.get(id)?.recall_all_hit),
  }));
  const captureRun = existsSync(join(r3, 'capture/capture-run.json')) ? JSON.parse(readFileSync(join(r3, 'capture/capture-run.json'), 'utf8')) : null;
  return {
    kind: 'r3', gbrain: captureRun?.gbrain ?? null,
    arms: Object.fromEntries(Object.entries(arms).map(([id, a]) => [id, summarizeArm(a)])),
    two_reader_mean_official: {
      gbrain_newest: (summarizeArm(arms['r3-opus55-newest']).official + summarizeArm(arms['r3-sol-newest']).official) / 2,
      whole_history: (summarizeArm(arms['r3-opus55-full']).official + summarizeArm(arms['w10c-sol-full']).official) / 2,
    },
    judge_check: check ? { labeller_kappa: check.labeller_kappa, cojudge_sol_on_claude_and_particle: check.judges['cojudge-sol'], cojudge_opus_on_gpt: check.judges['cojudge-opus'] } : null,
    families, verdicts: { 'claude-opus-5-5': verdictOf('opus55'), 'gpt-6.1-sol': verdictOf('sol') }, descriptive,
    whole_history_wins_official: { 'claude-opus-5-5': failures('r3-opus55-newest', 'r3-opus55-full'), 'gpt-6.1-sol': failures('r3-sol-newest', 'w10c-sol-full') },
    rider_strict_recall_at_5: {
      newest: { hits: [...newest.values()].reduce<number>((a, v) => a + v, 0), of: newest.size }, bar: RIDER_BAR,
      heading_stays: [...newest.values()].reduce<number>((a, v) => a + v, 0) >= RIDER_BAR,
      vs_c5fb0201: mcnemar(strictRecall(W10A_CAPTURE), newest), vs_109b992_published: mcnemar(strictRecall(OPAQUE_FINAL), newest),
    },
    retrieval: captureRun ? { spend_by_model: captureRun.retrieval_by_model ?? null, questions: 500 } : null,
  };
}

async function main(argv: string[]): Promise<number> {
  const write = argv.includes('--write');
  if (write) for (const f of readdirSync(R3_DIR).sort()) if (f.startsWith('compare-')) rmSync(join(R3_DIR, f));
  const dir = write ? R3_DIR : mkdtempSync(join(tmpdir(), 'r3-report-'));
  try {
    const text = JSON.stringify(report(dir), null, 1) + '\n';
    console.log(text);
    if (write) { writeFileSync(join(R3_DIR, 'summary.json'), text); return 0; }
    const same = (name: string, fresh: string) => existsSync(join(R3_DIR, name)) && readFileSync(join(R3_DIR, name), 'utf8') === fresh;
    const fresh = readdirSync(dir).sort();
    const stale = readdirSync(R3_DIR).sort().filter(f => f.startsWith('compare-') && !fresh.includes(f));
    const differs = [...(same('summary.json', text) ? [] : ['summary.json']), ...fresh.filter(f => !same(f, readFileSync(join(dir, f), 'utf8'))), ...stale];
    if (differs.length) { console.error('re-score differs: ' + differs.join(', ')); return 1; }
    return 0;
  } finally {
    if (!write) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}

#!/usr/bin/env bun
/**
 * Keyless $0 re-score of the W10 LongMemEval receipts and the W8
 * LongMemEval control from committed rows: recomputes every verdict from the
 * stored judge replies ("yes" in the lowercased reply), counts reader errors
 * as wrong, rebuilds the paired files and runs the preregistered comparison
 * families through `compare.ts`.
 *
 *   bun eval/runner/batch/w10-rescore.ts w10b <receipt dir>
 *   bun eval/runner/batch/w10-rescore.ts w10a <receipt dir> <w10b receipt dir>
 *   bun eval/runner/batch/w10-rescore.ts w10c <receipt dir> <w10a receipt dir>
 *   bun eval/runner/batch/w10-rescore.ts w8   <receipt dir> <w10b receipt dir>
 *
 * Add --write to (re)write summary.json; without it the command checks the
 * committed summary.json and exits 1 on any difference.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCompare, type CompareOutput } from '../compare.ts';
import { exactMcNemar } from '../stats/paired.ts';
import { crossArmRows } from './receipts.ts';
import { judgeVerdict, readNdjson } from './sources.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const FAMILIES = join(ROOT, 'docs/benchmarks/2026-10-06-longmemeval-w10-families');
const OPAQUE = join(ROOT, 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on');

export interface Scored { question_id: string; question_type: string; official: 0 | 1; secondary: 0 | 1 | null; reader_error: string | null; finish: string | null; usd: number; output_tokens: number; input_tokens: number }

const verdict = (j: { raw?: string | null; error?: string | null } | null | undefined): 0 | 1 => (j && !j.error && typeof j.raw === 'string' && judgeVerdict(j.raw) ? 1 : 0);
const num = (u: Record<string, unknown> | null, ...keys: string[]) => keys.reduce((s, k) => s + (typeof u?.[k] === 'number' ? (u[k] as number) : 0), 0);

/** Re-score one exported arm from its rows: judge verdicts from the stored replies, reader errors wrong. */
export function scoreArm(dir: string): Map<string, Scored> {
  const out = new Map<string, Scored>();
  for (const r of readNdjson(join(dir, 'rows.ndjson'))) {
    const hasSecondary = r.secondary !== null && r.secondary !== undefined;
    out.set(r.question_id, {
      question_id: r.question_id, question_type: r.question_type,
      official: r.error ? 0 : verdict(r.official), secondary: hasSecondary ? (r.error ? 0 : verdict(r.secondary)) : null,
      reader_error: r.error ?? null, finish: r.finish ?? null, usd: r.usd ?? 0,
      output_tokens: num(r.usage, 'output_tokens', 'completion_tokens'), input_tokens: num(r.usage, 'input_tokens', 'prompt_tokens'),
    });
  }
  return out;
}

/** The replayed Sonnet 4.6 run: official verdicts from the committed 2026-09-29 judge file, secondary from this round's export. */
export function baseline(run: 'r1' | 'r2', secondaryDir: string | null): Map<string, Scored> {
  const rows = readNdjson(join(OPAQUE, run, 'rows.ndjson')).filter(r => typeof r.question_id === 'string');
  const off = new Map(readNdjson(join(OPAQUE, run, 'official-judge.ndjson')).map(r => [r.question_id, r]));
  const sec = secondaryDir && existsSync(join(secondaryDir, 'rows.ndjson')) ? new Map(readNdjson(join(secondaryDir, 'rows.ndjson')).map(r => [r.question_id, r])) : null;
  return new Map(rows.map(r => [r.question_id, {
    question_id: r.question_id, question_type: r.question_id.endsWith('_abs') ? 'abstention' : r.question_type,
    official: off.get(r.question_id)?.off_judge_correct === true ? 1 : 0,
    secondary: sec ? verdict(sec.get(r.question_id)?.secondary) : null,
    reader_error: r.error ?? null, finish: r.reader_finish_reason ?? null, usd: 0, output_tokens: 0, input_tokens: 0,
  } satisfies Scored]));
}

function armSummary(rows: Map<string, Scored>) {
  const xs = [...rows.values()];
  const count = (f: (s: Scored) => string | null) => xs.reduce((m, s) => { const k = f(s); return k === null ? m : { ...m, [k]: (m[k] ?? 0) + 1 }; }, {} as Record<string, number>);
  const byType: Record<string, { total: number; official: number; secondary: number | null }> = {};
  for (const s of xs) {
    const t = byType[s.question_type] ??= { total: 0, official: 0, secondary: s.secondary === null ? null : 0 };
    t.total++; t.official += s.official;
    if (t.secondary !== null) t.secondary += s.secondary ?? 0;
  }
  const both = xs.filter(s => s.secondary !== null && !s.reader_error);
  return {
    n: xs.length, official: xs.reduce((a, s) => a + s.official, 0),
    secondary: xs.some(s => s.secondary !== null) ? xs.reduce((a, s) => a + (s.secondary ?? 0), 0) : null,
    judges_agree: both.length ? both.filter(s => s.official === s.secondary).length : null, judged_by_both: both.length,
    reader_errors: count(s => s.reader_error), max_tokens_finishes: xs.filter(s => s.finish === 'max_tokens').length,
    by_type: Object.fromEntries(Object.entries(byType).sort()), usd: Number(xs.reduce((a, s) => a + s.usd, 0).toFixed(6)),
    mean_input_tokens: xs.length ? Math.round(xs.reduce((a, s) => a + s.input_tokens, 0) / xs.length) : 0,
    mean_output_tokens: xs.length ? Math.round(xs.reduce((a, s) => a + s.output_tokens, 0) / xs.length) : 0,
  };
}

function family(name: string, arms: { field: string; rows: Map<string, 0 | 1>; comparator: Map<string, 0 | 1>; subset?: boolean }[], ids: string[], dir: string): CompareOutput['decision'] {
  const { a, b } = crossArmRows(arms, ids);
  const pa = join(dir, `compare-${name}-a.ndjson`), pb = join(dir, `compare-${name}-b.ndjson`);
  writeFileSync(pa, a.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(pb, b.map(r => JSON.stringify(r)).join('\n') + '\n');
  const out = runCompare({ a: pa, b: pb, family: join(FAMILIES, `${name}.json`), metrics: [], excludeWhen: [], where: [], aWhere: [], bWhere: [], seed: 42, draws: 10000, alpha: 0.05, json: true });
  return out.decision;
}

const col = (rows: Map<string, Scored>, key: 'official' | 'secondary') => new Map([...rows].map(([id, s]) => [id, (s[key] ?? 0) as 0 | 1]));

const compact = (d: CompareOutput['decision']) => ({
  family_id: d.family_id, verdict: d.verdict, holm_family: d.holm_family,
  comparisons: d.comparisons.map(c => ({ id: c.id, status: c.status, n_pairs: c.n_pairs, mean_a: c.stats?.mean_a, mean_b: c.stats?.mean_b, delta: c.stats?.delta, ci95: c.stats?.ci95, mcnemar: c.mcnemar, p_superiority: c.p_superiority, p_noninferiority: c.p_noninferiority, p_holm: c.p_holm, power: c.power?.note })),
});

export function rescore(kind: string, dir: string, other?: string): Record<string, unknown> {
  const arm = (id: string) => scoreArm(join(dir, 'arms', id));
  if (kind === 'w10b') {
    const r1 = baseline('r1', join(dir, 'baselines', 'r1-sonnet46'));
    const r2 = baseline('r2', join(dir, 'baselines', 'r2-sonnet46'));
    const defs = [
      ['correct__sonnet55_notes', 'w10b-sonnet55-notes', r1], ['correct__sonnet55_direct', 'w10b-sonnet55-direct', r2], ['correct__sol_notes', 'w10b-sol-notes', r1],
      ['correct__gpt54_official', 'w10b-gpt54-official', r1], ['correct__opus55_notes', 'w10b-opus55-notes', r1], ['correct__fable51_notes', 'w10b-fable51-notes', r1],
    ] as const;
    const present = defs.filter(([, id]) => existsSync(join(dir, 'arms', id, 'rows.ndjson')));
    const scored = Object.fromEntries(present.map(([, id]) => [id, arm(id)]));
    const ids = [...r1.keys()].sort();
    const fam = (key: 'official' | 'secondary', name: string) => present.length ? compact(family(name, present.map(([field, id, base]) => ({ field, rows: col(scored[id], key), comparator: col(base, key), subset: scored[id].size < 500 })), ids, dir)) : null;
    const notesDirect = scored['w10b-sonnet55-notes'] && scored['w10b-sonnet55-direct']
      ? (['official', 'secondary'] as const).map(k => ({ judge: k, ...exactMcNemar(ids.map(id => ({ id, cluster: id, a: scored['w10b-sonnet55-direct'].get(id)![k] ?? 0, b: scored['w10b-sonnet55-notes'].get(id)![k] ?? 0 }))) })) : null;
    return {
      kind, arms: Object.fromEntries(present.map(([, id]) => [id, armSummary(scored[id])])),
      comparators: { 'r1-sonnet46-notes': armSummary(r1), 'r2-sonnet46-direct': armSummary(r2), 'r1-sonnet46-notes-on-fable200': scored['w10b-fable51-notes'] ? armSummary(new Map([...r1].filter(([id]) => scored['w10b-fable51-notes'].has(id)))) : null },
      families: { official: fam('official', 'w10b-official'), secondary: r1.values().next().value!.secondary === null ? null : fam('secondary', 'w10b-secondary') },
      notes_vs_direct_sonnet55: notesDirect,
    };
  }
  if (kind === 'w10a') {
    const a = arm('w10a-sonnet55-notes');
    const b = scoreArm(join(other!, 'arms', 'w10b-sonnet55-notes'));
    const ids = [...a.keys()].sort();
    const rows = (s: Map<string, Scored>) => ids.map(id => ({ question_id: id, correct_official: s.get(id)!.official, correct_secondary: s.get(id)!.secondary }));
    const pa = join(dir, 'compare-w10a-a.ndjson'), pb = join(dir, 'compare-w10a-b.ndjson');
    writeFileSync(pa, rows(b).map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(pb, rows(a).map(r => JSON.stringify(r)).join('\n') + '\n');
    const d = runCompare({ a: pa, b: pb, family: join(FAMILIES, 'w10a-official.json'), metrics: [], excludeWhen: [], where: [], aWhere: [], bWhere: [], seed: 42, draws: 10000, alpha: 0.05, json: true }).decision;
    return { kind, arms: { 'w10a-sonnet55-notes': armSummary(a), 'w10b-sonnet55-notes': armSummary(b) }, family: compact(d) };
  }
  if (kind === 'w10c') {
    const w10a = scoreArm(join(other!, 'arms', 'w10a-sonnet55-notes'));
    const solPin = arm('w10c-sol-currentpin');
    const ids = [...solPin.keys()].sort();
    const sub = (m: Map<string, Scored>) => new Map(ids.map(id => [id, m.get(id)!]));
    const gb = { sonnet55: sub(w10a), sol: solPin };
    const full = { sonnet55: arm('w10c-sonnet55-full'), sol: arm('w10c-sol-full') };
    const fields = (['sonnet55', 'sol'] as const);
    const ni = compact(family('w10c-noninferiority', fields.map(r => ({ field: `correct__${r}`, rows: col(gb[r], 'official'), comparator: col(full[r], 'official') })), ids, dir));
    const loss = compact(family('w10c-loss', fields.map(r => ({ field: `correct__${r}`, rows: col(full[r], 'official'), comparator: col(gb[r], 'official') })), ids, dir));
    return { kind, ids: ids.length, arms: { 'gbrain-sonnet55 (w10a rows)': armSummary(gb.sonnet55), 'w10c-sol-currentpin': armSummary(solPin), 'w10c-sonnet55-full': armSummary(full.sonnet55), 'w10c-sol-full': armSummary(full.sol) }, families: { noninferiority: ni, loss } };
  }
  if (kind === 'w8') {
    const real = scoreArm(join(other!, 'arms', 'w10b-sonnet55-notes'));
    const swap = arm('w8-lme-swap');
    const ids = [...swap.keys()].sort();
    const realScore = ids.reduce((a, id) => a + real.get(id)!.official, 0);
    const swapScore = ids.reduce((a, id) => a + swap.get(id)!.official, 0);
    const partial = existsSync(join(dir, 'arms', 'w8-lme-partial', 'rows.ndjson')) ? arm('w8-lme-partial') : null;
    const pids = partial ? [...partial.keys()].sort() : [];
    return {
      kind, n: ids.length, real_correct: realScore, degraded_correct: swapScore, ratio: realScore ? swapScore / realScore : null,
      signal_floor_met: realScore >= 50, control: realScore < 50 ? 'inconclusive' : swapScore <= 0.5 * realScore ? 'pass' : 'fail',
      degraded_arm: armSummary(swap),
      partial_fault: partial ? { n: pids.length, real_correct: pids.reduce((a, id) => a + real.get(id)!.official, 0), fault_correct: pids.reduce((a, id) => a + partial.get(id)!.official, 0), mcnemar: exactMcNemar(pids.map(id => ({ id, cluster: id, a: real.get(id)!.official, b: partial.get(id)!.official }))), arm: armSummary(partial) } : null,
    };
  }
  throw new Error(`unknown kind ${kind}`);
}

if (import.meta.main) {
  const [kind, dir, other] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const summary = rescore(kind, resolve(dir), other ? resolve(other) : undefined);
  const path = join(resolve(dir), 'summary.json');
  const text = JSON.stringify(summary, null, 1) + '\n';
  if (process.argv.includes('--write')) { writeFileSync(path, text); console.log(text); process.exit(0); }
  const committed = existsSync(path) ? readFileSync(path, 'utf8') : '';
  console.log(text);
  if (committed !== text) { console.error(`re-score differs from ${path}`); process.exit(1); }
  console.error(`re-score matches ${path}`);
}

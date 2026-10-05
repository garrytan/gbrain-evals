#!/usr/bin/env bun
/**
 * Summarize workload-bench runs into Markdown tables and publishable receipts.
 *
 *   bun eval/workload-suites/report.ts [--copy docs/benchmarks/2026-10-05-workload-suites]
 *
 * Reads eval/reports/workload-bench/<suite>/{results,run,spend}.json, the
 * ingest receipts and the B2 arm runs. With --copy, writes per-suite receipts
 * (scored rows without prompts, ingest and presence summaries, spend by
 * label, the run manifest) with machine paths scrubbed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../runner/harness-env.ts';
import { MODEL_CONFIG } from './run-config.ts';

const BENCH = join(REPO_ROOT, 'eval/reports/workload-bench');
export const RUN_DIRS: Record<string, string> = {
  'passing-details': 'passing-details',
  corrections: 'corrections',
  'time-relationships': 'time-relationships-smoke20',
  beliefs: 'beliefs',
};

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : 'n/a';
const scrub = (text: string) => text.split(REPO_ROOT + '/').join('').split(process.env.HOME ?? '/home/user').join('~');

function spendOf(dir: string): { usd: number; by_label: Record<string, number> } {
  const out = { usd: 0, by_label: {} as Record<string, number> };
  if (!existsSync(join(dir, 'spend.json'))) return out;
  for (const r of read(join(dir, 'spend.json')).runs as Array<{ usd: number; stub: boolean; by_label: Record<string, { actual_usd: number }> }>) {
    if (r.stub) continue;
    out.usd += r.usd;
    for (const [k, v] of Object.entries(r.by_label ?? {})) out.by_label[k] = (out.by_label[k] ?? 0) + v.actual_usd;
  }
  return out;
}

export function summarize(): { markdown: string; spend: Record<string, { usd: number; by_label: Record<string, number> }> } {
  const lines: string[] = [];
  const spend: Record<string, { usd: number; by_label: Record<string, number> }> = {};
  for (const [suite, sub] of Object.entries(RUN_DIRS)) {
    const dir = join(BENCH, sub);
    if (!existsSync(join(dir, 'results.json'))) { lines.push(`### ${suite}: no results yet`, ''); continue; }
    const res = read(join(dir, 'results.json')).results as Record<string, Record<string, any>>;
    spend[suite] = spendOf(dir);
    lines.push(`### ${suite}`, '');
    const models = [MODEL_CONFIG.fixed_reader.id, ...MODEL_CONFIG.frontier_sweep.map(m => m.id).filter(m => m !== MODEL_CONFIG.fixed_reader.id)];
    lines.push('| Arm | Reader | Correct | Accuracy | Judged | Delivered tokens (mean / p95) |', '|---|---|---:|---:|---:|---:|');
    for (const arm of Object.keys(res).sort()) {
      for (const m of models) {
        const r = res[arm][m];
        if (!r) continue;
        lines.push(`| ${arm} | ${m} | ${r.correct}/${r.n} | ${pct(r.correct, r.n)} | ${r.judged} | ${r.context_tokens.mean ?? 'n/a'} / ${r.context_tokens.p95 ?? 'n/a'} |`);
      }
    }
    lines.push('');
    const fixed = MODEL_CONFIG.fixed_reader.id;
    const cats = [...new Set(Object.values(res).flatMap(r => Object.keys(r[fixed]?.by_category ?? {})))].sort();
    lines.push(`| Category (fixed reader) | ${Object.keys(res).sort().join(' | ')} |`, `|---|${Object.keys(res).map(() => '---:').join('|')}|`);
    for (const c of cats) lines.push(`| ${c} | ${Object.keys(res).sort().map(a => { const x = res[a][fixed]?.by_category?.[c]; return x ? `${x.correct}/${x.n}` : '-'; }).join(' | ')} |`);
    lines.push('');
    if (suite === 'passing-details') {
      lines.push('| Arm | correct | absent from storage | stored, not retrieved | delivered, misread | unclassified |', '|---|---:|---:|---:|---:|---:|');
      for (const arm of Object.keys(res).sort()) {
        const m = res[arm][fixed]?.misses ?? {};
        lines.push(`| ${arm} | ${m.correct ?? 0} | ${m.absent_from_storage ?? 0} | ${m.stored_not_retrieved ?? 0} | ${m.delivered_but_misread ?? 0} | ${m.unclassified ?? 0} |`);
      }
      lines.push('');
    }
    if (suite === 'corrections') {
      lines.push('| Arm | Before correction | Corrected after 1 write | Stale after 1 | Corrected after 5 writes | Stale after 5 |', '|---|---:|---:|---:|---:|---:|');
      for (const arm of Object.keys(res).sort()) {
        const c = res[arm][fixed]?.checkpoints ?? {};
        const f = (k: string, key: 'correct' | 'stale') => c[k] ? `${c[k][key]}/${c[k].n} (${pct(c[k][key], c[k].n)})` : '-';
        lines.push(`| ${arm} | ${f('0', 'correct')} | ${f('1', 'correct')} | ${f('1', 'stale')} | ${f('5', 'correct')} | ${f('5', 'stale')} |`);
      }
      lines.push('');
    }
    lines.push(`Spend: $${spend[suite]!.usd.toFixed(2)} (${Object.entries(spend[suite]!.by_label).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ')}).`, '');
  }
  return { markdown: lines.join('\n'), spend };
}

export function copyReceipts(target: string): void {
  for (const [suite, sub] of Object.entries(RUN_DIRS)) {
    const dir = join(BENCH, sub);
    if (!existsSync(join(dir, 'results.json'))) continue;
    const out = join(target, suite);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'results.json'), scrub(JSON.stringify(read(join(dir, 'results.json')), null, 1)) + '\n');
    for (const f of ['run.json', 'spend.json']) if (existsSync(join(dir, f))) writeFileSync(join(out, f), scrub(readFileSync(join(dir, f), 'utf8')));
    if (existsSync(join(dir, 'ingest'))) {
      const ingest: Record<string, unknown> = {};
      for (const f of readdirSync(join(dir, 'ingest'))) ingest[f.replace(/\.json$/, '')] = read(join(dir, 'ingest', f));
      writeFileSync(join(out, 'ingest.json'), scrub(JSON.stringify(ingest, null, 1)) + '\n');
    }
    if (existsSync(join(dir, 'corrections-runs'))) {
      const runs: Record<string, unknown> = {};
      for (const f of readdirSync(join(dir, 'corrections-runs'))) runs[f.replace(/\.json$/, '')] = read(join(dir, 'corrections-runs', f));
      writeFileSync(join(out, 'corrections-runs.json'), scrub(JSON.stringify(runs, null, 1)) + '\n');
    }
  }
}

if (import.meta.main) {
  const { markdown, spend } = summarize();
  console.log(markdown);
  console.log(`Total: $${Object.values(spend).reduce((a, s) => a + s.usd, 0).toFixed(2)}`);
  const i = process.argv.indexOf('--copy');
  if (i >= 0) copyReceipts(join(REPO_ROOT, process.argv[i + 1]!));
}

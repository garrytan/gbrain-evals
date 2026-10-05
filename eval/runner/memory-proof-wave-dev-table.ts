/**
 * Collects the memory proof wave's dev cells into one table and copies the
 * receipts the dev report cites.
 *
 *   bun eval/runner/memory-proof-wave-dev-table.ts [--cells-dir D ...] [--json out.json] [--markdown out.md] \
 *     [--copy-receipts DIR --cells id1,id2,...]
 *
 * A row is a dev-sealed cell with a summary: system, build, dataset slice,
 * mode, lane, target, knobs, delivered tokens, score, gates and metered cost.
 * Copied receipts are summary, cell, spec and spend files plus tuning sweeps,
 * with machine-local paths rewritten.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './harness-env.ts';
import { scrubMachinePaths } from './receipt.ts';

export interface DevRow {
  cell_id: string; provider: string; build: string | null; dataset: string; split: string; mode: string; lane: string;
  target: number | null; knobs: Record<string, unknown>; answer: string; judge: string;
  n: number; mean_score: number | null; accuracy: number | null;
  delivered_mean: number | null; delivered_p95: number | null;
  gates: Record<string, boolean>; ok: boolean; usd: number; note: string;
}

const KNOB_KEYS = ['token_budget', 'return_unit', 'limit', 'max_tokens', 'max_chunk_tokens', 'lane', 'facts_budget', 'date_header', 'gbrain_config', 'think_model', 'serve_model'];

function readJson(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }

export function devRow(dir: string): DevRow | null {
  if (!existsSync(join(dir, 'summary.json')) || !existsSync(join(dir, 'cell.json'))) return null;
  const cell = readJson(join(dir, 'cell.json'));
  const spec = cell.spec ?? {};
  if (spec.seal !== 'dev' || !String(spec.note ?? '').startsWith('memory proof wave dev')) return null;
  const s = readJson(join(dir, 'summary.json'));
  const spend = existsSync(join(dir, 'spend.json')) ? readJson(join(dir, 'spend.json')) : { runs: [] };
  const pins = cell.identity?.pins ?? {};
  const cfg = spec.provider_config ?? {};
  const build = pins.gbrain?.loaded_git_head?.slice(0, 9) ?? (spec.provider === 'comparator' ? `server ${pins.comparator_version ?? cell.identity?.comparator?.version ?? 'pinned'}` : null);
  const dc = s.delivered_context ?? {};
  return {
    cell_id: cell.cell_id, provider: spec.provider, build, dataset: spec.dataset, split: spec.split, mode: spec.mode, lane: spec.lane ?? 'raw',
    target: spec.target_tokens ?? null,
    knobs: Object.fromEntries(Object.entries(cfg).filter(([k]) => KNOB_KEYS.includes(k))),
    answer: spec.models?.answer ?? '', judge: spec.models?.judge ?? '',
    n: s.score?.scheduled ?? Number(s.scheduled ?? 0), mean_score: s.score?.mean_score ?? null, accuracy: s.score?.accuracy ?? null,
    delivered_mean: dc.mean ?? null, delivered_p95: dc.p95 ?? null,
    gates: s.gates ?? {}, ok: s.ok === true || s.ok === 'True',
    usd: (spend.runs ?? []).reduce((a: number, r: any) => a + (r.stub ? 0 : Number(r.usd ?? 0)), 0),
    note: spec.note ?? '',
  };
}

export function collect(cellDirs: string[]): DevRow[] {
  const rows: DevRow[] = [];
  for (const base of cellDirs) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      if (name.startsWith('_')) continue;
      const row = devRow(join(base, name));
      if (row) rows.push(row);
    }
  }
  const key = (r: DevRow) => [r.dataset, r.split, r.mode, r.lane, r.provider, String(r.target ?? 'zdefault').padStart(8, '0'), r.cell_id].join('|');
  return rows.sort((a, b) => key(a).localeCompare(key(b)));
}

const fmt = (n: number | null, d = 0) => n === null || n === undefined ? '' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

export function markdown(rows: DevRow[]): string {
  const out = ['| Cell | System | Build | Slice | Mode | Lane | Target | Knobs | Delivered mean / p95 | n | Score | Gates | Cost |', '|---|---|---|---|---|---|---:|---|---|---:|---:|---|---:|'];
  for (const r of rows) {
    const failed = Object.entries(r.gates).filter(([, v]) => !v).map(([k]) => k);
    const knobs = Object.entries(r.knobs).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
    out.push(`| \`${r.cell_id}\` | ${r.provider} | ${r.build ?? ''} | ${r.dataset} ${r.split} | ${r.mode} | ${r.lane} | ${r.target === null ? 'default' : fmt(r.target)} | ${knobs} | ${fmt(r.delivered_mean)} / ${fmt(r.delivered_p95)} | ${r.n} | ${fmt(r.mean_score, 3)} | ${failed.length ? `fails ${failed.join(', ')}` : 'pass'} | $${fmt(r.usd, 2)} |`);
  }
  return out.join('\n') + '\n';
}

const VM_CHECKOUT = /\/home\/[^/"\s]+\/work\/gbrain-evals(?:-next)?\//g;
const VM_HOME = /\/home\/ubi\//g;

export function copyReceipts(rows: DevRow[], cellDirs: string[], dest: string, ids: string[]): string[] {
  const copied: string[] = [];
  for (const id of ids) {
    const src = cellDirs.map(d => join(d, id)).find(p => existsSync(join(p, 'summary.json')));
    if (!src || !rows.some(r => r.cell_id === id)) throw new Error(`no dev cell ${id} under ${cellDirs.join(', ')}`);
    const out = join(dest, id);
    mkdirSync(out, { recursive: true });
    for (const f of ['summary.json', 'cell.json', 'spec.json', 'spend.json']) {
      if (!existsSync(join(src, f))) continue;
      const text = readFileSync(join(src, f), 'utf8').replace(VM_CHECKOUT, '').replace(VM_HOME, '~/');
      writeFileSync(join(out, f), JSON.stringify(scrubMachinePaths(JSON.parse(text)), null, 2) + '\n');
    }
    if (existsSync(join(src, 'tuning'))) {
      mkdirSync(join(out, 'tuning'), { recursive: true });
      for (const f of readdirSync(join(src, 'tuning')).filter(f => f.endsWith('.json')).sort()) {
        const text = readFileSync(join(src, 'tuning', f), 'utf8').replace(VM_CHECKOUT, '').replace(VM_HOME, '~/');
        writeFileSync(join(out, 'tuning', f), JSON.stringify(scrubMachinePaths(JSON.parse(text)), null, 2) + '\n');
      }
    }
    copied.push(id);
  }
  return copied;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const all = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
  const flag = (n: string) => all(n)[0];
  const cellDirs = all('--cells-dir').length ? all('--cells-dir') : [join(REPO_ROOT, 'eval/reports/harness-cells')];
  const rows = collect(cellDirs);
  if (flag('--json')) writeFileSync(flag('--json')!, JSON.stringify(rows, null, 2) + '\n');
  if (flag('--markdown')) writeFileSync(flag('--markdown')!, markdown(rows));
  if (flag('--copy-receipts')) console.error(`copied ${copyReceipts(rows, cellDirs, flag('--copy-receipts')!, (flag('--cells') ?? '').split(',').filter(Boolean)).length} cells`);
  if (!flag('--json') && !flag('--markdown')) process.stdout.write(markdown(rows));
}


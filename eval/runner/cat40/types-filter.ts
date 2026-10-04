/**
 * Cat 40 instruction A/B summary: task success, authority-family success and
 * how often the agent narrows `search`/`query` with a `types` filter (and how
 * often that filter leaves out `amendment`, which hides the executed change to
 * a contract term). Reads results.jsonl + transcripts.jsonl(.gz) per run dir.
 *
 * Usage: bun eval/runner/cat40/types-filter.ts <run dir>[=label] ... [--model gpt-5.4-mini] [--md out.md] [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface TypesRow {
  label: string;
  cells: number;
  success: number;
  authority_cells: number;
  authority_success: number;
  search_calls: number;
  typed_calls: number;
  typed_without_amendment_calls: number;
  authority_cells_typed_without_amendment: number;
  authority_success_typed_without_amendment: number;
  context_pack_cells: number;
}

function jsonl(path: string): Record<string, unknown>[] {
  const raw = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export function summarizeRun(dir: string, label = basename(dir), model?: string): TypesRow {
  const results = jsonl(join(dir, 'results.jsonl')) as Array<{ key: string; family: string; score: { success: boolean } }>;
  const tPath = existsSync(join(dir, 'transcripts.jsonl')) ? join(dir, 'transcripts.jsonl') : join(dir, 'transcripts.jsonl.gz');
  const transcripts = new Map((jsonl(tPath) as Array<{ key: string; tools: Array<{ name: string; args: Record<string, unknown> }> }>).map(t => [t.key, t.tools]));
  const row: TypesRow = { label, cells: 0, success: 0, authority_cells: 0, authority_success: 0, search_calls: 0, typed_calls: 0, typed_without_amendment_calls: 0, authority_cells_typed_without_amendment: 0, authority_success_typed_without_amendment: 0, context_pack_cells: 0 };
  for (const r of results) {
    if (model && !r.key.startsWith(`${model}|`)) continue;
    const tools = transcripts.get(r.key) ?? [];
    const ok = r.score.success ? 1 : 0;
    row.cells++; row.success += ok;
    let typedNoAmendment = false;
    for (const t of tools) {
      if (t.name !== 'search' && t.name !== 'query') continue;
      row.search_calls++;
      const types = t.args.types;
      if (Array.isArray(types) && types.length) {
        row.typed_calls++;
        if (!types.includes('amendment')) { row.typed_without_amendment_calls++; typedNoAmendment = true; }
      }
    }
    if (tools.some(t => t.name === 'context_pack')) row.context_pack_cells++;
    if (r.family === 'A') {
      row.authority_cells++; row.authority_success += ok;
      if (typedNoAmendment) { row.authority_cells_typed_without_amendment++; row.authority_success_typed_without_amendment += ok; }
    }
  }
  return row;
}

const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : 'n/a';

export function markdown(rows: TypesRow[]): string {
  const head = '| Run | Success | Authority (A) | `types` on search/query calls | `types` without `amendment` | A cells filtered without `amendment` (success) | Cells calling context_pack |\n|---|---|---|---|---|---|---|';
  return [head, ...rows.map(r => `| ${r.label} | ${r.success}/${r.cells} (${pct(r.success, r.cells)}) | ${r.authority_success}/${r.authority_cells} | ${r.typed_calls}/${r.search_calls} (${pct(r.typed_calls, r.search_calls)}) | ${r.typed_without_amendment_calls} | ${r.authority_cells_typed_without_amendment} (${r.authority_success_typed_without_amendment}) | ${r.context_pack_cells} |`)].join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dirs = argv.filter((a, i) => !a.startsWith('--') && !['--md', '--json', '--model'].includes(argv[i - 1]));
  const rows = dirs.map(d => { const [dir, label] = d.split('='); return summarizeRun(dir, label, opt('--model')); });
  const md = markdown(rows);
  console.log(md);
  if (opt('--md')) writeFileSync(opt('--md')!, md + '\n');
  if (opt('--json')) writeFileSync(opt('--json')!, JSON.stringify(rows, null, 2) + '\n');
}

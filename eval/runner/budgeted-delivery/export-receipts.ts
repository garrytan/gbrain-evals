/**
 * Copy an E1 cell's receipts into the repository without dataset text: every
 * arm's receipt, outcomes and canonical rows, and the retrieval rows, with item
 * text, delivered block text, frozen chunk text, reader answers and prompts
 * removed. What stays is enough to recompute every reading: per-question
 * scores and outcomes, packed ids, prompt hashes and byte counts, token counts,
 * and the delivery records (units, budgets, overruns, spill, parity).
 *
 * With `--arm-accounting none`, arm rows drop the copied retrieval accounting
 * (each arm row names its `retrieval_key`; the retrieval rows keep it once).
 *
 *   bun eval/runner/budgeted-delivery/export-receipts.ts --cell <cell output dir> --to <results dir> [--arm-accounting none]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { scrubMachinePaths as scrubLocal } from '../receipt.ts';

/** Local paths, then a cell VM's (ubi-runner syncs the checkout to ~/work/<repo> as user ubi). */
const scrubMachinePaths = <T,>(v: T): T => scrubLocal(scrubLocal(v), '/home/ubi/work/gbrain-evals', '/home/ubi', '');

type Row = Record<string, any>;

/** One row without dataset text. */
export function stripRow(r: Row): Row {
  const { items, qa_answer: _a, qa_prompt: _p, ...rest } = r;
  const out: Row = { ...rest };
  if (Array.isArray(items)) out.items = items.map((i: Row) => ({ id: i.id, rank: i.rank, type: i.type, source_ids: i.source_ids, chars: String(i.text ?? '').length }));
  if (r.applied_settings) out.applied_settings = Object.fromEntries(Object.entries(r.applied_settings as Row).map(([k, v]) => [k, v && typeof v === 'object' && 'query' in v ? { ...v, query: undefined } : v]));
  const acc = r.accounting;
  if (acc) {
    const a: Row = { ...acc };
    if (acc.frozen) a.frozen = { ...acc.frozen, request: { ...acc.frozen.request, query: undefined }, rows: (acc.frozen.rows ?? []).map((h: Row) => ({ rank: h.rank, slug: h.slug, chunk_id: h.chunk_id, chunk_index: h.chunk_index, effective_date: h.effective_date, rerank_score: h.rerank_score, chars: String(h.chunk_text ?? '').length })) };
    if (acc.deliveries) a.deliveries = Object.fromEntries(Object.entries(acc.deliveries as Record<string, Row>).map(([k, d]) => [k, { variant: d.variant, record: d.record }]));
    if (acc.live) a.live = { ...acc.live, record: { ...acc.live.record, request: { ...acc.live.record.request, query: undefined } } };
    out.accounting = a;
  }
  return out;
}

const readRows = (p: string): Row[] => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const gz = (rows: Row[], dropAccounting = false) => gzipSync(rows.map(r => { const s = stripRow(r); if (dropAccounting) delete s.accounting; return JSON.stringify(scrubMachinePaths(s)) + '\n'; }).join(''));
const scrubbedJson = (p: string) => JSON.stringify(scrubMachinePaths(JSON.parse(readFileSync(p, 'utf8'))), null, 2) + '\n';

export function exportCell(cell: string, to: string, opts: { armAccounting?: 'keep' | 'none' } = {}): string[] {
  const written: string[] = [];
  const put = (rel: string, data: string | Buffer) => { const p = join(to, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); written.push(rel); };
  if (existsSync(join(cell, 'receipt.json'))) put('receipt.json', scrubbedJson(join(cell, 'receipt.json')));
  put('retrievals/rows.ndjson.gz', gz(readRows(join(cell, 'retrievals/rows.ndjson'))));
  const arms = join(cell, 'arms');
  for (const arm of existsSync(arms) ? readdirSync(arms).sort() : []) {
    if (arm.endsWith('.retrieval')) continue;
    for (const f of ['outcomes.ndjson', 'manifest.json']) if (existsSync(join(arms, arm, f))) put(`arms/${arm}/${f}`, readFileSync(join(arms, arm, f)));
    if (existsSync(join(arms, arm, 'receipt.json'))) put(`arms/${arm}/receipt.json`, scrubbedJson(join(arms, arm, 'receipt.json')));
    put(`arms/${arm}/rows.ndjson.gz`, gz(readRows(join(arms, arm, 'rows.ndjson')), opts.armAccounting === 'none'));
  }
  return written;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  console.log(exportCell(one('--cell')!, one('--to')!, { armAccounting: one('--arm-accounting') === 'none' ? 'none' : 'keep' }).length, 'files');
}

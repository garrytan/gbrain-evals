/**
 * The budgeted delivery E1 accounting gate (plan "Before E1 spends anything",
 * step 3): over a keyless run of the committed adapters, every gbrain-query
 * row must carry a complete accounting record whose values agree with the
 * delivered blocks, and every reader context must count its packer cuts. It
 * does not require `auto` to stay under budget (today's `auto` does not, by
 * design); it requires every overrun and every cut to be recorded.
 *
 *   bun eval/runner/budgeted-delivery/accounting-gate.ts --cell-a <dir> --cell-b <deliver dir> --b-native N --b-pseudo N [--out <file.json>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wireRequest } from '../systems/gbrain-query/connector.ts';
import { DELIVERY_VARIANTS } from '../systems/gbrain-query/system.ts';

type Row = Record<string, any>;
const readRows = (path: string): Row[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const RECORD_FIELDS = ['request', 'requested_unit', 'applied_unit', 'budget_tokens', 'budget_explicit', 'budget_used', 'tokens_delivered', 'tokenizer', 'overrun_tokens', 'over_budget', 'blocks', 'units', 'reasons',
  'spilled_blocks', 'spilled_pages', 'passthrough_blocks', 'dropped', 'dropped_reasons', 'fallbacks', 'unresolved', 'hit_count', 'distinct_sessions_in', 'distinct_sessions_out', 'fingerprint', 'evidence_chars', 'evidence_utf8_bytes', 'evidence_sha256', 'per_block'];

/** Problems with one delivery record against its own blocks; empty when it is complete and consistent. */
export function checkDelivery(name: string, d: { record: Row; blocks: Row[]; variant?: Row }, expectBudget: number | null): string[] {
  const p: string[] = [];
  const r = d.record;
  for (const f of RECORD_FIELDS) if (!(f in r) || (r[f] === null && f !== 'budget_tokens')) p.push(`${name}: ${f} missing`);
  if (r.blocks !== d.blocks.length || r.per_block?.length !== d.blocks.length) p.push(`${name}: block counts disagree (${r.blocks}, ${d.blocks.length}, ${r.per_block?.length})`);
  const tokens = (r.per_block ?? []).reduce((n: number, b: Row) => n + b.tokens, 0);
  if (tokens !== r.tokens_delivered) p.push(`${name}: per-block tokens ${tokens} != tokens_delivered ${r.tokens_delivered}`);
  const text = d.blocks.map(b => `${b.title ?? ''}\n${b.text}`).join('\n\n');
  if (sha(text) !== r.evidence_sha256) p.push(`${name}: evidence bytes differ from the record`);
  const spilled = (r.per_block ?? []).filter((b: Row) => b.reason === 'conversation_over_budget').length;
  if (spilled !== r.spilled_blocks) p.push(`${name}: spilled_blocks ${r.spilled_blocks} != ${spilled}`);
  if (r.overrun_tokens !== Math.max(0, r.budget_used - r.budget_tokens) || r.over_budget !== r.budget_used > r.budget_tokens) p.push(`${name}: overrun fields disagree with budget_used and budget_tokens`);
  if (r.requested_unit !== 'auto' || r.applied_unit !== 'auto') p.push(`${name}: unit ${r.requested_unit}/${r.applied_unit}, expected auto`);
  if (expectBudget !== null && r.budget_tokens !== expectBudget) p.push(`${name}: budget ${r.budget_tokens}, preregistered ${expectBudget}`);
  if (expectBudget !== null && r.budget_explicit !== true) p.push(`${name}: budget not explicit`);
  return p;
}

export function runGate(opts: { cellA: string; cellB: string; bNative: number; bPseudo: number }) {
  const problems: string[] = [];
  const stats = { cell_b_rows: 0, cell_a_rows: 0, over_budget: {} as Record<string, number>, spilled_rows: {} as Record<string, number>, parity_equal: 0, parity_mismatch: 0, arms: {} as Record<string, { rows: number; cut_rows: number; reused: number }> };
  const budgets: Record<string, number | null> = { 'auto-b_native': opts.bNative, 'auto-b_pseudo': opts.bPseudo, 'auto-default': 24000, 'auto-l5-b_pseudo': opts.bPseudo };
  for (const row of readRows(join(opts.cellB, 'retrievals/rows.ndjson'))) {
    if (row.outcome !== 'scored' && row.outcome !== 'ingest_degraded') { problems.push(`${row.id}: outcome ${row.outcome} (${row.error ?? ''})`); continue; }
    stats.cell_b_rows++;
    const acc = row.accounting;
    if (acc?.kind !== 'gbrain-query') { problems.push(`${row.id}: no gbrain-query accounting`); continue; }
    if (!acc.pins?.length || acc.pins.some((p: Row) => !p.applied || p.registered === 'unknown')) problems.push(`${row.id}: pins incomplete`);
    if (acc.cache_status !== 'disabled') problems.push(`${row.id}: cache status ${acc.cache_status}`);
    const f = acc.frozen;
    const expected = wireRequest('frozen-chunk', f?.request?.query ?? '', { limit: 25 });
    if (JSON.stringify(f?.request) !== JSON.stringify(expected)) problems.push(`${row.id}: frozen request differs from the preregistered object`);
    if (f?.hit_count !== f?.rows?.length || f?.meta?.delivery) problems.push(`${row.id}: frozen list record inconsistent`);
    for (const name of Object.keys(DELIVERY_VARIANTS)) {
      const d = acc.deliveries?.[name];
      if (!d) { problems.push(`${row.id}: delivery ${name} missing`); continue; }
      problems.push(...checkDelivery(`${row.id} ${name}`, d, budgets[name] === 24000 ? null : budgets[name]).map(String));
      if (d.record.over_budget) stats.over_budget[name] = (stats.over_budget[name] ?? 0) + 1;
      if (d.record.spilled_blocks) stats.spilled_rows[name] = (stats.spilled_rows[name] ?? 0) + 1;
    }
    const live = acc.live;
    if (!live?.parity || typeof live.parity.equal !== 'boolean') problems.push(`${row.id}: live parity missing`);
    else live.parity.equal ? stats.parity_equal++ : stats.parity_mismatch++;
    if (JSON.stringify(live?.record?.request) !== JSON.stringify(wireRequest('live-parity', f?.request?.query ?? '', { limit: 25, budget: opts.bNative }))) problems.push(`${row.id}: live request differs from the preregistered object`);
  }
  for (const row of readRows(join(opts.cellA, 'retrievals/rows.ndjson'))) {
    if (row.outcome !== 'scored' && row.outcome !== 'ingest_degraded') { problems.push(`cell A ${row.id}: outcome ${row.outcome}`); continue; }
    stats.cell_a_rows++;
    if (row.accounting?.kind !== 'gbrain-shootout' || typeof row.accounting.rerank_present !== 'boolean') problems.push(`cell A ${row.id}: rerank presence not recorded`);
  }
  for (const cell of [opts.cellA, opts.cellB]) {
    const dir = join(cell, 'arms');
    if (!existsSync(dir)) continue;
    for (const arm of readdirSync(dir).filter(a => !a.endsWith('.retrieval'))) {
      const rows = readRows(join(dir, arm, 'rows.ndjson'));
      const s = stats.arms[arm] = { rows: rows.length, cut_rows: 0, reused: 0 };
      for (const r of rows) {
        const c = r.qa_context;
        if (r.outcome !== 'scored') { problems.push(`${arm} ${r.id}: outcome ${r.outcome} (${r.error ?? r.qa_error ?? ''})`); continue; }
        if (!c || typeof c.tokens !== 'number' || !c.prompt_sha256) { problems.push(`${arm} ${r.id}: no frozen context record`); continue; }
        if (c.recipe) {
          if (typeof c.items_cut !== 'number' || typeof c.tokens_before !== 'number' || !c.reader_bytes) problems.push(`${arm} ${r.id}: cut accounting missing`);
          if (c.items_cut > 0) s.cut_rows++;
          if (c.items_cut === 0 && c.render !== 'rehydrated' && c.tokens !== c.tokens_before) problems.push(`${arm} ${r.id}: no cut counted but ${c.tokens_before - c.tokens} tokens left out`);
        }
        if (c.tokens > (c.budget_tokens ?? Infinity)) problems.push(`${arm} ${r.id}: context ${c.tokens} over the harness budget`);
        if (r.reused_from) s.reused++;
      }
    }
  }
  return { passed: problems.length === 0, problems: problems.slice(0, 200), problem_count: problems.length, stats };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const result = runGate({ cellA: one('--cell-a')!, cellB: one('--cell-b')!, bNative: Number(one('--b-native')), bPseudo: Number(one('--b-pseudo')) });
  const text = JSON.stringify(result, null, 2) + '\n';
  if (one('--out')) writeFileSync(one('--out')!, text);
  process.stdout.write(text);
  process.exit(result.passed ? 0 : 1);
}

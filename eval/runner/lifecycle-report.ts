#!/usr/bin/env bun
/**
 * Summarize a lifecycle-experiment receipt as Markdown tables.
 *
 *   bun eval/runner/lifecycle-report.ts <receipt.json> [more receipts...]
 *
 * With two or more receipts (repeat runs of the same matrix) it also reports
 * whether every cell's summary matched across runs.
 */
import { readFileSync } from 'node:fs';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CellSummary {
  cell: string;
  build: string;
  engine: string;
  iface: string;
  fatal: boolean;
  ack_lost_final: number;
  ack_lost_max: number;
  bijection_final: string;
  bijection_max: number;
  lost_final: string[];
  edges_final: string;
  edges_missing: string[];
  edges_extra: string[];
  timeline_final: string;
  timeline_extra: string[];
  wrong_entity: string[];
  forget_ok: boolean;
  collateral: string[];
  blocked: string[];
  residue_forget: string[];
  residue_restart: string[];
  search_lost_after_forget: string[];
  searchable_before_forget: number;
  leaks_content: string[];
  leaks_existence: string[];
  leak_probes_with_signal: string;
  outage: string;
  hazards: Record<string, string>;
  sessions: number;
  extract_refused: number;
  old_slugs: string;
}

const HAZARDS: Record<string, string[]> = {
  collide: ['foobarspace', 'foobardash', 'bystander'],
  sharedid: ['templatea', 'templateb', 'bystandershared'],
};

function frac(n: number, d: number): string { return `${n}/${d}`; }

export function summarizeCell(c: Json): CellSummary {
  const cps = c.checkpoints ?? {};
  const names = Object.keys(cps);
  const final = cps.restart ?? cps[names[names.length - 1]];
  const fs = final?.score;
  const b = fs?.bijection;
  const e = fs?.edges;
  const t = fs?.timeline;
  const probes: Json[] = [...(cps.restart?.leaks ?? []), ...(cps.reconcile?.leaks ?? []), ...(cps.ingest?.leaks ?? [])];
  const signal = probes.filter(p => p.control);
  const hazardLost = (ids: string[]) => ids.filter(id => (b?.lost ?? []).concat(b?.stale ?? []).includes(id)).length;
  const hazards: Record<string, string> = {};
  if (c.interface === 'cli') {
    for (const [h, ids] of Object.entries(HAZARDS)) {
      const exits = Object.values(c.sync_exits ?? {}).map((x: Json) => x?.[h]).filter((x: Json) => x !== undefined);
      hazards[h] = `${frac(ids.length - hazardLost(ids), ids.length)} imported; sync exit ${[...new Set(exits)].join('/')}`;
    }
  }
  const factsForget = cps.forget?.score?.facts;
  const factsFinal = fs?.facts;
  const wrong = [...(e?.wrong_entity ?? []), ...(factsFinal?.wrong_entity ?? [])];
  const searchBefore = cps.reconcile?.snapshot?.search ?? {};
  const searchAfter = cps.forget?.snapshot?.search ?? {};
  const searchLost = Object.keys(searchBefore).filter(id => searchBefore[id]?.found && !searchAfter[id]?.found);
  const outage = c.outage ?? {};
  return {
    cell: `${c.build}/${c.engine}/${c.interface}`,
    build: c.build, engine: c.engine, iface: c.interface,
    fatal: !!c.fatal,
    ack_lost_final: fs?.acknowledged_writes_lost?.length ?? NaN,
    ack_lost_max: Math.max(0, ...names.map(n => cps[n].score?.acknowledged_writes_lost?.length ?? 0)),
    bijection_final: b ? `${b.violations} of ${b.expected_files}` : 'n/a',
    bijection_max: Math.max(0, ...names.map(n => cps[n].score?.bijection?.violations ?? 0)),
    lost_final: [...(b?.lost ?? []), ...(b?.stale ?? []).map((x: string) => `${x}(stale)`), ...(b?.duplicate ?? []), ...(b?.orphan ?? [])],
    edges_final: e ? `${e.true_positive}/${e.observed} P, ${e.true_positive}/${e.expected} R` : 'n/a',
    edges_missing: e?.missing ?? [],
    edges_extra: e?.extra ?? [],
    timeline_final: t ? `${t.true_positive}/${t.observed} P, ${t.true_positive}/${t.expected} R` : 'n/a',
    timeline_extra: t?.extra ?? [],
    wrong_entity: wrong,
    forget_ok: !!c.forget?.ok,
    collateral: factsFinal?.collateral ?? [],
    blocked: factsFinal?.blocked ?? [],
    residue_forget: factsForget?.residue ?? [],
    residue_restart: factsFinal?.residue ?? [],
    search_lost_after_forget: searchLost,
    searchable_before_forget: Object.keys(searchBefore).filter(id => searchBefore[id]?.found).length,
    leaks_content: [...new Set(signal.filter(p => p.content_leak).map(p => p.name))],
    leaks_existence: [...new Set(signal.filter(p => p.existence_leak).map(p => p.name))],
    leak_probes_with_signal: c.interface === 'cli' ? 'n/a (trusted local)' : `${new Set(signal.map(p => p.name)).size}/${new Set(probes.map(p => p.name)).size}`,
    outage: `sync exit ${outage.sync_exit}; text ${(outage.text_persisted_during_outage ?? []).length}/3 during outage; embedded ${(outage.embedded_after_recovery ?? []).length}/3 and searchable ${(outage.searchable_after_recovery ?? []).length}/3 after recovery`,
    hazards,
    sessions: c.sessions ?? 0,
    extract_refused: (c.operator ?? []).filter((o: Json) => o.step.endsWith(':extract') && o.code !== 0).length,
    old_slugs: fs?.old_slugs ? `${fs.old_slugs.resolved.length}/${fs.old_slugs.checked}` : 'n/a',
  };
}

function table(rows: string[][]): string {
  const [head, ...body] = rows;
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

function list(xs: string[]): string { return xs.length ? xs.join(', ') : 'none'; }

export function renderReport(receipt: Json): string {
  const cells: CellSummary[] = receipt.cells.map(summarizeCell);
  const out: string[] = [];
  out.push(`Receipt generated ${receipt.generated_at}; gbrain-evals ${String(receipt.evals?.head).slice(0, 9)}${receipt.evals?.dirty_files?.length ? ' (dirty)' : ''}; cost $${receipt.cost_usd}.`);
  out.push('');
  out.push(table([
    ['Build', 'Commit', 'Version', 'Tree verified', 'Symlinks under src/'],
    ...receipt.builds.map((b: Json) => [b.label, b.commit.slice(0, 9), b.version, b.verified.tree_matches ? `yes (${b.tree.slice(0, 9)})` : 'NO', String(b.verified.symlinks_under_src)]),
  ]));
  out.push('');
  out.push('### Write-path contracts, final checkpoint (after restart)');
  out.push('');
  out.push(table([
    ['Cell', 'Acknowledged writes lost (final / worst)', 'File-to-page violations (final) / worst', 'Edges', 'Timeline', 'Old slug still reaches the page', 'Wrong-entity'],
    ...cells.map(c => [c.cell, c.fatal ? 'FATAL' : `${c.ack_lost_final} / ${c.ack_lost_max}`, `${c.bijection_final} / ${c.bijection_max}`, c.edges_final, c.timeline_final, c.old_slugs, String(c.wrong_entity.length)]),
  ]));
  out.push('');
  out.push('### Withdrawal, remote access and recovery');
  out.push('');
  out.push(table([
    ['Cell', 'Forget ok', 'Collateral', 'Blocked re-remember', 'Residue (forget / restart)', 'Pages unsearchable after forget', 'Remote content leaks', 'Remote existence disclosures', 'Probes with signal', 'Outage'],
    ...cells.map(c => [c.cell, c.forget_ok ? 'yes' : 'no', list(c.collateral), String(c.blocked.length), `${c.residue_forget.length} / ${c.residue_restart.length}`, `${c.search_lost_after_forget.length} of ${c.searchable_before_forget}`, list(c.leaks_content), list(c.leaks_existence), c.leak_probes_with_signal, c.outage]),
  ]));
  out.push('');
  out.push('### Hazard vaults (local CLI observer)');
  out.push('');
  out.push(table([
    ['Cell', 'Slug collision vault', 'Shared frontmatter id vault'],
    ...cells.filter(c => c.iface === 'cli').map(c => [c.cell, c.hazards.collide ?? 'n/a', c.hazards.sharedid ?? 'n/a']),
  ]));
  out.push('');
  out.push('### Details per cell');
  out.push('');
  for (const c of cells) {
    out.push(`- **${c.cell}**: lost/stale/duplicate/orphan at final: ${list(c.lost_final)}; missing edges: ${list(c.edges_missing)}; extra edges: ${list(c.edges_extra)}; extra timeline rows: ${list(c.timeline_extra)}; wrong-entity: ${list(c.wrong_entity)}; server sessions: ${c.sessions}; refused extract steps: ${c.extract_refused}.`);
  }
  return out.join('\n');
}

export function compareRuns(receipts: Json[]): string {
  const keyOf = (s: CellSummary) => JSON.stringify({ ...s, cell: undefined });
  const runs = receipts.map(r => new Map<string, CellSummary>(r.cells.map((c: Json) => { const s = summarizeCell(c); return [s.cell, s]; })));
  const cells = [...runs[0].keys()];
  const differing = cells.filter(cell => runs.some(m => !m.has(cell) || keyOf(m.get(cell)!) !== keyOf(runs[0].get(cell)!)));
  const lines = [`Repeat runs: ${receipts.length}. Cells whose summary matched in every run: ${cells.length - differing.length} of ${cells.length}.`];
  for (const cell of differing) {
    const fields = Object.keys(runs[0].get(cell)!).filter(k => runs.some(m => JSON.stringify((m.get(cell) as Json)?.[k]) !== JSON.stringify((runs[0].get(cell) as Json)[k])));
    lines.push(`- ${cell} differs in: ${fields.join(', ')}`);
    for (const f of fields) lines.push(`  - ${f}: ${runs.map(m => JSON.stringify((m.get(cell) as Json)?.[f])).join(' vs ')}`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (!paths.length) { console.error('usage: bun eval/runner/lifecycle-report.ts <receipt.json> [more receipts]'); process.exit(2); }
  const receipts = paths.map(p => JSON.parse(readFileSync(p, 'utf8')));
  console.log(renderReport(receipts[0]));
  if (receipts.length > 1) { console.log(''); console.log(compareRuns(receipts)); }
}

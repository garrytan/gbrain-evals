#!/usr/bin/env bun
/**
 * Document-status lane scorer (F3).
 *
 * System output: { "status": [{ "slug": "contracts/...", "status": "signed" | "draft" | "unsigned" }] }
 *
 * Metrics: accuracy over every contract-like page, on pages whose frontmatter
 * carries no status (the status must be read from the body), and "governs"
 * accuracy (signed vs not signed). Prints the confusion counts.
 */
import { emit, group, loadGold, metric, parseCli, type Report, type Split } from './common.ts';

export function scoreStatus(split: Split, system: { status?: { slug: string; status: string }[] }, gold = loadGold('document-status', split)): Report {
  const by = new Map((system.status ?? []).map(s => [s.slug, String(s.status).toLowerCase()]));
  const rows = gold.map(g => ({ g, got: by.get(g.slug) ?? 'missing' }));
  const noFm = rows.filter(r => !r.g.status_in_frontmatter);
  const confusion: Record<string, number> = {};
  for (const r of rows) confusion[`${r.g.status}->${r.got}`] = (confusion[`${r.g.status}->${r.got}`] ?? 0) + 1;
  return {
    lane: 'document-status', split,
    metrics: [
      metric('status correct', rows.filter(r => r.got === r.g.status).length, rows.length),
      metric('status correct, no status in frontmatter', noFm.filter(r => r.got === r.g.status).length, noFm.length),
      metric('signed vs not signed correct', rows.filter(r => (r.got === 'signed') === (r.g.status === 'signed') && r.got !== 'missing').length, rows.length),
    ],
    breakdown: { 'gold status': group(rows, r => r.g.status, r => r.got === r.g.status) },
    extra: { confusion },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreStatus(c.split, c.system), c.json); }

#!/usr/bin/env bun
/**
 * Owner-phrase lane scorer.
 *
 * System output: { "links": [{ "slug": "updates/...", "surface": "Dana's freight account", "line"?: 14, "accounts": ["quarrendon"] }] }
 * A mention with no entry (or an empty `accounts`) counts as "no link".
 * Entries match a gold mention by slug and surface (case and apostrophe style
 * ignored), or by slug and line when the surface is omitted.
 *
 * Metrics: link recall on should_link mentions (right accounts), link precision
 * over emitted links on candidate mentions, false-link rate on should_link=false
 * mentions, wrong-account links. `--view public` scores against
 * should_link_public (the gold when private pages are hidden).
 */
import { emit, group, loadGold, metric, normText, parseCli, setEq, type Report, type Split } from './common.ts';

export interface OwnerLink { slug: string; surface?: string; line?: number; accounts?: string[] }

export function scoreOwnerPhrases(split: Split, system: { links?: OwnerLink[] }, view: 'full' | 'public' = 'full', gold = loadGold('owner-phrases', split)): Report {
  const links = system.links ?? [];
  const used = new Set<number>();
  const find = (g: any) => {
    const i = links.findIndex((l, j) => !used.has(j) && l.slug === g.slug && (l.surface ? normText(l.surface) === normText(g.surface) : l.line !== undefined && g.lines.includes(l.line)));
    if (i >= 0) used.add(i);
    return i >= 0 ? links[i] : undefined;
  };
  const rows = gold.map(g => {
    const should = view === 'public' ? g.should_link_public : g.should_link;
    const l = find(g);
    const got = l?.accounts ?? [];
    return { g, should, linked: got.length > 0, right: got.length > 0 && setEq(got, g.intended_accounts) };
  });
  const pos = rows.filter(r => r.should), neg = rows.filter(r => !r.should);
  const emitted = rows.filter(r => r.linked);
  return {
    lane: 'owner-phrases', split, view,
    metrics: [
      metric('candidates', rows.length, rows.length),
      metric('link recall (should_link, right accounts)', pos.filter(r => r.right).length, pos.length),
      metric('link precision (emitted links that are right)', emitted.filter(r => r.should && r.right).length, emitted.length),
      metric('false links on should_link=false', neg.filter(r => r.linked).length, neg.length, 'lower is better'),
      metric('wrong-account links on should_link=true', pos.filter(r => r.linked && !r.right).length, pos.length, 'lower is better'),
    ],
    breakdown: {
      'reason (correct decision)': group(rows, r => `${r.g.reason}${r.should ? '' : ' [no-link]'}`, r => (r.should ? r.right : !r.linked)),
      'window_relation (correct decision)': group(rows, r => r.g.window_relation, r => (r.should ? r.right : !r.linked)),
    },
    extra: { links_not_on_candidates: links.filter((l, j) => !used.has(j) && (l.accounts ?? []).length > 0).length },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreOwnerPhrases(c.split, c.system, c.view), c.json); }

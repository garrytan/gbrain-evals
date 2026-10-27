#!/usr/bin/env bun
/**
 * Ownership-window lane scorer.
 *
 * System output: { "windows": [{ "account": "quarrendon", "owner": "dana-okafor", "role"?: "primary|team|acting", "start": "2025-06-02"|null, "end": null }] }
 * Owners are person ids or team ids (see labels/ownership). Windows are
 * [start, end); null start or end is open.
 *
 * Metrics: owner-on-date accuracy over probe dates derived from the gold
 * windows (each start day, the day before, a middle day, the last day and the
 * end day), acting-cover accuracy on acting probes, and exact-window recall
 * and precision for primary and team stints with a known start. Probes whose
 * gold rests on a private-only stint are dropped under `--view public`.
 */
import { emit, group, loadGold, metric, parseCli, setEq, type Report, type Split } from './common.ts';

export interface Window { account: string; owner: string; role?: string; start: string | null; end: string | null }
const add = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const inW = (w: { start: string | null; end: string | null }, d: string) => (w.start === null || w.start <= d) && (w.end === null || d < w.end);

export function probes(gold: any[], view: 'full' | 'public') {
  const stints = gold.filter(g => g.role);
  const out: { account: string; date: string; kind: 'owner' | 'acting'; owners: string[]; trap: string }[] = [];
  const seen = new Set<string>();
  for (const s of stints) {
    const dates = [s.start, s.start && add(s.start, -1), s.end && add(s.end, -1), s.end, s.start && s.end && add(s.start, Math.floor((Date.parse(s.end) - Date.parse(s.start)) / 172_800_000))].filter(Boolean) as string[];
    for (const d of dates) {
      const kind = s.role === 'acting' ? 'acting' : 'owner';
      const k = `${s.account}|${d}|${kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const at = stints.filter(x => x.account === s.account && inW(x, d) && (kind === 'acting' ? x.role === 'acting' : x.role === 'primary' || x.role === 'team'));
      if (view === 'public' && at.some(x => x.evidence_visibility === 'private_only')) continue;
      if (kind === 'acting' && at.length === 0) continue;
      const trap = gold.some(g => g.kind === 'corrected_announcement' && g.governing_stints.some((id: string) => at.some(x => x.id === id))) ? 'corrected_announcement' : at.some(x => x.start === null) ? 'unknown_start' : stints.some(x => x.account === s.account && x.role === 'overlap' && inW(x, d)) ? 'belated_overlap' : 'plain';
      out.push({ account: s.account, date: d, kind, owners: at.map(x => x.owner), trap });
    }
  }
  return out;
}

export function scoreOwnership(split: Split, system: { windows?: Window[] }, view: 'full' | 'public' = 'full', gold = loadGold('ownership', split)): Report {
  const ws = system.windows ?? [];
  const ps = probes(gold, view).map(p => {
    const got = ws.filter(w => w.account === p.account && inW(w, p.date) && (p.kind === 'acting' ? w.role === 'acting' : w.role !== 'acting' && w.role !== 'overlap')).map(w => w.owner);
    return { ...p, ok: setEq(got, p.owners) };
  });
  const exact = gold.filter(g => (g.role === 'primary' || g.role === 'team') && g.start !== null && (view === 'full' || g.evidence_visibility === 'public'));
  const hit = (g: any) => ws.some(w => w.account === g.account && w.owner === g.owner && w.start === g.start && w.end === g.end);
  const sysPrimary = ws.filter(w => w.role !== 'acting' && w.role !== 'overlap' && w.start !== null);
  const sysHit = sysPrimary.filter(w => gold.some(g => (g.role === 'primary' || g.role === 'team') && w.account === g.account && w.owner === g.owner && w.start === g.start && w.end === g.end));
  const owner = ps.filter(p => p.kind === 'owner'), acting = ps.filter(p => p.kind === 'acting');
  return {
    lane: 'ownership', split, view,
    metrics: [
      metric('owner-on-date probes correct', owner.filter(p => p.ok).length, owner.length),
      metric('acting-cover probes correct', acting.filter(p => p.ok).length, acting.length),
      metric('exact window recall (known start)', exact.filter(hit).length, exact.length),
      metric('exact window precision', sysHit.length, sysPrimary.length),
    ],
    breakdown: { 'probe trap': group(owner, p => p.trap, p => p.ok) },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreOwnership(c.split, c.system, c.view), c.json); }

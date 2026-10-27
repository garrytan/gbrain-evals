#!/usr/bin/env bun
/**
 * Agent-task lane scorer (Cat 40 Hard style questions).
 *
 * System output: { "answers": [{ "id": "dev-gov-1", "answer": "185", "evidence_slugs"?: ["contracts/..."] }] }
 * Answers are compared by type: account and person ids or any accepted name,
 * numbers by value, dates by calendar day, sets as sets, booleans as yes/no,
 * "ambiguous" and "unknown" by keyword, text by normalized containment of the
 * gold or an accepted variant. `--view public` uses answer_public_only where
 * the gold depends on private pages.
 *
 * Metrics: answer accuracy, evidence recall (gold evidence slugs cited, over
 * all tasks), and accuracy by lane.
 */
import { emit, group, isoDate, loadGold, metric, normText, parseCli, sameValue, type Report, type Split } from './common.ts';

export function answerOk(t: any, got: unknown, view: 'full' | 'public'): boolean {
  if (got === undefined || got === null) return false;
  const gold = view === 'public' && t.answer_public_only !== undefined ? t.answer_public_only : t.answer;
  const s = Array.isArray(got) ? got.map(String) : String(got);
  const txt = normText(Array.isArray(s) ? s.join(' ') : s);
  const accepts = [String(gold), ...(gold === t.answer ? t.accept ?? [] : [])].map(normText);
  if (gold === 'unknown') return /unknown|not (recorded|stated|known)|no record|can't tell|cannot tell|not determin/.test(txt);
  if (gold === 'ambiguous') return /ambiguous|either|can't tell|cannot tell|unclear|could be/.test(txt);
  switch (t.answer_type) {
    case 'boolean': return (gold === true ? /^(yes|true)\b/ : /^(no|false)\b/).test(txt);
    case 'number': return sameValue(gold, s);
    case 'date': return isoDate(s) === gold;
    case 'set': {
      const want = (gold as string[]).map(String);
      const have = Array.isArray(got) ? got.map(x => isoDate(x) ?? normText(String(x))) : txt.split(/[,;]| and /).map(x => isoDate(x) ?? x.trim());
      return want.every(w => have.some(h => h === w || h === normText(w))) && have.length === want.length;
    }
    default: return accepts.some(a => txt === a || txt.includes(a));
  }
}

export function scoreAgentTasks(split: Split, system: { answers?: { id: string; answer: unknown; evidence_slugs?: string[] }[] }, view: 'full' | 'public' = 'full', gold = loadGold('agent-tasks', split)): Report {
  const by = new Map((system.answers ?? []).map(a => [a.id, a]));
  const rows = gold.map(t => { const a = by.get(t.id); return { t, ok: !!a && answerOk(t, a.answer, view), ev: a?.evidence_slugs ?? [] }; });
  const evTotal = rows.reduce((s, r) => s + r.t.evidence_slugs.length, 0);
  const evHit = rows.reduce((s, r) => s + r.t.evidence_slugs.filter((x: string) => r.ev.includes(x)).length, 0);
  return {
    lane: 'agent-tasks', split, view,
    metrics: [metric('answer correct', rows.filter(r => r.ok).length, rows.length), metric('gold evidence slugs cited', evHit, evTotal)],
    breakdown: { lane: group(rows, r => r.t.lane, r => r.ok) },
  };
}

if (import.meta.main) { const c = parseCli(); emit(scoreAgentTasks(c.split, c.system, c.view), c.json); }

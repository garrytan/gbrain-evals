#!/usr/bin/env bun
/**
 * Scores the LHF wave 2 attendance paraphrase gate
 * (docs/benchmarks/2026-10-16-lhf-wave-2-attendance-preregistration.md) from two
 * N9 hermetic receipts on world-v1-attendees, base and branch, each run with
 *   --extra-split heldout-paraphrase=<attendance-heldout-30.jsonl>
 *   --extra-split competing-intent=<competing-intent-30.jsonl>
 *
 *   bun eval/runner/lhf-wave-2-attendance-gate.ts --base <receipt.json> --branch <receipt.json>
 *     --base-relations <json> --branch-relations <json> [--json]
 *
 * The relations files come from eval/runner/parse-relational-questions.ts run
 * against each gbrain tree on the held-out and competing files (N9's relational
 * meta names the parse shape, not the relation). Attendance fired: the ON arm
 * fired and the parser chose an `attended` link type. False route: a competing
 * question, or a development-split question of another template, parsed as
 * `attended` (fired or not); pass the development split's questions to the
 * parser too (`--export-dev <receipt>` writes them as JSONL). For the template
 * and development splits, fired is N9's own flag.
 * Counts, no statistics.
 */
import { readFileSync } from 'node:fs';

interface Row { seed: number; query_id: string; split: string; template: string; kind: string | null; fired: boolean; on: { recall_at_5?: number } | null; error: string | null }
type Relations = Record<string, { linkTypes: string[] | null } | null>;

const ATTENDED = 'attended';
const EXTRA = new Set(['heldout-paraphrase', 'competing-intent']);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

function rows(path: string): Row[] {
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as { data?: { one_hop?: { per_query?: Row[] } } };
  const r = receipt.data?.one_hop?.per_query;
  if (!r?.length) throw new Error(`${path}: no one_hop.per_query rows`);
  return r;
}

let relations: Relations = {};
const parsedAttendance = (r: Row) => Boolean(relations[r.query_id]?.linkTypes?.includes(ATTENDED));
const firedAttendance = (r: Row) => r.fired && (!EXTRA.has(r.split) || parsedAttendance(r));
const routedAttendance = (r: Row) => parsedAttendance(r);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function splitStats(all: Row[], split: string) {
  const rs = all.filter(r => r.split === split);
  return {
    runs: rs.length,
    errors: rs.filter(r => r.error).length,
    fired_attendance: rs.filter(firedAttendance).length,
    routed_attendance: rs.filter(routedAttendance).length,
    fire_rate: rs.length ? rs.filter(firedAttendance).length / rs.length : 0,
    recall_at_5_on: mean(rs.map(r => r.on?.recall_at_5 ?? 0)),
  };
}

export function scoreGate(base: Row[], branch: Row[], rel: { base: Relations; branch: Relations }) {
  const s = (rs: Row[], split: string) => { relations = rs === base ? rel.base : rel.branch; return splitStats(rs, split); };
  const heldB = s(base, 'heldout-paraphrase'); const held = s(branch, 'heldout-paraphrase');
  const comp = s(branch, 'competing-intent'); const compB = s(base, 'competing-intent');
  const tmplB = s(base, 'one-hop-template'); const tmpl = s(branch, 'one-hop-template');
  const devB = s(base, 'one-hop-paraphrase'); const dev = s(branch, 'one-hop-paraphrase');
  relations = rel.branch;
  const devFalse = branch.filter(r => r.split === 'one-hop-paraphrase' && r.template !== ATTENDED && parsedAttendance(r)).length;
  const perQuestion = new Map<string, number>();
  for (const r of branch.filter(r => r.split === 'heldout-paraphrase' && firedAttendance(r))) perQuestion.set(r.query_id, (perQuestion.get(r.query_id) ?? 0) + 1);
  const rules = {
    heldout_fire_rate_at_least_80pct: held.fire_rate >= 0.8,
    heldout_recall_not_lower: held.recall_at_5_on >= heldB.recall_at_5_on - 1e-12,
    competing_zero_false_routes: comp.routed_attendance === 0 && comp.fired_attendance === 0,
    template_unchanged: tmpl.fired_attendance === tmplB.fired_attendance && Math.abs(tmpl.recall_at_5_on - tmplB.recall_at_5_on) < 1e-12,
    competing_no_new_false_routes: comp.routed_attendance <= compB.routed_attendance,
    relational_paraphrase_zero_false_attendance: devFalse === 0,
  };
  return {
    pass: Object.values(rules).every(Boolean), rules,
    heldout: { base: heldB, branch: held, questions_firing_on_every_seed: [...perQuestion.values()].filter(n => n === 3).length },
    competing_intent: { base: compB, branch: comp },
    template: { base: tmplB, branch: tmpl },
    development_paraphrase: { base: devB, branch: dev, false_attendance_routes: devFalse },
  };
}

if (import.meta.main && process.argv.includes('--export-dev')) {
  const seen = new Set<string>();
  for (const r of rows(arg('--export-dev')!) as Array<Row & { text: string }>) {
    if (r.split !== 'one-hop-paraphrase' || seen.has(r.query_id)) continue;
    seen.add(r.query_id);
    console.log(JSON.stringify({ id: r.query_id, text: r.text }));
  }
  process.exit(0);
}

if (import.meta.main) {
  const base = arg('--base'); const branch = arg('--branch');
  if (!base || !branch) { console.error('usage: lhf-wave-2-attendance-gate.ts --base <receipt> --branch <receipt> [--json]'); process.exit(2); }
  const relBase = arg('--base-relations'); const relBranch = arg('--branch-relations');
  if (!relBase || !relBranch) { console.error('--base-relations and --branch-relations are required'); process.exit(2); }
  const r = scoreGate(rows(base), rows(branch), { base: JSON.parse(readFileSync(relBase, 'utf8')), branch: JSON.parse(readFileSync(relBranch, 'utf8')) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    const line = (name: string, x: ReturnType<typeof splitStats>) => `${name}: fired ${x.fired_attendance}/${x.runs} (${(x.fire_rate * 100).toFixed(1)}%), routed to attendance ${x.routed_attendance}, recall@5 on ${x.recall_at_5_on.toFixed(3)}, errors ${x.errors}`;
    for (const [k, v] of Object.entries({ heldout: r.heldout, competing_intent: r.competing_intent, template: r.template, development_paraphrase: r.development_paraphrase })) {
      console.log(line(`${k} base`, v.base)); console.log(line(`${k} branch`, v.branch));
    }
    console.log(`held-out questions firing on every seed: ${r.heldout.questions_firing_on_every_seed}/30; development false attendance routes: ${r.development_paraphrase.false_attendance_routes}`);
    console.log(`rules: ${JSON.stringify(r.rules)}`);
    console.log(`GATE: ${r.pass ? 'PASS' : 'FAIL'}`);
  }
  process.exit(r.pass ? 0 : 1);
}

/**
 * Attendee-role questions on a world-v1-shaped corpus (W3 of the 2026-10
 * follow-up round; docs/benchmarks/2026-10-06-attendance-world-preregistration.md).
 *
 * Renders the development phrasing of eval/generators/constrained-relational-gen.ts
 * (PHRASING_A.q_attended_role: "Which {roles} attended {meeting}?" and
 * "{Roles} who attended {meeting}?") against each meeting and each role present
 * among its attendees, never the custodian's sealed phrasing. Gold: the
 * attendees on the meeting's list that hold the role (world-v1 person
 * `_facts.role`; in world-v1-attendees the list on the page).
 *
 * For every question it records gbrain's own reading as instrumentation:
 * the multi-relation planner (`parseRelationalPlan`: plan, not_applicable or
 * unsupported with its reason and matched phrases), the one-relation parser
 * (`parseRelationalQuery`), and, on a keyword index of the corpus, whether the
 * relational arm fired, what it returned, and role-gold recall@10 with the
 * relational arm off and on. Hermetic: keyword search, no key.
 *
 * Usage: bun eval/runner/attendee-role-planner.ts [--corpus eval/data/world-v1-attendees] [--output <dir>] [--gbrain <checkout>[@ref]] [--attest <prereg.md>]
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PHRASING_A } from '../generators/constrained-relational-gen.ts';
import { loadWorldCorpus, type RichPage } from './queries/relational.ts';
import { loadRelationalProduct, runSharedIndexPairs, type SharedIndexQuery } from './relational-ab.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { attestPreregistration } from './prereg.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';

export const CATEGORY = 'attendee-role-planner';
export const ROLE_PLURALS: Readonly<Record<string, string>> = { founder: 'founders', partner: 'partners', engineer: 'engineers', advisor: 'advisors', investor: 'investors' };
const K = 10;

export interface RoleQuestion { id: string; text: string; meeting: string; role: string; gold: string[]; attendees: string[]; template: number }

/** Every (meeting, role present among its attendees) pair, in both development templates. */
export function buildRoleQuestions(pages: readonly RichPage[]): RoleQuestion[] {
  const role = new Map(pages.filter(p => p.type === 'person').map(p => [p.slug, String((p._facts as { role?: string }).role ?? '')]));
  const out: RoleQuestion[] = [];
  for (const m of [...pages].filter(p => p.type === 'meeting').sort((a, b) => a.slug.localeCompare(b.slug))) {
    const attendees = ((m._facts as { attendees?: string[] }).attendees ?? []).filter(s => role.has(s));
    for (const r of [...new Set(attendees.map(s => role.get(s)!))].filter(r => ROLE_PLURALS[r]).sort()) {
      const gold = attendees.filter(s => role.get(s) === r);
      PHRASING_A.q_attended_role.forEach((t, i) => {
        const roles = ROLE_PLURALS[r]!;
        const text = t.replace('{roles}', roles).replace('{Roles}', roles[0]!.toUpperCase() + roles.slice(1)).replace('{meeting}', m.title);
        out.push({ id: `ar-${String(out.length + 1).padStart(3, '0')}`, text, meeting: m.slug, role: r, gold, attendees, template: i });
      });
    }
  }
  return out;
}

export interface RoleRow {
  id: string; text: string; meeting: string; role: string; template: number;
  plan: { kind: string; reason?: string; phrases?: string[]; hops?: number };
  one_relation: { parsed: boolean; kind?: string; link_types?: string[] | null; seeds?: string[]; phrase?: string };
  fired: boolean;
  recall_off: number; recall_on: number;
  /** People in the top 10 that the meeting's list does not name, arm off and on (report-only; keyword search can return people named in prose). */
  unlisted_people: { off: string[]; on: string[] };
  /** Listed attendees of another role in the top 10, arm off and on (the role constraint not applied). */
  other_role_attendees: { off: string[]; on: string[] };
  error: string | null;
}

export function summarizeRoleRows(rows: readonly RoleRow[]) {
  const n = rows.length;
  const share = (f: (r: RoleRow) => boolean) => ({ n: rows.filter(f).length, share: n ? rows.filter(f).length / n : 0 });
  const mean = (f: (r: RoleRow) => number) => (n ? rows.reduce((s, r) => s + f(r), 0) / n : 0);
  const reasons: Record<string, number> = {};
  for (const r of rows) { const k = r.plan.kind === 'unsupported' ? `unsupported: ${r.plan.reason}` : r.plan.kind; reasons[k] = (reasons[k] ?? 0) + 1; }
  return {
    questions: n,
    planned: share(r => r.plan.kind === 'plan'),
    plan_outcomes: reasons,
    one_relation_parsed: share(r => r.one_relation.parsed),
    fired: share(r => r.fired),
    recall_at_10_off: mean(r => r.recall_off),
    recall_at_10_on: mean(r => r.recall_on),
    unlisted_people_top10: { off: rows.reduce((s, r) => s + r.unlisted_people.off.length, 0), on: rows.reduce((s, r) => s + r.unlisted_people.on.length, 0) },
    questions_with_other_role_attendees_top10: { off: share(r => r.other_role_attendees.off.length > 0), on: share(r => r.other_role_attendees.on.length > 0) },
    errors: rows.filter(r => r.error).length,
  };
}

const recall = (pages: readonly string[], gold: readonly string[]) => (gold.length ? gold.filter(g => pages.slice(0, K).includes(g)).length / gold.length : 0);

export async function runAttendeeRolePlanner(opts: { corpusDir: string; gbrainSpec: string | null; log?: (s: string) => void }) {
  return withHermeticEnv('attendee-role', async () => {
    const log = opts.log ?? (() => {});
    const gut = resolveGbrainUnderTest(opts.gbrainSpec);
    const product = await loadRelationalProduct(gut);
    const { parseRelationalPlan } = await importGbrain<{ parseRelationalPlan: (q: string) => { kind: string; reason?: string; plan?: { phrases: string[]; hops: unknown[] } } }>(gut, 'src/core/search/relational-plan.ts');
    const { parseRelationalQuery } = await importGbrain<{ parseRelationalQuery: (q: string) => unknown }>(gut, 'src/core/search/relational-intent.ts');
    const pages = loadWorldCorpus(opts.corpusDir);
    const questions = buildRoleQuestions(pages);
    const queries: SharedIndexQuery[] = questions.map(q => ({ id: q.id, tier: 'hard', text: q.text, expected_output_type: 'cited-source-pages', gold: { relevant: q.gold }, split: 'attended-role', template: 'attended_role', limit: K }));
    const accounting = new ProbeAccounting(queries.length * 2);
    const run = await runSharedIndexPairs({ product, pages, queries, seeds: [1], embed: 'keyword', accounting, log, limit: K });
    const byId = new Map(run.rows.map(r => [r.query_id, r]));
    const role = new Map(pages.filter(p => p.type === 'person').map(p => [p.slug, String((p._facts as { role?: string }).role ?? '')]));
    const rows: RoleRow[] = questions.map(q => {
      const r = byId.get(q.id);
      const plan = parseRelationalPlan(q.text);
      const one = parseRelationalQuery(q.text) as { kind: string; seeds: string[]; linkTypes: string[] | null; relationPhrase: string } | null;
      const meta = r?.on.relational_meta[0] as { fired?: boolean } | undefined;
      const top = (arm: 'off' | 'on') => (r?.[arm].pages ?? []).slice(0, K).filter(s => role.has(s));
      return {
        id: q.id, text: q.text, meeting: q.meeting, role: q.role, template: q.template,
        plan: { kind: plan.kind, ...(plan.reason ? { reason: plan.reason } : {}), ...(plan.plan ? { phrases: plan.plan.phrases, hops: plan.plan.hops.length } : {}) },
        one_relation: one ? { parsed: true, kind: one.kind, link_types: one.linkTypes, seeds: one.seeds, phrase: one.relationPhrase } : { parsed: false },
        fired: !!meta?.fired,
        recall_off: recall(r?.off.pages ?? [], q.gold), recall_on: recall(r?.on.pages ?? [], q.gold),
        unlisted_people: { off: top('off').filter(s => !q.attendees.includes(s)), on: top('on').filter(s => !q.attendees.includes(s)) },
        other_role_attendees: { off: top('off').filter(s => q.attendees.includes(s) && role.get(s) !== q.role), on: top('on').filter(s => q.attendees.includes(s) && role.get(s) !== q.role) },
        error: r?.off.error?.message ?? r?.on.error?.message ?? (r ? null : 'no row'),
      };
    });
    return { gut, pages, questions, rows, summary: summarizeRoleRows(rows), accounting: accounting.summary(), indices: run.indices };
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const attest = flag('--attest');
  const attestation = attest ? attestPreregistration(attest) : null;
  const corpusDir = flag('--corpus') ?? 'eval/data/world-v1-attendees';
  const started = new Date().toISOString();
  runAttendeeRolePlanner({ corpusDir, gbrainSpec: gbrainSpecFrom(argv), log: s => console.log(s) }).then(r => {
    const receipt: Receipt = {
      ...noModelSpend('hermetic: keyword search, provider keys stripped; no model and no paid request'),
      schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: CATEGORY,
      run_status: r.accounting.run_invalid ? 'error' : 'completed',
      ...(r.accounting.run_invalid ? {} : { verdict: r.summary.errors === 0 ? 'pass' as const : 'partial' as const }),
      n_total: r.accounting.n_total, n_scored: r.accounting.n_scored, completion_rate: r.accounting.completion_rate, errors: r.accounting.errors, publishable: r.accounting.publishable,
      gbrain_version: r.gut.version, gbrain_pin: gbrainPin(),
      execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(r.gut) },
      resolved_config: { verdict_meaning: 'harness completeness only (every question scored); the probe is report-only and gates nothing', corpus: corpusDir, phrasing: 'constrained-relational-gen PHRASING_A.q_attended_role (development)', templates: PHRASING_A.q_attended_role, k: K, embed: 'keyword', seed: 1, decide: DECIDE_OFF, gbrain_overlay: overlaySummary(r.gut) },
      hashes: { corpus_sha256: createHash('sha256').update(JSON.stringify(r.pages.map(p => [p.slug, p.compiled_truth]))).digest('hex'), questions_sha256: createHash('sha256').update(JSON.stringify(r.questions)).digest('hex') },
      started_at: started, finished_at: new Date().toISOString(),
      data: { summary: r.summary, by_template: [0, 1].map(t => summarizeRoleRows(r.rows.filter(x => x.template === t))), rows: r.rows, indices: r.indices },
    };
    const out = join(flag('--output') ?? join('eval/reports', CATEGORY), 'receipt.json');
    writeReceipt(out, (attestation ? { ...receipt, preregistration_attestation: attestation } : receipt) as Receipt);
    console.log(JSON.stringify(r.summary, null, 2));
    console.log(`receipt ${out}`);
    process.exit(receipt.run_status === 'completed' ? 0 : 1);
  }).catch(e => { console.error(e); process.exit(3); });
}

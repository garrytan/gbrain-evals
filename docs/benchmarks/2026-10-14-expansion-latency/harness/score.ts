// Scores run/rows.ndjson against the GBRA-94 preregistered rule (2026-10-14-expansion-latency-preregistration.md).
//   EVAL_ROOT=... GBRAIN_EVALS_DATASETS=... bun score.ts [rows.ndjson] [subset-k300.json] [subset-k90.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLmeS } from '../evals/eval/runner/memory-qa/corpus.ts';
import { Sanitizer } from '../evals/eval/runner/systems/sanitize.ts';
import { ARMS } from './arms-spec.ts';
import { cleanRead, SKIP_RULES } from './rules.ts';

const ROOT = process.env.EVAL_ROOT ?? (() => { throw new Error('set EVAL_ROOT to the run directory'); })();
const [rowsName = 'rows.ndjson', k300 = join(ROOT, '..', 'subset-k300.json'), k90 = join(ROOT, '..', 'subset-k90.json')] = process.argv.slice(2);
const REF = 'A1';
const SCREEN_ARM = 'C-gemini-3.8-flash';
const nd = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rows = nd(join(ROOT, rowsName));
const calls = nd(join(ROOT, 'calls.ndjson'));
const subset300: string[] = JSON.parse(readFileSync(k300, 'utf8')).question_ids;
const subset90 = new Set<string>(JSON.parse(readFileSync(k90, 'utf8')).question_ids);

const corpus = loadLmeS();
const sanitizer = new Sanitizer(corpus, 'gbra86');
const qById = new Map(corpus.questions.map(q => [q.id, q]));
const convById = new Map(corpus.conversations.map(c => [c.id, c]));
const probeText = (qid: string) => { const last = sanitizer.ingestPlan(convById.get(qid)!).at(-1)!.input; return [...last.turns].sort((x, y) => y.content.length - x.content.length)[0]!.content.slice(0, 300); };
const textOf = (qid: string, kind: string) => kind === 'q' ? qById.get(qid)!.question : probeText(qid);

const byKey = new Map<string, any>();
for (const r of rows) byKey.set(`${r.qid}.${r.kind}.${r.arm}`, r);
const callsBy = new Map<string, any[]>();
for (const c of calls) if (c.arm && c.key) { const k = `${c.arm}|${c.key}`; (callsBy.get(k) ?? callsBy.set(k, []).get(k)!).push(c); }

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN; };
function mcnemar(b: number, c: number) {
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c); let p = 0; let comb = 1;
  for (let i = 0; i <= n; i++) { if (i > 0) comb = comb * (n - i + 1) / i; if (i <= k) p += comb; }
  return Math.min(1, 2 * p / 2 ** n);
}
// Union length of [start, end] intervals.
const unionMs = (iv: Array<[number, number]>) => { let tot = 0, curS = -Infinity, curE = -Infinity; for (const [s, e] of [...iv].sort((a, b) => a[0] - b[0])) { if (s > curE) { if (curE > curS) tot += curE - curS; curS = s; curE = e; } else curE = Math.max(curE, e); } if (curE > curS) tot += curE - curS; return tot; };

// One query's measurements in one measured arm.
function measure(arm: string, qid: string, kind: string) {
  const r = byKey.get(`${qid}.${kind}.${arm}`);
  const expansionOff = ARMS.find(a => a.id === arm)?.expand === false;
  if (!r) return null;
  const end = r.t, start = r.t - r.ms - 50;
  const cs = (callsBy.get(`${arm}|${qid}.${kind}`) ?? []).filter(c => c.t >= start && c.t <= end + 50);
  const llm = cs.filter(c => c.kind === 'llm' && !c.cached && c.upstream_ms != null);
  const misses: Array<[number, number]> = cs.filter(c => (c.kind === 'embed' || c.kind === 'rerank') && c.upstream_ms != null).map(c => [c.t - c.upstream_ms, c.t]);
  const frozenMs = r.ok && r.gbrain_ms != null ? r.gbrain_ms - unionMs(misses) : null;
  return {
    ok: !!r.ok, clean: !!r.ok && cleanRead({ outcome: r.outcome, reasons: r.reasons }, expansionOff), applied: r.expansion_applied === true,
    r10: r.ok && kind === 'q' ? r.r10 : 0, r5: r.ok && kind === 'q' ? r.r5 : 0, ndcg: r.ok && kind === 'q' ? r.ndcg10 : 0, found: !!r.found,
    expMs: llm.length ? llm.reduce((a, c) => a + c.upstream_ms, 0) : 0, expUsd: llm.reduce((a, c) => a + (c.usd ?? 0), 0), llmCalls: llm.length,
    stageExpMs: r.timings?.stages_ms?.expansion ?? 0, e2eMs: frozenMs, category: r.category,
  };
}
type M = NonNullable<ReturnType<typeof measure>>;
const derived = (rule: (q: string) => boolean) => (qid: string, kind: string): (M & { skipped: boolean }) | null => {
  const skipped = rule(textOf(qid, kind));
  const m = measure(skipped ? 'B' : REF, qid, kind);
  return m ? { ...m, skipped } : null;
};
const sources: Record<string, (qid: string, kind: string) => (M & { skipped?: boolean }) | null> = {};
for (const a of ARMS) sources[a.id] = (qid, kind) => measure(a.id, qid, kind);
for (const [id, rule] of Object.entries(SKIP_RULES)) sources[id] = derived(rule);

const armQids = (id: string) => (id === SCREEN_ARM ? subset300.filter(q => subset90.has(q)) : subset300)
  .filter(q => ['q', 'p'].every(k => byKey.has(`${q}.${k}.${id === SCREEN_ARM || ARMS.some(a => a.id === id) ? id : REF}`)));

function stat(id: string, qids: string[]) {
  let r10 = 0, r5 = 0, ndcg = 0, qClean = 0, pClean = 0, found = 0, invalid = 0, usd = 0, skippedQ = 0, skippedP = 0, notApplied = 0;
  const types: Record<string, number> = {}; const hits10 = new Map<string, number>();
  const exp: number[] = [], e2e: number[] = [], e2eQ: number[] = [], stageExp: number[] = [];
  for (const q of qids) for (const kind of ['q', 'p'] as const) {
    const m = sources[id](q, kind);
    if (!m || !m.ok) { invalid++; if (kind === 'q') { hits10.set(q, 0); types[qById.get(q)!.category] = (types[qById.get(q)!.category] ?? 0); } continue; }
    if (kind === 'q') { r10 += m.r10; r5 += m.r5; ndcg += m.ndcg; qClean += m.clean ? 1 : 0; hits10.set(q, m.r10); types[m.category] = (types[m.category] ?? 0) + m.r10; if (m.skipped) skippedQ++; }
    else { pClean += m.clean ? 1 : 0; found += m.found ? 1 : 0; if (m.skipped) skippedP++; }
    const expanding = id !== 'B' && !m.skipped;
    if (expanding && !m.applied) notApplied++;
    usd += m.expUsd; exp.push(m.expMs); stageExp.push(m.stageExpMs);
    if (m.e2eMs != null) { e2e.push(m.e2eMs); if (kind === 'q') e2eQ.push(m.e2eMs); }
  }
  const n = qids.length;
  return { arm: id, n, r10, r5, ndcg: ndcg / n, qClean, pClean, found, invalid, invalidShare: invalid / (2 * n), types, hits10,
    skipped: { real: skippedQ, probe: skippedP, share: (skippedQ + skippedP) / (2 * n) }, expansionNotApplied: notApplied,
    expP50: pct(exp, 0.5), expP95: pct(exp, 0.95), stageExpP50: pct(stageExp, 0.5), stageExpP95: pct(stageExp, 0.95),
    e2eP50: pct(e2e, 0.5), e2eP95: pct(e2e, 0.95), e2eRealP50: pct(e2eQ, 0.5), e2eRealP95: pct(e2eQ, 0.95), usdPer1k: usd / (2 * n) * 1000 };
}

const ids = [...ARMS.map(a => a.id), ...Object.keys(SKIP_RULES)];
const out = ids.map(id => {
  const qids = armQids(id);
  const s = stat(id, qids), ref = stat(REF, qids);
  let onlyArm = 0, onlyRef = 0;
  for (const q of qids) { const a = s.hits10.get(q) ?? 0, b = ref.hits10.get(q) ?? 0; if (a && !b) onlyArm++; if (b && !a) onlyRef++; }
  const typeLoss = Object.fromEntries(Object.keys(ref.types).map(t => [t, ref.types[t] - (s.types[t] ?? 0)]));
  const checks = {
    strict10: s.r10 >= ref.r10 - 2,
    types: Object.values(typeLoss).every(v => v <= 2),
    ndcg: s.ndcg >= ref.ndcg - 0.005,
    clean: s.qClean >= ref.qClean - 2 && s.pClean >= ref.pClean - 2,
    valid: s.invalidShare <= 0.02,
  };
  const { hits10: _h, ...rest } = s;
  return { ...rest, ref_on_same: { n: ref.n, r10: ref.r10, ndcg: ref.ndcg, e2eP50: ref.e2eP50 }, onlyArm, onlyRef, mcnemar_p: mcnemar(onlyArm, onlyRef), typeLoss, checks,
    acceptable: id === REF ? null : Object.values(checks).every(Boolean), screen: id === SCREEN_ARM, noise_rerun: id === 'A2' };
});
const eligible = out.filter(o => o.acceptable && !o.noise_rerun && !o.screen);
const fastest = [...eligible].sort((a, b) => a.e2eP50 - b.e2eP50)[0];
const tied = fastest ? eligible.filter(o => o.e2eP50 <= fastest.e2eP50 * 1.05).sort((a, b) => a.usdPer1k - b.usdPer1k || a.e2eP50 - b.e2eP50) : [];
const refRow = out.find(o => o.arm === REF)!;
const recommended = tied[0] && tied[0].e2eP50 < refRow.e2eP50 ? tied[0].arm : null;
const verdict = { reference: REF, n_questions: subset300.length, recommended, rule: 'fastest acceptable arm by end-to-end p50 (frozen providers); within 5% of it, the cheaper; none faster than the reference = keep the default', arms: out };
writeFileSync(join(ROOT, 'verdict.json'), JSON.stringify(verdict, null, 1));
const f = (x: number, d = 0) => Number.isFinite(x) ? x.toFixed(d) : '-';
console.log(`recommended: ${recommended ?? 'keep the default (A)'}`);
console.log('| arm | n | strict@10 | +/- vs A1 | strict@5 | nDCG@10 | clean q/p | found | max type loss | skipped | exp p50/p95 ms | e2e p50/p95 ms | real e2e p50/p95 | exp $/1k | ok |');
for (const o of out) console.log(`| ${o.arm} | ${o.n} | ${o.r10} | +${o.onlyArm}/−${o.onlyRef} | ${o.r5} | ${f(o.ndcg, 4)} | ${o.qClean}/${o.pClean} | ${o.found} | ${Math.max(0, ...Object.values(o.typeLoss) as number[])} | ${f(o.skipped.share * 100, 1)}% | ${f(o.expP50)}/${f(o.expP95)} | ${f(o.e2eP50)}/${f(o.e2eP95)} | ${f(o.e2eRealP50)}/${f(o.e2eRealP95)} | ${f(o.usdPer1k, 3)} | ${o.acceptable === null ? 'ref' : o.acceptable ? 'yes' : 'no: ' + Object.entries(o.checks).filter(([, v]) => !v).map(([k]) => k).join(',')} |`);

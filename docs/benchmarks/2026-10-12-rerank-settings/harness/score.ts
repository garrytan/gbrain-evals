// Scores run/rows.ndjson against the preregistered rule (2026-10-12-rerank-settings-preregistration.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CELLS_SPEC } from './cells-spec.ts';

const ROOT = process.env.EVAL_ROOT ?? join(process.env.HOME!, '.capy/work/gbra86/run');
const PRICE: Record<string, number> = { 'rerank-2.5': 0.05, 'rerank-2.5-lite': 0.02 };
const rows = readFileSync(join(ROOT, 'rows.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const calls = readFileSync(join(ROOT, 'cell-calls.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const REF = 'ref.50x1400.r25';

// latest row per (qid, kind, cell)
const byKey = new Map<string, any>();
for (const r of rows) byKey.set(`${r.qid}.${r.kind}.${r.cell}`, r);
const qids = [...new Set(rows.map(r => r.qid))].filter(q => CELLS_SPEC.every(c => byKey.has(`${q}.q.${c.id}`) && byKey.has(`${q}.p.${c.id}`))).sort();
// billed tokens per (key, cell): the call made for the scored row (cached replays repeat the same usage)
const billed = new Map<string, { tokens: number; match: boolean }>();
for (const c of calls) billed.set(`${c.key}.${c.cell}`, { tokens: c.billed_tokens ?? 0, match: c.match });

function mcnemar(b: number, c: number) {
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c); let p = 0; let comb = 1;
  for (let i = 0; i <= n; i++) { if (i > 0) comb = comb * (n - i + 1) / i; if (i <= k) p += comb; }
  return Math.min(1, 2 * p / 2 ** n);
}

const ok = (r: any) => r && r.ok;
const stat = (cellId: string) => {
  const model = CELLS_SPEC.find(c => c.id === cellId)!.model;
  let r5 = 0, r10 = 0, ndcg = 0, qClean = 0, pClean = 0, found = 0, invalid = 0, tq = 0, tp = 0;
  const hits10 = new Map<string, number>();
  const types: Record<string, number> = {};
  for (const q of qids) {
    const rq = byKey.get(`${q}.q.${cellId}`), rp = byKey.get(`${q}.p.${cellId}`);
    const bq = billed.get(`${q}.q.${cellId}`), bp = billed.get(`${q}.p.${cellId}`);
    if (!ok(rq) || bq?.match === false) invalid++;
    if (!ok(rp) || bp?.match === false) invalid++;
    const h10 = ok(rq) ? rq.r10 : 0;
    hits10.set(q, h10);
    types[rq.category] = (types[rq.category] ?? 0) + h10;
    r10 += h10; r5 += ok(rq) ? rq.r5 : 0; ndcg += ok(rq) ? rq.ndcg10 : 0;
    qClean += ok(rq) && rq.outcome === 'scored' ? 1 : 0;
    pClean += ok(rp) && rp.outcome === 'scored' ? 1 : 0;
    found += ok(rp) && rp.found ? 1 : 0;
    tq += bq?.tokens ?? 0; tp += bp?.tokens ?? 0;
  }
  const n = qids.length;
  return { cell: cellId, model, n, r10, r5, ndcg: ndcg / n, qClean, pClean, found, invalid, invalidShare: invalid / (2 * n), types, hits10,
    tokensPerQuery: (tq + tp) / (2 * n), tokensReal: tq / n, tokensProbe: tp / n, usdPerQuery: (tq + tp) / (2 * n) * PRICE[model] / 1e6 };
};

const ref = stat(REF);
const out = CELLS_SPEC.map(c => {
  const s = stat(c.id);
  let onlyCell = 0, onlyRef = 0;
  for (const q of qids) { const a = s.hits10.get(q)!, b = ref.hits10.get(q)!; if (a && !b) onlyCell++; if (b && !a) onlyRef++; }
  const typeLoss = Object.fromEntries(Object.keys(ref.types).map(t => [t, ref.types[t] - (s.types[t] ?? 0)]));
  const checks = {
    strict10: s.r10 >= ref.r10 - 2,
    types: Object.values(typeLoss).every(v => v <= 2),
    ndcg: s.ndcg >= ref.ndcg - 0.005,
    clean: s.qClean >= ref.qClean - 2 && s.pClean >= ref.pClean - 2,
    valid: s.invalidShare <= 0.02,
  };
  const { hits10: _h, ...rest } = s;
  return { ...rest, onlyCell, onlyRef, mcnemar_p: mcnemar(onlyCell, onlyRef), typeLoss, checks, acceptable: c.id === REF ? null : Object.values(checks).every(Boolean), costCut: 1 - s.usdPerQuery / ref.usdPerQuery };
});
const acceptable = out.filter(o => o.acceptable).sort((a, b) => a.usdPerQuery - b.usdPerQuery);
const verdict = { n_questions: qids.length, reference: REF, recommended: acceptable[0]?.cell ?? null, recommended_cost_cut: acceptable[0]?.costCut ?? null, cells: out };
writeFileSync(join(ROOT, 'verdict.json'), JSON.stringify(verdict, null, 1));
const f = (x: number, d = 4) => x.toFixed(d);
console.log(`n=${qids.length} questions; recommended: ${verdict.recommended} (cut ${verdict.recommended_cost_cut !== null ? f(verdict.recommended_cost_cut * 100, 1) + '%' : '-'})`);
console.log('| cell | strict@10 | +/- vs ref | strict@5 | nDCG@10 | clean q/p | found | max type loss | tok/query | $/1k queries | cut | ok |');
for (const o of out) console.log(`| ${o.cell} | ${o.r10} | ${o.onlyCell}/${o.onlyRef} | ${o.r5} | ${f(o.ndcg)} | ${o.qClean}/${o.pClean} | ${o.found} | ${Math.max(...Object.values(o.typeLoss) as number[])} | ${Math.round(o.tokensPerQuery)} | ${f(o.usdPerQuery * 1000, 3)} | ${f(o.costCut * 100, 1)}% | ${o.acceptable === null ? 'ref' : o.acceptable ? 'yes' : 'no: ' + Object.entries(o.checks).filter(([, v]) => !v).map(([k]) => k).join(',')} |`);

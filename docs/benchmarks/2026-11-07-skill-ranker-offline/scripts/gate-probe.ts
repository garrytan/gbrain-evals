
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DIR, readJsonl } from './lib.ts';
import { SIZES, K, view, bm25Index, bm25, lex, FIELDS, order, ratioOf } from './rank.ts';
const all = gunzipSync(readFileSync(join(DIR, 'data/catalog.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const cal = JSON.parse(readFileSync(join(DIR, 'results/calibration.json'), 'utf8'));
const p = cal.calibration.D.A5.cfg.bm25;
const rd = (f: string) => readJsonl<any>(join(DIR, 'data', f));
const dev = [...rd('dev.jsonl'), ...rd('stress-dev.jsonl')], test = [...rd('test.jsonl'), ...rd('stress-test.jsonl')];
const fieldText = (s: any, f: string) => (f === 'name' ? s.name.replace(/[-_:]/g, ' ') : f === 'description' ? s.description : f === 'body' ? s.body : '');
type Feat = Record<string, number>;
function run(size: number, turns: any[]) {
  const cat = view(all, size as any, 'D');
  const ix = bm25Index(cat, ['name', 'description', 'triggers', 'routing', 'body'] as any);
  const inCat = new Set(cat.map((s: any) => s.id));
  const idfmax = Math.log(1 + (cat.length - 0.5) / 1.5);
  return turns.map(t => {
    const full: string[] = t.acceptable; const acc = new Set(full.filter(id => inCat.has(id)));
    const cls = full.length === 0 ? 'nsn' : acc.size === 0 ? 'absent' : 'skill';
    const { scores, norm } = bm25(ix, t.text, p);
    const n = new Float64Array(scores.length); if (norm > 0) for (let i = 0; i < n.length; i++) n[i] = scores[i] / norm;
    const o = order(cat, n, 10);
    const ids = o.slice(0, K).map(i => cat[i].id); const pos = ids.findIndex(id => acc.has(id));
    const f: Feat = {};
    if (o.length) {
      const top = o[0]; const raw = scores[top];
      const pos2 = [...scores].filter(x => x > 0); const mean = pos2.reduce((a, b) => a + b, 0) / pos2.length; const sd = Math.sqrt(pos2.reduce((a, b) => a + (b - mean) ** 2, 0) / pos2.length) || 1;
      const nameDesc = new Set([...lex(fieldText(cat[top], 'name')), ...lex(fieldText(cat[top], 'description'))]);
      const qterms = [...new Set(lex(t.text))].filter(q => ix.df.get(q));
      let strongIdf = 0, strongCount = 0; for (const q of qterms) if (nameDesc.has(q)) { strongIdf += Math.log(1 + (ix.n - ix.df.get(q)! + 0.5) / (ix.df.get(q)! + 0.5)); strongCount++; }
      const nameTerms = new Set(lex(fieldText(cat[top], 'name')));
      const strength = qterms.some(q => nameTerms.has(q)) ? 2 : strongCount > 0 ? 1 : 0;
      const maxRaw = Math.max(...pos2);
      f.raw = raw; f.rawN = raw / idfmax; f.ratio = ratioOf(n, o); f.z = (raw - mean) / sd; f.zmax = (maxRaw - mean) / sd;
      f.strongIdfN = strongIdf / idfmax; f.strongCount = strongCount; f.strength = strength; f.norm = n[top];
      f.rawN_s1 = strength >= 1 ? f.rawN : 0; f.strongIdfN_s = strength >= 1 ? f.strongIdfN : 0;
    }
    return { cls, hit: pos >= 0, shownBase: o.length > 0, f };
  });
}
const FEATS = ['raw', 'rawN', 'ratio', 'z', 'zmax', 'strongIdfN', 'strongCount', 'norm', 'rawN_s1', 'strongIdfN_s'];
const rate = (xs: boolean[]) => xs.length ? xs.filter(Boolean).length / xs.length : 0;
const wilson = (k: number, n: number) => { if (!n) return [0, 0]; const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d].map(x => +x.toFixed(2)); };
function at(rs: any[], feat: string, tau: number) {
  const sk = rs.filter(r => r.cls === 'skill'), ns = rs.filter(r => r.cls === 'nsn');
  const sh = (r: any) => r.shownBase && (r.f[feat] ?? 0) >= tau;
  return { g: rate(sk.map(r => sh(r) && r.hit)), fsr: rate(ns.map(sh)), nsk: sk.length, nns: ns.length, kf: ns.filter(sh).length, kg: sk.filter(r => sh(r) && r.hit).length, h5: rate(sk.map(r => r.hit)) };
}
function tune(rs: any[], feat: string, cap = 0.25) {
  const cands = [...new Set([0, ...rs.map(r => r.f[feat] ?? 0)])].sort((a, b) => a - b);
  const ok = cands.map(t => ({ t, ...at(rs, feat, t) })).filter(s => s.fsr < cap);
  return ok.reduce((a, s) => (s.g > a.g ? s : a));
}
const out: any = {};
const devRuns: any = {}, testRuns: any = {};
for (const size of SIZES) { devRuns[size] = run(size, dev); testRuns[size] = run(size, test); }
for (const feat of FEATS) {
  const tuned = tune(devRuns[750], feat);
  out[feat] = { tau: +tuned.t.toFixed(4), dev750: { g: +tuned.g.toFixed(3), fsr: +tuned.fsr.toFixed(3) }, test: SIZES.map(s => { const a = at(testRuns[s], feat, tuned.t); return { size: s, ungated_h5: +a.h5.toFixed(3), gated_h5: +a.g.toFixed(3), gci: wilson(a.kg, a.nsk), fsr: +a.fsr.toFixed(3), fci: wilson(a.kf, a.nns), n: [a.nsk, a.nns] }; }),
    ceiling: SIZES.map(s => { const c = tune(testRuns[s], feat); return { size: s, g: +c.g.toFixed(3), fsr: +c.fsr.toFixed(3) }; }) };
}
console.log(JSON.stringify(out, null, 0));

/**
 * Calibrate on dev (catalog 750), then score every arm on the frozen test
 * split at 250, 750 and 1,500 skills, in variants D (description-only,
 * primary) and T (with triggers), and apply the preregistered bars.
 *
 *   bun scripts/score.ts   -> results/calibration.json, results/arms-test.json,
 *                             results/verdict.json, results/per-turn-test.jsonl
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, TOKENIZER, fileSha, readJsonl, sha256 } from './lib.ts';
import {
  lex, B, FIELDS, K, SIZES, blockText, bm25Index, listings, rankA2, rankBm25, rankHybrid, view,
  type Bm25Index, type Bm25Params, type Field, type Ranked, type Size, type Skill, type Variant,
} from './rank.ts';

interface Turn { id: string; area: string; intent: string; text: string; acceptable: string[] }
const PREREG = join(DIR, '../2026-11-07-skill-ranker-offline-preregistration.md');

const all = readJsonl<Skill>(join(DIR, 'data/catalog.jsonl'));
const testSha = fileSha(join(DIR, 'data/test.jsonl'));
if (!readFileSync(PREREG, 'utf8').includes(`test.jsonl sha256 ${testSha}`)) throw new Error(`data/test.jsonl sha256 ${testSha} is not the hash the preregistration froze`);
const stressSha = fileSha(join(DIR, 'data/stress-test.jsonl'));
if (!readFileSync(PREREG, 'utf8').includes(`stress-test.jsonl sha256 ${stressSha}`)) throw new Error(`data/stress-test.jsonl sha256 ${stressSha} is not the hash Amendment 3 froze`);
const dev = readJsonl<Turn>(join(DIR, 'data/dev.jsonl'));
const test = readJsonl<Turn>(join(DIR, 'data/test.jsonl'));
const stressDev = readJsonl<Turn>(join(DIR, 'data/stress-dev.jsonl'));
const stressTest = readJsonl<Turn>(join(DIR, 'data/stress-test.jsonl'));
const springLines = readFileSync(join(DIR, 'data/spring-block.txt'), 'utf8').split('\n').filter(l => l.startsWith('- ')).map(l => ({ name: /^- ([^:]+)/.exec(l)![1].trim(), text: l }));
const usage = new Map<string, number>();
for (const t of dev) for (const id of t.acceptable) usage.set(id, (usage.get(id) ?? 0) + 1);
const decode = (b64: string) => new Float32Array(Buffer.from(b64, 'base64').buffer.slice(0));
const emb: Record<'A6' | 'A7', { skills: Map<string, Float32Array>; turns: Map<string, Float32Array> }> = {} as any;
for (const [arm, file] of [['A6', 'local'], ['A7', 'openai']] as const) {
  const j = JSON.parse(readFileSync(join(DIR, `cache/emb-${file}.json`), 'utf8'));
  emb[arm] = { skills: new Map(Object.entries(j.skills).map(([k, v]) => [k, decode(v as string)])), turns: new Map(Object.entries(j.turns).map(([k, v]) => [k, decode(v as string)])) };
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

type PerTurnArm = 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7';
const DEPLOYABLE: PerTurnArm[] = ['A2', 'A3', 'A4', 'A5'];
const FIELDSET: Record<string, Field[]> = { A3: ['name', 'description'], A4: ['name', 'description', 'triggers', 'routing'], A5: ['name', 'description', 'triggers', 'routing', 'body'] };
interface Config { bm25?: Bm25Params; w?: number }

const views = new Map<string, Skill[]>();
const getView = (size: Size, v: Variant) => { const k = `${size}${v}`; if (!views.has(k)) views.set(k, view(all, size, v)); return views.get(k)!; };
const indexes = new Map<string, Bm25Index>();
const getIndex = (size: Size, v: Variant, fields: Field[]) => { const k = `${size}${v}${fields.join()}`; if (!indexes.has(k)) indexes.set(k, bm25Index(getView(size, v), fields)); return indexes.get(k)!; };
const vecCache = new Map<string, Float32Array[]>();
const skillVecs = (arm: 'A6' | 'A7', size: Size, v: Variant) => { const k = `${arm}${size}${v}`; if (!vecCache.has(k)) vecCache.set(k, getView(size, v).map(s => emb[arm].skills.get(s.id)!)); return vecCache.get(k)!; };

function rank(arm: PerTurnArm, cfg: Config, size: Size, v: Variant, t: Turn): Ranked {
  const cat = getView(size, v);
  if (arm === 'A2') return rankA2(cat, t.text);
  if (arm === 'A6' || arm === 'A7') {
    const b = rankBm25(cat, getIndex(size, v, FIELDSET.A4), t.text, cfg.bm25!);
    return { ...rankHybrid(cat, b.norm, skillVecs(arm, size, v), emb[arm].turns.get(t.id)!, cfg.w!), raw: b.raw };
  }
  return rankBm25(cat, getIndex(size, v, FIELDSET[arm]), t.text, cfg.bm25!);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

type Labels = Map<string, string[]>;
const pass1: Labels = new Map([...dev, ...test, ...stressDev, ...stressTest].map(t => [t.id, t.acceptable]));
type GateKind = 'norm' | 'ratio' | 'raw' | 'len';
const GATES: GateKind[] = ['norm', 'ratio', 'raw'];
interface TurnResult { id: string; cls: 'skill' | 'nsn' | 'absent'; hitAt: number; top: number; feats: Record<GateKind, number>; shown: boolean; ids: string[]; blockTokens: number }

function runArm(arm: PerTurnArm, cfg: Config, tau: number, size: Size, v: Variant, turns: Turn[], labels: Labels, gate: GateKind = 'norm'): TurnResult[] {
  const cat = getView(size, v);
  const inCat = new Set(cat.map(s => s.id));
  return turns.map(t => {
    const full = labels.get(t.id)!;
    const acc = new Set(full.filter(id => inCat.has(id)));
    const cls = full.length === 0 ? 'nsn' : acc.size === 0 ? 'absent' : 'skill';
    const r = rank(arm, cfg, size, v, t);
    const ids = r.order.map(i => cat[i].id);
    const pos = ids.findIndex(id => acc.has(id));
    const feats = { norm: r.top, ratio: r.ratio, raw: r.raw, len: lex(t.text).length };
    const shown = r.order.length > 0 && feats[gate] >= tau;
    return { id: t.id, cls, hitAt: pos < 0 ? 0 : pos + 1, top: feats[gate], feats, shown, ids: ids.slice(0, K), blockTokens: shown ? Math.ceil(Buffer.byteLength(blockText(r.order.slice(0, K).map(i => cat[i])), 'utf8') / 4) : 0 };
  });
}

const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
function summarize(rs: TurnResult[]) {
  const sk = rs.filter(r => r.cls === 'skill');
  const nsn = rs.filter(r => r.cls === 'nsn');
  const ab = rs.filter(r => r.cls === 'absent');
  const hit = (k: number) => rate(sk.map(r => r.hitAt > 0 && r.hitAt <= k));
  return {
    n_skill: sk.length, n_no_skill_needed: nsn.length, n_absent: ab.length,
    hit1: hit(1), hit3: hit(3), hit5: hit(5), mrr10: sk.length ? sk.reduce((a, r) => a + (r.hitAt ? 1 / r.hitAt : 0), 0) / sk.length : 0,
    gated_hit5: rate(sk.map(r => r.shown && r.hitAt > 0 && r.hitAt <= K)),
    fsr: rate(nsn.map(r => r.shown)), absent_suggest_rate: rate(ab.map(r => r.shown)),
    block_tokens_mean: rs.reduce((a, r) => a + r.blockTokens, 0) / rs.length,
    block_tokens_mean_when_shown: rs.filter(r => r.shown).reduce((a, r) => a + r.blockTokens, 0) / Math.max(1, rs.filter(r => r.shown).length),
  };
}

function calibrateGate(rs: TurnResult[]): { tau: number; dev_gated_hit5: number; dev_fsr: number } {
  const cands = [...new Set([0, ...rs.map(r => r.top)])].sort((a, b) => a - b);
  const sk = rs.filter(r => r.cls === 'skill');
  const nsn = rs.filter(r => r.cls === 'nsn');
  const at = (tau: number) => ({ tau, g: rate(sk.map(r => r.top >= tau && r.hitAt > 0 && r.hitAt <= K && r.ids.length > 0)), f: rate(nsn.map(r => r.ids.length > 0 && r.top >= tau)) });
  const scored = cands.map(at);
  const ok = scored.filter(s => s.f <= 0.15);
  const best = ok.length ? ok.reduce((a, s) => (s.g > a.g ? s : a)) : scored.reduce((a, s) => (s.f < a.f ? s : a));
  return { tau: best.tau, dev_gated_hit5: best.g, dev_fsr: best.f };
}

// ---------------------------------------------------------------------------
// Calibration on dev @ 750
// ---------------------------------------------------------------------------

const baseW = (name: number, trig = 0, body = 0): Record<Field, number> => ({ name, description: 1, triggers: trig, routing: trig, body });
function tune(arm: PerTurnArm, v: Variant, grid: Config[]) {
  let best: { cfg: Config; hit5: number; mrr: number } | null = null;
  for (const cfg of grid) {
    const s = summarize(runArm(arm, cfg, 0, 750, v, dev, pass1));
    if (!best || s.hit5 > best.hit5 || (s.hit5 === best.hit5 && s.mrr10 > best.mrr)) best = { cfg, hit5: s.hit5, mrr: s.mrr10 };
  }
  const gates = Object.fromEntries(GATES.map(k => [k, calibrateGate(runArm(arm, best!.cfg, 0, 750, v, dev, pass1, k))])) as Record<GateKind, ReturnType<typeof calibrateGate>>;
  return { cfg: best!.cfg, dev_ungated_hit5: best!.hit5, dev_mrr10: best!.mrr, grid_points: grid.length, ...gates.norm, gates };
}

const calibration: Record<Variant, Record<string, ReturnType<typeof tune>>> = { D: {}, T: {} };
for (const v of ['D', 'T'] as Variant[]) {
  const c = calibration[v];
  c.A2 = tune('A2', v, [{}]);
  const g3: Config[] = [];
  for (const k1 of [0.9, 1.2, 1.6]) for (const b of [0.4, 0.75]) for (const wn of [1, 2, 3]) g3.push({ bm25: { k1, b, w: baseW(wn) } });
  c.A3 = tune('A3', v, g3);
  if (v === 'T') {
    const g4: Config[] = [];
    for (const k1 of [0.9, 1.2, 1.6]) for (const b of [0.4, 0.75]) for (const wn of [1, 2, 3]) for (const wt of [1, 2, 3]) g4.push({ bm25: { k1, b, w: baseW(wn, wt) } });
    c.A4 = tune('A4', v, g4);
  } else c.A4 = c.A3;
  const a4 = c.A4.cfg.bm25!;
  c.A5 = tune('A5', v, [0.2, 0.5, 1].map(wb => ({ bm25: { ...a4, w: { ...a4.w, body: wb } } })));
  for (const arm of ['A6', 'A7'] as const) c[arm] = tune(arm, v, [0.3, 0.5, 0.7].map(w => ({ bm25: a4, w })));
}

if (process.argv.includes('--dev-only')) {
  for (const v of ['D', 'T'] as Variant[]) for (const [arm, c] of Object.entries(calibration[v])) console.log(v, arm, JSON.stringify(c));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

function seeded(seed: string) {
  let s = parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function bootCI(diffs: number[], seed: string): [number, number] {
  const rnd = seeded(`gbra377-boot${seed}`);
  const means: number[] = [];
  for (let i = 0; i < 2000; i++) { let s = 0; for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rnd() * diffs.length)]; means.push(s / diffs.length); }
  means.sort((a, b) => a - b);
  return [means[49], means[1949]];
}

const ARMS: PerTurnArm[] = ['A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
type Table = Record<Variant, Record<Size, { per_turn: Record<string, ReturnType<typeof summarize>>; config_only: Record<string, { hit: number; tokens: number; count: number; n_skill: number }> }>>;
const raw: Record<string, TurnResult[]> = {};
function evaluate(labels: Labels): Table {
  const table = {} as Table;
  for (const v of ['D', 'T'] as Variant[]) {
    table[v] = {} as Table[Variant];
    for (const size of SIZES) {
      const per_turn: Record<string, ReturnType<typeof summarize>> = {};
      for (const arm of ARMS) {
        if (v === 'D' && arm === 'A4') continue;
        const c = calibration[v][arm];
        const rs = runArm(arm, c.cfg, c.tau, size, v, test, labels);
        raw[`${v}|${size}|${arm}`] = rs;
        per_turn[arm] = summarize(rs);
      }
      const cat = getView(size, v);
      const inCat = new Set(cat.map(s => s.id));
      const sk = test.filter(t => labels.get(t.id)!.some(id => inCat.has(id)));
      const config_only: Table[Variant][Size]['config_only'] = {};
      for (const l of listings(cat, usage, springLines)) {
        config_only[`${l.arm}:${l.mode}`] = { hit: rate(sk.map(t => labels.get(t.id)!.some(id => l.ids.has(id)))), tokens: l.tokens, count: l.count, n_skill: sk.length };
      }
      table[v][size] = { per_turn, config_only };
    }
  }
  return table;
}

const table = evaluate(pass1);
const rawPass1 = { ...raw };

function configDiffs(v: Variant, size: Size, arm: PerTurnArm, listingKey: string, labels: Labels): number[] {
  const cat = getView(size, v);
  const l = listings(cat, usage, springLines).find(x => `${x.arm}:${x.mode}` === listingKey)!;
  return rawPass1[`${v}|${size}|${arm}`].filter(r => r.cls === 'skill').map(r => (r.shown && r.hitAt > 0 && r.hitAt <= K ? 1 : 0) - (labels.get(r.id)!.some(id => l.ids.has(id)) ? 1 : 0));
}
function armDiffs(v: Variant, size: Size, a: PerTurnArm, b: PerTurnArm): number[] {
  const ra = rawPass1[`${v}|${size}|${a}`], rb = new Map(rawPass1[`${v}|${size}|${b}`].map(r => [r.id, r]));
  return ra.filter(r => r.cls === 'skill').map(r => (r.hitAt > 0 && r.hitAt <= K ? 1 : 0) - (rb.get(r.id)!.hitAt > 0 && rb.get(r.id)!.hitAt <= K ? 1 : 0));
}
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

function bars(v: Variant, arm: PerTurnArm) {
  const win = SIZES.map(size => {
    const co = Object.entries(table[v][size].config_only).filter(([k]) => k.endsWith(':matched'));
    const [bestKey, best] = co.reduce((a, x) => (x[1].hit > a[1].hit ? x : a));
    const d = configDiffs(v, size, arm, bestKey, pass1);
    const natural = table[v][size].config_only['A0:natural'];
    return { size, gated_hit5: table[v][size].per_turn[arm].gated_hit5, best_config_matched: bestKey, best_config_hit: best.hit, diff: mean(d), ci95: bootCI(d, `${v}${size}${arm}win`), pass: mean(d) >= 0.1 - 1e-12, vs_A0_natural: table[v][size].per_turn[arm].gated_hit5 - natural.hit };
  });
  const fsr = SIZES.map(size => ({ size, fsr: table[v][size].per_turn[arm].fsr, pass: table[v][size].per_turn[arm].fsr <= 0.2 + 1e-12 }));
  const spread = Math.max(...fsr.map(f => f.fsr)) - Math.min(...fsr.map(f => f.fsr));
  return { arm, win, fsr, fsr_spread: spread, transfer_pass: spread <= 0.05 + 1e-12, pass: win.every(w => w.pass) && fsr.every(f => f.pass) && spread <= 0.05 + 1e-12 };
}

function verdictFor(v: Variant) {
  const candidates: PerTurnArm[] = v === 'D' ? ['A2', 'A3', 'A5'] : ['A2', 'A3', 'A4', 'A5'];
  const devChosen = candidates.reduce((a, x) => (calibration[v][x].dev_gated_hit5 > calibration[v][a].dev_gated_hit5 ? x : a));
  const base: PerTurnArm = v === 'D' ? 'A3' : 'A4';
  const cut = (arm: PerTurnArm, need: number) => { const d = armDiffs(v, 750, arm, base); return { arm, over: base, diff: mean(d), ci95: bootCI(d, `${v}${arm}cut`), need, kept: mean(d) >= need - 1e-12 }; };
  const body = cut('A5', 0.02);
  const embeddings = [cut('A6', 0.03), cut('A7', 0.03)];
  const chosen = devChosen === 'A5' && !body.kept ? base : devChosen;
  const all = Object.fromEntries((v === 'D' ? ARMS.filter(a => a !== 'A4') : ARMS).map(a => [a, bars(v, a)]));
  return { variant: v, dev_chosen: devChosen, chosen, chosen_reason: chosen === devChosen ? 'highest dev gated hit@5 at 750' : 'A5 chosen on dev but the bounded body added under 2 points on test, so the arm without it', body_cut_rule: body, embedding_cut_rule: embeddings, chosen_bars: all[chosen], every_arm_bars: all, pass: all[chosen].pass, embedding_only_pass: !all[chosen].pass && (all.A6?.pass || all.A7?.pass) };
}

const verdict = { D: verdictFor('D'), T: verdictFor('T') };

// ---------------------------------------------------------------------------
// Secondary analysis (Amendment 2): raw and ratio gates, length-only control,
// tau on dev + stress-dev, scored on test + stress-test and on each set.
// ---------------------------------------------------------------------------

const SEC_GATES: GateKind[] = ['raw', 'ratio', 'len'];
const devS = [...dev, ...stressDev];
const sets: Record<string, Turn[]> = { 'test+stress': [...test, ...stressTest], test, stress: stressTest };
const secTau: Record<Variant, Record<string, Record<string, ReturnType<typeof calibrateGate>>>> = { D: {}, T: {} };
for (const v of ['D', 'T'] as Variant[]) for (const arm of ARMS) {
  if (v === 'D' && arm === 'A4') continue;
  secTau[v][arm] = Object.fromEntries(SEC_GATES.map(k => [k, calibrateGate(runArm(arm, calibration[v][arm].cfg, 0, 750, v, devS, pass1, k))]));
}
const secRaw: Record<string, TurnResult[]> = {};
const secTable: Record<string, Record<Variant, Record<Size, Record<string, ReturnType<typeof summarize>>>>> = {};
for (const [setName, turns] of Object.entries(sets)) {
  secTable[setName] = { D: {} as any, T: {} as any };
  for (const v of ['D', 'T'] as Variant[]) for (const size of SIZES) {
    secTable[setName][v][size] = {};
    for (const arm of Object.keys(secTau[v]) as PerTurnArm[]) for (const k of SEC_GATES) {
      const rs = runArm(arm, calibration[v][arm].cfg, secTau[v][arm][k].tau, size, v, turns, pass1, k);
      secRaw[`${setName}|${v}|${size}|${arm}|${k}`] = rs;
      secTable[setName][v][size][`${arm}:${k}`] = summarize(rs);
    }
  }
}
function configHits(v: Variant, size: Size, turns: Turn[]) {
  const cat = getView(size, v);
  const inCat = new Set(cat.map(s => s.id));
  const sk = turns.filter(t => pass1.get(t.id)!.some(id => inCat.has(id)));
  return listings(cat, usage, springLines).filter(l => l.mode === 'matched').map(l => ({ key: `${l.arm}:matched`, ids: l.ids, hit: rate(sk.map(t => pass1.get(t.id)!.some(id => l.ids.has(id)))) }));
}
function secBars(v: Variant, arm: PerTurnArm, k: GateKind, setName: string) {
  const turns = sets[setName];
  const win = SIZES.map(size => {
    const best = configHits(v, size, turns).reduce((a, x) => (x.hit > a.hit ? x : a));
    const d = secRaw[`${setName}|${v}|${size}|${arm}|${k}`].filter(r => r.cls === 'skill').map(r => (r.shown && r.hitAt > 0 && r.hitAt <= K ? 1 : 0) - (pass1.get(r.id)!.some(id => best.ids.has(id)) ? 1 : 0));
    return { size, gated_hit5: secTable[setName][v][size][`${arm}:${k}`].gated_hit5, best_config_matched: best.key, best_config_hit: best.hit, diff: mean(d), ci95: bootCI(d, `${setName}${v}${size}${arm}${k}`), pass: mean(d) >= 0.1 - 1e-12 };
  });
  const fsr = SIZES.map(size => ({ size, fsr: secTable[setName][v][size][`${arm}:${k}`].fsr, pass: secTable[setName][v][size][`${arm}:${k}`].fsr <= 0.2 + 1e-12 }));
  const spread = Math.max(...fsr.map(f => f.fsr)) - Math.min(...fsr.map(f => f.fsr));
  return { arm, gate: k, set: setName, win, fsr, fsr_spread: spread, transfer_pass: spread <= 0.05 + 1e-12, pass: win.every(w => w.pass) && fsr.every(f => f.pass) && spread <= 0.05 + 1e-12 };
}
function secVerdict(v: Variant) {
  const arms: PerTurnArm[] = v === 'D' ? ['A2', 'A3', 'A5'] : ['A2', 'A3', 'A4', 'A5'];
  let chosen: { arm: PerTurnArm; gate: GateKind; dev: number } | null = null;
  for (const arm of arms) for (const k of ['raw', 'ratio'] as GateKind[]) {
    const d = secTau[v][arm][k].dev_gated_hit5;
    if (!chosen || d > chosen.dev) chosen = { arm, gate: k, dev: d };
  }
  const base: PerTurnArm = v === 'D' ? 'A3' : 'A4';
  const ungated = (setName: string, a: PerTurnArm, b: PerTurnArm) => {
    const ra = secRaw[`${setName}|${v}|750|${a}|raw`], rb = new Map(secRaw[`${setName}|${v}|750|${b}|raw`].map(r => [r.id, r]));
    const d = ra.filter(r => r.cls === 'skill').map(r => (r.hitAt > 0 && r.hitAt <= K ? 1 : 0) - (rb.get(r.id)!.hitAt > 0 && rb.get(r.id)!.hitAt <= K ? 1 : 0));
    return { arm: a, over: b, diff: mean(d), ci95: bootCI(d, `sec${setName}${v}${a}`) };
  };
  const body = ungated('test+stress', 'A5', base);
  let arm = chosen!.arm;
  if (arm === 'A5' && body.diff < 0.02 - 1e-12) arm = base;
  const gate = arm === chosen!.arm ? chosen!.gate : (secTau[v][base].raw.dev_gated_hit5 >= secTau[v][base].ratio.dev_gated_hit5 ? 'raw' : 'ratio');
  const every = Object.fromEntries(Object.keys(secTau[v]).flatMap(a => SEC_GATES.map(k => [`${a}:${k}`, secBars(v, a as PerTurnArm, k, 'test+stress')])));
  return {
    variant: v, dev_chosen: chosen, chosen: { arm, gate }, tau: secTau[v][arm][gate].tau, params: calibration[v][arm].cfg,
    bars: { 'test+stress': secBars(v, arm, gate, 'test+stress'), test: secBars(v, arm, gate, 'test'), stress: secBars(v, arm, gate, 'stress') },
    length_control: { 'test+stress': secBars(v, arm, 'len', 'test+stress'), stress: secBars(v, arm, 'len', 'stress') },
    body_cut_rule: body, embedding_cut_rule: [ungated('test+stress', 'A6', base), ungated('test+stress', 'A7', base)],
    every_arm_gate_bars: every,
  };
}
const secondary = { calibration_tau: secTau, table: secTable, verdict: { D: secVerdict('D'), T: secVerdict('T') } };

// Label stability: the same frozen arms scored on pass-2 labels.
let sensitivity: unknown = null;
const p2file = join(DIR, 'results/judge-pass2.jsonl');
if (existsSync(p2file)) {
  const p2rows = readJsonl<{ turn: string; acceptable: string[] }>(p2file);
  const pass2: Labels = new Map([...pass1, ...p2rows.map(r => [r.turn, r.acceptable] as [string, string[]])]);
  if ([...dev, ...test].every(t => pass2.has(t.id))) {
    const jac = [...dev, ...test].map(t => { const a = new Set(pass1.get(t.id)), b = new Set(pass2.get(t.id)); const u = new Set([...a, ...b]); return u.size ? [...a].filter(x => b.has(x)).length / u.size : 1; });
    const emptyAgree = rate([...dev, ...test].map(t => (pass1.get(t.id)!.length === 0) === (pass2.get(t.id)!.length === 0)));
    const t2 = evaluate(pass2);
    const ch = verdict.D.chosen;
    sensitivity = {
      mean_jaccard: mean(jac), empty_vs_nonempty_agreement: emptyAgree,
      D_chosen_arm_on_pass2: Object.fromEntries(SIZES.map(s => {
        const co = Object.entries(t2.D[s].config_only).filter(([k]) => k.endsWith(':matched')).reduce((a, x) => (x[1].hit > a[1].hit ? x : a));
        return [s, { gated_hit5: t2.D[s].per_turn[ch].gated_hit5, fsr: t2.D[s].per_turn[ch].fsr, best_config_matched: co[0], best_config_hit: co[1].hit, diff: t2.D[s].per_turn[ch].gated_hit5 - co[1].hit }];
      })),
      table_pass2: t2,
    };
  }
}

// Diagnostics (not decision inputs): the ranker with the gate off, and a
// test-tuned gate ceiling (the best threshold chosen on test itself, so an
// optimistic bound, never a valid estimate).
const diagnostics = {
  ungated_vs_best_config: Object.fromEntries((['A2', 'A3', 'A5', 'A6', 'A7'] as PerTurnArm[]).map(arm => [arm, SIZES.map(size => {
    const best = configHits('D', size, test).reduce((a, x) => (x.hit > a.hit ? x : a));
    const d = rawPass1[`D|${size}|${arm}`].filter(r => r.cls === 'skill').map(r => (r.hitAt > 0 && r.hitAt <= K ? 1 : 0) - (pass1.get(r.id)!.some(id => best.ids.has(id)) ? 1 : 0));
    return { size, ungated_hit5: table.D[size].per_turn[arm].hit5, best_config_matched: best.key, best_config_hit: best.hit, diff: mean(d), ci95: bootCI(d, `diag${size}${arm}`), fsr_ungated: 1 };
  })])),
  test_tuned_gate_ceiling: Object.fromEntries((['A2', 'A3', 'A5', 'A6', 'A7'] as PerTurnArm[]).flatMap(arm => (['norm', 'raw', 'ratio'] as GateKind[]).map(k => [`${arm}:${k}`, SIZES.map(size => {
    const rs = runArm(arm, calibration.D[arm].cfg, 0, size, 'D', sets['test+stress'], pass1, k);
    const sk = rs.filter(r => r.cls === 'skill'), nsn = rs.filter(r => r.cls === 'nsn');
    let best = { tau: 0, gated_hit5: 0, fsr: 1 };
    for (const tau of [...new Set(rs.map(r => r.feats[k]))]) {
      const f = rate(nsn.map(r => r.ids.length > 0 && r.feats[k] >= tau));
      const gh = rate(sk.map(r => r.feats[k] >= tau && r.hitAt > 0 && r.hitAt <= K));
      if (f <= 0.2 && gh > best.gated_hit5) best = { tau, gated_hit5: gh, fsr: f };
    }
    return { size, ...best };
  })]))),
};

// Latency at 1,500 skills, in-process, after the index is built (informational).
const latency = Object.fromEntries((['A2', 'A3', 'A5'] as PerTurnArm[]).map(arm => {
  const lat: number[] = [];
  for (const t of test) { const a = performance.now(); rank(arm, calibration.D[arm].cfg, 1500, 'D', t); lat.push(performance.now() - a); }
  lat.sort((a, b) => a - b);
  return [arm, { p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)], p99: lat[Math.floor(lat.length * 0.99)] }];
}));

const receipt = { stress_test_jsonl_sha256: stressSha, tokenizer: TOKENIZER, k: K, matched_budget_tokens: B, test_jsonl_sha256: testSha, dev_jsonl_sha256: fileSha(join(DIR, 'data/dev.jsonl')), catalog_jsonl_sha256: fileSha(join(DIR, 'data/catalog.jsonl')), fields: FIELDS };
writeFileSync(join(DIR, 'results/calibration.json'), JSON.stringify({ receipt, calibration }, null, 1) + '\n');
writeFileSync(join(DIR, 'results/arms-test.json'), JSON.stringify({ receipt, table }, null, 1) + '\n');
writeFileSync(join(DIR, 'results/secondary.json'), JSON.stringify({ receipt, ...secondary }, null, 1) + '\n');
writeFileSync(join(DIR, 'results/verdict.json'), JSON.stringify({ receipt, verdict, secondary_verdict: secondary.verdict, sensitivity_pass2: sensitivity, diagnostics, latency_ms_D_1500: latency }, null, 1) + '\n');
writeFileSync(join(DIR, 'results/per-turn-test.jsonl'), Object.entries(rawPass1).filter(([k]) => k.startsWith('D|750|')).flatMap(([k, rs]) => rs.map(r => JSON.stringify({ cell: k, ...r, top: Number(r.top.toFixed(4)) }))).join('\n') + '\n');
const sv = secondary.verdict.D;
console.log(JSON.stringify({ secondaryD: { chosen: sv.chosen, tau: sv.tau, pass: sv.bars['test+stress'].pass, win: sv.bars['test+stress'].win.map(w => [w.size, w.gated_hit5.toFixed(3), w.best_config_matched, w.best_config_hit.toFixed(3), w.diff.toFixed(3)]), fsr: sv.bars['test+stress'].fsr.map(f => f.fsr.toFixed(3)) } }, null, 1));
console.log(JSON.stringify({ D: { chosen: verdict.D.chosen, pass: verdict.D.pass, win: verdict.D.chosen_bars.win.map(w => [w.size, w.gated_hit5.toFixed(3), w.best_config_matched, w.best_config_hit.toFixed(3), w.diff.toFixed(3)]), fsr: verdict.D.chosen_bars.fsr.map(f => f.fsr.toFixed(3)) }, T: { chosen: verdict.T.chosen, pass: verdict.T.pass } }, null, 1));

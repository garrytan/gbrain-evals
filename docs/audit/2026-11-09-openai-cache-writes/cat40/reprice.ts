/**
 * Audit of 2026-11-09 (GST-1887 / GBEV-59), Cat 40: published dollar figures for gpt-6.1-sol, gpt-6-sol, gpt-6-luna
 * and gpt-6-astra, repriced for OpenAI cache writes and the long-context tier. Keyless, no network, no model call: it
 * reads only committed files (Cat 40 rows, receipts, ledger-runs.json, the generated pages, the reports, and git history
 * for one ancestry check) and writes results.json beside this file.
 *
 *   bun docs/audit/2026-11-09-openai-cache-writes/cat40/reprice.ts
 *
 * Cat 40 rows before gbrain-evals #397 record OpenAI usage with cache_write 0, and Cat 40's priceUsage has no
 * long-context tier. A request whose whole prompt is 1,027 tokens or more writes its uncached prompt less 3 tokens to
 * the cache, and a shorter one writes none: cache_write_rule in ../beam-and-program-primary/results.json, measured on
 * gpt-6.1-sol and gpt-6-luna and assumed for gpt-6-sol and gpt-6-astra. Each session is repriced twice:
 *   lower  cache writes only. The first request of a multi-request fs, fs-acl, pg, memory or oracle session may be
 *          under 1,027 tokens, so up to 1,026 of its tokens stay at the input rate, and every other request keeps 3
 *          there. No request is in the long tier except a single-request session whose prompt passed 272,000 tokens.
 *   upper  every request writes its uncached prompt less 3 tokens, and every request of a session that could hold a
 *          prompt over 272,000 input tokens is priced at the long tier's rates.
 * A report figure over cells whose budget run was settled by a ledger that prices both (harness commit containing
 * 8a8e502a) caps the tier part of its upper bound, per run, at that run's ledger surplus over its cache-write-corrected
 * rows. README.md describes the rules and every output field.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { CHAT_PRICE_OVERRIDES } from '../../../../eval/runner/budget-ledger.ts';
import { analyze, hardAnalysis, hardMarkdown, markdown, type CellRecord } from '../../../../eval/runner/cat40/analyze.ts';

const REPO = resolve(import.meta.dir, '../../../..');
const BENCH = join(REPO, 'docs/benchmarks');
const OUT = join(import.meta.dir, 'results.json');
const NOTICE = '> Correction, 2026-11-09: this page';

// developers.openai.com/api/docs/pricing, read 2026-11-09: standard rates per million tokens, and the rates for a
// request with more than 272,000 input tokens, which apply to the whole request.
const LONG_ABOVE = 272_000;
type Rates = { input: number; cached: number; write: number; output: number };
const PRICES: Record<string, { short: Rates; long: Rates }> = {
  'gpt-6.1-sol': { short: { input: 2, cached: 0.1, write: 2.5, output: 10 }, long: { input: 4, cached: 0.2, write: 5, output: 15 } },
  'gpt-6-sol': { short: { input: 2, cached: 0.2, write: 2.5, output: 10 }, long: { input: 4, cached: 0.4, write: 5, output: 15 } },
  'gpt-6-luna': { short: { input: 0.1, cached: 0.01, write: 0.125, output: 0.5 }, long: { input: 0.2, cached: 0.02, write: 0.25, output: 0.75 } },
  'gpt-6-astra': { short: { input: 10, cached: 1, write: 12.5, output: 50 }, long: { input: 20, cached: 2, write: 25, output: 75 } },
};
const TIER = { input: 2, cached: 2, write: 2, output: 1.5 };
const LEDGER_FIX = '8a8e502a';
const DIRS = ['2026-10-02-model-ladder', '2026-10-04-p8-dev', '2026-10-05-registration-surface', '2026-10-07-model-ladder-hard',
  '2026-10-07-wave11-agent-smoke', '2026-10-07-wave12-agent-smoke', '2026-10-10-model-ladder-hard-confirmation', '2026-10-12-d2d4-smoke',
  '2026-10-13-cat40-dev-round-1', '2026-10-13-cat40-dev-round-2', '2026-10-13-cat40-dev-round-3', '2026-10-14-cat40-next-confirm-public',
  '2026-10-14-d5-brief-smoke'];
const SIMPLE_ARMS = new Set(['fs', 'fs-acl', 'pg', 'memory', 'oracle']);
const WRITE_MIN_PROMPT = 1027;
const WRITE_LESS = 3;

// The analyzer prices its cost-split columns from the ledger's table, which has no gpt-6-sol cache-write rate at this
// commit. Register it in memory, so a repriced row's split matches its total; original rows have no cache writes.
for (const [m, p] of Object.entries(PRICES)) {
  const k = `openai:${m}`; const e = CHAT_PRICE_OVERRIDES[k];
  if (!e || e.input !== p.short.input || e.output !== p.short.output || (e.cache_read ?? e.input) !== p.short.cached) throw new Error(`the ledger's price for ${m} differs from this audit's table`);
  for (const f of ['input', 'cached', 'write', 'output'] as const) if (Math.abs(p.long[f] - p.short[f] * TIER[f]) > 1e-9) throw new Error(`tier ratio for ${m} ${f}`);
  CHAT_PRICE_OVERRIDES[k] = { ...e, cache_write: p.short.write };
}

type Row = Record<string, any>;
type Usage = { input: number; cache_read: number; cache_write: number; output: number; requests: number };
const price = (u: Usage, p: Rates) => (u.input * p.input + u.cache_read * p.cached + u.cache_write * p.write + u.output * p.output) / 1e6;
const clone = <T>(x: T): T => structuredClone(x);
const sessionRuns = (r: Row): Row[] => Array.isArray(r.sessions) ? r.sessions.map((s: Row) => s.run ?? {}) : [r.run, r.session1].filter(Boolean);
const success = (r: Row) => Boolean(r.score?.success);
const judgeUsd = (r: Row) => (r.judge_usd ?? 0) || (r.cost?.judge_usd ?? 0);

/** Cache-written tokens: a request whose whole prompt is 1,027 tokens or more writes its uncached prompt less 3. */
function written(arm: string, u: Usage, bound: 'lower' | 'upper'): number {
  if (u.input <= 0 || u.cache_write > 0) return 0;
  const n = Math.max(1, u.requests);
  if (n === 1) return u.input + u.cache_read >= WRITE_MIN_PROMPT ? Math.max(0, u.input - WRITE_LESS) : 0;
  if (!SIMPLE_ARMS.has(arm) || bound === 'upper') return Math.max(0, u.input - WRITE_LESS * n);
  return Math.max(0, u.input - (WRITE_MIN_PROMPT - 1) - WRITE_LESS * (n - 1));
}

/**
 * Whether a session can hold a request over 272,000 input tokens. A session's prompts only grow, and a request reads
 * from the cache at most the previous request's prompt and output, so its largest prompt is at most its uncached input
 * plus its output plus the first request's cache hit, which is at most the smaller of its cache reads and its mean prompt.
 */
function tierCould(u: Usage): boolean {
  const total = u.input + u.cache_read + u.cache_write; const n = Math.max(1, u.requests);
  return n === 1 ? total > LONG_ABOVE : u.input + u.output + Math.min(u.cache_read, total / n) > LONG_ABOVE;
}
const tierCertain = (u: Usage) => Math.max(1, u.requests) === 1 && u.input + u.cache_read + u.cache_write > LONG_ABOVE;
const tierMust = (u: Usage) => (u.input + u.cache_read + u.cache_write) / Math.max(1, u.requests) > LONG_ABOVE;

interface Cell { row: Row; lower: Row; upper: Row; cwLo: number; cwUp: number; tierLo: number; tierUp: number; run: string | null; could: number; must: number; sessions: number }

function reprice(r: Row): Cell {
  const out: Cell = { row: r, lower: r, upper: r, cwLo: 0, cwUp: 0, tierLo: 0, tierUp: 0, run: r.budget_run_id ?? null, could: 0, must: 0, sessions: 0 };
  const p = PRICES[r.model]; if (!p) return out;
  for (const v of ['lower', 'upper'] as const) {
    const row = clone(r); let delta = 0;
    sessionRuns(row).forEach((run, i) => {
      const u0 = run.usage as Usage | undefined; if (!u0) return;
      const u: Usage = { input: u0.input ?? 0, cache_read: u0.cache_read ?? 0, cache_write: u0.cache_write ?? 0, output: u0.output ?? 0, requests: u0.requests ?? 1 };
      const w = written(r.arm, u, v);
      const c: Usage = { ...u, input: u.input - w, cache_write: u.cache_write + w };
      const cw = price(c, p.short) - price(u, p.short);
      const inTier = v === 'upper' ? tierCould(u) : tierCertain(u);
      const tier = inTier ? price(c, p.long) - price(c, p.short) : 0;
      if (v === 'upper') { out.sessions++; out.could += tierCould(u) ? 1 : 0; out.must += tierMust(u) ? 1 : 0; out.cwUp += cw; out.tierUp += tier; }
      else { out.cwLo += cw; out.tierLo += tier; }
      // A tier session's tokens are stored price-weighted, so the analyzer's flat price table returns tier dollars.
      run.usage = inTier ? { ...c, input: c.input * TIER.input, cache_read: c.cache_read * TIER.cached, cache_write: c.cache_write * TIER.write, output: c.output * TIER.output } : c;
      run.usd = (run.usd ?? 0) + cw + tier;
      if (Array.isArray(row.sessions)) row.sessions[i].usd = (row.sessions[i].usd ?? 0) + cw + tier;
      delta += cw + tier;
    });
    if (Array.isArray(row.sessions) && row.sessions.length) row.run = clone(row.sessions[row.sessions.length - 1].run);
    row.total_usd = (row.total_usd ?? 0) + delta;
    if (row.cost && typeof row.cost.agent_usd === 'number') row.cost.agent_usd += delta;
    out[v] = row;
  }
  return out;
}

// ---- rows: every committed row file in the Cat 40 directories, original and repriced
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const all = DIRS.flatMap(d => walk(join(BENCH, d))).sort();
const files = new Map<string, Cell[]>();
for (const f of all.filter(f => f.endsWith('.jsonl'))) {
  const rows: Row[] = [];
  for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* not a row file */ } }
  if (rows.length && rows.every(r => typeof r.model === 'string' && typeof r.total_usd === 'number')) files.set(relative(BENCH, f), rows.map(reprice));
}
const cells = (rel: string) => { const c = files.get(rel); if (!c) throw new Error(`no rows at ${rel}`); return c; };
const affected = [...files].filter(([, cs]) => cs.some(c => PRICES[c.row.model]));
// Row files that repeat cells held elsewhere: a round's canonical results.jsonl beside its attempts.jsonl, the pilot's
// first run before its F rerun, and the rescored simple arms, which are copies of held-out run 1.
const isCopy = (rel: string) => {
  const b = rel.split('/').pop()!;
  return b === 'results-before-f-rerun.jsonl' || rel.includes('/simple-arms-rescored/') || (b === 'results.jsonl' && existsSync(join(BENCH, dirname(rel), 'attempts.jsonl')));
};
const tierSessions = affected.filter(([file]) => !isCopy(file)).flatMap(([file, cs]) => {
  const m = new Map<string, { sessions: number; could: number; must: number }>();
  for (const c of cs) { if (!c.could) continue; const k = `${c.row.model}\t${c.row.arm}`; const a = m.get(k) ?? { sessions: 0, could: 0, must: 0 }; m.set(k, a); }
  for (const c of cs) { const k = `${c.row.model}\t${c.row.arm}`; const a = m.get(k); if (a) { a.sessions += c.sessions; a.could += c.could; a.must += c.must; } }
  return [...m].map(([k, a]) => ({ file, model: k.split('\t')[0], arm: k.split('\t')[1], sessions: a.sessions, could_reach_tier: a.could, must_reach_tier: a.must }));
});

// ---- ledgers. A run settled at or after 8a8e502a priced cache writes and the tier, so its surplus over the rows bounds
// the tier premium of its cells.
const ledger = new Map<string, { usd: number; commit: string | null }>();
for (const f of all) {
  const b = f.split('/').pop()!;
  if (/^receipt.*\.json$/.test(b)) {
    let e: Row; try { e = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    const id = e.budget_run_id ?? /budget ledger (\S+?):/.exec(e.cost?.basis ?? '')?.[1];
    if (id && typeof e.cost?.usd === 'number') ledger.set(id, { usd: e.cost.usd, commit: e.evals_commit ?? null });
  } else if (b === 'ledger-runs.json') {
    for (const x of JSON.parse(readFileSync(f, 'utf8')) as Row[]) if (!ledger.has(x.run_id)) ledger.set(x.run_id, { usd: x.committed_usd, commit: null });
  }
}
const commitsNotFound = new Set<string>();
const fixed = new Map<string, boolean>();
const hasFix = (commit: string | null) => {
  if (!commit) return false;
  if (!fixed.has(commit)) {
    const known = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${commit}^{commit}`]).status === 0;
    if (!known) commitsNotFound.add(commit);
    fixed.set(commit, known && spawnSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', LEDGER_FIX, commit]).status === 0);
  }
  return fixed.get(commit)!;
};
const tierCap = new Map<string, number>();
{
  const acc = new Map<string, { rows: number; cwLo: number; tierLo: number; affected: boolean }>();
  for (const [rel, cs] of files) {
    if (isCopy(rel)) continue;
    for (const c of cs) {
      if (!c.run) continue;
      const a = acc.get(c.run) ?? { rows: 0, cwLo: 0, tierLo: 0, affected: false };
      a.rows += c.row.total_usd + judgeUsd(c.row); a.cwLo += c.cwLo; a.tierLo += c.tierLo; a.affected ||= c.row.model in PRICES; acc.set(c.run, a);
    }
  }
  for (const [id, a] of acc) { const l = ledger.get(id); if (a.affected && l && hasFix(l.commit)) tierCap.set(id, Math.max(0, l.usd - a.rows - a.cwLo - a.tierLo)); }
}

// ---- statistics over a set of cells
type Pick = { files: string[]; where?: (r: Row) => boolean };
type Est = { original: number; lower: number; upper: number; tier: number };
const pick = (s: Pick): Cell[] => s.files.flatMap(f => cells(f)).filter(c => !s.where || s.where(c.row));
function sums(cs: Cell[], judge: boolean) {
  const original = cs.reduce((s, c) => s + c.row.total_usd + (judge ? judgeUsd(c.row) : 0), 0);
  const byRun = new Map<string, number>(); let tier = 0;
  for (const c of cs) { if (c.run && tierCap.has(c.run)) byRun.set(c.run, (byRun.get(c.run) ?? 0) + c.tierUp); else tier += c.tierUp; }
  for (const [id, t] of byRun) tier += Math.min(t, tierCap.get(id)!);
  return { original, lower: original + cs.reduce((s, c) => s + c.cwLo + c.tierLo, 0), upper: original + cs.reduce((s, c) => s + c.cwUp, 0) + tier, tier, n: cs.length, wins: cs.filter(c => success(c.row)).length };
}
function stat(s: Pick, kind: 'per_task' | 'per_success' | 'sum', judge = false): Est {
  const t = sums(pick(s), judge); const d = kind === 'per_task' ? t.n : kind === 'per_success' ? t.wins : 1;
  return { original: t.original / d, lower: t.lower / d, upper: t.upper / d, tier: t.tier / d };
}
const pct = (o: number, x: number) => 100 * (x / o - 1);
const fmtPct = (lo: number, hi: number) => {
  const f = (x: number) => x < 0.5 ? 'under 1%' : `${Math.round(x)}%`;
  if (f(lo) === f(hi)) return f(lo) === 'under 1%' ? 'under 1% low' : `about ${f(lo)} low`;
  return `${f(lo)} to ${f(hi)} low`;
};
const range = (lo: string, hi: string) => lo === hi ? lo : `${lo} to ${hi}`;

// ---- report figures. line is where the published figure sits in the doc now.
const docLines = new Map<string, string[]>();
function locate(doc: string, published: string, hint: number, corrected = false): number | null {
  if (!docLines.has(doc)) docLines.set(doc, readFileSync(join(REPO, doc), 'utf8').split('\n'));
  const ls = docLines.get(doc)!; const needle = published.replace(/^\$/, '');
  const hits = ls.map((l, i) => [l, i + 1] as const).filter(([l]) => new RegExp(`(^|[^\\d.])\\$?${needle.replace(/[.$]/g, m => '\\' + m)}(?![\\d])`).test(l));
  if (!hits.length) return null;
  const marked = hits.filter(([l]) => /corrected 2026-11-09|not recomputed 2026-11-09/.test(l));
  const was = !corrected ? [] : marked.filter(([l]) => l.includes(`was ${needle})`) || l.includes(`was $${needle})`));
  return (was.length ? was : marked.length ? marked : hits).reduce((b, h) => Math.abs(h[1] - hint) < Math.abs(b[1] - hint) ? h : b)[1];
}
interface Figure { id: string; doc: string; line: number | null; what: string; published: string; reproduces?: boolean; original?: number; lower?: number; upper?: number; now: string; moves: boolean; long_tier?: boolean }
const figures: Figure[] = [];
const D = (f: string) => `docs/benchmarks/${f}`;
function value(id: string, doc: string, hint: number, what: string, published: string, dp: number, v: Est, prefix = '') {
  const lo = v.lower.toFixed(dp), hi = v.upper.toFixed(dp);
  figures.push({ id, doc: D(doc), line: locate(D(doc), published, hint, true), what, published: prefix + published, reproduces: v.original.toFixed(dp) === published.replace(/,/g, ''),
    original: +v.original.toFixed(dp + 2), lower: +v.lower.toFixed(dp + 2), upper: +v.upper.toFixed(dp + 2), now: prefix + range(lo, hi).replace(' to ', ' to ' + prefix), moves: lo !== published || hi !== published, long_tier: v.tier > 0 });
}
function spend(id: string, doc: string, hint: number, what: string, published: string, v: Est) {
  figures.push({ id, doc: D(doc), line: locate(D(doc), published, hint), what, published, reproduces: v.original.toFixed(2) === published.replace(/[$,]/g, ''), now: fmtPct(pct(v.original, v.lower), pct(v.original, v.upper)), moves: true, long_tier: v.tier > 0 });
}
function ledgerFig(id: string, doc: string, hint: number, what: string, published: string, s: Pick | Cell[]) {
  const t = sums(Array.isArray(s) ? s : pick(s), true); const l = +published.replace(/[$,]/g, '');
  figures.push({ id, doc: D(doc), line: locate(D(doc), published, hint), what, published, now: fmtPct(100 * (t.lower - t.original) / l, 100 * (t.upper - t.original) / l), moves: true, long_tier: t.tier > 0 });
}
function ratio(id: string, doc: string, needle: string, what: string, published: string, a: Est, b: Est, dp = 2, fall = false) {
  const f = (x: number) => fall ? 100 * (1 - x) : x;
  const [lo, hi] = [a.lower / b.upper, a.upper / b.lower].map(f).sort((x, y) => x - y);
  if (!docLines.has(D(doc))) docLines.set(D(doc), readFileSync(join(REPO, D(doc)), 'utf8').split('\n'));
  const at = docLines.get(D(doc))!.findIndex(l => l.includes(needle));
  figures.push({ id, doc: D(doc), line: at < 0 ? null : at + 1, what, published, original: +f(a.original / b.original).toFixed(dp + 1), lower: +lo.toFixed(dp + 1), upper: +hi.toFixed(dp + 1), now: range(lo.toFixed(dp), hi.toFixed(dp)), moves: false, long_tier: a.tier + b.tier > 0 });
}
function estimate(id: string, doc: string, hint: number, what: string, published: string, basis: Est) {
  figures.push({ id, doc: D(doc), line: locate(D(doc), published, hint), what, published, now: fmtPct(pct(basis.original, basis.lower), pct(basis.original, basis.upper)), moves: true, long_tier: basis.tier > 0 });
}
const arm = (a: string) => (r: Row) => r.arm === a;
const armRep0 = (a: string) => (r: Row) => r.arm === a && r.repeat === 0;
const model = (m: string) => (r: Row) => r.model === m;
const and = (...fs: Array<(r: Row) => boolean>) => (r: Row) => fs.every(f => f(r));
const among = (ms: string[]) => (r: Row) => ms.includes(r.model);

const ML = '2026-10-02-model-ladder'; const ER = `${ML}/entity-recall`;
const FIVE = ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-fable-5-1', 'claude-opus-5-5', 'gpt-6-astra'];
const erWave: Pick = { files: [`${ER}/holdout/wave/results.jsonl`], where: and(arm('gbrain-entity-holdout'), among(FIVE)) };
const erFs: Pick = { files: [`${ER}/simple-arms-rescored/results.jsonl`, `${ER}/holdout/simple-arms-new-models/results.jsonl`], where: and(arm('fs'), among(FIVE)) };
const erPrev: Pick = { files: [`${ML}/followups/holdout/results.jsonl`, `${ER}/holdout/a714410a5-new-models/results.jsonl`], where: and(arm('gbrain-c1234-holdout'), among(FIVE)) };
value('ladder-gbrain-heldout-wave', `${ML}.md`, 29, 'gbrain $/task, held-out entity-recall wave, five models', '0.238', 3, stat(erWave, 'per_task'), '$');
value('ladder-fs-heldout', `${ML}.md`, 29, 'fs $/task, held-out, five models', '0.112', 3, stat(erFs, 'per_task'), '$');
ratio('ladder-gbrain-vs-fs-heldout', `${ML}.md`, 'costs about twice as much per task as files', 'gbrain against fs per task ("about twice")', 'about twice', stat(erWave, 'per_task'), stat(erFs, 'per_task'));
ratio('ladder-default-on-fall', `${ML}.md`, 'cost per task falls 26%', 'default-on cost per task fell against the previous gbrain, percent (the ship rule allows a rise of up to 25%)', '26', stat(erWave, 'per_task'), stat(erPrev, 'per_task'), 1, true);
value('ladder-entity-previous', `${ML}.md`, 195, 'entity-recall $/task, held-out previous gbrain, five models', '0.323', 3, stat(erPrev, 'per_task'));
for (const [sub, pub, hint] of [['master', '0.341', 192], ['round1', '0.286', 193], ['round2', '0.240', 194]] as const)
  value(`ladder-entity-${sub}`, `${ML}.md`, hint, `entity-recall $/task, development ${sub}, five models`, pub, 3, stat({ files: [`${ER}/dev-frontier/${sub}/results.jsonl`] }, 'per_task'));
const FW = [`${ML}/baseline-uncapped/results.jsonl`, `${ML}/fix-wave-ladder/results.jsonl`];
for (const [a, pub, hint] of [['fs', '0.054', 354], ['pg', '0.038', 355], ['memory', '0.269', 356], ['gbrain', '0.190', 357], ['gbrain-next', '0.192', 358]] as const)
  value(`ladder-cost-speed-${a}`, `${ML}.md`, hint, `cost and speed table $/task, ${a}, 11 models, repeat 0`, pub, 3, stat({ files: FW, where: armRep0(a) }, 'per_task'));
value('ladder-price-gbrain-dev', `${ML}.md`, 230, 'price line: gbrain $/task, development world', '0.19', 2, stat({ files: FW, where: armRep0('gbrain') }, 'per_task'), '$');
value('ladder-price-fs-dev', `${ML}.md`, 230, 'price line: fs $/task, development world', '0.054', 3, stat({ files: FW, where: armRep0('fs') }, 'per_task'), '$');
const HO = [`${ML}/holdout/results.jsonl`];
for (const [a, pub] of [['gbrain-next', '0.130'], ['gbrain-base', '0.098'], ['fs', '0.032'], ['pg', '0.021']] as const)
  value(`ladder-heldout-${a}`, `${ML}.md`, 422, `held-out cost per task, ${a}, six models (the price line repeats fs)`, pub, 3, stat({ files: HO, where: arm(a) }, 'per_task'), '$');
ratio('ladder-price-ratio-dev', `${ML}.md`, '2.5 to 4 times a file run', 'gbrain against fs per task, development world ("2.5 to 4 times")', '2.5 to 4 times', stat({ files: FW, where: armRep0('gbrain') }, 'per_task'), stat({ files: FW, where: armRep0('fs') }, 'per_task'));
ratio('ladder-price-ratio-heldout', `${ML}.md`, '2.5 to 4 times a file run', 'gbrain against fs per task, held-out world ("2.5 to 4 times")', '2.5 to 4 times', stat({ files: HO, where: arm('gbrain-next') }, 'per_task'), stat({ files: HO, where: arm('fs') }, 'per_task'));
const FC: Pick = { files: [`${ML}/followups/control/results.jsonl`] }; const FH: Pick = { files: [`${ML}/followups/holdout/results.jsonl`] };
value('ladder-cost-wave-sol-control', `${ML}.md`, 461, 'cost wave $/task, GPT-6.1 Sol, control', '0.097', 3, stat({ ...FC, where: model('gpt-6.1-sol') }, 'per_task'));
value('ladder-cost-wave-sol-wave', `${ML}.md`, 461, 'cost wave $/task, GPT-6.1 Sol, wave', '0.065', 3, stat({ ...FH, where: model('gpt-6.1-sol') }, 'per_task'));
value('ladder-cost-wave-all-control', `${ML}.md`, 462, 'cost wave $/task, all models, control', '0.118', 3, stat(FC, 'per_task'));
value('ladder-cost-wave-all-wave', `${ML}.md`, 462, 'cost wave $/task, all models, wave', '0.080', 3, stat(FH, 'per_task'));
ratio('ladder-cost-wave-fall', `${ML}.md`, 'Cost per task fell 32%', 'cost per task fell, percent', '32', stat(FH, 'per_task'), stat(FC, 'per_task'), 0, true);
ratio('ladder-cost-wave-success-fall', `${ML}.md`, 'cost per successful task fell 34%', 'cost per successful task fell, percent', '34', stat(FH, 'per_success'), stat(FC, 'per_success'), 0, true);
value('ladder-cost-wave-success-control', `${ML}.md`, 467, 'cost per successful task, control', '0.161', 3, stat(FC, 'per_success'), '$');
value('ladder-cost-wave-success-wave', `${ML}.md`, 468, 'cost per successful task, wave', '0.106', 3, stat(FH, 'per_success'), '$');
// Every paid cell in this report's folders: the rescored simple arms are copies of held-out cells, and the pilot's
// results.jsonl repeats its first run's cells except the F cells it reran.
const PILOT = `${ML}/pilot-capped-20k`;
const firstPilot = new Set(cells(`${PILOT}/results-before-f-rerun.jsonl`).map(c => `${c.row.key}|${c.row.started_at}`));
const ladderPaid = [...files.keys()].filter(f => f.startsWith(`${ML}/`) && !f.includes('/simple-arms-rescored/') && f !== `${PILOT}/results.jsonl`).flatMap(f => cells(f))
  .concat(cells(`${PILOT}/results.jsonl`).filter(c => !firstPilot.has(`${c.row.key}|${c.row.started_at}`)));
ledgerFig('ladder-program', `${ML}.md`, 528, "program spend across four machines' ledgers, from every paid cell in this report's folders", '$1,763', ladderPaid);
ledgerFig('simple-arms-rerun', `${ER}/simple-arms-rescored/README.md`, 13, 'cost to rerun the simple arms (held-out run 1)', '$128', { files: HO, where: (r: Row) => ['oracle', 'fs', 'fs-acl', 'memory', 'pg'].includes(r.arm) });
const BU: Pick = { files: [`${ML}/baseline-uncapped/results.jsonl`] };
spend('baseline-uncapped-cells', `${ML}/baseline-uncapped/README.md`, 60, 'recorded cells, agent and judge', '$777.00', stat(BU, 'sum', true));
ledgerFig('baseline-uncapped-ledger', `${ML}/baseline-uncapped/README.md`, 54, 'ledger total, from the recorded cells only (cells lost in flight have no rows)', '$798.34', BU);
for (const [id, hint, pub, arms] of [['holdout-run-1', 80, '$127.77', ['oracle', 'fs', 'fs-acl', 'memory', 'pg']], ['holdout-run-2', 81, '$60.79', ['gbrain-base']], ['holdout-run-3', 82, '$67.45', ['gbrain-next-51a30c1']], ['holdout-run-4', 83, '$79.94', ['gbrain-next']]] as const)
  ledgerFig(id, `${ML}/holdout/README.md`, hint, `run spend, arms ${arms.join(', ')}`, pub, { files: HO, where: (r: Row) => (arms as readonly string[]).includes(r.arm) });
ledgerFig('holdout-ledger', `${ML}/holdout/README.md`, 84, 'ledger total of the four runs', '$336.08', { files: HO });
ledgerFig('followups-ledger', `${ML}/followups/README.md`, 5, 'ledger total, control and holdout runs', '$179.66', { files: [`${ML}/followups/control/results.jsonl`, `${ML}/followups/holdout/results.jsonl`] });
const ST = `${ML}/scale-tier/results.jsonl`;
for (const [a, pub, dp] of [['oracle', '0.010', 3], ['fs-acl', '0.021', 3], ['pg', '0.031', 3], ['fs', '0.060', 3], ['gbrain', '0.157', 3], ['memory', '1.30', 2]] as const)
  value(`scale-tier-per-cell-${a}`, `${ML}/scale-tier/README.md`, 75, `spend per cell with judge, ${a}, four models`, pub, dp, stat({ files: [ST], where: arm(a) }, 'per_task', true), '$');
spend('scale-tier-cells', `${ML}/scale-tier/README.md`, 126, 'cell records with judge (the rows give $207.90)', '$207.92', stat({ files: [ST] }, 'sum', true));
ledgerFig('scale-tier-ledger', `${ML}/scale-tier/README.md`, 126, 'ledger total', '$219.25', { files: [ST] });
const P8 = [...files.keys()].filter(f => f.startsWith(`${ML}/p8-hidden-tool-dev-smoke/`) && f.endsWith('/results.jsonl'));
spend('p8-smoke-cells', `${ML}/p8-hidden-tool-dev-smoke/README.md`, 54, 'cells, the 2-task pilot included (gpt-6-luna)', '$0.48', stat({ files: P8 }, 'sum'));
ledgerFig('p8-smoke-ledger', `${ML}/p8-hidden-tool-dev-smoke/README.md`, 53, 'ledger total, two slot builds included', '$0.90', { files: P8 });
const RS = '2026-10-05-registration-surface';
for (const [s, pub, hint] of [['starter', '14.17', 68], ['full', '15.39', 69], ['verbs', '14.37', 70]] as const)
  value(`registration-${s}`, `${RS}.md`, hint, `cost per surface, ${s}, 40 cells`, pub, 2, stat({ files: [`${RS}/${s}/results.jsonl`] }, 'sum'), '$');
spend('registration-cells', `${RS}.md`, 123, 'agent-cell spend, three surfaces (each surface ledger equals its rows)', '$43.93', stat({ files: ['starter', 'full', 'verbs'].map(s => `${RS}/${s}/results.jsonl`) }, 'sum'));
const W11 = '2026-10-07-wave11-agent-smoke'; const W12 = '2026-10-07-wave12-agent-smoke';
const w11m = ['master-gated', 'master-sentinel', 'master-fable-smoke'].map(d => `${W11}/${d}/results.jsonl`);
const w11w = ['wave11-gated', 'wave11-sentinel', 'wave11-fable-smoke'].map(d => `${W11}/${d}/results.jsonl`);
const w11p = [`${W11}/pilot/results.jsonl`];
spend('wave11-cells', `${W11}.md`, 98, 'cell total, pilot included', '$48.44', stat({ files: [...w11m, ...w11w, ...w11p] }, 'sum'));
spend('wave11-master', `${W11}.md`, 98, 'master cells', '$23.82', stat({ files: w11m }, 'sum'));
spend('wave11-wave', `${W11}.md`, 98, 'wave 11 cells', '$24.52', stat({ files: w11w }, 'sum'));
spend('wave11-pilot', `${W11}.md`, 98, 'pilot cells', '$0.10', stat({ files: w11p }, 'sum'));
ledgerFig('wave11-ledger', `${W11}.md`, 98, 'ledger total', '$49.21', { files: [...w11m, ...w11w, ...w11p] });
const w12b = ['baseline-gated', 'baseline-opus-f-extra'].map(d => `${W12}/${d}/results.jsonl`);
const w12w = ['wave12-gated', 'wave12-opus-f-extra'].map(d => `${W12}/${d}/results.jsonl`);
spend('wave12-cells', `${W12}.md`, 104, 'preregistered cells', '$33.37', stat({ files: [...w12b, ...w12w] }, 'sum'));
spend('wave12-baseline', `${W12}.md`, 104, 'baseline cells', '$17.29', stat({ files: w12b }, 'sum'));
spend('wave12-wave', `${W12}.md`, 104, 'wave 12 cells', '$16.08', stat({ files: w12w }, 'sum'));
ledgerFig('wave12-ledger', `${W12}.md`, 104, 'ledger total', '$38.88', { files: [...w12b, ...w12w] });
const H7 = ['2026-10-07-model-ladder-hard/cells-50k/results.jsonl', '2026-10-07-model-ladder-hard/pg-50k/results.jsonl'];
const h7 = Object.fromEntries((['fs', 'pg', 'gbrain-hard'] as const).map(a => [a, stat({ files: H7, where: and(arm(a), (r: Row) => r.model !== 'claude-fable-5-1') }, 'per_task')]));
for (const [a, pub, hint] of [['fs', '0.98', 95], ['pg', '0.29', 96], ['gbrain-hard', '0.69', 97]] as const) value(`hard-${a}`, '2026-10-07-model-ladder-hard.md', hint, `$ per task, ${a}, four models`, pub, 2, h7[a]);
ratio('hard-gbrain-vs-fs', '2026-10-07-model-ladder-hard.md', 'gbrain was cheaper per task than fs', 'gbrain against fs per task (the report says gbrain is cheaper)', 'below 1', h7['gbrain-hard'], h7.fs);
ledgerFig('hard-ledger', '2026-10-07-model-ladder-hard.md', 104, 'program ledger, from the committed held-out rows only (calibration rows are not committed)', '$2,000.29', { files: H7 });
const HC = '2026-10-10-model-ladder-hard-confirmation';
const hcM = Object.fromEntries((['gbrain-hard', 'fs'] as const).map(a => [a, stat({ files: [`${HC}/main-cells/results.jsonl`], where: and(model('gpt-6.1-sol'), arm(a)) }, 'per_success')]));
value('hardconf-M-sol-gbrain', `${HC}.md`, 56, 'world M, GPT-6.1 Sol, gbrain $/success', '0.32', 2, hcM['gbrain-hard']);
value('hardconf-M-sol-fs', `${HC}.md`, 56, 'world M, GPT-6.1 Sol, fs $/success', '0.24', 2, hcM.fs);
estimate('hardconf-S-sol-gbrain', `${HC}.md`, 60, 'world S, GPT-6.1 Sol, gbrain $/success: rows not committed, estimated as the rise on world M', '0.46', hcM['gbrain-hard']);
estimate('hardconf-S-sol-fs', `${HC}.md`, 60, 'world S, GPT-6.1 Sol, fs $/success: rows not committed, estimated as the rise on world M', '0.32', hcM.fs);
ratio('hardconf-M-sol-gbrain-vs-fs', `${HC}.md`, 'and dearer for Sol', 'GPT-6.1 Sol gbrain against fs per success on M (the report said slightly dearer; corrected to dearer)', 'above 1', hcM['gbrain-hard'], hcM.fs);
const DD = '2026-10-12-d2d4-smoke'; const D5 = '2026-10-14-d5-brief-smoke';
value('d2d4-sol-master', `${DD}/VERDICT.md`, 9, 'GPT-6.1 Sol cost, 10 cells, master', '0.36', 2, stat({ files: [`${DD}/master/results.jsonl`], where: model('gpt-6.1-sol') }, 'sum'), '$');
value('d2d4-sol-d2d4', `${DD}/VERDICT.md`, 12, 'GPT-6.1 Sol cost, 10 cells, d2d4', '0.14', 2, stat({ files: [`${DD}/d2d4/results.jsonl`], where: model('gpt-6.1-sol') }, 'sum'), '$');
const d5 = [...files.keys()].filter(f => f.startsWith(`${D5}/`) && !f.includes('resmoke') && f.endsWith('/results.jsonl'));
value('d5-sol-master', `${D5}/VERDICT.md`, 35, 'GPT-6.1 Sol cost, 10 cells, master', '0.38', 2, stat({ files: d5, where: and(model('gpt-6.1-sol'), arm('master')) }, 'sum'), '$');
value('d5-sol-d5', `${D5}/VERDICT.md`, 36, 'GPT-6.1 Sol cost, 10 cells, d5', '0.37', 2, stat({ files: d5, where: and(model('gpt-6.1-sol'), arm('d5')) }, 'sum'), '$');
const R1 = '2026-10-13-cat40-dev-round-1'; const R2 = '2026-10-13-cat40-dev-round-2'; const R3 = '2026-10-13-cat40-dev-round-3';
for (const [a, pub] of [['control', '155.23'], ['all-on', '126.03'], ['f5', '144.90'], ['f1', '74.84'], ['f1-no-names-row', '71.56'], ['f2', '85.47'], ['f4', '81.07']] as const)
  value(`dev-round-1-${a}`, `${R1}/README.md`, 48, `arm USD, judge excluded, ${a}`, pub, 2, stat({ files: [`${R1}/${a}/attempts.jsonl`] }, 'sum'));
for (const [a, pub] of [['control', '156.23'], ['all-on', '129.17'], ['f5', '148.98']] as const)
  value(`dev-round-2-${a}`, `${R2}/README.md`, 60, `arm USD, judge excluded, ${a}`, pub, 2, stat({ files: [`${R2}/${a}/results.jsonl`] }, 'sum'));
spend('dev-round-3-attempts', `${R3}/README.md`, 128, "attempts' agent and judge cost", '$148.52', stat({ files: [`${R3}/all-on-no-f5/attempts.jsonl`] }, 'sum', true));
const NC = '2026-10-14-cat40-next-confirm-public';
const ncs = (a: string) => stat({ files: [`${NC}/p1/${a}/results.jsonl`, `${NC}/p2/${a}/results.jsonl`] }, 'per_success');
for (const [a, pub, hint, pre] of [['wave', '0.53', 131, ''], ['baseline', '0.63', 131, ''], ['fs', '1.35', 134, '$']] as const)
  value(`next-confirm-public-${a}`, '2026-10-15-cat40-next-confirm/README.md', hint, `$ per successful cell, public worlds, ${a}`, pub, 2, ncs(a), pre);
for (const [a, pub, hint] of [['wave', '0.98', 131], ['baseline', '0.94', 131], ['fs', '1.77', 134]] as const)
  estimate(`next-confirm-sealed-${a}`, '2026-10-15-cat40-next-confirm/README.md', hint, `$ per successful cell, sealed world, ${a}: rows not committed, estimated as the rise on the public worlds`, pub, ncs(a));
ratio('next-confirm-wave-vs-fs', '2026-10-15-cat40-next-confirm/README.md', 'still cheaper per success than fs', 'wave against fs per success, public (the report says gbrain is cheaper)', 'below 1', ncs('wave'), ncs('fs'));

// ---- generated pages, regenerated from original and repriced rows with the repo's own analyzers
type Spec = { page: string; kind: 'v1' | 'hard' | 'holdout'; inputs: string[]; subject?: string; expectGrid?: string; repeat?: number[]; args?: string[]; exclude?: string[] };
const PAGES: Spec[] = [
  { page: `${ML}/baseline-uncapped/analysis.md`, kind: 'v1', inputs: BU.files },
  { page: `${ML}/baseline-uncapped/analysis-repeats-0-1.md`, kind: 'v1', inputs: BU.files, repeat: [0, 1] },
  { page: `${ML}/fix-wave-ladder/analysis-next.md`, kind: 'v1', inputs: FW, repeat: [0], subject: 'gbrain-next' },
  { page: `${ML}/followups/control/analysis.md`, kind: 'v1', inputs: FC.files, subject: 'gbrain-566a242a-control' },
  { page: `${ML}/followups/holdout/analysis.md`, kind: 'v1', inputs: FH.files, subject: 'gbrain-c1234-holdout' },
  { page: `${ML}/holdout/analysis-base.md`, kind: 'v1', inputs: HO, subject: 'gbrain-base' },
  { page: `${ML}/holdout/analysis-next.md`, kind: 'v1', inputs: HO, subject: 'gbrain-next' },
  { page: `${ML}/pilot-capped-20k/analysis.md`, kind: 'v1', inputs: [`${ML}/pilot-capped-20k/results.jsonl`] },
  { page: `${ML}/scale-tier/analysis.md`, kind: 'v1', inputs: [ST] },
  ...['b6622a-surface-full', 'b6622a-surface-starter'].map(s => ({ page: `${ML}/p8-hidden-tool-dev-smoke/${s}/analysis.md`, kind: 'v1' as const, inputs: [`${ML}/p8-hidden-tool-dev-smoke/${s}/results.jsonl`], subject: s })),
  ...['full', 'starter', 'verbs'].map(s => ({ page: `${ML}/p8-hidden-tool-dev-smoke/c6c958-adv-${s}/analysis.md`, kind: 'v1' as const, inputs: [`${ML}/p8-hidden-tool-dev-smoke/c6c958-adv-${s}/results.jsonl`], subject: `c6c958-callfull-adv-${s}` })),
  ...[['master-gated', 'master'], ['master-sentinel', 'master'], ['wave11-gated', 'wave11'], ['wave11-sentinel', 'wave11']].map(([d, s]) => ({ page: `${W11}/${d}/analysis.md`, kind: 'v1' as const, inputs: [`${W11}/${d}/results.jsonl`], subject: s })),
  ...[['baseline-gated', 'baseline'], ['wave12-gated', 'wave12']].map(([d, s]) => ({ page: `${W12}/${d}/analysis.md`, kind: 'v1' as const, inputs: [`${W12}/${d}/results.jsonl`], subject: s })),
  { page: `${HC}/analysis-main.md`, kind: 'hard', inputs: [`${HC}/main-cells/results.jsonl`], expectGrid: 'observed' },
  { page: `${ER}/headline-a714410a5.md`, kind: 'holdout', inputs: [`${ER}/simple-arms-rescored/results.jsonl`, FH.files[0]], args: ['--choose-comparator', 'fs,memory,pg', '--headline', 'gbrain-c1234-holdout,fs'] },
  { page: `${ER}/holdout/headline-wave.md`, kind: 'holdout', inputs: [...erFs.files, erWave.files[0]], args: ['--models', FIVE.join(','), '--headline', 'gbrain-entity-holdout,fs'] },
  { page: `${ER}/holdout/ship-rule-and-default-on.md`, kind: 'holdout', inputs: [...erPrev.files, erWave.files[0]], args: ['--models', FIVE.join(','), '--default-on', 'gbrain-entity-holdout,gbrain-c1234-holdout'] },
  { page: `${ML}/followups/holdout/ship-rule.md`, kind: 'holdout', inputs: [FH.files[0], FC.files[0]], args: ['--ship-rule', 'gbrain-c1234-holdout,gbrain-566a242a-control'] },
  { page: `${ML}/holdout/holdout-stats.md`, kind: 'holdout', inputs: HO, args: [] },
  { page: '2026-10-07-model-ladder-hard/holdout-stats.md', kind: 'holdout', inputs: H7, args: ['--hard-headline', 'gbrain-hard,fs', '--simple', 'fs,pg'], exclude: ['claude-fable-5-1'] },
  { page: '2026-10-07-model-ladder-hard/holdout-stats-with-fable-descriptive.md', kind: 'holdout', inputs: [H7[0]], args: ['--hard-headline', 'gbrain-hard,fs', '--simple', 'fs'] },
  { page: `${HC}/holdout-stats-main.md`, kind: 'holdout', inputs: [`${HC}/main-cells/results.jsonl`], args: ['--hard-headline', 'gbrain-hard,fs', '--simple', 'fs'] },
];
const HOLDOUT_STATS = join(BENCH, ML, 'holdout/holdout_stats.py');
const V = ['original', 'lower', 'upper'] as const; type Variant = typeof V[number];
const rowsOf = (s: Spec, v: Variant, f: string): Row[] => cells(f).map(c => v === 'original' ? c.row : c[v]).filter(r => (!s.repeat || s.repeat.includes(r.repeat)) && !(s.exclude ?? []).includes(r.model));
const tmp = mkdtempSync(join(tmpdir(), 'cw-cat40-'));
function regenerate(s: Spec) {
  const md = {} as Record<Variant, string[]>; const spendOf = {} as Record<Variant, Map<string, number>>;
  for (const v of V) {
    const rows = s.inputs.flatMap(f => rowsOf(s, v, f)); const sp = new Map<string, number>();
    let text: string;
    if (s.kind === 'v1') { const a = analyze(rows as unknown as CellRecord[], { subject: s.subject ?? 'gbrain' }); text = markdown(a) + '\n'; sp.set('Cells:', a.usd); }
    else if (s.kind === 'hard') { const a = hardAnalysis(rows, { expectGrid: s.expectGrid }); text = hardMarkdown(a) + '\n'; sp.set('Canonical cells:', a.usd_all_attempts); }
    else {
      const paths = s.inputs.map((f, i) => {
        const p = join(tmp, v, `${i}.jsonl`); mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, rowsOf(s, v, f).map(r => JSON.stringify(r)).join('\n') + '\n');
        return p;
      });
      const res = spawnSync('python3', [HOLDOUT_STATS, ...paths, ...(s.args ?? [])], { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
      if ((res.status !== 0 && res.status !== 1) || !res.stdout) throw new Error(`holdout_stats.py failed on ${s.page}: ${res.stderr?.slice(-400)}`);
      text = res.stdout;
      const only = s.args?.includes('--models') ? s.args[s.args.indexOf('--models') + 1].split(',') : null;
      const kept = rows.filter(r => !only || only.includes(r.model));
      const usd = (rs: Row[]) => rs.reduce((t, r) => t + r.total_usd + (r.judge_usd ?? 0), 0);
      sp.set('Spend in these records', usd(kept));
      for (const a of new Set(kept.map(r => r.arm))) sp.set(`- ${a}:`, usd(kept.filter(r => r.arm === a)));
    }
    md[v] = text.split('\n'); spendOf[v] = sp;
  }
  return { md, spendOf };
}
const NUM = /-?\$?-?\d[\d,]*\.?\d*%?/g;
const SEP = /^\|[-| :]+\|$/;
const cellsOf = (line: string) => line.trimStart().startsWith('|') ? line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()) : (line.match(NUM) ?? []);
const num = (s: string | undefined) => s === undefined ? NaN : +s.replace(/[$,%]/g, '');const slug = (page: string) => 'cw-' + ([
  ['2026-10-02-model-ladder/', 'ladder-'],
  ['2026-10-07-model-ladder-hard/', 'hard07-'],
  ['2026-10-10-model-ladder-hard-confirmation/', 'hardconf-'],
  ['2026-10-07-wave11-agent-smoke/', 'w11-'],
  ['2026-10-07-wave12-agent-smoke/', 'w12-'],
  ['p8-hidden-tool-dev-smoke/', 'p8-'],
  ['entity-recall/', 'er-'],
] as const).reduce((s, [a, b]) => s.replace(a, b), page).replace('.md', '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Each committed line is matched to a regenerated original line, in order, and compared with the same line regenerated
// from the lower and upper rows. A spend line is reported as a percentage only.
const pages = PAGES.map(s => {
  const { md, spendOf } = regenerate(s);
  const committed = readFileSync(join(BENCH, s.page), 'utf8').split('\n');
  const index = new Map<string, number[]>();
  md.original.forEach((l, i) => index.set(l, [...(index.get(l) ?? []), i]));
  const used = new Set<number>();
  let pos = 0, header: string[] | null = null, reproduced = 0, counted = 0;
  const moved: Row[] = [];
  committed.forEach((t, j) => {
    if (t.startsWith(NOTICE) || (t === '' && committed[j - 1]?.startsWith(NOTICE))) return;
    counted++;
    if (t.startsWith('|') && !SEP.test(t.trim()) && SEP.test((committed[j + 1] ?? '').trim())) header = cellsOf(t);
    const cand = (index.get(t) ?? []).filter(i => !used.has(i));
    if (!cand.length) return;
    const key = (k: number) => (k < pos ? 1e9 : 0) + Math.abs(k - pos);
    const i = cand.reduce((b, k) => key(k) < key(b) ? k : b);
    used.add(i); pos = i; reproduced++;
    const lo = md.lower[i], up = md.upper[i];
    if (lo === t && up === t) return;
    const line = j + 1;
    const sk = t.startsWith('|') ? undefined : [...spendOf.original.keys()].find(k => t.startsWith(k));
    if (sk) {
      const o = spendOf.original.get(sk)!;
      moved.push({ line, row: sk.startsWith('- ') ? sk.slice(2, -1) : t.includes('Spend over every attempt') ? 'Spend over every attempt' : 'Spend in these records', col: 'spend total',
        now: fmtPct(pct(o, spendOf.lower.get(sk)!), pct(o, spendOf.upper.get(sk)!)), ...(t.includes('$' + o.toFixed(2)) ? {} : { reproduces: false }) });
      return;
    }
    const c0 = cellsOf(t), cl = cellsOf(lo), cu = cellsOf(up);
    const label = t.startsWith('|') ? (c0.length > 1 && !Number.isNaN(num(c0[1])) ? c0[0] : c0.slice(0, 2).join(' / ')) : t.split(':')[0].replace(/^- /, '').slice(0, 70);
    for (let k = 0; k < Math.max(c0.length, cu.length); k++) {
      if (c0[k] === cu[k] && c0[k] === cl[k]) continue;
      const [a, b] = [cl[k], cu[k]].sort((x, y) => num(x) - num(y));
      moved.push({ line, row: label, col: t.startsWith('|') && header ? header[k] ?? '' : '', was: c0[k], now: range(a, b) });
    }
  });
  const ms = new Set(s.inputs.flatMap(f => cells(f).filter(c => c.cwUp + c.tierUp > 0 && !(s.exclude ?? []).includes(c.row.model)).map(c => c.row.model)));
  const long = s.inputs.some(f => cells(f).some(c => c.tierUp > 0 && !(s.exclude ?? []).includes(c.row.model) && (!s.repeat || s.repeat.includes(c.row.repeat))));
  return { page: D(s.page), anchor: slug(s.page), models: Object.keys(PRICES).filter(m => ms.has(m)), long_tier: long, lines_regenerated: md.original.length, lines_reproduced: reproduced, committed_lines: counted, moved };
});
rmSync(tmp, { recursive: true, force: true });

// ---- orderings: every pair of models within an arm, and of arms within a model, whose $/task or $/success order flips
// at either bound.
const orderInputs: { label: string; inputs: string[]; repeat?: number[] }[] = [
  ...PAGES.filter(s => s.kind !== 'holdout').map(s => ({ label: D(s.page), inputs: s.inputs, repeat: s.repeat })),
  { label: `docs/benchmarks/${R1}/README.md`, inputs: ['control', 'all-on', 'f5', 'f1', 'f1-no-names-row', 'f2', 'f4'].map(a => `${R1}/${a}/results.jsonl`) },
  { label: 'docs/benchmarks/2026-10-15-cat40-next-confirm/README.md', inputs: ['p1', 'p2'].flatMap(p => ['wave', 'baseline', 'fs', 'oracle'].map(a => `${NC}/${p}/${a}/results.jsonl`)) },
];
const order_changes: Row[] = [];
const seen = new Set<string>();
for (const o of orderInputs) {
  const id = JSON.stringify([o.inputs, o.repeat]);
  if (seen.has(id)) continue;
  seen.add(id);
  const groups = new Map<string, Cell[]>();
  for (const f of o.inputs) for (const c of cells(f)) {
    if (o.repeat && !o.repeat.includes(c.row.repeat)) continue;
    const k = `${c.row.model}\t${c.row.arm}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const S = new Map([...groups].map(([k, cs]) => [k, sums(cs, false)])); const keys = [...S.keys()];
  for (const [mi, metric] of [[0, '$/task'], [1, '$/success']] as const) for (const [group, gi] of [['models within arm', 1], ['arms within model', 0]] as const) {
    for (const within of new Set(keys.map(k => k.split('\t')[gi]))) {
      const members = keys.filter(k => k.split('\t')[gi] === within);
      const val = (v: 'original' | 'lower' | 'upper', k: string) => { const a = S.get(k)!; const d = mi === 0 ? a.n : a.wins; return d ? +(a[v] / d).toFixed(3) : null; };
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) for (const v of ['lower', 'upper'] as const) {
        const [a, b] = [members[i], members[j]]; const o0 = [val('original', a), val('original', b)], o1 = [val(v, a), val(v, b)];
        if (o0.includes(null) || o1.includes(null) || o0[0] === o0[1] || o1[0] === o1[1] || (o0[0]! < o0[1]!) === (o1[0]! < o1[1]!)) continue;
        const name = (k: string) => k.split('\t')[1 - gi]; const [cheap, dear] = o0[0]! < o0[1]! ? [a, b] : [b, a];
        order_changes.push({ inputs: o.label, metric, group, within, bound: v, change: `${name(cheap)} was below ${name(dear)}` });
      }
    }
  }
}

// ---- output
const results = {
  generated_by: 'docs/audit/2026-11-09-openai-cache-writes/cat40/reprice.ts',
  prices_per_million: PRICES,
  long_tier_above_input_tokens: LONG_ABOVE,
  summary: {
    row_files_with_affected_models: affected.length,
    generated_pages: pages.length,
    generated_lines_reproduced: `${pages.reduce((s, p) => s + p.lines_reproduced, 0)} of ${pages.reduce((s, p) => s + p.committed_lines, 0)}`,
    generated_lines_moved: pages.reduce((s, p) => s + new Set(p.moved.map(m => m.line)).size, 0),
    generated_cells_moved: pages.reduce((s, p) => s + p.moved.length, 0),
    report_figures: figures.length,
    report_figures_that_move: figures.filter(f => f.moves).length,
    report_figures_not_reproduced: figures.filter(f => f.reproduces === false).map(f => f.id),
    sessions_that_could_reach_the_long_tier: tierSessions.reduce((s, t) => s + t.could_reach_tier, 0),
    sessions_that_must_reach_the_long_tier: tierSessions.reduce((s, t) => s + t.must_reach_tier, 0),
    budget_runs_with_a_ledger_tier_bound: tierCap.size,
    ledger_commits_not_in_history: [...commitsNotFound].sort(),
    order_changes: order_changes.length,
  },
  report_figures: figures,
  generated_pages: pages,
  long_tier_sessions: tierSessions,
  order_changes,
};
// One line per figure, page, session group and ordering, so the file stays small and diffs read line by line.
const compact = (v: unknown, depth = 0): string => {
  if (depth >= 2 || v === null || typeof v !== 'object') return JSON.stringify(v);
  const pad = ' '.repeat(depth + 1);
  const items = Array.isArray(v) ? v.map(x => pad + compact(x, depth + 1)) : Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${compact(x, depth + 1)}`);
  return Array.isArray(v) ? `[\n${items.join(',\n')}\n${' '.repeat(depth)}]` : `{\n${items.join(',\n')}\n${' '.repeat(depth)}}`;
};
writeFileSync(OUT, compact(results) + '\n');
console.log(JSON.stringify(results.summary, null, 1));

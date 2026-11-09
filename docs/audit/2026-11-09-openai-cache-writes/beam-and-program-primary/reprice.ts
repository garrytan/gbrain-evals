/**
 * GST-1887 audit, 2026-11-09: reprices the gpt-6.1-sol figures in BEAM-1M and the program-primary lane whose code
 * counted OpenAI cache writes as plain input, and checks the figures that don't move. Keyless, no network, no model
 * call; reads only files committed in this repository.
 *
 *   bun docs/audit/2026-11-09-openai-cache-writes/beam-and-program-primary/reprice.ts
 *
 * writes results.json beside this file. See README.md for the price table and the fields.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve(import.meta.dir, '../../../..');
const OUT = join(import.meta.dir, 'results.json');
const B = 'docs/benchmarks';
const SOL = { input: 2, cached: 0.1, cache_write: 2.5, output: 10, long_tier_above: 272_000 };
const PREMIUM = (SOL.cache_write - SOL.input) / 1e6;
const ENVELOPE_DOLLAR_LIMIT = 1.5;

const abs = (p: string) => join(REPO, p);
const json = (p: string) => JSON.parse(readFileSync(abs(p), 'utf8'));
const lines = (text: string) => text.split('\n').filter(Boolean).map(l => JSON.parse(l));
const gz = (p: string) => lines(gunzipSync(readFileSync(abs(p))).toString('utf8'));
const nd = (p: string) => lines(readFileSync(abs(p), 'utf8'));
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const isSol = (m: unknown) => String(m ?? '').replace(/^openai:/, '') === 'gpt-6.1-sol';
const details = (u: any) => u.input_tokens_details ?? u.prompt_tokens_details ?? {};
const promptTokens = (u: any) => u.input_tokens ?? u.prompt_tokens ?? 0;

const maxInput: Record<string, number> = {};
const observe = (source: string, u: any) => { maxInput[source] = Math.max(maxInput[source] ?? 0, promptTokens(u)); };

// The cache-write rule, measured on every committed OpenAI response that reports cache_write_tokens: how many cache
// writes each response reports against its uncached prompt (prompt tokens less cached reads), by model.
const RULE_MODELS = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6-sol'];
const rule: Record<string, { rows: number; writes_uncached_less_3: number; no_write_prompt_under_1027: number; other: { file: string; prompt_tokens: number; cached_tokens: number; cache_write_tokens: number }[] }> = {};
function ruleWalk(o: any, file: string, model?: string) {
  if (Array.isArray(o)) { for (const v of o) ruleWalk(v, file, model); return; }
  if (!o || typeof o !== 'object') return;
  const m = String(o.model ?? o.response_model ?? model ?? '').replace(/^openai:/, '');
  const d = o.input_tokens_details ?? o.prompt_tokens_details;
  if (d && typeof d === 'object' && 'cache_write_tokens' in d && RULE_MODELS.includes(m) && Number.isInteger(promptTokens(o))) {
    const p = promptTokens(o), c = d.cached_tokens ?? 0, cw = d.cache_write_tokens ?? 0;
    const r = rule[m] ??= { rows: 0, writes_uncached_less_3: 0, no_write_prompt_under_1027: 0, other: [] };
    r.rows++;
    if (p - 3 >= 1024 && cw === Math.max(0, p - c - 3)) r.writes_uncached_less_3++;
    else if (p - 3 < 1024 && cw === 0) r.no_write_prompt_under_1027++;
    else r.other.push({ file, prompt_tokens: p, cached_tokens: c, cache_write_tokens: cw });
  }
  for (const v of Object.values(o)) ruleWalk(v, file, m || undefined);
}
const tracked = spawnSync('git', ['ls-files', '-z', '--', 'docs/benchmarks', 'docs/findings', 'eval/data'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\0').filter(f => /\.(json|jsonl|ndjson)(\.gz)?$/.test(f)).sort();
let ruleFiles = 0;
for (const f of tracked) {
  const buf = readFileSync(abs(f)), text = (f.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
  if (!text.includes('cache_write_tokens')) continue;
  ruleFiles++;
  let docs: any[];
  try { docs = [JSON.parse(text)]; } catch { docs = text.split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); }
  for (const doc of docs) ruleWalk(doc, f);
}

// BEAM-1M failure analysis: settled by a ledger from before 8a8e502a. Only each answer's input tokens are committed,
// so a non-cached answer counts its input less 3 tokens as cache writes when that is 1,024 or more (the measured rule;
// the BEAM reader sends no cached prefix, as the S1 fixes' raw rows show).
const beamDir = B + '/2026-10-08-beam-1m-failure-analysis/arms';
const beam_1m_failure_analysis = readdirSync(abs(beamDir)).filter(a => a.endsWith('-gpt61sol')).sort().map(arm => {
  let ledger = 0, answers = 0, cached = 0, below = 0, eligible = 0, maxIn = 0;
  for (const s of readdirSync(abs(join(beamDir, arm))).filter(s => s.startsWith('shard-')).sort()) {
    ledger += json(join(beamDir, arm, s, 'receipt.json')).cost.usd;
    for (const a of gz(join(beamDir, arm, s, 'answers.ndjson.gz'))) {
      answers++;
      if (a.cached) { cached++; continue; }
      maxIn = Math.max(maxIn, a.input_tokens);
      if (a.input_tokens - 3 >= 1024) eligible += a.input_tokens - 3; else below++;
    }
  }
  maxInput['beam-1m-failure-analysis/' + arm] = maxIn;
  const premium = eligible * PREMIUM;
  return { arm, answers, cached_answers: cached, prompts_under_rule: below, cache_write_tokens: eligible, ledger_usd: r6(ledger), premium_usd: r6(premium), corrected_usd: r6(ledger + premium), pct_low: r6(100 * premium / ledger) };
});

// BEAM-1M S1 fixes: settled after 8a8e502a. The rows' raw usage at the cache-write rate should reproduce the ledger
// less a small judge remainder; at the input rate it would not.
const s1Dir = B + '/2026-10-12-beam-1m-s1-fixes/arms';
const beam_1m_s1_fixes = readdirSync(abs(s1Dir)).filter(a => a.endsWith('-gpt61sol')).sort().map(arm => {
  let ledger = 0, requests = 0, withWrite = 0, atInput = 0;
  for (const s of readdirSync(abs(join(s1Dir, arm))).filter(s => s.startsWith('shard-')).sort()) {
    ledger += json(join(s1Dir, arm, s, 'receipt.json')).cost.usd;
    for (const row of gz(join(s1Dir, arm, s, 'rows.ndjson.gz'))) for (const q of row.qa_receipts ?? []) {
      const u = q.usage_raw;
      if (!u || !isSol(q.model) || q.from_cache) continue;
      observe('beam-1m-s1-fixes', u);
      requests++;
      const d = details(u), cr = d.cached_tokens ?? 0, cw = d.cache_write_tokens ?? 0, p = promptTokens(u), o = u.completion_tokens ?? u.output_tokens ?? 0;
      withWrite += ((p - cr - cw) * SOL.input + cr * SOL.cached + cw * SOL.cache_write + o * SOL.output) / 1e6;
      atInput += ((p - cr) * SOL.input + cr * SOL.cached + o * SOL.output) / 1e6;
    }
  }
  return { arm, sol_requests: requests, ledger_usd: r6(ledger), sol_reader_usd_at_cache_write_rate: r6(withWrite), sol_reader_usd_at_input_rate: r6(atInput), ledger_less_reader_usd: r6(ledger - withWrite) };
});

// Program-primary lane (t0 runner): every committed run with raw usage receipts. The premium is read per cell from the
// receipts' cache-write tokens and added to the cell's recorded dollars.
const T0_DIRS = [
  '2026-10-08-program-primary/baseline',
  '2026-10-08-program-primary-hard/baseline',
  '2026-10-08-program-primary-hard/candidate-0-master',
  '2026-10-08-program-primary-hard/calibration/round-1',
  '2026-10-08-program-primary-hard/calibration/round-2',
  '2026-10-08-program-primary-hard/calibration/round-3',
  '2026-10-08-program-primary-hard/candidate-1-newer-mentions/master',
  '2026-10-08-program-primary-hard/candidate-1-newer-mentions/candidate-1',
  '2026-10-08-program-primary-hard/candidate-1-newer-mentions/fresh-seeds/master',
  '2026-10-08-program-primary-hard/candidate-1-newer-mentions/fresh-seeds/candidate-1',
  '2026-10-08-program-primary-hard/candidate-1-newer-mentions/candidate-1-mutant-stale-correction',
  '2026-10-08-program-primary-hard/candidate-1-newer-mentions/candidate-1-mutants-amendment-3',
  '2026-10-08-program-primary-hard/candidate-1-newer-mentions/exploratory-candidate-1-plus-f24ca6afe',
  '2026-10-08-program-primary-hard/alias-stack/development/master',
  '2026-10-08-program-primary-hard/alias-stack/development/alias',
  '2026-10-08-program-primary-hard/alias-stack/fresh-seeds/master',
  '2026-10-08-program-primary-hard/alias-stack/fresh-seeds/alias',
  '2026-10-08-program-primary-hard/alias-stack/alias-mutants',
  '2026-10-14-proactive-brief-dev/development',
  '2026-10-15-proactive-brief-dev-v2/development',
];
type Arm = { cells: number; total: number; reader: number; premium: number };
const t0: Record<string, { sol: Record<string, Arm>; all: Record<string, Arm>; cells_usd: number; sol_premium: number }> = {};
for (const dir of T0_DIRS) {
  const premium: Record<string, number> = {};
  for (const u of gz(join(B, dir, 'usage.jsonl.gz'))) {
    if (!isSol(u.model) || !u.usage_raw || u.from_cache) continue;
    observe('program-primary-lane', u.usage_raw);
    premium[u.cell] = (premium[u.cell] ?? 0) + (details(u.usage_raw).cache_write_tokens ?? 0) * PREMIUM;
  }
  const sol: Record<string, Arm> = {}, all: Record<string, Arm> = {};
  let cellsUsd = 0;
  for (const c of gz(join(B, dir, 'results.jsonl.gz'))) {
    cellsUsd += c.usd?.total ?? 0;
    for (const [bucket, on] of [[all, true], [sol, isSol(c.reader)]] as const) {
      if (!on) continue;
      const a = bucket[c.arm] ??= { cells: 0, total: 0, reader: 0, premium: 0 };
      a.cells++; a.total += c.usd?.total ?? 0; a.reader += c.usd?.reader ?? 0; a.premium += premium[c.key] ?? 0;
    }
  }
  t0[dir] = { sol, all, cells_usd: cellsUsd, sol_premium: Object.values(premium).reduce((s, x) => s + x, 0) };
}
const perCell = (a: Arm) => ({ cells: a.cells, total_per_cell_usd: r6(a.total / a.cells), corrected_total_per_cell_usd: r6((a.total + a.premium) / a.cells), reader_per_cell_usd: r6(a.reader / a.cells), corrected_reader_per_cell_usd: r6((a.reader + a.premium) / a.cells), pct_low_reader: r6(100 * a.premium / a.reader) });
const program_primary_lane = Object.entries(t0).flatMap(([dir, v]) => Object.entries(v.sol).map(([arm, a]) => ({ dir, arm, reader: 'gpt-6.1-sol', ...perCell(a) })));

const ratio = (name: string, [d1, a1]: [string, string], [d2, a2]: [string, string]) => {
  const x = t0[d1].sol[a1], y = t0[d2].sol[a2];
  const old = (x.total / x.cells) / (y.total / y.cells), now = ((x.total + x.premium) / x.cells) / ((y.total + y.premium) / y.cells);
  return { name, numerator: d1 + ' ' + a1, denominator: d2 + ' ' + a2, ratio: r6(old), corrected_ratio: r6(now), within_envelope: now <= ENVELOPE_DOLLAR_LIMIT };
};
const H = '2026-10-08-program-primary-hard/';
const sol_dollar_ratios = [
  ratio('hard root cause: candidate 0 over baseline', [H + 'candidate-0-master', 'baseline'], [H + 'baseline', 'baseline']),
  ratio('alias stack, development: alias over master', [H + 'alias-stack/development/alias', 'baseline'], [H + 'alias-stack/development/master', 'baseline']),
  ratio('alias stack, fresh seeds: alias over master', [H + 'alias-stack/fresh-seeds/alias', 'baseline'], [H + 'alias-stack/fresh-seeds/master', 'baseline']),
  ratio('candidate 1, development: candidate 1 over master', [H + 'candidate-1-newer-mentions/candidate-1', 'baseline'], [H + 'candidate-1-newer-mentions/master', 'baseline']),
  ratio('candidate 1, fresh seeds: candidate 1 over master', [H + 'candidate-1-newer-mentions/fresh-seeds/candidate-1', 'baseline'], [H + 'candidate-1-newer-mentions/fresh-seeds/master', 'baseline']),
];

const proactive_brief_all_readers = ['2026-10-14-proactive-brief-dev/development', '2026-10-15-proactive-brief-dev-v2/development'].flatMap(dir =>
  Object.entries(t0[dir].all).map(([arm, a]) => ({ dir, arm, cells: a.cells, total_per_cell_usd: r6(a.total / a.cells), corrected_total_per_cell_usd: r6((a.total + a.premium) / a.cells) })));

// Runs whose committed cost files are the whole ledger: the gap between the ledger and the cells' recorded dollars,
// and how much of it the Sol premium from the receipts explains.
const ledger_checks = ['2026-10-08-program-primary-hard/baseline', '2026-10-08-program-primary-hard/candidate-0-master', '2026-10-14-proactive-brief-dev/development', '2026-10-15-proactive-brief-dev-v2/development'].map(dir => {
  const costs = readdirSync(abs(join(B, dir))).filter(f => f.startsWith('cost-') && f.endsWith('.json')).sort();
  const ledger = costs.reduce((s, f) => s + json(join(B, dir, f)).usd, 0), { cells_usd, sol_premium } = t0[dir];
  return { dir, cost_files: costs.length, ledger_usd: r6(ledger), cells_usd: r6(cells_usd), gap_usd: r6(ledger - cells_usd), sol_premium_usd: r6(sol_premium), premium_share_of_gap: r6(sol_premium / (ledger - cells_usd)) };
});

// Sealed confirmation: no usage receipts are committed, so Sol gets the whole gap between each arm's ledger and its
// cells' recorded dollars, an upper bound.
const sealedDir = B + '/2026-10-08-program-primary-hard/sealed-confirmation';
const sealed = Object.fromEntries(['frozen/counted', 'stack/counted', 'stack/mutants'].map(part => {
  const d = join(sealedDir, part);
  const ledger = readdirSync(abs(d)).filter(f => f.startsWith('cost-')).sort().reduce((s, f) => s + json(join(d, f)).usd, 0);
  const rows = gz(join(d, 'scores.jsonl.gz')), sol = rows.filter(r => isSol(r.reader));
  const cells = rows.reduce((s, r) => s + r.usd, 0), solUsd = sol.reduce((s, r) => s + r.usd, 0);
  return [part, { cells: rows.length, sol_cells: sol.length, ledger_usd: r6(ledger), cells_usd: r6(cells), gap_usd: r6(ledger - cells), sol_per_cell_usd: r6(solUsd / sol.length), sol_per_cell_upper_bound_usd: r6((solUsd + ledger - cells) / sol.length) }];
}));
const sf = sealed['stack/counted'], ff = sealed['frozen/counted'];
const sealed_confirmation = { arms: sealed, stack_over_frozen: r6(sf.sol_per_cell_usd / ff.sol_per_cell_usd), stack_over_frozen_upper_bounds: r6(sf.sol_per_cell_upper_bound_usd / ff.sol_per_cell_upper_bound_usd), within_envelope: sf.sol_per_cell_upper_bound_usd / ff.sol_per_cell_upper_bound_usd <= ENVELOPE_DOLLAR_LIMIT };

// F6 dry run: the metering proxy's per-cell Sol reader aggregates [calls, input, output, usd] reproduce only with every
// input token at the cache-write rate.
const f6 = json(B + '/2026-10-29-f6-current-master/dry-run/summary.json');
const f6_dry_run = f6.cells.flatMap((c: any) => Object.entries(c.usage ?? {}).filter(([k]) => k.endsWith('|gpt-6.1-sol')).map(([, v]: any) => {
  const [calls, input, output, usd] = v;
  return { cell: c.cell, run: c.run, calls, input_tokens: input, output_tokens: output, recorded_usd: usd, at_cache_write_rate_usd: r6((input * SOL.cache_write + output * SOL.output) / 1e6), at_input_rate_usd: r6((input * SOL.input + output * SOL.output) / 1e6) };
}));

// W10b and W10c Sol rows (corrected 2026-11-01): list and batch reader dollars at the cache-write rate.
const w10 = Object.fromEntries([
  ['w10b-sol-notes', B + '/2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-sol-notes/rows.ndjson'],
  ['w10c-sol-currentpin', B + '/2026-10-07-longmemeval-w10c-full-context/arms/w10c-sol-currentpin/rows.ndjson'],
  ['w10c-sol-full', B + '/2026-10-07-longmemeval-w10c-full-context/arms/w10c-sol-full/rows.ndjson'],
].map(([arm, p]) => {
  const rows = nd(p);
  let recorded = 0, list = 0, prompt = 0, writes = 0, correct = 0;
  for (const r of rows) {
    recorded += r.list_usd ?? 0; correct += r.correct_official ?? 0;
    if (!r.usage) continue;
    observe('longmemeval-w10', r.usage);
    const d = details(r.usage), cr = d.cached_tokens ?? 0, cw = d.cache_write_tokens ?? 0, p0 = promptTokens(r.usage);
    prompt += p0; writes += cw;
    list += ((p0 - cr - cw) * SOL.input + cr * SOL.cached + cw * SOL.cache_write + (r.usage.completion_tokens ?? 0) * SOL.output) / 1e6;
  }
  return [arm, { questions: rows.length, correct_official: correct, prompt_tokens: prompt, cache_write_tokens: writes, recorded_list_usd: r6(recorded), list_usd: r6(list), batch_usd: r6(list / 2), list_per_question_usd: r6(list / rows.length), batch_per_question_usd: r6(list / 2 / rows.length), list_per_correct_usd: r6(list / correct), batch_per_correct_usd: r6(list / 2 / correct) }];
}));

const results = {
  generated_by: 'docs/audit/2026-11-09-openai-cache-writes/beam-and-program-primary/reprice.ts',
  prices_usd_per_million: { 'gpt-6.1-sol': SOL },
  envelope_dollar_limit: ENVELOPE_DOLLAR_LIMIT,
  long_tier: { max_input_tokens_per_request: maxInput, any_above_272k: Object.values(maxInput).some(m => m > SOL.long_tier_above) },
  cache_write_rule: { files_scanned: ruleFiles, by_model: rule },
  beam_1m_failure_analysis,
  beam_1m_s1_fixes,
  program_primary_lane,
  sol_dollar_ratios,
  proactive_brief_all_readers,
  ledger_checks,
  sealed_confirmation,
  f6_dry_run,
  w10,
};
writeFileSync(OUT, JSON.stringify(results, null, 1) + '\n');
console.log('wrote ' + OUT.slice(REPO.length + 1));

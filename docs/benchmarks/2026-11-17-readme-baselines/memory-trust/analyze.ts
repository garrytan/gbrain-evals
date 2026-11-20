/**
 * Pairs the Cat 37 plain-pg baseline receipts with the published gbrain receipts (README baselines, GBEV-97).
 *
 *   bun docs/benchmarks/2026-11-17-readme-baselines/memory-trust/analyze.ts [--plain <receipt>...] [--out <json>]
 *
 * Writes analysis.json (rates with Clopper-Pearson 95% intervals, paired tests) and rows.csv (one line per model,
 * scenario and repeat: each arm's attack or benign outcome, plain-pg relay and seen flags, judge errors as "error").
 *
 * gbrain rows: docs/benchmarks/2026-10-08-memory-trust/paid/cat37-{opus,sonnet,gpt}.receipt.json (modes off and
 * default, labels shown) and cat37-labels-absent.receipt.json, all at gbrain c2f10ee8. Pairs are (model, scenario,
 * repeat); a row with an error (a judge error) drops its pair. Primary test: exact McNemar against the off arm, the
 * arm behind README's "with trust labels shown" number, as the gbrain report paired its own arms.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clopperPearson } from '../../../../eval/runner/stats/exact.ts';
import { clusteredPairedDelta, exactMcNemar } from '../../../../eval/runner/stats/paired.ts';

type Row = { scenario_id: string; model: string; mode: string; repeat: number; kind: string; path: string; style: string; goal: string; relayed: boolean | null; seen?: boolean; attack_success: boolean | null; attack_via: string | null; benign_success: boolean | null; error?: string; usd: number };

const argv = process.argv.slice(2);
const flagAll = (f: string) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]!] : []));
const here = import.meta.dir;
const GB = join(here, '../../2026-10-08-memory-trust/paid');
const plainPaths = flagAll('--plain').length ? flagAll('--plain') : ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'].map(m => join(here, `receipts/${m}.receipt.json`));
const rowsOf = (p: string): Row[] => JSON.parse(readFileSync(p, 'utf8')).data.model_arm.rows;
const plain = plainPaths.flatMap(rowsOf);
const gbrain = ['cat37-opus', 'cat37-sonnet', 'cat37-gpt', 'cat37-labels-absent'].flatMap(f => rowsOf(join(GB, `${f}.receipt.json`)));
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'];
const key = (r: Row) => `${r.model}|${r.scenario_id}|${r.repeat}`;
const ok = (r: Row) => !r.error;
const frac = (hits: number, n: number) => ({ hits, n, rate: n ? hits / n : null, ci95: n ? (({ lower, upper }) => [lower, upper])(clopperPearson(hits, n)) : null });

function arm(rows: Row[]) {
  const atk = rows.filter(r => r.kind === 'attack' && ok(r));
  const ben = rows.filter(r => r.kind === 'benign' && ok(r));
  const relayable = atk.filter(r => r.path === 'agent_relayed' && r.relayed !== null);
  const seenRows = atk.filter(r => typeof r.seen === 'boolean');
  return {
    attack: frac(atk.filter(r => r.attack_success).length, atk.length),
    attack_external: frac(atk.filter(r => r.path === 'external' && r.attack_success).length, atk.filter(r => r.path === 'external').length),
    attack_agent_relayed: frac(atk.filter(r => r.path === 'agent_relayed' && r.attack_success).length, atk.filter(r => r.path === 'agent_relayed').length),
    attack_claim: frac(atk.filter(r => r.attack_via === 'claim').length, atk.filter(r => r.goal === 'claim').length),
    attack_tool: frac(atk.filter(r => r.attack_via === 'tool').length, atk.filter(r => r.goal === 'tool').length),
    instruction_followed: frac(atk.filter(r => r.style === 'instruction' && r.attack_success).length, atk.filter(r => r.style === 'instruction').length),
    factual_adopted: frac(atk.filter(r => r.style === 'factual' && r.attack_success).length, atk.filter(r => r.style === 'factual').length),
    relay_rate: frac(relayable.filter(r => r.relayed).length, relayable.length),
    seen: seenRows.length ? frac(seenRows.filter(r => r.seen).length, seenRows.length) : null,
    seen_agent_relayed: seenRows.length ? frac(seenRows.filter(r => r.path === 'agent_relayed' && r.seen).length, seenRows.filter(r => r.path === 'agent_relayed').length) : null,
    attack_given_seen: seenRows.length ? frac(seenRows.filter(r => r.seen && r.attack_success).length, seenRows.filter(r => r.seen).length) : null,
    benign: frac(ben.filter(r => r.benign_success).length, ben.length),
    errors: rows.filter(r => !ok(r)).length,
    rows: rows.length,
    usd_per_scenario_run: rows.length ? rows.reduce((s, r) => s + (r.usd ?? 0), 0) / rows.length : null,
  };
}

/** errorsAs: score a judge-error row in the plain-pg arm as adopted (1) or not (0) instead of dropping its pair (bounds). */
function paired(gb: Row[], pp: Row[], errorsAs?: 0 | 1) {
  const b = new Map(pp.filter(r => r.kind === 'attack' && (ok(r) || errorsAs !== undefined)).map(r => [key(r), r]));
  const score = (r: Row) => (ok(r) ? (r.attack_success ? 1 : 0) : errorsAs!);
  const pairs = gb.filter(r => r.kind === 'attack' && ok(r) && b.has(key(r))).map(r => ({ id: key(r), cluster: `${r.model}|${r.scenario_id}`, a: r.attack_success ? 1 : 0, b: score(b.get(key(r))!) }));
  if (!pairs.length) return null;
  const mc = exactMcNemar(pairs);
  const d = clusteredPairedDelta(pairs, { seed: 97, draws: 10_000 });
  return { pairs: pairs.length, gbrain_only: mc.losses, plain_only: mc.wins, both: mc.both_pass, mcnemar_p: mc.p_two_sided, delta_plain_minus_gbrain: d.delta, delta_ci95: d.ci95,
    classification: mc.p_two_sided < 0.05 ? (mc.wins > mc.losses ? 'win (gbrain lower adoption)' : 'loss (plain lower adoption)') : 'no measurable difference' };
}

const by = (rows: Row[], model: string | null, mode: string) => rows.filter(r => (model === null || r.model === model) && r.mode === mode);
const out: Record<string, unknown> = {};
for (const m of [...MODELS, null]) {
  const name = m ?? 'pooled';
  const pp = by(plain, m, 'plain-pg');
  out[name] = {
    plain_pg: arm(pp),
    gbrain_off: arm(by(gbrain, m, 'off')),
    gbrain_default: arm(by(gbrain, m, 'default')),
    gbrain_labels_absent: arm(by(gbrain, m, 'labels-absent')),
    paired_vs_off: paired(by(gbrain, m, 'off'), pp),
    paired_vs_off_judge_errors_not_adopted: paired(by(gbrain, m, 'off'), pp, 0),
    paired_vs_off_judge_errors_adopted: paired(by(gbrain, m, 'off'), pp, 1),
    paired_vs_default: paired(by(gbrain, m, 'default'), pp),
    paired_vs_labels_absent: paired(by(gbrain, m, 'labels-absent'), pp),
  };
}
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : join(here, 'analysis.json');
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
const cell = (r: Row | undefined) => (!r ? '' : r.error ? 'error' : String(Number(r.kind === 'attack' ? r.attack_success : r.benign_success)));
const idx = (rows: Row[], mode: string) => new Map(rows.filter(r => r.mode === mode).map(r => [key(r), r]));
const [off, def, abs] = ['off', 'default', 'labels-absent'].map(m => idx(gbrain, m));
const csv = ['model,scenario_id,repeat,kind,path,artifact,style,goal,gbrain_off,gbrain_default,gbrain_labels_absent,plain_pg,plain_pg_relayed,plain_pg_seen',
  ...plain.map(r => [r.model, r.scenario_id, r.repeat, r.kind, r.path, (r as Row & { artifact: string }).artifact, r.style, r.goal, cell(off!.get(key(r))), cell(def!.get(key(r))), cell(abs!.get(key(r))), cell(r), r.relayed ?? '', r.seen ?? ''].join(','))];
writeFileSync(join(outPath, '..', 'rows.csv'), csv.join('\n') + '\n');
const pct = (f: { hits: number; n: number; rate: number | null; ci95: number[] | null } | null) => f && f.rate !== null ? `${f.hits}/${f.n} (${(100 * f.rate).toFixed(1)}%, ${(100 * f.ci95![0]!).toFixed(1)}-${(100 * f.ci95![1]!).toFixed(1)})` : 'n/a';
for (const [name, v] of Object.entries(out) as Array<[string, any]>) {
  console.log(`\n${name}`);
  for (const a of ['plain_pg', 'gbrain_off', 'gbrain_default', 'gbrain_labels_absent']) console.log(`  ${a.padEnd(22)} attack ${pct(v[a].attack)}  instr ${pct(v[a].instruction_followed)}  relay ${pct(v[a].relay_rate)}  seen ${pct(v[a].seen)}  benign ${pct(v[a].benign)}  err ${v[a].errors}`);
  for (const p of ['paired_vs_off', 'paired_vs_off_judge_errors_not_adopted', 'paired_vs_off_judge_errors_adopted', 'paired_vs_default', 'paired_vs_labels_absent']) { const x = v[p]; if (x) console.log(`  ${p.padEnd(40)} n=${x.pairs} gbrain-only ${x.gbrain_only} plain-only ${x.plain_only} p=${x.mcnemar_p.toPrecision(3)} delta ${(100 * x.delta_plain_minus_gbrain).toFixed(1)} pts [${x.delta_ci95?.map((y: number) => (100 * y).toFixed(1)).join(', ')}] ${x.classification}`); }
}
console.log(`\nwrote ${outPath}`);

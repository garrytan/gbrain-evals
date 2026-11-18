/**
 * Scores classic entity-resolution tools (Splink, dedupe, Zingg) on the
 * person-dedupe world, from their output files, with the same ledger and
 * scoring functions as eval/runner/person-dedupe.ts.
 *
 * Each system writes one JSON file per configuration in a neutral shape:
 *   { "system": "splink", "version": "5.0.0", "config": "default",
 *     "tiers": { "auto": [["work:maya-reeves", "home:maya-reeves"], ...],
 *                "proposed": [[...], ...] } }
 * A page key is "<source_id>:<slug>", as the person-dedupe scorer keys pages.
 * `auto` is the tool's own match decision, clustered the way the tool
 * clusters; `proposed` is a review band and is left out when the tool has
 * none. Clusters in one tier must not share a page. Singletons may be left out.
 *
 * Each tier is scored as a set of groups closed transitively: false-merge
 * rate over the designed different-people pairs (Wilson 95% interval), then
 * recall and precision over every page pair, pair F1 and B-cubed F1.
 *
 * The adapters train and tune only on a held-out world. `labels` writes the
 * page-to-person map an adapter's labeller reads, and refuses the scored seed.
 *
 * Usage:
 *   bun eval/runner/er-h2h-score.ts [--seed N] [--per-family N] [--output DIR] [--json] FILE...
 *   bun eval/runner/er-h2h-score.ts labels --seed N [--per-family N] [--scored-seed N] --out FILE
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  PERSON_DEDUPE_DEFAULT_PER_FAMILY, PERSON_DEDUPE_DEFAULT_SEED, PERSON_DEDUPE_GENERATOR_VERSION,
  deriveGold, generateLedger, ledgerFingerprint, pageKey, type Ledger,
} from '../generators/person-dedupe-gen.ts';
import { scoreGroups, type Group, type Rate, type Score } from './person-dedupe.ts';

export const ER_TIERS = ['auto', 'proposed'] as const;
export type ErTier = typeof ER_TIERS[number];

export interface ErOutput { system: string; version: string; config: string; tiers: Partial<Record<ErTier, string[][]>> }

export interface ErRow {
  system: string;
  version: string;
  config: string;
  tier: ErTier;
  clusters: number;
  false_merge: Rate;
  designed_recall: Rate;
  precision: Rate;
  recall: Rate;
  pair_f1: number | null;
  b3_f1: number;
  false_merges_anywhere: number;
  by_family: Score['by_family'];
}

const fail = (msg: string): never => { throw new Error(`er-h2h-score: ${msg}`); };

/** Checks one output file against the world's page keys. Throws on anything the scorer cannot read exactly. */
export function parseErOutput(raw: unknown, known: ReadonlySet<string>): ErOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('output is not an object');
  const o = raw as ErOutput;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'config,system,tiers,version') fail(`output has keys ${keys}, expected config,system,tiers,version`);
  for (const f of ['system', 'version', 'config'] as const) if (typeof o[f] !== 'string' || !o[f]) fail(`${f} must be a non-empty string`);
  const id = `${o.system}/${o.config}`;
  if (!o.tiers || typeof o.tiers !== 'object' || Array.isArray(o.tiers)) fail(`${id}: tiers is not an object`);
  for (const t of Object.keys(o.tiers)) if (!(ER_TIERS as readonly string[]).includes(t)) fail(`${id} has tier ${t}; tiers are ${ER_TIERS.join(', ')}`);
  if (!o.tiers.auto) fail(`${id} has no auto tier`);
  for (const [tier, clusters] of Object.entries(o.tiers)) {
    if (!Array.isArray(clusters)) fail(`${id} tier ${tier} is not a list of clusters`);
    const seen = new Set<string>();
    for (const c of clusters as unknown[]) {
      if (!Array.isArray(c) || c.some(k => typeof k !== 'string')) fail(`${id} tier ${tier} has a cluster that is not a list of page keys`);
      for (const k of new Set(c as string[])) {
        if (!known.has(k)) fail(`${id} tier ${tier} names ${k}, which the world does not have`);
        if (seen.has(k)) fail(`${id} tier ${tier} puts ${k} in two clusters`);
        seen.add(k);
      }
    }
  }
  return o;
}

const pairF1 = (s: Score) => s.precision.rate === null || s.recall.rate === null || s.precision.rate + s.recall.rate === 0 ? null : (2 * s.precision.rate * s.recall.rate) / (s.precision.rate + s.recall.rate);

/** Scores each tier of one output as groups closed transitively, with the person-dedupe scorer. */
export function scoreErOutput(out: ErOutput, ledger: Ledger): ErRow[] {
  const person = deriveGold(ledger);
  return ER_TIERS.filter(t => out.tiers[t]).map(tier => {
    const groups: Group[] = out.tiers[tier]!.map(c => [...new Set(c)].sort()).filter(m => m.length > 1).map(members => ({ members, kind: 'cluster', class: tier, rules: [`${out.system}/${out.config}`] }));
    const s = scoreGroups(groups, ledger.pairs, person);
    return { system: out.system, version: out.version, config: out.config, tier, clusters: groups.length, false_merge: s.false_merge, designed_recall: s.designed_recall, precision: s.precision, recall: s.recall, pair_f1: pairF1(s), b3_f1: s.b3.f1, false_merges_anywhere: s.false_merges_anywhere, by_family: s.by_family };
  });
}

/** Page key to person id for a held-out world, for an adapter's labeller. Never for the scored seed. */
export function heldOutLabels(seed: number, perFamily: number, scoredSeed: number = PERSON_DEDUPE_DEFAULT_SEED) {
  if (seed === scoredSeed) fail(`labels: seed ${seed} is the scored seed; labels and tuning come only from a held-out seed`);
  const ledger = generateLedger(seed, perFamily);
  return { seed, per_family: perFamily, generator_version: PERSON_DEDUPE_GENERATOR_VERSION, ledger_sha256: ledgerFingerprint(ledger), person: Object.fromEntries(deriveGold(ledger)) };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (r: Rate) => r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(1)}% (${r.k}/${r.n}; 95% CI ${(r.ci95![0] * 100).toFixed(1)} to ${(r.ci95![1] * 100).toFixed(1)}%)`;

function main(): void {
  const argv = process.argv.slice(2);
  const perFamily = Number(argValue(argv, '--per-family') ?? PERSON_DEDUPE_DEFAULT_PER_FAMILY);
  if (argv[0] === 'labels') {
    const seed = argValue(argv, '--seed');
    const out = argValue(argv, '--out');
    if (!seed || !out) return fail('labels needs --seed N and --out FILE');
    const labels = heldOutLabels(Number(seed), perFamily, Number(argValue(argv, '--scored-seed') ?? PERSON_DEDUPE_DEFAULT_SEED));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify(labels) + '\n');
    console.log(`labels for held-out seed ${seed}: ${Object.keys(labels.person).length} pages, ledger ${labels.ledger_sha256.slice(0, 12)} -> ${out}`);
    return;
  }
  const valued = new Set(['--seed', '--per-family', '--output']);
  const files = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  if (!files.length) fail('give one or more output files');
  const seed = Number(argValue(argv, '--seed') ?? PERSON_DEDUPE_DEFAULT_SEED);
  const ledger = generateLedger(seed, perFamily);
  const known = new Set(ledger.pages.map(pageKey));
  const inputs = files.map(file => {
    const text = readFileSync(file, 'utf8');
    return { file, sha256: createHash('sha256').update(text).digest('hex'), output: parseErOutput(JSON.parse(text), known) };
  });
  const rows = inputs.flatMap(i => scoreErOutput(i.output, ledger));
  const fingerprint = ledgerFingerprint(ledger);
  const nDiff = ledger.pairs.filter(p => p.label === 'different').length;
  const result = {
    seed, per_family: perFamily, generator_version: PERSON_DEDUPE_GENERATOR_VERSION, ledger_sha256: fingerprint, pages: ledger.pages.length,
    designed_pairs: { different: nDiff, same: ledger.pairs.length - nDiff },
    inputs: inputs.map(i => ({ file: i.file, sha256: i.sha256, system: i.output.system, version: i.output.version, config: i.output.config, tiers: Object.keys(i.output.tiers) })),
    rows,
  };
  const outputDir = argValue(argv, '--output');
  if (outputDir) {
    mkdirSync(resolve(outputDir), { recursive: true });
    writeFileSync(join(resolve(outputDir), 'er-h2h-scores.json'), JSON.stringify(result, null, 2) + '\n');
  }
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
  console.log(`# Classic ER tools on person-dedupe\n\nseed ${seed}; ${perFamily} per family; ledger ${fingerprint.slice(0, 12)}; ${ledger.pages.length} pages; ${ledger.pairs.length} designed pairs (${nDiff} different-people, ${ledger.pairs.length - nDiff} same-person)\n`);
  console.log('| system | version | config | tier | false-merge rate (designed different-people pairs) | recall (all pairs) | precision (all pairs) | pair F1 | B-cubed F1 | clusters |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.system} | ${r.version} | ${r.config} | ${r.tier} | ${pct(r.false_merge)} | ${pct(r.recall)} | ${pct(r.precision)} | ${r.pair_f1 === null ? 'n/a' : r.pair_f1.toFixed(3)} | ${r.b3_f1.toFixed(3)} | ${r.clusters} |`);
  for (const i of inputs) if (!i.output.tiers.proposed) console.log(`\n${i.output.system}/${i.output.config}: no proposed tier (the tool has no review band)`);
  if (outputDir) console.log(`\nScores: ${join(resolve(outputDir), 'er-h2h-scores.json')}`);
}

if (import.meta.main) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(3); }
}

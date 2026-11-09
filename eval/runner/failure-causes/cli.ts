#!/usr/bin/env bun
/**
 * Failure-cause command line.
 *
 *   bun eval/runner/failure-causes/cli.ts taxonomy [--write | --check]
 *   bun eval/runner/failure-causes/cli.ts classify --manifest <sources.json> --root <name>=<dir> ... --out <labels.ndjson>
 *       [--failures-out <failures.ndjson>] [--stress-out <stress.json>] [--counts-out <counts.json>]
 *   bun eval/runner/failure-causes/cli.ts estimate --failures <failures.ndjson> [--labelset-per-family <n>]
 *   bun eval/runner/failure-causes/cli.ts label --failures <failures.ndjson> --out <file> --cache <dir> [--mode production|labelset]
 *       [--labelset-per-family <n>] --paid --budget-run-id <id>
 *   bun eval/runner/failure-causes/cli.ts agree --labelset <double.ndjson> --production <labels.ndjson> --out <label-check.json>
 *   bun eval/runner/failure-causes/cli.ts report --labels <a.ndjson>[,<b.ndjson>] [--gates <label-check.json>] [--stress <stress.json>]
 *       --out-dir <dir> --heading <text> [--allow-stale]
 *
 * report counts each source, run and case once when label files overlap, the last file winning, and refuses any model
 * label whose labeller path and row family have no passing gate in --gates. agree fails when a (path, family) pair the
 * production labels used has no passing gate, or when there is nothing to gate. classify and report are
 * keyless. failures.ndjson carries row text for the labeller: keep it in a private work directory, never in the
 * repository. label spends money and refuses without --paid and an open budget run; it exits 1 when the budget stops it
 * or when any row got no label, so a partial run is never mistaken for a finished one.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_PRICE_OVERRIDES, budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { ChatClient } from '../memory-qa/qa-v2.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { ADAPTERS } from './adapters/index.ts';
import { buildLabelSet, gatePaths, LABEL_SET_PER_FAMILY, labelSetSample, NO_LABEL_RULES, productionLabels, ungated, type DoubleLabel, type PathGate } from './agreement.ts';
import { classify } from './classify.ts';
import { buildLabelPrompt, LABEL_SET_LABELLERS, labellerFor, labelResidual, labelSet, type LabellerSpec } from './label.ts';
import { loadSource, readManifest } from './manifest.ts';
import { issueDrafts, renderReport, summarize } from './report.ts';
import { renderTaxonomyMarkdown } from './taxonomy.ts';
import type { CauseLabel, EvalFailure, SourceCounts, StressCount } from './types.ts';

export const TAXONOMY_DOC = 'docs/failure-causes/TAXONOMY.md';
const STALE_MS = 8 * 24 * 3600 * 1000;
const OUTPUT_TOKENS: Record<string, number> = { medium: 2_500, high: 5_000 };

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (argv: string[], name: string) => { const v = flag(argv, name); if (!v) throw new Error(`pass ${name}`); return v; };
const readNdjson = <T>(path: string): T[] => readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
const writeNdjson = (path: string, rows: unknown[]) => writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const stratum = (f: EvalFailure) => `${f.source}|${f.model.split(':')[0]}`;
const family = (model: string) => labellerFor(model).path;

function roots(argv: string[]): Record<string, string> {
  return Object.fromEntries(argv.flatMap((a, i) => (a === '--root' ? [argv[i + 1]] : [])).map(r => {
    const at = r?.indexOf('=') ?? -1;
    if (at <= 0) throw new Error(`--root takes <name>=<dir>, got ${r}`);
    return [r.slice(0, at), r.slice(at + 1)];
  }));
}

function residuals(failures: EvalFailure[]): EvalFailure[] {
  return failures.filter(f => classify(f).basis === 'needs_model' && f.text && (f.visibility === 'public' || f.visibility === 'synthetic'));
}

/** List-price estimate: prompt characters over four as input tokens, a fixed output allowance per effort. */
export function estimateUsd(calls: Array<{ spec: LabellerSpec; chars: number }>): number {
  return calls.reduce((sum, { spec, chars }) => {
    const price = CHAT_PRICE_OVERRIDES[spec.model];
    if (!price) throw new Error(`no list price for ${spec.model} in budget-ledger.ts`);
    return sum + (chars / 4) * price.input / 1e6 + (OUTPUT_TOKENS[spec.effort] ?? 5_000) * price.output / 1e6;
  }, 0);
}

function plan(failures: EvalFailure[], perFamily: number) {
  const rest = residuals(failures);
  const sample = labelSetSample(rest, f => family(f.model), f => f.source, f => `${f.source}|${f.case_id}`, perFamily);
  const chars = (f: EvalFailure) => { const p = buildLabelPrompt(f); return p.system.length + p.prompt.length; };
  const production = rest.map(f => ({ spec: labellerFor(f.model), chars: chars(f) }));
  const labelset = sample.flatMap(f => LABEL_SET_LABELLERS.map(spec => ({ spec, chars: chars(f) })));
  return { rest, sample, production, labelset };
}

async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'taxonomy') {
    const doc = renderTaxonomyMarkdown();
    if (rest.includes('--write')) { mkdirSync('docs/failure-causes', { recursive: true }); writeFileSync(TAXONOMY_DOC, doc); return 0; }
    if (rest.includes('--check')) {
      const same = existsSync(TAXONOMY_DOC) && readFileSync(TAXONOMY_DOC, 'utf8') === doc;
      if (!same) console.error(`${TAXONOMY_DOC} is stale; run bun eval/runner/failure-causes/cli.ts taxonomy --write`);
      return same ? 0 : 1;
    }
    process.stdout.write(doc);
    return 0;
  }
  if (command === 'classify') {
    const manifest = readManifest(need(rest, '--manifest'));
    const dirs = roots(rest);
    const labels: CauseLabel[] = [];
    const failures: EvalFailure[] = [];
    const stress: StressCount[] = [];
    const counts: Record<string, SourceCounts> = {};
    for (const entry of manifest.sources) {
      const out = ADAPTERS[entry.adapter](loadSource(entry, dirs), entry);
      counts[entry.id] = out.counts;
      failures.push(...out.failures);
      stress.push(...out.stress);
      labels.push(...out.failures.map(classify));
    }
    writeNdjson(need(rest, '--out'), labels);
    if (flag(rest, '--failures-out')) writeNdjson(flag(rest, '--failures-out')!, failures);
    if (flag(rest, '--stress-out')) writeFileSync(flag(rest, '--stress-out')!, JSON.stringify(stress, null, 1) + '\n');
    if (flag(rest, '--counts-out')) writeFileSync(flag(rest, '--counts-out')!, JSON.stringify(counts, null, 1) + '\n');
    const basis = labels.reduce((m, l) => ({ ...m, [l.basis]: (m[l.basis] ?? 0) + 1 }), {} as Record<string, number>);
    console.log(JSON.stringify({ failures: labels.length, basis, stress: stress.length, counts }, null, 1));
    return 0;
  }
  if (command === 'estimate') {
    const p = plan(readNdjson<EvalFailure>(need(rest, '--failures')), Number(flag(rest, '--labelset-per-family') ?? LABEL_SET_PER_FAMILY));
    console.log(JSON.stringify({ residual: p.rest.length, labelset_cases: p.sample.length,
      families: Object.fromEntries([...new Set(p.sample.map(f => family(f.model)))].map(s => [s, p.sample.filter(f => family(f.model) === s).length])),
      strata: Object.fromEntries([...new Set(p.sample.map(stratum))].map(s => [s, p.sample.filter(f => stratum(f) === s).length])),
      production_usd: Number(estimateUsd(p.production).toFixed(2)), labelset_usd: Number(estimateUsd(p.labelset).toFixed(2)),
      basis: 'list prices, prompt characters / 4 as input tokens, 2,500 output tokens at medium effort and 5,000 at high' }, null, 1));
    return 0;
  }
  if (command === 'label') {
    const failures = readNdjson<EvalFailure>(need(rest, '--failures'));
    const out = need(rest, '--out');
    const cache = need(rest, '--cache');
    const mode = flag(rest, '--mode') ?? 'production';
    if (mode !== 'production' && mode !== 'labelset') throw new Error('--mode is production or labelset');
    if (existsSync(out)) throw new Error(`${out} exists; a rerun writes a fresh file (cached calls are free)`);
    const p = plan(failures, Number(flag(rest, '--labelset-per-family') ?? LABEL_SET_PER_FAMILY));
    const estimate = estimateUsd(mode === 'production' ? p.production : p.labelset);
    requirePaidArm(rest, { arm: `failure-cause labeller (${mode})`, estimateUsd: estimate });
    mkdirSync(cache, { recursive: true });
    const { run: budget, guard } = startPaidRun(`failure-cause-labeller-${mode}`, { ...budgetOptionsFrom(rest), estimateUsd: estimate });
    const client = new ChatClient(cache, undefined, undefined, { holdMayHaveBilled: true });
    let stopped: string | null = null;
    let failed = 0;
    try {
      if (mode === 'production') {
        const result = await labelResidual(failures, client);
        stopped = result.stopped;
        failed = result.labels.filter(l => NO_LABEL_RULES.includes(l.rule_id)).length;
        writeNdjson(out, result.labels);
      } else {
        const result = await labelSet(p.sample, client, stratum);
        stopped = result.stopped;
        failed = result.dropped;
        writeNdjson(out, result.rows);
      }
    } finally {
      guard.uninstall();
    }
    const summary = budget.close();
    console.log(JSON.stringify({ mode, stopped, failed, usd: summary.actual_usd, requests: summary.requests }, null, 1));
    if (failed) console.error(`${failed} rows got no label (a failed call or an unparseable reply); rerun to a fresh --out, cached calls are free`);
    return stopped || failed ? 1 : 0;
  }
  if (command === 'agree') {
    const set = buildLabelSet(readNdjson<DoubleLabel>(need(rest, '--labelset')));
    const production = productionLabels(readNdjson<CauseLabel>(need(rest, '--production')), family);
    const gates = gatePaths(set.rows, production);
    writeFileSync(need(rest, '--out'), JSON.stringify({ agreed: set.agreed, disagreed: set.disagreed, gates }, null, 1) + '\n');
    console.log(JSON.stringify(gates.map(g => ({ path: g.path, family: g.family, held_out: g.held_out, kappa: g.kappa, pass: g.pass, reason: g.reason })), null, 1));
    if (!gates.length) console.error('no labeller path to gate: the production labels hold no model label');
    return gates.length && gates.every(g => g.pass) ? 0 : 1;
  }
  if (command === 'report') {
    const files = need(rest, '--labels').split(',');
    if (!rest.includes('--allow-stale')) for (const f of files) if (Date.now() - statSync(f).mtimeMs > STALE_MS) throw new Error(`${f} is more than 8 days old; a weekly report needs this week's labels (or pass --allow-stale for a back-classification)`);
    const labels = [...new Map(files.flatMap(f => readNdjson<CauseLabel>(f)).map(l => [`${l.source}|${l.run_id}|${l.case_id}`, l])).values()];
    if (!labels.length) throw new Error('no labels to report; nothing is filed for an empty week');
    const gates: PathGate[] = flag(rest, '--gates') ? JSON.parse(readFileSync(flag(rest, '--gates')!, 'utf8')).gates : [];
    const refused = ungated(labels, gates, family);
    if (refused.length) throw new Error(`model labels without a passing gate: ${refused.map(r => `${r.path} on ${r.family} (${r.labels})`).join(', ')}; run agree and pass its output as --gates`);
    const stress: StressCount[] = flag(rest, '--stress') ? JSON.parse(readFileSync(flag(rest, '--stress')!, 'utf8')) : [];
    const dir = need(rest, '--out-dir');
    mkdirSync(dir, { recursive: true });
    const summary = summarize(labels, stress);
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
    writeFileSync(join(dir, 'report.md'), renderReport(summary, { heading: need(rest, '--heading') }));
    writeFileSync(join(dir, 'issues.json'), JSON.stringify(issueDrafts(summary), null, 1) + '\n');
    console.log(JSON.stringify({ failures: summary.failures, pending: summary.pending, top_three: summary.top_three.map(r => ({ cause: r.cause, score: r.score, count: r.count })) }, null, 1));
    return 0;
  }
  console.error('usage: bun eval/runner/failure-causes/cli.ts taxonomy|classify|estimate|label|agree|report (see the header of this file)');
  return 2;
}

if (import.meta.main) run(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

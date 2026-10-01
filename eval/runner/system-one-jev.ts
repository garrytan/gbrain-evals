/**
 * gbrain System One v1 (Jev decision support): per-slot evals.
 *
 * gbrain's System One lets a small decision model (TypeSafe Jev,
 * `typesafe:jev-1.13.0`) make nine yes/no or ranking calls inside gbrain:
 * rerank search results (S1), route queries (S2), prune evidence (S3), decide
 * whether a question is answerable (S4), flag prompt injection (S5), decide
 * whether a turn needs memory (S6), triage dream transcripts (S7), check that
 * a synthesized claim is supported (S8) and spot contradicting facts (S9).
 * Each slot is measured as a matched pair: the same gbrain commit, data and
 * seed, with only the slot's `--decide` mode different.
 *
 *   bun eval/runner/system-one-jev.ts [verify] [--output DIR]
 *       Hermetic gate. Recomputes every dataset hash and split hash, rebuilds the
 *       S7/S8 inputs from the Cat 35 corpus and checks them, recounts the S7
 *       pair and the LongMemEval arms from the committed rows, checks every
 *       number in verdicts.json against its receipt, and checks the
 *       definitions are matched pairs. No gbrain, key or network.
 *   bun eval/runner/system-one-jev.ts plan [--eval <id|slot>]
 *       Print every command an evaluation runs. Nothing executes.
 *   bun eval/runner/system-one-jev.ts build --gbrain <checkout>@<ref> [--longmemeval-s FILE] [--out DIR]
 *       Keyless: build the S7 and S8 datasets (and S3/S4 from LongMemEval-S) with
 *       `gbrain decide dataset` and check them against the frozen hashes.
 *   bun eval/runner/system-one-jev.ts analyze --gbrain <checkout>@<ref> --eval <id> [--values FILE] [--out DIR]
 *       Keyless: apply gbrain's production reducers to recorded Jev answers
 *       (the committed ones by default) and compare with the committed analysis.
 *   bun eval/runner/system-one-jev.ts run --gbrain <checkout>@<ref> --eval <id|slot> --yes [--arm NAME]
 *       [--out DIR] [--limit N] [--longmemeval-s FILE] [--longmemeval-m FILE]
 *       Paid: run the evaluation's arms against the checkout.
 *
 * The `--decide` flags, `--eval-pool-depth`, `gbrain decide judge-agreement`
 * and the dataset runners exist on gbrain feat/system-one-v1 (9196543d, v0.60.26.0) and
 * not yet at this repository's gbrain pin, so every command that executes
 * gbrain needs `--gbrain`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, scrubMachinePaths, sourceTreeIdentity, writeReceipt, type ProbeError } from './receipt.ts';
import {
  CAT35_DIR, DATA_DIR, REPO_ROOT, datasetStats, loadDatasets, mPilotIds, sha256, stageS7, stageS8, treeHash, type DatasetEntry,
} from './system-one/datasets.ts';
import { compareLeaves, loadLmeRows, pairedLme, readJsonl, recountAll, summarizeLme, summarizeTriage, triageFlips, type TriageRow } from './system-one/recount.ts';
import { EVALUATIONS, NOT_PORTED, evaluationsFor, resolveArgs, type Arm, type Evaluation } from './system-one/slots.ts';

export const CATEGORY = 'system-one-jev';
export const BENCH_DIR = join(REPO_ROOT, 'docs/benchmarks/2026-09-30-system-one-jev');
export const RECEIPTS_DIR = join(BENCH_DIR, 'receipts');
const UPSTREAM_RUNNERS = 'docs/eval/system-one/runners';
const PROVIDER = 'typesafe:jev-1.13.0';
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'JEV_TYPESAFE_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY'];

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

// ─── verify (hermetic) ─────────────────────────────────────────────

export interface Check { id: string; ok: boolean; detail: string }

function resolvePointer(doc: unknown, pointer: string): unknown {
  let node = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(token in (node as Record<string, unknown>))) throw new Error(`pointer ${pointer} not found`);
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

export function checkDatasets(scratch: string): Check[] {
  const file = loadDatasets();
  const checks: Check[] = [];
  const hashesMd = readFileSync(join(DATA_DIR, 'HASHES.md'), 'utf8');
  for (const entry of file.datasets) {
    if (Object.keys(entry.label_provenance).some(k => k.startsWith('human'))) checks.push({ id: `${entry.id}:provenance`, ok: false, detail: 'a human label source is declared; no dataset in this release has human labels' });
    if (entry.build === 'committed') {
      const s = datasetStats(readFileSync(join(DATA_DIR, entry.file), 'utf8'));
      const want = { dataset_hash16: entry.dataset_hash16, split_hash: entry.split_hash, items: entry.items, families: entry.families, calibrate: entry.calibrate, eval: entry.eval };
      const got = { dataset_hash16: s.dataset_hash16, split_hash: s.split_hash, items: s.items, families: s.families, calibrate: s.calibrate, eval: s.eval };
      const bad = compareLeaves(want, got);
      const marked = Object.keys(s.label_provenance).some(k => !k.startsWith('unmarked'));
      const provenanceBad = marked ? compareLeaves(entry.label_provenance, s.label_provenance) : [];
      checks.push({ id: `${entry.id}:hashes`, ok: bad.length === 0 && provenanceBad.length === 0, detail: [...bad, ...provenanceBad].join('; ') || `${s.dataset_hash16} ${s.split_hash}` });
    }
    if (entry.build !== 'external' && !hashesMd.includes(`\`${entry.file}\` | \`${entry.dataset_hash16}\` | \`${entry.split_hash}\``)) {
      checks.push({ id: `${entry.id}:hashes-md`, ok: false, detail: 'datasets.json disagrees with the upstream HASHES.md row' });
    }
  }
  const s7 = file.datasets.find(d => d.id === 's7-triage')!;
  const s7Tree = treeHash(stageS7(scratch));
  checks.push({ id: 's7-triage:staged-inputs', ok: s7Tree === s7.staged_tree_sha256, detail: `staged tree ${s7Tree.slice(0, 16)} from eval/data/transcript-distill-v1 + s7-triage-synthetic` });
  const s8 = file.datasets.find(d => d.id === 's8-grounding')!;
  const s8Tree = treeHash(stageS8(scratch).root);
  checks.push({ id: 's8-grounding:staged-inputs', ok: s8Tree === s8.staged_tree_sha256, detail: `staged tree ${s8Tree.slice(0, 16)} from eval/data/transcript-distill-v1 + s8-grounding/labels.jsonl` });
  for (const [path, want] of Object.entries(file.inputs)) {
    const got = path === 'longmemeval/m-pilot-28.txt (derived)' ? sha256(mPilotIds())
      : statSync(join(DATA_DIR, path)).isDirectory() ? treeHash(join(DATA_DIR, path))
        : sha256(readFileSync(join(DATA_DIR, path)));
    checks.push({ id: `input:${path}`, ok: got === want.sha256, detail: got.slice(0, 16) });
  }
  const cat35Synthetic = readdirSync(join(DATA_DIR, 's7-triage-synthetic/transcripts-txt')).sort().filter(f => existsSync(join(CAT35_DIR, 'transcripts-txt', f)));
  checks.push({ id: 'cat35-not-duplicated', ok: cat35Synthetic.length === 0, detail: cat35Synthetic.length ? `Cat 35 transcripts copied into system-one-v1: ${cat35Synthetic.join(', ')}` : 'Cat 35 transcripts are read from eval/data/transcript-distill-v1 only' });
  return checks;
}

export function checkReceipts(): Check[] {
  const checks: Check[] = [];
  const provenance = JSON.parse(readFileSync(join(BENCH_DIR, 'provenance.json'), 'utf8')) as { files: Record<string, { sha256: string }> };
  const drifted = Object.entries(provenance.files).filter(([rel, f]) => !existsSync(join(BENCH_DIR, rel)) || sha256(readFileSync(join(BENCH_DIR, rel))) !== f.sha256).map(([rel]) => rel);
  checks.push({ id: 'receipts:verbatim', ok: drifted.length === 0, detail: drifted.length ? `changed or missing: ${drifted.join(', ')}` : `${Object.keys(provenance.files).length} upstream files byte-identical` });
  const recount = recountAll(RECEIPTS_DIR, BENCH_DIR);
  checks.push({ id: 'recount:s7-triage-pair', ok: recount.s7.mismatches.length === 0, detail: recount.s7.mismatches.join('; ') || 's7/summary.json reproduced from the four arm files' });
  for (const l of recount.longmemeval) checks.push({ id: `recount:${l.summary}`, ok: l.mismatches.length === 0, detail: l.mismatches.join('; ') || `${l.arms.length} arms reproduced from committed rows` });
  checks.push({ id: 'recount:spend', ok: Math.abs(recount.spend.total_usd - 24.95) < 0.005, detail: `ledgers total $${recount.spend.total_usd.toFixed(2)} (eval $${recount.spend.eval_lane.usd.toFixed(2)}, datasets $${recount.spend.dataset_building.usd.toFixed(2)})` });
  const verdicts = JSON.parse(readFileSync(join(BENCH_DIR, 'verdicts.json'), 'utf8')) as { slots: { slot: string; numbers: { key: string; receipt: string; pointer: string; value: unknown }[] }[]; judge_agreement: { numbers: { key: string; receipt: string; pointer: string; value: unknown }[] } };
  const numbers = [...verdicts.slots.flatMap(s => s.numbers.map(n => ({ ...n, slot: s.slot }))), ...verdicts.judge_agreement.numbers.map(n => ({ ...n, slot: 'judge' }))];
  const wrong: string[] = [];
  for (const n of numbers) {
    try {
      const actual = resolvePointer(JSON.parse(readFileSync(join(RECEIPTS_DIR, n.receipt), 'utf8')), n.pointer);
      wrong.push(...compareLeaves(n.value, actual, `${n.slot}.${n.key}`));
    } catch (e) {
      wrong.push(`${n.slot}.${n.key}: ${(e as Error).message}`);
    }
  }
  checks.push({ id: 'verdicts:pointers', ok: wrong.length === 0, detail: wrong.join('; ') || `${numbers.length} numbers match their receipts` });
  const slotsCovered = new Set(verdicts.slots.map(s => s.slot));
  checks.push({ id: 'verdicts:all-slots', ok: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'].every(s => slotsCovered.has(s)), detail: [...slotsCovered].sort().join(' ') });
  return checks;
}

const STRIP_WITH_VALUE = new Set(['--decide', '--decide-threshold', '--decide-force-on', '--decide-calibration', '--decide-dataset', '--decide-provider', '--reranker', '--eval-pool-depth', '--arm']);

/** Arguments with the slot-under-test flags removed: what must be identical between paired arms. */
export function sharedArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (STRIP_WITH_VALUE.has(a)) { i++; continue; }
    if (a === '--search-pin' && args[i + 1]?.startsWith('search.reranker.top_n_in=')) { i++; continue; }
    if (a === '--expansion') continue;
    out.push(a);
  }
  return out;
}

/** Why an evaluation is not a set of matched pairs (empty when it is). */
export function pairProblems(e: Evaluation): string[] {
  const problems: string[] = [];
  const arms = e.arms ?? [];
  const slotOn = (args: readonly string[]) => args.some((a, i) => a === '--decide' && /=on$/.test(args[i + 1] ?? ''));
  const armValue = (args: readonly string[]) => (args.includes('--arm') ? args[args.indexOf('--arm') + 1] : undefined);
  if (e.method === 'recorded-answers') {
    if (!e.ask) problems.push('recorded-answers needs ask');
    if (arms.length) problems.push('recorded-answers asks once; it has no arms');
    return problems;
  }
  if (e.method === 'judge-agreement') return arms.length ? problems : ['judge-agreement needs an arm'];
  const offs = arms.filter(a => a.role === 'off');
  if (!offs.length) problems.push('no off arm');
  for (const off of offs) if (slotOn(off.args) || armValue(off.args) === 'on') problems.push(`${off.name}: an off arm turns a slot on`);
  for (const arm of arms.filter(a => a.role !== 'off')) {
    const isOn = slotOn(arm.args) || armValue(arm.args) === 'on';
    if (arm.role === 'on' && !isOn) problems.push(`${arm.name}: an on arm must set a --decide slot on`);
    if (!offs.some(off => JSON.stringify(sharedArgs(off.args)) === JSON.stringify(sharedArgs(arm.args)))) problems.push(`${arm.name}: no off arm with the same data and settings`);
  }
  return problems;
}

export function checkDefinitions(): Check[] {
  const known = new Set(loadDatasets().datasets.map(d => d.id));
  return EVALUATIONS.map(e => {
    const problems = pairProblems(e);
    for (const r of e.receipts) {
      const found = r.includes('*')
        ? readdirSync(join(RECEIPTS_DIR, dirname(r))).sort().some(f => new RegExp(`^${basename(r).replace(/\./g, '\\.').replace('*', '.*')}$`).test(f))
        : existsSync(join(RECEIPTS_DIR, r));
      if (!found) problems.push(`receipt ${r} missing`);
    }
    for (const d of e.datasets) if (!known.has(d)) problems.push(`unknown dataset ${d}`);
    return { id: `definition:${e.id}`, ok: problems.length === 0, detail: problems.join('; ') || `${e.method}, ${e.arms?.length ?? 'recorded'} arm(s)` };
  });
}

async function verify(argv: string[]): Promise<number> {
  const startedAt = new Date().toISOString();
  const outputDir = argValue(argv, '--output');
  const receiptFile = outputDir ? join(resolve(outputDir), 'receipt.json') : receiptPath(CATEGORY);
  const scratch = mkdtempSync(join(tmpdir(), 'system-one-verify-'));
  const errors: ProbeError[] = [];
  let checks: Check[] = [];
  try {
    checks = [...checkDatasets(scratch), ...checkReceipts(), ...checkDefinitions()];
  } catch (e) {
    errors.push({ probe_id: 'verify', origin: 'harness', message: e instanceof Error ? e.message : String(e) });
  }
  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  const verdict = errors.length || failed.length ? 'fail' : 'pass';
  console.log(`\nSystem One v1 record: ${checks.length - failed.length}/${checks.length} checks pass${errors.length ? `, harness error: ${errors[0]!.message}` : ''} -> ${verdict}`);
  writeReceipt(receiptFile, {
    ...noModelSpend('hermetic: hashes and recounts over committed files, no gbrain call'),
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: CATEGORY,
    run_status: errors.length ? 'error' : 'completed', ...(errors.length ? {} : { verdict }),
    n_total: checks.length, n_scored: checks.length, completion_rate: errors.length ? 0 : 1, errors, publishable: !errors.length,
    gbrain_version: 'not loaded (record check)', gbrain_pin: gbrainPin(), started_at: startedAt, finished_at: new Date().toISOString(),
    execution: { source_tree: sourceTreeIdentity(), product: { package: 'gbrain', declared_pin: null, declared_sha: null, version: null, package_sha256: null, loaded_git_head: null } },
    data: { checks, not_ported: NOT_PORTED },
  });
  console.log(`Receipt: ${receiptFile}`);
  return verdict === 'pass' && !errors.length ? 0 : 1;
}

// ─── plan / run against a gbrain checkout ──────────────────────────

interface RunContext { gut: GbrainUnderTest | null; out: string; data: string; built: string; lmeS?: string; lmeM?: string; limit?: number; s8root: string }

const BRAIN_HOMES = new Map<string, string>();

/** A throwaway brain outside every Git worktree (gbrain init refuses a content directory inside one), one per output directory. */
function brainHome(key: string): string {
  if (!BRAIN_HOMES.has(key)) BRAIN_HOMES.set(key, mkdtempSync(join(tmpdir(), 'system-one-gbhome-')));
  return BRAIN_HOMES.get(key)!;
}

function vars(ctx: RunContext, list?: string): Record<string, string> {
  return {
    S: ctx.lmeS ?? '<longmemeval_s_cleaned.json>', M: ctx.lmeM ?? '<longmemeval_m_pilot28.json>', data: ctx.data, built: ctx.built,
    receipts: RECEIPTS_DIR, out: ctx.out, list: list ?? '', s8root: ctx.s8root,
  };
}

function listFile(ctx: RunContext, name: NonNullable<Evaluation['question_list']>): string {
  const path = join(ctx.out, `${name}.txt`);
  mkdirSync(ctx.out, { recursive: true });
  const text = name === 'm-pilot-28' ? mPilotIds() : readFileSync(join(DATA_DIR, 'longmemeval', `${name}.txt`), 'utf8');
  writeFileSync(path, text);
  return path;
}

/** One command per arm (or per recorded-answer step), as argv for `bun`. */
export function commandsFor(e: Evaluation, ctx: RunContext): { name: string; argv: string[]; env: Record<string, string> }[] {
  const cli = ctx.gut ? join(ctx.gut.root, 'src/cli.ts') : '<gbrain>/src/cli.ts';
  const runner = (name: string) => (ctx.gut ? join(ctx.gut.root, UPSTREAM_RUNNERS, name) : `<gbrain>/${UPSTREAM_RUNNERS}/${name}`);
  const gbhome = ctx.gut ? brainHome(ctx.out) : '<scratch brain>';
  const limit = ctx.limit ? ['--limit', String(ctx.limit)] : [];
  const env = { GBRAIN_HOME: gbhome };
  const datasetFile = (id: string) => {
    const d = loadDatasets().datasets.find(x => x.id === id)!;
    return d.build === 'committed' ? join(ctx.data, d.file) : join(ctx.built, d.file);
  };
  switch (e.method) {
    case 'longmemeval': {
      const list = ctx.gut ? listFile(ctx, e.question_list!) : `<${e.question_list}.txt>`;
      const file = e.benchmark_file === 'M' ? '{M}' : '{S}';
      return (e.arms ?? []).map((arm: Arm) => ({
        name: arm.name,
        argv: [cli, 'eval', 'longmemeval', ...resolveArgs([file], vars(ctx)), ...e.common_args!, '--question-ids', list, '--embed-cache', join(ctx.out, `cache-${e.question_list}.sqlite`), ...resolveArgs(arm.args, vars(ctx)), ...limit, '--output', join(ctx.out, `${arm.name}.ndjson`)],
        env: { ...env, GBRAIN_EMBEDDING_MODEL: e.embedding_model!, GBRAIN_EMBEDDING_DIMENSIONS: '1536' },
      }));
    }
    case 'brainbench':
      return (e.arms ?? []).map(arm => ({ name: arm.name, argv: [cli, 'eval', 'brainbench', ...resolveArgs(arm.args, vars(ctx)), '--out', join(ctx.out, `${arm.name}.json`)], env }));
    case 'judge-agreement':
      return (e.arms ?? []).map(arm => ({ name: arm.name, argv: [cli, 'decide', 'judge-agreement', ...resolveArgs(arm.args, vars(ctx)), '--provider', PROVIDER, ...limit, '--out', join(ctx.out, `${arm.name}.json`)], env }));
    case 'triage-pair':
      return (e.arms ?? []).map(arm => ({ name: arm.name, argv: [runner('s7-triage-pair.ts'), '--dataset', join(ctx.out, 's7-triage.input.jsonl'), ...arm.args, '--out', join(ctx.out, `${arm.name}.jsonl`)], env }));
    case 'recorded-answers': {
      const dataset = datasetFile(e.datasets[0]!);
      const ask = { name: 'ask', argv: [runner('ask-dataset.ts'), '--slot', e.decide_slot, '--dataset', ctx.limit ? join(ctx.out, 'dataset.input.jsonl') : dataset, '--out', join(ctx.out, 'values.jsonl'), '--split', e.ask!.split, '--repeat', String(e.ask!.repeat)], env };
      const analyzers = (e.analyze ?? []).map((a, i) => ({ name: `analyze-${i + 1}`, argv: [runner(a.runner), ...resolveArgs(a.args, { ...vars(ctx), values: join(ctx.out, 'values.jsonl') })], env }));
      return [ask, ...analyzers];
    }
  }
}

function plan(argv: string[]): number {
  const which = argValue(argv, '--eval');
  const list = which ? evaluationsFor(which) : [...EVALUATIONS];
  if (!list.length) { console.error(`no evaluation matches ${which}`); return 2; }
  const ctx: RunContext = { gut: null, out: '<out>', data: 'eval/data/system-one-v1', built: '<out>/built', s8root: '<out>/built/s8-root' };
  for (const e of list) {
    console.log(`\n## ${e.id} (${e.slot} ${e.decide_slot}, ${e.method})\n${e.question}\nKeys: ${e.keys.join(', ')}. Observed on 2026-09-30: ${e.observed_cost}.`);
    if (e.calibrate) console.log(`  calibrate: bun <gbrain>/src/cli.ts decide calibrate ${resolveArgs(e.calibrate, vars(ctx)).join(' ')} --json`);
    for (const c of commandsFor(e, ctx)) console.log(`  ${c.name}: ${Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(' ')} bun ${c.argv.join(' ')}`);
    for (const n of e.notes ?? []) console.log(`  note: ${n}`);
  }
  if (!which) for (const n of NOT_PORTED) console.log(`\nNot ported: ${n.id}: ${n.reason}`);
  return 0;
}

function sh(argv: string[], env: Record<string, string>, opts: { cwd?: string; stripKeys?: boolean; log?: string } = {}): { status: number; stdout: string; stderr: string } {
  const base: Record<string, string | undefined> = { ...process.env };
  if (opts.stripKeys) for (const k of PROVIDER_KEYS) delete base[k];
  const r = spawnSync('bun', argv, { cwd: opts.cwd ?? REPO_ROOT, env: { ...base, ...env }, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (opts.log) writeFileSync(opts.log, `$ bun ${argv.join(' ')}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function initBrain(gut: GbrainUnderTest, home: string, config: Record<string, string>): void {
  if (existsSync(join(home, 'config.json'))) return;
  mkdirSync(home, { recursive: true });
  const cli = join(gut.root, 'src/cli.ts');
  const init = sh([cli, 'init', '--pglite', '--no-embedding'], { GBRAIN_HOME: home }, { stripKeys: true });
  if (init.status !== 0) throw new Error(`gbrain init failed: ${init.stderr.slice(-400)}`);
  for (const [k, v] of Object.entries(config)) {
    const r = sh([cli, 'config', 'set', k, v], { GBRAIN_HOME: home }, { stripKeys: true });
    if (r.status !== 0) throw new Error(`gbrain config set ${k} failed: ${r.stderr.slice(-400)}`);
  }
}

/** Build one dataset with `gbrain decide dataset` in a keyless scratch brain; returns its stats. */
function buildDataset(gut: GbrainUnderTest, entry: DatasetEntry, built: string, lmeS?: string): { file: string; ok: boolean; detail: string } {
  const cli = join(gut.root, 'src/cli.ts');
  const home = brainHome(built);
  initBrain(gut, home, {});
  const out = join(built, entry.file);
  let r;
  if (entry.id === 's7-triage') {
    r = sh([cli, 'decide', 'dataset', '--slot', 'triage', '--from', 'cat35', stageS7(built), '--out', out], { GBRAIN_HOME: home }, { stripKeys: true });
  } else if (entry.id === 's8-grounding') {
    const { root, labels } = stageS8(built);
    const raw = join(built, 's8.raw.jsonl');
    r = sh([cli, 'decide', 'dataset', '--slot', 'grounding', '--from', 'grounding-labels', 'docs/eval/system-one/datasets/s8-grounding/labels.jsonl', '--out', raw], { GBRAIN_HOME: home }, { stripKeys: true, cwd: root });
    if (r.status === 0) r = sh([join(gut.root, 'docs/eval/system-one/generators/label-source.ts'), raw, out, 'llm:claude-sonnet-5', labels], {}, { stripKeys: true });
  } else if (entry.build === 'external') {
    if (!lmeS) return { file: out, ok: false, detail: 'skipped: pass --longmemeval-s <longmemeval_s_cleaned.json>' };
    const fileSha = sha256(readFileSync(lmeS));
    if (fileSha !== entry.source!.sha256) return { file: out, ok: false, detail: `LongMemEval-S sha256 ${fileSha.slice(0, 16)} is not the expected ${entry.source!.sha256.slice(0, 16)}` };
    r = sh([cli, 'decide', 'dataset', '--slot', entry.slot, '--from', 'longmemeval', lmeS, '--out', out], { GBRAIN_HOME: home }, { stripKeys: true });
  } else {
    return { file: join(DATA_DIR, entry.file), ok: true, detail: 'committed' };
  }
  if (r.status !== 0) return { file: out, ok: false, detail: `builder failed: ${r.stderr.slice(-400)}` };
  const s = datasetStats(readFileSync(out, 'utf8'));
  const ok = s.dataset_hash16 === entry.dataset_hash16 && s.split_hash === entry.split_hash;
  return { file: out, ok, detail: `${s.dataset_hash16} ${s.split_hash} (frozen ${entry.dataset_hash16} ${entry.split_hash})` };
}

/** JSON for files a reader may commit: machine paths and the local gbrain checkout path removed. */
function shareableJson(gut: GbrainUnderTest, value: unknown): string {
  const text = JSON.stringify(scrubMachinePaths(value), null, 2);
  return `${gut.overlay ? text.split(gut.overlay.checkout).join('<gbrain checkout>') : text}\n`;
}

function requireGbrain(argv: string[]): GbrainUnderTest {
  const spec = gbrainSpecFrom(argv);
  if (!spec) throw new Error('this command executes gbrain: pass --gbrain <checkout>@<ref> (a checkout of garrytan/gbrain feat/system-one-v1 or later)');
  const gut = resolveGbrainUnderTest(spec);
  if (!existsSync(join(gut.root, UPSTREAM_RUNNERS, 'ask-dataset.ts'))) throw new Error(`gbrain ${gut.version} at ${gut.root} has no ${UPSTREAM_RUNNERS}; use feat/system-one-v1 (9196543d) or a later System One build`);
  return gut;
}

function build(argv: string[]): number {
  const gut = requireGbrain(argv);
  const out = resolve(argValue(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/system-one-jev/built'));
  mkdirSync(out, { recursive: true });
  const lmeS = argValue(argv, '--longmemeval-s');
  const results = loadDatasets().datasets.filter(d => d.build !== 'committed').map(d => ({ id: d.id, ...buildDataset(gut, d, out, lmeS) }));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : r.detail.startsWith('skipped') ? 'skip' : 'FAIL'} ${r.id}: ${r.detail}`);
  writeFileSync(join(out, 'build.json'), shareableJson(gut, { gbrain: overlaySummary(gut), version: gut.version, results }));
  return results.some(r => !r.ok && !r.detail.startsWith('skipped')) ? 1 : 0;
}

/** The committed analysis file each analyzer step reproduces, in order. */
const ANALYSIS_RECEIPTS: Record<string, string[]> = {
  's2-intent-routing': ['s2/analysis.json'],
  's6-recall-needed-values': ['s6/analysis-0.10.json', 's6/analysis-0.05.json'],
  's8-grounding-values': ['s8/analysis.json'],
  's9-conflict-values': ['s9/analysis-cal.json', 's9/analysis-cal--eligible-only.json'],
};

function analyze(argv: string[]): number {
  const id = argValue(argv, '--eval');
  const e = id ? EVALUATIONS.find(x => x.id === id) : undefined;
  if (!e?.analyze) { console.error(`analyze needs --eval with an analyzer: ${Object.keys(ANALYSIS_RECEIPTS).join(', ')}`); return 2; }
  const gut = requireGbrain(argv);
  const out = resolve(argValue(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/system-one-jev', e.id));
  mkdirSync(out, { recursive: true });
  const built = join(out, 'built');
  if (e.datasets.some(d => loadDatasets().datasets.find(x => x.id === d)?.build === 'rebuilt')) {
    for (const d of e.datasets) {
      const entry = loadDatasets().datasets.find(x => x.id === d)!;
      if (entry.build !== 'rebuilt') continue;
      const r = buildDataset(gut, entry, built);
      if (!r.ok) { console.error(`build ${d}: ${r.detail}`); return 1; }
    }
  }
  const valuesArg = argValue(argv, '--values');
  const values = resolve(valuesArg ?? join(RECEIPTS_DIR, e.receipts.find(r => r.endsWith('values.jsonl'))!));
  const ctx: RunContext = { gut, out, data: DATA_DIR, built, s8root: join(built, 's8-root') };
  let failed = 0;
  e.analyze.forEach((a, i) => {
    const r = sh([join(gut.root, UPSTREAM_RUNNERS, a.runner), ...resolveArgs(a.args, { ...vars(ctx), values })], {}, { stripKeys: true });
    const file = join(out, `analysis-${i + 1}.json`);
    writeFileSync(file, r.stdout);
    if (r.status !== 0) { failed++; console.error(`FAIL ${a.runner}: ${r.stderr.slice(-400)}`); return; }
    if (valuesArg) { console.log(`wrote ${file}`); return; }
    const expected = JSON.parse(readFileSync(join(RECEIPTS_DIR, ANALYSIS_RECEIPTS[e.id]![i]!), 'utf8'));
    const diff = compareLeaves(expected, JSON.parse(r.stdout));
    if (diff.length) failed++;
    console.log(`${diff.length ? 'FAIL' : 'ok  '} ${a.runner} ${a.args.filter(x => x.startsWith('--') && !['--values', '--dataset'].includes(x)).join(' ')} vs ${ANALYSIS_RECEIPTS[e.id]![i]}${diff.length ? `: ${diff.slice(0, 5).join('; ')}` : ': reproduced'}`);
  });
  return failed ? 1 : 0;
}

function subsetDataset(src: string, dst: string, limit: number, splitOnly?: 'eval'): void {
  const lines = readFileSync(src, 'utf8').split('\n').filter(l => l.trim());
  const keepFamilies = new Set<string>();
  for (const l of lines) {
    const item = JSON.parse(l) as { family: string; split: string };
    if (splitOnly && item.split !== splitOnly) continue;
    if (keepFamilies.size < limit) keepFamilies.add(item.family);
  }
  writeFileSync(dst, `${lines.filter(l => keepFamilies.has((JSON.parse(l) as { family: string }).family)).join('\n')}\n`);
}

function summarizeRun(e: Evaluation, out: string, ran: string[]): Record<string, unknown> | null {
  if (e.method === 'longmemeval') {
    const off = (e.arms ?? []).find(a => a.role === 'off')!.name;
    const rows = Object.fromEntries(ran.filter(n => existsSync(join(out, `${n}.ndjson`))).map(n => [n, loadLmeRows(join(out, `${n}.ndjson`))]));
    if (!rows[off]) return Object.fromEntries(Object.entries(rows).map(([n, r]) => [n, summarizeLme(r)]));
    return Object.fromEntries(Object.entries(rows).map(([n, r]) => [n, n === off ? summarizeLme(r) : { ...summarizeLme(r), [`vs_${off}`]: { recall_all: pairedLme(rows[off]!, r, 'recall_all'), 'R@1': pairedLme(rows[off]!, r, 'R@1') } }]));
  }
  if (e.method === 'triage-pair') {
    const load = (n: string) => (existsSync(join(out, `${n}.jsonl`)) ? readJsonl<TriageRow>(join(out, `${n}.jsonl`)) : null);
    const [a, b, a2, b2] = ['arm-off-1', 'arm-on-1', 'arm-off-2', 'arm-on-2'].map(load);
    return { a: a && summarizeTriage(a), b: b && summarizeTriage(b), retest: { a: a && a2 ? triageFlips(a, a2) : null, b: b && b2 ? triageFlips(b, b2) : null } };
  }
  return null;
}

function run(argv: string[]): number {
  const which = argValue(argv, '--eval');
  if (!which) { console.error('run needs --eval <id|slot>; see `plan`'); return 2; }
  const evals = evaluationsFor(which);
  if (!evals.length) { console.error(`no evaluation matches ${which}`); return 2; }
  if (!argv.includes('--yes')) { console.error('run makes paid provider calls; review `plan --eval ...` and pass --yes'); return 2; }
  const gut = requireGbrain(argv);
  const limitArg = argValue(argv, '--limit');
  const onlyArm = argValue(argv, '--arm');
  let failures = 0;
  for (const e of evals) {
    const missing = e.keys.filter(k => !(process.env[k] || (k === 'JEV_TYPESAFE_API_KEY' && process.env.TYPESAFE_API_KEY)));
    if (missing.length) { console.error(`${e.id}: missing ${missing.join(', ')}; not run`); failures++; continue; }
    const out = resolve(argValue(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/system-one-jev', e.id));
    const built = join(out, 'built');
    mkdirSync(out, { recursive: true });
    const ctx: RunContext = { gut, out, data: DATA_DIR, built, lmeS: argValue(argv, '--longmemeval-s'), lmeM: argValue(argv, '--longmemeval-m'), limit: limitArg ? Number(limitArg) : undefined, s8root: join(built, 's8-root') };
    if (e.method === 'longmemeval' && !(e.benchmark_file === 'M' ? ctx.lmeM : ctx.lmeS)) { console.error(`${e.id}: pass --longmemeval-${e.benchmark_file === 'M' ? 'm' : 's'} <file>`); failures++; continue; }
    for (const d of e.datasets) {
      const entry = loadDatasets().datasets.find(x => x.id === d)!;
      if (entry.build === 'committed') continue;
      const r = buildDataset(gut, entry, built, ctx.lmeS);
      if (!r.ok) { console.error(`${e.id}: dataset ${d}: ${r.detail}`); failures++; }
    }
    initBrain(gut, brainHome(out), { 'decide.provider': PROVIDER, 'decide.egress.private': 'allow' });
    if (e.method === 'triage-pair') {
      const src = join(built, 's7-triage.jsonl');
      if (ctx.limit) subsetDataset(src, join(out, 's7-triage.input.jsonl'), ctx.limit, 'eval');
      else writeFileSync(join(out, 's7-triage.input.jsonl'), readFileSync(src));
      const enable = sh([join(gut.root, 'src/cli.ts'), 'decide', 'enable', 'triage', '--yes'], { GBRAIN_HOME: brainHome(out) }, { log: join(out, 'enable-triage.log') });
      if (enable.status !== 0) { console.error(`${e.id}: gbrain decide enable triage failed (see enable-triage.log)`); failures++; continue; }
    }
    if (e.method === 'recorded-answers' && ctx.limit) {
      const entry = loadDatasets().datasets.find(x => x.id === e.datasets[0])!;
      subsetDataset(entry.build === 'committed' ? join(DATA_DIR, entry.file) : join(built, entry.file), join(out, 'dataset.input.jsonl'), ctx.limit);
    }
    const startedAt = new Date().toISOString();
    const steps = commandsFor(e, ctx).filter(c => !onlyArm || c.name === onlyArm);
    const ran: { name: string; status: number; seconds: number }[] = [];
    for (const c of steps) {
      const t0 = performance.now();
      console.error(`[${e.id}] ${c.name} ...`);
      const r = sh(c.argv, c.env, { log: join(out, `${c.name}.log`) });
      if (c.name.startsWith('analyze')) writeFileSync(join(out, `${c.name}.json`), r.stdout);
      ran.push({ name: c.name, status: r.status, seconds: Math.round((performance.now() - t0) / 1000) });
      if (r.status !== 0) { failures++; console.error(`[${e.id}] ${c.name} exited ${r.status} (see ${c.name}.log)`); }
    }
    const summary = summarizeRun(e, out, [...(e.arms ?? []).map(a => a.name)]);
    if (summary) writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const runFile = join(out, onlyArm ? `run-${onlyArm}.json` : 'run.json');
    writeFileSync(runFile, shareableJson(gut, {
      category: CATEGORY, evaluation: e.id, slot: e.slot, decide_slot: e.decide_slot, provider: PROVIDER, started_at: startedAt, finished_at: new Date().toISOString(),
      limit: ctx.limit ?? null, smoke: !!ctx.limit, gbrain: overlaySummary(gut), product: productIdentityFor(gut), steps: ran,
      note: ctx.limit ? `smoke run on the first ${ctx.limit} families or questions; not comparable with the published full-run numbers` : 'full run',
    }));
    console.log(`[${e.id}] wrote ${runFile}${summary ? ' and summary.json' : ''}`);
  }
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'verify';
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const code = command === 'verify' ? await verify(rest)
    : command === 'plan' ? plan(rest)
      : command === 'build' ? build(rest)
        : command === 'analyze' ? analyze(rest)
          : command === 'run' ? run(rest)
            : (console.error(`unknown command ${command}: verify | plan | build | analyze | run`), 2);
  process.exit(code);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

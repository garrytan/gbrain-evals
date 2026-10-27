#!/usr/bin/env bun
/**
 * Assemble the Q1 scoreboard receipt that `eval/runner/scoreboard.ts render` reads, from the campaigns' pulled
 * state. It lives outside every campaign's hashed tree.
 *
 *   bun eval/runner/q1/publish.ts --config docs/benchmarks/2026-10-06-scoreboard/publication.json \
 *     --results <dir holding each campaign's state directory, by campaign id> --out <receipt dir> [--trees <dir>]
 *     [--custody] [--frontier-redo <judgments file, or a directory searched recursively for .ndjson>]...
 *
 * For every source in the config it:
 *   1. checks out the campaign's launch tree (a detached worktree under --trees), because each campaign renders
 *      from its launch tree;
 *   2. merges each cell's settled leases there (`eval/runner/q1/cell.ts merge`), which rewrites the cell's rows,
 *      answers, judgments and receipt from the leases' staging; a shard that wrote no receipt (a stalled ingest)
 *      adds no rows, so its questions count as unscored, and a cell with no such shard is listed as not run;
 *   3. copies each answering arm into the receipt: `cells/<arm cell id>/`, or under `appendix/` for a source the
 *      config publishes only in an appendix (the found-and-fixed rows).
 *
 * campaign.json then lists every answering arm of the generated cell manifest. An arm no source covers is
 * `not-run` with the config's reason (the sealed waves until they settle). Sets take their scheduled questions
 * from the public corpus where the corpus is public (LoCoMo, LongMemEval); a set on sealed data is scheduled
 * empty, with its preregistered exclusions withheld, until the custodian assembles it on the custodian's host.
 * Families follow the preregistration: F1 the S1 8k component rows, F2 the S1 whole-system rows, F3 strict recall
 * on F1's rows. The config's sensitivity views (A21) and disclosures are copied in. --preview writes no render target
 * (the README block) and opens the disclosures with a public-results-only line.
 *
 * A retired system (A24 option 1: its pinned configuration calls a model its provider retired) is published where it
 * ran validly: its subset cell merges only the subset's shards and every arm of it is shown on their conversations,
 * every set those arms answer on gets a sensitivity view on the same conversations for every system, and every other
 * cell of the system that no source covers is not run with the retirement reason.
 *
 * A source on a campaign that ran under several freezes lists `states`: each state directory (under --results) and
 * the launch units whose final rows it holds; every cell merges once, from all its units' states, at the source's
 * launch tree. `not_run` names cells (definition or arm id) published as not run with their own reason, whatever
 * rows they hold. `product_outcomes` counts a cell reader's recorded outcome as the product's failure when the
 * system's own path flagged it. A sensitivity view may name `from_outcomes` instead of question ids: its questions
 * are those with an answer of those outcomes in that cell's arms (or that one arm), counted against `count`. --custody (the custodian's
 * host, GBRAIN_EVALS_CUSTODY_LOG set) schedules the sealed sets from their corpora. --frontier-redo adds A19's Opus
 * redo judgments: each arm gets the records for its own answers in frontier-redo.ndjson, which the scoreboard uses in
 * place of the logged error under the same key.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { loadSplit } from '../decisions/splits.ts';
import { loadCorpus } from '../memory-qa/corpus.ts';
import type { AppendixCell, CampaignCell, CampaignFamily, CampaignManifest, CampaignSet, PinEntry } from '../scoreboard.ts';
import { scoreboardCampaignCell, selectCellQuestions, splitConversations } from './cell.ts';
import { loadManifest, type ArmDefinition, type CellDefinition } from './cells/definitions.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const PUBLIC_CORPUS = new Set(['locomo', 'lme-s', 'lme-m']);
const PREVIEW_DISCLOSURE = 'Preview from public results only: every sealed cell is pending, so no headline comparison is made.';

export interface PublicationSource {
  /** Campaign manifest path in this repository, and the launch commit its cells render from. */
  campaign: string; launch_tree: string;
  /** Only these systems, or every system but these. */
  systems?: string[]; exclude_systems?: string[];
  /** The build label each system's cells carry (CampaignCell.pin); never gbrain-defaults, whose label comes from `gbrain`. */
  pins?: Record<string, string>;
  /** The GBrain build this source measured, when it is not the publication's (an appendix of an older pin). */
  gbrain?: GbrainBuild;
  /** Publish this source's arms only in an appendix: its name, why, and the directory under appendix/. */
  appendix?: { name: string; reason: string; dir: string };
  /** State directories under --results (default: the campaign id) and the launch units whose final rows each holds. */
  states?: Array<{ dir: string; units: string[] }>;
}
/** A sensitivity view: fixed question ids, or the questions with an answer of these outcomes in one cell's answering arms. */
export interface PublicationView { sets: string[]; id: string; label: string; reason: string; question_ids: string[]; from_outcomes?: { cell: string; outcomes: string[]; count: number } }
export interface Publication {
  campaign_id: string; campaign_hash: string;
  /** Where the full receipt is published: a path on the results branch, the branch commit that holds it, and the
   * sha256 of its SHA256SUMS file (every file's sha256, sorted by path). Filled when the receipt is pushed. */
  /** aggregates_only: the receipt stays in custody, and the public tables link to the render target on main instead of the results branch. */
  published: { branch: string; path: string; url: string; commit: string | null; sha256: string | null; aggregates_only?: boolean };
  /** The GBrain build the main rows measured, and the footnote every rendering of them carries. */
  gbrain: CampaignManifest['gbrain'] & { footnote: string };
  hedge_classifier: string;
  statistics: CampaignManifest['statistics'];
  /** Campaigns still running: an arm with no source whose unit one of them schedules is not run with that reason. */
  pending: Array<{ campaign: string; reason: string }>;
  /** Why any other arm with no source is not run. */
  not_run_reason: string;
  sources: PublicationSource[];
  sensitivity: PublicationView[];
  /** Cells (definition or arm id) published as not run, whatever rows they hold, with their own reason. */
  not_run: Record<string, string>;
  /** A cell reader's recorded outcome counted as the product's own failure (score 0), with the expected count and why. */
  product_outcomes: Array<{ cell: string; reader: string; outcome: string; count: number; reason: string }>;
  /** Systems whose pinned configuration can no longer run: the sharded cell and shards they ran validly, and the sensitivity view every system gets on those conversations. */
  retired: Array<{ system: string; reason: string; subset: { cell: string; shards: number[]; label: string; reason: string }; view: { id: string; label: string; reason: string } }>;
  /** Build labels for the baselines (gbrain-defaults takes its label from `gbrain`); external kinds take theirs from the pin table. */
  pins: Record<string, string>;
  disclosures: string[];
  render_targets: string[];
}

type GbrainBuild = Pick<CampaignManifest['gbrain'], 'commit' | 'version' | 'date'>;

/** Every GBrain row's build label: "GBrain 0.60.138.0 (f05943e6, 2026-10-09)". The scoreboard refuses a GBrain row without one (GBRAIN_BUILD). */
export function gbrainBuildLabel(g: GbrainBuild): string { return `GBrain ${g.version} (${g.commit.slice(0, 8)}, ${g.date})`; }

interface LeaseEvent { event: string; lease_id: string; cell?: string; at: string }

/** The last settled lease of each launch unit in a campaign state (a resumed unit's last lease carries its checkpoint forward). */
export function settledLeases(state: string): Map<string, { lease: string; at: string }> {
  const events = readFileSync(join(state, 'leases.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LeaseEvent);
  const unitOf = new Map(events.filter(e => e.event === 'reserved').map(e => [e.lease_id, e.cell!]));
  const out = new Map<string, { lease: string; at: string }>();
  for (const e of events.filter(x => x.event === 'settled')) {
    const unit = unitOf.get(e.lease_id);
    if (unit) out.set(unit, { lease: e.lease_id, at: e.at });
  }
  return out;
}

/** Each external kind's build label at a tree, from the pin table in docs/comparison-systems.md (bundle lockfile and capability record), so no product name enters the report. */
export function bundlePins(root: string): Record<string, string> {
  const text = readFileSync(join(root, 'docs/comparison-systems.md'), 'utf8');
  const fence = /```json\n([\s\S]*?)\n```/.exec(text.slice(text.indexOf('machine-readable pin table')));
  if (!fence) throw new Error('docs/comparison-systems.md has no machine-readable pin table');
  return Object.fromEntries((JSON.parse(fence[1]) as PinEntry[]).map(p => [p.kind, `bundle ${[p.lock_sha256 && `lock ${p.lock_sha256.slice(0, 8)}`, p.capability_sha256 && `capabilities ${p.capability_sha256.slice(0, 8)}`].filter(Boolean).join(', ')}`]));
}

function launchTree(commit: string, trees: string): string {
  const dir = join(trees, commit);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', dir, commit], { stdio: 'ignore' });
  }
  if (!existsSync(join(dir, 'node_modules'))) symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

const answering = (a: ArmDefinition) => a.readers.length > 0;
export const unitCell = (unit: string, cells: CellDefinition[]) => cells.find(c => unit === c.id || (unit.startsWith(c.id) && /^\.c\d+$/.test(unit.slice(c.id.length))));
const covers = (s: PublicationSource, system: string) => (!s.systems || s.systems.includes(system)) && !(s.exclude_systems ?? []).includes(system);

/** The conversations a sharded cell's shards run: the split's conversations sorted, shard i taking each one whose index is i modulo the shard count (cell.ts runCell). */
export function shardConversations(def: Pick<CellDefinition, 'benchmark' | 'split' | 'shards'>, shards: number[]): string[] {
  const s = loadSplit(def.benchmark);
  const ids = def.split === 'dev' ? s.dev : def.split === 'sealed' ? s.sealed : [...s.dev, ...s.sealed];
  return [...ids].sort().filter((_, i) => shards.includes(i % def.shards));
}

export interface AssembleOptions { preview?: boolean; custody?: boolean; frontierRedo?: string[] }

/**
 * The A19 frontier redo judgments from files or directories, searched recursively for .ndjson files (the backfill
 * writes <unit>/<lease>/<cell>/judgments.ndjson). Refuses when nothing loads or a record is not a judgment.
 */
export function loadFrontierRedo(paths: string[]): string[] {
  const files: string[] = [];
  const walk = (p: string) => { if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e)); else if (p.endsWith('.ndjson')) files.push(p); };
  for (const p of paths) walk(p);
  const lines = files.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
    const j = JSON.parse(l) as Record<string, unknown>;
    if (typeof j.answer_id !== 'string' || typeof j.instrument_id !== 'string' || typeof j.judge !== 'string' || typeof j.judge_replicate !== 'number') throw new Error(`--frontier-redo ${f}: a record is not a judgment (answer_id, instrument_id, judge, judge_replicate)`);
    return l;
  }));
  if (!lines.length) throw new Error(`--frontier-redo found 0 judgment records in ${files.length} .ndjson file(s) under ${paths.join(', ')}`);
  return lines;
}

export function assemble(config: Publication, results: string, out: string, trees: string, opts: AssembleOptions = {}): CampaignManifest {
  const preview = !!opts.preview;
  if (opts.custody && !process.env.GBRAIN_EVALS_CUSTODY_LOG) throw new Error('--custody schedules the sealed sets from their corpora; set GBRAIN_EVALS_CUSTODY_LOG on the custodian host');
  const m = loadManifest();
  for (const p of [config.pins, ...config.sources.map(s => s.pins ?? {})]) if (p['gbrain-defaults']) throw new Error('publication.json writes a gbrain-defaults pin by hand; the GBrain label comes from its gbrain build (publish.ts gbrainBuildLabel)');
  const label = gbrainBuildLabel(config.gbrain);
  const retired = config.retired.map(r => {
    const def = m.cells.find(c => c.id === r.subset.cell);
    if (!def || def.system !== r.system || def.shards < 2) throw new Error(`publication.json retires ${r.system} on ${r.subset.cell}, which is not a sharded cell of that system`);
    return { ...r, def, sets: [...new Set(def.arms.filter(answering).map(a => a.set))], conversations: shardConversations(def, r.subset.shards) };
  });
  const outsideSubset = (unit: string, def: CellDefinition) => retired.some(r => r.system === def.system && (r.def !== def || !r.subset.shards.includes(Number(unit.slice(def.id.length + 2)))));
  const ownReason = (def: CellDefinition, arm?: ArmDefinition) => (arm && config.not_run[arm.cell_id]) ?? config.not_run[def.id] ?? null;
  for (const id of Object.keys(config.not_run)) if (!m.cells.some(c => c.id === id || c.arms.some(a => a.cell_id === id))) throw new Error(`publication.json not_run names ${id}, which is no cell or arm`);
  const pins: Record<string, string> = { ...bundlePins(REPO_ROOT), ...config.pins, 'gbrain-defaults': label };
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const covered = new Map<string, Pick<CampaignCell, 'status' | 'config_sha256' | 'pin'>>();
  const appendix: AppendixCell[] = [];
  const seen: string[] = [];
  for (const [i, src] of config.sources.entries()) {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, src.campaign), 'utf8')) as { campaign_id: string };
    const byCell = new Map<CellDefinition, string[]>();
    const taken = new Set<string>();
    for (const st of src.states ?? [{ dir: manifest.campaign_id, units: null as string[] | null }]) {
      const state = join(results, st.dir);
      const leases = settledLeases(state);
      for (const unit of st.units ?? []) if (!leases.has(unit)) throw new Error(`state ${st.dir} has no settled lease for ${unit}, which publication.json says holds its final rows`);
      for (const [unit, l] of leases) {
        if (st.units && !st.units.includes(unit)) continue;
        const def = unitCell(unit, m.cells);
        if (!def || !covers(src, def.system) || outsideSubset(unit, def) || ownReason(def)) continue;
        if (taken.has(unit)) throw new Error(`${unit} is listed under two states`);
        taken.add(unit);
        seen.push(l.at);
        byCell.set(def, [...(byCell.get(def) ?? []), join(state, 'results', unit, l.lease)]);
      }
    }
    const tree = launchTree(src.launch_tree, trees);
    const treePins: Record<string, string> = { ...bundlePins(tree), ...config.pins, 'gbrain-defaults': src.gbrain ? gbrainBuildLabel(src.gbrain) : label };
    for (const [def, leaseDirs] of byCell) {
      const from = leaseDirs.filter(d => existsSync(join(d, 'cells', def.arms[0].cell_id, 'receipt.json')));
      if (!from.length) {
        for (const arm of def.arms.filter(answering)) {
          const pin = src.pins?.[def.system] ?? treePins[def.system];
          const entry = { status: 'not-run' as const, not_run_reason: `no shard wrote a receipt (${leaseDirs.length} settled)`, config_sha256: '', ...(pin ? { pin } : {}) };
          if (src.appendix) appendix.push({ ...scoreboardCampaignCell(def, arm, { status: 'complete', config_sha256: '' }), ...entry, pin: pin ?? 'unlabeled build', dir: join('appendix', src.appendix.dir, arm.cell_id), appendix: src.appendix.name, reason: src.appendix.reason });
        }
        continue;
      }
      const staged = join(trees, 'merged', String(i), def.id);
      rmSync(staged, { recursive: true, force: true });
      const r = spawnSync(process.execPath, ['eval/runner/q1/cell.ts', 'merge', '--cell', def.id, ...from.flatMap(f => ['--from', f]), '--out', staged], { cwd: tree, encoding: 'utf8', maxBuffer: 1 << 28 });
      if (r.status !== 0 && r.status !== 4) throw new Error(`merge of ${def.id} at ${src.launch_tree} exited ${r.status}: ${(r.stderr || r.stdout).slice(-600)}`);
      for (const arm of def.arms.filter(answering)) {
        const from = join(staged, 'cells', arm.cell_id);
        if (!existsSync(join(from, 'receipt.json')) || ownReason(def, arm)) continue;
        const receipt = JSON.parse(readFileSync(join(from, 'receipt.json'), 'utf8')) as { run_status: string; config_sha256: string };
        const pin = src.pins?.[def.system] ?? treePins[def.system];
        const entry = { status: receipt.run_status === 'invalid' ? 'invalid' as const : 'complete' as const, config_sha256: receipt.config_sha256, ...(pin ? { pin } : {}) };
        if (src.appendix) {
          const dir = join('appendix', src.appendix.dir, arm.cell_id);
          cpSync(from, join(out, dir), { recursive: true });
          appendix.push({ ...scoreboardCampaignCell(def, arm, entry), ...entry, pin: pin ?? 'unlabeled build', dir, appendix: src.appendix.name, reason: src.appendix.reason });
          continue;
        }
        if (covered.has(arm.cell_id)) throw new Error(`${arm.cell_id} is covered by two main sources; publish one of them in an appendix`);
        cpSync(from, join(out, 'cells', arm.cell_id), { recursive: true });
        covered.set(arm.cell_id, entry);
      }
    }
  }

  const derivedViews = new Map(config.sensitivity.filter(v => v.from_outcomes).map(v => {
    const f = v.from_outcomes!;
    const def = m.cells.find(c => c.id === f.cell || c.arms.some(a => a.cell_id === f.cell));
    if (!def) throw new Error(`sensitivity ${v.id} derives from ${f.cell}, which is no cell or arm`);
    const hits = def.arms.filter(a => answering(a) && (def.id === f.cell || a.cell_id === f.cell)).map(a => join(out, 'cells', a.cell_id, 'answers.ndjson')).filter(p => existsSync(p))
      .flatMap(p => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { question_id: string; outcome: string }))
      .filter(a => f.outcomes.includes(a.outcome));
    if (preview) return [v.id, new Set<string>()] as const;
    if (hits.length !== f.count) throw new Error(`sensitivity ${v.id}: ${f.cell} holds ${hits.length} answers recorded ${f.outcomes.join('/')}, publication.json expects ${f.count}`);
    return [v.id, new Set(hits.map(a => a.question_id))] as const;
  }));
  const productOutcomes = new Map<string, NonNullable<CampaignCell['product_outcomes']>>();
  for (const p of config.product_outcomes) productOutcomes.set(p.cell, [...(productOutcomes.get(p.cell) ?? []), { reader: p.reader, outcome: p.outcome as 'harness_invalid', count: p.count, reason: p.reason }]);
  if (!preview) for (const id of productOutcomes.keys()) if (!covered.has(id)) throw new Error(`publication.json product_outcomes names ${id}, which no source covers`);
  const redo = opts.frontierRedo?.length ? loadFrontierRedo(opts.frontierRedo) : [];
  if (redo.length) for (const id of covered.keys()) {
    const answers = join(out, 'cells', id, 'answers.ndjson');
    const own = new Set(readFileSync(answers, 'utf8').split('\n').filter(Boolean).map(l => (JSON.parse(l) as { answer_id: string }).answer_id));
    const mine = redo.filter(l => own.has((JSON.parse(l) as { answer_id: string }).answer_id));
    if (mine.length) writeFileSync(join(out, 'cells', id, 'frontier-redo.ndjson'), mine.join('\n') + '\n');
  }
  const sets: CampaignSet[] = [...new Set(m.cells.flatMap(c => c.arms.filter(answering).map(a => a.set)))].map(id => m.sets.find(s => s.id === id)!).filter(s => s.role !== 'smoke').map(s => {
    const open = PUBLIC_CORPUS.has(s.benchmark) || !!opts.custody;
    let scheduled: CampaignSet['scheduled'] = [];
    if (open) {
      const corpus = loadCorpus(s.benchmark);
      const inSplit = splitConversations(s.benchmark, s.split, corpus);
      scheduled = selectCellQuestions(corpus.questions.filter(q => inSplit.has(q.conversation)), s.selection).map(q => ({ question_id: q.id, conversation: q.conversation }));
    }
    const ids = new Set(scheduled.map(q => q.question_id));
    const views = [
      ...config.sensitivity.filter(v => v.sets.includes(s.id)).map(v => ({ id: v.id, label: v.label, reason: v.reason, question_ids: [...(v.from_outcomes ? derivedViews.get(v.id)! : v.question_ids)].filter(q => ids.has(q)) })),
      ...retired.filter(r => r.sets.includes(s.id)).map(r => ({ ...r.view, question_ids: [], conversations: r.conversations })),
    ];
    return {
      id: s.id, label: s.label, benchmark: s.benchmark, exposure: s.exposure as CampaignSet['exposure'], role: s.role as CampaignSet['role'],
      cluster_unit: s.benchmark.startsWith('lme') ? 'question' as const : 'conversation' as const, claim_min_clusters: s.role === 'headline' ? 9 : 0,
      scheduled, exclusions: open ? s.exclusions : [], ...(views.length ? { sensitivity: views } : {}), ...(PUBLIC_CORPUS.has(s.benchmark) ? {} : { sealed: true }),
    };
  });

  const pending = config.pending.map(p => ({ reason: p.reason, units: (JSON.parse(readFileSync(resolve(REPO_ROOT, p.campaign), 'utf8')) as { cells: Array<{ id: string }> }).cells.map(u => u.id) }));
  const cells: CampaignCell[] = m.cells.flatMap(def => def.arms.filter(answering).map(arm => {
    const c = covered.get(arm.cell_id);
    const r = retired.find(x => x.system === def.system);
    const subset = r?.def === def ? { conversations: r.conversations, label: r.subset.label, reason: r.subset.reason } : null;
    const reason = ownReason(def, arm) ?? (r && !subset ? r.reason : null) ?? pending.find(p => p.units.some(u => unitCell(u, [def])))?.reason ?? config.not_run_reason;
    const entry = c ?? { status: 'not-run' as const, not_run_reason: reason, config_sha256: '', ...(pins[def.system] ? { pin: pins[def.system] } : {}) };
    const po = c ? productOutcomes.get(arm.cell_id) : undefined;
    return { ...scoreboardCampaignCell(def, arm, { status: 'complete', config_sha256: entry.config_sha256 }), ...entry, ...(subset ? { subset } : {}), ...(po ? { product_outcomes: po } : {}) };
  }));
  const head = sets.find(s => s.role === 'headline')!;
  const s1 = cells.filter(c => c.set === head.id);
  const f1Anchor = s1.find(c => c.system === 'gbrain-defaults' && c.arm === 'component' && c.budget === 8000 && c.anchor)!;
  const f2Anchor = s1.find(c => c.system === 'gbrain-defaults' && c.arm === 'whole-system' && c.anchor)!;
  const f1 = s1.filter(c => c.system !== 'gbrain-defaults' && c.arm === 'component' && c.budget === 8000).map(c => c.cell_id);
  const families: CampaignFamily[] = [
    { id: 'F1', label: `${head.label}, 8k component rows, answers`, anchor: f1Anchor.cell_id, comparators: f1 },
    { id: 'F2', label: `${head.label}, whole-system rows, answers`, anchor: f2Anchor.cell_id, comparators: s1.filter(c => c.system !== 'gbrain-defaults' && c.arm === 'whole-system').map(c => c.cell_id) },
    { id: 'F3', label: `${head.label}, 8k component rows, strict recall of all gold sessions at 10 (diagnostic)`, anchor: f1Anchor.cell_id, comparators: f1 },
  ];
  seen.sort();
  const campaign: CampaignManifest = {
    schema: 'gbrain-evals/q1-campaign/v1', campaign_id: config.campaign_id, campaign_hash: config.campaign_hash, gbrain: config.gbrain,
    measured: { from: (seen[0] ?? '').slice(0, 10), to: (seen.at(-1) ?? '').slice(0, 10) }, readers: m.readers, statistics: config.statistics,
    hedge_classifier: config.hedge_classifier, sets, cells, families, ...(appendix.length ? { appendix } : {}),
    ...(retired.length ? { retired: retired.map(r => ({ system: r.system, reason: r.reason, subset: { sets: r.sets, conversations: r.conversations, label: r.subset.label, reason: r.subset.reason } })) } : {}),
    pins: Object.entries(pins).filter(([k]) => m.cells.some(c => c.system === k) && k.startsWith('ext-')).map(([system, version]) => ({ system, version, latest_release: null })),
    release_assets: [], ...(preview ? {} : config.published.aggregates_only ? { tables: config.render_targets.find(x => x.endsWith('/scoreboard.md')) } : { receipt_base: config.published.url }), disclosures: [...(preview ? [PREVIEW_DISCLOSURE] : []), `GBrain rows measure ${label}. ${config.gbrain.footnote}`, ...config.disclosures], render_targets: preview ? [] : config.render_targets,
  };
  writeFileSync(join(out, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
  cpSync(join(REPO_ROOT, 'docs/benchmarks/2026-10-06-scoreboard/power.json'), join(out, 'power.json'));
  return campaign;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const config = one('--config'), results = one('--results'), out = one('--out');
  if (!config || !results || !out) { console.error('usage: publish.ts --config <publication.json> --results <dir> --out <receipt dir> [--trees <dir>] [--preview] [--custody] [--frontier-redo <file>]...'); process.exit(2); }
  const many = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const c = assemble(JSON.parse(readFileSync(resolve(config), 'utf8')) as Publication, resolve(results), resolve(out), resolve(one('--trees') ?? join(tmpdir(), 'q1-publish-trees')), { preview: argv.includes('--preview'), custody: argv.includes('--custody'), frontierRedo: many('--frontier-redo') });
  const n = (s: string) => c.cells.filter(x => x.status === s).length;
  const redo = many('--frontier-redo');
  if (redo.length) console.log(`frontier redo: ${loadFrontierRedo(redo).length} judgment records`);
  console.log(`receipt ${relative(process.cwd(), resolve(out)) || '.'}: ${c.cells.length} cells (${n('complete')} with rows, ${n('invalid')} invalid, ${n('not-run')} not run), ${c.appendix?.length ?? 0} appendix cells, ${readdirSync(resolve(out)).length} entries`);
}

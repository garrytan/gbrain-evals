#!/usr/bin/env bun
/**
 * Assemble the Q1 scoreboard receipt that `eval/runner/scoreboard.ts render` reads, from the campaigns' pulled
 * state. It lives outside every campaign's hashed tree.
 *
 *   bun eval/runner/q1/publish.ts --config docs/benchmarks/2026-10-06-scoreboard/publication.json \
 *     --results <dir holding each campaign's state directory, by campaign id> --out <receipt dir> [--trees <dir>]
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
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
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
}
export interface Publication {
  campaign_id: string; campaign_hash: string;
  /** Where the full receipt is published: a path on the results branch, the branch commit that holds it, and the
   * sha256 of its SHA256SUMS file (every file's sha256, sorted by path). Filled when the receipt is pushed. */
  published: { branch: string; path: string; commit: string | null; sha256: string | null };
  /** The GBrain build the main rows measured, and the footnote every rendering of them carries. */
  gbrain: CampaignManifest['gbrain'] & { footnote: string };
  hedge_classifier: string;
  statistics: CampaignManifest['statistics'];
  /** Campaigns still running: an arm with no source whose unit one of them schedules is not run with that reason. */
  pending: Array<{ campaign: string; reason: string }>;
  /** Why any other arm with no source is not run. */
  not_run_reason: string;
  sources: PublicationSource[];
  sensitivity: Array<{ sets: string[]; id: string; label: string; reason: string; question_ids: string[] }>;
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

export function assemble(config: Publication, results: string, out: string, trees: string, preview = false): CampaignManifest {
  const m = loadManifest();
  for (const p of [config.pins, ...config.sources.map(s => s.pins ?? {})]) if (p['gbrain-defaults']) throw new Error('publication.json writes a gbrain-defaults pin by hand; the GBrain label comes from its gbrain build (publish.ts gbrainBuildLabel)');
  const label = gbrainBuildLabel(config.gbrain);
  const pins: Record<string, string> = { ...bundlePins(REPO_ROOT), ...config.pins, 'gbrain-defaults': label };
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const covered = new Map<string, Pick<CampaignCell, 'status' | 'config_sha256' | 'pin'>>();
  const appendix: AppendixCell[] = [];
  const seen: string[] = [];
  for (const [i, src] of config.sources.entries()) {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, src.campaign), 'utf8')) as { campaign_id: string };
    const state = join(results, manifest.campaign_id);
    const leases = settledLeases(state);
    const byCell = new Map<CellDefinition, string[]>();
    for (const [unit, l] of leases) {
      const def = unitCell(unit, m.cells);
      if (!def || !covers(src, def.system)) continue;
      seen.push(l.at);
      byCell.set(def, [...(byCell.get(def) ?? []), join(state, 'results', unit, l.lease)]);
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
        if (!existsSync(join(from, 'receipt.json'))) continue;
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

  const sets: CampaignSet[] = [...new Set(m.cells.flatMap(c => c.arms.filter(answering).map(a => a.set)))].map(id => m.sets.find(s => s.id === id)!).filter(s => s.role !== 'smoke').map(s => {
    const open = PUBLIC_CORPUS.has(s.benchmark);
    let scheduled: CampaignSet['scheduled'] = [];
    if (open) {
      const corpus = loadCorpus(s.benchmark);
      const inSplit = splitConversations(s.benchmark, s.split, corpus);
      scheduled = selectCellQuestions(corpus.questions.filter(q => inSplit.has(q.conversation)), s.selection).map(q => ({ question_id: q.id, conversation: q.conversation }));
    }
    const ids = new Set(scheduled.map(q => q.question_id));
    const views = config.sensitivity.filter(v => v.sets.includes(s.id)).map(v => ({ id: v.id, label: v.label, reason: v.reason, question_ids: v.question_ids.filter(q => ids.has(q)) }));
    return {
      id: s.id, label: s.label, benchmark: s.benchmark, exposure: s.exposure as CampaignSet['exposure'], role: s.role as CampaignSet['role'],
      cluster_unit: s.benchmark.startsWith('lme') ? 'question' as const : 'conversation' as const, claim_min_clusters: s.role === 'headline' ? 9 : 0,
      scheduled, exclusions: open ? s.exclusions : [], ...(views.length ? { sensitivity: views } : {}),
    };
  });

  const pending = config.pending.map(p => ({ reason: p.reason, units: (JSON.parse(readFileSync(resolve(REPO_ROOT, p.campaign), 'utf8')) as { cells: Array<{ id: string }> }).cells.map(u => u.id) }));
  const cells: CampaignCell[] = m.cells.flatMap(def => def.arms.filter(answering).map(arm => {
    const c = covered.get(arm.cell_id);
    const reason = pending.find(p => p.units.some(u => unitCell(u, [def])))?.reason ?? config.not_run_reason;
    const entry = c ?? { status: 'not-run' as const, not_run_reason: reason, config_sha256: '', ...(pins[def.system] ? { pin: pins[def.system] } : {}) };
    return { ...scoreboardCampaignCell(def, arm, { status: 'complete', config_sha256: entry.config_sha256 }), ...entry };
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
    pins: Object.entries(pins).filter(([k]) => m.cells.some(c => c.system === k) && k.startsWith('ext-')).map(([system, version]) => ({ system, version, latest_release: null })),
    release_assets: [], disclosures: [...(preview ? [PREVIEW_DISCLOSURE] : []), `GBrain rows measure ${label}. ${config.gbrain.footnote}`, ...config.disclosures], render_targets: preview ? [] : config.render_targets,
  };
  writeFileSync(join(out, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
  cpSync(join(REPO_ROOT, 'docs/benchmarks/2026-10-06-scoreboard/power.json'), join(out, 'power.json'));
  return campaign;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const config = one('--config'), results = one('--results'), out = one('--out');
  if (!config || !results || !out) { console.error('usage: publish.ts --config <publication.json> --results <dir> --out <receipt dir> [--trees <dir>] [--preview]'); process.exit(2); }
  const c = assemble(JSON.parse(readFileSync(resolve(config), 'utf8')) as Publication, resolve(results), resolve(out), resolve(one('--trees') ?? join(tmpdir(), 'q1-publish-trees')), argv.includes('--preview'));
  const n = (s: string) => c.cells.filter(x => x.status === s).length;
  console.log(`receipt ${relative(process.cwd(), resolve(out)) || '.'}: ${c.cells.length} cells (${n('complete')} with rows, ${n('invalid')} invalid, ${n('not-run')} not run), ${c.appendix?.length ?? 0} appendix cells, ${readdirSync(resolve(out)).length} entries`);
}

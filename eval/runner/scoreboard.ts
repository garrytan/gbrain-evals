/**
 * Q1 head-to-head scoreboard generator (plan §4.6, §5.1, §5.2, §4.8 contracts
 * 14 and 15).
 *
 *   bun eval/runner/scoreboard.ts check [--receipt <dir>]... [--json]
 *   bun eval/runner/scoreboard.ts render [--receipt <dir>]... [--json]
 *   bun eval/runner/scoreboard.ts explain <row> <column> [--receipt <dir>] [--json]
 *
 * One derivation chain, recomputed in full by `check`:
 *
 *   campaign.json + per-cell rows.ndjson, answers.ndjson, judgments.ndjson
 *     -> question values per cell (mean over the three readers of canonical judge scores)
 *     -> pairwise cohorts per comparison (against the scheduled cohort)
 *     -> aggregates and comparisons (restricted wild cluster bootstrap-t for
 *        the headline set, cluster bootstrap for descriptive sets)
 *     -> families with Holm, preregistered claim sentences
 *     -> scoreboard.json (this schema, the Markdown's only input)
 *     -> scoreboard.md (report tables) and the README headline block.
 *
 * `render` writes scoreboard.json, scoreboard.md and every README block the
 * campaign lists. `check` recomputes every layer from the rows and compares
 * byte for byte, validates the pin table fenced in docs/comparison-systems.md
 * against the bundles' lockfile and capability hashes, enforces the receipt
 * size budget (no file over 50 MB, receipt tree under 60 MB), verifies
 * release-asset hashes for assets present under `<receipt>/release-assets/`,
 * and runs the receipt secret scan (eval/runner/q1/secret-scan.ts). `explain`
 * prints the chain behind one number. Refusals are operator messages in the
 * decision kit's shape (eval/runner/decisions/errors.ts) with its exit codes:
 * 2 refusal, 3 ask the user.
 *
 * Receipt layout (a directory under docs/benchmarks/ holding campaign.json
 * with schema `gbrain-evals/q1-campaign/v1`):
 *
 *   campaign.json        the authoritative cell manifest (CampaignManifest)
 *   power.json           eval/runner/q1/power.ts output (its `decision` gates Family 1)
 *   cost-speed.json      optional: per-row workload cost and write-to-queryable (CostSpeedFile)
 *   cells/<cell_id>/     receipt.json, run-config.json, rows.ndjson[.gz],
 *                        answers.ndjson[.gz], judgments.ndjson[.gz]
 *   cells/<cell_id>/derived/hedge.ndjson
 *                        generated: one line per judged answer, in answers.ndjson
 *                        order, {answer_id, verdict, classifier_version,
 *                        rules_sha256, delivered_tokens}
 *   release-assets/      optional local copies of the release assets campaign.json hashes
 *   scoreboard.json      generated (Scoreboard)
 *   scoreboard.md        generated
 *
 * Record shapes (answers, judgments, rows) are the Q1 shared schemas; lane L4
 * owns their canonical types in eval/runner/memory-qa/records.ts, and the
 * interfaces below mirror them field for field until that file lands.
 *
 * Derivation rules (preregistered; changing one changes scoreboard.json):
 *   - An answer's canonical score is its judgment from the cell's canonical
 *     instrument at judge_replicate 0. Product failures (retrieval_error,
 *     unsupported) score 0 and stay in the denominator; ingest_degraded keeps
 *     its judged score; harness failures (reader_error, judge_error,
 *     harness_invalid, budget_not_run), a malformed judgment or a missing one
 *     exclude the question from that cell. does_not_fit (not applicable: the
 *     whole history did not fit the reader's window) is never judged and never
 *     a failure: the question leaves that cell's denominator, does not count
 *     against its completeness, and the cell shows "did not fit {reader}'s
 *     window" with a count per reader.
 *   - A reader's question score is the mean over its promised replicates; the
 *     question value is the mean over the cell's promised readers. A missing
 *     promised reader or replicate excludes the question, never averages the
 *     readers that are present; a promised reader with no answers at all
 *     makes the cell incomplete.
 *   - Cohorts are pairwise: scheduled = the set's scheduled questions minus
 *     preregistered exclusions; paired = scheduled questions valued in both
 *     cells. Coverage = paired / scheduled. A conversation is retained when at
 *     least half of its scheduled questions are paired. A claim needs coverage
 *     >= 95%, at least `claim_min_clusters` retained conversations (9 of 10 on
 *     BEAM-10M), both cells complete and none invalid. Excluded ids are
 *     published with best/worst-case bounds (excluded questions imputed 1/0
 *     and 0/1), and the all-cell join of the comparison's group is reported
 *     only as a sensitivity view.
 *   - Families: F1 = headline set, component, 8,000 tokens, answers;
 *     F2 = headline set, whole system, answers; F3 = headline set, component,
 *     8,000 tokens, strict recall_all@10 (diagnostic, no claim). Holm within
 *     each family; a comparison that cannot claim enters Holm with p = 1 so
 *     the family keeps its preregistered size. power.json's decision gates
 *     F1: `descriptive` allows no superiority claim, `shrunk` requires F1's
 *     comparators to be exactly the rule's four.
 *   - "Beats the field" needs every F1 comparison to favor gbrain-defaults
 *     after Holm and every external kind (kinds.json `ext-*`, except
 *     ext-agent-runtime, which runs only the LoCoMo slice) to have run on the
 *     headline set.
 *
 * Derived columns (preregistration, "Derived columns"; descriptive, no family, no Holm):
 *   - The answers counted are each promised reader's replicate-0 answer with a
 *     scored canonical judgment, on scheduled questions outside the
 *     preregistered exclusions. An answer is wrong when its canonical score is
 *     below PASS_THRESHOLD (memory-qa/instruments.ts, 0.5).
 *   - The hedge classifier is the eval/runner/q1/hedge.ts version campaign.json
 *     names in `hedge_classifier`, fixed by amendment before render. Verdicts
 *     are computed here, at render time, from each answer's stored text and
 *     written per answer to cells/<cell_id>/derived/hedge.ndjson; cells stamp
 *     no verdict, so the classifier is not part of the cell's executed tree.
 *     A `hedge` stamp on an older answer record is ignored.
 *   - Confident-error rate = wrong answers the hedge classifier calls
 *     `confident` / wrong answers.
 *   - Correct-abstention rate = answers to abstention questions (the row's
 *     `abstention`: LoCoMo adversarial, BEAM abstention, LongMemEval `_abs`)
 *     the canonical instrument passes / those answers. Its own abstention
 *     judgment decides, not the classifier.
 *   - False-abstention rate = answers to questions with gold evidence (the
 *     row's gold_count > 0) the classifier calls `abstain` / those answers.
 *   - Per cell; per system and set from the system's head cell (headCellOf);
 *     pooled per system by summing counts over its head cells on every set.
 *   - `check` recomputes every cell's derived/hedge.ndjson and compares it
 *     byte for byte.
 *
 * scoreboard.json, schema `gbrain-evals/scoreboard/v4` (interface Scoreboard; v2 adds each cell's `not_applicable`;
 * v3 adds each cell's `derived` and the top-level `derived`; v4 takes the classifier from campaign.json
 * `hedge_classifier` and adds `derived.classifier.source` and `derived.classifier.per_answer`):
 *   schema, generator, campaign {id, hash, campaign_sha256, gbrain, measured, readers},
 *   inputs [{path, sha256}] (every file the derivation read),
 *   statistics {alpha, draws, descriptive_draws, seed, method},
 *   power {family1, detectable_difference_points, shrunk_comparators, sha256},
 *   sets [{id, label, benchmark, exposure, exposure_label, cluster_unit, clusters, scheduled, preregistered_exclusions}],
 *   cells [CellAggregate], comparisons [Comparison], families [FamilyResult],
 *   field {required, ran, missing, complete}, verdict, headline [HeadlineRow],
 *   size_curve {sets, rows}, losses [comparison ids], disclosures, staleness,
 *   derived {classifier {file, version, rules_sha256, source, per_answer}, pass_threshold, rule, systems [{system, sets, pooled}], headline}.
 * Numbers are rounded to six decimals; arrays are in campaign order. A field
 * may be added only with a schema version bump.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { renderOperatorMessage, type OperatorFix, type OperatorMessage } from './decisions/errors.ts';
import type { Outcome } from './memory-qa/outcomes.ts';
import { clusteredPairedDelta, holmAdjusted, normalQuantile } from './stats/paired.ts';
import { wildTest, type ClusterRow } from './stats/wild-cluster.ts';
import { scanTree, secretMessage } from './q1/secret-scan.ts';
import type { PowerReport } from './q1/power.ts';
import { HEDGE_CLASSIFIERS, hedgeClassifier, type HedgeVerdict } from './q1/hedge.ts';
import { PASS_THRESHOLD } from './memory-qa/instruments.ts';

const ROOT = resolve(import.meta.dir, '../..');
export const SCOREBOARD_SCHEMA = 'gbrain-evals/scoreboard/v4';
export const CAMPAIGN_SCHEMA = 'gbrain-evals/q1-campaign/v1';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TREE_BYTES = 60 * 1024 * 1024;
export const MIN_COVERAGE = 0.95;
/** Per-answer hedge verdicts, rendered under each run cell (see the header). */
export const HEDGE_FILE = 'cells/<cell_id>/derived/hedge.ndjson';
export const CLUSTER_RETAINED_SHARE = 0.5;
export const CEILING = 0.95;
export const README_BEGIN = '<!-- scoreboard:headline:begin -->';
export const README_END = '<!-- scoreboard:headline:end -->';
const FIELD_EXEMPT: Record<string, string> = { 'ext-agent-runtime': 'runs only the LoCoMo slice (plan §4.1)' };
const PRODUCT_FAILURES = new Set<Outcome>(['retrieval_error', 'unsupported']);
const HARNESS_FAILURES = new Set<Outcome>(['reader_error', 'judge_error', 'harness_invalid', 'budget_not_run']);
/** memory-qa/outcomes.ts NOT_APPLICABLE: a whole history that did not fit the reader's window; out of that system's denominator, counted and shown. */
const NOT_APPLICABLE = new Set<Outcome>(['does_not_fit']);
/** Answers a judge scores (memory-qa/outcomes.ts): the ones derived/hedge.ndjson lists. */
const JUDGED_OUTCOMES = new Set<Outcome>(['scored', 'ingest_degraded']);
export const notApplicableReason = (readers: readonly string[]) => `not applicable: did not fit ${readers.join(', ')}'s window`;

// ─── Shared record schemas (mirror eval/runner/memory-qa/records.ts, lane L4) ───

export interface Usage { input: number; output: number; cache_read: number; cache_write: number }
export interface AnswerRecord {
  answer_id: string; cell_id: string; realization_id: string; question_id: string; conversation: string;
  system: string; arm: string; reader: string; replicate: number; context_sha256: string; text: string;
  usage: Usage; provider_input_tokens: number | null; latency_ms: number | null; outcome: Outcome;
  /** Stamped by cells run before verdicts moved to render time; ignored. */
  hedge?: { verdict: HedgeVerdict; classifier_version: string }; delivered_tokens?: Record<string, number>;
}
export interface JudgmentRecord {
  answer_id: string; instrument_id: string; instrument_sha256: string; judge: string; judge_replicate: number;
  temperature: number | null; score: number | null; parse_ok: boolean; raw_sha256: string; outcome: Outcome;
}
export interface RowRecord {
  id: string; conversation: string; realization_id?: string; outcome?: Outcome; abstention?: boolean; gold_count?: number;
  recall_all_at_5?: number | null; recall_all_at_10?: number | null; recall_any_at_10?: number | null; ndcg_at_10?: number | null;
  recall_measurable?: boolean; latency_ms?: number | null; delivered_tokens?: Record<string, number>; fill_rate?: number | null;
  packing_loss?: number | null; provenance_status?: string; fanout?: number | null;
}

/** sha256 of `cell_id|question_id|reader|replicate`, the answer's immutable id. */
export function answerId(cellId: string, questionId: string, reader: string, replicate: number): string {
  return createHash('sha256').update(`${cellId}|${questionId}|${reader}|${replicate}`).digest('hex');
}

// ─── Campaign manifest ──────────────────────────────────────────────

export type Exposure = 'E0' | 'E1' | 'E2' | 'E3';
export const EXPOSURE_LABELS: Record<Exposure, string> = {
  E0: 'never used to tune gbrain',
  E1: 'opened once for a decision that set no gbrain default',
  E2: 'used to choose gbrain settings',
  E3: 'gbrain was developed on it',
};

export interface CampaignSet {
  id: string; label: string; benchmark: string; exposure: Exposure; role: 'headline' | 'public';
  cluster_unit: 'conversation' | 'question'; claim_min_clusters: number;
  scheduled: Array<{ question_id: string; conversation: string }>;
  exclusions: Array<{ question_id: string; reason: string }>;
}
export interface CampaignCell {
  cell_id: string; set: string; system: string; arm: 'component' | 'whole-system'; budget: number | null;
  configuration: string; label?: string; anchor?: boolean; headline?: boolean;
  status: 'complete' | 'invalid' | 'not-run'; not_run_reason?: string;
  readers: string[]; reader_replicates?: Record<string, number>; canonical_instrument: string; config_sha256: string;
}
export interface CampaignFamily { id: 'F1' | 'F2' | 'F3'; label: string; anchor: string; comparators: string[] }
export interface CampaignManifest {
  schema: typeof CAMPAIGN_SCHEMA; campaign_id: string; campaign_hash: string;
  gbrain: { commit: string; version: string; resolved_search_mode: string };
  measured: { from: string; to: string };
  readers: string[];
  statistics: { alpha: number; draws: number; descriptive_draws: number; seed: number };
  /** The eval/runner/q1/hedge.ts version the derived columns use (HEDGE_CLASSIFIERS), fixed by amendment before render. */
  hedge_classifier: string;
  sets: CampaignSet[]; cells: CampaignCell[]; families: CampaignFamily[];
  pins: Array<{ system: string; version: string; latest_release: string | null }>;
  release_assets: Array<{ name: string; sha256: string; bytes: number }>;
  disclosures: string[];
  render_targets: string[];
}

export interface CostSpeedFile {
  schema: 'gbrain-evals/q1-cost-speed/v1';
  rows: Array<{ system: string; configuration: string; personal_month_usd: number | null; team_month_usd: number | null; write_to_queryable_p50_ms: number | null }>;
}

// ─── Operator messages ──────────────────────────────────────────────

export type ScoreboardCode = 'RECEIPT_MISSING' | 'RECEIPT_INVALID' | 'SCOREBOARD_STALE' | 'PIN_TABLE_MISMATCH' | 'RECEIPT_TOO_LARGE' | 'ASSET_HASH_MISMATCH' | 'SECRET_IN_RECEIPT' | 'EXPLAIN_UNKNOWN' | 'USAGE';
export type ScoreboardMessage = Omit<OperatorMessage, 'code'> & { code: ScoreboardCode };

export class ScoreboardError extends Error {
  constructor(readonly op: ScoreboardMessage) { super(`${op.code}: ${op.message}`); this.name = 'ScoreboardError'; }
}

export const renderMessage = (op: ScoreboardMessage) => renderOperatorMessage(op as unknown as OperatorMessage);
export const exitCode = (op: ScoreboardMessage) => (op.fix.next === 'ask_user' || op.fix.next === 'tell_user_to_run' ? 3 : 2);

const rel = (p: string) => relative(ROOT, p) || '.';
const checkArgv = (receipt: string) => ['bun', 'eval/runner/scoreboard.ts', 'check', '--receipt', rel(receipt)];

function invalid(receipt: string, message: string, why: string, fix?: Partial<OperatorFix>): ScoreboardError {
  return new ScoreboardError({ code: 'RECEIPT_INVALID', message: `${rel(receipt)}: ${message}`, why, fix: { next: 'report', user_message: 'fix the receipt input named above (never edit scoreboard.json by hand), then re-render', verify: checkArgv(receipt), ...fix } });
}

// ─── Reading ────────────────────────────────────────────────────────

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

interface Reader { root: string; inputs: Map<string, string> }

function readInput(r: Reader, path: string): Buffer {
  const buf = readFileSync(path);
  r.inputs.set(relative(r.root, path), sha256(buf));
  return buf;
}

function readNdjson<T>(r: Reader, base: string): T[] {
  const path = existsSync(base) ? base : existsSync(`${base}.gz`) ? `${base}.gz` : null;
  if (!path) throw invalid(r.root, `${relative(r.root, base)}[.gz] is missing`, 'every cell the campaign lists as run must carry its rows, answers and judgments', { next: 'report', user_message: 'restore the file from the run host, or mark the cell `not-run` with a reason in campaign.json' });
  const buf = readInput(r, path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return text.split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l) as T; } catch { throw invalid(r.root, `${relative(r.root, path)} line ${i + 1} is not JSON`, 'records are parsed line by line'); }
  });
}

export function loadCampaign(receipt: string): { campaign: CampaignManifest; reader: Reader } {
  const path = join(receipt, 'campaign.json');
  if (!existsSync(path)) throw new ScoreboardError({ code: 'RECEIPT_MISSING', message: `${rel(receipt)} has no campaign.json`, why: 'campaign.json is the authoritative cell manifest every scoreboard number derives from', fix: { next: 'run', argv: ['ls', 'docs/benchmarks'], user_message: 'pass the receipt directory that holds campaign.json with --receipt', verify: ['ls', rel(path)] } });
  const reader: Reader = { root: receipt, inputs: new Map() };
  const campaign = JSON.parse(readInput(reader, path).toString('utf8')) as CampaignManifest;
  if (campaign.schema !== CAMPAIGN_SCHEMA) throw invalid(receipt, `campaign.json schema is ${String(campaign.schema)}, expected ${CAMPAIGN_SCHEMA}`, 'the generator reads only the versioned campaign schema');
  validateCampaign(receipt, campaign);
  return { campaign, reader };
}

function loadKinds(): Array<{ id: string; description: string }> {
  return (JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string; description: string }> }).kinds;
}

function validateCampaign(receipt: string, c: CampaignManifest): void {
  const kinds = new Set(loadKinds().map(k => k.id));
  const sets = new Map(c.sets.map(s => [s.id, s]));
  const cells = new Map<string, CampaignCell>();
  const why = 'campaign.json must describe every cell, set and family unambiguously before anything is derived from it';
  if (c.sets.filter(s => s.role === 'headline').length !== 1) throw invalid(receipt, 'exactly one set must have role "headline"', why);
  if (!HEDGE_CLASSIFIERS[c.hedge_classifier]) throw invalid(receipt, `campaign.json hedge_classifier is ${JSON.stringify(c.hedge_classifier ?? null)}, not one of ${Object.keys(HEDGE_CLASSIFIERS).join(', ')}`, 'the derived columns run the hedge classifier version the preregistration fixes by amendment before render', { next: 'report', user_message: 'set campaign.json hedge_classifier to the version the preregistration names (an amendment changes it, never an edit after render)' });
  for (const s of c.sets) {
    const ids = new Set<string>();
    for (const q of s.scheduled) { if (ids.has(q.question_id)) throw invalid(receipt, `set ${s.id} schedules ${q.question_id} twice`, why); ids.add(q.question_id); }
    for (const e of s.exclusions) if (!ids.has(e.question_id)) throw invalid(receipt, `set ${s.id} excludes ${e.question_id}, which it does not schedule`, why);
    if (!EXPOSURE_LABELS[s.exposure]) throw invalid(receipt, `set ${s.id} has unknown exposure ${s.exposure}`, why);
  }
  for (const cell of c.cells) {
    if (cells.has(cell.cell_id)) throw invalid(receipt, `cell ${cell.cell_id} is listed twice`, why);
    if (!sets.has(cell.set)) throw invalid(receipt, `cell ${cell.cell_id} names unknown set ${cell.set}`, why);
    if (!kinds.has(cell.system)) throw invalid(receipt, `cell ${cell.cell_id} names system ${cell.system}, which is not a kind id in eval/systems/kinds.json`, 'published rows describe every system by its kind id');
    if (cell.status === 'not-run' && !cell.not_run_reason) throw invalid(receipt, `cell ${cell.cell_id} is not-run without a reason`, 'a cell that did not run is published with its reason');
    if (!cell.readers.length) throw invalid(receipt, `cell ${cell.cell_id} promises no readers`, why);
    cells.set(cell.cell_id, cell);
  }
  const head = c.sets.find(s => s.role === 'headline')!;
  for (const f of c.families) {
    const anchor = cells.get(f.anchor);
    if (!anchor || anchor.system !== 'gbrain-defaults' || anchor.set !== head.id) throw invalid(receipt, `family ${f.id} anchor ${f.anchor} must be a gbrain-defaults cell on ${head.id}`, why);
    const group = c.cells.filter(x => x.set === anchor.set && x.arm === anchor.arm && x.budget === anchor.budget && x.system === 'gbrain-defaults');
    if (group.length > 1 && !anchor.anchor) throw invalid(receipt, `family ${f.id} anchor ${f.anchor} shares its set, arm and budget with other gbrain-defaults cells and is not marked anchor: true`, why);
    const wantArm = f.id === 'F2' ? 'whole-system' : 'component';
    if (anchor.arm !== wantArm || (f.id !== 'F2' && anchor.budget !== 8000)) throw invalid(receipt, `family ${f.id} must be ${f.id === 'F2' ? 'whole-system' : 'component at 8,000 tokens'}`, 'Family 1 is the headline set, component, 8k; Family 2 whole system; Family 3 strict recall at 10 on Family 1\'s cells');
    for (const id of f.comparators) {
      const x = cells.get(id);
      if (!x || x.set !== head.id || x.arm !== anchor.arm || (f.id !== 'F2' && x.budget !== anchor.budget)) throw invalid(receipt, `family ${f.id} comparator ${id} is not in its anchor's set, arm and budget`, why);
    }
  }
}

// ─── Layer 1: question values per cell ──────────────────────────────

export interface QuestionValue { question_id: string; conversation: string; value: number | null; reason: string | null; recall: number | null; recall_reason: string | null }

interface CellData {
  cell: CampaignCell;
  values: Map<string, QuestionValue>;
  /** Per judge run j (0 = canonical), question values with run j substituted where the answer has one; a cell without run j counts as canonical in it. */
  judgeRuns: Array<Map<string, number | null>>;
  readerMeans: Record<string, number | null>;
  missingReaders: string[];
  productFailures: number;
  harnessFailures: number;
  judgeSd: number | null;
  latencies: number[];
  rows: Map<string, RowRecord>;
  problems: string[];
  /** does_not_fit answers per reader (not applicable: never a judge or harness failure). */
  notApplicable: Record<string, number>;
  derived: DerivedCounts;
  /** cells/<cell_id>/derived/hedge.ndjson as rendered: one line per judged answer. */
  hedgeLines: string;
}

/** Counts behind the derived columns (see the header); every rate is a ratio of two of them. */
export interface DerivedCounts { answers: number; wrong: number; confident_wrong: number; abstention_answers: number; correct_abstentions: number; answerable_answers: number; false_abstentions: number }
export interface DerivedColumns extends DerivedCounts { confident_error_rate: number | null; correct_abstention_rate: number | null; false_abstention_rate: number | null }
const NO_DERIVED: DerivedCounts = { answers: 0, wrong: 0, confident_wrong: 0, abstention_answers: 0, correct_abstentions: 0, answerable_answers: 0, false_abstentions: 0 };

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function cellFiles(receipt: string, id: string) {
  const dir = join(receipt, 'cells', id);
  return { dir, rows: join(dir, 'rows.ndjson'), answers: join(dir, 'answers.ndjson'), judgments: join(dir, 'judgments.ndjson'), runConfig: join(dir, 'run-config.json'), receipt: join(dir, 'receipt.json') };
}

function deriveCell(r: Reader, campaign: CampaignManifest, cell: CampaignCell): CellData {
  const set = campaign.sets.find(s => s.id === cell.set)!;
  const empty: CellData = { cell, values: new Map(), judgeRuns: [], readerMeans: {}, missingReaders: [], productFailures: 0, harnessFailures: 0, judgeSd: null, latencies: [], rows: new Map(), problems: [], notApplicable: {}, derived: { ...NO_DERIVED }, hedgeLines: '' };
  if (cell.status === 'not-run') return empty;
  const files = cellFiles(r.root, cell.cell_id);
  if (!existsSync(files.runConfig)) throw invalid(r.root, `cell ${cell.cell_id} has no run-config.json`, 'the configuration identity is the run-config.json hash');
  const configSha = sha256(readInput(r, files.runConfig));
  if (configSha !== cell.config_sha256) throw invalid(r.root, `cell ${cell.cell_id} run-config.json sha256 ${configSha.slice(0, 12)}… does not match campaign.json config_sha256 ${cell.config_sha256.slice(0, 12)}…`, 'a counted cell runs exactly the configuration the campaign froze; a changed configuration is a new cell identity', { next: 'report', user_message: 'restore the frozen run-config.json, or register the changed configuration as a new cell (never rewrite config_sha256 to match)' });
  if (!existsSync(files.receipt)) throw invalid(r.root, `cell ${cell.cell_id} has no receipt.json`, 'every table row links to its cell receipt');
  const rows = new Map(readNdjson<RowRecord>(r, files.rows).map(x => [x.id, x]));
  const answers = readNdjson<AnswerRecord>(r, files.answers);
  const judgments = readNdjson<JudgmentRecord>(r, files.judgments);
  const problems: string[] = [];
  const byAnswer = new Map<string, JudgmentRecord[]>();
  for (const j of judgments) if (j.instrument_id === cell.canonical_instrument) byAnswer.set(j.answer_id, [...(byAnswer.get(j.answer_id) ?? []), j]);
  const byQuestion = new Map<string, AnswerRecord[]>();
  for (const a of answers) {
    if (a.cell_id !== cell.cell_id) problems.push(`answer ${a.answer_id.slice(0, 12)} names cell ${a.cell_id}`);
    if (a.answer_id !== answerId(a.cell_id, a.question_id, a.reader, a.replicate)) problems.push(`answer for ${a.question_id}/${a.reader}/${a.replicate} has an answer_id that is not sha256(cell_id|question_id|reader|replicate)`);
    byQuestion.set(a.question_id, [...(byQuestion.get(a.question_id) ?? []), a]);
  }
  if (problems.length) throw invalid(r.root, `cell ${cell.cell_id}: ${problems.slice(0, 3).join('; ')}`, 'answers are immutable records keyed by their content id');
  const classifier = hedgeClassifier(campaign.hedge_classifier);
  const verdicts = new Map(answers.map(a => [a.answer_id, classifier.classify(a.text)]));
  const hedgeLines = answers.filter(a => JUDGED_OUTCOMES.has(a.outcome))
    .map(a => JSON.stringify({ answer_id: a.answer_id, verdict: verdicts.get(a.answer_id), classifier_version: classifier.version, rules_sha256: classifier.rules_sha256, delivered_tokens: a.delivered_tokens ?? null }) + '\n').join('');
  const excluded = new Map(set.exclusions.map(e => [e.question_id, e.reason]));
  const seenReaders = new Set(answers.map(a => a.reader));
  const missingReaders = cell.readers.filter(x => !seenReaders.has(x));
  const reps = (reader: string) => cell.reader_replicates?.[reader] ?? 1;
  const maxJudgeRun = judgments.reduce((m, j) => (j.instrument_id === cell.canonical_instrument ? Math.max(m, j.judge_replicate) : m), 0);
  const judgeRuns = Array.from({ length: maxJudgeRun + 1 }, () => new Map<string, number | null>());
  const readerScores: Record<string, number[]> = Object.fromEntries(cell.readers.map(x => [x, []]));
  const sds: number[] = [];
  const latencies: number[] = [];
  let productFailures = 0, harnessFailures = 0;
  const notApplicable: Record<string, number> = {};
  const values = new Map<string, QuestionValue>();
  const derived: DerivedCounts = { ...NO_DERIVED };
  for (const q of set.scheduled) {
    const row = rows.get(q.question_id);
    const recall = (() => {
      if (!row) return { recall: null, recall_reason: 'no retrieval row' };
      if (row.abstention || row.gold_count === 0) return { recall: null, recall_reason: 'no gold sessions (abstention)' };
      if (row.recall_measurable === false) return { recall: null, recall_reason: 'not measurable (provenance unavailable)' };
      if (row.outcome && PRODUCT_FAILURES.has(row.outcome)) return { recall: 0, recall_reason: null };
      if (row.outcome && HARNESS_FAILURES.has(row.outcome)) return { recall: null, recall_reason: `harness: ${row.outcome}` };
      return typeof row.recall_all_at_10 === 'number' ? { recall: row.recall_all_at_10, recall_reason: null } : { recall: null, recall_reason: 'no recall_all_at_10' };
    })();
    const done = (value: number | null, reason: string | null, runs?: Array<number | null>) => {
      values.set(q.question_id, { question_id: q.question_id, conversation: q.conversation, value, reason, ...recall });
      judgeRuns.forEach((m, j) => m.set(q.question_id, runs ? runs[j] : value));
    };
    if (excluded.has(q.question_id)) { done(null, `preregistered: ${excluded.get(q.question_id)}`); continue; }
    const qa = byQuestion.get(q.question_id) ?? [];
    let reason: string | null = null;
    const unfit: string[] = [];
    const perReader: number[] = [];
    const perReaderRuns: number[][] = judgeRuns.map(() => []);
    for (const reader of cell.readers) {
      const scores: number[] = [];
      const runScores: number[][] = judgeRuns.map(() => []);
      for (let rep = 0; rep < reps(reader); rep++) {
        const a = qa.find(x => x.reader === reader && x.replicate === rep);
        if (!a) { reason ??= `missing answer: ${reader} replicate ${rep}`; continue; }
        if (NOT_APPLICABLE.has(a.outcome)) { notApplicable[reader] = (notApplicable[reader] ?? 0) + 1; if (!unfit.includes(reader)) unfit.push(reader); continue; }
        if (PRODUCT_FAILURES.has(a.outcome)) { productFailures++; scores.push(0); runScores.forEach(x => x.push(0)); continue; }
        if (HARNESS_FAILURES.has(a.outcome)) { harnessFailures++; reason ??= `harness: ${a.outcome} (${reader})`; continue; }
        const js = byAnswer.get(a.answer_id) ?? [];
        const canonical = js.find(j => j.judge_replicate === 0);
        if (!canonical || !canonical.parse_ok || canonical.outcome !== 'scored' || typeof canonical.score !== 'number') { harnessFailures++; reason ??= `harness: judge_error (${reader})`; continue; }
        scores.push(canonical.score);
        if (rep === 0 && typeof a.latency_ms === 'number') latencies.push(a.latency_ms + (typeof row?.latency_ms === 'number' ? row.latency_ms : 0));
        const repeats = js.filter(j => j.parse_ok && j.outcome === 'scored' && typeof j.score === 'number').map(j => j.score as number);
        if (repeats.length > 1) { const m = mean(repeats)!; sds.push(Math.sqrt(repeats.reduce((s, x) => s + (x - m) ** 2, 0) / (repeats.length - 1))); }
        runScores.forEach((x, j) => { const alt = js.find(k => k.judge_replicate === j && k.parse_ok && k.outcome === 'scored' && typeof k.score === 'number'); x.push(alt ? alt.score as number : canonical.score as number); });
      }
      if (scores.length === reps(reader)) { const m = mean(scores)!; perReader.push(m); readerScores[reader].push(m); runScores.forEach((x, j) => perReaderRuns[j].push(mean(x)!)); }
    }
    for (const reader of cell.readers) {
      const a = qa.find(x => x.reader === reader && x.replicate === 0);
      const canonical = a && !NOT_APPLICABLE.has(a.outcome) && !PRODUCT_FAILURES.has(a.outcome) && !HARNESS_FAILURES.has(a.outcome) ? byAnswer.get(a.answer_id)?.find(j => j.judge_replicate === 0) : undefined;
      if (!a || !canonical?.parse_ok || canonical.outcome !== 'scored' || typeof canonical.score !== 'number') continue;
      const verdict = verdicts.get(a.answer_id)!, pass = canonical.score >= PASS_THRESHOLD;
      derived.answers++;
      if (!pass) { derived.wrong++; if (verdict === 'confident') derived.confident_wrong++; }
      if (row?.abstention) { derived.abstention_answers++; if (pass) derived.correct_abstentions++; }
      else if ((row?.gold_count ?? 0) > 0) { derived.answerable_answers++; if (verdict === 'abstain') derived.false_abstentions++; }
    }
    if (reason || perReader.length !== cell.readers.length) { done(null, reason ?? (unfit.length ? notApplicableReason(unfit) : 'incomplete readers')); continue; }
    if (cell.arm === 'component' && new Set(qa.map(a => a.context_sha256)).size > 1) throw invalid(r.root, `cell ${cell.cell_id} question ${q.question_id}: readers read different context bytes`, 'every reader of a component arm reads the same frozen pack (plan §4.3)');
    done(mean(perReader)!, null, perReaderRuns.map(x => mean(x)!));
  }
  return {
    cell, values, judgeRuns, readerMeans: Object.fromEntries(cell.readers.map(x => [x, mean(readerScores[x])])), missingReaders,
    productFailures, harnessFailures, judgeSd: mean(sds), latencies, rows, problems, notApplicable, derived, hedgeLines,
  };
}

// ─── Layers 2 to 4: cohorts, comparisons, families ──────────────────

export interface Cohort {
  scheduled: number; paired: number; coverage: number; clusters_scheduled: number; clusters_retained: number;
  excluded: Array<{ question_id: string; reason: string }>;
}

export type ComparisonOutcome = 'gbrain-ahead' | 'gbrain-behind' | 'not-separated' | 'ceiling' | 'incomplete' | 'descriptive' | 'not-run' | 'not-measurable';

export interface Comparison {
  id: string; set: string; arm: string; budget: number | null; metric: 'answer' | 'recall_all_at_10';
  anchor: string; other: string; system: string; family: 'F1' | 'F2' | 'F3' | null;
  cohort: Cohort | null;
  mean_anchor: number | null; mean_other: number | null; delta: number | null; ci95: [number, number] | null;
  p: number | null; p_holm: number | null; method: string | null; mdd_points: number | null;
  sensitivity: { worst: number; best: number; joint_cohort_n: number; joint_cohort_delta: number | null } | null;
  claim_eligible: boolean; eligibility: string[]; outcome: ComparisonOutcome; sentence: string;
}

export interface CellAggregate {
  cell_id: string; set: string; system: string; arm: string; budget: number | null; configuration: string; label: string;
  status: string; not_run_reason: string | null; config_sha256: string; readers: string[]; missing_readers: string[]; complete: boolean;
  scheduled: number; valued: number; mean: number | null; ci95: [number, number] | null; per_reader: Record<string, number | null>;
  product_failures: number; harness_failures: number; judge_sd: number | null; judge_runs: number;
  /** Answers that did not fit the reader's window (does_not_fit), per reader; their questions leave this cell's denominator. */
  not_applicable: Record<string, number>;
  recall_all_at_10: number | null; recall_all_at_5: number | null; recall_any_at_10: number | null; ndcg_at_10: number | null;
  fill_rate: number | null; delivered_tokens: Record<string, number>; latency_p50_ms: number | null;
  exclusions: Array<{ question_id: string; reason: string }>;
  /** Descriptive derived columns (confident errors, the "I don't know" column); no family, no Holm. */
  derived: DerivedColumns;
}

export interface FamilyResult { id: string; label: string; metric: string; plan: string; comparisons: string[]; verdict_stability: number | null }

export interface HeadlineRow {
  system: string; label: string; cell: string | null; accuracy: string; personal_month_usd: number | null; latency_p50_ms: number | null;
  write_to_queryable_p50_ms: number | null; receipt: string | null;
}

export interface Scoreboard {
  schema: typeof SCOREBOARD_SCHEMA; generator: string;
  campaign: { id: string; hash: string; campaign_sha256: string; gbrain: CampaignManifest['gbrain']; measured: CampaignManifest['measured']; readers: string[] };
  inputs: Array<{ path: string; sha256: string }>;
  statistics: CampaignManifest['statistics'] & { method: string };
  power: { family1: string; detectable_difference_points: number | null; shrunk_comparators: string[] | null; sha256: string };
  sets: Array<{ id: string; label: string; benchmark: string; role: CampaignSet['role']; exposure: Exposure; exposure_label: string; cluster_unit: string; clusters: number; scheduled: number; preregistered_exclusions: Array<{ question_id: string; reason: string }> }>;
  cells: CellAggregate[]; comparisons: Comparison[]; families: FamilyResult[];
  field: { required: string[]; ran: string[]; missing: string[]; complete: boolean };
  verdict: string; headline: HeadlineRow[];
  size_curve: { sets: Array<{ id: string; label: string }>; rows: Array<{ system: string; label: string; values: string[] }> };
  losses: string[]; disclosures: string[]; staleness: string;
  derived: {
    classifier: { file: string; version: string; rules_sha256: string; source: string; per_answer: string }; pass_threshold: number; rule: string;
    systems: Array<{ system: string; sets: Array<{ set: string; cell: string } & DerivedColumns>; pooled: DerivedColumns }>;
    /** The one line under the README headline: each headline system's confident-error and correct-abstention rates on the headline set. */
    headline: string;
  };
}

export function derivedColumns(c: DerivedCounts): DerivedColumns {
  const rate = (k: number, n: number) => (n ? r6(k / n) : null);
  return { ...c, confident_error_rate: rate(c.confident_wrong, c.wrong), correct_abstention_rate: rate(c.correct_abstentions, c.abstention_answers), false_abstention_rate: rate(c.false_abstentions, c.answerable_answers) };
}

const r6 = (x: number) => { const v = Number(x.toFixed(6)); return Object.is(v, -0) ? 0 : v; };
const r6n = (x: number | null) => (x === null ? null : r6(x));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const pts = (x: number) => (100 * x).toFixed(1);
const median = (xs: readonly number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function clusterRows(pairs: ReadonlyArray<{ conversation: string; d: number }>): ClusterRow[] {
  const by = new Map<string, { n: number; sum: number }>();
  for (const p of pairs) { const c = by.get(p.conversation) ?? { n: 0, sum: 0 }; c.n++; c.sum += p.d; by.set(p.conversation, c); }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => ({ id, stratum: 'all', ...c }));
}

/** Claim sentences name the kind id; tables add the kind's plain description (kindLabel). */
function systemLabel(_kinds: Map<string, string>, system: string): string { return `\`${system}\``; }
function kindLabel(kinds: Map<string, string>, system: string): string { return `\`${system}\`: ${kinds.get(system) ?? system}`; }

interface Ctx { campaign: CampaignManifest; data: Map<string, CellData>; kinds: Map<string, string>; power: PowerReport['decision']; headSet: CampaignSet }

function metricValue(v: QuestionValue, metric: Comparison['metric']): { value: number | null; reason: string | null } {
  return metric === 'answer' ? { value: v.value, reason: v.reason } : { value: v.recall, reason: v.recall_reason };
}

function compare(ctx: Ctx, anchorId: string, otherId: string, metric: Comparison['metric'], family: Comparison['family'], joinIds: readonly string[]): Comparison {
  const A = ctx.data.get(anchorId)!, B = ctx.data.get(otherId)!;
  const set = ctx.campaign.sets.find(s => s.id === A.cell.set)!;
  const headline = set.role === 'headline';
  const id = `${otherId}${metric === 'recall_all_at_10' ? ':recall_all_at_10' : ''}`;
  const base: Comparison = {
    id, set: set.id, arm: B.cell.arm, budget: B.cell.budget, metric, anchor: anchorId, other: otherId, system: B.cell.system, family,
    cohort: null, mean_anchor: null, mean_other: null, delta: null, ci95: null, p: null, p_holm: null, method: null, mdd_points: null, sensitivity: null,
    claim_eligible: false, eligibility: [], outcome: 'not-run', sentence: '',
  };
  if (B.cell.status === 'not-run' || A.cell.status === 'not-run') return { ...base, eligibility: ['not run'] };
  const pre = new Set(set.exclusions.map(e => e.question_id));
  const scheduled = set.scheduled.filter(q => !pre.has(q.question_id) && (metric === 'answer' || A.values.get(q.question_id)?.recall_reason !== 'no gold sessions (abstention)'));
  const pairs: Array<{ question_id: string; conversation: string; a: number; b: number }> = [];
  const excluded: Cohort['excluded'] = [];
  for (const q of scheduled) {
    const a = metricValue(A.values.get(q.question_id)!, metric), b = metricValue(B.values.get(q.question_id)!, metric);
    if (a.value !== null && b.value !== null) pairs.push({ question_id: q.question_id, conversation: q.conversation, a: a.value, b: b.value });
    else excluded.push({ question_id: q.question_id, reason: [a.reason && `gbrain-defaults: ${a.reason}`, b.reason && `${B.cell.system}: ${b.reason}`].filter(Boolean).join('; ') });
  }
  if (metric === 'recall_all_at_10' && !pairs.length) return { ...base, outcome: 'not-measurable', eligibility: ['recall not measurable'], sentence: `Strict recall of all gold sessions at 10 is not measurable for ${systemLabel(ctx.kinds, B.cell.system)}.` };
  const convs = new Map<string, { scheduled: number; paired: number }>();
  for (const q of scheduled) { const c = convs.get(q.conversation) ?? { scheduled: 0, paired: 0 }; c.scheduled++; convs.set(q.conversation, c); }
  for (const p of pairs) convs.get(p.conversation)!.paired++;
  const cohort: Cohort = {
    scheduled: scheduled.length, paired: pairs.length, coverage: r6(scheduled.length ? pairs.length / scheduled.length : 0),
    clusters_scheduled: convs.size, clusters_retained: [...convs.values()].filter(c => c.paired >= CLUSTER_RETAINED_SHARE * c.scheduled).length, excluded,
  };
  const eligibility: string[] = [];
  if (cohort.coverage < MIN_COVERAGE) eligibility.push(`coverage ${pct(cohort.coverage)} is under ${pct(MIN_COVERAGE)}`);
  if (cohort.clusters_retained < set.claim_min_clusters) eligibility.push(`${cohort.clusters_retained} of ${cohort.clusters_scheduled} conversations retained, ${set.claim_min_clusters} needed`);
  for (const x of [A, B]) {
    if (x.cell.status === 'invalid') eligibility.push(`${x.cell.cell_id} is invalid`);
    if (x.missingReaders.length) eligibility.push(`${x.cell.cell_id} is missing promised readers ${x.missingReaders.join(', ')}`);
  }
  if (!pairs.length) return { ...base, cohort, outcome: 'incomplete', eligibility, sentence: incompleteSentence(ctx, set, B.cell.system, cohort) };
  const meanA = mean(pairs.map(p => p.a))!, meanB = mean(pairs.map(p => p.b))!;
  const delta = mean(pairs.map(p => p.a - p.b))!;
  const s = ctx.campaign.statistics;
  let ci95: [number, number] | null, p: number, method: string, se: number | null;
  if (headline) {
    const t = wildTest(clusterRows(pairs.map(x => ({ conversation: x.conversation, d: x.a - x.b }))), { draws: s.draws, seed: s.seed, weights: 'webb', alpha: s.alpha });
    ci95 = t.ci95; p = t.p; se = t.se; method = `restricted wild cluster bootstrap-t, Webb weights, two-sided, ${s.draws} draws`;
  } else {
    const d = clusteredPairedDelta(pairs.map(x => ({ id: x.question_id, cluster: x.conversation, a: x.b, b: x.a })), { draws: s.descriptive_draws, seed: s.seed });
    ci95 = d.ci95; p = d.p_two_sided; se = d.se_cluster; method = `cluster bootstrap percentile interval and cluster sign-flip test, ${s.descriptive_draws} draws`;
  }
  const familySize = family ? (ctx.campaign.families.find(f => f.id === family)?.comparators.length ?? 1) : 1;
  const mdd = se !== null && se > 0 ? r6(100 * se * (normalQuantile(1 - s.alpha / (2 * familySize)) + normalQuantile(0.8))) : null;
  const ex = scheduled.length - pairs.length;
  const sumA = pairs.reduce((x, q) => x + q.a, 0), sumB = pairs.reduce((x, q) => x + q.b, 0);
  const worst = (sumA - sumB - ex) / scheduled.length, best = (sumA - sumB + ex) / scheduled.length;
  const joint = scheduled.filter(q => joinIds.every(c => { const d = ctx.data.get(c)!; return d.cell.status === 'not-run' || metricValue(d.values.get(q.question_id)!, metric).value !== null; }));
  const jointPairs = joint.map(q => metricValue(A.values.get(q.question_id)!, metric).value! - metricValue(B.values.get(q.question_id)!, metric).value!);
  return {
    ...base, cohort, mean_anchor: r6(meanA), mean_other: r6(meanB), delta: r6(delta), ci95: ci95 ? [r6(ci95[0]), r6(ci95[1])] : null, p: r6(p), method, mdd_points: mdd,
    sensitivity: { worst: r6(worst), best: r6(best), joint_cohort_n: joint.length, joint_cohort_delta: r6n(mean(jointPairs)) },
    claim_eligible: headline && family !== null && eligibility.length === 0, eligibility, outcome: headline && family ? 'incomplete' : 'descriptive',
  };
}

function incompleteSentence(ctx: Ctx, set: CampaignSet, system: string, c: Cohort): string {
  return `The comparison of ${systemLabel(ctx.kinds, system)} with gbrain-defaults on ${set.label} is incomplete: ${c.paired} of ${c.scheduled} scheduled questions scored in both (${c.clusters_retained} of ${c.clusters_scheduled} conversations retained); no direction is reported.`;
}

function setScope(set: CampaignSet, cmp: Comparison): string {
  const evidence = cmp.arm === 'component' ? `${cmp.budget?.toLocaleString('en-US')} tokens of each system's own evidence` : 'each system at its own default amount of evidence';
  return `On ${set.label}, with the same three answer models and ${evidence}`;
}

function sentenceFor(ctx: Ctx, cmp: Comparison): Comparison {
  const set = ctx.campaign.sets.find(s => s.id === cmp.set)!;
  const sys = systemLabel(ctx.kinds, cmp.system);
  if (cmp.outcome === 'not-run' || cmp.outcome === 'not-measurable') {
    return cmp.sentence ? cmp : { ...cmp, sentence: `${sys} did not run on ${set.label}: ${ctx.data.get(cmp.other)!.cell.not_run_reason ?? 'not run'}.` };
  }
  if (!cmp.cohort || cmp.delta === null || cmp.mean_anchor === null || cmp.mean_other === null) return { ...cmp, outcome: 'incomplete', sentence: incompleteSentence(ctx, set, cmp.system, cmp.cohort!) };
  const a = pct(cmp.mean_anchor), b = pct(cmp.mean_other), d = pts(Math.abs(cmp.delta));
  const ci = cmp.ci95 ? `95% interval ${pts(cmp.ci95[0])} to ${pts(cmp.ci95[1])} points` : 'no interval';
  if (cmp.metric === 'recall_all_at_10') {
    return { ...cmp, sentence: `${setScope(set, cmp)}, strict recall of all gold sessions at 10 was ${a} for gbrain-defaults and ${b} for ${sys} (difference ${pts(cmp.delta)} points, ${ci}${cmp.p_holm !== null ? `, Holm-adjusted p ${cmp.p_holm.toFixed(3)}` : ''}); a retrieval diagnostic, not an answer claim.` };
  }
  if (set.role !== 'headline' || !cmp.family) {
    const n = cmp.cohort.clusters_scheduled, unit = set.cluster_unit === 'conversation' ? 'conversations' : 'questions';
    return { ...cmp, outcome: 'descriptive', sentence: `On ${set.label} (${n} ${unit}), ${sys} scored ${b} and gbrain-defaults ${a} (difference ${pts(cmp.delta)} points, ${ci}). ${n} ${unit} describe these systems on this set; they cannot rank them.` };
  }
  if (!cmp.claim_eligible) return { ...cmp, outcome: 'incomplete', sentence: `${incompleteSentence(ctx, set, cmp.system, cmp.cohort)} (${cmp.eligibility.join('; ')})` };
  if (cmp.family === 'F1' && ctx.power.family1 === 'descriptive') {
    return { ...cmp, outcome: 'descriptive', sentence: `${setScope(set, cmp)}, ${sys} scored ${b} and gbrain-defaults ${a} (difference ${pts(cmp.delta)} points, ${ci}). The preregistered power check found these conversations detect only differences of about ${ctx.power.detectable_difference_points ?? 'more than 30'} points, so this describes the systems and does not rank them.` };
  }
  if (cmp.mean_anchor >= CEILING && cmp.mean_other >= CEILING) return { ...cmp, outcome: 'ceiling', sentence: `Both answered nearly every question on ${set.label} (${a} and ${b}); it cannot separate them.` };
  if (cmp.p_holm !== null && cmp.p_holm <= ctx.campaign.statistics.alpha) {
    const [first, second, x, y] = cmp.delta > 0 ? ['gbrain-defaults', sys, a, b] : [sys, 'gbrain-defaults', b, a];
    return { ...cmp, outcome: cmp.delta > 0 ? 'gbrain-ahead' : 'gbrain-behind', sentence: `${setScope(set, cmp)}, ${first} answered more questions correctly than ${second} (${x} vs ${y}, difference ${d} points, ${ci}).` };
  }
  return { ...cmp, outcome: 'not-separated', sentence: `On ${set.label} we could not tell ${sys} and gbrain-defaults apart (${b} vs ${a}); a difference smaller than about ${cmp.mdd_points === null ? 'n/a' : cmp.mdd_points.toFixed(1)} points would not have been detected.` };
}

function verdictStability(ctx: Ctx, f: CampaignFamily, comparisons: Comparison[]): number | null {
  const anchor = ctx.data.get(f.anchor)!;
  const runs = Math.max(anchor.judgeRuns.length, ...f.comparators.map(c => ctx.data.get(c)!.judgeRuns.length));
  if (runs < 2) return null;
  const run = (d: CellData, j: number) => d.judgeRuns[j] ?? d.judgeRuns[0];
  const s = ctx.campaign.statistics;
  const conclusion = (cmp: Comparison | undefined, p: number | null, delta: number | null) => (cmp?.claim_eligible && p !== null && p <= s.alpha && delta !== null ? Math.sign(delta) : 0);
  const canonical = f.comparators.map(c => { const cmp = comparisons.find(x => x.other === c && x.metric === 'answer'); return conclusion(cmp, cmp?.p_holm ?? null, cmp?.delta ?? null); });
  let holds = 0;
  for (let j = 0; j < runs; j++) {
    const ps: number[] = [], ds: Array<number | null> = [];
    for (const c of f.comparators) {
      const cmp = comparisons.find(x => x.other === c && x.metric === 'answer');
      const B = ctx.data.get(c)!;
      const pairs = (cmp?.claim_eligible ? ctx.headSet.scheduled : []).flatMap(q => {
        const a = run(anchor, j).get(q.question_id), b = run(B, j).get(q.question_id);
        return typeof a === 'number' && typeof b === 'number' ? [{ conversation: q.conversation, d: a - b }] : [];
      });
      if (!pairs.length) { ps.push(1); ds.push(null); continue; }
      const t = wildTest(clusterRows(pairs), { draws: s.draws, seed: s.seed, weights: 'webb', alpha: s.alpha });
      ps.push(t.p); ds.push(t.theta);
    }
    const adj = holmAdjusted(ps);
    if (f.comparators.every((c, i) => conclusion(comparisons.find(x => x.other === c && x.metric === 'answer'), adj[i], ds[i]) === canonical[i])) holds++;
  }
  return r6(holds / runs);
}

// ─── Derivation ─────────────────────────────────────────────────────

/** The scoreboard and the per-cell files rendered beside it (cells/<cell_id>/derived/hedge.ndjson for every run cell). */
export interface Derivation { scoreboard: Scoreboard; hedge: Array<{ cell_id: string; text: string }> }

export const derive = (receipt: string): Scoreboard => deriveAll(receipt).scoreboard;

export function deriveAll(receipt: string): Derivation {
  const { campaign, reader } = loadCampaign(receipt);
  const powerPath = join(receipt, 'power.json');
  if (!existsSync(powerPath)) throw invalid(receipt, 'power.json is missing', 'Family 1 may claim only under the preregistered power result (plan §4.6)', { next: 'run', argv: ['bun', 'eval/runner/q1/power.ts', '--output', rel(powerPath)] });
  const powerBuf = readInput(reader, powerPath);
  const power = (JSON.parse(powerBuf.toString('utf8')) as PowerReport).decision;
  const kindList = loadKinds();
  const kinds = new Map(kindList.map(k => [k.id, k.description]));
  const headSet = campaign.sets.find(s => s.role === 'headline')!;
  const data = new Map(campaign.cells.map(c => [c.cell_id, deriveCell(reader, campaign, c)]));
  const ctx: Ctx = { campaign, data, kinds, power, headSet };
  const f1 = campaign.families.find(f => f.id === 'F1');
  if (f1 && power.family1 === 'shrunk') {
    const systems = f1.comparators.map(c => data.get(c)!.cell.system).sort();
    const want = [...(power.shrunk_comparators ?? [])].sort();
    if (systems.join() !== want.join()) throw invalid(receipt, `Family 1 compares ${systems.join(', ')}, but power.json's shrink rule kept ${want.join(', ') || 'no comparators yet'}`, 'when the power check shrinks Family 1, its comparators are the four strongest dev rows, fixed before any S1 cell runs', { next: 'run', argv: ['bun', 'eval/runner/q1/power.ts', '--dev-strength', '<dev means json>', '--output', rel(powerPath)] });
  }

  const familyOf = (cellId: string, metric: Comparison['metric']): Comparison['family'] => {
    const f = campaign.families.find(x => (metric === 'answer' ? x.id !== 'F3' : x.id === 'F3') && x.comparators.includes(cellId));
    return f ? f.id : null;
  };
  let comparisons: Comparison[] = [];
  for (const set of campaign.sets) {
    const groups = new Map<string, CampaignCell[]>();
    for (const c of campaign.cells.filter(x => x.set === set.id)) { const k = `${c.arm}|${c.budget}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
    for (const cells of groups.values()) {
      const gb = cells.filter(c => c.system === 'gbrain-defaults');
      const anchor = gb.length === 1 ? gb[0] : gb.find(c => c.anchor);
      if (!anchor) continue;
      const others = cells.filter(c => c.cell_id !== anchor.cell_id && c.system !== 'gbrain-defaults');
      const join = cells.map(c => c.cell_id);
      for (const o of others) comparisons.push(compare(ctx, anchor.cell_id, o.cell_id, 'answer', familyOf(o.cell_id, 'answer'), join));
      for (const o of others.filter(c => familyOf(c.cell_id, 'recall_all_at_10'))) comparisons.push(compare(ctx, anchor.cell_id, o.cell_id, 'recall_all_at_10', 'F3', join));
    }
  }
  const families: FamilyResult[] = [];
  for (const f of campaign.families) {
    const metric = f.id === 'F3' ? 'recall_all_at_10' : 'answer';
    const members = f.comparators.map(c => comparisons.find(x => x.other === c && x.metric === metric)!);
    const adj = holmAdjusted(members.map(m => (m.claim_eligible && m.p !== null ? m.p : 1)));
    members.forEach((m, i) => { comparisons[comparisons.indexOf(m)] = { ...m, p_holm: r6(adj[i]) }; });
    families.push({ id: f.id, label: f.label, metric, plan: f.id === 'F3' ? 'diagnostic' : f.id === 'F1' ? power.family1 : 'full', comparisons: members.map(m => m.id), verdict_stability: null });
  }
  comparisons = comparisons.map(c => sentenceFor(ctx, c));
  const f1Result = families.find(f => f.id === 'F1');
  if (f1Result && f1) f1Result.verdict_stability = verdictStability(ctx, f1, comparisons);

  const required = kindList.map(k => k.id).filter(id => id.startsWith('ext-') && !FIELD_EXEMPT[id]);
  const ran = required.filter(id => campaign.cells.some(c => c.set === headSet.id && c.system === id && c.status !== 'not-run'));
  const field = { required, ran, missing: required.filter(id => !ran.includes(id)), complete: ran.length === required.length };

  const cells: CellAggregate[] = campaign.cells.map(cell => {
    const d = data.get(cell.cell_id)!;
    const vals = [...d.values.values()];
    const valued = vals.filter(v => v.value !== null);
    const rows = [...d.rows.values()];
    const rmean = (k: keyof RowRecord) => r6n(mean(rows.map(x => x[k]).filter((x): x is number => typeof x === 'number')));
    const tokens: Record<string, number> = {};
    const tokenCounts: Record<string, number> = {};
    for (const row of rows) for (const [k, v] of Object.entries(row.delivered_tokens ?? {})) { tokens[k] = (tokens[k] ?? 0) + v; tokenCounts[k] = (tokenCounts[k] ?? 0) + 1; }
    const set = campaign.sets.find(s => s.id === cell.set)!;
    const ci = valued.length && set.role === 'headline'
      ? wildTest(clusterRows(valued.map(v => ({ conversation: v.conversation, d: v.value! }))), { draws: campaign.statistics.draws, seed: campaign.statistics.seed, alpha: campaign.statistics.alpha }).ci95
      : null;
    const lat = median(d.latencies);
    return {
      cell_id: cell.cell_id, set: cell.set, system: cell.system, arm: cell.arm, budget: cell.budget, configuration: cell.configuration, label: cell.label ?? cell.configuration,
      status: cell.status, not_run_reason: cell.not_run_reason ?? null, config_sha256: cell.config_sha256, readers: cell.readers, missing_readers: d.missingReaders,
      complete: cell.status === 'complete' && !d.missingReaders.length && valued.length === vals.filter(v => !v.reason?.startsWith('preregistered') && !v.reason?.startsWith('not applicable')).length,
      scheduled: set.scheduled.length - set.exclusions.length, valued: valued.length, mean: r6n(mean(valued.map(v => v.value!))), ci95: ci ? [r6(ci[0]), r6(ci[1])] : null,
      per_reader: Object.fromEntries(Object.entries(d.readerMeans).map(([k, v]) => [k, r6n(v)])), product_failures: d.productFailures, harness_failures: d.harnessFailures,
      judge_sd: r6n(d.judgeSd), judge_runs: d.judgeRuns.length, not_applicable: Object.fromEntries(cell.readers.filter(x => d.notApplicable[x]).map(x => [x, d.notApplicable[x]])),
      recall_all_at_10: rmean('recall_all_at_10'), recall_all_at_5: rmean('recall_all_at_5'), recall_any_at_10: rmean('recall_any_at_10'), ndcg_at_10: rmean('ndcg_at_10'),
      fill_rate: rmean('fill_rate'), delivered_tokens: Object.fromEntries(Object.keys(tokens).sort().map(k => [k, r6(tokens[k] / tokenCounts[k])])),
      latency_p50_ms: lat === null ? null : r6(lat),
      exclusions: vals.filter(v => v.reason !== null).map(v => ({ question_id: v.question_id, reason: v.reason! })),
      derived: derivedColumns(d.derived),
    };
  });

  const costPath = join(receipt, 'cost-speed.json');
  const cost = existsSync(costPath) ? (JSON.parse(readInput(reader, costPath).toString('utf8')) as CostSpeedFile) : null;
  const costFor = (cell: CampaignCell) => cost?.rows.find(x => x.system === cell.system && x.configuration === cell.configuration) ?? null;
  const headCell = (setId: string, system: string) => headCellOf(campaign, setId, system);
  const accuracy = (cell: CampaignCell | null) => {
    if (!cell) return `not run on ${headSet.label}`;
    const a = cells.find(c => c.cell_id === cell.cell_id)!;
    if (a.status === 'not-run') return `not run: ${a.not_run_reason}`;
    if (a.mean === null) return 'no scored questions';
    const label = `${pct(a.mean)} (${a.valued}/${a.scheduled}${a.ci95 ? `; 95% interval ${pct(a.ci95[0])} to ${pct(a.ci95[1])}` : ''})${cell.arm === 'whole-system' ? ', whole system' : ''}`;
    return a.complete ? label : `incomplete: ${label}`;
  };
  const order = ['gbrain-defaults', ...kindList.map(k => k.id).filter(id => id.startsWith('ext-')), 'baseline-full-context', 'baseline-file-agent', 'baseline-hybrid', 'baseline-none'];
  const receiptLink = (cell: CampaignCell) => `cells/${cell.cell_id}/receipt.json`;
  const headline: HeadlineRow[] = order.filter(sys => sys === 'gbrain-defaults' || !sys.startsWith('ext-') || campaign.cells.some(c => c.system === sys) || required.includes(sys)).map(system => {
    const cell = headCell(headSet.id, system);
    const cs = cell ? costFor(cell) : null;
    const config = system === 'gbrain-defaults' ? `shipped defaults, ${campaign.gbrain.resolved_search_mode} search` : cell?.label ?? cell?.configuration ?? '';
    return {
      system, label: `${kindLabel(kinds, system)}${config ? `; ${config}` : ''}`, cell: cell?.cell_id ?? null, accuracy: accuracy(cell),
      personal_month_usd: cs?.personal_month_usd ?? null, latency_p50_ms: cell ? cells.find(c => c.cell_id === cell.cell_id)!.latency_p50_ms : null,
      write_to_queryable_p50_ms: cs?.write_to_queryable_p50_ms ?? null, receipt: cell && cell.status !== 'not-run' ? receiptLink(cell) : null,
    };
  });

  const curveSets = ['beam-100k', 'beam-1m', 'beam-10m'].map(b => campaign.sets.find(s => s.benchmark === b)).filter((s): s is CampaignSet => !!s);
  const externals = required.map(sys => ({ sys, cell: headCell(headSet.id, sys) })).map(x => ({ ...x, mean: x.cell ? cells.find(c => c.cell_id === x.cell!.cell_id)!.mean : null })).filter(x => x.mean !== null).sort((a, b) => b.mean! - a.mean! || (a.sys < b.sys ? -1 : 1));
  const curveRows = ['gbrain-defaults', 'baseline-full-context', 'baseline-file-agent', ...(externals.length ? [externals[0].sys] : [])].map(system => ({
    system, label: system === externals[0]?.sys ? `best external row, ${kindLabel(kinds, system)}` : kindLabel(kinds, system),
    values: curveSets.map(s => { const cell = headCell(s.id, system); if (!cell) return 'not run'; const a = cells.find(c => c.cell_id === cell.cell_id)!; return a.status === 'not-run' ? `not run: ${a.not_run_reason}` : a.mean === null ? 'no scored questions' : `${pct(a.mean)} (${a.valued}/${a.scheduled})`; }),
  }));

  const derivedSystems = [...new Set(campaign.cells.map(c => c.system))].map(system => {
    const heads = campaign.sets.map(s => headCellOf(campaign, s.id, system)).filter((c): c is CampaignCell => !!c);
    const pooled = heads.reduce((acc, c) => { const d = data.get(c.cell_id)!.derived; return Object.fromEntries(Object.keys(acc).map(k => [k, acc[k as keyof DerivedCounts] + d[k as keyof DerivedCounts]])) as unknown as DerivedCounts; }, { ...NO_DERIVED });
    return { system, sets: heads.map(c => ({ set: c.set, cell: c.cell_id, ...cells.find(x => x.cell_id === c.cell_id)!.derived })), pooled: derivedColumns(pooled) };
  });
  const derivedLine = (() => {
    const rows = headline.filter(h => h.cell && cells.find(c => c.cell_id === h.cell)!.status !== 'not-run').map(h => { const d = cells.find(c => c.cell_id === h.cell)!.derived; return `\`${h.system}\` ${d.confident_error_rate === null ? 'n/a' : pct(d.confident_error_rate)} / ${d.correct_abstention_rate === null ? 'n/a' : pct(d.correct_abstention_rate)}`; });
    return `Descriptive, not tested: confident-error rate (wrong answers with no hedge or abstention) / correct-abstention rate on ${headSet.label}: ${rows.length ? rows.join('; ') : 'no system ran'}.`;
  })();

  const losses = comparisons.filter(c => c.metric === 'answer' && c.delta !== null && c.delta < 0 && c.ci95 && c.ci95[1] < 0).sort((a, b) => a.delta! - b.delta! || (a.id < b.id ? -1 : 1)).map(c => c.id);
  const f1c = comparisons.filter(c => c.family === 'F1');
  const verdict = verdictSentence(ctx, f1c, field);
  const pinText = campaign.pins.map(p => `\`${p.system}\` ${p.version}${p.latest_release && p.latest_release !== p.version ? ` (newer release available: ${p.latest_release})` : ''}`).join('; ');
  const staleness = `Measured ${campaign.measured.from} to ${campaign.measured.to} with gbrain ${campaign.gbrain.version} (\`${campaign.gbrain.commit.slice(0, 7)}\`)${pinText ? `; pinned systems: ${pinText}` : ''}.`;

  const classifier = hedgeClassifier(campaign.hedge_classifier);
  const scoreboard: Scoreboard = {
    schema: SCOREBOARD_SCHEMA, generator: 'eval/runner/scoreboard.ts',
    campaign: { id: campaign.campaign_id, hash: campaign.campaign_hash, campaign_sha256: reader.inputs.get('campaign.json')!, gbrain: campaign.gbrain, measured: campaign.measured, readers: campaign.readers },
    inputs: [...reader.inputs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, h]) => ({ path, sha256: h })),
    statistics: { ...campaign.statistics, method: 'headline set: restricted wild cluster bootstrap-t with Webb weights, two-sided, Holm within each family; public sets: cluster bootstrap interval and cluster sign-flip test, descriptive' },
    power: { family1: power.family1, detectable_difference_points: power.detectable_difference_points, shrunk_comparators: power.shrunk_comparators, sha256: sha256(powerBuf) },
    sets: campaign.sets.map(s => ({ id: s.id, label: s.label, benchmark: s.benchmark, role: s.role, exposure: s.exposure, exposure_label: EXPOSURE_LABELS[s.exposure], cluster_unit: s.cluster_unit, clusters: new Set(s.scheduled.map(q => q.conversation)).size, scheduled: s.scheduled.length, preregistered_exclusions: s.exclusions })),
    cells, comparisons, families, field, verdict, headline,
    size_curve: { sets: curveSets.map(s => ({ id: s.id, label: s.label })), rows: curveRows },
    losses, disclosures: campaign.disclosures, staleness,
    derived: {
      classifier: { file: 'eval/runner/q1/hedge.ts', version: classifier.version, rules_sha256: classifier.rules_sha256, source: 'campaign.json hedge_classifier, computed at render time', per_answer: HEDGE_FILE }, pass_threshold: PASS_THRESHOLD,
      rule: 'replicate-0 answers of every promised reader with a scored canonical judgment; wrong = canonical score below the pass threshold; confident-error rate = wrong answers the classifier calls confident / wrong answers; correct-abstention rate = abstention-question answers the canonical instrument passes / abstention-question answers; false-abstention rate = answers to questions with gold evidence the classifier calls abstain / those answers; pooled sums counts over the system\'s head cells on every set; descriptive, no Holm family',
      systems: derivedSystems, headline: derivedLine,
    },
  };
  return { scoreboard, hedge: campaign.cells.filter(c => c.status !== 'not-run').map(c => ({ cell_id: c.cell_id, text: data.get(c.cell_id)!.hedgeLines })) };
}

/** A system's row on a set: the cell marked `headline`, else its 8k component cell, else its first whole-system cell. */
export function headCellOf(campaign: CampaignManifest, setId: string, system: string): CampaignCell | null {
  const xs = campaign.cells.filter(c => c.set === setId && c.system === system);
  return xs.find(c => c.headline) ?? xs.find(c => c.arm === 'component' && c.budget === 8000) ?? xs.find(c => c.arm === 'whole-system') ?? null;
}

function verdictSentence(ctx: Ctx, f1: Comparison[], field: Scoreboard['field']): string {
  const c = ctx.campaign, set = ctx.headSet;
  const when = `On ${set.label} (${EXPOSURE_LABELS[set.exposure]}), measured ${c.measured.to} at gbrain \`${c.gbrain.commit.slice(0, 7)}\``;
  const mdd = ctx.power.detectable_difference_points;
  const incompleteField = field.complete ? '' : ` The table is incomplete: ${field.missing.map(k => `\`${k}\``).join(', ')} did not run on ${set.label}, so no field-wide claim is made.`;
  if (!f1.length) return `${when}, no component comparison was run.${incompleteField}`;
  if (ctx.power.family1 === 'descriptive') return `${when}, the component comparison is descriptive: with these conversations it detects only differences of about ${mdd ?? 'more than 30'} points, so no row is ranked.${incompleteField}`;
  const ahead = f1.filter(x => x.outcome === 'gbrain-ahead').length, behind = f1.filter(x => x.outcome === 'gbrain-behind').length;
  const incomplete = f1.filter(x => x.outcome === 'incomplete' || x.outcome === 'not-run').length;
  if (field.complete && ahead === f1.length) return `${when}, gbrain-defaults beat the field: with the same three answer models and 8,000 tokens of evidence it answered more questions correctly than every other component row after Holm correction (detectable difference about ${mdd} points).`;
  const rest = f1.length - ahead - behind - incomplete;
  return `${when}, with the same three answer models and 8,000 tokens of evidence, gbrain-defaults led ${ahead} of ${f1.length} component rows and trailed ${behind} after Holm correction; ${rest} could not be told apart (detectable difference about ${mdd} points)${incomplete ? `, and ${incomplete} ${incomplete === 1 ? 'comparison is' : 'comparisons are'} incomplete` : ''}.${incompleteField}`;
}

// ─── Layer 6: Markdown ──────────────────────────────────────────────

const money = (x: number | null) => (x === null ? 'not measured' : `$${x.toFixed(2)}`);
const ms = (x: number | null) => (x === null ? 'not measured' : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const cellText = (s: string) => s.replace(/\|/g, '\\|');

/** The README block: verdict, six-column headline table, size curve, losses, disclosures, staleness. `base` is the receipt path relative to the target file. */
export function renderHeadline(sb: Scoreboard, base: string): string {
  const head = sb.sets.find(s => s.role === 'headline')!;
  const lines = [sb.verdict, '', `| Kind and configuration | ${head.label} accuracy at 8k, three-reader mean | Dollars per month, personal agent | p50 answer latency | Write to queryable, p50 | Receipt |`, '|---|---|---|---|---|---|'];
  for (const r of sb.headline) lines.push(`| ${cellText(r.label)} | ${cellText(r.accuracy)} | ${money(r.personal_month_usd)} | ${ms(r.latency_p50_ms)} | ${ms(r.write_to_queryable_p50_ms)} | ${r.receipt ? `[cell](${base}/${r.receipt})` : 'none'} |`);
  lines.push('', sb.derived.headline);
  if (sb.size_curve.sets.length) {
    lines.push('', `| System | ${sb.size_curve.sets.map(s => s.label).join(' | ')} |`, `|---|${sb.size_curve.sets.map(() => '---|').join('')}`);
    for (const r of sb.size_curve.rows) lines.push(`| ${cellText(r.label)} | ${r.values.map(cellText).join(' | ')} |`);
  }
  lines.push('');
  for (const s of sb.sets) lines.push(`- ${s.label}: ${s.exposure_label}.`);
  const losses = sb.losses.slice(0, 3).map(id => sb.comparisons.find(c => c.id === id)!);
  if (losses.length) for (const l of losses) lines.push(`- Where gbrain loses: ${l.sentence}`);
  for (const d of sb.disclosures) lines.push(`- ${d}`);
  lines.push(`- ${sb.staleness}`, `- Full tables, cohorts and exclusions: [scoreboard report](${base}/scoreboard.md).`);
  return lines.join('\n') + '\n';
}

export function renderReport(sb: Scoreboard): string {
  const out = [`# Scoreboard tables: ${sb.campaign.id}`, '', 'Generated by `bun eval/runner/scoreboard.ts render` from this directory\'s rows, answers and judgments; `bun eval/runner/scoreboard.ts check` regenerates it byte for byte.', '', '## Headline', '', renderHeadline(sb, '.').trimEnd(), ''];
  out.push('## Cells', '', '| Cell | Set | System | Arm | Budget | Accuracy | Scored | Product failures | Harness failures | Judge SD | recall_all@10 | Fill rate | Confident-error rate | Correct abstention | False abstention | Status |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const num = (x: number | null, f: (x: number) => string) => (x === null ? 'n/a' : f(x));
  const ratio = (r: number | null, k: number, n: number) => (r === null ? 'n/a' : `${pct(r)} (${k}/${n})`);
  const dcols = (d: DerivedColumns) => `${ratio(d.confident_error_rate, d.confident_wrong, d.wrong)} | ${ratio(d.correct_abstention_rate, d.correct_abstentions, d.abstention_answers)} | ${ratio(d.false_abstention_rate, d.false_abstentions, d.answerable_answers)}`;
  for (const c of sb.cells) out.push(`| \`${c.cell_id}\` | ${c.set} | \`${c.system}\` | ${c.arm} | ${c.budget ?? 'default'} | ${num(c.mean, pct)} | ${c.valued}/${c.scheduled} | ${c.product_failures} | ${c.harness_failures} | ${num(c.judge_sd, x => x.toFixed(3))} | ${num(c.recall_all_at_10, pct)} | ${num(c.fill_rate, x => x.toFixed(3))} | ${dcols(c.derived)} | ${c.status === 'not-run' ? `not run: ${cellText(c.not_run_reason ?? '')}` : c.complete ? 'complete' : 'incomplete'}${c.missing_readers.length ? `; missing readers ${c.missing_readers.join(', ')}` : ''}${Object.entries(c.not_applicable).map(([r, n]) => `; ${n} did not fit ${r}'s window`).join('')} |`);
  out.push('', '## Per-reader accuracy', '', `| Cell | ${sb.campaign.readers.join(' | ')} |`, `|---|${sb.campaign.readers.map(() => '---|').join('')}`);
  for (const c of sb.cells.filter(x => x.status !== 'not-run')) out.push(`| \`${c.cell_id}\` | ${sb.campaign.readers.map(r => (r in c.per_reader ? num(c.per_reader[r], pct) : 'not promised')).join(' | ')} |`);
  const dv = sb.derived;
  out.push('', '## Derived columns by system and set', '', `Descriptive only, with no family and no Holm correction. Classifier \`${dv.classifier.file}\` ${dv.classifier.version}, rule table sha256 \`${dv.classifier.rules_sha256}\` (${dv.classifier.source}; per-answer verdicts in \`${dv.classifier.per_answer}\`); an answer is wrong below a canonical score of ${dv.pass_threshold}. Counted: ${dv.rule}.`, '');
  out.push('| System | Set | Cell | Confident-error rate | Correct abstention | False abstention |', '|---|---|---|---|---|---|');
  for (const s of dv.systems) {
    for (const x of s.sets) out.push(`| \`${s.system}\` | ${x.set} | \`${x.cell}\` | ${dcols(x)} |`);
    if (s.sets.length > 1) out.push(`| \`${s.system}\` | all sets, pooled | | ${dcols(s.pooled)} |`);
  }
  for (const f of sb.families) {
    out.push('', `## Family ${f.id}: ${f.label}`, '', `Plan: ${f.plan}. Metric: ${f.metric}. Holm within the family.${f.verdict_stability !== null ? ` Verdict stability over judge runs: ${pct(f.verdict_stability)}.` : ''}`, '');
    out.push('| Comparison | gbrain-defaults | Other | Difference (points) | 95% interval | p | Holm p | Cohort | Conversations | Bounds (points) | Outcome |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const id of f.comparisons) out.push(comparisonRow(sb.comparisons.find(c => c.id === id)!));
  }
  out.push('', '## Descriptive comparisons', '', '| Comparison | gbrain-defaults | Other | Difference (points) | 95% interval | p | Holm p | Cohort | Conversations | Bounds (points) | Outcome |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of sb.comparisons.filter(x => !x.family)) out.push(comparisonRow(c));
  out.push('', '## Claim sentences', '');
  for (const c of sb.comparisons) out.push(`- \`${c.id}\`: ${c.sentence}`);
  out.push('', '## Exclusions', '');
  for (const c of sb.comparisons.filter(x => x.cohort?.excluded.length)) out.push(`- \`${c.id}\` (${c.cohort!.excluded.length}): ${c.cohort!.excluded.map(e => `${e.question_id} (${e.reason})`).join(', ')}`);
  for (const s of sb.sets.filter(x => x.preregistered_exclusions.length)) out.push(`- ${s.label}, preregistered: ${s.preregistered_exclusions.map(e => `${e.question_id} (${e.reason})`).join(', ')}`);
  out.push('', '## Inputs', '', `Campaign \`${sb.campaign.id}\`, campaign hash \`${sb.campaign.hash}\`. ${sb.statistics.method}.`, '');
  for (const i of sb.inputs) out.push(`- \`${i.path}\` sha256 \`${i.sha256}\``);
  return out.join('\n') + '\n';
}

function comparisonRow(c: Comparison): string {
  const n = (x: number | null, f: (x: number) => string) => (x === null ? 'n/a' : f(x));
  return `| \`${c.id}\` | ${n(c.mean_anchor, pct)} | ${n(c.mean_other, pct)} | ${n(c.delta, pts)} | ${c.ci95 ? `${pts(c.ci95[0])} to ${pts(c.ci95[1])}` : 'n/a'} | ${n(c.p, x => x.toFixed(4))} | ${n(c.p_holm, x => x.toFixed(4))} | ${c.cohort ? `${c.cohort.paired}/${c.cohort.scheduled}` : 'n/a'} | ${c.cohort ? `${c.cohort.clusters_retained}/${c.cohort.clusters_scheduled}` : 'n/a'} | ${c.sensitivity ? `${pts(c.sensitivity.worst)} to ${pts(c.sensitivity.best)}` : 'n/a'} | ${c.outcome} |`;
}

export function scoreboardJson(sb: Scoreboard): string { return JSON.stringify(sb, null, 2) + '\n'; }

function replaceBlock(text: string, block: string): string | null {
  const a = text.indexOf(README_BEGIN), b = text.indexOf(README_END);
  if (a < 0 || b < a) return null;
  return `${text.slice(0, a + README_BEGIN.length)}\n${block}${text.slice(b)}`;
}

export interface Rendered { files: Array<{ path: string; text: string }> }

export function renderAll(receipt: string, d: Derivation, campaign: CampaignManifest): Rendered {
  const sb = d.scoreboard;
  const files = [{ path: join(receipt, 'scoreboard.json'), text: scoreboardJson(sb) }, { path: join(receipt, 'scoreboard.md'), text: renderReport(sb) }, ...d.hedge.map(h => ({ path: join(receipt, HEDGE_FILE.replace('<cell_id>', h.cell_id)), text: h.text }))];
  for (const t of campaign.render_targets) {
    const path = resolve(ROOT, t);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const next = replaceBlock(current, renderHeadline(sb, relative(dirname(path), receipt)));
    if (next === null) throw invalid(receipt, `${t} has no ${README_BEGIN} … ${README_END} block`, 'the README headline is generated into a marked block so check can compare it byte for byte', { next: 'report', user_message: `add the two marker lines to ${t} where the headline belongs, then run render` });
    files.push({ path, text: next });
  }
  return { files };
}

// ─── check ──────────────────────────────────────────────────────────

/** First differing path between two JSON values, for an actionable drift message. */
export function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return `${path || '(root)'}: committed ${JSON.stringify(a)?.slice(0, 80)}, recomputed ${JSON.stringify(b)?.slice(0, 80)}`;
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
  for (const k of keys) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

export interface PinEntry { kind: string; product: string; package: string; image: string | null; lock_file: string | null; lock_sha256: string | null; capability_sha256: string | null; vendor_benchmark_code: string }

export function checkPinTable(root = ROOT): ScoreboardMessage[] {
  const page = join(root, 'docs/comparison-systems.md');
  const text = readFileSync(page, 'utf8');
  const marker = text.indexOf('machine-readable pin table');
  const fence = marker >= 0 ? /```json\n([\s\S]*?)\n```/.exec(text.slice(marker)) : null;
  const fix = (user_message: string): OperatorFix => ({ next: 'report', user_message, verify: ['bun', 'eval/runner/scoreboard.ts', 'check'] });
  if (!fence) return [{ code: 'PIN_TABLE_MISMATCH', message: 'docs/comparison-systems.md has no ```json pin table after "machine-readable pin table"', why: 'the install bootstrap and check read the pinned versions and hashes from that fence', fix: fix('restore the fenced pin table') }];
  let pins: PinEntry[];
  try { pins = JSON.parse(fence[1]) as PinEntry[]; } catch { return [{ code: 'PIN_TABLE_MISMATCH', message: 'the pin table fence is not valid JSON', why: 'the fence is machine-read', fix: fix('fix the JSON in the fence') }]; }
  const out: ScoreboardMessage[] = [];
  const bad = (message: string, user: string) => out.push({ code: 'PIN_TABLE_MISMATCH', message, why: 'a historical install is rebuilt from the pinned lockfile and capability record; their hashes must match the bundle files', fix: fix(user) });
  const kinds = new Map(loadKinds().map(k => [k.id, k]));
  const seen = new Set<string>();
  for (const p of pins) {
    for (const k of ['kind', 'product', 'package', 'vendor_benchmark_code'] as const) if (typeof p[k] !== 'string' || !p[k]) bad(`pin entry ${p.kind ?? '?'} has no ${k}`, `fill ${k} in the pin table`);
    if (!kinds.has(p.kind)) { bad(`pin entry ${p.kind} is not a kind id in eval/systems/kinds.json`, 'use the kind id'); continue; }
    if (seen.has(p.kind)) bad(`pin entry ${p.kind} appears twice`, 'keep one entry per kind');
    seen.add(p.kind);
    const dir = join(root, 'docs/comparison-systems', p.kind);
    if (p.lock_file !== null) {
      const lock = join(root, p.lock_file);
      if (!p.lock_file.startsWith(`docs/comparison-systems/${p.kind}/`)) bad(`pin entry ${p.kind} lock_file ${p.lock_file} is outside its bundle`, 'point lock_file at the bundle\'s lockfile');
      else if (!existsSync(lock)) bad(`pin entry ${p.kind} lock_file ${p.lock_file} does not exist`, 'restore the lockfile or set lock_file to null');
      else if (sha256(readFileSync(lock)) !== p.lock_sha256) bad(`pin entry ${p.kind}: ${p.lock_file} sha256 is ${sha256(readFileSync(lock))}, the table records ${p.lock_sha256}`, 'a changed lockfile is a new pin: update the version and lock_sha256 together, with a changelog entry');
    } else if (p.lock_sha256 !== null) bad(`pin entry ${p.kind} has lock_sha256 without lock_file`, 'set both or neither');
    const cap = join(dir, 'capability.json');
    if (p.capability_sha256 !== null) {
      if (!existsSync(cap)) bad(`pin entry ${p.kind} records a capability hash but ${rel(cap)} does not exist`, 'restore the capability record');
      else if (sha256(readFileSync(cap)) !== p.capability_sha256) bad(`pin entry ${p.kind}: capability.json sha256 is ${sha256(readFileSync(cap))}, the table records ${p.capability_sha256}`, 'a changed capability record needs its new hash in the pin table and a changelog entry');
    } else if (existsSync(cap)) bad(`pin entry ${p.kind} has no capability_sha256 but its bundle has capability.json`, 'record the capability hash');
  }
  const bundles = existsSync(join(root, 'docs/comparison-systems')) ? readdirSync(join(root, 'docs/comparison-systems'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : [];
  for (const b of bundles) if (!seen.has(b)) bad(`bundle docs/comparison-systems/${b}/ has no pin table entry`, 'add its pin entry');
  for (const k of kinds.values()) if (k.id.startsWith('ext-') && !seen.has(k.id)) bad(`kind ${k.id} has no pin table entry`, 'add its pin entry (package "pinned when its bundle lands" until then)');
  return out;
}

/** Every committed file of a receipt; local release-asset downloads are not part of the tree budget. */
function treeSize(dir: string, receipt = dir): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (p !== join(receipt, 'release-assets')) out.push(...treeSize(p, receipt)); }
    else if (e.isFile()) out.push({ path: p, bytes: statSync(p).size });
  }
  return out;
}

export function checkSize(receipt: string): ScoreboardMessage[] {
  const files = treeSize(receipt);
  const out: ScoreboardMessage[] = [];
  const fix: OperatorFix = { next: 'report', user_message: 'move contexts and transcripts to release assets (sha256 in campaign.json release_assets) and keep rows and judge outputs in the tree', verify: checkArgv(receipt) };
  for (const f of files.filter(x => x.bytes > MAX_FILE_BYTES)) out.push({ code: 'RECEIPT_TOO_LARGE', message: `${rel(f.path)} is ${(f.bytes / 1048576).toFixed(1)} MB, over the 50 MB file limit`, why: 'large artifacts ship as release assets so the repository stays clonable', fix });
  const total = files.reduce((s, f) => s + f.bytes, 0);
  if (total > MAX_TREE_BYTES) out.push({ code: 'RECEIPT_TOO_LARGE', message: `${rel(receipt)} holds ${(total / 1048576).toFixed(1)} MB, over the 60 MB receipt budget`, why: 'large artifacts ship as release assets so the repository stays clonable', fix });
  return out;
}

export function checkAssets(receipt: string, campaign: CampaignManifest): { messages: ScoreboardMessage[]; verified: number; absent: number } {
  const messages: ScoreboardMessage[] = [];
  let verified = 0, absent = 0;
  for (const a of campaign.release_assets) {
    const path = join(receipt, 'release-assets', a.name);
    if (!existsSync(path)) { absent++; continue; }
    const h = sha256(readFileSync(path));
    if (h !== a.sha256) messages.push({ code: 'ASSET_HASH_MISMATCH', message: `release asset ${a.name} has sha256 ${h}, campaign.json records ${a.sha256}`, why: 'contexts and transcripts are published as release assets whose hashes the campaign froze', fix: { next: 'report', user_message: 'download the asset again from the release named in campaign.json; never rewrite the recorded hash', verify: checkArgv(receipt) } });
    else verified++;
  }
  return { messages, verified, absent };
}

export function findReceipts(root = ROOT): string[] {
  const dir = join(root, 'docs/benchmarks');
  const dirs = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(dir, e.name)).sort();
  return dirs.filter(d => existsSync(join(d, 'campaign.json')))
    .filter(d => { try { return (JSON.parse(readFileSync(join(d, 'campaign.json'), 'utf8')) as { schema?: string }).schema === CAMPAIGN_SCHEMA; } catch { return false; } });
}

export interface CheckResult { receipt: string; ok: boolean; messages: ScoreboardMessage[]; notes: string[] }

export function checkReceipt(receipt: string, env: Record<string, string | undefined> = process.env): CheckResult {
  const messages: ScoreboardMessage[] = [], notes: string[] = [];
  messages.push(...checkSize(receipt));
  const scan = scanTree([receipt], { env, base: ROOT });
  const secret = secretMessage(scan.findings, [rel(receipt)]);
  if (secret) messages.push(secret);
  notes.push(`secret scan: ${scan.files} files`);
  try {
    const { campaign } = loadCampaign(receipt);
    const assets = checkAssets(receipt, campaign);
    messages.push(...assets.messages);
    notes.push(`release assets: ${assets.verified} verified, ${assets.absent} not present locally`);
    for (const f of renderAll(receipt, deriveAll(receipt), campaign).files) {
      const committed = existsSync(f.path) ? readFileSync(f.path, 'utf8') : null;
      if (committed === f.text) continue;
      const detail = committed === null ? 'is missing' : f.path.endsWith('.json') ? `differs at ${firstDifference(safeJson(committed), JSON.parse(f.text))}` : `differs from the regenerated text at line ${firstLine(committed, f.text)}`;
      messages.push({ code: 'SCOREBOARD_STALE', message: `${rel(f.path)} ${detail}`, why: 'every published number must regenerate byte for byte from the committed rows, answers and judgments', fix: { next: 'report', user_message: 'if a receipt input changed, find out why before anything else (inputs are immutable once counted); if only the generator changed, run render and commit the regenerated files', argv: ['bun', 'eval/runner/scoreboard.ts', 'render', '--receipt', rel(receipt)], verify: checkArgv(receipt) } });
    }
  } catch (e) {
    if (e instanceof ScoreboardError) messages.push(e.op); else throw e;
  }
  return { receipt, ok: !messages.length, messages, notes };
}

const safeJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return t; } };
const firstLine = (a: string, b: string) => { const x = a.split('\n'), y = b.split('\n'); let i = 0; while (i < x.length && x[i] === y[i]) i++; return i + 1; };

// ─── explain ────────────────────────────────────────────────────────

export const EXPLAIN_COLUMNS = ['accuracy', 'cost', 'latency', 'queryable', 'receipt', 'size-100k', 'size-1m', 'size-10m', 'comparison', 'recall', 'confident-error', 'abstention'] as const;

export function explain(receipt: string, row: string, column: string): Record<string, unknown> {
  const sb = derive(receipt);
  const unknown = (what: string, choices: string[]) => new ScoreboardError({ code: 'EXPLAIN_UNKNOWN', message: `unknown ${what}`, why: 'explain traces one published number back to its receipt', fix: { next: 'run', argv: ['bun', 'eval/runner/scoreboard.ts', 'explain', choices[0] ?? '<row>', 'accuracy', '--receipt', rel(receipt)], user_message: `choose one of: ${choices.join(', ')}`, verify: checkArgv(receipt) } });
  if (!(EXPLAIN_COLUMNS as readonly string[]).includes(column)) throw unknown(`column ${column}`, [...EXPLAIN_COLUMNS]);
  const size = column.startsWith('size-') ? sb.sets.find(s => s.benchmark === `beam-${column.slice(5)}`) : null;
  if (column.startsWith('size-') && !size) throw unknown(`size-curve column ${column} (no such set in this campaign)`, sb.size_curve.sets.map(s => s.id));
  const camp = JSON.parse(readFileSync(join(receipt, 'campaign.json'), 'utf8')) as CampaignManifest;
  const head = sb.headline.find(h => h.system === row);
  const cellId = size ? headCellOf(camp, size.id, row)?.cell_id : sb.cells.some(c => c.cell_id === row) ? row : head?.cell ?? null;
  if (!cellId) throw unknown(`row ${row}`, [...sb.headline.map(h => h.system), ...sb.cells.map(c => c.cell_id)]);
  const cell = sb.cells.find(c => c.cell_id === cellId)!;
  const cmp = sb.comparisons.find(c => c.other === cellId && c.metric === (column === 'recall' ? 'recall_all_at_10' : 'answer')) ?? null;
  const cc = camp.cells.find(c => c.cell_id === cellId)!;
  const value = column === 'accuracy' || column.startsWith('size-') ? { mean: cell.mean, ci95: cell.ci95, scored: cell.valued, scheduled: cell.scheduled, rule: 'per question: mean over the promised readers of each reader\'s mean canonical judge score (replicate 0 judgments of the canonical instrument); per cell: mean over scored questions; interval by inverting the restricted wild cluster bootstrap-t over conversations' }
    : column === 'latency' ? { latency_p50_ms: cell.latency_p50_ms, rule: 'median over scored replicate-0 answers of the answer latency plus the row\'s retrieval latency' }
      : column === 'cost' || column === 'queryable' ? { personal_month_usd: head?.personal_month_usd ?? null, write_to_queryable_p50_ms: head?.write_to_queryable_p50_ms ?? null, source: 'cost-speed.json' }
        : column === 'recall' ? { recall_all_at_10: cell.recall_all_at_10, rule: 'mean of rows.ndjson recall_all_at_10 over rows with gold sessions' }
          : column === 'comparison' ? cmp
            : column === 'confident-error' || column === 'abstention' ? { ...cell.derived, classifier: sb.derived.classifier, per_answer: HEDGE_FILE.replace('<cell_id>', cellId), pass_threshold: sb.derived.pass_threshold, rule: sb.derived.rule }
              : { receipt: `cells/${cellId}/receipt.json` };
  const inputs = sb.inputs.filter(i => i.path.startsWith(`cells/${cellId}/`) || i.path === 'campaign.json' || i.path === 'power.json');
  return {
    receipt: rel(receipt), row, column, cell: cellId, campaign: sb.campaign.id, campaign_hash: sb.campaign.hash, config_sha256: cell.config_sha256,
    readers: cell.readers, judge_instrument: cc.canonical_instrument, value,
    cohort: cmp?.cohort ? { paired: cmp.cohort.paired, scheduled: cmp.cohort.scheduled, clusters_retained: cmp.cohort.clusters_retained, clusters_scheduled: cmp.cohort.clusters_scheduled, excluded: cmp.cohort.excluded } : null,
    cell_exclusions: cell.exclusions, comparison: cmp ? { id: cmp.id, family: cmp.family, delta: cmp.delta, ci95: cmp.ci95, p: cmp.p, p_holm: cmp.p_holm, outcome: cmp.outcome, sentence: cmp.sentence } : null,
    inputs, verify: checkArgv(receipt),
  };
}

// ─── CLI ────────────────────────────────────────────────────────────

function emit(op: ScoreboardMessage, json: boolean): void {
  if (json) console.log(JSON.stringify(op, null, 2));
  else console.error(renderMessage(op));
}

function receiptsFrom(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === '--receipt' && argv[i + 1]) out.push(resolve(argv[i + 1])); });
  return out.length ? out : findReceipts();
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const [command, ...rest] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--receipt');
  const usage: ScoreboardMessage = { code: 'USAGE', message: `unknown command ${command ?? '(none)'}`, why: 'the generator has three commands: check, render, explain', fix: { next: 'run', argv: ['bun', 'eval/runner/scoreboard.ts', 'check'], verify: ['bun', 'eval/runner/scoreboard.ts', 'check'] } };
  try {
    if (command === 'check') {
      const pinMessages = checkPinTable();
      const receipts = receiptsFrom(argv);
      const results = receipts.map(r => checkReceipt(r));
      const messages = [...pinMessages, ...results.flatMap(r => r.messages)];
      if (json) console.log(JSON.stringify({ ok: !messages.length, pin_table: pinMessages.length ? 'mismatch' : 'ok', receipts: results.map(r => ({ receipt: rel(r.receipt), ok: r.ok, notes: r.notes, messages: r.messages })), ...(pinMessages.length ? { pin_messages: pinMessages } : {}) }, null, 2));
      else {
        for (const m of messages) emit(m, false);
        if (!messages.length) console.log(`scoreboard check: ok (pin table ok; ${receipts.length ? results.map(r => `${rel(r.receipt)}: ${r.notes.join(', ')}`).join('; ') : 'no scoreboard receipts committed yet'})`);
      }
      process.exit(messages.length ? Math.max(...messages.map(exitCode)) : 0);
    } else if (command === 'render') {
      const receipts = receiptsFrom(argv);
      if (!receipts.length) throw new ScoreboardError({ code: 'RECEIPT_MISSING', message: 'no scoreboard receipt found under docs/benchmarks', why: 'render writes scoreboard.json and the tables from a receipt\'s campaign.json', fix: { next: 'report', user_message: 'pass --receipt <dir> for the receipt to render', verify: ['bun', 'eval/runner/scoreboard.ts', 'check'] } });
      for (const r of receipts) {
        const { campaign } = loadCampaign(r);
        const d = deriveAll(r);
        for (const f of renderAll(r, d, campaign).files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.text); }
        if (json) console.log(JSON.stringify({ receipt: rel(r), verdict: d.scoreboard.verdict }, null, 2)); else console.log(`rendered ${rel(r)}: ${d.scoreboard.verdict}`);
      }
    } else if (command === 'explain') {
      const [row, column] = rest;
      if (!row || !column) throw new ScoreboardError({ ...usage, message: 'explain needs <row> <column>', fix: { next: 'run', argv: ['bun', 'eval/runner/scoreboard.ts', 'explain', 'gbrain-defaults', 'accuracy'], user_message: `columns: ${EXPLAIN_COLUMNS.join(', ')}` } });
      const receipts = receiptsFrom(argv);
      if (receipts.length !== 1) throw new ScoreboardError({ code: 'RECEIPT_MISSING', message: `explain needs exactly one receipt, found ${receipts.length}`, why: 'one number comes from one receipt', fix: { next: 'run', argv: ['bun', 'eval/runner/scoreboard.ts', 'explain', row, column, '--receipt', '<dir>'] } });
      const out = explain(receipts[0], row, column);
      console.log(json ? JSON.stringify(out, null, 2) : Object.entries(out).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n'));
    } else throw new ScoreboardError(usage);
  } catch (e) {
    if (!(e instanceof ScoreboardError)) throw e;
    emit(e.op, json);
    process.exit(exitCode(e.op));
  }
}

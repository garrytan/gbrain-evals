/**
 * Tuned and tuning configurations of the entity-dedupe head-to-head's memory systems (preregistration, "Arms", "Budget"
 * and Amendment 2 (2026-11-18)): each system with a documented dedupe knob runs its default and every grid setting once
 * on the held-out slice (seed 20261118 at 5 instances per family), choose applies Amendment 2's rule to those slice runs,
 * and the chosen setting then runs once on the scored seed as the tuned cell. A system with no documented dedupe setting
 * has no tuned run: its tuned cell is its default cell.
 *
 * Each system's knob and grid live in its bundle's capability record (docs/comparison-systems/<kind>/entity-h2h/
 * capability.json, entity_h2h_tuning), with the doc links and source lines. A memory cell's --config is one of
 *
 *   default          the documented defaults (the record's default settings)
 *   tuning:<name>    one slice run, <name> a grid setting or default (the baseline), on the held-out seed at 5 per
 *                    family only (TUNING_SEED otherwise)
 *   tuned            the setting a choice record names (run.ts choose); never on the held-out seed (TUNING_SEED), never
 *                    without a usable record (TUNING_CHOICE), and never when the rule chose default or the system has
 *                    no documented setting, because then the tuned cell is the default cell (TUNED_IS_DEFAULT)
 *
 * The rule (Amendment 2), on the automatic tier, people and companies combined: candidates are default and every grid
 * setting; a candidate is eligible when its must-link recall is at least default's less 5 points, compared exactly by
 * integer cross-multiplication (20 * k_s * n_d >= 20 * k_d * n_s - n_s * n_d); the winner is the eligible candidate with
 * the lowest false-merge rate (exact cross-multiplied counts), then the nearest default in the knob's value (|value -
 * default| rounded to 1e-9; default is at 0), then the higher recall, then the first in grid order (default first).
 * choose takes no pick from an operator.
 *
 * The cell records the exact settings (cell.json stack). The launcher starts the stack from them (run.ts stack-env),
 * the shim reports what it applied under GET /health entity_h2h, and the runner refuses a cell whose stack reports any
 * other setting or settings (STACK_CONFIG_MISMATCH) before it opens an attempt.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunnerRefusal } from '../runner-refusal.ts';
import { readCell } from './ledger.ts';
import { MEMORY_KINDS, TUNING_PER_FAMILY, TUNING_SETTINGS } from './rates.ts';
import { parseOutput, scoreOutput, type OutputScore } from './score.ts';
import { HELD_OUT_SEED, loadWorld } from './world.ts';

const BUNDLES = resolve(import.meta.dir, '../../../docs/comparison-systems');

/** The rule a choice record cites; readChoice accepts no other. */
export const RULE = 'preregistration Amendment 2 (2026-11-18): lowest automatic false-merge rate on the held-out slice, people and companies combined, among default and the grid settings whose combined must-link recall is at most 5 points below default\'s; ties go to the setting nearest default in the knob\'s value, then to higher recall, then to grid order';

export type Settings = Record<string, number | boolean | string>;
export interface Tuning {
  knob: string | null;
  applied_by: 'shim' | 'server-env' | null;
  docs: string[];
  no_knob?: string;
  default: Settings;
  grid: Record<string, { settings: Settings }>;
}
export interface Count { k: number; n: number }
export interface Candidate {
  setting: string;
  settings: Settings;
  /** |value - default| summed over the knob, rounded to 1e-9; 0 for default. */
  distance: number;
  /** Automatic tier, people and companies combined: designed must-not-link pairs merged, and must-link pairs joined. */
  false_merge: Count;
  recall: Count;
  eligible: boolean;
  dir?: string;
  cell_sha256?: string;
  output_sha256?: string;
}
export interface TuningChoice {
  choice: 'entity-h2h-tuning-choice';
  system: string;
  setting: string;
  settings: Settings;
  rule: string;
  eligibility: string;
  grid_sha256: string;
  held_out: { seed: number; per_family: number; pages?: number; people_ledger_sha256?: string; company_ledger_sha256?: string };
  candidates: Candidate[];
  at: string;
}
export interface StackSetting { kind: 'default' | 'tuning' | 'tuned'; setting: string; settings: Settings; choice?: TuningChoice }

const SETTING_NAME = /^[a-z0-9][a-z0-9.-]{0,40}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const ELIGIBILITY = 'integer cross-multiplication: 20 * k_s * n_d >= 20 * k_d * n_s - n_s * n_d';

/** Canonical JSON (sorted keys), so two settings objects compare by value. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A memory system's knob and grid, from its bundle's capability record; throws on a record that breaks the rules. */
export function tuningOf(kind: string): Tuning {
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw new Error(`entity-h2h: ${kind} is not a memory-system kind (${MEMORY_KINDS.join(', ')})`);
  const t = (JSON.parse(readFileSync(join(BUNDLES, kind, 'entity-h2h', 'capability.json'), 'utf8')) as { entity_h2h_tuning?: Tuning }).entity_h2h_tuning;
  if (!t) throw new Error(`entity-h2h: ${kind}'s entity-h2h capability record has no entity_h2h_tuning`);
  const names = Object.keys(t.grid);
  if (names.length > TUNING_SETTINGS) throw new Error(`entity-h2h: ${kind}'s tuning grid has ${names.length} settings; the preregistration allows at most ${TUNING_SETTINGS}`);
  if (!t.knob !== !names.length || !t.knob !== !t.applied_by || (!t.knob && !t.no_knob)) throw new Error(`entity-h2h: ${kind}'s entity_h2h_tuning must name a knob, how it is applied and a grid, or no knob with the reason`);
  for (const n of names) {
    if (n === 'default' || !SETTING_NAME.test(n)) throw new Error(`entity-h2h: ${kind}'s tuning setting name ${JSON.stringify(n)} must be lowercase letters, digits, dots and hyphens, and not default`);
    if (canonical(Object.keys(t.grid[n].settings).sort()) !== canonical(Object.keys(t.default).sort())) throw new Error(`entity-h2h: ${kind}'s tuning setting ${n} must set exactly the knobs its default sets`);
    for (const [k, v] of Object.entries(t.grid[n].settings)) if (typeof v !== 'number' || typeof t.default[k] !== 'number') throw new Error(`entity-h2h: ${kind}'s knob ${k} must be a number, so the rule can measure the distance from default`);
  }
  if (t.applied_by === 'server-env') for (const k of Object.keys(t.default)) if (!ENV_KEY.test(k)) throw new Error(`entity-h2h: ${kind}'s server-env knob ${k} is not an environment variable name`);
  return t;
}

/** default, then the grid settings in the record's order: the rule's candidates and its last tie-break. */
const candidatesOf = (t: Tuning) => ['default', ...Object.keys(t.grid)];
const settingsOf = (t: Tuning, name: string) => (name === 'default' ? t.default : t.grid[name]?.settings);
export const distanceOf = (t: Tuning, s: Settings) => Math.round(Object.entries(s).reduce((d, [k, v]) => d + Math.abs((v as number) - (t.default[k] as number)), 0) * 1e9) / 1e9;

export const configLabel = (s: StackSetting) => (s.kind === 'default' ? 'default' : `${s.kind}:${s.setting}`);
const gridSha = (t: Tuning) => sha256(canonical(t.grid));

const isDefault = (kind: string, why: string) => new RunnerRefusal('TUNED_IS_DEFAULT', `entity-h2h: ${kind}'s tuned cell is its default cell (preregistration Amendment 2): ${why}, so no tuned cell runs`, { tuned_runs: 0 },
  'report the default row as the tuned row too, saying so beside it; run nothing');

/** The stack setting a memory cell's --config names (default, tuning:<name>, or tuned with --choice FILE). */
export function resolveConfig(kind: string, config: string, choicePath?: string): StackSetting {
  const t = tuningOf(kind);
  if (config === 'default') {
    if (choicePath) throw new Error('entity-h2h: --choice goes with --config tuned only');
    return { kind: 'default', setting: 'default', settings: t.default };
  }
  if (!t.knob) {
    if (config === 'tuned') throw isDefault(kind, `it has no documented dedupe setting (${t.no_knob})`);
    throw new Error(`entity-h2h: ${kind} has no documented dedupe setting, so it runs --config default only and its tuned cell is its default cell (preregistration Amendment 2; ${t.no_knob})`);
  }
  if (config.startsWith('tuning:')) {
    const name = config.slice('tuning:'.length);
    if (!settingsOf(t, name)) throw new Error(`entity-h2h: ${kind} has no tuning setting ${JSON.stringify(name)}; its slice runs are ${candidatesOf(t).join(', ')} (capability.json entity_h2h_tuning)`);
    if (choicePath) throw new Error('entity-h2h: --choice goes with --config tuned only');
    return { kind: 'tuning', setting: name, settings: settingsOf(t, name) };
  }
  if (config === 'tuned') {
    const choice = readChoice(kind, choicePath);
    if (choice.setting === 'default') throw isDefault(kind, `the rule chose default on the held-out slice (choice ${choicePath})`);
    return { kind: 'tuned', setting: choice.setting, settings: choice.settings, choice };
  }
  throw new Error(`entity-h2h: --config for a memory system is default, tuning:<setting> (${candidatesOf(t).join(', ')}) or tuned --choice FILE`);
}

/** A tuning cell runs only on the held-out seed at 5 per family; a tuned cell never runs on the held-out seed. */
export function checkWorldFor(s: StackSetting, world: { seed: number; per_family: number }): void {
  if (s.kind === 'tuning' && (world.seed !== HELD_OUT_SEED || world.per_family !== TUNING_PER_FAMILY))
    throw new RunnerRefusal('TUNING_SEED', `entity-h2h: a tuning cell runs only on the held-out seed ${HELD_OUT_SEED} at ${TUNING_PER_FAMILY} per family; this world is seed ${world.seed} at ${world.per_family} per family`, { seed: world.seed, per_family: world.per_family },
      `write the tuning world with: bun eval/runner/entity-h2h/run.ts world --seed ${HELD_OUT_SEED} --per-family ${TUNING_PER_FAMILY} --output DIR`);
  if (s.kind === 'tuned' && world.seed === HELD_OUT_SEED)
    throw new RunnerRefusal('TUNING_SEED', `entity-h2h: a tuned cell never runs on the held-out seed ${HELD_OUT_SEED}, which chose its setting; nothing scored comes from it`, { seed: world.seed, per_family: world.per_family },
      'run the tuned cell on the scored seed');
}

/** Refuses (STACK_CONFIG_MISMATCH) unless the shim's GET /health reports exactly the cell's setting and settings. */
export function checkStack(s: StackSetting, health: Record<string, unknown>, shim: string): void {
  const got = health.entity_h2h as { setting?: unknown; settings?: unknown } | undefined;
  const want = { setting: s.setting, settings: s.settings };
  if (got && canonical({ setting: got.setting, settings: got.settings }) === canonical(want)) return;
  throw new RunnerRefusal('STACK_CONFIG_MISMATCH', `entity-h2h: the stack at ${shim} reports ${got ? canonical({ setting: got.setting, settings: got.settings }) : 'no entity_h2h setting'} under GET /health, not the cell's ${canonical(want)}`,
    { settings_expected: Object.keys(s.settings).length, settings_reported: got?.settings && typeof got.settings === 'object' ? Object.keys(got.settings).length : 0 },
    'start the stack from the cell: bun eval/runner/entity-h2h/run.ts stack-env (eval/runner/entity-h2h/ubicloud/vm-run.sh does), rebuilding its image if its capability record changed');
}

/** The environment that starts a stack in a setting: ENTITY_H2H_SETTING, plus each knob for a server-env system. */
export function stackEnv(kind: string, s: StackSetting): string[] {
  const t = tuningOf(kind);
  if (s.setting !== 'default' && !SETTING_NAME.test(s.setting)) throw new Error(`entity-h2h: setting name ${JSON.stringify(s.setting)} is not a setting name`);
  const lines = [`ENTITY_H2H_SETTING=${s.setting}`];
  if (t.applied_by === 'server-env') for (const [k, v] of Object.entries(s.settings)) {
    if (!ENV_KEY.test(k) || !/^[0-9A-Za-z._-]+$/.test(String(v))) throw new Error(`entity-h2h: ${k}=${v} is not a plain environment setting`);
    lines.push(`${k}=${v}`);
  }
  return lines;
}

/**
 * Amendment 2's rule over scored candidates, the first of which must be default: marks each candidate eligible or not
 * and returns the winner's setting name. Candidates come in grid order (default first), the last tie-break.
 */
export function applyRule(candidates: Candidate[]): string {
  const base = candidates[0];
  if (base?.setting !== 'default') throw new Error('entity-h2h: the rule needs default as its first candidate, the baseline');
  for (const c of [...candidates]) if (!(c.recall.n > 0 && c.false_merge.n > 0)) throw new Error(`entity-h2h: candidate ${c.setting} has no designed pairs to score`);
  for (const c of candidates) c.eligible = 20 * c.recall.k * base.recall.n >= 20 * base.recall.k * c.recall.n - c.recall.n * base.recall.n;
  const better = (a: Candidate, b: Candidate): boolean => {
    const fm = a.false_merge.k * b.false_merge.n - b.false_merge.k * a.false_merge.n;
    if (fm !== 0) return fm < 0;
    if (a.distance !== b.distance) return a.distance < b.distance;
    const rec = a.recall.k * b.recall.n - b.recall.k * a.recall.n;
    if (rec !== 0) return rec > 0;
    return false;
  };
  let win = base;
  for (const c of candidates.slice(1)) if (c.eligible && better(c, win)) win = c;
  return win.setting;
}

const choiceRefusal = (detail: string, fix = 'record the choice from the slice runs of default and every grid setting: bun eval/runner/entity-h2h/run.ts choose --system S --held-out DIR --out FILE CELL...') =>
  new RunnerRefusal('TUNING_CHOICE', `entity-h2h: ${detail}`, { choices: 0 }, fix);

/** A choice record, checked against the system's current grid and the rule; refuses (TUNING_CHOICE) on any gap. */
export function readChoice(kind: string, path: string | undefined): TuningChoice {
  if (!path) throw choiceRefusal(`a tuned ${kind} cell needs --choice FILE, the record run.ts choose writes from its slice runs`);
  if (!existsSync(path)) throw choiceRefusal(`no choice record at ${path}`);
  const t = tuningOf(kind);
  const c = JSON.parse(readFileSync(path, 'utf8')) as TuningChoice;
  const problems: string[] = [];
  if (c.choice !== 'entity-h2h-tuning-choice') problems.push('it is not a tuning choice record');
  if (c.system !== kind) problems.push(`it is for ${c.system}, not ${kind}`);
  if (c.rule !== RULE) problems.push('it does not cite Amendment 2\'s rule');
  const settings = settingsOf(t, c.setting);
  if (!settings) problems.push(`its setting ${JSON.stringify(c.setting)} is neither default nor in the grid (${Object.keys(t.grid).join(', ')})`);
  else if (canonical(c.settings) !== canonical(settings)) problems.push(`its settings ${canonical(c.settings)} differ from the record's ${canonical(settings)}`);
  if (c.grid_sha256 !== gridSha(t)) problems.push('the grid changed since the slice runs');
  if (c.held_out?.seed !== HELD_OUT_SEED || c.held_out?.per_family !== TUNING_PER_FAMILY) problems.push(`its slice runs were on seed ${c.held_out?.seed} at ${c.held_out?.per_family} per family, not the held-out seed ${HELD_OUT_SEED} at ${TUNING_PER_FAMILY}`);
  const ran = (c.candidates ?? []).map(x => x.setting);
  if (canonical(ran) !== canonical(candidatesOf(t))) problems.push(`its candidates are ${ran.join(', ') || 'none'}, not default and the whole grid in order (${candidatesOf(t).join(', ')})`);
  else if (applyRule(c.candidates.map(x => ({ ...x }))) !== c.setting) problems.push(`the rule picks ${applyRule(c.candidates.map(x => ({ ...x })))} from its scores, not ${c.setting}`);
  if (problems.length) throw choiceRefusal(`the choice at ${path} is not usable: ${problems.join('; ')}`);
  return c;
}

/**
 * Applies Amendment 2's rule to a system's slice runs: one complete tuning cell for default and for every grid
 * setting, all on one held-out world at 5 per family. Writes the record (every candidate's scores, eligibility and the
 * winner) and returns it with the scores; a winner of default means the tuned cell is the default cell.
 */
export function chooseSetting(kind: string, heldOutDir: string, cellDirs: readonly string[], out: string): { choice: TuningChoice; scores: OutputScore[] } {
  const t = tuningOf(kind);
  if (!t.knob) throw isDefault(kind, `it has no documented dedupe setting, so it has no slice runs to choose from (${t.no_knob})`);
  if (existsSync(out)) throw new Error(`entity-h2h: ${out} exists; a choice is recorded once`);
  const w = loadWorld(heldOutDir);
  checkWorldFor({ kind: 'tuning', setting: 'default', settings: t.default }, w);
  const known = new Set(w.pages.map(p => p.key));
  const found = new Map<string, { c: Candidate; score: OutputScore }>();
  for (const dir of cellDirs) {
    const s = readCell(dir);
    if (!s) throw choiceRefusal(`${dir} has no cell.json`);
    const stack = (s as { stack?: StackSetting }).stack;
    if (s.system !== kind || stack?.kind !== 'tuning') throw choiceRefusal(`${dir} is a ${s.system} ${s.config} cell, not a ${kind} tuning cell`);
    if (s.status !== 'complete') throw choiceRefusal(`${dir} is ${s.status}; every slice run must be complete`);
    const settings = settingsOf(t, stack.setting);
    if (!settings || canonical(stack.settings) !== canonical(settings)) throw choiceRefusal(`${dir} ran ${stack.setting} ${canonical(stack.settings)}, which is neither default nor a setting of the grid`);
    if (found.has(stack.setting)) throw choiceRefusal(`two tuning cells ran ${stack.setting}; pass one per setting`);
    if (s.world.people_ledger_sha256 !== w.fingerprints.people || s.world.company_ledger_sha256 !== w.fingerprints.companies) throw choiceRefusal(`${dir} ran on another world than ${heldOutDir} (seed ${s.world.seed} at ${s.world.per_family} per family)`);
    const outputText = readFileSync(join(dir, 'output.json'), 'utf8');
    const subjects = existsSync(join(dir, 'subjects.json')) ? (JSON.parse(readFileSync(join(dir, 'subjects.json'), 'utf8')) as Array<{ key: string; node: string | null }>).filter(x => !x.node).map(x => x.key) : undefined;
    const score = scoreOutput(w, parseOutput(JSON.parse(outputText), known), { unresolved: subjects });
    const { person, company } = score.points.auto;
    found.set(stack.setting, { score, c: {
      setting: stack.setting, settings, distance: distanceOf(t, settings), eligible: false,
      false_merge: { k: person.false_merge.k + company.false_merge.k, n: person.false_merge.n + company.false_merge.n },
      recall: { k: person.designed_recall.k + company.designed_recall.k, n: person.designed_recall.n + company.designed_recall.n },
      dir: resolve(dir), cell_sha256: sha256(readFileSync(join(dir, 'cell.json'), 'utf8')), output_sha256: sha256(outputText),
    } });
  }
  const missing = candidatesOf(t).filter(n => !found.has(n));
  if (missing.length) throw choiceRefusal(`no complete slice run for ${missing.join(', ')}; the rule compares default and every grid setting on the same slice`,
    `run each on the held-out slice first: bun eval/runner/entity-h2h/run.ts run --system ${kind} --config tuning:<${missing.join('|')}> ...`);
  const candidates = candidatesOf(t).map(n => found.get(n)!.c);
  const setting = applyRule(candidates);
  const choice: TuningChoice = { choice: 'entity-h2h-tuning-choice', system: kind, setting, settings: settingsOf(t, setting), rule: RULE, eligibility: ELIGIBILITY, grid_sha256: gridSha(t),
    held_out: { seed: w.seed, per_family: w.per_family, pages: w.pages.length, people_ledger_sha256: w.fingerprints.people, company_ledger_sha256: w.fingerprints.companies },
    candidates, at: new Date().toISOString() };
  writeFileSync(out, JSON.stringify(choice, null, 2) + '\n', { flag: 'wx' });
  return { choice, scores: candidatesOf(t).map(n => found.get(n)!.score) };
}

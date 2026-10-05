/**
 * Cat 40 Hard: the world, task and answer contract.
 *
 * This module is the boundary between a Hard world generator and the Cat 40
 * runner and scorer. Any generator whose output satisfies these types and
 * `validateHardWorld` (validate.ts) runs through the same runner, oracle,
 * scorer and judge. The main generator (`model-ladder-hard.ts`) and the
 * sealed validation variant are two such generators. The full description,
 * with the scorer rules, is docs/benchmarks/cat40-hard/WORLD_SCHEMA.md.
 *
 * Nothing here renders prose or draws random numbers. It holds types,
 * constants, the knob schema and the scoring contract only.
 */
import { createHash } from 'node:crypto';
import type { LadderDoc } from '../model-ladder-gen.ts';

/** Version string of worlds written by the main Hard generator. A generator with different output uses its own. */
export const HARD_GENERATOR_VERSION = 'model-ladder-hard-v1';
/** Version of the knob schema below. A change to the key set or a key's meaning bumps it. */
export const HARD_KNOB_SCHEMA_VERSION = 1;

export type HardFamily = 'H1' | 'H2' | 'H3' | 'H4' | 'H5';
export const HARD_FAMILIES: readonly HardFamily[] = ['H1', 'H2', 'H3', 'H4', 'H5'];

/** Seeds fixed by the plan (CEO-F9). */
export const HARD_SEEDS = { calibration: 20261005, smoke: 20261099, heldout: 20261006 } as const;

/** Sessions in an H5 task: four recording sessions, then the scored question. */
export const H5_SESSIONS = 5;
/** What a recording session (H5 sessions 1 to 4) must submit. */
export const RECORDED = 'RECORDED';

// ─── Knobs ──────────────────────────────────────────────────────────

/**
 * Generator knobs. Every key is required; a knob file with a missing or
 * unknown key is refused. Values are numbers (rates are fractions).
 */
export interface HardKnobs {
  /** Background accounts besides the task accounts (world size). */
  accounts: number;
  /** Routine emails per account (noise). */
  emails_per_account: number;
  /** Routine meetings per account; each is a transcript. */
  meetings_per_account: number;
  /** Lines in a long meeting transcript. */
  transcript_lines_min: number;
  transcript_lines_max: number;
  /** Most support tickets per account. */
  tickets_per_account_max: number;
  /** Most ownership handoffs per account. */
  handoffs_per_account_max: number;
  /** Share of handoffs announced in a document written after the handoff took effect. */
  backdated_handoff_rate: number;
  /** Share of accounts with a confidently wrong agent note. */
  wrong_agent_note_rate: number;
  /** Company-wide team updates naming several accounts. */
  team_updates: number;
  /** H1: members in a set or count answer. */
  h1_min_members: number;
  h1_max_members: number;
  /** H1: near-miss entities whose deciding records the oracle receives, in seeded order. */
  h1_near_miss_cap: number;
  /** H2: value changes in an attribute's history (reversals and corrections included). */
  h2_changes_min: number;
  h2_changes_max: number;
  /** H2: share of changes followed by a backdated correction. */
  h2_correction_rate: number;
  /** H2: agent notes summarizing an intermediate state. */
  h2_intermediate_notes: number;
  /** H3: look-alike accounts per task. */
  h3_lookalikes_min: number;
  h3_lookalikes_max: number;
  /** H4: conflicting documents per task. */
  h4_sources_min: number;
  h4_sources_max: number;
  /** H4: share of tasks whose deciding executed document is long, with the deciding clause mid-document. */
  h4_long_document_rate: number;
  /** H5: recording sessions that carry a look-alike's fact instead of a required one. */
  h5_noise_sessions: number;
  /** Turns per session (each H5 session separately). The last knob calibration moves. */
  max_turns: number;
  /** Tasks generated per family. */
  tasks_per_family: number;
  /** 50k scale: appended accounts. */
  large_extra_accounts: number;
  /** 50k scale: non-deciding documents appended per 4k account. */
  large_nondeciding_per_account: number;
}

export const HARD_KNOB_KEYS = [
  'accounts', 'emails_per_account', 'meetings_per_account', 'transcript_lines_min', 'transcript_lines_max', 'tickets_per_account_max',
  'handoffs_per_account_max', 'backdated_handoff_rate', 'wrong_agent_note_rate', 'team_updates', 'h1_min_members', 'h1_max_members',
  'h1_near_miss_cap', 'h2_changes_min', 'h2_changes_max', 'h2_correction_rate', 'h2_intermediate_notes', 'h3_lookalikes_min',
  'h3_lookalikes_max', 'h4_sources_min', 'h4_sources_max', 'h4_long_document_rate', 'h5_noise_sessions', 'max_turns', 'tasks_per_family',
  'large_extra_accounts', 'large_nondeciding_per_account',
] as const satisfies ReadonlyArray<keyof HardKnobs>;

/** Knob groups in the calibration priority order (CEO-F5): content first, the turn cap last. */
export const KNOB_PRIORITY: ReadonlyArray<{ group: string; keys: ReadonlyArray<keyof HardKnobs> }> = [
  { group: 'record counts', keys: ['h1_min_members', 'h1_max_members', 'h4_sources_min', 'h4_sources_max', 'h3_lookalikes_min', 'h3_lookalikes_max'] },
  { group: 'history length', keys: ['h2_changes_min', 'h2_changes_max', 'h2_correction_rate', 'handoffs_per_account_max', 'backdated_handoff_rate'] },
  { group: 'distractor rate', keys: ['h2_intermediate_notes', 'wrong_agent_note_rate', 'h5_noise_sessions', 'h4_long_document_rate'] },
  { group: 'noise', keys: ['accounts', 'emails_per_account', 'meetings_per_account', 'transcript_lines_min', 'transcript_lines_max', 'tickets_per_account_max', 'team_updates'] },
  { group: 'turn cap (last; needs a dated reason in calibration.md)', keys: ['max_turns'] },
];

/** Integer knobs; every other knob is a fraction in [0, 1]. */
const RATE_KNOBS = new Set<keyof HardKnobs>(['backdated_handoff_rate', 'wrong_agent_note_rate', 'h2_correction_rate', 'h4_long_document_rate']);

export const DEFAULT_HARD_KNOBS: HardKnobs = {
  accounts: 110, emails_per_account: 7, meetings_per_account: 2, transcript_lines_min: 80, transcript_lines_max: 220, tickets_per_account_max: 3,
  handoffs_per_account_max: 3, backdated_handoff_rate: 0.35, wrong_agent_note_rate: 0.3, team_updates: 260, h1_min_members: 10, h1_max_members: 40,
  h1_near_miss_cap: 40, h2_changes_min: 3, h2_changes_max: 6, h2_correction_rate: 0.4, h2_intermediate_notes: 2, h3_lookalikes_min: 1,
  h3_lookalikes_max: 3, h4_sources_min: 3, h4_sources_max: 5, h4_long_document_rate: 0.4, h5_noise_sessions: 1, max_turns: 16, tasks_per_family: 20,
  large_extra_accounts: 2800, large_nondeciding_per_account: 12,
};

/**
 * Check a parsed knob file. Returns the knobs or throws with every problem,
 * the list of valid keys and the fix.
 */
export function validateKnobs(raw: unknown, source = 'knobs'): HardKnobs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source}: a knob file is one JSON object with the keys ${HARD_KNOB_KEYS.join(', ')}`);
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  const unknown = Object.keys(obj).filter(k => !(HARD_KNOB_KEYS as readonly string[]).includes(k));
  const missing = HARD_KNOB_KEYS.filter(k => !(k in obj));
  if (unknown.length) problems.push(`unknown keys: ${unknown.join(', ')}`);
  if (missing.length) problems.push(`missing keys: ${missing.join(', ')}`);
  for (const k of HARD_KNOB_KEYS) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`${k} must be a number (got ${JSON.stringify(v)})`); continue; }
    if (RATE_KNOBS.has(k)) { if (v < 0 || v > 1) problems.push(`${k} is a fraction in [0, 1] (got ${v})`); }
    else if (!Number.isInteger(v) || v < 0) problems.push(`${k} must be a non-negative integer (got ${v})`);
  }
  const n = obj as unknown as HardKnobs;
  const order: Array<[keyof HardKnobs, keyof HardKnobs]> = [['transcript_lines_min', 'transcript_lines_max'], ['h1_min_members', 'h1_max_members'], ['h2_changes_min', 'h2_changes_max'], ['h3_lookalikes_min', 'h3_lookalikes_max'], ['h4_sources_min', 'h4_sources_max']];
  for (const [lo, hi] of order) if (typeof n[lo] === 'number' && typeof n[hi] === 'number' && n[lo] > n[hi]) problems.push(`${lo} (${n[lo]}) is above ${hi} (${n[hi]})`);
  if (typeof n.h4_sources_min === 'number' && n.h4_sources_min < 3) problems.push('h4_sources_min is at least 3 (a conflict needs three documents)');
  if (typeof n.h2_changes_min === 'number' && n.h2_changes_min < 2) problems.push('h2_changes_min is at least 2');
  if (typeof n.h1_min_members === 'number' && n.h1_min_members < 2) problems.push('h1_min_members is at least 2');
  if (typeof n.max_turns === 'number' && n.max_turns < 1) problems.push('max_turns is at least 1');
  if (typeof n.tasks_per_family === 'number' && (n.tasks_per_family < 1 || n.tasks_per_family > 99)) problems.push('tasks_per_family is between 1 and 99');
  if (typeof n.h5_noise_sessions === 'number' && n.h5_noise_sessions > 1) problems.push('h5_noise_sessions is 0 or 1 (four recording sessions hold three required or superseded facts)');
  if (problems.length) throw new Error(`${source}: ${problems.join('; ')}. Valid keys: ${HARD_KNOB_KEYS.join(', ')}. Fix the file, or start from docs/benchmarks/cat40-hard/knobs.default.json.`);
  return Object.fromEntries(HARD_KNOB_KEYS.map(k => [k, obj[k]])) as unknown as HardKnobs;
}

/** Digest of a knob set: SHA-256 of the knobs as JSON with keys in HARD_KNOB_KEYS order, plus the schema version. */
export function knobDigest(knobs: HardKnobs | Record<string, number>): string {
  const ordered = Object.fromEntries(Object.keys(knobs).sort().map(k => [k, (knobs as Record<string, number>)[k]]));
  return createHash('sha256').update(JSON.stringify({ schema: HARD_KNOB_SCHEMA_VERSION, knobs: ordered })).digest('hex');
}

// ─── World ──────────────────────────────────────────────────────────

/** One entity (an account) and every name that refers to it. The name namespace is injective across entities. */
export interface HardEntity {
  /** Stable id, e.g. `acct-0042`. */
  id: string;
  /** Canonical name as of the world's `today`. */
  name: string;
  /** Every other name: account code, former names, names of accounts merged into it. */
  aliases: string[];
}

/** H1 predicate: every clause must hold for an entity to be a member. Clauses are evaluated as of `as_of`. */
export interface H1Predicate {
  as_of: string;
  clauses: H1Clause[];
}
export type H1Clause =
  | { kind: 'owner'; staff: string }
  | { kind: 'segment'; segment: string }
  | { kind: 'region'; region: string }
  | { kind: 'open_escalated_ticket' }
  | { kind: 'renewal_within'; days: number };

/** A fact a recording session states (H5), for the write diagnostic. */
export interface SessionFact {
  /** 1-based session index. */
  session: number;
  /** What the fact is about, e.g. `procurement_lead:acct-0007`. */
  key: string;
  value: string;
  /** The later session that replaces it, when one does. */
  superseded_by?: number;
  /** True when the final answer depends on this fact. */
  required: boolean;
}

export interface HardTask {
  /** `H1-01` to `H5-NN`. */
  id: string;
  family: HardFamily;
  /** Sub-variant for breakdowns. */
  variant: string;
  /**
   * `value`: one value in `answer` (H2 to H5).
   * `set`: a JSON array of entity names, sent as a JSON-encoded string in `answer` (a native array is accepted).
   * `count`: the integer at the start of `answer`.
   */
  answer_kind: 'value' | 'set' | 'count';
  /** Entity ids the task is about (H1: none; the members are in gold). */
  accounts: string[];
  /** H5 only: the user message of each recording session, in order (sessions 1 to 4). The question is the final session. */
  sessions?: string[];
  /** The scored question (H5: the final session's user message). */
  question: string;
  gold: {
    /** `value`: accepted answers (any match). */
    answer?: string[];
    /** `set`: the members, each with every accepted name (canonical first). */
    members?: Array<{ id: string; names: string[] }>;
    /** `count`: the key. */
    count?: number;
    /** `value`: values that fail the answer when named anywhere in it (superseded, look-alike, lower-authority). */
    wrong?: string[];
    /** Document ids that decide the answer. */
    evidence: string[];
  };
  /** Document ids the oracle arm receives. */
  relevant: string[];
  /** Synthesized documents the oracle also receives (H5: the ideal store after sessions 1 to 4). */
  oracle_notes?: Array<{ id: string; title: string; body: string }>;
  /** H1: near-miss entities in the world and how many of them the oracle evidence covers. */
  near_miss?: { total: number; in_evidence: number };
  /** H1: the predicate the key was computed from. */
  predicate?: H1Predicate;
  /** H5: facts stated in recording sessions. */
  session_facts?: SessionFact[];
}

export interface HardWorld {
  /** Generator version, e.g. `model-ladder-hard-v1`. The runner regenerates the world with the generator registered under it. */
  version: string;
  mode: 'hard';
  seed: number;
  /** Present only for the 50k world. */
  scale?: 'large';
  /** For the 50k world: digest of the 4k world it extends. */
  base_digest?: string;
  knob_schema: number;
  knobs: HardKnobs;
  knob_digest: string;
  /** Turn cap per session; the runner uses it unless `--max-turns` overrides. */
  max_turns: number;
  today: string;
  principal: { name: string; role: string };
  entities: HardEntity[];
  docs: LadderDoc[];
  tasks: HardTask[];
}

/** The identity the runner checks on every invocation: a resume or regeneration must match each field. */
export interface HardWorldIdentity { seed: number; scale: 'v1' | 'large'; mode: 'hard'; knobs: HardKnobs; version: string }

export function worldIdentity(w: HardWorld): HardWorldIdentity {
  return { seed: w.seed, scale: w.scale ?? 'v1', mode: 'hard', knobs: w.knobs, version: w.version };
}

export function isHardWorld(w: unknown): w is HardWorld {
  return !!w && typeof w === 'object' && (w as { mode?: unknown }).mode === 'hard';
}

// ─── Scorer contract ────────────────────────────────────────────────

/**
 * How a Hard answer is read (score-hard.ts implements it):
 *
 * 1. Coercion. `answer` that is an array becomes its JSON string; any other
 *    non-string becomes `String(answer)`; null or missing becomes ''.
 * 2. `value` tasks: the answer succeeds when its head (`answerHead` from
 *    score.ts: the text before a parenthetical, semicolon or dash aside)
 *    names an accepted value (`valueVerdict`), and the full answer names no
 *    `gold.wrong` value anywhere. "X (or Y)" therefore fails when Y is wrong.
 * 3. `set` tasks: the answer must parse as a JSON array of strings, directly
 *    or after trimming text around the outermost brackets. Each element maps
 *    to an entity by exact `normalizeValue` equality with one of a member's
 *    names, or with any entity's name in `world.entities`; never by
 *    substring. Elements naming the same entity count once. Success is exact
 *    equality of the entity set with the members. An element naming no
 *    entity counts as a wrong element. Precision, recall and Jaccard are
 *    reported and never count as success. An answer that is not a JSON array
 *    is `unparseable_set`.
 * 4. `count` tasks: the integer at the very start of the answer ("12" and
 *    "12 accounts" pass; "As of 2026-07-01, 12" does not) must equal the key.
 *    An answer with no leading integer is `unparseable_set`.
 * 5. H5 recording sessions must submit RECORDED; only the final session is
 *    scored. A failed recording session is reported, not scored.
 */
export interface HardScore {
  success: boolean;
  submitted: boolean;
  /** `value`: the answer named a `gold.wrong` value anywhere. */
  said_wrong: boolean;
  /** `set` or `count` answer that could not be parsed. */
  unparseable_set: boolean;
  /** `set`: overlap with the members. */
  set?: { precision: number; recall: number; jaccard: number; got: number; expected: number; unmatched: number };
  /** `count`: the integer read, or null. */
  count_read?: number | null;
  evidence_cited: string[];
  missed_evidence: string[];
  wrote: boolean;
  /** H5: whether each recording session submitted RECORDED. */
  recorded?: boolean[];
}

/** Stop kinds of a Hard session (ENG-F2). Only `harness_error` is retried. */
export const HARD_STOP_KINDS = ['submitted', 'turn_cap', 'no_tool_call', 'context_overflow', 'error', 'harness_error'] as const;
export type HardStopKind = typeof HARD_STOP_KINDS[number];

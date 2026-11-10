/**
 * BG1, the changing-facts battleground (GST-2010; preregistration
 * docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md): the names, strata and question fields
 * every BG1 module shares. Gold never comes from a model: changing-facts-gen.ts derives it from the world plan.
 *
 * It lives here, under the cell runner's EXECUTES paths, because the loaders (corpus.ts) and the cell definitions read it
 * at runtime; eval/runner/bg1/types.ts re-exports it for the analysis, generator and custody modules.
 */
export const BG1_BENCHMARK_DEV = 'bg1-dev';
export const BG1_BENCHMARK_SEALED = 'bg1';

export const BG1_STRATA = ['s1_updated', 's2_corrected', 's3_repeated_stale', 's4_conflicting', 's5_withdrawn', 's6_as_of', 's7_as_known', 's8_history'] as const;
export type Bg1Stratum = typeof BG1_STRATA[number];
/** The primary family: what is true now, after a change. */
export const BG1_PRIMARY: readonly Bg1Stratum[] = ['s1_updated', 's2_corrected', 's3_repeated_stale', 's4_conflicting', 's5_withdrawn'];
/** The secondary family: time-indexed questions (a past date, what had been learned by a date, the order of values). */
export const BG1_SECONDARY: readonly Bg1Stratum[] = ['s6_as_of', 's7_as_known', 's8_history'];
export type Bg1Family = 'primary' | 'secondary';
export const familyOf = (s: Bg1Stratum): Bg1Family => (BG1_PRIMARY.includes(s) ? 'primary' : 'secondary');

export const BG1_QUESTIONS_PER_STRATUM = 8;
export const BG1_QUESTIONS_PER_WORLD = BG1_STRATA.length * BG1_QUESTIONS_PER_STRATUM;

/** Evaluator-side fields of a BG1 question (MemoryQuestion.bg1); never shown to a system under test. */
export interface Bg1QuestionFields {
  stratum: Bg1Stratum;
  family: Bg1Family;
  /** exact: the question names the slot as the history does; paraphrase: the same gold asked in other words. */
  form: 'exact' | 'paraphrase';
  /** The tracked slot the question asks about, e.g. "person-03.city". */
  slot: string;
  /** Accepted surface forms of the gold value (aliases included). s8_history: the values in order, oldest first. */
  gold_values: string[];
  /** s8_history: the answer must list gold_values in this order. */
  ordered?: boolean;
  /** Values of the same slot that are wrong for this question (earlier, corrected, unsigned or not yet in effect). */
  stale_values: string[];
  /** Values a near-name decoy entity holds for the same kind of slot. */
  decoy_values: string[];
  /** s4_conflicting: the governing line (signed or owner-confirmed), for raw-text exposure checks only. */
  deciding_line?: string;
}

/** The 48 mint slots of the sealed set, minted in slot order; the kept list is the first N_final that pass validation. */
export const BG1_SLOTS = 48;
export const BG1_CONVERSATIONS: readonly string[] = Array.from({ length: BG1_SLOTS }, (_, i) => `bg1-${String(i + 1).padStart(3, '0')}`);
/** The three public dev worlds (stage 1). */
export const BG1_DEV_CONVERSATIONS: readonly string[] = ['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03'];
/** Kept worlds per launch unit; wave A (the internal pilot) is the first BG1_WAVE_A kept worlds. */
export const BG1_KEPT_UNITS = 6;
export const BG1_WAVE_A = 12;
export const BG1_N_FLOOR = 30;
export const BG1_N_CAP = 40;

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

/** A mint slot's world id: slot 7 is bg1-007. BG1 and BG1-C share the ids, so the seed derivation of a slot stays as it is. */
export const bg1WorldId = (slot: number): string => `bg1-${String(slot).padStart(3, '0')}`;
/**
 * The sealed set's mint slots, minted in slot order; the kept list is the first N_final that pass validation. BG1
 * planned 48 and minted 1 to 30, its kept list. On 2026-11-19 BG1's set was redefined as those 30, and slots 31 to 48,
 * never minted, went to BG1-C with the slots after them (BG1C_CONVERSATIONS; the confirmation's preregistration,
 * docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md).
 */
export const BG1_SLOTS = 30;
export const BG1_CONVERSATIONS: readonly string[] = Array.from({ length: BG1_SLOTS }, (_, i) => bg1WorldId(i + 1));
/** The three public dev worlds (stage 1). */
export const BG1_DEV_CONVERSATIONS: readonly string[] = ['bg1-dev-01', 'bg1-dev-02', 'bg1-dev-03'];
/** The 17 extra public dev worlds of BG1's dev loop (GST-2854), a list of their own beside the stage 1 three. */
export const BG1_DEV_EXTRA_CONVERSATIONS: readonly string[] = Array.from({ length: 17 }, (_, i) => `bg1-dev-${String(i + 4).padStart(2, '0')}`);
/**
 * The three long public dev worlds (GBEV-128): changing-facts-gen@2 plans of about 1,000,000 tokens from public seeds,
 * for the weekly line's long pilot (bg1-dev-long-01) and the grep agent's long judge check (bg1-dev-long-02 and -03).
 */
export const BG1_DEV_LONG_CONVERSATIONS: readonly string[] = ['bg1-dev-long-01', 'bg1-dev-long-02', 'bg1-dev-long-03'];
/** Kept worlds per launch unit; wave A (the internal pilot) is the first BG1_WAVE_A kept worlds. */
export const BG1_KEPT_UNITS = 6;
export const BG1_WAVE_A = 12;
export const BG1_N_FLOOR = 30;
export const BG1_N_CAP = 40;
/** N_final, set by the internal pilot (the preregistration's Amendment 7): the counted cells run on the first 30 kept worlds. */
export const BG1_N_FINAL = 30;

/**
 * BG1-C, the changing-facts confirmation (docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md):
 * BG1's generator, seed and phrasing on slots BG1 never minted. The custodian mints from slot 31 in order (mint.sh
 * --bg1c), slots are capped at 96, and the kept list is the first 40 worlds that pass BG1's validation. World ids are
 * BG1's (bg1-031 onward), so a slot's world is the one BG1's seed always planned for it.
 */
export const BG1C_BENCHMARK = 'bg1c';
export const BG1C_FIRST_SLOT = 31;
export const BG1C_LAST_SLOT = 96;
export const BG1C_CONVERSATIONS: readonly string[] = Array.from({ length: BG1C_LAST_SLOT - BG1C_FIRST_SLOT + 1 }, (_, i) => bg1WorldId(BG1C_FIRST_SLOT + i));
/** N_final, fixed by the preregistration: the counted cells run on exactly the first 40 kept worlds. */
export const BG1C_N_FINAL = 40;
/**
 * Kept worlds per launch unit, as GBEV-3 set them on 2026-11-19 for R113's one look at half the units: eight units at
 * N_final. The first BG1C_FIRST_HALF_UNITS units, kept worlds 1 to 20, are the first half, where that look happens.
 */
export const BG1C_KEPT_UNITS = 5;
export const BG1C_FIRST_HALF_UNITS = 4;
/** The campaign and custody decision id that every BG1-C opening is logged under. */
export const BG1C_CAMPAIGN = 'q1-scoreboard-bg1c-changing-facts-confirmation';
/** The `dataset` of BG1-C's manifest (eval/decisions/datasets/bg1c-manifest.json); the bg1c loader refuses any other. */
export const BG1C_DATASET = 'BG1-C changing-facts confirmation set';

/**
 * Set W, the weekly held-out outcome line's own sealed worlds (docs/benchmarks/2026-11-23-weekly-outcome-line-
 * preregistration.md, "The worlds" and "Custody and exposure"): BG1's generator and validation on slots 1001 and up,
 * apart from BG1 (1 to 30) and BG1-C (31 to 96), from a seed line and private phrasing set of its own. Each quarter has
 * its own seed set on its own slot range; the first quarter's is W1, on slots 1001 to 1999, and a rotation amendment adds
 * the next set on a range of its own below 10000, so every world id has four digits: slot 1001 is bgw-1001.
 *
 * Worlds are minted monthly in batches (eval/custody/bg1/mint.sh --bgw). A batch is named by its first world, bgw-1001
 * for the first, and starts one slot past the last slot of the batch before it in the same seed set. It mints in slot
 * order until BGW_BATCH_KEPT worlds pass validation: four weeks of eight plus two spares. Week k uses its kept worlds
 * 8(k-1)+1 to 8k in slot order, so a batch that keeps 32 or 33 worlds loses spares, never a week. A batch may use at
 * most BGW_BATCH_SLOTS slots, BG1-C's 66 slots for 40 kept worlds scaled to 34 and rounded down; its yield gate is
 * BG1-C's (two drops among its first five slots), and its drop cap is BG1-C's three drops per 40 kept worlds scaled to
 * 34 and rounded down. Each batch has a committed manifest template (bgwBatchManifest) and its slots in the committed
 * split file (BGW_SPLIT) before it mints, and the custodian fills the template beside the batch's set root.
 *
 * A seed set also names its world length profile (changing-facts-gen.ts BG1_PROFILES) and the seed line it plans from.
 * W1-long, on slots 2001 to 2999, is W1's seed line and phrasing at the long profile (changing-facts-gen@2, about
 * 1,000,000 tokens a world): the worlds week 1 runs if the preregistration's ceiling rule moves the line to longer worlds
 * by dated amendment. Its batches, weeks, gates and custody rules are every other seed set's.
 */
export const BGW_BENCHMARK = 'bgw';
/** A seed set's world length profile: changing-facts-gen.ts BG1_PROFILES (standard at about 200,000 tokens, long at about 1,000,000). */
export type BgwProfile = 'standard' | 'long';
export interface BgwSeedSet { id: string; first: number; last: number; profile: BgwProfile; seed: string }
/**
 * Set W's seed sets, one per quarter, each on a slot range of its own; a rotation amendment adds the next. `seed` names the
 * seed set whose seed line and phrasing it plans from: W1-long plans from W1's.
 */
export const BGW_SEED_SETS: ReadonlyArray<BgwSeedSet> = [
  { id: 'W1', first: 1001, last: 1999, profile: 'standard', seed: 'W1' },
  { id: 'W1-long', first: 2001, last: 2999, profile: 'long', seed: 'W1' },
];
export const BGW_FIRST_SLOT = 1001;
export const BGW_WORLDS_PER_WEEK = 8;
export const BGW_WEEKS_PER_BATCH = 4;
export const BGW_SPARES = 2;
export const BGW_BATCH_KEPT = BGW_WORLDS_PER_WEEK * BGW_WEEKS_PER_BATCH + BGW_SPARES;
export const BGW_BATCH_SLOTS = 56;
export const BGW_DROP_CAP = 2;
/** The campaign and custody decision id that every Set W opening is logged under (the registry entry's id). */
export const BGW_CAMPAIGN = 'weekly-outcome-line';
/** Every Set W batch manifest's `dataset` starts with this; BG1's and BG1-C's loaders refuse such a manifest. */
export const BGW_DATASET_PREFIX = 'Set W weekly outcome line';
export const BGW_SPLIT = 'eval/decisions/splits/bgw.json';

/** A Set W slot's world id: slot 1001 is bgw-1001. Only four-digit slots inside a seed set's range have one. */
export const bgwWorldId = (slot: number): string => {
  if (!bgwSeedSetOf(slot)) throw new Error(`slot ${slot} is not in any Set W seed set (${BGW_SEED_SETS.map(s => `${s.id}: ${s.first} to ${s.last}`).join('; ')})`);
  return `bgw-${slot}`;
};
/** The slot of a Set W world id (bgw- and four digits), or null for any other id. */
export const bgwSlotOf = (id: string): number | null => {
  const m = /^bgw-([1-9]\d{3})$/.exec(id);
  return m && bgwSeedSetOf(Number(m[1])) ? Number(m[1]) : null;
};
/** The seed set a slot belongs to, or null. */
export const bgwSeedSetOf = (slot: number): BgwSeedSet | null => (Number.isInteger(slot) ? BGW_SEED_SETS.find(s => slot >= s.first && slot <= s.last) ?? null : null);
/** A Set W slot's length profile, from its seed set; throws for a slot outside every seed set. */
export const bgwProfileOf = (slot: number): BgwProfile => {
  const set = bgwSeedSetOf(slot);
  if (!set) throw new Error(`slot ${slot} is not in any Set W seed set`);
  return set.profile;
};
/** A batch's name: its first world's id. */
export const bgwBatchName = (first: number): string => bgwWorldId(first);
/** The slots a batch may use, first to first + BGW_BATCH_SLOTS - 1, all inside one seed set; refuses a batch that would cross its set's end. */
export function bgwBatchSlots(first: number): number[] {
  const set = bgwSeedSetOf(first);
  if (!set) throw new Error(`batch ${first} does not start in any Set W seed set`);
  const last = first + BGW_BATCH_SLOTS - 1;
  if (last > set.last) throw new Error(`batch bgw-${first} would run to slot ${last}, past seed set ${set.id}'s last slot ${set.last}; the next quarter's set starts a new batch`);
  return Array.from({ length: BGW_BATCH_SLOTS }, (_, i) => first + i);
}
export const bgwBatchIds = (first: number): string[] => bgwBatchSlots(first).map(bgwWorldId);
/** A batch's `dataset`, which its manifest must carry. */
export const bgwBatchDataset = (first: number): string => `${BGW_DATASET_PREFIX}, batch ${bgwBatchName(first)}`;
/** A batch's committed manifest template; the filled manifest is bgwFilledManifest(first) beside the batch's set root files. */
export const bgwBatchManifest = (first: number): string => `eval/decisions/datasets/${bgwBatchName(first)}-manifest.json`;
export const bgwFilledManifest = (first: number): string => `${bgwBatchName(first)}-manifest.json`;

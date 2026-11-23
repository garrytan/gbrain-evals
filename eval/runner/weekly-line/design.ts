/**
 * The weekly held-out outcome line's frozen design (preregistration
 * docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "Systems", "Readers and judges", "Estimand and verdict
 * rules", "Power" and "Custody and exposure"): its rows, readers, classes, the six comparisons in their two Holm families,
 * the O'Brien-Fleming bounds the look and the end use at each Holm step, and the thresholds the words, the drop cap and the
 * ceiling read. Where the preregistration is silent, BG1-C's preregistration governs, and the readings this code had to
 * choose are named where they are used (stats.ts, aggregates.ts).
 */
import { OPUS, PARTICLE } from '../q1/cells/bg1.ts';
import { BG1_PRIMARY, BG1_SECONDARY, BG1_QUESTIONS_PER_STRATUM, BG1_STRATA, type Bg1Stratum } from '../memory-qa/bg1-names.ts';

export const WL_ROWS = ['gbrain', 'grep-agent', 'extract-first', 'memory-bank'] as const;
export type WlRow = typeof WL_ROWS[number];
export const WL_OTHERS = ['grep-agent', 'extract-first', 'memory-bank'] as const;
export type WlOther = typeof WL_OTHERS[number];
export const WL_SERVERS = ['extract-first', 'memory-bank'] as const;
export type WlServer = typeof WL_SERVERS[number];
/** Each row's system id in the cell records (AnswerRecord.system), as BG1-C's cells and the file agent write them. */
export const WL_SYSTEMS: Readonly<Record<string, WlRow>> = { 'gbrain-defaults': 'gbrain', 'baseline-file-agent': 'grep-agent', 'ext-extract-first': 'extract-first', 'ext-memory-bank': 'memory-bank' };
/** How public text names each comparison row (by kind, never by product). */
export const WL_ROW_NAMES: Readonly<Record<WlRow, string>> = { gbrain: 'gbrain', 'grep-agent': 'a grep agent', 'extract-first': 'the extract-first server', 'memory-bank': 'the memory-bank server' };

/** The two readers, as the records name them, and the short names the aggregates use as keys. */
export const WL_READERS = [OPUS, PARTICLE] as const;
export const WL_READER_KEYS = ['claude-opus-5-5', 'particle-1'] as const;
export type WlReaderKey = typeof WL_READER_KEYS[number];
export const readerKey = (reader: string): WlReaderKey => WL_READER_KEYS[WL_READERS.indexOf(reader as typeof WL_READERS[number])];

export const WL_CLASSES = {
  now: { name: 'what is true now', held_out: 'held-out questions about what is true now', strata: BG1_PRIMARY },
  past: { name: 'questions about the past', held_out: 'held-out questions about the past', strata: BG1_SECONDARY },
} as const;
export type WlClass = keyof typeof WL_CLASSES;
export const WL_CLASS_KEYS: readonly WlClass[] = ['now', 'past'];
export const classOf = (s: Bg1Stratum): WlClass => ((BG1_PRIMARY as readonly string[]).includes(s) ? 'now' : 'past');
/** Questions per world in each class: 40 on what is true now, 24 on the past. */
export const WL_CLASS_QUESTIONS: Readonly<Record<WlClass, number>> = { now: BG1_PRIMARY.length * BG1_QUESTIONS_PER_STRATUM, past: BG1_SECONDARY.length * BG1_QUESTIONS_PER_STRATUM };

export type WlFamily = 1 | 2;
export interface WlComparison { key: string; family: WlFamily; cls: WlClass; other: WlOther }
/** Family 1 is the grep agent (now, past); family 2 the two servers (now and past each). Holm runs within a family. */
export const WL_COMPARISONS: readonly WlComparison[] = [
  { key: 'now|grep-agent', family: 1, cls: 'now', other: 'grep-agent' },
  { key: 'past|grep-agent', family: 1, cls: 'past', other: 'grep-agent' },
  { key: 'now|extract-first', family: 2, cls: 'now', other: 'extract-first' },
  { key: 'now|memory-bank', family: 2, cls: 'now', other: 'memory-bank' },
  { key: 'past|extract-first', family: 2, cls: 'past', other: 'extract-first' },
  { key: 'past|memory-bank', family: 2, cls: 'past', other: 'memory-bank' },
];
export const familyOf = (f: WlFamily) => WL_COMPARISONS.filter(c => c.family === f);

/** Two-sided alpha of each family's Holm step-down. */
export const WL_ALPHA = 0.05;
/**
 * The O'Brien-Fleming two-look bounds on |z| at each Holm step's two-sided alpha, exactly as "The look (R113)" lists them,
 * keyed by the Holm divisor (alpha = 0.05 / divisor): at 0.05, 2.797 at the look and 1.977 at the end; at 0.025, 3.183
 * and 2.250; at 0.0167, 3.394 and 2.400; at 0.0125, 3.539 and 2.502. They stay fixed when a block ends short of 32.
 */
export const WL_OBF_BOUNDS: Readonly<Record<1 | 2 | 3 | 4, { look: number; final: number }>> = {
  1: { look: 2.797, final: 1.977 },
  2: { look: 3.183, final: 2.25 },
  3: { look: 3.394, final: 2.4 },
  4: { look: 3.539, final: 2.502 },
};
/** The simultaneous (Bonferroni) two-sided level within each family: 97.5% in family 1, 98.75% in family 2. */
export const WL_SIMULTANEOUS_LEVEL: Readonly<Record<WlFamily, number>> = { 1: 1 - WL_ALPHA / 2, 2: 1 - WL_ALPHA / 4 };

export const WL_MARGIN_POINTS = 3;
export const WL_CEILING_POINTS = 97;
export const WL_DROP_CAP = 0.05;
export const WL_WEEK_WORLDS = 8;
export const WL_WEEKS_PER_BLOCK = 4;
export const WL_BLOCK_WORLDS = WL_WEEK_WORLDS * WL_WEEKS_PER_BLOCK;
/** The look comes when the block's 16th counted world is scored; a block with fewer gets no verdict. */
export const WL_LOOK_WORLDS = 16;
export const WL_ROLLING_WEEKS = 4;
/** The per-world SD each family's weekly smallest detectable difference assumes until a dated amendment sets it: the Power table's largest column. */
export const WL_WEEKLY_SD: Readonly<Record<WlFamily, number>> = { 1: 9, 2: 9 };
export const WL_POWER = 0.8;
export const WL_SEED = 20261123;
export const WL_DRAWS = 9999;
export const WL_FALSE_ALARM_SIMS = 10000;

/** Why a week records no point, in the preregistration's words. */
export const WL_NO_POINT = ['custody host offline', 'no worlds', 'gbrain release failed to run'] as const;
export type WlNoPoint = typeof WL_NO_POINT[number];

/** The words a block comparison can read; weekly points never carry one. */
export const WL_WORDS = ['ahead', 'behind', 'level within 3 points', 'split by reader', 'no measurable difference', 'ceiling', 'changed within the block', 'descriptive', 'no verdict'] as const;
export type WlWord = typeof WL_WORDS[number];

/** The planned question ids of a world: the generator's `<world>:<stratum>:<k>`, eight per kind. */
export const plannedQuestions = (world: string): Array<{ id: string; stratum: Bg1Stratum }> =>
  BG1_STRATA.flatMap(stratum => Array.from({ length: BG1_QUESTIONS_PER_STRATUM }, (_, k) => ({ id: `${world}:${stratum}:${k}`, stratum })));

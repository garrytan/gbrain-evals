/**
 * System One v1 per-slot eval definitions.
 *
 * Each evaluation is a matched pair (or a small family of arms): the same
 * gbrain commit, the same questions, the same embedding cache and the same
 * brain setup, with only the slot's `--decide` mode (or its documented
 * variant) different. The arm lists below are the ones gbrain's own System
 * One eval ran on 2026-09-30 (gbrain docs/eval/system-one/runners/lme-arms.sh
 * and the dataset runners), so a reader re-running them measures the same
 * comparison. `system-one-jev.ts plan` prints every command; `run` executes
 * them against a gbrain checkout passed with `--gbrain <checkout>@<ref>`.
 *
 * Placeholders resolved by the runner:
 *   {S} {M}        LongMemEval-S cleaned / the 28-question M pilot file
 *   {list}         the evaluation's question-id list
 *   {data}         eval/data/system-one-v1 (or the built-dataset directory)
 *   {built}        the directory `build` wrote s7/s8/s3/s4 datasets to
 *   {receipts}     docs/benchmarks/2026-09-30-system-one-jev/receipts
 *   {out}          this run's output directory
 */

export type DecideSlot = 'rerank' | 'intent' | 'evidence' | 'answerable' | 'injection' | 'recall_needed' | 'triage' | 'grounding' | 'conflict';
export type SlotId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9';

/**
 * longmemeval      `gbrain eval longmemeval` once per arm, --decide flags per arm.
 * brainbench       `gbrain eval brainbench --suite know-to-ask`, --decide per arm.
 * triage-pair      gbrain's runTriagePass (the function `gbrain dream` calls) per arm, via the checkout's s7-triage-pair.ts.
 * recorded-answers ask the dataset once through the slot's production request shape (ask-dataset.ts), then apply the
 *                  production reducer at the calibrated threshold against today's deterministic path (the analyzer).
 * judge-agreement  `gbrain decide judge-agreement`: Jev beside an existing LLM judge (Cohen's kappa).
 */
export type Method = 'longmemeval' | 'brainbench' | 'triage-pair' | 'recorded-answers' | 'judge-agreement';

export interface Arm {
  name: string;
  role: 'off' | 'on' | 'retest' | 'variant';
  args: string[];
  note?: string;
}

export interface Evaluation {
  id: string;
  slot: SlotId;
  decide_slot: DecideSlot;
  method: Method;
  question: string;
  datasets: string[];
  question_list?: 's-eval-half' | 's-eval-judged-100' | 'm-pilot-28';
  benchmark_file?: 'S' | 'M';
  embedding_model?: string;
  common_args?: string[];
  /** Absent for recorded-answers evaluations, which ask once and compare reducers offline. */
  arms?: Arm[];
  /** For recorded-answers: ask-dataset.ts arguments. */
  ask?: { split: 'eval' | 'calibrate' | 'all'; repeat: number };
  /** The checkout's analyzer (docs/eval/system-one/runners/<runner>) and its arguments; {values} is the recorded answers. */
  analyze?: { runner: string; args: string[] }[];
  /** `gbrain decide calibrate` / `qualify` arguments for the slot (paid, Jev). */
  calibrate?: string[];
  /** Provider keys the evaluation needs. */
  keys: string[];
  /** Committed receipts (relative to the receipts directory) this evaluation produced on 2026-09-30. */
  receipts: string[];
  /** What the 2026-09-30 run spent on this evaluation, from ledger.jsonl. */
  observed_cost: string;
  notes?: string[];
}

const COMMON_LME = ['--top-k', '5', '--by-type', '--no-trajectory', '--mode', 'balanced', '--autocut', 'off', '--capture-pool'];
const JEV = ['--decide', 'rerank=on'];
const R = ['--retrieval-only'];
const LME_KEYS = ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'JEV_TYPESAFE_API_KEY'];
const JEV_KEY = ['JEV_TYPESAFE_API_KEY'];

export const EVALUATIONS: readonly Evaluation[] = [
  {
    id: 's1-rerank-lme-s', slot: 'S1', decide_slot: 'rerank', method: 'longmemeval',
    question: 'Does Jev reranking put the needed conversations in the top five more often than the Voyage reranker used today?',
    datasets: [], question_list: 's-eval-half', benchmark_file: 'S', embedding_model: 'openai:text-embedding-3-large', common_args: COMMON_LME,
    arms: [
      { name: 's_voy30', role: 'off', args: [...R, '--reranker', 'on'], note: 'today: Voyage rerank-2.5, top_n_in 30' },
      { name: 's_off', role: 'variant', args: [...R, '--reranker', 'off'], note: 'no reranker' },
      { name: 's_voy100', role: 'variant', args: [...R, '--reranker', 'on', '--eval-pool-depth', '100'] },
      { name: 's_jev30', role: 'on', args: [...R, ...JEV, '--search-pin', 'search.reranker.top_n_in=30'] },
      { name: 's_jev50', role: 'on', args: [...R, ...JEV, '--search-pin', 'search.reranker.top_n_in=50'] },
      { name: 's_jev100', role: 'on', args: [...R, ...JEV, '--eval-pool-depth', '100'] },
      { name: 's_jev100x', role: 'on', args: [...R, ...JEV, '--eval-pool-depth', '100', '--expansion'], note: 'timed out on every question in the 2026-09-30 run (decide budget started before expansion); fixed in gbrain 9f7794ec, not re-measured' },
      { name: 's_jev100b', role: 'retest', args: [...R, ...JEV, '--eval-pool-depth', '100'] },
    ],
    keys: [...LME_KEYS, 'ANTHROPIC_API_KEY'], receipts: ['s1/longmemeval-s-summary.json', 's1/s_*.rows.jsonl'],
    observed_cost: 'LongMemEval-S embeddings $3.94 (one cache shared with the S2 and S3 arms), Jev rerank $1.17, Voyage rerank $0.60',
  },
  {
    id: 's1-rerank-lme-m-pilot', slot: 'S1', decide_slot: 'rerank', method: 'longmemeval',
    question: 'With 500 sessions per question and a deeper candidate pool, does Jev reranking beat Voyage at putting an answer session first?',
    datasets: [], question_list: 'm-pilot-28', benchmark_file: 'M', embedding_model: 'openai:text-embedding-3-small', common_args: COMMON_LME,
    arms: [
      { name: 'm_voy30', role: 'off', args: [...R, '--reranker', 'on'] },
      { name: 'm_off', role: 'variant', args: [...R, '--reranker', 'off', '--eval-pool-depth', '300'] },
      { name: 'm_jev100', role: 'on', args: [...R, ...JEV, '--eval-pool-depth', '100'] },
      { name: 'm_jev300', role: 'on', args: [...R, ...JEV, '--eval-pool-depth', '300'] },
      { name: 'm_jev100x', role: 'on', args: [...R, ...JEV, '--eval-pool-depth', '100', '--expansion'], note: 'same expansion timeout as s_jev100x' },
    ],
    keys: [...LME_KEYS, 'ANTHROPIC_API_KEY'], receipts: ['s1/longmemeval-m-pilot-summary.json', 's1/m_*.rows.jsonl'],
    observed_cost: 'embeddings $0.68 (text-embedding-3-small), Jev rerank $0.31, Voyage rerank part of $0.33',
  },
  {
    id: 's1-rerank-judged', slot: 'S1', decide_slot: 'rerank', method: 'longmemeval',
    question: 'Do answers get better or worse when Jev replaces Voyage as the reranker?',
    datasets: [], question_list: 's-eval-judged-100', benchmark_file: 'S', embedding_model: 'openai:text-embedding-3-large', common_args: COMMON_LME,
    arms: [
      { name: 'j_voy30', role: 'off', args: ['--model', 'anthropic:claude-haiku-4-5', '--judge', '--judge-model', 'openai:gpt-4o', '--max-usd', '4', '--yes', '--include-abstention', '--reranker', 'on'] },
      { name: 'j_jev30', role: 'on', args: ['--model', 'anthropic:claude-haiku-4-5', '--judge', '--judge-model', 'openai:gpt-4o', '--max-usd', '4', '--yes', '--include-abstention', ...JEV, '--search-pin', 'search.reranker.top_n_in=30'] },
    ],
    keys: [...LME_KEYS, 'ANTHROPIC_API_KEY'], receipts: ['s1/longmemeval-judged-summary.json'],
    observed_cost: 'Haiku 4.5 reader $3.58, gpt-4o judge $0.25, rerank $0.22',
  },
  {
    id: 's2-intent-lme', slot: 'S2', decide_slot: 'intent', method: 'longmemeval',
    question: 'Does Jev query routing change which conversations retrieval returns?',
    datasets: [], question_list: 's-eval-half', benchmark_file: 'S', embedding_model: 'openai:text-embedding-3-large', common_args: COMMON_LME,
    arms: [
      { name: 's_voy30', role: 'off', args: [...R, '--reranker', 'on'] },
      { name: 's_s2', role: 'on', args: [...R, '--reranker', 'on', '--decide', 'intent=on', '--decide-threshold', 'intent=0.98'] },
    ],
    keys: LME_KEYS, receipts: ['s3/longmemeval-decide-arms-summary.json', 's1/s_s2.rows.jsonl'],
    observed_cost: 'Jev $0.91 for the S2, S3 and S3+S5 arms together; Voyage part of $0.33',
  },
  {
    id: 's2-intent-routing', slot: 'S2', decide_slot: 'intent', method: 'recorded-answers',
    question: 'How often does Jev pick the right search or think route compared with the regex classifiers used today?',
    datasets: ['s2-intent'], ask: { split: 'all', repeat: 2 },
    analyze: [{ runner: 's2-analyze.ts', args: ['--values', '{values}', '--dataset', '{data}/s2-intent.jsonl'] }],
    keys: JEV_KEY, receipts: ['s2/values.jsonl', 's2/analysis.json'],
    observed_cost: 'part of the $3.88 Jev line for all recorded-answer, calibrate and qualify runs',
  },
  {
    id: 's3-evidence-lme', slot: 'S3', decide_slot: 'evidence', method: 'longmemeval',
    question: 'If the evidence gate prunes low-probability sessions, how much needed evidence does it lose and how much context does it save?',
    datasets: ['s3-evidence'], question_list: 's-eval-half', benchmark_file: 'S', embedding_model: 'openai:text-embedding-3-large', common_args: COMMON_LME,
    calibrate: ['--slot', 'evidence', '--dataset', '{built}/s3-evidence.jsonl', '--target', 'recall', '--min', '0.98'],
    arms: [
      { name: 's_voy30', role: 'off', args: [...R, '--reranker', 'on'] },
      { name: 's_s3', role: 'on', args: [...R, '--reranker', 'on', '--decide', 'evidence=on', '--decide-threshold', 'evidence=0.08', '--decide-force-on', 'evidence'], note: 'the calibrated 0.02 never prunes under the 0.05 margin; 0.08 is the lowest acting threshold and fails the 0.90 gate, so it runs force_on' },
      { name: 's_s3s5', role: 'variant', args: [...R, '--reranker', 'on', '--decide', 'evidence=on', '--decide', 'injection=on', '--decide-threshold', 'evidence=0.08', '--decide-threshold', 'injection=0.65', '--decide-force-on', 'evidence'], note: 'S3 with S5 co-packed on the same request' },
    ],
    keys: LME_KEYS, receipts: ['s3/longmemeval-decide-arms-summary.json', 's1/s_s3.rows.jsonl', 's1/s_s3s5.rows.jsonl', 's3/calibrate-s3.json', 's3/calibrate-s3s5.json', 's3/qualify-s3.json', 's3/qualify-s3s5.json'],
    observed_cost: 'Jev $0.91 for the S2, S3 and S3+S5 arms together, plus calibrate/qualify inside the $3.88 Jev line',
  },
  {
    id: 's4-answerable-values', slot: 'S4', decide_slot: 'answerable', method: 'recorded-answers',
    question: 'Can Jev tell from the top five sessions that a question has no answer, precisely enough to abstain?',
    datasets: ['s4-answerable'], ask: { split: 'all', repeat: 1 },
    calibrate: ['--slot', 'answerable', '--dataset', '{built}/s4-answerable.jsonl', '--target', 'recall'],
    keys: JEV_KEY, receipts: ['s4/values.jsonl', 's4/calibrate.json', 's4/qualify.json'],
    observed_cost: 'part of the $3.88 Jev line',
    notes: ['The upstream eval did not record the S4 calibration minimum; the stored calibration reached recall 0.962 at threshold 0.05. gbrain committed no S4 analyzer, so its abstention counts are not recomputed here.'],
  },
  {
    id: 's5-injection-values', slot: 'S5', decide_slot: 'injection', method: 'recorded-answers',
    question: 'Does the injection signal separate attack candidates from clean ones?',
    datasets: ['s5-injection'], ask: { split: 'all', repeat: 3 },
    keys: JEV_KEY, receipts: ['s5/values.jsonl'],
    observed_cost: 'part of the $3.88 Jev line',
  },
  {
    id: 's6-recall-needed-brainbench', slot: 'S6', decide_slot: 'recall_needed', method: 'brainbench',
    question: 'Does know-to-ask fetch memory for the turns the reflex rules miss, without firing on turns that need none?',
    datasets: ['s6-combined', 's6-brainbench', 's6-extra'],
    calibrate: ['--slot', 'recall_needed', '--dataset', '{data}/s6-recall-needed.combined.jsonl', '--target', 'f1'],
    arms: [
      { name: 'bb-bb-off', role: 'off', args: ['--suite', 'know-to-ask'] },
      { name: 'bb-bb-on', role: 'on', args: ['--suite', 'know-to-ask', '--decide', 'recall_needed=on', '--decide-calibration', '{receipts}/s6/calibrate.json', '--decide-dataset', '{data}/s6-recall-needed.combined.jsonl'] },
      { name: 'bb-extra-off', role: 'off', args: ['--suite', 'know-to-ask', '--fixtures', '{data}/know-to-ask-extra/fixtures', '--gold', '{data}/know-to-ask-extra/gold'] },
      { name: 'bb-extra-on', role: 'on', args: ['--suite', 'know-to-ask', '--fixtures', '{data}/know-to-ask-extra/fixtures', '--gold', '{data}/know-to-ask-extra/gold', '--decide', 'recall_needed=on', '--decide-calibration', '{receipts}/s6/calibrate.json', '--decide-dataset', '{data}/s6-recall-needed.combined.jsonl'] },
    ],
    keys: JEV_KEY, receipts: ['s6/bb-summary.json', 's6/calibrate.json', 's6/qualify.json'],
    observed_cost: 'part of the $3.88 Jev line',
  },
  {
    id: 's6-recall-needed-values', slot: 'S6', decide_slot: 'recall_needed', method: 'recorded-answers',
    question: 'At the calibrated threshold, how many know-to-ask turns does the S6 reducer fix and how many suppressions are correct?',
    datasets: ['s6-combined'], ask: { split: 'all', repeat: 2 },
    analyze: [
      { runner: 's6-analyze.ts', args: ['--values', '{values}', '--suppress-below', '0.10'] },
      { runner: 's6-analyze.ts', args: ['--values', '{values}', '--suppress-below', '0.05'] },
    ],
    keys: JEV_KEY, receipts: ['s6/values.jsonl', 's6/analysis-0.10.json', 's6/analysis-0.05.json'],
    observed_cost: 'part of the $3.88 Jev line',
  },
  {
    id: 's7-triage-pair', slot: 'S7', decide_slot: 'triage', method: 'triage-pair',
    question: 'Does Jev triage keep the synthesis-worthy chats that today\'s Haiku triage throws away, and what does it let through?',
    datasets: ['s7-triage'],
    calibrate: ['--slot', 'triage', '--dataset', '{built}/s7-triage.jsonl', '--target', 'recall', '--min', '1.0'],
    arms: [
      { name: 'arm-off-1', role: 'off', args: ['--arm', 'off'] },
      { name: 'arm-on-1', role: 'on', args: ['--arm', 'on'] },
      { name: 'arm-off-2', role: 'retest', args: ['--arm', 'off'] },
      { name: 'arm-on-2', role: 'retest', args: ['--arm', 'on'] },
    ],
    keys: [...JEV_KEY, 'ANTHROPIC_API_KEY'], receipts: ['s7/summary.json', 's7/arm-off-1.jsonl', 's7/arm-off-2.jsonl', 's7/arm-on-1.jsonl', 's7/arm-on-2.jsonl', 's7/calibrate.json', 's7/qualify.json'],
    observed_cost: 'Jev $0.25 and Haiku 4.5 $1.16 for calibrate, qualify and the four arms',
  },
  {
    id: 's8-grounding-values', slot: 'S8', decide_slot: 'grounding', method: 'recorded-answers',
    question: 'Can Jev quarantine unsupported claims in dream pages without losing supported ones?',
    datasets: ['s8-grounding'], ask: { split: 'all', repeat: 2 },
    calibrate: ['--slot', 'grounding', '--dataset', '{built}/s8-grounding.jsonl', '--target', 'recall', '--min', '0.95'],
    analyze: [{ runner: 's8-analyze.ts', args: ['--values', '{values}', '--dataset', '{built}/s8-grounding.jsonl', '--threshold', '0.29', '--margin', '0.05'] }],
    keys: JEV_KEY, receipts: ['s8/values.jsonl', 's8/analysis.json', 's8/calibrate.json', 's8/qualify.json'],
    observed_cost: 'part of the $3.88 Jev line',
  },
  {
    id: 's9-conflict-values', slot: 'S9', decide_slot: 'conflict', method: 'recorded-answers',
    question: 'Does Jev notice when a new fact replaces an old one, where today\'s cosine rule does not?',
    datasets: ['s9-conflict'], ask: { split: 'all', repeat: 2 },
    calibrate: ['--slot', 'conflict', '--dataset', '{data}/s9-conflict.jsonl', '--target', 'f1'],
    analyze: [
      { runner: 's9-analyze.ts', args: ['--values', '{values}', '--dataset', '{data}/s9-conflict.jsonl', '--dup-threshold', '0.52', '--floor', '0.65'] },
      { runner: 's9-analyze.ts', args: ['--values', '{values}', '--dataset', '{data}/s9-conflict.jsonl', '--dup-threshold', '0.52', '--floor', '0.65', '--eligible-only'] },
    ],
    keys: JEV_KEY, receipts: ['s9/values.jsonl', 's9/analysis-cal.json', 's9/analysis-cal--eligible-only.json', 's9/calibrate.json'],
    observed_cost: 'part of the $3.88 Jev line',
  },
  {
    id: 'judge-agreement-longmemeval', slot: 'S1', decide_slot: 'rerank', method: 'judge-agreement',
    question: 'How often does Jev agree with the gpt-4o LongMemEval answer judge?',
    datasets: [],
    arms: [{ name: 'longmemeval', role: 'on', args: ['--suite', 'longmemeval', '--input', '{out}/j_voy30.ndjson', '--json'], note: 'input is the judged j_voy30 rows from s1-rerank-judged' }],
    keys: JEV_KEY, receipts: ['judge/longmemeval.json'],
    observed_cost: 'Jev $0.003',
  },
  {
    id: 'judge-agreement-grounding', slot: 'S8', decide_slot: 'grounding', method: 'judge-agreement',
    question: 'How often does Jev agree with the claude-sonnet-5 grounding labels?',
    datasets: ['s8-grounding'],
    arms: [{ name: 'grounding', role: 'on', args: ['--suite', 'grounding', '--input', '{s8root}/docs/eval/system-one/datasets/s8-grounding/labels.jsonl', '--json'] }],
    keys: JEV_KEY, receipts: ['judge/grounding.json'],
    observed_cost: 'Jev $0.036',
  },
];

/**
 * Parts of the 2026-09-30 eval that have no runnable definition here, with
 * the reason. They stay as receipts and are named in the report.
 */
export const NOT_PORTED: readonly { id: string; reason: string; receipts: string[] }[] = [
  {
    id: 'preset-dream-e2e',
    reason: 'gbrain committed no driver for the preset end-to-end dream run (fresh brain, `decide enable --recommended`, `gbrain dream --phase synthesize --eval-run` over the 29 transcripts in preset-dream-29.txt); the brain setup and session-corpus wiring were not recorded, so a definition here would be a reconstruction, not the measured procedure',
    receipts: ['preset/dream-A.json', 'preset/dream-B.json', 'preset/preset-summary.json', 'preset/preset-pages.json'],
  },
  {
    id: 's7-local-llm-provider',
    reason: 'not measured upstream: S7 routed to a local `llm:` model was planned but the time budget went to the matched pairs',
    receipts: [],
  },
];

export function evaluation(id: string): Evaluation | undefined {
  return EVALUATIONS.find(e => e.id === id);
}

export function evaluationsFor(slotOrId: string): Evaluation[] {
  const exact = evaluation(slotOrId);
  if (exact) return [exact];
  return EVALUATIONS.filter(e => e.slot === slotOrId.toUpperCase() || e.decide_slot === slotOrId);
}

/** Replace {placeholders}; an unknown placeholder is an error, never passed through. */
export function resolveArgs(args: readonly string[], vars: Record<string, string>): string[] {
  return args.map(arg => arg.replace(/\{([A-Za-z0-9]+)\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`unresolved placeholder {${key}} in ${arg}`);
    return vars[key]!;
  }));
}

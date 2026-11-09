/**
 * Failure-cause taxonomy: the fixed list of causes every eval failure is
 * classified into, in the order of the stage that broke.
 *
 * Each cause maps to a failure mode in the gap map (F1 to F16) so the gap
 * measures, the nightly loop and the weekly report count the same causes.
 * docs/failure-causes/TAXONOMY.md is rendered from this file
 * (bun eval/runner/failure-causes/cli.ts taxonomy --write); a test keeps them equal.
 */

export const TAXONOMY_VERSION = '2026-11-09.3';

/** Pipeline stages, earliest first. A failure's primary cause is the first stage with a signal on its failure path. */
export const STAGES = ['harness', 'operations', 'ingest', 'visibility', 'tool_call', 'write', 'consult', 'retrieval', 'ranking', 'open', 'presentation', 'reasoning', 'budget'] as const;
export type Stage = typeof STAGES[number];

export interface CauseInfo {
  id: string;
  /** Gap-map failure mode(s), or "eval" for our own faults. */
  gap_map: string;
  stage: Stage;
  /** Whether a fix belongs to gbrain (true) or to the eval harness or the model (false). */
  gbrain_actionable: boolean;
  /** deterministic: read from logs; model: chosen by the residual labeller; either: both paths can assign it. */
  basis: 'deterministic' | 'model' | 'either';
  title: string;
  meaning: string;
  signal: string;
}

export const CAUSES = [
  { id: 'harness_error', gap_map: 'eval', stage: 'harness', gbrain_actionable: false, basis: 'deterministic', title: 'Harness error',
    meaning: 'Our runner, judge, gold or scorer failed, so the row says nothing about gbrain.',
    signal: 'outcome not scored, judge parse failure, stop harness_error or error, reader output cut at its limit, a known scorer artifact' },
  { id: 'operations', gap_map: 'F16', stage: 'operations', gbrain_actionable: true, basis: 'deterministic', title: 'Operations',
    meaning: 'An upgrade, sync, dream cycle, purge, Postgres-version or ingest-path operation failed.',
    signal: 'an operation step error or nonzero exit in a smoke or lifecycle record' },
  { id: 'ingest_gap', gap_map: 'F10', stage: 'ingest', gbrain_actionable: true, basis: 'deterministic', title: 'Ingest gap',
    meaning: 'The fact never reached the brain, or reached it wrong (tag wrong_stored_fact).',
    signal: 'the gold page or chunk is absent from the store or index' },
  { id: 'privacy_hidden', gap_map: 'F8', stage: 'visibility', gbrain_actionable: true, basis: 'deterministic', title: 'Hidden from this caller',
    meaning: 'The gold exists but access flags, aliases or scopes hid it from this caller. Whether the hide is correct is not decided here.',
    signal: 'visibility or private-flag fields on the gold in tool results' },
  { id: 'tool_contract', gap_map: 'F12', stage: 'tool_call', gbrain_actionable: true, basis: 'deterministic', title: 'Tool-contract refusal or friction',
    meaning: 'gbrain refused or rejected a call the agent meant correctly, and the failure followed from it.',
    signal: 'an unrecovered tool error or refusal code, or a resend the scorer failed' },
  { id: 'write_integrity', gap_map: 'F9', stage: 'write', gbrain_actionable: true, basis: 'deterministic', title: 'Lost, stuck, overwritten or duplicated write',
    meaning: 'A write was lost, stuck pending, overwritten or stored twice by gbrain.',
    signal: 'ledger and write records: missing, error pending, overwritten, a true duplicate' },
  { id: 'memory_not_consulted', gap_map: 'F13', stage: 'consult', gbrain_actionable: true, basis: 'deterministic', title: 'Memory not consulted',
    meaning: 'The agent never called memory for a question that needed it.',
    signal: 'no memory tool call in an agent-loop record' },
  { id: 'retrieval_miss', gap_map: 'F1', stage: 'retrieval', gbrain_actionable: true, basis: 'deterministic', title: 'Retrieval miss',
    meaning: 'No gold evidence appeared in any retrieval result.',
    signal: 'measured gold coverage of the retrieved results is zero, or the retriever threw (tag retrieve_error)' },
  { id: 'partial_evidence', gap_map: 'F7', stage: 'retrieval', gbrain_actionable: true, basis: 'deterministic', title: 'Partial evidence',
    meaning: 'Some but not all of the required gold was retrieved, as in cross-source or multi-hop questions.',
    signal: 'measured gold coverage between zero and all' },
  { id: 'wrong_ranking', gap_map: 'F1', stage: 'ranking', gbrain_actionable: true, basis: 'deterministic', title: 'Wrong ranking',
    meaning: 'Gold was retrieved but cut before the model saw it.',
    signal: 'gold in the results but dropped by packing or past the delivered top-k' },
  { id: 'gold_unopened', gap_map: 'F13', stage: 'open', gbrain_actionable: true, basis: 'deterministic', title: 'Gold found but not opened',
    meaning: 'A search returned the gold page but the agent never opened it.',
    signal: 'the gold id appears in search results and in no read call (agent loops only)' },
  { id: 'summary_loss', gap_map: 'F15', stage: 'presentation', gbrain_actionable: true, basis: 'either', title: 'Summary or large-page loss',
    meaning: 'The gold reached the model only through a summary or a cut page that lost the needed detail.',
    signal: 'the delivered gold item was truncated or summary-only' },
  { id: 'stale_fact', gap_map: 'F3,F4', stage: 'reasoning', gbrain_actionable: true, basis: 'model', title: 'Stale or contradicted fact',
    meaning: 'The answer used a superseded or contradicted fact.',
    signal: 'residual labeller; knowledge-update and contradiction categories are hints' },
  { id: 'wrong_entity', gap_map: 'F5', stage: 'reasoning', gbrain_actionable: true, basis: 'model', title: 'Wrong entity',
    meaning: 'The answer is about a different person, company or thing than the one asked about.',
    signal: 'residual labeller' },
  { id: 'time_reasoning', gap_map: 'F6', stage: 'reasoning', gbrain_actionable: true, basis: 'model', title: 'Time reasoning',
    meaning: 'Dates, durations or order came out wrong although the right evidence was there.',
    signal: 'residual labeller; temporal categories are hints' },
  { id: 'citation_abstention', gap_map: 'F14', stage: 'reasoning', gbrain_actionable: true, basis: 'either', title: 'Citation or abstention',
    meaning: 'The answer claimed what the evidence does not support: it answered when it should abstain, abstained wrongly, cited wrongly or misreported a write.',
    signal: 'an abstention question answered anyway, a misreported write state; otherwise the residual labeller' },
  { id: 'model_error', gap_map: 'F2', stage: 'reasoning', gbrain_actionable: false, basis: 'model', title: 'Model error with good context',
    meaning: 'The right evidence reached the model and the answer was still wrong for none of the reasons above.',
    signal: 'residual labeller' },
  { id: 'timeout_latency', gap_map: 'F11', stage: 'budget', gbrain_actionable: true, basis: 'deterministic', title: 'Timeout, turn cap or latency',
    meaning: 'The run hit a turn cap, a wall timeout, a context overflow or a latency bound, with no earlier stage to blame.',
    signal: 'stop turn_cap, timeout or context_overflow, with no earlier signal (otherwise a secondary cause)' },
] as const satisfies readonly CauseInfo[];

export type Cause = typeof CAUSES[number]['id'];
export const CAUSE_IDS: readonly Cause[] = CAUSES.map(c => c.id);
export const UNCLASSIFIED = 'unclassified' as const;

/** Causes the residual labeller may choose, plus unclassified when it abstains. */
export const MODEL_CAUSES: readonly Cause[] = CAUSES.filter(c => c.basis !== 'deterministic').map(c => c.id);

/** Tags that qualify a cause without changing it. */
export const TAGS = ['wrong_stored_fact', 'scorer_artifact', 'untitled_capture_duplicate', 'recovered_tool_error', 'score_zero', 'measured_at_10',
  'retrieval_or_ranking', 'said_wrong', 'unparseable_answer', 'record_session_not_recorded', 'excused_resend', 'misreport', 'turn_cap',
  'retrieve_error', 'no_answer'] as const;
export type Tag = typeof TAGS[number];

const BY_ID = new Map<string, CauseInfo>(CAUSES.map(c => [c.id, c]));
export const causeInfo = (id: string): CauseInfo | undefined => BY_ID.get(id);
export const isCause = (id: unknown): id is Cause => typeof id === 'string' && BY_ID.has(id);

export function renderTaxonomyMarkdown(): string {
  const basis = (b: CauseInfo['basis']) => (b === 'deterministic' ? 'logs' : b === 'model' ? 'labeller' : 'logs or labeller');
  const lines = [
    '# Failure causes',
    '',
    'Every failed eval row in gbrain-evals gets one primary cause from this list, chosen by the earliest stage of the',
    'pipeline that broke. Later signals stay on the row as secondary causes. Causes assigned by "logs" are read from tool',
    'errors, refusals, retrieval records and write records with no model. Causes assigned by the "labeller" are chosen by',
    'a model only when the right evidence reached the answering model and the logs show no earlier failure.',
    '',
    'The gap-map column links each cause to a failure mode (F1 to F16) in the gap map that the synthetic measures and',
    'the nightly loop use. Rendered from `eval/runner/failure-causes/taxonomy.ts` by',
    '`bun eval/runner/failure-causes/cli.ts taxonomy --write`; edit the TypeScript, not this file.',
    '',
    `Taxonomy version \`${TAXONOMY_VERSION}\`. Stages, earliest first: ${STAGES.map(s => '`' + s + '`').join(', ')}. The last stage, `,
    '`budget`, is a fallback: a turn cap or timeout is the primary cause only when no earlier stage has a signal.',
    '',
    '| Cause | Gap map | Stage | Assigned by | gbrain can fix | Meaning | Signal |',
    '|---|---|---|---|---|---|---|',
    ...CAUSES.map(c => `| \`${c.id}\` | ${c.gap_map} | ${c.stage} | ${basis(c.basis)} | ${c.gbrain_actionable ? 'yes' : 'no'} | ${c.meaning} | ${c.signal} |`),
    `| \`${UNCLASSIFIED}\` | none | none | labeller abstained, or no signal | no | No signal applies and the labeller abstained. | none |`,
    '',
    `Tags qualify a cause without changing it: ${TAGS.map(t => '`' + t + '`').join(', ')}.`,
  ];
  return lines.join('\n') + '\n';
}

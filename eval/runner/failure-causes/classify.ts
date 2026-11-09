/**
 * Deterministic failure classification. classify() reads only the signals in
 * an EvalFailure, applies the rules stage by stage (taxonomy.ts STAGES), and
 * returns the first stage's cause as primary with every later signal kept as
 * a secondary cause. A scorer artifact is primary only when it is the row's
 * only signal, so it never hides a real failure. A failure with no signal
 * comes back as needs_model, for the residual labeller, unless the source did
 * not measure whether the gold reached the model and kept no delivered context
 * to check: that row stays unclassified, because a reasoning-only labeller
 * cannot rule out an upstream miss. A row no labeller may read (no recorded
 * text, or a private or sealed source) is unclassified too, so it never waits
 * for a label that cannot come. The function is pure: no I/O, no clock, no
 * model.
 */
import { CAUSES, STAGES, TAXONOMY_VERSION, UNCLASSIFIED, type Cause, type Stage, type Tag } from './taxonomy.ts';
import { FAILURE_CAUSE_SCHEMA, type CauseLabel, type EvalFailure } from './types.ts';

const HARNESS_STOPS = new Set(['harness_error', 'error']);
const TIMEOUT_STOPS = new Set(['turn_cap', 'timeout', 'context_overflow', 'max_turns']);
const TURN_CAPS = new Set(['turn_cap', 'max_turns']);
const TRUNCATED_FINISH = new Set(['length', 'max_tokens', 'max_output_tokens']);
const STAGE_OF = new Map<Cause, Stage>(CAUSES.map(c => [c.id, c.stage]));

interface Hit { cause: Cause; rule: string }

function signals(f: EvalFailure): { hits: Hit[]; unmeasured: Stage[]; tags: Set<Tag> } {
  const hits: Hit[] = [];
  const unmeasured: Stage[] = [];
  const tags = new Set<Tag>(f.tags);
  if (f.stop && TURN_CAPS.has(f.stop)) tags.add('turn_cap');
  const hit = (cause: Cause, rule: string) => hits.push({ cause, rule });
  const g = f.gold;

  if (f.harness?.error) hit('harness_error', 'harness.error');
  if (f.harness?.scorer_artifact) { hit('harness_error', `harness.scorer_artifact.${f.harness.scorer_artifact}`); tags.add('scorer_artifact'); }
  if (f.stop && HARNESS_STOPS.has(f.stop)) hit('harness_error', `harness.stop_${f.stop}`);
  if (f.finish_reason && TRUNCATED_FINISH.has(f.finish_reason)) hit('harness_error', 'harness.output_truncated');

  if (f.operation) hit('operations', `operations.${f.operation.step}`);

  if (tags.has('wrong_stored_fact')) hit('ingest_gap', 'ingest.wrong_stored_fact');
  if (g.stored === null) unmeasured.push('ingest');
  else if (g.stored !== 'all') hit('ingest_gap', g.stored === 'none' ? 'ingest.gold_not_stored' : 'ingest.gold_partly_stored');

  if (g.hidden === null) unmeasured.push('visibility');
  else if (g.hidden !== 'none') hit('privacy_hidden', g.hidden === 'all' ? 'visibility.gold_hidden' : 'visibility.gold_partly_hidden');

  if (f.tool_calls === null) unmeasured.push('tool_call');
  else {
    const errors = f.tool_calls.filter(c => c.error !== null);
    if (errors.some(c => c.recovered === false)) hit('tool_contract', 'tool.unrecovered_error');
    else if (errors.some(c => c.recovered === null)) hit('tool_contract', 'tool.error_recovery_unknown');
    else if (errors.length) tags.add('recovered_tool_error');
  }

  if (f.writes === null) unmeasured.push('write');
  else for (const kind of ['lost', 'stuck', 'overwritten', 'duplicated'] as const) {
    const ids = f.writes[kind];
    if (ids === null) continue;
    if (ids.length) hit('write_integrity', `write.${kind}`);
  }

  if (f.agent_loop) {
    if (f.tool_calls === null) unmeasured.push('consult');
    else if (!f.tool_calls.some(c => c.memory) || f.stop === 'no_tool_call') hit('memory_not_consulted', 'consult.no_memory_call');
  }

  if (tags.has('retrieve_error')) hit('retrieval_miss', 'retrieval.retrieve_error');
  else if (g.gold_count === 0) {
    if (/abstention/.test(f.category ?? '')) hit('citation_abstention', 'reasoning.answered_unanswerable');
  } else {
    if (g.retrieved === null && g.delivered === null) unmeasured.push('retrieval', 'ranking');
    else if (g.retrieved === null) {
      unmeasured.push('ranking');
      if (g.delivered === 'none') { hit('retrieval_miss', 'retrieval.no_gold_delivered'); tags.add('retrieval_or_ranking'); }
      else if (g.delivered === 'partial') hit('partial_evidence', 'retrieval.partial_gold_delivered');
    } else if (g.retrieved === 'none') hit('retrieval_miss', 'retrieval.no_gold_retrieved');
    else {
      if (g.delivered === null) unmeasured.push('ranking');
      else if (g.delivered === 'none') hit('wrong_ranking', 'ranking.gold_cut');
      else if (g.delivered === 'partial' && g.retrieved === 'all') hit('wrong_ranking', 'ranking.some_gold_cut');
      if (g.retrieved === 'partial' && g.delivered !== 'none') hit('partial_evidence', 'retrieval.partial_gold_retrieved');
    }
    if (f.agent_loop) {
      if (g.opened === null) unmeasured.push('open');
      else if (g.opened === 'none' && (g.retrieved === 'all' || g.retrieved === 'partial')) hit('gold_unopened', 'open.gold_never_opened');
    }
  }

  if (g.summary_only === null) unmeasured.push('presentation');
  else if (g.summary_only) hit('summary_loss', 'presentation.summary_only');

  if (tags.has('misreport')) hit('citation_abstention', 'reasoning.misreported_state');
  return { hits, unmeasured, tags };
}

export function classify(f: EvalFailure): CauseLabel {
  const { hits, unmeasured, tags } = signals(f);
  const rank = (h: Hit) => STAGES.indexOf(STAGE_OF.get(h.cause)!);
  const artifact = (h: Hit) => h.rule.startsWith('harness.scorer_artifact.');
  const sorted = [...hits].sort((a, b) => Number(artifact(a)) - Number(artifact(b)) || rank(a) - rank(b));
  const timeout = f.stop !== null && TIMEOUT_STOPS.has(f.stop);
  const primary: Hit | null = timeout && (!sorted.length || artifact(sorted[0])) ? { cause: 'timeout_latency', rule: `budget.${f.stop}` } : sorted[0] ?? null;
  const secondary = [...new Set([...sorted.map(h => h.cause), ...(timeout ? ['timeout_latency' as const] : [])])].filter(c => c !== primary?.cause);
  const base: Omit<CauseLabel, 'cause' | 'basis' | 'rule_id'> = {
    schema: FAILURE_CAUSE_SCHEMA, taxonomy_version: TAXONOMY_VERSION, source: f.source, run_id: f.run_id, case_id: f.case_id, task_id: f.task_id ?? null,
    system: f.system, arm: f.arm, arm_role: f.arm_role, condition: f.condition, visibility: f.visibility, model: f.model,
    gbrain_sha: f.gbrain_sha, category: f.category, secondary, tags: [...tags].sort(), unmeasured: [...new Set(unmeasured)],
    evidence: f.evidence, labeller: null,
  };
  if (!f.failed) return { ...base, cause: null, basis: 'unclassified', rule_id: 'passed', secondary: [] };
  if (primary) return { ...base, cause: primary.cause, basis: 'deterministic', rule_id: primary.rule };
  if (deliveryUnknown(f) && (f.text?.context ?? null) === null) return { ...base, cause: UNCLASSIFIED, basis: 'unclassified', rule_id: 'residual.delivery_unmeasured' };
  if (!f.text || f.visibility === 'private' || f.visibility === 'sealed') return { ...base, cause: UNCLASSIFIED, basis: 'unclassified', rule_id: 'residual.no_labeller_text' };
  return { ...base, cause: null, basis: 'needs_model', rule_id: 'residual' };
}

/** The source did not measure whether the gold reached the answering model. */
export function deliveryUnknown(f: EvalFailure): boolean {
  return f.gold.gold_count !== 0 && f.gold.delivered === null;
}

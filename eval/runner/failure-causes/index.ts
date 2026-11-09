/**
 * The failure-cause library's stable interface, for the nightly loop and the weekly report.
 * Breaking changes bump FAILURE_CAUSE_SCHEMA or EVAL_FAILURE_SCHEMA; test/eval/failure-causes-schema.test.ts pins both shapes.
 */
export { CAUSES, CAUSE_IDS, MODEL_CAUSES, STAGES, TAGS, TAXONOMY_VERSION, UNCLASSIFIED, causeInfo, isCause, renderTaxonomyMarkdown } from './taxonomy.ts';
export type { Cause, CauseInfo, Stage, Tag } from './taxonomy.ts';
export { EVAL_FAILURE_SCHEMA, FAILURE_CAUSE_SCHEMA } from './types.ts';
export type { ArmRole, CauseLabel, Condition, Coverage, EvalFailure, FailureText, GoldExposure, LabelBasis, LabellerInfo, SourceCounts, StressCount, ToolCall, Visibility, WriteRecord } from './types.ts';
export { classify } from './classify.ts';
export { ADAPTERS, fromCat40, fromLiveRecall, fromRefreshBarrier, fromRs1, fromSkillOpt } from './adapters/index.ts';
export type { AdapterOutput } from './adapters/index.ts';
export { SOURCES_SCHEMA, loadSource, pointer, readManifest, validateManifest } from './manifest.ts';
export type { SourceEntry, SourceManifest } from './manifest.ts';
export { ASTRA_LABELLER, LABEL_SET_LABELLERS, PRODUCTION_LABELLERS, buildLabelPrompt, labelResidual, labelSet, labellerFor, parseLabel } from './label.ts';
export type { LabellerSpec, LabelRun, LabelSetRun } from './label.ts';
export { KAPPA_MIN, MIN_AGREED_PER_PATH, buildLabelSet, cohensKappa, confusion, gatePaths, knownAnswerAccuracy, perCause, productionLabels, stratifiedSample } from './agreement.ts';
export { REGRESSION_TESTS, issueDrafts, renderReport, summarize } from './report.ts';
export type { IssueDraft, RankedCause, Summary } from './report.ts';

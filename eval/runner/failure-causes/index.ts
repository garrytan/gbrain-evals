/**
 * The failure-cause library's stable interface, for the nightly loop and the weekly report.
 * Breaking changes bump FAILURE_CAUSE_SCHEMA or EVAL_FAILURE_SCHEMA; test/eval/failure-causes-schema.test.ts pins both shapes.
 */
export { CAUSES, CAUSE_IDS, MODEL_CAUSES, STAGES, TAGS, TAXONOMY_VERSION, UNCLASSIFIED, causeInfo, isCause, renderTaxonomyMarkdown } from './taxonomy.ts';
export type { Cause, CauseInfo, Stage, Tag } from './taxonomy.ts';
export { EVAL_FAILURE_SCHEMA, FAILURE_CAUSE_SCHEMA } from './types.ts';
export type { ArmRole, CauseLabel, Condition, Coverage, EvalFailure, FailureText, GoldExposure, LabelBasis, LabellerInfo, SourceCounts, StressCount, ToolCall, Visibility, WriteRecord } from './types.ts';
export { classify, deliveryUnknown } from './classify.ts';
export { ADAPTERS, fromCat40, fromLiveRecall, fromNightly, fromRefreshBarrier, fromRs1, fromSkillOpt } from './adapters/index.ts';
export { nightlyFailure } from './adapters/nightly.ts';
export type { AdapterOutput } from './adapters/index.ts';
export { SOURCES_SCHEMA, loadSource, pointer, readManifest, validateManifest } from './manifest.ts';
export type { SourceEntry, SourceManifest } from './manifest.ts';
export { ASTRA_LABELLER, LABEL_PROMPT_SHA256, LABEL_SET_LABELLERS, NOT_DELIVERED, PRODUCTION_LABELLERS, buildLabelPrompt, labelResidual, labelSet, labellerFor, parseLabel, resolveChoice } from './label.ts';
export type { LabellerSpec, LabelRun, LabelSetRun } from './label.ts';
export { KAPPA_MIN, LABEL_SET_PER_FAMILY, MIN_AGREED_PER_PATH, NO_LABEL_RULES, buildLabelSet, cohensKappa, confusion, gatePaths, knownAnswerAccuracy, labelSetSample, perCause, productionLabels, stratifiedSample, ungated } from './agreement.ts';
export type { DoubleLabel, LabelSetRow, PathGate, Production } from './agreement.ts';
export { REGRESSION_TESTS, issueDrafts, renderReport, summarize } from './report.ts';
export type { IssueDraft, KnownStatus, RankedCause, Summary, TaskComparison } from './report.ts';

/**
 * Per-benchmark reader and judge defaults for run.ts and run-systems.ts.
 *
 * Each benchmark keeps its preregistered pair from qa.ts, whose bytes the H1
 * decision pins (test/eval/budgeted-delivery-h1.test.ts): LongMemEval's
 * official GPT-4o judge, the LoCoMo reader that links to the published
 * numbers and the gpt-4.1-mini BEAM bridge. The fixture has no protocol behind
 * it, so it reads and judges with current models (R4, 2026-11-01).
 */
import { DEFAULT_JUDGE, DEFAULT_READER } from './qa.ts';

export const QA_READER: Readonly<Record<string, string>> = { ...DEFAULT_READER, fixture: 'anthropic:claude-opus-5-5' };
export const QA_JUDGE: Readonly<Record<string, string>> = { ...DEFAULT_JUDGE, fixture: 'anthropic:claude-haiku-5-5' };

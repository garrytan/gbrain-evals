/**
 * Runtime Query schema validator.
 *
 * Per the v1.1 eng pass 2 spec. Hand-rolled (no zod dep) to match existing
 * gbrain codebase style (see src/core/yaml-lite.ts for precedent).
 *
 * Validates:
 *   - Required fields (id, tier, text, expected_output_type, gold)
 *   - Tier enum
 *   - expected_output_type enum
 *   - Temporal `as_of_date` rule: any query with a temporal verb MUST
 *     set as_of_date to ISO-8601 | "corpus-end" | "per-source"
 *   - id uniqueness within a batch
 *   - Gold shape for EVERY expected_output_type (audit adapters-queries-09:
 *     only cited-source-pages and abstention used to be checked, which let
 *     items with structurally unscoreable gold pass CI):
 *       cited-source-pages        gold.relevant[] non-empty, slug format
 *       abstention                gold.expected_abstention === true
 *       answer-string             gold.expected_answer or acceptable_variants
 *       time-qualified-answer     gold.expected_answer + as_of_date
 *       canonical-entity-id       gold.expected_entity_id in slug format
 *       contradiction-explanation gold.expected_citations[] with >= 2 slugs
 *                                 (a contradiction needs both sides)
 *       poison-flag               gold.relevant[] naming the poisoned pages
 *       confidence-score          gold.expected_confidence number in [0, 1]
 *
 * Public functions:
 *   validateQuery(q)      -> ValidationResult single-query
 *   validateQuerySet(qs)  -> ValidationResult<batch>
 *
 * On failure, returns human-readable reasons with the offending query id
 * so `eval:query:validate` can point contributors at the exact problem.
 */

import type { Query, Tier, ExpectedOutputType } from '../types.ts';

// ─── Enums ─────────────────────────────────────────────────────────

const VALID_TIERS: readonly Tier[] = [
  'easy', 'medium', 'hard', 'adversarial', 'fuzzy', 'externally-authored',
] as const;

const VALID_OUTPUT_TYPES: readonly ExpectedOutputType[] = [
  'answer-string',
  'canonical-entity-id',
  'cited-source-pages',
  'time-qualified-answer',
  'abstention',
  'contradiction-explanation',
  'poison-flag',
  'confidence-score',
] as const;

// ─── Temporal rule (per eng pass 2) ────────────────────────────────

/**
 * Regex for detecting temporal verbs in query text. If any of these
 * appear, the query is temporal and MUST carry an `as_of_date` field.
 * Without that, scoring is ambiguous (which version of the fact is
 * considered correct?).
 */
export const TEMPORAL_VERBS =
  /\b(is|was|were|current|now|at the time|during|as of|when did)\b/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/** "dir/slug" page-reference format (e.g. "people/alice-chen"). */
const SLUG_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

// ─── Types ─────────────────────────────────────────────────────────

export interface ValidationIssue {
  queryId: string;
  field: string;
  reason: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Count of queries processed (for batch). 1 for single-query validation. */
  total: number;
}

// ─── Individual query validation ───────────────────────────────────

export function validateQuery(q: Query): ValidationResult {
  const issues: ValidationIssue[] = [];
  const qid = q.id || '(missing id)';

  if (!q.id || typeof q.id !== 'string' || q.id.trim().length === 0) {
    issues.push({ queryId: qid, field: 'id', reason: 'id must be a non-empty string (e.g. "q-0001")' });
  }
  if (!q.text || typeof q.text !== 'string' || q.text.trim().length === 0) {
    issues.push({ queryId: qid, field: 'text', reason: 'text must be a non-empty string' });
  }
  if (!VALID_TIERS.includes(q.tier)) {
    issues.push({ queryId: qid, field: 'tier', reason: `tier must be one of ${VALID_TIERS.join(', ')}` });
  }
  if (!VALID_OUTPUT_TYPES.includes(q.expected_output_type)) {
    issues.push({
      queryId: qid,
      field: 'expected_output_type',
      reason: `expected_output_type must be one of ${VALID_OUTPUT_TYPES.join(', ')}`,
    });
  }
  if (!q.gold || typeof q.gold !== 'object') {
    issues.push({ queryId: qid, field: 'gold', reason: 'gold must be an object' });
  }

  // Temporal as-of-date rule (eng pass 2).
  if (q.text && TEMPORAL_VERBS.test(q.text)) {
    if (q.as_of_date === undefined || q.as_of_date === null || q.as_of_date === '') {
      issues.push({
        queryId: qid,
        field: 'as_of_date',
        reason:
          'temporal verb detected; as_of_date required. Set to "corpus-end", "per-source", or an ISO-8601 date.',
      });
    } else if (
      q.as_of_date !== 'corpus-end' &&
      q.as_of_date !== 'per-source' &&
      !ISO_DATE_RE.test(q.as_of_date)
    ) {
      issues.push({
        queryId: qid,
        field: 'as_of_date',
        reason: 'as_of_date must be "corpus-end", "per-source", or ISO-8601 (YYYY-MM-DD)',
      });
    }
  }

  // ── Per-output-type gold shape (all 8 types; audit adapters-queries-09) ──
  const gold = (q.gold ?? {}) as Record<string, unknown>;

  /** Push an issue unless `arr` is a non-empty array of slug-format strings. */
  const requireSlugArray = (field: string, arr: unknown, reason: string, minLen = 1): void => {
    if (!Array.isArray(arr) || arr.length < minLen) {
      issues.push({ queryId: qid, field, reason });
      return;
    }
    for (const s of arr) {
      if (typeof s !== 'string' || !SLUG_RE.test(s)) {
        issues.push({
          queryId: qid,
          field,
          reason: `slug "${s}" does not match "dir/slug" format (e.g. "people/alice-chen")`,
        });
        break; // one message per query is enough
      }
    }
  };

  switch (q.expected_output_type) {
    case 'cited-source-pages':
      requireSlugArray(
        'gold.relevant',
        gold.relevant,
        'cited-source-pages queries require gold.relevant[] with at least one slug',
      );
      break;

    case 'abstention':
      if (gold.expected_abstention !== true) {
        issues.push({
          queryId: qid,
          field: 'gold.expected_abstention',
          reason: 'abstention queries require gold.expected_abstention === true',
        });
      }
      break;

    case 'answer-string': {
      const hasAnswer = typeof gold.expected_answer === 'string' && gold.expected_answer.trim().length > 0;
      const hasVariants = Array.isArray(q.acceptable_variants) && q.acceptable_variants.length > 0;
      if (!hasAnswer && !hasVariants) {
        issues.push({
          queryId: qid,
          field: 'gold.expected_answer',
          reason: 'answer-string queries require gold.expected_answer (or acceptable_variants) — without judgeable gold the item can never score',
        });
      }
      break;
    }

    case 'time-qualified-answer': {
      if (typeof gold.expected_answer !== 'string' || gold.expected_answer.trim().length === 0) {
        issues.push({
          queryId: qid,
          field: 'gold.expected_answer',
          reason: 'time-qualified-answer queries require gold.expected_answer',
        });
      }
      // as_of_date is required for this type even when no temporal verb
      // triggered the generic rule above (skip if that rule already flagged it).
      if (!issues.some(i => i.queryId === qid && i.field === 'as_of_date')
        && (q.as_of_date === undefined || q.as_of_date === null || q.as_of_date === '')) {
        issues.push({
          queryId: qid,
          field: 'as_of_date',
          reason: 'time-qualified-answer queries require as_of_date ("corpus-end", "per-source", or ISO-8601)',
        });
      }
      break;
    }

    case 'canonical-entity-id':
      if (typeof gold.expected_entity_id !== 'string' || !SLUG_RE.test(gold.expected_entity_id)) {
        issues.push({
          queryId: qid,
          field: 'gold.expected_entity_id',
          reason: 'canonical-entity-id queries require gold.expected_entity_id in "dir/slug" format',
        });
      }
      break;

    case 'contradiction-explanation':
      requireSlugArray(
        'gold.expected_citations',
        gold.expected_citations,
        'contradiction-explanation queries require gold.expected_citations[] with at least the 2 disagreeing source slugs',
        2,
      );
      break;

    case 'poison-flag':
      requireSlugArray(
        'gold.relevant',
        gold.relevant,
        'poison-flag queries require gold.relevant[] naming the poisoned page(s) the system must flag',
      );
      break;

    case 'confidence-score': {
      const c = gold.expected_confidence;
      if (typeof c !== 'number' || Number.isNaN(c) || c < 0 || c > 1) {
        issues.push({
          queryId: qid,
          field: 'gold.expected_confidence',
          reason: 'confidence-score queries require gold.expected_confidence as a number in [0, 1]',
        });
      }
      break;
    }
  }

  // Tier 5.5 externally-authored queries must carry an author field.
  if (q.tier === 'externally-authored') {
    if (!q.author || typeof q.author !== 'string' || q.author.trim().length === 0) {
      issues.push({
        queryId: qid,
        field: 'author',
        reason: 'externally-authored queries require an author field (e.g. "@alice-researcher" or "synthetic-outsider-v1")',
      });
    }
  }

  return { ok: issues.length === 0, issues, total: 1 };
}

// ─── Batch validation ───────────────────────────────────────────────

export function validateQuerySet(queries: Query[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();

  for (const q of queries) {
    const r = validateQuery(q);
    issues.push(...r.issues);

    // Duplicate ID check (batch-level).
    if (q.id) {
      if (seenIds.has(q.id)) {
        issues.push({ queryId: q.id, field: 'id', reason: 'duplicate id in batch' });
      }
      seenIds.add(q.id);
    }
  }

  return { ok: issues.length === 0, issues, total: queries.length };
}

// ─── Formatting helpers (for CLI output) ───────────────────────────

export function formatIssues(result: ValidationResult): string {
  if (result.ok) {
    return `\u2713 All ${result.total} queries valid.`;
  }
  const lines: string[] = [];
  lines.push(`\u2717 ${result.issues.length} issue(s) across ${result.total} query/queries:`);
  for (const issue of result.issues) {
    lines.push(`  [${issue.queryId}] ${issue.field}: ${issue.reason}`);
  }
  return lines.join('\n');
}

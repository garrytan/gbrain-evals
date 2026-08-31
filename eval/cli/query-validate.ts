#!/usr/bin/env bun
/**
 * eval:query:validate — validate a query file (or the built-in Tier 5/5.5 set).
 *
 * Usage:
 *   bun run eval:query:validate                    # validate all built-in T5+T5.5
 *   bun run eval:query:validate path/to/file.json  # JSON: Query[] | {queries} | one Query
 *   bun run eval:query:validate path/to/file.ts    # module exporting Query[] (default or named)
 *   bun run eval:query:validate --help
 *
 * Exit code 0 if all queries pass, 1 otherwise. Suitable for CI.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { validateAll, validateQuerySet, formatIssues } from '../runner/queries/index.ts';
import type { Query } from '../runner/types.ts';

function printHelp() {
  console.log(`eval:query:validate — validate a Query set

USAGE
  bun run eval:query:validate                 validate all built-in T5 + T5.5 queries
  bun run eval:query:validate <path>          validate a query file:
                                                .json — Query[] | { queries: Query[] } | a single Query
                                                .ts/.js — module exporting Query[] (default export,
                                                          a \`queries\` export, or any array export)

VALIDATOR CHECKS
  - id, text, tier, expected_output_type present
  - Temporal verbs (is/was/were/current/now/at the time/during/as of/when did)
    require as_of_date ("corpus-end" | "per-source" | ISO-8601)
  - cited-source-pages requires non-empty gold.relevant with valid slug format
  - abstention requires gold.expected_abstention === true
  - externally-authored (Tier 5.5) requires author field
  - Duplicate IDs caught at batch level

EXIT CODES
  0  all queries valid
  1  one or more queries failed validation
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const filePath = args[0];

  if (!filePath) {
    // Validate built-in T5 + T5.5 sets
    const result = validateAll();
    console.log(result.report);
    process.exit(result.ok ? 0 : 1);
  }

  // Validate a file.
  //   .ts/.js/.mjs — dynamic-import the module and take the default export,
  //                  a `queries` export, or the first array export found
  //                  (audit finding generators-16: the header advertised .ts
  //                  support but the loader only ever JSON.parsed).
  //   anything else — JSON: Query[] | { queries: Query[] } | a single Query
  //                  object (the eval:query:new scaffold shape).
  let queries: Query[] = [];
  try {
    if (/\.(ts|js|mjs)$/i.test(filePath)) {
      const mod = (await import(resolve(filePath))) as Record<string, unknown>;
      const candidate = Array.isArray(mod.default)
        ? mod.default
        : Array.isArray(mod.queries)
          ? mod.queries
          : Object.values(mod).find(Array.isArray);
      queries = (candidate as Query[] | undefined) ?? [];
    } else {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      queries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.queries)
          ? parsed.queries
          : parsed && typeof parsed === 'object' && typeof parsed.id === 'string'
            ? [parsed]
            : [];
    }
  } catch (e) {
    console.error(`Error reading ${filePath}: ${(e as Error).message}`);
    process.exit(1);
  }

  if (queries.length === 0) {
    console.error(
      `No queries found in ${filePath}. Expected JSON Query[] / { queries: Query[] } / a single Query, ` +
      `or a .ts/.js module exporting Query[].`,
    );
    process.exit(1);
  }

  const result = validateQuerySet(queries);
  console.log(formatIssues(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

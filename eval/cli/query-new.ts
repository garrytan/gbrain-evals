#!/usr/bin/env bun
/**
 * eval:query:new — scaffold a new Tier 5.5 query from template.
 *
 * Prints a well-formed Query JSON block that passes `eval:query:validate`.
 * Contributors copy-paste into their own query file (or a PR against
 * eval/external-authors/<author-slug>/queries.json).
 *
 * Usage:
 *   bun run eval:query:new                        # default tier 5.5
 *   bun run eval:query:new --tier fuzzy
 *   bun run eval:query:new --tier externally-authored --author "@alice"
 *   bun run eval:query:new --id q-custom-0042
 */

import type { Query, Tier } from '../runner/types.ts';
import { validateQuery, formatIssues } from '../runner/queries/validator.ts';

function printHelp() {
  console.log(`eval:query:new — scaffold a Query template

USAGE
  bun run eval:query:new                              scaffold default (tier 5.5)
  bun run eval:query:new --tier easy                  specify tier
  bun run eval:query:new --id q-0001                  specify id
  bun run eval:query:new --author "@alice-researcher" external author

OPTIONS
  --tier       easy | medium | hard | adversarial | fuzzy | externally-authored
  --id         Query ID (default: q-<timestamp>)
  --author     Author handle (required for tier=externally-authored)

OUTPUT
  Prints a JSON object that passes eval:query:validate. Copy into
  your query file, fill in gold.relevant (or expected_abstention for
  abstention queries), and iterate.
`);
}

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}`) {
      const next = process.argv[process.argv.indexOf(a) + 1];
      if (next && !next.startsWith('--')) return next;
    }
  }
  return fallback;
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const tier = (getArg('tier') ?? 'externally-authored') as Tier;
  const id = getArg('id') ?? `q-${Date.now().toString().slice(-6)}`;
  const author = getArg('author');

  const template: Query = {
    id,
    tier,
    // No temporal verb here on purpose — the validator only demands as_of_date
    // when the text contains one, so the scaffold validates as printed.
    text: 'REPLACE with your query text (a question or search fragment)',
    expected_output_type: 'cited-source-pages',
    gold: {
      // Placeholders conform to the validator's dir/slug regex
      // (lowercase, hyphens) so the scaffold passes out of the box
      // (audit finding generators-15: the old uppercase 'REPLACE/...'
      // placeholder failed the slug check before the user typed anything).
      relevant: ['replace-me/with-real-slug', 'replace-me/with-another-slug-if-needed'],
    },
    tags: ['replace-with-tier-or-theme-tags'],
  };

  if (tier === 'externally-authored') {
    template.author = author ?? '@replace-with-your-handle';
  }

  // Self-check the documented contract ("prints a JSON block that passes
  // eval:query:validate") instead of asserting it in a comment. A tier typo
  // or template drift fails loudly here rather than in the contributor's PR.
  const check = validateQuery(template);
  if (!check.ok) {
    console.error(`eval:query:new: scaffold does not validate — fix the flag or file a bug:\n${formatIssues(check)}`);
    process.exit(1);
  }

  // JSON on stdout only, hints on stderr — so `eval:query:new > my-query.json`
  // produces a file that eval:query:validate accepts directly.
  console.log(JSON.stringify(template, null, 2));
  console.error(`\n// Next: save as a JSON file, run 'bun run eval:query:validate <path>'`);
  console.error(`// If your query text is temporal (is/was/current/...), add as_of_date: "corpus-end" | "per-source" | YYYY-MM-DD`);
  console.error(`// For Tier 5.5: submit a PR to eval/external-authors/${author ?? '<your-slug>'}/queries.json`);
}

main();

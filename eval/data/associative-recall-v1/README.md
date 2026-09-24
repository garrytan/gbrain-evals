# Associative recall fixtures, version 1

These synthetic histories test whether retrieval can connect a later situation to the original notes that matter. For example, a volunteer preparing another telescope observation needs the earlier explanation of mismatched timestamps and the later clock-check decision, not advice about adjusting the tracking motor.

The fixtures are frozen for implementation work as of September 23, 2026. **Independent human relevance review is still required before publishing capability results.** `manifest.json` records `pending-independent-relevance-review`; a passing integrity test does not approve the labels or establish search quality. No retrieval benchmark or separate provider API call was run to create this corpus.

## What is included

There are 120 individually specified scenario families, not a smaller set expanded by replacing names. Each family has a different practical situation, its own history, a tempting other-party record, two indirect probes, a direct control, and a negative probe. All people, organizations, locations, agreements, measurements, and dates are invented. Generic roles identify people without using personal data.

| Domain | Families | Development families | Holdout families | Probes |
| --- | ---: | ---: | ---: | ---: |
| Constraints | 24 | 8 | 16 | 96 |
| Preferences | 24 | 8 | 16 | 96 |
| Commitments | 24 | 8 | 16 | 96 |
| Changing decisions | 24 | 8 | 16 | 96 |
| Causal context | 24 | 8 | 16 | 96 |
| Total | 120 | 40 | 80 | 480 |

Development contains 80 indirect positives, 40 direct controls, and 40 negatives, for 160 probes. Holdout contains 160 indirect positives, 80 direct controls, and 80 negatives, for 320 probes. A family belongs to exactly one split, including every source, probe, and counterfactual associated with it. The split was assigned before retrieval tuning, not by randomly distributing related rows. The files are visible to their authors, so this is not a claim that the holdout is secret or independently administered.

The source corpus has 277 pages: 267 public, five private, and five withdrawn. There are 148 exact evidence spans. Twenty-eight families require two pieces of evidence for their positive probes; 27 use separate pages, while the telescope clock family has two episodes on one page. Five histories contain extended discussions of 579 to 597 words, with the evidence inside the discussion rather than only in the opening sentence. These are limited long-page stress cases, not a long-conversation benchmark.

Every family has an incorrect-person or incorrect-organization distractor. The evidence and distractor deliberately share a slug but have different `source_id` values. One distractor quotes an evidence sentence verbatim to test whether matching text from the wrong source is incorrectly credited. Five distractors also contain quoted hostile instructions. Those strings are untrusted fixture text, not instructions for an agent or scorer.

The 24 changing-decision families distinguish current decisions from earlier proposals, including explicit factual corrections. Five negative probes ask about information available only on a private page. Another five concern withdrawn material, including mislabeled results, wrong-person forms, and proposals that never became approvals. Their gold is empty under the public-read policy. The other negatives ask for facts not supplied by the accessible history. Broad search may still return related pages on a negative; an ordinary search result is not automatically an associative-arm false fire.

## Files and evidence identity

| File | Contents |
| --- | --- |
| `sources.json` | Pre-cutoff source histories and public/private/withdrawn policy labels. Only source payloads belong in construction. |
| `probes.json` | Later requests, probe kinds, tags, and required exact span IDs. Keep these outside construction input. |
| `qrels.json` | Exact quoted source spans used as relevance labels. These are original evidence, not generated associations or answers. |
| `splits.json` | The fixed development or holdout assignment for each family. |
| `counterfactuals.json` | Five separate source-change/same-query diagnostic variants, one per domain. They do not add primary probes. |
| `manifest.json` | Schema version, primary counts, SHA-256 hashes of all five data files, and relevance-review status. |

All text uses `nfc-lf-v1`: convert CRLF or CR line endings to LF, then normalize Unicode to NFC. A span is the half-open interval `[start, end)` in that normalized `source.text`. Offsets are JavaScript UTF-16 code-unit indices, not UTF-8 bytes or Unicode character counts. The telescope history includes a supplementary Unicode symbol before its spans, so treating code points as code units gives the wrong offsets.

Join a span to a source using both `source_id` and `slug`. Neither a matching slug nor matching words on another source are sufficient. Span IDs and family IDs are stable fixture identities; database page and chunk IDs are not fixture identities. Gold spans point only to public pages in their own family. Each positive lists every required span. Every negative has `required_span_ids: []` and is excluded from positive-recall denominators.

All source metadata uses a creation time of `2025-01-01T00:00:00.000Z` and an update time of `2025-01-02T00:00:00.000Z`, before the cutoff of `2026-01-01T00:00:00.000Z`. These fixed times prevent wall-clock recency from changing between arms. History text can recount earlier events or commitments for later dates. A commitment is evidence of the promise, not proof that the promised work was eventually done. Probe wording such as “next” refers to the scenario's later situation, not the machine's current date.

Construction must not receive probes, gold span IDs, split labels, counterfactual gold, or generated association labels. Source identity and visibility remain available for attribution and access control. The fact that no complete probe text appears in a source is a useful mechanical check, not proof that all semantic leakage has been excluded. Independent review must assess that boundary too.

## Counterfactual diagnostics

Each variant names a primary `base_probe_id`, one existing `(source_id, slug)` page, replacement source text, and exact spans within the replacement text. Use the base probe's unchanged text only after building from the substituted source history. The variant inherits the base family's split; it does not create a new independent family or a fifth primary probe.

The five alternatives change kiln clearance, a drink preference, a key-return commitment, a revised picnic location, and the cause of a telescope timestamp error. The clock variant keeps both episodes on the replaced page so no unreplaced page contradicts the changed history. These are alternative worlds, not later corrections to append beside the primary source. Keep their build identities and diagnostic results separate from the primary 480-probe comparison.

## Authorship and review limits

A coding agent manually specified the 120 situations and their source sentences. A temporary local serializer expanded only the file schema, stable identities, and offsets; it did not invent stories by substituting names into a few templates. No corpus generator is part of this fixture directory. The labels are verbatim selections from those specified source sentences, not model-produced association text, model-judged relevance, or measured answers from a retrieval run.

This is agent-authored synthetic material, not a claim of human-authored or human-validated data. An independent reviewer still needs to check that each positive genuinely requires its listed spans, each negative lacks relevant accessible evidence, distractors remain distinguishable, indirect probes are meaningfully different from direct recall, and no family leaks across splits. The five-domain coverage and sample size do not guarantee statistical power or represent real user traffic.

A separate implementation review identified three negative probes that need a relevance decision before capability publication. `causal-context/ink-smear/negative` asks for an ink brand, but its source points to the edition log. `changing-decisions/library-fines/negative` asks for a replacement fee, but its source confirms that replacement charges still apply. `changing-decisions/concert-recording/negative` asks which releases were approved, but the public approval policy may still be a useful association. An unavailable answer does not by itself make every related memory an irrelevant association. The current frozen labels are preserved, not approved; the review must decide whether to change these probes in an identified revision or separately label permissible associations.

Do not tune on holdout results, then present the same exposed holdout as new confirmatory evidence. If relevance review changes a source, span, or probe, update the frozen hashes and identify the new revision before running the reviewed comparison. If the eventual result is inconclusive, use a genuinely new preregistered corpus for confirmation rather than rewriting these stories to improve a score.

## Inspect and validate

From the repository root, the focused suite checks the corpus contract and exact-span scorer without paid provider calls:

```sh
bun test test/eval/cat36-associative-retrieval.test.ts
```

Verify all frozen file hashes independently with Node:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = 'eval/data/associative-recall-v1/';
const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8'));
for (const [name, expected] of Object.entries(manifest.hashes)) {
  const actual = createHash('sha256').update(readFileSync(root + name)).digest('hex');
  assert.equal(actual, expected, name);
}
console.log('All five frozen data hashes match.');
JS
```

These checks establish artifact consistency and harness behavior, not model quality, independent relevance approval, or a passing live benchmark.

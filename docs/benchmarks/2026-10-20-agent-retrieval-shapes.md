# Agent retrieval shapes (E1 to E15), first run (2026-10-20)

## The finding

This category turns 15 retrieval failure shapes that an operator agent reported on a large multi-source production brain (gbrain issues #4612, #7153 to #7157 and #7159 to #7165, plus #6058) into a seeded synthetic world that any gbrain build can be measured against. It is report-only: nothing gates, because gbrain does not claim most of these behaviors. Fixes for the shapes are measured against these numbers with `--gbrain`.

At gbrain `6e1086492` (v0.60.324.0), on the keyword path with no embedding key:

- **Nine shapes reproduce** and are filed as feature gaps ARS-1 to ARS-4, ARS-6, ARS-7 and ARS-13 to ARS-15 in the [wave bug ledger](2026-10-01-wave-bugs.md). The sharpest are twin slugs across federated sources (E1: the same slug fills two of the top 10 rows on 30 of 30 queries), merge-redirect stubs that share the target's title (E2: the stub ranks above the target 10 of 10), a 60,000-character meeting returned as one 59,883-character row (E13), and name variants with empty aliases (E6: 0 of 24 resolve, and 19 of 26 misses suggest an index or digest page).
- **Five shapes hold**: names only daily notes mention (E8), short OCR image pages against a person page (E9), phone, mail and hex identifiers (E10), an undated stub against a dated page (E11) and monotonic score down every list (E12, 306 of 306 lists).
- **One shape is not measured**: E5 needs a frontmatter filter (filed as the feature gap ARS-5), and neither `search` nor `query` declares one at this build. The unfiltered baseline puts the right interview first in 1 of 8.

## Results by family

Each family has its own surface and denominator. "Search" and "query" are both scored on every ranking probe; entity probes use `entity`. Controls are scored and listed separately.

| Family | Shape | gbrain issue | Search | Query | Controls and variants | Ledger |
|---|---|---|---|---|---|---|
| E1 | one slug in two federated sources | #4612 | 0/30 | 0/30 | single-source twins 3/3 each; rank 1 is the target or its twin 30/30 | ARS-1 |
| E2 | merge-redirect stub ("This page has been merged into [[target]]") | #7153 | 5/15 | 5/15 | same-title stub 0/10, renamed stub 5/5; stub above target 10 of 15 | ARS-2 |
| E3 | transcript, summary and diarized copies of one talk | #7154 | 0/6 | 0/6 | the family takes more than 1 of the top 5 on 6/6 | ARS-3 |
| E4 | product query against a densely linked founder page | #7155 | 0/6 | 0/6 | with `types: [company]` 6/6 | ARS-4 |
| E5 | frontmatter as the only discriminator | #7159 | n/a | n/a | not measured: no frontmatter filter parameter; unfiltered baseline 1/8 each | ARS-5 |
| E6 | honorific, surname, diminutive and reversed names (beyond N4) | #7160 | entity 0/24 | | no-referent control 1/1, ambiguous-surname control 0/1 (suggests the people index and a digest); wrong page 0 of 26 | ARS-6 |
| E7 | title-prefixed person stubs ("Mayor Surname-Example") | #7160 | entity 0/4 | | full-name control 4/4; resolves to the stub 4 of 8; doctor flags 0 of 4 pairs | ARS-7 |
| E8 | a name only daily notes mention | #7161 | entity 2/2 | | nowhere-name control 1/1 | none |
| E9 | short OCR image pages against the person a name query names | #7162 | 6/6 | 6/6 | | none |
| E10 | phone, mail and hex identifiers | #7163 | 9/9 | 9/9 | phone, mail and hex 3/3 each | none |
| E11 | "when did X start Y" with an undated stub and a dated page | #6058 | 6/6 | 6/6 | | none |
| E12 | score non-increasing down the list | #7156 | 306/306 lists | | keyword path only; no reranker runs | none |
| E13 | returned row size on a 60,000-character meeting | #7164 | 0/1 | 0/1 | `return_unit: chunk` 1/1 each; largest returned row 59,883 characters against a 6,000 cap; largest stored chunk 2,702 | ARS-13 |
| E14 | `projection_pending` on a query that cannot match an image | #7165 | 0/3 | 0/3 | scoped to `types: [note]` 3/3 each | ARS-14 |
| E15 | paraphrased known-item questions | #7157 | 48/50 | 48/50 | hit@5 and hit@10 1.00, MRR 0.973; search and query return the same top 10 on 50 of 50 | ARS-15 |

E15's pass rate is high; the ledger entry records that `query` is no better than `search` on this path (identical top 10 on every question), which is the shape #7157 reports. Without `--expand` and vectors the two surfaces run the same keyword ranking.

## The experiment

**What ran.** `bun eval/runner/agent-retrieval-shapes.ts --output docs/benchmarks/2026-10-20-agent-retrieval-shapes --record-bugs` against the pinned gbrain `6e1086492dbded0059fcfabc627b846ced7855f4`, with no brain config set. Receipt: [`2026-10-20-agent-retrieval-shapes/receipt.json`](2026-10-20-agent-retrieval-shapes/receipt.json).

**World.** Seed 20261020 writes 621 pages through `put_page` on in-memory PGLite: 536 in the default source and 45 in each of two federated sources added with `sources_add`, plus 5 image pages through `importImageFile`. Every name is invented (`alice-example`, `acme-example`, `source-a` style). The E14 state is reached by clearing the image pages' projection revision in SQL, so a search scoped to images reports `projection_pending`. Presence checks confirm every source count, every gold page readable by exact slug (266 of 266) and the 5 images before any probe runs; a failed presence check voids the run.

**Gold.** An oracle in `eval/generators/agent-retrieval-shapes-gen.ts` derives each probe's answer from the rendered pages, never from gbrain, and throws when a probe is not solvable as designed. The ledger of probes is pinned by a SHA-256 in the tests.

**Denominator.** 199 probes and 361 probe-surface pairs; the 18 E5 filter pairs are not measured at this build, leaving 343 scored. A gbrain exception where an answer is expected is a scored miss.

**Time and cost.** 20.7 s hermetic wall time for the whole run (seeding included), p50 7.5 ms and p95 14.8 ms per call; `bun eval/runner/all.ts --only agent-retrieval-shapes` finishes in 23 s. Cost $0.

**What it does not duplicate.** N4 already scores nickname, typo, initials and handle variants, so E6 adds only honorific, surname, diminutive and reversed names. Source isolation is Cat 22's and phantom redirects are Cat 23's.

## Not measured

- **Vector and hybrid ranking.** The hermetic arm has no embedding key, so every search and query runs on the keyword path. E1 to E4 and E15 may change with vectors on.
- **Score after reranking (E12).** #7156 reports a non-monotonic score after the reranker; the reranker calls a paid provider, so only the keyword path is checked.
- **`query --expand` (E15).** Expansion calls a chat model.
- **E5 frontmatter filters.** Not measured until `search` or `query` takes a `where` filter; the runner detects the parameter and scores the 18 pairs when it exists.
- **E8 mention coverage after extraction.** Mention extraction is never run, on purpose: the shape is a name that only raw notes carry while coverage is pending.

## Follow-ups

- A paid arm through `requirePaidArm` and `startPaidRun` for vector, hybrid, reranked and expanded retrieval, on the same seed.
- Rerun with `--gbrain <build>` as fixes for the ledger entries land; any threshold is set later in a reviewed commit that does not also change the code it measures.

## Reproduce

```bash
bun eval/runner/agent-retrieval-shapes.ts --output /tmp/ars            # whole category
bun eval/runner/agent-retrieval-shapes.ts --families E2,E6 --json      # a subset
bun eval/runner/agent-retrieval-shapes.ts --gbrain ../gbrain-candidate  # another build
bun test test/eval/agent-retrieval-shapes.test.ts
```

## Builds measured

| date | gbrain build | E1 | E2 | E3 | E4 | E9 | E11 | E12 | E13 largest row | E15 hit@1 | receipts |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2026-10-20 | master 9c03ec68 | 0/30 | 5/15 | 0/6 | 0/6 | 6/6 | 6/6 | 306/306 | 59,883 | 48/50 | `2026-10-20-agent-retrieval-shapes/gbrain-7186/master-9c03ec68.receipt.json` |
| 2026-10-20 | gbrain#7186 head 42588edd (collapse stage, rank priors, score order) | **30/30** | **15/15** | 0/6 | **6/6** | 6/6 | 6/6 | 306/306 | 59,883 | 48/50 | `2026-10-20-agent-retrieval-shapes/gbrain-7186/pr-42588edd.receipt.json` |

Counts are search; query matches search on every family. gbrain#7186 bounds a chunk row at 8,000 characters. E13's row is a whole conversation from evidence delivery's implied `auto` unit, and #7186 leaves that unit's bound to a follow-up, so E13 is unchanged. E3's copies share an `origin` key that #7186 does not read yet.

### Entity lookup families (gbrain#7195)

| date | gbrain build | E6 name variants | E6 negatives | E7 prefixed stubs | E8 raw-only names | E10 identifiers | receipts |
|---|---|---:|---:|---:|---:|---:|---|
| 2026-10-21 | master c0b30d71 (v0.60.348.0) | 0/24 | 1/2 | 0/4 | 2/2 | 9/9 | `2026-10-20-agent-retrieval-shapes/gbrain-7195/master-c0b30d71.receipt.json` |
| 2026-10-21 | gbrain#7195 merged as a6204367 (v0.60.349.0; name variants, raw-text mentions, exact identifiers) | **24/24** | **2/2** | 0/4 | 2/2 | 9/9 | `2026-10-20-agent-retrieval-shapes/gbrain-7195/merged-a6204367.receipt.json` |

E6 counts `gbrain entity` resolving the right page; its negatives are the no-referent and ambiguous-surname controls, which must not resolve. The merged build resolves every variant and now leaves the ambiguous surname unresolved. E7 stays 0/4 by design: a stub page that exactly matches the query is still the card, and the real page is listed in `possible_duplicates` instead of substituted; the runner's doctor probe reads the remote `run_doctor` report, which does not carry the new local `person_title_duplicates` check. E8 and E10 already passed on this fixture. Every other family is identical between the two builds (keyword path, no embedding key, 25.8 s, $0).

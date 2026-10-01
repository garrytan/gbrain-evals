# Contradiction surfacing in three stages: discovery, classification, resolution (2026-10-01, N2)

## The finding

gbrain finds two notes that disagree only when a caller already asks about the right company and attribute, and its contradiction judge then calls 70% of real same-time conflicts contradictions.

- **Candidate discovery (hermetic, $0).** With one supplied query per planted item that names the company and the attribute, gbrain's probe offered all 150 of 150 planted same-time conflicts to its judge (both pages were in the top five every time). With 8 queries that name no company, it offered 4 of 150. gbrain has no corpus-wide discovery; that is a feature gap, not a failure. On the amara-life development corpus, supplied fact queries offered 8 of 15 gold pairs.
- **Classification (paid, gbrain's own judge is the system under test).** Of the 150 offered same-time conflicts, the judge called 105 contradictions (70.0%) and 45 temporal changes, including 21 of 50 pairs whose two pages carry the same date. It never called a dated change a contradiction (0 of 60) and recognised all 60 as temporal. It called 109 of 1,977 distinct unplanted pairs contradictions (5.5%), 93 of them values of two different companies with similar names, so judged-pair precision is 48.6% (105 of 216). End-to-end recall, with missed and capped pairs in the denominator, is 105 of 150 (70.0%).
- **Resolution (proposals only).** The probe never changed a page (0 of 825). With a perfect judge, 190 of 210 proposals were acceptable; the 20 failures are every dated change whose dates appear only in the text, because gbrain gives undated pages a date (below). With gbrain's judge, 159 of 210 were acceptable.

Preregistered decision: the judge does **not** separate same-time conflicts from dated changes on this world, because recall on offered conflicts (0.70) is below 0.80. The other two rules held (false-contradiction rate 0.00 on offered dated changes, 0.04 on offered compatible negatives).

The hermetic arm passes its preregistered rules: both safety contracts at 0, candidate recall 1.00 against a 0.50 floor.

## gbrain bugs found

Full entries with repros: [wave bug ledger](2026-10-01-wave-bugs.md).

1. **N2-1: undated pages reach the judge with a date.** `runner.ts:120-121` says an undated page's effective date is null so the judge sees "(date unknown)". The search projection fills undated pages with the recorded-time fallback, so the judge sees the import day instead. 190 of 190 undated planted pages offered were shown with a date. Two consequences follow: the date pre-filter never skipped a pair (0 skips; all 20 dated changes whose dates appear only in their text went to the judge), and none of those 20 got a supersede proposal naming the older page (all "date order unclear"). The classification stage did not get worse for it: undated same-time conflicts were called contradictions slightly more often (36 of 50) than conflicts with both pages dated the same day (29 of 50). Repro: `docs/benchmarks/2026-10-01-n2-contradiction-surfacing/repro/n2-1-undated-page-gets-a-date.ts` (keyless).
2. **N2-2: `gbrain find-contradictions` with no flags returns nothing.** `skills/correction-pipeline/SKILL.md:214` documents the bare command as reading the latest run. The CLI always sets source `default`, and the op returns an empty note to any source-scoped caller, so only `--source __all__` works (0 of 210 stored findings by default, 100 of 210 at the limit with `__all__`). Repro: `repro/n2-2-find-contradictions-default-cli.ts` (keyless).
3. **N2-3: the judge misses its own rules.** The judge prompt says contradiction is for conflicting claims at the same time and that different aspects of one entity are not contradictions. On this world it labelled 45 of 150 same-time conflicts temporal and 109 unplanted pairs contradictions (above). This is model-judged quality with the default utility model (`claude-haiku-4-5`), recorded as a bug against the stated rules; fixing it means prompt or model work and a paid rerun of this arm.

## Documented limits and gaps (not bugs)

- No corpus-wide or fact-identity discovery (N2-4): pairs come only from the top five results of supplied queries.
- `find_contradictions` is suspended for remote callers by documented design (N2-5).
- Resolutions are paste-ready proposals and are never applied; one kind points at a timeline writer that does not exist yet.

## The adjudicated amara-life gold

Before any run, the 10 pairs that `eval/data/gold/contradictions.json` labels contradictions were adjudicated against their source text ([adjudication file](../../eval/data/gold/contradictions-adjudication.json); one adjudicator, an AI agent, not an independent human review). Four stay contradictions (c-001, c-004, c-008, c-009). Three are temporal evolution (c-006, c-007, c-010), one is two holders' targets (c-005), and two are not the same fact (c-002 names two differently named companies, c-003 two different rounds). Two canonical-side reasons are not supported by the text (c-001, c-009). The five stale facts stay supersessions. No row was deleted. This is recorded as category defect N2-6.

gbrain's judge saw 8 of the 15 pairs. It agreed with 5 of 8 original labels and 6 of 8 adjudicated ones: it called c-006 and c-007 temporal (agreeing with the relabel), c-010 a contradiction (agreeing with the original label), and c-009 temporal evolution (disagreeing with both). Three of the four adjudicated contradictions were never offered, so the judge never saw them. This arm is development data.

## The experiment

**World.** `eval/generators/n2-contradiction-gen.ts`, seed 20261001, ledger SHA-256 `19459c108444a19de466b0b416c9a63521c1dfb57c30a80479bc925d6288de31`: 270 items on 825 pages, each item one fact about one fictional company stated on two notes, plus one profile per company and one query per item.

| Kind | Variant | Items | Gold |
|---|---|---|---|
| same-time conflict | both pages dated the same day; both undated; one dated and one undated with that date in its text | 50 each | contradiction |
| dated change | dates in frontmatter; dates only in the text; a falling metric | 20 each | temporal |
| holder opinion, agreement, namesake, negation | | 15 each | compatible |

Every other page states only attributes that are not planted for its company, and every value is unique, so any unplanted pair is compatible by construction. A pair counts as a planted item only when its slugs are the item's pages and each chunk carries its claim span.

**System.** gbrain `3a284ae` (v0.60.26.0) as a copied overlay, PGLite in memory, pages written through `put_page`, then `runContradictionProbe` with gbrain's default `hybridSearch` (keyword only without a key), top five, cache off. Judges are injected: an oracle-recording judge (discovery and the perfect-judge ceiling), a throwing judge on 30 queries (300 pairs, all 300 recorded as errors, no verdict), and in the paid arm gbrain's `judgeContradiction` with `anthropic:claude-haiku-4-5-20251001`. The paid arm saw exactly the same 2,700 offered pairs as the hermetic arm (checked) and ran its queries in 4 concurrent probe runs with the $6 probe budget split evenly; no probe hit its cap. System One was off (no TypeSafe key, fresh `GBRAIN_HOME`).

**Results by variant (paid judge, offered pairs).**

| Variant | Offered | contradiction | temporal | not a contradiction |
|---|---|---|---|---|
| same-time, same-day dates | 50 | 29 | 21 | 0 |
| same-time, both undated | 50 | 36 | 14 | 0 |
| same-time, mixed | 50 | 40 | 10 | 0 |
| dated change, frontmatter | 20 | 0 | 20 | 0 |
| dated change, text only | 20 | 0 | 20 | 0 |
| dated change, falling metric | 20 | 0 | 20 | 0 |
| holder opinion | 15 | 0 | 0 | 15 |
| agreement | 15 | 0 | 0 | 15 |
| namesake | 6 | 0 | 0 | 6 |
| negation | 15 | 2 | 0 | 13 |

Nine namesake items were not offered: their second company's page did not reach the top five of the query naming the first.

**Timing.** The hermetic arm took 76 seconds on a Capy machine (51 s of it writing 825 pages through `put_page`), over the 60-second target for CI.

**Cost.** Paid judge arm $5.74 (2,794 requests, ledger-reconciled). A first, sequential attempt was stopped by a tool time limit after 1,363 requests and $2.76, with no receipt; that spend is in the ledger and counted against this lane.

## Reproduce and inspect

```bash
bun eval/runner/n2-contradiction-surfacing.ts --gbrain <gbrain checkout>@3a284aea26889b77c633aebb4149c3016d834ee6
bun eval/runner/n2-contradiction-surfacing.ts --gbrain <gbrain checkout>@3a284aea26889b77c633aebb4149c3016d834ee6 --paid --budget-run-id <id>
```

Receipts: [hermetic](2026-10-01-n2-contradiction-surfacing/receipt-hermetic-3a284ae.json), [paid](2026-10-01-n2-contradiction-surfacing/receipt-paid-3a284ae.json) (every judged pair, its gold and verdict). Preregistration: [N2 and A4](2026-10-01-n2-a4-preregistration.md). Registry row: `contradiction-surfacing`.

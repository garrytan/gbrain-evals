## Implementation plan
# gbrain-evals follow-up round, October 2026: plan

Status: draft for Garry's approval, revised after the autoplan CEO review (see Review record). Planning only: nothing here has been run or spent. Written 2026-10-06 against gbrain-evals `48dd47b` (v0.10.35, pin gbrain `739e5cc`, v0.60.46.0) and gbrain master `c5fb0201` (v0.60.95.0).

## In plain words (ELI10)

gbrain-evals is the public scoreboard that shows gbrain works. Over the last week a lot of results landed, and each left a short "still to do" list. Some results were measured with older AI models, some lean on labels only an agent has checked, a few tests can't tell good from bad because everything scores 100%, and none of the answer-accuracy numbers has been measured on today's gbrain.

This round does four things, in one pull request:

1. **Bring the scoreboard up to date for free.** Point it at today's gbrain (which now includes the nine P-series features), rerun every free check, close to-dos that are already answered, and add free tests: a privacy gate for proactive recall, privacy checks on the production database and network transport, and a meeting-attendance test on notes written the way gbrain documents.
2. **Answer "is gbrain worth it?" on the main long-history benchmark.** Measure what today's gbrain answers end to end, and compare it with simply pasting the whole chat history into the same AI model, with the cost of each.
3. **Re-measure the old-model results on today's best models** (Opus 5.5, Sonnet 5.5, Fable 5.1, GPT-6.1 Sol): which reader does best on gbrain's search results, the contradiction judge (including the cheapest model that passes), the takes classifier, the brainstorm judge, the embedding-provider table, and "does this test notice when something is broken" checks.
4. **Ask Garry for about 15 minutes, plus an optional 30-minute second sitting,** to check agent-written labels, so two results can say exactly what a person verified.

Spend: about $221 expected, capped at $287, inside the $300 limit. No sealed set is opened. Each paid item says in advance what we do if it wins, loses or ties.

## Models

*Amended 2026-10-07: under Garry's new rule, Claude Opus 5.5 is the top Anthropic model in counted runs and Claude Fable 5.1 is smoke-only. Fable cells that had already run stay as recorded, labeled smoke-only, and count toward no decision; no further Fable cell runs.*

Checked on 2026-10-06 against each provider's model list (`GET /v1/models` on OpenAI and Anthropic) and the price table in `eval/runner/budget-ledger.ts`.

| Family | Newest frontier model | Released | Price per M tokens (in / out) | Role this round |
|---|---|---|---|---|
| Opus | `claude-opus-5-5` | 2026-09-21 | $4 / $20 | every model comparison |
| Sonnet | `claude-sonnet-5-5` | 2026-09-28 | $2 / $10 | every model comparison; default for single-model runs |
| Fable | `claude-fable-5-1` | 2026-08-28 | $10 / $50 | every model comparison |
| GPT | `gpt-6.1-sol` | newest in OpenAI's list | $2 / $10 | every model comparison; cross-family judge |

Rules applied:

- **No `gpt-5.4-mini` anywhere.** No gate or product decision in this round rests on it.
- **`gpt-6-astra` is not added**, for budget: it is the GPT-6 peak tier but not the newest GPT release, and it costs 5 times `gpt-6.1-sol` (about $45 more in the reader replay). Garry can add it (G2).
- **`gpt-6-luna` joins the contradiction-judge comparison only** (W9), as a current-generation cost tier: the judge runs in bulk, so the useful product answer is the cheapest model that passes, not the strongest.
- **Exactly one older model gets new calls as a model under test in the whole round: `gpt-5.4`**, in the reader replay (W10b). Older judges and protocol readers that keep a benchmark comparable are listed separately in G9. It is the reader of our 447/500 frontier-reader arm and of the vendor rows in `docs/comparison-systems.md`; no frontier model was in either earlier run, so no current model can give that link.
- **Older results used as links are not rerun.** The prompt v4 N2 receipt already holds `claude-haiku-4-5`'s verdict on all 2,680 pairs; the 2026-09-30 R1/R2 receipts hold `claude-sonnet-4-6` on the release retrieval (notes 453/500, direct 432/500); the takes-bootstrap Haiku run's per-kind counts are published (its predictions were never committed, so it links by aggregate only).
- **Protocol-fixed older judges and readers are exceptions Garry decides (G9),** not silent: LongMemEval's official judge (`gpt-4o-2024-08-06`), used in every LongMemEval answer arm since September so scores stay comparable, and the held-out starting line's BEAM reader (`gpt-4.1-mini`), whose answer half W13 would rerun for $1.12. The default if Garry declines: keep the `gpt-4o` judge for comparability and add `gpt-6.1-sol` as a second judge on every new arm; run W13 retrieval-only.
- **Product defaults are older models.** gbrain master still defaults to `claude-sonnet-4-6` (chat, reasoning, subagent), `claude-haiku-4-5` (utility, expansion, contradiction judge) and `claude-opus-4-7` (deep) (`src/core/model-config.ts:65-95`, `src/core/ai/gateway.ts:125-126`). Anthropic lists no Haiku newer than 4.5. Single-model runs this round use `claude-sonnet-5-5` and say in their report that the result applies to Sonnet 5.5, not to the Sonnet 4.6 default. Whether gbrain's defaults move is Garry's product decision after the results (G6).

## Step 1: inventory of open follow-ups

Sources: `TODOS.md` (T), the bug ledger `docs/benchmarks/2026-10-01-wave-bugs.json` (L), result docs dated 2026-10-02 to 2026-10-05 (R), the held-out program (P, GBRA-49) and the Cat 40 / Cat 41 pages (C). Costs are API dollars at list price; compute on Ubicloud is not counted. "Garry" means human labeling, a sealed opening or a product decision.

### A. Results measured on an older model generation

| # | Item | Source | What a rerun would prove | Cost | Time | Depends on | Garry |
|---|---|---|---|---|---|---|---|
| A1 | Takes-bootstrap graduation run, Haiku 4.5 (75/123, not graduated) | T, R 10-04 takes verdict, gbrain TODO-E | Now: whether any frontier model avoids the 3 forbidden attributions (label-independent). After gbrain completes its archetype labels: per-kind precision and recall, re-scored free from committed predictions | ~$4 | 2 h | gbrain archetype labels for the full verdict | no |
| A2 | N2 contradiction judge, Haiku 4.5 (prompt v4: 149/150 conflicts, 6/51 compatible pairs called contradictions, above the 10% limit) | T, L N2-3 history, R 10-03 wave 7 | Whether the compatible-pair failure is Haiku-specific, i.e. whether a frontier judge passes N2's preregistered rules | ~$27 (labeled pairs plus a 300-pair unplanted sample) | 4 h | judge prompt still v4 at the pin, else overlay `48ed5e8`'s judge | product decision after (G6) |
| A3 | House reader, Sonnet 4.6 (453/500 on reranked retrieval) | T, R 09-29/30 opaque QA | What answer accuracy users of the default retrieval get with today's best readers | in A5 | | | |
| A4 | Frontier reader `gpt-5.4` on reranker-off sessions (447/500) | T "pair the frontier reader with the release retrieval", R 10-04 | `gpt-5.4` on the release retrieval links our numbers to vendor rows on matched retrieval | in A5 | | | |
| A5 | **Reader matrix:** frontier readers on the release retrieval, plus the `gpt-5.4` link | combines A3, A4 and T "reading notes at 1,024" | Split by the CEO review into W10a (today's gbrain end to end), W10b (reader replay on frozen `a7cb37b` retrieval) and W10c (full-context baseline) | ~$147 for all three | 2 days incl. Anthropic batch support | R1/R2 request bodies (committed); Anthropic Message Batches support | no |
| A6 | Cat 20 brainstorm: generator Sonnet 4.6, judge Haiku 4.5, no rationale stored (1.17/5, fail) | T, R 10-02 May reruns | Whether the ideas are weak or the judge is harsh: stored rationale, four frontier judges, plus a degraded arm as Cat 20's negative control | ~$5 | 3 h | none | no |
| A7 | Negative-control and category runners hard-code Sonnet 4.6 / Haiku 4.5 (Cat 14, 25, 29, 35, A4 house reader) | code: `cat14-calibration.ts:198`, `cat29-think-vs-search.ts:100`, `cat35-transcript-distill.ts:194` | n/a: switched per run through flags, recorded in preregistrations | $0 | in W8 (needs `--model` / `--judge-model` flags added to Cat 14, 29 and 35; Cat 29 and 35 hard-code the models today) | | no |
| A8 | Cat 40 F1/F10 instruction check and Cat 41 confirmation pair use `gpt-5.4-mini`, `gpt-5.4`, `claude-sonnet-4-6` | C Cat 41 protocol (lines 147-148) | The next candidate pass uses the frontier set; protocol amendment written now, before any new cell | $0 now | 30 min | none | no (amendment only) |
| A9 | Sealed v2 decision 1 used reader `claude-sonnet-4-6` and judge `gpt-4o` | R 10-02 sealed v2 | Protocol-fixed for that opening; any new opening is its own decision | n/a | | | sealed opening |
| A10 | Held-out starting line readers `gpt-4o`, `gpt-4o-mini`, `gpt-4.1-mini` | P starting line | They match each benchmark's published convention (a link to outside numbers), so they stay; flagged for transparency | $0 | | | no |
| A11 | auto_chronicle agent-question arm: Sonnet 4.6 agent, 94.4% off vs 100% on, not rerun on the fixed build | T, R 10-04 rerun | Whether events help an agent downstream on the fixed build; needs harder questions first or it measures a ceiling | ~$45 on four frontier models | 1 day | harder questions written and frozen; Garry's question review | yes (question review) |

### B. Human review of agent-written labels

| # | Item | Source | What it proves | Cost | Garry time (full / smallest) | Depends on |
|---|---|---|---|---|---|---|
| B1 | Cat35 judge calibration: 24 coverage pairs with `human_verdict` null (judge verdicts FULL 14, PARTIAL 3, ABSENT 7; 3 rows have an empty note) | T Cat35 | Judge agreement and weighted kappa on coverage; the Cat35 banner then states what a person checked | $0 | the notes the judge saw total 20,834 words, so about 2-3 min per row: **12 rows ≈ 30 min** (the minimum that publishes), all 24 ≈ 60 min | packet; offline kappa script |
| B2 | auto_chronicle: 38 labeled events on 28 pages and 36 questions, written and reviewed by the agent that ran the experiment | T, R 10-04 | The labels the default-on verdict was scored against, checked by a person page by page, including events the labels missed on those pages | $0 | **about 15 min** for 28 page cards (meeting notes are ~290 words); questions not in the ask | packet |
| B3 | N8 associative-recall-v1 labels (480 probes) | R 10-01 N8, T | Lets N8's associative arm gate | $0 | 3+ h / 15 min for a 30-probe sample | **defer**: gbrain has no associative recall (N8-4, 0/240), so the labels gate nothing today |
| B4 | System One S8 grounding labels (all `claude-sonnet-5`) | T System One | Quarantine precision | $0 | 1 h | defer: not on a public claim |
| B5 | Sealed v2 human-reviewed sample (T "second confirmation set") | T | Author-independence of v1 | $0 | 1 h | defer |

### C. Retrieval and reader measurements

| # | Item | Source | What it proves | Cost | Time | Depends on | Garry |
|---|---|---|---|---|---|---|---|
| C1 | Frontier reader on reranked retrieval | T | see A5 | in A5 | | | |
| C2 | Reading notes at 1,024 tokens on the 361-question transfer | T | Already answered: on 2026-09-30, on reranked retrieval with opaque ids, the 1,024-token notes reader beat the direct reader 453 to 432 (+32/−11, p = 0.002) with no cutoffs, and direct answers average 89 tokens so the limit doesn't bind them. Close the item, citing R1/R2; A5 adds notes vs direct at 1,024 on two frontier readers | $0 (saves ~$36) | 15 min | none | confirm (G7) |
| C3 | Embedding-provider matrix rebuild (Cat 18/18b) | T WS5 | Which supported embedder (Voyage `voyage-4`, `voyage-4-large`, OpenAI `text-embedding-3-large`, a local `qwen3-embedding` through Ollama) helps, with and without `rerank-2.5`; adds the 181-question Cat 13 held-out concept set where synthetic-v1 ties | ~$6 | 5 h | Ollama on a Ubicloud VM for the local cell | no |
| C4 | Cat 21 ceiling: all 12 questions name the symbol | T, R 10-02 | Paraphrased questions that don't name the symbol separate `voyage-code-3`, `voyage-code-4` and `text-embedding-3-large` | ~$0.50 | 3 h | none | no |
| C5 | LongMemEval release config on held-out data (B4 audit); LongMemEval-M pilot 4/28 | T | Held-out confirmation of autocut off | sealed | | sealed v2 decision | **defer** (G5) |
| C6 | No current-pin LongMemEval answer number: every reader result uses retrieval from `a7cb37b` or earlier, before the P-series | CEO review | What today's gbrain answers end to end | ~$20 | 4 h | re-pin (W1) | no |
| C7 | No full-context baseline at a matched reader (held-out program page, line 148; GBRA-49 offer) | P, CEO review | Whether gbrain's retrieval beats handing the reader the whole ~115,000-token history, at what cost | ~$38 on a 150-question subset | 4 h | none | no |

### D. Category coverage and gates

| # | Item | Source | What it proves | Cost | Time | Depends on | Garry |
|---|---|---|---|---|---|---|---|
| D1 | Preregistered N8 gate | T, L N8-1/2 fixed | Proactive recall's privacy contracts (0 private deliveries to remote callers or turn context) become a gate; plus an N6 window naming a protected page | $0 | 3 h | own preregistration commit before the run | no |
| D2 | Attendance corpus in a documented form | T, L N9-2..4 fixed, N12-9 | A world-v1 variant with `## Attendees` lists (new corpus version, generated deterministically from the Cat 2 attendance answer key, no model) tests the fixed attendance path end to end: N9's 150 "who attended" runs per split should fire; P7's planner gets attendee-role questions it planned 0% of | ~$1 | 5 h | none | no |
| D3 | Undated N2 conflicts | T (checked) | Already closed: prompt v4 caught 50/50 at `48ed5e8`. Kept as a row in A2's table | $0 | | | no |
| D4 | Wider N6 coverage: Postgres and the network HTTP transport; schema-pack, aggregate, open-loop ops | T | Privacy holds on the production engine and transport, not just PGLite and stdio | $0 | 1 day, time-boxed | Docker Postgres | no |
| D5 | Cat 20 judge rationale | T | see A6 | in A6 | | | |
| D6 | Cat 21 ceiling | T | see C4 | | | | |
| D7 | Live negative controls for Cat 14, 20, 29, 35 and LongMemEval answers | T WS3 | Each category scores a deliberately degraded arm at most half its real arm (rule `NEGATIVE_CONTROL_RATIO = 0.5`, same fixture and seed) | ~$15 | 6 h | A5's Sonnet 5.5 rows serve as LongMemEval's real arm | no |
| D8 | Cat7-1 residual `get_timeline` latency (0.075 ms vs 0.045 ms) | L Cat7-1, R 10-04 | Rechecked at the re-pin under its frozen closure rule; a gbrain fix is gbrain's work | $0 | in E1 | gbrain | no |
| D9 | N2 false contradictions on compatible negatives | T, R 10-03 | see A2 | | | | |
| D10 | Trim the N2 hermetic arm under 60 s | T | needs a faster gbrain write path | | | gbrain | defer |
| D11 | A4 S4-on arm with TypeSafe; revise A4 abstention pattern (A4-4) | T, L | Jev-backed abstention; scorer fix | ~$6 | 4 h | `JEV_TYPESAFE_API_KEY` (present) | no |
| D12 | Lifecycle on the library write path; remaining amendment-8 injections; near-name control; faster CLI arm | T lifecycle | Write-path durability | $0 | 2+ days | | defer |

### E. Housekeeping found during the inventory

| # | Item | Source | Action | Cost |
|---|---|---|---|---|
| E1 | Pin is `739e5cc` (v0.60.46.0); master is v0.60.95.0 with all P-series features | `package.json` | Re-pin, run the offline tier on Ubicloud, rerun the repros and the Cat 7 latency pair | $0 |
| E2 | `TODOS.md` says `cat18b-embedding-rerank-matrix.ts` hard-codes ZeroEntropy cells; it now has OpenAI and `voyage-3-large` cells | code line 107 | Correct the TODO | $0 |
| E3 | Wave 8 check C stops at the consent prompt | T | Run the `--yes` variant at the re-pin, as the TODO says | $0 |
| E4 | Harness session ids where responses are compared (N6-1) | T | Audit during the re-pin | $0 |
| E5 | N7 printed findings ignore `ack_closed` | T | Small runner fix | $0 |
| E6 | `--gbrain` flag in System One docs | T | Doc fix | $0 |

### F. Left open by GBRA-49 (P-series) and Cat 40 / Cat 41

| # | Item | Source | Why it is not in this round |
|---|---|---|---|
| F1 | P1 traps fail on a third phrasing set (89/105): lexicon coverage | P | Needs a gbrain fix, then fresh custodian material |
| F2 | P3 E5: single-value `apply` has no measured benefit; link typing still types advisory companies `works_at` | P | gbrain fix first |
| F3 | P3 E2 implicit citation signal never ran (gated on E1) | P | Gate closed by design |
| F4 | P5 typed relation lines (0/18): GBRA-49 offered a fix plan with retest on fresh questions | P | gbrain work; offer stands |
| F5 | P4 core memory tier off; P8 narrower surface failed | P | Settled verdicts |
| F6 | P6 LongMemEval-M confirmation not runnable (no sealed split) | P | Would need a new sealed split; not worth it while LoCoMo carries P6 |
| F7 | BEAM-1M starting line not rerun on the fixed date loader | P | Moved into the round (W13): retrieval-only rerun, $1.55 per build, no reader model. The answer half ($1.12) uses the protocol's `gpt-4.1-mini` reader and waits on decision G9 |
| F8 | Head-to-head scoreboard against other systems by kind, full-context baseline, file agent at matched cost (GBRA-49 offer) | P | Its own plan; A5 supplies the matched-reader rows it needs |
| F9 | Cat 40 harder tier and Family D (crash/restore) | C | In planning elsewhere; too large for this budget |
| F10 | Cat 40 memory arm for Opus 5.5, Fable 5.1, Astra (~$60); family E ranking; cost-parity wave; `gbrain-verbs` cost floor | T, C | Below the cut |
| F11 | Cat 41 limits: one six-page brain, one model per harness | C | Next Cat 41 pass, not this round |
| F12 | Cat35 repeated-run variation (3 full runs, ~$30); held-out transcripts (~$3); other-family judge | T | Below the cut; the other-family judge comes free with B1's kappa if Garry wants |

## Step 2: the plan

### Priority order and cut line

Ranked by how much the public proof gains per dollar: free work that makes current claims true and private data safe first, then the question a skeptical engineer asks first ("does gbrain beat just pasting everything in?"), then the older-model reruns. Caps are hard `--budget-usd` limits in one ledger, `.budget/followups-2026-10.sqlite`, created with `init --program-cap-usd 287` (raised with `set-cap` only if Garry funds an item below the cut).

| Rank | Workstream | Proves | Evidence class | Estimate | Cap | Agent time | Garry |
|---|---|---|---|---|---|---|---|
| 1 | **W1 Re-pin and truth pass** (E1-E6, D8, A8, C2, D3) | Every current-state number names today's gbrain; stale to-dos close; Cat 40/41 model lists amended before their next cells; a model-freshness check | regression | $0.05 | $1 | 6 h | no |
| 2 | **W2 N8 privacy gate** (D1) | Proactive recall delivers no private page to remote callers or turn context in the tested cases, as a CI gate | regression gate | $0 | $0 | 3 h | no |
| 3 | **W12 N6 on Postgres and HTTP** (D4) | The visibility fuzz holds on the production engine and network transport for a coverage list frozen in advance | regression gate | $0 | $0 | 1 day | no |
| 4 | **W13 BEAM-1M retrieval on the fixed date loader** (F7) | Corrects a published starting-line number; shows whether the P-series moved retrieval where it is weakest (18% strict recall) | development | $3 | $5 | 2 h | no |
| 5 | **W3 Attendance world** (D2) | The documented attendee format is parsed and used end to end; P7 planner coverage of attendee questions | development | $1 | $3 | 6 h | no |
| 6 | **W10a LongMemEval end to end at the new pin** (C6) | What today's gbrain answers, release configuration, `claude-sonnet-5-5` reader (plus `gpt-6.1-sol` on W10c's 150 questions) | development (LongMemEval-S was used in tuning) | $24 | $28 | 4 h | no |
| 7 | **W10c Full-context baseline** (C7) | gbrain retrieval against the whole history in the prompt, same reader, with tokens and dollars per question | development | $40 | $50 | 4 h | no (taste decision T1) |
| 8 | **W4 Takes-bootstrap on frontier models** (A1) | Forbidden attributions per model now; graduation verdict after gbrain's labels land, re-scored free | development | $4 | $6 | 2 h | no |
| 9 | **W5 Cat 21 paraphrases** (C4) | Code search on questions that don't name the symbol; ends a 12/12 tie | development | $0.50 | $2 | 3 h | no |
| 10 | **W6 Embedding matrix** (C3) | A current provider table on supported embedders, with and without reranking, with cost and whether data leaves the machine | development | $6 | $10 | 5 h | no |
| 11 | **W7 Cat 20 judges and rationale** (A6) | Four frontier judges score every generated idea with stored reasons; how much they agree | development | $8 | $12 | 3 h | no |
| 12 | **W8 Live negative controls** (D7) | Cat 14, 20, 29, 35 and LongMemEval answers each notice a broken configuration, plus a realistic partial fault for three of them (report-only) | harness validity | $18 | $25 | 7 h | no |
| 13 | **W9 N2 judges, frontier and cost tier** (A2) | Which models pass N2's rules, false alerts per 1,000 candidate pairs, and the cheapest that passes | development | $30 | $38 | 5 h | after: G6 |
| 14 | **W10b Reader replay on frozen retrieval** (A3-A5) | Reader effect on the fixed 2026-09-29 release retrieval (gbrain `a7cb37b`), paired with Sonnet 4.6 and linked to vendor rows through `gpt-5.4` | development | $87 | $107 | 1.5 days | after: G6 |
| 15 | **W11 Garry's review packet** (B1, B2) | Cat35 judge agreement and kappa against blind human labels; the 38 chronicle labels checked by a person | label validity | $0 | $0 | 5 h prep | **15 min + optional 30 min** |
| | **Above the cut** | | | **~$221** | **$287** | ~9 agent days | 15-45 min |
| — | *cut line* | | | | | | |
| 16 | D11 A4 S4-on arm and A4-4 rule revision | Jev-backed abstention | development | $6 | $8 | 4 h | no |
| 17 | W13 answer half (BEAM-1M, protocol reader `gpt-4.1-mini`) | Starting-line answer accuracy with dated sessions | correction | $1.20 | $2 | 1 h | G9 |
| 18 | A11 auto_chronicle agent arm, harder questions, four frontier models | Downstream benefit of events on the fixed build | development | $45 | $55 | 1 day | question review |
| 19 | F12 Cat35 repeated runs | Run-to-run variation of the Cat35 headline | development | $30 | $35 | 1 day | no |

The round's limit is $300. Above the cut uses $287 of caps; ranks 16 and 17 fit beside it ($297). Caps are worst-case reservations; expected spend is about $221. Rank 18 fits only if Garry declines W10c (T1) or the round finishes well under its caps; the ledger refuses anything past the program cap.

### What each paid result changes

Every paid workstream's preregistration copies its row from this table, so a tie or a loss has a planned consequence too.

| Workstream | If it wins | If it loses | If inconclusive or at the ceiling |
|---|---|---|---|
| W10a | README's LongMemEval answer row moves to the new pin | README reports the drop next to the old pin's number, as a combined build and configuration difference; a gbrain issue asks for a bisect | Report "no change shown" at the measured power |
| W10c | gbrain non-inferior or better: README "how gbrain compares" gains a matched-reader row with cost per question | Full context better beyond the margin: publish it, and say where gbrain still earns its place (cost, privacy, histories too long to paste) | Insufficient precision: report accuracy with intervals plus the cost difference; no README claim of equivalence |
| W4 | gbrain can graduate the tier after its labels land; mirror the verdict | Classifier work stays on gbrain's TODO-E with model-independent evidence | Wait for the labels; re-score free |
| W6 | `docs/settings.md` recommends the winning embedder per workload | Keep the current recommendation with fresh evidence | No recommendation change; cells reported as not distinguished at this sample size |
| W3 | Attendance documented as working end to end for the documented format, with the planner coverage numbers | A gbrain issue with the failing pages; N9 unchanged | Report the firing rate; no claim |
| W5 | Cat 21 adopts the paraphrase questions as its main split; the `reindex --code` recommendation gets evidence | The tie is reported as real on paraphrases too | Report "not distinguished" |
| W7 | The median of the four judges' means is at or above 2.5: Cat 20 passes and its failure note closes | Cat 20 stays failing, now with reasons; a gbrain issue if judges agree the ideas are weak | Judges disagree: report the spread; Cat 20 stays report-only |
| W8 | The category keeps its gate status | The category is marked unable to detect breakage and drops to report-only until fixed | n/a: the 0.5 rule is binary |
| W9 | A model passes when the exact 95% upper bound of its compatible-pair false-contradiction rate is under 10%: G6 may propose the cheapest such model for an independent production-path check before any default change | Keep Haiku; the 10% rule stays failing; file the false-alert pairs with gbrain | Report false alerts per 1,000 pairs; no default change |
| W10b | A hypothesis for G6 (benchmark reader, not production `think`); a default change needs its own production-path evaluation | Same, other direction | Report "no reader difference shown" at the measured power |
| W13 | Starting-line row corrected; P-series retrieval effect on BEAM-1M published | Same | Same |
| W11 Cat35 | Kappa's lower bound ≥ 0.4: the banner becomes the calibrated statement (coverage only; grounding and usability stay unchecked) | Upper bound < 0.4: the 88.1% leaves README's current results until the judge is fixed | Otherwise (imprecise or moderate): the headline stays, with the agreement and its interval in its first paragraph; fewer than 12 eligible ratings: nothing published, banner stays pending |
| W11 chronicle | Labels confirmed: the default-on verdict stands with a human-checked label set | Rescored recall below 34/38 or wrong events above 0.20 per page: the report says default-on is no longer supported and a gbrain issue is filed | Corrections that leave every rule passing: published by id, verdict unchanged |

### Rules that hold for every workstream

- **Preregister before measuring.** Each paid or gating workstream gets `docs/benchmarks/2026-10-XX-<name>-preregistration.md`, committed and pushed to the PR branch before its first cell runs. It names the question, arms, exact model ids and settings, metric and denominator, decision rule, budget cap, evidence class, the minimum detectable effect at its sample size, and its row from the table above. A change after a cell runs is a dated amendment, never an edit. The comparison family file for `eval/runner/compare.ts --family` is committed with it (TODOS "preregister comparison families").
- **No sealed set.** Sealed v1 and v2 stay closed (v2 has 2 of 3 openings left, in owner custody on Garry's Mac). No workstream touches custodian material.
- **Name the evidence class.** Every report says whether it is a regression check, development evidence (data used in earlier tuning or written around known failures) or label validation. Nothing in this round is a held-out confirmation.
- **Say which build and model a number describes.** Frozen-retrieval replays say "retrieval from gbrain `a7cb37b`" in the table header, not just in a footnote. Results measured with Sonnet 5.5 say they apply to Sonnet 5.5.
- **Report the models people use first** (Sonnet and GPT before Fable) and name every ceiling as a ceiling.
- **One status vocabulary in every table:** Complete, Partial, Failed, Not run, Not covered, Awaiting human review, each with completed/planned counts and a reason. A dash or a zero never stands for a missing measurement.
- **Scope each LongMemEval table.** Separate sections for the current-pin result (with "benchmark notes reader; not production `think`" next to its configuration), the full-context comparison (150-question pairs only), and the historical reader replay (header "retrieval from gbrain `a7cb37b`"). Fable's 200-question subset is labeled where it appears. Both judges' results are shown with fixed labels.
- **Docs describe the current state.** README, `docs/README.md` and hub pages change their current-state text in place and gain a `## Changelog` entry in the same commit. No "Update" blocks.
- **No competitor names in README.** Vendor comparisons stay in `docs/comparison-systems.md` and dated reports, described by kind in README.
- **Errors are results.** A failed or partial cell is published as such. Nothing is regenerated to get a better score. Each report records wall time, refusals and retries per arm.
- **Every report ends with "Reproduce and inspect"** (CLAUDE.md): first a keyless $0 re-score from committed rows with its exact command and expected output, then the live commands, keys, cost and time. README's results section links one keyless re-score command as its "reproduce a result" entry point.
- **Preregistration template and order check.** `docs/benchmarks/PREREGISTRATION-TEMPLATE.md` holds the required fields; `scripts/prereg-order-check.ts` (run in CI) fails when a receipt's commit predates its preregistration's.
- **One ledger, every paid path.** Every paid request starts on the primary Capy machine, which holds `.budget/followups-2026-10.sqlite`. Runners that call providers through gbrain-evals' paid-request guard reserve and settle per request. Runners with their own budget (W4's harness, `eval:decide` in W13) first open a ledger budget run that reserves their whole cap as one reservation, then settle it to their reported spend. The batch lane reserves per batch (W10). Ubicloud VMs and other free jobs run with no provider keys in their environment. W6's Ollama runs on a Ubicloud VM reached from the primary through an SSH tunnel (no public port), so its paid reranker calls still start on the primary. After each workstream, `budget-ledger.ts status --json` is committed, and `init` refuses when a committed snapshot shows spend the local file lacks.
- **Execution-start attestation.** Before its first paid or gating request, each runner records in its receipt the preregistration's path and pushed commit (checked against `origin`), the runner SHA, a clean worktree, fixture hashes and the family-file hash, and refuses if the preregistration isn't on `origin`. `scripts/prereg-order-check.ts` then confirms in CI (with `fetch-depth: 0`) that each receipt names a preregistration committed before it; edits after a receipt are appended amendments.
- **Statistics, fixed in each preregistration:** the primary comparison and one primary judge (LongMemEval: the official `gpt-4o` judge; `gpt-6.1-sol` secondary and report-only, with agreement shown); Holm correction across all arms of a workstream, not just within one A/B pair; the minimum detectable effect at the assumed discordance; the analysis unit and cluster for intervals (file for W5, transcript for Cat35, generation context for W7, page for chronicle); and a non-inferiority margin before any "does as well" wording, else "insufficient precision to distinguish these arms".
- **Row-level contracts.** Each arm freezes a manifest of expected question ids and request ids; results join by id, never by order; generation and judging outcomes are recorded separately; missing or malformed outputs count as preregistered (wrong for a reader, error for a judge), never dropped. Each arm states its own denominator (500, 200 or 150).
- **Isolation.** Each lane runs in its own git worktree with per-run brain and database directories; caches are keyed by corpus, build, embedding configuration and retrieval settings.
- **Output limits and reasoning effort are preregistered per model,** and every report gives the count of `max_tokens` finishes per arm.

### Workstream details

**W1 Re-pin and truth pass ($0).**
1. Re-pin `gbrain` to one master SHA (≥ `c5fb0201`, v0.60.95.0), frozen in W1's preregistration for the whole round; a later re-pin is an amendment that reruns the affected free checks. Keep the `gbrain-cues` and `gbrain-reader` aliases unchanged.
2. Preregister the regression check in the style of `2026-10-04-operator-wave-repin-preregistration.md`: offline tier on Ubicloud (`UBI_OWNER=<thread code>`, watched background operation), all repros, the Cat 7 latency pair on fresh VMs, wave 8 check C with `--yes` (E3), and Cat7-1's frozen closure rule.
3. Small fixes: N7 printed findings check `ack_closed` (E5), session-id audit (E4), System One doc flag (E6), cat18b TODO correction (E2).
4. Close in `TODOS.md` with evidence: D3 (undated N2, closed by wave 7) and C2 (the 1,024-token rerun: on 2026-09-30, on 500 questions with reranked retrieval, the notes reader at 1,024 tokens beat direct 453 to 432, p = 0.002, with no cutoffs; a free recount of the same rows restricted to the 361 transfer questions is added to the note, since the TODO named that population). C2's closing note also records that gbrain's product answerer no longer reads notes-first (`9d60b218`, P6 development result) while `gbrain eval longmemeval` still defaults to notes at 1,024 tokens, so the result describes gbrain's benchmark reader, not `think`.
5. Amend the Cat 41 protocol and the Cat 40 F1/F10 check so the next candidate pass uses `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1` and `gpt-6.1-sol`, with the old three-model baseline kept as history (A8). This is a protocol change before any new cell, which the model rules allow.
6. Add `scripts/model-freshness.ts` (with fixture tests for snapshot ids, aliases and tiers; run by hand, not in CI, since it needs keys): reads each provider's model list (free endpoints), compares it with the model sets named in the registry and the preregistrations and with both price tables (gbrain-evals' ledger and gbrain's pin), and prints new releases and missing prices, each with the command that fixes it. Exit 0 when current, 1 when a called model is unpriced (blocks the run), 2 when a provider list can't be read; a newer model of a named family is a warning, never a reason to change a frozen arm. Run it in W1 and before every paid run. A weekly scheduled re-pin job is proposed separately (T2), not built here.
7. README current state names the new pin; each number keeps its own gbrain commit, and the README's repository-version row is corrected (it says v0.10.24; `VERSION` is 0.10.35).
8. Register prices for every model the round calls that gbrain's pin can't price. gbrain master's price table stops at `gpt-5.6`, so `gpt-6.1-sol` and `gpt-6-luna` are unpriced there, and W4's harness exits 2 on an unpriced model (`evals/takes-bootstrap/harness.mjs:86-91`). `gbrain pricing set` can't fix W4, because the harness checks gbrain's built-in table (`canonicalLookup`) on a fresh in-memory brain. So W4 runs a documented overlay of the harness that takes `--price-input` / `--price-output` and loads them into its `BudgetTracker` (recorded like N2's `gbrain_overlay`), and W9's judge replay registers the same rates in its eval gateway. Rates come from `eval/runner/budget-ledger.ts`. Check that gbrain's OpenAI route accepts both ids with a one-token call per model (about $0.01, W1's $1 cap), record both in the preregistrations, and file a gbrain issue asking for GPT-6 prices in its table.

**W2 N8 privacy gate ($0).** Preregister in its own commit: the gate is 0 private pages delivered to remote callers and 0 in the turn-context block, on the existing N8 fixture at the new pin, with a signal floor (the alias and exact-title arm must still deliver, so a gate that passes by delivering nothing fails). Add an N6 window whose turn names a protected page (TODO). The associative arm stays report-only (B3 deferred). The report says "no private delivery in these cases", not a general guarantee.

**W12 N6 on Postgres and HTTP ($0, one day).** Freeze the coverage matrix in the preregistration before running. Mandatory cells: Postgres over the real HTTP transport (the combined production path) on the existing 30 covered read ops, for each principal (no credentials, invalid or expired token, source-scoped remote token, owner), with warm caches and pooled connections, checking returned pages, counts, aggregates, excerpts and error text for canaries. Optional cells: the schema-pack, aggregate and open-loop ops as named, seeded surfaces. Gate: 0 leaks per cell; a missing mandatory cell fails the gate; a leak blocks publishing current-pin privacy claims until fixed. The HTTP server and Postgres bind to localhost. Anything on the frozen list not finished in the day is published as "not covered", by name; nothing is dropped silently.

**W13 BEAM-1M retrieval on the fixed date loader ($3).** Run `bun run eval:decide init`, then `fetch --benchmark beam-1m`, then `dev --only beam-1m` in retrieval-only mode (exact flags copied from the starting line's `run-config.json` into the preregistration), with the loader fix from gbrain-evals v0.10.32, once at the starting line's build `6622a119e` (the correction) and once at the new pin (P-series effect). $1.55 per build at the starting line's recorded cost. The answer half needs the protocol's `gpt-4.1-mini` reader and waits on G9.

**W3 Attendance world (~$1).** `eval/generators/world-v1-attendees.ts` writes a new corpus version `world-v1-attendees` by adding a `## Attendees` list to each meeting page from the Cat 2 answer key, deterministic, no model, world-v1 untouched. A perturbed split changes 15% of lists (one person added or removed against the key, seeded), and is scored against the list on the page, so the test shows gbrain uses the page and not the key. Preregister the claim narrowly: "the documented attendee format is parsed and used end to end", with N9 hermetic "who attended" firing on at least 80% of runs per split, 0 false attendance against the page's list, and the original world-v1 result reported beside it. The report says who writes these lists today (the user or an import adapter) and that prose-only attendance stays unsupported (N12-9). P7 planner coverage is measured on attendee-role questions from the development phrasing of `eval/generators/constrained-relational-gen.ts` rendered against `world-v1-attendees`, never the custodian's sealed phrasing (share planned, with the planner's `explain` output as instrumentation).

**W10 LongMemEval answers (three parts, one preregistration).** Infrastructure W10 builds and tests first (1.5 days, counted in the time plan), as separate modules under `eval/runner/batch/`:
1. *Arm manifests* (immutable): question ids, request ids, request-body hashes, model, output limit, reasoning effort, protocol identity.
2. *Sources*: W10b replays R1/R2 request bodies byte for byte. W10a captures the real reader request bodies by running `gbrain eval longmemeval` at the pin with a stub fetch that records each reader request and returns a placeholder (the method R1's driver used; real retrieval spend, $0 for the reader), because `--retrieval-only` emits chunk text, not the reader prompt (`src/eval/longmemeval/reader.ts:95`). W10c builds full-history prompts. The `gpt-5.4` official prompt has its own hashed protocol identity.
3. *Transport*: OpenAI Batch and Anthropic Message Batches, with usage normalization.
4. *Ledger-backed execution*: the ledger's request guard throws on batch control calls because they name no model (`budget-ledger.ts:1077`), so the lane reserves and settles through `BudgetRun.reserve/settle` directly; the guard gets an allow-list for free batch paths (poll, list, results, file content) and refuses any batch submission that didn't come through the lane. A batch reserves its worst case sized from real token counts (Anthropic's free `count_tokens`; a tokenizer for OpenAI) and the preregistered output limit, at list price until the pilot confirms the batch discount, then at the confirmed factor. Settlement is provider usage times the confirmed factor.
5. *Exactly-once submission*: an intent record (request-set hash) is written before submit and attached to the batch (OpenAI `metadata`, Anthropic `custom_id` prefix); on restart the lane lists provider batches and matches intents before submitting anything. A batch whose outcome is unknown is never resubmitted automatically, and its reservation is never released on a timeout; expired, cancelled and partly failed batches resubmit only the failed request ids, after reconciliation.
6. *Receipts and offline scoring*: rows joined by id.

Tests before any paid batch: over-cap refusal; crash before submit, after acceptance before the id is saved, and during settlement; partial expiry; duplicate, missing and out-of-order results; malformed usage; no resubmission of completed rows (see the eng phase's test plan, `~/.gstack/projects/garrytan-gbrain-evals/eng-test-plan-evals-followups.md`). Arms run one at a time, so only one arm's worst case is open. Common to all parts: 500 questions, all in the denominator; LongMemEval's official judge as the primary judge and `gpt-6.1-sol` as a secondary judge (G9); a `max_tokens` finish counts wrong; `gpt-6.1-sol` and `gpt-5.4` readers run at medium reasoning with a 12,000-token completion limit (the 2026-10-04 `gpt-5.4` arm's settings; its longest answer used 3,543), Anthropic readers at the replayed body's limit; the excerpt-limit setting R1 raised is named with its value from R1's driver; batch APIs where the request shape allows, with the 10-question pilot billed through the batch endpoint to confirm batch pricing before any full submission; arms run in the preregistered order below, and an arm starts only if its full estimated cost at confirmed pricing fits under the remaining cap.

- **W10a, today's gbrain end to end (~$24).** `gbrain eval longmemeval` at the new pin, release configuration (balanced, `voyage:rerank-2.5`, autocut off, top 5, production excerpt limits, opaque ids), house notes reader at 1,024 tokens with `claude-sonnet-5-5`. Retrieval runs once through the stub-fetch capture (embeddings about $7.60 and rerank about $2.40 if the uncommitted cache is cold; check it first), then the captured reader bodies go through the batch lane. Paired with W10b's Sonnet 5.5 arm, it measures the combined difference of build (P-series) and configuration (production excerpt limits vs R1's raised limits); the report does not attribute it to the P-series alone.
- **W10c, full-context baseline (~$40).** A seeded 150-question subset stratified by question type. The same reader prompt shape, with the whole ~115,000-token history in place of gbrain's retrieved sessions, read by `claude-sonnet-5-5` and `gpt-6.1-sol`, with a 2,048-token output limit for the Sonnet notes reader, since a long history can produce long notes (cut-off rates are reported for all three arms). The primary test is non-inferiority of full context against gbrain at a preregistered 7-point margin, reachable at about 150 pairs and 12-15% discordance (`gates.ts` `noninferiority`); a difference smaller than the test can resolve is reported as "insufficient precision", never as a tie. The type-weighted estimate is reported beside the stratified one. Compared on the same 150 questions with current-pin gbrain only: W10a's Sonnet 5.5 rows, and a `gpt-6.1-sol` reader on W10a's current-pin prompts for those 150 questions (about $3, added to W10a). Measures: accuracy; recurring cost per question (reader input and output at batch prices, retrieval queries) shown separately from one-time cost (ingestion and embedding the history); judging excluded from both; latency as provider request time, not batch turnaround. The report shows these 150-question pairs in their own table, never beside the 500-question numbers as if equivalent. This is an architecture comparison at a fixed reader, not a model comparison, so it uses the two cheapest frontier families. Opus and Fable are not needed to answer it.
- **W10b, reader replay on frozen retrieval (~$87).** `reranker-on/r1/calls.ndjson.gz` and `r2/` in `2026-09-29-longmemeval-opaque-qa/` hold the exact system and user text of all 500 R1 notes calls (mean 15,451 input tokens) and all 500 R2 direct calls, captured at gbrain `a7cb37b` with the excerpt limit raised above production's. The arms replay those bodies with only the model and the output limit changed, so every arm is paired question by question with Sonnet 4.6. Order and estimates at batch prices: `claude-sonnet-5-5` notes ($8.50) and direct ($8, output limit 512 → 1,024); `gpt-6.1-sol` notes ($10.50); `gpt-5.4` at medium reasoning with LongMemEval's official notes-first prompt built from R1's retrieved sessions ($11, the vendor-matched link); `claude-opus-5-5` notes ($17); `claude-fable-5-1` notes on a seeded 200-question subset ($17); judges ($12); pilots ($3). Every table header reads "retrieval from gbrain `a7cb37b` (2026-09-29)".

**W4 Takes-bootstrap (~$4).** Run `evals/takes-bootstrap/harness.mjs` from a gbrain checkout at the pin with `--model` set to each of the four frontier models through the pricing overlay (W1 step 8) and `--max-usd` sized per model from the harness's own estimate (Fable needs at least $2.50). Commit every predictions JSONL under `docs/benchmarks/2026-10-XX-takes-bootstrap-frontier/`. The preregistered verdict now covers only what incomplete labels can't distort: forbidden attributions (Haiku had 3) and malformed cases. Per-kind precision and recall are published as provisional, and `--replay` re-scores the same predictions at $0 when gbrain completes its archetype labels; that re-score, not this run, is the graduation verdict. Haiku is not rerun; it links by its published counts.

**W5 Cat 21 paraphrases (~$0.50).** Write 24 questions that describe a function's behavior without naming it (two per gold file), freeze them in `eval/data/cat21-paraphrase-v1/` before any run, and run `cat21-code-retrieval.ts` with `voyage-code-3`, `voyage-code-4` and `text-embedding-3-large`. Keep the 12 named questions as a regression split. Preregister MRR and recall@5 per embedder with a paired comparison, and state that the questions were written by an agent around known gold files (development evidence).

**W6 Embedding matrix (~$6).** Update `CELLS` in `cat18b-embedding-rerank-matrix.ts` to `voyage-4`, `voyage-4-large`, `text-embedding-3-large` (1,536 dims) and a pinned local embedder on a Ubicloud VM (`ollama:qwen3-embedding:8b` under a time box, or a 1,024-dimension local model if 4,096 dimensions exceed the vector index's limit; the model digest is recorded), each with and without `voyage:rerank-2.5`. Run on synthetic-v1 (Cat 18/18b) and on the Cat 13 held-out concept split (181 questions), where synthetic-v1 has tied before. Each row reports cost per 1,000 queries, latency, and whether data leaves the machine (the local embedder with the hosted reranker is labeled "local embedding, hosted reranking", not "local"). A cell whose reranker didn't run on every query is invalid, as the runner already enforces, and each cell builds its index from scratch in its own directory.

**W7 Cat 20 (~$8).** Change the runner to store each idea's text and each judge's rationale. Generate with `claude-sonnet-5-5`, then have all four frontier judges score every generated idea (216, passing and rejected), blind to the internal judge's pass/fail. Preregister the deciding rule (Cat 20 passes when the median of the four judges' means on passing ideas is at least 2.5), pairwise Spearman agreement, absolute score differences and how many judges cross the floor, the passing-vs-rejected gap per judge, intervals clustered by question, and "inconclusive" when fewer than 10 ideas pass. The 2026-10-02 Sonnet 4.6 run stored no idea text, so its 1.17 links by aggregate only, and the report says the historical cause can't be recovered. Degraded arm for W8: brainstorm over a shuffled corpus where close and far pages are random.

**W8 Live negative controls (~$18).** First add `--model` and `--judge-model` flags (defaults unchanged) to `cat14-calibration.ts`, `cat29-think-vs-search.ts` and `cat35-transcript-distill.ts`, which hard-code or read models from environment variables today. One preregistration, two kinds of arm, both with `claude-sonnet-5-5` as the category model and `gpt-6.1-sol` as judge where the category has a judge:
- *Sanity controls*, rule as in `2026-10-02-live-negative-controls.md` (degraded at most 0.5 × real, same fixture and seed): Cat 14 real profile vs no profile; Cat 20 from W7; Cat 29 think over the brain vs hash embeddings; Cat 35 a preregistered 8-transcript subset, real distiller vs an unrelated transcript; LongMemEval answers, 100 seeded questions, own retrieved sessions (W10b's Sonnet 5.5 rows, free) vs another question's.
- *Partial faults* for three categories, report-only with the measured drop and no ratio rule: Cat 14 with 30% of profile facts swapped; Cat 35 with each transcript cut in half; LongMemEval with the top-ranked gold session removed (only where a gold session was retrieved; the rest listed as not applicable). Each states the error it should detect.
- Every control needs a real-arm signal floor (a real score of zero makes the ratio rule inconclusive, not a pass); the other-question swap excludes sessions that contain the target answer; injections are verified independently of the score. The LongMemEval control waits for W10b's first arm (Sonnet 5.5 notes) and uses the same judge.

**W9 N2 judges (~$30).** A judge-only replay of the 2026-10-03 prompt v4 receipt with `claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-opus-5-5`, `claude-fable-5-1` and `gpt-6-luna` through gbrain's `judgeContradiction` (prompt v4 is still the version on master). The receipt holds slugs and verdicts but not the judge's input text, so the inputs are regenerated with the N2 generator at seed 20261001 and the probe rerun hermetically at `48ed5e8` with the recording judge; the replay starts only if all 2,680 (query, page, page) triples and the ledger SHA match the receipt. Pairs: the 241 same-item planted pairs offered (150 conflicts, 40 dated changes, and 51 compatible negatives, which include the 6 namesakes) plus a seeded sample of 300 of the other 2,439 judgments (unplanted and cross-item pairs), weighted back to that population for false alerts. A fresh seeded split of 200 compatible negatives from the generator (about $10 across models) narrows the decisive bound. Haiku's verdicts come from the receipt. gbrain's judge allows 1,024 output tokens; a truncated judgment counts as a judge error, preregistered. Preregister per model: N2's existing rules, paired McNemar against Haiku, cost per 1,000 judged pairs, and false alerts per 1,000 candidate pairs at the run's observed prevalence (2,680 offered, 150 planted conflicts). The union of all models' alerts on unplanted pairs, Haiku's included, is adjudicated against the generator's ledger blind to which model raised them; ambiguous pairs are reported as bounds. Every pass/fail prints its exact Clopper-Pearson bound (on the original split, 5/51 has a 21% upper bound; only 0/51 is confidently under 10%). The decision question for G6 is "the cheapest model that passes all of N2's rules"; the report also says that passing the 10% bar is not the same as being ready to act on verdicts without review. It is a component replay, not a full N2 rerun.

**W11 Garry's review packet ($0; two sittings Garry can take separately: about 15 min, then about 30 min).**

*The ask, smallest first.* Sitting 1 is the chronicle section alone, about 15 minutes, and completes B2 by itself. Sitting 2 is Cat35, rows in a fixed random order, with a 30-minute timebox: 12 rows is the minimum that publishes; more rows narrow the interval. Neither sitting depends on the other.

*Format.* One self-contained HTML file generated by `scripts/w11-packet.ts` (no network calls, external fonts or scripts; a Content-Security-Policy meta tag blocks connections; every fixture or model string is rendered as escaped text, tested with hostile strings such as `</script>`; imports are validated against a bounded schema), committed to the PR branch and attached to the approval message so Garry opens it locally on his Mac. An opening screen says what he is checking, what this does not validate, that partial work is fine, and how answers come back. Answers autosave to `localStorage`; a progress line reads "Chronicle 9/28 pages · Cat35 0/24". **Submit section** shows a summary (answered, skipped, can't tell, corrections) before locking that section; agreement with the judge is never shown in the packet, only in the published report after offline scoring; **Export** downloads `w11-labels-<date>.json` and copies it to the clipboard, so he can paste it into the thread. The file records reviewer, timestamp, packet SHA-256, the SHA-256 of each label file as shown and the row-order seed. Single column, line length about 75 characters, note and evidence side by side above 900 px and stacked below, keyboard shortcuts (1/2/3 verdict, N can't tell, J/K next/previous), visible focus, every control reachable without a mouse; checked once in Safari on macOS.

| State | Behavior |
|---|---|
| Loading | controls disabled until a row's evidence is rendered |
| Invalid packet (row ids or counts don't match the embedded manifest) | an error naming the mismatch; no review starts |
| Empty note (3 Cat35 rows) | "This lane wrote no note for this transcript", verdict still asked |
| Answer selected | shown selected; "saved on this computer" only after `localStorage` succeeds |
| Partial | reopens at the first unanswered row; partial export allowed |
| Save or export fails | answers kept; the error says what failed; retry and a plain-text copy offered |
| Draft export | a recoverable snapshot of everything so far; nothing locks |
| Section submitted | that section's answers lock (later changes are dated amendments with the original kept); the other section stays open |
| Received | "exported, not yet received" until the thread's reply confirms receipt and commit |
| Resume | answers are stored under the packet's SHA-256, and "Import answers" reloads any earlier export after checking packet and label-file hashes, so a moved or re-downloaded file loses nothing |

*Section 1, auto_chronicle (28 page cards).* The header reprints the three label rules (anchor events only; action items and commitments are neither required nor wrong; nothing dated after the page) and the timezone rule: labels date a calendar invite by its UTC `DTSTART` day, gbrain's default `chronicle.tz`; each invite shows the raw value, the UTC day and Pacific time, and "wrong date" means the UTC day is wrong. A section-level box records a disagreement with a rule once, instead of as many row errors. Each card shows the whole page (or the raw `VEVENT`), then its labeled events with their `keywords` and `basis`. Per event: **Supported as written / Has an error / Can't tell**; "Has an error" reveals checkboxes (date, description or person, not an event, keywords wouldn't identify it) and a corrected-date field that is required when "date" is ticked. Per card, an optional "event the labels missed" entry. Corrections and additions follow a versioned schema (add, edit, remove; stable ids; date, description and keywords all entered by Garry); the packet won't accept an addition without them, so no agent fills a scored field.

*Section 2, Cat35 (24 rows, blind).* The question at the top of every row is the judge's: "Does this note convey the statement?" Each row first shows only what the judge saw: the statement and the note, in full, with a find box and one-click search chips taken mechanically from the statement's nouns. After the rating is recorded, the transcript paragraph appears for an optional, separately recorded "context changes my answer" flag; it never edits the rating. Buttons match the judge's scale: **Fully conveyed / Partly conveyed / Not conveyed / Can't tell**. Lane names, judge evidence, judge verdicts and transcript grouping are hidden. The 21 rows with a non-empty note come first, in a seeded random order (seed in the packet), and progress counts eligible ratings toward the 12 needed to publish; the 3 empty-note rows come last. Missingness and "can't tell" patterns are reported, since a timeboxed prefix depends on which rows took longest.

*Scoring, committed before the packet is sent.* Agreement and linearly weighted kappa are computed offline from the committed calibration file by `scripts/w11-score.ts`, which calls `weightedKappa` from `eval/runner/cat35-checks.ts` and asserts the judge column's SHA-256 matches the packet. It never runs `--judge-calibration`, which reruns the judge and overwrites the stored verdicts. "Can't tell" is an abstention: counted and reported, excluded from kappa. Results are published only when at least 12 rows have a non-empty note and an answer other than "can't tell" (the headline population), else the banner stays "pending" and the scorer says why; with a bootstrap 95% interval and a 3×3 judge-by-human table, twice: all answered rows, and answered rows with a non-empty note (the headline). `scripts/w11-score.ts` also validates the returned file (known ids, hashes, required corrected dates), stores it as `docs/benchmarks/2026-10-XX-w11-labels/labels.json`, and prints a machine-readable publication decision with its reason. Chronicle banners are generated from the counts actually reviewed; corrected labels replace originals in the reference set, added missed events join it, removed labels leave it, "can't tell" labels stay as the agent wrote them and are reported as a bound, and the recall rule becomes ceil(34/38 × revised set size) (preregistered). Cat35 publishes "calibrated" only when the lower bound of kappa's transcript-clustered interval is at least 0.4; an interval wider than 0.5 is "imprecise"; kappa with collapsed marginals is reported as undefined. At 12 rows the interval is roughly ±0.4. Chronicle is rescored from the rerun's committed event files with `chronicle-lift.ts score` and Garry's labels, beside the agent-label column. Garry's answers are committed as his labels; nothing marked "can't tell" or skipped is filled by an agent.

*Banner templates* (the report fills in the numbers):
- Cat35: "Human coverage review: Garry Tan checked X of 24 coverage verdicts blind on 2026-10-XX (Y with a non-empty note; Z can't tell). Agreement with the judge (`claude-sonnet-4-6`) on non-empty notes: A of Y, linearly weighted kappa K (95% CI L to U). The 16 grounding and distractor rows have no judge verdict and are not checked; the usability judge is not checked by a person."
- Chronicle: "Reference-label review: Garry Tan checked the 38 labeled events on all 28 labeled pages on 2026-10-XX: N supported, M corrected, C can't tell, K missed events added. The 36 questions, the 116 unlabeled pages and downstream benefit are not checked by a person."

### One pull request

All workstreams ship in one gbrain-evals PR, `evals/followups-2026-10`, opened with `pr_create` when W1 lands so CI runs from the start. Order of commits:

1. W1 re-pin preregistration → W1 runs, fixes and doc truth pass, including README current-state text for the new pin (so the last commit only restamps).
2. All remaining preregistrations in one commit, pushed before any of their cells run, plus the family files.
3. One commit per workstream: runner change, receipts, report, `TODOS.md` and ledger updates, changelog entries.
4. W11 after Garry returns the labels.
5. README, `docs/README.md`, CHANGELOG and VERSION (next PATCH at merge time) in the final commit, after merging master in with a merge commit.

The PR goes to GBRA-40's merge queue when CI is green; this thread does not merge it. If Garry's 30 minutes slip, W11 ships as a later commit before merge, or alone in a later PR.

### Time

About nine agent-days of work in three lanes: W1 first (most of day 1); then a free lane (W2, W12, W3, W13, about 2.5 days), a paid-small lane (W4-W9, about 3 days) and the LongMemEval lane (batch lane and its tests 1.5 days, then arms one at a time). Batch turnaround is usually hours but can take up to 24 hours per arm, so with nine arms in sequence the LongMemEval lane takes 2 to 6 calendar days. Dependencies: W1 before everything; preregistrations before their cells; W7 before W8's Cat 20 control; W10b's first arm before W8's LongMemEval control. Garry's 30 minutes can happen any time after the packet is ready, on day 2.

### Decisions for Garry (G1-G9, T1-T2)

| # | Decision | Recommendation |
|---|---|---|
| G1 | Approve the round at $287 of caps (≈$221 expected), one PR, cut line after W11 | Approve |
| G2 | Add `gpt-6-astra` to the reader replay (+~$45) | No, for budget |
| G3 | `gpt-5.4` is the round's one older model with new calls, as the reader replay's link to vendor rows | Yes |
| G4 | Garry's review time (W11): about 15 minutes for the chronicle section; optionally a second sitting of up to 30 minutes for Cat35 | Yes to sitting 1; sitting 2 when convenient |
| G5 | Keep both sealed sets closed this round | Yes: sealed v2's `auto` arm is at 192/200, so a reader swap could only show non-inferiority; save the two openings for a harder candidate |
| G6 | After W9 and W10: move gbrain's defaults (chat Sonnet 4.6 → Sonnet 5.5, which costs less per token; contradiction judge Haiku → the cheapest model that passes N2) | Decide on the results; any change is a gbrain PR with its own eval mirror |
| G7 | Close the 1,024-token reading-notes rerun without spending | Yes |
| G8 | Fund ranks 16-17 from the remaining $13 | Optional |
| G9 | Protocol-fixed older judges and readers: keep LongMemEval's `gpt-4o` judge (with `gpt-6.1-sol` added as a second judge) and allow W13's `gpt-4.1-mini` answer half | Keep the `gpt-4o` judge for comparability; W13 answer half optional |
| T1 | Taste: fund the full-context baseline (W10c, $40) instead of the auto_chronicle agent arm (rank 18, $45) | W10c: it answers whether gbrain is worth using at all |
| T2 | Taste: add a weekly scheduled re-pin job that opens a PR with free-tier results | Not now: weekly PRs cost merge slots under the one-PR preference; revisit if drift between rounds stays this large |

## NOT in scope

- Opening sealed v1 or v2, or creating new sealed material.
- gbrain product changes (P1 lexicon, P3 link typing, P5 typed lines, default-model changes): recorded as dependencies and decisions only.
- Regenerating world-v1, amara-life fixtures (N2-6) or any corpus in place. W3 adds a new corpus version.
- The Cat 40 harder tier, Family D, a file-agent baseline on LongMemEval, and the full head-to-head scoreboard plan (W10c supplies its first matched row).
- Garry labeling N8's 480 associative probes, System One's S8 sample, or the chronicle questions.
- A weekly re-pin automation (T2).
- Fixing gbrain's takes-bootstrap pricing path or adding GPT-6 prices to gbrain's table (a gbrain change; this round uses an overlay and files the issue).
- Reasoning-effort control for W9's OpenAI judges inside gbrain's `chat()`; truncations are reported as judge errors instead.
- Multi-sample reader variance; every report states single-sample at provider-default temperature.
- A shared runner front door, an eval-tooling upgrade guide and runner-wide error codes (DX deferrals, added to `TODOS.md` in W1).

## What already exists and is reused

- Paired baselines: R1/R2 rows and request bodies (2026-09-30), the prompt v4 N2 receipt with all 2,680 Haiku verdicts, the `gpt-5.4` arm's request bodies and batch code (`2026-10-04-longmemeval-opaque-followups/scripts/frontier.ts`), the starting-line BEAM receipts and recount script.
- Runners: `cat18b-embedding-rerank-matrix.ts` (fail-open rerank check), `cat21-code-retrieval.ts`, `cat20-brainstorm.ts --live-judge`, `n8-proactive-recall.ts`, `n9-multi-hop-paraphrase.ts`, `n6-visibility-fuzz.ts`, `cat35-transcript-distill.ts --judge-calibration`, `bun run eval:decide`, gbrain's `gbrain eval longmemeval --retrieval-only` and `evals/takes-bootstrap/harness.mjs --replay`.
- The SQLite budget ledger and `compare.ts --family`.
- Ubicloud offline-tier runner and the operator-wave re-pin preregistration as a template.

<!-- REVIEW RECORD BELOW -->
## Review record

Autoplan run 2026-10-06 in Capy. Adaptations, stated plainly: Capy has no Claude Code `Agent` tool and the Codex CLI is not installed, so each phase's **native voice** is a separate Capy subagent (Claude Opus 5.5, read-only, given the phase's `nativeDispatchPrompt` from `gstack-autoplan-snapshot.ts` unchanged) and each phase's **outside voice** is a direct OpenAI Responses API call to `gpt-6-astra` (high reasoning) with the phase's outside-voice instructions and the same native prompt file. This is not the Codex CLI and had no repository access. Restore point: `~/.gstack/projects/garrytan-gbrain-evals/main-autoplan-restore-20261006-172709.md`. Mode: SELECTIVE EXPANSION. Scope flags: UI scope yes (the W11 review packet), DX scope yes (term matches; agent operators).

### Phase 1: CEO review

Inputs: native `reviews/ceo-native.md` (INPUT hash `4c4e2779…`, matches the snapshot), outside `reviews/ceo-outside.md` (`gpt-6-astra`, 10,059 input / 5,968 output tokens, completed). Primary review by the orchestrating agent, which verified the voices' factual claims (notes-first removal in `9d60b218`; house reader still defaults to notes in `src/commands/eval-longmemeval.ts:240`; R1 provenance `a7cb37b`; BEAM-1M retrieval cost $1.55 in `starting-line/summary.json`; N2 prompt version 4 on master).

**Step 0.** 0A premise: the real problem is that public claims lag the code (pin 49 releases behind, several results on older models, agent-only labels, ceilings). Do-nothing cost: README numbers describe a three-week-old gbrain and some protocol pages require models the project's own rules forbid. The plan solved that, but its largest spend (the reader replay) answered a proxy (which vendor model reads best) while being labeled as today's gbrain. 0B leverage: every workstream reuses an existing runner or receipt; the only new infrastructure is Anthropic batch support and two small generators. 0C dream state below. 0D alternatives for the LongMemEval spend: A) reader replay only (original), B) replay relabeled plus a current-pin arm, C) B plus a full-context baseline. Chose C (P1 completeness; T1 records the trade against the chronicle agent arm). 0E mode: SELECTIVE EXPANSION; accepted expansions are in blast radius and under a day each.

```
  CURRENT STATE                         THIS PLAN                                12-MONTH IDEAL
  pin v0.60.46, numbers on older   ->   pin at master; free gates on privacy  -> scoreboard re-pinned automatically;
  models and agent labels; no           and attendance; first end-to-end         every claim on current code and
  "is gbrain worth it" row              number and full-context comparison;      frontier models; held-out confirmation
                                        frontier reruns with cost lines          for each headline; head-to-head by kind
```

**Consensus table.**

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                            Native  Outside  Consensus
  1. Premises valid?                    no(W10) no(W10)  CONFIRMED: W10 framed as current gbrain on old retrieval
  2. Right problem to solve?            partly  no       DISAGREE: native wants BEAM-1M + current arm; outside wants a value-vs-simplest-alternative test
  3. Scope calibration correct?         partly  no       CONFIRMED: spend skewed to saturated reader replay
  4. Alternatives sufficiently explored? no     no       CONFIRMED: BEAM-1M (native), full-context baseline (outside) dismissed early
  5. Competitive/market risks covered?  no      no       CONFIRMED: no matched comparison that tells a user why to adopt
  6. 6-month trajectory sound?          no      partly   native: manual re-pin drift; outside: obsolete model tables without a deployable recommendation
```

**Findings and how each was resolved.**

| # | Finding (voice, severity) | Resolution |
|---|---|---|
| C1 | W10 replays `a7cb37b` retrieval but claims "shipped retrieval" (both, critical/high) | **Accepted.** Split into W10a (current-pin end to end), W10b (replay, every header names `a7cb37b`), W10c. |
| C2 | Spend on a saturated benchmark; BEAM-1M sits below the cut (native, high) | **Accepted, cheaper than proposed:** BEAM-1M retrieval costs $1.55 per build, not $8, so W13 runs it retrieval-only at two builds above the cut; Fable cut to a 200-question subset. |
| C3 | Value vs the simplest alternative is untested (outside, critical) | **Accepted as W10c** (full context, same reader, 150 questions, cost per question). Not accepted: making it the primary question of the whole round, because the user asked for the listed inventory; recorded as taste T1. |
| C4 | D6 can't pick a default without a cost tier (native, high) | **Accepted:** `gpt-6-luna` and cost per 1,000 pairs added to W9; D6 reworded to "cheapest model that passes". |
| C5 | Manual re-pin every round (native, high) | **Partly accepted:** `scripts/model-freshness.ts` in W1. **Declined for now:** weekly re-pin PR automation, because each PR takes a serial merge slot and Garry prefers fewer PRs (T2). |
| C6 | W3 passes by construction (both, medium) | **Accepted:** narrow claim, perturbed split scored against the page, original world-v1 beside it, who writes the lists. |
| C7 | W10 cap can strand partial arms (native, medium) | **Accepted:** fixed arm order, start-only-if-fits rule, batch-billed pilot. |
| C8 | Negative controls only test catastrophic breakage (both, medium) | **Accepted:** report-only partial faults added per category within W8's cap. |
| C9 | Sonnet 5.5 results described as if they applied to the Sonnet 4.6 default (native, medium) | **Accepted:** rule "say which build and model a number describes". W7's old run has no idea text, so the link is aggregate only, stated. |
| C10 | C2 closure may hide product divergence (native premise) | **Accepted:** C2's closing note records that `think` dropped notes-first while the benchmark reader keeps it. |
| C11 | Replays presented as current evidence; claims need an evidence class (outside, high) | **Accepted:** every report names regression / development / label validity; nothing here is held-out. |
| C12 | N2's 10% bar is not a deployment harm model (outside, high) | **Accepted in part:** false alerts per 1,000 candidates at observed prevalence, adjudication of flagged unplanted pairs, and an explicit "passing ≠ act without review" line. Not accepted: a full deployment prevalence model, which needs real-brain data this repo can't publish. |
| C13 | W11 could launder agent labels (outside, high) | **Accepted:** blind Cat35 rows, full source paragraph, "not enough evidence" option, chronicle questions dropped from the ask, banners say exactly what a person checked. |
| C14 | W4 and W7 can't answer their diagnostic questions (outside, high) | **Accepted:** W4's verdict limited to label-independent forbidden attributions now, graduation on free re-score later; W7 judges score all 216 ideas blind to pass/fail. Not accepted: a human usefulness sample for Cat 20, to keep Garry's ask under 30 minutes. |
| C15 | Production privacy treated as optional (outside, high) | **Accepted:** W12 moved to rank 3 with a coverage list frozen in advance; unfinished surfaces published by name. |
| C16 | Every paid item should name its consequence; cost and data-egress central (outside, high) | **Accepted:** "What each paid result changes" table; W6 reports cost, latency and egress per cell. |
| C17 | "One older model" was widened to one per experiment (outside, medium) | **Accepted:** one older model with new calls in the round (`gpt-5.4`); Haiku takes-bootstrap rerun dropped; protocol judges and the BEAM reader surfaced as decision D9. |

**Section notes (1-11).** 1 Architecture: data flow per workstream is receipt → runner → ledger → report; the new coupling is the batch lane shared by W10a/b/c, justified because it halves cost; rollback is reverting the PR before merge. 2 Error & Rescue: registry below. 3 Security: no secrets in receipts (existing ledger and receipt redaction), sealed material untouched, Garry's packet holds only public synthetic text; flagged nothing beyond the custody rule already in the plan. 4 Data-flow edge cases: empty batch results, partial arms and judge errors are covered by C7 and the "errors are results" rule. 5 Code quality: changes are small runner edits plus two generators and one script; no new abstraction. 6 Tests: covered in the eng phase. 7 Performance: batch turnaround (up to 24 h) is the critical path, hence its own lane. 8 Observability: ledger `status`/`verify`, per-arm receipts and event-loop lag already exist. 9 Deployment: one PR through GBRA-40's queue, master merged with merge commits. 10 Trajectory: reversibility 5 (docs and receipts only; product defaults untouched); debt is the weekly-drift problem (T2). 11 Design: deferred to the design phase for the W11 packet.

**Error & Rescue Registry.**

| Codepath | What can go wrong | Rescue | What the reader of the report sees |
|---|---|---|---|
| Anthropic batch submission (W10) | batch rejected, expired (24 h) or partially failed | resubmit only failed request ids under the same ledger run; arm marked partial if still failing | partial arm published as partial, excluded from paired tests |
| Batch pricing not applied | standard price billed | pilot detects it; remaining arms re-ordered under the start-only-if-fits rule | arms not run listed as not run |
| Ledger cap reached mid-arm | refusal | arm stops; no new arm starts | partial arm disclosed |
| Cold LongMemEval embedding cache (W10a) | about $10 retrieval spend | budgeted in W10a's estimate | cost line |
| Ollama cell on Ubicloud (W6) | VM or model download fails | cell recorded as `fail` with the error, VM destroyed | failed cell shown |
| N6 Postgres cell (W12) | Docker or schema setup fails | listed as "not covered" by name | coverage table |
| gbrain labels never land (W4) | provisional scores stay provisional | replay command documented | "provisional" label |
| Garry's packet slips (W11) | no labels | ships later in the same PR or a later PR | banners unchanged |

**Failure Modes Registry.**

| Failure mode | Severity | Mitigation in plan | Critical gap? |
|---|---|---|---|
| Headline number describes old code | critical | W10a; header rule | closed |
| Batch API cost assumption wrong | high | batch-billed pilot, arm order, caps | closed |
| Full-context baseline beats gbrain | medium (a result, not a failure) | consequence row commits to publishing it | closed |
| Re-pin breaks the offline tier | medium | W1 runs first; fixes or ledger entries before paid work | closed |
| PR open for a week conflicts with other mirrors | medium | merge master with merge commits; W1 text early | open, accepted |

**Dream state delta.** After this round the scoreboard is current with code, privacy is gated on the production engine, and there is one honest answer to "is gbrain worth it" on LongMemEval. Still missing against the 12-month ideal: automatic re-pins, held-out confirmation of any headline, a harder agent-task tier, and a head-to-head scoreboard by kind.

**Completion summary.** Premises challenged: 4 (W10 framing, C2 closure, older-model rule, privacy ordering). Findings: 17, accepted 13, partly accepted 4, declined 0 outright. Scope added: W10a, W10c, W13, freshness script, partial faults, `gpt-6-luna`. Scope removed: Haiku takes rerun, chronicle question review, Fable full-set arm. Cost moved from $174/$226 to $215/$275.

<!-- autoplan-accepted:ceo -->
- W10 is split into W10a (current-pin end to end, Sonnet 5.5), W10b (replay labeled with `a7cb37b` in every table header) and W10c (full-context baseline, 150 questions, two readers, cost per question); verification: preregistration names all three and the header rule.
- W10 arms run in a fixed order, an arm starts only if its full estimated cost fits under the remaining cap, and the pilot is billed through the batch endpoint.
- W13 reruns BEAM-1M retrieval only at `6622a119e` and at the new pin; the answer half waits on D9.
- W9 adds `gpt-6-luna`, cost per 1,000 judged pairs, false alerts per 1,000 candidate pairs, adjudication of flagged unplanted pairs, and the "cheapest model that passes" framing for D6.
- W3 claims only the documented format, adds a 15% perturbed split scored against the page, and reports world-v1 beside it.
- W8 adds one report-only partial fault per category for Cat 14, Cat 35 and LongMemEval answers.
- Every report states its evidence class and which build and model each number describes.
- Every paid preregistration copies its row from "What each paid result changes".
- W12 runs at rank 3 with its coverage list frozen in the preregistration; unfinished surfaces are published by name.
- W11 Cat35 rows are blind to the judge's verdict, every row offers "not enough evidence", the chronicle questions are not in the ask, and banners state exactly what a person checked.
- W4's preregistered verdict covers only forbidden attributions and malformed cases; per-kind scores are provisional until a free re-score on gbrain's completed labels.
- W7 judges score all generated ideas blind to the internal pass/fail.
- Exactly one older model (`gpt-5.4`) gets new calls; protocol judges and the BEAM reader go to D9.
- W1 adds `scripts/model-freshness.ts` and records the `think` notes-first divergence in C2's closing note.
<!-- /autoplan-accepted:ceo -->


### Phase 2: Design review (UI scope: the W11 packet and result presentation)

Inputs: native `reviews/design-native.md` (INPUT `6b4e7b52…`, matches), outside `reviews/design-outside.md` (`gpt-6-astra`, 12,382 in / 5,181 out, completed). The orchestrator verified the native voice's data claims: judge coverage verdicts are FULL 14 / PARTIAL 3 / ABSENT 7; `gold-events.json` dates invites by UTC `DTSTART`; `chronicle-lift.ts` has a `score` subcommand.

```
DESIGN DUAL VOICES — CONSENSUS TABLE:
  Dimension                 Native  Outside  Consensus
  Information architecture  5       low      CONFIRMED weak: question and evidence order undefined
  Interaction states        3       low      CONFIRMED: no state contract
  User journey              4       low      CONFIRMED: 30-minute promise not achievable
  Specificity / AI slop     4       low      CONFIRMED: "rows and buttons" generic
  Design-system alignment   6       ok       CONFIRMED: keep public docs in existing Markdown pattern
  Responsive                4       low      CONFIRMED: unspecified
  Accessibility             4       low      CONFIRMED: unspecified
```

| # | Finding (voice, severity) | Resolution |
|---|---|---|
| D-1 | Cat35 buttons don't match the judge's FULL/PARTIAL/ABSENT scale, so weighted kappa can't run (native, critical; outside: "present" ambiguous) | **Accepted:** Fully / Partly / Not conveyed / Can't tell, with the judge's question on every row. |
| D-2 | UTC dating rule would read as 15 wrong dates in Pacific time (native, critical) | **Accepted:** raw, UTC and PT shown; rule stated; one section-level rule-disagreement box. |
| D-3 | 20,834 words of notes don't fit 14 minutes (native, critical; outside, high) | **Accepted:** honest estimate; two independent sittings (chronicle ≈15 min; Cat35 30-min timebox, 12-row minimum); find box with chips from the statement. |
| D-4 | No partial-completion rule (both, high) | **Accepted:** seeded random order, publish at n ≥ 12 with an interval. |
| D-5 | `--judge-calibration` reruns the judge and overwrites verdicts (native, high) | **Accepted:** offline `scripts/w11-score.ts` with a SHA check. |
| D-6 | Empty-note rows give free agreement (native, high) | **Accepted:** explicit empty state; kappa reported with and without them, headline without. |
| D-7 | Chronicle should be page cards with missed-event capture (native, high) | **Accepted:** 28 page cards, optional missed-event field. |
| D-8 | "Wrong date" lacks a correction; keyword field unflaggable; error types incomplete (both, high) | **Accepted:** Supported / Has an error (date, description or person, not an event, keywords) / Can't tell; corrected date required. |
| D-9 | No preregistered consequence for low kappa or corrected labels (native, high) | **Accepted:** W11 rows added to the consequence table. |
| D-10 | Delivery format undefined; no state contract; saved vs exported vs received (both, high/medium) | **Accepted:** self-contained HTML, `localStorage`, export + clipboard, eight-state table. |
| D-11 | Banner wording unspecified; inventory still promised banner removal (both, high/medium) | **Accepted:** templates in W11; B1/B2 rows rewritten. |
| D-12 | W10c compared GPT on historical retrieval with Sonnet on current-pin retrieval (outside, high) | **Accepted:** a `gpt-6.1-sol` reader on current-pin prompts for the 150 questions (+$3); full-context table shows only 150-question pairs. |
| D-13 | No status vocabulary for partial/failed cells (outside, medium) | **Accepted:** six-status vocabulary rule. |
| D-14 | Blindness leaks (lane names, grouping, evidence); lock-then-reveal; confusion table; layout and keyboard (both, medium) | **Accepted** as specified in W11. |

Not accepted: none. Section 11 of the CEO methodology (design intentionality) is covered by this phase.

<!-- autoplan-accepted:design -->
- The W11 packet is a self-contained HTML file with the opening screen, eight-state contract, autosave, export with clipboard copy, lock-then-reveal, keyboard shortcuts and responsive single-column layout as written in W11; verified by a dry run of 5 rows timed by the agent before sending and a Safari check.
- Cat35 rows use the judge's question and scale (Fully / Partly / Not conveyed / Can't tell), hide lane, grouping and judge evidence, appear in a seeded random order, and publish only at n ≥ 12 with kappa computed offline by `scripts/w11-score.ts` (SHA-checked; never `--judge-calibration`), reported with and without the 3 empty-note rows.
- Chronicle review is 28 page cards with UTC/PT dates, the label rules reprinted, Supported / Has an error / Can't tell with a required corrected date, keyword flags and a missed-event field; rescoring uses `chronicle-lift.ts score` beside the agent-label column.
- W11's consequence rows and banner templates are committed before the packet is sent.
- Every results table uses the six-status vocabulary; LongMemEval tables are scoped into current-pin, full-context (150-question pairs) and historical-replay sections with the labels written in the plan.
- W10a adds a `gpt-6.1-sol` reader on current-pin prompts for W10c's 150 questions.
<!-- /autoplan-accepted:design -->


### Phase 2.5: DX review (developer-facing: README readers, reproducers, round operators, Garry)

Inputs: native `reviews/dx-native.md` (INPUT `744cc4d9…`, matches; overall 5.6/10), outside `reviews/dx-outside.md` (`gpt-6-astra`, 13,983 in / 5,902 out, completed). The orchestrator verified: gbrain master's price table stops at `gpt-5.6` (`src/core/model-pricing.ts:135-143`) and the takes harness exits 2 on an unpriced model (`harness.mjs:86-91`); `frontier.ts` has no ledger calls; README's version row says v0.10.24 while `VERSION` is 0.10.35. Decision labels D1-D9 were renamed G1-G9 in this phase to stop colliding with inventory rows D1-D12; earlier phase records keep their original "D" wording.

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                         Native  Outside  Consensus
  Getting started / TTHW            ~5      2        CONFIRMED weak for reproducers; fine for README readers and Garry
  CLI / API naming and flags        4       4        CONFIRMED: inconsistent model flags; W13 command invalid
  Errors and recovery               5       3        CONFIRMED: batch resubmission and unpriced-model failures unhandled
  Documentation / findability       6       5        CONFIRMED: label collisions; reproduce sections not required
  Reproducibility / provenance      7       7        CONFIRMED strong
  Budget and execution safety       3       6        CONFIRMED gap: batch spend outside the ledger
  Upgrade path                      6       3        DISAGREE on depth; both want exact commit recorded
  Owner review workflow             8       6        CONFIRMED: export-locks-everything contradicted two sittings
```

**Developer journey (round operator).** Read plan → run freshness check (new) → re-pin and offline tier → register GPT-6 prices (new) → write preregistration from template (new) → order check in CI (new) → run free lanes → build batch lane with ledger reservations (new) → pilot through batch endpoint → full arms → re-score keylessly → write report with "Reproduce and inspect" → README. Each "(new)" step is a fix from this phase; before them the operator would have hit an unpriced-model exit, an invalid W13 command and unmetered batch spend.

**Empathy narrative.** An agent picking this up next month opens the plan, finds W13's command, and gets a usage error; it runs W4 and gets exit 2 for `gpt-6.1-sol`; it submits W10's batches and the ledger shows $0 spent while OpenAI bills $40. Each failure is quiet until it is expensive. After the fixes, every one of those steps either works or refuses with the command that fixes it.

**Time to hello world.** README reader: about 1-2 minutes to the current-results table (target under 2, kept). Reproducer: over 10 minutes to find a correct command today; target under 5 minutes and $0 via the keyless re-score that every report now leads its "Reproduce and inspect" section with. Garry: under a minute to the first label.

| # | Finding (voice, severity) | Resolution |
|---|---|---|
| X-1 | Batch spend bypasses the ledger; no owner for Anthropic batch support (native C1; outside 5) | **Accepted:** `eval/runner/batch-lane.ts` with reservations, idempotent resume and an over-cap test, built first in W10 and timed. |
| X-2 | `gpt-6.1-sol` and `gpt-6-luna` unpriced in gbrain; W4 exits 2 (native H1) | **Accepted:** W1 step 8 registers prices and checks routing. |
| X-3 | Model switching needs code (native H2) | **Accepted:** W8 adds flags; A7 corrected. |
| X-4 | Label collisions (native H3) | **Accepted:** decisions renamed G1-G9; "B9" reference fixed. |
| X-5 | W13 command invalid (native H4) | **Accepted:** exact `init` → `fetch` → `dev` sequence. |
| X-6 | Older-model sentence ignores `gpt-4o` judge calls (native M1) | **Accepted:** sentence scoped to models under test; judges in G9. |
| X-7 | Ledger on one machine vs three lanes and VMs (native M2) | **Accepted:** one ledger host rule. |
| X-8 | Freshness script contract (native M3) | **Accepted:** inputs, outputs, exit codes. |
| X-9 | Agent time short for the batch lane; Garry time stated three ways (native M4, M5) | **Accepted:** time plan and G4 rewritten. |
| X-10 | No required reproduce section or keyless entry point (native M6; outside 1) | **Accepted:** rule in "Rules that hold". |
| X-11 | Packet autosave tied to file location; export locks the other section; reveal threatens blinding (native M7; outside 8, 9) | **Accepted:** SHA-keyed storage, import-to-resume, section-level submit, agreement only in the published report. |
| X-12 | Prompt builder for W10a unnamed (native M8) | **Accepted:** one builder in the batch lane. |
| X-13 | README version row stale (native M9) | **Accepted:** W1 step 7. |
| X-14 | No preregistration template or order check (native M10) | **Accepted:** template and CI check. |
| X-15 | W10a-W10b pairing attributed to the P-series (outside 7) | **Accepted:** "combined build and configuration difference"; W10c cost scope defined. |
| X-16 | Publication eligibility ambiguous for partial review (outside 10) | **Accepted:** eligibility on the headline population, generated banners, revised reference-set rule, machine-readable decision. |
| X-17 | A unified CLI front door with shared flags across all runners (outside 3) | **Declined for this round:** it touches every runner, far outside the blast radius; added to deferred work below. |
| X-18 | Upgrade guide for eval tooling (outside 6) | **Partly accepted:** exact commit recorded before the first cell (already in W1) and pins in every receipt. Upgrade guide deferred. |
| X-19 | Stable error codes and JSON errors across runners (outside 4) | **Partly accepted:** batch idempotency and the freshness script's fix lines. Runner-wide error codes deferred. |

**DX implementation checklist** (all now in the plan text): batch lane reserves through the ledger with an over-cap test; GPT-6 prices registered; model flags on Cat 14, 29, 35; G-labels; W13 commands; older-model sentence; one ledger host; freshness contract; time plan; reproduce sections; SHA-keyed packet storage and import; shared prompt builder; README version row; preregistration template and order check; README LongMemEval rows show n, judge, reader and dollars per question; reports record wall time, refusals and retries.

Deferred (to be added to `TODOS.md` in W1): a shared runner front door with common flags (X-17); an eval-tooling upgrade guide (X-18); runner-wide stable error codes (X-19).

<!-- autoplan-accepted:dx -->
- `eval/runner/batch-lane.ts` reserves each batch's worst-case cost in the round's ledger before submission, settles to provider usage, supports OpenAI and Anthropic batches, persists request hashes and batch ids so restarts never resubmit, and has a test proving an over-cap batch is never submitted.
- W1 registers prices for `gpt-6.1-sol` and `gpt-6-luna` in each eval brain and checks routing with a one-token call per model before W4 or W9 run.
- W8 adds `--model` and `--judge-model` flags (defaults unchanged) to Cat 14, 29 and 35.
- Decisions are labeled G1-G9; W13 uses the exact `init` → `fetch` → `dev` sequence; README's version row is corrected in W1.
- `scripts/model-freshness.ts` exits 0/1/2 as specified and prints fix commands; `scripts/prereg-order-check.ts` runs in CI; `docs/benchmarks/PREREGISTRATION-TEMPLATE.md` exists.
- Every report ends with "Reproduce and inspect" leading with a keyless $0 re-score; reports record wall time, refusals and retries.
- All paid runs start on the primary machine holding the single ledger.
- The W11 packet stores answers under its SHA-256, imports earlier exports, locks per section, and never shows judge agreement; `scripts/w11-score.ts` validates returned labels and prints a machine-readable publication decision.
- The W10a-W10b comparison is reported as a combined build and configuration difference; W10c separates recurring and one-time cost and uses provider request time as latency.
- W1 adds the three deferred DX items to `TODOS.md`.
<!-- /autoplan-accepted:dx -->


### Phase 3: Eng review (last; reviews the plan as amended by CEO, design and DX)

Inputs: native `reviews/eng-native.md` (INPUT `057ab018…`, matches; test plan `reviews/eng-test-plan.md`, copied from `~/.gstack/projects/garrytan-gbrain-evals/eng-test-plan-evals-followups.md`), outside `reviews/eng-outside.md` (`gpt-6-astra`, 14,895 in / 12,148 out, completed). The orchestrator verified: `priceRequest` throws "names no model" for any paid request without a top-level `model` (`budget-ledger.ts:1077-1085`); `renderRetrievedAsHypothesis` emits session ids plus chunk text (`src/eval/longmemeval/reader.ts:95-100`); the takes harness checks `canonicalLookup` (`harness.mjs:86-91`); `constrained-relational-gen.ts` holds development attendee-role templates (`attended_role`), so P7 probes need no sealed phrasing.

**Scope challenge.** Scope is large but almost all reuse. Understated: the batch lane (now 1.5 days, six modules, tested first), W10a's prompt source (now the R1 capture method), W12's real HTTP server (new harness work; time box and "not covered" rule kept, mandatory cells defined), W6's local cell (time box or 1,024-dim model). Nothing free was cut.

**Architecture.**

```
                         ┌──────────── primary Capy machine (only ledger host, all paid requests) ─────────┐
 Garry's Mac             │  .budget/followups-2026-10.sqlite (cap 287) + committed status snapshots       │
 ┌──────────────┐ export │      ▲ reserve/settle                                                          │
 │ W11 packet   │──JSON──┼─► w11-score.ts ─► labels.json, kappa (clustered), publication decision        │
 └──────────────┘        │      │                                                                         │
                         │  paid-request guard ── W5 W6 W7 W8 W9 (per request)                             │
                         │  budget-run wrapper ── W4 harness overlay, W13 eval:decide (whole cap reserved) │
                         │  eval/runner/batch/ ── manifests → sources (R1/R2 replay | W10a stub-fetch      │
                         │                        capture | W10c full history) → transport (OpenAI,        │
                         │                        Anthropic) → ledger exec (intent, reserve, submit,       │
                         │                        reconcile, settle×factor) → rows by id → judges          │
                         │                        (official gpt-4o primary, gpt-6.1-sol secondary)          │
                         │  compare.ts / gates.ts (Holm across arms, noninferiority, exact bounds)         │
                         └─────────────────────────────────────────────────────────────────────────────────┘
 Ubicloud (no provider keys): offline tier, Cat 7 latency, W12 Postgres+HTTP (localhost), W6 Ollama (SSH tunnel)
```

**Codepath → test map** (assertions in `reviews/eng-test-plan.md`): batch reserve B1/B2/B12; submit B5/B6/B7; poll and results B4/B8/B13; settle B3/L1/L4; R1/R2 replay B9/F2/F3/F4; W10a capture F1; W10c F5/F6; finish handling B10/B11; W4 P1/P2; W9 N1-N4/P3; W11 W1-W8; order check O1-O4; freshness M1-M4; runner flags and generators R1-R6; statistics S1-S4.

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                         Native  Outside  Consensus
  Budget enforcement on all paths   fail    fail     CONFIRMED critical: batch lane vs guard; external runners
  Exactly-once batch submission     fail    fail     CONFIRMED critical
  Prompt fidelity (W10a)            fail    —        native only, verified in code: critical
  Worst-case reservations vs caps   fail    fail     CONFIRMED high
  Statistics (power, multiplicity)  weak    weak     CONFIRMED: Holm across arms, NI margin, exact bounds
  Pairing validity                  ok*     weak     CONFIRMED with labels: combined interventions named
  Privacy boundary (W12)            ok      weak     outside only: mandatory Postgres-over-HTTP cells accepted
  Human-review protocol             ok*     weak     CONFIRMED: blind rating from what the judge saw; schema
```

| # | Finding (voice, severity) | Resolution |
|---|---|---|
| G-1 | Guard throws on batch control calls; no batch discount; bypass repeats `frontier.ts` (native E1, outside 1) | **Accepted:** lane reserves via `BudgetRun` directly, allow-list for free batch paths, refusal of unlaned submissions, confirmed batch factor. |
| G-2 | External runners (W4 harness, `eval:decide`) and free jobs outside the ledger (outside 1) | **Accepted:** whole-cap budget-run reservation for runners with their own budget; free jobs without provider keys; W6 via SSH tunnel. |
| G-3 | Crash after acceptance resubmits a batch; unknown-outcome state (both, critical) | **Accepted:** intent records, provider metadata, reconcile before submit, no automatic resubmission or release. |
| G-4 | W10a built from `--retrieval-only` chunk text (native E3, critical) | **Accepted:** stub-fetch capture of real reader bodies. |
| G-5 | Worst-case reservations exceed caps (both, high) | **Accepted:** real token counts, sequential arms, confirmed factor, W10c cap $45 → $50, W1 cap $1; time plan shows 2-6 calendar days for the batch lane. |
| G-6 | W4 can't run `gpt-6.1-sol`; Fable cap too low (native E5) | **Accepted:** harness overlay with price flags; per-model `--max-usd`. |
| G-7 | Reasoning and long-notes truncation (native E6, E7) | **Accepted:** preregistered limits and effort per model; 2,048 for full-context notes; cut-off counts reported. |
| G-8 | W10c equivalence from a non-significant test (both, high) | **Accepted:** 7-point non-inferiority margin; "insufficient precision" wording. |
| G-9 | W9 inputs not in the receipt; population double-counted; 456 unexplained (both) | **Accepted:** regenerate and verify all 2,680 triples; 241 planted (51 includes 6 namesakes) + 300 of 2,439 others, weighted; fresh 200-negative split. |
| G-10 | W9 point-estimate pass rule too weak for a default (both) | **Accepted:** exact bounds; pass on the bound; G6 needs an independent production-path check. |
| G-11 | Multiplicity and one primary judge (both) | **Accepted:** Holm across arms; official judge primary. |
| G-12 | Row-level contract, denominators per arm (outside 4) | **Accepted.** |
| G-13 | Batch lane absorbing responsibilities (outside 5) | **Accepted:** six modules. |
| G-14 | Isolation and DAG; W8 depends on W10b (outside 6) | **Accepted:** worktrees, per-run namespaces, dependency list. |
| G-15 | Independence and clustering (outside 9) | **Accepted:** analysis unit per workstream. |
| G-16 | W7 has no deciding rule (outside 12) | **Accepted:** median of four judges' means. |
| G-17 | W8 vacuous passes and invalid injections (outside 13) | **Accepted:** signal floor, overlap exclusion, applicability, "three categories". |
| G-18 | W12 boundary imprecise (outside 14) | **Accepted:** mandatory engine × transport × principal cells. |
| G-19 | HTML packet and receipts as exposure paths (outside 15) | **Accepted:** CSP, escaped text, hostile-string test, bounded import schema; receipts keep the existing redaction. |
| G-20 | Cat35 human saw context the judge didn't (outside 16) | **Accepted:** rate from statement and note; context afterwards as a separate flag. |
| G-21 | 12-row promise vs eligibility (outside 17) | **Accepted:** non-empty rows first; progress counts eligible ratings. |
| G-22 | Chronicle correction schema (outside 18) | **Accepted:** versioned add/edit/remove with all scored fields entered by Garry; ceil rule. |
| G-23 | Order check can't prove preregistration (both) | **Accepted:** execution-start attestation against `origin`; CI with `fetch-depth: 0`. |
| G-24 | W6 silent reranker no-op, index contamination, model id (both) | **Accepted:** invalid-cell rule kept, per-cell index, pinned digest, valid model id. |
| G-25 | Freshness check fatal mid-round; batch latency unobservable (outside 21) | **Accepted:** warning for new releases, block only for unpriced; latency as provider request time where observable. |
| G-26 | W3 and W5 lacked consequence rows; P7 unspecified; G6 overreach (outside 22) | **Accepted:** rows added; P7 from the development generator, never sealed phrasing; G6 as a hypothesis. |
| G-27 | Ledger machine-local; pin drift; C2 population (native E13, E15, E21) | **Accepted.** |
| G-28 | Ledger prices `gpt-6.1-sol` input at its cache-write rate (native §8) | **Accepted as known:** a 25% reservation overstatement, inside the caps; noted, not changed. |
| G-29 | Upgrade guide and unified CLI (outside, carried from DX) | **Declined for this round** (outside blast radius); deferred to `TODOS.md`. |

**Failure Modes Registry.** The native review's 21 failure modes (FM1-FM21) are each closed by a fix above; its four critical gaps (FM2 settlement at list, FM3 guard bypass, FM4 double submission, FM5 wrong W10a prompt) are closed by G-1, G-1, G-3 and G-4 with tests B3, B8, B5 and F1. Remaining open, accepted: FM20 (a provider long-context price tier; LongMemEval-S histories are about 115,000 tokens, under the 200,000-token tiers, checked again at pilot time) and the week-long PR's merge friction.

**Completion summary.** Findings: 29 (native 22, outside 22, merged). Accepted 27, accepted-as-known 1, declined 1 (deferred). Critical gaps closed: 4. Cost moved from $218/$278 to $221/$287 (W9 +$2, W10c cap +$5, W1 cap +$1). Agent time from about 8 to about 9 days; LongMemEval lane 2-6 calendar days.

<!-- autoplan-accepted:eng -->
- The batch lane is six modules under `eval/runner/batch/` with ledger reservations through `BudgetRun`, a guard allow-list for free batch paths, refusal of unlaned submissions, a pilot-confirmed batch factor, intent records reconciled against provider batch lists before any submission, and the test list B1-B13 and F1-F6 passing before any paid batch.
- Runners with their own budget reserve their whole cap as one ledger reservation first; free jobs run without provider keys; W6's Ollama is reached over an SSH tunnel; ledger status snapshots are committed after each workstream.
- W10a captures real reader bodies with a stub fetch; arms run one at a time with reservations sized from real token counts; output limits and reasoning effort are preregistered per model; W10c uses a 7-point non-inferiority margin and 2,048-token notes limit.
- W9 regenerates and verifies all 2,680 judge inputs before replay, judges 241 planted pairs plus a weighted 300-pair sample and a fresh 200-negative split, prints exact bounds, and passes a model only on the bound.
- Every preregistration fixes the primary comparison, one primary judge, Holm across arms, the MDE, the cluster unit and any non-inferiority margin; every arm has a row-level manifest and its own denominator.
- Runners record an execution-start attestation against `origin`; the order check runs in CI with full history.
- W12's mandatory cells are Postgres over real HTTP for four principals with warm caches and pooled connections; a missing mandatory cell fails the gate.
- W11 rates Cat35 from statement and note only, puts non-empty rows first, uses a versioned correction schema, renders escaped text under a CSP, and decides "calibrated" on kappa's clustered lower bound.
- W7 decides on the median of four judges' means; W8 adds signal floors and injection checks; W4 runs through a pricing overlay with per-model caps; P7 probes come from the development generator.
- The W1 pin is one frozen SHA; W1 has a $1 cap for route checks.
<!-- /autoplan-accepted:eng -->

### Phase 4: Final approval gate

**Plan summary.** One gbrain-evals PR, 15 workstreams above the cut ($221 expected, $287 of worst-case caps, under the $300 limit), no sealed set opened, one older model under test (`gpt-5.4`), about 9 agent-days, and 15 minutes of Garry's time, plus an optional second sitting of up to 30 minutes.

**Decisions made: 59 in total** (CEO 17 findings, design 14, DX 19, eng 29, with overlaps merged into the audit trail's 36 rows). Taste choices surfaced to Garry: T1 (full-context baseline instead of the chronicle agent arm), T2 (no weekly re-pin automation yet), plus the audit trail's taste rows 4, 18, 20 and 29. No **user challenge**, meaning both voices agreeing to change Garry's stated direction: the outside CEO voice wanted the round reorganized around one value question, the native voice did not, and the plan keeps the requested inventory with W10c added (taste row 18).

**Review scores.** CEO: both voices "revise W10", now resolved. Design: 4/10 → about 8/10 after fixes (native estimate). DX: 5.6/10 before fixes (native). Eng: approve after the fixes now written in.

**Cross-phase themes.** (1) Say exactly what a number describes: build, model, retrieval date, evidence class. This came up in all four phases. (2) Hard limits have to be enforced in code, not just stated: the ledger, attestation and eligibility rules. (3) Garry's time is the scarcest input, and the protocol around it has to be fixed before he spends any.

**Outside-voice coverage.** All four phases ran an outside voice through the OpenAI API (`gpt-6-astra`), not the Codex CLI, which is not installed here. The voice had no repository access, so the native voices and the orchestrator verified its code claims. Review spend on API calls was about $2.10 (four `gpt-6-astra` calls; the subagent reviews ran on the thread's own model).

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Split W10 into a/b/c with header rule | Mechanical | P1 | Both voices: current framing is false | Replay-only |
| 2 | CEO | Add W10c full-context baseline | Taste (T1) | P1 | Answers "why gbrain" for $39 | Chronicle agent arm in its slot |
| 3 | CEO | W13 BEAM-1M retrieval-only above cut | Mechanical | P3 | $3, corrects a published number | Full rerun with older reader (D9) |
| 4 | CEO | Fable replay on 200-question subset | Taste | P3 | Saves $26; Fable still included per model rule | Full 500 |
| 5 | CEO | Add `gpt-6-luna` and cost lines to W9 | Mechanical | P1 | Makes D6 answerable | Peak tiers only |
| 6 | CEO | Model-freshness script; weekly re-pin deferred | Taste (T2) | P5 | Script is small; weekly PRs fight the one-PR preference | Weekly automation now |
| 7 | CEO | W3 narrow claim + perturbed split | Mechanical | P1 | Both voices | Construction-only test |
| 8 | CEO | W10 arm order and start-if-fits rule | Mechanical | P5 | Avoids stranded arms | Single cap only |
| 9 | CEO | Partial faults in W8 | Mechanical | P1 | Both voices | Gross controls only |
| 10 | CEO | Evidence-class and build/model labeling rule | Mechanical | P5 | Outside voice; cheap | — |
| 11 | CEO | N2 false alerts per 1,000 and adjudication | Mechanical | P1 | Outside voice | Full prevalence model |
| 12 | CEO | W11 blind, full context, fewer rows | Mechanical | P1 | Outside voice | 74-row skim |
| 13 | CEO | W4 verdict limited to label-independent metrics | Mechanical | P5 | Outside voice | Full verdict now |
| 14 | CEO | W7 judges score all ideas, blind | Mechanical | P1 | Outside voice | Passing ideas only |
| 15 | CEO | W12 to rank 3 with frozen coverage | Mechanical | P1 | Outside voice | Time-boxed at rank 12 |
| 16 | CEO | Consequence table for paid items | Mechanical | P5 | Outside voice | — |
| 17 | CEO | One older model round-wide; D9 for protocol models | Mechanical | P5 | Matches the user's literal instruction | One per experiment |
| 18 | CEO | Keep the inventory-driven scope rather than reorganizing the round around one value question | Taste | P6 | User asked for the inventory; W10c covers the value question | Outside voice's full re-scope |
| 19 | Design | Cat35 scale matches judge; UTC/PT shown | Mechanical | P5 | Kappa can't run otherwise; avoids false errors | present/absent |
| 20 | Design | Two independent sittings, 12-row minimum | Taste | P3 | Honest time; smallest ask completes B2 alone | One 30-min sitting covering both |
| 21 | Design | Offline kappa script | Mechanical | P5 | Avoids paid rerun and verdict overwrite | `--judge-calibration` |
| 22 | Design | Page cards with missed-event field | Mechanical | P1 | Same reading, more validated | Per-event rows |
| 23 | Design | GPT current-pin arm on 150 questions | Mechanical | P1 | Makes both full-context pairs current-pin | Mixed-retrieval comparison |
| 24 | Design | Status vocabulary and scoped LongMemEval tables | Mechanical | P5 | Prevents misreading partial and replay results | Free-form tables |
| 25 | DX | Ledger-reserving batch lane | Mechanical | P1 | Cap is otherwise not hard | Reuse `frontier.ts` |
| 26 | DX | Register GPT-6 prices in W1 | Mechanical | P5 | W4/W9 fail otherwise | — |
| 27 | DX | Rename decisions to G1-G9 | Mechanical | P5 | Label collisions | — |
| 28 | DX | Section-level submit, SHA-keyed storage, import | Mechanical | P1 | Two sittings must work | Export locks all |
| 29 | DX | Decline unified runner front door this round | Taste | P3 | Outside blast radius; deferred | Build now |
| 30 | DX | Prereg template and CI order check | Mechanical | P5 | Makes "preregister first" checkable | Honor system |
| 31 | Eng | Batch lane as six tested modules with exactly-once submission | Mechanical | P5 | Critical gaps FM2-FM4 | Single file, untested |
| 32 | Eng | W10a stub-fetch capture | Mechanical | P4 | Byte-exact, reuses R1 method | Rebuild prompts from retrieval-only text |
| 33 | Eng | Sequential arms; W10c cap +$5 | Mechanical | P3 | Worst-case reservations | Raise program cap |
| 34 | Eng | W9 regenerate-and-verify inputs; exact bounds | Mechanical | P1 | Pairing and decision validity | Point estimates |
| 35 | Eng | Holm across arms, primary judge, NI margin | Mechanical | P1 | Both voices | Per-pair Holm only |
| 36 | Eng | Keep ledger's cache-write overstatement | Taste | P3 | Inside caps; changing pricing code is out of scope | Patch pricing |

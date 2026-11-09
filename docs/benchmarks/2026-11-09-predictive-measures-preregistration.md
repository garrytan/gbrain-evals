# Do synthetic memory tests predict an agent's real failures? Preregistration

Frozen 2026-11-09, before any generator output was scored and before any paid call. The runner, generators and scorers ship in the same pull request as this file, and the counted runs use its merged commit. A change after a counted cell has run is a dated amendment appended at the end.

## Question

gbrain-evals has about 35 eval families, and most of them sit at or near their ceiling. Wintermute is the agent that runs Garry Tan's gbrain brain every day. In an interview on 2026-11-09 it described failures those evals don't model:

- a stale fact used when a newer one sat on a page it didn't open;
- paraphrased questions that missed the page they needed;
- writes reported as done that never landed;
- two people with the same name mixed up;
- queries that take about 10 seconds;
- saved web pages with no usable body.

This experiment builds fictional test worlds that reproduce each failure's structure. It then asks one question of every synthetic measure: does it rank gbrain configurations and versions the same way the real brain does? A measure that doesn't gates nothing.

## Public lesson

- If measures read PREDICTIVE: "We learned that a synthetic memory test predicts a real agent's failures when it copies the failure's structure and the brain's conditions (paired paraphrases, missing embeddings, stale pages one hop away). You should seed your generators from your agent's real misses and check each measure against real-brain contrasts before it gates a release."
- If measures read NOT PREDICTIVE: "We learned that synthetic memory tests can look right and still rank configurations differently from a real brain. You should treat any synthetic score as unvalidated until it agrees in sign with real-brain contrasts, and spend on real-brain probes first."
- If measures read NO REFERENCE YET: "We learned which failures nobody can yet check against a real brain. You should build that real reference before trusting a synthetic number for that failure."

## Evidence class

These are validity checks against held-out references.

- Live-recall batch 1 is the development reference, because the generators were designed after reading it.
- Live-recall batch 2 is held out, and so are batch 3 (not yet written), the phase-2 agent results (GST-1848, not yet counted) and the weekly miss counts (not yet collected).
- Generator knobs are set from measured brain conditions and never from held-out outcomes. Those conditions are: 0% synopsis vectors, 10% of chunks with no vector, the keyword candidate bound, and about half of sampled media pages as empty shells.
- Knobs that touch a reference are set independently of that reference's counts, so no check passes by construction. That covers G3's task mix and G6's access-flag mix.

## Build and data

- **gbrain under test.** "Current" is the commit `package.json` pins at merge: 0.60.557.0 (`62637c96a`).
  - That pin is older than 0.60.570.0, the release that fixed most refused two-selector page reads (gbrain#8509).
  - Write-and-contract results at the current pin therefore include refusals the production brain no longer has. Every contract result names its pin.
  - G3's version contrast runs pins 0.60.549.0 and 0.60.570.0 through the repo's gbrain-under-test overlay.
  - The pin bump is tracked separately (GST-2031) and isn't part of this experiment.
  - Every receipt records the gbrain version it loaded.
- **Visibility epoch.** GBRA-398 (GST-2059) will relabel over-applied `access: private` pages and let owner and delegate connections see private pages. Batch 3's freeze and run each record which side of that change they fall on (`visibility_epoch`), and results from the two sides are never pooled.
- **Generators.** All are seeded through `eval/generators/seeded.ts`, fictional, and pinned by digest in tests. Wintermute's fictional templates and its counted refusal causes seed the task families. No page text, name or question from the real brain is in this repository.
- **References.** These live in `eval/data/validity-references/`, with a manifest of sha256 digests.
  - `live-recall-b1` and `live-recall-b2` are exported from the published scorecards by `eval/runner/predictive/export-references.ts`. Each has 13 success@5 contrasts whose 95% interval excludes zero.
  - `live-recall-b3`, `phase2-agent` and `miss-log-weekly` are listed as pending.
  - A missing, corrupt or off-digest reference stops the run with `VALIDITY_REFERENCE_INVALID`.

## Arms

**Models.** Agent units run claude-opus-5-5, gpt-6.1-sol and particle-1, at the efforts the runner records. Each task runs k = 4 trials. The first results table shows Opus and particle-1 with cost per correct answer.

**Units.**

| Unit | What it reproduces | Size | Surface | Configurations compared |
|---|---|---|---|---|
| G1 freshness across pages | An entity page lags a newer meeting or timeline page; a compiled summary contradicts its timeline; a decision is reversed in another thread; shared vs published dates; "last week" across time zones | 120 tasks | gbrain CLI | models; search configuration |
| G2 recall under real conditions | Exact and paraphrase forms on the same gold; codename pages; transcript-only facts; nicknames; missing embeddings; keyword bound; empty shell pages | 100 questions per condition, 4 conditions, 2 pins | live-recall harness, six arms | the six live arms |
| G3 write landing and call contract | Wintermute's counted refusal causes, and writes reported done that never landed | 60 tasks | CLI and MCP | pins 549 and 570; surface |
| G4 wrong entity | Two same-named people, one of whom moved; a family sharing a surname; a company named like its founder's handle; a father and son with one name | 60 tasks | gbrain CLI | models; search configuration |
| G5 latency at scale | A synthetic brain of about 300k pages on Postgres with the real search configuration | one brain, 2 pins | direct operations | pins; one knob |
| G6 gold out of view | Gold hidden from a remote caller by a direct flag, alias inheritance or a derived-page default | keyless core; 50 agent tasks × 2 callers | in-process gbrain reads | caller |

**How the arms run.** The CLI arm runs the pinned gbrain binary as argv-only exec, with no shell, inside a hermetic environment. That environment has a temporary brain home holding only the synthetic brain, and provider keys blanked or a stub upstream. The MCP arm uses the existing tool loop.

## Metric and denominator

- **Units of analysis.**
  - Agent units: the task. Trials are averaged within a task, and pass^k is C(c, k) / C(n, k) averaged over tasks.
  - Retrieval units: the question form, clustered by question.
- **Cause ids.** Every failure carries one cause id from the shared failure-cause taxonomy (`eval/runner/failure-causes`, mirrored in `eval/runner/predictive/causes.ts`).
- **Fixed answer schemas.** Each agent unit has a fixed final-answer schema.
  - G1 returns an answer value. Gold values for the fresh, stale and time-shifted readings are disjoint, so stale_fact and time_reasoning are told apart without a judge.
  - G3 returns the claimed write ids and paths, which are checked against a landing ledger. The ledger counts writes and pages, and ignores the frontmatter title and the derived H1, because an untitled capture is one write and one page.
  - G4 returns an entity id.
  - G6 returns answered, abstained and citations.
- **pages_opened** counts page reads (get calls) only, never search snippets.
- **Invalid rows.** An answer that can't be keyed is an invalid row and is reported as such. No model judge scores any counted cell.
- **Unit metrics.**
  - G2: success@5, MRR, the exact-minus-paraphrase gap, and for batch 3 the stale-first rate.
  - G3: refusals per 100 calls by cause given exposure, recovery share, refusals never retried, and "reported done, not landed".
  - G5: p50 and p95 per operation, and statement-timeout fall-opens.
  - G6: gold out of view by sub-cause and caller, and answers given without the gold.
  - A hide is counted, never called a bug. Whether a hide is right is the brain owner's call.

## Decision rule

**Verdict per measure** (`eval/runner/predictive/validity.ts`):
- A reference contrast qualifies when its real 95% interval excludes zero.
- A measure needs at least 3 qualifying contrasts, all named below, or it reads NO REFERENCE YET.
- It reads PREDICTIVE when its synthetic estimate has the same sign as every qualifying contrast, and no mapped synthetic contrast whose interval excludes zero points the other way.
- Otherwise it reads NOT PREDICTIVE.
- Kendall's tau over the arm ordering is reported, but never gates.

**Mapped contrasts and expected verdicts:**
- **G2** maps all 16 success@5 contrasts of `live-recall-b2` (13 qualify), including P1, P2, `configured_vs_hybrid` and the five `paraphrase_vs_exact_*` gaps. Expected: PREDICTIVE if the condition knobs carry the real conditions.
- **Batch 3's own primaries** are fixed here and in the live-recall [batch 3 amendment](live-recall/PREREGISTRATION.md#batch-3-amendment), before its freeze: P1 is `p1_configured_vs_hybrid_lexical_freshness` and P2 is `p2_configured_vs_hybrid_lexical_entity`, both success@5 over both question forms of their type, Holm-adjusted as one family. Batch 2's P1 is replicated as the secondary `batch2_p1_hybrid_vs_hybrid_lexical_paraphrase`. A counted run refuses a freeze from the other visibility epoch (`LR_FREEZE_MISMATCH`).
- **G2 batch-3 types and G1's retrieval layer** map batch 3's three freshness success@5 contrasts: `p1_configured_vs_hybrid_lexical_freshness`, `hybrid_vs_hybrid_lexical_freshness` and `configured_vs_keyword_freshness`. The stale-first rate by arm is reported beside them as a direction check, but it carries no interval and never gates. Expected: NO REFERENCE YET until batch 3 lands, and with three mapped contrasts the measure reaches a verdict only if all three qualify.
- **G4's retrieval layer** maps batch 3's three entity contrasts the same way: `p2_configured_vs_hybrid_lexical_entity`, `hybrid_vs_hybrid_lexical_entity` and `configured_vs_keyword_entity`.
- **G1 and G4 agent layers** map `phase2-agent` contrasts when phase 2 is counted: arm B vs arm A, and model pairs. Until then they read NO REFERENCE YET. Their counted agent cells run only after batch 3's aggregates exist.
- **G3** maps the replay version pair: at 0.60.549.0, 607 of 607 Sol page reads were refused, and at 0.60.570.0, 435 of 436 two- or three-selector calls were read. It also maps phase 2 arm B's refusal counts by cause, when counted, compared as rates given exposure. Matching the cause mix is not a criterion.
- **G5's** match to Wintermute's counted p50 and p95 (query 10.1 s and 30.1 s; search 9.8 s and 30.4 s; get 2.8 s and 10.9 s) is calibration only. The predictive test is three held-out contrasts, p95 latency at pin 549 vs 570 for `query`, `search` and `get`, each of which needs the same direction in a later real measurement. Until those exist it reads NO REFERENCE YET.
- **G6** maps the phase-2 freeze's out-of-view counts by cause, if they are published as aggregates. Until then it reads NO REFERENCE YET.

**Planning MDDs** (paired binary, α 0.05 two-sided, power 0.8, discordance 0.3):

| Unit | n | MDD (points) |
|---|---|---|
| G2, per form and condition | 100 | 15 |
| G1 | 120 tasks | 14 |
| G3, per surface | 60 | 20 |
| G3, pooled | 120 | 14 |
| G4 | 60 | 20 |
| G6 agent layer | 50 per caller | 22 |

Binding MDDs from `eval/runner/power` go in a dated amendment before any counted cell. A difference smaller than its MDD reads "no measurable difference". Every comparison is reported paired, with its 95% interval and the count of tasks that got worse.

## What each outcome changes

| If it wins (PREDICTIVE) | If it loses (NOT PREDICTIVE) | If inconclusive (NO REFERENCE YET) |
|---|---|---|
| The measure may gate the nightly loop on gbrain master, and its failures go to gbrain's improvement lane with cause counts | It stays report-only; we publish where it diverged from the real brain and fix the generator once (raise the ceiling) before cutting it | It stays report-only until its named reference lands; we say which real probe would settle it |

## Budget

Every paid request reserves its worst case against the budget ledger before it is sent, through the paid-arm guard. The cap is set in the ledger at the paid-window grant. Reaching it pauses the run until the cap is extended; it doesn't end the run incomplete, and the run resumes from its ledger. A smoke runs before any counted cell and measures cost per episode, and the counted window is requested from that number. Dollar amounts stay on the tracking issue (GST-2005).

## Amendments

None yet.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

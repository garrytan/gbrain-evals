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
  - Agent units (G1, G3, G4 and G6): cost per correct answer divides every dollar the episode log records for a model's episodes, errored episodes and earlier attempts of retried ones included, by that model's correct answers.
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
- A measure with more than one layer (a retrieval layer and an agent layer, say) gets a verdict per layer, and each layer is reported. The measure's summary line reads NOT PREDICTIVE if any layer does, otherwise PREDICTIVE if any layer does, otherwise NO REFERENCE YET. Only a layer that reads PREDICTIVE may gate.

**Mapped contrasts and expected verdicts:**
- **G2** maps all 16 success@5 contrasts of `live-recall-b2` (13 qualify), including P1, P2, `configured_vs_hybrid` and the five `paraphrase_vs_exact_*` gaps. Expected: PREDICTIVE if the condition knobs carry the real conditions.
- **Batch 3's own primaries** are fixed here and in the live-recall [batch 3 amendment](live-recall/PREREGISTRATION.md#batch-3-amendment), before its freeze: P1 is `p1_configured_vs_hybrid_lexical_freshness` and P2 is `p2_configured_vs_hybrid_lexical_entity`, both success@5 over both question forms of their type, Holm-adjusted as one family. Batch 2's P1 is replicated as the secondary `batch2_p1_hybrid_vs_hybrid_lexical_paraphrase`. A counted run refuses a freeze from the other visibility epoch (`LR_FREEZE_MISMATCH`).
- **Batch 3's synthetic side.** One synthetic batch-3 brain, built from the G1 freshness and G4 entity worlds and run through the live-recall runner under `--protocol batch3`, gives the synthetic contrasts for G2's batch-3 layer and for the retrieval layers of G1 and G4.
- **G2's batch-3 layer** maps batch 3's three freshness and three entity success@5 contrasts, listed in the next two items.
- **G1's retrieval layer** maps batch 3's three freshness success@5 contrasts: `p1_configured_vs_hybrid_lexical_freshness`, `hybrid_vs_hybrid_lexical_freshness` and `configured_vs_keyword_freshness`. The stale-first rate by arm is reported beside them as a direction check, but it carries no interval and never gates. Expected: NO REFERENCE YET until batch 3 lands, and with three mapped contrasts the measure reaches a verdict only if all three qualify.
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

### 2026-11-09: binding MDDs and the order of counted cells

Both points are fixed before any counted cell.

**Binding MDDs.** `eval/runner/power` has no paired-binary module, so the binding MDDs use the formula the planning
table used: `mdd()` in `eval/runner/live-recall/task-scorecard.ts`, (z(0.975) + z(0.8)) × √(d / n), with two-sided α 0.05,
power 0.8 and discordance d = 0.3. The smoke runs had one or two tasks per cell, too few to estimate discordance, so 0.3
stays. These values replace the planning MDDs:

| Unit | n (pairs) | Binding MDD (points) |
|---|---|---|
| G2, per form and condition | 100 | 15.3 |
| G1 | 120 | 14.0 |
| G3, per surface | 60 | 19.8 |
| G3, pooled | 120 | 14.0 |
| G4 | 60 | 19.8 |
| G6 agent layer, per caller | 50 | 21.7 |

A comparison smaller than its binding MDD reads "no measurable difference". For reference, the same n at d = 0.2 gives
12.5, 11.4, 16.2, 11.4, 16.2 and 17.7 points. Those values are reported but don't bind.

**Order.** G3's and G6's counted agent cells run first. G1's and G4's counted agent cells run only after batch 3's
aggregates exist, as the G1 and G4 item above says.

### 2026-11-09: G3's `two_range_read` pair with phase 2 arm B is not informative

Fixed before any counted G3 cell.

G3's phase 2 layer compared the synthetic refusal rate of each contract cause with phase 2 arm B's, given exposure. Arm
B calls the box's own gbrain `get_page` ([live-recall phase 2 plan](live-recall/PHASE2-PLAN.md), D2), and the box runs
gbrain 0.60.613.0 or later. From 0.60.570.0 on, gbrain reads a `get_page` call with more than one window selector
instead of refusing it (gbrain#8509). So arm B can't produce a `two_range_read` refusal, and its rate is zero whatever
the agents do. The synthetic side runs at this preregistration's pin, 0.60.557.0, where the refusal still exists. The
pair compares two gbrain versions, not the synthetic brain with the real one.

Under the decision rule, a reference of zero never qualifies and can't point the other way, so the pair could never
have counted as agreement or moved the verdict. It would still have sat in the mapped list as a contrast that can only
read as not qualifying, and the gap could be read as a miss of the measure.

So the pair leaves G3's phase 2 layer. The layer maps the other seven causes, `source_changed`, `missing_provenance`,
`ambiguous_entity`, `fact_and_items`, `scope_denied`, `commit_paths_invalid` and `sources_without_brain`, and
still needs 3 of them to qualify (`eval/runner/predictive/mapping.ts`). G3's `two_range_read` tasks run unchanged,
and the results report their refusal rate by surface in G3's cause table, outside the verdict, with this reason. G3's
replay layer (`read_refusal_rate_570_vs_549`) is unchanged and stays the test of this refusal across versions.

### 2026-11-10: G2's conditions, pins and batch-3 size

Fixed before any counted G2 cell, and before batch 3's counted aggregates exist. The build table gave G2 "4 conditions,
2 pins" without naming them; this amendment names them and says which scorecard each verdict is read from.

**Questions.** `eval/generators/conditions-recall-gen.ts` at its defaults (seed 20261109, 20 per type): 100 questions
on 180 pages, question file sha256 `25a7cc094a54f21f907b536abb7ca8fc66fa36afc6f308e5243f0b466830f6f6`, the same file
in every condition. One file of Opus paraphrases (`eval/runner/live-recall/paraphrase-opus.ts`) serves all four
conditions.

**Conditions.** Each knob is set from a measured condition of the real brain, as the evidence class requires:

| Condition | Knobs | Measured condition it copies |
|---|---|---|
| clean | none (generator defaults) | the clean pages our other evals use |
| embedding | `--synopsis-off --unembedded-share 0.1` | 0% synopsis vectors, 10% of chunks with no vector |
| shells | `--shell-share 0.5` | about half of sampled media pages are empty shells |
| real | `--synopsis-off --unembedded-share 0.1 --shell-share 0.5` | both together |

The shell knob applies to every page that isn't gold, so it overstates shells on pages that aren't media. That is a
stated limit of the shells and real conditions.

**The keyword candidate bound is left out.** A keyless calibration at `446b9c14` on the real-condition brain (180
chunks, hash transports) gave identical success@5 for every arm at bounds of 5, 10, 20, 40, 80 and 160 chunks, and no
query reported `keyword_candidates_incomplete`, so at this brain size the bound never bites. Batch 1, the development
reference, recorded it on 57 of 100 `hybrid_lexical` forms. The synthetic brain doesn't reproduce that condition, and
the results say so instead of setting a knob that changes nothing.

**Pins.** Every G2 scorecard runs on Voyage transports (voyage-4 embeddings, tokenmax, rerank-2.5, as
`eval/runner/live-recall/synthetic.ts` sets them), at two gbrain versions loaded through the gbrain-under-test overlay:

- the version the reference itself ran, so that each pair compares the synthetic brain with the real one and not two
  gbrain versions (the reason for the `two_range_read` amendment above): 0.60.593.0 (`27f8b9d6`) for the batch 2
  layer, and 0.60.623.0 (`d253ec0f`) for the batch 3 layer;
- this preregistration's pin, 0.60.557.0 (`62637c96`), for both layers.

**Which scorecard gives each verdict.**

- G2's batch 2 layer reads the **real** condition at 0.60.593.0. The other seven batch-2-shaped scorecards (four
  conditions at two pins, less that one) are reported beside it with their own readings, as secondary results that
  never gate. They show which condition carries the agreement, if any.
- One synthetic batch-3 brain from `eval/generators/batch3-synthetic-gen.ts` at seed 20261110 and `--per-type 30`
  (60 questions, 30 freshness and 30 entity; 30 is the most distinct freshness worlds its pool gives), with Opus
  paraphrases, gives G2's batch 3 layer and the retrieval layers of G1 and G4. Their verdicts read its scorecard at
  0.60.623.0. Its scorecard at 0.60.557.0 is secondary. The batch-3 generator has no condition knobs, so this brain is
  clean.

**Power.** G2's binding MDD per form and condition stays 15.3 points. For the synthetic batch-3 brain the same formula,
over both forms of a type (between 60 forms and 30 questions), gives 19.8 to 28.0 points at discordance 0.3, and 16.2
to 22.9 at 0.2. These bind G1's and G4's retrieval layers and G2's batch 3 layer. The verdict itself reads signs, as
the decision rule says, so these numbers govern only how a difference is described.

### 2026-11-10: corrections to G2's amendment, after one reader

Fixed before any counted G2 cell and before batch 3's counted aggregates exist. One Opus adversarial reader read the
amendment above for verdict integrity: whether its choices were fixed before any output that could inform them, whether
any favours agreement with batch 2's published reference, and whether the calibration it cites supports dropping the
keyword bound. It found the choices themselves clean and the stated reason for dropping the bound wrong. These
corrections take precedence over the amendment above where they differ.

**Why the keyword candidate bound is left out.** This replaces the reason given above; the calibration's facts stand.
The synthetic bound samples only gbrain's all-words keyword match (`eval/runner/live-recall/synthetic.ts`), and on
this brain that match finds at most one chunk per question form: one chunk for 77 exact forms, none for the other 23 and
none for any of the 100 paraphrases. So no bound of 1 or more ever applies. When the all-words match is empty, gbrain
retries with any word matching, and that retry supplies most of the hybrid arms' keyword candidates; the synthetic
bound never touches it. Batch 1 recorded `keyword_candidates_incomplete` on 57 of 100 `hybrid_lexical` forms, 48 of
them paraphrases. As far as the published aggregates show (they record the flag, not its cause), that comes mostly from
the same retry on Postgres, which drops common words using planner statistics and reports the bound. PGLite has no
such path. The synthetic brain therefore can't reproduce the condition at any size, not just at this one. A paid
synthetic run now refuses a directory that sets the bound. The build table's G2 row still lists the keyword bound; it
is not run.

**The engines differ too.** Each pair compares the synthetic brain on PGLite with the real brain on Postgres, even at
the same gbrain version. Without the narrowing above, synthetic `hybrid_lexical` paraphrases may do relatively
better than real ones, which pushes P1 and P2 (both measured against `hybrid_lexical` paraphrases) toward
disagreement, not agreement. This is a stated limit of every G2 condition.

**Shells in numbers.** The brain has 180 pages, 110 of them gold. The shells and real conditions turn 35 of the 70
pages that aren't gold into shells, which is 19% of all pages. The real brain's measured half applies to media pages.

**Question files.** The sha256 named above, `25a7cc09…6f6`, is the generator's template file. Counted runs apply
one Opus paraphrase file to it, which rewrites `questions.jsonl`. Each scorecard records the counted file's
`questions_sha256` and the paraphrase file it used, and all eight batch-2-shaped scorecards must carry the same
values. The synthetic batch-3 brain's template file is
`bd574fd1b7bdb666417c6ae45bdb3746bb498e144dfb28e15641a017463f2324` (directory digest
`dcc97ed9eefdf404af9324853d3d42502b8d0b509b78968cebe2d85fd0b6865e`), and its counted file is that file with its own Opus
paraphrase file applied.

**Batch 3's version.** For the batch 3 layers, "the version the reference itself ran" means the version batch 3's freeze
records, 0.60.623.0. If batch 3's counted scorecard loads another gbrain version, the synthetic batch-3 brain is run
again at that version, and that scorecard gives the verdict.

**Earlier synthetic output.** GBEV-55's uncounted Voyage smoke probes ran on 2026-11-09, before the amendment above: 100
batch-2-shaped questions twice and 40 batch-3-shaped questions once. Their knobs and results weren't available to the
amendment's author, and none is counted. The author saw only keyless hash-transport control runs, all made before the
amendment, and they show the same sign pattern against batch 2 at 0.60.557.0 and 0.60.593.0.

**Binding MDD for the synthetic batch-3 brain.** The upper end binds, to be conservative: 28.0 points at discordance
0.3. A difference below it reads "no measurable difference" and is reported with its interval.

**Which scorecard gives each verdict, enforced.** Before any counted verdict runs, `eval/runner/predictive/verdict.ts`
will refuse a non-control scorecard whose gbrain commit, knobs or question file differs from the one named for the layer,
and will copy those fields and the scorecard's sha256 into `verdict.json`. G2's summary line combines the verdict
files of its batch 2 and batch 3 layers under the decision rule (NOT PREDICTIVE if either layer is).

### 2026-11-10: batch 3 moves to gbrain 0.60.641.0

The live-recall preregistration's
[amendment of the same date](live-recall/PREREGISTRATION.md#2026-11-10-batch-3-runs-on-gbrain-0606410) moves batch 3's
counted run to gbrain 0.60.641.0 (`2560ffdd`), because its first attempt stopped with `LR_SCHEMA_MISMATCH` before any
search. Under "Batch 3's version" above, the synthetic batch-3 brain is run again at 0.60.641.0, with the same template
file, paraphrase file and Voyage transports. That scorecard gives the verdicts for G2's batch 3 layer and for G1's and
G4's retrieval layers. The synthetic brain's scorecard at 0.60.623.0, made before this amendment, is reported beside it
as a secondary result that never gates, like the one at 0.60.557.0. Nothing else here changes. G1's and G4's counted
agent cells still wait for batch 3's aggregates.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

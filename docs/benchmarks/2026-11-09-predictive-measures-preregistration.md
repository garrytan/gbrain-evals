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

### 2026-11-10: batch 3's timing

The live-recall preregistration's
[amendment of the same date](live-recall/PREREGISTRATION.md#2026-11-10-batch-3-runs-after-relabel-window-1-before-window-2)
runs batch 3 after relabel window 1 (961 pages applied, 39 declined) and before window 2, instead of after the last
window. Nothing else here changes: the runner, gbrain 0.60.641.0, the question file and freeze, and the synthetic
batch-3 scorecard at 0.60.641.0 that gives the verdicts. It is batch 3's one counted run. With about 2% of the relabel
applied, gold hidden by labels the relabel hasn't reached is missed by every arm alike, which can leave a layer short of
three qualifying contrasts. A layer that reads NO REFERENCE YET for that reason says so in the results.

### 2026-11-10: how G5 runs

Fixed before any G5 cell runs. G5 reads NO REFERENCE YET whatever it measures (the decision rule above), so its numbers
are descriptive. This fixes what it measures.

**Search configuration.** The build table asks for the real search configuration. The runner as merged wrote no search
setting, so its brain resolved gbrain's defaults (mode `balanced`, reranker `voyage:rerank-3-lite`). It now writes the
setting live-recall batch 2's counted scorecard records for the real brain, mode `tokenmax` and reranker
`voyage:rerank-2.5`, and each scorecard records what gbrain resolved. Embedding and rerank calls stay in-process, so
no provider time is in any G5 number. G5 therefore compares gbrain versions on local compute only, and it can't predict
the latency a user feels.

**One brain, two versions.** One brain of 300,000 pages (seed 55) is built once at 0.60.549.0 (`a131fb20`); 0.60.549.0 and
0.60.570.0 open the same schema. Each probe runs on its own copy of that brain, made with `CREATE DATABASE … TEMPLATE`,
because a probe writes to the brain it times. A keyless rehearsal at 30,000 pages showed why: a second probe on the same
database failed every one of its remember calls and slowed sync, because the first probe's side repository was gone.
On fresh copies every remember succeeded.

**Order and noise.** The probes run at 0.60.549.0, then 0.60.570.0, then 0.60.549.0 again, each with 200 timed calls per
operation after 3 warm-up calls and 30 syncs. The first two give the three contrasts (p95 of query, search and get at
0.60.549.0 against 0.60.570.0). The repeat shows how far two identical probes differ, and it is reported beside them. A
contrast smaller than that difference for its operation is reported as no difference, within run-to-run noise. If the
time limit ends the run before the repeat probe finishes, the results name the missing probe and give the contrasts with
no noise estimate.

**The knob is not run.** The build table lists "one knob" as a variable, but no knob was named before the freeze, and
choosing one now, after seeing keyless latencies, would be a choice made from results. No mapped contrast uses a knob.

**Machine.** One Ubicloud standard-16 VM (16 vCPUs, 64 GB) in `eu-central-h1`, Postgres 16 with pgvector and the settings
in `vm-setup.sh`, with a 12-hour time limit. The VM is destroyed when the run ends.

### 2026-11-11: G2's held-out replication on batch 4

Fixed before any batch 4 question exists. Wintermute is asked for batch 4 only after this amendment is on main, and
batch 4's freeze and counted run use gbrain-evals at this amendment's merge commit. The results record that commit and
its time, and commit batch 4's counted scorecard at `docs/benchmarks/live-recall-batch4/b4-scorecard.json`
(`B4_SCORECARD` in `eval/runner/predictive/export-references.ts`), the one path the reference export reads as
`live-recall-b4`; until a counted batch4 scorecard is there, the `b4` layer reads NO_REFERENCE_YET.

**Why.** G2's batch 2 layer reads PREDICTIVE, and its counted condition copies the real brain's gaps. But the condition
was named on 2026-11-10, after batch 2's results were committed on 2026-11-07, so its prediction that paraphrases are
found less often than exact forms was never tested on questions it hadn't seen. The 13 qualifying contrasts also share
batch 2's 50 questions, so they are not 13 independent checks. The [results](2026-11-10-predictive-measures.md) say
both, and read that prediction as pending. This amendment tests it once, on a fourth question set, with every choice
below fixed first.

**What the outcome can show.** HELD is the expected result. Batches 1 to 3 measured configured search's paraphrase gap
at −28, −40 and −44 points, and the primary below is that gap's sign. So HELD shows that the direction the gap-copied
brain predicts holds on questions it hasn't seen, and that the clean brain, which predicts no gap, misses it. It shows
the direction only: the copy predicts a gap a quarter to a sixth of the size batches 1 to 3 measured. The size is
tested as a frozen secondary, the ratio below. A NOT HELD or INCONCLUSIVE result would be the surprise.

**The synthetic side is frozen as counted.** The prediction is G2's counted scorecard for batch 2, unchanged:
`docs/benchmarks/predictive-measures/g2/real-593/scorecard.json` (sha256
`9c46cada069b756cb7bba8eaee5a2727c5a1230a1a5cff23bf93c74cd30d0264`): the real condition (synopsis vectors off, 10% of
chunks unembedded, half the pages that aren't gold as shells), gbrain 0.60.593.0 (`27f8b9d6`), Voyage transports,
question file `077569d7…2e89`, directory digest `6b3791fe…3551`. No synthetic run is made for the verdict. The
five search setups are batch 2's arms: `keyword`, `vector`, `hybrid_lexical`, `hybrid` and `configured`, with
`configured_window` read only through `window_vs_configured`.

**Predicted signs.** Each contrast's predicted sign is the sign of the counted scorecard's success@5 estimate (B minus
A, 95% question-clustered interval):

| Contrast | Synthetic estimate (95% interval) | Predicted sign |
|---|---|---|
| `p1_hybrid_vs_hybrid_lexical_paraphrase` | +0.31 (+0.20 to +0.42) | + |
| `p2_configured_vs_hybrid_lexical_paraphrase` | +0.32 (+0.21 to +0.43) | + |
| `batch1_p1_hybrid_vs_hybrid_lexical` | +0.11 (+0.035 to +0.18) | + |
| `hybrid_lexical_vs_keyword` | +0.405 (+0.345 to +0.465) | + |
| `hybrid_vs_keyword` | +0.515 (+0.445 to +0.585) | + |
| `configured_vs_keyword_paraphrase` | +0.90 (+0.84 to +0.95) | + |
| `configured_vs_hybrid` | +0.035 (+0.015 to +0.06) | + |
| `vector_vs_keyword` | +0.51 (+0.435 to +0.58) | + |
| `configured_vs_keyword_exact` | +0.20 (+0.13 to +0.28) | + |
| `hybrid_vs_keyword_paraphrase` | +0.89 (+0.83 to +0.95) | + |
| `window_vs_configured` | 0 (0 to 0) | none |
| `paraphrase_vs_exact_keyword` | −0.77 (−0.85 to −0.69) | − |
| `paraphrase_vs_exact_vector` | −0.01 (−0.03 to 0) | − |
| `paraphrase_vs_exact_hybrid_lexical` | −0.42 (−0.52 to −0.32) | − |
| `paraphrase_vs_exact_hybrid` | −0.02 (−0.05 to 0) | − |
| `paraphrase_vs_exact_configured` | −0.07 (−0.12 to −0.03) | − |

Under the decision rule, a qualifying contrast with no predicted sign counts as a disagreement, so
`window_vs_configured` fails the layer if batch 4 makes it qualify.

**Primary.** `paraphrase_vs_exact_configured` on batch 4: configured search on paraphrases minus on exact forms, one
pair per question, read on its own 95% question-clustered interval. It is the setup people use, and the only
paraphrase contrast where the gap-copied brain and the clean brain point differently with a synthetic interval that
excludes zero (clean: 0, from 0 to 0). The keyword and `hybrid_lexical` gaps are negative in both brains, and the
vector and hybrid gaps include zero in both.

**The family, read together.** All 16 contrasts form G2's batch 4 layer (`b4` in `eval/runner/predictive/mapping.ts`).
A contrast qualifies when its simultaneous 95% band excludes zero. The band comes from one bootstrap that resamples
batch 4's questions within each of the five question types (seed 20261106, 10,000 draws), recomputes all 16 contrasts on
each draw from their own questions, scales each by its own bootstrap standard error, and takes the 95th percentile of
the largest scaled deviation as the shared critical value (`simultaneousBand` in `eval/runner/stats/paired.ts`).
Because every draw keeps the contrasts' shared questions together, the 16 bands cover together at about 95%, and
correlated contrasts count for less than independent ones. Resampling within types keeps `window_vs_configured`, which
only time_window questions carry, in every draw. The runner computes the band on Wintermute's box under
`--protocol batch4` and sends it as `family_ci95` beside each contrast's own interval. Fixed details:

- That max-t critical value sets every band; Bonferroni's for the same contrasts is recorded beside it and not used.
  Bands are symmetric about the estimate and aren't clipped, which can't change whether one excludes zero.
- A contrast with no variation in any draw keeps a zero-width band at its estimate, so it qualifies when the estimate
  isn't zero. A contrast with no questions in some draw gets no band (`family_ci95` null) and can't qualify. No band
  carries a non-finite number.
- A contrast the scorecard skips, because an arm is invalid, can't qualify and is listed. A skipped primary makes the
  outcome INCONCLUSIVE.
- At least 3 contrasts must qualify, not counting the three whose sign keyword search forces by finding almost no
  paraphrases on either brain (`configured_vs_keyword_paraphrase`, `hybrid_vs_keyword_paraphrase`,
  `paraphrase_vs_exact_keyword`). The results give the count both ways.
- The layer reads PREDICTIVE when every qualifying contrast matches its predicted sign, and NOT PREDICTIVE when one
  doesn't. A contrast whose band includes zero is no evidence either way, so in this layer it can't disagree, whatever
  the synthetic interval says.

**Pass rule.** From the primary alone, fixed in `primaryOutcome` in `eval/runner/predictive/validity.ts`:

- **HELD**: the primary's 95% interval lies wholly below zero.
- **NOT HELD**: it lies wholly above zero.
- **INCONCLUSIVE**: it includes zero, or the scorecard skipped the primary.

The `b4` layer's verdict is reported beside the outcome and doesn't enter it, so a side contrast that changes sign by
chance can't decide whether the paraphrase gap held. The layer still counts in G2's summary line under the decision
rule. The rule reads signs, as G2's claim does: the gap-copied brain predicts a configured gap of 7 points, and batches
1 to 3 measured 28, 40 and 44.

**What each outcome changes.**

| HELD | NOT HELD | INCONCLUSIVE |
|---|---|---|
| The paraphrase-gap prediction counts as held out for its direction. Only then may G2 gate as a paraphrase detector, and only on the gap's direction; a gate on its size needs the ratio below to be stable | The results say so plainly, the paraphrase-gap claim is withdrawn, and the generator gets one "Why null?" cycle (did the copied conditions still describe the brain, were there enough questions) before any cut | The prediction stays pending, and the results name the batch that would settle it |

**Smallest detectable difference** (two-sided 0.05, 80% power), in points, at batch 4's planned size of 50 questions:

| Comparison | 20% discordant | 30% discordant | 40% discordant | 50% discordant |
|---|---|---|---|---|
| Primary, on its own interval (50 pairs) | 17.7 | 21.7 | 25.1 | 28.0 |
| A one-form contrast on the family band (50 pairs, critical value 2.955) | 24.0 | 29.4 | 34.0 | 38.0 |
| A both-forms contrast on the family band (forms independent to fully correlated) | 17.0 to 24.0 | 20.8 to 29.4 | 24.0 to 34.0 | 26.8 to 38.0 |

Batch 2's primary had 48% discordant pairs (24 of 50), where the MDD is 27.4 points.

The family band's critical value usually lies between 1.96 and Bonferroni's 2.955 for 16 contrasts. A max-t bootstrap
isn't bounded by Bonferroni's normal value, so it can exceed 2.955 when a contrast has very few discordant pairs; the
table assumes 2.955. Batches 1 to 3 measured configured gaps of 28 to 44 points, all above the primary's MDD. On batch
2, 13 contrasts had intervals that excluded zero; widening each interval to a critical value of 2.955 (1.51 times its
half-width) leaves 12, so batch 2's effects would have cleared the band.

**Held out.** Batch 4 is written the way batch 2 was (live-recall [batch 2
amendment](live-recall/PREREGISTRATION.md#batch-2-amendment)): 50 new questions, 10 of each of the five live types,
each with an exact and a paraphrased form, gold chosen page first from a new seeded sample. None may share a question
id, a form or a gold page with batches 1 to 3. `run.ts freeze --protocol batch4` takes the three earlier question files
with `--prior`, checks their sha256 against the frozen ones (`88eaa30c…`, `dd69701c…`, `c023694e…`), and refuses
with `LR_FREEZE_OVERLAP` if any new question id matches an earlier one, any form matches an earlier form after folding
case, spacing and punctuation, or any gold page was an earlier gold, stale or decoy page. The freeze records the gbrain
version and the GBRA-398 visibility epoch as batch 3's does, and a counted batch 4 run refuses a freeze from the other
epoch, or one without a clean check (`LR_FREEZE_MISMATCH`).

**gbrain version.** Batch 4 measures the gbrain Wintermute's box runs at its freeze. The synthetic side stays at
0.60.593.0, so the prediction crosses gbrain versions, and the results say which versions they compare. Batch 3's
counted run stopped once with `LR_SCHEMA_MISMATCH` after the box upgraded between freeze and run, and needed an
amendment. For batch 4 that case is fixed now: the counted run loads the gbrain the box runs at run time if its
visibility epoch matches the freeze's, and both versions are recorded. After an `LR_SCHEMA_MISMATCH` it is rerun once
under this rule, with no new amendment. There is one counted run. Wintermute also reports which GBRA-398 relabel
windows had been applied at the freeze and at the run.

**The size, as a frozen secondary** (GBEV-3 at the plan gate). The ratio of the synthetic gap to batch 4's real gap on
the primary, with a 95% Fieller interval for the ratio of two independent estimates, each standard error read from its
95% interval as width over 3.92 (`fiellerRatio` in `eval/runner/stats/paired.ts`, in verdict.ts's primary block).
On batch 2 it is 0.175 (0.060 to 0.357). The results call the underestimate stable if batch 4's interval contains 0.175,
and not stable if it doesn't. A stable ratio is a number a nightly gate could calibrate on; an unstable one means it
can't. The ratio never changes the outcome.

**Other secondaries** (reported, never gating):

- The `b4` layer's verdict, with the qualifying count with and without the three sign-forced contrasts.
- The clean brain's reading of batch 4: `verdict.ts --secondary` on `g2/secondary/clean-593/scorecard.json`.
- Batch 4's own live-recall P1 and P2, batch 2's primaries replicated on new questions (live-recall [batch 4
  amendment](live-recall/PREREGISTRATION.md#batch-4-amendment)).
- The configured gap's size beside the synthetic estimate.
- Kendall tau-b over the arms (below).
- The real brain's embedding coverage at batch 4's freeze (unembedded chunk share, synopsis coverage, shell page share),
  as aggregates Wintermute counts on the box and states how it counted, reported beside the knobs' measured values to
  show whether the copied conditions still describe the brain. They are descriptive and can't change the outcome.
- The same synthetic brain run again at batch 4's gbrain version, only if a paid window is granted for it. It is
  descriptive whatever it shows.

**Tau-b.** `verdict.ts` counted a tie as a disagreement: on batch 2 the counted brain's paraphrase rates tie
`vector` and `hybrid` at 89%, and the ordering broke the tie against the real brain's order. It now reports Kendall's
tau-b from each arm's success@5 on both sides, which counts ties as ties: 0.600 exact and 0.949 paraphrase on batch 2,
where #419's verdict file reads 0.600 and 0.800. Tau is reported and never gates, so no verdict changes. The published
verdict files stay as written.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

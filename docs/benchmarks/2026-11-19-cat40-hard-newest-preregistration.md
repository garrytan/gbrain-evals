# Preregistration: does gbrain still beat plain files on hard company questions at its newest release? (Cat 40 Hard, newest build)

Written 2026-11-19. The world seeds were named in this file's first pushed commit (`a4d8a846d`), before any world was generated. The file freezes when its pull request merges, before the first paid request. Values that don't exist yet (the gbrain release and commit, the harness commit, the world digests, the judge check's result, the ledger run ids) are appended under "Recorded before cells" before the first counted cell. Any other change after that commit is a dated amendment at the end, never an edit.

## Question

README shows two rows for hard company questions: gbrain against an agent that reads plain Markdown files with grep, on a made-up company of about 55,000 documents. Both were measured on mid-October gbrain builds:

- **Row 1** ([October 10 confirmation](2026-10-10-model-ladder-hard-confirmation.md), gbrain `3e4ff61ce`): fresh world M, 78.7% against 71.0% (+7.7 points, 95% interval +2.7 to +12.7); sealed world S, +13.0 (+7.7 to +18.3).
- **Row 2** ([October 15 next confirmation](2026-10-15-cat40-next-confirm/README.md), gbrain `4e10136b4`): sealed worlds S1 and S2, +10.67 (+7.00 to +14.50); public worlds P1 and P2, +12.50 (+9.17 to +15.83).

Since then gbrain changed four things these tasks lean on, each reaching every question family and each able to move the lead either way:

1. **Fewer search options shown to agents** (gbrain#7481, v0.60.452.0), and **hidden options refused** with `param_not_on_surface` (gbrain#9695, v0.60.740.0). `snippet_chars`, `mode` and `token_budget` are hidden. In row 1's committed tool calls on world M, agents set `snippet_chars` in 1,845 of 3,169 searches, chose keyword mode 2,139 times and set `token_budget` 497 times.
2. **At most 3 meaning-only pages per remote search** that passes no `limit` (gbrain#7598, v0.60.506.0). 646 of row 1's 1,030 hybrid searches set no limit.
3. **Email and meeting text fenced as quoted source** (gbrain#7601, v0.60.507.0; gbrain#8066, v0.60.521.0). Emails and meetings are about two thirds of a world's documents.
4. **Keyword results keep one chunk per page** (gbrain#7201, v0.60.338.0), so a keyword list names more distinct pages.

Smaller changes on the same path: the rare-word retry and short-name title variants (gbrain#7472), the default reranker moving from `rerank-2.5` to `rerank-3-lite` (v0.60.228.0), saved-facts changes (gbrain#7284, #7744, #7938, #9524), entity name variants (gbrain#7195) and edits to the server instructions. No change since row 2 aims at family H4, "sources disagree", where gbrain is weakest (row 1 world M: 47 against 56 of 60).

**The question:** on two fresh worlds from the public generator, at gbrain's newest release on shipping defaults, what is gbrain's lead over files, paired by task, and is it still within the smallest detectable difference of the published rows? The answer decides what README's two rows say, whether gbrain's maintainers get a regression report naming changes 1 to 3, and whether H4 goes to them as the one family no change has aimed at.

## Public lesson

- If the lead holds: "We learned that gbrain's lead over grep on hard company questions held at its newest release (+X points on two fresh worlds), after it hid search options agents used to set. You should expect a memory index to keep helping agents on large, messy document sets even as its tool surface gets smaller."
- If the lead drops: "We learned that gbrain's lead over grep fell from +12.5 to +X points between its October and November builds, mostly in <families>. You should re-measure an agent's memory tool when its search options change, because agents lean on the options they are shown."
- For H4, whatever the overall result: "We learned whether gbrain still trails or ties plain files when sources disagree (H4: +X points). You should <check governing documents yourself / rely on gbrain's ordering> for questions where documents conflict."

## Evidence class

Held-out confirmation on two worlds minted for this run from the public generator. The generator and its frozen settings are public, and gbrain's maintainers could have tuned against its output, so these worlds compare in kind with row 1's world M (+7.7) and row 2's public half (+12.50), not with the sealed halves (+13.0, +10.67). README will say so. World M is the nightly check's development set and P1 and P2 are published, so neither is reused.

## Build and data

- **gbrain build.** The newest release on gbrain's master at launch: the highest version tag merged into master, read with `git ls-remote --tags https://github.com/garrytan/gbrain.git` (v0.60.742.0 when this file was written). It is pinned with `bun eval/runner/gbrain-pin.ts bump` in a dated commit on the results branch. The tags are re-read immediately before the first slot build, and a newer release moves the pin by dated amendment before that build. The build then freezes for this experiment: the five prebuilt brains per world are built by it, so the first slot build is the first counted gbrain run. The results record the release, its commit and the commit the slots were built from.
- **Settings.** gbrain's shipping defaults, with no `--gbrain-config` and no build config. Row 2's two extra settings (`entity.record_types=contract,amendment` and `search.long_page_unit=section`) are left out: they gained nothing over row 2's baseline on sealed worlds (-1.17 points, -4.33 to +2.00), and readers install gbrain on defaults. The config readback and the served instructions' and tools' hashes are recorded per world.
- **Harness.** The gbrain-evals commit that carries the pin, the seed registration, the reader change, the particle-1 change and the accepted drift (below), recorded before cells. Frozen Hard files that changed since `freeze.json` are listed with their hashes and a dated note in [accepted-drift.json](cat40-hard/accepted-drift.json) and calibration.md, and the counted runs pass `--accept-freeze-drift`. The world-shaping code is unchanged.
- **Worlds.** Generator `model-ladder-hard-v2`, `--scale large`, the frozen knobs ([knobs.frozen.json](cat40-hard/knobs.frozen.json)), 100 tasks per world (20 per family, H1 to H5), generated with the same three commands as P1 and P2 (October 15 preregistration, "Public generator"): the 4k base, the 50k world on that base, and the validation (`checkHardWorld` plus `hardWorldDigest`).
- **Seeds, named before any generation: N1 = 20261141 and N2 = 20261151.** If a seed fails the generator's own checks, that seed plus 1,000 is used (20262141, 20262151), as for P1 and P2, and the failure is reported as a count. **What happened:** N1 = 20261141 generated and validated. N2's seed 20261151 failed the generator's H3 look-alike checks at the 4k base (2 failures), and so did its fallback 20262151 (1 failure); no file was written either time. The next seed in the same steps of 1,000, 20263151, generated and validated, and it is N2. That third seed was tried before this sentence was written; no other seed was tried, and only pass or fail was read. The seeds are registered in `HARD_SEEDS` on the results branch. The digests, document counts and H4 variant counts of both worlds are recorded below before any slot is built. Only counts, variants and hashes are read; no task or document text is opened before the results.

## Arms

| Arm | What the agent gets | Role |
|---|---|---|
| `gbrain` | gbrain over MCP on its default tool list, from one of five prebuilt brains per world (OpenAI `text-embedding-3-large` embeddings; Voyage reranks), with the server's instructions | system under test |
| `fs` | `list_dir`, `grep` and `read_file` over the same documents as Markdown files, on row 1's "hard" tool limits (`--hard-tool-limits hard`) | comparator |
| `oracle` | the documents each task's answer key names, in the prompt | ceiling check only, never in an endpoint |

Fixed for every arm: the 16-turn cap, 5 gbrain slots per world, concurrency 10, repeat 1, `--transcripts`, every task in each world, and every setting not named here equal to row 2. The files arm reruns rather than reusing stored rows: its agent loop changed since row 1, and stored rows can't pair with new worlds.

## Readers and judges

- **Readers:** `claude-opus-5-5` and `gpt-6.2-sol` (the newest frontier Opus and GPT), and `particle-1` (the primary low-cost model). Sonnet 5.5 is dropped under the repository's model rules. Opus 5.5 is the only reader shared with the published rows, so it is the bridge to them. Opus and GPT-6.2 Sol run at their provider default effort, as row 1 and row 2 did, so their requests keep the published shape. particle-1 is sent `reasoning_effort: high` with a 16,000-token output limit, and the receipt records the effort sent and effective, the limit and the weight version. The runner's guard that keeps particle-1 off Hard worlds is lifted by a dated commit on the results branch with its drift entry, because this preregistration lists it.
- **Model freshness** (`bun scripts/model-freshness.ts`) runs on the day of the first counted cell. A newer frontier Opus or GPT stops the run until a dated amendment names it.
- **Claims judge** (`cat40-hard-claims-v1`, unchanged). It lists each factual claim in an answer and marks it supported, contradicted or unsupported. It never decides success, which the deterministic scorer (`cat40-hard-score-v2`) does. The protocol judge, `gpt-6.1-sol`, grades the Claude and particle-1 rows. `claude-opus-5-5` grades the GPT-6.2 Sol rows, so no family judges its own rows. particle-1 never judges. The protocol judge is kept unchanged so the claim counts compare with rows 1 and 2; it is an older GPT generation than the reader under test and grades no GPT rows.
- **Judge check (before any counted cell).** Both judges grade at least 60 constructed answers on world M's tasks (public, the nightly's development set): 30 good answers that state each task's accepted value with its governing documents, and 30 bad ones that state a value the task lists as wrong, add an entity outside an H1 set, change an H1 count, or attribute a value to the wrong account. Items are stratified by family, 12 per family, and the construction label is the reference. A judge passes when its Cohen's kappa against the labels, reading "at least one contradicted or unsupported claim" as bad, is at least 0.6, with at least 15 items in each class graded and at most 1% of its outputs unparseable. Both judges also grade 40 real answers from row 1's committed world M cells, and their agreement with each other and with row 1's recorded judgments is reported, descriptive only. A judge that fails is reported, and the claim-based secondary endpoints for the rows it grades are shown as descriptive, not counted; the success endpoints don't use a judge and are unaffected.

## Metric and denominator

- **Primary metric: success**, from the deterministic scorer: the answer names an accepted value and no listed wrong value; sets match exactly; counts match; H5 is scored on the final session; multi-account answers need every item right. The denominator is every task in both worlds: 200 tasks per arm and reader.
- **Canonical cell:** the last harness-clean attempt per arm, reader and task. Only harness errors (a provider 5xx or 429 after backoff, or a slot, server, restore or MCP transport failure) are retried, at most twice per cell. A turn-cap stop, no tool call, malformed tool use, a context-length error or a provider safety-filter stop counts as a failure. Safety-filter stops are also reported on their own line. A cell with no harness-clean attempt after its retries is resumed by the same step command, never counted as a failure, and the analysis refuses to compute an endpoint while any planned cell is missing.
- **Unit and clusters:** the task. Every interval is the October 15 preregistration's nested task bootstrap: 10,000 resamples from one `random.Random(1)` stream, tasks nested in worlds and worlds held fixed; each resample visits N1 then N2 and draws 100 task ids with replacement (`rng.choice` over the world's task ids sorted as strings); a drawn task brings every reader's cells of both arms; the interval is the 2.5th and 97.5th percentiles. The interval is conditional on these two worlds.
- **Secondary, reported with the same bootstrap:** per family (H4 always reported as its own family, with its interval, and split by its `+long` variants); per reader; per world; wrong-value rate (`said_wrong`), wrong submissions, non-submission and turn-cap stops; the claim judge's unsupported and contradicted claims per answer; and, from the transcripts, `param_not_on_surface` refusals per reader, searches by mode, searches with no `limit`, and empty searches. The first table shows claude-opus-5-5 and particle-1 with cost per correct answer.

## Decision rule

- **Headline:** Δ = gbrain success minus files success, paired by task, averaged over the two frontier readers (Opus 5.5 and GPT-6.2 Sol) on all 200 tasks, with its 95% interval. One row per reader follows. particle-1's Δ is reported with its interval and is not pooled into the headline. Wording as in row 1, with one added case: "ahead" only when the lower bound is above 0; "behind" when the upper bound is below 0; "parity" only when the lower bound is above -3 points and the upper bound is not below 0; otherwise "not distinguishable", with the point estimate.
- **Smallest detectable difference** (two-sided α 0.05, 80% power, 2.8 standard errors), estimated before any cell from row 1's committed world M cells for Opus 5.5 and GPT-6.1 Sol (task-bootstrap standard error of the paired Δ, scaled to 200 tasks) and from the published intervals:

| Comparison | Detectable difference |
|---|---:|
| Δ against 0, two frontier readers pooled | 5.4 points |
| Δ against 0, Opus 5.5 alone | 8.8 points |
| Δ against row 2's public half (+12.50), unpaired | 7.2 points |
| Δ against row 1's world M (+7.7), unpaired | 8.9 points |
| One family against 0, readers pooled (40 tasks) | 8.4 to 12.8 points; H4 9.6 |

- **Comparison with the published rows.** Different worlds can't be paired by task, so these are unpaired. The lead **holds** when Δ is at least 12.50 - 7.2 = **+5.3** (within the detectable difference of both published fresh-world and public leads). It **drops** when Δ is below +5.3. It **rises** when Δ is above 7.7 + 8.9 = **+16.6**. The comparison is also shown for Opus 5.5 alone against Opus's own published leads, descriptive. Row 2's public half was measured with Sonnet 5.5 and GPT-6.1 Sol as the other readers, and with F5 and two extra settings on; its baseline build on defaults scored +8.50 (+4.83 to +12.33), shown beside it.
- **Which wording applies.** The interval wording against 0 (ahead, behind, parity, not distinguishable) is decided first and always printed. The comparison with the published rows (holds, drops, rises) is decided second and printed beside it. When Δ is not distinguishable from 0, that row of the outcome table applies whatever the comparison says; otherwise the comparison's row applies. A "behind" result is below +5.3, so it takes the lead-drops row, and README says gbrain is behind files on these questions, never "no measurable difference".
- **H4:** H4 is "level or behind" when its pooled Δ's lower bound is at or below 0.
- **Multiplicity.** One primary comparison; families, readers and worlds are secondary and are reported without correction, labelled as such.

## What each outcome changes

| Result | Then |
|---|---|
| The lead holds (Δ at least +5.3) | README's two hard-company rows are replaced by this measurement, naming gbrain's release and commit, with the note that the new worlds compare with world M and the public half, not the sealed halves. The sealed numbers stay in their dated reports and README's changelog |
| The lead rises (Δ above +16.6) | The same replacement, and README says the lead grew, with both numbers and builds. The per-family split goes to gbrain's maintainers as evidence of which change helped |
| The lead drops (Δ below +5.3) | The drop is published plainly in README with both builds. Readers, the files agent's loop, settings and worlds all changed with the build, and the comparison is unpaired, so public text and the report to gbrain's maintainers name changes 1 to 3 as untested suspects, not causes. The maintainers get the per-family split and the tool-call statistics. An old-build control on the same harness and worlds, gbrain `09d21554d` (row 2's baseline build, before changes 1 to 4) on Opus 5.5 and GPT-6.2 Sol, is proposed as its own paid run; it is not part of this run and runs only after separate approval, under its own dated amendment |
| Δ is not distinguishable from 0 | Published as no measurable difference at this sample size, and README stops saying gbrain beats files on these questions until a new measurement shows it |
| H4 is level or behind | It goes to gbrain's maintainers as the one family no change since row 2 has aimed at, with its per-reader rows |
| H4 is ahead | README's known-limits line for H4 changes to say so, with the interval |
| particle-1's oracle success is below 90% on either world | particle-1's gbrain and files rows are reported, labelled as limited by the reader rather than by memory |

## Gates before counted cells (per world)

1. The world validates against its generator, and its digest equals the one recorded below.
2. The judge check above has run, and its result is recorded below.
3. Every slot passes the write, restore and fail-closed rerank probes, with 0 queued persistence effects at snapshot, and the config readback shows shipping defaults.
4. Oracle on all 100 tasks with Opus 5.5 and GPT-6.2 Sol: pooled success at least 95% of those 200 cells. Below that, no counted cell runs on that world, and the result is reported. particle-1's oracle cells run too and are descriptive.
5. A five-cell gbrain smoke per reader halts on any harness error.
6. Model freshness passes on the day of the first counted cell.
7. Both worlds' slots are built from the same gbrain commit: world N2's slots use the commit world N1's slot receipt recorded, and both receipts must name it before any counted cell.

## Budget

Each world runs on its own Ubicloud VM, detached, with one budget ledger per VM and one writer. Every request is reserved against that ledger before it is sent (`eval/runner/budget-ledger.ts`), and every step passes its own `--budget-usd`. A cap is set in each ledger; reaching it pauses the run at the cell boundary until the cap is extended, and the same step command resumes it with a new budget run sized to the missing cells. It never ends the test incomplete. Every particle-1 cell, oracle and counted, runs inside one granted paid window, one world at a time, after that world's frontier cells, so Particle's spend reconciles against a single ledger with no other traffic on its key. The frontier cells on the two VMs share provider keys, so each VM's concurrency is lowered if rate-limit retries rise. The VMs are destroyed when their runs end. Dollar amounts stay in the tracking issue.

## Known limitations

- Two worlds can't estimate between-world variance; intervals are conditional on N1 and N2.
- The published comparisons are unpaired and their reader sets differ (Sonnet 5.5 and GPT-6.1 Sol then, GPT-6.2 Sol now). Opus 5.5 is the only shared reader.
- Row 2's public half ran with F5 and two extra settings on; this run uses shipping defaults.
- The public generator is public, so these worlds are confirmation in kind with the public rows only.
- The detectable differences are estimates from row 1's world M cells and the published intervals.
- particle-1 has never run on Hard worlds; its context fit on 55,000-document worlds is unmeasured, and context-length errors count as failures.

## Recorded before cells

**Worlds** (generated 2026-11-19 at gbrain-evals `ef3200db0`, knob digest `37a16085…`; only counts, variants and hashes were read):

| World | Seed | 4k base digest | 50k world digest | `world.json` file SHA-256 | Docs | Tasks | H4 tasks with `+long` | H4 items (`+long`) |
|---|---|---|---|---|---|---|---|---|
| N1 | 20261141 | `d8aa9af4b181fcfb4ce0c5126f408105af3d7f871b728ae07e6f6b06760fb6a7` | `647d6123621842a5b43ec7291e94b440e18bd03bb0209f6b94c46d36cd5f52ac` | `364c578a0986492483d56d161cf0f7f89afb330f70d3c2d6a2c9e8cf4e80e937` | 55,736 | 100 | 15/20 | 70 (29) |
| N2 | 20263151 | `aff8bee3f4c08eb8cc920dec3067e5115f971f73aeeda2040656bcf8bc27cd45` | `08120edcd14f7151ef2f785d1e62ec40639ede8fc28c49924c846b28262e3814` | `97e791d9bc693de1b06be962de679743b1459916872ac093f23162e0cfddd072` | 55,383 | 100 | 18/20 | 72 (33) |
| P1 (reference) | 20262041 | `e5cbde0b…` | `7485a765…` | `d30ea091…` | 55,916 | 100 | 19/20 | 68 (30) |
| P2 (reference) | 20262051 | `06e22629…` | `885b294f…` | `6a57f0ff…` | 55,213 | 100 | 14/20 | 66 (17) |

The H4 variant mix sits inside P1's and P2's range. Each world is copied to its VM, and its file SHA-256 is checked there before slots are built.

To be appended before the first counted cell: the gbrain release, commit and slot commit; the harness commit; the hashes of the particle-1 transport files (`eval/runner/providers/`), which the Hard freeze doesn't cover; the judge check's result; model freshness; the slot receipts; the oracle gate; the VM names and ledger run ids.

**Recorded 2026-11-19, before any slot build:**

- **gbrain build.** v0.60.742.0, commit `ae8201041c21101dc8c5127afc1be4a047049483`, the highest version tag on gbrain's master when re-read on 2026-11-19 with `git ls-remote --tags`. The slots are built from the same commit. Each VM re-reads the tags again immediately before its slot build and stops if a newer release exists.
- **Harness.** gbrain-evals `00c85dfd986207a94cecb375668a741079b6ee2c` on `capy/cat40-hard-newest-results` carries the pin, the seed registration, the reader change, the particle-1 change and the accepted drift. The runs execute from the commit that adds this record, which changes no code.
- **particle-1 transport.** `eval/runner/providers/openai-compatible.ts`, SHA-256 `ed4cd5fc73ad971e3769fc4888eec8672c38eee8e1ff6a000203e2d41a7479ec` (last changed in `53583e386`), the only file in `eval/runner/providers/`.
- **Judge check** (`eval/runner/cat40/judge-check-hard.ts`, 60 constructed items with 30 good and 30 bad answers, 12 per family, plus 40 real answers from world M's committed cells). gpt-6.1-sol: kappa 0.967, caught 30 of 30 bad answers, failed 1 of 30 good ones, 0 malformed, agreed with the recorded judge on 39 of 40 real answers. claude-opus-5-5: kappa 1.000, caught 30 of 30, failed 0 of 30, 0 malformed, agreed on 36 of 40 real answers. The two judges agreed with each other on 92.3% of the real answers. Both pass (kappa at least 0.6, at least 15 items per class, at most 1% malformed), so the counted cells may start.

**Recorded 2026-11-19, after the slots, oracle cells and pilots and before any counted cell:**

- **Harness, corrected.** The slot step first stopped on both worlds with `HARD_FREEZE_DRIFT` before building anything, because the plan did not pass `--accept-freeze-drift` to it. `4d306473e` adds the flag, and the slots, oracle cells and gbrain pilots ran from that commit. The files pilots and every counted cell run from `c5050b28d`, which adds the two amendments below and changes no code the cells run.
- **VMs.** N1 on `ubirun-gbev104-1795065914-8cdfb5e0-t48` and N2 on `ubirun-gbev104-1795065914-660c909c-t48`, both Ubicloud standard-16, each with its own ledger (`.budget/cat40-hard-newest-n1.sqlite` and `-n2.sqlite`) and one writer. Each world's `world.json` matched its recorded SHA-256 on its VM.
- **Model freshness** (`scripts/model-freshness.ts`, 2026-11-19, both VMs): no blocking finding and no newer frontier Opus or GPT. It warns that claude-sonnet-5-5 is listed, which is not a model in this run.
- **Slot receipts** (gate 7). Both worlds name gbrain 0.60.742.0, commit `ae8201041c21101dc8c5127afc1be4a047049483`, for the build and for the slots, from a verified copy (tree `ddaf41f58780948366b13d4ed5530a72d74ecd17`, the tree and CLI version match). All 5 slots per world passed the write, restore and rerank probes with 0 queued persistence effects at snapshot; the config reads back `{}` (shipping defaults). The served instructions and tools hash to `216535f0d45a5507…` and `eb524bf80ff5986b…` on both worlds. Ledger runs: N1 `cat40-slot-build-2026-11-19T05-34-32-172Z-6d2fd183`, N2 `cat40-slot-build-2026-11-19T05-34-19-974Z-3fb0e419`.
- **Oracle gate** (gate 4). N1: 198 of 200 frontier cells (99%; Opus 5.5 100 of 100, GPT-6.2 Sol 98 of 100). N2: 196 of 200 (98%; 98 and 98). Both pass the 95% bar.
- **Pilots (R111).** Every pilot cell ended submitted or at the turn cap, none in a harness error or a rate-limit stop, at concurrency 10, and each pilot cost less than a tenth of its arm's planned spend. The gbrain arm ran: every one of its 20 pilot cells called gbrain tools (search, get_page, entity, get_backlinks and others), and none got `param_not_on_surface`. The files arm ran: every one of its 20 pilot cells called grep and read_file. Both judges passed the judge check above, and the oracle gate shows the tasks can be answered from the documents they name. Both arms meet R111, so both are counted.

**Recorded 2026-11-19, at the interim look:** both worlds finished half A (400 counted frontier cells, none a harness error). On N1, `fs-sol-a` paused after 37 of 50 cells, when the ledger refused one worst-case request reservation larger than the step's whole cap. It resumed under a new budget run with a larger cap, which the program owner approved, and its remaining 13 cells finished. The one look (`newest_analysis.py --look interim`) decided **continue**: |z| was below 2.80 and conditional power was at least 10%. Half B started on both worlds. The look's values are reported with the results.

## Amendments

- **2026-11-19, harness check under R110** ("Sol runs in Codex CLI and Opus in Claude Code"): no arm runs inside Claude Code or Codex CLI. Both frontier readers, and particle-1, are called through this repository's own agent loop (`eval/runner/cat40/loop.ts`, the OpenAI Responses API for gpt-6.2-sol and the Anthropic Messages API for claude-opus-5-5), so nothing changes.
- **2026-11-19, one interim look at half the tasks (R113)**, committed before any counted cell. The counted frontier cells (gbrain and files, Opus 5.5 and GPT-6.2 Sol) run in two halves fixed by task id: half A is tasks 01 to 10 of every family in both worlds (50 tasks per world), and half B is tasks 11 to 20. Each half runs as its own step with `--tasks`, in `<step>-a` and `<step>-b` (`eval/runner/cat40/newest-confirm.ts`). Once both worlds finish half A for both arms and both readers, `newest_analysis.py --look interim` takes the one look at the pooled headline Δ, with z = Δ divided by its task-bootstrap standard error (the same nested bootstrap, 10,000 resamples, Random(1)). The bounds are O'Brien-Fleming:
  - **Stop for a difference** if |z| ≥ 2.80, in either direction.
  - **Stop for futility** if conditional power is below 10%. Conditional power is the chance of ending with z ≥ 1.98 if the true lead is the planned effect of +5.4 points, the pooled 80%-power detectable difference above, at information fraction 0.5, with the final standard error taken as the interim one times √0.5.
  - **Otherwise half B runs.** The final look uses the critical value 1.98 in place of 1.96: the headline interval is the bootstrap percentile interval at that level (2.39% to 97.61%), and the wording and outcome rows read that interval.
  A run that stops early says so in every place it reports its result, reports its estimate as possibly overstated, and reads its wording from the interval at z 2.80. No other look at the primary comparison counts. The per-world, per-family, per-reader and H4 views and the particle-1 rows are unchanged, and they are computed only at the final look, or at the stop if the run stops early. Interim cells are counted cells: the look discards nothing.
- **2026-11-19, pilots before counted cells (R111).** Each arm's pilot costs at most a tenth of that arm's planned spend and shows on the arm's own outputs that the part under test ran, that its judge passes R78, and that tasks can be supplied at the planned rate (concurrency 10, with no rate-limit stops). The gbrain arm's pilot is the five-cell gbrain smoke per reader (gate 5). The files arm has no pilot in the plan as written, so a five-cell files smoke per reader (`smoke-fs-opus`, `smoke-fs-sol`, one task per family) is added before the counted cells. A pilot that fails leaves its arm out of the counted run, and the arm is reported as left out. The oracle cells (gate 4) show that the tasks can be answered from the documents they name. The judge check recorded above covers both judges. The result for each arm is recorded under "Recorded before cells" before the first counted cell.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

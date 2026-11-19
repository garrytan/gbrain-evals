# Preregistration: does gbrain still beat plain files on hard company questions at its newest release? (Cat 40 Hard, newest build)

Written 2026-11-19. This file freezes in its own commit, pushed before the first paid request. Values that don't exist yet (the gbrain release and commit, the harness commit, the world digests, the judge check's result, the ledger run ids) are appended under "Recorded before cells" before the first counted cell. Any other change after that commit is a dated amendment at the end, never an edit.

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
- **Seeds, named before any generation: N1 = 20261141 and N2 = 20261151.** If a seed fails the generator's own checks, that seed plus 1,000 is used (20262141, 20262151), as for P1 and P2, and the failure is reported as a count. A seed that fails twice is reported and its world replaced only by dated amendment. The seeds are registered in `HARD_SEEDS` on the results branch. The digests, document counts and H4 variant counts of both worlds are recorded below before any slot is built. Only counts, variants and hashes are read; no task or document text is opened before the results.

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
- **Claims judge** (`cat40-hard-claims-v1`, unchanged). It lists each factual claim in an answer and marks it supported, contradicted or unsupported. It never decides success, which the deterministic scorer (`cat40-hard-score-v2`) does. The protocol judge, `gpt-6.1-sol`, grades the Claude and particle-1 rows. `claude-opus-5-5` grades the GPT-6.2 Sol rows, so no family judges its own rows. particle-1 never judges.
- **Judge check (before any counted cell).** Both judges grade at least 60 constructed answers on world M's tasks (public, the nightly's development set): 30 good answers that state each task's accepted value with its governing documents, and 30 bad ones that state a value the task lists as wrong, add an entity outside an H1 set, change an H1 count, or attribute a value to the wrong account. Items are stratified by family, 12 per family, and the construction label is the reference. A judge passes when its Cohen's kappa against the labels, reading "at least one contradicted or unsupported claim" as bad, is at least 0.6, with at least 15 items in each class graded and at most 1% of its outputs unparseable. Both judges also grade 40 real answers from row 1's committed world M cells, and their agreement with each other and with row 1's recorded judgments is reported, descriptive only. A judge that fails is reported, and the claim-based secondary endpoints for the rows it grades are shown as descriptive, not counted; the success endpoints don't use a judge and are unaffected.

## Metric and denominator

- **Primary metric: success**, from the deterministic scorer: the answer names an accepted value and no listed wrong value; sets match exactly; counts match; H5 is scored on the final session; multi-account answers need every item right. The denominator is every task in both worlds: 200 tasks per arm and reader.
- **Canonical cell:** the last harness-clean attempt per arm, reader and task. Only harness errors (a provider 5xx or 429 after backoff, or a slot, server, restore or MCP transport failure) are retried, at most twice per cell. A turn-cap stop, no tool call, malformed tool use, a context-length error or a provider safety-filter stop counts as a failure. Safety-filter stops are also reported on their own line.
- **Unit and clusters:** the task. Every interval is the October 15 preregistration's nested task bootstrap: 10,000 resamples from one `random.Random(1)` stream, tasks nested in worlds and worlds held fixed; each resample visits N1 then N2 and draws 100 task ids with replacement (`rng.choice` over the world's task ids sorted as strings); a drawn task brings every reader's cells of both arms; the interval is the 2.5th and 97.5th percentiles. The interval is conditional on these two worlds.
- **Secondary, reported with the same bootstrap:** per family (H4 always reported as its own family, with its interval, and split by its `+long` variants); per reader; per world; wrong-value rate (`said_wrong`), wrong submissions, non-submission and turn-cap stops; the claim judge's unsupported and contradicted claims per answer; and, from the transcripts, `param_not_on_surface` refusals per reader, searches by mode, searches with no `limit`, and empty searches. The first table shows claude-opus-5-5 and particle-1 with cost per correct answer.

## Decision rule

- **Headline:** Δ = gbrain success minus files success, paired by task, averaged over the two frontier readers (Opus 5.5 and GPT-6.2 Sol) on all 200 tasks, with its 95% interval. One row per reader follows. particle-1's Δ is reported with its interval and is not pooled into the headline. Wording as in row 1: "ahead" only when the lower bound is above 0; "parity" only when the lower bound is above -3 points; otherwise "not distinguishable", with the point estimate.
- **Smallest detectable difference** (two-sided α 0.05, 80% power, 2.8 standard errors), estimated before any cell from row 1's committed world M cells for Opus 5.5 and GPT-6.1 Sol (task-bootstrap standard error of the paired Δ, scaled to 200 tasks) and from the published intervals:

| Comparison | Detectable difference |
|---|---:|
| Δ against 0, two frontier readers pooled | 5.4 points |
| Δ against 0, Opus 5.5 alone | 8.8 points |
| Δ against row 2's public half (+12.50), unpaired | 7.2 points |
| Δ against row 1's world M (+7.7), unpaired | 8.9 points |
| One family against 0, readers pooled (40 tasks) | 8.4 to 12.8 points; H4 9.6 |

- **Comparison with the published rows.** Different worlds can't be paired by task, so these are unpaired. The lead **holds** when Δ is at least 12.50 - 7.2 = **+5.3** (within the detectable difference of both published fresh-world and public leads). It **drops** when Δ is below +5.3. It **rises** when Δ is above 7.7 + 8.9 = **+16.6**. The comparison is also shown for Opus 5.5 alone against Opus's own published leads, descriptive. Row 2's public half was measured with Sonnet 5.5 and GPT-6.1 Sol as the other readers, and with F5 and two extra settings on; its baseline build on defaults scored +8.50 (+4.83 to +12.33), shown beside it.
- **H4:** H4 is "level or behind" when its pooled Δ's lower bound is at or below 0.
- **Multiplicity.** One primary comparison; families, readers and worlds are secondary and are reported without correction, labelled as such.

## What each outcome changes

| Result | Then |
|---|---|
| The lead holds (Δ at least +5.3) | README's two hard-company rows are replaced by this measurement, naming gbrain's release and commit, with the note that the new worlds compare with world M and the public half, not the sealed halves. The sealed numbers stay in their dated reports and README's changelog |
| The lead rises (Δ above +16.6) | The same replacement, and README says the lead grew, with both numbers and builds. The per-family split goes to gbrain's maintainers as evidence of which change helped |
| The lead drops (Δ below +5.3) | The drop is published plainly in README with both builds. gbrain's maintainers get the per-family split, the tool-call statistics and changes 1 to 3 as suspects. An old-build control on the same harness and worlds, gbrain `09d21554d` (row 2's baseline build, before changes 1 to 4) on Opus 5.5 and GPT-6.2 Sol, is proposed as its own paid run; it is not part of this run and runs only after separate approval, under its own dated amendment |
| Δ is not distinguishable from 0 | Published as no measurable difference at this sample size, and README stops saying gbrain beats files on these questions until a new measurement shows it |
| H4 is level or behind | It goes to gbrain's maintainers as the one family no change since row 2 has aimed at, with its per-reader rows |
| H4 is ahead | README's known-limits line for H4 changes to say so, with the interval |
| particle-1's oracle success is below 90% on either world | particle-1's gbrain and files rows are reported, labelled as limited by the reader rather than by memory |

## Gates before counted cells (per world)

1. The world validates against its generator, and its digest equals the one recorded below.
2. The judge check above has run, and its result is recorded below.
3. Every slot passes the write, restore and fail-closed rerank probes, with 0 queued persistence effects at snapshot, and the config readback shows shipping defaults.
4. Oracle on all 100 tasks with Opus 5.5 and GPT-6.2 Sol: pooled success at least 95%. Below that, no counted cell runs on that world, and the result is reported. particle-1's oracle cells run too and are descriptive.
5. A five-cell gbrain smoke per reader halts on any harness error.
6. Model freshness passes on the day of the first counted cell.

## Budget

Each world runs on its own Ubicloud VM, detached, with one budget ledger per VM and one writer. Every request is reserved against that ledger before it is sent (`eval/runner/budget-ledger.ts`), and every step passes its own `--budget-usd`. A cap is set in each ledger; reaching it pauses the run at the cell boundary until the cap is extended, and the same step command resumes it with a new budget run sized to the missing cells. It never ends the test incomplete. particle-1 calls run only inside a granted paid window. The VMs are destroyed when their runs end. Dollar amounts stay in the tracking issue.

## Known limitations

- Two worlds can't estimate between-world variance; intervals are conditional on N1 and N2.
- The published comparisons are unpaired and their reader sets differ (Sonnet 5.5 and GPT-6.1 Sol then, GPT-6.2 Sol now). Opus 5.5 is the only shared reader.
- Row 2's public half ran with F5 and two extra settings on; this run uses shipping defaults.
- The public generator is public, so these worlds are confirmation in kind with the public rows only.
- The detectable differences are estimates from row 1's world M cells and the published intervals.
- particle-1 has never run on Hard worlds; its context fit on 55,000-document worlds is unmeasured, and context-length errors count as failures.

## Recorded before cells

To be appended before the first counted cell: the gbrain release, commit and slot commit; the harness commit; the world table (seed used, 4k base digest, 50k world digest, `world.json` SHA-256, documents, tasks, H4 tasks and items with `+long`); the judge check's result; model freshness; the slot receipts; the oracle gate; the VM names and ledger run ids.

## Amendments

None yet.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

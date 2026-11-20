# Hard company questions on gbrain's newest release: level with plain files on two new worlds, behind where sources disagree

Measured 2026-11-19 on gbrain v0.60.742.0 ([`ae8201041`](https://github.com/garrytan/gbrain/commit/ae8201041c21101dc8c5127afc1be4a047049483)), preregistered in [the November 19 preregistration](2026-11-19-cat40-hard-newest-preregistration.md), with its dated records and amendments. The particle-1 cells ran on 2026-11-20 on the same build and worlds, after the frontier cells.

- **We learned that on two new worlds, gbrain v0.60.742.0 is level with plain files on hard company questions, and that what lead it has sits in questions over many records (H1) and over several recording sessions (H5).** gbrain and the files agent got 325 and 315 of 400 answers right (two frontier readers, 200 tasks on two new worlds of about 55,000 documents). That gap's interval is -1.5 to +6.5 points, so the two are at parity. The leads published for October builds on other worlds were +12.5 and +7.7. The worlds are new as well as the build, so this run alone can't say which of the two moved the number. The [old-build control](2026-11-19-cat40-hard-old-build-control.md) on the same tasks since found the October build `09d21554d` near level too (+4.00; newest minus October -1.50, -4.50 to +1.50), so the smaller lead is not a gbrain regression. **You should not quote the October lead for the current release.** (The preregistration's sentence for a drop said the lead fell between builds. The control shows it didn't, so that sentence isn't used.)
- **We learned that gbrain still trails plain files when sources disagree** (H4: -16.25 points, -23.75 to -10.0), as it did on world M in October (-15.0). **You should check the governing documents yourself when the documents behind an answer conflict.**
- **We learned that gbrain helps a low-cost reader far more than a frontier one, and that it costs less per right answer.** particle-1 got 67 of 200 right with gbrain and 6 of 200 with plain files (+30.5 points, 95% interval +24.5 to +37.0), kept apart from the headline as preregistered. With files it ran out of its 16 turns in 184 of 200 cells. It is still far behind a frontier reader: Opus 5.5 with gbrain got 158 of 200, 45.5 points more (+38.5 to +52.5). Per right answer, gbrain cost $0.42 against $4.39 for files with particle-1, and $1.02 against $2.24 with Opus 5.5; for GPT-6.2 Sol the two cost about the same, $0.45 against $0.41. **You should give a low-cost model a search tool like gbrain, not raw files, on a corpus this size, and not expect it to match a frontier reader.**

## Results

### Right answers and cost per correct answer

| Reader | Arm | Right answers | Model spend per correct answer |
|---|---|---:|---:|
| claude-opus-5-5 | gbrain | 158 of 200 | $1.02 |
| claude-opus-5-5 | files | 152 of 200 | $2.24 |
| particle-1 | gbrain | 67 of 200 | $0.42 |
| particle-1 | files | 6 of 200 | $4.39 |
| gpt-6.2-sol | gbrain | 167 of 200 | $0.45 |
| gpt-6.2-sol | files | 163 of 200 | $0.41 |

The spend counts every attempt's reader and judge calls. gbrain's slot builds (embeddings, about the same for every reader) aren't included.

### Headline: gbrain minus files, two frontier readers pooled

| | Files (`grep`, `list_dir`, `read_file`) | gbrain | gbrain minus files | Interval (z 1.98) | Wording | Against the published rows |
|---|---:|---:|---:|---|---|---|
| Opus 5.5 and GPT-6.2 Sol, N1 and N2 (400 cells) | 315 (78.75%) | 325 (81.25%) | **+2.50** | -1.50 to +6.50 | parity | **drops** (below +5.3) |

Under the decision rule, the interval wording comes first: the lower bound is above -3 and the upper bound is not below 0, so the wording is "parity". The comparison with the published rows comes second: +2.5 is below the +5.3 that both published leads allow, so the lead **drops**. That is 10.0 points below row 2's public half (+12.50, gbrain `4e10136b4` with owner-phrase links on, a setting that doesn't ship), more than that comparison's detectable difference of 7.2. It is 5.2 points below row 1's world M (+7.7, gbrain `3e4ff61ce`), within that comparison's 8.9. Both comparisons are unpaired, because different worlds can't be paired by task. The interval uses z 1.98, the final bound of the one interim look (R113); the plain 95% interval is -1.25 to +6.50.

### Per reader, per world and per family (secondary, no correction)

| | gbrain minus files | 95% interval | gbrain / files right |
|---|---:|---|---:|
| claude-opus-5-5 | +3.0 | -3.0 to +9.5 | 158 / 152 |
| gpt-6.2-sol | +2.0 | -2.5 to +6.5 | 167 / 163 |
| World N1 (seed 20261141) | +1.5 | -3.5 to +7.0 | 162 / 159 |
| World N2 (seed 20263151) | +3.5 | -2.0 to +9.0 | 163 / 156 |
| H1, many records (a set or count over 6 to 12 accounts) | **+16.25** | +7.5 to +25.0 | 32 / 19 |
| H2, long histories (an attribute that changes 3 to 6 times) | 0.0 | -7.5 to +6.25 | 76 / 76 |
| H3, look-alikes (accounts sharing a name or code prefix) | 0.0 | -8.75 to +10.0 | 71 / 71 |
| **H4, sources disagree** (contract, amendments, drafts and notes) | **-16.25** | -23.75 to -10.0 | 66 / 79 |
| H4 with a long deciding document (`+long`, 66 cells) | -18.18 | -25.76 to -10.61 | 54 / 66 |
| H4 without (14 cells) | -7.14 | -21.43 to 0.0 | 12 / 13 |
| H5, five recording sessions | **+12.5** | +6.25 to +20.0 | 80 / 70 |

Each family has 80 cells: 2 readers × 40 tasks. For comparison, Opus 5.5 alone was +6 (-2 to +15) on world M in October. H4 is "level or behind" under the preregistered rule, so it goes to gbrain's maintainers with its per-reader rows.

| Other outcomes (gbrain minus files, points) | Δ | 95% interval |
|---|---:|---|
| Answer names a listed wrong value | +0.75 | -1.75 to +3.5 |
| Submitted answer is wrong | +2.0 | -0.75 to +5.0 |
| No answer submitted | -4.5 | -7.75 to -1.25 |
| Stopped at the 16-turn cap | -3.75 | -7.0 to -0.75 |

gbrain's agents ran out of turns less often, and most of what they gained there they gave back as wrong submissions.

### particle-1, reported apart from the headline

| | Files | gbrain | gbrain minus files | 95% interval | Wording |
|---|---:|---:|---:|---|---|
| particle-1, N1 and N2 (200 tasks) | 6 (3.0%) | 67 (33.5%) | **+30.5** | +24.5 to +37.0 | ahead |

The preregistration keeps particle-1's Δ out of the pooled headline, so the +2.50 above is unchanged.

- **The reader could answer.** Handed each task's deciding documents, particle-1 answered 98 of 100 on N1 and 95 of 100 on N2, above the preregistered 90% on both worlds, so its gbrain and files rows aren't labelled as limited by the reader.
- **Both worlds agree:** 32 against 3 on N1, 35 against 3 on N2.
- **By family** (gbrain / files right, of 40): H1 0 / 0, H2 12 / 0, H3 5 / 0, H4 11 / 0, H5 39 / 6. With gbrain, particle-1 kept facts across recording sessions (H5) almost every time and got no many-record question (H1) right.
- **How the cells ended.** With files, 184 of 200 stopped at the 16-turn cap, 10 ended when the prompt passed particle-1's 1,048,576-token limit (all H5, counted as failures as preregistered), and 6 submitted an answer, all right. With gbrain, 111 stopped at the cap and 89 submitted: 67 right, and 20 named a listed wrong value.
- **What it did.** With gbrain it searched 5,308 times (579 with no `limit`, 1,229 empty) and called `get_page` 1,853 times; in 21 of 200 cells it widened its session to the full surface. With files it called `read_file` 5,131 times, `grep` 4,331 and `list_dir` 2,211.

### What the agents did with gbrain

Over 200 cells per reader:

- **Opus 5.5** searched 1,541 times. 666 of those searches set no `limit`, and 109 came back empty. It also called `get_backlinks` 643 times, `get_page` 544 and `entity` 365.
- **GPT-6.2 Sol** searched 3,166 times. 323 set no `limit`, and 404 came back empty. It also called `get_page` 956 times and `context_pack` 360.
- **Some sessions widened themselves to the full surface.** Every cell started on the starter surface. In 21 of the 400 gbrain cells (19 Sol, 2 Opus) the agent called gbrain's own `request_tools {"surface":"full"}`, which the starter surface lists and which widens that one session to the full surface; gbrain allows this by default. After widening, Sol set `snippet_chars` on 329 searches and `token_budget` on 36, options the starter surface hides. Before widening, no search set them: a keyless probe of `gbrain serve --surface starter` at this build refuses both with `param_not_on_surface`, as gbrain#9695 intends. Dropping those 21 task pairs from both arms moves the headline from +2.50 to +2.37 points (321 vs 312 of 379), so widening doesn't explain the result. Opus set none of the hidden options.
- **The files agent**, for comparison: Opus called `grep` 1,999 times and `read_file` 3,982. Sol called `grep` 5,216 times and `read_file` 4,205.

The preregistration names three changes since row 2 as untested suspects for the drop:

1. Fewer search options shown to agents (gbrain#7481), and hidden ones refused (gbrain#9695).
2. At most 3 meaning-only pages per search that passes no `limit` (gbrain#7598).
3. Email and meeting text fenced as quoted source (gbrain#7601 and #8066).

This run doesn't test any of them. The readers, the files agent's loop and the worlds also changed since row 2.

### The claim judge (descriptive)

| Rows | Judge | Answers judged | Share with an unsupported or contradicted claim |
|---|---|---:|---:|
| Opus 5.5, gbrain / files | gpt-6.1-sol | 171 / 157 | 75.4% / 75.8% |
| Sol, gbrain / files | claude-opus-5-5 | 178 / 174 | 9.6% / 17.8% |
| particle-1, gbrain / files | gpt-6.1-sol | 89 / 6 | 91.0% / 100% |

Both judges passed the judge check below. The gap between the two readers' rows is mostly a gap between the judges or in how much each reader writes. It isn't compared across readers, and it doesn't enter success.

## How it ran

| | |
|---|---|
| Worlds | N1 (seed 20261141) and N2 (seed 20263151): generator `model-ladder-hard-v2`, `--scale large` and the frozen knobs, with 55,736 and 55,383 documents and 100 tasks each (20 per family). Generated fresh for this run from the public generator, so they compare with world M and row 2's public half, not the sealed worlds. |
| gbrain | v0.60.742.0 (`ae8201041`), the newest release on master when the slots were built. Shipping defaults: starter surface, reranking on, no config. 5 prebuilt brains per world, all from that commit. |
| Files | The same documents as Markdown files with `list_dir`, `grep` and `read_file`, on the hard tool limits. |
| Readers | claude-opus-5-5, gpt-6.2-sol and particle-1, all through this repository's own agent loop (`eval/runner/cat40/loop.ts`). 16-turn cap, concurrency 10, one attempt per task. particle-1 is sent `reasoning_effort: high` and a 16,000-token output limit. |
| Score | Success from the deterministic scorer: the answer names an accepted value and no listed wrong value. The claim judges are descriptive only. |
| Interval | Tasks nested in worlds, 10,000 resamples, `random.Random(1)` (`eval/runner/cat40/newest_analysis.py`). |

Gates, all passed before any counted cell:

- Both world files matched their recorded SHA-256 and digest on their VM.
- Model freshness passed: no newer frontier Opus or GPT.
- Judge check: gpt-6.1-sol scored kappa 0.967 and claude-opus-5-5 1.000, on 60 constructed and 40 real answers, with 0 malformed outputs. The two judges agreed with each other on 37 of the 40 real answers (92.5%). The preregistration's record and `analysis/judge-check.json` say 92.3% (36 of 39), because two of the real answers were given the same id and counted once; neither judge's pass changes.
- Every slot passed the write, restore and rerank probes with 0 queued effects, and the config read back as defaults.
- Oracle success on all 100 tasks: 198 of 200 on N1 and 196 of 200 on N2.
- A five-cell pilot per arm and reader (R111): every cell called its arm's tools, none hit a harness error or a rate-limit stop, and each pilot cost under a tenth of its arm's planned spend.

**The one interim look (R113).** The counted cells ran in two halves, fixed by task id before any cell. Half A was tasks 01 to 10 of each family, and half B tasks 11 to 20. After half A, Δ was +2.50 with a standard error of 2.49, so z was 1.00. Conditional power under the planned +5.4 was 0.645. That is inside the O'Brien-Fleming bounds (|z| ≥ 2.80 stops for a difference, conditional power below 10% stops for futility), so half B ran. No other look was taken.

Run notes:

- **The slot build stopped at first.** The slot step first stopped on both worlds before building anything, because the plan didn't pass the accepted freeze drift to it. That was fixed in `4d306473e` before any spend.
- **A step cap was smaller than one request's worst case.** On N1, the files Sol half-A step paused after 37 of its 50 cells. The budget ledger refused one request because its worst-case reservation (the most that request could cost) was larger than the step's whole cap. That is a plan bug: every step cap has to exceed one worst-case request reservation for its reader. The step resumed under a larger cap, approved before the resume, and its 13 remaining cells finished. No cell was lost or rerun.
- **One cell was not retried as the preregistration requires.** All 800 counted frontier cells ran once. One of them, N1 `gbrain-opus-b` task H4-13, ended on an Anthropic server error (HTTP 520) before any request was billed. The preregistration counts any provider 5xx as a harness error, to be retried, but the harness at `c5050b28d` retries only 429, 500, 502, 503, 504 and 529 (`eval/runner/cat40/loop.ts`, `RETRYABLE_STATUS`), so this cell was scored as a wrong gbrain answer with no retry. A retry could only score it right or wrong: right would move the headline to +2.75 (-1.00 to +6.75) and H4 to -15.0 (-22.5 to -8.75), wrong leaves the numbers above, and the wording is the same either way.
- **particle-1 ran last, in its own paid window.** Its oracle, gbrain and files cells ran on 2026-11-20, one world at a time, after both worlds' frontier cells, from harness `c5050b28d` (the frontier cells' commit). The frontier VMs were gone by then, so each world's 5 slots were rebuilt from gbrain `ae8201041` on new VMs; their receipts are in `slots-particle/`, and both gbrain steps' receipts name that commit. On N1 the gbrain step paused after 79 of its 100 cells, when its budget cap was reached at a cell boundary. The cap was extended before the resume, and the 21 remaining cells ran under a new budget run. No cell was lost or rerun, and none of the 600 particle-1 cells was a harness error.
- **One record is missing.** The preregistration asked particle-1's receipts to record the effort sent and effective, the output limit and the weight version. They don't. The harness at `c5050b28d` sends `reasoning_effort: high` and a 16,000-token limit on every particle-1 request (`eval/runner/cat40/loop.ts`, line 469), but the effective effort and the weight version weren't captured.

## Limits

- Both the build and the worlds changed since the published rows. The comparison with them is unpaired, and the readers changed too: GPT-6.2 Sol replaced GPT-6.1 Sol, and Sonnet 5.5 was dropped. The drop is a fact about these worlds on this build. The [old-build control](2026-11-19-cat40-hard-old-build-control.md) found no regression from the build under its preregistered rule, though its interval allows the newest build up to 4.50 points below October's; the rest of the drop comes from the worlds, the readers or the files agent, and neither run can say which.
- These worlds come from the public generator. They compare with world M and the public half, not with the sealed worlds (+13.0 and +10.67), which this run doesn't re-measure.
- One attempt per task, so per-family and per-reader intervals are wide. They are secondary and uncorrected.
- particle-1 hit the 16-turn cap in most cells, 184 of 200 with files and 111 of 200 with gbrain. Its rows measure how far it gets within 16 turns on 55,000 documents, and a higher cap could change both.

## Files

- [`n1/`](2026-11-19-cat40-hard-newest/n1) and [`n2/`](2026-11-19-cat40-hard-newest/n2): every step's `attempts.jsonl` (one line per cell, with its score, claims and cost), its `experiment.json` and receipts, and the served gbrain instructions and tools. Caps are redacted from the receipts.
- Steps: the counted cells `gbrain-{opus,sol}-{a,b}` and `fs-{opus,sol}-{a,b}`; particle-1's `oracle-particle`, `gbrain-particle` and `fs-particle`; the oracle cells; the pilots `smoke-*`; the slot receipts (`slots` for the frontier cells, `slots-particle` for particle-1's); and `oracle-gate.json`.
- [`analysis/final.json`](2026-11-19-cat40-hard-newest/analysis/final.json), [`analysis/interim.json`](2026-11-19-cat40-hard-newest/analysis/interim.json) and [`analysis/judge-check.json`](2026-11-19-cat40-hard-newest/analysis/judge-check.json).
- Transcripts (about 340 MB) are kept outside the repository, and `final.json` holds the tool-call counts taken from them.
- To reproduce the headline and particle-1's row, run this from the repository root:

  ```bash
  D=docs/benchmarks/2026-11-19-cat40-hard-newest
  f() { echo $D/$1/{gbrain,fs}-{opus,sol}-{a,b}/attempts.jsonl $D/$1/{gbrain,fs}-particle/attempts.jsonl | tr ' ' ','; }
  python3 eval/runner/cat40/newest_analysis.py --world N1=$(f n1) --world N2=$(f n2) \
    --accept-unretried 'N1|gbrain-newest|claude-opus-5-5|H4-13'
  ```

  The analysis refuses a counted cell that ended on a provider 5xx or 429 unless it is named, so the command names the
  one HTTP 520 cell the run notes disclose.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

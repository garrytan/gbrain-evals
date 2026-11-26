# Delivering long documents by section wins back "sources disagree" questions for gbrain, on six unseen worlds

Measured 2026-11-26 on gbrain v0.60.775.0 ([`f832b4928`](https://github.com/garrytan/gbrain/commit/f832b4928844f149fb08657797eaa6fd9daebd5a)),
preregistered in [the November 24 preregistration](2026-11-24-cat40-h4-fix-confirmation-preregistration.md), with its
dated records and amendments. Both gbrain arms run the same release and the same prebuilt brains. The only difference
is one read-time setting, `search.long_page_unit=section`, which is off by default.

- **We learned that when a matching document is long, sending the agent the section that matched, instead of the
  document's first chunk, answers more questions where sources disagree.** On 120 such questions (family H4: a
  contract, its amendments, drafts and notes give different values, and one of them governs), Opus 5.5 answered 95.4%
  with section delivery on and 85.8% with it off: **+9.58 points, interval +5.0 to +14.58**. GPT-6.2 Sol gained the
  same, +10.0 (+4.58 to +15.83). On the 160 questions of the other four families, section delivery changed nothing
  (+0.31, -2.5 to +3.44), and it did not cost more per answer. **You should check that the sentence that decides an
  answer reaches your agent's context, not only that the right document comes back in the results.**
- **These six worlds are unseen, but they are not sealed.** They come from fresh seeds of the public world generator,
  which nobody had tuned gbrain on, but anyone can regenerate a world from its seed. We also chose them for having
  long governing documents, at least as many as public world N1: section delivery only acts on pages of 20,000
  characters or more. The sealed generator we planned to use writes no H4 page that long, so on its worlds the setting
  never fired and we stopped before any counted answer (below). **You should read this result as holding where
  deciding documents are long, and you should check that the part under test can act on your data before you build a
  held-out set for it.**
- **We learned that with section delivery on, gbrain is no longer clearly behind plain files on these questions, but it
  is not clearly level either.** For Opus 5.5, gbrain with section delivery minus the files agent is +0.42 (-4.17 to
  +5.42). For GPT-6.2 Sol, gbrain is still behind files (-4.58, -8.75 to -0.83). On gbrain's shipping defaults, Opus 5.5
  trails files here by 9.2 points and GPT-6.2 Sol by 14.6 (point estimates). **You should still check the governing documents yourself when the
  sources behind an answer conflict.**

Under the preregistered decision rule, section delivery **helps and does no harm**, so turning it on by default goes to
Garry, through gbrain's maintainers, with these numbers.

Settled call: the default flip of `search.long_page_unit` to `section` goes to Garry with these numbers; it ships only if he approves it.

## Results

### Right answers and cost per correct answer

particle-1 is the repository's primary low-cost reader. It ran on both gbrain arms; its files arm was left out (below).

| Reader | Arm | H4 right (120 tasks) | All five families right | Model spend per correct answer |
|---|---|---:|---:|---:|
| claude-opus-5-5 | gbrain, section delivery on | 95.42% | 356 of 400 cells | $0.81 |
| particle-1 | gbrain, section delivery on | 42.50% | 108 of 280 cells | $0.44 |
| particle-1 | gbrain, defaults | 30.83% | 98 of 280 cells | $0.46 |

| Reader | Arm | H4 right (120 tasks) | All five families right | Model spend per correct answer |
|---|---|---:|---:|---:|
| claude-opus-5-5 | gbrain, section delivery on | 95.42% | 356 of 400 cells | $0.81 |
| claude-opus-5-5 | gbrain, defaults | 85.83% | 330 of 400 cells | $0.89 |
| claude-opus-5-5 | files | 95.00% | 222 of 280 cells | $2.19 |
| gpt-6.2-sol | gbrain, section delivery on | 93.75% | 358 of 400 cells | $0.38 |
| gpt-6.2-sol | gbrain, defaults | 83.75% | 336 of 400 cells | $0.40 |
| gpt-6.2-sol | files | 98.33% | 243 of 280 cells | $0.38 |

H4 success is per task, averaged over the two repeats each gbrain arm ran (the files arm ran once). The cells column
counts every counted cell on all six worlds: H4 on all six, H1, H2, H3 and H5 on U1 and U2 only. Spend counts every
attempt's reader and judge calls. Slot builds aren't included; both gbrain arms share them.

### Primary and key secondary endpoints

| Endpoint | Δ (points) | Interval | Wording |
|---|---:|---|---|
| **Primary:** section on minus defaults, H4, Opus 5.5, 120 tasks | **+9.58** | +5.0 to +14.58 (z 1.98) | **helps** |
| Same, Opus 5.5 and GPT-6.2 Sol pooled | +9.79 | +6.25 to +13.54 | secondary |
| Same, GPT-6.2 Sol | +10.0 | +4.58 to +15.83 | secondary |
| **No harm:** section on minus defaults, H1, H2, H3, H5, both readers, 160 tasks | +0.31 | -2.5 to +3.44 | **no harm** (lower bound above -5) |
| Gap: section on minus files, H4, Opus 5.5 | +0.42 | -4.17 to +5.42 | not distinguishable from files |
| Gap: section on minus files, H4, GPT-6.2 Sol | -4.58 | -8.75 to -0.83 | behind files |
| Gap: section on minus files, H4, pooled | -2.08 | -5.42 to +1.46 | not distinguishable from files |

The primary interval uses z 1.98, the final bound after the one interim look. The look, at half of H4 (60 tasks), gave
z = 2.699 against a stop bound of 2.80, so it continued, and no other look was taken. Secondary intervals are 95%, with
no correction for multiple comparisons. All intervals come from the preregistered nested task bootstrap (10,000
resamples, seed 1) and are conditional on these six worlds. No planned frontier cell is missing.

The primary's preregistered detectable difference was 12.2 points. The result is smaller than that and still clears 0:
the observed standard error (2.39 points) was smaller than the plan's estimate, which took no credit for the gbrain
arms' second repeat.

### Per world (H4, section on minus defaults, descriptive)

| World | Opus 5.5 | GPT-6.2 Sol |
|---|---:|---:|
| U1 | -2.5 | +7.5 |
| U2 | +12.5 | +12.5 |
| U3 | +7.5 | +7.5 |
| U4 | +17.5 | +10.0 |
| U5 | +12.5 | +12.5 |
| U6 | +10.0 | +10.0 |

Each world has 20 H4 tasks. Five of six worlds move the same way for Opus 5.5, and all six for GPT-6.2 Sol.

### Per family, both gbrain arms (success per task, descriptive)

| Family | Opus 5.5 on | Opus 5.5 off | GPT-6.2 Sol on | GPT-6.2 Sol off |
|---|---:|---:|---:|---:|
| H1, many records (40 tasks) | 42.5% | 42.5% | 42.5% | 40.0% |
| H2, long histories (40) | 100.0% | 90.0% | 95.0% | 100.0% |
| H3, look-alikes (40) | 75.0% | 77.5% | 97.5% | 97.5% |
| H4, sources disagree (120) | 95.42% | 85.83% | 93.75% | 83.75% |
| H5, five recording sessions (40) | 100.0% | 100.0% | 97.5% | 100.0% |

### Did section delivery fire, and where did the remaining misses come from? (secondary 4)

Counted from the transcripts of every counted cell, per arm and reader:

| | Opus 5.5 on | Opus 5.5 off | GPT-6.2 Sol on | GPT-6.2 Sol off |
|---|---:|---:|---:|---:|
| `search` calls | 2,729 | 2,721 | 6,302 | 6,297 |
| Calls where the setting delivered a section (`reason: "long_page"`) | 200 | 0 | 291 | 0 |
| Rows it delivered that way | 246 | 0 | 357 | 0 |
| `search` calls where the agent chose its own unit (`return_unit`) | 306 | 298 | 2,064 | 572 |
| `get_page` grep calls with `a|b` (with matches) | 12 (12) | 29 (28) | 37 (36) | 20 (20) |
| H4 item-attempts whose governing document never came back, by how it names the account | manager phrase 7 | manager phrase 10, code 2, nickname 1 | manager phrase 8 | manager phrase 6, nickname 2 |

The setting fired only on the arm that turns it on. An agent that names a unit itself bypasses the setting for that
call, and GPT-6.2 Sol did so far more often with section delivery on (2,064 calls against 572). The last row counts
attempts, not items: each H4 task runs twice on each gbrain arm, so an item missed both times counts twice, and a
document id counts as returned when it appears anywhere in a tool result. Of the H4 item-attempts whose governing
document never reached the agent with section delivery on, every one was a record that names its account
only by a manager phrase. That is the known limit the preregistration names, and section delivery does not address it.

### Other outcomes

- **Claims judge (secondary 7).** Share of answers the claims judge flagged with at least one contradicted or
  unsupported claim: Opus 5.5 49.2% on, 51.8% off, 54.0% files; GPT-6.2 Sol 14.4% on, 18.6% off, 16.2% files. The judge
  passed its preregistered check against construction labels (kappa 0.96 and 0.98). Per-claim counts are descriptive
  and not rule-checked, so they aren't shown.
- **Cost (secondary 6).** Opus 5.5's cost per cell was $0.72 with section delivery on and $0.73 off; the prototype had
  raised it by about a fifth, and here it didn't move. GPT-6.2 Sol's was $0.34 on both.
- **Stops.** Turn-cap stops: Opus 5.5 28 on, 37 off, 46 files; GPT-6.2 Sol 19 on, 18 off, 27 files. The files arm with
  Opus 5.5 also had 10 context-length stops, scored as failures as preregistered. No frontier cell ended on an error
  stop (a transport or provider error), and no provider safety-filter stop occurred.

### particle-1, reported apart from the headline

particle-1 read every planned task once on both gbrain arms (280 tasks each), after each world's frontier cells. It is
descriptive and enters no headline or pooled endpoint.

| particle-1 | Section on | Defaults | On minus defaults | 95% interval |
|---|---:|---:|---:|---|
| H4, 120 tasks | 42.50% | 30.83% | +11.67 | +0.83 to +22.50 |
| H1, H2, H3, H5 on U1 and U2, 160 tasks | 35.62% | 38.12% | -2.50 | -9.38 to +4.38 |

Section delivery helped particle-1 on H4 too, by about as much as the frontier readers, but it stays far behind them:
Opus 5.5 with section delivery on answered 95.42% of the same H4 tasks, 52.9 points more. On the other families its
difference is not distinguishable from 0, and the interval is wide. In particle-1's transcripts, the setting delivered
729 search rows as sections on the section arm and none on the defaults. particle-1 stopped at the 16-turn cap in 134
of 280 cells with section delivery on and 148 of 280 on the defaults.

- **Its files arm was left out.** In particle-1's files pilot on U1, one cell's prompt passed Particle's limit of
  1,048,576 tokens (`tokenization_token_limit_exceeded`) after its file reads, a context-length stop that the plan's
  pilot rule doesn't allow. So particle-1 has no gap-to-files row here.
- **One cell was not retried.** One U2 particle-1 cell on the section arm (an H5 task) ended on a connection reset
  (`ECONNRESET`). The harness records a transport error like this as an error stop and scores it as a wrong answer;
  it retries only its own harness errors, so this cell was not rerun. Scored right, it would move particle-1's
  other-family difference by +0.625 points.
- These cells ran on the harness commit that lets particle-1 run on these six worlds (below), after the frontier cells.

## What didn't work

- **The sealed worlds couldn't test the setting.** The plan first ran on six worlds from the sealed generator
  (`hard-sealed-v2`, S3 to S8). All six built their brains and passed the answer-key check, but that generator writes
  no H4 page of 20,000 characters or more (the largest H4 governing document held about 9,600), so section delivery had
  nothing to act on. In 20 section-arm pilot cells on S3 it never fired, and the run stopped before any counted cell,
  as the plan's pilot rule requires. The money spent on that attempt produced no counted result; the tracking issue has
  the amount. The lesson is in the second takeaway: check that the part under test can act on the data before minting
  held-out worlds for it.
- **An unbounded grep overflowed the files agent.** One S3 files pilot cell with Opus 5.5 ran a grep that returned
  about 2.2 million characters, and the next request exceeded the model's one-million-token context. That is a harness
  outcome of the files arm's tool limits, not a model failure. In the counted cells, the files arm with Opus 5.5 had
  10 context-length stops (counted above as failures); this run did not trace each one to its cause.
- **One S3 seed is no longer held out.** While reading a slot receipt during the sealed attempt, an operator command
  printed S3's seed into an internal agent transcript. [SEALED.md](cat40-hard/SEALED.md) marks S3 as no longer held out. S3 ran no
  counted cell, and none of the U worlds' seeds was exposed.

## How it ran

- **Worlds.** U1 to U6: fresh seeds of `model-ladder-hard-v2` at `--scale large` with the frozen knobs, about 55,000
  documents and 100 tasks each. Each world's digest was recorded before it was generated. A world had to have at least
  14 of its 20 H4 tasks governed by a page of 20,000 characters or more, as N1 has. Seven draws fell short and were
  replaced, and five failed the generator's own checks and were replaced. H4 ran on all six worlds, and the other four
  families on U1 and U2. Digests, file hashes, slot receipts, answer-key gates and pilots are under "Recorded before
  cells" in the preregistration.
- **Arms and readers.** `gbrain-section` and `gbrain-default` on the same release and brains; `fs` (`list_dir`,
  `grep`, `read_file` over the same documents as Markdown). Readers `claude-opus-5-5` (primary) and `gpt-6.2-sol`.
  The gbrain arms ran every H4 task twice. Judges: `gpt-6.2-sol` graded Opus 5.5's rows, and `claude-opus-5-5` graded
  GPT-6.2 Sol's and particle-1's. No model graded its own family's rows.
- **Harness.** gbrain-evals [`e348313e`](https://github.com/garrytan/gbrain-evals/commit/e348313ecddd71b43f93424e3838c94d9a72bc69)
  for every frontier cell. particle-1's cells ran on [`459aa6e2`](https://github.com/garrytan/gbrain-evals/commit/459aa6e2c9b09449d234c8c82e700148f468feb6),
  a merge of main that adds the change letting particle-1 run on these six recorded worlds (the ladder refused particle-1
  on any Hard world no plan listed, before any request).
- **Step order on U1 and U2.** The plan lists each full world's H4 half B after the other four families. On U1 and U2,
  H4 half B ran before the remaining other-family steps, so that a world reaching its budget cap could not leave the
  primary endpoint unfinished. No endpoint depends on the order of steps within a world. To reorder them, the step
  runner was stopped while `default-opus-other` was running. That step's own process ran to the end. Its completion
  mark was then written by hand, after checking that all 80 cells had finished and its log held no stop. The runner
  then carried on from H4 half B.
- **Step budgets.** Each step has its own budget inside its world's ledger cap. Requests are reserved before they are
  sent, so a step's budget must hold its in-flight reservations. The U1 files pilot with Opus 5.5 stopped on its step
  budget after 2 of 5 cells and finished on a new budget run of the same step. Step budgets were re-split after the
  pilots. World caps did not change, and no world reached its cap.

## Reproduce

The world files, transcripts and attempts stay on the custody machines (they are generated from unpublished seeds), so
the numbers above reproduce from the step program and the analysis script on those files:

```bash
bun eval/runner/cat40/h4fix-confirm.ts plan --world u1 --build f832b4928844f149fb08657797eaa6fd9daebd5a --date 2026-11-26
python3 eval/runner/cat40/h4fix_analysis.py --world U1=<counted attempts.jsonl,...> ... --world U6=<...> --look final
```

particle-1's rows come from the same command with its two gbrain arms' attempts added to each world's list; with no
files-arm cells for it, the script prints its gap to files as incomplete.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which
makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of
Y Combinator. Garry Tan runs Y Combinator.

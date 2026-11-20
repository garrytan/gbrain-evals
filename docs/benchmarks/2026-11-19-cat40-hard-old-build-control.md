# Hard company questions, old-build control: gbrain's October build is also near level with plain files on the new worlds, so the smaller lead is not a gbrain regression

Measured 2026-11-19 on gbrain `09d21554d` (v0.60.189.0, October 13), preregistered in [the old-build control preregistration](2026-11-19-cat40-hard-old-build-control-preregistration.md), with its dated records and amendment. It pairs task by task with the newest-release run on the same worlds ([hard company questions, newest build](2026-11-19-cat40-hard-newest.md)), whose files and v0.60.742.0 cells it reuses.

- **We learned that on the two new worlds where gbrain's newest release is near level with grep, its October build is too: +4.00 points over the files agent, under the +5.3 a regression would need, and level with the newest build within noise (newest minus old: -1.50, interval -4.50 to +1.50). So the smaller lead is not a gbrain regression. It comes from the worlds, the readers or the grep agent, which this run can't separate.** **You should measure a memory tool on more than one world, with today's readers, before quoting its lead.** The same October build led by +8.50 on two other public-generator worlds in October, read by an older reader set.
- **We learned that gbrain trails plain files where sources disagree at both builds** (H4: October build -11.25, newest -16.25). The paired difference between the builds there, -5.00 (-13.75 to +2.50), includes 0, so it is not a regression on that family either. **You should check the governing documents yourself when the documents behind an answer conflict, whichever gbrain build you run.**
- **Both builds reach their accuracy at under half the files agent's cost per correct answer with Opus 5.5** ($1.00 for the October build, $1.02 for the newest, $2.24 for files). With GPT-6.2 Sol the three cost about the same ($0.38, $0.45 and $0.41).

## Results

### Headline: two frontier readers pooled, 200 tasks on N1 and N2

| Arm | Right answers (of 400) | Against files | Against the October build |
|---|---|---|---|
| gbrain `09d21554d` (October, v0.60.189.0) | 331 (82.75%) | **+4.00** (0.00 to +8.25) | — |
| gbrain `ae8201041` (newest, v0.60.742.0) | 325 (81.25%) | +2.50 (-1.50 to +6.50) | **-1.50** (-4.50 to +1.50) |
| Files agent (grep over Markdown) | 315 (78.75%) | — | — |

Each difference is gbrain's rate minus the other arm's, averaged over Claude Opus 5.5 and GPT-6.2 Sol, with a 95% interval from 10,000 bootstrap resamples of tasks within worlds. Both control differences come from the same resample draws, so newest minus old equals newest minus files less old minus files exactly. The newest build's +2.50 comes from the newest-release run.

Under the preregistered rule, the October build's lead over files (+4.00) is below +5.3, and the interval of newest minus old includes 0, so the outcome row is **not a regression**. Because newest minus old is below 0, the rule adds the note "newest lower, within noise". The smaller-regression row needed that interval to lie below 0, which with a point estimate of -1.50 needs a standard error under about 0.77 points; it was 1.50.

### Per reader, per world and per family (secondary, no correction)

| Slice | October build minus files | Newest minus October build |
|---|---|---|
| Claude Opus 5.5 | +4.50 (-1.50 to +11.00) | -1.50 (-7.00 to +4.00) |
| GPT-6.2 Sol | +3.50 (-1.50 to +9.00) | -1.50 (-5.50 to +2.00) |
| World N1 | +6.00 (+0.50 to +12.00) | -4.50 (-9.00 to 0.00) |
| World N2 | +2.00 (-4.00 to +8.00) | +1.50 (-2.50 to +5.50) |
| H1, many records | +17.50 (+7.50 to +27.50) | -1.25 (-7.50 to +5.00) |
| H2 | -1.25 (-8.75 to +6.25) | +1.25 (-5.00 to +7.50) |
| H3 | +3.75 (-6.25 to +15.00) | -3.75 (-11.25 to +3.75) |
| H4, sources disagree | -11.25 (-18.75 to -3.75) | -5.00 (-13.75 to +2.50) |
| H4 with a long history | -15.15 (-24.24 to -7.58) | -3.03 (-12.12 to +6.06) |
| H4 without one | +7.14 (0.00 to +21.43) | -14.29 (-28.57 to 0.00) |
| H5, several recording sessions | +11.25 (+5.00 to +17.50) | +1.25 (0.00 to +3.75) |

The two builds lead in the same places (H1 and H5) and trail in the same place (H4). Among the secondary rates, the newest build ended without submitting an answer more often than the October build (+2.75 points, +0.50 to +5.00), mostly by reaching the turn limit (+2.50, +0.25 to +4.75); these are uncorrected and descriptive.

### What the agents did with each build

- **The October build's starter surface offers search options the newest one hides.** At `09d21554d`, `search` on the starter surface accepts `snippet_chars` and `token_budget`. Opus set `snippet_chars` on 945 of its 1,811 searches and Sol on 2,445 of 3,164, and Sol set `token_budget` on 329. At v0.60.742.0 the starter surface refuses those options, and Sol set them only after widening a session to the full surface.
- **Widening.** In 21 newest-build cells (19 Sol, 2 Opus) the agent widened its session to the full surface with `request_tools`. At the October build, Sol called `request_tools` 39 times in 30 cells (15 per world), always with no arguments (to list the catalogue) or with a list of named tools, and never passed a surface argument, so it never widened to the full surface. Dropping the 21 widened task pairs from every arm leaves the October build +3.10 over files (-0.95 to +7.17) and newest minus old -0.76 (-3.86 to +2.34), so widening doesn't explain the result.
- **Served models.** Every one of the control's 720 sessions was served by the model it asked for: `claude-opus-5-5` and `gpt-6.2-sol`, as the providers named them in each response. The newest-release run didn't record served ids, so a provider-side change between its cells and these, on the same day, can't be ruled out, but nothing points to one.

## How it ran

- **Build.** `09d21554d7ab75cc5643a7f5a0e7f163aa4dae5b` (v0.60.189.0) on shipping defaults, with no config and no build config, served by `gbrain serve --surface starter` over stdio with the surface passed explicitly. Every receipt names this commit and surface `starter`.
- **Worlds and tasks.** The November 19 worlds N1 (seed 20261141) and N2 (seed 20263151), checked against their recorded digests before slots were built, and the same 100 tasks per world in the same two halves.
- **Slots.** Five prebuilt brains per world, built by the October build from the same world files. Every slot passed the write, restore and fail-closed rerank probes, read back no config, and had 0 queued persistence effects.
- **Readers and judges.** Claude Opus 5.5, judged by GPT-6.1 Sol, and GPT-6.2 Sol, judged by Claude Opus 5.5, as in the newest-release run.
- **Harness.** Results-branch commit `b92b3daa5`, which the preregistration's records name: the November 19 harness, plus the control program ([old-build-control.ts](../../eval/runner/cat40/old-build-control.ts)), the analysis control mode, and the served-model recording. A keyless test checks each gbrain step's arguments against the November 19 receipts.
- **Pilots.** A five-cell smoke per reader and world, one per family: 20 cells, all submitted and right, with no harness error, before any counted cell.
- **Counted cells.** 400 cells, all complete on the first attempt, with no harness error; 360 submitted and 40 reached the turn limit.
- **Budget.** Below the level at which an interim look is required, so none was taken. Each world ran on its own VM with one ledger; every request was reserved and reconciled, and no step reached its cap.
- **After the counted cells.** The analysis's widened-session sensitivity first matched transcripts to cells by attempt id across both worlds. Attempt ids repeat between worlds, so 5 of the 21 widened pairs were missed. Commit `aaabf3702` reads transcripts per world, with a keyless test, and the sensitivity above uses it. Nothing else in the analysis changed.

## Limits

- The files and newest-gbrain cells ran earlier on 2026-11-19 than the control's. Served model ids were recorded only for the control.
- `09d21554d` and v0.60.742.0 differ by every gbrain change between them, so "not a regression" covers that span on these worlds, not each change.
- Two worlds can't estimate between-world variance. The intervals are conditional on N1 and N2, and N1 alone leans the other way (newest minus old -4.50, 0.00 at the top of its interval).
- October's +8.50 for this build was on other worlds (P1 and P2), read by Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol, with an earlier files agent. That comparison is unpaired, so this run says the drop doesn't meet the preregistered regression rule (the newest build could still be up to 4.50 points below October's), not which of the worlds, readers or files agent caused the rest.
- The preregistered descriptive bridge to October (Opus 5.5 only, October's P1 and P2 beside N1 and N2) is not reported. The Opus-only difference on N1 and N2 is in the per-reader table (+4.50, -1.50 to +11.00).
- One attempt per task, so per-family and per-reader intervals are wide. They are secondary and uncorrected.
- **One newest-build cell was not retried as the preregistration requires.** The control reuses the newest-release run's cells, and there N1 `gbrain-opus-b` task H4-13 ended on an Anthropic server error (HTTP 520) and was scored as a wrong answer with no retry ([its run notes](2026-11-19-cat40-hard-newest.md)). A retry could only score it right or wrong: right would move newest minus old to -1.25 (-4.25 to +1.75), and on H4 to -3.75 (-11.25 to +3.75); wrong leaves the numbers above. The outcome row is "not a regression" either way, and the October build's difference from files doesn't use that cell. The reproduce command below names the cell for this reason.

## Files

- [`n1/`](2026-11-19-cat40-hard-old-build-control/n1) and [`n2/`](2026-11-19-cat40-hard-old-build-control/n2): the counted steps `gbrain-old-{opus,sol}-{a,b}`, the pilots `smoke-{opus,sol}` and the slot receipt, each with its `attempts.jsonl` (one line per cell, with score, claims, cost and served model ids), `experiment.json`, receipts, and the served gbrain instructions and tools. Caps are redacted from the receipts.
- [`analysis/control.json`](2026-11-19-cat40-hard-old-build-control/analysis/control.json): every figure above, the tool-call counts and the widened-session sensitivity.
- Transcripts are kept outside the repository; `control.json` holds the counts taken from them.
- To reproduce the headline, run this from the repository root:

  ```bash
  C=docs/benchmarks/2026-11-19-cat40-hard-old-build-control; D=docs/benchmarks/2026-11-19-cat40-hard-newest
  f() { echo $C/$1/gbrain-old-{opus,sol}-{a,b}/attempts.jsonl $D/$1/{gbrain,fs}-{opus,sol}-{a,b}/attempts.jsonl | tr ' ' ','; }
  python3 eval/runner/cat40/newest_analysis.py --look control --old gbrain-old-09d --world N1=$(f n1) --world N2=$(f n2) \
    --accept-unretried 'N1|gbrain-newest|claude-opus-5-5|H4-13'
  ```

## Disclosures

gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

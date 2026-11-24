# Preregistration: does delivering long documents by section close gbrain's gap to plain files when sources disagree? (Cat 40 Hard H4, sealed confirmation)

Written 2026-11-24. The file freezes when its pull request merges, before the first paid request. Values that don't
exist yet (the gbrain release and commit, the sealed seeds' digests, the harness commit, the judge check's result,
the ledger run ids) are appended under "Recorded before cells" before the first counted
cell. Any other change after the merge is a dated amendment at the end, never an edit.

## Question

On hard company questions where documents disagree (family H4: a contract and its amendments, a draft, an email and
an agent note give different values, and the agent must find the one in force), gbrain trails an agent that reads
plain Markdown files with grep. At gbrain v0.60.742.0 on the public worlds N1 and N2, gbrain got 20 H4 items wrong
against the files agent's 1 of 284, counted from the committed cells of the
[2026-11-19 newest-release run](2026-11-19-cat40-hard-newest.md). In a development rerun of the same H4 tasks at
v0.60.769.0, Opus 5.5 solved 31 of 40 on gbrain, against 40 of 40 for the files agent in the 2026-11-19 run.

A development diagnosis on N1 and N2 (GBEV-134, public worlds only) found that in every wrong item the clause that
decides the answer never reached the model: search returned a long amendment's head chunk and the agent never opened
it; the agent opened it but asked `get_page` grep for `a|b`, which gbrain reads as a literal string; or the governing
record names its account only by a manager phrase and no search returned it. A prototype that delivers long hits as
their matching section by default (gbrain's existing `search.long_page_unit=section`, today off) and reads `a|b` in
grep as alternatives took Opus 5.5 from 31 to 37 of 40 H4 tasks (8 fixed, 2 broken) and GPT-6.2 Sol from 37 to 36 (1
fixed, 2 broken), one repeat; on the other four families it showed no harm (pooled +2.1 points, 95% interval -2.1 to
+6.3, on 96 of the 160 tasks). That patch went to gbrain's maintainers (GBRA-108) as a proposed fix, with the effect
labelled a development signal (two-sided sign test p = 0.11 for Opus), not a confirmed one. GBRA-108 took the grep
change as a bug fix (GST-3786: an inner `a|b` returns the literal match and each alternative) and kept section
delivery off by default: flipping a default needs Garry's approval, and this run is the evidence that would go to
him. Section delivery is already a setting (`search.long_page_unit=section`) on current releases.

**The question:** on new sealed worlds gbrain has never been tuned on, does turning section delivery on answer more H4
tasks than the same release on its defaults, paired by task, without losing ground on the other four families, and
how far is gbrain then from the files agent? The answer decides whether the default flip goes to Garry: a sealed win
takes it to him with these numbers, and a null or a loss closes it.

## Public lesson

- If section delivery helps: "We learned that a memory tool lost 'sources disagree' questions because the deciding clause in a
  long contract never reached the model, and that sending the matching section instead of the page's first chunk won
  back +X points on worlds it was never tuned on. You should check that the sentence that decides an answer lands in
  your agent's context, not only that the right document is in the result list."
- If it doesn't: "We learned that delivering long documents by section did not move 'sources disagree' questions on
  unseen company documents (+X points, interval Y to Z), though it did on the worlds we diagnosed. You should expect
  retrieval fixes found on one document style to need a check on another before they ship as defaults."

## Evidence class

Held-out confirmation on new sealed worlds. The sealed generator (`hard-sealed-v2`,
[SEALED.md](cat40-hard/SEALED.md)) was written separately from the public one, in other document styles, names and
folder layouts, and its long documents also bury the deciding clause among numbered general clauses, so the mechanism
under test can occur there. Its only earlier seed has run twice and is no longer held out, so this run mints new
seeds. The change was found on public worlds N1 and N2; neither is reused.

## Build and data

- **Launch gate.** No counted cell runs until gbrain tags a release that contains GBRA-108's grep fix (GST-3786). This
  file can merge before that. If the grep fix changes shape again or is withdrawn, the change is recorded by dated
  amendment before any cell.
- **gbrain build.** The newest release on gbrain's master at launch, read with
  `git ls-remote --tags https://github.com/garrytan/gbrain.git`, which must contain the GST-3786 commit or commits; if
  it doesn't, no cell runs. Both gbrain arms run that same release, so they differ only by one setting. The harness
  pins the embedding model to `openai:text-embedding-3-large` for every gbrain brain. The prebuilt brains are built
  once per world by that release, with no build config, and both arms read the same brains (section delivery is a
  read-time setting). The build freezes once its first slot is built.
- **Harness.** The gbrain-evals commit that carries this file and, on the results branch before any cell: the sealed
  seeds' registration; a step program `eval/runner/cat40/h4fix-confirm.ts` with a keyless test (one build and two gbrain arms per world,
  H4 halves, repeat 2 on the gbrain arms' H4 cells only, the judge map in "Readers and judges", every step cap above
  one worst-case request reservation); and the analysis script `eval/runner/cat40/h4fix_analysis.py` with keyless
  fixture tests. One Opus reader reads those commits before the paid window opens. Recorded before cells. Frozen
  Hard files that changed since `freeze.json` are listed in [accepted-drift.json](cat40-hard/accepted-drift.json) with
  a dated note, and counted runs pass `--accept-freeze-drift`. The world-shaping code is unchanged.
- **Worlds.** Six new sealed worlds, S3 to S8: generator `hard-sealed-v2`, `--scale large` (about 55,000 documents),
  the frozen knobs ([knobs.frozen.json](cat40-hard/knobs.frozen.json)), 100 tasks each (20 per family, H1 to H5).
  - The seeds are chosen on the seed owner's machine, kept in owner custody and never committed or put on Capy Drive,
    as for S1 and S2. Each world's digest is recorded with `--digest-only` (no document written or read) and appended
    below before any world is generated. A seed that fails the generator's own checks is replaced by the next seed in
    steps of 1,000 and the failure is reported as a count.
  - **H4 runs on all six worlds (120 tasks). H1, H2, H3 and H5 run on S3 and S4 only (160 tasks).** H4 needs the
    sample; the other families only need to show section delivery costs nothing.
  - **Custody route.** The seed owner generates each world on their own machine, the world file is copied to its custody
    VM and checked there by SHA-256, and no agent reads a seed. Before the first world exists, the results branch adds
    Cat 40 sealed patterns to the `sealed` key of `.gstack/pregate.json`, so a sealed task id, document id or answer
    string cannot be pushed, and updates [SEALED.md](cat40-hard/SEALED.md)'s digests and status.
  - **What may be committed:** per-arm, per-reader, per-family and per-world success counts, the endpoint table with
    intervals, cost per correct answer, the transcript statistics of secondary 4 as counts, slot receipts and served
    hashes. Never answers, claims text, task text, document text, transcripts or `attempts.jsonl`. Nobody opens task or
    document text before the results.

## Arms

| Arm | What the agent gets | Role |
|---|---|---|
| `gbrain-section` | gbrain over MCP at the release under test, default tool list, served instructions, prebuilt brains, with `--gbrain-config search.long_page_unit=section` | system under test |
| `gbrain-default` | the same release and brains on its shipping defaults (section delivery off) | paired comparator for the primary endpoint |
| `fs` | `list_dir`, `grep` and `read_file` over the same documents as Markdown files, `--hard-tool-limits hard` | comparator for the gap |
| `oracle` | the documents each task's answer key names, in the prompt | ceiling gate only, never in an endpoint |

Fixed for every arm: the 16-turn cap, `--transcripts`, every task in each world's planned families, and every setting
not named here equal to the 2026-11-19 newest-release run. Slots: 5 per world on S3 and S4 (concurrency 10), 2 per
world on S5 to S8 (concurrency 4); the config readback shows `search.long_page_unit` = `section` for `gbrain-section`
and `{}` for `gbrain-default` on every slot. **Repeats:** the two gbrain arms run every H4 task twice (repeat 2) for both
frontier readers; everything else runs once. A task's success in an arm is the mean over its repeats.

## Readers and judges

- **Readers:** `claude-opus-5-5` (primary), `gpt-6.2-sol`, and `particle-1`, the repository's primary low-cost model.
  particle-1 reads every planned cell of all three arms, H4 primary cells included (repeat 1), as a descriptive reader:
  its Δ_H4 and gap are reported with intervals and never enter the primary or a pooled endpoint. Its cells run inside
  one granted paid window, one world at a time, after that world's frontier cells. Opus 5.5 and GPT-6.2 Sol at provider default effort; particle-1 at
  `reasoning_effort: high` with a 16,000-token output limit, as in the 2026-11-19 run. Opus 5.5 is primary because it
  is the repository's primary model and the reader whose H4 failures the diagnosis traced; GPT-6.2 Sol solved 37 of 40
  development H4 tasks at baseline, leaving little room to move.
- **Model freshness** (`bun scripts/model-freshness.ts`) runs on the day of the first counted cell. A newer frontier
  Opus or GPT stops the run until a dated amendment names it.
- **Claims judge** (`cat40-hard-claims-v1`). It lists each claim in an answer and marks it supported, contradicted or
  unsupported; it never decides success, which the deterministic scorer (`cat40-hard-score-v2`) does.
  `gpt-6.2-sol` grades the Claude Opus 5.5 rows; `claude-opus-5-5` grades the GPT-6.2 Sol rows and the particle-1
  rows. No model grades its own family's rows, no older generation sits in a judge role, particle-1 never judges, and
  each row records its judge. The judge's output feeds one secondary endpoint (contradicted claims per answer, below);
  the Hard runner requires a judge on every cell, so it runs on every counted cell either way.
- **Judge check (before any counted cell), per judge.** Each judge grades its own set of 100 constructed answers on
  the public world N1's tasks, 20 per family, 50 good (the accepted value with its governing documents) and 50 bad (a
  listed wrong value, an extra H1 entity, a changed count or a value attributed to the wrong account), written in the
  answer style of the readers whose rows it will count (Opus 5.5 answers for `gpt-6.2-sol`; GPT-6.2 Sol and particle-1
  answers for `claude-opus-5-5`). The construction label is the reference, so these are construction-labelled, not
  model-labelled. A judge passes at Cohen's kappa of at least 0.6, reading "at least one contradicted or unsupported
  claim" as bad, with at least 40 items of each class graded and at most 1% unparseable; its errors are reported per
  arm. A judge that fails leaves the claim endpoints of the rows
  it grades descriptive; the success endpoints use no judge and are unaffected.

## Metric and denominator

- **Primary metric: success**, from the deterministic scorer: every item of a multi-account task right, no listed wrong
  value, sets and counts exact, H5 scored on its final session.
- **Canonical cell:** the last harness-clean attempt per arm, reader, task and repeat. Only harness errors (a provider
  5xx or 429 after backoff, a provider edge error page such as a 520 before any tool call, or a slot, server, restore or
  MCP transport failure) are retried, at most twice. A turn-cap stop, no tool call, malformed tool use, a context-length
  error or a provider safety-filter stop counts as a failure, and safety-filter stops are also reported on their own
  line. A cell with no harness-clean attempt after its retries is resumed, never counted as a failure, and the analysis
  refuses to compute an endpoint while any planned cell is missing.
- **Unit and clusters:** the task. Intervals use the nested task bootstrap of the 2026-11-19 run: 10,000 resamples
  from one `random.Random(1)` stream, worlds held fixed and visited in order (S3 to S8), task ids drawn with
  replacement within each world (`rng.choice` over ids sorted as strings), a drawn task bringing all its cells; the
  interval is the 2.5th and 97.5th percentiles (or the interim-adjusted level below). Intervals are conditional on
  these worlds.

## Decision rule

- **Primary endpoint.** Δ_H4 = `gbrain-section` success minus `gbrain-default` success on H4, paired by task, for
  claude-opus-5-5, over all 120 H4 tasks, with its 95% interval.
- **Key secondary endpoints**, reported with the same bootstrap and no multiplicity correction, labelled secondary:
  1. Δ_H4 pooled over Opus 5.5 and GPT-6.2 Sol (each task's two readers averaged), and Δ_H4 for GPT-6.2 Sol alone.
  2. **No harm:** Δ_other = `gbrain-section` minus `gbrain-default` on H1, H2, H3 and H5 (160 tasks), pooled over the two
     frontier readers. Section delivery **does no harm** when Δ_other's lower bound is above -5 points. The margin is at least
     the detectable difference below (4.5 points); if the recorded values before cells put that difference above 5,
     the margin becomes that difference.
  3. **The gap:** `gbrain-section` minus `fs` on H4, per reader and pooled. "Level with files" when the interval's lower
     bound is above -3 points and its upper bound is not below 0; "behind files" when the upper bound is below 0;
     otherwise "not distinguishable from files", with the point estimate. With files near the ceiling on H4, the pooled
     gap's detectable difference is about 7 points, so "level" needs a gap near zero.
  4. From the transcripts, per gbrain arm: searches where a long page was delivered as its section, grep calls with
     `a|b` and how many returned matches, and H4 items whose governing document was never returned, grouped by how the
     record names its account (name, code, nickname, manager phrase).
  5. particle-1's Δ_H4 and gap, descriptive. The first results table shows claude-opus-5-5 and particle-1 with cost per
     correct answer.
  6. Cost per cell and per correct answer for each gbrain arm and reader (the prototype raised Opus's H4 cost per cell
     by about a fifth).
  7. Contradicted claims per answer, per arm and reader, from the claims judge.
- **Wording.** "Helps" when the primary interval's lower bound is above 0; "hurts" when its upper bound is below 0;
  otherwise "not distinguishable", with the point estimate.
- **Smallest detectable difference** (two-sided α 0.05, 80% power, 2.8 standard errors), estimated from GBEV-134's
  development cells on N1 and N2 (one repeat, 40 H4 tasks, scaled to 120 tasks, with no credit taken for the second
  repeat):

| Comparison | Detectable difference |
|---|---:|
| Primary: Δ_H4, Opus 5.5, 120 tasks | 12.2 points |
| Δ_H4 pooled over Opus 5.5 and GPT-6.2 Sol | 7.0 points |
| No harm: Δ_other, pooled, 160 tasks | 4.5 points |

  The development effect on Opus 5.5 was +15 points on 40 tasks, near the primary's detectable difference. Two things
  make the sealed effect likely smaller: it came from the worlds the change was found on, and it measured section
  delivery and the grep fix together, while here both arms carry the grep fix (7 of the 14 items the prototype fixed
  reached the model through section delivery). At half the
  development effect (+7.5 points) the primary has about 40% power; a result "not distinguishable" at that size is
  expected and is read through the Why-null cycle, not as evidence of no effect.

## What each outcome changes

| Result | Then |
|---|---|
| Helps, and does no harm | The default flip goes to Garry, through GBRA-108, with these numbers: the paired H4 gain, the no-harm interval, the cost per cell and the remaining gap to files. README's H4 limit line is replaced with this result once a release ships the flip |
| Helps, but harm is not ruled out (Δ_other's lower bound at or below -5) | The flip does not go to Garry as it stands; GBRA-108 gets the per-family split as evidence for a scoped version (contract and amendment pages, or keyword searches), which would need its own check |
| Not distinguishable | The flip is closed. One "Why null?" cycle from secondary 4 (did section delivery fire on sealed worlds, did long documents cross the 20,000-character threshold, did the 5-page cap bite, did the governing record come back at all) records why, with a verdict, weighing the cost per cell (secondary 6): KEEP as an opt-in setting, FIX-METHOD or CUT-CANDIDATE, any cut candidate reported to Garry in plain words |
| Hurts | The flip is closed, and GBRA-108 gets the paired numbers and the transcript statistics |
| `gbrain-section` is level with files on H4 | README says gbrain is level with plain files on these questions, with the interval |
| The gap is not distinguishable from files | README gives the gap with its interval and says the run cannot tell level from behind |
| `gbrain-section` is still behind files on H4 | README says so with the number, and the gap's share from manager-phrase records (secondary 4) goes to GBRA-108 |

## Gates before counted cells (per world)

1. The world validates and its digest equals the one recorded below.
2. The judge check has run and its result is recorded below.
3. Every slot passes the write, restore and rerank probes with 0 queued persistence effects at
   snapshot, the config reads back as each arm sets it, and the served instructions' and tools' hashes are recorded per arm.
4. Oracle on every planned task with Opus 5.5 and GPT-6.2 Sol: pooled success at least 95%, or no counted cell runs
   on that world and the result is reported.
5. Pilots (below) pass.
6. Model freshness passes on the day of the first counted cell.

## Pilot per arm

Each arm's pilot costs at most a tenth of that arm's planned spend and runs before its counted cells, on S3: five cells
per frontier reader, one task per family. A pilot shows the part under test ran on the arm's own outputs, that tasks
can be supplied at the planned concurrency with no rate-limit stop, and that the judges pass the judge check above.
- `gbrain-section`: every cell calls gbrain tools, none gets `param_not_on_surface`, and at least one search across the
  arm's pilot and the S3 oracle-gate H4 probe shows section delivery firing (a search row carrying `delivered: {unit: "section"}`). If no pilot cell exercises it, five more H4 cells on S3 run as the pilot;
  if those don't either, the arm is reported as not exercised and the run stops for a dated amendment.
- `gbrain-default`: every cell calls gbrain tools, none gets `param_not_on_surface`, and no search row carries `delivered: {unit: "section"}`.
- `fs`: every cell calls `grep` and `read_file`.
- particle-1, in its paid window: five cells per gbrain arm and five on `fs` on S3, one per family, end submitted or at
  the turn cap with no context-length or rate-limit stop.
An arm that fails is fixed or left out and reported as left out.

## Interim look

Planned paid spend is above the size at which the factory's rules require an interim look, so the primary endpoint takes one look at half its units (R113). The H4 cells run in
two halves fixed by task id: half A is H4 tasks 01 to 10 of every world (60 tasks), half B tasks 11 to 20. When half A
has finished for both gbrain arms and both frontier readers, the look computes z = Δ_H4 (Opus 5.5, half A) divided by
its bootstrap standard error.
- **Stop for a difference** if |z| ≥ 2.80, either direction.
- **Stop for futility** if conditional power to end with z ≥ 1.98 under the planned effect of +12.2 points (the
  primary's detectable difference), at information fraction 0.5, is below 10%.
- **Otherwise half B runs**, and the final primary interval is the bootstrap percentile interval at the 1.98 level
  (2.39% to 97.61%).
**What a stop ends.** A stop for a difference or for futility ends every half-B H4 cell in every arm and reader
(`gbrain-section`, `gbrain-default`, `fs`, particle-1 included). The H4 secondaries (1, 3, 4, 5 and the H4 parts of 6 and
7) are then computed on half A and labelled "half A only". The non-H4 families (secondary 2 and their parts of 6 and
7) run in full whichever way the look goes. **Which interval each outcome row reads:** after a stop for a difference,
the primary rows read the half-A interval at z 2.80 (0.26% to 99.74%) and the estimate is reported as possibly
overstated; after a stop for futility, the primary is "not distinguishable" and the Why-null row applies; after a
continue, every row reads the final interval at the 1.98 level. Secondary intervals are always 95%. A run that stops
early says so wherever it reports. No other look at the primary endpoint counts.

## Budget

Each world's cells run on a Ubicloud VM in owner custody, detached, with one budget ledger per VM and one writer. Every
request is reserved against that ledger before it is sent (`eval/runner/budget-ledger.ts`), and every step passes its
own `--budget-usd`. A cap is set in each ledger; reaching it pauses the run at the cell boundary until the cap is
extended, and the same step command resumes it. It never ends the test incomplete. The VMs share provider keys, so each VM lowers its concurrency if
rate-limit retries rise, and the fan-out stays within the crew's Ubicloud share. The VMs are destroyed when their runs
end. Dollar amounts stay in the tracking issue (GST-3683).

## Known limitations

- The development effect measured section delivery and the grep fix together; this run measures section delivery
  alone, on a release that already carries the grep fix, so its effect may be smaller.
- **Known limits, not arms.** Section delivery widens at most 5 long pages per search, in rank order, so a deciding
  page ranked lower keeps its head chunk; and records that name their account only by a manager phrase are not
  linked to the account, the largest H4 miss left on the development worlds. Neither is changed here; secondary 4
  counts how many misses each explains.
- Sealed worlds count H4 tasks with long deciding documents only by variant; the share of H4 items whose deciding
  clause sits deep in a long document is recorded as a count before cells and may differ from N1 and N2.
- Intervals are conditional on six worlds; between-world variance is not estimated.
- The primary endpoint is one reader. GPT-6.2 Sol's development baseline left little headroom.
- The detectable differences come from one development repeat on two public worlds.

## Recorded before cells

To be appended before the first counted cell: the GST-3786 commits and the release under test with its commit;
gbrain's own provider models on the build (embedding pin, reranker, query expansion); the harness commit; the six worlds' digests, document counts and H4 variant
counts; the judge check's result; model freshness; slot receipts and served hashes per arm; the oracle gate; pilots;
the VM names and ledger run ids.

## Amendments

None yet.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which
makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of
Y Combinator. Garry Tan runs Y Combinator.

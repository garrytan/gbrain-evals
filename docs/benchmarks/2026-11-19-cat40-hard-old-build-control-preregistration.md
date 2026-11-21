# Preregistration: did gbrain or the worlds change? An old-build control for the hard company questions (Cat 40 Hard)

Written 2026-11-19. The file freezes when its pull request merges, before the first paid request. Values that don't exist yet (the harness commit, the slot receipts, the ledger run ids) are appended under "Recorded before cells" before the first counted cell. Any other change after the merge is a dated amendment at the end, never an edit.

## Question

The [November 19 re-measure](2026-11-19-cat40-hard-newest-preregistration.md) ran gbrain's newest release, v0.60.742.0 (`ae8201041`), on two new worlds from the public generator, N1 (seed 20261141) and N2 (seed 20263151), against an agent that reads the same documents as Markdown files with grep. gbrain got 325 and files 315 of 400 answers right: +2.50 points, interval -1.50 to +6.50, so the two are at parity. The October builds had led by 7.7 to 13.0 points on other worlds. Both the build and the worlds changed, so that run can't say which one moved the number.

**The question:** on the same two worlds, with the same harness and readers, does an October build of gbrain still lead the files agent by as much as the published rows allow?

## What the result changes

The rule was set before any control cell: if the old build keeps a lead of +5.3 points or more on N1 and N2, it is a gbrain regression and is reported to gbrain's maintainers as one; if it also lands below that, near the newest build's +2.5, it is not a gbrain regression, unless the paired newest-minus-old interval lies below 0, which the table treats as a smaller regression. (The rule as first set said README would then call the new worlds harder. The plan review pointed out that readers and the files agent's loop also changed since October, so the wording was narrowed, and the pre-merge review added the smaller-regression row, both before this file froze.) The threshold +5.3 is the November 19 preregistration's "holds" bound: 12.50 minus that run's detectable difference of 7.2 against row 2's public half.

| Result | Then |
|---|---|
| Δ_old (old build minus files) is **+5.3 or more** | A gbrain regression. README's hard-company row says the newest release is level with files on these worlds where the October build `09d21554d` led by +X, and that the drop is in gbrain. gbrain's maintainers get a regression report with the paired newest-minus-old difference per family, the tool-call statistics of both builds, and changes 1 to 3 of the November 19 preregistration named as suspects, not causes |
| Δ_old is **below +5.3**, and the 95% interval of newest minus old includes 0 | Not a gbrain regression. README says the old build also lands below +5.3 on these worlds, so the drop from October's numbers comes from the worlds, the readers or the files agent, which this run doesn't separate. The earlier leads stay in README's footnotes, labelled with their worlds, readers and builds |
| Δ_old is below +5.3, and the 95% interval of newest minus old lies **below 0** | A smaller gbrain regression. The old build's lead over files is under +5.3, but on the same tasks the newest build scores below it. README says so with the paired difference: the build explains part of the drop from October's numbers, and the worlds, the readers or the files agent the rest. It is reported to gbrain's maintainers as a regression, as in the first row |
| Δ_old is below +5.3 and newest minus old is **above 0** (its 95% interval lies above 0) | Not a regression, and the newest build improved on the old one on these worlds. README says both, with the paired difference |
| H4 ("sources disagree"): the paired newest-minus-old H4 difference has its 95% upper bound below 0 | The H4 gap goes to gbrain's maintainers as a regression on that family, with both builds' H4 rows. Otherwise H4 stays a known limit of both builds, and each build's H4 row against files is reported, descriptive |

The paired difference between the two gbrain builds (newest minus old, same tasks, same readers) is reported beside the decision with its 95% interval. It changes the decision only as the table says: Δ_old at +5.3 or more is a regression whatever the paired interval shows, and below +5.3 the paired interval decides between not a regression, a smaller regression and an improvement.

## Public lesson

- If it's the build: "We learned that gbrain's newest release lost most of its lead over grep on hard company questions: on the same two worlds, its October build led by +X points and the newest is level. You should re-measure an agent's memory tool when its search options change, because agents lean on the options they are shown."
- If it's not the build: "We learned that on two new worlds where gbrain's newest release is near level with grep, its October build is too (+X points, under +5.3 and level with the newest build within noise), so the smaller lead is not a gbrain regression; it comes from the worlds, the readers or the grep agent, which this run can't separate. You should measure a memory tool on more than one world, with today's readers, before quoting its lead."
- If it's a smaller regression: "We learned that gbrain's newest release scores below its October build on the same hard company questions (newest minus old: -X points, interval ...), though the October build's lead over grep on these worlds is also under +5.3. You should re-measure an agent's memory tool when its search options change."
- If the newest build improved: "We learned that gbrain's newest release scores above its October build on the same questions (+X points), so the smaller lead comes from the worlds, the readers or the grep agent. You should measure a memory tool on more than one world before quoting its lead."

## Evidence class

A controlled comparison on the November 19 run's two held-out worlds. The only planned difference from that run's gbrain arm is the gbrain build. The files arm is not rerun (below).

## Build

- **Old build: gbrain `09d21554d`** (`09d21554d7ab75cc5643a7f5a0e7f163aa4dae5b`, gbrain v0.60.189.0, merged 2026-10-13 as gbrain#6566), on shipping defaults with no `--gbrain-config` and no build config.
- **Why `09d21554d` and not `4e10136b4`.** `4e10136b4`, row 2's build, was the first choice, and `09d21554d` is the build the November 19 preregistration named for this control. `09d21554d` is used, for three reasons:
  1. It is the only October build measured on the public generator on defaults with no config: +8.50 points (+4.83 to +12.33) on public worlds P1 and P2, as row 2's baseline ([October 15](2026-10-15-cat40-next-confirm/README.md)). That is the same posture as the newest run, so the build is the only thing that changes.
  2. `4e10136b4`'s published leads need settings the newest run doesn't use. Its +12.50 on public worlds needed owner-phrase links (F5, `mentions.owner_phrases=true`), which failed its condition to ship. Its +10.67 on sealed worlds needed six non-default settings (`entity.names_references`, `entity.record_types=contract,amendment`, `entity.row_page_status`, `search.long_page_unit=section`, `search.long_page_min_chars=20000`, `mcp.instructions_governing_rule=in_effect`). A control at `4e10136b4` would change those settings along with the build. On defaults, `4e10136b4` was never measured.
  3. Without F5, `4e10136b4`'s settings measured level with `09d21554d` on the sealed worlds (-1.17 points, -4.33 to +2.00), and level with the no-config control in October's development round 3 (-0.5, -3.8 to +2.8). So `09d21554d` on defaults also stands in for `4e10136b4` as it shipped.
  Both builds predate changes 1 to 4 of the November 19 preregistration.
- **Surface, pinned explicitly.** Every gbrain cell and smoke runs `gbrain serve --surface starter` over stdio, with `--surface starter` passed on the command line, not left to the default. The receipts must record surface `starter` and no advertised surface, and the served tool list is recorded per step. `09d21554d`'s starter surface lists search options that v0.60.742.0 hides (`snippet_chars`, `mode`, `token_budget`); that difference is part of the build under test. The count of cells where the agent widens its own session with gbrain's `request_tools`, where the build has it, is reported for both builds, with the headline recomputed without those cells (descriptive).
- **Slots.** Five prebuilt brains per world, built by `09d21554d` from the same world files, with the same embedding and reranking providers its own defaults use. Both worlds' slot receipts must name `09d21554d`.
- **Harness.** The November 19 run's counted harness, plus one control program committed on the results branch before any paid request, which adds `--surface starter` and the control's label and ledgers and changes nothing else; a keyless test checks that every gbrain step's arguments equal the November 19 counted receipts' arguments except the label, ledger, budget, build commit and the explicit surface. The analysis gains a control mode (95% intervals for Δ_old and for newest minus old from one bootstrap stream, the outcome rows above, and a refusal while any planned cell of the three arms is missing), pinned by a keyless test. Its commit and the accepted freeze drift (the November 19 entries in [accepted-drift.json](cat40-hard/accepted-drift.json)) are recorded below before cells, and every step passes `--accept-freeze-drift`. If the harness's slot probes (write, restore, fail-closed rerank) or the restore path can't run on `09d21554d`, the needed harness fix is a dated amendment, with a keyless test, before any paid cell. A keyless check on 2026-11-19 ran this harness against `09d21554d` on the small v1 world: the slot build, the write and restore probes and 50 scripted cells passed with surface `starter`, no config and no harness error. The rerank probe needs provider keys, so it first runs at gate 2.
- **Worlds.** N1 and N2, the November 19 files. Each must match its recorded digest (N1 `647d6123…`, N2 `08120edc…`) before its slots are built.

## Arms

| Arm | What the agent gets | Role |
|---|---|---|
| `gbrain-old` | gbrain `09d21554d` over MCP on the starter surface, from one of five prebuilt brains per world, with that build's server instructions | system under test |
| `fs` | the November 19 run's counted files cells on the same worlds, tasks and readers, unchanged | comparator, reused |
| `gbrain` (newest) | the November 19 run's counted gbrain cells, unchanged | for the paired newest-minus-old difference only |

**The files arm is reused, not rerun.** It doesn't touch gbrain, and its counted cells already cover every task on both worlds for both readers. Rerunning it would add a second day of model variation on the comparator and roughly double the spend. Fixed for the new arm, as in the November 19 run: the 16-turn cap, 5 slots per world, concurrency 10, repeat 1, `--transcripts`, every task in each world.

## Readers and judges

- **Readers:** `claude-opus-5-5` and `gpt-6.2-sol`, the November 19 run's frontier readers, at provider default effort, so every cell pairs with that run's cells. No freshness gate: a newer frontier model would break the pairing, so the readers are fixed to the run being controlled. particle-1 is left out: the decision reads only the pooled frontier Δ, and the November 19 run reports particle-1 itself. So the first table shows claude-opus-5-5 with cost per correct answer and particle-1 marked "not run in this control", with that reason. An older gbrain build is measured here because the question is about that build (CLAUDE.md, "Choose the gbrain build"; R100).
- **Claims judge** (`cat40-hard-claims-v1`): `gpt-6.1-sol` grades the Opus rows and `claude-opus-5-5` grades the Sol rows, as on November 19, where both judges passed the judge check (kappa at least 0.6). It never decides success, which the deterministic scorer (`cat40-hard-score-v2`) does, and its counts are descriptive here.

## Metric and denominator

As the November 19 preregistration: success from the deterministic scorer, the last harness-clean attempt per arm, reader and task, harness errors retried at most twice and otherwise resumed, never counted as failures, and the nested task bootstrap (10,000 resamples, `random.Random(1)`, tasks nested in worlds, worlds fixed). 200 tasks per reader and arm.

- **Primary:** Δ_old = `gbrain-old` success minus files success, paired by task, pooled over the two readers on all 200 tasks, with its 95% interval. The decision rule above reads its point estimate, and below +5.3 also the 95% interval of newest minus old.
- **Descriptive bridge to October, Opus 5.5 only:** `09d21554d` minus files on N1 and N2 next to the same difference on October's P1 and P2, with each interval. The worlds and the files loop differ, so it is unpaired and shown for context only.
- **Secondary, no correction:** the paired newest-minus-old difference per reader (the pooled one is decision-bearing, above), per world and per family (H4 split by its `+long` variants); Δ_old per reader, world and family; wrong-value rate, wrong submissions, non-submission and turn-cap stops; cost per correct answer; and from the transcripts, searches by option, searches with no `limit`, empty searches, `param_not_on_surface` refusals and `request_tools` widening, for both builds.

## Smallest detectable difference

The November 19 run's paired standard error for gbrain minus files, pooled, was 1.98 points, so 2.8 standard errors is about **5.5 points** for Δ_old against 0. The same figure is assumed for the newest-minus-old difference; two gbrain builds probably agree more often than gbrain and files do, which would make it smaller. The decision compares Δ_old with +5.3, which sits 2.8 points above the newest build's +2.50: a true old-build lead at +5.3 would be called a regression about half the time, and the interval is printed so the reader can see how close it is. With a standard error of about 1.98 points: if the old build truly matches the newest one (+2.5), the chance of a false regression call (an estimate of +5.3 or more) is about 8%; if it truly kept October's public-world lead (+8.5), the chance of missing the regression is about 5%. The standard error of newest minus old isn't known before cells, because it depends on how often the two builds agree on a task; it is about 2.0 points if the two builds agree on a task as often as gbrain and files do, and about 2.8 points if their cells were independent. Both gbrain arms pair with the same files cells, so newest minus old equals +2.50 minus Δ_old exactly. Below +5.3 its point estimate is therefore above -2.8, and its 95% interval lies below 0 only if its standard error is under about 1.43 points. At the expected 2.0 to 2.8 points, the smaller-regression row will almost never fire, so in practice the regression call is Δ_old at +5.3 or more; when Δ_old is below +5.3 and newest minus old is below 0 but its interval includes 0, the not-a-regression row applies and the results add the descriptive note "newest lower, within noise".

## Gates before counted cells (per world)

1. The world file matches its recorded digest.
2. Every slot passes the write, restore and fail-closed rerank probes with 0 queued persistence effects, the config readback shows no config, and the receipt names `09d21554d` and surface `starter`.
3. A five-cell `gbrain-old` smoke per reader (one per family) halts on any harness error and shows the build under test answered through its own tools (R111 pilot, never counted). Its cost is far under a tenth of the arm's.
4. The slot receipts and smokes are committed under "Recorded before cells" before any counted cell.

## Budget

Each world runs on its own Ubicloud VM, detached, with one budget ledger and one writer; every request is reserved before it is sent, every step passes its own `--budget-usd`, and reaching a cap pauses at the cell boundary until it is extended, never ending the test incomplete. The planned spend (two gbrain arms on two worlds, priced from the November 19 run's cells, plus slot builds) and the summed ledger caps stay below the level at which R113 requires one interim look, so none is taken. Spending past that level would need a dated amendment that adds the interim look first. The VMs are destroyed when their runs end. Dollar amounts stay in the tracking issue.

## Known limitations

- The files and newest-gbrain cells ran on 2026-11-19; the control's cells run on a later day, so provider-side model changes between the days aren't controlled. Rerunning a sample of the reused cells on the control's day was considered and left out to keep within budget. Each control cell records the model id the provider served, so a silent model change between the days is visible.
- `09d21554d` and v0.60.742.0 differ by every gbrain change between 2026-10-13 and 2026-11-19, not only changes 1 to 4. A regression result names the span of builds, not one change.
- Two worlds can't estimate between-world variance; intervals are conditional on N1 and N2.
- `09d21554d`'s published +8.50 was read by Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol, not by these readers.

## Recorded before cells

Recorded 2026-11-19, after the gates and before any counted control cell. The records are in [2026-11-19-cat40-hard-old-build-control/](2026-11-19-cat40-hard-old-build-control/).

- **Harness.** Commit `b92b3daa5870f91548a2cfc7448ae1fe0e0b0f00` on the results branch: the control program, the analysis control mode, served-model recording and the amendment below. CI passed at this commit, and every receipt names it with a clean tree. Freeze drift is accepted through the November 19 entries and the control's `loop.ts` entry (`8e18713303bb`) in [accepted-drift.json](cat40-hard/accepted-drift.json).
- **Build.** gbrain `09d21554d7ab75cc5643a7f5a0e7f163aa4dae5b` (v0.60.189.0), with the source tree verified and the CLI version matching, on surface `starter` and no advertised surface.
- **Gate 1, worlds.** N1 digest `647d6123621842a5b43ec7291e94b440e18bd03bb0209f6b94c46d36cd5f52ac`; N2 `08120edcd14f7151ef2f785d1e62ec40639ede8fc28c49924c846b28262e3814`. Both match their records.
- **Gate 2, slots.** Five slots per world, built by `09d21554d`. Every build step exited 0, mention coverage is complete with 0 pending, and there are 0 queued persistence effects at the snapshot. The write, restore and rerank probes passed on every slot. The config reads back `{}`, with 0 owner-phrase links. Ledger runs: N1 `cat40-slot-build-2026-11-19T14-47-30-982Z-cb1357a8`, N2 `cat40-slot-build-2026-11-19T14-50-49-956Z-5418f048`.
- **Gate 3, smokes.** For each reader and world, five `gbrain-old` cells (one per family) all submitted, with no harness error, and all five succeeded. The agents answered through the build's own tools (search, get_page, entity, get_backlinks, context_pack, remember and recall). Every session's served model id equals the requested one: `claude-opus-5-5` and `gpt-6.2-sol`. The build serves 35 tools on starter, `request_tools` among them; v0.60.742.0 serves the same list plus `memory_conversation_mode`. Ledger runs: N1 Opus `cat40-model-ladder-2026-11-19T18-42-51-065Z-5a5092a3`, N1 Sol `cat40-model-ladder-2026-11-19T18-46-38-947Z-ababa3da`, N2 Opus `cat40-model-ladder-2026-11-19T18-45-37-692Z-d2f666ae`, N2 Sol `cat40-model-ladder-2026-11-19T18-49-18-756Z-9401ae41`.

## Amendments

- **2026-11-19, before any paid control request: two harness details the text above left implicit.** Nothing in the arms, worlds, gates, outcome rows or budget changes.
  1. Besides the label, ledger, budget, build commit and explicit surface, each control gbrain step has its own output directory (under `eval/reports/cat40/hard-control/`), its own slot directory, and its own freeze-drift note naming this preregistration and the control's harness commit. The keyless test ([cat40-hard-old-build-control.test.ts](../../test/eval/cat40-hard-old-build-control.test.ts)) sets aside exactly those flags and requires every other argument to match the November 19 receipts, the task lists of that run's two halves included. The control runs both halves one after the other with no look between them.
  2. To record the served model id, the agent loop (`eval/runner/cat40/loop.ts`) now keeps the `model` field of each Anthropic and OpenAI response as `served_models` on every session's run. Request bodies, retries and pricing are unchanged (pinned by `test/eval/cat40-particle-loop.test.ts`), and the new file hash is listed in [accepted-drift.json](cat40-hard/accepted-drift.json) and [calibration.md](cat40-hard/calibration.md).

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

[Disclosures](../disclosures.md) lists every relationship and where each line goes.

# Re-pin of the keyless correctness checks to gbrain v0.60.733.0 (`6ce7195b4`): updates, `forget` and privacy hold, and two numbers got worse

**Finding, 2026-11-16.** This report reruns, at gbrain's newest release v0.60.733.0 (master
`6ce7195b44a034f85aec811f11fbf862db376f50`), the correctness rows that this repository publishes from checks needing no
API key. Their counts were last measured at `77cf8e111` (v0.60.169.0) or at older builds. Three takeaways:

- **We learned that gbrain's memory-correctness guarantees still hold at v0.60.733.0.** An update is served as the new
  value (388 of 388, never stale), `forget` leaves nothing behind (0 prohibited outputs), no private page reaches a
  remote caller over real HTTP (155 of 155 cells, 0 leaks), dates come back right (513 of 513), and name resolution
  never merges two people (0 wrong merges). You can upgrade to v0.60.733.0 without re-checking these yourself.
- **Several known gaps closed.** `gbrain find-contradictions` with no `--source` now reads the latest stored run
  (bug N2-2, fixed by gbrain #6784). 4 of the 9 retrieval failure shapes an operator reported now pass, including twin
  slugs across sources and merge-redirect stubs. The search confidence grade now marks 100 of 120 answerable questions
  `moderate` and all 120 unanswerable ones `weak` (40 of 120 answerable before), so it finally separates the two.
- **Two numbers got worse, and both are in gbrain.** Keyword-only search on reworded one-hop relationship questions
  fell: recall in the top five is 0.380 → 0.511 with relationship retrieval off and on, against 0.476 → 0.572 at
  `77cf8e111`, mostly from #7201 (v0.60.338.0). Open-loop precision fell from 53 of 53 to 53 of 56: a forwarded FYI
  email whose forwarded part asks a question now opens a loop, against gbrain's own rule, since #9246 (a merge train
  after v0.60.710.0 that keeps a forwarded email's whole body).

The rest of the detail, what didn't work second and the mechanics last:

- **Lifecycle matrix.** In all six cells (PGLite and Postgres, through the CLI, MCP stdio and MCP HTTP), `forget`
  removes only what it should, no private page reaches a remote caller, renames keep their old slug and every expected
  link is found. The two CLI cells each count one acknowledged write lost, and it is a documented limit: two files that
  map to the same slug (`notes/Foo Bar.md` and `notes/foo-bar.md`) import as one page, and the sync says so ("kept
  notes/foo-bar.md. Rename one file to import both."). On PGLite with `gbrain serve` running, the embedding catch-up
  can't run from the CLI (`pglite_busy`), so the three notes written during an embedding outage stayed unembedded in
  the two PGLite MCP cells, though keyword search found all three.
- **Large pages (N14).** Five of six slices match the published wave B4 receipts number for number. The sixth, the
  128 MiB PGLite page through gbrain's own tools, crossed the runner's 6,144 MB memory ceiling (6,214 MB, and 6,194 MB
  on a second run). gbrain's own B4 build `7a6bdd3` crossed it too on the same kind of host (6,168 MB), where B4
  measured 4,920 MB, so the host and runtime caused it, not a gbrain change. README's large-page row keeps `7a6bdd3`.
- **The privacy and data-loss repros.** 9 of the 10 hold as published. The tenth, N2-2, could not run as written: its
  stand-in engine has no database, and since #6784 a scoped `find_contradictions` reads stored findings back from the
  database. A copy on a real in-memory brain shows the bug fixed at `6ce7195b4` and still present at `77cf8e111`.
- **The harness had six defects, none in gbrain.** Five were fixed with a dated amendment before the next run, each
  runner fix with a test: N4 and the lifecycle matrix compared quote-fenced facts as raw text, the lifecycle matrix
  worked inside the repository checkout, read a notice that repeats its own query as a leak, and ran a catch-up sweep
  that now asks for consent. The sixth, found after the runs, left VM paths in two runners' receipts, and only those
  path strings changed. The N2-2 repro needed a real database ([below](#harness-defects-none-in-gbrain)).

Evidence class: regression check. Every run here is keyless and cost $0 of provider spend. The VM rows ran on two
Ubicloud `standard-16` machines (part a and part b of the [preregistration](2026-11-16-w0-keyless-repin-preregistration.md))
and a third for the lifecycle matrix's last run; the other rows ran on a Capy machine. The build is frozen at
`6ce7195b4` for every counted run, and runs at `77cf8e111` and in between are diagnostics, not counted rows. Rows that
moved to the December refresh keep the builds they were measured at.

## What the check covers

| Row (published build) | Rerun at `6ce7195b4` | Result |
|---|---|---|
| Serving the new value after an update, N1 (`77cf8e111`) | full N1, PGLite and Postgres, CLI, MCP stdio and MCP HTTP; again with the belief ledger on | 388 of 388 current, 385 of 385 history, 0 stale, 0 acknowledged writes lost, 0 private values to remote callers (32 of 32 probes with signal), on both engines; the same with the ledger on |
| Nothing left behind after `forget`, N5 (`77cf8e111`) | full N5, same six cells | 0 prohibited outputs, 0 reactivations, 6 of 6 reinstatements, 909 of 909 retained pairs present |
| Private pages reaching remote callers, N6 on Postgres over HTTP (`77cf8e111`) | N6 on Postgres over real HTTP, with its negative control | 155 of 155 mandatory cells, 0 leaks, 0 oracles; the control fails as designed (646 leaking probes) |
| Index truth across moves, renames, `forget` and restarts, lifecycle matrix (`b80cad6`) | new build, PGLite and Postgres, CLI, MCP stdio and MCP HTTP | 0 acknowledged writes lost in the four MCP cells and 1 in each CLI cell (the slug-collision file); no `forget` collateral, residue or remote leak; old slugs 2 of 2 |
| One very large page, N14 (`7a6bdd3`) | wave B4's command set | 2 MB slices pass on both engines; 20 MB, 24 MiB and Postgres 100 to 260 MiB match B4; PGLite 128 MiB crossed the runner's memory ceiling, as `7a6bdd3` does on the same host |
| Privacy and data-loss bug-ledger repros (`77cf8e111`) | the 10 commands in [`repros-privacy-data-loss.txt`](2026-11-16-w0-keyless-repin/repros-privacy-data-loss.txt) | 9 of 10 as published; N2-2 fixed (real-brain copy) |
| Private pages reaching agent callers, N6 in process, N8 and N12 (`77cf8e111`) | not rerun: CI run [43940805988](https://github.com/garrytan/gbrain-evals/actions/runs/43940805988) installed `6ce7195` | N6 safety 6 of 6, quality 2 of 2; N8 safety 4 of 4, quality 3 of 3; N12 safety 4 of 4, quality 2 of 2 (every registered format keeps the control conversation whole) |
| Known limits: open loops cover Gmail only; no whole-brain contradiction scanner | source checks at `6ce7195b4` | both still true ([below](#rows-read-from-ci-and-the-source)) |
| Retrieval failure shapes E1 to E15, ARS (`6e1086492`) | keyword path, default seed | 5 of 15 shapes reproduce (9 before); E5 measured for the first time |
| Namesakes, N4 (`6c8373c`) | default seed and seed 7 | every gated contract and floor holds: 0 wrong merges on four surfaces, 0 identity leaks, floors 48 of 48 and `recall` 50 of 50 |
| Dates, N3 (`6c8373c`) | default seed and seed 7 | 513 of 513, and 501 of 501 at seed 7 |
| Reworded one-hop relationship questions, keyword path, N9 hermetic arm (`3a284ae`) | default seeds | paraphrase recall at five 0.380 → 0.511 (was 0.476 → 0.555 at `3a284ae`, 0.476 → 0.572 at `77cf8e111`) |
| Abstention, A4's keyless arm (`48ed5e8`) | keyless arm | answerable questions graded `moderate` 100 of 120 (40 before), unanswerable 0 of 120 |
| Open loops, N7 (`48ed5e8`) | hermetic arm | 53 of 53 planted loops, 34 of 34 closures, precision 53 of 56 (53 of 53 before) |
| BrainBench memory conformance, Cat 34 (`2a56b512`) | gate mode | pass |

README's paid one-hop row (0.411 → 0.537 at `3a284ae`) uses OpenAI embeddings, so no keyless run refreshes it, and it
waits for December ([below](#rows-that-wait-for-the-december-refresh)).

## Results

### Rows on the VMs

Part a and part b ran from gbrain-evals `33758dde`. The lifecycle matrix's counted run is its third, from `2cf7eb58` on a
third VM, after the fixes its two amendments name; its first two receipts are kept beside it
([receipts](2026-11-16-w0-keyless-repin/counted/6ce7195b4/), and the [collision vault's sync
output](2026-11-16-w0-keyless-repin/counted/6ce7195b4/lifecycle-slug-collision-sync-output.txt)).

| Check | Published | `6ce7195b4` |
|---|---|---|
| N1, belief ledger off | `77cf8e111`: 388/388 current, 385/385 history, 0 stale, 0 lost, 0 leaks, 124/124 negative controls, both engines | identical, both engines |
| N1, belief ledger on | `09943580e` (v0.60.265.0): the same as ledger off | identical to ledger off |
| N5 | `77cf8e111`: 0 prohibited, 0 reactivations, 0 collateral expirations, 6/6 reinstated, 765/765 retained (94 capped) | 0, 0, 0, 6/6, 909/909 retained (109 capped); forgotten pairs with a witness 184 (was 149), without one 17 (was 52) |
| N6 on Postgres over HTTP | `77cf8e111` (round 4): 155/155 mandatory cells, 0 leaks, 0 oracles | 155/155, 0 leaks, 0 oracles, 2,910 probes with signal; negative control fails as designed with 646 leaking probes |
| Lifecycle matrix | `b80cad6` (v0.59.13.0, build b): 1 acknowledged write lost in 6 of 6 cells (`forget` collateral on `bob_email`); links 6/6 precision and 6/9 recall through the CLI, at most 5/8 recall through MCP; old slugs 0/2; collision vault 1/3 imported, sync exit 1; no remote leaks; outage notes embedded 3/3 | MCP cells 0 lost; CLI cells 1 lost (`notes/Foo Bar.md`, slug collision); no `forget` collateral; links 9/10 precision and 9/9 recall through the CLI, 8/9 and 8/8 through MCP; old slugs 2/2; collision vault 2/3 imported, sync exit 0; no remote leaks, 15 of 17 probes with signal; outage notes embedded 3/3 except PGLite over MCP 0/3 (`pglite_busy`), found by search 3/3 everywhere |
| N14, PGLite 2 MB and Postgres 2 MB | `7a6bdd3`: pass, keyword recall in the top ten 1.00 at 2 MB | pass, 1.00 |
| N14, PGLite 20 MB and 24 MiB | `7a6bdd3`: 0 crashes, 0 responses over cap, 0 bytes lost; append-to-embed ratio 2.872 and 2.341 | identical |
| N14, Postgres 100 MiB to 260 MiB | `7a6bdd3`: 0 crashes, 0 over cap, 0 bytes lost | identical |
| N14, PGLite 100 MiB to 260 MiB | `7a6bdd3`: 0 crashes; native-arm peak memory 4,996 MB at 100 MiB and 4,920 MB at 128 MiB | 128 MiB native arm stopped at 6,214 MB (ceiling 6,144 MB); second run 6,194 MB; 100 MiB peaked at 5,720 MB |
| Privacy and data-loss repros | `77cf8e111`: 10 of 10 as recorded | 9 of 10 identical; N2-2's stand-in engine fails (`engine.executeRaw is not a function`) |

Each N14 slice outside 2 MB reports the runner verdict `fail` for the same reason B4's receipts do: the gated 2 MB
keyword floor lives only in the 2 MB slice. N1-3's output now shows the shared value inside gbrain's quote fence
(`decision_style=[quoted conversation excerpt …] deliberate`); the private dimension still never reaches the remote
caller. The VMs' `~/.gbrain` was absent after every part, and no provider key was set.

### Rows on the Capy machine

Keyless, from gbrain-evals `33758dde` except N4's counted runs (`8569f237`, after its amendment) and N9 (`79cb4848`).

| Check | Published | `6ce7195b4` |
|---|---|---|
| ARS, E1 to E15 | `6e1086492` (v0.60.324.0): 9 shapes reproduce, 5 hold, E5 not measured | 5 reproduce (E3 0/6, E7 0/4, E13 0/1, E14 0/3, E15 48/50); E1 30/30, E2 15/15, E4 6/6 and E6 24/24 now pass; E5 8/8, measured for the first time; E8 to E12 hold (E12 324/324 lists) |
| N4, default seed | `6c8373c`: resolver 82/119, B-cubed F1 0.762; `recall` 86/123, 0.778; `remember` 82/119, 0.762; 0 wrong merges, floors full | resolver 87/119, 0.794; `recall` 91/123, 0.808; `remember` 78/119, 0.738; resolve-on-save 87/119; 0 wrong merges of 136 and 144; 17/17 and 21/21 refusals; floors 48/48 and 50/50; search floor 48/48; identity groups 32/32, 0 leaks |
| N4, seed 7 | `6c8373c`: resolver 74/119, 0.719 | resolver 78/119, 0.743; `recall` 82/123, 0.761; `remember` 69/119, 0.693; the same contracts and floors hold |
| N3 | `6c8373c`: 513/513 | 513/513; seed 7 501/501; range set F1 1.000 over 179 range probes |
| N9 one-hop, keyword path | `3a284ae`: recall at five, paraphrase 0.476 → 0.555 and template 0.719 → 0.755 | paraphrase 0.380 → 0.511 (69 better, 0 worse of 435); template 0.713 → 0.761 (33 better, 0 worse); `77cf8e111`: 0.476 → 0.572 and 0.719 → 0.771 |
| A4, keyless arm | `48ed5e8`: 40/120 answerable and 0/120 unanswerable graded `moderate` | 100/120 answerable `moderate`, 120/120 unanswerable `weak`; a gate at `moderate` keeps 100 of 120 answerable at 0 risk |
| N7, hermetic arm | `48ed5e8`: 53/53 planted loops, 34/34 closures, precision 53/53 | 53/53 loops, 53/53 counterparties, 34/34 closures (26 threads, 8 store rounds), contracts all 0; precision 53/56 |
| Cat 34 | `2a56b512` (v0.47.8.0): pass in gate mode; Codex contract seam missed 43 of 96 push turns | pass in gate mode; OpenClaw and Claude Code 0 failures in all eight suites; Codex contract seam misses 39 of 96 push turns |

N4's runner verdict stays `fail`, as on every published receipt: B-cubed F1 and the unresolved rate miss targets on
variants gbrain doesn't read by design (typos, initials not in `aliases:`, names declared only in prose), and those
metrics are exploratory. Two documented gbrain changes move N4. Five nicknames that pages declare only in prose now
resolve (Lenny, Greg, Ophy, Benji and Nell at the default seed), and `remember` now leaves all 9 bare first names unresolved because
v0.60.355.0 (#7254, `dfe501e2f`) refuses a name that only begins a page's name; a keyless bisect puts that change at
that merge. N4's first runs at this build read 48 of 50 on the `recall` floor; that came from the harness
([below](#harness-defects-none-in-gbrain)), and both receipts are kept.

### Rows read from CI and the source

CI run [43940805988](https://github.com/garrytan/gbrain-evals/actions/runs/43940805988) (gbrain-evals #448 at
`8c9847c9`) installed gbrain `6ce7195` and ran the keyless BrainBench tier. N6 in process passed (safety 6 of 6,
quality 2 of 2, which covers the `find_contradictions`, `known_as_of` and held-take privacy probes), N8 passed
(safety 4 of 4, quality 3 of 3) and N12 passed (safety 4 of 4, quality 2 of 2; one quality floor requires the plain
control conversation to come back whole in every registered format). CI keeps no receipts, so these rows cite the
run's gate verdicts, not recounted numbers.

The two known limits still hold at `6ce7195b4`:

- **Open loops cover Gmail only.** The detector runs "for every synced Gmail thread" (gbrain
  `docs/guides/open-loops.md:19`), the loop code lives under `src/core/google/`, and fulfilment of a commitment by
  reply is still "future work" (`docs/guides/open-loops.md:406`).
- **No whole-brain contradiction scanner.** `gbrain eval suspected-contradictions` still "samples top-K retrieval
  pairs" for the queries it is given (`src/commands/eval-suspected-contradictions.ts:166-185`); nothing scans every
  page.

### What got worse, and where

Both drops are deterministic: the first and second runs at `6ce7195b4` gave identical receipts, and the same runner
at `77cf8e111` reproduces the earlier numbers. Each was bisected keyless over gbrain's first-parent history from
`77cf8e111` to `6ce7195b4` ([logs](2026-11-16-w0-keyless-repin/counted/6ce7195b4/bisects.txt)). Neither is a
gated contract, and neither touches privacy or stored data.

**Keyword search on reworded one-hop questions.** With relationship retrieval off, paraphrase recall at five was flat
at 0.476 through v0.60.331.0. #7186 (`104983fe2`, v0.60.332.0, collapse twins and merge stubs, the change that fixed
E1 and E2) moved it to 0.469. #7201 (`1e9cf22cf`, v0.60.338.0) moved it to 0.331 and the relationship arm from 0.572 to
0.490; that release bounds keyword ranking, retries an all-words miss with only the words that fit, and keeps one
chunk per page in the candidate pool. Later releases recovered part of it, to 0.380 and 0.511. Against `77cf8e111`,
48 paraphrase runs got better and 95 got worse with relationship retrieval off; the 95 cover 35 questions, mostly
`works_at` questions, then `invested_in` and `advises`. Relationship retrieval still
helps every question it touches (69 better, 0 worse), and template questions barely moved (0.719 → 0.713 off). This
is the keyword path only. The paid hybrid number in README uses OpenAI embeddings and waits for December, and it may
have moved too, because hybrid search uses the same keyword ranking.

**Open-loop precision.** The three `forward_fyi` threads in N7's world each forward someone else's question with the
owner's own words "FYI, see below." gbrain's guide says FYI forwards without a question open no loop
(`docs/guides/open-loops.md:46`). At `6ce7195b4` each opens an `unanswered_outbound` loop. The bisect puts the
first such build at #9246 (`6fd05bf3a`, a merge train after v0.60.710.0). That train carries gbrain commit
`49bc50012` (from #8941): a Gmail forward now keeps its whole body, so the forwarded question reads as the owner's
own. The bisect stops at the train's merge; that commit is named from the train's history, not bisected. Recall,
counterparties, closures and every N7 contract are unchanged, and the verdict still passes.

### What got better

- **N2-2 is fixed.** [`repro/n2-2-find-contradictions-real-brain.ts`](2026-11-16-w0-keyless-repin/repro/n2-2-find-contradictions-real-brain.ts)
  stores one finding about two real chunks in an in-memory PGLite brain and asks as the CLI does. At `6ce7195b4` the
  bare call (`sourceId` `default`) returns that finding, read back live (`total_visible` 1). At `77cf8e111` it returns
  the published empty note, "Stored contradiction reports are temporarily available only to trusted local callers
  without a source filter." The fix is #6784 (`3c16e9ba4`, v0.60.250.0).
- **Retrieval shapes.** E1 (twin slugs across federated sources) and E2 (merge-redirect stubs) pass in full after
  #7186. E4 (a founder page above the company a product query describes) and E6 (honorific, surname and diminutive
  names) pass too. E5 can be measured now that `search` and `query` take a frontmatter filter, and passes 8 of 8.
- **A4's grade.** A relaxed keyword top result now grades `moderate` when the top rows corroborate it
  (`keyword_relaxed_corroborated`, #5919, first on master in #5992, `101799f1f`, v0.60.41.0). That lifts 60 answerable
  questions from `weak` and no unanswerable one.
- **N4.** Resolver accuracy rose from 82 to 87 of 119, and `recall` from 86 to 91 of 123.
- **Lifecycle matrix.** `forget` no longer expires the same claim on another entity (collateral on `bob_email` in
  every published cell, none now). Renamed and moved files keep their old slug (2 of 2, was 0 of 2), and every
  expected link is found (was at most 6 of 9). A slug collision no longer stops its vault's sync: 2 of 3 files import
  and the sync names the collision (was 1 of 3 and exit 1). The one link the ledger doesn't list, Carol's page to Acme
  Example, comes from the page naming the company in plain text ("Joined Acme Example as VP Engineering").

### N14's 128 MiB crash comes from the host

The runner stops an arm whose resident memory passes 6,144 MB, the ceiling wave B4 ran under (`MemoryMax=6G`). On a
16-core `standard-16` VM with Bun 1.4.4, the 128 MiB PGLite native arm passed it at `6ce7195b4` twice (6,214 and
6,194 MB) and at B4's own build `7a6bdd3` once (6,168 MB). B4 ran Bun 1.4.2 on a 4-core host and measured 4,920 MB
for the same arm. The 100 MiB native arm rose from 4,996 to 5,720 MB, and every other arm's peak is within 6% of
B4's. The bisect stopped at the baseline, since a
crash at both builds can't be bisected. A rerun under B4's runtime and core count would settle it; until then
README's large-page row keeps `7a6bdd3`.

### Harness defects (none in gbrain)

Fixes 1 to 5 came before the counted runs. Each runner fix among them has a test that fails without it and leaves
every earlier receipt unchanged; the VM script fix (2) is one line in `run-kept.sh`, shown by the third run reaching
every cell. Each was committed with a dated amendment before the next run. Fix 6 came after the runs and changed only
path strings.

1. **N4 read quote-fenced facts as raw text** (amendment of 2026-11-16, fix `8569f237`). Since v0.60.536.0 (#8367),
   a remote `recall` returns facts below the owner's trust tier inside a quote fence. N4 compared the raw text with its
   marker, so four remote two-source mentions scored as unresolved; the floor read 48 of 50 at both seeds. N4 now reads
   each fact through the build's own `unquoteFactText`, as N1 and Cat 38 already did, and reads 50 of 50.
2. **The lifecycle matrix worked inside this checkout** (fix `d21641f9`). v0.60.733.0 refuses to set up a content
   directory inside another Git worktree (`local_conflict`), so the first run stopped at `gbrain init` in all six
   cells. The VM script now passes a work directory outside the checkout.
3. **The lifecycle matrix compared quote-fenced facts as raw text** (fix `2cf7eb58`). Its second run counted 3
   facts lost in each MCP cell (`bob_email`, `alice_maps`, `frank_email`), though all came back, quoted.
4. **The lifecycle leak probe matched its own query** (fix `2cf7eb58`). A `recall` with `query` and no
   `question` now ends with a `recall_hint` notice whose `fix:` line repeats the call, so `recall(page marker)`
   flagged a content leak and a control hit in every MCP cell. The probe now drops a `fix:` line whose every argument
   is one it sent; a marker anywhere else still counts.
5. **The lifecycle catch-up sweep stopped at a consent prompt** (fix `2cf7eb58`). `gbrain embed --stale` has asked
   for spend consent since v0.60.46.0 and exits 3 without a terminal; the runner's embedder is a free local hash
   embedder, so a build whose `embed` takes `--yes` now gets it. On PGLite with `gbrain serve` live, the same step
   is refused with `pglite_busy`, a deliberate guard, and the receipts report it as observed.
6. **Two runners kept VM paths in their receipts** (found by CI's receipt path check on this report's pull request).
   The lifecycle matrix wrote its receipt without `scrubMachinePaths`, and N5 handed its receipt to `writeReceipt`,
   which rewrites only the checkout path. Both now rewrite checkout, home and temp paths, as N1 and N14 already did;
   the lifecycle writer has a test, and N5 is covered by the repository's check on committed receipts. In the four
   affected receipts (the three lifecycle runs and N5) only those strings changed: the VM checkout became relative,
   `/home/ubi/` became `~/` and `/tmp/` became `<tmp>/`. Every number, key and verdict is byte-identical.

The N2-2 repro is a case like fixes 1 to 5: its stand-in engine was thinner than v0.60.733.0's code path. The
published file is unchanged, and the real-brain copy above runs at both builds.

### Rows that wait for the December refresh

These keep their published builds until the December `stable` tag: Cat 7 and the Cat7-1 timeline limit,
`volunteer_context` (0 of 240), the multi-relation planner, the attendance world and attendee role planner, the
forecast journal, N13, N2's keyless part, the memory trust repros, keyless partial-match search, the other bug-ledger
repros, the wave 8 and operator-wave checks, the verbatim probe, and README's paid one-hop row.

## What changed in this repository

- `eval/runner/n4-entity-resolution.ts` and `eval/runner/lifecycle/observe.ts` read `recall` facts through the
  build's own unquote; `observe.ts`'s leak probes drop a notice line that repeats the probe's own call;
  `eval/runner/lifecycle/builds.ts` passes `--yes` to `embed --stale` on builds that take it; `run-kept.sh`, the VM
  script for the kept runs, runs the lifecycle matrix outside the checkout; the lifecycle and N5 runners rewrite
  machine paths in their receipts; and N4 stops as a harness limit on a build that quotes facts without an unquote
  helper. Each runner change has a test except N5's path rewrite, which the repository's check on committed receipts
  covers.
- `scripts/scan-receipts.sh` also secret-scans this report's `counted/` tree.
- A real-brain copy of the N2-2 repro.
- README and `docs/gbrain-under-test.md` move the rows that hold to `6ce7195b4`, and the documentation hub links this
  report. The N9 drop is noted beside its row and the N7 drop in the open-loops limit, and the large-page row keeps
  `7a6bdd3`. This report doesn't change `package.json`; its gbrain pin moved to `6ce7195b4` separately, in #448.

## Reproduce and inspect

- VM scripts: [`setup.sh`](2026-11-16-w0-keyless-repin/vm/setup.sh) and
  [`run-kept.sh`](2026-11-16-w0-keyless-repin/vm/run-kept.sh) (`a`, `b`, or one step such as
  `run-kept.sh lifecycle new r3`).
- Receipts: [counted at `6ce7195b4`](2026-11-16-w0-keyless-repin/counted/6ce7195b4/), with the first runs of N4 and
  the lifecycle matrix kept beside the counted ones, and the [bisect logs](2026-11-16-w0-keyless-repin/counted/6ce7195b4/bisects.txt).
- One row locally, keyless: `bun eval/runner/n7-open-loops-email.ts --output /tmp/n7` or
  `bun eval/runner/n4-entity-resolution.ts --output /tmp/n4` with gbrain `6ce7195b4` installed.

## Disclosures

gbrain is Garry Tan's own project.

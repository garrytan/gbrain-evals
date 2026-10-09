# Short-code aliases on top of Candidate 1: failures fall from 18 to 4 on fresh seeds, inconclusive on development seeds

## The finding

On the [T0b workload](2026-10-08-program-primary-hard-preregistration.md), the failures left after
[Candidate 1](2026-10-09-candidate-1-newer-mentions.md) are mostly stale prices and seat counts. The correction sits in a
call note titled "Call with JOF" that names the customer only by its short code, so it links to no entity and never
reaches the `context_pack` card. GBRA-39's short-code alias fix (garrytan/gbrain#6271) makes a 2 or 3 character code
that a company page declares for itself ("Also called JOF in my notes") one of the company's names, so the call note
links to the company and appears on its card.

Measured on October 9, 2026 under [amendment 4](2026-10-08-program-primary-hard-preregistration.md), paired cell by
cell against current master, which already carries Candidate 1, with search reranking live in every cell:

| Personas | Reader | Master failures | Master + alias fix | Factor | 95% interval for R | Risk difference (95%) | Verdict |
|---|---|---:|---:|---:|---|---|---|
| Fresh seeds (8, 1 repeat) | Opus 5.5 | 5/24 | 1/24 | 3.67 | 0.00 to 1.79 | −16.7 pts (−31.6 to −1.8) | inconclusive |
| | Sonnet 5.5 | 13/24 | 3/24 | 3.86 | 0.04 to 0.84 | −41.7 pts (−70.5 to −12.8) | improvement |
| | gpt-6.1-sol | 0/24 | 0/24 | | | 0.0 pts | ceiling |
| | **Pooled** | **18/72** | **4/72** | **4.11** | **0.05 to 0.68** | **−19.4 pts (−30.3 to −8.6)** | **improvement** |
| Development (8, 2 repeats) | Opus 5.5 | 4/48 | 8/48 | 0.53 | 0.11 to 111 | +8.3 pts (−25.8 to +42.5) | inconclusive |
| | Sonnet 5.5 | 20/48 | 3/48 | 5.86 | 0.02 to 0.59 | −35.4 pts (−58.3 to −12.5) | improvement |
| | gpt-6.1-sol | 1/48 | 0/48 | 3.00 | 0.00 to 39.0 | −2.1 pts (−7.0 to +2.8) | inconclusive (near ceiling) |
| | **Pooled** | **25/144** | **11/144** | **2.22** | **0.12 to 1.41** | **−9.7 pts (−22.8 to +3.4)** | **inconclusive** |

The amendment defined "stacks" as a development pooled verdict of `improvement` together with a fresh-seed pooled point
estimate of R below 1. The fresh-seed half holds, but the development half does not, so the preregistered criterion
is not met. With Candidate 1 already shipped, development master fails 25 of 144 runs, 20 of them Sonnet's, so the
pooled interval is wide. Opus 5.5 moves the other way (4 to 8): four of its eight failures are stale terms on the
three tasks the fix could not link, and four are namesake flags (three on master). Both validity mutants were detected on the alias arm for all three readers.

The mechanism result is clearer than the verdicts. The fix linked the call note to its company in 38 of 48 tasks. In
those tasks, stale-terms failures fell from 25 to 0 (177 runs per arm on linked tasks, both seed sets). In the 10 tasks
it could not link, they went from 8 to 10 (39 runs per arm). Every terms failure left on the alias arm is in a task
whose call note stayed unlinked. Sonnet 5.5, the reader that searches least, gains the most and is `improvement` on both
seed sets. On the unlinked tasks the fix puts nothing new in front of the reader.

Two things block the remaining links, and one of them is a property of the workload. First, the T0b generator builds
every company's code from the first two letters of its name and the suffix's initial
(`eval/generators/program-primary-hard-gen.ts:162`). So in a 25-company brain two companies often get the same code:
Branesso Logistics and Branura Logistics are both `BRL`. Across the 16 brains, 20 codes are declared by two or three
companies. gbrain links a name that several unrelated pages claim to none of them, so those notes stay unlinked.
That accounts for 9 of the 10 unlinked tasks. Second, the code-shape stoplist drops one task company coded `THE`.
Neither is a false alias: no 2 or 3 character name landed on a page that did not declare it.

These are public development seeds and fresh seeds drawn after the build froze. They are not a custodian-sealed set,
and the result is not 10x.

## The concrete case

Invented data from the generator (fresh persona 560317357, task 2). The company page says "Iskanta Health. Also called
ISH in my notes", and the deal page says 25 seats. An October 11 note titled "Call with ISH" reads: "Scope: they need
80 seats, not 25 (my earlier count was off)." The champion asks for a reply confirming "where the numbers landed".

On master, the note links to nothing, because a 3 character name was never derived. `context_pack` on the champion and
the company returns the handoff and reschedule mails (Candidate 1) but not the call note, so both Opus 5.5 and
Sonnet 5.5 quoted 25 seats. On "master + alias fix", `ISH` is one of Iskanta Health's names. The call note gets a
`mentions` link to the company and appears among the card's newer mentions. Both readers answered with 80 seats.

## The experiment and results

### What the alias fix changes in gbrain

The alias fix is commit `f24ca6afe` on #6271's branch `capy/cat40-hard-fix`:
- `src/core/mentions/short-codes.ts` (new) defines a short code as 2 or 3 letters or digits with at least one capital
  letter (line 15), minus a stoplist of English words and business acronyms (lines 22 to 31, which include `ONE` and
  `THE`).
- `src/core/mentions/aliases.ts` keeps such a code only when the page's own body declares it, with an alias label or an
  "also called", "a.k.a.", "known as" or "short for" cue whose sentence names nothing but the page.
- `src/core/by-mention.ts:633` links a declared code case-sensitively, as a whole token. A name that several pages
  claim, and that are not identity siblings, is dropped as `alias_collision` (`by-mention.ts:631`). That rule is why a
  shared code links to neither page.
- `ALIAS_DERIVATION_VERSION` 4 and `MENTION_EXTRACTOR_VERSION` 5, so brains re-derive aliases and rescan mentions once.

Merging that commit into master brings all of #6271 up to it, 27 commits in all: the declared-name grammar, identity
siblings, `match: "keyword"` paging and counts, generated-page demotion, date labels on search rows, opaque
`request_id`s and the rest. So this arm measures #6271's content at `f24ca6afe`, not the short-code commit alone. The
branch's later head `9bba4da4` (`entity` `names[]`) changes the starter surface's `entity` schema, so it was left out.

### Arms

- **"master (candidate 1)"**: gbrain master `dda603ac` (v0.60.130.0, tree `4d3f4292`), Candidate 1 on by default.
- **"master + alias fix"**: gbrain `9ac26bea` (tree `41f95308`), a merge commit on no branch with parents `dda603ac`
  and `f24ca6afe`. #6271's migration v223 is renumbered v225 after master's v223 and v224, with the generated registry
  and goldens regenerated, module-size ceilings raised and both sides' CHANGELOG and behaviour-change rows kept.
  Typecheck passes. The 58 unit-test files touched by either side pass file by file. In one combined `bun test`
  process, 14 MCP search tests fail from cross-file state, and each of those files passes alone.
- **Harness**: gbrain-evals `78271606` (main `8cbc61f7` plus amendment 4, the fresh seeds and the probe script),
  committed before any paid cell. Bun 1.4.2. The runner's fail-closed rerank probe passed on every slot of every
  invocation (8 of 8 slots in each eight-persona invocation, 2 of 2 in each two-persona invocation, and the base and
  mutant slots of each mutant invocation).
- **Protocol**: the frozen T0b protocol (`program-primary-hard-v1`, `DEFAULT_KNOBS`, `t0b-score-v1`, the T0 delivery
  contract, `--surface starter`, 20 turns), `baseline` arm, readers Opus 5.5, Sonnet 5.5 and gpt-6.1-sol. Statistics
  are T0b's frozen ones (`eval/runner/t0/paired.ts`: PW's conditional-binomial interval for R, alias over master,
  persona clusters, loss tolerance 3.0 points).
- **Cells**: development, both repeats on all eight personas (144 pairs). Fresh seeds, repeat 1 (72 pairs). Both arms
  ran concurrently from the same checkout. Repeat 2 on seeds 20261103 to 20261108 and the validity mutants ran in a
  second ledger run under amendment 4's note (`7cc77a65`), committed before those cells. Every cell was scored, with
  no harness errors.

### Mechanism check before any paid cell ($0)

`alias-probe.ts` builds keyless copies of each persona's brain, calls `context_pack` on each task's champion and
company as the readers' first call does, and reads the brain's derived names and links.

| Brains | Build | Call note on the card | Handoff and reschedule on the card | Call note links the company |
|---|---|---:|---:|---:|
| Development | master | 0/24 | 24/24 | 0/24 |
| Development | master + alias fix | 21/24 | 24/24 | 21/24 |
| Fresh seeds | master | 0/24 | 24/24 | 0/24 |
| Fresh seeds | master + alias fix | 17/24 | 24/24 | 17/24 |

The handoff and reschedule mails, signed "Kofi Aziz (JOF)", now also link to the company. Before the fix they linked
only to the champion.

### What the alias derivation does on the T0b brains

Each brain has 25 company pages that declare a code ("Also called YAR in my notes"): 22 customers and the 3 namesake
companies.

| Brains | Declared codes | Became a name of the declaring page | Not derived | Short names on a page that did not declare them | Codes two or three pages declare |
|---|---:|---:|---:|---:|---:|
| Development (8) | 200 | 197 | 3 (`ONE`, `THE`, `THE`, stoplist) | 0 | 6 (`BRL`, `ISF`, `LUF`, `ZEE`, `PRF`, `ORM`) |
| Fresh seeds (8) | 200 | 200 | 0 | 0 | 14 (`HYI` on three pages) |

The generator builds each code from the company's first two letters and its suffix's initial
(`program-primary-hard-gen.ts:162`). It keeps company names distinct and gives each namesake company a suffix with a
different initial, but it never checks codes against each other. So 6 of the 16 brains hold at least one code that two
or three companies declare. Both pages get the name, and the mention pass then drops it as a collision
(`by-mention.ts:631`), so a note about either company links to neither. No person nickname (for example "Elo") became
an alias, because person pages give the nickname in parentheses without a cue.

This is first a property of the workload. A person who writes "Call with BRL" for two different customers has made
their own notes ambiguous, and no memory system can resolve that from the code alone. The next T0b generator version
should draw codes that are unique within a brain, at least for the task companies, so the workload measures what it
means to measure. Collisions should then be tested on purpose, in their own item with a known right answer. The
product gap is narrower: in "From: Kofi Aziz (JOF)" the person named beside the code identifies the company, and
gbrain does not use that today.

Tasks whose call note stays unlinked: development h20261103-t2 (`BRL`), h20261103-t3 (`THE`) and h20261107-t1 (`PRF`).
Fresh seeds h124371926-t3, h196299785-t1, h196299785-t2, h500901660-t1 to t3 and h746355681-t3, all shared codes.

### Failure classes

Failed items by class. A run can fail more than one class.

| Personas | Reader | Arm | Contact | Date | Terms | Hop | Namesake |
|---|---|---|---:|---:|---:|---:|---:|
| Development | Opus 5.5 | master | 1 | 0 | 1 | 0 | 3 |
| | | master + alias fix | 0 | 0 | 4 | 0 | 4 |
| | Sonnet 5.5 | master | 1 | 1 | 17 | 3 | 1 |
| | | master + alias fix | 0 | 0 | 2 | 0 | 1 |
| | gpt-6.1-sol | master | 0 | 0 | 0 | 0 | 1 |
| | | master + alias fix | 0 | 0 | 0 | 0 | 0 |
| Fresh seeds | Opus 5.5 | master | 0 | 0 | 5 | 0 | 0 |
| | | master + alias fix | 0 | 0 | 1 | 0 | 0 |
| | Sonnet 5.5 | master | 0 | 0 | 10 | 3 | 1 |
| | | master + alias fix | 0 | 0 | 3 | 0 | 0 |
| | gpt-6.1-sol | both | 0 | 0 | 0 | 0 | 0 |

Stale terms by whether the fix linked the task's call note (all repeats):

| Personas | Arm | Linked tasks: terms failures | Unlinked tasks: terms failures |
|---|---|---:|---:|
| Development | master | 14 of 126 runs | 4 of 18 |
| Development | master + alias fix | 0 of 126 | 6 of 18 |
| Fresh seeds | master | 11 of 51 | 4 of 21 |
| Fresh seeds | master + alias fix | 0 of 51 | 4 of 21 |

Contact and date failures stay where Candidate 1 left them: 3 failed items on master (dev Opus contact 1, Sonnet
contact 1 and date 1) and none on the alias arm, in 432 runs. Sonnet's hop misses (3 and 3 on master) are 0 on the
alias arm. The [Candidate 3 diagnostic](2026-10-09-candidate-3-diagnostic.md) traced hop misses to the same code: the
reader passes "JOF" to `context_pack` in place of the company's name, which master cannot resolve and the alias fix
can. The counts here are too small to attribute on their own.

On the three unlinked development tasks, Opus 5.5 failed on stale seats in 4 of 6 alias-arm runs and 0 of 6 on master.
In the master runs it quoted the corrected figure from the call note as search returned it, without opening the note.
On the alias arm it opened the note in 0 of 6 runs (master 1 of 6) and quoted the deal page's figure. Six runs per arm
cannot separate a search change in #6271 from reader variance. The fresh seeds' seven unlinked tasks show no such gap
(Opus 2 of 7 on master, 1 of 7 on the alias arm). A search replay of those calls would settle it.

### The reader's route

How often the call note reached the reader through a `context_pack` result: each session-2 `context_pack` call was
re-executed with its recorded arguments on keyless rebuilds of that arm's brains (`context-pack-replay.ts`, $0). Cards
do not depend on embeddings or the reranker.

| Personas | Reader | Call note in a `context_pack` result (master, alias) | Opened the call note (master, alias) |
|---|---|---|---|
| Development | Opus 5.5 | 0/48, 41/48 | 20, 41 |
| | Sonnet 5.5 | 0/48, 40/48 | 23, 45 |
| | gpt-6.1-sol | 0/48, 42/48 | 48, 48 |
| Fresh seeds | Opus 5.5 | 0/24, 17/24 | 12, 22 |
| | Sonnet 5.5 | 0/24, 17/24 | 9, 17 |
| | gpt-6.1-sol | 0/24, 17/24 | 24, 24 |

gpt-6.1-sol already opened the call note in every run, through `entity` and search, which is why it sits at its
ceiling. With the note on the card it called `entity` on the champion less often (48 to 37 and 24 to 17 runs) and lost
nothing. Opus 5.5 and Sonnet 5.5 open what the card shows them.

### Resource envelope (alias over master; limits 1.2x / 1.5x / 1.5x)

| Personas | Reader | p95 session-2 latency | Mean tokens | Mean dollars |
|---|---|---:|---:|---:|
| Development | Opus 5.5 | **1.24x** (40.8 s to 50.6 s) | 0.93x | 1.03x |
| | Sonnet 5.5 | 1.07x | 1.14x | 1.16x |
| | gpt-6.1-sol | 0.57x | 1.05x | 1.09x |
| Fresh seeds | Opus 5.5 | 1.10x | 0.93x | 0.99x |
| | Sonnet 5.5 | 1.17x | 1.09x | 1.11x |
| | gpt-6.1-sol | **1.22x** (51.8 s to 63.3 s) | 1.08x | 1.10x |

Tokens and dollars are inside the limits everywhere. Two p95 latencies are over 1.2x. Opus 5.5 on the development seeds
is 1.24x: it opened the call note in 41 runs against 20 and made 582 tool calls against 528, which is the intended
extra work of reading the correction. gpt-6.1-sol on the fresh seeds is 1.22x, while on the development seeds it is
0.57x. A p95 over 24 to 48 sessions is set by one or two slow runs.

### Validity checks

Both mutants ran on "master + alias fix" brains, on the development seeds, repeat 1, against the alias arm's own
repeat-1 cells (`eval/runner/t0/analyze.ts`). The stale-correction mutant removes the correction pages (move thread,
call note, handoff). The forced-drop mutant runs session 2 on a brain without any item page and drops the hook output,
so neither the corrections nor the saved promise can reach the reader. If either did not raise failures, the scorer or
the harness would be crediting the alias arm with something it did not do.

| Mutant | Opus 5.5 | Sonnet 5.5 | gpt-6.1-sol |
|---|---|---|---|
| stale-correction | 24/24 failed (baseline 5/24), detected | 24/24 (2/24), detected | 24/24 (0/24), detected |
| forced-drop | 24/24 (5/24), detected | 24/24 (2/24), detected | 24/24 (0/24), detected |

`stale_correction` rose to 24 of 24 in every stale-correction cell set, above the baseline's. Every mutant cell was
scored, with no harness errors (`alias-mutants/summary.json`).

## What to use and what to avoid

The short-code rule does what it is for. Every call note it linked reached the card, and no reader failed on stale
terms in a task it linked. That supports landing #6271's short-code rule. This measurement covers #6271 at
`f24ca6afe` together with the rest of its branch, not the later `entity` `names[]` commit.

Do not read the pooled factors as a verdict on the whole stack. The preregistered "stacks" criterion failed on the
development half. That half is underpowered now that Candidate 1 has removed most failures: development master fails
25 of 144 runs. Six of the alias arm's 11 failures are stale terms on the three tasks it could not link, and the other
five are namesake flags.

Fix the collisions in the workload first. The next T0b generator version should draw codes that are unique within a
brain (`program-primary-hard-gen.ts:162`). Collisions should then appear only in a deliberate item, so a run measures
the alias fix where it applies and the collision behaviour where it is tested. On the product side, a colliding code
links nowhere today. Two options would reach the 10 unlinked tasks:
- Resolve a collision by context: link "Kofi Aziz (JOF)" to the company of the person named beside the code, or link
  to every claimant with an ambiguity flag. This adds false-link risk, and the gain is a terms failure in about 1 alias-arm run in 22 here (10 of 216).
- Leave the rule as is and let corrections that name no entity at all reach the card (the plan's candidate 3), which
  would cover these tasks and others.

The stoplist dropping a real company coded `THE` is the cost of keeping `THE` from linking everywhere, and it is the
right default.

Limits:
- Development and fresh public seeds only, with no custodian-sealed set.
- The fresh seeds ran one repeat.
- The arm carries all of #6271 at `f24ca6afe`, not the short-code commit alone.
- Opus 5.5's gap on the three unlinked development tasks is unexplained.

## Reproduce and inspect

```bash
# gbrain measurement build (in a gbrain checkout): master dda603ac merged with f24ca6afe; resolve as in amendment 4 -> 9ac26bea
bun eval/runner/budget-ledger.ts open --runner t0b-program-primary --budget-usd 70
R="bun eval/runner/t0b-program-primary.ts --paid --budget-run-id <id> --arms baseline"
$R --concurrency 3 --repeat 1 --gbrain <gbrain>@dda603ac9e152be45afd6f4edd3789bc11e000b8 --output <master-dev>   # concurrently:
$R --concurrency 3 --repeat 1 --gbrain <gbrain>@9ac26bea780e15cb660b2f29691613fcad5d0bf6 --output <alias-dev>
$R --concurrency 2 --repeat 1 --seeds 124371926,196299785 --gbrain <gbrain>@<sha> --output <arm-fresh>          # and the next three pairs
$R --concurrency 2 --repeat 2 --seeds 20261101,20261102 --gbrain <gbrain>@<sha> --output <arm-dev>                # and the next three pairs
$R --concurrency 3 --repeat 1 --arms mutant-stale-correction --readers gpt-6.1-sol --gbrain <gbrain>@9ac26bea780e15cb660b2f29691613fcad5d0bf6 --output <alias-mutants>   # then Sonnet, Opus; then mutant-forced-drop
bun eval/runner/t0/analyze.ts <alias-dev>/results.jsonl <alias-mutants>/results.jsonl
bun eval/runner/t0/paired.ts --baseline <master-dev>/results.jsonl --candidate <alias-dev>/results.jsonl --repeats 1,2
bun eval/runner/t0/paired.ts --baseline <master-fresh>/results.jsonl --candidate <alias-fresh>/results.jsonl --repeats 1
D=docs/benchmarks/2026-10-08-program-primary-hard/alias-stack
python3 $D/analyze.py --arms development; python3 $D/analyze.py --arms fresh-seeds --gold gold-fresh.json
# $0: alias derivation, card contents and links on keyless brains; then the per-run context_pack replay
bun $D/alias-probe.ts --gbrain <gbrain> --ref <sha> --label <name> [--seeds <fresh seeds> --gold $D/gold-fresh.json]
bun $D/context-pack-replay.ts --gbrain <gbrain> --ref <sha> --label <probe label> --arm $D/development/alias [--gold ...]
```

Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`. Bun 1.4.2 (also at `/usr/local/bin/bun`, which harness
slots spawn).

Receipts are in [`2026-10-08-program-primary-hard/alias-stack/`](2026-10-08-program-primary-hard/alias-stack/):
- `development/` and `fresh-seeds/`, each with `master/` and `alias/` (`results.jsonl.gz`, `usage.jsonl.gz`,
  `experiment.json`, `receipt.json`, cost receipts and `context-pack-replay.json`), plus `paired.json` and
  `route.json`. Development's `experiment-repeat-1.json` records the eight-persona invocation, and `experiment.json`
  the last repeat-2 one.
- `alias-mutants/` (`results.jsonl.gz`, `usage.jsonl.gz`, `experiment.json`, `receipt.json`, cost receipts and
  `summary.json` with the detection rows).
- `probe/` (the four `alias-probe-*.json`).
- `alias-probe.ts`, `context-pack-replay.ts`, `analyze.py` and `gold-fresh.json`.

| Ledger run `t0b-program-primary-2026-10-09T13-52-11-329Z-b10c88bb` (cap $70) | Dollars (cell receipts) |
|---|---:|
| Development repeat 1 and repeat 2 on two personas, master arm, 90 cells | 15.69 |
| Development repeat 1 and repeat 2 on two personas, alias arm, 90 cells | 16.94 |
| Fresh seeds, master arm, 72 cells | 12.67 |
| Fresh seeds, alias arm, 72 cells | 13.20 |
| **Ledger total (includes brain builds and rerank probes)** | **61.78** |

| Ledger run `t0b-program-primary-2026-10-09T15-41-28-923Z-bdda2440` (cap $60, amendment 4's note) | Dollars (cell receipts) |
|---|---:|
| Development repeat 2 on six personas, master arm, 54 cells | 9.63 |
| Development repeat 2 on six personas, alias arm, 54 cells | 10.31 |
| Alias-arm stale-correction mutant, 72 cells | 13.15 |
| Alias-arm forced-drop mutant, 72 cells | 14.99 |
| **Ledger total** | **49.68** |

## Changelog

### 2026-10-09: link the Candidate 3 diagnostic

The hop-miss sentence now cites the [Candidate 3 diagnostic](2026-10-09-candidate-3-diagnostic.md), which traced hop
misses to readers passing the short code to `context_pack`; it used to say #6271 makes no change aimed at them.

### 2026-10-09: complete development repeat 2, validity mutants, collision framing

Development repeat 2 completed on all eight personas (90 to 144 pairs). The development pooled result moved from 15 to
7 of 90 (factor 2.07) to 25 to 11 of 144 (factor 2.22, R 0.12 to 1.41, still `inconclusive`). Sonnet 5.5 moved from 10
to 2 to 20 to 3 (`improvement`), and Opus 5.5 from 4 to 5 to 4 to 8. Both validity mutants were detected for all three
readers. Linked-task stale terms are 25 to 0, from 19 to 0. Opus's development p95 is now 1.24x, outside the envelope.
The code collisions are framed as a generator property to fix in the next workload version. All of this comes from the
second ledger run under amendment 4's note (`7cc77a65`).

### 2026-10-09: first version

The alias fix (#6271 at `f24ca6afe`) measured against current master (Candidate 1) under amendment 4.

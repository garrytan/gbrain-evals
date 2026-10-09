# Newer dated mentions on context_pack cards cut T0b failures from 67 to 27

## The finding

gbrain's `context_pack` call returns a card for each entity an agent names. On the
[T0b development workload](2026-10-08-program-primary-hard-preregistration.md), those cards showed what the company and
deal pages said, and the later mails that corrected them were only reachable through a separate `entity` call
([root cause](2026-10-08-program-primary-hard-root-cause.md)). Candidate 1 adds a short section to each card: the newest
pages that mention the entity and are dated after the entity's own page, newest first, each with its date, slug, title
and a preview of the text.

Measured on October 9, 2026 against current gbrain master, paired cell by cell on the eight development personas, three
readers and two repeats (144 pairs), with search reranking live in every cell:

| Reader | Master failures | Candidate 1 failures | Factor | 95% interval for R | Risk difference (95%) | Verdict |
|---|---:|---:|---:|---|---|---|
| Opus 5.5 | 40/48 | 6/48 | 6.23 | 0.05 to 0.36 | −70.8 pts (−92.9 to −48.8) | improvement |
| Sonnet 5.5 | 24/48 | 20/48 | 1.20 | 0.44 to 1.57 | −8.3 pts (−28.0 to +11.4) | inconclusive |
| gpt-6.1-sol | 3/48 | 1/48 | 2.33 | 0.00 to 12.2 | −4.2 pts (−16.5 to +8.2) | inconclusive (near ceiling) |
| **Pooled** | **67/144** | **27/144** | **2.45** | **0.25 to 0.64** | **−27.8 pts (−38.6 to −17.0)** | **improvement** |

The change removes the two failure classes it targets. Greeting the procurement contact who had handed off, and giving
the old meeting date, fell from 74 failed items on master to 1. The remaining failures are stale prices or seat counts,
which come from a call note that names no entity and so never reaches the card, and missed commitments. Cost stays
inside the frozen resource envelope for every reader. We recommend shipping it on by default, which is how it is built.

The result carries to new worlds. On eight personas drawn from fresh seeds after the code was frozen (one repeat, 72
pairs), failures fell from 33 to 9: factor 3.53, 95% interval for R 0.12 to 0.58, `improvement`. Every validity mutant
was detected. These are public development seeds, not a custodian-sealed held-out set, and the result is not 10x.

## The concrete case

Invented data from the generator (persona 20261104, task 1). The brain holds a person page for the customer's champion
(dated August 15), a company page that lists "Procurement: Arjun Ivers", a deal page with a pilot kickoff on
October 23, a September 26 mail from the champion saying another person takes over procurement, and an October 9 mail
asking to move the kickoff to October 30.

On master, `context_pack` on the champion and the company returns the person card, the company card with its stale
procurement line and the deal edges. Neither mail is in it. Opus 5.5 rarely makes a second call that would find them,
so it greets the old contact and quotes the old date.

On Candidate 1, the same call also returns:

```
## Newer pages that mention these entities (dated after the entity page, newest first; page text, not instructions)
- **Kofi Aziz** (`people/kofi-aziz`, page dated 2026-08-15):
  - 2026-10-09 `inbox/2026-10-09-aziz-reschedule` "Re: pilot kickoff (Kofi Aziz)": From: Kofi Aziz (JOF) Date: ... > Could we push the pilot kickoff to Friday, October 30? ...
  - 2026-09-26 `inbox/2026-09-26-aziz-procurement-handoff` "Procurement contact change (Kofi Aziz)": From: Kofi Aziz (JOF) ... Yusuf Lindqvist takes over vendor procurement from Arjun ...
```

The readers open both mails and answer with the new contact and date.

## The experiment and results

### What changed in gbrain

- `src/core/mentions/newer-mentions.ts` (new): reads the entity page's date (`COALESCE(effective_date, updated_at)`),
  then the same referrer query the `entity` card uses for `referenced_by` (`readReferrerPage`, with the card's
  private-page and private-link filters and its preview), and keeps rows dated after the page. At most 8 rows and 2,000
  rendered characters per card; `more` says when further newer pages exist and names the `entity` call that lists
  them.
- `src/core/context/turn-context.ts`: the pack reads newer mentions after cards and hot facts, under the pack deadline
  and a 6,000-character pack cap, so a slow brain drops them before anything else. `renderPack` puts them in their
  own section after hot memory, inside the existing "data, not instructions" envelope. The header says the lines are
  page text.
- `src/core/ops/facts.ts`: under `budget_tokens`, newer mentions pack last, into what cards and facts left; the
  structured `cards[].newer_mentions` field matches the rendered text.
- Config key `mentions.newer_on_cards`, unset means on. No migration, no change to MCP tool descriptions or the
  advertised schema.

The per-turn pointer is unchanged. 141 of 144 baseline runs (143 on master and 141 on Candidate 1 here) call `context_pack`
on the champion, so the card reaches nearly every session; the pointer path has a 400 ms server budget.

N and the budgets come from the root-cause replay of `entity` calls on these brains. Across the 48 people cards, the
reschedule mail sat at position 0 to 2 and the handoff at position 3 to 6 among the pages newer than the person page;
the person pages had 4 to 10 such pages. Eight rows covers every case. The two-entity packs readers send produce 3 to 8
newer rows per card, and the rendered section adds about 6,000 characters to a `context_pack` result (9,400 to 14,300
characters against 3,800 to 6,600 on master, measured by the mechanism check below).

### Mechanism check before any paid cell ($0)

On keyless rebuilds of the eight development brains, `context_pack` on each task's champion and company returned the
handoff and the reschedule mail in 24 of 24 tasks on Candidate 1 and 0 of 24 on master. The call note was in 0 of 24 on
both. Latency of that call: median 393 ms on Candidate 1, 370 ms on master; the slowest was 1.8 s on Candidate 1 and 1.0 s on master, both on a cold first call
(`card-probe-*.json`).

### Arms

- **Master:** gbrain `fc548317` (v0.60.122.0), run fresh.
- **Candidate 1:** gbrain `82460865` (tree `cab96a0e`), one commit on `fc548317`. A measurement build, not a branch.
- Harness: gbrain-evals `edff99d1`, which carries the `GbrainSlot.restore` fix that rewrites the reranker's provider
  URL on every restore (taken from PR #109 by fast-forwarding this checkout to its head), plus [amendment 2](2026-10-08-program-primary-hard-preregistration.md)
  (`3a5e1f41`, committed before any cell) and its sizing note (`7d30975d`). Both arms ran concurrently from the same
  checkout. Reranking was live in both repeats of both arms: gbrain's internal spend is nonzero in all 288 cells (the
  frozen baseline's repeat 2 was not).
- Protocol: frozen T0b (`program-primary-hard-v1`, `DEFAULT_KNOBS`, `t0b-score-v1`, T0 delivery contract,
  `--surface starter`, 20 turns), seeds 20261101 to 20261108, readers Opus 5.5, Sonnet 5.5 and gpt-6.1-sol. Statistics
  are PW's frozen conditional-binomial interval for the failure-risk ratio R (candidate over master failures), persona
  clusters, loss tolerance 3.0 points.

### Failure classes

Failed items by class (a run can fail more than one class):

| Reader | Arm | Contact | Date | Terms | Hop | Namesake |
|---|---|---:|---:|---:|---:|---:|
| Opus 5.5 | master | 38 | 21 | 0 | 0 | 0 |
| Opus 5.5 | Candidate 1 | 1 | 0 | 5 | 0 | 0 |
| Sonnet 5.5 | master | 11 | 4 | 10 | 8 | 0 |
| Sonnet 5.5 | Candidate 1 | 0 | 0 | 16 | 6 | 1 |
| gpt-6.1-sol | master | 3 | 1 | 0 | 0 | 0 |
| gpt-6.1-sol | Candidate 1 | 0 | 0 | 0 | 0 | 1 |

Sonnet's terms failures rose from 10 to 16. Its search and page-open counts barely moved (3.0 searches and 5.2 pages
per session against 2.9 and 4.6), and it opened the call note in 25 runs against 22. We have no mechanism for the rise;
the master arm's own run-to-run spread on terms is of this size (Candidate 0 measured 13 on the same code).

### The reader's route

| Reader | Arm | `entity` on the champion | Opened the handoff | Opened the reschedule mail | Searches per session |
|---|---|---:|---:|---:|---:|
| Opus 5.5 | master | 1/48 | 1 | 1 | 3.4 |
| Opus 5.5 | Candidate 1 | 2/48 | 47 | 46 | 3.7 |
| Sonnet 5.5 | master | 37/48 | 34 | 33 | 2.9 |
| Sonnet 5.5 | Candidate 1 | 32/48 | 45 | 40 | 3.0 |
| gpt-6.1-sol | master | 44/48 | 45 | 47 | 4.5 |
| gpt-6.1-sol | Candidate 1 | 48/48 | 48 | 48 | 3.9 |

Opus still almost never calls `entity`, and no longer needs to: the card puts the mails in front of it and it opens
them. On master, every contact or date failure in all three readers was in a run without `entity` on the champion.

### Resource envelope (Candidate 1 over master, limits 1.2x / 1.5x / 1.5x)

| Reader | Mean input tokens | p95 session-2 latency | Mean tokens | Mean dollars |
|---|---|---|---:|---:|
| Opus 5.5 | 168,498 → 171,539 | 46.1 s → 38.9 s (0.84x) | 1.02x | 1.03x |
| Sonnet 5.5 | 147,681 → 161,001 | 25.6 s → 28.1 s (1.10x) | 1.09x | 1.09x |
| gpt-6.1-sol | 102,924 → 102,804 | 45.9 s → 45.2 s (0.98x) | 1.00x | 0.96x |

All inside. The pushed hook context did not change size (about 550 characters per session in both arms): the section
rides on the `context_pack` tool result, not on the SessionStart push, because these sessions had no banked standing
entities.

### Validity checks

Both mutants run on Candidate 1 brains, on the development seeds, against Candidate 1's own repeat-1 cells. The
stale-correction mutant removes the correction pages, and the forced-drop mutant removes every item page and drops the
hook output, so no correction or commitment can reach the reader. If either did not raise failures, the scorer or the
harness would be giving Candidate 1 credit it did not earn.

| Mutant | Opus 5.5 | Sonnet 5.5 | gpt-6.1-sol |
|---|---|---|---|
| stale-correction | 24/24 failed (baseline 5/24), detected | 24/24 (10/24), detected | 24/24 (1/24), detected |
| forced-drop | 9/9 on seeds 20261101 to 20261103 (2/9), detected | 24/24 (10/24), detected | 24/24 (1/24), detected |

`stale_correction` rose above the baseline in every stale-correction cell. The Opus forced-drop mutant ran on the three
leading personas the remaining budget admitted (amendment 3, step 4); with three persona clusters its risk-difference
lower bound is still above 0. Every paired and mutant cell was scored, with no harness errors. Amendment 2 ran the
Sonnet and gpt-6.1-sol stale-correction cells; amendment 3 ran the rest.

### Fresh-seed check

Amendment 3 drew eight new seeds at random on 2026-10-09 at 07:45 UTC, after Candidate 1's code was frozen
(306480323, 316602389, 384540222, 476843991, 615322188, 691467441, 731983881, 767687777; world digest `081ea8b8`).
Same generator, knobs, scorer, readers and code identities; one repeat, 72 pairs. They test whether the development
result carries to worlds we never looked at. They are public in this repository, so they are not a held-out set.

| Reader | Master failures | Candidate 1 failures | Factor | 95% interval for R | Risk difference (95%) | Verdict |
|---|---:|---:|---:|---|---|---|
| Opus 5.5 | 17/24 | 3/24 | 5.00 | 0.03 to 0.61 | −58.3 pts (−83.0 to −33.6) | improvement |
| Sonnet 5.5 | 14/24 | 6/24 | 2.23 | 0.14 to 1.19 | −33.3 pts (−63.1 to −3.5) | inconclusive |
| gpt-6.1-sol | 2/24 | 0/24 | 5.00 | 0.00 to 5.33 | −8.3 pts (−21.2 to +4.6) | inconclusive (near ceiling) |
| **Pooled** | **33/72** | **9/72** | **3.53** | **0.12 to 0.58** | **−33.3 pts (−41.9 to −24.7)** | **improvement** |

Failed items by class on the fresh seeds: Opus contact 16 and date 9 on master, terms 3 on Candidate 1; Sonnet contact
12, date 11, terms 7 and namesake 1 on master, terms 5, contact 1 and hop 1 on Candidate 1; gpt-6.1-sol contact 1 and
date 1 on master, none on Candidate 1. Contact and date fell from 50 failed items to 1. Opus opened the handoff mail in
23 of 24 runs on Candidate 1 against 2 on master, without calling `entity` in either arm. Resource envelope, Candidate 1
over master: p95 session-2 latency 0.83x, 1.04x and 0.92x (Opus, Sonnet, gpt-6.1-sol), mean tokens 0.95x, 1.03x and
1.01x, mean dollars 1.03x, 1.08x and 1.01x, all inside the limits.

### Exploratory: Candidate 1 with the short-code alias fix

Descriptive only, preregistered as such before it ran, on fewer cells than planned because of the budget: gbrain
`8913cbeb`, a merge of Candidate 1 with GBRA-39's alias fix (`f24ca6afe` on #6271's branch; only the module-size ceiling
row conflicted). Repeat 1, compared with the same tasks' repeat-1 cells:

| Reader | Cells | Master | Candidate 1 | Candidate 1 + alias fix |
|---|---:|---:|---:|---:|
| Sonnet 5.5 (seeds 20261101 to 20261106) | 18 | 10 (contact 5, terms 3, hop 3, date 1) | 6 (terms 5, hop 2) | 1 (terms 1) |
| gpt-6.1-sol (seeds 20261101 to 20261104) | 12 | 1 | 0 | 0 |

The two fixes look additive on Sonnet: the alias fix links the call note ("Call with JOF") to the company, so the
company card carries the corrected figure, and the hop misses also disappeared. Eighteen cells is too few for a verdict;
it is the case for measuring the combination next.

## What to use and what to avoid

Ship Candidate 1 on by default. It wins clearly where the failures were (Opus 5.5, pooled), does not lose for any
reader, and stays inside the envelope. The improvement comes from putting dated evidence on the first call, not from
changing what readers decide: every reader that saw the mails used them.

Do not read the pooled factor as the product's ceiling. Terms failures remain because the call note links to no entity;
short-code aliases (candidate 2) address that, and the exploratory arm suggests they stack. Sonnet's verdict is
inconclusive; its contact and date failures are gone, but its terms failures carry the arm.

Limits: development and fresh public seeds only, no custodian-sealed set; the per-turn pointer is unchanged; on a busy
brain the newest mentions of an entity can be routine mail, and this workload does not test that precision (a
large-brain check belongs in the held-out gate). The Opus forced-drop mutant ran on 9 of its 24 cells.

## Reproduce and inspect

```bash
# gbrain measurement builds (in a gbrain checkout): Candidate 1 = 82460865 on fc548317; exploratory = 8913cbeb
bun eval/runner/budget-ledger.ts open --runner t0b-program-primary --budget-usd 60
R="bun eval/runner/t0b-program-primary.ts --concurrency 3 --paid --budget-run-id <id>"
$R --gbrain <gbrain>@fc548317f628f25c6708049e17af22ee6b4e28ad --output <master> --arms baseline --repeat 2
$R --gbrain <gbrain>@82460865ef7e9313cdcd69b3b52a665ba8825bdb --output <c1> --arms baseline --repeat 2
$R --gbrain <gbrain>@82460865ef7e9313cdcd69b3b52a665ba8825bdb --output <c1m> --arms mutant-stale-correction --readers gpt-6.1-sol   # then claude-sonnet-5-5
bun eval/runner/t0/paired.ts --baseline <master>/results.jsonl --candidate <c1>/results.jsonl
python3 docs/benchmarks/2026-10-08-program-primary-hard/candidate-1-newer-mentions/analyze.py
# amendment 3 ($45 run): mutants on the development seeds, then the fresh seeds in two-persona batches, both arms at once
$R --gbrain <gbrain>@82460865ef7e9313cdcd69b3b52a665ba8825bdb --output <c1m3> --arms mutant-stale-correction --readers claude-opus-5-5
$R --gbrain <gbrain>@82460865ef7e9313cdcd69b3b52a665ba8825bdb --output <c1m3> --arms mutant-forced-drop --readers gpt-6.1-sol   # then claude-sonnet-5-5; Opus on --seeds 20261101,20261102,20261103
$R --gbrain <gbrain>@<master or Candidate 1> --output <fresh-arm> --arms baseline --repeat 1 --seeds 306480323,316602389   # and the next three pairs
bun eval/runner/t0/paired.ts --baseline <fresh-master>/results.jsonl --candidate <fresh-c1>/results.jsonl --repeats 1
bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-1-newer-mentions/gold.ts <fresh seeds> > gold-fresh.json
python3 docs/benchmarks/2026-10-08-program-primary-hard/candidate-1-newer-mentions/analyze.py --arms fresh-seeds --gold gold-fresh.json
# $0 mechanism check
bun docs/benchmarks/2026-10-08-program-primary-hard/candidate-1-newer-mentions/card-probe.ts --gbrain <gbrain> --ref <sha> --label <name>
```

Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`. Bun 1.4.2 (also at `/usr/local/bin/bun`, which harness
slots spawn). Each 144-cell arm took about an hour at concurrency 3.

Receipts in [`2026-10-08-program-primary-hard/candidate-1-newer-mentions/`](2026-10-08-program-primary-hard/candidate-1-newer-mentions/):
`master/`, `candidate-1/`, `candidate-1-mutant-stale-correction/`, `exploratory-candidate-1-plus-f24ca6afe/` (each
`results.jsonl.gz`, `usage.jsonl.gz`, `experiment.json`, `receipt.json`, cost receipts), `paired.json`, `summary.json`,
`route.json`, `analyze.py`, `card-probe.ts` and its two outputs; amendment 3's `candidate-1-mutants-amendment-3/` and
`fresh-seeds/` (`master/`, `candidate-1/`, `paired.json`, `route.json`), `gold.ts` and `gold-fresh.json`.

| Ledger run `t0b-program-primary-2026-10-09T05-58-28-840Z-2773d713` | Dollars (cell receipts) |
|---|---:|
| Master arm, 144 cells | 23.23 |
| Candidate 1 arm, 144 cells | 24.14 |
| Candidate 1 stale-correction mutant, 48 cells | 4.90 |
| Exploratory arm, 30 cells | 4.04 |
| **Ledger total (includes brain builds and provider calls outside cells)** | **58.36 of 60** |

| Ledger run `t0b-program-primary-2026-10-09T07-49-07-137Z-5fce8fdd` (amendment 3) | Dollars (cell receipts) |
|---|---:|
| Mutants: stale-correction Opus 24, forced-drop gpt-6.1-sol 24, Sonnet 24, Opus 9 | 17.37 |
| Fresh seeds, master arm, 72 cells | 11.48 |
| Fresh seeds, Candidate 1 arm, 72 cells | 11.95 |
| **Ledger total** | **42.38 of 45** |

## Changelog

### 2026-10-09: validity mutants and a fresh-seed check

Added amendment 3's results: every mutant detected (stale-correction for all three readers, forced-drop for all three,
Opus on 9 cells), and the fresh-seed check (pooled 33 to 9 of 72, factor 3.53, `improvement`). The finding now states
the fresh-seed result and the limits no longer list missing mutants.

### 2026-10-09: first version

Candidate 1 measured against a fresh master arm under amendment 2.

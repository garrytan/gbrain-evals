# On a Git-canonical source, gbrain v0.60.685.0 keeps a fact about an entity with no page in Git, and agents report it correctly

gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

- **We learned that gbrain v0.60.685.0 keeps the fact in Git every time.** An agent asked to remember a fact about a person or project that has no page, on a source whose pages are canonical in Git, left that fact in a database rebuilt from Git in 144 of 144 trials on v0.60.685.0 (`505204a9`) and 0 of 144 on v0.60.684.0 (`47cbca02`), on both claude-opus-5-5 and gpt-6.1-sol. The fact is committed on the holding page `memory/unattributed` with the entity named in its row. You should treat Git as the record for these facts from v0.60.685.0 on: a rebuild no longer loses them.
- **We learned that a reply that says where a fact really went stops agents from misreporting it.** On v0.60.684.0, `remember` answered with `page` set to a page that did not exist and said "no repository configured" on a source that has one. claude-opus-5-5 repeated it: 10 of 72 replies placed the fact on a page that did not exist (9 by hand; see the hand-check), and 34 of 72 told the user the brain has no repository. On v0.60.685.0 both fell to 0 of 72: truthful reports +13.9 points (95% interval +5.6 to +23.6). gpt-6.1-sol was already right in 72 of 72 replies before the change, a ceiling, so it shows no measurable difference. If you build agent tools, you should name in the reply only the place a write actually landed.
- **What didn't work as intended: the new notice makes agents create pages nobody asked for.** v0.60.685.0's `entity_page_missing` notice gives `put_page` as the next step to run. Agents ran it: gpt-6.1-sol created the entity's page in 58 of 72 trials and claude-opus-5-5 in 41 of 72 (2 and 0 before), and 45 of those 99 pages carry only a title. The user asked only to remember one fact. You should read the notice's `next: run` as an instruction agents follow, and decide whether creating the page should wait for the user.

The preregistered verdict is **KEEP**: kept-in-Git improves on both models with intervals that exclude 0, and the truthful-report rate does not fall.

## The case

A gbrain source can be marked `canonical: git` ("strict"): its pages live in a Git repository, and the database is an index that can be rebuilt from it. An agent saving a fact uses `remember` with an `entity`, such as `people/ivan-example`. When that entity has a page, the fact goes into the page's facts table, in its file. The question here is the other case, an entity with no page yet. An invented example, item 1 of 24:

> Please remember this about Ivan Example (people/ivan-example): their badge number is K2-4152. Where did you save that?

- On v0.60.684.0 the fact was stored in the database only. The reply said `"page": "people/ivan-example"` and `write_through.skipped: no_repo_configured`, so a brain rebuilt from Git lost the fact, and the reply named a page that did not exist.
- On v0.60.685.0 (gbrain#9179, with #9165 and #9178) the fact is committed to Git on `memory/unattributed`, in a row whose `entity` column names `people/ivan-example`. The reply says `"page": "memory/unattributed"` and `write_through.held_for`, and an `entity_page_missing` notice says the fact is saved and committed, and that the next maintenance cycle moves it once the entity has a page.

## The experiment

- **Brain.** A fresh synthetic PGLite brain per trial, built by the refused-write-agents fixture (`eval/runner/refresh-barrier/trial.ts openBrain`): a managed Git clone with two sources, Git durability on, eight `people/*-example` pages and eight notes each. The source the agent writes to is marked `canonical: git`. No refresh, no fault.
- **Agent.** The tool list and server instructions gbrain's stdio MCP server builds (164 tools), the Cat 40 agent loop at medium effort, at most 12 turns, calls dispatched as a remote stdio client. The agent ends by sending its reply to the user.
- **Items.** 24 user turns (`eval/runner/strict-pageless/items.ts`), each one fact with a unique token about an entity with no page: 12 people, 12 projects; 16 give the slug, 8 only the name; 4 add "Where did you save that?" and 4 "Is it on their page now?".
- **Arms and models.** gbrain `47cbca02` (v0.60.684.0) against `505204a9` (v0.60.685.0), on claude-opus-5-5 and gpt-6.1-sol. Each item ran 3 times per cell: 72 trials per cell, 288 in all, paired by item and replicate.
- **Scoring, by code, no model judge.**
  - *Kept in Git:* alpha's folder from a `git clone` of the brain's HEAD is synced into a new database and the facts step is run; the trial counts when an active fact row carries the token for the item's entity.
  - *Truthful report:* `report.ts` reads the reply against where the token actually is. It is wrong when it puts the fact on the entity's page (or names that page as where it went) and the token is not in that page's file, says the save failed when it did not, claims Git or database-only falsely, or names the holding page when the fact is not there.
  - *Exposure:* a `remember` carrying the token for the item's entity while that entity had no page.

## Results

| Cell | Trials | Exposure | Kept in Git | Truthful report | Says where | Says "no repository" | Created the entity's page |
|---|---|---|---|---|---|---|---|
| gpt-6.1-sol, v0.60.684.0 | 72 | 72 | 0 | 72 | 26 | 6 | 2 |
| gpt-6.1-sol, v0.60.685.0 | 72 | 72 | 72 | 72 | 40 | 0 | 58 |
| claude-opus-5-5, v0.60.684.0 | 72 | 72 | 0 | 62 | 52 | 34 | 0 |
| claude-opus-5-5, v0.60.685.0 | 72 | 72 | 72 | 72 | 72 | 0 | 41 |

Every trial ended with the agent's reply; no trial errored or was rerun.

Paired differences (v0.60.685.0 minus v0.60.684.0), 95% intervals: item-cluster bootstrap (primary; 24 items resampled, 10,000 draws, seed 449) and Newcombe's hybrid score interval. Where the bootstrap degenerates (every pair moved the same way or none moved), the Newcombe interval is the one to read.

| Outcome | Model | Before | After | Difference | Bootstrap 95% | Newcombe 95% |
|---|---|---|---|---|---|---|
| Kept in Git (primary) | gpt-6.1-sol | 0/72 | 72/72 | +100.0 pts | degenerate | +92.8 to +100.0 |
| Kept in Git (primary) | claude-opus-5-5 | 0/72 | 72/72 | +100.0 pts | degenerate | +92.8 to +100.0 |
| Truthful report (primary) | gpt-6.1-sol | 72/72 | 72/72 | 0.0 pts | degenerate | -5.1 to +5.1 |
| Truthful report (primary) | claude-opus-5-5 | 62/72 | 72/72 | +13.9 pts | +5.6 to +23.6 | +5.9 to +23.7 |
| Truthful report | pooled | 134/144 | 144/144 | +6.9 pts | +2.8 to +11.8 | +2.9 to +12.3 |
| Says "no repository" (secondary) | claude-opus-5-5 | 34/72 | 0/72 | -47.2 pts | -63.9 to -31.9 | -58.6 to -35.0 |
| Says "no repository" (secondary) | gpt-6.1-sol | 6/72 | 0/72 | -8.3 pts | -20.8 to 0.0 | -17.0 to -1.6 |
| Says where (secondary) | gpt-6.1-sol | 26/72 | 40/72 | +19.4 pts | +6.9 to +33.3 | +7.0 to +30.9 |
| Says where (secondary) | claude-opus-5-5 | 52/72 | 72/72 | +27.8 pts | +18.1 to +38.9 | +17.4 to +39.0 |
| Created the page (secondary) | gpt-6.1-sol | 2/72 | 58/72 | +77.8 pts | +63.9 to +90.3 | +65.2 to +85.5 |
| Created the page (secondary) | claude-opus-5-5 | 0/72 | 41/72 | +56.9 pts | +40.3 to +73.6 | +44.4 to +67.7 |

On the 8 forced-report items, claude-opus-5-5 was truthful in 9 of 12 "where" trials and 11 of 12 "is it on the page" trials before, 12 of 12 each after; gpt-6.1-sol 12 of 12 on both, in both arms.

**What the misreports look like.** All 9 hand-confirmed misreports are claude-opus-5-5 on v0.60.684.0 repeating the reply's `page` field, as in "It's stored as fact #1 on people/jun-example." In 5 of the 9 the same reply also says the fact is in the database only, so a careful reader could untangle it; in 4 it does not.

**Why gpt-6.1-sol shows no difference.** It met the case in all 144 trials (exposure 72 of 72 in each arm), the task is the one the change targets, and 72 pairs detect about an 11-point difference. It sat at a ceiling: on v0.60.684.0 it mostly said "Remembered: ..." without naming a place (it named one in 26 of 72), and when asked "Is it on their page now?" it answered no correctly in 12 of 12. That forced question was the planned attempt to raise the ceiling, and it did not.

**Pages created unasked.** On v0.60.685.0 every page an agent created was at the slug of the entity the fact is held for, so the next maintenance cycle can move the fact there. 54 of the 99 carry the fact as text as well; 45 carry only a title. On v0.60.684.0 the reply had no such notice, and pages were created in 2 of 144 trials.

## The rule check

The truthful-report rule was hand-checked before the counted run on 24 pilot replies (6 per cell, pilot items 101 to 106): all 24 were right by hand; the rule's first version agreed on 21 and the frozen version on 24, but the frozen version was fixed on those replies. After the run, 40 counted replies drawn at random (seed 449) were labelled by hand without looking at the rule's verdict: the rule agreed on 40 of 40 (3 wrong, 37 right). One error outside that sample is known: one claude-opus-5-5 v0.60.684.0 reply ("it wasn't saved to a file either because this brain has no repo set up") is scored as a false failure but is right by hand. The tables keep the rule's score; by hand that cell is 63 of 72 and claude-opus-5-5's difference +12.5 points. Details: [rule-handcheck.json](2026-11-12-strict-pageless-facts/rule-handcheck.json).

## What this does not show

Postgres; a refresh during the write; managed sources that are not strict and brains with no repository (their behaviour did not change); the move into the page once it exists (gbrain's own tests cover it); conversations longer than one turn; real brains; particle-1, which this machine had no key for.

## Reproduce

From a gbrain-evals checkout at this commit, with a gbrain checkout (`bun install`) at each commit and `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set:

```
bun eval/runner/strict-pageless/agent.ts --model anthropic:claude-opus-5-5 --gbrain-root <gbrain at 505204a9> \
  --items 1-24 --k 3 --out <runs>/claude-opus-5-5-505204a9 --budget-ledger <ledger> --program-cap-usd <cap> --budget-usd <cell budget>
bun eval/runner/strict-pageless/analyze.ts --before 47cbca02 --after 505204a9 --runs <runs> --out <out>
```

`--model fake` runs a scripted keyless agent. Each process keeps memory from every episode's in-process databases, so the counted run used processes of at most 4 items (about 1 GB each); four cells in parallel took 13 to 29 minutes on a 4-CPU, 16 GB machine. Raw rows: [outcomes.jsonl](2026-11-12-strict-pageless-facts/outcomes.jsonl), [summary.json](2026-11-12-strict-pageless-facts/summary.json). Preregistration: [2026-11-12-strict-pageless-facts-preregistration.md](2026-11-12-strict-pageless-facts-preregistration.md), frozen before the first counted trial, with one change written before the run resumed (processes and per-cell budgets after a memory stop; nothing in the method).

## Agent notes

GBRA-449, for GBRA-108. Preregistration frozen first in GBrain Minder's drive and copied here; this repository's runtime attestation against `origin` was not used, so the commit order is the only in-repository evidence of it. Harness commit `43f8cd15` (agent.ts sha256 `b73fb5a8…` for every counted trial). After the run, one typecheck-only edit removed a duplicate `item` key from the episode record; the later key, the whole item, already won at run time, so recorded episodes are unchanged. Model freshness checked with `scripts/model-freshness.ts` on 2026-11-12.

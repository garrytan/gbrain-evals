# On a Git-canonical source, gbrain v0.60.685.0 keeps a fact about an entity with no page in Git, and agents report it correctly

- **We learned that gbrain v0.60.685.0 keeps the fact in Git every time.** An agent asked to remember a fact about a person or project that has no page, on a source whose pages are canonical in Git, left that fact in a database rebuilt from Git in 144 of 144 trials on v0.60.685.0 (`505204a9`) and 0 of 144 on v0.60.684.0 (`47cbca02`), on both claude-opus-5-5 and gpt-6.1-sol (+100.0 points on each model, 95% interval +92.8 to +100.0). The fact is committed on the holding page `memory/unattributed` with the entity named in its row. You should treat Git as the record for these facts from v0.60.685.0 on: a rebuild no longer loses them.
- **We learned that a reply that says where a fact really went stops agents from misreporting it.** On v0.60.684.0, `remember` answered with `page` set to a page that did not exist and said "no repository configured" on a source that has one. claude-opus-5-5 repeated it: 9 of 72 replies placed the fact on a page that did not exist, and 34 of 72 told the user the brain has no repository. The rule scores one more reply wrong, a false failure that is right on a reading of the reply (see the rule check). On v0.60.685.0 both fell to 0 of 72: truthful reports +13.9 points (95% interval +5.6 to +23.6), and "no repository" replies -47.2 points (a secondary outcome, 95% interval -63.9 to -31.9). gpt-6.1-sol was already right in 72 of 72 replies before the change, a ceiling, so it shows no measurable difference (0.0 points, 95% interval -5.1 to +5.1). If you build agent tools, you should name in the reply only the place a write actually landed.
- **What didn't work as intended: the new notice makes agents create pages nobody asked for.** v0.60.685.0's `entity_page_missing` notice gives `put_page` as the next step to run. Agents ran it: gpt-6.1-sol created the entity's page in 58 of 72 trials and claude-opus-5-5 in 41 of 72 (2 and 0 before; a secondary outcome, +77.8 points, 95% interval +63.9 to +90.3, and +56.9 points, +40.3 to +73.6), and 45 of those 99 pages lack the fact (39 carry nothing but a title). The user asked only to remember one fact. You should read the notice's `next: run` as an instruction agents follow, and decide whether creating the page should wait for the user.
- **We learned that the same notice without a step to run stops those pages, and the other two outcomes hold.** gbrain#9202 (`e09d662c`, v0.60.688.0) keeps what the notice says (saved, committed, held on `memory/unattributed`, moved once a page exists) and replaces `fix: put_page` and `next: run` with "Nothing needs to run". In a preregistered re-run of the after arm, paired by item and replicate with `505204a9`, page creation fell from 58 to 0 of 72 on gpt-6.1-sol (−80.6 points, 95% interval −88.0 to −68.8) and from 41 to 0 of 72 on claude-opus-5-5 (−56.9 points, −67.7 to −44.4). Kept in Git stayed 72 of 72 and truthful reports 72 of 72 on both models, by the rule, and a check of 40 of those replies by the eval agent found no rule error. Both were already at that ceiling, so the re-run shows they did not fall, not that they could rise. gpt-6.1-sol also said where the fact went more often (70 of 72 against 40, +41.7 points, +28.8 to +53.3). You should put a next step in a tool's notice only when you want the agent to take it.

The preregistered verdict is **KEEP**: kept-in-Git improves on both models with intervals that exclude 0, and the truthful-report rate does not fall. The re-run's preregistered verdict for #9202's notice (Change 2) is also **KEEP**: page creation is lower on both models with intervals wholly below 0, and both guard outcomes hold (each lower bound −5.1 points, against a floor of −10).

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

Every trial ended with the agent's reply, and no trial errored. The four trials in flight when the first processes were stopped for memory (Change 1) were run again from the start, once each. Two of them (gpt-6.1-sol, item 13 replicate 1 on v0.60.685.0 and item 17 replicate 1 on v0.60.684.0) had already sent model requests, so their counted episodes are the second start, recorded as attempt 1. Every rebuild from Git threw no error and reported a first sync (`first_sync`). In 2 of the 144 before-arm trials (gpt-6.1-sol, item 8, replicates 2 and 3) the agent also created the entity's page and copied the code into its prose: the code was in Git as page text, but the saved fact stayed in the database only, so under the preregistered rule those trials count as not kept.

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

**What the misreports look like.** All 9 misreports, each confirmed on a reading of the reply, are claude-opus-5-5 on v0.60.684.0 repeating the reply's `page` field, as in "It's stored as fact #1 on people/jun-example." In 5 of the 9 the same reply also says the fact is in the database only, so a careful reader could untangle it; in 4 it does not.

**Why gpt-6.1-sol shows no difference.** It met the case in all 144 trials (exposure 72 of 72 in each arm), the task is the one the change targets, and 72 pairs detect about an 11-point difference. It sat at a ceiling: on v0.60.684.0 it mostly said "Remembered: ..." without naming a place (it named one in 26 of 72), and when asked "Is it on their page now?" it answered no correctly in 12 of 12. That forced question was the planned attempt to raise the ceiling, and it did not.

**Pages created unasked.** On v0.60.685.0 every page an agent created was at the slug of the entity the fact is held for, so the next maintenance cycle can move the fact there. 54 of the 99 carry the fact as text as well; 45 do not, and 39 of those carry nothing but frontmatter and a heading (the other 6 add a one-line description). An earlier version of this report said all 45 carry only a title. On v0.60.684.0 the reply had no such notice, and pages were created in 2 of 144 trials.

## Re-run: the notice without a next step (gbrain e09d662c)

gbrain#9202 changes one thing an agent sees here. Where the fact is already committed, the `entity_page_missing` notice now reads "Saved and committed to Git; held on memory/unattributed until people/uma-example has a page. Say that when you report the save. Nothing needs to run: once the page exists, the next maintenance cycle (gbrain dream) moves the fact into the page's Facts table, in its file." It has no `fix:` and no `next:` line. The re-run ran the same 24 items, 3 replicates, prompts, tools and scoring on `e09d662c` (v0.60.688.0), 144 trials, and compared each trial with the same item and replicate on `505204a9` ([Change 2](2026-11-12-strict-pageless-facts-preregistration.md)).

| Cell (72 trials each) | Pages created | Without the fact | Title-only | Kept in Git | Truthful, rule | Says where |
|---|---|---|---|---|---|---|
| gpt-6.1-sol, `505204a9` | 58 | 22 | 22 | 72 | 72 | 40 |
| gpt-6.1-sol, `e09d662c` | 0 | 0 | 0 | 72 | 72 | 70 |
| claude-opus-5-5, `505204a9` | 41 | 23 | 17 | 72 | 72 | 72 |
| claude-opus-5-5, `e09d662c` | 0 | 0 | 0 | 72 | 72 | 72 |

Paired differences, re-run minus first run, with Newcombe 95% intervals (the item-cluster bootstrap beside it in [summary.json](2026-11-12-strict-pageless-facts/rerun/summary.json)):

- **Pages created (primary).** gpt-6.1-sol −80.6 points (−88.0 to −68.8), claude-opus-5-5 −56.9 (−67.7 to −44.4). Every discordant pair went one way: 58 and 41 trials created a page before, none after. The smallest reduction this design could detect at 80% power was stated in advance as about 24 and 25 points.
- **Pages without the fact, and title-only pages.** gpt-6.1-sol −30.6 points (−42.0 to −19.9) for both; claude-opus-5-5 −31.9 (−43.4 to −21.1) and −23.6 (−34.6 to −13.9). In the first run the share of created pages without the fact was 22 of 58 (Wilson 95% 26.6% to 50.8%) and 23 of 41 (41.0% to 70.1%); title-only, 22 of 58 (26.6% to 50.8%) and 17 of 41 (27.8% to 56.6%). The re-run created no pages, so it has no share to compare.
- **Kept in Git and truthful report (guards).** 0.0 points on both models (−5.1 to +5.1). Both were 72 of 72 before and after, a ceiling: the re-run shows the change did not make them worse, the preregistered criterion, and cannot show more.
- **Says where the fact went.** gpt-6.1-sol +41.7 points (+28.8 to +53.3); claude-opus-5-5 was 72 of 72 in both. False "no repository" replies stayed at 0.

Exposure was 72 of 72 in every cell: every trial met the case. Every trial ended with a reply on its first attempt, with no errored or harness-error attempt, and every rebuild synced with no error. **Hand-check:** 40 re-run replies drawn at random (seed 9202) were labelled by the eval agent that ran the experiment, on claude-opus-5-5 (one of the two models under test), not by a person. Each reply's rule verdict was hidden from it, but it already knew the rule had scored all 144 re-run replies truthful, so the sample was less blind than Change 2's plan intended. All 40 were right, and the rule agreed on 40 of 40. Of the 23 re-run sentences the rule's hedge and negation filters skipped, which the same agent read, every one says the fact is not on a page yet or will move there later, which is true; none hides a false claim. [rule-handcheck.json](2026-11-12-strict-pageless-facts/rerun/rule-handcheck.json) has both.

One defect from the first run is still there. For the 8 items that give only a name, the agent usually passes an entity such as `community-garden-project`, not `projects/community-garden` (45 of 48 such trials on `e09d662c`), and gbrain keeps it as a top-level entity. The fact is still kept and the reply still truthful, but its entity does not match a page created later at the expected slug.

## The rule check

Every label in this section, and in the re-run's check above, was made by the eval agent that ran the experiment, on claude-opus-5-5, one of the two models under test, not by a person. "By hand" here means that agent's reading of each reply; both outcomes are scored by code. The truthful-report rule was hand-checked before the counted run on 24 pilot replies (6 per cell, pilot items 101 to 106): all 24 were right by hand; the rule's first version agreed on 21 and the frozen version on 24, but the frozen version was fixed on those replies. After the run, 40 counted replies drawn at random (seed 449) were labelled by that agent with each reply's rule verdict hidden: the rule agreed on 40 of 40 (3 wrong, 37 right). Two errors outside that sample are known, both in claude-opus-5-5 v0.60.684.0 replies. One reply ("it wasn't saved to a file either because this brain has no repo set up") is scored as a false failure but is right by hand. In another (item 19, replicate 1) the rule skipped the sentence "It's stored as fact #1 on people/rosa-example, and when I read it back with recall it came up correctly" because of its unrelated "when" clause. That reply is right by hand, because it goes on to say the fact is not on their page and the page does not exist; a stricter reading would count the sentence as a page claim and the reply as wrong. The tables keep the rule's score; by hand that cell is 63 of 72 and claude-opus-5-5's difference +12.5 points (62 of 72 and +13.9 points on the stricter reading). A check of all 288 replies for sentences the rule's hedge and negation filters skipped found no other false claim: in both after arms, every skipped sentence speaks of the future, or says the entity has no page or the fact is not on it. [rule-handcheck.json](2026-11-12-strict-pageless-facts/rule-handcheck.json) records the pilot check, the 40-reply sample and the first known error; its labeller field, "the GBRA-449 agent, by hand", means that agent's reading. The second error and the check of skipped sentences were read from the run's episode files, which hold each reply's text and are not in this repository; outcomes.jsonl keeps no reply text.

## What this does not show

Postgres; a refresh during the write; managed sources that are not strict and brains with no repository (their behaviour did not change); the move into the page once it exists (gbrain's own tests cover it); conversations longer than one turn; real brains; particle-1, which this machine had no key for.

## Reproduce

From a gbrain-evals checkout at this commit, with a gbrain checkout (`bun install`) at each commit and `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set:

```
bun eval/runner/strict-pageless/agent.ts --model anthropic:claude-opus-5-5 --gbrain-root <gbrain at 505204a9> \
  --items 1-24 --k 3 --out <runs>/claude-opus-5-5-505204a9 --budget-ledger <ledger> --program-cap-usd <cap> --budget-usd <cell budget>
bun eval/runner/strict-pageless/analyze.ts --before 47cbca02 --after 505204a9 --runs <runs> --out <out>
```

The re-run used the same command with `--gbrain-root <gbrain at e09d662c>` and `--out <runs>/<model>-e09d662c`, one process per 4 items, then `analyze.ts --before 505204a9 --after e09d662c`. Its rows: [rerun/outcomes.jsonl](2026-11-12-strict-pageless-facts/rerun/outcomes.jsonl), [rerun/summary.json](2026-11-12-strict-pageless-facts/rerun/summary.json). The first run's files were regenerated with the analysis at this commit, which adds the `page_without_fact` and `page_title_only` columns; no earlier value changed.

`--model fake` runs a scripted keyless agent. Each process keeps memory from every episode's in-process databases, so the counted run used processes of at most 4 items (about 1 GB each); four cells in parallel took 13 to 29 minutes on a 4-CPU, 16 GB machine. Raw rows: [outcomes.jsonl](2026-11-12-strict-pageless-facts/outcomes.jsonl), [summary.json](2026-11-12-strict-pageless-facts/summary.json). Preregistration: [2026-11-12-strict-pageless-facts-preregistration.md](2026-11-12-strict-pageless-facts-preregistration.md) (see the freeze margin under Agent notes), with one change written before the run resumed (processes and per-cell budgets after a memory stop; nothing in the method).

## Agent notes

GBRA-449, for GBRA-108. The preregistration was written to GBrain Minder's drive and copied here; this repository's runtime attestation against `origin` was not used.

**Freeze margin, stated plainly.** The preregistration commit in this repository (`05676ac5`) is stamped 02:58:01Z on 2026-11-12. By the preregistration's own change note, the four counted cells started at 02:57Z. So the record does not show the freeze ahead of the first counted trial by more than about a minute; the commit by itself comes after the start. The drive copy's first write has no timestamp of its own. The firmest evidence I have is the drive's retained version history. Version `vver_01M76V0HEBT94KQZWSF1G20BHB`, recorded 02:57:23.915Z, is the first that holds the drive's `eval-prereg.md`; the version before it (02:54:27Z) does not. Its content is byte-identical to `05676ac5` (sha256 `8c33822a…`). The budget ledger opened the first counted run at 02:57:41.195Z and recorded its first counted request at 02:57:51.430Z, and the first counted episode file was written at 02:57:59Z. That puts the frozen text in the drive about 17 seconds before the first counted ledger run and about 27 seconds before the first counted request. A version's time is when the drive recorded the snapshot, so it bounds the write from above and proves nothing more. The harness, scoring rules included, was committed at 02:56:43Z (`43f8cd15`). What bears on it: both outcomes are scored by code, with no model judge. The eval agent (claude-opus-5-5) checked the report rule on 24 pilot replies before the counted run, and its check of 40 counted replies after the run, with each reply's verdict hidden, agreed 40 of 40. GBEV-3 decides whether this run counts as preregistered.

GBEV-3 ruled on 2026-11-12 that the preregistration counts as frozen: its text was recorded in the drive 17 seconds before the first counted ledger run.

Harness commit `43f8cd15`: every counted process, first and resumed, ran from one checkout whose agent.ts was sha256 `b73fb5a8…`, and the last counted episode was written at 03:33:42Z. Three edits came after it, and none changes a recorded outcome. `54f8f107` (03:42:06Z) removed a duplicate `item` key from the episode record (agent.ts `e960b0bc…`); the later key, the whole item, already won at run time. `ff86c4ea` (03:55:52Z) sorts analyze.ts's directory reads (analyze.ts `82dfeff7…`), and `6ff29e89` (04:29:56Z) stops analyze.ts writing cost fields (analyze.ts `c4920e16…`); the committed outcomes.jsonl and summary.json were regenerated there and differ from the run-time output only by those fields. All 288 episode records show a rebuild that threw no error and reported `sync_status: first_sync`, and an ok quiesce, and every record is attempt 1. Model freshness checked with `scripts/model-freshness.ts` on 2026-11-12.

Change 1 needs two notes. Its count of episodes written before the stop was read a few seconds before two processes stopped: Opus before had written 26 (all of replicate 1 and items 1 and 2 of replicate 2) and Sol before 16, not 24 and 15; Opus after 18 and Sol after 12 are right. The resumed processes skipped every file that existed, and each cell ends with exactly 72 records. And "written before any cell resumed" rests on file times only: the run machine's drive copy holding Change 1 was last written at 03:04:42.339Z and the first resumed ledger run started at 03:04:42.836Z, about half a second later. The drive's version history no longer reaches that far back, and the repository commit (`7fe8205b`, 03:37:50Z) came after the run.

**Re-run freeze, with times.** Change 2 and the cell guards are commit `79468f73`, committed at 07:52:37Z on 2026-11-12 and pushed to `capy/gbra449-strict-pageless-rerun`; GitHub recorded the branch's creation at that commit at 07:52:39Z, and the remote head was confirmed at 07:52:40Z. The first counted ledger run of the re-run opened at 07:55:42.287Z, 3 minutes 2 seconds after GitHub's record, its first counted request was at 07:55:49.133Z, and the first counted episode file was written at 07:55:59Z. A keyless smoke and a two-trial paid pilot per model (pilot items 101 and 102, outside the counted set) ran before the commit, on the guarded harness. The first pilot attempt stopped at its own budget on its first request, because the ledger reserves for a request that misses the prompt cache; it wrote `cap-stop.json`, which the new guard would refuse to relaunch, so the pilot ran again, with larger pilot budgets, into a fresh directory. Every counted process ran from `79468f73` (agent.ts sha256 `7f9e369e…`, as Change 2 records), and the last counted episode was written at about 08:28Z.

**Who labelled, and the harness gaps the review found.** Change 2's hand-check plan says the 40 replies are "labelled by hand without looking at the rule's verdict". The labels in both runs came from GBRA-449's eval subagent on claude-opus-5-5, and for the re-run it knew the rule's 144-of-144 total before it drew the sample; both rule-handcheck.json files keep their original wording. GBEV-3 ruled on 2026-11-12 to keep the KEEP verdict and say this plainly. The /ship review of this release found three gaps in the cell guards and the analysis, ruled as open notes, none of which touched a counted episode by GBRA-449's check of the private records: a process killed mid-episode leaves no attempt file, so a relaunch would run attempt 1 again (the re-run had no relaunch: 18 of 18 ledger runs per cell finished); `unscorable()` catches only a rebuild that throws, not a blocked or partial sync (all 432 counted episodes report `first_sync`); and the page-content columns read the agent's last `put_page`, not the page's final bytes (each of the 101 created pages had one successful matching `put_page` and no later write). The fixes belong in the next experiment's harness, because agent.ts and analyze.ts stay byte-identical to what Change 2 preregistered.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
  Garry Tan runs Y Combinator.

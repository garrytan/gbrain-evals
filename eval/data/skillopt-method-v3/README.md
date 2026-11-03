# skillopt-method-v3

skillopt-method-v3 holds the task sets of the SkillOpt ceiling attempt (category `skillopt-method`, N15; issue GBEV-30,
plan sections 2 to 4). This is revision 1, the plan's one revision after calibration put the seed at the ceiling on
query and briefing. It changes task structure, not knobs: every family is new, and each is built so that gbrain's
keyword search does not hand over the deciding pages from the question's own words. Its tasks test what a skill's
procedure adds on a brain built to need it:

- indirect references: an account named only as "the account where P works as T", a person named only as "C's former
  T", a company named only as "the company that acquired C";
- joins: the one account meeting two conditions that two different pages decide (two terms, or its owner and a term);
- aggregation over 10 or more pages: which of a Lanterncrest rep's accounts had the most or fewest seats, the highest or
  lowest price, the largest or smallest discount or the earliest renewal on a date, or their total seats;
- buried supersession: two thirds of the accounts with three or more records moved their later contracts to a legal
  entity whose name shares no word with the account's, so the record in force names the entity and a search on the
  account's name ranks the older records first;
- abstention: a legal-entity name or a contact no page carries, built from real ones.

The rollout brain is world-v3's 1,030 pages ([`world-v3.ts`](../../generators/skillopt-method/world-v3.ts)), and the seed
skills are the ones gbrain ships at `311a83bbe` (v0.60.553.0). They are byte-identical to v1's and v2's seeds (gbrain
`3ec766c40`): none of the three changed between the two commits. This commit's `package.json` pins gbrain `311a83bbe`
(v0.60.553.0), the same commit the seeds come from.

Every reader names v3 explicitly: [`dataset.ts`](../../runner/skillopt-method/dataset.ts) keeps v2 as the N15 default, and
[`dataset-context.ts`](../../runner/skillopt-method/dataset-context.ts) hands brain import, the audit and the proposer's
redaction v3's own pages and names, cached per sha256 of [`MANIFEST.json`](MANIFEST.json).

## Tasks

Each skill has 180 tasks: 24 train, 24 selection, 36 gate and 96 test. Gate and test are sealed: only
`readSealedTasks` reads them. Held-out families appear only in gate and test, so no optimizer sees them. Train is
ordered round-robin by family, so each of gbrain's batches of 8 covers every trained family.

| Skill | Family | Train / sel / gate / test | What the task asks |
|---|---|---|---|
| `query` | legal-as-of | 5 / 5 / 4 / 10 | An account's term as of a date when the record in force names its legal entity; the records naming the account hold a superseded value |
| | contact-as-of | 5 / 5 / 4 / 10 | "As of D, what was the support tier of the account where P works as T?" |
| | join-two | 5 / 5 / 4 / 10 | "As of D, which account was on Tier 2 support and on payment terms of net 45?" (or owned by a named rep and on a term) |
| | rep-extreme | 5 / 5 / 3 / 10 | "On D, which of the accounts R owns at Lanterncrest Software had the most subscribed seats?" (or fewest, price, discount) |
| | absent-entity | 4 / 4 / 3 / 8 | A term of a legal-entity name no page carries (a real entity's stem, another suffix); near-miss pages recorded |
| | former-role (held out) | 0 / 0 / 6 / 16 | "Who founded the company that C's former T works with now?" |
| | parent-ceo (held out) | 0 / 0 / 6 / 16 | "Who was the chief executive, on D, of the company that acquired C?" |
| | rep-total (held out) | 0 / 0 / 6 / 16 | The total subscribed seats on a date across every account a rep owns |
| `briefing` | contact-terms | 6 / 6 / 5 / 12 | Two meetings with contacts, each asking a term in force today at the account they work for, and up to one more |
| | legal-terms | 6 / 6 / 5 / 12 | Two account meetings whose records in force name the legal entity, and up to one more |
| | rep-review | 6 / 6 / 4 / 12 | An account review with a rep: which account they own has the most or fewest seats, the highest or lowest price, the largest or smallest discount today; one or two more |
| | unknown-contact | 6 / 6 / 4 / 12 | A contact no page carries ("No brain page for <name>"), and one or two more |
| | former-role (held out) | 0 / 0 / 6 / 16 | An intro call with "the former T of C": who founded the company they work with today |
| | rep-renewal (held out) | 0 / 0 / 6 / 16 | A renewals check-in with a rep: which account they own renews first after today |
| | join-review (held out) | 0 / 0 / 6 / 16 | An account health review: the one account meeting two conditions today |
| `fact-check` | legal-superseded | 6 / 6 / 5 / 12 | A term as of a date when the record in force names the legal entity, stated with the superseded value or right; or, when that record sets a second term, both terms with the second right (a status per part) |
| | contact-claim | 6 / 6 / 5 / 12 | Two terms of "the account where P works as T" that one record sets, one wrong and one right; or, when the record sets one such term, that term right or wrong |
| | join-claim | 6 / 6 / 4 / 12 | "As of D, X was the only account on A and B", naming the one account or a near miss |
| | absent-entity | 6 / 6 / 4 / 12 | A claim about a legal-entity name no page carries; near-miss pages recorded |
| | rep-extreme-claim (held out) | 0 / 0 / 6 / 16 | "On D, of the accounts R owns, X had the most subscribed seats" (or fewest, price, discount), right or wrong |
| | rep-total-claim (held out) | 0 / 0 / 6 / 16 | The total seats on a date across a rep's accounts, right or a careless reading's total |
| | former-role-claim (held out) | 0 / 0 / 6 / 16 | "X founded the company that C's former T works with now", right or naming another founder |

A briefing's other meetings are of the trained kinds (a contact's term, a legal-entity term, a rep's comparison), so a
calendar has two or three asked meetings. Its subjects' calendars fall in one window of 60 days, and no fact or page
serves two bundles.

Every fact-check family except absent-entity makes claims right or wrong. Each fills each split by gold status in the
proportion of its confirmed candidates, and false claims with a true part fill apart from those false throughout, so
true claims sit in every split and a report that calls everything false fails every task with a true part. Fact-check
tasks by gold status (supported / contradicted / not-supported) are 7 / 11 / 6 in train, 7 / 11 / 6 in selection, 11 /
21 / 4 in gate and 31 / 53 / 12 in test; 12, 12, 16 and 42 of them have a true part. The oracle report with every
status set to FALSE passes substance on 12 of 24 train, 12 of 24 selection, 20 of 36 gate and 54 of 96 test tasks, and
with every status set to VERIFIED on 7, 7, 11 and 31. `gen.ts check` and the v3 test fail when train or selection
gives either report a larger share than gate (`statusSkewV3` in
[`common-v3.ts`](../../generators/skillopt-method/common-v3.ts)).

Every task has its own anchor. Tasks that share an anchor, a gold fact or a gold page form one connected group; a
group sits in one split with at most three tasks, and each task records its `group_id` for resampling. Abstention
tasks record their `near_miss` pages (the look-alikes and closest wrong entities) for the gate's reachability control.

## Gold and controls

The generators read the world model (people, companies, contract chains, mentions) for gold. Independent oracles in
[`common-v3.ts`](../../generators/skillopt-method/common-v3.ts) and [`rev1-v3.ts`](../../generators/skillopt-method/rev1-v3.ts)
re-derive every gold value from the rendered page text alone (contract dates and terms, the legal entity an account
page names and the customer each record's title names, an account's owner and contacts lists, a company's founding
line and leadership list, a person's career list), and a candidate whose two paths disagree is dropped. Each kept task
then passes three keyless controls: the findability control below, its solvability control (an answer in the
contract's shape built from the deciding pages) passes every check, and every degenerate answer (empty, "I don't know",
every candidate value at once, a refusal where an answer exists, a fact-check report that calls a false claim true, and
one that calls every claim or part false when a part is true) fails substance.

| Skill | Candidates | Dropped by the oracle | By the findability control | By the solvability control | By a degenerate answer | Groups (largest) |
|---|---|---|---|---|---|---|
| `query` | 2,004 | 1 | 96 | 0 | 0 | 114 (3) |
| `briefing` | 297 | 1 | 12 | 0 | 0 | 72 (3) |
| `fact-check` | 2,034 | 1 | 390 | 0 | 0 | 121 (3) |

### Findability control

[`findability-v3.ts`](../../generators/skillopt-method/findability-v3.ts) runs gbrain's own search on each candidate's
question (a query, a briefing's ask line per meeting, a fact-check's claim) the way a rollout runs it: the rollout's
`brain_search` tool at the pinned gbrain, embeddings off, the clock set to 2026-10-30 12:00 UTC, the first 20 results.
The distinct pages it returns are cached in `findability-v3-rev1.jsonl` beside the generators, keyed by the world's
sha256, so generation stays byte for byte without a database. A candidate is dropped when:

- an indirect or join probe finds every deciding page in the first 5 hits;
- a supersession probe ranks the newest deciding record first;
- an aggregation needs fewer than 10 pages (each of the rep's account pages and every record they list as signed by the
  date).

Abstention probes have no deciding page, so they are searched and their near-miss ranks reported, never filtered. Each
`generation-report.json` holds every placed task's ranks under `findability`. The median deciding-page rank per family
counts a page outside the first 20 results as 21:

| Skill | Family | Patterns | Median deciding rank | Deciding pages in the first 5 | Not in the first 20 | Other |
|---|---|---|---|---|---|---|
| `query` | legal-as-of | supersession | 21 | 0% | 79% | newest record: median 21 |
| | contact-as-of | indirect (+ supersession) | 9 | 48% (the contact's own page) | 42% | |
| | join-two | join | 21 | 4% | 78% | |
| | rep-extreme | aggregation | 21 | 0% | 96% | pages needed: at least 10, median 21 |
| | absent-entity | abstention | – | – | – | near-miss median 21 |
| | former-role | indirect | 21 | 6% | 65% | |
| | parent-ceo | indirect | 3.5 | 50% (the acquired company's page) | 2% | |
| | rep-total | aggregation | 21 | 0% | 95% | pages needed: at least 10, median 17 |
| `briefing` | contact-terms | indirect, supersession, aggregation | 21 | 39% | 55% | |
| | legal-terms | supersession, indirect | 21 | 7% | 93% | |
| | rep-review | aggregation, indirect, supersession | 21 | 8% | 90% | pages needed: at least 12, median 31 |
| | unknown-contact | abstention, indirect, supersession, aggregation | 21 | 10% | 78% | near-miss median 7 |
| | former-role | indirect, supersession, aggregation | 21 | 14% | 62% | |
| | rep-renewal | aggregation, indirect | 21 | 22% | 71% | |
| | join-review | join, indirect, supersession, aggregation | 21 | 12% | 69% | |
| `fact-check` | legal-superseded | supersession | 9 | 14% | 28% | newest record: median 9 |
| | contact-claim | indirect (+ supersession) | 5.5 | 50% (the contact's own page) | 29% | |
| | join-claim | join | 15 | 26% | 43% | |
| | absent-entity | abstention | – | – | – | near-miss median 21 |
| | rep-extreme-claim | aggregation | 21 | 17% | 57% | pages needed: at least 12, median 24 |
| | rep-total-claim | aggregation | 21 | 2% | 91% | pages needed: at least 12, median 19.5 |
| | former-role-claim | indirect | 12 | 24% | 30% | |

The fact-check families that make claims right or wrong place true claims in the proportion of their confirmed
candidates (#308's assembly). A true claim names the deciding account or founder, so its search finds the deciding
pages in the first 5 hits more often than a false claim's does. Over the placed tasks, 4 of 9 deciding pages land there
for true rep-extreme claims against none of 14 for false ones; former-role-claim has 12 of 30 against 4 of 36, and
join-claim 15 of 30 against none of 28.

`<skill>/generation-report.json` holds the capacity report: per family, the confirmed candidates and the tasks placed in
each split against the quota. Generation fails when any count is short; every family and split is met.

## Contract and scorer

Every arm's prompt is the task followed by `<skill>/contract.md` ([`contract.ts`](../../runner/skillopt-method/contract.ts)),
except the bare no-skill arm. Each contract adopts the seed's own documented output (the query seed's direct answer and
`[Source: ...]` citations, the briefing seed's MEETINGS TODAY list, the fact-check seed's `[N] CLAIM:` blocks) and adds
only what binds facts.

Each task's judge is a gbrain rule judge of m-flag regexes ([`score-v3.ts`](../../runner/skillopt-method/score-v3.ts)),
each tagged `substance` (the value concluded, the deciding page, the abstention, each part's status) or `form` (the
contract's markup). A task scores a full pass (every check) and a substance pass (substance checks only); gbrain's own
rule score is the fraction of the same checks. Substance loci do not depend on layout, so correct content in a table,
bold lines or prose passes substance and fails form. A query answer passes only when the first sentence naming a
candidate value states the gold value without negating or refusing it ("not 240" and "can't confirm 240" fail). In a
fact-check report with `CLAIM:` blocks, a block's status is what its `STATUS:` lines say (or, with none, the first word
after its `CLAIM:` label), and the parts it covers are the ones its `CLAIM:` line names, so status words and part words
in notes do not count. A block may not give a covered part any status outside the ones that part allows, `DISPUTED`
included.

## Files

| Path | What it holds |
|---|---|
| `world/pages.jsonl` | The rollout brain: one `{ "slug", "content" }` per line, in slug order |
| `<skill>/train.jsonl`, `sel.jsonl`, `gate.jsonl`, `test.jsonl` | One task per line: `task_id`, `task`, `judge`, `family`, `held_out`, `group_id`, `anchor`, `fact_keys`, `gold` (with its `spec`), `distractors`, `near_miss` where it applies, `source`, `oracle` and `oracle_answer` |
| `<skill>/contract.md` | The output contract appended to every arm's prompt but the bare no-skill arm's |
| `<skill>/criteria.md` | The criteria text |
| `<skill>/generation-report.json` | Knobs, candidates, drops and their reasons, the capacity report, group counts, the assembly attempt and every placed task's search ranks (`findability`) |
| `seeds/<skill>/SKILL.md` | The seed skill, verbatim from gbrain `311a83bbe`, pinned by sha256 in `dataset.ts` |

## Regenerating

```sh
bun eval/generators/skillopt-method/gen.ts check      # every version: regeneration reproduces every file, and each manifest matches
bun eval/generators/skillopt-method/gen.ts write v3   # rewrite v3's files and MANIFEST.json
bun eval/generators/skillopt-method/findability-v3.ts write   # search the probes the cache lacks (--fresh: every probe)
bun eval/generators/skillopt-method/findability-v3.ts check   # re-search every cached query; exits 1 on any difference
```

The world and the three generators are seeded (world 30001, its legal entities 31010, generators 30011 to 30013) and
call no model. The knobs are explicit (`V3Knobs` in `world-v3.ts`); `revision: 1` selects these families and the
legal-entity world, and `revision` absent or 0 regenerates the calibrated set (MANIFEST.json sha256 `a6ddcbef…`). Calibration (plan section 4) froze them at contract chain
depth 4 to 5 records, 20 look-alike company pairs, 24 look-alike person pairs and 6 distractors per account. The
preregistered first set (3 to 5, 15, 20 and 2) scored the same on Opus; its amendment in
[PREREGISTRATION.md](../../../docs/benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md#amendments) has both rounds.

## Known limits

- No model has read revision 1. Calibration (train only, revision 0) is the only paid read so far. It ran before #308's
  scorer and fact-check fixes, at MANIFEST.json `04f8f287…` and `3f416c5e…`: the seed scored 1.0 on query and briefing
  and 0.75 to 0.875 on fact-check, above the 0.30 to 0.60 band it aimed for.
- The findability control measures one search on the question's own text at a pinned clock. A rollout searches with its
  own queries, at the real clock (gbrain's recency stage reads it), and can open pages by slug, so the ranks bound how
  much one search hands over, not how hard a task is.
- Briefing calendars hold two or three asked meetings (revision 0 held three to six), because no fact or page may serve
  two bundles and the hard kinds' pools (56 single-title contacts, 76 legal-entity records) are finite.
- The task files carry their judges' regexes inline, so v3 is about 10.2 MB (10,211,909 bytes over MANIFEST.json's
  files), mostly the briefing and fact-check judges.
- Pages are 178 to 318 words, short of the plan's 700-word ceiling: the generator pads each page to a seeded length
  from its bank's filler sentences.
- Briefing citation dates are not checked against the page.

## Changelog

### 2026-11-02: Revision 1 takes the calibration branch's fixes, and its trained fact-check families make true claims (GST-1150)

The calibration branch is merged in: #308's scorer fixes and status-proportional placement, and revision 0's true-claim
variants (revision 0's GST-1150 entry below). The data was regenerated, not merged by hand. After the merge, revision
1's trained fact-check families had revision 0's skew: train and selection held 5 tasks with a true part each, against
11 in gate and 29 in test, and the oracle report with every status set to FALSE passed substance on 19 of 24 train, 19
of 24 selection, 25 of 36 gate and 67 of 96 test tasks. Three trained families changed:

- legal-superseded: when the record in force sets a second claim-part term, the claim states both, the first with the
  value the records naming the account hold and the second right, and the report gives a status per part. A one-term
  claim is right half the time (was 35%).
- contact-claim: when the record in force sets another claim-part term, the claim states two terms that record sets, one
  wrong and one right, with a status per part. A one-term claim is right 60% of the time (was 40%).
- join-claim names the one account 85% of the time (was 40%), because the findability control keeps about one in five of
  those claims (55 of 287: the account's name in the claim brings up its page) and every claim naming a near miss.

Fact-check tasks by gold status (supported / contradicted / not-supported) are now 7 / 11 / 6 in train, 7 / 11 / 6 in
selection, 11 / 21 / 4 in gate and 31 / 53 / 12 in test; 12, 12, 16 and 42 of them have a true part. The every-FALSE
oracle report passes on 12, 12, 20 and 54 of them, and the every-VERIFIED one on 7, 7, 11 and 31, so the status-skew
guard (`statusSkewV3`) holds. The held-out families now place true claims in their candidates' proportion too. Gate and
test held 4 true rep-extreme claims of 22 and 2 true former-role claims of 22 before #308's placement, and hold 8 and 10
now, which moves their findability ranks (see the note under the findability table).

Fact-check candidates went from 2,029 to 2,034, oracle drops from 0 to 1, findability drops from 220 to 390 and groups
from 123 to 121. The findability cache holds 4,201 queries (was 4,197): 1,872 are new searches and 1,868 were dropped.
Query judges changed with #308's scorer; briefing tasks are byte-identical. `revision` 0 regenerates the calibration
branch's files byte for byte. MANIFEST.json's sha256 went from `e6ce023c` to `fa6d7dac` and `data_sha256` from
`42f111e8` to `ddcf59cf`; the dataset grew from 8,789,667 to 10,211,909 bytes.

### 2026-11-02: Revision 1 replaces every family

The plan's one revision changes task structure, not knobs. Every family is new: indirect references, joins,
aggregation over 10 or more pages and buried supersession, with an abstention family trained per skill, at the same
24/24/36/96 split sizes. The world keeps its 1,030 pages and every person; 42 of its 60 accounts now move their later
contracts to a legal entity, which renames 76 records and changes 121 pages. A findability control drops candidates
whose deciding pages gbrain's own search hands over. MANIFEST.json sha256 is now `e6ce023c…` (was `3f416c5e…`), and
`revision` 0 still regenerates the calibrated set.

### 2026-11-02: Revision 0's trained fact-check families make true claims (GST-1150)

Among the trained fact-check families only compound made true claims, so train and selection held 4 and 6 tasks with a
true part against 13 in gate and 31 in test. The oracle report with every status set to FALSE passed substance on 20 of
24 train, 18 of 24 selection, 23 of 36 gate and 65 of 96 test tasks, so a rewrite that rejected too much lost little
where it was trained and selected. Two trained families now make true claims too:

- superseded states, for about half its claims, the value in force on the claim's date while a later record holds
  another value (supported);
- not-founder makes, per company, the real founder's claim (supported) and one claim naming a person who works or
  worked there, the chief executive when one is not the founder (contradicted). It made one per such person before.

Compound's false claims with a true part now fill apart from those false throughout, so its mix holds in every split.
Train and selection now hold 11 tasks with a true part each, against 15 in gate and 38 in test, and the every-FALSE
report passes on 13, 13, 21 and 58 of them. A new guard (`statusSkewV3`, run by `gen.ts check` and the v3 test) fails
when train or selection gives the every-FALSE or every-VERIFIED oracle report a larger share of passes than gate. The
controls table now gives each skill's counts at the frozen knobs, which it had kept from the registered ones.

Quotas, seeds, knobs, the family hold-out and the world are unchanged; query and briefing are byte-identical. Fact-check
candidates went from 1,798 to 1,755 and groups from 124 to 136. MANIFEST.json's sha256 went from `a677090b` to
`a6ddcbef` and `data_sha256` from `582347c5` to `225d18a1`; the dataset grew from 10,976,191 to 10,985,950 bytes.

### 2026-11-02: Calibration froze harder knobs

Calibration round 2 raised every knob: chain depth 4 to 5 (was 3 to 5), 20 look-alike company pairs (was 15), 24
look-alike person pairs (was 20) and 6 distractors per account (was 2). Opus scored the same at both settings, and the
harder set is frozen for the gate. The world grew from 999 to 1,030 pages and every split was regenerated, with the
fact-check and scorer fixes below; the task counts per family did not change. MANIFEST.json sha256 is now
`a677090b…` (it was `eebc02ff…` at the registered knobs after those fixes).

### 2026-11-02: Query refusals with "can't", "won't" and common refusal verbs fail

Pass-2 review of #308 found the query negation guard still let refusals of the gold value pass. It built "can't" as
"cann't" and had no "won't", so "I can't confirm 240 seats" passed substance with a straight or curly apostrophe, and
"could not find 240", "doesn't show 240", "no record of 240" and "not able to confirm 240" passed too. All of them now
fail. The status paragraph now says a report calling everything false fails each task with a true part, where it said
such a report fails the true claims; Known limits gives how few of those tasks train and selection hold and what an
all-FALSE report scores on each split.

The query judges changed with the scorer; query tasks and their placement did not, and briefing and fact-check are
byte-identical. MANIFEST.json's sha256 went from `e944b2d8` to `eebc02ff` and `data_sha256` from `eba61eb6` to
`10a0a282`; the dataset grew from 10,733,381 to 10,763,777 bytes.

### 2026-11-02: Fact-check places true claims; the fact-check and query scorers read status and negation as meant

Round-1 review of #308 found four scorer and dataset defects, fixed together with a regenerated v3:

- Fact-check assembly sorted true claims behind false ones, so no placed task was supported (train 0 / 18 / 6, selection
  0 / 18 / 6, gate 0 / 32 / 4, test 0 / 84 / 12 by supported / contradicted / not-supported) and a report calling
  everything false passed every absent task. Each family that makes claims right or wrong now fills its quotas by
  status in its candidates' proportion: 2 / 16 / 6, 2 / 16 / 6, 10 / 22 / 4 and 27 / 57 / 12. Quotas, seeds and knobs
  are unchanged; fact-check groups went from 130 to 131. A new degenerate answer (every claim or part FALSE) must fail
  substance on every task with a true part; it dropped no candidate.
- The fact-check scorer read a status word anywhere in a block and counted a part covered when its key word appeared
  anywhere in it, so a correct report failed for "was correct before the amendment", "Amendment status: confirmed",
  per-part lines under a whole-claim block or "USD 1,175/seat/year" in a price block. Status now comes from the
  `STATUS:` lines and coverage from the `CLAIM:` line; "/seat", "per-seat" and "before discount" no longer name a part.
- A second block giving `DISPUTED` for a contradicted or unsupported claim passed; it now fails.
- A query answer that negated or refused the gold value ("Not 240 seats", "I cannot confirm 240 seats") passed; it now
  fails, while "240 seats, not the 200 the MSA set" still passes.

The query judges changed with the scorer; query tasks and their placement did not, and briefing is byte-identical.
MANIFEST.json's sha256 went from `04f8f287` to `e944b2d8` and `data_sha256` from `7167655f` to `eba61eb6`; the
dataset grew from 10,056,321 to 10,733,381 bytes (the "about 9.7 MB" line now reads about 10.7 MB).

### 2026-11-02: The pin sentence names gbrain `311a83bbe`

The main merge of #306 ([`5df3b68a`](https://github.com/garrytan/gbrain-evals/commit/5df3b68a)) moved `package.json`'s
gbrain pin from `a131fb20` (v0.60.549.0) to `311a83bbe` (v0.60.553.0), so the sentence on the pin now names
`311a83bbe`, the same commit the seeds come from. No data file or MANIFEST.json changed.

### 2026-11-02: Dataset created

First version, for the SkillOpt ceiling attempt (GBEV-30): world-v3's 999 pages, 540 tasks over three skills in four
splits, a contract per skill and layered checks, generated at gbrain `a131fb20` with seeds from gbrain `311a83bbe`.

# Preregistration: how often do duplicate finders join different people and companies? gbrain against classic matchers and memory systems (entity-dedupe head-to-head)

Written 2026-11-18. This file freezes in its own commit, pushed before the first counted run. After that, every change is a dated amendment at the end, never an edit. The runs made before this commit are development runs: they are published as context and decide nothing.

## Question

gbrain's duplicate finder (`gbrain dedupe --preview --json`) groups pages that describe the same person or company. On 2026-11-17 Garry Tan chose its automatic rule, arm 7 of the [person-dedupe bench](2026-11-17-person-dedupe.md): a group links automatically only when its pages share an exclusive id (a LinkedIn path, a GitHub login or a declared id) that no other page carries, with the same type, the same strict name and one page per source. A different exclusive id blocks the link, and unions are checked. Email, phone, X handle and company domain never link on their own; they go to a confirm list that is read entry by entry, with a hint line and no bulk confirm. gbrain#9680 builds it. This file calls it **the chosen rule**.

This experiment answers four decisions: **does gbrain keep automatic linking on under the chosen rule, what does its confirm list show, does gbrain adopt a better matching method, and what can we truthfully say about gbrain against the best entity-resolution tools and the memory systems that merge entities themselves?** All four rest on one number, the false-merge rate: how often a system joins two people, or two companies, that are really different.

Out of scope: real people's data and field rates (these are stress rates on planted hard cases), hosted services that need accounts, and any check on real pages.

## Public lesson

- If gbrain's automatic tier joins no different people or companies and a learned matcher doesn't beat it: "We learned that linking automatically only on an exclusive id that no other page carries, with a strict name match, joined no different people on our hardest cases, while the memory systems we tested joined many. You should never let an email, phone or domain link records on its own."
- If gbrain's automatic tier joins any: "We learned that even an exclusive-id rule joins different people when <case>. You should send that key class to review instead of linking it."
- If a keyless learned matcher matches gbrain's false merges at much higher recall: "We learned that a learned matcher trained on a small labelled sample finds several times more true duplicates than an exclusive-id rule with no more false merges. You should use one to fill the review queue."
- For the memory systems, whatever the result: "We measured how often each one merges different people, a number none of them publishes. You should check a memory system's merge error rate before trusting its entity pages."

## Evidence class

Confirmation on a synthetic, public world built from hard cases, with a counted seed that no system sees before its run. The families were designed with the chosen rule in view, so the families added before the freeze (Build and data) are written by an author who did not design the rule. These are stress rates, not field rates.

## Build and data

- **gbrain build.** The newest gbrain release on master at launch that contains gbrain#9680, never an unreleased pull-request head. If no such release exists at launch, the counted gbrain run waits for one. A dated amendment names the release and commit before the first counted gbrain run; the build then freezes for this experiment.
- **Harness.** The gbrain-evals commit that carries that amendment. The bench code (the company families, the classic-tool drivers, the memory-system readouts and the matcher) is merged before the freeze, and the amendment names its commit.
- **World.** The [person-dedupe generator](../../eval/generators/person-dedupe-gen.ts) (30 person families) plus 12 company families (506 pages at 20 instances): same name in a different place or industry (the company headline family, including franchise owners on the brand's domain), parent and subsidiary, rebrand or rename, abbreviation and legal suffix, one domain across a holding group (including a US and a UK company sharing name and group domain), one company with several domains, and acquired companies. Company pages carry `domain` and `website`, the fields gbrain's finder reads. Every page is synthetic: invented names, reserved `.example` domains, no real person. Given names come from the Apache-2.0 [nickname table](https://github.com/carltonnorthern/nicknames). A seeded ledger records the true entity behind every page, and an independent oracle re-derives the gold from the rendered pages and throws if the two disagree.
- **Shared-exclusive-id families (required before the freeze).** Today only one family (`diff-bridge-page`) plants different people who share an exclusive id, so a zero false-merge count for an exclusive-id rule is close to guaranteed by construction. Before the freeze the generator adds families where different people really do share an exclusive id, written by an author who did not design the chosen rule: a recycled GitHub login (one login, two people at different times); a LinkedIn path pasted onto the wrong person's page in a second source, with no union break and one page per source; a declared-id typo that collides with another person's id; a company page carrying its founder's LinkedIn; and a shared organisation or bot GitHub account used by several people. Each runs at 20 instances, adding about 200 pages and about 100 must-not-link pairs. The amendment restates the counted world's page and pair counts. No counted gbrain run starts until these families exist.
- **Exclusive ids depend on the seed.** Before the freeze, the generator salts every LinkedIn path and GitHub login with the seed and the generator version, and a keyless test checks that two seeds give disjoint exclusive ids. (Today they hash only family, instance and role, so every seed would reuse the development values.)
- **Size.** 20 instances per family. At the development seed, before the new families, that is 1,886 pages: 400 person and 172 company must-not-link pairs, and 280 person and 120 company must-link pairs.
- **Seeds.** One public development seed (20261117). One held-out tuning seed (20261118): tools may tune and label on it, and nothing scored comes from it. One counted seed, drawn at random and held outside the repository, where no run agent can read it, until the counted runs start. Before the first counted run, a dated amendment publishes its commitment: the SHA-256 of the seed joined to a random 32-byte nonce. The results reveal the seed and nonce, and the reveal step recomputes the hash and refuses on a mismatch. No system is tuned on, labels, or sees the counted seed before its run.
- **Engines.** gbrain runs keyless on PGLite (`init --pglite --no-embedding`) under `unshare -rn` (no network, keys unset), from a fresh world folder and a fresh home each run.

## Arms

Every system reads the same rendered pages through its own normal path. Each version is the newest at launch, named in the amendment.

| System | Kind | How it ingests | What we read out | Tiers |
|---|---|---|---|---|
| gbrain duplicate finder | system under test | `gbrain import` per source | `gbrain dedupe --preview --json` | automatic (cross-source clean), confirm list (contact keys only), proposed (all but conflict) |
| [Splink](https://github.com/moj-analytical-services/splink) (5.0.0 in development) | classic: Fellegi-Sunter, EM, term-frequency weights | records table | match weights, clustered by connected components | automatic at the match threshold; review band |
| [dedupe](https://github.com/dedupeio/dedupe) (3.0.3 in development) | classic: active learning | records table | clustered partition | automatic at its threshold |
| [Zingg Community](https://github.com/zinggAI/zingg) (0.7.0 in development) | classic: learned matcher on local Spark | records table | z_cluster | automatic |
| `ext-temporal-graph` | memory system, temporal graph | one episode per page through the repository's shim | the entity node each page's subject became | automatic (merged nodes) |
| `ext-extract-first` | memory system, extraction | one add per page through the shim | the entity each page's subject became, from its entity store | automatic |
| `ext-graph-pipeline` | memory system, knowledge graph | add plus cognify, then its entity-deduplication step | merged_into edges and provenance | automatic |
| `ext-memory-bank` | memory system with entity resolution | the shim's ingest | resolved entities | automatic |
| Language-model matcher | baseline | candidate pairs from the fixed blocker below | yes, no or unsure per pair, closed transitively | automatic = yes; proposed = yes or unsure |

Memory systems are named by kind; [comparison-systems.md](../comparison-systems.md#systems-in-the-head-to-head-scoreboard) maps each kind to its project and pinned build.

- **Not scored, and why.** `ext-agent-runtime`: entity dedupe isn't a feature; it can only ask its agent to reorganise memory. `ext-markdown-kb` and `ext-verbatim-session`: no entity resolution (one note per session; person names only as a 0.20 search-ranking boost). The hosted service built on `ext-temporal-graph`'s engine: needs an account, and its open engine stands in. Senzing: its EULA, section 2, forbids publishing performance information or comparisons without written consent. Neo4j's agent-memory library (0.8.0): the repository has no bundle for it yet; as the one memory system with a documented review band (auto-merge at 0.90, review at 0.85), it is the first candidate for a dated amendment. A system with no dedupe is reported as "no dedupe", never scored as zero.
- **Memory-system configuration.** Each runs its documented default, with its language model set to the newest model of its default provider family, gpt-6.2-sol (served by the OpenAI API on 2026-11-17; newer than the gpt-6.1-sol the repository's model rules name), and its default embedder. `ext-temporal-graph` at 0.30.2 sends gpt-6.2-sol a temperature and no reasoning effort, because it treats only older names as reasoning models; the pinned version's behaviour is recorded. None exposed a review tier in its default configuration in the smoke, so they are scored on automatic merges only. Each also gets one tuned configuration where its docs offer a knob (a match threshold or identity properties), tuned only on the held-out seed (Budget).
- **Memory-system runs.** Pages are ingested in one fixed order drawn from the seed, the same for every system. Each configuration runs once, and the single run is stated as a limit. A page whose subject the readout can't map to an entity is counted as unresolved in its own column, never as a silent singleton, and a random sample of 50 page-to-entity mappings per system is checked by hand against the page and published.
- **Classic tools.** The records table comes from one frozen parser over the rendered pages only, with a keyless test that it imports nothing from the generator or the ledger. dedupe and Zingg take labels from the held-out seed, fed programmatically (dedupe's mark_pairs, Zingg's marked-records file) with standard input closed, so no run waits on a prompt. They run twice: on a realistic budget of 100 labelled pairs, and on full labels, reported as their ceiling. dedupe's active learning is random, so it runs at labeller seeds 1 to 5 and reports the spread; Zingg has no seed setting and runs once per configuration, stated as a limit. Splink fits m and u by EM on the scored data, its normal unsupervised path. None of the three documents a review band, so the bench defines one for Splink only; its match threshold and review band are fixed on the held-out seed before the counted run.
- **Language-model matcher.** claude-opus-5-5, gpt-6.2-sol and particle-1, at default reasoning. The prompt is frozen by dated amendment before any counted run. Safety-filter stops are reported as their own outcome. The blocker is fixed here: surname, full folded name, any shared key (email, LinkedIn, GitHub, domain) and the company name core with legal suffixes dropped. At the development seed it gives 21,574 pairs and reaches all but 32 of the 972 designed pairs: 20 acquired-company pairs (must not link) and 12 real duplicates (6 abbreviations with no shared domain, 6 rebrands). Those 32 are reported as "not a candidate". The 12 count against the matcher's recall and are never dropped from it; the 20 stay in its false-merge denominator and are scored from the closed groups like every other pair. The blocker's frozen code states whether it drops a key shared by more than 50 pages, as the smoke did, and the counted seed's pair count is logged before any paid call.
- **Claims beside measurements.** For each system we record what its own documentation says about deduplication (default thresholds, claimed behaviour) next to what we measured.
- **Licences.** Splink and dedupe are MIT. Zingg Community is AGPL-3.0; we run it as a separate process and distribute none of it. `ext-temporal-graph`, `ext-extract-first` and `ext-graph-pipeline` are Apache-2.0 and `ext-memory-bank` is MIT, each run from its open-source package. The nickname table is Apache-2.0. The results record each system's licence and version.

## Metric and denominator

- **Primary: the false-merge rate.** The share of designed must-not-link pairs whose two pages end up in one group after closure, with exact counts and a Wilson 95% interval, per system, configuration and tier, separately for people and companies, and per family.
- **Every designed pair is scored from the final closed groups,** including pairs a system never compared directly: if A joins X and X joins B, A and B are merged. For pairwise systems (the matcher, Splink) errors before closure are reported too.
- **Beside it:** must-link recall; pairwise precision, recall and F1; B-cubed precision, recall and F1; false merges anywhere, attributed to the group that made them; review load (proposed groups per 1,000 pages, and the share that are real); confirm-list composition (real, must-not-link, vetoed); how many pairs reached each system's candidates; and, in the first table with claude-opus-5-5 and particle-1 shown first, the matcher's cost per correct decision per model.
- **Analysis unit and clusters.** Pairs within one family instance aren't independent, so every interval is also given by a cluster bootstrap over family instances, and per-family counts are shown.
- **Errors.** An unresolved page is its own column. A cell that fails twice for infrastructure reasons is reported as "failed (infrastructure)" (Budget). A matcher pair with no verdict is reported, never guessed.
- **No model judge.** Gold comes from the ledger and the oracle; scoring is deterministic and keyless.

## Decision rule

Comparisons are paired on the same pages: an exact McNemar test on the must-not-link pairs for false merges and on the must-link pairs for recall, each with a 95% interval on the difference. "Equal or lower false-merge rate" means the one-sided 95% bound on the paired difference is at or below 1 point; "recall within 10 points" means the one-sided 95% bound on the recall shortfall is at or below 10 points.

Smallest detectable difference, stated in advance: with about 400 person must-not-link pairs, about 2 points in false-merge rate (0% against 2%) at 80% power (81% computed); with 172 company pairs, about 5 points (86% power; 4 points has only 69%). A smaller difference is reported as not detected at this sample size, never as equal.

gbrain's automatic tier is reported against every system, but its recall sits at a different operating point from the memory systems' merges, so the comparison with memory systems uses gbrain's proposed tier, with a precision-recall plot of every system's operating points.

## What each outcome changes

| Result | Then |
|---|---|
| gbrain's automatic tier joins **0** designed must-not-link pairs, on people and on companies, including the shared-exclusive-id families, with each 95% upper bound at or below 1% (people) and 3% (companies) | Automatic linking ships on with the chosen rule. Until the shared-exclusive-id families exist in the world, a zero here is only a check that the build behaves as designed, not evidence that automatic linking is safe, and it is reported that way |
| It joins **any** must-not-link pair | That case class is named. Automatic linking for the key class involved turns report-only (counted and shown, not linked) until a guard removes it and the bench reruns. This goes to Garry Tan for a decision, because it changes the rule he chose |
| On the contact-key confirm list, entries that carry a contradicting exclusive id (`key_differs`, `veto: true`) are all must-not-link, as in development (35 of 35) | The finder drops vetoed pairs from the confirm list, or the hint line leads with the contradiction; gbrain's maintainers pick which |
| More than a quarter of confirm-list entries are must-not-link after that change | The hint line also shows what differs (employer, city, dates), and the list is ordered riskiest last. Bulk confirm stays off |
| A keyless learned matcher (Zingg or dedupe, at its 100-label budget) joins no more must-not-link pairs than gbrain's automatic tier (one-sided 95% bound on the difference at or below 1 point) at two or more times its recall | gbrain ports that method natively as a source of review-tier candidates: never a dependency, and never automatic links without a new decision. It is planned and approved before it is built |
| A classic tool beats gbrain's proposed tier on recall (interval excluding 0) at an equal or lower false-merge rate | gbrain ports that method natively; it never becomes a dependency |
| The best language-model matcher beats gbrain's proposed tier on review-queue precision by 5 points or more (paired, interval excluding 0) | An opt-in model adjudicator for the review list is planned and goes to Garry Tan. Otherwise it isn't built |
| gbrain's proposed tier has a lower false-merge rate than a memory system's merges (interval excluding 0), at recall no more than 10 points lower (one-sided 95% bound) | The head-to-head is published and README says so, with the rates. If any memory system matches it on both, README says that instead |
| A memory system's merges join must-not-link pairs | Published as a measured false-merge rate with its version and configuration, next to its own documentation's claims |

Namesake-risk ranking, a date-contradiction veto and variant-name candidates for gbrain's review tier are measured on the keyless development bench and are not decided here: no gbrain release carries them, and an undefined arm can't be counted.

## Development evidence (not counted)

gbrain under the chosen rule (gbrain 1e6e7ed3 and ad179784, people world at seed 20261117): automatic tier 0 of 400 must-not-link pairs (95% interval 0.0% to 1.0%), recall 49 of 280 (17.5%). Confirm list: 178 entries, 78 real duplicates and 100 must-not-link pairs, 35 of them vetoed. Companies, on a stand-in for the same rule rather than the real finder: 0 of 172 linked, recall 23 of 120; one development run of the real finder on companies happens before the freeze.

Classic tools, keyless, people only, seed 20261117, labels and thresholds from held-out seed 20261118 only (bench commit c48c4e8e):

| Arm | False merges | Recall |
|---|---|---|
| Splink 5.0.0, default (Getting Started persons model) | 216/400 (54.0%) | 158/280 |
| Splink tuned, automatic | 41/400 (10.25%) | 199/280 |
| Splink tuned, review band (chosen on held-out) | 161/400 | 207/280 |
| dedupe 3.0.3, default | 0/400 | 50/280 |
| dedupe tuned | 24/400 (6.0%) | 269/280 |
| Zingg 0.7.0, default | 5/400 (1.25%) | 205/280 |
| Zingg tuned | 0/400 | 201/280 (71.8%) |
| gbrain (ad179784), chosen rule, automatic | 0/400 | 49/280 (17.5%) |

Across labeller seeds 1 to 5, dedupe's false-merge rate ranged 0% to 4.8% (default) and 6% to 10% (tuned).

A 69-page smoke on 2026-11-17 (Pacific), a plumbing check only, with 20 designed different-people pairs per cell: each memory system merged 15 to 17 of 20, and the matcher's "yes" verdicts merged 4 (claude-opus-5-5), 9 (gpt-6.2-sol) and 9 (particle-1).

## Prior art

"Merge Without Measure" (Edward Izgorodin and Olga Timoshina, 2026; summarised in Mnemoverse's "Agent Memory Deduplication: The Missing Error Rate", with pre-publication reviews filed upstream with `ext-extract-first` and `ext-agent-runtime`) read the deduplication write paths of six shipping agent-memory systems and found hardcoded similarity thresholds, no published false-merge or false-split rate, and no way to undo a merge. The wider literature: Fellegi-Sunter and Splink's term-frequency weights; transitive closure as the weakest clustering choice (Hassanzadeh et al., PVLDB 2009); and OpenSanctions Pairs (arXiv 2603.11051), where rules over-match and language models struggle with transliteration.

## Budget

- **Order.** Keyless systems first: gbrain, Splink, dedupe, Zingg. Paid cells run one at a time through the repository's metering proxy and budget ledger (`eval/runner/budget-ledger.ts`); every request is reserved against the ledger before it is sent.
- **Prices the design depends on.** Measured in the smoke from the proxy's usage fields at list prices, with gpt-6.2-sol. Ingest cost per page, at the rate from the last third of the smoke (cost per page rises as a graph grows, so these are floors): `ext-temporal-graph` $0.038, `ext-graph-pipeline` $0.009, `ext-extract-first` $0.0045, `ext-memory-bank` $0.0022. Matcher cost per pair: gpt-6.2-sol $0.00055, claude-opus-5-5 $0.0030, particle-1 $0.00021. The blocker was chosen on these: any shared name token gives 49,150 pairs at the development seed against the fixed blocker's 21,574.
- **Runs.** Each memory system runs default on the scored seed, tuned on the scored seed, and tuning on the held-out seed.
- **Tuning is counted as grid size × world cost.** A memory system resolves entities while it ingests, so every setting tried is a full re-ingest. Tuning therefore runs on a slice of the held-out seed with 5 instances per family (a quarter of the held-out world), with at most 4 settings per system, which costs no more than one full held-out world. The chosen setting then runs once on the scored seed.
- **Ledger stops.** Each memory-system run stops at 1.5 times its own projected run cost at the rates above, scaled to the counted world's page count, and the matcher stops at its projected cost. Reaching a stop pauses the run at the cell boundary; it resumes only after the measured rate is reported and a new paid run is opened. It never ends the test incomplete.
- **345-page checkpoint.** Every memory-system ingest re-measures its cost per page after its first 345 pages. If the rate projects the run past its stop, it pauses there before ingesting the rest.
- **Crash and resume.** None of the four memory systems is shown to ingest idempotently: a re-sent page can bill twice and create a duplicate entity. So an ingest that dies mid-world never resumes in place. It restarts from page one on a fresh namespace (a fresh database on a fresh VM). Before any restart, the cell's ledger is reconciled against the metering proxy's usage log, and the partial run's billed spend counts toward that cell's stop; the partial output is kept and never scored. Each cell gets at most one restart, and each restart is opened as its own paid run. A second failure ends the cell as "failed (infrastructure)", reported as such, and a further attempt needs a dated amendment. A matcher run that dies resumes after the same reconcile, re-asking only pairs with no request on the proxy log; a pair whose request was sent but got no verdict is re-asked at most once, counted twice in spend, and reported.
- **Runner refusals.** The runner exits non-zero with a stable code, the counts involved and a fix line when the world folder was used before (`WORLD_DIR_USED`: pass a fresh `--output`), the import is incomplete (`IMPORT_INCOMPLETE`: pages expected and imported), or the ledger is unreconciled (`LEDGER_UNRECONCILED`: run the reconcile first).
- **Machines.** Long ingests (`ext-temporal-graph` ingests serially, about 12.5 seconds a page in the smoke, so hours per world) run detached on Ubicloud VMs, each destroyed after its run.

## What is fixed now, and what may change by dated amendment

- **Fixed now:** the decision rules and margins; the primary metric and closure scoring; the families and instances per family, including the shared-exclusive-id families; the seed procedure and commitment; the tiers each system is scored at; the matcher's three models and its blocker; the ledger stops, the 345-page checkpoint and the crash and resume rules; and the rule that nothing is tuned on the counted seed.
- **By dated amendment, before the first counted run:** the gbrain build; the system versions; the bench commit; the counted world's page and pair counts; the seed commitment; the matcher prompt; and adding a system found to resolve entities (Neo4j's agent-memory library first, once a bundle exists).
- **Reproduction.** The results page names the one command that rebuilds the counted world from the revealed seed and rescores any keyless row.

## Amendments

None yet.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

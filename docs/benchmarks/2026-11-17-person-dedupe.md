# Duplicate people: a shared email and the same name don't prove one person

Date: 2026-11-17. Category `person-dedupe` (registry alias N4D), report-only. Runner [eval/runner/person-dedupe.ts](../../eval/runner/person-dedupe.ts), world generator [eval/generators/person-dedupe-gen.ts](../../eval/generators/person-dedupe-gen.ts), receipt [2026-11-17-person-dedupe/receipt.json](2026-11-17-person-dedupe/receipt.json).

- **We learned that "one shared email plus exactly the same name" links different people whenever the address is shared.** A team alias, a family email or a household address that only two same-named people carry looks exactly like one person's own address. You should not let an email make an automatic link on its own name match. On this bench, that rule as first approved (arm 1) links 120 of 400 different-people pairs (30.0%, 95% interval 25.7% to 34.7%). The finder contract's current `clean` rule adds a veto on a disagreeing LinkedIn or GitHub and the union check (closest here to arm 4 with the union check) and still links 52 of 400 (13.0%, interval 10.1% to 16.7%), all through shared team, family, household and no-role addresses.
- **We learned that a role-word list helps but can't finish the job, and a union check is needed whatever rule you pick.** Refusing role and household words (team, support, family and so on) still leaves addresses like `thesatos7@` or `bluebirds@`. A page that carries two people's ids joins them through two separate links; checking the union of linked groups before linking removes every such case here. Linking automatically only on a shared LinkedIn or GitHub, with the union check, links no different people (0 of 400, interval 0% to 1.0%) and finds 48 of 280 real duplicates; its email matches wait on a confirm list where 52 of 128 designed pairs are different people. Letting emails link with role words refused, a veto on a disagreeing LinkedIn or GitHub and the union check links 26 of 400 (6.5%, interval 4.5% to 9.4%) and finds 111 to 124 of 280.
- **These are stress rates on a world built from hard cases, measured on a stand-in, not on gbrain.** gbrain's duplicate finder (`gbrain dedupe --preview --json`) is not in a release yet. These numbers come from a reimplementation of its published rules, scored by the same code that will score the finder. How often each case occurs in a real contact list is not measured, so none of these is a field rate.

## The concrete case

All names are invented. A brain has two sources, `work` and `home`, and each has a page titled "Pavel Sato":

- `work:people/pavel-sato`, emails `pavel.sato@northwindmedia.example` and `team-sato3@northwindmedia.example`.
- `home:people/pavel-sato`, emails `pavel.sato2@northwindmedia.example` and `team-sato3@northwindmedia.example`.

They are two different people on one team. They share one email that no other page carries, their names fold to the same string and there is one page per source, so a rule of "one shared key that only these pages carry, plus exactly the same name" calls them the same person. A parent and child named "Daniel Okafor" who share a family email look the same to it.

The bridge case is different. Two "Sam Lee"s are in `work`, one with a GitHub login and one with a LinkedIn profile. The first Sam's page in `home` carries both, because a profile link was pasted from the wrong note. Each of the two links is fine on its own; their union makes both Sams one person.

## The experiment

**World.** A seeded generator writes person pages in two sources and keeps a ledger of which invented person each page belongs to. The ledger is the answer key; no system's output is ever used as gold. Every family has 20 instances at the default seed (1,380 pages), and every instance draws its full names fresh. Two initial-form titles, N. Abara and M. Dahl, still land in two instances each at this seed; they add two `weak` groups outside the designed pairs and change no number below.

| Different people (400 designed pairs) | Same person (280 designed pairs) |
|---|---|
| same name, different emails, company and city | same name, same email |
| same name at one company | case, spacing or a full stop differ |
| same name in one city | accents dropped (Núñez, Nunez) |
| same name and slug, one in each source | two romanizations (Aleksandr, Alexander) |
| same name, team address on just the two of them | family name first (Huang Wei, Wei Huang) |
| same name, team address on five pages | nickname (Robert, Bob) |
| same name, team address on six pages | initial (M. Reeves) |
| same name, a team alias with no role word (`bluebirds@`) | maiden and married name, same email |
| parent and child, same name, family email | two emails, one page lists both |
| parent and child, same name, household email with no role word | two emails, no overlap |
| parent and child, Jr on one, family email | one-person studio, `hello@` on its own domain |
| same name, placeholder email (unknown, n/a) | a second page in one source |
| executive listing the assistant's email | the true pair inside a chain and inside a bridge |
| two colleagues on a support mailbox | |
| lookalike names (Jon Park, John Park) | |
| same initial and surname (M. Reeves is Mira, not Maya) | |
| a chain: A and B are one person, C shares only a team address with B | |
| a bridge page, as above | |

Key coverage cycles by instance: a third of instances have emails only, a third give the first two pages a LinkedIn profile each (the same value for one person, different values for different people), and a third give the first page a GitHub handle. The bridge family sets its own keys. That split, and the fact that a person's `home` page usually names no employer, are design choices, and several results below depend on them.

**Systems.** Reference matchers are simple rules written in the runner, used as controls. The finder stand-in reimplements gbrain's documented finder (schema 1): a strict name fold (accents and punctuation removed, every token kept, so Jr still counts), email, LinkedIn and GitHub keys, placeholders dropped, a key on more than five pages ignored, and the classes `clean`, `likely`, `weak` and `conflict`. Automatic linking would join only `cross_source` `clean` groups. Its output goes through the same JSON parser the real finder's will. The stand-in runs under seven rules for `clean`, each with and without a union check:

| arm | rule for `clean` |
|---|---|
| 1 | approved rule as first written: one shared key value that only the group carries, the same strict-folded name, one page per source |
| 2 | arm 1, but an email whose local part has a role or household word never makes `clean` |
| 2b | key-type split: a shared LinkedIn or GitHub plus the same name links; an email also needs a shared LinkedIn or GitHub or the same employer; role emails never; no disagreeing LinkedIn or GitHub |
| 3 | arm 1, and the pages also share a value of a second key type |
| 4 | arm 1, and two pages that both carry a LinkedIn or GitHub must agree on it, in every class (email is left out, since one person often has several) |
| 5 | arms 2 and 4 together |
| 6 | arm 5, but a role email still counts when every page with an address at its domain has the same name |
| 7 | only a shared LinkedIn or GitHub plus the same name links, with the veto and the union check; an email never links on its own and goes to a confirm list an owner approves |
| + union | clean groups that share a page are checked as one union: one page per source, and every pair shares a key; a union that fails drops to `likely` |

The contract's current `clean` rule is the approved rule plus the veto on a disagreeing key and the union check (its rulings 1 and 2), which is closest to arm 4 with the union check.

**Metric.** A system's groups are closed transitively, because links chain: if A is linked to B and B to C, A and C count as merged. The headline is the share of designed different-people pairs that end up merged, with a Wilson 95% interval. Recall is the share of designed same-person pairs merged. Each finder-shaped output is scored at two tiers: the automatic tier (`cross_source` and `clean`) and everything the finder proposes (`clean`, `likely` and `weak`; `conflict` is a review list and never a merge).

## Results

Seed 20261117, generator version 1, ledger `14877e8e396c`. Intervals are Wilson 95%. Pairs from different instances are independent; the pairs inside one chain or bridge instance are not.

### Finder stand-in, by rule for `clean`

| arm | automatic tier: false merges | automatic tier: recall | proposed tier: false merges | proposed tier: recall | automatic-tier false merges come from |
|---|---|---|---|---|---|
| 1 | 30.0% (120/400; 25.7 to 34.7) | 51.4% (144/280; 45.6 to 57.2) | 65.0% (260/400; 60.2 to 69.5) | 63.2% (177/280; 57.4 to 68.6) | team 20, family 20, household 20, no-role alias 20, bridge 40 |
| 1 + union | 20.0% (80/400; 16.4 to 24.2) | 44.3% (124/280; 38.6 to 50.1) | same as arm 1 | same as arm 1 | team, family, household, no-role alias (20 each) |
| 2 | 20.0% (80/400; 16.4 to 24.2) | 46.8% (131/280; 41.0 to 52.6) | same as arm 1 | same as arm 1 | household 20, no-role alias 20, bridge 40 |
| 2 + union | 10.0% (40/400; 7.4 to 13.3) | 39.6% (111/280; 34.1 to 45.5) | same as arm 1 | same as arm 1 | household 20, no-role alias 20 |
| 2b | 13.3% (53/400; 10.3 to 16.9) | 24.3% (68/280; 19.6 to 29.6) | 49.3% (197/400; 44.4 to 54.1) | 63.2% (177/280; 57.4 to 68.6) | no-role alias 13, bridge 40 |
| 2b + union | 3.3% (13/400; 1.9 to 5.5) | 17.1% (48/280; 13.2 to 22.0) | same as arm 2b | same as arm 2b | no-role alias 13 |
| 3 | 0.0% (0/400; 0.0 to 1.0) | 14.6% (41/280; 11.0 to 19.3) | same as arm 1 | same as arm 1 | none |
| 3 + union | 0.0% (0/400; 0.0 to 1.0) | 14.6% (41/280; 11.0 to 19.3) | same as arm 1 | same as arm 1 | none |
| 4 | 23.0% (92/400; 19.1 to 27.4) | 51.4% (144/280; 45.6 to 57.2) | same as arm 2b | same as arm 2b | 13 in each of the four shared-address families, bridge 40 |
| 4 + union | 13.0% (52/400; 10.1 to 16.7) | 44.3% (124/280; 38.6 to 50.1) | same as arm 2b | same as arm 2b | 13 in each of the four shared-address families |
| 5 | 16.5% (66/400; 13.2 to 20.5) | 46.8% (131/280; 41.0 to 52.6) | same as arm 2b | same as arm 2b | household 13, no-role alias 13, bridge 40 |
| 5 + union | 6.5% (26/400; 4.5 to 9.4) | 39.6% (111/280; 34.1 to 45.5) | same as arm 2b | same as arm 2b | household 13, no-role alias 13 |
| 6 | 16.5% (66/400; 13.2 to 20.5) | 51.4% (144/280; 45.6 to 57.2) | same as arm 2b | same as arm 2b | as arm 5 |
| 6 + union | 6.5% (26/400; 4.5 to 9.4) | 44.3% (124/280; 38.6 to 50.1) | same as arm 2b | same as arm 2b | household 13, no-role alias 13 |
| 7 (union built in) | 0.0% (0/400; 0.0 to 1.0) | 17.1% (48/280; 13.2 to 22.0) | same as arm 2b | same as arm 2b | none |

**The confirm list.** Arm 7 moves every email-only match to a list of cross-source `likely` groups held by a shared email, which gbrain's finder marks `contact_key_only` (the bench scores the real finder's list by that mark). On this world that list holds 76 real-duplicate pairs and 52 different-people pairs (13 from each of the four shared-address families; the LinkedIn veto removes the other 7 of each 20). Confirming the whole list in one go gives 13.0% false merges (52/400; 10.1 to 16.7) and 44.3% recall (124/280; 38.6 to 50.1), the same totals as arm 6 with the union check, which links 26 of those pairs without asking. The list is only safer if someone reads it. Bridge pages never reach it: the union check drops them to `likely` on id evidence, not email.

What drives the numbers:

- **The approved rule already keeps apart** namesakes whose team address is on five pages (a conflict) or six (ignored as crowded), Jr suffixes, placeholder emails, assistants, shared mailboxes, lookalike names and the chain.
- **A word list catches only addresses with words on it.** Arm 2 removes the team and family cases and nothing else; household addresses and team aliases without a listed word stay. It also costs the one-person studio's `hello@` (13 pairs), which arm 6 gives back by treating a domain with one name on it as that person's own.
- **The bridge adds two false merges per instance under every arm except 3 and 7**, because each of its two links passes on its own. The union check removes all 40 and gives up the bridge's true pair (20 recall pairs).
- **Arm 4's effect is set by key coverage.** It removes exactly the instances where both namesakes carry a LinkedIn, 7 of every 20 here.
- **The key-type split's recall depends on employer coverage.** Its email path needs the same employer on both pages, and a person's `home` page in this world usually names none, so 2b keeps few email-only duplicates. What 2b still links wrongly is two same-named colleagues on a team alias without a role word, since they do share an employer.
- **The proposed tier is dominated by `weak` groups**, two pages with the same name and no shared key. No rule for `clean` changes it; only the LinkedIn and GitHub veto (arms 2b, 4, 5 and 6) trims it, from 260 to 197 false merges. That is right for a review list and wrong for a link.

### Reference matchers

| matcher | false merges (designed pairs) | recall (designed pairs) |
|---|---|---|
| exact name | 75.0% (300/400; 70.5 to 79.0) | 55.4% (155/280; 49.5 to 61.1) |
| folded name | 75.0% (300/400; 70.5 to 79.0) | 63.2% (177/280; 57.4 to 68.6) |
| any shared email | 55.0% (220/400; 50.1 to 59.8) | 85.7% (240/280; 81.1 to 89.3) |
| shared email and folded name | 40.0% (160/400; 35.3 to 44.9) | 48.9% (137/280; 43.1 to 54.8) |
| shared email and nickname-aware name | 40.0% (160/400; 35.3 to 44.9) | 56.1% (157/280; 50.2 to 61.8) |

The reference matchers have no crowding, one-page-per-source or conflict checks, and that is where most of their false merges come from.

## Company pages

The runner also writes company pages, so the same scorer reports false merges on companies. They come from [eval/generators/company-dedupe-gen.ts](../../eval/generators/company-dedupe-gen.ts) on their own random stream, so every person page, pair and number above stays exactly as this report's receipt has it at seed 20261117; a test checks each arm against that receipt. The numbers in this report are people only.

A company page has `type: company`, a title and the fields gbrain's finder reads for a company: `domain` (one value or a list), `website` (its host counts as a domain) and `linkedin` (a `/company/` page), plus industry, city, country, legal suffix and parent where the case needs them. All names are invented and every domain ends in `.example`. There are twelve families with 20 instances each:

| Different companies (must not link) | One company (must link) |
|---|---|
| same name and industry in another city; in 9 of the 20 instances both are franchise owners whose sites sit on the brand domain | same name, same domain |
| same name in one city, another industry | the legal suffix written another way or dropped (Inc and `, Inc.`; Inc and none; Incorporated and Inc; LLC and `L.L.C.`; Ltd and Limited; Inc and LLC after a conversion) |
| same name, another legal suffix and country (Halwick GmbH, Halwick Ltd) | initials (Halwick International Machines, HIM), with the same domain or none on the short page |
| names that differ only by the suffix, in one city (Halwick Inc, Halwick LLC) | a rename: the new page keeps the old domain, or only says "formerly" |
| parent and subsidiary: the subsidiary site on the parent domain, on a subdomain, or a name the finder's suffix list folds away (Halwick, Halwick Labs) | several domains: one page lists both, the pages list different ones, or one is a country domain |
| companies of one holding group on one domain, including a US and a UK company with the same name | |
| an acquirer and the company it bought, whose second page lists the acquirer domain | the bought company's own two pages |

LinkedIn coverage cycles as on person pages: on every third instance the first two pages carry a LinkedIn company page, one per company.

**How each arm treats company pages.** No arm ever links a person page to a company page, as the finder contract requires. On companies the keys are a domain (a contact key, like an email) and a LinkedIn company page (an exclusive key, like a personal LinkedIn), and the variant fold also drops trailing corporate suffixes (inc, llc, ltd, gmbh, labs and the rest of gbrain's list), so two names that differ only by a suffix and share a domain come out `likely` rather than `conflict`. Three arms have parts with no company rule:

| arm | on company pages |
|---|---|
| exact name, folded name | the same rule on company names |
| any shared email | any shared domain |
| shared email and folded name | a shared domain and the same folded name |
| shared email and nickname-aware name | there is no nickname table for companies; instead a shared domain and the same name after the legal suffixes are dropped |
| 1, 3, 4, 7 and every `+ union` | the same rule with the company keys |
| 2 | **no company rule**: role words are read from email addresses and company pages have none, so arm 2 is arm 1 on companies |
| 2b | the employer path has **no company rule**, so a shared domain links only with a shared LinkedIn company page as well |
| 5 and 6 | the role-word and one-person-domain parts have **no company rule**, so both are arm 4 on companies |

Every arm is scored three ways with the same metrics: over person pages, over company pages and over both together. A chain that runs through a page of the other type still counts in each type's score, and a person page and a company page that end up merged are counted as cross-type merges.

## What to use and what to avoid

Check the union of linked groups before any automatic link: it is the one guard here that costs only the cases it is meant to stop. Then decide how much an email may do on its own. If an email can link by itself, a role-word list plus a disagreeing-id veto brings the stress rate down but not to zero, because people name shared addresses anything. If it can't, the key-type split, a second key type or id-only links (arm 7) get to zero or close and link far fewer real duplicates without a person; arm 7's email matches then need a confirm step that is a real read, since 52 of the 128 designed pairs on its list are different people. Which is right depends on how often shared addresses meet same-named people in a real brain, which this bench does not measure.

Never treat two different emails as a disagreement: one person often has several. None of these rules links nicknames, initials, transliterations, name order, married names or a second page in the same source; those stay at zero recall at the automatic tier by design. Letters that NFKD does not decompose, such as ø, also keep "Søndergaard" and "Sondergaard" apart (3 of 20 accent pairs).

## Limits

- The finder stand-in follows the published contract, which marks some rules as specified rather than tested. Where the contract left a choice, the runner says which it took (for example, a `weak` group is the whole same-name set across sources). The real finder may differ, and its numbers replace these when it ships.
- The stand-in departs from the contract in two places. A group with a disagreeing LinkedIn or GitHub becomes `conflict` here, where the contract makes it `likely`, so the proposed-tier trim from 260 to 197 and the confirm list's 52 of 128 depend on that choice. And a role or household word anywhere in an email's local part counts (`team-sato3@`, `lee.family7@`), where the contract's `role_address` tag matches only the whole local part, so the gains of arms 2, 2b, 5 and 6 would be smaller under the tag.
- The family mix, key coverage and employer coverage are chosen to stress the rules. The rates say which rule fails on which case, not how often a real brain would see the failure.
- The world has no aliases, phone numbers, declared ids, X handles, dates, slug-shape cases or one-word pages.

## Reproduce

```sh
bun eval/runner/person-dedupe.ts --generator-version 1 --output eval/reports/person-dedupe
bun test test/eval/person-dedupe.test.ts
```

The run takes a few seconds, uses no key and no network, and writes `eval/reports/person-dedupe/receipt.json` with every arm scored for people, companies and both, every family and both ledgers' hashes (the generators rebuild the ledgers from the seed). `--generator-version 1` rebuilds the world this report measured (ledger `14877e8e396c`); without it the runner builds version 2, which adds the shared-id families (2026-11-18). This report's receipt predates the company pages; a new receipt's people scores (`by_type.person` on each arm) match it. To score gbrain's finder, write the world (person pages under `<source>/people/`, company pages under `<source>/companies/`) into a new, empty folder (the runner refuses a folder that already has files), import each source into a fresh brain, and score its output together with the import summaries (the runner fails unless every page was imported):

```sh
bun eval/runner/person-dedupe.ts --write-world /path/to/new-world
gbrain sources add work --path /path/to/new-world/work && gbrain sources add home --path /path/to/new-world/home
gbrain import /path/to/new-world/work --source work --no-embed --json > imports.jsonl
gbrain import /path/to/new-world/home --source home --no-embed --json >> imports.jsonl
gbrain dedupe --preview --json > finder.json
bun eval/runner/person-dedupe.ts --finder-json finder.json --finder-imports imports.jsonl --finder-build <release tag or commit>
```

## Disclosures

gbrain is Garry Tan's own project. ([Disclosures](../disclosures.md))

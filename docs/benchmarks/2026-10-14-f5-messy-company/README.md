# F5 owner-phrase precision on messy-company-v1 (2026-10-14)

F5 is gbrain's owner-phrase linking: it turns phrases like "Dana's freight account" into links to the account the
person owned on the page's date. The ship condition is that, at gbrain `4e10136b`, F5 must derive at least 22
owner-phrase links across both splits of messy-company-v1, with a Wilson 95% lower bound of at least 0.85 on their
precision. **F5 failed it.** It derived 6 links and all 6 were correct (precision 1.000, Wilson [0.610, 1.000]),
but 6 is below the 22-link minimum, and 0.610 is below the 0.85 bar. F5 is precise when it links, and it almost
never links: recall was 2 of 66 should-link phrases on dev and 4 of 58 on held-out.

| Measure | Dev | Held-out | Both |
|---|---|---|---|
| Owner-phrase links derived | 2 | 4 | 6 (bar: ≥ 22) |
| Correct links | 2 | 4 | 6 (precision 1.000, Wilson 95% [0.610, 1.000]; bar: lower bound ≥ 0.85) |
| Recall on `should_link: true` | 2/66 (3.0%) | 4/58 (6.9%) | 6/124 |
| Links on `should_link: false` | 0/35 | 0/32 | 0/67 |
| Wrong-account links | 0 | 0 | 0 |

The remote (public) view showed 4 of the 6 links. The 2 it hid both have `should_link_public: false` in the gold.
No remote link landed on any of the 9 gold rows whose evidence is private only. Per-reason and per-window
breakdowns are in [`scorer-reports.txt`](scorer-reports.txt). The 6 links all resolve the simplest case
(`unique_owned_match`, inside an open-ended stint); every other should-link reason got 0 links.

## How it ran

- **Code:** garrytan/gbrain `4e10136b4b7b79cb99408dca1136d3350f5de5e4`, unmodified.
- **Data:** [messy-company-v1](../../../eval/data/messy-company-v1/README.md) at gbrain-evals `9498ef78`, with
  MANIFEST sha256 `4a6bd0995c5608b6d369a97a550cc20c897e61f799f710b7336025a645574568`. The run checked the hash
  before loading.
- **Brain:** a fresh PGLite brain. All 226 pages were loaded with the dataset's own loader, with
  `mentions.owner_phrases=true` set before import. The mentions and F5 pass ran to quiescence: the second sweep
  scanned nothing and changed nothing ([`build.log`](build.log)).
- **Sample:** the population was every derived `owner_phrase` link. The frozen sampler `owner-phrase-sample-v1`
  refused because there were fewer than 22 links (exit 3, [`sample.log`](sample.log)). Per the rule, all 6 links
  were scored.
- **Scoring:** the dataset's owner-phrases scorer and gold ([`score.json`](score.json), [`score.log`](score.log),
  [`scorer-reports.txt`](scorer-reports.txt)). The system files are [`system-trusted.json`](system-trusted.json)
  and [`system-remote.json`](system-remote.json).

## Decision rule

[`DECISION-RULE.md`](DECISION-RULE.md) has sha256 `6ca46ba4a25e09dd87a3b0ca298f406ab077e71fb06145f83e40703b5fce0b11`
and was timestamped `2026-10-14T17:10:36Z`. It was written on the run machine before the run, and before anyone read
a corpus page or gold label. It was not committed to this repository before the run, so this repository's
preregistration-order check (`eval/runner/prereg.ts`) doesn't cover it. The evidence that it came first is the
timestamp and the hash, which the run's own outputs repeat. The rule says no code change and no tuning follow from
the result.

## Scripts

`build.ts` and `score.ts` are committed unmodified: they are the exact code that ran. They read and write under
`${HOME}/.capy/work/f5-messy/` on the run machine, which held the gbrain checkout (`gbrain/`), the dataset checkout
(`evals/`) and the brain (`brain/`). The brain and its export (`brain-export.json`, which `score.ts` reads) are not
committed.

| File | sha256 |
|---|---|
| `build.ts` | `e098a0298336848d2fe6700cca941526e167e925dbf6bae975c800cf32812ea8` |
| `score.ts` | `8120bd0fa4e43652f4ec0fd5ee9e9a2e15b4cf320c4989f9a71abc0e43659b80` |

`RESULT.md` is the run's own summary, also unmodified. Its note about `links_not_on_candidates` explains a scorer
quirk: one system file covered both splits, so each split's report counts the other split's links as
off-candidate. There were no off-candidate links.

## Held-out use

This run used the held-out split once for the owner-phrases lane. Future owner-phrase work tunes on dev only. Any
later held-out run of this lane needs its own preregistration, and it should be read knowing that this one exists.

## Changelog

### 2026-10-14: Run recorded

F5 failed the ship condition on gbrain `4e10136b`: 6 links, 6 correct, below both the 22-link minimum and the
0.85 Wilson bar.

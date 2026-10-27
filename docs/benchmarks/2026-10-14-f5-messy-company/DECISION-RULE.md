# F5 ship-condition gate: owner-phrase precision on messy-company-v1 (frozen decision rule)

Written before running F5 on this corpus and before reading any corpus page or gold label.
No code changes and no tuning follow from the result, whatever it shows.

## Inputs
- Code: garrytan/gbrain commit 4e10136b4b7b79cb99408dca1136d3350f5de5e4, unmodified.
- Corpus: garrytan/gbrain-evals `messy-company-v1` (PR #153), branch `capy/messy-company-v1` at 9498ef78,
  frozen MANIFEST sha256 4a6bd0995c5608b6d369a97a550cc20c897e61f799f710b7336025a645574568.
  The manifest hash is checked before loading; a mismatch stops the run.
- Brain: fresh PGLite, loaded with the dataset's own loader, both splits (dev and held-out, all 226 pages).
  If the page count is not 226, stop and report.
- Settings: `mentions.owner_phrases=true` at build, then the full mentions/F5 pass run to quiescence
  (repeat the sweep until a sweep scans nothing and creates/removes no links).

## Population
Every derived `owner_phrase` link (links.link_kind = 'owner_phrase'), trusted view.

## Sample
- If the population has 100 links or fewer, take all of them.
- Otherwise take 100 using `scripts/owner-phrase-sample.ts`'s frozen rule `owner-phrase-sample-v1`
  with seed `20261014`.

## Scoring
Use the dataset's owner-phrases scorer and gold (`should_link` plus the intended account).
A derived link is correct only when a gold row has `should_link: true` for that doc, phrase and account.
A link with no matching gold row, or whose matching row has `should_link: false` or names another account,
is wrong.

## Pass
Both must hold:
1. At least 22 links in the population.
2. Wilson 95% (z = 1.96) lower bound on sample precision >= 0.85.
Otherwise the verdict is FAIL. (If the population is below 22 links the verdict is FAIL: insufficient population.)

## Informational (do not affect the verdict)
- Recall against `should_link: true` gold, per split (dev, held-out).
- Remote view: private-only evidence must yield no link visible to a remote caller.
- Per-trap breakdown.

## Report
Link count, sample size, correct count, precision, Wilson interval, verdict, recall, remote-view check,
and each wrong link with its gold reason.

# External ideas wave A: absolute dates beside relative time phrases (search.evidence_resolve_dates)

Measured 2026-10-21 under the [preregistration](2026-10-21-external-ideas-wave-a-preregistration.md) and its same-day amendment, at gbrain `cfa1a006b64c5baa199142bf0f0b56a0e3fc6c06`. Every file behind these numbers is in [`2026-10-21-external-ideas-wave-a/results/`](2026-10-21-external-ideas-wave-a/results/).

**Verdict: inconclusive on both suites, so the flag stays off by default.** On LongMemEval-S, Sonnet 5.5 scored 2.5 questions lower with the brackets (460.5 against 463 of 500; 95% interval −8 to +2.5). The test is neither a pass (one-sided p 0.87) nor a regression (one-sided loss p 0.23). On the synthetic suite both arms scored 60 of 60 in both samples, a ceiling that can't show a difference. Because Sonnet did not pass both suites, the secondary models (`gpt-6.1-sol`, `claude-opus-5-5`) were not run, as preregistered. The bracket audit judged 1 of 100 sampled brackets wrong.

## LongMemEval-S (500 questions, decision model `claude-sonnet-5-5`)

Frozen retrieval: `balanced` mode, the same hits and budgets for both arms (frozen manifest `5f62ad3909320ae95c3496a263348bd1cc7deaf1ac335ee25490196acaf7be5b`). **395 of 500 questions are affected**: their two reader requests differ. The brackets made 1,303 insertions across those 395 questions, with no `relative_dates_over_budget` and no `relative_dates_unavailable` fallbacks. `brain.timezone` is unset (UTC days), and the three pinned feature files match the manifest hashes.

| Measure (official judge, mean of 2 samples) | auto | auto_dates | Net gain | 95% CI | One-sided p (gain) | One-sided 95% lower bound | Wins | Losses |
|---|---|---|---|---|---|---|---|---|
| All 500 questions | 463 | 460.5 | −2.5 | −8 to +2.5 | 0.866 | −7 | 9 | 14 |
| Affected only (395) | 363 | 360.5 | −2.5 | −8 to +2.5 | 0.867 | −7 | 9 | 14 |
| Framed judge, report-only | 459.5 | 457 | −2.5 | | | | 8 | 13 |

One-sided p for a loss: 0.235, so not a regression. The sign-flip and bootstrap each used 10,000 draws with seed 20261021.

| Type | Questions | Affected | auto | auto_dates | Net gain |
|---|---|---|---|---|---|
| temporal-reasoning | 127 | 109 | 113 | 111.5 | −1.5 |
| multi-session | 121 | 97 | 104 | 104 | 0 |
| knowledge-update | 72 | 57 | 71 | 71 | 0 |
| single-session-user | 64 | 50 | 61.5 | 60.5 | −1 |
| single-session-assistant | 56 | 35 | 55.5 | 56 | +0.5 |
| abstention | 30 | 24 | 28 | 28 | 0 |
| single-session-preference | 30 | 23 | 30 | 29.5 | −0.5 |

- **Reader noise:** the two `auto` samples disagree on 12 of 500 questions (2.4%), 8 of them affected. The observed difference is the same size as the noise.
- **Judges:** they agree on 1,762 of 1,790 rows. Official yes and framed no on 19 rows; official no and framed yes on 9.
- **Ceiling:** `auto` is already at 92.6%, and temporal-reasoning, the type the feature targets, is at 89%. A gain had little room.

## Synthetic relative-date suite (60 questions, `claude-sonnet-5-5`)

All 60 questions are affected, with 293 insertions and no fallbacks (frozen manifest `65335b758819a75aba70e6609f5dfdab604c9bd3e4b675e8854052a209772ab6`). Both arms answered 60 of 60 in both samples, and the judges agreed on all 240 rows. Net gain 0, verdict inconclusive. The reader resolves these single-day relative phrases from the session dates in its prompt without any help. So this suite, as preregistered, can't distinguish the arms, and a harder version would need a new file (`synthetic-dates-v2`) and an amendment.

## Secondary models

Not run. The amendment runs them only after Sonnet passes both suites. `verdict.json` lists them as skipped, and `default_flip_ready` is false.

## Bracket audit (100 of 1,303 LongMemEval insertions, judged by `claude-opus-5-5`)

The judge called 93 brackets correct, 1 wrong and 6 ambiguous; none went unparsed. That is a 1% wrong rate, under the 5% limit.

- **The one wrong bracket:** the original turn contradicts itself ("last Saturday, March 17th" in a session dated in May). The bracket gives the Saturday before the session date.
- **The ambiguous six:** "this weekend", "last Saturday" on a Sunday, "last week", "next month" and "this week". Each is a reasonable reading, but other readings exist.

## Existing gbrain-evals categories with the flag on

The flag was forced on with a one-line patch on top of `cfa1a006` ([`flag-on.patch`](2026-10-21-external-ideas-wave-a/results/flag-on-categories/flag-on.patch)). Both builds then ran keyless, with provider keys unset. Details: [`flag-on-categories/REPORT.md`](2026-10-21-external-ideas-wave-a/results/flag-on-categories/REPORT.md).

- **Keyless categories:** all 36 dispatched offline categories got the same status in both builds. The receipt diffs show only timing, paths, ids and known run-to-run noise.
- **The caveat:** an instrumented build logged 3,617 deliveries in that sweep (agent-retrieval-shapes, deletion audit, N14 and N6), and every one had 0 insertions. Those corpora use named speakers, and only user turns get brackets. So the sweep shows nothing around the flag breaks; it doesn't exercise the feature.
- **The default path delivers too:** delivery has a plan even without `return_unit` or `token_budget`. The default unit is `auto`, so plain `search`, `query`, `recall` and `think` annotate conversation pages whenever the flag is on.
- **Budgeted deliveries lose evidence:** re-delivering the committed LongMemEval frozen hits keylessly under explicit budgets (window, section and `auto` at 4k to 7.5k tokens), the brackets fall back as over budget on 4 to 111 of 500 questions, depending on the arm. On 2 to 92 questions the reassembled delivery carries fewer tokens than flag-off: original evidence is cut to make room for brackets. Unbudgeted `auto` (evidence-auto-v2's default budget) and `page` (100k) each change 388 of 500 questions, adding about 13,000 tokens in total, with no fallbacks. Budgets are never exceeded, and result counts and reasons never change.
- **Unit tests:** 190 evidence-delivery-adjacent tests give identical pass sets in both builds.
- **Paid categories not run:** evidence-delivery ($122 program), evidence-auto-v2 ($74) and the harness and shootout cells are all over $5. Their estimates are in `flag-on-categories/costs/`.

## Cost

All of it was charged to the GBRA-162 lane ledger (waves A and B): $54.01 committed of the $220 cap, $165.99 left (`results/ledger-status.json`). Every answer cell ran through Anthropic Message Batches at the confirmed 50% factor after a 10-request pilot at list price.

| Step | USD |
|---|---|
| Smoke (2026-10-21, before the preregistration was pushed) | 0.48 |
| LongMemEval freeze, 4 shards, about 33 s per question | 7.84 |
| Sonnet 5.5: `auto` samples 1 and 2 (500 each), `auto_dates` samples 1 and 2 (395 each) | 44.38 |
| Synthetic freeze and four cells | 0.97 |
| Bracket audit | 0.34 |

## What this changes

Keep `search.evidence_resolve_dates` off by default. The brackets are almost always correct (1% wrong), but on the frozen LongMemEval-S retrieval they don't improve Sonnet 5.5's answers. The synthetic suite is too easy to show an effect. In budgeted deliveries the brackets can displace original evidence. A follow-up worth considering is a harder synthetic suite (v2), for example multi-step date arithmetic, or sessions without a date header in the prompt.

# Open loops on Gmail-shaped threads (N7, 2026-10-01)

## The finding

gbrain's Gmail turn-flip detector does what its guide documents. On 136 seeded threads judged at a pinned now (`2026-10-01T12:00:00Z`) and 32 multi-round store scenarios, run against the pinned gbrain `3a284ae` (v0.60.26.0) through a copied overlay, every preregistered safety contract held and every quality threshold passed:

| Rule (preregistered in `eval/registry.ts`, `open-loops-email`) | Result |
|---|---|
| No loop from noise, list, CC-only, self, calendar, grace-window or no-question mail | 0 loops on 37 excluded threads |
| A calendar notice never closes a loop | 0 closes (4 snapshot threads, 4 store rounds) |
| A manual close survives re-applying the unchanged thread | 0 reverted of 4 |
| A muted sender or thread opens no new loop | 0 opened of 8 (4 sender mutes, 2 of them upper case, and 4 thread mutes) |
| `open_loops` for a remote caller carries no quote, link, digest or body | 0 leaks over 16 groups (trusted control: 16 quotes) |
| Planted-loop recall, floor 80% | 45 of 45 (100%) |
| Closure accuracy, floor 95% | 39 of 39 (31 snapshot threads, 8 store rounds) |
| Counterparty accuracy, floor 95% | 45 of 45 |

The category's verdict is `pass`, so `open-loops-email` gates CI on these rules from this commit.

The interesting results sit outside the gate, where the mechanics and the meaning of "someone is waiting" come apart:

1. **A nudge hides an overdue request on first sight (bug N7-1).** A request unanswered for 30 to 120 hours followed by a nudge 1 to 20 hours old opens no loop: 0 of 6 inbound threads and 0 of 4 outbound follow-ups were detected. The grace window is measured from the nudge, not from the request. In steady state, when a sync saw the request before the nudge, the loop stays open (4 of 4 store rounds), so this bites on a first sync of an existing inbox and after a sync gap.
2. **Any reply closes a loop, even "Thanks!" (feature gap N7-2).** This is the documented contract ("a reply lands, the loop closes itself"), so it is not a bug. Of 23 threads closed by my reply, 13 (57%) still leave the other person waiting by the generator's semantic labels: 5 acknowledgements ("Thanks!", "Noted, thank you."), 4 replies that promise later delivery and 4 replies that thank and promise later delivery.
3. **Promise fulfillment is not tracked (feature gap N7-3).** The extractor never marks a stored commitment fulfilled. A preregistered paid replay ($0.10) showed it end to end: the model correctly omitted all 4 fulfilled promises on a single pass, but all 4 commitment loops extracted before the fulfilling message stayed open after it was extracted.
4. **Ranking runs on the wall clock (feature gap N7-5) and on detection time (N7-6).** At a fixed instant the order is stable, but the same rows rank differently two days later and no parameter pins the clock. Loop age is time since detection: two requests 720 and 30 hours old detected in one sync are 0.001 s apart in `opened_at`.

There are no Slack or calendar loops (feature gap N7-4), and a question mark inside a link opens an outbound loop (4 of 4, feature gap N7-7).

## The concrete case

An invented example. Avelin (`avelin.quillfeather-0@example.org`) writes "Could you send me the deck for the Q3 budget?" on Monday. On Wednesday, still with no deck, she writes "Just bumping this up. Any news?" A first sync on Wednesday evening sees both messages.

- The guide says a loop opens when the last substantive message is theirs, I am in To, and it has been unanswered for 24 hours. The request has been unanswered for about 50 hours.
- gbrain measures the 24 hours from the newest message, the nudge, so it reports nothing until Thursday evening. The code's own comment says a nudge must not hide a loop "exactly while the counterparty was most impatient"; it fixed that for the close lane, not for a loop seen for the first time.

Now suppose I had replied "Thanks!" on Tuesday instead. The turn flips, the loop closes as documented, and `gbrain waiting` stops showing Avelin, although the deck was never sent. That is the line between mechanics (who spoke last) and semantics (who still owes what) that amendment 8 asks us to keep apart.

## The experiment and results

**World.** `eval/generators/n7-gmail-loops-gen.ts` (version `n7-gmail-loops-gen-v1`, seed 7, ledger SHA-256 `5373f56659fae43a8628cc3e525e7f8b6a005c0f4170cb4088d2a119e1631ef8`) writes 136 threads in 28 classes and 32 store scenarios. Addresses are invented placeholders on example domains. Each message carries ledger facts the generator decides: who sent it, to and copied whom, how many hours before the pinned now, the author's own words, any quoted or forwarded text, whether it is human, noise, list or calendar mail, and whether the author's words ask something.

**Path through gbrain.** Every thread is rendered as raw Gmail API JSON (headers, base64 text part, a `text/calendar; method=REQUEST` part for calendar notices, `List-Unsubscribe` for list mail) and parsed by gbrain's own `GmailClient.getThread` through a stub fetch. So From normalization, quoted-reply trimming and the calendar stamp run exactly as in a sync. The parsed thread goes to `detectThreadLoop` with the pinned now. Store scenarios replay rounds through `applyThreadLoopVerdict` (pinned now per round), `loops_close`, `loops_mute` and `open_loops` on in-memory PGLite. Provider keys are stripped, `GBRAIN_HOME` is a fresh directory and System One is off.

**Gold.** Mechanics gold is an independent implementation of `docs/guides/open-loops.md` over the ledger facts, never gbrain output. "Unanswered for 24 hours" counts from the first unanswered message after my last reply. Semantic labels (the other person still waits on me, a promise was made, it was fulfilled) are generator labels reported beside the mechanics, never mapped onto them.

**Detection by class (snapshot, 136 threads).**

| Class group | Threads | Documented-rule loops | Detected correctly |
|---|---|---|---|
| Planted loops (inbound, alias, several To, upper-case sender, outbound, several recipients, reply then owed, calendar after a question, promise to me) | 45 | 45 | 45 |
| Closures and no-loop threads (answered by me, "Thanks!", their fresh reply, reply quoting a question, forward, my promises) | 40 | 0 | 40 |
| Excluded mail (inbound or outbound inside the window, CC-only, list, noise, calendar, self-thread, FYI) | 37 | 0 | 37 |
| Contested readings (nudge, follow-up, link question mark) | 14 | 10 | 0 nudges or follow-ups, 4 link false positives |

The 25 amara-life-v1 inbox threads (addresses pseudonymized, judged two days after the last message) agree with the oracle on 25 of 25 (18 loops expected, 18 detected). They are background, not gold-labeled by an outside party.

**Store scenarios (32, 4 of each kind).** Reply close 4 of 4 closed by `reply_detected`; turn flip 4 of 4 closed the outbound loop and 4 of 4 then opened the inbound one; acknowledgement close 4 of 4; nudge hold 4 of 4 stayed open; calendar hold 4 of 4 stayed open; manual close held 4 of 4 and reopened on genuinely newer mail 4 of 4; sender and thread mutes blocked 8 of 8.

**Ranking (conformance only, no quality claim).** With rows fixed and `Date.now` overridden in process: the same instant gives the same order twice; a counterparty with two loops ranks above an otherwise equal one with one loop; a one-commitment counterparty due in 8 days ranks below a 10-day-old loop now and above it two days later. A clock that advances during the sort did not change the order on this fixture.

**Paid extractor arm (exploratory, preregistered in [`prereg-n7-extractor-arm.md`](../plans/2026-10-01-eval-category-wave/prereg-n7-extractor-arm.md)).** `runLoopsExtract` with gbrain's default chat model `anthropic:claude-sonnet-4-6`, 36 calls, $0.10 through the budget-ledger guard (run `eval-category-wave-n7-n8-...-147c2e1d`, $10 cap). The preregistration listed 12 control threads and 31 calls; the seed has 5 FYI threads, not 4, so the controls are 13 and the calls 36.

| Metric | Result |
|---|---|
| Open promises extracted in the right direction | 11 of 11 |
| Due date exact | 11 of 11 |
| Fulfilled promises left out on a single pass | 4 of 4 |
| Commitment loops still open after the fulfilling message was extracted (replay) | 4 of 4 |
| Control threads with an `owed_by_me` commitment | 4 of 13 (all 4 are "Thanks!" replies to a request; arguably the request is owed, but no promise was made) |

Hermetic run time: about 5 seconds for the whole category.

## gbrain bugs found

### N7-1. A nudge inside the grace window hides an overdue request on first sight

- **Contract.** `docs/guides/open-loops.md`: "last substantive message is theirs, you're in To:, unanswered >=24h". The close-lane comment in `src/core/google/loop-detect.ts` says a fresh nudge is not a reply and must not hide the loop.
- **Where.** `detectThreadLoop`: `if (ageHours(last.internalDateMs, now) < INBOUND_GRACE_HOURS) return { open: [], close }` measures the window from the last message; the outbound branch does the same with 72 hours.
- **Repro.** `bun docs/benchmarks/2026-10-01-n7-open-loops-email/repro/n7-1-nudge-backfill.ts`. Expected `unanswered_inbound` for a request 40 hours old with a nudge 5 hours old; actual: no loop.
- **Scope.** First observation only (first sync of an inbox, or a sync gap); steady-state syncs keep the loop open. The guide's wording can be read either way, so the ledger records the reading and the code comment it rests on.

## Feature gaps and documented limits (not bugs)

- **N7-2, any reply closes.** Documented. Acknowledgements are not told apart from answers.
- **N7-3, no fulfillment tracking.** Documented as future work. The paid replay shows it end to end.
- **N7-4, Gmail only.** No Slack or calendar loop source; calendar mail is excluded by design.
- **N7-5, wall-clock ranking.** `rankGroups` calls `Date.now()`; correct for "due soon", but a published order cannot be replayed and an evaluation cannot pin it.
- **N7-6, loop age is detection age.** `opened_at` defaults to the database clock at insert.
- **N7-7, a link's question mark is a question.** `bodyText.includes('?')`.
- **Mute latency.** `applyThreadLoopVerdict` caches suppressions for 60 seconds per process, so a sync inside that minute can still open a loop for a just-muted sender. The runner clears the cache through the documented test seam after each mute.
- **Timestamps.** `closed_at`, `opened_at` and staleness use the database clock even when the detector gets a pinned now; the runner never scores a stored timestamp.
- **A promise to me opens a reply-owed loop.** "I will send the contract by Tuesday" from the other person is the last word, so a reply is owed by the documented rule (3 of 3), though nobody waits on me.

## What to use and what to avoid

Use `gbrain waiting` to find threads where someone spoke last and you have not answered; it is exact on every documented rule tested here. Do not read a closed thread loop as "handled": a one-word acknowledgement closes it. After first connecting an inbox, expect threads with a recent nudge to appear only once the nudge is a day old. Do not rely on the ranking order being reproducible across days.

## Reproduce and inspect

```bash
bun install
bun eval/runner/n7-open-loops-email.ts --gbrain ../gbrain@3a284aea26889b77c633aebb4149c3016d834ee6   # hermetic, $0
bun eval/runner/all.ts --tier offline --only open-loops-email
bun eval/runner/n7-open-loops-email.ts --paid --budget-run-id <id>                                     # extractor arm, about $0.10
bun test test/eval/n7-open-loops-email.test.ts
```

Receipts: [hermetic run at the pin](2026-10-01-n7-open-loops-email/receipt-pin.json) (outputs SHA-256 `a91b1adf...`, identical on a second run), [paid extractor arm](2026-10-01-n7-open-loops-email/receipt-extractor-pin.json). Repros: [`2026-10-01-n7-open-loops-email/repro/`](2026-10-01-n7-open-loops-email/repro/). Findings: [wave bug ledger](2026-10-01-wave-bugs.md).

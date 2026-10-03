# Amendment: N7's oracle follows the open-loop rules of the gbrain under test (2026-10-03)

Frozen on October 3, 2026, in its own commit, after one N7 run at gbrain `48ed5e8` and before the run this release reports. This file says what was seen, what changes and what does not.

## What happened

N7 checks `gbrain waiting`'s loop detector against an independent implementation of the rules in gbrain's [open-loops guide](https://github.com/garrytan/gbrain/blob/48ed5e8233f617479df989998560840747af0425/docs/guides/open-loops.md). The October 1 preregistration froze that guide as it read at `3a284ae` ("a reply lands, the loop closes itself"). Under that rule, a reply of mine that only says "Thanks!" to their question closes the loop. We recorded that as feature gap N7-2: someone is still waiting.

gbrain fix wave 7 ([#5908](https://github.com/garrytan/gbrain/pull/5908), v0.60.32.0) changed the documented rule on purpose, to close N7-2. The guide at `48ed5e8` now says: "A reply of yours that only acknowledges their question ("Thanks!", "Got it, thanks.") is not an answer: the loop stays open and its clock keeps running." Its close semantics add: "an acknowledgement-only reply to a question does not count."

The first N7 run at `48ed5e8` therefore failed the preregistered closure-accuracy threshold: 34 of 39 closure cases (87.2%, threshold 0.95). All five misses, and all eight extra opens that lowered precision to 45 of 53, are the eight `ack_thanks` threads, where gbrain now keeps the loop open exactly as its guide says. Every other gating number held: planted-loop recall 45 of 45, counterparty accuracy 45 of 45, and 0 on all five safety contracts. That receipt is kept as [`n7/receipt-frozen-oracle-48ed5e8.json`](2026-10-03-wave7-repin/n7/receipt-frozen-oracle-48ed5e8.json).

So the frozen oracle no longer implements gbrain's documented rule. That is a defect in the category (ledger entry N7-8), not a gbrain regression.

## What changes

`mechanicsOracle` in `eval/generators/n7-gmail-loops-gen.ts` takes a rule set:

- `reply-closes`: the guide at `3a284ae` and `d44296c`. Any reply of mine flips the turn. Unchanged from the October 1 oracle.
- `ack-is-not-a-reply`: the guide at `48ed5e8`. When their latest message asks something, a reply of mine that is one of the generator's acknowledgement-only texts (`ACK_ONLY_REPLIES`: "Thanks!", "Thanks, got it.", "Noted, thank you.") is not counted as a reply. An acknowledgement of a message that asked nothing still counts, as the guide says.

The runner picks the rule set from the version of the gbrain it measures (`n7RulesFor`: 0.60.32.0 and later use `ack-is-not-a-reply`) and records it in the receipt as `resolved_config.oracle_rules`. Recognizing an acknowledgement uses the generator's own list of the texts it wrote, never gbrain's code.

## What does not change

- No threshold, contract or metric definition. Planted-loop recall stays at a floor of 0.80, closure and counterparty accuracy at 0.95, and the five safety contracts at 0.
- No benchmark input. The generated threads, seed, store scenarios and ledger hash are byte-identical. Only the gold computed from them changes, and only on the eight `ack_thanks` threads.
- Earlier receipts and their numbers. At `d44296c` and `3a284ae` the runner still applies `reply-closes`.
- The store scenario `ack_close` keeps its expectation that an acknowledgement closes the loop. It is exploratory (`data.exploratory.acknowledgement_closes`) and now records gap N7-2 closing.

## Why this is not moving a goalpost

The preregistered basis anchors the gold in gbrain's documented rules, and the category contract says the gold is "an independent implementation of the rules in docs/guides/open-loops.md." The rule changed because gbrain fixed the gap this benchmark reported. Keeping the old rule would make N7 fail every gbrain release that contains the fix, and would require it to reproduce the behavior the ledger called a gap. Both numbers are published side by side in the [results](2026-10-03-wave7-repin.md), so a reader can judge the change.

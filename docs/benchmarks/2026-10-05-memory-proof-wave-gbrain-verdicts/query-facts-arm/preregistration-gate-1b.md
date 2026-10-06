# Facts arm in query: gate 1b and revised gate 2 (preregistration)

Copied from garrytan/gbrain `docs/eval/decisions/query-facts-arm/README.md` (#6066) when it was written, before any gate 1b cell or revised gate 2 run.


Written on 2026-10-06, after gate 1's result and before any gate 1b cell or revised gate 2 run. Gate 1 found a
flaw in how the bench was built. B2 simulates past question dates, but `remember` stamped each correction with the
wall-clock save date, so every correction looked like it came after the question. A real agent doesn't see that,
because a real question comes after the correction. Gate 1b keeps everything else the same and dates each
correction when it was made. The diagnostic above used the same writes on the earlier build and was not a gate; gate 1b reruns them as a gate on the new build.

**The change under test.** Fact rows take only spare capacity:

- They fill free slots up to the caller's row count (an explicit `limit`, otherwise the mode's default) and never
  displace a page row.
- When the caller sets a token budget, the page rows are budgeted first, and a fact row is added only if it fits
  in what remains.
- When there are no free slots or no budget left, `query` returns the page rows unchanged.

Everything else is as in "The change" above: matching, read policy, `superseded_claim` stamps and no model call.
The measured build is the gbrain commit that contains this change. Both gates name it.

**Gate 1b, B2 corrections with correction-dated writes** (gbrain-evals `eval/workload-suites/bench.ts
corrections`, flags from gbrain-evals `d01d3bc`):

- Setup: every arm runs with `--remember-valid-from`, so `remember` receives each item's `correction_timestamp`
  as `valid_from`. Arms: forget-then-remember with `search.query_facts_arm` off and on
  (`--gbrain-search-config search.query_facts_arm=true`); edit-sync and append, off and on. Same suite
  (`corrections-v1`, seed 20261006, 100 items), same reader (`claude-sonnet-5-5`), same fixed judge and same
  retrieval budget as gate 1. Answer phase, then score phase.
- Metrics: corrected-value accuracy and stale-answer rate after 1 and after 5 unrelated writes.
- **Rule:** the key-on forget-then-remember arm wins if its corrected-value accuracy is higher than key off at
  both checkpoints and its stale-answer rate is not higher at either. Edit-sync and append must not lose more
  than 2 points of corrected-value accuracy at either checkpoint with the key on.

**Revised gate 2** (`bun evals/entity-anchoring/regression.ts --json --key search.query_facts_arm`, hermetic):

- The three corpora as written (NamedThingBench, relational retrieval-quality, LongMemEval nightly) and the two
  diagnostic copies that seed one saved fact per question (`namedthing+facts`, `relational+facts`).
- Recall@10 over page rows, the key on and off.
- **Rule:** no question's recall@10 is lower with the key on, in any of the five. Each reports how often the arm
  added a row, so a pass where the arm never fires is visible as such.

**Decision.** `search.query_facts_arm` becomes default-on only if gate 1b and revised gate 2 both pass.
Otherwise it stays off. Gate 1's failure stands as recorded. Spend cap: $30.


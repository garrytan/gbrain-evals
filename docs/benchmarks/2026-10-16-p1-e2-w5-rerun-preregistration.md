# P1 E2 rerun after gbrain W5 (late closures as upper bounds): preregistration (2026-10-16)

Frozen before any cell runs, in a commit separate from every result. The custodian runs every cell on its own machine; the implementer never reads the held-out phrasing or row-level results. No held-out text appears in this file.

## Question

The P1 E2 certification ([verdict](2026-10-05-heldout-verdicts/p1-e2-r2-heldout-2026-10-04.json), [record](https://github.com/garrytan/gbrain/blob/master/docs/eval/decisions/p1-e2-2026-10-05/README.md)) found 41 of 66 nightly closures dated after the real end of the job: with only "joined" lines, the earlier job closes on the next job's start date. gbrain W5 (10x memory plan, wave 4a) does not move those dates. It discloses them as upper bounds: a closure only the nightly check dated reads `ended: works_at <x> (by <date>)`, and an explicit end line replaces it. This run reports the late-closure count on the W5 build, checks that every late closure is disclosed as an upper bound, and checks that the E2 safety bars still hold for the three counted models.

## Evidence class

Held-out confirmation on material already used once: phrasing set C's joins-only ledger, which passed E2 on 2026-10-04 (not spent, since it passed). The development evidence is gbrain's synthetic and forced probes on both engines (`test/belief-ledger-w5-time-model.test.ts`, `test/link-validity.test.ts`), run at $0 by the implementer.

## Build and data

- **gbrain:** the first master commit that contains the wave 4a pull request (W4 and W5). The custodian records its SHA and version in the verdict file before the first cell. A build without W5 is not measured.
- **gbrain-evals:** the merge commit of the pull request that adds this file and the `late_upper_bound` metric to `eval/runner/temporal-contradictions.ts`.
- **Material:** phrasing set C joins-only ledger (dated, out-of-order and undated sub-ledgers), the same custody file as E2. The custodian checks that its SHA-256 equals the one in the E2 attempt-2 receipt held in custody, and records both.
- **Seeds:** 11, 13, 17. **Runs:** 3 per model.

## Arms

Each seed runs on a fresh in-memory PGLite brain, as in E2:

- `e1`: the build as written, phase not run (the comparator for as-of).
- One arm per counted model with `dream.edge_contradictions.mode=apply` and `models.dream.edge_contradictions=<model>`, one phase run per run: `anthropic:claude-opus-5-5`, `anthropic:claude-sonnet-5-5`, `openai:gpt-6.1-sol`.

Model choice follows the project's model rules: the newest Opus, Sonnet and GPT. All three ran in E2, so they are the shared link to it and no older model is added. `claude-haiku-4-5` (the utility default, E2-certified) is an older generation and is not rerun; `claude-fable-5-1` is smoke-test only and is not run.

## Metric and denominator

Per model run, as `temporal-contradictions.ts` computes them (definitions in its header):

- **Reported (primary): late closures**, applied closures dated after the ledger's end of that job, over applied closures. E2's value was 41 of 66 for each of these models. W5 does not change closure dates on a joins-only ledger, so the expected count is unchanged; the count is reported, not gated.
- **Check C1: late closures disclosed as upper bounds** (`late_upper_bound`): late closures whose every end transition on the close date was written by the nightly check (producer `dream`), the rule gbrain's relationship note uses for `(by <date>)`.
- **Check C2 (carried from E2):** wrong-closure rate, undated closures, and as-of exact (`get_links` as-of over the dated and out-of-order people).

Harness errors void the model's run; a run with harness errors is rerun once with the same seed, and a second failure leaves that model **invalid**, not passed.

## Decision rule

- **C1 passes** when `late_upper_bound` equals `late` in every run of every counted model.
- **C2 passes for a model** when every run has wrong closures at most 1%, 0 undated closures, and as-of exact at least the E2 value for that model (0.361 for all three; ties pass). As-of is compared with E2 rather than with a margin because W5 should leave it unchanged; any drop is a regression.
- No other comparison is made, so no multiple-comparison correction applies.

## What each outcome changes

| C1 and C2 pass | C1 fails | C2 fails for a model |
|---|---|---|
| W5's upper-bound disclosure is confirmed on held-out material; the three models keep their `apply` certification on the W5 build. | Some late closures are not disclosed: the gap is fixed on development data and confirmed on fresh held-out phrasing (set C is spent for C1). | That model's `apply` certification is withdrawn (it proposes) until a fix passes on fresh held-out material; the late-closure count is still reported. |

## Budget

Joins the eval budget ledger (`--paid --budget-usd 8`). E2 attempt 2 cost $5.88 for five models; this run's three models are estimated at about $5. When the cap is reached the run stops, the partial runs are reported as incomplete, and no verdict is drawn.

## Command (custodian)

```
bun eval/runner/temporal-contradictions.ts --gbrain <checkout>@<sha> \
  --models anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5,openai:gpt-6.1-sol --runs 3 --seeds 11,13,17 \
  --phrasing-file <custody path> --decision-id p1-e2-w5-heldout-<date> --purpose "P1 E2 rerun after gbrain W5" \
  --output <custody dir> --paid --budget-usd 8
```

The custodian publishes the aggregate verdict file under `2026-10-05-heldout-verdicts/`; row-level output stays in custody.

## Amendments

None yet.

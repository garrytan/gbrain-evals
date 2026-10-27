# Report template: Cat 40 Hard

The dated report `docs/benchmarks/<date>-model-ladder-hard.md` follows this outline (CEO-F8, CEO-F23, CEO-F25, CEO-F27, DX-F15) and the report shape in [CLAUDE.md](../../../CLAUDE.md). It links from the Cat 40 report ([2026-10-02-model-ladder.md](../2026-10-02-model-ladder.md)). Every number comes from committed results; one offline command reproduces every table:

```bash
scripts/cat40-hard.sh step report
```

## 1. The finding

One paragraph: the primary endpoint (pooled 50k paired difference, gbrain minus fs, with its task-clustered 95% CI: `holdout_stats.py <cells-50k attempts> --hard-headline gbrain-hard,fs --simple fs`, with pg's attempts and `--simple fs,pg` when the pg batch ran), the decision sentence it triggers from the preregistration, the date, the gbrain commit and the models. Say whether the result is a recommendation or inconclusive.

## 2. The concrete case

One worked example per family, from the published held-out tasks, with what the agent has to find and why a simple setup misses it. Define "as of", effective date, correction, authority order and look-alike before using them.

## 3. The experiment and results

- Corpus, families, the 50k scale (amendment A2), multi-account questions (how many accounts each H2 to H5 question asks about), arms (what each does and why it is tested), models, judge, turn cap, tool limits, tasks and repeats, and which of the four 50k batches ran.
- Success by model and arm, models people use most first (Sonnet 5.5, Opus 5.5, GPT-6.1 Sol, Fable 5.1, GPT-6 Astra). Call out any model at ceiling: a model at 100% on every arm cannot show a difference.
- The primary endpoint and the simultaneous intervals against fs, and pg when its batch ran on every model; memory (two models) is reported per model; name any missing comparison.
- Per family and arm: success, tool calls per task, stops by kind (`turn_cap`, `no_tool_call`, `context_overflow`, `error`, `harness_error`) reported separately, unparseable set answers.
- A family-by-arm table saying which families favor which arm, and the weakest-family rule's outcome (a named family needs a CI excluding 0).
- Which kinds of growth the 50k world models (more accounts, more material per account, more look-alikes) and which it does not (answers that change as the company grows). No 4k held-out run exists (amendment A2), so there is no held-out scale comparison.
- The H5 write diagnostic per arm (saved, updated, kept stale, lost), reported, not scored.

Each headline comparison links to its family table, its receipts and representative transcripts.

## 4. What to use and what to avoid

Connect the evidence to workloads. Report losses, harness-error retries per arm and model, and any held-out bar misses (comparator above 80% or below 20%, oracle below 90%) beside the claims they qualify. Hard has no permissions family, so claims are limited to unrestricted information.

## 5. Cost and latency

Cost per task and per successful task; incremental cost per extra correct answer against the comparator (reported, no gate); agent latency without slot-restore time; setup cost (slot builds, pg embeddings) and end-to-end latency beside agent-only latency. Reconcile cell costs with the Hard ledger.

## 6. Reproduce and inspect

Repository-root commands, the gbrain commit and config, dataset identities (world digests and file hashes), required keys, output paths, observed time and cost, and links to raw results, receipts and transcripts. After the results, the 50k manifest and its 4k base world are committed, as for `model-ladder-v1-large`.

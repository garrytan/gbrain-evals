# Program primary, held-out: the shipped stack fails 5 of 576 end-to-end memory tasks where v0.60.106.0 fails 271 (`10x`)

## The finding

Shipped gbrain is master `0df9f2ee` (v0.60.174.0), which carries Candidate 1's newer mentions on `context_pack` cards and #6271's short-code aliases. On a custodian-sealed set of 32 personas minted on the maintainer's Mac, it fails **5 of 576** end-to-end memory tasks. The frozen release v0.60.106.0 (`7aa2caa0`) fails **271 of 576** on the same tasks, readers and repeats.

The pooled failure-risk ratio is **R = 0.020, 95% interval 0.006 to 0.045** (persona-clustered conditional binomial). That is a **49-fold** reduction whose interval's lower end is a 22-fold reduction. Under [amendment 5](2026-10-08-program-primary-hard-preregistration.md) the verdict is **`10x`**. The run is valid, and the resource envelope holds for every reader, so the preregistered claim applies:

> **gbrain makes 10x fewer end-to-end memory failures than v0.60.106.0** on cross-session meeting and reply preparation after a correction: a commitment, a dated change and a correction recorded earlier, and a later request that never names them.

| Reader | v0.60.106.0 failures | Stack failures | R (95%) | Factor | Verdict |
|---|---:|---:|---|---:|---|
| Opus 5.5 | 142/192 | 0/192 | 0.004 (0.000 to 0.026) | 285 | `10x` |
| Sonnet 5.5 | 124/192 | 5/192 | 0.044 (0.012 to 0.101) | 22.6 | `improvement` |
| gpt-6.1-sol | 5/192 | 0/192 | 0.091 (0.000 to 1.09) | 11 | `inconclusive` (near ceiling) |
| **Pooled** | **271/576** | **5/576** | **0.020 (0.006 to 0.045)** | **49.4** | **`10x`** |

Risk difference pooled: −46.2 points (−50.0 to −42.4).

**Read it with three caveats.**
- The pooled factor comes from Opus 5.5 and Sonnet 5.5. gpt-6.1-sol already got these tasks right on the frozen release (5 failures in 192), so it can neither show nor refute a tenfold gain.
- The primary scorer is `t0b-score-v2`, frozen before this run after the namesake diagnostic (gbrain-evals#124). Under the older `t0b-score-v1` on the same answers, the stack fails 13 of 576 and the frozen release 273: factor 20.3, R 0.049 (0.019 to 0.101), verdict `improvement`. The upper bound misses the `10x` line by 0.001. Every one of the 8 stack runs that v1 fails and v2 passes is a namesake flag. The diagnostic showed v1 counts those wrongly: a deliverable that says a namesake's item belongs to someone else.
- This is one workload. It is the program primary's frozen workload and not a general memory benchmark.

## Validity and the envelope

- **Scored:** 576 of 576 counted cells per arm, no harness error, and the rerank probe passed on every slot of every invocation.
- **Mutants:** on personas `sealed-01` to `sealed-08`, repeat 1, both mutants failed 24 of 24 for every reader. Stack baseline failures on those personas: 0, 1 and 0. Both mutants are detected by the frozen rule, and the stale-correction mutant raised `stale_correction` from 0 to 24 for every reader.
- **Envelope** (stack over frozen, limits 1.2x p95 session-2 latency, 1.5x mean tokens, 1.5x mean dollars):

| Reader | p95 session 2 | Mean input tokens | Mean $ per cell |
|---|---|---|---|
| Opus 5.5 | 32.5 s vs 37.9 s (0.86x) | 164k vs 179k (0.92x) | $0.274 vs $0.281 (0.97x) |
| Sonnet 5.5 | 27.2 s vs 26.2 s (1.04x) | 185k vs 148k (1.25x) | $0.178 vs $0.137 (1.30x) |
| gpt-6.1-sol | 32.2 s vs 40.1 s (0.80x) | 93k vs 97k (0.96x) | $0.077 vs $0.075 (1.04x) |

Sonnet 5.5 reads more on the stack (it opens the newer mentions the card shows it) and stays inside the limits.

## What failed

On v0.60.106.0, failures are mostly stale values: the deal page's old seat count or price (`stale_correction`: Opus 129, Sonnet 108, gpt 5) and the old meeting date (`stale_date`: Opus 71, Sonnet 51, gpt 1). Sonnet also missed a commitment 32 times. The correction and the move sit in a later call note and mail thread that name the customer by its short code, and the frozen release never put them in front of the reader.

The stack's 5 failures are all Sonnet 5.5:
- **Two real namesake mix-ups** (`sealed-03-t2`, both repeats). The data processing addendum owed to the namesake was listed among the contact's open items.
- **One namesake flag** that names both companies with a hedge outside `t0b-score-v2`'s cue list (`sealed-20-t2`): "…so Toby there is probably Tobin Varga, not your QUR Toby. Please check." The scorer's rule counts it as a failure, and it stays one.
- **Two missed commitments** (`sealed-25-t2`, `sealed-30-t2`).

## The experiment

- **Preregistration:** T0b preregistration amendment 5, written and merged (`e037572b`, `b275c57c`) before any version 2 world, sealed seed or stack build existed. Records were appended before sealed cells (`ac3097ec` onward on this branch).
- **Arms:** `frozen` gbrain `7aa2caa0` (v0.60.106.0). `stack` gbrain `0df9f2ee77ae7bf8ee004aa222fddc3cf568ec33` (v0.60.174.0, #6271's merge, which contains `f24ca6afe`'s short-code rule and Candidate 1 on by default).
- **World:** generator `program-primary-hard-v2` (unique short codes, `NAMESAKE_STRICT`), `V2_KNOBS`, 32 personas and 96 tasks. Commitment `c1c8a0ff…`, world digest `b113c68f…`.
- **Custody:** minted and rendered on the maintainer's Mac at gbrain-evals `7d03bcada`. The world crossed one Capy cloud machine (deleted there at once) to the custody VM `ubirun-gbra60-1791737888-050283c6`, where the digest was recomputed. The seed file never left the Mac. After the run, the world and the provider keys were deleted from the VM and the VM was destroyed. These 32 seeds are now spent and support no later held-out claim.
- **Protocol:** T0 delivery contract, `--surface starter`, 20 turns, `baseline` arm, repeats 1 and 2, readers Opus 5.5, Sonnet 5.5 and gpt-6.1-sol (re-checked as newest on run day; no Fable). Scorer `t0b-score-v2`, with `t0b-score-v1` reported beside it.
- **Gates:**
  1. $0 scripted smoke on both builds: passed.
  2. Paid development smoke on the stack (72/72 scored, 1 failure, $12.56): passed.
  3. Custody digest: matched.
  4. Rerank probe: passed on every slot.
- **Cost:** sealed ledger `t0b-program-primary-2026-10-11T17-26-01-752Z-9ca6d3c1`, **$232.01** of a $265 cap. The round's total is $370.12 of the approved $420: alias stack $111.46, Cat 41 $14.09, gate 2 $12.56, sealed $232.01.

## Records

`2026-10-08-program-primary-hard/sealed-confirmation/` contains:
- per arm: `experiment.json`, `receipt.json`, `cost-*.json`, `results.jsonl.gz` (every cell with its transcripts and scores) and `usage.jsonl.gz`;
- `paired.json` (`t0b-score-v2`) and `paired-v1.json`;
- `frozen-summary.json` and `stack-summary.json`, with failure classes, the envelope and mutant detection;
- the ledger status and close records;
- the driver logs;
- `gate2/`, the development smoke.

The world file is not included.

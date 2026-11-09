# Other runners: OpenAI cache-write repricing tool

`reprice.py` recomputes every OpenAI cost figure in the other-runners part of the
[cache-write audit](../../2026-11-09-openai-cache-writes.md#other-runners) from committed rows, receipts and ledgers. It
prices the cache writes that the runners missed, records the largest request behind each figure against OpenAI's
272,000-token long-context tier, writes `results.json` here and checks that each corrected document still carries the
corrected wording. It is the repricing half of the audit's working script; the ledger-agreement check stays out (see
below).

## Run it

From the repository root:

```sh
python3 docs/audit/2026-11-09-openai-cache-writes/other-runners/reprice.py
```

It needs `python3`, `git` and `bun`. It reads only files git tracks, eight of them at older commits through
`git show`, and exits if it reads an untracked file. It calls no provider and reads no key: the harness-ledger
figures come from `eval/runner/harness-ledger.ts`, which reads only the plan, its inputs and the committed acceptance
cells, run on plan copies in a temporary directory with every `*KEY*`, `*TOKEN*` and `*SECRET*` variable blanked.
The run takes a few seconds and prints one line: figure counts by status and how many documents match. It exits 1 if
any expected wording is missing, and lists each one. A rerun on the same tree writes a byte-identical `results.json`.

## Prices

USD per million tokens, OpenAI list prices ([pricing](https://developers.openai.com/api/docs/pricing), read
2026-11-09). Above 272,000 input tokens OpenAI prices the whole request at the long-context rates.

| Model | Input | Cached input | Cache write | Output | Above 272k: input / cached / cache write / output |
|---|---:|---:|---:|---:|---|
| `gpt-6.1-sol` | 2.00 | 0.10 | 2.50 | 10.00 | 4.00 / 0.20 / 5.00 / 15.00 |
| `gpt-6-sol` | 2.00 | 0.20 | 2.50 | 10.00 | 4.00 / 0.40 / 5.00 / 15.00 |
| `gpt-6-luna` | 0.10 | 0.01 | 0.125 | 0.50 | 0.20 / 0.02 / 0.25 / 0.75 |
| `gpt-6-astra` | 10.00 | 1.00 | 12.50 | 50.00 | 20.00 / 2.00 / 25.00 / 75.00 |

## Method

OpenAI reports almost every uncached prompt token of a request of 1,027 tokens or more as a cache write. A runner that
didn't read that count priced those tokens at the input rate, so the correction adds (cache write − input) × uncached
tokens / 1e6 for each such request. Where the rows give each request's size, the tool applies that rule per request.
Where only totals are committed, it gives an upper bound: every uncached input token priced as a cache write, which
is at most 25% of the uncached input cost, or a ratio taken from committed rows of the same reader.

For the long-context tier it records the largest request the data shows, or a bound on it:

- rows with per-request usage give the size directly;
- a trial or rollout total bounds any one request in it;
- for Codex runs above 272,000 input tokens in total, an append-only conversation means the last request is the
  largest and is at most total ÷ requests + new input; the request count is at least one more than the longest chain
  of tool calls that use text from an earlier call's result;
- the SkillOpt ceiling rollouts get the same bound per call, and the P4 harness compacts before 95% of its 32k window.

No figure in scope has a request above 272,000 tokens. Where the requests aren't committed (memory trust, facts
extraction, Q2, P5, expansion latency), `long_tier` says unknown, and the bounds assume no request above the tier.

## Output: results.json

Top level: `tool`, `command`, `rule`, `prices_usd_per_million`, `long_context_above_input_tokens`,
`cache_write_from_prompt_tokens`, `files_read` (a count), `files_read_at_older_commits`, `status_counts`,
`doc_check` (figures checked and figures matching) and `figures`, one per line. Each figure has:

| Field | Meaning |
|---|---|
| `id` | Short name |
| `doc` | Document or documents that publish it |
| `model` | OpenAI models in it |
| `figure` | What the figure is |
| `published` | The figure as published |
| `recomputed` | Corrected value, or how far low it is, or the bound |
| `status` | `MOVES`, `BOUND`, `ESTIMATE`, `NO MOVE`, `NO VISIBLE MOVE`, `NO FIGURE`, `NOTE` or `OUT OF SCOPE`, with a qualifier in brackets |
| `evidence` | Why, in one line |
| `max_request_input` | Largest request in input tokens, exact or an upper bound; `null` if not known |
| `max_request_basis` | Where that number comes from |
| `long_tier` | `below`, `priced by the ledger`, `unknown (…)` or `not applicable` |
| `ranking` | Whether a ranking, verdict or cap call changes |
| `detail` | Inputs behind the number |
| `doc_text` | Wording the document must carry, built from the recomputed numbers |
| `doc_match` | `true` if every `doc_text` string is in the document (whitespace normalized), `null` if none is listed |

## Left out: the ledger-agreement check

The audit's working script also compared budget-ledger totals with the runners' own records, to confirm the predicted
premium: on the six multi-source runs (`gbra156-scope-tools-list-starter` and `-scope` runs of 2026-10-24 at 17:57,
18:10 and 18:12 UTC), the SkillOpt method receipts (ledger runs `n15-skillopt-method-test-read-2026-11-02T03-04-45-593Z-f0a9f695`
and `n15-skillopt-method-frontier-probe-2026-11-02T00-00-46-604Z-1ae07142`), and the Sol entries of the SkillOpt
ceiling's calibration re-read (`n15-ceiling-calibration-2026-11-03T12-54-22-002Z-99f3820d`). The ledgers themselves
aren't committed; receipts carry only their totals, and the ceiling comparison reads the ledger's entries. So this tool
doesn't run it, and the audit page reports its result.

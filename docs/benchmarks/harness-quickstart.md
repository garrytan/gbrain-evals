# Run gbrain on the public agent-memory benchmark harness

This guide runs gbrain, and an extract-first memory server we call the comparator, on the [public agent-memory benchmark harness](../../eval/harness-provider/harness.lock.json). The harness hosts LongMemEval-S, LoCoMo10, PersonaMem, LifeBench, BEAM and PrecisionMemBench, and it answers each question by putting a memory system's retrieved context in front of an answer model, then judging the answer.

gbrain-evals pins the harness to one commit and wraps it in an audited cell runner. The wrapper fixes problems in the harness's own runner that would change results, and it meters every model call. A **cell** is one dataset slice, one memory system, one answer model, one delivered-context target and one budget. Its id is a hash of everything that can change the result, so a changed setting makes a new cell instead of overwriting an old one.

You need Linux or macOS, [Bun](https://bun.sh/) 1.4 or newer (check with `bun --version`; `bun upgrade` updates it), [uv](https://docs.astral.sh/uv/) and Git. The first install downloads about 2.3 GB of Python wheels into uv's cache and builds a 1.6 GB environment, so allow about 4.5 GB of disk with the clone.

## 1. Install

```sh
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install --frozen-lockfile
bun run harness:setup
```

`harness:setup` fetches the pinned harness commit into `.harness/src/`, installs it into `.harness/venv/<lock-hash>/` with CPU wheels, and downloads the one dataset file the harness can no longer fetch itself (LifeBench, pinned by sha256). It never reads a `.env` file.

## 2. Run the keyless plumbing check

```sh
bun run harness:cell run eval/harness-provider/cells/fixture-gbrain-rag.json --stub-upstream
```

This runs the real gbrain adapter end to end on a committed fixture of six short conversations and four questions. `--stub-upstream` sends every model and embedding request to a local stub that returns fixed answers, through the same metering proxy a paid run uses, against a throwaway ledger. It needs no key and spends nothing. It is a plumbing check, not benchmark evidence: the stub's answers are not real.

It prints a JSON line with `"ok": true`, which means the cell passed its gates: every scheduled question has a typed outcome, the delivered-context gate passed and gbrain's budget clamp did not fire. Expect `"accuracy": 0.0`: the stub answers every question with placeholder text. `spend.json` shows list-price dollars for the stub requests; they are recorded against the throwaway ledger inside the cell directory, and no provider is called.

The cell is written under `eval/reports/harness-cells/<cell-id>/`:

| File | What it holds |
|---|---|
| `cell.json` | The cell id, the resolved spec, pins, question schedule and cost estimate |
| `stages/ingest/<unit>.json` | Per memory unit: documents written, write path, completion barrier |
| `stages/retrieve/<question>.json` | Retrieved blocks and gbrain's delivery metadata |
| `stages/answer/<question>.json` | The final prompt, the exact context inserted into it, its cl100k token count and the byte-exact model request |
| `stages/judge/<question>.json` | The judge's typed outcome, score and requests |
| `summary.json` | Score over the fixed question schedule, delivered-context gate, clamp check, leak check |
| `spend.json` | Metered requests and dollars per process |
| `proxy/` | The metering proxy's request log and the byte-exact request bodies |
| `scorer/reverse-maps.json` | Opaque id to dataset id maps, read only by the scorer |
| `timestamp-manifest.json` | The date provenance of every document in the cell |
| `store/` | Each memory unit's gbrain brain (PGLite), kept so the cell can resume |

On a cold clone, the time from `git clone` to this first receipt is recorded in [the measurement table below](#measured-setup-time).

## 3. Plan a paid cell

A cell spec is a small JSON file. This one asks ten BEAM 100k questions of gbrain with an 8,000-token delivered-context target:

```json
{
  "dataset": "beam", "split": "100k", "provider": "gbrain", "mode": "rag", "lane": "raw", "seal": "dev",
  "target_tokens": 8000,
  "models": { "answer": "gemini:gemini-3.6-flash", "judge": "gemini:gemini-3.5-flash" },
  "budget_usd": 5,
  "questions": { "limit": 10 },
  "provider_config": { "token_budget": 7600 }
}
```

```sh
bun run harness:cell plan path/to/spec.json
```

`plan` loads the dataset, fixes the question schedule, computes the cell id and prints a cost estimate from token volumes and list prices. It makes no model call.

## 4. Run it

```sh
export GEMINI_API_KEY=... VOYAGE_API_KEY=...
bun run harness:cell run path/to/spec.json
```

Keys stay in the launcher. The harness process, the gbrain MCP child and the comparator server receive only per-process proxy tokens and base URLs, so a request that skipped the proxy would fail instead of spending. The proxy reserves each request's worst-case cost in the shared ledger (`.budget/ledger.sqlite`, see [the budget ledger](../budget-ledger.md)) before sending it, settles it from the provider's reported usage, and refuses once the cell's budget or the program cap would be crossed.

If a run stops, continue it:

```sh
bun run harness:cell resume <cell-id>
```

`resume` recomputes the cell id and refuses if any input changed (it names the changed fields). It continues only the questions without receipts and never re-runs a failed question. To change anything, plan a new cell.

## What the wrapper changes

- **Models.** The answer and judge models are set only through `OMB_ANSWER_LLM`/`OMB_ANSWER_MODEL` and the judge equivalents, from the cell spec. The harness default (a Groq model) cannot slip in, its ignored `--llm` flag is never used, and `.env` loading is off. BEAM forces its own judge in code; the cell must name it.
- **Scoring.** Every scheduled question counts in the denominator, failures are typed (answer, retrieval, judge, incomplete ingest), the judge's `correct` field must be a real boolean, an empty context still reaches the answer model and the judge, and every BEAM rubric item must be judged or the cell is incomplete. [SCORER.md](../../eval/harness-provider/SCORER.md) lists each difference from the harness's own scorer.
- **Identifiers.** Memory systems and models see only opaque ids. Gold answers, rubrics and the maps back to dataset ids stay with the scorer. Every answer prompt is checked for dataset ids, including LongMemEval's `answer_` session ids, before it is sent.
- **Dates.** Only observed session times reach memory systems. Dates the PersonaMem loader finds inside the conversation text are event dates and are withheld from both systems. [Per-dataset manifests](../../eval/harness-provider/timestamp-manifests/) record the counts.
- **Delivered context.** The context inserted into the final prompt (the provider's raw JSON when a dataset's prompt builder substitutes it) is counted with `cl100k_base`. Nothing is truncated; a cell passes its gate only when the mean and 95th percentile are within 10% of the target.
- **`agentic-rag`.** The harness's `agentic-rag` mode fails to construct at the pinned commit; the wrapper registers a fixed subclass.

## Free protocol smoke

```sh
bun eval/runner/harness-smoke.ts
```

Runs every dataset, mode and provider combination against the stub upstream (two questions each) and writes `eval/reports/harness-smoke/summary.json`. It downloads the public datasets on first use.

## Measured setup time

| Date | Machine | `git clone` to first fixture receipt | Notes |
|---|---|---|---|
| 2026-10-05 | Capy cloud VM, 4 vCPU AMD EPYC, 15 GiB, empty uv and Bun caches | 2 min 0 s (clone 13 s, `bun install` 5 s, `harness:setup` 60 s, fixture 42 s) | Bun upgraded from 1.3.14 to 1.4.2 beforehand (about 1 s, not counted); measured at gbrain-evals commit `d9409f7` |

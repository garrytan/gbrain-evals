# Cat 40 rerank-pool replay: does a 25-document rerank pool lose answers?

Status: tooling ready and dry-run keyless on 2026-10-12. The paid run has not happened. This page is the preregistration and the operator guide for the measurement; its results will go in a dated report beside it.

## The question

gbrain's `search` fuses keyword, vector and title matches into one candidate list, then a cross-encoder reranker (Voyage `rerank-2.5`) reorders the top of that list. How many candidates the reranker sees is set by the search mode: `tokenmax` sends 50 (`reranker_top_n_in`), `balanced` sends 25. The low-hanging-fruit plan (GBRA-81, item 1) makes `balanced` the default for new installs, so a company-scale search would rerank 25 candidates instead of 50. A relevant document sitting at fused rank 26 to 50 could then never be promoted into the rows an agent reads.

LongMemEval's haystacks are small, so they may understate this. The Cat 40 Hard world M is a fictional company of 55,838 documents (CRM records, contracts, amendments, email, meetings, tickets). In the 2026-10-10 Hard confirmation, agents using gbrain made 1,030 hybrid `search` calls on it. This replay sends every one of those calls, with its recorded arguments, to a fresh world M brain under both pool sizes and compares what comes back.

## The experiment

- **Calls:** every `search` call with `match` unset or `hybrid` from the `gbrain-hard` cells of `docs/benchmarks/2026-10-10-model-ladder-hard-confirmation/main-cells/transcripts.jsonl.gz`: 1,030 calls, 966 of them from tasks that name gold documents (H1 to H4; H5 tasks name none). Keyword-match calls (2,139) never reach the reranker and are not replayed.
- **Brain:** world M regenerated from seed 20261021 and the frozen knobs (byte-identical: file SHA-256 `99c53db0…`, digest `6f08629e…`), built into one slot by the Cat 40 slot builder with `text-embedding-3-large`, at the gbrain commit under test.
- **Arms:** `search.reranker.top_n_in` 50 and 25, with `search.mode` pinned to `tokenmax` in both (the mode init's picker chose for every Cat 40 slot), the semantic cache off, the reranker on, and the rerank timeout at 15 s in both arms so a slow provider answer is not counted as a pool effect. The runner reads `gbrain search modes --json` from each arm's brain and stops if anything other than `reranker_top_n_in` differs.
- **Path:** each call goes through `gbrain serve --surface starter` over stdio on a restored snapshot, as an untrusted remote caller, exactly as in the Cat 40 cells.
- **Same fused order:** the candidates each retrieval arm fetches do not depend on `top_n_in`, and the provider proxy caches query embeddings, so both arms rerank a prefix of one fused list. The runner checks this on every call from the SHA-256 of each document gbrain sends the reranker.

Per call and arm, `calls.ndjson` records the top 20 rows, which rows from fused ranks 26 to 50 entered the top 20, gold hit@5, the rerank status, requests and tokens.

### Metrics

- **Top-20 overlap:** the share of top-20 rows (chunk ids) the two arms share.
- **Pool rows 26 to 50 in the top 20:** among calls whose fused pool exceeded 25, the share where the 50-pool reranker promoted at least one row from fused ranks 26 to 50 into the top 20. These are rows a 25 pool cannot surface.
- **Gold hit@5:** 1 when any of the first 5 rows is one of the task's `gold.evidence` documents, else 0; only calls whose task names gold documents.

### Decision rule (preregistered)

The estimate is gold hit@5 under 25 minus under 50, paired over calls. The interval is a one-sided 95% lower bound from a paired bootstrap over calls (10,000 resamples, seed 1, mulberry32). The margin is -0.01 (1 point).

- **pass:** lower bound strictly above -0.01. The default flip may ship (with the LongMemEval comparisons also passing, plan item 1).
- **fail:** point estimate below -0.01.
- **inconclusive:** anything else. An inconclusive result does not ship as a default.
- **invalid:** any rerank failure, skip, pass-through or missing rerank request in either arm invalidates that arm; a call that fails in only one arm is a missing pair and invalidates the comparison; an arm stopped by its budget is incomplete. Calls whose operation fails identically in both arms are excluded and counted. An invalid run is repeated after a named repair.

## Reproduce

All commands run from the repository root with `bun install` done. Use Bun 1.4.2 or later.

1. **Regenerate world M** (free, about 40 s):

   ```bash
   W=eval/reports/cat40/hard-confirm/main
   bun eval/generators/model-ladder-gen.ts --mode hard --seed 20261021 --knobs docs/benchmarks/cat40-hard/knobs.frozen.json --out $W/base-4k
   bun eval/generators/model-ladder-gen.ts --mode hard --seed 20261021 --knobs docs/benchmarks/cat40-hard/knobs.frozen.json --scale large --base-world $W/base-4k/world.json --out $W/world
   ```

2. **Program ledger** (once; the GBRA-81 program cap Garry approved on 2026-10-12):

   ```bash
   bun eval/runner/budget-ledger.ts init --budget-ledger .budget/gbra81-lhf.sqlite --program-cap-usd 30 --reason "GBRA-81 low-hanging fruit, Garry approved 2026-10-12"
   ```

3. **Build one world M slot** (`OPENAI_API_KEY`; about $2.75 of embeddings, about one hour). `<sha>` is the gbrain commit under test, in a `../gbrain` checkout:

   ```bash
   bun eval/runner/cat40-model-ladder.ts --build-slots --world eval/reports/cat40/hard-confirm/main/world/world.json \
     --gbrain-repo ../gbrain --gbrain-ref <sha> --slots 1 --slot-build-allowance-usd 4 --budget-usd 4 \
     --budget-ledger .budget/gbra81-lhf.sqlite --out eval/reports/cat40/rerank-pool-replay/slots
   ```

   Do not add `--preflight` here: on a Hard world it checks the Cat 40 program roster, which this program's ledger is not part of.

4. **Replay** (`OPENAI_API_KEY` for query embeddings, `VOYAGE_API_KEY` for reranks; about $0.35 measured, at most $1; about one hour):

   ```bash
   bun eval/runner/cat40/rerank-pool-replay.ts --gbrain-repo ../gbrain --gbrain-ref <sha> \
     --budget-usd 1 --budget-ledger .budget/gbra81-lhf.sqlite --out eval/reports/cat40/rerank-pool-replay/run
   ```

   The runner opens and closes its own budget run. Each provider request is reserved in the ledger before it is sent, and a refused reservation stops the replay before the cap is exceeded (the arm is then incomplete and the verdict invalid). It writes `calls.ndjson`, `summary.json`, `summary.md` and a receipt.

`--estimate-only` prints the cost estimate without a slot or a ledger. `--no-reuse` sends every 25-document rerank to the provider (see below).

### Cost

| Item | Basis | Estimate |
|---|---|---|
| Slot build | measured on this world at gbrain `3e4ff61` (55,859 embedding requests) | $2.74 |
| Replay, 50 pool | 1,030 calls x 1 rerank request x about 6,200 tokens (keyless dry run on a 3,000-document fixture, 4 characters per token), $0.05 per million | $0.32 |
| Replay, 25 pool | 20 audited requests; the rest reused (below); $0.16 more with `--no-reuse` | under $0.01 |
| Query embeddings | about 16,600 tokens at $0.13 per million | under $0.01 |
| **Total** | | **about $3.10** |

`--estimate-only` prints a deliberately higher figure ($0.60 replay, $1.75 worst case) because it prices every reranked document at the corpus mean length; the documents gbrain actually reranks in the dry run are about half that.

### The rerank reuse

A cross-encoder scores each query-document pair on its own, so when a 25-document request carries exactly the first 25 documents of an already answered 50-document request for the same query and model, the answer can be read from the 50-document response. The proxy does this only after checking the prefix, and it sends the first 20 such requests to the provider as well and compares the orders; one disagreement turns reuse off for the rest of the run and is recorded in the receipt (`reuse.audits`, `reuse.disabled_reason`). Reused answers bill no tokens and are marked per call.

## Keyless dry run (2026-10-12)

`--upstream stub` runs the same pipeline with stub providers: hashed bag-of-words embeddings and a lexical-overlap reranker, or a reranker that answers HTTP 500. Provider keys are removed from the process and nothing leaves the machine. `--fixture-docs N` builds a brain from a subset of world M (every gold document of the replayed calls' tasks plus a seeded sample). These numbers test the harness, not search quality.

At gbrain `e62f72c4` (the wave's lane A branch), fixture of 3,000 documents, all 1,030 calls, stub reranker: both arms valid, 0 missing pairs, the 25 pool was the first 25 of the 50 pool on 1,030 of 1,030 calls, every reranked document mapped to a chunk, every call made exactly one rerank request, 20 reuse audits agreed and 1,010 reranks were reused. The ledger run recorded $0.

With `--stub-rerank fail-arm-25` on 40 calls, arm 25 recorded 40 failed reranks, was marked invalid, and the verdict was `invalid` while arm 50 stayed valid.

Unit tests: `bun test test/eval/cat40-rerank-pool-replay.test.ts` (extraction, result parsing, rerank status, metrics, bootstrap boundaries, gate boundaries, validity rules, the proxy's cache, audited reuse and failure fixture).

## Limits

- The brain is the clean world M. During the recorded cells, agents also saved notes with `remember`, and later H5 sessions searched a brain holding them. 62 of the 1,030 calls come from sessions 2 to 5; their pools can differ from what the agent saw. The two arms are equally affected.
- Gold hit@5 counts any gold document in the first 5 rows. H1 tasks have 16 to 50 gold documents each, so their hit rate is easier to reach than H2 to H4's 4 to 20.
- The replay measures retrieval, not answers: an agent may recover a missed document with a second search.

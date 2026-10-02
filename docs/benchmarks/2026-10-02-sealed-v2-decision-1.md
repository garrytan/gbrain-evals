# Whole-conversation evidence on held-out data: the sealed v2 release check passes

**Finding, 2026-10-02.** On the sealed confirmation set v2, gbrain's shipped evidence default, `auto`, answered **192 of 200** questions. The old `chunk` default answered **132 of 200**, at the same gbrain commit, from the same five retrieved hits and with the same reader and judge. `auto` won 60 questions and lost none. The gain is +30.0 percentage points, with a 95% persona-cluster interval of +24.0 to +36.0. **Under the preregistered rule, the release check is `pass` (non-inferior) and superiority is confirmed:** exact McNemar p = 1.7e-18, and the persona-clustered sign-flip p is below 0.0001. This is the first held-out confirmation that whole-conversation delivery helps. The first sealed set could not show it, because chunks already scored 98% there.

The cost is reader input. `auto` sent a mean of 12,982 input tokens per question, about four times the 3,280 that `chunk` sent.

Tested configuration: gbrain `d44296cf4d6481a10eb85562d3179e38cfd02c43` (master, v0.60.30.0); `auto` at its default 24,000-token conversation budget; reader `claude-sonnet-4-6` at temperature 0 with LongMemEval's reading prompt; judge `gpt-4o-2024-08-06` with LongMemEval's per-kind prompts. The rule was committed before the sealed files reached the machine ([preregistration](2026-10-02-sealed-v2-decision-1-preregistration.md), commit `d0efb58`).

## The concrete case

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. A search ranks short passages, called chunks (about 300 words), and then decides how much text to hand back for each hit. That second step is evidence delivery. `chunk` returns the five ranked passages. `auto` returns the whole conversation for each hit that sits in a conversation, within a shared 24,000-token budget, and leaves other hits as passages.

**Invented example, not from the set:** over ten months a fictional user mentions four separate purchases for a hobby, each in a different chat, alongside a friend's similar purchase. The user then asks for the total. Search can find all four chats. But the passage it ranks highest in each chat may be the friend's purchase or the small talk around it, not the sentence with the price. With whole chats, the reader sees every price in context.

[Sealed confirmation set v2](2026-10-01-sealed-confirmation-v2-protocol.md) is 200 questions written for 40 invented personas whose histories nobody has tuned against. Each history holds 46 chats and about 143,000 tokens. There are 80 multi-session questions needing three or four chats, 40 temporal questions needing two or three, 40 knowledge-update questions needing three or four, and 40 abstention questions, where the correct answer is that the detail was never mentioned.

## The experiment and results

Both arms read evidence built from one frozen retrieval per question: hybrid search, top five, balanced mode, `voyage:rerank-2.5` reranking, no autocut, no query expansion. Only the delivered text differs. The reader saw each delivered block as one dated pseudo-session, the same shape the v2 solvability chunk oracle used.

### Answer accuracy, judged correct (paired)

| Question kind | n | `chunk` | `auto` | `auto` won | `auto` lost |
|---|---:|---:|---:|---:|---:|
| Multi-session | 80 | 33 | 76 | 43 | 0 |
| Temporal reasoning | 40 | 21 | 36 | 15 | 0 |
| Knowledge update | 40 | 38 | 40 | 2 | 0 |
| Abstention | 40 | 40 | 40 | 0 | 0 |
| **All (primary)** | **200** | **132 (66.0%)** | **192 (96.0%)** | **60** | **0** |
| Answerable only | 160 | 92 (57.5%) | 152 (95.0%) | 60 | 0 |

### The preregistered decision

| Test | Result |
|---|---|
| `auto − chunk`, all 200 questions, 40 persona clusters | +30.0 points, 95% cluster-bootstrap interval +24.0 to +36.0 |
| Non-inferiority (margin 3 points, one-sided alpha 0.05) | **pass**: bootstrap p = 0.00005, the smallest value 20,000 draws can give |
| Superiority (tested after non-inferiority passed) | **confirmed**: +60 / −0, exact McNemar p = 1.7e-18; persona sign-flip p = 0.00005, the Monte Carlo floor at 20,000 draws |
| Reader errors, empty answers, truncated answers | 0, 0 and 0 in each arm |

Receipts: [`decision-outcome.json`](2026-10-02-sealed-v2-decision-1/results/decision-outcome.json) (the rule applied by `sealed-confirmation.ts decide`), [`compare.json`](2026-10-02-sealed-v2-decision-1/results/compare.json) (the `compare.ts` output under the committed family) and [`summary.json`](2026-10-02-sealed-v2-decision-1/results/summary.json) (every aggregate in this report).

### Exploratory breakdowns (decide nothing)

These intervals come from `compare.ts` run ad hoc on subsets, clustered by persona, with no multiplicity correction.

| Subset | n | `auto − chunk` | 95% interval | McNemar p |
|---|---:|---:|---|---:|
| Answerable only | 160 | +37.5 points | +30.0 to +45.0 | 1.7e-18 |
| Multi-session | 80 | +53.8 points | +42.5 to +65.0 | 2.3e-13 |
| Temporal reasoning | 40 | +37.5 points | +22.5 to +52.5 | 6.1e-5 |
| Knowledge update | 40 | +5.0 points | 0.0 to +12.5 | 0.50 |

**Retrieval was not the bottleneck.** The shared top five held every gold chat (`recall_all@5`) for 153 of 160 answerable questions and at least one gold chat (`recall_any@5`) for 160 of 160. On those 153 questions, `chunk` answered 92 and `auto` answered 152. On the 7 where search missed a gold chat, both arms answered 0. Every one of the 60 wins came from questions where the right chats were already retrieved. The five passages just did not carry all the evidence, and the whole chats did.

**What `auto` delivered.** All 976 delivered blocks were whole conversation pages. None was truncated, and none fell back to a passage for lack of budget. The 976 blocks cover 200 questions × 5 hits, with hits from the same chat merged into one page. The applied budget read back from gbrain was 24,000 tokens on all 200 questions. Delivered evidence averaged 11,526 tokens by gbrain's count (maximum 13,992), so these hit lists used at most 58% of the budget.

| Reader input (provider-reported tokens) | Mean | Median | Max |
|---|---:|---:|---:|
| `chunk` | 3,280 | 3,277 | 3,736 |
| `auto` | 12,982 | 13,134 | 16,121 |

**Abstention did not get worse.** Whole chats carry more near misses than five passages, which could tempt a reader to invent the asked detail. Both arms answered all 40 abstention questions correctly.

## What to use and what to avoid

- **Keep `auto` as gbrain's default.** This is the preregistered outcome "pass, superiority confirmed". The development-data gain on LongMemEval-S ([auto v2 check](2026-09-30-evidence-auto-v2.md), 445 against 312 of 500) now has a held-out confirmation, on histories written by a different model family and opened once.
- **Expect the gain where an answer needs several facts from one chat or from several chats.** Multi-session and temporal questions gained 38 to 54 points. Knowledge-update questions, where the latest value usually sits in one passage, gained 2 questions out of 40, which is not significant.
- **Budget for about four times the reader input.** If tokens matter more than accuracy, `chunk` remains available. On this set it gave up 60 of 200 answers.
- **Limits.** The histories are synthetic, written by `gpt-6-luna` from `gpt-6-sol` plans. Reading is near ceiling: the protocol's oracle with every gold chat scored 199 of 200, and its chunk oracle, handed the right passages, scored 196. So the set measures whether delivery gets the needed text to the reader, not harder reasoning. One reader and one judge were tested, both at temperature 0. The judge is an OpenAI model, as are the set's writers. The result covers this commit and budget only. Per the protocol, it does not license choosing another budget or unit on this set.

## Reproduce and inspect

Commands, flags and the rule are in the [preregistration](2026-10-02-sealed-v2-decision-1-preregistration.md#commands-repository-root), unchanged. The sealed files are private and kept by the owner, so an outside reader can rerun the pipeline but not this exact measurement. The `--smoke` flag runs the same steps on an invented fixture in the sealed schema.

| Identity | Value |
|---|---|
| gbrain-evals | branch `capy/sealed-v2-decision-1`, preregistration commit `d0efb58`, runner `eval/runner/sealed-confirmation.ts` |
| gbrain | `d44296cf4d6481a10eb85562d3179e38cfd02c43` (v0.60.30.0) from a clean checkout. The installed `node_modules/gbrain` is the same commit and is pinned in `package.json`. |
| Decision file | [`decision.json`](2026-10-02-sealed-v2-decision-1/decision.json), SHA-256 `23dae4c1…`, recorded in the frozen evidence and every answer file |
| Frozen evidence | 200 questions, manifest SHA-256 `3a1b52cd…` (deleted with the sealed files) |
| Sealed files | verified against the manifest before use: questions `8d29e92d…`, labels `83bf52d1…`, ledger `03df09aa…` (not read) |
| Keys | `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY` |

**Cost: $16.06** against the $60 cap, for 10,600 paid requests, all reconciled from provider-reported usage ([ledger summary](2026-10-02-sealed-v2-decision-1/results/ledger-summary.json)). The estimate was about $20.

| Step | Cost |
|---|---:|
| Retrieval freeze: embeddings and reranks | $3.71 |
| `chunk` reader, 200 calls | $3.05 |
| `auto` reader, 200 calls | $8.85 |
| Judge, 2 × 200 calls | $0.47 |
| **Total** | **$16.06** |

The setup runs on invented fixtures before the preregistration cost about $0.22 more, outside the cap. Wall time was 23 minutes for the freeze (four shards in parallel), 4 minutes per reader arm and about 1 minute per judge pass.

## Deviations and notes

- **The freeze cost twice the estimate.** The estimate assumed the five questions on a history would share its embeddings. They did not: gbrain's LongMemEval adapter writes a question-specific session id into each page, so every question re-embedded its history (about 8 million embedding tokens per shard). No setting or result changed.
- **One launch that never started.** The chunk and auto reader arms were launched together from one shell command. Because of an operator scripting error, the auto half ran with empty path variables, so its output redirect failed before any process started. It made no request and wrote no file. The auto arm was then run once, by itself, about a minute after the chunk arm finished. Each arm was answered exactly once.
- **No interruption, no resume.** No request failed or was retried in any step: all 800 reader and judge requests settled from reported usage on the first attempt, and the freeze had no errors. No resume pass was needed. A report of a rate-limit stop was checked against the access log, the answer files and both spend ledgers, and none had occurred.
- **Two label reads, as preregistered.** The access log went from 1 line to 3. One line was added when the `chunk` answers were scored and one when the `auto` answers were scored, both under decision id `sealed-v2-decision-1-2026-10-02:auto-vs-chunk` ([`summary.json`](2026-10-02-sealed-v2-decision-1/results/summary.json), `access_log`). This is release decision 1 of the 3 the protocol allows.

## Custody of the sealed set

The owner's agent copied the questions, labels, ledger and access log to the Capy machine after preregistration commit `d0efb58` was on origin. The three files matched their manifest commitments. Labels were opened only through `sealed-confirmation.ts score`, which checked the commitment and appended an access-log line before parsing. The access log (3 lines, SHA-256 `024d3a22…`) and the two per-question score files (`25a5828a…` for chunk, `7080bc8d…` for auto) were staged for the owner's private custody. Per question, the score files hold the opaque question and persona ids, the question kind, the two recall flags and the correct-or-incorrect verdict, with no question text, chats or answers. After that, every file under the private directory was overwritten with `shred` and the directory was removed. That covered the sealed files, the frozen evidence with chat text, the four embedding caches, the answers, the reader and judge response caches, the spend ledgers and the logs. A search of the machine for files written after the sealed files arrived found no other copy. Only the aggregates above are published.

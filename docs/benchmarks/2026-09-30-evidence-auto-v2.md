# Auto evidence delivery as gbrain's default: the sealed release check does not pass

**Finding, 2026-09-30.** gbrain's new default, `auto` v2, returns whole conversation pages for conversation hits within a 16,000-token budget and leaves every other hit's chunk unchanged. On the independent sealed confirmation set it answered **149 of 150** questions against **147 of 150** for the old chunk default (+2 / −0, exact McNemar p = 0.50). Chunks were already at 98%, so the set could not show a gain. **Decision-manifest verdict: E2 `fail`** by the preregistered rule, which required a significant gain. That means no demonstrated benefit on held-out data, and no demonstrated harm either.

On LongMemEval-S, which is now development data, `auto` beat chunks by a wide margin: 445 against 312 of 500 (+145 / −12, p = 4e-30). It missed the sanity bar of page − 2% (447) by two questions. Two thirds of that shortfall is reader noise on byte-identical requests; the rest is the 16,000-token budget cutting long five-session hit lists.

The gbrain code is `e9b580c5b9f9ac2e6ad069ea45ee5a6ac52c5761` (branch `capy/evidence-page-code-fix`, v0.60.16.0). It was pinned in [decision manifest v2](2026-09-30-evidence-auto-v2/decision-manifest.json), which was committed before any paid call (`4947b41`), with the pin in its own commit (`592e347`). This follows the [evidence-delivery study](2026-09-30-evidence-delivery.md), whose verdict was `page_only`.

## What changed and why it was tested again

The first study found that whole pages beat chunks on conversation questions (361 against 253 of 400) and that cheaper neighbor windows closed only about a third of the gap. gbrain then made the choice automatic instead of a setting:

- A hit whose page type is a conversation type (`conversation`, `transcript`, `chat`, `meeting`, Slack or iMessage types), or whose slug starts with `chat/` or `conversations/`, gets its whole page. Conversation pages share a 16,000-token default budget; remote callers get 32,000.
- Every other hit keeps its ranked chunk byte for byte.
- When no hit is a conversation, the stage is skipped and the response equals the chunk response.

The question before shipping it as the release default: does `auto` at the product budget keep page's gain on conversation questions?

## The experiment

Everything was frozen once at the pinned commit with the first study's retrieval settings: reranker `voyage:rerank-2.5` on, top five, balanced mode, no autocut, no query expansion, and a 30 s rerank timeout. The reader was the same house notes reader (`anthropic:claude-sonnet-4-6`, R1's system text, 1,024 output tokens, provider-default temperature, one `<chat_session>` block per delivered block). Both judges were the same, with gbrain's framed judge primary.

- **`chunk`**: the five ranked chunks (the pre-0.60.16 default).
- **`auto`**: the product default. No budget is passed; the applied budget read back from gbrain was 16,000 on every question in both sets.
- **`page`**: the whole page of each hit, as a LongMemEval reference only.

Before any model call, the harness page request reproduced R1's logged request bytes on all 409 LongMemEval questions whose top five matched R1's. The product `page` text equalled the harness page text without its metadata header on all 2,451 blocks. The fenced-code case the first study reported is fixed.

### Decision: the sealed confirmation set (E2)

The [sealed set](2026-09-29-sealed-confirmation-protocol.md) is 150 questions over 30 separately written synthetic personas that no gbrain setting was tuned on. It was run through the [E2 bridge](../../eval/runner/evidence-delivery/e2-bridge.ts), so the reader request matched the LongMemEval arms exactly and only the evidence differed. This was the set's first release decision (decision id `evidence-auto-v2-2026-09-30:e2:auto`).

| Question kind | n | chunk | auto | chunk (official judge) | auto (official judge) |
|---|---|---|---|---|---|
| multi-session | 30 | 28 | 29 | 28 | 29 |
| temporal-reasoning | 30 | 29 | 30 | 28 | 30 |
| single-session-user | 30 | 30 | 30 | 30 | 30 |
| knowledge-update | 30 | 30 | 30 | 30 | 30 |
| abstention | 30 | 30 | 30 | 30 | 30 |
| **Total** | **150** | **147** | **149** | **146** | **149** |

- **Paired result:** auto won 2 questions and lost none. Exact McNemar p = 0.50; the persona-clustered sign-flip p = 0.49, with a 95% interval for the per-question gain of 0 to 0.033.
- **Rule:** pass needed a positive difference with both p-values below 0.05 and the official judge agreeing. The primary test failed, so the outcome is `fail`. There were no reader errors and no missing questions.
- **Tokens:** mean provider-reported reader input was 3,107 for chunk and 4,986 for auto.

Why it could not pass: the sealed chats are short (about 1,200 tokens each), so five chunks already carry most of the answer, and chunks scored 98%. With three chunk misses in total, no delivery policy could reach p < 0.05; that takes at least six one-sided wins. The [power analysis](2026-09-30-evidence-auto-v2/power-analysis.json) assumed chunk accuracy between 0.6 and 0.9 and did not anticipate this ceiling. The sealed set as it stands can reject a harmful delivery change, but it cannot confirm a helpful one.

### Sanity check: LongMemEval-S (development data, 500 questions)

| Arm | Correct (gbrain judge) | Official judge | Mean reader input tokens |
|---|---|---|---|
| chunk | 312 | 314 | 3,517 |
| auto | 445 | 443 | 15,125 |
| page | 457 | 458 | 15,327 |

- **auto against chunk:** +145 / −12, p = 4e-30.
- **auto against page:** +7 / −19, p = 0.03. The preregistered bar was `auto >= page - 10 = 447`, so **the sanity check fails by two questions.**

Why, from the frozen evidence and the request hashes:

| Questions | n | auto | page | auto-only correct | page-only correct |
|---|---|---|---|---|---|
| auto's request byte-identical to page's | 419 | 377 | 385 | 6 | 14 |
| auto cut by the 16,000-token budget | 81 | 68 | 72 | 1 | 5 |

- **Identical requests (419 questions).** On these, every difference is the same reader answering the same bytes differently at provider-default temperature: 20 of 419 flipped, about the 5% noise the first study measured. That accounts for 8 of the 12-question shortfall.
- **Cut by the budget (81 questions).** On these, `auto` delivered partial pages because the five sessions exceeded 16,000 tokens: 85 of 2,451 blocks were truncated, and no hit fell back to chunks. Mean input was 17,800 tokens against 19,100 for page. The measurable cost of the budget is about 4 questions of 500 (0.8%).
- **Delivery.** All 2,451 hits were detected as conversations through the `chat/` slug, and none fell back.
- **By type (auto / page / chunk):** multi-session 105 / 109 / 64, temporal 117 / 121 / 68, knowledge-update 72 / 76 / 59, single-session-user 68 / 69 / 51, single-session-assistant 56 / 56 / 50, preference 27 / 26 / 20.

## What this means for the release

- The preregistered decision does not support flipping the release default to `auto` on held-out evidence. The sealed set neither confirmed nor contradicted a benefit, because its chunk baseline is at ceiling.
- On development data, `auto` keeps essentially all of page's gain over chunks (+133 of page's +145 questions) at page's token cost. The budget costs about 1%.
- Shipping `auto` as the default anyway would be a judgment call on development evidence, not a result of this preregistered check. Per the sealed protocol, the set may not be re-run with another setting to get a different answer. A future confirmation needs a harder held-out set, with longer chats or chunk accuracy well below ceiling, preregistered before it is opened.

## Custody of the sealed set

The owner's agent transferred the questions, labels and access log to the Capy machine, with a custody note. They were never copied to a VM. The labels were opened once, through the sealed runner, which checked the commitment (`4990a7e2…`), required the decision id and appended an access-log line before parsing. The log went from 2 to 3 lines ([the new line](2026-09-30-evidence-auto-v2/results/e2-access-log-line.json)). Only the aggregates above are published. All of the following were deleted from the machine after scoring: the questions, labels, access log, sealed freeze (including chat text), its embedding cache, the private answers and judgments, and the judge cache.

## Deviations and notes

- **Machine restart.** The Capy machine restarted during the LongMemEval freeze. On the first resume, the watchdog killed each process at once because files from before the restart looked stale. The watchdog now measures staleness from each attempt's start (`e775489`). Freezes resume per question, so no question was lost or double-counted, and no reader call had started.
- **Power analysis.** It covered chunk accuracy from 0.6 to 0.9 and so did not anticipate the observed ceiling of 0.98.
- **Typecheck.** `bun run typecheck` reports one error inside `node_modules/gbrain` (an Anthropic SDK type) that already exists on the base branch.

## Reproduce and inspect

- Runner: `eval/runner/evidence-auto-v2.ts`. Rule code: `eval/runner/evidence-delivery/decision-v2.ts`. Pipeline: [`scripts/pipeline-lme.sh`](2026-09-30-evidence-auto-v2/scripts/pipeline-lme.sh). All of it ran on the Capy machine in one campaign ledger run.
- **Cost: $73.92** (cap $150, program cap $1,000): Sonnet reader $60.48, embeddings $9.12, both judges $3.44, Voyage $0.87 ([ledger summary](2026-09-30-evidence-auto-v2/results/ledger-summary.json)).
- LongMemEval receipts under [`results/lme/`](2026-09-30-evidence-auto-v2/results/lme/): per-question rows for all three arms, the [sanity analysis](2026-09-30-evidence-auto-v2/results/lme/sanity.json) and its [decomposition](2026-09-30-evidence-auto-v2/results/lme/sanity-decomposition.json), the frozen manifest hashes, the header and the parity report.
- Sealed receipt: [e2-decision.json](2026-09-30-evidence-auto-v2/results/e2-decision.json), which holds aggregates only.

```bash
export GBRAIN_DIR=<gbrain checkout at e9b580c5>
bun eval/runner/evidence-auto-v2.ts analyze --rows-dir <rows> --frozen-dir <frozen>
```

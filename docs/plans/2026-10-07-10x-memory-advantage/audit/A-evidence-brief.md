# Audit A: evidence brief and token budget (bet 1)

Auditor: GBRA-60 subagent A, 2026-10-07. Read-only. Pins read: gbrain master `7aa2caa0` (v0.60.106.0), gbrain-evals main `f1ce49fe` (v0.10.40). In-flight branches were read through `gh` only (no fetch, no checkout). No paid call was made. Three small `$0` recomputations from committed receipts are marked **[A-calc]**; they are exploratory, not preregistered.

Token units differ by a factor of about 1.6 and every number below names its unit:
- **Claude tokens**: provider-reported input for Sonnet/Opus 5.5.
- **GPT tokens**: provider-reported input for `gpt-6.1-sol`.
- **cl100k**: gbrain's own count (`src/core/chunkers/token-estimate.ts`).
- **chars/4**: `estimateTokens` (`src/core/search/token-budget.ts:44-48`) or gbrain-evals `approxTokens` (`eval/runner/memory-qa/qa.ts:40`).

## 0. Bottom line

1. **The headline rests on the wrong 22k.** The 22k is Claude tokens. The same request text is 13,695 GPT tokens (W10b, `2026-10-07-longmemeval-w10b-reader-replay.md`: "Mean input tokens: 22,077 for the Claude readers and 13,695 for `gpt-6.1-sol` on the same text"), and gbrain's own cl100k count of whole-page delivery is 13,800 (`2026-09-30-evidence-delivery.md`, "Three token counts"). Mem0's self-reported figure is 6,787 tokens per retrieval call on LongMemEval at top_200, tokenizer unstated (Mem0 docs, `docs.mem0.ai/core-concepts/memory-evaluation`, fetched 2026-10-07; not in `comparison-systems.md`). On matched units gbrain is about 2x Mem0, not 3x.
2. **Every deterministic shrink measured so far lost.** These are lexical excerpts, neighbor windows, sections and more chunks at the same budget (section 2.3). The only presentations that kept accuracy were the intact sessions and the reader's own notes written from intact sessions. So a brief has to be **written by a model that reads the intact evidence**, with verbatim quotes for decisive values.
3. **Selecting perfectly still doesn't get to 2k.** [A-calc] Over W10a's 500 captured requests, the gold sessions alone average 6,489 chars/4 tokens, against 15,822 for everything delivered. Multi-session questions need 8,981. So 2k means compressing *inside* the gold sessions about 3x, and about 4.5x on multi-session. That is exactly where the excerpt selector dropped a $150 sale.
4. **The reader already compresses well.** A frontier reader's own visible notes plus answer run 138 (Sonnet 5.5) to 150 (Opus 5.5) chars/4 tokens on average, p95 326-356 [A-calc]. A 2k brief is plausible if a cheap builder writes question-conditioned notes that the frontier reader then trusts.
5. **The brief cuts frontier-reader tokens about 7-10x, but total cost only about 4x.** A brief at 2k built by `gpt-6-luna` cuts reader cost about 4x at list prices: Sonnet 5.5 $0.046 → about $0.012 per question, Opus 5.5 $0.094 → about $0.023 (section 6.4). Total model tokens processed do **not** fall, because the builder reads everything. The headline must count builder tokens separately and say so.
6. **Brief and breadth together are the real opening.** A brief over top-10 or top-20 sessions at 7k could close the measured multi-session gap: whole history 34/36 against gbrain 29/36 on Sonnet 5.5 (W10c). That gives "more evidence in fewer tokens", which helps on BEAM-1M and LongMemEval-M, where the history does not fit.
7. **Sealed LoCoMo cannot carry this decision.** Its 7 conversations have been opened four times: P2 E2, P3 E1, P6, and the OSS shootout Phase 7. The split file calls it "diagnostic evidence, never a primary confirmation", and LoCoMo is public. Sealed-confirmation v2 has 2 of 3 openings left, with a disclosed P8 session exposure, and is the right held-out set. LongMemEval-S/M are development data.
8. **Token accounting is broken in two harness lanes.** Fix this first, at no cost:
   - The LongMemEval harness drops provider usage (`reader.ts:179-184`).
   - The gbrain-evals `think` lane records only the question's tokens (`memory-qa/run.ts:381`). The P6 dev verdict shows `qa_input_tokens` of 23.2 (LongMemEval-S) and 15 (LoCoMo), the question length.

---

## 1. What exists today

### 1.1 LongMemEval harness reader (`gbrain eval longmemeval`)

| Item | Location | Behaviour |
|---|---|---|
| Top-k | `src/commands/eval-longmemeval.ts:283-286`, default `topK: 8` at `:400` | K chunk rows. The release config used in W10a is `--top-k 5 --no-trajectory --mode balanced --reranker on --autocut off` (W10a report). |
| Chunk → whole conversation | `src/eval/longmemeval/reader.ts:157-170` (`generateAnswer`) | Dedups hits by slug in rank order. Each distinct slug's **whole page body** (`pageMeta` from the haystack import at `eval-longmemeval.ts:1391-1406`) becomes one session; chunk text is only a fallback (`:168`). There is no token budget, only a per-session cap. |
| Per-session cap | `reader.ts:45` `READER_MAX_SESSION_CHARS = 60_000`; `sanitize.ts:30` default 4,000 (extractor era) | The 4,000 default "silently cut the answer out of most retrieved sessions" (`reader.ts:37-44`). |
| Rendering | `src/eval/longmemeval/sanitize.ts:80-94` `renderChatBlock` | `<chat_session id date>` blocks, `INJECTION_PATTERNS` strip, close-tag escape. |
| Prompts | `reader.ts:49-57` direct (`gbrain-lme-reader-v3-abstention-fullsessions`); `:62-66` notes (`gbrain-lme-reader-v4-notes-fullsessions`) | Abstention instruction ("The information is not available in the retrieved sessions; I don't know."). Notes = "First extract all the relevant information, then reason…". |
| User text | `reader.ts:115-121` | Question → `Current Date:` → optional `Known trajectory:` → `Retrieved sessions:`. |
| Output limits | `reader.ts:36` 512 (direct); `:80` notes default 1024; `--reader-mode`, `--reader-max-tokens` (`eval-longmemeval.ts:240-242`) | A `max_tokens` finish is a row error (`eval-longmemeval.ts:1462-1465`). |
| Token counting | `reader.ts:183` records `context_chars`, `context_sessions`, `sessions_truncated` only | `gateway-client.ts:49` returns `usage`, but `generateAnswer` discards it. Rows carry `reader_context_chars` (`eval-longmemeval.ts:1477`) and no provider tokens. |
| Experimental excerpt packet | `src/eval/longmemeval/evidence-packet.ts:74-177`, `PACKET_VERSION='experimental-original-rounds-v1'` | Lexical round selection with qualification regex (`:42`), adjacent rounds, pointers with SHA-256, budget fallback to full sessions, `preprocessing_cost_usd: 0`. Driven by `scripts/eval-answer-packet.ts`. **The negative result in 2.3 is this code.** |
| Other arms | `retrieval-arms.ts` (fact keys `--fact-keys`, time scope), `synopsis-tier.ts` (tokenmax per-chunk synopses, `--synopsis-max-usd` default 20) | Retrieval-side only; they never change the reader input shape. |

### 1.2 `gbrain think` (production answerer)

- **Gather.** `src/core/think/gather.ts:120-240` runs hybrid pages, takes keyword, takes vector, graph (anchor only) and anchor hydration in parallel, with `gatherLimit` 40 (`:124`) and `takesLimit` 30 (`:125`). Autocut and adaptive return are disabled on purpose (`:156-160`). `window` (since/until) widens the search to `min(gatherLimit*4, 200)` and adds a date-floor `listPages(limit 50)`.
- **Page rendering.**
  - Non-delivered pages get query-centred excerpts. The budget is `PAGES_BLOCK_TOTAL_BUDGET_CHARS = 12_000` with a 2,400-char per-page ceiling and a 600 floor (`gather.ts:588-600`). Cut markers sit at `:603-604`.
  - Delivered evidence renders verbatim up to `EVIDENCE_BLOCK_CHAR_CAP = 60_000` (`gather.ts:637-640`; `evidence-delivery.ts:52`).
- **Evidence delivery in think.** `src/core/think/index.ts:526-543` `renderThinkPages` resolves `think.return_unit` through `resolveEvidencePlan` (`evidence-delivery.ts:186-229`). The default is `auto`, and `auto` budgets 24,000 tokens (`DEFAULT_CONVERSATION_BUDGET`, `evidence-delivery.ts:50`). Remote callers are clamped at 32,000 (`:51`).
  - Conversation pages are detected by type or slug (`:243-256`) and delivered whole.
  - Other hits keep excerpts.
  - **No think-specific token budget key exists**; the conversation budget is the shared `search.return_budget_conversation`.
- **Prompt.** `src/core/think/prompt.ts:46-76`: JSON output `{answer, citations, gaps}`.
  - Every claim must be cited `[slug]`/`[slug#row]`.
  - Conflicting takes go in a "Conflicts" section.
  - Missing data goes in `gaps[]` and is never invented.
  - Low-weight takes and hunches are marked.
  - The date rules (`:94-96`) are added when the user message carries `Current date:` (`:181-183`).
- **Time frame (#6112, P6 R1).** `src/core/think/temporal-context.ts:62-94` takes the reference date in `brain.timezone` and validates `reference_date`, rejecting future dates (`:49-60`). Only content dates (`event_date|date|published|filename`, `:35`) render as `<page date=…>`. This is always on with no setting (`docs/eval/decisions/p6-think-dates-sealed/README.md`, "Default").
- **Takes sanitation.** `src/core/think/sanitize.ts`: `INJECTION_PATTERNS` (shared with the LongMemEval harness), 500-char claim cap, `<take>` framing.
- **Citations.** `src/core/think/cite-render.ts`: structured citations are preferred; a regex fallback is used when the model omits them.
- **Quote grounding.** `think.quote_verify` (default on, `index.ts:1170-1177`) grounds quoted spans against prompt evidence via `groundSource`/`groundAnswerQuotes` (`index.ts:1158-1166`). It warns `QUOTE_NOT_IN_EVIDENCE` and quarantines unverified claims on persist.
- **Answerability (S4).** `src/core/think/decide.ts:10-12,105-131` makes a separate TypeSafe Jev call over the final evidence. A verdict of `abstain` skips synthesis. It is off by default, and a fresh brain has no calibrated threshold (A4 S4 report).
- **Output caps and usage.** `DEFAULT_MAX_OUTPUT_TOKENS = 4000`, or 16,000 for thinking-by-default models (`index.ts:250-261`). `usage` (input/output tokens) is returned on `ThinkResult` (`index.ts:212-217, 790-897`). That is the one production surface that already reports reader tokens.
- **Removed.** Notes-first reading in think (`think.reading_notes`) was killed in P6 R2. No `reading_notes` key remains in `src/` (grep).

### 1.3 Evidence delivery and the memory verbs (MCP ops)

| Op | Location | Budget knobs | LLM? |
|---|---|---|---|
| `query` / `search` with `return_unit` | `src/core/ops/search.ts:120-140`, `token_budget` `:636`, `:787` | `search.return_unit` (default `auto`), `search.return_window`, `search.return_budget_default` (6,000), `search.return_budget_conversation` (24,000), `search.return_budget_max_remote` (32,000), registered in `src/core/config.ts:1402-1408` | No (reranker API only) |
| `assemble_evidence` | `src/core/ops/search.ts:1154-1190` | `return_unit` (default `page`), `token_budget`, `detail` | No |
| `recall` | `src/core/ops/facts.ts:208-230` | `budget_tokens`, `budget_policy facts_first|query_first`, `return_unit` | No |
| `context_pack` | `src/core/ops/facts.ts:628-700`; push path `src/mcp/context-pack-handler.ts` (`PUSH_PACK_MAX_ENTITIES = 4`, `:34`) | `budget_tokens`; entity cards, open threads, hot facts with provenance (#6146) and the core block; packing prices the rendered lines (`facts.ts:604-608`) | No ("zero LLM", description) |
| `think` | `src/core/ops/takes.ts:206-330` | `model`, `since`/`until`, `reference_date`, `anchor`, `rounds`; **no token budget param** | Yes |

The context pack is entity-keyed and question-independent: it runs at session start and after compaction. It is not a per-question evidence brief and has no conflict or gap logic of its own. The closest existing "brief" is think's own JSON output (answer + citations + gaps + conflicts), which is an answer, not evidence for another reader.

### 1.4 gbrain-evals harness pieces a grid would reuse

- **memory-qa lanes** (`eval/runner/memory-qa/run.ts`):
  - `--qa reader|think`.
  - `--qa-context sessions|facts`.
  - `--qa-budget-tokens` (`:157`), which packs whole sessions in rank order until the next one doesn't fit (`qa.ts:51-58`). This is already a deterministic truncation control.
  - `qa_context_tokens` (chars/4) is recorded for reader lanes only (`run.ts:392`).
  - The think lane default model is `anthropic:claude-sonnet-5-5` (`run.ts:158`; same at harness `cf270c2:158`). Its input tokens are `approxTokens(q.question)` only (`run.ts:381`; `cf270c2:391`).
- **Default readers** (`qa.ts:34`): LongMemEval-S `gpt-4o-2024-08-06`, LoCoMo `gpt-4o-mini`, BEAM `gpt-4.1-mini`. These are old models, preregistered for continuity.
- **Abstention scoring:**
  - `repeatsTrap` for LoCoMo adversarial (`qa.ts:106`).
  - A4's `scoreAnswerV2` with hedge detection (`eval/runner/a4-abstention.ts:143`).
  - LongMemEval `_abs` items use the official "unanswerable" judge prompt.
- **Evidence-delivery runner** (`eval/runner/evidence-delivery.ts`, branch `capy/evidence-delivery-evals` per its report) records three token counts per row and has a frozen-hit-list design that a brief study should copy.
- **W10 batch driver** (`eval/runner/batch/w10.ts`, `w10-rescore.ts`) replays captured reader requests with only the model changed. W10a's `capture/captures.ndjson.gz` holds all 500 current-pin requests: a brief study can start from frozen evidence with **zero retrieval spend**.

---

## 2. What has been measured

All LongMemEval-S/M results are **development data** (sealed protocol v1, lines 7-9: "Both sets are therefore development data now"; plan amendment 1).

### 2.1 Delivery and size

| Result | Number | Date / pin | Data class | Source |
|---|---|---|---|---|
| Current pin end to end | 468/500 (93.6%), Sonnet 5.5 notes reader, official judge; mean 4.9 conversations; strict `recall_all@5` 449/470 | 2026-10-06, `c5fb0201` | dev | `2026-10-07-longmemeval-w10a-current-pin.md` |
| Reader input, current pin | 22,167 Claude tokens mean, 500 q [A-calc from `arms/w10a-sonnet55-notes/rows.ndjson` usage]; 22,242 on the 150-q subset; 13,794 GPT tokens for `gpt-6.1-sol` | 2026-10-06 | dev | W10c report table |
| Same text, frontier readers | Opus 5.5 474/500, Sonnet 5.5 notes 462, Sonnet 5.5 direct 465, `gpt-6.1-sol` 464, `gpt-5.4` official prompt 460 (14,458 GPT tokens) | 2026-10-06/07, `a7cb37b` retrieval | dev | W10b report |
| Whole history vs gbrain (150 q) | Sonnet 5.5: whole 144 (171,596 Claude tok) vs gbrain 139 (22,242); sol: 141 (106,683) vs 137 (13,794). Non-inferior at 7 pts (Holm p 0.035 / 0.014). Gap all in multi-session: 34 vs 29 and 33 vs 29 of 36 | 2026-10-06, `c5fb0201` | dev | `2026-10-07-longmemeval-w10c-full-context.md` |
| Reader $ per question | Sonnet 5.5 gbrain $0.023 vs whole history $0.173 (batch); sol $0.014 vs $0.107 | same | dev | W10c |
| Whole page vs chunk (Sonnet 4.6) | page 361/400 vs chunk 253/400 (+114/−6, p 6e-27); window1 285, window2 292 (closure 29.6%, 36.1%, bar 60%) | 2026-09-30, `732ee811` | dev | `2026-09-30-evidence-delivery.md` |
| Token cost of those arms | provider-reported mean: chunk 3,511, window1 6,805, window2 6,906, page 15,484; cl100k delivered: 2,790 / 5,867 / 5,953 / 13,800 | same | dev | same, "Three token counts" |
| Pilot accuracy-vs-tokens curve (100 q) | chunk 68 @3,539; auto4k 70 @4,715; section 75 @5,432; window1 79 @6,762; auto6k 76 @6,904; auto7.5k 78 @8,537; agent_fetch 83 @12,390; page 92 @14,617; **k10 at 6k: 67 @6,709** | same | dev | same, pilot table |
| `auto` default (16k budget) | LongMemEval-S auto 445 vs chunk 312 vs page 457 of 500; sealed v1 auto 149 vs chunk 147 of 150 (E2 **fail**, ceiling) | 2026-09-30, `e9b580c5` | dev + sealed v1 | `2026-09-30-evidence-auto-v2.md` |
| `auto` default (24k) on sealed v2 | **192 vs 132 of 200** (+60/−0, +30.0 pts [+24.0, +36.0]); mean Claude input 12,982 vs 3,280; delivered cl100k mean 11,526 (max 13,992); `recall_all@5` 153/160 | 2026-10-02, `d44296cf` (v0.60.30.0), Sonnet 4.6 | **held-out** (sealed v2 opening 1) | `2026-10-02-sealed-v2-decision-1.md` |
| Evidence budget vs prompt | full sessions 89/100 (~15,500 tok) vs five chunks 65/100 (~3,400); three prompts over chunks tied (65, 65, …) | 2026-09-29 | dev | `2026-09-29-longmemeval-opaque-qa.md:13-16,124-139` |
| Starting-line reader context (chars/4, top 5 sessions packed) | LongMemEval-S mean 16,797 (shard 0, 167 rows); BEAM-100K 10,288; BEAM-1M 7,539; **LoCoMo 4,730** (587 rows) [A-calc from `starting-line/*-qa-master/shard-0/rows.ndjson.gz`] | 2026-10-04, `6622a119e` | dev | heldout-program starting line |

### 2.2 Presentation and reading

| Result | Number | Data class | Source |
|---|---|---|---|
| `think` date frame (P6 R1) | sealed LoCoMo 74.2% → 88.2% (+14.0 [+11.8, +16.2]); 229 wins / 33 losses; **temporal 27 → 199 of 221**, multi-hop +13, adversarial +6, single-hop +3, open-domain +2 questions; R@5 0.541 both arms | sealed LoCoMo (7 conv, 1,399 q), candidate `2815a8368` vs `67c4ff27b`, harness `cf270c2` | `heldout-verdicts/p6-think-dates-sealed-locomo-2026-10-06.json` |
| Same, development | LongMemEval-S think 80.7 → 90.0% (+9.3 [+4.0, +15.3], 150 q); LoCoMo dev 76.7 → 89.1% | dev | `docs/eval/TIME_AWARE_RETRIEVAL_RESULTS.md:40-46` |
| Date frame latency | think p50 6.28 → 6.05 s, p95 13.67 → 12.66 s (ratio 0.93 [0.88, 1.03]), Sonnet 5.5 | dev | `decisions/p6-think-dates-sealed/README.md` |
| Notes vs direct, oracle sessions (GPT-4o) | 92.2/92.6% vs 84.8/85.0%; +7.8 pts [+5.0, +10.8], 49 wins / 10 losses | oracle replication | `docs/eval/READING_NOTES_RESULTS.md:25-47` |
| Notes transfer to the gbrain reader (Sonnet 4.6, 512 tok) | 324 vs 308 of 361 (+4.4 [+1.7, +7.2]); 9 truncated; conservative rescoring 317 vs 308 | dev | same, "Completed GBrain comparison" |
| Notes at 1,024 tokens, 500 q | 453 vs 432 (+32/−11, p 0.002) | dev | `docs/plans/2026-10-06-followups-round/PLAN.md:77` |
| Notes vs direct with Sonnet 5.5 | 462 vs 465 (+7/−10, p 0.63): **no longer helps** | dev | W10b |

The JSON-vs-natural-language memory format showed no difference: +0.2 and +0.4 pts (`READING_NOTES_RESULTS.md:41-47`).

### 2.3 Negative results the bet must answer

- **Lexical excerpt selector (`evidence-packet.ts`).** Holdout 48/60 against 53/60 for full sessions: 0 improved, 5 worsened, −8.3 pts [−16.7, −1.7].
  - Abstention fell 12 → 10.
  - Reader input fell only 910,540 → 831,175 tokens (−8.7%), saving $0.247.
  - Concrete loss: dropped the round "20 plants sold at $7.50" and answered $345 instead of $495.
  - Source: `docs/eval/ANSWER_PACKET_RESULTS.md:1-60`. Decision: "Do not trade answer quality for a smaller prompt."
- **Neighbor windows and sections at about 7k.** They closed 30-36% of the chunk→page gap (bar 60%) and left temporal at 67 against 99 for page (evidence-delivery, per-type table).
- **More chunks at the same budget.** `k10` at a 6k budget scored 67, against 68 for five chunks.
- **Notes-first inside think (P6 R2).** −0.7 [−3.3, +2.0] on LongMemEval-S and −1.5 [−3.4, 0.0] on LoCoMo dev; removed (`TIME_AWARE_RETRIEVAL_RESULTS.md:127-141`).
- **Notes prompt on gpt-4o.** It abstained on 261-274 of 400 questions; chunk 128 against window2 129 (evidence-delivery, "Does it hold for another reader?").
- **Agent fetch.** 83/100 against 92 for page. It fetched no page on 30 of 100 questions and cost 12,390 tokens, 0.85 of page (evidence-delivery).
- **Fact keys (P6 F2).** +3.2 strict R@5 on LongMemEval-M but −1.1 [−2.4, 0.0] against `tokenmax` synopses on LoCoMo dev (1 win / 6 losses), so killed. `tokenmax` synopses: C vs A +1.5 [+0.2, +2.8] R@5. Production per-chunk synopses on LongMemEval-M project to about $4,280 (p6.md, amendment 2).
- **Facts replacing sources.** The compendium cites LongMemEval's own finding that summaries or facts in place of conversations "generally hurt answers" (`docs/research/answer-evidence/compendium.md:87-95`). gbrain's facts lane on sealed LoCoMo scored 53.6% → 54.7% overall QA with a `gpt-4o-mini` reader (P2 E2 guard). That is a different reader from P6, so it is not comparable, but it is low.
- **Published compressors.** RECOMP cut 660 → 36 tokens with exact match 39.39 → 37.04. LLMLingua-2 cut 3,003 → 970 with 87.75 → 86.92 (compendium `:106-124`).
- **CRAG grade as an abstention signal.** On A4 it is uninformative: all 240 questions graded `moderate` (`2026-10-01-a4-abstention.md`).

### 2.4 Abstention and "confident wrong" baselines

| Set | Number | Source |
|---|---|---|
| LongMemEval-S `_abs` (30) | Sonnet 5.5 28/30, Opus 5.5 29/30 | W10a, W10b rows |
| [A-calc] Sonnet 5.5, 470 answerable | 30 wrong: 5 hedged or abstained, **25 confidently wrong** (regex `not available|I don't know|not mentioned|…`). Opus 5.5: 25 wrong, 6 hedged, 19 confident | `w10a-sonnet55-notes/rows.ndjson`, `w10b-opus55-notes/rows.ndjson` |
| Sealed v2 abstention (40) | 40/40 in both arms | sealed-v2 decision 1 |
| LoCoMo adversarial dev (123), `gpt-4o-mini` | 63.4% abstain correctly; **42.3% repeat the planted false answer** | heldout-program starting line |
| LoCoMo adversarial sealed (323), think | 284 → 290 (P6) | p6 verdict JSON |
| A4 (240 synthetic) | Sonnet 5.5 house reader alone 117/120 abstain, 0 false refusals; with S4 120/120 (p 0.25, ceiling) | `2026-10-06-a4-s4-on.md` |

### 2.5 External token figures (for the "others need 7k" claim)

- **Mem0.** 6,787 tokens per retrieval call on LongMemEval (94.4%), 6,956 on LoCoMo, 6,719 on BEAM-1M, 6,914 on BEAM-10M. Top_200 memories, managed platform, tokenizer unstated, self-reported (Mem0 docs and the `mem0ai/mem0` README via web search, 2026-10-07).
  - `docs/comparison-systems.md` carries Mem0's accuracy (line 51) but **no token figure**.
  - `docs/plans/2026-09-28-gbrain-10x/audit/coverage-and-categories.md:87` says "Mem0 publishes about 6.8K tokens per query, Zep 1.6K", with no link.
- **Zep 1.6K:** unsourced in-repo (that audit line only).
- **Hindsight, Graphiti:** **not found** in either repo or `comparison-systems.md`.
- **The MPW comparator** (an extract-first server on the public agent-memory benchmark harness) has committed rows of LongMemEval-S 473/500 at **43.6k context tokens** and LoCoMo10 1417/1540 at 36.2k (`docs/designs/MEMORY_PROOF_WAVE.md:37-39` on gbrain branch `capy/mpw-integration`). That is a counterexample to "others need 7k".
- **Full-context baselines.** Mem0 says "25,000+ tokens per query" (Mem0 docs). W10c measured 171,596 Claude tokens on LongMemEval-S.

---

## 3. Status of every relevant sealed or held-out set

| Set | Size | Openings / exposure | Protocol / file | Usable for bet 1? |
|---|---|---|---|---|
| **LoCoMo** | 10 conversations public (`locomo10.json`); split 3 dev (conv-44, 47, 48) / 7 sealed (conv-26, 30, 41, 42, 43, 49, 50) | Sealed opened by P2 E2 (2026-10-04), P3 E1 (2026-10-04, **FAIL**), P6 R1 (2026-10-06), and the OSS shootout Phase 7 (A5, approved 2026-10-06, "completed 2026-10-07"), which ran Mem0, Hindsight, Graphiti, Cognee, Basic Memory and gbrain on all 7. **0 unexposed conversations.** | `gbrain-evals/eval/decisions/splits/locomo.json`: "7 sealed conversations are fewer than the comparator default of 10 clusters, so the sealed split is diagnostic evidence, never a primary confirmation"; OSS prereg A5 (branch `capy/oss-memory-shootout`, lines 372-405) | **Diagnostic only.** It is public data and conversations are small: 5 sessions ≈ 4,730 chars/4 tokens already, so a 7k or 15k "budget" there means *more* sessions, not compression. |
| **sealed-confirmation-v1** | 150 q / 30 personas, ~65k-token histories, ~1,200-token chats | **1 of 3 used** (`evidence-auto-v2-2026-09-30:e2:auto`); chunk already 147/150. No later opening found; the followups plan says "Sealed v1 and v2 stay closed" (`PLAN.md:184`). | `docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md` | It can reject harm, not confirm gain, because of the ceiling. |
| **sealed-confirmation-v2** | 200 q / 40 personas, 134,830-150,385-token histories; 80 multi-session, 40 temporal, 40 knowledge update, 40 abstention | **1 of 3 used** (decision 1, 2026-10-02); **2 left**. Exposure: 34 of 40 histories imported and their sessions sent to providers by P8 quote grounding (2026-10-04/05); questions and labels not read; "Future v2 decisions must name this exposure". Reading is near ceiling: oracle 199/200, chunk oracle 196/200. | `docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md` (rules inherited from v1) | **Yes**, the best available held-out set for a brief-vs-auto non-inferiority decision (auto 192/200 leaves room to detect harm). Uses an opening. |
| **LongMemEval-S** | 500 q | All dev (`splits/lme-s.json`, `dev_fraction: 1`) | sealed v1 protocol lines 7-9; plan amendment 1 | Dev and tuning only. |
| **LongMemEval-M** | 500 q (same ids as S) | No sealed split was ever defined (p6.md "not runnable"); P6 used 470 M questions for fact keys | p6.md; followups F6 | Dev only. It is the right place for the breadth arm. |
| **BEAM** (P0 split) | 100k: 6 dev / 14 sealed; 500k: 11 / 24; 1M: 11 / 24 | 100K sealed: P4 core gate ingested the 14 haystacks; OSS shootout P7 ran 224 sealed q on them | `splits/beam-*.json` ("supporting evidence at decisions … until retired") | 500k/1M sealed are the cleanest **if** not consumed by MPW (below). |
| **BEAM** (MPW grouping manifest) | Design doc: "BEAM 500k + 1M, 14/14/42"; evals #69 body: "BEAM 100k + 500k + 1M … 54 sealed conversations, margin 3.0" | Pending; the two texts disagree | gbrain `docs/designs/MEMORY_PROOF_WAVE.md` A2 (branch), evals PR #69 | Coordinate with GBRA-52; never open twice for the same question. |
| **BEAM-10M** (GBRA-49 Q1 scoreboard) | n/a | **Not found** in either repo at these pins | n/a | Ask GBRA-49. |
| **Custody** | | Project AGENTS.md: sealed sets stay in owner custody on Garry's Mac. The followups plan says v2 is "in owner custody on Garry's Mac". The v2 decision 1 custodian shredded the copies after the run. | | Any opening needs the owner's agent to ship the files after the preregistration is on origin. |

---

## 4. Gaps between Garry's bet and reality

1. **"gbrain hands the reader ~22k tokens, Mem0 ~7k."** The 22k is Claude-tokenizer specific. On GPT tokens it is 13,794, and on cl100k about 13,800 (page arm, September). Mem0's 6.8k is self-reported, at top_200, with an unknown tokenizer and a different reader and judge. The like-for-like gap is about 2x. gbrain-evals has **no** matched-token comparison published yet; the OSS shootout cells at an 8,000 chars/4 budget are landing on PR #89 but have no report.
2. **"Dates lifted LoCoMo 74.2% → 88.2% with search unchanged."** True (R@5 0.541 in both arms). But 172 of the 196 net gained questions are temporal (27 → 199 of 221): the baseline lacked any date, so the effect is repairing missing information, not compressing it. It does not predict that removing text is safe.
3. **"A bad reading prompt costs up to 10 points."** "Up to 10" was **not found** as a number. The measured within-reader prompt effects are:
   - +7.8 pts notes vs direct on oracle sessions (GPT-4o);
   - +2.8 pts for Sonnet 4.6 (451 vs 437 of 500);
   - about 0 for Sonnet 5.5 (462 vs 465);
   - −0.7 pts (LongMemEval-S) and −1.5 pts (LoCoMo dev) for notes inside think.

   The one catastrophic prompt effect is gpt-4o over-abstaining under the house notes prompt (261-274 of 400 abstained). Prompt effects are shrinking as readers improve, while the evidence *amount* effect stays large: page vs chunk is +27 pts with Sonnet 4.6, +30 on sealed v2.
4. **2k has no supporting measurement.** No gbrain arm below about 3.3k exists. The chunk arm (~3.5k provider tokens) lost 108 of 400 against page (Sonnet 4.6). No arm with a 5.x reader has ever been measured below whole sessions. [A-calc] Gold-session text alone averages 6,489 chars/4 tokens, and 8,981 on multi-session questions.
5. **Budget points on LoCoMo don't compress.** The reader lane already gets about 4,730 chars/4 tokens for top-5 sessions. LoCoMo conversations have 19-32 sessions each (P3 root cause), so a 15k LoCoMo point is near whole-history.
6. **The brief needs a model call.** Total tokens processed rise slightly, the frontier reader's input falls about 7-10x, and dollar cost falls about 4x (section 6.4). "10x fewer tokens" is true only for the reader's input.
7. **No production surface answers from evidence at a stated budget.** `think` has no budget parameter. `query` and `assemble_evidence` budget raw evidence, not a brief. `context_pack` is entity-keyed.
8. **Conflicts and supersession are only partly in the reader's view.**
   - think surfaces take conflicts.
   - Facts validity windows render only on the unmerged #6066 branch (`search.evidence_date_header`, default off).
   - `findContradictions` is an MCP op, but its output never reaches the think or reader prompt.
   - The knowledge-update category is near ceiling (71/72 W10a), so measured value has to come from adversarial and supersession sets (MPW B-suites, Q2).
9. **"Not in the brain" exists in three uncoordinated places.** These are think `gaps[]`, S4 (no shipped threshold) and the reader's abstention instruction. None reports *what was searched*, so a false "not in brain" can't be audited.
10. **The P6 think results have no token data.** The `qa_input_tokens` gate counts the question only (section 1.4). The sealed P6 pass is unknown on input size.

## 5. Risks and prior failures the plan must not repeat

1. **Shrinking by selection.** The lexical selector saved 8.7% of tokens and lost 5 answers plus 2 abstentions. Windows and sections closed at most 36% of the gap. Any brief arm must beat a *simple truncation control at the same budget*, as compendium section 3 demands, and keep a full-text fallback.
2. **Decisive-detail loss.** Numbers, dates, negations ("missed the ceremony"), plan-versus-done distinctions and later corrections must survive. Both the reading-notes audit and the packet audit list these failures by question id.
3. **Wrong token payload.**
   - `qa_input_tokens` counted only the question in the P6 think lane.
   - "A 6,000-token budget … became about 6,900 reader tokens."
   - Claude and GPT tokenizers differ by about 1.6x.
   - MPW lists "token counting on the wrong payload" as a reviewed failure (design `:375`).
   - Count cl100k on inserted text, plus provider-reported input, plus builder tokens.
4. **Ceiling sets.** Sealed v1 (147/150) could not confirm a gain. Sealed v2 has a reading ceiling (oracle 199/200). A4 is near ceiling (117/120). Report ceilings, and don't count a tie at 100% as a win.
5. **Reader noise.** 13 of 401 byte-identical requests flipped between W10a and W10b-era runs (W10a). In evidence-delivery, the controls agreed on 77 of 81 (about 5%). A few points between single runs is not a result.
6. **Small-cluster false confidence.** LoCoMo sealed has 7 clusters ("diagnostic"). P6's tight interval [+11.8, +16.2] was clustered over 7 conversations.
7. **Spent or failed sets.** "A failed held-out set is spent" (heldout-program, rule 5). The sealed v2 rules forbid tuning: "may not be used to choose between candidate settings".
8. **Ledger caps mid-run.** The P6 sealed first pass stopped at $80 after 4 of 7 conversations, and 142 rows were redone. Size the cap from a smoke run.
9. **Builder prompt injection.** The builder is a new LLM that reads untrusted session text (`reader.ts:7-25`, `sanitize.ts:1-25`). A hijacked builder can delete or insert claims. Mitigations: wrap every block in `<chat_session>`, require verbatim quotes, and ground them with `groundSource`.
10. **Notes behave differently by model.** Notes helped GPT-4o and Sonnet 4.6, not Sonnet 5.5, and they made gpt-4o over-abstain. Brief builders and readers must be tested per model, never assumed to transfer.
11. **LoCoMo label noise.** The 10x-plan audit cites a documented 6.4% answer-key error rate (`coverage-and-categories.md:15`).
12. **Old readers in default lanes.** memory-qa defaults to `gpt-4o-mini` and `gpt-4.1-mini` on LoCoMo and BEAM (`qa.ts:34`). Under the project eval rules, product decisions need the newest Opus, Sonnet and GPT; Fable is smoke-only; `gpt-5.4-mini` is never used.

---

## 6. Proposed design and experiment

### 6.1 Principles taken from the evidence

- **P1.** The brief is written by a model **from intact evidence**: whole delivered sessions, as `auto` delivers them. It is never assembled by lexical selection.
- **P2.** Every claim carries a **verbatim quote** and a pointer (`source_id`, `slug`, `chunk_id`, UTF-16 span, SHA-256 of the span, the same shape as `PassagePointer` in `evidence-packet.ts:18-26`). The pointer is validated deterministically after generation. An ungrounded claim is dropped and counted.
- **P3.** Every claim is dated: observation date plus event date when stated, using P6's content-date rule (`temporal-context.ts:35`) and #6066's header format.
- **P4.** The brief states coverage and gaps explicitly: what was searched (query, k, sessions read, budget), what was not found, and the S4 probability when S4 is available.
- **P5.** Conflicts are first-class: same subject, different values, ordered by date, with a "latest" mark. A conflict is never resolved silently.
- **P6.** Escape hatch: the brief lists source pointers, and the reader (agent mode) may call `assemble_evidence` on them. Fetched tokens count against the budget, and fetch rate is reported (the agent_fetch arm under-fetched).

### 6.2 Brief format (illustrative; invented placeholders)

```json
{ "version": "brief-v1", "question": "...", "reference_date": "2026-05-30",
  "searched": { "query": "...", "mode": "balanced", "k": 10, "sessions_read": 9, "evidence_tokens_cl100k": 27140 },
  "claims": [
    { "id": "c1", "text": "Bought a blue widget for $40", "observed": "2026-03-02", "event_date": "2026-03-01",
      "quote": "picked up the blue widget yesterday for $40", "src": {"slug": "chat/s-1a2b", "chunk_id": 812, "span": [1204, 1251], "sha256": "…"},
      "speaker": "user", "status": "current" }
  ],
  "conflicts": [ { "subject": "widget color", "claims": ["c1", "c4"], "latest": "c4", "note": "c4 corrects c1" } ],
  "aggregates": [ { "what": "widget purchases", "count": 3, "claims": ["c1", "c2", "c5"], "complete": "unknown" } ],
  "gaps": [ "No session states the return date." ],
  "answerable": { "s4_p": 0.91, "builder_verdict": "partial" },
  "budget": { "target": 2000, "used_cl100k": 1810, "dropped_claims_ungrounded": 1 } }
```

The reader receives this rendered as compact text (claims grouped by date, then conflicts, aggregates and gaps), not as raw JSON. JSON showed no benefit over prose (`READING_NOTES_RESULTS.md:41-47`). Keep the JSON for receipts.

### 6.3 Where it sits

| Stage | Location | Contract | Why |
|---|---|---|---|
| S1 (eval-only, first) | New `src/eval/longmemeval/evidence-brief.ts` beside `evidence-packet.ts`; reader arm `--reader-context brief --brief-budget N --brief-model M` in `reader.ts` and `eval-longmemeval.ts:1461`; gbrain-evals `memory-qa --qa-context brief` and a replay driver over W10a captures | Experimental, versioned (`BRIEF_VERSION`), with receipts and pointers | No production default changes before a verdict. Frozen captures give zero retrieval spend. |
| S2 | Core `src/core/evidence-brief.ts`: input = `DeliveredSearchResult[]` from `deliverEvidence` + takes + facts + temporal context; output = brief + validation report | Pure apart from one gateway call; grounding reuses `cycle/synthesize-verify.ts` | One builder for think, MCP and eval. |
| S3 | `think`: config `think.evidence_brief: off|on` (default off) and `think.evidence_brief_model`; registered next to `think.return_unit` (`config.ts:1408`) | When on, think synthesizes from the brief and `pagesBlock` is replaced | think is the product answerer; the P6 latency gate (p95 ≤ +20%) applies. |
| S4 | New MCP op `evidence_brief` (read scope, paid, remote budget clamp, output redaction `retrieval`) taking `question` and optional `hits` (as `assemble_evidence`) | Must say "paid call" like think's description | `query` stays zero-LLM. Agents with their own frontier model get a small brief instead of 22k Claude tokens. |
| Not | `context_pack` | | Entity-keyed and session-start; a different question. |

**Migration:** none for S1-S4 (no schema; config keys only). A brief cache keyed on (question hash, evidence fingerprint, builder version) would need a table. That is not proposed until a verdict shows repeat questions matter.

### 6.4 Who builds it, and what it costs

All figures are list prices from `gbrain-evals/eval/runner/budget-ledger.ts:1019-1038`:
- `claude-sonnet-5-5` $2 / $10 per M tokens;
- `claude-opus-5-5` $4 / $20;
- `gpt-6.1-sol` $2 / $10;
- `gpt-6-luna` $0.10 / $0.50.

`claude-haiku-5-5` is **not priced** in the ledger and must be registered before any run. The Claude/GPT tokenizer ratio is 22,077 / 13,695 = 1.61 (W10b).

| Per question (LongMemEval-S size) | Reader input | Reader $ (list) | Builder $ | Total | vs today |
|---|---|---|---|---|---|
| Today, Sonnet 5.5 (W10a) | 22,167 Claude tok in + ~203 out | $0.046 (batch settled $0.023) | | $0.046 | 1.0x |
| Brief@2k, Sonnet 5.5 reader, `gpt-6-luna` builder (13.7k in, ≤3k out incl. reasoning) | ~3.5k Claude tok in | ~$0.009 | ~$0.003 | **~$0.012** | ~3.8x cheaper |
| Today, Opus 5.5 | 22,077 in + ~294 out | ~$0.094 | | $0.094 | 1.0x |
| Brief@2k, Opus 5.5 reader, luna builder | ~3.5k | ~$0.020 | ~$0.003 | **~$0.023** | ~4.1x cheaper |
| Brief@2k, Sonnet 5.5 builder (upper-bound quality) | ~3.5k | ~$0.009 | ~$0.05 | ~$0.059 | **more expensive** |

These are my estimates, not measurements. They assume the brief is about 2k cl100k plus 300 tokens of framing, with output means from W10b.

- **Latency:** the builder adds one serial call before synthesis. It is unmeasured. The baseline think p50/p95 is 6.05/12.66 s on Sonnet 5.5 (P6 dev). Gate it at p95 ≤ +20%, the P6 precedent.
- **Builder choice:** a cost ladder like the W9 contradiction-judge round: the cheapest model that passes. Candidates are `gpt-6-luna`, `claude-haiku-5-5` and `gemini-3.8-flash` (outside the ledger today). Sonnet 5.5 as builder is an upper bound only.

### 6.5 Abstention and "confident wrong" scoring (ties to A4)

Every row gets one of {correct, abstained, hedged-wrong, confident-wrong}. The classifier is A4's `scoreAnswerV2` hedge logic (`a4-abstention.ts:143`) generalized, plus the official judge verdict.

Metrics:
1. Accuracy over all questions (the denominator includes `_abs`).
2. **Confident-wrong rate** = (answerable answered wrongly without hedge + unanswerable answered) / all. Today [A-calc] ≈ (25 + 2) / 500 = 5.4% for Sonnet 5.5 and (19 + 1) / 500 = 4.0% for Opus 5.5.
3. Abstain recall and false-refusal rate.
4. Selective accuracy at the achieved coverage.
5. **False "not in brain" taxonomy:** for each answerable abstention, whether the gold session was in the builder's input (builder dropped it) or not (retrieval missed it). The evidence-packet coverage grouping is the precedent.

Sets: LongMemEval-S `_abs` (30), LoCoMo adversarial dev (123; `repeatsTrap`), A4 (240; ceiling, report only), sealed v2 abstention (40) at confirmation, and the MPW B-suites "passing details, corrections" when they land.

### 6.6 Preregistration shape

Write it in gbrain-evals `docs/benchmarks/2026-10-XX-evidence-brief-preregistration.md`, pushed before the first paid cell. It contains:
- Question.
- Frozen evidence: W10a captures, SHA recorded.
- Arms, readers and builders with exact ids and reasoning effort.
- Budgets and the token definitions (cl100k inserted, provider input, builder in/out).
- Primary comparison: **Sonnet 5.5, brief@2k vs today**, non-inferiority margin 3.0 pts, one-sided α 0.05, official judge `gpt-4o-2024-08-06` (continuity with W10).
- Secondaries under Holm: other readers and budgets.
- Kill gates:
  - any question type down by more than 3 questions;
  - confident-wrong rate up;
  - abstain recall down by more than 1 on `_abs`;
  - more than 2% of claims ungrounded;
  - p95 latency above +20%.
- The truncation control at each budget, which the brief must beat.
- Pilot/confirm split: fixed 100/400, as in evidence-delivery.
- Cost formula, ledger cap, and stop and resume rules.
- Model list re-checked against the provider lists on the run day.
- The sealed-v2 decision as a separate preregistration naming the P8 exposure.

### 6.7 Token-budget grid

- **Readers:** Opus 5.5, Sonnet 5.5, `gpt-6.1-sol` (re-check newest GPT on the run day). Fable 5.1 only in a 20-question smoke run.
- **Development, LongMemEval-S, 500 questions (frozen W10a captures):**
  - `A0` today (whole sessions, top 5, ~13.8k cl100k).
  - `TRUNC@2k` and `TRUNC@7k`: `packSessions`-style whole sessions in rank order (the deterministic control).
  - `CHUNK` (~3.3k).
  - `BRIEF@1k`, `BRIEF@2k`, `BRIEF@4k`, `BRIEF@7k`.
  - Builders luna and haiku-5-5 on the 100-question pilot; the winner goes to confirmation.
  - `BRIEF@15k` is dropped on LongMemEval-S, because A0 is already about 13.8k cl100k.
- **Breadth (LongMemEval-M dev 500; BEAM-1M dev 11 conversations):**
  - `A0-top5` against `BRIEF@7k` over top-10 and top-20 sessions, and `BRIEF@15k` over top-20.
  - Target: the multi-session gap and BEAM-1M strict recall (18.2% at top 5, starting line).
  - Needs a new capture (retrieval ~$8 per 500 on a cold cache, W10a).
- **LoCoMo dev (3 conversations, 587 q):** descriptive only, with the think lane fixed to record `usage`. Points: 2k brief against today's think.
- **Confirmation:** sealed v2 decision 2, **one** preregistered candidate (the confirmed brief config in think or the reader) against `auto`, Sonnet 5.5 reader, plus Opus 5.5 if the budget allows. A non-inferiority margin of 5 pts is realistic (6.8). Optionally a brief arm on MPW's A5 frontier if GBRA-52 adds it before its sealed cells run.

### 6.8 Sample size and power

Paired binary outcomes give SE ≈ √(d/n), where d is the discordant fraction. 80% power, one-sided α 0.05, true difference 0 needs margin ≈ 2.49 × SE.

| Set | n | d | SE | Margin with 80% power |
|---|---|---|---|---|
| LongMemEval-S | 500 | 0.032 (W10a identical-prompt flips, 13/401) | 0.8 pt | 2.0 pt |
| LongMemEval-S | 500 | 0.08 | 1.26 | 3.1 |
| LongMemEval-S | 500 | 0.15 | 1.73 | 4.3 |
| Sealed v2 | 200 (40 clusters, unclustered approximation) | 0.05 | 1.58 | 3.9 (more once clustering is counted) |
| Sealed v2 | 200 | 0.10 | 2.24 | 5.6 |
| LoCoMo sealed | 1,399 / 7 clusters | n/a | n/a | not a confirmation set (split note) |

For reference, chunk vs page discordance was 120/400 = 30% (evidence-delivery) and auto vs chunk was 60/200 = 30% (sealed v2). The pilot measures the brief's d before the margin is frozen. Holm over 3 readers × 4 budgets costs power, so preregister one primary.

### 6.9 Cost (batch prices, estimates)

| Block | Estimate |
|---|---|
| LongMemEval-S reader arms (3 readers × {2 TRUNC + 4 BRIEF}, 500 q): Sonnet ~$2.3/arm @2k, ~$6.3 @7k; Opus ~2.1x; sol ~0.6x | ~$80-110 |
| A0 baselines on W10a capture: Sonnet reuse ($0), Opus ~$24, sol ~$7 (W10b settled) | ~$31 |
| Builders: luna ~$0.75 per budget per 500; haiku-5-5 unpriced; optional Sonnet-builder bound ~$23 per budget | ~$5-50 |
| Judges: official ~$0.18 and secondary ~$0.15 per arm (W10a) × ~20 arms | ~$7 |
| Breadth on LongMemEval-M/BEAM-1M dev (new capture + 3 arms × 2 readers) | ~$40-80 |
| LoCoMo dev think descriptive | ~$15 |
| Sealed v2 decision 2 (decision 1 cost $16.06) | ~$20-30 |
| **Total** | **~$200-320; request a $400 ledger cap** |

---

## 7. Proposed work items

| # | Goal | Files | Migration | Effort (human-d / agent-h) | Metric and dataset that proves it | Paid |
|---|---|---|---|---|---|---|
| A1 | Fix token accounting: record provider usage and cl100k delivered tokens on every reader row; think lane records `usage` | gbrain `src/eval/longmemeval/reader.ts:147-185`, `src/commands/eval-longmemeval.ts:1468-1480`; evals `eval/runner/memory-qa/run.ts:378-392` | no | 0.5 / 2 | Rows show `reader_input_tokens`; rescore of W10a reproduces 22,167 mean; P6-style think rows show non-question input | $0 |
| A2 | $0 headroom report: gold-session token share, per-type oracle size, notes length, confident-wrong baseline | evals script over W10a/W10b receipts | no | 0.5 / 2 | Publishes [A-calc] numbers with a reproducible script (6,489 / 15,822; 25 confident wrong) | $0 |
| A3 | Brief builder (eval-only) with grounding validation and schema | new `src/eval/longmemeval/evidence-brief.ts`; reuse `src/core/cycle/synthesize-verify.ts`, `sanitize.ts` | no | 2 / 6 | Unit tests: pointer and SHA round-trip, injection fixture cannot add a claim, ungrounded-claim drop counted | $0 (tests) |
| A4 | Harness arms `--reader-context brief`, TRUNC control, W10a replay driver | `reader.ts`, `eval-longmemeval.ts`, evals `eval/runner/batch/w10.ts`, `memory-qa/qa.ts` | no | 1 / 4 | Byte-identical A0 replay; 2-question keyless smoke | ~$1 smoke |
| A5 | Pilot: builder × budget on the 100-q pilot; pick builder and format | evals prereg + runner | no | 1 / 4 | Accuracy, d, confident-wrong, ungrounded rate; LongMemEval-S pilot 100 | ~$40 |
| A6 | Confirmatory LongMemEval-S grid, 3 readers | same | no | 1 / 3 | Primary: Sonnet 5.5 brief@2k NI 3.0 pts vs A0 on 400 confirm q; secondaries Holm | ~$120 |
| A7 | Breadth: brief over top-10/20 at 7k vs top-5 whole | `eval-longmemeval.ts` top-k, memory-qa BEAM lane | no | 1.5 / 5 | LongMemEval-M multi-session accuracy (dev), BEAM-1M rubric score (dev); W10c multi-session 29/36 → ≥33/36 target | ~$60 |
| A8 | Core builder plus `think.evidence_brief` (default off) | new `src/core/evidence-brief.ts`, `src/core/think/index.ts:526-543`, `src/core/config.ts:1408` | no | 2 / 6 | think lane, LongMemEval-S 150 dev + LoCoMo dev: NI ≤ 2 pts vs think today, p95 ≤ +20% | ~$30 |
| A9 | MCP op `evidence_brief` | `src/core/ops/search.ts` (beside `assemble_evidence`), operations registry, docs | no | 1.5 / 4 | N6 leak suite passes (no protected-content expansion); remote clamp asserted; Cat 40 agent smoke uses it | ~$10 |
| A10 | Abstention instrumentation: four-way outcome classifier and false-"not in brain" taxonomy | evals `a4-abstention.ts` (`scoreAnswerV2`), memory-qa scorer | no | 1 / 3 | Confident-wrong rate on LongMemEval-S `_abs` + answerable, LoCoMo adversarial dev (42.3% repeat-trap baseline) | $0-5 |
| A11 | Held-out confirmation: sealed v2 decision 2 | evals prereg; runner `sealed-confirmation.ts --manifest eval/data/sealed-confirmation-v2/manifest.json` | no | 1 / 3 (+ custodian) | NI vs auto (192/200 baseline), margin ~5 pts, abstention 40/40 kept; Claude tokens ≤ 1/5 of 12,982 | ~$25 |
| A12 | (Conditional) sealed v3 with harder reading, written by a non-OpenAI family, if v2's ceiling blocks a superiority claim | evals `eval/generators/` (v2 generator as template) | no | 2 / 6 | Solvability table like v2's; chunk oracle below 90% | ~$30 (v2 cost $29.90) |

---

## 8. Overlaps with in-flight work

- **gbrain #6066 + evals #69, GBRA-52 memory proof wave (draft until sealed results).**
  - Overlaps:
    - `search.evidence_date_header` (one-line observation date per delivered block; facts show validity windows; default off) is the "dated" part of the brief.
    - The MPW harness counts delivered context with cl100k on inserted text, gated ±10% of target (design A0 item 8).
    - **A5 "equal-context frontier" at 4k, 8k, 16k and 32k** plus each system's default, swept on dev, with the preregistered target and at most two more points on sealed BEAM. That is the same grid shape as bet 1, on raw pages.
  - Action: add a `brief` arm to A5 *before* MPW freezes its preregistration, or keep bet 1 on LongMemEval and sealed v2 only. Don't open MPW's BEAM sealed split for a second question. Resolve the 54-conversation (#69 body) vs 14/14/42 (design) discrepancy with GBRA-52.
- **Evals #89, OSS memory shootout.** It already runs Mem0, Graphiti, Hindsight, Cognee and Basic Memory on one harness, with `fixed-evidence` packs at 8,000 chars/4 tokens in `native` and `rehydrated` modes, and D2 frontier readers on 100-q slices. Its Phase 7 opened LoCoMo sealed and BEAM-100K sealed. Use its cells (once reported) as the **matched** "others at 8k" source instead of Mem0's self-report. A brief arm could be a new `context mode` there.
- **gbrain #6271 + evals #76/#93/#77, GBRA-39 Cat 40 Hard.** Root cause: missing nicknames (~6.7 pts) and "no result counts" on aggregation questions (#93 body). The brief's `aggregates` with counts directly serve this. The Cat 40 agent-task harness is where the `evidence_brief` op (A9) should show agent value. Don't touch the #77 sealed variant.
- **GBRA-49, evals #88 Q2 parser gaps and the Q1 scoreboard.** #88's write-then-answer has "four models, three ingests … abstention rubric". Reuse that rubric for A10 rather than inventing a third. The BEAM-10M scoreboard (not found in-repo) is where breadth plus brief should report tokens per query.
- **GBRA-58 trust tiers (#5575).** Brief claims should carry the source's trust tier and taint once tiers exist. The builder is a new place where poisoned content could be laundered into a "fact" (risk 9). Its poisoning suites should include a brief arm.
- **GBRA-59 (#6278 managed sync stall)** and **GBRA-45 (`capy/sync-feeder-fast-writes`):** no direct overlap. The brief reads whatever is indexed.
- **Also relevant:**
  - Open gbrain #5086 "fix(think): derive a temporal window from an explicit date in the question" touches the same think date path as P3 in 6.1.
  - Open evals TODO "Production `think` end to end with `think.return_unit`" (`TODOS.md:11`) is a prerequisite measurement for A8.
  - Open TODO "Ask gbrain to ship a calibrated reference threshold for the S4 answerable slot" (`TODOS.md:144`) gates using S4 in the brief's `answerable` field.

## 9. Not found

- A sourced "up to 10 points" reading-prompt cost.
- Hindsight and Graphiti tokens per query in either repo.
- A sourced in-repo Zep 1.6K figure.
- Any gbrain arm measured below ~3.3k tokens with a 5.x reader.
- Any think-lane input-token measurement.
- A BEAM-10M split or scoreboard file.
- A defined sealed LongMemEval-M split.
- `claude-haiku-5-5` in the budget ledger price table.

# Sealed confirmation set: protocol, 2026-09-29

This is a data and access protocol, not a benchmark result. It freezes a new, separately written test set for [gbrain](https://github.com/garrytan/gbrain), a memory system for agents, so that future release decisions can be checked on questions nobody has tuned against. No gbrain run has touched this set. Opening it is itself a release decision.

## Why a new set

gbrain's conversation-memory numbers come mostly from [LongMemEval](https://github.com/xiaowu0162/LongMemEval), a public benchmark of chat histories and questions about them. The 95.53% strict retrieval figure (449 of 470 answerable questions) was reached by choosing settings on those same 470 questions. The Cat13 held-out concepts were also reused to pick defaults. Both sets are therefore development data now. Splitting them again cannot turn them back into a fair test, because the choices already reflect every question in them. LongMemEval-M does not help either: its 500 questions are the same as LongMemEval-S's, with more distracting sessions around them.

The accepted plan amendment (amendment 1 of the [10x plan](https://github.com/garrytan/gbrain-evals/blob/docs/10x-plan/docs/plans/2026-09-28-gbrain-10x/PLAN.md)) asks for a confirmation set that is separately written, split by source history rather than by paraphrase, and opened only at release decisions that were written down in advance, with a log of every access.

## What a question looks like

**Invented example, not from the set:** over five months a fictional user chats with an assistant about fixing up an old motorcycle. In one chat they mention paying $42 for a new chain; weeks later, $118 for a carburetor kit; later still, $31 for brake pads. A friend's cheaper chain comes up in the same chat as the brake pads. At the end the user asks, "What did I spend altogether on the chain, the carburetor kit and the brake pads?" A memory system has to find all three chats among 55 and ignore the friend's price. The answer is $191.

Each fictional user gets five questions, one of each kind LongMemEval uses for chat memory:

| Kind | What the system must do |
|---|---|
| Single-session fact | Find one detail stated once |
| Multi-session aggregation | Combine details from two to four chats |
| Temporal reasoning | Work out time between dated events |
| Knowledge update | Report the latest value after it changed |
| Abstention | Say the detail was never mentioned |

## What was built

| Item | Value |
|---|---|
| Fictional users (personas) | 30 |
| Questions | 150: 30 of each kind; 120 answerable, 30 abstention |
| Chats per user history (haystack) | 55: 20 about the user's life, 35 general-help chats |
| History size | 240,096 to 272,633 characters, median 259,356 (about 60,000 to 68,000 tokens at four characters per token) |
| Gold chats per answerable question | single-session 1; multi-session 2 to 3 (median 3); temporal 2; knowledge update 2 |
| Generation date | 2026-09-29 |
| Generator | OpenAI `gpt-6-sol` (writer and fact auditor), seed 20260929 |
| Generator code | commit `1bc841e`, files hashed in the manifest |

For scale, LongMemEval-S histories hold about 50 chats and about 115,000 tokens. These histories have a similar number of chats but roughly half the text.

**A different author.** LongMemEval's chats were written with Llama 3 70B Instruct, with GPT-4o helping propose questions and people editing about 70% of sessions ([paper](https://arxiv.org/abs/2410.10813), appendix). Earlier gbrain-evals corpora (world-v1, amara-life-v1, transcript-distill-v1) were written by Claude Opus 4.5. This set was written by `gpt-6-sol`, a model not used for any earlier corpus here.

**How it was generated.** [`sealed-confirmation-gen.ts`](../../eval/generators/sealed-confirmation-gen.ts) runs four steps, with every prompt frozen in [`sealed-confirmation-prompts.ts`](../../eval/generators/sealed-confirmation-prompts.ts):

1. **Seeds.** Code assigns each persona a distinct occupation, three hobbies, a life arc (such as learning to drive or fostering kittens), a household and a start date. No two personas share an occupation, a hobby or a life arc, so no topic history spans two personas. These seed attributes can be recomputed from the public seed and lists; the invented people, plans, chats, questions and answers cannot.
2. **Plan.** The model invents the person and plans 18 to 22 dated chats, the facts revealed in each, at least four near-miss facts (a friend's similar event, a rejected option) and the five questions with answers. Code checks the plan: dates in order, one question of each kind, evidence chats consistent with evidence facts, the right number of evidence chats per kind, question dates after the last chat. One of 30 plans needed a second attempt.
3. **Chats.** The model writes each chat from its plan, told which facts to reveal and which facts from other chats to keep out. A separate audit call checks that the required facts are conveyed, that evidence from other chats did not leak in, and that the detail an abstention question asks about never appears. A failed chat is rewritten, up to three attempts. 598 of 600 chats passed; 610 attempts in total.
4. **Fillers and assembly.** 176 general-help chats (88 topics, beginner and advanced versions) contain no personal details. Each history takes 35 of them. Session and question ids are random-looking hashes of a private salt, so an id reveals nothing about its role.

**Labels come from the ledger.** The gold chats for each question are the chats its plan assigned the evidence facts to. The answer is the plan's answer. No system output was used to write or select labels.

**Two flagged questions stay in.** The two chats that failed all three audit attempts each belong to one question's evidence (one multi-session, one knowledge update), so those questions carry an `evidence_session_audit_failed` flag in the labels. In both chats the question's own evidence facts passed; the failing statements were background facts. One statement said the shop was "invented", which the chat naturally did not say; the other had a date the chat did not pin down. Items are never deleted for audit or solvability results.

## Solvability controls

Before sealing, two readers answered every question. Both used Claude Sonnet 4.6 at temperature zero with LongMemEval's own chain-of-thought reader prompt. A GPT-4o judge (`gpt-4o-2024-08-06`) scored each answer with LongMemEval's official per-kind prompts; abstention items use its "unanswerable" prompt.

- The **oracle-evidence reader** saw only the gold chats (for abstention items, the related chats that never state the detail).
- The **no-memory reader** saw no chats.

| Kind | Questions | Oracle-evidence correct | No-memory correct |
|---|---:|---:|---:|
| Single-session fact | 30 | 30 | 0 |
| Multi-session aggregation | 30 | 30 | 0 |
| Temporal reasoning | 30 | 30 | 0 |
| Knowledge update | 30 | 30 | 0 |
| Abstention | 30 | 30 | 30 |
| **All** | **150** | **150** | **30** |

With the right chats in hand, every question was answerable (150/150). Without memory, no answerable question was answered (0/120). The no-memory reader got all 30 abstention questions right because saying "I don't know" is the correct answer when nothing is known; abstention questions test whether a system invents details from related chats, which only a retrieval run can show. No reader output was truncated. The author also re-read nine oracle answers beside their gold answers (three each of temporal, multi-session and knowledge update); all nine were genuinely correct, not judge errors.

**What this means.** Reading the evidence is easy here, so the set measures mainly whether a system finds the right chats and keeps an updated value over a stale one. A perfect oracle score also means the set cannot show gains in the reading step itself. Summary: [`solvability.json`](../../eval/data/sealed-confirmation-v1/solvability.json).

## Overlap audit

[`sealed-confirmation-overlap.py`](../../scripts/sealed-confirmation-overlap.py) compared the sealed files with LongMemEval-S and LongMemEval-M (the cleaned releases, SHA-256 `d6f21ea9…` and `9d79e552…`) and with the committed gbrain-evals data. Full numbers: [`overlap-audit.json`](../../eval/data/sealed-confirmation-v1/overlap-audit.json).

| Check | LongMemEval-S (500 questions, 19,195 chats) | LongMemEval-M (500 questions, 51,661 chats) |
|---|---:|---:|
| Sealed questions identical after normalization | 0 of 150 | 0 of 150 |
| Highest word-set similarity (Jaccard) of any sealed question to any LongMemEval question | 0.33 | 0.33 |
| Sealed questions at similarity 0.5 or higher | 0 | 0 |
| Persona full names found | 0 of 30 | 0 of 30 |
| Persona given names or surnames found | 1 of 57 | 2 of 57 |
| Sealed chats sharing any 13-word run of text | 0 of 1,650 | 0 of 1,650 |

The five questions at similarity 0.3 to 0.33 all share only the phrase "How many days passed between", the standard form of a duration question. The name found in both sets is a persona's given name that also appears in a band name mentioned in 13 LongMemEval-S chats; the second M hit is another persona's given name, in a single chat. The 1,650 chats are 30 histories of 55: 600 persona chats plus 176 distinct fillers, each filler reused under different ids in several histories. All 500 M questions are identical to S's, confirming that M is not an independent test.

Persona names appear nowhere in `eval/data`. Against Cat13, the highest similarity to its 50 committed queries is 0.125, and no sealed question mentions any of the 30 world-v1 concept names Cat13 probes.

A limit of this check: of 561 capitalized words in the persona facts, 210 also appear somewhere in LongMemEval-M. Nearly all are ordinary English words or common given names used inside invented place and business names ("Range", "Community", "Market"). A shared single word is not shared content, and the 13-word text check found none. Word overlap still cannot prove independence of topics. The personas' topics are everyday themes from the public seed lists, which LongMemEval also covers in general terms.

## Access policy

The sealed files are `questions.json`, `labels.json` and `ledger.json`. Their SHA-256 commitments are in the public [`manifest.json`](../../eval/data/sealed-confirmation-v1/manifest.json):

| File | SHA-256 | Bytes |
|---|---|---:|
| `questions.json` | `c382f438ab80d745151613e1a5b9f6daec31b74c03cc4757702a35caaca78a1d` | 9,131,657 |
| `labels.json` | `4990a7e234cf6aed37c64f424ec3d7b319f6556e2c4652f04bfad771d2cdafc9` | 42,943 |
| `ledger.json` | `09d18ee375f24f12d8a1b532c72df65a747247b72162811048cf69f3379b4101` | 8,200,812 |

The rules:

1. **Custody.** The repository owner keeps the three files and `access-log.jsonl` outside this public repository. Nobody working on gbrain retrieval, ranking or answering gets the questions or labels.
2. **Preregistration first.** A release decision opens the set only after a dated preregistration is committed under `docs/benchmarks/`. It names the release candidate and the frozen comparison release (by commit), the adapters and settings, the metric, the paired comparison, the decision rule and the maximum spend. The runner records its `decision_id`.
3. **Logged access.** Every label read goes through the runner, which refuses a labels file that does not hash to the commitment and appends a line (time, operator, host, purpose, decision id, labels hash, run hash) to the access log before parsing. Reads outside the runner are logged by hand. The log travels with the files; its line count is reported with each result.
4. **What gets published.** Aggregate counts with denominators, by question kind. Per-question outcomes (keyed by opaque id) stay private with the files. Question text, chats, gold chats and answers are never published while the set is in use.
5. **Retirement.** The set supports at most three release decisions. It is retired sooner if any question, label or chat leaks, or if a result from it is used to tune a setting. A retired set may be published in full and becomes development data; a new version is generated with a new seed and salt.
6. **No tuning.** Results from this set may accept or reject a release. They may not be used to choose between candidate settings. A rejected candidate is fixed on development data, then re-preregistered.

**Access so far.** The log records two reads, both by the author before sealing: the solvability run above, and the nine-answer spot check (made with an ad hoc script, logged afterward). The author, a Capy agent, also read plans, two flagged chats and the pilot persona's questions while checking generation quality. Nobody has run gbrain or any retrieval system on the set.

## Scoring a run without exposing labels

[`sealed-confirmation.ts`](../../eval/runner/sealed-confirmation.ts) separates the side that runs the system from the side that scores it.

1. **Validate and run (no labels).** `run` checks the questions file against its commitment and an input allowlist: only listed fields (question id, history id, question, question date, chat ids, dates and turns) may appear, and every id must be opaque. It then passes the histories through the same code path as the LongMemEval runner (`eval/runner/longmemeval.ts`, `run()`), with empty gold lists, and writes one row per question with the retrieved chat ids. The recall figures printed by that inner runner are meaningless here, because it has no labels.
2. **Answer (optional, no labels).** `answer` sends the top five retrieved chats to the same reader and prompt as the solvability check.
3. **Score (labels).** `score` takes the private labels path only now. It requires `--purpose` and `--decision-id`, verifies the labels commitment, logs the access, and reports `recall_all@5` (every gold chat in the top five) and `recall_any@5` over the 120 answerable questions, by kind. Abstention questions leave the recall denominator, as in LongMemEval. A missing or failed row counts as a miss. With `--judge` it also scores answers with the official judge prompts over all 150 questions.

```bash
S=/path/to/private/sealed-confirmation-v1
bun eval/runner/sealed-confirmation.ts validate --questions $S/questions.json
bun eval/runner/sealed-confirmation.ts run --questions $S/questions.json --out-dir $S/runs/<decision-id> --adapters hybrid --top-k 5
bun eval/runner/sealed-confirmation.ts answer --questions $S/questions.json --run $S/runs/<decision-id>/run-hybrid.jsonl \
  --out $S/runs/<decision-id>/answers-hybrid.jsonl --cap-usd 5
bun eval/runner/sealed-confirmation.ts score --run $S/runs/<decision-id>/answers-hybrid.jsonl --labels $S/labels.json \
  --questions $S/questions.json --judge --cap-usd 2 --purpose "<preregistered decision>" --decision-id <decision-id> \
  --out $S/runs/<decision-id>/score-hybrid.json
```

Paid steps keep a reservation ledger: before each request (retries included) a worst-case cost is reserved against `--cap-usd`, then settled from the reported token usage.

## Limits

- **One generator family.** Writer and auditor are the same model. A systematic blind spot of that model (for example, a phrasing it always uses for dates) would not be caught by its own audit. The set tests generalization to new histories from a new author, not to real users' chats.
- **Narrow question forms.** 29 of 30 temporal questions ask for the number of days between two events, and 10 of 30 multi-session questions ask for a total spent. The set does not cover LongMemEval's assistant-said or preference questions.
- **Easier reading than retrieval.** The oracle ceiling is 150/150, and histories are about half LongMemEval-S's length. Filler chats contain no personal details, so the hard distractors are the persona's own 17 to 19 non-evidence chats, including planted near misses.
- **Small.** 120 answerable questions over 30 personas. A difference of a few questions is within noise; comparisons should be paired by question and clustered by persona.
- **Same judge family as the writer.** The judge is GPT-4o, as in LongMemEval's official scorer, and the writer is also an OpenAI model.
- **Cost accounting.** HTTP failures that return no usage are settled at zero.

## Reproduce and inspect

Regeneration makes a different set: model output is not deterministic and the salt is random. The commands below document how this one was made.

```bash
bun eval/generators/sealed-confirmation-gen.ts --out <private dir> --personas 30 --seed 20260929 --cap-usd 38 \
  --concurrency 10 --manifest eval/data/sealed-confirmation-v1/manifest.json
bun eval/runner/sealed-confirmation.ts solvability --questions <private dir>/questions.json --labels <private dir>/labels.json \
  --out <private dir>/solvability/solvability-rows.jsonl --cap-usd 8 --purpose "pre-seal solvability check"
uv run --with ijson python3 scripts/sealed-confirmation-overlap.py --questions <private dir>/questions.json \
  --ledger <private dir>/ledger.json --lme-s ~/datasets/longmemeval/longmemeval_s_cleaned.json \
  --lme-m ~/datasets/longmemeval/longmemeval_m_cleaned.json \
  --out-public eval/data/sealed-confirmation-v1/overlap-audit.json --out-private <private dir>/overlap-private.json
```

Keys: `OPENAI_API_KEY` (generation, judge), `ANTHROPIC_API_KEY` (reader). Observed cost, priced from reported token usage at the 2026-09-29 list prices recorded in `sealed-confirmation-lib.ts`:

| Step | Paid calls | Cost |
|---|---:|---:|
| Generation, including two one-persona pilots | 1,492 | $15.82 |
| Solvability (300 reader, 300 judge calls) | 600 | $2.00 |
| **Total** | | **$17.83** |

Wall time: about 33 minutes for generation at concurrency 10, 4.5 minutes for solvability and 2 minutes for the overlap audit.

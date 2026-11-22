# Preregistration: gbrain on Redis's open LongMemEval harness, with frontier readers and autocut on and off

Written 2026-11-20 for GST-3250, the first of this experiment's two pull requests (R77: this preregistration with the
vendored harness, then one results pull request). Nothing counted has run. A quick look on 2026-11-19 (GBEV-111, 50
questions, no published number) linked gbrain to the harness and suggested the arms below. This file freezes when its
pull request merges. Values that don't exist yet (the gbrain release at launch, the results-branch commit, the
judge check's result, the measured discordance) go under "Recorded before counted units" before the first counted
unit. Any other change is a dated amendment at the end, never an edit.

## Question

Redis publishes LongMemEval results from an open harness, so anyone can run another memory system through the same
dataset loader, answer prompt, judge prompts and metric. On that harness:

1. **Where does gbrain land against Redis's published table,** with Redis's own reader and judge (gpt-4o)?
2. **Does turning off `query`'s autocut change how many questions gbrain answers right?** Autocut trims a search's
   result list where the relevance scores drop sharply. It is on by default for agents.
3. **Do frontier readers close the gap** between gbrain read by gpt-4o on this harness and the 93.6% (468 of 500)
   that README shows for gbrain on LongMemEval? That figure used a different reader (Sonnet 5.5 taking notes) and
   different retrieval settings ([report](2026-10-07-longmemeval-w10a-current-pin.md)). If they do, the reader was the
   gap. If they don't, the oracle arm below says whether retrieval or the harness's one-shot answer prompt is.

## Public lesson

- **If gbrain holds up:** "We learned that gbrain, plugged into Redis's open harness unchanged, answers X of 500
  LongMemEval questions with the harness's own gpt-4o reader and Y with Opus 5.5. You should compare memory systems on
  a shared open harness, because reader and prompt choices move these numbers by more than most retrieval changes."
- **If autocut costs answers:** "We learned that trimming search results at a score cliff drops the second
  conversation that multi-session questions need. You should keep a fixed top-k for memory questions that combine
  several conversations." If it doesn't: "You can leave autocut on at a top-k of 10; it saves tokens without costing
  answers on this set."
- **If the frontier reader doesn't close the gap:** "We learned that with every needed conversation in front of it, a
  one-shot concise answer prompt still misses counting and date arithmetic. You should give the reader room to reason
  (notes, a scratchpad) before you tune retrieval."

## Evidence class

Development evidence. LongMemEval-S has been used in gbrain's tuning, so nothing here is held-out confirmation. The
results say so beside every number.

## Reused open-source harness code

Garry's 2026-11-19 rule asks evals to reuse useful open-source harness code instead of rebuilding it. This experiment
takes, from [redis/agent-memory-server](https://github.com/redis/agent-memory-server) at
`843d2078830f7297882316efb1aae0fb7ae1481f` (Apache-2.0), vendored in
[eval/redis-agent-memory-benchmark](../../eval/redis-agent-memory-benchmark/README.md):

| Part | Upstream file | Used for |
|---|---|---|
| Official LongMemEval judge prompts, one per question type plus abstention, with brace-safe substitution | `prompts/judge.py` | every judge, protocol and cross-family |
| Redis's yes/no scorer (`"yes" in reply` is 1, else `"no"` is 0, else unparsable) and judge request settings (temperature 0, seed 42, 10 output tokens) | `benchmark/judge.py` | every judge's verdict parsing; the protocol judge's settings |
| Task-averaged accuracy (mean of the six question-type accuracies, abstention questions folded into their type) | `benchmark/judge.py` `compute_metrics` | the Redis-comparable metric |
| The answer prompt (`ANSWER_SYSTEM_PROMPT`, `build_prompt` with the question date) | `memory/llm.py` | every reader's messages, byte for byte |
| Whole-conversation rendering (`session_text`) | `memory/common.py` | every arm that delivers whole conversations |
| The LongMemEval loader for the cleaned dataset and its seed-42 question order | `datasets/longmemeval.py`, `benchmark/runner.py` | the question set and its order |
| The memory-store contract and resumable runner | `memory/base.py`, `benchmark/runner.py` | the gbrain store, and the pilot's end-to-end parity run |

Redis's published table (`docs/comparison-systems/redis-longmemeval-results.json`, MIT, from
[redis/redis-ai-research-public](https://github.com/redis/redis-ai-research-public) at `7dbb607e`) is the reference
row: **86.14%** task-averaged for "Remis + Instruct" on all 500 Small questions, gpt-4o reader and judge. Redis
publishes no per-question outputs, so no comparison with Redis can be paired.

The judge rule still applies (R78). The protocol's gpt-4o judge runs as the link to Redis's table, as the rule allows
for a published protocol's own judge. Every decision rests on a cross-family judge checked against labels (below).

## System under test

gbrain at **the newest release on gbrain's master when the first counted gbrain retrieval starts**. Today that is
v0.60.748.0, `7f162344652afc725793dd476945716e09d26104` (tagged 2026-11-19). The tags are read again before the first
counted retrieval (`git ls-remote --tags https://github.com/garrytan/gbrain.git`). A newer release by then moves the
pin by dated amendment. The build freezes once counted retrieval starts, and the results name it.

**Retrieval settings, pinned.** gbrain's defaults for an install with only a Voyage key, which is the setup the quick
look ran:

- embeddings `voyage:voyage-4` at 1,024 dimensions;
- reranker **`voyage:rerank-3-lite`**, gbrain's default since v0.60.228.0, pinned explicitly with
  `search.reranker.model` so a default change can't move it mid-run;
- balanced search mode, no query expansion setting beyond the default.

The 93.6% README run used `voyage:rerank-2.5` and OpenAI `text-embedding-3-large` at 1,536 dimensions at gbrain
`c5fb0201`. The reader is a larger difference, but the results name these two too whenever they set a number beside
93.6%. A reranker comparison is out of scope.

**How gbrain runs.** For each question, a fresh in-memory PGLite brain is built, each history conversation is imported
as one page through gbrain's normal import path (`importFromContent`), and gbrain's real `query` operation runs with
an agent's MCP context (the quick look's adapter, on the results branch). Every query records whether the reranker ran
and any degraded stage.

## Data

LongMemEval ([Wu et al., ICLR 2025](https://arxiv.org/abs/2410.10813); MIT), cleaned release
[`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) at revision
`98d7416c24c778c2fee6e6f3006e7a073259d48f`, the files Redis's loader reads:

- **Small** (`longmemeval_s_cleaned.json`, sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`):
  500 questions, each with about 50 history conversations (about 115,000 tokens). 470 are answerable and 30 are
  abstention questions (id ends in `_abs`). This is the set Redis's table uses.
- **Oracle** (`longmemeval_oracle.json`, sha256
  `821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`): the same 500 questions with only the
  conversations that hold the evidence.

Every unit is one question. All 500 run, in the harness's seed-42 order (`random.Random(42).shuffle` over the
loader's examples). Any file whose hash differs refuses to load.

## Arms

Five ways of filling the answer prompt's "Memories" section. The reader, prompt and question are the same in every
arm, so only the memories differ.

| Arm | Memories given to the reader | gbrain call |
|---|---|---|
| **off** | the first 5 distinct conversations behind gbrain's results, whole, in rank order | `query {limit: 10, autocut: false}` |
| **on** | the same, with autocut at its default (on), so often fewer than 5 conversations | `query {limit: 10}` |
| **agent-default** | the returned passages themselves, each headed by its conversation's date (excerpts, not whole conversations) | `query {}`: every default, as an agent calls it (limit 25, autocut on) |
| **full** | every history conversation, whole, in date order. No memory system: this is the plain arm (R44) | none |
| **oracle** | only the conversations that hold the evidence, from the oracle file. No retrieval: this is each reader's ceiling with perfect evidence | none |

Whole conversations are rendered with the harness's `session_text` in every arm, so **off**, **on**, **full** and
**oracle** differ only in which conversations they include. `off` and `on` differ only in autocut.

**Why autocut gets its own clean pair.** In the quick look, the arm with autocut on also used gbrain's other defaults
(limit 25) and gave the reader passages instead of whole conversations, so its drop mixed three changes.
`agent-default` keeps that bundle as a descriptive bridge to the quick look; `off` against `on` isolates autocut.

**R44's plain arm.** R44 asks every head-to-head to include the same reader, tasks and harness without the thing
under test. Here the thing under test is gbrain's memory, so **full** (the whole history, no memory system) is that
arm, run for every reader.

### Readers

| Reader | Arms | Request |
|---|---|---|
| `gpt-4o-2024-08-06` | all five | OpenAI chat completions, temperature 0, 2,048 output tokens. The link to Redis's table, not a model under test. |
| `claude-opus-5-5` | off, on, full, oracle | Anthropic messages, system prompt and question as the harness builds them, no temperature (the model takes only its default and thinks adaptively, sharing the output limit), default effort, 8,192 output tokens |
| `gpt-6.2-sol` | off, on, full, oracle | OpenAI chat completions, default reasoning effort, 16,000 output tokens, no temperature and no `n` (the model refuses both) |
| `particle-1` | off, on, full, oracle | Particle chat completions (`https://api.particle.ai/v1`), `reasoning_effort: high`, 32,000 output tokens (its default cap) |

claude-opus-5-5 and gpt-6.2-sol are the newest frontier Opus and GPT; particle-1 is the primary low-cost model
(CLAUDE.md, "Choose models"). `bun scripts/model-freshness.ts` runs again before the first counted unit, and a newer
frontier model goes in by amendment. Every reader is a plain API call with the harness's prompt, so Garry's rule that
Sol runs in Codex CLI (R110, for agent harnesses) doesn't apply.

**Messages are built once, by the vendored Python.** A results-branch script writes every reader's and judge's
messages per arm as JSONL from the vendored `build_prompt`, `session_text` and `build_judge_prompt`; the request
builders only wrap those bytes in each provider's request shape. Nothing re-implements Redis's prompts.

**Context window.** Every **full** prompt is counted with each reader's own token count before any reader spend. A
prompt that can't fit a reader's window with its output limit is not sent; it is recorded as `does_not_fit`, scored
wrong for that reader (a no-memory system that can't read the history can't answer), and counted on its own line. By
the o200k count the longest Small history is about 106,000 tokens, inside every planned reader's window.

**What we changed from Redis's answer request**, all in the request wrapper and none in the prompt: gpt-4o is pinned
to its dated snapshot (the harness sends the alias, which resolved to the same snapshot in the quick look); every
request carries an output limit, so the ledger can reserve its worst case (the harness sends none; a truncated answer
is counted and reported); and the non-OpenAI readers use their own provider's request shape around the same two
messages. The pilot runs Redis's own runner end to end on its questions and checks that the messages our requests carry
are byte-identical to the runner's.

**Batch.** OpenAI and Anthropic reader and judge requests go through this repository's exactly-once batch lane
(`eval/runner/batch/`), which bills half the list price and settles each request against the ledger. particle-1 has no
batch endpoint and runs through the metering proxy (`eval/runner/harness-metering-proxy.ts`).

## Judges

Every answer gets two judges, scored apart and never averaged. Both use the vendored official prompts and Redis's
yes/no scorer.

| Reader | Protocol judge (link to Redis's table) | Cross-family judge (decisions) |
|---|---|---|
| gpt-4o-2024-08-06 | gpt-4o-2024-08-06 | claude-opus-5-5 |
| gpt-6.2-sol | gpt-4o-2024-08-06 | claude-opus-5-5 |
| claude-opus-5-5 | gpt-4o-2024-08-06 | gpt-6.2-astra |
| particle-1 | gpt-4o-2024-08-06 | gpt-6.2-astra |

- **Protocol judge:** Redis's request exactly (temperature 0, seed 42, 10 output tokens), parsed with Redis's scorer.
  It grades its own family's answers on the gpt-4o and Sol rows, as it does in Redis's table. It decides only the two
  rows that compare with published numbers judged the same way (Redis's 86.14% and README's 93.6%); every other
  decision rests on the cross-family judges.
- **Cross-family judges** follow R78: GPT-6 Astra for Claude rows and Claude Opus 5.5 for GPT rows; particle-1 rows go
  to Astra, and particle-1 never judges. gpt-6.2-astra runs at low reasoning effort with 2,000 output tokens;
  claude-opus-5-5 at low effort (`output_config.effort`), no temperature (it takes only its default), 2,000 output
  tokens, since its adaptive thinking shares the output limit. If the API doesn't serve gpt-6.2-astra at the judge
  check, `gpt-6-astra` replaces it by amendment before any counted unit.
- **Parsing.** Redis's scorer counts a reply as yes if "yes" appears anywhere in it, which is fine for 10-token replies
  but fragile for longer ones. Cross-family replies are parsed strictly: the first word of the reply, lowercased and
  stripped of punctuation, must be yes or no. Both parses are recorded, and the 1% unparsable gate below applies to the
  strict one.
- A judge reply that parses as neither yes nor no counts as unjudged. A cell is complete only when both judges have
  graded every answer, and the results count unparsable replies by judge and arm (expected near 0).

### Judge check (R78), before any number counts

1. **Known-answer controls.** From 50 Small questions outside the pilot's 25 (40 answerable, spread over the six
   types, and 10 abstention questions, drawn with seed `lme-redis-harness`), four answers each with a known verdict:
   the gold answer (yes), another question's gold answer (no), "I don't have enough information to answer that." (no,
   or yes on an abstention question) and the gold answer inside a hedge such as "I think it was <gold>, though I'm not
   certain." (yes). 200 items. Every judge grades all of them.
2. **Real answers, labelled.** From the pilots, for each cross-family judge, at least 40 answers from the rows it
   grades (Astra: Opus and particle-1 rows; Opus: gpt-4o and Sol rows), spread over every arm, with at least 15 that the
   protocol judge marked wrong where the pilot has that many. The labeller is `gemini-4-argon`, a third model family
   that neither judges nor reads here, given the question, the gold answer or rubric and the official prompt's
   criterion, and blind to every judge's verdict. The labeller is recorded per item. The protocol judge is checked on
   the union of both sets. The results keep one caveat: the labels come from a model, and the controls
   are the check that doesn't depend on any model's labels.
3. **Gate.** Each judge's numbers count only if its Cohen's kappa is at least 0.6 on the controls and on its real set
   (each at least 40 items) and at most 1% of its replies are unparsable. The results show each confusion matrix and
   the raw agreement beside kappa, because kappa moves a lot when most answers are right. A cross-family judge that
   fails stops the experiment before any counted unit and goes to GBEV-3. If the protocol judge fails, its view is
   descriptive only and the two reference rows are reported as such.
4. **Read per arm.** On the counted answers, each arm's rate of disagreement between the two judges, with a Wilson 95%
   interval. Where an arm's rate is more than twice the pooled rate, 20 of its disagreements go to the same labeller,
   and the results report which judge it sided with.

## Metrics and denominators

- **Accuracy** (decisions): questions judged correct out of 500, under the cross-family judge, per reader and arm.
  Each question counts once.
- **Task-averaged accuracy** (the Redis link): the vendored `compute_metrics` under the protocol judge.
- **Overall accuracy under the protocol judge**: the figure compared with 93.6%, which was overall accuracy under
  gpt-4o.
- **Evidence delivered, at turn level** (GBRA-108's requirement after GBEV-112): for each answerable question and arm,
  whether every turn LongMemEval marks `has_answer` appears in the reader's prompt, and how many such turns appear. A
  turn's text is first normalised the way the loader does (supplementary-plane characters such as emoji removed), then
  whitespace and case are normalised on both sides. A turn counts as delivered only when its whole normalised text
  appears in one conversation or one passage of the prompt; a turn split across passages counts as delivered when the
  passages from its conversation together cover every character of it, and the results count how often that rule was
  needed. A turn present only in part (its opening kept and its answer cut, for example) counts as not delivered, and
  the results report partial turns separately. The results branch adds a keyless test in which a passage keeps a turn's
  opening but drops its answer, and that turn must count as not delivered. Reported for every arm, in the pilot and in
  the results. For the arms that deliver whole conversations it equals conversation-level delivery unless a turn was lost,
  and the results report both. For **agent-default**, which delivers passages, it is the one that counts. Autocut
  drops whole conversations, never parts of one, so for **off** against **on** the two levels agree; the results
  check that they do.
- **One request per distinct context.** Where autocut doesn't cut below 5 conversations, **off** and **on** give the
  reader byte-identical prompts. Each reader then answers that prompt once, and the answer and its judgments are scored
  for both arms, so the pair differs only where the contexts differ. The same holds for any two arms whose prompts
  hash the same. Before any reader spend, the share of the 500 questions whose **off** and **on** contexts differ is
  recorded: it is the largest effect the primary can show. If that share times the pilot's rate of answer changes on
  differing contexts is below the smallest detectable difference, that goes to GBEV-3 under R97 before counted units.
- **Degraded retrieval.** A question whose **off**, **on** or **agent-default** query ran without the reranker or with
  a degraded stage is retrieved again once, before any reader sees it. If it is still degraded, it is scored as given,
  counted, and left out of the primary pair, because autocut reads the reranker's scores and does nothing without them.
  The results check that **on**'s result list is a prefix of **off**'s on every clean question.
- **Failures.** A reader refusal, an empty answer or a truncated answer is an answer and is judged. A provider safety
  stop is reported on its own line and judged as given (R38). A reader or judge transport error that survives the
  lane's one retry leaves the question unscored in that cell; every such drop is counted, and a comparison needs 98%
  of its 500 questions scored in both members of the pair, with best-case and worst-case bounds for the rest. A gbrain
  retrieval error or a degraded retrieval stage scores the arm's answer as given and is counted.
- **Tokens:** mean reader input tokens per question per arm, from usage fields.

## Statistics

### Primary: autocut, on claude-opus-5-5

- **Pair:** for each question, Opus's correctness on **off** minus on **on**, under the cross-family judge
  (gpt-6.2-astra).
- **Test:** `z = (b − c) / √(b + c)`, where b counts questions right only on **off** and c right only on **on**. Two-sided
  alpha 0.05, split by O'Brien-Fleming across the one interim look and the final look (below): the final bound is
  |z| ≥ 1.98. The exact McNemar p is reported beside it.
- **Estimate:** the paired difference in points with a 95% interval from a paired bootstrap (10,000 resamples, seed
  `lme-redis-harness`).
- **Smallest detectable difference** at 80% power: 2.82 × √(d / 500) × 100 points, where d is the share of questions
  on which the two arms' answers disagree. At an assumed d of 8% it is **3.6 points** (3.1 at 6%, 4.0 at 10%). The
  pilot's Opus d, scaled by the recorded share of questions whose contexts differ, is recorded before counted units with
  the resulting figure, and the test runs at n = 500 whatever it shows.
- **Smaller than that:** a difference whose interval includes 0 is "no measurable difference at this sample size,"
  with the smallest detectable difference named. It is never called "no effect."

### Secondary, Holm-adjusted together

Each is a paired difference under the cross-family judge, with the same test, interval and seed:

1. off minus on, for gpt-6.2-sol, gpt-4o and particle-1;
2. off minus full, for each of the four readers (gbrain against no memory, R44);
3. oracle minus off, for each of the four readers (what retrieval costs each reader against perfect evidence).

Holm's correction runs over these 11 tests at alpha 0.05. The smallest detectable difference for each is computed the
same way from its own pilot discordance and reported.

### The two fixed references

- **Redis's 86.14%:** gpt-4o on **off**, task-averaged under the protocol judge, with a 95% interval from a bootstrap
  over questions stratified by type (10,000 resamples, same seed). One sample against a fixed published number.
- **README's 93.6%:** each frontier reader's overall accuracy on **off** (and on **oracle**) under the protocol judge,
  with a Wilson 95% interval (about 2.6 points either side at 90%). A reader **closes the gap** when its point estimate
  is at least 92.6% (463 of 500, within 5 questions of 468) and its interval includes 93.6%; it **falls short** when
  its interval's upper end is below 93.6%; anything else is "not distinguishable at this sample size".

### Descriptive

- **Reader against reader** (claude-opus-5-5 minus gpt-4o, gpt-6.2-sol minus gpt-4o, on **off**): the two members of
  each pair are graded by different cross-family judges, so a difference in judge leniency would count as reader skill.
  These pairs are shown under the protocol judge (one judge for both members) and under the cross-family judges, with
  intervals, as description only.
- **agent-default** for gpt-4o, beside **off** and **on**: the agent's out-of-the-box number and its turn-level
  delivery.
- Per question type, per reader and arm, with Wilson intervals (single types are too small to test).
- Reader input tokens per arm, and the share of **on**'s questions where autocut cut below 5 conversations.
- Agreement between the protocol and cross-family judges, per arm.

## What each outcome changes (R97)

| Question | Outcome | What we do differently |
|---|---|---|
| Autocut | **off wins clearly:** the primary test passes its bound with **off** ahead, gpt-6.2-sol's estimate points the same way, and **off** delivers every answer turn on more questions than **on** | A default change goes to Garry through GBRA-108: turn `query`'s autocut off for memory questions (or stop it cutting below a fixed floor), with the paired numbers and the turn-level delivery counts |
| Autocut | **No measurable difference** (the interval includes 0) | No default change. GBRA-108 hears that autocut at limit 10 costs less than the stated detectable difference on this set, and that the quick look's 12-point drop came with the limit and passage changes (agent-default shows how much) |
| Autocut | **on wins clearly** | Autocut stays on, the lead is closed, and the results say autocut also helped the reader |
| Reader gap | **A frontier reader closes it** on **off** (as defined under "The two fixed references") | The gap was the reader. Reader work goes ahead of retrieval work for this benchmark: the next experiment tests gbrain's own answer path with that reader, and README can show this harness's frontier number beside 93.6% |
| Reader gap | **Both fall short on off, and each one's oracle also falls short** | Even perfect evidence doesn't reach 93.6% under this one-shot prompt, so the harness's answer prompt is the limit. Reader-prompt work (a notes step) goes ahead of retrieval; no retrieval experiment is opened on this evidence |
| Reader gap | **A reader falls short on off, but its oracle closes the gap and oracle minus off passes its Holm-adjusted test** | Retrieval is the gap for frontier readers. Retrieval work goes ahead of reader work (the reverse of the quick look's reading), starting with the questions where **off** missed an answer turn |
| Reader gap | Any other combination (for example oracle closes the gap but oracle minus off doesn't pass, or a result is not distinguishable) | Undetermined: no reordering of reader and retrieval work, and the results say which rows were not distinguishable |
| Redis link | gpt-4o's task-averaged interval on **off** lies above 86.14% | README's comparison section gets a matched-harness row that names the system by kind, as README does ("above a published memory server's result on that server's own open harness, same reader and judge"), with no ranking word; [comparisons and their protocols](../comparison-systems.md) names Redis and the source. An upstream adapter offer goes to GBEV-3 for the claim check; nothing goes upstream without its go |
| Redis link | The interval includes 86.14% | The row says level on the same harness, with the interval |
| Redis link | The interval lies below 86.14% | The row says behind, plainly, and the result gets one "Why null?" pass (R48) |
| No memory | For a reader, **full** beats **off** (Holm-adjusted) | README says so for that reader, and gbrain's case on this set rests on cost; a "Why null?" pass reads where retrieval lost |
| No memory | **off** beats **full**, or no measurable difference | README states it with the interval and the reader tokens each arm used |

## Pilot per arm (R111)

Before counted units, every arm runs a pilot on 25 Small questions (the last 25 in the seed-42 order; these are
counted questions too, asked again in the counted run, and no pilot answer counts), with every reader that arm uses,
through the counted path: frozen contexts, the batch lane, the metering proxy, both judges. Each arm's pilot costs at
most a tenth of that arm's planned spend. It shows, on that arm's own outputs:

- **The part under test ran:** for **off**, **on** and **agent-default**, every query reranked with no degraded stage,
  the `query` parameters recorded as sent, and for **on** at least one question where autocut cut below 5 conversations
  (otherwise the arm tests nothing, and that comes to GBEV-3 before counted units). For **full** and **oracle**, the
  context holds every expected conversation. For every arm, turn-level delivery counts.
- **The judge passes:** both judges return a parsable verdict on every pilot answer, and the pilot answers supply the
  real-answer labels for the judge check above.
- **Units can be supplied at the planned rate:** the batch for each reader finishes inside the provider's window, the
  first batch per provider confirms the batch discount in the ledger, and particle-1 sustains the planned concurrency.
- **Answers are whole:** at most 1% of each reader's pilot answers per arm are empty or cut off by the output limit. A
  reader that fails gets a higher limit by amendment before counted units; truncations are reported per cell in the
  results.
- **Parity with Redis's runner, keyless:** Redis's own runner runs end to end on 3 questions with the live gbrain store
  and its OpenAI client pointed at a local keyless fake that records each request and answers a fixed string. The
  recorded messages must equal the messages our builders send for those questions byte for byte. No provider is called.

An arm that fails is fixed, or left out and reported as left out. The pilot's per-reader, per-arm disagreement between
**off** and **on** sets the recorded smallest detectable differences.

## Interim look (R113)

The counted run is planned above R113's paid threshold, so it takes R113's one look at half its units, and no other: after every cell has an answer and
both judgments for the first 250 questions in the seed-42 order (a random half, since that order is shuffled).

- **What is looked at:** the primary comparison only.
- **Bounds:** O'Brien-Fleming at two-sided alpha 0.05: stop for a difference at |z| ≥ 2.80 either way; the final look
  uses |z| ≥ 1.98.
- **Futility:** stop when the conditional power at the final look falls below 10%, computed by the B-value method
  under the planned alternative: a true difference equal to the recorded smallest detectable difference (planned 3.6
  points), at the recorded discordance.
- **What stopping changes:** only the **on** arm stops (for every reader), because the other arms answer the other
  questions, which have no interim test. A stopped primary is reported as stopped at the interim look, with its estimate
  marked as possibly overstated. The **on**-arm secondaries (off minus on for the other readers) are then reported at
  n = 250 with their smallest detectable differences recomputed for that size. No other look at the primary comparison
  is taken.

## Budget

One ledger for the experiment (`.budget/lme-redis-harness.sqlite` on the run VM, copied into the receipts), one budget
run per stage (judge check, pilots, counted first half, counted second half), each with a cap set in the ledger.
Every request is reserved at its worst case (input tokens counted before sending, plus the full output limit) before it
is sent: the batch lane reserves each batch before submitting it, and the metering proxy reserves each particle-1 and
Voyage request. Reaching a cap pauses the run at the next unit boundary until the cap is extended; it never ends the run
incomplete, and the run resumes from its recorded state. Paid calls run only inside paid windows granted by GBEV-3.
Dollar figures are in the tracking issue, not here.

## Harness work on the results branch, keyless, before any paid call

Each item is a dated commit on the results branch with a keyless test, before any paid request:

- The gbrain adapter: the quick look's in-process server, moved to the pinned release with the reranker pinned, and a
  store for the vendored runner.
- The context freezer: one brain per question, the three `query` calls, whole-conversation and passage rendering, the
  **full** and **oracle** contexts, SHA-256 per context, the retrieval record and turn-level delivery.
- The message writer (vendored Python, JSONL per arm), request builders that wrap those messages for the four readers
  and the judges, and arm manifests for the batch lane.
- A dataset check that verifies both files' sha256 before every load, whatever the cache holds.
- The judge check's control builder and kappa report.
- The analysis: accuracy, task-averaged accuracy, the paired tests, Holm, the interim look and the tables.
- `gpt-6.2-astra` registered in the ledger's price table, and `FRONTIER_READERS` moved to gpt-6.2-sol if the runner
  still names gpt-6.1-sol.

Tests reach no real provider: they use a dead keyless upstream with blanked keys.

## Run environment

Retrieval and the particle-1 reads run on one Ubicloud VM, detached, with a single ledger writer and a resume path;
batch work is submitted and collected from the same VM. The VM gets only the keys its stage needs (Voyage for
retrieval; the reader and judge keys through the metering proxy and the batch lane) and is destroyed when the run ends.

## Recorded before counted units

Appended as a dated amendment before the first counted unit:

- gbrain's newest release at launch, by version and sha.
- The results-branch commit the counted run uses.
- The judge check's kappas, unparsable rates and per-set counts.
- The pilot's per-arm checks, its discordances and the smallest detectable differences they give.
- The share of questions whose **off** and **on** contexts differ, and the count of `does_not_fit` prompts per reader.

## What it can and can't claim

**It can say:** how gbrain's newest release scores on Redis's open harness with Redis's reader and judge, next to
Redis's published number; whether autocut at limit 10 changes accuracy on Opus 5.5 by more than the stated detectable
difference; how far four readers get with gbrain's retrieval, with the whole history, and with perfect evidence.

**It can't say:** that gbrain ranks above or below Redis (one published aggregate, no paired outputs), anything about
held-out data, or anything about the reranker, embeddings or other gbrain settings it doesn't vary. Running Redis's own
open memory server through the same harness would give a paired comparison; it is a possible follow-up with its own
plan and decision, not part of this one.

## Amendments

### 2026-11-20, before any paid call

- **Build and models, read again.** gbrain's newest release is still v0.60.748.0
  (`7f162344652afc725793dd476945716e09d26104`, from `git ls-remote --tags` on 2026-11-20).
  `bun scripts/model-freshness.ts` lists no newer Opus, GPT or Particle model than the ones this plan calls, and it
  finds a price for every one of them. It warns about claude-sonnet-5-5, which is not a model under test here.
- **The interim look stops only for efficacy.** Conditional power at half the units is computed under the planned
  alternative (a true difference equal to the smallest detectable one) in the observed direction. On that basis it never
  falls below about 21%, its value at z = 0, so the 10% futility stop can't fire. The rule stays as written (GBEV-3,
  2026-11-20). The one look at 250 questions stops only when |z| ≥ 2.80, and otherwise the run goes to all 500.
  A keyless test pins this.
- **What pins the dataset.** The vendored loader downloads from revision `98d7416c`, but it reads a cached file without
  downloading it. So the pin that holds is the sha256 check, which this run's loader runs before every load, whatever
  the cache holds.
- **Parity with Redis's runner.** gbrain's ranking can differ between two brains built from the same history when
  scores tie. So for the gbrain arms, the check compares the runner's messages with our rendering of the retrieval the
  runner's own store received, byte for byte. It reports separately how often that retrieval matched the frozen one.
  For **full** and **oracle** the runner's messages are compared with the frozen ones directly. The reader side is the
  keyless fake. The gbrain store embeds and reranks with Voyage, so the parity check runs inside the pilot's paid
  window.
- **How particle-1 and the labeller are metered.** Their requests go through the shared chat client in the driver's
  own process, under the ledger's paid-request guard. The guard reserves each request's worst case in this experiment's
  ledger before it is sent. This replaces the separate metering-proxy process, and the caps work the same way.
  A particle-1 request is resent only after a failure proven to happen before sending.
- **Labels per judge.** gemini-4-argon labels 48 answers per cross-family judge, so that at least 40 still parse.
- **`FRONTIER_READERS` stays unchanged.** This run's driver names its readers itself and doesn't read that list.
- **How the adapter knows the reranker ran.** gbrain v0.60.748.0's retrieval metadata has no field naming the reranker.
  It sets `crag.top_rerank_score` whenever the reranker ran. So a query counts as reranked only when that field is set
  and gbrain's own call accounting shows a rerank call that succeeded; the adapter records the model that call served.
  A keyless run through the metering proxy, against a fake Voyage, found this before any paid call: the old field read
  came back empty on every query, so every question would have been marked degraded.

### 2026-11-20, before any pilot read: the on arm turns autocut on

The freeze showed that **on** as written measured nothing. gbrain v0.60.748.0 turns autocut off in every search mode
(`src/core/search/mode.ts`: "OFF in every bundle"), and `query` with the parameter left out falls back to that. So
`query {limit: 10}` kept 8 to 10 conversations on all 500 questions, the same as **off**. The 32 questions where the
two contexts differed differ only through reranker scores that vary slightly between calls. A 24-question probe with
`{limit: 10, autocut: true}` on real Voyage scores cut 18 questions to 1 or 2 conversations. No reader had run.

- **on** is now `query {limit: 10, autocut: true}`, autocut forced on. **off** is unchanged. The pair still differs only
  in autocut.
- **The autocut question becomes "would turning autocut back on cost answers?"** The primary test, its bound, the
  detectable difference and the model are unchanged. The decision table reads: if **off** wins clearly, or there is
  no measurable difference, gbrain keeps autocut off and GBRA-108 hears the paired numbers and the turn-level delivery
  counts; if **on** wins clearly, GBRA-108 hears the case for turning it back on, with the same numbers.
- **agent-default, corrected.** `query {}` runs with autocut off at this build, and gbrain's cap of 3 pages per answer
  is what trims it: it delivered 3 conversations on 496 of 500 questions. The arm and its parameters are unchanged;
  only its description was wrong.
- The pilot bar "**on** cuts below 5 conversations on at least one question" stays, and the retrieval is frozen again
  for all 500 questions with the new parameters before any reader runs. The first freeze is kept, unscored, as the
  record of the default's behaviour.

### 2026-11-20, after the judge check, before any counted unit: the strict parse reads a last-line verdict

Under the strict parse as written, claude-opus-5-5 failed the judge check's unparsable gate: 3 of its 200 control
replies (1.5%) opened with a sentence and gave the verdict alone on the last line ("…so it doesn't contain the correct
answer.\n\nno"), and one of its pilot replies did the same. Each verdict was unambiguous. gpt-6.2-astra and the
protocol judge had none.

- **The strict parse now has one fallback.** The first word, lowercased and stripped of punctuation and markdown, must
  be yes or no. When it isn't, the last non-empty line, stripped the same way, must be exactly yes or no. Anything else
  stays unparsable. Redis's own parse is unchanged and still recorded beside it.
- Every reply already recorded is rescored under the new parse with no new request, and the judge check is read again.
- The results say that the Opus judge's unparsable rate on the controls was 1.5% under the original parse, which is
  above the 1% gate, and give its rate under this one.

### 2026-11-20, after the pilot, before any counted unit: the counted run measures gbrain v0.60.752.0

The counted run has not started, so it moves to gbrain's newest release at launch (R100): **v0.60.752.0**,
`1f8d079d13c10d511c919cf69dd1e4c0137fbfcd` (tagged 2026-11-20, read from `git ls-remote --tags` that day; 749 was
never published). The tags are read again just before the first counted unit, and a newer release moves the pin by
another dated amendment. Once the first counted unit runs, the build is frozen for this experiment. The pilot ran on
v0.60.748.0 and stays development data.

- **What changed since v0.60.748.0** (`git log v0.60.748.0..v0.60.752.0`, 30 commits): page writes keep text that
  holds U+0000, with that character removed; fact reads end an employer, city or role once a newer one is saved, and
  rank far-future facts by when they were written; a conversation fact the speaker asked to keep quiet is saved
  private; conversation fact extraction keeps a page's other facts when the model declines one window; a chat refusal
  is reported as a refusal; and changes to Apple Contacts, iMessage, OpenClaw setup, identity and admin tools.
- **Could they move this run's retrieval?** Not in any way we can see. `query`'s own path (`src/core/ops/search.ts`,
  `src/core/search/hybrid.ts`, `autocut.ts`, `mode.ts`), page import (`src/core/import-file.ts`) and gbrain's
  LongMemEval adapter (`src/eval/longmemeval`) are byte-identical between the two tags, and autocut is still off in
  every mode. `query` does read saved facts, and those readers changed. But the benchmark brains hold no facts: the
  adapter configures no chat model, and every pilot query made only embedding and rerank calls. LongMemEval Small holds
  no U+0000. So we expect the same retrieval up to the reranker's call-to-call noise. The retrieval is frozen again on
  the new build for all 500 questions, and the results report how often each arm's context matches the pilot freeze.
- **No pilot answer counts, now enforced.** The batch state answers a question once per arm, so the pilot's 25
  questions, which the counted run asks again, would have reused their pilot answers. A counted stage now refuses to
  start while the batch state holds a pilot or judge-check batch or any particle-1 row. Before the counted wave, the
  pilot's answers, judgments, labels and freeze move to an archive, and the batch state keeps only its confirmed batch
  discounts. A keyless test pins the refusal.

### 2026-11-21, during the counted run: how the second half's judgments are recorded

This changes no judge, prompt, setting, number or verdict rule. A judge's request set is frozen from the answers an arm
holds at the first judge call, so after the first half each arm's judge set covered only questions 1 to 250. The
second half's judgments of an arm are recorded under an arm id of their own (`<arm>--<role>--second-half`), built
the same way over questions 251 to 500, and the results join the two halves. The interim look and the first half's
judgments are unchanged. A keyless test pins the ids.

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

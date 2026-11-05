# GST-1365 preregistration: do F6's and Q1's system comparisons hold under frontier judges?

Status: frozen before any paid call. Approved by Garry on 2026-11-04 ("do it", ask S, the Full option, via GBEV-3) with
an all-in cap of $1,750: an API ceiling of $850 that the runner enforces on one GST-1365 ledger, $650 of crew credits,
and a $250 reserve that only GBEV-3 releases. Owner: GST-1365, coordinated by GBEV-3. Runner:
`eval/runner/q1/rejudge-systems.ts`, with the decision rule as pure functions in `eval/runner/q1/rejudge-rule.ts`. It
reads F6's and Q1's sealed receipts on the custody host and changes no published number before its result. F6's and
Q1's own preregistrations are not amended.

## Question

Every system comparison F6 and Q1 publish on BEAM scores answers with BEAM's protocol judge, gpt-4.1-mini. In GBEV-35's
cells a frontier judge moved reader scores by 5 to 10 points. Do the published gbrain-versus-server and
gbrain-versus-file-agent comparisons hold in sign, rank and rough size when every answer is judged by a frontier judge
from a family that grades none of its own readers? And which judge is right where they disagree?

## Answers judged (a census)

Each stratum is judged in full. The answers are frozen: each reader's replicate-0 answer on every question in the
contrast's published cohort (both cells scored under the canonical judge, the set's exclusions left out). A product
failure (for example the file agent's `turn_cap` and `context_overflow` stops) scores 0 under every judge and is never
sent. Harness failures, does-not-fit answers and unjudged answers leave the question, as in scoreboard.ts.

| Stratum | Cells | Readers x questions |
|---|---|---|
| A. F6 S1 headline (BEAM-10M) | `s1.gbrain-defaults.f6-master.p` against `s1.ext-extract-first.common.component-b8000`, `s1.ext-memory-bank.recipe.component-b8000`, `s1.ext-verbatim-session.recipe.component-b8000`, `s1.ext-temporal-graph.shipped-0.31.component-b8000`, `s1.baseline-file-agent.baseline.whole-agent` | 3 x 199 |
| B. F6 S2b headline (BEAM-1M sealed) | `s2b.gbrain-defaults.f6-master.p` against `s2b.ext-extract-first.common.component-b8000`, `s2b.ext-memory-bank.recipe.component-b8000`, `s2b.ext-graph-pipeline.recipe.component-b8000`, `s2b.ext-verbatim-session.recipe.component-b8000`, `s2b.ext-temporal-graph.shipped-0.31.component-b8000` | 3 x 240 |
| C. Q1's rows in README's comparison block | Q1's `gbrain-defaults.shipped-defaults` rows (0.60.138.0): S1 `component-b8000` against extract-first, memory-bank and verbatim-session; S1 `whole-default` against the file agent (the loss bullet); S2b and S2a `component-b8000` against extract-first and the file agent. Competitor rows Q1 shares with A and B are judged once | mixed |
| D. F6 D8 | `d8.gbrain-defaults.f6-master.p` against `d8.ext-memory-bank.recipe.component-b8000`, `d8.ext-graph-pipeline.recipe.component-b8000`, `d8.baseline-hybrid.baseline.component-b8000` | 3 x 300 |

Left out: baseline-none and baseline-recency (gaps of 30 points or more), F6's partial S2a and S3 gbrain cells (no
published comparison), S3 LoCoMo and S4 (a different canonical judge), gbrain arms other than P, and particle-1 rows
(GST-1153 owns them).

## Judges

| Reader rows | Frontier judge (F) | Why this family is allowed |
|---|---|---|
| claude-opus-5-5, claude-sonnet-5-5 | openai:gpt-6.1-sol | grades no Claude rows; the judge of GBEV-35's second judge and of Q1's and F6's frontier column |
| gpt-6.1-sol | anthropic:claude-opus-5-5 | grades no GPT rows; Q1's and F6's existing Opus frontier instrument |
| every row (referee) | gemini:gemini-4-argon | grades no reader here and neither disputant |

- **Instrument and blinding.** Every judge uses the set's canonical BEAM rubric instrument (`beam-10m`, `beam-1m`,
  `beam-100k`, `beam-d8`) with the same prompts, recorded as `<instrument>@<judge>`, at the judge's default effort and
  replicate 0. The prompt shows only the rubric item and the answer, never the system or the reader.
- **Family rule.** No model judges its own family's rows (GST-767), and particle-1 never judges (GST-605); the runner
  refuses either. The canonical judge breaks the rule today on the gpt-6.1-sol rows; the frontier view removes that.
- **One judge per reader.** The judge depends only on the reader, so every per-reader contrast is within one judge.
  The report also gives the gpt-6.1-sol-judged two-reader mean (Opus and Sonnet rows) as a single-judge view.
- **Reuse.** A frontier judgment already in custody is reused when its answer id, `<instrument>@<judge>` id, instrument
  sha256 and replicate 0 match and it parsed: the receipts' frontier column with A19's `frontier-redo.ndjson` applied,
  and paid second-judge outs (GBEV-35, GBEV-39) passed as `--root second-judge=<out>`. An out whose `upstream.json` or
  any receipt does not say `keyless: false` is refused (KEYLESS_SOURCE). Opus judgments of Sonnet rows break the family
  rule and are not reused.
- **Reuse check.** Before the census reuses a judge's old judgments, that judge re-judges a seeded 100 of them in a
  fresh cache (`reuse-check`). They are reused if pass-or-fail agreement is at least 95%; otherwise every one of that
  judge's old judgments is judged again (about $55 at most, from the reserve). The census refuses to start while a
  judge it would reuse has no recorded check.

## Which judge is right: two blind measures

**1. The referee.** gemini-4-argon judges, with every rubric item, every answer where the canonical and frontier judges
disagree at the pass threshold (0.5), and a seeded sample of 600 answers where they agree (seed `gst-1365-referee` over
sorted answer ids, allocated across set, reader family and system in proportion to their size). It sees the rubric
item and the answer, never another judge's verdict. The referee runs only once its strata are frozen: complete, or
dropped by the cut order.

- *Validity:* the referee must match the unanimous verdict on at least 85% of the agreement sample, or it is reported
  and not used.
- *p_F:* the share of disagreements where the referee sides with the frontier judge, with a Wilson 95% interval,
  pooled, for Claude rows (gpt-4.1-mini against gpt-6.1-sol) and for gpt-6.1-sol rows (gpt-4.1-mini against
  claude-opus-5-5), and broken down by BEAM category, by reader and system, and by direction (frontier judge stricter or
  more lenient).
- *K:* each answer's verdict by two of the three judges (on agreeing answers, the shared verdict). K is a share of
  correct answers, reported beside the other views and not part of the rule.

**2. Known-answer controls.** A custody step builds them from BEAM's own gold answers with no model call: 150
rubric-scored questions with a gold answer, 50 each from S1, S2b and D8, stratified by category with event_ordering
left out (it scores rank order), seed `gst-1365-controls`.

| Control | Text | Correct verdict |
|---|---|---|
| C1 | the gold answer as written | pass |
| C2 | the gold answer of another non-abstention question in the same conversation and category, skipping any whose gold normalizes equal to the question's own; an abstention question draws from a non-abstention question in its conversation, and the number of C2 answers on abstention questions is reported | fail |
| C3 | a fixed abstention: "I can't find that in our conversation history." | fail, except pass on abstention questions |
| C4 | the gold answer inside a fixed hedge: "I'm not fully certain, but it appears that <gold>. The history may be incomplete." | pass (BEAM's prompt does not penalize hedging) |

All four judges (gpt-4.1-mini, gpt-6.1-sol, claude-opus-5-5 and gemini-4-argon) judge every control answer: 600, less
one for each question with no eligible C2 text, which the report counts. The family rule does not apply to gold texts. The report gives each judge's error rate per control and in total, with
paired differences between judges clustered by question. A judge is *more accurate on known answers* if its total
error rate is at least 3 points lower with a paired 95% interval that excludes 0.

**Which-judge verdict.** The frontier judge is right if the referee is valid, p_F's interval lies entirely above 0.5,
and the controls do not show gpt-4.1-mini more accurate. The canonical judge is right if the referee is valid, p_F's
interval lies entirely below 0.5, and the controls do not show the frontier judge more accurate. Otherwise the question
is unsettled. The verdict is given pooled and for each frontier judge's rows.

## Decision rule

**Estimand.** As F6 publishes it: gbrain's score minus the comparator's, the three-reader mean, paired by question.
Views: M, the canonical judge as published (every reader replicate); M0, the canonical judge on replicate 0, the answers
a frontier judge saw; F, the row's frontier judge; K, two of three. The judge effect is δ = Δ_F − Δ_M0, so a reader
with replicates (Sonnet x3 on Q1's S1 competitor rows) is compared on the same answers.

**One cohort.** Every view of a contrast is computed on one common cohort: the published cohort's questions where every
reader's value exists for both systems under M0 and F (and the referee, for K). It is reported beside the published
cohort. A contrast whose common cohort is short of the published cohort by more than 2% of its questions, or loses any
whole conversation, is INCOMPLETE and gets no outcome class. A judge error (a judgment still unparsable after three
attempts) is final: the answer counts as judged and unscored, so it leaves the common cohort like any missing value and
leaves no stratum partial, and in a reuse check it counts as a disagreement.

**Reproduction first.** Before any frontier number, `plan` and `summary` run scoreboard.ts's own derive() on each
receipt, require every in-scope comparison's Δ, interval and cohort to equal the committed scoreboards' values below to
their rounding, and require the runner's canonical cell values and contrasts to equal derive()'s. Any mismatch refuses
(REPRODUCTION_FAILED) and nothing is judged or summarized.

**The contrasts.** A contrast is *separated* if its canonical interval excludes 0 and *level* if it does not.

| Family | Set | Comparator | Canonical Δ, points (95% interval), cohort |
|---|---|---|---|
| F6 | S1 | extract-first | +2.2 (-1.9 to 6.1), 199 |
| F6 | S1 | memory-bank | +5.7 (1.6 to 9.7), 199 |
| F6 | S1 | verbatim-session | +10.2 (3.4 to 16.8), 199 |
| F6 | S1 | temporal graph 0.31 | +12.4 (7.1 to 17.4), 199 |
| F6 | S1 | file agent | not published as a paired contrast (68.2% vs 61.0%); its canonical interval is computed in the run |
| F6 | S2b | extract-first | +4.8 (2.6 to 7.1), 240 |
| F6 | S2b | memory-bank | +1.3 (-0.9 to 3.7), 240 |
| F6 | S2b | graph-pipeline | +3.7 (0.3 to 7.4), 240 |
| F6 | S2b | verbatim-session | +6.9 (4.1 to 9.9), 240 |
| F6 | S2b | temporal graph 0.31 | +9.3 (5.2 to 13.3), 240 |
| D8 | D8 | memory-bank | +3.8 (1.0 to 6.7), 300 |
| D8 | D8 | graph-pipeline | +3.8 (1.6 to 6.1), 300 |
| D8 | D8 | hybrid | +4.3 (2.3 to 6.5), 300 |
| Q1 | S1 | extract-first (component, 8k) | -3.0 (-8.1 to 1.8), 197 |
| Q1 | S1 | memory-bank (component, 8k) | +0.6 (-4.5 to 5.2), 197 |
| Q1 | S1 | verbatim-session (component, 8k) | +5.1 (0.5 to 9.2), 197 |
| Q1 | S1 | file agent (whole system) | -8.7 (-16.4 to -1.4), 198 |
| Q1 | S2b | extract-first | -0.3 (-3.7 to 3.5), 240 |
| Q1 | S2b, S2a | file agent | computed in the run |
| Q1 | S2a | extract-first | -1.8 (-6.9 to 3.1), 140 |

**Outcome per contrast** (from Δ_F, δ and each reader's Δ_F on the common cohort):
- **HOLDS.** A separated contrast holds if Δ_F has the canonical sign, its interval excludes 0, and its size has not
  changed. A level contrast holds if Δ_F's interval includes 0 or Δ_F has the canonical sign.
- **SIZE CHANGED.** The sign holds, but δ's interval excludes 0 and |δ| is at least the larger of 3 points and half of
  |Δ_M|.
- **WEAKENED.** For a separated contrast, Δ_F's interval includes 0. Or any single reader shows a confident reversal:
  that reader's Δ_F interval excludes 0 on the other side.
- **REVERSED.** The three-reader Δ_F interval excludes 0 on the side opposite Δ_M.
- **Rank, per set.** gbrain's position (ahead, level, behind) against each canonically separated comparator under F.
  The rank holds if every such position is unchanged.

**Family verdicts**, one line each for F6 S1+S2b (the primary verdict), D8 and Q1:
- **HOLDS:** every contrast holds and the rank holds on each set.
- **HOLDS IN SIGN AND RANK, SIZE RESTATED:** no WEAKENED or REVERSED contrast, and at least one SIZE CHANGED.
- **WEAKENED:** at least one WEAKENED, none REVERSED, and the S1 and S2b ranks hold.
- **FAILS:** any REVERSED contrast, or a rank change on S1 or S2b.
- **INCOMPLETE:** the family has an INCOMPLETE contrast or rests on a stratum left partial. A family the cut order
  dropped is reported "not run (cut order)".

**Three-reader primacy.** The verdict uses F's three-reader mean, as the question asks ("under a frontier judge"). The
per-reader contrasts, the canonical M and M0 views, K and the single-judge two-reader view are reported beside it. A
per-reader difference smaller than that reader's minimum detectable difference (below) is not read as a change.
Absolute levels (for example S1 gbrain's 61.0%) are expected to move and are reported, not ruled on.

**Statistics.** Conversation-cluster paired bootstrap (eval/runner/stats/paired.ts) with 10,000 draws and seed
`gst-1365` for Δ_M0, Δ_F, Δ_K, δ and every per-reader Δ; Wilson 95% intervals for p_F, referee validity and reuse
agreement. The canonical Δ_M of a published contrast is its published value and interval.

## Power

Minimum detectable judge effects (δ) at 80% power and two-sided α = 0.05, assuming 14% disagreement at the pass
threshold, a root-mean-square score shift of 0.6 on disagreeing answers and 0.1 on the rest, a correlation of 0.2
between systems and between readers on a question, and a design effect of 1.3 for conversations. Stage 0 measures the
disagreement and shifts from existing judgments and records them in a dated note below before any spend; the rule does
not change.

| Set | Per reader | Three-reader mean | At 10% to 18% disagreement |
|---|---:|---:|---|
| S1 (199 questions, 10 conversations) | 7.0 points | 4.7 points | 4.1 to 5.3 |
| S2b (240, 24) | 6.3 | 4.3 | 3.8 to 4.8 |
| D8 (300, 10) | 5.7 | 3.9 | 3.4 to 4.3 |
| S2a, Q1 only (140) | 8.3 | 5.7 | 4.9 to 6.3 |
| S1 and S2b pooled, for comparators on both sets | | 3.2 | 2.8 to 3.6 |

Contrasts at or above their set's figure can be checked against a reversal with at least 80% power: S1 memory-bank,
verbatim-session, temporal graph and file agent, and S2b extract-first, verbatim-session and temporal graph. D8's three
contrasts sit at the edge. The two level contrasts (S1 extract-first, S2b memory-bank) and S2b graph-pipeline cannot be
powered against a judge-caused reversal and are reported as intervals.

## Money

| Judge | Per answer, central | Conservative |
|---|---:|---:|
| gpt-6.1-sol | $0.0188 (measured, GBEV-35) | $0.025 |
| claude-opus-5-5 | $0.068 | $0.10 |
| gemini-4-argon | $0.03 | $0.10 |
| gpt-4.1-mini (controls only) | $0.003 | $0.003 |

| API line | Central | Conservative |
|---|---:|---:|
| A. F6 S1 census | $93 | $133 |
| B. F6 S2b census | $139 | $198 |
| C. Q1 rows | $72 | $103 |
| D. D8 census | $127 | $180 |
| Referee | $75 | $251 |
| Controls | $72 | $137 |
| Smoke and reuse checks | $11 | $16 |
| **Total** | **$589** | **$1,018** |

- **Ceiling.** One GST-1365 ledger with one writer. The ceiling is pinned in code at $850; only a recorded
  `--reserve-grant <usd>=<GBEV-3's words>` raises it, by at most $250, to $1,100. A lease that would pass the ceiling is
  refused before it opens.
- **Before any lease.** The runner attests this preregistration (committed and on origin) into every receipt, checks
  that every task's instrument is this tree's, and checks each judge's key (set, and its free model listing answers).
- **Stops.** LEASE_EXHAUSTED (exit 4): the lease ran out; rerun with a new lease, and the resume skips judged answers.
  CEILING_REACHED (exit 5): final under R71; the check is reported incomplete to GBEV-3 and never retried.
  KEY_MISSING (exit 2): names the variable, never its value. A STOP file in the out directory stops between answers. An
  identity file per stage refuses a resume onto other answers, judges or instruments.
- **Gemini's rate.** The ledger books gemini-4-argon at its 2026-12-01 price ($4 in, $20 out, $0.20 cache read per
  million tokens), twice its list price before then, so a reservation is never short; every receipt also gives list
  spend from usage. Thinking is billed as output: output = max(completion_tokens, total_tokens − prompt_tokens).
- **All-in.** API at most $850, crew credits $650, reserve $250: $1,750, inside R71's $2,000. Expected about $1,150.

**Cut order.** If the smoke's measured rates (`plan --rates-from <smoke out>`) project the API lines above $850, these
cuts are made, first to last, before any census lease (`cut --through <n>`, recorded and never undone):
1. Controls on claude-opus-5-5 and gemini-4-argon drop to 75 questions (25 per set).
2. Q1's S2a rows.
3. The D8 referee.
4. The D8 census.
5. Q1's S2b rows.

Never cut: the S1 and S2b censuses, their referee, or the controls on gpt-4.1-mini and gpt-6.1-sol.

## Order of work

1. Stage 0, free, in custody: `plan` gives coverage, reusable judgments, answers to judge per judge and stratum,
   product failures, projected dollars, the measured disagreement and score shifts, and the contrasts the reusable
   judgments already allow. The measured values are added below as a dated note before any spend.
2. Paid smoke, about $11: 20 answers per frontier judge (`judge --limit 20`), 20 referee answers (`referee --limit 20`),
   and the reuse checks. On every gemini-4-argon response, max(completion_tokens, total_tokens − prompt_tokens) must not
   exceed the `max_completion_tokens` sent; otherwise the reservation is raised by the effort's thinking budget, or the
   native route is used, before any referee lease. The cut order applies if needed.
3. Census leases: S1, S2b, Q1, D8. Then the referee, then the controls, then `summary`.
4. Each paid stage goes to GBEV-3 as a PAID WINDOW REQUEST with all-in spend so far. The check makes no particle-1 call.

## What gets restated

Every replacement is made in place, with a changelog entry in the same commit.

- **HOLDS.** No number changes. The F6 scoreboard gains a dated "Frontier-judge sensitivity (GST-1365)" section with
  Δ under M, F and K and each outcome, rendered in custody as aggregates; README and docs/README.md say the comparisons
  hold under frontier judges.
- **SIZE CHANGED.** The canonical numbers stay (BEAM's protocol judge). Each affected claim sentence in the F6
  scoreboard, and README's comparison block for Q1 rows, gives both judges' differences and intervals.
- **WEAKENED or REVERSED.** Each affected sentence becomes a judge-dependent statement giving both intervals: the F6
  scoreboard's claim sentences, README's current results and comparison block (including the "best external row" label
  if a rank changes), docs/comparison-systems.md where it quotes a contrast, publication.json, and Q1's report for Q1
  rows. docs/corrections.md lists every REVERSED contrast as overstated. No "ahead", "leads" or "trails" wording
  survives that both judges do not support.
- **Which judge leads.** If the frontier judge is right, frontier-judged numbers lead the sensitivity view, and new
  BEAM work (RS1's revisit, any new ranking set) makes the per-row frontier judges canonical or co-primary under the
  family rule; F6's and Q1's canonical numbers stay, labelled "BEAM protocol judge". If the canonical judge is right, a
  note only, and RS1 can keep gpt-4.1-mini with a frontier co-judge. If unsettled, only claims both judges support are
  written.

## Custody

No sealed item leaves the custody host, and no agent reads items: the check is API-only. Corpora open only through
cell.ts's custody gate with `GBRAIN_EVALS_CUSTODY_LOG`, decision id `gst-1365` and a purpose. Every output is counts,
means, intervals and dollars; `summary` refuses to write a report that would hold a question id.

## Not verified at freeze

- claude-opus-5-5's and gemini-4-argon's dollars per answer, and gemini-4-argon's OpenAI-compatible route and thinking
  under the rubric's output limit: the smoke measures them.
- Reusable coverage: read from F6's published coverage table and GBEV-35's receipts until Stage 0 counts it. If Q1's
  think and file-agent rows turn out unjudged on S2b and S2a, judging them costs up to about $81, from the reserve.
- That `GEMINI_API_KEY` reaches the run's process on the custody host: the key preflight checks it before any lease.
- Referee independence: frontier models may share errors; the known-answer controls are the judge-free check.

## Disclosures in the results

The results file closes with a Disclosures section carrying "gbrain is Garry Tan's own project." and the OpenAI line,
because it reports gbrain's comparisons and gpt-6.1-sol's reader rows. A judge triggers no line. The check makes no
particle-1 call, so the Particle line does not apply.

## Amendments

**2026-11-05: Stage 0, before any spend.** `plan` ran on the custody host at 989bb472 with F6's receipt, Q1's receipt
and the eight paid second-judge outs from the particle-1 add-on (each `keyless: false`). The reproduction check passed:
every in-scope published contrast and canonical cell matched scoreboard.ts's derive(). Nothing here changes the rule, a
cell, a judge, the cut order or the ceiling.

- **Coverage.** Q1's competitor rows are the same answers as F6's, so each answer is counted once, in the first stratum
  that holds it (A, then B, C, D). Still to judge: 2,130 in A, 3,301 in B, 2,408 in C and 3,600 in D, or 6,933 by
  gpt-6.1-sol and 4,506 by claude-opus-5-5 (the estimate above was 7,133 and 4,354). The census covers 15,382 answers,
  of which 3,943 already have a reusable family-clean frontier judgment.
- **Measured from existing judgments.** 5,440 answers have both a canonical and a family-clean frontier judgment. They
  disagree at the pass threshold on 15.9%, with a root-mean-square score shift of 0.69 on disagreeing answers and 0.16
  on the rest (assumed above: 14%, 0.6 and 0.1).
- **Power at the measured values**, with the same model (correlation 0.2 between systems and between readers, design
  effect 1.3):

  | Set | Per reader | Three-reader mean |
  |---|---:|---:|
  | S1 (199) | 8.9 points | 6.1 points |
  | S2b (240) | 8.1 | 5.5 |
  | D8 (300) | 7.2 | 4.9 |
  | S2a, Q1 only (140) | 10.6 | 7.2 |
  | S1 and S2b pooled | 6.0 | 4.1 |

  Contrasts at or above their set's three-reader figure: F6's S1 verbatim-session, temporal graph and file agent, F6's
  S2b verbatim-session and temporal graph, and Q1's S1 file agent. Now below it, and reported as intervals like the
  level contrasts: F6's S1 memory-bank (5.7 against 6.1), F6's S2b extract-first (4.8 against 5.5), D8's three
  contrasts (3.8 to 4.3 against 4.9) and Q1's S1 verbatim-session (5.1 against 6.1).
- **Money, before the smoke.** With each answer counted once, the API lines come to $600 at central rates (census
  $437, referee $91 on about 2,450 expected disagreements plus the 600-answer agreement sample, controls $72) and
  $1,066 at conservative rates, which would fire cut steps 1 to 4 and leave $728. The smoke's measured rates replace
  these before any census lease, and the cut decision counts the smoke's and reuse checks' settled spend against the
  $850 ceiling as well.
- **Runner fix.** Stage 0 found that `plan` counted the answers Q1 shares with F6 twice, in stratum C's census line and
  in the referee line. That would have overstated the projection by about $85 at central rates and fired one cut step
  too many at conservative rates. The projection now counts each answer once.

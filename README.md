# gbrain-evals

gbrain-evals is the public test suite for [gbrain](https://github.com/garrytan/gbrain), a memory system for AI agents,
and it asks one question: does an agent get more right with gbrain than without it? It holds the test data, the systems
we compare against, the scoring code and every published result, so you can check any claim or run the same tests on
another system.

This page has three parts: [what gbrain does](#what-gbrain-does), [its current results](#current-results) and
[how it compares with other memory systems](#how-gbrain-compares). Everything above [Changelog](#changelog)
describes gbrain as this repository pins it today ([the pin](docs/gbrain-under-test.md#the-pin)); the changelog at the
bottom records how this page changed.

## What gbrain does

gbrain keeps your notes, conversations and documents as Markdown files you own, indexes them in Postgres or embedded
PGLite, and gives an agent such as Claude Code or Codex tools to save, search, update and forget what it knows, over a
CLI or an MCP server. It mixes exact-word search, meaning-based search and an optional reranker, follows stored
relationships between pages, hands the agent whole conversations, and labels everything it returns by source. Without
an embedding key, a search still finds pages that hold most of the question's words. On a personal brain it keeps a
redacted, searchable archive of your agent conversations, one page per conversation per day, and one brain can hold a
company's notes beside your own or serve several people, each with their own key and a folder only they can read. This
repository installs gbrain's newest release, which this page calls the pin: [the gbrain under
test](docs/gbrain-under-test.md#the-pin) names its version and commit, and [CLAUDE.md](CLAUDE.md#choose-the-gbrain-build)
keeps it at the newest release. Results measured at earlier commits name their own commit, and that page lists every
capability and what changed between those commits and the pin.

## Current results

- **We learned that gbrain's read tools turn questions about a person's own notes from mostly "I don't know" into mostly
  right answers. You should give your agent gbrain's `query`, `search` and `get_page` tools and let the model that
  answers call them.** Opus 5.5 goes from 13.3% with no retrieval to 86.7%, and particle-1 from 9.3% to 68.0%. A
  summarising helper between gbrain and the model added no right answers and cut answers that are right and cite only
  supporting pages by 14.3 points for Opus and 14.4 for particle-1.
- **We learned that on hard questions about a large company's documents, gbrain is near level with an agent that
  greps the same files on two new worlds, at its newest release and at an October build alike, and behind it where
  sources disagree. You should measure a memory tool on more than one world, with today's readers, before quoting its
  lead.** On two new worlds gbrain v0.60.742.0 got 81.25% right against 78.75% (+2.50 points, interval -1.50 to +6.50),
  and trailed by 16.25 points where sources disagree. The October build `09d21554d`, which led by 8.50 on other worlds,
  got 82.75% on the same tasks (+4.00, 0.00 to +8.25; the newest build scored 1.50 points below it, -4.50 to +1.50), so
  the smaller lead is not a gbrain regression.
- **We learned that gbrain beats the plain Postgres search a developer would build first: full-text plus pgvector,
  fused by rank. You should use gbrain rather than hand-roll that search for an agent's memory.** On LongMemEval it
  found every conversation a question needs in its top five for 451 of 470 questions against 414, and its results gave
  Opus 5.5 474 right answers of 500 against 445. With its trust labels, agents adopted an attacker's planted claim in
  2.8% of sessions against 10.2% with a plain Postgres memory.
- **We learned that on long chat histories, and on questions that name what they ask about, a simpler setup can score
  as high as gbrain or higher. You should test those baselines on your own workload before choosing.** Pasting the
  whole history into the prompt answered 471 of 500 questions from LongMemEval, a public benchmark of questions about
  old chats, against 468 for gbrain's retrieval (Sonnet 5.5 reader), at about 7.4 times gbrain's reader cost per
  question with one question per history. On BEAM-10M, whose chat histories run to about 10 to 11 million tokens each,
  an agent with `grep` over the same files scored 67.4% against 55.2% for gbrain's whole system, with Opus 5.5
  reading both, 12.2 points ahead (95% interval 6.4 to 18.4), and a plain keyword ranker matched gbrain on reworded relationship questions. A history asked several questions can be read
  from a prompt cache after the first, which we haven't measured.

Each row of the first table names the alternative a developer would use instead of gbrain, measured on the same tasks
with the same reader and judge. Each gbrain cell opens with how far gbrain is ahead, level or behind, and each row's
gbrain commit and report sit in small type under what it measures. The second table holds checks of gbrain's own
behaviour, such as `forget` leaving nothing behind or a sync catching up, where there is nothing to compare against.

<table>
<thead>
<tr>
<th valign="top" align="left" width="34%">What we measure</th>
<th valign="top" align="left" width="28%">Without gbrain</th>
<th valign="top" align="left" width="38%">With gbrain</th>
</tr>
</thead>
<tbody>
<tr><th valign="top" align="left" colspan="3">Agents answering with and without gbrain</th></tr>
<tr>
<td valign="top">Right answers to questions about one person's own notes, asked in other words (99 tasks on Garry Tan's own brain), Opus 5.5<br><sub>gbrain <code>98dda48fb9fd</code> (v0.60.613.0) · <a href="docs/benchmarks/2026-11-09-live-recall-phase2.md">Live recall</a></sub></td>
<td valign="top">13.3% with no retrieval</td>
<td valign="top"><h3>+73.5 points</h3><b>86.7%</b> with gbrain's tools; the gain's 95% interval is 63.9 to 82.5¹</td>
</tr>
<tr>
<td valign="top">The same questions, particle-1<br><sub>gbrain <code>98dda48fb9fd</code> (v0.60.613.0) · <a href="docs/benchmarks/2026-11-09-live-recall-phase2.md">Live recall</a></sub></td>
<td valign="top">9.3% with no retrieval</td>
<td valign="top"><h3>+58.8 points</h3><b>68.0%</b> with gbrain's tools; the gain's 95% interval is 48.5 to 68.8¹ ²</td>
</tr>
<tr>
<td valign="top">Hard questions about a large, messy company, answered correctly by agents (two new worlds of about 55,000 documents; Opus 5.5 and GPT-6.2 Sol)<br><sub>gbrain <code>ae8201041</code> (v0.60.742.0) · <a href="docs/benchmarks/2026-11-19-cat40-hard-newest.md">Hard company questions, newest build</a></sub></td>
<td valign="top">the same files with <code>grep</code>: 315 of 400 (78.75%)</td>
<td valign="top"><h3>Level: +2.50 points</h3><b>325 of 400 (81.25%)</b>; the gain's interval is -1.50 to +6.50, so the two are at parity; an October build scores within noise of the newest on these worlds, so the smaller lead than October's is not a gbrain regression³</td>
</tr>
<tr>
<td valign="top">The same hard company questions, particle-1 (a low-cost reader)<br><sub>gbrain <code>ae8201041</code> (v0.60.742.0) · <a href="docs/benchmarks/2026-11-19-cat40-hard-newest.md">Hard company questions, newest build</a></sub></td>
<td valign="top">the same files with <code>grep</code>: 6 of 200 (3.0%)</td>
<td valign="top"><h3>+30.5 points</h3><b>67 of 200 (33.5%)</b> with gbrain's tools; the gain's 95% interval is 24.5 to 37.0. Opus 5.5 with gbrain got 158 of 200</td>
</tr>
<tr>
<td valign="top">The same questions where two sources disagree and one governs<br><sub>gbrain <code>ae8201041</code> (v0.60.742.0) · <a href="docs/benchmarks/2026-11-19-cat40-hard-newest.md">Hard company questions, newest build</a></sub></td>
<td valign="top">the same files with <code>grep</code>: 79 of 80 (98.75%)</td>
<td valign="top"><h3>Behind: -16.25 points</h3><b>66 of 80 (82.50%)</b>; the gap's 95% interval is -23.75 to -10.00⁴</td>
</tr>
<tr>
<td valign="top">Leaks (fewer is better): finance-only text reaching the agent's context in 100 permission runs, where the agent works for an account manager outside finance who isn't allowed to see it; first, easier company world (five frontier models)<br><sub>gbrain <code>51f865d78</code> · <a href="docs/benchmarks/2026-10-02-model-ladder.md">Permission runs</a></sub></td>
<td valign="top">the same files: leaks in 100 runs; plain Postgres: 97, with 4 of them reaching an answer</td>
<td valign="top"><h3>100 → 0 leaking runs</h3><b>0 of 100</b> runs leak finance-only text into the agent's context or its answer</td>
</tr>
<tr>
<td valign="top">Right answers on 150 LongMemEval questions, against pasting each whole history (about 50 conversations) into the prompt<br><sub>gbrain <code>c5fb0201</code> · <a href="docs/benchmarks/2026-10-07-longmemeval-w10c-full-context.md">Whole-history comparison</a></sub></td>
<td valign="top">whole history: 144 (Sonnet 5.5 reader) and 141 (GPT-6.1 Sol) of 150</td>
<td valign="top"><h3>Within the margin, at about a seventh of the cost</h3><b>139</b> and <b>137</b> of 150, within the preregistered 7-point margin, at about a seventh of the reader cost per question, with one question per history⁵</td>
</tr>
<tr>
<td valign="top">Right answers about very long chat histories (BEAM-10M, never used to tune gbrain; answer models Opus 5.5, GPT-6.2 Sol and particle-1; 8,000 tokens of memory)<br><sub>gbrain <code>7f162344</code> (v0.60.748.0), measured 2026-11-20 · <a href="docs/benchmarks/2026-11-19-beam10m-newest/results/README.md">BEAM-10M on the newest release</a></sub></td>
<td valign="top">the same setup at gbrain v0.60.493.0 (measured 2026-11-03), with Opus 5.5 reading: 59.1%</td>
<td valign="top"><h3>Level: −0.1 points</h3><b>55.8%</b>, the mean of the three answer models (199 of 199 questions); with Opus 5.5 reading both builds, 59.1% now, a change of −0.1 points (95% interval −3.2 to +3.1)⁶</td>
</tr>
<tr>
<td valign="top">The same questions, against an agent with list, <code>grep</code> and read tools over the same files (each at its own default amount of evidence; answer models Opus 5.5, GPT-6.2 Sol and particle-1)<br><sub>gbrain <code>7f162344</code> (v0.60.748.0), measured 2026-11-20; file agent stored from October 2026, not re-run · <a href="docs/benchmarks/2026-11-19-beam10m-newest/results/README.md">BEAM-10M on the newest release</a> · <a href="docs/benchmarks/2026-10-06-scoreboard/scoreboard.md">Head-to-head scoreboard</a></sub></td>
<td valign="top">the file agent: 67.6% (Opus 5.5, GPT-6.1 Sol and Sonnet 5.5 reading, gpt-4.1-mini judge); 67.4% with Opus 5.5 reading under gbrain's judge</td>
<td valign="top"><h3>12.2 points behind</h3><b>50.6%</b>, the mean of the three answer models (199 of 199 questions); with Opus 5.5 reading both, 55.2% against 67.4%, 12.2 points behind (95% interval 6.4 to 18.4)⁶</td>
</tr>
<tr><th valign="top" align="left" colspan="3">Finding the right evidence</th></tr>
<tr>
<td valign="top">Finding every conversation a question needs in the top five results (LongMemEval; a question counts only if all its conversations are found)<br><sub>gbrain <code>109b992</code> · <a href="docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md">Recount</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/longmemeval/results.md">Baseline</a></sub></td>
<td valign="top">plain Postgres full-text plus pgvector search, fused by reciprocal rank: 414 of 470 (88.1%), with gbrain ahead on 45 questions and behind on 8 (p = 2.4e-7)</td>
<td valign="top"><h3>+37 questions</h3><b>451 of 470 (95.96%)</b></td>
</tr>
<tr>
<td valign="top">Right answers on LongMemEval with gbrain's release search settings and a Sonnet 5.5 reader (gbrain's note-taking benchmark reader, not its production <code>think</code>; official GPT-4o judge)<br><sub>gbrain <code>c5fb0201</code> · <a href="docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md">End to end at the pin of the day</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/longmemeval/results.md">Baseline</a></sub></td>
<td valign="top">the whole history in the prompt: 471 of 500, no measurable difference (p = 0.72), at about 7.4 times the reader cost per question²²; plain hybrid search's top five conversations: 445 (gbrain ahead, p = 0.004); the question alone: 58</td>
<td valign="top"><h3>+23 over plain hybrid search</h3><b>468 of 500 (93.6%)</b>; level with the whole history, which costs about 7.4 times as much to read</td>
</tr>
<tr>
<td valign="top">Right answers from a newer reader, Opus 5.5, reading search results saved on September 29 (official GPT-4o judge)<br><sub>gbrain <code>a7cb37b</code> retrieval · <a href="docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md">Reader replay</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/longmemeval/results.md">Baseline</a></sub></td>
<td valign="top">plain hybrid search's top five conversations, same reader and judge: 445 of 500, with gbrain ahead on 43 questions and behind on 14 (p = 0.0002)</td>
<td valign="top"><h3>+29 answers</h3><b>474 of 500 (94.8%)</b>, above Sonnet 4.6's 451 on the same saved results (Holm-adjusted p = 0.0002)⁷</td>
</tr>
<tr>
<td valign="top">Finding the conversation when a search quotes a saved message word for word (LongMemEval-S, 500 questions)<br><sub>gbrain <code>fecc7827</code> (merged as <code>f05943e65</code>) · <a href="docs/benchmarks/2026-10-09-verbatim-probe-preregistration.md">Verbatim probe</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/longmemeval/results.md">Baseline</a></sub></td>
<td valign="top">plain hybrid search: the quoted conversation first for 491 of 500 and in the top ten for 499, no measurable difference²³; strict recall in the top ten 480, behind gbrain</td>
<td valign="top"><h3>Level at the ceiling</h3><b>500 of 500</b> return the conversation as a clean read (was 429); strict recall in the top ten unchanged at 496, against 480</td>
</tr>
<tr>
<td valign="top">Right answers when the reader gets whole conversations instead of bare passages (a sealed set never used in development)<br><sub>gbrain <code>d44296c</code> · <a href="docs/benchmarks/2026-10-02-sealed-v2-decision-1.md">Sealed decision</a></sub></td>
<td valign="top">the question alone, no memory: 40 of 200, every one an abstention (0 of the 160 answerable), with the same reader (Sonnet 4.6) and judge in the set's solvability check</td>
<td valign="top"><h3>40 → 192 of 200</h3><b>192 vs 132 of 200</b> with whole conversations against bare passages (60 gained, 0 lost)</td>
</tr>
<tr>
<td valign="top">Concept questions in other words, the right page ranked first (with reranker)<br><sub>gbrain <code>d44296c</code> · <a href="docs/benchmarks/2026-10-02-concept-vector-rerank.md">Concept search</a></sub></td>
<td valign="top">a plain vector index: 118, or 128 with the same Voyage reranker</td>
<td valign="top"><h3>Level with a reranked index</h3><b>130 of 181</b>, level with the reranked vector index</td>
</tr>
<tr>
<td valign="top">Reworded one-hop relationship questions, recall in the top five<br><sub>gbrain <code>3a284ae</code> · <a href="docs/benchmarks/2026-10-01-n9-multi-hop.md">Relationship questions</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/retrieval/results.md">Baseline</a></sub></td>
<td valign="top">a keyword (BM25) ranker: 0.616, no measurable difference (gbrain ahead on 19 questions, behind on 33, p = 0.07)¹⁷; vector-only 0.438 and plain hybrid 0.467, both behind gbrain (p = 0.004 and 0.020)</td>
<td valign="top"><h3>Level with BM25</h3><b>0.411 → 0.537</b>, 19 better, 0 worse¹⁶; BM25 leads on the point estimate¹⁷; ahead of vector-only and plain hybrid search</td>
</tr>
<tr>
<td valign="top">Finding who attended a meeting from a <code>## Attendees</code> list of links, the form gbrain documents<br><sub>gbrain <code>c5fb0201</code> · <a href="docs/benchmarks/2026-10-06-attendance-world.md">Attendance world</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/retrieval/results.md">Baseline</a></sub></td>
<td valign="top">a keyword (BM25) ranker: 18.2% "who attended" recall in the top five; plain hybrid search 24.7% (gbrain ahead on 48 and 44 of 50 meetings, behind on none)</td>
<td valign="top"><h3>80% vs 24.7% recall</h3><b>132 of 132</b> attendees stored, 0 false; "who attended" recall in the top five 32% → 80%</td>
</tr>
<tr>
<td valign="top">Returning only the right facts (PrecisionMemBench, which penalises extra results; tight mode with reranker)<br><sub>gbrain <code>2efaaf8f</code> · <a href="docs/benchmarks/2026-09-09-retrieval-refresh.md">Retrieval refresh</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/retrieval/results.md">Baseline</a></sub></td>
<td valign="top">plain hybrid search cut to one result: 0.563 precision, 0.810 recall, no measurable difference (Holm p = 0.76)¹⁸</td>
<td valign="top"><h3>Level</h3><b>0.586 precision</b>, 0.825 recall</td>
</tr>
<tr><th valign="top" align="left" colspan="3">Keeping memory correct, private and safe</th></tr>
<tr>
<td valign="top">Joining different people or companies in a synthetic stress test (fewer false merges is better, with recall within 10 points)<br><sub>gbrain <code>0a008fe5</code> (v0.60.738.0) · <a href="docs/benchmarks/2026-11-18-entity-dedupe-h2h.md">Duplicate-finder head-to-head</a></sub></td>
<td valign="top">Automatic merges on the same 676 different-entity pairs: 422 for <code>ext-extract-first</code>, 423 for <code>ext-memory-bank</code>, and 438 for patched default <code>ext-graph-pipeline</code>. The temporal-graph system found more real duplicates, and the tuned graph-pipeline setting made fewer false merges but left more pages unresolved.</td>
<td valign="top"><h3>360 of 676 proposed, 9.17 to 11.54 points fewer</h3>The proposed tier found 290 of 436 real pairs, within the recall margin against those three settings, people and companies combined. On companies alone, no comparison clears both tests: gbrain's company recall is higher than all three, but none of the company false-merge differences was detected at this sample size (gbrain 64 of 188, against 62, 68 and 53). In the measured automatic tier, 36 of 488 different-person pairs joined and 0 of 188 different-company pairs joined. The shipping design doesn't auto-link people.</td>
</tr>
<tr>
<td valign="top">An attacker's false claim from an email or a relayed tool result, adopted in a later session (fewer is better; Opus 5.5, Sonnet 5.5, GPT-6.1 Sol)<br><sub>gbrain <code>c2f10ee8</code> to <code>5b9c814b</code> (shipped as <code>d4dc2d4d8</code>); keyless at <code>6ce7195b4</code> · <a href="docs/benchmarks/2026-10-08-memory-trust-results-paid.md">Memory trust</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/memory-trust/results.md">Baseline</a></sub></td>
<td valign="top">an agent with a plain Postgres memory and no trust labels: 6.6% (Opus 5.5), 12.1% (Sonnet 5.5) and 12.1% (GPT-6.1 Sol) of sessions, with gbrain ahead on all three (p = 0.02, 2e-6 and 0.0005); 1 of 355 instruction-worded injections followed</td>
<td valign="top"><h3>Fewer adopted on all three models</h3><b>1.5% to 5%</b> of sessions with trust labels shown, 5.1% to 10.6% with them stripped; <b>0 of 360</b> instruction-worded injections followed per model; the checks that need no API keys pass at the pin, and CI runs them on every pull request</td>
</tr>
<tr>
<td valign="top">Finding notes that contradict each other: conflicts found (more is better) and false flags on notes that don't (fewer is better)<br><sub>gbrain <code>77cf8e111</code> · <a href="docs/benchmarks/2026-10-11-wave14-repin.md#the-paid-n2-judge-arm">Contradiction re-run</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/judgment/results.md">Baseline</a></sub></td>
<td valign="top">the same model with a plain prompt: 150 of 150 conflicts, but <b>24 of 40</b> dated changes and <b>29 of 51</b> compatible pairs flagged</td>
<td valign="top"><h3>24 → 0 and 29 → 4 false flags</h3><b>146 of 150</b> conflicts found (4 missed) with the default judge model (<code>claude-haiku-4-5</code>); 0 of 40 dated changes and 4 of 51 compatible pairs flagged</td>
</tr>
<tr>
<td valign="top">The same contradiction finding on current models<br><sub>gbrain <code>c5fb0201</code> · <a href="docs/benchmarks/2026-10-06-n2-judges.md">Contradiction judges</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/judgment/results.md">Baseline</a></sub></td>
<td valign="top">a plain prompt: 150 of 150 conflicts for GPT-6 Luna, Sonnet 5.5 and GPT-6.1 Sol, 149 for Opus 5.5; Luna and Sonnet also flag 27 and 13 of 251 compatible pairs, while Sol and Opus flag none, no measurable difference for those two¹⁹</td>
<td valign="top"><h3>Ahead for Luna and Sonnet; level for Sol and Opus</h3><b>150 of 150</b> conflicts and <b>0 of 251</b> compatible pairs flagged, for each of four current models; the cheapest passing one costs $0.24 per 1,000 pairs</td>
</tr>
<tr><th valign="top" align="left" colspan="3">Writing and syncing memory</th></tr>
<tr>
<td valign="top">Labeled timeline events found in meetings and chats (more is better), and wrong events per page (fewer is better)<br><sub>gbrain <code>b9ee931</code> · <a href="docs/benchmarks/2026-10-04-auto-chronicle-rerun.md">Timeline extraction</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/judgment/results.md">Baseline</a></sub></td>
<td valign="top">the same model (Sonnet 4.6) with a plain prompt: 33 and 36 of 38, 0.54 and 0.36 wrong per page, no measurable difference by the preregistered page test (p = 0.06)²⁰</td>
<td valign="top"><h3>Level by the preregistered test</h3><b>37 and 38 of 38</b>, 0.04 wrong per page</td>
</tr>
<tr>
<td valign="top">Useful material kept when an agent session becomes a memory page<br><sub>gbrain <code>079941d2</code> (shipped as v0.47.8.0) · <a href="docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md">Session pages</a> · <a href="docs/benchmarks/2026-11-17-readme-baselines/judgment/results.md">Baseline</a></sub></td>
<td valign="top">the same model (Sonnet 4.6) writing the page from a plain prompt: 80.3% judged, 68.5% with quoted evidence²¹</td>
<td valign="top"><h3>+7.6 points</h3><b>88.1%</b> judged (paired, 95% interval 0.6 to 14.4)²¹, while the judge's calibration awaits a person's review; 74.9% with quoted evidence</td>
</tr>
</tbody>
</table>

**Checks of gbrain's own behaviour (nothing to compare against).**

| What we check | Result | gbrain commit | Report |
|---|---|---|---|
| **Finding the right evidence** | | | |
| Questions chaining two or three relationships (multi-relation planner, held-out; no baseline is run on a held-out set) | **24 better, 0 worse**; +27 points in the share of questions with every answer in the top ten | `94bd52e01` (shipped in v0.60.60.0) | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md) |
| Vector search inside a 10% source or visibility scope, 1M to 2M chunks on Postgres | recall in the top 50 **0.96 to 0.99** (was 0.52 to 0.77)⁸ | `2e84d234e` | [Scoped vector search](docs/benchmarks/2026-10-09-hnsw-scale.md) |
| Graph walks on fictional graphs of 10,000 to 1,000,000 pages: Postgres against HydraDB as the walk engine | Postgres faster at every size, same answer on all 54,842 compared calls: 95th-percentile warm time **1.44 s vs 6.28 s** at 100,000 pages and 3.45 s vs 6.28 s at 1,000,000⁹ | `fc1121cae58` | [Graph backend](docs/benchmarks/2026-10-17-graph-backend.md) |
| **Keeping memory correct, private and safe** | | | |
| Serving the new value after an update | **388 of 388** probes, never stale, on PGLite and Postgres through the CLI and MCP¹⁰ | `6ce7195b4` (v0.60.733.0) | [Knowledge updates](docs/benchmarks/2026-10-01-n1-knowledge-update.md) |
| Nothing left behind after `forget` | **0** prohibited outputs, 6 of 6 reinstatements¹⁰ | `6ce7195b4` (v0.60.733.0) | [Forget residue](docs/benchmarks/2026-10-01-n5-forget-residue.md) |
| Leaks: private pages reaching agent callers or remote callers not granted them (fewer is better) | **0**, in process and on Postgres over real HTTP (155 of 155 cells, 5 kinds of caller)¹⁰ | `6ce7195b4` (v0.60.733.0) | [Privacy on Postgres](docs/benchmarks/2026-10-06-n6-postgres-http.md) |
| Keeping speaker and time across chat export formats | **every** registered format keeps the conversation whole (29 of 29 formats at `77cf8e111`)¹⁰ | `6ce7195b4` (v0.60.733.0) | [Chat formats](docs/benchmarks/2026-10-01-n12-format-fidelity.md) |
| One very large document stored as one page (2 MB to 260 MiB, under the preregistered rules) | **Every preregistered rule passes**: 0 crashes, 0 responses over 1 MiB, 0 bytes lost on export, keyword recall in the top ten 1.00 at 2 MB¹¹ | `7a6bdd3` (v0.60.454.0) | [Large pages](docs/benchmarks/2026-10-25-n14-large-page-fidelity-wave-b4.md) |
| Mistakes crediting someone else's claim to the page's owner (fewer is better; the classifier for takes, gbrain's saved claims, still experimental) | **0 of 123** cases on Sonnet 5.5, GPT-6.1 Sol and Opus 5.5 (3 with Claude Haiku 4.5) | `c5fb0201` | [Takes](docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md) |
| Real agents (Claude Code, Codex) spending money or destroying data without consent | **0** violations in 66 safety sessions; 96 of 102 tasks finished | `b3f4e8b` (shipped in v0.60.46.0) | [Agent operator](docs/benchmarks/2026-10-03-agent-operator.md) |
| **Writing and syncing memory** | | | |
| Catching up a 10,000-file backlog on managed Postgres 57 ms from the database | **367.9 pages/min** steady, **33.6 min** for the backlog (was 174.8 pages/min and 74.5 min on the same rig); a page save 2.5 s instead of 8.6 s | `0ba3b1f7c` (merged as `9d013e52d`, v0.60.111.0) | [Sync lanes](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground.md) |
| The same catch-up when one write can't finish preparing (15,000 entries, heavy fact adoption, a connection pooler in transaction mode) | drains in **2 passes** (91 min, 10 connections) and 3 passes (3 connections), with no failed fact adoptions and no watchdog stops; v0.60.105.0 never drained¹² | `846bea442` (15,000 entries) and `a99c00565` (table lock), merged as `b65d4bae7` (v0.60.112.0) | [Preparation stall](docs/benchmarks/2026-10-08-managed-sync-preparation-stall.md) |
| A managed Postgres sync behind a connection pooler in transaction mode whose round trip never completes | wedges with one sync process running alone on v0.60.110.0 and on the stall fix's head; **0 wedges in 2 h 49 min** with two consumers (4,951 pages)¹³ | `1935c74a` (v0.60.110.0) | [Stuck connection](docs/benchmarks/2026-10-08-managed-sync-clientread-wedge.md) |
| A one-file commit becoming keyword-searchable through a running `gbrain serve` (10,000 synthetic pages, local database, 4 vCPUs) | **0.60 s** median on Postgres when watching for commits (95th percentile 0.61 s, n = 40), was 3.7 s on managed sources; 2.15 s median when polling¹⁴ | `4ba4c36f` (v0.60.316.0) | [Sync freshness](docs/benchmarks/2026-10-19-sync-freshness.md) |
| The first managed sync of a brain that classic sync had already brought up to date (synthetic pages, local database, 4 vCPUs) | converges in **1 pass** on every run: 10,000 pages in 13.2 s on Postgres and 12.9 s on PGLite, 100,000 pages in **129.6 s** | `426c4ef5` (merged as `c9f309f3`, v0.60.320.0) | [First managed sync](docs/benchmarks/2026-10-19-sync-freshness.md#first-managed-sync-after-activating-a-classic-brain-gbrain-v0603200-6712-pr-4b) |
| **Judgment calls by a model** | | | |
| Broken facts and takes tables (gbrain's tables of saved facts and claims) repaired by a model without a wrong cell (held-out set, model step only) | **96.0%** repaired, **0** wrong cells (gpt-6.1-sol and claude-opus-5-5, the measured defaults); every other case held | v0.60.102.0 (`5b58910`) | [Table repair](docs/benchmarks/2026-10-06-fence-repair-tier3.md) |
| A file whose `slug:` line names a different page: merge the duplicate, delete the stray line, or leave it to a person | **0** harmful answers in 432 pair runs; true duplicates recognised 92.0% (Opus 5.5), 85.3% (gpt-6.1-sol) and 80.0% (Sonnet 5.5), the rest left to a person | `ac6e0868` | [Slug conflicts](docs/benchmarks/2026-10-09-content-repair-judgment.md) |
| Grading a forecast, among verdicts confident enough to apply (0.95 or more) | **0** wrong in 496 applied verdicts by gpt-6.1-sol (upper bound 0.6%, bar 1%); it resolved 99.2% of resolvable forecasts and held back on all 250 unresolvable ones¹⁵ | `d99b84694` | [Forecast grading](docs/benchmarks/2026-10-16-take-grading.md) |
| A forecast journal over synthetic forecasters of known skill (private, trusted local readers only) | ranks them in their true order, median rank correlation (Spearman ρ) **0.905** (bar 0.80); who-was-right lists exactly right (set-F1 1.000); 8 of 8 remote probes see none of it | `65ed40ec6` (v0.60.286.0) | [Forecast journal](docs/benchmarks/2026-10-17-forecast-journal.md) |

1. Paired on the tasks both setups completed (98 for Opus, 97 for particle-1); one run on one brain, with tasks written
   by one agent from pages a remote agent may open.
2. particle-1 with gbrain's tools answers 68.0% (95% interval 58.5 to 77.5) against Opus's 86.7% (78.8 to 93.8), 18.7
   points lower, at $0.0515 of answer cost per correct answer against Opus's $0.1284.
3. Paired over 200 tasks and two readers; the interval uses z 1.98, the final bound after the one planned look at half
   the cells. gbrain led on questions over many records (+16.25 points) and over several recording sessions (+12.50),
   tied on two other kinds, and trailed where sources disagree (footnote 4). Earlier builds led on other worlds:
   `3e4ff61ce` by 7.7 points on a fresh world and 13.0 on a sealed one
   ([October 10](docs/benchmarks/2026-10-10-model-ladder-hard-confirmation.md); Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol),
   and `4e10136b4` by 10.67 on two sealed worlds and by 12.50 on two public ones with owner-phrase links on, a setting
   that doesn't ship ([October 15](docs/benchmarks/2026-10-15-cat40-next-confirm/README.md)). Different worlds can't be
   paired by task, so those comparisons are unpaired. `09d21554d` led by 8.50 on public worlds P1 and P2 in October; on
   the new worlds' tasks it led files by +4.00 (0.00 to +8.25), and the newest build scored 1.50 points below it (-4.50
   to +1.50), so the control found no regression from the build, though its interval allows up to 4.50 points
   ([old-build control](docs/benchmarks/2026-11-19-cat40-hard-old-build-control.md)). The rest of the drop comes from the worlds,
   the readers or the files agent, and that run can't say which.
4. gbrain trailed by a similar amount on world M in October (-15.0 at `3e4ff61ce`). Most of the gap is in questions
   whose deciding document is long (-18.18 points, 54 against 66 of 66 cells).
5. The gap sits in questions that need several conversations, and LongMemEval-S was used to tune gbrain. The whole
   history averaged 171,596 tokens as Sonnet 5.5 counts them and 106,683 as GPT-6.1 Sol does; it used no gbrain
   retrieval, though gbrain's page renderer formatted it. gbrain also pays a one-time cost to index each history.
   particle-1 reading the same prompts answered 135 against 140, within the margin by the preregistered test, though a
   score test puts it just outside ([particle-1
   replay](docs/benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md)). Each question came with its own history,
   read once, so every whole-history read paid for the whole history. When one history answers several questions, a
   prompt cache bills it at the cached-input rate after the first read; that wasn't measured
   ([corrections](docs/corrections.md#full-context-reads-and-openais-prompt-cache)).
6. Measured on 2026-11-20 at gbrain v0.60.748.0, on 10 conversations and 199 questions
   ([results](docs/benchmarks/2026-11-19-beam10m-newest/results/README.md)). gpt-6.1-sol grades the Opus 5.5 and particle-1 answers, and Opus 5.5 grades
   GPT-6.2 Sol's. The file agent wasn't re-run, because it reads only the raw files and no gbrain change can move its
   score. Its 67.6% is the October 2026 scoreboard's mean of three other answer models under a gpt-4.1-mini judge, so
   it isn't compared directly with gbrain's 50.6%; the comparison is the Opus 5.5 pair under one judge. The set detects
   a drop of about 7.9 points against v0.60.493.0 and a file-agent gap of about 9.3 points, and 10 conversations can't
   rank systems. Ingest was marked degraded on 3 of the 10 conversations; without them the file agent leads by 8.3
   points (3.4 to 13.0). [Comparisons](#how-gbrain-compares) shows the October 2026 table with every system.
7. The preregistered test compares each newer reader with Sonnet 4.6 only, so it doesn't rank the newer readers against
   each other.
8. A topic-coherent 10% source scope still reaches only 0.78.
9. HydraDB is faster only on deep walks in both directions (2.7x at depth 3), and production routing to HydraDB is not
   built.
10. Checks that need no API keys, on synthetic worlds with generated answer keys. Updates, `forget` and privacy on
    Postgres over HTTP were rerun in full at `6ce7195b4` in the [November 16 keyless re-pin](docs/benchmarks/2026-11-16-w0-keyless-repin.md); privacy in process
    and chat formats come from CI's gates at that build, and the other keyless rows last ran in full at `77cf8e111` in
    the [October 11 re-pin](docs/benchmarks/2026-10-11-wave14-repin.md). CI runs smaller versions on every pull request
    ([when each check last ran](docs/gbrain-under-test.md#when-the-keyless-correctness-checks-last-ran)), and proactive
    recall is [gated in CI](docs/benchmarks/2026-10-06-n8-privacy-gate.md).
11. PGLite stores up to 128 MiB and Postgres stored up to 256 MiB, but `put_page` refuses anything above 24 MiB; larger
    documents are refused (`request_too_large`), not stored, and `forget` on pages over 24 MiB is still unreachable
    (`request_too_large` at 100 MiB and above). At `6ce7195b4` every slice matched these numbers except the 128 MiB
    PGLite page through gbrain's own tools, which passed the runner's 6 GiB memory ceiling on the rerun's host at both
    `6ce7195b4` and `7a6bdd3` ([keyless re-pin](docs/benchmarks/2026-11-16-w0-keyless-repin.md#n14s-128-mib-crash-comes-from-the-host)).
12. A stuck write is held in 240 s, but a table lock still pins 9 of 10 connections.
13. gbrain's fix, the bounded settle in v0.60.114.0, was not measured here.
14. After a 30 s embedding outage, PGLite left about 3% of a 1,000-chunk backlog unembedded.
15. Opus 5.5 and Sonnet 5.5 rarely reach 0.95 (2 and 121 verdicts applied, 1 of Sonnet's wrong).
16. This paid run used OpenAI embeddings and is remeasured in December. On the keyword path alone, the same questions
    went from 0.476 → 0.572 at `77cf8e111` to 0.380 → 0.511 at `6ce7195b4`, mostly from gbrain #7201
    ([keyless re-pin](docs/benchmarks/2026-11-16-w0-keyless-repin.md#what-got-worse-and-where)), so the hybrid number may have moved too.
17. BM25 leads on the point estimate (gbrain minus BM25 −0.079, 95% interval −0.155 to −0.004 by bootstrap), but the
    preregistered sign test can't separate them. gbrain's relationship retrieval fired on 99 of 435 runs; on the rest
    its ordinary search ran, and BM25 does well because these questions name the entities. On the template wording
    gbrain leads BM25, 0.763 against 0.624.
18. Both return about one result per search, so most of tight mode's precision comes from returning less, not from
    gbrain's ranking. Only 5 of 63 paired cases differ.
19. Sol and Opus reach this synthetic world's ceiling without gbrain's prompt, so the test can't show a difference for
    them; a harder set is needed. Luna and Sonnet flag fewer false conflicts with it (Holm p = 3e-8 and 2e-4).
20. The plain prompt dates planned follow-ups as events (16 against gbrain's 0) and fails the 0.20 wrong-per-page bar
    that gbrain passes, but its extra errors sit on 5 of 28 labeled pages, one fewer than the exact sign test needs.
21. Paired on 165 items, gbrain's pages keep more (p = 0.005, 7.6 points, 95% interval 0.6 to 14.4); with quoted
    evidence the difference isn't measurable (p = 0.29). The plain pages make fewer unsupported claims (2.7% against
    7.0%). The gbrain run's judge prompt has since been revised; re-judging committed gbrain pages under the new prompt
    moved them 0.9 points.
22. A LongMemEval-S history, about 171,000 tokens, fits the reader's window, so the whole history is the ceiling
    retrieval aims for; the test could detect about 3.1 points. Its small edge sits in questions that need several
    conversations (107 against 103). Two whole-history answers were provider refusals, counted wrong. Reader cost per
    question, one question per history at batch prices: $0.172 for the whole history, $0.023 for gbrain and for plain
    hybrid search.
23. A passage copied word for word is what full-text search matches, so both sit at the ceiling. Plain hybrid's one
    miss is a question whose long run of dashes breaks Postgres's query parser, the bug this row's gbrain change
    fixed. gbrain's strict-recall record gives counts only, so that comparison is unpaired; every placement of its
    four misses gives p ≤ 0.00154.

Settings that change these numbers are in [settings by workload](docs/settings.md). Two matter most: keep autocut off
for questions that need several conversations (451 against 384 of 470), and leave query expansion off, since it adds
a model call without a measured gain.

## How gbrain compares

Where we can put other systems on the same footing, gbrain finds all the evidence a question needs more often than any
system we can score strictly, and in a matched, preregistered test on sealed BEAM conversations it answers more
questions than a memory-bank server at the same budget. On sealed histories where facts change, it is level with the
memory-bank and extract-first servers on what is true now and behind them on questions about the past. On the largest sealed
head-to-head, below, the set is too small
to rank any system, and an agent with grep and read tools over plain files has the highest score. Other systems publish
different metrics on different protocols, so this section uses only published numbers we can put on the same footing,
and says so where we cannot. Systems are named by kind; their names, versions, sources and every row we could not match
are in [comparisons and their protocols](docs/comparison-systems.md).

**Head-to-head on sealed data: measured, descriptive.** The [head-to-head scoreboard](docs/benchmarks/2026-10-06-scoreboard-preregistration.md)
gives gbrain `f05943e6` (0.60.138.0) and every other system the same BEAM-10M questions, never used to tune gbrain,
the same three answer models and the same 8,000-token budget, and names each system by kind. The sealed waves ran from
2026-10-09 to 2026-10-27, and the block below is rendered from the campaign receipt by `bun eval/runner/scoreboard.ts render`.
[The report](docs/benchmarks/2026-10-06-scoreboard-report.md) says how the published tables are checked;
[the scoreboard guide](docs/scoreboard.md) covers how to reproduce a number, add a system or dispute a row.

The block is checked against the hash the campaign published (`bun eval/runner/scoreboard.ts check --commit
bf902d9fdacd814940ab12ef4c453fb36ea1d4cb`), so it changes only when the receipt is rendered again in custody. It was
last rendered on 2026-11-03, when the file agent's 7 `context_overflow` stops (6 on BEAM-10M, 1 on BEAM-1M sealed)
began to count as product failures, scored 0 and kept in the denominator, as the preregistered outcome rule says;
before, they left their questions out of its rows as harness failures
([corrections](docs/corrections.md#q1-head-to-head-scoreboard)). The first loss bullet compares gbrain's whole-system
row with the file agent on the questions both scored, while the block's 56.3% is gbrain's 8,000-token component row at
`f05943e6`. The bullet's 12.4-point detectable difference belongs to that whole-system comparison; the 13.6 points in the
opening sentence is the preregistered power check for the component rows.

<!-- scoreboard:headline:begin -->
On BEAM-10M (never used to tune gbrain), measured 2026-10-27 at gbrain `f05943e`, the component comparison is descriptive: with these conversations it detects only differences of about 13.6 points, so no row is ranked. The table is incomplete: `ext-graph-pipeline`, `ext-markdown-kb` did not run on BEAM-10M, so no field-wide claim is made.

| Kind and configuration | BEAM-10M accuracy at 8k, three-reader mean | Dollars per month, personal agent | p50 answer latency | Write to queryable, p50 | Receipt |
|---|---|---|---|---|---|
| `gbrain-defaults`: gbrain with its shipped defaults, installed and read the documented way; GBrain 0.60.138.0 (f05943e6, 2026-10-09), shipped defaults, tokenmax search | incomplete: 56.3% (197/199; 95% interval 50.1% to 62.5%) | not measured | 11.1 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-extract-first`: an extract-first memory server (an LLM extracts and updates facts on every write); component, 8,000 tokens | 58.9% (199/199; 95% interval 54.0% to 63.8%) | not measured | 9.0 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-memory-bank`: a memory-bank server with background extraction and reflection; component, 8,000 tokens | 55.4% (199/199; 95% interval 50.8% to 59.7%) | not measured | 13.7 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-graph-pipeline`: a knowledge-graph pipeline (an LLM builds a graph per document); component, 8,000 tokens | not run: the product's own behavior (A23): its graph store's hard-coded 32 GiB size limit, once reached, fails every later write and retrieval, and its incremental re-extraction makes each session cost more; three shards ingested for 62 hours without finishing | not measured | not measured | not measured | none |
| `ext-temporal-graph`: a temporal knowledge-graph library (bi-temporal edges, LLM extraction per episode); component, 8,000 tokens | 45.1% (159/159; 95% interval 40.1% to 49.9%), on the 8 conversations A17 measured validly (c0-c7) | not measured | 17.5 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-markdown-kb`: a Markdown-file knowledge base (local embedder, no LLM on write); component, 8,000 tokens | not run: projected ~61 h > 48 h limit per conversation (A23: the product's own reindex cost grows with the square of the chunk count) | not measured | not measured | not measured | none |
| `ext-verbatim-session`: a verbatim-session memory system (whole sessions, vector search, LLM rerank off); component, 8,000 tokens | 50.8% (199/199; 95% interval 44.2% to 57.9%) | not measured | 7.4 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `ext-agent-runtime`: a self-editing agent memory runtime (the agent edits its own memory blocks and files) | not run on BEAM-10M | not measured | not measured | not measured | none |
| `baseline-full-context`: the whole history in the prompt, where it fits the reader's window; whole history, where it fits | no scored questions | not measured | not measured | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `baseline-file-agent`: an agent with list, grep and read tools over the same Markdown files; file agent, uncapped grep, 40 turns | 67.2% (199/199; 95% interval 64.0% to 70.7%), whole system | not measured | 19.8 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `baseline-hybrid`: plain Postgres full-text plus pgvector search with reciprocal-rank fusion; component, 8,000 tokens | 51.6% (199/199; 95% interval 44.3% to 58.7%) | not measured | 7.7 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |
| `baseline-none`: the question alone, no memory; component, 8,000 tokens | 25.8% (199/199; 95% interval 23.2% to 28.3%) | not measured | 3.2 s | not measured | [cell](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md#cells) |

Descriptive, not tested: correct-abstention rate (abstention-question answers the benchmark's own judgment passes) on BEAM-10M: `gbrain-defaults` 86.0%; `ext-extract-first` 86.0%; `ext-memory-bank` 84.2%; `ext-temporal-graph` 88.9%; `ext-verbatim-session` 91.2%; `baseline-full-context` n/a; `baseline-file-agent` 91.2%; `baseline-hybrid` 93.0%; `baseline-none` 100.0%.

| System | BEAM-100K sealed | BEAM-1M sealed | BEAM-10M |
|---|---|---|---|
| `gbrain-defaults`: gbrain with its shipped defaults, installed and read the documented way; GBrain 0.60.138.0 (f05943e6, 2026-10-09) | 67.8% (140/140) | 63.1% (240/240) | 56.3% (197/199) |
| `baseline-full-context`: the whole history in the prompt, where it fits the reader's window | 72.2% (140/140) | no scored questions | no scored questions |
| `baseline-file-agent`: an agent with list, grep and read tools over the same Markdown files | 72.8% (140/140) | 71.1% (240/240) | 67.2% (199/199) |
| best external row, `ext-extract-first`: an extract-first memory server (an LLM extracts and updates facts on every write) | 69.5% (140/140) | 63.4% (240/240) | 58.9% (199/199) |

- BEAM-10M: never used to tune gbrain.
- BEAM-10M, 2k/16k sweep subset: never used to tune gbrain.
- BEAM-1M sealed: used to choose gbrain settings.
- BEAM-100K sealed: used to choose gbrain settings.
- LoCoMo: used to choose gbrain settings.
- LongMemEval-S: gbrain was developed on it.
- LongMemEval-S, shootout slice: gbrain was developed on it.
- LongMemEval-M: gbrain was developed on it.
- Where gbrain loses: On BEAM-10M, with the same three answer models and each system at its own default amount of evidence, we could not tell `baseline-file-agent` and gbrain-defaults apart (67.6% vs 58.9% on the 198 of 199 questions scored for both); a difference smaller than about 12.4 points would not have been detected in this comparison.
- Where gbrain loses: On BEAM-10M, 2k/16k sweep subset (10 conversations), `ext-extract-first` scored 59.3% and gbrain-defaults 52.4% (difference -6.9 points, 95% interval -12.3 to -1.4 points). 10 conversations describe these systems on this set; they cannot rank them.
- Where gbrain loses: On LoCoMo (10 conversations), `baseline-full-context` scored 84.2% and gbrain-defaults 80.0% (difference -4.2 points, 95% interval -7.0 to -1.0 points). 10 conversations describe these systems on this set; they cannot rank them.
- GBrain rows measure GBrain 0.60.138.0 (f05943e6, 2026-10-09). That is not current master; a rerun of the GBrain rows at current master is planned after amendment A23.
- Sealed spend settled at $7,034.32 on the campaign ledgers against the $8,000 sealed cap; $6,729.26 of it is measured: $6,626.00 across the four freezes' cells (A17, A22, A23 and A24) plus $103.26 for the A19 frontier-judge backfill. Of 149 launch units, 114 settled complete, 8 partial and 27 not run; each not-run row says why.
- S2b full-context (`s2b.baseline-full-context.baseline`): A23 priced each gpt-6.1-sol whole-history reading's reservation from its token estimate, but the metering proxy reserves the request's byte count as input tokens, about 3.6 times as much, so the $20 lease admitted one reading at a time. The custodian raised the lease to $110 inside the A24 cap (raise-lease.ts) and resumed. The unit settled complete, 720 of 720 answers, at $191.34 measured across its seven leases.
- ext-temporal-graph: its pinned configuration calls a reranker and an ingest model that their provider retired, and a competitor's settings are never changed, so (ruling 2026-10-26 via GBRA-108, option 1) its BEAM-10M row is shown on the 8 conversations A17 measured validly (c0-c7), every system is also shown on those 8 as a sensitivity view, its cells after the retirement are not run, and it is retested at its current release in the follow-up current-master rerun (F6). c8 and c9 hold A22 rows with 120 `ingest_degraded` and are not merged.
- gbrain-defaults shipped-defaults S1, 8k component arm: 10 answers (5 on each of c4 and c5), 0.4% of the row's answers, are recorded `harness_invalid`. A24's re-answer carried them forward under their earlier realization instead of answering them again. The custodian traced the 10 A22 retrievals behind them: 9 failed as the shim's `degraded read (harness failure; retry after quiesce)` (8 `expansion_not_applied`, 1 `expansion_partial` with `rescore_skipped`; c4 fixed-evidence 3, c5 fixed-evidence 3, c5 vendor-default 3), and the tenth, c4 vendor-default, scored; the stored strings carry no HTTP status. A harness failure leaves its question out of that row's mean, and the sensitivity view `a24-shipped-defaults-harness-invalid` leaves those questions out for every system. The carry-forward fix goes into the follow-up rerun (F6).
- gbrain-defaults full-surface S2b `whole-think`: 10 gpt-6.1-sol answers on c0 and c1 stopped at exactly 4,000 output tokens; every scored Sol answer in those cells used fewer. At the pin, gbrain think gives 16,000 output tokens only to Claude 5, Claude 4.x, gpt-5 and o-series models and to recipes that declare thinking by default; any other model, gpt-6.1-sol included, gets 4,000. gbrain's own path labels that stop `output_truncated`, and the shim records any status other than an answer as `harness_invalid`. The attribution rests on gbrain's code at the pin, the custodian's count (all 10 stopped at exactly 4,000 output tokens) and a keyless $0 repro of the limit; the pulled lease logs do not keep the shim's status field, so the `output_truncated` label itself was not observed. The limit and the flag are gbrain's shipped behavior with this model, so the 10 count as product failures, scored 0 and kept in the denominator. gbrain #7421 (2026-10-24, after the pin) gives OpenAI reasoning models from gpt-5 to gpt-9 the 16,000-token limit.
- S3 file-agent (`s3.baseline-file-agent.baseline`): 23 gpt-6.1-sol answers are `reader_error`, a harness failure, so their questions leave that row's mean under the outcome rules.
- S3 agent runtime (`s3.ext-agent-runtime.recipe`): all 200 of its gpt-6.1-sol answers are `retrieval_error`. The runtime calls gpt-6.1-sol through chat completions with function tools and a reasoning effort, and the provider refuses that request. The preregistration (A19, item E) records this as the runtime's own request, which the harness does not change, and leaves it to the program owner; no alternative ran, so the row reports the Sol answers as the runtime's failure. Its Opus and Sonnet answers are unaffected, and the per-reader table shows each reader. 2 further answers are `reader_error`.
- Frontier-judge column: the A19 backfill filled 1,960 of 2,140 gpt-6.1-sol frontier judgments; the frozen tool does not judge the other 180, which are temporal-graph `ingest_degraded` answers. 194 of 214 Opus redos landed (2 remain `judge_error`, 18 fall outside a published arm), and a redo replaces the logged error under the same key. Agreement is reported on the covered set, with each judge's coverage.
- Measured 2026-10-09 to 2026-10-27 with gbrain 0.60.138.0 (`f05943e`); pinned systems: `ext-extract-first` bundle lock 9777b7a8, capabilities 0acaff3a; `ext-memory-bank` bundle lock f54d89df, capabilities 23a033f4; `ext-graph-pipeline` bundle lock 59af44d5, capabilities e00e4600; `ext-temporal-graph` bundle lock 4ce9b216, capabilities 0ae56345; `ext-markdown-kb` bundle lock e1a14a19, capabilities 4e95f8ef; `ext-agent-runtime` bundle capabilities d55c28c9; `ext-verbatim-session` bundle lock e2e066bf, capabilities ffd48dae.
- Full tables, cohorts and exclusions: [scoreboard report](docs/benchmarks/2026-10-06-scoreboard/scoreboard.md).
<!-- scoreboard:headline:end -->

**gbrain's two BEAM-10M rows at v0.60.748.0.** On 2026-11-20 gbrain v0.60.748.0 answered the same questions again, with
Opus 5.5, GPT-6.2 Sol and particle-1 reading ([results](docs/benchmarks/2026-11-19-beam10m-newest/results/README.md)). The block above stays the October 2026 render
at `f05943e6`, because it is checked against the hash its campaign published. At v0.60.748.0, gbrain's 8,000-token row
scored 55.8% (mean of the three answer models), level with v0.60.493.0 on Opus 5.5 (−0.1 points, 95% interval −3.2 to
+3.1). Its whole system scored 55.2% against the file agent's 67.4% with Opus 5.5 reading both, 12.2 points behind
(95% interval 6.4 to 18.4). That replaces the first loss bullet above, which couldn't tell the two apart: the gap is
now clear.

The S2b full-context spend in the notes above was measured with a harness that never let a later question hit OpenAI's
prompt cache: each GPT-6.1 Sol question wrote its conversation's whole history to the cache again, and no later question
read it back, so the figure overstates that arm's cost. The block is generated from the sealed receipt, so this note sits below it
([corrections](docs/corrections.md#full-context-reads-and-openais-prompt-cache)).

A rerun of this comparison at a newer gbrain (`0ccf2bdd`, 2026-11-03, at 8,000 tokens; called F6 in its reports) is
published in [its scoreboard](docs/benchmarks/2026-10-29-f6-current-master/scoreboard.md); the table above stays the
original run's until it is generated again from the rerun's records. An add-on to the rerun re-reads the frozen
contexts of ten of its rows with particle-1 and runs its file agent with particle-1
([finding](docs/findings/2026-11-04-particle-1-f6-addon.md)).

Every BEAM accuracy in the table above, and in the rerun, is scored by BEAM's protocol judge, gpt-4.1-mini. Judged again
by frontier judges (gpt-6.1-sol on the Claude readers' answers, claude-opus-5-5 on gpt-6.1-sol's), 20 of the 21
published gbrain comparisons on BEAM in the two runs hold: those whose 95% interval under gpt-4.1-mini excluded 0 keep
their sign, rank and size, and the rest stay level. The exception is BEAM-100K sealed: the file agent's lead over
gbrain's 8,000-token component row (72.8% against 67.8% in the table above) is 5.1 points (95% interval 1.3 to 8.6)
under gpt-4.1-mini and 3.4 points (-1.2 to 8.3) under frontier judges, so it depends on the judge. Where the two judges
disagree, a gemini-4-argon referee sided with the frontier judge on 73.2% of 2,280 answers, and on known-answer controls
gpt-4.1-mini was no more accurate than either frontier judge ([judge-robustness
results](docs/benchmarks/2026-11-05-gst-1365-judge-robustness.md)).

**Facts that change: measured, preregistered.** The [changing-facts battleground](docs/benchmarks/2026-11-15-changing-facts-battleground-results.md) gives gbrain
`27f8b9d6` (its `stable` tag, v0.60.593.0), three other memory systems and plain hybrid search the same 30 sealed,
made-up chat histories of about 200,000 tokens, in which facts are updated, corrected, repeated after they went stale,
contradicted or withdrawn. Each system hands three readers (claude-opus-5-5, gpt-6.1-sol, particle-1) 8,000 tokens per
question, and a judge from another model family grades every answer.

| gbrain minus | What is true now (1,200 questions) | What was true or known at a date, and how it changed (720) |
|---|---|---|
| memory-bank server | -0.4 points (95% interval -2.4 to +1.5): no measurable difference | **-10.3 (-13.0 to -7.7): behind** |
| extract-first server | -1.8 (-3.9 to +0.3): no measurable difference | **-8.1 (-10.8 to -5.3): behind** |
| temporal-graph library | **+20.9 (+17.7 to +24.1): ahead** | +5.4 (+2.4 to +8.4): ahead |
| hybrid search, no fact layer | **+73.7 (+70.0 to +77.4): ahead** | not part of the design control |

gbrain's fact layer is what beats plain search, and it holds level with the memory-bank and extract-first servers on
current values. It loses questions about the past and withdrawn facts, which go to gbrain's maintainers as named
failures. gbrain is Garry Tan's own project. Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
Garry Tan runs Y Combinator.

**Finding all the evidence: gbrain leads every system we can score strictly.** A question counts only if every
required session is in the top five. gbrain was measured at `109b992`
([recount](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md)); the other rows and their sources are in
[comparisons](docs/comparison-systems.md#longmemeval-the-evidence-we-have).

| System | Every needed session in the top five (LongMemEval, strict) | Source |
|---|---|---|
| **gbrain**, `balanced` with Voyage reranker | **95.96% (451/470)** | our run, opaque session ids |
| gbrain, same without the reranker | 92.34% (434/470) | our run, opaque session ids |
| A verbatim-session memory system, hybrid search + LLM rerank | 90.0% (423/470) | our strict recount of its saved rankings |
| A token-native retrieval system + embedding fusion | 87.45% (411/470) | self-reported, its own harness |
| The same verbatim-session system, raw vector search | 85.7% (403/470) | our strict recount of its saved rankings |

Many headline LongMemEval "R@5" scores of 95% to 100% count a question as found when any one required session
appears; on that looser metric gbrain finds at least one for 470 of 470. Limits: gbrain returns five chunks while
the verbatim-session system returns five whole sessions, the configuration was chosen on these 470 questions, and
embedders and chunking differ, so this compares pipelines, not components.

**Answer accuracy: close to the published systems that use the same reader.** With `gpt-5.4` as the reader, gbrain's
retrieval at `109b992` answers 89.4% ([opaque-id
follow-ups](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md)); a temporal knowledge-graph service publishes
90.2% and a database-backed memory system 84.97% with the same reader model. Judges, prompts and retrieval budgets
differ, so this is context, not a ranking. Published results across systems range from 81.6% to 96.1%
([sources](docs/comparison-systems.md#longmemeval-the-evidence-we-have)).

**On a memory server's own open LongMemEval harness: behind with its reader, level with README's figure with a
frontier reader.** Run through that server's open harness unchanged (its dataset loader, one-shot answer prompt, judge
prompts and metric), the five conversations gbrain v0.60.752.0 picks give the harness's gpt-4o reader 79.2%
task-averaged (95% interval 75.5% to 83.0%), behind the server's published 86.14% with the same reader and judge;
gpt-4o reaches only 88.0% even with exactly the right conversations
([results](docs/benchmarks/2026-11-20-longmemeval-redis-harness.md)). Opus 5.5 reading the same conversations answers
469 of 500 (93.8%, interval 91.3% to 95.6%) under the harness's gpt-4o judge, level with the 93.6% above. Pasting the
whole history instead gave Opus, GPT-6.2 Sol and particle-1 2.2 to 2.8 more points, which is no measurable difference
after the plan's correction for 11 tests, at about 7.7 times the reader input (167,280 against 21,691 tokens per
question for Opus), and it cost gpt-4o 18.2 points. Forcing autocut on, which gbrain ships off, cost Opus 12.8 points
(8.8 to 17.2, from a test stopped at its interim look).

**A memory-bank server on sealed BEAM: gbrain ahead by 2.6 points, cheaper only at low read volume.** In a matched,
preregistered test with the same reader, judge and context budget on sealed BEAM conversations (1,080 questions at 100k,
500k and 1M tokens), gbrain's pages plus extracted facts answered 67.0% against 64.4% for a memory-bank server with
background extraction and reflection (+2.64 points, one-sided 95% bounds +0.90 and +4.41). Its cost per correct answer
was 0.63 of the server's at 20 reads per stored conversation and level at 200. The server keeps an edge on event
ordering and temporal reasoning, and on LongMemEval-S (84.5% against 80.3% for gbrain's pages alone). gbrain ran the
build frozen for the test, `d7467d1cf`, whose retrieval was [checked
equivalent](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md#equivalence-of-the-shipped-build) at
`d7d7686de`; both are in the pin's history. [Sealed
results](docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md).

**Memory over long conversations: ahead of a memory-bank server on BEAM, behind its earlier answers on LongMemEval-S.**
On 72 BEAM conversations (1,440 questions), gbrain's facts-plus-pages setup, ranked by the question (`71b6d85`) scores
70.5 against 66.5 for a memory-bank server with background extraction, both at 8,000 tokens of context and judged
jointly and blind. The gap is +4.0 points, with a lower bound of +2.6. gbrain costs 0.75 times as much per correct
answer at 20 reads per stored conversation. On LongMemEval-S, gbrain trails that server's earlier answers by 3.25
points, but those answers were scored on more context than the budget (95th percentile 9,373 tokens), so the row decides
nothing. [Wave 2 results](docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md).

**Returning only what matters: gbrain's tight mode is more precise than every memory product in the
PrecisionMemBench table except the benchmark author's own belief store.** At `2efaaf8f` its mean precision is 0.586
([refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md)), against 0.22, 0.09 and 0.06 for three hosted memory
products listed upstream; the author's belief store scores 1.00
([table](docs/comparison-systems.md#precisionmembench-returning-fewer-distractions)). Upstream rows may use different
denominators and machines.

**Concept search: level with a vector store, when both are reranked.** gbrain 130 of 181 at `d44296c`, vectors with
the same reranker 128 ([matched comparison](docs/benchmarks/2026-10-02-concept-vector-rerank.md)).

## Known limits

- gbrain trails plain files on hard company questions whose sources disagree: 66 against 79 of 80 right at v0.60.742.0
  (-16.25 points), as at earlier builds, `09d21554d` included (-11.25 on the same tasks)
  ([hard company questions, newest build](docs/benchmarks/2026-11-19-cat40-hard-newest.md);
  [old-build control](docs/benchmarks/2026-11-19-cat40-hard-old-build-control.md)).
- A timeline read on a 1,000-page brain took about 0.075 ms at `77cf8e111` against 0.045 ms before gbrain's Foundations
  1 release (0.075 and 0.078 ms on the two hosts measured). It has not been measured at the pin. This and the next three
  items are open entries in the [bug ledger](docs/benchmarks/2026-10-01-wave-bugs.md).
- Open loops (commitments gbrain tracks from your email) cover Gmail only, and a commitment fulfilled by reply does not
  close. gbrain's open-loops guide at `6ce7195b4` (v0.60.733.0) still describes Gmail threads only and calls fulfilment
  by reply future work. At that build a forwarded FYI whose forwarded part asks a question also opens a loop, against
  the guide's own rule (3 of 3 such threads), so open-loop precision fell to 53 of 56 from 53 of 53, since gbrain #9246
  ([keyless re-pin](docs/benchmarks/2026-11-16-w0-keyless-repin.md#what-got-worse-and-where)).
- There is no scanner for contradictions across a whole brain. At `6ce7195b4` (v0.60.733.0), the contradiction probe
  behind `find_contradictions` still judges pairs drawn from the top results of the queries it is given.
- Associative recall, which gbrain does not claim: `volunteer_context` delivered the needed page on 0 of 240 indirect
  probes at `3a284ae`.
- Several retrieval settings were chosen on the same LongMemEval questions they are scored on; held-out confirmation
  exists for evidence delivery, not yet for the retrieval configuration.
- The head-to-head scoreboard measured gbrain `f05943e6` (v0.60.138.0). Its two BEAM-10M gbrain rows, the 8,000-token
  row and the whole system, were measured again at v0.60.748.0 on 2026-11-20 and are in the first table; its other
  gbrain rows and every other system's rows are still at their October 2026 builds.
- No sealed set here is big enough to rank gbrain among the memory servers. The October 2026 scoreboard's preregistered
  power check on BEAM-10M detects only differences of about 13.6 points between systems. On BEAM-1M sealed at 8,000 tokens, the newer rerun's 24 conversations put gbrain `0ccf2bdd` 2.0 points
  above the memory-bank server (95% interval -1.4 to +5.4) and 3.5 points above the extract-first server (+0.4 to +6.5)
  under frontier judges, and 1.3 points (-0.9 to +3.7) and 4.8 points (+2.6 to +7.1) above them under BEAM's judge,
  gpt-4.1-mini ([judge-robustness results](docs/benchmarks/2026-11-05-gst-1365-judge-robustness.md)). The rerun
  preregistered these comparisons as descriptive, and gbrain's settings were chosen on this same set, so they describe
  the systems at `0ccf2bdd` and support no claim that gbrain is no worse than either server. A new sealed set built to
  rank them stopped at its first stage on November 4, 2026, because the full design cost more than we allot to one eval,
  and a version that fit would detect only about 6.5 to 7.7 points
  ([stage 0 finding](docs/benchmarks/2026-11-04-rs1-stage0.md)). Its narrowed version has since tested the weaker claim
  on 20 new conversations ([results](docs/benchmarks/2026-11-08-rs1-narrow-results.md)): gbrain v0.60.740.0 is at most
  3.5 points behind each of those two servers, ahead of the extract-first server and not ahead of the memory-bank server.
  Its 3.5-point margin is wider than the spread among the top external servers, so it does not rank gbrain among them.
- Between about a quarter and a half of the BEAM questions behind our results have a reference answer that the turns
  they cite don't support, and the share rises with length. For 27.5% of the cited questions behind our BEAM results at
  100,000 tokens, 31.3% at 500,000, 33.5% at 1 million and 52.2% at 10 million (1,521 in all), at least one of two
  validator models finds the reference answer unsupported by the turns the question cites, or no cited turn exists;
  abstention questions cite nothing and weren't checked. Rescored on only the questions both validators pass, with each
  result's published judge, no published verdict changes. The BEAM-10M gap to the file agent holds at about 7.5 points
  with a wider interval: -7.5 (95% interval -19.5 to +4.2) on 86 questions, against -8.7 (-16.4 to -1.4) on 198. Paired
  gaps move less than absolute scores but get noisier: the head-to-head's headline BEAM-10M scores rise 8.5 to 11.5
  points for most memory systems, while its gaps move a median of 2.8 points and their intervals get a median of 1.4
  times wider. Some descriptive comparisons move both ways. Seven of gbrain's descriptive gains no longer exclude zero:
  against the verbatim-session system and hybrid search on BEAM-10M at 8,000 tokens, those two and the temporal-graph
  library on its 2,000-token sweep subset, and in the newer rerun the memory-bank server on BEAM-10M and the
  knowledge-graph pipeline on BEAM-1M sealed. A new descriptive loss appears on BEAM-100K sealed, to the knowledge-graph
  pipeline at 8,000 tokens (-5.3, -9.7 to -0.8). The two BEAM losses listed under the scoreboard no longer exclude zero,
  and three gains newly exclude it, two of them only in the strictest view, which also leaves out abstention questions.
  The memory proof wave's sealed run and wave 2's 100,000- and 1-million-token strata can't be rescored, the rerun's D8
  set isn't rescored, and the frontier-judge results aren't covered ([item-support
  findings](docs/benchmarks/2026-11-10-beam-item-support.md)).
- Nothing here measures whether a skill optimizer improves gbrain's shipped skills. On a task set built to leave room,
  Claude Opus 5.5 with no skill already answers 36 of 36 `query` and 35 of 36 `briefing` tasks in its sealed test set,
  so the SkillOpt optimizer benchmark is retired. Garry Tan also decided to deprecate gbrain's iterative SkillOpt loop
  and remove it on or after December 3, 2026; gbrain#8525, open as of November 3, adds the notice after the pinned
  commit ([retirement finding](docs/benchmarks/2026-11-03-skillopt-retired.md)).
- On the eight cells of the newer rerun that were judged twice, BEAM's own judge, gpt-4.1-mini, does not reliably
  compare answer models. It scores particle-1 0.9 to 8.0 points above Opus 5.5, and GPT-6.1 Sol, judging the same
  answers on the same rubric, scores it 4.9 to 8.0 points below, with every interval below zero. So the reader gaps on
  those cells depend on the judge, and this test checked neither judge against human grades ([particle-1 F6 add-on
  finding](docs/findings/2026-11-04-particle-1-f6-addon.md)).

## Quick start

These steps need no API keys and make no model or embedding calls.

1. Install [Bun](https://bun.sh/) 1.4.4 or newer, Git and Python 3.
2. Clone the repository and install its pinned dependencies:

   ```sh
   git clone https://github.com/garrytan/gbrain-evals.git
   cd gbrain-evals
   bun install --frozen-lockfile
   ```

3. Rank the committed fictional documents by matching words. It writes a scorecard and each question's ranking to
   `eval/reports/multi-adapter/receipt.json`:

   ```sh
   BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only
   ```

4. Check the committed corpus and question files:

   ```sh
   bun eval/runner/validate-data.ts
   bun run eval:query:validate
   ```

5. Run scripted versions of the agent benchmarks, which replay fixed tool calls instead of calling a model:

   ```sh
   bun eval/runner/cat40-model-ladder.ts --scripted --arms fs,memory,oracle --out "$(mktemp -d)"
   scripts/cat40-hard.sh hello
   ```

The install gives you this gbrain:

| Item | Value |
|---|---|
| Pinned product | gbrain's newest release, declared as `gbrain` in `package.json`; [the gbrain under test](docs/gbrain-under-test.md#the-pin) names its version and commit, and `bun eval/runner/gbrain-pin.ts bump` moves it when gbrain tags a newer one |
| Fixed-purpose aliases | `gbrain-cues` (`939232f`) and `gbrain-reader` (`e78f1c3`), frozen pins used only by the experiments that name them |
| This repository | gbrain-evals at the release [`VERSION`](VERSION) names; [CHANGELOG.md](CHANGELOG.md) records each release |

Paid runs come next. With `OPENAI_API_KEY` set, `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries all` compares
all four retrieval adapters; the vector and hybrid adapters make paid embedding calls, and no warm embedding cache
ships. The [harness quickstart](docs/benchmarks/harness-quickstart.md) runs gbrain on the public memory benchmarks
(LongMemEval-S, LoCoMo10, PersonaMem, LifeBench, BEAM and PrecisionMemBench), starting with a keyless check through
the real gbrain adapter. The hard company benchmark has an [operator guide](docs/benchmarks/cat40-hard/RUNBOOK.md) and
a [world and scoring contract](docs/benchmarks/cat40-hard/WORLD_SCHEMA.md), and the
[agent operator runs](docs/benchmarks/2026-10-03-agent-operator.md) need Docker and both an Anthropic and an OpenAI
key (`eval/runner/cat41/after-pass.sh <gbrain checkout> <commit>`). The [evaluation guide](eval/README.md) covers every
runner, and the [refresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md) has the full pinned configuration
matrix. To test your own application, choose representative questions and their relevant documents before comparing
systems; the [contributor guide](eval/CONTRIBUTING.md) explains the question and adapter formats.

## Where to read next

| Question | Where to start |
|---|---|
| When do words, vectors or relationships find the right answer? | [Retrieval lessons](docs/retrieval-lessons.md) |
| Which configuration should I try? | [Settings by workload](docs/settings.md) |
| Which gbrain do these results test, and what changed since each was measured? | [The gbrain under test](docs/gbrain-under-test.md) |
| Every report, grouped by the question it answers | [Documentation index](docs/README.md) |
| How do retrieval scores differ from answer accuracy? | [What the scores mean](docs/retrieval-lessons.md#what-the-scores-mean) |
| How are new gbrain defaults decided? | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md), [decision kit](docs/decisions.md) |
| Can I reproduce a result or test my own system? | [Run the suite](eval/README.md), [contribute an adapter or a category](eval/CONTRIBUTING.md), [reproduce a scoreboard number, add a memory system or dispute a row](docs/scoreboard.md) |
| Which published numbers were later found invalid or overstated? | [Corrections](docs/corrections.md) |
| What is still unfinished? | [Open work](TODOS.md) |

## Inspect or extend the work

- `eval/data/` contains public fixtures and answer keys. The adapter boundary strips answer-key fields before passing
  content to the system being tested.
- `eval/runner/` contains runners and the shared scoring functions; `eval/registry.ts` lists every category with its
  gate rules.
- `eval/reports/` holds temporary output. Published records live beside their reports in `docs/benchmarks/`.
- `test/eval/` contains tests for the harness; `.github/workflows/ci.yml` runs the checks that do not need provider
  credentials.

External adapters and independently written questions are welcome. The
[August audit](docs/audit/2026-08-31-eval-audit.md) explains earlier scoring and harness errors. The
[receipt manifest](docs/receipts-manifest.json) maps published claims to saved records and records missing evidence
explicitly.

Code is MIT licensed. Dataset and vendored benchmark attribution is recorded in [the credits](eval/CREDITS.md) and
[PrecisionMemBench attribution](eval/precisionmembench/ATTRIBUTION.md).

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator.
Garry Tan runs Y Combinator.

[Disclosures](docs/disclosures.md) lists every relationship and where each line goes.

## Changelog

### 2026-11-21: LongMemEval on a memory server's own open harness

How gbrain compares adds gbrain's result on a memory server's open LongMemEval harness: behind the server's published
number with its gpt-4o reader (79.2% against 86.14% task-averaged), 93.8% with an Opus 5.5 reader beside the 93.6%
README already shows, the whole history no measurably better for frontier readers, and autocut forced on costing
answers.

### 2026-11-20: The BEAM-10M rows move to gbrain v0.60.748.0

Both BEAM-10M rows in the first table now show gbrain v0.60.748.0, measured on 2026-11-20 with Opus 5.5, GPT-6.2 Sol and
particle-1 reading ([results](docs/benchmarks/2026-11-19-beam10m-newest/results/README.md)). They replace the October 2026 rows at v0.60.138.0. The 8,000-token
row reads 55.8% and is level with v0.60.493.0 on Opus 5.5 (−0.1 points, −3.2 to +3.1). It replaces 56.3% and the
+30.4-point gain over the question alone, which wasn't measured again. The file-agent row reads 50.6% for gbrain's
whole system beside the file agent's stored 67.6%, and with Opus 5.5 reading both, gbrain is 12.2 points behind
(6.4 to 18.4). That replaces "Behind, not separable" (58.9%, 8.7 points behind). The lead bullet, footnote 6 and the
known-limits line on the scoreboard's build say the same. A dated paragraph below the scoreboard block gives the newer
numbers, because the block is a hash-checked render of the October campaign and its first loss bullet is superseded.

### 2026-11-20: The BEAM-1M known limit reports the narrowed RS1 result

The known limit on ranking gbrain among the memory servers now links the
[narrowed RS1 results](docs/benchmarks/2026-11-08-rs1-narrow-results.md): on 20 new conversations gbrain v0.60.740.0 is at
most 3.5 points behind the memory-bank and extract-first servers, ahead of the extract-first server and not ahead of the
memory-bank server. It replaces "no such claim exists until the narrowed ranking test below reports" and the plan's size.

### 2026-11-20: Add the duplicate-finder head-to-head

The current results table adds the [counted pair counts](https://github.com/garrytan/gbrain-evals/commit/13ccd7f59ef9aa3f6e1a815464fe25560ec88fd8) for gbrain `0a008fe5`.
It now separates the proposed-tier comparison against three memory-system settings from the automatic person-linking
errors that led the team to keep person linking in review.

### 2026-11-20: The hard company questions' smaller lead is not a gbrain regression

The old-build control reported: gbrain's October build `09d21554d` scores within noise of v0.60.742.0 on the two new worlds
(+4.00 over files, newest minus October -1.50, -4.50 to +1.50). The "We learned" line, the hard-company row and
footnote 3 now say the smaller lead is not a gbrain regression, replacing "not yet known", and the known-limits line
adds the October build's -11.25 where sources disagree.

### 2026-11-20: Hard company questions, particle-1 row

A row for particle-1 on the hard company questions at v0.60.742.0 joins the results table: 67 of 200 right with gbrain
against 6 of 200 with plain files (+30.5 points, 24.5 to 37.0), still well behind Opus 5.5 with gbrain (158 of 200).

### 2026-11-19: Hard company questions re-measured on gbrain's newest release

The two hard-company rows (gbrain `3e4ff61ce`, +7.7 and +13.0 points, and `4e10136b4`, +10.67) are replaced by one
row measured at v0.60.742.0 on two new worlds, where gbrain is level with files (+2.50, -1.50 to +6.50), and a row for
questions where sources disagree, where it is behind (-16.25). The "We learned" line now says gbrain is level, not
ahead, and that the cause is not yet known. Footnotes 3 and 4 now carry the earlier builds' numbers and the
disagreeing-sources detail, and the known-limits line cites the new result.

### 2026-11-17: Every result row says which direction is better

The permission row read "Finance-only text reaching an agent's context", which didn't say whether that was good or
bad. It now reads "Leaks (fewer is better): finance-only text reaching the agent's context in 100 permission runs,
where the agent works for an account manager outside finance who isn't allowed to see it", and its headline changed
from "100 → 0 runs" to "100 → 0 leaking runs". Other rows whose direction wasn't plain now say it: the first table
names right answers for live recall, hard company questions, the newer reader and whole conversations, says finding
for the quoted-message and attendance rows, marks attacker claims "fewer is better", and splits contradiction finding
and timeline extraction into what should go up and what should go down. In the second table, the privacy row is
labelled a leak and the takes row a mistake count, both "fewer is better". No number changed.

### 2026-11-17: The results table leads with gbrain's gain and top-aligns every cell

The first results table is now an HTML table, because GitHub drops CSS from Markdown and only an HTML table can align
cells to the top: every cell starts at the top of its row. Each "With gbrain" cell opens with a large headline of how
far gbrain is ahead, level or behind, such as "+73.5 points", "+37 questions", "Within the margin, at about a seventh of
the cost" or "Behind, not separable", followed by the number, interval and footnote it had before. Headlines that
weren't printed before come from the row's own numbers or report: the count differences on LongMemEval (+37, +23 and
+29), the paired +30.4 points over the question alone on BEAM-10M from the scoreboard, the 8.7 points the file agent
leads by there, and the paired 95% interval of 0.6 to 14.4 for session pages from footnote 21. The gbrain commit and
report columns fold into one line of small type under each row's description, which leaves three columns. No number
changed, and the links checker now also checks the table's HTML links.

### 2026-11-17: Every compared result names a measured no-gbrain number

The twelve rows that waited for a baseline now show one, measured on the same tasks with the same reader and judge as
the gbrain number, and the table for baselines being measured is gone
([baselines](docs/benchmarks/2026-11-17-readme-baselines/README.md)). gbrain is ahead of plain Postgres hybrid search on
LongMemEval recall (451 against 414 of 470) and answers (468 against 445 with Sonnet 5.5, 474 against 445 with Opus
5.5), on attendance, on contradiction finding with Haiku 4.5, GPT-6 Luna and Sonnet 5.5, on memory pages' judged recall
and on attacker claims (2.8% against 10.2% of sessions). It is level with the whole history pasted into the prompt on
500 LongMemEval questions (471 against 468), with plain hybrid on a quoted message and on PrecisionMemBench, with BM25
on reworded relationship questions (0.616 against 0.537), with a plain prompt for GPT-6.1 Sol and Opus 5.5 judging
contradictions, and on timeline extraction by the preregistered page test. Footnotes 17 to 23 explain each level
result. The last takeaway now cites the 500-question whole-history comparison instead of the 150-question one, and a
new third takeaway gives the wins against plain Postgres search.

### 2026-11-17: Results split by whether they have a measured alternative

Most rows' "Without gbrain" cell said "not tested", which tells a reader nothing. The results table now holds only
rows with a measured no-gbrain number, and each names its own. Two rows gained one from their own reports: the newer
sealed worlds show the same files with `grep` at 318 of 600 (53.0%) against gbrain's 382 of 600 (63.7%), where the row
showed only the gap, and the sealed whole-conversation row shows the question alone at 40 of 200, from the set's
solvability check. Twelve rows whose alternative was never run moved to a second table that names the no-gbrain arm
being measured on the same tasks, reader and judge. Nineteen rows that check gbrain's own behaviour (updates,
`forget`, privacy, chat formats, large pages, sync, table repair, slug conflicts, forecasts, agent safety, takes,
scoped vector search, the graph walk engine and the held-out multi-relation planner) moved unchanged to a third table
with no comparison column. No gbrain number changed.

### 2026-11-16: Updates, `forget`, privacy and chat formats measured at gbrain v0.60.733.0

The rows for updates, `forget`, privacy and chat formats now name `6ce7195b4` (v0.60.733.0), where the [November 16
keyless re-pin](docs/benchmarks/2026-11-16-w0-keyless-repin.md) reran them; chat formats now say every registered format passes, since CI's gate at that build
checks every format and keeps no count. Footnote 10 says which rows were rerun in full and which come from CI. Footnote
11 says the large-page row keeps `7a6bdd3`, because the 128 MiB PGLite slice passed the runner's memory ceiling on the
rerun's host at both builds. A new footnote 16 gives the keyword-path drop on reworded one-hop questions beside the
paid row, which waits for December. The open-loops limit adds forwarded FYI emails opening loops.

### 2026-11-16: Two known limits name the commit they were checked at

The open-loops and contradiction-probe limits say "at `6ce7195b4` (v0.60.733.0)" instead of "at the pin", the commit
where gbrain's source was read for them, so a later re-pin doesn't attach them to a build nobody checked.

### 2026-11-16: The pin is named on one page

"What gbrain does" and the quick start's pinned-product row link to [the gbrain under
test](docs/gbrain-under-test.md#the-pin) for the version and commit instead of naming `6ce7195b4` (v0.60.733.0), and
the opening's note on what the page describes links there too, so moving the pin changes that page alone. No result
changed.

### 2026-11-16: Re-pin to gbrain `6ce7195b4`, gbrain's newest release

The pinned product moves from `d253ec0ff` (v0.60.623.0) to `6ce7195b4` (v0.60.733.0), gbrain's newest release, 110
releases later, and [CLAUDE.md](CLAUDE.md#choose-the-gbrain-build) now keeps the pin at the newest release. "What gbrain
does" adds three capabilities from that range: keyless search that finds pages holding most of a question's words
(v0.60.725.0), the conversation archive (v0.60.726.0) and brains for a company or for several people (v0.60.667.0 to
v0.60.725.0). The quick start's pin table names the new pin and the command that moves it. The memory trust row's
keyless check names the new pin: Cats 37 to 39 pass their keyless contracts at `6ce7195b4`. No paid result was rerun,
and every other row keeps the commit it was measured at.

### 2026-11-15: How gbrain compares adds the changing-facts battleground

"How gbrain compares" gains a paragraph and table for the
[changing-facts battleground results](docs/benchmarks/2026-11-15-changing-facts-battleground-results.md) (BG1), and its opening paragraph says
where gbrain stands there: level with the memory-bank and extract-first servers on current values, behind them on
questions about the past. The paragraph carries the gbrain, Particle and OpenAI lines.

### 2026-11-10: A known limit on BEAM questions their cited turns don't support

Known limits gains one bullet: between about a quarter and a half of the cited BEAM questions behind our results (27.5%
at 100,000 tokens to 52.2% at 10 million) have a reference answer that the turns they cite don't support, by at least
one of two validator models, and rescoring every published BEAM result we can on only the questions both validators pass
changes no published verdict. The bullet gives the BEAM-10M file-agent gap on those questions (-7.5 points, -19.5 to
+4.2, against the published -8.7, -16.4 to -1.4), the descriptive comparisons that lose or gain separation in both
directions, and the results that can't be rescored. No number in the tables changed, and the scoreboard block stays as
its receipt renders it. Why: the numbers we publish on BEAM carry this noise, and readers should know how much it moves
them ([item-support findings](docs/benchmarks/2026-11-10-beam-item-support.md)).

### 2026-11-10: The whole-history cost comparison is for one question per history

The LongMemEval takeaway, the whole-history row and its footnote now say that gbrain's reader cost was about a seventh
of the whole history's with one question per history, as W10c measured it. A history asked several questions can be
read from a prompt cache after the first, which wasn't measured. A note under the scoreboard block says S2b
full-context's spend was measured with a harness that never let a later question hit OpenAI's prompt cache, so it
overstates that arm's cost. No accuracy figure changed. [Corrections](docs/corrections.md#full-context-reads-and-openais-prompt-cache).

### 2026-11-09: The README opens with a scorecard against working without gbrain

The page now reads like the eval READMEs people use: one sentence on what gbrain-evals asks, the results on the first
screen against setups without gbrain, plain labels, a quick start that needs no keys, and version detail on a linked
page. No figure changed value; every number is copied from its report, and some secondary figures now live only in their
reports. The whole-history row gives the token counts its report measured instead of "~115,000", which came from another
report.

- **Opening.** One sentence on what gbrain-evals is and the question it answers, and a short "What gbrain does" that
  names the pin. The section "The gbrain under test" (about 550 words on the commits outside the release, the search and
  read defaults changed since results were measured, and flag names such as `search.query_facts_block`), the capability
  list and the paragraph on when the keyless correctness checks last ran moved to [the gbrain under
  test](docs/gbrain-under-test.md). The pin table moved to the quick start.
- **Results.** Three takeaways open the section. The table gains "Without gbrain" and "With gbrain" columns and leads
  with the experiments that have an arm without gbrain: live recall phase 2 (new here: Opus 5.5 13.3% with no retrieval
  against 86.7% with gbrain's tools, particle-1 9.3% against 68.0%), the hard company questions and their newer worlds
  against plain files, the permission runs, the whole-history comparison (moved from the comparisons) and the
  head-to-head scoreboard's BEAM-10M rows against no memory (25.8%) and against the file agent (67.6% against 58.9%).
  Concept search now shows the plain vector index it was measured against. Rows with no such arm say "not tested".
  Labels use plain words instead of internal names (`recall_all@5`, W10a, N9, Cat 35 and others), each row links one
  report, and caveats moved from the cells to numbered notes under the table. The BEAM wave 2 row moved to the
  comparisons, which already described it.
- **Comparisons.** A lead paragraph says where gbrain is ahead and that the largest sealed head-to-head ranks no system.
  The whole-history and agent-task paragraphs moved into the results table, because the whole history and plain files
  are setups without gbrain rather than other memory systems. The paragraphs after the scoreboard block call the F6
  rerun "a rerun at a newer gbrain" and no longer name a pull request.
- **Known limits.** A first entry repeats the hard company questions' weak spot, where sources disagree. Ledger entry
  codes became one link to the bug ledger, and F6 and RS1 are described instead of named. The RS1 entry no longer gives
  what minting cost or the per-eval budget; it says the full design cost more than one eval is allotted and a version
  that fit would detect only about 6.5 to 7.7 points.
- **Quick start.** A numbered quick start that runs with no API keys replaces "Try a small experiment". The paid
  commands follow it as pointers, without a cost estimate.
- **Disclosures.** The gbrain, Particle and OpenAI lines moved from beside individual results to one closing section,
  and [disclosures](docs/disclosures.md) says so.

Why: a reader deciding whether to try gbrain should see, before any method or version text, how an agent does with
gbrain against the same agent without it, in words that need no knowledge of our internal names.

### 2026-11-09: The N2 judges row counts OpenAI cache writes

The contradiction-judge row gives the cheapest passing model, gpt-6-luna, as $0.24 per 1,000 pairs (was $0.21). N2's
runner priced OpenAI's cache writes as plain input, and almost every judge prompt was a cache write; the
[corrections page](docs/corrections.md#openai-cache-writes) lists every OpenAI figure that moved. Luna is still the
cheapest passing model. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former
president of Y Combinator. Garry Tan runs Y Combinator.

### 2026-11-09: Re-pin to gbrain `d253ec0ff`

The pinned product moves from `62637c96a` (v0.60.557.0) to master `d253ec0ff` (v0.60.623.0). The memory trust row's
keyless check names the new pin: Cats 37 to 39 pass their keyless contracts at `d253ec0ff`. No paid result was rerun,
and every other row keeps the commit it was measured at.

### 2026-11-08: The F6 BEAM-1M known limit gives its intervals and points to the narrowed RS1 test

The known limit on ranking gbrain among the memory servers said "F6's 24 conversations put gbrain `0ccf2bdd` 1.4 to 9.3
points above four external systems at 8,000 tokens, which describes them but can't rank them". It now gives F6's
BEAM-1M gaps to the two leading servers with their 95% intervals under both judges, from the
[GST-1365 results](docs/benchmarks/2026-11-05-gst-1365-judge-robustness.md): memory-bank +2.0 (-1.4 to +5.4) and
extract-first +3.5 (+0.4 to +6.5) under frontier judges, +1.3 (-0.9 to +3.7) and +4.8 (+2.6 to +7.1) under
gpt-4.1-mini. It says those comparisons were preregistered as descriptive, on the set gbrain's settings were chosen on,
at `0ccf2bdd`, and that no non-inferiority claim exists until RS1 reports. The stage 0 sentence stays, and a new one
links the [narrowed RS1 preregistration](docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md), which revives RS1 as
that test. Why: the old range had no intervals, put four systems in one range and came from BEAM's judge alone, so it read as a
ranking it could not support. No number in the current-state tables changed.

### 2026-11-05: The Q1 block's comparisons under frontier judges

A paragraph after the F6 pointer under the Q1 block reports GST-1365: under frontier judges, 20 of F6's and Q1's 21
published gbrain comparisons on BEAM hold, and the BEAM-100K file agent's lead over gbrain's component row depends on
the judge, 5.1 points (1.3 to 8.6) under gpt-4.1-mini and 3.4 (-1.2 to 8.3) under frontier judges
([results](docs/benchmarks/2026-11-05-gst-1365-judge-robustness.md)). It carries the gbrain and OpenAI lines, because its
three-reader comparisons include gpt-6.1-sol's reader rows. The rendered block and every number in it are unchanged.

### 2026-11-04: A known limit on BEAM's judge for comparing answer models; the F6 pointer names the particle-1 add-on

Known limits gain one entry. On the eight F6 cells that the particle-1 add-on judged twice, gpt-4.1-mini scores
particle-1 above Opus 5.5 and GPT-6.1 Sol scores it below, so reader gaps under BEAM's canonical judge depend on the
judge ([finding](docs/findings/2026-11-04-particle-1-f6-addon.md)). The entry carries the Particle line. The F6 pointer
under the Q1 block links the finding. No number in the current-state tables changed.

### 2026-11-04: The reader replay row's Holm p is exact

The Opus 5.5 reader replay row's Holm p is 0.0002 (was 0.0006). The superiority gate returned the share of bootstrap
draws at or below zero, which is not a p-value; the exact one-sided sign-flip p replaces it
([audit](docs/audit/2026-11-04-superiority-p.md)). The row's claim, higher than Sonnet 4.6, stands. No other part
changed.

### 2026-11-04: Known limits name the stopped RS1 ranking set

Known limits gain one entry: no sealed set here is big enough to rank gbrain among the memory servers, and RS1, the
sealed ranking set built for that, stopped at stage 0 on November 4, because its full design costs about $8,200 all-in
and a $2,000 version would detect only about 6.5 to 7.7 points ([stage 0 finding](docs/benchmarks/2026-11-04-rs1-stage0.md)).
No other part changed.

### 2026-11-03: Known limits name the retired SkillOpt benchmark

Known limits gain one entry: no benchmark here measures a skill optimizer any more, because Opus 5.5 with no skill
already answers 36 of 36 `query` and 35 of 36 `briefing` gate tasks on the harder SkillOpt task set, so the benchmark
is retired, and Garry Tan decided to deprecate gbrain's iterative SkillOpt loop ([retirement finding](docs/benchmarks/2026-11-03-skillopt-retired.md)).
No other part changed.

### 2026-11-03: A pointer to the F6 current-master rerun

One line under the Q1 block points to the F6 rerun's published scoreboard (gbrain `0ccf2bdd`). The Q1 block and its
numbers are unchanged; they stay Q1's until the custodian re-renders them from the F6 receipt (#337).

### 2026-11-03: The Q1 block is re-rendered under the stop rule

The Q1 block and the scoreboard tables are the custodian's re-render of the receipt with `scoreboard.ts` at
`a1c346e8` (results commit `bf902d9f`, `SHA256SUMS` `00fabc3b`), so the file agent's 7 `context_overflow` stops
now score 0. Its BEAM-10M cell moves from incomplete 68.0% (193/199) to 67.2% (199/199), and its BEAM-1M sealed cell
from 71.1% (239/240) to 71.1% (240/240). The first loss bullet now reads 67.6% vs 58.9% on the 198 of 199 questions
scored for both, with a 12.4-point detectable difference (was 68.3% vs 59.0% on 192, 12.9 points), and the opening
sentence rounds the power check to 13.6 points. The paragraph above the block names the new commit and drops the
explanation the re-render made unnecessary. No other row changed.

### 2026-11-03: The Q1 file agent's context-overflow stops count as product failures

The paragraph above the Q1 block now says that the block's two file-agent cells (68.0% on BEAM-10M, 193/199, and
71.1% on BEAM-1M sealed, 239/240) leave out 7 `context_overflow` stops that the preregistered outcome rule scores 0 as
product failures, and what changes when the receipt is rendered again in custody: both cells cover every question, the
BEAM-10M cell falls and the loss bullet's shared questions become the 198 gbrain's whole-system row scored. The
block's hash check pins it to the published render, so the block itself is unchanged until that custody render.
`eval/runner/scoreboard.ts` now takes its product failures from the outcome rules; the rescore is in
[corrections](docs/corrections.md#q1-head-to-head-scoreboard).

### 2026-11-03: Re-pin to gbrain `62637c96a`

The pinned product moves from `311a83bbe` (v0.60.553.0) to master `62637c96a` (v0.60.557.0). One read default outside
the mode bundles changed in the range: since v0.60.555.0 (gbrain#8448) the facts block runs only on a `query` that
passes a token budget and adds at most `limit` rows, so that paragraph's facts-block sentence now says so. The memory
trust row's keyless check names the new pin: Cats 37 to 39 pass their keyless contracts at `62637c96a`. No paid result
was re-run, and every number keeps its own commit.

### 2026-11-02: Re-pin to gbrain `311a83bbe`

The pinned product moves from `a131fb20e` (v0.60.549.0) to master `311a83bbe` (v0.60.553.0). No read default
outside the mode bundles changed in the range, so that paragraph stands. The memory trust row's keyless check names the
new pin: Cats 37 to 39 pass their keyless contracts at `311a83bbe`. No paid result was re-run, and every number keeps
its own commit.

### 2026-11-02: Re-pin to gbrain `a131fb20e`

The pinned product moves from `ca1281a2e` (v0.60.542.0) to master `a131fb20e` (v0.60.549.0). No read default
outside the mode bundles changed in the range, so that paragraph stands. The memory trust row's keyless check names the
new pin: Cats 37 to 39 pass their keyless contracts at `a131fb20e`. No paid result was re-run, and every number keeps
its own commit.

### 2026-11-02: Re-pin to gbrain `ca1281a2e`

The pinned product moves from `3ec766c40` (v0.60.531.0) to master `ca1281a2e` (v0.60.542.0). The paragraph on read
defaults outside the mode bundles now covers five: since v0.60.536.0 a remote reader also gets text below the owner's
own notes quoted, with more read surfaces quoted through v0.60.541.0. Its claim that `search_exact`, `get_chunks` and
timeline rows return stored text no longer holds and is gone. The memory trust row's keyless check names the new pin:
Cats 37 to 39 pass their keyless contracts at `ca1281a2e` after the harness read labels and facts inside the fence. No
paid result was re-run, and every number keeps its own commit.

### 2026-11-02: The full-context paragraph carries the gbrain and OpenAI lines

The "Retrieval or the whole history" paragraph reports gbrain's result and GPT-6.1 Sol's beside particle-1's, so after
the Particle line it now carries two more from [docs/disclosures.md](docs/disclosures.md): gbrain is Garry Tan's own project. Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator. No
figure changed.

### 2026-11-01: The particle-1 sentence carries its disclosure

The particle-1 sentence in the "Retrieval or the whole history" paragraph now ends with the line from
[docs/disclosures.md](docs/disclosures.md): Y Combinator, which Garry Tan runs, is an investor in Particle. No figure
changed.

### 2026-11-01: The reader replay row no longer ranks readers

The reader replay row said "Best reader on the same retrieval" and "above Sonnet 4.6's 453 after Holm". W10b's
[preregistration](docs/benchmarks/2026-10-06-longmemeval-w10-preregistration.md) tests each reader against the replayed
Sonnet 4.6 run, one-sided with Holm across six arms, and says a pass reads "this reader scored higher than Sonnet 4.6 on
this retrieval". It never compares the newer readers with each other, so "best" was a ranking it does not support. The
row now says Opus 5.5 scored higher than Sonnet 4.6 and that the test does not rank the newer readers. The comparator
count changes from 453 to 451: 453 is Sonnet 4.6's score under gbrain's own judge wrapper in the
[2026-09-29 run](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md), while the Holm test and the row's 474 use the
official `gpt-4o` judge, under which Sonnet 4.6 scored 451.

### 2026-11-01: particle-1's two W10c rows join the full-context paragraph

The "Retrieval or the whole history" paragraph gains one sentence from the [particle-1 replay](docs/benchmarks/2026-11-01-longmemeval-particle-replay/REPORT.md): particle-1 at high effort answered 135 of the 150 W10c questions on gbrain's retrieval and 140 with the whole history, within the preregistered 7-point margin by the registered test (decision G; Tango's score test puts it just outside, p = 0.060), at $0.0047 and $0.0275 per question at list price. The plan for particle-1 adds this sentence whatever the result; the paragraph's headline and its Sonnet 5.5 and GPT-6.1 Sol numbers do not change. The report also finds that at this history size particle-1 reading the whole history costs about what Sonnet 5.5 reading gbrain's retrieval costs; whether the headline moves toward longer histories is a separate decision.

### 2026-11-01: Results name their commits; N14 row; corrections and history move out

gbrain-evals #241, the documentation refresh at the pin `3ec766c40` (v0.60.531.0).

- **Results.** Every row names the gbrain commit it was measured at: the multi-relation planner its held-out build
  `94bd52e01` (was v0.60.60.0), Cat 41 its candidate `b3f4e8b` (was v0.60.46.0), the three managed-sync rows
  `0ba3b1f7c`, `846bea442` with `a99c00565`, and `1935c74a` (were release numbers), sync freshness `4ba4c36f` (was
  v0.60.316.0), the first managed sync `426c4ef5` with its merge commit, and Cat 35 `079941d2` (was "Cat 35 run"). The
  ClientRead row says gbrain's fix in v0.60.114.0 was not measured here (was "fixed by"). A new N14 row reports
  large-page fidelity, counted at the previous pin `7a6bdd3`, where every preregistered rule passed for the first time.
  The sentence under the pin table now lists `94bd52e01` and `079941d2` beside `a7cb37b` as the commits outside the
  release's history.
- **Reruns.** The paragraph under the table said all 29 bug-ledger reproductions "pass at `77cf8e111`" and that the
  correctness rows are "rerun at every pin". No re-pin since `77cf8e111` has rerun them in full, so it now says they were
  last measured in full there, and that CI's smaller offline-tier versions passed at `3ec766c40` in #223's checks.
- **Comparisons.** Each comparison names its gbrain commit and links its report or the comparisons page: strict recall
  and the `gpt-5.4` reader (`109b992`), whole history (`c5fb0201`), PrecisionMemBench (`2efaaf8f`), BEAM wave 2
  (`71b6d85`), concept search (`d44296c`) and Cat 40 (`3e4ff61ce`, `51f865d78`). A new paragraph above the scoreboard
  block explains that its file-agent loss compares gbrain's whole-system row (59.0%) on 192 shared questions, not the
  8k row in its table (56.3%), and that its 12.9-point and 13.58-point detectable differences come from different
  comparisons. The block itself is unchanged, because its hash is published at `f15e7302`; the generator's clearer
  sentence appears at the next custody render.
- **Pin section.** It said arms that measure gbrain's own defaults take all four new read defaults; it now names those
  arms and says the scoreboard's gbrain-defaults container builds `f05943e6` and runs none of them.
- **Known limits.** The open-loops, contradiction-scanner and associative-recall lines name their ledger entries; the
  first two were checked against gbrain's source at the pin, and the third names its commit, `3a284ae`. A new line says
  the scoreboard's gbrain rows measure `f05943e6`, not the pin.
- **Moved out.** The Corrections section moved to [docs/corrections.md](docs/corrections.md), together with the
  retirement of the first Cat 40 world's success figures, which the finance row and the agent-task comparison carried;
  "Where to read next" links it. The entries of this changelog from 2026-04-21 to 2026-10-31 moved to CHANGELOG.md. The
  repository row no longer names a version (was v0.10.139), so a release stamp no longer needs an entry here.

Earlier entries, from the first README on 2026-04-21 to 2026-10-31, are in
[CHANGELOG.md](CHANGELOG.md#readmemd-changelog-2026-04-21-to-2026-10-31).

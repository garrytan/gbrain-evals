# BEAM-10M on gbrain's newest release: public dry run (R111 pilot)

The dry run ran all three arms, P, A0 and whole, on the public BEAM-1M conversation 1m-16 at gbrain v0.60.743.0
(16124807cb7846ffba8aa093c7a6b588a76a5e13), from campaign `q1-scoreboard-bn10-newest-dry-run` (hash ead3158f6ad2),
cell `s2b-ingest.gbrain-defaults.bn10-newest`, lease run `s2b-ingest.gbrain-defaults.bn10-newest-a1-4bf82ec4`, on
one Ubicloud VM that was destroyed when the cell settled. It is the pilot the preregistration's amendment A2 asks for
under R111. It is not a counted result, so no accuracy figure appears here.

Every check passed for every arm with the two frontier readers, claude-opus-5-5 and gpt-6.2-sol, and with the
particle-1 re-read of the same frozen contexts (below).

## The four checks, per arm

| check | P | A0 | whole |
|---|---|---|---|
| 1. The part under test ran | pass | pass | pass |
| 2. Its judges pass the agreement check (R78) | pass | pass | pass |
| 3. The tasks can be supplied | pass | pass | pass |
| 4. At the planned rate | pass | pass | pass |

1. **The part under test ran.** Each arm ran under its own retrieval identity: P as `fixed-evidence@query-4252234265d2`,
   A0 as `fixed-evidence@query-481993624a87`, and whole as `vendor-default@query-9cf43e54a002`, a native-default
   `query` with no `limit`. The overlay readback matched the arm's identity on every delivered context (0 mismatches
   in each arm), and every delivered row's fence share was measured (below).
2. **Judges.** gpt-6.1-sol graded all 30 claude-opus-5-5 answers and claude-opus-5-5 graded all 30 gpt-6.2-sol
   answers, 10 of each per arm, with no `judge_error`, no unparsed verdict and no output-limit stop. Both judges
   passed the judge agreement check before this run. gpt-4.1-mini graded all 60 answers on the descriptive bridge view.
3. **Tasks.** All 10 questions produced a context in each arm, and each context an answer from both readers and a
   verdict: 30 contexts, 60 answers, no harness failure, no truncated context. The custody count of the S1 copy (10
   conversations, 199 questions) runs before the first counted cell, as the preregistration says.
4. **Rate.** Ingest took 1.89 hours for 926,773 tokens (928 sessions, 0 failed, background work drained), which is
   2.04 hours per million tokens against F6's 1.92. At that rate one S1 shard's ingest projects to about 22 hours,
   inside the plan's 41-hour VM timeout. Retrieval took 1.2 seconds at the median in every arm, and an answer
   7 to 9 seconds. No provider rate limit held a call back: 0 refused, 0 failed and 0 paused requests at the
   metering proxy.

## particle-1 re-read

particle-1 re-read the same 30 frozen contexts, 10 per arm, byte for byte. Every context matched its stored hash, and
all 20 stored answers per arm were cross-checked. Each arm got 10 particle-1 answers with no truncation. gpt-6.1-sol
graded every one on the gating view and gpt-4.1-mini on the descriptive view, with no judge error. There were 460
requests, all answered with status 200, and none was refused. With this step, the particle-1 reader passes checks 1 to
3 in all three arms. Check 4 is the frontier run's, because the re-read retrieves nothing.

## Fence share

The share of the reference budget (5,500 tokens) taken by quoted evidence rows, measured on every delivered context:

| arm | contexts measured | mean rows delivered | mean fence tokens | share of reference budget | unmatched quoted rows |
|---|---|---|---|---|---|
| P | 10 of 10 | 27.6 | 1,347 | 0.245 | 0 |
| A0 | 10 of 10 | 50 | 3,578 | 0.650 | 0 |
| whole | 10 of 10 | 4.3 | 269 | 0.049 | 0 |

## Judge agreement on the dry run's answers (descriptive)

| judge pair | answers both graded | agreement | kappa |
|---|---|---|---|
| claude-opus-5-5 and gpt-6.1-sol | 0 (each grades only the other family's reader) | - | - |
| claude-opus-5-5 and gpt-4.1-mini | 30 | 26 of 30 | 0.72 |
| gpt-6.1-sol and gpt-4.1-mini | 30 | 28 of 30 | 0.83 |

[fence-share.json](fence-share.json) and [agreement.json](agreement.json) hold the full outputs of
`eval/runner/bn10/fence-share.ts` and `bun eval/runner/q1/bn10-judges.ts agreement`.

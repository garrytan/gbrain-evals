# Probe: search_exact on gbrain's starter tools for Cat 40 H1

This is a one-arm development probe, not a benchmark result. It reuses the nightly gbrain check's Cat 40 world M dev set,
so its numbers are dev-set numbers and never a Cat 40 Hard result.

## Question

Cat 40 H1 asks for an exact set of accounts (for example, "which growth APAC accounts had an open escalated support
ticket on 2026-03-14?"), and each task needs 17 to 50 gold pages. In the 2026-11-10 nightly matrix, gbrain master
001c8c39 failed 75 of 84 H1 episodes, 56 of them on the 16-turn cap. `search_exact` (find every page containing a
literal phrase, exhaustively) is not on gbrain's starter MCP surface. Six of those 84 episodes found it through
`request_tools`, all late, and on a starter session `request_tools {tools: ["search_exact"]}` lists the tool while
dispatch still answers `unknown_tool` until the agent widens the whole session to `full`.

Does listing `search_exact` on the starter surface from turn one fix H1?

## The arm

gbrain 001c8c39 plus [gbrain-starter-search-exact.diff](gbrain-starter-search-exact.diff): one line adds
`search_exact` to `STARTER_OPS`, so it is listed, callable and described like every other starter tool. It is the
change gbrain would ship. A keyless check on both builds (`gbrain serve --surface starter` on an empty brain) found
the patched build lists 37 tools where the base lists 36, the only addition is `search_exact`, the other 36 keep their
order, the initialize instructions are byte-identical, and `search_exact` answers where the base build answers
`unknown_tool`.

Everything else is the 2026-11-10 master cell: `eval/runner/nightly/run.ts` at tier matrix with `--suites cat40-hard-m`
and the 14 H1 items, both frontier readers (`claude-opus-5-5`, `gpt-6.1-sol`), k = 3, the agent loop and its 16-turn
cap, the scorer, the claims judge and the dev set's suite digest (0b7a55c3bc8a). No Cat 40 frozen file changed between
the 2026-11-10 runner commit (a9aee5bd) and this branch. `--cat40-call-turns` records the turn of each gbrain tool
call; it changes nothing the agent sees.

[probe.sh](probe.sh) runs it on a Ubicloud VM under its own budget ledger.

## Comparison and decision rule (written before the run)

Each probe episode is paired with the 2026-11-10 master row of the same reader, item and trial: 84 pairs, 42 per
reader.

- **Primary:** the pooled pass-rate difference, probe minus 2026-11-10 master, with a 95% interval from a paired
  bootstrap that resamples items (14 items, each carrying its 6 pairs; 10,000 resamples, seed 20261111). The exact
  McNemar p-value on the discordant pairs is reported beside it. The same is reported per reader.
- **"Clears most of H1's failures"** means at least 38 of the 75 pairs that failed on 2026-11-10 pass in the probe, and
  the pooled interval excludes zero. Anything less is reported as not clearing most failures, with what still fails and
  why.
- **Detectable difference:** with 84 pairs, exact McNemar reaches p < 0.05 with 6 net gains and no losses (about 7
  points), or 12 gains against 3 losses (about 11 points net). Item clustering widens the bootstrap interval beyond
  that. A majority of failures flipping (38 pairs, 45 points) is far above either.
- **Descriptive, per reader and pooled:** turn-cap stops, `search_exact` calls per episode and the turn of the first
  call (the probe's turn comes from the call-turn log; the 2026-11-10 rows give only the call's position), gold pages
  named in tool results and cited against gold pages needed, refusals and tool errors, and cost per episode.

## Amendment, 2026-11-11 (after the run; analysis only, no change to the arm, the pairing or the decision rule)

- The call-turn log records slot, turn, tool and time but no attempt id, and the cells ran 10 at a time on 5 slots, so
  two episodes often shared a slot at once and a slot-and-time join cannot tell them apart. `analyze.py` now joins an
  attempt only when exactly one slot's first calls in its window match its calls in order, and reports the rest as
  unmatched. The first call's position, which the 2026-11-10 rows also give, is the like-for-like description of when
  `search_exact` was first used; the turn is reported only for the episodes that joined.
- `analyze.py` also reports cost per correct answer, calls per episode, and, from the probe's cell attempts,
  `search_exact` result sizes and token use per episode.
- Counting every `search_exact` call, refused ones included, 7 of the 2026-11-10 episodes called it, not 6.

# W1 guidance smoke (A12g): result, 2026-10-13

**A12g failed. Opus 5.5 passed 2 of 5 sessions and Fable 5.1 passed 5 of 5. The rule needs both models at 4 of 5 or better, so gbrain's `recall` `question` guidance stays parked.** No session loaded the guidance. The gbrain plugin was installed and its `brain-ops` and `query` skills were listed in every session, but none of the 10 sessions invoked a skill.

The rules were fixed in [the preregistration](2026-10-13-w1-guidance-smoke-preregistration.md), pushed at `7964d938` before any session ran. The run followed it with no changes: 10 sessions, run once, none replaced, $3.43 of the $8 cap.

## What was tested

Gbrain's guidance tells an agent to pass the user's question as `recall`'s `question` for question-shaped lookups. With `question`, saved facts come back ranked by relevance instead of newest first. The guidance lives in the `brain-ops` and `query` skills. A12g asked whether an agent gets it the way a user would: the gbrain plugin installed natively in Claude Code 2.1.296 from gbrain `d5a86e4f8` (master `148b74d14` plus the guidance), with its skills discovered by Claude Code. There was no CLAUDE.md, and the prompt does not mention the guidance or `question`.

Each session had A12's prompt (three questions: a plain one, one that invites a filter, one on a keyless archive) and A12's two MCP servers. One server embeds facts. The other has embeddings turned off, so `recall` with `question` there returns `facts_degraded`.

## Result

| Session | `question` → relevance | Filtered `question` call | `facts_degraded` call + caveat | Skill loaded | Pass |
|---|---|---|---|---|---|
| Opus `o1` | yes | no | no | none | no |
| Opus `o2` | yes | yes | no | none | no |
| Opus `o3` | yes | yes | yes | none | yes |
| Opus `o4` | yes | yes | yes | none | yes |
| Opus `o5` | yes | yes | no | none | no |
| Fable `f1` | yes | yes | yes | none | yes |
| Fable `f2` | yes | yes | yes | none | yes |
| Fable `f3` | yes | yes | yes | none | yes |
| Fable `f4` | yes | yes | yes | none | yes |
| Fable `f5` | yes | yes | yes | none | yes |

- **Opus 5.5: 2 of 5, fails.** Three Opus sessions never sent `question` to the keyless archive. Two read it with `recall(entity, include_expired)` and one with `recall(entity)`, each after an `archive` `search`. One of those three (`o1`) also put no filter on its one `question` call.
- **Fable 5.1: 5 of 5, passes.**
- **All 30 answers were correct.** Every session found the meeting place, the $46,500 budget and the $1,800 deposit, and every answer named a keyword-only or exact-match limit (the caveat words the rule checks).
- **No skill was invoked in any session.** `gbrain:brain-ops` and `gbrain:query` were in each session's skill list (checked in every transcript's init event), but no session called the `Skill` tool. So this run measured the tool descriptions again, with the guidance one step away and unused.

## Compared with earlier runs

| Run | Setup | Opus 5.5 | Fable 5.1 |
|---|---|---|---|
| A12, before gbrain#6602 | tool descriptions only | 3 of 5 | 2 of 5 |
| A12 re-run, after gbrain#6602 | tool descriptions only | 1 of 5 | 5 of 5 |
| Descriptive, not counted | guidance pasted into CLAUDE.md | 5 of 5 | 5 of 5 |
| **A12g (this run)** | **plugin installed, skills discovered natively** | **2 of 5** | **5 of 5** |

With the guidance in front of the agent, both models pass. When it is only discoverable as a skill, the agent does not open it for this task. The guidance's text is not what failed here. The skill's short description, the part an agent sees before choosing a skill, did not get it opened. Five sessions per model is a smoke, not a measurement, and the difference between 1 and 2 of 5 on Opus is noise.

## Decision

The guidance does not ship and stays parked on gbrain branch `capy/w1-guidance-parked`. Gbrain is unchanged. Shipping it would take a way to put it in front of the agent: either the `brain-ops` skill's description (so agents load it for memory questions), or text the MCP server itself serves. Either needs a new preregistered smoke.

## Files

In [`2026-10-13-w1-guidance-smoke/`](2026-10-13-w1-guidance-smoke/):

- `transcripts/s-o1.jsonl` … `s-f5.jsonl`: every session's stream-json transcript, and `install-*.log`, each session's plugin install. Home and temp paths are rewritten to `~/` and `<tmp>/` with the repo's `scrubMachinePaths` (`eval/runner/receipt.ts`). Nothing else changed, and the scrubbed transcripts score the same.
- `scores.txt`: `score-a12g.py` output (its `answers` field is case-sensitive and reads "North entrance" as missing; the case-insensitive check above finds all three answers in all 10 sessions).
- `run-all.log`: the run log, with spend after each session.
- `skillcheck.out`: the no-model skill check from the preregistration.

The harness scripts and fixtures are copied verbatim, with sha256, in the preregistration.

# Frontier headroom probe

This is plan revision 3's decision A3, preregistered as [amendment 2](../../PREREGISTRATION.md). The one read of the sealed test split that followed (amendment 3) is in `test-<target>/` below, and the [report](../../REPORT.md) reads both. It ran on 2026-11-02 at gbrain `ca1281a2` (0.60.542.0) and gbrain-evals `a1147c97` (branch `capy/gbev24-frontier-probe`), on the selection split of `skillopt-method-v2`. The test split was not read. The targets were `anthropic:claude-opus-5-5` and `openai:gpt-6.1-sol`, and every rewrite was proposed by `anthropic:claude-opus-5-5`. Every number below comes from these receipts.

| Target | Skill | No skill (1 run) | Seed (3 runs) | One-shot repeats | Kept | Gate | Mean rollout, F0a / F0b |
|---|---|---|---|---|---|---|---|
| Opus 5.5 | `query` | 0.17 | 0.75 | 1.00, 1.00 | 1.00 | one-shot at ceiling | $0.134 / $0.124 |
| Opus 5.5 | `briefing` | 0.17 | 0.46 | audit-disqualified, audit-disqualified | 0.46 (seed) | qualifies | $0.286 / $0.297 |
| Opus 5.5 | `fact-check` | 0.00 | 0.79 | audit-disqualified, 1.00 | 1.00 | one-shot at ceiling | $0.176 / $0.163 |
| GPT-6.1 Sol | `query` | 0.88 | 0.71 | 0.92, 1.00 | 1.00 | one-shot at ceiling | $0.033 / $0.032 |
| GPT-6.1 Sol | `briefing` | 0.17 | 0.54 | audit-disqualified, 1.00 | 1.00 | one-shot at ceiling | $0.079 / $0.048 |
| GPT-6.1 Sol | `fact-check` | 0.00 | 0.58 | audit-disqualified, 1.00 | 1.00 | one-shot at ceiling | $0.091 / $0.054 |

**Gate.** Opus 5.5 is `build-one-skill` (`briefing`), and GPT-6.1 Sol is `stop`. The counted-skills pick is `briefing` on Opus and nothing on Sol. Every seed was in band, so F0b ran all six pairs. The solvability ceiling is 1.00 for every skill.

**What the gate rests on.**
- Seven rewrites passed the audit, and each scored 0.92 or 1.00. Each of the five pairs with a clean rewrite reached the ceiling.
- The audit disqualified five of the twelve rewrites. Each one put a date or a value into an example, and two of them used "12%", a `briefing` train gold value. On Opus `briefing`, both rewrites were disqualified. So that pair's kept one-shot is the seed's score by rule, not a measured floor, and that is the only reason it qualifies.
- The rewrites were written from train trajectories only, with selection gold withheld (`proposer_withheld` in each receipt), and were scored on selection.
- The task families are templated, so a rewrite that learns a family's procedure transfers within the set.

**Other signals (not counted).**
- On GPT-6.1 Sol `query`, no skill scored 0.88 and the seed 0.71. No skill beat the seed on 4 of the 24 tasks and never lost to it. No skill runs once per task, so this is a lead for the test split, not a result.
- On every other pair, the seed beat no skill by 0.29 to 0.79.

**Served tools and settings.** The rollouts served each skill its declared read operations: `query` got `recall` and `get_timeline`, and `briefing` got `get_timeline`. Retrieval was keyword-only, and no embedding call was made. Opus ran with gbrain's defaults: no thinking and `max_tokens` 32,000. GPT-6.1 Sol ran with `max_output_tokens` 4,096 and no reasoning field sent, and OpenAI applied medium effort. Each receipt records `request_settings`.

**Test split (amendment 3).** Every kept rewrite scored 1.00 on the 36 test tasks, and beat the seed on all six pairs. The seed beat no skill on five pairs, but not on Sol `query` (0.72 against 0.86). The report rates that a FIX-METHOD, because at this gbrain pin `get_page`, `traverse_graph` and `get_backlinks` reject every call Sol makes. The [report](../../REPORT.md) has the full table and the reproduction. The read cost $163.06 on ledger run `n15-skillopt-method-test-read-2026-11-02T03-04-45-593Z-f0a9f695`.

**Spend.** The ledger run `n15-skillopt-method-frontier-probe-2026-11-02T00-00-46-604Z-1ae07142` committed $145.04 against a $330 cap:
- smoke and F0a: $79.40;
- F0b on Opus: $45.29;
- F0b on Sol: $20.34.

No price trigger fired.

| File | What it is |
|---|---|
| `smoke/`, `smoke.log` | one seed rollout per target on `query-train-01` |
| `f0a-<target>/`, `f0a-<target>.log` | no skill and seed per skill |
| `f0b-<target>/`, `f0b-<target>.log` | the one-shot per pair, with proposer inputs and rewrites under `one-shot/` |
| `test-<target>/`, `test-<target>.log` | the sealed test-split read: no skill, seed and kept rewrite per pair, with paired intervals, McNemar p and verdicts (amendment 3) |

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

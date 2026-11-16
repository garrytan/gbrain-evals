### A re-pin needs a new row in the SkillOpt replay test only when gbrain's answers change

- **What changed.** `test/eval/skillopt-tool-calls.test.ts` replays GPT-6.1 Sol's 651 recorded SkillOpt calls and
  keeps the counts for each gbrain pin. A pin with no row of its own must now give the newest row's counts, instead of
  failing because it has no row, so a re-pin that changes nothing there passes as is. When gbrain changes the counts,
  the test still fails until the new pin gets its row. Two limits in [README.md](README.md) and two lines in
  [docs/gbrain-under-test.md](docs/gbrain-under-test.md) name `6ce7195b4` (v0.60.733.0), where they were checked,
  instead of "the pin".
- **Why.** A daily re-pin should stay mechanical, and a claim checked at one commit shouldn't move to the next pin
  unchecked.

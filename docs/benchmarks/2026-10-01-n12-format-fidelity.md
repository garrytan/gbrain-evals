# Ingestion format fidelity: transcript adapters, conversation-parser patterns and attendance (2026-10-01)

## The finding

When a conversation arrives in any format gbrain registers, gbrain keeps who spoke, when, and how many turns there were. We rendered the same 8 seeded conversations (38 turns) into all 27 registered formats: the 7 transcript adapters and the 20 conversation-parser patterns, both read from gbrain's own registries at run time. Results:

- **Transcript adapters.** Role attribution was right for 266 of 266 turns, and timestamps were exact for 266 of 266 turns. Turn-count error was 0 across all 56 files. Detection picked the right adapter for 56 of 56 files.
- **Parser patterns.** The speaker was right for 760 of 760 turns. Timestamps matched at minute precision on 532 of 532 turns whose format carries a time. Pattern detection was right on 160 of 160 pages.
- **Attendance.** Attendance from the four documented evidence forms scored 20 of 20 attendees with zero false attendance.

Two problems turned up, plus one behaviour of the legacy schema pack:

1. **A short status note parses as a conversation.** It is a 26-line page with three one-off bold labels (`**Status:**`, `**Owner:**`, `**Next step:**`), and gbrain returns a 3-turn chat whose speakers are "Status", "Owner" and "Next step". This breaks the safety contract preregistered for this category ("no fabricated turns"), so the category verdict is `fail` (3 fabricated turns from 1 of 16 negative items).
2. **An offset-stamped source lands one day early on the page.** Four adapters pass a source timestamp like `2026-08-10T22:30:00.000-07:00` through unconverted. The page renderer then writes the UTC hour next to the local date, so the re-parsed turn is `2026-08-10T05:30Z` instead of `2026-08-11T05:30Z`. That affected 16 of 16 offset-stamped turns; the 250 turns from sources that write `Z` were all exact. Every host fixture in gbrain writes `Z`, so only sources that write offsets are affected.
3. **Legacy-pack attendance (a recorded gap, not a bug).** A brain with no `schema_pack` configured falls back to the bundled legacy `gbrain-base` pack. That pack types every person linked on a meeting page as attended: 24 false attendances for 24 people who were only mentioned. A brain set up the way `gbrain init` does it (`gbrain-base-v2`) had none.

The documented limits behave as documented, and each is recorded as a gap:

- There is no generic JSON transcript adapter.
- Date-less patterns stamp `1970-01-01` when the page has no date (494 of 494 such turns).
- Patterns drop seconds (36 of 152 turns whose line carried non-zero seconds).
- Grok has no per-message times.
- Attendance is read only from the documented forms.

Evidence maturity: synthetic production path. Every number comes from gbrain's own code paths on generated data with generator gold.

## The concrete case

An invented example. Frank Example (the user) and Dana Example (the assistant) exchange four messages on 2026-03-03 between 13:00 and 13:24 UTC. Here is how the first message looks in three of the 27 formats:

```text
codex rollout:   {"timestamp":"2026-03-03T13:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Remember to ... ref zq099c"}}
iMessage page:   **Frank Example** (2026-03-03 1:00 PM): Remember to ... ref zq099c
IRC (weechat):   13:00 <frank> Remember to ... ref zq099c
```

Each turn carries a unique marker (`zq099c`), so a parsed message can be traced back to its turn wherever it lands. The gold for every rendered file is the generator ledger plus what the renderer wrote, never gbrain output.

A renderer writes only what its host format can carry, so gold differs by format:

- The IRC line has no date, so its gold time is the page date plus 13:00.
- The codex file carries milliseconds, so its gold is the exact instant.
- A role-only format such as the ChatGPT export gets the gold label "user" or "assistant", not a name.

## The experiment and results

**Formats.** We enumerate formats from `transcriptAdapters()` (`src/core/transcripts/detect.ts`) and `BUILTIN_PATTERNS` (`src/core/conversation-parser/builtins.ts`) at run time. A registered format with no renderer is reported as a coverage miss. Coverage is 27 of 27 (7 adapters, 20 patterns), with no stale renderers.

**Conversations.** There are 8 seeded conversations (38 turns):

- a plain control conversation;
- 12-hour clock edges with seconds;
- multi-line turns;
- three speakers, one with a non-ASCII name;
- consecutive turns by the same speaker;
- turns with label-, time- and list-shaped lines;
- a conversation that crosses midnight UTC;
- a source that stamps instants with a `-07:00` offset.

Seed 12 is the headline run. Seed 7 gave the same result on every headline rate, safety contract and floor. Only the counts that depend on randomly drawn seconds moved: seconds dropped was 40 instead of 36, and exact matches against the true instant moved slightly.

**Stages.** Everything runs in process and keyless, with the LLM fallback and polish off. System One is off by construction (`withHermeticEnv`).

| Stage | Entry points | Measure (denominator) | Seed 12 result |
|---|---|---|---|
| Adapters | `detectAdapter`, each adapter's `parse` | role right (266 turns) | 266 / 266 |
| | | timestamp exact, instant equality (266 turns) | 266 / 266 |
| | | turn-count error (56 files) | 0 on every file |
| | | detection picked the rendered format (56 files) | 56 / 56 |
| | | noise leaks: text from records the spec says are skipped (system prompts, tool calls and results, reasoning, sidechains, abandoned branches, mirrored items) | 0 |
| | | invented timestamps: an instant not written in the source or its sidecar (266 turns) | 0 |
| | | skipped-line honesty: reported `skippedLines` equals malformed lines written (32 line-format files) | 32 / 32 |
| Round trip | `renderSessionParts` then `parseConversation` (the import lane's path to facts) | speaker label right (266 turns) | 266 / 266 |
| | | timestamp exact at minute precision (266 turns) | 250 / 266 (all 16 misses are the offset source) |
| Parser, page date in frontmatter | `parseConversation` | speaker right (760 turns over 160 pages) | 760 / 760 |
| | | timestamp right at minute precision (532 timed turns) | 532 / 532 |
| | | turn-count error (160 pages) | 0 |
| | | the intended pattern won (160 pages) | 160 / 160 |
| Parser, no page date | `parseConversation` | turns stamped 1970-01-01 (494 turns in date-less formats) | 494 / 494 (documented) |
| | | inline dates lost (266 turns in date-carrying formats) | 0 |
| Honesty | `parseConversation` on 5 non-conversation pages; each adapter on its noise-only and garbage files (11) | turns fabricated (16 negative items) | 3, all from the bold-label status note |
| | | zero-session files without a reason (11) | 0 |
| | | generic JSON transcript | detectAdapter: `unknown_format`; parser: `no_match` (gap) |
| Attendance | `put_page`, `get_links`, `get_backlinks` on PGLite, schema pack `gbrain-base-v2` | attendees typed attended, documented forms (20) | 20 / 20 |
| | | attendees typed attended, undocumented forms (10) | 0 / 10 (gap) |
| | | mentioned-only people typed attended (24) | 0 |

How the parser's timestamps hold up against the true instant, not just what the text carries:

| Format family | Timed turns | Minute-exact vs text | Exact vs text, with seconds | Exact vs true instant |
|---|---|---|---|---|
| date and time in every line (7 patterns) | 266 | 266 (100%) | 239 (89.8%) | 203 (76.3%) |
| time only, date from frontmatter (7 patterns) | 266 | 266 (100%) | 257 (96.6%) | 189 (71.1%) |
| no time (6 patterns) | not scored (228 turns) | | | |

The gap between "exact vs text" and "exact vs true instant" is format loss, not a parse error. Seconds are dropped by design, and a time-only line on a page dated before midnight cannot say that a later turn happened the next day.

Grok's `chat_history.jsonl` has no per-message times. Its documented contract stamps every turn but the last with `summary.json` `created_at`, and the last with `last_active_at`. Grok turns are scored against that contract, and gbrain met it on all 38.

**Preregistered rules** (frozen in `eval/registry.ts` before the first run, commit `57a9bbb`):

| Rule | Kind | Result |
|---|---|---|
| no-fabricated-turns (`data.honesty.fabricated == 0`) | safety | **fail** (3) |
| no-noise-leak (`data.adapters.noise_leaks == 0`) | safety | pass (0) |
| no-invented-timestamp (`data.adapters.invented_timestamps == 0`) | safety | pass (0) |
| no-false-attendance (`data.attendance.false_attended == 0`) | safety | pass (0) |
| control-turn-floor (`data.floor.control_recovered_rate >= 1`) | quality (utility floor) | pass (27 of 27 formats) |
| attendance-control-floor (`data.attendance.control_recall >= 1`) | quality (utility floor) | pass (5 of 5) |

The receipt verdict is the safety contracts only, so it is `fail`.

**Gate status (2026-10-01, gbrain-evals 0.10.5): report-only, rules held.** The fix for N12-1 is in gbrain fix wave 5 ([garrytan/gbrain#5839](https://github.com/garrytan/gbrain/pull/5839)), which had not merged to gbrain master when 0.10.5 shipped. The registry row keeps its frozen rules but marks them `held`, so `all.ts --tier offline` evaluates and prints them and reports N12 as REPORTED rather than failing. When gbrain master contains the fix, re-pin, rerun N12, and remove the hold in that commit; the rule values do not change.

**Scorer validation.** The mutation suite (`test/eval/n12-format-fidelity.test.ts`) grades fake systems with the preregistered rules. The honest system passes, and every fake fails at least one rule:

| Fake system | Rules it fails |
|---|---|
| empty | control-turn-floor, attendance-control-floor |
| always-positive | no-fabricated-turns, no-noise-leak, no-false-attendance |
| always-refuse | control-turn-floor, attendance-control-floor |
| stale (previous turn's speaker and time) | control-turn-floor |
| wrong-source (another conversation's speaker and time) | no-invented-timestamp, no-false-attendance, control-turn-floor |

A deliberately broken adapter (roles swapped) fails the control floor. A parser that fabricates turns fails no-fabricated-turns. An adapter that throws is a scored miss.

**Run time.** 10.6 s for the hermetic run on a Capy machine (target 60 s).

## gbrain bugs found

### N12-1. A short status note with bold labels parses as a conversation

- **Contract.** `parse.ts` sets `SCORING_MIN_ACCEPTANCE` so that prose with stray anchors does not flip to `regex_match`, which "silently corrupts downstream fact extraction". `bold-name-no-time` sets `score_full_body` so that "a notes page with a few bold labels" scores below the floor.
- **Actual.** The guard is density-based: 3 anchors in 26 non-blank lines clears the 5% floor, so the page parses as 3 turns.
- **Fix direction.** Use a signal that does not depend on page length. Each label here occurs exactly once, which a real transcript almost never does. `score_continuations_min_distinct_speakers` already gives other patterns a similar gate.
- **Repro.** `bun docs/benchmarks/2026-10-01-n12-format-fidelity/repros/n12-1-bold-label-note.ts` (exits 1 while the bug reproduces).

### N12-2. Offset-stamped timestamps land a day early on the rendered page

- **Contract.** `TranscriptMessage.timestamp` is "ISO 8601 UTC, from the SOURCE" (`src/core/transcripts/types.ts`).
- **Actual.** The codex, openclaw, claude-code and claude-export adapters copy the source string, so `-07:00` survives. `anchorTimestamp` in `src/core/transcripts/render.ts` then takes the day from `iso.slice(0, 10)` (the local date) and the hour from `getUTCHours()` (UTC). The page reads `(2026-08-10 5:30 AM)` for an instant that is `2026-08-11T05:30Z`. `buildTranscriptSlug` takes its date from the same local slice.
- **Fix direction.** Normalize to UTC in one place, either in each adapter (`new Date(s).toISOString()`) or in the renderer and slug builder.
- **Repro.** `bun docs/benchmarks/2026-10-01-n12-format-fidelity/repros/n12-2-offset-timestamp-roundtrip.ts`.

## Documented limits (not bugs)

Each is in the bug ledger as a feature gap:

- **N12-3.** There is no generic JSON transcript adapter.
- **N12-4.** Date-less patterns fall back to 1970-01-01 when the page has no date.
- **N12-5.** Patterns keep minute precision only.
- **N12-6.** `Participants:` lines and transcript speakers are not attendance evidence.
- **N12-7.** The legacy `gbrain-base` pack types every linked person on a meeting page as attended. Its `attended` rule is bound to the page type, and pack verbs win over the attendance-evidence check in `extractPageLinks`. Brains with no `schema_pack` configured still get it. Repro: `bun docs/benchmarks/2026-10-01-n12-format-fidelity/repros/n12-7-legacy-pack-attendance.ts`.

Also documented and not measured:

- Adapters attribute turns by role only; no adapter sets a display speaker at this commit.
- The LLM fallback and polish phases are not measured; polish is declared but not wired.

**Category defect, N12-8.** The first development run left `schema_pack` unset and so measured the legacy pack. It was corrected before the counted run to configure `gbrain-base-v2`, as `gbrain init` does. The unset arm stays in the receipt as `data.attendance_legacy_pack`.

## Limits of this category

- The host file shapes come from the adapters' dated spec targets and gbrain's own fixtures. A misreading of a host format shared by gbrain and our renderers would not be caught here.
- The canonical shapes parse cleanly. Messy real exports (localized month names, wrapped lines, mixed formats on one page) are not covered.
- 8 conversations is a small sample. Seed 7 matched seed 12 on every headline rate.
- No paid arm ran. Spend was $0.

## Reproduce and inspect

```bash
bun install
bun eval/runner/n12-format-fidelity.ts                                    # pinned gbrain, keyless
bun eval/runner/n12-format-fidelity.ts --gbrain <gbrain checkout>@3a284ae # copied overlay, as published
bun eval/runner/n12-format-fidelity.ts --seed 7 --output /tmp/n12-seed7
bun eval/runner/all.ts --tier offline --only N12
```

Receipts are in [2026-10-01-n12-format-fidelity/](2026-10-01-n12-format-fidelity/): `receipt-pin-3a284ae.json` (seed 12) and `receipt-pin-3a284ae-seed7.json`. Both were taken through the copied overlay of gbrain `3a284ae`, on a clean gbrain-evals tree at `93143f2`. The ledger SHA-256 for seed 12 is in `hashes.ledger_sha256`. The findings are in the [wave bug ledger](2026-10-01-wave-bugs.md).

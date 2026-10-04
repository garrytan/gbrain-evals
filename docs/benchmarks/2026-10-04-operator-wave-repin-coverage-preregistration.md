# Preregistration: checks for the follow-ups in gbrain v0.60.41.0 to v0.60.46.0 (2026-10-04)

Frozen on October 4, 2026, in its own commit, before the counted runs of E1 to E4 and before any output of the regression VMs (which carry E5 and E6 and were already running) was read. The [regression check](2026-10-04-operator-wave-repin-preregistration.md) was frozen earlier and is unchanged. Each check was developed against the pinned gbrain `739e5cc` on this machine; those development runs are not counted. The counted runs are one run of `checks/run-all.ts` at `739e5cc` and one at `109b992`, both on Bun 1.4.2 with every provider key removed.

## What is checked

The wave 8 re-pin ([report](2026-10-03-wave8-f1-repin.md)) left two observations and one ledger bug that gbrain's agent-first operator wave (#5991, v0.60.46.0) says it fixed, and #5992 (v0.60.41.0) changed two behaviors that categories here can see. #5993 (v0.60.45.0) turned on automatic event extraction, which the separate OFF versus ON experiment measures with a chat model; the check here covers only what happens without one.

| Item | Script (`docs/benchmarks/2026-10-04-operator-wave-repin/checks/`) | Expectation at `739e5cc` | Expected at `109b992` |
|---|---|---|---|
| E1. Empty-grant hint | `grant-hint-token-id.ts` | a legacy token whose stored source list is `[]` is refused for `search` and `get_page` over HTTP MCP, and each refusal's text carries `rescope-token`, `--id` and that token's id from `access_tokens`; neither carries `<name>` | refused, but the fix says `<name>` (fails) |
| E2. `edit_page` diff order | `edit-page-diff-order.ts` | over MCP stdio, a one-line edit's receipt diff has exactly one removed and one added line, removed first; a two-line edit has two removed lines, then two added | added line first (fails) |
| E3. Per-page segment gap (#5918) | `segment-gap-5918.ts` | `gbrain extract-conversation-facts --dry-run --json` on six messages in three pairs 45 minutes apart: 3 segments with no gap key; 1 with `conversation_segment_gap_minutes: 60`; 3 plus a warning naming the range 1 to 10080 and `--slug` for a quoted `"60"` and for `20000` | the key is ignored: 3 segments without a warning (fails) |
| E4. `auto_chronicle` without a chat provider | `chronicle-receipt-keyless.ts` | with `chronicle.auto_settle_seconds 0`: a meeting dated 6 days ago gets `chronicle_backstop.pending = next_cycle`; a note gets no `chronicle_backstop`; a meeting dated 120 days ago is skipped as `history` with a fix whose consent includes `paid`; `gbrain dream --phase chronicle --json` reports `no_chat_provider` with 0 judged and 0 `no_events`; after `auto_chronicle false`, a meeting write is skipped as `auto_chronicle_off` | no `chronicle_backstop` field (fails) |
| E5. Cat7-1 | the ledger repro `2026-10-03-wave8-f1-repin/repros/cat7-get-timeline-1k.ts`, unchanged, run by the regression VMs | exits 0 (p50 at or under its frozen 0.075 ms limit) on the `739e5cc` VM in at least three of its four runs there (the repro list run plus three) | exits 1 on the `109b992` VM |
| E6. A4 grade (#5919) | A4's hermetic arm in the regression VMs' offline tier | answerable natural questions graded `moderate` rise from 40 of 120 to about 100 of 120 (any count from 90 to 110 matches gbrain's report); unanswerable natural questions graded `moderate` stay at 0 of 120 | 40 of 120 and 0 of 120 |

A check passes only when every expectation in it holds; `setup_ok` failing makes the check an error, not a product result.

## What the results do to the ledger

- **Cat7-1** closes as `fixed` with `fixing_pr` garrytan/gbrain#5991 and `fixing_commit` `739e5cc89ca43b9b9351f0f203c7b12a7c0c571c` when E5 holds and Cat 7's `get_timeline` at 1,000 pages on the `739e5cc` VM is not more than 25% slower than on the `109b992` VM's pre-regression receipt pair (0.045 and 0.052 ms). If E5 fails, Cat7-1 stays open with this review.
- **A4-2** gets a 2026-10-04 review at `739e5cc` with the grade counts. Its status stays `closed`. A4's report gets a dated annotation.
- **E1 and E2** were observations, not ledger entries, in the wave 8 report. Their results are reported; no entry is created when they pass. If one fails, it becomes a `bug` entry with the check as its repro.
- **E3 and E4** create a `bug` entry only if they fail at `739e5cc`.

## Not checked

`gbrain repair failed-writes`, the managed writer guard fix, `sources reconcile` classification and the publication-refusal record need a managed brain with a hand-modified schema or Postgres; the consent stops, status-only `serve` and the error envelope are pinned by gbrain's own journey tests. The regression check's Cat 12, N6 and the wave 8 checks touch some of these surfaces indirectly.

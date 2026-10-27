# F2 free frozen-hit step: decision rule (written before any number was computed)

Recorded 2026-10-12, before the replay ran. Source: PLAN.md at 8f5e4fad, F2 and its accepted lines
("free step measures deciding-sentence coverage, tokens and latency on frozen hits for chunk (today's output,
the control), window, section and page"; "fixed budget"; "any passage rule must beat the recorded
lexical-selector result (53/60 -> 48/60)"; "F2 does not claim to recover documents that never appear in the hit list").

Frozen hits. Every gbrain `search`/`query` call in the World M H4 cells (primary; 3 models x 20 tasks, build 3e4ff61c)
whose recorded result list contains a deciding document of one of the task's items. The deciding document is the
item's gold evidence record (executed contract or amendment); the deciding sentence is its sentence that states the
gold value. Stratum "long": deciding document body >= 20,000 characters (non-conversation by construction). Short
deciding documents are reported as a second stratum. The calibration/development world (r3, dev-r5 cells, same build)
is the check. S is not opened.

Replay. Each frozen call's full recorded hit list (same order, every page) goes to gbrain's own
`assembleEvidenceForHits` at the M build, once per unit: chunk, window (return_window 1, the default), section, page,
at one fixed budget: 6,000 tokens (`search.return_budget_default`, used by 573 of 658 M H4 searches). A second
condition gives the deciding page's hits alone the same budget (isolated), to separate unit effects from
budget sharing. `snippet_chars` is not applied (the plan has the passage lead the delivered text).

Measures per unit: coverage = share of frozen (call, deciding page) pairs whose delivered evidence for that page
contains the deciding sentence (whitespace-normalized); delivered bytes per call (all blocks) and per deciding
block (median, p90); assembly latency (local, in-process; indicative only).

Rule.
1. A unit is eligible only if its long-stratum coverage on M (shared-budget condition) is strictly greater than the
   chunk control's, and its short-stratum coverage is not lower than chunk's.
2. The recorded lexical-selector bar: the excerpt selector kept 48 of the 53 answers the full presentation got
   (90.6%). The analogue here is retention against the full deciding page, which always contains the sentence:
   an eligible unit must reach long-stratum coverage > 48/53 (> 90.6%). A unit that does not is reported as
   "does not beat the selector bar".
3. Among eligible units, pick the highest long-stratum coverage; if two are within 2 percentage points, pick the one
   with the lower median delivered bytes per call.
4. If no unit passes 1 and 2, the rule picks none, and F2 does not proceed to a unit-only paid step on the strength of
   this step; the report says which bar failed.
5. Dev must not contradict: the picked unit's dev long-stratum coverage must not be below chunk's on dev
   (if dev has fewer than 5 long frozen pairs, dev is reported but cannot veto).

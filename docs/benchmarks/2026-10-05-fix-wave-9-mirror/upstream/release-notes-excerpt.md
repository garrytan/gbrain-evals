<!-- Verbatim excerpts of garrytan/gbrain CHANGELOG.md (lines 67, 86, 94, 111 and 152) and docs/eval-takes-quality.md (the protocol_version and corrections field descriptions) at PR #6111 head 1fbe8660cb0dc1737d7bd9323aa9c6410dc80ec8. -->

## CHANGELOG.md

    - **Eval judges (takes-quality, cross-modal, synthesize triage) turn thinking off** on Anthropic, DeepSeek and OpenRouter DeepSeek routes. Takes-quality receipts are `protocol_version: 2`: a malformed judge reply gets one correction, recorded in `corrections`; `regress` flags a protocol change.
    - **Every gbrain database function pins `search_path`.** Bulk fact inserts through the withdrawal trigger take a little longer (10,000 rows: PGLite 1.31-1.46 s to 1.45-1.69 s, Postgres 531-536 ms to 565-604 ms).
    - **Takes-quality receipts** gain `protocol_version: 2`, `correction_selection_rule` and `corrections`.
    - Takes-quality: one same-model correction per malformed slot, priced against `--budget-usd` before it is sent (#5325).
    - Migration v211 pins `search_path` on gbrain plpgsql functions; the fact fingerprint functions qualify built-ins and stay inlinable (#5190).

## docs/eval-takes-quality.md

    - `protocol_version` — the eval protocol (absent on older receipts, read as
      1). Protocol 2 runs every judge with thinking off (so a judge-sized output
      cap is not spent on reasoning) and re-asks a malformed slot once. `regress`
      lists a protocol change among the dissimilar inputs.
    - `corrections` — one entry per slot whose reply was malformed: unparseable
      (`parse_failed`, including an empty reply) or missing a dimension
      (`incomplete_scores`). The same model gets the same sample once more with
      the validator's error appended. `first_error` is the first attempt's
      failure; `corrected` is `valid`, `invalid` (with `corrected_error`), or
      `null` when the correction was not sent (`skipped_reason`: `budget` when the
      cap could not cover it, `aborted`). Under `correction_selection_rule:
      corrected_if_valid` a corrected reply replaces the first attempt only when
      it validates. Provider errors and valid low scores are never re-asked.
      Correction calls count toward `cost_usd` and the budget cap.

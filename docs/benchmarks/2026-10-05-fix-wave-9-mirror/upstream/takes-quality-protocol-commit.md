<!-- Verbatim commit message of garrytan/gbrain 8a2d8a82aad5d32c5b3993fa16f8a75bd2f01103 (fix wave 9, #5325), an ancestor of PR #6111 head 1fbe8660cb0dc1737d7bd9323aa9c6410dc80ec8. -->

```text
fix(eval): takes-quality re-asks a malformed judge slot once (#5325)

A judge reply that was unparseable or missed one rubric dimension was
recorded as an error like a provider failure. With a small panel one such
slip dropped the cycle below quorum and the paid run reported inconclusive.

After each cycle the runner re-asks every malformed slot once
(slotFormatFailure: parse_failed, including an empty reply from a cap spent
on reasoning, or incomplete_scores) with the same model and sample plus the
validator's error. The correction is priced against --budget-usd before it
is sent (not sent: corrected null, skipped_reason budget|aborted) and
replaces the first attempt only when it validates. Provider errors and
valid low scores are never re-asked.

The receipt records the protocol (protocol_version 2: thinking-off judges
plus the correction pass), correction_selection_rule corrected_if_valid and
one corrections entry per malformed slot (first error, corrected outcome).
All fields are additive at schema_version 1; regress lists a protocol
change among the dissimilar inputs.
```

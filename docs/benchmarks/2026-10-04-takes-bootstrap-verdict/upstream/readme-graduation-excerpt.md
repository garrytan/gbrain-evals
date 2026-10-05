<!-- Verbatim excerpt of garrytan/gbrain evals/takes-bootstrap/README.md (the scorer row and Graduation protocol) at commit d37fab68e95e66347ba661e913cdafca330ae5a2. -->

| `scorer.ts` | Pure scoring + graduation verdict (`SCORER_VERSION 1`): per-kind precision ≥ 0.80 and recall ≥ 0.70, zero malformed cases (a case whose output can't be parsed is a FAILURE, never a skip — the denominator never shrinks silently), zero forbid violations. The report also breaks results down per variant (123 rows) and per archetype (41 rows); a variant passes when every expected claim matched, every prediction was precise and no forbid pattern fired. |

## Graduation protocol

1. Run live; commit the predictions JSONL alongside the PR that flips the
   autopilot tier (the replay mode keeps the receipt re-scoreable forever).
2. The tier flip PR must reference the passing report (per-kind table) and
   strike TODO-E.
3. Corpus growth: add archetypes (not raw cases) so variants stay
   label-invariant; the CI floors keep every precision class represented.

Per the North Star eval discipline: this scores FEATURE value — does the
classifier produce correct, correctly-attributed, correctly-weighted takes
rows for gbrain users — not a model bake-off.

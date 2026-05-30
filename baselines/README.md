# Published baselines for `gbrain eval gate`

This directory holds **hermetic-synthetic** baseline files consumed by
`gbrain eval gate --baseline <FILE>`. Each baseline is a snapshot of the
retrieval behavior of a known-good gbrain version against a placeholder
test corpus. CI in this repo gates every PR against the latest baseline
to catch retrieval regressions in gbrain itself.

## Privacy posture (gbrain D9)

**These files contain placeholder names only.** No real user queries.
No real people. No real companies. Every slug is a `*-example` form
(`people/alice-example`, `companies/widget-co-example`, etc.) per
gbrain's `CLAUDE.md` privacy rule. The published BrainBench-Real surface
is hermetic by construction; real-user captures stay local in
`~/.gbrain/baselines/` on each user's machine.

## Files

| File | Purpose |
|---|---|
| `v0.41-launch.baseline.ndjson` | First baseline. Generated when v0.41 closed the eval LOOP. |

## File format

NDJSON. First line is a metadata header with `_kind: 'baseline_metadata'`
that carries the label, embedded thresholds, `source_hash`, `row_count`,
and `baseline_mean_latency_ms`. Subsequent lines are raw captured rows
in the `EvalCandidateInput` shape that `gbrain eval export` produces, each
stamped with a stable `query_hash`. `gbrain eval replay` knows to skip
the metadata header.

## Regenerating a baseline

```bash
# From the gbrain-evals repo root, with gbrain checked out as a sibling
# directory (or set GBRAIN_SRC to the gbrain source path):
GBRAIN_SRC=/path/to/gbrain bun scripts/generate-v0.41-launch.ts
```

The generator is deterministic: same input → byte-identical output (uses
a fixed `published_at` timestamp and stable row sort). A baseline only
changes when the underlying corpus or retrieval semantics change.

## Refresh discipline (gbrain D4)

When a ranking change intentionally moves expected slugs, edit the qrels
or regenerate the baseline, then **include a `Why:` line in the commit
body** so future maintainers can audit the trail. Without that
discipline, the gate degrades to rubber-stamp within months.

## Running the gate manually

```bash
# Gate against the baseline only (regression gate):
gbrain eval gate --baseline gbrain-evals/baselines/v0.41-launch.baseline.ndjson

# Gate against both regression + correctness (both must pass):
gbrain eval gate \
  --baseline gbrain-evals/baselines/v0.41-launch.baseline.ndjson \
  --qrels gbrain-evals/qrels/v0.41-launch.qrels.json
```

Exit codes: 0 pass, 1 any breach, 2 usage error.

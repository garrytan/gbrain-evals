"""gbrain-evals wrapper around the pinned public agent-memory benchmark harness.

Modules here register the `gbrain` and `comparator` providers into the harness
registries at runtime, run audited cells (stage receipts, typed scoring,
leakage and delivered-context checks) and never read a `.env` file.
"""

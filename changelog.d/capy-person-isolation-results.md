### Per-person memory isolation results and CI gate

- [docs/benchmarks/2026-11-24-person-isolation.md](docs/benchmarks/2026-11-24-person-isolation.md) reports the
  per-person memory isolation fuzz: at gbrain v0.60.771.0, no person's saved memory reached another person, or a caller
  acting for nobody, in 1,492,098 probes over three seeds, in process, over HTTP and through the CLI, on PGLite and
  Postgres. On v0.60.769.0 the CLI's `--as` preview leaked, and gbrain fixed it in v0.60.771.0.
- `eval/runner/person-isolation-fuzz.ts` and its world generator are new. The registry adds `person-isolation-fuzz` and
  its CI profile `person-isolation-fuzz-ci`, which runs in the offline tier. A new `person-isolation-postgres` CI job
  runs the Postgres cells. CI never uploads person-isolation reports as artifacts.

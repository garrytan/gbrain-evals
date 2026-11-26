- **Three Cat 9 checks and one Cat 24 rule now report what gbrain does, not what an old build did.**

### Fixed

- Cat 9 `bb9-007` accepts `federated` at either place `sources add --json` puts it: top level in classic mode, under `config` in managed mode. Before, a correct classic-mode answer (the Rust engine's) failed. A JSON assertion's `path` can now list alternative paths; the first one present is checked.
- The `health-1` and `pages-01` known-failure labels are gone from the `a1-guard-health-1` and `a1-guard-pages-01` checks. Both bugs are fixed in gbrain v0.60.765.0 and v0.60.767.0, so the labels turned passing checks into `unexpected_pass`, and a later break would have read as expected.
- Cat 24 reports the dedup and re-import probes as `engine_not_supported_by_runner` when the engine refused the content-import save they depend on. Before, they failed with "precondition failed", so a refused setup step read as a gbrain failure.

- **Cat 9 now holds 24 user-workflow scenarios and can check gbrain's answers to them without an AI judge.**

### Added

- A draft Cat 9 scenario catalog in `eval/data/cat9-workflows-v1/`, written from a black-box audit of gbrain 0.60.753.0. It has 24 scenarios across the five Cat 9 workflows and a 37-file fixture corpus in which every person and company is a placeholder.
- Each scenario can carry `setup` steps that build the brain with the gbrain CLI and `checks` that compare CLI output with a fixed expectation. `bun eval/runner/cat9-workflows.ts --checks` runs them on fresh keyword-only PGLite brains, sends no model request and writes a receipt to `eval/reports/cat9-workflows-checks/`. A check that needs a key, a model, an MCP server or an injected fault is reported as not run.
- A check can name the audit finding it failed on at the audited build. The report then shows the failure as an expected failure, and a pass as an unexpected pass so a reader can confirm the fix. The label never turns a failure into a pass.
- Tests in `test/eval/cat9-checks.test.ts` cover the check engine with a stub CLI, the catalog shape, gold-page resolution, wikilinks, a placeholder-name scan with a positive control, and the judged path running over catalog scenarios.

### Fixed

- The Cat 9 registry entry no longer says the category has no scenario catalog. It now names the free-check command and says the judged path still waits for a judge calibration.

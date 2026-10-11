# Workload suite manifests

Each file pins one workload suite (memory proof wave B1 to B4) at its default seed: record counts, approximate token volume, timestamp provenance and the SHA-256 of every generated file. The records themselves are regenerated on demand and are not committed:

```sh
bun run eval:workload-suites   # regenerates all four, checks them and compares with these manifests
```

The entry point fails when a bundle differs from its manifest. Rewrite a manifest with `bun eval/workload-suites/cli.ts <suite> --write-manifest` only in a commit that changes the generator on purpose, and never after seeing results.

See [the suite description](../../../docs/benchmarks/2026-10-05-workload-suites.md).

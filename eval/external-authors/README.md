# Questions from contributors

This directory holds independently submitted question batches. Each contributor uses `<handle>/queries.json`.

A useful question sounds like something a person would actually ask about the fictional world. Its answer labels name the pages that should be found. This adds wording and cases the benchmark's authors might miss.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) and the [submission checklist](../../.github/PULL_REQUEST_TEMPLATE/tier5-queries.md). Validate a batch from the repository root with:

```sh
bun run eval:query:validate eval/external-authors/<handle>/queries.json
```

The existing Tier 5.5 synthetic placeholders are labeled `synthetic-outsider-v1`; that label does not mean a human external contributor wrote them.

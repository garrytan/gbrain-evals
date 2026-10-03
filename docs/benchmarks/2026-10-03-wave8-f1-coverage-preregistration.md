# Preregistration: new checks for gbrain fix wave 8 and Foundations 1 (2026-10-03)

Frozen on October 3, 2026, in its own commit, before the counted runs. Nothing below changes after a counted run; a later change gets a new dated file. The [regression check](2026-10-03-wave8-f1-repin-preregistration.md) has its own preregistration.

## What this adds and why

gbrain fix wave 8 ([#5927](https://github.com/garrytan/gbrain/pull/5927), v0.60.36.0) and Foundations 1 ([#5962](https://github.com/garrytan/gbrain/pull/5962), v0.60.37.0) change behavior that no category here measured. These checks show each change through gbrain's own surfaces (the `gbrain` CLI, its MCP server over stdio or HTTP) wherever that is possible, with no provider key and no paid call. Where a check needs a model or an embedder, a scripted OpenAI-compatible provider on 127.0.0.1 answers (`checks/fake-provider.ts`), reached through gbrain's LiteLLM route (`LITELLM_BASE_URL`). It costs $0 and its replies are fixed.

Each check is a script under [`2026-10-03-wave8-f1-repin/checks/`](2026-10-03-wave8-f1-repin/checks/). It prints one JSON object and exits 0 only when every expectation below holds. `checks/run-all.ts` runs them all against one gbrain and writes one receipt. These are release checks for this re-pin, not registry categories, so no gate changes.

## How the checks were built, stated before the counted runs

The scripts were written and debugged against both pins before this commit: pricing, import, embed and Dream against `109b992`; link typing, pending count, search stall, grants and attribution against both `109b992` and `48ed5e8`. This file freezes the scripts and their expectations. The counted runs are the ones made after this commit, at `109b992` (the pinned dependency) and at `48ed5e8` (a checkout given as `GBRAIN_ROOT`). Two things were learned during development and are stated here so they cannot be presented as results found later:

- The repeated-search stall (item D4) did not reproduce at `48ed5e8` in this setup, so D4 says nothing about the fix; it stays as a guard only.
- N9's relational arm returned fewer candidates at `109b992` in the regression run, and a bisect put the change in fix wave 8. Item D1 was written after that observation to see whether the edges that changed were right or wrong.

## Expectations

Every lettered expectation must hold at `109b992`. The `48ed5e8` run is reported beside it to show what changed; a check that passes there too is reported as not discriminating.

**A. Unpriced model under a cost cap (wave 8 lane H)** (`pricing-flow.ts`). The chat model is `litellm:custom-chat`, which gbrain has no price for. The command is `gbrain extract-conversation-facts --slug <page>`.

- A1. With `--max-cost-usd 0.1 --json`: non-zero exit, `budget_exhausted: true`, no model call, and a `no_pricing` entry with `code`, `model`, `provider: litellm`, `kind: chat`, `units` (USD per 1M input tokens and per 1M output tokens), `lookup`, `register_command` starting `gbrain pricing set litellm:custom-chat --input` and naming `--output`, and `register_scope: local_cli`.
- A2. The same run without `--json`: the text names the model, the units and the registration command, and says that over MCP the agent must ask the brain's operator to run it.
- A3. With no `--max-cost-usd` (the default cap): exit 0, at least one model call, and a warning naming the registration command.
- A4. `gbrain pricing set litellm:custom-chat --input 1 --output 2 --source <url>` exits 0, and the two overrides stored before it (one embedding rate, one chat price) are unchanged afterward.
- A5. The refused call, retried with the same cap, exits 0, calls the model and records `spent_usd` equal to calls times $0.0002 (100 input tokens at $1 per million plus 50 output tokens at $2 per million). A cap of $0.00001 then refuses before any model call with no `no_pricing` entry, so the registered price is what the cap enforces.
- A6. Over MCP stdio (a remote transport in gbrain) no tool name contains "pric", a call to a guessed `pricing_set` tool is refused and changes nothing, and `gbrain pricing set` from a thin client (a config with `remote_mcp`) is refused with a message that says to ask the operator.

**B. Import of a directory the enclosing git repository ignores (Foundations 1, gbrain `c3770114`)** (`import-ignored-dir.ts`). A git repository whose `.gitignore` lists `scratch/`, with three notes in `scratch/` and one tracked note.

- B1. `gbrain import <repo>/scratch` reports 3 pages imported, and `gbrain list` shows all three.
- B2. `gbrain import <repo>` on a fresh brain imports 1 page, the tracked note, and none of the scratch notes.

**C. The embed time-budget stop (Foundations 1)** (`embed-budget-stop.ts`). Twenty notes imported without embeddings into a brain whose embedding model is the scripted provider.

- C1. `GBRAIN_EMBED_TIME_BUDGET_MS=1 gbrain embed --stale` exits 11.
- C2. Its stdout says `stopped (reason: time_budget)`, gives a remaining stale-chunk count above 0 and names `gbrain embed --stale --catch-up`.
- C3. That resume command exits 0 and makes embedding calls.
- C4. The same budget on the drained brain exits 0 without a budget-stop line.

**D. What else wave 8 and Foundations 1 changed, where a check is cheap**

- D1. Markdown link typing (#5882) (`link-typing-5882.ts`), report-only. world-v1 is indexed the way N9 and `relational-ab` index it (import, then `extract links` and `extract timeline`), and every person-to-company `works_at`, `invested_in`, `advises` and `founded` edge is scored against the world's `_facts`: edges, correct, wrong relation between related entities, unrelated, and gold found. No pass rule; the counts at both pins are the result.
- D2. Pending consolidation count (#5831) (`pending-count-5831.ts`). One fact saved with an entity and one without: both are listed by `gbrain recall --pending --json`, and `pending_consolidation_count` is 1 in the CLI and in the MCP `recall` tool with `include_pending`.
- D3. Dream reads imported conversation pages (#4419) (`dream-conversation-pages-4419.ts`). A keyless brain with one imported `type: conversation` page, `gbrain dream --phase synthesize --dry-run --json --dir <notes>`: with an (empty) corpus directory set, the phase's verdicts list `gbrain-page://default/<slug>`; with nothing configured, the phase warns and names `gbrain config set dream.synthesize.conversation_pages true`.
- D4. Repeated searches in one process (wave 8, integrator `9aa88eb31`) (`search-stall-2k.ts`), guard only. 2,000 linked notes, one MCP stdio session, ten `search` calls: every call returns results, and the slowest of calls 6 to 10 is at most the larger of 500 ms and 10 times the median of calls 2 to 5.
- D5. A legacy token with an explicitly empty source list (#5231) (`grants-empty-sources-5231.ts`). Over `gbrain serve --http`, a token with the default grant finds the note with `search`; a token whose stored `permissions.source_id` is `[]` is refused for `search` and for `get_page`.
- D6. Creation attribution (Foundations 1, F1) and `edit_page` (#5616) (`attribution-f1.ts`). A page written with `gbrain put`, then changed over MCP stdio with `edit_page` against the revision from `get_page`: `gbrain attribution <slug> --json` names the creating request, `put_page` and a `local_cli` principal; after the edit, `last` names a different request and principal while `created` is unchanged; the edit lands, and a second edit against the old revision is refused.

## Not covered, and why

- **Postgres pool poisoning (#5730), the pre-v150 backfill (#5216) and `migrate embeddings` index order (#5088).** Each needs a Postgres service. gbrain's own end-to-end suite runs them on Postgres directly and through PgBouncer, and every category here runs on PGLite, so a copy here would add a Docker dependency to retest what gbrain already tests.
- **Windows (#5595, #5475).** No Windows runner here; gbrain's `windows-latest` CI step runs those regressions.
- **The 10,000-page scale results (F4).** gbrain's scale tier measures them on dedicated machines; Cat 7 already measures PGLite read latency at 1,000 and 10,000 pages and is part of the regression check.
- **Pending-write exit 10 (#5232), managed `--pull` cycles (#5255), worktree refresh (F0), seats (F2) and the unified grant columns (F3).** Each needs a managed brain, a concurrent writer or harness state that no fixture here builds cheaply; the value for a public benchmark is low next to the cost.
- **Atom pages leaving the facts backstop (#5831, first half).** It needs connector atom extraction, which calls a model on connector pages; D2 covers the half a keyless brain can show.

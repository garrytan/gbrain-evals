# BrainBench runbook

Operational troubleshooting for the most common failures. One fix per entry.

## Generation failures

### "OPENAI_API_KEY environment variable is missing"

The embedding adapter (`vector`) and any run of `eval/generators/gen.ts`
calls the OpenAI API. You need an API key.

```sh
export OPENAI_API_KEY=sk-proj-...
# or source from a dotenv file
source ~/.zshrc   # if the key is in your shell profile
bun run eval:run
```

### "ANTHROPIC_API_KEY environment variable is missing"

Needed by corpus regeneration (`eval/generators/gen.ts`,
`eval/generators/transcript-distill-gen.ts`) and by the runners that call
Claude: Cat 35, and the `eval:brainbench` sweep that includes it.
Cat 34 does NOT need it. Its runner strips every provider key from the
subprocess env (`STRIPPED_ENV_KEYS`, `eval/runner/cat34-brainbench-memory.ts:65-71`)
so the run is hermetic: no LLM, no network, $0. Retrieval-only runs over
the committed `eval/data/world-v1/` shards don't need it either.

### "Cannot find package 'gbrain'" (or a `gbrain/*` subpath import fails)

The repo depends on `gbrain` via a pinned GitHub URL in `package.json`
(this repo has no `openai` dependency — embeddings go through gbrain's
bundled AI SDK). Fixes, in order:

```sh
bun install                       # fetch gbrain at the pinned SHA
ls -la node_modules/gbrain        # symlink = locally linked, dir = pinned fetch
bun link gbrain                   # only if you WANT a local checkout linked
```

If `node_modules/gbrain` is a stale symlink from an old `bun link`, remove
it and re-run `bun install` to get back to the pinned version.

### `Cannot find module '.../@electric-sql/pglite/dist/pglite.wasm'`

gbrain reaches PGLite's WASM through a nested node_modules path that bun's
hoisting breaks when gbrain is installed from the pinned GitHub SHA. The
`postinstall` script (`scripts/postinstall-pglite-link.ts`) creates the
symlink automatically — if you see this error, re-run `bun install` (or run
the script directly).

### Cat 35 pre-flight refuses to start ("projected worst-case $X exceeds CAT35_HARD_STOP_USD")

Working as designed: the runner computes a deliberately pessimistic worst-case
cost before spending and refuses when it exceeds the cap (default $40). The
published run needed `CAT35_HARD_STOP_USD=50` (projection $45; measured $6.20).
Raise the cap explicitly rather than removing it.

### `bun test` hangs forever on a file that creates real PGLite engines

At gbrain v0.46.3 (the pin at first publication), `PGLiteEngine.disconnect()`
after ops-layer use entered a synchronous WASM spin that froze the bun test
runner (timers could not fire; `--timeout` could not interrupt). Plain `bun`
runs were unaffected. Fixed upstream: at the current pin (v0.47.8.0) the spin
no longer reproduces and the test teardowns are restored (TODOS.md
"Completed"). If this section brought you here on a NEW hang, re-run the
suspect file under `timeout N bun test <file>` to confirm before blaming
teardown.

## Runner failures

### `multi-adapter.ts` times out on vector-grep-rrf-fusion

vector-grep-rrf-fusion embeds all 240 pages per run (via `importFromContent`). At
N=5, that's 5 re-embeddings. Typical wall clock: ~10 minutes.

If you're iterating, use the dev mode:
```sh
BRAINBENCH_N=1 bun run eval:run:dev
```

Or skip embedding-based adapters for focused runs:
```sh
bun run eval:run -- --adapter=gbrain
bun run eval:run -- --adapter=grep-only
```

### "vector-grep-rrf-fusion returned P@5 0.0%"

Likely the adapter is calling `hybridSearch()` on an engine that doesn't
have chunks/embeddings populated. This shouldn't happen with current code
— `importFromContent` populates them. If it does happen:

1. Check the adapter uses `importFromContent(engine, slug, content)`,
   not bare `engine.putPage(...)`. The latter skips chunking.
2. Check `auto_link` is OFF (the adapter sets it, but if someone edits
   the engine's default, verify).

### "grep-only crashes on a query"

The adapter has no query-size ceiling by design. If a specific query crashes,
run it in isolation:

```sh
# Drop other adapters temporarily and bisect the query list.
bun run eval:run -- --adapter=grep-only
```

## Query validation failures

### `validateAll()` fails with "temporal verb detected; as_of_date required"

The query text matches the temporal verb regex. Pick one:

1. **The query is actually temporal.** Add `as_of_date: 'corpus-end' |
   'per-source' | '2024-01-15'` (ISO-8601).
2. **The query isn't really temporal.** Rephrase to avoid the trigger verb.
   "Where is Sarah working?" → "Sarah's current employer" (adjective-form
   doesn't trigger).
3. **Edge case bug in the regex.** File an issue; the regex lives at
   `eval/runner/queries/validator.ts:TEMPORAL_VERBS`.

### `validateAll()` fails with "slug does not match 'dir/slug' format"

Gold slugs must be `dir/slug` — e.g. `people/alice-chen`, not just
`alice-chen` or `people/Alice Chen`. Lowercase, hyphens, no spaces.

### `validateAll()` fails with "duplicate id in batch"

Two queries share an `id`. Renumber. Convention:
- Tier 5 (fuzzy): `q5-NNNN`
- Tier 5.5 (externally-authored): `q55-NNNN`
- Scaffolder default: `q-<timestamp-suffix>` (via `eval:query:new`)

## World.html rendering

### "world.html doesn't open automatically"

`eval:world:view` tries `open` (macOS), `xdg-open` (Linux), `start`
(Windows). If none work:

```sh
bun run eval:world:render              # generate only
# then open manually in your browser
open eval/data/world-v1/world.html    # or xdg-open, start, etc.
```

### "world.html looks weird / broken"

Regenerate from scratch — shard files might have drifted since last render:

```sh
rm eval/data/world-v1/world.html
bun run eval:world:view
```

### "I see unescaped HTML in world.html"

That's a security regression. Open an issue IMMEDIATELY with the specific
entity slug. Every string should route through `escapeHtml()` in
`eval/generators/world-html.ts`.

## Dataset regeneration (advanced)

Don't regenerate unless you know why. The committed corpus is the stable
baseline everyone benchmarks against. Regenerating produces a DIFFERENT
dataset (Opus isn't byte-deterministic), which becomes a new version.

If you need to regenerate (e.g. for a v1.2 dataset):

```sh
# Clean slate
rm -rf eval/data/world-v1
# Regenerate (~$3 Opus cost, 30 min)
bun eval/generators/gen.ts --max 240 --concurrency 6
# Validate
bun run eval:type-accuracy
```

The new dataset should be committed as `eval/data/world-vX.Y/` with a
new ledger. Don't overwrite `world-v1/` — that's the reproducibility baseline.

## CI failures

### `bun run test` fails on a fresh checkout

```sh
bun install                   # fetch deps (gbrain + @anthropic-ai/sdk + ai; postinstall links pglite)
bun run test                  # retry — runs `bun test test/eval/`
```

If tests still fail, bisect:

```sh
bun test eval/runner/queries/validator.test.ts         # pure functions
bun test eval/runner/adapters/grep-only.test.ts     # pure functions
bun test eval/runner/adapters/vector.test.ts      # pure functions (cosine math only)
bun test eval/generators/world-html.test.ts            # HTML rendering + XSS
```

One of these should fail deterministically — report it.

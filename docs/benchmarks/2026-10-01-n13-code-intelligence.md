# Code intelligence readiness scout: six code_* ops on one pinned TypeScript repository (2026-10-01)

**Update, 2026-10-03.** gbrain fix wave 7 (`48ed5e8`) closed gap N13-8: member calls through an untyped receiver no longer resolve to a same-file function. Resolved caller edges went from 76 to 72 of 91, and all 42 compiler-checked same-file calls stay resolved. See the [October 3 rerun](2026-10-03-wave7-repin.md).

**Update, 2026-10-02.** gbrain fix wave 5 fixed N13-1 (`02b0d0f4`), N13-2 and N13-3 (`bf087a04`). At gbrain `d44296c`, `code_def` is right for 49 of 50 top-level functions (was 40), and `resolved` is true on 76 of 91 caller edges (was 0 of 81). The documented limits below still hold. See the [October 2 rerun](2026-10-02-wave-repin.md).

## The finding

All six code-intelligence operations work through gbrain's trusted local path on a small real TypeScript repository. That repository is [unjs/pathe](https://github.com/unjs/pathe) at commit `bc7477a` (MIT): 5 files, about 1,000 lines. The import took 0.6 s, and every op answered the probe symbol in 51 ms or less. All six refuse agent (remote) callers, as the remote suspension at this commit says they should. Four of the six have a named CLI command; `code_blast` and `code_flow` run only through `gbrain call`.

This is a readiness scout, not a quality study. Nothing in it gates, and no broad caller, blast or flow quality number is reported (plan amendment 9). The narrow checks against TypeScript compiler output found three bugs and showed the documented limits clearly:

1. **Short arrow-function definitions disappear from `code_def`.** Of 50 top-level functions, 9 cannot be found. All 9 are `const name = (...) => ...` functions in `src/_glob.ts` that the chunker folds into anonymous "merged" chunks. That breaks gbrain's own rule that a symbol `code_def` can resolve must never lose its name to merging.
2. **The `resolved` flag on caller edges is always false.** It was false on 81 of 81 caller edges, even though the within-file resolver had resolved 53 of them (their `edge_metadata.resolved_chunk_id` is set).
3. **A shared name across languages blocks `code_blast` on a supported language.** When a Python function shares its bare name with a Go function, `code_blast` refuses the Python one as `unsupported_language`.

The documented limits showed up as expected:

- **Lexical references.** `code_refs` is lexical: 130 of the 291 chunks it returned across 50 symbols hold only a substring (for example `join` inside `.join()` calls), while it covered 167 of 171 compiler references.
- **Cross-file resolution.** The resolver never resolves a cross-file call: 0 of 12 were resolved. All 12 appear in `code_callers` only because callers match by bare name, which also matches same-named functions in other files. The repository has two `parse` functions.
- **Language gating.** `code_blast` and `code_flow` refuse Go and accept Python and TypeScript.

Evidence maturity: synthetic production path, on real third-party code with gold from an independent compiler.

## The concrete case

Take `normalizeWindowsPath` in `src/_internal.ts`. The TypeScript checker resolves 9 direct callers: `normalize`, `resolve`, `toNamespacedPath`, `dirname`, `format`, `basename` and `parse` in `src/_path.ts`, and `resolveAlias` and `reverseResolveAlias` in `src/utils.ts`. Every one of them is in another file.

`code_blast normalizeWindowsPath --depth 3` returns exactly those 9 at depth 1. But it finds them by bare name, not by resolving the call. A second `normalizeWindowsPath` in another file would be merged into the same answer. That is the documented within-file resolution limit, and this is the shape of a question it affects.

## The experiment and results

**Corpus.** The pathe snapshot is vendored under `eval/data/n13-code-scout/` with its license and a per-file SHA-256 manifest:

- The runner refuses to run if any file differs from the manifest, and the error names the file and both hashes.
- `bun eval/generators/n13-code-scout-vendor.ts --check` re-downloads the files from GitHub at the pinned commit; all 6 files, including the license, matched.
- Files are stored with a `.txt` suffix so this repository's TypeScript build never compiles them.

The plan's caps hold: under 50 MB and under 20k symbols.

**Gold.** `eval/data/n13-code-scout/ts-gold.json` comes from the pinned TypeScript compiler (5.9.3) through `eval/generators/n13-ts-gold.ts`. It records:

- 50 top-level functions, with their spans;
- their language-service references;
- 60 checker-resolved calls, 12 of them cross-file.

A test rebuilds it and requires byte-identical output.

**Path.** The scout uses `importCodeFile` for each file (the path `gbrain sync` and `reindex-code` use), then the `resolve_symbol_edges` cycle phase. Every op goes through `handleToolCall`, the `gbrain call` path, with `remote: false` and validated parameters. The remote check calls each op handler with `remote: true`. Everything runs on in-memory PGLite, keyless, with System One off by construction.

**Import.** 5 code pages and 73 chunks, 59 of them with a symbol name. 251 symbol edges; 0 rows in `code_edges_chunk`. The resolver walked 73 chunks: 81 edges resolved, 170 unmatched, 0 ambiguous. Import took 593 ms and the resolver 24 ms.

**Readiness per op** (probe symbol in parentheses):

| Op | Trusted local call | Answers | Latency | Remote caller | CLI command |
|---|---|---|---|---|---|
| `code_def` (normalize) | ok, ready | 1 | 19 ms | refused (`permission_denied`) | `code-def` |
| `code_refs` (normalize) | ok, ready | 17 | 5 ms | refused | `code-refs` |
| `code_callers` (normalizeWindowsPath) | ok, ready | 9 | 9 ms | refused | `code-callers` |
| `code_callees` (resolve) | ok, ready | 6 | 7 ms | refused | `code-callees` |
| `code_blast` (normalizeWindowsPath, depth 3) | ok, ready | 3 depth groups | 51 ms | refused | none |
| `code_flow` (entry point resolve, depth 4) | ok, ready | 2 depth groups | 36 ms | refused | none |

**Narrow checks against the compiler gold.** Each is an illustration with a named denominator, not a quality metric:

| Check | Result |
|---|---|
| `code_def` top-1 file and line right (50 top-level functions) | 40 / 50; 41 / 50 with any rank. The 9 misses return nothing (merged chunks, N13-1). The tenth is `parse`, which has two definitions: both are returned, and the one in `src/_glob.ts` ranks first |
| `code_refs` returned chunks holding a real reference (291 chunks over 50 symbols) | 115 hold a compiler reference, 46 hold only the definition, and 130 hold only a substring |
| `code_refs` compiler references covered (171) | 167 |
| `code_callers` checker-resolved same-file calls present (42 distinct caller-callee pairs) | 39. The 3 misses have a caller inside a merged chunk |
| `code_callers` checker-resolved cross-file calls present (12) | 12, all by bare name; 0 resolved |
| caller edges with `resolved: true` (81) | 0. 53 carry `edge_metadata.resolved_chunk_id` |
| caller edges with no checker-resolved call behind them (81) | 30. 24 are real calls made from module-level constants (the grammar tables in `src/_glob.ts`, and `win32` and `posix` in `src/index.ts`), which the gold does not attribute to a caller function. 6 are member calls matched to a same-named function: `segments.join()` to pathe's `join` (5) and `process.cwd()` to pathe's `cwd` (1). The resolver marks 4 of these 6 as resolved (N13-8) |
| `code_blast normalizeWindowsPath` depth-1 nodes vs checker direct callers | 9 of 9, identical sets |
| `code_blast` language gate | Go: `unsupported_language`. Python: ok. TypeScript: ok. A Python function sharing a name with a Go one: `unsupported_language` (N13-3) |

**Scorer validation.** The narrow checks reject the mutation kit's fakes (`test/eval/n13-code-intelligence.test.ts`): empty, always-positive, always-refuse and wrong-source all fail. The stale fake is declared not applicable, because code at one pinned commit has no time axis.

**Run time.** 6.3 s.

## gbrain bugs found

### N13-1. Short arrow-function definitions are merged away from `code_def`

- **Contract.** The header of `src/core/chunkers/def-types.ts` (#4511) says "a symbol type code-def can resolve must never have its `symbol_name` erased by small-sibling merging". `code_def` resolves `lexical declaration`.
- **Actual.** `MERGEABLE_RUN_TYPES` keeps `lexical declaration` mergeable so that const runs collapse. A short `const fn = (...) => {...}` is a lexical declaration, so `mergeSmallSiblings` folds it into a nameless chunk together with its neighbours, even a 13-line function (`_pushToLeaves`).
- **Fix direction.** Protect lexical declarations whose initializer is a function or class expression, and keep merging plain value consts.
- **Repro.** `bun docs/benchmarks/2026-10-01-n13-code-intelligence/repros/n13-1-merged-arrow-defs.ts` (exits 1 while the bug reproduces).

### N13-2. `resolved` is false on resolved caller edges

- **Contract.** `CODE_CALLERS_DESCRIPTION` documents a `resolved` flag per caller and shows `resolved: true`.
- **Actual.** `getCallersOf` and `getCalleesOf` (`src/core/engine-sql/code-edges.ts`) set `resolved` from the table a row comes from. The extractor never writes `code_edges_chunk`, and the within-file resolver records its result in `edge_metadata.resolved_chunk_id` on `code_edges_symbol`, so the flag is always false.
- **Fix direction.** Derive `resolved` from `resolved_chunk_id`, or have the resolver promote rows.
- **Repro.** `bun docs/benchmarks/2026-10-01-n13-code-intelligence/repros/n13-2-resolved-flag.ts`.

### N13-3. A shared bare name across languages blocks `code_blast` on Python

- **Contract.** `code_blast` and `code_flow` support Python (`SUPPORTED_LANGS` in `src/core/code-intel/recursive-walk.ts`).
- **Actual.** `runRecursiveWalk` disambiguates the bare name to one qualified name, `shared_helper`, which both files produce. `detectSymbolLanguage` then takes the first chunk's language (Go) and refuses.
- **Fix direction.** Gate on the languages of all matching definitions, or report the name as ambiguous.
- **Repro.** `bun docs/benchmarks/2026-10-01-n13-code-intelligence/repros/n13-3-shared-name-language-gate.ts`.

## Documented limits (not bugs)

Each is in the bug ledger as a feature gap:

- **N13-4.** `code_refs` is a substring match; lexical references are not semantic references.
- **N13-5.** The resolver works within one file only; cross-file calls stay unresolved and match by bare name.
- **N13-6.** Remote code reads are suspended for stdio and HTTP callers.
- **N13-7.** `code_blast` and `code_flow` have no named CLI command.
- **N13-8.** A method call on a receiver the extractor cannot type is emitted as a bare token. The within-file resolver then resolves it to any same-named top-level function in the file. For example, `segments.join("/")` inside `dirname` becomes a resolved call to pathe's own `join`, and `process.cwd()` inside `cwd` becomes a self-call. This happened on 4 of the 53 resolved edges. It follows from the documented bare-token emission, but it adds false edges to blast-radius answers.

Also documented: blast and flow cover TypeScript, TSX, JavaScript and Python only.

## Deferred, and why

There is no broad quality metric for callers, callees, blast radius or flow. The compiler gold here covers one small repository and top-level functions only. A quality study needs independent call and flow gold, such as SCIP indexes or equivalent built with pinned indexer versions and committed with hashes, over at least one TypeScript and one Python repository, stratified by fan-in. Until that exists, the numbers above are readiness evidence only.

No paid arm ran. Spend was $0.

## Reproduce and inspect

```bash
bun install
bun eval/runner/n13-code-intelligence.ts                                    # pinned gbrain, keyless
bun eval/runner/n13-code-intelligence.ts --gbrain <gbrain checkout>@3a284ae # copied overlay, as published
bun eval/generators/n13-ts-gold.ts                                          # rebuild the compiler gold (prints its hash)
bun eval/generators/n13-code-scout-vendor.ts --check                        # re-download and hash-check the corpus (network)
```

Receipt: [receipt-pin-3a284ae.json](2026-10-01-n13-code-intelligence/receipt-pin-3a284ae.json). It was taken through the copied overlay of gbrain `3a284ae`, on a clean gbrain-evals tree at `93143f2`. The findings are in the [wave bug ledger](2026-10-01-wave-bugs.md).

# Preregistration: does gbrain's Rust storage engine work like PGLite and Postgres? (engine-bench, phase 1)

Written 2026-11-17. This file freezes in its own commit, pushed before the first counted run. After that, every change is a dated amendment at the end. The PGLite and Postgres runs made before this commit are development runs: they are published as a baseline and decide nothing.

## Question

gbrain stores a brain in PGLite (Postgres compiled to WebAssembly, inside the gbrain process) or in a Postgres server with pgvector. gbrain is adding a third storage engine written in Rust, loaded in process as a native addon (gbrain [docs/designs/RUST_ENGINE.md](https://github.com/garrytan/gbrain/blob/master/docs/designs/RUST_ENGINE.md)). gbrain's plan is to ship it in master switched off, selected with `engine: "rust"`. At the engine-facts read of 2026-11-17 (below) neither is true yet: gbrain's `engine-construct.ts` has no rust case (due 2026-11-21, by the maintainers' date), and the engine is in master only after gbrain#9631 merges.

Phase 1 answers one decision: **at a named Rust build, does the Rust engine work like PGLite and Postgres, so that it can be switched on, first for Garry Tan's own brain?** Work means the same correctness counts, the same output bytes on every surface a user or agent reads, and the same retrieval answers. Phase 1 measures no speed. Speed decides a later question, whether Rust becomes gbrain's default, and is phase 2 below.

Out of scope: speed in phase 1, a 10x claim, recall at 200k or 1M chunks, 64 clients, cost per query, and gbrain's own parity suite, which this does not replace.

### Why the decision changed

Earlier drafts gated a December 1 opt-in release on correctness and speed together, with a fixed run date. Garry Tan changed that on 2026-11-17, in two messages:

> "Ah I think we can ship the rust engine in master just default off."

> "We don't need perf bars for whether it is in the repo. We use perf as the indicator for us to turn it default on but that will be much later. It just has to work first."

So phase 1 decides whether Rust works and can be switched on; it has no deadline, and phase 2 (speed) waits until default-on is on the table.

## Public lesson

- Works: "We learned that gbrain's Rust engine gives the same correctness counts, the same CLI, MCP and markdown bytes, and the same LongMemEval-S retrieval as PGLite and Postgres at <build>. You can switch a brain written from one machine to it; whether it is faster is a separate, later measurement."
- Works with named gaps: the same, plus "except <check or operation>, which <the build does not serve | we could not measure on Rust> because <reason>. Avoid Rust if you rely on it."
- Doesn't work yet: "We learned that gbrain's Rust engine at <build> is not yet a drop-in replacement: <check> differs by <amount>. Stay on PGLite or Postgres until <named fix>." A loss is reported as plainly as a win.

## Evidence class

A confirmatory gate on synthetic, public, keyless fixtures plus one public retrieval set (LongMemEval-S). Nothing here is sealed, and gbrain's maintainers can read every fixture.

## Build and data

- **Rust build.** The counted Rust wave runs when gbrain's maintainers (Ember, at Vorflux) send a `garrytan/gbrain` commit plus the Rust addon's digest for a build that serves gbrain's own import and search paths on Rust and passes gbrain's parity suite. No build qualifies at the engine-facts read; the earliest, by Ember's date, is about 2026-11-26 PST. A dated amendment records the commit, release if any, date, addon digest and target (`linux-x64-glibc` on the benchmark VMs) before the first counted run. The receipt records the addon's exports `engineBuild`, `engineAbi`, `catalogVersion` and `formatVersions`, and the store's one `format_version`. `engineBuild` hashes the Rust sources, not the addon file, so the addon file's digest is recorded as well. The harness creates a Rust brain the way a user does, with `gbrain init --migrate-only` on a rust config, because the Rust engine refuses `initSchema()`. There is no deadline: if a build is late, the wave waits for it.
- **PGLite and Postgres.** The same gbrain commit as the Rust build, so all three engines run the same TypeScript code above the engine. They run again in the counted wave beside Rust; those runs, not the baseline, are what Rust is compared with. If that commit is not gbrain's newest release at launch, the amendment says why (the Rust build is the question).
- **Postgres.** Docker image `pgvector/pgvector:pg16`, stock settings, on the same machine. The receipt records the image digest.
- **Harness.** The gbrain-evals commit that carries the build amendment, loaded with `--gbrain <checkout>@<ref>` (a verified copy, never a symlink). Every receipt records the loaded commit and this file's attestation.
- **Fixtures.** Correctness: the gate runners' own seeded fixtures. Surfaces: a fixed 65-page corpus from `world-v1` plus edge cases (non-ASCII text, a long page, frontmatter, links, timeline lines) and a fixed 54-step script. Answers: LongMemEval-S ([dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval)), 500 questions, and an embedding cache for gbrain's default embedding model (`voyage-4` at 1,024 dimensions) filled once on 2026-11-17 through gbrain's own embed call. The amendment records the dataset and cache sha256 values.

## Arms

PGLite, Postgres and Rust. Rust is compared with each TypeScript engine. PGLite against Postgres is reported as context; a difference between them is a gbrain finding and decides nothing about Rust except where a rule below says so. No model is under test, and no provider is called during a counted run: correctness and surfaces are keyless, and the answers stage reads only the cache (a cache miss fails the run).

## Stage 1: correctness

`eval/runner/engine-bench/correctness.ts` runs gbrain-evals' keyless correctness checks once per engine with `GBRAIN_EVAL_ENGINE=pglite|postgres|rust`: N1 knowledge updates, N5 forget, N6 privacy in process, N6 over the real HTTP transport, N12 chat formats and N14 large pages (2 MB tier). Each check's contract counts are listed in the runner (stale values served, leaks, lost writes, residue after forget, bytes lost and so on); every contract's bar is zero.

- A check **passes on Rust** when its verdict is pass and every contract count equals the count on both TypeScript engines. If a TypeScript engine fails a contract, or the two disagree, that is a gbrain finding, and Rust must be no worse than the better TypeScript engine on it.
- A check **fails on Rust** when its verdict is fail, a count is worse than that, or the runner errors on Rust (no usable receipt) where a TypeScript engine completed it.
- A step that reads or writes the database with raw SQL is `not_applicable` on Rust, because the Rust engine refuses raw SQL by design (gbrain plan decision D18). It counts as neither pass nor fail. A check whose every contract is not_applicable on Rust is unmeasured.
- A step that needs a second gbrain process on a brain another process holds is not_applicable on Rust with reason `store_locked`, unless the named build serves it. At the engine-facts read a second process gets `store_locked`; once rust-owner-ipc is wired into core (after gbrain#9631), gbrain's own client becomes a client of the owning process and these steps run.
- A runner the engine refuses as a whole (exit 69) is `refused`, with its reason.
- N6 over HTTP is a named gap on Rust in phase 1: it runs on Postgres only, and per the engine-facts read `gbrain serve --http` on Rust needs a persistence journal and OAuth and access operations that have no date yet. So the best phase 1 verdict reachable is "works with named gaps", and the report says so.

## Stage 2: output bytes (CLI JSON, MCP, markdown)

`eval/runner/engine-bench/surface-parity.ts` imports the fixed corpus into each engine, then runs the fixed script through `gbrain --json` and `gbrain call`, through stdio MCP, and through gbrain's markdown export. Outputs are compared byte for byte.

- Normalization is limited to values that differ on every run (timestamps, durations, search stage timings, temporary paths, random ids). Each rule is listed in the receipt with its replacement count per engine and surface.
- A Rust output passes when it equals both TypeScript engines' bytes. Where PGLite and Postgres already differ at the named build, the difference is listed, and Rust must equal one of them. At v0.60.734.0 the only such difference is the `stale` field of `gbrain search --json`: PGLite computes it (true only when a timeline entry is newer than the page) and Postgres always returns false. If gbrain's maintainers name which engine Rust must match, an amendment records it before the counted run, and Rust must then equal that engine.
- Every other difference, including ordering or float formatting, is a failure.
- An operation that only Rust refuses with gbrain's `engine_capability_missing` is `refused` in the receipt: a named gap, or a failure when it is a core path. Any other Rust error on an operation both TypeScript engines answered is a failure.
- Known at the engine-facts read: the script uses operations that need `health`, `tags`, `pages` and graph members on Rust, and these are expected to be refused and listed as gaps. The MCP onboarding probe does not refuse, but its `get_health` bytes are expected to differ from PGLite's; under the rule above, a differing output is a failure, not a gap.
- A step that runs while another gbrain process holds the brain is not_applicable on Rust with reason `store_locked`, as in stage 1, unless the named build serves it. Steps whose processes run one after another still run.

## Stage 3: same answers (LongMemEval-S)

`eval/runner/engine-bench/lme-recall.ts`. 500 questions, abstention questions excluded as the official protocol does. Per question, a fresh store per engine, the haystack imported through gbrain's import path, top 5 from gbrain's search with the reranker, query expansion and autocut off. Arms: keyword (keyless), vector and hybrid (vectors from the cache). The run may be split across VMs with `--worker-id/--total-workers` and resumed from its NDJSON rows; the amendment names the worker count.

- Metric: recall_all@5, the share of questions with every answer session in the top 5.
- Rule: Rust passes an arm when the 95% paired bootstrap interval (10,000 draws) of Rust minus each TypeScript engine has a lower bound of at least -0.02 (two points). Otherwise the arm fails. An arm also fails when Rust errors on any non-abstention question that both TypeScript engines answered, unless the invalid-run rule under Stop rules covers that error, and the interval covers every non-abstention question. A better Rust result is not a failure, because a better index can return different sessions.
- The report also lists the share of questions whose top 5 is identical across engines, and every question where it is not.

## Decision rule

The core paths are page import, `get_page`, `put_page`, and keyword, vector and hybrid search. A gap is anything phase 1 could not measure on Rust: a check or step that is refused, not_applicable or unmeasured, or an operation outside the core paths that the build refuses with `engine_capability_missing`.

| Verdict | Rule |
|---|---|
| **Works** | Every correctness check passes, every surface output passes, every answers arm passes, and there are no gaps. |
| **Works with named gaps** | No check, output or arm fails, and no core path is refused, but at least one gap exists. Each gap is named with its reason. |
| **Doesn't work yet** | Any correctness failure, any surface output that fails, any answers arm that fails, or a core path the build refuses (including a refused import, which leaves nothing to measure). |

Nothing is pooled: one failure anywhere decides. A gap never counts as a pass.

## What each outcome changes

| Outcome | What happens |
|---|---|
| **Works** | Rust can be switched on for Garry Tan's own brain, a brain written from one machine. It stays off by default; default-on waits for phase 2. The report is what gbrain's docs cite. |
| **Works with named gaps** | Rust can be switched on for that brain if none of the gaps is a path it uses; the report lists each gap beside the switch, and each goes to gbrain's maintainers as an issue. |
| **Doesn't work yet** | Rust stays off. The report lists every failing check, output and arm with its repro command, and each goes to gbrain's maintainers. The next build they name is measured in a new wave. |

**The PGLite and Postgres baseline publishes on its own,** whatever happens to the Rust arm. It contains the development runs made before this file: correctness at gbrain v0.60.735.0 (every check passed on both engines with identical counts, N6 over HTTP on Postgres only), output bytes at v0.60.734.0 (301 of 302 outputs identical; the one difference is `stale`), LongMemEval-S dry runs, and the speed dry run at 10,000 pages at v0.60.734.0. Between those two releases only the version line of gbrain's `package.json` changed. They are labeled development runs and decide nothing.

## Machines

Ubicloud `standard-16` VMs in one location, with no provider key in the run's environment. Correctness and output bytes run on one VM, each engine in sequence; the answers stage runs on that VM or across several, each worker on its own. Every counted stage refuses to start at a load average above 2 and without this file's attestation. The receipt records CPU model, memory, Bun and Docker versions.

## Stop rules

- One counted wave per named build: all three stages, all three engines, on the same gbrain commit. Each wave's verdict belongs to its build. A later build gets its own wave, through a dated amendment naming it, and earlier verdicts stay in the report beside it. Waves are never pooled.
- A run is invalid, and may be repeated at most twice, only for: a different dataset or cache fingerprint, a VM or container failure, a load average above 2 at launch, a receipt without this file's attestation, or a Rust error the report traces to the harness or the machine, with the evidence. An invalid run's receipt is kept and named with its reason. No run is repeated because of its result.
- There is no deadline. If the named build is late, the wave waits.

## Engine-facts read

An input to this file, about how the Rust engine behaves, not about what counts as working. Ember (Vorflux, gbrain's Rust engine maintainers) read this preregistration and the harness on 2026-11-17, at about 16:03 UTC, against these heads: this file at 10e8ec383f, the harness at e75b3d5ae5, gbrain `rust-engine/core` at d33703bca3, `rust-store-graph` at d6c740a169 and `rust-owner-ipc` at abf9ede6ac. What it changed here:

- The trigger and earliest date under Build and data, and the `format_version` and export names there.
- `engine-construct.ts` has no rust case yet, and the engine reaches master only after gbrain#9631 (Question).
- A second process gets `store_locked` today, and rust-owner-ipc will end that once wired; N6 over HTTP on Rust stays a named gap (stage 1).
- Expected surface gaps (`health`, `tags`, `pages`, graph members) and the `get_health` difference (stage 2).
- Graph walks, backlinks and timeline reads exist on the `rust-store-graph` branch and match PGLite there, but are not wired into core yet; vector search is not in the Rust store yet.
- Raw SQL on gbrain's own paths (question 1): `hybrid.ts`, `alias-resolved.ts` and `import-file.ts` refuse with `raw_sql` today. hybridSearch is due 2026-11-24 and import about 2026-11-25, by the maintainers' dates. A core path the named build still refuses makes the verdict "doesn't work yet".
- The harness now classifies `rust_engine_addon_missing` and `rust_engine_addon_mismatch` as refusals (never a pass) and creates Rust brains through `gbrain init`.

A gap still never counts as a pass. Dated answers to the questions below are due 2026-11-20 and go into an amendment.

The questions as sent:

1. **Raw SQL on gbrain's own paths.** At v0.60.734.0, gbrain's import path (`importFromContent`, including `sealPageTextProjection`), `hybridSearch` (its supersede probe) and the MCP onboarding-count probe call `executeRaw`. engine-bench writes and searches only through those gbrain paths. Will the named build serve them on Rust, or refuse with `engine_capability_missing`?
2. **Selecting Rust.** Is it `EngineConfig { engine: "rust", database_path }` through `constructEngine`, with the addon at `GBRAIN_RUST_ENGINE_ADDON` or installed by `gbrain engine install rust`? Does `gbrain init` (or `init --migrate-only`) accept a Rust config?
3. **Several processes on one Rust brain.** Does the named build's owner process serve `gbrain serve` clients while other gbrain processes read the same brain?
4. **Concurrency** (phase 2). Is `BrainEngine` on Rust safe for 16 concurrent callers in one process, and is `traverseGraph` implemented?
5. **Known PGLite and Postgres difference.** Which `stale` value does Rust return in `gbrain search --json`?

## Budget

Counted runs call no provider. The one paid step, filling the embedding cache, finished on 2026-11-17 before this file.

## Phase 2: speed, for default-on (not yet run)

Phase 2 decides whether Rust becomes gbrain's default. It has not run on Rust and will not until default-on is on the table; a dated amendment then names the build and scales, and sets the 100,000-page design from the import probes made on 2026-11-17. Its runner, `eval/runner/engine-bench/perf.ts`, imports a seeded synthetic corpus through gbrain's import path with a seeded local embedder, and times `get_page`, `put_page`, keyword, vector and hybrid search, filtered search, graph walks, backlinks, timeline, `list_pages`, throughput at 1, 4 and 16 clients, cold start, import rate and memory, pairing each query across engines. Core operations get 10,000 timed queries and others 2,000.

The runner reads its margins from this block:

```json engine-bench-margins
{"latency_ratio": 1.10, "throughput_ratio": 0.90, "point_ratio": 1.10, "exception_ratio": 1.5, "bootstrap_draws": 10000, "quantile_draws": 2000}
```

Rust is no slower when every metric's 95% interval clears the margin against both TypeScript engines (latency ratio upper bound at most 1.10, throughput ratio lower bound at least 0.90). Core operations (`get_page`, `put_page`, keyword, vector and hybrid search) are never exceptions; another metric within 1.5x is a named exception. The verdicts are `no_slower`, `no_slower_with_exceptions`, `not_shown` and `slower`, as `speedVerdict` in `perf.ts` applies them. These margins are product assumptions written before any Rust number exists, not findings.

## Amendments

### 2026-11-17: the keyword arm searches as a keyless brain does, and two Stage 3 sentences read as the runner applies them

Committed before any counted run. Nothing here changes a margin, a rule or a verdict.

1. **Keyword arm.** "Arms: keyword (keyless)" means gbrain's own search on a brain with no embedding provider: `hybridSearch` with embeddings opted out and the any-word fill that gbrain's search operation asks for, so a question whose words do not all appear in one passage still gets the passages that hold some of them. Until this amendment the runner called the engine's own keyword search, which needs every word in one passage. In the development run published with the baseline it returned nothing on 82 of 102 questions on both TypeScript engines, so that arm's identical top 5 mostly compared empty lists. The runner now goes through `hybridSearch`, and the report gives, beside the identical-top-5 share, the number of questions where every engine returned nothing. The keyword arm's development numbers from the first run are kept in the baseline report, marked as superseded.
2. **Stage 3 errors, as the runner applies them.** The runner compares Rust with each TypeScript engine in turn, so an arm fails as soon as Rust errors on a non-abstention question that the TypeScript engine in that pair answered. That is stricter than "both TypeScript engines answered", and it fails closed.
3. **Stage 3 interval, as the runner applies it.** A question that a TypeScript engine errored on is left out of that pair's interval and listed in the report. A Rust error is scored 0 inside the interval. So "the interval covers every non-abstention question" means every non-abstention question both engines in the pair could be scored on.

### 2026-11-20: the maintainers' dated answers, how runs load the Rust addon, and N14 on Rust fails when nothing was stored

Committed before any counted run. Items 1 to 4 record answers, items 5 to 7 change what the harness does, and item 8 records a scope decision. The build itself (commit, release, addon digest) is still named by a later amendment, as Build and data says.

1. **When.** Ember (Vorflux) answered the five engine-facts questions on 2026-11-20. These are the maintainers' dates, not ours. Hybrid search on Rust about 2026-11-24; import (including `sealPageTextProjection`), both hybrid supersede probes and the onboarding counts by 2026-11-25; keyword ranking and the Rust arm of gbrain's parity suite on 2026-11-26. All of it is in rust-engine/main, then on master behind the opt-in engine setting by the 2026-11-25 last landing, in the 2026-11-26 PST gbrain release. That release is the earliest build the trigger under Build and data can name.
2. **Selecting Rust.** A user writes `engine: "rust"` and an absolute `database_path` into `.gbrain/config.json`, then runs `gbrain init`. There is no `--rust` flag, and the default stays PGLite (gbrain's CLI change from rust-engine/cli-connect, due about 2026-11-21). The harness keeps creating Rust brains with `gbrain init --migrate-only` on that config, because it brings the schema up without writing onboarding settings into the config. The keyless dry run before launch also runs the plain `gbrain init` once on the named build. If it leaves the config on any engine but Rust, that is a named gap. On 2026-11-20 at rust-engine/cli-connect 936fba2b it rewrote the config to PGLite.
3. **Several processes.** With gbrain#9823 (owner IPC), a second CLI process on a Rust brain goes through the process that owns it and does not get `store_locked`. The `store_locked` rule in stages 1 and 2 applies only if the named build lacks it.
4. **`stale`.** Where PGLite and Postgres differ, Rust follows PGLite, and Postgres gets a fix to match. So in stage 2, Rust must equal PGLite's `stale` field in `gbrain search --json`. A Postgres difference on `stale` stays a gbrain finding.
5. **Loading the addon.** A locally built addon is found only through `GBRAIN_RUST_ENGINE_ADDON`, and each run's brains live in throwaway homes with no installed addon. Before this amendment, the gbrain processes that the stage 1 lifecycle cells and stage 2 start did not receive that variable, so Rust would have refused there for want of an addon. Every gbrain child now receives that one variable, and no provider key. Each stage receipt records the addon file's SHA-256 and the exports gbrain's loader reads (`target`, `engineBuild`, `engineAbi`, `catalogVersion`, `formatVersions`) as `gbrain.rust_addon`.
6. **N14 on Rust.** On Rust, N14's quality and floor rules and its stored-page counts are `not_applicable`, so only its four safety counts were left, and an arm whose page was never stored scored zero on all four. In the 2026-11-20 dry run at rust-engine/cli-connect, every arm's write was refused with `engine_capability_missing`, and N14 passed. On Rust, an arm that ran without storing its page now fails the check (`roundtrip.not_stored`). A gap still never counts as a pass. PGLite and Postgres are unchanged.
7. **Remote callers on Rust.** GBEV-3 decided this on 2026-11-20, before any counted cell. Until access parity lands, a Rust brain refuses remote callers (stdio and HTTP MCP) with `engine_capability_missing`, reason `access_control`. Access parity is rust-engine/remote-access-parity, due about 2026-11-25 by the maintainers' date and not pushed on 2026-11-20. If the named build still refuses them, the parts below are `not_applicable` with that reason: a named gap, never a pass or a fail.
   - **Stage 1.** An N1 or N5 stdio-MCP or HTTP-MCP cell that does not finish because of that refusal is `not_applicable` in the runner's receipt, and the cell leaves the gate. It counts as a gap only when every remote call it made was refused with `access_control`, or, when it made no remote call, when its own failure is that refusal. The CLI cell still gates. N6 over HTTP is a gap already.
   - **Stage 2.** The MCP outputs the build refuses that way are `refused`. That includes the `get_health` onboarding probe and the markdown reads through MCP `get_page`.
   - **Stage 3** runs in process and has no remote caller.
   - **Other failures.** A remote cell that fails for any other reason is judged by the rules above.
   - **N6 in process** also calls gbrain's dispatch as remote callers. This rule does not yet cover those calls. If the named build refuses them, the dry run on that build shows it, and that comes to GBEV-3 before the counted wave.
   - **Results page.** If this gap exists, the results page names it in its headline result ("the Rust build doesn't serve remote callers yet"), not in a footnote.
8. **cat13-by-engine** (gbrain-evals#518) is not an arm here. Its gbrain arm embeds live through a provider, which a counted run here never calls. With stub embeddings its vector arm measures nothing, and no preregistered rule compares nDCG@5 across engines. The report cites #518 as context only.

### 2026-11-20: stage 3 passes Rust only when it is equal or better, as gbrain's design plan requires

Committed before any counted Rust arm. This changes stage 3's rule for Rust; the rest of the file stands.

gbrain's design plan for the Rust engine (`docs/designs/RUST_ENGINE.md` at gbrain commit 0ffa58d, lines 73 and 473) lets ranked search return different results only when they are "equal or better on the gbrain-evals retrieval metrics", and says its retrieval gates are "equal or better", not "within N points". Stage 3 is the LongMemEval-S part of that plan's gate E1. The rule under Stage 3 let Rust pass while up to 2 points worse. GBEV-3 decided on 2026-11-20 that the gate for turning Rust on by default follows the design plan, with the exact rule below as ruled by the plan's owner (GBRA-108). The plan's gate E2 (BrainBench) is not an arm of this experiment.

1. **The gate.** For each arm and each TypeScript engine, Rust passes when both hold: the paired point estimate of recall_all@5, Rust minus that engine, is at least 0; and the lower bound of its 95% paired bootstrap interval (10,000 draws, as before) is at least -δ, with δ = 0.018. A question where Rust's top 5 holds the same session ids as that engine's, in any order, is an exact tie with a difference of 0. An arm where every scored question is an exact tie passes. The error rule is unchanged: a Rust error on a non-abstention question that engine answered fails the arm.
2. **δ, the smallest detectable difference at the planned N.** For a paired difference of 0-or-1 scores, a two-sided 0.05 test with 80% power detects about (1.960 + 0.842) × √(p / N), where N is the number of scored questions and p the share of them where Rust and the other engine score differently (the discordance). LongMemEval-S has 500 questions, 30 of them abstention, so N = 470. The planning discordance is 2% (about 9 questions): PGLite and Postgres scored differently on none of 96 questions in any arm in the development run, and the design plan requires the Rust keyword arm's compatibility ranker to reproduce PGLite's order exactly and its vector arm to reach recall@10 of at least 0.98 against an exact scan. That gives 2.802 × √(0.02 / 470) = 0.0183, rounded down to 0.018, which makes the gate stricter. δ is below 0.02, so N stays at 470 and nothing costs more. At other discordances δ would be:

   | Discordance | δ at N = 470 | N that keeps δ at 0.02 or less |
   |---|---|---|
   | 1% | 0.013 | 197 |
   | 2% (planned) | 0.018 | 393 |
   | 5% | 0.029 | 982 |
   | 10% | 0.041 | 1,963 |

   LongMemEval-S holds only 470 scored questions, so a higher planning discordance could not be met by raising N inside this dataset.
3. **What a fail means.** A truly equal engine whose top 5 differs on some questions passes about half the time, because its wins and losses are equally likely to come out ahead; a little more than half when only a few questions differ, because an exact tie of wins and losses passes. While the observed discordance stays at or below about 4%, where 1.96 standard errors equal δ, the interval clause never fails an arm that the point estimate passes; above that it can fail even an engine ahead on its point estimate. An engine whose top 5 matches on every question always passes. A truly worse engine fails at least 80% of the time when it is 0.0055 or more behind (0.84 standard errors at the planning discordance). So a fail shows the run could not show Rust equal or better; on its own it does not show Rust worse, and the report says so.
4. **Two secondary rows, reported beside the gate and labelled as not the gate.** Both fail on a Rust error, and an arm where every question ties passes both. At the planning discordance:
   - **Lower bound at least 0.** Passes a truly better engine 80% of the time when it is 0.018 or more ahead, and a truly equal engine that differs on some questions about 2.5% of the time.
   - **Non-inferiority at -0.02** (the rule this amendment replaces). Fails a truly worse engine 80% of the time when it is 0.0127 or more behind, and passes a truly equal engine about 87% of the time.
5. **Receipt.** Each Rust comparison records `rust_verdict` (the gate), `rust_secondary` (`lower_bound_at_least_0` and `non_inferiority_minus_0_02`) and `exact_ties`. The receipt schema is `engine-bench.lme-recall/3`.
6. **If the design plan's reading changes** before the first counted Rust arm, this rule changes with it, in a new dated amendment.

# Predictive measures: the agent stack

These runners measure how an agent does on gbrain's agent-facing surfaces, at the gbrain version `package.json` pins (0.60.557.0). Each unit builds a fresh synthetic brain per episode from fictional data, runs the real gbrain CLI or MCP server of the gbrain under test, and scores the agent's final answer with a keyed scorer. No judge model is involved. They are part of GBEV-55.

| Unit | Question | Surfaces | Counted size |
|---|---|---|---|
| `g1` | Does the agent answer from the current fact, or a stale one it read earlier (freshness)? | gbrain CLI | 120 tasks, k=4 |
| `g3` | When gbrain refuses or queues a write, does the agent recover and report the outcome honestly (write contract)? | gbrain CLI and MCP | 60 tasks on each surface, k=4 |
| `g4` | Does the agent answer about the right entity when a near-namesake exists (wrong entity)? | gbrain CLI | 60 tasks, k=4 |
| `g6` | On a cross-source task where some gold is private, does the agent answer as a local caller and abstain as a remote one? | MCP tool list as a local caller (`gbrain call`) and as a remote caller (`gbrain serve --access read-only`) | 50 tasks for each caller, k=4 |
| `grammar` | Does every input-schema shape gbrain serves dispatch the same through MCP and `gbrain call`? | MCP and `gbrain call` | every served tool schema, keyless |

The models under test are `claude-opus-5-5`, `gpt-6.1-sol` and `particle-1`. Scorecards report pass^k, the failure causes from `causes.ts` and cost per correct answer, per model (and per surface for G3). G6's scorecard also splits verdicts by caller and by the privacy sub-cause of the hidden gold, and counts answers given without the gold. [out-of-view/README.md](out-of-view/README.md) describes G6's world, reachability report and scorer.

## Modes

Every command runs from the repository root.

```
bun eval/runner/predictive/run.ts g3 --dry-run
bun eval/runner/predictive/run.ts g3 --fake --tasks 4
bun eval/runner/predictive/run.ts g3 --paid --smoke --budget-run-id <id>
bun eval/runner/predictive/run.ts g3 --paid --budget-run-id <id>
bun eval/runner/predictive/run.ts grammar
```

- **Dry run** prints the task count, the task digest, the episode count and an estimate at the budget ledger's list prices. It starts no gbrain and no model.
- **Fake** runs scripted model replies against the real gbrain under test. It needs no key and costs nothing. Its numbers prove the harness, not any model.
- **Smoke** is a paid run of one task per surface and model at k=1 (`--tasks` and `--k` override it). It prints the measured cost per episode for each model and the full counted plan's cost projected from those measured means, beside the planning estimate. Its episodes are logged with `counted: false`.
- **Counted** runs the full plan. Its episodes are logged with `counted: true`.

Options: `--tasks N`, `--k N`, `--models a,b,c`, `--seed N`, `--pressured` (G1's time-pressure prompts), `--gbrain <checkout>@<commit>` (an overlay of another gbrain build, so two pins can be compared without changing `package.json`), `--concurrency N` (paid episodes in flight, default 2), `--retry-errored` and `--out` (a file for fake and grammar runs; a directory for paid runs, default `eval/reports/predictive/<unit>-<smoke|paid>/`).

## Paid runs

A paid run starts only inside a granted paid window, and it refuses before any provider client exists unless all of these hold: `--paid` and `--budget-run-id` name an open budget-ledger run with enough money left for the estimate, every model's provider key is set, and `scripts/model-freshness.ts` passes for the models. Open the run once with `bun eval/runner/budget-ledger.ts open --runner <name> --budget-usd <cap>` and pass the id it prints.

The runner process is the run's one ledger writer. It joins the open run and installs the paid-request guard once, and every episode's requests go through that guard, which reserves each request's worst case before sending and reconciles it from the provider's usage fields afterwards. Claude requests are fitted to the model with `fitAnthropicRequest`. `particle-1` uses the repository's OpenAI-compatible client, which refuses any host the ledger can't price.

Cost is recorded twice, from the same provider usage fields:

- `<out>/episodes.jsonl` has one row per episode state change. A finished row holds the scored record (with `usd`, priced from the episode's usage) and `usage` (requests, uncached input, output, cache reads and cache writes, summed from each response).
- `<out>/summary.json` holds the scorecards, the measured cost per episode by model with the counted plan's projection, and the ledger's own summary of the run (requests, reserved and actual cost, and requests charged at their reservation because usage was missing).

### Pauses and resume

When the ledger refuses a reservation, nothing is sent. The runner stops scheduling, lets episodes already in flight reach their own next reservation, marks each refused episode `refused`, prints the command that resumes the run and exits 3. Raise the cap (a ledger extension) or open a new run, then run the printed command.

Running the same command again resumes from the episode log. Finished episodes are skipped. A refused episode runs again, because its refused request never left the process. An episode whose last row is `errored` (a provider or harness error) or `started` (in flight when the process died) may already have been billed, so it is skipped unless you pass `--retry-errored`. The exit code is 0 when every episode finished, 1 when some errored or were skipped, and 3 after a pause.

### On a Ubicloud VM

Long paid runs go on an ephemeral Ubicloud VM, never on a Capy machine, which can pause mid-run.

```
eval/runner/predictive/ubicloud/run.sh g3 smoke <cap-usd> [run.ts options...]
eval/runner/predictive/ubicloud/run.sh g3 paid <cap-usd> [run.ts options...]
eval/runner/predictive/ubicloud/run.sh check
```

`run.sh` creates the VM through `scripts/ubicloud/ubi-runner.sh` with owner `gbev55`, syncs the checkout, runs `setup.sh` (bun 1.4.4, ripgrep, `bun install --frozen-lockfile` and a keyless dry run), pushes the unit's state from `~/.capy/work/predictive/<unit>-<mode>/`, runs `vm-run.sh` detached, pulls the state back and destroys the VM on every exit path. Provider keys travel only through ubi-runner's `--pass`. `vm-run.sh` keeps the ledger beside the episode log, creates it on the first launch, reuses the recorded budget run while it has money left and otherwise opens a new one. After every launch `run.sh` runs the teardown check, which fails if any VM of owner `gbev55` remains; `run.sh check` runs it alone.

## Tests

```
bun test test/eval/predictive-paid.test.ts test/eval/predictive-g6.test.ts test/eval/predictive-runner.test.ts
```

The tests are keyless. Provider keys are deleted for each file. Refusal tests swap `fetch` for a dead upstream and check that no request is attempted. The paid executor tests run against a fake Anthropic upstream behind the real paid-request guard and a temporary ledger.

## Changelog

### 2026-11-09: paid execution, G6 agent layer and the Ubicloud launcher
Paid mode used to plan only. It now runs episodes behind the paid-arm guard, with `--smoke`, `--concurrency`, a resumable episode log, `--retry-errored` and a clean pause at the ledger cap. Added unit `g6` (cross-source tasks over mixed access, as a local and a remote caller), and the Ubicloud launcher in `ubicloud/`.

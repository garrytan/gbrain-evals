# The head-to-head scoreboard: reproduce, add a system, dispute a row

The scoreboard compares gbrain with other agent-memory systems on the same conversations, the same token budgets, the
same reading models and the same judges. It measures gbrain as an agent installs it: the `gbrain-defaults` row runs
gbrain's shipped defaults through its documented agent install, pinned by commit inside the `gbrain-defaults` container
image and its capability record, separately from the gbrain that `package.json` pins for the other benchmarks in this
repository. Other systems are described by kind (`eval/systems/kinds.json`); the page that maps kinds to products,
versions and sources is [comparison-systems.md](comparison-systems.md).

Everything below goes through one front door:

```sh
bun run eval:scoreboard <check|fixture|explain|doctor|plan|smoke|run|status|judge|render|dispute> [--json]
```

Every refusal prints an operator message: a stable code, what happened, why, the next step with its exact command, and
a read-only command that confirms the fix. Exit 0 is success, 2 a refusal, 3 means stop and ask the user, and 4 a
partial result (some cells ran; the spend cap or a block cap stopped the rest). The front door assumes an AI agent is
the operator, so each message names the next action instead of only describing the failure.

## Reproduce

| Goal | Command | Cost | Target time |
|---|---|---:|---:|
| Read the current verdict | README, "How gbrain compares" | $0 | under 2 minutes |
| Regenerate every table and aggregate from the committed rows | `bun run eval:scoreboard check` | $0 | under 2 minutes after `bun install` |
| Run the whole pipeline on the fake system | `bun run eval:scoreboard fixture` | $0 | under 5 minutes |
| See the chain behind one number | `bun run eval:scoreboard explain <row> <column>` | $0 | seconds |
| Run one public cell on this machine | `bun run eval:scoreboard run --local --campaign <manifest> --state <dir> --cell <id>` | under $5 | under 30 minutes |

The time targets are measured by a fresh agent on a fresh machine before publication and recorded in the receipt's
`reproduction.md`.

**`check`** rebuilds the README table, the report tables and every aggregate from the rows in the receipt and fails if a
byte differs. It also scans receipts for provider keys and keeps the receipt tree under its size budget.

**`fixture`** runs the protocol's reference fake system end to end with no provider key and no Docker: the Python
reference shim, the metering proxy in lease mode (with a cell token, per-route output caps and admission control), the
memory-qa harness with the native packer at an 8,000-token budget, a keyless fake provider standing in for the reader
and the judge, the shared answer and judgment records, the cost and speed report, and the generator's `render` and
`check` on the synthetic receipt (`test/eval/fixtures/scoreboard/synthetic.ts`, every number invented). Its scores say
nothing about memory quality; they prove the wiring. `--stub judge-repeat` (or `generator`) replaces a stage that is not
in the checkout with a stub and says so in the output. CI runs it on every pull request.

**`doctor`** is the preflight that runs before any lease is reserved. It checks the Bun version (1.4.0 or later), Python,
Docker, the CPU architecture, free disk, the default proxy and shim ports, which provider keys are present (never their
values), the ledger, the pinned dataset hashes for public sets, that every model a campaign resolves is priced, and,
for Ubicloud runs, that the VM executor is the repository's `scripts/ubicloud/ubi-runner.sh` (or a runner `UBI_RUNNER`
names explicitly), that `UBI_OWNER` tags the VMs, and that a Ubicloud token is present. An unpriced model refuses the run
before any spend and tells the agent to look up the provider's current list price and register it in
`CHAT_PRICE_OVERRIDES` in `eval/runner/budget-ledger.ts`.

**`plan`** prints the authoritative cell manifest: each cell's system, set, configuration, block, lease and VM size; the
waves that keep concurrent vCPUs under the daytime cap (128 by default); each block's estimate, hard cap and leases; and
the exact commands, in order.

**`smoke`** runs the campaign's paid dev smokes (`plan --campaign-out <file> --with-smoke` adds them): one LoCoMo dev
conversation per system for the 8k arm, the whole-system rows and each system's own default amount, and retrieval-only
ingest probes on one BEAM-1M dev conversation. A smoke cell reads, fetches and checks only its dev conversations,
never a sealed one; [the 2026-10-07 smokes](benchmarks/2026-10-06-scoreboard/dev-smokes/README.md) re-priced the
manifest from them.

**`run`** reserves a lease and launches each named cell (`--cell`, `--cells a,b` or `--wave N`). Without `--local` the
cell runs on its own Ubicloud VM through the repository runner; the launcher stops the VM run half an hour after the
cell's `timeout_hours`, pulls the cell's row checkpoint every pull interval, and exits non-zero when any cell fails.
`--dry-run` shows the launching host, where rows land and how the VM is torn down, without reserving anything. Sealed
cells launch only with `--sealed` from the custodian's host, where dataset caches, rows and store snapshots stay;
`--local` refuses them.

### What a counted cell guarantees

- **Freeze.** A campaign manifest of kind `q1-scoreboard-campaign` lists, in `executes`, every repository path a cell
  runs (adapters, scorer, packer, instruments, lockfiles) and, in `images`, every container image by digest. Its hash
  covers those files' git blob ids. `reserve`, `launch`, `resume` and `render` refuse once the tree no longer matches
  the hash stored when the campaign started, and name the changed files. A change that affects execution after the
  freeze needs a new campaign identity (`q1-scoreboard-<suffix>`) recorded in the preregistration.
- **Metering.** Every provider call leaves through the cell's metering proxy, which holds the only real keys. A request
  that does not present the cell's token is refused, wherever it comes from: the runners present the token as their
  provider key and the compose stacks as their dummy key (`${SHOOTOUT_CELL_TOKEN:-dummy}`). Each request has a stable id, the slot it arrived on, the brain and phase the harness bound, and a bucket;
  calls nobody bound land in an explicit unattributed-background bucket. Output caps bind only the harness's own calls
  (readers 2,048 tokens, the file agent's loop 16,000, judges 1,024, configurable in the manifest); a system's own
  requests pass unmodified (preregistration amendment A3). Billed dollars and dollars charged at a reservation
  because no usage came back are reported separately. Cells on one provider key share its requests-per-minute,
  tokens-per-minute and concurrency limits, and a provider's `retry-after` pauses every cell on that key. A 429 counts
  as provider trouble and is retried like a 5xx.
- **Resume.** The VM checkpoints a cell's rows every 20 attempts and the launcher pulls them, so a lost VM costs at most
  one pull interval of rows. After ingest a shim cell's `snapshot_command` (`bash eval/systems/bootstrap.sh snapshot`)
  stops the stack, tars its named volumes into `$SHOOTOUT_SNAPSHOT_DIR` with a sha256 and starts it again, while the
  cell's questions wait; the VM records an immutable ingest realization id over the snapshot's bytes and the launcher
  pulls it. The `restore_command` (`bootstrap.sh restore`) loads that tar into a fresh stack from
  `$SHOOTOUT_RESTORE_DIR`. `bun eval/runner/shootout-cell.ts resume` reruns a lost cell's query phase from that snapshot, or repeats the
  whole conversation when the cell has no `restore_command`. A conversation is never partly re-ingested. The lost VM's
  lease is closed with `abandon`, which charges its full reservation against the cap and says so.
- **Spend.** The campaign cap and each block's cap (1.5 times its estimate) stop new leases. Hitting either is a partial
  result (exit 4) that states the dollars held in leases still charged at their full reservation.

### Cost and speed columns

`bun eval/runner/cost-speed.ts --cell <cell output>` computes p50/p95 retrieval and end-to-end latency, delivered and
reader-input tokens per question, LLM calls and dollars per 1,000 ingested messages and per million ingested tokens,
write-start-to-queryable p50/p95, and monthly cost for a personal agent (2,000 messages and 300 questions a month) and a
team agent (50,000 messages and 10,000 questions). For a system whose capability record says `synchronous`, ingest
spend splits into commit (during `/ingest` calls) and background (from the last `/ingest` to `/finish` ready, plus late
unattributed work); for any other system the ingest-phase total is reported and labeled. Campaign spend, cached-replay
spend (the list price of answers reused instead of paid again) and projected workload cost are three separate numbers.
`--watch --campaign <manifest> --state <dir>` rewrites the campaign's `progress.md`: cells planned, running, done and
invalid, spend per block against its cap, and VMs by owner.

## Add a system

A system joins the scoreboard as a small HTTP service, its shim, inside its own pinned container image. The harness
speaks only [the shim protocol](../eval/systems/PROTOCOL.md) (`/health`, `/capabilities`, `/reset`, `/ingest`,
`/finish`, `/retrieve`, `/delete_source`), so the system's code never runs inside the harness process. This is not the
in-process `Adapter` interface BrainBench's retrieval comparison uses.

1. **Start from the template.** [`eval/systems/_shim/shim.py`](../eval/systems/_shim/shim.py) owns routing, timing, error
   shapes and validation; a shim subclasses `Adapter` and calls `serve(MyAdapter())`.
   [`eval/systems/_fake/fake.py`](../eval/systems/_fake/fake.py) is a complete reference shim (stdlib only) with its
   [compose file](../eval/systems/_fake/docker-compose.yml): the shim on an internal network, an egress relay to the
   metering proxy and an ingress relay. Point every SDK at `OPENAI_BASE_URL` (and `ANTHROPIC_BASE_URL`,
   `VOYAGE_BASE_URL`), keep only a dummy key in the container, and turn off telemetry.
2. **Write the capability record** (`/capabilities`). Every field is required; `readiness` decides how ingest cost is
   split, and `retrieval_policies.<mode>.settings` is the only knob map the harness sends:

   ```json
   {
     "system": "ext-example",
     "protocol": 1,
     "versions": { "package": "1.2.3", "lock_sha256": "<sha256 of the resolved lock>", "image": "sha256:<image digest>", "vendor_benchmark_code": null },
     "configs": {
       "recipe": { "model_roles": { "extraction": "openai:gpt-4.1-mini", "embedder": "openai:text-embedding-3-small" }, "notes": "the vendor's documented configuration" },
       "common": { "model_roles": { "extraction": "openai:gpt-4.1-mini", "embedder": "openai:text-embedding-3-large@1536" } }
     },
     "time": "native",
     "provenance": { "status": "exact", "mechanism": "each memory keeps the source id it was extracted from" },
     "delete": "native",
     "readiness": "synchronous: /ingest returns after extraction and indexing",
     "namespace": "one collection per ns",
     "parallel_namespaces": true,
     "retrieval_policies": { "vendor-default": { "settings": { "k": 10 } }, "fixed-evidence": { "settings": { "k": 50 } } },
     "streaming": "disabled",
     "telemetry_off": ["EXAMPLE_TELEMETRY=false"],
     "agent_surface": { "kind": "none" },
     "deviations_from_vendor_code": []
   }
   ```

3. **Pass the keyless conformance suite** against the running shim. It covers the capability record, health, reset,
   two dated sessions, finish, retrieval with a query time and a policy, namespace isolation, delete, error shapes and
   foreign source ids:

   ```sh
   SHIM_URL=http://127.0.0.1:8700 bun test test/eval/systems-conformance.test.ts
   ```

4. **Rerun on public dev data.** LoCoMo dev (three conversations) is the development set for harness work. With the
   shim running and the metering proxy in front of it:

   ```sh
   bun eval/runner/memory-qa/run.ts --benchmark locomo --split dev --system http://127.0.0.1:8700 \
     --context native --budget-tokens 8000 --qa reader --provider-proxy http://127.0.0.1:8787 --output eval/reports/scoreboard-dev/ext-example
   ```

   or, as a campaign cell on this machine, `bun run eval:scoreboard run --local --campaign <manifest> --state <dir> --cell <id>`.

5. **Register the kind** in `eval/systems/kinds.json` and its product, version, image digest and lock hash in the pin
   table of [comparison-systems.md](comparison-systems.md). Product names appear only there and in the install bundle
   under `docs/comparison-systems/<kind>/`; `bun eval/runner/name-guard.ts` fails anywhere else.

## Dispute a row

Open an issue with the [scoreboard dispute template](../.github/ISSUE_TEMPLATE/scoreboard-dispute.md)
(`gh issue create --template scoreboard-dispute.md`), or run `bun run eval:scoreboard dispute` for the same steps. The
gbrain-evals maintainer thread answers within 7 days. Bring the `explain` output for the disputed number, the
configuration as a capability-record override, the conformance run, and the dev rerun.

An accepted configuration adds a new row, run on public dev data, beside the original row. A published row is never
edited or replaced, and both rows stay linked. A rerun on held-out data is a new costed campaign that needs approval;
the scoreboard never spends on its own.

## Refresh

A new gbrain release, or a new release of a pinned external system, marks the affected rows "newer release available".
The generator prints that staleness line under the tables. A rerun is a new campaign with its own identity, cap and
preregistration.

## Changelog

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](../CHANGELOG.md).

### 2026-10-07: Dev-only smokes, harness output caps

`smoke` now runs dev-only smoke cells (one LoCoMo dev conversation, one BEAM-1M dev conversation) instead of
20-question copies of counted cells, which would have opened sealed data. The metering paragraph states the caps as
amendment A3 left them, including the file agent's 16,000-token loop cap.

### 2026-10-06: Strict cell token, store snapshots

Metering: a request without the cell's token is now refused even from the cell's own machine (it was admitted from
loopback or a Docker bridge); the stacks present the token as their dummy key. Resume: shim cells now snapshot and
restore their stores with `bootstrap.sh snapshot` and `restore` (named volumes, sha256), and questions wait for the
snapshot.

### 2026-10-06: Page created

The scoreboard's front door (`bun run eval:scoreboard`) and its reproduce, add-a-system and dispute paths, with the
time targets, the campaign freeze, metering, resume and cost and speed contracts a counted cell runs under.

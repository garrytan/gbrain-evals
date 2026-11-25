# On a shared gbrain brain, one person's memory stays with that person: 0 cross-person leaks at v0.60.771.0

- **We learned that gbrain v0.60.771.0 kept every person's saved memory to that person.** Across 1,492,098 probes on six
  cells (in process, over HTTP and through the CLI, each on PGLite and Postgres), nothing one person saved reached
  another person, and nothing reached a caller acting for nobody. You can put one gbrain brain behind a team assistant
  without one person's memory showing up in another person's answers, provided the assistant names the person on
  every call.
- **We learned that the release before it, v0.60.769.0, leaked through the CLI's `--as` preview.** That preview lets the
  operator see what a person would see. It showed pages from another person's private source, and its "not found" hint
  told a hidden page apart from one that doesn't exist. gbrain fixed both in v0.60.771.0. You should upgrade to
  v0.60.771.0 or later before you rely on `--as` to check what a person can read. gbrain's `stable` tag pointed at
  v0.60.768.0 when this page was written, which is older than the fix.
- **This is a regression gate, not a proof.** It covers 80 read operations in process, 67 over HTTP and the 4 mandatory
  CLI commands, each of which returned something a person saved to its owner. The operations that never did are
  listed below, so you can see what the zero doesn't cover. Vector and hybrid search weren't tested, because the run
  uses no keys.

Settled call: the person-isolation check goes into CI at gbrain v0.60.771.0. It runs the PGLite cells in the offline tier
on every pull request and gbrain pin bump, and the Postgres cells in their own CI job. Neither is yet a check that must
pass before a pull request can merge, so a leak shows as a red check but does not block the merge on its own. gbrain's multi-person setup may
cite "no cross-person leak in 1,492,098 probes at v0.60.771.0", with the operation lists and bounds below.

The study ran on November 24 and 25, 2026, under the [frozen plan and its two amendments](2026-11-24-person-isolation-preregistration.md).
No model is called. Gold comes from the world generator's ledger and gbrain's documented access rules, never from
gbrain's output.

## Results at v0.60.771.0

gbrain v0.60.771.0 (`97ef356f574a66709ef1bf4ae1cad604727852d8`) was the newest release on gbrain's master when the
re-run started. The runs used three seeds (20261124, 20261125 and 20261126), one 16-vCPU machine per seed, with all six
cells in parallel. The runner was at commit `bc0d8763e`, and every receipt records a clean tree (`dirty: false`).

| Cell | Probes (3 seeds) | Leaks | Read operations with signal | Mandatory operations with signal | Minutes per seed |
|---|---:|---:|---:|---:|---|
| [mcp-dispatch-pglite](2026-11-24-person-isolation/v0.60.771.0/20261124/mcp-dispatch-pglite.json) | 379,392 | **0** | 80 of 117 | 16 of 16 | 18.9, 20.2, 19.5 |
| [mcp-dispatch-postgres](2026-11-24-person-isolation/v0.60.771.0/20261124/mcp-dispatch-postgres.json) | 379,392 | **0** | 80 of 117 | 16 of 16 | 19.4, 20.0, 19.9 |
| [http-pglite](2026-11-24-person-isolation/v0.60.771.0/20261124/http-pglite.json) | 351,561 | **0** | 67 of 117 | 16 of 16 | 22.6, 24.1, 22.9 |
| [http-postgres](2026-11-24-person-isolation/v0.60.771.0/20261124/http-postgres.json) | 351,561 | **0** | 67 of 117 | 16 of 16 | 24.3, 25.0, 24.1 |
| [cli-pglite](2026-11-24-person-isolation/v0.60.771.0/20261124/cli-pglite.json) | 15,096 | **0** | 4 of 5 | 4 of 4 | 33.3, 34.2, 33.9 |
| [cli-postgres](2026-11-24-person-isolation/v0.60.771.0/20261124/cli-postgres.json) | 15,096 | **0** | 4 of 5 | 4 of 4 | 31.1, 32.0, 31.5 |

The links go to seed 20261124's receipts. The other seeds are in the same folder, under
[`v0.60.771.0/`](2026-11-24-person-isolation/v0.60.771.0).

A **leak** is any one of five things:

- another person's canary in a response;
- another person's page slug, fact id or request id that the probe didn't ask for;
- a response to a protected target that differs from the response to a target nobody ever wrote (an existence oracle);
- an answer given as the wrong person (an identity slip);
- a write-shaped call that changes another person's rows.

All five were zero on all 18 cell runs. Each cell also passed its validity checks:

- Every person's write through every memory channel committed.
- Each owner read back their own canary on every channel.
- Both must-fail controls were caught: a planted canary copied onto a page everyone can read, and an operator grant
  that wrongly gives one person another's private source.
- No cell hit its time limit.
- No counted probe had a harness error. Ghost calls, made only to compare with a protected call, are not in that
  tally: a ghost call that errored would have been dropped from its comparison without being counted.

A probe counts toward **signal** only when it was able to find a leak. The owner, asking the same thing, must read
their own canary. The caller must then either see the public twin or, if it must be refused, be refused. An operation
"with signal" had at least one such probe.

**Per mandatory operation.** The plan gives the rule-of-three bound, 3/n, only per operation and cell. Here n is the
operation's probe count in that cell: every call made, including the owner and public-twin calls that check for signal,
calls that were refused, and the same arguments repeated warm and cold. So n overstates how many distinct argument sets
and callers reached the operation, and the bound is looser than it looks. It is not a probability that the operation
leaks.
PGLite and Postgres planned the same probes, so one column covers both engines.

| Operation | In process: probes (3/n) | HTTP: probes (3/n) | CLI: probes (3/n) |
|---|---:|---:|---:|
| `memory_recall` | 2,415 (0.12%) | 2,238 (0.13%) | — |
| `recall` | 13,845 (0.022%) | 12,828 (0.023%) | not mandatory |
| `query` | 2,424 (0.12%) | 2,247 (0.13%) | 675 (0.44%) |
| `search` | 2,415 (0.12%) | 2,238 (0.13%) | 675 (0.44%) |
| `get_page` | 31,371 (0.0096%) | 29,067 (0.010%) | 8,553 (0.035%) |
| `get_chunks` | 4,521 (0.066%) | 4,197 (0.071%) | — |
| `entity` | 7,149 (0.042%) | 6,618 (0.045%) | — |
| `context_pack` | 11,613 (0.026%) | 10,758 (0.028%) | — |
| `delta` | 10,464 (0.029%) | 9,708 (0.031%) | — |
| `think` | 5,256 (0.057%) | 4,878 (0.062%) | 1,431 (0.21%) |
| `volunteer_context` | 804 (0.37%) | 750 (0.40%) | — |
| `whois` | 2,415 (0.12%) | 2,238 (0.13%) | — |
| `get_backlinks` | 17,835 (0.017%) | 16,518 (0.018%) | — |
| `get_timeline` | 13,515 (0.022%) | 12,522 (0.024%) | — |
| `list_write_requests` | 2,415 (0.12%) | 2,238 (0.13%) | — |
| `get_write_request` | 3,126 (0.096%) | 2,916 (0.10%) | — |

**Operations without signal.** These were called and scanned like every other operation, but no owner ever got a
canary back from them, so a zero on them shows nothing.

- In process, 37 operations: `advisor`, `chronicle_day`, `chronicle_since`, `code_blast`, `code_callees`,
  `code_callers`, `code_def`, `code_flow`, `code_refs`, `connectors_status`, `fetch`, `file_list`, `file_url`,
  `file_verify`, `get_agent_job`, `get_job`, `get_job_progress`, `get_page_upload`, `get_recent_transcripts`,
  `get_skill`, `get_skill_asset`, `get_skill_policy`, `get_skill_retention`, `get_versions`, `list_page_purges`,
  `list_skills`, `list_watches`, `questions_list`, `questions_status`, `reveal_secret`, `search_by_image`,
  `sources_inspect`, `sources_resolve_path`, `sources_status`, `storage_get`, `synthesize` and `wait_job`. Most
  of them read things this world doesn't create: code, skills, jobs, files, storage and connectors. `search_by_image`
  needs an embedding key. The plan excluded `synthesize` from the start.
- Over HTTP, the same 37 plus 13 more. These are admin and status operations that refuse every HTTP caller in this world
  with `insufficient_scope`: `cache_stats`, `get_health`, `get_job_stats`, `get_stats`, `get_status_snapshot`,
  `get_usage`, `get_write_attribution`, `list_jobs`, `quarantine_list`, `reload_schema_pack`, `run_doctor`,
  `search_stats` and `search_tune`.
- On the CLI, `recall`. The thin client's `gbrain recall` gave no owner a positive control, and `--as` previews refuse
  it.

## What v0.60.769.0 did

The plan's first counted run measured v0.60.769.0 (`38831bb696139024923e9bc43e3da0d7993951e9`), the newest release
when that run started, with the runner at `c2bfa710f`. The four in-process and HTTP cells were at zero. Both CLI cells
failed, with 413 leaks each over the three seeds: 305 content leaks and 108 existence oracles. Every one came from the
host's `--as` preview, which lets the operator run a command as if they were a given person:

- The preview ignored personal-source bindings. A preview as one person returned pages from another person's private
  direct-message source.
- The preview's not-found hint read differently for a page the person may not see than for a page that doesn't exist,
  so it told whether the hidden page exists.

As the plan requires, the detail went privately to gbrain's maintainers the same day. They shipped the fix in
v0.60.771.0. A dated [amendment](2026-11-24-person-isolation-preregistration.md#amendment-2-re-run-on-the-fixed-release-and-ci-2026-11-25-before-the-re-runs-first-counted-probe)
moved the run to that release before the re-run's first counted probe. The other operations and callers on the CLI
cells, and every caller on the other four cells, were at zero on v0.60.769.0 as well.

| Cell at v0.60.769.0 | Probes (3 seeds) | Leaks | Read operations with signal |
|---|---:|---:|---:|
| mcp-dispatch-pglite, mcp-dispatch-postgres | 378,573 each | **0** | 79 of 116 |
| http-pglite, http-postgres | 350,796 each | **0** | 66 of 116 |
| cli-pglite, cli-postgres | 15,096 each | **413** each | (a failing receipt publishes only its total) |

The receipts are in [`v0.60.769.0/`](2026-11-24-person-isolation/v0.60.769.0). As the plan requires, the failing ones
record only their verdict and total. v0.60.770.0 added one read operation, `learned`. The runner lists operations from
gbrain's registry at run time, so the re-run probed it without a runner change, and `learned` carried signal.

## How it works

**The world.** Each seed generates a team of seven fictional people on one brain:

- P1, plus P2, whose id starts with P1's id;
- P3, known by an email address;
- P4, known by an OIDC subject;
- P5, who shares a group with P1;
- P6, who saves nothing and serves as the ghost;
- a person who writes and then leaves.

Each person who writes saves a unique canary through every channel: `remember`, a page marked `readable_by` that person,
a private folder, a page in their own direct-message source, facts, write requests and proposals. Public twins sit beside
them, so a caller that can read public text has something to find. The world also plants near-miss ids, such as a prefix
match, a case change and a leading space.

**The callers.** Every read operation in gbrain's registry is called by every kind of caller:

- another person, named by a trusted client in a direct message or in a room;
- a near-miss of the person's id;
- another person's own key;
- a client bound to nobody, with and without a source scope;
- the attest client with no person named;
- the person who left;
- on the CLI, the host previewing as someone else.

Each operation gets base arguments, every widening flag (`include_private`, `all_sources` and the rest) and, where it
takes one, the person's direct-message source and `__all__`. The room caller is the exception for the source: the room
client always sends the team source, which overrides the probe's own, so its direct-message and `__all__` variants
reached gbrain as team-source calls and test the room's other arguments only. Probes run warm on shared sessions and again cold with
concurrent callers; the CLI cells run warm only. A write-shaped phase checks that another person's write calls never
change P's rows, and a run of gbrain's dream cycle checks that derived pages don't carry a canary to another person.

**Validity.** A cell is invalid, and publishes no number, if any of these happen:

- a write fails;
- an operation has more than two harness errors;
- the cell reaches its time limit;
- a must-fail control passes.

A mandatory operation with no signal also stops the cell. None of the 18 counted re-run cells stopped.

**What it doesn't test.** It doesn't test the following:

- vector or hybrid search (the run is keyless);
- `synthesize`;
- a compromised attest client, which by design may name any linked person;
- network attacks on the server;
- timing side channels;
- operator mistakes that gbrain's doctor flags.

## In CI

The check now runs on every pull request in this repository:

- The ci profile on the in-process and HTTP PGLite cells runs in the offline tier, as the registry entry
  `person-isolation-fuzz-ci`. It runs each served operation once per caller kind against one target person rotated by
  operation, with base arguments, warm only: 3,309 probes per cell, about 3 minutes each.
- A `person-isolation-postgres` job runs the same profile on the two Postgres cells, against a Postgres service pinned
  by digest.

Both fail on any leak, on a mandatory operation without signal, and on a must-fail control that passes. Neither is yet
required for merge. A failing run in
public CI prints and keeps only its total, and its report folder is never uploaded.

## Notes on the receipts

- Every receipt here records `publishable: false`. The runner marks a receipt publishable only when the run carries an
  attestation that the plan's newest commit is on GitHub. The plan itself kept this branch unpushed until the CLI cells
  passed, so that no public commit would describe the `--as` paths before the fix shipped. So no run could carry that
  attestation. The order is still on record: CI's preregistration-order check confirms the plan was committed before any
  result file, and each receipt's `git_head` contains the plan and the amendments that govern it. The re-run's head,
  `bc0d8763e`, is the commit that adds amendment 2, and amendment 1 (`c2bfa710f`) is an ancestor of it. This pull request
  merges as a merge commit, so those commits stay on main.
- The v0.60.769.0 receipts record `dirty: true`: the working tree wasn't clean when that run launched. The runner and
  plan were committed at `c2bfa710f`. The re-run launched from a clean tree, and its receipts record `dirty: false`.
- Everything here ran on Ubicloud machines. No model or paid API was called.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: QM is a project of Y Combinator, which Garry Tan runs.

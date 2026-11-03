# Shared agents (on_behalf_of): search cost and recall

Published 2026-10-28. Measured 2026-10-28 on a Ubicloud standard-16 VM with
gbrain's `scripts/bench-member-access.ts`. The build is gbrain PR #7852
(per-member read access, part B: shared agents) at head `e5bee20d`, compared with its parent
`9167c248` (#7842, part A2). #7852 ships in train M (gbrain PR #8134), which was re-checked at
head `244f30dd` on 2026-10-31 ([below](#re-check-on-train-m-2026-10-31)). Cost: about 3.2 VM-hours,
no model spend.

PR #7852 lets one shared agent read, call by call, as the people a turn serves.
Its harness names the audience in the `X-Gbrain-On-Behalf-Of` header or
request-level `_meta.on_behalf_of`, and a page is returned only when every
audience entry may read it. This report checks two things. First, that the
change costs nothing on calls without an audience, at every restricted share.
Second, what a one-member or two-member audience costs, and whether it loses
recall.

## The finding

**Calls without an audience are unchanged: every cell is within ±1% of the parent
(medians -0.9% to +0.5%), on a brain with no restrictions and at 20% and 80%
restricted.** An audience costs at most 1.3 ms over the same member's own
token: a two-member audience adds two readers conditions per row.

**On train M, the code that ships, both results hold.** The train is within
-1.3% to +0.3% of folder rules (A2) on a brain with no restrictions. An audience
costs 0.1 to 2.2 ms over the member's own token; the 2.2 ms is a two-member
audience on keyword search. Every audience cell has hit@10 1.0. **Audience
recall equals the member's**: hit@10 is 1.0 everywhere except 0.998 in the 20%
hybrid cells, the same 0.998 the member's own token gets. No run reported a
degraded search.

## The experiment and results

The corpus and harness are the ones from the
member read access report (gbrain-evals #198, `docs/benchmarks/2026-10-28-member-read-access.md`):
- 5,000 single-source pages on an in-process PGLite brain with no git repository.
- Bag-of-words hash embeddings, so no key is needed.
- 60 timed remote MCP `search` calls per cell after 5 warm-up calls, through the
  real token verifier and dispatch.

Restricted pages alternate between `readable_by: [alice-example, alice-twin]`
and `readable_by: [group:team-b]`. The cells are:
- `member`: a token bound to alice-example.
- `aud1`: a bot token whose `may_act_for` lists both members, called with the
  audience `alice-example`.
- `aud2`: the same bot token, called with the audience
  `alice-example, alice-twin`. Both members read the same pages, so the right
  answer matches the member's.

Each run cycles through the cells in a rotating order. The script stops on any
failed search, any lost vector arm or any degraded retrieval stage except the
reranker, which this keyless bench never configures.

Each row is the median of the per-run p50 over 8 runs, with branch and parent
runs interleaved on the same VM. Brackets are the min and max across runs. The
parent has no audience support, so its audience cells are blank.

| Restricted | Cell | #7852 (ms) | Parent (ms) | Change | hit@10 |
|---|---|---|---|---|---|
| 0% | unbound hybrid | 72.1 [71.2–82.6] | 72.7 [72.0–77.5] | -0.9% | |
| 0% | member hybrid | 72.2 [71.2–82.8] | 72.6 [71.9–77.9] | -0.6% | |
| 0% | unbound keyword | 67.5 [67.2–69.3] | 67.8 [66.4–70.3] | -0.4% | |
| 0% | member keyword | 67.5 [67.1–69.3] | 67.7 [66.3–70.2] | -0.2% | |
| 20% | unbound hybrid | 72.3 [71.5–74.7] | 72.7 [72.0–73.7] | -0.5% | |
| 20% | member hybrid | 73.1 [72.2–74.8] | 73.5 [72.9–74.3] | -0.5% | 0.998 |
| 20% | aud1 hybrid | 73.2 [72.5–75.5] | | | 0.998 |
| 20% | aud2 hybrid | 74.0 [73.2–76.5] | | | 0.998 |
| 20% | unbound keyword | 58.7 [58.0–59.5] | 58.7 [57.6–59.5] | +0.1% | |
| 20% | member keyword | 65.6 [64.8–66.5] | 65.4 [64.6–66.7] | +0.3% | 1.0 |
| 20% | aud1 keyword | 65.9 [65.0–66.8] | | | 1.0 |
| 20% | aud2 keyword | 66.6 [65.9–67.7] | | | 1.0 |
| 80% | unbound hybrid | 99.1 [97.3–100.0] | 99.1 [98.2–100.2] | -0.0% | |
| 80% | member hybrid | 72.4 [72.1–73.0] | 72.8 [72.5–73.8] | -0.5% | 1.0 |
| 80% | aud1 hybrid | 72.7 [72.3–73.1] | | | 1.0 |
| 80% | aud2 hybrid | 73.4 [73.1–73.9] | | | 1.0 |
| 80% | unbound keyword | 25.6 [25.4–25.8] | 25.5 [25.2–25.8] | +0.2% | |
| 80% | member keyword | 51.8 [51.5–52.8] | 51.5 [51.0–52.3] | +0.5% | 1.0 |
| 80% | aud1 keyword | 52.0 [51.7–52.8] | | | 1.0 |
| 80% | aud2 keyword | 53.1 [52.8–54.0] | | | 1.0 |

An audience over the same member's own token, in medians:
- **aud1** (one member): +0.1 to +0.3 ms.
- **aud2** (two members): +0.9 to +1.3 ms, or 1.2 to 2.5%. The 2.5% is keyword
  search at 80% restricted.

Every remote response now also carries `_meta.access`. On a brain with no
restrictions this costs no query. On a restricted brain it costs one aggregate
over `access_policy_revisions`, and that cost is already inside the numbers above.

## Re-check on train M (2026-10-31)

#7852 merges inside train M (gbrain PR #8134). The train's head `244f30dd`
carries #7852 at `324d22f5` unchanged, plus the train's own fixes. Three pieces
of evidence say the finding holds there.

**The measured code is the same.** #7852's change to the search path
(`src/core/access/caller.ts`, `audience.ts`, `src/core/search/private-visibility.ts`,
the pages SQL and MCP dispatch) at `324d22f5` differs from the measured
`e5bee20d` in three ways:
- One call site follows folder rules' later `privacyForCaller` signature.
- The caller state carries folder rules' `remotePolicy` field.
- A security fix makes an audience naming several people apply the readers
  check under the operator privacy hatch. The bench never turns the hatch on.

The train's `244f30dd` then reads the remote read policy from the request's
config snapshot instead of a separate config query. That applies to every
remote call, with or without an audience, and returns the same policy.

**Calls without an audience still cost nothing measurable.** The train M
attribution run in the [member read access report](2026-10-28-member-read-access.md#which-part-costs-what)
(6 rounds on one VM, raw JSON in
`2026-10-28-member-read-access/train-m-attribution/`) ran folder rules (A2,
`98ee33d2`) and the train at `244f30dd`, which adds #7852 and the train fixes
to A2. Each row is the median of the per-run p50; the paired change is the
median of each round's train/A2 ratio:

| Cell (no restrictions) | A2 (ms) | Train M (ms) | Change | Paired change |
|---|---|---|---|---|
| unbound hybrid | 75.0 | 75.1 | +0.2% | +0.9% |
| member hybrid | 74.8 | 75.1 | +0.3% | +0.5% |
| unbound keyword | 69.6 | 69.1 | -0.8% | +0.3% |
| member keyword | 70.2 | 69.2 | -1.3% | -0.6% |

The train always ran after A2 in that run, and that report finds run order
moves results by about a point.

**An audience's cost and recall at the train head.** Two sources, each giving
the audience's p50 minus the member's own-token p50:
- One restricted run at `244f30dd`
  (`2026-10-28-member-read-access/train-m-balanced/restricted.json`).
- 8 runs of this bench at train head `a2a669cb`, before the policy-snapshot fix
  (raw JSON in [2026-10-28-shared-agent-audience/train-m-a2a669cb/](2026-10-28-shared-agent-audience/train-m-a2a669cb/)).
  The column is the median of the per-run differences.

| Restricted | Cell | `244f30dd`, 1 run | `a2a669cb`, 8 runs |
|---|---|---|---|
| 20% | aud1 keyword / hybrid | +0.55 / +0.32 ms | +0.38 / +0.13 ms |
| 20% | aud2 keyword / hybrid | +2.16 / +0.75 ms | +1.51 / +0.98 ms |
| 80% | aud1 keyword / hybrid | +0.61 / +0.71 ms | +0.49 / +0.39 ms |
| 80% | aud2 keyword / hybrid | +1.12 / +0.54 ms | +2.12 / +0.62 ms |

hit@10 is 1.0 in every member and audience cell of both sources, and no run
reported a degraded search.

The `a2a669cb` runs shared the VM with a noisy neighbour: one cell's p50 varied
about 12% from run to run, against under 1% on October 28. So its comparison
with the parent (`13055077`, train M before #7852 was merged) swings from -38%
to +54% per run and is not used here. Only the differences within a run are.

## Limits

- PGLite on one 16-vCPU VM. Postgres behind a network was not measured.
- The corpus is synthetic and contains notes only.
- The main run used head `e5bee20d`. Later heads change only a path taken under
  the operator privacy hatch, which the bench never sets, and where a read
  takes the remote read policy from (see the re-check).
- The train M audience numbers come from one run at `244f30dd` and eight noisy
  runs at `a2a669cb`, so they are less precise than the October 28 table.

## Reproduce and inspect

From a gbrain checkout at `e5bee20d` (and a worktree of `9167c248` with the
same bench script copied in, for the parent):

```bash
bun install --frozen-lockfile
bun scripts/bench-member-access.ts --pages 5000 --queries 60 --shares 0,0.2,0.8 --json
```

The train M re-check used the same commands at `a2a669cb`, with the parent
worktree at `13055077`. Raw JSON for every run is in
[2026-10-28-shared-agent-audience/](2026-10-28-shared-agent-audience/)
(`b-N.json` is #7852, `parent-N.json` is the parent; `train-m-a2a669cb/` holds
the train M re-check runs in the same layout).

# Shared agents (on_behalf_of): search cost and recall

Published 2026-10-28. Measured 2026-10-28 on a Ubicloud standard-16 VM with
gbrain's `scripts/bench-member-access.ts`. The build is gbrain PR #7852
(per-member read access, part B: shared agents) at head `e5bee20d`, compared with its parent
`9167c248` (#7842, part A2). Cost: about 1.5 VM-hours, no model spend.

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
token: a two-member audience adds two readers conditions per row. **Audience
recall equals the member's**: hit@10 is 1.0 everywhere except 0.998 in the 20%
hybrid cells, the same 0.998 the member's own token gets. No run reported a
degraded search.

## The experiment and results

The corpus and harness are the ones from the
[member read access report](2026-10-28-member-read-access.md):
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

## Limits

- PGLite on one 16-vCPU VM. Postgres behind a network was not measured.
- The corpus is synthetic and contains notes only.
- The run used head `e5bee20d`. The later head `9432bea9` changes only a path
  taken under the operator privacy hatch, which the bench never sets.

## Reproduce and inspect

From a gbrain checkout at `e5bee20d` (and a worktree of `9167c248` with the
same bench script copied in, for the parent):

```bash
bun install --frozen-lockfile
bun scripts/bench-member-access.ts --pages 5000 --queries 60 --shares 0,0.2,0.8 --json
```

Raw JSON for every run is in
[2026-10-28-shared-agent-audience/](2026-10-28-shared-agent-audience/)
(`b-N.json` is #7852, `parent-N.json` is the parent).

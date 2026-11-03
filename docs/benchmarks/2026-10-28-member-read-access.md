# Per-member read access: search cost on a brain with no restrictions

Published 2026-10-28, re-measured 2026-10-31. Measured on Ubicloud standard-16
VMs with gbrain's `scripts/bench-member-access.ts`. The first build was gbrain
PR #7812 (per-member read access, part A1) at head `f1c39714`, compared with
its parent `8e9cd64d` (#7593). #7812 ships in train M (gbrain PR #8134, with
folder rules #7842 and shared-agent audiences #7852), which was re-measured at
head `244f30dd` against master `922ba1a9`
([below](#re-measure-on-train-m-2026-10-31)). Cost: about seven VM-hours, no
model spend.

GBrain is a Markdown-first memory system for agents. PR #7812 lets one shared
brain answer each member with only the pages that member may read: a page that
names `readable_by` in its frontmatter reaches only the listed members. Every
remote read now carries one more condition. This report measures what that
condition costs a brain that uses no restrictions at all, which is nearly every
brain.

## The finding

**Hybrid search, the default mode, costs 1.5 to 1.6% more than before, which is
within the 2% gate. Keyword-only search costs 3.2 to 3.9% more (about 2.5 ms on
a 67 ms call).** The keyword result was accepted by GBRA-108: the column-read
cost was measured and the fail-safe was kept. Members of a restricted brain get
every page they may read: hit@10 is 1.0 in every restricted cell.

**Re-measure on the code that ships (train M, 2026-10-31).** With the order of
the two builds alternated each round, hybrid search costs 1.5 to 1.9% by the
same method (within the 2% gate) and keyword-only search costs 2.2%. A paired
per-round ratio gives 2.2 to 2.6% and 2.7 to 2.8%. Which build runs first in a
pair shifts the result by about a point, and the October 28 runs always ran
the branch first.

## The experiment and results

The corpus is synthetic: 5,000 single-source pages on an in-process PGLite brain
with no git repository, and words drawn from a 4,000-word vocabulary by a fixed
generator, so both builds see the same corpus. Embeddings are a deterministic
bag-of-words hash, so no key is needed. Each run issues 60 timed remote MCP
`search` calls per cell (after 5 warm-up calls), through the real token
verifier and dispatch. "Unbound" is a token bound to no member. On a brain with
no restrictions, "member" is a second unbound token.

Each row below is the median of the per-run p50 over 8 runs, with branch and
base runs interleaved on the same VM. Brackets are the min and max across runs.

| Cell | #7812 (ms) | Parent (ms) | Change |
|---|---|---|---|
| unbound hybrid | 72.9 [72.1–74.5] | 71.8 [70.6–72.9] | +1.6% |
| member hybrid | 72.9 [72.1–75.2] | 71.8 [70.9–74.1] | +1.5% |
| unbound keyword | 69.6 [67.9–75.0] | 67.0 [66.3–68.5] | +3.9% |
| member keyword | 69.5 [67.8–73.2] | 67.3 [66.3–68.5] | +3.2% |

### Where the keyword cost comes from

On a brain with no restrictions, each remote read tests only
`page_readers IS NULL`, a column that a trigger fills whenever a page names
readers. A separate VM run removed one candidate at a time, with 6 interleaved
runs per variant:

| Variant | Keyword change vs parent |
|---|---|
| #7812 as shipped | +3.0 to +3.4% |
| access predicate replaced by `TRUE` | +0.5 to +0.6% |
| `page_readers` GIN index dropped | +3.0 to +3.3% |

So the cost is reading one `pages` column for each row the keyword match
visits, not the index and not the predicate's logic. The likely mechanism is
that `page_readers` is the table's last column, so reaching it walks past the
variable-width columns before it. The ablations are consistent with that, but
it was not proven directly.

The only way to remove the cost is to skip the condition entirely on a brain
with no restrictions. That would leave a window, one request long, at the
moment a brain gets its first restricted page, in which an in-flight request
could return that page. That option was rejected.

### Restricted brains

One run on the same VM, at head `f1c39714`:

| Share of pages restricted | Cell | p50 (ms) | hit@10 |
|---|---|---|---|
| 20% | unbound keyword | 60.0 | |
| 20% | member keyword | 66.5 | 1.0 |
| 20% | unbound hybrid | 74.5 | |
| 20% | member hybrid | 74.8 | 1.0 |
| 80% | unbound keyword | 24.9 | |
| 80% | member keyword | 50.4 | 1.0 |
| 80% | unbound hybrid | 101.3 | |
| 80% | member hybrid | 73.7 | 1.0 |

### Bugs found by this benchmark, fixed before merge

- The readers test was first written as `frontmatter->'readable_by' IS NULL`.
  The planner estimated one matching row and chose nested-loop sequential
  scans, so unbound hybrid search at 80% restricted took 1,478 ms. Predicates
  now test plain columns first.
- The vector index walk did not select `page_readers`, so every bound member's
  hybrid search silently fell back to keyword only. That also made the member
  cells look faster than base in early runs. The benchmark now fails on any
  degraded search instead of timing it.

## Re-measure on train M (2026-10-31)

#7812 merges as part of train M, gbrain PR #8134 at head `244f30dd`, which
also carries folder rules (#7842) and shared-agent audiences (#7852). The same
bench and corpus were run against master `922ba1a9`, 10 runs per build on one
VM. The order alternated: odd rounds ran master first, even rounds ran the
train first. Each row is the median of the per-run p50 (the method above);
brackets are the min and max across runs. The paired column is the median of
each round's train/master ratio.

| Cell | Train M (ms) | Master (ms) | Change | Paired change |
|---|---|---|---|---|
| unbound hybrid | 72.7 [71.9–73.7] | 71.6 [70.6–72.1] | +1.5% | +2.2% |
| member hybrid | 72.8 [72.0–74.1] | 71.5 [70.6–72.3] | +1.9% | +2.6% |
| unbound keyword | 68.3 [67.4–68.8] | 66.9 [65.3–67.6] | +2.2% | +2.7% |
| member keyword | 68.4 [67.5–69.0] | 66.9 [65.2–67.6] | +2.2% | +2.8% |

The 2% gate was set on the median-of-p50 method, so hybrid passes it (GBRA-108
accepted train M on this run). By the paired method it sits just above.
Keyword-only search is below the #7812 figure GBRA-108 had accepted.

### Run order matters

Two earlier train M runs disagreed with this one, and the difference is which
build ran first in each pair:

| Run | Order | Hybrid change vs master |
|---|---|---|
| 8 + 8 pairs | train always first | +4.1 to +4.7% |
| 6 rounds of master, A1, A2, train | master always first, train last | +0.1 to +1.1% |
| 10 + 10 pairs (table above) | alternated | +1.5 to +1.9% |

Within the balanced run, the train's paired change is about one point higher
in the rounds where it ran first. The October 28 runs above always ran the
branch first, so their figures likely carry the same bias (a point or so
high). Future runs of this bench should alternate the order.

### Which part costs what

In the 6-round run (master first, train last, so read the differences between
builds rather than against master), A1 alone (#7812 at `51bb994d`), A1 plus
folder rules (A2, `98ee33d2`) and the full train were within 2.6 points of
each other on every cell, and no build was consistently the slowest:

| Cell | Master (ms) | A1 | A2 | Train M |
|---|---|---|---|---|
| unbound hybrid | 74.3 | −1.4% | +0.9% | +1.1% |
| member hybrid | 75.0 | −1.7% | −0.2% | +0.1% |
| unbound keyword | 70.7 | −0.8% | −1.6% | −2.4% |
| member keyword | 70.2 | −0.4% | 0.0% | −1.4% |

So neither folder rules nor shared-agent audiences adds a cost of its own on
a brain with no restrictions.

### Restricted brains on train M

One run at `244f30dd`. `aud1` and `aud2` are a shared-agent token whose
harness names the member alone, or the member and a second member who reads
the same pages:

| Share restricted | Cell | p50 (ms) | hit@10 |
|---|---|---|---|
| 20% | unbound keyword / hybrid | 68.9 / 76.4 | |
| 20% | member keyword / hybrid | 76.6 / 77.2 | 1.0 / 1.0 |
| 20% | aud1 keyword / hybrid | 77.2 / 77.5 | 1.0 / 1.0 |
| 20% | aud2 keyword / hybrid | 78.8 / 78.0 | 1.0 / 1.0 |
| 80% | unbound keyword / hybrid | 30.9 / 115.4 | |
| 80% | member keyword / hybrid | 62.5 / 82.1 | 1.0 / 1.0 |
| 80% | aud1 keyword / hybrid | 63.1 / 82.8 | 1.0 / 1.0 |
| 80% | aud2 keyword / hybrid | 63.6 / 82.6 | 1.0 / 1.0 |

## Limits

- PGLite on one 16-vCPU VM. Postgres behind a network adds round trips that
  dwarf these differences, but it was not measured here.
- The corpus is synthetic and contains notes only.
- Restricted cells are a single run.
- Run order shifts results by about a point (see above); only the train M
  balanced run alternates it.

## Reproduce and inspect

From a gbrain checkout at `f1c39714` (and a worktree of `8e9cd64d` for the
base):

```bash
bun install --frozen-lockfile
bun scripts/bench-member-access.ts --pages 5000 --queries 60 --shares 0 --json
bun scripts/bench-member-access.ts --pages 5000 --queries 60 --shares 0.2,0.8 --json
```

The train M re-measure ran the same two commands from a gbrain checkout at
`244f30dd` and a worktree of master `922ba1a9` (with the train's bench script
copied in), alternating which build ran first each round.

Raw per-run JSON is in [`2026-10-28-member-read-access/`](2026-10-28-member-read-access/):
`gate/` holds the 8+8 runs and the restricted run, and `ablation/` the
variant runs. `train-m-balanced/` holds the 10+10 alternated train M runs and
its restricted run (round `i` ran master first when `i` is odd), and
`train-m-attribution/` the 6-round master, A1, A2 and train runs. The ablation's `branch` runs are from an earlier head that
already tested only `page_readers`, but the bench there still created a member
(so the full predicate ran); `xpred` and `xidx` are the variants in the table
above. One further variant (column dropped) failed to run and is omitted. A
standard-16 run of 16 interleaved bench runs takes about 26 minutes.

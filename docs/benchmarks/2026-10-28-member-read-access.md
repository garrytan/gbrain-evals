# Per-member read access: search cost on a brain with no restrictions

Published 2026-10-28. Measured 2026-10-28 on a Ubicloud standard-16 VM with
gbrain's `scripts/bench-member-access.ts`. The build is gbrain PR #7812
(per-member read access, part A1) at head `f1c39714`, compared with its parent
`8e9cd64d` (#7593). Cost: about four VM-hours, no model spend.

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

## Limits

- PGLite on one 16-vCPU VM. Postgres behind a network adds round trips that
  dwarf these differences, but it was not measured here.
- The corpus is synthetic and contains notes only.
- Restricted cells are a single run.

## Reproduce and inspect

From a gbrain checkout at `f1c39714` (and a worktree of `8e9cd64d` for the
base):

```bash
bun install --frozen-lockfile
bun scripts/bench-member-access.ts --pages 5000 --queries 60 --shares 0 --json
bun scripts/bench-member-access.ts --pages 5000 --queries 60 --shares 0.2,0.8 --json
```

Raw per-run JSON is in [`2026-10-28-member-read-access/`](2026-10-28-member-read-access/):
`gate/` holds the 8+8 runs and the restricted run, and `ablation/` the
variant runs. The ablation's `branch` runs are from an earlier head that
already tested only `page_readers`, but the bench there still created a member
(so the full predicate ran); `xpred` and `xidx` are the variants in the table
above. One further variant (column dropped) failed to run and is omitted. A
standard-16 run of 16 interleaved bench runs takes about 26 minutes.

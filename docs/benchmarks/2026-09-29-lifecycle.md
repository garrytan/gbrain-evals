# Memory lifecycle: what survives edits, forgetting and restarts, across four gbrain builds

Published 2026-09-29. Measured on 2026-09-29 with the hermetic lifecycle
experiment (`eval/runner/lifecycle-experiment.ts`, gbrain-evals commit
`8eafc20`). Cost: $0.

GBrain is a Markdown-first memory system for agents: notes stay as files, and
a database index serves search, links, timelines and remembered facts. A memory
system is only useful if the index keeps telling the truth after the files and
the facts change. This experiment follows one small vault through a full life
(ingest, query, an ingest during an embedding outage, corrections, a full
reconcile, a forget, a restart) and scores what an agent can read at each step
against a ledger the evaluator wrote itself. It never asks gbrain whether
gbrain is right: no `doctor`, `integrity` or invariant check is used as the
answer key.

## The finding

**The fix wave removed five of the failures this experiment can see, and no
measured behavior got worse. Four failures remain on the best build:** a slug
collision stops its vault's sync, a rename loses the page's inbound links, old
slugs stop resolving after a move or rename, and with a live PGLite server most
links are never extracted. We
compared four builds in 24 cells (4 builds x 2 engines x 3 interfaces) and ran
the whole matrix twice. The two runs agreed on every headline number; the
only differences were two timing-dependent counts, described below.

| Contract (cells per build: 6) | a: v0.59.3.0 | b0: v0.59.11.0 | b: master v0.59.13.0 | c: master + #5666 |
|---|---|---|---|---|
| Acknowledged writes lost by the end | 1 in 6/6 cells | 1 in 6/6 | 1 in 6/6 | **0 in 6/6** |
| Forgetting alice's "Prefers email" also expired bob's identical claim | 6/6 cells | 6/6 | 6/6 | **0/6** |
| The same claim could not be remembered again for a third person | 6/6 cells | 6/6 | 6/6 | **0/6** |
| Pages unsearchable right after one forget (local CLI) | 17 of 19 | **0 of 19** | 0 of 19 | 0 of 19 |
| A fact for a person with no page ("Exa Chen") attached to "Exa Cheng" | 6/6 cells | **0/6** | 0/6 | 0/6 |
| A remote caller read a private page's tags (`get_tags`) | 4/4 remote cells | 4/4 | **0/4** | 0/4 |
| Two notes sharing one frontmatter `id` (with a bystander note) | sync blocked, 1 of 3 files | **3 of 3** | 3 of 3 | 3 of 3 |
| Two files that map to one slug (with a bystander note) | sync blocked, 1 of 3 | blocked, 1 of 3 | blocked, 1 of 3 | blocked, 1 of 3 |
| A renamed page keeps its inbound link | 0/6 cells | 0/6 | 0/6 | 0/6 |
| The old slug of a moved or renamed page still finds it | 0 of 2 | 0 of 2 | 0 of 2 | 0 of 2 |

Bold marks the first build where a row changed. The one acknowledged write that
builds a, b0 and b lose is bob's fact, taken out by the forget aimed at alice.

What did not fail on any build, in any cell: a moved file that carries a
frontmatter `id` kept exactly one live page; a removed wikilink left no stale edge (no cell reported an edge the ledger
does not contain); a corrected timeline bullet left no stale
row (timeline precision and recall 4/4 locally, 3/3 remotely); a forgotten fact
stayed forgotten after a full re-import and a restart (residue 0); an ingest
during an embedding outage kept all 3 of 3 notes' text, and all 3 were embedded
and searchable after recovery; no remote probe showed a private page's text or
named it in a result, apart from the `get_tags` row above.

These results are from a fresh `gbrain init` brain, which uses gbrain's managed
write path. The September 28 audit reproduced several failures (a moved page
deleted on full sync, stale edges, stale timeline rows) on the library write
path without that coordinator. They did not appear here even on build a, so this
experiment cannot credit #5668 for fixing them. It also means the library path
still needs its own lifecycle run.

## The concrete case

The vault is invented. It holds people (`alice-example`, `bob-example`,
`carol-example`, `erin-example`), companies (`acme-example`, `acme-robotics`)
and notes that link them. Every file carries a unique marker word per version,
for example `cnrycarol1v2`, so the evaluator identifies a page by the marker in
its stored text rather than by the slug gbrain chose.

The correction commit does what people do to real vaults:

- moves `inbox/standup.md` to `meetings/standup.md` (it carries `id: lc-standup-0001`);
- renames `people/erin-example.md` to `people/erin-example-2.md`, while
  `notes/b.md` still links `[[people/erin-example]]`;
- removes the `[[people/bob-example]]` link from `notes/a.md`;
- corrects carol's bullet `2024-03-01 | Joined Acme Example as CTO` to
  `2024-04-01 | Joined Acme Example as VP Engineering`;
- deletes `notes/obsolete.md`.

The agent then remembers "Prefers email" for alice and for bob, forgets
alice's, and remembers "Prefers email" for frank. The right outcome is that
only alice's fact goes away. On builds a, b0 and b, bob's fact expired too and
frank's write was refused with "The write did not commit". On build c both
survive.

## The experiment

**Sequence.** Each cell runs the same script:

1. Ingest: commit the vault, `gbrain sync`, remember four facts, then query.
2. Outage: add three notes and sync while the embedding provider answers
   every request with HTTP 503.
3. Correct: commit the moves, rename, removed link, corrected bullet and
   deletion; sync.
4. Reconcile: `gbrain sync --full`, `gbrain extract --stale`, `gbrain embed --stale`.
5. Forget: forget alice's fact, remember frank's.
6. Restart: commit the working tree, `gbrain sync --full` (a re-import), restart
   the MCP server (a new harness session), query again.

The evaluator scores what the caller can read after steps 1, 2, 3, 4, 5 and 6.

**Ground truth.** `eval/runner/lifecycle/scenario.ts` is the ledger: the files,
the links the author meant, the timeline bullets, and the facts. A link counts
by author intent, so `[[people/erin-example]]` still means erin after the
rename. Two title links to pages that do not exist (`[[Exa Chen]]`,
`[[Acme Robotic Arms]]`) should create no edge; two exact title links
(`[[Exa Cheng]]`, `[[Acme Robotics]]`) are their presence control.

**Hazard vaults.** A slug collision (`notes/Foo Bar.md` and `notes/foo-bar.md`)
and two notes sharing a frontmatter `id` each live in their own vault, with a
bystander note that sorts after the pair. A hazard that stops a sync then shows
how much else it takes down, without hiding the other measurements. The
hazard vaults are read by the local observer only.

**Builds.** Each build is a plain copy extracted with `git archive`, with its
own `bun install --frozen-lockfile`, run by absolute path as a separate
process. The audit found that Bun resolves symlinked overlays back to the pinned
dependency, so the runner refuses a build unless its copied files hash to the
requested commit's tree, no symlink exists under `src/`, and `gbrain --version`
prints the copy's `VERSION`. All four builds passed.

| Label | Commit | What it is |
|---|---|---|
| a | [`6bb88d1`](https://github.com/garrytan/gbrain/tree/6bb88d128d70fef364444ec71f449f5a2cbd45ee) | v0.59.3.0, before the fix wave |
| b0 | [`2ede415`](https://github.com/garrytan/gbrain/tree/2ede415d74d50a98f836f451d0ab8fedc2ba0708) | v0.59.11.0: #5658 and #5668 merged |
| b | [`b80cad6`](https://github.com/garrytan/gbrain/tree/b80cad61e4725e62531439c027053387c98e23f8) | v0.59.13.0, master on 2026-09-29 (#5676 merged at 02:29 UTC) |
| c | `a27cf36` (tree `18ae08d`) | b plus unmerged #5666 (head `e4fc576`), merged for evaluation only |

The plan asked for "master plus #5666 and #5676". #5676 merged into master
before the run, so c is master plus #5666, and b0 keeps the pre-#5676 master
as its own row. Build c's merge had conflicts only in version stamps,
changelogs, plugin manifests and a lint-limit file; the runner resolved those
to master's side and refuses any conflict under `src/`. The merge is recreated
deterministically by `lifecycle/builds.ts` (fixed author and dates).

**Engines and interfaces.** PGLite and Postgres 16 with pgvector (Docker
`pgvector/pgvector:pg16`). Each engine runs three interfaces:

- local CLI: `gbrain call`, a trusted caller;
- MCP stdio: `gbrain serve`, an untrusted agent caller;
- MCP HTTP: `gbrain serve --http`, with an OAuth `client_credentials` client
  registered for the vault source.

The host maintenance steps (`sync`, `extract`, `embed`) always run through the
local CLI, as a person or scheduler would. The remote interfaces carry the
agent's reads and its remember and forget calls.

**Embedding provider.** A local OpenAI-compatible server returns hashed
bag-of-words vectors (64 dimensions) through gbrain's LiteLLM recipe. It proves
text reached the provider and came back as vectors. It says nothing about real
search quality. The runner removes `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and
`VOYAGE_API_KEY` from every child process; the operator logs show no provider
call.

**Metrics, each with its denominator.**

- *Acknowledged writes lost:* a file whose sync exited 0, or a fact whose
  `remember` returned `inserted`, that the caller can no longer read (bob's
  fact counts here on a, b0 and b).
- *File-to-page violations:* over the files the caller should see (25 locally,
  including 6 in hazard vaults; 18 remotely), a file with no live page holding
  its current marker (lost), only an old marker (stale), more than one page
  (duplicate), or a live page for a file that no longer exists (orphan).
- *Edge and timeline precision and recall* against the ledger (9 expected edges
  locally, 8 remotely; 4 and 3 timeline rows).
- *Wrong-entity attributions:* a near-name edge, or the "Exa Chen" fact landing on
  "Exa Cheng".
- *Withdrawal:* residue (the forgotten fact still active), collateral (another
  fact lost), a refused re-remember, and pages that stop matching their own
  marker in search right after the forget.
- *Remote leaks:* 17 probes across `get_page`, `get_tags`, `get_timeline`,
  `get_chunks`, `get_versions`, `get_backlinks`, `search`, `query`, `recall`,
  `list_pages`, `get_links`, `traverse_graph` and `resolve_slugs`. A content
  leak is the private page's own marker words in a response. An existence
  disclosure is a result row whose slug field names the private page. Each
  probe repeats against a public twin page of the same shape; a probe whose
  twin comes back empty is counted as "no signal", never as "no leak".
- *Recovery:* notes written during the outage whose text was readable during
  it, whose chunks the provider later embedded (the evaluator's own log of
  successful embedding inputs), and that search found after recovery.

## Results in detail

The full tables for all 24 cells are in
[summary.md](2026-09-29-lifecycle/summary.md), generated from the receipts by
`eval/runner/lifecycle-report.ts`.

**Withdrawal (N5).** Every forget call succeeded, and the forgotten fact never
came back, even after a full re-import and a restart (residue 0 in all 48
cell-runs). The collateral damage is the problem. On a, b0 and b, forgetting
alice's "Prefers email" expired bob's identical claim and then refused
"Prefers email" for frank, in all 18 cells of those builds. Build c removed only
alice's fact and accepted frank's in all 6 cells. On build a, one forget also
made 17 of 19 pages stop matching their own marker in local search. Remote
counts ranged from 6 to 12 of 18 pages and changed between the two runs, because the
pages come back as a background rebuild finishes; all were searchable again by
the restart checkpoint. From b0 on, no page dropped out.

**Access (N6).** On a and b0, a remote caller asking `get_tags` for the private
page received its tag (`["cnrydavetag1"]`) in all 4 remote cells. From b on
(#5676 filters private and deleted pages in `getTags`), none did. No other
probe leaked content or named the private page on any build. Coverage has
gaps. On PGLite, 12 of 17 probes had a working control; on Postgres, 15 of 17.
`get_versions` and the tag search returned nothing for the public twin either,
and on PGLite the link probes had no links to show (see below).

**Vault churn (N14).** The frontmatter-`id` move, the removed link, the
corrected bullet and the deletion all behaved correctly on every build, with 0
file-to-page violations in the main vault at every checkpoint. The failures
are in the hazard vaults and the rename:

- *Shared frontmatter id.* On a, gbrain accepted the first note and then stopped
  the sync with `revision_conflict` on `notes/template-b`; the bystander was
  never imported (1 of 3 files). From b0 on, all 3 imported.
- *Slug collision.* On every build, the sync imported `notes/Foo Bar.md`, then
  stopped with `revision_conflict: A page changed after this sync cursor was
  enumerated` on `notes/foo-bar.md`, and never imported the bystander (1 of 3).
  Later full syncs failed with `page_identity_changed`. The #5668 collision rule
  (the file named like the slug owns it) is not reached on this path.
- *Rename.* After `erin-example.md` became `erin-example-2.md`, the untouched
  `notes/b.md` lost its link to erin on every build, and `get_page` on the old
  slug found nothing. The moved standup note also could not be reached by its
  old slug, though its outgoing link survived.

**Links through a live PGLite server.** With `gbrain serve` holding a PGLite
brain, the host's syncs are delegated to the server. The remote caller then saw
0 or 1 of 8 expected edges (the one edge, `notes/a` to `acme-example`, appeared
in some runs and not others), against 5 of 8 on Postgres and 6 of 9 for the local
CLI on either engine. The documented catch-up, `gbrain extract --stale`, was
refused in every one of the 240 attempts (5 per cell-run x 48 cell-runs). On PGLite with
a live server it reports that the database is already open. Everywhere else,
the managed writer guard rejects it with `writer_coordinator_required`.

**Title links.** No build resolved `[[Exa Cheng]]` or `[[Acme Robotics]]` to
their existing pages. The near-name edge test therefore has no working
presence control: zero wrong near-name edges shows only that title links do not
resolve at all. Near-name fact attribution does have signal: alice's and bob's
facts landed on their own pages in every cell.

**Outage recovery.** Syncs during the outage exited 0 and kept the text of all
3 notes on every build. On PGLite with a live server, `gbrain embed --stale`
was refused, but the server drained the deferred embeddings itself. In every
cell, the provider log shows all 3 notes embedded after the outage, and search
found all 3.

**Repeatability.** The published matrix ran twice. The generated cell
summaries matched in 21 of 24 cells. Two differences were build a's remote
"pages unsearchable after forget" count (the background rebuild above), and one
was the single delegated-sync edge on `b/pglite/mcp-stdio` (1 of 8 in one run,
0 of 8 in the other). Two earlier full runs of the same scenario, not published
(see Limits), gave the same results; across all four runs, 19 of 24 cell
summaries matched exactly, and every difference was in one of those two
fields.

## What to use and what to avoid

- If you use `forget` on entity facts, run a build with #5666. Before it, one
  forget removes the same claim from every entity in the source and blocks it
  from being remembered again.
- Keep file names that slugify to the same slug out of a synced vault. On every
  build tested, one such pair stops the whole source from importing past it,
  and the sync reports it only as a failed run.
- After renaming a person or company file, check the notes that link to it. The
  link and the old slug stop working on every build tested.
- On PGLite with an MCP server running, expect relationship data from
  delegated syncs to be mostly missing. Postgres, or syncing while no server
  holds the database, gave full link extraction for the links that resolve.
- The private-page, outage and correction behavior measured here was sound on
  master: text survives an embedding outage, and corrections replace stale
  links and timeline rows.

## Limits

- One small vault (25 files) and a scripted sequence. Zero violations here is a
  regression result for these cases, not a reliability rate.
- One configuration: a fresh `gbrain init` brain on the managed write path. The
  library write path used by the audit is not covered.
- Not covered yet (plan amendment 8): kill-9 interruption between steps,
  duplicate delivery, concurrent edit/sync/forget, stale checkpoint replay,
  migration and backup/restore, grant revocation, and same-slug data across
  sources.
- The hash embedder is a control. Search results here show that text and
  vectors were stored, not that retrieval is good.
- Three earlier full runs on the same day are not published. The first ran
  before a harness fix: its observer listed only the default source, so every
  hazard-vault file looked lost, and it had no old-slug probe. The next two
  produced the same cell summaries as the published runs, apart from the two
  timing-dependent fields, but recorded the local Docker database password in
  the operator arguments. They were rerun after the harness learned to redact
  it, rather than editing receipts by hand. No number in this report comes from
  those runs.

## Reproduce and inspect

```sh
docker run -d --name lc-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 pgvector/pgvector:pg16
git clone https://github.com/garrytan/gbrain.git ../gbrain
git -C ../gbrain fetch origin capy/v05970-fixmemory-subject-scoped:refs/remotes/origin/capy/v05970-fixmemory-subject-scoped
bun eval/runner/lifecycle-experiment.ts --gbrain-repo ../gbrain --concurrency 4 \
  --out eval/reports/lifecycle/receipt.json
bun eval/runner/lifecycle-report.ts eval/reports/lifecycle/receipt.json
```

No API keys are needed, and the runner removes them from child processes. One
full matrix took about 30 minutes on a 4-vCPU machine: 466 to 852 seconds per
local-CLI cell (every read is a new process) and 62 to 81 seconds per MCP cell.
Scratch brains, vaults and full operator logs go under
`eval/reports/lifecycle/<timestamp>/`.

Artifacts in [`2026-09-29-lifecycle/`](2026-09-29-lifecycle/):

- `primary/receipt.json`: the primary run. It holds every cell's operator
  steps, exit codes, raw snapshots (pages, links, timeline rows, facts, search
  and old-slug probes), leak probes with evidence excerpts, scores, and the
  build identities.
- `repeat/receipt.json`: the repeat run.
- `summary.md`: the generated tables and the repeat comparison.
- `executed-sources.sha256`: hashes of the harness files as executed. They match
  commit `8eafc20`.

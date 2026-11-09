# G6: gold out of view, by cause

This measure counts how much of a task's gold evidence a caller can't reach in gbrain, and why. A trusted local caller (the `gbrain` CLI) reads every page. A remote caller (an MCP client with no private-pages grant) does not get pages that gbrain treats as private. When an agent works through a remote connection, those pages are out of its view, and the right behavior is to say so and abstain rather than answer from the pages it can see.

The measure counts hides. It does not judge whether a hide is right: that decision belongs to the brain's owner and to gbrain's maintainers. Every hide lands under the shared cause `privacy_hidden` (`eval/runner/predictive/causes.ts`), split into three sub-causes.

It is part of GBEV-55 (rank 10 in the gap map, with rank 8's cross-source joins as its agent layer). The world, the reachability report and the scorer are keyless; the agent layer (`agent.ts`) has a keyless fake mode and a paid mode through `eval/runner/predictive/run.ts g6`. Everything uses fictional data.

## What gbrain 0.60.557.0 hides from a remote caller

These rules come from `src/core/search/private-visibility.ts` in the pinned gbrain. The generator makes one page variant for each.

| Sub-cause | Variant | Frontmatter on the gold page |
|---|---|---|
| `direct_flag` | `visibility_private` | `visibility: private` |
| `alias_inheritance` | `access_alias` | `access: private`, `restricted` or `confidential`, with no `visibility` |
| `alias_inheritance` | `confidentiality_alias` | `confidentiality: confidential`, `secret`, `private` or `restricted`, with no `visibility` |
| `alias_inheritance` | `declared_lineage` | `derived_from` naming a page that is explicitly `visibility: private` |
| `derived_default` | `atom` | `type: atom` with no `visibility` |
| `derived_default` | `synthesized_concept` | `type: concept` and `synthesized_by`, with no `visibility` |
| `derived_default` | `atom_of_private_origin` | `type: atom`, `visibility: world`, `source_slug` naming a private page |

Two limits of the pinned rules shape the world. Declared lineage passes on only an explicit `visibility: private`, so a page derived from an alias-private page stays in view. An event page (`type: event`) is not one of the derived-by-default page types (atom, question, synthesized concept), so in our probe an event page with a private origin stayed in a remote caller's view at page level. The world has no event variant for that reason.

## How it works

1. `gen.ts` builds a seeded world. Each fictional project has two gold pages from two channels (CRM record, meeting notes, email thread, team chat), each holding one fact, plus a decoy sibling project with other values. Knobs set the share of gold pages per sub-cause, in exact counts. The defaults (50 projects, so 100 gold pages; 20% direct flag, 15% alias, 15% derived) are round design values. They are set independently of any measured freeze (gate change D1) and must never be tuned to one.
2. `reach.ts` imports every page through gbrain's own `importFromContent` into an in-memory PGLite brain, with the live-recall fixture's keyless hash embeddings and token-overlap reranker. For each gold page it calls gbrain's `get_page` and `search` operations through the MCP dispatch layer, once as a local caller (`remote: false`) and once as a remote caller (`remote: true`, stdio, no grant). `get_page` decides reachability. `search` for the page's own fact value is reported beside it.
3. `tasks.ts` writes one cross-source task per project. A task needs both facts, so it needs both gold pages. For each caller, the task records which of its gold pages that caller can't reach, using the observed reachability.

## Report: reach.json

| Field | Meaning |
|---|---|
| `schema` | `gbrain-evals/predictive-out-of-view/reach/v1` |
| `seed`, `knobs`, `world_digest` | The world's identity; the digest is sha256 over the canonical page list |
| `gbrain_version` | The gbrain version actually loaded |
| `cause` | `privacy_hidden` |
| `surfaces` | `get_page` decides reachability; `search` is also reported |
| `by_caller.<local or remote>.gold` | Gold pages probed |
| `.reachable`, `.out_of_view` | Gold the caller got, and gold it did not get, through `get_page` |
| `.found_by_search` | Gold that keyword search for its fact value returned to this caller |
| `.by_subcause` | Out-of-view gold by intended sub-cause: `direct_flag`, `alias_inheritance`, `derived_default` |
| `unexpected`, `unexpected_rows` | Gold whose observed reachability differs from its intended view: a marked page a remote caller still gets, an unmarked page it does not get, or any gold the local caller misses. Counted, not judged |
| `pages` | Per gold page: slug, intended view, variant, and `get_page` and `search` results per caller |
| `tasks_digest` | sha256 of the task list written beside it |

An out-of-view page with no privacy marker counts in `out_of_view` and `unexpected` but in no sub-cause, so `by_subcause` can sum to less than `out_of_view`.

## Tasks: tasks.jsonl

Each line has `id`, `question`, `sources` (the two channels), `gold` (two slugs), `out_of_view` (per caller, the gold slugs it can't reach) and `decoy` (the sibling project's page).

The final answer has one fixed schema (gate change G1): `{ "answered": boolean, "abstained": boolean, "citations": string[] }`, with page slugs as citations. An answer with any other shape is an invalid row (`parseAnswer` returns null) and is never sent to a judge. The keyed scorer gives one verdict per task and caller:

- `correct`: every gold page is in view, and the answer cites every gold page and nothing else.
- `abstained_correctly`: some gold is out of view, and the answer abstains without answering.
- `answered_without_gold`: some gold is out of view, and the answer answers anyway.
- `wrong`: anything else, such as abstaining when all gold was in view or a missing or extra citation.

The scorer passes the mutation kit (`eval/runner/mutation-kit.ts`): it fails a system that answers nothing, one that cites every page, one that always abstains, one that answers as if no page had gone private, and one that cites the decoy project.

## Agent layer: agent.ts

Each G6 episode builds the world into a fresh brain, importing the pages as Markdown files so their privacy frontmatter is kept exactly, and gives the agent the tool list of `gbrain serve --access read-only`. The remote caller reaches those tools through the MCP server (`remote: true`, no grant), the identity `reach.ts` probes with. The local caller gets the same tool list, dispatched through `gbrain call` (`remote: false`). Before the agent starts, the episode probes each of the task's gold pages with `get_page` as that caller, so the task's `out_of_view` comes from observed reachability. The agent ends by calling `submit_answer` with the fixed schema, and `tasks.ts` scores it. The scorecard counts verdicts by caller and by the privacy sub-cause of the hidden gold, plus answers given without the gold. [The runner's README](../README.md) covers the fake, smoke and counted modes.

## Reproduce

```
bun eval/runner/predictive/out-of-view/run.ts --seed 7 --out eval/reports/out-of-view
bun test test/eval/predictive-out-of-view.test.ts
```

Optional flags: `--entities`, `--direct-share`, `--alias-share`, `--derived-share` and `--gbrain <checkout>[@ref]`. The runner needs no key, runs inside `withHermeticEnv` and refuses `--paid`. The default world (164 pages) takes about 11 seconds on a Capy cloud machine. At gbrain 0.60.557.0 with seed 7 it reports the local caller with 100 of 100 gold pages in view, the remote caller with 50 of 100 (20 direct flag, 15 alias inheritance, 15 derived default out of view), and 0 unexpected.

## Changelog

### 2026-11-09: agent layer
Added `agent.ts`, which runs the tasks with an agent as a local and a remote caller and scores them; the README no longer says the agent loop is not wired.

### 2026-11-09: first version
Added the world generator, the reachability report, the cross-source tasks and the keyed scorer for GBEV-55.

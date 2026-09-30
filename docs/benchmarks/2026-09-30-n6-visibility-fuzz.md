# N6 visibility and access leak fuzz: 24 of 25 content-reachable read ops held; the entity card leaks private backlinks

Date: 2026-09-30. Category `visibility-leak-fuzz` (legacy alias N6), report-only. gbrain 0.60.10.0 (the pinned dependency, 608a174), 0.60.11.0 (master, f8d1e39, loaded as a copied overlay) and the `capy/evidence-delivery` branch head (c0a72ab, copied overlay). All three produced identical numbers.

## The finding

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents: notes are Markdown pages, and a database index serves search, facts, timelines and relationships. Agents reach it through MCP (stdio or HTTP) or as subagents, and gbrain promises that such callers never read what the brain marks as not theirs: pages marked `visibility: private`, Takes rows held by a named person, private Facts rows, derived atoms (private by default), and sources outside the caller's grant.

This category tests that promise on every read operation gbrain exposes. It reads the operation list at run time (73 read ops at 0.60.11.0), calls each one as six agent-facing callers scoped to one source, and checks every response against a ledger of protected markers written by the generator.

The trust boundary held almost everywhere. Across 3,158 probes that reached an op, no protected text, slug or foreign-source row came back from 24 of the 25 read ops that return protected content to the trusted owner, and no access gate let a read-only client call a write or admin op (60 scope gates, 30 local-only gates).

One bug leaks: **the `entity` card, and `context_pack` built on it, list inbound links from private pages to remote callers, with the private page's slug and the linking sentence from its body.** It reproduces on the pin, on master and on the evidence-delivery branch. Those 8 probes (2 ops x 4 MCP callers; subagents cannot call these ops) are the whole failure. No existence oracle was found: for every targeted probe, the response to a protected target matched the response to a target that was never written.

Verdict: `fail` (the target is zero leaks). The category is report-only, so this is information, not a CI failure.

The evidence-expansion paths are not measured yet: the evidence-delivery branch carries `docs/evidence-delivery.md` but no `return_unit` parameter or `assemble_evidence` op at c0a72ab. The receipt records them as documented but missing, and N6 will fuzz them automatically when they land (see "Reproduce").

## Update, 2026-09-30: zero leaks at the new pin (`6c8373c`, v0.60.13.0)

gbrain v0.60.13.0 ([#5769](https://github.com/garrytan/gbrain/pull/5769)) merges the evidence-delivery code and fixes the `entity` / `context_pack` private-backlink leak. Re-run at the new pinned dependency, gbrain master `6c8373c`, on a clean gbrain-evals tree (commit `2880304`): **0 content leaks, 0 existence leaks, 0 existence oracles and 0 of 90 access gates bypassed**, over 3,854 exposed probes (1,546 with signal) and 74 read ops. All 26 read ops that return protected content to the trusted owner held, including `entity` and `context_pack`, whose 8 leaking probes at `608a174`, `f8d1e39` and `732ee81` are now clean. Every `return_unit` value on `search`, `query`, `recall` and `assemble_evidence` was fuzzed and none leaked; the stage expanded on 30 of 36 probes per expanding unit on `search` and `query`, 20 of 24 on `recall` and every non-chunk `assemble_evidence` probe. The verdict is `pass`, so the category becomes a gate: `visibility-leak-fuzz` has `gate: 'gate'` in `eval/registry.ts`, and any leak fails `all.ts --tier offline`. Receipt: [receipt-pin-6c8373c.json](2026-09-30-n6-visibility-fuzz/receipt-pin-6c8373c.json).

## Update, 2026-09-30: the evidence-expansion code (`capy/evidence-delivery` at 732ee81)

The expansion stage landed on the gbrain branch at `732ee81` (0.60.13.0): `return_unit` and `return_window` on `search`, `query` and `recall`, and the new read op `assemble_evidence`. N6 ran against it as a copied overlay (clean checkout; gbrain-evals commit `7635759`, clean tree). **No expansion path leaked.** The only findings are the same 8 `entity` / `context_pack` probes as before (bug 1), which the branch does not touch.

N6 picked the new surface up without configuration: `return_unit` is an enum on all four ops, so every probe runs once per unit (`chunk`, `window`, `section`, `page`, `auto`), and `assemble_evidence` gets hit lists that name each protected target (the private note, the atom, the beta-only page) and each public twin. Every response, including the twin and ghost responses, is scanned for protected markers.

Two presence controls were added for expansion, because the usual local-replay control cannot see fenced rows: sealed chunks keep held Takes and private Facts out for every caller, the owner included.

- **applied**: the response carries a `delivered` block whose unit is `window`, `section` or `page`, so the stage actually expanded rather than falling back to the chunk.
- **fence span reached**: the twin response carries both the person page's first sentence (written above the Takes fence) and its public Facts row (inside the Facts fence), so the delivered text spans the rows the protected Take and Fact were stripped from. A leak would put the protected row right there.

| Unit (search + query + recall + assemble_evidence) | Probes | Signal | Expanded | Fence probes | Fence span reached | Leaks |
|---|---|---|---|---|---|---|
| `chunk` | 120 | 72 | 0 | 40 | 20 | 0 |
| `window` | 120 | 72 | 104 | 40 | 24 | 0 |
| `section` | 120 | 72 | 104 | 40 | 24 | 0 |
| `page` | 120 | 72 | 104 | 40 | 24 | 0 |
| `auto` | 120 | 72 | 104 | 40 | 24 | 0 |
| `assemble_evidence`, unit from config | 96 | 32 | 96 | 32 | 32 | 0 |

The 16 non-expanded probes per unit are all the held-Take target: a search for a held Take's text finds nothing, because Takes are not indexed, so there is nothing to expand. The fence span is reached on every fence probe that has a hit. Takes-twin searches find nothing for the same reason, which is why the search, query and recall rows reach it on half their fence probes. `assemble_evidence` is exposed to the four MCP callers; it is not on the subagent allow-list.

Whole run at 732ee81: 74 read ops (one new), 26 covered (every content-reachable op, now including `assemble_evidence`), 3,854 exposed probes, 1,546 with signal, 8 leaking (bug 1 only), 0 existence oracles, 0 of 90 access gates bypassed, 0 sealed-chunk violations. Receipt: [receipt-evidence-delivery-732ee81.json](2026-09-30-n6-visibility-fuzz/receipt-evidence-delivery-732ee81.json). Per-op, per-unit counts are in `data.expansion_paths.per_unit`; `data.expansion_paths.not_applied` lists each probe that requested an expanded unit and got none.

Reproduce: `bun eval/runner/n6-visibility-fuzz.ts --gbrain ../gbrain@732ee8116b6fd7d2de38824a54d35f57e4ea35c4`.

## The concrete case

Invented placeholders throughout. The world holds a public hub page `notes/hub-suxuq` and a private note that links to it:

```markdown
---
title: Note zxkapewezeteq
type: note
visibility: private
---
Planning memo zxkapewezeteq for the offsite. See [[notes/hub-suxuq]].
```

A remote caller asks for the private note with `get_page` and correctly gets `page_not_found`. The same caller then asks for the public hub with `entity` (`{"name": "notes/hub-suxuq"}`) and receives, inside `card.edges`:

```json
{ "type": "mentions", "direction": "in", "slug": "notes/guwahusoq",
  "context": "Revised once. Planning memo zxkapewezeteq for the offsite. See [[notes/hub-suxuq]]. ..." }
```

So the caller learns that the private page exists, its slug, and the sentence it wrote. `context_pack` with `entities: "notes/hub-suxuq"` returns the same edge.

## The experiment and results

**World.** `eval/generators/n6-visibility-gen.ts` writes a seeded ledger (default seed 20260930, ledger sha256 in each receipt). Every protected item has a public twin of the same shape and a ghost that was never written:

| Class | Protected | Public twin |
|---|---|---|
| `private_page` | a `visibility: private` note with a body marker, a tag marker and a timeline marker, linking to the hub | the same note without `visibility: private` |
| `private_take` | a Takes row held by a named holder on a public person page | a `world` Takes row on the same page |
| `private_fact` | a `private` Facts row on the same person page | a `world` Facts row |
| `derived_atom` | an `atom` page with no visibility field (derived pages default to private) | a hand-written concept page |
| `foreign_source` | a page in ungranted source `beta` at the same slug as an `alpha` page, and a beta-only page | the `alpha` page |

Pages are written twice through the `put_page` operation as the trusted local caller, so links, tags, timeline rows, Takes, Facts and version history are produced by gbrain's own write path.

**Gold.** Every protected marker and slug comes from the ledger. What a caller may see comes from the visibility rules gbrain documents (`src/core/search/private-visibility.ts`, `resolveRequestedScope`, the default `['world']` holder allow-list): each remote caller here is scoped to `alpha`, so every protected marker is forbidden to it. Nothing about what is protected is learned from gbrain output.

**Callers.**

| Caller | How it is called |
|---|---|
| `local` | `dispatchToolCall` with `remote: false`; used only as a positive control |
| `stdio` | `dispatchToolCall` with the options the stdio MCP server passes (`transport: 'stdio'`, holder list `['world']`), scoped to `alpha` as `GBRAIN_SOURCE=alpha` would scope it |
| `http-read`, `http-write` | serve-http's `tools/call` path replayed in process: `operationScopesAllowed`, then `dispatchToolCall` with the OAuth client's auth, source grant and holder list |
| `http-bound` | an `http-write` client with a slug-prefix binding |
| `subagent-remote`, `subagent-local` | `buildBrainTools` for a remote-owned and a local subagent job; only the subagent allow-list's ops are reachable |

**Probes.** For each read op, each class (plus the hub and a no-target listing), each variant (the base call, every enum value, and `source_id: beta` / `__all__` overrides where the op takes `source_id`), and each remote caller, the runner makes three calls with the same shape: aimed at the protected target, at its public twin and at its ghost. Arguments are synthesized from the op's declared parameters; widening flags such as `include_private`, `include_deleted` and `all_sources` are set to `true`.

A probe **leaks** when any of the three responses carries a protected marker (after crediting echoes of the probe's own arguments, measured on the ghost call), when a result field names a protected slug the probe did not ask for, or when a row carries `source_id: beta`. It is an **existence oracle** when the protected and ghost responses differ once target values and volatile fields (ids, timings, revisions) are masked.

**Controls.** A probe counts as signal only if (1) the trusted local caller, given the same arguments, reads protected content, so the probe aims at something real, and (2) the remote caller sees the public twin through the op (source overrides have no twin). A probe without both is "no signal", never "no leak". Presence assertions run before scoring: every ledger page stored in its source, the held Takes row and private Facts row indexed, the private page's timeline and hub link indexed, and the local caller reading every class's markers with `get_page`. A failed assertion makes the run an error. The detectors are checked on the local caller: they fired on 219 of 659 local replays, and 116 of 515 local protected/ghost pairs differed, so both detectors see content when it is there.

**Access gates.** An `http-read` client must be refused every op whose scope is not `read` (60 ops: 46 called with empty arguments, 14 evaluated through `operationScopesAllowed` directly because a bypass would run a handler without required arguments). The three HTTP callers must be refused every `localOnly` op (30 calls). 27 local-only gates on ops without a required parameter were not called, for the same safety reason.

### Results (identical on 0.60.10.0, 0.60.11.0 and c0a72ab)

| Measure | Value | Denominator |
|---|---|---|
| Probes that leaked protected content | 8 | 3,158 exposed probes |
| Probes that leaked existence (slug or foreign-source row) | 8 (the same 8) | 3,158 |
| Existence oracles | 0 | targeted probes with a ghost |
| Access-gate bypasses | 0 | 90 gates checked |
| Sealed-chunk violations (held Takes or private Facts text in `content_chunks`) | 0 | 2 fence markers |
| Read ops with at least one signal-bearing probe | 25 | 73 read ops |
| Content-reachable read ops covered | 25 | 25 ops that return protected content to the local caller |
| Probes with signal | 1,154 | 3,158 |
| Scored units (probes plus gates), errors | 3,248, 0 | |

Per caller: stdio, http-read, http-write and http-bound each ran 659 exposed probes with 210 signal and 2 leaks; each subagent ran 261 with 157 signal and 0 leaks.

Covered ops: `entity`, `get_page`, `list_pages`, `fetch`, `search`, `query`, `get_tags`, `get_links`, `get_backlinks`, `traverse_graph`, `get_timeline`, `get_versions`, `resolve_slugs`, `get_chunks`, `takes_list`, `takes_search`, `think`, `get_recent_salience`, `chronicle_day`, `chronicle_since`, `chronicle_last_seen`, `recall`, `context_pack`, `delta`, `find_trajectory`. Only `entity` and `context_pack` leaked.

**Uncovered ops (48).** Each is listed with its reason in the receipt's `uncovered_ops`. They fall into three groups:

- The world holds nothing they would return, even to the owner: skills and skillpacks, code intelligence (refused for remote callers without a code grant, and no code is seeded), ontology, open loops, schema packs, contradictions, experts, anomalies, calibration and scorecards (aggregates with no marker to see), sources, identity, ingest log, orphans, extraction queue, `get_raw_data`, `chronicle_on_this_day`, `volunteer_*`, `search_modes`, `whoami`.
- They need a provider: `synthesize` (no LLM configured) and `search_by_image`.
- No synthesis rule for a required argument: `get_skill_asset` (`revision`), `join_brain` (`adapter`), `sync_brain_skills` and `leave_brain` (`installation_id`).

A zero on these ops is "not measured", not "safe".

## gbrain bugs found

### 1. `entity` and `context_pack` expose inbound links from private pages to remote callers

`src/core/verbs/entity-card.ts`, `assembleCard` (lines ~264-285 at f8d1e39). `buildEntityCard` applies the private-page predicate to the card's own page, but the inbound-edge query and the backlink count select `FROM links l JOIN pages f ON f.id = l.from_page_id` with only a source filter. For a remote caller, a `visibility: private` (or derived, private-by-default) page that links to a public entity appears in `card.edges` with `direction: "in"`, its slug, and `links.context`, which holds a sentence of the private page's body. `backlink_count` counts it too. `context_pack` returns the same edges. Expected: for `remote: true` callers without the operator opt-out, filter the from-side with `privatePagesFilterFragment('f')` (and `privateLinkOriginFilterFragment` for derived links), exactly as `get_backlinks` does; `get_backlinks` on the same hub correctly hides the edge. Probes broken: `entity` and `context_pack` on the hub target, as stdio, http-read, http-write and http-bound (8 probes).

Minimal repro (run from a gbrain checkout):

```ts
import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { dispatchToolCall } from './src/mcp/dispatch.ts';

const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const config = { engine: 'pglite' } as any;
const put = (slug: string, content: string) =>
  dispatchToolCall(engine, 'put_page', { slug, content }, { remote: false, sourceId: 'default', config });
await put('notes/hub', '---\ntitle: Hub\ntype: note\n---\nTeam hub.\n');
await put('notes/secret', '---\ntitle: Secret\ntype: note\nvisibility: private\n---\nSECRETMARKER layoff plan. See [[notes/hub]].\n');

const remote = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };
const page = await dispatchToolCall(engine, 'get_page', { slug: 'notes/secret' }, remote);
console.log('get_page(notes/secret) as remote:', page.content[0].text.includes('page_not_found') ? 'page_not_found (correct)' : 'READ');
for (const [op, args] of [['entity', { name: 'notes/hub' }], ['context_pack', { entities: 'notes/hub' }]] as const) {
  const r = await dispatchToolCall(engine, op, args as any, remote);
  const text = r.content[0].text;
  console.log(`${op}(notes/hub) as remote: private slug ${text.includes('notes/secret') ? 'LEAKED' : 'hidden'}, private text ${text.includes('SECRETMARKER') ? 'LEAKED' : 'hidden'}`);
}
await engine.disconnect();
```

Output at f8d1e39:

```
get_page(notes/secret) as remote: page_not_found (correct)
entity(notes/hub) as remote: private slug LEAKED, private text LEAKED
context_pack(notes/hub) as remote: private slug LEAKED, private text LEAKED
```

No other gbrain bug was found by this category.

## What to use and what to avoid

- For agents on MCP or subagents, `get_page`, `search`, `query`, `recall`, `list_pages`, the graph reads, timelines, versions, chunks, Takes reads and the chronicle ops kept private pages, held Takes, private Facts, derived atoms and ungranted sources out, including with `include_private`, `include_deleted`, `all_sources` and `source_id` overrides.
- Until bug 1 is fixed, do not expose `entity` or `context_pack` to remote callers on a brain where private pages link to public ones. `get_backlinks` is a safe substitute for inbound links.
- The replayed serve-http path is the transport's call-time logic in process. It does not exercise the network layer, OAuth token verification or the Postgres engine, and writes by write-scoped callers are not executed. Read ops outside the 25 covered were not measured.
- N6 builds its own harness instead of calling `lifecycle/observe.ts` `probeLeaks`: that function hard-codes 17 calls against the lifecycle scenario world. N6 keeps its design (public-twin presence controls, slug-field existence checks) and applies it to every op. Cat 22 (`source-isolation`) remains the engine-level source-scoping check.

## Reproduce and inspect

```bash
bun eval/runner/n6-visibility-fuzz.ts                                   # pinned gbrain, ~15 s, $0
bun eval/runner/n6-visibility-fuzz.ts --gbrain ../gbrain                # a local checkout at HEAD, as a copied overlay
bun eval/runner/n6-visibility-fuzz.ts --gbrain ../gbrain@origin/capy/evidence-delivery
bun eval/runner/n6-visibility-fuzz.ts --seed 7 --only entity,get_page   # another world, a subset of ops
```

No keys: the runner removes provider keys from its environment and points `GBRAIN_HOME` at a temp directory. `--gbrain` (or `GBRAIN_UNDER_TEST`) extracts the ref with `git archive` into `.gbrain-overlays/`, installs it and verifies the copy (tree hash, no symlinks, CLI version); uncommitted edits in the checkout are not measured and the receipt says whether it was dirty. When the evidence-delivery code lands, rerun the third command: `return_unit` values are fuzzed as enum variants, `assemble_evidence` gets hit lists naming each protected target, and the receipt's `expansion_paths.per_unit` reports them.

Receipts (schema v2, scrubbed; produced by gbrain-evals commit `ce612e2` on a clean tree): [pin](2026-09-30-n6-visibility-fuzz/receipt-pin.json), [master](2026-09-30-n6-visibility-fuzz/receipt-master.json), [evidence-delivery branch](2026-09-30-n6-visibility-fuzz/receipt-evidence-delivery.json). Each holds the per-op table, every finding with evidence, every gate outcome, the presence checks and the uncovered ops with reasons.

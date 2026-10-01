# Unsolicited recall at final delivery (N8, 2026-10-01)

Report-only. This category stays report-only until the associative-recall-v1 labels pass independent human review (wave amendment 8 and the CEO requirement). Nothing here is a README capability claim.

## The finding

gbrain's push-based recall is a precise entity-mention mechanism, and it leaks private pages. On 186 seeded user turns in 52 sessions, run against the pinned gbrain `3a284ae` (v0.60.26.0) through a copied overlay, with provider keys stripped and System One off:

1. **Private pages reach remote callers and the injected block (bugs N8-1 and N8-2).** When a turn names a `visibility: private` person, `volunteer_context` returns that page, title and body synopsis, to a remote (MCP) caller: 4 private deliveries over 8 private-mention turns (the other 4 named a page already delivered in the session), with the private body marker inside the synopsis. Remote `search` for the same name returns nothing. The block `assembleTurnContext` builds for the IPC `turn_context` hook carries the same 4 pages. gbrain excludes private pages from untrusted callers by default everywhere else (`src/core/search/private-visibility.ts`, #4352), and N6's visibility fuzz never saw this because it had no window that names a private page.
2. **When a turn names something in the brain, it surfaces at the default gate.** Proactive recall was 42 of 42 (100%) on alias and exact-title triggers, 12 of 12 on surnames and 0 of 6 on slug-tail mentions, which the documented gate (0.7) excludes by design. False alarms on innocuous and no-mention turns were 0 of 68.
3. **Ordinary words that are aliases fire (feature gap N8-3).** A company aliased "Harbor" is volunteered for "We finally got to the harbor after lunch": 6 of 6 lower-case common-word turns. Matching is lexical. Over all 80 negative turns that is a 7.5% false-alarm rate at every threshold from 0.5 to 0.95, because the alias arm scores 0.9 plus a 0.05 boost.
4. **It does not do associative recall (feature gap N8-4).** On associative-recall-v1, `volunteer_context` delivered nothing for any of the 480 probes: 0 of 240 indirect, 0 of 120 direct, and no false alarm on 120 negatives under either the strict or the adjudicated labels. gbrain does not claim this capability; the result measures the gap, not a failure.

The four delivery contracts frozen before the run:

| Contract (target 0) | Result |
|---|---|
| Private pages delivered to a remote caller | 4 |
| Private pages in the `turn_context` block | 4 |
| Soft-deleted pages delivered (local, remote, `turn_context`) | 0 |
| A page re-volunteered although its slug is in `prior_context` | 0 |

Verdict: `fail` (reported, not gating).

## The concrete case

An invented example. The brain holds `people/kesmi-duskvale`, marked `visibility: private`, whose first sentence names an internal code. A user tells an MCP-connected agent: "Lunch with Kesmi Duskvale went well." The agent calls `volunteer_context` with that window. It gets back the page, its title and the first sentence of the body, code included. If the same agent calls `search` for "Kesmi Duskvale", it gets nothing, because search hides private pages from remote callers. On a local install the `gbrain hook user-prompt` path puts the same page and sentence into the model's context under "Brain pages mentioned this turn", although that block filters its hot facts to `world` for exactly this reason.

## The experiment and results

**Mechanics world.** `eval/generators/n8-proactive-recall-gen.ts` (version `n8-proactive-recall-gen-v1`, seed 8, ledger SHA-256 `bf21d39c97a8cd99f68fde487c0fdfbf51e68e4202146f60dbe197361adad9ef`) writes 38 entity pages with invented names: 12 people with a nickname alias, 6 companies with a short alias, 6 projects reachable by title or by slug tail only, 6 companies whose alias is an ordinary word, 4 private people and 4 soft-deleted people. Its 52 sessions alternate user and assistant turns; no user turn asks the brain for anything. Each user turn is replayed with a four-turn rolling window.

**Gold.** From the ledger only: a trigger turn's target is the entity it introduces; a delivery is allowed if the window mentions the page; any other delivery is a false alarm; a second delivery of a page in one session is redundant. Private and soft-deleted deliveries are counted separately.

**Presence.** All 34 live pages are readable through `get_page`, and all 12 direct alias mentions fire, so a false-alarm rate of 0 is not an empty system.

**Delivery modes (186 user turns: 60 triggers, 80 negatives, 8 private mentions, 8 soft-deleted mentions, 30 repeats).**

| Mode | Recall, alias and title (42) | Recall, all triggers (60) | False alarms, innocuous and no-mention (68) | False alarms, common words (12) | Redundant per session | Private | Tokens per turn, mean (p95) |
|---|---|---|---|---|---|---|---|
| `volunteer_context`, local, `prior_context` passed | 100% | 90% | 0% | 50% | 0 | 4 | 24.6 (73) |
| `volunteer_context`, local, no `prior_context` | 100% | 90% | 8.8% | 100% | 1.87 | 12 | 58.2 (132) |
| `volunteer_context`, remote, `prior_context` passed | 100% | 90% | 0% | 50% | 0 | 4 | 24.6 (73) |
| `turn_context` block (local, in process) | 100% | 100% | 0% | 50% | 0 | 4 | 23.4 (64) |
| Baseline: never inject | 0% | 0% | 0% | 0% | 0 | 0 | 0 |
| Baseline: three random pages | 4.8% | 10% | 100% | 100% | 1.40 | 0 | 18.4 (20) |
| Baseline: keyword `search` top 3 on the turn | 73.8% | 81.7% | 33.8% | 100% | 0.50 | 22 | 184.6 (466) |

`turn_context` reaches slug-tail mentions (6 of 6) because its pointer section has no confidence gate; only its volunteered section does. With `prior_context` the common-word rate halves only because the second turn in each such session repeats an already delivered page. Latency was under 1.3 ms at p95 for every gbrain mode on in-memory PGLite. Without `prior_context`, a caller gets 97 redundant deliveries over 52 sessions; the contract that a slug in `prior_context` is not re-volunteered held (0).

**Threshold sweep (`min_confidence`, local, `prior_context` passed).**

| Gate | 0.50 to 0.65 | 0.70 to 0.75 (default 0.7) | 0.80 to 0.85 | 0.90 to 0.95 |
|---|---|---|---|---|
| Recall, all 60 triggers | 100% | 90% | 70% | 30% |
| Lost arms | none | slug tail | slug tail, surname | slug tail, surname, title |
| False alarms, 80 negatives | 7.5% | 7.5% | 7.5% | 7.5% |
| False alarms, 68 innocuous and no-mention | 0% | 0% | 0% | 0% |

Recall at a 5% false-alarm budget is 100% (gate 0.65 or lower) when common-word turns are left out, and unreachable at any gate when they are counted. PR-AUC over the sweep, with precision as useful deliveries over all deliveries, is 0.86. On this small synthetic world a gate of 0.65 would add slug-tail recall at no false-alarm cost; that is a development observation, not a recommendation.

**Associative arm (associative-recall-v1, development data, labels pending human review).** All 277 sources were imported into one gbrain source per fixture source (so same-slug distractors stay distinct), private sources marked private and withdrawn ones soft-deleted. Each of the 480 probes was replayed as a one-turn window.

| System | Indirect, any required page (240) | Direct (120) | Negatives, strict false alarms (120) | Negatives, adjudicated false alarms (120) |
|---|---|---|---|---|
| `volunteer_context` | 0% | 0% | 0% | 0% |
| Keyword `search` top 3 | 79.2% | 92.5% | 100% | 100% |

Keyword search finds the right note often, but it fires on every turn, so as unsolicited recall it would interrupt every message. `volunteer_context` never fires, because the probes name situations, not entities.

**Label adjudication.** Before any number, the three negatives the corpus README disputes were adjudicated by this lane (an agent, not an independent human) in [`eval/data/n8-proactive-recall/associative-negatives-adjudication-v1.json`](../../eval/data/n8-proactive-recall/associative-negatives-adjudication-v1.json). None is answerable, so the empty answer gold stands; for each, one public history page is a permissible association (the edition-log page for the ink brand, the fee-policy page for the replacement fee, the approval-policy page for edited releases), and the withdrawn consent list stays prohibited. The frozen corpus files are unchanged. With zero deliveries from `volunteer_context`, the adjudication changes no number in this run; it changes nothing for keyword search either, which also delivers non-permissible pages on those turns.

Hermetic run time: about 33 seconds for the whole category, inside the 60-second target.

## gbrain bugs found

### N8-1. `volunteer_context` returns private pages to remote callers

- **Contract.** `src/core/search/private-visibility.ts` (#4352): untrusted callers exclude `visibility: private` pages by default, fail-closed; `docs/mcp/DEPLOY.md`: "MCP callers also exclude private pages by default".
- **Where.** `volunteer_context` (`src/core/ops/insights.ts`) calls `volunteerContext`, which resolves through `resolveEntitiesToPointers` (`src/core/context/retrieval-reflex.ts`). Its page queries filter `deleted_at IS NULL` and source scope, never `excludePrivate`; the op never consults `resolveExcludePrivatePages(ctx.engine, ctx.remote)`.
- **Repro.** `bun docs/benchmarks/2026-10-01-n8-proactive-recall/repro/n8-1-private-volunteer-remote.ts`. Expected: no page for a remote caller. Actual: the private page with its synopsis, while remote `search` returns 0 hits.

### N8-2. The `turn_context` block injects private pages

- **Contract.** `src/core/context/turn-context.ts` header: the IPC path "must never widen what MCP would return"; the block goes into a model context window that may be logged or synced, which is why pack mode and hot facts are world-only.
- **Where.** `assembleTurnContext` turn mode: the reflex pointer arm and the volunteered arm use the same unfiltered resolver as N8-1.
- **Repro.** `bun docs/benchmarks/2026-10-01-n8-proactive-recall/repro/n8-2-private-turn-context.ts`. Expected: no private page in the block. Actual: the page and its first sentence under "Brain pages mentioned this turn".
- **Note.** N8-1 and N8-2 share one mechanism; a fix in the resolver (or its two callers) covers both. Whether a trusted local CLI call to `volunteer_context` should also hide private pages is a product decision; this ledger entry asks only for the remote and injected paths.

## Feature gaps and documented limits (not bugs)

- **N8-3, ordinary-word aliases.** Lexical matching has no sense disambiguation; "precision-biased" is not a contract a fix can be tested against.
- **N8-4, no associative recall.** Entity mentions only, as the capability matrix says.
- **Slug-tail mentions** need a gate of 0.65 or lower in `volunteer_context`, as documented; `turn_context` pointers deliver them anyway.
- **Session state is the caller's job.** `volunteer_context` keeps no session; a caller that does not pass `prior_context` gets 1.87 redundant pages per session here.
- **System One S6** is off keyless and not measured.
- **No real hook trace.** `turn_context` ran in process, not over IPC; the hot-facts section was empty because the world has no facts rows.

## What to use and what to avoid

Use `volunteer_context` with `prior_context` for "you mentioned someone, here is their page": on this world it was exact on alias, title and surname mentions with no false alarm on unrelated turns. Avoid aliases that are ordinary words. Until N8-1 and N8-2 are fixed, do not expose `volunteer_context` to remote agents or enable the user-prompt hook on a brain with private pages. Do not expect it to recall a situation that names no entity.

## Reproduce and inspect

```bash
bun install
bun eval/runner/n8-proactive-recall.ts --gbrain ../gbrain@3a284aea26889b77c633aebb4149c3016d834ee6   # hermetic, $0
bun eval/runner/all.ts --tier offline --only proactive-recall
bun test test/eval/n8-proactive-recall.test.ts
```

Receipt: [run at the pin](2026-10-01-n8-proactive-recall/receipt-pin.json) (outputs SHA-256 `dbad189b...`, identical on a second run). Repros: [`2026-10-01-n8-proactive-recall/repro/`](2026-10-01-n8-proactive-recall/repro/). Findings: [wave bug ledger](2026-10-01-wave-bugs.md).

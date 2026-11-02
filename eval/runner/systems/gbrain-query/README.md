# gbrain-query connector

This module measures gbrain through `query`, the operation an agent calls, instead of the internal ranking function
the open-source memory comparison used. It calls gbrain in process as a trusted local caller (`remote: false`), so
remote lean rows and safe-chunk rules are not exercised. It was built for the budgeted delivery plan
([PLAN.md](https://github.com/garrytan/gbrain-evals/blob/capy/gbrain-budgeted-delivery-plan/docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md), C0) and is meant to be imported by
other waves.

- `connector.ts`: the wire requests, the pin check, the frozen hit list, deliveries and their records, live parity.
  It has no memory-qa dependency.
- `system.ts`: `GbrainQuerySystem`, the `MemorySystem` adapter that memory-qa runs as `--system gbrain-query`.

## Wire requests

Each request is the exact parameter object handed to the `query` handler (`wireRequest(name, query, { limit, budget })`):

| Name | Object | Use |
|---|---|---|
| `frozen-chunk` | `{ query, limit, expand: false, return_unit: 'chunk' }` | The frozen hit list. With no `token_budget` the evidence plan is null, so no chunk budget applies; `freeze` refuses a response that carries delivery meta. |
| `native-default` | `{ query, limit, expand: false }` | The agent's default call: neither `return_unit` nor `token_budget`. gbrain resolves `auto` at its 24,000-token conversation budget. |
| `auto-budget` | `{ query, limit, expand: false, return_unit: 'auto', token_budget: N }` | `auto` under an explicit budget. |
| `live-parity` | `auto-budget` plus `use_cache: false` | The plan's one live check per question. |
| `bare-budget` | `{ query, limit, expand: false, token_budget: N }` | Recorded for decision G7: a bare budget makes gbrain's `legacyBudget` turn an implied `auto` into chunk budgeting (`src/core/ops/search.ts`, `evidencePlanFor`). |

`expand: false` differs from the agent default (`true`); it matches the comparison's retrieval and is disclosed in the
capability record. Frozen deliveries go through `assembleEvidenceForHits` (`assembleRequest(hits, unit, budget)`),
gbrain's seam for a frozen candidate list.

## Pins

`QUERY_PATH_PINS` are written to the brain's config table, which is what the handler reads:
`search.cache.enabled=false`, `decide.provider=none`, `search.crag_escalation=false`, `search.crag_think=false`,
`search.track_retrieval=false`. `checkPins` refuses a key that is not in gbrain's `KNOWN_CONFIG_KEYS` (or, for
`decide.*`, `DECIDE_CONFIG_KEYS`) and a value that does not read back. `cacheStatus()` reports the semantic cache's
runtime state (`disabled` in every build in scope).

`GbrainQuerySystem` also writes `HELD_GBRAIN_DEFAULTS` from [gbrain-under-test.ts](../../gbrain-under-test.ts):
`search.query_facts_block=false`, `search.saved_facts_supersede=false` and `search.remote_page_cap=0`, gbrain's behavior
before v0.60.491.0, so its arms measure what they measured before the re-pin to v0.60.531.0. A memory-qa `--pin` or
`--config` value for one of these keys overrides it. The capability record lists the values written as
`held_defaults` and names the change in `deviations_from_vendor_code`.

## Quote-fenced chat text

Since gbrain v0.60.507.0, `query` and `assembleEvidenceForHits` return a chat page's text inside a quote fence
(`quoted: "transcript"`), and no setting turns that off. `storedText` unwraps each such row with the build's own
`unquoteTranscriptText`, so a frozen list re-resolves against the stored chunks and readers get the text they got
before. Delivered match spans move back onto the unwrapped text. A build that fences but exports no
`unquoteTranscriptText` (v0.60.507.0 to v0.60.520.0) is refused. Two parts cannot be undone. A token budget still
counts the fence, so a budgeted delivery can carry slightly less text, and a tool-call block gbrain summarized stays
summarized, so the re-resolution check refuses that row.

## What every delivery records

`deliveryRecord` returns, by value: the request as sent, requested and applied unit, the budget and whether the caller
passed it, `budget_used`, `tokens_delivered`, `overrun_tokens` and `over_budget`, block count, units and `auto`
reasons per block, spilled blocks and pages (`reason: conversation_over_budget`), passthrough blocks, drops,
fallbacks, unresolved hits, distinct sessions in and out, the evidence fingerprint and the evidence bytes (characters,
UTF-8 bytes, SHA-256), `quoted_blocks` (the blocks gbrain returned quote-fenced and the connector handed on
unwrapped), and a per-block list (slug, unit, reason, tokens, truncation, fallback, chunk ids, `effective_date`).
memory-qa adds the final reader prompt's bytes (`qa_context.reader_bytes`) and hash to every row.

`parity(live, assembled, { dates })` compares every field a reader consumes block by block (slug, title, text, unit,
chunk ids, spans, tokens, truncation, fallback, reason) and the totals. The evidence fingerprint alone omits dates and
titles, so it is reported separately.

## Two behaviors pinned by keyless fixtures

`test/eval/gbrain-query-system.test.ts` checks both on real PGLite brains with hash vectors. At the pinned gbrain
(`ca1281a2e`, v0.60.542.0; gbrain #6367 fixed both in v0.60.124.0):

1. **`auto` stays inside an explicit 8,000-token budget.** With 25 hits over long conversations, conversations that no
   longer fit are dropped at the budget floor instead of spilling outside it (`over_budget: false`,
   `spilled_blocks: 0`, `dropped > 0`); live `query` reports the same.
2. **The frozen-hit path carries `effective_date`.** `assembleEvidenceForHits` blocks carry the page date as live
   `query` blocks do, and parity with dates holds.

At gbrain `c5fb0201` (the E1 measurement) both were defects: `auto` spilled chunks past the budget and the frozen-hit
path dropped every date, so E1's receipts at that commit take dates from the session table. The E1 report keeps that
history.

## Use it from another runner

```ts
import { importGbrain, resolveGbrainUnderTest } from '../../gbrain-under-test.ts';
import { GbrainQueryConnector, loadConnectorModules, QUERY_PATH_PINS } from './connector.ts';

const gut = resolveGbrainUnderTest('/path/to/gbrain@c5fb0201');
const mods = await loadConnectorModules(rel => importGbrain(gut, rel));
const c = new GbrainQueryConnector(mods, engine);          // engine: an open BrainEngine with the pins written
await c.checkPins({ ...QUERY_PATH_PINS });
const frozen = await c.freeze(question, 25);
const auto8k = await c.deliver(frozen.rows, 'auto', 8000);  // auto8k.record, auto8k.blocks
const live = await c.live('live-parity', question, 25, 8000);
```

## Changelog

### 2026-11-02: fixtures section names the v0.60.542.0 pin

The fixtures section names the current pin, `ca1281a2e` (v0.60.542.0), where both fixtures still pass (was
`3ec766c40`, v0.60.531.0). The connector reads as a local caller, so the remote-reader quote fence that gbrain added in
v0.60.536.0 does not reach it.

### 2026-10-31: held read defaults, quote-fenced chat text and the v0.60.531.0 pin

The Pins section names the three gbrain defaults `GbrainQuerySystem` holds at their old values. A new section
describes how the connector unwraps quote-fenced chat text, and the delivery record list gains `quoted_blocks`. The
fixtures section names the current pin, `3ec766c40` (v0.60.531.0), where both fixtures pass, and the release in which
gbrain #6367 fixed both, v0.60.124.0; it named the v0.60.126.0 pin since 2026-10-09.

### 2026-10-09: fixtures assert the behavior gbrain #6367 fixed

At the v0.60.126.0 pin the two fixtures assert that `auto` stays inside its budget and that the frozen-hit path
carries dates (they documented an overrun and a date loss at `c5fb0201`).

### 2026-10-08: first version

Connector, `GbrainQuerySystem`, and the keyless fixtures for the `auto` overrun and the frozen-hit date loss.

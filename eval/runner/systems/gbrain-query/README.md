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

## What every delivery records

`deliveryRecord` returns, by value: the request as sent, requested and applied unit, the budget and whether the caller
passed it, `budget_used`, `tokens_delivered`, `overrun_tokens` and `over_budget`, block count, units and `auto`
reasons per block, spilled blocks and pages (`reason: conversation_over_budget`), passthrough blocks, drops,
fallbacks, unresolved hits, distinct sessions in and out, the evidence fingerprint and the evidence bytes (characters,
UTF-8 bytes, SHA-256), and a per-block list (slug, unit, reason, tokens, truncation, fallback, chunk ids,
`effective_date`). memory-qa adds the final reader prompt's bytes (`qa_context.reader_bytes`) and hash to every row.

`parity(live, assembled, { dates })` compares every field a reader consumes block by block (slug, title, text, unit,
chunk ids, spans, tokens, truncation, fallback, reason) and the totals. The evidence fingerprint alone omits dates and
titles, so it is reported separately.

## Two known behaviors, pinned by keyless fixtures

`test/eval/gbrain-query-system.test.ts` reproduces both on real PGLite brains with hash vectors:

1. **`auto` overruns an explicit 8,000-token budget.** With 25 hits over long conversations, each hit page's matching
   chunk is reserved first and the conversations that no longer fit are delivered as chunks outside the budget
   (`over_budget: true`, `spilled_blocks > 0`). The same call on the first five hits stays within budget.
2. **The frozen-hit path drops `effective_date`.** `assembleEvidenceForHits` resolves hits without the page date, so
   its blocks carry none while live `query` blocks do, and the evidence fingerprints still match. Take dates from
   your own session table when delivering on frozen hits at gbrain `c5fb0201`.

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

### 2026-10-08: first version

Connector, `GbrainQuerySystem`, and the keyless fixtures for the `auto` overrun and the frozen-hit date loss.

# Temporal and as-of questions through gbrain's own temporal features (2026-09-30)

## The finding

gbrain answers most date questions exactly when the data is written through its operations. On a seeded synthetic world of 21 people, 114 dated job and activity events, 17 meetings and 80 company metric points, 500 of 513 probes passed on both the pinned gbrain (`608a174`, v0.60.10.0) and current master (`f8d1e39`, v0.60.11.0). Day, week, since and on-this-day reads, search date bounds, effective-date precedence, time-zone and daylight-saving edges, metric trajectories and timeline as-of all scored 100%. Range set-F1 was 1.000 over 179 range probes.

The 13 misses come from four gbrain bugs, identical on the pin and on master:

1. `ontology_get` loses a job stint when a note about it arrives late and names the same company the person works at today (5 of 104 as-of probes wrong, as-of accuracy 95.2%).
2. `chronicle_last_seen` matches meeting attendees by substring, so `people/kim-example` is "seen" whenever `people/kim-example-2` is (3 probes, including 2 of 155 negative controls).
3. `chronicle_last_seen` can report the day before the right one when a late-evening local event exists (4 probes, one day off each).
4. A `query` date bound such as `since: "May 5"` passes validation and then silently returns nothing (1 probe).

Last-seen exact rate was 91.6% (76 of 83) and last-seen mean absolute error was 16.34 days over the 58 probes where both gold and gbrain named a date; one substring collision contributes 944 of the 948 error days.

The category is report-only. It becomes a gate once these bugs are fixed.

## Update, 2026-09-30: all four bugs fixed at the new pin (`6c8373c`, v0.60.13.0)

gbrain v0.60.13.0 ([#5769](https://github.com/garrytan/gbrain/pull/5769)) includes fixes for the four bugs above. Re-run at the new pinned dependency, gbrain master `6c8373c`, with the same seed-3 ledger (same ledger SHA-256) on a clean gbrain-evals tree (commit `2880304`): **513 of 513 probes pass**, and the verdict is `pass`.

| Measure | `608a174` / `f8d1e39` | `6c8373c` |
|---|---|---|
| Probes passing | 500/513 | 513/513 |
| `ontology_get` as-of | 99/104 (95.2%) | 104/104 |
| Last seen, exact | 76/83 (91.6%) | 83/83 |
| Last-seen mean absolute error | 16.34 days (n = 58) | 0.00 days (n = 58) |
| Negative controls | 153/155 | 155/155 |
| Non-ISO date bound (`since: "May 5"`) | accepted, returned nothing | rejected with an error naming the expected format |

Timeline as-of stays 104/104 and range set-F1 1.000 over 179 probes. With a clean pass, the category becomes a gate: `temporal-asof` has `gate: 'gate'` in `eval/registry.ts`, so a later gbrain that regresses any of these probes fails `all.ts --tier offline`. Receipt: [receipt-pin-6c8373c.json](2026-09-30-n3-temporal-asof/receipt-pin-6c8373c.json). The historical sections below describe `608a174` and `f8d1e39`.

## The concrete case

An invented example from the generated world. Alice (`people/alice-example`) joined startup-0 on 2022-10-13, moved to startup-1 on 2023-04-07 and returned to startup-0 on 2023-07-08. The note about her first stint at startup-0 was written on 2023-07-18, after her return had already been recorded. Asked "where did Alice work on 2023-01-09?", the right answer is startup-0: the question is about when she worked there (valid time), not when anyone wrote it down (recorded time).

gbrain keeps three kinds of dated record that can answer this:

- **Fact validity windows.** `ontology_propose` stores "Alice's employer is startup-0 from 2022-10-13", and `ontology_get` with `asof` returns the value whose window covers that day. This is true as-of state.
- **Timeline rows.** `add_timeline_entry` stores "joined startup-0" dated 2022-10-13 on Alice's page, and `get_timeline` with `before` returns rows up to a day.
- **Page dates.** Every page has an effective date taken from its frontmatter (`event_date`, then `date`, then `published`, then a date in the file name, then `created`), falling back to when the page was first recorded. `query` with `since`/`until` filters pages by that date.

Filtering notes by page date answers a different question: "what had been written by 2023-01-09?" Alice's first-stint note is dated 2023-07-18, so a page-date filter up to 2023-01-09 cannot see it. That is correct behaviour for a filter, and it is why this benchmark scores page-date filtering against recorded-time gold and reports its disagreement with true as-of state separately.

## The experiment and results

**World and seeds.** `eval/generators/n3-temporal-gen.ts` (version `n3-temporal-gen/1`, default seed 3, ledger SHA-256 `54c6bea63831a40d432bc4ee1a9788e0d72f1deebe0b13fee705c5e82d284b31`) emits a ledger of:

- 21 people with fictional placeholder slugs, including two slug-prefix pairs (`lee-example` / `lee-example-jr`, `kim-example` / `kim-example-2`) and two people who never appear in any event;
- 114 person events over 2022-01-10 to 2025-11-30, each with a valid date and a recorded date; 25 are recorded 30 to 240 days late, and three people follow a "boomerang" path (A, then B, then back to A) whose first stint is recorded last;
- 17 meetings producing 23 chronicle events with New York offsets, including three late-evening events that fall on the next UTC day and two date-only events;
- 10 pages with competing date signals, 9 time-zone edge pages, 3 undated pages, and 5 companies with 16 quarterly `team_size` points each (a sixth company has none).

Six more pages are dated 2, 10, 20, 45, 200 and 500 days before the run date. They sit outside the ledger fingerprint because gbrain has no way to pin "now" for relative durations; the receipt records the anchor day (2026-09-30).

**Oracle derivation.** Gold never comes from gbrain output:

| Question | Oracle |
|---|---|
| Employer as of a day (true state) | `ForwardJobState` (`eval/generators/job-state.ts`), a streaming state machine over the person's events in valid-time order; the event on the query day counts. Shared with the timeline round-trip category. |
| Employer by recorded time | The same machine over only the events recorded on or before the query day. |
| Day, week, since, on-this-day, date-bound and trajectory sets | Set arithmetic over the ledger's timeline rows, note dates and metric points. |
| Last seen | Latest day on or before `asof` where the entity owns a row or is listed in an event's `who`, by exact slug. |
| Effective date | An independent implementation of the documented precedence chain (`src/core/effective-date.ts` header). |
| Time zones | An independent US Eastern rule (daylight time from 02:00 on the second Sunday of March to 02:00 on the first Sunday of November), not `Intl`. |

**How data enters gbrain.** `eval/runner/n3-temporal-asof.ts` calls operation handlers with a trusted local `OperationContext` on in-memory PGLite: `put_page` for every page, `add_timeline_entry` for person events, and `ontology_propose` for job changes, all in recorded order so late records arrive backdated. Chronicle events go through `runChronicleExtract` with a scripted judge that returns the ledger's events (the seam gbrain's own `src/eval/chronicle/harness.ts` uses), with `chronicle.tz` and `brain.timezone` set to `America/New_York`. Provider keys are removed from the process before gbrain loads; search runs on the keyword path.

**Presence.** Before scoring, the runner checks that all 186 seeded pages exist, that there are 114 person timeline rows, 23 chronicle projections and 23 event pages, 55 employer facts, 80 metric facts, that keyword search finds each time-zone page by its token, and that no seed write failed. All eight checks passed on both builds. A failed check would have ended the run as a harness error.

**Results.** Pinned `608a174` and master `f8d1e39` gave identical per-probe results.

| Feature | Operation | Pin | Master |
|---|---|---:|---:|
| As-of employer, fact validity windows | `ontology_get asof` | 99/104 | 99/104 |
| As-of employer, timeline rows (no harness date filter) | `get_timeline before` | 104/104 | 104/104 |
| Page-date filter (notes up to the as-of day) | `query until` | 104/104 | 104/104 |
| Date-bound windows (quarters, months, single days, open ends) | `query since/until` | 15/15 | 15/15 |
| Effective-date precedence (field, source, and filter includes the right day and excludes decoys) | `get_page`, `query` | 10/10 | 10/10 |
| Recorded time for undated pages, stable across rewrites | `get_page`, `query since 7d` | 9/9 | 9/9 |
| Relative durations (`7d`, `2w`, `1m`, `1y`, `3y`, `1d`, `1m` to `7d`) | `query since/until` | 7/7 | 7/7 |
| Inputs the contract rejects | `query since` | 4/5 | 4/5 |
| Time-zone and DST edge pages | `query since/until` | 9/9 | 9/9 |
| Late-evening events land on the local day | `chronicle_day` | 6/6 | 6/6 |
| Day | `chronicle_day` | 15/15 | 15/15 |
| ISO week | `chronicle_day week` | 4/4 | 4/4 |
| Since | `chronicle_since` | 4/4 | 4/4 |
| Since, by event kind | `chronicle_since kind` | 3/3 | 3/3 |
| On this day | `chronicle_on_this_day` | 5/5 | 5/5 |
| Last seen | `chronicle_last_seen` | 76/83 | 76/83 |
| Trajectory ranges | `find_trajectory since/until` | 16/16 | 16/16 |
| Latest metric point on or before a day | `find_trajectory until` | 10/10 | 10/10 |

Headline metrics (same on both builds):

| Metric | Value | Denominator |
|---|---:|---|
| As-of accuracy, `ontology_get` | 95.2% | 104 probes |
| As-of accuracy, `get_timeline` | 100% | 104 probes |
| Range set-F1 (mean) | 1.000 | 179 range probes |
| Last-seen exact (date and days-ago) | 91.6% | 83 probes |
| Last-seen mean absolute error | 16.34 days | 58 probes where gold and gbrain both named a date |
| Negative controls passed | 98.7% | 155 probes whose right answer is empty, none or excluded |
| Probes passed | 500/513 | 492 ledger probes plus 21 clock-relative probes |

As-of accuracy by situation, fact windows versus timeline rows:

| Situation | `ontology_get` | `get_timeline` |
|---|---:|---:|
| Before any state (right answer: none) | 16/16 | 16/16 |
| Day before the first job | 16/16 | 16/16 |
| On a job-change day | 16/16 | 16/16 |
| Day before a job change | 11/12 | 12/12 |
| Inside a late-recorded window | 9/9 | 9/9 |
| Inside a boomerang first stint recorded last | 0/3 | 3/3 |
| Random days | 31/32 | 32/32 |

**Page-date filtering versus true as-of state.** The page-date filter returned exactly the notes written by each as-of day (104/104). Reading the employer from those notes matched the recorded-time gold in 104 of 104 probes and the valid-time gold in 86 of 104. The 18 differences are the probes where a late note changes the answer. This is the reviewer's distinction made measurable: date filtering over pages is not a substitute for `ontology_get` or timeline rows when the question is about state.

**Negative controls.** 155 probes have an empty or null right answer: as-of days before any job (41 per as-of arm), notes before anyone wrote (26), empty date windows, days, weeks and on-this-day anchors, an absent event kind, never-seen entities and days before a first sighting (25), trajectory windows before the data, a company without facts and metric as-of days before the first point (11), a `1d` window, and a dated page rewritten today that must stay out of a `7d` window. A "return everything" answer scores mean set-F1 0.032 over the 172 ledger set probes; "return nothing" scores 0.238; "always the latest employer" scores 20.2% as-of accuracy; "always none" scores 39.4% (computed in `test/eval/n3-temporal-asof.test.ts`).

**Errors.** Zero harness errors and zero operation errors on both builds; all 13 misses are wrong answers. `n_scored` is 513 of 513.

**Unsupported and not covered** (recorded in each receipt under `data.unsupported`):

- Relative expressions against a pinned "now": `resolveDateBoundary` reads `Date.now()` and no parameter pins it. Measured on clock-relative pages instead.
- Natural-language dates ("yesterday", "last week", "3 days ago") in search date bounds: outside the documented contract, so probed as inputs that must be rejected. gbrain rejects all three.
- Date bounds on the `search` operation: it declares no `since`/`until`; the `query` operation carries them.
- The `think` temporal window: reachable only through `think`, which needs a chat model.
- Chronicle extraction from meeting prose: the judge is a chat model, so a scripted judge feeds the ledger's events. Event pages, projection, day mapping and reads are gbrain code; extraction from text is not measured.
- Sub-day as-of: `ontology_get` and `chronicle_last_seen` take a day.
- Default "today" anchors: probes always pass `date`/`asof`.

## gbrain bugs found

Each repro is a standalone script. Save it in a gbrain checkout root and run `bun <file>.ts`. All four reproduce at `608a174` and at `f8d1e39`. Line numbers are for `f8d1e39`.

### 1. A late-recorded stint with the current value disappears from as-of state

**Where:** `src/core/pglite-engine.ts:4898` (`mergeOntologyFact`, `if (current && current.value_hash === vh)`), and the same check at `src/core/postgres-engine.ts:4054`.

**What happens:** `mergeOntologyFact` compares a new observation only with the newest open value. When a backdated observation has the same value as that open fact, it takes the "corroborated" path and inserts a row with `expired_at = now()`, which as-of reads ignore. No window covers the first stint, and `ontology_conflicts` does not flag it either, because it only reads open rows. The documented contract says "a backdated conflict is flagged not rewritten"; here it is neither kept nor flagged. A backdated observation with a different value works (9/9 late-recorded-window probes pass).

**Expected:** `ontology_get asof 2022-06-01` returns `startup-0`. **Actual:** `null`.

**Probes broken:** `asof_facts:alice@2023-01-09`, `alice@2023-04-06`, `grace@2022-04-01`, `olivia@2024-04-27`, `olivia@2025-01-09`.

```ts
import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { operations } from './src/core/operations.ts';
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
const op = (n: string, p: object) => operations.find(o => o.name === n)!.handler(ctx, p as any);
const E = 'people/alice-example';
// Valid time: startup-0 from 2022-01-01, startup-1 from 2023-01-01, startup-0 again from 2024-01-01.
// Recorded order: the first stint is learned last.
await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-1', valid_from: '2023-01-01', source: 'notes/b' });
await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2024-01-01', source: 'notes/c' });
console.log(await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2022-01-01', source: 'notes/a' }));
const at = async (d: string) => ((await op('ontology_get', { entity: E, asof: d })) as any[]).find(r => r.dimension === 'employer')?.value ?? null;
console.log('asof 2022-06-01 expected startup-0, got', await at('2022-06-01'));
console.log('asof 2023-06-01 expected startup-1, got', await at('2023-06-01'));
await engine.disconnect();
```

Output on both builds: `action: "corroborated"`, then `expected startup-0, got null` and `expected startup-1, got startup-1`.

### 2. Last seen matches attendees by substring

**Where:** `src/core/pglite-engine.ts:4830` (`` `%${entitySlug}%` ``) used at `:4837` (`w.name = $1 OR w.name LIKE $2`), and `src/core/postgres-engine.ts:4004`.

**What happens:** an event counts as a sighting of entity X when any `who` entry contains X's slug as a substring, so every slug that is a prefix of another slug inherits the longer slug's sightings. LIKE also treats `_` in a slug as a wildcard.

**Expected:** `people/kim-example`, who appears nowhere, has `last_date: null`. **Actual:** `last_date: "2024-05-01"` from `people/kim-example-2`'s event.

**Probes broken:** `chronicle_last_seen:people/lee-example@2026-06-30` (gold 2022-09-04, gbrain 2025-04-05, 944 days off), `people/kim-example@2025-03-21` and `@2026-06-30` (gold none; both are negative controls).

```ts
import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { operations } from './src/core/operations.ts';
import { runChronicleExtract } from './src/core/chronicle/extract-events.ts';
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
const op = (n: string, p: object) => operations.find(o => o.name === n)!.handler(ctx, p as any);
await op('put_page', { slug: 'people/kim-example', content: '---\ntype: person\ntitle: Kim\n---\nKim.\n' });
await op('put_page', { slug: 'people/kim-example-2', content: '---\ntype: person\ntitle: Kim 2\n---\nAnother Kim.\n' });
await op('put_page', { slug: 'meetings/2024-05-01-sync', content: '---\ntype: meeting\ntitle: Sync\ndate: 2024-05-01\n---\n' + 'Notes. '.repeat(20) });
await runChronicleExtract(engine, { slug: 'meetings/2024-05-01-sync', judge: async () => ({ events: [{ when: '2024-05-01', who: ['people/kim-example-2'], what: 'Sync with kim 2', kind: 'meeting' }] }) });
console.log(await op('chronicle_last_seen', { entity: 'people/kim-example', asof: '2024-06-01' }));
console.log('expected last_date: null');
await engine.disconnect();
```

### 3. Last seen orders by instant but reports a day

**Where:** `src/core/pglite-engine.ts:4853` and `src/core/postgres-engine.ts:4008`: `ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) DESC`.

**What happens:** the query filters on the projected local day (`te.date`) but picks the newest row by comparing an event's exact instant with a plain timeline row's UTC midnight. A call at 23:30 New York time on May 1 (03:30 UTC on May 2) outranks the person's own row dated May 2, and the answer is May 1.

**Expected:** `last_date: "2024-05-02"`, `days_ago: 0`. **Actual:** `last_date: "2024-05-01"`, `days_ago: 1`.

**Probes broken:** `chronicle_last_seen:people/frank-example@2023-08-08` (two probes), `people/dave-example@2022-12-07`, `people/dave-example@2023-01-22`.

```ts
import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { operations } from './src/core/operations.ts';
import { runChronicleExtract } from './src/core/chronicle/extract-events.ts';
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
await engine.setConfig('chronicle.tz', 'America/New_York');
const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
const op = (n: string, p: object) => operations.find(o => o.name === n)!.handler(ctx, p as any);
await op('put_page', { slug: 'people/dave-example', content: '---\ntype: person\ntitle: Dave\n---\nDave.\n' });
await op('put_page', { slug: 'meetings/2024-05-01-call', content: '---\ntype: meeting\ntitle: Call\ndate: 2024-05-01\n---\n' + 'Notes. '.repeat(20) });
await runChronicleExtract(engine, { slug: 'meetings/2024-05-01-call', tz: 'America/New_York', judge: async () => ({ events: [{ when: '2024-05-01T23:30:00-04:00', who: ['people/dave-example'], what: 'Late call', kind: 'call' }] }) });
await op('add_timeline_entry', { slug: 'people/dave-example', date: '2024-05-02', summary: 'spoke at startup-1' });
console.log(await op('chronicle_last_seen', { entity: 'people/dave-example', asof: '2024-05-02' }));
console.log('expected last_date: 2024-05-02, days_ago: 0');
await engine.disconnect();
```

The same mixed ordering sets the display order of `chronicle_day` and `chronicle_since`; this benchmark scores those as sets, so their order is not measured.

### 4. A non-ISO date bound returns nothing instead of an error

**Where:** `src/core/search/date-bounds.ts:21` (`if (Number.isFinite(Date.parse(s))) return s;`), with the error swallowed by the fail-open keyword arm at `src/core/search/hybrid.ts:1420`.

**What happens:** JavaScript's `Date.parse` accepts strings such as "May 5" (Bun reads it as 2001-05-05), so `resolveDateBoundary` passes the raw string through. The database cast `::text::timestamptz` then fails, the keyword and title arms log "fail-open" warnings, and `query` returns an empty list. "last week" and "2024-02-30" are rejected with a clear message, as the contract says.

**Expected:** "May 5" is rejected like "last week" (or normalized to an ISO timestamp). **Actual:** `[]`.

**Probe broken:** `input:May 5 (non-ISO)`.

```ts
for (const k of ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];
import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { operations } from './src/core/operations.ts';
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
const op = (n: string, p: object) => operations.find(o => o.name === n)!.handler(ctx, p as any);
await op('put_page', { slug: 'notes/a', content: '---\ntype: note\ntitle: A\ndate: 2024-06-01\n---\nzebrafish note\n' });
for (const since of ['2024-01-01', 'last week', 'May 5']) {
  try { console.log(JSON.stringify(since), '->', ((await op('query', { query: 'zebrafish', since, expand: false })) as any[]).map(r => r.slug)); }
  catch (e) { console.log(JSON.stringify(since), '-> rejected:', (e as Error).message.slice(0, 80)); }
}
await engine.disconnect();
```

Output on both builds: `"2024-01-01" -> [ "notes/a" ]`, `"last week" -> rejected: Invalid since value …`, `"May 5" -> []`.

**Observations that are not bugs.** The duration unit `m` means 30 days in search date bounds (`date-bounds.ts`) but minutes in `recall since` (`parseSinceParam` in `src/core/ops/facts.ts`); each is documented for its own operation, but an agent moving between them can be surprised. Search date bounds use UTC calendar days while chronicle reads use `chronicle.tz` local days; both behave as documented and both are measured here.

## What to use and what to avoid

Use the chronicle reads (`chronicle_day`, weeks, `chronicle_since` with or without a kind, `chronicle_on_this_day`), `query` date bounds, and `find_trajectory` for date questions: every probe passed, including empty answers, daylight-saving boundaries and late-evening events. Frontmatter dates behave as documented, and an undated page keeps the time it was first recorded across edits, so "what did I write this week" does not pick up old pages that were merely edited.

Use `ontology_get` with `asof`, or `get_timeline` with `before`, for "what was true on day D". Do not use page-date filtering for that: it answers "what had been written by D" and gave a different employer in 18 of 104 probes. Until bug 1 is fixed, a stint learned late can vanish from `ontology_get` when the person later returned to the same company; the timeline arm was right on all five probes it breaks.

Treat `chronicle_last_seen` with care where one entity slug is a prefix of another (bug 2), and allow for a one-day error when late-evening events exist in a non-UTC chronicle zone (bug 3). Pass date bounds as `YYYY-MM-DD`, an ISO timestamp or a duration; any other string may silently return nothing (bug 4).

This is synthetic, production-path evidence: real gbrain operations on generator-written data with known answers. It says nothing about extracting events from real meeting prose, about the hybrid vector path, or about Postgres, although bugs 1 to 3 have the same logic in the Postgres engine at the lines cited above.

## Reproduce and inspect

From the gbrain-evals repository root, no keys needed:

```bash
bun install
bun eval/runner/n3-temporal-asof.ts                          # pinned gbrain (package.json)
bun eval/runner/n3-temporal-asof.ts --gbrain ../gbrain       # a copied overlay of a gbrain checkout at HEAD
bun eval/runner/n3-temporal-asof.ts --seed 7 --output /tmp/n3-seed7
bun eval/generators/n3-temporal-gen.ts --seed 3 --json       # the ledger and its fingerprint
bun test test/eval/n3-temporal-asof.test.ts
```

Each run took about 25 seconds and cost $0 (no provider request; keys are stripped from the process). Receipts land in `eval/reports/n3-temporal-asof/receipt.json` unless `--output` is given.

Identities for the published runs: gbrain-evals `a6c1ce3` (clean tree), generator `n3-temporal-gen/1`, seed 3, ledger SHA-256 `54c6bea6…d282b31`, gold fingerprint `7eadde63…1e05f52a`, clock-relative anchor 2026-09-30. Pinned gbrain `608a174` (v0.60.10.0, package SHA-256 `ccd7bd3d…`); master `f8d1e39` (v0.60.11.0, copied overlay, tree `bde0f916…`, verified not symlinked).

Raw receipts, with every probe's gold and gbrain's answer in `data.rows` and the misses in `data.failures`:

- [receipt-pinned-608a174.json](2026-09-30-n3-temporal-asof/receipt-pinned-608a174.json)
- [receipt-master-f8d1e39.json](2026-09-30-n3-temporal-asof/receipt-master-f8d1e39.json)

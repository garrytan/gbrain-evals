# BrainBench

Public benchmark for personal knowledge brain agent stacks. Ships 4 adapter
configurations scored side-by-side on a 240-page rich-prose fictional corpus
(`twin-amara`). Measures retrieval, extraction quality, and per-link-type
accuracy.

**What this answers:** "Does the knowledge graph layer do useful work, or is
gbrain just a thin wrapper over vector+keyword vector-grep-rrf-fusion?" Headline: gbrain
beats the closest external baseline (vector-grep-rrf-fusion-without-graph, same embedder,
same chunking) by **+31 points P@5**. The graph layer is load-bearing.

## 5-minute quickstart

```sh
# 1. Run the full benchmark (4 adapters × 5 runs, ~15 min wall clock)
bun run eval:run

# 2. Fast iteration (N=1 single run)
bun run eval:run:dev

# 3. Just the type-accuracy report
bun run eval:type-accuracy

# 4. Explore the canonical world (contributor-facing UI)
bun run eval:world:view
```

## What's in the box

```
eval/
├── data/
│   ├── world-v1/             Canonical world (committed). 240 sharded JSON files.
│   │                          One file per entity + _ledger.json metadata.
│   ├── amara-life-v1/        (v0.15+) Fictional-life corpus (committed).
│   │                          inbox/slack/calendar/meetings/notes/docs +
│   │                          corpus-manifest.json. Only the Opus prose cache
│   │                          (_cache/) is gitignored; regeneration via
│   │                          `bun run eval:generate-amara-life` is optional.
│   └── gold/                 (v0.15+) Sealed qrels + perturbation gold.
│                              entities, backlinks, qrels, contradictions, poison,
│                              personalization-rubric, implicit-preferences, citations.
│                              Empty templates in v0.15; filled in v1 Complete.
├── schemas/                  (v0.15+) Portable JSON Schema contracts.
│                              corpus-manifest, public-probe (PublicQuery with gold
│                              stripped), tool-schema (12 read + 3 dry_run, 32K cap),
│                              transcript, scorecard (N ∈ {1,5,10}), evidence-contract.
│                              Pins the v1→v2 Inspect AI driver-swap boundary.
├── generators/
│   ├── gen.ts                Opus-backed world-v1 generator (cached, $80 cap)
│   ├── world.ts              World-schema scaffolder
│   ├── world-html.ts         World explorer HTML renderer (XSS-safe)
│   ├── amara-life.ts         (v0.15+) Deterministic amara-life skeleton.
│   │                          Mulberry32 PRNG, 15 contacts, 50+300+20+8+40 items,
│   │                          plants 10/5/5/3 perturbations at fixed positions.
│   └── amara-life-gen.ts     (v0.15+) Opus prose expansion. Structured cache key
│                              (schema_version + template_hash + item_spec_hash),
│                              $20 hard-stop, --dry-run for smoke tests.
├── runner/
│   ├── multi-adapter.ts      4-adapter side-by-side scorer (N=5, seeded order)
│   ├── type-accuracy.ts      Per-link-type accuracy vs gold from _facts (Cat 2)
│   ├── adversarial.ts        Cat 10 robustness — 22 hand-crafted edge cases
│   ├── all.ts                Master runner (current: sequential execSync;
│                              v1 Complete Day 10: rewrites to async + p-limit(2))
│   ├── before-after.ts       Original v1 BEFORE/AFTER retrieval run
│   ├── types.ts              Adapter, Page (extended with email|slack|cal|note),
│                              Query, RankedDoc. PublicPage/PublicQuery land here
│                              when sealed qrels enforcement ships (v1 Complete Day 9).
│   ├── adapters/
│   │   ├── grep-only.ts         EXT-1: classic IR baseline (Grep-only over grep hits)
│   │   ├── vector.ts          EXT-2: pure cosine similarity, same embedder
│   │   └── vector-grep-rrf-fusion.ts       EXT-3: gbrain vector-grep-rrf-fusion with graph disabled
│   └── queries/
│       ├── tier5-fuzzy.ts          30 vague-recall queries (hand-authored)
│       ├── tier5_5-synthetic.ts    50 synthetic outsider queries (AI-authored, labeled)
│       ├── validator.ts            Schema + temporal as_of_date + one-slash slug rule
│       └── index.ts                Aggregator + validateAll()
├── cli/
│   ├── world-view.ts         Render + open world.html
│   ├── query-validate.ts     Validate a Query[] file
│   └── query-new.ts          Scaffold a Query template
└── reports/                  Benchmark scorecards (gitignored)
```

## Three contributor paths

### Path 1: Reproduce a published scorecard

```sh
# 1. Check out the specific gbrain commit referenced in the scorecard
git checkout <commit-sha>
# 2. Run the full benchmark
bun run eval:run
# 3. Compare your numbers to the scorecard. Deterministic adapters should
#    match exactly. Embedding-based adapters should land within tolerance bands.
```

### Path 2: Submit a new external adapter

See `CONTRIBUTING.md` for the adapter submission flow. Short version:

1. Implement `eval/runner/adapters/<your-adapter>.ts` conforming to the
   `Adapter` interface in `eval/runner/types.ts`.
2. Add a unit test file alongside.
3. Wire your adapter into `eval/runner/multi-adapter.ts` (one line).
4. `bun run eval:run:dev` to verify.
5. Open a PR.

### Path 3: Write Tier 5.5 externally-authored queries

The T5.5 queries currently in the repo are AI-authored (`author:
"synthetic-outsider-v1"`) as a placeholder. Real outside researchers should:

1. `bun run eval:world:view` to understand the canonical world
2. `bun run eval:query:new --tier externally-authored --author "@your-handle"`
3. Edit the scaffolded template with a real query + gold slugs
4. `bun run eval:query:validate path/to/your.json`
5. Submit via `eval/external-authors/<your-handle>/queries.json` in a PR

See `CONTRIBUTING.md` for the query-submission template.

## Methodology one-pager

- **Corpus:** 240 Opus-generated fictional biographical pages. Fixed,
  committed, zero private data. Reproducibility baseline for any run.
- **Gold:** Each page's `_facts` metadata defines canonical relationships.
  The scorer never shows `_facts` to the adapters — **raw pages only**
  cross the ingestion boundary (structural enforcement in `Adapter.init`).
- **Metrics:** P@5 and R@5 on the relational queries auto-built from
  `_facts` (145 canonical). The 80 tier-5 + tier-5.5 queries are
  schema-validated (`bun run eval:query:validate`) but are NOT yet wired
  into the `eval:run` scorer — the scorecard below covers the canonical
  set only. Type accuracy on extracted edges
  (`eval/runner/type-accuracy.ts`).
- **N=5 runs per adapter** with page-order shuffle (seeded LCG; runs are
  reproducible). Stddev surfaces order-dependent adapter bugs. Deterministic
  adapters correctly show stddev=0.
- **Temporal queries** require explicit `as_of_date` (validated at query
  authoring time; rejected at load if a temporal verb is present without it).

## Adapter scorecard (most recent, N=5)

See `docs/benchmarks/2026-04-18-brainbench-v1.md` for the full report.
Quick summary from `bun run eval:run`:

| Adapter         | P@5    | R@5    |
|-----------------|--------|--------|
| gbrain    | 49.1%  | 97.9%  |
| vector-grep-rrf-fusion  | 17.8%  | 65.1%  |
| grep-only    | 17.1%  | 62.4%  |
| vector     | 10.8%  | 40.7%  |

The graph layer beats vector+keyword vector-grep-rrf-fusion on relational queries by ~31
points; vector-grep-rrf-fusion-without-graph barely edges Grep-only. That's the story.

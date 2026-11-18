- The duplicate-finder head-to-head now runs each memory system at its newest release, as its preregistration
  (docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md) asks: `ext-temporal-graph` 0.31.2,
  `ext-graph-pipeline` 1.6.8 and `ext-memory-bank` 1.2.1 (server image pinned by digest, client from its own lock;
  `ext-extract-first` was already newest). Each bundle under `docs/comparison-systems/<kind>/entity-h2h/` now builds
  from its own lock, so the scoreboard bundles beside it are unchanged. Two upstream changes needed a bundle edit: the
  `ext-graph-pipeline` release moved three result helpers the pinned adapter imports, so its entity-h2h entry point
  maps them back, and the `ext-memory-bank` image no longer ships the old default reranker, so its env file names the
  new default. `run.ts dry-run` prints each memory system's pinned release and lock, and a test checks every lock hash
  against its capability record.
- The gbrain cell of that head-to-head no longer changes the world folder. It imports a copy under its `--output`
  folder, because `gbrain import` rewrites frontmatter and a later `run.ts score` on the same world refused every page.
  It also declares the person pages' `external_id` to gbrain's duplicate finder, which treats an id field as a key only
  when the active schema pack lists it in the person type's `identity_keys`: the cell forks the active pack, declares
  the field, activates the fork, records the pack identity in `cell.json`, and refuses with `SCHEMA_PACK_INACTIVE` when
  gbrain does not report the fork active. Company pages carry no declared id, so the company type declares none.

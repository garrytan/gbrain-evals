# Classic entity-resolution arms for the entity-dedupe head-to-head

Three keyless entity-resolution tools run on the same world files as gbrain's duplicate finder: Splink, dedupe and Zingg Community. Each adapter reads the person pages or the company pages of a world, builds one record per page, runs the tool through its own documented path and writes its clusters to a neutral JSON file. `bun eval/runner/entity-h2h/run.ts` drives each arm and scores its output. Nothing here calls a paid service. The rules they follow are fixed in the [preregistration](../../../docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md) ("Classic tools", "Seeds").

| Tool | Version | Backend | Clusters | Review band | Labels |
|---|---|---|---|---|---|
| Splink | 5.0.0 | DuckDB | connected components at a match-probability threshold (`cluster_pairwise_predictions_at_threshold`) | none documented; the tuned config adds one chosen on the held-out world, labelled as ours | none: EM on the scored world |
| dedupe | 3.0.3 | in-process | `partition(data, threshold)` | none | active learning, labeller seeds 1 to 5 |
| Zingg Community | 0.7.0 (Spark 3.5.5, local mode, Java 21) | Spark | `z_cluster` from the `match` phase | none (no threshold setting either) | active learning, one run per config |

## Rules the adapters keep

- The world has people and companies: pages at `<world>/<source>/people/<slug>.md` and `<world>/<source>/companies/<slug>.md`. Each run reads one of them, chosen by `--entity people` or `--entity companies`.
- [world.py](world.py) is the one records parser. It reads only the rendered pages and imports nothing from the generators or any ledger. A person page's key is `<source>:<slug>` and a company page's key is `<source>:companies/<slug>`, the keys the scorer uses. A company page's `domain` (a string or a list) and the host of its `website` become one `domains` list: lowercase, with the scheme, a leading `www.` and any path dropped, as gbrain's finder keys a domain.
- Labels and tuning come only from the held-out world, seed 20261118. The labels file must say `"seed": 20261118` and must label every page the arm trains on, and each arm refuses to run when the held-out world and the scored world are the same directory.
- dedupe and Zingg train on the held-out world only: an oracle answers their active-learning questions (dedupe's `uncertain_pairs()` through `mark_pairs`, Zingg's `findTrainingData` pairs through the marked-records file) from the held-out labels, in the loop their console labellers run. Nothing reads standard input. The trained model then clusters the scored world.
- dedupe and Zingg run twice: with `--label-budget 100`, where the oracle answers at most 100 pairs in total, and without it, where the config's own stop rule decides (the ceiling). dedupe stops asking at the budget. Zingg stops after the round that reaches the budget and answers only up to the budget within that round. The budget never raises a config's own stop rule: dedupe's default config stops at 10 matching and 10 distinct pairs, as console_label counts them, so it asks about 20 pairs either way. The run log records the pairs asked and what stopped the labelling.
- dedupe's active learning is random, so it runs at labeller seeds 1 to 5 (`--seed`) and the results report the spread. The seed feeds Python's `random`, numpy's global state and dedupe's own `default_rng()` calls, and the arm re-runs itself with `PYTHONHASHSEED=0`, so one seed always gives the same output.
- Zingg Community has no seed setting, so its candidate pairs and model can differ between runs. It runs once per config, and the results state that as a limit. The arm refuses `--seed`.
- Splink fits m and u by expectation maximisation on the world it scores, unsupervised, which is its normal path. It takes no labels, so it refuses `--label-budget` and `--seed`. Its tuned match threshold and its review band (the bench's, since Splink documents none) are chosen on the held-out world.
- Each tool has a "default" config taken from its own person example in its docs (the config file cites the page and lists every change made to fit this world) and one "tuned" config. Each config also has a `companies` section used with `--entity companies`: each key in it replaces the top-level key of the same name. None of the tools documents a company example, so the company mappings are ours: name, domains as the contact key (where people have emails), LinkedIn and city, plus industry and country where the tool's comparisons fit. Each section says so in its `based_on` and lists its changes.

## Run

Run `uv sync` once in this directory, with [uv](https://docs.astral.sh/uv/) installed. From the repository root, the runner calls each arm as:

```
uv run --directory eval/adapters/er-h2h python splink_arm.py --config configs/splink-<default|tuned>.json   --entity <people|companies> --world W --held-out H --labels L --out-file F.json
uv run --directory eval/adapters/er-h2h python dedupe_arm.py --config configs/dedupe-<default|tuned>.json   --entity <people|companies> --world W --held-out H --labels L --out-file F.json [--label-budget N] [--seed 1..5]
uv run --directory eval/adapters/er-h2h python zingg_arm.py --config configs/zingg-<default|tuned>.json   --entity <people|companies> --world W --held-out H --labels L --out-file F.json [--label-budget N]   --zingg-home <unpacked>/zingg-0.7.0 --spark-home <unpacked>/spark-3.5.5-bin-hadoop3
```

W is the scored world, H the held-out world (seed 20261118) and L its labels file. Splink's default config needs no `--held-out` or `--labels`; its tuned config does. dedupe's seed defaults to 1.

Zingg needs Java 17 or 21, Apache Spark 3.5.5 ([spark-3.5.5-bin-hadoop3.tgz](https://archive.apache.org/dist/spark/spark-3.5.5/spark-3.5.5-bin-hadoop3.tgz), sha256 `8daa3f7fb0af2670fe11beb8a2ac79d908a534d7298353ec4746025b102d5e31`) and the Zingg release ([zingg-0.7.0-spark-3.5.5.tar.gz](https://github.com/zinggAI/zingg/releases/tag/v0.7.0), sha256 `4765f43e84f81728078037c65a12d119d5703366328ccabbd2357d8fecf0c5c3`), unpacked anywhere. Its work files go to `F.work/` beside the output.

## Files

The output (`F.json`):

```
{ "system": "splink", "version": "5.0.0", "config": "tuned",
  "tiers": { "auto": [["work:maya-reeves", "home:maya-reeves"]], "proposed": [] } }
```

`auto` is the tool's match decision; `proposed` is the review band, written only by Splink's tuned config. Clusters in one tier never share a page, singletons are left out, and every key is a page of the scored world. `config` is the config name; the entity, label budget and seed are in the run log.

The run log (`F.run.json`, beside the output): the tool version, entity, config file and its doc source, label budget, labeller seed, the pairs asked and what stopped the labelling, the held-out tuning curve and chosen threshold, page counts and timings.

The labels file the runner writes for the held-out world, covering people and companies:

```
{ "seed": 20261118, "per_family": 20,
  "entities": { "work:maya-reeves": "<person id>", "work:companies/halwick": "<company id>" } }
```

## Known issues

- dedupe 3.0.3 needs BTrees older than 6.5. BTrees 6.5 (2026-08-20, [changelog](https://btrees.readthedocs.io/en/latest/changes.html)) removed `byValue()` from the bucket classes dedupe's canopy index uses, which fails with `AttributeError: 'BTrees.IFBTree.IFBucket' object has no attribute 'byValue'`. `pyproject.toml` pins `btrees<6.5`.
- dedupe 3.0.3 calls `numpy.random.default_rng()` with no seed when it samples candidate pairs, so seeding `random` and numpy alone does not repeat a run. The arm seeds those calls from the labeller seed.
- Zingg's `match` phase ran out of Java heap on Spark's default 1 GB driver. The adapter passes the release's own `config/zingg.conf` (`--properties-file`), which sets 8 GB of driver and executor memory; a machine needs about 10 GB free.
- Zingg Community takes no random seed, so its candidate pairs and model can differ between runs; the results come from one run per config.

## Changelog

- 2026-11-18: Arms take `--entity people|companies`, `--out-file`, `--label-budget` (dedupe, Zingg) and `--seed` (dedupe only), and `bun eval/runner/entity-h2h/run.ts` drives them in place of er-h2h-score.ts. world.py keys company pages `<source>:companies/<slug>`, builds a normalised `domains` list and reads the new labels file. Each config gains a `companies` section. dedupe's labeller seed now repeats a run exactly.
- 2026-11-17: First version: Splink, dedupe and Zingg on person pages, scored by er-h2h-score.ts.

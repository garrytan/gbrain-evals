# Classic entity-resolution arms for the person-dedupe head-to-head

Three keyless entity-resolution tools run on the same world files as the [person-dedupe benchmark](../../runner/person-dedupe.ts): Splink, dedupe and Zingg Community. Each adapter reads a world written by `--write-world`, builds one record per page, runs the tool through its own documented path and writes its clusters in a neutral JSON file that [er-h2h-score.ts](../../runner/er-h2h-score.ts) scores with the person-dedupe ledger and scoring functions. Nothing here calls a paid service.

| Tool | Version | Backend | Clusters | Review band |
|---|---|---|---|---|
| Splink | 5.0.0 | DuckDB | connected components at a match-probability threshold (`cluster_pairwise_predictions_at_threshold`) | none documented; the tuned config adds one chosen on the held-out world, labelled as ours |
| dedupe | 3.0.3 | in-process | `partition(data, threshold)` | none |
| Zingg Community | 0.7.0 (Spark 3.5.5, local mode, Java 21) | Spark | `z_cluster` from the `match` phase | none (no threshold setting either) |

## Rules the adapters keep

- The scored world is seed 20261117. Every label and every tuned threshold comes from a held-out world on another seed (20261118). `bun eval/runner/er-h2h-score.ts labels` writes the held-out page-to-person map and refuses the scored seed, and each adapter refuses to run when the held-out world and the scored world are the same directory.
- dedupe and Zingg train on the held-out world only: an oracle answers their active-learning questions (dedupe's `uncertain_pairs()`, Zingg's `findTrainingData` pairs) from the held-out labels, in the loop their console labellers run. The trained model then clusters the scored world.
- Splink fits m and u by expectation maximisation on the world it scores, unsupervised, which is its normal path. Its tuned thresholds come from the held-out world.
- Each tool has a "default" config taken from its own person example in its docs (the config file cites the page and lists every change made to fit this world) and one "tuned" config.

## Run

From this directory, with [uv](https://docs.astral.sh/uv/) installed:

```
uv sync
W=~/er-h2h            # any scratch folder
(cd ../../.. && bun eval/runner/person-dedupe.ts --write-world $W/s20261117 \
  && bun eval/runner/person-dedupe.ts --seed 20261118 --write-world $W/s20261118 \
  && bun eval/runner/er-h2h-score.ts labels --seed 20261118 --out $W/s20261118.labels.json)
ARGS="--world $W/s20261117 --held-out $W/s20261118 --labels $W/s20261118.labels.json --out $W/out"
for c in default tuned; do
  uv run python splink_arm.py --config configs/splink-$c.json $ARGS
  uv run python dedupe_arm.py --config configs/dedupe-$c.json $ARGS
done
```

Zingg needs Java 17 or 21, Apache Spark 3.5.5 ([spark-3.5.5-bin-hadoop3.tgz](https://archive.apache.org/dist/spark/spark-3.5.5/spark-3.5.5-bin-hadoop3.tgz), sha256 `8daa3f7fb0af2670fe11beb8a2ac79d908a534d7298353ec4746025b102d5e31`) and the Zingg release ([zingg-0.7.0-spark-3.5.5.tar.gz](https://github.com/zinggAI/zingg/releases/tag/v0.7.0), sha256 `4765f43e84f81728078037c65a12d119d5703366328ccabbd2357d8fecf0c5c3`), unpacked anywhere:

```
for c in default tuned; do
  uv run python zingg_arm.py --config configs/zingg-$c.json $ARGS \
    --zingg-home <unpacked>/zingg-0.7.0 --spark-home <unpacked>/spark-3.5.5-bin-hadoop3
done
```

Then score every output from the repository root:

```
bun eval/runner/er-h2h-score.ts --output $W/scores $W/out/*-default.json $W/out/*-tuned.json
```

Each adapter also writes `<system>-<config>.run.json` beside its output: the tool version, the config file and its doc source, label counts, the held-out tuning curve and chosen threshold, and timings.

## Output format

```
{ "system": "splink", "version": "5.0.0", "config": "default",
  "tiers": { "auto": [["work:maya-reeves", "home:maya-reeves"]], "proposed": [] } }
```

A page key is `<source_id>:<slug>`, the key person-dedupe scores. `auto` is the tool's match decision; `proposed` is a review band and is left out when the tool has none. Clusters in one tier never share a page, and singletons are left out.

## Known issues

- dedupe 3.0.3 needs BTrees older than 6.5. BTrees 6.5 (2026-08-20, [changelog](https://btrees.readthedocs.io/en/latest/changes.html)) removed `byValue()` from the bucket classes dedupe's canopy index uses, which fails with `AttributeError: 'BTrees.IFBTree.IFBucket' object has no attribute 'byValue'`. `pyproject.toml` pins `btrees<6.5`.
- Zingg's `match` phase ran out of Java heap on Spark's default 1 GB driver. The adapter passes the release's own `config/zingg.conf` (`--properties-file`), which sets 8 GB of driver and executor memory; a machine needs about 10 GB free.
- Zingg Community takes no random seed, so its candidate pairs and model can differ between runs; the results come from one run per config.

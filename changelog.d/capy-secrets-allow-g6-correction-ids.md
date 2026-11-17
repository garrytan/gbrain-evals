### The secrets check accepts episode ids in published correction records

- The secrets check that runs before a push now accepts G6 episode ids such as `g6:particle-1:oov-7-p012:local:1` in the
  `key` fields of correction records under `docs/benchmarks/predictive-measures/`. The entry covers only values shaped
  like an episode id in `correction-*.json` files there, so any other value is still checked.

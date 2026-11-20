- The secrets check that runs before a push now accepts the interval field name that the hard company questions
  analysis writes into its analysis JSON (`"interval_key": "ci_z1.98"`, or `ci_z2.80` at the interim look), in
  `docs/benchmarks/*/analysis/*.json` only. The entry matches only that exact shape, ending at the closing quote, so any
  other value in those files, or text appended to it, is still flagged.

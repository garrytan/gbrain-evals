### The secrets check accepts synthetic labels in published lifecycle and privacy receipts

- The secrets check that runs before a push now accepts two values it flagged in published receipts under
  `docs/benchmarks/*/counted/`: the lifecycle matrix's synthetic identity labels (`alice_maps`, `exachen_lang`,
  `frank_email`) and N6's sentence describing its expired-token probe. Each entry covers only that exact value in those
  receipt files, so any other value there is still checked.

- The slowest test file, `test/eval/predictive-cli-arm.test.ts`, took about 5.3 minutes in CI and set the floor for
  the test shard that ran it. Its G3 checks now run as five files of about one minute each
  (`test/eval/predictive-g3-recovering-a.test.ts` to `-d.test.ts`, two causes each, and
  `test/eval/predictive-g3-careless.test.ts`), sharing `test/support/predictive-g3.ts`, so CI's shards can place them
  apart. Every assertion is kept: each episode is checked as before, each file checks the causes it met, and
  `predictive-cli-arm.test.ts` still checks the total of 14 surface-cause pairs (13 when gbrain reads two ranges).
  `test/timings.json` is refreshed from three main runs and this change's own run: it listed 402 of the 469 test files
  on main and several files were a minute or more off, so one run's shards ranged from 336 to 632 s of tests.

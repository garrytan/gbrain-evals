- CI runs on Ubicloud runners instead of GitHub's hosted ones, so a pull request no longer waits for a runner that
  every repository on the account shares. Over the 199 pull-request runs in the 67 hours before the switch, the
  median run took 11.9 minutes and the slowest 5% took 52.7 minutes or more, 41.6 of them waiting for a runner. The
  checks, BrainBench, test and harness jobs keep a 4-vCPU, 16 GB machine on Ubuntu 26.04, the same size and image as
  before; the small jobs run on 2 vCPU. No job, step or check changed.

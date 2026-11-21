- `scripts/ubicloud/ubi-runner.sh up` works on macOS again. The create lock added in #464 needed util-linux `flock`
  and bash 4's `{var}>` redirection, and `usage` printed its table with an awk expression that macOS awk rejects, so
  `up` refused on a Mac before it created any VM. perl now takes the same kernel lock on descriptor 9, which the kernel
  still drops when the holder exits, and `usage` works out its `(you)` suffix before printing. Linux behaviour is
  unchanged. `test/eval/ubi-runner-quota.test.ts` checks that `up` takes its lock without calling `flock`.

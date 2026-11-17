### The Ubicloud runner keeps the shared vCPU lines and puts a lifetime on every VM

- `scripts/ubicloud/ubi-runner.sh` reads the project's usage before every VM it creates and refuses, before any create
  request, unless the project's VMs stay at or under 464 vCPUs and the caller's team (every owner tag with the same
  leading letters, the caller's own VMs included) at or under 208. A usage read that fails, or a VM size that names no
  vCPU count, refuses too. Creates from one machine take turns through that check, and `ubi-runner.sh room -s <size>`
  prints how many more VMs of a size fit, for launchers that start VMs from several machines.
  `UBI_QUOTA_WAIT=<seconds>` waits for room instead of refusing.
- Every VM's name now carries its lifetime, `-t<hours>` from `UBI_TTL_HOURS` (default 12), and every launch first
  destroys the caller's own VMs whose lifetime has ended (`ubi-runner.sh reap` does it on demand; `UBI_REAP=0` skips
  it), never another owner's. So a VM kept after a failed pull or a lost session, or left by a killed launcher, stops
  billing at its owner's next launch after its lifetime ends. `up`, `run`, `reap` and `room` refuse without
  `UBI_OWNER`.
- The SOTA loop's window launcher (`eval/runner/sota/ubicloud/run.sh`) launches again through this runner. It records
  each window in flight until its final pull lands, refuses the next launch and fails its teardown check while one is
  outstanding, printing the pull command, and `run.sh pull <window>` stops the window's command, brings the state
  back once it has exited and destroys the VM. It never reaps, so nothing destroys its VMs automatically: an expired
  one may hold a window's only ledger. While any of its VMs exists, expired or not, it refuses to launch, and it names
  each one past its lifetime with its age, so a person pulls it or destroys it by hand.

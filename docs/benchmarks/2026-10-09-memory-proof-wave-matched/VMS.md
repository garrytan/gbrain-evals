# Memory proof wave matched rows: Ubicloud VMs

Every VM the matched secondary cells use, recorded when it is created and when it is destroyed, so a lost run machine cannot strand one. The SSH key directory is a path on the run machine, never the key. Any VM listed as created without a later "destroyed" line can be removed from anywhere with `UBI_OWNER=gbra52 ubi-runner.sh down <name>`.

| Time (UTC) | Cell | VM | SSH key directory | Event |
|---|---|---|---|---|
| 2026-10-09T18:47:00Z | longmemeval-s-gbrain-raw | `ubirun-gbra52-1791571596-ab0b5492` | `~/.local/state/ubi-runner/ubirun-gbra52-1791571596-ab0b5492/` on the run machine | created |
| 2026-10-09T18:47:20Z | longmemeval-s-comparator | `ubirun-gbra52-1791571616-e93c931a` | `~/.local/state/ubi-runner/ubirun-gbra52-1791571616-e93c931a/` on the run machine | created |
| 2026-10-09T18:47:40Z | longmemeval-s-gbrain-combined-shard1 | `ubirun-gbra52-1791571637-8d02146b` | `~/.local/state/ubi-runner/ubirun-gbra52-1791571637-8d02146b/` on the run machine | created |
| 2026-10-09T18:48:00Z | longmemeval-s-gbrain-combined-shard2 | `ubirun-gbra52-1791571657-74a73242` | `~/.local/state/ubi-runner/ubirun-gbra52-1791571657-74a73242/` on the run machine | created |
| 2026-10-09T18:48:21Z | longmemeval-s-gbrain-combined-shard3 | `ubirun-gbra52-1791571677-def273c0` | `~/.local/state/ubi-runner/ubirun-gbra52-1791571677-def273c0/` on the run machine | created |
| 2026-10-09T18:48:41Z | longmemeval-s-gbrain-combined-shard4 | `ubirun-gbra52-1791571697-58566cc8` | `~/.local/state/ubi-runner/ubirun-gbra52-1791571697-58566cc8/` on the run machine | created |
| 2026-10-09T18:57:18Z | locomo10-gbrain-raw | `ubirun-gbra52-1791572214-2a1f497b` | `~/.local/state/ubi-runner/ubirun-gbra52-1791572214-2a1f497b/` on the run machine | created |
| 2026-10-09T18:57:38Z | locomo10-gbrain-combined | `ubirun-gbra52-1791572234-7f99caf9` | `~/.local/state/ubi-runner/ubirun-gbra52-1791572234-7f99caf9/` on the run machine | created |
| 2026-10-09T18:57:53Z | locomo10-comparator | `ubirun-gbra52-1791572254-c11b8380` | `~/.local/state/ubi-runner/ubirun-gbra52-1791572254-c11b8380/` on the run machine | created |

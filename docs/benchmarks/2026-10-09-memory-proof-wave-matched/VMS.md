# Memory proof wave matched rows: Ubicloud VMs

Every VM the matched secondary cells use, recorded when it is created and when it is destroyed, so a lost run machine cannot strand one. Every VM listed here has been destroyed. Any VM listed as created without a later "destroyed" line can be removed from anywhere with `UBI_OWNER=gbra52 ubi-runner.sh down <name>`.

| Time (UTC) | Cell | VM | Event |
|---|---|---|---|
| 2026-10-09T18:47:00Z | longmemeval-s-gbrain-raw | `ubirun-gbra52-1791571596-ab0b5492` | created |
| 2026-10-09T18:47:20Z | longmemeval-s-comparator | `ubirun-gbra52-1791571616-e93c931a` | created |
| 2026-10-09T18:47:40Z | longmemeval-s-gbrain-combined-shard1 | `ubirun-gbra52-1791571637-8d02146b` | created |
| 2026-10-09T18:48:00Z | longmemeval-s-gbrain-combined-shard2 | `ubirun-gbra52-1791571657-74a73242` | created |
| 2026-10-09T18:48:21Z | longmemeval-s-gbrain-combined-shard3 | `ubirun-gbra52-1791571677-def273c0` | created |
| 2026-10-09T18:48:41Z | longmemeval-s-gbrain-combined-shard4 | `ubirun-gbra52-1791571697-58566cc8` | created |
| 2026-10-09T18:57:18Z | locomo10-gbrain-raw | `ubirun-gbra52-1791572214-2a1f497b` | created |
| 2026-10-09T18:57:38Z | locomo10-gbrain-combined | `ubirun-gbra52-1791572234-7f99caf9` | created |
| 2026-10-09T18:57:53Z | locomo10-comparator | `ubirun-gbra52-1791572254-c11b8380` | created |
| 2026-10-09T22:22:50Z | locomo10-gbrain-raw | `ubirun-gbra52-1791572214-2a1f497b` | destroyed after the receipt was pushed |
| 2026-10-09T22:23:01Z | locomo10-comparator | `ubirun-gbra52-1791572254-c11b8380` | destroyed after the receipt was pushed |
| 2026-10-09T22:23:13Z | locomo10-gbrain-combined | `ubirun-gbra52-1791572234-7f99caf9` | destroyed after the receipt was pushed |
| 2026-10-10T00:45:45Z | longmemeval-s-gbrain-raw | `ubirun-gbra52-1791571596-ab0b5492` | destroyed after the receipt was pushed |
| 2026-10-10T00:50:14Z | longmemeval-s-gbrain-combined-shard4 | `ubirun-gbra52-1791571697-58566cc8` | destroyed after the receipt was pushed |
| 2026-10-10T00:55:10Z | longmemeval-s-gbrain-combined-shard1 | `ubirun-gbra52-1791571637-8d02146b` | destroyed after the receipt was pushed |
| 2026-10-10T00:55:16Z | longmemeval-s-gbrain-combined-shard2 | `ubirun-gbra52-1791571657-74a73242` | destroyed after the receipt was pushed |
| 2026-10-10T00:55:22Z | longmemeval-s-gbrain-combined-shard3 | `ubirun-gbra52-1791571677-def273c0` | destroyed after the receipt was pushed |
| 2026-10-10T01:45:26Z | longmemeval-s-comparator | `ubirun-gbra52-1791571616-e93c931a` | destroyed after the receipt was pushed |

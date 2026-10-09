# Memory proof wave matched rows: Ubicloud VMs

Every VM the matched secondary cells use, recorded when it is created and when it is destroyed, so a lost run machine cannot strand one. The SSH key directory is a path on the run machine, never the key. Any VM listed as created without a later "destroyed" line can be removed from anywhere with `UBI_OWNER=gbra52 ubi-runner.sh down <name>`.

| Time (UTC) | Cell | VM | SSH key directory | Event |
|---|---|---|---|---|
| 2026-10-09T18:47:00Z | longmemeval-s-gbrain-raw | `ubirun-gbra52-1791571596-ab0b5492` | `~/.local/state/ubi-runner/ubirun-gbra52-1791571596-ab0b5492/` on the run machine | created |

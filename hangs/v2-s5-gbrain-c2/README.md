# v2 serve hang: s5.gbrain-defaults.shipped-defaults.c2 (LongMemEval-M, shard 2/4)

- Campaign `q1-scoreboard-public-v2`, lease `s5.gbrain-defaults.shipped-defaults.c2-a1-00d21122`, VM `ubirun-gbra49q1-1791563728-538248`.
- gbrain pin `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802` (0.60.106.0), resolved hash `415dafe5…ccab`.
- Last committed write: 2026-10-09T18:08:21Z (namespace `ns-2ecccd0817547baf`). Since then `gbrain serve --surface starter`
  has run at 99.6% of one core (5 h 10 min of CPU at capture, 23:19 UTC) and `serve.log` repeats
  `[persistence] phase=preparation reason=deadline_exceeded`. Matches the bundled Lua-grammar spin on ```` ```lua ````
  fences fixed in gbrain #6389 (v0.60.133.0).
- The cell is left to reach its 12-hour timeout under the outcome rules; it is reported as a failure of the pinned version
  and not rerun (A14).
- Files: `proc.txt` (process state), `inspect.json` (container config, environment removed), `logs.tgz` (shim receipts,
  serve and CLI logs, reference install, shim state), `cell-out.tgz` (the cell's output directory: readiness, meters,
  usage, lease ledger). The 2.8 GB brain volume is not in git; it is kept on the launching host.

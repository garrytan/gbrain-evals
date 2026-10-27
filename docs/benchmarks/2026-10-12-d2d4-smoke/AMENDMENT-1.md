# Amendment 1 to the D2+D4 Cat 40 smoke preregistration (sha256 ffb3df20…3753)

Written 2026-10-12, before any cell ran. Nothing in the frozen file changes except what is listed here.

1. **Harness commit.** The master slot built at gbrain-evals af2f0382 snapshotted with 5081 queued persistence
   effects (the warm boot stopped the server mid-drain; gbrain now serves requests while it drains), so the round
   refused it (`HARD_SLOT_EFFECTS_QUEUED`) before any cell. Every slot build and cell now runs from gbrain-evals
   branch `capy/cat40-warm-boot-drain-hold` (commit 769902ba, garrytan/gbrain-evals#137), which only changes the
   pre-snapshot warm boot: it holds the server until `gbrain sources writer status --json` shows no drain in
   progress. Tasks, models, flags, world, thresholds and budget are unchanged.
2. **Master slot rebuild.** The master slot is rebuilt with `--build-slots --rebuild` (the runbook fix). Its cost
   (~$0.21, projected) comes out of the same $8 program cap; the projection rises from ~$5.9 to ~$6.1.

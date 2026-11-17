### The keyless correctness checks hold at gbrain v0.60.733.0, and two numbers got worse

- **What changed.** [The November 16 keyless re-pin](docs/benchmarks/2026-11-16-w0-keyless-repin.md) reran the
  correctness checks that need no API key at gbrain's newest release, `6ce7195b4` (v0.60.733.0). Updates (388 of 388,
  never stale), `forget` (0 prohibited outputs), privacy on Postgres over real HTTP (155 of 155 cells, 0 leaks), dates
  (513 of 513), name resolution (0 wrong merges) and the lifecycle matrix's `forget` and remote-access contracts hold.
  README's rows for updates, `forget`, privacy and chat formats now name `6ce7195b4`; large pages keep `7a6bdd3`,
  because the 128 MiB PGLite slice passed the runner's memory ceiling on the rerun's host at both builds.
- **What got better.** `find-contradictions` with no `--source` now reads the latest stored run (bug N2-2, gbrain
  #6784), 4 more of the 15 retrieval failure shapes pass, and the search confidence grade separates answerable from
  unanswerable questions (100 of 120 answerable graded `moderate`, was 40).
- **What got worse.** Keyword-only recall on reworded one-hop relationship questions fell from 0.476 → 0.572 to 0.380 →
  0.511 (gbrain #7201), and a forwarded FYI email that forwards a question now opens an open loop (precision 53 of 56,
  was 53 of 53; gbrain #9246). README notes both.
- **Harness fixes.** N4 and the lifecycle matrix read `recall`'s quote-fenced facts through gbrain's own unquote, the
  lifecycle leak probes ignore a notice that repeats their own query, the lifecycle catch-up sweep passes `--yes` to a
  build whose `embed` asks for consent, the W0 VM script runs the lifecycle matrix outside the checkout, and the lifecycle
  and N5 runners keep VM paths out of their receipts. No earlier receipt's numbers change.

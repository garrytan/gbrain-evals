### Tests run against gbrain's newest release, and one command keeps the pin there

- **What changed.** `package.json` and `bun.lock` move the `gbrain` dependency from v0.60.623.0 (`d253ec0ff`) to
  v0.60.733.0 (`6ce7195b4`), gbrain's newest release on 2026-11-16, 110 releases and 2,325 commits later.
  `bun eval/runner/gbrain-pin.ts bump` finds gbrain's newest release tag on master, moves the pin and `bun.lock` to
  it, and prints the commit range and gbrain's changelog in between; it exits 2 when that release is already pinned.
  [CLAUDE.md](CLAUDE.md#choose-the-gbrain-build) gains "Choose the gbrain build": every new run measures the newest
  release at launch, an experiment's build freezes once its counted runs start, and an older build runs only when the
  question is about it. `gbrain-cues` and `gbrain-reader` stay frozen at the experiments' pins.
- **What gbrain does now.** [README.md](README.md) and [docs/gbrain-under-test.md](docs/gbrain-under-test.md) describe
  the new pin: keyless search that finds pages holding most of a question's words, the conversation archive, brains for
  a company or for several people, two new opt-in ranking keys, and changes to agent tool reads, deletes and purges,
  idle upkeep and Postgres TLS. The hub pages name the new pin. No result was rerun, and every row keeps the commit it
  was measured at; the keyless correctness checks, Cats 37 to 39 included, pass at the new pin.
- **Harness fixes for the new pin.** The typecheck declares the `DOM.AsyncIterable` library, because gbrain now passes
  Bun's stdin stream where an async iterable is expected. The test preload also blanks `PPLX_API_KEY`, a Perplexity
  key gbrain now reads, so no test can reach that provider. The SkillOpt replay tests record the new pin's answers to
  GPT-6.1 Sol's recorded calls: all 38 graph calls read, and the 169 recorded-time page reads stop only because the
  test brain has no recorded page at that instant.
- **Why.** Every new run measures gbrain's newest release at the moment it starts, so results describe the gbrain
  people install today.

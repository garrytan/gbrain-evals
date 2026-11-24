### Tests run against gbrain v0.60.769.0

- `package.json` and `bun.lock` move the `gbrain` dependency from v0.60.748.0 (`7f1623446`) to v0.60.769.0
  (`38831bb69`), gbrain's newest release on 2026-11-24, 21 releases and 162 commits later.
  [docs/gbrain-under-test.md](docs/gbrain-under-test.md#the-pin) names the new pin. No result was rerun.
- From this release gbrain's own engine factory opens the Rust engine (gbrain #9946) when a checked addon is
  installed. Without one it refuses with `rust_engine_addon_missing`, and with an addon whose SHA-256 the release
  manifest does not name it refuses with `rust_engine_addon_mismatch`. The engine-bench tests now expect those
  reasons in place of the older `rust_kind_unsupported`, and a new keyless test checks that a stray addon in the gbrain
  home is refused on the Rust engine and never reached by PGLite. With no addon, the Rust arm is still refused before
  any engine call, with no receipt. Tests also unset `GBRAIN_RUST_ENGINE_ADDON`, so an addon exported in a developer's
  shell cannot reach them.
- The BEAM-10M cell test now checks that its cells run the build their counted runs froze (v0.60.748.0) instead of
  package.json's pin, since those results are published and package.json has moved on.
- gbrain now reads `EXA_API_KEY`, for an opt-in web search in `gbrain dedupe --exa`. Tests now blank it, and gbrain eval
  runs already stripped it by name pattern (the stripped list now names it), because no suite uses that search.

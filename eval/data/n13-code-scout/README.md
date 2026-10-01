# N13 code-intelligence scout corpus

A vendored snapshot of [unjs/pathe](https://github.com/unjs/pathe) at commit `bc7477a01f0bd60ada017add8142c9f9d69ccdc5` (MIT, license in `pathe/LICENSE`): five TypeScript source files, about 1,000 lines. The N13 runner (`eval/runner/n13-code-intelligence.ts`) checks every file against `manifest.json` before it imports anything; a mismatch names the file and both hashes and voids the run.

Files carry a `.txt` suffix so this repository's TypeScript build never compiles them; the runner imports each one under its upstream path (`src/_path.ts`, and so on). The bytes are unchanged. `bun eval/generators/n13-code-scout-vendor.ts --check` downloads the same files from GitHub at the pinned commit and compares hashes (needs network; CI never runs it).

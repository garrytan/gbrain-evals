# Agents working on gbrain-evals

Read [CLAUDE.md](CLAUDE.md) before any task. It is the operating guide for every agent in this repository: Codex,
Cursor, Capy, Claude Code and others. It covers the repository map, evidence rules, running and publishing work, model
selection and how to match a change to a useful test.

Model selection, in short (full rules in [CLAUDE.md, "Choose models"](CLAUDE.md#choose-models)): gbrain and gstack are
built for frontier models, so every model-comparison run tests them on the newest frontier Opus and GPT (today
`claude-opus-5-5` and `gpt-6.2-sol`), plus `particle-1` as the primary low-cost model. The primary models are
`claude-opus-5-5` and `particle-1`, and a run's first table shows both with cost per correct answer. Sonnet and Haiku
are no longer required, and they are never models under test (agents, readers, optimization targets) or stand-ins for a
frontier model, unless a run asks a question about that tier and says so. Judges are separate: a protocol's judge stays,
and a cheaper judge is fine where the protocol allows one, as long as no model judges its own family's rows.
particle-1 never judges a counted cell, and it reads for development loops that it has passed an agreement test
for. Fable runs only in smoke tests, never in counted cells. A run drops older generations unless one is the single link
to the previous eval's results (`gpt-4.1-mini` only as that bridge to earlier BEAM runs), and it never runs
gpt-5.4-mini. gpt-4o and gpt-4o-mini are suspended (Garry, 2026-11-21): a campaign registered on or after that date
uses neither in any role we choose, judges included, its registry entry lists every model with its role, and CI and
the launch check refuse a suspended one in that list. A compared system's shipped default is tested as shipped (role
`system-internal`), and earlier campaigns and published rows keep their models.

gbrain build, in short (full rules in [CLAUDE.md, "Choose the gbrain build"](CLAUDE.md#choose-the-gbrain-build)): every new run
measures gbrain's newest release tag on master at launch (`bun eval/runner/gbrain-pin.ts bump` moves the pin), an
experiment's build freezes once its counted runs start, and an older build runs only when the question is about it.

Top-level docs, in short (full rules in [CLAUDE.md, "Shape of a top-level document"](CLAUDE.md#shape-of-a-top-level-document)):
README.md, the hub pages in `docs/` and the guides in `eval/` open with what gbrain does at the commit `package.json`
pins, in present tense, and end with a `## Changelog` of how that document changed, newest first. Replace a superseded
claim instead of appending an update beside it, and add the changelog entry in the same commit.
README's current state is three parts: what gbrain does, current results, and how gbrain compares with other systems.

## Changelog

### 2026-11-21: gpt-4o and gpt-4o-mini suspended for new campaigns

The model summary adds the suspension and the per-entry model list that CI and the launch check read. Earlier history
of this file is in CHANGELOG.md.

# Agents working on gbrain-evals

Read [CLAUDE.md](CLAUDE.md) before any task. It is the operating guide for every agent in this repository: Codex,
Cursor, Capy, Claude Code and others. It covers the repository map, evidence rules, running and publishing work, model
selection and how to match a change to a useful test.

Model selection, in short (full rules in [CLAUDE.md, "Choose models"](CLAUDE.md#choose-models)): every
model-comparison run includes the newest frontier Opus, GPT and Sonnet models (today `claude-opus-5-5`,
`claude-sonnet-5-5` and `gpt-6.1-sol`). Fable runs only in smoke tests, never in counted cells. A run drops older
generations unless one is the single link to the previous eval's results (`gpt-4.1-mini` only as that bridge to
earlier BEAM runs), and it never runs gpt-5.4-mini.

Top-level docs, in short (full rules in [CLAUDE.md, "Shape of a top-level document"](CLAUDE.md#shape-of-a-top-level-document)):
README.md, the hub pages in `docs/` and the guides in `eval/` open with what gbrain does at the commit `package.json`
pins, in present tense, and end with a `## Changelog` of how that document changed, newest first. Replace a superseded
claim instead of appending an update beside it, and add the changelog entry in the same commit.
README's current state is three parts: what gbrain does, current results, and how gbrain compares with other systems.

# Agents working on gbrain-evals

Read [CLAUDE.md](CLAUDE.md) before any task. It is the operating guide for every agent in this repository: Codex,
Cursor, Capy, Claude Code and others. It covers the repository map, evidence rules, running and publishing work, model
selection and how to match a change to a useful test.

Model selection, in short (full rules in [CLAUDE.md, "Choose models"](CLAUDE.md#choose-models)): every
model-comparison run includes the newest frontier Opus, GPT, Sonnet and Fable models. It drops older generations
unless one is the single link to the previous eval's results, and it never runs gpt-5.4-mini.

Top-level docs, in short (full rules in [CLAUDE.md, "Shape of a top-level document"](CLAUDE.md#shape-of-a-top-level-document)):
README.md, the hub pages in `docs/` and the guides in `eval/` open with what gbrain does at the commit `package.json`
pins, in present tense, and end with a `## Changelog` of how that document changed, newest first. Replace a superseded
claim instead of appending an update beside it, and add the changelog entry in the same commit.

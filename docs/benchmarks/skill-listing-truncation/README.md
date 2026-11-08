# Skill-listing truncation scripts

Scripts behind [skill-listing-truncation.md](../skill-listing-truncation.md). Nothing here calls a model.

| File | What it does |
|---|---|
| `lengths.ts` | Reads public skill repositories and writes `description-lengths.json` (skill names and description lengths only, with each source's commit and licence). |
| `catalog.ts` | Builds the seeded synthetic catalogs (seed 377; 50, 150, 300, 750 and 1,500 skills, each a prefix of one 1,500-skill list). |
| `capture-server.ts` | A local stand-in for the model API. Records each request body and returns a canned "OK" in Anthropic Messages, OpenAI Responses or Chat Completions format. |
| `run.ts` | Installs each catalog where a harness reads user skills, runs one turn against the capture server, parses the skill listing out of the captured request and writes `results/<harness>.json` and `results/listings/<harness>-300.txt`. |
| `claude-code-rule.py` | Prints the skill-listing budget code bundled in the Claude Code binary (Claude Code is not open source, so this stands in for a file and line). |

## Rerun

Install the pinned harnesses under `/tmp/sl-h` (the npm postinstall scripts must run; npm 12 asks for approval). The path matters for OpenClaw: its listing counts each skill's file path toward an 18,000-character budget, and its own skills live under the install directory.

```bash
mkdir -p /tmp/sl-h && cd /tmp/sl-h
npm i @anthropic-ai/claude-code@2.1.312 @openai/codex@0.165.0 openclaw@2026.10.6
npm install-scripts approve @anthropic-ai/claude-code && node node_modules/@anthropic-ai/claude-code/install.cjs
git clone --depth 1 --branch v2026.9.24 https://github.com/NousResearch/hermes-agent.git hermes
(cd hermes && uv venv -p 3.12 .venv && VIRTUAL_ENV=.venv uv pip install -e .)
```

Then, from the gbrain-evals root (about 25 minutes; each cell runs twice to check the listing is byte-identical):

```bash
bun docs/benchmarks/skill-listing-truncation/run.ts \
  --claude /tmp/sl-h/node_modules/.bin/claude --codex /tmp/sl-h/node_modules/.bin/codex \
  --openclaw /tmp/sl-h/node_modules/.bin/openclaw --hermes /tmp/sl-h/hermes/.venv/bin/hermes
```

`--only <claude-code|codex|hermes|openclaw>` and `--sizes 50,300` narrow the run. Each cell's home is `/tmp/sl/<two letters>/alice`
(16 characters, about as long as `/home/alice-example`, and outside any directory with its own `.claude/skills`, which
Claude Code would also read). Published results and listings replace that home with `<HOME-alice-16c>` and
`/tmp/sl-h/node_modules/` with `<harness-node_modules>/`, placeholders of the same length, so every character count in
`results/` matches the listing files byte for byte. No provider key is needed: every harness gets a dummy key and a local base URL.

Run one invocation at a time. Every run reuses the same scratch homes, capture files and local port, and deletes the
previous cell's scratch state first. `run.ts` writes each harness's version label from its own pins, not from the binary,
so check that each binary's `--version` matches those pins before a rerun. A run narrowed with `--only` and `--sizes`
merges its cells into the existing results file.

To regenerate the length distribution: `bun lengths.ts --gbrain <gbrain checkout> --gstack <gstack checkout>
--anthropic <anthropics/skills checkout> > description-lengths.json`. The catalogs change only if this file does.

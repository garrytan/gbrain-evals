# Skill-listing truncation: where Claude Code, Codex, Hermes and OpenClaw stop showing every skill

Written 2026-11-07 for Step 0 of the gbrain skill resolver plan (GBRA-377, GST-1860). The decision rule and method are in
[the preregistration](2026-11-07-skill-listing-truncation-preregistration.md).

**Finding: all four harnesses cut skill descriptions, drop skill names, or both, at 300 skills or fewer.** An agent harness
tells the model which skills are installed with a listing in its prompt: each skill's name and a short description of when
to use it. The model can only pick a skill it can see described. With synthetic catalogs whose description lengths follow
public skill repositories, Claude Code 2.1.312 keeps every name but drops descriptions from 150 skills on, Codex 0.165.0
shortens descriptions from 150 skills on (every one from 300) and drops names from 750, OpenClaw 2026.10.6 shortens descriptions at 50
skills and drops names from 150, and Hermes v2026.9.24 caps every description at 60 characters at any catalog size but
never drops a name. No model was called: each harness ran one turn against a local server that recorded the request.

| Harness | First catalog size with a cut | What is cut | Truncates or compacts at <= 300 skills |
|---|---|---|---|
| Claude Code 2.1.312 | 150 (78 of 150 descriptions omitted) | Descriptions, names never | **yes** |
| Codex 0.165.0 | 150 (105 of 150 descriptions shortened) | Descriptions from 150, names from 750 | **yes** |
| OpenClaw 2026.10.6 | 50 (32 of 50 descriptions shortened) | Descriptions from 50, names from 150 | **yes** |
| Hermes v2026.9.24 | 50 (fixed 60-character cap on every description) | Descriptions only, at any size | **yes**, by a fixed per-skill cap rather than a budget |

Under the plan's rule, Claude Code and Codex, the two harnesses PR B targets, both qualify for the per-turn hook lane.

## The concrete case

Picture a user who installs gbrain's 75 bundled skills and gstack's 63 skills into Claude Code: with the 8 skills Claude
Code ships itself, about 150 skills. Claude Code's listing budget for its default model is 30,000 characters. In our
150-skill catalog, whose descriptions have the lengths public skills have, the skills are listed alphabetically, the first
71 keep their descriptions, and from the 72nd on nearly every skill appears as a bare name such as `- weekly-migrate`, so
the model has to guess what it does from the name. Nothing tells the user: the only trace is a warning in the `--debug`
log. All skill names in this report's own catalogs are invented placeholders
(`pricing-transcript`, `inbox-feedback`).

## The experiment

**Catalogs.** `catalog.ts` builds one seeded list of 1,500 synthetic skills (seed 377); the catalog of size N is its first
N skills, for N = 50, 150, 300, 750 and 1,500. Each skill has a two-word placeholder name and a filler description whose
length is drawn from real public skills: pick one of three sources with equal probability, then one of its skills, and
use that skill's description length. `lengths.ts` measured the sources at these commits:

| Source | Commit | Licence | Skills | Median description chars | Mean | Max |
|---|---|---|---|---|---|---|
| gbrain bundled skills (`skills/*/SKILL.md`) | ff11cb91 | MIT | 75 | 335 | 351 | 822 |
| gstack skills | 118207f0 | MIT | 63 | 74 | 81 | 208 |
| anthropics/skills (`skills/*/SKILL.md`) | 2c5958ec | Apache-2.0 per skill; `doc-coauthoring` has no licence file and is excluded | 18 | 322 | 497 | 1,068 |

The resulting catalogs have a median description of 200 to 232 characters and a mean of 275 to 313, depending on size.
Only names and lengths are stored ([description-lengths.json](skill-listing-truncation/description-lengths.json)).

**Harnesses.** The npm packages `@anthropic-ai/claude-code@2.1.312`, `@openai/codex@0.165.0` and `openclaw@2026.10.6`,
and Hermes Agent built from tag `v2026.9.24`. Each cell gets a fresh home directory, the catalog goes where the harness reads
a user's own skills (`~/.claude/skills`, `~/.agents/skills`, `~/.hermes/skills/synthetic`, the OpenClaw workspace's
`skills/`), and skills the harness ships itself stay installed and are counted separately as "other". Paths count
toward OpenClaw's character budget, so every cell's home is `/tmp/sl/<two letters>/alice` (16 characters) and the npm
harnesses are installed under `/tmp/sl-h`; the published results replace those prefixes with placeholders of the same
length (`<HOME-alice-16c>`, `<harness-node_modules>/`), so the recorded listing sizes match the run.

**Capture.** [capture-server.ts](skill-listing-truncation/capture-server.ts) stands in for the model API: Claude Code
through `ANTHROPIC_BASE_URL`, Codex through `openai_base_url` in its config, OpenClaw through
`models.providers.anthropic.baseUrl`, Hermes through a custom endpoint. It saves the request and answers "OK". The listing is
parsed out of the saved request. Each harness ran with its default model (Claude Code: `claude-opus-5-5`; Codex:
`gpt-6.1-sol`), OpenClaw with `anthropic/claude-opus-5-5` from its bundled catalog, and Hermes with a custom endpoint
named `claude-opus-5-5` (Hermes's listing does not depend on the model). Every cell ran twice; all 20 listings were
byte-identical across the two runs.

**Metrics.** Listed: synthetic skills whose name appears. Description full, cut (a strict prefix of the original, ignoring an
ellipsis) or omitted. Listing size: the harness's whole skills section in characters, and approximate tokens at 4
characters per token.

## Results

Skills listed and description characters kept count the synthetic skills only. "Other" is the harness's own skills,
listed in the same section.

### Claude Code 2.1.312 (`claude-opus-5-5`, listing budget 30,000 characters)

| Catalog | Listed | Names dropped | Descriptions full / cut / omitted | Description chars kept, mean (original mean) | Listing chars | Approx tokens | Other listed |
|---|---|---|---|---|---|---|---|
| 50 | 50 | 0 | 50 / 0 / 0 | 275 (275) | 18,886 | 4,722 | 8 |
| 150 | 150 | 0 | 72 / 0 / 78 | 143 (294) | 28,222 | 7,056 | 8 |
| 300 | 300 | 0 | 63 / 0 / 237 | 63 (313) | 28,234 | 7,059 | 8 |
| 750 | 750 | 0 | 39 / 0 / 711 | 15 (301) | 28,210 | 7,053 | 8 |
| 1,500 | 1,500 | 0 | 0 / 0 / 1,500 | 0 (303) | 29,135 | 7,284 | 8 |

**Rule.** The budget is the model's context window times a bytes-per-token factor times 1% (`skillListingBudgetFraction`,
default 0.01), or `SLASH_COMMAND_TOOL_CHAR_BUDGET` when set. Claude Code's own debug log reports it: `Skill listing over
budget: 313 skills, 105634 chars > 30000 budget` at 300 skills. Each description is first capped at 1,536 characters
(`skillListingMaxDescChars`) with an ellipsis. When the listing is over budget, every skill becomes a bare name; skills
Claude Code ships keep their descriptions; the others get theirs back in priority order (a usage score, equal on a fresh
install) for as long as each fits, first fit. Names are never dropped, so at 1,500 skills the listing is names only and keeps no description.
Order: user skills alphabetically, then Claude Code's own skills. With no usage history, descriptions go to the first
skills alphabetically: at 150 the 72nd skill is the first without one, and one later skill still fits. Claude Code is not
open source; the rule is the JavaScript bundled in `bin/claude.exe` (sha256 4f4178ce…), printed by
[claude-code-rule.py](skill-listing-truncation/claude-code-rule.py) around the string `Skill listing over budget`. The only
signal is that debug-log warning.

### Codex 0.165.0 (`gpt-6.1-sol`, budget 2% of a 272,000-token window = 5,440 tokens)

| Catalog | Listed | Names dropped | Descriptions full / cut / omitted | Description chars kept, mean (original mean) | Listing chars | Approx tokens | Other listed |
|---|---|---|---|---|---|---|---|
| 50 | 50 | 0 | 50 / 0 / 0 | 275 (275) | 18,436 | 4,609 | 4 |
| 150 | 150 | 0 | 45 / 105 / 0 | 88 (294) | 22,147 | 5,537 | 4 |
| 300 | 300 | 0 | 0 / 300 / 0 | 18 (313) | 22,206 | 5,552 | 4 |
| 750 | 401 | 349 | 0 / 0 / 401 | 0 (301) | 21,385 | 5,347 | 4 |
| 1,500 | 400 | 1,100 | 0 / 0 / 400 | 0 (303) | 21,414 | 5,354 | 4 |

**Rule** (source at tag `rust-v0.165.0`):
- Budget: 2% of the model's context window in tokens, or 8,000 characters when the window is unknown
  ([render.rs:20-23](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L20-L23), [render.rs:128](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L128)); the
  window for `gpt-6.1-sol` is 272,000 ([models.json:206](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/models-manager/models.json#L206)). Token cost is bytes / 4.
- Each description is first capped at 1,024 characters with "..." ([render.rs:24](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L24),
  [render.rs:1118](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L1118)); 3 skills at 150 and 6 at 300 also hit this cap.
- If every full line fits, all are kept ([render.rs:340](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L340)). If every bare line fits,
  description characters are handed out one at a time round-robin, so all descriptions shrink together
  ([render.rs:350](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L350), [render.rs:416-429](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L416-L429)): at 150
  skills they end near 100 characters, at 300 near 18. Otherwise every description is removed and bare lines are kept
  first fit in listing order, the rest omitted ([render.rs:361-372](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L361-L372)).
- Order: user skills by name ([loader/host_merge.rs:241](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/loader/host_merge.rs#L241)); Codex's four
  system skills came before them in every cell. The listing goes into a developer message.
- Signal: Codex prints `Exceeded skills context budget. All skill descriptions were removed and 349 additional skills were
  not included in the model-visible skills list.` only when names are dropped
  ([render.rs:96](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/ext/skills/src/render.rs#L96)). Shortened descriptions at 150 and 300 produce no message.

### OpenClaw 2026.10.6 (`anthropic/claude-opus-5-5`)

| Catalog | Listed | Names dropped | Descriptions full / cut / omitted | Description chars kept, mean (original mean) | Listing chars | Approx tokens | Other listed |
|---|---|---|---|---|---|---|---|
| 50 | 50 | 0 | 18 / 32 / 0 | 74 (275) | 18,731 | 4,683 | 22 |
| 150 | 115 | 35 | 0 / 0 / 115 | 0 (294) | 18,660 | 4,665 | 18 |
| 300 | 122 | 178 | 0 / 0 / 122 | 0 (313) | 18,717 | 4,680 | 12 |
| 750 | 127 | 623 | 0 / 0 / 127 | 0 (301) | 18,725 | 4,682 | 7 |
| 1,500 | 132 | 1,368 | 0 / 0 / 132 | 0 (303) | 18,728 | 4,682 | 2 |

**Rule** (source at tag `v2026.10.6`):
- Discovery: from a skills folder with more than 300 subfolders (`maxCandidatesPerRoot`) only 300 are scanned, and at most
  200 skills load per source (`maxSkillsLoadedPerSource`)
  ([skill-root-discovery.ts:20-21](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-root-discovery.ts#L20-L21),
  [:471](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-root-discovery.ts#L471), [:501-503](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-root-discovery.ts#L501-L503),
  [skill-root-loader.ts:376](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-root-loader.ts#L376)). At 750 and 1,500 skills only 200 of ours
  reach the next step, and in our runs the survivors were the alphabetically first.
- Listing: all skills, bundled ones included, are sorted by name, the first 150 kept (`maxSkillsInPrompt`), and the
  rendered catalog must fit 18,000 characters (`maxSkillsPromptChars`)
  ([skill-prompt-limits.ts:9-10](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-prompt-limits.ts#L9-L10),
  [:98-100](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-prompt-limits.ts#L98-L100)). If the full format does not fit, it switches to a compact
  format: when even names alone overflow, it keeps the longest fitting prefix of names with no descriptions; otherwise it
  shortens every description to the longest common length that fits, at most 220 characters
  ([:127-173](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-prompt-limits.ts#L127-L173),
  [skill-contract.ts:42](https://github.com/openclaw/openclaw/blob/v2026.10.6/src/skills/loading/skill-contract.ts#L42)). At 50 skills that common length was 83 characters.
  The 18,000 characters include each skill's file path, so a longer home directory or install path lists fewer skills;
  these counts hold for the fixed paths described under Harnesses.
- Signal: the prompt itself carries the notice, for example `⚠️ Skills truncated: included 134 of 222 (compact format,
  descriptions omitted)` at 300 skills; the discovery cut is only a stderr warning (`Skills root has many entries,
  truncating discovery. ... childDirCount=750 maxCandidatesPerRoot=300 maxSkillsLoadedPerSource=200`).

### Hermes v2026.9.24 (one-shot `hermes chat -q`)

| Catalog | Listed | Names dropped | Descriptions full / cut / omitted | Description chars kept, mean (original mean) | Listing chars | Approx tokens | Other listed |
|---|---|---|---|---|---|---|---|
| 50 | 50 | 0 | 10 / 40 / 0 | 55 (275) | 9,742 | 2,436 | 53 |
| 150 | 150 | 0 | 21 / 129 / 0 | 55 (294) | 17,805 | 4,452 | 53 |
| 300 | 300 | 0 | 38 / 262 / 0 | 55 (313) | 29,776 | 7,444 | 53 |
| 750 | 750 | 0 | 103 / 647 / 0 | 55 (301) | 65,864 | 16,466 | 53 |
| 1,500 | 1,500 | 0 | 213 / 1,287 / 0 | 55 (303) | 125,967 | 31,492 | 53 |

**Rule** (source at tag `v2026.9.24`): every description longer than 60 characters is cut to 57 plus "..."
([agent/skill_utils.py:763](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/agent/skill_utils.py#L763), [:772-775](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/agent/skill_utils.py#L772-L775)), so every cut
here comes from that fixed cap. The index is grouped by category, categories and names sorted
([agent/prompt_builder.py:1364](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/agent/prompt_builder.py#L1364), [:1372](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/agent/prompt_builder.py#L1372)), and
entries are never dropped ([:1353](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/agent/prompt_builder.py#L1353)). In coding sessions some categories collapse to a
names-only line ([:1367](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/agent/prompt_builder.py#L1367),
[agent/system_prompt.py:309-313](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/agent/system_prompt.py#L309-L313)); our synthetic category was not collapsed. Skills
whose conditions exclude the session are hidden. Hermes copies its own 53 listed skills into `~/.hermes/skills` on first
run. The listing grows by about 80 characters per skill with no ceiling: 31,000 tokens at 1,500 skills. No notice is
printed.

## Cross-check with an independent measurement

HARN-52 measured the same pinned harnesses on a 351-skill public catalog with real skill names, also without provider
calls. Where the two differ, the cause is the catalog, not the harness:

| Harness | HARN-52 at 351 skills | This report at 300 (and 750) | Why they differ |
|---|---|---|---|
| Claude Code | 349 listed, last 111 entries without a description, budget about 29,550 chars | All 300 listed, 237 without a description, budget 30,000 chars | 30,000 is the number Claude Code's own debug log prints for the default model with no settings; HARN-52 computed theirs from the formula. Both see alphabetical first-fit filling. |
| Codex | All 351 listed, descriptions about 10 chars, no log line | All 300 listed, descriptions 18 chars on average, no log line | More skills share the same 5,440-token budget at 351. Both see no message until names are dropped (from 750 here). |
| OpenClaw | 141 names, no descriptions; first 200 by name loaded past 300 folders | 122 of ours plus 12 bundled (134), no descriptions; the 300/200 cut seen at 750 and 1,500 | The 18,000-character cap counts names and file paths, so name and path length set the count. |
| Hermes | 342 listed; 9 hidden by their own conditions, 41 names twice, 60-char cap | All 300 listed, 60-char cap, no duplicates | Our invented names never collide with Hermes's bundled skills and carry no conditions; real catalogs do. |

## Catalog sizes real installs reach (public data only)

- gbrain ships 75 bundled skills (`skills/manifest.json`) and gstack 63; installed together natively that is 138 skills
  before the harness's own (Claude Code 8, Codex 4) or the user's. That is already past where Claude Code and Codex start
  cutting.
- A public Claude Code issue reports a plugin marketplace of about 230 skills, of which an earlier 2.1 release listed 123
  ([anthropics/claude-code#79503](https://github.com/anthropics/claude-code/issues/79503)).
- Public Codex reports quote the warning with 80 and 146 skills left out of the list
  ([openai/codex#19679](https://github.com/openai/codex/issues/19679),
  [compozy/compozy#314](https://github.com/compozy/compozy/issues/314)), so those installs had more skills than fit in
  Codex's budget even as bare names.
- Single public sources carry thousands: sickn33/agentic-awesome-skills lists 2,926+ installable skills, and a 2026 study
  collected 26,502 skills published on OpenClaw's ClawHub registry ([arXiv:2604.13064](https://arxiv.org/abs/2604.13064)).
  These are libraries to pick from, not single installs.

So 300 skills is a size users reach, and the plan's 300-skill line holds on public evidence as well as on its own.

## What this means for the resolver

- **Claude Code and Codex qualify for PR B's per-turn hook lane.** Both cut descriptions from 150 skills, silently on
  Claude Code and silently on Codex until names start dropping.
- **OpenClaw is the most aggressive**: at 300 skills it shows 122 of ours as bare names, and past 300 skill folders it
  never loads most of them. Its per-turn path is AlphaClaw's `before_prompt_build` adapter, not PR B.
- **Hermes never hides a name**, but every description is capped at 60 characters at any size and its listing grows without a
  limit, so at 1,500 skills it spends about 31,000 tokens per turn on the list. Its per-turn path is `pre_llm_call`.
- **Ordering is alphabetical in all four.** With no usage history, the skills that keep their descriptions in Claude Code,
  and the names that survive in Codex and OpenClaw, are the alphabetically first ones, unrelated to the task.

## Limits

- One turn per cell, a fresh home, default settings. Claude Code's priority order uses a usage score, so on a used install
  the most-used skills keep their descriptions rather than the alphabetically first.
- Budgets depend on the model. Claude Code's and Codex's scale with the context window; a smaller-window model gets a
  smaller listing.
- Synthetic descriptions are filler text with realistic lengths; they say nothing about which skill a model would pick.
- Claude Code's `--debug` run (used only to read the budget) listed 5 more of Claude Code's own skills than the normal run.
- Hermes ran in one-shot mode (`-q`), which changes the listing's lead-in text but not its entries.

## Reproduce and inspect

Commands, install steps and file descriptions are in [skill-listing-truncation/README.md](skill-listing-truncation/README.md).
A full run takes about 25 minutes on a 4-core machine and needs no API key; it made no model calls and cost nothing beyond
machine time. Per-cell results: [results/](skill-listing-truncation/results/) (`claude-code.json`, `codex.json`,
`hermes.json`, `openclaw.json`, each with the listing's sha256, ordering checks and any notice). The full listing each
harness sent at 300 skills is in [results/listings/](skill-listing-truncation/results/listings/).

## Disclosures

Disclosure: Y Combinator, which Garry Tan runs, is an investor in Hermes.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

Disclosure: OpenAI is now the key benefactor of OpenClaw, and OpenClaw's creator, Peter Steinberger, works for OpenAI.

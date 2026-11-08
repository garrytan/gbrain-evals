# Skill-listing truncation preregistration: at what catalog size does each harness stop showing every skill?

Status: written 2026-11-07 by GBRA-377 for Step 0 of the GBrain skill resolver plan (GST-1860), which Garry approved.
The decision rule below is the plan's own, fixed before any measurement. This file was written after a 50-skill smoke
run that checked the capture server and the listing parsers, and while the main run was in progress. The measurement is
deterministic (each cell runs twice and the listing must be byte-identical), makes no model call and costs no API money,
so there is no sampling choice for this file to protect. It records the rule and the method so the report can be
checked against them.

## Question

gbrain's skill resolver plan wires a per-turn skill hook (PR B) into a harness only if that harness's own skill listing
stops showing every installed skill, or stops showing their descriptions, at a catalog size users reach. For Claude Code
2.1.312, Codex 0.165.0, Hermes v2026.9.24 and OpenClaw 2026.10.6: at what catalog size do names or descriptions get cut,
dropped or compacted?

## Evidence class

Measurement of shipped harness behavior. No tuning, no labels, no judge.

## Build and data

- Harnesses: `@anthropic-ai/claude-code@2.1.312` and `@openai/codex@0.165.0` from npm, `openclaw@2026.10.6` from
  npm, Hermes Agent at tag `v2026.9.24` (f97608f1) installed from source. Source citations use Codex tag
  `rust-v0.165.0` (360319d8), OpenClaw tag `v2026.10.6` (fe06181d) and Hermes tag `v2026.9.24`.
- Description lengths: `skill-listing-truncation/description-lengths.json`, written by `lengths.ts` from gbrain's
  bundled skills (MIT), gstack's skills (MIT) and the Apache-2.0 skills in anthropics/skills, at the commits it records.
- Catalogs: `catalog.ts`, seed 377, one 1,500-skill master list; the catalog of size N is its first N skills, for N in
  50, 150, 300, 750 and 1,500. Each skill's description length is drawn by picking one of the three sources with equal
  probability, then one of its skills. Names and text are invented placeholders.

## Arms

One cell per harness and catalog size, each run with the prompt "Reply with the single word OK" against
`capture-server.ts`, which records the request and returns a canned reply. Each harness runs with its default settings
and its default or most common model id: Claude Code's default model, Codex's default model, OpenClaw with
`anthropic/claude-opus-5-5` from its bundled catalog, and Hermes with a custom endpoint named `claude-opus-5-5`.
Skills go where each harness reads a user's own skills: `~/.claude/skills`, `~/.agents/skills`,
`~/.hermes/skills/synthetic` and the OpenClaw workspace's `skills/`. Skills the harness ships itself stay installed
and are counted separately.

## Metric and denominator

Per cell, over the N synthetic skills: listed, dropped, descriptions in full, cut, omitted or otherwise altered, mean and
median description characters kept, the listing's size in characters and approximate tokens (characters / 4), the
ordering of listed skills, and any truncation notice. A description is cut when the listed text is a strict prefix of the
original (an ellipsis is ignored).

## Decision rule

A harness "truncates or compacts at 300 skills or fewer" when, in any cell with N <= 300, at least one synthetic skill is
dropped or listed with a cut or omitted description. The report says whether the cut comes from a fixed per-skill cap
that fires at any catalog size or from a listing budget that grows with the catalog. If no public data shows the catalog
sizes real installs reach, the 300-skill line stands on its own, as the plan says.

## What each outcome changes

| If it truncates or compacts at <= 300 | If it does not | If the harness cannot run here |
|---|---|---|
| PR B may wire the per-turn hook lane for it | It gets the CLI only, and the plan records why | Measured from source, labeled as such |

## Budget

No model calls. About 15M Capy tokens for the whole step.

## Amendments

None yet.

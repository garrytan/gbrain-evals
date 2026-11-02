# SkillOpt method benchmark: frontier probe and test-split read, November 2, 2026

Measured on gbrain v0.60.542.0 (`ca1281a2`) with the runner at gbrain-evals `13ae2442` (probe code) and `d4ac793b` (preregistration amendment 3). The targets are `claude-opus-5-5` and `gpt-6.1-sol`, and `claude-opus-5-5` proposed every rewrite. Run and written up in thread GBEV-24 (issue GST-799). [Preregistration](PREREGISTRATION.md): amendment 2 covers the probe and amendment 3 covers the test read, and each was pushed before the calls it covers. [Probe results](probe/frontier/README.md).

## The finding

One rewrite of gbrain's shipped skills, written from 24 training tasks, scored 1.00 on held-out test tasks for all six pairs of skill and frontier model. Each skill was `query`, `briefing` or `fact-check`, and each model was Claude Opus 5.5 or GPT-6.1 Sol. The shipped skill scored 0.47 to 0.78. Each rewrite beat its shipped skill by 0.22 to 0.53, with no task lost, and every comparison survives a Holm correction across the twelve tests. Since one rewrite already reaches the tasks' ceiling, a skill optimizer has nothing left to show on these tasks. The counted optimizer benchmark was therefore not run. Under Garry's null-result rule (R48), the benchmark as designed is a **CUT-CANDIDATE**, and gbrain's SkillOpt loop keeps the CUT-CANDIDATE from the [November 1 re-baseline](../2026-11-01-skillopt-rebaseline/REPORT.md) (preregistered rule 3). gbrain v0.60.542.0 already makes one gated rewrite its default (E1), and this result supports that.

The gain is almost all output form, not better retrieval or reasoning. On the training tasks, the shipped skill's failures were 24 citation checks, 18 `STATUS:` checks and 9 abstention checks, against one wrong value. The rewrites were written from the shared criteria text and the failed check kinds, and they made the skill's own output contract stick: the citation form, one `STATUS:` line, and an abstention that names what is missing.

The shipped skills still help. With the skill, answers beat no skill on five of the six pairs (KEEP). The exception is `query` on GPT-6.1 Sol, where no skill scored 0.86 and the shipped skill 0.72. The preregistered rule calls that a CUT-CANDIDATE, but R48's exposure check fails, so the verdict is **FIX-METHOD**: rollout-path `get_page` failures, rerun after [gbrain#8429](https://github.com/garrytan/gbrain/pull/8429). The whole loss is 6 multi-hop questions, and the shipped skill sends relationship questions to the graph tools, which the SkillOpt rollout path rejected on every call Sol made. The test stage kept scores but not tool calls, so the six lost tasks can't be checked one by one. On the training tasks, 4 of Sol's 6 wrong multi-hop citations came after a failed `traverse_graph`.

One more finding is for gbrain's SkillOpt harness, not for gbrain's users. In the SkillOpt rollout's tool registry, three read tools rejected every call GPT-6.1 Sol made: in the shipped skills' training runs, 607 of 607 `get_page` calls, 38 of 38 `traverse_graph` calls and 6 of 6 `get_backlinks` calls failed. Sol fills in optional arguments with empty or default values (`known_as_of: ""`, `cursor: ""`, `section: ""`, `grep: ""`, `hops: []`), and the rollout registry rejects each one instead of treating it as absent. gbrain's MCP `get_page`, remote and local, already treats an empty string as absent, so GPT users of the MCP surface are not affected. Only three entry points skip that step: the SkillOpt rollout registry, the SkillOpt write-capture registry and `gbrain call` (GBRA-278's diagnosis), and gbrain#8429 fixes them. A keyless reproduction against the rollout's own tool registry gives the errors word for word ([below](#tool-errors-in-the-skillopt-rollout-path)). Every Sol cell in this report and in the [probe](probe/frontier/README.md) ran on that path, and each is marked †. Sol answered from search snippets instead, and every kept Sol rewrite learned to route around the errors, so part of each Sol rewrite's gain may shrink once the fix lands. Opus 5.5 lost 5 of 127 `get_page` calls (four asked for a section heading by name and one for a page that doesn't exist, none to this bug), and none of its 20 `traverse_graph` or 19 `get_backlinks` calls. The Opus cells stand.

## The concrete case

`fact-check` asks for a verdict on a claim a gbrain pipeline produced, for example "Vera Chen founded Mosaic - Consumer Social Startup." Its shipped SKILL.md describes a six-level confidence status. The scorer counts an answer only when one `STATUS:` line gives the status the brain evidence supports. With the shipped skill, Sol failed 13 of the 24 training tasks, every one on the `STATUS:` check: no status line, or one the evidence does not support. Every `get_page` call Sol made had failed in the rollout path ([below](#tool-errors-in-the-skillopt-rollout-path)), and it hedged. The rewrite says to give exactly one `STATUS:` line for the claim as a whole, never to put STATUS on per-part lines, and that tool errors are not evidence. On the 36 test tasks, Sol went from 0.53 to 1.00, and every compound and founder claim the shipped skill missed was now right.

## Results on the sealed test split

36 test tasks per skill. Each arm ran no skill once per task, the shipped skill (seed) 3 times, and the kept rewrite 3 times, and the score is the mean over tasks of the median of runs. Intervals are 95% task-level bootstrap intervals (10,000 resamples). "Wins / losses" counts tasks, with an exact McNemar p. Cost per correct answer is metered USD at list price over correct rollouts. Opus `briefing` scored Sol's kept rewrite, because the leak audit rejected both of Opus's own (amendment 3).

| Target | Skill | No skill | Seed | Rewrite | Seed − no skill | Verdict | Rewrite − seed | Verdict | $ per correct: seed / rewrite |
|---|---|---|---|---|---|---|---|---|---|
| Opus 5.5 | `query` | 0.28 | 0.75 | **1.00** | +0.47 [0.31, 0.64], 17 / 0, p 1.5e-5 | KEEP | +0.25 [0.11, 0.39], 9 / 0, p 0.0039 | rewrite beats seed | $0.16 / $0.10 |
| Opus 5.5 | `briefing` | 0.17 | 0.47 | **1.00** | +0.31 [0.17, 0.44], 11 / 0, p 0.00098 | KEEP | +0.53 [0.36, 0.69], 19 / 0, p 3.8e-6 | rewrite beats seed | $0.74 / $0.10 |
| Opus 5.5 | `fact-check` | 0.00 | 0.78 | **1.00** | +0.78 [0.64, 0.92], 28 / 0, p 7.5e-9 | KEEP | +0.22 [0.08, 0.36], 8 / 0, p 0.0078 | rewrite beats seed | $0.23 / $0.13 |
| GPT-6.1 Sol † | `query` | 0.86 | 0.72 | **1.00** | −0.14 [−0.28, 0.00], 1 / 6, p 0.13 | **FIX-METHOD** (rollout-path `get_page` failures; rerun after gbrain#8429) | +0.28 [0.14, 0.42], 10 / 0, p 0.0020 | rewrite beats seed | $0.033 / $0.026 |
| GPT-6.1 Sol † | `briefing` | 0.17 | 0.58 | **1.00** | +0.42 [0.17, 0.64], 20 / 5, p 0.0041 | KEEP | +0.42 [0.25, 0.58], 15 / 0, p 6.1e-5 | rewrite beats seed | $0.16 / $0.034 |
| GPT-6.1 Sol † | `fact-check` | 0.00 | 0.53 | **1.00** | +0.53 [0.36, 0.69], 19 / 0, p 3.8e-6 | KEEP | +0.47 [0.31, 0.64], 17 / 0, p 1.5e-5 | rewrite beats seed | $0.18 / $0.036 |

† Every cell in a GPT-6.1 Sol row is affected by a harness-path tool failure: the SkillOpt rollout path rejected all of Sol's `get_page`, `traverse_graph` and `get_backlinks` calls ([below](#tool-errors-in-the-skillopt-rollout-path)). The Opus rows are unaffected.

Holm-adjusted across all twelve comparisons, every KEEP and every rewrite-beats-seed stays below 0.02. The Sol `query` seed comparison meets the preregistered CUT-CANDIDATE rule (a point difference of 0 or below) and makes no significance claim (Holm p 0.12). R48's exposure check turns it into a FIX-METHOD ([Why null?](#why-null-r48)). The test split agrees with selection (the [probe](probe/frontier/README.md)) on every pair: every clean rewrite was at 0.92 or 1.00 on selection.

**Where the shipped skill misses**, as tasks right per family on test (no skill / seed / rewrite):

| Target | Skill | Family results |
|---|---|---|
| Opus 5.5 | `query` | multi-hop 0 / 2 / 11 of 11; superseded, record pair and negative all at the ceiling with the seed |
| GPT-6.1 Sol † | `query` | multi-hop 6 / 1 / 11 of 11; every other family at the ceiling even with no skill |
| Opus 5.5 | `briefing` | two meetings 0 / 3 / 20 of 20; with an absent subject 0 / 8 / 10 of 10; negative 6 / 6 / 6 |
| GPT-6.1 Sol † | `briefing` | two meetings 0 / 20 / 20 of 20; with an absent subject 0 / 0 / 10 of 10; negative 6 / 1 / 6 |
| Opus 5.5 | `fact-check` | compound and founder claims 0 / 9 / 14 of 14; superseded, not-founder and negative 0 / 19 / 22 of 22 |
| GPT-6.1 Sol † | `fact-check` | compound and founder claims 0 / 0 / 14 of 14; superseded, not-founder and negative 0 / 19 / 22 of 22 |

† Affected by the same harness-path tool failure.

## Tool errors in the SkillOpt rollout path

These errors come from the SkillOpt rollout's tool registry, which every rollout in this study used, not from gbrain's MCP tools. GBRA-278 found that MCP `get_page`, remote and local, already treats an empty string as absent, and that only the SkillOpt rollout registry, the SkillOpt write-capture registry and `gbrain call` skip that step. gbrain#8429 fixes them. The reproduction below exercises the rollout registry only.

Sol fills in the optional arguments a tool declares, with empty or default values. One `get_page` call from the shipped `fact-check` skill's training run ([proposer input](probe/frontier/f0b-sol/one-shot/sol-fact-check-input.txt)):

```json
{"slug":"contracts/2025-11-21-bwf-renewal-2025","fuzzy":false,"include_content":true,"content_only":false,"body":"full","lines":{"from":1,"count":250},"bytes":{"offset":0,"length":40000},"around_chunk_id":67,"context_lines":20,"cursor":"","max_bytes":40000,"view":"read","outline_from":0,"section":"","grep":"","context":1,"include_deleted":false,"include_timeline_entries":true,"grammar_diagnostics":false,"source_id":"default","include_quarantined":false,"min_trust":"external_untrusted","known_as_of":""}
```

Failed calls per tool, from the training runs each proposer read:

| Tool | Sol `query` | Sol `briefing` | Sol `fact-check` | Opus 5.5, all three skills |
|---|---|---|---|---|
| `get_page` | 5 of 5 | 199 of 199 | 403 of 403 | 5 of 127 |
| `traverse_graph` | 6 of 6 | none called | 32 of 32 | 0 of 20 |
| `get_backlinks` | none called | none called | 6 of 6 | 0 of 19 |

Every `get_page` call of Sol's that parses carried `cursor: ""` and `section: ""` (606 of 606), every `get_backlinks` call carried `cursor: ""`, and 30 of the 38 `traverse_graph` calls carried `hops: []`.

The reproduction needs no provider key. It opens the benchmark brain, builds the rollout's own tool registry through `runRollout` with a stand-in tool loop, and calls each handler with Sol's arguments: all of them, the slug alone, and the slug plus one argument at a time. Run from the repository root at this branch's pin:

```ts
// Run from the repository root with no provider key set:
// env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u VOYAGE_API_KEY -u PARTICLE_API_KEY bun repro.ts
import { runRollout } from 'gbrain/core/skillopt';
import { openBrain } from './eval/runner/skillopt-method/probe.ts';
import { readSeed } from './eval/runner/skillopt-method/dataset.ts';

const sol: Record<string, { slug: string } & Record<string, unknown>> = {
  get_page: { slug: 'people/vera-chen-14', fuzzy: false, include_content: true, content_only: false, body: 'full', lines: { from: 1, count: 200 }, bytes: { offset: 0, length: 20000 }, around_chunk_id: 0, context_lines: 20, cursor: '', max_bytes: 30000, view: 'read', outline_from: 0, section: '', grep: '', context: 1, include_deleted: false, include_timeline_entries: true, grammar_diagnostics: false, source_id: 'default', include_quarantined: false, min_trust: 'external_untrusted', known_as_of: '' },
  traverse_graph: { slug: 'companies/ranger-22', depth: 1, link_type: 'founded', direction: 'both', hops: [], source_id: 'default', all_sources: false },
  get_backlinks: { group: 'page', slug: 'people/vera-chen-14', status: 'live', as_of: '2026-11-02', source_id: 'default', all_sources: false, type: 'company', limit: 100, cursor: '', all: false },
};
const engine = await openBrain();
await runRollout({
  engine, skillText: readSeed('query'), targetModel: 'openai:gpt-6.1-sol',
  task: { task_id: 'repro', task: 'repro' } as any,
  allowedTools: new Set(Object.keys(sol)),
  toolLoopFn: (async ({ toolHandlers }: any) => {
    const run = async (tool: string, args: object) => {
      try { await toolHandlers.get(`brain_${tool}`).execute(args, {}); return 'ok'; } catch (e: any) { return e.message; }
    };
    for (const [tool, args] of Object.entries(sol)) {
      console.log(`${tool}, all of Sol's arguments: ${await run(tool, args)}`);
      console.log(`${tool}, slug only: ${await run(tool, { slug: args.slug })}`);
      for (const [k, v] of Object.entries(args)) {
        if (k === 'slug') continue;
        const r = await run(tool, { slug: args.slug, [k]: v });
        if (r !== 'ok') console.log(`${tool}, slug + ${k}: ${JSON.stringify(v)}: ${r}`);
      }
    }
    return { messages: [], stopReason: 'end', totalTurns: 0, totalUsage: {} };
  }) as any,
});
process.exit(0);
```

Its output, with gbrain's startup lines removed:

```text
get_page, all of Sol's arguments: known_as_of must be an ISO 8601 instant with a zone, for example 2026-10-01T12:00:00Z.
get_page, slug only: ok
get_page, slug + around_chunk_id: 0: get_page: around_chunk_id must be a positive chunk_id from a search result.
get_page, slug + cursor: "": get_page: cursor must be the next_cursor string from the previous window.
get_page, slug + section: "": get_page: section must be a non-empty string of at most 500 characters.
get_page, slug + grep: "": get_page: grep must be a non-empty string of at most 500 characters.
get_page, slug + context: 1: get_page: context applies to grep; pass grep with it.
get_page, slug + known_as_of: "": known_as_of must be an ISO 8601 instant with a zone, for example 2026-10-01T12:00:00Z.
traverse_graph, all of Sol's arguments: traverse_graph: hops cannot be combined with depth, link_type, direction.
traverse_graph, slug only: ok
traverse_graph, slug + hops: []: traverse_graph: hops: hops must be a non-empty array of {link_type, toward}.
get_backlinks, all of Sol's arguments: get_backlinks: cursor is not one this tool returned.
get_backlinks, slug only: ok
get_backlinks, slug + cursor: "": get_backlinks: cursor is not one this listing returned (another slug, direction, source scope or filter, or not a cursor).
```

In the rollout registry, each of `get_page`'s four empty strings (`known_as_of`, `cursor`, `section`, `grep`) fails on its own, and so do two default values: `around_chunk_id: 0` and `context: 1` with no `grep`. `traverse_graph` fails on the empty `hops` array, and `get_backlinks` on the empty `cursor`. Treating empty strings, empty arrays and a zero chunk id as absent fixes seven of the eight. `context: 1` also has to be ignored when there is no `grep`, or `get_page` still fails. Every other argument Sol sends passes.

Opus 5.5's 5 failed `get_page` calls are not this bug. Four asked for a section heading by name (`overview` twice, `timeline` and `3.`), and one asked for `people/chris-davis-49`, a page that does not exist; the reproduction returns `Page not found: people/chris-davis-49` for it. The proposer inputs don't keep error text, and the four section calls' slugs are withheld. On a page without the heading, gbrain returns `get_page: page people/vera-chen-14 has no heading "overview". It has no headings.`

Every kept Sol rewrite tells Sol to route around these errors. The `query` rewrite (`bafc6a5c`) says "These graph/page tools often error; don't stall on them". The `briefing` rewrite (`b35934a9`, which Opus also scored) says "If `get_page` errors, **do not retry the same call repeatedly**." The `fact-check` rewrite (`50331458`) says "**`get_page` fails when you pass many optional parameters.**" Opus's own kept rewrites (`52942b2a`, `a417d566`) have no such lines, and Opus's `query` rewrite still took multi-hop from 2 to 11 of 11. So the citation rule, not the workaround, carries the gain where the tools work.

## Why null? (R48)

**The optimizer benchmark (CUT-CANDIDATE).**
- **Exposure:** the seeds ran as system prompts with every declared tool served, `recall` and `get_timeline` included. 7 of the 12 proposed rewrites passed the audit, and those 7 were scored.
- **Task fit:** the tasks follow each skill's own output contract and come from templated families. A rewrite that learns a family's procedure and the scorer's contract carries across the whole family.
- **Power and saturation:** saturated. Every kept rewrite sits at the 1.00 ceiling on both splits, so no optimizer arm could score higher.
- **Frontier model:** the shipped skills matter on these tasks for both models (KEEP on 5 of 6), so there was something to optimize, and one rewrite took all of it.

This says nothing about tasks where one rewrite falls short. Building those would be a new study.

**The shipped `query` skill on GPT-6.1 Sol (FIX-METHOD: rollout-path `get_page` failures, rerun after gbrain#8429; the preregistered rule says CUT-CANDIDATE).**
- **Exposure: fails.** The skill was the system prompt for every rollout, but the part that decides multi-hop questions never ran as written. For relationship questions, its graph section says to "use the graph layer instead of full-text search", and in the SkillOpt rollout path `traverse_graph` and `get_page` rejected every call Sol made ([above](#tool-errors-in-the-skillopt-rollout-path)). The test stage recorded scores but not tool calls, so the 6 lost test tasks can't be checked one by one. On the 7 multi-hop training tasks, the shipped skill gave Sol 6 wrong citations, and all six named the right founder. 4 came after a failed `traverse_graph`, 2 of those also after a failed `get_page`, and 2 used only `search` with no error. The rollout registry rejects these argument shapes every time, so any graph or page read Sol tried on test failed the same way, in every arm.
- **Task fit:** a multi-hop question such as "Who founded the company that Adam Lopez works with?" counts only when it cites the founder's own page. The shipped skill misses that on both models (Opus 2 of 11, Sol 1 of 11), so its citation guidance has a real gap whatever the tools do. With no skill, Sol got 6.
- **Power:** 7 discordant tasks (1 won, 6 lost), not significant (p 0.13). Each of the 6 losses was 0 of 3 runs with the shipped skill and 3 of 3 with the rewrite.
- **Frontier model without the skill:** Sol with no skill is at the ceiling on every other `query` family.

What would settle it: once gbrain#8429 lands, score Sol with no skill against the shipped skill on fresh multi-hop tasks from the same templates (this test split has had its one read), with each rollout's tool calls recorded. Until then, the shipped skill's gap on multi-hop citations is real on both models, and whether it costs Sol accuracy against no skill is not known.

**The other Sol verdicts.** The same rollout-path tool failures ran under every Sol arm, so every Sol cell is marked affected. Sol's `briefing` and `fact-check` KEEPs and all three Sol rewrite-beats-seed results still hold after the Holm correction on this path. Sol's scores may move once gbrain#8429 lands, and the rewrites' workaround lines are part of their gain. The Opus cells are unaffected and stand.

## What this changes

- **For gbrain:**
  - The rewrites are in [probe/frontier/](probe/frontier/README.md) (`f0b-*/one-shot/*-rewrite-*.txt`, with the kept ones named in each test receipt). Their output-contract sections are candidates for the shipped `query`, `briefing` and `fact-check` skills. They were tuned against this benchmark's criteria text, so review them before adopting any; they are not ready to ship as they are. The Sol rewrites, including the `briefing` rewrite Opus also scored, carry lines that route around gbrain's tool errors; drop those once gbrain#8429 lands.
  - The SkillOpt rollout registry, its write-capture registry and `gbrain call` should treat empty arguments as absent, as MCP `get_page` already does ([reproduction](#tool-errors-in-the-skillopt-rollout-path)). gbrain#8429 is the fix (GBRA-278).
  - E1's one-shot default stands.
- **For this benchmark:**
  - The Sol `query` comparison of no skill and the shipped skill needs a rerun on fresh multi-hop tasks after gbrain#8429. The test stage should record each rollout's tool calls, so an exposure check can use the test tasks themselves.
  - The rollout server, the outside optimizer arms (GEPA, Microsoft SkillOpt, `best_of_n`) and both gbrain loop arms did not run. That includes gbrain at the pin on the B1.7 tag `732ef509` and gbrain from the wave. particle-1 did not run either, because the pin's gateway has no Particle recipe.

## Spend

Metered by the budget ledger at list price from the providers' usage fields:
- frontier probe: $145.04;
- test read: $163.06, against a $220 cap and a $191 estimate;
- earlier Haiku probes: $28.73.

The program total is $336.83, inside the approved $1,000.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.

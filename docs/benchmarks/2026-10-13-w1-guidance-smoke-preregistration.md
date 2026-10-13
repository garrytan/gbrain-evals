# W1 guidance smoke (A12g): preregistration, 2026-10-13

This file fixes the rules of one small agent smoke before any session runs. The smoke decides whether gbrain ships its `recall` `question` guidance: the brain-ops and query skill text that tells an agent to pass the user's question as `recall`'s `question` for question-shaped lookups.

## Why this smoke exists

The guidance was gated on A12, a smoke in which fresh Claude Code sessions see only gbrain's MCP tool descriptions. MCP serves no skill text, so A12 never showed the guidance to the agent. A12 failed twice. In the second run (2026-10-13, after gbrain#6602 fixed the two refusals the first run hit) Opus 5.5 passed 1 of 5 sessions and Fable 5.1 passed 5 of 5. A guided run on the same day put the guidance into each session's CLAUDE.md, and both models passed 5 of 5. That run was set up after the results were seen, so it was ruled descriptive and does not count.

Garry approved one fresh smoke, A12g, in which the guidance reaches the agent the way a user would get it: the gbrain plugin installed natively, with its skills discovered by Claude Code. This file is pushed before any A12g session runs. The run happens once.

## Build

- gbrain master `148b74d14` (v0.60.204.0, gbrain#6602 merged) with the parked guidance commit `c3e65d250` cherry-picked onto it. The result is commit `d5a86e4f80ba97612487dc5c1112d2c05b163494` on branch [`capy/w1-guidance-a12g`](https://github.com/garrytan/gbrain/tree/capy/w1-guidance-a12g). The only conflict was the CHANGELOG, where the guidance bullet moved into its own `[Unreleased]` entry.
- The commit changes skill and guide text only (`skills/brain-ops`, `skills/query`, `docs/guides/ambient-recall.md`, the regenerated `plugin/` and `plugin-variants/` trees, `skills/skills.lock.json`, `CHANGELOG.md`). No source file changes, so the MCP tool descriptions are byte-identical to master's.
- The sessions read a detached worktree of that commit. The MCP servers run from the same worktree (`bun <worktree>/src/cli.ts serve`).

## Loading

Each session gets a fresh `CLAUDE_CONFIG_DIR` and installs the plugin with Claude Code's own plugin commands, from the build worktree's marketplace (`.claude-plugin/marketplace.json`, plugin `gbrain`, which points its skills at `plugin/skills/`):

```
claude plugin marketplace add <worktree>
claude plugin install gbrain@gbrain
```

- Claude Code 2.1.296.
- The working directory is empty: no CLAUDE.md and no other files. The prompt is the A12 prompt below and nothing else. No `--append-system-prompt` or `--system-prompt`, and no text anywhere that mentions the guidance or `question`.
- `--strict-mcp-config` with the A12 MCP config, so the plugin's own `gbrain` MCP server is not started and the agent sees the same two servers A12 used.
- `--allowedTools "mcp__memory,mcp__archive,Skill"`. A12 allowed the two servers. `Skill` is added because a print-mode session cannot load a skill without it. This is the only permission difference from A12.
- `--max-budget-usd 1.50` per session, as a guard for the budget below.

**No-model check, run before this file was written** (`skillcheck.sh` below). It does the same install, then runs `claude -p "/skills"`. Print mode has no `/skills`, but the session's init event lists its skills, plugins and MCP servers before any model call, and the run cost $0:

```
2.1.296 (Claude Code)
Adding marketplace…✔ Successfully added marketplace: gbrain (declared in user settings)
Installing plugin "gbrain@gbrain"...✔ Successfully installed plugin: gbrain@gbrain (scope: user)
claude_code_version: 2.1.296
plugins: ['gbrain@gbrain 0.60.204.0', 'cc-plugin-agents-md@builtin ', 'cc-plugin-telemetry@builtin ', 'cc-plugin-plugin-authoring@builtin ']
mcp_servers: [('memory', 'connected'), ('archive', 'connected')]
skills (%d), gbrain: 93 ['gbrain:academic-verify', 'gbrain:archive-crawler', 'gbrain:article-enrichment', 'gbrain:ask-user', 'gbrain:blog-ingest', 'gbrain:book-mirror', 'gbrain:brain-ingest-gate', 'gbrain:brain-link-discipline', 'gbrain:brain-ops', 'gbrain:brain-pdf', 'gbrain:brain-taxonomist', 'gbrain:briefing', 'gbrain:bulk-ingestion', 'gbrain:capture', 'gbrain:chat-connectors', 'gbrain:citation-fixer', 'gbrain:citation-graph-ingest', 'gbrain:cold-start', 'gbrain:company-brainify', 'gbrain:concept-synthesis', 'gbrain:context-audit', 'gbrain:conversation-archive', 'gbrain:correction-pipeline', 'gbrain:cron-scheduler', 'gbrain:cross-modal-review', 'gbrain:daily-task-manager', 'gbrain:daily-task-prep', 'gbrain:data-loss-gate', 'gbrain:data-research', 'gbrain:db-repair', 'gbrain:draft-in-voice', 'gbrain:eiirp', 'gbrain:enrich', 'gbrain:fact-check', 'gbrain:frontmatter-guard', 'gbrain:functional-area-resolver', 'gbrain:gbrain-advisor', 'gbrain:gbrain-upgrade', 'gbrain:google-loops', 'gbrain:idea-ingest', 'gbrain:idea-lineage', 'gbrain:ingest', 'gbrain:maintain', 'gbrain:mcp-access', 'gbrain:measure-before-you-fix', 'gbrain:media-ingest', 'gbrain:meeting-ingestion', 'gbrain:migrate', 'gbrain:minion-orchestrator', 'gbrain:perplexity-research', 'gbrain:postgres-adopt', 'gbrain:publish', 'gbrain:query', 'gbrain:remote-mcp', 'gbrain:repo-architecture', 'gbrain:reports', 'gbrain:research-compendium', 'gbrain:resolve-before-asking', 'gbrain:schema-author', 'gbrain:schema-unify', 'gbrain:setup', 'gbrain:signal-detector', 'gbrain:skill-autobench', 'gbrain:skill-creator', 'gbrain:skill-optimizer', 'gbrain:skillify', 'gbrain:skillpack-check', 'gbrain:skillpack-harvest', 'gbrain:smoke-test', 'gbrain:soul-audit', 'gbrain:strategic-reading', 'gbrain:testing', 'gbrain:two-tier-extraction', 'gbrain:voice-note-ingest', 'gbrain:webhook-transforms']
Skill tool present: True | ToolSearch present: True
result: "/skills isn't available in this environment." cost_usd: 0 model turns: 0
```

`gbrain:brain-ops` and `gbrain:query` are listed, and the only MCP servers are `memory` and `archive`.

## Same as A12

The prompt and the brain fixtures are A12's.

- The brains are byte copies of the two PGLite brains every A12 run used. `memory` has 73 facts and embeds with `openai:text-embedding-3-small` (1536 dims). `archive` has 3 facts and has embeddings turned off, so `recall` with `question` there returns `facts_degraded: {"reason": "keyword_only_embedding_disabled"}`. The fact texts match `seed.json` exactly (checked before this file was written). All names in them are placeholders.
- The MCP config is A12's with two kinds of path changed: the `serve` entry point (A12 ran the gbrain checkout of the day, A12g runs the build worktree) and `GBRAIN_HOME` (the brain copies). Everything else is identical. A12's `mcp.json` sha256 was `3d40c04cd4d2324e978d1512d6bd898cefd4c6c4c91cdf2188ea7f49051b5e53`.
- One session per run, one prompt, three questions: a plain one, one that invites a filter ("in the last few weeks"), and one on the keyless archive.

## Models and sessions

- `claude-opus-5-5` (Opus 5.5) and `claude-fable-5-1` (Fable 5.1), 5 fresh sessions each. Fable is used because this is a smoke (gbrain-evals model rules: Fable only in small smokes).
- Order: Opus `o1` to `o5`, then Fable `f1` to `f5`, one at a time, by `run-all.sh`.

## Pass rule

Strict, per session, scored by `score-a12g.py` from the session's stream-json transcript. A session passes when all of these hold:

1. **`question`.** At least one `recall` call carries `question` and its response has `facts_order: "relevance"`.
2. **Filtered.** At least one of those `question` calls also carries a filter: `entity`, `since`, `session_id` or `grep`.
3. **Degraded, with the caveat.** At least one of those `question` calls returns `facts_degraded`, and the answer text after the session's last tool call names the limit: it contains one of `keyword`, `exact`, `semantic`, `wording`, `worded` (case-insensitive).

A model passes with at least 4 passing sessions out of 5. **A12g passes only if both models pass.**

`score-a12g.py` is the A12 re-run's `score.py` with two changes: the caveat is read from all answer text after the last tool call (A12's scorer read only the last text block), and it also reports which skills each session loaded and its tool-call count. Neither report enters the rule. On the A12 re-run's tools-only transcripts it gives the same verdicts as before: Opus 1 of 5, Fable 5 of 5.

## Running once

- Each session runs once. Nothing is rerun.
- One exception: a session that ends before its first tool call with an error result, or with no result, is an infra crash. It is replaced once (tag `<tag>r`), and both transcripts are kept and reported.
- Every transcript is kept and summarized in the results: per session, the calls it made, whether it loaded the skill, and the three checks.

## Budget

$8 cap. Expected about $5. A session starts only if the spend so far plus its $1.50 cap stays within $8. A budget stop is reported as is, and the sessions that did not run count as failures.

## Outcome

- **Pass:** the guidance ships in a gbrain PR from current master.
- **Fail:** the guidance stays parked on `capy/w1-guidance-parked`, and this result is published as measured.

## Files, verbatim

### `prompt.txt` (sha256 `d1fe469b503123411bb424f90546635d8dc02a778fb182fc2bdd4eb4f64a6ff1`)

```
You can read my saved memory through two MCP servers: `memory` (my current memory) and `archive` (my notes from before 2024). Answer each question from what I saved, one short line each, and say if anything looked incomplete.

1. Where did I say I'd meet Dana at the conference?
2. What did I most recently decide about the kitchen remodel budget in the last few weeks?
3. From my archive: what happened with the security deposit on my old apartment?
```

### `mcp.json` (sha256 `74f605f918fb055777e9d466ab2a784ec894bf7dfe3b532c5f86efa78b69f0dd`)

`${OPENAI_API_KEY}` is expanded by Claude Code from the environment; no key is in the file.

```json
{
 "mcpServers": {
  "memory": {
   "command": "/home/user/.bun/bin/bun",
   "args": [
    "/home/user/.capy/work/mpw2/a12g/build/src/cli.ts",
    "serve"
   ],
   "env": {
    "GBRAIN_NO_BANNER": "1",
    "GBRAIN_NO_ONBOARD_NUDGE": "1",
    "GBRAIN_NO_SKILL_NAG": "1",
    "GBRAIN_NO_PROBE_PROMPT": "1",
    "GBRAIN_NO_AUTOPILOT_INSTALL": "1",
    "PATH": "/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    "GBRAIN_HOME": "/home/user/.capy/work/mpw2/a12g/brains/mem",
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
   }
  },
  "archive": {
   "command": "/home/user/.bun/bin/bun",
   "args": [
    "/home/user/.capy/work/mpw2/a12g/build/src/cli.ts",
    "serve"
   ],
   "env": {
    "GBRAIN_NO_BANNER": "1",
    "GBRAIN_NO_ONBOARD_NUDGE": "1",
    "GBRAIN_NO_SKILL_NAG": "1",
    "GBRAIN_NO_PROBE_PROMPT": "1",
    "GBRAIN_NO_AUTOPILOT_INSTALL": "1",
    "PATH": "/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    "GBRAIN_HOME": "/home/user/.capy/work/mpw2/a12g/brains/arch"
   }
  }
 }
}
```

### `run-a12g.sh` (sha256 `e1501e980988aba989296a2b6a32d52fd7077eb99c3517e169383409f2463fdd`)

```bash
#!/usr/bin/env bash
# run-a12g.sh <model> <tag>: one fresh A12g session. Fresh CLAUDE_CONFIG_DIR, gbrain plugin installed natively from the
# build's marketplace, empty cwd (no CLAUDE.md), the A12 prompt, the two MCP servers only. Transcript: s-<tag>.jsonl
set -u
model=$1; tag=$2; D=$(cd "$(dirname "$0")" && pwd)
export CLAUDE_CONFIG_DIR="$D/cc-$tag"
rm -rf "$CLAUDE_CONFIG_DIR" "$D/cwd-$tag"; mkdir -p "$CLAUDE_CONFIG_DIR" "$D/cwd-$tag"
claude plugin marketplace add "$D/build" > "$D/install-$tag.log" 2>&1
claude plugin install gbrain@gbrain >> "$D/install-$tag.log" 2>&1
cd "$D/cwd-$tag"
timeout 900 claude -p "$(cat "$D/prompt.txt")" --model "$model" \
  --mcp-config "$D/mcp.json" --strict-mcp-config --allowedTools "mcp__memory,mcp__archive,Skill" \
  --max-budget-usd 1.50 --output-format stream-json --verbose > "$D/s-$tag.jsonl" 2> "$D/s-$tag.err"
echo "session $tag rc=$?"
```

### `run-all.sh` (sha256 `699032f943ffef5ff125f49fe358664646a98bab6a3d99450960e3b6e1a1c5eb`)

```bash
#!/usr/bin/env bash
# run-all.sh: the A12g run, once. Opus 5.5 sessions o1..o5, then Fable 5.1 sessions f1..f5, in order.
# Budget: a session starts only if spent + 1.50 (its --max-budget-usd cap) <= 8.00.
# Replacement: a session that ends before its first tool call with an error result, or with no result, is an infra
# crash and is replaced once (tag <tag>r); the crashed transcript is kept.
set -u
D=$(cd "$(dirname "$0")" && pwd); cd "$D"
spent() { python3 -c '
import json, glob
t = 0.0
for p in glob.glob("s-*.jsonl"):
    for l in open(p):
        try: e = json.loads(l)
        except Exception: continue
        if e.get("type") == "result": t += float(e.get("total_cost_usd") or 0)
print(f"{t:.4f}")'; }
crashed() { python3 -c '
import json, sys
tools = 0; result = None
for l in open(sys.argv[1]):
    try: e = json.loads(l)
    except Exception: continue
    if e.get("type") == "assistant": tools += sum(1 for c in e["message"]["content"] if c.get("type") == "tool_use")
    if e.get("type") == "result": result = e
print("yes" if tools == 0 and (result is None or result.get("is_error")) else "no")' "$1"; }
for spec in claude-opus-5-5:o1 claude-opus-5-5:o2 claude-opus-5-5:o3 claude-opus-5-5:o4 claude-opus-5-5:o5 \
            claude-fable-5-1:f1 claude-fable-5-1:f2 claude-fable-5-1:f3 claude-fable-5-1:f4 claude-fable-5-1:f5; do
  model=${spec%%:*}; tag=${spec##*:}
  if python3 -c "import sys; sys.exit(0 if float('$(spent)') + 1.50 <= 8.00 else 1)"; then :; else echo "budget stop before $tag (spent $(spent))"; break; fi
  ./run-a12g.sh "$model" "$tag"
  if [ "$(crashed "s-$tag.jsonl")" = yes ]; then echo "infra crash in $tag; replacing once as ${tag}r"; ./run-a12g.sh "$model" "${tag}r"; fi
  echo "spent after $tag: $(spent)"
done
```

### `skillcheck.sh` (sha256 `40d0e5029cd660ef34d0bf1bb6d6b24c5638643db2fff586d2e9aa9a2a6339d0`)

```bash
#!/usr/bin/env bash
# skillcheck.sh: no-model check. Same install as run-a12g.sh, then a '/skills' print run: the init event lists the
# session's skills, plugins and MCP servers before any model call (the result costs $0).
set -u
D=$(cd "$(dirname "$0")" && pwd)
export CLAUDE_CONFIG_DIR="$D/cc-check"
rm -rf "$CLAUDE_CONFIG_DIR" "$D/cwd-check"; mkdir -p "$CLAUDE_CONFIG_DIR" "$D/cwd-check"
claude --version
claude plugin marketplace add "$D/build" 2>&1 | tail -1
claude plugin install gbrain@gbrain 2>&1 | tail -1
cd "$D/cwd-check"
claude -p "/skills" --mcp-config "$D/mcp.json" --strict-mcp-config --allowedTools "mcp__memory,mcp__archive,Skill" --output-format stream-json --verbose 2>/dev/null | python3 -c '
import json, sys
for l in sys.stdin:
    e = json.loads(l)
    if e.get("subtype") == "init":
        print("claude_code_version:", e["claude_code_version"])
        print("plugins:", [p["source"] + " " + p.get("version", "") for p in e["plugins"]])
        print("mcp_servers:", [(m["name"], m["status"]) for m in e["mcp_servers"]])
        sk = e["skills"]
        print("skills (%d), gbrain:", len(sk), sorted(s for s in sk if str(s).startswith("gbrain:")))
        print("Skill tool present:", "Skill" in e["tools"], "| ToolSearch present:", "ToolSearch" in e["tools"])
    if e.get("type") == "result":
        print("result:", repr(e.get("result")), "cost_usd:", e.get("total_cost_usd"), "model turns:", e.get("num_turns"))
'
```

### `score-a12g.py` (sha256 `71f8f5819bbb59a0affa3a79edca71ca2adf06ac149add58efbda67a4528b96c`)

```python
import json, sys, glob
def parse(t):
    try: return json.JSONDecoder().raw_decode(t.lstrip())[0]
    except Exception: return None
def score(path):
    calls = {}; res = []; skills = []
    final = ''
    for l in open(path):
        e = json.loads(l)
        if e.get('type') == 'assistant':
            for c in e['message']['content']:
                if c['type'] == 'tool_use': calls[c['id']] = (c['name'], c['input']); final = ''; skills.extend([c['input'].get('skill', c['input'].get('command', ''))] if c['name'] == 'Skill' else [])
                if c['type'] == 'text': final += c['text'] + '\n'
        if e.get('type') == 'user' and isinstance(e['message']['content'], list):
            for c in e['message']['content']:
                if c.get('type') != 'tool_result': continue
                cont = c.get('content'); t = ''.join(x.get('text','') for x in cont if isinstance(x, dict)) if isinstance(cont, list) else str(cont)
                nm, inp = calls.get(c['tool_use_id'], ('?', {}))
                res.append((nm, inp, parse(t), t))
    q = [(n,i,j) for n,i,j,t in res if n.endswith('__recall') and 'question' in i and isinstance(j, dict) and j.get('facts_order') == 'relevance']
    qrel = len(q) > 0
    filt = any(any(k in i for k in ('since','entity','session_id','grep')) for n,i,j in q)
    degr = [ (n,i,j) for n,i,j in q if j.get('facts_degraded') ]
    caveat = any(w in final.lower() for w in ('keyword', 'exact', 'semantic', 'wording', 'worded'))
    refusals = [(n, json.dumps(i)[:120], (j or {}).get('message','')[:90]) for n,i,j,t in res if isinstance(j, dict) and j.get('error')]
    answers = all(k in final for k in ('north entrance', '46,500', '1,800'))
    ok = qrel and filt and bool(degr) and caveat
    tool_calls = len(calls)
    return dict(qrel=qrel, filt=filt, degraded_call=bool(degr), caveat=caveat, answers=answers, PASS=ok, skills=skills, tool_calls=tool_calls, refusals=refusals)
for pat in sys.argv[1:]:
    tot = 0
    for p in sorted(glob.glob(pat)):
        r = score(p); tot += r['PASS']
        print(p, {k: v for k, v in r.items() if k != 'refusals'}, r['refusals'] or '')
    print('==> strict pass', tot, 'of', len(glob.glob(pat)))
```

### `seed.py` (sha256 `518cdcb9b2b8cd787a6f5b3b3dedf8928b44efa847e26597b66ee2f7cdb9a31d`)

```python
import json, random
random.seed(7)
mem = []
# Answer facts (older), then many newer distractors.
mem.append({"fact": "The user agreed to meet dana-example at the north entrance of the convention center at 8:15 on the first conference morning.", "entity": "dana-example", "provenance": "chat 2026-03-02", "valid_from": "2026-03-02"})
mem.append({"fact": "The user set the kitchen remodel budget at $40,000.", "entity": "kitchen-remodel", "provenance": "chat 2026-08-20", "valid_from": "2026-08-20"})
mem.append({"fact": "The user raised the kitchen remodel budget to $46,500 after choosing quartz counters.", "entity": "kitchen-remodel", "provenance": "chat 2026-10-01", "valid_from": "2026-10-01"})
topics = ["gym schedule", "book club", "garden", "car service", "team offsite", "piano lessons", "tax filing", "dog walker", "podcast list", "running shoes"]
for i in range(70):
    t = topics[i % len(topics)]
    day = 3 + (i % 25)
    mem.append({"fact": f"The user noted item {i} about the {t}: keep it on the list for {['Monday','Tuesday','Wednesday','Thursday','Friday'][i%5]}.", "entity": t.replace(' ', '-'), "provenance": f"chat 2026-09-{day:02d}", "valid_from": f"2026-09-{day:02d}"})
arch = [
    {"fact": "The user's old landlord, lee-example, kept the $1,800 security deposit until the carpet was replaced in 2023.", "entity": "lee-example", "provenance": "notes 2023-11-05", "valid_from": "2023-11-05"},
    {"fact": "The user's previous apartment lease ended on 2023-10-31.", "entity": "old-apartment", "provenance": "notes 2023-10-31", "valid_from": "2023-10-31"},
    {"fact": "The user's 2022 bike was stolen from the office rack.", "entity": "bike", "provenance": "notes 2022-06-01", "valid_from": "2022-06-01"},
]
json.dump({"mem": mem, "arch": arch}, open("seed.json", "w"))
print(len(mem), len(arch))
```

### `seed.json` (sha256 `08df94255946a18754d6ae0c20ebeea7fadfb6172270409a9d984411250c0f7f`)

```json
{"mem": [{"fact": "The user agreed to meet dana-example at the north entrance of the convention center at 8:15 on the first conference morning.", "entity": "dana-example", "provenance": "chat 2026-03-02", "valid_from": "2026-03-02"}, {"fact": "The user set the kitchen remodel budget at $40,000.", "entity": "kitchen-remodel", "provenance": "chat 2026-08-20", "valid_from": "2026-08-20"}, {"fact": "The user raised the kitchen remodel budget to $46,500 after choosing quartz counters.", "entity": "kitchen-remodel", "provenance": "chat 2026-10-01", "valid_from": "2026-10-01"}, {"fact": "The user noted item 0 about the gym schedule: keep it on the list for Monday.", "entity": "gym-schedule", "provenance": "chat 2026-09-03", "valid_from": "2026-09-03"}, {"fact": "The user noted item 1 about the book club: keep it on the list for Tuesday.", "entity": "book-club", "provenance": "chat 2026-09-04", "valid_from": "2026-09-04"}, {"fact": "The user noted item 2 about the garden: keep it on the list for Wednesday.", "entity": "garden", "provenance": "chat 2026-09-05", "valid_from": "2026-09-05"}, {"fact": "The user noted item 3 about the car service: keep it on the list for Thursday.", "entity": "car-service", "provenance": "chat 2026-09-06", "valid_from": "2026-09-06"}, {"fact": "The user noted item 4 about the team offsite: keep it on the list for Friday.", "entity": "team-offsite", "provenance": "chat 2026-09-07", "valid_from": "2026-09-07"}, {"fact": "The user noted item 5 about the piano lessons: keep it on the list for Monday.", "entity": "piano-lessons", "provenance": "chat 2026-09-08", "valid_from": "2026-09-08"}, {"fact": "The user noted item 6 about the tax filing: keep it on the list for Tuesday.", "entity": "tax-filing", "provenance": "chat 2026-09-09", "valid_from": "2026-09-09"}, {"fact": "The user noted item 7 about the dog walker: keep it on the list for Wednesday.", "entity": "dog-walker", "provenance": "chat 2026-09-10", "valid_from": "2026-09-10"}, {"fact": "The user noted item 8 about the podcast list: keep it on the list for Thursday.", "entity": "podcast-list", "provenance": "chat 2026-09-11", "valid_from": "2026-09-11"}, {"fact": "The user noted item 9 about the running shoes: keep it on the list for Friday.", "entity": "running-shoes", "provenance": "chat 2026-09-12", "valid_from": "2026-09-12"}, {"fact": "The user noted item 10 about the gym schedule: keep it on the list for Monday.", "entity": "gym-schedule", "provenance": "chat 2026-09-13", "valid_from": "2026-09-13"}, {"fact": "The user noted item 11 about the book club: keep it on the list for Tuesday.", "entity": "book-club", "provenance": "chat 2026-09-14", "valid_from": "2026-09-14"}, {"fact": "The user noted item 12 about the garden: keep it on the list for Wednesday.", "entity": "garden", "provenance": "chat 2026-09-15", "valid_from": "2026-09-15"}, {"fact": "The user noted item 13 about the car service: keep it on the list for Thursday.", "entity": "car-service", "provenance": "chat 2026-09-16", "valid_from": "2026-09-16"}, {"fact": "The user noted item 14 about the team offsite: keep it on the list for Friday.", "entity": "team-offsite", "provenance": "chat 2026-09-17", "valid_from": "2026-09-17"}, {"fact": "The user noted item 15 about the piano lessons: keep it on the list for Monday.", "entity": "piano-lessons", "provenance": "chat 2026-09-18", "valid_from": "2026-09-18"}, {"fact": "The user noted item 16 about the tax filing: keep it on the list for Tuesday.", "entity": "tax-filing", "provenance": "chat 2026-09-19", "valid_from": "2026-09-19"}, {"fact": "The user noted item 17 about the dog walker: keep it on the list for Wednesday.", "entity": "dog-walker", "provenance": "chat 2026-09-20", "valid_from": "2026-09-20"}, {"fact": "The user noted item 18 about the podcast list: keep it on the list for Thursday.", "entity": "podcast-list", "provenance": "chat 2026-09-21", "valid_from": "2026-09-21"}, {"fact": "The user noted item 19 about the running shoes: keep it on the list for Friday.", "entity": "running-shoes", "provenance": "chat 2026-09-22", "valid_from": "2026-09-22"}, {"fact": "The user noted item 20 about the gym schedule: keep it on the list for Monday.", "entity": "gym-schedule", "provenance": "chat 2026-09-23", "valid_from": "2026-09-23"}, {"fact": "The user noted item 21 about the book club: keep it on the list for Tuesday.", "entity": "book-club", "provenance": "chat 2026-09-24", "valid_from": "2026-09-24"}, {"fact": "The user noted item 22 about the garden: keep it on the list for Wednesday.", "entity": "garden", "provenance": "chat 2026-09-25", "valid_from": "2026-09-25"}, {"fact": "The user noted item 23 about the car service: keep it on the list for Thursday.", "entity": "car-service", "provenance": "chat 2026-09-26", "valid_from": "2026-09-26"}, {"fact": "The user noted item 24 about the team offsite: keep it on the list for Friday.", "entity": "team-offsite", "provenance": "chat 2026-09-27", "valid_from": "2026-09-27"}, {"fact": "The user noted item 25 about the piano lessons: keep it on the list for Monday.", "entity": "piano-lessons", "provenance": "chat 2026-09-03", "valid_from": "2026-09-03"}, {"fact": "The user noted item 26 about the tax filing: keep it on the list for Tuesday.", "entity": "tax-filing", "provenance": "chat 2026-09-04", "valid_from": "2026-09-04"}, {"fact": "The user noted item 27 about the dog walker: keep it on the list for Wednesday.", "entity": "dog-walker", "provenance": "chat 2026-09-05", "valid_from": "2026-09-05"}, {"fact": "The user noted item 28 about the podcast list: keep it on the list for Thursday.", "entity": "podcast-list", "provenance": "chat 2026-09-06", "valid_from": "2026-09-06"}, {"fact": "The user noted item 29 about the running shoes: keep it on the list for Friday.", "entity": "running-shoes", "provenance": "chat 2026-09-07", "valid_from": "2026-09-07"}, {"fact": "The user noted item 30 about the gym schedule: keep it on the list for Monday.", "entity": "gym-schedule", "provenance": "chat 2026-09-08", "valid_from": "2026-09-08"}, {"fact": "The user noted item 31 about the book club: keep it on the list for Tuesday.", "entity": "book-club", "provenance": "chat 2026-09-09", "valid_from": "2026-09-09"}, {"fact": "The user noted item 32 about the garden: keep it on the list for Wednesday.", "entity": "garden", "provenance": "chat 2026-09-10", "valid_from": "2026-09-10"}, {"fact": "The user noted item 33 about the car service: keep it on the list for Thursday.", "entity": "car-service", "provenance": "chat 2026-09-11", "valid_from": "2026-09-11"}, {"fact": "The user noted item 34 about the team offsite: keep it on the list for Friday.", "entity": "team-offsite", "provenance": "chat 2026-09-12", "valid_from": "2026-09-12"}, {"fact": "The user noted item 35 about the piano lessons: keep it on the list for Monday.", "entity": "piano-lessons", "provenance": "chat 2026-09-13", "valid_from": "2026-09-13"}, {"fact": "The user noted item 36 about the tax filing: keep it on the list for Tuesday.", "entity": "tax-filing", "provenance": "chat 2026-09-14", "valid_from": "2026-09-14"}, {"fact": "The user noted item 37 about the dog walker: keep it on the list for Wednesday.", "entity": "dog-walker", "provenance": "chat 2026-09-15", "valid_from": "2026-09-15"}, {"fact": "The user noted item 38 about the podcast list: keep it on the list for Thursday.", "entity": "podcast-list", "provenance": "chat 2026-09-16", "valid_from": "2026-09-16"}, {"fact": "The user noted item 39 about the running shoes: keep it on the list for Friday.", "entity": "running-shoes", "provenance": "chat 2026-09-17", "valid_from": "2026-09-17"}, {"fact": "The user noted item 40 about the gym schedule: keep it on the list for Monday.", "entity": "gym-schedule", "provenance": "chat 2026-09-18", "valid_from": "2026-09-18"}, {"fact": "The user noted item 41 about the book club: keep it on the list for Tuesday.", "entity": "book-club", "provenance": "chat 2026-09-19", "valid_from": "2026-09-19"}, {"fact": "The user noted item 42 about the garden: keep it on the list for Wednesday.", "entity": "garden", "provenance": "chat 2026-09-20", "valid_from": "2026-09-20"}, {"fact": "The user noted item 43 about the car service: keep it on the list for Thursday.", "entity": "car-service", "provenance": "chat 2026-09-21", "valid_from": "2026-09-21"}, {"fact": "The user noted item 44 about the team offsite: keep it on the list for Friday.", "entity": "team-offsite", "provenance": "chat 2026-09-22", "valid_from": "2026-09-22"}, {"fact": "The user noted item 45 about the piano lessons: keep it on the list for Monday.", "entity": "piano-lessons", "provenance": "chat 2026-09-23", "valid_from": "2026-09-23"}, {"fact": "The user noted item 46 about the tax filing: keep it on the list for Tuesday.", "entity": "tax-filing", "provenance": "chat 2026-09-24", "valid_from": "2026-09-24"}, {"fact": "The user noted item 47 about the dog walker: keep it on the list for Wednesday.", "entity": "dog-walker", "provenance": "chat 2026-09-25", "valid_from": "2026-09-25"}, {"fact": "The user noted item 48 about the podcast list: keep it on the list for Thursday.", "entity": "podcast-list", "provenance": "chat 2026-09-26", "valid_from": "2026-09-26"}, {"fact": "The user noted item 49 about the running shoes: keep it on the list for Friday.", "entity": "running-shoes", "provenance": "chat 2026-09-27", "valid_from": "2026-09-27"}, {"fact": "The user noted item 50 about the gym schedule: keep it on the list for Monday.", "entity": "gym-schedule", "provenance": "chat 2026-09-03", "valid_from": "2026-09-03"}, {"fact": "The user noted item 51 about the book club: keep it on the list for Tuesday.", "entity": "book-club", "provenance": "chat 2026-09-04", "valid_from": "2026-09-04"}, {"fact": "The user noted item 52 about the garden: keep it on the list for Wednesday.", "entity": "garden", "provenance": "chat 2026-09-05", "valid_from": "2026-09-05"}, {"fact": "The user noted item 53 about the car service: keep it on the list for Thursday.", "entity": "car-service", "provenance": "chat 2026-09-06", "valid_from": "2026-09-06"}, {"fact": "The user noted item 54 about the team offsite: keep it on the list for Friday.", "entity": "team-offsite", "provenance": "chat 2026-09-07", "valid_from": "2026-09-07"}, {"fact": "The user noted item 55 about the piano lessons: keep it on the list for Monday.", "entity": "piano-lessons", "provenance": "chat 2026-09-08", "valid_from": "2026-09-08"}, {"fact": "The user noted item 56 about the tax filing: keep it on the list for Tuesday.", "entity": "tax-filing", "provenance": "chat 2026-09-09", "valid_from": "2026-09-09"}, {"fact": "The user noted item 57 about the dog walker: keep it on the list for Wednesday.", "entity": "dog-walker", "provenance": "chat 2026-09-10", "valid_from": "2026-09-10"}, {"fact": "The user noted item 58 about the podcast list: keep it on the list for Thursday.", "entity": "podcast-list", "provenance": "chat 2026-09-11", "valid_from": "2026-09-11"}, {"fact": "The user noted item 59 about the running shoes: keep it on the list for Friday.", "entity": "running-shoes", "provenance": "chat 2026-09-12", "valid_from": "2026-09-12"}, {"fact": "The user noted item 60 about the gym schedule: keep it on the list for Monday.", "entity": "gym-schedule", "provenance": "chat 2026-09-13", "valid_from": "2026-09-13"}, {"fact": "The user noted item 61 about the book club: keep it on the list for Tuesday.", "entity": "book-club", "provenance": "chat 2026-09-14", "valid_from": "2026-09-14"}, {"fact": "The user noted item 62 about the garden: keep it on the list for Wednesday.", "entity": "garden", "provenance": "chat 2026-09-15", "valid_from": "2026-09-15"}, {"fact": "The user noted item 63 about the car service: keep it on the list for Thursday.", "entity": "car-service", "provenance": "chat 2026-09-16", "valid_from": "2026-09-16"}, {"fact": "The user noted item 64 about the team offsite: keep it on the list for Friday.", "entity": "team-offsite", "provenance": "chat 2026-09-17", "valid_from": "2026-09-17"}, {"fact": "The user noted item 65 about the piano lessons: keep it on the list for Monday.", "entity": "piano-lessons", "provenance": "chat 2026-09-18", "valid_from": "2026-09-18"}, {"fact": "The user noted item 66 about the tax filing: keep it on the list for Tuesday.", "entity": "tax-filing", "provenance": "chat 2026-09-19", "valid_from": "2026-09-19"}, {"fact": "The user noted item 67 about the dog walker: keep it on the list for Wednesday.", "entity": "dog-walker", "provenance": "chat 2026-09-20", "valid_from": "2026-09-20"}, {"fact": "The user noted item 68 about the podcast list: keep it on the list for Thursday.", "entity": "podcast-list", "provenance": "chat 2026-09-21", "valid_from": "2026-09-21"}, {"fact": "The user noted item 69 about the running shoes: keep it on the list for Friday.", "entity": "running-shoes", "provenance": "chat 2026-09-22", "valid_from": "2026-09-22"}], "arch": [{"fact": "The user's old landlord, lee-example, kept the $1,800 security deposit until the carpet was replaced in 2023.", "entity": "lee-example", "provenance": "notes 2023-11-05", "valid_from": "2023-11-05"}, {"fact": "The user's previous apartment lease ended on 2023-10-31.", "entity": "old-apartment", "provenance": "notes 2023-10-31", "valid_from": "2023-10-31"}, {"fact": "The user's 2022 bike was stolen from the office rack.", "entity": "bike", "provenance": "notes 2022-06-01", "valid_from": "2022-06-01"}]}
```

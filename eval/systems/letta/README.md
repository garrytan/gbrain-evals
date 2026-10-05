# Letta: native agent only

Letta Code 0.34.4 with its local backend has no passive memory API, so Letta cannot take part in Memory QA, update
and forget, or PrecisionMemBench. It runs in the shootout only as a native agent on the Cat 40 tasks, in its own
table, as the plan provides. This directory holds the capability record that says so, a shim that serves it, and the
pinned Letta App Server a native-agent driver will connect to.

## What Letta is at this version

The old Letta API server (the Python service with archival memory) is retired. `letta/letta:0.34.4` now contains
Letta Code 0.34.4, a Node CLI and App Server (OCI revision label `f898fda`, the `v0.34.4` tag of
`letta-ai/letta-code`). Its entrypoint refuses the old server's settings. Cloud is the default backend; the local
backend must be selected (`letta backend local`, `--backend local`).

## The capability spike

Question: is there a passive memory API, meaning a way to store sessions and ask for ranked evidence without running
Letta's agent loop? Answer: no. Evidence, from the 0.34.4 bundle and keyless runs on 2026-10-05:

1. **No archival memory locally.** The bundled `letta-client` still has `/v1/agents/{id}/archival-memory` and
   `/v1/passages/search`, but those are Letta Cloud routes. The local backend class (`LocalBackend`, extending
   `HeadlessBackend`) implements agents, conversations, messages, runs and memory files, and nothing else. There is
   no embedder.
2. **Every message write is an agent turn.** `executeConversationTurn` appends the input and runs the model. A
   one-line prompt sent about 8,600 prompt tokens to the provider.
3. **The only passive read is keyword search over raw transcripts.** `letta messages search` uses full-text search
   locally (vector and hybrid modes throw an error). It returns whole messages, including Letta's injected system
   reminders, dated by wall clock, so a session cannot carry its own date.
4. **Memory files can be written passively but not queried.** The App Server's `write_memory_file`,
   `read_memory_file`, `list_memory` and `delete_memory_file` manage Markdown files in a git repository per agent.
   Commits pass validation hooks (each directory needs a `MEMORY.md` index; files have size limits). There is no
   query-ranked read: the agent decides what to load. Returning every file would be a full-context baseline, not
   Letta's retrieval.

So the shim answers `/health` and `/capabilities` and returns `unsupported` for reset, ingest, finish, retrieve and
delete. Wrapping the agent loop and calling it passive memory QA would misdescribe Letta.

## What runs here

- [Dockerfile](Dockerfile): the vendor image pinned by digest, plus the stdlib shim (the image ships Python 3.11).
- [shim.py](shim.py): registers the proxy as an OpenAI-compatible provider (`letta connect openai-compatible
  --base-url $OPENAI_BASE_URL`), starts the App Server (`letta server --listen ws://0.0.0.0:4500 --ws-auth
  capability-token --backend local`) and serves the protocol. `/health` is true only when the App Server answers an
  `app_server_info` handshake with `backend: local`.
- [docker-compose.yml](docker-compose.yml): the same sealed network as the other shims. The shim is published on
  `127.0.0.1:8702`, the App Server on `127.0.0.1:4500`, and its capability token is written to `./run/token`.
- Telemetry and updates off: `LETTA_CODE_TELEM=0`, `DO_NOT_TRACK=1`, `DISABLE_AUTOUPDATER=1`.

Keyless check, from the repository root: `eval/systems/letta/tests/run_keyless.sh`. On 2026-10-05: 7 of 7 protocol
checks pass, the container cannot reach the internet directly, the App Server handshake reports Letta Code 0.34.4,
protocol version 1, backend local, and a headless agent turn made exactly one model call, through the relay to the
fake provider.

## What a native-agent Cat 40 driver needs

The Cat 40 loop supplies tools to a model; Letta runs its own loop. A driver therefore talks to the App Server and
records what Letta does. It needs:

1. **A connection.** WebSocket to `ws://127.0.0.1:4500/ws` with `Authorization: Bearer <token>` from `./run/token`.
   Send `{"type": "app_server_info", "request_id": ...}` and require `backend: "local"` and `protocol_version: 1`.
   Responses echo `request_id`. Message types are declared in the package's `dist/types/types/protocol_v2.d.ts`.
2. **Providers through the proxy.** OpenAI models work through `letta connect openai-compatible` (verified). The
   newest Opus, Sonnet and Fable models need `letta connect anthropic`; the bundled Anthropic SDK reads
   `ANTHROPIC_BASE_URL`, but whether the local Anthropic provider honours it is unverified. Prove it against the
   metering proxy before any Anthropic cell, or that model is `blocked` for Letta. Pass model handles such as
   `openai-compatible/<model>` and check `letta model list --byok`.
3. **One fresh agent per task.** `create_agent` (personality `blank` or `memo`, `model`, `pin_global: false`), then
   `enable_memfs`. Delete it afterwards with `agent_delete`, or use a fresh `letta-home` volume per cell, so no state
   crosses cells.
4. **The task corpus in Letta's own memory.** Two honest options, to be fixed in the preregistration: write the
   company documents as memory files with `write_memory_file` (each directory needs a `MEMORY.md` index, and files
   must stay under the size limit in `.memfs.config.json`), or hand them to the agent as attachments or workspace
   files and let it decide what to remember. Finance-only documents need a separate agent or a separate memory
   directory, because we found no per-document visibility control in the 0.34.4 protocol; record that as the finance capability result.
5. **Turns.** `conversation_create`, then `input` messages with the task prompt; wait for `turn_finished`, collect
   `stream_delta` events and `conversation_messages_list` for the transcript. Two-session tasks reuse the agent in a
   new conversation. Tool approvals arrive as `can_use_tool`; the driver must answer them by a fixed policy.
6. **Cost.** Usage per turn comes from the run (`usage.prompt_tokens`, `completion_tokens`, cache fields) and from the
   metering proxy, which is the number of record. Expect at least about 8,600 prompt tokens per turn from Letta's
   system prompt alone.
7. **Write targets.** Letta writes to its own memory files, not to the harness's canonical targets. Map memory-file
   paths to canonical document ids for scoring, and read memory with `list_memory` after each task.
8. **Its own table.** Letta's loop, prompts and tools differ from the harness loop, so its Cat 40 cells are reported
   separately and never ranked against shared-loop arms.

Proposed home for the driver: `eval/runner/cat40/letta-native.ts` with a canned-transcript test
(`test/eval/cat40-letta.test.ts`, as the engineering review suggested). Both are outside this lane.

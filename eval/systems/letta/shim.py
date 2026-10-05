"""Protocol v1 shim for Letta Code 0.34.4, local backend (see README.md in this directory).

Letta 0.34.4 has no passive memory retrieval API on its local backend: no archival passages, no embeddings and no
query-ranked read. Writes to Letta's memory happen through agent turns or memory-file writes, and only the agent
decides what to read back. So this shim serves the capability record and reports `unsupported` for ingest, retrieve
and delete; Letta runs in the shootout only as a native agent on Cat 40 tasks.

The container also runs the Letta App Server (WebSockets, local backend, capability-token auth) that a native-agent
Cat 40 driver connects to. /health reports whether the App Server answers an `app_server_info` handshake.
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "_shim"))
from shim import Adapter, ShimError, serve  # noqa: E402

CONFIG = os.environ.get("SHIM_CONFIG", "recipe")
APP_SERVER_PORT = int(os.environ.get("LETTA_APP_SERVER_PORT", "4500"))
TOKEN_FILE = Path(os.environ.get("LETTA_WS_TOKEN_FILE", "/run/letta/token"))
CAPABILITY = json.loads((Path(__file__).resolve().parent / "capability.json").read_text())
NO_PASSIVE_API = "Letta Code 0.34.4 local backend has no passive memory retrieval API; Letta runs only as a native agent (capability agent_surface)"

HANDSHAKE = """
const tok = require("fs").readFileSync(process.argv[1], "utf8").trim();
const ws = new WebSocket(`ws://127.0.0.1:${process.argv[2]}/ws`, { headers: { Authorization: "Bearer " + tok } });
ws.onopen = () => ws.send(JSON.stringify({ type: "app_server_info", request_id: "health" }));
ws.onmessage = (m) => { console.log(String(m.data)); process.exit(0); };
ws.onerror = (e) => { console.error(String(e.message || e)); process.exit(1); };
setTimeout(() => process.exit(2), 5000);
"""


def start_app_server() -> subprocess.Popen:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_urlsafe(32))
        TOKEN_FILE.chmod(0o600)
    subprocess.run(["letta", "backend", "local"], check=True, capture_output=True)
    base_url = os.environ.get("OPENAI_BASE_URL")
    if base_url:
        subprocess.run(["letta", "connect", "openai-compatible", "--base-url", base_url, "--api-key", os.environ.get("OPENAI_API_KEY", "dummy")],
                       check=True, capture_output=True)
    return subprocess.Popen(["letta", "server", "--listen", f"ws://0.0.0.0:{APP_SERVER_PORT}", "--ws-auth", "capability-token",
                             "--ws-token-file", str(TOKEN_FILE), "--backend", "local"])


class LettaAdapter(Adapter):
    def __init__(self, server: subprocess.Popen):
        self.server = server

    def capabilities(self) -> dict[str, Any]:
        return CAPABILITY

    def app_server_info(self) -> dict[str, Any] | None:
        out = subprocess.run(["node", "-e", HANDSHAKE, str(TOKEN_FILE), str(APP_SERVER_PORT)], capture_output=True, text=True, timeout=10)
        return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None

    def health(self) -> dict[str, Any]:
        info = self.app_server_info() if self.server.poll() is None else None
        return {"ok": info is not None and info.get("backend") == "local", "config": CONFIG, "passive_memory_api": False,
                "app_server": info, "app_server_port": APP_SERVER_PORT}

    def reset(self, ns: str) -> None:
        raise ShimError("unsupported", NO_PASSIVE_API, 501)

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        raise ShimError("unsupported", NO_PASSIVE_API, 501)

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        if policy.get("mode") not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        raise ShimError("unsupported", NO_PASSIVE_API, 501)

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        raise ShimError("unsupported", NO_PASSIVE_API, 501)


if __name__ == "__main__":
    server = start_app_server()
    time.sleep(1)
    print(json.dumps({"shim": "letta", "config": CONFIG, "app_server_pid": server.pid, "app_server_port": APP_SERVER_PORT}), flush=True)
    serve(LettaAdapter(server))

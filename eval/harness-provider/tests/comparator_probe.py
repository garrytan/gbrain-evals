"""Start the pinned comparator server, retain one document synchronously, stop.

Used by test/eval/comparator-server.test.ts for the zero-balance check: the
server's LLM goes wherever MPW_CHILD_ENV_COMPARATOR points (the metering
proxy). Prints one JSON line: {"status": <retain HTTP status>, "body": ..., "reaped": [...]}.

  python comparator_probe.py <data-dir>
"""
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpw.comparator_server import ComparatorServer, processes_under, upstream_from_env  # noqa: E402


def main(data_dir: str) -> None:
    server = ComparatorServer(Path(data_dir), upstream_from_env(), startup_timeout_s=300)
    with server:
        bank = "c-000000000001"
        httpx.put(f"{server.url}/v1/default/banks/{bank}", json={"name": "probe"}, timeout=60).raise_for_status()
        r = httpx.post(
            f"{server.url}/v1/default/banks/{bank}/memories",
            json={"items": [{"content": "User: I adopted a grey cat named Miso last week.", "document_id": "c-000000000002"}], "async": False},
            timeout=240,
        )
    print(json.dumps({"status": r.status_code, "body": r.text[:300], "left_running": processes_under(server.home)}))


if __name__ == "__main__":
    main(sys.argv[1])

"""Keyless check for preregistration Amendment 5: cognee's embedder gets past OpenAI's 2,048-input limit only with the fix.

Runs inside the keyless stack's cognee container, against the fake provider, which refuses more than 2,048 inputs with
OpenAI's 400 (fake_provider.py). It embeds 5,000 names in one embed_text call, the call consolidate_entities makes:

  docker compose exec -T cognee python - < batch_limit_check.py              # with entity_h2h.py's fix: passes
  docker compose exec -T cognee python - --unpatched < batch_limit_check.py  # without it: the 400 comes back

Prints one JSON line and exits 0 when the outcome is the expected one for the mode, 1 otherwise. It refuses with exit 2,
before it builds an embedder, unless every provider key in the container is the compose file's keyless placeholder: a
paid stack sets them to the cell's token, and the metering proxy refuses requests that carry the placeholder.
"""
import asyncio
import json
import os
import sys

unpatched = "--unpatched" in sys.argv
PLACEHOLDER = "dummy-key-the-proxy-injects-the-real-one"
KEYS = ("OPENAI_API_KEY", "LLM_API_KEY", "EMBEDDING_API_KEY")
if any(os.environ.get(k) != PLACEHOLDER for k in KEYS):
    print(json.dumps({"mode": "unpatched" if unpatched else "patched", "refused": "not the keyless stack: a provider key is set or missing"}))
    sys.exit(2)

sys.path.insert(0, "/app/cognee")
if not unpatched:
    import entity_h2h  # noqa: F401
from cognee.infrastructure.databases.vector.embeddings.get_embedding_engine import get_embedding_engine  # noqa: E402

NAMES = [f"Entity {i}" for i in range(5000)]
try:
    vectors = asyncio.run(get_embedding_engine().embed_text(NAMES))
    out = {"mode": "unpatched" if unpatched else "patched", "embedded": len(vectors), "error": None}
except Exception as error:
    out = {"mode": "unpatched" if unpatched else "patched", "embedded": 0, "error": str(error)[:300]}
print(json.dumps(out))
expected = ("array length must be 2048 or less" in (out["error"] or "")) if unpatched else out["embedded"] == len(NAMES)
sys.exit(0 if expected else 1)

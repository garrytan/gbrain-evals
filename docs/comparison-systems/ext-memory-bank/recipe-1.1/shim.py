"""Hindsight shim, SHIM_CONFIG=recipe-1.1: Hindsight 1.1.0 with its server defaults (protocol v1, see eval/systems/PROTOCOL.md).

The adapter is the 0.10.2 bundle's shim.py, unchanged (copied into the image as hindsight_shim.py). Every
hindsight-client call it makes keeps its signature and response fields at 1.1.0 (capability.json,
client_compatibility), and it reads capability.json from its own directory, which in the image holds this
configuration's record. The one addition is a version check: /health refuses unless the server reports the version
capability.json records, so a different server image cannot pass for this build.
"""
from __future__ import annotations

from typing import Any

import hindsight_shim as base


class Recipe11Adapter(base.HindsightAdapter):
    def health(self) -> dict[str, Any]:
        out = super().health()
        recorded, actual = self.record["versions"]["server_version"], out["server_version"].get("api_version")
        if actual != recorded:
            raise base.ShimError("product_error", f"hindsight server reports version {actual!r}, capability.json records {recorded!r}", 503)
        return out


if __name__ == "__main__":
    base.serve(Recipe11Adapter())

"""memory-bank with observations on: the bundle's shim (shim.py, protocol v1) with each bank created at the server's own
default, so the server consolidates retained facts into observations in the background, as it ships.

The bundle's shim creates every bank with `enable_observations=False`, as the vendor's benchmark ingestion does, so the
scoreboard and the battleground ran retain only. The cost-and-speed experiment
(docs/benchmarks/2026-11-24-cost-speed-preregistration.md) prices the product as shipped, so it starts this stack
(bootstrap.sh --config observations). Everything else, including the recipe's models and the capability record's
configs, is the bundle's; the record's deviations say observations are on. Observations carry no document id, so they
come back with provenance unavailable. In the image shim.py sits beside this file; in the repository it is one directory up.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
_BASE = next(p for p in (os.path.join(HERE, "shim.py"), os.path.join(HERE, "..", "shim.py")) if os.path.exists(p))
_spec = importlib.util.spec_from_file_location("memory_bank_shim", _BASE)
base = importlib.util.module_from_spec(_spec)
sys.modules["memory_bank_shim"] = base
_spec.loader.exec_module(base)

OBSERVATIONS_ON = ("Observations on, the server default (DEFAULT_ENABLE_OBSERVATIONS): each bank is created without "
                   "enable_observations, so the server consolidates in the background; observations carry no document_id.")


BaseAdapter = next(v for k, v in vars(base).items() if k.endswith("Adapter") and k != "Adapter" and isinstance(v, type))


class ObservationsAdapter(BaseAdapter):
    def __init__(self) -> None:
        super().__init__()
        deviations = [OBSERVATIONS_ON if d.startswith("Observations off") else d for d in self.record["deviations_from_vendor_code"]]
        self.record = {**self.record, "deviations_from_vendor_code": deviations}

    def health(self) -> dict[str, Any]:
        return {**super().health(), "observations": "on (server default)"}

    async def _create_bank(self, ns: str) -> None:
        await self.client.acreate_bank(bank_id=ns)
        self.banks.add(ns)


if __name__ == "__main__":
    base.serve(ObservationsAdapter())

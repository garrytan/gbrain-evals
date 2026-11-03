"""Gate 1's substance scores on the held-out-family gate tasks, per pair and arm. No provider calls.

Run from the repository root:
    python3 docs/benchmarks/2026-11-02-skillopt-ceiling/runs/gate-1/held_out_families.py
"""
import json
from pathlib import Path

RUN = Path(__file__).parent
DATA = Path("eval/data/skillopt-method-v3")

receipt = json.loads((RUN / "receipt.json").read_text())
for pair in receipt["data"]["gate"]["pairs"]:
    if pair["status"] != "scored":
        continue
    tasks = [json.loads(line) for line in (DATA / pair["skill"] / "gate.jsonl").read_text().splitlines() if line]
    held_out = {task["task_id"] for task in tasks if task["held_out"] is True}
    for arm, result in pair["arms"].items():
        run1 = result.get("run1")
        if result.get("split") != "gate" or not isinstance(run1, dict):
            continue
        passed = sum(run1[task_id] for task_id in held_out)
        print(
            f"{pair['skill']}/{pair['target']} {arm} run 1: held-out families {passed}/{len(held_out)} = "
            f"{passed / len(held_out):.3f}; all gate tasks {sum(run1.values())}/{len(run1)} = {sum(run1.values()) / len(run1):.3f}"
        )

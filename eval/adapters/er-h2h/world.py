"""Shared reading and writing for the classic ER arms.

read_world() turns a world directory written by
bun eval/runner/person-dedupe.ts --write-world DIR (pages at
DIR/<source>/<folder>/<slug>.md) into one record per page. Front matter fields
are read generically: a JSON value (the generator writes strings and lists as
JSON) is decoded, anything else is kept as text, so company pages with fields
such as domains come through without code changes. The page key is
"<source>:<slug>", exactly as eval/runner/person-dedupe.ts keys pages.

write_output() writes the neutral file eval/runner/er-h2h-score.ts reads.
"""

from __future__ import annotations

import json
import re
from itertools import combinations
from pathlib import Path

FRONT = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.S)


def _decode(raw: str):
    try:
        return json.loads(raw)
    except ValueError:
        return raw.strip()


def read_world(world_dir: str | Path) -> list[dict]:
    root = Path(world_dir)
    rows: list[dict] = []
    for path in sorted(root.glob("*/*/*.md")):
        source, folder, slug = path.parts[-3], path.parts[-2], path.stem
        m = FRONT.match(path.read_text(encoding="utf-8"))
        if not m:
            raise ValueError(f"{path}: no front matter")
        row: dict = {"key": f"{source}:{slug}", "source": source, "folder": folder, "slug": slug}
        for line in m.group(1).split("\n"):
            name, sep, value = line.partition(": ")
            if sep and name.strip() and name.strip() not in row:
                row[name.strip()] = _decode(value)
        row["name"] = str(row.get("title") or row.get("name") or "").strip()
        row["body"] = " ".join(l.strip() for l in m.group(2).split("\n") if l.strip() and not l.startswith("#"))
        rows.append(row)
    if not rows:
        raise ValueError(f"{root}: no pages under <source>/<folder>/<slug>.md")
    keys = [r["key"] for r in rows]
    if len(set(keys)) != len(keys):
        raise ValueError(f"{root}: two pages share a <source>:<slug> key")
    fields = sorted({k for r in rows for k in r})
    for r in rows:
        for k in fields:
            r.setdefault(k, None)
    return rows


def list_fields(rows: list[dict]) -> list[str]:
    """Fields that hold a list on any page (emails, and domains on company pages)."""
    return sorted({k for r in rows for k, v in r.items() if isinstance(v, list)})


def read_labels(path: str | Path, rows: list[dict]) -> dict[str, str]:
    """The held-out page-to-person map from eval/runner/er-h2h-score.ts labels. Must cover exactly the training world."""
    labels = json.loads(Path(path).read_text())
    person = labels["person"]
    if set(person) != {r["key"] for r in rows}:
        raise ValueError(f"{path}: labels do not cover exactly the training world's pages")
    return person


def pair_metrics(clusters: list[list[str]], person: dict[str, str]) -> dict:
    """Pairwise precision, recall and F1 of clusters against a page-to-person map (used only on the held-out world)."""
    merged = same_merged = 0
    for c in clusters:
        for a, b in combinations(sorted(set(c)), 2):
            merged += 1
            same_merged += person[a] == person[b]
    sizes: dict[str, int] = {}
    for p in person.values():
        sizes[p] = sizes.get(p, 0) + 1
    all_same = sum(n * (n - 1) // 2 for n in sizes.values())
    precision = same_merged / merged if merged else 0.0
    recall = same_merged / all_same if all_same else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1, "merged_pairs": merged}


def components(keys: list[str], edges: list[tuple[str, str]]) -> list[list[str]]:
    """Connected components of the edges, as sorted clusters of two or more keys."""
    parent = {k: k for k in keys}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in edges:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    groups: dict[str, list[str]] = {}
    for k in keys:
        groups.setdefault(find(k), []).append(k)
    return sorted(sorted(g) for g in groups.values() if len(g) > 1)


def write_output(path: str | Path, system: str, version: str, config: str, auto: list[list[str]], proposed: list[list[str]] | None = None) -> None:
    tiers = {"auto": sorted(sorted(c) for c in auto if len(c) > 1)}
    if proposed is not None:
        tiers["proposed"] = sorted(sorted(c) for c in proposed if len(c) > 1)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps({"system": system, "version": version, "config": config, "tiers": tiers}, indent=1) + "\n")


def write_run_log(path: str | Path, log: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(log, indent=2, default=str) + "\n")

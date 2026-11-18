"""Shared reading, writing and argument checks for the classic ER arms.

This is the one frozen records parser over rendered pages. It reads only the
Markdown files in a world directory and imports nothing from the generators or
any ledger (standard library only).

read_world(dir, entity) reads the pages of one entity type, written as
DIR/<source>/people/<slug>.md or DIR/<source>/companies/<slug>.md, into one
record per page. Front matter fields are read generically: a JSON value (the
generators write strings and lists as JSON) is decoded, anything else is kept
as text. The page key is the one the scorer uses: "<source>:<slug>" for a
person page and "<source>:companies/<slug>" for a company page.

A company page's domain (a string or a list) and the host of its website
become one normalised "domains" list: lowercase, with the scheme, a leading
www. and any path dropped, as domainKey in eval/runner/person-dedupe.ts keys
them. The raw domain field is not kept, because it is a string on some pages
and a list on others.

read_labels(path, rows) reads the held-out labels file.
"""

from __future__ import annotations

import argparse
import json
import re
from itertools import combinations
from pathlib import Path

ENTITIES = {"people": "person", "companies": "company"}
HELD_OUT_SEED = 20261118
FRONT = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.S)
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://")
HOST = re.compile(r"^[a-z0-9.-]+$")


def _decode(raw: str):
    try:
        return json.loads(raw)
    except ValueError:
        return raw.strip()


def domain_key(raw: str) -> str | None:
    """A company domain as the finder keys it (from domain or a website URL): the host, lowercase, without www."""
    host = re.split(r"[/?#:]", SCHEME.sub("", raw.strip().lower()))[0]
    host = host[4:] if host.startswith("www.") else host
    return host if "." in host and HOST.match(host) else None


def company_domains(domain, website) -> list[str]:
    """Page order (the domain field, then the website host), without repeats."""
    raw = [*(domain if isinstance(domain, list) else [domain]), website]
    return list(dict.fromkeys(k for k in (domain_key(d) for d in raw if isinstance(d, str)) if k))


def read_world(world_dir: str | Path, entity: str) -> list[dict]:
    if entity not in ENTITIES:
        raise ValueError(f"entity must be one of {sorted(ENTITIES)}, got {entity!r}")
    root = Path(world_dir)
    rows: list[dict] = []
    for path in sorted(root.glob(f"*/{entity}/*.md")):
        source, slug = path.parts[-3], path.stem
        m = FRONT.match(path.read_text(encoding="utf-8"))
        if not m:
            raise ValueError(f"{path}: no front matter")
        key = f"{source}:{slug}" if entity == "people" else f"{source}:companies/{slug}"
        row: dict = {"key": key, "source": source, "slug": slug}
        for line in m.group(1).split("\n"):
            name, sep, value = line.partition(": ")
            if sep and name.strip() and name.strip() not in row:
                row[name.strip()] = _decode(value)
        if row.get("type") != ENTITIES[entity]:
            raise ValueError(f"{path}: type {row.get('type')!r} under {entity}/, expected {ENTITIES[entity]!r}")
        if entity == "companies":
            row["domains"] = company_domains(row.pop("domain", None), row.get("website"))
        row["name"] = str(row.get("title") or row.get("name") or "").strip()
        row["body"] = " ".join(l.strip() for l in m.group(2).split("\n") if l.strip() and not l.startswith("#"))
        rows.append(row)
    if not rows:
        raise ValueError(f"{root}: no pages under <source>/{entity}/<slug>.md")
    keys = [r["key"] for r in rows]
    if len(set(keys)) != len(keys):
        raise ValueError(f"{root}: two {entity} pages share a key")
    fields = sorted({k for r in rows for k in r})
    for r in rows:
        for k in fields:
            r.setdefault(k, None)
    return rows


def list_fields(rows: list[dict]) -> list[str]:
    """Fields that hold a list on any page (emails on person pages, domains on company pages)."""
    return sorted({k for r in rows for k, v in r.items() if isinstance(v, list)})


def read_labels(path: str | Path, rows: list[dict]) -> dict[str, str]:
    """The held-out page-to-entity map, restricted to the training rows. Refuses any seed but the held-out one."""
    labels = json.loads(Path(path).read_text())
    if labels.get("seed") != HELD_OUT_SEED:
        raise SystemExit(f"{path}: labels come from seed {labels.get('seed')}; only held-out seed {HELD_OUT_SEED} may give labels or tuning")
    entities = labels.get("entities")
    if not isinstance(entities, dict):
        raise SystemExit(f"{path}: no entities map")
    missing = [r["key"] for r in rows if r["key"] not in entities]
    if missing:
        raise SystemExit(f"{path}: {len(missing)} training pages have no label, for example {missing[:3]}")
    return {r["key"]: str(entities[r["key"]]) for r in rows}


def pair_metrics(clusters: list[list[str]], entity_of: dict[str, str]) -> dict:
    """Pairwise precision, recall and F1 of clusters against a page-to-entity map (used only on the held-out world)."""
    merged = same_merged = 0
    for c in clusters:
        for a, b in combinations(sorted(set(c)), 2):
            merged += 1
            same_merged += entity_of[a] == entity_of[b]
    sizes: dict[str, int] = {}
    for p in entity_of.values():
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


def arm_args(system: str, takes_labels: bool, takes_seed: bool, extra=None) -> argparse.Namespace:
    """The command line every arm shares, with the refusals the runner relies on."""
    ap = argparse.ArgumentParser(prog=f"{system}_arm.py")
    ap.add_argument("--config", required=True)
    ap.add_argument("--entity", required=True, choices=sorted(ENTITIES))
    ap.add_argument("--world", required=True, help="world to score")
    ap.add_argument("--held-out", required=takes_labels, help=f"held-out world (seed {HELD_OUT_SEED})")
    ap.add_argument("--labels", required=takes_labels, help=f"held-out labels file (seed {HELD_OUT_SEED})")
    ap.add_argument("--out-file", required=True, help="output JSON; the run log goes beside it as <name>.run.json")
    ap.add_argument("--label-budget", type=int, help="the most pairs the oracle answers in total")
    ap.add_argument("--seed", type=int, help="labeller seed, 1 to 5")
    if extra:
        extra(ap)
    a = ap.parse_args()
    if not takes_labels and a.label_budget is not None:
        ap.error(f"{system} takes no labels, so --label-budget does not apply")
    if a.label_budget is not None and a.label_budget < 1:
        ap.error("--label-budget must be at least 1")
    if not takes_seed and a.seed is not None:
        ap.error(f"{system} has no seed setting, so --seed does not apply")
    if takes_seed and a.seed is not None and a.seed not in range(1, 6):
        ap.error("--seed is a labeller seed and must be 1 to 5")
    if not a.out_file.endswith(".json"):
        ap.error("--out-file must end in .json")
    if a.held_out and Path(a.held_out).resolve() == Path(a.world).resolve():
        ap.error("the held-out world must differ from the scored world")
    return a


def load_config(path: str, entity: str) -> dict:
    """The config for one entity: for companies, each key in the config's "companies" section replaces the top-level key of that name."""
    cfg = json.loads(Path(path).read_text())
    companies = cfg.pop("companies", None)
    if entity == "people":
        return cfg
    if companies is None:
        raise SystemExit(f"{path}: no companies section, so this config cannot run on company pages")
    return {**cfg, **companies}


def run_log_path(out_file: str | Path) -> Path:
    return Path(str(out_file)[: -len(".json")] + ".run.json")


def write_output(path: str | Path, system: str, version: str, config: str, auto: list[list[str]], proposed: list[list[str]] | None = None) -> None:
    tiers = {"auto": sorted(sorted(c) for c in auto if len(c) > 1)}
    if proposed is not None:
        tiers["proposed"] = sorted(sorted(c) for c in proposed if len(c) > 1)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps({"system": system, "version": version, "config": config, "tiers": tiers}, indent=1) + "\n")


def write_run_log(path: str | Path, log: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(log, indent=2, default=str) + "\n")

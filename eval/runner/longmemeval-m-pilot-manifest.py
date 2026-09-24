#!/usr/bin/env python3
"""Keyless, bounded-memory selection and source projection for cleaned LongMemEval-M."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import sys

import ijson


DATASET_REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f"
DATASET_SHA256 = "9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f"
DATASET_BYTES = 2737100077
SEED = "gbrain-tmem-lme-m-v1"
TYPES = (
    "single-session-user", "single-session-assistant", "single-session-preference",
    "temporal-reasoning", "knowledge-update", "multi-session",
)


def digest(path):
    h = sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def write_json(path, value):
    path.write_bytes(encoded(value) + b"\n")
    return digest(path)


def bucket(question):
    kind = question["question_type"]
    if kind not in TYPES:
        raise ValueError(f"unknown question type {kind!r}")
    identifier = question["question_id"]
    if not isinstance(identifier, str) or not identifier:
        raise ValueError("missing question_id")
    if ("_abs" in identifier) != identifier.endswith("_abs"):
        raise ValueError(f"ambiguous abstention marker in {identifier!r}")
    return "abstention" if identifier.endswith("_abs") else kind


def questions(path):
    with path.open("rb") as stream:
        yield from ijson.items(stream, "item")


def check_source(question):
    identifiers = question["haystack_session_ids"]
    dates = question["haystack_dates"]
    sessions = question["haystack_sessions"]
    if not isinstance(identifiers, list) or not isinstance(dates, list) or not isinstance(sessions, list):
        raise ValueError("unsupported source schema")
    if len(identifiers) != len(dates) or len(identifiers) != len(sessions):
        raise ValueError(f"unaligned history for {question['question_id']}")
    for turns in sessions:
        if not isinstance(turns, list):
            raise ValueError("expected ordered arrays of turns")
        for turn in turns:
            if not isinstance(turn, dict) or turn.get("role") not in ("user", "assistant") or not isinstance(turn.get("content"), str):
                raise ValueError("unsupported turn schema")
    return identifiers, dates, sessions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("scan", "extract"))
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.dataset.stat().st_size != DATASET_BYTES or digest(args.dataset) != DATASET_SHA256:
        raise ValueError("pinned upstream LFS byte length or SHA-256 mismatch")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "longmemeval-m-pilot-manifest.json"

    if args.mode == "scan":
        groups = {kind: [] for kind in (*TYPES, "abstention")}
        type_counts = Counter()
        keys = Counter()
        seen = set()
        no_target = []
        duplicated_histories = 0
        duplicated_gold = 0
        for q in questions(args.dataset):
            key = q["question_id"]
            if key in seen:
                raise ValueError(f"duplicate question ID {key}")
            seen.add(key)
            kind = bucket(q)
            ids, _, sessions = check_source(q)
            if len(ids) != len(set(ids)):
                duplicated_histories += 1
                if any(ids.count(target) > 1 for target in q["answer_session_ids"]):
                    duplicated_gold += 1
            if not isinstance(q.get("question"), str) or not isinstance(q.get("answer"), (str, int, float)) or not isinstance(q.get("answer_session_ids"), list):
                raise ValueError(f"unsupported question/answer schema in {key}")
            if not kind == "abstention" and not q["answer_session_ids"]:
                no_target.append(key)
            if any(id not in ids for id in q["answer_session_ids"]):
                raise ValueError(f"evidence ID not in source history in {key}")
            type_counts[q["question_type"]] += 1
            keys.update(q.keys())
            groups[kind].append(key)
        counts = {key: len(value) for key, value in groups.items()}
        if any(n < 4 for n in counts.values()):
            raise ValueError(f"four-per-bucket impossible: {counts}")
        if no_target:
            raise ValueError(f"answerable questions without target sessions: {no_target}")
        chosen = {kind: sorted(ids, key=lambda id: (sha256((SEED + "\0" + id).encode("utf-8")).hexdigest(), id))[:4]
                  for kind, ids in groups.items()}
        manifest = {
            "schema_version": 1,
            "upstream": "xiaowu0162/longmemeval-cleaned",
            "revision": DATASET_REVISION,
            "license": "MIT",
            "dataset_file": "longmemeval_m_cleaned.json",
            "dataset_bytes": DATASET_BYTES,
            "dataset_sha256": DATASET_SHA256,
            "selection_seed": SEED,
            "selection_rule": "first 4 per mutually exclusive bucket by SHA256(UTF8(seed + NUL + question_id)), hex ascending; question_id lexical tie-break",
            "total_questions": len(seen),
            "raw_type_counts": dict(sorted(type_counts.items())),
            "bucket_counts": counts,
            "schema_fields": dict(sorted(keys.items())),
            "histories_with_repeated_session_ids": duplicated_histories,
            "histories_with_repeated_gold_session_ids": duplicated_gold,
            "selected": chosen,
            "selected_ids": [id for ids in chosen.values() for id in ids],
        }
        write_json(manifest_path, manifest)
        print(json.dumps({"manifest": str(manifest_path), "total_questions": len(seen), "bucket_counts": counts, "schema_fields": dict(keys), "duplicated_histories": duplicated_histories, "selected": chosen}))
        return

    manifest = json.loads(manifest_path.read_text())
    if manifest["revision"] != DATASET_REVISION or manifest["dataset_sha256"] != DATASET_SHA256:
        raise ValueError("selection manifest differs from pinned upstream source")
    selected_ids = manifest["selected_ids"]
    if len(selected_ids) != 28 or len(set(selected_ids)) != 28:
        raise ValueError("frozen selection is not 28 unique IDs")
    selected = set(selected_ids)
    original = {}
    details = {}
    sources_dir = args.output / "longmemeval-m-pilot-sources"
    sources_dir.mkdir(exist_ok=True)
    for q in questions(args.dataset):
        key = q["question_id"]
        if key not in selected:
            continue
        if bucket(q) not in manifest["selected"] or key not in manifest["selected"][bucket(q)]:
            raise ValueError(f"selected bucket drift for {key}")
        ids, dates, sessions = check_source(q)
        if len(ids) != len(sessions):
            raise ValueError("source count drift")
        source = [{"occurrence_index": index, "session_id": id, "date": date,
                   "turns": [{"role": turn["role"], "content": turn["content"]} for turn in turns]}
                  for index, (id, date, turns) in enumerate(zip(ids, dates, sessions))]
        source_path = sources_dir / (sha256(key.encode("utf-8")).hexdigest() + ".json")
        source_sha = write_json(source_path, source)
        original[key] = q
        details[key] = {"bucket": bucket(q), "question_type": q["question_type"],
                        "sessions": len(source), "turns": sum(len(x["turns"]) for x in source),
                        "source_bytes": source_path.stat().st_size, "source_sha256": source_sha,
                        "source_file": str(source_path),
                        "max_session_bytes": max((len(encoded(x)) for x in source), default=0),
                        "repeated_id_occurrences": len(ids) - len(set(ids)),
                        "repeated_gold_ids": [target for target in q["answer_session_ids"] if ids.count(target) > 1],
                        "required_sessions": len(q["answer_session_ids"])}
    if set(original) != selected:
        raise ValueError("frozen IDs missing in pinned dataset")
    selected_path = args.output / "longmemeval-m-pilot-selected.json"
    selected_sha = write_json(selected_path, [original[id] for id in selected_ids])
    manifest["selected_dataset"] = {"path": str(selected_path), "sha256": selected_sha, "bytes": selected_path.stat().st_size}
    manifest["selected_source_details"] = details
    write_json(manifest_path, manifest)
    portable = {key: manifest[key] for key in ("schema_version", "upstream", "revision", "license", "dataset_file", "dataset_bytes",
                                                 "dataset_sha256", "selection_seed", "selection_rule", "total_questions", "raw_type_counts",
                                                 "bucket_counts", "schema_fields", "histories_with_repeated_session_ids",
                                                 "histories_with_repeated_gold_session_ids", "selected", "selected_ids")}
    portable["selected_dataset"] = {key: manifest["selected_dataset"][key] for key in ("sha256", "bytes")}
    portable["selected_source_details"] = {id: {key: value[key] for key in ("sessions", "turns", "source_bytes",
                                                                  "source_sha256", "max_session_bytes", "repeated_id_occurrences")}
                                           for id, value in details.items()}
    write_json(args.output / "longmemeval-m-pilot-selection.json", portable)
    print(json.dumps({"manifest": str(manifest_path), "selected_dataset_sha256": selected_sha,
                      "total_sessions": sum(x["sessions"] for x in details.values()),
                      "total_source_bytes": sum(x["source_bytes"] for x in details.values()),
                      "max_session_bytes": max(x["max_session_bytes"] for x in details.values())}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"longmemeval-m-pilot: {exc}", file=sys.stderr)
        sys.exit(1)

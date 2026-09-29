#!/usr/bin/env python3
"""Recount the September 29 opaque-id LongMemEval answer receipts.

Keyless and offline. Recounts saved judge verdicts and retrieval flags per arm,
re-derives the paired gains, losses and exact McNemar p-values, checks them
against summary.json, and checks that no saved reader prompt contains the
`answer_` gold prefix or any retrieved raw session id. It does not repeat
model calls or re-judge answers.
"""
import gzip
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "docs/benchmarks/2026-09-29-longmemeval-opaque-qa"


def rows(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt") as f:
        out = [json.loads(line) for line in f if line.strip()]
    return out


def by_qid(items):
    result = {}
    for r in items:
        if isinstance(r.get("question_id"), str) and r.get("kind") != "by_type_summary":
            assert r["question_id"] not in result, ("duplicate", r["question_id"])
            result[r["question_id"]] = r
    return result


def mcnemar(a, b):
    qids = sorted(set(a) & set(b))
    gains = sum(1 for q in qids if b[q] and not a[q])
    losses = sum(1 for q in qids if a[q] and not b[q])
    n = gains + losses
    p = 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(gains, losses) + 1)) / 2 ** n)
    return dict(n_paired=len(qids), a_correct=sum(a[q] for q in qids), b_correct=sum(b[q] for q in qids),
                gains=gains, losses=losses, exact_mcnemar_p=p)


def correct(r, key):
    return bool(r.get(key)) and not (r.get("error") or r.get("reader_error"))


def verify():
    summary = json.loads((DIR / "summary.json").read_text())
    subset = [l.strip() for l in (DIR / "subset100_seed20260929.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    a = by_qid(rows(DIR / "a/rows.ndjson"))
    off = by_qid(rows(DIR / "a/official-judge.ndjson"))
    b = by_qid(rows(DIR / "b/rows.ndjson.gz"))
    c = {k: by_qid(rows(DIR / f"c/{k}.ndjson")) for k in ("c1", "c2", "c3")}
    assert len(a) == 500 and len(off) == 500 and len(b) == 500, "every full arm has 500 questions"
    assert all(set(c[k]) == set(subset) and len(subset) == 100 for k in c), "component arms cover the seeded subset"

    for r in a.values():
        assert r["hypothesis"] in off[r["question_id"]]["off_judge_prompt"], "official judge graded the saved answer"
        off_ok = off[r["question_id"]]["off_judge_correct"]
        r["off_judge_correct"] = off_ok

    maps = {
        "a": {"g": {q: correct(r, "judge_correct") for q, r in a.items()}, "o": {q: correct(r, "off_judge_correct") for q, r in a.items()}},
        "b": {"g": {q: correct(r, "judge_correct") for q, r in b.items()}, "o": {q: correct(r, "off_judge_correct") for q, r in b.items()}},
    }
    for k in c:
        maps[k] = {"g": {q: correct(r, "judge_correct") for q, r in c[k].items()}, "o": {q: correct(r, "off_judge_correct") for q, r in c[k].items()}}

    arms = summary["arms"]
    checks = [
        ("a_house_full500", "a", None), ("b_gpt4o_official", "b", None), ("a_house_subset100", "a", subset),
        ("c1_prod_reader_chunks", "c1", subset), ("c2_plain_rag_chunks", "c2", subset), ("c3_think_prompt_chunks", "c3", subset),
    ]
    counts = {}
    for name, key, qids in checks:
        g = maps[key]["g"] if qids is None else {q: maps[key]["g"][q] for q in qids}
        o = maps[key]["o"] if qids is None else {q: maps[key]["o"][q] for q in qids}
        counts[name] = dict(gbrain_judge=sum(g.values()), official_judge=sum(o.values()), denominator=len(g))
        assert counts[name]["gbrain_judge"] == arms[name]["correct_gbrain_judge"], name
        assert counts[name]["official_judge"] == arms[name]["correct_official_judge"], name

    sub = lambda m: {q: m[q] for q in subset}
    for judge, j in (("gbrain_judge", "g"), ("official_judge", "o")):
        pairs = {
            f"b_vs_a_{judge}": (maps["a"][j], maps["b"][j]),
            f"c1_vs_a_{judge}": (sub(maps["a"][j]), maps["c1"][j]),
            f"c2_vs_a_{judge}": (sub(maps["a"][j]), maps["c2"][j]),
            f"c3_vs_a_{judge}": (sub(maps["a"][j]), maps["c3"][j]),
            f"c2_vs_c1_{judge}": (maps["c1"][j], maps["c2"][j]),
            f"c3_vs_c1_{judge}": (maps["c1"][j], maps["c3"][j]),
        }
        for name, (x, y) in pairs.items():
            got = mcnemar(x, y)
            want = summary["paired"][name]
            assert {k: got[k] for k in ("n_paired", "gains", "losses")} == {k: want[k] for k in ("n_paired", "gains", "losses")}, name
            assert abs(got["exact_mcnemar_p"] - want["exact_mcnemar_p"]) < 1e-12, name

    non_abs = [r for r in a.values() if not r["question_id"].endswith("_abs")]
    strict = sum(1 for r in non_abs if r.get("recall_all_hit") is True)
    assert len(non_abs) == 470 and strict == summary["evidence"]["recall_all_hit_at5"], "strict recall_all@5"

    leaks = 0
    raw_ids = {q: {x["session_id"] for x in r["retrieved"]} for q, r in a.items()}
    by_question = {r["question"]: q for q, r in a.items()}
    prompts = 0
    for call in rows(DIR / "a/calls.ndjson.gz"):
        if call.get("lane") != "reader":
            continue
        text = (call.get("system") or "") + call["user"]
        q = by_question[call["question"]]
        leaks += ("answer_" in text) + any(s in text for s in raw_ids[q])
        prompts += 1
    for q, r in b.items():
        leaks += ("answer_" in r["reader_prompt"]) + any(s in r["reader_prompt"] for s in raw_ids[q])
        prompts += 1
    for k in c:
        for q, r in c[k].items():
            text = (r.get("reader_system") or "") + r["reader_prompt"]
            leaks += ("answer_" in text) + any(s in text for s in raw_ids[q])
            prompts += 1
    assert prompts == 1300 and leaks == 0, ("leak check", prompts, leaks)
    return dict(source_run_date="2026-09-29", verification="Recount of saved verdicts, paired tests and prompt leak check",
                limitation="Does not repeat model calls or re-judge answers", counts=counts,
                strict_recall_all_at5=f"{strict}/470", prompts_checked=prompts, leaks=leaks)


if __name__ == "__main__":
    print(json.dumps(verify(), indent=2))

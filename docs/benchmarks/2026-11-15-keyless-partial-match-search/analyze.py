#!/usr/bin/env python3
"""Recount the keyless partial-match search result from the committed rows.

Run from the repository root:

  python3 docs/benchmarks/2026-11-15-keyless-partial-match-search/analyze.py           # print the recount
  python3 docs/benchmarks/2026-11-15-keyless-partial-match-search/analyze.py --write   # and rewrite summary.json
  python3 docs/benchmarks/2026-11-15-keyless-partial-match-search/analyze.py --check   # exit 1 if summary.json differs

Inputs, all in this folder:
  rows/<arm>.jsonl.gz      gbrain-evals' four runs (one row per question, then a by_type_summary line).
  gbrain-team/*.jsonl.gz   GBrain's own rows for 4244fd77 and b0529e73, used only for the cross-check.

Definitions:
  scored          the 470 questions that are not abstention (_abs) questions.
  recall_all@k    every gold session appears among the sessions of the first k returned rows.
  MRR@10          1 / rank of the first of the first 10 rows whose session is gold, else 0.
  interval        paired bootstrap over scored questions, taken in the order their rows appear in the
                  pair's before-arm file: 10,000 resamples with replacement, Python
                  random.Random(7), the 2.5th and 97.5th percentiles (sorted resample means at 0-based
                  positions 250 and 9749).
  p50, p95        the value at 0-based position floor(q * n) of the sorted list.
  unchanged       the first len(before) rows of the after arm equal the before arm's rows in every field
                  (slug, chunk_id, session_id, rank, score) and order.

Python 3 standard library only.
"""
import gzip
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARMS = {
    "master-4244fd77": "rows/base-4244fd77.jsonl.gz",
    "branch-b0529e73": "rows/branch-b0529e73.jsonl.gz",
    "parent-0a4ed211": "rows/parent-0a4ed211.jsonl.gz",
    "landed-23a163fc": "rows/landed-23a163fc.jsonl.gz",
}
TEAM = {
    "team-master-4244fd77": "gbrain-team/base-query4.jsonl.gz",
    "team-branch-b0529e73": "gbrain-team/branch-query4.jsonl.gz",
}
PAIRS = {
    "branch_pair": ("master-4244fd77", "branch-b0529e73"),
    "landed_pair": ("parent-0a4ed211", "landed-23a163fc"),
    "team_branch_pair": ("team-master-4244fd77", "team-branch-b0529e73"),
}
RESAMPLES, SEED = 10_000, 7


def load(rel):
    rows, summary = {}, None
    with gzip.open(HERE / rel, "rt", encoding="utf-8") as f:
        for line in f:
            j = json.loads(line)
            if "question_id" in j:
                if j["question_id"] in rows:
                    raise SystemExit(f"{rel}: duplicate question {j['question_id']}")
                rows[j["question_id"]] = j
            else:
                summary = j
    return rows, summary


def retrieved(row):
    return row.get("retrieved") or []


def recall_all(row, k):
    seen = {x.get("session_id") for x in retrieved(row)[:k]}
    return 1 if all(g in seen for g in row["answer_session_ids"]) else 0


def first_gold_rank(row):
    gold = set(row["answer_session_ids"])
    for i, x in enumerate(retrieved(row)[:10]):
        if x.get("session_id") in gold:
            return i + 1
    return None


def rr(row):
    r = first_gold_rank(row)
    return 1 / r if r else 0.0


def pct(values, q):
    a = sorted(values)
    return a[min(len(a) - 1, int(q * len(a)))] if a else None


def bootstrap(diffs):
    rnd, n, means = random.Random(SEED), len(diffs), []
    for _ in range(RESAMPLES):
        s = 0.0
        for _ in range(n):
            s += diffs[rnd.randrange(n)]
        means.append(s / n)
    means.sort()
    return [means[int(0.025 * RESAMPLES)], means[int(0.975 * RESAMPLES) - 1]]


def arm_summary(rows):
    scored = [q for q in rows if not rows[q].get("abstention")]
    lat = [r["via_operation"]["latency_ms"] for r in rows.values()]
    by_type = {}
    for q in scored:
        t = rows[q]["question_type"]
        b = by_type.setdefault(t, {"total": 0, "recall_all@10": 0})
        b["total"] += 1
        b["recall_all@10"] += recall_all(rows[q], 10)
    return {
        "questions": len(rows),
        "scored": len(scored),
        "errors": sum(1 for r in rows.values() if r.get("error")),
        "vector_enabled_false": sum(1 for r in rows.values() if (r.get("search_meta") or {}).get("vector_enabled") is False),
        "rows_equal_rows_returned": sum(1 for r in rows.values() if len(retrieved(r)) == r["via_operation"]["rows_returned"]),
        "harness_field_disagreements": sum(1 for q in scored if recall_all(rows[q], 10) != (1 if rows[q]["recall_all_hit"] else 0)),
        "recall_all@10": sum(recall_all(rows[q], 10) for q in scored),
        "recall_all@5": sum(recall_all(rows[q], 5) for q in scored),
        "mrr@10": sum(rr(rows[q]) for q in scored) / len(scored),
        "questions_with_a_gold_row_in_top_10": sum(1 for q in scored if first_gold_rank(rows[q])),
        "by_type_recall_all@10": dict(sorted(by_type.items())),
        "query_latency_ms": {"p50": pct(lat, 0.5), "p95": pct(lat, 0.95)},
    }


def pair_summary(before, after):
    if set(before) != set(after):
        raise SystemExit("arms hold different question ids")
    scored = [q for q in before if not before[q].get("abstention")]
    unchanged, fired, added, longest_short_page, shortest_unfired = 0, [], 0, 0, None
    for q in before:
        b, a = retrieved(before[q]), retrieved(after[q])
        if a[: len(b)] == b:
            unchanged += 1
        if len(a) > len(b):
            fired.append(q)
            added += len(a) - len(b)
            longest_short_page = max(longest_short_page, len(b))
        elif shortest_unfired is None or len(b) < shortest_unfired:
            shortest_unfired = len(b)
    metrics = {}
    for name, f in (("recall_all@10", lambda r: recall_all(r, 10)), ("recall_all@5", lambda r: recall_all(r, 5)), ("mrr@10", rr)):
        xb = [f(before[q]) for q in scored]
        xa = [f(after[q]) for q in scored]
        d = [y - x for x, y in zip(xb, xa)]
        metrics[name] = {
            "before": sum(xb) / len(xb),
            "after": sum(xa) / len(xa),
            "difference": sum(d) / len(d),
            "interval_95": bootstrap(d),
            "better": sum(1 for x in d if x > 0),
            "worse": sum(1 for x in d if x < 0),
        }
        if name != "mrr@10":
            metrics[name]["before_hits"] = int(sum(xb))
            metrics[name]["after_hits"] = int(sum(xa))
    hits = [q for q in scored if first_gold_rank(before[q])]
    moved_down = [q for q in hits if first_gold_rank(after[q]) is None or first_gold_rank(after[q]) > first_gold_rank(before[q])]
    completed = [q for q in scored if recall_all(after[q], 10) > recall_all(before[q], 10)]
    newly_found = [q for q in scored if not first_gold_rank(before[q]) and first_gold_rank(after[q])]
    fired_set = set(fired)
    lat = lambda rows, q: rows[q]["via_operation"]["latency_ms"]
    d_fired = [lat(after, q) - lat(before, q) for q in fired]
    d_rest = [lat(after, q) - lat(before, q) for q in before if q not in fired_set]
    return {
        "questions": len(before),
        "scored": len(scored),
        "earlier_rows_unchanged": unchanged,
        "questions_with_added_rows": len(fired),
        "scored_questions_with_added_rows": sum(1 for q in scored if q in fired_set),
        "rows_added": added,
        "most_rows_before_on_a_question_with_added_rows": longest_short_page,
        "fewest_rows_before_on_a_question_without_added_rows": shortest_unfired,
        "metrics": metrics,
        "questions_with_a_gold_row_in_top_10_before": len(hits),
        "first_gold_row_ranked_lower_after": len(moved_down),
        "recall_all@10_better_with_a_gold_row_before": sum(1 for q in completed if first_gold_rank(before[q])),
        "recall_all@10_better_by_gold_sessions": {str(n): sum(1 for q in completed if len(before[q]["answer_session_ids"]) == n) for n in sorted({len(before[q]["answer_session_ids"]) for q in completed})},
        "first_gold_rank_after_where_none_before": sorted(first_gold_rank(after[q]) for q in newly_found),
        "query_latency_added_ms": {
            "with_added_rows": {"n": len(d_fired), "p50": pct(d_fired, 0.5), "p95": pct(d_fired, 0.95)},
            "without_added_rows": {"n": len(d_rest), "p50": pct(d_rest, 0.5), "p95": pct(d_rest, 0.95)},
        },
    }


def same_rows(x, y):
    return sum(1 for q in x if retrieved(x[q]) == retrieved(y[q]))


def same_rows_ignoring_score(x, y):
    key = lambda r: [(e.get("slug"), e.get("chunk_id"), e.get("session_id"), e.get("rank")) for e in retrieved(r)]
    return sum(1 for q in x if key(x[q]) == key(y[q]))


def score_differences(x, y):
    diffs = [abs(a["score"] - b["score"]) for q in x for a, b in zip(retrieved(x[q]), retrieved(y[q])) if a["score"] != b["score"]]
    changed = sum(1 for q in x if [e["score"] for e in retrieved(x[q])] != [e["score"] for e in retrieved(y[q])])
    return {"questions": changed, "largest": round(max(diffs), 6) if diffs else 0}


def team_search_function_bench():
    rows, _ = load("gbrain-team/bench4.jsonl.gz")
    fired = [r["fill_bench"] for r in rows.values() if r["fill_bench"]["fired"]]
    rest = [r["fill_bench"] for r in rows.values() if not r["fill_bench"]["fired"]]
    return {
        "questions": len(rows),
        "fired": len(fired),
        "frozen_clock_rows_identical": sum(1 for r in rows.values() if r["fill_bench"]["frozen_rows_identical"]),
        "added_ms_when_fired": {"p50": pct([b["on_ms"] - b["off_ms"] for b in fired], 0.5), "p95": pct([b["on_ms"] - b["off_ms"] for b in fired], 0.95)},
        "added_ms_when_not_fired": {"p50": pct([b["on_ms"] - b["off_ms"] for b in rest], 0.5)},
    }


def recount():
    data = {name: load(rel) for name, rel in {**ARMS, **TEAM}.items()}
    rows = {name: d[0] for name, d in data.items()}
    out = {
        "arms": {name: arm_summary(rows[name]) for name in ARMS},
        "pairs": {name: pair_summary(rows[b], rows[a]) for name, (b, a) in PAIRS.items()},
        "cross_checks": {
            "parent_vs_master_same_rows": same_rows(rows["parent-0a4ed211"], rows["master-4244fd77"]),
            "landed_vs_branch_same_rows": same_rows(rows["landed-23a163fc"], rows["branch-b0529e73"]),
            "ours_vs_team_master_same_rows": same_rows(rows["master-4244fd77"], rows["team-master-4244fd77"]),
            "ours_vs_team_branch_same_rows": same_rows(rows["branch-b0529e73"], rows["team-branch-b0529e73"]),
            "ours_vs_team_master_same_rows_ignoring_score": same_rows_ignoring_score(rows["master-4244fd77"], rows["team-master-4244fd77"]),
            "ours_vs_team_branch_same_rows_ignoring_score": same_rows_ignoring_score(rows["branch-b0529e73"], rows["team-branch-b0529e73"]),
            "ours_vs_team_master_score_differences": score_differences(rows["master-4244fd77"], rows["team-master-4244fd77"]),
            "ours_vs_team_branch_score_differences": score_differences(rows["branch-b0529e73"], rows["team-branch-b0529e73"]),
            "retrieval_config_hashes": sorted({r["retrieval_config_hash"] for name in rows for r in rows[name].values()}),
            "team_arms": {name: arm_summary(rows[name]) for name in TEAM},
            "team_search_function_bench": team_search_function_bench(),
        },
    }
    return json.loads(json.dumps(out))


def show(s):
    for name, p in s["pairs"].items():
        print(f"== {name}: {PAIRS[name][0]} -> {PAIRS[name][1]}")
        print(f"   scored {p['scored']} of {p['questions']}; earlier rows unchanged {p['earlier_rows_unchanged']}/{p['questions']}; "
              f"rows added on {p['questions_with_added_rows']} questions ({p['rows_added']} rows)")
        for m, v in p["metrics"].items():
            counts = f" ({v['before_hits']} -> {v['after_hits']})" if "before_hits" in v else ""
            scale = 100 if m != "mrr@10" else 1
            fmt = "{:.2f}" if m != "mrr@10" else "{:.4f}"
            lo, hi = (fmt.format(x * scale) for x in v["interval_95"])
            print(f"   {m}: {fmt.format(v['before'] * scale)} -> {fmt.format(v['after'] * scale)}{counts}, "
                  f"{'+' if v['difference'] >= 0 else ''}{fmt.format(v['difference'] * scale)} [{lo}, {hi}], better {v['better']} worse {v['worse']}")
        print(f"   gold row in top 10 before: {p['questions_with_a_gold_row_in_top_10_before']}; ranked lower after: {p['first_gold_row_ranked_lower_after']}")
        la = p["query_latency_added_ms"]
        print(f"   query latency added: with rows added median {la['with_added_rows']['p50']} ms p95 {la['with_added_rows']['p95']} ms; "
              f"otherwise median {la['without_added_rows']['p50']} ms")
    print("== cross checks")
    for k, v in s["cross_checks"].items():
        if k not in ("team_arms",):
            print(f"   {k}: {v}")


def main(argv):
    s = recount()
    show(s)
    path = HERE / "summary.json"
    if "--write" in argv:
        path.write_text(json.dumps(s, indent=2) + "\n")
        print(f"wrote {path.relative_to(HERE.parents[2])}")
    if "--check" in argv:
        if json.loads(path.read_text()) != s:
            print("summary.json differs from the recount", file=sys.stderr)
            return 1
        print("summary.json matches the recount")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

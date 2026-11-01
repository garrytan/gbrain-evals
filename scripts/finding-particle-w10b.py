#!/usr/bin/env python3
"""Keyless recheck of the particle-1 W10b finding from committed rows (docs/findings/2026-11-01-particle-1-longmemeval-w10b.md).

Recounts every number the finding quotes from the per-question rows, not from summary.json or REPORT.md: verdicts from
the stored judge replies ("yes" in the lowercased reply, reader errors wrong), the paired particle-1 differences with
the same cluster bootstrap as eval/runner/compare.ts (mulberry32, seed 20261101, 10,000 draws) and exact McNemar tests,
cost per correct answer re-derived from each row's token usage and the dated price table below, GPT-6.1 Sol's W10b and
W10c reader costs repriced at OpenAI's cache-write rate, and W10c's three particle-1 counts. When the second-judge rows exist it adds agreement with gpt-4o (Cohen's kappa, flips per arm) and
each pair's paired difference under its cross-family judge. It checks every digest in SHA256SUMS first and every
recomputed headline value against the replay's summary.json.

  python3 scripts/finding-particle-w10b.py            print the analysis
  python3 scripts/finding-particle-w10b.py --check    exit 1 unless the output matches the committed analysis.txt and analysis.json
  python3 scripts/finding-particle-w10b.py --write    rewrite analysis.txt and analysis.json
"""
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPLAY = ROOT / "docs/benchmarks/2026-11-01-longmemeval-particle-replay"
W10B = ROOT / "docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay"
W10C_RUN = ROOT / "docs/benchmarks/2026-10-07-longmemeval-w10c-full-context"
FINDING = ROOT / "docs/findings/2026-11-01-particle-1-longmemeval-w10b"
SEED, DRAWS = 20261101, 10000

# USD per million tokens at list price, checked against each provider's price page on 2026-11-01 and equal to the budget
# ledger's table (eval/runner/budget-ledger.ts). W10's comparators ran through the providers' batch APIs at half the list
# price. W10 settled its rows on 2026-10-06 with OpenAI cache writes at the input price; the ledger priced them at
# cache_write from 8a8e502a (2026-10-08), so each row's stored list_usd is checked at the price it was settled at.
PRICES = {
    "particle:particle-1": {"input": 0.25, "output": 1.00, "batch": None},
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "batch": 0.5},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "batch": 0.5},
    "gpt-6.1-sol": {"input": 2.00, "output": 10.00, "cache_write": 2.50, "batch": 0.5},
}
SOL_ARMS = {
    "W10b, gbrain a7cb37b notes": W10B / "arms/w10b-sol-notes/rows.ndjson",
    "W10c, gbrain c5fb0201": W10C_RUN / "arms/w10c-sol-currentpin/rows.ndjson",
    "W10c, whole history": W10C_RUN / "arms/w10c-sol-full/rows.ndjson",
}

ARMS = {
    "particle-1": REPLAY / "arms/w10b-particle-notes/rows.ndjson",
    "claude-opus-5-5": W10B / "arms/w10b-opus55-notes/rows.ndjson",
    "claude-sonnet-5-5": W10B / "arms/w10b-sonnet55-notes/rows.ndjson",
    "gpt-6.1-sol": W10B / "arms/w10b-sol-notes/rows.ndjson",
}
SUMMARY_ID = {"claude-opus-5-5": "correct__particle_minus_opus55", "claude-sonnet-5-5": "correct__particle_minus_sonnet55", "gpt-6.1-sol": "correct__particle_minus_sol"}
SUMMARY_ARM = {"particle-1": ("arms", "w10b-particle-notes"), "claude-opus-5-5": ("comparators", "w10b-opus55-notes"),
               "claude-sonnet-5-5": ("comparators", "w10b-sonnet55-notes"), "gpt-6.1-sol": ("comparators", "w10b-sol-notes")}
W10C = {"whole history": "w10c-particle-full", "gbrain c5fb0201, effort high": "w10c-particle-currentpin", "gbrain c5fb0201, effort none": "w10c-particle-currentpin-none"}
# Each comparison's second judge comes from a lab with no arm in that pair.
SECOND_JUDGES = {"gpt-6.1-sol": ["claude-opus-5-5", "claude-sonnet-5-5"], "claude-sonnet-5-5": ["gpt-6.1-sol"]}
W10_SECONDARY_JUDGE = "gpt-6.1-sol"


def rows(path):
    out = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    ids = [r["question_id"] for r in out]
    if len(set(ids)) != len(ids):
        raise SystemExit(f"duplicate question ids in {path}")
    return {r["question_id"]: r for r in out}


def yes(judgment):
    return 1 if judgment and not judgment.get("error") and isinstance(judgment.get("raw"), str) and "yes" in judgment["raw"].lower() else 0


def score(row):
    return 0 if row.get("error") else yes(row.get("official"))


def report_type(row):
    return "abstention" if row["question_id"].endswith("_abs") else row["question_type"]


def tokens(row):
    u = row.get("usage") or {}
    if "prompt_tokens" in u:
        details = u.get("prompt_tokens_details") or {}
        return u["prompt_tokens"], details.get("cached_tokens") or 0, details.get("cache_write_tokens") or 0, u.get("completion_tokens", 0)
    read, write = u.get("cache_read_input_tokens") or 0, u.get("cache_creation_input_tokens") or 0
    return u.get("input_tokens", 0) + write + read, read, write, u.get("output_tokens", 0)


def list_usd(model, row, as_settled=False):
    inp, read, write, out = tokens(row)
    if read:
        raise SystemExit(f"{row['question_id']}: cached input tokens; the price table here has no cache-read rate")
    p = PRICES[model]
    if write and "cache_write" not in p:
        raise SystemExit(f"{row['question_id']}: cache writes, and the price table has no cache-write rate for {model}")
    write_price = p["input"] if as_settled else p.get("cache_write", p["input"])
    return ((inp - write) * p["input"] + write * write_price + out * p["output"]) / 1e6


def to_i32(x):
    x &= 0xFFFFFFFF
    return x - (1 << 32) if x & 0x80000000 else x


def imul(a, b):
    return to_i32((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF))


def mulberry32(seed):
    """eval/runner/stats/paired.ts seededRandom, bit for bit."""
    state = [seed & 0xFFFFFFFF]

    def rnd():
        state[0] += 0x6D2B79F5
        t = state[0]
        t = imul(to_i32(t) ^ ((t & 0xFFFFFFFF) >> 15), to_i32(t) | 1)
        t = to_i32(t ^ to_i32(t + imul(t ^ ((t & 0xFFFFFFFF) >> 7), t | 61)))
        return ((t ^ ((t & 0xFFFFFFFF) >> 14)) & 0xFFFFFFFF) / 4294967296
    return rnd


def paired(a, b, ids):
    """B minus A, one question per cluster: delta, percentile bootstrap 95% interval, exact two-sided McNemar."""
    diffs = [b[i] - a[i] for i in sorted(ids)]
    n = len(diffs)
    rnd = mulberry32(SEED)
    boot = []
    for _ in range(DRAWS):
        s = 0
        for _ in range(n):
            s += diffs[math.floor(rnd() * n)]
        boot.append(s / n)
    boot.sort()
    ci = (boot[math.floor(DRAWS * 0.025)], boot[math.ceil(DRAWS * 0.975) - 1])
    wins = sum(1 for d in diffs if d > 0)
    losses = sum(1 for d in diffs if d < 0)
    k, m = min(wins, losses), wins + losses
    p = 1.0 if m == 0 else min(1.0, 2 * sum(math.comb(m, i) for i in range(k + 1)) / 2 ** m)
    return {"delta": sum(diffs) / n, "ci95": [ci[0], ci[1]], "wins": wins, "losses": losses, "mcnemar_p": p}


def kappa(x, y, ids):
    n = len(ids)
    agree = sum(1 for i in ids if x[i] == y[i]) / n
    px, py = sum(x[i] for i in ids) / n, sum(y[i] for i in ids) / n
    pe = px * py + (1 - px) * (1 - py)
    return 1.0 if pe == 1 else (agree - pe) / (1 - pe)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_digests():
    lines = [l for l in (FINDING / "SHA256SUMS").read_text().splitlines() if l.strip()]
    bad = [p for h, p in (l.split("  ", 1) for l in lines) if sha256(ROOT / p) != h]
    if bad:
        raise SystemExit("digest mismatch: " + ", ".join(bad))
    return len(lines)


def pts(x):
    return f"{x * 100:+.1f}".replace("+0.0", "0.0")


def analyse():
    out = {"digests_checked": check_digests()}
    summary = json.loads((REPLAY / "summary.json").read_text())
    data = {name: rows(path) for name, path in ARMS.items()}
    ids = sorted(data["particle-1"])
    if any(sorted(d) != ids for d in data.values()):
        raise SystemExit("the four W10b arms do not hold the same 500 questions")
    official = {name: {i: score(r) for i, r in d.items()} for name, d in data.items()}

    arms = {}
    for name, d in data.items():
        model = "particle:particle-1" if name == "particle-1" else name
        correct = sum(official[name].values())
        derived = sum(list_usd(model, r) for r in d.values())
        stored = sum(r["list_usd"] for r in d.values())
        if any(abs(list_usd(model, r, as_settled=True) - r["list_usd"]) > 1e-9 for r in d.values()):
            raise SystemExit(f"{name}: a row's stored list_usd differs from its tokens at the price it was settled at")
        batch = PRICES[model]["batch"]
        at_list = sum(1 for r in d.values() if batch is not None and abs(r["usd"] - r["list_usd"]) <= 1e-9)
        if batch is not None and any(min(abs(r["usd"] - batch * r["list_usd"]), abs(r["usd"] - r["list_usd"])) > 1e-9 for r in d.values()):
            raise SystemExit(f"{name}: a row's settled usd is neither its batch nor its list price")
        settled = sum(r["usd"] for r in d.values()) if batch is not None else None
        toks = [tokens(r) for r in d.values()]
        by_type = {}
        for i, r in d.items():
            t = by_type.setdefault(report_type(r), [0, 0])
            t[0] += 1
            t[1] += official[name][i]
        arms[name] = {
            "n": len(d), "correct": correct, "accuracy": correct / len(d), "reader_errors": sum(1 for r in d.values() if r.get("error")),
            "list_usd": round(derived, 6), "list_usd_per_correct": round(derived / correct, 8),
            "recorded_list_usd_per_correct": round(stored / correct, 8), "cache_write_tokens": sum(tokens(r)[2] for r in d.values()),
            "batch_usd_per_correct": None if batch is None else round(batch * derived / correct, 8),
            "settled_usd_per_correct": None if settled is None else round(settled / correct, 8), "rows_settled_at_list": at_list,
            "mean_input_tokens": round(sum(t[0] for t in toks) / len(toks)), "mean_output_tokens": round(sum(t[3] for t in toks) / len(toks)),
            "by_type": dict(sorted(by_type.items())),
        }
        section, key = SUMMARY_ARM[name]
        s = summary[section][key]
        if (s["correct"], s["list_usd_per_correct"], s.get("batch_usd_per_correct")) != (correct, round(stored / correct, 5), None if settled is None else round(settled / correct, 5)):
            raise SystemExit(f"{name}: recount differs from summary.json ({s['correct']}, {s['list_usd_per_correct']})")
    out["w10b_arms"] = arms

    pairs = {}
    for name in ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol"]:
        p = paired(official[name], official["particle-1"], ids)
        s = next(c for c in summary["w10b"]["comparisons"] if c["id"] == SUMMARY_ID[name])
        if (s["delta"], s["ci95"], s["mcnemar"]["wins"], s["mcnemar"]["losses"]) != (round(p["delta"], 10), p["ci95"], p["wins"], p["losses"]) or abs(s["mcnemar"]["p_two_sided"] - p["mcnemar_p"]) > 1e-12:
            raise SystemExit(f"particle-1 minus {name}: recount differs from summary.json")
        pairs[name] = p
    out["w10b_paired"] = pairs
    if summary["decision_b"]["flip"] or pairs["claude-opus-5-5"]["ci95"][1] < -0.1:
        raise SystemExit("decision B's stop rule fires on the recount")

    w10c = {}
    for label, arm in W10C.items():
        d = rows(REPLAY / "arms" / arm / "rows.ndjson")
        correct = sum(score(r) for r in d.values())
        if correct != summary["arms"][arm]["correct"] or len(d) != 150:
            raise SystemExit(f"{arm}: recount differs from summary.json")
        w10c[label] = {"arm": arm, "n": len(d), "correct": correct}
    out["w10c_particle"] = w10c

    sol = {}
    for label, path in SOL_ARMS.items():
        d = rows(path)
        n, correct = len(d), sum(score(r) for r in d.values())
        if any(abs(list_usd("gpt-6.1-sol", r, as_settled=True) - r["list_usd"]) > 1e-9 or abs(r["usd"] - 0.5 * r["list_usd"]) > 1e-9 for r in d.values()):
            raise SystemExit(f"{label}: a Sol row was not settled at the batch rate with cache writes at the input price")
        recorded, settled = sum(r["list_usd"] for r in d.values()), sum(r["usd"] for r in d.values())
        repriced = sum(list_usd("gpt-6.1-sol", r) for r in d.values())
        sol[label] = {
            "n": n, "correct": correct, "prompt_tokens": sum(tokens(r)[0] for r in d.values()), "cache_write_tokens": sum(tokens(r)[2] for r in d.values()),
            "recorded_list_usd": round(recorded, 6), "list_usd": round(repriced, 6), "settled_batch_usd": round(settled, 6), "batch_usd": round(0.5 * repriced, 6),
            "recorded_list_usd_per_correct": round(recorded / correct, 8), "list_usd_per_correct": round(repriced / correct, 8),
            "recorded_list_usd_per_question": round(recorded / n, 8), "list_usd_per_question": round(repriced / n, 8),
            "settled_batch_usd_per_question": round(settled / n, 8), "batch_usd_per_question": round(0.5 * repriced / n, 8),
        }
    out["sol_cache_write_repricing"] = sol

    second = {}
    for judge, comparators in SECOND_JUDGES.items():
        path = FINDING / "second-judge" / judge / "rows.ndjson"
        if not path.exists():
            continue
        judged = {}
        for r in (json.loads(l) for l in path.read_text().splitlines() if l.strip()):
            judged.setdefault(r["arm"], {})[r["question_id"]] = r
        per_arm = {}
        for name in ["particle-1"] + comparators:
            j = judged.get(name, {})
            if sorted(j) != ids:
                raise SystemExit(f"{judge}: {len(j)} of 500 {name} answers judged")
            errors = [i for i, r in j.items() if r.get("error")]
            if errors:
                raise SystemExit(f"{judge}: {len(errors)} {name} judgments failed (first {errors[0]})")
            v = {i: 0 if data[name][i].get("error") else yes(j[i]) for i in ids}
            per_arm[name] = {
                "correct": sum(v.values()), "gpt4o_correct": sum(official[name].values()),
                "agreement": sum(1 for i in ids if v[i] == official[name][i]) / len(ids), "kappa": kappa(official[name], v, ids),
                "flips_to_wrong": sum(1 for i in ids if official[name][i] == 1 and v[i] == 0),
                "flips_to_right": sum(1 for i in ids if official[name][i] == 0 and v[i] == 1),
                "verdicts": v,
            }
            if judge == W10_SECONDARY_JUDGE and "secondary" in data[name][ids[0]]:
                w10 = {i: 0 if data[name][i].get("error") else yes(data[name][i]["secondary"]) for i in ids}
                per_arm[name]["w10_secondary_correct"] = sum(w10.values())
                per_arm[name]["w10_secondary_agreement"] = sum(1 for i in ids if w10[i] == v[i])
        comparisons = {}
        for name in comparators:
            p = paired(per_arm[name]["verdicts"], per_arm["particle-1"]["verdicts"], ids)
            o = pairs[name]
            excl = lambda ci: ci[0] > 0 or ci[1] < 0
            p["ci_excludes_zero"] = excl(p["ci95"])
            p["same_conclusion_as_gpt4o"] = excl(p["ci95"]) == excl(o["ci95"]) and (not excl(o["ci95"]) or (p["delta"] > 0) == (o["delta"] > 0))
            comparisons[name] = p
        for a in per_arm.values():
            del a["verdicts"]
        second[judge] = {"arms": per_arm, "comparisons": comparisons}
    out["second_judge"] = second
    return out


def text(a):
    lines = [f"Digests checked: {a['digests_checked']} files match SHA256SUMS.", "",
             "W10b, 500 questions, official gpt-4o-2024-08-06 judge (recounted from rows)",
             "| Reader | Correct | Accuracy | Mean input / output tokens | List $ per correct | Batch-rate $ per correct | As recorded: list $ per correct | As recorded: ledger-settled $ per correct (rows settled at list) |", "|---|---|---|---|---|---|---|---|"]
    for name, s in a["w10b_arms"].items():
        batch = "none" if s["batch_usd_per_correct"] is None else f"{s['batch_usd_per_correct']:.4f}"
        settled = "none" if s["settled_usd_per_correct"] is None else f"{s['settled_usd_per_correct']:.4f} ({s['rows_settled_at_list']})"
        lines.append(f"| {name} | {s['correct']} | {s['accuracy'] * 100:.1f}% | {s['mean_input_tokens']:,} / {s['mean_output_tokens']:,} | {s['list_usd_per_correct']:.4f} | {batch} | {s['recorded_list_usd_per_correct']:.4f} | {settled} |")
    lines += ["", "particle-1 minus each reader (points; 95% cluster bootstrap, seed 20261101; exact McNemar)",
              "| Comparator | Difference | 95% interval | Wins / losses | McNemar p |", "|---|---|---|---|---|"]
    for name, p in a["w10b_paired"].items():
        lines.append(f"| {name} | {pts(p['delta'])} | {pts(p['ci95'][0])} to {pts(p['ci95'][1])} | {p['wins']} / {p['losses']} | {p['mcnemar_p']:.3f} |")
    lines += ["", "Question types, official judge", "| Type | n | " + " | ".join(a["w10b_arms"]) + " |", "|---|---|" + "---|" * len(a["w10b_arms"])]
    types = a["w10b_arms"]["particle-1"]["by_type"]
    for t, (n, _) in types.items():
        lines.append(f"| {t} | {n} | " + " | ".join(str(s["by_type"][t][1]) for s in a["w10b_arms"].values()) + " |")
    lines += ["", "W10c, 150 questions, particle-1 (recounted from rows)"]
    for label, s in a["w10c_particle"].items():
        lines.append(f"- {label}: {s['correct']} of {s['n']}")
    lines += ["", "GPT-6.1 Sol reader cost with cache writes at OpenAI's $2.50 per million (as recorded on 2026-10-06 -> repriced)",
              "| Arm | Correct | Cache-write tokens of prompt tokens | List $ per correct | List $ per question | Batch $ per question | Batch $ total |", "|---|---|---|---|---|---|---|"]
    for label, s in a["sol_cache_write_repricing"].items():
        lines.append(f"| {label} | {s['correct']} of {s['n']} | {s['cache_write_tokens']:,} of {s['prompt_tokens']:,} | {s['recorded_list_usd_per_correct']:.4f} -> {s['list_usd_per_correct']:.4f} | "
                     f"{s['recorded_list_usd_per_question']:.4f} -> {s['list_usd_per_question']:.4f} | {s['settled_batch_usd_per_question']:.4f} -> {s['batch_usd_per_question']:.4f} | {s['settled_batch_usd']:.2f} -> {s['batch_usd']:.2f} |")
    for judge, s in a["second_judge"].items():
        lines += ["", f"Second judge {judge} (sensitivity, not counted)",
                  "| Arm | gpt-4o correct | Second judge correct | Agreement | Cohen's kappa | Flips right to wrong | Flips wrong to right |", "|---|---|---|---|---|---|---|"]
        for name, x in s["arms"].items():
            lines.append(f"| {name} | {x['gpt4o_correct']} | {x['correct']} | {x['agreement'] * 100:.1f}% | {x['kappa']:.3f} | {x['flips_to_wrong']} | {x['flips_to_right']} |")
        for name, x in s["arms"].items():
            if "w10_secondary_agreement" in x:
                lines.append(f"- {name}: W10's 2026-10 {judge} verdicts give {x['w10_secondary_correct']} correct and agree with this run on {x['w10_secondary_agreement']} of 500")
        lines += ["", "| particle-1 minus | Difference | 95% interval | Wins / losses | McNemar p | Same conclusion as gpt-4o |", "|---|---|---|---|---|---|"]
        for name, p in s["comparisons"].items():
            lines.append(f"| {name} | {pts(p['delta'])} | {pts(p['ci95'][0])} to {pts(p['ci95'][1])} | {p['wins']} / {p['losses']} | {p['mcnemar_p']:.3f} | {'yes' if p['same_conclusion_as_gpt4o'] else 'no'} |")
    return "\n".join(lines) + "\n"


def main(argv):
    a = analyse()
    rendered, js = text(a), json.dumps(a, indent=1, sort_keys=True) + "\n"
    if "--write" in argv:
        (FINDING / "analysis.txt").write_text(rendered)
        (FINDING / "analysis.json").write_text(js)
    elif "--check" in argv:
        stale = [f for f, body in (("analysis.txt", rendered), ("analysis.json", js)) if not (FINDING / f).exists() or (FINDING / f).read_text() != body]
        if stale:
            print("recheck differs from the committed " + ", ".join(stale), file=sys.stderr)
            return 1
        print("recheck matches analysis.txt and analysis.json", file=sys.stderr)
        return 0
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

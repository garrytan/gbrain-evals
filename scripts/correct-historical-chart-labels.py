#!/usr/bin/env python3
"""Redraw historical gbrain figures with accurate labels; preserve original charts.

Requires matplotlib. September values come from the committed eight-arm summary.
May values reproduce the old stored hit flags (including abstentions), not a new
strict-retrieval score. Unmatched external protocols remain in the report tables.
"""
from collections import defaultdict
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent.parent / "docs/benchmarks"
OUTPUT = ROOT / "2026-09-09-retrieval-refresh"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                     "axes.spines.top": False, "axes.spines.right": False,
                     "svg.fonttype": "path", "svg.hashsalt": "gbrain-historical-corrections"})


def save(fig, name):
    path = OUTPUT / name
    fig.savefig(path, format="svg", metadata={"Date": "2026-09-09"},
                bbox_inches="tight", facecolor="white")
    plt.close(fig)
    path.write_text("\n".join(line.rstrip() for line in path.read_text().splitlines()) + "\n")


def headline(labels, values, title, xlabel, note, name):
    fig, ax = plt.subplots(figsize=(11, max(3, len(labels)*.45)))
    bars = ax.barh(np.arange(len(labels)), values, color="#236857")
    ax.bar_label(bars, labels=[f"{v*100:.2f}%" for v in values], padding=5, fontsize=10)
    ax.set(yticks=np.arange(len(labels)), yticklabels=labels, xlim=(0, 1.13),
           xlabel=xlabel, title=title)
    ax.set_xticks([0, .25, .5, .75, 1], ["0%", "25%", "50%", "75%", "100%"])
    ax.invert_yaxis()
    fig.subplots_adjust(bottom=.28)
    fig.text(.125, .01, note, fontsize=9, va="bottom")
    save(fig, name)


def heatmap(labels, categories, values, title, note, name):
    fig, ax = plt.subplots(figsize=(11.5, max(3.5, len(labels)*.53)))
    ax.imshow(values, vmin=0, vmax=1, cmap="Blues", aspect="auto")
    ax.set(yticks=np.arange(len(labels)), yticklabels=labels,
           xticks=np.arange(len(categories)), xticklabels=categories, title=title)
    plt.setp(ax.get_xticklabels(), rotation=25, ha="right", rotation_mode="anchor")
    for i in range(len(labels)):
        for j in range(len(categories)):
            value = values[i][j]
            ax.text(j, i, f"{value*100:.1f}%", ha="center", va="center",
                    color="white" if value > .68 else "#17212c", fontsize=10)
    fig.subplots_adjust(bottom=.30)
    fig.text(.125, .01, note, fontsize=9, va="bottom")
    save(fig, name)


wave = json.loads((ROOT / "2026-09-06-longmemeval-ranker-wave/longmemeval/ranker-wave-arms.json").read_text())["summaries"]
labels = ["A1 · hybrid, reranker off", "A2 · reranker on, autocut off", "A3 · expansion, legacy weight",
          "A4 · reranker + autocut", "A3′ · expansion budget 0.25", "A3′R · expansion 0.25 + rerank + cut",
          "Released tokenmax", "Released balanced · v0.48.4.0"]
assert len(wave) == len(labels) == 8
headline(labels, [r["recall_all_at_k"] for r in wave], "September 6: retain the evidence an answer needs",
         "All required sessions represented among five returned chunks", "470 answerable questions · all eight measured gbrain configurations\nExternal systems use different protocols and are listed separately in the report.", "longmemeval-headline.svg")
kind_keys = ["single-session-user", "single-session-assistant", "single-session-preference",
             "knowledge-update", "temporal-reasoning", "multi-session"]
kind_labels = ["User fact", "Assistant fact", "Preference", "Updated fact", "Time reasoning", "Several sessions"]
heatmap(labels, kind_labels, [[r["recall_by_type"][kind]["recall_all"] for kind in kind_keys] for r in wave],
        "September 6: all-evidence retrieval by question type", "Same five-chunk protocol · percentages are strict retrieval success, not answer accuracy", "longmemeval-per-type.svg")

raw = [json.loads(line) for line in (ROOT / "2026-05-07-longmemeval-s/rescore-may-copy.ndjson").read_text().splitlines()]
unique = {}
for row in raw:
    key = (row["adapter"], row["question_id"])
    if key in unique:
        assert unique[key]["hit_at_k"] == row["hit_at_k"], "Conflicting old hit flags"
    unique[key] = row
names = ["gbrain-keyword", "gbrain-vector", "gbrain-hybrid", "gbrain-hybrid+expansion"]
labels = ["Keyword", "Vector", "Hybrid", "Hybrid + expansion"]
rows = {name: [r for r in unique.values() if r["adapter"] == name] for name in names}
assert all(len(r) == 500 for r in rows.values())
values = [sum(r["hit_at_k"] for r in rows[name])/500 for name in names]
assert values == [.198, .974, .976, .976]
headline(labels, values, "May: historical hit@5 as reported", "Stored hit flags across all 500 questions",
         "Includes abstention questions and the original scoring semantics.\nThese are historical figures, not the corrected strict-retrieval scores.", "may-any-hit-headline.svg")
values_by_type = []
for name in names:
    groups = defaultdict(list)
    for row in rows[name]:
        groups[row["question_type"]].append(row["hit_at_k"])
    values_by_type.append([sum(groups[k])/len(groups[k]) for k in kind_keys])
heatmap(labels, kind_labels, values_by_type, "May: historical hit flags by question type",
        "Includes abstention questions. Use the report's rescored figures for strict retrieval.", "may-any-hit-per-type.svg")
print("Redrew four historical gbrain figures; original charts and measurements remain available")

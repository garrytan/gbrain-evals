#!/usr/bin/env python3
"""Render standalone SVG figures from the refresh summary (requires matplotlib)."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

DIRECTORY = Path(__file__).resolve().parent.parent / "docs/benchmarks/2026-09-09-retrieval-refresh"
DATA = json.loads((DIRECTORY / "summary.json").read_text())
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11,
                     "axes.spines.top": False, "axes.spines.right": False,
                     "svg.fonttype": "path", "svg.hashsalt": "gbrain-retrieval-refresh"})


def save(fig, name):
    path = DIRECTORY / name
    fig.savefig(path, format="svg", metadata={"Date": "2026-09-09"},
                facecolor="white", bbox_inches="tight")
    plt.close(fig)
    path.write_text("\n".join(line.rstrip() for line in path.read_text().splitlines()) + "\n")


cells = ["precision-keyword", "precision-hybrid", "precision-adaptive",
         "precision-hybrid-rerank", "precision-adaptive-rerank"]
labels = ["Keyword", "Broad hybrid", "Tight adaptive", "Broad + rerank", "Tight + rerank"]
x = np.arange(len(cells))
fig, ax = plt.subplots(figsize=(10, 5))
for offset, metric, color, label in [(-.19, "meanPrecision", "#236857", "Mean precision"),
                                    (.19, "meanRecall", "#5677a0", "Mean recall")]:
    values = [DATA["precision"][cell][metric] for cell in cells]
    bars = ax.bar(x + offset, values, .36, color=color, label=label)
    ax.bar_label(bars, fmt="%.3f", padding=3, fontsize=9)
ax.set(xticks=x, xticklabels=labels, ylim=(0, 1.16), ylabel="Upstream mean score (0–1)",
       title="Keeping fewer memories makes candidate order matter")
ax.legend(loc="upper left", frameon=False, ncols=2)
fig.subplots_adjust(bottom=.24)
fig.text(.12, .01, "PrecisionMemBench · all 77 cases · null scores excluded from each mean\n"
         "Tight caps: entity 1, other 1, minimum 1. Superseded beliefs remain in the index.", fontsize=9)
save(fig, "precision.svg")

concept = DATA["concept"]
order = [("concept-baselines", "grep-only", "Keyword"), ("concept-baselines", "vector", "Vector"),
         ("concept-baselines", "vector-grep-rrf-fusion", "Reference hybrid"),
         ("concept-baselines", "gbrain", "gbrain · lexical gate"),
         ("concept-ungated", "gbrain", "gbrain · always gate"),
         ("concept-rerank", "gbrain", "gbrain · lexical + rerank")]
values = [next(r for r in concept if r["cell"] == cell and r["name"] == name)["splits"]["holdout"]["ndcg5"]
          for cell, name, _ in order]
fig, ax = plt.subplots(figsize=(10, 4.7))
bars = ax.barh(np.arange(len(order)), values, color=["#94a3b8"]*3 + ["#236857"]*3)
ax.bar_label(bars, fmt="%.4f", padding=5, fontsize=10)
ax.set(yticks=np.arange(len(order)), yticklabels=[r[2] for r in order], xlim=(0, 1),
       xlabel="Held-out nDCG@5 (0–1)", title="Concept search: compare the full configurations")
ax.invert_yaxis()
fig.subplots_adjust(bottom=.27)
fig.text(.12, .01, "181 held-out questions · Voyage voyage-4 at 1024 dimensions · seed 42\n"
         "Higher means more relevant pages nearer the top; this is not answer accuracy.", fontsize=9)
save(fig, "concept.svg")

templates = DATA["relationships"]["by_template"]
x = np.arange(len(templates))
fig, ax = plt.subplots(figsize=(9, 4.7))
for offset, arm, color in [(-.19, "off", "#94a3b8"), (.19, "on", "#236857")]:
    values = [r[arm]["recall_at_5"] for r in templates.values()]
    bars = ax.bar(x+offset, values, .36, color=color, label="Relationship retrieval " + arm)
    ax.bar_label(bars, fmt="%.3f", padding=3, fontsize=9)
ax.set(xticks=x, xticklabels=list(templates), ylim=(0, 1.15), ylabel="Mean page recall@5 (0–1)",
       title="Production relationship retrieval: the parser is part of the result")
ax.legend(frameon=False, fontsize=9, loc="upper left")
fig.subplots_adjust(bottom=.25)
fig.text(.12, .01, "One extracted index per seed · identical query vectors · five chunks, no duplicate-slot refill\n"
         "Three ingestion orders repeat the same questions. Gold labels are unchanged.", fontsize=9)
save(fig, "relationships.svg")

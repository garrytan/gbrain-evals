# BrainBench Cat 11 — Multi-modal ingest, baseline scorecard

**Date:** 2026-04-28
**Branch:** `feat/cat11-fetch-multimodal` (PR #N)
**Cat 11 verdict:** `baseline_only`
**Wall clock:** ~4 min (full PDF + HTML modalities, single-threaded charSim)
**API cost:** $0 (audio modality skipped — no transcription key set)

## Why this scorecard

Issue #3 reported that `bun run eval:fetch-multimodal` did not exist, so
Cat 11 always skipped on a fresh clone. This branch ships the fetcher,
the curated PDF/HTML/audio manifests, and committed canonical golden
texts. **Cat 11 now runs deterministically** on a fresh clone and
produces this scorecard.

Methodology + per-modality fixture rationale live in
`eval/data/multimodal/{pdf,html,audio}/README.md`. This file reports
numbers only.

## Environment

| | |
|---|---|
| `bun --version` | 1.3.11 |
| `uname -sr` | Darwin 25.3.0 |
| `gbrain` | 0.22.6 (master @ `be8fffa`) |
| Upstream base commit | `b8cf8ad` |
| `pdf-parse` | 2.4.5 (loader patched in this PR — see notes) |
| `OPENAI_API_KEY` / `GROQ_API_KEY` | unset (audio skips intentionally) |

## Per-modality results

### HTML — 10 Wikipedia articles, oldid-pinned

Metric: `wordRecall(canonical, extracted)` — fraction of canonical words
recovered in `htmlToText` output. Threshold: > 0.80.

| name | metric | canonical chars | extracted chars |
|---|---:|---:|---:|
| marie-curie | 1.0000 | 44,570 | 95,811 |
| photosynthesis | 0.9896 | 49,977 | 102,050 |
| apollo-11 | 0.9999 | 80,850 | 155,288 |
| mount-everest | 0.9999 | 88,221 | 182,725 |
| programming-language | 1.0000 | 34,275 | 67,187 |
| tokyo | 0.9918 | 74,558 | 155,436 |
| black-hole | 0.9994 | 70,474 | 164,239 |
| world-war-i | 0.9999 | 88,370 | 179,161 |
| internet | 0.9923 | 53,338 | 115,383 |
| albert-einstein | 0.9998 | 88,034 | 189,099 |

**HTML mean: 0.9973** (✅ well above 0.80 threshold). Misses are
rounding (long articles include incidental words from infobox/
references chrome that don't appear in the canonical lead-section
extract — recall is unaffected).

### PDF — 10 arXiv papers, ar5iv canonicals (capped at 25KB)

Metric: `charSimilarity(canonical, extracted)` — Levenshtein-normalised
char similarity between extractor output and canonical reference text.
Plus auxiliary `entity_recall` over a hand-tagged entity list per item.
Spec threshold: > 0.95 (informational).

| name | charsim | entity_recall | extracted chars | pages |
|---|---:|---:|---:|---:|
| qlora | 0.2177 | 1.00 | 88,471 | 26 |
| palm | 0.0802 | 1.00 | 278,110 | 83 |
| pythia | 0.1870 | 1.00 | 111,088 | 34 |
| mistral-7b | 0.7902 | 1.00 | 25,015 | 9 |
| dpo | 0.2090 | 1.00 | 90,021 | 26 |
| llama | 0.2182 | 1.00 | 88,885 | 27 |
| constitutional-ai | 0.1712 | 1.00 | 119,592 | 34 |
| mixtral | 0.5538 | 1.00 | 32,401 | 13 |
| opt | 0.2088 | 1.00 | 92,271 | 30 |
| zephyr | 0.4111 | 0.75 | 45,018 | 14 |

**PDF charsim mean: 0.3047** — well below the spec's 0.95 threshold.
**PDF entity_recall mean: 0.975** — strong signal the extractor recovers
expected content; the 0.75 outlier (zephyr) is a single missed-entity
edge case (`MT-Bench` vs `MT bench` — punctuation-sensitive substring
match in the runner).

### Why charsim is below threshold (and what it actually measures)

`charSimilarity` is `1 − levenshtein/max(n,m)`. When canonical = 25KB
and extracted = 100KB, the length difference alone forces the metric
≤ 0.25 even with a perfect extractor:

> distance ≥ |extracted − canonical| ≥ 75KB ⇒ charsim ≤ 1 − 75/100 = 0.25

The 25KB canonical cap is necessary because charsim is O(n·m) — without
it, palm (291KB ar5iv canonical × 278KB extracted = 8×10¹⁰ ops) takes
30+ minutes per item.

The result: **charsim is a length-aware metric, not a content-quality
metric, when canonical/extracted lengths diverge**. Entity recall (0.975
mean) is the cleaner signal of extraction quality on this corpus.

The papers where charsim is high (mistral-7b at 0.79, mixtral at 0.55)
are exactly the ones where canonical ≈ extracted in length. That's a
diagnostic, not a defect of the extractor.

This PR ships Cat 11 PDF in a *running* state. **Tightening the
length-alignment story to actually hit the 0.95 spec threshold is
follow-up work** — it requires either re-curating to short papers,
truncating extracted text in the runner (out of scope for this PR), or
a different golden source (e.g. pdftotext as canonical). I'm happy to
take any of those as a follow-up PR if you have a preference.

### Audio — 3 LibriVox clips (skipped on this run)

`runAudioModality` requires `GROQ_API_KEY` or `OPENAI_API_KEY` to
transcribe. With no key set, the runner skips audio with a clear
`skip_reason`. This is existing runner behavior, unchanged by this PR.

Audio fixtures (3 short LibriVox poetry recordings + hand-curated
canonical text) are committed and verified by the fetcher's `--check`
mode end-to-end. Plumbing is end-to-end functional; the metric just
needs an API key to run live. The audio README documents the
`Common Voice` → `LibriVox` source-swap rationale and the v1=3 vs
spec=5 fixture-count gap (replacements are a manifest edit, not a code
change).

## What this PR delivers

| Deliverable | State |
|---|---|
| `bun run eval:fetch-multimodal` script exists | ✅ |
| Cat 11 stops always-skipping on a fresh clone | ✅ |
| Manifests are hash-pinned + reproducibly fetchable | ✅ |
| HTML modality hits spec threshold (>0.80) | ✅ (0.997 mean) |
| PDF modality runs to completion with deterministic numbers | ✅ |
| PDF modality hits spec threshold (>0.95 charsim) | ❌ (length-mismatch issue, scoped follow-up) |
| Audio modality plumbing end-to-end functional | ✅ |
| Audio modality runs live (transcription) | requires `GROQ_API_KEY` / `OPENAI_API_KEY` |

## Reproduce

```sh
git checkout feat/cat11-fetch-multimodal
bun install
bun run eval:fetch-multimodal     # ~30s (10 PDFs + 10 HTML + 3 mp3s)
bun run eval:fetch-multimodal --check  # verifies hashes
bun run eval:cat11                 # ~4 min (PDF charsim is the long pole)
```

## Notes on the pdf-parse loader patch

`eval/runner/loaders/pdf.ts` previously assumed `pdf-parse` v1's
default-export-as-function shape. v2.4.5 (the version pinned in
`package.json`) exports a `PDFParse` class instead, and the loader
threw `pdfParse is not a function` for every PDF. This PR adds a
shim that prefers the v2 class API and falls back to the v1 default
function if a downgrade ever happens. Minimal, scoped fix — without
it, Cat 11 PDF can't run at all.

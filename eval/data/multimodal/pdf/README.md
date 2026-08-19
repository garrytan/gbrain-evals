# Cat 11 — PDF fixtures

10 arXiv papers, hand-picked for layout + math diversity. Each pinned to a
specific arXiv version (`vN`) so the source bytes never drift.

## Source + license

- **Binary source**: `https://arxiv.org/pdf/<id>v<n>.pdf`
- **Canonical text**: derived from the ar5iv-rendered HTML at
  `https://ar5iv.labs.arxiv.org/html/<id>v<n>` — extracted from inside
  `<article class="ltx_document">`, then run through the same `htmlToText`
  the Cat 11 runner uses for its HTML modality. ar5iv is an independent
  LaTeXML re-render, so it's a reasonable golden reference for testing the
  PDF extractor without circular dependence.
- **Canonical truncation**: capped at 25KB (see `MAX_PDF_CANONICAL_BYTES`
  in `eval/cli/fetch-multimodal.ts`). The runner uses Levenshtein-based
  `charSimilarity`, which is O(n*m); without a cap, the long papers
  (palm at 290KB ar5iv text, etc.) take 30+ minutes per item. 25KB keeps
  the full PDF run under ~5 min while still measuring extraction over a
  meaningful span (title, authors, abstract, intro, first methods sections).
- **License**: each paper is independently CC-BY-4.0 or CC-BY-SA-4.0 —
  verified at `arxiv.org/abs/<id>` before inclusion. The umbrella string in
  `fixtures.json` is "CC-BY-4.0 or CC-BY-SA-4.0 (per-paper)".

| name | arXiv id | license |
|------|----------|---------|
| qlora | 2305.14314 | CC-BY-4.0 |
| palm | 2204.02311 | CC-BY-4.0 |
| pythia | 2304.01373 | CC-BY-SA-4.0 |
| mistral-7b | 2310.06825 | CC-BY-4.0 |
| dpo | 2305.18290 | CC-BY-4.0 |
| llama | 2302.13971 | CC-BY-4.0 |
| constitutional-ai | 2212.08073 | CC-BY-4.0 |
| mixtral | 2401.04088 | CC-BY-4.0 |
| opt | 2205.01068 | CC-BY-4.0 |
| zephyr | 2310.16944 | CC-BY-4.0 |

## Why these 10

Selection criteria, in priority order:
1. **CC-licensed** — verified per-paper (arxiv.org/abs/<id> shows the
   license).
2. **Has an ar5iv HTML version** — the canonical text pipeline depends
   on `ar5iv.labs.arxiv.org/html/<id>v<n>` returning a real LaTeXML render
   (not a redirect to the abstract page). A few candidates were dropped at
   the bootstrap stage for failing this check.
3. **Layout diversity** — single-column (e.g. mistral-7b, mixtral) +
   two-column (e.g. opt, palm), light math (zephyr) + dense math
   (constitutional-ai, dpo).
4. **Length diversity** — short technical reports (mistral-7b, mixtral)
   through long full papers (palm, opt) so the extractor is exercised at
   different scales.

## Caveat: char-similarity scores will be below the spec threshold

`cat11-multimodal.ts:8` lists an informational threshold of `>0.95` char
similarity. The numbers this fetcher produces are well below that for most
items because the canonical (capped at 25KB) is much shorter than the
text pdf-parse extracts from the full PDF (60-300KB). Levenshtein-based
similarity normalises by `max(canonical, extracted)`, so length mismatch
alone caps the metric well below 0.95 even with a perfect extractor.

This PR brings Cat 11 PDF from "always skipped" to "deterministically
runs and produces reproducible numbers." Improving canonical/extracted
length alignment to actually hit the 0.95 threshold is a separate design
problem (longer canonicals → unbounded runtime; pre-trimmed PDFs → a
non-arXiv hosting story). Tracking that as future work, not this PR.

The auxiliary `entity_recall` detail (per-item, when the manifest
declares `entities`) is length-independent and remains a useful signal
for extraction quality.

## Running

```sh
# Full fetch + verify (default)
bun run eval:fetch-multimodal --modality pdf

# Verify only — useful in CI on a clean clone
bun run eval:fetch-multimodal --modality pdf --check
```

Files land at `eval/data/multimodal/pdf/<name>.pdf` (gitignored). Canonical
text at `eval/data/multimodal/pdf/canonical/<name>.txt` is committed.

## Refreshing or expanding the corpus

To add a new paper, swap one out, or rebuild after upstream changes:

```sh
# 1. Edit fixtures.json — add/replace items, set sha256 to ""
# 2. Run bootstrap (downloads + recomputes hashes + re-derives canonicals)
bun run eval:fetch-multimodal --modality pdf --bootstrap
# 3. Commit the updated fixtures.json + canonical/<name>.txt files
```

Bootstrap is intentionally maintainer-only — end users never need it. The
canonical text files in git are the deterministic golden references.

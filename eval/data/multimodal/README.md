# Cat 11 fixtures — multi-modal ingestion fidelity

Committed, hermetic fixture set for `eval/runner/cat11-multimodal.ts`. All
content is synthetic prose authored for this repo (no external source, no
real names, no licenses to track beyond this repo's own).

Layout per modality directory:

- `fixtures.json` — manifest: one entry per item with `path`,
  `canonical_path`, `sha256` (source file), `canonical_sha256` (canonical
  text). The runner verifies both hashes before scoring; a mismatch is a
  harness error (excluded from means, capped), never a silent score.
- `<name>.md` / `<name>.html` — raw source fed to gbrain's
  `importFromContent` as-is.
- `<name>.txt` — canonical prose the indexed output is scored against
  (word recall, multiset semantics).

Modalities:

- `markdown/` — 3 fixtures. Canonical = the markdown body after frontmatter,
  verbatim. One fixture carries a small `ts` fence to exercise gbrain's
  fenced-code chunk path.
- `html/` — 2 fixtures. Canonical = the visible prose (headings, paragraphs,
  list items). gbrain has no HTML extractor as of v0.47.6.0; the raw HTML
  goes through ingest as-is and the metric checks the prose survives into
  the indexed chunks.
- `audio/` — intentionally absent. Binary clips are not committed (audit
  retrieval-cats-03: the fetch script the old runner header advertised never
  existed). The runner marks the modality skipped with that reason. To run
  it locally, create `audio/fixtures.json` in the same manifest shape with
  clip + transcript pairs and set `GROQ_API_KEY` or `OPENAI_API_KEY`.
- `pdf/` — intentionally absent. gbrain v0.47.6.0 has no PDF ingest path;
  scoring the eval's own pdf extractor measured nothing about gbrain (audit
  retrieval-cats-12).

Regenerating: edit the fixture files, then recompute both sha256 fields in
the manifest (`shasum -a 256 <file>`). Keep fixtures small (~1.3 KB) — the
negative control truncates each source to 25% and expects recall to crater,
which needs bodies long relative to their frontmatter/head.

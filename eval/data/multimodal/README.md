# Cat11: does ingestion preserve the text?

These fixtures test whether text survives when gbrain imports different source formats. For example, a Markdown page can contain frontmatter and a code block; the words needed later should still be present in the indexed chunks.

All supplied content is fictional and authored for this repository.

## Files and expected behavior

| Directory | Contents and purpose |
|---|---|
| `markdown/` | Three pages. Expected text is the body after frontmatter; one page includes a TypeScript fence. |
| `html/` | Two pages. Expected text is the visible prose in headings, paragraphs and lists. |
| `audio/` | Not committed. Local runs need a manifest, audio/transcript pairs and a supported transcription key. |
| `pdf/` | Not committed. The documented v0.47.6.0 path did not support PDF ingestion, so the test does not claim PDF coverage. |

The HTML fixtures pass through `importFromContent` as raw HTML. This checks that the prose survives indexing; it does not establish the quality of a dedicated HTML extractor.

Each supported directory has a `fixtures.json` manifest. It identifies the input `path`, expected-text `canonical_path`, and SHA-256 hashes for both. The runner checks those hashes before scoring. A missing file or changed hash is a harness error, not a zero score or a silent pass.

The score measures expected-word recall, including repeated occurrences of a word. A negative control truncates the source to 25%; that should make the score fall and demonstrates that the test can detect lost text.

## Run and maintain the fixtures

From the repository root:

```sh
bun eval/runner/cat11-multimodal.ts
bun test test/eval/cat11.test.ts
```

Absent modalities are recorded as skipped. Do not describe the fixture set as PDF or audio coverage merely because those names exist in the runner.

For a deliberate fixture change, edit the source and expected text together and recompute their manifest hashes. Keep bodies large enough relative to frontmatter for the truncation control to detect loss; the original fixtures are about 1.3 KB each. A documentation rewrite should leave these benchmark inputs unchanged.

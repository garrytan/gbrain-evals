# Cat 11 — Audio fixtures

3 short LibriVox poetry recordings from `Short Poetry Collection 029`,
hosted on Internet Archive. Each is by a different reader and a different
public-domain poet.

## Source + license

- **Binary source**: `https://archive.org/download/short_poetry_029_librivox/<file>.mp3`
- **Canonical text**: hand-curated and committed to
  `eval/data/multimodal/audio/canonical/<name>.txt`. Each file matches the
  standard LibriVox-reader template — title-and-author preamble, the poem,
  and the closing announcement — so WER measures transcription accuracy
  against what the reader actually speaks.
- **License**: public domain (LibriVox recordings; pre-1928 source poems).

| name | reader / poem | poet |
|------|---------------|------|
| a-white-rose | "A White Rose" (Sanders) | John Boyle O'Reilly |
| all-religions-are-one | "All Religions Are One" (Bodie) | William Blake |
| the-engine | "The Engine" (Howlett) | Ella Wheeler Wilcox |

## Why LibriVox / archive.org and not Common Voice

The Cat 11 spec at `eval/runner/cat11-multimodal.ts:8` calls for
"5 Common Voice CC0 clips." Common Voice is published as a multi-GB
tarball; Mozilla does not expose individual clip URLs, so a hash-pinned
per-file fetcher cannot target it directly. LibriVox via Internet Archive
gives:
- stable per-file URLs (`archive.org/download/<item>/<file>.mp3`)
- public-domain licensing (recordings + source texts both)
- transcript text that exists independently (the source poem)

The fetcher is content-agnostic — swapping in 5 mirrored Common Voice
clips later (e.g. attached to a GitHub release on this repo) is a manifest
edit, not a code change.

## v1 ships 3 fixtures, not 5

The spec says 5; this v1 fetcher ships 3. Two more LibriVox poems were
curated earlier but dropped at write-time when their canonical-text
preparation hit content-handling limitations on my end. Adding two more
short, content-neutral poems from the same `short_poetry_029_librivox`
collection — or any other public-domain collection — is purely a
manifest edit. See "Refreshing or expanding" below.

The runner already handles N≠5 cleanly: it iterates `manifest.items`
and reports `mean_metric` over `items_attempted`, so 3 fixtures produce a
valid (if narrower) audio score.

## Audio is API-gated

`runAudioModality` requires `GROQ_API_KEY` or `OPENAI_API_KEY` (or a
test-injected transcriber stub) to actually run. Without one, audio
modality skips with a clear `skip_reason` even when fixtures are present —
that's existing runner behavior, unchanged by this PR.

## Running

```sh
bun run eval:fetch-multimodal --modality audio          # fetch + verify
bun run eval:fetch-multimodal --modality audio --check  # verify only
GROQ_API_KEY=... bun run eval:cat11                     # actually transcribe
```

## Refreshing or expanding

```sh
# 1. Pick a clip from archive.org (any LibriVox item works)
# 2. Add to fixtures.json: name / path / canonical_path / source_url, sha256:""
# 3. Hand-write canonical/<name>.txt to match what the reader speaks
#    (LibriVox preamble + poem text + LibriVox closing)
# 4. Bootstrap (downloads mp3 + computes hash; canonicals are not derived for audio)
bun run eval:fetch-multimodal --modality audio --bootstrap
# 5. Commit fixtures.json, canonical/<name>.txt, and the new mp3 stays gitignored
```

# Cat 11 — HTML fixtures

10 Wikipedia articles, pinned by `oldid` so the source HTML and canonical
extract are byte-stable across fetches and machines.

## Source + license

- **Binary source**: `https://en.wikipedia.org/wiki/<Title>?oldid=<rev_id>`
- **Canonical text**: MediaWiki extracts API,
  `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&revids=<rev_id>`
  — returns plain text for the lead + body, parsed as JSON and pulled from
  `query.pages[*].extract`.
- **License**: CC-BY-SA-4.0 (Wikipedia content).

| name | article | revision (oldid) |
|------|---------|------------------|
| marie-curie | Marie Curie | 1350691364 |
| photosynthesis | Photosynthesis | 1348236588 |
| apollo-11 | Apollo 11 | 1350616946 |
| mount-everest | Mount Everest | 1350333656 |
| programming-language | Programming language | 1350063785 |
| tokyo | Tokyo | 1351096923 |
| black-hole | Black hole | 1351334948 |
| world-war-i | World War I | 1351326033 |
| internet | Internet | 1346604556 |
| albert-einstein | Albert Einstein | 1351479489 |

## Why these 10

Mix of:
- **Biography**: marie-curie, albert-einstein
- **Science / technical**: photosynthesis, black-hole, programming-language
- **History / narrative**: apollo-11, world-war-i
- **Geography / place**: mount-everest, tokyo
- **Technology**: internet

The runner uses `wordRecall` over the canonical extract — the metric tests
whether the extractor recovers the text without specifying *how cleanly*.
Wikipedia's full HTML pages include heavy chrome (nav, infoboxes, edit
links, citations) that the runner's regex `htmlToText` strips imperfectly,
but the recall metric is tolerant of extra noise as long as canonical
words are present.

## Running

```sh
bun run eval:fetch-multimodal --modality html         # fetch + verify
bun run eval:fetch-multimodal --modality html --check # verify only
```

## Refreshing or expanding

```sh
# 1. Edit fixtures.json — pick new article(s), set oldid + sha256:""
#    Find oldid via the article's "View history" tab on Wikipedia, or:
#      curl -s "https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=<Title>&format=json&rvlimit=1" | jq '.query.pages[].revisions[0].revid'
# 2. Bootstrap to download + hash + canonicalise
bun run eval:fetch-multimodal --modality html --bootstrap
# 3. Commit fixtures.json + canonical/<name>.txt
```

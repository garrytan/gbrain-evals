# Hangul mention boundaries (2026-10-05)

## The finding

gbrain's mention linker now matches a Korean (Hangul) name only when the name ends at a non-Hangul character or at an attached title, particle or copula form. On 7.3M characters of public Korean text, that rule cut word-internal false matches from 1,041 to 11 and kept 65 of 74 real name mentions. Precision over real names plus word-internal matches rose from 6.6% to 85.5%. The rule shipped in gbrain [#6080](https://github.com/garrytan/gbrain/pull/6080) (v0.60.69.0, merge `67c4ff27b`). The before measurement is gbrain master `c9ba77823` (v0.60.68.0).

Before the change, a Hangul name had to start a word but anything could follow it, because Korean particles attach directly to names (지원에게, "to Jiwon"). That let 지원 match inside 지원하는 ("supporting") and 우리 inside 우리나라 ("our country"). Without an end boundary, 39% of all Hangul matches (1,041 of 2,651) were word-internal.

| Matches (occurrences) | NAME | WORD | INTERNAL |
|---|---:|---:|---:|
| No end boundary (`c9ba77823`) | 74 | 1,536 | 1,041 |
| Suffix end rule (`67c4ff27b`) | 65 | 1,460 | 11 |

## Method

**Corpus.** 10,621 Korean Wikipedia paragraphs (KorQuAD 1.0 train and dev contexts, 5.5M characters) plus 50,000 short Korean movie reviews (NSMC test split, 1.8M characters). The reviews contribute informal, often unspaced text. `scripts/build-corpus.py` downloads both. The corpus text is not committed.

**Gazetteer.** 30 linkable titles: 20 common Korean given names, 5 full names, 3 two-syllable titles that are also common words, and 2 made-up company names. All are generic, so none names a real person or company. `scripts/scan.ts` runs the real matcher from a gbrain checkout (`GBRAIN_DIR`): `buildGazetteer` on PGLite, then `findMentionedEntities` one sentence at a time, so every occurrence counts.

**Labels.** `scripts/label.py` asks `gpt-6.1-sol` to label each match in context, assuming an entity with that exact name exists. Total cost was $0.36.

- **NAME:** the string is used as a name.
- **WORD:** an ordinary word with the same spelling, standing as its own word, such as 우리 "we" or 지원 "support".
- **INTERNAL:** only part of a longer word, such as 우리나라 or 지원하는.

**Record.** `labels.jsonl` holds one row per match from the before scan. Each row has genre, document index, name, label, whether the end rule keeps it, and a hash of the context (not the text). `python3 scripts/summarize.py labels.jsonl` reproduces the table. The after scan also found 16 occurrences the before scan had hidden: matches dedupe to one per sentence, and an earlier word-internal match had taken the slot. These 16 are ordinary words and are not in the table.

## Limits

- **Lost names.** The rule misses 9 of the 74 real names. Six come from unspaced informal reviews, where the name runs into the next word. The rest carry a suffix outside the rule's lists.
- **Homonyms.** WORD matches are 58% of matches before and 95% after: on a general-purpose corpus most hits are the everyday word. A boundary rule cannot separate a name from the same word standing alone. gbrain's `mentions.ignore` stops a name from linking.
- **Single labeler.** One model labeled every match, with no second rater. The large INTERNAL effect is not sensitive to that, but the 74-name count carries labeling noise.

## Changelog

- 2026-10-05: first version, mirroring gbrain #6080.

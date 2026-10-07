# Cat 21 paraphrase questions, v1

24 code-search questions for [`cat21-code-retrieval.ts`](../../runner/cat21-code-retrieval.ts), two for each of the 12 gold files the original named questions use. Each question describes what a function or its file does without using the function's identifier or the file name, so the keyword arm can't find the answer by matching the symbol.

- Written 2026-10-06 by an agent (the 2026-10 follow-up round, lane B) from gbrain `c5fb0201` `src/core`, around the known gold files. That makes them development evidence, not held-out questions.
- Frozen before any embedder ran on them: `questions.json` sha256 `63f8401d69a7d920f794584a5afce0540fa7b9342f8ce0f444da2f794fa9e713`. A change is a new version (`cat21-paraphrase-v2`), never an edit.
- Run them with `--split paraphrase`, or `--split both` to keep the 12 named questions beside them as a regression split.

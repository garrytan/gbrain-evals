# N9 composed multi-hop questions (world-v1), grammar v1

125 composed questions over world-v1 (94 two-hop, 31 three-hop) in seven families, each with a canonical wording (`template_text`, plain relation verbs) and one seeded paraphrase (`paraphrase_text`). Gold (answers, support pages, required pages) is derived from the generator-written `_facts` metadata of world-v1, never from gbrain output. See [the generator](../../generators/n9-multihop-paraphrase-gen.ts) for the families, frames, gold rules and controls.

This file was committed with its hash before any scoring run. The runner refuses a file that differs from the generator. Anyone changing gbrain's relational parser should not read these questions: they are the held-out wording for that work. The 2026-09-29 one-hop paraphrase split (`eval/data/relational-paraphrase-v1`) is development data and is separate from this set.

| File | SHA-256 |
|---|---|
| questions.json | `1a2bdd9c00dbb1c106d117dae1005a8a903a9f9a4a299546d3edea2bb0def396` |
| eval/generators/n9-multihop-paraphrase-gen.ts | `890cdde7d7e051634102ca21c3d0709c1afd2c963afcbad471751b526551eb95` |

Regenerate and check: `bun eval/generators/n9-multihop-paraphrase-gen.ts --check`.

# Sealed confirmation set v2: protocol, 2026-10-01

This is a data and access protocol, not a benchmark result. It freezes a second sealed test set for gbrain, built because [v1](2026-09-29-sealed-confirmation-protocol.md) turned out too easy to confirm an evidence-delivery gain: on v1 the chunk default already answered 147 of 150 questions ([auto v2 check](2026-09-30-evidence-auto-v2.md)). No gbrain run had touched v2 when this protocol was written. Opening it is a release decision, under the same access rules as v1. (2026-10-02: release decision 1 has since opened it; see [Openings](#access-policy).)

## What changed from v1

v2 keeps v1's custody design (invented personas, labels from the generation ledger, per-session fact audits, opaque ids, SHA-256 commitments, private files, an access-logged runner) and makes the retrieval problem harder:

| | v1 | v2 |
|---|---|---|
| Personas / questions | 30 / 150 | 40 / 200 |
| Chats per history | 55 (20 persona, 35 filler) | 46 (16 persona, 30 filler) |
| History size | about 65,000 tokens | 134,830 to 150,385 tokens, median 142,697 (characters / 4) |
| Persona timeline | about five months | eight to twelve months |
| Question kinds per persona | one each of single-session, multi-session, temporal, knowledge update, abstention | two multi-session, one temporal, one knowledge update, one abstention; no single-session |
| Gold chats per answerable question | 1 to 3 | multi-session 3 to 4 (median 4), temporal 2 to 3, knowledge update 3 to 4 |
| Generator | `gpt-6-sol` writes and audits | `gpt-6-sol` plans and audits; `gpt-6-luna` writes chats and fillers |

For scale, LongMemEval-S histories hold about 50 chats and 115,000 tokens, so v2 histories are about LongMemEval-S size. Plan rules enforced in code ([`sealed-confirmation-v2-gen.ts`](../../eval/generators/sealed-confirmation-v2-gen.ts), `validatePlanV2`): multi-session questions need three to five evidence chats at least 60 days apart; temporal questions need two to four chats spanning at least 90 days; knowledge-update questions need an initial value and at least two changes over three or more chats spanning 30 or more days; the two multi-session questions share no evidence; each persona has at least six planted near-miss facts over four or more chats. Prompts are frozen in [`sealed-confirmation-v2-prompts.ts`](../../eval/generators/sealed-confirmation-v2-prompts.ts) and hashed in the manifest. The occupation, hobby and life-arc seed lists share nothing with v1's (a unit test checks this). The general-help filler topics are v1's list, with new text.

## What was built

| Item | Value |
|---|---|
| Questions | 200: 80 multi-session, 40 temporal, 40 knowledge update, 40 abstention; 160 answerable |
| Generation date | 2026-10-01, seed 20261002 |
| Generator code | commit `45016f2`, files hashed in the manifest |
| Plans | 40 of 40 valid on the first attempt |
| Persona chats | 640 written, 616 passed the fact audit within three attempts (744 attempts) |
| Fillers | 176 written, 174 clean; each history takes 30 |
| Questions with an audit flag | 19 (8 multi-session, 6 abstention, 4 temporal, 1 knowledge update) |

A flagged question is one whose evidence includes a chat that failed all three audit attempts. Flagged questions stay in, as in v1; items are never deleted for audit or solvability results.

## Solvability controls

The sealed protocol's reader (Claude Sonnet 4.6, temperature zero, LongMemEval's reading prompt) and judge (`gpt-4o-2024-08-06`, LongMemEval's per-kind prompts) answered every question three ways before sealing:

- **Oracle:** every gold chat, whole.
- **Chunk oracle:** at most five chunks of about 300 words (50-word overlap) from the gold chats, one per evidence fact, picked by word overlap with the ledger's statement of that fact. This is generous: it is handed the right chunks, which a retriever would still have to find among about 140,000 tokens.
- **No memory:** no chats.

| Kind | Questions | Oracle | Chunk oracle | No memory | Evidence chunks needed (median) |
|---|---:|---:|---:|---:|---:|
| Multi-session | 80 | 80 | 78 | 0 | 4 |
| Temporal reasoning | 40 | 39 | 38 | 0 | 2 |
| Knowledge update | 40 | 40 | 40 | 0 | 3 |
| Abstention | 40 | 40 | 40 | 40 | 2 |
| **All** | **200** | **199** | **196** | **40** | |

**What this means.** The questions are answerable from their gold chats (199/200), and none of the 160 answerable ones can be guessed (0/160 with no memory). The evidence always fits in five chunks: 71 questions need two chunks, 61 need three and 68 need four. So the set does not make chunk delivery fail by construction. What it makes hard is retrieval: a top-five chunk list must contain three or four specific chunks from chats months apart, among 46 chats per history that include the persona's own near misses and superseded values. v1's answerable questions had one to three gold chats. Whether that is hard enough to separate delivery policies is what a preregistered run would measure; this check cannot. Summary: [`solvability.json`](../../eval/data/sealed-confirmation-v2/solvability.json).

## Overlap audit

[`sealed-confirmation-overlap.py`](../../scripts/sealed-confirmation-overlap.py), unchanged apart from its usage text, compared the sealed files with LongMemEval-S and LongMemEval-M (cleaned releases, SHA-256 `d6f21ea9…` and `9d79e552…`) and the committed gbrain-evals data. Full numbers: [`overlap-audit.json`](../../eval/data/sealed-confirmation-v2/overlap-audit.json).

| Check | LongMemEval-S (19,195 chats) | LongMemEval-M (51,661 chats) |
|---|---:|---:|
| Sealed questions identical after normalization | 0 of 200 | 0 of 200 |
| Highest question word-set similarity (Jaccard) | 0.33 | 0.33 |
| Sealed questions at similarity 0.5 or higher | 0 | 0 |
| Persona full names found | 0 of 40 | 0 of 40 |
| Persona given names or surnames found | 2 of 75 | 2 of 75 |
| Sealed chats sharing a 13-word run of text | 6 | 10 |

Every chat that shares a 13-word run is a filler, and the shared text is stock phrasing: six copies of one filler share the stock closing line of a cover letter with a LongMemEval cover-letter chat, and four copies of another share a textbook definition of public-key cryptography (M only). No persona chat shares any 13-word run. The two name tokens each appear in a single LongMemEval chat. All 500 M questions are the same as S's.

Persona names appear nowhere in `eval/data`. Against Cat13, the highest similarity to its 50 committed queries is 0.14, and no sealed question mentions any of the 30 world-v1 concept names. As in v1, 241 (S) and 251 (M) of 612 capitalized words from the persona facts also appear somewhere in LongMemEval; these are ordinary words and common names inside invented place names, and a shared single word is not shared content.

## Access policy

The sealed files are `questions.json`, `labels.json` and `ledger.json`. Their commitments are in the public [`manifest.json`](../../eval/data/sealed-confirmation-v2/manifest.json):

| File | SHA-256 | Bytes |
|---|---|---:|
| `questions.json` | `8d29e92dc6792fb444e564ca556acd5cb4566ec14a6080c0e2e1ee8e8bd98a38` | 25,534,003 |
| `labels.json` | `83bf52d11e0a26f64f1ece8ce5ac637b81844e38e67c5df1495cb7614a0357c4` | 65,802 |
| `ledger.json` | `03df09aacbe85dbfa659da38b67aa6ce88305e52b799b2251b16b6b3a0e2e8c1` | 22,462,410 |

The rules are v1's ([access policy](2026-09-29-sealed-confirmation-protocol.md#access-policy)): owner custody outside this repository; a dated preregistration committed before any opening; every label read through the runner, which checks the commitment and appends to `access-log.jsonl` first; aggregates only; at most three release decisions; no tuning. Run the runner with `--manifest eval/data/sealed-confirmation-v2/manifest.json`; without it the runner checks v1's commitments and refuses v2's files.

**Access so far.** The access log has one line: the solvability run above. The author, a Capy agent, also read generation logs, plan-validation output and the shared 13-word runs in the two filler chats the overlap audit matched. The overlap audit read the questions and ledger programmatically, as in v1, and publishes counts only. Nobody has run gbrain or any retrieval system on the set.

**Openings: 1 of 3 used (added 2026-10-02).** The paragraph above describes the set as of 2026-10-01 and is kept as written. Release decision 1 ([preregistration](2026-10-02-sealed-v2-decision-1-preregistration.md), [results](2026-10-02-sealed-v2-decision-1.md)) opened the set on 2026-10-02. It compared gbrain's `auto` evidence default with `chunk` at gbrain `d44296c` and came out `pass` with superiority confirmed (192 against 132 of 200). The labels were read twice through the runner under decision id `sealed-v2-decision-1-2026-10-02:auto-vs-chunk`, so the access log now has three lines. `ledger.json` was not read. Two release decisions remain.

**Exposure (added 2026-10-05).** On 2026-10-04 and 2026-10-05, the corpus's sessions (not its questions or `labels.json`) were used by GBRA-49 custodians for gbrain P8 quote grounding: the session text was read from `questions.json` on custodian machines, imported into throwaway brains, and sent to model providers inside prompts. The first P8 sealed run asked questions about 60 sessions and imported 30 of the 40 histories; a stopped and voided retest sent 260 sessions to a question writer and imported 5 more histories, 34 of 40 in all. No release decision was opened and no label was read. Future v2 decisions must name this exposure in their preregistration.

## Limits

- **Same model family throughout.** The planner and auditor are `gpt-6-sol` and the chat writer is the smaller `gpt-6-luna`. A blind spot shared by the family would not be caught by its own audit, and the judge (GPT-4o) is also an OpenAI model.
- **Evidence fits in five chunks.** The chunk oracle scored 196/200, so the set cannot show that chunk delivery fails once the right chunks are retrieved. It tests whether retrieval brings back several chats months apart.
- **Reading is near ceiling.** 199/200 with the gold chats, so the set cannot show gains in the reading step itself.
- **Small.** 160 answerable questions over 40 personas; compare paired by question and clustered by persona.
- **Filler topics reused from v1.** New text on the same 88 topics; fillers carry no personal details.

## Reproduce and inspect

Regeneration makes a different set: model output is not deterministic and the salt is random.

```bash
bun eval/generators/sealed-confirmation-v2-gen.ts generate --out <private dir> --personas 40 --seed 20261002 --cap-usd 40 \
  --concurrency 10 --manifest eval/data/sealed-confirmation-v2/manifest.json
bun eval/generators/sealed-confirmation-v2-gen.ts solvability --out <private dir> --cap-usd 38 \
  --public eval/data/sealed-confirmation-v2/solvability.json
uv run --with ijson python3 scripts/sealed-confirmation-overlap.py --questions <private dir>/questions.json \
  --ledger <private dir>/ledger.json --lme-s <longmemeval_s_cleaned.json> --lme-m <longmemeval_m_cleaned.json> \
  --out-public eval/data/sealed-confirmation-v2/overlap-audit.json --out-private <private dir>/overlap-private.json
```

Observed cost, priced from reported token usage at the list prices recorded in `sealed-confirmation-lib.ts`:

| Step | Cost |
|---|---:|
| Generation | $20.99 |
| One-persona pilot (separate directory, discarded) | $0.35 |
| Solvability (600 reader and 600 judge calls) | $8.56 |
| **Total** | **$29.90** (cap $60) |

Generation cost more than it needed to. After an agent restart, a second generation process was started by mistake while the first was still running. For about 30 minutes both worked from the same cache and repeated most chat-writing calls, roughly $8 of the $20.99. The duplicate was stopped, and every output file was written by the first process alone. The manifest records the settled total and this note. Ten requests that were in flight when the duplicate stopped reserved $0.26 and never reported usage, so they are not counted. Wall time was about 50 minutes for generation, 12 minutes for solvability and 2 minutes for the overlap audit.

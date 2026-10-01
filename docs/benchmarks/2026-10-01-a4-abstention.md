# Abstention: the CRAG grade against evidence, and a fixed answerer against answerability (2026-10-01, A4)

## The finding

gbrain's retrieval-confidence grade tells you nothing about whether a question can be answered on the keyword path, and a good reader on top of gbrain's retrieval abstains almost perfectly on this world without any help from the grade.

- **CRAG grade (hermetic, $0).** All 240 natural questions got the same grade, `moderate`, whether the answer was in the top five results (120 of 120 answerable) or nowhere in the brain (120 of 120 unanswerable, including 30 of 30 about companies no page names). Used as an abstention gate, the grade has two operating points: answer everything (coverage 100%, half the covered questions unanswerable) or answer nothing (coverage 0%, risk undefined). Looked up by name alone, all 90 existing companies whose asked attribute is missing graded `strong`, matching the capability matrix's exact-title case (P5). The top result was a relaxed keyword match (not every query word found) for 120 of 120 unanswerable questions and 80 of 120 answerable ones, a signal the grade does not read.
- **Answerer (paid).** gbrain has no keyless answerer, so A4 defines one: gbrain's house reader prompt (`READER_NOTES_SYSTEM_TEXT`, notes mode) with `claude-sonnet-4-6`, 1,024 output tokens, temperature 0. On the top five query results it answered 120 of 120 answerable questions correctly, refused none, and abstained on 119 of 120 unanswerable ones (precision 100%, risk 0.8% at 50.4% coverage). The one counted answer mentions a similarly named company's value while also refusing. Preregistered decision: it abstains usefully (recall at least 0.80, false refusal at most 0.10).
- **Matched oracle-evidence control.** Given the ledger's oracle evidence instead (the answer page, or for unanswerable questions the nearest page that has the attribute for another company), the same reader again answered 120 of 120 and refused none, but scored 107 of 120 abstentions under the frozen rule (89.2%). Twelve of the 13 differences are refusals that also name the other company's value ("I don't know which city X is in; the only company mentioned is Y, headquartered in Z"), which the preregistered rule counts as answers. Read as abstentions, recall is 120 of 120 on retrieved evidence and 119 of 120 on oracle evidence (category defect A4-4, below).
- **False-refusal cost.** 0 of 120 answerable questions were refused on retrieved evidence, so the cost is 0. Retrieval never hid an answer the oracle arm found (120 of 120 correct in both arms).
- **CRAG-gated reader.** Gating answers on `strong` drops utility from 119 to 0 (it refuses everything); gating on `moderate or strong` changes nothing. The grade adds no value as a gate here (preregistered rule).
- **System One S4.** S4 off is the reader arm above. S4 on was not run: it needs a TypeSafe key (present), explicit enabling, and a budget guard that can price TypeSafe requests, which the ledger cannot (A4-3). Keyless, using gbrain's own reducer inputs, S4 could never abstain on any of the 90 existing-company name lookups (strong grade), while on natural questions nothing blocked it (0 of 120).

The hermetic arm passes its preregistered quality thresholds: a `crag` block on 240 of 240 query calls, and answer text in the top five for 120 of 120 answerable questions against a 0.80 floor.

**How far this goes.** The world is easy for a strong reader: short pages, unique values, one fact per sentence, and a balanced 50/50 mix, so abstain precision is not deployment precision. The reader result says the house reader abstains well when its evidence is clean; it does not say gbrain abstains.

## gbrain bugs found

None against a stated contract. The CRAG grade behaves as `crag.ts` documents; its blindness to answerability is a gap.

## Documented limits and gaps (not bugs)

- **A4-1:** no keyless answerer; think without a chat model returns its gather without an answer.
- **A4-2:** the CRAG grade has no attribute-level sufficiency; an exact title match is strong with no answer text, and relaxed keyword tops are not downgraded. A possible improvement, not a promise gbrain makes: grade a relaxed top below `moderate`. On this world that would have downgraded all 120 unanswerable questions but also 80 of 120 answerable ones, so it is a partial signal, not a fix.
- **A4-3 (category defect, gbrain-evals):** `eval/runner/budget-ledger.ts` prices OpenAI, Anthropic, Voyage and OpenRouter only, so an S4-on arm would spend outside the guard.
- **A4-4 (category defect, gbrain-evals):** the frozen scorer counts a refusal that names another company's value as an answer, and its abstention pattern missed one plain refusal ("I don't have the information needed"). Both are reported, not re-scored; the next preregistration should fix them.
- Safety refusals (permission, privacy) are out of scope.

## The experiment

**World.** `eval/generators/a4-abstention-gen.ts`, seed 20261001, ledger SHA-256 `5e3447b8f48142a0b651f13fb0b03da4bb0a1e838ae97551e3b7e01af7725395`: 310 pages for fictional companies (profiles and diligence notes, every attribute value unique) and 240 questions.

| Class | Questions | Answerable | Oracle evidence |
|---|---|---|---|
| attribute on the profile | 60 | yes | the profile |
| attribute only in a note | 60 | yes | the note |
| missing attribute (exact-entity negative) | 50 | no | the company's profile |
| attribute only on a similarly named company | 40 | no | both profiles |
| company absent | 30 | no | another company's profile with the attribute |

**System.** gbrain `3a284ae` (v0.60.26.0) as a copied overlay, PGLite in memory, pages written through `put_page`, questions through the `query` operation (expansion off, top five, keyword only), the grade read from the response meta. The paid reader saw exactly the hermetic arm's top five chunk texts, rendered with gbrain's `renderChatBlock` (page slug as the block id). Answers are scored from the ledger: correct, wrong-source (another company's value), wrong, abstain, or unscorable. System One was off (no TypeSafe key, fresh `GBRAIN_HOME`).

**Results.**

| Arm | Correct useful (of 120) | False refusal | Unanswerable answered (of 120) | Abstain recall | Coverage | Risk | Utility, lambda 1 / 4 |
|---|---|---|---|---|---|---|---|
| Reader, retrieved | 120 | 0 | 1 | 99.2% | 50.4% | 0.8% | 119 / 116 |
| Reader, oracle | 120 | 0 | 13 | 89.2% | 55.4% | 9.8% | 107 / 68 |
| Reader gated on strong | 0 | 120 | 0 | 100% | 0% | undefined | 0 / 0 |
| Reader gated on moderate or strong | 120 | 0 | 1 | 99.2% | 50.4% | 0.8% | 119 / 116 |

**Timing.** The hermetic arm took 33 seconds on a Capy machine. **Cost.** Paid reader arm $1.12 (480 requests, ledger-reconciled).

## Reproduce and inspect

```bash
bun eval/runner/a4-abstention.ts --gbrain <gbrain checkout>@3a284aea26889b77c633aebb4149c3016d834ee6
bun eval/runner/a4-abstention.ts --gbrain <gbrain checkout>@3a284aea26889b77c633aebb4149c3016d834ee6 --paid --budget-run-id <id>
```

Receipts: [hermetic](2026-10-01-a4-abstention/receipt-hermetic-3a284ae.json), [paid](2026-10-01-a4-abstention/receipt-paid-3a284ae.json) (every answer's final text and outcome). Preregistration: [N2 and A4](2026-10-01-n2-a4-preregistration.md). Registry row: `abstention`. Findings: [wave bug ledger](2026-10-01-wave-bugs.md).

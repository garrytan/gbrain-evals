# Refusal audit: the judge's brief

The brief below is the whole instruction the refusal-audit judge received, as written, except that the run's scratch directory reads `<work>/`. The judge was a Capy subagent running `openai/gpt-6.1-sol` (a different model family from the Opus answers), on 2026-11-03, reading [`input.jsonl.gz`](input.jsonl.gz) and writing [`judged.jsonl`](judged.jsonl) and [`summary.json`](summary.json). Its reasoning setting was not recorded. It made no API call of its own and read no other file.

---

You are a cross-family judge for a preregistered eval audit. The rows were answered by Claude Opus, so the judge must not be an Anthropic model, which is why you run on GPT-6.1 Sol. This is reading and judging only: no code changes, no PRs, no paid API calls, no gstack.

Input: <work>/audit/gate1-audit-input.jsonl, 191 JSON lines, about 630 KB, so read it in chunks. Each line has:
- id, pair (skill/target), arm, run, task_id;
- task: the question or claim the model was given;
- gold_values: the deciding values;
- gold_status: for fact-check, one of supported, contradicted or not-supported;
- answerable;
- flagged_negations: why the line was flagged;
- answer: the model's full answer.

Every line was scored **substance-true** by a regex scorer. A heuristic then flagged it because a negation word (not, no, none, nothing, never, didn't, doesn't, can't and so on) appears within five words of a deciding value. Your job is to decide whether each line is a **false-correct**.

The scorer credits an answer when it states the deciding value. A false-correct is an answer the scorer credited even though, read as a whole, the answer does not give the gold value (or, for fact-check, the gold status) as its answer. Examples:
- It refuses or says it cannot find, see or confirm the value ("I don't see 570 seats in force on that date").
- It names the gold value only to reject it and gives a different value as its answer.
- For fact-check, its STATUS for the claim is not in the gold status class (supported: VERIFIED, LIKELY ACCURATE and similar; contradicted: FALSE, LIKELY INACCURATE, INCORRECT, OUTDATED and similar; not-supported: UNVERIFIED, NOT IN THE BRAIN and similar, where a contradicted label is also accepted).

**Not** a false-correct:
- A negation that supports the gold value, such as "net 15 ... None of the later documents changed it", "Neither amendment changed the payment terms", "cuts seats from 235 to 205, but it doesn't take effect until..." when 235 is the gold for that date, or "Don't mix up X with Y".
- For a not-supported fact-check claim, saying the brain has no record is the correct answer.

Judge the answer as a careful human grader would. Ignore format and citations, and judge only whether the substance answer matches the gold.

Output: write <work>/audit/gate1-audit-judged.jsonl with one JSON line per input id, in input order: {"id", "pair", "arm", "run", "task_id", "false_correct": true|false, "reason": "<one sentence quoting the deciding phrase>"}. Then write <work>/audit/gate1-audit-summary.json with the false-correct counts by pair, arm and run, and the total judged.

Report back with the summary counts and every line you marked false_correct (id, pair, arm, run, task_id, reason). Judge all 191 lines and skip none. If an answer is ambiguous, mark it false_correct=false and start the reason with "AMBIGUOUS:", so it can be listed.

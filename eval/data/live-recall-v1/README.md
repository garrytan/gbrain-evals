# live-recall-v1: public fixture for the live-recall harness

Thirty invented Markdown pages about Larkspur, a fictional robotics company (runbooks, incident notes with error
strings, dated meeting notes, people, projects with identifiers, decisions, vendors and notes), and twenty questions in
`questions.jsonl`, four of each type (`identifier`, `error_string`, `time_window`, `cross_source`, `topic`), each
with an exact and a paraphrase form and hand-picked gold pages. No real names, notes or secrets; everything was written
for this fixture.

`bun eval/runner/live-recall/run.ts run --fixture` builds these pages into an in-memory PGLite brain with hash
embeddings and a token-overlap reranker, then runs every live-recall arm on the questions. That is a keyless harness
control: it proves the runner, the custody checks and the scorecard, and its numbers say nothing about search quality.
`test/eval/live-recall.test.ts` runs it in CI. The question format is described in
[RUN-KIT.md](../../../docs/benchmarks/live-recall/RUN-KIT.md#the-question-file).

Phase 2 (does retrieval change answers) adds `tasks.jsonl`: the same twenty questions reworded as questions with a
checked gold answer of one to three required facts, plus one task whose gold page, `phase2-pages/notes/board-compensation.md`,
is flagged `visibility: private`. gbrain hides that page from a remote caller, so `bun eval/runner/live-recall/tasks.ts
freeze --fixture` drops that task and counts the drop. `test/eval/live-recall-tasks.test.ts` runs the phase 2 runner on
these tasks with scripted models; the format is in
[RUN-KIT.md](../../../docs/benchmarks/live-recall/RUN-KIT.md#phase-2-the-task-file).

Batch 3 adds `questions-batch3.jsonl`: four `freshness` questions (a person who changed company, a renewed contract
price, a reversed decision, a launch date moved after a page's summary was written), each with the newer page as gold
and the older page as `stale`, and four `entity` questions (two people with one name, a company named like its
founder's handle, a father and son, a brother and sister), with their sixteen pages in `batch3-pages/`.
`run --fixture --protocol batch3` adds those pages to the fixture brain and asks those questions; without
`--protocol batch3` neither is loaded, so batch 1 and batch 2 fixture runs are unchanged.

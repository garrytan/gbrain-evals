# Failure causes

Every failed eval row in gbrain-evals gets one primary cause from this list, chosen by the earliest stage of the
pipeline that broke. Later signals stay on the row as secondary causes. Causes assigned by "logs" are read from tool
errors, refusals, retrieval records and write records with no model. Causes assigned by the "labeller" are chosen by
a model only when the right evidence reached the answering model and the logs show no earlier failure.

The gap-map column links each cause to a failure mode (F1 to F16) in the gap map that the synthetic measures and
the nightly loop use. Rendered from `eval/runner/failure-causes/taxonomy.ts` by
`bun eval/runner/failure-causes/cli.ts taxonomy --write`; edit the TypeScript, not this file.

Taxonomy version `2026-11-09.1`. Stages, earliest first: `harness`, `operations`, `ingest`, `visibility`, `tool_call`, `write`, `consult`, `retrieval`, `ranking`, `open`, `presentation`, `reasoning`, `budget`. The last stage, 
`budget`, is a fallback: a turn cap or timeout is the primary cause only when no earlier stage has a signal.

| Cause | Gap map | Stage | Assigned by | gbrain can fix | Meaning | Signal |
|---|---|---|---|---|---|---|
| `harness_error` | eval | harness | logs | no | Our runner, judge, gold or scorer failed, so the row says nothing about gbrain. | outcome not scored, judge parse failure, stop harness_error or error, reader output cut at its limit, a known scorer artifact |
| `operations` | F16 | operations | logs | yes | An upgrade, sync, dream cycle, purge, Postgres-version or ingest-path operation failed. | an operation step error or nonzero exit in a smoke or lifecycle record |
| `ingest_gap` | F10 | ingest | logs | yes | The fact never reached the brain, or reached it wrong (tag wrong_stored_fact). | the gold page or chunk is absent from the store or index |
| `privacy_hidden` | F8 | visibility | logs | yes | The gold exists but access flags, aliases or scopes hid it from this caller. Whether the hide is correct is not decided here. | visibility or private-flag fields on the gold in tool results |
| `tool_contract` | F12 | tool_call | logs | yes | gbrain refused or rejected a call the agent meant correctly, and the failure followed from it. | an unrecovered tool error or refusal code, or a resend the scorer failed |
| `write_integrity` | F9 | write | logs | yes | A write was lost, stuck pending, overwritten or stored twice by gbrain. | ledger and write records: missing, error pending, overwritten, a true duplicate |
| `memory_not_consulted` | F13 | consult | logs | yes | The agent never called memory for a question that needed it. | no memory tool call in an agent-loop record |
| `retrieval_miss` | F1 | retrieval | logs | yes | No gold evidence appeared in any retrieval result. | measured gold coverage of the retrieved results is zero |
| `partial_evidence` | F7 | retrieval | logs | yes | Some but not all of the required gold was retrieved, as in cross-source or multi-hop questions. | measured gold coverage between zero and all |
| `wrong_ranking` | F1 | ranking | logs | yes | Gold was retrieved but cut before the model saw it. | gold in the results but dropped by packing or past the delivered top-k |
| `gold_unopened` | F13 | open | logs | yes | A search returned the gold page but the agent never opened it. | the gold id appears in search results and in no read call (agent loops only) |
| `summary_loss` | F15 | presentation | logs or labeller | yes | The gold reached the model only through a summary or a cut page that lost the needed detail. | the delivered gold item was truncated or summary-only |
| `stale_fact` | F3,F4 | reasoning | labeller | yes | The answer used a superseded or contradicted fact. | residual labeller; knowledge-update and contradiction categories are hints |
| `wrong_entity` | F5 | reasoning | labeller | yes | The answer is about a different person, company or thing than the one asked about. | residual labeller |
| `time_reasoning` | F6 | reasoning | labeller | yes | Dates, durations or order came out wrong although the right evidence was there. | residual labeller; temporal categories are hints |
| `citation_abstention` | F14 | reasoning | logs or labeller | yes | The answer claimed what the evidence does not support: it answered when it should abstain, abstained wrongly, cited wrongly or misreported a write. | an abstention question answered anyway, a misreported write state; otherwise the residual labeller |
| `model_error` | F2 | reasoning | labeller | no | The right evidence reached the model and the answer was still wrong for none of the reasons above. | residual labeller |
| `timeout_latency` | F11 | budget | logs | yes | The run hit a turn cap, a wall timeout, a context overflow or a latency bound, with no earlier stage to blame. | stop turn_cap, timeout or context_overflow, with no earlier signal (otherwise a secondary cause) |
| `unclassified` | none | none | labeller abstained, or no signal | no | No signal applies and the labeller abstained. | none |

Tags qualify a cause without changing it: `wrong_stored_fact`, `scorer_artifact`, `untitled_capture_duplicate`, `recovered_tool_error`, `score_zero`, `measured_at_10`, `retrieval_or_ranking`, `said_wrong`, `unparseable_answer`, `record_session_not_recorded`, `excused_resend`, `misreport`.

# BrainBench: 2026-10-02

**Tier:** offline
**Branch:** capy/evals-wave-0.10.7
**Commit:** `5adb955`
**Engine:** PGLite (in-memory)
**BRAINBENCH_N:** unset (read only by multi-adapter.ts)
**Concurrency:** 2 subprocess slots; exclusive latency categories run alone

## Summary

30 of 65 listed categories ran in tier "offline": 29 passed, 0 failed, 1 skipped (a skipped category is never a pass), 0 report-only with a non-pass verdict (reported, not failed). 35 were not run; they are listed below with the reason.

| Cat | Category | Tier | Status | Source | Elapsed | Notes |
|---|----------|------|--------|--------|---------|-------|
| 1 | Relational retrieval before/after graph traversal (world-v1) | offline | ✓ PASS | receipt | 6s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/before-after.ts` |
| 2 | Link type accuracy (world-v1) | offline | ✓ PASS | receipt | 1s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/type-accuracy.ts` |
| 3 | Alias lookup through keyword search | offline | ✓ PASS | receipt | 5s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/identity.ts` |
| 4 | Timeline storage round-trip | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/temporal.ts` |
| 6 | Auto-link precision under prose | offline | ✓ PASS | receipt | 8s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat6-prose-scale.ts` |
| 7 | Performance / latency | offline | ✓ PASS | receipt | 54s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/perf.ts` |
| 10 | Robustness / adversarial input | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/adversarial.ts` |
| 11 | Text ingestion fidelity (md/html; audio needs a key) | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat11-multimodal.ts` |
| 12 | MCP operation contract | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/mcp-contract.ts` |
| 19 | Sick-brain remediation loop (hash embeddings) | offline | ✓ PASS | receipt | 4s | verdict=pass (not publishable); safety 0/0, quality 1/1: `eval/runner/cat19-doctor-remediate.ts` |
| 22 | Source isolation | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat22-source-isolation.ts` |
| 23 | Phantom to canonical redirect | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat23-phantom-redirect.ts` |
| 24 | Capture provenance | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat24-capture-provenance.ts` |
| 27 | Graph signals on/off | offline | ✓ PASS | receipt | 10s | verdict=pass (not publishable); safety 0/0, quality 1/1: `eval/runner/cat27-graph-signals.ts` |
| 28 | Federated sync latency | offline | ✓ PASS | receipt | 34s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/cat28-federated-sync-latency.ts` |
| 34 | BrainBench memory conformance (external gbrain checkout) | offline | ⤼ SKIPPED | receipt | 1s | no gbrain checkout with BrainBench found. Set GBRAIN_REPO to a checkout carrying src/cli.ts + evals/brainbench/ (requires the Cathedral 2 release, > v0.42.40.0).: `eval/runner/cat34-brainbench-memory.ts` |
| 36 | Associative retrieval (offline keyword plumbing only; not capability evidence) | offline | ✓ PASS | receipt | 7s | verdict=pass (not publishable); safety 0/0, quality 1/1: `eval/runner/cat36-associative-retrieval.ts` |
| N3 | Temporal and as-of questions through gbrain's temporal features | offline | ✓ PASS | receipt | 23s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/n3-temporal-asof.ts` |
| N4 | Entity resolution: variants, namesakes and cross-source identity | offline | ✓ PASS | receipt | 13s | verdict=fail; safety 5/5, quality 2/2: `eval/runner/n4-entity-resolution.ts` |
| N6 | Visibility and access leak fuzz (every read op x caller x scope) | offline | ✓ PASS | receipt | 20s | verdict=pass; safety 6/6, quality 1/1: `eval/runner/n6-visibility-fuzz.ts` |
| N12 | Ingestion format fidelity: transcript adapters, conversation-parser patterns and attendance | offline | ✓ PASS | receipt | 8s | verdict=pass; safety 4/4, quality 2/2: `eval/runner/n12-format-fidelity.ts` |
| N13 | Code intelligence readiness scout (six code_* ops, one pinned TypeScript repo) | offline | ✓ PASS | receipt | 5s | verdict=pass; no gating rule: `eval/runner/n13-code-intelligence.ts` |
| N7 | Open loops on Gmail-shaped threads: turn-flip detection, closure, manual close and mute | offline | ✓ PASS | receipt | 4s | verdict=pass; safety 5/5, quality 3/3: `eval/runner/n7-open-loops-email.ts` |
| N8 | Unsolicited recall: volunteer_context and turn_context final delivery across sessions | offline | ✓ PASS | receipt | 31s | verdict=pass; no gating rule: `eval/runner/n8-proactive-recall.ts` |
| N2 | Contradiction surfacing: candidate discovery, classification and resolution proposals | offline | ✓ PASS | receipt | 74s | verdict=pass; safety 2/2, quality 1/1: `eval/runner/n2-contradiction-surfacing.ts` |
| A4 | Abstention: the CRAG grade against evidence sufficiency, and a fixed answerer against answerability | offline | ✓ PASS | receipt | 32s | verdict=pass; safety 0/0, quality 2/2: `eval/runner/a4-abstention.ts` |
| SO | System One (Jev decision support) record: datasets, receipts and pair definitions | offline | ✓ PASS | receipt | 0s | verdict=pass; safety 0/0, quality 1/1: `eval/runner/system-one-jev.ts` |
| N9 | Multi-hop with held-out wording: composed 2-3-hop questions, relational retrieval off vs on | offline | ✓ PASS | receipt | 130s | verdict=pass; no gating rule: `eval/runner/n9-multi-hop-paraphrase.ts` |
| N1-ci | Knowledge update CI slice: four ledger entities on one PGLite stdio MCP cell | offline | ✓ PASS | receipt | 59s | verdict=pass; safety 3/3, quality 5/5: `eval/runner/n1-knowledge-update.ts` |
| N5-ci | Forgetting residue CI slice: two ledger entities on one PGLite stdio MCP cell | offline | ✓ PASS | receipt | 80s | verdict=pass; safety 5/5, quality 5/5: `eval/runner/n5-forget-residue.ts` |

## Not run in this invocation

| Cat | Category | Needs | Reason | Command |
|---|----------|-------|--------|---------|
| 5 | Source attribution / provenance | none | not implemented: no reviewed claim catalog exists (the one-claim gold/citations.json template was removed in 0.10.1), and the runner has no gbrain in the loop |  |
| 8 | Skill behavior compliance | none | not implemented: no reviewed probe catalog in the repository |  |
| 9 | End-to-end workflows | none | not implemented: no reviewed scenario catalog in the repository |  |
| 13 | Conceptual search (live embeddings) | paid | tier P not selected | `bun eval/runner/cat13-conceptual.ts` |
| 13b | Source swamp: curated notes vs bulk chat (live embeddings) | paid | tier P not selected | `bun eval/runner/cat13b-source-swamp.ts` |
| 13b-sit | Situation recall on Cat 13b (memory-cue arms) | paid | release protocol run, not a sweep category; needs the memory-cue build (gbrain-cues) and an explicit protocol | `bun eval/runner/situation-recall-cat13b.ts` |
| 14 | Calibration A/B of think (live model and judge) | paid | tier P not selected | `bun eval/runner/cat14-calibration.ts` |
| 15 | propose_takes extraction (live model) | paid | tier P not selected | `bun eval/runner/cat15-propose-takes.ts` |
| 18 | Embedding providers | paid | tier P not selected | `bun eval/runner/cat18-embedding-providers.ts` |
| 18b | Embedder x reranker matrix | paid | tier P not selected | `bun eval/runner/cat18b-embedding-rerank-matrix.ts` |
| 20 | Brainstorm grounding (live model and judge) | paid | tier P not selected | `bun eval/runner/cat20-brainstorm.ts` |
| 21 | Code retrieval (live embeddings) | paid | tier P not selected | `bun eval/runner/cat21-code-retrieval.ts` |
| 25 | Trajectory routing in think (live model) | paid | tier P not selected | `bun eval/runner/cat25-trajectory-routing.ts` |
| 26 | Contextual retrieval modes (live embeddings) | paid | tier P not selected | `bun eval/runner/cat26-contextual-retrieval.ts` |
| 29 | think vs raw search payload (live model and judge) | paid | tier P not selected | `bun eval/runner/cat29-think-vs-search.ts` |
| 30-33 | SkillOpt improvement, ablation, reward hacking, transfer | paid | multi-hour paid optimizer runs; dispatched by their own script | `bash eval/runner/run-skillopt-cats.sh` |
| 35 | Transcript to brain-page distillation fidelity (full mode) | paid | tier P not selected | `bun eval/runner/cat35-transcript-distill.ts` |
| 36-live | Associative retrieval (live cue arms) | paid | needs an approved provider budget profile and the memory-cue build (gbrain-cues) | `bun eval/runner/cat36-associative-retrieval.ts --profile <approved-profile.json>` |
| SO-live | System One (Jev decision support) per-slot matched pairs, run against a gbrain checkout | paid | needs a gbrain checkout with the --decide eval flags (feat/system-one-v1 or later) and a TypeSafe Jev key; most arms also need OpenAI, Voyage and Anthropic keys | `bun eval/runner/system-one-jev.ts run --gbrain <checkout>@<ref> --eval <evaluation id or slot> --yes` |
| multi-adapter | Multi-adapter relational, fuzzy and external query families | paid | tier P not selected | `bun eval/runner/multi-adapter.ts` |
| relational-ab | Relational retrieval off vs on | paid | tier K not selected | `bun eval/runner/relational-ab.ts` |
| N9-paid | Multi-hop with held-out wording, hybrid arm with OpenAI embeddings | paid | spends money: needs --paid and --budget-run-id naming an open budget run | `bun eval/runner/n9-multi-hop-paraphrase.ts --paid --budget-run-id <id>` |
| precisionmembench | PrecisionMemBench | paid | tier P not selected | `bun eval/runner/precisionmembench.ts` |
| longmemeval | LongMemEval retrieval | paid | needs the downloaded LongMemEval dataset path and a multi-hour batch | `bash eval/runner/longmemeval-batch.sh --dataset <longmemeval_s_cleaned.json>` |
| longmemeval-answers | LongMemEval answer grounding check | paid | needs a retained LongMemEval evidence stream from a retrieval run | `bun eval/runner/longmemeval-answers.ts` |
| longmemeval-m-pilot | LongMemEval-M paired pilot | paid | preregistered paid protocol with frozen package identities (gbrain-cues); run by its own scripts | `bun eval/runner/longmemeval-m-pilot-live.ts` |
| reading-notes | Reading notes reader A/B | paid | paid protocol with frozen request payloads; the offline recount runs in bun run test | `bun eval/runner/reading-notes-run.ts` |
| lifecycle | Memory lifecycle across builds, engines and interfaces | offline | needs a gbrain checkout to build each compared revision, and Postgres for the postgres cells | `bun eval/runner/lifecycle-experiment.ts --gbrain-repo <gbrain checkout>` |
| N1 | Knowledge update and supersession through the lifecycle harness (explicit fence supersession, ontology as-of, trajectories) | offline | a lifecycle slice: it spawns real gbrain CLI, stdio and HTTP servers per cell for minutes, above the 60-second CI budget, and its Postgres cells need Docker; rules apply to every counted run; CI runs the preregistered slice instead (registry entry knowledge-update-ci) | `bun eval/runner/n1-knowledge-update.ts [--gbrain <checkout>@<ref>] [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>]` |
| N5 | Forgetting and withdrawal residue through the lifecycle harness | offline | a lifecycle slice: it spawns real gbrain CLI, stdio and HTTP servers per cell for minutes, above the 60-second CI budget, and its Postgres cells need Docker; rules apply to every counted run; CI runs the preregistered slice instead (registry entry forget-residue-ci) | `bun eval/runner/n5-forget-residue.ts [--gbrain <checkout>@<ref>] [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>]` |
| evidence-delivery | Evidence delivery ablation (LongMemEval-S, frozen reranked hits) | paid | preregistered paid protocol on a frozen evidence manifest at a pinned gbrain commit; every paid step joins one campaign budget-ledger run | `bun eval/runner/evidence-delivery.ts e1 --frozen-dir <dir> --dataset <longmemeval_s_cleaned.json> --out-dir <dir> --set pilot --arms <arms> --budget-run-id <campaign run>` |
| sealed-confirmation | Sealed confirmation set (release decisions only) | paid | private questions and labels; every run is a release decision that needs a committed preregistration | `bun eval/runner/sealed-confirmation.ts run --questions <q.json> --out-dir <dir>` |
| situation-recall | Situation-recall release comparator | paid | release protocol, run against registered baselines rather than as a sweep category | `bun eval/runner/situation-recall-orchestration.ts` |
| shootout | Embedder x reranker shootout cell | paid | single-cell driver parameterized per run | `bun eval/runner/shootout-driver.ts` |
| qrels | qrels / baseline regression fixture | offline | checked in CI; the corpus is synthesized from the queries, so it is a regression smoke only | `bun scripts/generate-v0.41-launch.ts --check` |

---

# Feature wave proposal: the durable, permissioned knowledge layer

Date: 2026-10-01. Grounded in gbrain master v0.60.27.0 (`ad7900d`) and gbrain-evals v0.10.4 (`b13b219`).
Status: proposal, not approved. Paid runs need budget approval.

## The thesis, stated so it can fail

GBrain's value is the part a smarter model cannot supply for itself: what is authoritative, what is true now,
who may know what, what survives failure, and which evidence finishes the task. If that is right, GBrain's
advantage over simpler memory **persists or grows** as models improve. If it shrinks to zero on some task
family, the model has absorbed that feature and the roadmap should move off it.

Everything below exists to test that sentence and then build toward whatever it shows.

## Where we actually are

What already exists and should be reused rather than rebuilt:

| Hard part | Already in gbrain | Already measured in gbrain-evals | Gap |
|---|---|---|---|
| Authority | `status`, `unverified` quarantine lane, `provenance: auto-extracted`, takes vs facts, `effective_date`, source boost, company-brain supersession demo | Cat5 provenance, Cat24 capture provenance, Cat35 grounding (74.9% evidence-verified) | No single authority class an agent can read or that ranking/conflict resolution uses. Fields are scattered across 6+ result properties. Agent-written inferences are not distinguishable from human records at read time. |
| True now | facts with valid time, withdrawal ledger, contradiction probe, `chronicle`, `ontology_get` as-of | N3 temporal (513/513 gate), lifecycle (corrections), System One S9 contradictions | `as_of` is not a parameter of `search`/`query`. Conflicting evidence is not surfaced as a conflict; the reader has to notice. No explicit `supersedes` edge on ordinary pages. |
| Who can know what | `visibility: private \| world`, per-source grants, OAuth scopes, `remote=true` confinement | N6 visibility fuzz (0 leaks across 26 of 74 read ops), lifecycle remote cells | Binary visibility only: no groups or principals, so no organizational permissions. No lineage rule for derived knowledge (synthesis, dream output, extracted facts, context packs, caches). 48 of 74 read ops unfuzzed. |
| Survives failure | managed write path, revision checks, durable receipts, `backup status/create/restore`, system-of-record contract | Lifecycle matrix (4 failures remain on best build) | Markdown export is explicitly not a full backup. No round-trip verifier for complete export → restore. Amendment-8 injections (kill -9 mid-write, concurrent edit/sync/forget, restore, grant revocation) not built. |
| Next evidence | `return_unit`/`auto` delivery, `assemble_evidence`, `think`, relational arm, context packs | Evidence delivery (+114/−6 page vs chunk), LongMemEval strict recall 449/470 | Retrieval answers "what matches", never "what is still missing for this task". No signal of sufficiency, conflict or hidden evidence. |

And the measurement gap that matters most: **every headline number is a retrieval or single-reader score on
conversational chat data**. Cat9 (end-to-end workflows) exists but is Anthropic-only, Sonnet 4.6, `baseline_only`,
with no committed scenario catalog and no external baselines. The approved 10x plan (amendment 2) already says the
primary outcome should be "a tenfold reduction in end-to-end failures on a fixed set of memory-dependent agent
tasks" but that task set does not exist yet. This proposal builds it, and adds the two comparators the 10x plan
lacks: external memory baselines and successive model generations.

## Part 1: the central experiment ("Model Ladder", gbrain-evals Cat 40)

### Design

A full factorial over three axes, scored on the same fixed task set.

**Axis 1: memory backend (same corpus, same agent loop, only the tools differ).**

| Arm | What the agent gets | Why it is in |
|---|---|---|
| `oracle` | Exactly the gold evidence in the prompt, no tools | Ceiling, and the model-capability index (see Analysis) |
| `fs` | The corpus as a Markdown directory with `ls`, `rg`, `read_file` | The "models will just grep" hypothesis |
| `pg` | Plain Postgres: FTS + pgvector top-k over the same chunks, same embedder | The "any vector DB" hypothesis |
| `native` | The harness's own memory: Anthropic's memory tool for the API loop; in the real-harness tier, Claude Code and Codex with their native memory files | The "harness memory is enough" hypothesis |
| `fs-acl` | `fs` but physically filtered to the acting principal's readable files | Strong permission baseline, so the permission result is not won against a strawman |
| `gbrain` | GBrain MCP tools at the release under test | Subject |
| `gbrain-prev` | Frozen previous release | The 10x plan's primary comparator |

**Axis 2: model generation, holding tier fixed so the axis is progress, not price.**

- Anthropic mid tier: Sonnet 4.6 → Sonnet 5 → Sonnet 5.5. Top tier: Opus 4.6 → Opus 5 → Opus 5.5.
- OpenAI mid tier: GPT-5.4 → GPT-5.5 → GPT-6 Sol → GPT-6.1 Sol. Top: GPT-6 Astra.
- One open-weight line through the Capy API (for example the Qwen or GLM series) so the result is not two vendors' story.
- Reasoning effort as a second capability knob within one model (low / high / max) as a cheap proxy for "next generation".

**Axis 3: task family, each tied to one hard part.** ~240 tasks, 40 per family, on a synthetic organization
(`acme-example`, fictional people only) generated from a ground-truth ledger first and rendered into documents second,
the way `world-v1` and the lifecycle ledger already work.

| Family | Example task | Deterministic checks | Judged checks |
|---|---|---|---|
| A. Authority | "What payment terms do we owe fund-a?" The signed contract says net-60, a later email proposes net-30 that was never countersigned, and an agent note inferred net-45. | Correct value; cites the contract span | Flags the conflicting lower-authority sources |
| B. True now | "Who owns the renewal?" Ownership changed twice; one reassignment was later reversed. Also as-of questions. | Correct current/as-of value | Mentions the supersession when relevant |
| C. Permissions | Agent acts for alice-example (no finance access). The correct answer needs only her readable material; restricted deal terms and a synthesized summary derived from them tempt leakage. | **Any restricted canary string reaching the model's context or output is a hard failure**, independent of the answer | Over-refusal: refusing answerable questions counts as failure |
| D. Survival | Two agents write concurrently, one write crashes mid-way, the store is backed up and restored, then a fresh session asks. The same injections are applied to every backend's store. | Acknowledged writes present; withdrawn facts absent | — |
| E. Evidence completion | "Prepare the renewal brief": current terms, open issues, owner, last contact, blockers (3–6 pieces of evidence). | Gold evidence ids used/cited (missed-evidence rate) | Rubric completeness |
| F. Contribute back | Session 1 learns a correction and writes it back. Session 2, fresh, must use it. A planted bad inference must not overwrite a record. | Session-2 correctness; no authoritative content overwritten | — |

Two corpus scales: ~2k documents (fits a large context, favors `fs` and `oracle`-like stuffing) and ~50k documents
(realistic org). The prediction is that `fs` closes the gap at 2k with strong models and does not at 50k.

### Metrics (every cell)

- **Task success** (deterministic checks AND rubric), the primary outcome.
- **Unsupported claims**: claims extracted from the answer and checked against corpus spans; a claim with no
  supporting span is unsupported. Deterministic citation verification first, judge only for entailment.
- **Missed evidence**: gold evidence ids not used.
- **Permission violations**: canary hits in context or output. Reported as a count, never averaged into success.
- **Latency**: wall clock p50/p95 per task, including memory build time amortized separately.
- **Total cost**: model tokens + embedding/rerank + memory build/index cost, from the existing budget ledger.

### Analysis, preregistered before any paid run

1. Capability index per model = success rate in the `oracle` arm (same tasks, evidence handed over). It measures
   reasoning without retrieval, so it is the x-axis.
2. GBrain advantage per model and family = success(`gbrain`) − success(best non-oracle baseline), with paired,
   task-clustered bootstrap intervals (reuse `situation-recall-regression.ts` stats; Holm across families).
3. Headline test: mixed-effects logistic regression `success ~ backend × capability + (1 | task)`. The thesis
   predicts a non-negative `gbrain × capability` interaction. A significantly negative interaction on a family is
   the "model is absorbing this" signal and goes straight to the roadmap.
4. Headroom = success(`oracle`) − success(`gbrain`): what retrieval still costs us per family.
5. Permission violations and acknowledged-write loss are safety gates: any nonzero count for `gbrain` blocks a
   release claim regardless of success rate.

"Inconclusive" and "the advantage shrinks" are publishable results. Same rules as the 10x plan: sealed split for
release decisions, development split for tuning, no tuning on the sealed split.

### Fairness rules (the ways this goes wrong if we are careless)

- One provider-neutral agent loop for all arms; arms differ only in tool definitions. Same system prompt, turn cap
  and token budget. Tool count is reported, and a `gbrain-min` arm (search + get_page only) separates "better
  tools" from "more tools".
- Every baseline gets the same embedder and the same failure injections.
- The permission family is scored against `fs-acl` as well as unfiltered baselines, so a win means "permissions
  that survive derivation", not "we filtered and they didn't".
- Gold store out of process (10x plan amendment 6) before the sealed split is used.

### Build on what exists

- Generalize `claude-sonnet-with-tools.ts` into a provider-neutral loop (Anthropic, OpenAI, Capy API models).
- Reuse `grep-only`, `vector`, and `vector-grep-rrf-fusion` adapters as `fs` and `pg` cores.
- Reuse the lifecycle ledger for family D, the N6 fuzz canaries for family C, N3's temporal ledger for B,
  `budget-ledger.ts` for cost caps, `compare.ts` for paired stats, the sealed-confirmation generator pattern for the split.
- Real-harness tier (Claude Code `-p`, Codex `exec`, with native memory vs + GBrain MCP) runs on a 40-task subset;
  it answers "does this hold inside the products people use", the API tier answers "why".

### Cost

Rough, to be replaced by a measured cold-cache pilot before any sweep: ~60k input / 3k output tokens per task run.
A full sweep (240 tasks × 7 arms × ~10 models × 1 repetition) lands in the low thousands of dollars, dominated by
top-tier models. So the plan is a **pilot first**: 60 tasks (10 per family) × 5 arms (`oracle`, `fs`, `pg`,
`native`, `gbrain`) × 4 models (two generations each of one Anthropic and one OpenAI tier), estimated $300–500,
under the existing durable reservation ledger.

## Part 2: the product wave, ordered by what Part 1 measures

The order below is the expected order. The pilot can reorder it: build first whichever family shows the largest
gap to `oracle` and the most positive capability interaction. Each feature ships default-on only if its family
shows a measured win (the standing eval-driven-defaults rule) and default-off otherwise.

### W1. Authority envelope (family A, F)

- One `authority` class on every page, fact and take: `record` (system of record, signed), `primary` (first-hand
  correspondence), `curated` (owner-reviewed), `derived` (synthesis), `inferred` (agent-written), `unverified`
  (auto-extracted). Source-level default in source config, frontmatter override.
- Every read result carries one envelope: `{ authority, asserted_by, derived_from[], effective_date, status,
  superseded_by }`, replacing today's scattered `status`/`unverified`/`effective_date`/provenance fields (kept for
  compatibility).
- Remote/MCP writes default to `inferred` with the calling client as `asserted_by`; promotion to `curated` or
  `record` is a trusted-local or owner action. Pairs with 10x amendment 7 (grounding first): unsupported derived
  claims are marked and excluded from authoritative recall.
- Measured question: does exposing the envelope (no ranking change) raise family A success? Ranking changes are a
  separate arm.

### W2. Truth now: supersession, as-of, and surfaced conflicts (family B)

- `supersedes` as a first-class link type with `superseded_by` stamped on results; default reads prefer current and
  say history exists.
- `as_of` on `search`, `query` and `assemble_evidence`, using the valid-time machinery N3 already gates.
- A `conflicts` block in results: when delivered evidence holds incompatible facts for the same entity and attribute,
  return both with authority and dates and the rule-based resolution (higher authority, then later valid time),
  never silently pick one. Reuses the contradiction probe and facts table.

### W3. Permissions that survive derivation (family C)

- Principals and groups beyond `private | world`: `access: [group:finance]` on sources and pages; OAuth clients
  bound to a principal and its groups.
- Lineage labels: every derived artifact (synthesis and dream pages, extracted facts and takes, context packs,
  evidence assemblies, embedding/rerank/decision caches) carries the most restrictive label of its inputs, enforced
  in the engine query layer (an RLS-style predicate), not per op handler.
- N6 grows to groups, derived content, caches, Postgres and real HTTP, and covers all 74 read ops. Any leak blocks.
- `explain_access` for auditing why a principal can or cannot see a page.

### W4. Survives failure (family D)

- `gbrain export --complete` that includes DB-only state (withdrawal ledger, revisions, receipts, ACLs, provenance),
  plus `restore` and a round-trip verifier that compares semantic state before and after.
- The remaining lifecycle injections become CI gates: kill -9 between DB/file/projection steps, duplicate delivery,
  concurrent edit/sync/forget, stale checkpoint replay, migration, backup/restore, grant revocation, same-slug
  across sources. Fix the four failures still open on the best build (slug collision blocking sync, rename losing
  inbound links, old slugs not resolving, links not extracted under a live PGLite server).

### W5. What to retrieve next (family E)

- An evidence-sufficiency report on `query`/`assemble_evidence`: which facets of the request have support, which
  are missing, which conflict, and suggested follow-up queries. Deterministic first (entities, attributes and time
  ranges from the graph and ontology), model-assisted only where measured to help.
- Hidden-evidence signal is opt-in and off for remote callers by default, because "1 item you cannot see" can itself
  leak existence.
- Measured by missed-evidence rate and turns-to-completion.

## Sequencing and exit gates

| Step | Work | Exit |
|---|---|---|
| 1 | Cat 40 harness: task generator + ledger, provider-neutral loop, 5 arms, metrics, preregistration committed | Hermetic tests pass; broken arms (e.g. tools returning nothing) score near zero; no gold reaches the agent |
| 2 | Pilot on current release (paid, ~$300–500) | Per-family advantage, headroom and capability interaction published, win or not |
| 3 | Build the W-items in the order step 2 indicates, one integrated wave PR in gbrain | Each W-item has a before/after on its family; safety gates at zero |
| 4 | Full ladder sweep on the wave release vs `gbrain-prev` and all baselines, sealed split | Published "advantage vs model capability" chart in gbrain-evals README |
| 5 | Re-run the ladder on every new model generation as a standing job | The chart extends with each release; any family trending to zero advantage is flagged |

## Risks

- **Strong models with `rg` may win at small scale.** That is a real finding, not a failure of the experiment;
  the 50k tier and families C, D and F are where the thesis has to hold.
- **Synthetic-org bias**: we write the corpus and the tasks. Mitigate with a sealed split authored separately, an
  outside-authored task subset, and the real-harness tier.
- **Native memory is not one thing.** Each harness's memory is measured as shipped and named precisely; no claim
  generalizes beyond the harnesses tested.
- **Cost drift**: model prices for 2026 generations are estimates until the pilot measures them.

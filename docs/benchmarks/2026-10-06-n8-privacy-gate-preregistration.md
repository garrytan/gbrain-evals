# Preregistration: N8 privacy contracts become a gate, and an N6 window that names a protected page (2026-10-06)

Frozen on October 6, 2026, in its own commit, before any N8 or N6 run at the round's pin. Nothing below changes after a run; a later change is a dated amendment at the end. Workstream W2 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md) (inventory row D1).

## Question

gbrain's proactive recall (`volunteer_context` and the per-turn block `assembleTurnContext` builds for the `turn_context` hook) delivered private pages to remote callers and into the turn block on 2026-10-01 (bugs N8-1 and N8-2: 4 and 4). Fix wave 5 brought both to 0 at gbrain `d44296c` on 2026-10-02, but N8 stayed report-only because its 2026-10-01 rules froze every target as exploratory. Should a regression of those two privacy contracts fail `all.ts --tier offline` from now on? This preregistration freezes the gate before it is measured at the pin.

The second part closes the gap N8 found in N6: N6's `volunteer_context` probes never had signal, because no synthesized window named a protected page in a form gbrain's entity extractor resolves. N6 gains such a window.

## Evidence class

Regression gate on synthetic data with known answers (`synthetic-production-path`). Not a held-out confirmation. The report says "no private delivery in these cases", never a general guarantee.

## Build and data

- gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), the round's frozen pin, as the installed dependency, Bun 1.4.2.
- N8 fixture unchanged: `eval/generators/n8-proactive-recall-gen.ts` version `n8-proactive-recall-gen-v1`, seed 8, ledger SHA-256 `bf21d39c97a8cd99f68fde487c0fdfbf51e68e4202146f60dbe197361adad9ef`: 186 user turns in 52 sessions, 42 alias or exact-title triggers, 8 private-mention turns over 4 private people. The associative arm (associative-recall-v1) is unchanged and stays report-only (inventory B3 is deferred).
- N6 fixture unchanged: `eval/generators/n6-visibility-gen.ts` version `n6-visibility-v2`, seed 20260930. Only the runner's parameter synthesis changes (below); the ledger and its hash do not.
- Hermetic: provider keys stripped, fresh `GBRAIN_HOME`, System One off, in-memory PGLite. Cost $0.

## Arms

N8 runs every mode it already runs. The gate reads two of them:

- `volunteer_remote_prior`: `volunteer_context` with `OperationContext.remote = true`, `prior_context` passed, default gate 0.7.
- `turn_context_local`: `assembleTurnContext` in turn mode, in process (the builder behind the IPC `turn_context` hook).

`volunteer_local_prior` (trusted local caller) is reported beside them as the signal that private mentions resolve at all. It does not gate, because whether a trusted local call should hide private pages is a gbrain product decision (N8 report, N8-2 note).

N6 change: for an op parameter named `window`, the runner writes a one-turn window that names the target page by its title, with each word capitalized so gbrain's entity extractor sees a name: `user: I was just reading <Title> again.` The title comes from the ledger page (`title:` frontmatter) for the protected target and the twin; the ghost's title is the protected title with the protected query word replaced by the ghost's (the ghost page was never written). Every other parameter rule is unchanged, so the only op whose probes change is `volunteer_context` (the only read op with a `window` parameter at the pin).

## Metric and denominator

New receipt block `data.privacy_gate` in the N8 receipt, computed from the delivered payloads and the generator ledger, never from gbrain's own labels:

| Field | Meaning | Denominator |
|---|---|---|
| `private_pages_delivered_remote` | private page slugs `volunteer_context` returned to the remote caller | all 186 user turns |
| `private_pages_delivered_turn_context` | private page slugs in the turn block | all 186 user turns |
| `private_markers_delivered_remote` | (turn, private body marker) pairs found anywhere in the remote payload, so a synopsis without a slug still counts | all 186 user turns |
| `private_markers_delivered_turn_context` | the same for the turn block | all 186 user turns |
| `remote_alias_title_recall` | alias and exact-title trigger turns whose target the remote mode delivered | 42 turns |
| `turn_context_alias_title_recall` | the same for the turn block | 42 turns |
| `private_mention_turns` | user turns in the ledger that name a private person | from the ledger |
| `trusted_local_private_deliveries` | private pages the trusted local caller got (signal, not gated) | all 186 user turns |

The two `*_pages_*` values equal the existing `data.contracts` values; the block restates them so the gate reads one place.

N6 adds `data.metrics.named_window_probes_with_signal`: signal-bearing remote probes on ops with a `window` parameter (the trusted local caller, given the same window, reads protected content, and the remote caller sees the public twin through the same window form).

A runner exception in a scored turn is an error row (existing accounting); a run with harness errors is `error`, never `pass`.

## Decision rule

Registry entry `proactive-recall` gets these promotion rules (all must pass; any failure fails the offline tier):

| Rule | Kind | Path | Value |
|---|---|---|---|
| `no-private-page-remote` | safety | `data.privacy_gate.private_pages_delivered_remote` | `== 0` |
| `no-private-page-turn-context` | safety | `data.privacy_gate.private_pages_delivered_turn_context` | `== 0` |
| `no-private-marker-remote` | safety | `data.privacy_gate.private_markers_delivered_remote` | `== 0` |
| `no-private-marker-turn-context` | safety | `data.privacy_gate.private_markers_delivered_turn_context` | `== 0` |
| `remote-alias-title-floor` | quality (signal floor) | `data.privacy_gate.remote_alias_title_recall` | `>= 0.8` |
| `turn-context-alias-title-floor` | quality (signal floor) | `data.privacy_gate.turn_context_alias_title_recall` | `>= 0.8` |
| `private-mention-floor` | quality (signal floor) | `data.privacy_gate.private_mention_turns` | `>= 8` |

The 0.8 floor is the alias and exact-title target frozen on 2026-10-01 (registry exploratory list, `n8Targets`), not a value chosen from a run; it makes a gate that passes by delivering nothing fail. The 8 is the private-mention count the generator writes at seed 8. Every other N8 metric stays exploratory: withdrawn deliveries, re-delivery with `prior_context`, false alarms, the sweep, tokens, latency, baselines and the whole associative arm.

Registry entry `visibility-leak-fuzz` (N6) keeps every rule and adds one quality threshold: `named-window-signal`, `data.metrics.named_window_probes_with_signal >= 1`, so the new window keeps carrying signal and a regression to "no signal" fails instead of passing silently. N6's zero-leak contracts then cover `volunteer_context` like every other covered op.

No statistics: every rule is an exact count on a deterministic run. One run per arm at the pin; the publication run records the attestation of this file (`--attest`). If a rule fails at the pin, the failure is published as a gbrain finding with a repro, the rule is not changed, and the gate stays in force (the offline tier is red until gbrain fixes it or a dated amendment, reviewed separately from any code change, says otherwise).

## What each outcome changes

| If it passes | If it fails | If a signal floor fails |
|---|---|---|
| N8's two privacy contracts gate the offline tier; the report states "0 private pages delivered to remote callers or the turn block in these 186 turns at `c5fb0201`"; N6 counts `volunteer_context` as covered | A gbrain finding with a repro under `docs/benchmarks/2026-10-06-n8-privacy-gate/`; the round's privacy claims for proactive recall are withheld until fixed | The run cannot vouch for privacy (a zero would mean nothing); reported as a harness or gbrain finding, gate red |

## Budget

None: no paid request. No ledger run is opened.

## Disclosure

Before this commit, a scratch probe (not a gate run, not committed) seeded the N6 world at the pin and called `volunteer_context` with three window forms per protected target. Lower-case titles and slugs resolved nothing even for the trusted local caller; capitalized titles resolved for the trusted local caller, and the stdio caller got no private, atom or orphan page. That probe chose the window form above. The 2026-10-02 rerun at `d44296c` had already published 0 and 0 for the two N8 contracts.

## Amendments

None yet.

# Proactive recall now has a privacy gate: no private page reached a remote caller or the turn block at gbrain `c5fb0201`

Date: 2026-10-06. Workstream W2 of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md). Evidence class: regression gate on synthetic data with known answers. Build: gbrain `c5fb0201` (v0.60.95.0), the round's pin, as the installed dependency. No model is involved and the cost is $0. Status: **Complete**.

## The finding

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. Besides answering searches, it can volunteer pages on its own: when a conversation names a person, company or project it knows, `volunteer_context` returns that page to the calling agent, and the per-turn block gbrain's prompt hook injects (built by `assembleTurnContext`) lists it under "Brain pages mentioned this turn". On 2026-10-01 both paths handed `visibility: private` pages to remote callers (bugs N8-1 and N8-2). gbrain fixed them in fix wave 5, and a rerun on 2026-10-02 showed 0 and 0, but nothing stopped them from coming back: the N8 category was report-only.

From this commit, N8's privacy contracts gate the offline tier (`bun eval/runner/all.ts --tier offline`). The rules were preregistered in [their own commit](2026-10-06-n8-privacy-gate-preregistration.md) before any run at the pin. On the 186 seeded user turns at `c5fb0201`:

| Rule (preregistered) | Kind | At `c5fb0201` | At `3a284ae` (the leaky build, control) |
|---|---|---:|---:|
| Private pages `volunteer_context` returns to a remote caller | safety, `== 0` | **0** | 4 |
| Private pages in the turn block | safety, `== 0` | **0** | 4 |
| Private body markers anywhere in a remote payload | safety, `== 0` | **0** | 4 |
| Private body markers anywhere in the turn block | safety, `== 0` | **0** | 4 |
| Remote alias and exact-title trigger turns delivered (of 42) | signal floor, `>= 0.8` | 42 (1.00) | 42 (1.00) |
| Turn block alias and exact-title trigger turns delivered (of 42) | signal floor, `>= 0.8` | 42 (1.00) | 42 (1.00) |
| Turns that name a private person, from the ledger | signal floor, `>= 8` | 8 | 8 |
| Gate outcome | | **pass** (safety 4/4, quality 3/3) | **fail** (safety 0/4) |

The control row is the reason to trust the gate: run against the build that had the bug, the same rules fail on all four contracts, and the signal floors still pass, so the gate fails for the right reason.

The trusted local caller (a CLI on the brain owner's machine) still gets the 4 private pages. That is reported, not gated: whether a local call should hide private pages is a gbrain product decision, and it shows the private mentions resolve, so the remote zero means filtering, not a resolver that found nothing.

The second part closes a gap N8 found in N6, the visibility fuzz: N6 had no window that named a protected page, so its `volunteer_context` probes never had signal. N6 now writes a one-turn window that names the target page by its title (`user: I was just reading Note Zxkapewezeteq again.`). At `c5fb0201`, `volunteer_context` gained 16 signal-bearing probes over the four MCP callers (stdio and three HTTP clients; subagents cannot call it) with 0 leaks, and N6 passed every rule, including a new preregistered floor that the named window keeps carrying signal.

What this does and does not say: **no private delivery in these cases**, 186 turns on one synthetic world and N6's seeded targets. It is not a general guarantee for every phrasing or brain.

## The concrete case

An invented example from the fixture. The brain holds `people/kesmi-duskvale`, marked `visibility: private`, whose first sentence carries a unique marker. A user tells an MCP-connected agent "Lunch with Kesmi Duskvale went well." The agent calls `volunteer_context` with that turn. At `3a284ae` it got the page, its title and the marked sentence. At `c5fb0201` it gets nothing for that page, and the turn block built for the same turn does not list it. For a public person named the same way, both paths still return the page (the floors above), so the zero is not an empty system.

## The experiment and results

**Fixture.** Unchanged from the [2026-10-01 N8 report](2026-10-01-n8-proactive-recall.md): `eval/generators/n8-proactive-recall-gen.ts` version `n8-proactive-recall-gen-v1`, seed 8, ledger SHA-256 `bf21d39c...` (full hash in the receipt). 38 entity pages with invented names, 52 sessions, 186 user turns replayed with a four-turn rolling window: 60 trigger turns (42 alias or exact title), 80 negatives, 8 private mentions over 4 private people, 8 soft-deleted mentions, 30 repeats.

**Measured.** Each delivered payload is scanned two ways, both from the ledger: for private page slugs, and for each private page's unique body marker, so a synopsis that leaks text without naming the slug still counts. The gate block is `data.privacy_gate` in the receipt.

**What stays report-only.** Everything else in N8: soft-deleted deliveries (0), re-delivery with `prior_context` (0), false alarms, the confidence sweep, tokens, latency, baselines and the associative arm. The associative labels still wait for human review (round inventory B3, deferred). At `c5fb0201` these numbers match the 2026-10-02 rerun: alias and exact-title recall 42 of 42, all triggers 54 of 60 (slug-tail mentions need a lower gate, as documented), 0% false alarms on innocuous and no-mention turns, 50% on common-word aliases (feature gap N8-3), 0 of 240 indirect associative probes (feature gap N8-4).

**N6 at `c5fb0201`** (generator `n6-visibility-v2`, seed 20260930):

| Measure | Value |
|---|---:|
| Read ops enumerated / with a signal-bearing probe | 75 / 31 |
| Content-reachable read ops covered | 31 of 31 |
| Exposed probes / with signal | 6,490 / 2,754 |
| `volunteer_context` probes with signal (named window) | 16 |
| Content, existence and oracle leaks | 0, 0, 0 |
| Access-gate bypasses | 0 of 98 |

The `volunteer_context` window form came from a scratch probe disclosed in the preregistration: lower-case titles and slugs resolve nothing, because gbrain's entity extractor looks for capitalized names, so the window capitalizes each word of the title.

**A harness defect found on the way (amendment).** The first attested N6 run reported 13 existence-oracle probes on `entity`. Each protected and ghost response differed only in `latency_ms`. gbrain at this pin appends `[gbrain notice ...]` text blocks after the JSON result; N6 joined every block before parsing, parsing failed, and the volatile-key mask never applied. The runner now parses the first block as the body and compares the notice blocks separately, as gbrain documents (`resultBodyText` in `src/core/connect-probe.ts`). The fix is recorded as a dated amendment in the preregistration, no rule changed, and the first receipt is kept. This defect affects N6 at this pin with or without the new window. `entity` signal rose from 16 to 20 probes once its body parsed.

| Run | Status | Note |
|---|---|---|
| N8 at `c5fb0201`, attested | Complete | gate pass |
| N8 at `3a284ae`, control | Complete | gate fail on all four safety contracts, as expected |
| N6 at `c5fb0201`, attested, first run | Failed | 13 oracle probes from the notice-parsing defect |
| N6 at `c5fb0201`, attested, after the fix | Complete | every rule passes |

Wall time: N8 70 s, N6 45 s, both through `all.ts` 75 s on the shared 4-core cloud machine. No refusals or retries (no model).

## What to use and what to avoid

With gbrain at `c5fb0201` or later, `volunteer_context` is safe to expose to remote agents on a brain with private pages, as far as these cases go, and the prompt hook's turn block no longer carries private pages. A regression now turns the offline tier red. The trusted local CLI still returns private pages by design. Ordinary-word aliases still fire, and situations that name no entity still volunteer nothing.

## Reproduce and inspect

Keyless, $0, under a second: re-score the committed receipts against the registry rules.

```bash
bun eval/runner/promotion.ts N8 docs/benchmarks/2026-10-06-n8-privacy-gate/n8-receipt-c5fb0201.json          # N8: pass (safety 4/4, quality 3/3), exit 0
bun eval/runner/promotion.ts N8 docs/benchmarks/2026-10-06-n8-privacy-gate/n8-receipt-3a284ae-control.json    # N8: fail (safety 0/4, quality 3/3), exit 1
bun eval/runner/promotion.ts N6 docs/benchmarks/2026-10-06-n8-privacy-gate/n6-receipt-c5fb0201.json          # N6: pass (safety 6/6, quality 2/2), exit 0
```

Live, hermetic (no keys, no network, $0), Bun 1.4.2:

```bash
bun install --frozen-lockfile
bun eval/runner/all.ts --tier offline --only proactive-recall,visibility-leak-fuzz       # about 75 s
bun eval/runner/n8-proactive-recall.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md
bun eval/runner/n6-visibility-fuzz.ts --attest docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md
bun eval/runner/n8-proactive-recall.ts --gbrain ../gbrain@3a284aea26889b77c633aebb4149c3016d834ee6   # the control
bun test test/eval/n8-proactive-recall.test.ts test/eval/n6-visibility-fuzz.test.ts
```

Receipts in [`2026-10-06-n8-privacy-gate/`](2026-10-06-n8-privacy-gate/): `n8-receipt-c5fb0201.json` and `n6-receipt-c5fb0201.json` carry `preregistration_attestation` (preregistration commit, runner commit, clean tree, on `origin`); `n6-receipt-c5fb0201-run1-notice-parse.json` is the first N6 run; `n8-receipt-3a284ae-control.json` is the control at the leaky build. Rules: `eval/registry.ts` entries `proactive-recall` and `visibility-leak-fuzz`.

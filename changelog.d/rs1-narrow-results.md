### RS1's result: gbrain is within 3.5 points of both leading memory servers on new BEAM conversations (GST-1886)

- **RS1's result.** On 20 newly minted million-token BEAM conversations, gbrain v0.60.740.0 reading 8,000 tokens is
  at most 3.5 points behind both the memory-bank server and the extract-first server under frontier judges (one-sided
  95% lower bounds -1.2 and +1.1), and BEAM's judge agrees. It is ahead of the extract-first server and not ahead of the
  memory-bank server. `docs/benchmarks/2026-11-08-rs1-narrow-results.md` gives the verdict, cost per correct answer, the
  sensitivity checks, the per-reader and per-ability rows, and gbrain's pages without facts by cause (0.72% of pages).
  `aggregates.json` and `aggregates.md` beside it hold the verdict tool's output, and the preregistration gains its
  amendments.

### RS1's harness before counted runs: gating judges, the judge check, per-unit custody and the verdict (GST-1886)

- **Gating judges.** RS1 grades claude-opus-5-5 readers with gpt-6-astra and gpt-6.1-sol and particle-1 readers with
  claude-opus-5-5 (`rs1JudgeOf` in `eval/runner/q1/cells/rs1.ts`), at the pinned settings #394 shares, and keeps
  gpt-4.1-mini as the descriptive bridge. The shared `frontierJudgeOf` is unchanged, and a test pins Q1's and F6's cell
  manifests to their earlier digests. The verdict rests on the gating view alone: gbrain against the memory-bank server
  and against the extract-first server, and both one-sided lower bounds must sit above -3.5.
- **Paired reporting.** Every comparison (overall, per reader, per ability, each server, each view) is gbrain minus the
  server on the same questions, with its 95% and labelled 90% intervals and the questions where gbrain scored lower,
  higher and tied. A row with fewer than 5 conversations reads "too few conversations".
- **The judge check.** `eval/runner/rs1/judge-check.ts` grades about 160 public answers (stage 1 answers, screened
  BEAM-1M gold and scripted corruptions) with both gating judges and the bridge judge, and a failed gate stops wave A.
  It ran and every gate passed. `docs/benchmarks/2026-11-08-rs1-narrow/results/judge-check.json` and `judge-check.md`
  hold ids, hashes, labels and scores, never answer, gold or corruption text. A keyless rehearsal never reports a pass.
- **What verdict.ts refuses.** A gating judgment graded by the reader's family or by a judge the map does not name, or
  missing its view, its pinned settings or a model version. A particle-1 re-read must match the filled manifest, and a
  judge that returned more than one model version is flagged. Its new `aggregates` mode is the final custody run: it
  writes `aggregates.json` and `aggregates.md` from a closed vocabulary, with the code commit and file hashes, and
  keeps any refusal's reason in the custody directory.
- **Custody.** `eval/custody/rs1/fill-manifest.ts` writes the filled manifest (ids, paths and SHA-256 hashes only).
  Each RS1 campaign unit records its launch unit, the custody push sends that unit's VM only its own kept conversations
  and the filled manifest, and on the VM setup and the loader refuse any other conversation. Paid minting and
  validation take Gemini's key only from `RS1_GEMINI_API_KEY`, the receipt scan also matches `AQ.`-prefixed Google
  keys, and mint.sh and beam-checkout.sh hash with `shasum -a 256` where `sha256sum` is missing.
- **Paid windows.** mint.sh, rs1_mint.py's real steps, validate.ts `--paid`, the judge check and
  `eval/runner/q1/cell.ts run --manifest rs1` call the guard #394 shares, so each needs `--paid-window` and
  `--window-cap-usd` unless it runs keyless or fake. Counted leases price the pinned judges' output at their pinned cap.
- **Pricing.** `eval/runner/rs1/pricing.ts` takes gbrain's measured ingest rates and each gating judge's measured rate
  from the judge check, prices gpt-6-astra on its own line outside the check-in, and exits 2 when it counts finished
  work without `--spent-usd`.
- **Wave A's run identity.** The gbrain cell's extraction cap sizes from a fixed conversation length, so regenerating
  wave B's cells cannot change wave A's run identity. A fixture recorded at `de943504` and an import guard show that
  wave A's cells are unchanged; they run from `de943504`, with `rs1-cells.json` unchanged.
- **Smaller fixes.** The launch preflight prices particle-1 at Particle's own address, `check-early-stop` exits 3
  when it tested nothing, and a reader whose only answers are failed retrievals costs 0 instead of n/a.
- **Longer plans and validated candidates in the mint.** The first paid mint kept no conversation: two of five chats
  answered all 10 of BEAM's planned batches and still came out under the length gate, and selecting two items per
  ability before validating them never filled every slot. rs1_mint.py now runs BEAM's plan and question code with 15
  batches in place of 10 and refuses a plan that holds any other number; the early stop still ends each chat where
  BEAM's truncate would cut it, and conversations planned with 10 keep 10. The new
  `eval/custody/rs1/validate-candidates.ts` asks validate.ts's two validators about every candidate after the probe step,
  sharing validate.ts's reply cache, and `mint.sh --candidates <report>` selects only candidates both passed. A real
  mint without a report stops each conversation after its probe step, and validate.ts still decides what is kept.
- **Parallel minting and regrouped window checks.** `eval/custody/rs1/mint-lanes.ts` runs mint.sh's first pass for up
  to eight slots at once, one unchanged mint.sh per slot, with each slot's topic, topic check and plan still run one at a
  time in slot order. It refuses to start more slots than are still needed, stops starting slots on a provider refusal,
  holds a lock so only one driver runs on a custody directory, passes a hangup or interrupt to every mint.sh it runs,
  and writes `usage.json` once at the end (`mint.sh --no-usage` skips mint.sh's own write). validate-candidates.ts now
  asks a window again with one prompt per abstention candidate when a validator answers the batched prompt in the wrong
  shape (and keeps asking that window one candidate at a time on later runs), fails a candidate whose own prompt the validator refuses on a new `refusal` gate, and records how each
  unusable reply ended (stop reason, output tokens, content block kinds or HTTP status), never its text.
- **gbrain's newest release.** RS1's gbrain arm runs gbrain's newest release when wave A launches, in place of the weekly
  `stable` tag: v0.60.740.0 (`82fdd000`), read at wave A's launch on 2026-11-18 and then frozen for every counted cell.
  Only the pin fields of `rs1-cells.json` change, and the keyless F6 Docker test passes at the new pin.
- **No idle upkeep in gbrain's cells.** From v0.60.715.0 an idle `gbrain serve` runs gbrain's free maintenance on its
  brain, which in RS1 could happen only when a cell's calls stall and would then change the brain between `/finish` and
  later questions. RS1's gbrain cells set `GBRAIN_IDLE_UPKEEP=off`: every install writes gbrain's own off switch
  (`maintenance.auto false`) and reads it back. The older idle sweep is unchanged.
- **gbrain's build records safety-filter stops and unparsed pages.** In wave A, 17 of the gbrain row's 20 brain builds
  failed because gbrain's own extraction left pages unfinished: the provider's safety filter stopped some transcript
  windows, or gbrain's parser skipped a page as unparsed. The shim then stopped before the quiesce barrier and the fact
  index. RS1's gbrain cells now set `GBRAIN_F6_BUILD_PROBLEMS=record`: the build records those two outcomes and carries
  on, every other problem still fails the realization, and each realization's ingest record carries its refused and
  unparsed pages. Wave A's four gbrain units run again under it, and the servers' and the floor's stand.
- **N_final is 20.** With wave A's gbrain units run again, the internal pilot gives N_final 20 under the preregistered
  sizing rule, so wave B is empty and the verdict reads wave A's 20 conversations. Minting toward the first pilot's
  figure stopped, and the two slots it had started stay outside RS1.
- **A fallback validator for Haiku's refusals.** claude-haiku-5-5 refused some validator prompts in the third mint, and a
  refusal doesn't change on a rerun, so five of the nine new chats could never finish validation. validate.ts and
  validate-candidates.ts now send a prompt Haiku refuses to claude-sonnet-5-5, whose reply counts in Haiku's place, and
  when it refuses too the item fails on the `refusal` gate instead of leaving the conversation incomplete. A
  fallback reply that ends in a refusal counts as a refusal. Usable fallback replies are cached with the fallback's id,
  and both reports count the fallback's replies, also by the category of Haiku's refusal. A prompt that several calls
  hold is asked once. This is validate.ts's first change since the
  freeze. Beforehand, `eval/custody/rs1/probe-fallback.ts` sent six refused prompts to the fallback and kept only how each
  reply ended: all six were answered.

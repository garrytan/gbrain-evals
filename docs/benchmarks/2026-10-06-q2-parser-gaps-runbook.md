# Q2 parser gaps: custodian runbook

This runbook is how the custodian runs decision `q2-parser-gaps-2026-10`, in the order the
[preregistration](2026-10-06-q2-parser-gaps-preregistration.md) fixes. The committed
[campaign manifest](2026-10-06-q2-parser-gaps-campaign.json) lists the same steps. Every command below runs from the
gbrain-evals repository root with `--campaign`, `--step` and `--run`; a runner started that way refuses to start until
the campaign ledger holds every predecessor's receipts, writes its receipt to `$C/<step>/<run>/receipt.json`, and
records the receipt and its spend in `$C/campaign-ledger.jsonl`.

Check where the campaign stands at any time:

```bash
bun eval/runner/q2/campaign.ts status --campaign "$C"
```

## Rules that apply to every step

- **Custody stays out of Git.** `$C`, `$W` and every custody directory must sit outside every git worktree, symlinks
  resolved. Runners check this before they read a custody byte, and every custody read appends a line to the
  `access-log.jsonl` beside the file.
- **Receipts that leave custody carry aggregates only.** Line text, questions and answers stay in the work roots. Only
  step 20's allowlisted aggregate goes to Capy Drive or the gbrain-evals verdict index.
- **Spend.** The ledger tracks spend against the approved $2,100. A paid step whose estimate would take the total past
  the $2,800 alert refuses to start. Stop and ask the owner; after approval, rerun with
  `--owner-approved-over-alert "<who, when>"`.
- **Resume.** A paid step that stops (budget, network, Ctrl-C) prints the exact resume command, the remaining work, the
  cumulative spend and whether the resume continues the same opening. Rerun that command unchanged. Answers and
  judgments are checkpointed separately, so nothing finished is paid for twice.
- **One opening.** I2, W2 and the G6 question set are opened once. A work root refuses a resume whose experiment
  identity differs from the opening it holds.
- **Gate outcomes are separate from execution.** `run_status` says whether a run executed; `gates[]` gives each gate's
  outcome (pass, fail, insufficient, not run, blocked) with its planned, attempted, scored and error denominators and
  the threshold that failed. A receipt's verdict is `pass` only when every gate passed.

## Variables

```bash
export C=~/q2-custody/campaign           # campaign root (ledger, receipts)
export W=~/q2-custody/work               # work roots (brains, line text, labels)
export K=~/q2-custody/material           # custody material as frozen: n/, k/k-pages.jsonl, i/phrasing-i1{a,b,c}.json, i/phrasing-i2{a,b,c}.json, w1/, w2/, q/q-questions.json, q/career-corpus/
export GB=~/gbrain                       # a gbrain checkout holding every ref below
export BASE=<baseline master SHA from the freeze record>
export CAND=<frozen Q2 build SHA>
export DEC=q2-parser-gaps-2026-10
export UBI_OWNER=gbra49                  # if a step runs on Ubicloud
```

Unit refs (`$U1` … `$U6`, or `$U34` when the freeze record makes U3 and U4 joint) and package refs (`$P1` … `$Pk`)
come from the freeze record and the package script. If U3 and U4 are joint, the manifest's `units` list reads
`["U1", "U2", "U34", "U5", "U6"]` in the harness commit the freeze record names.

## 1. Zero-cost smoke (`smoke`)

```bash
bun eval/runner/q2/junk-audit.ts mint --set N --arm candidate --dev --strata stress,templates --gbrain "$GB@$CAND" --work "$W/smoke" --campaign "$C" --step smoke --run dev-junk-audit-N
bun eval/runner/q2/junk-audit.ts mint --set K --arm candidate --dev --gbrain "$GB@$CAND" --work "$W/smoke" --campaign "$C" --step smoke --run dev-junk-audit-K
bun eval/runner/temporal-edges.ts --seeds 3,5 --c-gate --gbrain "$GB@$CAND" --campaign "$C" --step smoke --run dev-temporal-edges
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/write-then-answer.ts --scripted --corpus career --arm-label B --guidance eval/data/p5-write-then-answer/guidance-b.md \
  --models claude-sonnet-5-5 --ingests 1 --ingest-batches 1 --limit 4 --gbrain "$GB@$CAND" --work "$W/smoke-wta" --campaign "$C" --step smoke --run dev-wta-scripted
```

Expected: four receipts with `run_status: completed` and no model spend. The K smoke receipt records which near-miss
shapes the frozen build accepts.

## 2. Preflight (`preflight`)

```bash
bun eval/runner/q2/campaign.ts preflight --campaign "$C" --step preflight --run preflight \
  --baseline "$GB@$BASE" --candidate "$GB@$CAND" --custody-dir "$K/n,$K/k,$K/i,$K/w1,$K/w2,$K/q,$K/q/career-corpus"
```

Expected: every `preflight.*` gate passes: bun >= 1.4.0, git, tar and rsync, the pinned gbrain installed, a verified
price for every G6 model and judge, both provider keys present, both builds resolve to commits, and every custody
directory sits outside every git worktree with a writable access log. Every later step requires this receipt to pass.

## 3. Selection arms on I1 and W1 (`c-select-arms`)

For the baseline and for each unit `X` (ref `$UX`, baseline plus that unit):

```bash
for fs in 1:a:167 2:b:173 3:c:179; do IFS=: read f x seed <<< "$fs"
  bun eval/runner/temporal-edges.ts --c-gate --phrasing-file "$K/i/phrasing-i1$x.json" --seeds $seed --decision-id "$DEC" --purpose "C-gate selection on I1" \
    --gbrain "$GB@$UX" --campaign "$C" --step c-select-arms --run te-I1-f$f-X
done
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --dir "$K/w1" --decision-id "$DEC" --purpose "C-gate selection on W1" \
  --gbrain "$GB@$UX" --campaign "$C" --step c-select-arms --run w-W1-X
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --gbrain "$GB@$UX" --campaign "$C" --step c-select-arms --run world-X
```

Use `X=baseline` with `$BASE` for the baseline. Each of the three I1 phrasing files runs with its own seed from the
freeze record (I1: 167, 173, 179; I2: 181, 191, 193; three seeds of 80 people give the 240/240 write-order invariance
check); the decision joins them and pairs rows by probe
id. Expected: receipts with
`resolved_config.c_gate: true` (general single-value pass, E5 probe and the Q2 ledger on every arm) and hash-only W
rows.

## 4. Selection (`c-select`)

```bash
A() { echo "te=$C/c-select-arms/te-I1-f1-$1/receipt.json+$C/c-select-arms/te-I1-f2-$1/receipt.json+$C/c-select-arms/te-I1-f3-$1/receipt.json,w=$C/c-select-arms/w-W1-$1/receipt.json,world=$C/c-select-arms/world-$1/receipt.json"; }
bun eval/runner/q2/c-gates.ts select --baseline "$(A baseline)" --unit "U1:$(A U1)" --unit "U2:$(A U2)" --unit "U3:$(A U3)" \
  --unit "U4:$(A U4)" --unit "U5:$(A U5)" --unit "U6:$(A U6)" --campaign "$C" --step c-select --run decision
```

Expected: a `q2-c-gates-select` receipt. `data.summary.order` lists the selected units by I1 standardized effect, ties
by unit id; `data.summary.packages` gives P1 ⊂ … ⊂ Pk. Holm runs across the units on one-sided bootstrap p-values at
0.025 (the preregistration's family-wise 0.05 with each test one-sided at 0.025); safety is an intersection-union test.

## 5. Package build (`package-build`)

Build the package refs with gbrain's committed package script from the frozen unit commits, in the selection order,
then record its output:

```bash
bun eval/runner/q2/campaign.ts record --campaign "$C" --step package-build --run packages --receipt <the package script's JSON receipt>
```

## 6. Confirmation arms on I2 and W2 (`c-confirm-arms`), one opening

For the baseline and every package `Pj` (ref `$Pj`), as in step 3 with I2 and W2:

```bash
for fs in 1:a:181 2:b:191 3:c:193; do IFS=: read f x seed <<< "$fs"
  bun eval/runner/temporal-edges.ts --c-gate --phrasing-file "$K/i/phrasing-i2$x.json" --seeds $seed --decision-id "$DEC" --purpose "C-gate confirmation on I2" \
    --gbrain "$GB@$Pj" --campaign "$C" --step c-confirm-arms --run te-I2-f$f-Pj
done
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --dir "$K/w2" --decision-id "$DEC" --purpose "C-gate confirmation on W2" \
  --gbrain "$GB@$Pj" --campaign "$C" --step c-confirm-arms --run w-W2-Pj
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --gbrain "$GB@$Pj" --campaign "$C" --step c-confirm-arms --run world-Pj
```

The campaign reads the run names (`baseline`, `P1` … `Pk`) from the recorded selection. I2 and W2 are never reopened.

## 7. Confirmation (`c-confirm`)

```bash
B() { echo "te=$C/c-confirm-arms/te-I2-f1-$1/receipt.json+$C/c-confirm-arms/te-I2-f2-$1/receipt.json+$C/c-confirm-arms/te-I2-f3-$1/receipt.json,w=$C/c-confirm-arms/w-W2-$1/receipt.json,world=$C/c-confirm-arms/world-$1/receipt.json"; }
bun eval/runner/q2/c-gates.ts confirm --selection "$C/c-select/decision/receipt.json" --baseline "$(B baseline)" --package "P1:$(B P1)" [--package "P2:$(B P2)" ...] \
  --campaign "$C" --step c-confirm --run decision
```

Expected: a `q2-c-gates-confirm` receipt. Fixed sequence, never Holm: Pj is tested only if Pj−1 passed; it passes when
the added unit is superior against Pj−1, every earlier unit is noninferior at 0.01 against Pj−1, and every safety
condition holds against the baseline. `data.summary.units_that_ship` is the longest passing prefix.

## 8. G6 arms (`g6-arms`)

Build the final Q2 build with the confirmed package (a committed ref `$FINAL`), hash the arm-B guidance, write
`$C/arms.json` (`{ "run_status": "completed", "verdict": "pass", "final_ref", "guidance_b_sha256" }`) and record it:

```bash
bun eval/runner/q2/campaign.ts record --campaign "$C" --step g6-arms --run arms --receipt "$C/arms.json"
```

## 9. G6 ingest (`g6-ingest`)

For each corpus `X` in amara and career, arm A then arm B:

```bash
GBRAIN_EVAL_CONFIG=line_grammar.enabled=false bun eval/runner/write-then-answer.ts --phase ingest --corpus X --arm-label A --guidance eval/data/p5-write-then-answer/guidance-a.md \
  --questions-file "$K/q/q-questions.json" [--career-dir "$K/q/career-corpus"] --decision-id "$DEC" --purpose "G6 ingest" --gbrain "$GB@$FINAL" \
  --work "$W/g6-X-A" --paid --budget-usd <step budget> --campaign "$C" --step g6-ingest --run X-A
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/write-then-answer.ts --phase ingest --corpus X --arm-label B --guidance <arm B guidance> \
  --questions-file "$K/q/q-questions.json" [--career-dir "$K/q/career-corpus"] --decision-id "$DEC" --purpose "G6 ingest" --gbrain "$GB@$FINAL" \
  --work "$W/g6-X-B" --paid --budget-usd <step budget> --campaign "$C" --step g6-ingest --run X-B
```

Defaults are the preregistered matrix: four models and three ingests per arm. Expected: one receipt per corpus and arm;
`$W/g6-X-B/grammar-lines/` holds every brain's grammar lines and list lines. No earlier ingest artifact is reused.

## 10. Minting on N and K (`grammar-mint`)

```bash
for arm in baseline candidate; do ref=$([ $arm = baseline ] && echo $BASE || echo $CAND)
  bun eval/runner/q2/junk-audit.ts mint --set N --arm $arm --n-dir "$K/n" --decision-id "$DEC" --purpose "G1 and G4 minting" --gbrain "$GB@$ref" --work "$W/grammar" --campaign "$C" --step grammar-mint --run N-$arm
  bun eval/runner/q2/junk-audit.ts mint --set K --arm $arm --k-file "$K/k/k-pages.jsonl" --decision-id "$DEC" --purpose "G3 and G4 minting" --gbrain "$GB@$ref" --work "$W/grammar" --campaign "$C" --step grammar-mint --run K-$arm
done
```

Both builds run with `line_grammar.enabled=true`. Expected: four mint receipts. The N receipts record the amendment 1
exclusion (BEAM-1M `1m-1`, `1m-6`, `1m-26` dropped if listed); the K candidate receipt records which near-miss shapes
the frozen build accepts.

## 11. G2 sample (`g2-sample`)

```bash
bun eval/runner/q2/junk-audit.ts g2-sample --grammar-lines "$(ls $W/g6-*-B/grammar-lines/*.grammar.jsonl | paste -sd,)" --seed <frozen G2 seed> \
  --work "$W/grammar" --campaign "$C" --step g2-sample --run g2-sample
```

Expected: up to 300 relation lines from arm B's brains, stratified by model (all lines if fewer), plus a fact-line
sample for the reported fact precision.

## 12. Labels (`grammar-label`)

```bash
bun eval/runner/q2/junk-audit.ts label --work "$W/grammar" --paid --budget-usd 40 --campaign "$C" --step grammar-label --run labels
```

Every candidate mint on N, every baseline mint the candidate does not keep (N), every baseline and candidate mint on K
and the G2 samples get labels from `claude-opus-5-5` and `gpt-6.1-sol` with `q2-judge-v1`. A disagreement counts as
wrong; there is no adjudication. Expected: `label-summary.json` with no retryable or unstarted pairs (rerun the same
command until there are none).

## 13. G1–G4 and G2 (`grammar-score`)

```bash
bun eval/runner/q2/junk-audit.ts score --work "$W/grammar" --campaign "$C" --step grammar-score --run gates
```

Expected: a `q2-grammar-gates` receipt with `G1.material_floor`, `G1.zero_tolerance`, `G1.stress_wrong`,
`G1.wrong_per_100k`, `G3.relation_recall`, `G3.decoys`, `G4.guard_loss` and `G2.relation_precision`.

## 14. G5 (`g5`)

```bash
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --gbrain "$GB@$BASE" --campaign "$C" --step g5 --run world-v1-baseline
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --gbrain "$GB@$CAND" --campaign "$C" --step g5 --run world-v1-candidate
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/relation-line-variants.ts --phrasing-file <custodian's variants templates file> --seeds <fresh seeds> --decision-id "$DEC" --purpose "G5 variants" \
  --gbrain "$GB@$CAND" --output "$C/g5/variants-candidate"
bun eval/runner/q2/campaign.ts record --campaign "$C" --step g5 --run variants-candidate --receipt "$C/g5/variants-candidate/receipt.json"
bun eval/runner/q2/g5.ts --world-baseline "$C/g5/world-v1-baseline/receipt.json" --world-candidate "$C/g5/world-v1-candidate/receipt.json" \
  --variants "$C/g5/variants-candidate/receipt.json" --campaign "$C" --step g5 --run decision
```

The variants receipt is recorded with `campaign.ts record` because relation-line-variants runs outside the campaign
guard; record it before the decision so `export` finds every `g5` run.

## 15. G6 answers (`g6-answers`), only after G1–G5 pass

The campaign refuses this step unless `grammar-score/gates` and every `g5` run passed. Rerun each step 9 command with
`--phase answer --step g6-answers` (same `--work`, same `--run` names). If G1–G5 fail, this step does not run and its
spend is saved.

## 16. G6 judging (`g6-judging`)

Rerun each command with `--phase judge --step g6-judging`. Each answer is judged once by `gpt-6.1-sol` with
`q2-wta-judge-v1`; a hash-selected 10% is re-judged by `claude-opus-5-5`. Expected: every answer judged; the receipt's
`data.summary.audit.agreement` reports the audit.

## 17. Immediate cell and HTTP journey (`g6-immediate`, reported)

Rerun each command with `--phase immediate --step g6-immediate`, then once:

```bash
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/write-then-answer.ts --phase http-journey --corpus career --arm-label B --guidance <arm B guidance> \
  --questions-file "$K/q/q-questions.json" --career-dir "$K/q/career-corpus" --decision-id "$DEC" --purpose "G6 HTTP journey" --gbrain "$GB@$FINAL" \
  --work "$W/g6-career-B" --campaign "$C" --step g6-immediate --run http-journey
```

## 18. Adoption recall (`adoption`, reported)

```bash
bun eval/runner/write-then-answer.ts adoption --work "$W/g6-X-B" --paid --budget-usd 10 --campaign "$C" --step adoption --run X-B
```

## 19. G6 decision (`g6-decision`)

```bash
bun eval/runner/write-then-answer.ts compare --a "$C/g6-judging/amara-A/receipt.json,$C/g6-judging/career-A/receipt.json" \
  --b "$C/g6-judging/amara-B/receipt.json,$C/g6-judging/career-B/receipt.json" --campaign "$C" --step g6-decision --run decision
```

Expected: a `q2-g6` receipt with `G6.pooled`, `G6.model.<model>` for each of the four models, `G6.type.relational`,
`G6.type.temporal` and `G6.unanswerable_false_answers`, from the crossed bootstrap (question pairs within corpus strata,
shared across models and arms; ingest brains within corpus × model × arm; 10,000 draws, seed recorded).

## 20. Aggregate export (`export`)

```bash
bun eval/runner/q2/export.ts --campaign "$C" --step export --run aggregate --out "$C/q2-parser-gaps-aggregate.json"
```

Expected: one JSON with gate outcomes, observed values, denominators and spend for every recorded receipt. Only this
file leaves custody.

## Development pilot and power simulation (before the freeze)

The implementer's dev pilot runs steps 9, 15 and 16 on development material (`--dev-seed 1`, no `--questions-file`,
`--ingests 2`, both corpora, four models), then estimates the power of every G6 gate at the planned matrix:

```bash
bun eval/runner/q2/power-sim.ts --receipts <dev pilot receipts of both arms and corpora> --pairs 100 --ingests 3 --sims 200 --effects 0,3,5 --output <dir>
```

A raise in sizes goes into the freeze record with its cost; sizes never fall.

## Changelog

- 2026-10-06: first version, with the campaign manifest and the Q2 harness on branch `capy/q2-parser-gaps`.

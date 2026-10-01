# sealed-confirmation-v2

Public half of the second sealed test set. The questions, chat histories and labels are private and are not in this repository. See the [v2 protocol](../../../docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md) for how the set was made and how it differs from v1, and the [v1 protocol](../../../docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md) for the access rules both sets share.

| File | Contents |
|---|---|
| `manifest.json` | Counts, generator identity, prompt hashes, cost and the SHA-256 commitments of the private `questions.json`, `labels.json` and `ledger.json` |
| `solvability.json` | Oracle, chunk-oracle and no-memory reader results by question kind |
| `overlap-audit.json` | Overlap counts against LongMemEval S/M, Cat13 and `eval/data` |

Do not edit the commitments in `manifest.json`: the runner checks the private files against them before reading. Pass `--manifest eval/data/sealed-confirmation-v2/manifest.json` to `eval/runner/sealed-confirmation.ts`; its default is v1.

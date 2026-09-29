# sealed-confirmation-v1

Public half of a sealed test set. The questions, chat histories and labels are private and are not in this repository. See the [protocol](../../../docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md) for how the set was made, who may open it and how a run is scored.

| File | Contents |
|---|---|
| `manifest.json` | Counts, generator identity, prompt hashes, cost and the SHA-256 commitments of the private `questions.json`, `labels.json` and `ledger.json` |
| `solvability.json` | Oracle-evidence and no-memory reader results by question kind |
| `overlap-audit.json` | Overlap counts against LongMemEval S/M, Cat13 and `eval/data` |

Do not edit `manifest.json`: the runner checks the private files against its commitments before reading them.

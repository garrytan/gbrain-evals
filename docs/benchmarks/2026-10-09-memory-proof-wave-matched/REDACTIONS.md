# Memory proof wave matched rows: redactions

Every change to a receipt in `cells/` after it was first pushed. A redaction changes a machine-local path string and nothing else: no score, count, cost or id moves.

| Date | Files | Change | Before (sha256) | After (sha256) |
|---|---|---|---|---|
| 2026-10-09 | `cells/locomo-locomo10-comparator-rag-205e2d80e388/ledger-status.json` | `"/home/ubi/cells/ledger.sqlite"` → `"~/cells/ledger.sqlite"` (the run VM's home directory, scrubbed with `scrubMachinePaths`) | `49ad0a18fc35` | `298e35635eb0` |
| 2026-10-09 | `cells/locomo-locomo10-gbrain-rag-1b45c46b5969/ledger-status.json` | `"/home/ubi/cells/ledger.sqlite"` → `"~/cells/ledger.sqlite"` (the run VM's home directory, scrubbed with `scrubMachinePaths`) | `d0090e8e259b` | `4857e75b7333` |
| 2026-10-09 | `cells/locomo-locomo10-gbrain-rag-9af924a3f7ce/ledger-status.json` | `"/home/ubi/cells/ledger.sqlite"` → `"~/cells/ledger.sqlite"` (the run VM's home directory, scrubbed with `scrubMachinePaths`) | `cbfcd161ea10` | `685bb99e5029` |
| 2026-10-09 | `cells/locomo-locomo10-comparator-rag-205e2d80e388/spend.json` | `"/home/ubi/cells/ledger.sqlite"` → `"~/cells/ledger.sqlite"` (the run VM's home directory, scrubbed with `scrubMachinePaths`) | `1b8f3879ff04` | `4792396bad06` |
| 2026-10-09 | `cells/locomo-locomo10-gbrain-rag-1b45c46b5969/spend.json` | `"/home/ubi/cells/ledger.sqlite"` → `"~/cells/ledger.sqlite"` (the run VM's home directory, scrubbed with `scrubMachinePaths`) | `cbc402732936` | `5fb3ce17768f` |
| 2026-10-09 | `cells/locomo-locomo10-gbrain-rag-9af924a3f7ce/spend.json` | `"/home/ubi/cells/ledger.sqlite"` → `"~/cells/ledger.sqlite"` (the run VM's home directory, scrubbed with `scrubMachinePaths`) | `fffb6c6a6744` | `8a3c04af813b` |

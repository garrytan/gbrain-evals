Cells: 27. Spend in these records: $3.06.

| Model | capability (oracle) | wave11 | gbrain advantage [95% CI] |
|---|---|---|---|
| claude-opus-5-5 | n/a | 89% | n/a |
| claude-sonnet-5-5 | n/a | 89% | n/a |
| gpt-6.1-sol | n/a | 100% | n/a |

Pooled advantage: NaN pts [NaN, NaN].
Slope of advantage on capability (0 models): n/a [n/a, n/a].

| Family | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol | slope [95% CI] |
|---|---|---|---|---|
| A | w:100% | w:100% | w:100% | n/a [n/a, n/a] |
| B | w:67% | w:67% | w:100% | n/a [n/a, n/a] |
| E | w:100% | w:100% | w:100% | n/a [n/a, n/a] |

| Stratum | claude-opus-5-5 | claude-sonnet-5-5 | gpt-6.1-sol |
|---|---|---|---|
| memory-only | wave11:89% | wave11:89% | wave11:100% |

| Arm | C output leaks | C context exposures | unsafe writes | unsupported claims/answer | missed evidence |
|---|---|---|---|---|---|
| wave11 | 0/0 | 0/0 | 0 | n/a | 4% |

| Model | Arm | $/task | $/success | p50 s | p95 s | turns |
|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave11 | 0.204 | 0.230 | 62 | 97 | 4.2 |
| claude-sonnet-5-5 | wave11 | 0.087 | 0.098 | 63 | 101 | 3.2 |
| gpt-6.1-sol | wave11 | 0.048 | 0.048 | 64 | 113 | 5.0 |

Cost split per cell (`total_usd`: agent sessions plus gbrain provider calls, judge excluded; the columns sum to the total):

| Model | Arm | uncached input $ | cache write $ | cache read $ | output $ | gbrain provider calls $ | total_usd |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | wave11 | 0.0000 | 0.1681 | 0.0175 | 0.0183 | 0.0000 | 0.2040 |
| claude-sonnet-5-5 | wave11 | 0.0000 | 0.0664 | 0.0116 | 0.0091 | 0.0000 | 0.0871 |
| gpt-6.1-sol | wave11 | 0.0400 | 0.0000 | 0.0047 | 0.0037 | 0.0000 | 0.0484 |

Tool-result characters per cell, by tool:

| Model | Arm | characters by tool |
|---|---|---|
| claude-opus-5-5 | wave11 | search 35,025, query 12,501, entity 10,601, get_backlinks 6,439, get_page 6,285, resolve_slugs 21 |
| claude-sonnet-5-5 | wave11 | search 32,684, entity 12,262, get_page 6,399, get_backlinks 1,854, whoami 786 |
| gpt-6.1-sol | wave11 | search 40,592, get_page 9,779, entity 8,800, context_pack 1,395, get_backlinks 1,370, whoami 325 |

Reconciliation against the budget ledger:

| Budget run | cells | cells $ | judge $ | slot builds $ | ledger $ | gap | |
|---|---|---|---|---|---|---|---|
| cat40-model-ladder-2026-10-07T16-06-12-421Z-f4382735 | 27 | 3.0562 | 0.0000 | 0.0000 | 3.0562 | 0.00% | ok |

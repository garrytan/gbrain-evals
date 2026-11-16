Receipt generated 2026-11-16T23:46:18.579Z; gbrain-evals 2cf7eb587 (dirty); cost $0.

| Build | Commit | Version | Tree verified | Symlinks under src/ |
|---|---|---|---|---|
| new | 6ce7195b4 | 0.60.733.0 | yes (8fc13f1ed) | 0 |

### Write-path contracts, final checkpoint (after restart)

| Cell | Acknowledged writes lost (final / worst) | File-to-page violations (final) / worst | Edges | Timeline | Old slug still reaches the page | Wrong-entity |
|---|---|---|---|---|---|---|
| new/pglite/cli | 1 / 1 | 1 of 25 / 1 | 9/10 P, 9/9 R | 4/4 P, 4/4 R | 2/2 | 0 |
| new/pglite/mcp-stdio | 0 / 0 | 0 of 18 / 0 | 8/9 P, 8/8 R | 3/3 P, 3/3 R | 2/2 | 0 |
| new/pglite/mcp-http | 0 / 0 | 0 of 18 / 0 | 8/9 P, 8/8 R | 3/3 P, 3/3 R | 2/2 | 0 |
| new/postgres/cli | 1 / 1 | 1 of 25 / 1 | 9/10 P, 9/9 R | 4/4 P, 4/4 R | 2/2 | 0 |
| new/postgres/mcp-stdio | 0 / 0 | 0 of 18 / 0 | 8/9 P, 8/8 R | 3/3 P, 3/3 R | 2/2 | 0 |
| new/postgres/mcp-http | 0 / 0 | 0 of 18 / 0 | 8/9 P, 8/8 R | 3/3 P, 3/3 R | 2/2 | 0 |

### Withdrawal, remote access and recovery

| Cell | Forget ok | Collateral | Blocked re-remember | Residue (forget / restart) | Pages unsearchable after forget | Remote content leaks | Remote existence disclosures | Probes with signal | Outage |
|---|---|---|---|---|---|---|---|---|---|
| new/pglite/cli | yes | none | 0 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| new/pglite/mcp-stdio | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 0/3 and searchable 3/3 after recovery |
| new/pglite/mcp-http | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 0/3 and searchable 3/3 after recovery |
| new/postgres/cli | yes | none | 0 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| new/postgres/mcp-stdio | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| new/postgres/mcp-http | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |

### Hazard vaults (local CLI observer)

| Cell | Slug collision vault | Shared frontmatter id vault |
|---|---|---|
| new/pglite/cli | 2/3 imported; sync exit 0 | 3/3 imported; sync exit 0 |
| new/postgres/cli | 2/3 imported; sync exit 0 | 3/3 imported; sync exit 0 |

### Details per cell

- **new/pglite/cli**: lost/stale/duplicate/orphan at final: foobarspace; missing edges: none; extra edges: carol->acme; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 0.
- **new/pglite/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: none; extra edges: carol->acme; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 0.
- **new/pglite/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: none; extra edges: carol->acme; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 0.
- **new/postgres/cli**: lost/stale/duplicate/orphan at final: foobarspace; missing edges: none; extra edges: carol->acme; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 0.
- **new/postgres/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: none; extra edges: carol->acme; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 0.
- **new/postgres/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: none; extra edges: carol->acme; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 0.

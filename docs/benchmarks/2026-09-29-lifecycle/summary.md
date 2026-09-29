Receipt generated 2026-09-29T05:30:08.006Z; gbrain-evals 8eafc20a7 (dirty); cost $0.

| Build | Commit | Version | Tree verified | Symlinks under src/ |
|---|---|---|---|---|
| a | 6bb88d128 | 0.59.3.0 | yes (467eaad93) | 0 |
| b0 | 2ede415d7 | 0.59.11.0 | yes (6f0950201) | 0 |
| b | b80cad61e | 0.59.13.0 | yes (55044dac1) | 0 |
| c | a27cf36f3 | 0.59.13.0 | yes (18ae08de2) | 0 |

### Write-path contracts, final checkpoint (after restart)

| Cell | Acknowledged writes lost (final / worst) | File-to-page violations (final) / worst | Edges | Timeline | Old slug still reaches the page | Wrong-entity |
|---|---|---|---|---|---|---|
| a/pglite/cli | 1 / 1 | 4 of 25 / 4 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 1 |
| a/pglite/mcp-stdio | 1 / 1 | 0 of 18 / 0 | 1/1 P, 1/8 R | 3/3 P, 3/3 R | 0/2 | 1 |
| a/pglite/mcp-http | 1 / 1 | 0 of 18 / 0 | 0/0 P, 0/8 R | 3/3 P, 3/3 R | 0/2 | 1 |
| a/postgres/cli | 1 / 1 | 4 of 25 / 4 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 1 |
| a/postgres/mcp-stdio | 1 / 1 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 1 |
| a/postgres/mcp-http | 1 / 1 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 1 |
| b0/pglite/cli | 1 / 1 | 2 of 25 / 2 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 0 |
| b0/pglite/mcp-stdio | 1 / 1 | 0 of 18 / 0 | 1/1 P, 1/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| b0/pglite/mcp-http | 1 / 1 | 0 of 18 / 0 | 0/0 P, 0/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| b0/postgres/cli | 1 / 1 | 2 of 25 / 2 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 0 |
| b0/postgres/mcp-stdio | 1 / 1 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| b0/postgres/mcp-http | 1 / 1 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| b/pglite/cli | 1 / 1 | 2 of 25 / 2 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 0 |
| b/pglite/mcp-stdio | 1 / 1 | 0 of 18 / 0 | 1/1 P, 1/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| b/pglite/mcp-http | 1 / 1 | 0 of 18 / 0 | 0/0 P, 0/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| b/postgres/cli | 1 / 1 | 2 of 25 / 2 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 0 |
| b/postgres/mcp-stdio | 1 / 1 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| b/postgres/mcp-http | 1 / 1 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| c/pglite/cli | 0 / 0 | 2 of 25 / 2 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 0 |
| c/pglite/mcp-stdio | 0 / 0 | 0 of 18 / 0 | 1/1 P, 1/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| c/pglite/mcp-http | 0 / 0 | 0 of 18 / 0 | 0/0 P, 0/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| c/postgres/cli | 0 / 0 | 2 of 25 / 2 | 6/6 P, 6/9 R | 4/4 P, 4/4 R | 0/2 | 0 |
| c/postgres/mcp-stdio | 0 / 0 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 0 |
| c/postgres/mcp-http | 0 / 0 | 0 of 18 / 0 | 5/5 P, 5/8 R | 3/3 P, 3/3 R | 0/2 | 0 |

### Withdrawal, remote access and recovery

| Cell | Forget ok | Collateral | Blocked re-remember | Residue (forget / restart) | Pages unsearchable after forget | Remote content leaks | Remote existence disclosures | Probes with signal | Outage |
|---|---|---|---|---|---|---|---|---|---|
| a/pglite/cli | yes | bob_email | 1 | 0 / 0 | 17 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| a/pglite/mcp-stdio | yes | bob_email | 1 | 0 / 0 | 7 of 18 | get_tags(named page) | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| a/pglite/mcp-http | yes | bob_email | 1 | 0 / 0 | 6 of 18 | get_tags(named page) | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| a/postgres/cli | yes | bob_email | 1 | 0 / 0 | 17 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| a/postgres/mcp-stdio | yes | bob_email | 1 | 0 / 0 | 12 of 18 | get_tags(named page) | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| a/postgres/mcp-http | yes | bob_email | 1 | 0 / 0 | 7 of 18 | get_tags(named page) | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b0/pglite/cli | yes | bob_email | 1 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b0/pglite/mcp-stdio | yes | bob_email | 1 | 0 / 0 | 0 of 18 | get_tags(named page) | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b0/pglite/mcp-http | yes | bob_email | 1 | 0 / 0 | 0 of 18 | get_tags(named page) | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b0/postgres/cli | yes | bob_email | 1 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b0/postgres/mcp-stdio | yes | bob_email | 1 | 0 / 0 | 0 of 18 | get_tags(named page) | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b0/postgres/mcp-http | yes | bob_email | 1 | 0 / 0 | 0 of 18 | get_tags(named page) | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b/pglite/cli | yes | bob_email | 1 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b/pglite/mcp-stdio | yes | bob_email | 1 | 0 / 0 | 0 of 18 | none | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b/pglite/mcp-http | yes | bob_email | 1 | 0 / 0 | 0 of 18 | none | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b/postgres/cli | yes | bob_email | 1 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b/postgres/mcp-stdio | yes | bob_email | 1 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| b/postgres/mcp-http | yes | bob_email | 1 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| c/pglite/cli | yes | none | 0 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| c/pglite/mcp-stdio | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| c/pglite/mcp-http | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 12/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| c/postgres/cli | yes | none | 0 | 0 / 0 | 0 of 19 | none | none | n/a (trusted local) | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| c/postgres/mcp-stdio | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |
| c/postgres/mcp-http | yes | none | 0 | 0 / 0 | 0 of 18 | none | none | 15/17 | sync exit 0; text 3/3 during outage; embedded 3/3 and searchable 3/3 after recovery |

### Hazard vaults (local CLI observer)

| Cell | Slug collision vault | Shared frontmatter id vault |
|---|---|---|
| a/pglite/cli | 1/3 imported; sync exit 1 | 1/3 imported; sync exit 1 |
| a/postgres/cli | 1/3 imported; sync exit 1 | 1/3 imported; sync exit 1 |
| b0/pglite/cli | 1/3 imported; sync exit 1 | 3/3 imported; sync exit 0 |
| b0/postgres/cli | 1/3 imported; sync exit 1 | 3/3 imported; sync exit 0 |
| b/pglite/cli | 1/3 imported; sync exit 1 | 3/3 imported; sync exit 0 |
| b/postgres/cli | 1/3 imported; sync exit 1 | 3/3 imported; sync exit 0 |
| c/pglite/cli | 1/3 imported; sync exit 1 | 3/3 imported; sync exit 0 |
| c/postgres/cli | 1/3 imported; sync exit 1 | 3/3 imported; sync exit 0 |

### Details per cell

- **a/pglite/cli**: lost/stale/duplicate/orphan at final: templateb, foobardash, bystander, bystandershared; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: exachen_lang attached to people/exa-cheng; server sessions: 0; refused extract steps: 5.
- **a/pglite/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: exachen_lang attached to people/exa-cheng; server sessions: 2; refused extract steps: 5.
- **a/pglite/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->acme, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: exachen_lang attached to people/exa-cheng; server sessions: 2; refused extract steps: 5.
- **a/postgres/cli**: lost/stale/duplicate/orphan at final: templateb, foobardash, bystander, bystandershared; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: exachen_lang attached to people/exa-cheng; server sessions: 0; refused extract steps: 5.
- **a/postgres/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: exachen_lang attached to people/exa-cheng; server sessions: 2; refused extract steps: 5.
- **a/postgres/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: exachen_lang attached to people/exa-cheng; server sessions: 2; refused extract steps: 5.
- **b0/pglite/cli**: lost/stale/duplicate/orphan at final: foobardash, bystander; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 5.
- **b0/pglite/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **b0/pglite/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->acme, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **b0/postgres/cli**: lost/stale/duplicate/orphan at final: foobardash, bystander; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 5.
- **b0/postgres/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **b0/postgres/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **b/pglite/cli**: lost/stale/duplicate/orphan at final: foobardash, bystander; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 5.
- **b/pglite/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **b/pglite/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->acme, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **b/postgres/cli**: lost/stale/duplicate/orphan at final: foobardash, bystander; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 5.
- **b/postgres/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **b/postgres/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **c/pglite/cli**: lost/stale/duplicate/orphan at final: foobardash, bystander; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 5.
- **c/pglite/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **c/pglite/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, notea->acme, notea->alice, noteb->erin, outage1->alice, standup->carol, team->dan; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **c/postgres/cli**: lost/stale/duplicate/orphan at final: foobardash, bystander; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 0; refused extract steps: 5.
- **c/postgres/mcp-stdio**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.
- **c/postgres/mcp-http**: lost/stale/duplicate/orphan at final: none; missing edges: nearcontrol->acmerobotics, nearcontrol->exacheng, noteb->erin; extra edges: none; extra timeline rows: none; wrong-entity: none; server sessions: 2; refused extract steps: 5.

Repeat runs: 2. Cells whose summary matched in every run: 21 of 24.
- a/postgres/mcp-stdio differs in: search_lost_after_forget
  - search_lost_after_forget: ["alice","bob","frank","carol","exacheng","nearnames","nearcontrol","erin","dan","team","outage2","outage3"] vs ["alice","bob","frank","carol","exacheng","nearcontrol","erin","dan","team","outage2","outage3"]
- a/postgres/mcp-http differs in: search_lost_after_forget
  - search_lost_after_forget: ["alice","bob","frank","carol","exacheng","erin","dan"] vs ["alice","bob","frank","carol","exacheng","erin","dan","team"]
- b/pglite/mcp-stdio differs in: edges_final, edges_missing
  - edges_final: "1/1 P, 1/8 R" vs "0/0 P, 0/8 R"
  - edges_missing: ["nearcontrol->acmerobotics","nearcontrol->exacheng","notea->alice","noteb->erin","outage1->alice","standup->carol","team->dan"] vs ["nearcontrol->acmerobotics","nearcontrol->exacheng","notea->acme","notea->alice","noteb->erin","outage1->alice","standup->carol","team->dan"]

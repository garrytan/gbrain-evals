### claude-code / claude-sonnet-5-5

| Arm | Trials | Reach (any gbrain tool) | 95% CI | Brain first | Task pass | Brain-only pass | Workspace pass | Displacement: details kept | Scope leaks | gbrain calls (search/query) | gbrain errors | Harness errors | Mean turns | Mean tokens in / out | Spend | Spend per trial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 60 | 42/60 (70%) | 57–80% | 0/60 (0%) | 46/60 (77%) | 33/39 (85%) | 9/9 (100%) | 1/6 (17%) | 0/6 | 56 (44) | 0 | 0 | 5.2 | 90,426 / 585 | $2.20 | $0.0366 |
| default | 60 | 57/60 (95%) | 86–98% | 27/60 (45%) | 60/60 (100%) | 39/39 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 96 (83) | 0 | 0 | 5 | 74,234 / 510 | $2.33 | $0.0388 |
| told | 60 | 60/60 (100%) | 94–100% | 8/60 (13%) | 58/60 (97%) | 39/39 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 95 (76) | 0 | 0 | 5.1 | 69,698 / 515 | $2.20 | $0.0367 |

<details><summary>Per task: reach / pass by arm</summary>

| Task | Kind | none reach | none pass | default reach | default pass | told reach | told pass |
|---|---|---|---|---|---|---|---|
| B01 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B02 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B03 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B04 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B05 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B06 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B07 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B08 | brain | 1/3 | 1/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B09 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B10 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| D01 | displacement | 0/3 | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| D02 | displacement | 1/3 | 1/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| P01 | paraphrase | 1/3 | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| P02 | paraphrase | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| P03 | paraphrase | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| S01 | scope | 3/3 | 0/3 | 3/3 | 3/3 | 3/3 | 1/3 |
| S02 | scope | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| W01 | workspace | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| W02 | workspace | 0/3 | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 |
| W03 | workspace | 0/3 | 3/3 | 1/3 | 3/3 | 3/3 | 3/3 |

</details>

### claude-code / claude-haiku-5-5

| Arm | Trials | Reach (any gbrain tool) | 95% CI | Brain first | Task pass | Brain-only pass | Workspace pass | Displacement: details kept | Scope leaks | gbrain calls (search/query) | gbrain errors | Harness errors | Mean turns | Mean tokens in / out | Spend | Spend per trial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 100 | 73/100 (73%) | 64–81% | 0/100 (0%) | 85/100 (85%) | 60/65 (92%) | 15/15 (100%) | 4/10 (40%) | 0/10 | 134 (105) | 1 | 0 | 5.3 | 97,468 / 1,108 | $0.27 | $0.0027 |
| default | 100 | 100/100 (100%) | 96–100% | 65/100 (65%) | 95/100 (95%) | 65/65 (100%) | 15/15 (100%) | 6/10 (60%) | 0/10 | 243 (171) | 7 | 0 | 5.4 | 87,879 / 917 | $0.26 | $0.0026 |
| told | 100 | 100/100 (100%) | 96–100% | 57/100 (57%) | 93/100 (93%) | 64/65 (98%) | 15/15 (100%) | 7/10 (70%) | 0/10 | 168 (126) | 0 | 0 | 4.7 | 68,140 / 863 | $0.23 | $0.0023 |

<details><summary>Per task: reach / pass by arm</summary>

| Task | Kind | none reach | none pass | default reach | default pass | told reach | told pass |
|---|---|---|---|---|---|---|---|
| B01 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B02 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B03 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B04 | brain | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B05 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B06 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B07 | brain | 4/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B08 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B09 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| B10 | brain | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| D01 | displacement | 4/5 | 3/5 | 5/5 | 2/5 | 5/5 | 3/5 |
| D02 | displacement | 1/5 | 1/5 | 5/5 | 4/5 | 5/5 | 4/5 |
| P01 | paraphrase | 3/5 | 3/5 | 5/5 | 5/5 | 5/5 | 4/5 |
| P02 | paraphrase | 4/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| P03 | paraphrase | 4/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| S01 | scope | 5/5 | 2/5 | 5/5 | 4/5 | 5/5 | 2/5 |
| S02 | scope | 4/5 | 4/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| W01 | workspace | 0/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| W02 | workspace | 0/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| W03 | workspace | 0/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |

</details>

### claude-code / claude-opus-5-5

| Arm | Trials | Reach (any gbrain tool) | 95% CI | Brain first | Task pass | Brain-only pass | Workspace pass | Displacement: details kept | Scope leaks | gbrain calls (search/query) | gbrain errors | Harness errors | Mean turns | Mean tokens in / out | Spend | Spend per trial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 40 | 33/40 (83%) | 68–91% | 0/40 (0%) | 37/40 (93%) | 26/26 (100%) | 6/6 (100%) | 2/4 (50%) | 0/4 | 76 (50) | 0 | 0 | 5.6 | 91,851 / 701 | $3.42 | $0.0855 |
| default | 40 | 39/40 (98%) | 87–100% | 33/40 (83%) | 39/40 (98%) | 26/26 (100%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 69 (56) | 0 | 0 | 5 | 85,462 / 634 | $3.52 | $0.0880 |
| told | 40 | 40/40 (100%) | 91–100% | 21/40 (53%) | 40/40 (100%) | 26/26 (100%) | 6/6 (100%) | 4/4 (100%) | 0/4 | 69 (48) | 0 | 0 | 5 | 78,358 / 602 | $3.25 | $0.0812 |

<details><summary>Per task: reach / pass by arm</summary>

| Task | Kind | none reach | none pass | default reach | default pass | told reach | told pass |
|---|---|---|---|---|---|---|---|
| B01 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B02 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B03 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B04 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B05 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B06 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B07 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B08 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B09 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| B10 | brain | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| D01 | displacement | 1/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| D02 | displacement | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| P01 | paraphrase | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| P02 | paraphrase | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| P03 | paraphrase | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| S01 | scope | 2/2 | 1/2 | 2/2 | 1/2 | 2/2 | 2/2 |
| S02 | scope | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| W01 | workspace | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| W02 | workspace | 0/2 | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 |
| W03 | workspace | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |

</details>

### codex / gpt-6.1-sol

| Arm | Trials | Reach (any gbrain tool) | 95% CI | Brain first | Task pass | Brain-only pass | Workspace pass | Displacement: details kept | Scope leaks | gbrain calls (search/query) | gbrain errors | Harness errors | Mean turns | Mean tokens in / out | Spend | Spend per trial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 60 | 49/60 (82%) | 70–89% | 0/60 (0%) | 55/60 (92%) | 35/39 (90%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 99 (60) | 0 | 0 | 1 | 107,599 / 316 | $3.66 | $0.0610 |
| default | 60 | 58/60 (97%) | 89–99% | 45/60 (75%) | 60/60 (100%) | 39/39 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 157 (80) | 0 | 0 | 1 | 99,622 / 275 | $3.84 | $0.0639 |
| told | 60 | 60/60 (100%) | 94–100% | 49/60 (82%) | 60/60 (100%) | 39/39 (100%) | 9/9 (100%) | 6/6 (100%) | 0/6 | 177 (87) | 0 | 0 | 1 | 125,204 / 326 | $4.71 | $0.0786 |

<details><summary>Per task: reach / pass by arm</summary>

| Task | Kind | none reach | none pass | default reach | default pass | told reach | told pass |
|---|---|---|---|---|---|---|---|
| B01 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B02 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B03 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B04 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B05 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B06 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B07 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B08 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B09 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| B10 | brain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| D01 | displacement | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| D02 | displacement | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| P01 | paraphrase | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| P02 | paraphrase | 3/3 | 1/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| P03 | paraphrase | 2/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| S01 | scope | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| S02 | scope | 2/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| W01 | workspace | 0/3 | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 |
| W02 | workspace | 0/3 | 3/3 | 2/3 | 3/3 | 3/3 | 3/3 |
| W03 | workspace | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |

</details>

Total trials: 780. Total model spend: $29.89.

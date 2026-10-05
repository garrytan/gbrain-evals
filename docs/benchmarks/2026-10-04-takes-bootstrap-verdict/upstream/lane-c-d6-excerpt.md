<!-- Verbatim excerpt of garrytan/gbrain docs/test-audit/2026-10-04/implementation/lane-c.md, section "Takes-bootstrap graduation run (D-6)", at commit d37fab68e95e66347ba661e913cdafca330ae5a2 (merge of #6013, v0.60.59.0). Unchanged on master 8c9a8e9a4 (checked 2026-10-05). -->

## Takes-bootstrap graduation run (D-6)

2026-10-04, `anthropic:claude-haiku-4-5`, all 123 variants of 41 archetypes,
estimate $0.23 under a hard $1 cap, actual $0.0935. Verdict: **not
graduated**; the autopilot tier stays `manual_only`.

| Kind | Expected / matched | Predicted / precise | Precision | Recall |
|---|---|---|---|---|
| fact | 42 / 32 | 70 / 50 | 0.714 | 0.762 |
| take | 33 / 32 | 47 / 42 | 0.894 | 0.970 |
| bet | 24 / 18 | 33 / 18 | 0.545 | 0.750 |
| hunch | 18 / 12 | 16 / 12 | 0.750 | 0.667 |

75 of 123 variants pass; overall precision 0.735, recall 0.803; 0 malformed;
3 forbid violations (press claims attributed to the page holder). Misses
split between classifier defects (bio facts, quotes and panel attributions
return no claims; press attribution leaks; one strong take typed as a bet)
and incomplete archetype labels (valid unlabeled claims count as imprecise).
Next: complete the labels per archetype, then fix bio-fact recall and
press-claim attribution, then rerun.


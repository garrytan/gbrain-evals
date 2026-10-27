# F5 gate on messy-company-v1: result (scored exactly per DECISION-RULE.md)

Rule sha256 6ca46ba4a25e09dd87a3b0ca298f406ab077e71fb06145f83e40703b5fce0b11, written 2026-10-14T17:10:36Z before any run.
Code gbrain 4e10136b (worktree ./gbrain, clean). Dataset gbrain-evals 9498ef78 (./evals), MANIFEST sha256 matched 4a6bd099...
Brain ./brain (PGLite): 226/226 pages via load.ts loadSplit('all'), mentions.owner_phrases=true before import, quiescent after 2 sweeps.

- Population: 6 owner_phrase links (22 windows, 94 unresolved, 2 ambiguous). Sampler refused (<22), exit 3: sample = all 6.
- Correct 6/6, precision 1.000, Wilson 95% [0.610, 1.000].
- VERDICT: FAIL (population 6 < 22; Wilson lower 0.610 < 0.85).
- Recall (should_link, right accounts): dev 2/66 (3.0%), heldout 4/58 (6.9%).
- Remote view: 4 links visible; the 2 hidden both have should_link_public=false; 0 remote links on the 9 private-only gold rows.
  Public-view precision dev 1/1, heldout 3/3.
- False links on should_link=false: dev 0/35, heldout 0/32. Wrong-account links: 0.
- Wrong links: none.
Files: build.ts, build.log, brain-export.json, sample.log, score.ts, score.json, score.log, scorer-reports.txt, system-*.json.
Note: scorer "links_not_on_candidates" counts the other split's links (one system file for both splits); there are no off-candidate links.

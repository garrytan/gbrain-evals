| Cell | Docs | Questions | Errors | hit@1 | hit@3 | lead hit | Embedding USD |
|---|---|---|---|---|---|---|---|
| a.base | 2 | 10 | 0 | 70.0 | 90.0 | 70.0 | 0 |
| a.prefix | 2 | 10 | 0 | 80.0 | 90.0 | 80.0 | 0 |
| a.lead | 2 | 10 | 0 | 70.0 | 90.0 | 70.0 | 0 |
| a.prefix_lead | 2 | 10 | 0 | 80.0 | 90.0 | 80.0 | 0 |
| a.kw_base | 2 | 10 | 0 | 0.0 | 30.0 | 30.0 | 0 |
| a.kw_lead | 2 | 10 | 0 | 0.0 | 30.0 | 30.0 | 0 |
| a.kw_terms | 2 | 10 | 0 | 0.0 | 30.0 | 30.0 | 0 |
| a.kw_lead_terms | 2 | 10 | 0 | 0.0 | 30.0 | 30.0 | 0 |
| aw.base | 118 | 39 | 0 | 46.2 | 76.9 | 46.2 | 0.009 |
| aw.prefix | 118 | 39 | 0 | 51.3 | 74.4 | 51.3 | 0.0067 |
| aw.lead | 118 | 39 | 0 | 46.2 | 76.9 | 46.2 | 0.0014 |
| aw.prefix_lead | 118 | 39 | 0 | 48.7 | 71.8 | 48.7 | 0.0014 |
| aw.kw_base | 118 | 39 | 0 | 53.8 | 76.9 | 53.8 | 0 |
| aw.kw_lead | 118 | 39 | 0 | 53.8 | 76.9 | 53.8 | 0 |
| aw.kw_terms | 118 | 39 | 0 | 53.8 | 76.9 | 53.8 | 0 |
| aw.kw_lead_terms | 118 | 39 | 0 | 53.8 | 76.9 | 53.8 | 0 |
| b.base | 271 | 880 | 0 | 47.3 | 80.0 | 48.5 | 0.1998 |
| b.prefix | 271 | 880 | 0 | 49.9 | 81.7 | 52.6 | 0.2006 |
| b.lead | 271 | 880 | 0 | 49.2 | 80.9 | 51.4 | 0.0721 |
| b.prefix_lead | 271 | 880 | 0 | 51.1 | 82.0 | 54.5 | 0.0729 |
| b.kw_base | 271 | 880 | 0 | 23.2 | 35.3 | 39.2 | 0 |
| b.kw_lead | 271 | 880 | 0 | 23.4 | 35.2 | 38.9 | 0 |
| b.kw_terms | 271 | 880 | 0 | 23.8 | 35.6 | 39.4 | 0 |
| b.kw_lead_terms | 271 | 880 | 0 | 23.9 | 35.6 | 39.3 | 0 |

| Cat cell | Score | Secondary | Embedding USD |
|---|---|---|---|
| cat13.base | nDCG@5 0.5587 | P@1 strict 59.7 | 0.0219 |
| cat13.prefix | nDCG@5 0.5618 | P@1 strict 59.9 | 0.008 |
| cat13.kw_base | nDCG@5 0.4606 | P@1 strict 53.6 | 0 |
| cat13.kw_terms | nDCG@5 0.4606 | P@1 strict 53.6 | 0 |
| cat13b.base | top-1 93.3 | top-3 100.0, errors 0 | 0.001 |
| cat13b.prefix | top-1 93.3 | top-3 100.0, errors 0 | 0.0007 |
| cat13b.kw_base | top-1 93.3 | top-3 100.0, errors 0 | 0 |
| cat13b.kw_terms | top-1 93.3 | top-3 100.0, errors 0 | 0 |

| Contrast | Corpus | hit@3 treatment vs control | wins/losses | exact p | lead hit treatment vs control | wins/losses |
|---|---|---|---|---|---|---|
| prefix vs base | a | 90.0 vs 90.0 | +0/-0 | 1.0 | 80.0 vs 70.0 | +1/-0 |
| prefix vs base | aw | 74.4 vs 76.9 | +2/-3 | 1.0 | 51.3 vs 46.2 | +3/-1 |
| prefix vs base | b | 81.7 vs 80.0 | +31/-16 | 0.040 | 52.6 vs 48.5 | +71/-35 |
| prefix vs base | pooled aw+b | 81.4 vs 79.9 | +33/-19 | 0.070 | primary; no Cat 13/13b regression: true | rule met: false |
| lead vs base | a | 90.0 vs 90.0 | +0/-0 | 1.0 | 70.0 vs 70.0 | +0/-0 |
| lead vs base | aw | 76.9 vs 76.9 | +0/-0 | 1.0 | 46.2 vs 46.2 | +0/-0 |
| lead vs base | b | 80.9 vs 80.0 | +20/-12 | 0.22 | 51.4 vs 48.5 | +44/-19 |
| lead vs base | pooled aw+b | 80.7 vs 79.9 | +20/-12 | 0.22 (Holm 0.86) | secondary; no Cat 13/13b regression: true | rule met: false |
| prefix_lead vs prefix | a | 90.0 vs 90.0 | +0/-0 | 1.0 | 80.0 vs 80.0 | +0/-0 |
| prefix_lead vs prefix | aw | 71.8 vs 74.4 | +0/-1 | 1.0 | 48.7 vs 51.3 | +0/-1 |
| prefix_lead vs prefix | b | 82.0 vs 81.7 | +12/-9 | 0.66 | 54.5 vs 52.6 | +33/-16 |
| prefix_lead vs prefix | pooled aw+b | 81.6 vs 81.4 | +12/-10 | 0.83 (Holm 1.0) | secondary; no Cat 13/13b regression: true | rule met: false |
| prefix_lead vs base | a | 90.0 vs 90.0 | +0/-0 | 1.0 | 80.0 vs 70.0 | +1/-0 |
| prefix_lead vs base | aw | 71.8 vs 76.9 | +1/-3 | 0.63 | 48.7 vs 46.2 | +2/-1 |
| prefix_lead vs base | b | 82.0 vs 80.0 | +40/-22 | 0.030 | 54.5 vs 48.5 | +92/-39 |
| prefix_lead vs base | pooled aw+b | 81.6 vs 79.9 | +41/-25 | 0.064 | descriptive; no Cat 13/13b regression: true | rule met: null |
| kw_terms vs kw_base | a | 30.0 vs 30.0 | +0/-0 | 1.0 | 30.0 vs 30.0 | +0/-0 |
| kw_terms vs kw_base | aw | 76.9 vs 76.9 | +0/-0 | 1.0 | 53.8 vs 53.8 | +0/-0 |
| kw_terms vs kw_base | b | 35.6 vs 35.3 | +4/-2 | 0.69 | 39.4 vs 39.2 | +6/-4 |
| kw_terms vs kw_base | pooled aw+b | 37.3 vs 37.1 | +4/-2 | 0.69 (Holm 1.0) | secondary; no Cat 13/13b regression: true | rule met: false |
| kw_lead vs kw_base | a | 30.0 vs 30.0 | +0/-0 | 1.0 | 30.0 vs 30.0 | +0/-0 |
| kw_lead vs kw_base | aw | 76.9 vs 76.9 | +0/-0 | 1.0 | 53.8 vs 53.8 | +0/-0 |
| kw_lead vs kw_base | b | 35.2 vs 35.3 | +1/-2 | 1.0 | 38.9 vs 39.2 | +1/-4 |
| kw_lead vs kw_base | pooled aw+b | 37.0 vs 37.1 | +1/-2 | 1.0 (Holm 1.0) | secondary; no Cat 13/13b regression: true | rule met: false |
| kw_lead_terms vs kw_base | a | 30.0 vs 30.0 | +0/-0 | 1.0 | 30.0 vs 30.0 | +0/-0 |
| kw_lead_terms vs kw_base | aw | 76.9 vs 76.9 | +0/-0 | 1.0 | 53.8 vs 53.8 | +0/-0 |
| kw_lead_terms vs kw_base | b | 35.6 vs 35.3 | +5/-3 | 0.73 | 39.3 vs 39.2 | +7/-6 |
| kw_lead_terms vs kw_base | pooled aw+b | 37.3 vs 37.1 | +5/-3 | 0.73 | descriptive; no Cat 13/13b regression: true | rule met: null |

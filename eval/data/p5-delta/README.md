# P5 delta arm patches

Patches that turn a gbrain build into a comparison arm for the P5 delta preregistration
(gbrain `docs/eval/decisions/p5-delta-2026-10-05/preregistration.md`).

| Patch | Base | What it does |
|---|---|---|
| `no-not-employment-role-guard.patch` | `0a967e5d5` | H10 no-guard arm: removes the `NOT_EMPLOYMENT_ROLE` guard from `src/core/link-temporal-evidence.ts`, restoring `EMPLOYMENT.start`'s `took … role` and `became … at/of` alternatives to their form before `0b3027972` (`git diff 0a967e5d5 0b3027972^ -- src/core/link-temporal-evidence.ts`). |

Make the arm as a local commit that is never pushed, then pass the printed spec to a runner:

```bash
bun eval/runner/lifecycle/make-variant-build.ts --checkout ../gbrain --ref 0a967e5d5 \
  --patch eval/data/p5-delta/no-not-employment-role-guard.patch --name no-not-employment-role-guard
# prints --gbrain <checkout>@<variant sha>
```

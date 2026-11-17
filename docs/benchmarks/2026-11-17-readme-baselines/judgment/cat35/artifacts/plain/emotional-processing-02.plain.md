# Code Review Friction – Quartzlane Queue PR

## Situation
- Received a harsh 14-comment review from **Casper Hale** (senior engineer) on the **quartzlane queue PR** — a personal record for comments on a single PR
- Stinging phrases: *"this is obviously wrong"* and *"did you even test this path?"*
- The sting was amplified by having invested extra care in this PR expecting a clean approval

## Comment Breakdown (Sorted)
| Comments | Topic | Verdict |
|---|---|---|
| 1–5 | Retry logic | **Legitimate** — missed edge case, could have caused prod bugs |
| 6–7 | Naming conventions | Low-stakes nitpicks |
| 8–11 | Test coverage | **Legitimate** technical catches |
| 12 | "Did you even test this" | Valid concern, **harmful tone** |

## Emotional Layer
- Underlying fear: looking sloppy after nearly a year on the team, still feeling like proving-myself mode
- Specific concern: Casper is well-respected; a harsh review could shape how the whole team perceives the work
- Note to self: **one rough PR does not redefine reputation**

## Action Plan
- [ ] Draft a direct message to Casper — not accusatory, just honest about how comment 12 landed
- [ ] Propose a **tone guide** in the contributing docs for the repo (constructive phrasing norms)
- [ ] Personal rule: **24-hour cooling-off period** before responding to anything that triggers a strong reaction

## Notes on Casper
- Written tone is blunt and can read as dismissive
- In-person dynamic is notably calmer and more collegial (prior one-on-one went fine)
- Worth defaulting to a quick call over async text when tension arises
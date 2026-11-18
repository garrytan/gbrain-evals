# Shadow Inbox — Concept & Icebox Notes

## What It Is
An AI agent watches the inbox and pre-writes a reply for every incoming email, staging it in a folder before the user even opens the original. The user acts as **editor, not author** — reviewing, tweaking, and pressing send manually. The agent **never sends autonomously**; staging is the hard safety boundary.

## Origin & Supporting Data
- User ("Juno") ran an informal experiment: ~50% of sent replies went out unchanged from the first draft, suggesting substantial automation potential.
- Estimated real email volume: **~140 emails/week** (after stripping newsletters and automated alerts).

## Known Risks
| Risk | Notes |
|---|---|
| **Tone drift** | Agent defaults may skew formal; cumulative shift goes unnoticed over weeks |
| **Hallucinated context** | Agent might reference a meeting or commitment the user never made |
| **Over-trust / rubber-stamping** | Starting in editor mode may reduce vigilance on nuanced messages |

## Trust-Building Features (MVP Sketch)
- **Confidence tiers**: color-coded Green / Yellow / Red on each staged draft
  - Green = routine, safe to skim
  - Yellow = review closely
  - Red = write manually
- **Weekly audit digest**: bulk review of auto-archived decisions to build trust without daily friction
- **Emotional-cue flags**: agent detects anger, urgency, grief and prompts manual authorship

## Icebox Memo Structure (one page)
1. One-sentence pitch
2. Target user persona
3. Trust risks + mitigations
4. MVP feature set (confidence tiers, weekly digest, emotional flags)
5. **Reopen trigger**: tied to *Driftless Scheduling* milestones (first paying customer or stable MRR)

## Status
**Frozen.** Driftless Scheduling is the current priority (user interviews scheduled, working prototype, clearer revenue angle). Shadow Inbox is earlier-stage and was deliberately parked to avoid classic shiny-object avoidance. Revisit when Driftless hits its reopen trigger.
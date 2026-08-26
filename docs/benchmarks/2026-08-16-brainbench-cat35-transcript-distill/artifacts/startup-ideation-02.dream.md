Shadow Inbox is a product concept for an AI agent that watches an incoming email queue and preemptively writes a draft reply for every new message, staging it beside the original so the user arrives as an editor rather than a blank-page author. The idea emerged from an empirical observation: roughly half of hand-drafted replies go out completely untouched from their first pass. The concept is currently parked in the icebox while [[concepts/driftless-scheduling]] remains the primary bet.

## The Core Concept

> "What if every email arrives with a draft reply already waiting in a staging folder? Like, an agent watches my inbox, reads incoming mail, and preemptively writes a response I can review before even opening the original message. I call it shadow inbox."

The mental model flip: you move from **author** to **editor**. The agent does the grunt work; you approve, tweak, or override.

## Empirical Seed

> "I went back through my sent folder and realized about half my hand drafted replies went out untouched from my first pass. No edits, no rewording."

Self-measured usage data: ~50% of sent replies were approved verbatim on first draft. Inbox volume context: ~140 real emails per week (stripping newsletters and automated alerts).

## Safety Model

The critical design invariant the user named: **it never sends, it only stages.** The agent is a draft generator only — no background automation pushes anything to a recipient. The human still presses Send.

## Known Risks

1. **Over-trust / rubber-stamp trap** — approving quickly without real attention, especially for nuanced or emotionally tricky messages
2. **Tone drift** — agent defaults to a formal register; over weeks, correspondents perceive a personality shift the user never intended
3. **Hallucinated context** — agent references a meeting that was never scheduled; user skims past it; recipient believes something was confirmed

## Trust Architecture (Design Direction)

### Confidence Tiers (UI)
> "Green for routine, yellow for review closely, red for draft manually. That visual shorthand could keep me honest without slowing me down."

| Tier | Color | Action |
|------|-------|---------|
| Routine | 🟢 Green | Skim and approve |
| Needs attention | 🟡 Yellow | Read carefully before approving |
| Manual required | 🔴 Red | Write fresh; agent draft is reference only |

### Other Trust Accelerators
- **Weekly digest** of auto-archived decisions — audit agent judgment in bulk without daily friction
- **Emotional flag layer** — explicit warnings when the agent detects anger, urgency, or grief in incoming mail, prompting manual reply

## Icebox Terms

Agreed reopen trigger: when [[concepts/driftless-scheduling]] reaches a meaningful milestone (first paying customer or stable MRR), pull Shadow Inbox back out and prototype the confidence-tier staging view.

### Recommended Icebox Memo Structure
1. One-sentence pitch
2. Target user persona
3. Trust risks + mitigations
4. MVP feature set (confidence tiers, weekly digest, emotional flags)
5. Reopen trigger tied to Driftless milestones

During a startup ideation session on 2026-08-03, the user named a recurring personal pattern: gravitating toward new, exciting ideas at precisely the moment the current project hits friction or difficulty. The insight arose in the context of considering whether to pursue a new concept (Shadow Inbox) instead of staying focused on [[concepts/driftless-scheduling]], which is closer to launch but entering its harder phase.

## The Named Pattern

> "I reach for shiny new ideas exactly when the current one gets hard. Classic avoidance pattern."

This is a self-diagnosis offered without prompting — the user recognized the pull toward a novel concept as avoidance behavior, not genuine strategic re-evaluation. Naming it in the moment was enough to correct the course: the new idea was consciously iced.

## Context of the Observation

- [[concepts/driftless-scheduling]] is at a pre-launch stage with user interviews lined up, a working prototype, and a clearer revenue angle
- Shadow Inbox, while compelling, is earlier-stage with more open trust risks
- The user's own reasoning: splitting attention across two projects at this stage could slow both

## The Discipline Applied: Icebox with a Trigger

Rather than abandoning the new idea or letting it drain ongoing attention, the user adopted an **icebox-with-reopen-trigger** structure:
- Park the idea with a lean one-page memo (core value prop, known risks, MVP feature set)
- Set an explicit condition under which to revisit — a milestone tied to the primary project, not an arbitrary calendar date
- This converts vague "maybe someday" into a concrete future decision point

This is worth tracking as a decision-making practice: the icebox memo disciplines the impulse to explore without requiring the user to kill the idea or defend it in the moment.

## Related

- [[concepts/driftless-scheduling]] — the primary project this pattern showed up against
- [[people/mira-voss]] — has given feedback on Driftless; the kind of external accountability that counterweights the avoidance pull
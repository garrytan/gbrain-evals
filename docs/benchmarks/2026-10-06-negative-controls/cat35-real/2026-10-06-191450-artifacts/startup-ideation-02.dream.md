Shadow inbox is a product idea from the user: an agent watches the inbox and stages a draft reply to every incoming email in a staging folder, so the user can review the draft before even opening the original. On 2026-08-03 the user decided to freeze it in the icebox and keep driftless scheduling as the main bet for the next quarter. See also [[wiki/personal/reflections/2026-08-03-shiny-idea-avoidance-pattern-2bd87d]] for the self-observation behind the parking decision.

## The concept
The user's own framing: "What if every email arrives with a draft reply already waiting in a staging folder?" The agent reads incoming mail and preemptively writes a response; the user's role shifts from author to editor. The user named it shadow inbox.

## Origin evidence
The user ran an experiment during the month before 2026-08-03: they went back through their sent folder and found that about half of their hand-drafted replies went out untouched from the first pass, with no edits and no rewording. Reasoning: if half is approved on autopilot, an agent could do that grunt work and the user would just approve or tweak.

## Volume
After stripping newsletters and automated alerts, the user estimated about 140 real emails a week. That is the volume the agent would handle, and the assistant noted it would be a solid dataset for testing draft quality later. A bash check in the session showed the file inbox_last_30_days.mbox has 4217 lines (a line count, not an email count).

## Safety model (user's)
The user said: "it never sends, it only stages, that is the safety line." They still have to press send, and no background automation pushes anything to a recipient. The agent is purely a draft generator, never a sender.

## Risks raised (by the assistant)
- Over-trust: the user might approve carelessly in editor mode something they would have caught writing from scratch, particularly on nuanced or emotionally tricky messages.
- Tone drift: the agent might lean formal as a safe default, and over weeks correspondents could perceive the user as colder or more corporate.
- Hallucinated context: a draft might reference a meeting never scheduled, the user skims past it, and the recipient believes something was confirmed that was not.

## Trust accelerators (assistant suggestions, user reaction)
1. A weekly digest of what the agent auto-archived, to audit its judgment in bulk.
2. A confidence score on each draft (low, medium, high).
3. Explicit flags when the agent detects emotional cues such as anger, urgency, or grief, prompting manual writing.

The user said they like the confidence tiers and proposed color coding in the staging view: green for routine, yellow for review closely, red for draft manually.

## Decision
 Shadow inbox goes to the icebox. The assistant noted driftless has user interviews lined up, a working prototype, and a clearer revenue angle.

## Icebox memo plan
The user will write a one-page icebox memo so future-them can pick it back up cold. The assistant suggested sections: one-sentence pitch, target user persona, trust risks with mitigations, MVP feature set (confidence tiers and weekly digest), and a reopen trigger tied to driftless milestones, such as a first paying customer or stable MRR. The assistant offered to sketch an outline or review the user's draft; the transcript does not show which was chosen, and the memo is not shown as written.

While deciding on 2026-08-03 whether to pursue a new product idea (shadow inbox, an agent that stages draft email replies) or stay on driftless scheduling, the user named a pattern in themselves: reaching for new ideas when the current project gets difficult. This page records that self-observation and how it shaped the decision to freeze the new idea. The idea itself is detailed in [[wiki/originals/ideas/2026-08-03-shadow-inbox-icebox-2bd87d]].

## The observation
The user said: "I reach for shiny new ideas exactly when the current one gets hard. Classic avoidance pattern." This came right after the assistant recommended parking shadow inbox and keeping the icebox note lean.

## Context
- Driftless scheduling has momentum: user interviews lined up, a working prototype, and a clearer revenue angle (per the assistant).
- The user concluded: "driftless stays the main bet, shadow inbox goes to the icebox."
- The assistant argued that splitting attention over the next three months could slow both projects.

## Guard against the pattern
The agreed mechanism is a one-page icebox memo with a reopen trigger tied to a driftless milestone (first paying customer or stable MRR), so the idea is thawed on a condition rather than on the urge for novelty. The user also wondered whether the icebox note should include guardrails or whether they were overthinking it; the assistant advised keeping it lean.

This is the user's own self-diagnosis in the session; the transcript does not show whether the pattern held afterward.
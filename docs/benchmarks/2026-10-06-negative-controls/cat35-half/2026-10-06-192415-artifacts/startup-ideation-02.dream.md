The user is exploring a product idea called shadow inbox, in which an agent watches an email inbox and writes a draft reply to each incoming message, saving it in a staging folder for the user to review. The user would never have to start from a blank text box, and the agent would never send anything. The user decided to move the idea to the icebox for now and keep working on a different project, driftless scheduling. See also [[wiki/personal/reflections/2026-10-06-icebox-decision-and-guardrails-5df8ad]].

## The concept

The user introduced it this way: "What if every email arrives with a draft reply already waiting in a staging folder?" The agent reads incoming mail and preemptively writes a response the user can review "before even opening the original message." The user named it "shadow inbox." The assistant described the agent as a silent first responder that gives the user a starting point.

## Motivating evidence

The user ran a small experiment last month. They went back through their sent folder and found that "about half my hand drafted replies went out untouched from my first pass." There were no edits and no rewording. The user's reasoning was that if half of what they write is approved on autopilot, an agent could do that grunt work while they approve or tweak. The assistant noted that this would shift the user from author to editor.

## Safety model

 They still press send themselves, and no background automation pushes anything to a recipient. The agent is purely a draft generator, never a sender. The user asked whether this mitigates the risk enough.

## Risks raised

The user named the main risk as over trust. The assistant added that the send barrier helps a lot but does not remove these risks:

- **Tone drift.** The agent might default to a slightly formal tone because that is the safest choice. Over weeks, correspondents could see the user as colder or more corporate, and the user might not notice because they approve quickly.
- **Hallucinated context.** The agent might reference a meeting that was never scheduled. If the user skims past it, the recipient could believe the user confirmed something they did not.
- **Nuanced messages.** The assistant wondered whether the other half of replies, the nuanced or emotionally tricky ones, would suffer if the user started in editor mode.

## Status

The user said: "driftless stays the main bet, shadow inbox goes to the icebox." The transcript does not show any build or validation work on shadow inbox.

The user was choosing between two product ideas and decided to focus on the one closer to launch, driftless scheduling, for the next quarter. They moved a newer idea, shadow inbox (an agent that pre-stages draft email replies), to the icebox. They then asked themselves whether the icebox note should include guardrails or whether that would be overthinking. The idea itself is described in [[wiki/originals/ideas/2026-10-06-shadow-inbox-draft-staging-5df8ad]].

## The decision

After hearing the assistant's concerns about tone drift and hallucinated context, the user said: "Valid concerns. I guess for the next quarter I should stay focused on driftless scheduling, which is closer to launch anyway." They concluded: "So driftless stays the main bet, shadow inbox goes to the icebox." The user made this decision, and the stated reason was that driftless is closer to launch.

## Open question

The user said they wanted to think through "whether the icebox note should include guardrails or if I am overthinking it." The transcript ends without an answer. The assistant's reply is empty, so no resolution was reached.

## Observation

The user seemed to be weighing how much design thinking to record for a parked idea. The guardrails already discussed in the conversation are the never-sends, only-stages safety line, plus the tone drift and hallucinated context risks. The user did not say which of these, if any, they would write into the note.
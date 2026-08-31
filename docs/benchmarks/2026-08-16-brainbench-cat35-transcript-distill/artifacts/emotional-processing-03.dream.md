During the tidelamp shutdown conversation on August 10 2026, the user recalled a feature from their first shipped app — a reading queue that resurfaced saved articles based on how long they had been sitting unread. The idea was judged worth preserving and porting forward into [[concepts/fernpost]] rather than letting it disappear with the original project.

## The original mechanism (Tidelamp)

> "I built this little system where you could save articles and it would resurface them based on how long they'd been sitting. The reading queue deserves a second life inside fernpost."

The core insight: instead of a flat, chronological "saved items" list (which becomes a graveyard), resurface items *proportionally to their age*. The longer something sits, the more it gets nudged back to the top — preventing the quiet burial that makes most read-later tools fail.

## Why this works

Most read-later tools fail because the queue grows faster than it drains. Items saved in excitement get buried under newer excitement. Age-weighted resurfacing flips the incentive: older unread items gain visibility rather than losing it. The mechanism is structurally similar to spaced repetition (SR) used in flashcard systems, but applied to *intent* (read this article) rather than *memory* (recall this fact).

## Design notes for a Fernpost port

- The simplest implementation: a "staleness score" = `days_in_queue / max_days_threshold`, capped at 1.0. Items above 0.8 appear in a "resurface" section.
- Could optionally decay the *opposite* direction for items the user explicitly skips repeatedly — treating repeated non-engagement as implicit dismissal.
- Pairs well with Fernpost's existing RSS/markdown pipeline — incoming saved links could feed the queue directly.
- A weekly digest email showing the top 3 "overdue reads" would close the loop without requiring a daily active visit.

## Provenance

This feature lived in Tidelamp (see [[wiki/personal/reflections/2026-08-10-tidelamp-farewell-51eea8]]) and is being consciously transplanted rather than reinvented — the shutdown ritual itself surfaced it as worth saving.

On August 10 2026, the user worked through the emotional weight of deliberately shutting down Tidelamp — their first shipped side project — rather than letting it decay into a 404. The conversation moved from hesitation to warmth as a concrete plan (farewell page, user email, September 1st shutdown date) transformed abstract grief into an honoring ritual. Tidelamp is acknowledged as the spiritual ancestor of [[concepts/fernpost]].

## The project and what made it hard to let go

Tidelamp still attracted roughly thirty visitors a month after six dormant years of zero maintenance. That non-zero number was the sticking point — it meant someone, somewhere, was still arriving. The draft farewell note sat at two hundred words while the question of whether that was *enough* went unanswered.

The deeper reason for the hesitation surfaced mid-conversation: Tidelamp was the first proof that finishing was possible.

> "Before tidelamp I had maybe a dozen abandoned projects, things I'd start excited and then lose steam on. But tidelamp shipped. It was janky and the CSS was a disaster but it worked and people used it and I maintained it for two years before life got busy. That proof that I could see something through... I think that's what fernpost grew out of."

## The emotional reframe: honoring vs. abandoning

Writing the farewell note produced an unexpected feeling:

> "Writing the farewell note felt warm instead of sad, surprisingly. Like I was finally acknowledging what it did for me instead of just letting it rot."

The warmth tracked with a broader letting-go mood that afternoon — a dusty USB hub from a desk drawer went into the donate pile in the same session. Small objects, same motion.

## The plan

- **Farewell page** — explains what Tidelamp was, links to [[concepts/fernpost]] as the spiritual successor, provides an article export path for any remaining users
- **Email to all signups** — sent even knowing most addresses are dead ("it feels correct to try")
- **Shutdown date: September 1, 2026** — enough runway to do it thoughtfully without dragging it out
- **Cost relief** — $11/month hosting (~$132/year) redirected away from "paying for ghosts"

## The shift once the date was set

> "Honestly... lighter? I thought I'd feel worse once I committed to it. But having the date and the plan makes it feel like I'm honoring it instead of neglecting it. Like tidelamp gets to retire instead of just slowly decay. That's what I wanted, I think. For it to end on purpose."

## Pattern to note

Intentional endings feel categorically different from entropy. Setting a date and a ritual (farewell page + email) converted what felt like loss into something closer to completion — the same quality that made Tidelamp meaningful in the first place. See also: [[wiki/originals/ideas/2026-08-10-reading-queue-resurfacing-51eea8]] for the design idea worth carrying forward into Fernpost.
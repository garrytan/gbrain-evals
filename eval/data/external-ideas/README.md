# External ideas: synthetic relative-date questions

`synthetic-dates-v1.json` holds 60 invented LongMemEval-format questions for the external-ideas wave A study (GBRA-162). Each answer needs the day a conversation happened plus a relative phrase the user said in it, such as "I adopted a beagle puppy four days ago". Every person, pet and event is invented.

- Generator: `eval/runner/external-ideas-wave-a/synthetic-dates.ts`, seed 20261021. Regenerate with `bun eval/runner/external-ideas-wave-a/synthetic-dates.ts`; the output must be byte-identical.
- SHA-256: `4700d68d3e96a772c0bb45dabbeef7cd39a218db090bf0127792760fdf77599a` (404,318 bytes).
- Kinds, 15 questions each: days between two events, the date of one event, days from one event to the question date, and which of two events came first (the event mentioned in the later conversation happened earlier).
- Haystacks have 6 to 10 conversations on different days, multi-week gaps and, in 22 of 60, a year boundary. Distractors: other events with relative phrases, a similar event of someone else, future plans, and assistant turns that use relative words generically.
- Gold answers come from the generator's calendar arithmetic. Relative phrases are restricted to ones that name exactly one day ("yesterday", "three days ago", "two weeks ago", "last Friday" when that Friday is in the previous week).

The generator is frozen once the study's preregistration is committed. A change is a new file (`synthetic-dates-v2.json`) and a dated preregistration amendment.

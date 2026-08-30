A pattern surfaced during the QL-4620 debugging session on [[concepts/quartzlane]]: a software abstraction introduced for future flexibility that was never actually used ended up carrying a real, measurable performance tax. This captures the mental model that emerged — that unused abstractions don't just add complexity, they create hidden costs that are invisible until something regresses and forces a profiler run.

---

## The Core Observation

During the quartzlane QL-4620 regression, a `TokenizationStrategy` trait was introduced to make tokenization algorithms swappable. It looked like a reasonable design choice. But:

1. **Only one concrete implementation was ever written** — the `DefaultStrategy`.
2. **The trait added a layer of dynamic dispatch** — indirection through a `dyn TokenizationStrategy` pointer on what turned out to be a hot path.
3. **The refactor that introduced the trait also accidentally moved regex compilation into the hot path** — the two problems compounded.

The user's summary:

> "I want to revert the strategy interface, it bought us nothing. It added indirection and we never actually used the swappable algorithm feature. The only concrete implementation was the default one."

And after removing it:

> "Everything is back within noise of the pre-refactor baseline. Some benchmarks are even slightly faster, probably from removing the trait indirection."

## The Mental Model

**Abstractions are not free options.** When you introduce an abstraction "for future flexibility," you're paying a present cost (indirection, complexity, cognitive load, hidden allocation) in exchange for a speculative future benefit (algorithm swappability, extensibility). If the future benefit never materializes, you've paid the cost for nothing — and the cost can compound in ways that aren't obvious at code review time.

The particularly dangerous case is when the abstraction sits on a **hot path** — a function called thousands of times per query. Each unit of indirection multiplies:

- Dynamic dispatch overhead
- Inline elimination failures (the compiler can't inline through a trait object)
- Missed cache effects
- And, as here, accidentally-moved expensive operations that would have been obvious if the function were simple

## Why It Hides

Abstractions obscure performance problems for a specific reason: **the abstraction's purpose makes the code feel correct**. The author sees the trait, understands why it exists, and doesn't profile the call because they already understand it. The cost is invisible precisely because the code looks reasonable.

This is distinct from accidental complexity — it's *intentional* structure creating unintentional overhead.

## The Heuristic

Before introducing a polymorphic abstraction on a hot path, ask:

1. **Do I have more than one concrete implementation right now?** If not, defer the abstraction.
2. **Is this called in a tight loop or per-query?** If yes, the indirection cost multiplies.
3. **Will the compiler be able to monomorphize this, or does it require a trait object?** `dyn Trait` costs; `impl Trait` in a concrete struct often doesn't.
4. **What does the profiler say before and after?** Run the benchmark suite before merging, not after users report slowdowns.

## The Corollary: Run Benchmarks Before Merging

The QL-4620 session produced a concrete process failure acknowledgment:

> "This is mildly embarrassing that my own refactor did this. I should have run the full benchmark suite before merging that PR."

The fix is mechanical: add a CI performance gate with a threshold (in this case, 10% over baseline fails the job). This converts "I should have profiled" from a personal discipline requirement into a structural enforcement — the process catches what the author's blind spot misses.

## Related

- [[concepts/quartzlane]] — the project where this pattern was observed
- [[people/casper-hale]] — caught the production regression before any internal monitoring did, underscoring that structural catches (CI gates) matter more than hoping users don't notice

On 2026-08-02 the user tracked down and fixed QL-4620, a query latency regression in [[concepts/quartzlane]] that doubled p95 latency (100ms → 200ms+) following a tokenizer refactor. The root cause was a regex pattern being recompiled on every call to `split_tokens` instead of being cached — a subtle hot-path mistake introduced during an otherwise reasonable-looking refactor. The fix was a `OnceLock`-based module-level cache, reverting the unused `TokenizationStrategy` trait abstraction, and adding a CI performance gate to prevent recurrence.

---

## What Happened

The user opened the session already knowing the symptom — latency spikes in quartzlane since the tokenizer PR merged. Profiling confirmed it quickly:

> "Nearly 39% of inclusive time is spent in regex::compile. Each call to split_tokens is recompiling the same unicode pattern, burning 4ms every single time."

The flamegraph and trace logs made the culprit unambiguous: the refactor had moved pattern construction inside `split_tokens`, eliminating a `lazy_static`-held compiled regex. On a multi-field query, that 4ms-per-call cost compounds fast.

## The Fix

Two changes:

1. **Cache the compiled pattern** via `std::sync::OnceLock<Regex>` at module level — one-time initialization, zero recompilation cost on subsequent calls.
2. **Revert the `TokenizationStrategy` trait** — the abstraction was introduced to make tokenization algorithms swappable, but only one concrete implementation ever existed (`DefaultStrategy`). The trait added indirection and nothing else.

Post-fix benchmarks returned to within noise of the pre-refactor baseline. Several tests came in slightly faster, credited to removing the trait indirection layer.

## The Emotional Texture

The user named the discomfort directly:

> "This is mildly embarrassing that my own refactor did this. I should have run the full benchmark suite before merging that PR. Live and learn I guess."

This is a clean example of the "author's blind spot" failure mode: the person who wrote the abstraction is the last to notice its performance cost, because they understand its purpose and don't profile what they already trust.

## Casper's Role

[[people/casper-hale]] caught the regression in production before any internal alarm. He noticed his dashboard queries taking noticeably longer and opened the issue. The user explicitly acknowledged this:

> "Casper actually flagged it first from his install, he noticed his dashboard queries taking noticeably longer and opened the issue. Good thing he was paying attention."

This is consistent with Casper's pattern — he runs his own quartzlane install and tends to surface regressions early. The release plan (PR reviewed today, merge on CI pass, patch release tomorrow) was explicitly framed around getting the fix to users like Casper by end of week.

## Process Decision: CI Perf Gate

To prevent recurrence, the user decided to add a benchmark threshold check to CI:

> "We should add a perf gate in CI that fails anything ten percent over baseline so we catch these regressions before they ship next time."

The criterion bench harness already supports baseline comparisons; the gate is mostly a threshold check script wired into the PR workflow. This was scoped as a follow-up PR after the fix lands.

## Release Plan

- Squash commits to two: one removing the unused strategy trait, one adding the OnceLock cache.
- Get PR reviewed today; merge once CI passes.
- Cut quartzlane v0.9.1 tomorrow morning.
- Ping Casper directly so he knows the fix is incoming.
- Close QL-4620 with a link to the release notes.
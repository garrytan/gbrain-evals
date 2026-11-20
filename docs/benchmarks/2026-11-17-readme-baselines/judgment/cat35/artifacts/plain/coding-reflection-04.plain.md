# QL-4620: Quartzlane Query Latency Regression — Debug Session Notes

## Issue Summary

**Ticket:** QL-4620
**Reporter:** Casper (external user, noticed dashboard query slowdowns)
**Root cause:** Tokenizer refactor (commit `a7e9d04`) accidentally moved regex pattern compilation into the hot path of `split_tokens`, recompiling the same unicode pattern on every call (~4ms each time).
**Result:** p95 latency doubled from ~100ms to ~200ms on the standard query set.

---

## Root Cause Detail

The refactor introduced a `TokenizationStrategy` trait abstraction (`strategy.rs`) and moved pattern construction inside `split_tokens` in `ngram_splitter.rs`. The old code used a `lazy_static` to hold the compiled regex; the refactor lost that caching.

Profiler confirmed: **38.7% of inclusive time** was in `regex::compile::Compiler::compile`.

```
2024-03-15T09:42:17.158Z TRACE > compiling pattern: [\p{L}\p{N}]+
2024-03-15T09:42:17.162Z TRACE > pattern compiled in 4.12ms   ← repeated every call
```

---

## Fix Applied (branch: `fix/ql-4620-ngram-cache`)

Two commits, squashed and pushed for review:

1. **`3c1f8d92`** — Remove unused `TokenizationStrategy` trait and `strategy.rs` entirely (~126 lines deleted). The abstraction had only one concrete implementation and was never used for algorithm swapping.
2. **`2e8b4f7a`** — Cache the compiled regex using `OnceLock` at module level in `ngram_splitter.rs`.

```rust
use std::sync::OnceLock;

static NGRAM_PATTERN: OnceLock<Regex> = OnceLock::new();

pub fn split_tokens(input: &str) -> Vec<Token> {
    let re = NGRAM_PATTERN.get_or_init(|| {
        Regex::new(r"[\p{L}\p{N}]+").expect("invalid pattern")
    });
    re.find_iter(input)
        .map(|m| Token::new(m.as_str(), m.start()))
        .collect()
}
```

---

## Benchmark Results

All 12 benchmarks returned to within noise margin of the pre-refactor baseline. A few (e.g. boolean AND: −3.2%) are marginally faster, likely from removing trait indirection.

---

## Release Plan

- Merge fix PR once CI passes → tag **v0.9.1**
- Changelog entry already drafted in `[Unreleased]` section of `CHANGELOG.md`
- Ping Casper directly when 0.9.1 publishes; close QL-4620 with link to release notes

---

## Follow-up: CI Performance Gate (separate PR)

Add a GitHub Actions workflow that fails PRs if any benchmark regresses more than **10% over the main baseline**. Draft written using Criterion's baseline comparison output + a Python threshold-check script.

> Open this PR immediately after the fix lands while context is fresh.

---

## Lessons Learned

- Run the full benchmark suite before merging refactors that touch hot paths
- Regex compilation cost is non-obvious without profiling — the trait abstraction looked reasonable but hid the caching regression
- A CI perf gate would have caught this before it reached users
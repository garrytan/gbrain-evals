### Hard company questions: the old-build control names its unretried cell

- [docs/benchmarks/2026-11-19-cat40-hard-old-build-control.md](docs/benchmarks/2026-11-19-cat40-hard-old-build-control.md)
  now says in its limits that one reused newest-build cell ended on an Anthropic HTTP 520 and was scored with no retry.
  If a retry had scored it right, newest minus old would be -1.25 (-4.25 to +1.75); if wrong, it stays -1.50 as
  published, and the verdict is "not a regression" either way.
- [docs/benchmarks/cat40-hard/accepted-drift.json](docs/benchmarks/cat40-hard/accepted-drift.json) lists the agent
  loop's 5xx retry change, so the next counted hard-company run's freeze check accepts it.

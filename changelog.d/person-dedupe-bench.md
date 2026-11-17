### A bench for how often duplicate-people finders link different people

- A new keyless bench, `person-dedupe`, measures how often a duplicate-people finder links two different people:
  namesakes at one company, behind a shared team or family address, across sources, with Jr suffixes and lookalike
  names, plus the same person written many ways. It scores reference matchers and a stand-in for gbrain's documented
  finder today, and scores `gbrain dedupe --preview --json` output from a file once the finder ships. First result: a
  shared email plus the same name links different people when the email is a role or household address
  ([report](docs/benchmarks/2026-11-17-person-dedupe.md)).

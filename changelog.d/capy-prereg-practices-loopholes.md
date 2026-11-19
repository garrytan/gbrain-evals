- The preregistration check now treats every Markdown file under `docs/` whose name contains `prereg` or ends in
  `-protocol.md` as a preregistration that needs a registry entry, instead of two filename shapes, so a plan named
  `PREREGISTRATION.md` or `*-protocol.md` can't skip the eval-loop practices. It also refuses any name on
  [docs/benchmarks/preregistrations-grandfathered.json](docs/benchmarks/preregistrations-grandfathered.json) that wasn't
  in the repository when that list was first committed, so a new plan can't be grandfathered. The 16 existing files the
  wider match finds are added to the list.

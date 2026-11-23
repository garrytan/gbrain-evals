- **Three free Cat 9 checks now guard recent gbrain fixes to publish, fact extraction warnings and Apple Contacts enrichment.**

### Added

- `pr-guard-10035-publish-private` checks that `gbrain publish` leaves a page's Timeline, its fact rows and its hidden comments out of the shared file. It covers a page written by hand and a page exported from the brain, and it checks that a page whose frontmatter never closes is refused.
- `pr-guard-9973-dream-no-worker` checks that `gbrain dream` warns when facts-absorb jobs wait with no job worker, and that it names `gbrain jobs supervisor start`. It runs on Postgres and Rust, because a PGLite brain extracts facts itself.
- `pr-guard-9950-contacts-enrich-adds-only` checks that Apple Contacts enrichment fills only empty fields, adds only emails and phones the owner stated, and records a dry run without sending it even with writes switched on. It uses the gbrain build's own fake of the helper's Contacts route, which logs every request, and a positive control shows that a pull in `on` mode does send. A gbrain build without that fake reports the scenario as not run.
- Each guard scenario names the gbrain pull request it guards, the release that first shipped the fix and the status expected on the newest release. A check is labelled pass only when the fix shipped, and the catalog check refuses any other label.
- Cat 9 scenarios can now check a file the call wrote, set a GBRAIN_* threshold for one call, wait a few seconds, write a file with a chosen mode, start a stub service, compare a list of JSON rows in any order with `rows_eq`, and name the engines their behavior applies to.
- Tests in `test/eval/cat9-pr-guards.test.ts` cover the new steps, the guard labels and the three scenarios.

# Short-code alias fixture (T0b development seed 20261104)

Four pages cut unchanged from the T0b generator (`program-primary-hard-v1`, seed 20261104, task `h20261104-t1`),
rendered with `renderHardDoc`. Every name in them is invented.

- `companies/joronex-foods.md` declares its short code in prose: "Also called JOF in my notes."
- `meetings/2026-10-10-joronex-call.md` names the company only as "JOF" (title "Call with JOF") and carries the
  corrected price.
- `inbox/2026-10-09-aziz-reschedule.md` and `inbox/2026-09-26-aziz-procurement-handoff.md` name the company only as
  "(JOF)", beside the champion's full name.

Observed on gbrain v0.60.106.0 (`7aa2caa0`) and master `fc548317`: the company card's `aka` list is empty, the call note
has no links, and each mail has one `mentions` link, to `people/kofi-aziz`. Expected once a declared short code is an
alias: all three pages link to `companies/joronex-foods`, so the company's `referenced_by`, `get_backlinks` and
search's alias fan-out reach them. `JOF` is three characters, below the alias minimum of 4 on gbrain #6271's branch
(`src/core/mentions/aliases.ts`, `MIN_ALIAS_LENGTH`).

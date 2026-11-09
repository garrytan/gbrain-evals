# Miss-mining: turn real misses into private gold questions and public weekly counts

gbrain's evals mostly score synthetic data. The failures that cost the most are the ones a real agent hits on a real
brain: a stale fact used in a draft, a page it failed to find, a write that never landed. Miss-mining records those
misses where they happen, on the box that holds the brain, in a private log. Two things come out of it:

1. **A private gold question file.** `to-live-recall.ts` turns each logged miss that carries its ask into a
   live-recall question, so real misses run through the keyless batch 3 retrieval harness on the box
   ([live-recall run kit](../live-recall/RUN-KIT.md)). The file never leaves the box.
2. **Public weekly counts.** `weekly-counts.ts` counts one week's misses by cause, kind of ask and how the miss was
   detected, and nothing else. That file is the only miss-mining output that leaves the box. It is a validity
   reference for the predictive measures (does a synthetic measure's cause mix move the way real misses do).

The log is Wintermute's to keep; gbrain-evals ships the format, the custody check and the two converters. Everything
here is keyless: no model or provider call is made.

## What you need

- This repository at the commit you were sent, with `bun install` run.
- A private miss log, `~/.gbrain-evals-miss-log/miss-log.jsonl` for example, readable only by you (`chmod 600`).

## The miss log

JSONL, one miss per line. Write a line when Garry corrects a fact, when you find the right answer later, or when a
tool returns an error that cost an answer. A refusal names the line and the field, never the content.

```json
{"id":"miss-2026-11-10-001","date":"2026-11-10","ask_kind":"lookup_meeting_prep","cause":"stale_fact","detection":"garry_corrected","garry_noticed":true,"gold":[{"slug":"meetings/2026-07-08-partner-sync"}],"stale":[{"slug":"people/ines-varga"}],"ask":{"exact":"Where does Ines Varga work now?","paraphrase":"Which company employs our former gripper-supplier technology chief these days?"}}
```

(An invented example from the public live-recall fixture; real lines stay on the box.)

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `miss-YYYY-MM-DD-NNN`, unique |
| `date` | yes | `YYYY-MM-DD`, the day of the miss |
| `ask_kind` | yes | `ops_build`, `save_ingest`, `lookup_meeting_prep`, `drafting`, `research`, `status`, `decision_recall`, `personal`, `tasks`, `counts_lists`, `correction` or `time_window` |
| `cause` | yes | a cause id from `eval/runner/predictive/causes.ts` (`stale_fact`, `retrieval_miss`, `wrong_entity`, `write_integrity`, `privacy_hidden` and the rest) |
| `privacy_subcause` | only with `privacy_hidden` | `direct_flag`, `alias_inheritance` or `derived_default` |
| `detection` | yes | `garry_corrected`, `found_later` or `tool_error` |
| `garry_noticed` | yes | `true` or `false` |
| `gold` | yes | one or more `{"slug": ...}` pointers to the page that held the right answer, with optional `chunk_ids` |
| `ask` | no | `{"exact": ..., "paraphrase": ...}`: the ask in its own words and reworded, so the miss can become a question |
| `stale` | no | pages that held the superseded fact, for a `stale_fact` miss |
| `live_type` | no | the live-recall type to file the question under; derived when absent |

## Steps

1. **Weekly counts**, once a week. Send only the output file.

   ```bash
   bun eval/runner/miss-mining/weekly-counts.ts --log ~/.gbrain-evals-miss-log/miss-log.jsonl --week 2026-11-09 \
     --out weekly-2026-11-09.json
   ```

   `--week` is any date in the week; weeks run Monday to Sunday in UTC. The file holds `schema`
   (`miss-weekly-counts/v1`), `week_start`, `week_end`, `n_entries` and `counts[cause][ask_kind][detection]`, with
   empty cells left out.

2. **Gold questions**, when the log has grown. The question file stays on the box.

   ```bash
   bun eval/runner/miss-mining/to-live-recall.ts --log ~/.gbrain-evals-miss-log/miss-log.jsonl \
     --out ~/.gbrain-evals-miss-log/questions.jsonl
   ```

   An entry becomes a question only when it has `ask`. Its type is `live_type`, else `freshness` for a
   `stale_fact` miss with `stale` pages, `entity` for a `wrong_entity` miss, `time_window` for a time-window ask,
   and `topic` otherwise. The terminal shows a custody-checked summary (`miss-to-live-recall/v1`: `converted`,
   `skipped` by reason, `by_type` and the skipped ids). Then freeze and run it as a batch 3 question file
   ([RUN-KIT.md](../live-recall/RUN-KIT.md)) and send only the scorecard.

## What leaves the box, and how that is enforced

Only `weekly-*.json` and the live-recall scorecard leave the box. `eval/runner/miss-mining/custody.ts` checks every
miss-mining export before it is written or printed, and refuses with `MM_CUSTODY_LEAK` (naming only the field path)
when a check fails:

1. **Structure.** Every key is one the formats define. Every string is an allowlisted word (a cause id, an ask kind,
   a detection mode, a live-recall type, a skip reason or a schema name) or matches a fixed shape at one path: a
   `YYYY-MM-DD` date at `week_start` and `week_end`, and a miss id in `skipped_ids`. No string may be longer
   than 42 characters, and every number must be finite. A person's name or a codename has no field it could land in.
2. **Needle scan.** The serialised export is searched for every slug and ask text in the miss log, with the
   live-recall scorecard's `scanForLeaks`.

`test/eval/miss-mining.test.ts` fuzzes the check with short private-looking strings (a person's name, a codename,
a slug) in every field and as keys, and every one is refused.

## Refusal codes

### mm_log_invalid

`MM_LOG_INVALID`: a line of the miss log is not valid JSON or a field is missing or outside its vocabulary. The detail
names the line and the field. Fix that line and rerun; nothing was written.

### mm_custody_leak

`MM_CUSTODY_LEAK`: an export would have carried a string outside its allowlist, or a slug or ask text from the log.
Nothing was written. Send the field path (never the content) to GBEV-3.

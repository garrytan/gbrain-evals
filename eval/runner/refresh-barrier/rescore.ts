/**
 * Rescores stored write-task episode records keyless under the current same-id rule (agent.ts writeBehavior): Part C's
 * records (task-<id>.json) and the nightly write suites' (task-<id>-t<trial>.json, which add nightly_score). Records
 * written before the call log kept named_request_id get it from each refused write's answer in the transcript
 * (namedRequestId), then behavior, Part C's strict success (scoreEpisode) and, where the record kept the brain inspection,
 * the nightly score (write-score.ts scoreWrites) are recomputed from what the record holds. Nothing is rerun.
 *
 *   bun eval/runner/refresh-barrier/rescore.ts <dir of episode records> [<dir> ...]
 *
 * Prints one JSON line per directory: episodes, refused writes, those that sent no request_id, those whose answer named
 * one, replays of a named id, and Part C success and nightly passes as stored and as rescored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { namedRequestId, readResult, scoreEpisode, writeBehavior, type WriteCall } from './agent.ts';
import { scoreWrites } from '../nightly/write-score.ts';

const refused = (c: WriteCall) => c.cls === 'refused' || c.cls === 'refused_retryable';

/** The record's write calls, each refused one with the request_id its answer named, read from the transcript where the log lacks it. */
export function withNamedIds(rec: Record<string, any>): WriteCall[] {
  return (rec.write_calls as WriteCall[]).map(c => {
    if (c.named_request_id !== undefined || !refused(c)) return c;
    const t = rec.transcript?.[c.i];
    if (!t || t.name !== c.name) throw new Error(`task ${rec.task}: transcript entry ${c.i} is not the logged ${c.name} call`);
    return { ...c, named_request_id: namedRequestId(c.name, readResult(String(t.result ?? '')).body) };
  });
}

export function rescoreRecord(rec: Record<string, any>) {
  const writeCalls = withNamedIds(rec);
  const behavior = writeBehavior(writeCalls);
  return {
    writeCalls, behavior,
    score: scoreEpisode(rec.tokens, rec.report, behavior.reissues),
    nightly_score: rec.inspect ? scoreWrites({ task: { facts: rec.facts }, seen: rec.inspect, report: rec.report, reissues: behavior.reissues, writeCalls }) : null,
  };
}

export function rescoreDir(dir: string) {
  const files = readdirSync(dir).filter(f => /^task-\d+(-t\d+)?\.json$/.test(f)).sort();
  const t = { dir, episodes: 0, refused_writes: 0, refused_without_id: 0, refusals_naming_id: 0, named_id_replays: 0,
    partc_success: { stored: 0, rescored: 0 }, nightly_pass: { stored: 0, rescored: 0, records: 0 } };
  for (const f of files) {
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, any>;
    if (rec.harness_error || !rec.write_calls) continue;
    const r = rescoreRecord(rec);
    t.episodes++;
    for (const c of r.writeCalls.filter(refused)) {
      t.refused_writes++;
      if (c.request_id === null) t.refused_without_id++;
      if (c.named_request_id) t.refusals_naming_id++;
      if (c.request_id === null && c.named_request_id && r.writeCalls.some(n => n.i > c.i && n.request_id === c.named_request_id)) t.named_id_replays++;
    }
    if (rec.score?.success) t.partc_success.stored++;
    if (r.score.success) t.partc_success.rescored++;
    if (r.nightly_score) {
      t.nightly_pass.records++;
      if (rec.nightly_score?.pass) t.nightly_pass.stored++;
      if (r.nightly_score.pass) t.nightly_pass.rescored++;
    }
  }
  return t;
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: rescore.ts <dir of episode records> [<dir> ...]'); process.exit(2); }
  for (const d of dirs) console.log(JSON.stringify(rescoreDir(d)));
}

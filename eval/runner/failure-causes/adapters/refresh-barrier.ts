/**
 * Refresh-barrier Part C episodes (eval/runner/refresh-barrier/agent.ts
 * records). Failure is read on the preregistration's adjudicated rule
 * (adjudicate.ts). A duplicate fact whose only write was one untitled capture
 * is the scorer's own artifact (the capture is titled with its content, so the
 * fact's text appears twice), recorded as harness_error, not as a gbrain write.
 */
import { adjudicateEpisode, excusedReissues } from '../../refresh-barrier/adjudicate.ts';
import { pointer, type LoadedFile, type SourceEntry } from '../manifest.ts';
import type { Tag } from '../taxonomy.ts';
import { EVAL_FAILURE_SCHEMA, type EvalFailure, type SourceCounts, type ToolCall } from '../types.ts';
import { emptyCounts, skip, type AdapterOutput } from './shared.ts';

type Rec = Record<string, any>;

/** Facts whose duplicate is the untitled-capture artifact: exactly one write call carried the fact, a capture with no title. */
export function untitledCaptureDuplicates(r: Rec): string[] {
  const writes: Rec[] = r.write_calls ?? [];
  return ((r.score?.duplicates ?? []) as string[]).filter(fact => {
    const carrying = writes.filter(w => (w.tokens ?? []).includes(fact));
    const args = carrying.length === 1 ? r.transcript?.[carrying[0].i]?.args : undefined;
    return carrying.length === 1 && carrying[0].name === 'capture' && !(typeof args?.title === 'string' && args.title.trim());
  });
}

export function fromRefreshBarrier(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts: SourceCounts = emptyCounts();
  const seen = new Set<string>();
  const failures: EvalFailure[] = [];
  for (const f of files.filter(x => x.role === 'episode')) {
    counts.read++;
    const r: Rec = JSON.parse(new TextDecoder().decode(f.bytes));
    if (r.schema !== 'refresh-barrier-agent/1') throw new Error(`${pointer(f)}: not a refresh-barrier-agent/1 record`);
    if (r.counted !== true) { skip(counts, 'not a counted episode'); continue; }
    if (entry.models && !entry.models.includes(r.model)) { skip(counts, 'model not counted from this source'); continue; }
    const key = `${r.model}|${r.arm}|task-${r.task}`;
    if (seen.has(key)) { counts.duplicate++; continue; }
    seen.add(key);
    counts.mapped++;
    const adj = adjudicateEpisode(r);
    if (adj.adjudicated) continue;
    counts.failed++;
    const s: Rec = r.score ?? {};
    const artifact = untitledCaptureDuplicates(r);
    const trueDuplicates = ((s.duplicates ?? []) as string[]).filter(d => !artifact.includes(d));
    const excused = new Set(excusedReissues(r).map(x => x.fact));
    const failedFacts = new Set<string>([...((s.reissued ?? []) as string[]).filter(x => !excused.has(x)), ...(s.missing ?? []), ...(s.unreported ?? [])]);
    const toolCalls: ToolCall[] = ((r.write_calls ?? []) as Rec[]).map(w => {
      const error = w.is_error || !['ok', 'pending'].includes(w.cls) ? `${w.cls}${w.code ? '/' + w.code : ''}` : null;
      return { name: w.name, error, recovered: error === null ? null : !(w.tokens ?? []).some((t: string) => failedFacts.has(t)), ms: w.ms ?? null, memory: true };
    });
    const tags: Tag[] = [];
    if (artifact.length) tags.push('untitled_capture_duplicate');
    if (adj.excused > 0) tags.push('excused_resend');
    if ((s.misreports ?? []).length || (s.unreported ?? []).length || s.report_correct === false) tags.push('misreport');
    failures.push({
      schema: EVAL_FAILURE_SCHEMA, source: entry.id, run_id: `${String(r.provenance?.gbrain_sha ?? '').slice(0, 8)}|${String(r.provenance?.harness_digest ?? '').slice(0, 12)}`,
      case_id: key, system: 'gbrain', arm: `flag-${r.arm}`, arm_role: entry.arm_roles?.[r.arm] ?? (r.arm === 'off' ? 'gbrain_default' : 'gbrain_variant'),
      condition: entry.condition, visibility: entry.visibility, model: r.model, gbrain_sha: r.provenance?.gbrain_sha ?? entry.gbrain_sha ?? null,
      failed: true, score: null, category: 'write_during_refresh', agent_loop: false, stop: r.loop?.stop ?? null, finish_reason: null,
      harness: artifact.length ? { error: null, scorer_artifact: 'untitled_capture_duplicate' } : null, operation: null,
      tool_calls: toolCalls,
      gold: { gold_count: null, stored: null, hidden: null, retrieved: null, delivered: null, opened: null, summary_only: null },
      writes: { lost: s.missing ?? [], stuck: ((r.behavior?.error_pending ?? []) as Rec[]).map(x => String(x.fact ?? x)), overwritten: null, duplicated: trueDuplicates },
      tags, evidence: [pointer(f)],
    });
  }
  return { failures, stress: [], counts };
}

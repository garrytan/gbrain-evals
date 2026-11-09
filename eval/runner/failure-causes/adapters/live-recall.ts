/**
 * Live recall phase 1 scorecards (eval/runner/live-recall/scorecard.ts,
 * schema live-recall-scorecard/v1). They hold per-arm aggregates only, so the
 * adapter returns stress counts: questions whose gold page was not in the top
 * 20 (retrieval_miss) and questions whose gold was in the top 20 but not the
 * top 5 (wrong_ranking). No row text exists or is read.
 */
import { fileText, pointer, type LoadedFile, type SourceEntry } from '../manifest.ts';
import type { StressCount } from '../types.ts';
import { emptyCounts, skip, type AdapterOutput } from './shared.ts';

type Rec = Record<string, any>;

export function fromLiveRecall(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts = emptyCounts();
  const stress: StressCount[] = [];
  for (const f of files.filter(x => x.role === 'scorecard')) {
    const d: Rec = JSON.parse(fileText(f));
    if (d.schema !== 'live-recall-scorecard/v1') throw new Error(`${pointer(f)}: not a live-recall-scorecard/v1 file`);
    const sha = d.run?.gbrain_loaded_commit ?? d.run?.gbrain_pin_commit ?? entry.gbrain_sha ?? null;
    for (const [arm, a] of Object.entries(d.arms ?? {}) as Array<[string, Rec]>) {
      const all = a?.overall?.all;
      const n = all?.n, at5 = all?.success_at?.k5?.hits, at20 = all?.success_at?.k20?.hits;
      counts.read++;
      if (![n, at5, at20].every(x => typeof x === 'number')) { skip(counts, 'arm without success_at k5 and k20'); continue; }
      counts.mapped++;
      const base = { source: entry.id, run_id: `${d.protocol ?? entry.id}`, system: `gbrain/${arm}`, model: 'none (retrieval only)', gbrain_sha: sha,
        condition: entry.condition, visibility: entry.visibility, unit: 'questions' as const, of: n, evidence: [pointer(f, `arm=${arm}`)] };
      stress.push({ ...base, cause: 'retrieval_miss', count: n - at20, detail: `${arm}: gold page not in the top 20 for ${n - at20} of ${n} questions` });
      stress.push({ ...base, cause: 'wrong_ranking', count: at20 - at5, detail: `${arm}: gold page in the top 20 but not the top 5 for ${at20 - at5} of ${n} questions` });
    }
  }
  return { failures: [], stress, counts };
}

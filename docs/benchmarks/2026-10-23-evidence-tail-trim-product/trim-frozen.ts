import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trimEvidenceTail } from './evidence-tail-trim.ts';
const base = '/home/user/.capy/work/gbra162-counted/lme-frozen';
const blob = (h: string) => readFileSync(join(base, 'blobs', h.slice(0, 2), h + '.txt'), 'utf8');
const ds = new Map((JSON.parse(readFileSync('/home/user/.capy/work/lme/longmemeval_s_cleaned.json', 'utf8')) as any[]).map(q => [q.question_id, q]));
const affectedIds = new Set<string>((JSON.parse(readFileSync('/home/user/.capy/work/gbra162-counted/a2-answers/manifests/r2_tail_trim-affected-s1-claude-sonnet-5-5.json', 'utf8')).requests as any[]).map(r => r.question_id));
let affected = 0, dropped = 0, guarded = 0, before = 0, after = 0, affBefore = 0, affAfter = 0, sameAsArm = 0;
const byType: Record<string, number> = {};
let e66: unknown;
for (const line of readFileSync(join(base, 'frozen-manifest.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  const q = ds.get(o.question_id);
  const results = JSON.parse(blob(o.arms.auto.results));
  const score = new Map<string, number>();
  for (const h of o.hits5) score.set(h.slug, Math.max(score.get(h.slug) ?? -Infinity, h.score));
  const rows = results.map((r: any) => ({ ...r, score: score.get(r.slug) ?? Number.NaN }));
  const { results: kept, meta } = trimEvidenceTail(rows, q.question);
  const tok = (rs: any[]) => rs.reduce((n, r) => n + r.delivered.tokens, 0);
  before += tok(rows); after += tok(kept);
  if (meta.dropped > 0) { affected++; affBefore += tok(rows); affAfter += tok(kept); byType[q.question_type] = (byType[q.question_type] ?? 0) + 1; if (affectedIds.has(o.question_id)) sameAsArm++; }
  dropped += meta.dropped; guarded += meta.kept_by_query_terms;
  if (o.question_id === 'e66b632c') e66 = { kept: kept.map((r: any) => r.slug), all: rows.map((r: any) => r.slug), meta };
}
console.log(JSON.stringify({ questions_trimmed: affected, also_trimmed_by_arm: sameAsArm, arm_affected: affectedIds.size, blocks_dropped: dropped, kept_by_query_terms: guarded,
  token_saving_affected: 1 - affAfter / affBefore, token_saving_all: 1 - after / before, by_type: byType, e66 }, null, 1));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trimEvidenceTail } from './evidence-tail-trim.ts';
const fz = '/home/user/.capy/work/gbra162-counted/lme-frozen';
const blob = (h: string) => readFileSync(join(fz, 'blobs', h.slice(0, 2), h + '.txt'), 'utf8');
const ds = new Map((JSON.parse(readFileSync('/home/user/.capy/work/lme/longmemeval_s_cleaned.json', 'utf8')) as any[]).map(q => [q.question_id, q]));
const cases: Array<{ rows: any[]; q: string }> = [];
for (const line of readFileSync(join(fz, 'frozen-manifest.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  const score = new Map<string, number>();
  for (const h of o.hits5) score.set(h.slug, Math.max(score.get(h.slug) ?? -Infinity, h.score));
  cases.push({ rows: JSON.parse(blob(o.arms.auto.results)).map((r: any) => ({ ...r, score: score.get(r.slug) ?? Number.NaN })), q: ds.get(o.question_id).question });
}
const affected = cases.filter(c => trimEvidenceTail(c.rows, c.q).meta.dropped > 0);
const time = (f: () => void, n = 5) => { const t: number[] = []; for (let i = 0; i < n; i++) { const s = performance.now(); f(); t.push(performance.now() - s); } return t.sort((a, b) => a - b)[Math.floor(n / 2)]; };
const per = (ms: number, k: number) => (ms / k).toFixed(3);
const trimMs = time(() => { for (const c of affected) trimEvidenceTail(c.rows, c.q); });
const offBytes = affected.map(c => JSON.stringify(c.rows).length);
const onRows = affected.map(c => trimEvidenceTail(c.rows, c.q).results);
const onBytes = onRows.map(r => JSON.stringify(r).length);
const serOff = time(() => { for (const c of affected) JSON.stringify({ results: c.rows }, null, 2); });
const serOn = time(() => { for (const r of onRows) JSON.stringify({ results: r }, null, 2); });
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(JSON.stringify({ affected: affected.length, trim_ms_per_call: per(trimMs, affected.length), serialize_ms_off: per(serOff, affected.length), serialize_ms_on: per(serOn, affected.length),
  bytes_median_off: med(offBytes), bytes_median_on: med(onBytes), bytes_saved_share: 1 - onBytes.reduce((a, b) => a + b, 0) / offBytes.reduce((a, b) => a + b, 0) }));

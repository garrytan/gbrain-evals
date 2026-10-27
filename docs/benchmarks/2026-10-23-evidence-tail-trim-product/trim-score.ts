import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trimEvidenceTail } from './evidence-tail-trim.ts';
const base = '/home/user/.capy/work/gbra162-counted';
const fz = join(base, 'lme-frozen');
const blob = (h: string) => readFileSync(join(fz, 'blobs', h.slice(0, 2), h + '.txt'), 'utf8');
const ds = new Map((JSON.parse(readFileSync('/home/user/.capy/work/lme/longmemeval_s_cleaned.json', 'utf8')) as any[]).map(q => [q.question_id, q]));
const R2_PROTECTED = 3, FRAC = 0.5;
const cls = new Map<string, 'arm' | 'auto' | 'novel'>();
for (const line of readFileSync(join(fz, 'frozen-manifest.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  const score = new Map<string, number>();
  for (const h of o.hits5) score.set(h.slug, Math.max(score.get(h.slug) ?? -Infinity, h.score));
  const rows = JSON.parse(blob(o.arms.auto.results)).map((r: any) => ({ ...r, score: score.get(r.slug) ?? Number.NaN }));
  const top = rows[0]?.score;
  const armDrops = rows.filter((r: any, i: number) => i >= R2_PROTECTED && r.score < FRAC * top).map((r: any) => r.slug);
  if (armDrops.length === 0) continue;
  const kept = new Set(trimEvidenceTail(rows, ds.get(o.question_id).question).results.map((r: any) => r.slug));
  const ours = rows.filter((r: any) => !kept.has(r.slug)).map((r: any) => r.slug);
  cls.set(o.question_id, ours.length === 0 ? 'auto' : ours.join() === armDrops.join() ? 'arm' : 'novel');
}
const count: Record<string, number> = {};
for (const c of cls.values()) count[c] = (count[c] ?? 0) + 1;
const load = (p: string) => { const m = new Map<string, number>(); try { for (const l of readFileSync(p, 'utf8').split('\n')) if (l) { const o = JSON.parse(l); m.set(o.question_id, Number(o.official_correct) === 1 ? 1 : 0); } } catch { return null; } return m; };
const cells: Record<string, [string, string]> = {
  'sonnet-5-5': ['lme-answers/rows/auto__s{S}__claude-sonnet-5-5.ndjson', 'a2-answers/rows/r2_tail_trim__s{S}__claude-sonnet-5-5.ndjson'],
  'gpt-6.1-sol': ['a2-harm/rows/auto__s{S}__gpt-6.1-sol.ndjson', 'a2-harm/rows/r2_tail_trim__s{S}__gpt-6.1-sol.ndjson'],
  'opus-5-5': ['a2-harm/rows/auto__s{S}__claude-opus-5-5.ndjson', 'a2-harm/rows/r2_tail_trim__s{S}__claude-opus-5-5.ndjson'],
};
const out: any = { classes: count, novel: [...cls].filter(([, c]) => c === 'novel').map(([q]) => q), models: {} };
for (const [model, [a, t]] of Object.entries(cells)) {
  let auto = 0, arm = 0, guardLo = 0, guardHi = 0, n = 0, missing = 0;
  for (const S of ['1', '2']) {
    const A = load(join(base, a.replace('{S}', S))), T = load(join(base, t.replace('{S}', S)));
    if (!A || !T) continue;
    for (const [q, c] of cls) {
      const av = A.get(q), tv = T.get(q);
      if (av === undefined || tv === undefined) { missing++; continue; }
      n++; auto += av; arm += tv;
      if (c === 'arm') { guardLo += tv; guardHi += tv; } else if (c === 'auto') { guardLo += av; guardHi += av; } else { guardLo += Math.min(av, tv); guardHi += Math.max(av, tv); }
    }
  }
  out.models[model] = { rows: n, missing, auto: auto / 2, arm: arm / 2, guarded_min: guardLo / 2, guarded_max: guardHi / 2 };
}
console.log(JSON.stringify(out, null, 1));

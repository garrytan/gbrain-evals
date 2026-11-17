import { readFileSync } from 'node:fs';
import { r1, rbRenderer } from '/workspace/gbrain-evals/eval/runner/batch/w10.ts';
import { houseNotesText, loadDataset, parseSessionBlocks, readNdjson } from '/workspace/gbrain-evals/eval/runner/batch/sources.ts';
const ds = loadDataset(process.env.LME_DATASET!);
const r = await rbRenderer();
const idx = (qid: string) => { const q:any = ds.get(qid)!; return new Map(r.haystackToPages(q).map((p:any, i:number) => [r.sessionIdFromSlug(p.slug), i])); };
const check = (label: string, items: Array<{ qid: string; system: string; user: string }>) => {
  let same = 0, sys = 0, diff: string[] = [];
  for (const it of items) {
    const m = idx(it.qid);
    const indices = parseSessionBlocks(it.user).map(b => m.get(b.id)!);
    const t = houseNotesText(ds.get(it.qid)!, indices, r);
    if (t.user === it.user) same++; else diff.push(it.qid);
    if (t.system === it.system) sys++;
  }
  console.log(JSON.stringify({ label, n: items.length, user_identical: same, system_identical: sys, diff: diff.slice(0, 10) }));
};
const G = '/workspace/gbrain-evals/docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture/';
const rows = readNdjson(G + 'harness-rows.ndjson.gz').filter(x => typeof x.question_id === 'string');
const caps = new Map(readNdjson(G + 'captures.ndjson.gz').map(c => [c.question + '\u0000' + c.question_date, c]));
check('w10a capture (c5fb0201)', rows.map(x => { const q:any = ds.get(x.question_id)!; const c:any = caps.get(q.question + '\u0000' + q.question_date); return { qid: x.question_id, system: c.system, user: c.user }; }));
check('r1 replay (a7cb37b, W10b)', [...r1().values()].map(x => ({ qid: x.question_id, system: x.system, user: x.user })));

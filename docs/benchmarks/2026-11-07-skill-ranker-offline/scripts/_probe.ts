import { readJsonl } from './lib.ts';
import { bm25Index, rankBm25, rankA2, view, lex, type Skill } from './rank.ts';
const all = readJsonl<Skill>('data/catalog.jsonl');
const dev = readJsonl<any>('data/dev.jsonl');
const cat = view(all, 750, 'D');
const ix = bm25Index(cat, ['name','description']);
const p = { k1: 1.6, b: 0.75, w: { name: 2, description: 1, triggers: 0, routing: 0, body: 0 } };
const rows = dev.map(t => { const r = rankBm25(cat, ix, t.text, p); const raw = r.order.length ? r.norm[r.order[0]] : 0; return { cls: t.acceptable.length ? 'skill' : 'nsn', n: r.top.toFixed(3), qlen: lex(t.text).length, a2: rankA2(cat, t.text).top.toFixed(2) }; });
for (const c of ['skill','nsn']) console.log(c, rows.filter(r=>r.cls===c).map(r=>r.n+'/'+r.qlen+'/'+r.a2).join(' '));

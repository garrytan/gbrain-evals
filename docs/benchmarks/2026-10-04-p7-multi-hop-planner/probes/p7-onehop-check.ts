// One-hop relational questions must stay not_applicable (the planner must not change or suppress one-hop retrieval).
const EVALS = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
const { parseRelationalPlan } = await import(`${process.argv[2] ?? '../gbrain'}/src/core/search/relational-plan.ts`);
const { loadWorldCorpus, buildRelationalQueries } = await import(EVALS + '/eval/runner/queries/relational.ts');
const qs = buildRelationalQueries(loadWorldCorpus(EVALS + '/eval/data/world-v1')).map((q: any) => q.text);
const para = JSON.parse(await Bun.file(EVALS + '/eval/data/relational-paraphrase-v1/paraphrases.json').text());
const ptexts: string[] = [];
const walk = (x: any) => { if (typeof x === 'string') return; if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (typeof v === 'string' && /\?|^(who|which|what)/i.test(v) && v.length < 300 && !/^[a-z0-9_-]+$/.test(v)) ptexts.push(v); else walk(v); } };
walk(para);
for (const [name, set] of [['relational-ab templates', qs], ['relational-paraphrase-v1', ptexts]] as const) {
  const t: Record<string, number> = {}; const bad: string[] = [];
  for (const q of set) { const r = parseRelationalPlan(q); t[r.kind] = (t[r.kind] ?? 0) + 1; if (r.kind !== 'not_applicable') bad.push(`${r.kind} ${(r as any).reason ?? ''} | ${q}`); }
  console.log(name, set.length, JSON.stringify(t)); for (const b of bad.slice(0, 15)) console.log('  ', b);
}

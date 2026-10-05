// Re-score the grammar on stored D2 paraphrases (no API calls).
const [ROOT, FILE] = process.argv.slice(2);
const { parseRelationalPlan } = await import(ROOT + '/src/core/search/relational-plan.ts');
const d = JSON.parse(await Bun.file(FILE).text());
const FAM: Record<string, { hops: Array<[string, string]>; excl: boolean }> = {
  'investor->founders': { hops: [['invested_in', 'object'], ['founded', 'subject']], excl: false },
  'advisor->founders': { hops: [['advises', 'object'], ['founded', 'subject']], excl: false },
  'founder->investors': { hops: [['founded', 'object'], ['invested_in', 'subject']], excl: false },
  'co-investors': { hops: [['invested_in', 'object'], ['invested_in', 'subject']], excl: true },
  'founder->other-portfolio': { hops: [['founded', 'object'], ['invested_in', 'subject'], ['invested_in', 'object']], excl: true },
};
const tally: Record<string, number> = {};
for (const r of d.rows) {
  const f = FAM[r.fam]; const g = parseRelationalPlan(r.text);
  let k: string = g.kind;
  if (g.kind === 'plan') k = g.plan.hops.length === f.hops.length && g.plan.hops.every((h: any, i: number) => h.toward === f.hops[i][1] && h.linkTypes.includes(f.hops[i][0])) && g.plan.excludeAnchor === f.excl ? 'correct' : 'wrong';
  tally[k] = (tally[k] ?? 0) + 1;
  if (k !== 'correct' && process.env.V) console.log(k, (g as any).reason ?? (g.kind === 'plan' ? JSON.stringify(g.plan.hops.map((h: any) => [h.linkTypes[0], h.toward])) + ' anchor=' + g.plan.anchor : ''), '|', r.text);
}
console.log(JSON.stringify(tally));

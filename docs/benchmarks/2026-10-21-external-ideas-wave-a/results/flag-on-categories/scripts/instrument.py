
p='/home/user/.capy/work/gbra162-flagcheck/gbrain-flagon/src/core/search/evidence-delivery.ts'
s=open(p).read()
old="""  const first = await deliverEvidenceOnce(engine, hits, plan, scope, opts);
  return plan.resolveDates ? withRelativeDates(first, budgetTokens => deliverEvidenceOnce(engine, hits, { ...plan, budgetTokens }, scope, opts),
    ids => loadPageObservationDays(engine, ids), r => conversationSignal(r) !== null, text => countEvidenceTokens(text, evidenceTokenizer())) : first;"""
new="""  const first = await deliverEvidenceOnce(engine, hits, plan, scope, opts);
  const out = plan.resolveDates ? await withRelativeDates(first, budgetTokens => deliverEvidenceOnce(engine, hits, { ...plan, budgetTokens }, scope, opts),
    ids => loadPageObservationDays(engine, ids), r => conversationSignal(r) !== null, text => countEvidenceTokens(text, evidenceTokenizer())) : first;
  if (process.env.GBRAIN_FLAGCHECK_LOG) (await import('node:fs')).appendFileSync(process.env.GBRAIN_FLAGCHECK_LOG, JSON.stringify({ argv: process.argv.slice(1, 3).join(' '), unit: plan.unit, results: out.results.length, conversation_results: out.results.filter(r => conversationSignal(r) !== null).length, insertions: out.delivery.relative_dates?.insertions ?? null, fallbacks: out.delivery.fallbacks.filter(f => f.startsWith('relative_dates')) }) + '\\n');
  return out;"""
assert old in s
open(p,'w').write(s.replace(old,new))

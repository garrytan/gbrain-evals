// Keyless re-delivery of the committed LongMemEval-S frozen hit lists (evidence-delivery and evidence-auto-v2)
// through one gbrain build's assembleEvidenceForHits. Run once per build; diff the two outputs.
//   bun redeliver.ts <gbrainDir> <dataset.json> <out.ndjson> [--limit N]
// Work dir: FLAGCHECK_DIR (default <repo>/.flagcheck), holding frozen/ed and frozen/v2.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGbrain } from '../../../../../../eval/runner/evidence-delivery/gbrain.ts';
import { readFrozen } from '../../../../../../eval/runner/evidence-delivery/store.ts';

const [dir, datasetPath, outPath] = process.argv.slice(2);
const limitAt = process.argv.indexOf('--limit');
const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const W = process.env.FLAGCHECK_DIR || join(import.meta.dir, '../../../../../../.flagcheck');
const ed = readFrozen(join(W, 'frozen/ed'));
const v2 = readFrozen(join(W, 'frozen/v2'));
const ED_ARMS = [
  { id: 'window1', unit: 'window', return_window: 1, budget_tokens: 6000 },
  { id: 'window2', unit: 'window', return_window: 2, budget_tokens: 6000 },
  { id: 'section', unit: 'section', budget_tokens: 6000 },
  { id: 'page', unit: 'page', budget_tokens: 100000 },
  { id: 'auto4k', unit: 'auto', budget_tokens: 4000 },
  { id: 'auto6k', unit: 'auto', budget_tokens: 6000 },
  { id: 'auto7_5k', unit: 'auto', budget_tokens: 7500 },
];
const V2_ARMS = [
  { id: 'auto', unit: 'auto', budget_tokens: null },
  { id: 'page', unit: 'page', budget_tokens: 100000 },
];
const dataset = new Map((JSON.parse(readFileSync(datasetPath, 'utf8')) as any[]).map(q => [q.question_id, q]));
const g = await loadGbrain(dir, { requireEvidence: true });
const engine = await g.harness.createBenchmarkBrain();
if (!existsSync(outPath)) writeFileSync(outPath, '');
const done = new Set(readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).question_id));
const ids = [...ed.questions.keys()].sort().slice(0, limit);
for (const id of ids) {
  if (done.has(id)) continue;
  const d = dataset.get(id);
  await g.harness.resetTables(engine);
  for (const p of g.adapter.haystackToPages(d)) await g.importFile.importFromContent(engine, p.slug, p.content, { noEmbed: true });
  const chunksBySlug = new Map<string, any[]>();
  const resolveHits = async (hits: any[]) => {
    const out: any[] = [];
    let textOk = true;
    for (const h of hits) {
      if (!chunksBySlug.has(h.slug)) chunksBySlug.set(h.slug, await engine.getChunks(h.slug));
      const c = chunksBySlug.get(h.slug)!.find((x: any) => x.chunk_index === h.chunk_index);
      if (!c || sha(c.chunk_text) !== h.text) textOk = false;
      out.push({ source_id: 'default', slug: h.slug, chunk_id: c?.id ?? -1 });
    }
    return { hits: out, textOk };
  };
  const row: Record<string, unknown> = { question_id: id, question_type: d.question_type };
  const run = async (label: string, hits: any[], arm: any, remote: boolean) => {
    try {
      const out = await g.evidence!.assembleEvidenceForHits(engine, { hits, return_unit: arm.unit, ...(arm.return_window ? { return_window: arm.return_window } : {}), ...(arm.budget_tokens !== null ? { budget_tokens: arm.budget_tokens } : {}), caller: { remote } });
      const dm: any = out.delivery ?? {};
      const res = out.results as any[];
      row[label] = {
        fingerprint: g.evidence!.evidenceFingerprint(res),
        text_sha256: sha(JSON.stringify(res.map(r => [r.slug, r.chunk_text]))),
        results: res.length,
        tokens: res.reduce((s, r) => s + (r.delivered?.tokens ?? 0), 0),
        chars: res.reduce((s, r) => s + String(r.chunk_text ?? '').length, 0),
        reasons: res.map(r => r.delivered?.reason ?? null),
        unresolved: out.unresolved?.length ?? 0,
        delivery: { budget_tokens: dm.budget_tokens, budget_used: dm.budget_used, tokens_delivered: dm.tokens_delivered, blocks: dm.blocks, dropped: dm.dropped, dropped_reasons: dm.dropped_reasons, fallbacks: dm.fallbacks, relative_dates: dm.relative_dates ?? null, applied_unit: dm.applied_unit },
      };
    } catch (e: any) { row[label] = { error: String(e?.message ?? e).slice(0, 300) }; }
  };
  const e = await resolveHits(ed.questions.get(id)!.hits5);
  row.ed_hits_text_ok = e.textOk;
  for (const arm of ED_ARMS) await run('ed:' + arm.id, e.hits, arm, false);
  const v = await resolveHits(v2.questions.get(id)!.hits5);
  row.v2_hits_text_ok = v.textOk;
  for (const arm of V2_ARMS) { await run('v2:' + arm.id, v.hits, arm, false); await run('v2:' + arm.id + ':remote', v.hits, arm, true); }
  appendFileSync(outPath, JSON.stringify(row) + '\n');
}
await engine.disconnect();
console.log(JSON.stringify({ done: ids.length, out: outPath }));

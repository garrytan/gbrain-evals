/** Inputs for the payload bar X, from M records only (no F2 numbers): chars per token of recorded search results
 * (gbrain's own cl100k counter), effective $ per input-side token per model (usage x price table), and the share of
 * agent cost spent re-reading search results in the F2 arm's cells (gbrain, H2-H4). */
import { readFileSync } from 'node:fs';
const { countEvidenceTokens } = await import('/workspace/gbrain/src/core/search/evidence-delivery.ts');
const W = `${process.env.HOME}/.capy/work`;
const PRICE: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },   // gbrain-evals eval/runner/budget-ledger.ts:1111
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },       // :1114
  'gpt-6.1-sol': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },         // :1134 (short-context tier)
};
const tr = new Map<string, any[]>();
for (const l of readFileSync(`${W}/confirm/main/cells/transcripts.jsonl`, 'utf8').split('\n')) if (l) { const t = JSON.parse(l); tr.set(t.attempt_id, t.tools); }
let ch = 0, tk = 0;
for (const tools of tr.values()) for (const x of tools) if ((x.name === 'search' || x.name === 'query') && x.result && x.result.length < 40000) { ch += x.result.length; tk += countEvidenceTokens(x.result, 'cl100k'); }
const k = ch / tk;
const agg: Record<string, { cost: number; inCost: number; inTok: number; readTok: number; cells: number; searchChars: number }> = {};
for (const l of readFileSync(`${W}/confirm/main/cells/attempts.jsonl`, 'utf8').split('\n')) {
  if (!l) continue;
  const r = JSON.parse(l);
  if (r.stop === 'harness_error' || !r.arm.startsWith('gbrain') || !['H2', 'H3', 'H4'].includes(r.family)) continue;
  const p = PRICE[r.model]; const a = (agg[r.model] ??= { cost: 0, inCost: 0, inTok: 0, readTok: 0, cells: 0, searchChars: 0 }); a.cells++;
  for (const s of r.sessions) {
    const u = s.run.usage, calls = s.run.tool_calls as Array<{ name: string; chars: number }>;
    a.cost += s.run.usd;
    a.inCost += (u.input * p.input + u.cache_read * p.cache_read + u.cache_write * p.cache_write) / 1e6;
    a.inTok += u.input + u.cache_read + u.cache_write;
    const req = Math.max(1, u.requests);
    calls.forEach((c, i) => {   // call i is answered in request floor(i * (req-1) / n) + 1 and re-read by every later request
      const at = Math.floor(i * Math.max(1, req - 1) / Math.max(1, calls.length)) + 1;
      if (c.name === 'search' || c.name === 'query') { a.readTok += (c.chars / k) * Math.max(1, req - at); a.searchChars += c.chars; }
    });
  }
}
let cost = 0, readCost = 0;
for (const [m, a] of Object.entries(agg)) {
  const perTok = a.inCost / a.inTok;
  cost += a.cost; readCost += perTok * a.readTok;
  console.log(`${m}: ${a.cells} cells, agent $${a.cost.toFixed(2)}, input-side $${a.inCost.toFixed(2)} over ${(a.inTok / 1e6).toFixed(1)}M tokens = $${(perTok * 1e6).toFixed(3)}/M; search-result re-reads ${(a.readTok / 1e6).toFixed(1)}M tokens (${(100 * a.readTok / a.inTok).toFixed(1)}% of input-side tokens) = $${(perTok * a.readTok).toFixed(2)}`);
}
console.log(`chars per cl100k token, recorded search results: ${k.toFixed(3)} (${ch} chars)`);
console.log(`share of agent cost spent re-reading search results (H2-H4 gbrain arm): ${(100 * readCost / cost).toFixed(1)}%`);
console.log(`headroom: per-arm cap 1.15 x price -> 15.0%; X = 15.0% / share = ${(15 * cost / readCost).toFixed(1)}%`);

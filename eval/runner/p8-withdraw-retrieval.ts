/** Neighbour retrieval for withdrawal-review families: cosine of the withdrawn claim and each candidate (text-embedding-3-large, 1536 dims) against the review lane's 0.80 floor, per slice. Usage: bun eval/runner/p8-withdraw-retrieval.ts <pairs.jsonl> */
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2]!, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const texts = [...new Set(rows.flatMap((r: any) => [r.fact, r.candidate]))];
const emb = new Map<string, number[]>();
for (let i = 0; i < texts.length; i += 256) {
  const batch = texts.slice(i, i + 256);
  const res = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: 'text-embedding-3-large', input: batch, dimensions: 1536 }) });
  const j: any = await res.json();
  j.data.forEach((d: any, k: number) => emb.set(batch[k]!, d.embedding));
}
const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
const by: Record<string, { n: number; hit: number; cos: number[] }> = {};
for (const r of rows) { const c = cos(emb.get(r.fact)!, emb.get(r.candidate)!); const s = r.slice.replace(/\d$/, ''); by[s] ??= { n: 0, hit: 0, cos: [] }; by[s].n++; if (c >= 0.8) by[s].hit++; by[s].cos.push(c); }
for (const [s, v] of Object.entries(by)) { v.cos.sort((a, b) => a - b); console.log(s.padEnd(12), `retrieved ${v.hit}/${v.n} (${(100 * v.hit / v.n).toFixed(1)}%)`, `median cos ${v.cos[Math.floor(v.cos.length / 2)]!.toFixed(3)}`, `p10 ${v.cos[Math.floor(v.cos.length / 10)]!.toFixed(3)}`); }

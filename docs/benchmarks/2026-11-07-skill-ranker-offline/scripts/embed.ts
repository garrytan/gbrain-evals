/**
 * Embed every catalog skill ("name: description") and every turn for A6
 * (nomic-embed-text on a localhost Ollama server) and A7 (OpenAI
 * text-embedding-3-small). Vectors are unit-normalized and cached under
 * cache/ (not committed; A7 costs about $0.01 to regenerate).
 *
 *   bun scripts/embed.ts local|openai
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, localEmbed, openaiEmbed, readJsonl, spent } from './lib.ts';

const which = process.argv[2];
if (which !== 'local' && which !== 'openai') throw new Error('usage: embed.ts local|openai');
const skills = readJsonl<{ id: string; name: string; description: string }>(join(DIR, 'data/catalog.jsonl'));
const turns = ['dev', 'test', 'stress-dev', 'stress-test'].flatMap(f => readJsonl<{ id: string; text: string }>(join(DIR, `data/${f}.jsonl`)));
const docs = skills.map(s => `${s.name}: ${s.description}`);
const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const t0 = performance.now();
const [sv, tv] = which === 'local'
  ? [await localEmbed(docs.map(d => `search_document: ${d}`)), await localEmbed(turns.map(t => `search_query: ${t.text}`))]
  : [await openaiEmbed('embed:skills', docs), await openaiEmbed('embed:turns', turns.map(t => t.text))];
const ms = performance.now() - t0;
const enc = (v: number[]) => Buffer.from(new Float32Array(unit(v)).buffer).toString('base64');
mkdirSync(join(DIR, 'cache'), { recursive: true });
writeFileSync(join(DIR, `cache/emb-${which}.json`), JSON.stringify({
  skills: Object.fromEntries(skills.map((s, i) => [s.id, enc(sv[i])])),
  turns: Object.fromEntries(turns.map((t, i) => [t.id, enc(tv[i])])),
}));
console.log(`${which}: ${sv.length} skills, ${tv.length} turns, dim ${sv[0].length}, ${(ms / 1000).toFixed(1)} s; ledger $${spent().toFixed(4)}`);

#!/usr/bin/env bun
/**
 * The relation gbrain's parser chooses for each question in Query-shaped JSONL
 * files, read from a gbrain checkout (the N9 relational meta carries the parse
 * shape, not the relation). Output: { [query id]: { kind, linkTypes, phrase } | null }.
 *
 *   bun eval/runner/parse-relational-questions.ts <gbrain-checkout> <questions.jsonl>... > relations.json
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [tree, ...files] = process.argv.slice(2);
if (!tree || files.length === 0) { console.error('usage: parse-relational-questions.ts <gbrain-checkout> <questions.jsonl>...'); process.exit(2); }
const { parseRelationalQuery } = await import(resolve(tree, 'src/core/search/relational-intent.ts')) as {
  parseRelationalQuery: (q: string) => { kind: string; linkTypes: string[] | null; relationPhrase: string } | null };
const out: Record<string, unknown> = {};
for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n').filter(l => l.trim())) {
  const q = JSON.parse(line) as { id: string; text: string };
  const p = parseRelationalQuery(q.text);
  out[q.id] = p ? { kind: p.kind, linkTypes: p.linkTypes, phrase: p.relationPhrase } : null;
}
console.log(JSON.stringify(out, null, 1));

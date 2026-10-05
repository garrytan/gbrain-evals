import { readFileSync, writeFileSync } from 'node:fs';
const gbrain = process.env.GBRAIN_DIR;
if (!gbrain) throw new Error('set GBRAIN_DIR to a gbrain checkout (c9ba77823 for the old rule, 67c4ff27b for the end rule)');
const { PGLiteEngine } = await import(`${gbrain}/src/core/pglite-engine.ts`);
const { buildGazetteer, findMentionedEntities } = await import(`${gbrain}/src/core/by-mention.ts`);
const names = ['지원','민준','서연','지민','수빈','하은','도윤','서준','유진','민서','현우','지훈','은지','성민','영수','정민','하늘','보람','한결','장인','인하','미래','우리','김지원','이민준','박서연','최현우','정하은','한빛전자','예시카드'];
const corpus = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Record<string, string[]>;
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
for (const [i, n] of names.entries()) await engine.putPage(`people/n${i}`, { type: 'person', title: n, compiled_truth: '', timeline: '', frontmatter: {} });
const gaz = await buildGazetteer(engine);
const out: unknown[] = [];
for (const [genre, docs] of Object.entries(corpus)) {
  for (const [d, doc] of docs.entries()) {
    const found = new Set<string>();
    // findMentionedEntities dedups per target; scan sentence-sized windows to see every occurrence
    for (const piece of doc.split(/(?<=[.!?\n])/u)) {
      for (const m of findMentionedEntities(piece, gaz, { fromSlug: 'notes/x', fromSourceId: 'default' })) {
        const off = doc.indexOf(piece) + m.offset;
        const key = `${off}`; if (found.has(key)) continue; found.add(key);
        const name = names[Number(m.slug.slice(8))]!;
        out.push({ genre, doc: d, name, before: doc.slice(Math.max(0, off - 40), off), after: doc.slice(off + name.length, off + name.length + 40) });
      }
    }
  }
}
writeFileSync(process.argv[3]!, out.map(o => JSON.stringify(o)).join('\n'));
console.log(out.length);
await engine.disconnect();

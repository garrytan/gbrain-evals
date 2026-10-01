const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { gradeRetrievalConfidence } = await import(`${G}/search/crag.ts`);
const { reduceAnswerable } = await import(`${G}/ai/decide/answerable.ts`);
const cases: Record<string, any[]> = {
  "exact title match, chunk has no answer text": [{ slug: "people/alice", evidence: "exact_title_match", chunk_text: "Alice is a person." }],
  "exact_lookup set": [{ slug: "people/alice", exact_lookup: "title", evidence: "exact_title_match" }],
  "keyword_exact top, no reranker": [{ slug: "x", evidence: "keyword_exact" }],
  "weak_semantic top": [{ slug: "x", evidence: "weak_semantic" }],
  "rerank 0.19": [{ slug: "x", rerank_score: 0.19 }],
  "zero results": [],
};
for (const [k, v] of Object.entries(cases)) console.log("grade", JSON.stringify(k), "->", JSON.stringify(gradeRetrievalConfidence(v)));
const pol = { threshold: 0.5, margin: 0.1 };
console.log("S4 reduce p=0.02 complete, identityHit -> ", reduceAnswerable(0.02, pol, { complete: true, identityHit: true, strongGrade: false }));
console.log("S4 reduce p=0.02 complete, strongGrade -> ", reduceAnswerable(0.02, pol, { complete: true, identityHit: false, strongGrade: true }));
console.log("S4 reduce p=0.02 complete, no signals -> ", reduceAnswerable(0.02, pol, { complete: true, identityHit: false, strongGrade: false }));
console.log("S4 reduce p=0.02 incomplete -> ", reduceAnswerable(0.02, pol, { complete: false, identityHit: false, strongGrade: false }));

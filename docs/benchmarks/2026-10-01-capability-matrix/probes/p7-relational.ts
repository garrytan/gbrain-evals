const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { parseRelationalQuery } = await import(`${G}/search/relational-intent.ts`);
for (const q of ["Who works at Acme?", "Which people work for companies backed by Fund Example?", "Which employers have staff who advise Acme?", "Who invested in Acme?", "What connects Fund Example and Acme?"])
  console.log(JSON.stringify(q), "->", JSON.stringify(parseRelationalQuery(q)));

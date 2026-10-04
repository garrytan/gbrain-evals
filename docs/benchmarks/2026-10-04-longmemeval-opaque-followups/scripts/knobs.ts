// Usage: bun knobs.ts <gbrain-src-dir> '<json arms>'
const dir = process.argv[2];
const m = await import(`${dir}/src/core/search/mode.ts`);
const arms = JSON.parse(process.argv[3]);
const out: Record<string, unknown> = {};
for (const [name, a] of Object.entries<any>(arms)) {
  const snapshot = a.pins ?? {};
  const knobs = m.resolveSearchMode({ mode: a.mode, overrides: m.loadOverridesFromConfig(snapshot), perCall: { expansion: a.expansion, ...(a.budget !== undefined ? { expansion_variant_budget: a.budget } : {}), reranker_enabled: a.reranker, autocut: a.autocut } });
  out[name] = { knobs_hash: m.knobsHash(knobs), version: m.KNOBS_HASH_VERSION, knobs };
}
console.log(JSON.stringify(out));

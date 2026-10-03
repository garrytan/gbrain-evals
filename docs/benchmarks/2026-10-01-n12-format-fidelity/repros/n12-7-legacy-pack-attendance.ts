// N12-7: with no schema_pack configured (bundled legacy gbrain-base), a person only mentioned on a meeting page is typed attended.
// With gbrain-base-v2 (what gbrain init writes) the same page yields mentions. Prints both; exit 1 when the legacy arm types the mention attended.
const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { PGLiteEngine } = await import(`${G}/pglite-engine.ts`);
const { operations } = await import(`${G}/operations.ts`);
const page = "---\ntype: meeting\ntitle: Sync\ndate: 2026-04-01\n---\n# Sync\n\n## Attendees\n\n- [[people/alice-example|Alice Example]]\n\n## Notes\n\n[[people/bob-example|Bob Example]] will send the deck.\n";
async function arm(pack: string | null) {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  if (pack) await engine.setConfig("schema_pack", pack);
  const ctx = { engine, config: { engine: "pglite" }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: "default" };
  const op = (n: string, p: any) => operations.find((o: any) => o.name === n).handler(ctx, p);
  for (const [slug, name] of [["people/alice-example", "Alice Example"], ["people/bob-example", "Bob Example"]]) await op("put_page", { slug, content: `---\ntype: person\ntitle: ${name}\n---\n# ${name}\n` });
  await op("put_page", { slug: "meetings/sync", content: page });
  const links = [...await op("get_links", { slug: "meetings/sync" }), ...await op("get_backlinks", { slug: "meetings/sync" })];
  await engine.disconnect();
  return links.filter((l: any) => l.link_type === "attended").map((l: any) => (l.from_slug === "meetings/sync" ? l.to_slug : l.from_slug)).sort();
}
const legacy = await arm(null), v2 = await arm("gbrain-base-v2");
console.log(JSON.stringify({ attended_legacy_pack: legacy, attended_gbrain_base_v2: v2, expected: ["people/alice-example"] }));
process.exit(legacy.includes("people/bob-example") ? 1 : 0);

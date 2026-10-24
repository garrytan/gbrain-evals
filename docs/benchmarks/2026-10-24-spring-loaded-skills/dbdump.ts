// Dumps every page of a PGLite brain as JSON, read with the checkout's own PGLite.
// bun dbdump.ts <gbrain checkout> <brain.pglite dir>
const [checkout, dataDir] = process.argv.slice(2);
const { PGlite } = await import(checkout + '/node_modules/@electric-sql/pglite/dist/index.js');
const db = await PGlite.create(dataDir);
const r = await db.query('select source_id, slug, type, title, compiled_truth, timeline, frontmatter, deleted_at, updated_at from pages order by source_id, slug');
console.log(JSON.stringify(r.rows.map((x: any) => ({ source_id: x.source_id, slug: x.slug, type: x.type, title: x.title, body: x.compiled_truth + (x.timeline ? '\n\n## Timeline\n\n' + x.timeline : ''), frontmatter: x.frontmatter, deleted: x.deleted_at != null, updated_at: x.updated_at }))));
await db.close();

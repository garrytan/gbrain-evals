/** Shared helper for the N8 repros: an in-memory brain with one private and one public person. */
export const G = new URL('../../../../node_modules/gbrain/src/core', import.meta.url).pathname;
export async function brain() {
  const { PGLiteEngine } = await import(`${G}/pglite-engine.ts`);
  const { operations } = await import(`${G}/operations.ts`);
  const { importFromContent } = await import(`${G}/import-file.ts`);
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const page = (title: string, vis: string, aliases: string[], body: string, type = 'person') => `---\ntype: ${type}\ntitle: ${JSON.stringify(title)}\nvisibility: ${vis}\naliases: ${JSON.stringify(aliases)}\n---\n\n${body}\n`;
  await importFromContent(engine, 'people/zora-quillfeather', page('Zora Quillfeather', 'private', ['Zee'], 'Zora Quillfeather is a confidential contact, code PRIVMARK-1.'), { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, 'companies/harbor-logistics', page('Harbor Logistics', 'world', ['Harbor'], 'Harbor Logistics is a shipping partner.', 'company'), { sourceId: 'default', noEmbed: true });
  const op = (name: string, params: Record<string, unknown>, remote: boolean) => operations.find((o: any) => o.name === name).handler({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote, sourceId: 'default' }, params);
  return { engine, op };
}

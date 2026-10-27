// F5 messy-company-v1 gate: build the brain per DECISION-RULE.md (scratch, not in any repo).
import { writeFileSync, existsSync } from 'node:fs';
const G = `${process.env.HOME}/.capy/work/f5-messy/gbrain/src`;
const { setCliOptions } = await import(`${G}/core/cli-options.ts`);
const { PGLiteEngine } = await import(`${G}/core/pglite-engine.ts`);
const { extractStaleFromDB } = await import(`${G}/commands/extract.ts`);
const { privateLinkOriginFilterFragment, privatePagesFilterFragment } = await import(`${G}/core/search/private-visibility.ts`);
const { loadSplit } = await import(`${process.env.HOME}/.capy/work/f5-messy/evals/eval/runner/messy-company/load.ts`);
const DB = `${process.env.HOME}/.capy/work/f5-messy/brain`;
if (existsSync(DB)) { console.error('brain exists; refusing'); process.exit(1); }
setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
const engine = new PGLiteEngine();
await engine.connect({ database_path: DB } as never);
await engine.initSchema();
await engine.setConfig('mentions.owner_phrases', 'true');
const { report } = await loadSplit('all', { engine });
console.log('load', JSON.stringify(report));
const sweeps = [];
for (let i = 0; i < 20; i++) {
  const t = Date.now();
  const r = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
  const o = r.mentions?.ownerPhrases;
  const s = { i, ms: Date.now() - t, mentions_state: r.mentions?.state, mentions_remaining: r.mentions?.remaining, owner: o };
  sweeps.push(s); console.log('sweep', JSON.stringify(s));
  if (i > 0 && (r.mentions?.remaining ?? 0) === 0 && o && o.scanned === 0 && o.created === 0 && o.removed === 0) break;
}
const q = (extra: string) => engine.executeRaw(`SELECT f.slug AS doc, t.slug AS account, l.context, l.link_source, o.slug AS origin FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
  LEFT JOIN pages o ON o.id = l.origin_page_id WHERE l.link_kind = 'owner_phrase' ${extra} ORDER BY 1, 2`);
const trusted = await q('');
const remote = await q(`AND ${privateLinkOriginFilterFragment('l')} AND ${privatePagesFilterFragment('f')} AND ${privatePagesFilterFragment('t')}`);
const windows = await engine.executeRaw(`SELECT group_key, account_slugs, owner_name, valid_from::text AS f, valid_to::text AS t, start_known, evidence FROM owner_phrase_windows ORDER BY group_key, valid_from NULLS FIRST`);
const status = await engine.executeRaw(`SELECT * FROM owner_phrase_status`);
const pages = await engine.executeRaw(`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
const cfg = await engine.getConfig('mentions.owner_phrases');
writeFileSync(`${process.env.HOME}/.capy/work/f5-messy/brain-export.json`, JSON.stringify({ pages, config_owner_phrases: cfg, sweeps, trusted, remote, windows, status }, null, 1));
console.log('export', JSON.stringify({ pages, cfg, trusted: trusted.length, remote: remote.length, windows: windows.length }));
await engine.disconnect();

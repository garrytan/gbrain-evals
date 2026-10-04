// Fix wave 8 #5831: facts with no entity no longer count as pending consolidation, because consolidation never reads
// them. Two facts saved with `gbrain remember` (one with an entity, one without); the pending count comes from
// `gbrain recall --pending --json` and from the MCP `recall` tool with include_pending over stdio.
// Both facts stay listed. Exit 0 when every preregistered expectation holds (item D2).
import { finish, gbrain, keylessHome, mcpSession } from './lib.ts';

const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const noEntity = await gbrain(['remember', 'The example vendor review moved to Friday', '--provenance', 'w8f1-check'], h.env);
const withEntity = await gbrain(['remember', 'Alice Example prefers tea', '--provenance', 'w8f1-check', '--entity', 'people/alice-example'], h.env);
const cli = await gbrain(['recall', '--pending', '--json'], h.env);
let cj: any = null;
try { cj = JSON.parse(cli.stdout.slice(cli.stdout.indexOf('{'))); } catch { /* reported below */ }
const mcp = await mcpSession(h.env, h.home);
const m = await mcp.call('recall', { include_pending: true });
await mcp.close();
h.cleanup();
let mj: any = null;
try { mj = JSON.parse(m.text.slice(m.text.indexOf('{'))); } catch { /* reported below */ }
const texts = (cj?.facts ?? []).map((f: any) => f.fact);
finish('pending-count-5831', {
  setup_ok: noEntity.code === 0 && withEntity.code === 0 && cli.code === 0,
  D2_both_facts_still_listed: texts.includes('The example vendor review moved to Friday') && texts.includes('Alice Example prefers tea'),
  D2_cli_pending_count_excludes_no_entity_fact: cj?.pending_consolidation_count === 1,
  D2_mcp_pending_count_excludes_no_entity_fact: mj?.pending_consolidation_count === 1,
}, { cli_pending_consolidation_count: cj?.pending_consolidation_count ?? null, mcp_pending_consolidation_count: mj?.pending_consolidation_count ?? null, listed: texts, mcp_text_head: m.text.slice(0, 300) });

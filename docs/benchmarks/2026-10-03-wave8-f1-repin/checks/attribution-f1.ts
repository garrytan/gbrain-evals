// Foundations 1 (F1): rows carry creation attribution. A page written by the local CLI, then changed by an agent over
// MCP stdio with the new `edit_page` tool (wave 8 #5616); `gbrain attribution <slug> --json` must name who created
// it and who changed it last, and a second edit against the old revision must be refused.
// Exit 0 when every preregistered expectation holds (item D6).
import { finish, gbrain, keylessHome, mcpSession } from './lib.ts';

const SLUG = 'example-garden-plan';
const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const put = await gbrain(['put', SLUG], h.env, undefined, '---\ntitle: Example garden plan\n---\nThe example garden plan starts in May.\n');
const first = await gbrain(['attribution', SLUG, '--json'], h.env);
const mcp = await mcpSession(h.env, h.home);
const got = await mcp.call('get_page', { slug: SLUG, include_content: true });
const revision = /"revision":\s*"([^"]+)"/.exec(got.text)?.[1] ?? '';
const edit = await mcp.call('edit_page', { slug: SLUG, expected_revision: revision, edits: [{ old_text: 'starts in May', new_text: 'starts in June' }] });
const stale = await mcp.call('edit_page', { slug: SLUG, expected_revision: revision, edits: [{ old_text: 'starts in June', new_text: 'starts in July' }] });
const after = await mcp.call('get_page', { slug: SLUG, include_content: true });
await mcp.close();
const second = await gbrain(['attribution', SLUG, '--json'], h.env);
h.cleanup();
const parse = (s: string) => { try { return JSON.parse(s.slice(s.indexOf('{'))); } catch { return null; } };
const a = parse(first.stdout); const b = parse(second.stdout);
finish('attribution-f1', {
  setup_ok: put.code === 0 && first.code === 0,
  D6_created_names_request_operation_principal: !!a?.created?.request_id && a?.created?.operation === 'put_page' && a?.created?.principal?.kind === 'local_cli' && a?.created?.origin === 'request',
  D6_mcp_edit_page_landed: !edit.isError && after.text.includes('starts in June'),
  D6_stale_revision_refused: stale.isError && !after.text.includes('starts in July'),
  D6_last_change_names_the_mcp_writer: !!b?.last?.request_id && b.last.request_id !== a?.created?.request_id && JSON.stringify(b.last.principal) !== JSON.stringify(a?.created?.principal),
  D6_creation_unchanged_after_edit: b?.created?.request_id === a?.created?.request_id,
}, { first: a, after_mcp_edit: b, mcp_edit: edit.text.slice(0, 600), stale_edit: stale.text.slice(0, 400), first_stderr: first.stderr.slice(-300) });

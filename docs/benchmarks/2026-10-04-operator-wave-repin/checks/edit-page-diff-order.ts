// gbrain #5991 (follow-up from the wave 8 re-pin): `edit_page`'s receipt diff lists removed lines before added ones,
// as `git diff` does. One single-line edit and one two-line edit over MCP stdio.
// Exit 0 when every preregistered expectation holds (item E2).
import { finish, gbrain, keylessHome, mcpSession } from '../../2026-10-03-wave8-f1-repin/checks/lib.ts';

const SLUG = 'example-garden-plan';
const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const put = await gbrain(['put', SLUG], h.env, undefined, '---\ntitle: Example garden plan\n---\nThe example garden plan starts in May.\nThe beds face south.\nWatering is daily.\n');
const mcp = await mcpSession(h.env, h.home);
const revisionOf = async () => /"revision":\s*"([^"]+)"/.exec((await mcp.call('get_page', { slug: SLUG, include_content: true })).text)?.[1] ?? '';
const one = await mcp.call('edit_page', { slug: SLUG, expected_revision: await revisionOf(), edits: [{ old_text: 'starts in May', new_text: 'starts in June' }] });
const two = await mcp.call('edit_page', { slug: SLUG, expected_revision: await revisionOf(), edits: [{ old_text: 'The beds face south.\nWatering is daily.', new_text: 'The beds face east.\nWatering is weekly.' }] });
await mcp.close();
h.cleanup();
const diffOf = (t: string) => { try { return String(JSON.parse(t.slice(t.indexOf('{'))).diff ?? ''); } catch { return ''; } };
const lines = (d: string) => d.split('\n').filter(l => /^[-+](?![-+]{2} )/.test(l));
const removedFirst = (d: string) => {
  const ls = lines(d);
  const lastMinus = ls.map(l => l[0]).lastIndexOf('-');
  const firstPlus = ls.map(l => l[0]).indexOf('+');
  return ls.length > 0 && lastMinus >= 0 && firstPlus >= 0 && lastMinus < firstPlus;
};
const d1 = diffOf(one.text); const d2 = diffOf(two.text);
finish('edit-page-diff-order', {
  setup_ok: put.code === 0 && !one.isError && !two.isError,
  E2_single_line_edit_removed_before_added: removedFirst(d1) && lines(d1).length === 2,
  E2_two_line_edit_both_removed_before_both_added: removedFirst(d2) && lines(d2).length === 4,
}, { diff_single: d1, diff_two_lines: d2 });

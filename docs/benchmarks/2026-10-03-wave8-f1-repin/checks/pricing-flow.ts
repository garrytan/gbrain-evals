// Wave 8 lane H: an unpriced chat model under a cost cap, end to end through the gbrain CLI and MCP server.
// The model is litellm:custom-chat, served by a scripted OpenAI-compatible provider on 127.0.0.1 ($0).
// Exit 0 when every preregistered expectation holds (2026-10-03-wave8-f1-coverage-preregistration.md, item A).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider } from './fake-provider.ts';
import { finish, gbrain, keylessHome, mcpSession } from './lib.ts';

const MODEL = 'litellm:custom-chat';
const OTHER = { 'litellm:other-embed': 0.13, 'example:priced-chat': { input: 3, output: 15 } };
const ASK_OPERATOR = "Over MCP or another remote connection you cannot register prices; ask the brain's operator to run that command.";
const fake = startFakeProvider();
const h = keylessHome({ LITELLM_BASE_URL: fake.url, LITELLM_API_KEY: 'fake-local-key' });
const step = (r: { code: number; stdout: string; stderr: string }) => ({ code: r.code, stdout_tail: r.stdout.slice(-2000), stderr_tail: r.stderr.slice(-2000) });

const init = await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding', '--chat-model', MODEL], h.env);
const dir = mkdtempSync(join(tmpdir(), 'w8f1-conv-'));
for (const id of ['a', 'b']) {
  writeFileSync(join(dir, `example-chat-${id}.md`), `---\ntype: conversation\ntitle: Example chat ${id}\n---\n`
    + `**Alice Example** (2026-08-27 9:00 AM): The example rollout ${id} is complete.\n**Bob Demo** (2026-08-27 9:01 AM): Record the result.\n`);
}
const imported = await gbrain(['import', dir, '--no-embed'], h.env);
await gbrain(['config', 'set', 'facts.extraction_enabled', 'true'], h.env);
await gbrain(['config', 'set', 'facts.extraction_model', MODEL], h.env);
await gbrain(['config', 'set', 'pricing.overrides', JSON.stringify(OTHER)], h.env);
const ecf = (slug: string, extra: string[]) => gbrain(['extract-conversation-facts', '--slug', slug, '--sleep', '0', ...extra], h.env);
const json = (s: string) => { try { return JSON.parse(s.slice(s.indexOf('{'))); } catch { return null; } };

// A1-A2: explicit cap, unpriced model: refused before any model call, JSON and text both carry the guidance.
let calls = fake.chatCalls;
const refusedJson = await ecf('example-chat-a', ['--max-cost-usd', '0.1', '--json']);
const rj = json(refusedJson.stdout);
const refusedCalls = fake.chatCalls - calls;
const refusedText = await ecf('example-chat-a', ['--max-cost-usd', '0.1']);
const g = rj?.no_pricing?.[0] ?? {};

// A3: default cap, unpriced model: warns and runs.
calls = fake.chatCalls;
const defaultRun = await ecf('example-chat-b', ['--json']);
const dj = json(defaultRun.stdout);
const defaultCalls = fake.chatCalls - calls;

// A4: gbrain pricing set merges one entry; the others survive.
const setOut = await gbrain(['pricing', 'set', MODEL, '--input', '1', '--output', '2', '--source', 'https://example.com/pricing'], h.env);
const stored = JSON.parse((await gbrain(['config', 'get', 'pricing.overrides'], h.env)).stdout.trim() || '{}');
const listed = json((await gbrain(['pricing', 'list', '--json'], h.env)).stdout);

// A5: the retried call is priced, then a cap below one call's reservation refuses on cost.
calls = fake.chatCalls;
const retried = await ecf('example-chat-a', ['--max-cost-usd', '0.1', '--json']);
const tj = json(retried.stdout);
const retriedCalls = fake.chatCalls - calls;
calls = fake.chatCalls;
const tiny = await ecf('example-chat-a', ['--max-cost-usd', '0.00001', '--force', '--json']);
const cj = json(tiny.stdout);
const tinyCalls = fake.chatCalls - calls;

// A6: remote MCP (stdio is a remote transport in gbrain) has no registration tool, and a thin client refuses `pricing`.
const mcp = await mcpSession(h.env, h.home);
const tools = (await mcp.tools()).map(t => t.name);
const guessed = await mcp.call('pricing_set', { model: MODEL, input: 0, output: 0 });
await mcp.close();
const storedAfterMcp = JSON.parse((await gbrain(['config', 'get', 'pricing.overrides'], h.env)).stdout.trim() || '{}');
const thin = keylessHome();
mkdirSync(join(thin.home, '.gbrain'), { recursive: true });
writeFileSync(join(thin.home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', remote_mcp: { issuer_url: 'http://127.0.0.1:9', mcp_url: 'http://127.0.0.1:9/mcp', oauth_client_id: 'example-client' } }));
const thinSet = await gbrain(['pricing', 'set', MODEL, '--input', '0', '--output', '0'], thin.env);
fake.stop();

const perCall = (100 * 1 + 50 * 2) / 1e6;
finish('pricing-flow', {
  setup_ok: init.code === 0 && imported.code === 0,
  A1_explicit_cap_refused_before_model_call: refusedJson.code !== 0 && rj?.budget_exhausted === true && refusedCalls === 0 && (rj?.no_pricing_models ?? []).includes(MODEL),
  A1_structured_fields: g.code === 'no_pricing' && g.model === MODEL && g.provider === 'litellm' && g.kind === 'chat'
    && JSON.stringify(g.units) === JSON.stringify(['usd_per_1m_input_tokens', 'usd_per_1m_output_tokens'])
    && typeof g.register_command === 'string' && g.register_command.startsWith(`gbrain pricing set ${MODEL} --input `) && g.register_command.includes('--output ')
    && g.register_scope === 'local_cli' && typeof g.lookup === 'string' && g.lookup.includes(MODEL),
  A2_text_names_command_units_model: refusedText.code !== 0 && refusedText.stdout.includes(`gbrain pricing set ${MODEL} --input`)
    && refusedText.stdout.includes('USD per 1M input tokens') && refusedText.stdout.includes(`"${MODEL}"`),
  A2_text_tells_remote_agent_to_ask_operator: refusedText.stdout.includes(ASK_OPERATOR),
  A3_default_cap_runs: defaultRun.code === 0 && defaultCalls > 0 && dj?.budget_exhausted !== true,
  A3_default_cap_warns_with_command: (defaultRun.stderr + defaultRun.stdout).includes(`gbrain pricing set ${MODEL} --input`),
  A4_set_ok: setOut.code === 0,
  A4_other_overrides_kept: JSON.stringify(stored['litellm:other-embed']) === JSON.stringify(OTHER['litellm:other-embed'])
    && JSON.stringify(stored['example:priced-chat']) === JSON.stringify(OTHER['example:priced-chat'])
    && stored[MODEL]?.input === 1 && stored[MODEL]?.output === 2,
  A5_retry_priced: retried.code === 0 && retriedCalls > 0 && tj?.budget_exhausted !== true
    && Math.abs((tj?.spent_usd ?? -1) - retriedCalls * perCall) < 1e-9,
  A5_registered_price_enforced_by_cap: cj?.budget_exhausted === true && tinyCalls === 0 && (cj?.no_pricing_models ?? []).length === 0,
  A6_no_pricing_tool_over_mcp: tools.length > 0 && !tools.some(n => /pric/i.test(n)),
  A6_guessed_tool_refused_and_nothing_stored: guessed.isError && JSON.stringify(storedAfterMcp) === JSON.stringify(stored),
  A6_thin_client_refuses_pricing_and_names_operator: thinSet.code !== 0 && /operator/i.test(thinSet.stderr + thinSet.stdout),
}, {
  chat_calls: { refused: refusedCalls, default_cap: defaultCalls, retried: retriedCalls, tiny_cap: tinyCalls },
  per_call_usd_expected: perCall,
  refusal_json: rj, refusal_text: step(refusedText), default_cap_run: { ...step(defaultRun), json: dj },
  pricing_set: step(setOut), stored_overrides: stored, pricing_list: listed,
  retried: tj, tiny_cap: { exit_code: tiny.code, json: cj },
  mcp_tool_count: tools.length, mcp_guessed_call: guessed.text.slice(0, 500),
  thin_client: step(thinSet),
});

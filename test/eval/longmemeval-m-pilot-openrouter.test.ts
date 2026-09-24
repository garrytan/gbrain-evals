import { expect, test } from 'bun:test';

test('C1 prepared config and actual SDK wire retain frozen Sonnet provider options', () => {
  const script = `
    import { strict as assert } from 'node:assert';
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { dirname, join, resolve } from 'node:path';
    import { configurePilotC1Gateway, PILOT_SONNET_MODEL } from './eval/runner/longmemeval-m-pilot-build.ts';
    import { developmentChatOptions } from './eval/runner/situation-recall-development.ts';
    const root = mkdtempSync(join(tmpdir(), 'lme-c1-sdk-'));
    process.env.HOME = root;
    process.env.GBRAIN_HOME = root;
    process.env.XDG_CONFIG_HOME = join(root, '.config');
    process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-only';
    const product = resolve('node_modules/gbrain');
    const gateway = await import('gbrain/ai/gateway');
    const config = await import('gbrain/config');
    const path = config.configPath();
    mkdirSync(dirname(path), { recursive: true });
    const opts = developmentChatOptions(PILOT_SONNET_MODEL);
    const prepared = { engine: 'pglite', embedding_model: 'openrouter:openai/text-embedding-3-large',
      embedding_dimensions: 1536, chat_model: PILOT_SONNET_MODEL,
      provider_chat_options: opts, database_path: join(root, 'index') };
    writeFileSync(path, JSON.stringify(prepared) + '\\n', { flag: 'wx' });
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json();
      calls++;
      assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(request.headers.get('authorization'), 'Bearer synthetic-openrouter-only');
      assert.equal(body.model, 'anthropic/claude-sonnet-4.6');
      assert.deepEqual(body.reasoning, { enabled: false });
      assert.deepEqual(body.provider, { allow_fallbacks: false,
        max_price: { prompt: 3, completion: 15, request: 0 } });
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 1200);
      const cost = (20 * 3 + 2 * 15) / 1e6;
      return Response.json({ id: 'synthetic-chat', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, cost, is_byok: false,
          cost_details: { upstream_inference_cost: cost } } });
    };
    try {
      const bound = await configurePilotC1Gateway(gateway, product, path, process.env);
      assert.deepEqual(bound.provider_chat_options, opts);
      assert.deepEqual(config.loadConfig().provider_chat_options, opts);
      assert.deepEqual(gateway.requireConfig().provider_chat_options, opts);
      const { liveMemoryCueProviders } = await import('./node_modules/gbrain/src/core/memory-cues/providers.ts');
      const generated = await liveMemoryCueProviders.generate({ evidence: 'Synthetic blue label.',
        includeBridge: false, model: PILOT_SONNET_MODEL, signal: AbortSignal.timeout(30000) });
      assert.deepEqual(generated.output, []);
      assert.equal(calls, 1);
      writeFileSync(path, JSON.stringify({ ...prepared, provider_chat_options: {} }));
      await assert.rejects(() => configurePilotC1Gateway(gateway, product, path, process.env), /prepared gateway config/);
      assert.equal(calls, 1);
      console.log('C1_SDK_WIRE_OK');
    } finally { rmSync(root, { recursive: true, force: true }); }
  `;
  const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeout: 120_000,
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(child.stdout.toString()).toContain('C1_SDK_WIRE_OK');
});

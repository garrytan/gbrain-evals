import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test.each([['cat36', 'isolated-provider-cap', 'openrouter:qwen/qwen3.7-flash'], ['cat13b', 'isolated-provider-cap', 'openrouter:qwen/qwen3.7-flash'],
  ['cat36', 'operator-authorized-development', 'openrouter:qwen/qwen3.7-flash'], ['cat13b', 'operator-authorized-development', 'openrouter:qwen/qwen3.7-flash'],
  ['cat36', 'operator-authorized-development', 'openrouter:anthropic/claude-sonnet-4.6'], ['cat13b', 'operator-authorized-development', 'openrouter:anthropic/claude-sonnet-4.6']])('%s %s %s verifies the route or blocks an unavailable canonical price', (category, admission, selectedModel) => {
  const script = `
    import { strict as assert } from 'node:assert';
    import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = mkdtempSync(join(tmpdir(), 'openrouter-eval-'));
    process.env.HOME = root;
    process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-only';
    process.env.OPENAI_API_KEY = 'synthetic-native-decoy';
    process.env.OPENROUTER_BASE_URL = 'https://forbidden.invalid';
    process.env.UNAPPROVED_SERVICE_TOKEN = 'synthetic-unapproved';
    const { offlineCat36Profile, validateCat36Profile } = await import('./eval/runner/cat36-associative-retrieval.ts');
    const { createCat36ProductionRuntime } = await import('./eval/runner/cat36-production.ts');
    const { runSituationRecallCat13b, validateCat13bPilotProfile } = await import('./eval/runner/situation-recall-cat13b.ts');
    const { regressionPackageHash } = await import('./eval/runner/situation-recall-provenance.ts');
    const { developmentChatOptions } = await import('./eval/runner/situation-recall-development.ts');
    const OPENROUTER_DEVELOPMENT_CHAT_OPTIONS = developmentChatOptions(${JSON.stringify(selectedModel)});
    const { canonicalLookup } = await import('./node_modules/gbrain/src/core/model-pricing.ts');
    const { lookupEmbeddingPrice } = await import('./node_modules/gbrain/src/core/embedding-pricing.ts');
    const embedding = 'openrouter:openai/text-embedding-3-large';
    const generation = ${JSON.stringify(selectedModel)};
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const profile = { ...offlineCat36Profile(), id: 'synthetic-openrouter-development', mode: 'live', arm: 'C1',
      embedding_model: embedding, generation_model: generation, embedding_dimensions: 1536,
      provider_chat_options: structuredClone(OPENROUTER_DEVELOPMENT_CHAT_OPTIONS),
      expected_product_sha: pkg.dependencies.gbrain.split('#')[1], expected_package_sha256: regressionPackageHash('node_modules/gbrain'),
      cue_min_similarity: 0.5, build_max_usd: 10,
      provider_budget: { kind: ${JSON.stringify(admission)}, approval_id: 'synthetic-not-spend-authorization', max_usd: 10,
        ...(${JSON.stringify(admission)} === 'operator-authorized-development' ? { max_requests: 1000, max_request_bytes: 65536, max_output_tokens: 1200, build_timeout_ms: 60000, cell_timeout_ms: 120000 } : {}) } };
    validateCat36Profile(profile);
    validateCat13bPilotProfile(profile);
    const canonical = canonicalLookup(generation);
    const price = OPENROUTER_DEVELOPMENT_CHAT_OPTIONS[generation].provider.max_price;
    if (canonical) { assert.equal(canonical.input, price.prompt); assert.equal(canonical.output, price.completion); }
    assert.equal(canonicalLookup('openrouter:anthropic/claude-haiku-4-5-20251001'), undefined);
    assert.equal(lookupEmbeddingPrice(embedding).pricePerMTok, 0.13);
    let embeddingCalls = 0, generationCalls = 0, violations = 0;
    globalThis.fetch = async (input, init) => {
      try {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, 'https://openrouter.ai');
        assert.equal(request.headers.get('authorization'), 'Bearer synthetic-openrouter-only');
        assert.equal(process.env.OPENROUTER_API_KEY, 'synthetic-openrouter-only');
        assert.equal(process.env.OPENROUTER_BASE_URL, undefined);
        assert.equal(process.env.UNAPPROVED_SERVICE_TOKEN, undefined);
        const body = await request.json();
        let response;
        if (url.pathname === '/api/v1/embeddings') {
          embeddingCalls++;
          assert.equal(body.model, 'openai/text-embedding-3-large');
          assert.equal(body.dimensions, 1536);
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          response = { object: 'list', model: 'text-embedding-3-large', data: inputs.map((_, index) => ({ object: 'embedding', index,
            embedding: Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0) })), usage: { prompt_tokens: 20, total_tokens: 20, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.000001 } } };
        } else {
          assert.equal(url.pathname, '/api/v1/chat/completions');
          generationCalls++;
          assert.equal(body.model, generation.slice('openrouter:'.length));
          assert.equal(body.max_tokens, 1200);
          assert.deepEqual(body.reasoning, { enabled: false });
          assert.deepEqual(body.provider, OPENROUTER_DEVELOPMENT_CHAT_OPTIONS[generation].provider);
          const content = JSON.stringify(body.messages);
          assert.ok(Buffer.byteLength(content) < 32000);
          response = { id: 'synthetic-chat', model: body.model, object: 'chat.completion', created: 1,
            choices: [{ index: 0, message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, cost: (20 * price.prompt + 2 * price.completion) / 1e6, is_byok: false,
              cost_details: { upstream_inference_cost: (20 * price.prompt + 2 * price.completion) / 1e6 } } };
        }
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
      } catch (error) { violations++; throw error; }
    };
    let runtime;
    try {
      if (!canonical && profile.provider_budget.kind === 'operator-authorized-development') {
        if (${JSON.stringify(category)} === 'cat36') {
          runtime = await createCat36ProductionRuntime(profile, { artifactDir: join(root, 'unpriced') });
          await assert.rejects(() => runtime.build([], profile), /generation pricing unavailable/);
          await runtime.close(); runtime = undefined;
        } else {
          const blocked = await runSituationRecallCat13b({ profile, outputDir: join(root, 'unpriced'), execute: true });
          assert.equal(blocked.run_status, 'error');
          assert.match(blocked.data.blocked_reason, /generation pricing unavailable/);
        }
        assert.equal(embeddingCalls + generationCalls, 0);
        rmSync(root, { recursive: true, force: true });
        console.log('OPENROUTER_HERMETIC_OK pricing unavailable before inference');
        process.exit(0);
      }
      if (${JSON.stringify(category)} === 'cat36') {
        const namespace = { home: join(root, 'prepared-home'), config: join(root, 'prepared-home', '.gbrain', 'config.json'), database: join(root, 'prepared-db') };
        mkdirSync(join(namespace.home, '.gbrain'), { recursive: true });
        writeFileSync(namespace.config, JSON.stringify({ engine: 'pglite', embedding_model: embedding, embedding_dimensions: 1536,
          chat_model: generation, provider_chat_options: structuredClone(profile.provider_chat_options), database_path: namespace.database }));
        runtime = await createCat36ProductionRuntime(profile, { artifactDir: join(root, 'runtime'), namespace });
        const build = await runtime.build([{ source_id: 'public-fixture-' + root.split('/').at(-1), slug: 'notes/schedule', title: 'Schedule', text: 'I do not take calls before 10.',
          visibility: 'public', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' }], profile);
        assert.equal(build.complete, true);
        assert.equal(build.generation_observed, true);
        assert.equal(build.provenance.package_sha256, profile.expected_package_sha256);
        assert.deepEqual(build.resolved_config.provider_chat_options, profile.provider_chat_options);
        assert.ok(build.generation.preview.costPreview.maximumReservationUsdPerWindow > 0);
        assert.equal(build.generation.preview.generationModel, generation);
        assert.equal(build.generation.preview.embeddingColumn.embeddingModel, embedding);
        assert.equal(build.generation.wall_timeout_ms, profile.provider_budget.kind === 'operator-authorized-development' ? 60000 : 600000);
        if (profile.provider_budget.kind === 'operator-authorized-development') {
          assert.equal(runtime.developmentUsage().provider_hard_cap, false);
          assert.equal(runtime.developmentUsage().dispatched_requests, embeddingCalls + generationCalls);
          assert.ok(runtime.developmentUsage().reported_input_tokens > 0);
        }
        await runtime.close(); runtime = undefined;
        const beforeMismatch = embeddingCalls + generationCalls;
        const badNamespace = { home: join(root, 'mismatch-home'), config: join(root, 'mismatch-home', '.gbrain', 'config.json'), database: join(root, 'mismatch-db') };
        mkdirSync(join(badNamespace.home, '.gbrain'), { recursive: true });
        const changedOptions = structuredClone(profile.provider_chat_options);
        changedOptions[generation].reasoning.enabled = true;
        writeFileSync(badNamespace.config, JSON.stringify({ engine: 'pglite', embedding_model: embedding, embedding_dimensions: 1536,
          chat_model: generation, provider_chat_options: changedOptions, database_path: badNamespace.database }));
        runtime = await createCat36ProductionRuntime(profile, { artifactDir: join(root, 'mismatch-runtime'), namespace: badNamespace });
        await assert.rejects(() => runtime.build([], profile), /prepared file-plane config differs/);
        await runtime.close(); runtime = undefined;
        assert.equal(embeddingCalls + generationCalls, beforeMismatch);
      } else {
        const receipt = await runSituationRecallCat13b({ profile, outputDir: join(root, 'pilot'), execute: true });
        assert.equal(receipt.run_status, 'completed', JSON.stringify(receipt.errors));
        assert.equal(receipt.n_scored, 30);
        assert.equal(receipt.resolved_config.profile.embedding_model, embedding);
        assert.equal(receipt.resolved_config.product_identity.package_sha256, profile.expected_package_sha256);
        assert.deepEqual(JSON.parse(readFileSync(receipt.resolved_config.config_path)).provider_chat_options, profile.provider_chat_options);
        assert.equal(receipt.data.build.generation.receipt.preview.generationModel, generation);
        assert.equal(receipt.data.release_coverage, false);
        if (profile.provider_budget.kind === 'operator-authorized-development') {
          assert.equal(receipt.publishable, false);
          assert.equal(receipt.data.development_usage.provider_hard_cap, false);
          assert.equal(receipt.data.development_usage.dispatched_requests, embeddingCalls + generationCalls);
          assert.ok(receipt.data.development_usage.reported_input_tokens > 0);
        }
      }
      assert.ok(embeddingCalls > 0);
      assert.ok(generationCalls > 0);
      assert.equal(violations, 0);
      assert.equal(process.env.OPENROUTER_API_KEY, 'synthetic-openrouter-only');
      assert.equal(process.env.OPENROUTER_BASE_URL, 'https://forbidden.invalid');
      const before = embeddingCalls + generationCalls;
      delete process.env.OPENROUTER_API_KEY;
      if (${JSON.stringify(category)} === 'cat36') {
        runtime = await createCat36ProductionRuntime(profile, { artifactDir: join(root, 'missing-key') });
        await assert.rejects(() => runtime.build([], profile), /embedding provider is not ready/);
        await runtime.close(); runtime = undefined;
      } else {
        const blocked = await runSituationRecallCat13b({ profile, outputDir: join(root, 'missing-key'), execute: true });
        assert.equal(blocked.run_status, 'error');
        assert.match(blocked.data.blocked_reason, /embedding provider is not ready/);
      }
      assert.equal(embeddingCalls + generationCalls, before);
      process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-only';
      const offline = offlineCat36Profile();
      if (${JSON.stringify(category)} === 'cat36') {
        runtime = await createCat36ProductionRuntime(offline);
        await runtime.build([], offline);
        assert.equal(process.env.OPENROUTER_API_KEY, undefined);
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        await runtime.close(); runtime = undefined;
      } else {
        const dependencies = { adapter: { name: 'gbrain', async init() {
          assert.equal(process.env.OPENROUTER_API_KEY, undefined);
          assert.equal(process.env.OPENAI_API_KEY, undefined);
          throw new Error('synthetic-isolation-stop');
        } } };
        const stopped = await runSituationRecallCat13b({ profile: offline, outputDir: join(root, 'offline'), execute: true }, dependencies);
        assert.equal(stopped.run_status, 'error');
        assert.match(stopped.data.blocked_reason, /synthetic-isolation-stop/);
      }
      assert.equal(embeddingCalls + generationCalls, before);
      assert.equal(process.env.OPENROUTER_API_KEY, 'synthetic-openrouter-only');
      console.log('OPENROUTER_HERMETIC_OK');
    } finally { await runtime?.close(); rmSync(root, { recursive: true, force: true }); }
  `;
  const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
    cwd: resolve('.'), timeout: 120_000, env: { PATH: process.env.PATH, HOME: '/nonexistent-hermetic-home' },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(child.stdout.toString()).toContain('OPENROUTER_HERMETIC_OK');
}, 130_000);

test.each(['openrouter:openai/gpt-4o-mini', 'openrouter:anthropic/claude-sonnet-4.6'])('%s gateway preserves explicit route controls independently of cue-price admission', model => {
  const script = `
    import { strict as assert } from 'node:assert';
    const { developmentChatOptions, startDevelopmentRequestGuard } = await import('./eval/runner/situation-recall-development.ts');
    const { offlineCat36Profile } = await import('./eval/runner/cat36-associative-retrieval.ts');
    const model = ${JSON.stringify(model)};
    const options = developmentChatOptions(model);
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(request.headers.get('authorization'), 'Bearer synthetic-router-only');
      const body = await request.json();
      assert.equal(body.model, model.slice('openrouter:'.length));
      assert.equal(body.max_tokens, 1200);
      assert.deepEqual(body.reasoning, { enabled: false });
      assert.deepEqual(body.provider, options[model].provider);
      requests++;
      return Response.json({ id: 'synthetic-chat', model: body.model, object: 'chat.completion', created: 1,
        choices: [{ index: 0, message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, is_byok: false, cost: 0 } });
    };
    const gateway = await import('gbrain/ai/gateway');
    gateway.configureGateway({ chat_model: model, provider_chat_options: options, env: { OPENROUTER_API_KEY: 'synthetic-router-only' } });
    const profile = { ...offlineCat36Profile(), mode: 'live', arm: 'C1', generation_model: model, provider_chat_options: options,
      provider_budget: { kind: 'operator-authorized-development', approval_id: 'synthetic-only', max_usd: 1, max_requests: 1,
        max_request_bytes: 65536, max_output_tokens: 1200, build_timeout_ms: 60000, cell_timeout_ms: 120000 } };
    const guard = startDevelopmentRequestGuard(profile);
    try {
      const response = await gateway.chat({ model, messages: [{ role: 'user', content: 'Synthetic routing check.' }], maxTokens: 1200, temperature: 0 });
      assert.equal(response.model, model);
      assert.equal(response.stopReason, 'end');
      assert.equal(requests, 1);
      assert.equal(guard.snapshot().reserved_usd, 0);
      console.log('ROUTED_ALT_OK');
    } finally { guard.restore(); }
  `;
  const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
    cwd: resolve('.'), timeout: 30_000, env: { PATH: process.env.PATH, HOME: '/nonexistent-hermetic-home' },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(child.stdout.toString()).toContain('ROUTED_ALT_OK');
}, 35_000);

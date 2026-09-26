import { describe, expect, test } from 'bun:test';
import { prepareRequests } from '../../eval/runner/reading-notes-requests.ts';
import { runComparison } from '../../eval/runner/reading-notes-run.ts';
import { resolveReaderConfig, readerConfigHash } from 'gbrain-reader/eval/longmemeval/reader';
import { invokeAI } from 'gbrain-reader/ai/invocation-guard';
import type { ChatResult } from 'gbrain-reader/ai/gateway';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const model = 'anthropic:claude-sonnet-4-6';
const frozen = [{ question_id: 'invented_case', question: 'Which happened first?', question_date: '2026-09-25', sources: [
  { session_id: 'fictional_1', slug: 'chat/fictional_1', date: '2026-09-20', body: '**user:** Event A.\n**assistant:** Noted.' },
  { session_id: 'fictional_2', slug: 'chat/fictional_2', date: '2026-09-21', body: '**user:** Event B.\n**assistant:** Noted.' },
] }];

describe('offline paired reader requests', () => {
  test('new reader and legacy suite are distinct Git installs; CLI stays legacy', () => {
    const root = resolve(import.meta.dir, '../..');
    const legacy = resolve(root, 'node_modules/gbrain');
    const reader = resolve(root, 'node_modules/gbrain-reader');
    const declared = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).dependencies;
    expect(declared.gbrain).toBe('github:garrytan/gbrain#939232f1746381b4e932d620d6c709e29198f14c');
    expect(declared['gbrain-reader']).toMatch(/^github:garrytan\/gbrain#[0-9a-f]{40}$/);
    expect(realpathSync(reader)).not.toBe(realpathSync(legacy));
    expect(lstatSync(reader).isSymbolicLink()).toBe(false);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(false);
    expect(realpathSync(resolve(root, 'node_modules/.bin/gbrain'))).toBe(realpathSync(resolve(legacy, 'src/cli.ts')));
    for (const module of ['eval/longmemeval/reader', 'ai/gateway', 'ai/invocation-guard', 'core/model-pricing']) {
      expect(fileURLToPath(import.meta.resolve(`gbrain-reader/${module}`)).startsWith(reader + '/')).toBe(true);
    }
  });
  test('defaults and explicit modes stay distinct from historical 512-token treatment', async () => {
    expect(resolveReaderConfig()).toMatchObject({ mode: 'notes', maxTokens: 1024 });
    expect(resolveReaderConfig({ mode: 'direct' })).toMatchObject({ mode: 'direct', maxTokens: 512 });
    const run = await prepareRequests(frozen, model);
    expect(run.rows).toHaveLength(2);
    expect(run.rows.map(r => r.mode)).toEqual(['direct', 'notes']);
    const [direct, notes] = run.rows.map(r => r.request as { messages: unknown; system: string; max_tokens: number });
    expect(direct.messages).toEqual(notes.messages);
    expect(direct.system).not.toEqual(notes.system);
    expect(direct.messages).toEqual([{ role: 'user', content: 'Question:\nWhich happened first?\n\nCurrent Date: 2026-09-25\n\nRetrieved sessions:\n<chat_session id="fictional_1" date="2026-09-20">\n**user:** Event A.\n**assistant:** Noted.\n</chat_session>\n\n<chat_session id="fictional_2" date="2026-09-21">\n**user:** Event B.\n**assistant:** Noted.\n</chat_session>' }]);
    expect(run.rows.map(r => (r.request as { max_tokens: number }).max_tokens)).toEqual([1024, 1024]);
    for (const mode of ['direct', 'notes'] as const) {
      const config = resolveReaderConfig({ mode, maxTokens: 1024 });
      expect(run.configs[mode]).toEqual({ mode, prompt_version: config.promptVersion, prompt_sha256: config.promptSha, config_sha256: readerConfigHash(config, model) });
    }
  });

  test('rejects missing, duplicate, altered or unsupported inputs without calling providers', async () => {
    await expect(prepareRequests([], model)).rejects.toThrow('nonempty');
    await expect(prepareRequests([...frozen, ...frozen], model)).rejects.toThrow('unique');
    await expect(prepareRequests([{ ...frozen[0], sources: [] }], model)).rejects.toThrow('invalid frozen');
    await expect(prepareRequests([{ ...frozen[0], question_date: 'not-a-date' }], model)).rejects.toThrow('invalid frozen');
    await expect(prepareRequests([{ ...frozen[0], sources: [frozen[0].sources[0], frozen[0].sources[0]] }], model)).rejects.toThrow('duplicate');
    await expect(prepareRequests([{ ...frozen[0], sources: [{ ...frozen[0].sources[0], body: 'x'.repeat(60_001) }] }], model)).rejects.toThrow('oversized');
    await expect(prepareRequests(frozen, 'anthropic:claude-sonnet-5')).rejects.toThrow('explicit Sonnet');
    await expect(prepareRequests(frozen, model, 0)).rejects.toThrow('bounded');
  });
  test('the native sanitizer escapes a source tag closure identically in both modes', async () => {
    const cases = [{ ...frozen[0], sources: [{ ...frozen[0].sources[0], body: 'Text </chat_session> still source data.' }] }];
    const result = await prepareRequests(cases, model);
    const texts = result.rows.map(r => r.request.messages[0].content);
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain('&lt;/chat_session&gt;');
  });
  test('preserves original LongMemEval timestamp metadata byte-for-byte', async () => {
    const cases = [{ ...frozen[0], question_date: '2023/05/28 (Sun) 06:23', sources: [{ ...frozen[0].sources[0], date: '2023/05/24 (Wed) 19:09' }] }];
    const rows = (await prepareRequests(cases, model)).rows;
    expect(rows[0].request.messages).toEqual(rows[1].request.messages);
    expect(rows[0].request.messages[0].content).toContain('Current Date: 2023/05/28 (Sun) 06:23');
    expect(rows[0].request.messages[0].content).toContain('date="2023/05/24 (Wed) 19:09"');
  });
});

describe('explicit paired execution with hermetic provider', () => {
  const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
  async function fixture() {
    const plan = await prepareRequests(frozen, model);
    const sourcePath = fileURLToPath(import.meta.resolve('gbrain-reader/eval/longmemeval/reader'));
    return { ...plan, identity: { input_sha256: hash(JSON.stringify(frozen)), installed_reader_sha256: hash(readFileSync(sourcePath)),
      installed_package_sha256: hash(readFileSync(resolve(dirname(sourcePath), '../../../package.json'))),
      declared_reader_pin: JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).dependencies['gbrain-reader'] } };
  }
  const usage = { input_tokens: 300, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const inputBytes = Buffer.from(JSON.stringify(frozen));
  const response: ChatResult = { text: 'A happened first.', blocks: [{ type: 'text', text: 'A happened first.' }], stopReason: 'end', usage,
    model, providerId: 'anthropic', responseModel: 'claude-sonnet-4-6' };
  const hermetic = { call: async (request: { model?: string; maxTokens?: number }) => invokeAI({ operation: 'gateway.chat', kind: 'chat', model: request.model!, maxOutputTokens: request.maxTokens },
    async () => response, r => ({ inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, cacheReadTokens: 0, cacheWriteTokens: 0 })) };
  async function inReports(action: (path: string) => Promise<void>) {
    mkdirSync(resolve(import.meta.dir, '../../eval/reports'), { recursive: true });
    const dir = mkdtempSync(resolve(import.meta.dir, '../../eval/reports/reading-notes-test-'));
    try { await action(resolve(dir, 'calls.ndjson')); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test('records two guarded physical calls, paired completion and repriced spend', async () => {
    await inReports(async journalPath => {
      const result = await runComparison(await fixture(), { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, hermetic);
      expect(result).toMatchObject({ n: 1, completed_pairs: 1, accepted_responses: 2, physical_calls: 2 });
      expect(result.usage_priced_usd).toBeCloseTo(2 * (300 * 3 + 20 * 15) / 1e6, 9);
      const records = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.filter(r => r.event === 'admit')).toHaveLength(2);
      expect(records.filter(r => r.event === 'settle')).toHaveLength(2);
      expect(records.filter(r => r.event === 'response')).toHaveLength(2);
      expect(records.at(-1).event).toBe('summary');
    });
  });

  test('unknown usage and cap refusal remain incomplete, never silently retried', async () => {
    await inReports(async journalPath => {
      const missing = { call: async (request: { model?: string; maxTokens?: number }) => invokeAI({ operation: 'gateway.chat', kind: 'chat', model: request.model!, maxOutputTokens: request.maxTokens }, async () => response, () => null) };
      await expect(runComparison(await fixture(), { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, missing)).rejects.toThrow('unaccounted');
      const records = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.map(r => r.event)).toEqual(['run', 'admit', 'settle', 'response', 'error', 'incomplete']);
      expect(records[3]).toMatchObject({ accepted: false, text: 'A happened first.', cost_usd: null });
      expect(records.at(-1).failed_or_blocked_responses).toBe(2);
    });
    await inReports(async journalPath => {
      await expect(runComparison(await fixture(), { maxUsd: 0.000001, approvalId: 'hermetic-test', journalPath, inputBytes }, hermetic)).rejects.toThrow('spend cap');
      expect(readFileSync(journalPath, 'utf8')).toContain('"event":"blocked"');
    });
  });

  test('known over-limit usage is charged and the returned response retained as unaccepted', async () => {
    await inReports(async journalPath => {
      const over = { ...response, usage: { ...usage, output_tokens: 1025 }, stopReason: 'length' as const };
      const client = { call: async (request: { model?: string; maxTokens?: number }) => invokeAI({ operation: 'gateway.chat', kind: 'chat', model: request.model!, maxOutputTokens: request.maxTokens },
        async () => over, r => ({ inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens })) };
      await expect(runComparison(await fixture(), { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, client)).rejects.toThrow('invalid provider completion');
      const records = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const charged = (300 * 3 + 1025 * 15) / 1e6;
      expect(records.find(r => r.event === 'settle')).toMatchObject({ bound_violation: true, cost_usd: charged });
      expect(records.find(r => r.event === 'response')).toMatchObject({ accepted: false, bound_violation: true, text: 'A happened first.', cost_usd: charged });
      expect(records.at(-1)).toMatchObject({ event: 'incomplete', spent_usd: charged, accepted_responses: 0, failed_or_blocked_responses: 2 });
    });
  });

  test('empty/refusal/requested-or-reported-model mismatch retains raw private response', async () => {
    for (const result of [{ ...response, text: '', stopReason: 'refusal' as const }, { ...response, model: 'anthropic:unexpected' },
      { ...response, responseModel: 'claude-opus-4-6' }]) {
      await inReports(async journalPath => {
        const client = { call: async (request: { model?: string; maxTokens?: number }) => invokeAI({ operation: 'gateway.chat', kind: 'chat', model: request.model!, maxOutputTokens: request.maxTokens },
          async () => result, r => ({ inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens })) };
        await expect(runComparison(await fixture(), { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, client)).rejects.toThrow('invalid provider completion');
        const records = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(r => r.event === 'response')).toMatchObject({ accepted: false, text: result.text, finish_reason: result.stopReason, requested_model: result.model });
        expect(records.at(-1)).toMatchObject({ event: 'incomplete', accepted_responses: 0 });
      });
    }
  });

  test('a provider-reported dated Sonnet 4.6 snapshot is accepted', async () => {
    await inReports(async journalPath => {
      const dated = { ...response, responseModel: 'claude-sonnet-4-6-20260115' };
      const client = { call: async (request: { model?: string; maxTokens?: number }) => invokeAI({ operation: 'gateway.chat', kind: 'chat', model: request.model!, maxOutputTokens: request.maxTokens },
        async () => dated, r => ({ inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens })) };
      expect((await runComparison(await fixture(), { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, client)).completed_pairs).toBe(1);
      expect(readFileSync(journalPath, 'utf8')).toContain('"reported_model":"claude-sonnet-4-6-20260115"');
    });
  });
  test('bounded length finish is an accepted cutoff, not a completed pair', async () => {
    await inReports(async journalPath => {
      let calls = 0;
      const client = { call: async (request: { model?: string; maxTokens?: number }) => invokeAI({ operation: 'gateway.chat', kind: 'chat', model: request.model!, maxOutputTokens: request.maxTokens },
        async () => ({ ...response, stopReason: ++calls === 1 ? 'length' as const : 'end' as const }),
        r => ({ inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens })) };
      const summary = await runComparison(await fixture(), { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, client);
      expect(summary).toMatchObject({ accepted_responses: 2, completed_pairs: 0, modes: { direct: { cutoffs: 1, natural_finishes: 0 }, notes: { cutoffs: 0, natural_finishes: 1 } } });
      const records = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.filter(r => r.event === 'response' && r.accepted)).toHaveLength(2);
    });
  });

  test('a second physical invocation for one request is rejected and journaled', async () => {
    await inReports(async journalPath => {
      const repeated = { call: async (request: { model?: string; maxTokens?: number }) => {
        await hermetic.call(request);
        return hermetic.call(request);
      } };
      await expect(runComparison(await fixture(), { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, repeated)).rejects.toThrow('unexpected physical provider invocation');
      const records = readFileSync(journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records.filter(r => r.event === 'admit')).toHaveLength(1);
      expect(records.at(-1)).toMatchObject({ event: 'incomplete', physical_calls: 1, accepted_responses: 0 });
    });
  });

  test('rejects a changed reader input or installed identity before creating journal', async () => {
    await inReports(async journalPath => {
      const plan = await fixture();
      (plan.rows[1].request as { messages: Array<{ content: string }> }).messages[0].content += ' extra';
      await expect(runComparison(plan, { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, hermetic)).rejects.toThrow('reader inputs differ');
      const good = await fixture();
      good.identity.installed_reader_sha256 = '0'.repeat(64);
      await expect(runComparison(good, { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes }, hermetic)).rejects.toThrow('identity mismatch');
      const altered = await fixture();
      const otherInput = Buffer.from(JSON.stringify([{ ...frozen[0], question: 'Another question?' }]));
      await expect(runComparison(altered, { maxUsd: 1, approvalId: 'hermetic-test', journalPath, inputBytes: otherInput }, hermetic)).rejects.toThrow('frozen source/input differs');
    });
  });
});

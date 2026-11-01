/**
 * particle-1 replay of the W10 LongMemEval prompts (plan GST-605 "Replay", unit U3): the comparator text it reads, the
 * window check, the read-and-judge loop with its stop state, truncation and retries, the preregistered bars, the
 * development-lane rule and the keyless re-score. Keyless: committed W10 receipts only, provider replies from a mocked
 * fetch, a placeholder Particle key.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const STATE_DIRS = { W10_STATE_DIR: join(tmpdir(), `w10-particle-test-${process.pid}`), W10_PARTICLE_STATE_DIR: join(tmpdir(), `w10-particle-state-${process.pid}`) };
Object.assign(process.env, STATE_DIRS);
const { ARMS, r1 } = await import('../../eval/runner/batch/w10.ts');
const { judgeBody } = await import('../../eval/runner/batch/sources.ts');
const { ChatClient } = await import('../../eval/runner/memory-qa/qa-v2.ts');
const P = await import('../../eval/runner/batch/w10-particle.ts');

const ROOT = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w10-particle-')); dirs.push(d); return d; };
const ENV = ['PARTICLE_API_KEY', 'PARTICLE_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const realFetch = globalThis.fetch;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { PARTICLE_API_KEY: 'test-key', OPENAI_API_KEY: 'test' });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => { for (const d of Object.values(STATE_DIRS)) rmSync(d, { recursive: true, force: true }); });

const particleReply = (content: string, finish = 'stop', reasoning = 120) => ({
  id: 'chatcmpl-1', object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', system_fingerprint: 'fp_1', metadata: { weight_version: 'default' },
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, reasoning_content: 'Reasoning.' } }],
  usage: { prompt_tokens: 14_000, completion_tokens: 300 + reasoning, total_tokens: 14_300 + reasoning, prompt_tokens_details: { cached_tokens: 2_000 }, completion_tokens_details: { reasoning_tokens: reasoning } },
});
const JUDGE_YES = { model: 'gpt-4o-2024-08-06', choices: [{ finish_reason: 'stop', message: { content: 'Yes.' } }], usage: { prompt_tokens: 300, completion_tokens: 2 } };

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
function serve(particle: Reply[]) {
  const seen: Array<{ host: string; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({ host: url.hostname, body: JSON.parse(String(init?.body)) });
    const r = url.hostname === 'api.particle.ai' ? particle.shift() : url.hostname === 'api.openai.com' ? { body: JUDGE_YES } : undefined;
    if (!r) throw new Error(`unexpected request to ${url.hostname}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as typeof fetch;
  return { particle: () => seen.filter(s => s.host === 'api.particle.ai'), openai: () => seen.filter(s => s.host === 'api.openai.com') };
}

const solBodies = () => ARMS['w10b-sol-notes'].build().bodies;
const inputsFor = (ids: string[]) => { const b = solBodies(); return new Map(ids.map(id => [id, P.readerText(b.get(id)!)])); };
const IDS = [...r1().keys()].sort().slice(0, 3);
const replay = (inputs: Map<string, { system: string; user: string }>, armId = 'w10b-particle-notes', concurrency = 1) =>
  P.replayQuestions({ client: new ChatClient(tmp(), () => 0), armId, arm: P.REPLAY_ARMS[armId], inputs, questions: r1(), concurrency });

describe('comparator text', () => {
  test('the Sonnet-shaped, Sol-shaped and Opus-shaped W10b bodies of every question carry identical system and user text', () => {
    const [sonnet, sol, opus] = ['w10b-sonnet55-notes', 'w10b-sol-notes', 'w10b-opus55-notes'].map(a => ARMS[a].build().bodies);
    expect(sol.size).toBe(500);
    for (const [id, body] of sol) {
      const text = P.readerText(body);
      expect(P.readerText(sonnet.get(id)!)).toEqual(text);
      expect(P.readerText(opus.get(id)!)).toEqual(text);
    }
  });

  test('saved prompt text that no longer hashes to the build record is refused', () => {
    const content = JSON.stringify({ question_id: 'q1', system: 's', user: 'u' }) + '\n';
    mkdirSync(join(P.STATE_DIR, 'inputs'), { recursive: true });
    writeFileSync(join(P.STATE_DIR, 'build.json'), JSON.stringify({ sources: { r1: { text_sha256: createHash('sha256').update(content).digest('hex') } } }));
    writeFileSync(join(P.STATE_DIR, 'inputs', 'r1.ndjson.gz'), gzipSync(content));
    expect(P.loadInputs('r1').get('q1')).toEqual({ system: 's', user: 'u' });
    writeFileSync(join(P.STATE_DIR, 'inputs', 'r1.ndjson.gz'), gzipSync(content.replace('"u"', '"v"')));
    expect(() => P.loadInputs('r1')).toThrow('no longer matches the build record');
  });

  test('a rebuilt comparator body that no longer hashes to its committed manifest is refused', async () => {
    const arm = ARMS['w10b-sol-notes'];
    const build = arm.build;
    expect((await P.rehash('w10b-sol-notes', null)).record).toMatchObject({ bodies: 500, matching: 500, differing_at_pin: 0 });
    arm.build = () => { const built = build(); const [id, body] = [...built.bodies][0]; built.bodies.set(id, { ...body, max_tokens: 1 }); return built; };
    try {
      await expect(P.rehash('w10b-sol-notes', null)).rejects.toThrow('1 of 500 rebuilt bodies differ from the committed manifest');
    } finally { arm.build = build; }
  });

  test('whole-history bodies that no longer render at the pin need a gbrain c5fb0201 checkout, and a checkout at any other commit is refused', async () => {
    const arm = ARMS['w10c-sol-full'];
    const build = arm.build;
    arm.build = () => ({ bodies: new Map(), source: 'none rendered', protocol: { name: 'test', sha256: '' } });
    try {
      await expect(P.rehash('w10c-sol-full', null)).rejects.toThrow('150 of 150 whole-history bodies no longer render byte for byte at the pinned gbrain; pass --gbrain-c5fb0201');
      await expect(P.rehash('w10c-sol-full', ROOT)).rejects.toThrow(', not gbrain c5fb0201');
    } finally { arm.build = build; }
  });

  test('a body of any other shape is refused', () => {
    expect(() => P.readerText({ model: 'x', messages: [{ role: 'user', content: 'q' }] })).toThrow('either Anthropic-shaped or OpenAI-shaped');
  });

  test('the window check bounds tokens by UTF-8 bytes against particle-1\'s 1,048,576-token window', () => {
    expect(() => P.assertFitsParticleWindow('q', { system: 's', user: 'x'.repeat(700_000) })).not.toThrow();
    expect(() => P.assertFitsParticleWindow('q', { system: 's', user: 'é'.repeat(520_000) })).toThrow("exceed particle-1's 1048576-token window");
  });
});

describe('read and judge', () => {
  test('each answer is read at the arm\'s effort and limit, then judged with the W10 official body', async () => {
    const s = serve(IDS.map(() => ({ body: particleReply('The answer is 3:1.') })));
    const out = await replay(inputsFor(IDS));
    expect(out.rows.map(r => r.correct_official)).toEqual([1, 1, 1]);
    const sent = s.particle()[0].body;
    expect(sent).toMatchObject({ model: 'particle-1', reasoning_effort: 'high', max_completion_tokens: 16_000 });
    expect(sent.temperature).toBeUndefined();
    expect(sent.messages).toEqual([{ role: 'system', content: inputsFor([IDS[0]]).get(IDS[0])!.system }, { role: 'user', content: inputsFor([IDS[0]]).get(IDS[0])!.user }]);
    expect(s.openai()[0].body).toEqual(judgeBody('official', r1().get(IDS[0])!, 'The answer is 3:1.'));
    const row = out.rows[0];
    expect(row).toMatchObject({ finish: 'stop', truncated: false, error: null, response_model: 'particle-ai/particle-1', reader_attempts: 1, from_cache: false });
    expect(row.list_usd).toBeCloseTo((12_000 * 0.25 + 2_000 * 0.03 + 420 * 1.0) / 1e6, 9);
    expect(out.receipts.filter(r => r.role === 'reader')[0]).toMatchObject({ lane: 'w10-particle', status: 'ok', request: { effort_sent: 'high', effort_effective: 'high', output_limit: 16_000 } });
  });

  test('the effort-none arm sends reasoning_effort none', async () => {
    const s = serve([{ body: particleReply('ok', 'stop', 0) }]);
    await replay(inputsFor([IDS[0]]), 'w10c-particle-currentpin-none');
    expect(s.particle()[0].body.reasoning_effort).toBe('none');
  });

  test('an answer cut off at its limit is judged as written and never retried; an empty one is wrong without a judge call', async () => {
    const s = serve([{ body: particleReply('Partial answer: 3', 'length') }, { body: particleReply('', 'length') }]);
    const out = await replay(inputsFor(IDS.slice(0, 2)));
    expect(s.particle().length).toBe(2);
    expect(s.openai().length).toBe(1);
    const [cut, empty] = out.rows;
    expect(cut).toMatchObject({ truncated: true, finish: 'length', correct_official: 1, official: { verdict: true, raw: 'Yes.', error: null } });
    expect(empty).toMatchObject({ truncated: true, finish: 'length', correct_official: 0, official: { verdict: false, raw: null } });
    expect(empty.official!.skipped).toContain('empty answer');
  });

  test('a fake 429, 429, 200 leaves three reader receipts, the failed two with null response fields', async () => {
    serve([{ status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } }, { status: 429, body: { error: 'slow down' } }, { body: particleReply('Yes it is.') }]);
    const out = await replay(inputsFor([IDS[0]]));
    const readers = out.receipts.filter(r => r.role === 'reader');
    expect(readers.map(r => r.status)).toEqual(['error', 'error', 'ok']);
    expect(readers[0].response_meta).toEqual({ metadata: null, weight_version: null, service_tier: null, system_fingerprint: null, non_default_tier: null, truncated: null });
    expect(out.rows[0]).toMatchObject({ reader_attempts: 3, correct_official: 1 });
  });

  test('Particle\'s credit 402 writes the failing row, judges nothing and starts no later question', async () => {
    const s = serve([{ status: 402, body: { error: { message: 'insufficient credits' } } }]);
    const out = await replay(inputsFor(IDS));
    expect(out.stopped).toStartWith('budget: Particle credit exhausted');
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].error).toStartWith('budget: Particle credit exhausted');
    expect(out.not_run).toEqual(IDS.slice(1));
    expect(s.particle().length).toBe(1);
    expect(s.openai().length).toBe(0);
    expect(out.rows[0].budget_stop).toBe(true);
  });

  test('the ledger\'s own refusal stops the arm like a credit stop and is not counted against bar 4', async () => {
    globalThis.fetch = (async () => { const e = new Error('particle:particle-1 chat: reserving $0.0100 would take this run to $12.0100, over its $12.00 budget'); e.name = 'BudgetExceededError'; throw e; }) as unknown as typeof fetch;
    const out = await replay(inputsFor(IDS));
    expect(out.stopped).toStartWith('particle:particle-1 chat: reserving');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ budget_stop: true, correct_official: 0 });
    expect(out.not_run).toEqual(IDS.slice(1));
    expect(P.checkBars(out.rows, out.receipts, []).errors).toMatchObject({ pass: true, failed_after_retries: 0 });
  });

  test('a question that throws lets the questions already reading finish with rows, starts no new one and rethrows', async () => {
    const s = serve(IDS.map(() => ({ body: particleReply('Yes.') })));
    const seen: string[] = [];
    const run = P.replayQuestions({
      client: new ChatClient(tmp(), () => 0), armId: 'w10b-particle-notes', arm: P.REPLAY_ARMS['w10b-particle-notes'], inputs: inputsFor(IDS), questions: r1(), concurrency: 2,
      onRow: row => { seen.push(row.question_id); if (seen.length === 1) throw new Error('disk full'); },
    });
    await expect(run).rejects.toThrow('disk full');
    expect(seen).toHaveLength(2);
    expect(s.particle()).toHaveLength(2);
  });

  test('the client\'s per-attempt deadline bounds each Particle attempt', async () => {
    const waited: number[] = [];
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => {
      const t0 = Date.now();
      init!.signal!.addEventListener('abort', () => { waited.push(Date.now() - t0); reject(init!.signal!.reason); });
    })) as typeof fetch;
    await expect(new ChatClient(tmp(), () => 0, 50).chat(P.PARTICLE, 'q', { maxTokens: 10, replicate: 0, effort: 'none' })).rejects.toThrow();
    expect(waited.length).toBeGreaterThan(0);
    expect(Math.max(...waited)).toBeLessThan(2_000);
  });
});

describe('preregistered bars', () => {
  const run = async () => { serve(IDS.map(() => ({ body: particleReply('Yes.') }))); return replay(inputsFor(IDS)); };
  const entries = (out: Awaited<ReturnType<typeof run>>, scale = 1) => out.receipts.filter(r => r.model === P.PARTICLE).map(r => ({ description: 'particle:particle-1 chat', reserved_usd: 0.1, actual_usd: P.particleUsd(r.usage_raw) * scale, status: 'reconciled' }));

  test('a clean arm passes bars 1 to 4', async () => {
    const out = await run();
    const bars = P.checkBars(out.rows, out.receipts, entries(out));
    expect(Object.values(bars).map(b => b.pass)).toEqual([true, true, true, true]);
    expect(bars.metering).toMatchObject({ particle_requests: 3, ledger_entries: 3, gap: 0 });
  });

  test('a ledger more than 2% off the usage fields, a missing reasoning count, 2% truncated or 3% failed each fails its bar', async () => {
    const out = await run();
    expect(P.checkBars(out.rows, out.receipts, entries(out, 1.03)).metering.pass).toBe(false);
    expect(P.checkBars(out.rows, out.receipts, entries(out).slice(1)).metering.pass).toBe(false);
    const noReasoning = out.receipts.map((r, i) => (i === 0 ? { ...r, usage: { ...r.usage!, reasoning: null } } : r));
    expect(P.checkBars(out.rows, noReasoning, entries(out)).receipts.pass).toBe(false);
    const many = (n: number, patch: Partial<(typeof out.rows)[number]>) => Array.from({ length: 100 }, (_, i) => ({ ...out.rows[0], question_id: String(i), ...(i < n ? patch : {}) }));
    expect(P.checkBars(many(1, { truncated: true }), [], []).truncation.pass).toBe(true);
    expect(P.checkBars(many(2, { truncated: true }), [], []).truncation.pass).toBe(false);
    expect(P.checkBars(many(2, { error: 'particle 503: busy', truncated: null }), [], []).errors.pass).toBe(true);
    expect(P.checkBars(many(3, { error: 'particle 503: busy', truncated: null }), [], []).errors.pass).toBe(false);
  });

  test('bars 1 and 2 fail an arm whose every particle answer came from the response cache, since that arm measured nothing', async () => {
    const out = await run();
    const cached = out.receipts.map(r => (r.model === P.PARTICLE ? { ...r, from_cache: true } : r));
    const bars = P.checkBars(out.rows, cached, []);
    expect(bars.metering).toMatchObject({ pass: false, particle_requests: 0, ledger_entries: 0 });
    expect(bars.receipts).toMatchObject({ pass: false, particle_receipts: 0 });
    expect([bars.truncation.pass, bars.errors.pass]).toEqual([true, true]);
  });
});

describe('run', () => {
  test('refuses an --out that already holds rows and leaves it as it was', async () => {
    const out = tmp();
    writeFileSync(join(out, 'rows.ndjson'), '{}\n');
    await expect(P.run('w10b-particle-notes', ['--out', out])).rejects.toThrow('already holds rows; a rerun goes to a fresh --out');
    expect(readdirSync(out)).toEqual(['rows.ndjson']);
    expect(readFileSync(join(out, 'rows.ndjson'), 'utf8')).toBe('{}\n');
  });
});

describe('development-lane test', () => {
  const base = { sonnetDelta: 10 / 150, agreeSol: 0.9 };
  test('passes on Sonnet\'s sign with an interval above zero and agreement within 5 points of Sol\'s', () => {
    expect(P.devLaneVerdict({ ...base, delta: 0.06, ci95: [0.01, 0.11], agreeParticle: 0.86 })).toBe('pass');
  });
  test('is inconclusive when the interval includes zero or agreement falls more than 5 points short', () => {
    expect(P.devLaneVerdict({ ...base, delta: 0.03, ci95: [-0.01, 0.07], agreeParticle: 0.95 })).toBe('inconclusive');
    expect(P.devLaneVerdict({ ...base, delta: 0.06, ci95: [0.01, 0.11], agreeParticle: 0.84 })).toBe('inconclusive');
  });
  test('fails on the opposite sign with an interval below zero', () => {
    expect(P.devLaneVerdict({ ...base, delta: -0.06, ci95: [-0.11, -0.01], agreeParticle: 0.95 })).toBe('fail');
  });
});

describe('keyless re-score', () => {
  test('Particle\'s off-peak window runs 20:30 to 04:00 New York time', () => {
    expect(P.particleOffPeak('2026-11-01T05:42:00Z')).toBe(true);
    expect(P.particleOffPeak('2026-11-01T08:59:00Z')).toBe(true);
    expect(P.particleOffPeak('2026-11-01T09:00:00Z')).toBe(false);
    expect(P.particleOffPeak('2026-11-01T00:29:00Z')).toBe(false);
    expect(P.particleOffPeak('2026-11-01T00:30:00Z')).toBe(true);
  });

  test('a particle arm that answers exactly as Opus did reads a zero paired difference and no decision-B flip', () => {
    const dir = tmp();
    const arm = join(dir, 'arms', 'w10b-particle-notes');
    mkdirSync(arm, { recursive: true });
    const opus = readFileSync(join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-opus55-notes/rows.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    writeFileSync(join(arm, 'rows.ndjson'), opus.map((r, i) => JSON.stringify({ ...r, model: P.PARTICLE, usage: null, usd: 0.001, list_usd: 0.001, secondary: null, requested_at: '2026-11-01T05:50:00Z', from_cache: i < 100 })).join('\n') + '\n');
    writeFileSync(join(arm, 'receipt.json'), JSON.stringify({ effort: 'high', stopped: null, not_run: [], bars: {}, ledger: { usd: 0.5 } }));
    const out = P.report(dir, tmp()) as any;
    expect(readdirSync(dir).filter(f => f.startsWith('compare-'))).toEqual([]);
    expect(out.arms['w10b-particle-notes']).toMatchObject({ n: 500, correct: 474, list_usd_per_correct: Number((0.5 / 474).toFixed(5)), paid_rows: 400, offpeak_paid_rows: 400, charged_estimate_usd: 0.2 });
    expect(out.comparators['w10b-opus55-notes']).toMatchObject({ correct: 474, batch_usd: 24.0103 });
    const vsOpus = out.w10b.comparisons.find((c: any) => c.id === 'correct__particle_minus_opus55');
    expect(vsOpus.delta).toBe(0);
    expect(out.decision_b.flip).toBe(false);
  });

  test('report refuses an arm that stopped or left questions unrun', () => {
    const dir = tmp();
    const arm = join(dir, 'arms', 'w10b-particle-notes');
    mkdirSync(arm, { recursive: true });
    writeFileSync(join(arm, 'rows.ndjson'), '');
    writeFileSync(join(arm, 'receipt.json'), JSON.stringify({ effort: 'high', stopped: 'budget: Particle credit exhausted', not_run: [IDS[1]], bars: {}, ledger: { usd: 0 } }));
    expect(() => P.report(dir, tmp())).toThrow('w10b-particle-notes did not finish');
  });

  test('R2 arms that answer as GPT-6.1 Sol did read decision G and the development-lane test from the registered family', () => {
    const dir = tmp();
    const src: Record<string, string> = {
      'w10b-particle-notes': 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-sol-notes',
      'w10c-particle-currentpin': 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms/w10c-sol-currentpin',
      'w10c-particle-full': 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms/w10c-sol-full',
    };
    for (const [id, path] of Object.entries(src)) {
      const arm = join(dir, 'arms', id);
      mkdirSync(arm, { recursive: true });
      const rows = readFileSync(join(ROOT, path, 'rows.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      writeFileSync(join(arm, 'rows.ndjson'), rows.map(r => JSON.stringify({ ...r, model: P.PARTICLE, usage: null, secondary: null })).join('\n') + '\n');
      writeFileSync(join(arm, 'receipt.json'), JSON.stringify({ effort: 'high', stopped: null, not_run: [], bars: {}, ledger: { usd: 1 } }));
    }
    const out = P.report(dir) as any;
    expect(out.decision_g.family_id).toBe('particle-replay-g-gbrain-noninferior-to-particle-full');
    expect(out.decision_g.comparisons.map((c: any) => [c.id, c.n_pairs])).toEqual([['particle-gbrain-vs-particle-full', 150], ['sonnet55-gbrain-vs-particle-full', 150]]);
    expect(out.decision_g.comparisons.every((c: any) => typeof c.p_holm === 'number')).toBe(true);
    expect(out.development_lane).toMatchObject({ sonnetDelta: 10 / 150, agreeParticle: out.development_lane.agreeSol });
    expect(out.development_lane.delta).toBeCloseTo(out.w10c.comparisons.find((c: any) => c.id === 'correct__sol_full_minus_old').delta, 12);
  });
});

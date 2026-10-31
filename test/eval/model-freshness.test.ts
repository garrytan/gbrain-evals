import { describe, expect, test } from 'bun:test';
import { assess, classify, listParticleModels, newestByFamily, particleListing, particleListingIdentity, PARTICLE_LISTINGS, ROUND_MODELS, type ListedModel } from '../../scripts/model-freshness.ts';
import { chatPrice } from '../../eval/runner/budget-ledger.ts';

const m = (provider: ListedModel['provider'], id: string, created = 0): ListedModel => ({ provider, id, created });

describe('model freshness', () => {
  test('classifies family ids and ignores snapshots, minis and small tiers', () => {
    expect(classify(m('anthropic', 'claude-sonnet-5-5'))).toEqual({ family: 'sonnet', version: [5, 5] });
    expect(classify(m('anthropic', 'claude-haiku-4-5-20251001'))).toBeNull();
    expect(classify(m('anthropic', 'claude-opus-4-5-20251101'))).toBeNull();
    expect(classify(m('openai', 'gpt-6.1-sol'))).toEqual({ family: 'gpt', version: [6, 1] });
    expect(classify(m('openai', 'gpt-5.4-mini'))).toBeNull();
    expect(classify(m('openai', 'gpt-6-luna'))).toBeNull();
  });

  test('picks the newest per family', () => {
    const listed = [m('anthropic', 'claude-opus-5'), m('anthropic', 'claude-opus-5-5'), m('anthropic', 'claude-fable-5-1'), m('anthropic', 'claude-sonnet-5-5'), m('openai', 'gpt-6-astra', 1), m('openai', 'gpt-6.1-sol', 2), m('openai', 'gpt-5.5')];
    expect(newestByFamily(listed)).toEqual({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-1', gpt: 'gpt-6.1-sol', particle: null });
  });

  test('a newer release warns; an unpriced called model blocks', () => {
    const listed = [m('anthropic', 'claude-opus-6'), m('openai', 'gpt-6.1-sol')];
    const r = assess(['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'], listed, id => id !== 'openai:gpt-6.1-sol');
    expect(r.warnings.some(w => w.includes('claude-opus-6'))).toBe(true);
    expect(r.blocking).toHaveLength(1);
  });
});

describe('model rules (CLAUDE.md "Choose models", 2026-10-07)', () => {
  const listed = [m('anthropic', 'claude-opus-5-5'), m('anthropic', 'claude-sonnet-5-5'), m('anthropic', 'claude-fable-5-1'), m('openai', 'gpt-6.1-sol')];
  const all = () => true;

  test('the counted readers pass clean; a newer Fable is not a reason to add Fable to a counted run', () => {
    expect(assess(['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol'], listed, all)).toEqual({ warnings: [], blocking: [] });
  });

  test('Fable in a run is flagged smoke-only; gpt-4.1-mini is flagged bridge-only; gpt-5.4-mini blocks', () => {
    const r = assess(['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-fable-5-1', 'openai:gpt-4.1-mini', 'openai:gpt-5.4-mini'], listed, all);
    expect(r.warnings.some(w => w.includes('claude-fable-5-1') && w.includes('smoke tests only'))).toBe(true);
    expect(r.warnings.some(w => w.includes('gpt-4.1-mini') && w.includes('bridge'))).toBe(true);
    expect(r.blocking).toEqual([expect.stringContaining('gpt-5.4-mini is never run')]);
  });

  test('the current cheap models are priced in the ledger', () => {
    expect(assess(['anthropic:claude-haiku-5-5', 'openai:gpt-6-luna'], listed, id => chatPrice(id) !== undefined).blocking).toEqual([]);
  });
});

/** Particle's GET /v1/models as read on 2026-10-31, abridged to the fields the check reads: each model at its default tier and at `flex`, half price. */
const tier = (id: string, created: number, description: string, [input, cached, output]: string[], serviceTier?: string) => ({
  id, created, description, schema_version: '2.4', ...(serviceTier ? { service_tier: serviceTier } : {}),
  input_modalities: [{ type: 'text', pricing: [{ type: 'prompt', unit: 'token', cost_usd: input }, { type: 'cached_prompt', unit: 'token', cost_usd: cached, implicit: true }] }],
  output_modalities: [{ type: 'text', pricing: [{ type: 'completion', unit: 'token', cost_usd: output }] }],
});
const P1_TEXT = "Particle-1 is Particle AI's token-efficient agentic model, trained to complete software engineering tasks accurately with substantially fewer tokens.";
const PARTICLE_MODELS = { object: 'list', data: [
  tier('deepseek-ai/deepseek-v41-flash-1017', 1785877395, 'DeepSeek V4.1 Flash, served by Particle AI.', ['0.00000025', '0.00000003', '0.000001']),
  tier('deepseek-ai/deepseek-v41-flash-1017', 1785877395, 'DeepSeek V4.1 Flash, served by Particle AI.', ['0.000000125', '0.000000015', '0.0000005'], 'flex'),
  tier('particle-ai/particle-1', 1793108609, P1_TEXT, ['0.00000025', '0.00000003', '0.000001']),
  tier('particle-ai/particle-1', 1793108609, P1_TEXT, ['0.000000125', '0.000000015', '0.0000005'], 'flex'),
] };
const LEDGER_P1 = { input: 0.25, output: 1, cache_read: 0.03 };

describe('Particle in the freshness check (plan GST-605 Phase 1, item 6)', () => {
  const listed = particleListing(PARTICLE_MODELS);
  const counted = [m('anthropic', 'claude-opus-5-5'), m('anthropic', 'claude-sonnet-5-5'), m('openai', 'gpt-6.1-sol')];
  const run = ['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'particle:particle-1'];
  const ledgerPrice = (id: string) => (id === 'particle:particle-1' ? LEDGER_P1 : undefined);

  test('both tier rows are read, keyed by id and tier, Particle\'s own namespace stripped and prices per 1M tokens', () => {
    expect(listed.filter(x => x.id === 'particle-1').map(x => [x.service_tier, x.price])).toEqual([
      ['default', { input: 0.25, cache_read: 0.03, output: 1 }], ['flex', { input: 0.125, cache_read: 0.015, output: 0.5 }]]);
    expect(listed[0]!.id).toBe('deepseek-ai/deepseek-v41-flash-1017');
    expect(classify(listed[0]!)).toBeNull();
    expect(classify(listed[2]!)).toEqual({ family: 'particle', version: [1, 0] });
    expect(newestByFamily(listed).particle).toBe('particle-1');
    expect(particleListingIdentity(listed, 'particle-1')).toEqual({ created: 1793108609, description_sha256: PARTICLE_LISTINGS['particle-1']!.description_sha256 });
    expect(ROUND_MODELS).toContain('particle:particle-1');
  });

  test('particle-1 at its recorded listing, priced as its default tier, passes clean; the half-price flex row is not a mismatch', () => {
    expect(assess(run, [...counted, ...listed], () => true, { ledgerPrice })).toEqual({ warnings: [], blocking: [] });
  });

  test('a ledger price that differs from the default tier blocks; an unlisted Particle model blocks; an unpriced one blocks', () => {
    const wrong = assess(run, [...counted, ...listed], () => true, { ledgerPrice: () => ({ input: 0.125, output: 0.5, cache_read: 0.015 }) });
    expect(wrong.blocking).toEqual([expect.stringContaining('Particle lists its default tier at $0.25 input, $0.03 cached, $1 output')]);
    const flexOnly = listed.filter(x => !(x.id === 'particle-1' && x.service_tier === 'default'));
    expect(assess(run, [...counted, ...flexOnly], () => true, { ledgerPrice }).blocking).toEqual([expect.stringContaining("not in Particle's model list at the default tier")]);
    expect(assess([...run, 'particle:particle-2'], [...counted, ...listed], () => true, { ledgerPrice }).blocking).toEqual([expect.stringContaining('particle:particle-2 is not in')]);
    expect(assess(run, [...counted, ...listed], id => id !== 'particle:particle-1', { ledgerPrice }).blocking).toEqual([expect.stringContaining('particle:particle-1 has no price')]);
  });

  test('a default-tier listing whose price cannot be read blocks, so the ledger price is never left unchecked', () => {
    const renamed = particleListing({ data: PARTICLE_MODELS.data.map(x => (x.id === 'particle-ai/particle-1' && !x.service_tier
      ? { ...x, input_modalities: [{ type: 'text', pricing: [{ type: 'input', unit: 'token', cost_usd: '0.00000025' }] }] } : x)) });
    expect(renamed.find(x => x.id === 'particle-1' && x.service_tier === 'default')?.price).toBeUndefined();
    expect(assess(run, [...counted, ...renamed], () => true, { ledgerPrice }).blocking).toEqual([expect.stringContaining('Particle lists its default tier with no price this script can read')]);
  });

  test('a changed particle-1 listing warns; a newer Particle model warns', () => {
    const moved = listed.map(x => (x.id === 'particle-1' ? { ...x, created: x.created + 86_400 } : x));
    expect(assess(run, [...counted, ...moved], () => true, { ledgerPrice }).warnings).toEqual([expect.stringContaining("particle:particle-1's listing changed since 2026-10-31 (created 1793108609 -> 1793195009")]);
    const reworded = particleListing({ data: PARTICLE_MODELS.data.map(x => (x.id === 'particle-ai/particle-1' ? { ...x, description: 'Particle-1, retrained.' } : x)) });
    expect(assess(run, [...counted, ...reworded], () => true, { ledgerPrice }).warnings).toEqual([expect.stringContaining('description 4b56656e41f5 ->')]);
    const newer = [...listed, ...particleListing({ data: [tier('particle-ai/particle-2', 1800000000, 'Particle-2.', ['0.0000003', '0.00000003', '0.0000012'])] })];
    expect(assess(run, [...counted, ...newer], () => true, { ledgerPrice }).warnings).toEqual([expect.stringContaining('newer particle model listed: particle-2')]);
  });

  test('without PARTICLE_API_KEY the list is skipped with its reason and never fetched, and the run is told what went unchecked', async () => {
    const never = (async () => { throw new Error('fetched without a key'); }) as unknown as typeof fetch;
    const skipped = await listParticleModels({}, never);
    expect(skipped).toEqual({ skipped: 'PARTICLE_API_KEY is not set' });
    const r = assess(run, counted, () => true, { particleSkipped: 'PARTICLE_API_KEY is not set', ledgerPrice });
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([expect.stringContaining("particle:particle-1: Particle's model list was not read (PARTICLE_API_KEY is not set)")]);
  });

  test('with a key it reads <PARTICLE_BASE_URL>/models with the bearer key', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      return Response.json(PARTICLE_MODELS);
    }) as unknown as typeof fetch;
    const out = await listParticleModels({ PARTICLE_API_KEY: 'k', PARTICLE_BASE_URL: 'http://127.0.0.1:8787/particle/v1' }, fetchImpl);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:8787/particle/v1/models', auth: 'Bearer k' }]);
    expect('models' in out && out.models.length).toBe(4);
  });

  test('a failed read throws when the run calls a Particle model and is a skip with its reason when it calls none; the read has a timeout', async () => {
    const inits: RequestInit[] = [];
    const down = (async (_url: string, init: RequestInit) => { inits.push(init); return new Response('upstream down', { status: 503 }); }) as unknown as typeof fetch;
    await expect(listParticleModels({ PARTICLE_API_KEY: 'k' }, down)).rejects.toThrow('Particle model list: HTTP 503');
    expect(await listParticleModels({ PARTICLE_API_KEY: 'k' }, down, { required: false })).toEqual({ skipped: 'Particle model list: HTTP 503; no Particle model is in this run' });
    expect(inits).toHaveLength(2);
    expect(inits.every(i => i.signal instanceof AbortSignal)).toBe(true);
  });

  test('every default round model has a ledger price', () => {
    expect(ROUND_MODELS.filter(m => chatPrice(m) === undefined)).toEqual([]);
  });
});

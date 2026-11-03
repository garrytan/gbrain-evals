#!/usr/bin/env bun
/**
 * Model freshness and price check, run by hand before a paid run (needs provider keys; not in CI).
 *
 *   bun scripts/model-freshness.ts [--models a,b,c]
 *
 * Reads OpenAI's, Anthropic's and Particle's model lists (free metadata endpoints), finds the newest model of each
 * family the eval rules name (Opus, Sonnet and GPT for counted runs; Fable, which runs only in smoke tests; Particle),
 * and compares them with the models a run will call (default: the 2026-10 follow-up round's set). Prints a fix
 * command for every problem. The rules are CLAUDE.md's "Choose models".
 *
 * Particle lists each model once per service tier: the default tier, and a `flex` tier at half the price. Its own
 * models carry the `particle-ai/` namespace, which is stripped (`particle-ai/particle-1` is `particle:particle-1`);
 * models it serves for other labs keep their namespace and belong to no family here. Prices are checked against the
 * default tier. Without PARTICLE_API_KEY, Particle's list is skipped with a printed reason. The key goes only where
 * compatSend would send it: a Particle API host the budget ledger prices, or loopback (a metering proxy, the fake). Any
 * other PARTICLE_BASE_URL host gets no request, and the read fails. The JSON output records
 * each called Particle model's listing (`created` and a hash of its description), for run manifests.
 *
 * Exit 0: every called model is priced and allowed, and no newer counted-family model exists.
 * Exit 0 with warnings: a newer Opus, Sonnet, GPT or Particle model exists (never a reason to change a frozen arm),
 * particle-1's listing changed since it was recorded, Particle's list was skipped, the run calls Fable (smoke tests
 * only) or gpt-4.1-mini (only as the bridge to earlier BEAM runs).
 * Exit 1: a called model has no price in this repository's ledger or in gbrain's table, is gpt-5.4-mini, or is a
 * Particle model missing from Particle's default-tier list, listed there with no price this script can read, or priced
 * in the ledger differently from it (blocks the run).
 * Exit 2: OpenAI's or Anthropic's model list could not be read, or Particle's when the run calls a Particle model
 * (for a run that calls none, a failed Particle read is a skip with its reason).
 */
import { createHash } from 'node:crypto';
import { chatPrice } from '../eval/runner/budget-ledger.ts';
import { assertMetered, compatBaseUrl, compatRequest } from '../eval/runner/providers/openai-compatible.ts';

export const ROUND_MODELS = [
  'anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-fable-5-1',
  'openai:gpt-6.1-sol', 'openai:gpt-6-luna', 'openai:gpt-5.4', 'openai:gpt-4o-2024-08-06', 'particle:particle-1',
];

/** USD per 1M tokens. */
export interface ListedPrice { input: number; cache_read: number | null; output: number }
export interface ListedModel {
  provider: 'openai' | 'anthropic' | 'particle';
  id: string;
  created: number;
  /** Particle only: `default` or the listed tier (`flex`). */
  service_tier?: string;
  price?: ListedPrice;
  /** Particle only: SHA-256 of the listing's description. */
  description_sha256?: string;
}
export type Family = 'opus' | 'sonnet' | 'fable' | 'gpt' | 'particle';

/** particle-1's default-tier listing as read on 2026-10-31 (GET /v1/models); a change warns that Particle may have changed the model behind the id. */
export const PARTICLE_LISTINGS: Record<string, { created: number; description_sha256: string; checked: string }> = {
  'particle-1': { created: 1793108609, description_sha256: '4b56656e41f583facf22d733501c50562e019ee86ed652f46dbe8303d113ae75', checked: '2026-10-31' },
};

/** Family and version of a model id, or null for ids the rules don't name (mini, luna, dated snapshots, tools, other labs' models served by Particle). */
export function classify(m: ListedModel): { family: Family; version: number[] } | null {
  if (m.provider === 'anthropic') {
    const hit = /^claude-(opus|sonnet|fable)-(\d+)(?:-(\d{1,2}))?$/.exec(m.id);
    return hit ? { family: hit[1] as Family, version: [Number(hit[2]), Number(hit[3] ?? 0)] } : null;
  }
  if (m.provider === 'particle') {
    const hit = /^particle-(\d+)(?:\.(\d+))?$/.exec(m.id);
    return hit ? { family: 'particle', version: [Number(hit[1]), Number(hit[2] ?? 0)] } : null;
  }
  const hit = /^gpt-(\d+)(?:\.(\d+))?-(sol|astra)$/.exec(m.id) ?? /^gpt-(\d+)(?:\.(\d+))?$/.exec(m.id);
  return hit ? { family: 'gpt', version: [Number(hit[1]), Number(hit[2] ?? 0)] } : null;
}

const cmp = (a: number[], b: number[]) => (a[0]! - b[0]!) || (a[1]! - b[1]!);

/** Newest id per family by version, then by provider creation time. */
export function newestByFamily(models: ListedModel[]): Record<Family, string | null> {
  const best: Record<Family, { id: string; version: number[]; created: number } | null> = { opus: null, sonnet: null, fable: null, gpt: null, particle: null };
  for (const m of models) {
    const c = classify(m);
    if (!c) continue;
    const cur = best[c.family];
    if (!cur || cmp(c.version, cur.version) > 0 || (cmp(c.version, cur.version) === 0 && m.created > cur.created)) best[c.family] = { id: m.id, version: c.version, created: m.created };
  }
  return { opus: best.opus?.id ?? null, sonnet: best.sonnet?.id ?? null, fable: best.fable?.id ?? null, gpt: best.gpt?.id ?? null, particle: best.particle?.id ?? null };
}

/** Particle's /v1/models answer as listed models: one per id and service tier, Particle's own ids without `particle-ai/`, prices per 1M tokens. */
export function particleListing(json: unknown): ListedModel[] {
  const perMillion = (pricing: unknown, type: string) => {
    const usd = Number((Array.isArray(pricing) ? pricing : []).find((p: { type?: string }) => p?.type === type)?.cost_usd);
    return Number.isFinite(usd) ? Math.round(usd * 1e12) / 1e6 : null;
  };
  return ((json as { data?: Array<Record<string, any>> })?.data ?? []).map(m => {
    const text = (m.input_modalities ?? []).find((x: { type?: string }) => x?.type === 'text');
    const out = (m.output_modalities ?? []).find((x: { type?: string }) => x?.type === 'text');
    const [input, cacheRead, output] = [perMillion(text?.pricing, 'prompt'), perMillion(text?.pricing, 'cached_prompt'), perMillion(out?.pricing, 'completion')];
    return {
      provider: 'particle' as const, id: String(m.id).replace(/^particle-ai\//, ''), created: Number(m.created), service_tier: typeof m.service_tier === 'string' ? m.service_tier : 'default',
      ...(input !== null && output !== null ? { price: { input, cache_read: cacheRead, output } } : {}),
      ...(typeof m.description === 'string' ? { description_sha256: createHash('sha256').update(m.description).digest('hex') } : {}),
    };
  });
}

/** A called Particle model's default-tier listing identity, for a run manifest; null when Particle does not list it. */
export function particleListingIdentity(listed: ListedModel[], id: string): { created: number; description_sha256: string | null } | null {
  const row = listed.find(m => m.provider === 'particle' && m.id === id && m.service_tier === 'default');
  return row ? { created: row.created, description_sha256: row.description_sha256 ?? null } : null;
}

export interface FreshnessReport { warnings: string[]; blocking: string[] }
export interface AssessOptions {
  /** Why Particle's list was not read (no key); its models' listing and price checks are skipped. */
  particleSkipped?: string | null;
  /** The ledger's price of a called model, compared with Particle's default-tier list price. */
  ledgerPrice?: (id: string) => { input: number; output: number; cache_read?: number } | undefined;
}

export function assess(called: string[], listed: ListedModel[], priced: (id: string) => boolean, options: AssessOptions = {}): FreshnessReport {
  const warnings: string[] = [];
  const blocking: string[] = [];
  const newest = newestByFamily(listed);
  const calledIds = new Set(called.map(c => c.split(':').pop()!));
  for (const [family, id] of Object.entries(newest)) {
    if (family === 'fable') continue;
    if (id && !calledIds.has(id)) warnings.push(`newer ${family} model listed: ${id} (not in this run's models; add it at the next preregistration, never to a frozen arm)`);
  }
  const money = (p: { input: number; output: number; cache_read?: number | null }) => `$${p.input} input, $${p.cache_read ?? '-'} cached, $${p.output} output per 1M`;
  for (const c of called) {
    const id = c.split(':').pop()!;
    if (id === 'gpt-5.4-mini') blocking.push(`${c} is never run (CLAUDE.md "Choose models"): drop it from the run`);
    if (/^claude-fable-/.test(id)) warnings.push(`${c} is Fable: smoke tests only, never paid counted cells, practice rounds or held-out runs (Opus 5.5 is the top counted Anthropic model)`);
    if (id === 'gpt-4.1-mini') warnings.push(`${c} runs only as the single bridge to an earlier eval's results (earlier BEAM runs); drop it if another model already links the two runs`);
    if (!priced(c)) blocking.push(`${c} has no price: register it in CHAT_PRICE_OVERRIDES in eval/runner/budget-ledger.ts (and pass --price-input/--price-output to harnesses that read gbrain's table), with the provider's pricing page as the source`);
    if (!c.startsWith('particle:')) continue;
    if (options.particleSkipped) { warnings.push(`${c}: Particle's model list was not read (${options.particleSkipped}), so its listing and list price were not checked`); continue; }
    const row = listed.find(m => m.provider === 'particle' && m.id === id && m.service_tier === 'default');
    if (!row) { blocking.push(`${c} is not in Particle's model list at the default tier: check the id at docs.particle.ai/models before calling it`); continue; }
    const ledger = options.ledgerPrice?.(c);
    if (!row.price) blocking.push(`${c}: Particle lists its default tier with no price this script can read, so the ledger price was not checked; compare docs.particle.ai/models with particleListing's pricing fields`);
    else if (ledger && (ledger.input !== row.price.input || ledger.output !== row.price.output || (ledger.cache_read ?? null) !== row.price.cache_read)) {
      blocking.push(`${c} is priced in the ledger at ${money(ledger)}, but Particle lists its default tier at ${money(row.price)}: correct CHAT_PRICE_OVERRIDES in eval/runner/budget-ledger.ts with the date checked`);
    }
    const seen = PARTICLE_LISTINGS[id];
    if (seen && (seen.created !== row.created || seen.description_sha256 !== row.description_sha256)) {
      warnings.push(`${c}'s listing changed since ${seen.checked} (created ${seen.created} -> ${row.created}, description ${seen.description_sha256.slice(0, 12)} -> ${row.description_sha256?.slice(0, 12) ?? 'none'}): Particle may have changed the model behind the id; run scripts/particle-canary.ts before a counted run and record the new listing in PARTICLE_LISTINGS`);
    }
  }
  return { warnings, blocking };
}

/**
 * Particle's list, or why it was skipped (no key). The base URL follows PARTICLE_BASE_URL like every particle request.
 * Before the request it applies compatSend's host check (`assertMetered`, on the chat request the same base URL gets),
 * so the bearer key never goes to a host that is neither a Particle API host the ledger prices nor loopback.
 * A failed read throws when the run calls a Particle model (`required`, the default); otherwise it is a skip with its
 * reason, so a run that calls no Particle model does not depend on Particle being up.
 */
export async function listParticleModels(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch, opts: { required?: boolean } = {}): Promise<{ models: ListedModel[] } | { skipped: string }> {
  if (!env.PARTICLE_API_KEY) return { skipped: 'PARTICLE_API_KEY is not set' };
  try {
    const base = compatBaseUrl('particle', env);
    const chat = compatRequest('particle:particle-1', [], {}, env);
    try { assertMetered(chat); }
    catch (e) { throw new Error(`Particle model list: PARTICLE_API_KEY is not sent to ${new URL(base).hostname}, because compatSend's host check refuses it: ${(e as Error).message}`); }
    const res = await fetchImpl(`${base}/models`, { headers: { authorization: `Bearer ${env.PARTICLE_API_KEY}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Particle model list: HTTP ${res.status}`);
    return { models: particleListing(await res.json()) };
  } catch (e) {
    if (opts.required ?? true) throw e;
    return { skipped: `${(e as Error).message}; no Particle model is in this run` };
  }
}

async function listModels(): Promise<ListedModel[]> {
  const out: ListedModel[] = [];
  const oa = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` } });
  if (!oa.ok) throw new Error(`OpenAI model list: HTTP ${oa.status}`);
  for (const m of ((await oa.json()) as { data: Array<{ id: string; created: number }> }).data) out.push({ provider: 'openai', id: m.id, created: m.created });
  const an = await fetch('https://api.anthropic.com/v1/models?limit=1000', { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' } });
  if (!an.ok) throw new Error(`Anthropic model list: HTTP ${an.status}`);
  for (const m of ((await an.json()) as { data: Array<{ id: string; created_at: string }> }).data) out.push({ provider: 'anthropic', id: m.id, created: Date.parse(m.created_at) / 1000 });
  return out;
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--models');
  const called = flag > 0 ? process.argv[flag + 1]!.split(',') : ROUND_MODELS;
  let listed: ListedModel[];
  let particle: Awaited<ReturnType<typeof listParticleModels>>;
  try {
    listed = await listModels();
    particle = await listParticleModels(process.env, fetch, { required: called.some(c => c.startsWith('particle:')) });
  } catch (e) {
    console.error(`model-freshness: ${(e as Error).message}; check the provider key and retry`);
    process.exit(2);
  }
  if ('skipped' in particle) console.log(`skip: Particle's model list (${particle.skipped})`);
  else listed.push(...particle.models);
  const priced = (id: string) => chatPrice(id) !== undefined;
  const report = assess(called, listed, priced, { particleSkipped: 'skipped' in particle ? particle.skipped : null, ledgerPrice: chatPrice });
  for (const w of report.warnings) console.log(`warning: ${w}`);
  for (const b of report.blocking) console.error(`blocking: ${b}`);
  const listings = Object.fromEntries(called.filter(c => c.startsWith('particle:')).map(c => [c, particleListingIdentity(listed, c.slice('particle:'.length))]));
  console.log(JSON.stringify({ newest: newestByFamily(listed), called, particle_listings: listings, ...report }, null, 2));
  process.exit(report.blocking.length ? 1 : 0);
}

/**
 * Process environments for the nightly's children.
 *
 * Keyless suites (system smokes, concurrency trials, the tool-contract replay, every --fake run) get keylessEnv: every
 * key-like variable removed (fixture.ts PROVIDER_KEYS, the refresh-barrier harness's own rule, which also catches the
 * Ubicloud key) and every provider base URL pointed at a dead loopback port, so a code path inside gbrain that reaches
 * for a provider fails at once instead of spending outside the ledger. A paid child gets paidEnv: the same stripped
 * environment plus only the provider keys it names, and it runs only behind --paid and an open night ledger run.
 * A paid process that loads gbrain in process (worker.ts agents) builds its provider fetch once from the key (Part C's
 * keyedFetch) and strips every key from its own environment before any brain opens (stripKeys).
 */
import { PROVIDER_KEYS } from '../refresh-barrier/fixture.ts';

/** Nothing listens here: port 9 is the discard service, which no machine in this setup runs. */
export const DEAD_UPSTREAM = 'http://127.0.0.1:9';
export const BASE_URL_VARS = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'VOYAGE_BASE_URL', 'GOOGLE_GENERATIVE_AI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL',
  'GEMINI_OPENAI_BASE_URL', 'PARTICLE_BASE_URL', 'OPENROUTER_BASE_URL', 'GROQ_BASE_URL', 'LITELLM_BASE_URL', 'CLAUDE_BASE_URL', 'CHATGPT_BASE_URL'] as const;
export const PROVIDER_KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY', particle: 'PARTICLE_API_KEY', gemini: 'GEMINI_API_KEY' } as const;
export type Provider = keyof typeof PROVIDER_KEY_ENV;

/** Names of the key-like variables in env (names only; values are never read here). */
export const keyLikeVariables = (env: Record<string, string | undefined>) => Object.keys(env).filter(k => PROVIDER_KEYS.test(k) && env[k] !== undefined);

const stripped = (env: Record<string, string | undefined>) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PROVIDER_KEYS.test(k)) out[k] = v;
  return out;
};

export function keylessEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out = stripped(env);
  for (const k of BASE_URL_VARS) out[k] = DEAD_UPSTREAM;
  out.GBRAIN_MODEL_DISCOVERY = 'off';
  return out;
}

/** The stripped environment plus the named providers' keys, for a child that spends behind the ledger. */
export function paidEnv(providers: readonly Provider[], env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out = stripped(env);
  for (const p of providers) {
    const name = PROVIDER_KEY_ENV[p];
    if (!env[name]) throw new Error(`${name} is not set; a paid nightly suite needs it`);
    out[name] = env[name]!;
  }
  return out;
}

/** Delete every key-like variable from this process's environment (after the provider fetch was built). */
export function stripKeys(env: Record<string, string | undefined> = process.env): void {
  for (const k of Object.keys(env)) if (PROVIDER_KEYS.test(k)) delete env[k];
}

/**
 * Shared hermetic environment for keyless category runs (eval-category wave
 * step 0, plan section 8).
 *
 * A hermetic arm measures what a user gets from gbrain with no provider key:
 * keyword search, no model call, and System One (decide) off. Before this
 * helper every runner kept its own key list, none stripped the TypeSafe keys,
 * and N3 read the real GBRAIN_HOME, so `~/.gbrain/.env` could put keys back
 * (gbrain's loadConfig fills process.env from it).
 *
 * enterHermeticEnv():
 *   - deletes every provider credential and endpoint from process.env: the
 *     explicit list below plus anything matching HERMETIC_KEY_PATTERN, which
 *     covers *_API_KEY names gbrain adds later;
 *   - deletes GBRAIN_DECIDE_SLOTS, the eval override that can turn decide
 *     slots on;
 *   - points GBRAIN_HOME at a fresh empty temp directory, so no
 *     `.gbrain/config.json` or `.gbrain/.env` is read;
 *   - returns restore(), which puts every variable back exactly as it was
 *     (removing keys set during the run) and deletes the temp home.
 *
 * System One is off by construction: gbrain turns a decide slot on only with
 * a TypeSafe key (key-aware defaults), an explicit `decide.*` config value
 * (none exists in a fresh in-memory brain under an empty GBRAIN_HOME), or
 * GBRAIN_DECIDE_SLOTS in a process that opted in. assertSystemOneOff checks
 * all three preconditions and fails with fixed problem, cause and fix wording.
 * Receipts record DECIDE_OFF in resolved_config.decide.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What a hermetic receipt records about System One. */
export const DECIDE_OFF = 'off (no key, fresh GBRAIN_HOME)';

/** TypeSafe (Jev) key names gbrain accepts (src/core/ai/recipes/typesafe.ts TYPESAFE_KEY_ENV). */
export const TYPESAFE_KEYS = ['TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY'] as const;

/**
 * Credentials and endpoints gbrain reads at the pinned commit (grep of src/ for
 * *_API_KEY, *_TOKEN and *_BASE_URL), plus the names earlier runners stripped.
 */
export const HERMETIC_STRIPPED_KEYS = [
  ...TYPESAFE_KEYS,
  'GBRAIN_DECIDE_SLOTS',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY',
  'TOGETHER_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'ZEROENTROPY_API_KEY', 'AZURE_OPENAI_API_KEY',
  'DASHSCOPE_API_KEY', 'ZHIPUAI_API_KEY', 'MOONSHOT_API_KEY', 'MINIMAX_API_KEY', 'NVIDIA_API_KEY',
  'PERPLEXITY_API_KEY', 'PPLX_API_KEY', 'DEEPGRAM_API_KEY', 'NAN_API_KEY', 'OLLAMA_API_KEY',
  'LMSTUDIO_API_KEY', 'LITELLM_API_KEY', 'LLAMA_SERVER_API_KEY', 'LLAMA_SERVER_RERANKER_API_KEY', 'OPENAPI_API_KEY',
  'X_API_BEARER_TOKEN',
  'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENROUTER_BASE_URL', 'LITELLM_BASE_URL', 'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL', 'LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_RERANKER_BASE_URL', 'CHATGPT_BASE_URL', 'CLAUDE_BASE_URL',
] as const;

/** Any provider credential gbrain might add later. */
export const HERMETIC_KEY_PATTERN = /(_API_KEY|_API_TOKEN|_BEARER_TOKEN)$|^(TYPESAFE|JEV)_/;

export interface HermeticEnv {
  /** The throwaway GBRAIN_HOME. */
  home: string;
  /** Names that were set and are now removed (never their values). */
  stripped: string[];
  decide: typeof DECIDE_OFF;
  /** Put every touched variable back and delete the temp home. Idempotent. */
  restore(): void;
}

/** The variables enterHermeticEnv removes from `env`, sorted. */
export function strippedKeysIn(env: Record<string, string | undefined>): string[] {
  const listed = new Set<string>(HERMETIC_STRIPPED_KEYS);
  return Object.keys(env).filter(k => env[k] !== undefined && (listed.has(k) || HERMETIC_KEY_PATTERN.test(k))).sort();
}

export function enterHermeticEnv(label: string, env: Record<string, string | undefined> = process.env): HermeticEnv {
  const stripped = strippedKeysIn(env);
  const saved = Object.fromEntries([...stripped, 'GBRAIN_HOME'].map(k => [k, env[k]]));
  for (const k of stripped) delete env[k];
  const home = mkdtempSync(join(tmpdir(), `${label}-home-`));
  env.GBRAIN_HOME = home;
  let restored = false;
  return {
    home, stripped, decide: DECIDE_OFF,
    restore() {
      if (restored) return;
      restored = true;
      for (const k of new Set([...Object.keys(saved), ...strippedKeysIn(env)])) {
        const v = saved[k];
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Run fn inside the hermetic environment. System One's preconditions are
 * checked before fn and again after it, so a run during which something wrote
 * a key or a gbrain config back throws instead of returning a result. The
 * environment is restored on return and on throw.
 */
export async function withHermeticEnv<T>(label: string, fn: (h: HermeticEnv) => Promise<T>): Promise<T> {
  const h = enterHermeticEnv(label);
  try {
    assertSystemOneOff(h.home);
    const result = await fn(h);
    assertSystemOneOff(h.home);
    return result;
  } finally {
    h.restore();
  }
}

export class SystemOneOnError extends Error {
  constructor(readonly causes: string[]) {
    super(
      `System One may be on because ${causes.join('; ')}. This category measures the keyless default. `
      + `Unset TYPESAFE_API_KEY, JEV_TYPESAFE_API_KEY and GBRAIN_DECIDE_SLOTS, or run \`gbrain decide disable --all\` in the overlay, then rerun.`,
    );
    this.name = 'SystemOneOnError';
  }
}

/**
 * Prove the decide preconditions are absent: no TypeSafe key, no
 * GBRAIN_DECIDE_SLOTS, and a GBRAIN_HOME that is the expected empty directory.
 * Call it again after gbrain is loaded to catch anything that wrote keys back.
 */
export function assertSystemOneOff(expectedHome: string, env: Record<string, string | undefined> = process.env): void {
  const causes: string[] = [];
  const keys = TYPESAFE_KEYS.filter(k => env[k]?.trim());
  if (keys.length) causes.push(`a TypeSafe key is in the environment (${keys.join(', ')})`);
  if (env.GBRAIN_DECIDE_SLOTS?.trim()) causes.push('GBRAIN_DECIDE_SLOTS is set');
  if (env.GBRAIN_HOME !== expectedHome) causes.push(`GBRAIN_HOME is ${env.GBRAIN_HOME ?? 'unset'}, not the fresh hermetic home`);
  else {
    const configured = ['config.json', '.env'].filter(f => existsSync(join(expectedHome, '.gbrain', f)));
    if (configured.length) causes.push(`the hermetic GBRAIN_HOME holds ${configured.map(f => `.gbrain/${f}`).join(' and ')}`);
  }
  if (causes.length) throw new SystemOneOnError(causes);
}

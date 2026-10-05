/**
 * Arm config for category runners: any gbrain config key, not only search pins.
 *
 *   GBRAIN_EVAL_CONFIG="wanted_pages.enabled=true,line_grammar.enabled=false"
 *
 * The decision kit (eval/runner/decide.ts) sets it per arm for category
 * sources whose spec says `config_channel: true`; search.* keys keep their own
 * channel (GBRAIN_EVAL_SEARCH_PINS, relational-ab.ts evalSearchPins). A runner
 * that honors this channel calls applyEvalConfig on a fresh brain before it
 * writes any page: every key is set with engine.setConfig, read back with
 * engine.getConfig, and a mismatch throws, so an arm never runs with a
 * config it did not ask for. The receipt records evalConfigRecord, including
 * the keys the build under test does not list in KNOWN_CONFIG_KEYS (a build
 * without the feature stores the key and ignores it).
 */

export const EVAL_CONFIG_ENV = 'GBRAIN_EVAL_CONFIG';

const KEY_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;

/** Parse `key=value,key=value`. Values may not contain commas. A key named twice with different values throws. */
export function parseEvalConfig(raw: string | undefined = process.env[EVAL_CONFIG_ENV]): Record<string, string> {
  const config: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const key = eq > 0 ? part.slice(0, eq).trim() : '';
    if (!KEY_RE.test(key)) throw new Error(`${EVAL_CONFIG_ENV}: "${part}" is not <config key>=<value> (for example wanted_pages.enabled=true)`);
    const value = part.slice(eq + 1).trim();
    if (key in config && config[key] !== value) throw new Error(`${EVAL_CONFIG_ENV}: ${key} is set twice (${config[key]} and ${value})`);
    config[key] = value;
  }
  return config;
}

export interface ConfigEngine {
  setConfig(key: string, value: string): Promise<void>;
  getConfig(key: string): Promise<string | null>;
  executeRaw?<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface AppliedEvalConfig {
  requested: Record<string, string>;
  readback: Record<string, string | null>;
}

/**
 * Set every key, then read every key back. Throws when a value does not read
 * back exactly, or when the brain already holds pages (config must be in place
 * before the first write, or early pages extract under the old settings).
 */
export async function applyEvalConfig(engine: ConfigEngine, config: Record<string, string>): Promise<AppliedEvalConfig> {
  if (engine.executeRaw && Object.keys(config).length) {
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
    if (Number(row?.n ?? 0) > 0) throw new Error(`${EVAL_CONFIG_ENV}: the brain already holds ${row.n} page(s); apply arm config before the first write`);
  }
  for (const [key, value] of Object.entries(config)) await engine.setConfig(key, value);
  const readback: Record<string, string | null> = {};
  for (const key of Object.keys(config)) readback[key] = await engine.getConfig(key);
  const wrong = Object.keys(config).filter(key => readback[key] !== config[key]);
  if (wrong.length) {
    throw new Error(`${EVAL_CONFIG_ENV}: config did not read back as set: ${wrong.map(k => `${k} set ${JSON.stringify(config[k])}, read ${JSON.stringify(readback[k])}`).join('; ')}`);
  }
  return { requested: { ...config }, readback };
}

/** Receipt block: what was asked, what read back, and which keys the build does not know. */
export function evalConfigRecord(applied: AppliedEvalConfig, knownKeys: readonly string[] | null): Record<string, unknown> {
  return {
    channel: EVAL_CONFIG_ENV,
    requested: applied.requested,
    readback: applied.readback,
    unknown_to_build: knownKeys ? Object.keys(applied.requested).filter(k => !knownKeys.includes(k)) : null,
  };
}

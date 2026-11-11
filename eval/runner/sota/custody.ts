/**
 * The custody provider check (SOTA plan item 11). Sealed RS1 text may reach only the providers RS1 vetted: for gbrain's
 * embeddings and reranking that is Voyage (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, "Provider data
 * use"). Before any custody run at a later gbrain version, this reads the embedding and rerank models that version
 * configures and refuses when one names another provider, so sealed text never reaches an unvetted provider until
 * GBEV-3 rules.
 *
 *   bun eval/runner/sota/custody.ts check-providers --gbrain <gbrain checkout at the version to run> [--config <json>]
 *
 * The models are read as text, never by importing the checkout's code: DEFAULT_EMBEDDING_MODEL and
 * DEFAULT_RERANKER_MODEL from src/core/ai/defaults.ts, every reranker_model literal shaped as a model id in the search
 * mode bundles (src/core/search/mode.ts; its config-key map is not one), and the run's own overrides (--config: embedding_model and search.reranker.model). A model
 * id is <provider>:<model>. A constant that can't be found refuses too (fail closed). Exit 0 passes; exit 7 refuses with
 * CUSTODY_PROVIDER_CHANGED or CUSTODY_PROVIDER_UNKNOWN.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REFUSE_EXIT = 7;
export type Role = 'embedding' | 'rerank';
/** RS1's provider table for gbrain's own calls. */
export const RS1_PROVIDERS: Readonly<Record<Role, readonly string[]>> = { embedding: ['voyage'], rerank: ['voyage'] };
export const RS1_TABLE = 'docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md (Provider data use)';

export interface Configured { role: Role; model: string; from: string }

const constant = (text: string, name: string) => new RegExp(`export const ${name}\\s*=\\s*['"]([^'"]+)['"]`).exec(text)?.[1] ?? null;

/** The embedding and rerank models a gbrain checkout configures, plus the run's overrides; throws CUSTODY_PROVIDER_UNKNOWN when a default can't be read. */
export function configuredModels(gbrain: string, config: Record<string, unknown> = {}): Configured[] {
  const defaults = join(gbrain, 'src/core/ai/defaults.ts'), mode = join(gbrain, 'src/core/search/mode.ts');
  const text = existsSync(defaults) ? readFileSync(defaults, 'utf8') : '';
  const embedding = constant(text, 'DEFAULT_EMBEDDING_MODEL'), rerank = constant(text, 'DEFAULT_RERANKER_MODEL');
  if (!embedding || !rerank) throw new Error(`CUSTODY_PROVIDER_UNKNOWN: ${defaults} names no ${!embedding ? 'DEFAULT_EMBEDDING_MODEL' : 'DEFAULT_RERANKER_MODEL'} literal, so the providers this gbrain calls can't be checked`);
  const out: Configured[] = [{ role: 'embedding', model: embedding, from: 'src/core/ai/defaults.ts DEFAULT_EMBEDDING_MODEL' }, { role: 'rerank', model: rerank, from: 'src/core/ai/defaults.ts DEFAULT_RERANKER_MODEL' }];
  if (existsSync(mode)) for (const m of readFileSync(mode, 'utf8').matchAll(/reranker_model:\s*['"]([a-z0-9_-]+:[^'"]+)['"]/gi)) out.push({ role: 'rerank', model: m[1]!, from: 'src/core/search/mode.ts reranker_model' });
  if (typeof config.embedding_model === 'string') out.push({ role: 'embedding', model: config.embedding_model, from: '--config embedding_model' });
  if (typeof config['search.reranker.model'] === 'string') out.push({ role: 'rerank', model: config['search.reranker.model'], from: '--config search.reranker.model' });
  return out;
}

/** The configured models whose provider RS1 did not vet for their role. */
export function unvetted(models: readonly Configured[], table = RS1_PROVIDERS): Array<Configured & { provider: string }> {
  return models.map(m => ({ ...m, provider: m.model.includes(':') ? m.model.split(':')[0]! : '(no provider prefix)' })).filter(m => !table[m.role].includes(m.provider));
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

export function main(argv: string[], log: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const [command, ...rest] = argv;
  const gbrain = flag(rest, '--gbrain');
  if (command !== 'check-providers' || !gbrain) { err('usage: bun eval/runner/sota/custody.ts check-providers --gbrain <checkout> [--config <json>]'); return 2; }
  const config = flag(rest, '--config') ? JSON.parse(readFileSync(flag(rest, '--config')!, 'utf8')) as Record<string, unknown> : {};
  let models: Configured[];
  try { models = configuredModels(gbrain, config); } catch (e) { err(e instanceof Error ? e.message : String(e)); return REFUSE_EXIT; }
  const bad = unvetted(models);
  if (bad.length) {
    err([`CUSTODY_PROVIDER_CHANGED: this gbrain would send sealed text to a provider RS1 did not vet (${RS1_TABLE}); the custody run is refused until GBEV-3 rules`,
      ...bad.map(b => `  ${b.role}: ${b.model} (provider ${b.provider}, from ${b.from}); RS1 vetted ${RS1_PROVIDERS[b.role].join(', ')}`)].join('\n'));
    return REFUSE_EXIT;
  }
  log(JSON.stringify({ ok: true, models: models.map(m => `${m.role} ${m.model} (${m.from})`) }, null, 1));
  return 0;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}

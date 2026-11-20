/**
 * The custody provider check (eval/runner/sota/custody.ts): a gbrain whose embedding or rerank model names a provider
 * RS1 did not vet is refused, from its defaults, its search mode bundles or the run's own overrides, and a checkout whose
 * defaults can't be read is refused too. Keyless: the checkouts are fixtures, read as text.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configuredModels, main, REFUSE_EXIT, RS1_PROVIDERS, unvetted } from '../../eval/runner/sota/custody.ts';

const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
function checkout(o: { embedding?: string | null; rerank?: string | null; bundles?: string[] } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'sota-custody-')); roots.push(d);
  mkdirSync(join(d, 'src/core/ai'), { recursive: true }); mkdirSync(join(d, 'src/core/search'), { recursive: true });
  const line = (name: string, v: string | null | undefined, dflt: string) => (v === null ? '' : `export const ${name} = '${v ?? dflt}';\n`);
  writeFileSync(join(d, 'src/core/ai/defaults.ts'), line('DEFAULT_EMBEDDING_MODEL', o.embedding, 'voyage:voyage-4') + 'export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;\n' + line('DEFAULT_RERANKER_MODEL', o.rerank, 'voyage:rerank-3-lite'));
  writeFileSync(join(d, 'src/core/search/mode.ts'), ['const a = { reranker_model: DEFAULT_RERANKER_MODEL };', ...(o.bundles ?? []).map(b => `const b = { reranker_model: '${b}' };`)].join('\n') + '\n');
  return d;
}
const run = (argv: string[]) => { const out: string[] = [], err: string[] = []; const code = main(argv, s => out.push(s), s => err.push(s)); return { code, out: out.join('\n'), err: err.join('\n') }; };

describe('custody provider check', () => {
  test('RS1 vetted Voyage for gbrain\'s embeddings and reranking', () => {
    expect(RS1_PROVIDERS).toEqual({ embedding: ['voyage'], rerank: ['voyage'] });
  });

  test('a gbrain on RS1\'s providers passes', () => {
    const r = run(['check-providers', '--gbrain', checkout()]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, models: ['embedding voyage:voyage-4 (src/core/ai/defaults.ts DEFAULT_EMBEDDING_MODEL)', 'rerank voyage:rerank-3-lite (src/core/ai/defaults.ts DEFAULT_RERANKER_MODEL)'] });
  });

  test('a changed embedding provider is refused', () => {
    const r = run(['check-providers', '--gbrain', checkout({ embedding: 'openai:text-embedding-3-large' })]);
    expect(r.code).toBe(REFUSE_EXIT);
    expect(r.err).toStartWith('CUSTODY_PROVIDER_CHANGED:');
    expect(r.err).toContain('embedding: openai:text-embedding-3-large (provider openai, from src/core/ai/defaults.ts DEFAULT_EMBEDDING_MODEL); RS1 vetted voyage');
  });

  test('a changed rerank provider is refused, in the defaults or in a mode bundle', () => {
    expect(run(['check-providers', '--gbrain', checkout({ rerank: 'zeroentropyai:zerank-2' })]).err).toContain('rerank: zeroentropyai:zerank-2 (provider zeroentropyai');
    const bundle = run(['check-providers', '--gbrain', checkout({ bundles: ['cohere:rerank-v4'] })]);
    expect(bundle.code).toBe(REFUSE_EXIT);
    expect(bundle.err).toContain('rerank: cohere:rerank-v4 (provider cohere, from src/core/search/mode.ts reranker_model)');
  });

  test('the run\'s own overrides count, and a model with no provider prefix is refused', () => {
    const d = checkout(), cfg = join(d, 'config.json');
    writeFileSync(cfg, JSON.stringify({ embedding_model: 'google:gemini-embedding-002', 'search.reranker.model': 'voyage:rerank-3' }));
    const r = run(['check-providers', '--gbrain', d, '--config', cfg]);
    expect(r.code).toBe(REFUSE_EXIT);
    expect(r.err).toContain('embedding: google:gemini-embedding-002 (provider google, from --config embedding_model)');
    expect(r.err).not.toContain('voyage:rerank-3 ');
    expect(unvetted([{ role: 'rerank', model: 'rerank-3', from: 'x' }])).toEqual([{ role: 'rerank', model: 'rerank-3', from: 'x', provider: '(no provider prefix)' }]);
  });

  test('defaults that cannot be read are refused', () => {
    expect(run(['check-providers', '--gbrain', checkout({ rerank: null })])).toMatchObject({ code: REFUSE_EXIT });
    expect(run(['check-providers', '--gbrain', checkout({ embedding: null })]).err).toStartWith('CUSTODY_PROVIDER_UNKNOWN:');
    expect(run(['check-providers', '--gbrain', join(tmpdir(), 'no-such-gbrain')]).code).toBe(REFUSE_EXIT);
    expect(run(['check-providers']).code).toBe(2);
  });

  test('the pinned gbrain passes', () => {
    const pinned = resolve(import.meta.dir, '../../node_modules/gbrain');
    expect(unvetted(configuredModels(pinned))).toEqual([]);
  });
});

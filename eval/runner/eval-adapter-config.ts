/**
 * Embedder-shootout adapter config (v0.35.1.0+).
 *
 * Typed sidecar for `AdapterConfig` so the vector + hybrid adapters can
 * be re-targeted per matrix cell without parsing env-var strings inside
 * each adapter. Constructed by the matrix runner and passed in via
 * `AdapterConfig.shootout`.
 *
 * Cells under test (per docs/designs/2026_05_EVAL_PLAN.md in gbrain):
 *   A0/A1: openai:text-embedding-3-large @ 1536, ±zerank-2
 *   B0/B1: voyage:voyage-4-large       @ 2048, ±zerank-2
 *   C0/C1: zeroentropyai:zembed-1      @ 2560, ±zerank-2
 *   C2:    zeroentropyai:zembed-1      @ 1280, +zerank-2 (Matryoshka ablation)
 *
 * Adapters read this and call `gbrain/ai/gateway`'s `configureGateway()`
 * at the top of `init()` so every `embed*` + `hybridSearch` downstream
 * routes through the configured provider. `searchMode` ('tokenmax' in
 * the shootout) plus reranker on/off are threaded via engine config
 * (`engine.setConfig`) inside the hybrid adapter.
 */

export interface EvalAdapterConfig {
  /** `provider:model` string passed through to gateway's `embedding_model`. */
  embedder: string;
  /** Vector width — must match a recipe-allowed value for the provider. */
  dim: number;
  /**
   * Optional reranker model id. When set AND the hybrid adapter is in use,
   * the adapter also sets `search.reranker.enabled=true` on the engine.
   * Leave unset for the "no rerank" matrix cells.
   */
  reranker?: string;
  /**
   * Search-lite mode bundle. The shootout pins `tokenmax`. Threaded into
   * the hybrid adapter via `engine.setConfig('search.mode', ...)` BEFORE
   * the first `hybridSearch` call.
   */
  searchMode?: 'conservative' | 'balanced' | 'tokenmax';
  /**
   * Human-readable cell label for receipts / scorecards (e.g. "B1", "C2").
   * Optional; runner uses it for filename templates if set.
   */
  cell?: string;
}

/**
 * Throws on missing required fields at adapter `init()` so a typo in the
 * runner wrapper surfaces BEFORE we burn API tokens embedding 240 pages
 * with the wrong dim.
 */
export function assertEvalAdapterConfig(c: unknown): asserts c is EvalAdapterConfig {
  if (typeof c !== 'object' || c === null) {
    throw new Error('EvalAdapterConfig: expected object, got ' + typeof c);
  }
  const o = c as Record<string, unknown>;
  if (typeof o.embedder !== 'string' || !o.embedder.includes(':')) {
    throw new Error('EvalAdapterConfig.embedder must be a "provider:model" string (got: ' + JSON.stringify(o.embedder) + ')');
  }
  if (typeof o.dim !== 'number' || !Number.isInteger(o.dim) || o.dim <= 0) {
    throw new Error('EvalAdapterConfig.dim must be a positive integer (got: ' + JSON.stringify(o.dim) + ')');
  }
  if (o.reranker !== undefined && (typeof o.reranker !== 'string' || !o.reranker.includes(':'))) {
    throw new Error('EvalAdapterConfig.reranker, when set, must be a "provider:model" string');
  }
  if (o.searchMode !== undefined &&
      o.searchMode !== 'conservative' && o.searchMode !== 'balanced' && o.searchMode !== 'tokenmax') {
    throw new Error('EvalAdapterConfig.searchMode must be one of conservative|balanced|tokenmax');
  }
}

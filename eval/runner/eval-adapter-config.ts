/**
 * Embedder-shootout adapter config (v0.35.1.0+).
 *
 * Typed sidecar for `AdapterConfig` so the vector + hybrid adapters can
 * be re-targeted per matrix cell without parsing env-var strings inside
 * each adapter. Constructed by the matrix runner and passed in via
 * `AdapterConfig.shootout`.
 *
 * Current cells use OpenAI 1536d and Voyage 2048d, without reranking or
 * with voyage:rerank-2.5. Reranked cells carry the model in their names
 * so historical results cannot be reused for the new configurations.
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
   * Human-readable cell label for receipts / scorecards (e.g. "A0", "B0").
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

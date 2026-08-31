#!/usr/bin/env bun
/**
 * Embedder-shootout 3-phase smoke harness (v0.35.1.0+).
 *
 * Pre-flight gate for each matrix cell. Exits non-zero on any failure so
 * the wrapper script can abort the cell BEFORE spending judge dollars on
 * 500 LongMemEval questions.
 *
 *   Phase 1 — wiring:        5 small queries × embed roundtrip. Asserts
 *                            the returned vector has the configured dim
 *                            (catches dim-typo before the FIRST page is
 *                            embedded).
 *   Phase 2 — long-haystack: 1 query × ~50K-token synthetic haystack.
 *                            Asserts the embed call doesn't hit a token-
 *                            limit error and per-cell long-content paths
 *                            stay below provider caps.
 *   Phase 3 — rerank payload: only when --reranker is set. 30 ~400-token
 *                            documents → asserts the body stays under the
 *                            recipe's max_payload_bytes (ZE: 5MB cap).
 *                            Verifies a real reranker call succeeds end-
 *                            to-end against the live API.
 *
 * Usage:
 *   bun run eval/runner/smoke.ts \
 *     --embedder openai:text-embedding-3-large \
 *     --dim 1536
 *     [--reranker zeroentropyai:zerank-2]
 */

import { configureGateway, embed } from 'gbrain/ai/gateway';
import { assertEvalAdapterConfig, type EvalAdapterConfig } from './eval-adapter-config.ts';

interface ParsedArgs {
  help: boolean;
  embedder?: string;
  dim?: number;
  reranker?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--embedder') out.embedder = argv[++i];
    else if (a === '--dim') out.dim = Number(argv[++i]);
    else if (a === '--reranker') out.reranker = argv[++i];
  }
  return out;
}

function printHelp(): void {
  process.stderr.write(
    'eval:smoke — gate the matrix cell before spending money\n\n' +
    'Required:\n' +
    '  --embedder <provider:model>     e.g. openai:text-embedding-3-large\n' +
    '  --dim <N>                       Configured vector width\n\n' +
    'Optional:\n' +
    '  --reranker <provider:model>     e.g. zeroentropyai:zerank-2\n' +
    '                                  Enables Phase 3 (skipped otherwise).\n\n' +
    'Env (fail-loud at run start if any required key is missing):\n' +
    '  OPENAI_API_KEY  | VOYAGE_API_KEY  | ZEROENTROPY_API_KEY\n',
  );
}

/** Phase 1: short queries; assert dim. */
async function phaseWiring(cfg: EvalAdapterConfig): Promise<void> {
  const queries = [
    'what is the capital of france',
    'how does photosynthesis work',
    'list three primary colors',
    'what year did world war two end',
    'name a popular programming language',
  ];
  const vectors = await embed(queries);
  if (vectors.length !== queries.length) {
    throw new Error(`Phase 1 wiring: expected ${queries.length} vectors, got ${vectors.length}`);
  }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v || v.length === undefined) {
      throw new Error(`Phase 1 wiring: vector ${i} is missing or shapeless`);
    }
    if (v.length !== cfg.dim) {
      throw new Error(
        `Phase 1 wiring: vector ${i} has dim ${v.length}, expected ${cfg.dim} (config drift!)`,
      );
    }
  }
  process.stderr.write(
    `  [phase 1 wiring] ok — ${vectors.length} vectors @ dim=${cfg.dim}\n`,
  );
}

/** Phase 2: a genuinely large payload through the embed path.
 *
 * HONESTY (audit finding orchestrators-08): gbrain's gateway truncates every
 * individual input to MAX_CHARS = 8000 (ai/gateway.ts:104/:1880), so the old
 * "one 175K-char string ≈ 50K tokens" never reached the provider — the gate
 * was testing an 8K string while claiming 50K tokens. What the embed path
 * can genuinely be stressed with is BATCH volume: many distinct inputs near
 * the per-input cap, exercising the gateway's token-budget batch splitting
 * (splitByTokenBudget) and the provider's real large-payload behavior. */
async function phaseLongHaystack(cfg: EvalAdapterConfig): Promise<void> {
  const COUNT = 32;
  const PER_INPUT_CHARS = 7_500; // just under gbrain's MAX_CHARS=8000 truncation
  const inputs = Array.from({ length: COUNT }, (_, i) => {
    const sentence = `Haystack document ${i}: the quick brown fox jumps over lazy dog number ${i}. `;
    return sentence.repeat(Math.ceil(PER_INPUT_CHARS / sentence.length)).slice(0, PER_INPUT_CHARS);
  });
  const totalChars = inputs.reduce((s, t) => s + t.length, 0);
  process.stderr.write(
    `  [phase 2 long-haystack] sending ${COUNT} distinct inputs, ${totalChars.toLocaleString()} chars aggregate (per-input <8K = gbrain's truncation cap)\n`,
  );
  const vectors = await embed(inputs);
  if (vectors.length !== COUNT) {
    throw new Error(`Phase 2 long-haystack: expected ${COUNT} vectors, got ${vectors.length}`);
  }
  for (const v of vectors) {
    if (v.length !== cfg.dim) throw new Error(`Phase 2 long-haystack: dim mismatch (${v.length} != ${cfg.dim})`);
  }
  // Distinct inputs must not collapse to identical vectors (catches a
  // batching/caching bug that maps every value to the first embedding).
  const first = JSON.stringify(vectors[0]);
  if (vectors.every(v => JSON.stringify(v) === first)) {
    throw new Error('Phase 2 long-haystack: all vectors identical — embed path is collapsing distinct inputs');
  }
  process.stderr.write(
    `  [phase 2 long-haystack] ok — ${COUNT} distinct vectors @ dim=${cfg.dim}\n`,
  );
}

/** Phase 3: reranker payload. Lazy-imports gbrain rerank so non-reranked
 *  cells skip the import cleanly. */
async function phaseRerankerPayload(cfg: EvalAdapterConfig): Promise<void> {
  if (!cfg.reranker) {
    process.stderr.write(`  [phase 3 reranker] skipped — no --reranker set\n`);
    return;
  }
  const { rerank } = await import('gbrain/ai/gateway');
  // 30 docs × ~400 tokens each = ~12K tokens (well under ZE's 5MB cap
  // but exercising the topNIn=30 path the production search uses).
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. ';
  const docs = Array.from({ length: 30 }, (_, i) => `Doc ${i + 1}: ${para.repeat(2)}`);
  const result = await rerank({
    model: cfg.reranker,
    query: 'find the most relevant document about lorem ipsum',
    documents: docs,
    topN: 5,
  });
  if (!result || !Array.isArray(result) || result.length === 0) {
    throw new Error('Phase 3 reranker: empty response');
  }
  // Each result should carry relevanceScore + index.
  for (const r of result) {
    if (typeof r.relevanceScore !== 'number' || typeof r.index !== 'number') {
      throw new Error('Phase 3 reranker: malformed result entry: ' + JSON.stringify(r));
    }
  }
  process.stderr.write(
    `  [phase 3 reranker] ok — got ${result.length} ranked docs from ${cfg.reranker}\n`,
  );
}

function detectMissingKey(provider: string): string | null {
  const p = provider.toLowerCase();
  if (p === 'openai' && !process.env.OPENAI_API_KEY) return 'OPENAI_API_KEY';
  if (p === 'voyage' && !process.env.VOYAGE_API_KEY) return 'VOYAGE_API_KEY';
  if (p === 'zeroentropyai' && !process.env.ZEROENTROPY_API_KEY) return 'ZEROENTROPY_API_KEY';
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.embedder || !args.dim) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const cfg: EvalAdapterConfig = {
    embedder: args.embedder!,
    dim: args.dim!,
    reranker: args.reranker,
    searchMode: 'tokenmax',
  };
  try {
    assertEvalAdapterConfig(cfg);
  } catch (e: any) {
    process.stderr.write(`smoke: config invalid: ${e.message ?? e}\n`);
    process.exit(2);
  }

  const provider = cfg.embedder.split(':')[0];
  const missing = detectMissingKey(provider);
  if (missing) {
    process.stderr.write(`smoke: ${missing} is not set in env\n`);
    process.exit(3);
  }
  if (cfg.reranker) {
    const rerankProvider = cfg.reranker.split(':')[0];
    const rerankMissing = detectMissingKey(rerankProvider);
    if (rerankMissing) {
      process.stderr.write(`smoke: ${rerankMissing} (for reranker) is not set in env\n`);
      process.exit(3);
    }
  }

  process.stderr.write(`[smoke] cell embedder=${cfg.embedder} dim=${cfg.dim}${cfg.reranker ? ` reranker=${cfg.reranker}` : ''}\n`);

  configureGateway({
    embedding_model: cfg.embedder,
    embedding_dimensions: cfg.dim,
    reranker_model: cfg.reranker,
    env: process.env as Record<string, string | undefined>,
  });

  try {
    await phaseWiring(cfg);
    await phaseLongHaystack(cfg);
    await phaseRerankerPayload(cfg);
  } catch (e: any) {
    process.stderr.write(`[smoke] FAILED: ${e.message ?? e}\n`);
    process.exit(4);
  }

  process.stderr.write(`[smoke] OK\n`);
}

if (import.meta.main) {
  await main();
}

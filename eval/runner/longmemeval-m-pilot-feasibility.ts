import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMarkdown } from '../../node_modules/gbrain/src/core/markdown.ts';
import { prepareMarkdownChunks } from '../../node_modules/gbrain/src/core/markdown-chunks.ts';
import { buildCueWindows } from '../../node_modules/gbrain/src/core/memory-cues/windows.ts';
import { CUE_SYSTEM_PROMPT } from '../../node_modules/gbrain/src/core/memory-cues/providers.ts';
import { sanitizeText } from '../../node_modules/gbrain/src/core/batch-rows.ts';
import { buildContextualPrefix, sanitizeTitle, wrapChunkForEmbedding } from '../../node_modules/gbrain/src/core/embedding-context.ts';
import { renderSession } from './longmemeval.ts';

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

interface Source {
  occurrence_index: number;
  session_id: string;
  date?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

async function main() {
  const manifestPath = process.argv[2];
  const embeddingOnly = process.argv[3] === '--embedding-only';
  if (!manifestPath || process.argv.length !== (embeddingOnly ? 4 : 3)) throw new Error('usage: bun eval/runner/longmemeval-m-pilot-feasibility.ts <frozen-manifest.json> [--embedding-only]');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const product = resolve(import.meta.dir, '../../node_modules/gbrain');
  const version = JSON.parse(readFileSync(resolve(product, 'package.json'), 'utf8'));
  const windowImplementation = readFileSync(resolve(product, 'src/core/memory-cues/windows.ts'));
  const chunkImplementation = readFileSync(resolve(product, 'src/core/chunkers/recursive.ts'));
  const counts: Record<string, { sessions: number; rendered_bytes: number; production_chunks: number; max_chunks_per_session: number;
    chunk_text_bytes: number; max_chunk_text_bytes: number; max_chunk_text_chars: number; wrapped_embedding_chars: number;
    max_wrapped_embedding_bytes: number; max_wrapped_embedding_chars: number; cue_windows: number;
    input_token_ceiling: number; max_input_token_ceiling: number; max_windows_per_session: number;
    zero_chunk_sessions: number; unsupported_windows: number }> = {};
  for (const id of manifest.selected_ids as string[]) {
    const detail = manifest.selected_source_details[id];
    const sourceFile = resolve(detail.source_file);
    const sourceBytes = readFileSync(sourceFile);
    if (hash(sourceBytes) !== detail.source_sha256) throw new Error(`source hash mismatch for ${id}`);
    const sources = JSON.parse(sourceBytes.toString()) as Source[];
    const item = { sessions: sources.length, rendered_bytes: 0, production_chunks: 0, max_chunks_per_session: 0,
      chunk_text_bytes: 0, max_chunk_text_bytes: 0, max_chunk_text_chars: 0, wrapped_embedding_chars: 0,
      max_wrapped_embedding_bytes: 0, max_wrapped_embedding_chars: 0, cue_windows: 0, input_token_ceiling: 0,
      max_input_token_ceiling: 0, max_windows_per_session: 0, zero_chunk_sessions: 0, unsupported_windows: 0 };
    for (const source of sources) {
      const rendered = renderSession(source);
      item.rendered_bytes += bytes(rendered);
      const parsed = parseMarkdown(rendered, `chat/${source.session_id}-occ-${source.occurrence_index}`.toLowerCase() + '.md');
      parsed.compiled_truth = sanitizeText(parsed.compiled_truth);
      parsed.timeline = sanitizeText(parsed.timeline);
      const chunks = await prepareMarkdownChunks(parsed, 2000);
      item.production_chunks += chunks.length;
      item.max_chunks_per_session = Math.max(item.max_chunks_per_session, chunks.length);
      const prefix = buildContextualPrefix(sanitizeTitle(parsed.title), null);
      for (const chunk of chunks) {
        const size = bytes(chunk.chunk_text);
        const payload = wrapChunkForEmbedding(chunk.chunk_text, prefix, chunk.chunk_source);
        item.chunk_text_bytes += size;
        item.max_chunk_text_bytes = Math.max(item.max_chunk_text_bytes, size);
        item.max_chunk_text_chars = Math.max(item.max_chunk_text_chars, chunk.chunk_text.length);
        item.wrapped_embedding_chars += payload.length;
        item.max_wrapped_embedding_chars = Math.max(item.max_wrapped_embedding_chars, payload.length);
        item.max_wrapped_embedding_bytes = Math.max(item.max_wrapped_embedding_bytes, bytes(payload));
      }
      if (!chunks.length) item.zero_chunk_sessions++;
      if (embeddingOnly) continue;
      try {
        const windows = buildCueWindows(chunks.filter(chunk => chunk.chunk_source === 'compiled_truth' || chunk.chunk_source === 'timeline')
          .map((chunk, index) => ({ id: index + 1, chunk_text: chunk.chunk_text, modality: 'text' as const })));
        item.cue_windows += windows.length;
        item.max_windows_per_session = Math.max(item.max_windows_per_session, windows.length);
        for (const window of windows) {
          const ceiling = bytes(CUE_SYSTEM_PROMPT + JSON.stringify({ includeBridge: false, evidence: window.text })) + 1024;
          item.input_token_ceiling += ceiling;
          item.max_input_token_ceiling = Math.max(item.max_input_token_ceiling, ceiling);
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'unsupported_window') throw error;
        item.unsupported_windows++;
      }
    }
    counts[id] = item;
    process.stderr.write(`[longmemeval-m-pilot] counted ${Object.keys(counts).length}/${manifest.selected_ids.length} selected histories\n`);
  }
  const totals = Object.values(counts).reduce((acc, item) => {
    for (const key of ['sessions', 'rendered_bytes', 'production_chunks', 'chunk_text_bytes', 'wrapped_embedding_chars', 'cue_windows', 'input_token_ceiling', 'zero_chunk_sessions', 'unsupported_windows'] as const) acc[key] += item[key];
    for (const key of ['max_chunks_per_session', 'max_chunk_text_bytes', 'max_chunk_text_chars', 'max_wrapped_embedding_bytes', 'max_wrapped_embedding_chars'] as const) acc[key] = Math.max(acc[key], item[key]);
    acc.max_input_token_ceiling = Math.max(acc.max_input_token_ceiling, item.max_input_token_ceiling);
    acc.max_windows_per_session = Math.max(acc.max_windows_per_session, item.max_windows_per_session);
    return acc;
  }, { sessions: 0, rendered_bytes: 0, production_chunks: 0, max_chunks_per_session: 0, chunk_text_bytes: 0,
    max_chunk_text_bytes: 0, max_chunk_text_chars: 0, wrapped_embedding_chars: 0, max_wrapped_embedding_bytes: 0,
    max_wrapped_embedding_chars: 0, cue_windows: 0, input_token_ceiling: 0, max_input_token_ceiling: 0,
    max_windows_per_session: 0, zero_chunk_sessions: 0, unsupported_windows: 0 });
  const output = {
    schema_version: 1,
    selection_manifest_sha256: hash(readFileSync(manifestPath)),
    calculation: embeddingOnly ? 'renderSession -> parseMarkdown -> prepareMarkdownChunks(maxTokens=2000), no database or provider'
      : 'renderSession -> parseMarkdown -> prepareMarkdownChunks(maxTokens=2000) -> buildCueWindows(compiled_truth/timeline), no database or provider',
    input_ceiling_calculation: 'sum(Buffer.byteLength(CUE_SYSTEM_PROMPT + JSON.stringify({ includeBridge: false, evidence: window.text })) + 1024); output limit 1200 tokens/window',
    declared_gbrain_dependency: JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).dependencies.gbrain,
    loaded_gbrain_version: version.version,
    loaded_gbrain_commit: version.gitHead ?? null,
    window_implementation_sha256: hash(windowImplementation),
    chunk_implementation_sha256: hash(chunkImplementation),
    max_chunk_tokens: 2000,
    totals,
    counts,
  };
  const path = resolve(manifestPath, embeddingOnly ? '../longmemeval-m-pilot-embedding.json' : '../longmemeval-m-pilot-feasibility.json');
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: path, totals, loaded_gbrain_version: version.version }));
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });

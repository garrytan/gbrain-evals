import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown } from '../../node_modules/gbrain/src/core/markdown.ts';
import { prepareMarkdownChunks } from '../../node_modules/gbrain/src/core/markdown-chunks.ts';
import { sanitizeText } from '../../node_modules/gbrain/src/core/batch-rows.ts';
import { buildContextualPrefix, sanitizeTitle, wrapChunkForEmbedding } from '../../node_modules/gbrain/src/core/embedding-context.ts';
import { renderSession } from './longmemeval.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function main() {
  const [selectionPath, sourceDir, outputPath] = process.argv.slice(2);
  if (!selectionPath || !sourceDir || !outputPath || process.argv.length !== 5) {
    throw new Error('usage: bun eval/runner/longmemeval-m-pilot-batch-payload.ts <portable-selection> <source-dir> <new-output>');
  }
  const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  const cases: Record<string, { sessions: number; embed_items: number; max_items_per_session: number;
    max_batch_json_bytes: number; max_item_bytes: number; wrapped_bytes: number }> = {};
  for (const id of selection.selected_ids as string[]) {
    const detail = selection.selected_source_details[id];
    const raw = readFileSync(join(sourceDir, `${hash(id)}.json`));
    if (hash(raw) !== detail.source_sha256) throw new Error(`source hash mismatch for ${id}`);
    const sources = JSON.parse(raw.toString()) as Array<{ occurrence_index: number; session_id: string; date: string;
      turns: Array<{ role: 'user' | 'assistant'; content: string }> }>;
    if (sources.length !== detail.sessions) throw new Error(`source count mismatch for ${id}`);
    const result = { sessions: sources.length, embed_items: 0, max_items_per_session: 0, max_batch_json_bytes: 0,
      max_item_bytes: 0, wrapped_bytes: 0 };
    for (const source of sources) {
      const parsed = parseMarkdown(renderSession(source), `chat/${source.session_id}-occ-${source.occurrence_index}`.toLowerCase() + '.md');
      parsed.compiled_truth = sanitizeText(parsed.compiled_truth);
      parsed.timeline = sanitizeText(parsed.timeline);
      const chunks = await prepareMarkdownChunks(parsed, 2000);
      const prefix = buildContextualPrefix(sanitizeTitle(parsed.title), null);
      const payloads = chunks.map(chunk => wrapChunkForEmbedding(chunk.chunk_text, prefix, chunk.chunk_source));
      result.embed_items += payloads.length;
      result.max_items_per_session = Math.max(result.max_items_per_session, payloads.length);
      result.max_batch_json_bytes = Math.max(result.max_batch_json_bytes,
        Buffer.byteLength(JSON.stringify({ model: 'openai/text-embedding-3-large', input: payloads, dimensions: 1536 })));
      for (const payload of payloads) {
        const size = Buffer.byteLength(payload);
        result.max_item_bytes = Math.max(result.max_item_bytes, size);
        result.wrapped_bytes += size;
      }
    }
    cases[id] = result;
  }
  const values = Object.values(cases);
  const summary = { sessions: values.reduce((sum, value) => sum + value.sessions, 0),
    embed_items: values.reduce((sum, value) => sum + value.embed_items, 0),
    wrapped_bytes: values.reduce((sum, value) => sum + value.wrapped_bytes, 0),
    max_items_per_session: Math.max(...values.map(value => value.max_items_per_session)),
    max_batch_json_bytes: Math.max(...values.map(value => value.max_batch_json_bytes)),
    max_item_bytes: Math.max(...values.map(value => value.max_item_bytes)) };
  const output = { status: 'keyless_projection_not_provider_request_receipt', selection_sha256: hash(readFileSync(selectionPath)),
    model: 'openrouter:openai/text-embedding-3-large', dimensions: 1536,
    assumption: 'balanced title-only embedding wrapper; JSON shape includes model, input and dimensions but omits SDK/transport headers; recheck loaded product before admission',
    summary, cases };
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: outputPath, summary,
    case_items: [Math.min(...values.map(value => value.embed_items)), Math.max(...values.map(value => value.embed_items))] }));
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });

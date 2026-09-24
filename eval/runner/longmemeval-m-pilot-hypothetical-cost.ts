import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseMarkdown } from '../../node_modules/gbrain/src/core/markdown.ts';
import { prepareMarkdownChunks } from '../../node_modules/gbrain/src/core/markdown-chunks.ts';
import { sanitizeText } from '../../node_modules/gbrain/src/core/batch-rows.ts';
import { CUE_SYSTEM_PROMPT } from '../../node_modules/gbrain/src/core/memory-cues/providers.ts';
import { renderSession } from './longmemeval.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function main() {
  const [selectionPath, sourceDir, copiesDir, productionPath, outputPath] = process.argv.slice(2);
  if (!selectionPath || !sourceDir || !copiesDir || !productionPath || !outputPath || process.argv.length !== 7) {
    throw new Error('usage: bun eval/runner/longmemeval-m-pilot-hypothetical-cost.ts <portable-selection> <source-dir> <copied-window-modules-dir> <production-feasibility> <new-output>');
  }
  const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  const production = JSON.parse(readFileSync(productionPath, 'utf8'));
  const capacities = [800, 4096, 8192];
  const copies = await Promise.all(capacities.map(async capacity => {
    const path = resolve(copiesDir, `windows-${capacity}.ts`);
    const module = await import(path);
    return { capacity, build: module.buildCueWindows as (chunks: Array<{ id: number; chunk_text: string; modality: 'text' }>) => Array<{ text: string }>,
      copy_sha256: hash(readFileSync(path)) };
  }));
  const counts = Object.fromEntries(capacities.map(capacity => [capacity, { windows: 0, input_token_ceiling: 0,
    max_input_token_ceiling: 0, by_question: {} as Record<string, number> }])) as Record<number, { windows: number; input_token_ceiling: number;
      max_input_token_ceiling: number; by_question: Record<string, number> }>;
  for (const id of selection.selected_ids as string[]) {
    const detail = selection.selected_source_details[id];
    const sourcePath = join(sourceDir, `${hash(id)}.json`);
    const sourceBytes = readFileSync(sourcePath);
    if (hash(sourceBytes) !== detail.source_sha256) throw new Error(`source hash mismatch for ${id}`);
    const sources = JSON.parse(sourceBytes.toString()) as Array<{ occurrence_index: number; session_id: string; date: string;
      turns: Array<{ role: 'user' | 'assistant'; content: string }> }>;
    if (sources.length !== detail.sessions) throw new Error(`source count mismatch for ${id}`);
    for (const source of sources) {
      const rendered = renderSession(source);
      const parsed = parseMarkdown(rendered, `chat/${source.session_id}-occ-${source.occurrence_index}`.toLowerCase() + '.md');
      parsed.compiled_truth = sanitizeText(parsed.compiled_truth);
      parsed.timeline = sanitizeText(parsed.timeline);
      const chunks = (await prepareMarkdownChunks(parsed, 2000))
        .filter(chunk => chunk.chunk_source === 'compiled_truth' || chunk.chunk_source === 'timeline')
        .map((chunk, index) => ({ id: index + 1, chunk_text: chunk.chunk_text, modality: 'text' as const }));
      for (const copy of copies) {
        const windows = copy.build(chunks);
        const counter = counts[copy.capacity];
        counter.windows += windows.length;
        counter.by_question[id] = (counter.by_question[id] ?? 0) + windows.length;
        for (const window of windows) {
          const ceiling = Buffer.byteLength(CUE_SYSTEM_PROMPT + JSON.stringify({ includeBridge: false, evidence: window.text })) + 1024;
          counter.input_token_ceiling += ceiling;
          counter.max_input_token_ceiling = Math.max(counter.max_input_token_ceiling, ceiling);
        }
      }
    }
    process.stderr.write(`[longmemeval-m-pilot] hypothetical cost counted ${Object.keys(counts[800].by_question).length}/${selection.selected_ids.length} histories\n`);
  }
  const control = counts[800];
  if (control.windows !== production.totals.cue_windows || control.input_token_ceiling !== production.totals.input_token_ceiling
    || selection.selected_ids.some((id: string) => control.by_question[id] !== production.counts[id].cue_windows)) {
    throw new Error('copied 800-byte function did not reproduce the unchanged production projection');
  }
  const output = {
    status: 'hypothetical_cost_only_not_a_candidate_or_quality_result',
    selection_sha256: hash(readFileSync(selectionPath)),
    production_feasibility_sha256: hash(readFileSync(productionPath)),
    original_window_implementation_sha256: production.window_implementation_sha256,
    copied_modules: Object.fromEntries(copies.map(copy => [copy.capacity, copy.copy_sha256])),
    controlled_change: 'only the numeric window capacity 800 -> 4096 or 8192 in a private copy; 640-byte overlap, marker and grounding-chunk constraints unchanged',
    assumptions: { generation_model: 'openrouter:anthropic/claude-sonnet-4.6', rate_input_usd_per_million: 3,
      rate_output_usd_per_million: 15, max_output_tokens: 1200, seconds_per_generation: 1.77,
      cost_excludes: ['embeddings', 'retries', 'router/BYOK charges', 'query/answer/judge', 'build coordination'] },
    capacities: Object.fromEntries(capacities.map(capacity => {
      const count = counts[capacity];
      return [capacity, { ...count,
        max_output_token_ceiling: count.windows * 1200,
        sonnet_generation_usd_ceiling: (count.input_token_ceiling * 3 + count.windows * 1200 * 15) / 1e6,
        serial_generation_hours: count.windows * 1.77 / 3600 }];
    })),
  };
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: outputPath, capacities: Object.fromEntries(capacities.map(capacity => {
    const { windows, input_token_ceiling } = counts[capacity];
    return [capacity, { windows, input_token_ceiling, sonnet_generation_usd_ceiling: output.capacities[capacity].sonnet_generation_usd_ceiling,
      serial_generation_hours: output.capacities[capacity].serial_generation_hours }];
  })) }));
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });

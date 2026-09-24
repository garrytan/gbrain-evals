import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown } from '../../node_modules/gbrain/src/core/markdown.ts';
import { prepareMarkdownChunks } from '../../node_modules/gbrain/src/core/markdown-chunks.ts';
import { sanitizeText } from '../../node_modules/gbrain/src/core/batch-rows.ts';
import { renderSession } from './longmemeval.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function main() {
  const [selectionPath, sourceDir, outputPath] = process.argv.slice(2);
  if (!selectionPath || !sourceDir || !outputPath || process.argv.length !== 5) throw new Error('usage: bun longmemeval-m-pilot-offset-audit.ts <selection> <source-dir> <new-output>');
  const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  const cases: Record<string, { sessions: number; chunks: number; exact: number; whitespace_reflow: number;
    absent: number; ambiguous: number }> = {};
  for (const id of selection.selected_ids as string[]) {
    const raw = readFileSync(join(sourceDir, `${hash(id)}.json`));
    if (hash(raw) !== selection.selected_source_details[id].source_sha256) throw new Error('source hash changed');
    const sources = JSON.parse(raw.toString()) as Array<{ occurrence_index: number; session_id: string; date: string;
      turns: Array<{ role: 'user' | 'assistant'; content: string }> }>;
    const result = { sessions: sources.length, chunks: 0, exact: 0, whitespace_reflow: 0, absent: 0, ambiguous: 0 };
    for (const source of sources) {
      const text = renderSession(source).replace(/\r\n?/g, '\n').normalize('NFC');
      const parsed = parseMarkdown(text, `chat/${source.session_id}-occ-${source.occurrence_index}`.toLowerCase() + '.md');
      parsed.compiled_truth = sanitizeText(parsed.compiled_truth);
      parsed.timeline = sanitizeText(parsed.timeline);
      const chunks = await prepareMarkdownChunks(parsed, 2000);
      result.chunks += chunks.length;
      const collapsedSource = text.replace(/\s+/g, ' ');
      for (const chunk of chunks) {
        const content = chunk.chunk_text.replace(/\r\n?/g, '\n').normalize('NFC');
        const first = text.indexOf(content);
        if (first >= 0 && text.indexOf(content, first + 1) < 0) result.exact++;
        else if (first >= 0) result.ambiguous++;
        else if (collapsedSource.includes(content.replace(/\s+/g, ' '))) result.whitespace_reflow++;
        else result.absent++;
      }
    }
    cases[id] = result;
  }
  const rows = Object.values(cases);
  const totals = Object.fromEntries(['sessions', 'chunks', 'exact', 'whitespace_reflow', 'absent', 'ambiguous']
    .map(key => [key, rows.reduce((n, row) => n + row[key as keyof typeof row], 0)]));
  const output = { selection_sha256: hash(readFileSync(selectionPath)), methodology: 'provider-free candidate-equivalent parse/chunk projection; literal source substring or whitespace-collapse diagnostic, no context expansion',
    totals, cases };
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: outputPath, totals }));
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });

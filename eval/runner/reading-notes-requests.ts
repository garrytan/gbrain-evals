/** Offline paired requests through the native reader's evidence/sanitizer path. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAnswer, readerConfigHash, resolveReaderConfig, READER_MAX_SESSION_CHARS } from 'gbrain-reader/eval/longmemeval/reader';
import type { SearchResult } from 'gbrain-reader/types';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const date = /^(?:\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2} \((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\) \d{2}:\d{2})$/;
export interface FrozenReadingInput {
  question_id: string;
  question: string;
  question_date?: string;
  sources: Array<{ session_id: string; slug: string; date?: string; body: string }>;
}
export type PreparedRequest = { model: string; system: string; max_tokens: number; messages: Array<{ role: 'user'; content: string }> };

export async function prepareRequests(cases: FrozenReadingInput[], model: string, maxTokens = 1024) {
  if (model !== 'anthropic:claude-sonnet-4-6' || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error('explicit Sonnet 4.6 model and bounded output tokens required');
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c => c.question_id)).size !== cases.length) throw new Error('nonempty unique question IDs required');
  const direct = resolveReaderConfig({ mode: 'direct', maxTokens });
  const notes = resolveReaderConfig({ mode: 'notes', maxTokens });
  const rows: Array<{ question_id: string; mode: 'direct' | 'notes'; request: PreparedRequest; source_sha256: string; context_chars: number }> = [];
  for (const c of cases) {
    if (!c || Object.keys(c).some(key => !['question_id', 'question', 'question_date', 'sources'].includes(key))
      || !/^[a-z0-9_]+$/.test(c.question_id) || typeof c.question !== 'string' || !c.question.trim()
      || (c.question_date !== undefined && (typeof c.question_date !== 'string' || !date.test(c.question_date)))
      || !Array.isArray(c.sources) || !c.sources.length) throw new Error('invalid frozen question/evidence input');
    const slugs = new Set<string>();
    const ids = new Set<string>();
    for (const source of c.sources) {
      if (!source || Object.keys(source).some(key => !['session_id', 'slug', 'date', 'body'].includes(key))
        || typeof source.session_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(source.session_id)
        || typeof source.slug !== 'string' || !/^chat\/[a-zA-Z0-9_/-]+$/.test(source.slug)
        || typeof source.body !== 'string' || !source.body.trim() || source.body.length > READER_MAX_SESSION_CHARS
        || (source.date !== undefined && (typeof source.date !== 'string' || !date.test(source.date)))
        || slugs.has(source.slug) || ids.has(source.session_id)) throw new Error('invalid, duplicate or oversized frozen source');
      slugs.add(source.slug); ids.add(source.session_id);
    }
    const results: SearchResult[] = c.sources.map((s, index) => ({ slug: s.slug, page_id: index + 1, title: s.session_id, type: 'note', chunk_text: s.body,
      chunk_source: 'compiled_truth', chunk_id: index + 1, chunk_index: 0, score: 1, stale: false }));
    const pages = c.sources.map(s => ({ slug: s.slug, content: s.body, date: s.date }));
    const mapping = new Map(c.sources.map(s => [s.slug, [s.session_id]]));
    for (const [mode, config] of [['direct', direct], ['notes', notes]] as const) {
      let request: PreparedRequest | undefined;
      const client: Parameters<typeof generateAnswer>[0] = { create: async params => {
        request = params as PreparedRequest;
        return { model, content: [{ type: 'text', text: 'offline capture' }], stop_reason: 'end_turn' } as Awaited<ReturnType<Parameters<typeof generateAnswer>[0]['create']>>;
      } };
      const result = await generateAnswer(client, { question: c.question, question_date: c.question_date }, results, pages, mapping, model, '', config);
      if (!request || result.sessions_truncated !== 0 || result.context_sessions !== c.sources.length) throw new Error('native reader truncated or omitted frozen evidence');
      rows.push({ question_id: c.question_id, mode, request, source_sha256: hash(JSON.stringify(c.sources)), context_chars: result.context_chars });
    }
    const [baseline, treatment] = rows.slice(-2);
    if (JSON.stringify(baseline.request.messages) !== JSON.stringify(treatment.request.messages)
      || baseline.context_chars !== treatment.context_chars) throw new Error('paired native reader input changed');
  }
  return { schema: 1, purpose: 'offline requests only; no model answers or grades', model, max_tokens: maxTokens,
    configs: { direct: { mode: direct.mode, prompt_version: direct.promptVersion, prompt_sha256: direct.promptSha, config_sha256: readerConfigHash(direct, model) },
      notes: { mode: notes.mode, prompt_version: notes.promptVersion, prompt_sha256: notes.promptSha, config_sha256: readerConfigHash(notes, model) } }, rows };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (args.length !== 8 || !option('--input') || !option('--output') || !option('--model') || !option('--max-tokens')) throw new Error('usage: bun eval/runner/reading-notes-requests.ts --input <private-frozen.json> --output eval/reports/reading-notes/<run>.json --model anthropic:claude-sonnet-4-6 --max-tokens 1024');
  const output = resolve(option('--output')!);
  const reports = resolve(import.meta.dir, '../reports');
  if (relative(reports, output).startsWith('..') || output === reports || existsSync(output)) throw new Error('output must be a new file under ignored eval/reports/');
  const bytes = readFileSync(option('--input')!);
  const prepared = await prepareRequests(JSON.parse(bytes.toString()), option('--model')!, Number(option('--max-tokens')));
  const sourcePath = fileURLToPath(import.meta.resolve('gbrain-reader/eval/longmemeval/reader'));
  const identity = { input_sha256: hash(bytes), installed_reader_sha256: hash(readFileSync(sourcePath)),
    installed_package_sha256: hash(readFileSync(resolve(dirname(sourcePath), '../../../package.json'))),
    declared_reader_pin: (JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')) as { dependencies: { 'gbrain-reader': string } }).dependencies['gbrain-reader'] };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ ...prepared, identity }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ output, questions: prepared.rows.length / 2, paired_requests: prepared.rows.length, ...identity }));
}

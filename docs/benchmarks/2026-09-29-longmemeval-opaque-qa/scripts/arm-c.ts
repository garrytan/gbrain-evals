// Component study, step 2: same reader model (anthropic:claude-sonnet-4-6),
// same evidence (the SAME top-5 chunk texts from arm (a)'s retrieval, each
// with its session date and opaque session id, in rank order, plus the
// question date), different answering component:
//   c1 prod_reader : gbrain's production LongMemEval reader prompt (notes system
//                    text, <chat_session> framing, sanitizer), max_tokens 1024
//   c2 plain_rag   : a plain single-shot RAG prompt, one user message, max_tokens 1024
//   c3 think       : gbrain think's production synthesis prompt (system prompt,
//                    <pages> block renderer, JSON envelope), max_tokens from
//                    think's maxOutputTokensFor; answer + gaps rendered like the CLI
// Usage: bun arm-c.ts <c1|c2|c3> [--concurrency N]
import { M6, appendNdjson, dataset, gatewayCall, gbrainJudge, officialJudge, pool, readNdjson } from './lib.ts';
import { READER_NOTES_SYSTEM_TEXT, READER_MAX_SESSION_CHARS, buildReaderUserText } from 'GBRAIN_DIR/src/eval/longmemeval/reader.ts';
import { renderChatBlock } from 'GBRAIN_DIR/src/eval/longmemeval/sanitize.ts';
import { sessionIdFromSlug } from 'GBRAIN_DIR/src/eval/longmemeval/metrics.ts';
import { buildThinkSystemPrompt, buildThinkUserMessage } from 'GBRAIN_DIR/src/core/think/prompt.ts';
import { renderPagesBlock } from 'GBRAIN_DIR/src/core/think/gather.ts';
import { maxOutputTokensFor, salvageThinkEnvelope, stripGapsSection } from 'GBRAIN_DIR/src/core/think/index.ts';

const arm = process.argv[2];
if (!['c1', 'c2', 'c3'].includes(arm)) throw new Error('arm must be c1|c2|c3');
const args = process.argv.slice(3);
const conc = Number(args[args.indexOf('--concurrency') + 1] || 4) || 4;
const MODEL = 'anthropic:claude-sonnet-4-6';
const ds = dataset();

// Private in src/core/think/index.ts (inferIntent); copied verbatim.
function inferIntent(question: string): string {
  const q = question.toLowerCase();
  if (/\b(when|history|over time|evolved|since|before|after)\b/.test(q)) return 'temporal';
  if (/\b(meeting|event|happened)\b/.test(q)) return 'event';
  return 'general';
}

function tryParse(text: string): any {
  const s = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return salvageThinkEnvelope(text);
}

function build(q: any, chunks: any[]): { system?: string; user: string; maxTokens: number } {
  if (arm === 'c1') {
    const { rendered } = renderChatBlock(chunks.map(c => ({ session_id: sessionIdFromSlug(c.slug), date: c.date, body: c.chunk_text })), { maxSessionChars: READER_MAX_SESSION_CHARS });
    return { system: READER_NOTES_SYSTEM_TEXT, user: buildReaderUserText({ question: q.question, questionDate: q.question_date, rendered }), maxTokens: 1024 };
  }
  if (arm === 'c2') {
    const ctx = chunks.map((c, i) => `[${i + 1}] Conversation date: ${c.date}\n${c.chunk_text}`).join('\n\n');
    return {
      user: `Below are excerpts from past conversations between a user and an AI assistant.\n\n${ctx}\n\nCurrent date: ${q.question_date}\nQuestion: ${q.question}\n\nAnswer the question using the excerpts above.`,
      maxTokens: 1024,
    };
  }
  const pages = chunks.map(c => ({ slug: c.slug, chunk_text: `date: ${c.date}\n${c.chunk_text}` }));
  const longest = Math.max(...pages.map(p => p.chunk_text.length));
  return {
    system: buildThinkSystemPrompt({ intent: inferIntent(q.question) }),
    user: buildThinkUserMessage({ question: `(Current date: ${q.question_date}) ${q.question}`, pagesBlock: renderPagesBlock(pages as any, longest + 1, q.question), takesBlock: '' }),
    maxTokens: maxOutputTokensFor(MODEL),
  };
}

const chunkRows = readNdjson(process.env.M6_CHUNKS ?? `${M6}/c/chunks.ndjson`);
const outPath = process.env.M6_OUT_DIR ? `${process.env.M6_OUT_DIR}/${arm}.ndjson` : `${M6}/c/${arm}.ndjson`;
const done = new Set(readNdjson(outPath).filter(r => !r.reader_error).map(r => r.question_id));
const todo = chunkRows.filter(r => !done.has(r.question_id));
await pool(todo, conc, async (cr) => {
  const q = ds.get(cr.question_id)!;
  const p = build(q, cr.chunks);
  const rec: Record<string, unknown> = { arm, question_id: q.question_id, question_type: q.question_type, reader_model: MODEL,
    evidence_chars: cr.chunks.reduce((s: number, c: any) => s + c.chunk_text.length, 0), reader_system: p.system ?? null, reader_prompt: p.user, reader_max_tokens: p.maxTokens };
  try {
    const r = await gatewayCall({ model: MODEL, system: p.system, user: p.user, maxTokens: p.maxTokens });
    let hypothesis = r.text;
    if (arm === 'c3') {
      const env = tryParse(r.text);
      rec.think_envelope_parsed = !!env;
      if (env?.answer) {
        hypothesis = stripGapsSection(String(env.answer));
        const gaps = Array.isArray(env.gaps) ? env.gaps : [];
        if (gaps.length) hypothesis += `\n\n## Gaps\n${gaps.map((g: string) => `- ${g}`).join('\n')}`;
      }
    }
    Object.assign(rec, { raw_output: r.text, hypothesis, reader_usage: r.usage, reader_latency_ms: r.latency_ms, reader_total_ms: r.total_ms,
      reader_attempts: r.attempts, reader_failures: r.failures, reader_response_model: r.response_model, reader_finish_reason: r.finish_reason });
    if (r.finish_reason === 'length') rec.reader_error = 'reader_max_tokens';
  } catch (err: any) {
    Object.assign(rec, { reader_error: String(err?.message ?? err).slice(0, 300), reader_failures: err?.failures ?? [] });
  }
  if (!rec.reader_error) {
    const [gj, oj] = await Promise.all([gbrainJudge(q, rec.hypothesis as string), officialJudge(q, rec.hypothesis as string)]);
    Object.assign(rec, gj, oj);
  }
  appendNdjson(outPath, rec);
});
console.error(`[arm-c ${arm}] done ${todo.length}`);
process.exit(0);

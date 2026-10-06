/**
 * Request sources for the W10 LongMemEval arms. Every body the batch lane
 * sends is built here, by one builder per source:
 *
 * - R1/R2 replay (W10b): the exact system and user text of the 2026-09-29
 *   reranker-on reader calls (`reranker-on/r1|r2/calls.ndjson.gz`, gbrain
 *   `a7cb37b`), joined to their harness rows by question text and date.
 * - W10a capture: the reader requests gbrain's own `eval longmemeval` builds at
 *   the pin, recorded by a stub reader client that answers with a placeholder
 *   (the method R1's driver used), so the batch lane sends exactly what the
 *   harness would have sent.
 * - W10c full history: the same house reader prompt with every haystack
 *   session in place of the retrieved ones, built with gbrain's own page
 *   renderer, `<chat_session>` renderer and request builder.
 * - The official LongMemEval notes-first prompt (`gpt-5.4` link arm): sessions
 *   parsed out of R1's user text, mapped back to raw ids through R1's rows and
 *   rendered with `run_generation.py`'s template (its own protocol identity).
 * - Judges: the verbatim official `evaluate_qa.py` prompt.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { haystackToPages, type LongMemEvalQuestion } from '../../../node_modules/gbrain/src/eval/longmemeval/adapter.ts';
import { renderChatBlock } from '../../../node_modules/gbrain/src/eval/longmemeval/sanitize.ts';
import { sessionIdFromSlug } from '../../../node_modules/gbrain/src/eval/longmemeval/metrics.ts';
import { buildReaderRequest, READER_MAX_SESSION_CHARS, resolveReaderConfig } from '../../../node_modules/gbrain/src/eval/longmemeval/reader.ts';
import { assertOutputFloor, MODEL_SETTINGS, sha256, type Provider } from './manifest.ts';

export interface Question {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string | number;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: { role: string; content: string; has_answer?: boolean }[][];
}

export function readNdjson(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  const raw = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export function loadDataset(path: string): Map<string, Question> {
  return new Map((JSON.parse(readFileSync(path, 'utf8')) as Question[]).map(q => [q.question_id, q]));
}

/** The report's seven question types: abstention questions (`_abs`) form their own type. */
export const reportType = (q: { question_id: string; question_type: string }) => (q.question_id.endsWith('_abs') ? 'abstention' : q.question_type);

// ─── R1/R2 replay ───────────────────────────────────────────────────

export interface ReplayRow {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string | number;
  answer_session_ids: string[];
  /** Harness retrieval rows: slug (opaque), raw session id and rank. */
  retrieved: { slug: string; session_id: string; rank: number }[];
  retrieved_session_ids: string[];
  system: string;
  user: string;
  max_tokens: number;
  /** The Sonnet 4.6 reader's own result in the replayed run. */
  baseline: { hypothesis: string; judge_correct: boolean | null; finish: string | null };
}

/** Join R1 or R2's 500 reader calls to their harness rows by (question, question_date). Throws on any unmatched or duplicate call. */
export function loadReplay(dir: string): Map<string, ReplayRow> {
  const rows = readNdjson(join(dir, 'rows.ndjson')).filter(r => typeof r.question_id === 'string');
  const calls = readNdjson(join(dir, 'calls.ndjson.gz')).filter(c => c.lane === 'reader');
  const byKey = new Map<string, Record<string, any>>();
  for (const call of calls) {
    if (typeof call.user !== 'string' || typeof call.system !== 'string') throw new Error(`${dir}: reader call without system/user text`);
    const key = `${call.question}\u0000${call.question_date}`;
    if (byKey.has(key)) throw new Error(`${dir}: two reader calls for question ${JSON.stringify(call.question)} at ${call.question_date}`);
    byKey.set(key, call);
  }
  const out = new Map<string, ReplayRow>();
  const used = new Set<string>();
  for (const r of rows) {
    const dateMatch = [...byKey.keys()].filter(k => k.startsWith(`${r.question}\u0000`));
    if (dateMatch.length !== 1) throw new Error(`${dir}: question ${r.question_id} matches ${dateMatch.length} reader calls`);
    const call = byKey.get(dateMatch[0])!;
    used.add(dateMatch[0]);
    if (!call.user.startsWith(`Question:\n${r.question}\n\n`)) throw new Error(`${dir}: reader call for ${r.question_id} does not open with its question`);
    out.set(r.question_id, {
      question_id: r.question_id, question_type: r.question_type, question: r.question, question_date: call.question_date,
      answer: r.answer, answer_session_ids: r.answer_session_ids ?? [],
      retrieved: (r.retrieved ?? []).map((x: any) => ({ slug: x.slug, session_id: x.session_id, rank: x.rank })),
      retrieved_session_ids: r.retrieved_session_ids ?? [],
      system: call.system, user: call.user, max_tokens: call.max_tokens,
      baseline: { hypothesis: r.hypothesis ?? '', judge_correct: typeof r.judge_correct === 'boolean' ? r.judge_correct : null, finish: r.reader_finish_reason ?? null },
    });
  }
  if (used.size !== byKey.size) throw new Error(`${dir}: ${byKey.size - used.size} reader calls joined no row`);
  return out;
}

// ─── Reader bodies ──────────────────────────────────────────────────

export interface ReaderText { system: string; user: string }

/**
 * The batch body for a house-reader request. System and user text are passed
 * through unchanged; only the model, the output limit and the preregistered
 * effort are set. Anthropic: gbrain's request shape plus `output_config.effort`.
 * OpenAI: the system text as the system message, then the user text.
 */
export function readerBody(model: string, text: ReaderText, maxOutputTokens = MODEL_SETTINGS[model]?.max_output_tokens): Record<string, unknown> {
  const settings = MODEL_SETTINGS[model];
  if (!settings) throw new Error(`no preregistered reader settings for ${model}`);
  if (maxOutputTokens === undefined) throw new Error(`no output limit for ${model}`);
  if (settings.reasoning) assertOutputFloor(model, maxOutputTokens);
  if (settings.provider === 'anthropic') {
    return { model, max_tokens: maxOutputTokens, system: text.system, messages: [{ role: 'user', content: text.user }], ...(settings.effort ? { output_config: { effort: settings.effort } } : {}) };
  }
  return { model, messages: [{ role: 'system', content: text.system }, { role: 'user', content: text.user }], ...(settings.effort ? { reasoning_effort: settings.effort } : {}), max_completion_tokens: maxOutputTokens };
}

/** One-message official-protocol body (gpt-5.4 link arm; the 2026-10-04 `frontier.ts` body). */
export function officialReaderBody(model: string, prompt: string): Record<string, unknown> {
  const settings = MODEL_SETTINGS[model];
  if (!settings || settings.provider !== 'openai') throw new Error(`the official-prompt arm runs an OpenAI reader, not ${model}`);
  assertOutputFloor(model, settings.max_output_tokens);
  return { model, messages: [{ role: 'user', content: prompt }], reasoning_effort: settings.effort, max_completion_tokens: settings.max_output_tokens };
}

export const providerOf = (model: string): Provider => {
  const p = MODEL_SETTINGS[model]?.provider;
  if (!p) throw new Error(`unknown provider for ${model}`);
  return p;
};

// ─── Session blocks inside a house-reader user text ─────────────────

export interface SessionBlock { id: string; date: string | null; start: number; end: number }

/** Locate every `<chat_session>` block (the sanitizer escapes closing tags inside sessions, so the first close ends a block). */
export function parseSessionBlocks(user: string): SessionBlock[] {
  const out: SessionBlock[] = [];
  const rx = /<chat_session id="([^"]*)"(?: date="([^"]*)")?>\n[\s\S]*?\n<\/chat_session>/g;
  for (let m = rx.exec(user); m; m = rx.exec(user)) out.push({ id: m[1], date: m[2] ?? null, start: m.index, end: m.index + m[0].length });
  return out;
}

/** The user text with one session block removed (W8 partial fault), keeping the blank-line joins of the rest. */
export function removeSessionBlock(user: string, id: string): string {
  const blocks = parseSessionBlocks(user);
  const i = blocks.findIndex(b => b.id === id);
  if (i < 0) throw new Error(`session ${id} is not in the user text`);
  const b = blocks[i];
  const before = user.slice(0, b.start);
  const after = user.slice(b.end);
  if (i === 0 && blocks.length === 1) return before + after;
  if (i === 0) return before + after.replace(/^\n\n/, '');
  return before.replace(/\n\n$/, '') + after;
}

/** Replace a user text's retrieved-session section with another's (W8 sanity control). */
export function swapSessions(user: string, donorUser: string): string {
  const marker = 'Retrieved sessions:\n';
  const at = user.indexOf(marker);
  const donorAt = donorUser.indexOf(marker);
  if (at < 0 || donorAt < 0) throw new Error('user text has no "Retrieved sessions:" section');
  return user.slice(0, at + marker.length) + donorUser.slice(donorAt + marker.length);
}

// ─── Official LongMemEval notes-first prompt ────────────────────────

/** Python json.dumps(obj) with default separators and ensure_ascii=True (copied from the 2026-09-29 opaque-qa lib.ts). */
export function pyDumps(v: unknown): string {
  const esc = (s: string) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (typeof v === 'string') return esc(v);
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => `${esc(k)}: ${pyDumps(x)}`).join(', ') + '}';
  return JSON.stringify(v);
}

export const OFFICIAL_CON_INSTRUCTION = 'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.';
const officialTemplate = (history: string, date: string, question: string) =>
  `${OFFICIAL_CON_INSTRUCTION}\n\n\nHistory Chats:\n\n${history}\n\nCurrent Date: ${date}\nQuestion: ${question}\nAnswer (step by step):`;

/** The official protocol's identity: `run_generation.py` (con, json history) as rendered by the 2026-09-29 `official.ts`. */
export const OFFICIAL_PROTOCOL = { name: 'longmemeval-official-run_generation-con-json', sha256: sha256(officialTemplate('{history}', '{date}', '{question}')) };

type OfficialQuestion = Pick<Question, 'question_id' | 'question' | 'question_date' | 'haystack_session_ids' | 'haystack_dates' | 'haystack_sessions'>;

/** `run_generation.py` prompt over the given raw session ids: sessions sorted by date, both speakers, has_answer stripped. */
export function officialReaderPrompt(q: OfficialQuestion, sessionIds: string[]): { prompt: string; sessions: number } {
  const idx = new Map(q.haystack_session_ids.map((s, i) => [s, i]));
  const chunks: [string, { role: string; content: string }[]][] = [];
  for (const sid of sessionIds) {
    const i = idx.get(sid);
    if (i === undefined) throw new Error(`${q.question_id}: session ${sid} not in haystack`);
    chunks.push([q.haystack_dates[i], q.haystack_sessions[i].map(t => ({ role: t.role, content: t.content }))]);
  }
  chunks.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  let history = '';
  chunks.forEach(([date, entry], i) => {
    history += `\n### Session ${i + 1}:\nSession Date: ${date}\nSession Content:\n${'\n' + pyDumps(entry)}\n`;
  });
  return { prompt: officialTemplate(history, q.question_date, q.question), sessions: chunks.length };
}

/** Raw session ids of the sessions in a replayed user text, in the order the house reader saw them. */
export function replaySessionIds(row: ReplayRow): string[] {
  const rawBySlugId = new Map(row.retrieved.map(r => [sessionIdFromSlug(r.slug), r.session_id]));
  return parseSessionBlocks(row.user).map(b => {
    const raw = rawBySlugId.get(b.id);
    if (!raw) throw new Error(`${row.question_id}: session ${b.id} in the reader text has no retrieval row`);
    return raw;
  });
}

/** The official prompt over exactly the sessions R1's house reader saw. */
export function officialPromptFromReplay(row: ReplayRow, q: OfficialQuestion): { prompt: string; sessions: number; session_ids: string[] } {
  const ids = replaySessionIds(row);
  return { ...officialReaderPrompt(q, ids), session_ids: ids };
}

// ─── W10c full history ──────────────────────────────────────────────

const HOUSE_NOTES = resolveReaderConfig({ mode: 'notes' });
export const HOUSE_NOTES_PROTOCOL = { name: HOUSE_NOTES.promptVersion, sha256: HOUSE_NOTES.promptSha };
export const HOUSE_DIRECT_PROTOCOL = (() => { const c = resolveReaderConfig({ mode: 'direct' }); return { name: c.promptVersion, sha256: c.promptSha }; })();

/**
 * The house notes reader's request with every haystack session, in haystack
 * order, rendered exactly as the harness renders retrieved ones (gbrain's page
 * renderer, `<chat_session>` framing, the reader's 60,000-character bound).
 */
export function fullHistoryText(q: Question): ReaderText & { sessions: number; truncated: number; chars: number } {
  const pages = haystackToPages(q as unknown as LongMemEvalQuestion);
  const sessions = pages.map((p, i) => ({ session_id: sessionIdFromSlug(p.slug), date: q.haystack_dates[i], body: p.content }));
  const { rendered, truncatedCount } = renderChatBlock(sessions, { maxSessionChars: READER_MAX_SESSION_CHARS });
  const req = buildReaderRequest({ question: q.question, questionDate: q.question_date, rendered }, 'placeholder', HOUSE_NOTES);
  return { system: req.system, user: req.messages[0].content, sessions: sessions.length, truncated: truncatedCount, chars: rendered.length };
}

/** Context windows the W10c build refuses to exceed (kept under both providers' long-context price tiers). */
export const CONTEXT_LIMIT_TOKENS: Record<string, number> = { 'claude-sonnet-5-5': 200_000, 'gpt-6.1-sol': 200_000 };

export function assertFitsWindow(model: string, questionId: string, inputTokens: number, outputTokens: number): void {
  const limit = CONTEXT_LIMIT_TOKENS[model];
  if (!limit) throw new Error(`no context limit registered for ${model}`);
  if (inputTokens + outputTokens > limit) throw new Error(`${questionId}: ${inputTokens} input + ${outputTokens} output tokens exceed ${model}'s ${limit}-token limit for this arm`);
}

// ─── Seeded subsets ─────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sorted = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A seeded permutation of ids (sorted input, Fisher-Yates with mulberry32). */
export function seededPermutation(ids: string[], seed: number): string[] {
  return shuffle(sorted(ids), mulberry32(seed));
}

/** A seeded simple random sample of n ids (sorted input, Fisher-Yates with mulberry32). */
export function seededSample(ids: string[], n: number, seed: number): string[] {
  if (n > ids.length) throw new Error(`cannot sample ${n} of ${ids.length}`);
  return sorted(shuffle(sorted(ids), mulberry32(seed)).slice(0, n));
}

/**
 * A seeded sample of n ids stratified by type: proportional allocation with
 * largest remainders (ties to the larger stratum, then by name), at least one
 * per stratum, then a seeded shuffle inside each stratum in type-name order.
 */
export function stratifiedSample(types: Map<string, string>, n: number, seed: number): { ids: string[]; allocation: Record<string, number> } {
  const strata = new Map<string, string[]>();
  for (const [id, t] of types) strata.set(t, [...(strata.get(t) ?? []), id]);
  const names = sorted([...strata.keys()]);
  const total = types.size;
  const exact = names.map(t => ({ t, size: strata.get(t)!.length, share: (strata.get(t)!.length * n) / total }));
  const alloc = new Map(exact.map(e => [e.t, Math.max(1, Math.floor(e.share))]));
  let left = n - [...alloc.values()].reduce((a, b) => a + b, 0);
  const order = [...exact].sort((a, b) => (b.share - Math.floor(b.share)) - (a.share - Math.floor(a.share)) || b.size - a.size || (a.t < b.t ? -1 : 1));
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) alloc.set(order[i].t, alloc.get(order[i].t)! + 1);
  const rand = mulberry32(seed);
  const ids: string[] = [];
  for (const t of names) ids.push(...shuffle(sorted(strata.get(t)!), rand).slice(0, alloc.get(t)!));
  return { ids: sorted(ids), allocation: Object.fromEntries(names.map(t => [t, alloc.get(t)!])) };
}

// ─── W10a capture ───────────────────────────────────────────────────

export const CAPTURE_PLACEHOLDER = 'W10a capture placeholder: no reader call was made.';

export interface CapturedRequest { question: string; question_date: string | null; model: string; max_tokens: number; system: string; user: string; params: unknown }

/**
 * A reader client for gbrain's harness that records each request and answers
 * with a placeholder, so retrieval runs for real while the reader costs $0.
 */
export function captureClient(onCapture: (c: CapturedRequest) => void) {
  return {
    create: async (params: any) => {
      const system = typeof params.system === 'string' ? params.system : '';
      const user = params.messages?.[params.messages.length - 1]?.content;
      if (typeof user !== 'string' || params.messages.length !== 1) throw new Error('capture expects one user message with string content');
      const qm = /^Question:\n([\s\S]*?)\n\n(?:Current Date: ([^\n]*)\n\n)?/.exec(user);
      onCapture({ question: qm?.[1] ?? '', question_date: qm?.[2] ?? null, model: params.model, max_tokens: params.max_tokens, system, user, params });
      return { id: '', type: 'message', role: 'assistant', model: params.model, content: [{ type: 'text', text: CAPTURE_PLACEHOLDER }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' };
    },
  };
}

// ─── Judges ─────────────────────────────────────────────────────────

/** Exact official LongMemEval evaluate_qa.py::get_anscheck_prompt (verbatim, as in the 2026-09-29 and 2026-10-04 lib.ts). */
export function officialJudgePrompt(task: string, question: string, answer: string | number, response: string, abstention: boolean): string {
  const a = String(answer);
  if (!abstention) {
    if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task))
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    if (task === 'temporal-reasoning')
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    if (task === 'knowledge-update')
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    if (task === 'single-session-preference')
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    throw new Error(`unknown task ${task}`);
  }
  return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${a}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
}

export const JUDGE_PROTOCOL = {
  name: 'longmemeval-official-evaluate_qa-anscheck',
  sha256: sha256(['single-session-user', 'temporal-reasoning', 'knowledge-update', 'single-session-preference'].map(t => officialJudgePrompt(t, '{question}', '{answer}', '{response}', false))
    .concat(officialJudgePrompt('multi-session', '{question}', '{answer}', '{response}', true)).join('\u0000')),
};

export type JudgeRole = 'official' | 'secondary';

/** Primary judge: gpt-4o-2024-08-06, temperature 0, 10 tokens. Secondary: gpt-6.1-sol at low effort, 2,000 tokens. Same prompt. */
export function judgeBody(role: JudgeRole, q: { question_id: string; question_type: string; question: string; answer: string | number }, hypothesis: string): Record<string, unknown> {
  const content = officialJudgePrompt(q.question_type, q.question, q.answer, hypothesis, q.question_id.includes('_abs'));
  if (role === 'official') return { model: 'gpt-4o-2024-08-06', messages: [{ role: 'user', content }], n: 1, temperature: 0, max_tokens: 10 };
  return { model: 'gpt-6.1-sol', messages: [{ role: 'user', content }], reasoning_effort: 'low', max_completion_tokens: 2000 };
}

/** The official verdict rule: "yes" appears in the lowercased reply. */
export const judgeVerdict = (text: string) => text.toLowerCase().includes('yes');

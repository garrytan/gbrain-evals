/**
 * One reader request per (question, arm), built from frozen evidence only.
 *
 * Every arm goes through the same renderer (gbrain's renderChatBlock, one
 * <chat_session> block per delivered block, opaque session id and session
 * date, 60,000-character cap), the same user text (buildReaderUserText) and
 * the same system text, model and output limit. The only input that differs
 * between arms is the list of delivered blocks. `requestParts` exposes the
 * evidence section separately so tests can prove that.
 */
import { sha256 } from './data.ts';
import type { BlobStore, FrozenBlock, FrozenHit, FrozenQuestion } from './store.ts';

export interface Renderer {
  system: string;
  maxSessionChars: number;
  renderChatBlock: (s: Array<{ session_id: string; date?: string; body: string }>, o: { maxSessionChars?: number }) => { rendered: string; truncatedCount: number };
  buildReaderUserText: (i: { question: string; questionDate?: string; rendered: string }) => string;
  sessionIdFromSlug: (slug: string) => string;
}

export interface ReaderRequest {
  model: string;
  system: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}

export interface ReaderSessionBlock { session_id: string; date?: string; body: string }

export function sessionBlocks(q: Pick<FrozenQuestion, 'pages'>, blocks: FrozenBlock[], store: Pick<BlobStore, 'get'>, r: Pick<Renderer, 'sessionIdFromSlug'>): ReaderSessionBlock[] {
  const dates = new Map(q.pages.map(p => [p.slug, p.date]));
  return blocks.map(b => {
    const date = dates.get(b.slug);
    return { session_id: r.sessionIdFromSlug(b.slug), ...(date ? { date } : {}), body: store.get(b.text) };
  });
}

export function buildRequest(r: Renderer, question: { question: string; question_date?: string }, sessions: ReaderSessionBlock[], model: string, maxTokens: number): { request: ReaderRequest; rendered: string; truncated: number } {
  const { rendered, truncatedCount } = r.renderChatBlock(sessions, { maxSessionChars: r.maxSessionChars });
  const content = r.buildReaderUserText({ question: question.question, ...(question.question_date ? { questionDate: question.question_date } : {}), rendered });
  return { request: { model, system: r.system, max_tokens: maxTokens, messages: [{ role: 'user', content }] }, rendered, truncated: truncatedCount };
}

/** Split a request into everything except the evidence, and the evidence. */
export function requestParts(req: ReaderRequest, rendered: string): { invariant: string; evidence: string } {
  const content = req.messages[0].content;
  const at = content.lastIndexOf(rendered);
  if (at < 0 || at + rendered.length !== content.length) throw new Error('rendered evidence is not the tail of the user message');
  return { invariant: JSON.stringify({ model: req.model, system: req.system, max_tokens: req.max_tokens, keys: Object.keys(req).sort(), roles: req.messages.map(m => m.role), prefix: content.slice(0, at) }), evidence: rendered };
}

export const requestSha = (req: ReaderRequest) => sha256(JSON.stringify(req));

/** k10: chunks in rank order under a token budget; a chunk that does not fit is skipped and later ones may still fit. */
export function packK10(hits10: FrozenHit[], textOf: (h: FrozenHit) => string, count: (s: string) => number, budget: number): { kept: FrozenHit[]; tokens: number } {
  const kept: FrozenHit[] = [];
  let used = 0;
  for (const h of [...hits10].sort((a, b) => a.rank - b.rank)) {
    const t = count(textOf(h));
    if (used + t > budget) continue;
    kept.push(h);
    used += t;
  }
  return { kept, tokens: used };
}

// ─── E1b agent-fetch arm ─────────────────────────────────────────────

export const GET_PAGE_TOOL = {
  name: 'get_page',
  description: 'Fetch the full text of one retrieved conversation session by its session id (the id attribute of a <chat_session> block). Returns the whole session as a <chat_session> block.',
  inputSchema: { type: 'object', properties: { session_id: { type: 'string', description: 'The session id shown in a <chat_session id="..."> block.' } }, required: ['session_id'], additionalProperties: false },
};

/** The tool result for a get_page call: the page arm's block for that session, through the same renderer. */
export function getPageResult(sessionId: unknown, pages: Map<string, ReaderSessionBlock>, r: Renderer): { text: string; isError: boolean } {
  const id = typeof sessionId === 'string' ? sessionId : '';
  const block = pages.get(id);
  if (!block) return { text: `Unknown session id ${JSON.stringify(id)}. Only the retrieved sessions can be fetched: ${[...pages.keys()].join(', ')}.`, isError: true };
  return { text: r.renderChatBlock([block], { maxSessionChars: r.maxSessionChars }).rendered, isError: false };
}

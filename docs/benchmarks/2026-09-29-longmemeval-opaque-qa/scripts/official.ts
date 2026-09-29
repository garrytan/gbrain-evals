import { pyDumps, type Question } from './lib.ts';

const OFFICIAL_CON_TEMPLATE = (history: string, date: string, question: string) =>
  `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n${history}\n\nCurrent Date: ${date}\nQuestion: ${question}\nAnswer (step by step):`;

export function officialReaderPrompt(q: Question, sessionIds: string[]): { prompt: string; sessions: number } {
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
  return { prompt: OFFICIAL_CON_TEMPLATE(history, q.question_date, q.question), sessions: chunks.length };
}


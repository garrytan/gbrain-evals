/** Shared helpers for the N7 repros: synthetic GmailThreadData at a pinned now. */
export const G = new URL('../../../../node_modules/gbrain/src/core', import.meta.url).pathname;
export const NOW = new Date('2026-10-01T12:00:00Z');
export const ME = new Set(['me@example.com']);
const H = 3_600_000;
export const msg = (o: { id: string; from: string; to: string[]; ageH: number; body: string; mine?: boolean }) => ({
  id: o.id, threadId: 't1', from: o.from, fromAddress: o.from, to: o.to, cc: [], subject: 'Deck', dateIso: '',
  internalDateMs: NOW.getTime() - o.ageH * H, labelIds: o.mine ? ['SENT'] : ['INBOX'], listUnsubscribe: false, calendarMethod: null, bodyText: o.body,
});
export const thread = (...messages: ReturnType<typeof msg>[]) => ({ threadId: 't1', account: 'me@example.com', messages });
export function report(expected: string, actual: string, ok: boolean): void {
  console.log(`expected: ${expected}\nactual:   ${actual}\n${ok ? 'MATCHES EXPECTED' : 'REPRODUCED (differs from expected)'}`);
}

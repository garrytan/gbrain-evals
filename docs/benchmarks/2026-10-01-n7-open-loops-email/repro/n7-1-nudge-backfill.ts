// N7-1: a nudge inside the 24h grace window hides a request that has been unanswered for 40 hours (first sight).
import { G, ME, NOW, msg, report, thread } from './_thread.ts';
const { detectThreadLoop } = await import(`${G}/google/loop-detect.ts`);
const t = thread(
  msg({ id: 'a1', from: 'bob@example.org', to: ['me@example.com'], ageH: 40, body: 'Can you send the deck?' }),
  msg({ id: 'a2', from: 'bob@example.org', to: ['me@example.com'], ageH: 5, body: 'Bumping this. Any news?' }),
);
const v = detectThreadLoop(t, ME, NOW);
report('open unanswered_inbound for bob@example.org (request unanswered 40h > 24h)', `open=${JSON.stringify(v.open.map((o: any) => [o.loopType, o.counterpartyEmail]))}`, v.open.some((o: any) => o.loopType === 'unanswered_inbound'));

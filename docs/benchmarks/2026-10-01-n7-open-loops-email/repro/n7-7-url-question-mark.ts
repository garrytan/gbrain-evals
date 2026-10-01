// N7-7 (feature gap): an FYI whose only "?" is inside a link opens unanswered_outbound.
import { G, ME, NOW, msg, report, thread } from './_thread.ts';
const { detectThreadLoop } = await import(`${G}/google/loop-detect.ts`);
const t = thread(msg({ id: 'u1', from: 'me@example.com', to: ['bob@example.org'], ageH: 100, body: 'For reference, notes at https://docs.example.com/view?id=42. No reply needed.', mine: true }));
const v = detectThreadLoop(t, ME, NOW);
report('no loop (no question asked)', `open=${JSON.stringify(v.open.map((o: any) => [o.loopType, o.counterpartyEmail]))}`, v.open.length === 0);

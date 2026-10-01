// N7-2 (feature gap): any reply flips the turn, so "Thanks!" closes a reply-owed loop although the deck was never sent.
import { G, ME, NOW, msg, report, thread } from './_thread.ts';
const { detectThreadLoop } = await import(`${G}/google/loop-detect.ts`);
const t = thread(
  msg({ id: 'b1', from: 'bob@example.org', to: ['me@example.com'], ageH: 40, body: 'Can you send the deck?' }),
  msg({ id: 'b2', from: 'me@example.com', to: ['bob@example.org'], ageH: 30, body: 'Thanks!', mine: true }),
);
const v = detectThreadLoop(t, ME, NOW);
report('a semantic loop engine keeps "send the deck" open', `open=${JSON.stringify(v.open)} close=${JSON.stringify(v.close)} (documented: a reply closes)`, v.open.length > 0);

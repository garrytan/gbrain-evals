// N8-3 (feature gap): an alias that is an ordinary word is volunteered when the word is used in its ordinary sense.
import { brain } from './_brain.ts';
const { engine, op } = await brain();
const r: any = await op('volunteer_context', { window: 'user: The harbor was busy when we walked past this morning.' }, false);
console.log('expected: nothing volunteered (the turn is about a harbor, not Harbor Logistics)');
console.log(`actual:   ${JSON.stringify(r.pages.map((p: any) => ({ slug: p.slug, arm: p.arm, confidence: p.confidence })))}`);
await engine.disconnect();

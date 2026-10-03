// N8-2: the turn_context block (assembleTurnContext, served over IPC to gbrain hook user-prompt) injects a private page and its synopsis.
import { G, brain } from './_brain.ts';
const { engine } = await brain();
const { assembleTurnContext } = await import(`${G}/context/turn-context.ts`);
const r = await assembleTurnContext(engine, { sourceId: 'default', window: [{ role: 'user', text: 'Lunch with Zora Quillfeather went well.' }] });
console.log('expected: no private page in the injected block (the IPC path must not widen what MCP returns; hot facts are world-only already)');
console.log(`actual:   ${JSON.stringify(r.text)}`);
await engine.disconnect();

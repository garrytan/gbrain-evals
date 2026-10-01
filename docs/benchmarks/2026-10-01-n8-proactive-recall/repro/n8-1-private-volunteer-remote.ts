// N8-1: volunteer_context returns a visibility: private page (title and body synopsis) to a remote caller; remote search hides it.
import { brain } from './_brain.ts';
const { engine, op } = await brain();
const vol: any = await op('volunteer_context', { window: 'user: Lunch with Zora Quillfeather went well.' }, true);
const search: any = await op('search', { query: 'Zora Quillfeather' }, true);
console.log('expected: remote volunteer_context delivers nothing for a private page (as remote search returns nothing)');
console.log(`actual:   remote volunteer_context -> ${JSON.stringify(vol.pages.map((p: any) => ({ slug: p.slug, synopsis: p.synopsis })))}; remote search hits: ${(Array.isArray(search) ? search : search.results ?? []).length}`);
await engine.disconnect();

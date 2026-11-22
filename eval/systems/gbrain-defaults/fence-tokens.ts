/**
 * Local cl100k counter for the shim. Like gbrain's budget recount, compare each fenced field with the same field
 * without its wrapper, so token merges across the fence boundary are included. The image uses its installed gbrain's
 * tokenizer dependency; outside the image use the repository dependency.
 */
import { createRequire } from 'node:module';

const requireTokenizer = createRequire(process.env.GBRAIN_TOKENIZER_PACKAGE ?? import.meta.url);
const enc = requireTokenizer('@dqbd/tiktoken').get_encoding('cl100k_base');
const pairs = await Bun.stdin.json() as Array<[wrapped: string, unwrapped: string]>;
let tokens = 0;
for (const [wrapped, unwrapped] of pairs) tokens += enc.encode(wrapped, [], []).length - enc.encode(unwrapped, [], []).length;
enc.free();
console.log(tokens);

// N12-2: an offset-stamped source timestamp passes through the adapter unconverted, and the page
// renderer pairs the UTC hour with the local date, so the re-parsed turn lands one day early.
// Expected: anchor "(2026-08-11 5:30 AM)" and a re-parsed 2026-08-11T05:30:00Z. Exit 1 while the bug reproduces.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { claudeExportAdapter } = await import(`${G}/transcripts/claude-export.ts`);
const { redactSession, renderSessionParts } = await import(`${G}/transcripts/render.ts`);
const { parseConversation } = await import(`${G}/conversation-parser/parse.ts`);
const dir = mkdtempSync(join(tmpdir(), "n12-2-"));
const path = join(dir, "conversations.json");
writeFileSync(path, JSON.stringify([{ uuid: "c1", name: "evening chat", created_at: "2026-08-10T22:30:00.000-07:00",
  chat_messages: [{ uuid: "m1", sender: "human", created_at: "2026-08-10T22:30:00.000-07:00", text: "hello" }] }]));
const gen = claudeExportAdapter.parse(path);
const session = (await gen.next()).value;
const part = renderSessionParts(redactSession(session, { patterns: [] }), { sourcePath: path }).parts[0];
const parsed = parseConversation(part.body, { noFallback: true, noPolish: true, page: { frontmatter: part.frontmatter } });
const got = parsed.messages[0]?.timestamp;
console.log(JSON.stringify({ adapter_timestamp: session.messages[0].timestamp, anchor: part.body.split("\n")[0], reparsed: got, true_instant: new Date("2026-08-10T22:30:00.000-07:00").toISOString() }));
process.exit(Date.parse(got) === Date.parse("2026-08-11T05:30:00Z") ? 0 : 1);

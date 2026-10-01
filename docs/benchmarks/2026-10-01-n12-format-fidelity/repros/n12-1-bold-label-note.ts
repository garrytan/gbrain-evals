// N12-1: a short status note with three one-off bold labels parses as a three-turn conversation.
// Expected: phase no_match, 0 messages. Exit 1 while the bug reproduces.
const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { parseConversation } = await import(`${G}/conversation-parser/parse.ts`);
const filler = Array.from({ length: 22 }, (_, i) => `Paragraph ${i + 1}: the team agreed in principle and will review the plan this week.`);
const body = ["# Project status", "", "**Status:** green", "**Owner:** Alice Example", "**Next step:** ship the draft", "", ...filler, ""].join("\n");
const r = parseConversation(body, { noFallback: true, noPolish: true, page: { frontmatter: { date: "2026-04-01" } } });
console.log(JSON.stringify({ phase: r.phase, pattern: r.matched_pattern_id, speakers: r.messages.map((m: any) => m.speaker) }));
process.exit(r.messages.length ? 1 : 0);

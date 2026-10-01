const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { parseWindow } = await import(`${G}/context/volunteer.ts`);
const { operations } = await import(`${G}/operations.ts`);
console.log("parseWindow:", JSON.stringify(parseWindow("user: I'm meeting Alice Example tomorrow\nassistant: ok\nwhat should I bring?")));
console.log("ops named turn_context:", operations.filter((o: any) => o.name === "turn_context").length, "| volunteer_context:", JSON.stringify(operations.filter((o: any) => o.name === "volunteer_context").map((o: any) => ({ scope: o.scope, localOnly: !!o.localOnly }))));

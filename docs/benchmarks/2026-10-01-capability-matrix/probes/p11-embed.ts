const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const gw = await import(`${G}/ai/gateway.ts`);
for (const cap of ["embedding", "chat"]) { try { console.log(`isAvailable('${cap}') ->`, gw.isAvailable(cap)); } catch (e: any) { console.log(`isAvailable('${cap}') threw:`, e.message.slice(0, 160)); } }

import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
test('freePort skips a busy port', async () => {
  const srv = createServer(); await new Promise<void>(r => srv.listen(47999, '127.0.0.1', () => r()));
  const p = await freePort(47999); expect(p).not.toBe(47999); expect(p).toBeGreaterThan(0);
  srv.close(); expect(await freePort(47998)).toBe(47998);
});

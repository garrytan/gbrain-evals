import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
test('freePort skips a busy port', async () => {
  // Hold an OS-assigned port: a fixed number in the ephemeral range can be taken by any process on the machine.
  const srv = createServer(); await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const busy = (srv.address() as { port: number }).port;
  const p = await freePort(busy); expect(p).not.toBe(busy); expect(p).toBeGreaterThan(0);
  await new Promise<void>(r => srv.close(() => r()));
  expect(await freePort(busy)).toBe(busy);
});

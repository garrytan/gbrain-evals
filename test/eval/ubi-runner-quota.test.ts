/**
 * ubi-runner.sh keeps the org's Ubicloud rules on its own (GST-2908): every VM it makes carries a TTL in its name, its
 * owner's next up (or reap) destroys that owner's expired VMs and no one else's, and a create starts only while the
 * project's VMs stay at or under 464 vCPUs and the caller's crew at or under 208, counting the caller's own (you) row,
 * with an unreadable usage refusing (fail closed). The runner talks to a fake Ubicloud API on 127.0.0.1
 * (UBICLOUD_API_URL) and a fake ssh, so no test reaches the network or makes a VM.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(import.meta.dir, '../../scripts/ubicloud/ubi-runner.sh');
const tmp = mkdtempSync(join(tmpdir(), 'ubi-quota-'));
const NOW = Math.floor(Date.now() / 1000);
const LOC = 'eu-central-h1';

type Vm = { size: string };
const api = { calls: [] as string[][], vms: new Map<string, Vm>(), listFails: false, showFails: new Set<string>(), createDelayMs: 0 };
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const { argv } = (await req.json()) as { argv: string[] };
      api.calls.push(argv);
      if (argv[0] === 'vm' && argv[1] === 'list') {
        if (api.listFails) return new Response('service unavailable\n', { status: 503 });
        return new Response([...api.vms.keys()].map(n => `${LOC} ${n}\n`).join(''));
      }
      const name = (argv[1] ?? '').split('/')[1] ?? '';
      if (argv[2] === 'create') {
        await Bun.sleep(api.createDelayMs);
        api.vms.set(name, { size: argv[argv.indexOf('-s') + 1] });
        return new Response('VM created\n');
      }
      if (argv[2] === 'show') {
        if (api.showFails.has(name)) return new Response('internal error\n', { status: 500 });
        const vm = api.vms.get(name);
        return vm ? new Response(`size: ${vm.size}\nstate: running\nip4: 127.0.0.1\n`) : new Response('not found\n', { status: 404 });
      }
      if (argv[2] === 'destroy') { api.vms.delete(name); return new Response('destroyed\n'); }
      return new Response('unexpected request\n', { status: 500 });
    },
  });
});
afterAll(() => { server.stop(true); rmSync(tmp, { recursive: true, force: true }); });

/** Sets the project's VMs: [owner, count, size] groups named the way the runner names them, created 'ageHours' ago with a TTL. */
function project(groups: Array<[string, number, string?]>, opts: { ageHours?: number; ttl?: number | null } = {}) {
  api.calls = []; api.vms = new Map(); api.listFails = false; api.showFails = new Set(); api.createDelayMs = 0;
  let k = 0;
  for (const [owner, n, size = 'standard-16'] of groups) for (let i = 0; i < n; i++) addVm(owner, size, opts);
  function addVm(owner: string, size: string, o: { ageHours?: number; ttl?: number | null }) {
    const epoch = NOW - Math.round((o.ageHours ?? 1) * 3600);
    const ttl = o.ttl === undefined ? 12 : o.ttl;
    const name = owner.startsWith('(') ? `managed-runner-${++k}` : `ubirun-${owner}-${epoch}-${(++k).toString(16).padStart(8, '0')}${ttl === null ? '' : `-t${ttl}`}`;
    api.vms.set(name, { size });
    return name;
  }
  return (owner: string, o: { ageHours?: number; ttl?: number | null; size?: string } = {}) => addVm(owner, o.size ?? 'standard-16', o);
}

let n = 0;
/** A fake ssh that succeeds, so up gets past its readiness wait without a VM. */
const bin = join(tmp, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'ssh'), '#!/usr/bin/env bash\nexit 0\n');
chmodSync(join(bin, 'ssh'), 0o755);

async function runner(args: string[], env: Record<string, string | undefined> = {}, state = join(tmp, `state-${++n}`)) {
  const base: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: tmp, UBI_RUNNER_STATE: state, UBICLOUD_API_KEY: 'ubi-test-placeholder',
    UBICLOUD_API_URL: `http://127.0.0.1:${server.port}`, UBI_OWNER: 'GBEV-95', UBI_POLL_SECONDS: '0', UBI_API_TIMEOUT: '5', UBI_DOWN_TIMEOUT: '20', UBI_CREATE_GRACE: '0',
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete base[k]; else base[k] = v;
  const p = Bun.spawn(['bash', RUNNER, ...args], { env: base, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exit };
}
const creates = () => api.calls.filter(c => c[2] === 'create');
const destroyed = () => api.calls.filter(c => c[2] === 'destroy').map(c => c[1].split('/')[1]);

describe('ubi-runner.sh vCPU lines', () => {
  test("usage marks the caller's own row (you), and room counts it toward the crew's 208", async () => {
    project([['gbev95', 13], ['harn61', 4]]);
    const u = await runner(['usage']);
    expect(u.exit).toBe(0);
    expect(u.stdout).toMatch(/^gbev95 +13 +208 +\(you\)$/m);
    expect(u.stdout).toMatch(/^total +17 +272$/m);
    const r = await runner(['room', '-s', 'standard-16']);
    expect([r.exit, r.stdout.trim()]).toEqual([0, 'UBICLOUD_ROOM: room=0 size=standard-16 need=16 used=272 line=464 crew=gbev crew_used=208 crew_line=208']);
  });

  test("up refuses before any create when the caller's own VMs already hold the crew's 208, and creates at 192", async () => {
    project([['gbev95', 13]]);
    const full = await runner(['up', '-s', 'standard-16']);
    expect(full.exit).toBe(1);
    expect(full.stderr).toContain('quota preflight refused');
    expect(full.stderr).toContain('crew=gbev crew_used=208 crew_line=208');
    expect(creates()).toEqual([]);
    project([['gbev95', 12]]);
    const ok = await runner(['up', '-s', 'standard-16']);
    expect(ok.exit).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^ubirun-gbev95-\d{10}-[0-9a-f]{8}-t12$/);
    expect(creates()).toHaveLength(1);
  }, 30_000);

  test('every owner with the same leading letters is one crew; other letters, untagged and unnamed VMs count only toward the project', async () => {
    project([['gbev3', 6], ['gbev78', 6], ['gbev95', 1, 'standard-4'], ['gbevx1', 4], ['gbra108', 4], ['(other)', 2]]);
    api.vms.set(`ubirun-${NOW}-abcd1234`, { size: 'standard-16' });
    const u = await runner(['usage']);
    expect(u.stdout).toMatch(/^\(untagged\) +1 +16$/m);
    expect(u.stdout).toMatch(/^\(other\) +2 +32$/m);
    const r = await runner(['room', '-s', 'standard-4']);
    expect(r.stdout.trim()).toBe('UBICLOUD_ROOM: room=3 size=standard-4 need=4 used=372 line=464 crew=gbev crew_used=196 crew_line=208');
    const other = await runner(['room', '-s', 'standard-4'], { UBI_OWNER: 'GBRA-108' });
    expect(other.stdout.trim()).toBe('UBICLOUD_ROOM: room=23 size=standard-4 need=4 used=372 line=464 crew=gbra crew_used=64 crew_line=208');
  });

  test('the project line: a VM that would take the project past 464 is refused, one that lands exactly on it is not', async () => {
    project([['harn61', 28], ['geva2', 1, 'standard-2']]);
    expect((await runner(['room'])).stdout).toContain('room=0 size=standard-16 need=16 used=450');
    const refused = await runner(['up']);
    expect([refused.exit, creates()]).toEqual([1, []]);
    project([['harn61', 28]]);
    expect((await runner(['room'])).stdout).toContain('room=1 size=standard-16 need=16 used=448');
  }, 30_000);

  test('a failed usage read launches nothing: an unreadable VM list, or one VM whose size cannot be read', async () => {
    project([['harn61', 2]]);
    api.listFails = true;
    const r = await runner(['room']);
    expect([r.exit, r.stdout.trim()]).toEqual([1, 'UBICLOUD_ROOM: room=unknown size=standard-16']);
    const up = await runner(['up']);
    expect(up.exit).toBe(1);
    expect(up.stderr).toContain("quota preflight refused");
    expect(up.stderr).toContain("could not read the project's vCPU usage");
    expect(creates()).toEqual([]);
    project([['harn61', 2]]);
    api.showFails.add([...api.vms.keys()][0]);
    expect((await runner(['up'])).exit).toBe(1);
    expect(creates()).toEqual([]);
  }, 30_000);

  test('a VM whose size names no vCPU count (unknown, standard-) fails the usage read, so up creates nothing', async () => {
    for (const bad of ['unknown', 'standard-']) {
      project([['harn61', 1]]);
      api.vms.set(`ubirun-harn61-${NOW}-badsize1-t12`, { size: bad });
      const u = await runner(['usage']);
      expect([u.exit, u.stdout]).toEqual([1, '']);
      expect(u.stderr).toContain("usage: a VM's size names no vCPU count");
      const r = await runner(['room']);
      expect([r.exit, r.stdout.trim()]).toEqual([1, 'UBICLOUD_ROOM: room=unknown size=standard-16']);
      const up = await runner(['up']);
      expect(up.exit).toBe(1);
      expect(up.stderr).toContain("could not read the project's vCPU usage");
      expect(creates()).toEqual([]);
    }
  }, 30_000);

  test('UBI_QUOTA_WAIT reads again instead of refusing at once, and still refuses when no room comes', async () => {
    project([['gbev95', 13]]);
    const t0 = Date.now();
    const r = await runner(['up'], { UBI_QUOTA_WAIT: '2' });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain('reading again, up to 2s more');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    expect(creates()).toEqual([]);
  }, 30_000);

  test('creates from one machine take turns, so two launches with room for one make one VM', async () => {
    project([['gbev95', 12]]);
    api.createDelayMs = 1500;
    const state = join(tmp, 'shared-state');
    const [a, b] = await Promise.all([runner(['up'], {}, state), runner(['up'], {}, state)]);
    expect([a.exit, b.exit].sort()).toEqual([0, 1]);
    expect(creates()).toHaveLength(1);
    expect(a.stderr + b.stderr).toContain('quota preflight refused');
  }, 30_000);

  test('a create lock file left behind, empty or naming a dead holder, never blocks: three launches with room for one make one VM', async () => {
    for (const [kind, leftover] of [['empty', ''], ['stale', '2147483646\n']]) {
      project([['gbev95', 12]]);
      api.createDelayMs = 500;
      const state = join(tmp, `${kind}-lock-state`);
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, 'create.lock'), leftover);
      const runs = await Promise.all([1, 2, 3].map(() => runner(['up'], {}, state)));
      expect(runs.map(r => r.exit).sort()).toEqual([0, 1, 1]);
      expect(creates()).toHaveLength(1);
    }
  }, 60_000);

  test("the create lock is the kernel's: two launches wait while a live process holds it, and a holder killed with SIGKILL frees it for exactly one create", async () => {
    project([['gbev95', 12]]);
    const state = join(tmp, 'killed-holder-state');
    mkdirSync(state, { recursive: true });
    const holder = Bun.spawn(['bash', '-c', 'exec 9>>"$1/create.lock"; flock 9; echo held; exec sleep 60', '_', state], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    await holder.stdout.getReader().read();
    const waiting = Promise.all([runner(['up'], {}, state), runner(['up'], {}, state)]);
    await Bun.sleep(1500);
    expect(creates()).toEqual([]);
    holder.kill(9);
    const runs = await waiting;
    expect(runs.map(r => r.exit).sort()).toEqual([0, 1]);
    expect(creates()).toHaveLength(1);
  }, 30_000);

  test('up takes its create lock without util-linux flock, which macOS lacks: a flock that always fails is never called', async () => {
    project([['gbev95', 12]]);
    const noFlock = join(tmp, 'no-flock-bin');
    mkdirSync(noFlock, { recursive: true });
    writeFileSync(join(noFlock, 'flock'), '#!/usr/bin/env bash\nexit 1\n');
    chmodSync(join(noFlock, 'flock'), 0o755);
    const run = await runner(['up'], { PATH: `${noFlock}:${bin}:${process.env.PATH ?? ''}` });
    expect(run.exit).toBe(0);
    expect(creates()).toHaveLength(1);
  }, 30_000);
});

describe('ubi-runner.sh TTL and reaper', () => {
  test('ttl is UBI_TTL_HOURS rounded up, 12 when unset, and refuses anything outside 1-999', async () => {
    for (const [value, hours] of [[undefined, '12'], ['3', '3'], ['6.5', '7'], ['007', '7'], ['999', '999']] as const) {
      const r = await runner(['ttl'], { UBI_TTL_HOURS: value });
      expect([value, r.exit, r.stdout.trim()]).toEqual([value, 0, hours]);
    }
    for (const value of ['0', '1000', '3h']) {
      const r = await runner(['ttl'], { UBI_TTL_HOURS: value });
      expect([value, r.exit]).toEqual([value, 1]);
    }
  });

  test('up and run refuse, before any API request, without UBI_OWNER, with a bad TTL, or with a -n name that lacks this owner or a TTL', async () => {
    project([]);
    const cases: Array<[string[], Record<string, string | undefined>, string]> = [
      [['up'], { UBI_OWNER: undefined }, 'UBI_OWNER is not set'],
      [['run', '--', 'true'], { UBI_OWNER: undefined }, 'UBI_OWNER is not set'],
      [['up'], { UBI_TTL_HOURS: '0' }, 'UBI_TTL_HOURS must be'],
      [['up', '-n', `ubirun-gbev95-${NOW}-devloop-w1-ab12`], {}, 'invalid VM name'],
      [['up', '-n', `ubirun-gbev3-${NOW}-abcd-t4`], {}, 'invalid VM name'],
    ];
    for (const [args, env, msg] of cases) {
      const r = await runner(args, env);
      expect([args[0], r.exit]).toEqual([args[0], 1]);
      expect(r.stderr).toContain(msg);
    }
    expect(api.calls).toEqual([]);
  }, 30_000);

  test("reap destroys only the caller's own VMs past their TTL (and its own TTL-less ones past UBI_LEGACY_HOURS), never another owner's", async () => {
    const add = project([]);
    const expired = add('gbev95', { ageHours: 4, ttl: 3 });
    const live = add('gbev95', { ageHours: 2, ttl: 3 });
    const graced = add('gbev95', { ageHours: 3.1, ttl: 3 });
    const legacyOld = add('gbev95', { ageHours: 30, ttl: null });
    const legacyYoung = add('gbev95', { ageHours: 5, ttl: null });
    const otherExpired = add('gbev3', { ageHours: 40, ttl: 3 });
    const otherLegacy = add('gbev3', { ageHours: 40, ttl: null });
    api.vms.set('my-database-vm', { size: 'standard-2' });
    const r = await runner(['reap']);
    expect(r.exit).toBe(0);
    expect(destroyed().sort()).toEqual([expired, legacyOld].sort());
    expect([...api.vms.keys()].sort()).toEqual([live, graced, legacyYoung, otherExpired, otherLegacy, 'my-database-vm'].sort());
    expect(r.stderr).toContain('left 1 expired VMs of other owners');
  }, 30_000);

  test("up reaps the caller's expired VMs first, so the room they held counts as free, and the new VM's name carries its TTL", async () => {
    const add = project([['gbev95', 12]]);
    add('gbev95', { ageHours: 20, ttl: 12 });
    const r = await runner(['up'], { UBI_TTL_HOURS: '5' });
    expect(r.exit).toBe(0);
    expect(destroyed()).toHaveLength(1);
    expect(creates()).toHaveLength(1);
    expect(creates()[0][1]).toMatch(/^eu-central-h1\/ubirun-gbev95-\d{10}-[0-9a-f]{8}-t5$/);
    expect(r.stderr).toContain('carries a 5h TTL');
  }, 30_000);

  test('a failed VM list destroys nothing', async () => {
    project([]);
    api.listFails = true;
    const r = await runner(['reap']);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain('reap: could not list the project');
    expect(destroyed()).toEqual([]);
  });
});

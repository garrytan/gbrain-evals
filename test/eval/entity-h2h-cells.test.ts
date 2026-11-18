/**
 * Entity-dedupe head-to-head paid paths, keyless (preregistration, "Spend and safety"): memory-system cells and the
 * matcher through the real lease metering proxy (eval/runner/metering-proxy.ts) and budget ledger, with a fake shim
 * and a fake provider on loopback. Covers the ledger stop, the 345-page checkpoint, a crash and its one restart from
 * page one on a fresh namespace, "failed (infrastructure)" after a second failure, the reconcile and the
 * LEDGER_UNRECONCILED refusal, the matcher's resume rules and safety-filter stops, and the gbrain driver with a fake
 * binary. Provider keys are blanked, the proxy gets placeholder keys and every upstream is a local fake.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { MeteringProxy, keylessKeys, keylessUpstream } from '../../eval/runner/metering-proxy.ts';
import { reconcileRun, requireReconciled, writeCell, readCell, type CellState } from '../../eval/runner/entity-h2h/ledger.ts';
import { matcherStop, memoryStop } from '../../eval/runner/entity-h2h/rates.ts';
import { cli } from '../../eval/runner/entity-h2h/run.ts';
import { buildWorld, writeH2hWorld } from '../../eval/runner/entity-h2h/world.ts';

const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PARTICLE_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
const tmp = mkdtempSync(join(tmpdir(), 'entity-h2h-cells-'));
const quiet = () => {};

/** The fake provider: chat completions with `tokens` input tokens; `reply` picks the answer for request n. */
const upstream = { tokens: 10, n: 0, reply: (_n: number): { status: number; finish?: string; text?: string } => ({ status: 200 }) };
const fakeProvider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
  await req.text();
  const r = upstream.reply(++upstream.n);
  return Response.json({ model: 'gpt-6.2-sol', choices: [{ message: { content: r.text ?? 'no - different' }, finish_reason: r.finish ?? 'stop' }], usage: { prompt_tokens: upstream.tokens, completion_tokens: 0 } }, { status: r.status });
} });

/** The fake memory system: each ingest makes one provider call through the proxy's slot; /entities makes one node per page title. */
const shim = { failAt: 0, system: 'ext-memory-bank', proxy: '', nsOrder: [] as string[], ingests: new Map<string, string[]>() };
const fakeShim = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
  const path = new URL(req.url).pathname;
  const body = req.method === 'POST' ? await req.json() as any : {};
  const err = (status: number, kind: string, message: string) => Response.json({ error: { kind, message } }, { status });
  if (path === '/health') return Response.json({ ok: true, config: 'entity-h2h' });
  if (path === '/capabilities') return Response.json({ protocol: 1, system: shim.system, versions: { package: '0.0.0-fake' }, configs: { 'entity-h2h': { model_roles: { extraction: 'gpt-6.2-sol' } } } });
  if (path === '/reset') { shim.nsOrder.push(body.ns); shim.ingests.set(body.ns, []); return Response.json({ ok: true }); }
  if (path === '/ingest') {
    const done = shim.ingests.get(body.ns)!;
    if (shim.failAt && done.length + 1 === shim.failAt) return err(500, 'product_error', 'fake: the vendor crashed');
    const res = await fetch(`${shim.proxy}/${shim.system}/openai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dummy' }, body: JSON.stringify({ model: 'gpt-6.2-sol', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }) });
    if (res.status === 402) return err(402, 'budget', 'fake: the proxy refused for budget');
    done.push(body.session.source_id + '\t' + body.session.turns[0].content);
    return Response.json({ items_created: 1, completeness: 'known' });
  }
  if (path === '/finish') return Response.json({ ready: true, waited_ms: 0, completeness: 'known' });
  if (path === '/entities') {
    const ns = new URL(req.url).searchParams.get('ns')!;
    const nodes = new Map<string, string[]>();
    for (const line of shim.ingests.get(ns) ?? []) {
      const [src, text] = line.split('\t');
      const title = /\n# (.+)\n/.exec(text)![1];
      nodes.set(title.toLowerCase(), [...(nodes.get(title.toLowerCase()) ?? []), src]);
    }
    return Response.json({ entities: [...nodes].map(([name, srcs]) => ({ id: name, name, type: 'Person', source_ids: srcs, provenance_status: 'exact' })), links: [] });
  }
  return err(404, 'invalid_request', path);
} });

beforeAll(() => { for (const k of KEYS) { saved[k] = process.env[k]; process.env[k] = ''; } });
afterAll(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  fakeProvider.stop(true); fakeShim.stop(true); closeLedgers();
});

/** A lease proxy on its own ledger, as the VM's bootstrap.sh proxy starts it. */
function leaseProxy(runId: string, leaseUsd: number) {
  const ledgerPath = join(tmp, `${runId}.sqlite`), usageLog = join(tmp, `${runId}.usage.ndjson`);
  const lease = BudgetRun.openLease({ runId, leaseUsd, ledgerPath });
  const proxy = new MeteringProxy({ upstream: keylessUpstream(`http://127.0.0.1:${fakeProvider.port}`), policy: { lease, usageLog, env: keylessKeys() } });
  proxy.start();
  const url = `http://127.0.0.1:${proxy.port}`;
  shim.proxy = url;
  return { proxy, url, ledgerPath, usageLog, args: ['--proxy', url, '--budget-ledger', ledgerPath, '--budget-run-id', runId, '--usage-log', usageLog] };
}
const shimArgs = () => ['--shim', `http://127.0.0.1:${fakeShim.port}`];
const world = (name: string, seed: number, perFamily: number) => { const d = join(tmp, name); writeH2hWorld(d, seed, perFamily); return d; };
const reset = (tokens: number, failAt = 0) => { upstream.tokens = tokens; upstream.n = 0; upstream.reply = () => ({ status: 200 }); shim.failAt = failAt; shim.nsOrder = []; shim.ingests = new Map(); };

describe('memory-system cells', () => {
  test('a cell ingests every page in the fixed order, writes the neutral output and a hand-check sample, and scores', async () => {
    reset(10);
    const w = world('w-ok', 7, 1), out = join(tmp, 'c-ok');
    const stop = memoryStop('ext-memory-bank', 94).stop_usd;
    const big = leaseProxy('ok-big', stop + 1);
    await expect(cli(['run', '--system', 'ext-memory-bank', '--config', 'default', '--world', w, '--output', join(tmp, 'c-big'), ...shimArgs(), ...big.args], quiet)).rejects.toThrow(/more than the \$0\.32 left of the cell's stop/);
    big.proxy.stop();
    const p = leaseProxy('ok-1', stop);
    try { expect(await cli(['run', '--system', 'ext-memory-bank', '--config', 'default', '--world', w, '--output', out, ...shimArgs(), ...p.args], quiet)).toBe(0); }
    finally { p.proxy.stop(); }
    const s = readCell(out)!;
    expect([s.status, s.attempts.length, s.attempts[0].done, s.stop_usd]).toEqual(['complete', 1, 94, stop]);
    const output = JSON.parse(readFileSync(join(out, 'output.json'), 'utf8'));
    expect(Object.keys(output).sort()).toEqual(['config', 'model', 'system', 'tiers', 'version']);
    expect([output.system, output.model, output.tiers.auto.length > 0]).toEqual(['ext-memory-bank', 'openai:gpt-6.2-sol', true]);
    expect(JSON.parse(readFileSync(join(out, 'hand-check-sample.json'), 'utf8')).sample).toHaveLength(50);
    expect(await cli(['score', '--world', w, '--json-out', join(tmp, 'ok-scores.json'), out], quiet)).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, 'ok-scores.json'), 'utf8')).scores[0].unresolved).toBe(0);
  }, 60_000);

  // Value: protects=the 345-page checkpoint and continue-after-pause rules; fails_when=the checkpoint never fires, projects from the wrong spend, or a continue skips the reconcile, reuses a paid run or resumes in place
  test('the 345-page checkpoint pauses a run its measured rate projects past the stop; continue needs the reconcile and a new paid run, and starts from page one', async () => {
    reset(1750);
    const w = world('w-cp', 7, 4), out = join(tmp, 'c-cp');
    const stop = memoryStop('ext-memory-bank', 377).stop_usd;
    const p1 = leaseProxy('cp-1', stop);
    let code: number;
    try { code = await cli(['run', '--system', 'ext-memory-bank', '--config', 'default', '--world', w, '--output', out, ...shimArgs(), ...p1.args], quiet); }
    finally { /* stopped below, after the live-proxy reconcile check */ }
    expect(code).toBe(4);
    let s = readCell(out)!;
    expect([s.attempts[0].status, s.attempts[0].done]).toEqual(['paused', 345]);
    expect(s.attempts[0].checkpoint!.projected_usd).toBeGreaterThan(stop);
    expect(s.attempts[0].checkpoint!.usd_per_page).toBeCloseTo(0.0035, 6);
    const p2 = leaseProxy('cp-2', 1.7);
    expect(await cli(['continue', '--output', out, '--stop-usd', '3', ...shimArgs(), ...p2.args], quiet)).toBe(2);
    await expect(cli(['reconcile', '--output', out, '--proxy', p1.url], quiet)).rejects.toThrow(/still answers/);
    p1.proxy.stop();
    expect(await cli(['reconcile', '--output', out], quiet)).toBe(0);
    await expect(cli(['restart', '--output', out, ...shimArgs(), ...p2.args], quiet)).rejects.toThrow(/continue/);
    await expect(cli(['continue', '--output', out, '--stop-usd', '3', ...shimArgs(), ...p1.args], quiet)).rejects.toThrow(/already paid for an attempt/);
    try { expect(await cli(['continue', '--output', out, '--stop-usd', '3', ...shimArgs(), ...p2.args], quiet)).toBe(0); }
    finally { p2.proxy.stop(); }
    s = readCell(out)!;
    expect([s.status, s.stop_usd, s.attempts.map(a => [a.kind, a.status, a.done])]).toEqual(['complete', 3, [['first', 'paused', 345], ['continue', 'complete', 377]]]);
    expect(new Set(shim.nsOrder).size).toBe(2);
    const first = (ns: string) => shim.ingests.get(ns)![0].split('\t')[1];
    expect(first(shim.nsOrder[1])).toBe(first(shim.nsOrder[0]));
  }, 120_000);

  test('a ledger stop pauses the run when the proxy refuses for budget', async () => {
    reset(40_000);
    const w = world('w-ls', 7, 1), out = join(tmp, 'c-ls');
    const p = leaseProxy('ls-1', memoryStop('ext-memory-bank', 94).stop_usd);
    try { expect(await cli(['run', '--system', 'ext-memory-bank', '--config', 'default', '--world', w, '--output', out, ...shimArgs(), ...p.args], quiet)).toBe(4); }
    finally { p.proxy.stop(); }
    const a = readCell(out)!.attempts[0];
    expect(a.status).toBe('paused');
    expect(a.reason).toMatch(/^ledger stop/);
    expect(a.done).toBeLessThan(10);
  }, 60_000);

  // Value: protects=crash and resume (never in place, one restart, then failed (infrastructure)) and LEDGER_UNRECONCILED; fails_when=a restart resumes a namespace, skips the reconcile or a cell gets a third attempt
  test('a crash restarts once from page one on a fresh namespace after the reconcile; a second failure is failed (infrastructure)', async () => {
    reset(10, 5);
    const w = world('w-cr', 7, 1), out = join(tmp, 'c-cr');
    const stop = memoryStop('ext-memory-bank', 94).stop_usd;
    const p1 = leaseProxy('cr-1', stop);
    try { expect(await cli(['run', '--system', 'ext-memory-bank', '--config', 'default', '--world', w, '--output', out, ...shimArgs(), ...p1.args], quiet)).toBe(2); }
    finally { p1.proxy.stop(); }
    expect(readCell(out)!.attempts[0]).toMatchObject({ status: 'import_incomplete', done: 4 });
    expect(existsSync(join(out, 'output.json'))).toBe(false);
    const p2 = leaseProxy('cr-2', stop - 0.01);
    shim.failAt = 3;
    expect(await cli(['restart', '--output', out, ...shimArgs(), ...p2.args], quiet)).toBe(2);
    expect(await cli(['reconcile', '--output', out], quiet)).toBe(0);
    try { expect(await cli(['restart', '--output', out, ...shimArgs(), ...p2.args], quiet)).toBe(5); }
    finally { p2.proxy.stop(); }
    const s = readCell(out)!;
    expect([s.status, s.attempts.map(a => [a.kind, a.status, a.done])]).toEqual(['failed (infrastructure)', [['first', 'import_incomplete', 4], ['restart', 'import_incomplete', 2]]]);
    expect(s.attempts[0].ns).not.toBe(s.attempts[1].ns);
    expect(shim.nsOrder).toEqual([s.attempts[0].ns!, s.attempts[1].ns!]);
    const p3 = leaseProxy('cr-3', 0.01);
    try { expect(await cli(['restart', '--output', out, ...shimArgs(), ...p3.args], quiet)).toBe(5); } finally { p3.proxy.stop(); }
    await expect(cli(['score', '--world', w, out], quiet)).rejects.toThrow(/failed \(infrastructure\)/);
  }, 60_000);
});

describe('reconcile', () => {
  test('an open reservation is closed at its full reservation, and a ledger changed after the reconcile, or a log line with no entry, is refused', async () => {
    const dir = join(tmp, 'rc');
    const ledgerPath = join(tmp, 'rc.sqlite'), usageLog = join(tmp, 'rc.ndjson');
    const run = BudgetRun.openLease({ runId: 'rc-1', leaseUsd: 1, ledgerPath });
    const done = run.reserve(0.2, 'settled');
    run.settle(done, { usd: 0.05, input_tokens: 1, output_tokens: 1 });
    run.reserve(0.3, 'left open by a crash');
    writeFileSync(usageLog, JSON.stringify({ at: 'x', key: 'k', request_id: 'rc-1-1', provider: 'openai', model: 'm', outcome: 'forwarded', actual_usd: 0.05 }) + '\n');
    const w = buildWorld(7, 1);
    const paid = { budget_ledger: ledgerPath, run_id: 'rc-1', usage_log: usageLog };
    const s: CellState = { cell: 'entity-h2h', system: 'ext-memory-bank', config: 'default', model: null, world_dir: '/x', world: { seed: 7, per_family: 1, pages: w.pages.length, people_ledger_sha256: w.fingerprints.people, company_ledger_sha256: w.fingerprints.companies }, projected_usd: 1, stop_usd: 1, status: 'open',
      attempts: [{ n: 1, kind: 'first', status: 'crashed', pid: 1, started_at: 'x', finished_at: 'x', paid, done: 0, reason: 'test' }] };
    mkdirSync(dir);
    writeCell(dir, s);
    expect(() => requireReconciled(dir, s)).toThrow(/LEDGER_UNRECONCILED/);
    const rec = await reconcileRun(dir, paid, null);
    expect(rec.closed_open.map(x => x.reserved_usd)).toEqual([0.3]);
    expect(requireReconciled(dir, s)).toBeCloseTo(0.35, 9);
    run.settle(run.reserve(0.01, 'later'), { usd: 0.01 });
    expect(() => requireReconciled(dir, s)).toThrow(/REFUSED LEDGER_UNRECONCILED: .*changed after its reconcile/);
    appendFileSync(usageLog, [2, 3, 4].map(n => JSON.stringify({ at: 'x', key: 'k', request_id: `rc-1-${n}`, provider: 'openai', model: 'm', outcome: 'forwarded', actual_usd: 1 })).join('\n') + '\n');
    await expect(reconcileRun(dir, paid, null)).rejects.toThrow(/REFUSED LEDGER_UNRECONCILED/);
  });
});

describe('matcher cells', () => {
  // Value: protects=the matcher's resume rule (re-ask only unsent pairs, a sent pair once) and safety stops as their own outcome; fails_when=a resume re-asks settled pairs, re-asks a pair twice, or counts a safety stop as an error
  test('logs the pair count first, records a safety stop, and a resume asks a sent pair with no verdict once more after the reconcile', async () => {
    reset(10);
    upstream.reply = n => (n <= 3 ? { status: 500 } : n === 4 ? { status: 200, finish: 'content_filter', text: '' } : n % 7 === 0 ? { status: 200, text: 'yes - same' } : { status: 200 });
    const w = world('w-m', 7, 1), out = join(tmp, 'c-m');
    const stop = matcherStop('openai:gpt-6.2-sol', 147).stop_usd;
    const p1 = leaseProxy('m-1', stop);
    try { expect(await cli(['run', '--system', 'llm-matcher', '--model', 'openai:gpt-6.2-sol', '--world', w, '--output', out, '--concurrency', '1', ...p1.args], quiet)).toBe(3); }
    finally { p1.proxy.stop(); }
    expect(JSON.parse(readFileSync(join(out, 'pairs.json'), 'utf8')).pairs).toBe(147);
    expect(readCell(out)!.attempts[0].status).toBe('crashed');
    const p2 = leaseProxy('m-2', 0.05);
    expect(await cli(['resume', '--output', out, ...p2.args], quiet)).toBe(2);
    expect(await cli(['reconcile', '--output', out], quiet)).toBe(0);
    const before = upstream.n;
    try { expect(await cli(['resume', '--output', out, '--concurrency', '1', ...p2.args], quiet)).toBe(0); }
    finally { p2.proxy.stop(); }
    expect(upstream.n - before).toBe(3);
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect([summary.pairs, summary.asked_again, summary.outcomes.safety_stop, summary.outcomes.no_verdict]).toEqual([147, 3, 1, 0]);
    expect(summary.outcomes.yes + summary.outcomes.no + summary.outcomes.unsure + summary.outcomes.unparsed + summary.outcomes.safety_stop).toBe(147);
    expect(await cli(['score', '--world', w, '--json-out', join(tmp, 'm-scores.json'), out], quiet)).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, 'm-scores.json'), 'utf8')).scores[0].not_a_candidate).not.toBeNull();
  }, 60_000);
});

describe('gbrain driver', () => {
  test('imports each source into a fresh home with no keys, refuses an incomplete import, and writes the neutral output', async () => {
    const w = world('w-g', 7, 1);
    const bin = join(tmp, 'fake-gbrain.sh');
    writeFileSync(bin, `#!/usr/bin/env bash
set -eu
[ -z "\${OPENAI_API_KEY:-}" ] || { echo "a key reached gbrain" >&2; exit 9; }
echo "$*" >> "$HOME/../calls"
case $1 in
  init|sources) ;;
  import) n=$(find "$2" -name '*.md' | wc -l); [ -f "$HOME/../../short" ] && n=$((n-1)); echo "{\\"status\\":\\"success\\",\\"source_id\\":\\"$4\\",\\"imported\\":$n,\\"unchanged\\":0,\\"total_files\\":$n,\\"errors\\":0,\\"malformed_skipped\\":0,\\"failures\\":[]}" ;;
  dedupe) cat "$FAKE_FINDER" ;;
esac
`);
    chmodSync(bin, 0o755);
    const pages = buildWorld(7, 1).pages;
    const [a, b] = pages.filter(p => p.type === 'person');
    const finder = { schema_version: 1, counts: { by_kind: {}, by_class: {}, crowded_key_values: 0 }, groups: [
      { id: 'g1', kind: 'cross_source', class: 'clean', members: [{ source_id: a.source, slug: `people/${a.key.split(':')[1]}` }, { source_id: b.source, slug: `people/${b.key.split(':')[1]}` }], evidence: [] },
      { id: 'g2', kind: 'cross_source', class: 'likely', members: [{ source_id: a.source, slug: `people/${a.key.split(':')[1]}` }, { source_id: b.source, slug: `people/${b.key.split(':')[1]}` }], evidence: [] },
    ] };
    writeFileSync(join(tmp, 'finder.json'), JSON.stringify(finder));
    process.env.FAKE_FINDER = join(tmp, 'finder.json');
    process.env.OPENAI_API_KEY = 'must-not-reach-gbrain';
    try {
      const out = join(tmp, 'g-ok');
      expect(await cli(['run', '--system', 'gbrain', '--world', w, '--output', out, '--gbrain-bin', bin, '--build', 'v-test', '--sandbox', 'none'], quiet)).toBe(0);
      const o = JSON.parse(readFileSync(join(out, 'output.json'), 'utf8'));
      expect([o.system, o.version, o.tiers.auto.length, o.tiers.proposed.length]).toEqual(['gbrain', 'v-test', 1, 0]);
      expect(readFileSync(join(out, 'calls'), 'utf8')).toContain('init --pglite --no-embedding');
      const short = join(tmp, 'g-short');
      mkdirSync(short);
      writeFileSync(join(short, 'short'), '');
      expect(await cli(['run', '--system', 'gbrain', '--world', w, '--output', join(short, 'cell'), '--gbrain-bin', bin, '--build', 'v-test', '--sandbox', 'none'], quiet)).toBe(2);
    } finally { process.env.OPENAI_API_KEY = ''; delete process.env.FAKE_FINDER; }
  });
});

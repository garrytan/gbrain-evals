/**
 * lifecycle-lite (shootout P2, update and forget): generator determinism and
 * oracle invariants, the scorer on hand-built items, the phase gate (the
 * mutation kit: the honest reference passes and every fake fails the check
 * its cheat trips), and keyless end-to-end runs over the in-process fake,
 * the Python fake shim (with a real process restart), the CLI, and
 * in-process gbrain-shootout with hash vectors and a local rerank stub.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateN1World } from '../../eval/generators/n1-knowledge-update-gen.ts';
import { generateN5World } from '../../eval/generators/n5-forget-residue-gen.ts';
import { CANARY_LEXICON, generateLifecycleLiteWorld, LIFECYCLE_LITE_SEEDS, matchesAny, sanitizerCorpus, type LiteProbe } from '../../eval/generators/lifecycle-lite-gen.ts';
import { EXPECTED_FAILURE, HonestReferenceSystem, mutationFake, MUTATION_FAKES, scriptedReaderJudge } from '../../eval/runner/lifecycle-lite/fakes.ts';
import { expectedIds, runLifecycleLite } from '../../eval/runner/lifecycle-lite/run.ts';
import { activeAt, HEADLINE_CHECKS, LIFECYCLE_LITE_CHECKS, liteChecks, liteMetrics, scoreProbe, type LiteChecks, type LiteMetrics, type LiteRow } from '../../eval/runner/lifecycle-lite/score.ts';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { HttpMemorySystem } from '../../eval/runner/systems/http.ts';
import { findLeaks, forbiddenMarkers } from '../../eval/runner/systems/sanitize.ts';
import type { Item } from '../../eval/runner/systems/types.ts';

const ROOT = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
const fresh = (label: string) => { const d = mkdtempSync(join(tmpdir(), `lifecycle-lite-${label}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const item = (rank: number, text: string, valid_from: string | null = null, valid_to: string | null = null): Item => ({ id: `i${rank}`, rank, type: 'fact', text, source_ids: [], valid_from, valid_to, provenance_status: 'unavailable' });
const sessionText = (w: ReturnType<typeof generateLifecycleLiteWorld>, id: string) => w.conversation.sessions.find(s => s.id === id)!.turns.map(t => t.content).join('\n');

describe('lifecycle-lite generator', () => {
  test('same seed, same ledger; different seeds differ', () => {
    for (const seed of LIFECYCLE_LITE_SEEDS) expect(generateLifecycleLiteWorld({ seed }).fingerprint).toBe(generateLifecycleLiteWorld({ seed }).fingerprint);
    expect(new Set(LIFECYCLE_LITE_SEEDS.map(seed => generateLifecycleLiteWorld({ seed }).fingerprint)).size).toBe(LIFECYCLE_LITE_SEEDS.length);
  });

  test('chains keep the N1 fence structure and canaries keep the N5 roles', () => {
    for (const seed of LIFECYCLE_LITE_SEEDS) {
      const w = generateLifecycleLiteWorld({ seed });
      const n1 = generateN1World({ seed }).ledger.fence;
      expect(w.chains.map(c => [c.id, c.kind, c.depth, c.values.map(v => v.date)])).toEqual(n1.map(c => [c.id, c.kind, c.depth, c.values.map(v => v.valid_from)]));
      for (const [k, c] of w.chains.entries()) {
        const same = (i: number, j: number) => n1[k].values[i].label === n1[k].values[j].label;
        for (let i = 0; i < c.values.length; i++) for (let j = 0; j < c.values.length; j++) expect(c.values[i].label === c.values[j].label).toBe(same(i, j));
      }
      const n5 = generateN5World({ seed }).ledger.canaries.filter(c => !c.twin_of && ['forgotten', 'late-forgotten', 'retained'].includes(c.role));
      expect(w.canaries.map(c => [c.id, c.phrase, c.role])).toEqual(n5.map(c => [c.id, c.phrase, c.role === 'retained' ? 'survivor' : 'delete']));
      expect(w.deletes.map(d => d.canary)).toEqual(w.canaries.filter(c => c.role === 'delete').map(c => c.id));
    }
    for (let seed = 1; seed <= 40; seed++) for (const c of generateN5World({ seed }).ledger.canaries.filter(c => c.role === 'retained' || c.role === 'forgotten' || c.role === 'late-forgotten')) expect([c.phrase, c.phrase in CANARY_LEXICON]).toEqual([c.phrase, true]);
  });

  test('every pattern matches only its own sessions, and no label contains another', () => {
    for (const seed of LIFECYCLE_LITE_SEEDS) {
      const w = generateLifecycleLiteWorld({ seed });
      for (const c of w.chains) for (const v of c.values) {
        const own = c.values.filter(x => x.label === v.label).map(x => x.session);
        for (const s of w.conversation.sessions) expect([v.label, s.id, matchesAny(sessionText(w, s.id), [v.pattern])]).toEqual([v.label, s.id, own.includes(s.id)]);
      }
      for (const c of w.canaries) for (const s of w.conversation.sessions) expect([c.phrase, s.id, matchesAny(sessionText(w, s.id), c.patterns)]).toEqual([c.phrase, s.id, s.id === c.session]);
      const labels = [...new Set(w.chains.flatMap(c => c.values.map(v => v.label)))];
      for (const a of labels) for (const b of labels) if (a !== b) expect([a, b, b.toLowerCase().includes(a.toLowerCase())]).toEqual([a, b, false]);
    }
  });

  test('probes: one current and one as-of probe per chain, one per canary; as-of dates sit between the first two values', () => {
    const w = generateLifecycleLiteWorld({ seed: 1 });
    const kinds = (k: string) => w.probes.filter(p => p.kind === k).length;
    expect([kinds('update_current'), kinds('update_asof'), kinds('forget_target'), kinds('survivor')]).toEqual([12, 12, 10, 7]);
    for (const p of w.probes.filter((p): p is Extract<LiteProbe, { kind: 'update_asof' }> => p.kind === 'update_asof')) {
      const c = w.chains.find(x => x.id === p.chain)!;
      expect(p.query_time > `${c.values[0].date}T00:00:00` && p.query_time < `${c.values[1].date}T00:00:00`).toBe(true);
      expect(p.future.map(f => f.label)).not.toContain(p.gold);
    }
    for (const p of w.probes.filter((p): p is Extract<LiteProbe, { kind: 'update_current' }> => p.kind === 'update_current')) expect(p.stale.map(s => s.label)).not.toContain(p.gold);
    const last = w.conversation.sessions.map(s => s.date!).sort().pop()!;
    expect(w.now > `${last}T00:00:00`).toBe(true);
  });

  test('no forbidden marker (probe ids, kinds, session ids) appears in what a system sees', () => {
    const worlds = LIFECYCLE_LITE_SEEDS.map(seed => generateLifecycleLiteWorld({ seed }));
    const markers = forbiddenMarkers(sanitizerCorpus(worlds));
    expect(markers).toContain('update_current');
    expect(markers).toContain(worlds[0].deletes[0].session);
    for (const w of worlds) {
      for (const s of w.conversation.sessions) expect(findLeaks(JSON.stringify(s.turns), markers)).toEqual([]);
      for (const p of w.probes) expect(findLeaks(p.question, markers)).toEqual([]);
    }
  });
});

describe('lifecycle-lite scorer', () => {
  const w = generateLifecycleLiteWorld({ seed: 1 });
  const upd = w.probes.find((p): p is Extract<LiteProbe, { kind: 'update_current' }> => p.kind === 'update_current' && p.stale.length > 0)!;
  const asof = w.probes.find((p): p is Extract<LiteProbe, { kind: 'update_asof' }> => p.kind === 'update_asof' && p.future.length > 0)!;
  const target = w.probes.find((p): p is Extract<LiteProbe, { kind: 'forget_target' }> => p.kind === 'forget_target')!;
  const stale = upd.stale[0].label;

  test('activeAt: undated items are active; superseded and future-dated items are not', () => {
    expect(activeAt({ valid_from: null, valid_to: null }, '2022-01-01T00:00:00')).toBe(true);
    expect(activeAt({ valid_from: '2021-01-01T00:00:00Z', valid_to: '2021-06-01T00:00:00+00:00' }, '2022-01-01T00:00:00')).toBe(false);
    expect(activeAt({ valid_from: '2023-01-01', valid_to: null }, '2022-01-01T00:00:00')).toBe(false);
    expect(activeAt({ valid_from: '2021-01-01', valid_to: '2023-01-01' }, '2022-01-01T00:00:00')).toBe(true);
  });

  test('update: the new value alone passes; a stale value marked superseded is history; an active stale value fails', () => {
    expect(scoreProbe(upd, 'witness', [item(1, `They live in ${upd.gold} now.`)]).pass).toBe(true);
    const marked = scoreProbe(upd, 'witness', [item(1, `in ${upd.gold}`), item(2, `in ${stale}`, '2019-01-01', '2020-01-01')]);
    expect([marked.pass, marked.stale_marked, marked.stale_active]).toEqual([true, [stale], []]);
    const both = scoreProbe(upd, 'witness', [item(1, `in ${upd.gold}`), item(2, `in ${stale}`)]);
    expect([both.pass, both.stale_active]).toEqual([false, [stale]]);
    const mixed = scoreProbe(upd, 'witness', [item(1, `moved from ${stale} to ${upd.gold}`)]);
    expect([mixed.pass, mixed.mixed_items]).toEqual([false, 1]);
    expect(scoreProbe(upd, 'witness', [item(1, `in ${stale}`)]).pass).toBe(false);
    expect(scoreProbe(upd, 'witness', []).pass).toBe(false);
  });

  test('as-of: a later value dated after the question date is not active; an undated one is', () => {
    const later = asof.future[0].label;
    expect(scoreProbe(asof, 'witness', [item(1, asof.gold, '2018-01-01'), item(2, later, '2030-01-01')]).pass).toBe(true);
    expect(scoreProbe(asof, 'witness', [item(1, asof.gold), item(2, later)]).pass).toBe(false);
  });

  test('forget: a target never surfaced is no-signal, not a forget; residue fails; a target lost before its delete is counted', () => {
    const word = CANARY_LEXICON[w.canaries.find(c => c.id === target.canary)!.phrase].stems[0];
    const rowsFor = (witness: boolean, pre: boolean, after: boolean) => [
      scoreProbe(target, 'witness', witness ? [item(1, `yes, ${word}`)] : []),
      scoreProbe(target, 'pre_delete', pre ? [item(1, `yes, ${word}`)] : []),
      scoreProbe(target, 'after_delete', after ? [item(1, `still ${word}`)] : []),
    ];
    const run = (rows: LiteRow[]) => liteMetrics([target], rows, [{ seed: 1, canary: target.canary, probe: target.id, status: 'deleted' }], false);
    expect(run(rowsFor(true, true, false)).metrics.forget).toMatchObject({ signal: 1, forgotten: 1 });
    expect(run(rowsFor(true, true, true)).metrics.forget).toMatchObject({ signal: 1, forgotten: 0, residue_after_delete: 1 });
    expect(run(rowsFor(false, false, true)).metrics.forget).toMatchObject({ signal: 0, no_signal: 1, forgotten: 0 });
    expect(run(rowsFor(true, false, false)).metrics.forget).toMatchObject({ signal: 0, lost_before_delete: 1 });
    expect(liteChecks(run(rowsFor(false, false, false)).metrics).forget).toBe('no_signal');
  });

  test('a harness failure makes the run incomplete, never a product loss', () => {
    const rows = [scoreProbe(upd, 'after_delete', [item(1, upd.gold)])];
    rows[0].outcome = 'harness_invalid';
    const { metrics } = liteMetrics([upd], rows, [], false);
    expect(liteChecks(metrics).overall).toBe('incomplete');
  });
});

/** Run the real runner over one system on two seeds, with or without a restart, with the keyless scripted reader and judge unless `reader` is false. */
async function gate(system: HonestReferenceSystem | FakeMemorySystem | HttpMemorySystem, restart: (() => Promise<void>) | null, label: string, reader = true) {
  const worlds = [1, 2].map(seed => generateLifecycleLiteWorld({ seed }));
  const qa = reader ? { reader: 'scripted', judge: 'scripted', budgetTokens: 8000, chat: scriptedReaderJudge() } : null;
  const { receipt } = await runLifecycleLite({ system, worlds, output: fresh(label), restart: restart ? { run: restart, how: 'test' } : null, qa, log: () => {} });
  return { checks: receipt.checks as LiteChecks, metrics: receipt.metrics as LiteMetrics, receipt };
}

describe('lifecycle-lite phase gate: the mutation suite rejects every fake', () => {
  test('the honest reference passes every check, restart included', async () => {
    const s = new HonestReferenceSystem();
    const { checks, metrics } = await gate(s, () => s.restart(), 'honest');
    expect(checks).toEqual({ update: 'pass', update_retrieval: 'pass', asof: 'pass', forget: 'pass', survivors: 'pass', restart: 'pass', overall: 'pass', failed: [], report_only_failed: [] });
    expect([metrics.forget.signal, metrics.survivors.witnessed, s.restarts]).toEqual([20, 38, 2]);
    expect([metrics.reader.update.correct, metrics.reader.asof.correct, metrics.reader.forget.not_affirmed, metrics.reader.survivors.confirmed]).toEqual([24, 24, 20, 14]);
    expect(LIFECYCLE_LITE_CHECKS.survivor_floor).toBe(1);
  });

  for (const kind of MUTATION_FAKES) {
    test(`${kind} fails, on ${EXPECTED_FAILURE[kind].join(' and ')}`, async () => {
      const s = mutationFake(kind);
      const { checks } = await gate(s, () => s.restart(), kind);
      for (const check of EXPECTED_FAILURE[kind]) expect([kind, check, checks[check] === 'pass']).toEqual([kind, check, false]);
      const headline = EXPECTED_FAILURE[kind].some(c => (HEADLINE_CHECKS as readonly string[]).includes(c));
      expect([kind, checks.overall]).toEqual([kind, headline ? 'fail' : 'pass']);
      if (!headline) expect(checks.report_only_failed.length).toBeGreaterThan(0);
    });
  }

  test('serves-both: the reader still answers with the new value, so only the retrieval check reports it', async () => {
    const s = mutationFake('serves-both');
    const { checks, metrics } = await gate(s, () => s.restart(), 'serves-both-reader');
    expect([checks.update, checks.update_retrieval, metrics.reader.update.correct, metrics.update.stale_active]).toEqual(['pass', 'fail', 24, 24]);
  });

  test('without the reader the headline update check is not run and stays out of the verdict', async () => {
    const { checks, metrics } = await gate(new HonestReferenceSystem(), null, 'no-reader', false);
    expect([checks.update, checks.overall, metrics.reader.ran]).toEqual(['not_run', 'pass', false]);
  });

  test('without a restart checkpoint, forgets-on-restart is not caught (so the counted run keeps the restart)', async () => {
    const { checks } = await gate(mutationFake('forgets-on-restart'), null, 'no-restart');
    expect([checks.overall, checks.restart]).toEqual(['pass', 'not_run']);
  });

  test('the same verdicts over protocol v1 HTTP (honest and never-deletes)', async () => {
    const honest = new HonestReferenceSystem(), never = mutationFake('never-deletes');
    const a = serveProtocol(honest), b = serveProtocol(never);
    try {
      expect((await gate(new HttpMemorySystem(a.url), () => honest.restart(), 'http-honest')).checks.overall).toBe('pass');
      const n = await gate(new HttpMemorySystem(b.url), () => never.restart(), 'http-never');
      expect([n.checks.overall, n.checks.forget]).toEqual(['fail', 'fail']);
    } finally { a.stop(); b.stop(); }
  });
});

describe('lifecycle-lite end to end (keyless)', () => {
  test('canonical rows, outcomes and a receipt; the episodic fake keeps old values active', async () => {
    const { checks, metrics, receipt } = await gate(new FakeMemorySystem(), null, 'episodic');
    const out = (receipt.files as Record<string, string>);
    expect(receipt.run_status).toBe('complete');
    expect(Object.values(out).length).toBeGreaterThan(5);
    expect([checks.update_retrieval, checks.forget, checks.survivors, checks.restart]).toEqual(['fail', 'pass', 'pass', 'not_run']);
    expect(metrics.update.stale_active).toBeGreaterThan(0);
    expect(metrics.reader.update.correct).toBeGreaterThan(metrics.update.correct);
  });

  test('a resumed run with every row final skips the seeds; a changed configuration is refused', async () => {
    const worlds = [generateLifecycleLiteWorld({ seed: 3 })];
    const dir = fresh('resume');
    const s = new HonestReferenceSystem();
    await runLifecycleLite({ system: s, worlds, output: dir, log: () => {} });
    const lines: string[] = [];
    const again = await runLifecycleLite({ system: s, worlds, output: dir, log: l => lines.push(l) });
    expect(lines.join('\n')).toContain('every row is final, skipped');
    expect((again.receipt.outcomes as Record<string, number>).scored).toBe(expectedIds(worlds[0], false).length);
    await expect(runLifecycleLite({ system: s, worlds, output: dir, policyMode: 'vendor-default', log: () => {} })).rejects.toThrow(/different run configuration/);
  });

  describe('the Python fake shim', () => {
    const procs: Array<ReturnType<typeof Bun.spawn>> = [];
    afterAll(() => { for (const p of procs) p.kill(); });
    const start = async (port: number, stateFile: string | null) => {
      const proc = Bun.spawn(['python3', 'eval/systems/_fake/fake.py'], { cwd: ROOT, env: { ...process.env, SHIM_PORT: String(port), ...(stateFile ? { SHIM_STATE_FILE: stateFile } : {}) }, stdout: 'ignore', stderr: 'ignore' });
      procs.push(proc);
      for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`, { keepalive: false })).ok) return proc; } catch { await Bun.sleep(50); } }
      throw new Error('python fake shim did not start');
    };
    const freePort = () => { const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return p; };

    for (const persistent of [true, false]) {
      test(`a real process restart ${persistent ? 'with SHIM_STATE_FILE keeps state' : 'without a state file is caught as lost state'}`, async () => {
        const port = freePort();
        const state = persistent ? join(fresh('state'), 'fake-state.json') : null;
        let proc = await start(port, state);
        const restart = async () => { proc.kill(); await proc.exited; proc = await start(port, state); };
        const { checks, metrics } = await gate(new HttpMemorySystem(`http://127.0.0.1:${port}`), restart, `py-${persistent}`);
        if (persistent) expect([checks.forget, checks.survivors, checks.restart, metrics.restart.lost]).toEqual(['pass', 'pass', 'pass', 0]);
        else expect([checks.restart, checks.survivors]).toEqual(['fail', 'fail']);
      }, 60_000);
    }

    test('the CLI over the shim URL writes a complete receipt and refuses unsafe flags', async () => {
      const port = freePort();
      await start(port, null);
      const out = fresh('cli');
      const cli = (args: string[]) => Bun.spawn([process.execPath, 'eval/runner/lifecycle-lite.ts', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      const p = cli(['--system', `http://127.0.0.1:${port}`, '--seeds', '1,2', '--qa', 'scripted', '--output', out]);
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(code, err).toBe(0);
      const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
      expect([receipt.kind, receipt.run_status, receipt.system.capabilities.system, receipt.report_only]).toEqual(['lifecycle-lite', 'complete', 'fake', true]);
      expect([receipt.metrics.reader.ran, receipt.qa.reader, receipt.metrics.reader.update.probes]).toEqual([true, 'scripted-lexical-reader', 24]);
      expect(readFileSync(join(out, 'rows.ndjson'), 'utf8').trim().split('\n')).toHaveLength(2 * expectedIds(generateLifecycleLiteWorld({ seed: 1 }), false).length);
      expect(err).toContain('lifecycle-lite complete (report-only)');
      const refuse = async (args: string[], why: RegExp) => { const r = cli([...args, '--output', fresh('refuse')]); const [e, c] = await Promise.all([new Response(r.stderr).text(), r.exited]); expect([c, why.test(e)], e).toEqual([2, true]); };
      await refuse(['--system', `http://127.0.0.1:${port}`, '--restart'], /needs --restart-cmd/);
      await refuse(['--system', 'fake', '--restart'], /keeps no state/);
      await refuse(['--system', 'gbrain-shootout'], /--paid/);
    }, 60_000);
  });

  test('in-process gbrain-shootout (hash vectors, rerank stub): runs every checkpoint and keeps its brain across a restart', async () => {
    const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
      const path = new URL(req.url).pathname;
      const body = await req.json().catch(() => ({})) as { model?: string; documents?: string[] };
      if (path.startsWith('/__proxy/')) return Response.json(path.endsWith('finalize') ? { usd: 0, requests: 0, unpriced: 0, byModel: {} } : { ok: true });
      if (path.endsWith('/rerank')) return Response.json({ object: 'list', model: body.model, data: (body.documents ?? []).map((_, i) => ({ index: i, relevance_score: 1 - i / 100 })), usage: { total_tokens: 1 } });
      return Response.json({ error: 'no route' }, { status: 404 });
    } });
    const out = fresh('gbrain');
    try {
      const p = Bun.spawn([process.execPath, 'eval/runner/lifecycle-lite.ts', '--system', 'gbrain-shootout', '--seeds', '1', '--restart', '--provider-proxy', `http://127.0.0.1:${proxy.port}`, '--output', out], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(code, err.slice(-2000)).toBe(0);
      const r = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
      expect([r.run_status, r.restart.enabled, r.system.capabilities.system, r.outcomes.scored]).toEqual(['complete', true, 'gbrain-shootout', expectedIds(generateLifecycleLiteWorld({ seed: 1 }), true).length]);
      expect([r.checks.restart, r.metrics.restart.lost, r.checks.forget]).toEqual(['pass', 0, 'pass']);
      expect(r.metrics.survivors.witnessed).toBeGreaterThan(0);
      expect(existsSync(join(out, 'forget-cases.ndjson'))).toBe(true);
    } finally { proxy.stop(true); }
  }, 300_000);
});

describe('lifecycle-lite campaign (Phase 6 manifests)', () => {
  test('loads, has one cell per system with the reader and the restart on, and a cap equal to its leases', async () => {
    const { loadCampaign } = await import('../../eval/runner/shootout-cell.ts');
    const { manifest } = loadCampaign(join(ROOT, 'docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite/manifests/campaign.json'));
    expect(manifest.campaign_id).toBe('oss-memory-shootout-p2-lifecycle-lite');
    expect(manifest.ledger.startsWith('.budget/')).toBe(true);
    expect(manifest.cells.map(c => c.system).sort()).toEqual(['extract-first', 'gbrain-shootout', 'gbrain-shootout-master', 'graph-pipeline', 'markdown-notes', 'memory-bank', 'temporal-graph']);
    expect(Math.round(manifest.cells.reduce((n, c) => n + c.lease_usd, 0) * 100) / 100).toBe(manifest.cap_usd);
    for (const c of manifest.cells) {
      expect([c.id, c.command.includes('eval/runner/lifecycle-lite.ts'), c.command.includes('--qa reader'), c.command.includes('--restart'), c.command.includes('--seeds 1,2,3,4,5'), c.config]).toEqual([c.id, true, true, true, true, 'common']);
      if (!c.system.startsWith('gbrain')) expect([c.id, c.command.includes(`bootstrap.sh restart --system ${c.system}`), c.command.includes(`bootstrap.sh down --system ${c.system}`)]).toEqual([c.id, true, true]);
    }
    expect(manifest.cells.find(c => c.system === 'extract-first')!.command).toContain('--finish-timeout-s 14400');
    expect(manifest.cells.find(c => c.system === 'gbrain-shootout-master')!.command).toContain('@c5fb0201d1960a0a5a81c35d77718311b03154b7');
  });
});

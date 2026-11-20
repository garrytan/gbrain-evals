/**
 * BG1's canonical judge (gemini:gemini-3.8-flash) through the real lease proxy, keyless. A BG1 unit's proxy takes
 * Gemini's key only from the variable the unit names (BG1_GEMINI_API_KEY), never from GEMINI_API_KEY, and the cell's
 * environment holds neither; and a keyless run's canonical judgment goes through the proxy's Gemini route to
 * eval/systems/_shim/fake_provider.py and scores. Every key here is a made-up placeholder and every upstream a local fake.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { BG1_CANONICAL_JUDGE, instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { ChatClient, judgeAnswer } from '../../eval/runner/memory-qa/qa-v2.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { metering } from '../../eval/runner/q1/cell.ts';
import { DEFAULT_ROUTE_CLASSES, runRemote } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'bg1-gemini-'));
const ndjson = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const Q = { id: 'bg1-q', conversation: 'bg1-w', question: 'Where does Ana live now?', category: 'current_value', gold: [], abstention: false, answer: 'Lisbon',
  bg1: { stratum: 'superseded', ordered: false, gold_values: ['Lisbon'], stale_values: ['Porto'] } } as unknown as MemoryQuestion;

let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); closeLedgers(); });

let fake: ReturnType<typeof Bun.spawn>;
let fakeBase = '';
const fakeLog = join(tmp, 'fake-provider.jsonl');
beforeAll(async () => {
  const port = await freePort(0);
  fake = Bun.spawn(['python3', 'eval/systems/_shim/fake_provider.py', '--port', String(port), '--log', fakeLog], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
  fakeBase = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { try { await fetch(`${fakeBase}/particle/v1/models`, { keepalive: false }); break; } catch { await Bun.sleep(50); } }
}, 60_000);
afterAll(() => { fake?.kill(); rmSync(tmp, { recursive: true, force: true }); });

describe('BG1 Gemini key and keyless judge', () => {
  // Value: protects=BG1's Gemini key reaches only the lease proxy, from BG1_GEMINI_API_KEY alone; fails_when=the proxy falls back to GEMINI_API_KEY, or the cell or a system under test can read either variable; why_new=GBEV-3 key rule for BG1's canonical judge; seam=runRemote's proxy and cell environments; no_claim=ubi-runner's --pass export on the VM
  test('a BG1 unit\'s proxy sends Gemini BG1_GEMINI_API_KEY and nothing else, refuses when only GEMINI_API_KEY is set, and the cell sees neither variable', async () => {
    const seen: string[] = [];
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => {
      seen.push(`${new URL(req.url).pathname} ${req.headers.get('authorization')}`);
      return Response.json({ model: 'gemini-3.8-flash', choices: [{ index: 0, message: { role: 'assistant', content: '{"correct": 1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } });
    const body = JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'grade' }], max_completion_tokens: 2048, reasoning_effort: 'low' });
    const command = `curl -s -o "$SHOOTOUT_OUT/reply.json" -w '%{http_code}' -H "Authorization: Bearer $SHOOTOUT_CELL_TOKEN" -H 'content-type: application/json' -d '${body}' "$SHOOTOUT_PROXY/cell/gemini/v1beta/openai/chat/completions" > "$SHOOTOUT_OUT/http.txt"; if [ -z "\${BG1_GEMINI_API_KEY+x}" ] && [ -z "\${GEMINI_API_KEY+x}" ]; then echo clean; else echo LEAKED; fi > "$SHOOTOUT_OUT/env.txt"`;
    const run = async (name: string, env: Record<string, string>) => {
      const out = join(tmp, name);
      Object.assign(process.env, env);
      try {
        expect(await runRemote({ lease_id: `lease-${name}`, lease_usd: 0.5, out, command, gemini_key_env: 'BG1_GEMINI_API_KEY' }, { port: await freePort(0), upstream: { gemini: `http://127.0.0.1:${upstream.port}` } })).toBe(0);
      } finally { for (const k of Object.keys(env)) delete process.env[k]; }
      return { http: readFileSync(join(out, 'http.txt'), 'utf8').trim(), env: readFileSync(join(out, 'env.txt'), 'utf8').trim() };
    };
    try {
      expect(await run('mapped', { BG1_GEMINI_API_KEY: 'placeholder-bg1-key', GEMINI_API_KEY: 'placeholder-decoy-key' })).toEqual({ http: '200', env: 'clean' });
      expect(seen).toEqual(['/v1beta/openai/chat/completions Bearer placeholder-bg1-key']);
      expect(await run('unmapped', { GEMINI_API_KEY: 'placeholder-decoy-key' })).toEqual({ http: '503', env: 'clean' });
      expect(seen).toHaveLength(1);
    } finally { upstream.stop(true); }
  }, 60_000);

  // Value: protects=a keyless BG1 rehearsal judges through the proxy's Gemini route and never reaches Google; fails_when=gemini-3.8-flash has no provider row, a keyless map leaves Gemini on its real upstream or without a placeholder key, or the request leaves the 2,048-token judge route; why_new=red-team #1 on #398 (no row for the canonical judge); seam=keylessUpstream, keylessKeys and the fake provider's BG1 verdict; no_claim=how the real model grades
  test('keyless: one canonical judgment goes through the lease proxy to the fake provider, at low effort and the 2,048-token floor, and scores', async () => {
    const usageLog = join(tmp, 'usage.ndjson');
    const lease = BudgetRun.openLease({ runId: 'bg1-keyless-judge', leaseUsd: 1, ledgerPath: join(tmp, 'ledger.sqlite') });
    const proxy = new MeteringProxy({ upstream: keylessUpstream(fakeBase), policy: { lease, usageLog, env: keylessKeys(), routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const meter = metering(`http://127.0.0.1:${proxy.port}`, { meter: () => {} }, process.env);
      const r = await meter.slotEnv('judge', () => judgeAnswer(new ChatClient(join(tmp, 'cache')), instrumentFor('bg1'), Q, 'She lives in Lisbon.', { judgeReplicate: 0, view: 'descriptive' }));
      expect(r).toMatchObject({ judge: BG1_CANONICAL_JUDGE, score: 1, outcome: 'scored', parse_ok: true });
    } finally { proxy.stop(); }
    const chats = ndjson(fakeLog).filter(l => l.route === 'chat' && String(l.path) === '/v1beta/openai/chat/completions');
    expect(chats.map(l => [l.model, l.effort, l.max_completion_tokens])).toEqual([['gemini-3.8-flash', 'low', 2048]]);
    expect(ndjson(usageLog).map(l => [l.provider, l.model, l.outcome, l.route_class, l.output_cap])).toEqual([['gemini', 'gemini-3.8-flash', 'forwarded', 'judge', 2048]]);
  }, 60_000);
});

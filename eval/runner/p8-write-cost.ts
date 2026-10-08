/**
 * Write cost: what an agent's memory writes cost on one gbrain build, with
 * background fact extraction on (the default, headline) and off (the floor).
 *
 * Each arm is a fresh PGLite brain behind `gbrain serve` (stdio MCP, the
 * agent's path). The agent writes LongMemEval-S sessions as `note` pages
 * (fact-extraction eligible; asserted) with `put_page`, then `remember`s one
 * fact per page. Every provider request goes through a metering proxy (dollars
 * by model) and gbrain's own `GBRAIN_AI_CALL_LOG` ledger (calls by kind and by
 * what caused them). The run waits for in-session work to settle (no new
 * provider calls for --settle-s seconds), closes the session, then drains the
 * background job queue with `gbrain jobs work` (PGLite's lock cannot host a
 * worker beside serve) and reports what is still outstanding.
 *
 * Columns per arm: pages, messages, put_page / remember latency p50 and p95,
 * generative attempts on the commit path (must be 0), generative and embedding
 * calls and tokens, dollars by model, all also per 1,000 messages and per
 * 1,000 pages, and seconds to settle.
 *
 * Arms: `off` (extraction disabled), `on` (the shipped default model) and
 * `on:<provider:model>` (extraction on with `facts.extraction_model` set; the
 * write-cost decision data of the 10x plan's R2).
 *
 * Usage:
 *   bun eval/runner/p8-write-cost.ts --gbrain <checkout>@<ref> [--sessions 200] [--arms on,off,on:openai:gpt-6-luna]
 *     [--settle-s 90] [--root <dir outside any repo>] --budget-usd <n> [--budget-ledger <path>] --out eval/reports/p8-write-cost/<name>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadLmeS, renderSessionPage, occurrenceId, type Session } from './memory-qa/corpus.ts';
import { GbrainSlot, McpClient, MeteringProxy, GBRAIN_EMBED_MODEL, type Meter } from './cat40/gbrain-arm.ts';
import { runCli } from './lifecycle/drivers.ts';
import { prepareBuild } from './lifecycle/builds.ts';
import { budgetOptionsFrom, startPaidRun } from './budget-ledger.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const log = (s: string) => process.stderr.write(`[write-cost] ${s}\n`);

interface CallLine { kind: string; model: string; outcome: string; input_tokens: number | 'unknown'; output_tokens: number | 'unknown'; request_id?: string; effect?: string; job_name?: string; phase?: string; operation?: string }

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
const tokens = (v: number | 'unknown') => typeof v === 'number' ? v : 0;

function pickSessions(n: number): Array<{ slug: string; session: Session }> {
  const corpus = loadLmeS();
  const seen = new Set<string>();
  const out: Array<{ slug: string; session: Session }> = [];
  for (const c of corpus.conversations) for (const s of c.sessions) {
    const text = renderSessionPage(s);
    if (seen.has(text) || s.turns.length < 2) continue;
    seen.add(text);
    out.push({ slug: `conversations/${occurrenceId(c.id, s.id)}`, session: s });
    if (out.length >= n) return out;
  }
  return out;
}

/** One fact per session: the first user sentence of reasonable length, attributed to the session page. */
function factFor(s: Session): string | null {
  for (const t of s.turns) {
    if (t.speaker !== 'user') continue;
    const sentence = t.content.split(/(?<=[.!?])\s+/).find(x => x.length >= 30 && x.length <= 240);
    if (sentence) return `The user said: ${sentence.trim()}`;
  }
  return null;
}

async function settle(path: string, quietMs: number, capMs: number): Promise<number> {
  const t0 = Date.now();
  let last = -1, lastChange = Date.now();
  while (Date.now() - t0 < capMs) {
    const n = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0;
    if (n !== last) { last = n; lastChange = Date.now(); }
    if (Date.now() - lastChange >= quietMs) return (lastChange - t0) / 1000;
    await Bun.sleep(5_000);
  }
  return capMs / 1000;
}

/** `on:<provider:model>` sets facts.extraction_model; `on` keeps the default; `off` disables extraction. */
export function parseWriteCostArm(arm: string): { arm: string; enabled: boolean; model: string | null; slot: string } {
  if (arm !== 'on' && arm !== 'off' && !/^on:[a-z0-9-]+:.+/.test(arm)) throw new Error(`write-cost arm "${arm}" must be on, off or on:<provider:model>`);
  return { arm, enabled: arm !== 'off', model: arm.startsWith('on:') ? arm.slice(3) : null, slot: `wc-${arm.replace(/[^a-z0-9]+/gi, '-')}` };
}

async function runArm(arm: string, buildDir: string, root: string, sessions: Array<{ slug: string; session: Session }>, proxy: MeteringProxy, settleS: number) {
  const spec = parseWriteCostArm(arm);
  const slot = new GbrainSlot(spec.slot, root, buildDir, proxy.port, 'full');
  const callLog = join(slot.dir, 'ai-calls.jsonl');
  slot.run.env.GBRAIN_AI_CALL_LOG = callLog;
  for (const d of ['home', 'uh']) mkdirSync(join(slot.dir, d), { recursive: true });
  const cli = async (args: string[]) => {
    const r = await runCli(slot.run, args, 600_000);
    if (r.code !== 0) throw new Error(`gbrain ${args.join(' ')} failed (${r.code}): ${(r.stdout + r.stderr).slice(-800)}`);
    return r;
  };
  await cli(['init', '--pglite', '--path', join(slot.dir, 'home', 'brain.pglite'), '--embedding-model', GBRAIN_EMBED_MODEL, '--non-interactive']);
  await cli(['config', 'set', 'facts.extraction_enabled', spec.enabled ? 'true' : 'false']);
  if (spec.model) await cli(['config', 'set', 'facts.extraction_model', spec.model]);
  writeFileSync(callLog, '');
  const meterKey = `arm:${arm}`;
  proxy.bind(slot.id, meterKey);
  const client = new McpClient(slot.run, ['--surface', 'full']);
  await client.start();
  const putMs: number[] = [], rememberMs: number[] = [];
  let messages = 0, facts = 0, errors = 0;
  const t0 = Date.now();
  for (const [i, { slug, session }] of sessions.entries()) {
    const content = renderSessionPage(session);
    if (!content.includes('type: note')) throw new Error('pages must be an extraction-eligible type (note)');
    messages += session.turns.length;
    let s = Date.now();
    const put = await client.call('put_page', { slug, content });
    putMs.push(Date.now() - s);
    if (put.startsWith('Error')) { errors++; log(`put_page ${slug}: ${put.slice(0, 200)}`); }
    const fact = factFor(session);
    if (fact) {
      s = Date.now();
      const r = await client.call('remember', { fact, provenance: `conversation page ${slug}` });
      rememberMs.push(Date.now() - s);
      if (r.startsWith('Error')) { errors++; log(`remember: ${r.slice(0, 200)}`); } else facts++;
    }
    if ((i + 1) % 25 === 0) log(`${arm}: ${i + 1}/${sessions.length} pages written`);
  }
  const writeS = (Date.now() - t0) / 1000;
  const settledAfterS = await settle(callLog, settleS * 1000, 45 * 60_000);
  await client.close();
  // PGLite cannot host a worker daemon beside serve: background jobs (facts-absorb) drain in the foreground afterwards.
  const jobs = async () => {
    const r = await cli(['jobs', 'stats', '--json']);
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { by_type?: Array<{ name: string; total: number; waiting_now: number; failed: number; dead: number }> };
    return Object.fromEntries((j.by_type ?? []).map(t => [t.name, { total: t.total, waiting: t.waiting_now, failed: t.failed, dead: t.dead }]));
  };
  const queued = await jobs();
  const d0 = Date.now();
  await runCli(slot.run, ['jobs', 'work', '--concurrency', String(Number(flag('--worker-concurrency') ?? 4))], 3 * 3_600_000);
  const drainS = (Date.now() - d0) / 1000;
  const outstanding = await jobs();
  proxy.unbind(slot.id);
  const meter: Meter = await proxy.finalize(meterKey);
  const lines = readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CallLine);
  const generative = lines.filter(l => l.kind !== 'embedding' && l.kind !== 'rerank');
  // A generative call that names a write request but no effect, job or phase ran inside the write's own commit path.
  const commitPath = generative.filter(l => l.request_id && !l.effect && !l.job_name && !l.phase);
  const by = (xs: CallLine[]) => {
    const out: Record<string, { calls: number; input_tokens: number; output_tokens: number }> = {};
    for (const l of xs) {
      const k = `${l.kind}:${l.model}${l.effect ? ` effect=${l.effect}` : l.job_name ? ` job=${l.job_name}` : l.phase ? ` phase=${l.phase}` : ''}`;
      out[k] ??= { calls: 0, input_tokens: 0, output_tokens: 0 };
      out[k].calls++; out[k].input_tokens += tokens(l.input_tokens); out[k].output_tokens += tokens(l.output_tokens);
    }
    return out;
  };
  const per = (x: number, n: number) => n ? Number((x * 1000 / n).toFixed(4)) : null;
  const embedTokens = lines.filter(l => l.kind === 'embedding').reduce((a, l) => a + tokens(l.input_tokens), 0);
  return {
    arm, extraction_model_setting: spec.model, resolved_extraction_models: [...new Set(generative.filter(l => l.effect === 'facts-absorb' || l.job_name === 'facts-absorb').map(l => l.model))],
    pages: sessions.length, messages, facts_remembered: facts, write_errors: errors,
    put_page_ms: { p50: pct(putMs, 0.5), p95: pct(putMs, 0.95) }, remember_ms: { p50: pct(rememberMs, 0.5), p95: pct(rememberMs, 0.95) },
    write_wall_s: writeS, settled_after_write_s: settledAfterS, jobs_queued_at_settle: queued, job_drain_s: drainS, jobs_after_drain: outstanding,
    commit_path_generative_attempts: commitPath.length,
    generative_calls: generative.length, embedding_calls: lines.filter(l => l.kind === 'embedding').length, embedding_tokens: embedTokens,
    calls_by_cause: by(lines),
    usd: Number(meter.usd.toFixed(4)), usd_by_model: meter.byModel, unpriced_requests: meter.unpriced, undrained_requests: meter.undrained ?? 0,
    per_1000_messages: { usd: per(meter.usd, messages), generative_calls: per(generative.length, messages), embedding_tokens: per(embedTokens, messages) },
    per_1000_pages: { usd: per(meter.usd, sessions.length), generative_calls: per(generative.length, sessions.length), embedding_tokens: per(embedTokens, sessions.length) },
  };
}

async function main() {
  const spec = flag('--gbrain');
  const out = flag('--out');
  if (!spec || !out) throw new Error('usage: --gbrain <checkout>@<ref> --out <dir> --budget-usd <n>');
  const [repo, ref] = spec.split('@') as [string, string];
  const arms = (flag('--arms') ?? 'on,off').split(',').map(a => parseWriteCostArm(a).arm);
  const sessions = pickSessions(Number(flag('--sessions') ?? 200));
  const settleS = Number(flag('--settle-s') ?? 90);
  // Brains live outside any Git worktree (gbrain refuses a content root inside another repository).
  const root = resolve(flag('--root') ?? join(process.env.HOME ?? '.', '.capy/work/p8-write-cost', basename(resolve(out))));
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve(out), { recursive: true });
  const build = prepareBuild(resolve(repo), { label: 'under-test', ref: ref ?? 'HEAD', description: 'gbrain under test' }, join(root, 'builds'));
  const { run: budget } = startPaidRun('p8-write-cost', { ...budgetOptionsFrom(argv), estimateUsd: null, log });
  const proxy = new MeteringProxy();
  proxy.start();
  const results = [];
  try {
    for (const arm of arms) {
      const allowance = budget.allowance(Number(flag('--arm-allowance-usd') ?? 10), `write-cost arm ${arm}`);
      proxy.allowances.set(parseWriteCostArm(arm).slot, allowance);
      try { results.push(await runArm(arm, build.dir, root, sessions, proxy, settleS)); }
      finally { proxy.allowances.delete(parseWriteCostArm(arm).slot); allowance.close(); }
      log(`${arm}: ${JSON.stringify(results.at(-1))}`);
    }
  } finally { proxy.stop(); }
  const summary = budget.close({ finish: results.length === arms.length });
  const receipt = { schema: 'p8-write-cost-v1', gbrain: { repo, commit: build.commit, version: build.version }, embedding_model: GBRAIN_EMBED_MODEL, dataset: 'LongMemEval-S cleaned (98d7416c), first distinct sessions', arms: results, budget: summary };
  writeFileSync(join(resolve(out), 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}

if (import.meta.main) await main();

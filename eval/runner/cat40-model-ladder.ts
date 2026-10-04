/**
 * Cat 40: Model Ladder. Does gbrain's advantage over simpler memory persist
 * as models improve?
 *
 * Runs every (model, arm, task) cell of the fictional company world in
 * eval/data/model-ladder-v1 through one agent loop (cat40/loop.ts). Arms differ
 * only in their tools. Writes one JSON line per cell to results.jsonl (a rerun
 * with the same --out resumes), then a summary and receipt.
 *
 * Protocol: docs/benchmarks/2026-10-02-model-ladder-protocol.md.
 *
 * Usage:
 *   bun eval/runner/cat40-model-ladder.ts --models claude-sonnet-4-6,gpt-5.4 \
 *     --arms oracle,fs,pg,memory,gbrain --budget-usd 100 [--families A,B] [--tasks A01,B02] \
 *     [--repeat 1] [--concurrency 6] [--slots 3] [--gbrain-repo ../gbrain --gbrain-ref <sha>] \
 *     [--gbrain-instructions-file <file>] [--gbrain-tool-descriptions-file <json>] [--gbrain-drop-tools a,b]
 *       (evaluator-side A/B of the instruction and tool-description text the model sees; gbrain code unchanged)
 *     [--judge gpt-5.4-mini|none] [--world eval/data/model-ladder-v1-large/world.json] [--out eval/reports/cat40/<name>]
 *   bun eval/runner/cat40-model-ladder.ts --scripted --arms fs,memory,oracle   (hermetic, $0)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { generateLadderWorld, worldDigest, DEFAULT_LADDER_DIR, FAMILIES, type LadderTask, type LadderWorld, type Family } from '../generators/model-ladder-gen.ts';
import { runAgent, provider, priceUsage, type AgentRun, type Arm, type ScriptedModel } from './cat40/loop.ts';
import { FsArm, MemoryArm, OracleArm, FileStore, isWriteCall, type ArmName } from './cat40/arms.ts';
import { renderDoc } from '../generators/model-ladder-gen.ts';
import { PgArm, PgStore, cachedOpenAIEmbedder } from './cat40/pg-arm.ts';
import { GbrainArm, instructionsOverride, GbrainPool, GbrainSlot, MeteringProxy, SERVE_BOOT_TIMEOUT_SECONDS, STAGED_SOURCE_ADD_DOCS, STAGED_SYNC_BATCH, type Meter, type SlotBuild } from './cat40/gbrain-arm.ts';
import { scoreTask, judgePrompt, parseClaims, JUDGE_PROMPT_VERSION, type TaskScore, type ClaimVerdicts } from './cat40/score.ts';
import { budgetOptionsFrom, startPaidRun, receiptCost } from './budget-ledger.ts';
import { prepareBuild } from './lifecycle/builds.ts';

export const CAT40_VERSION = 'cat40-v1';

export function systemPrompt(world: LadderWorld, arm: Arm): string {
  const p = world.principal;
  return [
    `You are an AI assistant working for ${p.name}, an ${p.role} at Acme Example Inc. Today is ${world.today}.`,
    'Answer using the company knowledge base available through your tools. Do not guess.',
    `Some information is restricted. Share only what ${p.name.split(' ')[0]} is allowed to see.`,
    arm.systemHint(),
    'When you are done, call submit_answer with the value only in `answer` (or one value per requested item in `fields`), the ids or paths of the documents you relied on in `sources`, and any caveats in `notes`. Write dates as YYYY-MM-DD.',
    `If the information is not available to ${p.name.split(' ')[0]}, answer NOT_ACCESSIBLE. If the knowledge base does not contain it, answer UNKNOWN.`,
  ].join('\n\n');
}

export function userMessage(world: LadderWorld, task: LadderTask, arm: Arm, session: 1 | 2): string {
  if (session === 1) return task.session1!;
  const parts = [task.question];
  if (task.answer_kind === 'fields') parts.push(`Use these keys in fields: ${task.fields!.join(', ')}.`);
  if (arm.name === 'oracle') parts.push(`Relevant documents:\n\n${OracleArm.evidence(world, task)}`);
  return parts.join('\n\n');
}

export interface CellRecord {
  key: string;
  model: string;
  provider: string;
  arm: string;
  task: string;
  family: Family;
  variant: string;
  repeat: number;
  score: TaskScore;
  claims: ClaimVerdicts | null;
  /** Set when the claims judge failed; the paid agent run is still recorded, with `claims: null`. */
  judge_error?: string;
  run: Omit<AgentRun, 'tools'> & { tool_calls: Array<{ name: string; ms: number; chars: number; truncated: boolean; error?: string }> };
  session1?: Omit<AgentRun, 'tools'> & { tool_calls: Array<{ name: string; ms: number; chars: number }> };
  gbrain_internal?: Meter;
  total_usd: number;
  wall_ms: number;
  started_at: string;
}

/** Tool calls with (shortened) results per cell, for --transcripts diagnostics. */
export const lastTools = new Map<string, Array<{ session: number; name: string; args: Record<string, unknown>; result: string }>>();

function strip(r: AgentRun) {
  const { tools, ...rest } = r;
  return { ...rest, tool_calls: tools.map(t => ({ name: t.name, ms: t.ms, chars: t.chars, truncated: t.truncated, ...(t.error ? { error: t.error } : {}) })) };
}

/** Hermetic scripted agent: greps for the account, reads its files, submits whatever the first gold-shaped value is. Proves the plumbing, not quality. */
export function scriptedAgent(task: LadderTask, armName: string): ScriptedModel {
  return history => {
    const sub = { name: 'submit_answer', args: { answer: 'UNKNOWN', sources: [] as string[] } };
    if (armName === 'oracle') return sub;
    if (history.length === 0) {
      if (armName === 'memory') return { name: 'memory', args: { command: 'view', path: `/memories/accounts/${task.account}` } };
      return { name: 'list_dir', args: { path: `accounts/${task.account}` } };
    }
    return sub;
  };
}

interface Ctx {
  world: LadderWorld;
  /** Rendered corpus files, built once and shared read-only by every file-backed run (each run writes to its own overlay). */
  files: { all: Map<string, string>; acl: Map<string, string> };
  out: string;
  pg?: PgStore;
  pool?: GbrainPool;
  proxy?: MeteringProxy;
  scripted: boolean;
  judge: string | null;
  /** Arm name recorded for gbrain cells, so two gbrain builds can be compared (`--gbrain-label`). */
  gbrainLabel: string;
  /** Per-tool-result character cap for every arm (`--max-tool-chars`, default 20,000). */
  maxToolChars: number;
}

async function judgeClaims(ctx: Ctx, task: LadderTask, run: AgentRun): Promise<{ claims: ClaimVerdicts | null; usd: number }> {
  if (!ctx.judge || ctx.scripted) return { claims: null, usd: 0 };
  const p = judgePrompt(ctx.world, task, run);
  if (!p) return { claims: null, usd: 0 };
  const r = await runAgentText(ctx.judge, p.system, p.user);
  return { claims: parseClaims(r.text), usd: r.usd };
}

async function runAgentText(model: string, system: string, user: string): Promise<{ text: string; usd: number }> {
  if (provider(model) === 'openai') {
    const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, instructions: system, input: user, max_output_tokens: 8000, reasoning: { effort: 'low' } }) });
    const j = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(`judge error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const text = ((j.output ?? []) as Array<Record<string, unknown>>).filter(o => o.type === 'message').flatMap(o => (o.content as Array<Record<string, unknown>>) ?? []).map(c => String(c.text ?? '')).join('\n');
    const u = j.usage as Record<string, unknown>;
    const cached = ((u.input_tokens_details ?? {}) as Record<string, number>).cached_tokens ?? 0;
    return { text, usd: priceUsage(model, { input: (u.input_tokens as number) - cached, cache_read: cached, cache_write: 0, output: u.output_tokens as number, requests: 1 }) };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }) });
  const j = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`judge error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const text = ((j.content ?? []) as Array<Record<string, unknown>>).filter(c => c.type === 'text').map(c => String(c.text)).join('\n');
  const u = j.usage as Record<string, number>;
  return { text, usd: priceUsage(model, { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, requests: 1 }) };
}

async function runCell(ctx: Ctx, model: string, armName: ArmName, task: LadderTask, repeat: number): Promise<CellRecord> {
  const started = new Date();
  const label = armName === 'gbrain' ? ctx.gbrainLabel : armName;
  const runId = `${model}|${label}|${task.id}|${repeat}`;
  let arm: Arm;
  let slot: GbrainSlot | null = null;
  if (armName === 'fs') arm = new FsArm('fs', new FileStore(ctx.files.all));
  else if (armName === 'fs-acl') arm = new FsArm('fs-acl', new FileStore(ctx.files.acl));
  else if (armName === 'memory') arm = new MemoryArm(new FileStore(ctx.files.all));
  else if (armName === 'oracle') arm = new OracleArm();
  else if (armName === 'pg') arm = new PgArm(ctx.pg!, runId);
  else {
    slot = await ctx.pool!.acquire();
    ctx.proxy!.take(slot.id);
    arm = new GbrainArm(slot);
  }
  try {
    const isWrite = (name: string, args: Record<string, unknown>) => isWriteCall(arm, name, args);
    const common = { model, arm, system: systemPrompt(ctx.world, arm), maxToolChars: ctx.maxToolChars };
    let session1: AgentRun | undefined;
    if (task.family === 'F' && armName !== 'oracle') {
      session1 = await runAgent({ ...common, user: userMessage(ctx.world, task, arm, 1), scripted: ctx.scripted ? scriptedAgent(task, armName) : undefined });
      if (slot) await slot.newSession();
    }
    const run = await runAgent({ ...common, system: systemPrompt(ctx.world, arm), user: userMessage(ctx.world, task, arm, 2), scripted: ctx.scripted ? scriptedAgent(task, armName) : undefined });
    const score = scoreTask(task, run, { session1, isWrite });
    lastTools.set(runId, [...(session1?.tools ?? []).map(t => ({ session: 1, name: t.name, args: t.args, result: t.result.slice(0, 40_000) })), ...run.tools.map(t => ({ session: 2, name: t.name, args: t.args, result: t.result.slice(0, 40_000) }))]);
    const gbrain_internal = slot ? ctx.proxy!.take(slot.id) : undefined;
    let judged: { claims: ClaimVerdicts | null; usd: number; error?: string };
    try { judged = await judgeClaims(ctx, task, run); }
    catch (e) {
      if ((e as Error).name === 'BudgetExceededError') throw e;
      judged = { claims: null, usd: 0, error: (e as Error).message };
    }
    const total = run.usd + (session1?.usd ?? 0) + (gbrain_internal?.usd ?? 0);
    return {
      key: runId, model, provider: ctx.scripted ? 'scripted' : provider(model), arm: label, task: task.id, family: task.family, variant: task.variant, repeat,
      score, claims: judged.claims, ...(judged.error ? { judge_error: judged.error } : {}), run: strip(run), ...(session1 ? { session1: strip(session1) } : {}), ...(gbrain_internal ? { gbrain_internal } : {}),
      total_usd: total, judge_usd: judged.usd, wall_ms: Date.now() - started.getTime(), started_at: started.toISOString(),
    } as CellRecord;
  } finally {
    if (slot) {
      // Restore after every run: a session can change the brain without a write tool (startup sweeps write too).
      await slot.restore();
      ctx.pool!.release(slot);
    }
  }
}

/** After the first failure no new item starts, but items already running finish before it is rethrown (so gbrain slots stay up for them). */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  let failure = null as { error: unknown } | null;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !failure) {
      const x = items[i++];
      try { await fn(x); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  const scripted = argv.includes('--scripted');
  const worldPath = resolve(flag(argv, '--world') ?? join(DEFAULT_LADDER_DIR, 'world.json'));
  const world: LadderWorld = JSON.parse(readFileSync(worldPath, 'utf8'));
  const regenerated = generateLadderWorld(world.seed, { scale: world.scale });
  if (worldDigest(regenerated) !== worldDigest(world)) throw new Error(`${worldPath} does not match its generator; run bun eval/generators/model-ladder-gen.ts${world.scale ? ` --scale ${world.scale}` : ''}`);
  const models = scripted ? ['scripted'] : (flag(argv, '--models') ?? '').split(',').filter(Boolean);
  if (!models.length) throw new Error('--models is required (or --scripted)');
  const arms = (flag(argv, '--arms') ?? 'oracle,fs,pg,memory,gbrain').split(',') as ArmName[];
  const families = (flag(argv, '--families') ?? FAMILIES.join(',')).split(',') as Family[];
  const only = flag(argv, '--tasks')?.split(',');
  const repeats = Number(flag(argv, '--repeat') ?? 1);
  const tasks = world.tasks.filter(t => families.includes(t.family) && (!only || only.includes(t.id)));
  const out = resolve(flag(argv, '--out') ?? join('eval/reports/cat40', scripted ? 'scripted' : new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });
  const judge = scripted || flag(argv, '--judge') === 'none' ? null : (flag(argv, '--judge') ?? 'gpt-5.4-mini');
  const files = (keep: (d: LadderWorld['docs'][number]) => boolean) => new Map(world.docs.filter(keep).map(d => [`${d.id}.md`, renderDoc(d)]));
  const instructionsFile = flag(argv, '--gbrain-instructions-file');
  if (instructionsFile) instructionsOverride.text = readFileSync(resolve(instructionsFile), 'utf8').replace(/\n+$/, '');
  const descriptionsFile = flag(argv, '--gbrain-tool-descriptions-file');
  if (descriptionsFile) instructionsOverride.descriptions = JSON.parse(readFileSync(resolve(descriptionsFile), 'utf8'));
  instructionsOverride.dropTools = (flag(argv, '--gbrain-drop-tools') ?? '').split(',').filter(Boolean);
  const ctx: Ctx = { world, files: { all: files(() => true), acl: files(d => !d.restricted) }, out, scripted, judge, gbrainLabel: flag(argv, '--gbrain-label') ?? 'gbrain', maxToolChars: Number(flag(argv, '--max-tool-chars') ?? 20_000) };
  const log = (s: string) => { process.stderr.write(`[cat40] ${s}\n`); appendFileSync(join(out, 'run.log'), `${new Date().toISOString()} ${s}\n`); };

  const paid = !scripted;
  const budget = paid ? startPaidRun('cat40-model-ladder', { ...budgetOptionsFrom(argv), estimateUsd: flag(argv, '--estimate-usd') ? Number(flag(argv, '--estimate-usd')) : null, log }) : null;

  const resultsPath = join(out, 'results.jsonl');
  const transcripts = argv.includes('--transcripts');
  const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).key as string) : []);
  const cells: Array<{ model: string; arm: ArmName; task: LadderTask; repeat: number }> = [];
  for (let r = 0; r < repeats; r++) for (const task of tasks) for (const model of models) for (const arm of arms) {
    if (arm === 'fs-acl' && task.family !== 'C') continue;
    if (!done.has(`${model}|${arm === 'gbrain' ? ctx.gbrainLabel : arm}|${task.id}|${r}`)) cells.push({ model, arm, task, repeat: r });
  }
  log(`${cells.length} cells to run (${done.size} already done) in ${out}`);

  const builds: SlotBuild[] = [];
  let gbrainBuild: ReturnType<typeof prepareBuild> | null = null;
  try {
    if (!scripted && arms.includes('pg')) {
      ctx.pg = await PgStore.build(world, cachedOpenAIEmbedder(resolve('eval/reports/cat40/embed-cache.json')));
      log('pg arm ready');
    }
    if (arms.includes('gbrain') && cells.some(c => c.arm === 'gbrain')) {
      if (scripted) throw new Error('the gbrain arm needs real embeddings; run it without --scripted');
      const repo = resolve(flag(argv, '--gbrain-repo') ?? '../gbrain');
      const ref = flag(argv, '--gbrain-ref') ?? 'HEAD';
      const root = resolve(flag(argv, '--gbrain-root') ?? join(process.env.HOME ?? '.', '.capy/work/cat40/gbrain'));
      mkdirSync(root, { recursive: true });
      gbrainBuild = prepareBuild(repo, { label: 'under-test', ref, description: 'gbrain under test' }, join(root, 'builds'));
      ctx.proxy = new MeteringProxy();
      ctx.proxy.start();
      const n = Number(flag(argv, '--slots') ?? 3);
      const surface = flag(argv, '--surface') ?? 'starter';
      // --slot-ref reuses brains built by another commit (read-path changes only; the commits must share a schema).
      const slotRef = flag(argv, '--slot-ref');
      const slotCommit = slotRef ? execFileSync('git', ['-C', repo, 'rev-parse', `${slotRef}^{commit}`], { encoding: 'utf8' }).trim() : gbrainBuild.commit;
      const slots = Array.from({ length: n }, (_, i) => new GbrainSlot(`slot${i}`, join(root, `slots-${slotCommit.slice(0, 12)}-${worldDigest(world).slice(0, 8)}${argv.includes('--no-pglite-analyze') ? '-noanalyze' : ''}`), gbrainBuild!.dir, ctx.proxy!.port, surface));
      await Promise.all(slots.map(async s => {
        if (!s.hasSnapshot() || argv.includes('--rebuild')) {
          // A build sends one provider request per page; an allowance keeps the ledger from being rewritten for each.
          const allowance = budget!.run.allowance(Number(flag(argv, '--slot-build-allowance-usd') ?? 5), `gbrain ${s.id} build`);
          ctx.proxy!.allowances.set(s.id, allowance);
          let b: SlotBuild, charged: ReturnType<typeof allowance.close>;
          try { b = await s.build(world, ctx.proxy!, !argv.includes('--no-pglite-analyze')); }
          finally { ctx.proxy!.allowances.delete(s.id); charged = allowance.close(); }
          builds.push({ ...b, allowance: { reserved_usd: allowance.usd, ...charged } });
          log(`built ${s.id} in ${(b.ms / 1000).toFixed(0)}s, $${b.meter.usd.toFixed(4)} (${b.meter.requests} provider requests; ledger allowance charged $${charged.usd.toFixed(4)})`);
        }
        await s.restore();
      }));
      // A write probe after restore: the arm is only fair if the agent's writes can land.
      for (const s of slots) {
        const probe = await s.client!.call('put_page', { slug: 'notes/cat40-write-probe', content: '---\ntitle: "write probe"\ntype: note\n---\nprobe\n' });
        if (/^Error/.test(probe) || !(await s.client!.call('get_page', { slug: 'notes/cat40-write-probe' })).includes('write probe')) throw new Error(`gbrain ${s.id} refuses writes after restore: ${probe.slice(0, 300)}`);
        await s.restore();
      }
      log('write probe passed on every slot');
      ctx.pool = new GbrainPool(slots);
      log(`gbrain ${gbrainBuild.version} (${gbrainBuild.commit.slice(0, 12)}) ready on ${n} slots, surface ${surface}`);
    }

    const concurrency = Number(flag(argv, '--concurrency') ?? 6);
    let finished = 0;
    await pool(cells, concurrency, async c => {
      let rec: CellRecord;
      try { rec = await runCell(ctx, c.model, c.arm, c.task, c.repeat); }
      catch (e) {
        log(`cell ${c.model}|${c.arm}|${c.task.id} failed: ${(e as Error).message}`);
        if ((e as Error).name === 'BudgetExceededError' || /BudgetExceeded|exceed/i.test((e as Error).message)) throw e;
        return;
      }
      appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
      if (transcripts) appendFileSync(join(out, 'transcripts.jsonl'), JSON.stringify({ key: rec.key, tools: lastTools.get(rec.key) ?? [] }) + '\n');
      finished++;
      if (finished % 10 === 0 || finished === cells.length) log(`${finished}/${cells.length} cells; last ${rec.key} success=${rec.score.success} $${rec.total_usd.toFixed(3)}`);
    });
  } finally {
    if (ctx.pool) await Promise.all(ctx.pool.slots.map(s => s.stop()));
    ctx.proxy?.stop();
    const summary = budget?.run.close();
    budget?.guard.uninstall();
    const receipt = {
      schema: 'cat40-receipt-v1', version: CAT40_VERSION, judge_prompt: JUDGE_PROMPT_VERSION, judge: ctx.judge,
      world: { path: relative(process.cwd(), worldPath), scale: world.scale ?? 'v1', digest: worldDigest(world), seed: world.seed, docs: world.docs.length, tasks: world.tasks.length },
      evals_commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
      evals_dirty: (() => { try { return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0; } catch { return null; } })(),
      gbrain: gbrainBuild ? { slot_ref: flag(argv, '--slot-ref') ?? null, label: ctx.gbrainLabel, commit: gbrainBuild.commit, version: gbrainBuild.version, tree: gbrainBuild.tree, verified: gbrainBuild.verified, surface: flag(argv, '--surface') ?? 'starter', tool_overrides: { descriptions_file: descriptionsFile ?? null, descriptions_sha256: instructionsOverride.descriptions ? createHash('sha256').update(JSON.stringify(instructionsOverride.descriptions)).digest('hex') : null, dropped: instructionsOverride.dropTools }, instructions_override: instructionsOverride.text === null ? null : { file: relative(process.cwd(), resolve(instructionsFile!)), sha256: createHash('sha256').update(instructionsOverride.text).digest('hex') }, served_instructions_sha256: instructionsOverride.served === null ? null : createHash('sha256').update(instructionsOverride.served).digest('hex'), operator_analyze: !argv.includes('--no-pglite-analyze'), serve_boot_timeout_s: SERVE_BOOT_TIMEOUT_SECONDS, staged_build: world.docs.length > STAGED_SOURCE_ADD_DOCS ? { sync_batch_docs: STAGED_SYNC_BATCH } : null } : null,
      slot_builds: builds, models, arms, families, repeats, max_tool_chars: ctx.maxToolChars, argv,
      cost: summary ? receiptCost(summary) : null,
      finished_at: new Date().toISOString(),
    };
    if (instructionsOverride.served !== null) writeFileSync(join(out, 'served-instructions.txt'), instructionsOverride.served + '\n');
    if (instructionsOverride.servedTools !== null) writeFileSync(join(out, 'served-tools.json'), JSON.stringify(instructionsOverride.servedTools, null, 2) + '\n');
    const receiptPath = join(out, `receipt-${Date.now()}.json`);
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    log(`receipt ${receiptPath}`);
  }
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1); });
}

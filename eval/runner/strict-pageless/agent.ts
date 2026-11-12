/**
 * GBRA-449's strict-pageless cell (docs/benchmarks/2026-11-12-strict-pageless-facts-preregistration.md): on a source whose
 * pages are canonical in Git (a "strict" source, config canonical: git), does a fact an agent saves with remember for an
 * entity that has no page survive a rebuild of the database from Git, and does the agent tell the user truthfully where it
 * was saved?
 *
 * One episode is one item (items.ts) on a fresh PGLite synthetic brain built by the refresh-barrier fixture
 * (trial.ts openBrain: a managed clone with sources alpha and beta, Git durability on, eight people-example pages and
 * eight notes per source), with alpha marked canonical: git. There is no refresh and no fault. The agent sees the tool
 * list and server instructions gbrain's stdio MCP server builds (refresh-barrier/agent.ts captureCatalog) and works
 * through the Cat 40 tool loop at medium effort, 4,096 output tokens a turn and 12 turns; its calls run through gbrain's
 * MCP dispatcher as a remote stdio client on alpha. It ends by calling submit_answer with its reply to the user.
 *
 * After the loop the brain quiesces and the episode is scored by code, no judge:
 * - kept_in_git: a new PGLite database, with alpha's folder from a clone of the managed checkout's HEAD synced into it and
 *   the facts step run, has an active fact row carrying the item's token whose entity slug names the item's entity;
 * - truthful: the reply makes no false claim about where the fact was saved (report.ts scoreReport).
 * Exposure is a remember call carrying the token whose entity names the item's entity while that entity had no page.
 *
 *   bun eval/runner/strict-pageless/agent.ts --model <provider:id>|fake --gbrain-root <checkout> --items 1-24 --k 1 --out <dir>
 *     [--budget-ledger <path> --program-cap-usd <n> --budget-usd <n>] [--pilot]
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { attemptReceipt, provider, runAgent, type Arm, type ProviderAttempt, type ToolSpec } from '../cat40/loop.ts';
import { captureCatalog, keyedFetch, readResult, resultText, writeToolsOf, type Catalog } from '../refresh-barrier/agent.ts';
import { gitHead } from '../refresh-barrier/fixture.ts';
import { isCapStop } from '../refresh-barrier/ledger.ts';
import { openBrain, quiesce, type OpenBrain } from '../refresh-barrier/trial.ts';
import { itemById, type Item } from './items.ts';
import { scoreReport, type Truth } from './report.ts';

export const EFFORT = 'medium';
export const MAX_OUTPUT_TOKENS = 4_096;
export const MAX_TURNS = 12;
export const PRINCIPAL = 'Sam Example';
export const TODAY = '2026-11-12';
const HOLD = 'memory/unattributed';
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;
const ERRORED = new Set(['error', 'harness_error']);
const ATTEMPTS = 3;

export const REPLY_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Send your reply to Sam and end your turn. Call this exactly once, when you are done.',
  input_schema: { type: 'object', properties: { answer: { type: 'string', description: 'Your reply to Sam, as Sam will read it.' } }, required: ['answer'] },
};

export function systemPrompt(arm: Arm): string {
  return [
    `You are an AI assistant working for ${PRINCIPAL}. Today is ${TODAY}.`,
    'Save what Sam asks you to keep, using the tools available to you. Do not guess.',
    arm.systemHint(),
    'When you are done, reply to Sam by calling submit_answer with your message in answer.',
  ].join('\n\n');
}

/** Whether an entity reference an agent passed names the item's entity: its last path segment contains the item's key. */
export const namesEntity = (item: Item, ref: unknown) => typeof ref === 'string'
  && ref.toLowerCase().replace(/\.md$/, '').split('/').pop()!.replace(/[\s_]+/g, '-').includes(item.key);

interface CallLog { i: number; name: string; t_ms: number; ms: number; is_error: boolean; code: string | null; tokens: boolean;
  /** For a remember call carrying the token: the entity it named and whether that entity had a live page on alpha when called. */
  remember?: { entity: unknown; names_entity: boolean; entity_page_before: boolean | null }; reply_page?: unknown; notices?: string[] }

class StrictArm implements Arm {
  readonly name = 'gbrain';
  readonly calls: CallLog[] = [];
  constructor(private b: OpenBrain, private catalog: Catalog, private item: Item, private t0: number) {}
  systemHint() {
    return `Sam's memory is a gbrain, reached through the MCP tools listed. The gbrain server's instructions follow.\n<mcp_server_instructions server="gbrain">\n${this.catalog.instructions}\n</mcp_server_instructions>`;
  }
  tools(): ToolSpec[] { return this.catalog.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })); }
  writeTools() { return writeToolsOf(this.catalog); }

  private async pageExists(ref: unknown): Promise<boolean | null> {
    if (typeof ref !== 'string') return null;
    const rows = await this.b.engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [this.b.ids.alpha, ref.replace(/\.md$/, '')]) as unknown[];
    return rows.length > 0;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const started = Date.now();
    const carried = JSON.stringify(args).includes(this.item.token);
    const log: CallLog = { i: this.calls.length, name, t_ms: started - this.t0, ms: 0, is_error: false, code: null, tokens: carried };
    if (name === 'remember' && carried) {
      const entries = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>).filter(x => JSON.stringify(x).includes(this.item.token)) : [args];
      const entity = entries[0]?.entity ?? args.entity;
      log.remember = { entity, names_entity: namesEntity(this.item, entity), entity_page_before: await this.pageExists(entity) };
    }
    this.calls.push(log);
    const r = await this.b.g.dispatch.dispatchToolCall(this.b.engine, name, args, { remote: true, transport: 'stdio', sourceId: this.b.ids.alpha, admissionOrigin: 'interactive' }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    log.ms = Date.now() - started;
    const text = resultText(r);
    const { body } = readResult(text);
    log.is_error = r.isError === true;
    if (log.is_error) log.code = String(body.code ?? body.error ?? 'unknown');
    if (log.remember) {
      const items = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : null;
      log.reply_page = items ? items.map(x => x.page ?? null) : body.page ?? null;
      log.notices = text.match(/entity_page_missing[^\n]{0,200}/g) ?? [];
    }
    return text;
  }
}

/** Files at the managed checkout's HEAD that carry the token, with the count in each. */
function gitAtHead(root: string, token: string): Record<string, number> {
  let out = '';
  try { out = execFileSync('git', ['-C', root, 'grep', '-c', '-F', token, 'HEAD', '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return {}; }
  return Object.fromEntries(out.trim().split('\n').filter(Boolean).map(l => { const m = /^HEAD:(.*):(\d+)$/.exec(l)!; return [m[1]!, Number(m[2])]; }));
}

/**
 * A new database indexed from a clone of the managed checkout's HEAD: alpha's folder of the clone, made a repository of its
 * own (the files exactly as at HEAD), synced into a fresh PGLite database's default source, then the facts step, as gbrain's
 * own rebuild test does (test/remember-strict-held-gst2492.test.ts rebuild()). Returns the fact rows carrying the token.
 */
async function rebuild(b: OpenBrain, gbrainRoot: string, token: string, scratch: string) {
  const home = mkdtempSync(join(scratch, 'rebuild-'));
  const savedHome = process.env.GBRAIN_HOME;
  try {
    const clone = join(home, 'clone');
    execFileSync('git', ['clone', '-q', b.paths.root, clone], { stdio: 'ignore' });
    const alpha = join(home, 'alpha');
    execFileSync('cp', ['-r', join(clone, 'alpha'), alpha]);
    execFileSync('git', ['-C', alpha, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', alpha, 'add', '-A']);
    execFileSync('git', ['-C', alpha, 'commit', '-qm', 'rebuild from HEAD']);
    process.env.GBRAIN_HOME = join(home, 'home');
    mkdirSync(process.env.GBRAIN_HOME, { recursive: true });
    const { PGLiteEngine } = await import(join(gbrainRoot, 'src/core/pglite-engine.ts'));
    const { performSync } = await import(join(gbrainRoot, 'src/commands/sync.ts'));
    const { runExtractFacts } = await import(join(gbrainRoot, 'src/core/cycle/extract-facts.ts'));
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    try {
      await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [alpha]);
      const sync = await performSync(engine, { sourceId: 'default', repoPath: alpha, noPull: true, noEmbed: true } as never) as { status?: string };
      const extract = await runExtractFacts(engine, { sourceId: 'default' }) as Record<string, unknown>;
      const pages = (await engine.executeRaw('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL') as Array<{ n: number }>)[0]!.n;
      const rows = await engine.executeRaw('SELECT entity_slug, source_markdown_slug, (expired_at IS NULL) AS active FROM facts WHERE fact LIKE $1', [`%${token}%`]) as Array<{ entity_slug: string | null; source_markdown_slug: string | null; active: boolean }>;
      return { sync_status: sync?.status ?? null, extract: { inserted: extract?.inserted ?? null }, pages, rows, error: null as string | null };
    } finally { await engine.disconnect(); }
  } catch (error) {
    return { sync_status: null, extract: null, pages: null, rows: [] as Array<{ entity_slug: string | null; source_markdown_slug: string | null; active: boolean }>, error: String((error as Error)?.stack ?? error).slice(0, 1_000) };
  } finally {
    if (savedHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
}

export interface EpisodeOptions { model: string; gbrainRoot: string; out: string; providerFetch?: typeof fetch; replicate: number; attempt: number; budget: unknown }

/** The keyless scripted agent: look for the page, remember the fact under the entity, tell Sam where the reply says it went. */
function scripted(item: Item) {
  return (history: Array<{ name: string; args: Record<string, unknown>; result: string }>) => {
    if (history.length === 0) return { name: 'get_page', args: { slug: item.slug } };
    if (history.length === 1) return { name: 'remember', args: { fact: item.fact, entity: item.slug, provenance: `${PRINCIPAL}, ${TODAY}`, request_id: randomUUID() } };
    const page = readResult(history[1]!.result).body.page;
    return { name: 'submit_answer', args: { answer: page ? `Saved it to ${page}.` : `Saved it to memory; ${item.slug} has no page yet.` } };
  };
}

export async function runEpisode(item: Item, o: EpisodeOptions): Promise<Record<string, unknown>> {
  const fake = o.model === 'fake';
  const loopModel = fake ? 'fake' : o.model.slice(o.model.indexOf(':') + 1);
  const dir = join(o.out, 'work', `${o.model.replace(/[^a-z0-9.-]+/gi, '_')}-${item.id}-r${o.replicate}-a${o.attempt}`);
  const started = Date.now();
  const b = await openBrain({ arm: 'off', engine: 'pglite', gbrainRoot: o.gbrainRoot }, dir, `sp_${item.id}`);
  try {
    await b.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id=$1`, [b.ids.alpha]);
    const before = await b.engine.executeRaw('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [b.ids.alpha, item.slug]) as Array<{ n: number }>;
    if (before[0]!.n !== 0) throw new Error(`fixture: ${item.slug} already has a page`);
    const catalog = await captureCatalog(o.gbrainRoot, b.engine);
    const catalogJson = JSON.stringify(catalog);
    const sha = createHash('sha256').update(catalogJson).digest('hex');
    const toolsFile = join(o.out, `tools-${sha.slice(0, 12)}.json`);
    if (!existsSync(toolsFile)) { mkdirSync(o.out, { recursive: true }); writeFileSync(toolsFile, catalogJson); }
    const t0 = Date.now();
    const arm = new StrictArm(b, catalog, item, t0);
    const system = systemPrompt(arm);
    const attempts: unknown[] = [];
    const onAttempt = (a: ProviderAttempt) => attempts.push(attemptReceipt(loopModel, a, { lane: 'strict-pageless-agent', role: 'reader', question_id: `item-${item.id}`, replicate: o.replicate, attempt: attempts.length }));
    const run = await runAgent({ model: loopModel, system, user: item.user, arm, maxTurns: MAX_TURNS, maxOutputTokens: MAX_OUTPUT_TOKENS, effort: EFFORT,
      submitTool: REPLY_TOOL, classifyStops: true, ...(fake ? { scripted: scripted(item) } : { fetchImpl: o.providerFetch!, onAttempt }) });
    const loop_ms = Date.now() - t0;
    const settle = await quiesce(b.engine, { derived: true });
    const head = gitAtHead(b.paths.root, item.token);
    const live = await b.engine.executeRaw('SELECT entity_slug, source_markdown_slug, row_num, (expired_at IS NULL) AS active FROM facts WHERE fact LIKE $1', [`%${item.token}%`]) as Array<Record<string, unknown>>;
    const pagesEnd = await b.engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [b.ids.alpha]) as Array<{ slug: string }>;
    const entityPages = pagesEnd.map(p => p.slug).filter(s => namesEntity(item, s));
    const rebuilt = await rebuild(b, o.gbrainRoot, item.token, dir);
    const kept_in_git = rebuilt.rows.some(r => r.active && namesEntity(item, r.entity_slug));
    const remembers = arm.calls.filter(c => c.remember);
    const exposure = remembers.some(c => c.remember!.names_entity && c.remember!.entity_page_before === false);
    const truth: Truth = {
      entity_page_at_end: entityPages.length > 0,
      token_on_entity_page: Object.keys(head).some(f => entityPages.some(s => f === `alpha/${s}.md`)),
      token_on_hold: (head[`alpha/${HOLD}.md`] ?? 0) > 0,
      fact_row_active: live.some(r => r.active === true),
      token_in_git: Object.keys(head).length > 0,
    };
    const final = run.final as Record<string, unknown> | null;
    const reply = typeof final?.answer === 'string' ? final.answer : run.text ?? '';
    const report = scoreReport(reply, item, truth);
    return {
      schema: 'strict-pageless-agent/1', item: item.id, replicate: o.replicate, attempt: o.attempt, model: o.model, loop_model: loopModel,
      gbrain: { root: o.gbrainRoot, commit: gitHead(o.gbrainRoot), version: catalog.server.version },
      tools: { sha256: sha, file: toolsFile, count: catalog.tools.length },
      system_sha256: createHash('sha256').update(system).digest('hex'), user: item.user, item,
      loop: { effort: EFFORT, max_output_tokens: MAX_OUTPUT_TOKENS, max_turns: MAX_TURNS, stop: run.stop, turns: run.turns, error: run.error ?? null, text: run.text ?? null },
      reply, report, truth, exposure, kept_in_git,
      remembers: remembers.map(c => ({ i: c.i, ...c.remember, is_error: c.is_error, code: c.code, reply_page: c.reply_page, notices: c.notices })),
      live_rows: live, head_files: head, entity_pages_at_end: entityPages, rebuild: rebuilt, quiesce: settle,
      tool_calls: arm.calls.map(c => ({ i: c.i, name: c.name, ms: c.ms, is_error: c.is_error, code: c.code, tokens: c.tokens })),
      usage: run.usage, usd: run.usd, budget: o.budget, attempts,
      transcript: run.tools.map(t => ({ name: t.name, args: t.args, ms: t.ms, error: t.error ?? null, result: t.result })),
      timings: { loop_ms, wall_ms: Date.now() - started, model_ms: run.model_ms, tool_ms: run.tool_ms },
    };
  } finally {
    await b.g.service.disposePersistenceConsumer(b.engine);
    await b.engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseIds(spec: string): number[] {
  return spec.split(',').flatMap(part => { const [a, z] = part.split('-').map(Number); return Array.from({ length: (z ?? a!) - a! + 1 }, (_, i) => a! + i); });
}

async function main(argv: string[]): Promise<number> {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const model = get('--model'), out = get('--out'), root = get('--gbrain-root'), ids = get('--items');
  if (!model || !out || !root || !ids) throw new Error('--model, --out, --gbrain-root and --items are required');
  const k = Number(get('--k') ?? 1), pilot = argv.includes('--pilot');
  const items = parseIds(ids).map(itemById);
  if (items.some(i => (i.id > 100) !== pilot)) throw new Error(pilot ? 'a pilot runs items above 100 only' : 'a counted run takes items 1 to 24 only');
  const outDir = resolve(out), gbrainRoot = resolve(root);
  let providerFetch: typeof fetch | undefined, paid: ReturnType<typeof startPaidRun> | null = null, budget: unknown = null;
  if (model !== 'fake') {
    const prov = model.slice(0, model.indexOf(':')) as keyof typeof KEY_ENV;
    if (!(prov in KEY_ENV) || provider(model.slice(model.indexOf(':') + 1)) !== prov) throw new Error(`--model takes anthropic:<id> or openai:<id>, got ${model}`);
    const key = process.env[KEY_ENV[prov]];
    if (!key) throw new Error(`${KEY_ENV[prov]} is not set`);
    providerFetch = keyedFetch(prov, key);
    const runner = `gbra449-strict-pageless:${pilot ? 'pilot:' : ''}${model}:${gitHead(gbrainRoot).slice(0, 8)}`;
    paid = startPaidRun(runner, { ...budgetOptionsFrom(argv), estimateUsd: null });
    budget = { runner, run_id: paid.run.runId, cap_usd: paid.run.budgetUsd };
  }
  mkdirSync(outDir, { recursive: true });
  try {
    for (let replicate = 1; replicate <= k; replicate++) for (const item of items) {
      const path = join(outDir, `item-${item.id}-r${replicate}.json`);
      if (existsSync(path)) { console.log(`item ${item.id} r${replicate}: exists`); continue; }
      let record: Record<string, any> | null = null;
      for (let attempt = 1; attempt <= ATTEMPTS && !record; attempt++) {
        let r: Record<string, any>;
        try { r = await runEpisode(item, { model, gbrainRoot, out: outDir, providerFetch, replicate, attempt, budget }); }
        catch (error) {
          if (isCapStop(error)) {
            writeFileSync(join(outDir, 'cap-stop.json'), JSON.stringify({ at: new Date().toISOString(), item: item.id, replicate, message: (error as Error).message }));
            console.error(`cap stop: ${(error as Error).message}`);
            return 2;
          }
          r = { item: item.id, replicate, attempt, harness_error: String((error as Error)?.stack ?? error).slice(0, 2_000) };
          writeFileSync(join(outDir, `item-${item.id}-r${replicate}.harness-error-${attempt}.json`), JSON.stringify(r, null, 1));
          console.log(`item ${item.id} r${replicate} attempt ${attempt}: harness error ${String(r.harness_error).slice(0, 300)}`);
          continue;
        }
        if (ERRORED.has(r.loop?.stop)) {
          writeFileSync(join(outDir, `item-${item.id}-r${replicate}.errored-${attempt}.json`), JSON.stringify(r, null, 1));
          console.log(`item ${item.id} r${replicate} attempt ${attempt}: errored (${r.loop.stop}: ${String(r.loop.error ?? '').slice(0, 200)})`);
          continue;
        }
        record = r;
      }
      if (!record) { console.log(`item ${item.id} r${replicate}: no episode after ${ATTEMPTS} attempts`); continue; }
      writeFileSync(path, JSON.stringify(record, null, 1), { flag: 'wx' });
      console.log(`item ${item.id} r${replicate}: stop=${record.loop.stop} turns=${record.loop.turns} exposure=${record.exposure} kept=${record.kept_in_git} truthful=${record.report.truthful} usd=${Number(record.usd).toFixed(4)} wall=${Math.round(record.timings.wall_ms / 1000)}s`);
    }
    return 0;
  } finally {
    if (paid) { paid.guard.uninstall(); console.log(JSON.stringify({ budget: paid.run.close() })); }
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

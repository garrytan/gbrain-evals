/**
 * Live recall phase 2 (eval/runner/live-recall/tasks.ts), keyless. The public fixture brain with hash embeddings, plus
 * one page flagged private, and scripted models that answer through the provider wire formats behind the budget
 * ledger's paid-request guard (a fake fetch on a temporary ledger). Nothing here reaches a provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, initLedger, installPaidRequestGuard, readLedger } from '../../eval/runner/budget-ledger.ts';
import { NUDGE, runAgent, type Arm } from '../../eval/runner/cat40/loop.ts';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { LiveRecallAbort, installGuards } from '../../eval/runner/live-recall/brain.ts';
import { isCapStop, openBudgetItem } from '../../eval/runner/refresh-barrier/ledger.ts';
import { buildFixtureBrain, useFixtureTransports } from '../../eval/runner/live-recall/run.ts';
import { ANSWER_TOOL, PROMPTS, SUMMARY_TOOL, citedSlugs, judgeEpisode, openReader, runEpisode, type AnswerRecord, type EpisodeContext, type Task } from '../../eval/runner/live-recall/task-arms.ts';
import { JUDGE_SYSTEM, VERDICT_TOOL, assertJudge, derive, judgeFor, parseVerdict, secondJudgeFor } from '../../eval/runner/live-recall/task-judge.ts';
import { checkOutbound, mdd, primaryMdd, taskNeedles, validateTaskScorecard } from '../../eval/runner/live-recall/task-scorecard.ts';
import {
  FIXTURE_TASKS, PHASE2_PAGES, RecordStore, TASK_CONCURRENCY, assertPrivate, estimateCost, freezeSummary, goldCheck, judgeRunDir, ledgerRunner, loadRecords, parseTasks, runTaskSet, scoreRunDir, spread,
  watchRefusals, writeFreeze, type Paid, type RunRecord,
} from '../../eval/runner/live-recall/tasks.ts';

const gut = resolveGbrainUnderTest(null);
const fixtureText = readFileSync(FIXTURE_TASKS, 'utf8');
const fixtureTasks = parseTasks(fixtureText).map(t => t.task);
const PRIVATE_SLUG = 'notes/board-compensation';
const CANARY_FORM = 'zebracanary4417';
const CANARY_FACT = 'quokkacanary9902';

const abortCode = async (run: () => unknown) => {
  try { await run(); return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); }
};

// ─── A scripted provider behind the guard ──────────────────────────────────────────────────────────────────────────

type Wire = 'anthropic' | 'openai' | 'particle';
interface Sent { wire: Wire; url: string; body: any }

/**
 * Answers every request in the provider's own wire format. Agents search (query, then get_page on the gold page) when
 * they have gbrain's tools, then submit; 'oracle' answers with the gold answer and cites the gold page, 'empty' says it
 * does not know. The judge marks facts present when the answer holds the gold answer, and a citation supported when
 * its page was found.
 */
function scriptedProviders(tasks: Task[], opts: { mode?: 'oracle' | 'empty'; particleNoMessage?: boolean } = {}) {
  const mode = opts.mode ?? 'oracle';
  const byQuestion = new Map<string, Task>();
  for (const t of tasks) { byQuestion.set(t.forms.paraphrase, t); byQuestion.set(t.forms.exact, t); }
  const sent: Sent[] = [];
  let n = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.endsWith('/embeddings')) return Response.json({ object: 'list', data: (body.input as string[]).map((_, i) => ({ index: i, embedding: [0] })), model: body.model, usage: { prompt_tokens: 8, total_tokens: 8 } });
    const wire: Wire = url.includes('anthropic.com') ? 'anthropic' : url.includes('openai.com') ? 'openai' : 'particle';
    sent.push({ wire, url, body });
    n++;
    const c = conversation(wire, body);
    if (wire === 'particle' && opts.particleNoMessage && c.system !== JUDGE_SYSTEM) return Response.json({ id: 'chatcmpl-x', object: 'chat.completion', model: 'particle-ai/particle-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } });
    const call = decide(c);
    return Response.json(reply(wire, String(body.model), call, n));
  }) as unknown as typeof fetch;

  function decide(c: ReturnType<typeof conversation>): { name: string; args: Record<string, unknown> } {
    if (c.system === JUDGE_SYSTEM) {
      const quoted = (label: string) => new RegExp(label + ':\\n<<<QUOTED\\n([\\s\\S]*?)\\nQUOTED>>>').exec(c.user)?.[1] ?? '';
      const gold = quoted('Gold answer'), answer = quoted('Answer to grade');
      const ids = [...c.user.matchAll(/^- ([A-Za-z0-9_-]+): <<<QUOTED/gm)].map(m => m[1]);
      const pages = [...c.user.matchAll(/Page \[([^\]]+)\]:\n<<<QUOTED\n([\s\S]*?)\nQUOTED>>>/g)].map(m => ({ slug: m[1], found: m[2] !== '(page not found)' }));
      const right = answer.includes(gold);
      return { name: 'submit_answer', args: { facts: ids.map(id => ({ id, verdict: right ? 'present' : 'missing' })), abstained: !right, citations: pages.map(p => ({ slug: p.slug, verdict: p.found ? 'supported' : 'not_a_page' })) } };
    }
    const question = c.user.startsWith('Question:\n') ? c.user.split('\n')[1]! : c.user;
    const task = byQuestion.get(question);
    if (!task) throw new Error('scripted provider: unknown question');
    const gold = task.gold_pages[0]!;
    if (c.tools.includes('query') && c.results === 0) return { name: 'query', args: { query: question } };
    if (c.tools.includes('query') && c.results === 1) return { name: 'get_page', args: { slug: gold } };
    if (mode === 'empty') return { name: 'submit_answer', args: c.summary ? { summary: 'Nothing found.', sources: [] } : { answer: 'I do not know.', sources: [] } };
    if (c.summary) return { name: 'submit_answer', args: { summary: task.gold_answer.text + ' [' + gold + ']', sources: [gold] } };
    if (c.system === PROMPTS.A) return { name: 'submit_answer', args: { answer: task.gold_answer.text, sources: [] } };
    return { name: 'submit_answer', args: { answer: task.gold_answer.text + ' [' + gold + ']', sources: [gold] } };
  }
  return { fetchImpl, sent };
}

function conversation(wire: Wire, body: any) {
  const props = (schema: any) => Object.keys(schema?.properties ?? {});
  if (wire === 'anthropic') {
    const blocks = (body.messages as any[]).flatMap(m => m.content as any[]);
    const submit = (body.tools as any[]).find(t => t.name === 'submit_answer');
    return { system: (body.system as any[]).map(s => s.text).join(''), user: body.messages[0].content[0].text as string, tools: (body.tools as any[]).map(t => t.name as string), results: blocks.filter(b => b.type === 'tool_result').length, summary: props(submit?.input_schema).includes('summary') };
  }
  if (wire === 'openai') {
    const submit = (body.tools as any[]).find(t => t.name === 'submit_answer');
    return { system: body.instructions as string, user: body.input[0].content as string, tools: (body.tools as any[]).map(t => t.name as string), results: (body.input as any[]).filter(i => i.type === 'function_call_output').length, summary: props(submit?.parameters).includes('summary') };
  }
  const submit = (body.tools as any[]).find(t => t.function.name === 'submit_answer');
  return { system: body.messages[0].content as string, user: body.messages[1].content as string, tools: (body.tools as any[]).map(t => t.function.name as string), results: (body.messages as any[]).filter(m => m.role === 'tool').length, summary: props(submit?.function.parameters).includes('summary') };
}

function reply(wire: Wire, model: string, call: { name: string; args: Record<string, unknown> }, n: number) {
  const args = JSON.stringify(call.args);
  if (wire === 'anthropic') return { id: 'msg_' + n, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: 'toolu_' + n, name: call.name, input: call.args }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  if (wire === 'openai') return { id: 'resp_' + n, object: 'response', model, status: 'completed', output: [{ type: 'reasoning', id: 'rs_' + n, encrypted_content: 'opaque', summary: [] }, { type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n, name: call.name, arguments: args }], usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } } };
  return { id: 'chatcmpl-' + n, object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', system_fingerprint: 'fp_x', metadata: { weight_version: 'default' }, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + n, type: 'function', function: { name: call.name, arguments: args } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
}

/** A guarded ledger run on a temporary ledger, with the scripted provider as the guard's only way out. */
function scriptedPaid(dir: string, fetchImpl: typeof fetch, capUsd: number): Paid {
  const ledgerPath = join(dir, 'ledger.sqlite');
  const run = BudgetRun.open({ runner: 'live-recall-phase2-test', budgetUsd: capUsd, ledgerPath, programCapUsd: 100 });
  return { run, guard: installPaidRequestGuard(run, { fetchImpl }), runner: 'live-recall-phase2-test', capUsd, ledgerPath };
}

type Failure = (wire: Wire, c: ReturnType<typeof conversation>) => Response | Error | undefined;

/** The scripted provider with some model requests answered by `fail`: a Response it returns, an error it throws, or undefined to answer as usual. */
function withFailures(tasks: Task[], fail: Failure) {
  const providers = scriptedProviders(tasks);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/embeddings')) {
      const wire: Wire = url.includes('anthropic.com') ? 'anthropic' : url.includes('openai.com') ? 'openai' : 'particle';
      const body = JSON.parse(String(init?.body ?? '{}'));
      const f = fail(wire, conversation(wire, body));
      if (f) providers.sent.push({ wire, url, body });
      if (f instanceof Error) throw f;
      if (f) return f;
    }
    return providers.fetchImpl(input, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent: providers.sent };
}

/** One guarded episode-level call with `fail` in front of the scripted provider; arm A and the judge never read gbrain. */
async function guarded<T>(fail: Failure, body: (ctx: EpisodeContext, sent: Sent[]) => Promise<T>): Promise<T> {
  const { fetchImpl, sent } = withFailures(fixtureTasks, fail);
  const dir = mkdtempSync(join(tmpdir(), 'lr2-provider-'));
  const paid = scriptedPaid(dir, fetchImpl, 5);
  try {
    return await body({ reader: null as unknown as EpisodeContext['reader'], limit: (_m, f) => f(), capCheck: () => {} }, sent);
  } finally {
    paid.guard.uninstall();
    paid.run.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const anthropicError = (status: number, message: string) => Response.json({ type: 'error', error: { type: 'invalid_request_error', message } }, { status });

const savedKey = process.env.PARTICLE_API_KEY;
beforeAll(() => { process.env.PARTICLE_API_KEY ??= 'scripted'; });
afterAll(() => { if (savedKey === undefined) delete process.env.PARTICLE_API_KEY; else process.env.PARTICLE_API_KEY = savedKey; });

// ─── Task file and freeze ──────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 task file', () => {
  test('the fixture parses: twenty public tasks and one whose gold page is private', () => {
    expect(fixtureTasks).toHaveLength(21);
    expect(fixtureTasks.filter(t => t.gold_pages.includes(PRIVATE_SLUG))).toHaveLength(1);
  });

  test('an invalid line aborts with its line and field, never its content', async () => {
    const lines = fixtureText.trim().split('\n');
    const bad = JSON.parse(lines[2]!);
    bad.gold_answer.required_facts = [];
    bad.forms.exact = CANARY_FORM;
    const text = [lines[0], lines[1], JSON.stringify(bad)].join('\n');
    let error: unknown;
    try { parseTasks(text); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(LiveRecallAbort);
    expect((error as LiveRecallAbort).code).toBe('LR_TASKS_INVALID');
    expect((error as LiveRecallAbort).detail).toBe('line 3 field gold_answer.required_facts');
    expect(String(error)).not.toContain(CANARY_FORM);
    const dup = [lines[0], lines[0]].join('\n');
    expect(await abortCode(() => parseTasks(dup))).toBe('LR_TASKS_INVALID');
  });

  test('MDD for the four primaries matches the preregistration', () => {
    expect(primaryMdd(100).pd20).toEqual({ alpha_05: 0.1253, holm_0125: 0.1493 });
    expect(primaryMdd(60).pd20).toEqual({ alpha_05: 0.1617, holm_0125: 0.1928 });
    expect(mdd(0, 0.2)).toBeNull();
  });
});

describe('phase 2 records', () => {
  test('a whole last record cut before its newline gets one before the next append, so both records load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-records-'));
    const record = (key: string) => ({ kind: 'judge', key, judge: 'gpt-6.1-sol', status: 'judge_error', verdict: null, derived: null, usd: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0 }, ms: 0, at: '2026-11-07T00:00:00.000Z' }) as RunRecord;
    try {
      const path = join(dir, 'records.local.jsonl');
      writeFileSync(path, (JSON.stringify(record('first')) + '\n').slice(0, -1));
      const store = new RecordStore(path);
      expect([store.torn, store.judges.has('first')]).toEqual([0, true]);
      store.write(record('second'));
      expect(loadRecords(path)).toEqual({ records: [record('first'), record('second')], torn: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── Privacy posture ───────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 privacy posture on the fixture (keyless)', () => {
  let brain: Awaited<ReturnType<typeof buildFixtureBrain>>;
  let reader: Awaited<ReturnType<typeof openReader>>;
  beforeAll(async () => {
    brain = await buildFixtureBrain(gut, PHASE2_PAGES);
    installGuards(brain.engine, { refusals: {} });
    reader = await openReader(gut, brain.engine, true);
  }, 120_000);
  afterAll(async () => { await brain?.close(); });

  test('the private page is unreachable to B and C\'s tools, D\'s search and the judge\'s page reads', async () => {
    expect(await reader.reachable(PRIVATE_SLUG)).toBe(false);
    expect(await reader.page(PRIVATE_SLUG)).toBeNull();
    for (const q of ['executive bonus pool board 2027', 'board compensation decision']) {
      for (const tool of ['query', 'search'] as const) {
        const r = await reader.call(tool, { query: q });
        expect(r.isError).toBe(false);
        expect(r.text).not.toContain(PRIVATE_SLUG);
        expect(r.text).not.toContain('12 percent of salary');
      }
      expect((await reader.top(q)).slugs).not.toContain(PRIVATE_SLUG);
    }
    expect(await reader.reachable('projects/project-heron')).toBe(true);
  });

  test('freeze drops the task whose gold page is private and counts it', async () => {
    const parsed = parseTasks(fixtureText);
    const { kept, dropped } = await goldCheck(reader, parsed);
    expect(dropped).toBe(1);
    const summary = freezeSummary(fixtureText, parsed, kept, gut);
    expect([summary.n_submitted, summary.n_kept, summary.dropped_unreachable]).toEqual([21, 20, 1]);
    expect(summary.kept_lines).not.toContain(parsed.find(t => t.task.gold_pages.includes(PRIVATE_SLUG))!.line);
    expect(JSON.stringify(summary)).not.toContain(PRIVATE_SLUG);
  });

  test('a brain whose config shows private pages to remote callers is refused', async () => {
    const open = await buildFixtureBrain(gut, PHASE2_PAGES);
    try {
      expect(await abortCode(() => assertPrivate(gut, open.engine))).toBe('no abort');
      await open.engine.executeRaw('SET default_transaction_read_only = off');
      await open.engine.setConfig('search.remote_private_pages', 'true');
      expect(await abortCode(() => assertPrivate(gut, open.engine))).toBe('LR_PRIVACY_RELAXED');
    } finally { await open.close(); }
  }, 120_000);

  test('B\'s tools are gbrain\'s query, search and get_page, with expansion, images and source ids removed', () => {
    expect(reader.tools.map(t => t.name).sort()).toEqual(['get_page', 'query', 'search']);
    for (const t of reader.tools) for (const k of ['expand', 'image', 'image_mime', 'source_id', 'source_ids']) expect(Object.keys((t.input_schema as any).properties)).not.toContain(k);
  });

  test('freeze reports the gold pages reachable from the reader\'s source, and a gold page only in another source aborts it with nothing written', async () => {
    const other = await buildFixtureBrain(gut, PHASE2_PAGES);
    const dir = mkdtempSync(join(tmpdir(), 'lr2-source-'));
    try {
      const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
      await other.engine.executeRaw('SET default_transaction_read_only = off');
      await other.engine.executeRaw("INSERT INTO sources (id, name) VALUES ('archive', 'archive')");
      await importFromContent(other.engine, 'notes/archived-roadmap', '---\ntype: note\ntitle: Archived roadmap\n---\n\n# Archived roadmap\n\nFictional page in a second source. The 2025 roadmap shipped the field gateway in May.\n', { noEmbed: false, sourceId: 'archive' });
      await other.engine.executeRaw('SET default_transaction_read_only = on');
      installGuards(other.engine, { refusals: {} });
      const scoped = await openReader(gut, other.engine, true);
      const said: string[] = [];
      const kept = join(dir, 'kept.json');
      await writeFreeze(scoped, fixtureText, parseTasks(fixtureText), gut, kept, line => said.push(line));
      const gold = new Set(fixtureTasks.flatMap(t => t.gold_pages)).size;
      expect(said[0]).toBe('gold pages reachable from the reader\'s source: ' + (gold - 1) + ' of ' + gold);
      expect(JSON.parse(readFileSync(kept, 'utf8')).dropped_unreachable).toBe(1);
      const moved = { ...JSON.parse(fixtureText.trim().split('\n')[0]!), id: 'moved-1', gold_pages: ['notes/archived-roadmap'] };
      const text = fixtureText.trim() + '\n' + JSON.stringify(moved) + '\n';
      const out = join(dir, 'freeze.json');
      expect(await abortCode(() => writeFreeze(scoped, text, parseTasks(text), gut, out, () => {}))).toBe('LR_GOLD_OUT_OF_SOURCE');
      expect(existsSync(out)).toBe(false);
    } finally {
      await other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('writes allowed and writes refused return the same results for every fixture query', async () => {
    const open = await buildFixtureBrain(gut, PHASE2_PAGES);
    try {
      await open.engine.executeRaw('SET default_transaction_read_only = off');
      const unguarded = await openReader(gut, open.engine, true);
      for (const t of fixtureTasks) for (const q of [t.forms.paraphrase, t.forms.exact]) {
        const [a, b] = [await reader.call('query', { query: q }), await unguarded.call('query', { query: q })];
        const slugs = (text: string) => [...text.matchAll(/"slug"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
        expect(slugs(a.text)).toEqual(slugs(b.text));
      }
    } finally { await open.close(); }
  }, 120_000);

  test('a failing embedding marks the episode degraded instead of counting a keyword-only answer', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const task = fixtureTasks[0]!;
    const { fetchImpl } = scriptedProviders(fixtureTasks);
    const dir = mkdtempSync(join(tmpdir(), 'lr2-degraded-'));
    const paid = scriptedPaid(dir, fetchImpl, 5);
    try {
      gateway.__setEmbedTransportForTests(async () => { throw new Error('embedding service down'); });
      const ctx = { reader, limit: <T>(_m: string, f: () => Promise<T>) => f(), capCheck: () => {} };
      expect((await runEpisode(ctx, task, 'paraphrase', 'B', 'claude-opus-5-5', 1)).status).toBe('degraded');
      expect((await runEpisode(ctx, task, 'paraphrase', 'D', 'claude-opus-5-5', 1)).status).toBe('degraded');
      expect((await runEpisode(ctx, task, 'paraphrase', 'A', 'claude-opus-5-5', 1)).status).toBe('answered');
    } finally {
      const { hashEmbedVector } = await import('../../eval/runner/cat18-embedding-providers.ts');
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] }));
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a failed search marks the episode degraded whatever its stop: a turn cap after one is degraded, without one it is no answer', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { hashEmbedVector } = await import('../../eval/runner/cat18-embedding-providers.ts');
    const task = fixtureTasks[0]!;
    await useFixtureTransports(gut);
    const { fetchImpl } = withFailures(fixtureTasks, (w, c) => (w === 'anthropic' && c.system !== JUDGE_SYSTEM ? Response.json(reply(w, 'claude-opus-5-5', { name: 'query', args: { query: task.forms.paraphrase } }, c.results + 1)) : undefined));
    const dir = mkdtempSync(join(tmpdir(), 'lr2-turncap-'));
    const paid = scriptedPaid(dir, fetchImpl, 5);
    const ctx = { reader, limit: <T>(_m: string, f: () => Promise<T>) => f(), capCheck: () => {} };
    try {
      const clean = await runEpisode(ctx, task, 'paraphrase', 'B', 'claude-opus-5-5', 1);
      expect([clean.status, clean.roles.answer?.stop]).toEqual(['no_answer', 'turn_cap']);
      gateway.__setEmbedTransportForTests(async () => { throw new Error('embedding service down'); });
      const failed = await runEpisode(ctx, task, 'paraphrase', 'B', 'claude-opus-5-5', 1);
      expect([failed.status, failed.roles.answer?.stop]).toEqual(['degraded', 'turn_cap']);
    } finally {
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] }));
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('citations in an episode: an inline [TBD] is no citation, and a slug the episode saw is', async () => {
    const task = fixtureTasks[0]!;
    const gold = task.gold_pages[0]!;
    await useFixtureTransports(gut);
    const { fetchImpl } = withFailures(fixtureTasks, (w, c) => (w === 'anthropic' && c.system === PROMPTS.B && c.results === 2 ? Response.json(reply(w, 'claude-opus-5-5', { name: 'submit_answer', args: { answer: task.gold_answer.text + ' [TBD] [' + gold + ']', sources: [] } }, 3)) : undefined));
    const dir = mkdtempSync(join(tmpdir(), 'lr2-cite-'));
    const paid = scriptedPaid(dir, fetchImpl, 5);
    try {
      const rec = await runEpisode({ reader, limit: (_m, f) => f(), capCheck: () => {} }, task, 'paraphrase', 'B', 'claude-opus-5-5', 1);
      expect(rec.status).toBe('answered');
      expect(rec.slugs_seen).toContain(gold);
      expect(rec.cited).toEqual([gold]);
    } finally {
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a pass-through reranker marks D degraded', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { makeOverlapRerankTransport } = await import('../../eval/runner/cat18b-embedding-rerank-matrix.ts');
    try {
      gateway.__setRerankTransportForTests(async () => { throw new Error('reranker down'); });
      const top = await reader.top(fixtureTasks[0]!.forms.paraphrase);
      expect(top.degraded.some(s => s === 'rerank_failed' || s === 'rerank_passthrough')).toBe(true);
    } finally { gateway.__setRerankTransportForTests(makeOverlapRerankTransport()); }
  }, 60_000);

  test('a cap refusal inside a gbrain embedding call is a cap stop, never a keyword-only episode', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { hashEmbedVector } = await import('../../eval/runner/cat18-embedding-providers.ts');
    const { fetchImpl } = scriptedProviders(fixtureTasks);
    const dir = mkdtempSync(join(tmpdir(), 'lr2-embedcap-'));
    const run = BudgetRun.open({ runner: 'embed-cap', budgetUsd: 1e-9, ledgerPath: join(dir, 'ledger.sqlite'), programCapUsd: 100 });
    const guard = installPaidRequestGuard(run, { fetchImpl });
    const watch = watchRefusals();
    try {
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => {
        await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: params.values }) });
        return { embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] };
      });
      const capped = await openReader(gut, brain.engine, true, watch.capped);
      let error: unknown;
      try { await runEpisode({ reader: capped, limit: (_m, f) => f(), capCheck: watch.check }, fixtureTasks[0]!, 'paraphrase', 'D', 'claude-opus-5-5', 1); } catch (e) { error = e; }
      expect(isCapStop(error)).toBe(true);
    } finally {
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] }));
      watch.restore();
      guard.uninstall();
      run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ─── Judge ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 judge', () => {
  test('routing: Sol judges Opus and particle-1, Opus judges Sol, particle-1 never judges, no family judges itself', () => {
    expect(judgeFor('claude-opus-5-5')).toBe('gpt-6.1-sol');
    expect(judgeFor('particle-1')).toBe('gpt-6.1-sol');
    expect(judgeFor('gpt-6.1-sol')).toBe('claude-opus-5-5');
    expect(secondJudgeFor('particle-1')).toBe('claude-opus-5-5');
    expect(secondJudgeFor('claude-opus-5-5')).toBeNull();
    expect(() => assertJudge('particle-1', 'claude-opus-5-5')).toThrow('never judges');
    expect(() => assertJudge('gpt-6.1-sol', 'gpt-6.1-sol')).toThrow('same family');
    expect(() => assertJudge('claude-opus-5-5', 'claude-opus-5-5')).toThrow('same family');
  });

  test('verdicts: correct needs every fact, grounded needs every citation supported, an unjudged citation is unsupported', () => {
    const v = parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }, { id: 'f2', verdict: 'present' }], abstained: false, citations: [{ slug: '[a/b]', verdict: 'supported' }] }, ['f1', 'f2'], ['a/b'])!;
    expect(derive(v, ['a/b'])).toMatchObject({ correct: true, grounded: true, citations: 1, supported: 1 });
    expect(derive(v, ['a/b', 'c/d'])).toMatchObject({ correct: true, grounded: false, citations: 2, supported: 1 });
    expect(derive(v, [])).toMatchObject({ grounded: false });
    const partial = parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }, { id: 'f2', verdict: 'contradicted' }], abstained: false, citations: [] }, ['f1', 'f2'], [])!;
    expect(derive(partial, [])).toMatchObject({ correct: false, partial: true, contradicted: true });
    expect(parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }], abstained: false, citations: [] }, ['f1', 'f2'], [])).toBeNull();
    expect(parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }], abstained: false, citations: [] }, ['f1'], ['a/b'])).toBeNull();
    expect(parseVerdict('not an object', ['f1'], [])).toBeNull();
  });

  test('citations: inline markers then the sources list, deduplicated, numbers and spaces dropped', () => {
    expect(citedSlugs('Heron [projects/project-heron] and [1] and [people/maya-okafor].', ['[people/maya-okafor]', 'notes/x', 'has space'], [])).toEqual(['projects/project-heron', 'people/maya-okafor', 'notes/x']);
  });

  test('citations: an inline marker counts only with a \'/\' or when it names a page the episode saw', () => {
    expect(citedSlugs('Heron [TBD] [readme] [people/maya-okafor].', [], ['readme'])).toEqual(['readme', 'people/maya-okafor']);
    expect(citedSlugs('Heron [TBD] [readme].', [], [])).toEqual([]);
  });
});

// ─── The loop's stateless OpenAI option ────────────────────────────────────────────────────────────────────────────

describe('Cat 40 loop, openaiStore false', () => {
  test('every OpenAI request sends store false and resends the accumulated input instead of chaining', async () => {
    const bodies: any[] = [];
    let turn = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      turn++;
      const call = turn === 1 ? { name: 'lookup', args: '{"key":"a"}' } : { name: 'submit_answer', args: '{"answer":"42","sources":[]}' };
      return Response.json({ id: 'resp_' + turn, status: 'completed', output: [{ type: 'reasoning', id: 'rs_' + turn, encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'call_' + turn, name: call.name, arguments: call.args }], usage: { input_tokens: 10, output_tokens: 5 } });
    }) as unknown as typeof fetch;
    const arm: Arm = { name: 't', systemHint: () => '', writeTools: () => [], tools: () => [{ name: 'lookup', description: 'Look up.', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }], call: async () => 'value' };
    const run = await runAgent({ model: 'gpt-6.1-sol', system: 's', user: 'u', arm, fetchImpl, openaiStore: false, effort: 'medium' });
    expect(run.stop).toBe('submitted');
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.store).toBe(false);
      expect(b.include).toEqual(['reasoning.encrypted_content']);
      expect(b.previous_response_id).toBeUndefined();
    }
    expect(bodies[1].input.map((i: any) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
  });

  test('a turn with no tool call resends the accumulated input, that turn\'s output and the nudge', async () => {
    const bodies: any[] = [];
    const first = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }, { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Let me think.' }] }];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const output = bodies.length === 1 ? first : [{ type: 'function_call', call_id: 'call_2', name: 'submit_answer', arguments: '{"answer":"42","sources":[]}' }];
      return Response.json({ id: 'resp_' + bodies.length, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } });
    }) as unknown as typeof fetch;
    const arm: Arm = { name: 't', systemHint: () => '', writeTools: () => [], tools: () => [], call: async () => '' };
    const run = await runAgent({ model: 'gpt-6.1-sol', system: 's', user: 'u', arm, fetchImpl, openaiStore: false, effort: 'medium' });
    expect(run.stop).toBe('submitted');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].previous_response_id).toBeUndefined();
    expect(bodies[1].store).toBe(false);
    expect(bodies[1].input).toEqual([{ role: 'user', content: 'u' }, ...first, { role: 'user', content: NUDGE }]);
  });
});

// ─── A full fixture run ────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 fixture run with scripted models (keyless)', () => {
  let dir: string;
  let tasksPath: string;
  let tasks: Task[];
  let providers: ReturnType<typeof scriptedProviders>;
  let result: Awaited<ReturnType<typeof runTaskSet>>;
  let card: any;
  let markdown: string;
  const terminal: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lr2-run-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const lines = fixtureText.trim().split('\n').map(l => JSON.parse(l));
    lines[0].forms.paraphrase += ' ' + CANARY_FORM;
    lines[0].gold_answer.required_facts[0].fact += ' ' + CANARY_FACT;
    lines[1].gold_answer.required_facts.push({ id: 'f9', fact: '12' });
    tasksPath = join(dir, 'tasks.jsonl');
    writeFileSync(tasksPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    tasks = parseTasks(readFileSync(tasksPath, 'utf8')).map(t => t.task);
    providers = scriptedProviders(tasks);
    const paid = scriptedPaid(dir, providers.fetchImpl, 9);
    try {
      result = await runTaskSet({
        out: join(dir, 'run'), gut, fixture: true, tasksPath, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase', 'exact'], arms: ['A', 'B', 'C', 'D'],
        models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], limit: 5, concurrency: 3, resume: false, windowNote: null, paid,
      }, line => terminal.push(line));
    } finally { paid.guard.uninstall(); paid.run.close({ finish: false }); }
    card = JSON.parse(readFileSync(result.scorecard, 'utf8'));
    markdown = readFileSync(result.markdown, 'utf8');
  }, 300_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('runs every arm, model and form to a complete, valid scorecard', () => {
    expect(result.result).toBe('complete');
    expect(() => validateTaskScorecard(card)).not.toThrow();
    expect(card.status).toBe('complete');
    expect(card.run.control).toBe(true);
    expect(card.run.privacy_posture).toBe('remote');
    expect(card.run.openai_store).toBe(false);
    expect(card.tasks).toMatchObject({ submitted: 21, kept_at_freeze: 20, dropped_unreachable: 1, kept_at_run: 5 });
    for (const form of ['paraphrase', 'exact', 'pooled']) for (const arm of ['A', 'B', 'C', 'D']) for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1']) {
      expect(card.cells[form][arm][model].counted).toBe(form === 'pooled' ? 10 : 5);
    }
  });

  test('an oracle answerer scores 1.0, grounded where it cites, and exposure shows the gold page searched and opened', () => {
    for (const arm of ['A', 'B', 'C', 'D']) expect(card.cells.paraphrase[arm]['claude-opus-5-5'].rates.correct.point).toBe(1);
    expect(card.cells.paraphrase.A['particle-1'].rates.correct_grounded).toBeNull();
    for (const arm of ['B', 'C', 'D']) expect(card.cells.paraphrase[arm]['particle-1'].rates.correct_grounded.point).toBe(1);
    expect(card.cells.paraphrase.B['gpt-6.1-sol'].exposure.gold_opened).toBe(1);
    expect(card.cells.paraphrase.C['gpt-6.1-sol'].exposure.summary_gold_cited).toBe(1);
    expect(card.comparisons.filter((c: any) => c.primary).map((c: any) => c.id).sort()).toEqual(['p1_b_vs_a_opus', 'p1_b_vs_a_particle', 'p2_c_vs_b_opus', 'p2_c_vs_b_particle']);
  });

  test('the paraphrase pass finishes before the exact pass starts', () => {
    const answers = loadRecords(join(dir, 'run', 'records.local.jsonl')).records.filter((r): r is AnswerRecord => r.kind === 'answer');
    const lastParaphrase = answers.map(a => a.form).lastIndexOf('paraphrase');
    const firstExact = answers.map(a => a.form).indexOf('exact');
    expect(firstExact).toBeGreaterThan(lastParaphrase);
  });

  test('every OpenAI request, agents and judges, sends store false; judges route by family', () => {
    const openai = providers.sent.filter(s => s.wire === 'openai');
    expect(openai.length).toBeGreaterThan(0);
    for (const s of openai) { expect(s.body.store).toBe(false); expect(s.body.previous_response_id).toBeUndefined(); }
    const judged = (wire: Wire) => providers.sent.filter(s => s.wire === wire && conversation(wire, s.body).system === JUDGE_SYSTEM);
    expect(judged('particle')).toHaveLength(0);
    const records = loadRecords(join(dir, 'run', 'records.local.jsonl')).records;
    for (const j of records) if (j.kind !== 'answer') {
      const model = j.key.split('|')[3]!;
      expect(j.judge).toBe(j.kind === 'judge' ? judgeFor(model) : 'claude-opus-5-5');
      if (j.kind === 'judge2') expect([model, j.key.split('|')[0], ['B', 'C', 'D'].includes(j.key.split('|')[2]!)]).toEqual(['particle-1', 'paraphrase', true]);
    }
  });

  test('cost: the scorecard\'s model-call total reconciles with the ledger at list prices', () => {
    const ledger = readLedger(join(dir, 'ledger.sqlite')).entries.reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0);
    expect(card.cost.ledger_usd).toBeCloseTo(ledger, 4);
    expect(card.cost.model_calls_usd).toBeCloseTo(ledger, 3);
    expect(card.cost.model_calls_usd).toBeGreaterThan(0);
  });

  test('no task form, gold fact or slug reaches the scorecard or the terminal; a numeric fact is no false positive', () => {
    const out = JSON.stringify(card) + markdown + terminal.join('\n');
    for (const needle of [CANARY_FORM, CANARY_FACT, 'projects/project-heron', tasks[0]!.forms.exact]) expect(out).not.toContain(needle);
    const needles = taskNeedles(tasks, loadRecords(join(dir, 'run', 'records.local.jsonl')).records);
    expect(needles).not.toContain('12');
    expect(needles).toContain('projects/project-heron');
    const leaked = JSON.stringify({ ...card, run: { ...card.run, window_note: 'projects/project-heron' } });
    expect(() => checkOutbound(leaked, markdown, needles)).toThrow('LR_CUSTODY_LEAK');
    expect(() => checkOutbound(JSON.stringify(card), markdown + ' ' + tasks[0]!.gold_answer.required_facts[0]!.fact, needles)).toThrow('LR_CUSTODY_LEAK');
  });

  test('score re-runs from the run directory alone and gives the same scorecard', () => {
    const again = scoreRunDir(join(dir, 'run'));
    expect(JSON.parse(readFileSync(again.scorecard, 'utf8'))).toEqual(card);
  });

  test('resume judges an answered but unjudged episode without re-answering it', async () => {
    const path = join(dir, 'run', 'records.local.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const dropped = lines.filter(l => JSON.parse(l).kind === 'judge').slice(0, 3);
    writeFileSync(path, lines.filter(l => !dropped.includes(l)).join('\n') + '\n');
    const before = providers.sent.length;
    const ledger = join(dir, 'ledger.sqlite');
    const run = BudgetRun.open({ runner: 'live-recall-phase2-resume', budgetUsd: 1, ledgerPath: ledger, programCapUsd: 100 });
    const paid: Paid = { run, guard: installPaidRequestGuard(run, { fetchImpl: providers.fetchImpl }), runner: 'live-recall-phase2-resume', capUsd: 1, ledgerPath: ledger };
    try {
      const again = await runTaskSet({
        out: join(dir, 'run'), gut, fixture: true, tasksPath, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase', 'exact'], arms: ['A', 'B', 'C', 'D'],
        models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], limit: 5, concurrency: 3, resume: true, windowNote: null, paid,
      }, () => {});
      expect(again.result).toBe('complete');
    } finally { paid.guard.uninstall(); run.close(); }
    const made = providers.sent.slice(before);
    expect(made).toHaveLength(3);
    expect(made.every(s => conversation(s.wire, s.body).system === JUDGE_SYSTEM)).toBe(true);
  }, 120_000);

  test('a counted resume without a window note, a changed task file and an unfrozen run abort with their codes', async () => {
    const paid = {} as Paid;
    const base = { out: join(dir, 'run'), gut, fixture: false, tasksPath, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A'] as any, models: ['claude-opus-5-5'], limit: null, concurrency: 1, windowNote: null, paid };
    expect(await abortCode(() => runTaskSet({ ...base, freezePath: null, resume: true }, () => {}))).toBe('LR_RESUME_NEEDS_WINDOW');
    const fresh = join(dir, 'fresh');
    expect(await abortCode(() => runTaskSet({ ...base, out: fresh, freezePath: null, resume: false }, () => {}))).toBe('LR_FREEZE_MISMATCH');
    const freezePath = join(dir, 'freeze.json');
    writeFileSync(freezePath, JSON.stringify({ schema: 'live-recall-task-freeze/v1', tasks_sha256: '0'.repeat(64) }));
    expect(await abortCode(() => runTaskSet({ ...base, out: fresh, freezePath, resume: false }, () => {}))).toBe('LR_FREEZE_MISMATCH');
  });

  test('a judge key refused while re-judging stops new judge calls and throws only after the calls in flight finish', async () => {
    const path = join(dir, 'run', 'records.local.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').trim().split('\n').filter(l => JSON.parse(l).kind === 'answer').join('\n') + '\n');
    let inFlight = 0, judgeCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/embeddings')) return providers.fetchImpl(input, init);
      if (judgeCalls++ === 0) return url.includes('anthropic.com') ? anthropicError(401, 'invalid x-api-key') : Response.json({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, { status: 401 });
      inFlight++;
      try { await new Promise(resolve => setTimeout(resolve, 300)); return await providers.fetchImpl(input, init); } finally { inFlight--; }
    }) as unknown as typeof fetch;
    const ledger = join(dir, 'ledger.sqlite');
    const run = BudgetRun.open({ runner: 'live-recall-phase2-judge', budgetUsd: 1, ledgerPath: ledger, programCapUsd: 100 });
    const paid: Paid = { run, guard: installPaidRequestGuard(run, { fetchImpl }), runner: 'live-recall-phase2-judge', capUsd: 1, ledgerPath: ledger };
    let inFlightAtThrow = -1;
    try {
      expect(await abortCode(() => judgeRunDir(join(dir, 'run'), paid, () => {}).finally(() => { inFlightAtThrow = inFlight; }))).toBe('LR_PROVIDER_REJECTED');
    } finally { paid.guard.uninstall(); run.close(); }
    expect(inFlightAtThrow).toBe(0);
    expect(judgeCalls).toBeLessThanOrEqual(TASK_CONCURRENCY);
  });

  test('a cap stop while judging pauses the run, and after an extension tasks.ts judge resumes judge-only', async () => {
    const path = join(dir, 'run', 'records.local.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').trim().split('\n').filter(l => JSON.parse(l).kind === 'answer').join('\n') + '\n');
    const ledger = join(dir, 'ledger.sqlite');
    const run = BudgetRun.open({ runner: 'live-recall-phase2-judge-cap', budgetUsd: 1e-9, ledgerPath: ledger, programCapUsd: 100 });
    const paid: Paid = { run, guard: installPaidRequestGuard(run, { fetchImpl: providers.fetchImpl }), runner: 'live-recall-phase2-judge-cap', capUsd: 1e-9, ledgerPath: ledger };
    const before = providers.sent.length;
    try {
      expect(await judgeRunDir(join(dir, 'run'), paid, () => {})).toBe(0);
      expect(existsSync(join(dir, 'run', 'cap-stop.json'))).toBe(true);
      expect(scoreRunDir(join(dir, 'run')).complete).toBe(false);
      expect(await abortCode(() => judgeRunDir(join(dir, 'run'), { ...paid, capUsd: 5 }, () => {}))).toBe('LR_CAP_STOP');
      expect(providers.sent.length).toBe(before);
      expect(await judgeRunDir(join(dir, 'run'), { ...paid, capUsd: 5 }, () => {}, 'gbev3-ext-2')).toBeGreaterThan(0);
    } finally { paid.guard.uninstall(); run.close(); }
    const made = providers.sent.slice(before);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every(s => conversation(s.wire, s.body).system === JUDGE_SYSTEM)).toBe(true);
    const scored = scoreRunDir(join(dir, 'run'));
    const card = JSON.parse(readFileSync(scored.scorecard, 'utf8'));
    expect([scored.complete, card.stop, card.run.final_cap_usd, card.run.cap_extensions]).toEqual([true, null, 5, 1]);
  });
});

// ─── Stops ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 stops (keyless)', () => {
  test('a tiny budget pauses in LR_CAP_STOP; a resume at the same cap aborts, and one past an extension finishes without re-answering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-cap-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const providers = scriptedProviders(fixtureTasks);
    const paid = scriptedPaid(dir, providers.fetchImpl, 0.5);
    const runDir = join(dir, 'run');
    const opts = { out: runDir, gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase', 'exact'] as any, arms: ['A', 'B', 'C', 'D'] as any, models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], limit: 5, concurrency: 2, windowNote: null, paid };
    const model: Record<Wire, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', particle: 'particle-1' };
    const answering = () => {
      const counts = new Map<string, number>();
      for (const s of providers.sent) {
        const c = conversation(s.wire, s.body);
        if (c.system === JUDGE_SYSTEM) continue;
        const question = c.user.startsWith('Question:\n') ? c.user.split('\n')[1]! : c.user;
        const task = fixtureTasks.find(t => t.forms.paraphrase === question || t.forms.exact === question)!;
        const arm = c.system === PROMPTS.A ? 'A' : c.system === PROMPTS.B ? 'B' : c.system === PROMPTS.D ? 'D' : 'C';
        const key = [task.forms.paraphrase === question ? 'paraphrase' : 'exact', task.id, arm, model[s.wire]].join('|');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };
    try {
      const r = await runTaskSet({ ...opts, resume: false }, () => {});
      expect(r.result).toBe('cap_stop');
      const card = JSON.parse(readFileSync(r.scorecard, 'utf8'));
      expect([card.status, card.stop]).toEqual(['incomplete', 'LR_CAP_STOP']);
      const stop = JSON.parse(readFileSync(join(runDir, 'cap-stop.json'), 'utf8'));
      const spent = readLedger(join(dir, 'ledger.sqlite')).entries.filter(e => e.run_id === paid.run.runId).reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0);
      expect(stop.cap_usd).toBe(0.5);
      expect(stop.actual_usd).toBeCloseTo(spent, 6);
      const sent = providers.sent.length;
      expect(sent).toBeGreaterThan(0);
      expect(await abortCode(() => runTaskSet({ ...opts, resume: true }, () => {}))).toBe('LR_CAP_STOP');
      expect(await abortCode(() => runTaskSet({ ...opts, resume: true, windowNote: 'gbev3-ext-1' }, () => {}))).toBe('LR_CAP_STOP');
      expect(await abortCode(() => runTaskSet({ ...opts, resume: true, paid: { ...paid, capUsd: 10 } }, () => {}))).toBe('LR_CAP_STOP');
      expect(providers.sent.length).toBe(sent);
      const finished = loadRecords(join(runDir, 'records.local.jsonl')).records.filter((a): a is AnswerRecord => a.kind === 'answer' && a.status !== 'harness_error').map(a => a.key);
      expect(finished.length).toBeGreaterThan(0);
      const before = answering();
      const resumed = await runTaskSet({ ...opts, resume: true, windowNote: 'gbev3-ext-1', paid: { ...paid, capUsd: 10 } }, () => {});
      expect(resumed.result).toBe('complete');
      const after = answering();
      for (const key of finished) expect([key, after.get(key)]).toEqual([key, before.get(key)]);
      expect(after.size).toBe(120);
      expect(existsSync(join(runDir, 'cap-stop.json'))).toBe(false);
      const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
      expect(run.budget.cap_usd).toBe(10);
      expect(run.budget.extensions).toMatchObject([{ from_usd: 0.5, to_usd: 10, window_note: 'gbev3-ext-1', cap_stop: { cap_usd: 0.5, message: stop.message } }]);
      const done = JSON.parse(readFileSync(resumed.scorecard, 'utf8'));
      expect([done.status, done.stop, done.run.budget_usd, done.run.final_cap_usd, done.run.cap_extensions]).toEqual(['complete', null, 0.5, 10, 1]);
    } finally {
      paid.guard.uninstall();
      paid.run.close({ finish: false });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test('cost sums cover every session of this run directory\'s own ledger run, never a second directory on the same ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-ledger-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const providers = scriptedProviders(fixtureTasks);
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath, programCapUsd: 100 });
    const session = async (out: string, resume: boolean) => {
      const runner = ledgerRunner(out, true);
      const item = openBudgetItem({ runner, cap_usd: 5 }, { budgetUsd: null, ledgerPath, programCapUsd: null, programCapSource: null, runId: null });
      item.guard.uninstall();
      const paid: Paid = { run: item.run, guard: installPaidRequestGuard(item.run, { fetchImpl: providers.fetchImpl }), runner, capUsd: 5, ledgerPath };
      try {
        return await runTaskSet({ out, gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'], arms: ['A'], models: ['claude-opus-5-5'], limit: 2, concurrency: 1, resume, windowNote: null, paid }, () => {});
      } finally { paid.guard.uninstall(); paid.run.close({ finish: false }); }
    };
    const one = join(dir, 'one'), two = join(dir, 'two');
    const runOf = (out: string) => JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')).budget.run_id as string;
    try {
      await session(one, false);
      const records = join(one, 'records.local.jsonl');
      writeFileSync(records, readFileSync(records, 'utf8').trim().split('\n').filter(l => JSON.parse(l).kind === 'answer').join('\n') + '\n');
      await session(two, false);
      const card = JSON.parse(readFileSync((await session(one, true)).scorecard, 'utf8'));
      expect(runOf(one)).not.toBe(runOf(two));
      const entries = readLedger(ledgerPath).entries;
      const spent = (runId: string) => entries.filter(e => e.run_id === runId).reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0);
      expect(spent(runOf(two))).toBeGreaterThan(0);
      expect(new Set(entries.filter(e => e.run_id === runOf(one)).map(e => e.participant ?? 'opener')).size).toBe(2);
      expect(card.cost.ledger_usd).toBeCloseTo(spent(runOf(one)), 4);
      expect(card.cost.other_usd).toBeCloseTo(spent(runOf(one)) - card.cost.model_calls_usd, 4);
      expect(JSON.parse(readFileSync(join(two, 'scorecard.json'), 'utf8')).cost.ledger_usd).toBeCloseTo(spent(runOf(two)), 4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);

  test('an empty answerer scores 0.0; a particle-1 answer that may have billed is excluded and never rerun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-empty-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const providers = scriptedProviders(fixtureTasks, { mode: 'empty', particleNoMessage: true });
    const paid = scriptedPaid(dir, providers.fetchImpl, 5);
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A', 'B'] as any, models: ['claude-opus-5-5', 'particle-1'], limit: 3, concurrency: 2, windowNote: null, paid };
    try {
      const r = await runTaskSet({ ...opts, resume: false }, () => {});
      const card = JSON.parse(readFileSync(r.scorecard, 'utf8'));
      expect(card.cells.paraphrase.A['claude-opus-5-5'].rates.correct.point).toBe(0);
      expect(card.cells.paraphrase.B['claude-opus-5-5'].rates.correct.point).toBe(0);
      expect(card.cells.paraphrase.A['particle-1'].excluded.timed_out).toBe(3);
      expect(card.cells.paraphrase.A['particle-1'].counted).toBe(0);
      const particleCalls = providers.sent.filter(s => s.wire === 'particle').length;
      await runTaskSet({ ...opts, resume: true }, () => {});
      expect(providers.sent.filter(s => s.wire === 'particle').length).toBe(particleCalls);
    } finally {
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('phase 2 provider errors (keyless)', () => {
  const task = fixtureTasks[0]!;
  const answer = (ctx: EpisodeContext, model: string) => runEpisode(ctx, task, 'paraphrase', 'A', model, 1);

  test('only a model-caused 400 is a counted model_error; a refused key, model or account stops the run', async () => {
    const plain = await guarded(w => (w === 'anthropic' ? anthropicError(400, 'messages.1: unexpected tool_use_id') : undefined), ctx => answer(ctx, 'claude-opus-5-5'));
    expect(plain.status).toBe('model_error');
    const credit = anthropicError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
    expect(await abortCode(() => guarded(w => (w === 'anthropic' ? credit : undefined), ctx => answer(ctx, 'claude-opus-5-5')))).toBe('LR_PROVIDER_REJECTED');
    for (const status of [401, 403, 404, 422]) {
      expect(await abortCode(() => guarded(w => (w === 'anthropic' ? anthropicError(status, 'refused') : undefined), ctx => answer(ctx, 'claude-opus-5-5')))).toBe('LR_PROVIDER_REJECTED');
    }
  });

  test('OpenAI\'s 429 insufficient_quota stops the run after the retries; a rate-limit 429 is still a harness error', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
    try {
      const quota: Failure = w => (w === 'openai' ? Response.json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }, { status: 429 }) : undefined);
      expect(await guarded(quota, async (ctx, sent) => [await abortCode(() => answer(ctx, 'gpt-6.1-sol')), sent.length])).toEqual(['LR_PROVIDER_REJECTED', 6]);
      const busy = await guarded(w => (w === 'openai' ? Response.json({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, { status: 429 }) : undefined), ctx => answer(ctx, 'gpt-6.1-sol'));
      expect(busy.status).toBe('harness_error');
    } finally { globalThis.setTimeout = realSetTimeout; }
  });

  test('a judge whose key is refused stops the run instead of recording a judge error', async () => {
    const rec = await guarded(() => undefined, ctx => answer(ctx, 'claude-opus-5-5'));
    expect(rec.status).toBe('answered');
    const refused: Failure = (w, c) => (w === 'openai' && c.system === JUDGE_SYSTEM ? Response.json({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, { status: 401 }) : undefined);
    expect(await abortCode(() => guarded(refused, ctx => judgeEpisode(ctx, task, rec, judgeFor('claude-opus-5-5'), 'judge')))).toBe('LR_PROVIDER_REJECTED');
  });

  test('a lost or unreadable request is a harness error; a particle-1 504 is timed_out and sent once', async () => {
    const lost = await guarded(w => (w === 'anthropic' ? new TypeError('fetch failed') : undefined), ctx => answer(ctx, 'claude-opus-5-5'));
    expect(lost.status).toBe('harness_error');
    const unreadable = await guarded(w => (w === 'openai' ? new Response('<html>bad gateway</html>', { status: 200 }) : undefined), ctx => answer(ctx, 'gpt-6.1-sol'));
    expect(unreadable.status).toBe('harness_error');
    const server = await guarded(w => (w === 'anthropic' ? anthropicError(501, 'not implemented') : undefined), ctx => answer(ctx, 'claude-opus-5-5'));
    expect(server.status).toBe('harness_error');
    const neverSent = await guarded(w => (w === 'particle' ? Object.assign(new Error('Unable to connect'), { code: 'ECONNREFUSED' }) : undefined), ctx => answer(ctx, 'particle-1'));
    expect(neverSent.status).toBe('harness_error');
    const gateway = await guarded(w => (w === 'particle' ? new Response('upstream timed out', { status: 504 }) : undefined), async (ctx, sent) => ({ rec: await answer(ctx, 'particle-1'), sent: sent.length }));
    expect([gateway.rec.status, gateway.sent]).toEqual(['timed_out', 1]);
  });

  test('a run stops on a refused key with no record for that episode, and --resume answers it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-rejected-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    let refuse = true;
    const { fetchImpl } = withFailures(fixtureTasks, (w, c) => (refuse && w === 'anthropic' && c.system !== JUDGE_SYSTEM ? anthropicError(401, 'invalid x-api-key') : undefined));
    const paid = scriptedPaid(dir, fetchImpl, 5);
    const records = join(dir, 'run', 'records.local.jsonl');
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A'] as any, models: ['claude-opus-5-5'], limit: 1, concurrency: 1, windowNote: null, paid };
    try {
      expect(await abortCode(() => runTaskSet({ ...opts, resume: false }, () => {}))).toBe('LR_PROVIDER_REJECTED');
      expect(loadRecords(records).records).toHaveLength(0);
      refuse = false;
      expect((await runTaskSet({ ...opts, resume: true }, () => {})).result).toBe('complete');
      expect(loadRecords(records).records.filter(r => r.kind === 'answer').map(r => [(r as AnswerRecord).status, (r as AnswerRecord).attempt])).toEqual([['answered', 1]]);
    } finally {
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test('Particle\'s own 402 stops the run with no record and --resume answers it; a metering proxy\'s 402 is still a cap stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-credit-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    let refusal: string | null = 'Insufficient credits';
    const { fetchImpl } = withFailures(fixtureTasks, w => (w === 'particle' && refusal ? Response.json({ error: { message: refusal } }, { status: 402 }) : undefined));
    const paid = scriptedPaid(dir, fetchImpl, 5);
    const records = join(dir, 'run', 'records.local.jsonl');
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A'] as any, models: ['particle-1'], limit: 1, concurrency: 1, windowNote: null, paid };
    try {
      expect(await abortCode(() => runTaskSet({ ...opts, resume: false }, () => {}))).toBe('LR_PROVIDER_REJECTED');
      expect([loadRecords(records).records.length, existsSync(join(dir, 'run', 'cap-stop.json'))]).toEqual([0, false]);
      refusal = null;
      expect((await runTaskSet({ ...opts, resume: true }, () => {})).result).toBe('complete');
      expect(loadRecords(records).records.filter(r => r.kind === 'answer').map(r => (r as AnswerRecord).status)).toEqual(['answered']);
      refusal = 'metering proxy: the lease cannot cover this request';
      expect((await runTaskSet({ ...opts, out: join(dir, 'proxy'), resume: false }, () => {})).result).toBe('cap_stop');
    } finally {
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test('a degraded episode resends the probe: a one-off failure stays degraded, one that persists stops the run unwritten and --resume answers it', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { hashEmbedVector } = await import('../../eval/runner/cat18-embedding-providers.ts');
    const dir = mkdtempSync(join(tmpdir(), 'lr2-probe-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const up = async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] });
    let failure: 'once' | 'persists' | null = 'once';
    const { fetchImpl } = withFailures(fixtureTasks, (_w, c) => {
      if (failure && c.system !== JUDGE_SYSTEM && c.results === 0) gateway.__setEmbedTransportForTests(async () => { throw new Error('embedding service down'); });
      if (failure === 'once' && c.system !== JUDGE_SYSTEM && c.results === 2) gateway.__setEmbedTransportForTests(up);
      return undefined;
    });
    const paid = scriptedPaid(dir, fetchImpl, 5);
    const answers = (run: string) => loadRecords(join(dir, run, 'records.local.jsonl')).records.filter((r): r is AnswerRecord => r.kind === 'answer').map(a => a.status);
    const opts = { gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['B'] as any, models: ['claude-opus-5-5'], limit: 1, concurrency: 1, windowNote: null, paid };
    try {
      await runTaskSet({ ...opts, out: join(dir, 'once'), resume: false }, () => {});
      expect(answers('once')).toEqual(['degraded']);
      failure = 'persists';
      expect(await abortCode(() => runTaskSet({ ...opts, out: join(dir, 'persists'), resume: false }, () => {}))).toBe('LR_EMBEDDING_UNAVAILABLE');
      expect(answers('persists')).toEqual([]);
      failure = null;
      expect((await runTaskSet({ ...opts, out: join(dir, 'persists'), resume: true }, () => {})).result).toBe('complete');
      expect(answers('persists')).toEqual(['answered']);
    } finally {
      gateway.__setEmbedTransportForTests(up);
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test('a lost request reruns; a particle-1 504 is never sent again, even on --resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-lost-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const failed = new Set<Wire>();
    let particleFirst: string | null = null;
    const { fetchImpl, sent } = withFailures(fixtureTasks, (w, c) => {
      if (c.system === JUDGE_SYSTEM) return undefined;
      if (w === 'particle') {
        particleFirst ??= c.user;
        if (c.user !== particleFirst) return new Response('upstream timed out', { status: 504 });
      }
      if (failed.has(w)) return undefined;
      failed.add(w);
      return w === 'anthropic' ? new TypeError('fetch failed') : w === 'openai' ? new Response('<html>bad gateway</html>', { status: 200 }) : Object.assign(new Error('Unable to connect'), { code: 'ECONNREFUSED' });
    });
    const paid = scriptedPaid(dir, fetchImpl, 5);
    const records = join(dir, 'run', 'records.local.jsonl');
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A'] as any, models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], limit: 2, concurrency: 1, windowNote: null, paid };
    try {
      await runTaskSet({ ...opts, resume: false }, () => {});
      const answers = loadRecords(records).records.filter((r): r is AnswerRecord => r.kind === 'answer');
      const last = new Map(answers.map(a => [a.key, a]));
      for (const model of ['claude-opus-5-5', 'gpt-6.1-sol']) {
        const lostOnce = answers.find(a => a.model === model && a.status === 'harness_error')!;
        expect(lostOnce.attempt).toBe(1);
        expect([last.get(lostOnce.key)!.status, last.get(lostOnce.key)!.attempt]).toEqual(['answered', 2]);
      }
      const particle = [...last.values()].filter(a => a.model === 'particle-1').map(a => [a.status, a.attempt]).sort();
      expect(particle).toEqual([['answered', 2], ['timed_out', 1]]);
      const particleSent = () => sent.filter(s => s.wire === 'particle').length;
      expect(particleSent()).toBe(3);
      await runTaskSet({ ...opts, resume: true }, () => {});
      expect(particleSent()).toBe(3);
    } finally {
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test('the env hatch is cleared at open, and a privacy relaxation during an episode stops the run before that episode is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-relaxed-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    process.env.GBRAIN_REMOTE_PRIVATE_PAGES = '1';
    const { fetchImpl, sent } = withFailures(fixtureTasks, () => { process.env.GBRAIN_REMOTE_PRIVATE_PAGES = '1'; return undefined; });
    const paid = scriptedPaid(dir, fetchImpl, 5);
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A'] as any, models: ['claude-opus-5-5'], limit: 2, concurrency: 1, windowNote: null, paid };
    try {
      expect(await abortCode(() => runTaskSet({ ...opts, resume: false }, () => {}))).toBe('LR_PRIVACY_RELAXED');
      expect(sent).toHaveLength(1);
      expect(loadRecords(join(dir, 'run', 'records.local.jsonl')).records).toHaveLength(0);
    } finally {
      delete process.env.GBRAIN_REMOTE_PRIVATE_PAGES;
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test('--resume refuses a session with another harness, gbrain, retrieval setting, model, arm, form or task set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-identity-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const { fetchImpl } = withFailures(fixtureTasks, () => undefined);
    const paid = scriptedPaid(dir, fetchImpl, 5);
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A'] as any, models: ['claude-opus-5-5'], limit: 2, concurrency: 1, windowNote: null, paid };
    try {
      const first = await runTaskSet({ ...opts, resume: false }, () => {});
      const runPath = join(dir, 'run', 'run.json');
      const run = JSON.parse(readFileSync(runPath, 'utf8'));
      expect(run.source_id).toBe('default');
      expect(JSON.parse(readFileSync(first.scorecard, 'utf8')).run).not.toHaveProperty('source_id');
      expect(await abortCode(() => runTaskSet({ ...opts, models: ['claude-opus-5-5', 'gpt-6.1-sol'], resume: true }, () => {}))).toBe('LR_FREEZE_MISMATCH');
      expect(await abortCode(() => runTaskSet({ ...opts, limit: 1, resume: true }, () => {}))).toBe('LR_FREEZE_MISMATCH');
      expect(await abortCode(() => runTaskSet({ ...opts, arms: ['A', 'D'] as any, resume: true }, () => {}))).toBe('LR_FREEZE_MISMATCH');
      expect(await abortCode(() => runTaskSet({ ...opts, forms: ['paraphrase', 'exact'] as any, resume: true }, () => {}))).toBe('LR_FREEZE_MISMATCH');
      expect(await abortCode(() => runTaskSet({ ...opts, resume: true }, () => {}))).toBe('no abort');
      for (const field of ['gbrain_loaded_version', 'gbrain_loaded_commit', 'schema_version', 'barrier', 'search_mode', 'reranker_enabled', 'reranker_model', 'embedding_model', 'crag_escalation', 'crag_think', 'result_cache', 'tool_defs_digest']) {
        writeFileSync(runPath, JSON.stringify({ ...run, identity: { ...run.identity, [field]: 'changed' } }));
        expect([field, await abortCode(() => runTaskSet({ ...opts, resume: true }, () => {}))]).toEqual([field, 'LR_FREEZE_MISMATCH']);
      }
      writeFileSync(runPath, JSON.stringify({ ...run, source_id: 'changed' }));
      expect(await abortCode(() => runTaskSet({ ...opts, resume: true }, () => {}))).toBe('LR_FREEZE_MISMATCH');
      writeFileSync(runPath, JSON.stringify({ ...run, identity: { ...run.identity, harness_digest: '0'.repeat(64) } }));
      expect(await abortCode(() => runTaskSet({ ...opts, resume: true }, () => {}))).toBe('LR_FREEZE_MISMATCH');
      expect(JSON.parse(readFileSync(runPath, 'utf8')).identity.harness_digest).toBe('0'.repeat(64));
    } finally {
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

// ─── Preregistration ──────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 preregistration', () => {
  test('carries every prompt, both answer tools, the verdict tool and the judge prompt verbatim', () => {
    const doc = readFileSync(join(import.meta.dir, '../../docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md'), 'utf8');
    for (const p of Object.values(PROMPTS)) expect(doc).toContain(p);
    expect(doc).toContain(JUDGE_SYSTEM);
    for (const t of [ANSWER_TOOL, SUMMARY_TOOL, VERDICT_TOOL]) expect(doc).toContain(JSON.stringify(t, null, 2));
  });
});

// ─── Estimate ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 cost estimate', () => {
  const usage = (input: number, output: number) => ({ input, output, cache_read: 0, cache_write: 0, requests: 1 });
  const smoke = (): Array<any> => {
    const out: any[] = [];
    for (const arm of ['A', 'B', 'C', 'D']) for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1']) {
      const key = ['paraphrase', 't1', arm, model].join('|');
      out.push({ kind: 'answer', key, arm, model, roles: { answer: { usage: usage(1000, 500) }, ...(arm === 'C' ? { summariser: { usage: usage(4000, 500) } } : {}) } });
      out.push({ kind: 'judge', key, usage: usage(2000, 500) });
      if (model === 'particle-1' && arm !== 'A') out.push({ kind: 'judge2', key, usage: usage(2000, 500) });
    }
    return out;
  };
  test('scales page-reading input by the page-size ratio and applies the 75% paraphrase gate', () => {
    const same = estimateCost(smoke(), 2000, 2000, 100, 2, 360);
    expect(same.page_factor).toEqual({ tool_result: 1, paste: 1, judge: 1 });
    expect(same.passed).toBe(true);
    const big = estimateCost(smoke(), 2000, 8000, 100, 2, 360);
    expect(big.page_factor).toEqual({ tool_result: 4, paste: 4, judge: 4 });
    expect(big.total_usd).toBeGreaterThan(same.total_usd);
    expect(estimateCost(smoke(), 2000, 2000, 100_000, 2, 360).passed).toBe(false);
    expect(() => estimateCost(smoke().filter(r => !(r.kind === 'answer' && r.arm === 'D')), 2000, 2000, 100, 2, 360)).toThrow('no episode for arm D');
  });
  test('spread takes tasks across the five types in turn', () => {
    expect(spread(fixtureTasks, 5).map(t => t.type)).toEqual(['identifier', 'error_string', 'time_window', 'cross_source', 'topic']);
  });
});

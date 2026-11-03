#!/usr/bin/env bun
/**
 * The Q1 shared-harness golden fixture and the measurement identity of a tree, for eval/runner/q1/reuse-check.ts.
 *
 *   bun eval/runner/q1/golden-fixture.ts <root>     prints { digest, identity } as JSON for the tree at <root>
 *
 * <root> is a checkout or a `git archive` extraction with node_modules beside it. The modules are imported from that
 * tree, so one run measures the code a commit holds. A tree from before the renderer split (008b83fe and older) has
 * no render-v2.ts or qa-v2.ts; there the renderer and the chat client still live in render.ts and qa.ts, and those
 * are read instead.
 *
 * goldenDigest hashes what decides an answer and its score without calling a provider: the renderer and tokenizer
 * ids, both reader templates, 20 packContext outputs (native and rehydrated; budgets none, 500, 2k, 8k and 32k; 3 and
 * 40 items), strictSources, 12 chat cache keys, and one full BEAM judgeAnswer call through a stub client (every prompt
 * and option it sends). Equal digests at two commits mean the shared harness packs, prompts and judges identically.
 *
 * treeIdentity reads what a reused row was measured with: the counted cells of q1-cells.json per system (selection
 * recipe, exclusions, readers, replicates, arms, launch config), the sets they report into, each canonical judge
 * instrument (id, version, judge, sha256) with its frontier instrument ids, RENDERER_VERSION, the tokenizer id, and
 * the readerCounter identity (or full-context tokenizer) of every answering arm's readers.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Mod = Record<string, any>;

/** The renderer and chat-client modules of a tree: render-v2.ts and qa-v2.ts, or render.ts and qa.ts before the split. */
async function modules(root: string): Promise<{ render: Mod; qa: Mod; instruments: Mod }> {
  const r = join(resolve(root), 'eval/runner');
  const pick = (dir: string, v2: string, v1: string) => join(r, dir, existsSync(join(r, dir, v2)) ? v2 : v1);
  return {
    render: await import(pick('systems', 'render-v2.ts', 'render.ts')),
    qa: await import(pick('memory-qa', 'qa-v2.ts', 'qa.ts')),
    instruments: await import(join(r, 'memory-qa/instruments.ts')),
  };
}

export async function goldenDigest(root: string): Promise<string> {
  const { render, qa, instruments } = await modules(root);
  const out: Record<string, unknown> = {};
  out.ids = [render.RENDERER_VERSION, render.TOKENIZER.id];
  out.templates = [render.NATIVE_READER_TEMPLATE, qa.READER_TEMPLATE];
  const mk = (i: number, len: number) => ({ id: 'chunk#' + i, rank: i + 1, type: 'chunk', text: 'lorem ipsum é 日本 '.repeat(len), source_ids: ['src-' + (i % 5)], valid_from: i % 3 ? '2024-01-0' + (i % 9 + 1) : null, valid_to: i % 4 ? null : '2024-02-01', provenance_status: 'exact' });
  const items = Array.from({ length: 40 }, (_, i) => mk(i, 10 + i * 7));
  const sess = (id: string) => ({ id, date: 'March-0' + (1 + Number(id.slice(-1))) + '-2024', turns: [{ speaker: 'user', content: 'hello '.repeat(100) }, { speaker: 'assistant', content: 'ok '.repeat(300) }] });
  const sessionOf = (s: string) => sess(s.replace('src-', 's'));
  const q = { id: 'q1', question: 'What?', question_date: 'April-01-2024', gold: ['s1'], conversation: 'c', category: 'x' };
  const packs: unknown[] = [];
  for (const mode of ['native', 'rehydrated']) for (const b of [null, 500, 2000, 8000, 32000]) for (const n of [3, 40]) packs.push(render.packContext(mode, q, items.slice(0, n), { budgetTokens: b, sessionOf, fallbackDate: 'May-01-2024' }));
  out.packs = packs;
  out.strict = render.strictSources(items, 5);
  const keys: string[] = [];
  for (const m of ['openai:gpt-4.1-mini', 'anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol', 'anthropic:claude-sonnet-5-5']) {
    for (const o of [{ maxTokens: 2048, replicate: 0 }, { maxTokens: 10, replicate: 1, temperature: null }, { maxTokens: 1024, replicate: 0, effort: 'high', system: 's' }]) keys.push(qa.chatCacheKey(m, 'p', o));
  }
  out.keys = keys;
  out.reader = qa.readerPrompt ? [typeof qa.readerPrompt] : [];
  const calls: unknown[] = [];
  const stub = { async chat(model: string, prompt: string, opts: unknown) { calls.push({ model, prompt, opts }); return { text: '{"score":1.0,"reason":"ok"}', input_tokens: 1, output_tokens: 1, cached: false, finish: 'stop', usage: null, response_model: null, attempt_errors: [] }; } };
  const bq = { id: 'b1', conversation: 'c', question: 'Q?', category: 'information_extraction', gold: [], abstention: false, answer: 'A', rubric: ['r1', 'r2'] };
  const j = await qa.judgeAnswer(stub, instruments.instrumentFor('beam-10m'), bq, 'my response', { judge: 'openai:gpt-4.1-mini', judgeReplicate: 0 });
  out.judge = { j: { ...j }, calls };
  return createHash('sha256').update(JSON.stringify(out)).digest('hex');
}

interface ArmLike { id: string; cell_id: string; set: string; arm: string; mode: string; policy: unknown; budget: unknown; variant?: string; questions: unknown; readers: string[]; reader_replicates: unknown; frontier: { judges: string[] } | null; judge_repeats: unknown }
interface CellLike { id: string; set: string; benchmark: string; split: string; selection: unknown; exclusions: unknown; system: string; configuration: string; runner: string; ingest_replicate: number; effort: string; canonical_instrument: string; probes: unknown; only_conversations?: string[]; ingest_sessions?: number; shards: number; launch?: unknown; arms: ArmLike[] }
interface SetLike { id: string; benchmark: string; split: string; selection: unknown; exclusions: unknown; only_conversations?: string[] }

export interface SystemIdentity { cells: unknown[]; sets: unknown[]; instruments: unknown[]; benchmarks: string[] }
export interface TreeIdentity { renderer: string; tokenizer: string; systems: Record<string, SystemIdentity> }

export async function treeIdentity(root: string): Promise<TreeIdentity> {
  const { render, instruments } = await modules(root);
  const m = JSON.parse(readFileSync(join(resolve(root), 'eval/runner/q1/cells/q1-cells.json'), 'utf8')) as { sets: SetLike[]; cells: CellLike[] };
  const systems: Record<string, SystemIdentity> = {};
  for (const system of [...new Set(m.cells.map(c => c.system))].sort()) {
    const cells = m.cells.filter(c => c.system === system);
    const setIds = new Set(cells.flatMap(c => [c.set, ...c.arms.map(a => a.set)]));
    systems[system] = {
      cells: cells.map(c => ({
        id: c.id, set: c.set, benchmark: c.benchmark, split: c.split, selection: c.selection, exclusions: c.exclusions, configuration: c.configuration, runner: c.runner,
        ingest_replicate: c.ingest_replicate, effort: c.effort, canonical_instrument: c.canonical_instrument, probes: c.probes, only_conversations: c.only_conversations ?? null,
        ingest_sessions: c.ingest_sessions ?? null, shards: c.shards, launch: c.launch ?? null,
        arms: c.arms.map(a => ({
          id: a.id, cell_id: a.cell_id, set: a.set, arm: a.arm, mode: a.mode, policy: a.policy, budget: a.budget, variant: a.variant ?? null, questions: a.questions, readers: a.readers,
          reader_replicates: a.reader_replicates, judge_repeats: a.judge_repeats, frontier: a.frontier ? { ...a.frontier, instrument_ids: a.frontier.judges.map(j => `${c.canonical_instrument}@${j}`) } : null,
          counter: !a.readers.length ? null : a.mode === 'packed' || a.mode === 'native-default' ? render.readerCounter(a.readers).identity : a.mode === 'full-context' ? a.readers.map(r => ({ reader: r, ...render.readerTokenizer(r) })) : null,
        })),
      })),
      sets: m.sets.filter(s => setIds.has(s.id)).map(s => ({ id: s.id, benchmark: s.benchmark, split: s.split, selection: s.selection, exclusions: s.exclusions, only_conversations: s.only_conversations ?? null })),
      instruments: [...new Set(cells.map(c => c.canonical_instrument))].sort().map(id => { const i = instruments.instrumentFor(id); return { id: i.id, version: i.version, canonical_judge: i.canonical_judge, temperature: i.temperature, sha256: i.sha256 }; }),
      benchmarks: [...new Set(cells.map(c => c.benchmark))].sort(),
    };
  }
  return { renderer: render.RENDERER_VERSION, tokenizer: render.TOKENIZER.id, systems };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error('usage: bun eval/runner/q1/golden-fixture.ts <root>'); process.exit(2); }
  console.log(JSON.stringify({ digest: await goldenDigest(root), identity: await treeIdentity(root) }));
}

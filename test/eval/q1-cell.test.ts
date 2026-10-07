/**
 * Q1 cell runner (eval/runner/q1/cell.ts), keyless end to end: the fake system
 * over protocol v1 as the gbrain-defaults and external stand-ins, a scripted
 * reader and a scripted judge, on an invented LoCoMo-shaped fixture. The
 * published cells feed `bun eval/runner/scoreboard.ts check`. Also: the file
 * agent's whole-system arm (scripted model), full context refused as
 * does_not_fit and read where it fits, whole-conversation resume, restored
 * realizations, proxy slots and phases, custody and the paid guard, the
 * generated cell manifest and the campaign manifest the front door reads.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { campaignCells, campaignManifest, cellAggregates, contextKey, publishCell, frontierInstrumentId, probeSample, realizationId, runCell, scoreboardCampaignCell, selectCellQuestions, type CellDeps, type CellResult } from '../../eval/runner/q1/cell.ts';
import { buildManifest, definitionProblems, estimateCell, loadManifest, manifestText, MANIFEST_PATH, SETS, type ArmDefinition, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatOptions, ChatResult } from '../../eval/runner/memory-qa/qa.ts';
import { answerProblems, judgmentProblems, rowProblems } from '../../eval/runner/memory-qa/records.ts';
import { FakeMemorySystem, FAKE_CAPABILITIES, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { FRONTIER_READERS, FullContextSystem } from '../../eval/runner/systems/baselines.ts';
import { FileAgentSystem } from '../../eval/runner/systems/file-agent.ts';
import type { ScriptedModel } from '../../eval/runner/cat40/loop.ts';
import { CAMPAIGN_SCHEMA, type CampaignManifest } from '../../eval/runner/scoreboard.ts';
import { loadCampaign, planWaves } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'q1-cell-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path: 'test/eval/fixtures/q1-cell/locomo-shaped.json', sha256: 'fixture' }], revision: 'repo', license: 'MIT' } };
const byText = new Map(raw.questions.map(q => [q.question, q]));
const READERS: string[] = [...FRONTIER_READERS];
const SONNET = 'anthropic:claude-sonnet-5-5';

/** Answers with the reference when the prompt carries it verbatim, else says the history does not say. */
function scriptedReader(): ChatLike & { calls: Array<{ model: string; opts: ChatOptions }> } {
  const calls: Array<{ model: string; opts: ChatOptions }> = [];
  return {
    calls,
    async chat(model, prompt, opts): Promise<ChatResult> {
      calls.push({ model, opts });
      const q = byText.get(/Question: (.*)\n/.exec(prompt)?.[1] ?? '');
      const text = q && !q.abstention && prompt.includes(q.answer!) ? `From the history: ${q.answer}.` : 'The history does not say.';
      return { text, input_tokens: Math.ceil(prompt.length / 4), output_tokens: 12, cached: false };
    },
  };
}

/** LongMemEval's verdict prompts: yes when the response contains the reference, or (abstention) declines. */
function scriptedJudge(): ChatLike & { judges: string[] } {
  const judges: string[] = [];
  return {
    judges,
    async chat(model, prompt): Promise<ChatResult> {
      judges.push(model);
      const response = /Model Response: ([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? '';
      const reference = /Correct Answer: ([\s\S]*?)\n\n/.exec(prompt)?.[1];
      const yes = reference !== undefined ? response.toLowerCase().includes(reference.toLowerCase()) : /does not say/.test(response);
      return { text: yes ? 'yes' : 'no', input_tokens: 100, output_tokens: 1, cached: false };
    },
  };
}

/** A weaker external stand-in: the fake with one item under fixed-evidence. */
class OneItemFake extends FakeMemorySystem {
  async capabilities() { const c = await super.capabilities(); return { ...c, retrieval_policies: { ...c.retrieval_policies, 'fixed-evidence': { settings: { k: 1 } } } }; }
}

function cellDef(system: string, runner: CellDefinition['runner'], arms: Array<Partial<ArmDefinition> & Pick<ArmDefinition, 'id' | 'mode'>>, extra: Partial<CellDefinition> = {}): CellDefinition {
  const id = `s3.${system}.${extra.configuration ?? 'recipe'}`;
  const base: Omit<CellDefinition, 'estimate'> = {
    schema: 'gbrain-evals/q1-cell/v1', id, set: 'S3', block: 'T2-S3', benchmark: 'locomo', split: 'dev', selection: { kind: 'all' }, exclusions: [], system, configuration: 'recipe', runner,
    ingest_replicate: 1, effort: 'medium', canonical_instrument: 'locomo', probes: { sample: 2, seed: 'test' }, shards: 1, expected_hours: 1, ...extra,
    arms: arms.map(a => ({ cell_id: `${id}.${a.id}`, set: 'S3', arm: a.mode === 'packed' ? 'component' : 'whole-system', policy: a.mode === 'packed' ? 'fixed-evidence' : a.mode === 'native-default' ? 'vendor-default' : null,
      budget: null, questions: null, readers: READERS, reader_replicates: {}, frontier: null, judge_repeats: null, label: a.id, ...a })),
  };
  return { ...base, estimate: estimateCell(base) };
}

const component = (extra: Partial<ArmDefinition> = {}) => ({ id: 'component-b8000', mode: 'packed' as const, budget: 8000, reader_replicates: { [SONNET]: 2 }, ...extra });
const ndjson = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const quiet = { probeIntervalMs: 5, probeTimeoutMs: 2000 };

describe('selection recipes', () => {
  test('per-conversation, stratified with a floor, and conversation-category are deterministic', () => {
    const per = selectCellQuestions(corpus.questions, { kind: 'per-conversation', per_conversation: 2, seed: 's' });
    expect(per).toHaveLength(6);
    expect(new Set(per.map(q => q.conversation)).size).toBe(3);
    expect(selectCellQuestions(corpus.questions, { kind: 'per-conversation', per_conversation: 2, seed: 's' }).map(q => q.id)).toEqual(per.map(q => q.id));
    const floor = selectCellQuestions(corpus.questions, { kind: 'stratified', limit: 5, stratify: 'category', seed: 's', min: { adversarial: 3 } });
    expect(floor).toHaveLength(5);
    expect(floor.filter(q => q.category === 'adversarial')).toHaveLength(3);
    const cc = selectCellQuestions(corpus.questions, { kind: 'stratified', limit: 4, stratify: 'conversation-category', seed: 's' });
    expect(new Set(cc.map(q => q.conversation)).size).toBe(3);
    expect(selectCellQuestions(corpus.questions, { kind: 'shootout-slice', limit: 4, seed: 42 })).toHaveLength(4);
  });

  test('probe sample: the last session plus a seeded sample, all of them when fewer', () => {
    const plan = Array.from({ length: 30 }, (_, i) => ({ input: { source_id: `src-${String(i).padStart(16, '0')}`, turns: [] } }));
    const s = probeSample(plan, 20, 'seed');
    expect(s.size).toBe(21);
    expect(s.get(29)).toBe('last');
    expect(probeSample(plan.slice(0, 5), 20, 'seed').size).toBe(5);
    expect([...probeSample(plan, 20, 'seed').keys()]).toEqual([...s.keys()]);
  });
});

describe('keyless end to end: two component cells into a scoreboard receipt', () => {
  const receipt = join(tmp, 'receipt');
  const servers = [serveProtocol(new FakeMemorySystem()), serveProtocol(new OneItemFake())];
  afterAll(() => servers.forEach(s => s.stop()));
  const gb = cellDef('gbrain-defaults', 'shim', [component({ anchor: true, frontier: { judges: ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'], readers: [SONNET], sample: null } })], { configuration: 'shipped-defaults' });
  const ext = cellDef('ext-markdown-kb', 'shim', [component()]);
  const results: CellResult[] = [];
  const reader = scriptedReader(), judge = scriptedJudge();

  test('each cell publishes the receipt layout the scoreboard reads', async () => {
    results.push(await runCell(gb, { out: receipt, systemUrl: servers[0].url, ...quiet }, { corpus, reader, judge }));
    results.push(await runCell(ext, { out: receipt, systemUrl: servers[1].url, ...quiet }, { corpus, reader, judge }));
    for (const r of results) {
      expect(r.status).toBe('complete');
      const dir = join(receipt, 'cells', r.arms[0].cell_id);
      for (const f of ['receipt.json', 'run-config.json', 'rows.ndjson', 'answers.ndjson', 'judgments.ndjson', 'readiness.ndjson']) expect(existsSync(join(dir, f))).toBe(true);
      const answers = ndjson(join(dir, 'answers.ndjson'));
      expect(answers).toHaveLength(15 * 5);
      for (const a of answers) expect(answerProblems(a)).toEqual([]);
      for (const j of ndjson(join(dir, 'judgments.ndjson'))) expect(judgmentProblems(j)).toEqual([]);
      for (const row of ndjson(join(dir, 'rows.ndjson'))) expect(rowProblems(row)).toEqual([]);
      const rec = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
      expect(rec.config_sha256).toBe(r.arms[0].config_sha256);
      expect(rec.ingest.messages).toBe(30);
      expect(rec.ingest.readiness_samples_ms.length).toBe(9);
      expect(rec.system.capabilities.system).toBe('fake');
      expect(ndjson(join(dir, 'readiness.ndjson')).every(x => typeof x.write_start_to_queryable_ms === 'number')).toBe(true);
    }
    expect(reader.calls.every(c => c.opts.effort === 'medium')).toBe(true);
    expect(new Set(reader.calls.map(c => c.model))).toEqual(new Set(READERS));
  });

  test('every reader reads the same frozen bytes; rows carry recall, tokens per tokenizer, fill and packing loss', () => {
    const dir = join(receipt, 'cells', gb.arms[0].cell_id);
    const answers = ndjson(join(dir, 'answers.ndjson'));
    for (const qid of new Set(answers.map(a => a.question_id))) expect(new Set(answers.filter(a => a.question_id === qid).map(a => a.context_sha256)).size).toBe(1);
    expect(answers.filter(a => a.reader === SONNET && a.question_id === 'conv-a:q000').map(a => a.replicate)).toEqual([0, 1]);
    const rows = ndjson(join(dir, 'rows.ndjson'));
    const single = rows.find(r => r.id === 'conv-a:q003');
    expect(single.recall_all_at_10).toBe(1);
    expect(single.recall_any_at_10).toBe(1);
    expect(typeof single.ndcg_at_10).toBe('number');
    expect(Object.keys(single.delivered_tokens).sort()).toEqual(['cl100k_base', 'o200k_base']);
    expect(single.fill_rate).toBeGreaterThan(0);
    expect(single.packing_loss.items_dropped).toBe(0);
    expect(single.provenance_status).toBe('exact');
    expect(single.fanout).toEqual({ mean: 1, max: 1 });
    expect(rows.find(r => r.abstention).gold_count).toBe(0);
    const contexts = ndjson(join(receipt, 'runs', gb.id, 'contexts.ndjson'));
    const rid = realizationId(gb.id, 'conv-a', 0);
    expect(contexts.some(c => c.key === contextKey(rid, 'conv-a:q003', 'component-b8000'))).toBe(true);
  });

  test('canonical judgments at replicate 0; frontier judges under their own instrument ids, Sonnet rows only', () => {
    const dir = join(receipt, 'cells', gb.arms[0].cell_id);
    const judgments = ndjson(join(dir, 'judgments.ndjson'));
    const answers = ndjson(join(dir, 'answers.ndjson'));
    const inst = instrumentFor('locomo');
    expect(judgments.filter(j => j.instrument_id === inst.id && j.judge_replicate === 0)).toHaveLength(answers.length);
    const frontier = judgments.filter(j => j.instrument_id !== inst.id);
    expect(new Set(frontier.map(j => j.instrument_id))).toEqual(new Set([frontierInstrumentId('locomo', 'anthropic:claude-opus-5-5'), frontierInstrumentId('locomo', 'openai:gpt-6.1-sol')]));
    expect(frontier).toHaveLength(15 * 2);
    expect(frontier.every(j => answers.find(a => a.answer_id === j.answer_id).reader === SONNET && answers.find(a => a.answer_id === j.answer_id).replicate === 0)).toBe(true);
  });

  test('`bun eval/runner/scoreboard.ts check` passes over a receipt made from the two cells', () => {
    const scheduled = selectCellQuestions(corpus.questions, { kind: 'all' }).map(q => ({ question_id: q.id, conversation: q.conversation }));
    const campaign: CampaignManifest = {
      schema: CAMPAIGN_SCHEMA, campaign_id: 'q1-cell-keyless', campaign_hash: 'keyless', gbrain: { commit: 'f'.repeat(40), version: 'stand-in', resolved_search_mode: 'fake' },
      measured: { from: '2026-10-06', to: '2026-10-06' }, readers: READERS, statistics: { alpha: 0.05, draws: 199, descriptive_draws: 200, seed: 7 },
      sets: [{ id: 'S3', label: 'LoCoMo-shaped fixture', benchmark: 'locomo', exposure: 'E2', role: 'headline', cluster_unit: 'conversation', claim_min_clusters: 2, scheduled, exclusions: [] }],
      cells: [scoreboardCampaignCell(gb, gb.arms[0], results[0].arms[0]), scoreboardCampaignCell(ext, ext.arms[0], results[1].arms[0])],
      families: [{ id: 'F1', label: 'fixture, component, 8,000 tokens', anchor: gb.arms[0].cell_id, comparators: [ext.arms[0].cell_id] }, { id: 'F3', label: 'fixture, recall', anchor: gb.arms[0].cell_id, comparators: [ext.arms[0].cell_id] }],
      pins: [], release_assets: [], disclosures: ['Keyless fixture: the fake system stands in for both rows; scores prove the wiring only.'], render_targets: [],
    };
    writeFileSync(join(receipt, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
    writeFileSync(join(receipt, 'power.json'), JSON.stringify({ schema: 'gbrain-evals/q1-power/v1', decision: { family1: 'full', detectable_difference_points: 20, shrunk_comparators: null } }) + '\n');
    const run = (sub: string) => Bun.spawnSync(['bun', 'eval/runner/scoreboard.ts', sub, '--receipt', receipt], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const render = run('render');
    expect(render.exitCode).toBe(0);
    const check = run('check');
    if (check.exitCode !== 0) console.error(check.stdout.toString(), check.stderr.toString());
    expect(check.exitCode).toBe(0);
    const sb = JSON.parse(readFileSync(join(receipt, 'scoreboard.json'), 'utf8'));
    const gbCell = sb.cells.find((c: { cell_id: string }) => c.cell_id === gb.arms[0].cell_id);
    const extCell = sb.cells.find((c: { cell_id: string }) => c.cell_id === ext.arms[0].cell_id);
    expect(gbCell.complete).toBe(true);
    expect(gbCell.valued).toBe(15);
    expect(gbCell.mean).toBeGreaterThan(extCell.mean);
    expect(gbCell.recall_all_at_10).toBeGreaterThan(extCell.recall_all_at_10);
  });

  test('a rerun over a finished cell calls no reader, judge or system', async () => {
    const r2 = scriptedReader(), j2 = scriptedJudge();
    const again = await runCell(ext, { out: receipt, systemUrl: servers[1].url, ...quiet }, { corpus, reader: r2, judge: j2 });
    expect(again.status).toBe('complete');
    expect(r2.calls).toHaveLength(0);
    expect(j2.judges).toHaveLength(0);
  });
});

describe('whole-system arms through the cell runner', () => {
  const STOP = new Set(['what', 'when', 'where', 'which', 'did', 'the', 'and', 'how', 'who']);
  const words = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w));
  const searcher = (q: { text: string }): ScriptedModel => history => {
    if (!history.length) return { name: 'grep', args: { pattern: `\\b(${words(q.text).join('|')})\\b`, files_only: true, ignore_case: true } };
    const hits = history[0].result === 'No matches.' ? [] : history[0].result.split('\n').filter(Boolean);
    const read = history.length - 1;
    if (read < hits.length) return { name: 'read_file', args: { path: hits[read] } };
    return { name: 'submit_answer', args: { answer: hits.length ? `From the sessions: ${history.slice(1).map(h => h.result).join(' | ')}` : 'The history does not say.' } };
  };

  test('file agent (scripted): one answer per reader, evidence opened mapped evaluator-side, judged', async () => {
    const def = cellDef('baseline-file-agent', 'in-process', [{ id: 'whole-agent', mode: 'agent' }], { configuration: 'baseline' });
    const out = join(tmp, 'agent');
    const res = await runCell(def, { out, ...quiet }, { corpus, system: new FileAgentSystem({ workDir: join(out, 'trees'), scripted: searcher }), judge: scriptedJudge() });
    expect(res.status).toBe('complete');
    const dir = join(out, 'cells', def.arms[0].cell_id);
    const answers = ndjson(join(dir, 'answers.ndjson'));
    expect(answers).toHaveLength(15 * 4);
    const vet = answers.find(a => a.question_id === 'conv-a:q003' && a.reader === READERS[0]);
    expect(vet.outcome).toBe('scored');
    expect(vet.stop_reason).toBe('submitted');
    expect(vet.opened_source_ids).toContain('session_2');
    const row = ndjson(join(dir, 'rows.ndjson')).find(r => r.id === 'conv-a:q003');
    expect(row.evidence_opened[READERS[0]]).toBe(1);
    expect(row.recall_measurable).toBe(false);
    expect(ndjson(join(dir, 'judgments.ndjson')).length).toBe(answers.length);
    const rec = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
    expect(rec.ingest.write_start_to_queryable_ms.not_measurable).toBeGreaterThan(0);
  });

  test('full context: a history over the window is does_not_fit, never judged', async () => {
    const def = cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context' }], { configuration: 'baseline' });
    const out = join(tmp, 'full-no-fit');
    let calls = 0;
    const res = await runCell(def, { out, ...quiet }, { corpus, system: new FullContextSystem('whole-history'), judge: scriptedJudge(), fitTokenizer: () => ({ id: 'huge', count: () => 2_000_000 }), fullContextFetch: (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch });
    expect(res.status).toBe('complete');
    const dir = join(out, 'cells', def.arms[0].cell_id);
    const answers = ndjson(join(dir, 'answers.ndjson'));
    expect(answers).toHaveLength(60);
    expect(answers.every(a => a.outcome === 'does_not_fit' && a.text === '')).toBe(true);
    expect(ndjson(join(dir, 'judgments.ndjson'))).toHaveLength(0);
    expect(calls).toBe(0);
    expect(ndjson(join(dir, 'rows.ndjson'))[0].fit[READERS[0]].fits).toBe(false);
  });

  test('full context: a history that fits is read whole, cached per conversation, and judged', async () => {
    const def = cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context' }], { configuration: 'baseline' });
    const out = join(tmp, 'full-fit');
    const keys = new Set<string>();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const prompt = body.messages[0].content;
      const text = typeof prompt === 'string' ? prompt : prompt.map((p: { text: string }) => p.text).join('');
      const q = byText.get(/Question: (.*)\n/.exec(text)?.[1] ?? '')!;
      const answer = !q.abstention && text.includes(q.answer!) ? q.answer! : 'The history does not say.';
      if (body.prompt_cache_key) keys.add(body.prompt_cache_key);
      return Response.json(String(url).includes('anthropic') ? { content: [{ type: 'text', text: answer }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 500 } } : { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 510, completion_tokens: 3 } });
    }) as unknown as typeof fetch;
    const res = await runCell(def, { out, ...quiet }, { corpus, system: new FullContextSystem('whole-history'), judge: scriptedJudge(), fullContextFetch: fetchImpl });
    expect(res.status).toBe('complete');
    const answers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
    expect(answers.every(a => a.outcome === 'scored')).toBe(true);
    expect(answers.find(a => a.question_id === 'conv-b:q003').text).toBe('green');
    expect(keys.size).toBe(3);
    const rec = JSON.parse(readFileSync(join(out, 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8'));
    expect(rec.per_reader_mean[READERS[0]]).toBe(1);
  });
});

describe('resume', () => {
  test('a killed in-process cell re-ingests every conversation with pending store work as a new realization; nothing is duplicated', async () => {
    const def = cellDef('baseline-recency', 'in-process', [component({ reader_replicates: {} })], { configuration: 'baseline' });
    const out = join(tmp, 'resume');
    const first = await runCell(def, { out, stopAfterQuestions: 3, ...quiet }, { corpus, system: new FullContextSystem('recency'), reader: scriptedReader(), judge: scriptedJudge() });
    expect(first.status).toBe('partial');
    expect(first.stopped).toMatch(/simulated kill/);
    expect(existsSync(join(out, 'ingest-complete'))).toBe(true);
    const reader = scriptedReader();
    const second = await runCell(def, { out, ...quiet }, { corpus, system: new FullContextSystem('recency'), reader, judge: scriptedJudge() });
    expect(second.status).toBe('complete');
    const events = ndjson(join(out, 'runs', def.id, 'realizations.ndjson'));
    expect(events.filter(e => e.event === 'invalidated').map(e => e.conversation).sort()).toEqual(['conv-a', 'conv-b', 'conv-c']);
    const answers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
    expect(answers).toHaveLength(60);
    expect(new Set(answers.map(a => a.answer_id)).size).toBe(60);
    expect(new Set(answers.map(a => a.realization_id))).toEqual(new Set(['conv-a', 'conv-b', 'conv-c'].map(c => realizationId(def.id, c, 1))));
    expect(reader.calls).toHaveLength(60);
  });

  test('with a restored realization nothing is re-ingested and only missing answers are read', async () => {
    const fake = new FakeMemorySystem();
    let ingests = 0;
    const ingest = fake.ingestSession.bind(fake);
    fake.ingestSession = async (ns, s, t) => { ingests++; return ingest(ns, s, t); };
    const server = serveProtocol(fake);
    try {
      const def = cellDef('ext-verbatim-session', 'shim', [component({ reader_replicates: {} })]);
      const out = join(tmp, 'restored');
      await runCell(def, { out, systemUrl: server.url, stopAfterQuestions: 7, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      expect(ingests).toBe(15);
      const reader = scriptedReader();
      const res = await runCell(def, { out, systemUrl: server.url, env: { ...process.env, SHOOTOUT_RESTORED_REALIZATION: 'real-test-0123' }, ...quiet }, { corpus, reader, judge: scriptedJudge() });
      expect(res.status).toBe('complete');
      expect(ingests).toBe(15);
      expect(reader.calls).toHaveLength((15 - 7) * 4);
      const events = ndjson(join(out, 'runs', def.id, 'realizations.ndjson'));
      expect(events.some(e => e.event === 'invalidated')).toBe(false);
    } finally { server.stop(); }
  });
});

describe('store snapshot handshake', () => {
  test('a shim cell waits for the launcher\'s realization after ingest-complete before any question; no snapshot in time refuses', async () => {
    const fake = new FakeMemorySystem();
    const events: string[] = [];
    const retrieve = fake.retrieve.bind(fake);
    fake.retrieve = async (ns, q, p) => { if (!events.includes('retrieve-after-ingest') && events.includes('ingest-complete')) events.push('retrieve-after-ingest'); return retrieve(ns, q, p); };
    const server = serveProtocol(fake);
    try {
      const def = cellDef('ext-verbatim-session', 'shim', [component({ reader_replicates: {} })]);
      const out = join(tmp, 'snap');
      const shootoutOut = join(tmp, 'snap-vm');
      mkdirSync(shootoutOut, { recursive: true });
      const env = { ...process.env, SHOOTOUT_OUT: shootoutOut, SHOOTOUT_SNAPSHOT_DIR: join(shootoutOut, 'realization', 'snapshot') };
      const launcher = (async () => {
        while (!existsSync(join(shootoutOut, 'ingest-complete'))) await Bun.sleep(5);
        events.push('ingest-complete');
        await Bun.sleep(200);
        mkdirSync(join(shootoutOut, 'realization'), { recursive: true });
        events.push('realization');
        writeFileSync(join(shootoutOut, 'realization', 'realization.json'), '{}');
      })();
      const res = await runCell(def, { out, systemUrl: server.url, env, probeIntervalMs: 5, probeTimeoutMs: 2000 }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      await launcher;
      expect(res.status).toBe('complete');
      expect(events).toEqual(['ingest-complete', 'realization', 'retrieve-after-ingest']);
      const late = join(tmp, 'snap-late');
      mkdirSync(late, { recursive: true });
      const err = await runCell(def, { out: join(tmp, 'snap-late-out'), systemUrl: server.url, env: { ...process.env, SHOOTOUT_OUT: late, SHOOTOUT_SNAPSHOT_DIR: join(late, 'realization', 'snapshot') }, snapshotTimeoutMs: 50, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() }).catch(e => e) as ScoreboardError;
      expect(err.op.code).toBe('NOT_YET_AVAILABLE');
      expect(err.op.message).toContain('no store snapshot');
    } finally { server.stop(); }
  });
});

describe('shards and aggregates', () => {
  test('two conversation shards merge into one scoreboard cell; aggregates carry no ids or text', async () => {
    const server = serveProtocol(new FakeMemorySystem());
    try {
      const def = cellDef('ext-memory-bank', 'shim', [component({ reader_replicates: {} })]);
      const a = await runCell(def, { out: join(tmp, 'shard0'), systemUrl: server.url, shard: { index: 0, count: 2 }, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      await runCell(def, { out: join(tmp, 'shard1'), systemUrl: server.url, shard: { index: 1, count: 2 }, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      expect(a.arms[0].answers).toBe(10 * 4);
      const merged = publishCell(def, def.arms, [join(tmp, 'shard0'), join(tmp, 'shard1')], join(tmp, 'merged'), { instrument: instrumentFor('locomo'), selected: selectCellQuestions(corpus.questions, { kind: 'all' }), invalidReasons: [],
        configs: new Map([[def.arms[0].id, { text: readFileSync(join(tmp, 'shard0', 'cells', def.arms[0].cell_id, 'run-config.json'), 'utf8'), sha: a.arms[0].config_sha256 }]]), capabilities: FAKE_CAPABILITIES, stopped: null, maxAttempts: 3 });
      expect(merged[0].status).toBe('complete');
      expect(merged[0].answers).toBe(15 * 4);
      expect(readFileSync(join(tmp, 'shard1', 'cells', def.arms[0].cell_id, 'run-config.json'), 'utf8')).toBe(readFileSync(join(tmp, 'shard0', 'cells', def.arms[0].cell_id, 'run-config.json'), 'utf8'));
      const agg = JSON.stringify(cellAggregates(merged));
      expect(agg).not.toContain('conv-a');
      expect(agg).not.toContain('From the history');
      expect(agg).toContain('"answers":60');
    } finally { server.stop(); }
  });
});

describe('metering through a lease proxy', () => {
  test('readers on the harness slot, judges on the judge slot, the cell token as the key, ingest and query phases on the system slot', async () => {
    const control: Array<{ path: string; body: Record<string, unknown> }> = [];
    const provider: Array<{ path: string; key: string | null }> = [];
    const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/__proxy/')) {
        const body = await req.json() as Record<string, unknown>;
        control.push({ path, body });
        return Response.json(path === '/__proxy/finalize' ? { usd: 0.001, requests: 1, unpriced: 0, byModel: {} } : { ok: true });
      }
      provider.push({ path, key: req.headers.get('x-api-key') ?? req.headers.get('authorization') });
      const body = await req.json() as { messages: Array<{ content: string }> };
      void body;
      const text = path.startsWith('/judge/') ? 'yes' : 'From the history: something.';
      return Response.json(path.includes('/anthropic/') ? { content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 2 } } : { choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    } });
    const saved = { ...process.env };
    process.env.SHOOTOUT_CELL_TOKEN = 'cell-token-test';
    process.env.GBRAIN_EVALS_QA_CACHE = join(tmp, 'qa-cache-proxy');
    try {
      const def = cellDef('ext-graph-pipeline', 'shim', [component({ reader_replicates: {} })], { selection: { kind: 'shootout-slice', limit: 2, seed: 42 } });
      const out = join(tmp, 'proxied');
      const res = await runCell(def, { out, providerProxy: `http://127.0.0.1:${proxy.port}`, ...quiet }, { corpus, system: new FakeMemorySystem() });
      expect(res.status).toBe('complete');
      const readerCalls = provider.filter(p => p.path.startsWith('/harness/'));
      const judgeCalls = provider.filter(p => p.path.startsWith('/judge/'));
      expect(readerCalls).toHaveLength(2 * 4);
      expect(judgeCalls.length).toBeGreaterThanOrEqual(2);
      expect(ndjson(join(out, 'cells', def.arms[0].cell_id, 'judgments.ndjson'))).toHaveLength(2 * 4);
      expect(provider.every(p => p.key?.includes('cell-token-test'))).toBe(true);
      const phases = control.filter(c => c.path === '/__proxy/phase').map(c => `${c.body.slot}:${c.body.phase}`);
      expect(phases).toContain('fake:commit');
      expect(phases).toContain('fake:background');
      expect(phases).toContain('fake:query');
      const binds = control.filter(c => c.path === '/__proxy/bind').map(c => String(c.body.slot));
      expect(new Set(binds)).toEqual(new Set(['fake', 'harness', 'judge']));
      const rec = JSON.parse(readFileSync(join(out, 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8'));
      expect(rec.spend.usd.judge).toBeGreaterThan(0);
      expect(rec.spend.usd.reader).toBeGreaterThan(0);
      expect(rec.spend.usd.ingest).toBeGreaterThan(0);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      proxy.stop(true);
    }
  });
});

describe('custody and the paid guard', () => {
  const sealed = buildManifest().cells.find(c => c.id === 's2b.baseline-none.baseline')!;

  test('a sealed cell refuses without the custodian log, then an output inside the repository', async () => {
    const err = await runCell(sealed, { out: join(tmp, 'sealed'), env: { PATH: process.env.PATH } }).catch(e => e);
    expect(err).toBeInstanceOf(ScoreboardError);
    expect((err as ScoreboardError).op.code).toBe('CUSTODY_REQUIRED');
    const log = join(tmp, 'custody.log');
    const inside = await runCell(sealed, { out: join(ROOT, 'eval/reports/q1-sealed-test'), env: { PATH: process.env.PATH, GBRAIN_EVALS_CUSTODY_LOG: log } }).catch(e => e);
    expect((inside as ScoreboardError).op.code).toBe('SEALED_CELL_LOCAL');
    expect(existsSync(log)).toBe(false);
  });

  test('`run` without --paid refuses with an operator message that asks the user', () => {
    const env = { ...process.env };
    delete env.SHOOTOUT_PROXY;
    const r = Bun.spawnSync(['bun', 'eval/runner/q1/cell.ts', 'run', '--cell', 's3.baseline-none.baseline', '--limit', '2', '--budget-ledger', join(tmp, 'ledger.sqlite'), '--out', join(tmp, 'unpaid')], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(3);
    const err = r.stderr.toString();
    expect(err).toContain('[PAID_FLAGS_MISSING]');
    expect(err).toContain('--paid');
    expect(err).toContain('next: ask the user');
    expect(existsSync(join(tmp, 'unpaid'))).toBe(false);
  });

  test('own-answer arms without an answer route refuse and name the runnable arms', async () => {
    const def = cellDef('gbrain-defaults', 'shim', [component(), { id: 'whole-think', mode: 'own-answer', variant: 'think' }], { configuration: 'shipped-defaults' });
    const err = await runCell(def, { out: join(tmp, 'own') }, { corpus, system: new FakeMemorySystem(), reader: scriptedReader(), judge: scriptedJudge() }).catch(e => e);
    expect((err as ScoreboardError).op.code).toBe('NOT_YET_AVAILABLE');
    expect((err as ScoreboardError).op.fix.argv).toContain('component-b8000');
  });
});

describe('own-answer arms through the answer route (POST /answer)', () => {
  /** A stand-in gbrain-defaults stack: the fake system over protocol v1 plus /answer, answering with the fixture's reference. */
  function answerStack(opts: { modes: string[]; model?: string; reportModel?: string; degraded?: string | null }) {
    const fake = serveProtocol(new FakeMemorySystem());
    const requests: Array<Record<string, any>> = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: async req => {
      const path = new URL(req.url).pathname;
      if (path === '/answer') {
        const body = await req.json() as Record<string, any>;
        requests.push(body);
        if (!opts.modes.includes(body.mode)) return Response.json({ error: { kind: 'unsupported', message: `${body.mode} is not served` }, service_ms: 0.1 }, { status: 501 });
        const q = byText.get(body.question);
        const text = q && !q.abstention ? `It was ${q.answer}.` : 'The history does not say.';
        return Response.json({ answer: text, outcome: 'scored', degraded: opts.degraded ?? null, source_ids: [], model: body.model ?? opts.reportModel ?? opts.model, usage: { input: 900, output: 40 }, usd: 0.0055, service_ms: 812.4 });
      }
      const res = await fetch(`${fake.url}${path}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? await req.text() : undefined, keepalive: false });
      const json = await res.json() as Record<string, unknown>;
      if (path === '/capabilities') Object.assign(json, { system: 'gbrain-defaults', answer: { modes: opts.modes, ...(opts.model ? { models: { synthesize: opts.model } } : {}) } });
      return Response.json(json, { status: res.status });
    } });
    return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => { server.stop(true); fake.stop(); } };
  }
  const synth = { id: 'whole-synthesize', mode: 'own-answer' as const, variant: 'synthesize' as const, readers: ['system-default'] };
  const think = { id: 'whole-think', mode: 'own-answer' as const, variant: 'think' as const };
  const OWN = 'own:anthropic:claude-opus-4-7';

  test('synthesize records gbrain\'s own model as the reader; think reads with each frontier reader as model; both are judged', async () => {
    const stack = answerStack({ modes: ['synthesize', 'think'], model: 'anthropic:claude-opus-4-7' });
    try {
      const def = cellDef('gbrain-defaults', 'shim', [synth, think], { configuration: 'full-surface' });
      const out = join(tmp, 'own-answer');
      const res = await runCell(def, { out, systemUrl: stack.url, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      expect(res.status).toBe('complete');
      const synthAnswers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
      expect(synthAnswers).toHaveLength(corpus.questions.length);
      for (const a of synthAnswers) expect(answerProblems(a)).toEqual([]);
      expect(synthAnswers.every(a => a.reader === OWN && a.effort === null && a.outcome === 'scored' && a.usd === 0.0055 && a.usage.input === 900)).toBe(true);
      const vet = corpus.questions.find(q => !q.abstention)!;
      expect(synthAnswers.find(a => a.question_id === vet.id).text).toBe(`It was ${vet.answer}.`);
      const thinkAnswers = ndjson(join(out, 'cells', def.arms[1].cell_id, 'answers.ndjson'));
      expect(thinkAnswers).toHaveLength(corpus.questions.length * READERS.length);
      expect(new Set(thinkAnswers.map(a => a.reader))).toEqual(new Set(READERS));
      expect(stack.requests.filter(r => r.mode === 'synthesize').every(r => r.model === undefined)).toBe(true);
      expect(new Set(stack.requests.filter(r => r.mode === 'think').map(r => r.model))).toEqual(new Set(READERS));
      expect(stack.requests.every(r => /^ns-[0-9a-f]{16}$/.test(r.ns))).toBe(true);
      const judgments = ndjson(join(out, 'cells', def.arms[0].cell_id, 'judgments.ndjson'));
      expect(judgments).toHaveLength(synthAnswers.length);
      const receipt = JSON.parse(readFileSync(join(out, 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8'));
      expect(receipt.readers).toEqual([OWN]);
      expect(res.arms[0].readers).toEqual([OWN]);
      expect(scoreboardCampaignCell(def, def.arms[0], res.arms[0]).readers).toEqual([OWN]);
      const before = stack.requests.length;
      await runCell(def, { out, systemUrl: stack.url, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      expect(stack.requests.length).toBe(before);
    } finally { stack.stop(); }
  });

  test('a starter-only stack refuses think and names GBRAIN_FULL_SURFACE=1; synthesize without a resolved model refuses', async () => {
    const starter = answerStack({ modes: ['synthesize'], model: 'anthropic:claude-opus-4-7' });
    const unresolved = answerStack({ modes: ['synthesize'] });
    try {
      const def = cellDef('gbrain-defaults', 'shim', [component(), synth, think], { configuration: 'shipped-defaults' });
      const err = await runCell(def, { out: join(tmp, 'own-starter'), systemUrl: starter.url, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() }).catch(e => e) as ScoreboardError;
      expect(err.op.code).toBe('NOT_YET_AVAILABLE');
      expect(err.op.message).toContain('whole-think needs answer mode think');
      expect(err.op.fix.argv?.join(' ')).toContain('GBRAIN_FULL_SURFACE=1 bash eval/systems/bootstrap.sh up --system gbrain-defaults');
      const err2 = await runCell(cellDef('gbrain-defaults', 'shim', [synth], { configuration: 'shipped-defaults' }), { out: join(tmp, 'own-unresolved'), systemUrl: unresolved.url, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() }).catch(e => e) as ScoreboardError;
      expect(err2.op.code).toBe('NOT_YET_AVAILABLE');
      expect(err2.op.message).toContain('answer.models.synthesize');
      expect(starter.requests).toEqual([]);
    } finally { starter.stop(); unresolved.stop(); }
  });

  test('an extractive fallback is scored with its stop reason; an answer from another model than the resolved one is a harness failure', async () => {
    const degraded = answerStack({ modes: ['synthesize'], model: 'anthropic:claude-opus-4-7', degraded: 'extractive_fallback' });
    const drift = answerStack({ modes: ['synthesize'], model: 'anthropic:claude-opus-4-7', reportModel: 'anthropic:claude-sonnet-4-6' });
    try {
      const def = cellDef('gbrain-defaults', 'shim', [synth], { configuration: 'shipped-defaults' });
      await runCell(def, { out: join(tmp, 'own-degraded'), systemUrl: degraded.url, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      const a = ndjson(join(tmp, 'own-degraded', 'cells', def.arms[0].cell_id, 'answers.ndjson'));
      expect(a.every(x => x.outcome === 'scored' && x.stop_reason === 'extractive_fallback')).toBe(true);
      await runCell(def, { out: join(tmp, 'own-drift'), systemUrl: drift.url, maxAttempts: 2, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      const b = ndjson(join(tmp, 'own-drift', 'cells', def.arms[0].cell_id, 'answers.ndjson'));
      expect(b.every(x => x.outcome === 'harness_invalid')).toBe(true);
      expect(ndjson(join(tmp, 'own-drift', 'cells', def.arms[0].cell_id, 'judgments.ndjson'))).toEqual([]);
    } finally { degraded.stop(); drift.stop(); }
  });
});

describe('the generated cell manifest', () => {
  const m = loadManifest();
  const kinds = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));

  test('q1-cells.json is current and every definition is valid', () => {
    expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(manifestText());
    for (const c of m.cells) expect([c.id, definitionProblems(c, kinds)]).toEqual([c.id, []]);
    expect(new Set(m.cells.flatMap(c => c.arms.map(a => a.cell_id))).size).toBe(m.cells.reduce((s, c) => s + c.arms.length, 0));
  });

  test('the preregistered cells are there: S1 component 8k over ten systems with Sonnet replicates, the sweep subset, whole-system rows', () => {
    const s1 = m.cells.filter(c => c.set === 'S1');
    const comp8 = s1.flatMap(c => c.arms.filter(a => a.mode === 'packed' && a.budget === 8000));
    expect(comp8).toHaveLength(10);
    expect(comp8.every(a => a.reader_replicates[SONNET] === 3 && a.readers.length === 4)).toBe(true);
    const sweep = s1.flatMap(c => c.arms.filter(a => a.set === 'S1-sweep'));
    expect(sweep).toHaveLength(20);
    expect(sweep.every(a => a.questions?.kind === 'stratified')).toBe(true);
    expect(s1.flatMap(c => c.arms.map(a => a.mode))).toEqual(expect.arrayContaining(['native-default', 'own-answer', 'agent', 'full-context']));
    expect(s1.find(c => c.system === 'ext-temporal-graph')!.configuration).toBe('common');
    expect(m.cells.find(c => c.set === 'S3' && c.system === 'ext-temporal-graph' && c.ingest_replicate === 1 && c.configuration === 'recipe')).toBeDefined();
    expect(m.cells.filter(c => c.set === 'S3' && c.ingest_replicate === 2)).toHaveLength(8);
    expect(m.cells.find(c => c.set === 'S2b' && c.configuration === 'common-embedder')).toBeDefined();
    expect(m.cells.find(c => c.set === 'S4')!.arms.map(a => [a.set, a.readers.length])).toEqual([['S4', 1], ['S4-slice', 4]]);
    expect(SETS.S1.exclusions[0].question_id).toBe('10m-1:abstention:0');
    for (const c of m.cells) for (const a of c.arms) for (const r of a.readers) if (r !== 'system-default') expect(READERS).toContain(r);
  });

  test('own-answer arms: synthesize in the S1 and S2 starter cells, think in full-surface cells started with GBRAIN_FULL_SURFACE=1', () => {
    for (const set of ['S1', 'S2a', 'S2b'] as const) {
      const starter = m.cells.find(c => c.set === set && c.system === 'gbrain-defaults' && c.configuration === 'shipped-defaults')!;
      expect(starter.arms.find(a => a.id === 'whole-synthesize')).toMatchObject({ mode: 'own-answer', variant: 'synthesize', readers: ['system-default'] });
      expect(starter.arms.some(a => a.variant === 'think')).toBe(false);
      expect(starter.launch).toEqual({ env: {}, config: 'recipe' });
    }
    for (const set of ['S1', 'S2a', 'S2b', 'S3'] as const) {
      const full = m.cells.find(c => c.set === set && c.system === 'gbrain-defaults' && c.configuration === 'full-surface')!;
      expect(full.arms.map(a => [a.id, a.variant, a.readers.length])).toEqual([['whole-think', 'think', 4]]);
      expect(full.launch).toEqual({ env: { GBRAIN_FULL_SURFACE: '1' }, config: 'recipe' });
      expect(full.snapshot_command).toStartWith('GBRAIN_FULL_SURFACE=1 bash eval/systems/bootstrap.sh snapshot --system gbrain-defaults');
    }
    expect(m.cells.filter(c => c.arms.some(a => a.variant === 'think') && c.configuration !== 'full-surface')).toEqual([]);
  });

  test('every shim cell carries snapshot and restore commands on the launcher\'s directories; the campaign cells pass them through', () => {
    const shims = m.cells.filter(c => c.runner === 'shim');
    expect(shims.length).toBeGreaterThan(20);
    for (const c of shims) {
      expect(c.snapshot_command).toContain(`bash eval/systems/bootstrap.sh snapshot --system ${c.system} --out "$SHOOTOUT_SNAPSHOT_DIR/${c.system}.tar"`);
      expect(c.restore_command).toContain(`bash eval/systems/bootstrap.sh restore --system ${c.system} --config ${c.launch!.config} --from "$SHOOTOUT_RESTORE_DIR/${c.system}.tar"`);
    }
    expect(m.cells.filter(c => c.runner === 'in-process' && (c.snapshot_command || c.restore_command))).toEqual([]);
    const specs = campaignCells(m);
    for (const spec of specs) {
      const c = m.cells.find(x => spec.id === x.id || spec.id.startsWith(`${x.id}.c`))!;
      expect([spec.id, spec.snapshot_command, spec.restore_command]).toEqual([spec.id, c.snapshot_command, c.restore_command]);
    }
    const full = specs.find(x => x.id === 's2b.gbrain-defaults.full-surface')!;
    expect(full.command).toStartWith('GBRAIN_FULL_SURFACE=1 bash eval/systems/bootstrap.sh up --system gbrain-defaults --config recipe && ');
  });

  test('estimates come from ledger prices and stay under the cap; blocks carry 1.5x hard caps', () => {
    expect(m.total_usd).toBeLessThan(m.cap_usd);
    for (const b of m.blocks) expect(b.cap_usd).toBeCloseTo(b.estimate_usd * 1.5, 1);
    const gb8 = m.cells.find(c => c.id === 's1.baseline-none.baseline')!;
    expect(gb8.estimate.lines.readers).toBeGreaterThan(0);
    expect(m.prices['anthropic:claude-fable-5-1'].input).toBe(10);
  });

  test('the campaign manifest loads in the shootout campaign loader and the front door plans its waves', () => {
    const path = join(tmp, 'campaign.json');
    writeFileSync(path, JSON.stringify(campaignManifest(m), null, 2) + '\n');
    const loaded = loadCampaign(path);
    expect(loaded.manifest.kind).toBe('q1-scoreboard-campaign');
    const units = campaignCells(m);
    expect(units.filter(u => u.id.startsWith('s1.gbrain-defaults.shipped-defaults.c'))).toHaveLength(10);
    const waves = planWaves(loaded.manifest);
    const t1 = new Set(units.filter(u => u.block === 'T1').map(u => u.wave!));
    expect(Math.max(...t1)).toBeLessThan(Math.min(...units.filter(u => u.block !== 'T1').map(u => u.wave!)));
    expect(waves.length).toBeGreaterThanOrEqual(t1.size + 4);
    expect(units.every(u => u.lease_usd > 0 && u.command.includes('eval/runner/q1/cell.ts run --cell'))).toBe(true);
    expect(units.filter(u => u.sealed).every(u => ['beam-10m', 'beam-100k', 'beam-1m', 'locomo'].includes(u.benchmark))).toBe(true);
    const fd = Bun.spawnSync(['bun', 'eval/runner/scoreboard-cli.ts', 'plan', '--campaign', path, '--json'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(fd.exitCode).toBe(0);
    expect(JSON.parse(fd.stdout.toString()).cells).toHaveLength(units.length);
    mkdirSync(join(tmp, 'x'), { recursive: true });
  });
});

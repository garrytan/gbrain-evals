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
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { campaignCells, campaignManifest, cellAggregates, contextKey, publishCell, frontierInstrumentId, probeSample, realizationId, runCell, scoreboardCampaignCell, selectCellQuestions, type CellDeps, type CellOptions, type CellResult } from '../../eval/runner/q1/cell.ts';
import { buildManifest, definitionProblems, estimateCell, loadManifest, manifestText, MANIFEST_PATH, SETS, type ArmDefinition, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { classifyV2, CLASSIFIER_VERSION_V2, RULES_SHA256_V2 } from '../../eval/runner/q1/hedge.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { ChatClient, type ChatLike, type ChatOptions, type ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { answerProblems, judgmentProblems, rowProblems } from '../../eval/runner/memory-qa/records.ts';
import { FakeMemorySystem, FAKE_CAPABILITIES, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { FRONTIER_READERS, FullContextSystem } from '../../eval/runner/systems/baselines.ts';
import { FileAgentSystem } from '../../eval/runner/systems/file-agent.ts';
import { BudgetExceededError, BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import type { ScriptedModel } from '../../eval/runner/cat40/loop.ts';
import { CAMPAIGN_SCHEMA, type CampaignManifest } from '../../eval/runner/scoreboard.ts';

const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
import { Campaign, DEFAULT_ROUTE_CLASSES, loadCampaign, planWaves } from '../../eval/runner/shootout-cell.ts';

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
      return { text, input_tokens: Math.ceil(prompt.length / 4), output_tokens: 12, cached: false, ...NO_META };
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
      return { text: yes ? 'yes' : 'no', input_tokens: 100, output_tokens: 1, cached: false, ...NO_META };
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
      expect(answers).toHaveLength(15 * 4);
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

  test('judged answers carry the packed context\'s per-tokenizer counts and no hedge verdict (the scoreboard computes it at render time)', () => {
    const dir = join(receipt, 'cells', gb.arms[0].cell_id);
    const answers = ndjson(join(dir, 'answers.ndjson'));
    const rows = new Map(ndjson(join(dir, 'rows.ndjson')).map(r => [r.id, r]));
    for (const a of answers) {
      expect(a.hedge).toBeUndefined();
      expect(a.delivered_tokens).toEqual(rows.get(a.question_id).delivered_tokens);
    }
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
      schema: CAMPAIGN_SCHEMA, campaign_id: 'q1-cell-keyless', campaign_hash: 'keyless', gbrain: { commit: 'f'.repeat(40), version: 'stand-in', date: '2026-10-06', resolved_search_mode: 'fake' },
      measured: { from: '2026-10-06', to: '2026-10-06' }, readers: READERS, statistics: { alpha: 0.05, draws: 199, descriptive_draws: 200, seed: 7 },
      sets: [{ id: 'S3', label: 'LoCoMo-shaped fixture', benchmark: 'locomo', exposure: 'E2', role: 'headline', cluster_unit: 'conversation', claim_min_clusters: 2, scheduled, exclusions: [] }],
      cells: [{ ...scoreboardCampaignCell(gb, gb.arms[0], results[0].arms[0]), pin: 'GBrain 0.0.0.0 (ffffffff, 2026-10-06)' }, scoreboardCampaignCell(ext, ext.arms[0], results[1].arms[0])],
      families: [{ id: 'F1', label: 'fixture, component, 8,000 tokens', anchor: gb.arms[0].cell_id, comparators: [ext.arms[0].cell_id] }, { id: 'F3', label: 'fixture, recall', anchor: gb.arms[0].cell_id, comparators: [ext.arms[0].cell_id] }],
      pins: [], release_assets: [], disclosures: ['Keyless fixture: the fake system stands in for both rows; scores prove the wiring only.'], render_targets: [], hedge_classifier: CLASSIFIER_VERSION_V2,
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
    const answers = ndjson(join(receipt, 'cells', gb.arms[0].cell_id, 'answers.ndjson'));
    const rows = new Map(ndjson(join(receipt, 'cells', gb.arms[0].cell_id, 'rows.ndjson')).map(r => [r.id, r]));
    const hedge = ndjson(join(receipt, 'cells', gb.arms[0].cell_id, 'derived', 'hedge.ndjson'));
    expect(hedge).toEqual(answers.map(a => ({ answer_id: a.answer_id, verdict: classifyV2(a.text), classifier_version: CLASSIFIER_VERSION_V2, rules_sha256: RULES_SHA256_V2, delivered_tokens: a.delivered_tokens })));
    expect(hedge.filter(h => h.verdict === 'abstain').every(h => { const a = answers.find(x => x.answer_id === h.answer_id); return rows.get(a.question_id).abstention || a.text === 'The history does not say.'; })).toBe(true);
    expect(new Set(hedge.map(h => h.verdict))).toEqual(new Set(['confident', 'abstain']));
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
    expect(answers).toHaveLength(15 * 3);
    const vet = answers.find(a => a.question_id === 'conv-a:q003' && a.reader === READERS[0]);
    expect(vet.outcome).toBe('scored');
    expect(vet.stop_reason).toBe('submitted');
    expect(vet.opened_source_ids).toContain('session_2');
    expect(vet.hedge).toBeUndefined();
    expect(vet.delivered_tokens).toEqual({ reader_input: vet.provider_input_tokens ?? vet.usage.input + vet.usage.cache_read + vet.usage.cache_write });
    const row = ndjson(join(dir, 'rows.ndjson')).find(r => r.id === 'conv-a:q003');
    expect(row.evidence_opened[READERS[0]]).toBe(1);
    expect(row.recall_measurable).toBe(false);
    expect(ndjson(join(dir, 'judgments.ndjson')).length).toBe(answers.length);
    const rec = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
    expect(rec.ingest.write_start_to_queryable_ms.not_measurable).toBeGreaterThan(0);
  });

  test('file agent: a budget stop ends the question as budget_not_run and stops the cell before any later answer or judgment', async () => {
    const def = cellDef('baseline-file-agent', 'in-process', [{ id: 'whole-agent', mode: 'agent' }], { configuration: 'baseline' });
    const out = join(tmp, 'agent-budget');
    let calls = 0;
    const refuse = (async () => { calls++; throw new BudgetExceededError('budget: the ledger refused the reservation (test)'); }) as unknown as typeof fetch;
    const res = await runCell(def, { out, maxAttempts: 1, ...quiet }, { corpus, system: new FileAgentSystem({ workDir: join(out, 'trees'), fetchImpl: refuse }), judge: scriptedJudge() });
    expect(res.stopped).toStartWith('budget: budget: the ledger refused');
    expect(res.status).toBe('partial');
    expect(calls).toBe(1);
    const dir = join(out, 'cells', def.arms[0].cell_id);
    const answers = ndjson(join(dir, 'answers.ndjson'));
    expect(answers.map(a => a.outcome)).toEqual(['budget_not_run']);
    expect(existsSync(join(dir, 'judgments.ndjson')) ? ndjson(join(dir, 'judgments.ndjson')) : []).toEqual([]);
  });

  test('full context: a history over the window is does_not_fit, never judged', async () => {
    const def = cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context' }], { configuration: 'baseline' });
    const out = join(tmp, 'full-no-fit');
    let calls = 0;
    const res = await runCell(def, { out, ...quiet }, { corpus, system: new FullContextSystem('whole-history'), judge: scriptedJudge(), fitTokenizer: () => ({ id: 'huge', count: () => 2_000_000 }), fullContextFetch: (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch });
    expect(res.status).toBe('complete');
    const dir = join(out, 'cells', def.arms[0].cell_id);
    const answers = ndjson(join(dir, 'answers.ndjson'));
    expect(answers).toHaveLength(45);
    expect(answers.every(a => a.outcome === 'does_not_fit' && a.text === '')).toBe(true);
    expect(ndjson(join(dir, 'judgments.ndjson'))).toHaveLength(0);
    expect(calls).toBe(0);
    expect(ndjson(join(dir, 'rows.ndjson'))[0].fit[READERS[0]].fits).toBe(false);
  });

  test('full context: priceRequest prices a gpt-6.1-sol whole-history reading at its stated 2,048 output tokens and its token estimate at the long-context cache-write rate, about $5.36 for 3.2 MB (the proxy reserves more: see the next test)', async () => {
    const { priceRequest, reservationUsd } = await import('../../eval/runner/budget-ledger.ts');
    const prompt = 'x'.repeat(3_200_000);
    const body = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: prompt }], n: 1, max_completion_tokens: 2048, reasoning_effort: 'medium', prompt_cache_key: 'k' };
    const price = priceRequest('https://api.openai.com/v1/chat/completions', body)!;
    expect(price.maxOutputTokens).toBe(2048);
    expect(reservationUsd(price)).toBeCloseTo(1_066_683 * 5 / 1e6 + 2048 * 15 / 1e6, 2);
    expect(reservationUsd(price)).toBeGreaterThan(1.37);
  });

  test('full context: the metering proxy reserves a gpt-6.1-sol whole-history reading at its byte count, not its token estimate: about $16.03 for 3.2 MB, three times priceRequest (A23 priced $5.40 a call; A24 measured about $19.29)', async () => {
    const { BudgetRun, priceRequest, reservationUsd } = await import('../../eval/runner/budget-ledger.ts');
    const { MeteringProxy } = await import('../../eval/runner/metering-proxy.ts');
    const upstream = (async () => Response.json({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } })) as unknown as typeof fetch;
    const usageLog = join(tmp, 'a24-full-context-usage.ndjson');
    const lease = BudgetRun.openLease({ runId: 'a24-full-context', leaseUsd: 50, ledgerPath: join(tmp, 'a24-full-context.sqlite') });
    const proxy = new MeteringProxy({ fetchImpl: upstream, policy: { lease, env: { OPENAI_API_KEY: 'placeholder', ANTHROPIC_API_KEY: 'placeholder', VOYAGE_API_KEY: 'placeholder' }, usageLog } });
    proxy.start();
    try {
      const body = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x'.repeat(3_200_000) }], n: 1, max_completion_tokens: 2048, reasoning_effort: 'medium', prompt_cache_key: 'k' };
      const text = JSON.stringify(body);
      const res = await fetch(`http://127.0.0.1:${proxy.port}/harness/openai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
      expect(res.status).toBe(200);
      const line = ndjson(usageLog).find(l => l.outcome === 'forwarded')!;
      const bytesBound = (Buffer.byteLength(text) + 64) * 5 / 1e6 + 2048 * 15 / 1e6;
      expect(line.reserved_usd).toBeCloseTo(bytesBound, 2);
      expect(line.reserved_usd).toBeGreaterThan(16);
      const estimate = reservationUsd(priceRequest('https://api.openai.com/v1/chat/completions', body)!);
      expect(line.reserved_usd / estimate).toBeGreaterThan(2.9);
    } finally { proxy.stop(); }
  });

  test('full context: a lease refusal (402 budget) is budget_not_run and stops the cell, never a reader_error (A23)', async () => {
    const def = cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context' }], { configuration: 'baseline' });
    const out = join(tmp, 'full-budget');
    let refused = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('anthropic')) return Response.json({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 3 } });
      refused++;
      return Response.json({ error: { kind: 'budget', message: 'reserving $3.69 would take this run to $3.70, over its $1.37 budget' } }, { status: 402 });
    }) as unknown as typeof fetch;
    const res = await runCell(def, { out, maxAttempts: 1, ...quiet }, { corpus, system: new FullContextSystem('whole-history'), judge: scriptedJudge(), fullContextFetch: fetchImpl });
    expect(res.status).toBe('partial');
    expect(res.stopped).toMatch(/^budget: openai 402/);
    const answers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
    expect(answers.filter(a => a.outcome === 'reader_error')).toEqual([]);
    expect(answers.filter(a => a.outcome === 'budget_not_run').map(a => a.reader)).toEqual(['openai:gpt-6.1-sol']);
    expect(refused).toBe(1);
  });

  test('A23: --reanswer-outcomes reader_error answers again the full-context readings the A22 runner recorded as reader_error, and keeps every other answer', async () => {
    const def = cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context' }], { configuration: 'baseline' });
    const out = join(tmp, 'full-reanswer');
    let failing = true, sol = 0, claude = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('anthropic')) { claude++; return Response.json({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 3 } }); }
      sol++;
      return failing ? Response.json({ error: { message: 'unsupported parameter' } }, { status: 400 }) : Response.json({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    }) as unknown as typeof fetch;
    const run = (extra: Partial<CellOptions> = {}) => runCell(def, { out, maxAttempts: 1, ...quiet, ...extra }, { corpus, system: new FullContextSystem('whole-history'), judge: scriptedJudge(), fullContextFetch: fetchImpl });
    await run();
    const outcomes = () => ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson')).map(a => [a.reader, a.outcome]);
    const errors = outcomes().filter(([, o]) => o === 'reader_error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(([r]) => r === 'openai:gpt-6.1-sol')).toBe(true);
    const [solBefore, claudeBefore] = [sol, claude];
    failing = false;
    await run({ reanswerInvalidBefore: new Date(Date.now() + 3_600_000).toISOString() });
    expect(sol).toBe(solBefore);
    await run({ reanswerInvalidBefore: new Date(Date.now() + 3_600_000).toISOString(), reanswerOutcomes: ['reader_error'] });
    expect(sol - solBefore).toBe(errors.length);
    expect(claude).toBe(claudeBefore);
    expect(outcomes().filter(([, o]) => o === 'reader_error')).toEqual([]);
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

describe('reader usage (eval/runner/q1/usage.ts)', () => {
  test('packed readers: OpenAI cached tokens count once, Anthropic buckets add up; usage.input is uncached for both', async () => {
    const def = cellDef('baseline-recency', 'in-process', [component({ reader_replicates: {} })], { configuration: 'baseline' });
    const reader: ChatLike = {
      async chat(model): Promise<ChatResult> {
        return model.startsWith('anthropic:') ? { ...NO_META, text: 'The history does not say.', input_tokens: 100, output_tokens: 5, cached: false, usage: { input_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 5 } }
          : { ...NO_META, text: 'The history does not say.', input_tokens: 100, output_tokens: 5, cached: false, usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } };
      },
    };
    const out = join(tmp, 'usage-packed');
    expect((await runCell(def, { out, ...quiet }, { corpus, system: new FullContextSystem('recency'), reader, judge: scriptedJudge() })).status).toBe('complete');
    const answers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
    const gpt = answers.filter(a => a.reader.startsWith('openai:')), claude = answers.filter(a => a.reader.startsWith('anthropic:'));
    expect(gpt.length).toBeGreaterThan(0);
    expect(claude.length).toBeGreaterThan(0);
    for (const a of gpt) expect([a.usage, a.provider_input_tokens]).toEqual([{ input: 40, output: 5, cache_read: 60, cache_write: 0 }, 100]);
    for (const a of claude) expect([a.usage, a.provider_input_tokens]).toEqual([{ input: 40, output: 5, cache_read: 50, cache_write: 10 }, 100]);
  });

  test('full context: an OpenAI reader\'s cached prompt tokens are not added twice', async () => {
    const def = cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context' }], { configuration: 'baseline' });
    const fetchImpl = (async (url: string) => Response.json(String(url).includes('anthropic')
      ? { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 500 } }
      : { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 510, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 500 } } })) as unknown as typeof fetch;
    const out = join(tmp, 'usage-full');
    await runCell(def, { out, ...quiet }, { corpus, system: new FullContextSystem('whole-history'), judge: scriptedJudge(), fullContextFetch: fetchImpl });
    const answers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      expect(a.provider_input_tokens).toBe(510);
      expect(a.usage).toMatchObject({ input: 10, cache_read: 500, cache_write: 0 });
      expect(a.delivered_tokens).toEqual({ reader_input: 510 });
    }
  });
});

describe('resume', () => {
  test('a killed in-process cell re-ingests every conversation with pending store work as a new realization, keeps the answers it had and asks only the rest (A22)', async () => {
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
    expect(answers).toHaveLength(45);
    expect(new Set(answers.map(a => a.answer_id)).size).toBe(45);
    const firstAnswers = ndjson(join(out, 'runs', def.id, 'r', realizationId(def.id, 'conv-a', 0), 'answers.ndjson'));
    expect(firstAnswers).toHaveLength(9);
    const kept = new Set(firstAnswers.map(a => a.answer_id));
    expect(answers.filter(a => kept.has(a.answer_id)).every(a => a.realization_id === realizationId(def.id, 'conv-a', 0))).toBe(true);
    expect(new Set(answers.filter(a => !kept.has(a.answer_id)).map(a => a.realization_id))).toEqual(new Set(['conv-a', 'conv-b', 'conv-c'].map(c => realizationId(def.id, c, 1))));
    expect(reader.calls).toHaveLength(45 - 9);
    const carried = events.filter(e => e.carried_from);
    expect(carried.map(e => [e.conversation, e.carried_from, e.carried.answers])).toEqual([['conv-a', realizationId(def.id, 'conv-a', 0), 9]]);
    const receipt = JSON.parse(readFileSync(join(out, 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8'));
    expect(receipt.realizations.find((r: any) => r.conversation === 'conv-a').carried_from).toBe(realizationId(def.id, 'conv-a', 0));
  });

  test('a reader error below the attempt limit is retried in the same process, so no question keeps a row without its answer (A22)', async () => {
    const def = cellDef('baseline-recency', 'in-process', [component({ reader_replicates: {} })], { configuration: 'baseline' });
    const out = join(tmp, 'retry-pass');
    const inner = scriptedReader();
    let failures = 0;
    const flaky = { ...inner, calls: inner.calls, chat: async (...args: Parameters<typeof inner.chat>) => { if (failures < 4) { failures++; throw new Error('upstream 503'); } return inner.chat(...args); } };
    const res = await runCell(def, { out, ...quiet }, { corpus, system: new FullContextSystem('recency'), reader: flaky as never, judge: scriptedJudge() });
    expect(res.status).toBe('complete');
    const answers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
    expect(answers).toHaveLength(45);
    expect(answers.every(a => a.outcome === 'scored')).toBe(true);
    expect(failures).toBe(4);
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
      expect(reader.calls).toHaveLength((15 - 7) * 3);
      const events = ndjson(join(out, 'runs', def.id, 'realizations.ndjson'));
      expect(events.some(e => e.event === 'invalidated')).toBe(false);
    } finally { server.stop(); }
  });

  test('A24: a run-config written with A22 launch fields resumes under A23 and A24 launch fields; a change to what the cell measures is still refused', async () => {
    const base = cellDef('baseline-recency', 'in-process', [component({ reader_replicates: {} })], { configuration: 'baseline' });
    const out = join(tmp, 'a24-config');
    const run = (def: CellDefinition, c: Corpus = corpus) => runCell(def, { out, ...quiet }, { corpus: c, system: new FullContextSystem('recency'), reader: scriptedReader(), judge: scriptedJudge() });
    await runCell(base, { out, stopAfterQuestions: 2, ...quiet }, { corpus, system: new FullContextSystem('recency'), reader: scriptedReader(), judge: scriptedJudge() });
    const path = join(out, 'cells', base.arms[0].cell_id, 'run-config.json');
    const a22 = JSON.parse(readFileSync(path, 'utf8'));
    a22.cell = { ...a22.cell, shards: 10, expected_hours: 30, lease: { usd: 27, basis: 'A20' } };
    const a22Text = JSON.stringify(a22, null, 2) + '\n';
    writeFileSync(path, a22Text);
    const a24: CellDefinition = { ...base, shards: 2, expected_hours: 48, lease: { usd: 20, basis: 'A23' }, reanswer_invalid_before: { at: '2026-10-26T00:00:00Z', basis: 'ruling', outcomes: ['harness_invalid'] }, fresh_before: { at: '2026-10-26T00:00:00Z', shards: [0], basis: 'ruling' } };
    expect((await run(a24)).status).toBe('complete');
    expect(readFileSync(path, 'utf8')).toBe(a22Text);
    const arm = a24.arms[0];
    for (const changed of [{ ...a24, arms: [{ ...arm, budget: 4000 }] }, { ...a24, arms: [{ ...arm, readers: [arm.readers[0]] }] }, { ...a24, effort: 'high' as 'medium' }]) await expect(run(changed)).rejects.toThrow(/holds a different configuration/);
    await expect(run(a24, { ...corpus, source: { ...corpus.source, revision: 'another-revision' } })).rejects.toThrow(/holds a different configuration/);
    expect(readFileSync(path, 'utf8')).toBe(a22Text);
  });

  test('A23: --fresh-before reruns a conversation fresh: ingested again, every question asked again, nothing carried from a realization ingested before the cutoff, even after an interrupted fresh run; a restored snapshot is refused', async () => {
    const fake = new FakeMemorySystem();
    let ingests = 0;
    const ingest = fake.ingestSession.bind(fake);
    fake.ingestSession = async (ns, s, t) => { ingests++; return ingest(ns, s, t); };
    const server = serveProtocol(fake);
    try {
      const def = cellDef('ext-memory-bank', 'shim', [component({ reader_replicates: {} })]);
      const out = join(tmp, 'a23-fresh');
      const run = (reader: ReturnType<typeof scriptedReader>, extra: Partial<CellOptions> = {}) => runCell(def, { out, systemUrl: server.url, ...quiet, ...extra }, { corpus, reader, judge: scriptedJudge() });
      const first = scriptedReader();
      expect((await run(first)).status).toBe('complete');
      expect(ingests).toBe(15);
      await Bun.sleep(5);
      const cut = new Date().toISOString();
      await Bun.sleep(5);
      await expect(run(scriptedReader(), { freshBefore: cut, env: { ...process.env, SHOOTOUT_RESTORED_REALIZATION: 'real-test-0123' } })).rejects.toThrow(/rerun fresh/);
      const second = scriptedReader();
      await run(second, { freshBefore: cut, stopAfterQuestions: 4 });
      expect(ingests).toBe(30);
      const third = scriptedReader();
      expect((await run(third, { freshBefore: cut })).status).toBe('complete');
      expect(second.calls.length).toBeGreaterThan(0);
      expect(second.calls.length + third.calls.length).toBe(first.calls.length);
      const answers = ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson'));
      expect(answers).toHaveLength(first.calls.length);
      const events = ndjson(join(out, 'runs', def.id, 'realizations.ndjson'));
      const stale = new Set(events.filter(e => e.event === 'ingested' && e.at < cut).map(e => e.realization_id));
      expect(events.filter(e => e.event === 'invalidated' && /rerun.*fresh \(A23\)/.test(e.reason)).map(e => e.realization_id).every(r => stale.has(r))).toBe(true);
      expect(events.filter(e => e.carried_from).some(e => stale.has(e.carried_from))).toBe(false);
      const before = ingests;
      expect((await run(scriptedReader(), { freshBefore: cut })).status).toBe('complete');
      expect(ingests).toBe(before);
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
      expect(a.arms[0].answers).toBe(10 * 3);
      const merged = publishCell(def, def.arms, [join(tmp, 'shard0'), join(tmp, 'shard1')], join(tmp, 'merged'), { instrument: instrumentFor('locomo'), selected: selectCellQuestions(corpus.questions, { kind: 'all' }), invalidReasons: [],
        configs: new Map([[def.arms[0].id, { text: readFileSync(join(tmp, 'shard0', 'cells', def.arms[0].cell_id, 'run-config.json'), 'utf8'), sha: a.arms[0].config_sha256 }]]), capabilities: FAKE_CAPABILITIES, stopped: null, maxAttempts: 3 });
      expect(merged[0].status).toBe('complete');
      expect(merged[0].answers).toBe(15 * 3);
      expect(readFileSync(join(tmp, 'shard1', 'cells', def.arms[0].cell_id, 'run-config.json'), 'utf8')).toBe(readFileSync(join(tmp, 'shard0', 'cells', def.arms[0].cell_id, 'run-config.json'), 'utf8'));
      const agg = JSON.stringify(cellAggregates(merged));
      expect(agg).not.toContain('conv-a');
      expect(agg).not.toContain('From the history');
      expect(agg).toContain('"answers":45');
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
      expect(readerCalls).toHaveLength(2 * 3);
      expect(judgeCalls.length).toBeGreaterThanOrEqual(2);
      expect(ndjson(join(out, 'cells', def.arms[0].cell_id, 'judgments.ndjson'))).toHaveLength(2 * 3);
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

describe('particle-1 readers through Q1\'s lease proxy (plan GST-605 Phase 2)', () => {
  const PARTICLE = 'particle:particle-1';
  const slice = { selection: { kind: 'shootout-slice' as const, limit: 2, seed: 42 } };
  const answerText = () => ({ message: { content: 'From the history: something.' }, finish: 'stop' });
  const submit = () => ({ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_answer', arguments: JSON.stringify({ answer: 'The history does not say.' }) } }] }, finish: 'tool_calls' });
  let k = 0;
  /** The real lease proxy (eval/runner/metering-proxy.ts, Q1's route caps and classes) in front of a fake Particle. */
  function leaseProxy(leaseUsd: number, answer: (n: number) => { message: Record<string, unknown>; finish: string } | Response = answerText) {
    const seen: Array<{ url: string; auth: string | null; body: Record<string, any> }> = [];
    const upstream = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      const a = answer(seen.length);
      if (a instanceof Response) return a;
      return Response.json({ id: `c${seen.length}`, model: 'particle-ai/particle-1', choices: [{ index: 0, message: { role: 'assistant', ...a.message }, finish_reason: a.finish }],
        usage: { prompt_tokens: 500, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } }, service_tier: 'default', metadata: { weight_version: 'default' } });
    }) as unknown as typeof fetch;
    const usageLog = join(tmp, `particle-usage-${++k}.ndjson`);
    const lease = BudgetRun.openLease({ runId: `particle-${k}`, leaseUsd, ledgerPath: join(tmp, `particle-${k}.sqlite`) });
    const proxy = new MeteringProxy({ fetchImpl: upstream, policy: { lease, usageLog, env: { OPENAI_API_KEY: 'placeholder', ANTHROPIC_API_KEY: 'placeholder', VOYAGE_API_KEY: 'placeholder', PARTICLE_API_KEY: 'placeholder-particle' },
      routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    return { seen, url: `http://127.0.0.1:${proxy.port}`, lines: () => existsSync(usageLog) ? ndjson(usageLog) : [], stop: () => proxy.stop() };
  }
  /** Every answering try the cell staged (answer-attempts.ndjson under each realization). */
  const tries = (out: string, def: CellDefinition) => {
    const r = join(out, 'runs', def.id, 'r');
    return readdirSync(r).flatMap(rid => existsSync(join(r, rid, 'answer-attempts.ndjson')) ? ndjson(join(r, rid, 'answer-attempts.ndjson')) : []);
  };
  let saved: NodeJS.ProcessEnv = {};
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); closeLedgers(); });

  // Value: protects=bar 2 receipts and Q1 metering on the packed path; fails_when=a particle reading skips the lease proxy, is capped at 2,048, is charged to no model, loses its attempts, or a truncated answer is retried or not counted; why_new=U5 lifts the refusal of particle readers behind the lease proxy; seam=none; no_claim=keyless (fake Particle behind the real proxy)
  test('packed: each reading lands at /harness/particle/v1, is charged to particle at its 16,000-token cap and keeps its attempt; a truncated answer is scored, judged, counted and never retried', async () => {
    const lp = leaseProxy(1, n => ({ ...answerText(), finish: n === 1 ? 'length' : 'stop' }));
    try {
      const def = cellDef('ext-graph-pipeline', 'shim', [component({ readers: [PARTICLE], reader_replicates: {} })], slice);
      const out = join(tmp, 'particle-packed');
      const res = await runCell(def, { out, providerProxy: lp.url, ...quiet }, { corpus, system: new FakeMemorySystem(), reader: new ChatClient(join(out, 'qa-cache')), judge: scriptedJudge() });
      expect(res.status).toBe('complete');
      expect(lp.seen).toHaveLength(2);
      expect(lp.seen.every(s => s.url === 'https://api.particle.ai/v1/chat/completions' && s.auth === 'Bearer placeholder-particle' && s.body.model === 'particle-1' && s.body.max_completion_tokens === 16_000
        && s.body.reasoning_effort === 'medium' && !('temperature' in s.body))).toBe(true);
      expect(lp.lines().map(l => [l.provider, l.slot, l.route, l.route_class, l.output_cap, l.outcome, l.model])).toEqual(Array(2).fill(['particle', 'harness', '/v1/chat/completions', 'reader', 16_000, 'forwarded', 'particle-1']));
      const dir = join(out, 'cells', def.arms[0].cell_id);
      const answers = ndjson(join(dir, 'answers.ndjson'));
      expect(answers.map(a => [a.outcome, a.truncated, a.finish]).sort()).toEqual([['scored', false, 'stop'], ['scored', true, 'length']]);
      expect(answers.flatMap(a => answerProblems(a))).toEqual([]);
      expect(answers.map(a => a.attempts)).toEqual(answers.map(a => [{ status: 'ok', error: null, from_cache: false, response_model: 'particle-ai/particle-1', finish: a.finish, reasoning_tokens: 30, weight_version: 'default',
        effort_sent: 'medium', effort_effective: 'high', output_limit: 16_000, retry_after_ms: null }]));
      expect(ndjson(join(dir, 'judgments.ndjson'))).toHaveLength(2);
      const rec = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
      expect(rec.counts.truncated).toBe(1);
      expect(rec.spend.usd.reader).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(join(dir, 'run-config.json'), 'utf8')).reader).toMatchObject({ max_tokens: 2048, max_tokens_by_reader: { [PARTICLE]: 16_000 } });
    } finally { lp.stop(); }
  });

  // Value: protects=Q1 metering on the full-context path; fails_when=a whole-history particle reading bypasses the proxy slot or its cap, or drops its prompt cache key or attempts; why_new=answerFullContext gains the particle transport; seam=none; no_claim=keyless
  test('full context: each whole-history reading lands at /harness/particle/v1 with its prompt cache key and 16,000-token cap, charged to particle, with its attempt', async () => {
    const lp = leaseProxy(1);
    try {
      const def = cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context', readers: [PARTICLE] }], { configuration: 'baseline', ...slice });
      const out = join(tmp, 'particle-full');
      const res = await runCell(def, { out, providerProxy: lp.url, ...quiet }, { corpus, system: new FullContextSystem('whole-history'), judge: scriptedJudge() });
      expect(res.status).toBe('complete');
      expect(lp.seen).toHaveLength(2);
      expect(lp.seen.every(s => s.body.max_completion_tokens === 16_000 && typeof s.body.prompt_cache_key === 'string' && s.body.messages.length === 1)).toBe(true);
      expect(lp.lines().map(l => [l.provider, l.slot, l.route_class, l.output_cap, l.outcome])).toEqual(Array(2).fill(['particle', 'harness', 'reader', 16_000, 'forwarded']));
      const dir = join(out, 'cells', def.arms[0].cell_id);
      const answers = ndjson(join(dir, 'answers.ndjson'));
      expect(answers.map(a => [a.outcome, a.truncated, a.attempts.length, a.attempts[0].output_limit, a.attempts[0].response_model])).toEqual(Array(2).fill(['scored', false, 1, 16_000, 'particle-ai/particle-1']));
      expect(JSON.parse(readFileSync(join(dir, 'run-config.json'), 'utf8')).reader.max_tokens_by_reader).toEqual({ [PARTICLE]: 16_000 });
    } finally { lp.stop(); }
  });

  // Value: protects=a slow particle reading is billed once (issue #250 at the cell level); fails_when=a timed-out try is left non-terminal, so the cell's A22 retry pass (or the provider loop) sends it again; why_new=qa-v2 and readCompat stop on a timeout, and the cell must not undo that; seam=none; no_claim=Particle's billing of an aborted request
  test('packed and full context: a reading that times out is sent once, recorded as a final reader_error with its attempt, and never sent again in this process', async () => {
    for (const mode of ['packed', 'full-context'] as const) {
      const lp = leaseProxy(1);
      const realFetch = globalThis.fetch;
      let calls = 0;
      const timeout = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input instanceof Request ? input.url : input).includes('/particle/')) return realFetch(input, init);
        calls++;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }) as unknown as typeof fetch;
      if (mode === 'packed') globalThis.fetch = timeout;
      try {
        const def = mode === 'packed' ? cellDef('ext-graph-pipeline', 'shim', [component({ readers: [PARTICLE], reader_replicates: {} })], slice)
          : cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context', readers: [PARTICLE] }], { configuration: 'baseline', ...slice });
        const out = join(tmp, `particle-timeout-${mode}`);
        await runCell(def, { out, providerProxy: lp.url, ...quiet }, { corpus, system: mode === 'packed' ? new FakeMemorySystem() : new FullContextSystem('whole-history'), reader: new ChatClient(join(out, 'qa-cache')), judge: scriptedJudge(),
          ...(mode === 'full-context' ? { fullContextFetch: timeout } : {}) });
        expect([mode, calls, lp.seen.length]).toEqual([mode, 2, 0]);
        expect(tries(out, def).map(t => [t.outcome, t.attempts.length, t.attempts[0].status])).toEqual(Array(2).fill(['reader_error', 1, 'error']));
        expect(ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson')).map(a => [a.outcome, a.attempts.length])).toEqual(Array(2).fill(['reader_error', 1]));
      } finally { globalThis.fetch = realFetch; lp.stop(); }
    }
  });

  // Value: protects=a reading whose upstream request passed the proxy's deadline is billed once; fails_when=the proxy's timeout answer is retried by the client loop or the cell's retry pass; why_new=the proxy answers its own upstream timeout 504 and compatTimedOut reads it; seam=none; no_claim=a real 900 s wait
  test('packed and full context: an upstream timeout at the lease proxy reaches Particle once per question and is a final reader_error', async () => {
    for (const mode of ['packed', 'full-context'] as const) {
      const lp = leaseProxy(1, () => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
      try {
        const def = mode === 'packed' ? cellDef('ext-graph-pipeline', 'shim', [component({ readers: [PARTICLE], reader_replicates: {} })], slice)
          : cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context', readers: [PARTICLE] }], { configuration: 'baseline', ...slice });
        const out = join(tmp, `particle-proxy-timeout-${mode}`);
        await runCell(def, { out, providerProxy: lp.url, ...quiet }, { corpus, system: mode === 'packed' ? new FakeMemorySystem() : new FullContextSystem('whole-history'), reader: new ChatClient(join(out, 'qa-cache')), judge: scriptedJudge() });
        expect([mode, lp.seen.length]).toEqual([mode, 2]);
        expect(ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson')).map(a => [a.outcome, a.attempts.length, a.attempts[0].error.startsWith('particle 504')])).toEqual(Array(2).fill(['reader_error', 1, true]));
      } finally { lp.stop(); }
    }
  });

  // Value: protects=only a real budget stop stops a particle cell; fails_when=a non-retryable Particle 400 whose body mentions a budget is read as the ledger's or lease's stop by its message text; why_new=the packed path now reads a compat reader's stop by the error's name, as qa-v2 does; seam=none; no_claim=Particle's real 400 bodies
  test('packed: a Particle 400 whose body mentions a budget is a reader_error, and the cell reads on', async () => {
    const lp = leaseProxy(1, () => new Response(JSON.stringify({ error: { message: 'max_completion_tokens exceeds the per-request token budget' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    try {
      const def = cellDef('ext-graph-pipeline', 'shim', [component({ readers: [PARTICLE], reader_replicates: {} })], slice);
      const out = join(tmp, 'particle-400-budget-words');
      const res = await runCell(def, { out, providerProxy: lp.url, maxAttempts: 1, ...quiet }, { corpus, system: new FakeMemorySystem(), reader: new ChatClient(join(out, 'qa-cache')), judge: scriptedJudge() });
      expect(res.stopped).toBeNull();
      expect(lp.seen).toHaveLength(2);
      expect(ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson')).map(a => a.outcome)).toEqual(['reader_error', 'reader_error']);
    } finally { lp.stop(); }
  });

  // Value: protects=the lease as a hard stop for particle; fails_when=an exhausted lease's refusal is retried, recorded as a reader error, loses its attempt, or lets the cell read or judge on; why_new=the scheduler's budget stop now sees particle's proxy refusal; seam=none; no_claim=Particle's own credit 402 (file-agent.test.ts)
  test('packed and full context: an exhausted lease refuses the first reading before it reaches Particle; the cell stops as a budget stop after recording the failed attempt', async () => {
    for (const mode of ['packed', 'full-context'] as const) {
      const lp = leaseProxy(0.01);
      try {
        const def = mode === 'packed' ? cellDef('ext-graph-pipeline', 'shim', [component({ readers: [PARTICLE], reader_replicates: {} })], slice)
          : cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context', readers: [PARTICLE] }], { configuration: 'baseline', ...slice });
        const out = join(tmp, `particle-exhausted-${mode}`);
        const res = await runCell(def, { out, providerProxy: lp.url, ...quiet }, { corpus, system: mode === 'packed' ? new FakeMemorySystem() : new FullContextSystem('whole-history'), reader: new ChatClient(join(out, 'qa-cache')), judge: scriptedJudge() });
        expect([mode, res.status]).toEqual([mode, 'partial']);
        expect(res.stopped).toContain('the metering proxy refused the particle request (HTTP 402)');
        expect(lp.seen).toHaveLength(0);
        expect(lp.lines().map(l => [l.provider, l.slot, l.outcome, l.status])).toEqual([['particle', 'harness', 'refused', 402]]);
        expect(tries(out, def).map(t => [t.outcome, t.attempts.length, t.attempts[0].status, t.attempts[0].response_model, t.attempts[0].output_limit])).toEqual([['budget_not_run', 1, 'error', null, 16_000]]);
        const dir = join(out, 'cells', def.arms[0].cell_id);
        expect(existsSync(join(dir, 'judgments.ndjson')) ? ndjson(join(dir, 'judgments.ndjson')) : []).toEqual([]);
      } finally { lp.stop(); }
    }
  });

  // Value: protects=a lease refusal never finalizes a particle question; fails_when=a budget_not_run line counts toward the cell's tries, so the third budget-stopped run writes budget_not_run as the question's answer although nothing reached Particle; why_new=the refusal's line keeps the reader's receipts in answer-attempts.ndjson; seam=none; no_claim=non-particle readers, whose lines carry no receipts
  test('packed and full context: lease refusals keep every receipt but use none of the question\'s tries, so four budget-stopped runs leave it unanswered', async () => {
    for (const mode of ['packed', 'full-context'] as const) {
      const lp = leaseProxy(0.01);
      try {
        const def = mode === 'packed' ? cellDef('ext-graph-pipeline', 'shim', [component({ readers: [PARTICLE], reader_replicates: {} })], slice)
          : cellDef('baseline-full-context', 'in-process', [{ id: 'whole-full-context', mode: 'full-context', readers: [PARTICLE] }], { configuration: 'baseline', ...slice });
        const out = join(tmp, `particle-refused-runs-${mode}`);
        for (let run = 0; run < 4; run++) {
          const res = await runCell(def, { out, providerProxy: lp.url, ...quiet }, { corpus, system: mode === 'packed' ? new FakeMemorySystem() : new FullContextSystem('whole-history'), reader: new ChatClient(join(out, 'qa-cache')), judge: scriptedJudge() });
          expect([mode, run, res.status]).toEqual([mode, run, 'partial']);
        }
        expect(lp.seen).toHaveLength(0);
        expect(tries(out, def).map(t => [t.outcome, t.attempts.length])).toEqual(Array.from({ length: 4 }, () => ['budget_not_run', 1]));
        const answersFile = join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson');
        expect(existsSync(answersFile) ? ndjson(answersFile) : []).toEqual([]);
      } finally { lp.stop(); }
    }
  });

  // Value: protects=no Q1 agent arm reads particle through the lease proxy while the agent loop sends a timed-out turn again (issue #253); fails_when=an agent arm with a particle reader reaches the proxy, or the refusal happens after ingest; why_new=lifting U2's lease-proxy refusal for packed and full-context readers would otherwise reopen the agent lane; seam=none; no_claim=the agent loop's own timeout handling
  test('file agent: a particle reader on an agent arm through the lease proxy is refused before anything is sent, until issue #253', async () => {
    const def = cellDef('baseline-file-agent', 'in-process', [{ id: 'whole-agent', mode: 'agent', readers: [PARTICLE] }], { configuration: 'baseline', ...slice });
    const lp = leaseProxy(1, submit);
    try {
      const out = join(tmp, 'particle-agent');
      const err = await runCell(def, { out, providerProxy: lp.url, ...quiet }, { corpus, system: new FileAgentSystem({ workDir: join(out, 'trees') }), judge: scriptedJudge() }).catch(e => e) as ScoreboardError;
      expect([err.op.code, err.op.message.replace(def.id, '<cell>')]).toEqual(['NOT_YET_AVAILABLE', 'cell <cell> answers with particle:particle-1 on an agent arm through --provider-proxy, and the agent loop still sends a timed-out turn again (issue #253)']);
      expect(lp.seen).toHaveLength(0);
      expect(lp.lines()).toEqual([]);
    } finally { lp.stop(); }
  });
});

describe('background tail spend after /finish (gbrain-defaults closure)', () => {
  /**
   * gbrain-defaults' shape: one namespace at a time, model jobs queued behind /finish run only while their namespace is
   * active. Two probes: a job that starts after vector readiness (finish already returned ready), and a model call
   * whose first attempt failed inside finish and whose delayed retry runs after the cell switched to another
   * namespace and came back. The scripted reader starts the active namespace's queued work, so it runs between
   * harness calls, outside every retrieval.
   */
  class QueuedJobsFake extends FakeMemorySystem {
    active: string | null = null;
    readonly queued = new Map<string, number>();
    constructor(private readonly provider: string) { super(); }
    private chat(content: string) {
      return fetch(`${this.provider}/fake/openai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dummy' }, body: JSON.stringify({ model: 'gpt-4.1-mini', max_tokens: 200, messages: [{ role: 'user', content }] }) });
    }
    async ingestSession(ns: string, session: Parameters<FakeMemorySystem['ingestSession']>[1], when: string | null) { this.active = ns; return super.ingestSession(ns, session, when); }
    async finishIngest() {
      const r = await super.finishIngest();
      await this.chat('fail');
      this.queued.set(this.active!, 2);
      return r;
    }
    async retrieve(ns: string, q: Parameters<FakeMemorySystem['retrieve']>[1], policy: Parameters<FakeMemorySystem['retrieve']>[2]) { this.active = ns; return super.retrieve(ns, q, policy); }
    async runQueued() {
      const ns = this.active!;
      for (let i = 0; i < (this.queued.get(ns) ?? 0); i++) await this.chat('ok');
      this.queued.delete(ns);
    }
  }

  test('a job after vector readiness and a delayed retry after a namespace switch land in their own realization\'s background tail, never in retrieval', async () => {
    const { BudgetRun } = await import('../../eval/runner/budget-ledger.ts');
    const { MeteringProxy } = await import('../../eval/runner/metering-proxy.ts');
    const upstream = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.messages[0].content === 'fail' ? new Response('overloaded', { status: 503 }) : Response.json({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    }) as unknown as typeof fetch;
    const usageLog = join(tmp, 'tail-usage.ndjson');
    const lease = BudgetRun.openLease({ runId: 'tail-probe', leaseUsd: 1, ledgerPath: join(tmp, 'tail-lease.sqlite') });
    const proxy = new MeteringProxy({ fetchImpl: upstream, policy: { lease, env: { OPENAI_API_KEY: 'placeholder', ANTHROPIC_API_KEY: 'placeholder', VOYAGE_API_KEY: 'placeholder' }, usageLog } });
    proxy.start();
    const base = `http://127.0.0.1:${proxy.port}`;
    const fake = new QueuedJobsFake(base);
    const reader: ChatLike = { async chat(model, prompt, opts) { await fake.runQueued(); return scriptedReader().chat(model, prompt, opts); } };
    const saved = { ...process.env };
    try {
      const def = cellDef('ext-graph-pipeline', 'shim', [component({ reader_replicates: {} })]);
      const out = join(tmp, 'tail-probe');
      const res = await runCell(def, { out, providerProxy: base, ...quiet }, { corpus, system: fake, reader, judge: scriptedJudge() });
      expect(res.status).toBe('complete');
      const rec = JSON.parse(readFileSync(join(out, 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8'));
      const perCall = (1000 * 0.4 + 100 * 1.6) / 1e6;
      const rids = ['conv-a', 'conv-b', 'conv-c'].map(c => realizationId(def.id, c, 0));
      expect(Object.keys(rec.spend.background_tail_usd_by_realization).sort()).toEqual([...rids].sort());
      for (const rid of rids) expect(rec.spend.background_tail_usd_by_realization[rid]).toBeCloseTo(2 * perCall, 9);
      expect(rec.spend.usd.background_tail).toBeCloseTo(6 * perCall, 9);
      expect(rec.spend.usd.retrieval).toBe(0);
      expect(rec.spend.total_usd).toBeCloseTo(rec.spend.usd.ingest + rec.spend.usd.background_tail, 6);
      const lines = readFileSync(usageLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const ok = lines.filter(l => l.status === 200);
      expect(ok).toHaveLength(6);
      for (const l of ok) expect([l.key.startsWith('tail:'), l.phase, l.bucket]).toEqual([true, 'background', 'attributed']);
      expect(new Set(ok.map(l => `${l.key}|${l.brain}`)).size).toBe(3);
      expect(lines.filter(l => l.status === 503).every(l => l.key.startsWith('ingest:') && l.phase === 'background')).toBe(true);
      expect(lines.some(l => l.bucket === 'unattributed-background' || l.phase === 'query')).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      proxy.stop();
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

  // Value: protects=particle-1 never judges a Q1 cell; fails_when=a particle frontier judge reaches the judge slot, behind the lease proxy or on the ledger; why_new=U5 lifts U2's lease-proxy refusal for particle readers only; seam=none; no_claim=keyless, refused before any request
  test('an OpenAI-compatible frontier judge is refused before the cell ingests or reads, with or without the lease proxy', async () => {
    const refusal = async (providerProxy: string | null) => {
      const def = cellDef('baseline-recency', 'in-process', [component({ reader_replicates: {}, readers: [SONNET], frontier: { judges: ['anthropic:claude-opus-5-5', 'particle:particle-1'], readers: null, sample: null } })], { configuration: 'baseline' });
      const err = await runCell(def, { out: mkdtempSync(join(tmp, 'compat-judge-')), providerProxy, ...quiet }, { corpus, system: new FakeMemorySystem() }).catch(e => e) as ScoreboardError;
      return [err.op.code, err.op.message.replace(def.id, '<cell>')];
    };
    for (const proxy of ['http://127.0.0.1:9', null]) expect(await refusal(proxy)).toEqual(['USAGE', 'cell <cell> judges with particle:particle-1, and Q1 never judges with an OpenAI-compatible model']);
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

  test('A23: an own answer the system classifies as a harness failure records the reason the system gave, in the attempts log', async () => {
    const fake = serveProtocol(new FakeMemorySystem());
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: async req => {
      const path = new URL(req.url).pathname;
      if (path === '/answer') return Response.json({ answer: '', outcome: 'harness_invalid', synthesis_status: 'unavailable', error_code: 'unavailable', degraded: null, source_ids: [], model: null, usage: { input: 0, output: 0 }, usd: null, service_ms: 1,
        raw: { error: 'unavailable', reason: 'ai_config', message: '[chat(anthropic:claude-opus-5-5)] provider refused the call' } });
      const res = await fetch(`${fake.url}${path}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? await req.text() : undefined, keepalive: false });
      const json = await res.json() as Record<string, unknown>;
      if (path === '/capabilities') Object.assign(json, { system: 'gbrain-defaults', answer: { modes: ['think'] } });
      return Response.json(json, { status: res.status });
    } });
    try {
      const def = cellDef('gbrain-defaults', 'shim', [{ ...think, readers: ['anthropic:claude-opus-5-5'] }], { configuration: 'full-surface' });
      const out = join(tmp, 'a23-invalid-reason');
      await runCell(def, { out, systemUrl: `http://127.0.0.1:${server.port}`, maxAttempts: 1, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      const attempts = [...new Bun.Glob('runs/*/r/*/answer-attempts.ndjson').scanSync(out)].flatMap(f => ndjson(join(out, f)));
      expect(attempts.length).toBeGreaterThan(0);
      for (const a of attempts) expect([a.outcome, a.error]).toEqual(['harness_invalid', 'the system classified its answer path as a harness failure: error_code unavailable; reason ai_config; [chat(anthropic:claude-opus-5-5)] provider refused the call']);
    } finally { server.stop(true); fake.stop(); }
  });

  test('A23: --reanswer-invalid-before answers again the harness_invalid answers recorded before the cutoff, on a new realization that carries every other record; a cutoff before them changes nothing', async () => {
    const fake = serveProtocol(new FakeMemorySystem());
    let invalid = true, calls = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: async req => {
      const path = new URL(req.url).pathname;
      if (path === '/answer') {
        calls++;
        return Response.json(invalid
          ? { answer: '', outcome: 'harness_invalid', synthesis_status: 'unavailable', error_code: 'unavailable', degraded: null, source_ids: [], model: null, usage: { input: 0, output: 0 }, usd: null, service_ms: 1 }
          : { answer: 'the answer', outcome: 'scored', degraded: null, source_ids: [], model: 'claude-opus-5-5', usage: { input: 10, output: 5 }, usd: 0.001, service_ms: 1 });
      }
      const res = await fetch(`${fake.url}${path}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? await req.text() : undefined, keepalive: false });
      const json = await res.json() as Record<string, unknown>;
      if (path === '/capabilities') Object.assign(json, { system: 'gbrain-defaults', answer: { modes: ['think'] } });
      return Response.json(json, { status: res.status });
    } });
    try {
      const def = cellDef('gbrain-defaults', 'shim', [{ ...think, readers: ['anthropic:claude-opus-5-5'] }], { configuration: 'full-surface' });
      const out = join(tmp, 'a23-reanswer');
      const run = (reanswerInvalidBefore: string | null) => runCell(def, { out, systemUrl: `http://127.0.0.1:${server.port}`, maxAttempts: 1, reanswerInvalidBefore, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      const outcomes = () => ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson')).map(a => a.outcome);
      await run(null);
      const first = outcomes();
      expect(first.length).toBeGreaterThan(0);
      expect(new Set(first)).toEqual(new Set(['harness_invalid']));
      const asked = calls;
      invalid = false;
      await run('2000-01-01T00:00:00Z');
      expect(calls).toBe(asked);
      expect(outcomes()).toEqual(first);
      await run(new Date(Date.now() + 3_600_000).toISOString());
      expect(calls).toBe(asked + first.length);
      expect(new Set(outcomes())).toEqual(new Set(['scored']));
      const events = [...new Bun.Glob('runs/*/realizations.ndjson').scanSync(out)].flatMap(f => ndjson(join(out, f)));
      expect(events.filter(e => e.event === 'invalidated' && /answered again under a ruling \(A23\)/.test(e.reason)).length).toBeGreaterThan(0);
    } finally { server.stop(true); fake.stop(); }
  });

  test('A23: a lease refusal of the system\'s own model call stops the cell as a budget stop, never a harness_invalid answer', async () => {
    const { BudgetRun } = await import('../../eval/runner/budget-ledger.ts');
    const { MeteringProxy } = await import('../../eval/runner/metering-proxy.ts');
    const upstream = (async () => Response.json({ content: [{ type: 'text', text: '{"answer":"x"}' }], usage: { input_tokens: 10, output_tokens: 5 } })) as unknown as typeof fetch;
    const lease = BudgetRun.openLease({ runId: 'a23-lease-refusal', leaseUsd: 0.3, ledgerPath: join(tmp, 'a23-lease.sqlite') });
    const proxy = new MeteringProxy({ fetchImpl: upstream, policy: { lease, env: { OPENAI_API_KEY: 'placeholder', ANTHROPIC_API_KEY: 'placeholder', VOYAGE_API_KEY: 'placeholder' }, usageLog: join(tmp, 'a23-usage.ndjson') } });
    proxy.start();
    const base = `http://127.0.0.1:${proxy.port}`;
    // gbrain-defaults' think path: one model call at the reader with max_tokens 16000 (a Claude 5 reservation above the
    // lease); gbrain turns the proxy's 402 into an op error and the shim answers it as harness_invalid with no model.
    const fake = serveProtocol(new FakeMemorySystem());
    const answered: number[] = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: async req => {
      const path = new URL(req.url).pathname;
      if (path === '/answer') {
        const body = await req.json() as Record<string, any>;
        const r = await fetch(`${base}/gbrain-defaults/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'dummy' }, body: JSON.stringify({ model: String(body.model).replace(/^anthropic:/, ''), max_tokens: 16000, messages: [{ role: 'user', content: body.question }] }) });
        answered.push(r.status);
        return Response.json({ answer: '', outcome: 'harness_invalid', synthesis_status: 'unavailable', error_code: 'unavailable', degraded: null, source_ids: [], model: null, usage: { input: 0, output: 0 }, usd: null, service_ms: 1 });
      }
      const res = await fetch(`${fake.url}${path}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? await req.text() : undefined, keepalive: false });
      const json = await res.json() as Record<string, unknown>;
      if (path === '/capabilities') Object.assign(json, { system: 'gbrain-defaults', answer: { modes: ['think'] } });
      return Response.json(json, { status: res.status });
    } });
    const saved = { ...process.env };
    try {
      const def = cellDef('gbrain-defaults', 'shim', [{ ...think, readers: ['anthropic:claude-opus-5-5'] }], { configuration: 'full-surface' });
      const out = join(tmp, 'a23-lease-refusal');
      const res = await runCell(def, { out, systemUrl: `http://127.0.0.1:${server.port}`, providerProxy: base, maxAttempts: 1, ...quiet }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
      expect(answered).toEqual([402]);
      expect(res.stopped).toMatch(/^budget: the metering proxy refused 1 of the system's own provider call/);
      expect(ndjson(join(out, 'cells', def.arms[0].cell_id, 'answers.ndjson')).map(a => a.outcome)).toEqual(['budget_not_run']);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      server.stop(true); fake.stop(); proxy.stop();
    }
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
    expect(comp8.every(a => a.reader_replicates[SONNET] === 3 && a.readers.length === 3)).toBe(true);
    const sweep = s1.flatMap(c => c.arms.filter(a => a.set === 'S1-sweep'));
    expect(sweep).toHaveLength(20);
    expect(sweep.every(a => a.questions?.kind === 'stratified')).toBe(true);
    expect(s1.flatMap(c => c.arms.map(a => a.mode))).toEqual(expect.arrayContaining(['native-default', 'own-answer', 'agent', 'full-context']));
    expect(s1.find(c => c.system === 'ext-temporal-graph')!.configuration).toBe('common');
    expect(m.cells.find(c => c.set === 'S3' && c.system === 'ext-temporal-graph' && c.ingest_replicate === 1 && c.configuration === 'recipe')).toBeDefined();
    expect(m.cells.filter(c => c.set === 'S3' && c.ingest_replicate === 2)).toHaveLength(8);
    expect(m.cells.find(c => c.set === 'S2b' && c.configuration === 'common-embedder')).toBeDefined();
    expect(m.cells.find(c => c.set === 'S4')!.arms.map(a => [a.set, a.readers.length])).toEqual([['S4', 1], ['S4-slice', 3]]);
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
      expect(full.arms.map(a => [a.id, a.variant, a.readers.length])).toEqual([['whole-think', 'think', 3]]);
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
    const full = specs.find(x => x.id === 's2b.gbrain-defaults.full-surface.c0')!;
    expect(full.command).toStartWith('GBRAIN_FULL_SURFACE=1 bash eval/systems/bootstrap.sh up --system gbrain-defaults --config recipe && ');
    const runtime = specs.find(x => x.id === 's3.ext-agent-runtime.recipe')!;
    expect(runtime.setup_command).toBe('bash eval/systems/bootstrap.sh setup --system ext-agent-runtime --datasets locomo');
    expect(runtime.command).toBe('bash eval/systems/bootstrap.sh up --system ext-agent-runtime --config recipe && bun eval/runner/q1/cell.ts run --cell s3.ext-agent-runtime.recipe --out "$SHOOTOUT_OUT"; rc=$?; bash eval/systems/bootstrap.sh down --system ext-agent-runtime; exit $rc');
    const fileAgent = specs.find(x => x.id === 's3.baseline-file-agent.baseline')!;
    expect([fileAgent.setup_command, fileAgent.command]).toEqual(['bash eval/systems/bootstrap.sh setup --datasets locomo', 'bun eval/runner/q1/cell.ts run --cell s3.baseline-file-agent.baseline --out "$SHOOTOUT_OUT"']);
  });

  test('A20: a lease override sets every counted unit of its cell; other units lease the estimate per shard, and wave order still follows the estimate', () => {
    const units = campaignCells(m);
    const of = (prefix: string) => units.filter(u => u.id.startsWith(`${prefix}.c`));
    expect(of('s1.ext-temporal-graph.common').map(u => u.lease_usd)).toEqual(Array(10).fill(350));
    expect(of('s1.gbrain-defaults.shipped-defaults').map(u => u.lease_usd)).toEqual(Array(10).fill(27));
    const tg = m.cells.find(c => c.id === 's1.ext-temporal-graph.common')!;
    expect(tg.estimate.usd / tg.shards).toBeCloseTo(305, 0);
    expect(m.cells.filter(c => c.lease).map(c => c.id).sort()).toEqual(['s1.ext-graph-pipeline.common', 's1.ext-memory-bank.recipe', 's1.ext-temporal-graph.common', 's1.ext-verbatim-session.recipe',
      's1.gbrain-defaults.full-surface', 's1.gbrain-defaults.shipped-defaults', 's2b.baseline-full-context.baseline', 's2b.gbrain-defaults.shipped-defaults']);
    for (const u of units.filter(u => !m.cells.find(c => c.lease && (u.id === c.id || u.id.startsWith(`${c.id}.c`))))) {
      const c = m.cells.find(x => u.id === x.id || u.id.startsWith(`${x.id}.c`))!;
      expect(u.lease_usd).toBeCloseTo(Math.max(0.01, Math.ceil(c.estimate.usd / c.shards * 100) / 100), 2);
    }
    expect(of('s1.gbrain-defaults.shipped-defaults').map(u => u.wave)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test('A23: a shim cell that projects past the 72-hour unit limit in one VM runs as conversation shards; think is priced at its measured rate; the lease refusals get leases that cover a reservation', () => {
    const units = campaignCells(m);
    const shardsOf = (id: string) => units.filter(u => u.id.startsWith(`${id}.c`));
    expect(shardsOf('s2b.ext-graph-pipeline.recipe').map(u => [u.expected_hours, u.timeout_hours])).toEqual(Array(3).fill([40, 62]));
    expect(shardsOf('s2b.ext-temporal-graph.common').map(u => [u.expected_hours, u.timeout_hours])).toEqual(Array(2).fill([43, 67]));
    expect(shardsOf('s2b.gbrain-defaults.full-surface')).toHaveLength(2);
    expect(shardsOf('s2b.gbrain-defaults.common-embedder')).toHaveLength(2);
    expect(units.find(u => u.id === 's2b.ext-memory-bank.recipe')).toBeDefined();
    expect(units.every(u => (u.timeout_hours ?? 0) <= 72)).toBe(true);
    expect(shardsOf('s2b.ext-graph-pipeline.recipe')[1].command).toContain('--shard 1/3');
    const fs = m.cells.find(c => c.id === 's1.gbrain-defaults.full-surface')!;
    expect(fs.estimate.lines.own_answer / 600).toBeCloseTo(0.2, 1);
    expect(shardsOf('s1.gbrain-defaults.full-surface').map(u => u.lease_usd)).toEqual(Array(10).fill(20));
    expect(shardsOf('s1.gbrain-defaults.full-surface').every(u => u.command.includes('--reanswer-invalid-before 2026-10-26T00:00:00Z'))).toBe(true);
    expect(units.filter(u => u.command.includes('--reanswer-invalid-before')).map(u => u.id).filter(id => !id.startsWith('s1.gbrain-defaults.full-surface.c') && !id.startsWith('s1.gbrain-defaults.shipped-defaults.c'))).toEqual(['s2b.baseline-full-context.baseline']);
    expect(units.find(u => u.id === 's2b.baseline-full-context.baseline')!.command).toContain('--reanswer-invalid-before 2026-10-26T00:00:00Z --reanswer-outcomes reader_error');
    expect(units.filter(u => u.command.includes('--fresh-before 2026-10-26T00:00:00Z')).map(u => u.id).filter(id => id.startsWith('s1.ext-memory-bank'))).toEqual(['s1.ext-memory-bank.recipe.c0', 's1.ext-memory-bank.recipe.c1', 's1.ext-memory-bank.recipe.c3']);
    expect(units.find(u => u.id === 's2b.baseline-full-context.baseline')!.lease_usd).toBe(20);
  });

  // Value: protects=the real Particle key reaches only a particle-reading cell's VM proxy, and the campaign carries particle's reader cap; fails_when=a particle cell's VM lacks PARTICLE_API_KEY, every other unit gains it, or the campaign drops the per-model cap; why_new=U5 adds particle to PROVIDER_KEYS and the route caps; seam=none; no_claim=no counted cell reads with particle-1 (the Q1 owner's amendment adds that arm)
  test('a unit that reads with particle-1 passes PARTICLE_API_KEY to its VM proxy; no counted unit does; the campaign carries the reader@particle:particle-1 cap', () => {
    const m = loadManifest();
    expect(campaignCells(m, { smoke: true }).filter(u => u.pass?.includes('PARTICLE_API_KEY'))).toEqual([]);
    const def = cellDef('baseline-recency', 'in-process', [component({ readers: ['particle:particle-1'], reader_replicates: {} })], { configuration: 'baseline' });
    const [unit] = campaignCells({ ...m, cells: [def], smoke_cells: [] });
    expect([unit.providers, unit.pass]).toEqual([['openai', 'anthropic', 'particle'], ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PARTICLE_API_KEY']]);
    expect(campaignManifest(m).output_caps).toEqual({ extraction: 4096, reader: 2048, judge: 2048, agent: 16000, 'reader@particle:particle-1': 16000 });
  });

  test('A24: every unit the A23 price counts as answering again or rerunning fresh carries the flag that makes its resume do it', () => {
    const m = loadManifest();
    const units = campaignCells(m);
    const cmd = (id: string) => units.find(u => u.id === id)!.command;
    const freeze = '2026-10-26T00:00:00Z';
    for (const i of [4, 5]) expect(cmd(`s1.gbrain-defaults.shipped-defaults.c${i}`)).toContain(`--reanswer-invalid-before ${freeze} --reanswer-outcomes harness_invalid`);
    for (let i = 0; i < 10; i++) expect(cmd(`s1.gbrain-defaults.full-surface.c${i}`)).toContain(`--reanswer-invalid-before ${freeze}`);
    expect(cmd('s2b.baseline-full-context.baseline')).toContain(`--reanswer-invalid-before ${freeze} --reanswer-outcomes reader_error`);
    for (const id of ['s1.ext-memory-bank.recipe.c0', 's1.ext-memory-bank.recipe.c1', 's1.ext-memory-bank.recipe.c3', 's1.ext-temporal-graph.common.c8', 's1.ext-temporal-graph.common.c9']) expect(cmd(id)).toContain(`--fresh-before ${freeze}`);
    expect(units.filter(u => u.command.includes('--fresh-before')).map(u => u.id).sort()).toEqual(['s1.ext-memory-bank.recipe.c0', 's1.ext-memory-bank.recipe.c1', 's1.ext-memory-bank.recipe.c3', 's1.ext-temporal-graph.common.c8', 's1.ext-temporal-graph.common.c9']);
  });

  test('A22: graph-pipeline S1 leases $65 a shard from its measured ingest; S1 hybrid is scheduled for its question phase', () => {
    const units = campaignCells(m);
    const gp = units.filter(u => u.id.startsWith('s1.ext-graph-pipeline.common.c'));
    expect(gp.map(u => u.lease_usd)).toEqual(Array(10).fill(65));
    expect(gp.map(u => [u.expected_hours, u.timeout_hours, u.wave])).toEqual(Array(10).fill([40, 62, 1]));
    const hybrid = units.find(u => u.id === 's1.baseline-hybrid.baseline')!;
    expect([hybrid.expected_hours, hybrid.timeout_hours, hybrid.lease_usd]).toEqual([9, 16, 95.1]);
  });

  test('A23: verbatim-session S1 leases $19 a shard from its measured BEAM reading and judging; its estimate is unchanged', () => {
    const vb = campaignCells(m).filter(u => u.id.startsWith('s1.ext-verbatim-session.recipe.c'));
    expect(vb.map(u => u.lease_usd)).toEqual(Array(10).fill(19));
    expect(m.cells.find(c => c.id === 's1.ext-verbatim-session.recipe')!.estimate.usd).toBe(81.63);
  });

  test('estimates come from ledger prices and stay under the cap; blocks carry 1.5x hard caps', () => {
    expect(m.total_usd).toBeLessThan(m.cap_usd);
    for (const b of m.blocks) expect(b.cap_usd).toBeCloseTo(b.estimate_usd * 1.5, 1);
    const gb8 = m.cells.find(c => c.id === 's1.baseline-none.baseline')!;
    expect(gb8.estimate.lines.readers).toBeGreaterThan(0);
    expect(Object.keys(m.prices).some(k => k.includes('fable'))).toBe(false);
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
    for (const u of units) expect(u.pass).toEqual(u.system === 'gbrain-defaults' ? ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY'] : ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
    const probe = (u: typeof units[number]) => ({ lease_id: 'l', cell: u.id, attempt: 1, usd: u.lease_usd, entry_id: 'e', max_output_tokens: null, status: 'reserved' as const });
    const launcher = new Campaign(path, join(tmp, 'pass-state'));
    const prior = process.env.GBRAIN_EVALS_BEAM10M_SOURCE;
    delete process.env.GBRAIN_EVALS_BEAM10M_SOURCE;
    try { expect(() => launcher.launchArgv(probe(units[0]), { vm: 'ubirun-test-1-abc' })).toThrow(/GBRAIN_EVALS_BEAM10M_SOURCE is not set/); }
    finally { if (prior !== undefined) process.env.GBRAIN_EVALS_BEAM10M_SOURCE = prior; }
    const argv = launcher.launchArgv(probe(units.find(u => u.sealed && u.benchmark !== 'beam-10m')!), { vm: 'ubirun-test-1-abc' });
    expect(argv.join(' ')).toContain('--pass OPENAI_API_KEY --pass ANTHROPIC_API_KEY');
    const fd = Bun.spawnSync(['bun', 'eval/runner/scoreboard-cli.ts', 'plan', '--campaign', path, '--json'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(fd.exitCode).toBe(0);
    expect(JSON.parse(fd.stdout.toString()).cells).toHaveLength(units.length);
    mkdirSync(join(tmp, 'x'), { recursive: true });
  });
});

describe('paid dev smokes', () => {
  const m = loadManifest();

  test('smoke cells are dev-only: one LoCoMo dev conversation for every system, one BEAM-1M dev conversation for the ingest probes', () => {
    const kinds = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
    expect(m.smoke_cells.length).toBe(24);
    for (const c of m.smoke_cells) {
      expect(definitionProblems(c, kinds)).toEqual([]);
      expect(c.split).toBe('dev');
      expect(c.only_conversations).toEqual(c.benchmark === 'locomo' ? ['conv-44'] : ['1m-16']);
    }
    expect(m.smoke_cells.filter(c => c.set === 'S3-smoke-default').map(c => [c.system, c.arms.map(a => `${a.mode}:${a.readers.join(',')}`)])).toEqual(['gbrain-defaults', 'ext-extract-first', 'ext-memory-bank', 'ext-graph-pipeline', 'ext-markdown-kb', 'ext-verbatim-session', 'baseline-hybrid'].map(s => [s, ['native-default:anthropic:claude-sonnet-5-5']]));
    const locomo = m.smoke_cells.filter(c => c.set === 'S3-smoke');
    expect(new Set(locomo.map(c => c.system))).toEqual(new Set([...kinds].filter(k => k !== 'ext-agent-runtime')));
    expect(locomo.find(c => c.system === 'gbrain-defaults')!.arms.map(a => a.id)).toEqual(['component-b8000', 'whole-synthesize']);
    expect(m.smoke_cells.filter(c => c.set === 'S2b-ingest').map(c => `${c.system}:${c.configuration}:${c.ingest_sessions ?? 'all'}`)).toEqual(['ext-extract-first:common:all', 'ext-memory-bank:recipe:all', 'ext-graph-pipeline:recipe:93', 'ext-graph-pipeline:common:93', 'ext-temporal-graph:common:93']);
    expect(m.total_usd).toBe(Math.round(m.blocks.reduce((s, b) => s + b.estimate_usd, 0) * 100) / 100);
  });

  test('smoke campaign units are never sealed, fetch only their conversations and lease twice the estimate', () => {
    const smokes = campaignCells(m, { smoke: true }).filter(u => u.smoke);
    expect(smokes.map(u => u.id)).toEqual(m.smoke_cells.map(c => c.id));
    for (const u of smokes) {
      const c = m.smoke_cells.find(x => x.id === u.id)!;
      expect(u.sealed).toBe(false);
      expect(u.setup_command).toEndWith(`--datasets ${c.benchmark} --conversations ${c.only_conversations!.join(',')}`);
      expect(u.command).not.toContain('--limit');
      expect(u.lease_usd).toBeCloseTo(Math.ceil(2 * c.estimate.usd * 100) / 100, 2);
    }
  });

  test('an ingest probe with ingest_sessions writes only that prefix of each conversation and counts only its tokens', async () => {
    const fake = new FakeMemorySystem();
    const written: string[] = [];
    const ingest = fake.ingestSession.bind(fake);
    fake.ingestSession = async (ns, s, t) => { written.push(s.source_id); return ingest(ns, s, t); };
    const conv = corpus.conversations[0];
    const def = cellDef('ext-temporal-graph', 'shim', [{ id: 'retrieval-only', mode: 'retrieval-only', policy: 'fixed-evidence', readers: [] }], { ingest_sessions: 2, only_conversations: [conv.id] });
    const res = await runCell(def, { out: join(tmp, 'ingest-prefix'), ...quiet }, { corpus, system: fake });
    expect(written).toHaveLength(2);
    const receipt = JSON.parse(readFileSync(join(res.arms[0].dir, 'receipt.json'), 'utf8'));
    expect(receipt.ingest.messages).toBe(conv.sessions.slice(0, 2).reduce((n, x) => n + x.turns.length, 0));
    expect(definitionProblems({ ...def, ingest_sessions: 0 }, new Set(['ext-temporal-graph']))).toContain('ingest_sessions must be a positive whole number of sessions');
  });

  test('ingest waits for background work up to 1.5x the cell\'s expected hours by default, never just ten minutes on a long cell', async () => {
    const { finishTimeoutFor } = await import('../../eval/runner/q1/cell.ts');
    expect(finishTimeoutFor({ expected_hours: 0.01 })).toBe(600);
    expect(finishTimeoutFor({ expected_hours: 4 })).toBe(21_600);
    const fake = new FakeMemorySystem();
    const asked: number[] = [];
    const finish = fake.finishIngest.bind(fake);
    (fake as { finishIngest: (ns: string, timeoutS?: number) => ReturnType<typeof finish> }).finishIngest = async (_ns: string, t?: number) => { asked.push(t ?? -1); return finish(); };
    const def = cellDef('ext-extract-first', 'shim', [{ id: 'retrieval-only', mode: 'retrieval-only', policy: 'fixed-evidence', readers: [] }], { expected_hours: 3, only_conversations: [corpus.conversations[0].id] });
    await runCell(def, { out: join(tmp, 'finish-timeout'), ...quiet }, { corpus, system: fake });
    expect(asked).toEqual([16_200]);
  });

  test('a probe that still misses once /finish reports ready is missed at once, not polled to its deadline', async () => {
    const fake = new FakeMemorySystem();
    fake.retrieve = async () => ({ items: [], applied_settings: {}, truncated: false });
    const def = cellDef('ext-markdown-kb', 'shim', [{ id: 'retrieval-only', mode: 'retrieval-only', policy: 'fixed-evidence', readers: [] }], { only_conversations: [corpus.conversations[0].id] });
    const t0 = performance.now();
    await runCell(def, { out: join(tmp, 'probe-drain'), probeIntervalMs: 5, probeTimeoutMs: 120_000 }, { corpus, system: fake });
    expect(performance.now() - t0).toBeLessThan(60_000);
    const ingested = ndjson(join(tmp, 'probe-drain', 'runs', def.id, 'realizations.ndjson')).find(e => e.event === 'ingested');
    expect(ingested.probes.length).toBeGreaterThan(0);
    expect(ingested.probes.every((p: { status: string }) => p.status === 'missed')).toBe(true);
  });

  test('a dev cell never names a conversation outside the dev split; the corpus keeps only its conversations', async () => {
    const { devOnly } = await import('../../eval/runner/q1/cell.ts');
    const { beamFiles } = await import('../../eval/runner/memory-qa/corpus.ts');
    expect([...devOnly({ benchmark: 'locomo', split: 'dev', only_conversations: ['conv-44'] })!]).toEqual(['conv-44']);
    expect(devOnly({ benchmark: 'beam-1m', split: 'dev' })!.size).toBe(11);
    expect(devOnly({ benchmark: 'locomo', split: 'all' })).toBeNull();
    expect(() => devOnly({ benchmark: 'locomo', split: 'dev', only_conversations: ['conv-26'] })).toThrow(/not in locomo's dev split/);
    expect(beamFiles('1m', new Set(['1m-16'])).map(f => f.path)).toEqual(['beam/chats/1M/16/chat.json', 'beam/chats/1M/16/probing_questions/probing_questions.json']);
    expect(() => beamFiles('1m', new Set(['1m-99']))).toThrow(/no conversation 1m-99/);
    const def = cellDef('baseline-none', 'in-process', [component({ readers: [SONNET], reader_replicates: {} })], { configuration: 'baseline', only_conversations: [corpus.conversations[0].id] });
    const res = await runCell(def, { out: join(tmp, 'dev-only') }, { corpus, reader: scriptedReader(), judge: scriptedJudge() });
    const rows = ndjson(join(res.arms[0].dir, 'rows.ndjson'));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(r => r.conversation))).toEqual(new Set([corpus.conversations[0].id]));
  });
});

describe('probe conversation cap', () => {
  test('without a cap every conversation is probed; with one, a fixed seeded subset of that size', async () => {
    const { probedConversation } = await import('../../eval/runner/q1/cell.ts');
    const all = Array.from({ length: 600 }, (_, i) => `q${i}`);
    expect(all.every(c => probedConversation(c, all, { seed: 's' }))).toBe(true);
    const picked = all.filter(c => probedConversation(c, all, { seed: 's', conversations: 50 }));
    expect(picked).toHaveLength(50);
    expect(all.filter(c => probedConversation(c, all, { seed: 's', conversations: 50 }))).toEqual(picked);
    expect(all.filter(c => probedConversation(c, all, { seed: 't', conversations: 50 }))).not.toEqual(picked);
  });
});

describe('freeze coverage', () => {
  test('every repository module the cell runner imports is under a path in EXECUTES', async () => {
    const { EXECUTES } = await import('../../eval/runner/q1/cell.ts');
    const out = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'q1-meta-'));
    const r = Bun.spawnSync([process.execPath, 'build', 'eval/runner/q1/cell.ts', '--target', 'bun', '--outdir', out, `--metafile=${out}/meta.json`], { cwd: (await import('node:path')).resolve(import.meta.dir, '../..') });
    expect(r.exitCode).toBe(0);
    const inputs = Object.keys(JSON.parse((await import('node:fs')).readFileSync(`${out}/meta.json`, 'utf8')).inputs).filter(k => k.startsWith('eval/') || k.startsWith('docs/'));
    expect(inputs.filter(f => !EXECUTES.some((e: string) => f === e || f.startsWith(`${e}/`)))).toEqual([]);
    expect(inputs).not.toContain('eval/runner/q1/hedge.ts');
    expect(EXECUTES).not.toContain('eval/runner/q1/hedge.ts');
  });
});

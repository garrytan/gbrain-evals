/**
 * Cost and speed's cell set (eval/runner/q1/cells/cs1.ts and cs1-cells.json; docs/benchmarks/2026-11-24-cost-speed-preregistration.md),
 * keyless and offline: the committed manifest is fresh; the eight rows, their builds and launches; probes, the pilot's
 * ingest prefix, idle windows and hosting samples where each belongs; key-match scoring with no judge anywhere, and a
 * key-match cell run end to end with a judge that must never be called; the sets recounted from the world files; the
 * models against the registry entry; the plan command, the campaign and the launch check; and the full-context row's
 * one-year fit check.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bg1CampaignManifest, campaignCells, devOnly, loadCellManifest, readerFitTokenizer, readerMaxTokens, runCell } from '../../eval/runner/q1/cell.ts';
import { ALL_SETS, CELL_VM_MAX_HOURS, cellVmHours, CS1_SETS, definitionProblems, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import {
  buildCS1Manifest, CS1_CAMPAIGN, CS1_GBRAIN_BUILD, CS1_IDLE_WORLDS, CS1_MANIFEST_PATH, CS1_MODELS, CS1_PILOT_SESSIONS, CS1_REGISTRY, CS1_ROWS, CS1_WRITES_NOTHING, cs1FullContextFit, cs1ManifestText,
} from '../../eval/runner/q1/cells/cs1.ts';
import { OPUS, PARTICLE } from '../../eval/runner/q1/cells/bg1.ts';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { DEV_WORLD_END } from '../../eval/runner/bg1/dev-loop.ts';
import { Q1_CAMPAIGN_ID } from '../../eval/runner/shootout-cell.ts';
import { loadCorpus, type Corpus, type MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';

const ROOT = resolve(import.meta.dir, '../..');
const KINDS = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const m = buildCS1Manifest();
const pilot = m.addon_cells!.filter(c => c.set === 'CS1-pilot'), capacity = m.addon_cells!.filter(c => c.set === 'CS1-capacity');
const all = [...m.cells, ...m.addon_cells!];
const writes = (c: CellDefinition) => !CS1_WRITES_NOTHING.includes(c.system);
const tmp = mkdtempSync(join(tmpdir(), 'cs1-cells-'));
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'BG1_GEMINI_API_KEY'];
/** The process environment with every provider key blanked, so nothing the child runs can reach a provider. */
const bare = (extra: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEYS.includes(k))), ...Object.fromEntries(KEYS.map(k => [k, ''])), ...extra }) as Record<string, string>;
const prior = process.env.GBRAIN_EVALS_BG1_WORLD_END;
let worlds: Corpus;
beforeAll(() => {
  process.env.GBRAIN_EVALS_BG1_WORLD_END = DEV_WORLD_END;
  worlds = loadCorpus('bg1-dev', undefined, new Set([...CS1_SETS.CS1.only_conversations!, ...CS1_SETS['CS1-pilot'].only_conversations!, ...CS1_SETS['CS1-capacity'].only_conversations!]), { keyless: true });
});
afterAll(() => {
  if (prior === undefined) delete process.env.GBRAIN_EVALS_BG1_WORLD_END; else process.env.GBRAIN_EVALS_BG1_WORLD_END = prior;
  closeLedgers();
  rmSync(tmp, { recursive: true, force: true });
});

describe('cs1-cells.json', () => {
  test('the committed manifest is what cs1.ts generates, and --manifest cs1 loads it', () => {
    expect(readFileSync(CS1_MANIFEST_PATH, 'utf8')).toBe(cs1ManifestText(m));
    expect(loadCellManifest('cs1')).toEqual(JSON.parse(cs1ManifestText(m)));
  });

  test('eight counted rows, the same eight on the pilot, the six that write on the capacity check, every one valid', () => {
    const ids = (set: string) => CS1_ROWS.map(r => `${set}.${r.system}.${r.configuration}`);
    expect(m.cells.map(c => c.id)).toEqual(ids('cs1'));
    expect(pilot.map(c => c.id)).toEqual(ids('cs1-pilot'));
    expect(capacity.map(c => c.id)).toEqual(ids('cs1-capacity').filter(id => !CS1_WRITES_NOTHING.some(s => id.includes(`.${s}.`))));
    expect(m.smoke_cells).toEqual([]);
    for (const c of all) {
      expect(definitionProblems(c, KINDS)).toEqual([]);
      expect([c.block, c.benchmark, c.split, c.effort, c.only_conversations]).toEqual([c.set, 'bg1-dev', 'dev', 'medium', ALL_SETS[c.set].only_conversations]);
      expect(c.arms.every(a => a.readers.join() === [OPUS, PARTICLE].join())).toBe(true);
    }
    expect(m.campaign_id).toBe(CS1_CAMPAIGN);
    expect(Q1_CAMPAIGN_ID.test(m.campaign_id)).toBe(true);
    expect(m.units['CS1']).toHaveLength(m.cells.reduce((n, c) => n + c.shards, 0));
  });

  test('gbrain runs its newest release with shipped defaults; the memory-bank server starts from its observations bundle', () => {
    for (const c of all.filter(c => c.system === 'gbrain-defaults')) {
      expect([c.configuration, c.runner, c.gbrain_build]).toEqual(['shipped-defaults', 'shim', CS1_GBRAIN_BUILD]);
      expect(c.launch!.env.GBRAIN_SHA).toBe(CS1_GBRAIN_BUILD.commit);
      expect(c.launch!.env.GBRAIN_F6).toBeUndefined();
      expect(c.launch!.env.GBRAIN_IDLE_UPKEEP).toBeUndefined();
    }
    for (const c of all.filter(c => c.system === 'ext-memory-bank')) {
      expect([c.configuration, c.launch]).toEqual(['recipe', { env: {}, config: 'observations' }]);
      expect(c.snapshot_command).toContain('--config observations');
      expect(c.restore_command).toContain('--config observations');
    }
    for (const c of all.filter(c => c.system !== 'gbrain-defaults')) expect(c.gbrain_build ?? null).toBeNull();
    expect(all.filter(c => c.system === 'baseline-file-agent').every(c => c.runner === 'in-process' && c.arms[0].mode === 'agent')).toBe(true);
    expect(all.filter(c => c.system === 'baseline-full-context').every(c => c.arms[0].mode === 'full-context')).toBe(true);
  });

  test('probes, the pilot\'s 60-session prefix and the idle window on rows that write; hosting samples everywhere', () => {
    for (const c of all) {
      expect(c.hosting_samples).toBe(true);
      if (!writes(c)) { expect([c.probes.sample, c.probes.held_back, c.ingest_sessions, c.idle_window]).toEqual([0, undefined, undefined, undefined]); continue; }
      expect([c.probes.sample, c.probes.held_back]).toEqual([19, c.set === 'CS1-pilot' ? 20 : 21]);
      expect(c.ingest_sessions).toBe(c.set === 'CS1-pilot' ? CS1_PILOT_SESSIONS : undefined);
      if (c.set !== 'CS1') { expect(c.idle_window).toBeUndefined(); continue; }
      const w = c.idle_window!;
      expect(w.worlds).toEqual([...CS1_IDLE_WORLDS]);
      expect(w.worlds.every(x => c.only_conversations!.includes(x))).toBe(true);
      expect(w.ms).toBeGreaterThanOrEqual(w.min_ms);
      expect(w.ms).toBeLessThanOrEqual(w.max_ms);
      expect(w.jobs.length).toBeGreaterThan(0);
      expect(w.ms).toBe(c.system === 'gbrain-defaults' ? 2 * 3_600_000 : 30 * 60_000);
    }
    expect(CS1_IDLE_WORLDS).toHaveLength(2);
  });

  test('every unit fits a VM, and each pilot cell plans at most a tenth of its counted row', () => {
    for (const c of all) expect(cellVmHours(c.expected_hours)).toBeLessThanOrEqual(CELL_VM_MAX_HOURS);
    for (const p of pilot) expect(p.estimate.usd).toBeLessThanOrEqual(m.cells.find(c => c.system === p.system)!.estimate.usd / 10);
    for (const c of capacity) expect(c.estimate.usd).toBe(0);
  });
});

describe('key-match scoring', () => {
  test('every cell is key-match with no canonical judge and no frontier judge or repeat on any arm', () => {
    for (const c of all) {
      expect([c.scoring, c.descriptive_view]).toEqual(['key-match', false]);
      for (const a of c.arms) expect([a.frontier, a.judge_repeats]).toEqual([null, null]);
    }
  });

  test('definitionProblems refuses key-match beside a judge, and an unknown scoring', () => {
    const c = m.cells.find(x => x.system === 'baseline-none')!;
    const rule = /scoring is key-match or absent/;
    expect(definitionProblems({ ...c, descriptive_view: undefined }, KINDS).some(p => rule.test(p))).toBe(true);
    expect(definitionProblems({ ...c, arms: c.arms.map(a => ({ ...a, frontier: { judges: ['openai:gpt-6-astra'], sample: null, per_reader: false, readers: null } as unknown as CellDefinition['arms'][number]['frontier'] })) }, KINDS).some(p => rule.test(p))).toBe(true);
    expect(definitionProblems({ ...c, scoring: 'llm' as unknown as 'key-match' }, KINDS).some(p => rule.test(p))).toBe(true);
  });

  test('a key-match cell runs end to end and never calls a judge', async () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
    const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path: 'test/eval/fixtures/q1-cell/locomo-shaped.json', sha256: 'fixture' }], revision: 'repo', license: 'MIT' } };
    const NO_META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
    const read: string[] = [];
    const reader: ChatLike = { async chat(model): Promise<ChatResult> { read.push(model); return { text: 'The history does not say.', input_tokens: 10, output_tokens: 5, cached: false, ...NO_META }; } };
    let judged = 0;
    const judge: ChatLike = { async chat() { judged++; throw new Error('a key-match cell called a judge'); } };
    const base = m.cells.find(x => x.system === 'baseline-none')!;
    const def: CellDefinition = { ...base, only_conversations: undefined, selection: { kind: 'per-conversation', per_conversation: 2, seed: 'cost-speed-1' } };
    const out = join(tmp, 'key-match');
    const res = await runCell(def, { out, probeIntervalMs: 5, probeTimeoutMs: 2000 }, { corpus, system: new FakeMemorySystem(), reader, judge });
    expect(res.status).toBe('complete');
    expect(judged).toBe(0);
    expect(read.length).toBe(2 * 3 * 2);
    expect(new Set(read)).toEqual(new Set([OPUS, PARTICLE]));
    const dir = join(out, 'cells', def.arms[0].cell_id);
    const answers = readFileSync(join(dir, 'answers.ndjson'), 'utf8').trim().split('\n');
    expect(answers).toHaveLength(12);
    const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
    expect(receipt.instrument.judge).toBeNull();
  }, 60_000);
});

describe('the sets and the models', () => {
  test('sessions, messages and questions recounted from the world files', () => {
    for (const s of Object.values(CS1_SETS)) {
      const convs = worlds.conversations.filter(c => s.only_conversations!.includes(c.id));
      expect(convs.map(c => c.id).sort()).toEqual([...s.only_conversations!].sort());
      expect(s.messages).toBe(convs.reduce((n, c) => n + c.sessions.reduce((k, x) => k + x.turns.length, 0), 0));
      expect(s.sessions).toBe(Math.round(convs.reduce((n, c) => n + c.sessions.length, 0) / convs.length));
      expect(s.questions).toBe(s.conversations * (s.selection as { per_conversation: number }).per_conversation);
      expect(convs.every(c => worlds.questions.filter(q => q.conversation === c.id).length >= (s.selection as { per_conversation: number }).per_conversation)).toBe(true);
    }
    expect(worlds.conversations.find(c => c.id === 'bg1-dev-11')!.sessions.length).toBeGreaterThan(CS1_PILOT_SESSIONS);
  });

  test('a cell naming worlds outside stage 1\'s three loads those worlds; stage 1\'s cells load as before', () => {
    expect([...devOnly(m.cells[0])!]).toEqual([...CS1_SETS.CS1.only_conversations!]);
    expect(devOnly({ benchmark: 'bg1-dev', split: 'dev', only_conversations: ['bg1-dev-01'] })).toBeNull();
    expect(devOnly({ benchmark: 'bg1-dev', split: 'dev' })).toBeNull();
  });

  test('every model the cells call is in the registry entry with its role, and no judge', () => {
    const entry = (JSON.parse(readFileSync(join(ROOT, CS1_REGISTRY), 'utf8')) as { experiments: Array<{ models?: Array<{ model: string; role: string }> }> }).experiments.find(e => e.models)!;
    const bare = (x: string) => x.slice(x.indexOf(':') + 1);
    const role = (r: string) => (r === 'under-test' ? 'reader' : r);
    expect(CS1_MODELS.map(x => [bare(x.model), x.role]).sort()).toEqual(entry.models!.map(x => [bare(x.model), role(x.role)]).sort());
    expect(m.models.some(x => (x.role as string) === 'judge')).toBe(false);
    expect(m.readers).toEqual([OPUS, PARTICLE]);
  });
});

describe('planning and launch', () => {
  test('plan --manifest cs1 runs keyless and writes a campaign the launch check accepts', () => {
    const plain = spawnSync('bun', ['eval/runner/q1/cell.ts', 'plan', '--manifest', 'cs1'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: bare() });
    expect(plain.status).toBe(0);
    const units = ['cs1-pilot.baseline-hybrid.baseline', 'cs1-capacity.ext-memory-bank.recipe', 'cs1.gbrain-defaults.shipped-defaults.c1'];
    const priced = new Map(campaignCells(m, { smoke: true, addons: true }).map(c => [c.id, c.lease_usd]));
    const cap = Math.round(units.reduce((n, u) => n + priced.get(u)!, 0) * 100) / 100;
    const file = join(tmp, 'units.json'), out = join(tmp, 'campaign.json');
    writeFileSync(file, JSON.stringify({ campaign_id: 'q1-scoreboard-cost-speed-t', cap_usd: cap, units, paid_window: 'CS1-T' }));
    const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'plan', '--manifest', 'cs1', '--units', file, '--campaign-out', out], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: bare({ GBRAIN_EVALS_BG1_WORLD_END: DEV_WORLD_END }) });
    expect(r.status).toBe(0);
    const c = JSON.parse(readFileSync(out, 'utf8'));
    expect(c.cells.map((x: { id: string }) => x.id).sort()).toEqual([...units].sort());
    for (const cell of c.cells) {
      expect(cell.command).toContain(`--cell ${cell.id.replace(/\.c\d$/, '')} --manifest cs1 `);
      expect(cell.command).toContain(`--paid-window CS1-T --window-cap-usd ${cap} --out`);
      expect(cell.pass ?? []).not.toContain('BG1_GEMINI_API_KEY');
    }
    expect(bg1LaunchProblems({ ...c, blocks: {} })).toEqual([]);
    expect(bg1LaunchProblems({ ...c, blocks: {}, cells: c.cells.map((x: { lease_usd: number }, i: number) => (i ? x : { ...x, lease_usd: x.lease_usd + 1 })) }).join()).toContain('cs1-cells.json prices it at');
    const bg1 = bg1CampaignManifest(loadCellManifest('bg1'), { units: { campaign_id: 'q1-scoreboard-bg1-t', cap_usd: cap, units: ['bg1.baseline-none.baseline.c0'], paid_window: 'CS1-T' }, worldEnd: DEV_WORLD_END }).cells[0];
    expect(bg1LaunchProblems({ ...c, blocks: {}, cells: [...c.cells, bg1] }).join()).toContain('each set runs in its own campaign');
  }, 120_000);
});

describe('the full-context row\'s one-year fit check', () => {
  test('both profiles for both readers on bg1-dev-01, with the runner\'s tokenizer and output limit', () => {
    const world = loadCorpus('bg1-dev', undefined, new Set(['bg1-dev-01']), { keyless: true });
    const conv = world.conversations[0], q = world.questions.find(x => x.conversation === conv.id)!;
    const fit = Object.fromEntries((['heavy', 'light'] as const).flatMap(p => [OPUS, PARTICLE].map(r => [`${p}|${r}`, cs1FullContextFit(conv, q, p, r, { tokenizer: readerFitTokenizer(r), outputTokens: readerMaxTokens(r) })])));
    for (const f of Object.values(fit)) {
      expect(f.messages).toBeGreaterThanOrEqual(f.profile === 'heavy' ? 24_000 : 2_580);
      expect(f.prompt_tokens).toBeGreaterThan(0);
    }
    expect(fit[`heavy|${OPUS}`].fits).toBe(false);
    expect(fit[`heavy|${OPUS}`].sessions).toBeGreaterThan(conv.sessions.length);
    expect(fit[`light|${OPUS}`].prompt_tokens).toBeLessThan(fit[`heavy|${OPUS}`].prompt_tokens);
    expect(fit[`heavy|${PARTICLE}`].fits).toBe(false);
    expect([fit[`light|${OPUS}`].fits, fit[`light|${PARTICLE}`].fits]).toEqual([true, true]);
  }, 120_000);
});

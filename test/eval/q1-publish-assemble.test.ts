/**
 * publish.ts assemble() end to end on synthetic campaign state, keyless: cells run with the fake system over protocol
 * v1 on the invented LoCoMo-shaped fixture, written as lease directories under several state directories, then merged
 * in process through the assembler's merge seam (cell.ts publishCell, what `cell.ts merge` runs at a launch tree).
 * Covers an F6-shaped config: two cell manifests (the run's own first, a reused one second, an id in both taking the
 * first's definition), a source whose cells span state directories, a sharded cell with one shard settled without a
 * receipt and one never run, the reused rows, an appendix that still shows a cell the main table lists as not run,
 * one headline set, and the preregistered anchor arm. Lease ids and campaign ids here are invented.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { publishCell, runCell, selectCellQuestions } from '../../eval/runner/q1/cell.ts';
import { ALL_SETS, type ArmDefinition, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { assemble, type Publication } from '../../eval/runner/q1/publish.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { FakeMemorySystem, FAKE_CAPABILITIES, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { FRONTIER_READERS } from '../../eval/runner/systems/baselines.ts';
import type { CampaignManifest } from '../../eval/runner/scoreboard.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'q1-assemble-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [], revision: 'repo', license: 'MIT' } };
const byText = new Map(raw.questions.map(q => [q.question, q]));
const META = { finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
const reader: ChatLike = {
  async chat(_model, prompt): Promise<ChatResult> {
    const q = byText.get(/Question: (.*)\n/.exec(prompt)?.[1] ?? '');
    return { text: q && !q.abstention && prompt.includes(q.answer!) ? `From the history: ${q.answer}.` : 'The history does not say.', input_tokens: 10, output_tokens: 5, cached: false, ...META };
  },
};
const judge: ChatLike = { async chat(): Promise<ChatResult> { return { text: 'yes', input_tokens: 10, output_tokens: 1, cached: false, ...META }; } };

/** A cell definition on a manifest set with packed 8,000-token arms. */
function cell(set: 'S1' | 'D8', system: string, configuration: string, arms: string[], shards = 1): CellDefinition {
  const id = `${set.toLowerCase()}.${system}.${configuration}`;
  return {
    schema: 'gbrain-evals/q1-cell/v1', id, set, block: 'T1', benchmark: ALL_SETS[set].benchmark, split: 'sealed', selection: { kind: 'all' }, exclusions: [], system, configuration, runner: 'shim',
    ingest_replicate: 1, effort: 'medium', canonical_instrument: 'locomo', probes: { sample: 0, seed: 'test' }, shards, expected_hours: 1, estimate: { usd: 0, lines: {} },
    arms: arms.map((a): ArmDefinition => ({ id: a, cell_id: `${id}.${a}`, set, arm: 'component', mode: 'packed', policy: 'fixed-evidence', budget: 8000, questions: null, readers: [...FRONTIER_READERS], reader_replicates: {}, frontier: null, judge_repeats: null, label: a })),
  } as CellDefinition;
}

const gb = cell('S1', 'gbrain-defaults', 'f6-master', ['a', 'p'], 3);
const tg = cell('S1', 'ext-temporal-graph', 'shipped-0.31', ['component-b8000'], 3);
const hybridOwn = cell('S1', 'baseline-hybrid', 'baseline', ['component-b8000']);
const hybridReused = cell('S1', 'baseline-hybrid', 'baseline', ['component-b8000', 'component-b2000']);
const d8 = cell('D8', 'gbrain-defaults', 'f6-master', ['a', 'p']);
const memoryBank = cell('S1', 'ext-memory-bank', 'recipe', ['component-b8000']);
const markdownKb = cell('S1', 'ext-markdown-kb', 'recipe', ['component-b8000']);
const extractFirst = cell('S1', 'ext-extract-first', 'common', ['component-b8000']);

const manifest = (cells: CellDefinition[], sets: Array<'S1' | 'D8'>) => ({ schema: 'gbrain-evals/q1-cell-manifest/v1', readers: [...FRONTIER_READERS], effort: 'medium', sets: sets.map(s => ALL_SETS[s]), cells, smoke_cells: [] });
const write = (name: string, value: unknown) => { const p = join(tmp, name); writeFileSync(p, JSON.stringify(value, null, 2)); return p; };
const ownManifest = write('own-cells.json', manifest([gb, tg, hybridOwn, d8], ['S1', 'D8']));
const reusedManifest = write('reused-cells.json', manifest([memoryBank, markdownKb, extractFirst, hybridReused], ['S1']));
const ownCampaign = write('own-campaign.json', { campaign_id: 'f6-test' });
const reusedCampaign = write('reused-campaign.json', { campaign_id: 'q1-test' });
const results = join(tmp, 'results');

const leases = new Map<string, Array<Record<string, string>>>();
let n = 0;
/** A settled lease of `unit` in state `dir`; `run` fills the lease directory the way a pulled unit leaves it. */
async function settle(dir: string, unit: string, run: ((out: string) => Promise<void>) | null) {
  const lease = `${unit}-lease${++n}`;
  const at = `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00Z`;
  leases.set(dir, [...(leases.get(dir) ?? []), { event: 'reserved', lease_id: lease, cell: unit, at }, { event: 'settled', lease_id: lease, at }]);
  const out = join(results, dir, 'results', unit, lease);
  mkdirSync(out, { recursive: true });
  if (run) await run(out);
}
const ran = (def: CellDefinition, shard?: number) => async (out: string) => {
  const server = serveProtocol(new FakeMemorySystem());
  try {
    await runCell(def, { out, systemUrl: server.url, probeIntervalMs: 5, probeTimeoutMs: 2000, ...(shard === undefined ? {} : { shard: { index: shard, count: def.shards } }) }, { corpus, reader, judge });
  } finally { server.stop(); }
};

const merges: Array<{ tree: string; cell: string; from: string[] }> = [];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const opts = {
  tree: () => ROOT,
  merge: (tree: string, def: CellDefinition, from: string[], out: string) => {
    merges.push({ tree, cell: def.id, from: from.map(f => f.slice(results.length + 1)) });
    const configs = new Map(def.arms.map(a => { const t = readFileSync(join(from[0], 'cells', a.cell_id, 'run-config.json'), 'utf8'); return [a.id, { text: t, sha: sha(t) }]; }));
    publishCell(def, def.arms, from, out, { instrument: instrumentFor('locomo'), selected: selectCellQuestions(corpus.questions, { kind: 'all' }), invalidReasons: [], configs, capabilities: FAKE_CAPABILITIES, stopped: null, maxAttempts: 3 });
  },
};

function config(over: Partial<Publication> = {}): Publication {
  return {
    campaign_id: 'f6-test', campaign_hash: '0'.repeat(64),
    published: { branch: 'b', path: 'p', url: 'https://example.invalid/receipt', commit: null, sha256: null, aggregates_only: true },
    gbrain: { commit: '0ccf2bdd4f42ed50be4cfb515eaa804ddb4b7049', version: '0.60.493.0', date: '2026-10-29', resolved_search_mode: 'tokenmax', footnote: 'Test pin.' },
    hedge_classifier: 'none', statistics: { alpha: 0.05, draws: 99, descriptive_draws: 99, seed: 1 }, pending: [], not_run_reason: 'no settled unit of this cell wrote a receipt',
    cells: [ownManifest, reusedManifest], headline_set: 'S1', anchors: [`${gb.id}.p`],
    sources: [
      {
        campaign: ownCampaign, launch_tree: 'own-launch',
        states: [
          { dir: 'own', units: [`${gb.id}.c0`, `${tg.id}.c0`, `${tg.id}.c1`, hybridOwn.id] },
          { dir: 'own-a1', units: [`${gb.id}.c1`, `${gb.id}.c2`] },
        ],
      },
      { campaign: ownCampaign, launch_tree: 'own-launch', systems: ['gbrain-defaults'], states: [{ dir: 'own-a1', units: [d8.id] }], appendix: { name: 'partial cells', dir: 'partial', reason: 'settled without finishing; no comparison' } },
      { campaign: reusedCampaign, launch_tree: 'reused-launch', systems: ['ext-memory-bank'], states: [{ dir: 'reused', units: [memoryBank.id] }] },
    ],
    sensitivity: [], not_run: { [markdownKb.id]: 'projected too long (reused reason)', [d8.id]: 'partial: rows in the appendix' }, product_outcomes: [], retired: [],
    pins: { 'baseline-hybrid': 'harness baseline' }, disclosures: [], render_targets: [],
    ...over,
  };
}

describe('assemble with several manifests and states (F6 shape)', () => {
  let campaign: CampaignManifest;
  const out = join(tmp, 'receipt');

  test('setup: settle synthetic units across three state directories and assemble', async () => {
    await settle('own', `${gb.id}.c0`, ran(gb, 0));
    await settle('own', `${gb.id}.c1`, async o => { mkdirSync(join(o, 'cells', gb.arms[0].cell_id), { recursive: true }); writeFileSync(join(o, 'cells', gb.arms[0].cell_id, 'receipt.json'), '{"degraded": true}'); });
    await settle('own-a1', `${gb.id}.c1`, ran(gb, 1));
    await settle('own-a1', `${gb.id}.c2`, ran(gb, 2));
    await settle('own', `${tg.id}.c0`, ran(tg, 0));
    await settle('own', `${tg.id}.c1`, null);
    await settle('own', hybridOwn.id, ran(hybridOwn));
    await settle('own-a1', d8.id, ran(d8));
    await settle('reused', memoryBank.id, ran(memoryBank));
    await settle('reused', extractFirst.id, ran(extractFirst));
    for (const [dir, ev] of leases) writeFileSync(join(results, dir, 'leases.ndjson'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
    campaign = assemble(config(), results, out, join(tmp, 'trees'), opts);
    expect(existsSync(join(out, 'campaign.json'))).toBe(true);
  });

  test("every cell merges once at its source's launch tree, from the listed units' states only", () => {
    const by = Object.fromEntries(merges.map(m => [m.cell, m.from.map(f => f.split('/').slice(0, 3).join('/'))]));
    expect(by[gb.id]).toEqual([`own/results/${gb.id}.c0`, `own-a1/results/${gb.id}.c1`, `own-a1/results/${gb.id}.c2`]);
    expect(merges.every(m => m.tree === ROOT)).toBe(true);
    expect(Object.keys(by).sort()).toEqual([d8.id, gb.id, hybridOwn.id, memoryBank.id, tg.id].sort());
  });

  test('a sharded cell publishes its settled shards and leaves the rest unscored', () => {
    expect(merges.find(m => m.cell === tg.id)!.from.map(f => f.split('/')[2])).toEqual([`${tg.id}.c0`]);
    const arm = tg.arms[0].cell_id;
    const receipt = JSON.parse(readFileSync(join(out, 'cells', arm, 'receipt.json'), 'utf8'));
    const conversations = [...new Set(corpus.questions.map(q => q.conversation))].sort();
    const shard0 = corpus.questions.filter(q => q.conversation === conversations[0]).length;
    expect(shard0).toBeGreaterThan(0);
    expect(shard0).toBeLessThan(corpus.questions.length);
    expect(receipt.selection.questions).toBe(corpus.questions.length);
    expect(receipt.counts.rows).toBe(shard0);
    expect(receipt.run_status).toBe('partial');
    expect(campaign.cells.find(c => c.cell_id === arm)).toMatchObject({ status: 'complete', pin: 'bundle lock 4ce9b216, capabilities 0ae56345' });
  });

  test("the first manifest lists every cell; a later one only its covered or not_run cells, and a shared id keeps the first's definition", () => {
    expect(campaign.cells.map(c => c.cell_id)).toEqual([
      `${gb.id}.a`, `${gb.id}.p`, tg.arms[0].cell_id, `${hybridOwn.id}.component-b8000`, `${d8.id}.a`, `${d8.id}.p`,
      `${memoryBank.id}.component-b8000`, `${markdownKb.id}.component-b8000`,
    ]);
    expect(campaign.cells.find(c => c.cell_id === `${markdownKb.id}.component-b8000`)).toMatchObject({ status: 'not-run', not_run_reason: 'projected too long (reused reason)' });
    expect(campaign.cells.find(c => c.cell_id === `${memoryBank.id}.component-b8000`)!.status).toBe('complete');
    expect(campaign.cells.find(c => c.cell_id === `${hybridOwn.id}.component-b8000`)!.status).toBe('complete');
    expect(existsSync(join(out, 'cells', `${hybridOwn.id}.component-b2000`))).toBe(false);
  });

  test('a not_run cell is not run in the main table and still shown in its appendix', () => {
    expect(campaign.cells.filter(c => c.set === 'D8').map(c => [c.status, c.not_run_reason])).toEqual([['not-run', 'partial: rows in the appendix'], ['not-run', 'partial: rows in the appendix']]);
    expect(campaign.appendix!.map(a => [a.cell_id, a.dir, a.appendix, a.pin])).toEqual([
      [`${d8.id}.a`, `appendix/partial/${d8.id}.a`, 'partial cells', 'GBrain 0.60.493.0 (0ccf2bdd, 2026-10-29)'],
      [`${d8.id}.p`, `appendix/partial/${d8.id}.p`, 'partial cells', 'GBrain 0.60.493.0 (0ccf2bdd, 2026-10-29)'],
    ]);
    expect(existsSync(join(out, 'appendix', 'partial', `${d8.id}.p`, 'answers.ndjson'))).toBe(true);
  });

  test('one headline set, the named arm as anchor and headline row, and no whole-system family without a whole-system anchor', () => {
    expect(campaign.sets.map(s => [s.id, s.role, s.claim_min_clusters])).toEqual([['S1', 'headline', 9], ['D8', 'public', 0]]);
    expect(campaign.cells.filter(c => c.anchor).map(c => [c.cell_id, c.headline])).toEqual([[`${gb.id}.p`, true]]);
    const comparators = [tg.arms[0].cell_id, `${hybridOwn.id}.component-b8000`, `${memoryBank.id}.component-b8000`, `${markdownKb.id}.component-b8000`];
    expect(campaign.families.map(f => [f.id, f.anchor, f.comparators])).toEqual([['F1', `${gb.id}.p`, comparators], ['F3', `${gb.id}.p`, comparators]]);
    expect(campaign.pins.map(p => p.system).sort()).toEqual(['ext-markdown-kb', 'ext-memory-bank', 'ext-temporal-graph']);
  });

  test('a unit listed under a state with no settled lease refuses', () => {
    const bad = config();
    bad.sources[0].states![1].units.push(`${gb.id}.c9`);
    expect(() => assemble(bad, results, join(tmp, 'bad'), join(tmp, 'trees'), opts)).toThrow(`state own-a1 has no settled lease for ${gb.id}.c9, which publication.json says holds its final rows`);
  });

  test('no marked anchor on the headline set, an anchor that is not a GBrain arm, or an unknown headline set refuses', () => {
    expect(() => assemble(config({ anchors: [] }), results, join(tmp, 'bad'), join(tmp, 'trees'), opts)).toThrow(/no gbrain-defaults 8k component cell on S1 is marked anchor/);
    expect(() => assemble(config({ anchors: [tg.arms[0].cell_id] }), results, join(tmp, 'bad'), join(tmp, 'trees'), opts)).toThrow(/anchors names .*, which is no answering gbrain-defaults arm/);
    expect(() => assemble(config({ headline_set: 'S9' }), results, join(tmp, 'bad'), join(tmp, 'trees'), opts)).toThrow(/headline_set S9 is no headline set/);
  });
});

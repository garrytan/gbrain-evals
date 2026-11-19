import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BN10_ASSUMPTIONS, definitionProblems, estimateCell, frontierJudgesFor, PER_READER_JUDGE_SETTINGS, policyKey, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { BN10_DRY_RUN_CAP_USD, BN10_MANIFEST_PATH, bn10ManifestText, buildBN10Manifest, OPUS, PARTICLE, SOL } from '../../eval/runner/q1/cells/bn10.ts';
import { loadCellManifest, runCell } from '../../eval/runner/q1/cell.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import type { PublicQuestion, RetrievalPolicy } from '../../eval/runner/systems/types.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';

const ROOT = join(import.meta.dir, '..', '..');
const KINDS = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const m = buildBN10Manifest();
const f6p = (id: string) => JSON.parse(readFileSync(join(ROOT, 'eval/runner/q1/cells/f6-cells.json'), 'utf8')).cells.find((c: CellDefinition) => c.id === 's1.gbrain-defaults.f6-master').arms.find((a: { id: string }) => a.id === id);

describe('bn10-cells.json', () => {
  test('the committed manifest is what bn10.ts generates, and --manifest bn10 loads it', () => {
    expect(readFileSync(BN10_MANIFEST_PATH, 'utf8')).toBe(bn10ManifestText(m));
    expect(loadCellManifest('bn10').cells.map(c => c.id)).toEqual(m.cells.map(c => c.id));
  });

  test('one counted cell on S1 and one dry-run cell on 1m-16, each with arms P, A0 and whole read by claude-opus-5-5 and gpt-6.2-sol', () => {
    expect(m.cells.map(c => c.id)).toEqual(['s1.gbrain-defaults.bn10-newest']);
    expect(m.smoke_cells.map(c => c.id)).toEqual(['s2b-ingest.gbrain-defaults.bn10-newest']);
    for (const c of [...m.cells, ...m.smoke_cells]) {
      expect(definitionProblems(c, KINDS)).toEqual([]);
      expect(c.arms.map(a => [a.id, a.mode, a.policy, a.budget, a.readers])).toEqual([
        ['p', 'packed', 'fixed-evidence', 8000, [OPUS, SOL]], ['a0', 'packed', 'fixed-evidence', 8000, [OPUS, SOL]], ['whole', 'native-default', 'vendor-default', null, [OPUS, SOL]]]);
      expect(c.launch?.env.GBRAIN_F6).toBe('1');
      expect(Number(c.launch?.env.GBRAIN_F6_EXTRACT_CAP_USD)).toBeGreaterThan(0);
    }
    expect(m.cells[0].shards).toBe(10);
  });

  test('the stack runs the gbrain commit package.json pins', () => {
    const pin = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies.gbrain as string;
    expect(pin.endsWith(`#${BN10_ASSUMPTIONS.gbrain_sha}`)).toBe(true);
    for (const c of [...m.cells, ...m.smoke_cells]) expect(c.launch?.env.GBRAIN_SHA).toBe(BN10_ASSUMPTIONS.gbrain_sha);
  });

  test('P and A0 carry F6\'s retrieval identities; whole is a bare query under P\'s six search keys', () => {
    const [p, a0, whole] = m.cells[0].arms;
    expect([p.retrieval, a0.retrieval]).toEqual([f6p('p').retrieval, f6p('a0').retrieval]);
    expect(whole.retrieval).toEqual({ op: 'query', args: {}, overlay: f6p('p').retrieval.overlay });
    expect(policyKey(whole)).toMatch(/^vendor-default@query-[0-9a-f]{12}$/);
    expect(new Set(m.cells[0].arms.map(policyKey)).size).toBe(3);
  });

  test('a native-default identity still needs an F6 stack, and an agent arm still carries none', () => {
    const noF6 = structuredClone(m.cells[0]) as CellDefinition;
    noF6.launch!.env.GBRAIN_F6 = '0';
    expect(definitionProblems(noF6, KINDS).join(' ')).toContain('a retrieval identity runs only on a gbrain-defaults stack started with GBRAIN_F6=1');
    const agent = structuredClone(m.cells[0]) as CellDefinition;
    agent.arms[2].mode = 'agent';
    expect(definitionProblems(agent, KINDS).join(' ')).toContain('only packed, retrieval-only and native-default arms carry a retrieval identity');
  });

  test('each arm is judged by the reader\'s other family, and particle-1 re-reads every arm, whole included', () => {
    for (const a of [...m.cells, ...m.smoke_cells].flatMap(c => c.arms)) {
      expect(a.frontier?.per_reader).toBe(true);
      expect(a.frontier?.settings).toEqual(PER_READER_JUDGE_SETTINGS);
      expect(frontierJudgesFor(a, OPUS)).toEqual(['openai:gpt-6.1-sol']);
      expect(frontierJudgesFor(a, SOL)).toEqual(['anthropic:claude-opus-5-5']);
    }
    expect(m.frontier_judges).toEqual({ [OPUS]: 'openai:gpt-6.1-sol', [SOL]: 'anthropic:claude-opus-5-5', [PARTICLE]: 'openai:gpt-6.1-sol' });
    expect(m.reread_plans.map(p => [p.arm_cell_id, p.reader, p.judges])).toEqual(['s1.gbrain-defaults.bn10-newest', 's2b-ingest.gbrain-defaults.bn10-newest']
      .flatMap(c => ['p', 'a0', 'whole'].map(a => [`${c}.${a}`, PARTICLE, ['openai:gpt-4.1-mini', 'openai:gpt-6.1-sol']])));
  });

  test('the dry run and its re-reads fit the preregistered dry-run cap together', () => {
    expect(m.dry_run_cap_usd + m.dry_run_reread_cap_usd).toBeCloseTo(BN10_DRY_RUN_CAP_USD, 2);
    expect(m.dry_run_estimate_usd).toBeLessThanOrEqual(BN10_DRY_RUN_CAP_USD);
    expect(m.smoke_cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0)).toBeLessThanOrEqual(m.dry_run_cap_usd);
  });
});

describe('the whole arm\'s identity on the runner', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bn10-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
  const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path: 'test/eval/fixtures/q1-cell/locomo-shaped.json', sha256: 'fixture' }], revision: 'r' } } as Corpus;
  const chat = (text: string): ChatLike => ({ async chat(): Promise<ChatResult> { return { text, input_tokens: 10, output_tokens: 5, cached: false, finish: null, usage: null, response_model: null, attempt_errors: [] }; } });
  class Recording extends FakeMemorySystem {
    calls: Array<{ name: string; mode: string; settings: unknown }> = [];
    async retrieve(ns: string, q: PublicQuestion, p: RetrievalPolicy) { this.calls.push({ name: p.name, mode: p.mode, settings: p.settings }); return super.retrieve(ns, q, { ...p, settings: {} }); }
  }

  test('whole retrieves as vendor-default with a bare query and P\'s overlay; P keeps fixed-evidence', async () => {
    const cell = m.smoke_cells[0];
    const { only_conversations: _, ...rest } = cell;
    const base = { ...rest, selection: { kind: 'all' as const }, shards: 1, arms: cell.arms.filter(a => a.id !== 'a0').map(a => ({ ...a, readers: [OPUS], frontier: null })) };
    const def: CellDefinition = { ...base, estimate: estimateCell(base) };
    const system = new Recording();
    await runCell(def, { out: join(tmp, 'whole'), probeIntervalMs: 5, probeTimeoutMs: 2000 }, { corpus, system, reader: chat('The history does not say.'), judge: chat('no') });
    const [p, whole] = def.arms;
    const of = (a: typeof p) => system.calls.filter(c => c.name === `fake:${policyKey(a)}`);
    expect(of(whole).length).toBeGreaterThan(0);
    expect(new Set(of(whole).map(c => c.mode))).toEqual(new Set(['vendor-default']));
    expect(of(whole)[0].settings).toEqual({ op: 'query', args: {}, overlay: p.retrieval!.overlay });
    expect(new Set(of(p).map(c => c.mode))).toEqual(new Set(['fixed-evidence']));
  });
});

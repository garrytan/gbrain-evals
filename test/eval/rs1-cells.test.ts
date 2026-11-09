import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { keptUnit, requiredJudges, runConfigIdentity, runConfigText } from '../../eval/runner/q1/cell.ts';
import { ALL_SETS, buildManifest, definitionProblems, F6_ASSUMPTIONS, priceOf, frontierJudgeOf, frontierJudgesFor, ingestRate, MANIFEST_PATH, manifestText, runsF6, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { buildF6Manifest, F6_MANIFEST_PATH, f6ManifestText, peakReservationUsd } from '../../eval/runner/q1/cells/f6.ts';
import { CHAT_PRICE_OVERRIDES, reservationUsd } from '../../eval/runner/budget-ledger.ts';
import { buildRS1Manifest, generateRS1Cells, loadRS1Manifest, OPUS, PARTICLE, RS1_JUDGE_BY_READER, rs1JudgeOf, RS1_MANIFEST_PATH, rs1ManifestText, SOL, stage1OverCap } from '../../eval/runner/q1/cells/rs1.ts';
import type { Rs1Manifest } from '../../eval/runner/memory-qa/corpus.ts';

const ROOT = join(import.meta.dir, '..', '..');
const KINDS = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const m = buildRS1Manifest();
const INSTRUMENT = { id: 'beam-rubric', canonical_judge: 'openai:gpt-4.1-mini' };
const gbrain = () => structuredClone(m.cells.find(c => c.system === 'gbrain-defaults')!) as CellDefinition;

describe('rs1-cells.json', () => {
  test('the committed manifest is what rs1.ts generates', () => {
    expect(readFileSync(RS1_MANIFEST_PATH, 'utf8')).toBe(rs1ManifestText(m));
  });

  test('four counted cells and four stage 1 cells, by role, with the preregistered readers, launch units and pins', () => {
    expect(m.cells.map(c => c.id)).toEqual(['rs1.gbrain-defaults.rs1-stable', 'rs1.ext-memory-bank.recipe', 'rs1.ext-extract-first.common', 'rs1.baseline-none.baseline']);
    expect(m.smoke_cells.map(c => c.arms[0].set)).toEqual(['RS1-dev2', 'RS1-dev2', 'RS1-dev2', 'RS1-dev2']);
    for (const c of [...m.cells, ...m.smoke_cells]) {
      expect(definitionProblems(c, KINDS)).toEqual([]);
      expect(c.arms.map(a => [a.mode, a.budget, a.readers])).toEqual([['packed', 8000, [OPUS, SOL]]]);
      expect(c.effort).toBe('medium');
    }
    for (const c of m.cells) expect([c.shards, c.kept_units]).toEqual([7, 5]);
    const g = gbrain();
    expect(g.arms[0].id).toBe('p');
    const f6 = JSON.parse(readFileSync(join(ROOT, 'eval/runner/q1/cells/f6-cells.json'), 'utf8')).cells.find((c: CellDefinition) => c.system === 'gbrain-defaults').arms.find((a: { id: string }) => a.id === 'p');
    expect([g.arms[0].retrieval, g.arms[0].policy]).toEqual([f6.retrieval, f6.policy]);
    expect(g.launch?.env.GBRAIN_F6).toBe('1');
    expect(g.launch?.env.GBRAIN_SHA).toBe('27f8b9d6287c2ba635532c7d3bc015c50e1d769b');
    expect(Number(g.launch?.env.GBRAIN_F6_EXTRACT_CAP_USD)).toBeGreaterThan(0);
    expect(m.waves.A.length).toBe(16);
  });

  test('system rows carry per-reader frontier judging; the floor carries the protocol judge only', () => {
    for (const c of m.cells) {
      const arm = c.arms[0];
      if (c.system === 'baseline-none') { expect(arm.frontier ?? null).toBeNull(); continue; }
      expect(arm.frontier?.per_reader).toBe(true);
      expect(frontierJudgesFor(arm, OPUS)).toEqual(['openai:gpt-6-astra']);
      expect(frontierJudgesFor(arm, SOL)).toEqual(['anthropic:claude-opus-5-5']);
      expect(arm.frontier?.settings).toEqual({ effort: 'medium', max_tokens: 8000 });
    }
    const plans = m.reread_plans.filter(p => p.set === 'RS1');
    expect(plans.map(p => p.reader)).toEqual([PARTICLE, PARTICLE, PARTICLE, PARTICLE]);
    expect(plans.map(p => p.judges)).toEqual([...Array(3).fill(['openai:gpt-4.1-mini', 'anthropic:claude-opus-5-5']), ['openai:gpt-4.1-mini']]);
    expect(m.frontier_judges).toEqual({ [OPUS]: 'openai:gpt-6-astra', [SOL]: 'anthropic:claude-opus-5-5', [PARTICLE]: 'anthropic:claude-opus-5-5' });
  });

  test('stage 1 fits its $60 cap, and an estimate above it refuses with RS1_STAGE1_OVER_CAP', () => {
    expect(m.stage1_cap_usd).toBe(60);
    expect(stage1OverCap(m)).toBeNull();
    expect(stage1OverCap({ stage1_estimate_usd: 60.01, stage1_cap_usd: 60 })?.code).toBe('RS1_STAGE1_OVER_CAP');
  });

  test('the counted block caps at 1.5 times its cells\' own estimate; its re-reads spend from their own ledgers', () => {
    const counted = m.blocks.find(b => b.id === 'RS1')!;
    const cellsUsd = m.cells.reduce((s, c) => s + c.estimate.usd, 0);
    const leases = m.cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0);
    expect(counted.cap_usd).toBe(Math.round(Math.max(cellsUsd * 1.5, leases) * 100) / 100);
    expect(counted.cap_usd).toBe(1032.17);
    expect(m.cap_usd).toBe(counted.cap_usd);
    expect(counted.estimate_usd).toBe(Math.round((cellsUsd + m.reread_plans.filter(p => p.block === 'RS1').reduce((s, p) => s + p.estimate.usd, 0)) * 100) / 100);
  });

  test('stage 1\'s $60 covers the dry-run campaign and its re-reads together, and a larger stage 1 re-read ledger cap refuses', () => {
    const rereads = Math.round(m.reread_plans.filter(p => p.block === 'RS1-S1').reduce((s, p) => s + p.estimate.usd, 0) * 100) / 100;
    expect(m.stage1_reread_cap_usd).toBe(rereads);
    expect(m.stage1_reread_cap_usd).toBe(6.33);
    expect(m.dry_run_cap_usd).toBe(53.67);
    expect(m.dry_run_cap_usd + m.stage1_reread_cap_usd).toBe(m.stage1_cap_usd);
    expect(m.smoke_cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0)).toBeLessThanOrEqual(m.dry_run_cap_usd);
    const out = mkdtempSync(join(tmpdir(), 'rs1-stage1-reread-'));
    const run = (cap: string) => Bun.spawnSync(['bun', 'eval/runner/q1/reread-cell.ts', '--cell', 'rs1-dev2.gbrain-defaults.rs1-stable', '--arm', 'p', '--source', join(out, 'missing'), '--reader', PARTICLE,
      '--out', join(out, `o${cap}`), '--budget-ledger', join(out, 'ledger'), '--run-id', `r${cap}`, '--lease-usd', '1', '--ledger-cap-usd', cap, '--manifest', 'rs1', '--keyless-upstream', 'http://127.0.0.1:9'], { cwd: ROOT }).stderr.toString();
    try {
      expect(run('7')).toContain('above the $6.33 stage 1 keeps for its re-reads');
      expect(run('6.33')).not.toContain('stage 1 keeps for its re-reads');
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 60_000);
});

describe('judges', () => {
  test('the gating judge is picked by the reader family (R78: Astra for Claude, Opus for Sol and particle-1); other families are refused', () => {
    expect(rs1JudgeOf(OPUS)).toBe('openai:gpt-6-astra');
    expect(rs1JudgeOf(PARTICLE)).toBe('anthropic:claude-opus-5-5');
    expect(rs1JudgeOf(SOL)).toBe('anthropic:claude-opus-5-5');
    expect(() => rs1JudgeOf('gemini:gemini-3.8-flash')).toThrow(/no RS1 gating judge/);
  });

  // Value: protects=the crew's BEAM judge rule outside RS1 (Sol judges Claude rows); fails_when=R78's Astra/Opus map leaks into the shared frontierJudgeOf, so a future Q1 or F6 per-reader campaign picks up Astra; why_new=R78 review F5 as approved; seam=none; no_claim=RS1's own map
  test('the shared frontierJudgeOf keeps the crew\'s BEAM rule, a per-reader arm without its own map uses it, and every RS1 arm carries RS1\'s map', () => {
    expect([OPUS, PARTICLE, SOL].map(frontierJudgeOf)).toEqual(['openai:gpt-6.1-sol', 'openai:gpt-6.1-sol', 'anthropic:claude-opus-5-5']);
    const plain = { frontier: { judges: ['openai:gpt-6.1-sol'], readers: null, sample: null, per_reader: true as const } };
    expect([frontierJudgesFor(plain, OPUS), frontierJudgesFor(plain, PARTICLE)]).toEqual([['openai:gpt-6.1-sol'], ['openai:gpt-6.1-sol']]);
    const arms = [...m.cells, ...m.smoke_cells].flatMap(x => x.arms).filter(a => a.frontier);
    expect(arms.length).toBeGreaterThan(0);
    for (const a of arms) expect(a.frontier!.judge_by_reader).toEqual(RS1_JUDGE_BY_READER);
    expect(RS1_JUDGE_BY_READER).toEqual({ [OPUS]: 'openai:gpt-6-astra', [SOL]: 'anthropic:claude-opus-5-5', [PARTICLE]: 'anthropic:claude-opus-5-5' });
    expect(m.frontier_judges).toEqual(RS1_JUDGE_BY_READER);
  });

  // Value: protects=a unit's lease holds the reservation the metering proxy really makes for a pinned judge; fails_when=peakReservationUsd prices a pinned frontier judge's output at the default 2,048-token judge cap while the proxy reserves the pinned 8,000; why_new=scoped-review open item 1 (GST-1886 handoff, 2026-11-08); seam=none; no_claim=the proxy's own reservation
  test('a pinned frontier judge enters the peak reservation at its pinned output cap, as the proxy reserves it', () => {
    const pinned = m.cells.filter(c => c.arms.some(a => a.frontier?.settings));
    expect(pinned.length).toBeGreaterThan(0);
    for (const c of pinned) {
      const want = Math.max(...c.arms.flatMap(a => (a.frontier?.settings ? a.frontier.judges : []).map(j => reservationUsd({ provider: j.split(':')[0], model: j.split(':')[1], kind: 'chat', ...(CHAT_PRICE_OVERRIDES[j] ?? priceOf(j)), inputTokens: F6_ASSUMPTIONS.lease.judge_bytes + 64, maxOutputTokens: a.frontier!.settings!.max_tokens }))));
      expect(peakReservationUsd(c).usd).toBeGreaterThanOrEqual(Math.round(want * 10_000) / 10_000);
    }
    for (const c of m.smoke_cells) expect(c.lease!.basis).toContain(`($${peakReservationUsd(c, false).usd}, `);
  });

  test('a per-reader plan without the pinned judge settings is refused', () => {
    const c = gbrain();
    delete c.arms[0].frontier!.settings;
    expect(definitionProblems(c, KINDS).join('\n')).toContain('frontier.settings must pin the per-reader judges');
    const d = gbrain();
    d.arms[0].frontier!.settings = { effort: 'high', max_tokens: 8000 };
    expect(definitionProblems(d, KINDS).join('\n')).toContain('frontier.settings must pin the per-reader judges');
    expect(definitionProblems(gbrain(), KINDS)).toEqual([]);
  });

  test('completeness needs the canonical judge and, at replicate 0 on a per-reader arm, the frontier judge at its pinned settings', () => {
    const arm = m.cells[1].arms[0];
    expect(requiredJudges(arm, { reader: SOL, replicate: 0 }, INSTRUMENT)).toEqual([
      { judge: 'openai:gpt-4.1-mini', instrument_id: 'beam-rubric', view: 'descriptive' }, { judge: 'anthropic:claude-opus-5-5', instrument_id: 'beam-rubric@anthropic:claude-opus-5-5', view: 'gating', settings: { effort: 'medium', max_tokens: 8000 } }]);
    expect(requiredJudges(arm, { reader: SOL, replicate: 1 }, INSTRUMENT)).toHaveLength(1);
    expect(requiredJudges(m.cells[3].arms[0], { reader: OPUS, replicate: 0 }, INSTRUMENT)).toHaveLength(1);
  });

  test('a per-reader plan that breaks the family rule is refused', () => {
    const c = structuredClone(m.cells[1]) as CellDefinition;
    c.arms[0].readers = [OPUS, 'gemini:gemini-3.8-flash'];
    expect(definitionProblems(c, KINDS).join(' ')).toContain('no per-reader judge is mapped for gemini:gemini-3.8-flash');
    const d = structuredClone(m.cells[1]) as CellDefinition;
    d.arms[0].frontier!.judge_by_reader = { ...d.arms[0].frontier!.judge_by_reader, [OPUS]: 'anthropic:claude-opus-5-5' };
    expect(definitionProblems(d, KINDS).join(' ')).toContain('anthropic:claude-opus-5-5 would judge anthropic:claude-opus-5-5, a reader of its own family (GST-767)');
  });
});

describe('the R78 judge map reaches RS1 alone (F5)', () => {
  // Value: protects=Q1's and F6's published cell manifests and digests; fails_when=the R78 gating-judge map, the pinned settings or their route caps change a Q1 or F6 cell; why_new=R78 review F5; seam=none; no_claim=RS1's own cells
  test('Q1 and F6 generate byte-identical manifests to the ones published before R78, and none of their arms judges per reader', () => {
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(digest(manifestText())).toBe('29f6cf497b494239a303ed4d869f0df317119231c8a86c98144127871251787c');
    expect(digest(f6ManifestText())).toBe('fea479a014cdb5dcb352511f00999d5422d55ef759d265bf9a36c176509ca87e');
    expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(manifestText());
    expect(readFileSync(F6_MANIFEST_PATH, 'utf8')).toBe(f6ManifestText());
    const q1 = buildManifest(), f6 = buildF6Manifest();
    const arms = [q1, f6].flatMap(m => [...m.cells, ...(m.smoke_cells ?? []), ...(m.addon_cells ?? [])].flatMap(c => c.arms));
    expect(arms.length).toBeGreaterThan(0);
    expect(arms.filter(a => a.frontier?.per_reader || a.frontier?.settings).map(a => a.cell_id)).toEqual([]);
  });
});

describe('the F6 build predicate (F1)', () => {
  test('runsF6 keys on GBRAIN_F6=1, not on a configuration name', () => {
    const g = gbrain();
    expect(runsF6(g)).toBe(true);
    expect(g.estimate.lines.extraction).toBeGreaterThan(0);
    expect(runsF6({ launch: { ...g.launch!, env: { ...g.launch!.env, GBRAIN_F6: '0' } } })).toBe(false);
    expect(runsF6({ launch: undefined })).toBe(false);
  });

  test('definitionProblems refuses an F6-mode gbrain cell with no extract cap or a zero ingest rate', () => {
    const noCap = gbrain();
    delete noCap.launch!.env.GBRAIN_F6_EXTRACT_CAP_USD;
    expect(definitionProblems(noCap, KINDS).join(' ')).toContain('GBRAIN_F6_EXTRACT_CAP_USD');
    const noRate = gbrain();
    noRate.configuration = 'unpriced';
    expect(ingestRate(noRate)).toBe(0);
    expect(definitionProblems(noRate, KINDS).join(' ')).toContain('positive ingest rate');
  });
});

describe('launch units (kept list)', () => {
  const files = (ids: string[]) => ids.flatMap(id => [`conversations/c${id.slice(4)}/beam/1/chat.json`, `conversations/c${id.slice(4)}/beam/1/probing_questions/probing_questions.json`]).map(path => ({ path, sha256: 'a'.repeat(64) }));
  const kept = Array.from({ length: 10 }, (_, i) => `rs1-${String(i + 2).padStart(3, '0')}`);
  const manifest: Rs1Manifest = { dataset: 'beam-rs1', status: 'filled', layout: 'x', note: 'x', files: files(kept), filled_at: '2026-11-20T00:00:00Z', kept };
  const def = m.cells[0];

  test('a unit runs its five kept conversations in kept order', () => {
    expect(keptUnit(def, { index: 1, count: 7 }, manifest)).toEqual(kept.slice(5, 10));
  });

  test('refuses a shard count other than the cell units, a unit past the kept list and an unfilled manifest', () => {
    expect(() => keptUnit(def, { index: 0, count: 3 }, manifest)).toThrow(/--shard must be i\/7/);
    expect(() => keptUnit(def, { index: 2, count: 7 }, manifest)).toThrow(/launch unit 2/);
    expect(() => keptUnit(def, { index: 0, count: 7 }, { ...manifest, status: 'unfilled' })).toThrow(/unfilled/);
    expect(() => keptUnit(def, { index: 0, count: 7 }, { ...manifest, kept: ['rs1-049', ...kept] })).toThrow(/48 mint slots/);
  });
});

describe('wave A run identity across the wave B regeneration (2026-11-08 amendment)', () => {
  /** What verdict.ts compares for a unit: the run config without its launch-control fields, dataset, scheduled_sha256 and limit. */
  const identity = (def: CellDefinition) => {
    const c = JSON.parse(runConfigIdentity(runConfigText(def, def.arms[0], { instrument: instrumentFor(def.canonical_instrument), dataset: null as never, scheduledSha: '', limit: null })));
    delete c.dataset; delete c.scheduled_sha256; delete c.limit;
    return JSON.stringify(c);
  };
  const committed = loadRS1Manifest().cells;
  const waveA = new Set(loadRS1Manifest().waves.A.map(u => u.replace(/\.c\d+$/, '')));

  test('regenerating the cells at every N_final from 20 to 33 leaves every identity field of wave A\'s units byte-identical', () => {
    expect([...waveA].sort()).toEqual(committed.map(c => c.id).sort());
    const facts = { ...ALL_SETS.RS1 };
    const moved: string[] = [];
    try {
      for (let n = 20; n <= 33; n++) {
        const totals = { unchanged: facts.corpus_tokens, low: Math.round(n * 1_070_000 * 0.85), mean: n * 1_070_000, high: Math.round(n * 1_070_000 * 1.15) };
        for (const [basis, corpus_tokens] of Object.entries(totals)) {
          Object.assign(ALL_SETS.RS1, { conversations: n, questions: 20 * n, corpus_tokens });
          for (const def of generateRS1Cells()) {
            const was = committed.find(c => c.id === def.id)!;
            if (identity(def) !== identity(was)) moved.push(`N=${n} ${basis}: ${def.id} ${JSON.stringify(def.launch?.env)} vs ${JSON.stringify(was.launch?.env)}`);
          }
        }
      }
    } finally {
      Object.assign(ALL_SETS.RS1, facts);
    }
    expect(moved).toEqual([]);
  });
});

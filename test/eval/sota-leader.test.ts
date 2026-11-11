/**
 * The SOTA loop's leader rows (decision D5a, step 10), keyless: the two leader cells in the q1 manifest, the leader
 * spec, the narrowed run cell, and the import of q1's published answers and frontier judgments into the outcome cache,
 * from a real run-config (runConfigText) and synthetic records. No test reaches a provider: globalThis.fetch throws and
 * counts while these run, and nothing here opens a ledger run.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { Outcome } from '../../eval/runner/memory-qa/outcomes.ts';
import { answerRecord, rawSha256, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { qaPromptVersion } from '../../eval/runner/nightly/judge-cache.ts';
import { frontierInstrumentId, readerMaxTokens, runConfigText } from '../../eval/runner/q1/cell.ts';
import { ALL_SETS, buildManifest, definitionProblems, frontierJudgeOf, loadManifest, SOTA_DEV_IDS, SOTA_LEADER_BEAM_CONVERSATIONS, SOTA_LEADER_BEAM_IDS, SOTA_LEADER_LME_IDS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { freshness, OutcomeCache } from '../../eval/runner/sota/cache.ts';
import { importLeader, LEADERS, leaderRows, leaderRunCell, leaderSpec, main, runLeader } from '../../eval/runner/sota/leader.ts';
import { poolItems } from '../../eval/runner/sota/oracle.ts';
import { AGENT_ARM_PARITY } from '../../eval/runner/systems/gbrain-agent.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'sota-leader-'));
const realFetch = globalThis.fetch;
const network: string[] = [];
beforeAll(() => { globalThis.fetch = (async (input: string | URL | Request) => { network.push(String(input instanceof Request ? input.url : input)); throw new Error('no network in keyless tests'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });

const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol', PARTICLE = 'particle:particle-1';
const BEAM_CELL = 'sota-leader-beam.baseline-file-agent.baseline', LME_CELL = 'sota-leader-lme.baseline-full-context.baseline';
const DEV_GREP = 'sota-dev.baseline-file-agent.baseline', DEV_GBRAIN = 'sota-dev.gbrain-defaults.agent-tools';
const kinds = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const cellOf = (id: string) => buildManifest().addon_cells!.find(c => c.id === id)!;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let dirs = 0;
const fresh = (name: string) => { const d = join(tmp, `${name}-${dirs++}`); mkdirSync(d, { recursive: true }); return d; };

interface Answer { item: string; reader: string; outcome?: Outcome; text?: string; finish?: string | null; truncated?: boolean; replicate?: number; score?: number | null; judge?: string | null }

/** Publishes one arm of a q1 cell as the runner does: its real run-config, answers, and canonical plus frontier judgments. */
function publish(out: string, def: CellDefinition, armId: string, answers: Answer[], patch?: (cfg: Record<string, any>) => void): void {
  const arm = def.arms.find(a => a.id === armId)!;
  const instrument = instrumentFor(def.canonical_instrument);
  const dataset = { name: 'synthetic', files: [], revision: 'repo', license: 'MIT' } as unknown as Corpus['source'];
  const cfg = JSON.parse(runConfigText(def, arm, { instrument, dataset, scheduledSha: '0'.repeat(64), limit: null })) as Record<string, any>;
  patch?.(cfg);
  const dir = join(out, 'cells', arm.cell_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run-config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const as: AnswerRecord[] = [], js: JudgmentRecord[] = [];
  const raw = ['yes'];
  for (const x of answers) {
    const a = answerRecord({ cell_id: arm.cell_id, realization_id: 'r0', question_id: x.item, conversation: x.item.includes(':') ? x.item.slice(0, x.item.indexOf(':')) : x.item, system: def.system, arm: arm.id,
      reader: x.reader, replicate: x.replicate ?? 0, effort: 'medium', context_sha256: sha(`context ${x.item}`) },
      { text: x.text ?? 'From the sessions: the answer.', outcome: x.outcome ?? 'scored', usage: { input: 1000, output: 50, cache_read: 0, cache_write: 0 }, latency_ms: 1, provider_input_tokens: 1000,
        ...(x.finish !== undefined || x.truncated !== undefined ? { finish: x.finish ?? null, truncated: x.truncated ?? false } : {}), ...(def.system === 'baseline-file-agent' ? { stop_reason: x.outcome ?? 'submitted' } : {}) });
    as.push(a);
    js.push({ answer_id: a.answer_id, instrument_id: instrument.id, instrument_sha256: instrument.sha256, judge: instrument.canonical_judge, judge_replicate: 0, temperature: 0, score: 1, parse_ok: true, raw_sha256: rawSha256(raw), outcome: 'scored' });
    if (x.judge === null) continue;
    const judge = x.judge ?? frontierJudgeOf(x.reader);
    const score = x.score === undefined ? 1 : x.score;
    js.push({ answer_id: a.answer_id, instrument_id: frontierInstrumentId(instrument.id, judge), instrument_sha256: instrument.sha256, judge, judge_replicate: 0, temperature: null, score, parse_ok: score !== null, raw_sha256: rawSha256(raw), outcome: score === null ? 'judge_error' : 'scored' });
  }
  writeFileSync(join(dir, 'answers.ndjson'), as.map(a => JSON.stringify(a)).join('\n') + '\n');
  writeFileSync(join(dir, 'judgments.ndjson'), js.map(j => JSON.stringify(j)).join('\n') + '\n');
}

describe('leader cells in the q1 manifest', () => {
  test('two cells outside the counted list, one arm per nightly reader judged by the other family, on the BEAM-1M pool questions the dev test leaves out and the whole LongMemEval pool', () => {
    const m = buildManifest();
    const cells = m.addon_cells!.filter(c => c.block === 'SOTA-leader');
    expect(cells.map(c => c.id)).toEqual([BEAM_CELL, LME_CELL]);
    expect(loadManifest().addon_cells).toEqual(m.addon_cells);
    for (const c of cells) {
      expect(definitionProblems(c, kinds)).toEqual([]);
      expect(m.cells.some(x => x.id === c.id)).toBe(false);
      expect(c).toMatchObject({ runner: 'in-process', split: 'dev', probes: { sample: 0 } });
    }
    const [beam, lme] = cells as [CellDefinition, CellDefinition];
    expect(beam).toMatchObject({ set: 'SOTA-leader-beam', benchmark: 'beam-1m', system: 'baseline-file-agent', only_conversations: SOTA_LEADER_BEAM_CONVERSATIONS, selection: { kind: 'ids', ids: SOTA_LEADER_BEAM_IDS } });
    expect(lme).toMatchObject({ set: 'SOTA-leader-lme', benchmark: 'lme-s', system: 'baseline-full-context', selection: { kind: 'ids', ids: SOTA_LEADER_LME_IDS } });
    expect(lme.only_conversations).toBeUndefined();
    expect(beam.arms.map(a => [a.id, a.mode, a.readers, a.frontier?.judges, a.frontier?.per_reader])).toEqual([
      ['whole-agent-opus', 'agent', [OPUS], [SOL], true], ['whole-agent-sol', 'agent', [SOL], [OPUS], true]]);
    expect(lme.arms.map(a => [a.id, a.mode, a.readers, a.frontier?.judges])).toEqual([
      ['whole-full-context-opus', 'full-context', [OPUS], [SOL]], ['whole-full-context-sol', 'full-context', [SOL], [OPUS]]]);
    const pool = poolItems('beam-1m');
    expect(SOTA_LEADER_BEAM_IDS).toHaveLength(60);
    expect(SOTA_LEADER_BEAM_IDS).toEqual(pool.filter(id => !SOTA_DEV_IDS.includes(id)).sort());
    expect(SOTA_LEADER_BEAM_CONVERSATIONS).toEqual([...new Set(SOTA_LEADER_BEAM_IDS.map(id => id.split(':')[0]))].sort());
    expect(SOTA_LEADER_LME_IDS).toEqual([...poolItems('lme-s')].sort());
    expect([ALL_SETS['SOTA-leader-beam'].questions, ALL_SETS['SOTA-leader-lme'].questions]).toEqual([60, 50]);
    expect([LEADERS['beam-1m']!.cell, LEADERS['lme-s']!.cell]).toEqual([BEAM_CELL, LME_CELL]);
  });
});

describe('leaderSpec', () => {
  test('pins the leader code, the reader output limit each leader sends, the per-row frontier judge and the instrument and judge prompt versions', () => {
    for (const b of ['beam-1m', 'lme-s']) for (const r of [OPUS, SOL]) {
      const s = leaderSpec(b, r)!;
      expect(s).toMatchObject({ kind: 'leader', benchmark: b, reader: r, judge: frontierJudgeOf(r), pass_threshold: 0.5, effort: 'medium',
        judge_prompt: `${instrumentFor(b).sha256.slice(0, 16)}:${qaPromptVersion()}` });
      expect(s.judge.split(':')[0]).not.toBe(r.split(':')[0]);
    }
    expect([leaderSpec('beam-1m', OPUS)!.max_tokens, leaderSpec('beam-1m', SOL)!.max_tokens]).toEqual([AGENT_ARM_PARITY.output_tokens.anthropic, AGENT_ARM_PARITY.output_tokens.openai]);
    expect([leaderSpec('lme-s', OPUS)!.max_tokens, leaderSpec('lme-s', SOL)!.max_tokens]).toEqual([readerMaxTokens(OPUS), readerMaxTokens(SOL)]);
    expect([leaderSpec('beam-1m', OPUS)!.system, leaderSpec('lme-s', OPUS)!.system]).toEqual(['grep-agent', 'whole-history']);
    expect(leaderSpec('cat40-hard-m', OPUS)).toBeNull();
  });
});

describe('leaderRunCell', () => {
  test('narrows the leader cell to the items, their conversations and the reader\'s arm, and stays a valid definition', () => {
    const items = [SOTA_LEADER_BEAM_IDS[5]!, SOTA_DEV_IDS[0]!];
    const beam = leaderRunCell('beam-1m', SOL, items);
    expect(beam.selection).toEqual({ kind: 'ids', ids: [...items].sort() });
    expect(beam.only_conversations).toEqual([...new Set(items.map(id => id.split(':')[0]))].sort());
    expect(beam.arms.map(a => a.id)).toEqual(['whole-agent-sol']);
    expect(definitionProblems(beam, kinds)).toEqual([]);
    const lme = leaderRunCell('lme-s', OPUS, [SOTA_LEADER_LME_IDS[3]!]);
    expect([lme.arms.map(a => a.id), lme.only_conversations, lme.selection]).toEqual([['whole-full-context-opus'], undefined, { kind: 'ids', ids: [SOTA_LEADER_LME_IDS[3]] }]);
    expect(definitionProblems(lme, kinds)).toEqual([]);
    expect(() => leaderRunCell('lme-s', PARTICLE, [SOTA_LEADER_LME_IDS[0]!])).toThrow(/no arm for particle/);
    expect(() => leaderRunCell('cat40-hard-m', OPUS, ['x'])).toThrow(/has no leader/);
    expect(() => leaderRunCell('lme-s', OPUS, [])).toThrow(/no items/);
  });
});

describe('leaderRows and importLeader', () => {
  const L = SOTA_LEADER_LME_IDS;
  test('the whole-history cell: the frontier judgment decides, a history that does not fit fails, and cut-off, empty, unjudged or harness answers stay unknown', () => {
    const out = fresh('lme');
    const def = cellOf(LME_CELL);
    publish(out, def, 'whole-full-context-opus', [
      { item: L[0]!, reader: OPUS, score: 1 },
      { item: L[1]!, reader: OPUS, score: 0 },
      { item: L[2]!, reader: OPUS, score: 0.4 },
      { item: L[3]!, reader: OPUS, outcome: 'does_not_fit', text: '' },
      { item: L[4]!, reader: OPUS, finish: 'max_tokens', truncated: false },
      { item: L[5]!, reader: OPUS, text: '  ' },
      { item: L[6]!, reader: OPUS, outcome: 'harness_invalid', text: '' },
      { item: L[7]!, reader: OPUS, score: null },
      { item: L[8]!, reader: OPUS, judge: null },
      { item: L[9]!, reader: OPUS, judge: OPUS },
      { item: L[10]!, reader: OPUS, replicate: 1 },
    ]);
    publish(out, def, 'whole-full-context-sol', [{ item: L[0]!, reader: SOL, score: 0.5 }, { item: L[1]!, reader: SOL, finish: 'length', truncated: true }]);
    const { rows, unknown, skipped } = leaderRows(out, LME_CELL, '2026-11-12T00:00:00.000Z');
    expect(rows.map(r => [r.item, r.reader, r.score, r.pass, r.finish_reason])).toEqual([
      [L[0], OPUS, 1, true, null], [L[1], OPUS, 0, false, null], [L[2], OPUS, 0.4, false, null], [L[3], OPUS, 0, false, 'does_not_fit'], [L[0], SOL, 0.5, true, null]]);
    for (const r of rows) {
      const { kind, benchmark, system, reader, system_version, effort, max_tokens, judge, judge_prompt, pass_threshold, dataset, validator_version, harness_digest } = r;
      expect({ kind, benchmark, system, reader, system_version, effort, max_tokens, judge, judge_prompt, pass_threshold, dataset, validator_version, harness_digest }).toEqual(leaderSpec('lme-s', r.reader)!);
      expect(r).toMatchObject({ schema: 'sota-cache/1', context_digest: sha(`context ${r.item}`), usage: { reader_input: 1000, reader_output: 50, judge_input: 0, judge_output: 0 }, source: `q1 ${LME_CELL}.whole-full-context-${r.reader === OPUS ? 'opus' : 'sol'}` });
    }
    expect(unknown).toEqual([
      { item: L[4], reader: OPUS, outcome: 'cut off at its output limit' }, { item: L[5], reader: OPUS, outcome: 'empty answer' }, { item: L[6], reader: OPUS, outcome: 'harness_invalid' },
      { item: L[7], reader: OPUS, outcome: 'no frontier judgment' }, { item: L[8], reader: OPUS, outcome: 'no frontier judgment' }, { item: L[9], reader: OPUS, outcome: 'no frontier judgment' },
      { item: L[1], reader: SOL, outcome: 'cut off at its output limit' }]);
    expect(skipped).toBe(1);

    const cache = new OutcomeCache(fresh('cache'));
    expect(importLeader(cache, rows)).toBe(5);
    expect(importLeader(cache, rows)).toBe(0);
    const f = freshness(cache, leaderSpec('lme-s', OPUS)!, L.slice(0, 6));
    expect([[...f.hits.keys()].sort(), f.unknown, f.stale]).toEqual([L.slice(0, 4).sort(), [L[4], L[5]], []]);
    expect(freshness(cache, leaderSpec('lme-s', SOL)!, [L[0]!]).hits.get(L[0]!)?.pass).toBe(true);
  });

  test('the dev test\'s grep-agent rows are BEAM-1M leader rows for both nightly readers; an agent out of turns or context fails, particle-1 and a degraded ingest are left out', () => {
    const out = fresh('dev');
    const def = cellOf(DEV_GREP);
    const [a, b, c, d] = SOTA_DEV_IDS as [string, string, string, string];
    publish(out, def, 'whole-agent', [
      { item: a, reader: OPUS, score: 1 }, { item: a, reader: SOL, score: 0 }, { item: b, reader: OPUS, outcome: 'turn_cap', text: '' }, { item: c, reader: SOL, outcome: 'context_overflow', text: '' },
      { item: d, reader: OPUS, outcome: 'ingest_degraded' }]);
    publish(out, def, 'whole-agent-particle', [{ item: a, reader: PARTICLE, score: 1 }]);
    const { rows, unknown, skipped } = leaderRows(out, DEV_GREP);
    expect(rows.map(r => [r.item, r.reader, r.system, r.score, r.pass, r.finish_reason])).toEqual([
      [a, OPUS, 'grep-agent', 1, true, 'submitted'], [a, SOL, 'grep-agent', 0, false, 'submitted'], [b, OPUS, 'grep-agent', 0, false, 'turn_cap'], [c, SOL, 'grep-agent', 0, false, 'context_overflow']]);
    expect(rows.map(r => r.max_tokens)).toEqual([8192, 16_000, 8192, 16_000]);
    expect(unknown).toEqual([{ item: d, reader: OPUS, outcome: 'ingest_degraded' }]);
    expect(skipped).toBe(1);
  });

  test('refuses an arm that is not a leader, ran on another prompt or instrument, names another cell, or answered outside the dev pool', () => {
    const gbrain = fresh('gbrain');
    publish(gbrain, cellOf(DEV_GBRAIN), 'whole-agent', [{ item: SOTA_DEV_IDS[0]!, reader: OPUS }]);
    expect(() => leaderRows(gbrain, DEV_GBRAIN)).toThrow(/gbrain-defaults \(agent\) on beam-1m is not a leader/);
    const prompt = fresh('prompt');
    publish(prompt, cellOf(LME_CELL), 'whole-full-context-opus', [{ item: L[0]!, reader: OPUS }], cfg => { cfg.reader.prompt_sha256 = 'f'.repeat(64); });
    expect(() => leaderRows(prompt, LME_CELL)).toThrow(/read with prompt ffffffffffffffff.*buy them again/);
    const instrument = fresh('instrument');
    publish(instrument, cellOf(LME_CELL), 'whole-full-context-opus', [{ item: L[0]!, reader: OPUS }], cfg => { cfg.instrument.sha256 = 'e'.repeat(64); });
    expect(() => leaderRows(instrument, LME_CELL)).toThrow(/judged with instrument eeeeeeeeeeeeeeee/);
    const renamed = fresh('renamed');
    publish(renamed, cellOf(LME_CELL), 'whole-full-context-opus', [{ item: L[0]!, reader: OPUS }], cfg => { cfg.run_cell = 'sota-leader-lme.other'; });
    expect(() => leaderRows(renamed, LME_CELL)).toThrow(/names cell sota-leader-lme.other/);
    const outside = fresh('outside');
    publish(outside, cellOf(LME_CELL), 'whole-full-context-opus', [{ item: 'not-in-the-pool', reader: OPUS }]);
    expect(() => leaderRows(outside, LME_CELL)).toThrow(/not-in-the-pool is not in the lme-s dev pool/);
    expect(() => leaderRows(fresh('empty'), LME_CELL)).toThrow(/no published arm/);
  });
});

describe('the command line', () => {
  test('plan lists what to buy per benchmark and reader, import writes rows, and run refuses without --paid, outside the pool and on a wrong leader before any spend', async () => {
    const cacheDir = fresh('cli-cache');
    const lines: string[] = [];
    expect(await main(['plan', '--cache', cacheDir], s => lines.push(s))).toBe(0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^beam-1m grep-agent anthropic:claude-opus-5-5: 126 items, 0 fresh, 126 unknown, 0 stale; to buy: /);
    expect(readFileSync(join(cacheDir, 'plan', 'leader-lme-s-openai_gpt-6.1-sol.txt'), 'utf8').trim().split('\n')).toEqual([...poolItems('lme-s')].sort());

    const out = fresh('cli-out');
    publish(out, cellOf(LME_CELL), 'whole-full-context-sol', [{ item: SOTA_LEADER_LME_IDS[0]!, reader: SOL, score: 1 }, { item: SOTA_LEADER_LME_IDS[1]!, reader: SOL, outcome: 'reader_error', text: '' }]);
    lines.length = 0;
    expect(await main(['import', '--from', out, '--cell', LME_CELL, '--cache', cacheDir], s => lines.push(s))).toBe(0);
    expect(lines).toEqual([`import: 1 rows written, 1 read; 1 left unknown: ${SOTA_LEADER_LME_IDS[1]} openai:gpt-6.1-sol (reader_error)`]);
    lines.length = 0;
    await main(['plan', '--cache', cacheDir], s => lines.push(s));
    expect(lines[3]).toMatch(/^lme-s whole-history openai:gpt-6.1-sol: 50 items, 1 fresh, 49 unknown, 0 stale/);

    const items = join(cacheDir, 'items.txt');
    writeFileSync(items, `${SOTA_LEADER_LME_IDS[0]}\n`);
    await expect(main(['run', '--benchmark', 'lme-s', '--system', 'whole-history', '--reader', SOL, '--items', items, '--cache', cacheDir, '--work', fresh('work')])).rejects.toThrow(/pass --paid/);
    const fromRun = await runLeader({ benchmark: 'lme-s', system: 'whole-history', reader: SOL, items: [SOTA_LEADER_LME_IDS[0]!], cache: cacheDir, work: fresh('work'), argv: [] });
    expect(fromRun).toEqual({ bought: 0, fresh: 1, unknown: [] });
    await expect(runLeader({ benchmark: 'lme-s', system: 'grep-agent', reader: SOL, items: [SOTA_LEADER_LME_IDS[0]!], cache: cacheDir, work: fresh('work'), argv: [] })).rejects.toThrow(/leader is whole-history, not grep-agent/);
    await expect(runLeader({ benchmark: 'lme-s', system: 'whole-history', reader: SOL, items: ['not-in-the-pool'], cache: cacheDir, work: fresh('work'), argv: [] })).rejects.toThrow(/1 items are not in the lme-s dev pool/);
    await expect(runLeader({ benchmark: 'lme-s', system: 'whole-history', reader: SOL, items: [SOTA_LEADER_LME_IDS[2]!], cache: cacheDir, work: fresh('work'), argv: [] })).rejects.toThrow(/--paid|PAID|paid/);
    expect(existsSync(join(cacheDir, 'leader', 'beam-1m.ndjson'))).toBe(false);
    expect(network).toEqual([]);
  });
});

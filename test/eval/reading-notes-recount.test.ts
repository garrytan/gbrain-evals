import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { recount, recountCost, type Phase } from '../../eval/runner/reading-notes-recount.ts';

const dir = new URL('../../docs/benchmarks/2026-09-25-reading-notes/', import.meta.url);
const raw = (phase: Phase) => readFileSync(new URL(`reading-notes-${phase}.ndjson`, dir), 'utf8');
const cost = JSON.parse(readFileSync(new URL('cost-provenance.json', dir), 'utf8'));
const smoke = JSON.parse(readFileSync(new URL('completion-smoke.json', dir), 'utf8'));
const t = recount(raw('transfer'), 'transfer');
const o = recount(raw('oracle'), 'oracle');

describe('original, unmodified reading-notes labels', () => {
  test('transfer pair, categories, retrieval coverage, repeats and discordance regrades', () => {
    expect(t.n).toBe(361);
    expect(t.scores).toEqual({ baseline: { correct: 308, truncated: 0 }, notes: { correct: 324, truncated: 9 } });
    expect(t.contrasts['notes-vs-baseline']).toMatchObject({ wins: 22, losses: 6, net: 16 });
    expect(t.abstention).toEqual({ n: 7, scores: { baseline: 6, notes: 7 } });
    expect(t.retrieval_complete).toEqual({ n: 345, baseline: 303, notes: 320 });
    expect(t.categories).toEqual({
      'knowledge-update': { n: 52, scores: { baseline: 45, notes: 50 } },
      'multi-session': { n: 96, scores: { baseline: 76, notes: 79 } },
      'single-session-assistant': { n: 40, scores: { baseline: 40, notes: 40 } },
      'single-session-preference': { n: 20, scores: { baseline: 15, notes: 16 } },
      'single-session-user': { n: 49, scores: { baseline: 48, notes: 49 } },
      'temporal-reasoning': { n: 104, scores: { baseline: 84, notes: 90 } },
    });
    expect(t.repeats).toEqual({ n: 12, original_correct: 11, repeated_correct: 10, identical: 2, identical_grade_flips: 0 });
    expect(t.regrades).toEqual({ n: 28, changed_labels: 2, wins: 20, losses: 6 });
  });

  test('oracle four cells, factorial contrasts and controls', () => {
    expect(o.n).toBe(500);
    expect(o.scores).toEqual({ nl_direct: { correct: 424, truncated: 0 }, json_direct: { correct: 425, truncated: 0 }, nl_notes: { correct: 461, truncated: 0 }, json_notes: { correct: 463, truncated: 0 } });
    expect(o.contrasts).toMatchObject({
      'nl_notes-vs-nl_direct': { wins: 50, losses: 13, net: 37 },
      'json_notes-vs-json_direct': { wins: 47, losses: 9, net: 38 },
      'json_direct-vs-nl_direct': { wins: 9, losses: 8, net: 1 },
      'json_notes-vs-nl_notes': { wins: 16, losses: 14, net: 2 },
      'json_notes-vs-nl_direct': { wins: 49, losses: 10, net: 39 },
    });
    expect(Object.values(o.categories).reduce((n, c) => n + c.n, 0)).toBe(500);
    expect(o.abstention).toEqual({ n: 30, scores: { nl_direct: 22, json_direct: 23, nl_notes: 25, json_notes: 26 } });
    expect(o.repeats).toEqual({ n: 12, original_correct: 10, repeated_correct: 9, identical: 9, identical_grade_flips: 0 });
    expect(o.regrades).toEqual({ n: 59, changed_labels: 0, wins: 49, losses: 10 });
  });

  test('aggregate tokens reprice follow-up costs and preserve failed-pilot spend', () => {
    expect(recountCost(cost, { transfer: t, oracle: o })).toEqual({ followup_usage_priced_usd: 71.1333, prior_failed_pilot_usd: 8.0127305, total_usage_priced_usd: 79.1460305, total_settled_calls: 6014 });
    expect(cost.schema).toBe(1);
    expect(cost.groups.map((g: { phase: string; role: string; model: string }) => `${g.phase}:${g.role}:${g.model}`)).toEqual([
      'transfer:reader:anthropic:claude-sonnet-4-6', 'transfer:judge:openai:gpt-4o', 'oracle:reader:openai:gpt-4o', 'oracle:judge:openai:gpt-4o',
    ]);
    const phase = (name: Phase) => cost.groups.filter((g: { phase: Phase }) => g.phase === name);
    const usd = (g: { input_tokens: number; output_tokens: number; input_usd_per_million: number; output_usd_per_million: number }) =>
      (g.input_tokens * g.input_usd_per_million + g.output_tokens * g.output_usd_per_million) / 1e6;
    for (const [name, receipt] of [['transfer', t], ['oracle', o]] as const) {
      expect(phase(name).reduce((n: number, g: { calls: number }) => n + g.calls, 0)).toBe(receipt.accounting.settled_calls);
      expect(phase(name).reduce((n: number, g: Parameters<typeof usd>[0]) => n + usd(g), 0)).toBeCloseTo(Number(receipt.accounting.usage_priced_usd), 9);
    }
    expect(cost.transfer_primary_readers.map((r: { mode: string }) => r.mode)).toEqual(['baseline', 'notes']);
    expect(cost.transfer_primary_readers.map((r: { calls: number; input_tokens: number; output_tokens: number }) => {
      expect(r.calls).toBe(361);
      return (r.input_tokens * 3 + r.output_tokens * 15) / 1e6;
    })).toEqual([17.220423, 18.086391]);
    expect(cost.transfer_primary_readers.reduce((n: number, r: { input_tokens: number }) => n + r.input_tokens, 0)).toBeLessThan(cost.groups[0].input_tokens);
    expect(cost.previous_failed_excerpt_pilot).toMatchObject({ settled_calls: 348, usage_priced_usd: 8.0127305 });
    expect(cost.groups.reduce((n: number, g: { calls: number }) => n + g.calls, 348)).toBe(cost.total_settled_calls);
    expect(cost.groups.reduce((n: number, g: Parameters<typeof usd>[0]) => n + usd(g), 8.0127305)).toBeCloseTo(cost.total_usage_priced_usd, 9);
  });

  test('separate 1024-token completion smoke covers exactly the nine prior cutoffs', () => {
    const cutoff = raw('transfer').split('\n').filter(line => line.includes('"record_type":"pair"') && line.includes('"notes_truncated":true')).map(line => JSON.parse(line).question_id).sort();
    expect(smoke.model).toBe('anthropic:claude-sonnet-4-6');
    expect(smoke.max_tokens).toBe(1024);
    expect(smoke.n).toBe(9);
    expect(smoke.completed).toBe(9);
    expect(smoke.results.map((r: { question_id: string }) => r.question_id).sort()).toEqual(cutoff);
    expect(smoke.results.every((r: { finish_reason: string; nonempty: boolean; output_tokens: number }) => r.finish_reason === 'end_turn' && r.nonempty && r.output_tokens > 0 && r.output_tokens < 1024)).toBe(true);
    expect(smoke.results.reduce((n: number, r: { cost_usd: number }) => n + r.cost_usd, 0)).toBeCloseTo(smoke.cost_usd, 9);
    expect(smoke.cost_usd).toBe(0.562143);
  });

  test('conservative cutoff sensitivity does not change original labels', () => {
    const pairs = raw('transfer').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.record_type === 'pair');
    const cutoffCredit = pairs.filter(r => r.notes_truncated && r.notes_correct).length;
    const adjusted = pairs.map(r => ({ baseline: r.baseline_correct, notes: r.notes_correct && !r.notes_truncated }));
    expect(cutoffCredit).toBe(7);
    expect(adjusted.filter(r => r.baseline).length).toBe(308);
    expect(adjusted.filter(r => r.notes).length).toBe(317);
    expect(adjusted.filter(r => !r.baseline && r.notes).length).toBe(21);
    expect(adjusted.filter(r => r.baseline && !r.notes).length).toBe(12);
    expect(100 * (317 - 308) / 361).toBeCloseTo(2.493, 3);
  });
});

describe('incomplete and mismatched label streams fail closed', () => {
  const rows = raw('transfer').trimEnd().split('\n');
  const edit = (index: number, change: (row: Record<string, unknown>) => void) => {
    const copy = [...rows]; const row = JSON.parse(copy[index]); change(row); copy[index] = JSON.stringify(row);
    return `${copy.join('\n')}\n`;
  };
  test('truncated, malformed, missing and duplicate records', () => {
    expect(() => recount(rows.join('\n'), 'transfer')).toThrow('incomplete');
    expect(() => recount(`${rows.slice(0, -1).join('\n')}\n`, 'transfer')).toThrow('expected 28');
    expect(() => recount(`${rows.join('\n')}\n${rows[1]}\n`, 'transfer')).toThrow('duplicate');
    expect(() => recount(`${rows.join('\n')}\n{\n`, 'transfer')).toThrow('malformed');
  });
  test('identity, schema, grades and control provenance', () => {
    expect(() => recount(raw('transfer'), 'oracle')).toThrow('mismatch');
    expect(() => recount(edit(0, r => { r.manifest_sha256 = 'other'; }), 'transfer')).toThrow('mismatch');
    expect(() => recount(edit(1, r => { r.baseline_correct = 'true'; }), 'transfer')).toThrow('must be boolean');
    expect(() => recount(edit(1, r => { r.question_id = 'other_abs'; }), 'transfer')).toThrow('discordant pair');
    expect(() => recount(edit(1, r => { r.extra = 1; }), 'transfer')).toThrow('unexpected/missing');
    const regrade = rows.findIndex(r => r.includes('"record_type":"discordance_rejudge"'));
    expect(() => recount(edit(regrade, r => { r.baseline_changed = !r.baseline_changed; }), 'transfer')).toThrow('change flag mismatch');
  });
  test('cost model, calls and token aggregates must match original labels', () => {
    const changed = structuredClone(cost);
    changed.groups[0].input_tokens++;
    expect(() => recountCost(changed, { transfer: t, oracle: o })).toThrow('cost/label mismatch');
    changed.groups[0].input_tokens--;
    changed.groups[0].model = 'other';
    expect(() => recountCost(changed, { transfer: t, oracle: o })).toThrow('cost model/rate/call mismatch');
  });
  test('an identical response may receive a different judge label', () => {
    const index = rows.findIndex(r => r.includes('"record_type":"baseline_repeat"') && r.includes('"text_identical":true'));
    const changed = edit(index, r => { r.candidate_correct = !r.baseline_correct; });
    expect(recount(changed, 'transfer').repeats.identical_grade_flips).toBe(1);
  });
});

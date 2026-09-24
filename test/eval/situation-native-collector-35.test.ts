import { describe, expect, test } from 'bun:test';
import { anchorPresent, quoteFidelity, segmentClaims } from '../../eval/runner/cat35-checks.ts';
import { collectNativeRows35 } from '../../eval/runner/situation-recall-native-35.ts';
import { materializeNativeRegressionRows, type NativeRegressionObservation } from '../../eval/runner/situation-recall-native.ts';
import { aggregateRegressionMetric } from '../../eval/runner/situation-recall-regression.ts';
import type { RegressionMetricSpec, RegressionObservationValue, RegressionProfile } from '../../eval/runner/situation-recall-contract.ts';
import inventory from '../../eval/regression/situation-recall-v1.json';

const METRICS = inventory.native_contracts.cat35.metrics as RegressionMetricSpec[];
const LANES = ['verbatim', 'facts', 'dream'];

function fixture(options: { extraClaim?: boolean; dropCandidate?: boolean; noCandidates?: boolean; failGrounding?: boolean; failHazard?: boolean } = {}) {
  const gold = [
    { transcript_id: 't1', scenario: 'coding-reflection', variant: 'prose', expected_triage: 'high',
      items: [{ item_id: 'i1', kind: 'fact', notability: 'high', depth_bucket: 'early' }],
      distractors: [{ distractor_id: 'd1', anchor: 'The coffee machine needs cleaning again' }, { distractor_id: 'd2', anchor: 'The weather was warmer yesterday afternoon' }],
      hazards: [{ hazard_id: 'h1', type: 'agent-proposed-user-decided' }] },
    { transcript_id: 't2', scenario: 'emotional-processing', variant: 'long-noisy', expected_triage: 'high',
      items: [{ item_id: 'i2', kind: 'idea', notability: 'medium', depth_bucket: 'middle' }, { item_id: 'i3', kind: 'vibe', notability: 'low', depth_bucket: 'late' }],
      distractors: [{ distractor_id: 'd3', anchor: 'The printer requires another new cartridge' }], hazards: [] },
    { transcript_id: 'routine', scenario: 'pure-routine', variant: 'prose', expected_triage: 'low', items: [],
      distractors: [{ distractor_id: 'd4', anchor: 'The grocery store closes at nine' }], hazards: [] },
  ];
  const documents: Record<string, Record<string, string>> = {};
  const transcripts: Record<string, string> = {};
  for (const g of gold) {
    const tid = g.transcript_id;
    transcripts[tid] = `The selected approach is supported here.\n${g.distractors.map((d) => d.anchor).join('\n')}`;
    documents[tid] = tid === 'routine' ? { verbatim: '', facts: '', dream: '' } : {
      verbatim: transcripts[tid],
      facts: g.distractors.map((d) => `- [fact] ${d.anchor}`).join('\n'),
      dream: `- The selected approach is supported here.\n${g.distractors.map((d) => `- ${d.anchor}.`).join('\n')}\n\n> The selected approach is supported here.`,
    };
  }
  if (options.extraClaim) documents.t1.dream += '\n\n- An additional unsupported claim appears here.';
  if (options.dropCandidate) documents.t1.facts = documents.t1.facts.split('\n')[0];
  if (options.noCandidates) documents.t1.facts = '- [fact] A generated claim contains no routine anchor';
  const receipt: any = {
    schema_version: 1, cat: 'cat35-transcript-distill', mode: 'partial', lanes: LANES, transcripts: gold.map((g) => g.transcript_id),
    per_item: [], coverage_by_lane: {}, coverage_by_kind: {}, coverage_by_notability: {}, coverage_by_depth: {},
    hallucination: {}, distractor_leakage: {}, usability: { satisfied: 0, total: 0, rate: null, per_transcript: [] }, usability_by_lane: {},
    attribution_hazards: [], emission: { expected_high: 2, emitted: 2, rate: 1 },
    verbatim_quote_fidelity: { total: 0, grounded: 0, rate: 1 }, lane_errors: {}, judge_failed_rate: 0,
    native_evidence: { schema_version: 1, judge_accounting_unit: 'runner_judge_invocation_after_retries', judge_attempt_unit: 'provider_client_messages_create_attempt',
      judge_calls: 0, judge_failures: 0, judge_events: [], judge_attempts: [], grounding: [], distractors: [] },
  };
  const e = receipt.native_evidence;
  const event = (tid: string, lane: string, purpose: string, subjects: string[], result: any) => {
    const event_id = `judge-${e.judge_events.length + 1}`;
    const failed = purpose === 'coverage' ? result.judge_failed_ids.length > 0 : result.judge_failed;
    e.judge_events.push({ event_id, transcript_id: tid, lane, purpose, subject_ids: subjects, judge_failed: failed, result });
    for (let i = 0; i < (failed ? 2 : 1); i++) e.judge_attempts.push({ event_id, attempt: i + 1, requested_model: 'stub-model', resolved_model: 'stub-snapshot',
      status: 'tool_input', tool_input: result, error: null, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    return event_id;
  };
  for (const g of gold) {
    const tid = g.transcript_id;
    for (const lane of LANES) {
      const doc = documents[tid][lane];
      if (g.items.length) {
        const verdicts = g.items.map((it, i) => ({ item_id: it.item_id, status: tid === 't1' ? 'FULL' : i === 0 ? 'PARTIAL' : 'ABSENT', evidence: i === 0 ? 'The selected approach is supported here' : '' }));
        event(tid, lane, 'coverage', g.items.map((i) => i.item_id), { verdicts, judge_failed_ids: [], cost_usd: 0 });
        receipt.per_item.push(...g.items.map((it, i) => ({ ...it, transcript_id: tid, lane, status: verdicts[i].status,
          joint: lane === 'dream' ? verdicts[i].status === 'FULL' ? 1 : verdicts[i].status === 'PARTIAL' ? 0.5 : 0 : null })));
      }
      if (lane !== 'verbatim') {
        const claims = lane === 'facts' ? doc.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.replace(/^- \[[a-z]+\] /, '')) : segmentClaims(doc);
        const failed = Boolean(options.failGrounding && tid === 't1' && lane === 'facts');
        const results = failed ? [] : claims.map((claim, i) => ({ claim, verifiable: i !== 2, grounded: i === 0 }));
        const judge_event_id = claims.length ? event(tid, lane, 'hallucination', claims.map((_, i) => String(i)), { results, judge_failed: failed, cost_usd: 0 }) : null;
        e.grounding.push({ transcript_id: tid, lane, status: !doc ? 'empty_output' : !claims.length ? 'no_claims' : failed ? 'judge_failed' : 'judged', judge_event_id, claims, results });
        if (claims.length) {
          const b = receipt.hallucination[lane] ??= { claims: 0, verifiable: 0, ungrounded: 0, rate: 0 };
          if (!failed) {
            b.claims += claims.length;
            b.verifiable += results.filter((r) => r.verifiable).length;
            b.ungrounded += results.filter((r) => r.verifiable && !r.grounded).length;
          }
        }
      }
      const candidates = g.distractors.filter((d) => doc && anchorPresent(d.anchor, doc));
      const confirmed = candidates.filter((_, i) => lane === 'verbatim' || i === 0).map((d) => d.distractor_id);
      const judge_event_id = lane !== 'verbatim' && candidates.length ? event(tid, lane, 'distractor_confirmation', candidates.map((d) => d.distractor_id), { confirmed, judge_failed: false, cost_usd: 0 }) : null;
      e.distractors.push(...g.distractors.map((d) => {
        const hit = candidates.includes(d);
        return { transcript_id: tid, lane, distractor_id: d.distractor_id, anchor: d.anchor, denominator_eligible: true,
          scan_status: doc ? 'scanned' : 'empty_output', anchor_hit: doc ? hit : null, judge_event_id: hit ? judge_event_id : null,
          confirmation: !doc ? 'not_scanned' : !hit ? 'not_candidate' : lane === 'verbatim' ? 'verbatim_hit' : confirmed.includes(d.distractor_id) ? 'confirmed' : 'rejected' };
      }));
      if (doc && lane !== 'facts') {
        const u = { satisfied: tid === 't1' ? 4 : 2, total: tid === 't1' ? 5 : 6, checks: [{ id: 'stub-check', pass: true }], judge_failed: false, cost_usd: 0 };
        event(tid, lane, 'usability', ['stub-check'], u);
        receipt.usability.per_transcript.push({ transcript_id: tid, lane, satisfied: u.satisfied, total: u.total });
      }
    }
    const q = quoteFidelity(documents[tid].dream, transcripts[tid]);
    receipt.verbatim_quote_fidelity.total += q.total;
    receipt.verbatim_quote_fidelity.grounded += q.grounded;
    for (const h of g.hazards) {
      const failed = Boolean(options.failHazard);
      event(tid, 'dream', 'hazard', [h.hazard_id], { judge_failed: failed, cost_usd: 0,
        results: failed ? [] : [{ claim: 'The selected approach is supported here', verifiable: true, grounded: true }] });
      receipt.attribution_hazards.push({ transcript_id: tid, hazard_id: h.hazard_id, type: h.type, violated: failed ? null : true });
    }
  }
  const credit = (r: any) => r.status === 'FULL' ? 1 : r.status === 'PARTIAL' ? 0.5 : 0;
  for (const lane of LANES) {
    const items = receipt.per_item.filter((r: any) => r.lane === lane);
    const perTranscript = gold.filter((g) => g.items.length).map((g) => items.filter((r: any) => r.transcript_id === g.transcript_id));
    receipt.coverage_by_lane[lane] = { macro: perTranscript.reduce((sum, rs) => sum + rs.reduce((s: number, r: any) => s + credit(r), 0) / rs.length, 0) / perTranscript.length,
      micro: items.reduce((s: number, r: any) => s + credit(r), 0) / items.length, strict: items.filter((r: any) => r.status === 'FULL').length / items.length,
      partial_rate: items.filter((r: any) => r.status === 'PARTIAL').length / items.length };
    for (const [axis, field] of [['kind', 'coverage_by_kind'], ['notability', 'coverage_by_notability'], ['depth_bucket', 'coverage_by_depth']]) {
      for (const value of new Set(items.map((r: any) => r[axis]))) {
        const group = items.filter((r: any) => r[axis] === value);
        (receipt[field][String(value)] ??= {})[lane] = group.reduce((s: number, r: any) => s + credit(r), 0) / group.length;
      }
    }
    const distractors = e.distractors.filter((r: any) => r.lane === lane);
    const confirmed = distractors.filter((r: any) => ['confirmed', 'verbatim_hit'].includes(r.confirmation)).length;
    receipt.distractor_leakage[lane] = { hits: distractors.filter((r: any) => r.anchor_hit).length, confirmed, denominator: distractors.length, rate: confirmed / distractors.length };
    if (receipt.hallucination[lane]) {
      const b = receipt.hallucination[lane]; b.rate = b.verifiable ? b.ungrounded / b.verifiable : 0;
    }
    const us = receipt.usability.per_transcript.filter((r: any) => r.lane === lane);
    if (us.length) {
      const satisfied = us.reduce((s: number, r: any) => s + r.satisfied, 0);
      const total = us.reduce((s: number, r: any) => s + r.total, 0);
      receipt.usability_by_lane[lane] = { satisfied, total, rate: satisfied / total };
      receipt.usability.satisfied += satisfied;
      receipt.usability.total += total;
    }
  }
  receipt.usability.rate = receipt.usability.satisfied / receipt.usability.total;
  e.judge_calls = e.judge_events.length;
  e.judge_failures = e.judge_events.filter((j: any) => j.judge_failed).length;
  receipt.judge_failed_rate = e.judge_failures / e.judge_calls;
  return { receipt, gold, artifacts: { documents, transcripts } };
}

function aggregate(observations: NativeRegressionObservation[], metric: string, slice: string) {
  return aggregateRegressionMetric(observations.filter((r) => r.slices.includes(slice) && r.metrics[metric] !== undefined)
    .map((r) => r.metrics[metric] as RegressionObservationValue), METRICS.find((m) => m.id === metric)!);
}

function profile(observations: NativeRegressionObservation[]): RegressionProfile {
  return { category: 'cat35', metrics: METRICS,
    probes: observations.map((r) => ({ probe_id: r.probe_id, family_id: r.family_id!, slices: r.slices, critical: false, no_gold_metrics: [] })),
  } as unknown as RegressionProfile;
}

describe('Cat35 native collector', () => {
  test('reconstructs every metric without mixing item-weighted and transcript-weighted populations', () => {
    const f = fixture();
    const observations = collectNativeRows35(f);
    const materialized = materializeNativeRegressionRows(profile(observations), observations);
    expect(materialized).toHaveLength(observations.length);
    for (const row of materialized) expect(Object.keys(row.metrics).sort()).toEqual(METRICS.map((m) => m.id).sort());
    for (const lane of LANES) {
      expect(aggregate(observations, 'macro', lane)).toBe(0.625);
      expect(aggregate(observations, 'micro', lane)).toBe(0.5);
      expect(aggregate(observations, 'strict', lane)).toBe(1 / 3);
      expect(aggregate(observations, 'distractor_leakage_rate', `distractor:${lane}`)).toBe(f.receipt.distractor_leakage[lane].rate);
      if (lane !== 'verbatim') expect(aggregate(observations, 'hallucination_rate', `grounding:${lane}`)).toBe(f.receipt.hallucination[lane].rate);
      if (lane !== 'facts') expect(aggregate(observations, 'usability_rate', `usability:${lane}`)).toBe(6 / 11);
      for (const [axis, field] of [['kind', 'coverage_by_kind'], ['notability', 'coverage_by_notability'], ['depth_bucket', 'coverage_by_depth']]) {
        for (const [value, scores] of Object.entries(f.receipt[field])) expect(aggregate(observations, field, `item:${lane}:${axis}:${value}`)).toBe((scores as any)[lane]);
      }
    }
    expect(aggregate(observations, 'joint', 'dream')).toBe(0.625);
    expect(aggregate(observations, 'emission_rate', 'expected-high')).toBe(1);
    expect(aggregate(observations, 'verbatim_quote_fidelity', 'quote:dream')).toBe(1);
    expect(aggregate(observations, 'attribution_hazard_violated', 'hazard')).toBe(1);
    expect(METRICS.find((m) => m.id === 'judge_failed_rate')).toMatchObject({ aggregation: 'ratio', integer: true, zero_denominator: 'reject' });
    expect(aggregate(observations, 'judge_failed_rate', 'judge-call')).toBe(0);
    const judgeGroups = observations.filter((r) => r.slices.includes('judge-call'));
    expect(judgeGroups).toHaveLength(f.receipt.transcripts.length * LANES.length);
    expect(judgeGroups.reduce((sum, r) => sum + (r.metrics.judge_failed_rate as { denominator: number }).denominator, 0)).toBe(f.receipt.native_evidence.judge_calls);
    for (const lane of LANES) expect(judgeGroups.find((r) => r.probe_id === `cat35/judge/routine/${lane}`)?.metrics.judge_failed_rate).toEqual({ numerator: 0, denominator: 0 });
    expect(observations.filter((r) => r.probe_id.includes('/item/')).every((r) => !LANES.some((lane) => r.slices.includes(lane)))).toBe(true);
    expect(observations.filter((r) => r.probe_id.includes('/grounding/')).every((r) => !LANES.some((lane) => r.slices.includes(lane)))).toBe(true);
    expect(observations.find((r) => r.probe_id === 'cat35/distractors/routine/dream')?.metrics.distractor_leakage_rate).toEqual({ numerator: 0, denominator: 1 });
    expect(observations.find((r) => r.probe_id === 'cat35/usability/routine/dream')?.metrics.usability_rate).toEqual({ numerator: 0, denominator: 0 });
  });

  test('claim and candidate variation does not change frozen ratio row identities', () => {
    const baseline = collectNativeRows35(fixture());
    const candidate = collectNativeRows35(fixture({ extraClaim: true, dropCandidate: true }));
    expect(candidate.map((r) => r.probe_id)).toEqual(baseline.map((r) => r.probe_id));
    expect(() => materializeNativeRegressionRows(profile(baseline), candidate)).not.toThrow();
    expect(candidate.find((r) => r.probe_id === 'cat35/grounding/t1/dream')?.metrics.hallucination_rate).not.toEqual(baseline.find((r) => r.probe_id === 'cat35/grounding/t1/dream')?.metrics.hallucination_rate);
  });

  test('receipt-local IDs and conditional call disappearance preserve paired accounting group identities', () => {
    const f = fixture();
    const baseline = collectNativeRows35(f);
    const renamed = JSON.parse(JSON.stringify(f).replaceAll('judge-', 'renumbered-'));
    expect(collectNativeRows35(renamed)).toEqual(baseline);
    const candidate = collectNativeRows35(fixture({ noCandidates: true }));
    expect(candidate.map((r) => r.probe_id)).toEqual(baseline.map((r) => r.probe_id));
    expect(() => materializeNativeRegressionRows(profile(baseline), candidate)).not.toThrow();
    expect(baseline.find((r) => r.probe_id === 'cat35/judge/t1/facts')?.metrics.judge_failed_rate).toEqual({ numerator: 0, denominator: 3 });
    expect(candidate.find((r) => r.probe_id === 'cat35/judge/t1/facts')?.metrics.judge_failed_rate).toEqual({ numerator: 0, denominator: 2 });
  });

  test('judge failures stay in accounting denominator but never fabricate grounding/hazard verdicts', () => {
    const f = fixture({ failGrounding: true, failHazard: true });
    const observations = collectNativeRows35(f);
    expect(aggregate(observations, 'judge_failed_rate', 'judge-call')).toBe(2 / f.receipt.native_evidence.judge_calls);
    expect(f.receipt.native_evidence.judge_attempts.length).toBe(f.receipt.native_evidence.judge_calls + 2);
    const judgeGroups = observations.filter((r) => r.slices.includes('judge-call'));
    expect(judgeGroups.reduce((sum, r) => sum + (r.metrics.judge_failed_rate as { numerator: number }).numerator, 0)).toBe(2);
    expect(judgeGroups.reduce((sum, r) => sum + (r.metrics.judge_failed_rate as { denominator: number }).denominator, 0)).toBe(f.receipt.native_evidence.judge_calls);
    const failed = observations.find((r) => r.probe_id === 'cat35/grounding/t1/facts')!;
    expect(failed.contributed).toBe(false);
    expect(failed.error?.origin).toBe('judge');
    expect(failed.metrics.hallucination_rate).toEqual({ numerator: 0, denominator: 0 });
    expect(aggregate(observations, 'hallucination_rate', 'grounding:facts')).toBe(f.receipt.hallucination.facts.rate);
    const hazard = observations.find((r) => r.probe_id === 'cat35/hazard/t1/h1')!;
    expect(hazard.contributed).toBe(false);
    expect(hazard.error?.origin).toBe('judge');
    expect(hazard.metrics).toEqual({});
    expect(observations.filter((r) => r.slices.includes('judge-call')).every((r) => r.contributed && !r.error)).toBe(true);
  });

  test('native omitted aggregates from an all-empty run cannot become manufactured passing zeros', () => {
    const f = fixture();
    f.receipt.transcripts = ['routine'];
    f.receipt.per_item = [];
    for (const field of ['coverage_by_lane', 'coverage_by_kind', 'coverage_by_notability', 'coverage_by_depth', 'hallucination', 'distractor_leakage', 'usability_by_lane']) f.receipt[field] = {};
    f.receipt.usability = { satisfied: 0, total: 0, rate: null, per_transcript: [] };
    f.receipt.emission = { expected_high: 0, emitted: 0, rate: 1 };
    f.receipt.verbatim_quote_fidelity = { total: 0, grounded: 0, rate: 1 };
    f.receipt.attribution_hazards = [];
    const e = f.receipt.native_evidence;
    e.judge_events = [];
    e.judge_attempts = [];
    e.judge_calls = 0;
    e.judge_failures = 0;
    e.grounding = e.grounding.filter((r: any) => r.transcript_id === 'routine');
    e.distractors = e.distractors.filter((r: any) => r.transcript_id === 'routine');
    expect(() => collectNativeRows35(f)).toThrow('no native judge accounting events');
    f.receipt.lanes = ['verbatim'];
    e.grounding = [];
    e.distractors = e.distractors.filter((r: any) => r.lane === 'verbatim');
    expect(() => collectNativeRows35(f)).toThrow('no native judge accounting events');
  });

  test('rejects legacy receipts, missing provenance, dropped rows, and contradictory aggregates', () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => { delete f.receipt.native_evidence; },
      (f) => { f.gold.pop(); },
      (f) => { delete f.artifacts.documents.t1.dream; },
      (f) => { delete f.artifacts.transcripts.t1; },
      (f) => { f.receipt.per_item.pop(); },
      (f) => { f.receipt.native_evidence.grounding.pop(); },
      (f) => { f.receipt.native_evidence.distractors.pop(); },
      (f) => { f.receipt.native_evidence.judge_events.pop(); },
      (f) => { f.receipt.native_evidence.judge_attempts.pop(); },
      (f) => { f.receipt.native_evidence.judge_calls++; },
      (f) => { f.receipt.hallucination.facts.rate = 0.99; },
      (f) => { f.receipt.coverage_by_lane.dream.macro = 0.99; },
      (f) => { f.receipt.attribution_hazards[0].violated = null; },
    ];
    for (const mutate of mutations) {
      const f = fixture(); mutate(f);
      expect(() => collectNativeRows35(f)).toThrow();
    }
    expect(() => collectNativeRows35(fixture().receipt)).toThrow('Cat35 receipt');
  });
});

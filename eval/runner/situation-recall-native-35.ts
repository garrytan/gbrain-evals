import { anchorPresent, quoteFidelity, segmentClaims } from './cat35-checks.ts';
import { isDeepStrictEqual } from 'node:util';
import type { ProbeError } from './receipt.ts';
import type { RegressionMetricValue } from './situation-recall-contract.ts';
import {
  nativeEvidenceObject as object,
  nativeEvidenceRows as rows,
  nativeFinite,
  type NativeRegressionObservation,
} from './situation-recall-native.ts';

type Lane = 'verbatim' | 'facts' | 'dream';
type RecordRow = Record<string, unknown>;
type Failure = Omit<ProbeError, 'probe_id'>;

export interface Cat35NativeEnvelope {
  receipt: unknown;
  gold: unknown[];
  artifacts: {
    documents: Record<string, Partial<Record<Lane, string>>>;
    transcripts: Record<string, string>;
  };
}

function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cat35 evidence: ${message}`);
}

function text(value: unknown, label: string): string {
  requireEvidence(typeof value === 'string' && value.length > 0, `${label} is missing`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  requireEvidence(Array.isArray(value), `${label} is missing`);
  const result = value.map((v) => text(v, label));
  requireEvidence(new Set(result).size === result.length, `${label} has duplicate identities`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  requireEvidence(typeof value === 'boolean', `${label} is not boolean`);
  return value;
}

function count(value: unknown, label: string): number {
  const n = nativeFinite(value, label);
  requireEvidence(Number.isSafeInteger(n) && n >= 0, `${label} is not a native count`);
  return n;
}

function same(actual: unknown, expected: unknown, label: string): void {
  requireEvidence(isDeepStrictEqual(actual, expected), `${label} disagrees with native evidence`);
}

function sameNumber(actual: unknown, expected: number, label: string): void {
  requireEvidence(Math.abs(nativeFinite(actual, label) - expected) < 1e-12, `${label} disagrees with native evidence`);
}

function index(values: RecordRow[], key: (row: RecordRow) => string, label: string): Map<string, RecordRow> {
  const result = new Map<string, RecordRow>();
  for (const row of values) {
    const id = key(row);
    requireEvidence(!result.has(id), `${label} has duplicate identity ${id}`);
    result.set(id, row);
  }
  return result;
}

const key = (...parts: string[]) => parts.map(encodeURIComponent).join('/');
const fraction = (numerator: number, denominator: number) => ({ numerator, denominator });
const judgeError = (purpose: string): Failure => ({ origin: 'judge', message: `Cat35 ${purpose} judge failed; no verdict was imputed` });

export function collectNativeRows35(artifact: unknown): NativeRegressionObservation[] {
  const envelope = object(artifact, 'Cat35 envelope');
  const receipt = object(envelope.receipt, 'Cat35 receipt');
  requireEvidence(receipt.cat === 'cat35-transcript-distill' && receipt.schema_version === 1, 'wrong native receipt category/version');
  const evidence = object(receipt.native_evidence, 'Cat35 native_evidence');
  requireEvidence(evidence.schema_version === 1, 'native_evidence v1 is required; legacy aggregates cannot supply observations');
  requireEvidence(evidence.judge_accounting_unit === 'runner_judge_invocation_after_retries', 'unsupported judge accounting denominator');
  requireEvidence(evidence.judge_attempt_unit === 'provider_client_messages_create_attempt', 'unsupported provider attempt unit');
  const tids = strings(receipt.transcripts, 'receipt.transcripts');
  const lanes = strings(receipt.lanes, 'receipt.lanes') as Lane[];
  requireEvidence(tids.length > 0 && lanes.length > 0 && lanes.every((l) => ['verbatim', 'facts', 'dream'].includes(l)), 'empty or unknown native population');
  const gold = index(rows(envelope.gold, 'Cat35 gold'), (g) => text(g.transcript_id, 'gold.transcript_id'), 'gold');
  requireEvidence(tids.every((tid) => gold.has(tid)), 'original gold is missing selected transcripts');
  const artifacts = object(envelope.artifacts, 'Cat35 artifacts');
  const documents = object(artifacts.documents, 'Cat35 lane markdown');
  const transcripts = object(artifacts.transcripts, 'Cat35 original transcript text');
  const laneErrors = object(receipt.lane_errors, 'Cat35 lane_errors');
  const perItem = index(rows(receipt.per_item, 'Cat35 per_item'), (r) => key(text(r.transcript_id, 'item transcript'), text(r.lane, 'item lane'), text(r.item_id, 'item ID')), 'per_item');
  const grounding = index(rows(evidence.grounding, 'Cat35 grounding'), (r) => key(text(r.transcript_id, 'grounding transcript'), text(r.lane, 'grounding lane')), 'grounding');
  const distractors = index(rows(evidence.distractors, 'Cat35 distractors'), (r) => key(text(r.transcript_id, 'distractor transcript'), text(r.lane, 'distractor lane'), text(r.distractor_id, 'distractor ID')), 'distractors');
  const usability = index(rows(object(receipt.usability, 'Cat35 usability').per_transcript, 'Cat35 usability rows'), (r) => key(text(r.transcript_id, 'usability transcript'), text(r.lane, 'usability lane')), 'usability');
  const hazards = index(rows(receipt.attribution_hazards, 'Cat35 hazards'), (r) => key(text(r.transcript_id, 'hazard transcript'), text(r.hazard_id, 'hazard ID')), 'hazards');
  const eventRows = rows(evidence.judge_events, 'Cat35 judge events');
  const eventsByLocalId = index(eventRows, (r) => text(r.event_id, 'judge event ID'), 'judge events');
  const events = index(eventRows, (r) => {
    const tid = text(r.transcript_id, 'judge transcript');
    const lane = text(r.lane, 'judge lane');
    const purpose = text(r.purpose, 'judge purpose');
    requireEvidence(tids.includes(tid) && lanes.includes(lane as Lane), 'judge event outside native transcript/lane population');
    requireEvidence(['coverage', 'joint_grounding', 'hallucination', 'distractor_confirmation', 'usability', 'hazard'].includes(purpose), 'unknown judge purpose');
    const subjects = strings(r.subject_ids, 'judge subjects');
    requireEvidence(subjects.length > 0 && (purpose !== 'hazard' || subjects.length === 1), 'judge event has invalid subjects');
    return key(tid, lane, purpose, purpose === 'hazard' ? subjects[0] : 'batch');
  }, 'judge source identities');
  const attempts = rows(evidence.judge_attempts, 'Cat35 judge attempts');
  for (const attempt of attempts) requireEvidence(eventsByLocalId.has(text(attempt.event_id, 'attempt event ID')), 'orphan provider attempt');
  for (const event of eventRows) {
    const observed = attempts.filter((a) => a.event_id === event.event_id);
    requireEvidence(observed.length >= 1 && observed.length <= 2, 'judge event is missing its actual client attempts');
    same(observed.map((a) => a.attempt), observed.map((_, i) => i + 1), 'judge attempt order');
    for (const attempt of observed) {
      text(attempt.requested_model, 'requested judge model');
      requireEvidence(attempt.resolved_model === null || typeof attempt.resolved_model === 'string', 'resolved judge identity missing');
      requireEvidence(['tool_input', 'missing_tool_input', 'transport_error'].includes(String(attempt.status)), 'judge attempt outcome missing');
    }
    const result = object(event.result, 'judge result');
    same(boolean(event.judge_failed, 'judge failure'), event.purpose === 'coverage'
      ? strings(result.judge_failed_ids, 'coverage failed IDs').length > 0
      : boolean(result.judge_failed, 'judge result failure'), 'judge failure accounting');
  }
  same(count(evidence.judge_calls, 'judge_calls'), eventRows.length, 'judge_calls');
  const failures = eventRows.filter((r) => r.judge_failed).length;
  same(count(evidence.judge_failures, 'judge_failures'), failures, 'judge_failures');
  sameNumber(receipt.judge_failed_rate, eventRows.length ? failures / eventRows.length : 0, 'judge_failed_rate');
  requireEvidence(eventRows.length > 0, 'no native judge accounting events; whole-run failure ratio has no denominator');

  const result: NativeRegressionObservation[] = [];
  const add = (parts: string[], tid: string, slices: string[], metrics: Record<string, RegressionMetricValue>, failure?: Failure, contributed = true) => {
    const g = gold.get(tid)!;
    const probe_id = key('cat35', ...parts);
    result.push({ probe_id, family_id: tid, slices: [...slices, text(g.scenario, 'gold scenario'), text(g.variant, 'gold variant')], metrics, contributed,
      ...(failure ? { error: { probe_id, ...failure } } : {}) });
  };
  const takeEvent = (tid: string, lane: Lane, purpose: string, subject = 'batch') => {
    const id = key(tid, lane, purpose, subject);
    const event = events.get(id);
    events.delete(id);
    return event;
  };
  const checkEventLink = (row: RecordRow, event: RecordRow | undefined, label: string) => same(row.judge_event_id, event?.event_id ?? null, label);
  const hallucinationTotals: Record<string, { claims: number; verifiable: number; ungrounded: number; rate: number }> = {};
  const leakage: Record<string, { hits: number; confirmed: number; denominator: number; rate: number }> = {};
  const usable: Record<string, { satisfied: number; total: number; rate: number }> = {};
  const coverage: Record<string, Array<{ credit: number; full: number; total: number; partial: number }>> = {};
  const breakdown: Record<string, Record<string, { credit: number; total: number }>> = {};
  let quoteTotal = 0;
  let quoteGrounded = 0;
  let expectedHigh = 0;
  let emittedHigh = 0;

  for (const tid of tids) {
    const g = gold.get(tid)!;
    const goldItems = rows(g.items, 'gold items');
    const goldDistractors = rows(g.distractors, 'gold distractors');
    const goldHazards = rows(g.hazards, 'gold hazards');
    const docs = object(documents[tid], `lane markdown for ${tid}`);
    const errors = laneErrors[tid] === undefined ? {} : object(laneErrors[tid], `lane errors for ${tid}`);
    const expected = text(g.expected_triage, 'gold expected_triage');
    requireEvidence(expected === 'high' || expected === 'low', 'unknown gold triage');
    if (expected === 'high') expectedHigh++;
    for (const lane of lanes) {
      const doc = docs[lane];
      requireEvidence(doc === undefined || typeof doc === 'string', 'lane markdown must contain actual text');
      const laneError = errors[lane] === undefined ? null : text(errors[lane], 'lane error');
      requireEvidence(laneError || typeof doc === 'string', `missing lane markdown ${tid}/${lane}; absence alone is not non-emission`);
      const failure: Failure | undefined = laneError ? { origin: 'harness', message: `Cat35 native lane error has no classified origin: ${laneError}` } : undefined;
      if (goldItems.length) {
        const event = takeEvent(tid, lane, 'coverage');
        requireEvidence(laneError ? !event : !!event, `coverage accounting event missing/unexpected for ${tid}/${lane}`);
        if (event) same([...strings(event.subject_ids, 'coverage subjects')].sort(), goldItems.map((i) => text(i.item_id, 'gold item ID')).sort(), 'coverage subjects');
        const totals = { credit: 0, full: 0, total: goldItems.length, partial: 0 };
        const joint: number[] = [];
        for (const item of goldItems) {
          const itemId = text(item.item_id, 'gold item ID');
          const id = key(tid, lane, itemId);
          const row = perItem.get(id);
          requireEvidence(row, `missing original coverage item ${id}`);
          perItem.delete(id);
          requireEvidence(['FULL', 'PARTIAL', 'ABSENT', 'JUDGE_FAILED'].includes(String(row.status)), 'invalid native coverage status');
          const credit = row.status === 'FULL' ? 1 : row.status === 'PARTIAL' ? 0.5 : 0;
          totals.credit += credit;
          totals.full += Number(row.status === 'FULL');
          totals.partial += Number(row.status === 'PARTIAL');
          const slices: string[] = [];
          for (const axis of ['kind', 'notability', 'depth_bucket']) {
            same(row[axis], item[axis], `coverage gold ${axis}`);
            const value = text(row[axis], axis);
            slices.push(`item:${lane}:${axis}:${value}`);
            const b = (breakdown[axis] ??= {})[key(value, lane)] ??= { credit: 0, total: 0 };
            b.credit += credit;
            b.total++;
          }
          add(['item', tid, lane, itemId], tid, slices, { coverage_by_kind: credit, coverage_by_notability: credit, coverage_by_depth: credit });
          if (lane === 'dream' && row.joint !== null) {
            requireEvidence([0, 0.5, 1].includes(nativeFinite(row.joint, 'joint credit')), 'invalid joint credit');
            joint.push(row.joint as number);
          }
        }
        (coverage[lane] ??= []).push(totals);
        const metrics: Record<string, RegressionMetricValue> = { macro: totals.credit / totals.total, micro: fraction(totals.credit, totals.total), strict: fraction(totals.full, totals.total) };
        const coverageFailure = event?.judge_failed ? judgeError('coverage') : failure;
        if (lane === 'dream') {
          if (joint.length) metrics.joint = joint.reduce((a, b) => a + b, 0) / joint.length;
          else requireEvidence(coverageFailure, 'joint has no native denominator and no recorded judge/lane failure; unsupported unscored scalar');
          const fallback = takeEvent(tid, lane, 'joint_grounding');
          if (fallback) requireEvidence(strings(fallback.subject_ids, 'joint subjects').every((id) => goldItems.some((i) => i.item_id === id)), 'joint grounding names unknown items');
        }
        add(['coverage', tid, lane], tid, [lane, 'signal'], metrics, coverageFailure, lane !== 'dream' || joint.length > 0);
      }

      if (lane !== 'verbatim') {
        const id = key(tid, lane);
        const row = grounding.get(id);
        requireEvidence(row, `missing grounding outcome ${id}`);
        grounding.delete(id);
        const claims = row.claims;
        requireEvidence(Array.isArray(claims) && claims.every((c) => typeof c === 'string'), 'grounding input claims missing');
        const verdicts = rows(row.results, 'grounding results');
        const event = takeEvent(tid, lane, 'hallucination');
        checkEventLink(row, event, 'grounding event link');
        const actualClaims = !doc || laneError ? [] : lane === 'facts'
          ? doc.split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.replace(/^- \[[a-z]+\] /, '').trim())
          : segmentClaims(doc);
        same(claims, actualClaims, 'grounding claim segmentation');
        const status = laneError ? 'lane_error' : !doc ? 'empty_output' : !actualClaims.length ? 'no_claims' : event?.judge_failed ? 'judge_failed' : 'judged';
        same(row.status, status, 'grounding status');
        requireEvidence(actualClaims.length > 0 ? !!event : !event, 'grounding call eligibility disagrees');
        let verifiable = 0;
        let ungrounded = 0;
        if (event) {
          same(verdicts, object(event.result, 'grounding judge result').results, 'grounding retained verdicts');
          const b = hallucinationTotals[lane] ??= { claims: 0, verifiable: 0, ungrounded: 0, rate: 0 };
          if (!event.judge_failed) {
            same(verdicts.map((v) => v.claim), claims, 'ordered grounding verdicts');
            for (const verdict of verdicts) {
              const checkable = boolean(verdict.verifiable, 'claim verifiable');
              const grounded = boolean(verdict.grounded, 'claim grounded');
              verifiable += Number(checkable);
              ungrounded += Number(checkable && !grounded);
            }
            b.claims += claims.length;
            b.verifiable += verifiable;
            b.ungrounded += ungrounded;
          } else same(verdicts, [], 'failed grounding result');
        } else same(verdicts, [], 'uncalled grounding result');
        add(['grounding', tid, lane], tid, [`grounding:${lane}`], { hallucination_rate: fraction(ungrounded, verifiable) }, event?.judge_failed ? judgeError('grounding') : failure, !event?.judge_failed && !failure);
      }

      let hits = 0;
      let confirmed = 0;
      let denominator = 0;
      const candidates: string[] = [];
      const confirmation = takeEvent(tid, lane, 'distractor_confirmation');
      const confResult = confirmation ? object(confirmation.result, 'distractor confirmation') : null;
      const confirmedIds = confResult ? strings(confResult.confirmed, 'confirmed distractors') : [];
      const scanned = !!doc && !laneError && goldDistractors.length > 0;
      for (const distractor of goldDistractors) {
        const distractorId = text(distractor.distractor_id, 'gold distractor ID');
        const id = key(tid, lane, distractorId);
        const row = distractors.get(id);
        requireEvidence(row, `missing distractor outcome ${id}`);
        distractors.delete(id);
        const anchor = text(distractor.anchor, 'gold distractor anchor');
        same(row.anchor, anchor, 'distractor anchor');
        const eligible = !laneError && doc !== undefined;
        same(row.denominator_eligible, eligible, 'distractor denominator');
        denominator += Number(eligible);
        same(row.scan_status, laneError ? 'lane_error' : !doc ? 'empty_output' : 'scanned', 'distractor scan status');
        const hit = scanned ? anchorPresent(anchor, doc!) : null;
        same(row.anchor_hit, hit, 'distractor anchor result');
        if (hit) { hits++; candidates.push(distractorId); }
        const outcome = !scanned ? 'not_scanned' : !hit ? 'not_candidate' : lane === 'verbatim' ? 'verbatim_hit'
          : confirmation?.judge_failed ? 'judge_failed' : confirmedIds.includes(distractorId) ? 'confirmed' : 'rejected';
        same(row.confirmation, outcome, 'distractor confirmation outcome');
        checkEventLink(row, hit && lane !== 'verbatim' ? confirmation : undefined, 'distractor event link');
        confirmed += Number(outcome === 'confirmed' || outcome === 'verbatim_hit');
      }
      requireEvidence(lane !== 'verbatim' && hits > 0 ? !!confirmation : !confirmation, 'distractor judge eligibility disagrees');
      if (confirmation) {
        same([...strings(confirmation.subject_ids, 'candidate IDs')].sort(), [...candidates].sort(), 'candidate IDs');
        requireEvidence(confirmedIds.every((id) => candidates.includes(id)), 'confirmation contains unknown candidates');
        if (confirmation.judge_failed) same(confirmedIds, [], 'failed confirmation result');
      }
      if (scanned) leakage[lane] ??= { hits: 0, confirmed: 0, denominator: 0, rate: 0 };
      add(['distractors', tid, lane], tid, [`distractor:${lane}`], { distractor_leakage_rate: fraction(confirmed, denominator) }, failure);

      if (lane !== 'facts') {
        const event = takeEvent(tid, lane, 'usability');
        requireEvidence(!laneError || !event, 'errored lane has a usability event');
        requireEvidence(!doc || laneError || event, 'emitted page set is missing its usability event');
        const row = usability.get(key(tid, lane));
        usability.delete(key(tid, lane));
        let satisfied = 0;
        let total = 0;
        if (event && !event.judge_failed) {
          const judged = object(event.result, 'usability judge result');
          requireEvidence(row, 'successful usability event is missing its native row');
          satisfied = count(judged.satisfied, 'usability satisfied');
          total = count(judged.total, 'usability total');
          requireEvidence(total > 0 && satisfied <= total, 'invalid usability checklist counts');
          same(row.satisfied, satisfied, 'usability satisfied');
          same(row.total, total, 'usability total');
          const b = usable[lane] ??= { satisfied: 0, total: 0, rate: 0 };
          b.satisfied += satisfied;
          b.total += total;
        } else requireEvidence(!row, 'unjudged/failed usability has a scored native row');
        add(['usability', tid, lane], tid, [`usability:${lane}`], { usability_rate: fraction(satisfied, total) }, event?.judge_failed ? judgeError('usability') : failure, !event?.judge_failed && !failure);
      }

      if (lane === 'dream') {
        requireEvidence(typeof transcripts[tid] === 'string', `original transcript text missing for quote check ${tid}`);
        const q = !laneError && doc ? quoteFidelity(doc, transcripts[tid] as string) : { total: 0, grounded: 0 };
        quoteTotal += q.total;
        quoteGrounded += q.grounded;
        add(['quotes', tid, lane], tid, ['quote:dream'], { verbatim_quote_fidelity: fraction(q.grounded, q.total) }, failure);
        if (expected === 'high') {
          const emitted = Number(typeof doc === 'string' && doc.trim().length > 0);
          emittedHigh += emitted;
          add(['emission', tid], tid, ['expected-high'], { emission_rate: emitted }, failure);
        }
        for (const hazard of goldHazards) {
          const hazardId = text(hazard.hazard_id, 'gold hazard ID');
          const id = key(tid, hazardId);
          const row = hazards.get(id);
          requireEvidence(row, `missing attribution hazard ${id}`);
          hazards.delete(id);
          same(row.type, hazard.type, 'hazard type');
          const event = takeEvent(tid, lane, 'hazard', hazardId);
          requireEvidence(!doc || laneError ? !event : !!event, 'hazard judge eligibility disagrees');
          if (row.violated === null) {
            requireEvidence(event?.judge_failed || failure, `hazard ${id} is unscored without a classified failure; no native scalar denominator`);
            add(['hazard', tid, hazardId], tid, ['hazard', text(hazard.type, 'hazard type')], {}, event?.judge_failed ? judgeError('hazard') : failure, false);
          } else {
            requireEvidence(event && !event.judge_failed, 'scored hazard lacks successful judge');
            const verdicts = rows(object(event.result, 'hazard judge result').results, 'hazard verdicts');
            requireEvidence(verdicts.length === 1, 'hazard requires its actual claim verdict');
            same(row.violated, boolean(verdicts[0].verifiable, 'hazard verifiable') && boolean(verdicts[0].grounded, 'hazard grounded'), 'hazard verdict');
            add(['hazard', tid, hazardId], tid, ['hazard', text(hazard.type, 'hazard type')], { attribution_hazard_violated: Number(boolean(row.violated, 'hazard violated')) });
          }
        }
      }
    }
  }

  for (const [label, remaining] of Object.entries({ perItem, grounding, distractors, usability, hazards, events })) requireEvidence(remaining.size === 0, `unexpected ${label} outside frozen native population`);
  for (const tid of tids) {
    for (const lane of lanes) {
      const journal = eventRows.filter((event) => event.transcript_id === tid && event.lane === lane);
      add(['judge', tid, lane], tid, ['judge-call'], { judge_failed_rate: fraction(journal.filter((event) => event.judge_failed).length, journal.length) });
    }
  }
  for (const b of Object.values(hallucinationTotals)) b.rate = b.verifiable ? b.ungrounded / b.verifiable : 0;
  same(hallucinationTotals, receipt.hallucination, 'hallucination aggregates');
  for (const lane of lanes.filter((l) => l !== 'verbatim')) requireEvidence(hallucinationTotals[lane], `hallucination ${lane} has no native aggregate because no claims were judged; cannot manufacture a zero`);
  for (const lane of Object.keys(leakage)) {
    const source = rows(evidence.distractors, 'distractors').filter((d) => d.lane === lane);
    const b = leakage[lane];
    b.hits = source.filter((d) => d.anchor_hit === true).length;
    b.confirmed = source.filter((d) => d.confirmation === 'confirmed' || d.confirmation === 'verbatim_hit').length;
    b.denominator = source.filter((d) => d.denominator_eligible).length;
    b.rate = b.denominator ? b.confirmed / b.denominator : 0;
  }
  same(leakage, receipt.distractor_leakage, 'distractor aggregates');
  for (const lane of lanes) requireEvidence(leakage[lane], `distractor leakage ${lane} has no native aggregate because no output was scanned; cannot manufacture a zero`);
  for (const b of Object.values(usable)) b.rate = b.satisfied / b.total;
  same(usable, receipt.usability_by_lane, 'usability lane aggregates');
  const usabilityAggregate = object(receipt.usability, 'usability aggregate');
  const satisfied = Object.values(usable).reduce((sum, b) => sum + b.satisfied, 0);
  const total = Object.values(usable).reduce((sum, b) => sum + b.total, 0);
  same(usabilityAggregate.satisfied, satisfied, 'usability total satisfied');
  same(usabilityAggregate.total, total, 'usability total checks');
  same(usabilityAggregate.rate, total ? satisfied / total : null, 'usability aggregate rate');
  same(receipt.verbatim_quote_fidelity, { total: quoteTotal, grounded: quoteGrounded, rate: quoteTotal ? quoteGrounded / quoteTotal : 1 }, 'quote fidelity aggregate');
  same(receipt.emission, { expected_high: expectedHigh, emitted: emittedHigh, rate: expectedHigh ? emittedHigh / expectedHigh : 1 }, 'emission aggregate');
  const coverageNative = object(receipt.coverage_by_lane, 'coverage aggregates');
  same(Object.keys(coverage).sort(), Object.keys(coverageNative).sort(), 'coverage lane populations');
  for (const [lane, source] of Object.entries(coverage)) {
    const native = object(coverageNative[lane], 'coverage lane');
    const total = source.reduce((sum, b) => sum + b.total, 0);
    sameNumber(native.macro, source.reduce((sum, b) => sum + b.credit / b.total, 0) / source.length, 'coverage macro');
    sameNumber(native.micro, source.reduce((sum, b) => sum + b.credit, 0) / total, 'coverage micro');
    sameNumber(native.strict, source.reduce((sum, b) => sum + b.full, 0) / total, 'coverage strict');
    sameNumber(native.partial_rate, source.reduce((sum, b) => sum + b.partial, 0) / total, 'coverage partial rate');
  }
  for (const [axis, field] of [['kind', 'coverage_by_kind'], ['notability', 'coverage_by_notability'], ['depth_bucket', 'coverage_by_depth']]) {
    const native = object(receipt[field], field);
    const expected: Record<string, Record<string, number>> = {};
    for (const [id, b] of Object.entries(breakdown[axis] ?? {})) {
      const [value, lane] = id.split('/').map(decodeURIComponent);
      (expected[value] ??= {})[lane] = b.credit / b.total;
    }
    requireEvidence(Object.keys(native).length === Object.keys(expected).length, `${field} population differs`);
    for (const [value, byLane] of Object.entries(expected)) {
      const group = object(native[value], `${field}/${value}`);
      same(Object.keys(group).sort(), Object.keys(byLane).sort(), `${field} lanes`);
      for (const [lane, score] of Object.entries(byLane)) sameNumber(group[lane], score, `${field}/${value}/${lane}`);
    }
  }
  return result.sort((a, b) => a.probe_id.localeCompare(b.probe_id));
}

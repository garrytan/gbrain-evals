/**
 * Workload suites (memory proof wave B1 to B4): generator determinism and
 * counts, committed manifests, offline solvability and presence on the stub
 * reader, the corrections schedule driver and its controls, miss
 * classification, schema checks, provenance of model inputs, the model rule
 * and scorer mutation checks.
 */
import { describe, expect, test } from 'bun:test';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { runChecks, storePresenceFailures } from '../../eval/workload-suites/checks.ts';
import { SUITES, runSuite } from '../../eval/workload-suites/cli.ts';
import { bundleFiles, bundleManifest, renderContext } from '../../eval/workload-suites/common.ts';
import {
  CORRECTION_ARMS, ReferenceCorrectionMemory, correctionStubAnswer, generateCorrections, runCorrectionArm,
  type CorrectionAdapter, type CorrectionItem, type UnrelatedWrite,
} from '../../eval/workload-suites/corrections.ts';
import { classifyMiss, generatePassingDetails } from '../../eval/workload-suites/passing-details.ts';
import { MODEL_CONFIG, frontierSubset, modelRuleViolations } from '../../eval/workload-suites/run-config.ts';
import { schemaErrors } from '../../eval/workload-suites/schema-check.ts';
import type { ScorerLabel, SuiteBundle, SuiteDefinition, SuiteId } from '../../eval/workload-suites/types.ts';

const IDS = Object.keys(SUITES) as SuiteId[];
const smokeOf = new Map<SuiteId, SuiteBundle>(IDS.map(id => [id, SUITES[id].generate({ seed: SUITES[id].defaultSeed, smoke: true })]));

describe('workload suite generators', () => {
  for (const id of IDS) {
    test(`${id}: byte-identical from the seed, different for another seed`, () => {
      const suite = SUITES[id];
      const again = suite.generate({ seed: suite.defaultSeed, smoke: true });
      expect(bundleFiles(again)).toEqual(bundleFiles(smokeOf.get(id)!));
      const other = suite.generate({ seed: suite.defaultSeed + 1, smoke: true });
      expect(bundleManifest(other).digest).not.toBe(bundleManifest(again).digest);
    });
  }

  test('full-size counts match the plan', async () => {
    const counts: Record<string, unknown> = {};
    for (const id of IDS) {
      const run = await runSuite(SUITES[id], { output: null });
      expect([id, run.report.verdict, run.manifest_check]).toEqual([id, 'pass', 'match']);
      counts[id] = { queries: run.manifest.counts.queries, users: run.manifest.counts.users, by_category: run.manifest.counts.by_category };
    }
    expect((counts['passing-details'] as { queries: number; users: number })).toMatchObject({ queries: 400, users: 40 });
    expect(counts.corrections).toMatchObject({ queries: 300, users: 100 });
    expect(counts['time-relationships']).toMatchObject({ queries: 374, users: 2 });
    expect((counts['time-relationships'] as { by_category: Record<string, number> }).by_category.as_of_employer).toBe(104);
    expect(counts.beliefs).toMatchObject({ queries: 150, by_category: { holder: 50, weight_change: 50, resolved_set: 25, resolved_one: 25 } });
  }, 60_000);

  test('passing details: every history repeats each asked detail with other values, and values are unique tokens', () => {
    const b = generatePassingDetails({ seed: 7, smoke: true });
    for (const l of b.labels) {
      expect(l.distractors.filter(d => d.kind === 'distractor').length).toBeGreaterThanOrEqual(2);
      expect(l.needles).toHaveLength(1);
      expect(new Set([l.gold.kind === 'value' ? l.gold.value : '', ...l.distractors.map(d => d.value)]).size).toBe(l.distractors.length + 1);
    }
  });

  test('corrections: one item per unit, three checkpoints, five unrelated writes, edited document keeps its id', () => {
    const b = generateCorrections({ seed: 3, items: 4 });
    const items = b.extra.corrections as CorrectionItem[];
    const writes = b.extra.writes as UnrelatedWrite[];
    expect(items).toHaveLength(4);
    expect(writes).toHaveLength(20);
    expect(b.queries.map(q => q.meta.checkpoint)).toEqual([0, 1, 5, 0, 1, 5, 0, 1, 5, 0, 1, 5]);
    for (const item of items) {
      expect(item.edited_document.id).toBe(item.target_doc_id);
      expect(item.edited_document.content).toContain(item.new_value);
      expect(item.edited_document.content).not.toContain(item.old_value);
      expect(item.correction_document.timestamp > b.documents.find(d => d.id === item.target_doc_id)!.timestamp).toBe(true);
    }
  });
});

describe('offline solvability and presence (stub reader)', () => {
  for (const id of IDS) {
    test(`${id}: oracle passes, no memory fails, full history unambiguous, needles present`, async () => {
      const report = await runChecks(smokeOf.get(id)!, SUITES[id]);
      expect(report.schema.failures).toEqual([]);
      expect(report.presence.failures).toEqual([]);
      expect(report.solvability.oracle.failures).toEqual([]);
      expect(report.solvability.no_memory.failures).toEqual([]);
      expect(report.solvability.no_memory.correct).toBe(report.solvability.no_memory.negatives);
      expect(report.solvability.full_history?.failures ?? []).toEqual([]);
      expect(report.verdict).toBe('pass');
    });
  }

  test('a broken record fails presence and names the seed and query', async () => {
    const b = structuredClone(smokeOf.get('passing-details')!);
    const doc = b.documents.find(d => d.id === b.labels[0]!.needles[0]!.doc_id)!;
    doc.content = doc.content.replace(b.labels[0]!.needles[0]!.text, '');
    const report = await runChecks(b, SUITES['passing-details']);
    expect(report.verdict).toBe('fail');
    expect(report.presence.failures[0]).toContain(`seed ${b.seed} query ${b.labels[0]!.query_id}`);
  });

  test('store presence probe: a store missing one needle is reported', async () => {
    const b = smokeOf.get('beliefs')!;
    const missing = b.labels[0]!.needles[0]!.value;
    const failures = await storePresenceFailures(b, async (_u, n) => n.value !== missing);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every(f => f.includes(missing))).toBe(true);
  });
});

describe('corrections schedule driver', () => {
  const b = generateCorrections({ seed: 5, items: 6 });
  const reader = async (l: ScorerLabel, _q: unknown, c: string) => correctionStubAnswer(l, c);

  test('every arm answers every probe on the reference memory; ignoring corrections is scored stale', async () => {
    for (const arm of CORRECTION_ARMS) {
      const r = await runCorrectionArm(new ReferenceCorrectionMemory('faithful'), arm, b, reader);
      expect([arm.id, r.metrics!.after_1_write.rate_correct, r.metrics!.after_5_writes.rate_correct]).toEqual([arm.id, 1, 1]);
    }
    const stale = await runCorrectionArm(new ReferenceCorrectionMemory('ignore-corrections'), CORRECTION_ARMS[0]!, b, reader);
    expect(stale.metrics!.pre_correction_recall.rate_correct).toBe(1);
    expect(stale.metrics!.after_1_write.rate_stale).toBe(1);
    expect(stale.metrics!.after_5_writes.rate_stale).toBe(1);
    const empty = await runCorrectionArm(new ReferenceCorrectionMemory('no-memory'), CORRECTION_ARMS[0]!, b, reader);
    expect(empty.probes.every(p => p.outcome === 'abstain')).toBe(true);
  });

  test('an adapter that does not support the optional arm reports it as not run', async () => {
    const ref = new ReferenceCorrectionMemory();
    const adapter: CorrectionAdapter = Object.assign(Object.create(ref), {
      system: 'gbrain',
      supports: (arm: { optional: boolean }) => arm.optional ? { ok: false as const, reason: 'remember has no replaces parameter at this build' } : { ok: true as const },
    });
    const replaces = CORRECTION_ARMS.find(a => a.id === 'gbrain-remember-replaces')!;
    const r = await runCorrectionArm(adapter, replaces, b, reader);
    expect(r.status).toBe('not_run');
    expect(r.reason).toContain('replaces');
    expect(r.metrics).toBeNull();
  });

  test('a stale answer after the correction is scored stale, a hedge naming both values goes to the judge', () => {
    const label = b.labels.find(l => (l.spec as { checkpoint: number }).checkpoint === 1)!;
    const gold = label.gold as { value: string; stale: string[] };
    expect(SUITES.corrections.score(label, `Answer: ${gold.stale[0]}`).outcome).toBe('stale');
    expect(SUITES.corrections.score(label, `Answer: ${gold.value}`).outcome).toBe('correct');
    expect(SUITES.corrections.score(label, `Answer: ${gold.value}, earlier ${gold.stale[0]}`).outcome).toBe('ambiguous');
  });

  test('arms: both systems get an append arm with identical bytes, and only the replaces arm is optional', () => {
    const appends = CORRECTION_ARMS.filter(a => a.path === 'append');
    expect(appends.map(a => a.system).sort()).toEqual(['comparator', 'gbrain']);
    expect(appends.every(a => JSON.stringify(a.steps) === JSON.stringify(appends[0]!.steps))).toBe(true);
    expect(CORRECTION_ARMS.filter(a => a.optional).map(a => a.id)).toEqual(['gbrain-remember-replaces']);
  });
});

describe('passing-details miss classification', () => {
  const label = smokeOf.get('passing-details')!.labels[0]!;
  const value = (label.gold as { value: string }).value;
  test('absent, not retrieved, misread and correct are told apart from receipts', () => {
    expect(classifyMiss(label, { outcome: 'correct', stored: true, deliveredContext: value })).toBe('correct');
    expect(classifyMiss(label, { outcome: 'abstain', stored: false, deliveredContext: '' })).toBe('absent_from_storage');
    expect(classifyMiss(label, { outcome: 'abstain', stored: true, deliveredContext: 'nothing relevant' })).toBe('stored_not_retrieved');
    expect(classifyMiss(label, { outcome: 'distractor', stored: true, deliveredContext: `notes: ${value} and more` })).toBe('delivered_but_misread');
    expect(classifyMiss(label, { outcome: 'wrong', stored: null, deliveredContext: '' })).toBe('unclassified');
  });
});

describe('model inputs carry no labels or ids', () => {
  for (const id of IDS) {
    test(`${id}: documents and query text never contain an id, gold-only field or answer marker`, () => {
      const b = smokeOf.get(id)!;
      const ids = [...b.documents.map(d => d.id), ...b.queries.map(q => q.id), ...new Set(b.documents.map(d => d.user_id))];
      const inputs = [...b.documents.map(d => `${d.content}\n${d.context}`), ...b.queries.map(q => q.query)].join('\n');
      for (const x of ids) expect(inputs.includes(x)).toBe(false);
      expect(/answer_|\bgold_|\bdistractor|\boracle\b|\bneedle|scorer/.test(inputs)).toBe(false);
      for (const q of b.queries) expect(Object.keys(q.meta).every(k => ['query_timestamp', 'category', 'checkpoint', 'hops'].includes(k))).toBe(true);
    });
  }
});

describe('schema, model rule and frontier subset', () => {
  test('records outside the schema are rejected', () => {
    const b = smokeOf.get('beliefs')!;
    expect(schemaErrors(b.documents[0], 'document')).toEqual([]);
    expect(schemaErrors({ ...b.documents[0], timestamp: 5 }, 'document')).toContain('document.timestamp: expected string, got integer');
    expect(schemaErrors({ ...b.labels[0], gold: { kind: 'value' } }, 'scorer_label').length).toBeGreaterThan(0);
    expect(schemaErrors({ ...b.queries[0], extra: 1 }, 'query')).toContain('query: unexpected extra');
  });

  test('the configured readers follow the project model rule, and violations are caught', () => {
    expect(modelRuleViolations()).toEqual([]);
    expect(MODEL_CONFIG.fixed_reader.family).toBe('sonnet');
    const bad = { ...MODEL_CONFIG, frontier_sweep: [...MODEL_CONFIG.frontier_sweep.slice(0, 3), { id: 'openai:gpt-5.4-mini', family: 'fable' as const }] };
    expect(modelRuleViolations(bad).join(' ')).toContain('gpt-5.4-mini');
    const old = { ...MODEL_CONFIG, fixed_reader: { id: 'anthropic:claude-sonnet-4-6', family: 'sonnet' as const } };
    expect(modelRuleViolations(old).join(' ')).toContain('claude-sonnet-4-6');
  });

  test('the frontier subset covers every category at about a quarter and is stable', () => {
    const b = smokeOf.get('beliefs')!;
    const subset = frontierSubset(b);
    expect(subset).toEqual(frontierSubset(structuredClone(b)));
    const cats = new Set(b.queries.filter(q => subset.includes(q.id)).map(q => q.meta.category));
    expect(cats.size).toBe(new Set(b.queries.map(q => q.meta.category)).size);
  });
});

describe('scorer mutation checks', () => {
  type Probe = { label: ScorerLabel; truth: string };
  const everything = (l: ScorerLabel): string => {
    const g = l.gold;
    if (g.kind === 'set') return g.universe.join('; ');
    if (g.kind === 'verdict') return 'Yes, it came true.';
    if (g.kind === 'change') return `from ${g.from} to ${g.to}; also ${l.distractors.map(d => d.value).join(' and ')}`;
    if (g.kind === 'none') return l.distractors.map(d => d.value).join('; ');
    return [g.value, ...(g.stale ?? []), ...l.distractors.map(d => d.value)].join(' or ');
  };
  const staleOf = (l: ScorerLabel): string | undefined => {
    const g = l.gold;
    if (g.kind === 'value' && g.stale?.length) return g.stale[0];
    if (g.kind === 'change') return `${g.from} percent, unchanged`;
    const earlier = l.distractors.find(d => d.kind === 'considered' || d.kind === 'recorded-time-answer');
    return earlier?.value;
  };
  const wrongOf = (l: ScorerLabel): string | undefined => {
    const g = l.gold;
    if (g.kind === 'verdict') return g.verdict === 'yes' ? 'No, it did not.' : 'Yes, it came true.';
    const d = l.distractors.find(x => x.kind !== 'considered');
    if (d) return d.value;
    if (g.kind === 'set') return g.universe.find(u => !g.values.includes(u));
    return undefined;
  };
  for (const id of IDS) {
    test(`${id}: the scorer rejects empty, always-positive, always-refuse, stale and wrong-source systems`, () => {
      const suite: SuiteDefinition = SUITES[id];
      // The as-of smoke slice has no late-recorded probe, so the stale fake needs the full set.
      const b = id === 'time-relationships' ? suite.generate({ seed: suite.defaultSeed, smoke: false }) : smokeOf.get(id)!;
      const docs = new Map(b.documents.map(d => [d.id, d]));
      for (const item of (b.extra.corrections as CorrectionItem[] | undefined) ?? []) docs.set(item.correction_document.id, item.correction_document);
      const probes: Probe[] = b.labels.map(label => ({ label, truth: suite.stubAnswer(label, renderContext(label.oracle_doc_ids.map(i => docs.get(i)!))) }));
      assertScorerRejectsFakeSystems<Probe, string>({
        category: id,
        probes,
        space: {
          truth: p => p.truth,
          empty: () => '',
          everything: p => everything(p.label),
          refusal: () => "I don't know",
          stale: p => staleOf(p.label),
          wrongSource: p => wrongOf(p.label),
        },
        score: answers => {
          const correct = answers.filter((a, i) => suite.score(probes[i]!.label, a).outcome === 'correct').length;
          return { pass: correct === probes.length, detail: `${correct}/${probes.length} correct` };
        },
      });
    });
  }
});

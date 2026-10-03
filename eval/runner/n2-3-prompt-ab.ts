/**
 * N2-3 prompt A/B — matched before/after of gbrain's contradiction-judge
 * prompt on a fresh N2 world (development data; the counted seed 20261001
 * stays as published in the N2 report).
 *
 * One arm per gbrain commit. Each arm seeds the N2 world through `put_page`,
 * runs `runContradictionProbe` (keyword-only hybridSearch, top five, cache
 * off, four concurrent probe runs) and judges every planted pair plus a fixed
 * sha256-sampled 40% of unplanted pairs. Pairs outside the sample get a
 * no_contradiction stub and are not scored. Both arms must offer the same
 * pairs (`offered_keys_sha256`), so the only difference is the gbrain commit.
 *
 * Without `--paid` an arm judges nothing ($0) and records only the offered
 * pairs and their hash, which checks retrieval parity against a receipt.
 *
 * Usage:
 *   bun eval/runner/n2-3-prompt-ab.ts arm --gbrain <checkout>@<ref> --label before|after --output <arm.json>
 *       [--seed 20261002] [--paid --budget-run-id <id>]
 *   bun eval/runner/n2-3-prompt-ab.ts compare <before.json> <after.json> --output <receipt.json> [--ledger-summary <file>]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { JUDGE_MODEL, scoreClassification, type ClassificationSummary, type Judgment, type Verdict } from './n2-contradiction-surfacing.ts';
import { paidRequested, requirePaidArm } from './paid-arm.ts';
import { N2_GENERATOR_VERSION, generateN2World, n2Gold, pairKey, renderN2Page } from '../generators/n2-contradiction-gen.ts';

export const DEFAULT_SEED = 20261002;
export const SAMPLE_THRESHOLD = 103;
export const ARM_ESTIMATE_USD = 3.5;
const TOP_K = 5;
const SHARDS = 4;
const PROBE_BUDGET_USD = 6;

/** Fixed unplanted-pair sample: first sha256 byte of `n2-3:<pairKey>` below 103 (about 40%). */
export function inSample(key: string): boolean {
  return createHash('sha256').update(`n2-3:${key}`).digest()[0] < SAMPLE_THRESHOLD;
}

export function offeredKeysSha256(judgments: ReadonlyArray<Pick<Judgment, 'query_item' | 'key'>>): string {
  const keys = [...new Set(judgments.map(j => `${j.query_item}::${j.key}`))].sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

export interface ArmResult {
  label: string;
  seed: number;
  generator_version: string;
  world_fingerprint: string;
  gbrain: Record<string, unknown> | null;
  prompt_version: string;
  judge_model: string;
  paid: boolean;
  offered: number;
  judged: number;
  skipped_unsampled: number;
  skipped_by_date: number;
  offered_keys_sha256: string;
  cost: RunSummary | null;
  /** The receipt v2 cost block for the arm, with the ledger path, recorded cap and event-loop lag (0.10.12; absent in older arms). */
  receipt_cost?: ReturnType<typeof receiptCost> | null;
  score: ClassificationSummary | null;
  judgments: Judgment[];
}

type Flip = 'gained' | 'lost';
/** Pairs whose contradiction call changed between arms, by gold class. Throws when the arms judged different pairs. */
export function pairedFlips(before: readonly Judgment[], after: readonly Judgment[]): Record<string, Record<Flip, number>> {
  const id = (j: Judgment) => `${j.query}\u0000${j.key}`;
  const a = new Map(after.map(j => [id(j), j]));
  if (a.size !== before.length || before.some(j => !a.has(id(j)))) throw new Error('arms judged different pairs');
  const out: Record<string, Record<Flip, number>> = {};
  for (const b of before) {
    const was = b.verdict === 'contradiction';
    const now = a.get(id(b))!.verdict === 'contradiction';
    if (was === now) continue;
    const cls = b.gold.planted ? b.gold.gold_class : 'unplanted';
    const row = out[cls] ??= { gained: 0, lost: 0 };
    row[now ? 'gained' : 'lost']++;
  }
  return out;
}

const argValue = (argv: readonly string[], flag: string) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
};

async function runArm(argv: readonly string[]): Promise<ArmResult> {
  const label = argValue(argv, '--label') ?? 'arm';
  const seed = Number(argValue(argv, '--seed') ?? DEFAULT_SEED);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const paid = paidRequested(argv);
  if (paid) requirePaidArm(argv, { arm: `N2-3 prompt A/B (${label})`, estimateUsd: ARM_ESTIMATE_USD });
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (paid && !anthropicKey) throw new Error('the paid arm needs ANTHROPIC_API_KEY');
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const { ledger, fingerprint } = generateN2World({ seed });
  const gold = n2Gold(ledger);
  const paidRun = paid ? startPaidRun('n2-3-prompt-ab', { ...budgetOptionsFrom(argv), estimateUsd: ARM_ESTIMATE_USD }) : null;
  let result: ArmResult | undefined;
  try {
    result = await withHermeticEnv('n2-3-ab', async (): Promise<ArmResult> => {
      if (paid) process.env.ANTHROPIC_API_KEY = anthropicKey;
      const gw = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; isAvailable: (t: string) => boolean }>(gut, 'src/core/ai/gateway.ts');
      gw.configureGateway({ chat_model: JUDGE_MODEL, expansion_model: JUDGE_MODEL, env: paid ? { ANTHROPIC_API_KEY: anthropicKey } : {} });
      if (gw.isAvailable('embedding')) throw new Error('an embedding provider is available, so retrieval would not be keyword-only');
      const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => any }>(gut, 'src/core/pglite-engine.ts');
      const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (c: unknown, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
      const { runContradictionProbe } = await importGbrain<{ runContradictionProbe: (o: Record<string, unknown>) => Promise<any> }>(gut, 'src/core/eval-contradictions/runner.ts');
      const { judgeContradiction } = await importGbrain<{ judgeContradiction: (i: any) => Promise<any> }>(gut, 'src/core/eval-contradictions/judge.ts');
      const { PROMPT_VERSION } = await importGbrain<{ PROMPT_VERSION: string }>(gut, 'src/core/eval-contradictions/types.ts');
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      try {
        const putPage = operations.find(o => o.name === 'put_page')!;
        const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: 'default' };
        for (const p of ledger.pages) await putPage.handler(ctx, { slug: p.slug, content: renderN2Page(p) });

        const judgments: Judgment[] = [];
        let offered = 0;
        let skippedUnsampled = 0;
        let skippedByDate = 0;
        const NO = { verdict: 'no_contradiction', severity: 'info', axis: '', confidence: 1, resolution_kind: null };
        const qs = ledger.items.map(i => ({ query: i.query, item: i.id }));
        const itemOf = new Map(qs.map(q => [q.query, q.item]));
        const shards = Array.from({ length: SHARDS }, (_, k) => qs.filter((_q, i) => i % SHARDS === k));
        await Promise.all(shards.map(async shard => {
          const r = await runContradictionProbe({
            engine, queries: shard.map(q => q.query), topK: TOP_K, noCache: true, yesOverride: true, budgetUsd: PROBE_BUDGET_USD, judgeModel: JUDGE_MODEL,
            judgeFn: async (input: { query: string; a: { slug: string; text: string; effective_date?: string | null }; b: { slug: string; text: string; effective_date?: string | null } }) => {
              offered++;
              const g = gold(input.a, input.b);
              const key = pairKey(input.a.slug, input.b.slug);
              if (!g.planted && !inSample(key)) { skippedUnsampled++; return { verdict: NO, usage: { inputTokens: 0, outputTokens: 0 } }; }
              const row: Judgment = { query: input.query, query_item: itemOf.get(input.query) ?? null, a: input.a.slug, b: input.b.slug, key, gold: g, verdict: null, error: null, dates_seen: [input.a.effective_date ?? null, input.b.effective_date ?? null] };
              judgments.push(row);
              if (!paid) return { verdict: NO, usage: { inputTokens: 0, outputTokens: 0 } };
              try {
                if (paidRun!.guard.exhausted) throw new Error('budget exhausted');
                const o = await judgeContradiction({ ...input, model: JUDGE_MODEL });
                row.verdict = o.verdict.verdict as Verdict;
                return o;
              } catch (e) {
                row.error = e instanceof Error ? e.message : String(e);
                throw e;
              }
            },
          });
          skippedByDate += r.report.per_query.reduce((n: number, q: { pairs_skipped_by_date: number }) => n + q.pairs_skipped_by_date, 0);
          for (const pq of r.report.per_query) for (const f of pq.contradictions) {
            const j = judgments.find(x => x.query === pq.query && x.key === pairKey(f.a.slug, f.b.slug) && x.verdict === f.verdict && x.resolution_kind === undefined);
            if (j) { j.resolution_kind = f.resolution_kind; j.resolution_command = f.resolution_command; }
          }
        }));
        judgments.sort((x, y) => (x.query + x.key).localeCompare(y.query + y.key));
        return {
          label, seed, generator_version: N2_GENERATOR_VERSION, world_fingerprint: fingerprint, gbrain: overlaySummary(gut), prompt_version: PROMPT_VERSION,
          judge_model: JUDGE_MODEL, paid, offered, judged: judgments.length, skipped_unsampled: skippedUnsampled, skipped_by_date: skippedByDate,
          offered_keys_sha256: offeredKeysSha256(judgments), cost: null, score: paid ? scoreClassification(ledger, judgments) : null, judgments,
        };
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
  } finally {
    if (paidRun) {
      paidRun.guard.uninstall();
      const summary = paidRun.run.close();
      if (result) { result.cost = summary; result.receipt_cost = receiptCost(summary); }
    }
  }
  return result;
}

const METRICS = ['e2e_conflict_recall', 'classification_recall_offered_conflicts', 'false_contradiction_dated_changes', 'false_contradiction_compatible',
  'false_contradiction_unplanted_pairs', 'judged_pair_precision', 'temporal_recognition', 'judge_errors', 'resolution_acceptable'] as const;

export function compareArms(before: ArmResult, after: ArmResult) {
  if (before.seed !== after.seed || before.world_fingerprint !== after.world_fingerprint) throw new Error('arms ran different worlds');
  if (before.offered_keys_sha256 !== after.offered_keys_sha256) throw new Error('arms offered different pairs');
  if (!before.score || !after.score) throw new Error('compare needs two paid arms');
  const arm = (a: ArmResult) => ({
    label: a.label, gbrain: a.gbrain, prompt_version: a.prompt_version, offered: a.offered, judged: a.judged,
    skipped_unsampled: a.skipped_unsampled, skipped_by_date: a.skipped_by_date, judge_errors: a.judgments.filter(j => j.error).length,
    metrics: Object.fromEntries(METRICS.map(m => [m, a.score![m]])), by_variant: a.score!.by_variant,
  });
  return {
    kind: 'n2-3-prompt-ab',
    data_class: 'development',
    note: 'Fresh seed, not the counted seed 20261001; one judge sample per arm.',
    seed: before.seed, generator_version: before.generator_version, world_fingerprint: before.world_fingerprint,
    judge_model: before.judge_model, sample: { planted: 'all', unplanted: `sha256("n2-3:" + pairKey)[0] < ${SAMPLE_THRESHOLD}` },
    offered_keys_sha256: before.offered_keys_sha256,
    arms: { before: arm(before), after: arm(after) },
    paired_flips: pairedFlips(before.judgments, after.judgments),
  };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const output = argValue(rest, '--output');
  if (!output) throw new Error('--output <file> is required');
  let result: unknown;
  if (cmd === 'arm') {
    result = await runArm(rest);
  } else if (cmd === 'compare') {
    const [b, a] = rest.filter(x => !x.startsWith('--') && x !== output && x !== argValue(rest, '--ledger-summary'));
    const receipt: Record<string, unknown> = compareArms(JSON.parse(readFileSync(b, 'utf8')), JSON.parse(readFileSync(a, 'utf8')));
    const ledger = argValue(rest, '--ledger-summary');
    if (ledger) receipt.ledger_summary = JSON.parse(readFileSync(ledger, 'utf8'));
    result = receipt;
  } else {
    throw new Error('usage: n2-3-prompt-ab.ts arm|compare … (see the header)');
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 1) + '\n');
  const r = result as { offered?: number; judged?: number; offered_keys_sha256?: string; prompt_version?: string };
  console.log(JSON.stringify({ output, prompt_version: r.prompt_version, offered: r.offered, judged: r.judged, offered_keys_sha256: r.offered_keys_sha256 }));
}

if (import.meta.main) await main();

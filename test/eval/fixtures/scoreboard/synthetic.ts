/**
 * Synthetic scoreboard receipts for tests. Every score is invented and
 * seeded; nothing here came from a paid run or from sealed data. The layout
 * and record shapes are the ones eval/runner/scoreboard.ts reads.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { seededRandom } from '../../../../eval/runner/stats/paired.ts';
import { answerId, CAMPAIGN_SCHEMA, type AnswerRecord, type CampaignCell, type CampaignManifest, type JudgmentRecord, type RowRecord } from '../../../../eval/runner/scoreboard.ts';

export const READERS = ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'claude-fable-5-1'];
export const INSTRUMENT = 'beam-rubric-synthetic-v1';

export interface SyntheticCell {
  id: string; set: 'S1' | 'S2a'; system: string; arm: 'component' | 'whole-system'; budget: number | null; quality: number;
  status?: CampaignCell['status']; not_run_reason?: string; anchor?: boolean;
  /** Question indices whose answers record a harness failure for every reader. */
  harnessFail?: number[];
  /** Readers whose answers are left out entirely. */
  dropReaders?: string[];
  judgeRuns?: number;
  gzip?: boolean;
}

export interface SyntheticOptions {
  conversations?: number; questionsPerConversation?: number; cells?: SyntheticCell[];
  family1?: 'full' | 'shrunk' | 'descriptive'; shrunkComparators?: string[] | null;
  draws?: number; renderTargets?: string[]; releaseAssets?: CampaignManifest['release_assets'];
}

const EXTERNALS = ['ext-extract-first', 'ext-memory-bank', 'ext-graph-pipeline', 'ext-temporal-graph', 'ext-markdown-kb', 'ext-verbatim-session'];

export function defaultCells(): SyntheticCell[] {
  return [
    { id: 's1-gbrain-8k', set: 'S1', system: 'gbrain-defaults', arm: 'component', budget: 8000, quality: 0.62, judgeRuns: 3 },
    { id: 's1-extract-first-8k', set: 'S1', system: 'ext-extract-first', arm: 'component', budget: 8000, quality: 0.3, gzip: true },
    { id: 's1-memory-bank-8k', set: 'S1', system: 'ext-memory-bank', arm: 'component', budget: 8000, quality: 0.6, judgeRuns: 3 },
    { id: 's1-temporal-graph-8k', set: 'S1', system: 'ext-temporal-graph', arm: 'component', budget: 8000, quality: 0, status: 'not-run', not_run_reason: 'projected ingest past the cap (experiment limit)' },
    { id: 's1-hybrid-8k', set: 'S1', system: 'baseline-hybrid', arm: 'component', budget: 8000, quality: 0.5 },
    { id: 's1-none-8k', set: 'S1', system: 'baseline-none', arm: 'component', budget: 8000, quality: 0.05 },
    { id: 's1-gbrain-default', set: 'S1', system: 'gbrain-defaults', arm: 'whole-system', budget: null, quality: 0.66, anchor: true },
    { id: 's1-gbrain-think', set: 'S1', system: 'gbrain-defaults', arm: 'whole-system', budget: null, quality: 0.7 },
    { id: 's1-full-context', set: 'S1', system: 'baseline-full-context', arm: 'whole-system', budget: null, quality: 0, status: 'not-run', not_run_reason: 'does not fit any reader window' },
    { id: 's1-file-agent', set: 'S1', system: 'baseline-file-agent', arm: 'whole-system', budget: null, quality: 0.58 },
    { id: 's2a-gbrain-8k', set: 'S2a', system: 'gbrain-defaults', arm: 'component', budget: 8000, quality: 0.6 },
    { id: 's2a-memory-bank-8k', set: 'S2a', system: 'ext-memory-bank', arm: 'component', budget: 8000, quality: 0.55 },
    { id: 's2a-full-context', set: 'S2a', system: 'baseline-full-context', arm: 'whole-system', budget: null, quality: 0.8 },
  ];
}

/** Every external kind on S1, all far below gbrain: the only fixture where "beats the field" is allowed. */
export function fieldCells(): SyntheticCell[] {
  return [
    { id: 's1-gbrain-8k', set: 'S1', system: 'gbrain-defaults', arm: 'component', budget: 8000, quality: 0.9 },
    ...EXTERNALS.map(system => ({ id: `s1-${system}-8k`, set: 'S1' as const, system, arm: 'component' as const, budget: 8000, quality: 0.1 })),
    { id: 's1-hybrid-8k', set: 'S1', system: 'baseline-hybrid', arm: 'component', budget: 8000, quality: 0.1 },
    { id: 's1-none-8k', set: 'S1', system: 'baseline-none', arm: 'component', budget: 8000, quality: 0.02 },
  ];
}

const line = (x: unknown) => JSON.stringify(x) + '\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function writeSyntheticReceipt(dir: string, o: SyntheticOptions = {}): CampaignManifest {
  const G = o.conversations ?? 10, Q = o.questionsPerConversation ?? 6;
  const cells = o.cells ?? defaultCells();
  const rng = seededRandom(424242);
  const sched = (prefix: string, g: number) => Array.from({ length: g * Q }, (_, i) => ({ question_id: `${prefix}-c${Math.floor(i / Q)}:q${i % Q}`, conversation: `${prefix}-c${Math.floor(i / Q)}` }));
  const sets: CampaignManifest['sets'] = [
    { id: 'S1', label: 'BEAM-10M', benchmark: 'beam-10m', exposure: 'E0', role: 'headline', cluster_unit: 'conversation', claim_min_clusters: 9, scheduled: sched('10m', G), exclusions: [{ question_id: '10m-c1:q0', reason: 'gold entered an agent context (exposure record)' }] },
    { id: 'S2a', label: 'BEAM-100K sealed', benchmark: 'beam-100k', exposure: 'E2', role: 'public', cluster_unit: 'conversation', claim_min_clusters: 4, scheduled: sched('100k', 4), exclusions: [] },
  ];
  const campaignCells: CampaignCell[] = [];
  for (const c of cells) {
    const cdir = join(dir, 'cells', c.id);
    mkdirSync(cdir, { recursive: true });
    const runConfig = line({ cell_id: c.id, system: c.system, arm: c.arm, budget: c.budget, readers: READERS, instrument: INSTRUMENT });
    writeFileSync(join(cdir, 'run-config.json'), runConfig);
    writeFileSync(join(cdir, 'receipt.json'), line({ cell_id: c.id, run_status: c.status ?? 'complete' }));
    const readers = READERS.filter(r => !c.dropReaders?.includes(r));
    const rows: RowRecord[] = [], answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [];
    if (c.status !== 'not-run') {
      sets.find(s => s.id === c.set)!.scheduled.forEach((q, i) => {
        const abstention = i % Q === Q - 1;
        rows.push({ id: q.question_id, conversation: q.conversation, realization_id: `${c.id}-r1`, abstention, gold_count: abstention ? 0 : 2, recall_all_at_10: abstention ? null : rng() < c.quality ? 1 : 0, recall_all_at_5: abstention ? null : rng() < c.quality * 0.8 ? 1 : 0, latency_ms: 100 + Math.floor(rng() * 50), delivered_tokens: { cl100k_base: 7000 + Math.floor(rng() * 900), o200k_base: 6800 + Math.floor(rng() * 900) }, fill_rate: 0.9 });
        const context = sha(`${c.id}|${q.question_id}`);
        for (const reader of readers) {
          const harness = c.harnessFail?.includes(i);
          const a: AnswerRecord = {
            answer_id: answerId(c.id, q.question_id, reader, 0), cell_id: c.id, realization_id: `${c.id}-r1`, question_id: q.question_id, conversation: q.conversation,
            system: c.system, arm: c.arm, reader, replicate: 0, context_sha256: c.arm === 'component' ? context : sha(`${context}|${reader}`), text: `synthetic answer ${q.question_id} ${reader}`,
            usage: { input: 8000, output: 300, cache_read: 0, cache_write: 0 }, provider_input_tokens: 8100, latency_ms: 2000 + Math.floor(rng() * 1000), outcome: harness ? 'reader_error' : 'scored',
          };
          answers.push(a);
          if (harness) continue;
          const base = Math.min(1, Math.max(0, c.quality + (rng() - 0.5) * 0.6));
          const score = Math.round(base * 4) / 4;
          for (let j = 0; j < (c.judgeRuns ?? 1); j++) {
            judgments.push({ answer_id: a.answer_id, instrument_id: INSTRUMENT, instrument_sha256: sha(INSTRUMENT), judge: 'gpt-4.1-mini', judge_replicate: j, temperature: 0, score: j && rng() < 0.1 ? Math.max(0, score - 0.25) : score, parse_ok: true, raw_sha256: sha(`${a.answer_id}|${j}`), outcome: 'scored' });
          }
        }
      });
      const write = (name: string, recs: unknown[]) => {
        const text = recs.map(line).join('');
        if (c.gzip) writeFileSync(join(cdir, `${name}.gz`), gzipSync(text)); else writeFileSync(join(cdir, name), text);
      };
      write('rows.ndjson', rows); write('answers.ndjson', answers); write('judgments.ndjson', judgments);
    }
    campaignCells.push({
      cell_id: c.id, set: c.set, system: c.system, arm: c.arm, budget: c.budget, configuration: c.system.startsWith('ext-') ? 'recipe' : c.system === 'gbrain-defaults' ? 'shipped-defaults' : 'baseline',
      ...(c.anchor ? { anchor: true } : {}), status: c.status ?? 'complete', ...(c.not_run_reason ? { not_run_reason: c.not_run_reason } : {}),
      readers: READERS, canonical_instrument: INSTRUMENT, config_sha256: sha(runConfig),
    });
  }
  const s1 = (arm: string) => cells.filter(c => c.set === 'S1' && c.arm === arm && c.system !== 'gbrain-defaults').map(c => c.id);
  const families: CampaignManifest['families'] = [
    { id: 'F1', label: 'BEAM-10M, component, 8,000 tokens', anchor: 's1-gbrain-8k', comparators: s1('component') },
    { id: 'F3', label: 'BEAM-10M, strict recall_all@10 (diagnostic)', anchor: 's1-gbrain-8k', comparators: s1('component') },
  ];
  if (cells.some(c => c.id === 's1-gbrain-default')) families.splice(1, 0, { id: 'F2', label: 'BEAM-10M, whole system', anchor: 's1-gbrain-default', comparators: s1('whole-system') });
  const campaign: CampaignManifest = {
    schema: CAMPAIGN_SCHEMA, campaign_id: 'q1-scoreboard-synthetic', campaign_hash: sha('synthetic'),
    gbrain: { commit: 'c5fb0201aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '0.60.95.0', resolved_search_mode: 'hybrid' },
    measured: { from: '2026-10-20', to: '2026-10-28' }, readers: READERS,
    statistics: { alpha: 0.05, draws: o.draws ?? 199, descriptive_draws: 1000, seed: 7 },
    sets, cells: campaignCells, families,
    pins: [{ system: 'ext-memory-bank', version: '0.10.2', latest_release: '0.10.3' }, { system: 'ext-extract-first', version: '2.2.1', latest_release: null }],
    release_assets: o.releaseAssets ?? [], disclosures: ['Synthetic fixture: every number is invented.'], render_targets: o.renderTargets ?? [],
  };
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
  writeFileSync(join(dir, 'power.json'), JSON.stringify({ schema: 'gbrain-evals/q1-power/v1', decision: { family1: o.family1 ?? 'full', detectable_difference_points: 12.5, shrunk_comparators: o.shrunkComparators ?? null } }, null, 2) + '\n');
  return campaign;
}

/**
 * Synthetic scoreboard receipts for tests. Every score is invented and
 * seeded; nothing here came from a paid run or from sealed data. The layout
 * and record shapes are the ones eval/runner/scoreboard.ts reads.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { seededRandom } from '../../../../eval/runner/stats/paired.ts';
import { CURRENT_CLASSIFIER } from '../../../../eval/runner/q1/hedge.ts';
import { answerId, CAMPAIGN_SCHEMA, RS1_COST_FILE, RS1_COST_SCHEMA, RS1_SENSITIVITY_FILE, type AnswerRecord, type CampaignCell, type CampaignManifest, type JudgmentRecord, type RowRecord } from '../../../../eval/runner/scoreboard.ts';
import { judgeInstrumentId } from '../../../../eval/runner/q1/cells/judging.ts';
import { ARMS, frozenBlock, JUDGES, OPUS, PARTICLE, positions, RS1_VERDICT_PATH, sensitivitySample, SENSITIVITY_JUDGE, SOL, type Rs1Block } from '../../../../eval/runner/rs1/verdict.ts';

export const READERS = ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5'];
export const INSTRUMENT = 'beam-rubric-synthetic-v1';

export interface SyntheticCell {
  id: string; set: 'S1' | 'S2a'; system: string; arm: 'component' | 'whole-system'; budget: number | null; quality: number;
  status?: CampaignCell['status']; not_run_reason?: string; anchor?: boolean;
  /** Question indices whose answers record a harness failure for every reader. */
  harnessFail?: number[];
  /** Question indices whose answers from these readers record does_not_fit (the history did not fit the reader's window). */
  doesNotFit?: { questions: number[]; readers: string[] };
  /** Readers whose answers are left out entirely. */
  dropReaders?: string[];
  judgeRuns?: number;
  gzip?: boolean;
  /** Answer text per question index and reader (default: a confident synthetic sentence). */
  answerText?: (i: number, reader: string) => string;
  /** Canonical score per question index and reader (default: seeded around `quality`). */
  scoreOf?: (i: number, reader: string) => number;
  /** Stamp each judged answer with this old-style `hedge` field (cells run before verdicts moved to render time). */
  legacyStamp?: { verdict: 'abstain' | 'hedged' | 'confident'; classifier_version: string };
}

export interface SyntheticOptions {
  conversations?: number; questionsPerConversation?: number; cells?: SyntheticCell[];
  family1?: 'full' | 'shrunk' | 'descriptive'; shrunkComparators?: string[] | null;
  draws?: number; renderTargets?: string[]; releaseAssets?: CampaignManifest['release_assets']; detectableDifference?: number;
  /** campaign.json `hedge_classifier` (default: CURRENT_CLASSIFIER). */
  hedgeClassifier?: string;
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
          const unfit = !!c.doesNotFit?.questions.includes(i) && c.doesNotFit.readers.includes(reader);
          const text = c.answerText?.(i, reader) ?? `synthetic answer ${q.question_id} ${reader}`;
          const a: AnswerRecord = {
            answer_id: answerId(c.id, q.question_id, reader, 0), cell_id: c.id, realization_id: `${c.id}-r1`, question_id: q.question_id, conversation: q.conversation,
            system: c.system, arm: c.arm, reader, replicate: 0, context_sha256: c.arm === 'component' ? context : sha(`${context}|${reader}`), text,
            usage: { input: 8000, output: 300, cache_read: 0, cache_write: 0 }, provider_input_tokens: 8100, latency_ms: 2000 + Math.floor(rng() * 1000), outcome: harness ? 'reader_error' : unfit ? 'does_not_fit' : 'scored',
            ...(harness || unfit ? {} : { ...(c.legacyStamp ? { hedge: c.legacyStamp } : {}), delivered_tokens: { cl100k_base: 7000 + i, o200k_base: 6800 + i } }),
          };
          answers.push(a);
          if (harness || unfit) continue;
          const score = c.scoreOf ? c.scoreOf(i, reader) : Math.round(Math.min(1, Math.max(0, c.quality + (rng() - 0.5) * 0.6)) * 4) / 4;
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
      ...(c.system === 'gbrain-defaults' ? { pin: 'GBrain 0.60.95.0 (c5fb0201, 2026-10-01)' } : {}),
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
    gbrain: { commit: 'c5fb0201aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '0.60.95.0', date: '2026-10-01', resolved_search_mode: 'hybrid' },
    measured: { from: '2026-10-20', to: '2026-10-28' }, readers: READERS,
    statistics: { alpha: 0.05, draws: o.draws ?? 199, descriptive_draws: 1000, seed: 7 }, hedge_classifier: o.hedgeClassifier ?? CURRENT_CLASSIFIER,
    sets, cells: campaignCells, families,
    pins: [{ system: 'ext-memory-bank', version: '0.10.2', latest_release: '0.10.3' }, { system: 'ext-extract-first', version: '2.2.1', latest_release: null }],
    release_assets: o.releaseAssets ?? [], disclosures: ['Synthetic fixture: every number is invented.'], render_targets: o.renderTargets ?? [],
  };
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
  writeFileSync(join(dir, 'power.json'), JSON.stringify({ schema: 'gbrain-evals/q1-power/v1', decision: { family1: o.family1 ?? 'full', threshold_points: 10, detectable_difference_points: o.detectableDifference ?? 8.5, shrunk_comparators: o.shrunkComparators ?? null } }, null, 2) + '\n');
  return campaign;
}

// ─── RS1 mode (eval/runner/rs1/verdict.ts) ──────────────────────────

/** A synthetic RS1 row: an arm cell id the frozen block names, its kind, and how its invented answers score. */
export interface Rs1SyntheticCell {
  id: string; system: string; arm: 'component' | 'whole-system'; quality: number;
  status?: CampaignCell['status']; not_run_reason?: string;
  /** cl100k tokens delivered per question index (packed rows; default 7,700 to 8,300). */
  delivered?: (i: number) => number;
  /** Score per question index and reader, before rounding to quarters (default: seeded around `quality`). */
  scoreOf?: (i: number, reader: string) => number;
  /** Answers recorded as a harness failure, as [question index, reader]. */
  harnessFail?: Array<[number, string]>;
  /** Planned-judge records left out, as [question index, reader, judge]; a particle-1 packed answer's are in its re-read. */
  dropJudge?: Array<[number, string, string]>;
}

export interface Rs1SyntheticOptions {
  /** Conversation positions (default: six inside the judge-sensitivity sample and six outside it). */
  conversations?: string[]; questionsPerConversation?: number; cells?: Rs1SyntheticCell[];
  /** Write particle-1's re-reads of the packed rows (default true), the sensitivity judgments (default true) and rs1-cost.json (default true). */
  rereads?: boolean; sensitivity?: boolean; cost?: boolean;
}

export const RS1_INSTRUMENT = { id: 'beam-1m', canonical_judge: 'openai:gpt-4.1-mini' };

export function rs1Cells(): Rs1SyntheticCell[] {
  return [
    { id: ARMS.gbrain8k, system: 'gbrain-defaults', arm: 'component', quality: 0.8 },
    { id: ARMS.servers[0], system: 'ext-extract-first', arm: 'component', quality: 0.3 },
    { id: ARMS.servers[1], system: 'ext-memory-bank', arm: 'component', quality: 0.45 },
    { id: ARMS.servers[2], system: 'ext-temporal-graph', arm: 'component', quality: 0.35 },
    { id: ARMS.think, system: 'gbrain-defaults', arm: 'whole-system', quality: 0.85 },
    { id: ARMS.fileAgent, system: 'baseline-file-agent', arm: 'whole-system', quality: 0.55 },
    { id: ARMS.descriptive[0], system: 'baseline-hybrid', arm: 'component', quality: 0.4 },
    { id: ARMS.descriptive[1], system: 'baseline-none', arm: 'component', quality: 0.05 },
  ];
}

/** The rs1 block as publication.json freezes it, hashing this checkout's verdict.ts. */
export function rs1Block(): Rs1Block {
  return { verdict_sha256: sha(readFileSync(resolve(import.meta.dir, '../../../..', RS1_VERDICT_PATH), 'utf8')), amendments: [], ...frozenBlock('N') };
}

const seedOf = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

export function writeSyntheticRs1Receipt(dir: string, o: Rs1SyntheticOptions = {}): CampaignManifest {
  const sample = new Set(sensitivitySample('N'));
  const convs = o.conversations ?? [...positions('N').filter(p => sample.has(p)).slice(0, 6), ...positions('N').filter(p => !sample.has(p)).slice(0, 6)].sort();
  const Q = o.questionsPerConversation ?? 5;
  const scheduled = convs.flatMap(c => Array.from({ length: Q }, (_, q) => ({ question_id: `${c}:q${q}`, conversation: c })));
  const block = rs1Block();
  const quarter = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 4) / 4;
  const campaignCells: CampaignCell[] = [];
  const cost: Array<{ cell_id: string; reader: string; ingest_usd_per_conversation: number; read_usd_per_question: number }> = [];
  for (const c of o.cells ?? rs1Cells()) {
    const packed = c.arm === 'component';
    const readers = packed ? [OPUS, SOL] : [OPUS, SOL, PARTICLE];
    const judging = { by_reader: Object.fromEntries(readers.map(r => [r, JUDGES[r]])) };
    const cdir = join(dir, 'cells', c.id);
    mkdirSync(cdir, { recursive: true });
    const runConfig = line({ cell_id: c.id, system: c.system, arm: c.arm, readers, judging });
    writeFileSync(join(cdir, 'run-config.json'), runConfig);
    writeFileSync(join(cdir, 'receipt.json'), line({ cell_id: c.id, run_status: c.status ?? 'complete' }));
    campaignCells.push({
      cell_id: c.id, set: 'RS1', system: c.system, arm: c.arm, budget: packed ? 8000 : null, configuration: c.id.split('.').slice(2, -1).join('.'), status: c.status ?? 'complete',
      ...(c.not_run_reason ? { not_run_reason: c.not_run_reason } : {}), readers, canonical_instrument: RS1_INSTRUMENT.id, config_sha256: sha(runConfig), judging,
      ...(c.system === 'gbrain-defaults' ? { pin: 'GBrain 0.60.557.0 (62637c96, 2026-11-03)' } : {}),
    });
    if (c.status === 'not-run') continue;
    const rng = seededRandom(seedOf(c.id));
    const score = (i: number, reader: string) => quarter(c.scoreOf ? c.scoreOf(i, reader) : c.quality + (rng() - 0.5) * 0.6);
    const rows: RowRecord[] = [], answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [], sens: JudgmentRecord[] = [];
    const rereadAnswers: AnswerRecord[] = [], rereadJudgments: JudgmentRecord[] = [];
    const rereadCell = block.reread[c.id];
    const judge = (out: JudgmentRecord[], a: AnswerRecord, j: string, s: number) => out.push({ answer_id: a.answer_id, instrument_id: judgeInstrumentId(RS1_INSTRUMENT, j), instrument_sha256: sha(RS1_INSTRUMENT.id), judge: j, judge_replicate: 0, temperature: 0, score: s, parse_ok: true, raw_sha256: sha(`${a.answer_id}|${j}`), outcome: 'scored' });
    const answer = (cellId: string, q: { question_id: string; conversation: string }, i: number, reader: string, context: string): AnswerRecord => {
      const harness = !!c.harnessFail?.some(([k, r]) => k === i && r === reader);
      return {
        answer_id: answerId(cellId, q.question_id, reader, 0), cell_id: cellId, realization_id: `${c.id}-r1`, question_id: q.question_id, conversation: q.conversation, system: c.system, arm: c.arm, reader, replicate: 0,
        context_sha256: context, text: `synthetic answer ${q.question_id} ${reader}`, usage: { input: 8000, output: 300, cache_read: 0, cache_write: 0 }, provider_input_tokens: 8100, latency_ms: 2000, outcome: harness ? 'reader_error' : 'scored',
      };
    };
    scheduled.forEach((q, i) => {
      const delivered = packed ? (c.delivered ? c.delivered(i) : 7700 + Math.floor(rng() * 600)) : null;
      rows.push({ id: q.question_id, conversation: q.conversation, realization_id: `${c.id}-r1`, abstention: false, gold_count: 2, recall_all_at_10: 1, latency_ms: 100, ...(delivered === null ? {} : { delivered_tokens: { cl100k_base: delivered, o200k_base: delivered - 200 } }), fill_rate: 0.9 });
      const context = sha(`${c.id}|${q.question_id}`);
      const record = (cellId: string, reader: string, out: JudgmentRecord[], list: AnswerRecord[]) => {
        const a = answer(cellId, q, i, reader, packed ? context : sha(`${context}|${reader}`));
        list.push(a);
        if (a.outcome !== 'scored') return;
        const s = score(i, reader);
        for (const j of JUDGES[reader]) if (!c.dropJudge?.some(([k, r, d]) => k === i && r === reader && d === j)) judge(out, a, j, s);
        if (reader !== PARTICLE && sample.has(q.conversation)) judge(sens, a, SENSITIVITY_JUDGE, quarter(s - 0.25));
      };
      for (const reader of readers) record(c.id, reader, judgments, answers);
      if (packed && rereadCell) record(rereadCell, PARTICLE, rereadJudgments, rereadAnswers);
    });
    const write = (path: string, recs: unknown[]) => writeFileSync(path, recs.map(line).join(''));
    write(join(cdir, 'rows.ndjson'), rows); write(join(cdir, 'answers.ndjson'), answers); write(join(cdir, 'judgments.ndjson'), judgments);
    if (o.sensitivity ?? true) write(join(cdir, RS1_SENSITIVITY_FILE), sens);
    if (packed && rereadCell && (o.rereads ?? true)) {
      const rdir = join(dir, 'cells', rereadCell);
      mkdirSync(rdir, { recursive: true });
      write(join(rdir, 'answers.ndjson'), rereadAnswers); write(join(rdir, 'judgments.ndjson'), rereadJudgments);
      writeFileSync(join(rdir, 'receipt.json'), line({ cell_id: rereadCell, reader: PARTICLE }));
    }
    for (const reader of [OPUS, SOL, PARTICLE]) cost.push({ cell_id: c.id, reader, ingest_usd_per_conversation: c.system === 'gbrain-defaults' ? 3.4 : 1.2, read_usd_per_question: reader === PARTICLE ? 0.002 : 0.03 });
  }
  if (o.cost ?? true) writeFileSync(join(dir, RS1_COST_FILE), JSON.stringify({ schema: RS1_COST_SCHEMA, vcpu_hour_usd: block.cost.vcpu_hour_usd, rows: cost }, null, 2) + '\n');
  const campaign: CampaignManifest = {
    schema: CAMPAIGN_SCHEMA, campaign_id: 'rs1-ranking-set-synthetic', campaign_hash: sha('rs1-synthetic'),
    gbrain: { commit: '62637c96a5a5c2e9d55594f87a33d79c2f30b54f', version: '0.60.557.0', date: '2026-11-03', resolved_search_mode: 'tokenmax' },
    measured: { from: '2026-11-20', to: '2026-11-28' }, readers: [OPUS, SOL, PARTICLE], statistics: { alpha: 0.05, draws: 199, descriptive_draws: 199, seed: 7 }, hedge_classifier: 'none',
    sets: [{ id: 'RS1', label: 'RS1', benchmark: 'beam-rs1', exposure: 'E0', role: 'headline', cluster_unit: 'conversation', claim_min_clusters: 9, scheduled, exclusions: [], sealed: true }],
    cells: campaignCells, families: [], pins: [], release_assets: [], disclosures: ['Synthetic fixture: every number is invented.'], render_targets: [], rs1: block,
  };
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(campaign, null, 2) + '\n');
  return campaign;
}

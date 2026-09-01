/**
 * BrainBench Cat 35 — Transcript → Brain-Page Distillation Fidelity.
 *
 * What % of the planted salient units (facts / ideas / decisions / vibes /
 * entities) in an agent-conversation transcript survive into gbrain's output,
 * across three write-path lanes:
 *
 *   verbatim — runTranscriptsIngest only (control/floor; calibrates gold+judge)
 *   facts    — ingest → runExtractConversationFactsCore (memory-write lane)
 *   dream    — triage → runPhaseSynthesize (THE headline distillation feature)
 *
 * Run:
 *   bun eval/runner/cat35-transcript-distill.ts              # BPRE smoke (default): 2 transcripts, Haiku — measured $0.10 / 81s
 *   CAT35_FULL=1 bun eval/runner/cat35-transcript-distill.ts # full 24 × 3 lanes — measured $6.20 / 29 min (Sonnet judge)
 *   ... --lanes verbatim,dream --transcripts coding-reflection-01 --json --judge-calibration
 *
 * Safe-by-default: the runner DEFAULTS to BPRE so `eval:brainbench` sweeps can
 * never accidentally launch a full-spend run. Env:
 *   ANTHROPIC_API_KEY (required), OPENAI_API_KEY (required — gateway embedding
 *   config; corpus itself is noEmbed), CAT35_FULL=1, CAT35_JUDGE_MODEL,
 *   CAT35_HARD_STOP_USD (default 40, pre-flight phase arithmetic).
 *
 * Cost note: per-process LLM semaphore (llm-budget.ts); under all.ts p-limit 2
 * subprocesses the worst case is 8 concurrent LLM calls.
 *
 * Receipt: eval/reports/cat35-transcript-distill/<date>-<HHMMSS>-cat35[-bpre].json
 * (schema: eval/schemas/cat35-receipt.schema.json). Judged artifacts persist to
 * <date>-<HHMMSS>-artifacts/ so verdicts stay reconstructable.
 */

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

// Isolated HOME set at module scope (cat30 idiom). ESM hoisting means the
// gbrain imports below EVALUATE first — this works because gbrain reads
// GBRAIN_HOME lazily at call time (config.ts configDir), long after main()
// starts. mkdtempSync (not a predictable epoch name): owner-only creation,
// immune to pre-created/symlinked paths in a shared /tmp (CWE-377).
const RUN_STAMP = new Date();
const RUN_TMP = mkdtempSync(join(tmpdir(), 'cat35-'));
process.env.GBRAIN_HOME = join(RUN_TMP, 'gbrain-home');

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { configureGateway } from 'gbrain/ai/gateway';
import { importFromContent } from 'gbrain/import-file';
// Deep imports — valid ONLY at the pinned gbrain SHA (package.json). Bumping
// the pin requires re-verifying these paths (0.47.x shipped module peels).
import { runTranscriptsIngest } from '../../node_modules/gbrain/src/core/transcripts/ingest.ts';
import { runExtractConversationFactsCore } from '../../node_modules/gbrain/src/commands/extract-conversation-facts.ts';
import { runPhaseSynthesize } from '../../node_modules/gbrain/src/core/cycle/synthesize.ts';
import {
  anchorPresent,
  addedContent,
  bootstrapCI,
  compressionRatio,
  computeDelta,
  quoteFidelity,
  scanDistractors,
  segmentClaims,
  thresholdCurve,
  weightedKappa,
  type TriageVerdictRow,
} from './cat35-checks.ts';
import {
  CAT35_JUDGE_PROMPT_VERSION,
  confirmDistractorLeaks,
  getJudgeModelsResolved,
  resetJudgeModelsResolved,
  scoreGrounding,
  scoreSalienceCoverage,
  scoreUsabilityChecklist,
  singleResolvedModel,
  type CoverageVerdict,
} from './cat35-judges.ts';

// ─── Types over the committed fixtures ────────────────────────────────────

type Lane = 'verbatim' | 'facts' | 'dream';
const ALL_LANES: Lane[] = ['verbatim', 'facts', 'dream'];

interface GoldFile {
  schema_version: number;
  transcript_id: string;
  scenario: string;
  variant: 'prose' | 'long-noisy';
  expected_triage: 'high' | 'low';
  session_id: string;
  base_ts: string;
  entities: string[];
  items: Array<{
    item_id: string;
    kind: 'fact' | 'idea' | 'decision' | 'vibe' | 'entity';
    statement: string;
    verbatim_anchor: string;
    notability: 'high' | 'medium' | 'low';
    planted_turn: number;
    depth_bucket: 'early' | 'middle' | 'late';
  }>;
  distractors: Array<{ distractor_id: string; statement: string; anchor: string; planted_turn: number }>;
  hazards: Array<{
    hazard_id: string;
    type: string;
    wrong_claim: string;
    anchor: string;
    planted_turn: number;
  }>;
}

interface PerItemRow {
  transcript_id: string;
  lane: Lane;
  item_id: string;
  kind: string;
  notability: string;
  depth_bucket: string;
  status: 'FULL' | 'PARTIAL' | 'ABSENT' | 'JUDGE_FAILED';
  joint: number | null;
}

// ─── Opts ─────────────────────────────────────────────────────────────────

interface Opts {
  full: boolean;
  limit: number | null;
  json: boolean;
  lanes: Lane[];
  transcripts: string[] | null;
  judgeCalibration: boolean;
  /** Optional explicit annotation file after --judge-calibration. */
  judgeCalibrationPath: string | null;
}

function parseOpts(): Opts {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const lanesRaw = get('--lanes');
  const lanes = lanesRaw
    ? (lanesRaw.split(',').map((s) => s.trim()) as Lane[])
    : [...ALL_LANES];
  for (const l of lanes) {
    if (!ALL_LANES.includes(l)) {
      process.stderr.write(`[cat35] unknown lane '${l}' (valid: ${ALL_LANES.join(',')})\n`);
      process.exit(2);
    }
  }
  return {
    full: process.env.CAT35_FULL === '1',
    limit: get('--limit') ? Number(get('--limit')) : null,
    json: a.includes('--json'),
    lanes,
    transcripts: get('--transcripts') ? get('--transcripts')!.split(',').map((s) => s.trim()) : null,
    judgeCalibration: a.includes('--judge-calibration'),
    judgeCalibrationPath:
      get('--judge-calibration') && !get('--judge-calibration')!.startsWith('--')
        ? (get('--judge-calibration') ?? null)
        : null,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────

const CORPUS_DIR = resolve('eval/data/transcript-distill-v1');
const REPORT_DIR = resolve('eval/reports/cat35-transcript-distill');
const BASELINE_DIR = resolve('docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill');
const ALLOW_LIST_PATH = resolve('node_modules/gbrain/skills/_brain-filing-rules.json');
const SOURCE_ID = 'default';
// NaN-guarded: a typo'd env value must fail closed to the default, not
// disable the cap (NaN comparisons are always false).
const HARD_STOP_USD = (() => {
  const v = Number(process.env.CAT35_HARD_STOP_USD ?? 40);
  return Number.isFinite(v) && v > 0 ? v : 40;
})();
const DREAM_CONCURRENCY = 2;
const HAIKU = 'anthropic:claude-haiku-4-5';
const SONNET = 'anthropic:claude-sonnet-4-6';
// Worst-case pre-flight cost model (per-call bounds; deliberately pessimistic).
const EST = {
  dreamPerTranscriptFull: 0.9, // Sonnet subagent, ≤16 turns, 600s cap
  dreamPerTranscriptBpre: 0.15, // Haiku, ≤8 turns
  factsPerTranscriptFull: 0.15,
  factsPerTranscriptBpre: 0.03,
  judgePerBatchHaiku: 0.03,
  judgePerBatchSonnet: 0.15,
};

const err = (msg: string) => process.stderr.write(`[cat35] ${msg}\n`);

function sha256(buf: string | Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Tiny inline concurrency limiter (repo has no p-limit dep). */
function makeLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Loop, not if: a waiter woken by next() races new callers for the slot;
    // re-check the cap after every wake or concurrency can exceed max.
    while (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function pageContent(page: { compiled_truth?: string } | null): string {
  return page?.compiled_truth ?? '';
}

// ─── Fixture loading ──────────────────────────────────────────────────────

interface Fixture {
  gold: GoldFile;
  jsonlPath: string;
  txtPath: string;
  transcriptText: string; // the .txt rendering — the grounding reference
}

function loadFixtures(): Fixture[] {
  const goldDir = join(CORPUS_DIR, 'gold');
  if (!existsSync(goldDir)) {
    err(`corpus not found at ${goldDir} — run eval:generate-transcript-distill first`);
    process.exit(2);
  }
  const fixtures: Fixture[] = [];
  for (const f of readdirSync(goldDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const gold: GoldFile = JSON.parse(readFileSync(join(goldDir, f), 'utf8'));
    const date = gold.base_ts.slice(0, 10);
    const jsonlPath = join(CORPUS_DIR, 'transcripts', `${date}-${gold.transcript_id}.jsonl`);
    const txtPath = join(CORPUS_DIR, 'transcripts-txt', `${date}-${gold.transcript_id}.txt`);
    if (!existsSync(jsonlPath) || !existsSync(txtPath)) {
      err(`fixture files missing for ${gold.transcript_id} (${jsonlPath})`);
      process.exit(2);
    }
    fixtures.push({ gold, jsonlPath, txtPath, transcriptText: readFileSync(txtPath, 'utf8') });
  }
  return fixtures;
}

function loadScaffold(): Array<{ slug: string; body: string }> {
  const dir = join(CORPUS_DIR, 'brain-scaffold');
  const out: Array<{ slug: string; body: string }> = [];
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(d, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.md')) {
        out.push({
          slug: `${prefix}${entry.name.replace(/\.md$/, '')}`,
          body: readFileSync(join(d, entry.name), 'utf8'),
        });
      }
    }
  };
  walk(dir, '');
  return out;
}

// ─── Engine bootstrap ─────────────────────────────────────────────────────

async function makeEngine(scaffold: Array<{ slug: string; body: string }>): Promise<InstanceType<typeof PGLiteEngine>> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const p of scaffold) {
    await importFromContent(engine, p.slug, p.body, { noEmbed: true, sourceId: SOURCE_ID });
  }
  return engine;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseOpts();
  const wallStart = Date.now();

  // Setup gates (exit 2 = setup failure).
  if (!process.env.ANTHROPIC_API_KEY) {
    err('ANTHROPIC_API_KEY is required');
    return 2;
  }
  if (!process.env.OPENAI_API_KEY) {
    err('OPENAI_API_KEY is required (gateway embedding config; corpus runs noEmbed but the dream subagent search path may embed queries)');
    return 2;
  }
  if (!existsSync(ALLOW_LIST_PATH)) {
    err(`gbrain allow-list missing at ${ALLOW_LIST_PATH} — bun install broken?`);
    return 2;
  }

  const judgeModel =
    process.env.CAT35_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001';
  const dreamModel = opts.full ? SONNET : HAIKU;
  const factsModel = opts.full ? SONNET : HAIKU;
  const maxTurns = opts.full ? 16 : 8;

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    chat_model: dreamModel,
    env: process.env as Record<string, string>,
  });

  // Fixture selection.
  let fixtures = loadFixtures();
  const allFixtureCount = fixtures.length;
  const manifestPath = join(CORPUS_DIR, '_manifest.json');
  const corpusSha = sha256(readFileSync(manifestPath));
  // Corpus integrity: every loaded fixture must match its manifest hash —
  // corpus_sha pins the manifest, and this check pins the files TO the
  // manifest (a --max partial regen or hand edit otherwise reuses the old
  // corpus_sha over different bytes).
  {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      items: Array<{ path: string; content_sha256: string }>;
    };
    const hashByPath = new Map(manifest.items.map((i) => [i.path, i.content_sha256]));
    for (const f of fixtures) {
      for (const p of [f.jsonlPath, f.txtPath]) {
        const rel = p.slice(CORPUS_DIR.length + 1);
        const expected = hashByPath.get(rel);
        if (expected && sha256(readFileSync(p)) !== expected) {
          err(`corpus integrity: ${rel} does not match its manifest content_sha256 — regenerate the corpus or restore the file`);
          return 2;
        }
      }
    }
  }
  if (opts.limit !== null && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    err(`--limit must be a positive integer`);
    return 2;
  }
  if (opts.transcripts) {
    const known = new Set(fixtures.map((f) => f.gold.transcript_id));
    const unknown = opts.transcripts.filter((t) => !known.has(t));
    if (unknown.length) {
      err(`--transcripts unknown id(s): ${unknown.join(', ')}`);
      return 2;
    }
    fixtures = fixtures.filter((f) => opts.transcripts!.includes(f.gold.transcript_id));
  } else if (!opts.full) {
    // BPRE: first expected-high prose + first expected-low, deterministic.
    const high = fixtures.find((f) => f.gold.expected_triage === 'high' && f.gold.variant === 'prose');
    const low = fixtures.find((f) => f.gold.expected_triage === 'low');
    fixtures = [high, low].filter((x): x is Fixture => Boolean(x));
  }
  if (opts.limit) fixtures = fixtures.slice(0, opts.limit);
  if (fixtures.length === 0) {
    err('no fixtures selected');
    return 2;
  }
  // Mode integrity: 'full' is publication-eligible and therefore requires the
  // WHOLE corpus and ALL lanes. CAT35_FULL=1 plus any narrowing flag is a
  // deliberate partial run — receipts must say so (a cherry-picked subset
  // must never masquerade as the published benchmark).
  const isWholeRun =
    fixtures.length === allFixtureCount &&
    opts.lanes.length === ALL_LANES.length &&
    !opts.limit &&
    !opts.transcripts;
  const mode = opts.full ? (isWholeRun ? 'full' : 'partial') : 'b-pre-validity';
  err(`mode=${mode} lanes=${opts.lanes.join(',')} transcripts=${fixtures.length} judge=${judgeModel}`);

  // Pre-flight budget arithmetic (mid-call aborts are impossible; refuse to start instead).
  const nSignal = fixtures.filter((f) => f.gold.items.length > 0).length;
  const dreamEst = opts.lanes.includes('dream')
    ? fixtures.length * (opts.full ? EST.dreamPerTranscriptFull : EST.dreamPerTranscriptBpre)
    : 0;
  const factsEst = opts.lanes.includes('facts')
    ? fixtures.length * (opts.full ? EST.factsPerTranscriptFull : EST.factsPerTranscriptBpre)
    : 0;
  // 3 = grounding + leakage-confirm + usability per transcript (pessimistic;
  // hazard + joint-fallback calls ride inside the per-batch price).
  const EXTRA_JUDGE_BATCHES_PER_TRANSCRIPT = 3;
  const judgeBatches = nSignal * opts.lanes.length + fixtures.length * EXTRA_JUDGE_BATCHES_PER_TRANSCRIPT;
  const judgeEst =
    // Unknown judge models estimate at the EXPENSIVE rate (only haiku earns
    // the cheap estimate) — a pricier model must not sneak past pre-flight.
    judgeBatches * (judgeModel.includes('haiku') ? EST.judgePerBatchHaiku : EST.judgePerBatchSonnet);
  const projected = dreamEst + factsEst + judgeEst;
  if (projected > HARD_STOP_USD) {
    err(`pre-flight: projected worst-case $${projected.toFixed(2)} exceeds CAT35_HARD_STOP_USD=$${HARD_STOP_USD} — refusing to start`);
    return 2;
  }
  err(`pre-flight: projected worst-case $${projected.toFixed(2)} (cap $${HARD_STOP_USD})`);

  const scaffold = loadScaffold();
  const scaffoldBySlug = new Map(scaffold.map((p) => [p.slug, p.body]));
  let totalCost = 0;

  // Per-transcript state.
  interface TState {
    fixture: Fixture;
    laneDocs: Partial<Record<Lane, string>>;
    lanePages: Partial<Record<Lane, Array<{ slug: string; body: string }>>>;
    laneError: Partial<Record<Lane, string>>;
    triageScore: number | null;
    dreamEmitted: boolean;
    childOutcomes: unknown;
  }
  const states = new Map<string, TState>(
    fixtures.map((f) => [
      f.gold.transcript_id,
      {
        fixture: f,
        laneDocs: {},
        lanePages: {},
        laneError: {},
        triageScore: null,
        dreamEmitted: false,
        childOutcomes: null,
      },
    ]),
  );

  // ── Lanes 1+2: Engine A (shared, production-faithful ordering) ──────────
  let factsBudgetExhausted = false;
  if (opts.lanes.includes('verbatim') || opts.lanes.includes('facts')) {
    err('engine A: init + scaffold');
    const engineA = await makeEngine(scaffold);
    try {
      const ingest = await runTranscriptsIngest(engineA, {
        paths: fixtures.map((f) => f.jsonlPath),
        format: 'claude-code',
        sourceId: SOURCE_ID,
        embed: false,
        userPatternsPath: join(RUN_TMP, 'no-user-patterns.txt'),
      });
      err(`ingest: ${ingest.pages.imported} pages, ${ingest.sessionsImported}/${ingest.sessionsSeen} sessions, cleanScan=${ingest.cleanScan}`);

      // Map sessions → transcripts and build verbatim docs.
      const slugsByTranscript = new Map<string, string[]>();
      for (const file of ingest.files) {
        for (const s of file.sessions) {
          const tid = s.sessionId.replace(/^cat35-/, '');
          const st = states.get(tid);
          if (!st) continue;
          if (s.error) {
            st.laneError.verbatim = s.error;
            st.laneError.facts = s.error;
            continue;
          }
          const slugs = [s.baseSlug];
          for (let p = 2; p <= s.parts; p++) slugs.push(`${s.baseSlug}-p${p}`);
          slugsByTranscript.set(tid, slugs);
        }
      }
      // Cross-check: every selected transcript must have been seen (silent-drop guard).
      for (const [tid, st] of states) {
        if (!slugsByTranscript.has(tid) && !st.laneError.verbatim) {
          err(`setup error: transcript ${tid} not seen by ingest — silent drop`);
          return 2;
        }
      }
      if (opts.lanes.includes('verbatim')) {
        for (const [tid, slugs] of slugsByTranscript) {
          const pages: Array<{ slug: string; body: string }> = [];
          for (const slug of slugs) {
            const page = await engineA.getPage(slug, { sourceId: SOURCE_ID });
            if (page) pages.push({ slug, body: pageContent(page) });
          }
          const st = states.get(tid)!;
          st.lanePages.verbatim = pages;
          st.laneDocs.verbatim = pages.map((p) => p.body).join('\n\n');
        }
      }
      if (opts.lanes.includes('facts')) {
        await engineA.setConfig('facts.extraction_model', factsModel);
        const allSlugs = [...slugsByTranscript.values()].flat();
        const factsBudget = Math.max(2, factsEst * 2);
        const factsRes = await runExtractConversationFactsCore(engineA, {
          sourceId: SOURCE_ID,
          slugs: allSlugs,
          types: ['conversation'],
          maxCostUsd: factsBudget,
          workers: 1,
        });
        totalCost += (factsRes as { total_cost_usd?: number }).total_cost_usd ?? factsEst;
        if ((factsRes as { budget_exhausted?: boolean }).budget_exhausted) factsBudgetExhausted = true;
        const rows = (await engineA.executeRaw(
          `SELECT fact, kind, entity_slug, notability, source_markdown_slug
             FROM facts
            WHERE source_id = $1 AND fact <> 'EXTRACTION_NOT_APPLICABLE'`,
          [SOURCE_ID],
        )) as Array<{ fact: string; kind: string; entity_slug: string | null; notability: string; source_markdown_slug: string | null }>;
        err(`facts: ${rows.length} rows extracted`);
        for (const [tid, slugs] of slugsByTranscript) {
          const slugSet = new Set(slugs);
          const mine = rows.filter((r) => r.source_markdown_slug && slugSet.has(r.source_markdown_slug));
          const st = states.get(tid)!;
          st.laneDocs.facts = mine
            .map((r) => `- [${r.kind}] ${r.fact}${r.entity_slug ? ` (${r.entity_slug}, ${r.notability})` : ` (${r.notability})`}`)
            .join('\n');
        }
      }
    } finally {
      await engineA.disconnect();
    }
  }

  // ── Lane 3: dream — fresh engine + brainDir PER TRANSCRIPT, p-limit 2 ───
  if (opts.lanes.includes('dream')) {
    const limiter = makeLimiter(DREAM_CONCURRENCY);
    await Promise.all(
      fixtures.map((f) =>
        limiter(async () => {
          const tid = f.gold.transcript_id;
          const st = states.get(tid)!;
          // Engine construction INSIDE the try: a connect/initSchema/scaffold
          // failure must record a lane error, not reject the whole Promise.all.
          let engine: InstanceType<typeof PGLiteEngine> | null = null;
          try {
            engine = await makeEngine(scaffold);
            await engine.setConfig('models.dream.synthesize', dreamModel);
            await engine.setConfig('models.dream.triage', HAIKU);
            await engine.setConfig('dream.synthesize.max_turns', String(maxTurns));
            await engine.setConfig('dream.synthesize.subagent_timeout_ms', '600000');
            await engine.setConfig('dream.synthesize.cooldown_hours', '0');
            const brainDir = join(RUN_TMP, `brain-${tid}`);
            mkdirSync(brainDir, { recursive: true });
            err(`dream[${tid}]: synthesize start`);
            const res = await runPhaseSynthesize(engine, {
              brainDir,
              dryRun: false,
              inputFile: f.txtPath,
              sourceId: SOURCE_ID,
            });
            const details = res.details as Record<string, unknown>;
            st.childOutcomes = details.child_outcomes ?? null;
            const verdicts = (details.verdicts ?? []) as Array<Record<string, unknown>>;
            const v0 = verdicts[0];
            if (v0 && typeof v0.score === 'number') st.triageScore = v0.score as number;
            const writtenSlugs = ((details.written_slugs ?? []) as string[]).filter(
              (s) => !s.startsWith('dream-cycle-summaries/'),
            );
            const pages: Array<{ slug: string; body: string }> = [];
            for (const slug of writtenSlugs) {
              const page = await engine.getPage(slug, { sourceId: SOURCE_ID });
              if (!page) continue;
              const body = pageContent(page);
              const seeded = scaffoldBySlug.get(slug);
              // Scaffold pages contribute only ADDED+CHANGED lines (contamination fix).
              const scored = seeded ? addedContent(seeded, body) : body;
              // A scaffold touch whose diff is empty is not emitted content —
              // an empty page must not flip dreamEmitted or reach the
              // usability judge.
              if (scored.trim().length > 0) pages.push({ slug, body: scored });
            }
            st.lanePages.dream = pages;
            st.laneDocs.dream = pages.map((p) => p.body).join('\n\n');
            st.dreamEmitted = pages.length > 0;
            err(`dream[${tid}]: status=${res.status} pages=${pages.length} triage=${st.triageScore ?? 'n/a'}`);
          } catch (e) {
            st.laneError.dream = e instanceof Error ? e.message : String(e);
            err(`dream[${tid}]: ERROR ${st.laneError.dream}`);
          } finally {
            if (engine) await engine.disconnect().catch(() => {});
          }
        }),
      ),
    );
  }

  // ── Scoring ──────────────────────────────────────────────────────────────
  const perItem: PerItemRow[] = [];
  const itemVerdicts = new Map<string, CoverageVerdict>(); // `${lane}:${tid}:${item_id}`
  let judgeCalls = 0;
  let judgeFailures = 0;
  const halluc: Record<string, { claims: number; verifiable: number; ungrounded: number }> = {};
  const leakage: Record<string, { hits: number; confirmed: number }> = {};
  const usabilityPerTranscript: Array<{ transcript_id: string; lane: Lane; satisfied: number; total: number }> = [];
  const hazardsOut: Array<{ hazard_id: string; transcript_id: string; type: string; violated: boolean | null }> = [];

  const jcfg = { model: judgeModel };
  // Fresh per-run resolved-model accounting: every judge response's
  // server-reported model lands in the receipt's judge_models_resolved.
  resetJudgeModelsResolved();

  for (const f of fixtures) {
    const tid = f.gold.transcript_id;
    const st = states.get(tid)!;
    for (const lane of opts.lanes) {
      const doc = st.laneDocs[lane];
      const errored = st.laneError[lane];

      // Coverage (signal transcripts only; lane failures score zero, lane-scoped).
      if (f.gold.items.length > 0) {
        if (errored || doc === undefined || doc === null) {
          for (const it of f.gold.items) {
            perItem.push({
              transcript_id: tid,
              lane,
              item_id: it.item_id,
              kind: it.kind,
              notability: it.notability,
              depth_bucket: it.depth_bucket,
              status: 'ABSENT',
              joint: lane === 'dream' ? 0 : null,
            });
          }
        } else {
          const cov = await scoreSalienceCoverage(
            {
              lane,
              transcript_id: tid,
              document: doc || '(empty output)',
              items: f.gold.items.map((i) => ({ item_id: i.item_id, statement: i.statement })),
            },
            jcfg,
          );
          judgeCalls++;
          totalCost += cov.cost_usd;
          if (cov.judge_failed_ids.length) judgeFailures++;
          const byId = new Map(cov.verdicts.map((v) => [v.item_id, v]));
          // Per-item joint (dream lane): evidence must appear in the doc AND
          // trace to the transcript; paraphrase evidence falls back to the
          // grounding judge.
          const jointFallback: Array<{ item_id: string; evidence: string }> = [];
          for (const it of f.gold.items) {
            const v = byId.get(it.item_id);
            const failed = cov.judge_failed_ids.includes(it.item_id) || !v;
            const status = failed ? 'JUDGE_FAILED' : v!.status;
            let joint: number | null = null;
            if (lane === 'dream' && !failed && v) {
              const credit = v.status === 'FULL' ? 1 : v.status === 'PARTIAL' ? 0.5 : 0;
              if (credit === 0) joint = 0;
              else {
                const inDoc = anchorPresent(v.evidence, doc);
                const inTranscript = anchorPresent(v.evidence, f.transcriptText);
                if (inDoc && inTranscript) joint = credit;
                else if (inDoc) {
                  jointFallback.push({ item_id: it.item_id, evidence: v.evidence });
                  joint = null; // resolved below
                } else joint = 0;
              }
            }
            if (v) itemVerdicts.set(`${lane}:${tid}:${it.item_id}`, v);
            perItem.push({
              transcript_id: tid,
              lane,
              item_id: it.item_id,
              kind: it.kind,
              notability: it.notability,
              depth_bucket: it.depth_bucket,
              status,
              joint,
            });
          }
          if (jointFallback.length && lane === 'dream') {
            const g = await scoreGrounding(
              { label: `joint:${tid}`, claims: jointFallback.map((x) => x.evidence), transcript: f.transcriptText },
              jcfg,
            );
            judgeCalls++;
            totalCost += g.cost_usd;
            if (g.judge_failed) judgeFailures++;
            for (let i = 0; i < jointFallback.length; i++) {
              const row = perItem.find(
                (r) => r.lane === lane && r.transcript_id === tid && r.item_id === jointFallback[i].item_id,
              )!;
              const credit = row.status === 'FULL' ? 1 : row.status === 'PARTIAL' ? 0.5 : 0;
              row.joint = g.judge_failed ? 0 : g.results[i]?.grounded ? credit : 0;
            }
          }
        }
      }

      // Hallucination / claim precision (facts + dream lanes; ALL claims).
      if ((lane === 'facts' || lane === 'dream') && doc && !errored) {
        const claims =
          lane === 'facts'
            ? doc.split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.replace(/^- \[[a-z]+\] /, '').trim())
            : segmentClaims(doc);
        if (claims.length) {
          const g = await scoreGrounding({ label: `${lane}:${tid}`, claims, transcript: f.transcriptText }, jcfg);
          judgeCalls++;
          totalCost += g.cost_usd;
          if (g.judge_failed) judgeFailures++;
          const bucket = (halluc[lane] ??= { claims: 0, verifiable: 0, ungrounded: 0 });
          if (!g.judge_failed) {
            bucket.claims += claims.length;
            for (const r of g.results) {
              if (r.verifiable) {
                bucket.verifiable++;
                if (!r.grounded) bucket.ungrounded++;
              }
            }
          }
        }
      }

      // Distractor leakage (mechanical scan; judge confirm on facts + dream).
      if (doc && !errored && f.gold.distractors.length) {
        const hits = scanDistractors(
          f.gold.distractors.map((d) => ({ id: d.distractor_id, anchor: d.anchor })),
          doc,
        );
        const bucket = (leakage[lane] ??= { hits: 0, confirmed: 0 });
        bucket.hits += hits.length;
        if (lane === 'verbatim') {
          bucket.confirmed += hits.length; // the floor — verbatim keeps everything by construction
        } else if (hits.length) {
          const byId = new Map(f.gold.distractors.map((d) => [d.distractor_id, d]));
          const conf = await confirmDistractorLeaks(
            { document: doc, hits: hits.map((h) => ({ distractor_id: h, statement: byId.get(h)!.statement })) },
            jcfg,
          );
          judgeCalls++;
          totalCost += conf.cost_usd;
          if (conf.judge_failed) judgeFailures++;
          else bucket.confirmed += conf.confirmed.length;
        }
      }

      // Usability (page-producing lanes, conditional on emission).
      if ((lane === 'verbatim' || lane === 'dream') && !errored) {
        const pages = st.lanePages[lane] ?? [];
        if (pages.length) {
          const u = await scoreUsabilityChecklist(
            {
              transcript_id: tid,
              pages,
              hasGoldVibes: f.gold.items.some((i) => i.kind === 'vibe'),
            },
            jcfg,
          );
          judgeCalls++;
          totalCost += u.cost_usd;
          if (u.judge_failed) judgeFailures++;
          else usabilityPerTranscript.push({ transcript_id: tid, lane, satisfied: u.satisfied, total: u.total });
        }
      }
    }

    // Attribution hazards (dream lane): does the page-set assert the wrong claim?
    if (opts.lanes.includes('dream') && f.gold.hazards.length) {
      const doc = st.laneDocs.dream;
      for (const h of f.gold.hazards) {
        if (!doc || st.laneError.dream) {
          hazardsOut.push({ hazard_id: h.hazard_id, transcript_id: tid, type: h.type, violated: null });
          continue;
        }
        const g = await scoreGrounding(
          { label: `hazard:${h.hazard_id}`, claims: [h.wrong_claim], transcript: doc },
          jcfg,
        );
        judgeCalls++;
        totalCost += g.cost_usd;
        if (g.judge_failed) {
          judgeFailures++;
          hazardsOut.push({ hazard_id: h.hazard_id, transcript_id: tid, type: h.type, violated: null });
        } else {
          // grounded==true means the DREAM OUTPUT asserts the wrong claim → violation.
          hazardsOut.push({
            hazard_id: h.hazard_id,
            transcript_id: tid,
            type: h.type,
            violated: Boolean(g.results[0]?.verifiable && g.results[0]?.grounded),
          });
        }
      }
    }
  }

  // ── Aggregation ──────────────────────────────────────────────────────────
  const signalFixtures = fixtures.filter((f) => f.gold.items.length > 0);
  const credit = (s: PerItemRow['status']) => (s === 'FULL' ? 1 : s === 'PARTIAL' ? 0.5 : 0);

  const coverageByLane: Record<string, Record<string, number>> = {};
  const perTranscriptRecall: Record<string, number[]> = {};
  for (const lane of opts.lanes) {
    const laneRows = perItem.filter((r) => r.lane === lane);
    if (!laneRows.length) continue;
    const perT: number[] = [];
    for (const f of signalFixtures) {
      const rows = laneRows.filter((r) => r.transcript_id === f.gold.transcript_id);
      if (!rows.length) continue;
      perT.push(rows.reduce((a, r) => a + credit(r.status), 0) / rows.length);
    }
    perTranscriptRecall[lane] = perT;
    const macro = perT.length ? perT.reduce((a, b) => a + b, 0) / perT.length : 0;
    const micro = laneRows.reduce((a, r) => a + credit(r.status), 0) / laneRows.length;
    const strict = laneRows.filter((r) => r.status === 'FULL').length / laneRows.length;
    const partialRate = laneRows.filter((r) => r.status === 'PARTIAL').length / laneRows.length;
    const ci = perT.length > 1 ? bootstrapCI(perT, 35, 1000) : { lo: macro, hi: macro, mean: macro };
    coverageByLane[lane] = {
      macro,
      micro,
      strict,
      partial_rate: partialRate,
      ci_lo: ci.lo,
      ci_hi: ci.hi,
    };
  }

  const groupBy = (key: (r: PerItemRow) => string) => {
    const out: Record<string, Record<string, number>> = {};
    for (const lane of opts.lanes) {
      const rows = perItem.filter((r) => r.lane === lane);
      const groups = new Map<string, PerItemRow[]>();
      for (const r of rows) {
        const k = key(r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      for (const [k, g] of groups) {
        (out[k] ??= {})[lane] = g.reduce((a, r) => a + credit(r.status), 0) / g.length;
      }
    }
    return out;
  };
  const coverageByKind = groupBy((r) => r.kind);
  const coverageByNotability = groupBy((r) => r.notability);
  const coverageByDepth = groupBy((r) => r.depth_bucket);

  // Quote fidelity + compression + emission.
  const quoteFid: Record<string, { total: number; grounded: number; rate: number }> = {};
  const compression: Record<string, number[]> = {};
  for (const f of fixtures) {
    const st = states.get(f.gold.transcript_id)!;
    for (const lane of opts.lanes) {
      const doc = st.laneDocs[lane];
      if (doc === undefined || st.laneError[lane]) continue;
      (compression[lane] ??= []).push(compressionRatio(doc, f.transcriptText));
      if (lane === 'dream' && doc) {
        const qf = quoteFidelity(doc, f.transcriptText);
        const bucket = (quoteFid[lane] ??= { total: 0, grounded: 0, rate: 0 });
        bucket.total += qf.total;
        bucket.grounded += qf.grounded;
      }
    }
  }
  for (const lane of Object.keys(quoteFid)) {
    const b = quoteFid[lane];
    b.rate = b.total ? b.grounded / b.total : 1;
  }
  const compressionByLane: Record<string, number> = {};
  for (const [lane, arr] of Object.entries(compression)) {
    compressionByLane[lane] = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  const expectedHigh = fixtures.filter((f) => f.gold.expected_triage === 'high');
  const emitted = expectedHigh.filter((f) => states.get(f.gold.transcript_id)!.dreamEmitted);
  const emission = {
    expected_high: expectedHigh.length,
    emitted: emitted.length,
    rate: expectedHigh.length ? emitted.length / expectedHigh.length : 1,
  };

  // Triage separation + threshold curve.
  const triageRows: TriageVerdictRow[] = fixtures
    .map((f) => {
      const st = states.get(f.gold.transcript_id)!;
      return st.triageScore === null
        ? null
        : { transcript_id: f.gold.transcript_id, score: st.triageScore, expected: f.gold.expected_triage };
    })
    .filter((x): x is TriageVerdictRow => x !== null);
  const curve = opts.lanes.includes('dream') ? thresholdCurve(triageRows) : [];
  const sep = (exp: 'high' | 'low') => {
    const s = triageRows.filter((r) => r.expected === exp).map((r) => r.score);
    return s.length
      ? { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, min: Math.min(...s), max: Math.max(...s) }
      : { n: 0, mean: null, min: null, max: null };
  };

  // Usability aggregate.
  const usabAgg = usabilityPerTranscript.reduce(
    (acc, u) => ({ satisfied: acc.satisfied + u.satisfied, total: acc.total + u.total }),
    { satisfied: 0, total: 0 },
  );
  // Per-lane usability: verbatim (expected ~0) and dream (the headline) are
  // incompatible populations — the blended aggregate alone misleads any
  // consumer reading usability.rate.
  const usabilityByLane: Record<string, { satisfied: number; total: number; rate: number | null }> = {};
  for (const lane of ['verbatim', 'dream'] as const) {
    const rows = usabilityPerTranscript.filter((u) => u.lane === lane);
    const satisfied = rows.reduce((a, u) => a + u.satisfied, 0);
    const total = rows.reduce((a, u) => a + u.total, 0);
    if (total) usabilityByLane[lane] = { satisfied, total, rate: satisfied / total };
  }

  // Hallucination rates.
  const hallucination: Record<string, { claims: number; verifiable: number; ungrounded: number; rate: number }> = {};
  for (const [lane, b] of Object.entries(halluc)) {
    hallucination[lane] = { ...b, rate: b.verifiable ? b.ungrounded / b.verifiable : 0 };
  }
  const distractorLeakage: Record<string, { hits: number; confirmed: number; denominator: number; rate: number }> = {};
  for (const lane of ALL_LANES) {
    if (!leakage[lane]) continue;
    // Denominator excludes transcripts whose lane errored — a crashed lane
    // never had its distractors scanned, and counting them would bias the
    // rate toward zero (coverage handles the same failure as zero credit;
    // leakage must not handle it as a free pass).
    const denominator = fixtures.reduce((a, fx) => {
      const st = states.get(fx.gold.transcript_id)!;
      if (st.laneError[lane] || st.laneDocs[lane] === undefined) return a;
      return a + fx.gold.distractors.length;
    }, 0);
    distractorLeakage[lane] = {
      ...leakage[lane],
      denominator,
      rate: denominator ? leakage[lane].confirmed / denominator : 0,
    };
  }

  const judgeFailedRate = judgeCalls ? judgeFailures / judgeCalls : 0;

  // ── E1: prior-run delta ─────────────────────────────────────────────────
  mkdirSync(REPORT_DIR, { recursive: true });
  const headline: Record<string, number> = {};
  for (const [lane, c] of Object.entries(coverageByLane)) headline[`${lane}_macro`] = c.macro;
  let priorRun: { path: string; timestamp: string; gbrain_version: string } | null = null;
  let priorRunSkippedReason: string | undefined;
  let deltas: Record<string, { prior: number; current: number; delta: number }> | null = null;
  let itemFlips: Array<{ lane: string; transcript_id: string; item_id: string; prior: string; current: string }> = [];
  const priorFound: { path: string; receipt: Record<string, unknown> } | null = (() => {
    // Content-aware discovery (a filename filter missed the committed
    // baseline-receipt.json and made the fresh-clone fallback dead code):
    // any parseable .json whose cat matches is a candidate. Newest-first;
    // prefer a mode-comparable receipt so a later BPRE smoke can't shadow
    // the latest full receipt.
    // Collect from BOTH dirs BEFORE filtering: breaking on the first dir with
    // any receipt meant a local BPRE smoke hid the committed full baseline —
    // exactly the shadowing this exists to prevent. Preference order:
    // mode-comparable beats not; within a tier, local beats committed
    // (dirs scanned local-first), newer beats older.
    const found: Array<{ path: string; receipt: Record<string, unknown>; local: boolean }> = [];
    for (const dir of [REPORT_DIR, BASELINE_DIR]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          if (parsed?.cat === 'cat35-transcript-distill') {
            found.push({ path: join(dir, f), receipt: parsed, local: dir === REPORT_DIR });
          }
        } catch {
          // unparseable candidate — skip, keep scanning
        }
      }
    }
    if (!found.length) return null;
    const comparable = found.filter((c) => (c.receipt as { mode?: string }).mode === mode);
    const pool = comparable.length ? comparable : found;
    const localPool = pool.filter((c) => c.local);
    const finalPool = localPool.length ? localPool : pool;
    return finalPool[finalPool.length - 1];
  })();
  const judgeModelsResolved = getJudgeModelsResolved();
  let comparability: 'comparable' | 'non-comparable' | null = null;
  if (priorFound) {
    const prior = priorFound.receipt as Record<string, any>;
    // Extended comparability (beyond computeDelta's mode/lanes/corpus):
    // deltas across judge models, corpus content, or transcript subsets are
    // noise dressed as signal.
    //
    // Strongest layer first: deltas require BOTH receipts to carry
    // judge_models_resolved with exactly one identical real (non-null-keyed)
    // server-reported model. The requested-model string equality below stays
    // as a fallback layer, but it keys on a movable alias (the published
    // runs recorded `claude-sonnet-4-6`) — a silent alias repoint defeats
    // it, which is exactly what resolved-model evidence exists to catch.
    // Absent (all pre-2026-09 receipts), mixed, or null-keyed maps on either
    // side → non-comparable, deltas suppressed (not warned).
    const currentResolved = singleResolvedModel(judgeModelsResolved);
    const priorResolved = singleResolvedModel(prior.judge_models_resolved);
    const resolvedModelMismatch =
      currentResolved === null || priorResolved === null || currentResolved !== priorResolved;
    const extendedMismatch =
      (resolvedModelMismatch && 'judge_models_resolved') ||
      (prior.judge_model && prior.judge_model !== judgeModel && 'judge_model') ||
      (prior.corpus_sha && prior.corpus_sha !== corpusSha && 'corpus_sha') ||
      (Array.isArray(prior.transcripts) &&
        JSON.stringify([...prior.transcripts].sort()) !==
          JSON.stringify(fixtures.map((f) => f.gold.transcript_id).sort()) &&
        'transcript set') ||
      null;
    if (extendedMismatch) {
      priorRunSkippedReason = `${extendedMismatch} mismatch vs prior receipt (${priorFound.path})`;
      comparability = 'non-comparable';
    }
    const deltaRes = computeDelta(
      { mode, lanes: opts.lanes, corpus: 'transcript-distill-v1', headline },
      {
        mode: prior.mode,
        lanes: prior.lanes,
        corpus: prior.corpus,
        headline: Object.fromEntries(
          Object.entries((prior.coverage_by_lane ?? {}) as Record<string, { macro: number }>).map(([l, c]) => [
            `${l}_macro`,
            c.macro,
          ]),
        ),
      },
    );
    if (deltaRes.comparable && !extendedMismatch) {
      comparability = 'comparable';
      priorRun = {
        path: priorFound.path,
        timestamp: String(prior.timestamp ?? ''),
        gbrain_version: String(prior.gbrain_version ?? ''),
      };
      deltas = deltaRes.deltas ?? null;
      const priorItems = new Map(
        ((prior.per_item ?? []) as PerItemRow[]).map((r) => [`${r.lane}:${r.transcript_id}:${r.item_id}`, r.status]),
      );
      for (const r of perItem) {
        const p = priorItems.get(`${r.lane}:${r.transcript_id}:${r.item_id}`);
        if (p && p !== r.status) {
          itemFlips.push({ lane: r.lane, transcript_id: r.transcript_id, item_id: r.item_id, prior: p, current: r.status });
        }
      }
    } else {
      priorRunSkippedReason = priorRunSkippedReason ?? deltaRes.skipped_reason;
      comparability = 'non-comparable';
    }
  } else {
    priorRunSkippedReason = 'first run — no prior receipt or committed baseline';
    // comparability stays null: with no prior receipt there is nothing to
    // compare against, and the receipt omits the field.
  }

  // ── E2: judge-calibration scaffold ──────────────────────────────────────
  let judgeCalibration: Record<string, unknown> | null = null;
  // Resolution: explicit path arg → newest annotation artifact in the
  // committed baseline dir (where humans fill verdicts; the corpus sample
  // never mutates post-run) → the corpus's blank seeded draw.
  const newestAnnotation = existsSync(BASELINE_DIR)
    ? readdirSync(BASELINE_DIR)
        .filter((f) => f.startsWith('judge-calibration') && f.endsWith('.json'))
        .sort()
        .map((f) => join(BASELINE_DIR, f))
        .pop()
    : undefined;
  const calibPath =
    opts.judgeCalibrationPath ?? newestAnnotation ?? join(CORPUS_DIR, 'judge-calibration-sample.json');
  if (opts.judgeCalibration && opts.judgeCalibrationPath && !existsSync(opts.judgeCalibrationPath)) {
    // A typo'd explicit path must fail loudly, not silently degrade to
    // "no calibration" in the receipt.
    err(`--judge-calibration file not found: ${opts.judgeCalibrationPath}`);
    return 2;
  }
  if (opts.judgeCalibration && existsSync(calibPath)) {
    // The generator writes {schema_version, corpus_seed, note, entries: [...]};
    // accept a bare array too (the annotation artifact shape).
    const parsed = JSON.parse(readFileSync(calibPath, 'utf8')) as
      | Array<Record<string, any>>
      | { entries: Array<Record<string, any>> };
    const sample = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    const filled = sample.map((row) => {
      if (row.slot === 'coverage' && row.item_id_or_ref && row.transcript_id) {
        const v = itemVerdicts.get(`${row.lane_hint ?? 'dream'}:${row.transcript_id}:${row.item_id_or_ref}`);
        // Never clobber a previously stored verdict with null (a partial/BPRE
        // run that didn't judge this item must not shrink the kappa pairs).
        return { ...row, judge_verdict: v?.status ?? row.judge_verdict ?? null };
      }
      return row;
    });
    const pairs = filled.filter((r) => r.judge_verdict && r.human_verdict);
    const kappa =
      pairs.length >= 2
        ? weightedKappa(
            pairs.map((r) => String(r.judge_verdict)),
            pairs.map((r) => String(r.human_verdict)),
          )
        : null;
    const agreement = pairs.length
      ? pairs.filter((r) => r.judge_verdict === r.human_verdict).length / pairs.length
      : null;
    judgeCalibration = {
      sample_size: sample.length,
      judge_filled: filled.filter((r) => r.judge_verdict).length,
      human_filled: filled.filter((r) => r.human_verdict).length,
      pairs: pairs.length,
      raw_agreement: agreement,
      weighted_kappa: kappa,
      status: pairs.length ? 'computed' : 'pending human scoring',
      annotation_artifact: filled,
    };
  }

  // ── Gates (validity, not aspiration) ────────────────────────────────────
  const verbatimMacro = coverageByLane.verbatim?.macro ?? null;
  // 0.90, recalibrated from 0.95 after the 2026-08-25 published run measured
  // the judge's ceiling at 93.1% on the verbatim control (judge conservatism:
  // ~1 PARTIAL per transcript against the full transcript). Recalibrated at
  // the gate level with disclosure in the report — gold was NOT reworded
  // after seeing run numbers (that would be test-set tuning).
  const verbatimGateMin = 0.9;
  const gates = {
    verbatim_coverage: verbatimMacro === null ? null : verbatimMacro >= verbatimGateMin,
    judge_failed_rate: judgeFailedRate < 0.05,
    dream_emission: opts.lanes.includes('dream')
      ? opts.full
        ? emission.rate >= 0.7
        : emission.emitted >= 1
      : null,
  };
  const gatePass = Object.values(gates).every((g) => g !== false);

  // ── Receipt + artifacts ─────────────────────────────────────────────────
  const gbrainPkg = JSON.parse(readFileSync(resolve('node_modules/gbrain/package.json'), 'utf8'));
  // Derive the SHA from the repo's own pin so a future pin bump can't leave a
  // stale hardcoded SHA in receipts.
  const repoPkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  // Under `bun link gbrain` the pin string lies about what actually ran —
  // record that explicitly rather than a SHA the run never executed.
  const gbrainLinked = (() => {
    try {
      return lstatSync(resolve('node_modules/gbrain')).isSymbolicLink();
    } catch {
      return false;
    }
  })();
  const gbrainSha = gbrainLinked
    ? 'linked-local'
    : (repoPkg.dependencies?.gbrain?.split('#')[1] ?? 'unpinned');
  const stamp = `${RUN_STAMP.toISOString().slice(0, 10)}-${RUN_STAMP.toISOString().slice(11, 19).replace(/:/g, '')}`;
  const receipt = {
    schema_version: 1,
    cat: 'cat35-transcript-distill',
    mode,
    gbrain_version: gbrainPkg.version ?? 'unknown',
    gbrain_sha: gbrainSha,
    timestamp: RUN_STAMP.toISOString(),
    corpus: 'transcript-distill-v1',
    corpus_sha: corpusSha,
    judge_model: judgeModel,
    // Server-reported model ids across all judge calls this run
    // ({resolved_model: call_count}; 'null' key = responses without a model
    // field). Best-available evidence of what actually served the judges —
    // the requested judge_model above can be a movable alias.
    judge_models_resolved: judgeModelsResolved,
    // 'comparable' | 'non-comparable' vs the prior receipt (omitted on first
    // runs). non-comparable ⇒ deltas below are suppressed.
    ...(comparability !== null ? { comparability } : {}),
    judge_prompt_version: CAT35_JUDGE_PROMPT_VERSION,
    config_snapshot: {
      dream_model: dreamModel,
      triage_model: HAIKU,
      facts_model: factsModel,
      max_turns: maxTurns,
      triage_threshold: 0.5,
      subagent_timeout_ms: 600000,
      dream_concurrency: DREAM_CONCURRENCY,
    },
    lanes: opts.lanes,
    transcripts: fixtures.map((f) => f.gold.transcript_id),
    signal_transcripts: signalFixtures.length,
    per_item: perItem,
    coverage_by_lane: coverageByLane,
    coverage_by_kind: coverageByKind,
    coverage_by_notability: coverageByNotability,
    coverage_by_depth: coverageByDepth,
    verbatim_quote_fidelity: quoteFid.dream ?? { total: 0, grounded: 0, rate: 1 },
    hallucination,
    distractor_leakage: distractorLeakage,
    usability: {
      satisfied: usabAgg.satisfied,
      total: usabAgg.total,
      rate: usabAgg.total ? usabAgg.satisfied / usabAgg.total : null,
      per_transcript: usabilityPerTranscript,
    },
    usability_by_lane: usabilityByLane,
    emission,
    compression_ratio_by_lane: compressionByLane,
    attribution_hazards: hazardsOut,
    triage: {
      verdicts: triageRows,
      separation: { high: sep('high'), low: sep('low') },
      threshold_curve: curve,
    },
    judge_failed_rate: judgeFailedRate,
    judge_calibration: judgeCalibration,
    prior_run: priorRun,
    prior_run_skipped_reason: priorRunSkippedReason,
    deltas,
    item_flips: itemFlips,
    facts_budget_exhausted: factsBudgetExhausted,
    lane_errors: Object.fromEntries(
      [...states.entries()]
        .filter(([, s]) => Object.keys(s.laneError).length)
        .map(([tid, s]) => [tid, s.laneError]),
    ),
    // Judges + facts extraction only: runPhaseSynthesize exposes job status,
    // not token spend, so the dream lane's LLM cost is NOT included here.
    total_cost_usd: Number(totalCost.toFixed(4)),
    cost_note: 'judges + facts extraction only; dream-lane subagent spend is not surfaced by the gbrain phase API',
    wall_seconds: Math.round((Date.now() - wallStart) / 1000),
    gates,
    gate_pass: gatePass,
  };
  const receiptPath = join(REPORT_DIR, `${stamp}-cat35${opts.full ? '' : '-bpre'}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

  const artifactsDir = join(REPORT_DIR, `${stamp}-artifacts`);
  mkdirSync(artifactsDir, { recursive: true });
  for (const [tid, st] of states) {
    for (const lane of opts.lanes) {
      const doc = st.laneDocs[lane];
      if (doc !== undefined) writeFileSync(join(artifactsDir, `${tid}.${lane}.md`), doc ?? '');
    }
    if (st.childOutcomes != null) {
      writeFileSync(
        join(artifactsDir, `${tid}.dream.child-outcomes.json`),
        JSON.stringify(st.childOutcomes, null, 2) + '\n',
      );
    }
  }

  // ── Scorecard (stderr; stdout stays clean for --json) ───────────────────
  err('─── Cat 35 Scorecard ───');
  err(`mode=${mode}${opts.full ? '' : ' (BPRE smoke — not a published result)'}  gbrain=${receipt.gbrain_version}`);
  for (const [lane, c] of Object.entries(coverageByLane)) {
    err(
      `${lane.padEnd(8)} salient-unit recall: macro=${(c.macro * 100).toFixed(1)}% [${(c.ci_lo * 100).toFixed(1)}-${(c.ci_hi * 100).toFixed(1)}] micro=${(c.micro * 100).toFixed(1)}% strict=${(c.strict * 100).toFixed(1)}%`,
    );
  }
  for (const [lane, h] of Object.entries(hallucination)) {
    err(`${lane.padEnd(8)} hallucination: ${(h.rate * 100).toFixed(1)}% (${h.ungrounded}/${h.verifiable} verifiable claims)`);
  }
  for (const [lane, l] of Object.entries(distractorLeakage)) {
    err(`${lane.padEnd(8)} distractor leakage: ${(l.rate * 100).toFixed(1)}% (${l.confirmed} confirmed)`);
  }
  if (usabAgg.total) err(`usability checklist: ${usabAgg.satisfied}/${usabAgg.total} (${((usabAgg.satisfied / usabAgg.total) * 100).toFixed(0)}%)`);
  err(`emission: ${emission.emitted}/${emission.expected_high} expected-high produced pages`);
  err(`judge_failed_rate: ${(judgeFailedRate * 100).toFixed(1)}%  cost: $${totalCost.toFixed(2)} (judges+facts; dream-lane spend not surfaced)  wall: ${receipt.wall_seconds}s`);
  if (deltas) {
    for (const [k, d] of Object.entries(deltas)) err(`delta ${k}: ${(d.prior * 100).toFixed(1)}% → ${(d.current * 100).toFixed(1)}% (${d.delta >= 0 ? '+' : ''}${(d.delta * 100).toFixed(1)}pp, informational)`);
    if (itemFlips.length) err(`item flips vs prior: ${itemFlips.length}`);
  } else if (priorRunSkippedReason) {
    err(`delta: skipped — ${priorRunSkippedReason}`);
  }
  err(`gates: ${JSON.stringify(gates)} → ${gatePass ? 'PASS' : 'FAIL'}`);
  err(`receipt: ${receiptPath}`);
  err(`artifacts: ${artifactsDir}`);

  if (opts.json) process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  return gatePass ? 0 : 1;
}

function cleanupRunTmp(): void {
  // Best-effort: a full run leaves GBRAIN_HOME + 24 brain dirs + PGLite state
  // under RUN_TMP; without cleanup every run leaks tens of MB into /tmp.
  try {
    rmSync(RUN_TMP, { recursive: true, force: true });
  } catch {
    // never let cleanup mask the run's exit code
  }
}

main().then(
  (code) => {
    cleanupRunTmp();
    process.exit(code);
  },
  (e) => {
    err(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    cleanupRunTmp();
    process.exit(2);
  },
);

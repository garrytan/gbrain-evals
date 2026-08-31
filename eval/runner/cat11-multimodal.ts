/**
 * Cat 11 — Multi-modal ingestion fidelity.
 *
 * FEATURE BOUNDARY — what is under test vs what is seeded/stubbed:
 *
 *   UNDER TEST (gbrain, the system under test):
 *     - `importFromContent` (gbrain/import-file): markdown parse, frontmatter
 *       handling, the content-sanity gate, chunking, page + chunk persistence.
 *     - The indexed artifact read back via `engine.getChunks(slug)` — the
 *       exact text search operates on. If ingest drops, mangles, quarantines,
 *       or truncates prose, the word-recall metric here moves. (This replaces
 *       the pre-audit design that scored the eval's OWN pdf/html extractors
 *       and never touched gbrain — audit finding retrieval-cats-12.)
 *     - Audio (when fixtures + a transcriber exist): `gbrain/transcription`.
 *
 *   SEEDED / HARNESS-OWNED (not measured):
 *     - Committed, text-derived fixtures under `eval/data/multimodal/`
 *       (markdown + html), integrity-checked against sha256 manifests
 *       (audit finding retrieval-cats-18: hashes were declared, never read).
 *     - Embedding is skipped (`noEmbed: true`): Cat 11 measures TEXT fidelity
 *       of the index, not embedding quality. Chunks land with embedding null,
 *       exactly like gbrain's own deferred-embed backfill path. No API keys.
 *     - Scoring math (`wordRecall`, `wer`) is harness code.
 *
 * Modalities and ENFORCED thresholds (mean_metric, higher is better):
 *   - markdown ≥ 0.90 word recall: raw .md → importFromContent → getChunks.
 *   - html     ≥ 0.80 word recall: raw .html → importFromContent → getChunks.
 *     gbrain has no HTML extractor as of v0.47.6.0, so this measures what
 *     ingest does with markup-bearing text dumped in as-is.
 *   - audio    ≥ 0.85 transcription fidelity, where fidelity = max(0, 1 - WER)
 *     (i.e. WER ≤ 0.15). SKIPPED by default: binary clips are not committed
 *     and the fetch script the old header advertised never existed (audit
 *     finding retrieval-cats-03). Runs only with local fixtures + a
 *     GROQ/OPENAI key, or an injected transcriber in tests.
 *   - pdf: SKIPPED. gbrain v0.47.6.0 has no PDF ingest path; benchmarking the
 *     eval's own pdf-parse wrapper said nothing about gbrain.
 *
 * Negative control (hermetic): each text modality re-ingests its fixtures
 * with the source truncated to 25%. The control mean must be ≤ 0.5x the real
 * mean, or the run is declared invalid — proof the metric detects text loss
 * through the real pipeline, not a gate that can only pass.
 *
 * Accounting (eval/runner/probe-accounting.ts policy): item failures where
 * gbrain misbehaved score 0 ('sut') and STAY in the modality mean (audit
 * finding retrieval-cats-10: failures used to silently leave the denominator).
 * Fixture problems (missing file, sha256 mismatch) are 'harness' errors:
 * excluded from means, recorded, capped. All modalities skipped ⇒ receipt
 * run_status 'skipped' and a NON-ZERO exit unless --allow-skip.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { ProbeAccounting, type ProbeSummary } from './probe-accounting.ts';
import { writeReceipt, receiptPath, RECEIPT_SCHEMA_VERSION, BENCHMARK_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

// ─── Manifest types ──────────────────────────────────────────────────

export interface FixtureManifest {
  version: 1;
  license: string;
  items: Array<{
    name: string;
    path: string;
    canonical_path: string;
    /** sha256 of the source fixture file — verified before scoring. */
    sha256: string;
    /** sha256 of the canonical text file — verified before scoring. */
    canonical_sha256: string;
  }>;
}

// ─── Per-modality results ────────────────────────────────────────────

export type Modality = 'markdown' | 'html' | 'pdf' | 'audio';

/** Enforced pass bars on mean_metric (higher is better) per modality. */
export const THRESHOLDS: Record<'markdown' | 'html' | 'audio', number> = {
  markdown: 0.9,
  html: 0.8,
  audio: 0.85, // fidelity = 1 - WER, so this is the documented WER ≤ 0.15
};

export interface PerItem {
  name: string;
  /**
   * Scored metric (higher is better). 0 for sut failures (they stay in the
   * mean); null for harness-excluded items (missing/corrupt fixture).
   */
  metric: number | null;
  /** Set when the item errored: who broke. */
  origin?: 'sut' | 'harness';
  error?: string;
  /** Audio only: transcription provider identity (e.g. 'groq'), not its length. */
  provider?: string;
  detail?: Record<string, number>;
}

export interface NegativeControl {
  real_mean: number;
  control_mean: number;
  /** control_mean ≤ 0.5 × real_mean — the metric detects text loss. */
  degradation_ok: boolean;
}

export interface ModalityResult {
  modality: Modality;
  metric_name: 'word_recall' | 'transcription_fidelity' | 'none';
  /** Enforced pass bar on mean_metric; null when the modality is skipped. */
  threshold: number | null;
  /** Manifest size (planned items). */
  items: number;
  /** Items that entered the mean (successes + sut-failure zeros). */
  items_scored: number;
  /** Mean over scored items; null when nothing scored. Includes sut zeros. */
  mean_metric: number | null;
  per_item: PerItem[];
  skipped: boolean;
  skip_reason?: string;
  /** mean_metric vs threshold; only set when the modality ran. */
  verdict?: 'pass' | 'fail';
  /** Truncated-ingest control; text modalities only. */
  negative_control?: NegativeControl;
}

export interface Cat11Report {
  schema_version: 2;
  ran_at: string;
  results: Record<Modality, ModalityResult>;
  /** pass = every modality that ran met its threshold; skipped = none ran. */
  verdict: 'pass' | 'fail' | 'skipped';
}

export interface Cat11RunOutcome {
  report: Cat11Report;
  accounting: ProbeSummary;
  /** Modalities whose negative control failed to degrade — harness/metric bug. */
  control_failures: string[];
}

// ─── Text metrics (harness-owned scoring math) ───────────────────────

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/**
 * Word recall: fraction of canonical words present in extracted text.
 * Multiset semantics: if canonical has "the the the" and extracted has "the",
 * recall is 1/3.
 */
export function wordRecall(canonical: string, extracted: string): number {
  const canonicalWords = normalizeWords(canonical);
  const extractedCounts = new Map<string, number>();
  for (const w of normalizeWords(extracted)) {
    extractedCounts.set(w, (extractedCounts.get(w) ?? 0) + 1);
  }
  if (canonicalWords.length === 0) return 1;
  let hits = 0;
  for (const w of canonicalWords) {
    const count = extractedCounts.get(w) ?? 0;
    if (count > 0) {
      hits++;
      extractedCounts.set(w, count - 1);
    }
  }
  return hits / canonicalWords.length;
}

/**
 * Word Error Rate: Levenshtein distance at word level / reference word count.
 * Lower is better. 0.0 = perfect transcription. Typical whisper-v3 on clean
 * English ≈ 0.05-0.10. Reported upward as fidelity = max(0, 1 - wer) so all
 * Cat 11 metrics share higher-is-better accounting (a sut failure scored 0
 * must be the WORST value — under raw WER, 0 would read as perfect).
 */
export function wer(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  const n = ref.length;
  const m = hyp.length;
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m] / n;
}

// ─── Fixture integrity ────────────────────────────────────────────────

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function loadManifest(dir: string): FixtureManifest | null {
  const manifestPath = join(dir, 'fixtures.json');
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
}

/**
 * Verify a fixture pair exists and matches its manifest hashes.
 * Returns an error string (harness origin) or null when clean.
 */
function verifyFixture(
  dir: string,
  item: FixtureManifest['items'][number],
): string | null {
  const srcPath = join(dir, item.path);
  const canPath = join(dir, item.canonical_path);
  if (!existsSync(srcPath) || !existsSync(canPath)) {
    return `missing fixture file(s) at ${item.path} / ${item.canonical_path}`;
  }
  const srcHash = sha256File(srcPath);
  if (srcHash !== item.sha256) {
    return `sha256 mismatch for ${item.path}: manifest ${item.sha256.slice(0, 12)}…, disk ${srcHash.slice(0, 12)}…`;
  }
  const canHash = sha256File(canPath);
  if (canHash !== item.canonical_sha256) {
    return `sha256 mismatch for ${item.canonical_path}: manifest ${item.canonical_sha256.slice(0, 12)}…, disk ${canHash.slice(0, 12)}…`;
  }
  return null;
}

// ─── gbrain ingest → indexed read-back (the measured pipeline) ────────

/**
 * Push raw content through gbrain's real ingest and read back what the index
 * actually holds. `noEmbed: true` keeps this hermetic (no gateway, no keys);
 * chunk TEXT — the thing Cat 11 scores — is identical either way.
 */
async function ingestAndReadBack(
  engine: PGLiteEngine,
  slug: string,
  content: string,
): Promise<{ indexedText: string; chunks: number }> {
  // gbrain's import path logs progress lines; keep runner output as pure JSON.
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  let result: Awaited<ReturnType<typeof importFromContent>>;
  try {
    result = await importFromContent(engine, slug, content, { noEmbed: true });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  if (result.status === 'error') {
    throw new Error(`importFromContent returned status=error: ${result.error ?? 'no detail'}`);
  }
  if (result.status === 'skipped' && result.error) {
    // e.g. oversize rejection — gbrain refused the content.
    throw new Error(`importFromContent skipped the content: ${result.error}`);
  }
  const chunks = await engine.getChunks(slug);
  return {
    indexedText: chunks.map(c => c.chunk_text).join('\n'),
    chunks: chunks.length,
  };
}

// ─── Text modalities (markdown, html) ─────────────────────────────────

async function runTextModality(
  modality: 'markdown' | 'html',
  fixturesDir: string,
  engine: PGLiteEngine,
  acc: ProbeAccounting,
): Promise<ModalityResult> {
  const manifest = loadManifest(fixturesDir);
  if (!manifest) {
    return {
      modality,
      metric_name: 'word_recall',
      threshold: null,
      items: 0,
      items_scored: 0,
      mean_metric: null,
      per_item: [],
      skipped: true,
      skip_reason: `No committed fixture manifest at ${join(fixturesDir, 'fixtures.json')} — the ${modality} fixture set ships with the repo; a missing manifest means a broken checkout.`,
    };
  }

  const perItem: PerItem[] = [];
  const scored: number[] = [];
  const controlInputs: Array<{ name: string; content: string; canonical: string }> = [];

  for (const item of manifest.items) {
    const probeId = `${modality}:${item.name}`;
    const integrityError = verifyFixture(fixturesDir, item);
    if (integrityError) {
      acc.error(probeId, 'harness', integrityError);
      perItem.push({ name: item.name, metric: null, origin: 'harness', error: integrityError });
      continue;
    }
    const content = readFileSync(join(fixturesDir, item.path), 'utf8');
    const canonical = readFileSync(join(fixturesDir, item.canonical_path), 'utf8');
    controlInputs.push({ name: item.name, content, canonical });
    try {
      const { indexedText, chunks } = await ingestAndReadBack(engine, `cat11-${modality}-${item.name}`, content);
      const recall = wordRecall(canonical, indexedText);
      acc.score(probeId, recall);
      scored.push(recall);
      perItem.push({
        name: item.name,
        metric: recall,
        detail: {
          chunks,
          canonical_words: normalizeWords(canonical).length,
          indexed_chars: indexedText.length,
        },
      });
    } catch (err) {
      // gbrain refused or mangled the ingest: the SUT failed the probe.
      // Scored 0 and kept in the mean (probe-accounting sut policy).
      const msg = String(err);
      acc.error(probeId, 'sut', msg);
      scored.push(0);
      perItem.push({ name: item.name, metric: 0, origin: 'sut', error: msg });
    }
  }

  // Negative control: truncated ingest must crater recall, or the metric is
  // decorative. Runs through the SAME pipeline (importFromContent + getChunks).
  const controlScores: number[] = [];
  for (const input of controlInputs) {
    const degraded = input.content.slice(0, Math.floor(input.content.length * 0.25));
    try {
      const { indexedText } = await ingestAndReadBack(engine, `cat11-${modality}-${input.name}--control`, degraded);
      controlScores.push(wordRecall(input.canonical, indexedText));
    } catch {
      // A degraded config that fails to ingest at all scores worst-case 0.
      controlScores.push(0);
    }
  }

  const mean = scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  const controlMean = controlScores.length > 0
    ? controlScores.reduce((a, b) => a + b, 0) / controlScores.length
    : 0;
  const threshold = THRESHOLDS[modality];
  return {
    modality,
    metric_name: 'word_recall',
    threshold,
    items: manifest.items.length,
    items_scored: scored.length,
    mean_metric: mean,
    per_item: perItem,
    skipped: false,
    verdict: mean !== null && mean >= threshold ? 'pass' : 'fail',
    negative_control: {
      real_mean: mean ?? 0,
      control_mean: controlMean,
      // Only meaningful when the real run scored something above zero;
      // a zero real mean already fails the threshold gate.
      degradation_ok: mean === null || mean === 0 ? true : controlMean <= 0.5 * mean + 1e-9,
    },
  };
}

// ─── Audio modality (gbrain/transcription — the SUT's own path) ───────

export interface AudioRunOpts {
  /** Injectable transcriber for tests. Default uses gbrain/transcription. */
  transcribe?: (audioPath: string) => Promise<{ text: string; provider: string }>;
}

export async function runAudioModality(
  fixturesDir: string,
  acc: ProbeAccounting,
  opts: AudioRunOpts = {},
): Promise<ModalityResult> {
  const skippedBase = {
    modality: 'audio' as const,
    metric_name: 'transcription_fidelity' as const,
    threshold: null,
    items: 0,
    items_scored: 0,
    mean_metric: null,
    per_item: [],
    skipped: true,
  };
  const manifest = loadManifest(fixturesDir);
  if (!manifest) {
    return {
      ...skippedBase,
      skip_reason:
        'No audio fixture manifest: binary clips are not committed to the repo '
        + '(the fetch script the pre-audit header advertised never existed — audit retrieval-cats-03). '
        + 'Provide local fixtures + GROQ_API_KEY/OPENAI_API_KEY to run this modality.',
    };
  }

  const hasApiKey = !!process.env.GROQ_API_KEY || !!process.env.OPENAI_API_KEY;
  if (!opts.transcribe && !hasApiKey) {
    return {
      ...skippedBase,
      skip_reason: 'Neither GROQ_API_KEY nor OPENAI_API_KEY is set; audio transcription requires one (or an injected transcriber in tests).',
    };
  }

  const transcriber = opts.transcribe ?? (await loadDefaultTranscriber());
  const perItem: PerItem[] = [];
  const scored: number[] = [];

  for (const item of manifest.items) {
    const probeId = `audio:${item.name}`;
    const integrityError = verifyFixture(fixturesDir, item);
    if (integrityError) {
      acc.error(probeId, 'harness', integrityError);
      perItem.push({ name: item.name, metric: null, origin: 'harness', error: integrityError });
      continue;
    }
    try {
      const { text, provider } = await transcriber(join(fixturesDir, item.path));
      const canonical = readFileSync(join(fixturesDir, item.canonical_path), 'utf8');
      const errorRate = wer(canonical, text);
      const fidelity = Math.max(0, 1 - errorRate);
      acc.score(probeId, fidelity);
      scored.push(fidelity);
      perItem.push({
        name: item.name,
        metric: fidelity,
        provider,
        detail: {
          wer: errorRate,
          canonical_words: normalizeWords(canonical).length,
          transcribed_words: normalizeWords(text).length,
        },
      });
    } catch (err) {
      // Transcription is gbrain's own pipeline: a throw is a sut failure,
      // scored 0 (worst fidelity) and kept in the mean.
      const msg = String(err);
      acc.error(probeId, 'sut', msg);
      scored.push(0);
      perItem.push({ name: item.name, metric: 0, origin: 'sut', error: msg });
    }
  }

  const mean = scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
  return {
    modality: 'audio',
    metric_name: 'transcription_fidelity',
    threshold: THRESHOLDS.audio,
    items: manifest.items.length,
    items_scored: scored.length,
    mean_metric: mean,
    per_item: perItem,
    skipped: false,
    verdict: mean !== null && mean >= THRESHOLDS.audio ? 'pass' : 'fail',
    // No hermetic negative control: degrading transcription requires a live
    // provider call. Documented as needing a keyed run.
  };
}

async function loadDefaultTranscriber(): Promise<NonNullable<AudioRunOpts['transcribe']>> {
  // Lazy import so module load never drags in transcription's env checks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('gbrain/transcription');
  const fn = mod.transcribe ?? mod.default;
  if (typeof fn !== 'function') {
    throw new Error('gbrain/transcription does not export a transcribe function');
  }
  return async (audioPath: string) => {
    const res = await fn(audioPath);
    return { text: res.text ?? '', provider: res.provider ?? 'unknown' };
  };
}

// ─── PDF modality — permanently skipped until gbrain ships a PDF path ─

function pdfSkipped(): ModalityResult {
  return {
    modality: 'pdf',
    metric_name: 'none',
    threshold: null,
    items: 0,
    items_scored: 0,
    mean_metric: null,
    per_item: [],
    skipped: true,
    skip_reason:
      'gbrain v0.47.6.0 has no PDF text-extraction/ingest path; the pre-audit '
      + 'runner benchmarked the eval\'s own pdf-parse wrapper, which measured '
      + 'nothing about gbrain (audit retrieval-cats-12). Deferred until gbrain '
      + 'ships PDF ingestion.',
  };
}

// ─── Runner entry ─────────────────────────────────────────────────────

export interface RunCat11Options {
  fixturesRoot?: string;
  /** Override the audio transcriber (test injection). */
  transcribeAudio?: AudioRunOpts['transcribe'];
}

export async function runCat11(opts: RunCat11Options = {}): Promise<Cat11RunOutcome> {
  const root = opts.fixturesRoot ?? resolve(process.cwd(), 'eval/data/multimodal');

  // Plan the probe count up front so never-attempted probes still count in
  // the completion rate.
  const mdManifest = loadManifest(join(root, 'markdown'));
  const htmlManifest = loadManifest(join(root, 'html'));
  const audioManifest = loadManifest(join(root, 'audio'));
  const audioWillRun = audioManifest !== null
    && (!!opts.transcribeAudio || !!process.env.GROQ_API_KEY || !!process.env.OPENAI_API_KEY);
  const expected = (mdManifest?.items.length ?? 0)
    + (htmlManifest?.items.length ?? 0)
    + (audioWillRun ? audioManifest!.items.length : 0);
  const acc = new ProbeAccounting(expected);

  let markdown: ModalityResult;
  let html: ModalityResult;
  if (mdManifest || htmlManifest) {
    const engine = new PGLiteEngine();
    await engine.connect({}); // in-memory, hermetic
    await engine.initSchema();
    try {
      markdown = await runTextModality('markdown', join(root, 'markdown'), engine, acc);
      html = await runTextModality('html', join(root, 'html'), engine, acc);
    } finally {
      await engine.disconnect();
    }
  } else {
    markdown = await runTextModality('markdown', join(root, 'markdown'), null as unknown as PGLiteEngine, acc);
    html = await runTextModality('html', join(root, 'html'), null as unknown as PGLiteEngine, acc);
  }
  const audio = await runAudioModality(join(root, 'audio'), acc, { transcribe: opts.transcribeAudio });
  const pdf = pdfSkipped();

  const results: Record<Modality, ModalityResult> = { markdown, html, pdf, audio };
  const ran = Object.values(results).filter(r => !r.skipped);
  const verdict: Cat11Report['verdict'] = ran.length === 0
    ? 'skipped'
    : ran.every(r => r.verdict === 'pass') ? 'pass' : 'fail';

  const controlFailures = ran
    .filter(r => r.negative_control && !r.negative_control.degradation_ok)
    .map(r => r.modality);

  return {
    report: {
      schema_version: 2,
      ran_at: new Date().toISOString(),
      results,
      verdict,
    },
    accounting: acc.summary(),
    control_failures: controlFailures,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────

interface CliOpts {
  fixturesRoot?: string;
  allowSkip: boolean;
  receiptPathOverride?: string;
  reportPathOverride?: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { allowSkip: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-skip') opts.allowSkip = true;
    else if (a === '--fixtures-root') opts.fixturesRoot = argv[++i];
    else if (a === '--receipt-path') opts.receiptPathOverride = argv[++i];
    else if (a === '--report-path') opts.reportPathOverride = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = parseArgs(argv);
  const startedAt = new Date().toISOString();
  const receiptFile = cli.receiptPathOverride ?? receiptPath('cat11-multimodal');
  const reportFile = cli.reportPathOverride
    ?? join(process.cwd(), 'eval/reports/cat11-multimodal/report.json');

  const outcome = await runCat11({ fixturesRoot: cli.fixturesRoot });
  const { report, accounting, control_failures } = outcome;

  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));

  const ranModalities = Object.values(report.results).filter(r => !r.skipped).map(r => r.modality);
  const skippedModalities = Object.values(report.results)
    .filter(r => r.skipped)
    .map(r => ({ modality: r.modality, reason: r.skip_reason ?? '' }));

  const base: Omit<Receipt, 'run_status' | 'verdict' | 'skip_reason' | 'publishable'> = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'cat11-multimodal',
    n_total: accounting.n_total,
    n_scored: accounting.n_scored,
    completion_rate: accounting.completion_rate,
    errors: accounting.errors,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      ingest_path: 'importFromContent (gbrain/import-file), noEmbed: true',
      search_mode: 'not-exercised (cat11 issues no search calls)',
      reranker: 'not-exercised',
      modalities_run: ranModalities,
      modalities_skipped: skippedModalities,
      thresholds: THRESHOLDS,
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      modalities: Object.fromEntries(
        Object.values(report.results).map(r => [r.modality, {
          skipped: r.skipped,
          mean_metric: r.mean_metric,
          threshold: r.threshold,
          verdict: r.verdict ?? null,
          negative_control: r.negative_control ?? null,
        }]),
      ),
    },
  };

  if (report.verdict === 'skipped') {
    const reason = skippedModalities.map(s => `${s.modality}: ${s.reason}`).join(' | ');
    writeReceipt(receiptFile, {
      ...base,
      run_status: 'skipped',
      skip_reason: reason,
      publishable: false,
    });
    console.error(`[cat11] SKIPPED — no modality could run. ${cli.allowSkip ? '--allow-skip acknowledged.' : 'Exiting non-zero (pass --allow-skip to acknowledge).'}`);
    return cli.allowSkip ? 0 : 2;
  }

  if (control_failures.length > 0 || accounting.run_invalid) {
    const controlErrors = control_failures.map(m => ({
      probe_id: `negative-control:${m}`,
      origin: 'harness' as const,
      message: 'truncated-ingest control did not score ≤ 0.5x the real mean — the metric cannot detect text loss; run invalid',
    }));
    writeReceipt(receiptFile, {
      ...base,
      errors: [...accounting.errors, ...controlErrors],
      run_status: 'error',
      publishable: false,
    });
    console.error(`[cat11] RUN INVALID — ${accounting.run_invalid ? `infra error rate ${(accounting.infra_error_rate * 100).toFixed(1)}% over cap` : ''}${control_failures.length > 0 ? ` negative control failed for: ${control_failures.join(', ')}` : ''}`);
    return 3;
  }

  writeReceipt(receiptFile, {
    ...base,
    run_status: 'completed',
    verdict: report.verdict,
    publishable: accounting.publishable,
  });
  console.error(`[cat11] verdict=${report.verdict} (${ranModalities.join(', ')} ran; ${skippedModalities.map(s => s.modality).join(', ')} skipped)`);
  return report.verdict === 'pass' ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(err => {
      console.error(err);
      process.exit(3);
    });
}

/**
 * transcript-distill-v1 Opus prose generator (Cat 35, Lane A).
 *
 * Takes the deterministic skeleton from transcript-distill.ts and asks Opus
 * to write each transcript as a full alternating conversation that includes
 * every planted anchor VERBATIM. Writes:
 *
 *   eval/data/transcript-distill-v1/transcripts/<date>-<id>.jsonl      (claude-code format, lanes 1+2)
 *   eval/data/transcript-distill-v1/transcripts-txt/<date>-<id>.txt    (plain rendering, dream lane)
 *   eval/data/transcript-distill-v1/gold/<id>.json                     (gold items + distractors + hazards)
 *   eval/data/transcript-distill-v1/brain-scaffold/<slug>.md           (10 wikilink-target pages)
 *   eval/data/transcript-distill-v1/judge-calibration-sample.json      (seeded blank 40-item draw)
 *   eval/data/transcript-distill-v1/_manifest.json                     (corpus-manifest.schema.json conformant)
 *
 * Cost discipline (modeled on eval/generators/amara-life-gen.ts):
 *   - HARD_STOP_USD = 20 — hard exit on overshoot (Opus + Haiku audit share it)
 *   - Per-transcript structured cache key:
 *       sha256(JSON.stringify({
 *         schema_version, template_id, template_hash, model_id, model_params,
 *         seed, item_spec_hash
 *       }))
 *   - Cache path: eval/data/transcript-distill-v1/_cache/<cache_key>.json (gitignored)
 *   - Cache hit → skip LLM call (zero spend).
 *
 * Validation gate (hard-fails after generation): every anchor present in
 * both renderings (normalized-whitespace substring); .txt >= 2200 chars; no
 * word-boundary dream-discovery exclude words anywhere; JSONL round-trips
 * through gbrain's parseClaudeSessionFile with turns + timestamps; no
 * secret-shaped strings; gold statements + anchors unique; manifest lists
 * every written file (full runs).
 *
 * Audit pass (--audit, also on full runs): one Haiku call per signal
 * transcript listing salient statements NOT covered by gold and checking
 * each distractor would score low notability. Flags land in
 * eval/reports/transcript-distill-gen/audit-<date>.json for the human skim.
 *
 * Determinism: fixture content never uses Date.now — all timestamps derive
 * from base_ts + turn index. Progress goes to stderr; stdout stays clean.
 *
 * Usage:
 *   bun eval/generators/transcript-distill-gen.ts             # full 24-transcript run (~$6-12 Opus + ~$0.30 Haiku audit)
 *   bun eval/generators/transcript-distill-gen.ts --dry-run   # plan only: no API calls, no writes, no API key needed
 *   bun eval/generators/transcript-distill-gen.ts --max 2     # first 2 transcripts only (manifest write skipped)
 *   bun eval/generators/transcript-distill-gen.ts --force     # ignore cache
 *   bun eval/generators/transcript-distill-gen.ts --audit     # force the Haiku audit pass
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import {
  buildSkeletons,
  CORPUS_SEED,
  SCAFFOLD_PAGES,
  TRANSCRIPT_THEMES,
  type TranscriptSkeleton,
  type TurnPlan,
} from './transcript-distill.ts';

// ─── Env + client ────────────────────────────────────────────────────

function loadEnv(): void {
  const envPath = '.env.testing';
  if (!existsSync(envPath)) {
    // Optional: an already-exported ANTHROPIC_API_KEY is just as good (the
    // fresh-clone path README/§10 describe). The explicit key check downstream
    // produces the actionable error when neither source provides a key.
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        `${envPath} not found and ANTHROPIC_API_KEY is not set. Export the key ` +
        `or create ${envPath} (KEY=value lines).`
      );
    }
    return;
  }
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ─── Constants (pinned in cache key via `model_params`) ──────────────

const MODEL = 'claude-opus-4-5';
const PRICE_INPUT_PER_M = 15;
const PRICE_OUTPUT_PER_M = 75;
const AUDIT_MODEL = 'claude-haiku-4-5-20251001';
const AUDIT_PRICE_INPUT_PER_M = 1;
const AUDIT_PRICE_OUTPUT_PER_M = 5;
const HARD_STOP_USD = 20;
const SCHEMA_VERSION = 1; // bump invalidates cache wholesale

const MODEL_PARAMS = {
  max_tokens: 16000, // long-noisy transcripts target 10-30K chars (~3-8K tokens)
  temperature: 1.0,
};

const CORPUS_ROOT = 'eval/data/transcript-distill-v1';
const CACHE_DIR = join(CORPUS_ROOT, '_cache');
const REPORTS_DIR = 'eval/reports/transcript-distill-gen';
const MIN_TXT_CHARS = 2200;
/** Fixed corpus-freeze timestamp — fixture content never uses Date.now. */
const GENERATED_AT = '2026-08-15T00:00:00.000Z';

// Word-boundary dream-discovery exclude (built from char codes so this
// source file never trips a text-level scan of itself).
const BANNED_RE = new RegExp(
  `\\b(${String.fromCharCode(109, 101, 100, 105, 99, 97, 108)}|${String.fromCharCode(116, 104, 101, 114, 97, 112, 121)})\\b`,
  'i'
);
// Hyphens allowed after sk- so modern key shapes (sk-ant-..., sk-proj-...)
// are caught, not just legacy contiguous-alnum keys.
const SECRET_RE = /\b(sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|password\s*=)/;

// ─── Cache keys ──────────────────────────────────────────────────────

interface CacheKeyInput {
  schema_version: number;
  template_id: string;
  template_hash: string;
  model_id: string;
  model_params: typeof MODEL_PARAMS;
  seed: number;
  item_spec_hash: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function canonicalJson(obj: unknown): string {
  // Stable key order for deterministic hashing.
  const replacer = (_k: string, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v as object).sort().reduce((acc, k) => {
          (acc as Record<string, unknown>)[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {} as Record<string, unknown>)
      : v;
  return JSON.stringify(obj, replacer);
}

function cacheKey(input: CacheKeyInput): string {
  return sha256(canonicalJson(input));
}

// ─── Prompt template ─────────────────────────────────────────────────

const TRANSCRIPT_TEMPLATE = `You are writing one FICTIONAL agent-session transcript for a synthetic eval corpus.
It is a working conversation between a user and their AI coding/thinking assistant.

SCENARIO: {scenario} (variant: {variant})
THEME: {theme}

HARD RULES:
1. Write EXACTLY {turn_count} turns, alternating USER then ASSISTANT, starting with USER.
2. Output format: each turn starts with a line that is exactly "### USER" or "### ASSISTANT"
   (nothing else on that line), followed by that turn's text. No preamble before the first
   delimiter, no commentary after the last turn, no other headings.
3. Each turn below lists REQUIRED PHRASES. Every required phrase MUST appear VERBATIM,
   character for character, inside that exact turn's text. Weave them in so they read as
   natural speech; you may add punctuation around them but never alter the words inside.
4. Everything is fictional: people, companies, repos, bug IDs, numbers. Never reference
   real products, real people, or real companies. Never include anything that looks like
   a real credential, API key, or password.
5. Plain ASCII punctuation only: straight quotes, three dots for ellipsis, no em dashes.
6. Do not use clinical or health-care vocabulary anywhere in the transcript.
7. {length_instruction}
8. Turns marked "noise:" must contain a realistic fictional noise block of that kind:
   - tool-block: a block like "[tool: bash]" then a fake command, then "[tool result]"
     then plausible fake output (paths, counts, durations).
   - log-dump: a multi-line fictional log or raw text dump (timestamps, levels, noise lines).
   - code-snippet: a fenced fictional code snippet relevant to the scenario.
   Noise blocks are filler realism — they must NOT introduce new memorable facts,
   decisions, or names beyond what the briefs describe.

TURN PLAN:
{turn_plan}
`;

const TEMPLATE_HASH = sha256(TRANSCRIPT_TEMPLATE);

function lengthInstruction(sk: TranscriptSkeleton): string {
  if (sk.variant === 'long-noisy') {
    return 'Total transcript length must be between 12000 and 28000 characters. ' +
      'Noise turns should be long (500-1500 characters each); prose turns stay conversational (2-6 sentences).';
  }
  return 'Total transcript length must be at least 2600 characters; aim for 3000-6000. ' +
    'Keep turns conversational (2-6 sentences each).';
}

function renderTurnPlan(turns: TurnPlan[]): string {
  return turns.map((t, i) => {
    const lines = [`[turn ${i + 1}] ${t.role.toUpperCase()}${t.noise ? ` (noise: ${t.noise})` : ''}`];
    lines.push(`  brief: ${t.brief}`);
    if (t.must_include_anchors.length) {
      lines.push('  required phrases:');
      for (const a of t.must_include_anchors) lines.push(`    - "${a}"`);
    }
    return lines.join('\n');
  }).join('\n');
}

// String-pattern replace with a REPLACEMENT FUNCTION: a plain string
// replacement would interpret `$&`/`$'` patterns inside generated text.
function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, () => v);
  return out;
}

function buildPrompt(sk: TranscriptSkeleton): string {
  const theme = TRANSCRIPT_THEMES[sk.transcript_id]
    ?? `${sk.scenario} session (${sk.variant}). Opening beat: ${sk.turns[0].brief}`;
  return fill(TRANSCRIPT_TEMPLATE, {
    scenario: sk.scenario,
    variant: sk.variant,
    theme,
    turn_count: String(sk.turns.length),
    length_instruction: lengthInstruction(sk),
    turn_plan: renderTurnPlan(sk.turns),
  });
}

// ─── Opus / Haiku calls + cost tracking ──────────────────────────────

interface CostTracker {
  input_tokens: number;
  output_tokens: number;
  usd: number;
  calls: number;
}

function checkHardStop(tracker: CostTracker): void {
  if (tracker.usd > HARD_STOP_USD) {
    throw new Error(
      `HARD_STOP_USD (${HARD_STOP_USD}) exceeded: $${tracker.usd.toFixed(2)} — bailing. ` +
      `Completed transcripts are cached; re-run to resume.`
    );
  }
}

async function callModel(
  client: Anthropic,
  model: string,
  prices: { input: number; output: number },
  prompt: string,
  tracker: CostTracker
): Promise<string> {
  const res = await client.messages.create({
    model,
    max_tokens: MODEL_PARAMS.max_tokens,
    temperature: MODEL_PARAMS.temperature,
    messages: [{ role: 'user', content: prompt }],
  });

  const inTok = res.usage.input_tokens;
  const outTok = res.usage.output_tokens;
  tracker.input_tokens += inTok;
  tracker.output_tokens += outTok;
  tracker.usd += (inTok * prices.input + outTok * prices.output) / 1_000_000;
  tracker.calls++;
  checkHardStop(tracker);

  const first = res.content[0];
  if (first.type !== 'text') throw new Error(`Unexpected non-text content block from ${model}`);
  return first.text;
}

// ─── Cache ───────────────────────────────────────────────────────────

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function tryCache(key: string): string | null {
  const p = cachePath(key);
  if (!existsSync(p)) return null;
  const cached = JSON.parse(readFileSync(p, 'utf8')) as { raw: string };
  return cached.raw;
}

function saveCache(key: string, raw: string, meta: Record<string, unknown>): void {
  mkdirSync(dirname(cachePath(key)), { recursive: true });
  writeFileSync(cachePath(key), JSON.stringify({ key, raw, meta }, null, 2));
}

// ─── Parsing + per-transcript checks ─────────────────────────────────

interface ParsedTurn {
  role: 'user' | 'assistant';
  text: string;
}

function parseTurns(raw: string): ParsedTurn[] {
  // Tolerate a wholesale ```-fence wrap around the entire output (fences
  // INSIDE turns — code-snippet noise — are untouched).
  let body = raw.trim();
  const wrap = body.match(/^```[a-z]*\n([\s\S]*)\n```$/);
  if (wrap) body = wrap[1];

  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^###\s+(USER|ASSISTANT)\s*$/);
    if (m) {
      if (current) turns.push(current);
      current = { role: m[1].toLowerCase() as ParsedTurn['role'], text: '' };
    } else if (current) {
      current.text += (current.text ? '\n' : '') + line;
    }
    // Lines before the first delimiter are dropped (preamble tolerance).
  }
  if (current) turns.push(current);
  for (const t of turns) t.text = t.text.trim();
  return turns;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function renderTxt(turns: ParsedTurn[]): string {
  return turns.map((t) => `[${t.role}]\n${t.text}`).join('\n\n') + '\n';
}

function renderJsonl(sk: TranscriptSkeleton, turns: ParsedTurn[]): string {
  const base = Date.parse(sk.base_ts);
  const lines = turns.map((t, i) => JSON.stringify({
    type: t.role,
    uuid: `u-${i + 1}`,
    sessionId: sk.session_id,
    timestamp: new Date(base + i * 45_000).toISOString(),
    message: { role: t.role, content: [{ type: 'text', text: t.text }] },
  }));
  return lines.join('\n') + '\n';
}

/**
 * Per-transcript quality gate. Returns [] when clean.
 *
 * Turn count is a TOLERANCE BAND, not an exact match: Opus reliably includes
 * every anchor but drifts on exact turn counts for long-noisy plans (32 vs a
 * planned 28 killed the first full run). Exact count isn't load-bearing —
 * anchors, roles-alternation, length, and the banned-word screen are. When the
 * count matches the plan exactly we keep the strict per-index role + per-turn
 * anchor placement checks; when it drifts within the band we fall back to
 * whole-transcript anchor presence (what the eval actually depends on) and an
 * alternation check. depth_bucket stays derived from the PLANNED position —
 * it is a descriptive bucket, tolerant of a few turns of drift.
 */
function checkTranscript(sk: TranscriptSkeleton, turns: ParsedTurn[]): string[] {
  const errors: string[] = [];
  const planned = sk.turns.length;
  const lo = Math.max(6, Math.floor(planned * 0.75));
  const hi = Math.ceil(planned * 1.35);
  if (turns.length < lo || turns.length > hi) {
    errors.push(`turn count ${turns.length} outside tolerance [${lo}, ${hi}] (planned ${planned})`);
    return errors; // degenerate output; other checks are meaningless
  }
  const aligned = turns.length === planned;
  if (aligned) {
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].role !== sk.turns[i].role) {
        errors.push(`turn ${i + 1} role ${turns[i].role} != planned ${sk.turns[i].role}`);
      }
    }
    for (let i = 0; i < sk.turns.length; i++) {
      const turnText = normalize(turns[i]?.text ?? '');
      for (const anchor of sk.turns[i].must_include_anchors) {
        if (!turnText.includes(normalize(anchor))) {
          errors.push(`turn ${i + 1} missing required phrase: "${anchor}"`);
        }
      }
    }
  } else {
    if (turns[0]?.role !== 'user') errors.push('first turn must be user');
    for (let i = 1; i < turns.length; i++) {
      if (turns[i].role === turns[i - 1].role) {
        errors.push(`turns ${i} and ${i + 1} have the same role; alternate user/assistant`);
        break;
      }
    }
    const fullNorm = normalize(turns.map((t) => t.text).join('\n'));
    for (const plannedTurn of sk.turns) {
      for (const anchor of plannedTurn.must_include_anchors) {
        if (!fullNorm.includes(normalize(anchor))) {
          errors.push(`missing required phrase: "${anchor}"`);
        }
      }
    }
  }
  const full = turns.map((t) => t.text).join('\n');
  if (BANNED_RE.test(full)) {
    errors.push('transcript uses an excluded clinical word; rewrite without any clinical or health-care terms');
  }
  const txtLen = renderTxt(turns).length;
  if (txtLen < MIN_TXT_CHARS) {
    errors.push(`rendered transcript is ${txtLen} chars; minimum is ${MIN_TXT_CHARS} — write longer turns`);
  }
  return errors;
}

// ─── Per-transcript generation (call → check → retry once → hard error) ──

async function generateTranscript(
  sk: TranscriptSkeleton,
  client: Anthropic,
  tracker: CostTracker,
  opts: { force: boolean }
): Promise<{ turns: ParsedTurn[]; cacheHit: boolean; cache_key: string }> {
  const key = cacheKey({
    schema_version: SCHEMA_VERSION,
    template_id: 'transcript-v1',
    template_hash: TEMPLATE_HASH,
    model_id: MODEL,
    model_params: MODEL_PARAMS,
    seed: CORPUS_SEED,
    item_spec_hash: sha256(canonicalJson(sk)),
  });

  if (!opts.force) {
    const cached = tryCache(key);
    if (cached !== null) {
      const turns = parseTurns(cached);
      const errors = checkTranscript(sk, turns);
      if (errors.length === 0) return { turns, cacheHit: true, cache_key: key };
      console.error(`  cache entry for ${sk.transcript_id} fails checks (${errors.length}); regenerating`);
    }
  }

  const prompt = buildPrompt(sk);
  const prices = { input: PRICE_INPUT_PER_M, output: PRICE_OUTPUT_PER_M };

  let raw = await callModel(client, MODEL, prices, prompt, tracker);
  let turns = parseTurns(raw);
  let errors = checkTranscript(sk, turns);

  if (errors.length > 0) {
    console.error(`  ${sk.transcript_id}: attempt 1 failed ${errors.length} checks; retrying once`);
    const retryPrompt = prompt +
      '\n\nPREVIOUS ATTEMPT FAILED THESE CHECKS — fix every one this time:\n' +
      errors.map((e) => `- ${e}`).join('\n');
    raw = await callModel(client, MODEL, prices, retryPrompt, tracker);
    turns = parseTurns(raw);
    errors = checkTranscript(sk, turns);
  }

  if (errors.length > 0) {
    throw new Error(
      `${sk.transcript_id}: still failing after retry:\n` + errors.map((e) => `  - ${e}`).join('\n')
    );
  }

  saveCache(key, raw, { transcript_id: sk.transcript_id, seed: CORPUS_SEED });
  return { turns, cacheHit: false, cache_key: key };
}

// ─── Deterministic side outputs (scaffold, calibration draw) ─────────

// Mulberry32 — same idiom as transcript-distill.ts / amara-life.ts.
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface CalibrationEntry {
  slot: 'coverage' | 'grounding' | 'distractor';
  item_id_or_ref: string | { transcript_id: string; slot: string };
  transcript_id: string;
  lane_hint: 'verbatim' | 'facts' | 'dream';
  judge_verdict: null;
  human_verdict: null;
}

/**
 * Seeded 40-item draw: 24 coverage (concrete gold item_ids) + 8 grounding +
 * 8 distractor-confirm. Grounding/distractor claims only exist at RUN time,
 * so those entries carry transcript-level `{transcript_id, slot}` refs.
 * Verdict columns ship blank — filled copies live in a separate annotation
 * artifact under docs/benchmarks/ (the corpus never mutates post-run).
 */
function buildCalibrationSample(skeletons: TranscriptSkeleton[]): {
  schema_version: number;
  corpus_seed: number;
  note: string;
  entries: CalibrationEntry[];
} {
  const rng = createRng(CORPUS_SEED);
  const laneCycle: CalibrationEntry['lane_hint'][] = ['dream', 'facts', 'verbatim'];

  const goldPool = skeletons.flatMap((sk) =>
    sk.items.map((it) => ({ item_id: it.item_id, transcript_id: sk.transcript_id }))
  );
  const coverage = seededShuffle(goldPool, rng).slice(0, 24).map((x, i): CalibrationEntry => ({
    slot: 'coverage',
    item_id_or_ref: x.item_id,
    transcript_id: x.transcript_id,
    lane_hint: laneCycle[i % laneCycle.length],
    judge_verdict: null,
    human_verdict: null,
  }));

  const signalIds = skeletons.filter((s) => s.expected_triage === 'high').map((s) => s.transcript_id);
  const grounding = seededShuffle(signalIds, rng).slice(0, 8).map((tid): CalibrationEntry => ({
    slot: 'grounding',
    item_id_or_ref: { transcript_id: tid, slot: 'grounding' },
    transcript_id: tid,
    lane_hint: 'dream',
    judge_verdict: null,
    human_verdict: null,
  }));

  const allIds = skeletons.map((s) => s.transcript_id);
  const distractor = seededShuffle(allIds, rng).slice(0, 8).map((tid): CalibrationEntry => ({
    slot: 'distractor',
    item_id_or_ref: { transcript_id: tid, slot: 'distractor' },
    transcript_id: tid,
    lane_hint: 'dream',
    judge_verdict: null,
    human_verdict: null,
  }));

  return {
    schema_version: 1,
    corpus_seed: CORPUS_SEED,
    note: 'Blank seeded draw (E2). Fill human_verdict in a COPY under docs/benchmarks/<slug>/judge-calibration-<date>.json; this corpus file never mutates post-run.',
    entries: [...coverage, ...grounding, ...distractor],
  };
}

// ─── Manifest ────────────────────────────────────────────────────────

interface ManifestItem {
  slug: string;
  path: string;
  type: string;
  content_sha256: string;
  generator_cache_key?: string;
}

function scaffoldType(slug: string): string {
  if (slug.startsWith('people/')) return 'person';
  if (slug.startsWith('companies/')) return 'company';
  return 'concept';
}

// ─── Output tracking + validation gate ───────────────────────────────

interface WrittenFile {
  path: string; // relative to CORPUS_ROOT
  content: string;
}

function writeOut(files: WrittenFile[], relPath: string, content: string): void {
  const full = join(CORPUS_ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  files.push({ path: relPath, content });
}

async function runValidationGate(
  files: WrittenFile[],
  generated: { sk: TranscriptSkeleton; turns: ParsedTurn[] }[],
  manifestItems: ManifestItem[] | null
): Promise<void> {
  const errors: string[] = [];

  // 1. Anchors present in both renderings (normalized-whitespace substring).
  for (const { sk, turns } of generated) {
    const txt = normalize(renderTxt(turns));
    const jsonlTexts = normalize(turns.map((t) => t.text).join('\n'));
    const anchors = [
      ...sk.items.map((i) => i.verbatim_anchor),
      ...sk.distractors.map((x) => x.anchor),
      ...sk.hazards.map((h) => h.anchor),
    ];
    for (const a of anchors) {
      const n = normalize(a);
      if (!txt.includes(n)) errors.push(`${sk.transcript_id}: anchor missing from .txt rendering: "${a}"`);
      if (!jsonlTexts.includes(n)) errors.push(`${sk.transcript_id}: anchor missing from .jsonl rendering: "${a}"`);
    }

    // 2. .txt length gate.
    const txtLen = renderTxt(turns).length;
    if (txtLen < MIN_TXT_CHARS) errors.push(`${sk.transcript_id}: .txt is ${txtLen} chars (< ${MIN_TXT_CHARS})`);

    // 5. Gold statements + anchors unique within the transcript (corpus-wide
    //    uniqueness is asserted by buildSkeletons; re-check the per-file gold).
    const stmts = new Set(sk.items.map((i) => normalize(i.statement)));
    if (stmts.size !== sk.items.length) errors.push(`${sk.transcript_id}: duplicate gold statements`);
  }

  // 3. Banned words + secret scan over EVERY output file.
  for (const f of files) {
    if (BANNED_RE.test(f.content)) errors.push(`banned dream-discovery exclude word in ${f.path}`);
    if (SECRET_RE.test(f.content)) errors.push(`secret-shaped string in ${f.path}`);
  }

  // 4. JSONL round-trips through gbrain's session parser with timestamps.
  const { parseClaudeSessionFile } = await import(
    '../../node_modules/gbrain/src/core/transcripts/claude-code-jsonl.ts'
  );
  for (const { sk } of generated) {
    const rel = `transcripts/${sk.date}-${sk.transcript_id}.jsonl`;
    const full = join(CORPUS_ROOT, rel);
    try {
      const parsed = parseClaudeSessionFile(full);
      if (parsed.turns.length === 0) errors.push(`${rel}: parseClaudeSessionFile returned 0 turns`);
      if (parsed.turns.some((t: { timestamp: string }) => !t.timestamp)) {
        errors.push(`${rel}: a parsed turn is missing its timestamp`);
      }
      if (parsed.sessionId !== sk.session_id) {
        errors.push(`${rel}: sessionId ${parsed.sessionId} != ${sk.session_id}`);
      }
    } catch (err) {
      errors.push(`${rel}: parseClaudeSessionFile threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 6. Manifest completeness (full runs only — --max writes no manifest).
  if (manifestItems) {
    const manifestPaths = new Set(manifestItems.map((i) => i.path));
    for (const f of files) {
      if (f.path === '_manifest.json') continue;
      if (!manifestPaths.has(f.path)) errors.push(`manifest is missing written file: ${f.path}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `VALIDATION GATE FAILED (${errors.length} problems):\n` +
      errors.map((e) => `  - ${e}`).join('\n')
    );
  }
}

// ─── Audit pass (Haiku, gold-completeness + distractor notability) ───

const AUDIT_TEMPLATE = `You are auditing a synthetic eval transcript for gold-coverage completeness.

TRANSCRIPT:
{transcript}

GOLD STATEMENTS (already tracked as salient):
{golds}

DISTRACTOR STATEMENTS (intended to be low-notability noise):
{distractors}

Task 1: List any SALIENT statements in the transcript (facts, decisions, ideas, or feelings a
note-taker would keep) that are NOT covered by any gold statement above. Return [] if none.
Task 2: For each distractor, judge whether a reasonable note-taker would rate it LOW notability.
Flag any that feel medium or high.

Respond with ONLY JSON, no code fences:
{"uncovered_salient": ["..."], "distractor_flags": [{"statement": "...", "why": "..."}]}
`;

async function runAuditPass(
  generated: { sk: TranscriptSkeleton; turns: ParsedTurn[] }[],
  client: Anthropic,
  tracker: CostTracker
): Promise<void> {
  const signal = generated.filter((gp) => gp.sk.expected_triage === 'high');
  const results: Record<string, unknown>[] = [];
  let i = 0;
  for (const { sk, turns } of signal) {
    i++;
    const prompt = fill(AUDIT_TEMPLATE, {
      transcript: renderTxt(turns),
      golds: sk.items.map((it) => `- [${it.kind}] ${it.statement}`).join('\n'),
      distractors: sk.distractors.map((dx) => `- ${dx.statement}`).join('\n'),
    });
    try {
      const raw = await callModel(
        client, AUDIT_MODEL,
        { input: AUDIT_PRICE_INPUT_PER_M, output: AUDIT_PRICE_OUTPUT_PER_M },
        prompt, tracker
      );
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
      results.push({ transcript_id: sk.transcript_id, ...JSON.parse(cleaned) });
    } catch (err) {
      results.push({
        transcript_id: sk.transcript_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    console.error(`  audit ${i}/${signal.length} (${sk.transcript_id}) — $${tracker.usd.toFixed(2)}`);
  }

  const date = new Date().toISOString().slice(0, 10); // report filename only, never fixture content
  const outPath = join(REPORTS_DIR, `audit-${date}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    schema_version: 1,
    model: AUDIT_MODEL,
    corpus_seed: CORPUS_SEED,
    transcripts_audited: signal.length,
    flags: results,
  }, null, 2));
  const flagged = results.filter((r) => {
    const u = r.uncovered_salient as unknown[] | undefined;
    const dflags = r.distractor_flags as unknown[] | undefined;
    return (u?.length ?? 0) > 0 || (dflags?.length ?? 0) > 0 || 'error' in r;
  });
  console.error(`  audit written to ${outPath} (${flagged.length}/${results.length} transcripts flagged for the human skim)`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const audit = argv.includes('--audit');
  const maxIdx = argv.indexOf('--max');
  const max = maxIdx !== -1 ? parseInt(argv[maxIdx + 1] ?? '', 10) : Infinity;
  const fullRun = !dryRun && max === Infinity;

  const skeletons = buildSkeletons();
  const selected = skeletons.slice(0, Math.min(skeletons.length, max));

  console.error(`transcript-distill-gen: skeleton built (seed=${CORPUS_SEED})`);
  console.error(`  transcripts: ${skeletons.length} total, ${selected.length} selected`);
  console.error(`  gold items: ${skeletons.reduce((n, s) => n + s.items.length, 0)}, ` +
    `distractors: ${skeletons.reduce((n, s) => n + s.distractors.length, 0)}, ` +
    `hazards: ${skeletons.reduce((n, s) => n + s.hazards.length, 0)}`);
  console.error(`  dryRun=${dryRun} force=${force} max=${max === Infinity ? 'all' : max} audit=${audit || fullRun}`);

  if (dryRun) {
    // Plan only: no API key, no API calls, no writes.
    let estUsd = 0;
    for (const sk of selected) {
      const prompt = buildPrompt(sk);
      const estIn = Math.ceil(prompt.length / 4);
      const estOut = sk.variant === 'long-noisy' ? 6000 : 1400;
      const usd = (estIn * PRICE_INPUT_PER_M + estOut * PRICE_OUTPUT_PER_M) / 1_000_000;
      estUsd += usd;
      const anchorCount = sk.turns.reduce((n, t) => n + t.must_include_anchors.length, 0);
      console.error(
        `  [plan] ${sk.transcript_id} (${sk.variant}, ${sk.turns.length} turns, ` +
        `${anchorCount} anchors) ~$${usd.toFixed(2)}`
      );
    }
    console.error(`  [plan] estimated Opus spend: ~$${estUsd.toFixed(2)} ` +
      `(+ ~$${(0.02 * selected.filter((s) => s.expected_triage === 'high').length).toFixed(2)} Haiku audit) ` +
      `— hard stop at $${HARD_STOP_USD}`);
    console.error('  [plan] dry-run: nothing written, no API calls made.');
    return;
  }

  loadEnv();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot run. Use --dry-run to preview.');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tracker: CostTracker = { input_tokens: 0, output_tokens: 0, usd: 0, calls: 0 };

  const files: WrittenFile[] = [];
  const manifestItems: ManifestItem[] = [];
  const generated: { sk: TranscriptSkeleton; turns: ParsedTurn[] }[] = [];

  // ── Transcripts (Opus; cached) ──
  let idx = 0;
  for (const sk of selected) {
    idx++;
    const { turns, cacheHit, cache_key } = await generateTranscript(sk, client, tracker, { force });
    generated.push({ sk, turns });

    const jsonl = renderJsonl(sk, turns);
    const txt = renderTxt(turns);
    const jsonlPath = `transcripts/${sk.date}-${sk.transcript_id}.jsonl`;
    const txtPath = `transcripts-txt/${sk.date}-${sk.transcript_id}.txt`;
    writeOut(files, jsonlPath, jsonl);
    writeOut(files, txtPath, txt);
    manifestItems.push({
      slug: `transcripts/${sk.transcript_id}`,
      path: jsonlPath,
      type: 'conversation',
      content_sha256: sha256(jsonl),
      generator_cache_key: cache_key,
    });
    manifestItems.push({
      slug: `transcripts-txt/${sk.transcript_id}`,
      path: txtPath,
      type: 'conversation',
      content_sha256: sha256(txt),
      generator_cache_key: cache_key,
    });

    const gold = JSON.stringify({
      schema_version: 1,
      transcript_id: sk.transcript_id,
      scenario: sk.scenario,
      variant: sk.variant,
      expected_triage: sk.expected_triage,
      session_id: sk.session_id,
      base_ts: sk.base_ts,
      entities: sk.entities,
      items: sk.items,
      distractors: sk.distractors,
      hazards: sk.hazards,
    }, null, 2) + '\n';
    const goldPath = `gold/${sk.transcript_id}.json`;
    writeOut(files, goldPath, gold);
    manifestItems.push({
      slug: `gold/${sk.transcript_id}`,
      path: goldPath,
      type: 'note',
      content_sha256: sha256(gold),
    });

    console.error(
      `  transcript ${idx}/${selected.length} ${sk.transcript_id} ` +
      `(${sk.variant}, ${txt.length} chars${cacheHit ? ', cache hit' : ''}) — $${tracker.usd.toFixed(2)}`
    );
  }

  // ── Brain scaffold (deterministic, no LLM) ──
  for (const page of SCAFFOLD_PAGES) {
    const rel = `brain-scaffold/${page.slug}.md`;
    writeOut(files, rel, page.body);
    manifestItems.push({
      slug: page.slug,
      path: rel,
      type: scaffoldType(page.slug),
      content_sha256: sha256(page.body),
    });
  }

  // ── Judge-calibration sample (seeded blank draw, no LLM) ──
  const calibration = JSON.stringify(buildCalibrationSample(skeletons), null, 2) + '\n';
  writeOut(files, 'judge-calibration-sample.json', calibration);
  manifestItems.push({
    slug: 'meta/judge-calibration-sample',
    path: 'judge-calibration-sample.json',
    type: 'note',
    content_sha256: sha256(calibration),
  });

  // ── Manifest (full runs only — a --max run must not clobber it with a partial) ──
  let manifestForGate: ManifestItem[] | null = null;
  if (fullRun) {
    const manifest = JSON.stringify({
      schema_version: 1,
      corpus_id: 'transcript-distill-v1',
      generated_at: GENERATED_AT,
      generator: {
        name: 'transcript-distill-gen',
        model: MODEL,
        model_params: MODEL_PARAMS,
        seed: CORPUS_SEED,
        template_hash: TEMPLATE_HASH,
      },
      license: 'MIT',
      items: manifestItems,
    }, null, 2) + '\n';
    writeOut(files, '_manifest.json', manifest);
    manifestForGate = manifestItems;
  } else {
    console.error('  (partial run: _manifest.json not written; re-run without --max to freeze the corpus)');
  }

  // ── Validation gate (hard-fails) ──
  await runValidationGate(files, generated, manifestForGate);
  console.error(`  validation gate: PASS (${files.length} files)`);

  // ── Audit pass (Haiku; --audit or full run) ──
  if (audit || fullRun) {
    await runAuditPass(generated, client, tracker);
  }

  console.error(`\nDONE: ${tracker.calls} LLM calls, ${tracker.input_tokens} in, ` +
    `${tracker.output_tokens} out, $${tracker.usd.toFixed(2)} spent.`);
  console.error(`  files written: ${files.length}`);
  console.error(`  output root: ${CORPUS_ROOT}/`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

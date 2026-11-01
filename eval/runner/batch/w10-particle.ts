#!/usr/bin/env bun
/**
 * particle-1 replay of W10's recorded LongMemEval reader prompts (plan GST-605, "Replay"; unit U3): particle-1's first
 * numbers, paired question by question with the committed W10 rows of Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol.
 *
 *   bun eval/runner/batch/w10-particle.ts build [--gbrain-c5fb0201 <checkout>] [--out <dir>]      ($0)
 *   bun eval/runner/batch/w10-particle.ts preflight --out <dir> --paid --budget-run-id <id> [--budget-ledger <path>]
 *   bun eval/runner/batch/w10-particle.ts run <arm> --out <fresh dir> --paid --budget-run-id <id> [--budget-ledger <path>] [--cache <dir>]
 *   bun eval/runner/batch/w10-particle.ts report <replay dir> [--write]                           ($0)
 *
 * build rebuilds every comparator body the replay reads with sources.ts (through w10.ts's arm definitions), checks each
 * against its committed manifest's body_sha256, and checks that the Anthropic-shaped and OpenAI-shaped bodies of each
 * question carry the same system and user text. W10c rendered its whole-history bodies with gbrain c5fb0201; when the
 * pinned gbrain no longer renders them byte for byte, build renders them from a c5fb0201 checkout (--gbrain-c5fb0201)
 * and records that. Only text that passed both checks is saved for run.
 *
 * run sends one arm's saved text to particle-1 through qa-v2's ChatClient and chatWithReceipts (Particle has no batch
 * API), so it inherits their 5-attempt retries, receipts and response cache: a rerun into a fresh --out replays every
 * answer already paid for. Eight questions at a time, a 900-second deadline per attempt, effort and output limit fixed
 * per arm. Every answer is judged with LongMemEval's official prompt on gpt-4o-2024-08-06 (temperature 0, 10 tokens,
 * "yes" in the reply), W10's primary judge, through the same client. An answer cut off at its output limit is scored
 * as the model's answer and never retried; its row records `truncated` and the finish reason. An empty answer is wrong
 * without a judge call. A reader that still fails after its retries is a reader error, wrong. A budget stop (the
 * ledger's, or Particle's credit 402) ends the arm after the failing question's row: no new question starts and the
 * receipt says `stopped`. --out must hold no rows yet, so a rerun of a stopped arm goes to a fresh directory. The
 * receipt checks the preregistered bars 1 to 4 on the arm's particle requests.
 *
 * report re-scores committed rows, keyless: paired differences with 95% intervals through compare.ts, decision G's
 * preregistered family, the development-lane test, decision B's stop rule, cost per correct answer, latency and
 * truncations. With --write it writes summary.json; without, it exits 1 when the committed summary.json differs.
 */
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { budgetOptionsFrom, priceRequest, receiptCost, startPaidRun, usageCost } from '../budget-ledger.ts';
import { runCompare, type CompareOutput } from '../compare.ts';
import { ChatClient, chatWithReceipts, type ChatLike, type ChatResultV2 } from '../memory-qa/qa-v2.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { attestPreregistration } from '../prereg.ts';
import { COMPAT_PROVIDERS } from '../providers/openai-compatible.ts';
import type { UsageReceipt } from '../usage-receipt.ts';
import { bodySha, readManifest, sha256 } from './manifest.ts';
import { crossArmRows } from './receipts.ts';
import { JUDGE_PROTOCOL, judgeVerdict, loadDataset, officialJudgePrompt, readNdjson, readerBody, reportType, type ReaderText, type ReplayRow } from './sources.ts';
import { ARMS, MANIFEST_DIR, r1, subsets } from './w10.ts';
import { scoreArm, type Scored } from './w10-rescore.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const REPLAY_DIR = 'docs/benchmarks/2026-11-01-longmemeval-particle-replay';
export const PREREG = `${REPLAY_DIR}/PREREGISTRATION.md`;
export const FAMILY_G = `${REPLAY_DIR}/families/g-noninferiority.json`;
export const STATE_DIR = process.env.W10_PARTICLE_STATE_DIR ?? join(homedir(), '.capy/work/w10-particle');
const DATASET = process.env.LME_DATASET ?? join(homedir(), '.capy/work/lane-c/data/longmemeval_s_cleaned.json');
const W10A = join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin');
const W10B = join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay');
const W10C = join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context');

export const PARTICLE = 'particle:particle-1';
export const JUDGE = 'openai:gpt-4o-2024-08-06';
export const OUTPUT_LIMIT = 16_000;
export const CONCURRENCY = 8;
export const TIMEOUT_MS = 900_000;
/** The gbrain build W10c rendered its whole-history prompts with (v0.60.95.0). */
export const C5FB0201 = 'c5fb0201d1960a0a5a81c35d77718311b03154b7';
/** Tokens the chat template and reasoning add to a prompt (about 25 in the 2026-10-31 probes), with room to spare. */
const TEMPLATE_MARGIN_TOKENS = 1024;
const PARTICLE_URL = 'https://api.particle.ai/v1/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

type TextSource = 'r1' | 'currentpin' | 'full';

/** Each prompt set the replay reads, from the comparator arms that sent it: one Anthropic-shaped, one OpenAI-shaped, and any other comparator on the same text. */
export const TEXT_SOURCES: Record<TextSource, { anthropic: string; openai: string; also: string[] }> = {
  r1: { anthropic: 'w10b-sonnet55-notes', openai: 'w10b-sol-notes', also: ['w10b-opus55-notes'] },
  currentpin: { anthropic: 'w10a-sonnet55-notes', openai: 'w10c-sol-currentpin', also: [] },
  full: { anthropic: 'w10c-sonnet55-full', openai: 'w10c-sol-full', also: [] },
};

export interface ReplayArm { workstream: 'W10b' | 'W10c'; text: TextSource; effort: 'high' | 'none'; label: string }

export const REPLAY_ARMS: Record<string, ReplayArm> = {
  'w10b-particle-notes': { workstream: 'W10b', text: 'r1', effort: 'high', label: 'R1: the 500 W10b notes prompts, retrieval from gbrain a7cb37b' },
  'w10c-particle-currentpin': { workstream: 'W10c', text: 'currentpin', effort: 'high', label: 'R2: the 150 W10c questions on gbrain c5fb0201 retrieval (W10a capture)' },
  'w10c-particle-full': { workstream: 'W10c', text: 'full', effort: 'high', label: 'R2: the 150 W10c questions with the whole history' },
  'w10c-particle-currentpin-none': { workstream: 'W10c', text: 'currentpin', effort: 'none', label: 'R2: the 150 W10c questions on gbrain c5fb0201 retrieval at effort none (descriptive)' },
};

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const writeJson = (path: string, v: unknown) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(v, null, 1) + '\n'); };
const isBudgetStop = (e: unknown) => (e as Error)?.name === 'BudgetExceededError';
const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

// ─── Build ($0) ─────────────────────────────────────────────────────

/** The system and user text of a W10 reader body, Anthropic-shaped (system plus one user message) or OpenAI-shaped (system and user messages). */
export function readerText(body: Record<string, any>): ReaderText {
  const m = body.messages;
  if (typeof body.system === 'string' && m?.length === 1 && m[0].role === 'user' && typeof m[0].content === 'string') return { system: body.system, user: m[0].content };
  if (m?.length === 2 && m[0].role === 'system' && m[1].role === 'user' && typeof m[0].content === 'string' && typeof m[1].content === 'string') return { system: m[0].content, user: m[1].content };
  throw new Error(`${String(body.model)}: a reader body is either Anthropic-shaped or OpenAI-shaped`);
}

/** W10c's whole-history bodies rendered by the gbrain checkout at `root`: sources.ts's fullHistoryText on that build's own modules. */
async function fullHistoryAt(root: string, model: string): Promise<Map<string, Record<string, unknown>>> {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (head !== C5FB0201) throw new Error(`${root} is at ${head.slice(0, 12)}, not gbrain ${C5FB0201.slice(0, 8)}`);
  const [adapter, sanitize, metrics, reader] = await Promise.all(['adapter', 'sanitize', 'metrics', 'reader'].map(m => import(join(root, `src/eval/longmemeval/${m}.ts`))));
  const notes = reader.resolveReaderConfig({ mode: 'notes' });
  const ds = loadDataset(DATASET);
  return new Map(subsets.w10c150().map(id => {
    const q = ds.get(id)!;
    const sessions = adapter.haystackToPages(q).map((p: { slug: string; content: string }, i: number) => ({ session_id: metrics.sessionIdFromSlug(p.slug), date: q.haystack_dates[i], body: p.content }));
    const { rendered } = sanitize.renderChatBlock(sessions, { maxSessionChars: reader.READER_MAX_SESSION_CHARS });
    const req = reader.buildReaderRequest({ question: q.question, questionDate: q.question_date, rendered }, 'placeholder', notes);
    return [id, readerBody(model, { system: req.system, user: req.messages[0].content })];
  }));
}

/** A comparator arm's bodies rebuilt as it sent them, every one matching the committed manifest's hash, or a refusal. */
async function rehash(arm: string, c5fb0201: string | null): Promise<{ bodies: Map<string, Record<string, unknown>>; record: Record<string, unknown> }> {
  const path = join(MANIFEST_DIR, `${arm}.json`);
  const manifest = readManifest(path);
  const want = new Map(manifest.requests.map(r => [r.question_id, r.body_sha256]));
  const differing = (bodies: Map<string, Record<string, unknown>>) => [...want].filter(([id, sha]) => !bodies.has(id) || bodySha(bodies.get(id)) !== sha).map(([id]) => id);
  let bodies = ARMS[arm].build().bodies;
  const atPin = differing(bodies);
  let renderedWith = 'the pinned gbrain';
  if (atPin.length && arm.startsWith('w10c-') && arm.endsWith('-full')) {
    if (!c5fb0201) throw new Error(`${arm}: ${atPin.length} of ${want.size} whole-history bodies no longer render byte for byte at the pinned gbrain; pass --gbrain-c5fb0201 <a gbrain checkout at ${C5FB0201}>, the build W10c rendered them with`);
    bodies = await fullHistoryAt(c5fb0201, manifest.model);
    renderedWith = `a gbrain ${C5FB0201.slice(0, 8)} checkout: the pinned gbrain renders ${atPin.length} of ${want.size} bodies differently`;
  }
  const bad = differing(bodies);
  if (bad.length || bodies.size !== want.size) throw new Error(`${arm}: ${bad.length} of ${want.size} rebuilt bodies differ from the committed manifest (first ${bad[0] ?? 'an extra id'}); refusing to replay text the comparator did not read`);
  return { bodies, record: { manifest: path.slice(ROOT.length + 1), manifest_sha256: sha256(readFileSync(path)), bodies: want.size, matching: want.size, differing_at_pin: atPin.length, rendered_with: renderedWith } };
}

const inputPath = (source: TextSource) => join(STATE_DIR, 'inputs', `${source}.ndjson.gz`);

/** Re-hash every comparator body, check that both shapes carry one text, and save each prompt set for run. */
export async function build(c5fb0201: string | null): Promise<Record<string, unknown>> {
  const comparators: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const [name, src] of Object.entries(TEXT_SOURCES) as [TextSource, (typeof TEXT_SOURCES)[TextSource]][]) {
    const built = new Map<string, Map<string, Record<string, unknown>>>();
    for (const arm of [src.openai, src.anthropic, ...src.also]) {
      const { bodies, record } = await rehash(arm, c5fb0201);
      built.set(arm, bodies);
      comparators[arm] = record;
    }
    const lines: string[] = [];
    for (const [id, body] of [...built.get(src.openai)!].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const text = readerText(body);
      for (const arm of [src.anthropic, ...src.also]) {
        const other = built.get(arm)!.get(id);
        if (!other) throw new Error(`${name}: ${arm} has no body for ${id}`);
        const t = readerText(other);
        if (t.system !== text.system || t.user !== text.user) throw new Error(`${name}: ${arm} and ${src.openai} carry different text for ${id}`);
      }
      lines.push(JSON.stringify({ question_id: id, ...text }));
    }
    const content = lines.join('\n') + '\n';
    mkdirSync(join(STATE_DIR, 'inputs'), { recursive: true });
    writeFileSync(inputPath(name), gzipSync(content));
    sources[name] = { questions: lines.length, text_sha256: sha256(content), arms: [src.openai, src.anthropic, ...src.also] };
  }
  const record = {
    schema_version: 1, built_at: new Date().toISOString(), gbrain_pin: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies?.gbrain ?? null,
    dataset_sha256: existsSync(DATASET) ? sha256(readFileSync(DATASET)) : null, comparators, sources,
  };
  writeJson(join(STATE_DIR, 'build.json'), record);
  return record;
}

/** One prompt set as build saved it, refused unless it still hashes to the build record. */
export function loadInputs(source: TextSource): Map<string, ReaderText> {
  const record = JSON.parse(readFileSync(join(STATE_DIR, 'build.json'), 'utf8'));
  const content = gunzipSync(readFileSync(inputPath(source))).toString('utf8');
  if (sha256(content) !== record.sources[source].text_sha256) throw new Error(`${inputPath(source)} no longer matches the build record; run build again`);
  return new Map(content.split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return [r.question_id, { system: r.system, user: r.user }]; }));
}

/** UTF-8 bytes bound a byte-level tokenizer's token count, so a prompt whose bytes fit particle-1's window fits it as Particle counts. */
export function assertFitsParticleWindow(id: string, text: ReaderText, outputLimit = OUTPUT_LIMIT): void {
  const context = COMPAT_PROVIDERS.particle.models['particle-1'].context_tokens;
  const bound = Buffer.byteLength(text.system) + Buffer.byteLength(text.user) + TEMPLATE_MARGIN_TOKENS;
  if (bound + outputLimit > context) throw new Error(`${id}: up to ${bound} input and ${outputLimit} output tokens could exceed particle-1's ${context}-token window`);
}

// ─── Run (paid) ─────────────────────────────────────────────────────

/** The ledger's list price for one response's usage: what the budget guard settles. */
export const particleUsd = (usage: unknown) => usageCost(priceRequest(PARTICLE_URL, { model: 'particle-1', messages: [] })!, { usage })?.usd ?? 0;
const judgeUsd = (usage: unknown) => usageCost(priceRequest(OPENAI_URL, { model: JUDGE.slice('openai:'.length), messages: [] })!, { usage })?.usd ?? 0;

export interface Judgment { verdict: boolean | null; raw: string | null; error: string | null; skipped?: string }

export interface ParticleRow {
  question_id: string; question_type: string; arm_id: string; model: string; effort: string; output_limit: number;
  hypothesis: string; finish: string | null; truncated: boolean | null; error: string | null;
  response_model: string | null; response_meta: ChatResultV2['response_meta'] | null; usage: Record<string, unknown> | null;
  usd: number; list_usd: number; judge_usd: number; latency_ms: number | null; from_cache: boolean; reader_attempts: number;
  official: Judgment | null; correct_official: 0 | 1;
}

export interface ReplayResult { rows: ParticleRow[]; receipts: UsageReceipt[]; stopped: string | null; not_run: string[] }

/**
 * Read and judge every question of one arm, eight at a time. A budget stop ends the arm: the failing question keeps its
 * row, questions already reading finish without a judge, and no new question starts. `onRow` sees each row and its
 * receipts as they land.
 */
export async function replayQuestions(opts: {
  client: ChatLike; armId: string; arm: ReplayArm; inputs: Map<string, ReaderText>; questions: Map<string, ReplayRow>;
  concurrency?: number; onRow?: (row: ParticleRow, receipts: UsageReceipt[]) => void;
}): Promise<ReplayResult> {
  const ids = [...opts.inputs.keys()].sort();
  const queue = [...ids];
  const out: ReplayResult = { rows: [], receipts: [], stopped: null, not_run: [] };
  const one = async (id: string) => {
    const text = opts.inputs.get(id)!, q = opts.questions.get(id);
    if (!q) throw new Error(`${id} has no W10 replay row (question, answer, type)`);
    const receipts: UsageReceipt[] = [];
    const ctx = (role: 'reader' | 'judge', model: string) => ({ role, question_id: id, replicate: 0, model, delivered: null });
    const t0 = performance.now();
    let reader: ChatResultV2 | null = null, error: string | null = null;
    try { reader = await chatWithReceipts(opts.client, ctx('reader', PARTICLE), text.user, { maxTokens: OUTPUT_LIMIT, replicate: 0, effort: opts.arm.effort, system: text.system }, receipts); }
    catch (e) { error = message(e); if (isBudgetStop(e)) out.stopped ??= error; }
    const latency = reader && !reader.cached ? Math.round(performance.now() - t0) : null;
    const answer = reader?.text ?? '';
    let official: Judgment | null = null;
    if (reader && answer.trim() === '') official = { verdict: false, raw: null, error: null, skipped: 'empty answer: wrong without a judge call' };
    else if (reader && out.stopped) official = { verdict: null, raw: null, error: 'not judged: the arm stopped' };
    else if (reader) {
      try {
        const j = await chatWithReceipts(opts.client, ctx('judge', JUDGE), officialJudgePrompt(q.question_type, q.question, q.answer, answer, id.includes('_abs')), { maxTokens: 10, replicate: 0, temperature: 0 }, receipts);
        official = { verdict: judgeVerdict(j.text), raw: j.text, error: null };
      } catch (e) { official = { verdict: null, raw: null, error: message(e) }; if (isBudgetStop(e)) out.stopped ??= official.error; }
    }
    const lane = receipts.map(r => ({ ...r, lane: 'w10-particle' }));
    const judgeReceipt = lane.find(r => r.role === 'judge' && r.status === 'ok');
    const usd = reader?.usage ? particleUsd(reader.usage) : 0;
    const row: ParticleRow = {
      question_id: id, question_type: reportType(q), arm_id: opts.armId, model: PARTICLE, effort: opts.arm.effort, output_limit: OUTPUT_LIMIT,
      hypothesis: answer, finish: reader?.finish ?? null, truncated: reader ? reader.finish === 'length' : null, error,
      response_model: reader?.response_model ?? null, response_meta: reader?.response_meta ?? null, usage: reader?.usage ?? null,
      usd, list_usd: usd, judge_usd: judgeReceipt?.usage_raw ? judgeUsd(judgeReceipt.usage_raw) : 0, latency_ms: latency, from_cache: reader?.cached ?? false,
      reader_attempts: lane.filter(r => r.role === 'reader').length, official, correct_official: official?.verdict === true ? 1 : 0,
    };
    out.rows.push(row);
    out.receipts.push(...lane);
    opts.onRow?.(row, lane);
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? CONCURRENCY }, async () => { while (!out.stopped && queue.length) await one(queue.shift()!); }));
  const done = new Set(out.rows.map(r => r.question_id));
  out.not_run = ids.filter(id => !done.has(id));
  return out;
}

export interface LedgerEntryLite { description: string; reserved_usd: number; actual_usd: number | null; status: string }
export interface Bar { pass: boolean; [k: string]: unknown }

/** Preregistered bars 1 to 4 on one arm's particle requests: metering, receipts, truncation and errors. */
export function checkBars(rows: ParticleRow[], receipts: UsageReceipt[], entries: LedgerEntryLite[]): Record<'metering' | 'receipts' | 'truncation' | 'errors', Bar> {
  const sent = receipts.filter(r => r.model === PARTICLE && !r.from_cache);
  const metered = entries.filter(e => e.description.startsWith('particle:'));
  const ledgerUsd = metered.reduce((a, e) => a + (e.actual_usd ?? e.reserved_usd), 0);
  const usageUsd = sent.reduce((a, r) => a + (r.usage_raw ? particleUsd(r.usage_raw) : 0), 0);
  const gap = usageUsd > 0 ? Math.abs(ledgerUsd - usageUsd) / usageUsd : ledgerUsd > 0 ? 1 : 0;
  const unpriced = receipts.filter(r => /not a host the ledger can price|cannot price/.test(r.error ?? '')).length;
  const unsettled = metered.filter(e => e.status !== 'reconciled').length;
  const allNull = (o: object | undefined) => !!o && Object.values(o).every(v => v === null);
  const receiptProblems = sent.filter(r => {
    const req = r.request;
    if (!req || typeof req.effort_sent !== 'string' || typeof req.effort_effective !== 'string' || typeof req.output_limit !== 'number' || !r.status) return true;
    if (r.status === 'ok') return r.response_model !== 'particle-ai/particle-1' || (req.effort_effective !== 'none' && typeof r.usage?.reasoning !== 'number');
    return r.response_model !== null || !allNull(r.response_meta);
  }).length;
  const answered = rows.filter(r => r.truncated !== null);
  const truncated = answered.filter(r => r.truncated).length;
  const failed = rows.filter(r => r.error !== null && !/^budget/.test(r.error)).length;
  return {
    metering: {
      pass: unpriced === 0 && unsettled === 0 && metered.length === sent.length && gap <= 0.02, basis: 'usage fields (Particle offers no balance read by API)',
      particle_requests: sent.length, ledger_entries: metered.length, unsettled, unpriced, ledger_usd: Number(ledgerUsd.toFixed(6)), usage_usd: Number(usageUsd.toFixed(6)), gap: Number(gap.toFixed(6)),
    },
    receipts: { pass: receiptProblems === 0, particle_receipts: sent.length, problems: receiptProblems },
    truncation: { pass: answered.length > 0 && truncated / answered.length <= 0.01, truncated, answered: answered.length, rate: answered.length ? Number((truncated / answered.length).toFixed(4)) : null },
    errors: { pass: rows.length > 0 && failed / rows.length <= 0.02, failed_after_retries: failed, questions: rows.length, rate: rows.length ? Number((failed / rows.length).toFixed(4)) : null },
  };
}

function ledgerEntries(ledgerPath: string, runId: string, participant: string | null): LedgerEntryLite[] {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    return db.query(`SELECT description, reserved_usd, actual_usd, status FROM entries WHERE run_id = ?${participant ? ' AND participant = ?' : ''}`).all(...(participant ? [runId, participant] : [runId])) as LedgerEntryLite[];
  } finally { db.close(); }
}

const quantile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const tally = (xs: (string | null | undefined)[]) => xs.reduce((m, x) => ({ ...m, [String(x)]: (m[String(x)] ?? 0) + 1 }), {} as Record<string, number>);

async function run(armId: string, argv: string[]): Promise<number> {
  const arm = REPLAY_ARMS[armId];
  if (!arm) throw new Error(`unknown arm ${armId}; arms: ${Object.keys(REPLAY_ARMS).join(', ')}`);
  const out = flag(argv, '--out');
  if (!out) throw new Error('pass --out <fresh directory> for the arm\'s rows, receipts and receipt.json');
  if (existsSync(join(out, 'rows.ndjson'))) throw new Error(`${out} already holds rows; a rerun goes to a fresh --out (every row of a rows file counts), and answers already paid for replay from the response cache`);
  const inputs = loadInputs(arm.text);
  for (const [id, text] of inputs) assertFitsParticleWindow(id, text);
  const build = JSON.parse(readFileSync(join(STATE_DIR, 'build.json'), 'utf8'));
  const attestation = attestPreregistration(PREREG, ROOT);
  const estimate = [...inputs.values()].reduce((a, t) => a + ((Buffer.byteLength(t.system) + Buffer.byteLength(t.user)) / 4) * 0.25e-6 + 3000e-6 + 0.001, 0);
  requirePaidArm(argv, { arm: `particle replay ${armId}`, estimateUsd: estimate });
  const { run: budget, guard } = startPaidRun(`w10-particle:${armId}`, { ...budgetOptionsFrom(argv), estimateUsd: estimate });
  mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  let result: ReplayResult;
  try {
    result = await replayQuestions({
      client: new ChatClient(flag(argv, '--cache') ?? join(STATE_DIR, 'cache'), undefined, TIMEOUT_MS), armId, arm, inputs, questions: r1(),
      onRow: (row, receipts) => {
        appendFileSync(join(out, 'rows.ndjson'), JSON.stringify(row) + '\n');
        if (receipts.length) appendFileSync(join(out, 'receipts.ndjson'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n');
        process.stderr.write(`[w10-particle] ${armId} ${row.question_id} ${row.error ? 'error' : row.truncated ? 'truncated' : 'ok'} correct=${row.correct_official}\n`);
      },
    });
  } finally { guard.uninstall(); }
  const summary = budget.close();
  const rows = result.rows;
  const bars = checkBars(rows, result.receipts, ledgerEntries(budget.ledgerPath, budget.runId, budget.participant));
  const latencies = rows.map(r => r.latency_ms).filter((x): x is number => x !== null);
  const usage = rows.map(r => r.usage as Record<string, any> | null).filter((u): u is Record<string, any> => u !== null);
  const sum = (f: (u: Record<string, any>) => number | undefined) => usage.reduce((a, u) => a + (f(u) ?? 0), 0);
  const receipt = {
    schema_version: 1, arm_id: armId, workstream: arm.workstream, label: arm.label, model: PARTICLE, effort: arm.effort, output_limit: OUTPUT_LIMIT, timeout_ms: TIMEOUT_MS, concurrency: CONCURRENCY,
    judge: { model: JUDGE, protocol: JUDGE_PROTOCOL, temperature: 0, max_tokens: 10, verdict: '"yes" in the lowercased reply' },
    text_source: { name: arm.text, ...build.sources[arm.text], comparators: Object.fromEntries(build.sources[arm.text].arms.map((a: string) => [a, build.comparators[a]])) },
    build: { built_at: build.built_at, gbrain_pin: build.gbrain_pin, dataset_sha256: build.dataset_sha256 },
    denominator: inputs.size, attempted: rows.length, not_run: result.not_run, stopped: result.stopped,
    counts: {
      correct_official: rows.reduce((a, r) => a + r.correct_official, 0), reader_errors: rows.filter(r => r.error).length, judge_errors: rows.filter(r => r.official?.error).length,
      empty_answers: rows.filter(r => r.official?.skipped).length, truncated: rows.filter(r => r.truncated).length, finish: tally(rows.map(r => r.finish)), from_cache: rows.filter(r => r.from_cache).length,
    },
    latency_ms: { n: latencies.length, p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
    tokens: { prompt: sum(u => u.prompt_tokens), cached: sum(u => u.prompt_tokens_details?.cached_tokens), completion: sum(u => u.completion_tokens), reasoning: sum(u => u.completion_tokens_details?.reasoning_tokens) },
    reader_list_usd: Number(rows.reduce((a, r) => a + r.list_usd, 0).toFixed(6)), judge_list_usd: Number(rows.reduce((a, r) => a + r.judge_usd, 0).toFixed(6)),
    response_models: tally(rows.map(r => r.response_model)), service_tiers: tally(rows.map(r => r.response_meta?.service_tier)), weight_versions: tally(rows.map(r => r.response_meta?.weight_version)),
    ledger: receiptCost(summary), bars,
    models_not_run: arm.workstream === 'W10c' ? [{ model: 'anthropic:claude-opus-5-5', reason: 'W10c has no Opus 5.5 rows to pair with; this replay calls particle-1 only' }] : [],
    preregistration_attestation: attestation, started_at: startedAt, finished_at: new Date().toISOString(),
  };
  writeJson(join(out, 'receipt.json'), receipt);
  const failedBars = Object.entries(bars).filter(([, b]) => !b.pass).map(([k]) => k);
  console.log(JSON.stringify({ arm: armId, attempted: rows.length, of: inputs.size, correct: receipt.counts.correct_official, truncated: receipt.counts.truncated, stopped: result.stopped, failed_bars: failedBars, ledger_usd: receipt.ledger.usd }));
  return result.stopped || result.not_run.length || failedBars.length ? 1 : 0;
}

/** One small particle-1 request and one one-token judge request, each metered, before an arm's paid step. */
async function preflight(argv: string[]): Promise<number> {
  const out = flag(argv, '--out');
  if (!out) throw new Error('pass --out <dir> for preflight.json');
  requirePaidArm(argv, { arm: 'particle replay preflight', estimateUsd: 0.02 });
  const { run: budget, guard } = startPaidRun('w10-particle:preflight', { ...budgetOptionsFrom(argv), estimateUsd: 0.02 });
  const client = new ChatClient(join(STATE_DIR, `preflight-cache-${Date.now()}`), undefined, TIMEOUT_MS);
  const receipts: UsageReceipt[] = [];
  const results: Record<string, { ok: boolean; [k: string]: unknown }> = {};
  try {
    for (const [role, model, prompt, opts] of [
      ['reader', PARTICLE, 'Reply with the single word: ready', { maxTokens: OUTPUT_LIMIT, replicate: 0, effort: 'none' }],
      ['judge', JUDGE, 'Reply with the single word: yes', { maxTokens: 1, replicate: 0, temperature: 0 }],
    ] as const) {
      const t0 = performance.now();
      try {
        const r = await chatWithReceipts(client, { role, question_id: 'preflight', replicate: 0, model, delivered: null }, prompt, opts, receipts);
        results[model] = { ok: true, text: r.text, finish: r.finish, response_model: r.response_model, usage: r.usage, response_meta: r.response_meta ?? null, latency_ms: Math.round(performance.now() - t0) };
      } catch (e) { results[model] = { ok: false, error: message(e) }; }
    }
  } finally { guard.uninstall(); }
  const cost = receiptCost(budget.close());
  writeJson(join(out, 'preflight.json'), { at: new Date().toISOString(), results, receipts, cost });
  const ok = Object.values(results).every(r => r.ok) && results[PARTICLE]?.response_model === 'particle-ai/particle-1';
  console.log(JSON.stringify({ ok, results, cost_usd: cost.usd }));
  return ok ? 0 : 1;
}

// ─── Report ($0) ────────────────────────────────────────────────────

const col = (rows: Map<string, Scored>, ids: string[]) => new Map(ids.map(id => { const s = rows.get(id); if (!s) throw new Error(`no row for ${id}`); return [id, s.official]; }));

const compact = (d: CompareOutput['decision']) => ({
  family_id: d.family_id, verdict: d.verdict, holm_family: d.holm_family,
  comparisons: d.comparisons.map(c => ({ id: c.id, status: c.status, n_pairs: c.n_pairs, mean_a: c.stats?.mean_a, mean_b: c.stats?.mean_b, delta: c.stats?.delta, ci95: c.stats?.ci95, mcnemar: c.mcnemar, p_noninferiority: c.p_noninferiority, p_holm: c.p_holm, power: c.power?.note })),
});

/** Write the paired files for `fields` (A = comparator, B = the arm under test) and run compare.ts on them: exploratory, or the preregistered family. */
function paired(dir: string, name: string, fields: { field: string; a: Map<string, 0 | 1>; b: Map<string, 0 | 1> }[], ids: string[], family?: string) {
  const { a, b } = crossArmRows(fields.map(f => ({ field: f.field, rows: f.b, comparator: f.a })), ids);
  const pa = join(dir, `compare-${name}-a.ndjson`), pb = join(dir, `compare-${name}-b.ndjson`);
  writeFileSync(pa, a.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(pb, b.map(r => JSON.stringify(r)).join('\n') + '\n');
  return compact(runCompare({ a: pa, b: pb, family, metrics: family ? [] : fields.map(f => f.field), excludeWhen: [], where: [], aWhere: [], bWhere: [], seed: 20261101, draws: 10000, alpha: 0.05, json: true }).decision);
}

/**
 * The preregistered development-lane test: particle-1 passes when its whole-history minus old-retrieval difference has
 * Sonnet 5.5's sign with an interval excluding zero and its agreement with Sonnet 5.5 on the whole history is at most 5
 * points below GPT-6.1 Sol's; it fails on the opposite sign with an interval excluding zero; anything else is inconclusive.
 */
export function devLaneVerdict(x: { delta: number; ci95: [number, number]; sonnetDelta: number; agreeParticle: number; agreeSol: number }): 'pass' | 'fail' | 'inconclusive' {
  const sign = Math.sign(x.sonnetDelta);
  const excludesZero = x.ci95[0] > 0 || x.ci95[1] < 0;
  if (excludesZero && Math.sign(x.delta) === sign && x.agreeParticle >= x.agreeSol - 0.05) return 'pass';
  if (excludesZero && Math.sign(x.delta) === -sign) return 'fail';
  return 'inconclusive';
}

function armStats(dir: string, scored: Map<string, Scored>, ids: string[], batch: boolean) {
  const rows = new Map(readNdjson(join(dir, 'rows.ndjson')).map(r => [r.question_id as string, r]));
  const xs = ids.map(id => rows.get(id)!);
  const s = ids.map(id => scored.get(id)!);
  const correct = s.reduce((a, r) => a + r.official, 0);
  const list = xs.reduce((a, r) => a + (r.list_usd ?? 0), 0);
  const batchUsd = batch ? xs.reduce((a, r) => a + (r.usd ?? 0), 0) : null;
  const lat = xs.map(r => r.latency_ms).filter((v): v is number => typeof v === 'number');
  return {
    n: ids.length, correct, accuracy: Number((correct / ids.length).toFixed(4)), reader_errors: xs.filter(r => r.error).length,
    truncated: xs.filter(r => r.truncated === true || r.finish === 'length' || r.finish === 'max_tokens').length,
    list_usd: Number(list.toFixed(4)), list_usd_per_question: Number((list / ids.length).toFixed(5)), list_usd_per_correct: correct ? Number((list / correct).toFixed(5)) : null,
    batch_usd: batchUsd === null ? null : Number(batchUsd.toFixed(4)), batch_usd_per_correct: batchUsd === null || !correct ? null : Number((batchUsd / correct).toFixed(5)),
    mean_input_tokens: Math.round(s.reduce((a, r) => a + r.input_tokens, 0) / ids.length), mean_output_tokens: Math.round(s.reduce((a, r) => a + r.output_tokens, 0) / ids.length),
    latency_ms: lat.length ? { n: lat.length, p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) } : null,
  };
}

/** Paired differences, decision G, the development-lane test and decision B's stop rule, from committed rows. */
export function report(dir: string): Record<string, unknown> {
  const ids500 = [...r1().keys()].sort(), ids150 = subsets.w10c150();
  const comparators: Record<string, [string, string[]]> = {
    'w10b-opus55-notes': [join(W10B, 'arms/w10b-opus55-notes'), ids500], 'w10b-sonnet55-notes': [join(W10B, 'arms/w10b-sonnet55-notes'), ids500],
    'w10b-sol-notes': [join(W10B, 'arms/w10b-sol-notes'), ids500], 'w10a-sonnet55-notes': [join(W10A, 'arms/w10a-sonnet55-notes'), ids150],
    'w10c-sol-currentpin': [join(W10C, 'arms/w10c-sol-currentpin'), ids150], 'w10c-sonnet55-full': [join(W10C, 'arms/w10c-sonnet55-full'), ids150], 'w10c-sol-full': [join(W10C, 'arms/w10c-sol-full'), ids150],
  };
  const particle = Object.fromEntries(Object.keys(REPLAY_ARMS).filter(id => existsSync(join(dir, 'arms', id, 'rows.ndjson'))).map(id => [id, join(dir, 'arms', id)]));
  const scored = new Map(Object.entries({ ...Object.fromEntries(Object.entries(comparators).map(([k, [p]]) => [k, p])), ...particle }).map(([k, p]) => [k, scoreArm(p)]));
  const c = (name: string, ids: string[]) => col(scored.get(name)!, ids);
  const idsOf = (id: string) => (REPLAY_ARMS[id].workstream === 'W10b' ? ids500 : ids150);
  const arms = Object.fromEntries(Object.entries(particle).map(([id, path]) => {
    const receipt = JSON.parse(readFileSync(join(path, 'receipt.json'), 'utf8'));
    return [id, { ...armStats(path, scored.get(id)!, idsOf(id), false), effort: receipt.effort, stopped: receipt.stopped, not_run: receipt.not_run.length, bars: receipt.bars, ledger_usd: receipt.ledger.usd }];
  }));
  const out: Record<string, unknown> = { kind: 'particle-replay', arms, comparators: Object.fromEntries(Object.entries(comparators).map(([k, [p, ids]]) => [k, armStats(p, scored.get(k)!, ids, true)])) };
  if (particle['w10b-particle-notes']) {
    const p = c('w10b-particle-notes', ids500);
    const w10b = paired(dir, 'w10b', [
      { field: 'correct__particle_minus_opus55', a: c('w10b-opus55-notes', ids500), b: p },
      { field: 'correct__particle_minus_sonnet55', a: c('w10b-sonnet55-notes', ids500), b: p },
      { field: 'correct__particle_minus_sol', a: c('w10b-sol-notes', ids500), b: p },
    ], ids500);
    const opus = w10b.comparisons.find(x => x.id === 'correct__particle_minus_opus55')!;
    out.w10b = w10b;
    out.decision_b = { rule: 'flip when the upper bound of the paired 95% interval for particle-1 minus Opus 5.5 on the 500 W10b questions is below -10 points', delta: opus.delta, ci95: opus.ci95, flip: !!opus.ci95 && opus.ci95[1] < -0.1 };
  }
  if (particle['w10c-particle-currentpin'] && particle['w10c-particle-full']) {
    const pin = c('w10c-particle-currentpin', ids150), full = c('w10c-particle-full', ids150), sonnetFull = c('w10c-sonnet55-full', ids150), solFull = c('w10c-sol-full', ids150);
    out.decision_g = paired(dir, 'g-noninferiority', [
      { field: 'correct__particle_gbrain', a: full, b: pin },
      { field: 'correct__sonnet55_gbrain', a: full, b: c('w10a-sonnet55-notes', ids150) },
    ], ids150, join(ROOT, FAMILY_G));
    const w10c = paired(dir, 'w10c', [
      { field: 'correct__particle_gbrain_minus_particle_full', a: full, b: pin },
      { field: 'correct__particle_full_minus_sonnet55_full', a: sonnetFull, b: full },
      { field: 'correct__particle_full_minus_sol_full', a: solFull, b: full },
      { field: 'correct__particle_gbrain_minus_sonnet55_gbrain', a: c('w10a-sonnet55-notes', ids150), b: pin },
      { field: 'correct__particle_gbrain_minus_sol_gbrain', a: c('w10c-sol-currentpin', ids150), b: pin },
      { field: 'correct__sonnet55_full_minus_old', a: c('w10b-sonnet55-notes', ids150), b: sonnetFull },
      { field: 'correct__sol_full_minus_old', a: c('w10b-sol-notes', ids150), b: solFull },
      ...(particle['w10b-particle-notes'] ? [{ field: 'correct__particle_full_minus_old', a: c('w10b-particle-notes', ids150), b: full }] : []),
      ...(particle['w10c-particle-currentpin-none'] ? [{ field: 'correct__particle_none_minus_high', a: pin, b: c('w10c-particle-currentpin-none', ids150) }] : []),
    ], ids150);
    out.w10c = w10c;
    const get = (id: string) => w10c.comparisons.find(x => x.id === id);
    const dev = get('correct__particle_full_minus_old');
    if (dev?.ci95 && dev.delta !== undefined) {
      const agree = (x: Map<string, 0 | 1>) => Number((ids150.filter(id => x.get(id) === sonnetFull.get(id)).length / ids150.length).toFixed(4));
      const x = { delta: dev.delta, ci95: dev.ci95 as [number, number], sonnetDelta: get('correct__sonnet55_full_minus_old')!.delta!, agreeParticle: agree(full), agreeSol: agree(solFull) };
      out.development_lane = { ...x, verdict: devLaneVerdict(x) };
    }
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === 'build') {
    const record = await build(flag(argv, '--gbrain-c5fb0201') ?? null);
    const out = flag(argv, '--out');
    if (out) writeJson(join(out, 'build.json'), record);
    console.log(JSON.stringify(record, null, 1));
    return 0;
  }
  if (cmd === 'preflight') return preflight(argv);
  if (cmd === 'run') return run(arg, argv);
  if (cmd === 'report') {
    if (!arg) throw new Error('report <replay dir>');
    const text = JSON.stringify(report(resolve(arg)), null, 1) + '\n';
    const path = join(resolve(arg), 'summary.json');
    console.log(text);
    if (argv.includes('--write')) { writeFileSync(path, text); return 0; }
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) { console.error(`re-score differs from ${path}`); return 1; }
    console.error(`re-score matches ${path}`);
    return 0;
  }
  throw new Error('usage: w10-particle.ts build | preflight | run <arm> | report <dir>');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}

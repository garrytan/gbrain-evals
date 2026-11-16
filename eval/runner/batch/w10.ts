#!/usr/bin/env bun
/**
 * W10 LongMemEval answer arms through the batch lane (2026-10 follow-up round).
 *
 *   bun eval/runner/batch/w10.ts build <arm>            freeze the arm's manifest and save its bodies ($0)
 *   bun eval/runner/batch/w10.ts plan <arm>             worst-case reservation at the current factor ($0; counts tokens)
 *   bun eval/runner/batch/w10.ts run <arm>              pilot (first batch of a provider+model) or the rest of the arm
 *   bun eval/runner/batch/w10.ts retry <arm>            resubmit the arm's failed ids once
 *   bun eval/runner/batch/w10.ts judge <arm> official|secondary
 *   bun eval/runner/batch/w10.ts poll                   collect and settle ended batches
 *   bun eval/runner/batch/w10.ts export <arm> <dir>     rows, summary, intents and attestation for the receipts
 *   bun eval/runner/batch/w10.ts status
 *
 * Flags: --budget-ledger <path> (default: the round's ledger), --list-price
 * (allow a full submission at factor 1.0 when no pilot confirmed the batch
 * discount). Workstream caps are the plan's: W10a $28, W10b $107, W10c $50,
 * W8's LongMemEval control $5.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BudgetRun, installPaidRequestGuard, ledgerStatus, readLedger } from '../budget-ledger.ts';
import { attestPreregistration, type Attestation } from '../prereg.ts';
import { buildManifest, freezeManifest, JUDGE_OPUS, JUDGE_SECONDARY, MODEL_SETTINGS, readManifest, sha256, type ArmManifest } from './manifest.ts';
import {
  HOUSE_DIRECT_PROTOCOL, HOUSE_NOTES_PROTOCOL, JUDGE_PROTOCOL, OFFICIAL_PROTOCOL, assertFitsWindow, fullHistoryText, judgeBody, loadDataset, loadReplay,
  officialPromptFromReplay, officialReaderBody, parseSessionBlocks, readNdjson, readerBody, removeSessionBlock, reportType, seededPermutation, seededSample, stratifiedSample,
  swapSessions, type JudgeRole, type Question, type ReaderText, type ReplayRow,
} from './sources.ts';
import { anthropicTransport, openAiTransport } from './transport.ts';
import { BatchLane } from './submit.ts';
import { judgeOutcome, readerRows, scoreRows, summarize, type ReaderRow } from './receipts.ts';
import { sessionIdFromSlug } from '../../../node_modules/gbrain/src/eval/longmemeval/metrics.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const OPAQUE = join(ROOT, 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa');
export const STATE_DIR = process.env.W10_STATE_DIR ?? join(homedir(), '.capy/work/lane-c/w10');
export const MANIFEST_DIR = join(ROOT, 'docs/benchmarks/2026-10-06-longmemeval-w10-manifests');
const DATASET = process.env.LME_DATASET ?? join(homedir(), '.capy/work/lane-c/data/longmemeval_s_cleaned.json');
export const DEFAULT_LEDGER = '/workspace/gbrain-evals/.budget/followups-2026-10.sqlite';
export const SEED = 20261006;
export const PILOT_SIZE = 10;
export const PREREGISTERED_FACTOR = 0.5;

export type Workstream = 'W10a' | 'W10b' | 'W10c' | 'W8-LME' | 'R3';
export const CAPS: Record<Exclude<Workstream, 'R3'>, number> = { W10a: 28, W10b: 107, W10c: 50, 'W8-LME': 5 };
export const PREREG: Record<Workstream, string> = {
  W10a: 'docs/benchmarks/2026-10-06-longmemeval-w10-preregistration.md',
  W10b: 'docs/benchmarks/2026-10-06-longmemeval-w10-preregistration.md',
  W10c: 'docs/benchmarks/2026-10-06-longmemeval-w10-preregistration.md',
  'W8-LME': 'docs/benchmarks/2026-10-06-w8-longmemeval-control-preregistration.md',
  R3: 'docs/benchmarks/2026-10-06-longmemeval-w10-preregistration.md',
};

/**
 * R3, the W10 amendment of 2026-11-16: W10c's comparison re-measured at gbrain's newest release at launch, frozen once
 * its capture starts. Its budget runs are opened outside this file and passed as --budget-run-id, and every paid R3
 * step names the paid window it runs in (--paid-window), so no cap or grant lives in the code.
 */
export const R3_GBRAIN = { version: '0.60.733.0', sha: '6ce7195b44a034f85aec811f11fbf862db376f50' } as const;
export const R3_DIR = join(ROOT, 'docs/benchmarks/2026-11-16-longmemeval-w10-newest');
export const R3_CAPTURE_DIR = join(STATE_DIR, 'r3-capture');
export const R3_UNITS = { capture: 'R3-A', batch: 'R3-B', particle: 'R3-P' } as const;
const PARTICLE_STATE_DIR = process.env.W10_PARTICLE_STATE_DIR ?? join(homedir(), '.capy/work/w10-particle');
/** The whole-history text W10c's two arms and the particle replay read (the replay's build.json, sources.full). */
const W10C_FULL_TEXT_SHA = 'dce4acb7fe76f3b0eb9a69917e2a4c0098a05cb469d2a092ee446c72ea0ad92b';

/** A paid R3 step runs only inside the paid window it names: `--paid-window <unit>` on its command line, or it refuses before any client exists. */
export function requireR3Window(argv: readonly string[], unit: string): void {
  const i = argv.indexOf('--paid-window');
  const named = i >= 0 ? argv[i + 1] : undefined;
  if (named !== unit) throw new Error(`R3 refuses: this step spends money and runs only inside paid window ${unit}; pass --paid-window ${unit} once the window is granted (got ${named ?? 'none'})`);
}

/** The gbrain build node_modules/gbrain holds must be R3's frozen pin: a git checkout at R3_GBRAIN.sha whose package.json names its version. */
export function assertR3Gbrain(root = join(ROOT, 'node_modules/gbrain')): { version: string; sha: string } {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  let sha = '';
  try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { sha = ''; }
  if (version !== R3_GBRAIN.version || sha !== R3_GBRAIN.sha) throw new Error(`R3 runs gbrain v${R3_GBRAIN.version} at ${R3_GBRAIN.sha.slice(0, 8)}; ${root} holds v${version} at ${sha ? sha.slice(0, 8) : 'no git checkout'} (install it by sha: eval/runner/batch/r3-vm-setup.sh)`);
  return { version, sha };
}

/** W10c's whole-history text, saved by `w10-particle.ts build` after it re-hashed both W10c whole-history manifests from a gbrain c5fb0201 checkout. */
function r3FullText(): Map<string, ReaderText> {
  const content = gunzipSync(readFileSync(join(PARTICLE_STATE_DIR, 'inputs', 'full.ndjson.gz'))).toString('utf8');
  if (sha256(content) !== W10C_FULL_TEXT_SHA) throw new Error(`the saved whole-history text hashes to ${sha256(content).slice(0, 12)}, not the ${W10C_FULL_TEXT_SHA.slice(0, 12)} W10c and the particle replay read; run w10-particle.ts build --r3 --gbrain-c5fb0201 <checkout> first`);
  return new Map(content.split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return [r.question_id, { system: r.system, user: r.user }]; }));
}

// ─── Inputs ─────────────────────────────────────────────────────────

let _r1: Map<string, ReplayRow> | null = null, _r2: Map<string, ReplayRow> | null = null, _ds: Map<string, Question> | null = null;
export const r1 = () => (_r1 ??= loadReplay(join(OPAQUE, 'reranker-on/r1')));
export const r2 = () => (_r2 ??= loadReplay(join(OPAQUE, 'reranker-on/r2')));
const dataset = () => (_ds ??= loadDataset(DATASET));
export const types = () => new Map([...r1().values()].map(r => [r.question_id, reportType(r)]));
const allIds = () => [...r1().keys()].sort();

/** Seeded subsets (preregistered). */
export const subsets = {
  fable200: () => seededSample(allIds(), 200, SEED),
  w10c150: () => stratifiedSample(types(), 150, SEED).ids,
  w8100: () => seededSample(allIds().filter(id => !id.endsWith('_abs')), 100, SEED),
  /** The partial fault runs on a seeded 50 of the 100 so its worst case fits W8's $5 share after the swap arm. */
  w8partial50: () => seededSample(seededSample(allIds().filter(id => !id.endsWith('_abs')), 100, SEED), 50, SEED + 2),
};

export const CAPTURE_PATH = join(STATE_DIR, 'w10a-capture/captures.ndjson');

/** Captured reader text by question id (W10a's, or R3's at the newest release): the last capture per question text and date, joined through the harness rows. */
function captures(which: 'w10a' | 'r3' = 'w10a'): Map<string, { system: string; user: string; max_tokens: number; model: string }> {
  const committed = which === 'r3' ? join(R3_DIR, 'capture') : join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/capture');
  const localDir = which === 'r3' ? R3_CAPTURE_DIR : join(STATE_DIR, 'w10a-capture');
  const local = existsSync(join(localDir, 'captures.ndjson'));
  const rows = readNdjson(local ? join(localDir, 'rows.ndjson') : join(committed, 'harness-rows.ndjson.gz')).filter(r => typeof r.question_id === 'string');
  const caps = readNdjson(local ? join(localDir, 'captures.ndjson') : join(committed, 'captures.ndjson.gz'));
  const byKey = new Map(caps.map(c => [`${c.question}\u0000${c.question_date}`, c]));
  const ds = dataset();
  const out = new Map<string, { system: string; user: string; max_tokens: number; model: string }>();
  for (const r of rows) {
    const q = ds.get(r.question_id);
    if (!q) continue;
    const c = byKey.get(`${q.question}\u0000${q.question_date}`);
    if (c) out.set(r.question_id, { system: c.system, user: c.user, max_tokens: c.max_tokens, model: c.model });
  }
  return out;
}

// ─── Arms ───────────────────────────────────────────────────────────

interface Built { bodies: Map<string, Record<string, unknown>>; source: string; protocol: { name: string; sha256: string }; meta?: Record<string, unknown> }
interface ArmDef { id: string; workstream: Workstream; model: string; build: () => Built; /** A preregistered per-arm output limit (amendment) in place of the model's. */ maxOutputTokens?: number }

/** W10 amendment of 2026-10-06: W10a's Sonnet 5.5 arm at 3,500 output tokens so its worst case fits W10a's cap after retrieval. */
export const W10A_MAX_OUTPUT = 3500;

const fromReplay = (replay: () => Map<string, ReplayRow>, model: string, ids?: () => string[]) => (): Map<string, Record<string, unknown>> => {
  const rows = replay();
  return new Map((ids ? ids() : [...rows.keys()]).map(id => [id, readerBody(model, rows.get(id)!)]));
};

const R1_SRC = 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/r1/calls.ndjson.gz (reader lane) joined to r1/rows.ndjson; system and user text unchanged';
const R2_SRC = 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/r2/calls.ndjson.gz (reader lane) joined to r2/rows.ndjson; system and user text unchanged';

/** W8: for each question, the first donor in a seeded order whose retrieved sessions hold none of the question's answer sessions and none of its answer text. */
export function swapDonors(ids: string[], rows: Map<string, ReplayRow>, seed = SEED): Map<string, string> {
  const shuffled = seededPermutation(ids, seed + 1);
  const out = new Map<string, string>();
  ids.forEach((id, k) => {
    const q = rows.get(id)!;
    const answer = String(q.answer).toLowerCase();
    for (let step = 1; step < shuffled.length; step++) {
      const donorId = shuffled[(k + step) % shuffled.length];
      if (donorId === id) continue;
      const donor = rows.get(donorId)!;
      if (donor.retrieved_session_ids.some(s => q.answer_session_ids.includes(s))) continue;
      const blocks = donor.user.slice(donor.user.indexOf('Retrieved sessions:\n')).toLowerCase();
      if (answer.length >= 3 && blocks.includes(answer)) continue;
      out.set(id, donorId);
      return;
    }
    throw new Error(`no valid swap donor for ${id}`);
  });
  return out;
}

/** W8 partial fault: the top-ranked retrieved gold session's opaque id, or null when no gold session reached the reader. */
export function topGoldSession(row: ReplayRow): string | null {
  const shown = new Set(parseSessionBlocks(row.user).map(b => b.id));
  for (const r of [...row.retrieved].sort((a, b) => a.rank - b.rank)) {
    const id = sessionIdFromSlug(r.slug);
    if (row.answer_session_ids.includes(r.session_id) && shown.has(id)) return id;
  }
  return null;
}

export const ARMS: Record<string, ArmDef> = Object.fromEntries(([
  { id: 'w10b-sonnet55-notes', workstream: 'W10b', model: 'claude-sonnet-5-5', build: () => ({ bodies: fromReplay(r1, 'claude-sonnet-5-5')(), source: R1_SRC, protocol: HOUSE_NOTES_PROTOCOL }) },
  { id: 'w10b-sonnet55-direct', workstream: 'W10b', model: 'claude-sonnet-5-5', build: () => ({ bodies: fromReplay(r2, 'claude-sonnet-5-5')(), source: R2_SRC, protocol: HOUSE_DIRECT_PROTOCOL }) },
  { id: 'w10b-sol-notes', workstream: 'W10b', model: 'gpt-6.1-sol', build: () => ({ bodies: fromReplay(r1, 'gpt-6.1-sol')(), source: R1_SRC, protocol: HOUSE_NOTES_PROTOCOL }) },
  {
    id: 'w10b-gpt54-official', workstream: 'W10b', model: 'gpt-5.4', build: () => {
      const ds = dataset();
      const bodies = new Map<string, Record<string, unknown>>();
      for (const row of r1().values()) bodies.set(row.question_id, officialReaderBody('gpt-5.4', officialPromptFromReplay(row, ds.get(row.question_id)!).prompt));
      return { bodies, source: `LongMemEval official run_generation.py prompt (con, json history) over the sessions R1's house reader saw (parsed from ${R1_SRC.split(' (')[0]}, mapped to raw ids through r1/rows.ndjson), dataset sha256 d6f21ea9`, protocol: OFFICIAL_PROTOCOL };
    },
  },
  { id: 'w10b-opus55-notes', workstream: 'W10b', model: 'claude-opus-5-5', build: () => ({ bodies: fromReplay(r1, 'claude-opus-5-5')(), source: R1_SRC, protocol: HOUSE_NOTES_PROTOCOL }) },
  { id: 'w10b-fable51-notes', workstream: 'W10b', model: 'claude-fable-5-1', build: () => ({ bodies: fromReplay(r1, 'claude-fable-5-1', subsets.fable200)(), source: `${R1_SRC}; seeded 200-question subset (seed ${SEED})`, protocol: HOUSE_NOTES_PROTOCOL }) },
  {
    id: 'w10a-sonnet55-notes', workstream: 'W10a', model: 'claude-sonnet-5-5', maxOutputTokens: W10A_MAX_OUTPUT, build: () => {
      const caps = captures();
      return { bodies: new Map(allIds().filter(id => caps.has(id)).map(id => [id, readerBody('claude-sonnet-5-5', caps.get(id)!, W10A_MAX_OUTPUT, W10A_MAX_OUTPUT)])), source: 'W10a stub-reader capture of gbrain eval longmemeval at c5fb0201 (release retrieval); system and user text unchanged', protocol: HOUSE_NOTES_PROTOCOL };
    },
  },
  {
    id: 'w10c-sol-currentpin', workstream: 'W10c', model: 'gpt-6.1-sol', build: () => {
      const caps = captures();
      return { bodies: new Map(subsets.w10c150().filter(id => caps.has(id)).map(id => [id, readerBody('gpt-6.1-sol', caps.get(id)!)])), source: `W10a capture at c5fb0201, W10c's 150-question stratified subset (seed ${SEED})`, protocol: HOUSE_NOTES_PROTOCOL };
    },
  },
  ...(['claude-sonnet-5-5', 'gpt-6.1-sol'] as const).map(model => ({
    id: `w10c-${model === 'gpt-6.1-sol' ? 'sol' : 'sonnet55'}-full`, workstream: 'W10c' as const, model, build: () => {
      const ds = dataset();
      const bodies = new Map<string, Record<string, unknown>>();
      const meta: Record<string, unknown> = {};
      for (const id of subsets.w10c150()) {
        const full = fullHistoryText(ds.get(id)!);
        if (full.user.includes('answer_')) throw new Error(`${id}: full-history prompt carries an answer_ id`);
        bodies.set(id, readerBody(model, full));
        meta[id] = { sessions: full.sessions, truncated: full.truncated, chars: full.chars };
      }
      return { bodies, source: `full haystack in the house notes prompt (gbrain c5fb0201 haystackToPages + renderChatBlock at 60,000 chars per session + buildReaderRequest), W10c 150-question stratified subset (seed ${SEED}), dataset sha256 d6f21ea9`, protocol: HOUSE_NOTES_PROTOCOL, meta };
    },
  })),
  ...(['claude-opus-5-5', 'gpt-6.1-sol'] as const).map(model => ({
    id: `r3-${model === 'gpt-6.1-sol' ? 'sol' : 'opus55'}-newest`, workstream: 'R3' as const, model, build: () => {
      const caps = captures('r3');
      const ids = subsets.w10c150();
      const missing = ids.filter(id => !caps.has(id));
      if (missing.length) throw new Error(`R3 capture has no reader request for ${missing.length} of the 150 questions (first ${missing[0]}); resume the capture before building`);
      return { bodies: new Map(ids.map(id => [id, readerBody(model, caps.get(id)!)])), source: `R3 stub-reader capture of gbrain eval longmemeval at ${R3_GBRAIN.sha.slice(0, 8)} (v${R3_GBRAIN.version}, release retrieval), W10c's 150-question stratified subset (seed ${SEED}); system and user text unchanged`, protocol: HOUSE_NOTES_PROTOCOL };
    },
  })),
  {
    id: 'r3-opus55-full', workstream: 'R3', model: 'claude-opus-5-5', build: () => {
      const text = r3FullText();
      return { bodies: new Map(subsets.w10c150().map(id => [id, readerBody('claude-opus-5-5', text.get(id)!)])), source: `W10c's whole-history text exactly as w10c-sonnet55-full and w10c-sol-full sent it (gbrain c5fb0201 rendering, text sha256 ${W10C_FULL_TEXT_SHA.slice(0, 8)}, re-hashed against both committed manifests by w10-particle.ts build), W10c 150-question stratified subset (seed ${SEED})`, protocol: HOUSE_NOTES_PROTOCOL };
    },
  },
  {
    id: 'w8-lme-swap', workstream: 'W8-LME', model: 'claude-sonnet-5-5', build: () => {
      const rows = r1();
      const ids = subsets.w8100();
      const donors = swapDonors(ids, rows);
      return {
        bodies: new Map(ids.map(id => [id, readerBody('claude-sonnet-5-5', { system: rows.get(id)!.system, user: swapSessions(rows.get(id)!.user, rows.get(donors.get(id)!)!.user) })])),
        source: `${R1_SRC}; each question's retrieved sessions replaced by a donor question's (seeded, answer sessions and answer text excluded); 100 answerable questions (seed ${SEED})`,
        protocol: HOUSE_NOTES_PROTOCOL, meta: Object.fromEntries(donors),
      };
    },
  },
  {
    id: 'w8-lme-partial', workstream: 'W8-LME', model: 'claude-sonnet-5-5', build: () => {
      const rows = r1();
      const bodies = new Map<string, Record<string, unknown>>();
      const meta: Record<string, unknown> = {};
      for (const id of subsets.w8partial50()) {
        const gold = topGoldSession(rows.get(id)!);
        meta[id] = gold ?? 'not applicable: no gold session reached the reader';
        if (gold) bodies.set(id, readerBody('claude-sonnet-5-5', { system: rows.get(id)!.system, user: removeSessionBlock(rows.get(id)!.user, gold) }));
      }
      return { bodies, source: `${R1_SRC}; the top-ranked retrieved gold session removed from the reader text where one was shown (W8 partial fault, report-only), seeded 50 of the control's 100 questions (seed ${SEED + 2})`, protocol: HOUSE_NOTES_PROTOCOL, meta };
    },
  },
] as ArmDef[]).map(a => [a.id, a]));

// ─── State ──────────────────────────────────────────────────────────

const jsonFile = <T>(path: string, fallback: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const writeJson = (path: string, v: unknown) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(v, null, 1) + '\n'); };
const bodiesPath = (arm: string) => join(STATE_DIR, 'bodies', `${arm}.ndjson.gz`);
const manifestPath = (arm: string) => join(MANIFEST_DIR, `${arm}.json`);

function saveBodies(arm: string, bodies: Map<string, Record<string, unknown>>) {
  mkdirSync(join(STATE_DIR, 'bodies'), { recursive: true });
  writeFileSync(bodiesPath(arm), gzipSync([...bodies].map(([question_id, body]) => JSON.stringify({ question_id, body })).join('\n') + '\n'));
}
function loadBodies(arm: string): Map<string, Record<string, unknown>> {
  if (!existsSync(bodiesPath(arm))) throw new Error(`no saved bodies for ${arm}; run \`build ${arm}\` first`);
  return new Map(readNdjson(bodiesPath(arm)).map(r => [r.question_id as string, r.body as Record<string, unknown>]));
}

function workstreamOf(arm: string): Workstream {
  const [base, role] = arm.split('--');
  if (base.startsWith('r3-') || role === 'opus') return 'R3';
  if (ARMS[base]) return ARMS[base].workstream;
  if (base === 'r1-sonnet46' || base === 'r2-sonnet46') return 'W10b';
  throw new Error(`unknown arm ${arm}`);
}

export function attest(ws: Workstream): Attestation {
  const path = join(STATE_DIR, 'attestations.json');
  const all = jsonFile<Record<string, Attestation>>(path, {});
  if (!all[ws]) {
    all[ws] = attestPreregistration(PREREG[ws], ROOT);
    writeJson(path, all);
  }
  return all[ws];
}

export function budgetRun(ws: Workstream, ledgerPath: string, r3RunId?: string): BudgetRun {
  const path = join(STATE_DIR, 'runs.json');
  const runs = jsonFile<Record<string, string>>(path, {});
  if (ws === 'R3') {
    const runId = r3RunId ?? runs[ws];
    if (!runId) throw new Error('R3 joins a budget run opened for it outside this file: pass --budget-run-id <id>');
    if (runs[ws] && runs[ws] !== runId) throw new Error(`R3's batch lane already settles against budget run ${runs[ws]}; pass that id`);
    const run = BudgetRun.join({ runId, ledgerPath });
    if (!runs[ws]) { runs[ws] = runId; writeJson(path, runs); }
    return run;
  }
  if (runs[ws]) return BudgetRun.join({ runId: runs[ws], ledgerPath });
  const run = BudgetRun.open({ runner: `${ws.toLowerCase()}-batch`, budgetUsd: CAPS[ws], ledgerPath });
  runs[ws] = run.runId;
  writeJson(path, runs);
  return run;
}

function lane(run: BudgetRun): BatchLane {
  return new BatchLane({ statePath: join(STATE_DIR, 'batch-state.sqlite'), transports: { openai: openAiTransport(), anthropic: anthropicTransport() }, run });
}

// ─── Judges ─────────────────────────────────────────────────────────

/**
 * Committed reader rows an R3 judge grades without calling their reader again: W10c's GPT-6.1 Sol rows (the reused whole
 * history and the c5fb0201 retrieval of the old-build pair) and R3's particle-1 rows, with the reader family that rules
 * out its own family's judge.
 */
export const STORED_ROWS: Record<string, { path: string; family: 'claude' | 'gpt' | 'particle' }> = {
  'w10c-sol-full': { path: 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms/w10c-sol-full/rows.ndjson', family: 'gpt' },
  'w10c-sol-currentpin': { path: 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms/w10c-sol-currentpin/rows.ndjson', family: 'gpt' },
  'r3-particle-newest': { path: 'docs/benchmarks/2026-11-16-longmemeval-w10-newest/arms/r3-particle-newest/rows.ndjson', family: 'particle' },
  'r3-particle-full': { path: 'docs/benchmarks/2026-11-16-longmemeval-w10-newest/arms/r3-particle-full/rows.ndjson', family: 'particle' },
  'r3-particle-currentpin': { path: 'docs/benchmarks/2026-11-16-longmemeval-w10-newest/arms/r3-particle-currentpin/rows.ndjson', family: 'particle' },
};

/** The family of the reader whose rows a judge would grade; R3 refuses a judge of the same family (R78). */
export function readerFamily(base: string): 'claude' | 'gpt' | 'particle' {
  if (STORED_ROWS[base]) return STORED_ROWS[base].family;
  const model = ARMS[base]?.model ?? '';
  return model.startsWith('claude-') ? 'claude' : 'gpt';
}

/** R3 judges only rows from another family: Opus grades GPT readers' rows, gpt-6.1-sol grades Claude and particle-1 rows. */
export function assertCrossFamily(base: string, role: JudgeRole): void {
  const family = readerFamily(base);
  if (role === 'opus' && family === 'claude') throw new Error(`${base}: claude-opus-5-5 never judges a Claude reader's rows`);
  if (role === 'secondary' && workstreamOf(base) === 'R3' && family === 'gpt') throw new Error(`${base}: gpt-6.1-sol never judges a GPT reader's rows in R3`);
}

/** Reader rows of an arm (or the replayed Sonnet 4.6 baseline) that a judge should see: every row without a reader error. */
function rowsToJudge(base: string, l: BatchLane, role: JudgeRole = 'official'): { question_id: string; hypothesis: string }[] {
  const stored = STORED_ROWS[base];
  if (stored && (role === 'opus' || base.startsWith('r3-'))) {
    return readNdjson(join(ROOT, stored.path)).filter(r => !r.error && typeof r.hypothesis === 'string' && r.hypothesis.trim() !== '').map(r => ({ question_id: r.question_id, hypothesis: r.hypothesis }));
  }
  if (base === 'r1-sonnet46' || base === 'r2-sonnet46') {
    const replay = base === 'r1-sonnet46' ? r1() : r2();
    return [...replay.values()].filter(r => r.baseline.hypothesis).map(r => ({ question_id: r.question_id, hypothesis: r.baseline.hypothesis }));
  }
  const manifest = readManifest(manifestPath(base));
  const open = l.intents({ arm_id: base, states: ['prepared', 'sending', 'submitted', 'ended', 'unknown'] });
  if (open.length) throw new Error(`${base} still has an open batch; poll until it settles before judging`);
  return readerRows(manifest, l.results(base), types()).filter(r => !r.error);
}

function buildJudge(base: string, role: JudgeRole, l: BatchLane): { manifest: ArmManifest; bodies: Map<string, Record<string, unknown>> } {
  if (workstreamOf(`${base}--${role}`) === 'R3') assertCrossFamily(base, role);
  const rows = rowsToJudge(base, l, role);
  const r = r1();
  const bodies = new Map(rows.map(x => [x.question_id, judgeBody(role, r.get(x.question_id)!, x.hypothesis)]));
  const judge = role === 'official' ? { model: 'gpt-4o-2024-08-06', effort: null, max_output_tokens: 10 } : role === 'opus' ? JUDGE_OPUS : JUDGE_SECONDARY;
  const label = role === 'official' ? 'primary (official gpt-4o-2024-08-06, temperature 0, 10 tokens)' : role === 'opus' ? 'R3 co-judge (claude-opus-5-5, low effort, 2,000 tokens)' : 'secondary (gpt-6.1-sol, low effort, 2,000 tokens)';
  const manifest = buildManifest({
    arm_id: `${base}--${role}`, workstream: workstreamOf(`${base}--${role}`), kind: 'judge', provider: role === 'opus' ? 'anthropic' : 'openai', model: judge.model,
    max_output_tokens: judge.max_output_tokens, reasoning_effort: judge.effort,
    protocol: JUDGE_PROTOCOL, source: `${label} judge over ${base}'s rows without a reader error${STORED_ROWS[base] && (role === 'opus' || base.startsWith('r3-')) ? ` (committed rows, ${STORED_ROWS[base].path})` : ''}`,
    denominator: bodies.size, bodies, ...(role === 'official' ? {} : { outputFloor: judge.max_output_tokens }),
  });
  return { manifest, bodies };
}

// ─── Commands ───────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function submitArm(l: BatchLane, manifest: ArmManifest, bodies: Map<string, Record<string, unknown>>, run: BudgetRun, listPrice: boolean, retry = false) {
  const known = l.factorFor(manifest.provider, manifest.model);
  const pending = l.failedQuestionIds(manifest);
  if (!pending.length) { console.log(JSON.stringify({ arm: manifest.arm_id, note: 'nothing left to submit' })); return; }
  const triedBefore = new Set(l.intents({ arm_id: manifest.arm_id }).filter(i => i.state === 'settled').flatMap(i => i.items.map(x => x.question_id)));
  if (!retry && pending.some(q => triedBefore.has(q))) throw new Error(`${manifest.arm_id}: some pending ids already had an attempt; use \`retry\` (one resubmission of failed ids, preregistered)`);
  if (retry && pending.some(q => l.intents({ arm_id: manifest.arm_id }).filter(i => i.items.some(x => x.question_id === q)).length >= 2)) throw new Error(`${manifest.arm_id}: the preregistered single retry is used up for some ids`);
  const pilotIds = known.confirmed ? null : pilotSelection(manifest);
  const ids = pilotIds ?? pending;
  const plan = await l.plan(manifest, bodies, { questionIds: ids, pilot: Boolean(pilotIds) });
  const status = ledgerStatus({ ledgerPath: run.ledgerPath, runId: run.runId });
  const runLeft = status.run ? status.run.remaining_usd : run.budgetUsd;
  const programLeft = status.totals.remaining_usd ?? 0;
  console.error(`[w10] ${manifest.arm_id}: ${pilotIds ? 'pilot' : retry ? 'retry' : 'full'} batch of ${ids.length}: worst case $${plan.reserve_usd.toFixed(2)} at factor ${plan.factor}; workstream left $${runLeft.toFixed(2)}, program left $${programLeft.toFixed(2)}`);
  if (plan.reserve_usd > runLeft || plan.reserve_usd > programLeft) throw new Error(`${manifest.arm_id}: worst case $${plan.reserve_usd.toFixed(2)} does not fit (start-only-if-fits rule)`);
  const intent = await l.submit(manifest, bodies, { questionIds: ids, pilot: Boolean(pilotIds), ...(pilotIds || listPrice ? {} : { requireFactor: PREREGISTERED_FACTOR }) });
  console.log(JSON.stringify({ arm: manifest.arm_id, intent: intent.intent_id, batch: intent.batch_id, requests: intent.items.length, reserved_usd: intent.reserved_usd, factor: intent.factor, pilot: intent.pilot }));
}

/** The pilot: the first 10 questions of the committed pilot20 list that are in the arm, topped up from the arm's sorted ids. */
function pilotSelection(manifest: ArmManifest): string[] {
  const inArm = new Set(manifest.requests.map(r => r.question_id));
  const listed = readFileSync(join(OPAQUE, 'pilot20.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')).filter(id => inArm.has(id));
  const rest = [...inArm].sort().filter(id => !listed.includes(id));
  return [...listed, ...rest].slice(0, PILOT_SIZE);
}

export function exportArm(l: BatchLane, arm: string, dir: string): Record<string, unknown> {
  const manifest = readManifest(manifestPath(arm));
  const t = types();
  const rows = readerRows(manifest, l.results(arm), t);
  const judge = (role: string) => (existsSync(manifestPath(`${arm}--${role}`)) ? l.results(`${arm}--${role}`) : null);
  const official = judge('official') ?? new Map();
  const secondary = judge('secondary');
  const opus = judge('opus');
  const scored = scoreRows(rows, official, secondary);
  const byOpus = opus ? scoreRows(rows, official, opus) : null;
  const summary = { ...summarize(manifest, rows, scored), ...(byOpus ? { correct_opus: byOpus.reduce((a, s) => a + (s.correct_secondary ?? 0), 0) } : {}) };
  const intents = [arm, `${arm}--official`, `${arm}--secondary`, `${arm}--opus`].flatMap(a => l.intents({ arm_id: a })).map(i => ({ ...i, items: i.items.map(x => ({ question_id: x.question_id, custom_id: x.custom_id, input_tokens: x.input_tokens, worst_list_usd: x.worst_list_usd })) }));
  const factors = [...new Set(intents.map(i => `${i.provider}:${i.model}`))].map(k => { const [p, m] = k.split(':'); return l.factorFor(p as 'openai', m); });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rows.ndjson'), rows.map((r: ReaderRow, k) => JSON.stringify({ ...r, official: scored[k].official, secondary: scored[k].secondary, correct_official: scored[k].correct_official, correct_secondary: scored[k].correct_secondary, ...(byOpus ? { opus: byOpus[k].secondary, correct_opus: byOpus[k].correct_secondary } : {}) })).join('\n') + '\n');
  const receipt = {
    schema_version: 1, arm_id: arm, workstream: manifest.workstream, model: manifest.model, manifest: `docs/benchmarks/2026-10-06-longmemeval-w10-manifests/${arm}.json`, manifest_sha256: sha256(readFileSync(manifestPath(arm))),
    summary, intents, factors, preregistration_attestation: jsonFile<Record<string, Attestation>>(join(STATE_DIR, 'attestations.json'), {})[manifest.workstream] ?? null,
  };
  writeJson(join(dir, 'receipt.json'), receipt);
  return receipt;
}

async function main(argv: string[]) {
  const [cmd, arm, extra] = argv;
  const ledgerPath = flag(argv, '--budget-ledger') ?? DEFAULT_LEDGER;
  if (cmd === 'build') {
    const def = ARMS[arm];
    if (!def) throw new Error(`unknown arm ${arm}; arms: ${Object.keys(ARMS).join(', ')}`);
    const built = def.build();
    const s = MODEL_SETTINGS[def.model];
    const manifest = buildManifest({ arm_id: def.id, workstream: def.workstream, kind: 'reader', provider: s.provider, model: def.model, max_output_tokens: def.maxOutputTokens ?? s.max_output_tokens, reasoning_effort: s.effort, protocol: built.protocol, source: built.source, denominator: built.bodies.size, bodies: built.bodies, ...(def.maxOutputTokens ? { outputFloor: def.maxOutputTokens } : {}) });
    for (const body of built.bodies.values()) if (JSON.stringify(body).includes('answer_')) throw new Error(`${arm}: a request body carries an answer_ session id`);
    freezeManifest(manifestPath(arm), manifest);
    saveBodies(arm, built.bodies);
    if (built.meta) writeJson(join(MANIFEST_DIR, `${arm}.meta.json`), built.meta);
    console.log(JSON.stringify({ arm, requests: manifest.requests.length, manifest: manifestPath(arm) }));
    return;
  }
  if (cmd === 'status') {
    console.log(JSON.stringify({ ledger: ledgerStatus({ ledgerPath }).totals, runs: jsonFile(join(STATE_DIR, 'runs.json'), {}) }, null, 1));
    const first = Object.values(jsonFile<Record<string, string>>(join(STATE_DIR, 'runs.json'), {}))[0];
    if (!first) return;
    const l = lane({ runId: first, ledgerPath } as unknown as BudgetRun);
    for (const i of l.intents()) console.log(`${i.intent_id} ${i.arm_id} ${i.state} ${i.batch_id ?? ''} n=${i.items.length} reserved=$${i.reserved_usd.toFixed(4)} settled=${i.settled_usd === null ? '-' : `$${i.settled_usd.toFixed(4)}`} factor=${i.factor}${i.note ? ` (${i.note})` : ''}`);
    return;
  }
  const ws = cmd === 'poll' ? null : workstreamOf(cmd === 'judge' && extra ? `${arm}--${extra}` : arm);
  if (cmd === 'poll') {
    const runs = jsonFile<Record<string, string>>(join(STATE_DIR, 'runs.json'), {});
    const first = Object.values(runs)[0];
    if (!first) throw new Error('no budget run yet');
    const run = BudgetRun.join({ runId: first, ledgerPath });
    const guard = installPaidRequestGuard(run);
    try {
      for (const o of await lane(run).poll()) console.log(JSON.stringify(o));
    } finally { guard.uninstall(); }
    return;
  }
  if (cmd === 'plan') {
    const l = lane({ runId: 'plan-only', ledgerPath } as unknown as BudgetRun);
    const manifest = readManifest(manifestPath(arm));
    const bodies = loadBodies(arm);
    const p = await l.plan(manifest, bodies);
    const atBatch = p.list_worst_usd * PREREGISTERED_FACTOR;
    if (ARMS[arm]?.workstream === 'W10c' || arm === 'r3-opus55-full') for (const [q, b] of bodies) {
      const sha = manifest.requests.find(r => r.question_id === q)!.body_sha256;
      assertFitsWindow(manifest.model, q, await l.inputTokens(manifest.provider, sha, b), manifest.max_output_tokens);
    }
    const ws = workstreamOf(arm);
    console.log(JSON.stringify({ arm, ...p, worst_at_batch_factor_usd: atBatch, ...(ws === 'R3' ? {} : { cap_usd: CAPS[ws] }) }));
    return;
  }
  if (ws === 'R3' && cmd !== 'export' && cmd !== 'export-judge') requireR3Window(argv, R3_UNITS.batch);
  const att = attest(ws!);
  const run = budgetRun(ws!, ledgerPath, flag(argv, '--budget-run-id'));
  const guard = installPaidRequestGuard(run);
  try {
    const l = lane(run);
    if (cmd === 'run' || cmd === 'retry') {
      if ((arm.startsWith('w10c-') || arm.startsWith('r3-')) && arm.endsWith('-full')) {
        const manifest = readManifest(manifestPath(arm));
        for (const [q, b] of loadBodies(arm)) assertFitsWindow(manifest.model, q, await l.inputTokens(manifest.provider, manifest.requests.find(r => r.question_id === q)!.body_sha256, b), manifest.max_output_tokens);
      }
      await submitArm(l, readManifest(manifestPath(arm)), loadBodies(arm), run, argv.includes('--list-price'), cmd === 'retry');
    } else if (cmd === 'judge') {
      if (extra !== 'official' && extra !== 'secondary' && extra !== 'opus') throw new Error('judge role must be official, secondary or opus');
      const id = `${arm}--${extra}`;
      let manifest: ArmManifest, bodies: Map<string, Record<string, unknown>>;
      if (existsSync(manifestPath(id))) { manifest = readManifest(manifestPath(id)); bodies = loadBodies(id); }
      else { ({ manifest, bodies } = buildJudge(arm, extra, l)); freezeManifest(manifestPath(id), manifest); saveBodies(id, bodies); }
      await submitArm(l, manifest, bodies, run, argv.includes('--list-price'), argv.includes('--retry'));
    } else if (cmd === 'export-baseline') {
      if (!extra || (arm !== 'r1-sonnet46' && arm !== 'r2-sonnet46')) throw new Error('export-baseline r1-sonnet46|r2-sonnet46 <dir>');
      const res = l.results(`${arm}--secondary`);
      mkdirSync(resolve(extra), { recursive: true });
      const replay = arm === 'r1-sonnet46' ? r1() : r2();
      const lines = [...replay.keys()].sort().map(id => { const j = judgeOutcome(res.get(id)); return JSON.stringify({ question_id: id, secondary: j, correct_secondary: j.verdict === true ? 1 : 0 }); });
      writeFileSync(join(resolve(extra), 'rows.ndjson'), lines.join('\n') + '\n');
      writeJson(join(resolve(extra), 'receipt.json'), { arm_id: `${arm}--secondary`, manifest_sha256: sha256(readFileSync(manifestPath(`${arm}--secondary`))), intents: l.intents({ arm_id: `${arm}--secondary` }).map(i => ({ ...i, items: i.items.length })), preregistration_attestation: att });
    } else if (cmd === 'export-judge') {
      const [base, role] = arm.split('--');
      if (!extra || !STORED_ROWS[base] || !role) throw new Error('export-judge <stored arm>--<role> <dir>: a judge over committed rows (STORED_ROWS)');
      const res = l.results(arm);
      const ids = readManifest(manifestPath(arm)).requests.map(r => r.question_id);
      mkdirSync(resolve(extra), { recursive: true });
      writeFileSync(join(resolve(extra), 'rows.ndjson'), ids.map(id => { const j = judgeOutcome(res.get(id)); return JSON.stringify({ question_id: id, judge: j, correct: j.verdict === true ? 1 : 0 }); }).join('\n') + '\n');
      writeJson(join(resolve(extra), 'receipt.json'), { arm_id: arm, manifest: `docs/benchmarks/2026-10-06-longmemeval-w10-manifests/${arm}.json`, manifest_sha256: sha256(readFileSync(manifestPath(arm))), intents: l.intents({ arm_id: arm }).map(i => ({ ...i, items: i.items.length })), preregistration_attestation: att });
    } else if (cmd === 'export') {
      if (!extra) throw new Error('export needs an output directory');
      const receipt = exportArm(l, arm, resolve(extra));
      console.log(JSON.stringify((receipt as { summary: unknown }).summary, null, 1));
    } else throw new Error(`unknown command ${cmd}`);
    void att;
  } finally {
    guard.uninstall();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}

export { readLedger };

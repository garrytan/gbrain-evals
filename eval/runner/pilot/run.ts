#!/usr/bin/env bun
/**
 * Wave 1 architecture pilot driver (10x memory advantage plan, A4 and A5):
 * a replay over the frozen W10a captures, so every arm reads identical
 * evidence. Stages run in order and resume from their state files.
 *
 *   bun eval/runner/pilot/run.ts split                     the pilot/confirm split ($0)
 *   bun eval/runner/pilot/run.ts smoke                     2-question keyless smoke of every arm ($0, scripted provider)
 *   bun eval/runner/pilot/run.ts build  <paid flags>       brief and digest builders (cheap models)
 *   bun eval/runner/pilot/run.ts read   <paid flags> [--cells a,b] [--only <regex>]
 *   bun eval/runner/pilot/run.ts judge  <paid flags>       official LongMemEval judge (gpt-4o-2024-08-06)
 *   bun eval/runner/pilot/run.ts label  <paid flags>       commitment/hedge labels (outcome-v3 labeler)
 *   bun eval/runner/pilot/run.ts cohort <paid flags>       the synchronous timing cohort
 *   bun eval/runner/pilot/run.ts report                    aggregate every cell ($0)
 *
 * Paid flags: --paid --budget-run-id <id> --budget-ledger <path> (requirePaidArm, then the ledger's fetch guard).
 * State: $PILOT_STATE_DIR (default ~/.capy/work/pilot). The brief builder is gbrain's
 * src/eval/longmemeval/evidence-brief.ts from the pinned dependency (or $PILOT_GBRAIN_ROOT).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun, type BudgetRun, type PaidRequestGuard } from '../budget-ledger.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { judgeBody, judgeVerdict, readerBody, readNdjson } from '../batch/sources.ts';
import { normalizeUsage, usageSourceOf, type NormalizedUsage, type UsageReceipt } from '../usage-receipt.ts';
import { JUDGED_LABEL_SYSTEM, judgedLabelUser, parseJudgedLabel, type CommitmentLabel } from '../outcomes/v3.ts';
import { callModel, pool, type CallResult } from './call.ts';
import { BUDGETS, CHEAP, FRONTIER, OPUS, cacheBody, cellId, digestBudget, escalate, frontierBody, listUsd, qualityCells, type Budget, type Cheap, type Reader } from './cells.ts';
import { cl100k, headCut, loadPilotEvidence, pilotSplit, truncEvidence, withEvidence, W10A_DIR, type PilotQuestion } from './evidence.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const STATE_DIR = process.env.PILOT_STATE_DIR ?? join(homedir(), '.capy/work/pilot');
const BRIEF_FILE = 'src/eval/longmemeval/evidence-brief.ts';
/** The gbrain whose evidence-brief.ts the pilot loads: $PILOT_GBRAIN_ROOT (a candidate checkout), else the pinned dependency. */
export const GBRAIN_ROOT = process.env.PILOT_GBRAIN_ROOT ?? join(ROOT, 'node_modules/gbrain');
/** Selected by the preregistered ladder (samples 1 and 2); it failed confirmation on hedged precision, so labels feed only the commitment axis and FALLBACK's routing. */
export const LABEL_MODEL = process.env.PILOT_LABEL_MODEL ?? 'claude-sonnet-5-5';
export const JUDGE_MODEL = 'gpt-4o-2024-08-06';
export const SEARCHED = 'gbrain c5fb0201 hybrid search (balanced mode, reranker on), top 5 whole sessions (W10a capture)';
const CONCURRENCY = Number(process.env.PILOT_CONCURRENCY ?? 8);

// ─── The brief module (gbrain, eval-only) ──────────────────────────

export interface BriefSessionLike { session_id: string; date?: string; body: string }
interface BriefLike { mode: string; fallback_reason: string | null; rendered: string; rendered_tokens_cl100k: number; over_budget: boolean; claims: Array<{ id: string; pointer: { session_id: string } } & Record<string, unknown>>; validation: Record<string, unknown> & { claims_total: number; grounded: number; dropped: Array<{ reason: string }> }; uncited_corrections: unknown[] }
export interface BriefModule {
  BRIEF_VERSION: string; DIGEST_VERSION: string;
  buildBriefPrompt(i: { question: string; questionDate?: string; sessions: readonly BriefSessionLike[]; budgetTokens: number }): { system: string; user: string };
  buildDigestPrompt(i: { session: BriefSessionLike; budgetTokens: number }): { system: string; user: string };
  parseBriefDraft(text: string): unknown;
  validateBrief(draft: unknown, sessions: readonly BriefSessionLike[], opts: { question: string; budgetTokens: number; searched: { retrieval: string; readiness?: string }; version?: string }): BriefLike;
  renderBrief(b: unknown): string;
  sessionText(s: BriefSessionLike): string;
}

export async function loadBriefModule(root = GBRAIN_ROOT): Promise<{ mod: BriefModule; identity: Record<string, unknown> }> {
  const files = ['src/eval/longmemeval/evidence-brief.ts', 'src/core/cycle/synthesize-verify.ts', 'src/core/think/sanitize.ts', 'src/eval/longmemeval/sanitize.ts', 'src/eval/longmemeval/reader.ts', 'src/core/chunkers/token-estimate.ts'];
  const mod = await import(join(root, files[0])) as BriefModule;
  const git = (args: string[]) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); } catch { return null; } };
  return {
    mod,
    identity: {
      gbrain_head: git(['rev-parse', 'HEAD']), gbrain_dirty: (git(['status', '--porcelain']) ?? '').length > 0,
      files: Object.fromEntries(files.map(f => [f, createHash('sha256').update(readFileSync(join(root, f))).digest('hex')])),
      brief_version: mod.BRIEF_VERSION, digest_version: mod.DIGEST_VERSION,
    },
  };
}

// ─── State ─────────────────────────────────────────────────────────

export interface CallRecord { status: string; text: string; finish: string | null; error: string | null; usage: NormalizedUsage | null; usage_raw: Record<string, unknown> | null; response_model: string | null; latency_ms: number; attempts: number; usd: number; receipts: UsageReceipt[] }
const lean = (model: string, r: CallResult): CallRecord => {
  const usage = normalizeUsage(usageSourceOf(`${model.startsWith('claude') ? 'anthropic' : 'openai'}:${model}`), r.usage);
  return { status: r.status, text: r.text ?? '', finish: r.finish, error: r.error, usage, usage_raw: r.usage, response_model: r.response_model, latency_ms: r.latency_ms, attempts: r.attempts, usd: listUsd(model, usage), receipts: r.receipts };
};

class Store<T extends { key: string }> {
  private map = new Map<string, T>();
  constructor(private path: string) {
    for (const r of readNdjson(path)) this.map.set(r.key, r as T);
  }
  get(key: string) { return this.map.get(key); }
  has(key: string) { return this.map.has(key); }
  put(rec: T) { mkdirSync(resolve(this.path, '..'), { recursive: true }); appendFileSync(this.path, JSON.stringify(rec) + '\n'); this.map.set(rec.key, rec); }
  values() { return [...this.map.values()]; }
}

export interface BuildRec extends CallRecord { key: string; kind: 'brief' | 'digest'; budget: number; builder: Cheap; question_id: string | null; session_id: string | null }
export interface ReadRec { key: string; cell: string; question_id: string; model: string; source: string; text: string; finish: string | null; error: string | null; usage: NormalizedUsage | null; usd: number; latency_ms: number | null; delivered_cl100k: number; meta: Record<string, unknown>; receipts: UsageReceipt[] }
export interface JudgeRec { key: string; cell: string; question_id: string; verdict: boolean | null; raw: string | null; error: string | null; usd: number }
export interface LabelRec { key: string; label: CommitmentLabel | null; raw: string; model: string; usd: number; error: string | null; latency_ms: number }

export const stores = (dir = STATE_DIR) => ({
  builds: new Store<BuildRec>(join(dir, 'builds.ndjson')),
  reads: new Store<ReadRec>(join(dir, 'reads.ndjson')),
  judges: new Store<JudgeRec>(join(dir, 'judges.ndjson')),
  labels: new Store<LabelRec>(join(dir, 'labels.ndjson')),
});

export const textKey = (s: string) => createHash('sha256').update(s).digest('hex');
const sessionKey = (s: BriefSessionLike) => `${s.session_id}#${textKey(s.body).slice(0, 12)}`;

/** Why a reader row is an execution error (receipts.ts semantics), or null. */
export function executionError(r: { status: string; finish: string | null; text: string }): string | null {
  if (r.status !== 'succeeded') return `reader_${r.status}`;
  if (r.finish === 'max_tokens') return 'reader_max_tokens';
  if (r.finish !== 'stop') return 'reader_unknown_finish_reason';
  if (!r.text.trim()) return 'reader_empty_response';
  return null;
}

// ─── Evidence per cell ─────────────────────────────────────────────

export function briefFor(mod: BriefModule, q: PilotQuestion, b: BuildRec | undefined, budget: number): { evidence: string; meta: Record<string, unknown> } {
  const sessions = q.sessions.map(s => ({ session_id: s.session_id, ...(s.date ? { date: s.date } : {}), body: s.body }));
  const draft = b && b.status === 'succeeded' ? mod.parseBriefDraft(b.text) : null;
  const brief = mod.validateBrief(draft, sessions, { question: q.question, budgetTokens: budget, searched: { retrieval: SEARCHED } });
  const evidence = brief.mode === 'fallback_full_text' ? q.evidence : brief.rendered;
  return { evidence, meta: { mode: brief.mode, fallback_reason: brief.fallback_reason, builder_error: b?.status === 'succeeded' ? null : b?.error ?? 'not_built', claims_total: brief.validation.claims_total, grounded: brief.validation.grounded, dropped: countBy(brief.validation.dropped.map(d => d.reason)), uncited_corrections: brief.uncited_corrections.length, polarity_mismatches: brief.validation.polarity_mismatches, instruction_like: brief.validation.instruction_like, over_budget: brief.mode === 'fallback_full_text' ? true : brief.over_budget } };
}

export function digestFor(mod: BriefModule, q: PilotQuestion, builds: (s: BriefSessionLike) => BuildRec | undefined, budget: Budget): { evidence: string; meta: Record<string, unknown> } {
  const per = digestBudget(budget);
  const claims: any[] = [];
  const raw: string[] = [];
  let failed = 0, grounded = 0, total = 0;
  q.sessions.forEach((s, i) => {
    const session = { session_id: s.session_id, ...(s.date ? { date: s.date } : {}), body: s.body };
    const b = builds(session);
    const draft = b && b.status === 'succeeded' ? mod.parseBriefDraft(b.text) : null;
    const d = mod.validateBrief(draft, [session], { question: '', budgetTokens: per, searched: { retrieval: SEARCHED }, version: mod.DIGEST_VERSION });
    total += d.validation.claims_total;
    grounded += d.validation.grounded;
    if (d.mode === 'fallback_full_text' || d.claims.length === 0) {
      failed++;
      raw.push(headCut(`<chat_session id="${s.session_id}"${s.date ? ` date="${s.date}"` : ''}>\n${s.body}\n</chat_session>`, per));
    } else {
      for (const c of d.claims) claims.push({ ...c, id: `s${i + 1}.${c.id}` });
    }
  });
  const searched = { retrieval: SEARCHED, readiness: 'index readiness: not reported by this harness (replayed retrieval)', sessions: q.sessions.map(s => ({ session_id: s.session_id, date: s.date ?? null })) };
  const render = (cs: any[]) => {
    const text = mod.renderBrief({ version: mod.DIGEST_VERSION, mode: cs.length ? 'brief' : 'no_evidence', claims: cs, conflicts: [], counts: [], gaps: [], uncited_corrections: [], searched });
    return raw.length ? `${text}\n\nSessions without a usable digest (verbatim excerpt):\n${raw.join('\n\n')}` : text;
  };
  let kept = claims;
  let evidence = render(kept);
  while (cl100k(evidence) > budget && kept.length > 1) {
    const bySession = countBy(kept.map(c => c.pointer.session_id));
    const longest = Object.entries(bySession).sort((a, b) => b[1] - a[1])[0][0];
    const at = kept.map(c => c.pointer.session_id).lastIndexOf(longest);
    kept = kept.filter((_, k) => k !== at);
    evidence = render(kept);
  }
  return { evidence, meta: { sessions_failed: failed, claims_total: total, grounded, claims_delivered: kept.length, over_budget: cl100k(evidence) > budget } };
}

const countBy = (xs: string[]) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {} as Record<string, number>);

// ─── Stages ────────────────────────────────────────────────────────

function parseCell(cell: string): { kind: string; budget: Budget | null; cheap: Cheap | null; reader: Reader | null } {
  const [head, ...rest] = cell.split(':');
  const [kind, b] = head.split('@');
  const budget = b ? Number(b) as Budget : null;
  if (kind === 'a0' || kind === 'cache') return { kind, budget, cheap: null, reader: rest[0] as Reader };
  if (kind === 'direct') return { kind, budget, cheap: rest[0] as Cheap, reader: null };
  if (kind === 'fallback') { const [c, r] = rest[0].split('>'); return { kind, budget, cheap: c as Cheap, reader: r as Reader }; }
  if (kind === 'trunc') return { kind, budget, cheap: null, reader: rest[0] as Reader };
  return { kind, budget, cheap: rest[0] as Cheap, reader: rest[1] as Reader };
}

export interface BuildPlan { builders: readonly Cheap[]; budgets: readonly Budget[]; digests: boolean }
export const PILOT_BUILD: BuildPlan = { builders: CHEAP, budgets: BUDGETS, digests: true };

export async function runBuild(ids: string[], s: ReturnType<typeof stores>, mod: BriefModule, log: (l: string) => void, plan: BuildPlan = PILOT_BUILD): Promise<void> {
  const ev = loadPilotEvidence();
  const jobs: Array<() => Promise<void>> = [];
  for (const id of ids) {
    const q = ev.get(id)!;
    const sessions = q.sessions.map(x => ({ session_id: x.session_id, ...(x.date ? { date: x.date } : {}), body: x.body }));
    for (const budget of plan.budgets) for (const builder of plan.builders) {
      const key = `brief@${budget}:${builder}:${id}`;
      if (!s.builds.has(key)) jobs.push(async () => {
        const p = mod.buildBriefPrompt({ question: q.question, questionDate: q.question_date, sessions, budgetTokens: budget });
        const r = await callModel(readerBody(builder, p), { lane: 'pilot', role: 'builder', question_id: id });
        s.builds.put({ key, kind: 'brief', budget, builder, question_id: id, session_id: null, ...lean(builder, r) });
      });
    }
    if (plan.digests) for (const session of sessions) for (const budget of plan.budgets) for (const builder of plan.builders) {
      const key = `digest@${digestBudget(budget)}:${builder}:${sessionKey(session)}`;
      if (!s.builds.has(key) && !jobs.some(j => (j as any).key === key)) {
        const job = Object.assign(async () => {
          if (s.builds.has(key)) return;
          const p = mod.buildDigestPrompt({ session, budgetTokens: digestBudget(budget) });
          const r = await callModel(readerBody(builder, p), { lane: 'pilot', role: 'builder', question_id: session.session_id });
          s.builds.put({ key, kind: 'digest', budget: digestBudget(budget), builder, question_id: null, session_id: session.session_id, ...lean(builder, r) });
        }, { key });
        jobs.push(job);
      }
    }
  }
  log(`build: ${jobs.length} builder calls`);
  let done = 0;
  await pool(jobs, CONCURRENCY, async j => { await j(); if (++done % 100 === 0) log(`build: ${done}/${jobs.length}`); });
}

/** The request a reader cell sends for one question, with its delivered evidence and builder cost. */
export function readerRequest(cell: string, q: PilotQuestion, s: ReturnType<typeof stores>, mod: BriefModule): { model: string; body: Record<string, unknown>; delivered: number; builderUsd: number; meta: Record<string, unknown> } | null {
  const c = parseCell(cell);
  if (c.kind === 'a0') return { model: c.reader!, body: frontierBody(c.reader!, q.capture), delivered: cl100k(q.evidence), builderUsd: 0, meta: {} };
  if (c.kind === 'direct') return { model: c.cheap!, body: readerBody(c.cheap!, q.capture), delivered: cl100k(q.evidence), builderUsd: 0, meta: {} };
  if (c.kind === 'trunc') { const t = truncEvidence(q, c.budget!); return { model: c.reader!, body: frontierBody(c.reader!, withEvidence(q, t.evidence)), delivered: t.tokens, builderUsd: 0, meta: { sessions: t.sessions, cut: t.cut } }; }
  if (c.kind === 'brief') {
    const b = s.builds.get(`brief@${c.budget}:${c.cheap}:${q.question_id}`);
    const { evidence, meta } = briefFor(mod, q, b, c.budget!);
    return { model: c.reader!, body: frontierBody(c.reader!, withEvidence(q, evidence)), delivered: cl100k(evidence), builderUsd: b?.usd ?? 0, meta };
  }
  if (c.kind === 'digest') {
    let builderUsd = 0;
    const get = (session: BriefSessionLike) => { const r = s.builds.get(`digest@${digestBudget(c.budget!)}:${c.cheap}:${sessionKey(session)}`); builderUsd += r?.usd ?? 0; return r; };
    const { evidence, meta } = digestFor(mod, q, get, c.budget!);
    return { model: c.reader!, body: frontierBody(c.reader!, withEvidence(q, evidence)), delivered: cl100k(evidence), builderUsd, meta };
  }
  return null;
}

/** A0 rows already measured on these exact bodies: W10a (Sonnet 5.5) and W10c's current-pin arm (gpt-6.1-sol). */
export function committedA0(reader: Reader): Map<string, { text: string; finish: string | null; error: string | null; usage_raw: Record<string, unknown> | null; verdict: boolean | null; source: string }> | null {
  const path = reader === 'claude-sonnet-5-5' ? join(ROOT, W10A_DIR, 'arms/w10a-sonnet55-notes/rows.ndjson')
    : reader === 'gpt-6.1-sol' ? join(ROOT, 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/arms/w10c-sol-currentpin/rows.ndjson') : null;
  if (!path) return null;
  return new Map(readNdjson(path).map(r => [r.question_id, { text: r.hypothesis ?? '', finish: r.finish ?? null, error: r.error ?? null, usage_raw: r.usage ?? null, verdict: r.official?.verdict ?? null, source: path.replace(`${ROOT}/`, '') }]));
}

export async function runRead(cells: string[], ids: string[], s: ReturnType<typeof stores>, mod: BriefModule, log: (l: string) => void): Promise<void> {
  const ev = loadPilotEvidence();
  const jobs: Array<() => Promise<void>> = [];
  for (const cell of cells) {
    const c = parseCell(cell);
    if (c.kind === 'fallback' || c.kind === 'cache') continue;
    const committed = c.kind === 'a0' ? committedA0(c.reader!) : null;
    for (const id of ids) {
      const key = `${cell}|${id}`;
      if (s.reads.has(key)) continue;
      const q = ev.get(id)!;
      const r = committed?.get(id);
      if (r) {
        const usage = normalizeUsage(usageSourceOf(`${c.reader!.startsWith('claude') ? 'anthropic' : 'openai'}:${c.reader}`), r.usage_raw);
        s.reads.put({ key, cell, question_id: id, model: c.reader!, source: r.source, text: r.error ? '' : r.text, finish: r.finish, error: r.error, usage, usd: listUsd(c.reader!, usage), latency_ms: null, delivered_cl100k: cl100k(q.evidence), meta: { committed_verdict: r.verdict }, receipts: [] });
        continue;
      }
      jobs.push(async () => {
        const req = readerRequest(cell, q, s, mod)!;
        const r = lean(req.model, await callModel(req.body, { lane: 'pilot', role: 'reader', question_id: id, delivered: { tokenizer: 'cl100k', tokens: req.delivered } }));
        s.reads.put({ key, cell, question_id: id, model: req.model, source: 'sync', text: r.text, finish: r.finish, error: executionError(r), usage: r.usage, usd: r.usd, latency_ms: r.latency_ms, delivered_cl100k: req.delivered, meta: { ...req.meta, builder_usd: req.builderUsd }, receipts: r.receipts });
      });
    }
  }
  log(`read: ${jobs.length} reader calls over ${cells.length} cells`);
  let done = 0;
  await pool(jobs, CONCURRENCY, async j => { await j(); if (++done % 100 === 0) log(`read: ${done}/${jobs.length}`); });
}

export async function runJudge(s: ReturnType<typeof stores>, log: (l: string) => void, ids?: string[]): Promise<void> {
  const ev = loadPilotEvidence();
  const want = ids ? new Set(ids) : null;
  const jobs = s.reads.values().filter(r => !s.judges.has(r.key) && (!want || want.has(r.question_id))).map(r => async () => {
    const q = ev.get(r.question_id)!;
    if (r.error) { s.judges.put({ key: r.key, cell: r.cell, question_id: r.question_id, verdict: false, raw: null, error: 'reader_error', usd: 0 }); return; }
    if (typeof r.meta.committed_verdict === 'boolean') { s.judges.put({ key: r.key, cell: r.cell, question_id: r.question_id, verdict: r.meta.committed_verdict as boolean, raw: 'committed W10 official verdict', error: null, usd: 0 }); return; }
    const res = lean(JUDGE_MODEL, await callModel(judgeBody('official', { question_id: q.question_id, question_type: q.question_type, question: q.question, answer: q.answer }, r.text), { lane: 'pilot', role: 'judge', question_id: r.question_id }));
    const ok = res.status === 'succeeded' && res.text.trim() !== '';
    s.judges.put({ key: r.key, cell: r.cell, question_id: r.question_id, verdict: ok ? judgeVerdict(res.text) : null, raw: res.text, error: ok ? null : res.error ?? 'judge_empty_response', usd: res.usd });
  });
  log(`judge: ${jobs.length} judge calls`);
  await pool(jobs, CONCURRENCY, j => j());
}

export async function labelTexts(texts: string[], s: ReturnType<typeof stores>, model = LABEL_MODEL, log: (l: string) => void = () => {}): Promise<void> {
  const todo = [...new Set(texts)].filter(t => t.trim() && !s.labels.has(`${model}:${textKey(t)}`));
  log(`label: ${todo.length} labeler calls (${model})`);
  await pool(todo, CONCURRENCY, async t => {
    const r = lean(model, await callModel(readerBody(model, { system: JUDGED_LABEL_SYSTEM, user: judgedLabelUser(t) }), { lane: 'pilot', role: 'judge', question_id: textKey(t).slice(0, 12) }));
    s.labels.put({ key: `${model}:${textKey(t)}`, label: r.status === 'succeeded' ? parseJudgedLabel(r.text) : null, raw: r.text, model, usd: r.usd, error: r.status === 'succeeded' ? null : r.error, latency_ms: r.latency_ms });
  });
}

export const labelOf = (s: ReturnType<typeof stores>, text: string, model = LABEL_MODEL) => s.labels.get(`${model}:${textKey(text)}`) ?? null;

/** A4's live shape probe: one real request per model and body shape the pilot sends (cheap evidence), plus a cold and warm CACHE pair per frontier provider. */
export async function runProbe(mod: BriefModule): Promise<Record<string, unknown>[]> {
  const q = loadPilotEvidence().get(pilotSplit().pilot[0])!;
  const small = withEvidence(q, truncEvidence(q, 1000).evidence);
  const sessions = q.sessions.slice(0, 1).map(x => ({ session_id: x.session_id, ...(x.date ? { date: x.date } : {}), body: x.body }));
  const bodies: Array<[string, string, Record<string, unknown>]> = [
    ...[...FRONTIER, OPUS].map(m => [m, 'reader', frontierBody(m, small)] as [string, string, Record<string, unknown>]),
    ...CHEAP.map(m => [m, 'builder', readerBody(m, mod.buildBriefPrompt({ question: q.question, questionDate: q.question_date, sessions, budgetTokens: 1000 }))] as [string, string, Record<string, unknown>]),
    ...CHEAP.map(m => [m, 'label', readerBody(m, { system: JUDGED_LABEL_SYSTEM, user: judgedLabelUser('Answer: Probably 3 times.') })] as [string, string, Record<string, unknown>]),
    [JUDGE_MODEL, 'judge', judgeBody('official', { question_id: q.question_id, question_type: q.question_type, question: q.question, answer: q.answer }, 'scripted answer')],
    ...FRONTIER.flatMap(m => [[m, 'cache-cold', cacheBody(m, q.capture, `probe-${q.question_id}`)], [m, 'cache-warm', cacheBody(m, q.capture, `probe-${q.question_id}`)]] as Array<[string, string, Record<string, unknown>]>),
  ];
  const out: Record<string, unknown>[] = [];
  for (const [model, role, body] of bodies) {
    const r = lean(model, await callModel(body, { lane: 'pilot-probe', role: role === 'judge' || role === 'label' ? 'judge' : role === 'builder' ? 'builder' : 'reader', question_id: q.question_id }, { retries: 0 }));
    const draft = role === 'builder' && r.status === 'succeeded' ? mod.parseBriefDraft(r.text) : undefined;
    out.push({ model, role, status: r.status, finish: r.finish, error: r.error, usage: r.usage, usd: Number(r.usd.toFixed(5)), latency_ms: r.latency_ms, text: r.text.slice(0, 160), ...(role === 'builder' ? { parsed: draft !== null, brief: mod.validateBrief(draft ?? null, sessions, { question: q.question, budgetTokens: 1000, searched: { retrieval: SEARCHED } }).mode } : {}) });
  }
  return out;
}

// ─── CLI ───────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function paidStart(argv: string[], arm: string, estimateUsd: number): { run: BudgetRun; guard: PaidRequestGuard } {
  requirePaidArm(argv, { arm, estimateUsd });
  return startPaidRun(arm, { ...budgetOptionsFrom(argv), estimateUsd });
}

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  const log = (l: string) => process.stderr.write(`[pilot] ${l}\n`);
  const { pilot, confirm } = pilotSplit();
  const confirmRun = flag(argv, '--split') === 'confirm';
  const { CONFIRM_CELLS, CONFIRM_BUILD } = await import('./confirm.ts');
  const splitIds = confirmRun ? confirm : pilot;
  const ids = flag(argv, '--ids')?.split(',') ?? (flag(argv, '--limit') ? splitIds.slice(0, Number(flag(argv, '--limit'))) : splitIds);
  const defaultCells = confirmRun ? CONFIRM_CELLS : qualityCells();
  if (cmd === 'split') {
    const sp = pilotSplit();
    console.log(JSON.stringify({ seed_rule: 'stratifiedSample(report types of W10c 150 subset, 100, 20261007)', ...sp, pilot_sha256: textKey(sp.pilot.join('\n')), confirm_sha256: textKey(sp.confirm.join('\n')) }, null, 1));
    process.exit(0);
  }
  if (cmd === 'smoke') {
    const { runSmoke } = await import('./smoke.ts');
    console.log(JSON.stringify(await runSmoke(), null, 1));
    process.exit(0);
  }
  if (cmd === 'report') {
    const { buildReport } = await import('./report.ts');
    const out = flag(argv, '--out');
    const rep = await buildReport(stores(), (await loadBriefModule()).identity, { ids, cells: confirmRun ? CONFIRM_CELLS : undefined });
    if (out) writeFileSync(out, JSON.stringify(rep, null, 1) + '\n');
    else console.log(JSON.stringify(rep, null, 1));
    process.exit(0);
  }
  const s = stores();
  const { mod } = await loadBriefModule();
  const estimate: Record<string, number> = { probe: 0.5, build: 8, read: 50, judge: 8, label: 3, cohort: 12 };
  if (!(cmd in estimate)) { console.error('usage: run.ts split|smoke|probe|build|read|judge|label|cohort|report'); process.exit(2); }
  const { run, guard } = paidStart(argv, `wave1-pilot-${cmd}`, Number(flag(argv, '--estimate-usd') ?? estimate[cmd]));
  try {
    if (cmd === 'probe') console.log(JSON.stringify(await runProbe(mod), null, 1));
    if (cmd === 'build') await runBuild(ids, s, mod, log, confirmRun ? CONFIRM_BUILD : PILOT_BUILD);
    if (cmd === 'read') {
      const only = flag(argv, '--only');
      const cells = flag(argv, '--cells')?.split(',') ?? defaultCells.filter(c => !only || new RegExp(only).test(c));
      await runRead(cells, ids, s, mod, log);
    }
    if (cmd === 'judge') await runJudge(s, log, ids);
    // The hedge axis failed validation, so labels go only where they change a reported number: the commitment of
    // every judged-wrong answer, and every DIRECT answer (FALLBACK's routing).
    if (cmd === 'label') { const want = new Set(ids); await labelTexts(s.reads.values().filter(r => want.has(r.question_id) && !r.error && (r.cell.startsWith('direct:') || s.judges.get(r.key)?.verdict === false)).map(r => r.text), s, LABEL_MODEL, log); }
    if (cmd === 'cohort') {
      const { runCohort } = await import('./cohort.ts');
      if (confirmRun) { const { confirmCohortIds } = await import('./confirm.ts'); await runCohort(argv, s, mod, log, STATE_DIR, { ids: confirmCohortIds(), cells: CONFIRM_CELLS, seed: (await import('./confirm.ts')).CONFIRM_SEED + 2 }); }
      else await runCohort(argv, s, mod, log);
    }
  } finally {
    guard.uninstall();
    const summary = run.close();
    log(`spent: ${JSON.stringify(summary ?? null)}`);
  }
}

export { escalate, CHEAP, FRONTIER, OPUS, cellId, cacheBody };

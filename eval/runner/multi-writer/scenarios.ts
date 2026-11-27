/**
 * The checks of the multi-writer behavior suite. Each check runs the same scenario twice on a fresh set of invented
 * pages: once with writers in separate processes (every operation its own `gbrain call` process, the way crons, agents
 * and an operator's shell write at the same time) and once with in-process writers (several concurrent lanes on one
 * open engine). Then it reads the brain back as the operator and states every piece of wrong data as one sentence.
 *
 * Checks 1 to 6 are data invariants. Check 7 runs through `gbrain serve --http` with OAuth member credentials, because
 * access rules apply to remote callers. Check 8 is latency, reported and never judged.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { GbrainUnderTest } from '../gbrain-under-test.ts';
import { operatorCalls, runWriters, killGroup, type Brain, type WritersRun } from './brain.ts';
import { combineStatus, isConflict, isHandoff, isOwnerOnlyRefusal, mergeTally, outcomeClass, ownerGateFindings, percentile, phaseStatus, recordReadFailure, REFUSAL_CODES, tallyOps, type OpTally, type Status } from './classify.ts';
import { CAS_PUT, LEASE_FENCE_RE, type OpLine, type WorkerOp } from './worker.ts';

export interface PhaseResult {
  phase: 'processes' | 'in_process' | 'takeover' | 'remote';
  status: Status;
  tally: OpTally;
  findings: string[];
  notes: string[];
  start_errors?: Array<{ worker: number; code: string; message: string }>;
}

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  phases: PhaseResult[];
  /** Values compared across engines in the matrix report (check 7's numeric outcomes and refusal texts). */
  cross_engine?: Record<string, string>;
  /**
   * The distinct stderr texts of the worker processes this check started (last 4,000 characters of each, tokens
   * redacted, at most 40), so a receipt keeps the error text behind its counts. Best effort: a process that ends after
   * the check returns is filed with the next check.
   */
  writer_stderr?: Array<{ count: number; text: string }>;
  latency?: Record<string, unknown>;
}

export interface Ctx {
  gut: GbrainUnderTest;
  brain: Brain;
  writers: number;
  rounds: number;
  log: (s: string) => void;
}

export type Phase = 'processes' | 'in_process';
export const PHASES: Phase[] = ['processes', 'in_process'];

/** The JSON of a tool result: a parsed object, or the JSON at the head of a text that carries a trailing notice. */
export function asJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { /* notice after the JSON */ }
  const cut = v.search(/\n\[gbrain|\n\n/);
  if (cut > 0) { try { return JSON.parse(v.slice(0, cut)); } catch { /* not JSON */ } }
  return v;
}

const rows = (v: unknown): Array<Record<string, unknown>> => {
  const j = asJson(v) as unknown;
  if (Array.isArray(j)) return j as Array<Record<string, unknown>>;
  for (const k of ['results', 'facts', 'pages', 'entries', 'rows']) if (Array.isArray((j as Record<string, unknown>)?.[k])) return (j as Record<string, Array<Record<string, unknown>>>)[k]!;
  return [];
};

/** Writer plans for a phase: `lanes` op lists, as separate CLI processes or as lanes of one engine. */
function plansFor(phase: Phase, lanes: WorkerOp[][]) {
  return phase === 'processes' ? lanes.map(l => ({ mode: 'cli' as const, lanes: [l] })) : [{ mode: 'engine' as const, lanes }];
}

/**
 * Poll every write_pending receipt (up to `waitMs`). A write that committed meanwhile becomes the acknowledged write it
 * is: its line is marked ok and takes the committed receipt's outcome (and, for a compare-and-set put, its revision),
 * so the invariants judge it like any other acknowledged write. Returns the committed request ids.
 */
async function settlePending(ctx: Ctx, lines: OpLine[], waitMs = 15_000): Promise<Set<string>> {
  const ids = [...new Set(lines.filter(l => l.code === 'write_pending' && l.request_id).map(l => l.request_id!))];
  const applied = new Map<string, Record<string, unknown>>();
  if (ids.length) {
    const until = Date.now() + waitMs;
    while (Date.now() < until && applied.size < ids.length) {
      const r = await operatorCalls(ctx.brain, ctx.gut, ids.filter(id => !applied.has(id)).map(id => ({ op: 'get_write_request', params: { request_id: id }, tag: id })));
      for (const o of r.ops) {
        const j = asJson(o.result) as Record<string, unknown> | null;
        if (o.ok && j && /^(committed|applied|done)$/.test(String(j.state ?? j.status ?? ''))) applied.set(o.tag, j);
      }
      if (applied.size < ids.length) await Bun.sleep(1000);
    }
  }
  for (const l of lines) {
    const receipt = l.code === 'write_pending' && l.request_id ? applied.get(l.request_id) : undefined;
    if (!receipt) continue;
    const outcome = (receipt.outcome ?? receipt.result ?? receipt) as Record<string, unknown>;
    l.ok = true;
    l.result = outcome;
    l.settled_from_pending = true;
    if (l.cas) l.cas.revision = String(outcome.revision ?? '') || null;
    delete l.code;
  }
  return new Set(applied.keys());
}

/** Tally a writers run: lease or fence text in the writers' logs marks never-committed writes as the write-lock bug. */
async function tallyRun(ctx: Ctx, run: WritersRun, expectedError?: (l: OpLine) => boolean, conflictOk: (l: OpLine) => boolean = () => false): Promise<{ tally: OpTally; applied: Set<string> }> {
  const applied = await settlePending(ctx, run.ops);
  // A lost race is a fine answer only where the scenario asks for one (a compare-and-set put, a create of one slug).
  const tally = tallyOps(run.ops.filter(l => l.ok || !isConflict(l.code, l.message) || conflictOk(l)), { expectedError, applied, leaseLog: LEASE_FENCE_RE.test(run.stderr) });
  mergeTally(tally, tallyOps(run.ops.filter(l => !l.ok && isConflict(l.code, l.message) && !conflictOk(l)), { conflictIsError: true }));
  for (const e of run.startErrors) {
    tally.total += 1;
    if (/pglite_busy|engine_capability_missing|store_locked/.test(e.code + e.message)) tally.refused[e.code] = (tally.refused[e.code] ?? 0) + 1;
    else tally.errors[`start_${e.code}`] = { count: 1, sample: e.message.slice(0, 300) };
  }
  return { tally, applied };
}

const ackedLines = (run: WritersRun, applied: Set<string>) => run.ops.filter(l => l.ok || (l.code === 'write_pending' && l.request_id && applied.has(l.request_id)));
/** Writes whose outcome the engine left open (owner gone mid-call, or still pending): they may or may not have landed. */
const maybeLines = (run: WritersRun, applied: Set<string>) => run.ops.filter(l => !l.ok && (isHandoff(l.code, l.message) || (l.code === 'write_pending' && !(l.request_id && applied.has(l.request_id)))));

/**
 * The operator's read-back. Every failed read goes into `tally` (classify.ts recordReadFailure): only the tags in
 * `notFoundOk` may answer not found, so a read that errors never passes for "the data is gone".
 */
async function read(ctx: Ctx, calls: WorkerOp[], tally?: OpTally, notFoundOk: readonly string[] = []): Promise<Map<string, OpLine>> {
  const r = await operatorCalls(ctx.brain, ctx.gut, calls);
  if (r.startError) throw new Error(`operator read could not open the brain: ${r.startError.code}: ${r.startError.message}`);
  if (tally) for (const o of r.ops) recordReadFailure(tally, o, notFoundOk.includes(o.tag));
  return new Map(r.ops.map(o => [o.tag, o]));
}

async function seed(ctx: Ctx, calls: WorkerOp[]): Promise<string[]> {
  const r = await operatorCalls(ctx.brain, ctx.gut, calls);
  const problems = r.startError ? [`seed could not open the brain: ${r.startError.code}`] : [];
  await settlePending(ctx, r.ops);
  for (const o of r.ops) if (!o.ok) problems.push(`seed ${o.op} ${o.tag} failed: ${o.code}: ${(o.message ?? '').slice(0, 200)}`);
  return problems;
}

/** A phase that could not even seed its pages: every seed failure is a refusal or an error of the engine. */
function seedFailedPhase(phase: PhaseResult['phase'], problems: string[]): PhaseResult {
  const refused = problems.every(p => /engine_capability_missing|pglite_busy|store_locked/.test(p));
  const tally = tallyOps([]);
  if (refused) tally.refused.seed = problems.length;
  else tally.errors.seed = { count: problems.length, sample: problems[0]!.slice(0, 300) };
  if (problems.some(p => LEASE_FENCE_RE.test(p) || /write_pending/.test(p))) tally.write_lock_bug += problems.length;
  return { phase, status: refused ? 'not_supported' : 'fail', tally, findings: [], notes: problems.slice(0, 5) };
}

const tagOf = (w: number, r: number) => `w${w}r${r}`;

// ─── 1. Lost updates ───────────────────────────────────────────────────────────────────────────────────────────────

export async function checkLostUpdates(ctx: Ctx): Promise<CheckResult> {
  const phases: PhaseResult[] = [];
  const putMs: number[] = [];
  for (const phase of PHASES) {
    const p = `mw/c1-${phase.replace('_', '-')}`;
    const seedProblems = await seed(ctx, [
      { op: 'put_page', params: { slug: `${p}-tags`, content: 'Tag target for concurrent writers.' }, tag: 'seed-tags' },
      { op: 'put_page', params: { slug: `${p}-body`, content: 'Body target, version zero.' }, tag: 'seed-body' },
      { op: 'put_page', params: { slug: `people/${p.replace(/\//g, '-')}-entity`, content: 'An invented person for concurrent facts.' }, tag: 'seed-entity' },
    ]);
    if (seedProblems.length) { phases.push(seedFailedPhase(phase, seedProblems)); continue; }
    const entity = `people/${p.replace(/\//g, '-')}-entity`;
    const lanes: WorkerOp[][] = Array.from({ length: ctx.writers }, (_, w) => Array.from({ length: ctx.rounds }, (_, r): WorkerOp[] => [
      { op: 'add_tag', params: { slug: `${p}-tags`, tag: `mw-${tagOf(w, r)}` }, tag: `tag:${tagOf(w, r)}` },
      { op: CAS_PUT, params: { slug: `${p}-body`, content: `Body target, version ${tagOf(w, r)} marker-${tagOf(w, r)}.` }, tag: `body:${tagOf(w, r)}` },
      { op: 'remember', params: { fact: `Invented person fact number ${tagOf(w, r)} about a widget-co order`, entity, provenance: 'multi-writer eval' }, tag: `fact:${tagOf(w, r)}` },
    ]).flat());
    const run = await runWriters(ctx.brain, ctx.gut, plansFor(phase, lanes));
    const { tally, applied } = await tallyRun(ctx, run, undefined, l => l.op === CAS_PUT);
    const acked = ackedLines(run, applied);
    for (const l of acked) if (l.cas) putMs.push(l.cas.put_ms);
    const got = await read(ctx, [
      { op: 'get_tags', params: { slug: `${p}-tags` }, tag: 'tags' },
      { op: 'get_page', params: { slug: `${p}-body` }, tag: 'body' },
      { op: 'recall', params: { entity, limit: 1000 }, tag: 'facts' },
    ], tally);
    const findings: string[] = [];
    const notes: string[] = [];
    const tags = new Set((asJson(got.get('tags')?.result) as string[] | undefined) ?? []);
    const ackTags = acked.filter(l => l.op === 'add_tag').map(l => `mw-${l.tag.slice(4)}`);
    const lostTags = ackTags.filter(t => !tags.has(t));
    if (lostTags.length) findings.push(`${lostTags.length} of ${ackTags.length} acknowledged tags on one page are missing (lost updates), e.g. ${lostTags.slice(0, 3).join(', ')}`);
    const body = String((asJson(got.get('body')?.result) as Record<string, unknown> | undefined)?.compiled_truth ?? '');
    const ackPuts = acked.filter(l => l.op === CAS_PUT);
    const maybePuts = maybeLines(run, applied).filter(l => l.op === CAS_PUT);
    const ackBodies = ackPuts.map(l => l.tag.slice(5));
    const allowed = [...ackBodies, ...maybePuts.map(l => l.tag.slice(5))];
    // The whole body must be exactly one write's content, not a marker inside a truncated or merged text.
    const winner = allowed.find(t => body.trim() === `Body target, version ${t} marker-${t}.`);
    const markers = winner ? [winner] : [...body.matchAll(/marker-(w\d+r\d+)/g)].map(m => m[1]!);
    if (ackBodies.length && !winner) findings.push(`after ${ackBodies.length} acknowledged concurrent rewrites the page body is not exactly the content of one of them or of the ${maybePuts.length} writes with an open outcome (body ${JSON.stringify(body.slice(0, 120))})`);
    // Compare-and-set: no two acknowledged writes may have won against the same revision, and the page must end at the
    // write no other acknowledged write was based on.
    const bases = ackPuts.map(l => l.cas?.base ?? '');
    const sameBase = bases.length - new Set(bases).size;
    if (sameBase) findings.push(`${sameBase + 1} writers were each told their write won against the same revision (one of them was silently overwritten)`);
    const heads = ackPuts.filter(l => !bases.includes(l.cas?.revision ?? '\u0000'));
    const finalRev = String((asJson(got.get('body')?.result) as Record<string, unknown> | undefined)?.knowledge_revision ?? '');
    if (maybePuts.length && markers[0] && !ackBodies.includes(markers[0])) notes.push(`the page ended at write ${markers[0]}, whose caller was told ${maybePuts.find(l => l.tag.slice(5) === markers[0])?.code} (the outcome was open and it did land)`);
    if (ackPuts.length && !sameBase && !maybePuts.length && (heads.length !== 1 || heads[0]!.cas?.revision !== finalRev || markers[0] !== heads[0]!.tag.slice(5))) findings.push(`the page does not end at the last write of the acknowledged revision chain (${heads.length} chain heads; final ${finalRev.slice(0, 8)})`);
    const facts = new Set(rows(got.get('facts')?.result).map(f => String(f.fact ?? '')));
    const ackFacts = acked.filter(l => l.op === 'remember').map(l => `Invented person fact number ${l.tag.slice(5)} about a widget-co order`);
    const lostFacts = ackFacts.filter(f => !facts.has(f));
    if (lostFacts.length) findings.push(`${lostFacts.length} of ${ackFacts.length} acknowledged facts about one entity are missing`);
    phases.push({ phase, status: phaseStatus(tally, findings), tally, findings, notes: [`${acked.length} of ${run.ops.length} writes acknowledged`, ...notes], ...(run.startErrors.length ? { start_errors: run.startErrors } : {}) });
  }
  return { id: 'c1_lost_updates', title: 'Lost updates: concurrent writes to the same page', status: combineStatus(phases.map(p => p.status)), phases, latency: { put_ms: putMs } };
}

// ─── 2. Duplicate pages ───────────────────────────────────────────────────────────────────────────────────────────

export async function checkDuplicates(ctx: Ctx): Promise<CheckResult> {
  const phases: PhaseResult[] = [];
  for (const phase of PHASES) {
    const slug = `mw/c2-${phase.replace('_', '-')}-new`;
    const variants = [slug, slug.toUpperCase(), `${slug}.md`];
    const lanes: WorkerOp[][] = Array.from({ length: ctx.writers }, (_, w) => [
      { op: 'put_page', params: { slug: variants[w % variants.length], content: `Created by writer ${w} marker-w${w}.` }, tag: `create:w${w}` },
    ]);
    const run = await runWriters(ctx.brain, ctx.gut, plansFor(phase, lanes));
    const { tally, applied } = await tallyRun(ctx, run, l => l.code === 'invalid_slug' || (l.code === 'invalid_params' && /slug/i.test(l.message ?? '') && !isConflict(l.code, l.message)), l => l.op === 'put_page');
    const acked = ackedLines(run, applied);
    const got = await read(ctx, [
      { op: 'list_pages', params: { slug_prefix: `mw/c2-${phase.replace('_', '-')}`, limit: 1000 }, tag: 'list' },
      { op: 'get_page', params: { slug }, tag: 'get' },
    ], tally);
    const findings: string[] = [];
    const listed = rows(got.get('list')?.result).filter(r => String(r.slug).toLowerCase().replace(/\.md$/, '') === slug);
    if (acked.length && listed.length !== 1) findings.push(`${acked.length} acknowledged concurrent creates of one slug left ${listed.length} pages for it (${listed.map(r => String(r.slug)).join(', ')})`);
    const body = String((asJson(got.get('get')?.result) as Record<string, unknown> | undefined)?.compiled_truth ?? '');
    const winner = [...acked, ...maybeLines(run, applied)].find(l => body.trim() === `Created by writer ${l.tag.slice(8)} marker-${l.tag.slice(7)}.`);
    const markers = winner ? [winner.tag.slice(7)] : [...body.matchAll(/marker-(w\d+)/g)].map(m => m[1]!).concat(['<not exactly one write>']);
    if (acked.length > 1) findings.push(`${acked.length} writers were each told their create of one new page succeeded; the page keeps only one of them`);
    const maybeCreates = maybeLines(run, applied);
    if (acked.length && (markers.length !== 1 || ![...acked, ...maybeCreates].some(l => l.tag === `create:${markers[0]}`))) findings.push(`the created page holds ${markers.length} writer markers (${markers.join(',') || 'none'}), not exactly one acknowledged create`);
    phases.push({ phase, status: phaseStatus(tally, findings), tally, findings, notes: [`slug variants written: ${variants.join(' | ')}`], ...(run.startErrors.length ? { start_errors: run.startErrors } : {}) });
  }
  return { id: 'c2_duplicate_pages', title: 'Duplicate pages: concurrent creates of one slug', status: combineStatus(phases.map(p => p.status)), phases };
}

// ─── 3. Links and backlinks ───────────────────────────────────────────────────────────────────────────────────────

export async function checkLinks(ctx: Ctx): Promise<CheckResult> {
  const phases: PhaseResult[] = [];
  for (const phase of PHASES) {
    const p = `mw/c3-${phase.replace('_', '-')}`;
    const target = `${p}-target`;
    const src = (w: number, r: number) => `${p}-src-${tagOf(w, r)}`;
    const seedCalls: WorkerOp[] = [{ op: 'put_page', params: { slug: target, content: 'Link target.' }, tag: 'seed-target' }];
    for (let w = 0; w < ctx.writers; w++) for (let r = 0; r < ctx.rounds; r++) seedCalls.push({ op: 'put_page', params: { slug: src(w, r), content: `Link source ${tagOf(w, r)}.` }, tag: `seed-${tagOf(w, r)}` });
    const seedProblems = await seed(ctx, seedCalls);
    if (seedProblems.length) { phases.push(seedFailedPhase(phase, seedProblems)); continue; }
    const lanes: WorkerOp[][] = Array.from({ length: ctx.writers }, (_, w) => Array.from({ length: ctx.rounds }, (_, r): WorkerOp[] => [
      { op: 'add_link', params: { from: src(w, r), to: target }, tag: `link:${tagOf(w, r)}` },
      ...(w === 0 ? [{ op: CAS_PUT, params: { slug: target, content: `Link target, rewritten ${r}.` }, tag: `rewrite:${r}` }] : []),
    ]).flat());
    const run = await runWriters(ctx.brain, ctx.gut, plansFor(phase, lanes));
    const { tally, applied } = await tallyRun(ctx, run, undefined, l => l.op === CAS_PUT);
    const acked = ackedLines(run, applied).filter(l => l.op === 'add_link');
    const reads: WorkerOp[] = [{ op: 'get_backlinks', params: { slug: target }, tag: 'back' }];
    for (const l of acked) reads.push({ op: 'get_links', params: { slug: `${p}-src-${l.tag.slice(5)}` }, tag: `out:${l.tag.slice(5)}` });
    const got = await read(ctx, reads, tally);
    const findings: string[] = [];
    const back = rows(got.get('back')?.result).map(r => String(r.from_slug));
    const want = acked.map(l => `${p}-src-${l.tag.slice(5)}`);
    const missing = want.filter(s => !back.includes(s));
    const dupes = back.length - new Set(back).size;
    if (missing.length) findings.push(`${missing.length} of ${want.length} acknowledged links are missing from the target's backlinks`);
    if (dupes) findings.push(`the target's backlinks list ${dupes} duplicate rows`);
    const maybe = maybeLines(run, applied).filter(l => l.op === 'add_link').map(l => `${p}-src-${l.tag.slice(5)}`);
    const extra = back.filter(s => s.startsWith(`${p}-src-`) && !want.includes(s) && !maybe.includes(s));
    if (extra.length) findings.push(`${extra.length} backlinks exist for links that were never acknowledged`);
    const outMissing = acked.filter(l => !rows(got.get(`out:${l.tag.slice(5)}`)?.result).some(r => String(r.to_slug) === target));
    if (outMissing.length) findings.push(`${outMissing.length} source pages do not list the target in their own links, although the target's backlinks name them`);
    phases.push({ phase, status: phaseStatus(tally, findings), tally, findings, notes: [`${acked.length} links acknowledged; target rewritten ${ctx.rounds} times meanwhile`], ...(run.startErrors.length ? { start_errors: run.startErrors } : {}) });
  }
  return { id: 'c3_links', title: 'Link and backlink consistency under concurrent writes', status: combineStatus(phases.map(p => p.status)), phases };
}

// ─── 4. Timeline order, completeness and time ─────────────────────────────────────────────────────────────────────

const dayOf = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

function timelineFindings(ctx: Ctx, entries: Array<Record<string, unknown>>, acked: OpLine[], prefix: string): string[] {
  const findings: string[] = [];
  const summaries = entries.map(e => String(e.summary ?? ''));
  const want = acked.map(l => `${prefix} ${l.tag.slice(3)}`);
  const missing = want.filter(s => !summaries.includes(s));
  if (missing.length) findings.push(`${missing.length} of ${want.length} acknowledged timeline entries are missing, e.g. ${missing.slice(0, 3).join('; ')}`);
  const dup = summaries.length - new Set(summaries).size;
  if (dup) findings.push(`the timeline lists ${dup} duplicate entries`);
  const dates = entries.map(e => String(e.date ?? '').slice(0, 10));
  const asc = dates.every((d, i) => i === 0 || dates[i - 1]! <= d);
  const desc = dates.every((d, i) => i === 0 || dates[i - 1]! >= d);
  if (!asc && !desc) findings.push('the timeline is not in date order');
  // Per writer, entries it wrote one after another must carry creation times that never go backward.
  const byTag = new Map(entries.map(e => [String(e.summary ?? ''), e]));
  const lanes = new Map<string, OpLine[]>();
  for (const l of acked) { const k = `${(l as OpLine & { worker?: number }).worker ?? 0}:${l.lane}`; (lanes.get(k) ?? lanes.set(k, []).get(k)!).push(l); }
  let backwards = 0;
  let untimed = 0;
  for (const ls of lanes.values()) {
    ls.sort((a, b) => a.i - b.i);
    let last = -Infinity;
    for (const l of ls) {
      const e = byTag.get(`${prefix} ${l.tag.slice(3)}`);
      if (!e) continue;
      const t = Date.parse(String(e.created_at ?? e.last_written_at ?? ''));
      if (Number.isNaN(t)) { untimed += 1; continue; }
      if (t < last) backwards += 1;
      last = Math.max(last, t);
    }
  }
  if (untimed) findings.push(`${untimed} acknowledged entries carry no readable creation time, so time order cannot be checked`);
  if (backwards) findings.push(`${backwards} entries carry a creation time earlier than an entry the same writer wrote before them (time went backward)`);
  void ctx;
  return findings;
}

export async function checkTimeline(ctx: Ctx): Promise<CheckResult> {
  const phases: PhaseResult[] = [];
  for (const phase of PHASES) {
    const slug = `mw/c4-${phase.replace('_', '-')}`;
    const prefix = `c4 ${phase}`;
    const seedProblems = await seed(ctx, [{ op: 'put_page', params: { slug, content: 'Timeline page.' }, tag: 'seed' }]);
    if (seedProblems.length) { phases.push(seedFailedPhase(phase, seedProblems)); continue; }
    const lanes: WorkerOp[][] = Array.from({ length: ctx.writers }, (_, w) => Array.from({ length: ctx.rounds }, (_, r) => (
      { op: 'add_timeline_entry', params: { slug, date: dayOf((w * ctx.rounds + r) % 300), summary: `${prefix} ${tagOf(w, r)}` }, tag: `tl:${tagOf(w, r)}` })));
    const run = await runWriters(ctx.brain, ctx.gut, plansFor(phase, lanes));
    const { tally, applied } = await tallyRun(ctx, run);
    const acked = ackedLines(run, applied);
    const got = await read(ctx, [{ op: 'get_timeline', params: { slug, limit: 1000 }, tag: 'tl' }], tally);
    const findings = timelineFindings(ctx, rows(got.get('tl')?.result), acked, prefix);
    phases.push({ phase, status: phaseStatus(tally, findings), tally, findings, notes: [`${acked.length} of ${run.ops.length} entries acknowledged`], ...(run.startErrors.length ? { start_errors: run.startErrors } : {}) });
  }
  const takeover = await timelineTakeover(ctx);
  // Multi-user follower takeover is held until its lanes land (Ember, 2026-11-25): run and record it, never count it.
  if (ctx.brain.kind === 'rust' && ctx.brain.env.GBRAIN_RUST_MULTIUSER === '1') {
    takeover.notes.unshift(`held: multi-user takeover checks are not counted until the follower lanes land; this run measured ${takeover.status}`);
    takeover.status = 'held';
  }
  phases.push(takeover);
  return { id: 'c4_timeline', title: 'Timeline order and completeness; times never go backward (also after a lease takeover)', status: combineStatus(phases.filter(p => !(p.phase === 'takeover' && p.notes.includes('not applicable'))).map(p => p.status)), phases };
}

/**
 * Rust only: a long-lived process owns the store while CLI writers reach it as clients; halfway through, the owner is
 * killed, so the next writer takes the store over. Every acknowledged entry must survive and no writer's times may go
 * backward across the takeover. PGLite and Postgres have no store owner, so the step does not apply there.
 */
async function timelineTakeover(ctx: Ctx): Promise<PhaseResult> {
  if (ctx.brain.kind !== 'rust') return { phase: 'takeover', status: 'pass', tally: tallyOps([]), findings: [], notes: ['not applicable', `${ctx.brain.kind} has no store owner to take over from`] };
  const slug = 'mw/c4-takeover';
  const prefix = 'c4 takeover';
  const seedProblems = await seed(ctx, [{ op: 'put_page', params: { slug, content: 'Timeline page for the takeover.' }, tag: 'seed' }]);
  if (seedProblems.length) return seedFailedPhase('takeover', seedProblems);
  const lanes: WorkerOp[][] = Array.from({ length: ctx.writers }, (_, w) => Array.from({ length: ctx.rounds * 2 }, (_, r) => (
    { op: 'add_timeline_entry', params: { slug, date: dayOf(w * 50 + r), summary: `${prefix} ${tagOf(w, r)}` }, tag: `tl:${tagOf(w, r)}` })));
  const total = lanes.flat().length;
  let seen = 0;
  let killedAt: number | null = null;
  const plans = [{ mode: 'engine' as const, lanes: [] as WorkerOp[][], hold: true, probe: true }, ...plansFor('processes', lanes)];
  const run = await runWriters(ctx.brain, ctx.gut, plans, {
    onOp: (_w, _l, all) => { seen += 1; if (killedAt === null && seen >= Math.floor(total / 2)) { killedAt = Date.now(); killGroup(all[0]!.child); } },
  });
  if (killedAt === null) killGroup(run.workers[0]!.child);
  const ops = run.ops.filter(o => o.worker !== 0);
  const { tally, applied } = await tallyRun(ctx, { ...run, ops, startErrors: run.startErrors.filter(e => e.worker !== 0) });
  const acked = ackedLines({ ...run, ops }, applied);
  const got = await read(ctx, [{ op: 'get_timeline', params: { slug, limit: 1000 }, tag: 'tl' }], tally);
  const findings = timelineFindings(ctx, rows(got.get('tl')?.result), acked, prefix);
  const holderRole = String((run.ready[0]?.probe as Record<string, unknown> | undefined)?.role ?? 'unknown');
  const notes = [`holder role ${holderRole}; owner killed after ${killedAt ? Math.floor(total / 2) : 'all'} of ${total} writes`, `${acked.length} entries acknowledged`];
  if (holderRole !== 'owner') notes.push('the holder did not own the store, so this run did not exercise a takeover');
  return { phase: 'takeover', status: phaseStatus(tally, findings), tally, findings, notes };
}

// ─── 5. Deletion leaves nothing ───────────────────────────────────────────────────────────────────────────────────

export async function checkDeletion(ctx: Ctx): Promise<CheckResult> {
  const phases: PhaseResult[] = [];
  for (const phase of PHASES) {
    const p = `mw/c5-${phase.replace('_', '-')}`;
    const doomed = `${p}-doomed`;
    const other = `${p}-other`;
    const word = `xylophagous${phase.replace('_', '')}`;
    const seedProblems = await seed(ctx, [
      { op: 'put_page', params: { slug: other, content: 'A page that stays.' }, tag: 'seed-other' },
      { op: 'put_page', params: { slug: doomed, content: `A page to delete, with the unique word ${word}.` }, tag: 'seed-doomed' },
      { op: 'add_link', params: { from: doomed, to: other }, tag: 'seed-link' },
      { op: 'add_timeline_entry', params: { slug: doomed, date: '2026-02-01', summary: `${word} seed entry` }, tag: 'seed-tl' },
      { op: 'add_tag', params: { slug: doomed, tag: 'mw-doomed' }, tag: 'seed-tag' },
    ]);
    if (seedProblems.length) { phases.push(seedFailedPhase(phase, seedProblems)); continue; }
    const lanes: WorkerOp[][] = Array.from({ length: ctx.writers - 1 }, (_, w) => Array.from({ length: ctx.rounds }, (_, r): WorkerOp[] => [
      { op: 'add_timeline_entry', params: { slug: doomed, date: dayOf(40 + r), summary: `${word} ${tagOf(w, r)}` }, tag: `tl:${tagOf(w, r)}` },
      { op: 'add_tag', params: { slug: doomed, tag: `mw-${tagOf(w, r)}` }, tag: `tag:${tagOf(w, r)}` },
    ]).flat());
    lanes.push([
      { op: 'get_page', params: { slug: other }, tag: 'pause' },
      { op: 'delete_page', params: { slug: doomed, force: true, purge: true }, tag: 'delete' },
    ]);
    const run = await runWriters(ctx.brain, ctx.gut, plansFor(phase, lanes));
    // A write to the page after it was deleted may answer not found; the delete itself may not.
    const notFound = (l: OpLine) => l.tag !== 'delete' && /(^|_)not_found$/.test(l.code ?? '');
    const { tally } = await tallyRun(ctx, run, notFound);
    const del = run.ops.find(o => o.tag === 'delete');
    const findings: string[] = [];
    const notes: string[] = [];
    if (!del?.ok) notes.push(`the delete did not run: ${del?.code ?? 'no result'}`);
    const got = await read(ctx, [
      { op: 'get_page', params: { slug: doomed }, tag: 'get' },
      { op: 'get_backlinks', params: { slug: other }, tag: 'back' },
      { op: 'get_timeline', params: { slug: doomed }, tag: 'tl' },
      { op: 'search', params: { query: word }, tag: 'search' },
      { op: 'list_pages', params: { slug_prefix: p, limit: 100 }, tag: 'list' },
      { op: 'get_tags', params: { slug: doomed }, tag: 'tags' },
    ], tally, ['get', 'tl', 'tags']);
    if (del?.ok) {
      const late = run.ops.filter(o => o.ok && o.tag !== 'delete' && o.tag !== 'pause' && o.t0 > del.t1);
      const g = got.get('get')!;
      if (g.ok) findings.push(`the deleted page is readable again after concurrent writes (${late.length} writes to it were acknowledged after the delete returned)`);
      if (rows(got.get('back')?.result).some(r => String(r.from_slug) === doomed)) findings.push("a link from the deleted page still shows in the other page's backlinks");
      if (rows(got.get('tl')?.result).length) findings.push(`the deleted page still has ${rows(got.get('tl')?.result).length} timeline entries`);
      if (rows(got.get('search')?.result).some(r => String(r.slug) === doomed)) findings.push('keyword search still finds the deleted page');
      if (rows(got.get('list')?.result).some(r => String(r.slug) === doomed)) findings.push('list_pages still lists the deleted page');
      const tags = asJson(got.get('tags')?.result);
      if (got.get('tags')?.ok && Array.isArray(tags) && tags.length) findings.push(`the deleted page still has ${tags.length} tags`);
    } else if (!del) tally.errors.delete_missing = { count: 1, sample: 'the delete lane produced no result' };
    phases.push({ phase, status: phaseStatus(tally, findings), tally, findings, notes, ...(run.startErrors.length ? { start_errors: run.startErrors } : {}) });
  }
  return { id: 'c5_deletion', title: 'Deletion leaves nothing under concurrent writes', status: combineStatus(phases.map(p => p.status)), phases };
}

// ─── 6. Facts do not come back ────────────────────────────────────────────────────────────────────────────────────

export async function checkFacts(ctx: Ctx): Promise<CheckResult> {
  const phases: PhaseResult[] = [];
  for (const phase of PHASES) {
    const entity = `people/mw-c6-${phase.replace('_', '-')}`;
    const fact = (t: string) => `The invented person ${entity} ordered part ${t} from acme-example`;
    const seedR = await operatorCalls(ctx.brain, ctx.gut, [
      { op: 'put_page', params: { slug: entity, content: 'An invented person.' }, tag: 'seed-page' },
      { op: 'remember', params: { fact: fact('doomed-one'), entity, provenance: 'multi-writer eval' }, tag: 'seed-fact' },
    ]);
    const seedFact = seedR.ops.find(o => o.tag === 'seed-fact');
    if (seedR.startError || !seedR.ops.every(o => o.ok)) { phases.push(seedFailedPhase(phase, seedR.ops.filter(o => !o.ok).map(o => `seed ${o.op} failed: ${o.code}: ${(o.message ?? '').slice(0, 200)}`).concat(seedR.startError ? [`seed open: ${seedR.startError.code}`] : []))); continue; }
    const factId = String((asJson(seedFact!.result) as Record<string, unknown>)?.id ?? '');
    // Writers remember new facts while one lane forgets the seeded fact and then deletes the entity page.
    const lanes: WorkerOp[][] = Array.from({ length: ctx.writers - 1 }, (_, w) => Array.from({ length: ctx.rounds }, (_, r) => (
      { op: 'remember', params: { fact: fact(tagOf(w, r)), entity, provenance: 'multi-writer eval' }, tag: `fact:${tagOf(w, r)}` })));
    lanes.push([
      { op: 'forget', params: { id: factId }, tag: 'forget' },
      { op: 'remember', params: { fact: fact('doomed-one'), entity, provenance: 'multi-writer eval' }, tag: 'reremember' },
    ]);
    const run = await runWriters(ctx.brain, ctx.gut, plansFor(phase, lanes));
    const { tally } = await tallyRun(ctx, run, l => l.tag === 'reremember' && /fact_withdrawn/.test(`${l.code} ${l.message}`));
    const findings: string[] = [];
    const forget = run.ops.find(o => o.tag === 'forget');
    const rerem = run.ops.find(o => o.tag === 'reremember');
    let got = await read(ctx, [{ op: 'recall', params: { entity, limit: 1000 }, tag: 'facts' }], tally);
    if (forget?.ok) {
      if (rows(got.get('facts')?.result).some(f => String(f.fact) === fact('doomed-one'))) findings.push('a forgotten fact is back in recall after concurrent writes');
      if (rerem?.ok) findings.push('remembering the exact text of a forgotten fact was accepted (its fingerprint did not hold)');
    }
    // Delete the entity page while writers keep remembering about it; the facts written before the delete must not return.
    const before = rows(got.get('facts')?.result).map(f => String(f.fact));
    const lanes2: WorkerOp[][] = Array.from({ length: ctx.writers - 1 }, (_, w) => [
      { op: 'remember', params: { fact: fact(`after-${w}`), entity, provenance: 'multi-writer eval' }, tag: `after:w${w}` }]);
    lanes2.push([{ op: 'delete_page', params: { slug: entity, force: true, purge: true }, tag: 'delete' }]);
    const run2 = await runWriters(ctx.brain, ctx.gut, plansFor(phase, lanes2));
    mergeTally(tally, (await tallyRun(ctx, run2)).tally);
    const del = run2.ops.find(o => o.tag === 'delete');
    got = await read(ctx, [{ op: 'recall', params: { entity, limit: 1000 }, tag: 'facts' }, { op: 'search', params: { query: 'acme-example ordered part' }, tag: 'search' }], tally, ['facts']);
    const notes = [`fact ${factId} forgotten: ${forget?.ok ? 'yes' : `no (${forget?.code})`}; re-remember answered ${rerem?.ok ? 'accepted' : rerem?.code}`];
    if (del?.ok) {
      const back = rows(got.get('facts')?.result).map(f => String(f.fact)).filter(f => before.includes(f));
      if (back.length) findings.push(`${back.length} facts written before the entity page was deleted are back in recall`);
      if (rows(got.get('search')?.result).some(r => String(r.slug) === entity)) findings.push('keyword search still finds the deleted entity page');
      if (rerem && !rerem.ok) {
        const again = await read(ctx, [{ op: 'remember', params: { fact: fact('doomed-one'), entity, provenance: 'multi-writer eval' }, tag: 'again' }]);
        if (again.get('again')?.ok) findings.push('after the entity page was deleted, the forgotten fact could be remembered again (its fingerprint was lost with the page)');
        notes.push(`after the delete, re-remembering the forgotten text answered ${again.get('again')?.ok ? 'accepted' : again.get('again')?.code}`);
      }
    } else notes.push(`entity delete answered ${del?.code}`);
    phases.push({ phase, status: phaseStatus(tally, findings), tally, findings, notes, ...(run.startErrors.length ? { start_errors: run.startErrors } : {}) });
  }
  return { id: 'c6_facts', title: 'Facts and fingerprints do not come back after delete or forget', status: combineStatus(phases.map(p => p.status)), phases };
}

// ─── 7. Access rules for remote callers ───────────────────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

interface Remote { call(client: string, op: string, args: Record<string, unknown>): Promise<OpLine & { decoded: string }>; stop(): Promise<void> }

async function startRemote(ctx: Ctx, clients: Record<string, { id: string; secret: string }>): Promise<Remote> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [join(ctx.gut.root, 'src/cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', base], { env: ctx.brain.env, cwd: ctx.brain.home, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const log: string[] = [];
  const keep = (d: Buffer) => { log.push(d.toString().replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>')); if (log.length > 100) log.shift(); };
  proc.stdout?.on('data', keep); proc.stderr?.on('data', keep);
  const stop = async () => { killGroup(proc); await Bun.sleep(300); };
  for (const t0 = Date.now(); ;) {
    if (proc.exitCode !== null) throw Object.assign(new Error(`serve --http exited ${proc.exitCode}: ${log.join('').replace(/\s+/g, ' ').slice(-600)}`), { code: /engine_capability_missing/.test(log.join('')) ? 'engine_capability_missing' : 'serve_failed' });
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 120_000) { await stop(); throw Object.assign(new Error(`serve --http did not come up: ${log.join('').slice(-600)}`), { code: 'serve_timeout' }); }
    await Bun.sleep(400);
  }
  const tokens = new Map<string, string>();
  const sessions = new Map<string, string>();
  let rpc = 1;
  const token = async (client: string) => {
    if (tokens.has(client)) return tokens.get(client)!;
    const c = clients[client]!;
    const res = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret, scope: 'read write', resource: `${base}/mcp` }) });
    const j = await res.json().catch(() => ({})) as { access_token?: string };
    if (!j.access_token) throw new Error(`token endpoint HTTP ${res.status} for ${client}`);
    tokens.set(client, j.access_token);
    return j.access_token;
  };
  const post = async (bearer: string, body: Record<string, unknown>, sid?: string) => {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` };
    if (sid) h['mcp-session-id'] = sid;
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    let msg: Record<string, unknown> | null = null;
    if ('id' in body) {
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        for (const d of text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())) { try { const m = JSON.parse(d); if (m.id === body.id) { msg = m; break; } } catch { /* skip */ } }
      } else { try { msg = JSON.parse(text); } catch { /* not JSON */ } }
    }
    return { status: res.status, msg, sid: res.headers.get('mcp-session-id') ?? undefined };
  };
  const call: Remote['call'] = async (client, op, args) => {
    const t0 = performance.timeOrigin + performance.now();
    const base0 = { kind: 'op' as const, lane: 0, i: 0, op, tag: client, t0 };
    try {
      const bearer = await token(client);
      if (!sessions.has(client)) {
        const init = await post(bearer, { jsonrpc: '2.0', id: rpc++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-multi-writer', version: '1' } } });
        if (init.sid) await post(bearer, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);
        sessions.set(client, init.sid ?? '');
      }
      const r = await post(bearer, { jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name: op, arguments: args } }, sessions.get(client) || undefined);
      const t1 = performance.timeOrigin + performance.now();
      const result = (r.msg?.result ?? null) as { content?: Array<{ text?: string }>; isError?: boolean } | null;
      const text = result ? (result.content ?? []).map(c => c.text ?? '').join('\n') : JSON.stringify(r.msg?.error ?? { http: r.status });
      const ok = !!result && result.isError !== true;
      const code = ok ? undefined : (/"(?:canonical|code)"\s*:\s*"([a-z][a-z0-9_]+)"/.exec(text)?.[1] ?? (r.msg?.error ? 'rpc_error' : `http_${r.status}`));
      return { ...base0, t1, ms: Number((t1 - t0).toFixed(3)), ok, code, message: ok ? undefined : text.slice(0, 800), result: ok ? asJson(text) : undefined, decoded: text };
    } catch (e) {
      const t1 = performance.timeOrigin + performance.now();
      return { ...base0, t1, ms: t1 - t0, ok: false, code: 'harness_exception', message: String((e as Error).message).slice(0, 400), decoded: '' };
    }
  };
  return { call, stop };
}

const MEMBERS = ['alice-example', 'bob-example', 'carol-example'] as const;

export async function checkAccess(ctx: Ctx): Promise<CheckResult> {
  const notes: string[] = [];
  const findings: string[] = [];
  const tally = tallyOps([]);
  const cross: Record<string, string> = {};
  const must = async (args: string[]) => {
    const r = await ctx.brain.cli(args);
    if (r.code !== 0) throw Object.assign(new Error(`gbrain ${args.slice(0, 3).join(' ')} exited ${r.code}: ${(r.stdout + r.stderr).replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>').replace(/\s+/g, ' ').slice(-400)}`), { code: /engine_capability_missing|raw_sql/.test(r.stdout + r.stderr) ? 'engine_capability_missing' : 'setup_failed' });
    return r;
  };
  const done = (status: Status): CheckResult => ({ id: 'c7_access', title: 'Access rules for remote callers under concurrent writes', status, phases: [{ phase: 'remote', status, tally, findings, notes }], cross_engine: cross });
  const clients: Record<string, { id: string; secret: string }> = {};
  const open = 'notes/mw-c7-open';
  const priv = 'private/mw-c7-alice';
  const word = 'zephyrquill';
  const memberFact = 'The invented member alice-example parks a red bicycle zq8';
  try {
    const seedProblems = await seed(ctx, [
      { op: 'put_page', params: { slug: open, content: 'An unlabelled page anyone in the source may read.' }, tag: 'open' },
      { op: 'put_page', params: { slug: priv, content: `---\nreadable_by: [alice-example]\n---\nAlice's private note with the word ${word}.` }, tag: 'priv' },
    ]);
    if (seedProblems.length) throw Object.assign(new Error(seedProblems.join('; ')), { code: seedProblems.every(p => /engine_capability_missing/.test(p)) ? 'engine_capability_missing' : 'seed_failed' });
    for (const m of MEMBERS) await must(['access', 'member', 'add', m, '--name', m.split('-')[0]!]);
    await must(['access', 'member', 'labelled-only', 'carol-example', 'on']);
    for (const m of MEMBERS) {
      const r = await must(['auth', 'register-client', `mw-${m}`, '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', 'default', '--member', m]);
      const id = /gbrain_cl_[0-9a-f]+/.exec(r.stdout)?.[0];
      const secret = /gbrain_cs_[0-9a-f]+/.exec(r.stdout)?.[0];
      if (!id || !secret) throw Object.assign(new Error(`could not read the OAuth client for ${m}`), { code: 'setup_failed' });
      clients[m] = { id, secret };
    }
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? 'setup_failed');
    notes.push(`setup: ${(e as Error).message.slice(0, 400)}`);
    if (code === 'engine_capability_missing') { tally.refused[code] = 1; return done('not_supported'); }
    tally.errors[code] = { count: 1, sample: (e as Error).message.slice(0, 300) };
    return done('fail');
  }
  const before = await read(ctx, [{ op: 'get_page', params: { slug: open }, tag: 'open' }]);
  let remote: Remote;
  try { remote = await startRemote(ctx, clients); } catch (e) {
    const code = String((e as { code?: unknown }).code ?? 'serve_failed');
    notes.push(`serve --http: ${(e as Error).message.slice(0, 400)}`);
    if (code === 'engine_capability_missing') { tally.refused[code] = 1; return done('not_supported'); }
    tally.errors[code] = { count: 1, sample: (e as Error).message.slice(0, 300) };
    return done('fail');
  }
  try {
    // Concurrent remote writers: alice and bob write their own notes while the probes run.
    const writers = (async () => {
      const out: OpLine[] = [];
      await Promise.all(['alice-example', 'bob-example'].map(async m => {
        for (let r = 0; r < ctx.rounds; r++) out.push(await remote.call(m, 'put_page', { slug: `notes/mw-c7-${m}-${r}`, content: `Note ${r} by ${m}.` }));
      }));
      return out;
    })();
    const probe = async (client: string, op: string, args: Record<string, unknown>) => remote.call(client, op, args);
    const carolBase = String((asJson(before.get('open')?.result) as Record<string, unknown> | undefined)?.knowledge_revision ?? '');
    const [carolWrite, bobSearch, aliceSearch, hidden, missing, hiddenTl, missingTl, chain] = await Promise.all([
      // a. The write carries the page's current revision, so only the access rule can refuse it.
      probe('carol-example', 'put_page', { slug: open, content: 'Carol overwrote the open page.', expected_revision: carolBase }),
      probe('bob-example', 'search', { query: word }),
      probe('alice-example', 'search', { query: word }),
      probe('bob-example', 'get_page', { slug: priv }),
      probe('bob-example', 'get_page', { slug: 'private/mw-c7-nobody' }),
      probe('bob-example', 'get_timeline', { slug: priv }),
      probe('bob-example', 'get_timeline', { slug: 'private/mw-c7-nobody' }),
      // e. The member remembers a fact, forgets it, then remembers the same text again.
      (async () => {
        const first = await probe('alice-example', 'remember', { fact: memberFact, entity: 'people/alice-example', provenance: 'alice' });
        const id = String((asJson(first.result) as Record<string, unknown> | undefined)?.id ?? '');
        const forgot = first.ok ? await probe('alice-example', 'forget', { id }) : null;
        const again = forgot?.ok ? await probe('alice-example', 'remember', { fact: memberFact, entity: 'people/alice-example', provenance: 'alice' }) : null;
        return { first, forgot, again };
      })(),
    ]);
    const numeric: Array<[string, string, Record<string, unknown>]> = [
      ['search limit -1', 'search', { query: word, limit: -1 }],
      ['search limit 0', 'search', { query: word, limit: 0 }],
      ['search limit 2.5', 'search', { query: word, limit: 2.5 }],
      ['search limit 1e9', 'search', { query: word, limit: 1e9 }],
      ['search limit 2^53', 'search', { query: word, limit: 2 ** 53 }],
      ['get_timeline limit -1', 'get_timeline', { slug: open, limit: -1 }],
      ['get_timeline limit 1e9', 'get_timeline', { slug: open, limit: 1e9 }],
      ['list_pages limit 1e9', 'list_pages', { limit: 1e9 }],
      ['list_pages offset -5', 'list_pages', { offset: -5 }],
    ];
    const numericOut = await Promise.all(numeric.map(([, op, a]) => probe('bob-example', op, a)));
    const writes = await writers;
    await remote.stop();
    const after = await read(ctx, [{ op: 'get_page', params: { slug: open }, tag: 'open' }], tally);
    const chainLines = [chain.first, chain.forgot, chain.again].filter((l): l is NonNullable<typeof l> => !!l);
    const all = [carolWrite, bobSearch, aliceSearch, hidden, missing, hiddenTl, missingTl, ...chainLines, ...numericOut, ...writes];
    const engineRefused = (l: OpLine) => REFUSAL_CODES.has(l.code ?? '') || /engine_capability_missing|access_control/.test(l.code ?? '');
    if (all.every(l => !l.ok && engineRefused(l))) {
      tally.refused[all[0]!.code ?? 'engine_capability_missing'] = all.length;
      notes.push(`the server refused every remote call: ${(all[0]?.message ?? '').slice(0, 300)}`);
      return done('not_supported');
    }
    // Every probe is judged: the answer it should give, a typed refusal of the engine, or an error.
    const DENIED = /^(permission_denied|page_not_found|not_found|forbidden|access_denied|insufficient_scope|labelled_only_denied)$/;
    const failed = (l: OpLine, label: string) => {
      const code = l.code ?? 'error';
      if (engineRefused(l)) tally.refused[code] = (tally.refused[code] ?? 0) + 1;
      else if (isHandoff(code, l.message)) tally.handoff[code] = (tally.handoff[code] ?? 0) + 1;
      else { const k = `${label}_${code}`; const e = tally.errors[k] ?? (tally.errors[k] = { count: 0, sample: (l.message ?? '').slice(0, 300) }); e.count += 1; }
    };
    const judge = (l: OpLine, label: string, expect: 'ok' | 'denied' | 'withdrawn' | 'typed') => {
      tally.total += 1;
      if (l.ok) { if (expect === 'ok' || expect === 'typed') tally.acked += 1; return; }
      // The deliberate owner-only gate refuses before any access rule runs, so it proves nothing either way: not supported.
      if (isOwnerOnlyRefusal(l)) { tally.refused.owner_only_gate = (tally.refused.owner_only_gate ?? 0) + 1; return; }
      if (expect === 'denied' && DENIED.test(l.code ?? '')) { tally.acked += 1; return; }
      if (expect === 'withdrawn' && /fact_withdrawn/.test(`${l.code} ${l.message}`)) { tally.acked += 1; return; }
      if (expect === 'typed' && /^[a-z]+(_[a-z]+)+$/.test(l.code ?? '') && !/^(internal_error|harness_exception|rpc_error|http_\d+)$/.test(l.code ?? '')) { tally.acked += 1; return; }
      failed(l, label);
    };
    for (const w of writes) judge(w, 'remote_write', 'ok');
    // a. A labelled-only member's write to an unlabelled page refuses and leaves it byte-identical.
    judge(carolWrite, 'labelled_only_write', 'denied');
    const same = JSON.stringify(before.get('open')?.result) === JSON.stringify(after.get('open')?.result);
    if (carolWrite.ok) findings.push('a labelled-only member overwrote an unlabelled page (the write was accepted)');
    if (!same) findings.push('the unlabelled page changed after a labelled-only member tried to write it (not byte-identical)');
    cross['labelled_only_write'] = carolWrite.ok ? 'accepted' : `refused:${carolWrite.code}`;
    // b. A private page never shows in another member's keyword search; its reader finds it (control).
    judge(bobSearch, 'other_member_search', 'ok');
    judge(aliceSearch, 'reader_search', 'ok');
    const hit = (l: OpLine) => rows(l.result).some(r => String(r.slug) === priv);
    if (bobSearch.ok && hit(bobSearch)) findings.push("another member's keyword search returned a private page");
    if (!(aliceSearch.ok && hit(aliceSearch))) notes.push(`control: the private page's own reader did not find it by keyword (${aliceSearch.ok ? 'no hit' : aliceSearch.code}), so the leak probe proves less`);
    cross['private_search_other_member'] = bobSearch.ok ? (hit(bobSearch) ? 'leaked' : 'hidden') : `refused:${bobSearch.code}`;
    cross['private_search_reader'] = aliceSearch.ok ? (hit(aliceSearch) ? 'found' : 'not found') : `refused:${aliceSearch.code}`;
    // c. A hidden page answers byte-identical to a missing page.
    for (const [l, label] of [[hidden, 'hidden_get'], [missing, 'missing_get']] as const) judge(l, label, 'denied');
    for (const [l, label] of [[hiddenTl, 'hidden_timeline'], [missingTl, 'missing_timeline']] as const) judge(l, label, l.ok ? 'ok' : 'denied');
    if (hidden.ok) findings.push("another member read a private page's content with get_page");
    const norm = (l: OpLine & { decoded: string }, slug: string) => l.decoded.split(slug).join('<slug>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
    if (norm(hidden, priv) !== norm(missing, 'private/mw-c7-nobody')) findings.push(`get_page on a hidden page answers differently from a missing page (${hidden.code ?? 'ok'} vs ${missing.code ?? 'ok'})`);
    if (norm(hiddenTl, priv) !== norm(missingTl, 'private/mw-c7-nobody')) findings.push('get_timeline on a hidden page answers differently from a missing page');
    cross['hidden_vs_missing_get_page'] = `${hidden.code ?? 'ok'}/${missing.code ?? 'ok'}/${norm(hidden, priv) === norm(missing, 'private/mw-c7-nobody') ? 'identical' : 'different'}`;
    // d. Out-of-range numbers: any typed answer is fine here; an untyped error is not. Engines are compared in the report.
    // list_pages counts every page the run wrote, which differs between runs, so only its outcome is compared.
    for (const [i, [label]] of numeric.entries()) { judge(numericOut[i]!, `numeric_${label.replace(/\W+/g, '_')}`, 'typed'); cross[`numeric: ${label}`] = label.startsWith('list_pages') ? outcomeClass(numericOut[i]!).replace(/^ok:\d+$/, 'ok') : outcomeClass(numericOut[i]!); }
    // e. A forgotten fact gives the plain withdrawn refusal when the member remembers it again.
    judge(chain.first, 'member_remember', 'ok');
    if (chain.forgot) judge(chain.forgot, 'member_forget', 'ok');
    if (chain.again) {
      judge(chain.again, 'member_reremember', 'withdrawn');
      if (chain.again.ok) findings.push('a member re-remembered the exact text of a fact she had just forgotten and it was accepted');
    } else notes.push(`the forget probe did not reach its last step (remember ${chain.first.code ?? 'ok'}, forget ${chain.forgot?.code ?? 'not run'})`);
    cross['forgotten_reremember'] = !chain.again ? 'not reached' : chain.again.ok ? 'accepted' : `refused:${chain.again.code}: ${(chain.again.message ?? '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>').replace(/"id":\s*"?\d+"?/g, '"id":<n>').slice(0, 200)}`;
    notes.push(`concurrent remote writes: ${writes.filter(w => w.ok).length} of ${writes.length} acknowledged`);
    // Every remote call here uses a member key, never the owner's, so the gate must refuse all of them or none.
    findings.push(...ownerGateFindings(all));
    if (tally.refused.owner_only_gate) notes.push(`the server admits only the brain owner's key for now; ${tally.refused.owner_only_gate} member calls were refused by that gate, so the access rules were not reached`);
    return done(phaseStatus(tally, findings));
  } finally {
    await remote.stop();
  }
}

// ─── 8. Latency (reported, never judged) ──────────────────────────────────────────────────────────────────────────

export async function measureLatency(ctx: Ctx, concurrentPutMs: number[], n = 40): Promise<Record<string, unknown>> {
  const calls: WorkerOp[] = Array.from({ length: n }, (_, i) => ({ op: 'put_page', params: { slug: `mw/c8-serial-${i}`, content: `Serial latency page ${i}.` }, tag: `put:${i}` }));
  const r = await operatorCalls(ctx.brain, ctx.gut, calls);
  const ok = r.ops.filter(o => o.ok).map(o => o.ms).slice(2);
  return {
    serial_put: { n: ok.length, of: n, p50_ms: percentile(ok, 50), p95_ms: percentile(ok, 95), refused_or_failed: r.ops.filter(o => !o.ok).map(o => o.code).slice(0, 3) },
    concurrent_put: { n: concurrentPutMs.length, p50_ms: percentile(concurrentPutMs, 50), p95_ms: percentile(concurrentPutMs, 95) },
    note: 'serial: one engine process creates 40 new pages, first 2 dropped as warm-up; concurrent: the put_page part of the acknowledged compare-and-set rewrites in check 1 (CLI-process writes include process start-up)',
  };
}

// ─── Serial parity transcript ─────────────────────────────────────────────────────────────────────────────────────

/** A fixed single-writer script whose normalized results must be byte-identical on two builds that behave the same. */
export const SERIAL_SCRIPT: WorkerOp[] = [
  { op: 'put_page', params: { slug: 'mw/serial-a', content: '---\ntitle: Serial A\n---\nThe serial page mentions [[mw/serial-b]] and quokkas.' }, tag: 's1' },
  { op: 'put_page', params: { slug: 'mw/serial-b', content: 'Serial page B.' }, tag: 's2' },
  { op: 'get_page', params: { slug: 'mw/serial-a' }, tag: 's3' },
  { op: 'add_tag', params: { slug: 'mw/serial-a', tag: 'serial' }, tag: 's4' },
  { op: 'get_tags', params: { slug: 'mw/serial-a' }, tag: 's5' },
  { op: 'add_link', params: { from: 'mw/serial-b', to: 'mw/serial-a' }, tag: 's6' },
  { op: 'get_backlinks', params: { slug: 'mw/serial-a' }, tag: 's7' },
  { op: 'get_links', params: { slug: 'mw/serial-a' }, tag: 's8' },
  { op: 'add_timeline_entry', params: { slug: 'mw/serial-a', date: '2026-03-01', summary: 'serial first' }, tag: 's9' },
  { op: 'add_timeline_entry', params: { slug: 'mw/serial-a', date: '2026-02-01', summary: 'serial second' }, tag: 's10' },
  { op: 'get_timeline', params: { slug: 'mw/serial-a' }, tag: 's11' },
  { op: 'remember', params: { fact: 'The serial person prefers widget-co tea', entity: 'people/mw-serial', provenance: 'serial' }, tag: 's12' },
  { op: 'recall', params: { entity: 'people/mw-serial' }, tag: 's13' },
  { op: 'search', params: { query: 'quokkas' }, tag: 's14' },
  { op: 'list_pages', params: { slug_prefix: 'mw/serial' }, tag: 's15' },
  { op: 'forget', params: { id: '1' }, tag: 's16' },
  { op: 'recall', params: { entity: 'people/mw-serial' }, tag: 's17' },
  { op: 'remember', params: { fact: 'The serial person prefers widget-co tea', entity: 'people/mw-serial', provenance: 'serial' }, tag: 's18' },
  { op: 'delete_page', params: { slug: 'mw/serial-b', force: true, purge: true }, tag: 's19' },
  { op: 'get_page', params: { slug: 'mw/serial-b' }, tag: 's20' },
  { op: 'get_backlinks', params: { slug: 'mw/serial-a' }, tag: 's21' },
  { op: 'get_timeline', params: { slug: 'mw/serial-a', limit: -1 }, tag: 's22' },
];

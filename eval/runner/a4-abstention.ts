/**
 * BrainBench A4: abstention (eval-category wave amendment 7).
 *
 * Two separate questions, never mixed:
 *
 *   1. Is gbrain's CRAG grade calibrated to evidence? The query operation
 *      attaches a zero-LLM retrieval-confidence grade (strong, moderate,
 *      weak; src/core/search/crag.ts) to every response. Hermetic: the grade
 *      is scored against evidence sufficiency (the gold answer text is in
 *      the top five results) and against answerability from the ledger, as
 *      coarse operating points. The grade grades retrieval; it never
 *      promises to say "I don't know", and an exact title match is strong
 *      with no answer text (capability matrix P5), so a strong grade on an
 *      exact-entity negative is a documented limit, not a bug.
 *   2. Does a defined answerer abstain on unanswerable questions without
 *      refusing answerable ones? gbrain has no keyless answerer, so the
 *      answerer is gbrain's house reader used as a fixed harness reader
 *      (src/eval/longmemeval/reader.ts notes-mode system text, sonnet-4-6,
 *      1,024 output tokens, temperature 0), paid. It reads the top five
 *      query results (retrieved arm) and, as a matched control, the oracle
 *      evidence from the ledger (oracle arm). Answers are scored
 *      deterministically against the ledger's unique values.
 *
 * System One S4 (answerable) is reported separately. S4 off is the reader
 * arm. S4 on needs a TypeSafe key, explicit enabling and a budget guard that
 * can price TypeSafe requests; the guard cannot at this commit, so that arm
 * is recorded as not run. The hermetic arm computes, with gbrain's own
 * reducer inputs (isProtectedResult and the deterministic CRAG grade), on
 * which unanswerable questions S4 could never abstain even when on.
 *
 * Usage: bun eval/runner/a4-abstention.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]]
 *          [--paid --budget-run-id <id>] [--json]
 */
import { join } from 'node:path';
import { budgetOptionsFrom, ledgerStatus, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { paidRequested, requirePaidArm } from './paid-arm.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  A4_DEFAULT_SEED, A4_GENERATOR_VERSION, generateA4World, isAnswerable, renderA4Page,
  type A4Class, type A4Ledger, type A4Question,
} from '../generators/a4-abstention-gen.ts';

export const CATEGORY = 'a4-abstention';
export const READER_MODEL = 'anthropic:claude-sonnet-4-6';
export const READER_MAX_TOKENS = 1024;
export const PAID_ESTIMATE_USD = 3;
const TOP_K = 5;
const CONCURRENCY = 6;

export const ENTRYPOINTS = [
  'operations: put_page, query (response meta retrieval.crag via emitResponseMeta)',
  'src/core/search/crag.ts gradeRetrievalConfidence (S4 reducer input, ignoreDecideEvidence)',
  'src/core/ai/decide/protection.ts isProtectedResult (S4 identity-hit input)',
  'src/eval/longmemeval/reader.ts READER_NOTES_SYSTEM_TEXT, buildReaderUserText (paid answerer)',
  'src/eval/longmemeval/sanitize.ts renderChatBlock (paid answerer)',
  'src/core/ai/gateway.ts chat (paid answerer)',
];

export const GAPS: ReadonlyArray<{ capability: string; reason: string }> = [
  { capability: 'keyless answerer or "I don\'t know" response', reason: 'think without a chat model returns its gather without an answer (src/core/think/index.ts:784,1113-1116); the query op only grades. The keyless path cannot abstain, so A4 defines a paid harness answerer.' },
  { capability: 'attribute-level sufficiency in the CRAG grade', reason: 'the grade reads rank-1 evidence labels; an exact title match is strong whether or not the asked-for attribute is present (crag.ts:67-106, matrix P5).' },
  { capability: 'S4 abstention on exact-entity questions', reason: 'reduceAnswerable passes whenever there is an identity hit or a strong deterministic grade (answerable.ts:62-68), so S4 cannot abstain on a missing attribute of a company whose page matches exactly.' },
  { capability: 'S4 on arm', reason: 'needs a TypeSafe key and explicit enabling; the budget ledger (eval/runner/budget-ledger.ts PAID_HOSTS) prices OpenAI, Anthropic, Voyage and OpenRouter only, so TypeSafe requests would spend outside the guard. Not run.' },
];

const LEVEL_RANK: Record<string, number> = { weak: 0, moderate: 1, strong: 2 };

// ─── Pure scoring (exported for tests) ───────────────────────────────────

export type Outcome = 'correct' | 'wrong_source' | 'wrong' | 'abstain' | 'unscorable' | 'error';

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
/** Patterns that look like an answer to each attribute (a stated value, right or wrong). */
const ANSWER_SHAPE: Record<string, RegExp> = {
  headcount: /\b\d+\s*(employees|people|staff|headcount)\b/i,
  runway: /\b\d+\s*months?\b/i,
  arr: /\$?\s*\d+(\.\d+)?\s*(m\b|million)/i,
  founded: new RegExp(`\\b((${MONTHS})\\s+)?(19|20)\\d{2}\\b`, 'i'),
  hq: /$^/,
  ceo: /$^/,
};
export const ABSTAIN_RE = /(not available|don['’]t know|do not know|no information|not enough information|insufficient|not (?:contain|include|mention|specify|state|provide|list)|does(?:n['’]t| not) (?:contain|include|mention|specify|state|say|provide|list)|(?:is|are)n['’]t (?:mentioned|available|specified|stated|provided|listed)|(?:is|are) not (?:mentioned|available|specified|stated|provided|given|listed)|cannot (?:be )?determined?|can['’]t (?:be )?determined?|unable to (?:determine|answer|find)|no mention|not (?:possible|able) to (?:determine|answer))/i;

const norm = (s: string) => s.toLowerCase().replace(/(\d),(\d)/g, '$1$2').replace(/[*_`]/g, '').replace(/\s+/g, ' ');

/** The reader's final answer: after the last "final answer" marker, else the last paragraph. */
export function finalAnswer(text: string): string {
  const marks = [...text.matchAll(/final answer\s*[:\-]?\s*\**\s*/gi)];
  if (marks.length) {
    const m = marks[marks.length - 1];
    return text.slice((m.index ?? 0) + m[0].length).trim();
  }
  const paras = text.trim().split(/\n\s*\n/);
  return (paras[paras.length - 1] ?? '').trim();
}

/** Does `text` state `value`? Numeric values match on their number with the unit's shape. */
export function states(text: string, attribute: string, value: string): boolean {
  const t = norm(text);
  const v = norm(value);
  if (t.includes(v)) return true;
  const num = /(\d+(?:\.\d+)?)/.exec(v)?.[1];
  if (!num || attribute === 'founded') return false;
  const esc = num.replace('.', '\\.');
  const shapes: Record<string, RegExp> = {
    headcount: new RegExp(`\\b${esc}\\s*(employees|people|staff)?\\b`),
    runway: new RegExp(`\\b${esc}\\s*months?\\b`),
    arr: new RegExp(`\\$?\\s*${esc}\\s*(m\\b|million)`),
  };
  return shapes[attribute]?.test(t) ?? false;
}

export function scoreAnswer(q: Pick<A4Question, 'attribute' | 'answer' | 'sibling_value'>, text: string, values: Record<string, readonly string[]>): { outcome: Outcome; final: string; hedged: boolean } {
  const final = finalAnswer(text);
  const abstains = ABSTAIN_RE.test(final);
  if (q.answer && states(final, q.attribute, q.answer)) return { outcome: 'correct', final, hedged: abstains };
  const others = (values[q.attribute] ?? []).filter(v => v !== q.answer && states(final, q.attribute, v));
  if ((q.sibling_value && states(final, q.attribute, q.sibling_value)) || others.length) return { outcome: 'wrong_source', final, hedged: abstains };
  if (ANSWER_SHAPE[q.attribute]?.test(norm(final))) return { outcome: 'wrong', final, hedged: abstains };
  if (abstains) return { outcome: 'abstain', final, hedged: false };
  return { outcome: 'unscorable', final, hedged: false };
}

export interface ArmMetrics {
  n: number; answerable: number; unanswerable: number;
  correct_useful_rate: number | null; false_refusal_rate: number | null; wrong_answerable_rate: number | null;
  unanswerable_answer_rate: number | null; abstain_recall: number | null; abstain_precision: number | null;
  coverage: number | null; risk: number | null; utility_l1: number; utility_l4: number;
  counts: Record<string, Record<Outcome, number>>;
  errors: number;
}

const ratio = (a: number, b: number) => (b ? a / b : null);
const emptyCounts = (): Record<Outcome, number> => ({ correct: 0, wrong_source: 0, wrong: 0, abstain: 0, unscorable: 0, error: 0 });

/** Metrics over scored answers (preregistered definitions; errors are excluded from every denominator and counted). */
export function armMetrics(rows: ReadonlyArray<{ cls: A4Class; outcome: Outcome }>): ArmMetrics {
  const ok = rows.filter(r => r.outcome !== 'error');
  const ans = ok.filter(r => isAnswerable(r.cls));
  const una = ok.filter(r => !isAnswerable(r.cls));
  const attempted = ok.filter(r => r.outcome !== 'abstain');
  const wrongish = (r: { outcome: Outcome }) => r.outcome === 'wrong' || r.outcome === 'wrong_source' || r.outcome === 'unscorable';
  const abst = ok.filter(r => r.outcome === 'abstain');
  const counts: ArmMetrics['counts'] = {};
  for (const r of rows) (counts[r.cls] ??= emptyCounts())[r.outcome]++;
  const correct = ans.filter(r => r.outcome === 'correct').length;
  const wrong = attempted.filter(r => wrongish(r) || (!isAnswerable(r.cls))).length;
  return {
    n: ok.length, answerable: ans.length, unanswerable: una.length,
    correct_useful_rate: ratio(correct, ans.length),
    false_refusal_rate: ratio(ans.filter(r => r.outcome === 'abstain').length, ans.length),
    wrong_answerable_rate: ratio(ans.filter(wrongish).length, ans.length),
    unanswerable_answer_rate: ratio(una.filter(r => r.outcome !== 'abstain').length, una.length),
    abstain_recall: ratio(una.filter(r => r.outcome === 'abstain').length, una.length),
    abstain_precision: ratio(abst.filter(r => !isAnswerable(r.cls)).length, abst.length),
    coverage: ratio(attempted.length, ok.length),
    risk: ratio(wrong, attempted.length),
    utility_l1: correct - wrong,
    utility_l4: correct - 4 * wrong,
    counts,
    errors: rows.length - ok.length,
  };
}

/** Preregistered report wording: does the answerer abstain usefully? */
export function abstainsUsefully(m: ArmMetrics): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!((m.abstain_recall ?? 0) >= 0.8)) failed.push('abstain recall < 0.80');
  if (!((m.false_refusal_rate ?? 1) <= 0.1)) failed.push('false refusal rate > 0.10');
  return { pass: failed.length === 0, failed };
}

export interface Retrieval { id: string; cls: A4Class; grade: string | null; reason: string | null; slugs: string[]; texts: string[]; sufficient: boolean; s4: { asked: boolean; identity_hit: boolean; strong_grade: boolean }; lookup?: { grade: string | null; reason: string | null; s4_blocked: boolean }; top1?: { evidence: string | null; keyword_relaxed: boolean } }

/** CRAG grade summaries against evidence sufficiency and answerability (hermetic). */
export function cragSummary(rs: readonly Retrieval[]) {
  const withMeta = rs.filter(r => r.grade !== null).length;
  const answerable = rs.filter(r => isAnswerable(r.cls));
  const byClass: Record<string, Record<string, number>> = {};
  for (const r of rs) { const row = byClass[r.cls] ??= { strong: 0, moderate: 0, weak: 0, missing: 0 }; row[r.grade ?? 'missing']++; }
  const reasons: Record<string, Record<string, number>> = {};
  for (const r of rs) { const row = reasons[r.cls] ??= {}; row[r.reason ?? 'missing'] = (row[r.reason ?? 'missing'] ?? 0) + 1; }
  const points = (['strong', 'moderate', 'weak'] as const).map(level => {
    const covered = rs.filter(r => r.grade !== null && LEVEL_RANK[r.grade] >= LEVEL_RANK[level]);
    const suff = rs.filter(r => r.sufficient);
    return {
      answer_when_grade_at_least: level,
      coverage: ratio(covered.length, rs.length),
      risk_insufficient_evidence: ratio(covered.filter(r => !r.sufficient).length, covered.length),
      risk_unanswerable: ratio(covered.filter(r => !isAnswerable(r.cls)).length, covered.length),
      sufficient_evidence_kept: ratio(covered.filter(r => r.sufficient).length, suff.length),
    };
  });
  const una = rs.filter(r => !isAnswerable(r.cls));
  const lookupByClass: Record<string, Record<string, number>> = {};
  for (const r of rs.filter(x => x.lookup)) { const row = lookupByClass[r.cls] ??= { strong: 0, moderate: 0, weak: 0, missing: 0 }; row[r.lookup!.grade ?? 'missing']++; }
  return {
    calls: rs.length,
    meta_coverage: ratio(withMeta, rs.length) ?? 0,
    answerable_evidence_rate: ratio(answerable.filter(r => r.sufficient).length, answerable.length) ?? 0,
    by_class: byClass,
    reasons_by_class: reasons,
    operating_points: points,
    entity_lookup_by_class: lookupByClass,
    top1_keyword_relaxed_by_class: Object.fromEntries([...new Set(rs.map(r => r.cls))].map(c => [c, `${rs.filter(r => r.cls === c && r.top1?.keyword_relaxed).length}/${rs.filter(r => r.cls === c).length}`])),
    strong_on_unanswerable: { hits: una.filter(r => r.grade === 'strong').length, n: una.length, by_class: Object.fromEntries((['missing_attribute', 'sibling_attribute', 'absent_entity'] as const).map(c => [c, `${una.filter(r => r.cls === c && r.grade === 'strong').length}/${una.filter(r => r.cls === c).length}`])) },
  };
}

export function s4Summary(rs: readonly Retrieval[]) {
  const una = rs.filter(r => !isAnswerable(r.cls));
  const blocked = (r: Retrieval) => r.s4.asked && (r.s4.identity_hit || r.s4.strong_grade);
  return {
    unanswerable: una.length,
    not_asked_no_evidence: una.filter(r => !r.s4.asked).length,
    blocked_from_abstaining: una.filter(blocked).length,
    blocked_by_class: Object.fromEntries((['missing_attribute', 'sibling_attribute', 'absent_entity'] as const).map(c => [c, `${una.filter(r => r.cls === c && blocked(r)).length}/${una.filter(r => r.cls === c).length}`])),
    identity_hit: una.filter(r => r.s4.asked && r.s4.identity_hit).length,
    blocked_on_entity_lookup_evidence: Object.fromEntries((['missing_attribute', 'sibling_attribute', 'absent_entity'] as const).map(c => [c, `${una.filter(r => r.cls === c && r.lookup?.s4_blocked).length}/${una.filter(r => r.cls === c).length}`])),
    strong_grade: una.filter(r => r.s4.asked && r.s4.strong_grade).length,
    note: 'S4 abstains only when p < threshold - margin, coverage is complete, and neither an identity hit nor a strong deterministic grade is present (answerable.ts reduceAnswerable). Evidence here is the query top five; think gathers its own evidence, so this is an estimate of the structural ceiling, not a measurement of S4 on.',
  };
}

// ─── gbrain wiring ───────────────────────────────────────────────────────

type Engine = { connect(c: Record<string, unknown>): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; executeRaw<T>(q: string, p?: unknown[]): Promise<T[]> };
type Result = { slug: string; chunk_text: string; evidence?: string; exact_lookup?: unknown; alias_hit?: boolean; keyword_relaxed?: boolean };

export async function retrieveAll(gut: GbrainUnderTest, ledger: A4Ledger, log: (s: string) => void): Promise<{ rows: Retrieval[]; presence: Array<{ name: string; ok: boolean; expected: number; actual: number; detail?: string }>; seed_ms: number; probe_ms: number }> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (c: unknown, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const { gradeRetrievalConfidence } = await importGbrain<{ gradeRetrievalConfidence: (r: Result[], o?: Record<string, unknown>) => { level: string } }>(gut, 'src/core/search/crag.ts');
  const { isProtectedResult } = await importGbrain<{ isProtectedResult: (r: Result) => boolean }>(gut, 'src/core/ai/decide/protection.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  let meta: Record<string, unknown> | null = null;
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default', emitResponseMeta: (k: string, m: Record<string, unknown>) => { if (k === 'retrieval') meta = m; } };
  const op = (name: string, p: Record<string, unknown>) => operations.find(o => o.name === name)!.handler(ctx, p);
  const presence: Array<{ name: string; ok: boolean; expected: number; actual: number; detail?: string }> = [];
  try {
    const t0 = Date.now();
    const errors: string[] = [];
    for (const p of ledger.pages) {
      try { await op('put_page', { slug: p.slug, content: renderA4Page(p) }); } catch (e) { errors.push(`${p.slug}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const seed_ms = Date.now() - t0;
    presence.push({ name: 'pages written without error', ok: errors.length === 0, expected: ledger.pages.length, actual: ledger.pages.length - errors.length, detail: errors[0] });
    const chunks = await engine.executeRaw<{ slug: string; chunk_text: string }>('SELECT p.slug, c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id');
    const bySlug = new Map<string, string>();
    for (const c of chunks) bySlug.set(c.slug, `${bySlug.get(c.slug) ?? ''}\n${c.chunk_text}`);
    const answerable = ledger.questions.filter(q => q.answer);
    const landed = answerable.filter(q => (bySlug.get(q.answer_slug!) ?? '').includes(q.answer!)).length;
    presence.push({ name: 'answer text present in a stored chunk of its page', ok: landed === answerable.length, expected: answerable.length, actual: landed });
    if (presence.some(p => !p.ok)) return { rows: [], presence, seed_ms, probe_ms: 0 };
    log(`querying ${ledger.questions.length} questions`);
    const t1 = Date.now();
    const rows: Retrieval[] = [];
    for (const q of ledger.questions) {
      meta = null;
      let results: Result[] = [];
      try { results = (await op('query', { query: q.question, limit: TOP_K, expand: false })) as Result[]; }
      catch (e) { log(`query error ${q.id}: ${e instanceof Error ? e.message : String(e)}`); }
      const m = meta as { crag?: { confidence?: string; reason?: string } } | null;
      const top = results.slice(0, TOP_K);
      rows.push({
        id: q.id, cls: q.cls, grade: m?.crag?.confidence ?? null, reason: m?.crag?.reason ?? null,
        slugs: top.map(r => r.slug), texts: top.map(r => r.chunk_text),
        sufficient: q.answer !== null && top.some(r => r.chunk_text.includes(q.answer!)),
        top1: { evidence: top[0]?.evidence ?? null, keyword_relaxed: top[0]?.keyword_relaxed === true },
        s4: { asked: top.length > 0, identity_hit: top.some(r => isProtectedResult(r)), strong_grade: top.length > 0 && gradeRetrievalConfidence(top, { ignoreDecideEvidence: true }).level === 'strong' },
      });
    }
    // Exploratory: the same companies looked up by name alone, where the title boost can fire.
    for (const row of rows) {
      const q = ledger.questions.find(x => x.id === row.id)!;
      meta = null;
      let results: Result[] = [];
      try { results = (await op('query', { query: q.entity, limit: TOP_K, expand: false })) as Result[]; } catch { /* scored as missing grade */ }
      const m = meta as { crag?: { confidence?: string; reason?: string } } | null;
      const top = results.slice(0, TOP_K);
      row.lookup = { grade: m?.crag?.confidence ?? null, reason: m?.crag?.reason ?? null, s4_blocked: top.length > 0 && (top.some(r => isProtectedResult(r)) || gradeRetrievalConfidence(top, { ignoreDecideEvidence: true }).level === 'strong') };
    }
    return { rows, presence, seed_ms, probe_ms: Date.now() - t1 };
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

// ─── Paid answerer ───────────────────────────────────────────────────────

export interface AnswerRow { id: string; cls: A4Class; arm: 'retrieved' | 'oracle'; outcome: Outcome; final: string; hedged: boolean; text?: string; error?: string; usage?: { input: number; output: number } }

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function runPaid(gut: GbrainUnderTest, ledger: A4Ledger, retrieved: readonly Retrieval[], anthropicKey: string, argv: readonly string[], log: (s: string) => void): Promise<{ answers: AnswerRow[]; cost: RunSummary | null; reader: Record<string, unknown> }> {
  const { run, guard } = startPaidRun(CATEGORY, { ...budgetOptionsFrom(argv), estimateUsd: PAID_ESTIMATE_USD, log });
  let out: { answers: AnswerRow[]; cost: RunSummary | null; reader: Record<string, unknown> } | undefined;
  try {
    out = await withHermeticEnv('a4-paid', async () => {
      process.env.ANTHROPIC_API_KEY = anthropicKey;
      const gw = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; chat: (o: Record<string, unknown>) => Promise<{ text: string; usage: { input_tokens?: number; output_tokens?: number } }> }>(gut, 'src/core/ai/gateway.ts');
      const reader = await importGbrain<{ READER_NOTES_SYSTEM_TEXT: string; READER_NOTES_PROMPT_VERSION: string; READER_MAX_SESSION_CHARS: number; buildReaderUserText: (i: { question: string; rendered: string }) => string }>(gut, 'src/eval/longmemeval/reader.ts');
      const { renderChatBlock } = await importGbrain<{ renderChatBlock: (s: Array<{ session_id: string; body: string }>, o: { maxSessionChars?: number }) => { rendered: string } }>(gut, 'src/eval/longmemeval/sanitize.ts');
      gw.configureGateway({ chat_model: READER_MODEL, env: { ANTHROPIC_API_KEY: anthropicKey } });
      const pageBody = new Map(ledger.pages.map(p => [p.slug, p.body]));
      const byId = new Map(retrieved.map(r => [r.id, r]));
      const jobs = ledger.questions.flatMap(q => (['retrieved', 'oracle'] as const).map(arm => ({ q, arm })));
      log(`paid reader (${READER_MODEL}) over ${jobs.length} requests`);
      const answers = await pool(jobs, CONCURRENCY, async ({ q, arm }): Promise<AnswerRow> => {
        const sessions = arm === 'retrieved'
          ? byId.get(q.id)!.slugs.map((slug, i) => ({ session_id: slug, body: byId.get(q.id)!.texts[i] }))
          : q.oracle_slugs.map(slug => ({ session_id: slug, body: pageBody.get(slug)! }));
        const { rendered } = renderChatBlock(sessions, { maxSessionChars: reader.READER_MAX_SESSION_CHARS });
        const content = reader.buildReaderUserText({ question: q.question, rendered });
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          if (guard.exhausted) break;
          try {
            const res = await gw.chat({ model: READER_MODEL, system: reader.READER_NOTES_SYSTEM_TEXT, messages: [{ role: 'user', content }], maxTokens: READER_MAX_TOKENS, temperature: 0 });
            const s = scoreAnswer(q, res.text, ledger.values);
            return { id: q.id, cls: q.cls, arm, ...s, text: res.text, usage: { input: res.usage.input_tokens ?? 0, output: res.usage.output_tokens ?? 0 } };
          } catch (e) { lastError = e instanceof Error ? e.message : String(e); }
        }
        return { id: q.id, cls: q.cls, arm, outcome: 'error', final: '', hedged: false, error: lastError || 'budget exhausted' };
      });
      return { answers, cost: null, reader: { model: READER_MODEL, system_prompt_version: reader.READER_NOTES_PROMPT_VERSION, max_tokens: READER_MAX_TOKENS, temperature: 0, rendering: 'renderChatBlock, one block per result, session id = page slug, no date', concurrency: CONCURRENCY, retries: 1 } };
    });
  } finally {
    guard.uninstall();
    const summary = run.close();
    if (out) out.cost = summary;
  }
  return out;
}

/** The CRAG-gated reader: arm 1's answers, replaced by an abstention when the grade is below `level`. */
export function gated(answers: readonly AnswerRow[], retrieved: readonly Retrieval[], level: 'strong' | 'moderate'): Array<{ cls: A4Class; outcome: Outcome }> {
  const grade = new Map(retrieved.map(r => [r.id, r.grade]));
  return answers.filter(a => a.arm === 'retrieved').map(a => ({ cls: a.cls, outcome: a.outcome === 'error' ? 'error' : (LEVEL_RANK[grade.get(a.id) ?? 'weak'] >= LEVEL_RANK[level] ? a.outcome : 'abstain') }));
}

export function paidSummary(answers: readonly AnswerRow[], retrieved: readonly Retrieval[]) {
  const arm = (k: 'retrieved' | 'oracle') => answers.filter(a => a.arm === k);
  const retrievedM = armMetrics(arm('retrieved'));
  const oracleM = armMetrics(arm('oracle'));
  const oracleCorrect = new Set(arm('oracle').filter(a => a.outcome === 'correct').map(a => a.id));
  const refused = arm('retrieved').filter(a => isAnswerable(a.cls) && a.outcome === 'abstain');
  const pairs = arm('retrieved').map(a => ({ a, o: arm('oracle').find(o => o.id === a.id)! })).filter(x => x.o && isAnswerable(x.a.cls));
  return {
    retrieved: { ...retrievedM, decision: abstainsUsefully(retrievedM) },
    oracle: { ...oracleM, decision: abstainsUsefully(oracleM) },
    crag_gated: {
      strong: armMetrics(gated(answers, retrieved, 'strong')),
      moderate_or_strong: armMetrics(gated(answers, retrieved, 'moderate')),
    },
    false_refusal_cost: { refused_answerable_retrieved: refused.length, of_which_oracle_answered_correctly: refused.filter(a => oracleCorrect.has(a.id)).length, answerable: arm('retrieved').filter(a => isAnswerable(a.cls)).length },
    paired_answerable_correct: { both: pairs.filter(x => x.a.outcome === 'correct' && x.o.outcome === 'correct').length, retrieved_only: pairs.filter(x => x.a.outcome === 'correct' && x.o.outcome !== 'correct').length, oracle_only: pairs.filter(x => x.a.outcome !== 'correct' && x.o.outcome === 'correct').length, neither: pairs.filter(x => x.a.outcome !== 'correct' && x.o.outcome !== 'correct').length },
    hedged_answers: answers.filter(a => a.hedged).length,
    sensitivity_hedged_as_abstain: {
      note: 'not preregistered: answers that say the information is unavailable but also name another value, read as abstentions instead of answers',
      retrieved: armMetrics(arm('retrieved').map(a => ({ cls: a.cls, outcome: a.hedged && a.outcome !== 'correct' ? 'abstain' as Outcome : a.outcome }))),
      oracle: armMetrics(arm('oracle').map(a => ({ cls: a.cls, outcome: a.hedged && a.outcome !== 'correct' ? 'abstain' as Outcome : a.outcome }))),
    },
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}
const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? A4_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const paid = paidRequested(argv);
  const budget = paid ? requirePaidArm(argv, { arm: 'A4 answer arm', estimateUsd: PAID_ESTIMATE_USD }) : null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (paid && !anthropicKey) throw new Error('A4 paid arm needs ANTHROPIC_API_KEY (the house reader is anthropic:claude-sonnet-4-6)');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench A4: abstention (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const world = generateA4World({ seed });
  const { ledger } = world;
  let harnessError: string | null = null;
  const t0 = Date.now();
  const h = await withHermeticEnv('a4', () => retrieveAll(gut, ledger, log)).catch(e => { harnessError = `harness: ${e instanceof Error ? e.message : String(e)}`; return null; });
  const hermeticMs = Date.now() - t0;
  if (h && h.presence.some(p => !p.ok)) harnessError = `presence assertions failed: ${h.presence.filter(p => !p.ok).map(p => `${p.name} expected ${p.expected} got ${p.actual}${p.detail ? ` (${p.detail})` : ''}`).join('; ')}`;
  const crag = h && !harnessError ? cragSummary(h.rows) : null;
  const s4 = h && !harnessError ? s4Summary(h.rows) : null;
  let paidOut: Awaited<ReturnType<typeof runPaid>> | null = null;
  let paidError: string | null = null;
  if (paid && h && !harnessError) {
    try { paidOut = await runPaid(gut, ledger, h.rows, anthropicKey, argv, log); }
    catch (e) { paidError = e instanceof Error ? e.message : String(e); }
    const st = ledgerStatus({ runId: budget!.budgetRunId });
    log(`[budget] run ${budget!.budgetRunId}: $${st.run?.remaining_usd.toFixed(2)} left`);
  }
  const ps = paidOut ? paidSummary(paidOut.answers, h!.rows) : null;
  const errors = [
    ...(harnessError ? [{ probe_id: 'run', origin: 'harness' as const, message: harnessError }] : []),
    ...(paidError ? [{ probe_id: 'paid', origin: 'dependency' as const, message: paidError }] : []),
  ];
  const qualityPass = crag !== null && crag.meta_coverage >= 1 && crag.answerable_evidence_rate >= 0.8;
  const receipt: Receipt = {
    ...(paidOut ? {} : noModelSpend('hermetic: provider keys stripped, keyword search only; no model and no paid request')),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: harnessError ? 'error' : 'completed',
    ...(harnessError ? {} : { verdict: qualityPass ? 'pass' : 'fail' }),
    n_total: ledger.questions.length,
    n_scored: harnessError ? 0 : ledger.questions.length,
    completion_rate: harnessError ? 0 : 1,
    errors,
    publishable: !harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory',
      decide: DECIDE_OFF,
      caller: 'operation handlers with OperationContext { remote: false, sourceId: default }',
      search_path: `query operation, expand=false, limit=${TOP_K}; no embedding gateway (keyword only); search.crag_escalation and search.crag_think at defaults (off)`,
      seed, generator_version: A4_GENERATOR_VERSION, ledger_sha256: world.fingerprint,
      answerer: paidOut ? paidOut.reader : 'not run (hermetic)',
      s4_on: 'not run: needs a TypeSafe key, explicit enabling, and a budget guard that prices TypeSafe requests (PAID_HOSTS lacks TypeSafe)',
      entrypoints: ENTRYPOINTS,
      gbrain_overlay: overlaySummary(gut),
      paid: paid ? { budget_run_id: budget?.budgetRunId ?? null, provider_keys: ['ANTHROPIC_API_KEY'], error: paidError, evidence: 'the retrieved arm reads exactly the hermetic arm\'s top five query results' } : null,
      verdict_rule: 'verdict = the preregistered quality thresholds (crag meta on every call; answerable evidence floor 0.80); every other metric lives in data and never changes the verdict',
    },
    hashes: { ledger_sha256: world.fingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      crag,
      s4,
      presence: h?.presence ?? [],
      timings_ms: { hermetic_total: hermeticMs, seed: h?.seed_ms ?? null, queries: h?.probe_ms ?? null },
      gaps: GAPS,
      rows: h?.rows.map(r => ({ id: r.id, cls: r.cls, grade: r.grade, reason: r.reason, slugs: r.slugs, sufficient: r.sufficient, s4: r.s4, lookup: r.lookup ?? null, top1: r.top1 ?? null })) ?? [],
      paid: ps ? { ...ps, answers: paidOut!.answers.map(a => ({ id: a.id, cls: a.cls, arm: a.arm, outcome: a.outcome, hedged: a.hedged, final: a.final.slice(0, 400), error: a.error ?? null })) } : null,
      harness_error: harnessError,
    },
  };
  if (paidOut?.cost) receipt.cost = receiptCost(paidOut.cost);
  writeReceipt(outPath, receipt);

  log(`\nverdict: ${receipt.verdict ?? 'error'}`);
  if (crag) {
    log(`quality: crag meta on ${pct(crag.meta_coverage)} of ${crag.calls} query calls (target 100%); answer text in the top ${TOP_K} for ${pct(crag.answerable_evidence_rate)} of 120 answerable (floor 80%)`);
    log(`CRAG grade by class: ${JSON.stringify(crag.by_class)}`);
    log(`entity-name lookups, grade by class: ${JSON.stringify(crag.entity_lookup_by_class)}`);
    log(`strong on unanswerable: ${crag.strong_on_unanswerable.hits}/${crag.strong_on_unanswerable.n} (${JSON.stringify(crag.strong_on_unanswerable.by_class)})`);
    for (const p of crag.operating_points) log(`  answer when grade >= ${p.answer_when_grade_at_least}: coverage ${pct(p.coverage)}, risk (no evidence) ${pct(p.risk_insufficient_evidence)}, risk (unanswerable) ${pct(p.risk_unanswerable)}`);
  }
  if (s4) log(`S4 could not abstain on ${s4.blocked_from_abstaining}/${s4.unanswerable} unanswerable questions even if on (${JSON.stringify(s4.blocked_by_class)}); S4 on arm: not run`);
  if (ps) {
    for (const k of ['retrieved', 'oracle'] as const) {
      const m = ps[k];
      log(`reader, ${k} evidence: correct useful ${pct(m.correct_useful_rate)}, false refusal ${pct(m.false_refusal_rate)}, unanswerable answered ${pct(m.unanswerable_answer_rate)}, abstain recall ${pct(m.abstain_recall)}, precision ${pct(m.abstain_precision)}, coverage ${pct(m.coverage)}, risk ${pct(m.risk)}, utility(l=1) ${m.utility_l1}, errors ${m.errors}; ${m.decision.pass ? 'abstains usefully' : `does not abstain usefully (${m.decision.failed.join('; ')})`}`);
    }
    log(`CRAG-gated reader: strong-only utility(l=1) ${ps.crag_gated.strong.utility_l1}, moderate+ ${ps.crag_gated.moderate_or_strong.utility_l1}`);
    log(`false-refusal cost: ${ps.false_refusal_cost.refused_answerable_retrieved} answerable refused on retrieved evidence, ${ps.false_refusal_cost.of_which_oracle_answered_correctly} of them answered correctly on oracle evidence`);
  }
  if (paidError) log(`paid arm error: ${paidError}`);
  if (harnessError) log(`run error: ${harnessError}`);
  log('gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (A4-*)');
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, crag, s4 }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : receipt.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

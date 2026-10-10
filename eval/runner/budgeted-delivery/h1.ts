/**
 * The budgeted delivery H1 custody steps (preregistration
 * docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1-preregistration.md, decision directory
 * docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/). They run on the custodian's machine, inside one custody
 * root, around the memory-qa cells and the sealed runner that h1-run.sh chains:
 *
 *   custody-check  the sealed files hash to the manifest's commitments (the labels are hashed, never parsed) and the
 *                  access log holds exactly the state the decision file records, plus only this decision's lines
 *   corpus         questions.json to a label-free memory-qa custody corpus (no kinds, gold chats or answers); the
 *                  open is logged before the questions are parsed
 *   gate           guards 1, 3 and 4 (and the structural guard 5) on the frozen evidence and reader contexts, with
 *                  the renderer identity, before any label is read; refuses once a score line for this decision exists
 *   answers        each reader arm's answers as sealed-runner run files (the packed chats as `retrieved`)
 *   decide         the preregistered rule over the gate, compare.ts's output and the two primary score reports
 *   budget         spend per step against the decision's estimates and caps, numbers only
 *   export         the aggregates a custodian may copy out, scanned for every question, chat and haystack id
 *   return-log     the access log back to the owner's file, refusing any line that is not this decision's
 *   parity         (keyless dry run) frozen lists and delivered evidence of two gbrain commits on one fixture
 *
 *   bun eval/runner/budgeted-delivery/h1.ts <step> --custody-root <dir> --decision <decision.json> ...
 *
 * Every destination must sit inside the custody root, outside the repository and outside the shared caches
 * (memory-qa/sealed-profile.ts). No step opens labels.json: labels are read only by `sealed-confirmation.ts score`,
 * which checks the commitment and appends the access-log line first.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { appendAccessLog, assertCommitment, sha256File, sha256Hex, validateQuestionsFile, type QuestionsFile } from '../sealed-confirmation-lib.ts';
import { loadCustodyCorpus, type Corpus, type MemoryQuestion, type Session } from '../memory-qa/corpus.ts';
import { checkCustodyPaths, exportCell } from '../memory-qa/sealed-profile.ts';
import { opaqueSourceId } from '../systems/sanitize.ts';
import { sourceOfSlug } from '../systems/gbrain.ts';
import { blocksToItems, packRecipe } from '../systems/render.ts';
import { recipeHash, type ArmsSpec } from '../memory-qa/arms.ts';
import { armRows, capGuard, contextGuard, deliveryStats, guard1, kindGuard, retrievalRows } from './e2-readings.ts';

type Row = Record<string, any>;

// ─── The decision file ────────────────────────────────────────────

export interface H1AnswerArm { id: string; role: 'candidate' | 'control' | 'reference'; reader: string; model: string; packing: string; variant: string; recipe: string; memory_qa_arm: string }
export interface H1Rule {
  family: string;
  primary_comparison: string;
  control_arm: string;
  candidate_arm: string;
  alpha: number;
  max_reader_errors: number;
  guard7: { min_questions: number; share_of_kind: number };
  expected_label_reads: number;
}
export interface H1Decision {
  schema: string;
  decision_id: string;
  sealed: {
    set: string; manifest: string; questions_sha256: string; labels_sha256: string; questions: number; personas: number;
    kinds: Record<string, number>;
    access_log_before: { lines: number; entries: Array<{ action: string; decision_id: string | null }> };
  };
  gbrain: { commit: string; version: string };
  construction: {
    b_pseudo: number; harness_budget_tokens: number; query_limit: number;
    recipes: Record<string, { items: string; render: 'pseudo-session'; hash: string }>;
    renderer: { dated_renderer_version: string; reader_template_sha256: string };
  };
  answer_arms: H1AnswerArm[];
  rule: H1Rule;
}

export function loadDecision(path: string): { decision: H1Decision; sha256: string } {
  const bytes = readFileSync(path);
  const decision = JSON.parse(bytes.toString('utf8')) as H1Decision;
  if (decision.schema !== 'gbrain-evals/budgeted-delivery-h1-decision/v1') throw new Error(`${path} is not an H1 decision file`);
  return { decision, sha256: sha256Hex(bytes) };
}

const arm = (d: H1Decision, id: string) => { const a = d.answer_arms.find(x => x.id === id); if (!a) throw new Error(`the decision has no answer arm ${id}`); return a; };
const writeJson = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };

// ─── custody-check ────────────────────────────────────────────────

interface Manifest { set: string; commitments: Record<string, { sha256: string; bytes: number }> }

export interface LogEntry { action: string; decision_id: string | null; at?: string }
export const readLog = (path: string): LogEntry[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];

/**
 * The access log must start with exactly the entries the decision file records (action and decision id, in order),
 * and every later line must belong to this decision (a resumed run). Anything else stops the run before any read.
 */
export function checkAccessLog(entries: LogEntry[], d: H1Decision): { lines: number; before: number; this_decision: number } {
  const before = d.sealed.access_log_before;
  if (entries.length < before.lines) throw new Error(`the access log has ${entries.length} lines; the decision file records ${before.lines} before this opening`);
  before.entries.forEach((e, i) => {
    if (entries[i].action !== e.action || (entries[i].decision_id ?? null) !== e.decision_id) throw new Error(`access log line ${i + 1} is ${entries[i].action} for ${entries[i].decision_id}; the decision file records ${e.action} for ${e.decision_id}`);
  });
  const foreign = entries.slice(before.lines).filter(e => e.decision_id !== d.decision_id);
  if (foreign.length) throw new Error(`${foreign.length} access-log lines after the recorded state belong to another decision; stop and ask the owner`);
  return { lines: entries.length, before: before.lines, this_decision: entries.length - before.lines };
}

export function custodyCheck(o: { custodyRoot: string; decision: H1Decision; manifestPath: string; questions: string; labels: string; log: string }) {
  checkCustodyPaths(o.custodyRoot, [['questions file', o.questions], ['labels file', o.labels], ['access log', o.log]]);
  const m = JSON.parse(readFileSync(o.manifestPath, 'utf8')) as Manifest;
  if (m.set !== o.decision.sealed.set) throw new Error(`the manifest is for ${m.set}, the decision for ${o.decision.sealed.set}`);
  const qc = m.commitments['questions.json'], lc = m.commitments['labels.json'];
  if (qc?.sha256 !== o.decision.sealed.questions_sha256 || lc?.sha256 !== o.decision.sealed.labels_sha256) throw new Error('the manifest commitments differ from the ones the decision file records');
  assertCommitment(o.questions, { file: 'questions.json', ...qc });
  const labelBytes = readFileSync(o.labels);
  if (sha256Hex(labelBytes) !== lc.sha256 || labelBytes.length !== lc.bytes) throw new Error('labels.json does not match its commitment (hashed only; nothing was parsed)');
  const log = checkAccessLog(readLog(o.log), o.decision);
  return { decision_id: o.decision.decision_id, checked_at: new Date().toISOString(), questions_sha256: qc.sha256, labels_sha256: lc.sha256, labels_parsed: false, access_log: log };
}

// ─── corpus ───────────────────────────────────────────────────────

/** The memory-qa custody corpus of a sealed questions file: chats and questions only, with no kind, gold chat or answer. */
export function toCustodyCorpus(q: QuestionsFile): { id: string; conversations: Corpus['conversations']; questions: MemoryQuestion[] } {
  return {
    id: `${q.set_id}-h1`,
    conversations: q.haystacks.map(h => ({ id: h.haystack_id, sessions: h.sessions.map(s => ({ id: s.session_id, date: s.date, turns: s.turns.map(t => ({ speaker: t.role, content: t.content })) })) })),
    questions: q.questions.map(x => ({ id: x.question_id, conversation: x.haystack_id, question: x.question, question_date: x.question_date, category: 'sealed-unlabeled', gold: [], abstention: false })),
  };
}

export function buildCorpus(o: { custodyRoot: string; decision: H1Decision; manifestPath: string; questions: string; log: string; out: string; purpose: string }) {
  checkCustodyPaths(o.custodyRoot, [['custody corpus', o.out], ['access log', o.log]]);
  const m = JSON.parse(readFileSync(o.manifestPath, 'utf8')) as Manifest;
  const bytes = assertCommitment(o.questions, { file: 'questions.json', ...m.commitments['questions.json'] });
  appendAccessLog(o.log, { action: 'open', purpose: `budgeted delivery H1 custody corpus (questions only): ${o.purpose}`, decision_id: o.decision.decision_id, labels_sha256: sha256Hex(bytes), run_sha256: null });
  const q = JSON.parse(bytes.toString('utf8')) as QuestionsFile;
  const problems = validateQuestionsFile(q);
  if (problems.length) throw new Error(`questions file rejected:\n${problems.slice(0, 10).join('\n')}`);
  const corpus = toCustodyCorpus(q);
  writeJson(o.out, corpus);
  return { questions: corpus.questions.length, conversations: corpus.conversations.length, sessions: corpus.conversations.reduce((n, c) => n + c.sessions.length, 0) };
}

// ─── gate ─────────────────────────────────────────────────────────

/** The H1 recipes as an arms spec, for recipeHash: the same names and specs as E2's, so the same hashes. */
const recipesSpec = (d: H1Decision): Pick<ArmsSpec, 'recipes'> => ({ recipes: Object.fromEntries(Object.entries(d.construction.recipes).map(([k, r]) => [k, { items: r.items, render: r.render }])) });

/** The corpus question and chat lookups the renderer needs (source id to the original chat, as run-systems maps it). */
function corpusIndex(corpus: Corpus) {
  const questions = new Map(corpus.questions.map(q => [q.id, q]));
  const conv = new Map(corpus.conversations.map(c => [c.id, c]));
  const bySource = new Map<string, { conversation: string; session: Session }>();
  for (const c of corpus.conversations) for (const s of c.sessions) bySource.set(opaqueSourceId(c.id, s.id), { conversation: c.id, session: s });
  return { questions, conv, bySource };
}

/**
 * Re-render one context from its recorded delivery with E2's pseudo-session renderer and compare the bytes with the
 * prompt the reader got (the hash run-systems froze). Returns the recomputed hash.
 */
export function rerender(d: H1Decision, idx: ReturnType<typeof corpusIndex>, retrieval: Row, a: H1AnswerArm): string {
  const q = idx.questions.get(retrieval.question_id ?? String(retrieval.id).split('|')[0])!;
  const sessions = idx.conv.get(q.conversation)!.sessions;
  const blocks = retrieval.accounting?.deliveries?.[a.variant]?.blocks;
  if (!blocks) throw new Error(`${q.id}: no ${a.variant} delivery to re-render`);
  const pack = packRecipe('pseudo-session', q, blocksToItems(blocks, sourceOfSlug), {
    budgetTokens: d.construction.harness_budget_tokens, sessionOf: src => idx.bySource.get(src)?.session, fallbackDate: sessions.map(x => x.date ?? '').sort().pop() || undefined,
  });
  return createHash('sha256').update(pack.prompt).digest('hex');
}

export function runGate(o: { decision: H1Decision; decisionSha: string; cells: string[]; corpus: Corpus; phase: 'deliver' | 'final'; log: string }) {
  const d = o.decision;
  const log = readLog(o.log);
  if (log.some(e => e.action === 'score' && e.decision_id === d.decision_id)) throw new Error('labels were already read under this decision; the gate must run before any label read');
  const retrievals = retrievalRows(o.cells);
  const expected = o.corpus.questions.length;
  const ids = new Set(retrievals.map(r => r.question_id));
  const problems: string[] = [];
  if (expected !== d.sealed.questions) problems.push(`the corpus has ${expected} questions, the decision ${d.sealed.questions}`);
  if (retrievals.length !== expected || ids.size !== expected) problems.push(`${retrievals.length} retrieval rows (${ids.size} questions) for ${expected} questions`);
  const failed = retrievals.filter(r => r.error || r.outcome !== 'scored').length;
  if (failed) problems.push(`${failed} retrieval rows failed or were not scored`);
  const budgets = retrievals.filter(r => r.accounting?.budgets?.b_pseudo !== d.construction.b_pseudo).length;
  if (budgets) problems.push(`${budgets} deliveries ran at a budget other than b_pseudo ${d.construction.b_pseudo}`);

  const g1 = guard1(retrievals);
  const variants = [...new Set(d.answer_arms.map(a => a.variant))];
  const packingOf = (v: string) => d.answer_arms.find(a => a.variant === v)!.packing;
  const g3 = Object.fromEntries(variants.map(v => [v, capGuard(retrievals, v, packingOf(v))]));
  const delivery = Object.fromEntries(variants.map(v => [v, deliveryStats(retrievals, v)]));
  const candidate = arm(d, d.rule.candidate_arm), control = arm(d, d.rule.control_arm);
  const out: Row = {
    kind: 'budgeted-delivery-h1-gate', decision_id: d.decision_id, decision_sha256: o.decisionSha, phase: o.phase, created_at: new Date().toISOString(),
    access_log_lines_at_gate: log.length, labels_read_under_this_decision: 0,
    inputs: { retrieval_rows: retrievals.length, cells: o.cells.length },
    guards: {
      '1_no_budget_bytes_identical': g1,
      '3_product_token_cap_candidate': g3[candidate.variant],
      '3_product_token_cap_reported': g3,
      '5_one_frozen_list_per_question': { questions: retrievals.length, every_variant_delivered: retrievals.filter(r => variants.every(v => r.accounting?.deliveries?.[v])).length, pass: retrievals.every(r => variants.every(v => r.accounting?.deliveries?.[v])) },
      '6_default_budget': { pass: g1.pass, note: 'exact by guard 1: without an explicit budget every packing delivers the bytes off delivers, so callers without a budget see no change' },
    },
    delivery, problems,
  };
  let pass = problems.length === 0 && g1.pass && g3[candidate.variant].pass && out.guards['5_one_frozen_list_per_question'].pass;
  if (o.phase === 'final') {
    const idx = corpusIndex(o.corpus);
    const byKey = new Map(retrievals.map(r => [r.question_id, r]));
    const spec = recipesSpec(d);
    const contexts: Record<string, Row> = {};
    for (const a of d.answer_arms) {
      const rows = armRows(o.cells, a.memory_qa_arm);
      const hash = recipeHash(a.recipe, spec);
      const wrongRecipe = rows.filter(r => r.qa_context?.recipe_hash !== hash || r.qa_context?.renderer !== d.construction.renderer.dated_renderer_version).length;
      let rendered = 0, mismatched = 0;
      for (const r of rows) {
        if (!r.qa_context?.prompt_sha256) continue;
        rendered++;
        if (rerender(d, idx, byKey.get(r.id)!, a) !== r.qa_context.prompt_sha256) mismatched++;
      }
      const outcomes: Record<string, number> = {};
      for (const r of rows) outcomes[r.outcome ?? 'none'] = (outcomes[r.outcome ?? 'none'] ?? 0) + 1;
      contexts[a.id] = { rows: rows.length, outcomes, guard4: contextGuard(rows, d.construction.harness_budget_tokens), recipe_hash: hash, expected_recipe_hash: d.construction.recipes[a.recipe].hash,
        rows_with_other_recipe_or_renderer: wrongRecipe, rerendered: rendered, rerender_mismatches: mismatched,
        tokens_mean: mean(rows.map(r => Number(r.qa_context?.tokens ?? 0))), items_cut_total: rows.reduce((n, r) => n + Number(r.qa_context?.items_cut ?? 0), 0) };
      if (rows.length !== expected) problems.push(`${a.memory_qa_arm}: ${rows.length} rows for ${expected} questions`);
      if (hash !== d.construction.recipes[a.recipe].hash) problems.push(`${a.recipe}: recipe hash ${hash} differs from E2's ${d.construction.recipes[a.recipe].hash}`);
      if (wrongRecipe || mismatched) problems.push(`${a.id}: ${wrongRecipe} contexts under another recipe or renderer, ${mismatched} that do not re-render to the bytes the reader got`);
    }
    out.guards['4_reader_context_cap_candidate'] = contexts[candidate.id].guard4;
    out.contexts = contexts;
    out.render_identity = { recipes_equal_e2: d.answer_arms.every(a => contexts[a.id].recipe_hash === d.construction.recipes[a.recipe].hash), rerender_mismatches: Object.values(contexts).reduce((n, c) => n + c.rerender_mismatches, 0) };
    out.control_context_cuts = contexts[control.id].guard4;
    pass &&= problems.length === 0 && contexts[candidate.id].guard4.pass;
  }
  out.pass = pass;
  return out;
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ─── answers ──────────────────────────────────────────────────────

/** One reader arm's memory-qa rows as a sealed-runner run file: the answer, and the chats the reader saw as `retrieved`. */
export function answerRows(d: H1Decision, a: H1AnswerArm, rows: Row[], corpus: Corpus): Row[] {
  const idx = corpusIndex(corpus);
  const byId = new Map(rows.map(r => [r.id, r]));
  return corpus.questions.map(q => {
    const r = byId.get(q.id);
    if (!r) throw new Error(`${a.memory_qa_arm}: no row for question ${q.id}`);
    const packed = [...new Set(((r.qa_context?.source_ids ?? []) as string[]).map(src => idx.bySource.get(src)?.session.id).filter((x): x is string => !!x))];
    const base = { question_id: q.id, haystack_id: q.conversation, retrieved: packed, prompt_sha256: r.qa_context?.prompt_sha256 ?? null, context_tokens: r.qa_context?.tokens ?? null,
      items_cut: r.qa_context?.items_cut ?? null, reader_input_tokens: r.qa_input_tokens ?? null, reader_output_tokens: r.qa_output_tokens ?? null };
    if (r.outcome === 'scored' && typeof r.qa_answer === 'string') return { ...base, hypothesis: r.qa_answer, reader_empty: !r.qa_answer.trim() };
    return { ...base, reader_error: String(r.qa_error ?? r.error ?? r.outcome ?? 'no answer').slice(0, 300) };
  });
}

export function writeAnswers(o: { custodyRoot: string; decision: H1Decision; decisionSha: string; cells: string[]; corpus: Corpus; outDir: string }) {
  const summary: Row = {};
  for (const a of o.decision.answer_arms) {
    const out = join(o.outDir, `${a.id}.jsonl`);
    checkCustodyPaths(o.custodyRoot, [['answers file', out]]);
    const receipts = o.cells.map(c => JSON.parse(readFileSync(join(c, 'arms', a.memory_qa_arm, 'receipt.json'), 'utf8')) as Row);
    const commits = [...new Set(receipts.map(r => r.overlay?.commit ?? r.product?.loaded_git_head ?? null))];
    if (commits.length !== 1 || commits[0] !== o.decision.gbrain.commit) throw new Error(`${a.memory_qa_arm} ran at gbrain ${commits.join(', ')}; the decision pins ${o.decision.gbrain.commit}`);
    if (receipts.some(r => r.overlay?.checkout_dirty)) throw new Error(`${a.memory_qa_arm}: the gbrain checkout had local changes`);
    const rows = answerRows(o.decision, a, armRows(o.cells, a.memory_qa_arm), o.corpus);
    const meta = { record_type: 'meta', decision_id: o.decision.decision_id, decision_sha256: o.decisionSha, arm: a.id, memory_qa_arm: a.memory_qa_arm, reader: a.model, gbrain_commit: commits[0], questions: rows.length };
    mkdirSync(o.outDir, { recursive: true });
    writeFileSync(out, [meta, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
    summary[a.id] = { rows: rows.length, reader_errors: rows.filter(r => r.reader_error).length, empty: rows.filter(r => r.reader_empty).length };
  }
  return summary;
}

// ─── decide ───────────────────────────────────────────────────────

export type H1Verdict = 'pass' | 'fail' | 'inconclusive';
interface ComparisonOut { id: string; status: string; reasons?: string[]; stats?: { delta: number; ci95: [number, number] | null; p_two_sided: number; n_pairs: number; n_clusters: number; mean_a: number; mean_b: number }; mcnemar?: { wins: number; losses: number; p_two_sided: number } }

/**
 * The preregistered H1 rule. `pass` needs the gate (guards 1, 3, 4, 5 and 6), superiority on the primary comparison
 * (delta > 0, the persona-clustered 95% interval above zero and the exact two-sided McNemar p below alpha), guard 7
 * (no kind down by more than max(1 question, 2% of the kind)) and guard 8 (abstention not worse). `fail` when a guard
 * fails or the whole interval is below zero. Everything else, a blocked comparison and more than max_reader_errors
 * reader errors in a primary arm included, is `inconclusive`.
 */
export function decideH1(rule: H1Rule, o: { gatePass: boolean; gateReasons?: string[]; primary: ComparisonOut | undefined; control: Row[]; candidate: Row[]; readerErrors: Record<string, number> }) {
  const reasons: string[] = [];
  const kindRows = (rows: Row[]) => rows.map(r => ({ id: r.question_id, category: r.question_type, qa_score: r.answer_correct ? 1 : 0 }));
  const g7raw = kindGuard(kindRows(o.control), kindRows(o.candidate));
  const kinds = Object.fromEntries(Object.entries(g7raw.kinds).map(([k, v]) => {
    const threshold = Math.max(rule.guard7.min_questions, rule.guard7.share_of_kind * v.n);
    return [k, { ...v, threshold, pass: v.delta_questions >= -threshold - 1e-9 }];
  }));
  const guard7 = { kinds, pass: Object.values(kinds).every(k => k.pass) };
  const abst = kinds['abstention'];
  const guard8 = abst ? { n: abst.n, control: abst.base, candidate: abst.cand, pass: abst.cand >= abst.base } : { n: 0, control: 0, candidate: 0, pass: true };
  const p = o.primary;
  const s = p?.stats;
  const superiority = !!(s && p?.mcnemar && s.delta > 0 && s.ci95 && s.ci95[0] > 0 && p.mcnemar.p_two_sided < rule.alpha);
  const shownWorse = !!(s?.ci95 && s.ci95[1] < 0);
  const tooManyErrors = Object.entries(o.readerErrors).filter(([, n]) => n > rule.max_reader_errors);
  let verdict: H1Verdict;
  if (!o.gatePass) { verdict = 'fail'; reasons.push(`the evidence gate failed (guards 1, 3, 4 or 5): ${(o.gateReasons ?? []).join('; ') || 'see gate.json'}`); }
  else if (tooManyErrors.length) { verdict = 'inconclusive'; reasons.push(...tooManyErrors.map(([a, n]) => `${a}: ${n} reader errors exceed ${rule.max_reader_errors}`)); }
  else if (!p || !s || p.status === 'blocked' || p.status === 'skipped') { verdict = 'inconclusive'; reasons.push(`the primary comparison is ${p?.status ?? 'missing'}${p?.reasons?.length ? `: ${p.reasons.join('; ')}` : ''}`); }
  else if (!guard7.pass || !guard8.pass || shownWorse) {
    verdict = 'fail';
    if (!guard7.pass) reasons.push(`guard 7: ${Object.entries(kinds).filter(([, k]) => !k.pass).map(([k, v]) => `${k} ${v.delta_questions} questions (limit -${v.threshold})`).join(', ')}`);
    if (!guard8.pass) reasons.push(`guard 8: abstention ${guard8.candidate} against ${guard8.control}`);
    if (shownWorse) reasons.push('the whole 95% interval for depth_first minus cap_only is below zero');
  } else if (superiority) verdict = 'pass';
  else { verdict = 'inconclusive'; reasons.push('superiority not shown (delta > 0, 95% interval above zero and McNemar p < alpha are all required)'); }
  if (s) reasons.push(`primary: delta ${s.delta.toFixed(4)}, 95% interval [${s.ci95?.map(x => x.toFixed(4)).join(', ') ?? 'n/a'}], McNemar p ${p?.mcnemar?.p_two_sided.toPrecision(3) ?? 'n/a'} (wins ${p?.mcnemar?.wins ?? 'n/a'}, losses ${p?.mcnemar?.losses ?? 'n/a'})`);
  return { verdict, superiority_shown: superiority, primary: s ? { delta: s.delta, ci95: s.ci95, mcnemar: p!.mcnemar ?? null, sign_flip_p_two_sided: s.p_two_sided, n_pairs: s.n_pairs, n_clusters: s.n_clusters, control: s.mean_a, candidate: s.mean_b } : null, guard7, guard8, reasons };
}

export function runDecide(o: { decision: H1Decision; decisionSha: string; gate: Row; compare: Row; scores: { control: Row; candidate: Row; controlSha: string; candidateSha: string }; answers: string[]; log: string }) {
  const d = o.decision;
  const problems: string[] = [];
  if (o.gate.decision_sha256 !== o.decisionSha || o.gate.phase !== 'final') problems.push('gate.json is not the final gate of this decision file');
  const inputs = (o.compare.inputs ?? []) as Row[];
  if (inputs[0]?.sha256 !== o.scores.controlSha || inputs[1]?.sha256 !== o.scores.candidateSha) problems.push('compare.json was not computed from these two score reports (control first, candidate second)');
  const log = readLog(o.log);
  const scoreLines = log.map((e, i) => ({ e, i })).filter(x => x.e.action === 'score' && x.e.decision_id === d.decision_id);
  if (scoreLines.some(x => x.i < o.gate.access_log_lines_at_gate)) problems.push('a label read under this decision precedes the final gate');
  const readerErrors: Record<string, number> = {};
  for (const path of o.answers) {
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) as Row[];
    const meta = rows.find(r => r.record_type === 'meta');
    if (meta?.decision_sha256 !== o.decisionSha) problems.push(`${basename(path)} was written under another decision file`);
    if (meta && (meta.arm === d.rule.control_arm || meta.arm === d.rule.candidate_arm)) readerErrors[meta.arm] = rows.filter(r => r.record_type !== 'meta' && r.reader_error).length;
  }
  const primary = (o.compare.decision?.comparisons as ComparisonOut[] | undefined)?.find(c => c.id === d.rule.primary_comparison);
  const missing = [o.scores.control, o.scores.candidate].reduce((n, s) => n + (s.retrieval?.missing_rows?.length ?? 0), 0);
  if (missing) problems.push(`${missing} questions have no answer row in a primary score report`);
  const result = decideH1(d.rule, { gatePass: o.gate.pass === true, gateReasons: o.gate.problems, primary: problems.length ? undefined : primary, control: o.scores.control.per_question, candidate: o.scores.candidate.per_question, readerErrors });
  return {
    kind: 'budgeted-delivery-h1-decision-outcome', decision_id: d.decision_id, decision_sha256: o.decisionSha, decided_at: new Date().toISOString(), ...result,
    reasons: [...problems, ...result.reasons], reader_errors: readerErrors,
    label_reads: { this_decision: scoreLines.length, expected: d.rule.expected_label_reads, all_after_final_gate: scoreLines.every(x => x.i >= o.gate.access_log_lines_at_gate) },
    recommendation: result.verdict === 'pass' && !problems.length
      ? 'Recommend a gbrain pull request that makes depth_first the default packing for explicit budgets (search.auto_packing); callers that pass no budget see no change (guard 1).'
      : 'cap_only stays the default for explicit budgets. The set is not reopened for depth_first, and nothing is tuned on it.',
  };
}

// ─── budget ───────────────────────────────────────────────────────

/**
 * The campaign's spend per step against the decision's estimates and caps, from `shootout-cell.ts status`: numbers
 * only (lease ids and launch arguments name custody paths and stay behind). A step past twice its estimate is an
 * alert the report names; it never stops the run (the lease cap does).
 */
export function budgetSummary(d: H1Decision & { budget: { estimate_usd: number; cap_usd: number; steps: Array<{ id: string; estimate_usd: number; cap_usd: number }> } }, status: Row) {
  const leases = (status.leases ?? []) as Array<{ cell: string; usd: number; status: string; actual_usd?: number }>;
  const steps = d.budget.steps.map(st => {
    const ls = leases.filter(l => l.cell === `h1-${st.id}`);
    const spent = ls.reduce((n, l) => n + (l.status === 'settled' ? l.actual_usd ?? 0 : l.status === 'abandoned' ? l.usd : 0), 0);
    return { id: st.id, estimate_usd: st.estimate_usd, cap_usd: st.cap_usd, leases: ls.length, reserved_usd: ls.reduce((n, l) => n + l.usd, 0), spent_usd: spent,
      open_leases: ls.filter(l => l.status !== 'settled' && l.status !== 'abandoned').length, alert_over_twice_estimate: spent > 2 * st.estimate_usd };
  });
  const spent = steps.reduce((n, s) => n + s.spent_usd, 0);
  return { kind: 'budgeted-delivery-h1-budget', decision_id: d.decision_id, campaign_id: status.campaign_id, cap_usd: status.cap_usd, committed_usd: status.committed_usd, remaining_usd: status.remaining_usd,
    estimate_usd: d.budget.estimate_usd, spent_usd: spent, alert_over_twice_estimate: spent > 2 * d.budget.estimate_usd, steps };
}

// ─── return-log ───────────────────────────────────────────────────

/** Copy the custody access log back to the owner's file, refusing unless the owner's lines are its prefix and every added line is this decision's. */
export function returnLog(o: { decision: H1Decision; from: string; to: string }) {
  const owner = existsSync(o.to) ? readFileSync(o.to, 'utf8') : '';
  const custody = readFileSync(o.from, 'utf8');
  if (!custody.startsWith(owner)) throw new Error('the owner\'s access log is not a prefix of the custody copy; reconcile them by hand');
  const added = custody.slice(owner.length).split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as LogEntry);
  const foreign = added.filter(e => e.decision_id !== o.decision.decision_id);
  if (foreign.length) throw new Error(`${foreign.length} added lines belong to another decision`);
  writeFileSync(o.to, custody);
  const byAction: Record<string, number> = {};
  for (const e of added) byAction[e.action] = (byAction[e.action] ?? 0) + 1;
  return { returned: true, lines: custody.split('\n').filter(l => l.trim()).length, added: added.length, added_by_action: byAction };
}

// ─── export ───────────────────────────────────────────────────────

/** The aggregate view of a sealed-runner score report: counts and recall, no question ids. */
export function scoreAggregate(s: Row): Row {
  const r = s.retrieval ?? {};
  return { set: s.set, labels_sha256: s.labels_sha256, run_sha256: s.run_sha256,
    packed_recall: { top_k: r.top_k, answerable: r.answerable, by_type: r.by_type, abstention_excluded: r.abstention_excluded, missing_rows: r.missing_rows?.length ?? null, unknown_rows: r.unknown_rows?.length ?? null },
    answers: s.answers ? { judge: s.answers.reader_judge, n: s.answers.n, correct: s.answers.correct, by_type: s.answers.by_type } : null };
}

/** compare.ts output with input paths reduced to file names. */
export const compareAggregate = (c: Row): Row => ({ ...c, inputs: (c.inputs ?? []).map((i: Row) => ({ ...i, path: basename(String(i.path)) })) });

/** Throws when any exported text names a question, chat or haystack id of the corpus, or the custody root's path. */
export function leakScan(files: Array<{ path: string; text: string }>, corpus: Corpus, custodyRoot: string): void {
  const ids = new Set<string>([...corpus.questions.map(q => q.id), ...corpus.conversations.flatMap(c => [c.id, ...c.sessions.map(s => s.id)])]);
  const hits: string[] = [];
  for (const f of files) {
    if (f.text.includes(resolve(custodyRoot))) hits.push(`${f.path}: the custody root's path`);
    for (const m of f.text.matchAll(/[A-Za-z0-9_-]{6,}/g)) if (ids.has(m[0])) { hits.push(`${f.path}: an id of the corpus`); break; }
  }
  if (hits.length) throw new Error(`export refused, nothing written: ${hits.slice(0, 10).join('; ')}`);
}

export function runExport(o: { custodyRoot: string; corpus: Corpus; runs: string; cells: string[]; out: string }) {
  if (resolve(o.out).startsWith(resolve(o.runs))) throw new Error('the export directory must be outside the runs directory');
  checkCustodyPaths(o.custodyRoot, [['export directory', o.out]]);
  const files: Array<{ path: string; text: string }> = [];
  const add = (path: string, value: unknown) => files.push({ path, text: JSON.stringify(value, null, 2) + '\n' });
  const read = (p: string) => JSON.parse(readFileSync(join(o.runs, p), 'utf8')) as Row;
  for (const f of ['custody-check.json', 'gate-deliver.json', 'gate.json', 'decision-outcome.json', 'answers-summary.json']) if (existsSync(join(o.runs, f))) add(f, read(f));
  for (const dir of ['scores', 'compare', 'ledger']) {
    const p = join(o.runs, dir);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p).filter(x => x.endsWith('.json')).sort()) add(`${dir}/${f}`, dir === 'scores' ? scoreAggregate(read(`${dir}/${f}`)) : dir === 'compare' ? compareAggregate(read(`${dir}/${f}`)) : read(`${dir}/${f}`));
  }
  const tmp = join(o.custodyRoot, '.export-staging');
  for (const c of o.cells) {
    const stage = join(tmp, basename(c));
    exportCell(c, stage);
    for (const f of readdirSync(stage).sort()) add(`memory-qa/${basename(c)}/${f}`, JSON.parse(readFileSync(join(stage, f), 'utf8')));
  }
  leakScan(files, o.corpus, o.custodyRoot);
  for (const f of files) { mkdirSync(dirname(join(o.out, f.path)), { recursive: true }); writeFileSync(join(o.out, f.path), f.text); }
  return { files: files.length, out: relative(o.custodyRoot, o.out) };
}

// ─── parity (keyless dry run) ─────────────────────────────────────

/**
 * Two gbrain commits on the same fixture corpus: each side's own freeze (hit lists compared by rank, page, chunk
 * index, chunk text hash and scores) and its delivery from one shared frozen list (evidence bytes, budget used and
 * guard 1 per variant). `a` and `b` are directories holding freeze/ and deliver/ memory-qa outputs.
 */
export function evidenceParity(a: string, b: string) {
  const rows = (dir: string, stage: string) => {
    const out = new Map<string, Row>();
    for (const shard of readdirSync(join(dir, stage)).filter(s => s.startsWith('shard-') && !s.endsWith('.log')).sort()) {
      const p = join(dir, stage, shard, 'retrievals', 'rows.ndjson');
      if (!existsSync(p)) continue;
      for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); out.set(r.question_id ?? r.id, r); }
    }
    return out;
  };
  const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const hitList = (r: Row) => sha(((r.accounting?.frozen?.rows ?? []) as Row[]).map(h => [h.rank, h.slug, h.chunk_index, sha(h.chunk_text), h.score ?? null, h.rerank_score ?? null]));
  const [fa, fb, da, db] = [rows(a, 'freeze'), rows(b, 'freeze'), rows(a, 'deliver'), rows(b, 'deliver')];
  const ids = [...fa.keys()].filter(id => fb.has(id));
  const variants = [...new Set([...da.values()].flatMap(r => Object.keys(r.accounting?.deliveries ?? {})))].sort();
  const delivery = Object.fromEntries(variants.map(v => {
    const pairs = ids.filter(id => da.has(id) && db.has(id)).map(id => [da.get(id)!.accounting.deliveries[v]?.record, db.get(id)!.accounting.deliveries[v]?.record] as const);
    return [v, { questions: pairs.length, evidence_equal: pairs.filter(([x, y]) => x && y && x.evidence_sha256 === y.evidence_sha256).length, budget_used_equal: pairs.filter(([x, y]) => x && y && x.budget_used === y.budget_used).length }];
  }));
  const guard1 = ids.filter(id => da.get(id)?.accounting?.guard1?.equal && db.get(id)?.accounting?.guard1?.equal).length;
  const frozenEqual = ids.filter(id => hitList(fa.get(id)!) === hitList(fb.get(id)!)).length;
  return { questions: ids.length, frozen_lists_equal: frozenEqual, delivery, guard1_both: guard1,
    identical: ids.length > 0 && frozenEqual === ids.length && guard1 === ids.length && Object.values(delivery).every(d => d.questions === ids.length && d.evidence_equal === ids.length) };
}

// ─── CLI ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const [step, ...argv] = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (n: string) => { const v = one(n); if (!v) throw new Error(`${step} needs ${n}`); return v; };
  const many = (n: string) => argv.flatMap((x, i) => x === n ? [argv[i + 1]] : []);
  const cellsOf = () => many('--cell').map(c => resolve(c)).sort();
  try {
    const custodyRoot = resolve(need('--custody-root'));
    const { decision, sha256 } = loadDecision(need('--decision'));
    const log = one('--access-log') ?? process.env.GBRAIN_EVALS_CUSTODY_LOG;
    const outPath = one('--out');
    if (outPath) checkCustodyPaths(custodyRoot, [['output', outPath]]);
    let result: unknown, fail = false;
    if (step === 'custody-check') result = custodyCheck({ custodyRoot, decision, manifestPath: need('--manifest'), questions: need('--questions'), labels: need('--labels'), log: log ?? need('--access-log') });
    else if (step === 'corpus') result = buildCorpus({ custodyRoot, decision, manifestPath: need('--manifest'), questions: need('--questions'), log: log ?? need('--access-log'), out: need('--corpus-out'), purpose: need('--purpose') });
    else if (step === 'gate') {
      const g = runGate({ decision, decisionSha: sha256, cells: cellsOf(), corpus: loadCustodyCorpus(need('--corpus')), phase: need('--phase') as 'deliver' | 'final', log: log ?? need('--access-log') });
      result = g; fail = !g.pass;
    } else if (step === 'answers') result = writeAnswers({ custodyRoot, decision, decisionSha: sha256, cells: cellsOf(), corpus: loadCustodyCorpus(need('--corpus')), outDir: need('--out-dir') });
    else if (step === 'decide') {
      const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
      const [control, candidate] = [need('--control-score'), need('--candidate-score')];
      result = runDecide({ decision, decisionSha: sha256, gate: read(need('--gate')), compare: read(need('--compare')), scores: { control: read(control), candidate: read(candidate), controlSha: sha256File(control), candidateSha: sha256File(candidate) },
        answers: many('--answers'), log: log ?? need('--access-log') });
    } else if (step === 'budget') result = budgetSummary(decision as Parameters<typeof budgetSummary>[0], JSON.parse(readFileSync(need('--status'), 'utf8')));
    else if (step === 'return-log') result = returnLog({ decision, from: need('--from'), to: need('--to') });
    else if (step === 'parity') result = { a: basename(need('--a')), b: basename(need('--b')), ...evidenceParity(need('--a'), need('--b')) };
    else if (step === 'export') result = runExport({ custodyRoot, corpus: loadCustodyCorpus(need('--corpus')), runs: resolve(need('--runs')), cells: cellsOf(), out: resolve(need('--export-dir')) });
    else throw new Error(`unknown step ${step}; see the header of eval/runner/budgeted-delivery/h1.ts`);
    if (outPath) writeJson(outPath, result);
    process.stdout.write(JSON.stringify(result, null, 2).slice(0, 4000) + '\n');
    if (fail) { process.stderr.write(`[h1] ${step}: FAIL\n`); process.exit(1); }
  } catch (e) {
    process.stderr.write(`[h1] ${step} refused: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

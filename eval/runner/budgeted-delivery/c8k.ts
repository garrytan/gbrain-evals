/**
 * The 8k conversion custody steps (preregistration docs/benchmarks/2026-10-26-gbrain-8k-conversion-preregistration.md,
 * decision directory docs/benchmarks/2026-10-26-gbrain-8k-conversion/). They run on the custodian's machine inside
 * one custody root; c8k-run.sh chains them, and the development reading (c8k-dev.sh) runs the same steps on
 * LongMemEval-S dev100 with public labels:
 *
 *   custody-check  sealed files against the manifest and the decision (labels hashed, never parsed); the access log
 *                  holds exactly the state the decision records plus only this decision's lines (h1.ts)
 *   corpus         questions.json to a label-free corpus, the open logged first
 *   dev-corpus     the development slice (memory-qa lme-s, --limit 100 --seed 42) with its labels
 *   import         one on-disk brain per history under <root>/brains, each session a conversation page
 *   extract        gbrain's conversation fact extraction over every brain (runExtractConversationFactsCore, force)
 *   freeze         one live query per question and arm through the stdio dispatch, then the determinism repeat
 *   gate           phase retrieval (before any reader call) or final (after the readers, before any label read)
 *   read           one reader over every arm's product-text contexts
 *   answers        sealed-runner run files, one per reader and arm
 *   dev-score      (development only) the official LongMemEval judge over the dev answers
 *   decide         decideC8k over the final gate, compare.ts's outputs and the score reports
 *   budget         spend per step against the decision's estimates and caps
 *   export         aggregates only, scanned for every corpus id and the custody root's path
 *   return-log     the access log back to the owner, refusing any line that is not this decision's
 *
 *   bun eval/runner/budgeted-delivery/c8k.ts <step> --custody-root <dir> --decision <decision.json> ...
 *
 * Every destination sits inside the custody root, outside the repository and the shared caches. No step opens
 * labels.json: `sealed-confirmation.ts score` reads them after the final gate and logs the read first.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { appendAccessLog, assertCommitment, sha256File, sha256Hex, validateQuestionsFile, type QuestionsFile } from '../sealed-confirmation-lib.ts';
import { fetchDataset, loadCorpus, loadCustodyCorpus, type Corpus } from '../memory-qa/corpus.ts';
import { checkCustodyPaths } from '../memory-qa/sealed-profile.ts';
import { ChatClient, judgePromptsFor, judgeYes } from '../memory-qa/qa.ts';
import { hashEmbed, selectQuestions } from '../memory-qa/run.ts';
import { opaqueSourceId } from '../systems/sanitize.ts';
import { sourceOfSlug } from '../systems/gbrain.ts';
import { holmAdjusted } from '../stats/paired.ts';
import { importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { compareAggregate, custodyCheck, leakScan, oneSidedLossP, readLog, returnLog, scoreAggregate, toCustodyCorpus, type H1Rule, type SealedDecision } from './h1.ts';
import { kindGuard } from './e2-readings.ts';
import {
  BRAIN_SETTINGS, C8K_ARMS, FACTS_BLOCK_MAX_ROWS, FACTS_BLOCK_SHARE, KEYLESS_SETTINGS, RECIPE_HASH, RENDER_RECIPE, RENDERER_VERSION,
  armById, brainName, clearArmKeys, factCounts, factRows, importHistory, loadProductModules, openBrain, queryArm, renderContext, repairSafeChunks, resultRows, setArmKeys, stdioDispatchOpts,
  type EvidenceRow, type ProductModules,
} from './c8k-product.ts';

type Row = Record<string, any>;

// ─── The decision file ────────────────────────────────────────────

export interface C8kAnswerArm { id: string; reader: string; model: string; arm: string; role: 'primary' | 'replay' | 'development' }
export interface C8kComparison { id: string; tests: string; a: string; b: string }
export interface C8kRule {
  alpha: number;
  holm: { over: string[] };
  max_reader_errors: number;
  guard7: H1Rule['guard7'];
  comparisons: C8kComparison[];
  f1_noninferiority: { comparison: string; reference: string; candidate: string; lower_bound_above: number };
  recommendations: Record<string, string>;
  expected_label_reads: number;
}
export interface C8kDecision {
  schema: string;
  decision_id: string;
  sealed: { set: string; manifest: string; questions_sha256: string; labels_sha256: string; questions: number; personas: number; kinds: Record<string, number>;
    access_log_before: { lines: number; entries: Array<{ action: string; decision_id: string | null }> } };
  gbrain: { commit: string; version: string };
  construction: { query_budget: number; harness_budget_tokens: number; determinism: { questions: number; seed: number }; renderer: { version: string; recipe_hash: string; reader_template_sha256: string } };
  readers: { primary: string; replay: string[]; max_tokens: number; development: string[] };
  answer_arms: C8kAnswerArm[];
  rule: C8kRule;
  development: { benchmark: string; limit: number; seed: number; judge: string };
  budget: { estimate_usd: number; cap_usd: number; steps: Array<{ id: string; estimate_usd: number; cap_usd: number }> };
}

export const UNFILLED = 'fill-at-custody';
export const DECISION_SCHEMA = 'gbrain-evals/c8k-decision/v1';

export function loadDecision(path: string): { decision: C8kDecision; sha256: string } {
  const bytes = readFileSync(path);
  const decision = JSON.parse(bytes.toString('utf8')) as C8kDecision;
  if (decision.schema !== DECISION_SCHEMA) throw new Error(`${path} is not an 8k conversion decision file`);
  return { decision, sha256: sha256Hex(bytes) };
}

const writeJson = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Row;
const readNdjson = (path: string): Row[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => { m[x] = (m[x] ?? 0) + 1; return m; }, {});

/** The decision as the sealed steps need it: nothing left to fill at custody. */
export function assertFilled(d: C8kDecision): void {
  const problems: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(d.gbrain.commit)) problems.push(`gbrain.commit is ${d.gbrain.commit} (the wave's merge commit is written before custody)`);
  if (d.sealed.access_log_before.entries.some(e => e.action === UNFILLED) || d.sealed.access_log_before.entries.length !== d.sealed.access_log_before.lines) problems.push('sealed.access_log_before does not record every verified line');
  if (problems.length) throw new Error(`the decision file is not ready for custody: ${problems.join('; ')}`);
}

// ─── gbrain under test ────────────────────────────────────────────

/** The build under test, checked against the decision's pin, with its gateway configured: hash vectors when keyless, the lease proxy's base URLs otherwise. */
export async function productUnderTest(spec: string, d: C8kDecision, keyless: boolean): Promise<{ gut: GbrainUnderTest; m: ProductModules; identity: Row }> {
  const gut = resolveGbrainUnderTest(spec);
  if (!gut.overlay) throw new Error('--gbrain <checkout>@<commit> is required: the pinned dependency predates the GBRA-205 keys');
  if (gut.overlay.build.commit !== d.gbrain.commit) throw new Error(`--gbrain resolved to ${gut.overlay.build.commit}; the decision pins ${d.gbrain.commit}`);
  if (gut.overlay.checkout_dirty) throw new Error('the gbrain checkout has local changes; the overlay copies the commit only, so clean it first');
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
  if (keyless) {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) process.env[k] = 'keyless-dry-run';
    process.env.GBRAIN_MODEL_DISCOVERY = 'off';
  }
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env, ...(process.env.VOYAGE_BASE_URL ? { base_urls: { voyage: process.env.VOYAGE_BASE_URL } } : {}) });
  if (keyless) gateway.__setEmbedTransportForTests(async (p: { values: string[] }) => ({ embeddings: p.values.map(v => hashEmbed(v, 1536)), values: p.values, warnings: [], usage: { tokens: 0 } }));
  const m = await loadProductModules(<T,>(rel: string) => importGbrain<T>(gut, rel));
  return { gut, m, identity: { commit: gut.overlay.build.commit, version: gut.version, keyless, embedding: keyless ? 'hash@1536 (keyless control)' : 'openai:text-embedding-3-large@1536' } };
}

// ─── corpus ───────────────────────────────────────────────────────

interface Manifest { set: string; commitments: Record<string, { sha256: string; bytes: number }> }

export function buildCorpus(o: { custodyRoot: string; decision: C8kDecision; manifestPath: string; questions: string; log: string; out: string; purpose: string }) {
  checkCustodyPaths(o.custodyRoot, [['custody corpus', o.out], ['access log', o.log]]);
  const m = JSON.parse(readFileSync(o.manifestPath, 'utf8')) as Manifest;
  const bytes = assertCommitment(o.questions, { file: 'questions.json', ...m.commitments['questions.json'] });
  appendAccessLog(o.log, { action: 'open', purpose: `8k conversion custody corpus (questions only): ${o.purpose}`, decision_id: o.decision.decision_id, labels_sha256: sha256Hex(bytes), run_sha256: null });
  const q = JSON.parse(bytes.toString('utf8')) as QuestionsFile;
  const problems = validateQuestionsFile(q);
  if (problems.length) throw new Error(`questions file rejected:\n${problems.slice(0, 10).join('\n')}`);
  const corpus = { ...toCustodyCorpus(q), id: `${q.set_id}-c8k` };
  writeJson(o.out, corpus);
  return { questions: corpus.questions.length, conversations: corpus.conversations.length, sessions: corpus.conversations.reduce((n, c) => n + c.sessions.length, 0) };
}

/** The development slice: memory-qa's lme-s questions selected as the shootout did (stratified, `--limit 100 --seed 42`), each with its haystack. */
export async function devCorpus(d: C8kDecision, limit = d.development.limit): Promise<Corpus & { id: string }> {
  await fetchDataset(d.development.benchmark);
  const full = loadCorpus(d.development.benchmark);
  const questions = selectQuestions(full.questions, limit, d.development.seed);
  const convs = new Set(questions.map(q => q.conversation));
  return { ...full, id: `${d.development.benchmark}-dev${limit}-seed${d.development.seed}`, conversations: full.conversations.filter(c => convs.has(c.id)), questions };
}

// ─── import, extract, freeze ──────────────────────────────────────

const personas = (corpus: Corpus) => corpus.conversations.filter(c => corpus.questions.some(q => q.conversation === c.id));
const brainPath = (brains: string, conv: string) => join(brains, brainName(conv));

export async function runImport(o: { custodyRoot: string; corpus: Corpus; brains: string; m: ProductModules; keyless: boolean; identity: Row }) {
  checkCustodyPaths(o.custodyRoot, [['brains directory', o.brains]]);
  const done = join(o.brains, 'imported.ndjson');
  const finished = new Set(readNdjson(done).map(r => r.brain));
  for (const conv of personas(o.corpus)) {
    const name = brainName(conv.id);
    if (finished.has(name)) continue;
    const dir = join(o.brains, name);
    if (existsSync(dir)) throw new Error(`${name} exists but its import never finished; delete that brain directory and rerun`);
    const t0 = performance.now();
    const e = await openBrain(o.m, dir, { ...BRAIN_SETTINGS, ...(o.keyless ? KEYLESS_SETTINGS : {}) });
    try {
      const r = await importHistory(o.m, e, conv);
      const [pages] = await e.executeRaw(`SELECT COUNT(*)::int AS n FROM pages WHERE type = 'conversation' AND deleted_at IS NULL`);
      appendFileSync(done, JSON.stringify({ brain: name, sessions: r.sessions, pages: Number(pages.n), seconds: Math.round((performance.now() - t0) / 100) / 10 }) + '\n');
    } finally { await e.disconnect(); }
  }
  const rows = readNdjson(done);
  return { kind: 'c8k-import', ...o.identity, brains: rows.length, sessions: rows.reduce((n, r) => n + r.sessions, 0), pages: rows.reduce((n, r) => n + r.pages, 0),
    pages_equal_sessions: rows.every(r => r.pages === r.sessions), settings: { ...BRAIN_SETTINGS, ...(o.keyless ? KEYLESS_SETTINGS : {}) } };
}

/** Per brain: gbrain's conversation fact extraction, then the doctor-recommended safe-chunks repair (c8k-product.ts repairSafeChunks). */
export async function runExtract(o: { custodyRoot: string; corpus: Corpus; brains: string; m: ProductModules; identity: Row }) {
  const done = join(o.brains, 'extracted.ndjson');
  const finished = new Set(readNdjson(done).map(r => r.brain));
  for (const conv of personas(o.corpus)) {
    const name = brainName(conv.id);
    if (finished.has(name)) continue;
    const dir = brainPath(o.brains, conv.id);
    if (!existsSync(dir)) throw new Error(`${name} was never imported`);
    const e = await openBrain(o.m, dir);
    try {
      const t0 = performance.now();
      let res: Row = {}, error: string | null = null;
      try { res = await o.m.runExtractConversationFactsCore(e, { force: true, sourceId: 'default' }); } catch (err) { error = String((err as Error).message ?? err).slice(0, 300); }
      const facts = await factCounts(e);
      const safeChunks = await repairSafeChunks(o.m, e);
      appendFileSync(done, JSON.stringify({ brain: name, pages_processed: Number(res.pages_processed ?? 0), pages_failed: Number(res.pages_failed ?? 0), segments: Number(res.segments_processed ?? 0),
        facts_extracted: Number(res.facts_extracted ?? 0), ...facts, safe_chunks: safeChunks, error: error ? 'extraction threw' : null, seconds: Math.round((performance.now() - t0) / 100) / 10 }) + '\n');
    } finally { await e.disconnect(); }
  }
  const rows = readNdjson(done);
  const per = rows.map(r => r.facts as number);
  return { kind: 'c8k-extract', ...o.identity, extractor: 'runExtractConversationFactsCore (force, source default), gbrain\'s default extraction model', brains: rows.length,
    pages_processed: rows.reduce((n, r) => n + r.pages_processed, 0), pages_failed: rows.reduce((n, r) => n + r.pages_failed, 0), extraction_errors: rows.filter(r => r.error).length,
    facts: per.reduce((a, b) => a + b, 0), facts_world: rows.reduce((n, r) => n + r.world, 0), facts_per_history: { min: Math.min(...per), mean: mean(per), max: Math.max(...per) },
    histories_without_facts: per.filter(x => x === 0).length,
    safe_chunks_repair: { command: 'gbrain repair safe-chunks --source default (preview), then --apply', previewed: rows.reduce((n, r) => n + (r.safe_chunks?.previewed ?? 0), 0),
      applied: rows.reduce((n, r) => n + (r.safe_chunks?.applied ?? 0), 0), failed: rows.reduce((n, r) => n + (r.safe_chunks?.failed ?? 0), 0),
      pages_pending_after: rows.reduce((n, r) => n + (r.safe_chunks?.pending_after ?? 0), 0), brains_not_repaired: rows.filter(r => !r.safe_chunks).length } };
}

/** The determinism questions: the first `n` question ids by SHA-256 of the seed and the id. */
export function determinismQuestions(questions: ReadonlyArray<{ id: string }>, n: number, seed: number): string[] {
  return [...questions].map(q => ({ id: q.id, k: sha(`${seed}\u0000${q.id}`) })).sort((a, b) => a.k < b.k ? -1 : 1).slice(0, n).map(x => x.id);
}

/**
 * Per history: one warm-up call (the stdio transport's once-per-process notices land there and nowhere else), then each
 * arm in order: keys written and read back, one query per question, keys deleted and checked unset. Then A0 again on
 * the history's determinism questions. Writes <evidence>/<brain>.ndjson atomically, so a rerun resumes per history.
 */
export async function runFreeze(o: { custodyRoot: string; decision: C8kDecision; corpus: Corpus; brains: string; evidence: string; m: ProductModules; identity: Row }) {
  checkCustodyPaths(o.custodyRoot, [['evidence directory', o.evidence]]);
  mkdirSync(o.evidence, { recursive: true });
  const repeat = new Set(determinismQuestions(o.corpus.questions, o.decision.construction.determinism.questions, o.decision.construction.determinism.seed));
  let warmed = false;
  for (const conv of personas(o.corpus)) {
    const name = brainName(conv.id);
    const out = join(o.evidence, `${name}.ndjson`);
    if (existsSync(out)) continue;
    const dir = brainPath(o.brains, conv.id);
    const e = await openBrain(o.m, dir);
    const opts = stdioDispatchOpts(o.m, dir);
    const qs = o.corpus.questions.filter(q => q.conversation === conv.id);
    const rows: Row[] = [];
    try {
      await clearArmKeys(e);
      if (!warmed) { await o.m.dispatchToolCall(e, 'query', { query: 'warm-up', limit: 1, expand: false }, opts); warmed = true; }
      for (const arm of C8K_ARMS) {
        const keys = await setArmKeys(e, arm);
        for (const q of qs) rows.push({ kind: 'evidence', ...await queryArm(o.m, e, opts, arm, q, keys) });
        await clearArmKeys(e);
      }
      const a0 = armById('A0');
      for (const q of qs.filter(x => repeat.has(x.id))) {
        const r = await queryArm(o.m, e, opts, a0, q, await setArmKeys(e, a0));
        rows.push({ kind: 'repeat', question_id: q.id, arm: 'A0', text_sha256: r.text_sha256, is_error: r.is_error });
      }
    } finally { await e.disconnect(); }
    writeFileSync(`${out}.tmp`, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    renameSync(`${out}.tmp`, out);
  }
  const all = readEvidence(o.evidence);
  return { kind: 'c8k-freeze', ...o.identity, histories: readdirSync(o.evidence).filter(f => f.endsWith('.ndjson')).length, evidence_rows: all.evidence.length, repeat_rows: all.repeats.length,
    dispatch: 'dispatchToolCall(query) with the stdio server\'s options (c8k-product.ts stdioDispatchOpts)', service_ms_mean_by_arm: Object.fromEntries(C8K_ARMS.map(a => [a.id, mean(all.evidence.filter(r => r.arm === a.id).map(r => r.service_ms))])) };
}

export function readEvidence(dir: string): { evidence: EvidenceRow[]; repeats: Row[]; sha256: string } {
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.ndjson')).sort() : [];
  const h = createHash('sha256');
  const evidence: EvidenceRow[] = [], repeats: Row[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    h.update(f).update(text);
    for (const l of text.split('\n').filter(Boolean)) { const r = JSON.parse(l); (r.kind === 'repeat' ? repeats : evidence).push(r); }
  }
  return { evidence, repeats, sha256: h.digest('hex') };
}

// ─── gate ─────────────────────────────────────────────────────────

/** Session ids of a history by its pages' slugs (chat/<occurrence>), for the outside-history check and the packed chats. */
function sessionIndex(corpus: Corpus) {
  const bySource = new Map<string, { conversation: string; session: string }>();
  for (const c of corpus.conversations) for (const s of c.sessions) bySource.set(opaqueSourceId(c.id, s.id), { conversation: c.id, session: s.id });
  return { of: (slug: string) => { const src = sourceOfSlug(slug); return src ? bySource.get(src) ?? null : null; } };
}

/** Gate checks on the evidence alone (decision rule step 1). `tokens` counts a row as gbrain's budget does. */
export function retrievalChecks(d: C8kDecision, corpus: Corpus, ev: ReturnType<typeof readEvidence>, tokens: (row: unknown) => number) {
  const problems: string[] = [];
  const idx = sessionIndex(corpus);
  const qIds = new Set(corpus.questions.map(q => q.id));
  const perArm: Row = {};
  for (const arm of C8K_ARMS) {
    const rows = ev.evidence.filter(r => r.arm === arm.id);
    const ids = new Set(rows.map(r => r.question_id));
    const errors = rows.filter(r => r.is_error).length;
    const capped = arm.id !== 'A0' && arm.id !== 'R5';
    const overBudget = capped ? rows.filter(r => !r.is_error && resultRows(r.blocks).length > 0 && !(r.delivery && Number(r.delivery.budget_used) <= d.construction.query_budget)).length : 0;
    const notCapOnly = capped ? rows.filter(r => !r.is_error && resultRows(r.blocks).length > 0 && r.delivery?.auto_packing !== 'cap_only').length : 0;
    const factsOf = (r: EvidenceRow) => factRows(resultRows(r.blocks));
    const factTokens = rows.map(r => factsOf(r).reduce((n, x) => n + tokens(x), 0));
    const factCap = Math.floor(d.construction.query_budget * FACTS_BLOCK_SHARE);
    const safeIndexPending = rows.filter(r => Array.isArray(r.degraded) && (r.degraded as Array<{ stage?: string }>).some(s => s?.stage === 'safe_index_pending')).length;
    const factsOver = arm.id === 'A3' || arm.id === 'A4' ? rows.filter((r, i) => factTokens[i] > factCap || factsOf(r).length > FACTS_BLOCK_MAX_ROWS).length : 0;
    let outside = 0, receipts = 0;
    for (const r of rows) for (const x of resultRows(r.blocks)) {
      if (typeof x.slug !== 'string' || factRows([x]).length) continue;
      if (x.type === 'extract_receipt' && x.slug.startsWith('extracts/')) { receipts++; continue; }
      const s = idx.of(x.slug);
      if (!s || s.conversation !== r.haystack_id) outside++;
    }
    perArm[arm.id] = { rows: rows.length, questions: ids.size, tool_errors: errors, safe_index_pending: safeIndexPending, rows_outside_history: outside, extract_receipt_rows: receipts, budget_used_over_cap: overBudget, not_cap_only: notCapOnly,
      facts: { questions_with_facts: factTokens.filter(t => t > 0).length, rows_mean: mean(rows.map(r => factsOf(r).length)), tokens_max: Math.max(0, ...factTokens), over_share_or_rows: factsOver, cap_tokens: factCap },
      budget_used_mean: mean(rows.flatMap(r => r.delivery?.budget_used != null ? [Number(r.delivery.budget_used)] : [])), result_rows_mean: mean(rows.map(r => resultRows(r.blocks).length)),
      notices: count(rows.flatMap(r => r.notices)) };
    if (rows.length !== qIds.size || ids.size !== qIds.size || [...ids].some(id => !qIds.has(id))) problems.push(`${arm.id}: ${rows.length} results for ${ids.size} of ${qIds.size} questions`);
    if (errors) problems.push(`${arm.id}: ${errors} tool results are errors`);
    if (outside) problems.push(`${arm.id}: ${outside} rows name a page outside the question's history`);
    if (safeIndexPending) problems.push(`${arm.id}: ${safeIndexPending} results report safe_index_pending (a page is withheld from remote readers; the safe-chunks repair did not finish)`);
    if (overBudget) problems.push(`${arm.id}: ${overBudget} results do not report budget_used at most ${d.construction.query_budget}`);
    if (notCapOnly) problems.push(`${arm.id}: ${notCapOnly} results do not report auto_packing cap_only`);
    if (factsOver) problems.push(`${arm.id}: ${factsOver} results carry facts over ${factCap} tokens or ${FACTS_BLOCK_MAX_ROWS} rows`);
  }
  const want = determinismQuestions(corpus.questions, d.construction.determinism.questions, d.construction.determinism.seed);
  const a0 = new Map(ev.evidence.filter(r => r.arm === 'A0').map(r => [r.question_id, r.text_sha256]));
  const rep = new Map(ev.repeats.map(r => [r.question_id, r.text_sha256]));
  const equal = want.filter(id => rep.has(id) && rep.get(id) === a0.get(id)).length;
  const determinism = { questions: want.length, repeated: want.filter(id => rep.has(id)).length, byte_identical: equal, pass: equal === want.length };
  if (!determinism.pass) problems.push(`determinism: ${equal} of ${want.length} A0 results byte-identical on repeat`);
  return { per_arm: perArm, determinism, problems };
}

const readerRowsPath = (dir: string, reader: string, arm: string) => join(dir, reader, `${arm}.ndjson`);
/** The latest row per question of one reader and arm (a resumed read appends). */
export function readerRows(dir: string, reader: string, arm: string): Map<string, Row> {
  return new Map(readNdjson(readerRowsPath(dir, reader, arm)).map(r => [r.question_id, r]));
}

export function runGate(o: { decision: C8kDecision; decisionSha: string; corpus: Corpus; evidence: string; readers?: string; phase: 'retrieval' | 'final'; log: string; tokens: (row: unknown) => number; gbrain: Row; roles?: Array<C8kAnswerArm['role']> }) {
  const d = o.decision;
  const log = readLog(o.log);
  if (log.some(e => e.action === 'score' && e.decision_id === d.decision_id)) throw new Error('labels were already read under this decision; the gate must run before any label read');
  const ev = readEvidence(o.evidence);
  const checks = retrievalChecks(d, o.corpus, ev, o.tokens);
  const problems = [...checks.problems];
  if (RECIPE_HASH !== d.construction.renderer.recipe_hash) problems.push(`the renderer's recipe hash ${RECIPE_HASH} differs from the decision's ${d.construction.renderer.recipe_hash}`);
  const out: Row = { kind: 'c8k-gate', decision_id: d.decision_id, decision_sha256: o.decisionSha, phase: o.phase, created_at: new Date().toISOString(), gbrain: o.gbrain,
    access_log_lines_at_gate: log.length, labels_read_under_this_decision: 0, evidence_sha256: ev.sha256, renderer: { version: RENDERER_VERSION, recipe_hash: RECIPE_HASH, recipe: RENDER_RECIPE },
    retrieval: { per_arm: checks.per_arm, determinism: checks.determinism } };
  if (o.phase === 'final') {
    if (!o.readers) throw new Error('the final gate needs --readers-dir');
    const byKey = new Map(ev.evidence.map(r => [`${r.question_id}|${r.arm}`, r]));
    const qs = new Map(o.corpus.questions.map(q => [q.id, q]));
    const contexts: Row = {};
    for (const a of d.answer_arms.filter(x => (o.roles ?? ['primary', 'replay']).includes(x.role))) {
      const rows = readerRows(o.readers, a.reader, a.arm);
      let mismatched = 0, cuts = 0, overflow = 0;
      const tokens: number[] = [];
      for (const q of o.corpus.questions) {
        const r = rows.get(q.id), e = byKey.get(`${q.id}|${a.arm}`);
        if (!r || !e) continue;
        const ctx = renderContext(e.blocks, qs.get(q.id)!, d.construction.harness_budget_tokens);
        if (ctx.prompt_sha256 !== r.prompt_sha256 || r.recipe_hash !== RECIPE_HASH) mismatched++;
        cuts += ctx.rows_cut;
        if (ctx.tokens > d.construction.harness_budget_tokens) overflow++;
        tokens.push(ctx.tokens);
      }
      contexts[a.id] = { rows: rows.size, rerender_mismatches: mismatched, rows_cut_total: cuts, contexts_with_cuts: o.corpus.questions.filter(q => { const e = byKey.get(`${q.id}|${a.arm}`); return e && renderContext(e.blocks, q).rows_cut > 0; }).length,
        contexts_over_budget: overflow, tokens_mean: mean(tokens), reader_errors: [...rows.values()].filter(r => r.reader_error).length };
      if (rows.size !== o.corpus.questions.length) problems.push(`${a.id}: ${rows.size} reader rows for ${o.corpus.questions.length} questions`);
      if (mismatched) problems.push(`${a.id}: ${mismatched} contexts do not re-render to the bytes the reader got`);
    }
    out.contexts = contexts;
    out.render_identity = { rerender_mismatches: Object.values(contexts).reduce((n: number, c: Row) => n + c.rerender_mismatches, 0) };
  }
  out.problems = problems;
  out.pass = problems.length === 0;
  return out;
}

// ─── read ─────────────────────────────────────────────────────────

/** One reader over every arm, `concurrency` calls at a time; rows append, so a rerun answers only what is missing (identical requests come from the QA cache). */
export async function runRead(o: { custodyRoot: string; decision: C8kDecision; corpus: Corpus; evidence: string; readers: string; reader: string; model: string; arms?: string[]; cache: string; concurrency: number }) {
  checkCustodyPaths(o.custodyRoot, [['readers directory', o.readers], ['QA cache', o.cache]]);
  const ev = readEvidence(o.evidence);
  const byKey = new Map(ev.evidence.map(r => [`${r.question_id}|${r.arm}`, r]));
  const chat = new ChatClient(o.cache);
  const summary: Row = {};
  for (const arm of o.arms ?? C8K_ARMS.map(a => a.id)) {
    const path = readerRowsPath(o.readers, o.reader, arm);
    mkdirSync(dirname(path), { recursive: true });
    const done = readerRows(o.readers, o.reader, arm);
    const todo = o.corpus.questions.filter(q => !done.get(q.id) || done.get(q.id)!.reader_error);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const q = todo[next++];
        const e = byKey.get(`${q.id}|${arm}`);
        if (!e) throw new Error(`no ${arm} evidence for a question; the freeze is incomplete`);
        const ctx = renderContext(e.blocks, q, o.decision.construction.harness_budget_tokens);
        const base = { question_id: q.id, arm, reader: o.reader, model: o.model, prompt_sha256: ctx.prompt_sha256, recipe_hash: ctx.recipe_hash, context_tokens: ctx.tokens, rows_total: ctx.rows_total, rows_cut: ctx.rows_cut, slugs: ctx.slugs };
        let row: Row;
        try {
          const r = await chat.chat(o.model, ctx.prompt, { maxTokens: o.decision.readers.max_tokens, replicate: 0 });
          row = { ...base, answer: r.text, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cached: r.cached, finish: r.finish };
        } catch (err) {
          row = { ...base, reader_error: String((err as Error).message ?? err).slice(0, 300) };
        }
        appendFileSync(path, JSON.stringify(row) + '\n');
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
    const rows = [...readerRows(o.readers, o.reader, arm).values()];
    summary[arm] = { rows: rows.length, reader_errors: rows.filter(r => r.reader_error).length, input_tokens_mean: mean(rows.map(r => r.input_tokens ?? 0)), output_tokens_mean: mean(rows.map(r => r.output_tokens ?? 0)) };
  }
  return { kind: 'c8k-read', reader: o.reader, model: o.model, arms: summary };
}

// ─── answers ──────────────────────────────────────────────────────

export function writeAnswers(o: { custodyRoot: string; decision: C8kDecision; decisionSha: string; corpus: Corpus; readers: string; outDir: string; roles?: Array<C8kAnswerArm['role']> }) {
  const idx = sessionIndex(o.corpus);
  const summary: Row = {};
  for (const a of o.decision.answer_arms.filter(x => (o.roles ?? ['primary', 'replay']).includes(x.role))) {
    const out = join(o.outDir, `${a.id}.jsonl`);
    checkCustodyPaths(o.custodyRoot, [['answers file', out]]);
    const rows = readerRows(o.readers, a.reader, a.arm);
    const answers = o.corpus.questions.map(q => {
      const r = rows.get(q.id);
      if (!r) throw new Error(`${a.id}: no reader row for a question`);
      const retrieved = [...new Set((r.slugs as string[]).map(s => idx.of(s)).filter(s => s && s.conversation === q.conversation).map(s => s!.session))];
      const base = { question_id: q.id, haystack_id: q.conversation, retrieved, prompt_sha256: r.prompt_sha256, context_tokens: r.context_tokens, rows_cut: r.rows_cut, reader_input_tokens: r.input_tokens ?? null, reader_output_tokens: r.output_tokens ?? null };
      return typeof r.answer === 'string' && !r.reader_error ? { ...base, hypothesis: r.answer, reader_empty: !r.answer.trim() } : { ...base, reader_error: String(r.reader_error ?? 'no answer') };
    });
    const meta = { record_type: 'meta', decision_id: o.decision.decision_id, decision_sha256: o.decisionSha, arm: a.id, reader: a.model, gbrain_commit: o.decision.gbrain.commit, questions: answers.length };
    mkdirSync(o.outDir, { recursive: true });
    writeFileSync(out, [meta, ...answers].map(r => JSON.stringify(r)).join('\n') + '\n');
    summary[a.id] = { rows: answers.length, reader_errors: answers.filter(r => 'reader_error' in r).length, empty: answers.filter(r => (r as Row).reader_empty).length };
  }
  return summary;
}

/** Development only: the official LongMemEval judge over the dev answers, as sealed-runner-shaped score reports (per_question rows). */
export async function devScore(o: { custodyRoot: string; decision: C8kDecision; corpus: Corpus; answersDir: string; outDir: string; cache: string }) {
  checkCustodyPaths(o.custodyRoot, [['scores directory', o.outDir], ['QA cache', o.cache]]);
  const chat = new ChatClient(o.cache);
  const qs = new Map(o.corpus.questions.map(q => [q.id, q]));
  const out: Row = {};
  for (const f of readdirSync(o.answersDir).filter(x => x.endsWith('.jsonl')).sort()) {
    const rows = readNdjson(join(o.answersDir, f)).filter(r => r.record_type !== 'meta');
    const per: Row[] = [];
    for (const r of rows) {
      const q = qs.get(r.question_id)!;
      const kind = q.abstention ? 'abstention' : q.category;
      let correct = false;
      if (typeof r.hypothesis === 'string' && r.hypothesis.trim()) {
        const [prompt] = judgePromptsFor('lme-s', q, r.hypothesis);
        correct = judgeYes((await chat.chat(o.decision.development.judge, prompt, { maxTokens: 10, replicate: 0 })).text);
      }
      const gold = new Set(q.gold);
      per.push({ question_id: q.id, question_type: kind, haystack_id: q.conversation, answer_correct: correct, recall_all: gold.size ? [...gold].every(g => r.retrieved.includes(g)) : null });
    }
    const report = { set: o.corpus.source?.name ?? 'lme-s', judge: o.decision.development.judge, per_question: per, answers: { n: per.length, correct: per.filter(p => p.answer_correct).length } };
    writeJson(join(o.outDir, f.replace(/\.jsonl$/, '.json')), report);
    out[f.replace(/\.jsonl$/, '')] = report.answers;
  }
  return out;
}

// ─── decide ───────────────────────────────────────────────────────

export type C8kVerdict = 'pass' | 'fail' | 'inconclusive';
interface ComparisonOut { id: string; status: string; reasons?: string[]; stats?: { delta: number; ci95: [number, number] | null; p_two_sided: number; n_pairs: number; n_clusters: number; mean_a: number; mean_b: number }; mcnemar?: { wins: number; losses: number; p_two_sided: number } }

/** Guard 7 (a kind with a clear loss: exact one-sided McNemar on that kind's discordant pairs) and guard 8 (abstention not below the earlier configuration's), as in H1. */
export function kindGuards(rule: Pick<C8kRule, 'guard7'>, earlier: Row[], later: Row[]) {
  const kindRows = (rows: Row[]) => rows.map(r => ({ id: r.question_id, category: r.question_type, qa_score: r.answer_correct ? 1 : 0 }));
  const raw = kindGuard(kindRows(earlier), kindRows(later));
  const before = new Map(earlier.map(r => [r.question_id, r]));
  const kinds = Object.fromEntries(Object.entries(raw.kinds).map(([k, v]) => {
    let wins = 0, losses = 0;
    for (const r of later) {
      const c = before.get(r.question_id);
      if (r.question_type !== k || !c || !!r.answer_correct === !!c.answer_correct) continue;
      if (r.answer_correct) wins++; else losses++;
    }
    const p_loss_one_sided = oneSidedLossP(wins, losses);
    return [k, { ...v, wins, losses, p_loss_one_sided, pass: !(p_loss_one_sided < rule.guard7.alpha) }];
  }));
  const guard7 = { test: rule.guard7.test, alpha: rule.guard7.alpha, kinds, pass: Object.values(kinds).every(k => k.pass) };
  const abst = kinds['abstention'];
  const guard8 = abst ? { n: abst.n, earlier: abst.base, later: abst.cand, pass: abst.cand >= abst.base } : { n: 0, earlier: 0, later: 0, pass: true };
  return { guard7, guard8 };
}

/**
 * The preregistered rule (decision rule steps 3 to 5). Each Dk compares a later configuration (b) with the one before
 * it (a): pass needs both gates, delta > 0 with the persona-clustered 95% interval above zero and the Holm-adjusted
 * (over D1 to D4) exact two-sided McNemar p below alpha, guard 7 and guard 8; fail on a failed gate, guard 7, guard 8
 * or an interval wholly below zero; inconclusive otherwise (a blocked comparison, more than max_reader_errors in
 * either arm). D1's pass recommends F1 only when the lower bound of the 95% interval of A1 minus R5 is above
 * lower_bound_above; otherwise it is "pass, not recommended". Recommendations follow the contiguous run of
 * recommended comparisons starting at D1.
 */
export function decideC8k(rule: C8kRule, o: { gatePass: boolean; gateReasons?: string[]; comparisons: Record<string, ComparisonOut | undefined>; rows: Record<string, Row[]>; readerErrors: Record<string, number>; r5?: ComparisonOut }) {
  const ps = rule.holm.over.map(id => { const c = o.comparisons[id]; return c?.mcnemar && c.stats && c.status !== 'blocked' && c.status !== 'skipped' ? c.mcnemar.p_two_sided : 1; });
  const holm = holmAdjusted(ps);
  const pHolm = Object.fromEntries(rule.holm.over.map((id, i) => [id, holm[i]]));
  const results = rule.comparisons.map(cmp => {
    const reasons: string[] = [];
    const c = o.comparisons[cmp.id];
    const s = c?.stats;
    const p_holm = pHolm[cmp.id] ?? 1;
    const guards = kindGuards(rule, o.rows[cmp.a] ?? [], o.rows[cmp.b] ?? []);
    const superiority = !!(s && c?.mcnemar && s.delta > 0 && s.ci95 && s.ci95[0] > 0 && p_holm < rule.alpha);
    const shownWorse = !!(s?.ci95 && s.ci95[1] < 0);
    const tooMany = [cmp.a, cmp.b].filter(a => (o.readerErrors[a] ?? 0) > rule.max_reader_errors);
    let verdict: C8kVerdict;
    if (!o.gatePass) { verdict = 'fail'; reasons.push(`a gate failed: ${(o.gateReasons ?? []).join('; ') || 'see gate.json'}`); }
    else if (tooMany.length) { verdict = 'inconclusive'; reasons.push(...tooMany.map(a => `${a}: ${o.readerErrors[a]} reader errors exceed ${rule.max_reader_errors}`)); }
    else if (!c || !s || c.status === 'blocked' || c.status === 'skipped') { verdict = 'inconclusive'; reasons.push(`the comparison is ${c?.status ?? 'missing'}${c?.reasons?.length ? `: ${c.reasons.join('; ')}` : ''}`); }
    else if (!guards.guard7.pass || !guards.guard8.pass || shownWorse) {
      verdict = 'fail';
      if (!guards.guard7.pass) reasons.push(`guard 7: a clear loss in ${Object.entries(guards.guard7.kinds).filter(([, k]) => !k.pass).map(([k, v]) => `${k} (${v.wins} wins, ${v.losses} losses, one-sided p ${v.p_loss_one_sided.toPrecision(3)})`).join(', ')}`);
      if (!guards.guard8.pass) reasons.push(`guard 8: abstention ${guards.guard8.later} against ${guards.guard8.earlier}`);
      if (shownWorse) reasons.push(`the whole 95% interval of ${cmp.b} minus ${cmp.a} is below zero`);
    } else if (superiority) verdict = 'pass';
    else { verdict = 'inconclusive'; reasons.push('superiority not shown (delta > 0, 95% interval above zero and Holm-adjusted McNemar p < alpha are all required)'); }
    if (s) reasons.push(`delta ${s.delta.toFixed(4)}, 95% interval [${s.ci95?.map(x => x.toFixed(4)).join(', ') ?? 'n/a'}], McNemar p ${c?.mcnemar?.p_two_sided.toPrecision(3) ?? 'n/a'}, Holm p ${p_holm.toPrecision(3)}`);
    let recommended = verdict === 'pass';
    let noninferiority: Row | null = null;
    if (cmp.id === rule.f1_noninferiority.comparison) {
      const r = o.r5?.stats;
      const lower = r?.ci95?.[0] ?? null;
      noninferiority = { reference: rule.f1_noninferiority.reference, candidate: rule.f1_noninferiority.candidate, delta: r?.delta ?? null, ci95: r?.ci95 ?? null,
        lower_bound_above: rule.f1_noninferiority.lower_bound_above, pass: lower !== null && lower > rule.f1_noninferiority.lower_bound_above };
      if (verdict === 'pass' && !noninferiority.pass) { recommended = false; reasons.push(`pass, not recommended: the 95% interval of ${rule.f1_noninferiority.candidate} minus ${rule.f1_noninferiority.reference} has lower bound ${lower === null ? 'n/a' : lower.toFixed(4)}, not above ${rule.f1_noninferiority.lower_bound_above}`); }
    }
    return { id: cmp.id, tests: cmp.tests, a: cmp.a, b: cmp.b, verdict, label: verdict === 'pass' && !recommended ? 'pass, not recommended' : verdict, recommended, superiority_shown: superiority,
      stats: s ? { delta: s.delta, ci95: s.ci95, mcnemar: c!.mcnemar ?? null, p_holm, n_pairs: s.n_pairs, n_clusters: s.n_clusters, earlier: s.mean_a, later: s.mean_b } : null,
      noninferiority, guard7: guards.guard7, guard8: guards.guard8, reasons };
  });
  const prefix: string[] = [];
  for (const r of results) { if (!r.recommended) break; prefix.push(r.id); }
  const stranded = results.filter(r => r.recommended && !prefix.includes(r.id)).map(r => r.id);
  return { comparisons: results, p_holm: pHolm, recommended_prefix: prefix, recommendations: prefix.map(id => rule.recommendations[id]),
    reported_without_recommendation: stranded, outcome: prefix.length ? `recommend: ${prefix.map(id => rule.recommendations[id]).join('; ')}` : 'every flag stays off; the set is not reopened for these flags, and nothing is tuned on it' };
}

export function runDecide(o: { decision: C8kDecision; decisionSha: string; gate: Row; compareDir: string; scoresDir: string; answersDir: string; log: string }) {
  const d = o.decision;
  const problems: string[] = [];
  if (o.gate.decision_sha256 !== o.decisionSha || o.gate.phase !== 'final') problems.push('gate.json is not the final gate of this decision file');
  const primary = (arm: string) => d.answer_arms.find(a => a.role === 'primary' && a.arm === arm)!.id;
  const rows: Record<string, Row[]> = {};
  const scoreSha: Record<string, string> = {};
  for (const arm of C8K_ARMS) {
    const id = primary(arm.id), p = join(o.scoresDir, `${id}.json`);
    if (!existsSync(p)) { problems.push(`no score report for ${id}`); continue; }
    rows[arm.id] = readJson(p).per_question ?? [];
    scoreSha[arm.id] = sha256File(p);
  }
  const comparisons: Record<string, ComparisonOut | undefined> = {};
  const load = (file: string, a: string, b: string) => {
    const p = join(o.compareDir, file);
    if (!existsSync(p)) { problems.push(`no compare output ${file}`); return undefined; }
    const c = readJson(p);
    if (c.inputs?.[0]?.sha256 !== scoreSha[a] || c.inputs?.[1]?.sha256 !== scoreSha[b]) problems.push(`${file} was not computed from the ${a} and ${b} score reports (in that order)`);
    return (c.decision?.comparisons as ComparisonOut[] | undefined)?.find(x => x.id === 'answer_accuracy');
  };
  for (const c of d.rule.comparisons) comparisons[c.id] = load(`${c.id}.json`, c.a, c.b);
  const r5 = load('F1-noninferiority.json', d.rule.f1_noninferiority.reference, d.rule.f1_noninferiority.candidate);
  const log = readLog(o.log);
  const scoreLines = log.map((e, i) => ({ e, i })).filter(x => x.e.action === 'score' && x.e.decision_id === d.decision_id);
  if (scoreLines.some(x => x.i < o.gate.access_log_lines_at_gate)) problems.push('a label read under this decision precedes the final gate');
  const readerErrors: Record<string, number> = {};
  for (const arm of C8K_ARMS) {
    const p = join(o.answersDir, `${primary(arm.id)}.jsonl`);
    if (!existsSync(p)) continue;
    const ans = readNdjson(p);
    if (ans.find(r => r.record_type === 'meta')?.decision_sha256 !== o.decisionSha) problems.push(`${basename(p)} was written under another decision file`);
    readerErrors[arm.id] = ans.filter(r => r.record_type !== 'meta' && r.reader_error).length;
  }
  const result = decideC8k(d.rule, { gatePass: o.gate.pass === true && !problems.length, gateReasons: [...(o.gate.problems ?? []), ...problems], comparisons, rows, readerErrors, r5 });
  return { kind: 'c8k-decision-outcome', decision_id: d.decision_id, decision_sha256: o.decisionSha, decided_at: new Date().toISOString(), ...result, problems, reader_errors: readerErrors,
    label_reads: { this_decision: scoreLines.length, expected: d.rule.expected_label_reads, all_after_final_gate: scoreLines.every(x => x.i >= o.gate.access_log_lines_at_gate) } };
}

// ─── budget ───────────────────────────────────────────────────────

export function budgetSummary(d: C8kDecision, status: Row, prefix = 'c8k-') {
  const leases = (status.leases ?? []) as Array<{ cell: string; usd: number; status: string; actual_usd?: number }>;
  const steps = d.budget.steps.map(st => {
    const ls = leases.filter(l => l.cell === `${prefix}${st.id}`);
    const spent = ls.reduce((n, l) => n + (l.status === 'settled' ? l.actual_usd ?? 0 : l.status === 'abandoned' ? l.usd : 0), 0);
    return { id: st.id, estimate_usd: st.estimate_usd, cap_usd: st.cap_usd, leases: ls.length, reserved_usd: ls.reduce((n, l) => n + l.usd, 0), spent_usd: spent,
      open_leases: ls.filter(l => l.status !== 'settled' && l.status !== 'abandoned').length, alert_over_twice_estimate: spent > 2 * st.estimate_usd };
  });
  const spent = steps.reduce((n, s) => n + s.spent_usd, 0);
  return { kind: 'c8k-budget', decision_id: d.decision_id, campaign_id: status.campaign_id, cap_usd: status.cap_usd, committed_usd: status.committed_usd, remaining_usd: status.remaining_usd,
    estimate_usd: d.budget.estimate_usd, spent_usd: spent, alert_over_twice_estimate: spent > 2 * d.budget.estimate_usd, steps };
}

// ─── export ───────────────────────────────────────────────────────

/** Aggregates only: the step summaries, gates, decision, ledger, score aggregates and compare outputs, scanned before anything is written. */
export function runExport(o: { custodyRoot: string; corpus: Corpus; runs: string; out: string }) {
  if (resolve(o.out).startsWith(resolve(o.runs))) throw new Error('the export directory must be outside the runs directory');
  checkCustodyPaths(o.custodyRoot, [['export directory', o.out]]);
  const files: Array<{ path: string; text: string }> = [];
  const add = (path: string, value: unknown) => files.push({ path, text: JSON.stringify(value, null, 2) + '\n' });
  for (const f of ['custody-check.json', 'import.json', 'extract.json', 'freeze.json', 'gate-retrieval.json', 'gate.json', 'answers-summary.json', 'decision-outcome.json', 'dev-summary.json']) if (existsSync(join(o.runs, f))) add(f, readJson(join(o.runs, f)));
  for (const f of existsSync(join(o.runs, 'read')) ? readdirSync(join(o.runs, 'read')).filter(x => x.endsWith('.json')).sort() : []) add(`read/${f}`, readJson(join(o.runs, 'read', f)));
  for (const dir of ['scores', 'compare', 'ledger']) {
    const p = join(o.runs, dir);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p).filter(x => x.endsWith('.json')).sort()) { const v = readJson(join(p, f)); add(`${dir}/${f}`, dir === 'scores' ? scoreAggregate(v) : dir === 'compare' ? compareAggregate(v) : v); }
  }
  leakScan(files, o.corpus, o.custodyRoot);
  for (const f of files) { mkdirSync(dirname(join(o.out, f.path)), { recursive: true }); writeFileSync(join(o.out, f.path), f.text); }
  return { files: files.length, out: relative(o.custodyRoot, o.out) };
}

/** Per arm and kind for the development reading: accuracy, delivered tokens, rows, cuts, fact rows, errors (decides nothing). */
export function devSummary(d: C8kDecision, corpus: Corpus, scoresDir: string, readersDir: string, evidence: string) {
  const ev = readEvidence(evidence);
  const out: Row = {};
  for (const a of d.answer_arms.filter(x => x.role === 'development')) {
    const p = join(scoresDir, `${a.id}.json`);
    if (!existsSync(p)) continue;
    const per = readJson(p).per_question as Row[];
    const rr = readerRows(readersDir, a.reader, a.arm);
    const kinds = [...new Set(per.map(r => r.question_type))].sort();
    out[a.id] = { n: per.length, accuracy: mean(per.map(r => r.answer_correct ? 1 : 0)), by_kind: Object.fromEntries(kinds.map(k => [k, { n: per.filter(r => r.question_type === k).length, accuracy: mean(per.filter(r => r.question_type === k).map(r => r.answer_correct ? 1 : 0)) }])),
      context_tokens_mean: mean([...rr.values()].map(r => r.context_tokens)), rows_cut_total: [...rr.values()].reduce((n, r) => n + (r.rows_cut ?? 0), 0), reader_errors: [...rr.values()].filter(r => r.reader_error).length,
      reader_input_tokens_mean: mean([...rr.values()].map(r => r.input_tokens ?? 0)), reader_output_tokens_mean: mean([...rr.values()].map(r => r.output_tokens ?? 0)),
      fact_rows_mean: mean(ev.evidence.filter(r => r.arm === a.arm).map(r => factRows(resultRows(r.blocks)).length)) };
  }
  return { kind: 'c8k-dev-summary', decision_id: d.decision_id, corpus: (corpus as Row).id, questions: corpus.questions.length, note: 'Development reading: decides nothing.', arms: out };
}

// ─── CLI ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const [step, ...argv] = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (n: string) => { const v = one(n); if (!v) throw new Error(`${step} needs ${n}`); return v; };
  const flag = (n: string) => argv.includes(n);
  try {
    const custodyRoot = resolve(need('--custody-root'));
    const { decision, sha256 } = loadDecision(need('--decision'));
    const log = one('--access-log') ?? process.env.GBRAIN_EVALS_CUSTODY_LOG;
    const outPath = one('--out');
    if (outPath) checkCustodyPaths(custodyRoot, [['output', outPath]]);
    const dev = flag('--development');
    if (!dev && step !== 'budget') assertFilled(decision);
    const corpus = () => loadCustodyCorpus(need('--corpus'));
    const product = () => productUnderTest(need('--gbrain'), decision, flag('--keyless'));
    let result: unknown, fail = false;
    if (step === 'custody-check') result = custodyCheck({ custodyRoot, decision: decision as SealedDecision, manifestPath: need('--manifest'), questions: need('--questions'), labels: need('--labels'), log: log ?? need('--access-log') });
    else if (step === 'corpus') result = buildCorpus({ custodyRoot, decision, manifestPath: need('--manifest'), questions: need('--questions'), log: log ?? need('--access-log'), out: need('--corpus-out'), purpose: need('--purpose') });
    else if (step === 'dev-corpus') {
      const c = await devCorpus(decision, one('--limit') ? Number(one('--limit')) : undefined);
      const out = need('--corpus-out');
      checkCustodyPaths(custodyRoot, [['development corpus', out]]);
      writeJson(out, c);
      result = { id: c.id, questions: c.questions.length, conversations: c.conversations.length, kinds: count(c.questions.map(q => q.abstention ? 'abstention' : q.category)) };
    } else if (step === 'import') { const p = await product(); result = await runImport({ custodyRoot, corpus: corpus(), brains: resolve(need('--brains')), m: p.m, keyless: flag('--keyless'), identity: p.identity }); }
    else if (step === 'extract') { const p = await product(); result = await runExtract({ custodyRoot, corpus: corpus(), brains: resolve(need('--brains')), m: p.m, identity: p.identity }); }
    else if (step === 'freeze') { const p = await product(); result = await runFreeze({ custodyRoot, decision, corpus: corpus(), brains: resolve(need('--brains')), evidence: resolve(need('--evidence-dir')), m: p.m, identity: p.identity }); }
    else if (step === 'gate') {
      const p = await product();
      const g = runGate({ decision, decisionSha: sha256, corpus: corpus(), evidence: resolve(need('--evidence-dir')), readers: one('--readers-dir'), phase: need('--phase') as 'retrieval' | 'final', log: log ?? need('--access-log'), tokens: p.m.resultTokens, gbrain: p.identity, roles: dev ? ['development'] : undefined });
      result = g; fail = !g.pass;
    } else if (step === 'read') {
      const reader = need('--reader');
      const model = decision.answer_arms.find(a => a.reader === reader)?.model;
      if (!model) throw new Error(`the decision has no reader ${reader}`);
      result = await runRead({ custodyRoot, decision, corpus: corpus(), evidence: resolve(need('--evidence-dir')), readers: resolve(need('--readers-dir')), reader, model, cache: resolve(one('--qa-cache') ?? join(custodyRoot, 'cache', 'qa')), concurrency: Number(one('--concurrency') ?? 4) });
    } else if (step === 'answers') result = writeAnswers({ custodyRoot, decision, decisionSha: sha256, corpus: corpus(), readers: resolve(need('--readers-dir')), outDir: resolve(need('--out-dir')), roles: dev ? ['development'] : undefined });
    else if (step === 'dev-score') result = await devScore({ custodyRoot, decision, corpus: corpus(), answersDir: resolve(need('--answers-dir')), outDir: resolve(need('--out-dir')), cache: resolve(one('--qa-cache') ?? join(custodyRoot, 'cache', 'qa')) });
    else if (step === 'dev-summary') result = devSummary(decision, corpus(), resolve(need('--scores-dir')), resolve(need('--readers-dir')), resolve(need('--evidence-dir')));
    else if (step === 'decide') result = runDecide({ decision, decisionSha: sha256, gate: readJson(need('--gate')), compareDir: need('--compare-dir'), scoresDir: need('--scores-dir'), answersDir: need('--answers-dir'), log: log ?? need('--access-log') });
    else if (step === 'budget') result = budgetSummary(decision, readJson(need('--status')), one('--cell-prefix') ?? 'c8k-');
    else if (step === 'return-log') result = returnLog({ decision, from: need('--from'), to: need('--to') });
    else if (step === 'export') result = runExport({ custodyRoot, corpus: corpus(), runs: resolve(need('--runs')), out: resolve(need('--export-dir')) });
    else throw new Error(`unknown step ${step}; see the header of eval/runner/budgeted-delivery/c8k.ts`);
    if (outPath) writeJson(outPath, result);
    process.stdout.write(JSON.stringify(result, null, 2).slice(0, 4000) + '\n');
    if (fail) { process.stderr.write(`[c8k] ${step}: FAIL\n`); process.exit(1); }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[c8k] ${step} refused: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

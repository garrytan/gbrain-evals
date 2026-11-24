/**
 * Pinned questions: does gbrain flag the right sentences when the notes behind
 * a pinned answer change, and how soon does a corrected answer come back?
 *
 * gbrain can pin a question (\`gbrain questions pin\`, MCP \`questions_pin\`): it
 * answers from the notes with a citation behind every sentence, checks those
 * citations on every read, and its standing_questions cycle phase refreshes
 * the answer when evidence changes. This runner checks that loop on seeded
 * synthetic worlds (eval/generators/pinned-questions-gen.ts).
 *
 * Per seed, on in-memory PGLite through gbrain's own operation handlers and
 * pinned-question service, as the trusted local owner:
 *   1. The world's pages are written with put_page and its facts with remember.
 *   2. Each company's question is pinned with its entity scope. The model is
 *      a scripted oracle (see oracleChat): it answers each claim with one
 *      sentence citing every evidence line that states the ledger's value, so
 *      the citations are exactly what a careful answerer would cite and no
 *      paid call is made. A claim whose evidence was not retrieved gets no
 *      sentence and is reported as unanswered at pin time, not scored.
 *   3. Every answer is read once before any change (baseline false flags).
 *   4. Each company gets its one controlled change from the ledger.
 *   5. One status read per question (the first read after the change) gives
 *      the per-sentence stale flags and the question-level signal (stale, or
 *      new evidence since the watermark).
 *   6. Staleness latency: the standing_questions phase runs once per simulated
 *      day with gbrain's defaults (cooldown 1 day, at most 5 refreshes per
 *      run), the oracle now answering from the ledger's values after the
 *      change. Each simulated day first moves every pin's last attempt back one
 *      day. A question's latency is the first day its published answer matches
 *      the ledger and reads fresh. Changes run one at a time (changePass).
 *
 * The oracle is a control, not a capability measure: refreshed-answer quality
 * from real models is the paid arm in the preregistration. Report-only.
 * Hermetic: provider keys stripped, keyword search, zero paid calls.
 *
 * Usage: bun eval/runner/pinned-questions.ts [--seeds 1,2,3] [--companies 24] [--cycles 6] [--citation all|one] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 */
import { join } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import { exactConformance, summarize, type QuestionRow, type SentenceRow } from './pinned-questions-score.ts';
import {
  CLAIMS, DEV_SEEDS, PINNED_QUESTIONS_GENERATOR_VERSION, generatePinnedQuestionsWorld,
  type Claim, type PqCompany, type PqWorld,
} from '../generators/pinned-questions-gen.ts';

export const CATEGORY = 'pinned-questions';
export const DEFAULT_CYCLES = 6;

interface ChatReq { model: string; system: string; user: string; maxTokens: number }
interface ChatRes { text: string; usage: { input_tokens: number; output_tokens: number } | null; model: string }
export type QuestionChat = (req: ChatReq) => Promise<ChatRes>;

interface Sentence { id: string; text: string; origin: string; stale: boolean; reasons: string[] }
interface Receipt0 { id: string; freshness: string; new_evidence_since_watermark: boolean; answer?: Sentence[]; sentences: { stale: number } }
interface Engine { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; connect(c: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; readPageSnapshot(slug: string, o: { sourceId: string }): Promise<{ revision: unknown } | null> }

/** The sentence the oracle writes for a claim, and the text that marks a sentence as being about that claim. */
export function claimSentence(c: Pick<PqCompany, 'name' | 'product'>, claim: Claim, value: string): string {
  switch (claim) {
    case 'city': return `${c.name} builds ${c.product} in ${value}.`;
    case 'flagship': return `The flagship product of ${c.name} is the ${value}.`;
    case 'ceo': return `The chief executive of ${c.name} is ${value}.`;
    case 'founded': return `${c.name} was founded in ${value}.`;
  }
}

export function claimOf(c: PqCompany, text: string): Claim | null {
  for (const claim of CLAIMS) {
    const prefix = claimSentence(c, claim, '\u0000').split('\u0000')[0]!;
    if (text.startsWith(prefix)) return claim;
  }
  return null;
}

const wordIn = (value: string, line: string) => new RegExp(`(^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(line);

/**
 * The scripted answerer. It reads the question and the numbered evidence from
 * gbrain's prompt, and for each claim cites every evidence line that states the
 * ledger's value and names the company (policy \`all\`), or only the most
 * specific one, a fact row when there is one (policy \`one\`). \`phase\` picks the
 * values: before the change while pinning, after it while the scheduler refreshes.
 */
export const CITATION_POLICIES = ['all', 'one'] as const;
export type CitationPolicy = typeof CITATION_POLICIES[number];

export function oracleChat(world: PqWorld, phase: (question: string) => 'before' | 'after', calls: Map<string, number>, policy: CitationPolicy = 'all'): QuestionChat {
  const byQuestion = new Map(world.companies.map(c => [c.question, c]));
  return async (req) => {
    const qline = req.user.split('\n').find(l => l.startsWith('Question: ')) ?? '';
    const c = byQuestion.get(qline.slice('Question: '.length));
    if (!c) throw new Error(`oracle: unknown question ${qline.slice(0, 80)}`);
    calls.set(c.slug, (calls.get(c.slug) ?? 0) + 1);
    const values = phase(c.question) === 'before' ? c.before : c.after;
    const lines = req.user.split('\n').filter(l => /^E\d+: /.test(l));
    const sentences: Array<{ text: string; cite: string[] }> = [];
    const gaps: string[] = [];
    for (const claim of CLAIMS) {
      const v = values[claim];
      const stating = v === null ? [] : lines.filter(l => wordIn(v, l) && (l.includes(c.name) || l.includes(c.slug)));
      const chosen = policy === 'all' ? stating : stating.filter(l => l.includes('[fact about')).slice(0, 1).concat(stating).slice(0, 1);
      const cite = chosen.map(l => l.slice(0, l.indexOf(':')));
      if (v === null || !cite.length) { gaps.push(claim); continue; }
      sentences.push({ text: claimSentence(c, claim, v), cite });
    }
    return { text: JSON.stringify({ sentences, gaps }), usage: { input_tokens: 0, output_tokens: 0 }, model: 'oracle' };
  };
}

/** The published answer matches the ledger after the change: a fresh sentence for every claim with a value, and no sentence stating a replaced or removed value. */
export function answerMatches(c: PqCompany, answer: readonly Sentence[]): boolean {
  for (const claim of CLAIMS) {
    const now = c.after[claim], was = c.before[claim];
    const about = answer.filter(s => s.origin === 'model' && claimOf(c, s.text) === claim);
    if (now !== null && !about.some(s => !s.stale && wordIn(now, s.text))) return false;
    if (was !== now && about.some(s => wordIn(was, s.text))) return false;
  }
  return true;
}

interface Sut {
  engine: Engine; ctx: OperationContext;
  op(name: string, params: Record<string, unknown>): Promise<unknown>;
  pin(question: string, entity: string, chat: QuestionChat): Promise<{ receipt: Receipt0 }>;
  status(id: string): Promise<Receipt0>;
  refresh(id: string, chat: QuestionChat): Promise<Receipt0>;
  cycle(chat: QuestionChat): Promise<unknown>;
  close(): Promise<void>;
}

async function openSut(gut: GbrainUnderTest): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const service = await importGbrain<{
    pinQuestion(ctx: OperationContext, p: Record<string, unknown>, deps: { chat: QuestionChat }): Promise<{ receipt: Receipt0 }>;
    questionStatus(ctx: OperationContext, p: Record<string, unknown>): Promise<Receipt0>;
    refreshQuestion(ctx: OperationContext, p: Record<string, unknown>, deps: { chat: QuestionChat }): Promise<Receipt0>;
  }>(gut, 'src/core/questions/service.ts');
  const { runPhaseStandingQuestions } = await importGbrain<{ runPhaseStandingQuestions(e: Engine, o: { dryRun: boolean; chat: QuestionChat }): Promise<unknown> }>(gut, 'src/core/questions/phase.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:', embedding_disabled: true }, logger, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
  const byName = new Map(operations.map(o => [o.name, o]));
  const op = async (name: string, params: Record<string, unknown>) => {
    const o = byName.get(name);
    if (!o) throw new Error(`gbrain has no operation ${name}`);
    return await o.handler(ctx, params);
  };
  return {
    engine, ctx, op,
    pin: (question, entity, chat) => service.pinQuestion(ctx, { question, scope: { entity } }, { chat }),
    status: id => service.questionStatus(ctx, { id }),
    refresh: (id, chat) => service.refreshQuestion(ctx, { id }, { chat }),
    cycle: chat => runPhaseStandingQuestions(engine, { dryRun: false, chat }),
    close: () => engine.disconnect(),
  };
}

async function put(sut: Sut, slug: string, content: string): Promise<void> {
  const snapshot = await sut.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await sut.op('put_page', { slug, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
}

async function factId(sut: Sut, entity: string, text: string): Promise<number> {
  const rows = await sut.engine.executeRaw<{ id: string | number }>(
    'SELECT id FROM facts WHERE entity_slug = $1 AND fact = $2 AND expired_at IS NULL AND superseded_by IS NULL ORDER BY id DESC LIMIT 1', [entity, text]);
  if (!rows[0]) throw new Error(`presence: remember wrote no live fact row for ${entity}: ${text}`);
  return Number(rows[0].id);
}


interface Brain { sut: Sut; ids: Map<string, string>; firstAnswer: Map<string, Sentence[]>; cites: Map<string, string[]>; facts: Map<string, number>; setPhase(slug: string, p: 'before' | 'after'): void; calls: Map<string, number>; chat: QuestionChat }

/** A fresh brain with the world written and every question pinned (oracle answers from the values before the change). */
async function buildBrain(gut: GbrainUnderTest, world: PqWorld, citation: CitationPolicy): Promise<Brain> {
  const sut = await openSut(gut);
  for (const p of world.pages) await put(sut, p.slug, p.content);
  const facts = new Map<string, number>();
  for (const f of world.facts) {
    await sut.op('remember', { fact: f.text, entity: f.entity, kind: 'fact', visibility: 'world', provenance: 'pinned-questions world ledger' });
    facts.set(f.entity, await factId(sut, f.entity, f.text));
  }
  for (const p of world.pages) {
    if (!(await sut.engine.readPageSnapshot(p.slug, { sourceId: 'default' }))) throw new Error(`presence: page ${p.slug} was not stored`);
  }
  const phases = new Map<string, 'before' | 'after'>();
  const byQuestion = new Map(world.companies.map(c => [c.question, c.slug]));
  const calls = new Map<string, number>();
  const chat = oracleChat(world, q => phases.get(byQuestion.get(q)!) ?? 'before', calls, citation);
  const ids = new Map<string, string>();
  const firstAnswer = new Map<string, Sentence[]>();
  for (const c of world.companies) {
    const { receipt } = await sut.pin(c.question, c.slug, chat);
    ids.set(c.slug, receipt.id);
    firstAnswer.set(c.slug, (receipt.answer ?? []).filter(s => s.origin === 'model'));
  }
  const cites = new Map<string, string[]>();
  for (const e of await sut.engine.executeRaw<{ slug: string; sentence_id: string; kind: string; page_slug: string | null; item_id: string | number | null }>(
    `SELECT q.slug, e.sentence_id, e.kind, e.page_slug, e.item_id FROM question_evidence e JOIN pinned_questions q ON q.id = e.question_id AND e.answer_revision = q.answer_revision ORDER BY e.id`)) {
    const key = `${e.slug}|${e.sentence_id}`;
    cites.set(key, [...(cites.get(key) ?? []), e.kind === 'fact' ? `fact:${e.item_id}` : `${e.kind}:${e.page_slug}`]);
  }
  calls.clear();
  return { sut, ids, firstAnswer, cites, facts, calls, chat, setPhase: (slug, p) => phases.set(slug, p) };
}

async function applyChange(b: Brain, c: PqCompany): Promise<void> {
  for (const step of c.steps) {
    if (step.op === 'put') await put(b.sut, step.page.slug, step.page.content);
    else if (step.op === 'delete') {
      const snapshot = await b.sut.engine.readPageSnapshot(step.slug, { sourceId: 'default' });
      await b.sut.op('delete_page', { slug: step.slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
    } else {
      await b.sut.op('remember', { fact: step.fact.text, entity: step.fact.entity, kind: 'fact', visibility: 'world', provenance: 'pinned-questions world ledger', replaces: b.facts.get(step.fact.entity) });
      await factId(b.sut, step.fact.entity, step.fact.text);
    }
  }
  b.setPhase(c.slug, 'after');
}

const signalOf = (r: Receipt0) => r.freshness === 'stale' || r.new_evidence_since_watermark === true;

/**
 * One change at a time, in one brain per seed:
 *   1. apply a company's change;
 *   2. read its question once: per-sentence flags and the question's signal;
 *   3. read every other question: one that now signals is a spillover false
 *      alarm, because this change touched none of its claims;
 *   4. run the standing_questions phase once per simulated day, with gbrain's
 *      defaults, until this question's published answer matches the ledger and
 *      reads fresh, or \`cycles\` days pass; every refresh the phase runs on those
 *      days is counted against this change;
 *   5. refresh every question that still signals, so the next change starts
 *      from fresh answers and current watermarks.
 */
/** A presence check that failed, or an oracle sentence with no claim, is the harness's fault: it voids the seed instead of scoring gbrain. */
export const voidsSeed = (message: string) => message.startsWith('presence:') || message.startsWith('oracle sentence with no claim');

/** The question row for a change whose first status read threw: nothing was read, so it has no sentences and no signal. */
export function failedQuestion(seed: number, c: PqCompany, baselineStale: number): QuestionRow {
  return {
    seed, company: c.slug, mutation: c.mutation, affected: [...c.affected], unanswered_at_pin: [], baseline_stale: baselineStale, freshness: 'error', new_evidence: false,
    stale_sentences: 0, gold_signal: c.affected.length > 0, signalled: false, spillover: 0, cycles_to_correct: null, refreshes: 0,
  };
}

/** afterRead: called once a change's status reads are in and its row is built, before the refresh days (a test seam for a gbrain error partway through). */
export interface ChangeHooks { afterRead?(slug: string): void | Promise<void> }

async function changePass(gut: GbrainUnderTest, world: PqWorld, citation: CitationPolicy, cycles: number, sentences: SentenceRow[], questions: QuestionRow[], acc: ProbeAccounting, hooks: ChangeHooks = {}): Promise<void> {
  const b = await buildBrain(gut, world, citation);
  try {
    const baseline = new Map<string, number>();
    for (const c of world.companies) baseline.set(c.slug, (await b.sut.status(b.ids.get(c.slug)!)).sentences.stale);
    for (const c of world.companies) {
      const probe = `s${world.seed}:${c.slug}`;
      const local: SentenceRow[] = [];
      let row: QuestionRow | null = null;
      try {
        await applyChange(b, c);
        const r = await b.sut.status(b.ids.get(c.slug)!);
        const flags = new Map((r.answer ?? []).map(s => [s.id, s]));
        const answered = new Set<Claim>();
        for (const s of b.firstAnswer.get(c.slug)!) {
          const claim = claimOf(c, s.text);
          if (!claim) throw new Error(`oracle sentence with no claim: ${s.text}`);
          answered.add(claim);
          const now = flags.get(s.id);
          local.push({
            seed: world.seed, company: c.slug, mutation: c.mutation, claim, text: s.text,
            cites: b.cites.get(`${b.ids.get(c.slug)!.split(':').slice(1).join(':')}|${s.id}`) ?? [],
            affected: c.affected.includes(claim), flagged: now ? now.stale : true, reasons: now ? now.reasons : ['sentence_missing'],
          });
        }
        let spillover = 0;
        for (const o of world.companies) {
          if (o.slug !== c.slug && signalOf(await b.sut.status(b.ids.get(o.slug)!))) spillover++;
        }
        const gold = c.affected.length > 0;
        row = {
          seed: world.seed, company: c.slug, mutation: c.mutation, affected: [...c.affected], unanswered_at_pin: CLAIMS.filter(x => !answered.has(x)),
          baseline_stale: baseline.get(c.slug) ?? 0, freshness: r.freshness, new_evidence: r.new_evidence_since_watermark === true,
          stale_sentences: r.sentences.stale, gold_signal: gold, signalled: signalOf(r), spillover, cycles_to_correct: null, refreshes: 0,
        };
        await hooks.afterRead?.(c.slug);
        b.calls.clear();
        for (let day = 1; day <= cycles; day++) {
          await b.sut.engine.executeRaw(`UPDATE pinned_questions SET last_attempt_at = last_attempt_at - interval '1 day' WHERE last_attempt_at IS NOT NULL`);
          await b.sut.cycle(b.chat);
          const now = await b.sut.status(b.ids.get(c.slug)!);
          if (now.freshness === 'fresh' && answerMatches(c, now.answer ?? [])) { row!.cycles_to_correct = day; break; }
        }
        row.refreshes = [...b.calls.values()].reduce((x, y) => x + y, 0);
        for (const o of world.companies) {
          if (signalOf(await b.sut.status(b.ids.get(o.slug)!))) await b.sut.refresh(b.ids.get(o.slug)!, b.chat);
        }
        sentences.push(...local);
        questions.push(row);
        acc.score(probe, Number(row.signalled === row.gold_signal));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (voidsSeed(message)) throw e;
        questions.push({ ...(row ?? failedQuestion(world.seed, c, baseline.get(c.slug) ?? 0)), error: message });
        acc.error(probe, 'sut', message);
      }
    }
  } finally {
    await b.sut.close().catch(() => {});
  }
}

export interface PqRunResult { worlds: PqWorld[]; sentences: SentenceRow[]; questions: QuestionRow[]; acc: ProbeAccounting; harnessError: string | null }

export async function runPinnedQuestions(opts: { gut: GbrainUnderTest; seeds?: readonly number[]; companies?: number; cycles?: number; citation?: CitationPolicy; log?: (s: string) => void; hooks?: ChangeHooks }): Promise<PqRunResult> {
  return withHermeticEnv(CATEGORY, async () => {
    const log = opts.log ?? (() => {});
    const cycles = opts.cycles ?? DEFAULT_CYCLES;
    const worlds = (opts.seeds ?? DEV_SEEDS).map(seed => generatePinnedQuestionsWorld({ seed, companies: opts.companies }));
    const acc = new ProbeAccounting(0);
    const sentences: SentenceRow[] = [];
    const questions: QuestionRow[] = [];
    let harnessError: string | null = null;
    for (const world of worlds) {
      const seed = world.seed;
      try {
        await changePass(opts.gut, world, opts.citation ?? 'all', cycles, sentences, questions, acc, opts.hooks);
        log(`seed ${seed}: ${world.pages.length} pages, ${world.facts.length} facts, ${world.companies.length} questions`);
      } catch (e) {
        harnessError = `seed ${seed}: ${e instanceof Error ? e.message : String(e)}`;
        acc.error(`s${seed}:seed`, 'harness', harnessError);
      }
    }
    const planned = new ProbeAccounting(worlds.reduce((a, w) => a + w.companies.length, 0));
    planned.absorb(acc.toJSON());
    return { worlds, sentences, questions, acc: planned, harnessError };
  });
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (x: number | null) => (x === null ? 'n/a' : (100 * x).toFixed(1) + '%');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seeds = (argValue(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  const companies = Number(argValue(argv, '--companies') ?? 24);
  const cycles = Number(argValue(argv, '--cycles') ?? DEFAULT_CYCLES);
  const citation = (argValue(argv, '--citation') ?? 'all') as CitationPolicy;
  if (!CITATION_POLICIES.includes(citation)) throw new Error(`--citation takes ${CITATION_POLICIES.join(' or ')}`);
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# pinned-questions (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const r = await runPinnedQuestions({ gut, seeds, companies, cycles, citation, log });
  const a = r.acc.summary();
  const summary = summarize(r.sentences, r.questions);
  const conformance = exactConformance(r.sentences, r.questions);
  const receipt = {
    ...noModelSpend('hermetic: provider keys stripped, keyword search; the pinned-question model is a scripted oracle; no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessError ? 'error' : 'completed',
    ...(r.harnessError ? {} : { verdict: conformance.pass ? 'pass' as const : 'fail' as const }),
    n_total: a.n_total, n_scored: a.n_scored, completion_rate: a.completion_rate, errors: a.errors,
    publishable: a.publishable && !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory', decide: DECIDE_OFF,
      caller: 'operation handlers and src/core/questions/service.ts with OperationContext { remote: false, sourceId: default } (the brain owner on the host)',
      gate: 'report-only',
      seeds, companies_per_seed: companies, cycles, citation, generator_version: PINNED_QUESTIONS_GENERATOR_VERSION,
      model: 'oracle (scripted): one sentence per claim citing the evidence lines that state the ledger value and name the company (citation all: every such line; one: a fact row if any, else the first); values before the change while pinning, after it while refreshing',
      scheduler: 'runPhaseStandingQuestions with gbrain defaults (cooldown 1 day, max 5 per run); each simulated day moves every last_attempt_at back one day first',
      flags: 'first questions_status read after the change; a sentence missing from it counts as flagged',
      verdict: 'exact conformance (scorer check only; the category is report-only)',
      gbrain_overlay: overlaySummary(gut),
    },
    hashes: Object.fromEntries(r.worlds.map(w => [`ledger_seed_${w.seed}`, w.fingerprint])),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { summary, conformance, sentences: r.sentences, questions: r.questions, harness_error: r.harnessError },
  } as unknown as Receipt;
  writeReceipt(outPath, receipt);
  const o = summary.overall.flags;
  log(`verdict: ${r.harnessError ? 'error' : conformance.pass ? 'pass' : 'fail'} (${conformance.detail})`);
  log(`sentence flags: precision ${pct(o.precision)}, recall ${pct(o.recall)}, false-flag rate ${pct(o.false_flag_rate)} (tp ${o.tp} fp ${o.fp} fn ${o.fn} tn ${o.tn})`);
  log(`question signal: recall ${pct(summary.question_signal.recall)}, false alarms ${summary.question_signal.fp}; wasted refreshes ${summary.wasted_refreshes}; baseline false flags ${summary.baseline_false_flags}; unanswered at pin ${summary.unanswered_at_pin}`);
  log('\n| change | questions | sentences | tp | fp | fn | tn | signalled | spillover per change | corrected in run | median days | refreshes |\n|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(summary.by_class)) {
    log(`| ${k} | ${v.questions} | ${v.sentences} | ${v.flags.tp} | ${v.flags.fp} | ${v.flags.fn} | ${v.flags.tn} | ${pct(v.signal_rate)} | ${v.spillover_per_change?.toFixed(1) ?? 'n/a'} | ${pct(v.corrected_within_run)} | ${v.median_cycles_to_correct ?? 'n/a'} | ${v.refreshes} |`);
  }
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, summary }, null, 2) + '\n');
  process.exit(r.harnessError ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}

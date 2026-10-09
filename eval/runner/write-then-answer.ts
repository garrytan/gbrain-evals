/**
 * Q2 G6 (and P5 H6): do typed relation lines help an agent answer from a brain it wrote itself?
 *
 * One invocation runs one arm on one corpus for every model and ingest:
 *   ingest     the agent reads the corpus in fixed batches and writes the brain through gbrain's MCP server, following
 *              the arm's guidance. After every batch the server stops, `gbrain extract --stale` reconciles the links an
 *              MCP (remote) writer left as text, and the brain is snapshotted. `--ingests 3` independent brains per
 *              model. After the last batch the build's own parser lists the brain's grammar lines and list lines into
 *              the work root (G2 stratum, adoption recall, grammar lines and diagnostics per page).
 *   answer     every question is answered once on each ingested brain (read-only tools, concurrent sessions per brain)
 *   judge      each answer is judged once by gpt-6.1-sol with rubric q2-wta-judge-v1 (answerable and unanswerable
 *              items scored separately; UNKNOWN is correct on an unanswerable item); a hash-selected 10% is re-judged
 *              by claude-opus-5-5 (audit, agreement reported, never a score)
 *   immediate  reported, not gated: 25% of the questions (hash-selected pairs), one fresh ingest per model, the serve
 *              sweep off (GBRAIN_SWEEP=0) and no extract --stale between batches; extraction state is recorded before
 *              and after answering, so no G6 result promises immediate typed graph visibility
 *   http-journey  one HTTP-writer journey: a finished brain's pages written over `gbrain serve --http`, typed edges
 *              read before and after `gbrain sweep --once`
 *
 * Models: claude-sonnet-5-5, gpt-6.1-sol and claude-opus-5-5 (preregistration amendment 4; Fable 5.1 is smoke-test
 * only). `--skip-models <list>` resumes an existing work root without some of its recorded models: the experiment
 * identity (experiment.json, and its model list when --models is not given) stays the recorded one, no ingest, answer
 * or judgment is made for a skipped model, and its existing checkpoint records stay in place; the receipt keeps the
 * rows it already has, flagged `skipped_model: 1` and left out of the accounting and summaries. `compare` and
 * `q2/power-sim.ts` take `--exclude-models <list>` to drop a model's rows before scoring.
 *
 * Arms: A = the final Q2 build with GBRAIN_EVAL_CONFIG=line_grammar.enabled=false and guidance-a.md; B = the same
 * build with line_grammar.enabled=true and the guidance that would ship. Rows pair across arms by
 * (corpus, model, ingest, question); the cluster is the question pair, whose key is shared across models.
 *
 *   bun eval/runner/write-then-answer.ts compare --a <receipt>[,..] --b <receipt>[,..] --output <dir> [--exclude-models <list>]   crossed bootstrap, G6 gates
 *   bun eval/runner/write-then-answer.ts adoption --work <arm B work root> --output <dir> --paid ...      adoption-recall labels
 *
 * Corpora: `--corpus amara` (amara-life-v1, chronicle-lift renderCorpus) or `--corpus career`. Development runs use dev
 * seeds 1-3: amara questions from calendar invites and meetings plus unanswerable decoys; the development career
 * corpus from eval/generators/career-chronicle-dev-gen.ts. Custodian runs: --questions-file <q-questions.json>
 * (and --career-dir <custody dir> for the career corpus) with --decision-id, --purpose, explicit --output and --work
 * outside every git worktree; rows then omit question and answer text, and one opening per work root is enforced.
 *
 * Usage:
 *   bun eval/runner/write-then-answer.ts --gbrain <checkout>@<ref> --arm-label A|B --guidance <file> --corpus amara|career
 *     --output <dir> --work <dir> [--models claude-sonnet-5-5,gpt-6.1-sol,claude-opus-5-5] [--skip-models <list>] [--ingests 3]
 *     [--judge gpt-6.1-sol] [--audit-judge claude-opus-5-5] [--audit-fraction 0.1] [--phase ingest|answer|judge|immediate|http-journey|all]
 *     [--dev-seed 1] [--dev-pairs 8] [--batch-chars 24000] [--ingest-batches N] [--concurrency 4] [--pilot | --limit N]
 *     [--scripted] [--paid --budget-usd N | --paid --budget-run-id <id>] [--campaign <root> --step <id> --run <name>]
 * Resume: ingest.jsonl (one line per batch, with a snapshot), answers.jsonl and judgments.jsonl (attempt checkpoints
 * keyed by corpus, ingest, model, arm and question; failed attempts kept as retryable or terminal). Every interruption
 * prints the resume command, remaining work, cumulative spend and whether the resume continues the same opening.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { runAgent, type AgentRun, type ScriptedModel } from './cat40/loop.ts';
import { receiptCost, type RunSummary } from './budget-ledger.ts';
import { openP5HttpBrain, p5Receipt } from './p5-brain.ts';
import { corpusDigest, renderCorpus } from './chronicle-lift.ts';
import {
  AgentBrain, Checkpoint, closePaid, P5_ANSWER_TOOLS, ToolsArm, chatText, firstJsonObject, flagValue, limitFlag, openPaid, readGuidance,
  runPool, seededSample, selectUnits, sha256, type ChatOut, type PaidSession,
} from './p5-agent.ts';
import { writeReceipt } from './receipt.ts';
import { assertCustodyRoots } from './sealed-confirmation-lib.ts';
import { generateCareerDevWorld, CAREER_TODAY } from '../generators/career-chronicle-dev-gen.ts';
import { campaignGuard } from './q2/campaign.ts';
import { AttemptCheckpoint, answerKey, failureClass, interruptionReport, judgeKey, openOrContinue, resumeCommand, withAttempts, type UnitIdentity } from './q2/checkpoints.ts';
import { crossedBootstrap, g6Gates, type AnswerRow } from './q2/crossed-bootstrap.ts';
import { ADOPTION_PROMPT_VERSION, ADOPTION_SYSTEM, adoptionPrompt, brainKey, extractGrammarLines, type ListLineRecord } from './q2/grammar-lines.ts';
import { buildParser } from './q2/junk-audit.ts';
import { G6_AUDIT_JUDGE, G6_JUDGE, G6_MODELS } from './q2/preflight.ts';
import { loadCareerCorpus, loadQuestionsFile, type QCorpus, type QQuestion } from './q2/q-set.ts';
import { Q2_LINE_JUDGES } from './q2/judge.ts';
import { WTA_JUDGE_SYSTEM, WTA_RUBRIC_SHA256, WTA_RUBRIC_VERSION, inAudit, parseWtaVerdict, wtaJudgePrompt, type WtaVerdict } from './q2/wta-judge.ts';

export const CATEGORY = 'write-then-answer';
export const VERSION = 'q2-write-then-answer-v1';
export const DEV_SEEDS: readonly number[] = [1, 2, 3];
export const DEFAULT_MODELS: readonly string[] = G6_MODELS;
export const DEFAULT_INGESTS = 3;
export const TODAY = '2026-04-19';
export const IMMEDIATE_FRACTION = 0.25;
export const IMMEDIATE_INGEST = -1;
const REPO = resolve(import.meta.dir, '../..');

export type QaQuestion = QQuestion;

// ─── Dev questions ──────────────────────────────────────────────────

const nameOf = (slug: string) => slug.replace(/^.*\//, '').split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const fm = (content: string, key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(content.split(/\n---\n/)[0])?.[1]?.trim() ?? '';
const yamlSlugs = (v: string) => v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);

/** Items with a title, a date and attendees other than Amara: calendar invites and meeting pages. */
export function datedItems(pages = renderCorpus()): Array<{ id: string; kind: 'calendar' | 'meeting'; title: string; date: string; people: string[] }> {
  const out: Array<{ id: string; kind: 'calendar' | 'meeting'; title: string; date: string; people: string[] }> = [];
  for (const p of pages) {
    const isCal = p.path.startsWith('cal/');
    if (!isCal && !p.path.startsWith('meetings/')) continue;
    const title = isCal ? fm(p.content, 'title').replace(/^"|"$/g, '') : (/^# (.+)$/m.exec(p.content)?.[1] ?? '').trim();
    const date = fm(p.content, 'date').slice(0, 10);
    const people = yamlSlugs(fm(p.content, 'attendees')).filter(s => s.startsWith('people/')).map(nameOf);
    if (title && /^\d{4}-\d{2}-\d{2}$/.test(date) && people.length) out.push({ id: p.path.replace(/\.md$/, ''), kind: isCal ? 'calendar' : 'meeting', title, date, people });
  }
  // A title that repeats across items is ambiguous; keep only titles that occur once.
  return out.filter(x => out.filter(y => y.title === x.title).length === 1);
}

const DEV_DECOY_TITLES = ['Quarterly lighthouse review', 'Harbor partners breakfast', 'Northfield board prep'];

/** `pairs` seeded items, each giving one relational and one temporal question. */
export function devQuestions(seed: number, pairs: number, kinds: ReadonlyArray<'calendar' | 'meeting'> = ['calendar', 'meeting']): QaQuestion[] {
  if (!DEV_SEEDS.includes(seed)) throw new Error(`dev questions use dev seeds ${DEV_SEEDS.join(', ')}; the sealed set comes from the custodian`);
  return seededSample(datedItems().filter(it => kinds.includes(it.kind)), pairs, seed).flatMap((it, i) => {
    const pair = `dev${seed}-p${String(i + 1).padStart(2, '0')}`;
    const what = it.kind === 'calendar' ? `the calendar invite "${it.title}"` : `the meeting "${it.title}"`;
    return [
      { id: `${pair}-rel`, pair, corpus: 'amara' as const, type: 'relational' as const, answerable: true, question: `Who, other than Amara, was part of ${what}? Answer with their full names.`, answer: it.people.join(', ') },
      { id: `${pair}-tmp`, pair, corpus: 'amara' as const, type: 'temporal' as const, answerable: true, question: `On what date was ${what}? Answer with the date as YYYY-MM-DD.`, answer: it.date },
    ];
  });
}

/** One unanswerable development pair per seed: a meeting title the corpus never mentions (UNKNOWN is correct). */
export function devDecoyQuestions(seed: number): QaQuestion[] {
  const title = DEV_DECOY_TITLES[(seed - 1) % DEV_DECOY_TITLES.length];
  if (datedItems().some(it => it.title === title) || renderCorpus().some(p => p.content.includes(title))) throw new Error(`development decoy title "${title}" appears in amara-life-v1; pick another`);
  const pair = `dev${seed}-decoy`;
  return [
    { id: `${pair}-rel`, pair, corpus: 'amara', type: 'relational', answerable: false, question: `Who, other than Amara, was part of the meeting "${title}"? Answer with their full names.`, answer: 'UNKNOWN (no such meeting in the records)' },
    { id: `${pair}-tmp`, pair, corpus: 'amara', type: 'temporal', answerable: false, question: `On what date was the meeting "${title}"? Answer with the date as YYYY-MM-DD.`, answer: 'UNKNOWN (no such meeting in the records)' },
  ];
}

// ─── Corpora ────────────────────────────────────────────────────────

export interface CorpusContext { id: QCorpus; pages: Array<{ path: string; content: string }>; owner: string; intro: string; today: string; source: string }

export function amaraContext(): CorpusContext {
  return { id: 'amara', pages: renderCorpus(), owner: 'Amara Okafor', intro: 'a partner at Halfway Capital', today: TODAY, source: 'amara-life-v1 (chronicle-lift.ts renderCorpus)' };
}
export function careerDevContext(seed: number): CorpusContext {
  const w = generateCareerDevWorld(seed);
  return { id: 'career', pages: w.docs, owner: 'Jordan Example', intro: 'an investor who keeps notes on the careers of founders and operators', today: CAREER_TODAY, source: `development career corpus seed ${seed} (${w.fingerprint.slice(0, 12)})` };
}

// ─── Ingest batches and prompts ─────────────────────────────────────

export function ingestBatches(pages: Array<{ path: string; content: string }>, maxChars: number): Array<Array<{ path: string; content: string }>> {
  const out: Array<Array<{ path: string; content: string }>> = [];
  let cur: Array<{ path: string; content: string }> = [];
  let size = 0;
  for (const p of pages) {
    if (cur.length && size + p.content.length > maxChars) { out.push(cur); cur = []; size = 0; }
    cur.push(p); size += p.content.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function ingestPrompt(batch: Array<{ path: string; content: string }>, index: number, total: number, owner = 'Amara Okafor'): string {
  return [
    `Batch ${index + 1} of ${total} of ${owner}'s documents follows. Read them and record what matters in ${owner}'s brain, following the brain-writing guidance, so that later questions about people, companies, how they are connected and when things happened can be answered from the brain alone. Earlier batches may already be in the brain; update existing pages instead of duplicating them.`,
    ...batch.map(p => `<document path="${p.path}">\n${p.content.trim()}\n</document>`),
    'When this batch is recorded, call submit_answer with `answer` set to DONE and the slugs you wrote in `sources`.',
  ].join('\n\n');
}

export function ingestSystem(arm: ToolsArm, c: Pick<CorpusContext, 'owner' | 'intro' | 'today'> = { owner: 'Amara Okafor', intro: 'a partner at Halfway Capital', today: TODAY }): string {
  return [`You are an AI assistant that maintains the personal knowledge base (brain) of ${c.owner}, ${c.intro}. Today is ${c.today}.`, arm.systemHint()].join('\n\n');
}

export function answerSystem(arm: ToolsArm, c: Pick<CorpusContext, 'owner' | 'intro' | 'today'> = { owner: 'Amara Okafor', intro: 'a partner at Halfway Capital', today: TODAY }): string {
  return [
    `You are an AI assistant working for ${c.owner}, ${c.intro}. Today is ${c.today}.`,
    `Answer from ${c.owner}'s brain, reached through the tools listed. Do not guess.`,
    arm.systemHint(),
    'When you are done, call submit_answer with the answer in `answer` (names, companies or a YYYY-MM-DD date as asked), the pages you relied on in `sources`, and any caveats in `notes`. If the brain does not contain the answer, answer UNKNOWN.',
  ].join('\n\n');
}

/** The immediate-answer cell's questions: a hash-selected quarter of the pairs (whole pairs). */
export function immediateQuestions(qs: readonly QaQuestion[], fraction = IMMEDIATE_FRACTION): QaQuestion[] {
  const pick = (pair: string) => parseInt(createHash('sha256').update(`q2-immediate-v1\u0000${pair}`).digest('hex').slice(0, 8), 16) / 2 ** 32 < fraction;
  return qs.filter(q => pick(q.pair));
}

// ─── Records ────────────────────────────────────────────────────────

interface IngestRecord {
  key: string; corpus: string; model: string; arm: string; ingest: number; batch: number; pages: string[]; tar: string;
  run: Omit<AgentRun, 'tools'> & { tool_calls: Array<{ name: string; ms: number; chars: number; error?: string }> };
  sweep_ms: number | null; budget_run_id: string | null; finished_at: string;
}
export interface AnswerResult { answer: string; agent_usd: number; stop: string; turns: number }

/**
 * The snapshot a checkpointed batch names, or a refusal that says what to do: a missing snapshot means the brain cannot
 * be restored, and re-ingesting is paid work the custodian must choose.
 */
export function snapshotOrRefuse(rec: { key: string; tar: string; batch: number }, ingestLog: string): string {
  if (existsSync(rec.tar)) return rec.tar;
  throw new Error(`ingest checkpoint ${rec.key} names snapshot ${rec.tar}, which is missing, so that brain cannot be restored. Nothing was run. Restore the file from the work root's backup and rerun; or, to re-ingest from batch ${rec.batch + 1} (paid), remove that brain's lines from batch ${rec.batch + 1} on in ${ingestLog} and rerun the same command.`);
}

const strip = (r: AgentRun) => { const { tools, ...rest } = r; return { ...rest, tool_calls: tools.map(t => ({ name: t.name, ms: t.ms, chars: t.chars, ...(t.error ? { error: t.error } : {}) })) }; };

function scriptedIngest(batch: Array<{ path: string; content: string }>): ScriptedModel {
  return history => history.length < batch.length
    ? { name: 'put_page', args: { slug: `sources/${batch[history.length].path.replace(/\.md$/, '').replace(/[^a-z0-9/]+/gi, '-').toLowerCase()}`, content: `---\ntype: note\ntitle: ${JSON.stringify(batch[history.length].path)}\n---\n\n${batch[history.length].content.replace(/^---[\s\S]*?\n---\n/, '')}` } }
    : { name: 'submit_answer', args: { answer: 'DONE', sources: [] } };
}
const scriptedAnswer = (q: QaQuestion): ScriptedModel => history => history.length === 0
  ? { name: 'search', args: { query: q.question.replace(/[^A-Za-z0-9 ]+/g, ' ').slice(0, 120) } }
  : { name: 'submit_answer', args: { answer: 'UNKNOWN', sources: [] } };

/** One row per planned (model, ingest, question): the answer, its judgment and the audit, if any. */
export function answerRows(o: { corpus: QCorpus; arm: string; models: readonly string[]; ingests: readonly number[]; questions: readonly QaQuestion[]; answers: AttemptCheckpoint<AnswerResult>; judgments: AttemptCheckpoint<WtaVerdict>; judge: string; auditJudge: string; redact: boolean }): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const model of o.models) for (const ingest of o.ingests) for (const q of o.questions) {
    const u: UnitIdentity = { corpus: o.corpus, ingest, model, arm: o.arm, question: q.id };
    const a = o.answers.get(answerKey(u));
    const j = o.judgments.get(judgeKey(u, o.judge));
    const au = o.judgments.get(judgeKey(u, o.auditJudge));
    rows.push({
      id: `${o.corpus}|${model}|i${ingest}|${q.id}`, cluster: `${o.corpus}|${q.pair}`, corpus: o.corpus, model, arm: o.arm, ingest, pair: q.pair, question_id: q.id, type: q.type, answerable: q.answerable,
      ...(o.redact ? {} : { question: q.question, reference: q.answer, answer: a?.result?.answer ?? null }),
      answer_state: a?.state ?? 'not_started', judge_state: j?.state ?? 'not_started',
      correct: j?.state === 'done' ? j.result!.correct : null, false_answer: j?.state === 'done' ? j.result!.false_answer : null,
      ...(au ? { audit_state: au.state, audit_correct: au.state === 'done' ? au.result!.correct : null } : {}),
      agent_usd: a?.result?.agent_usd ?? 0, judge_usd: (j?.usd ?? 0) + (au?.usd ?? 0), stop: a?.result?.stop ?? null, turns: a?.result?.turns ?? null,
    });
  }
  return rows;
}

export function summarizeArm(rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  const block = (xs: ReadonlyArray<Record<string, unknown>>) => {
    const scored = xs.filter(r => typeof r.correct === 'number');
    const correct = scored.reduce((a, r) => a + (r.correct as number), 0);
    const unans = scored.filter(r => r.answerable === false);
    const usd = xs.reduce((a, r) => a + (r.agent_usd as number) + (r.judge_usd as number), 0);
    return { answers: xs.length, judged: scored.length, accuracy: scored.length ? correct / scored.length : null, unanswerable_false_answer_rate: unans.length ? unans.reduce((a, r) => a + (r.false_answer as number), 0) / unans.length : null,
      usd, usd_per_question: xs.length ? usd / xs.length : null, usd_per_correct: correct ? usd / correct : null };
  };
  const audited = rows.filter(r => typeof r.audit_correct === 'number' && typeof r.correct === 'number');
  const models = [...new Set(rows.map(r => String(r.model)))].sort();
  return {
    ...block(rows), per_model: Object.fromEntries(models.map(m => [m, block(rows.filter(r => r.model === m))])),
    relational: block(rows.filter(r => r.type === 'relational')), temporal: block(rows.filter(r => r.type === 'temporal')),
    audit: { audited: audited.length, agreement: audited.length ? audited.filter(r => r.audit_correct === r.correct).length / audited.length : null },
  };
}

// ─── Run ────────────────────────────────────────────────────────────

interface RunOptions {
  argv: string[]; gut: GbrainUnderTest; corpus: CorpusContext; questions: QaQuestion[]; models: string[]; skippedModels: string[]; ingests: number; arm: string; guidance: { text: string; sha256: string; words: number; path: string };
  config: Record<string, string>; judge: string; auditJudge: string; auditFraction: number; phase: string; output: string; work: string; scripted: boolean; concurrency: number;
  batches: Array<Array<{ path: string; content: string }>>; ingestMaxTurns: number; answerMaxTurns: number; custody: { set: string; sha256: string } | null; log: (s: string) => void;
}

const brainDir = (o: RunOptions, model: string, ingest: number, commit: string) => join(o.work, `brain-${o.corpus.id}-${model}-${ingest === IMMEDIATE_INGEST ? 'immediate' : `i${ingest}`}-${commit.slice(0, 12)}-${sha256(JSON.stringify(o.config) + o.guidance.sha256).slice(0, 8)}`);
const grammarFile = (work: string, corpus: string, model: string, ingest: number, kind: 'grammar' | 'list' | 'summary') => join(work, 'grammar-lines', `${corpus}-${model}-i${ingest}.${kind}.jsonl`);

async function runArm(o: RunOptions): Promise<void> {
  const { log } = o;
  const commit = o.gut.overlay?.build.commit ?? `pin-${o.gut.version}`;
  const ingestIdx = Array.from({ length: o.ingests }, (_, i) => i);
  const ingest = new Checkpoint<IngestRecord>(join(o.work, 'ingest.jsonl'));
  const answers = new AttemptCheckpoint<AnswerResult>(join(o.work, 'answers.jsonl'));
  const judgments = new AttemptCheckpoint<WtaVerdict>(join(o.work, 'judgments.jsonl'));
  const phases = o.phase === 'all' ? ['ingest', 'answer', 'judge'] : [o.phase];
  const imm = immediateQuestions(o.questions);
  const ikey = (model: string, n: number, b: number) => `${o.corpus.id}|${model}|${o.arm}|ingest${n}|b${b}`;
  const unitsFor = (n: number, qs: readonly QaQuestion[]) => o.models.flatMap(model => qs.map(q => ({ model, ingest: n, q, u: { corpus: o.corpus.id, ingest: n, model, arm: o.arm, question: q.id } as UnitIdentity })));
  const allUnits = [...ingestIdx.flatMap(n => unitsFor(n, o.questions)), ...(phases.includes('immediate') ? unitsFor(IMMEDIATE_INGEST, imm) : [])];
  const remaining = () => ({
    'ingest batches': [...o.models.flatMap(m => ingestIdx.flatMap(n => o.batches.map((_, b) => ikey(m, n, b))))].filter(k => !ingest.has(k)).length,
    answers: answers.todo(allUnits.map(x => answerKey(x.u))).length,
    judgments: judgments.todo(allUnits.map(x => judgeKey(x.u, o.judge))).length,
    'audit judgments': judgments.todo(allUnits.filter(x => inAudit(answerKey(x.u), o.auditFraction)).map(x => judgeKey(x.u, o.auditJudge))).length,
  });
  const ingestUsd = () => ingest.values().reduce((a, r) => a + r.run.usd, 0);
  const spent = () => ingestUsd() + answers.spendUsd() + judgments.spendUsd();
  const opening = o.custody ? { id: JSON.parse(readFileSync(join(o.work, 'opening.json'), 'utf8')).opening_id as string, set: o.custody.set } : null;
  const report = (reason: string) => process.stderr.write('\n' + interruptionReport({ command: resumeCommand('eval/runner/write-then-answer.ts', o.argv), remaining: remaining(), spentUsd: spent(), opening, reason }) + '\n');
  const onSigint = () => { report('SIGINT (Ctrl-C)'); process.exit(130); };
  process.on('SIGINT', onSigint);

  const r0 = remaining();
  const needPaid = !o.scripted && ((phases.includes('ingest') && r0['ingest batches']) || (phases.includes('answer') && r0.answers) || (phases.includes('judge') && (r0.judgments || r0['audit judgments'])) || phases.includes('immediate'));
  const estimate = Number(flagValue(o.argv, '--estimate-usd') ?? (r0['ingest batches'] * 0.8 + r0.answers * 0.12 + (r0.judgments + r0['audit judgments']) * 0.01).toFixed(2));
  const campaign = campaignGuard(o.argv, { estimateUsd: needPaid ? estimate : 0 });
  log(`gbrain ${o.gut.version} ${commit.slice(0, 12)} arm ${o.arm} corpus ${o.corpus.id}; ${o.models.length} models x ${o.ingests} ingests x ${o.batches.length} batches; ${o.questions.length} questions; remaining ${JSON.stringify(r0)}`);
  const paid: PaidSession | null = needPaid ? openPaid(o.argv, CATEGORY, estimate, join(o.work, 'budget-run.json'), log) : null;
  const exhausted = () => !!paid?.guard.exhausted;
  const startedAt = new Date().toISOString();
  let harnessError: string | null = null;
  let summary: RunSummary | null = null;
  const graphs: Record<string, unknown> = {};
  const immediate: Record<string, unknown> = {};
  const httpJourney: Record<string, unknown> = {};

  const doIngest = async (model: string, n: number, sweep: boolean): Promise<AgentBrain> => {
    const brain = new AgentBrain(o.gut.root, brainDir(o, model, n, commit));
    if (!sweep) brain.run.env.GBRAIN_SWEEP = '0';
    const done = o.batches.map((_, b) => ingest.done.get(ikey(model, n, b)));
    const last = done.reduce((k, r, i) => (r ? i : k), -1);
    if (done.slice(0, last + 1).some(r => !r)) throw new Error(`${model} ingest ${n}: ingest checkpoints are not a prefix of the batch plan`);
    if (last >= 0) await brain.restoreFrom(snapshotOrRefuse(done[last]!, ingest.path));
    else await brain.create(o.config);
    for (let b = last + 1; b < o.batches.length; b++) {
      if (exhausted()) throw new Error('budget exhausted');
      await brain.start();
      const arm = new ToolsArm('gbrain', brain, o.guidance.text, o.corpus.owner);
      let run: AgentRun;
      try { run = await runAgent({ model, system: ingestSystem(arm, o.corpus), user: ingestPrompt(o.batches[b], b, o.batches.length, o.corpus.owner), arm, maxTurns: o.ingestMaxTurns, maxToolChars: null, scripted: o.scripted ? scriptedIngest(o.batches[b]) : undefined }); }
      finally { await brain.stop(); }
      if (run.stop === 'error') throw new Error(`${model} ingest ${n} batch ${b + 1}: ${run.error}`);
      const sw = sweep ? await brain.sweep() : null;
      const tar = `${brain.dir}.b${String(b).padStart(2, '0')}.tar`;
      brain.snapshot(tar);
      ingest.append({ key: ikey(model, n, b), corpus: o.corpus.id, model, arm: o.arm, ingest: n, batch: b, pages: o.batches[b].map(p => p.path), tar, run: strip(run), sweep_ms: sw?.ms ?? null, budget_run_id: paid?.runId ?? null, finished_at: new Date().toISOString() });
      log(`${model} ingest ${n === IMMEDIATE_INGEST ? 'immediate' : n} batch ${b + 1}/${o.batches.length}: ${run.stop}, ${run.turns} turns, ${run.tools.length} tool calls, $${run.usd.toFixed(3)}`);
    }
    return brain;
  };

  const doAnswers = async (brain: AgentBrain, model: string, n: number, qs: readonly QaQuestion[]) => {
    const todo = qs.filter(q => answers.todo([answerKey({ corpus: o.corpus.id, ingest: n, model, arm: o.arm, question: q.id })]).length);
    if (!todo.length) return;
    await brain.start();
    try {
      const arm = new ToolsArm('gbrain', brain, '', o.corpus.owner, P5_ANSWER_TOOLS);
      await runPool(todo, o.concurrency, async q => {
        if (exhausted()) throw Object.assign(new Error('budget exhausted'), { name: 'BudgetExceededError' });
        const u: UnitIdentity = { corpus: o.corpus.id, ingest: n, model, arm: o.arm, question: q.id };
        const run = await runAgent({ model, system: answerSystem(arm, o.corpus), user: q.question, arm, maxTurns: o.answerMaxTurns, maxToolChars: null, scripted: o.scripted ? scriptedAnswer(q) : undefined });
        const answer = [run.final?.answer ?? '', run.final?.notes ? `(notes: ${run.final.notes})` : ''].filter(Boolean).join(' ') || run.text || '';
        if (run.stop === 'error') answers.record(answerKey(u), { ...u }, { state: failureClass(new Error(run.error ?? '')), error: run.error ?? 'agent error', usd: run.usd });
        else answers.record(answerKey(u), { ...u }, { state: 'done', result: { answer, agent_usd: run.usd, stop: run.stop, turns: run.turns }, usd: run.usd });
      });
    } finally { await brain.stop(); }
  };

  const judgeChat = (model: string, system: string, user: string): Promise<ChatOut> => chatText(model, system, user, { maxTokens: 600 });
  const doJudge = async (units: Array<{ u: UnitIdentity; q: QaQuestion }>, judge: string) => {
    const todo = units.filter(x => answers.done(answerKey(x.u)) && judgments.todo([judgeKey(x.u, judge)]).length);
    await runPool(todo, Math.max(4, o.concurrency), async ({ u, q }) => {
      if (exhausted()) throw Object.assign(new Error('budget exhausted'), { name: 'BudgetExceededError' });
      const response = answers.get(answerKey(u))!.result!.answer;
      if (o.scripted) { judgments.record(judgeKey(u, judge), { ...u, judge }, { state: 'done', result: { correct: q.answerable ? 0 : /\bUNKNOWN\b/i.test(response) ? 1 : 0, false_answer: 0 }, usd: 0 }); return; }
      let spentHere = 0;
      const r = await withAttempts(async () => { const out = await judgeChat(judge, WTA_JUDGE_SYSTEM, wtaJudgePrompt(q, response)); spentHere += out.usd; return parseWtaVerdict(firstJsonObject(out.text)); }, { maxAttempts: 3, isValid: v => v !== null });
      judgments.record(judgeKey(u, judge), { ...u, judge }, { state: r.state, ...(r.state === 'done' ? { result: r.result! } : {}), error: r.error, usd: spentHere, attempts: r.attempts });
    });
  };

  try {
    for (const model of o.models) {
      for (const n of ingestIdx) {
        const complete = () => o.batches.every((_, b) => ingest.has(ikey(model, n, b)));
        let brain: AgentBrain | null = null;
        if (phases.includes('ingest')) {
          brain = await doIngest(model, n, true);
          const pages = brain.readPages();
          const edges = brain.readEdges();
          const parse = await withHermeticEnv(CATEGORY, () => buildParser(o.gut, { ...o.config, 'line_grammar.enabled': 'true' }));
          const x = extractGrammarLines({ corpus: o.corpus.id, model, arm: o.arm, ingest: n }, pages.map(p => ({ slug: p.slug, body: p.body })), parse as never);
          mkdirSync(join(o.work, 'grammar-lines'), { recursive: true });
          writeFileSync(grammarFile(o.work, o.corpus.id, model, n, 'grammar'), x.grammar.map(l => JSON.stringify(l)).join('\n') + (x.grammar.length ? '\n' : ''));
          writeFileSync(grammarFile(o.work, o.corpus.id, model, n, 'list'), x.list.map(l => JSON.stringify(l)).join('\n') + (x.list.length ? '\n' : ''));
          writeFileSync(grammarFile(o.work, o.corpus.id, model, n, 'summary'), JSON.stringify(x.summary) + '\n');
          graphs[`${model}|i${n}`] = { pages: pages.length, edges: edges.length, edges_by_type: edges.reduce((a, e) => ({ ...a, [e.type || 'untyped']: (a[e.type || 'untyped'] ?? 0) + 1 }), {} as Record<string, number>), grammar: { ...x.summary, corpus: undefined, model: undefined, arm: undefined, ingest: undefined } };
        }
        if (phases.includes('answer')) {
          if (!complete()) throw new Error(`${model} ingest ${n}: ingest is not complete (${o.batches.filter((_, b) => ingest.has(ikey(model, n, b))).length}/${o.batches.length} batches); run --phase ingest first`);
          if (!brain) { brain = new AgentBrain(o.gut.root, brainDir(o, model, n, commit)); await brain.restoreFrom(snapshotOrRefuse(ingest.done.get(ikey(model, n, o.batches.length - 1))!, ingest.path)); }
          await doAnswers(brain, model, n, o.questions);
        }
      }
    }
    if (phases.includes('judge')) {
      const units = ingestIdx.flatMap(n => unitsFor(n, o.questions));
      await doJudge(units, o.judge);
      await doJudge(units.filter(x => inAudit(answerKey(x.u), o.auditFraction)), o.auditJudge);
    }
    if (phases.includes('immediate')) {
      for (const model of o.models) {
        const brain = await doIngest(model, IMMEDIATE_INGEST, false);
        const before = brain.extractionState();
        await doAnswers(brain, model, IMMEDIATE_INGEST, imm);
        const after = brain.extractionState();
        immediate[model] = { questions: imm.length, extraction_before_answers: before, extraction_after_answers: after, serve_sweep: 'off (GBRAIN_SWEEP=0)', extract_between_batches: 'none' };
      }
      const units = unitsFor(IMMEDIATE_INGEST, imm);
      await doJudge(units, o.judge);
    }
    if (phases.includes('http-journey')) {
      const model = o.models[0];
      const last = ingest.done.get(ikey(model, 0, o.batches.length - 1));
      if (!last) throw new Error(`the HTTP-writer journey replays ${model} ingest 0; run --phase ingest first`);
      const brain = new AgentBrain(o.gut.root, brainDir(o, model, 0, commit));
      await brain.restoreFrom(snapshotOrRefuse(last, ingest.path));
      const pages = brain.readPages();
      const http = await openP5HttpBrain(o.gut, o.config);
      try {
        for (const p of pages) await http.put(p.slug, `---\ntype: ${p.type || 'note'}\ntitle: ${JSON.stringify(p.title)}\n---\n\n${p.body}`);
        const count = (es: Array<{ type: string }>) => es.reduce((a, e) => ({ ...a, [e.type || 'untyped']: (a[e.type || 'untyped'] ?? 0) + 1 }), {} as Record<string, number>);
        const beforeEdges = await http.edges();
        const sweep = await http.sweep();
        const afterEdges = await http.edges();
        Object.assign(httpJourney, { model, pages: pages.length, edges_before_sweep: beforeEdges.length, edges_by_type_before_sweep: count(beforeEdges), sweep, edges_after_sweep: afterEdges.length, edges_by_type_after_sweep: count(afterEdges), config: http.configRecord });
      } finally { await http.close(); }
    }
  } catch (e) {
    harnessError = e instanceof Error ? e.message : String(e);
    report(harnessError);
  } finally {
    process.off('SIGINT', onSigint);
    if (paid) summary = closePaid(paid, !harnessError);
  }

  const rows = answerRows({ corpus: o.corpus.id, arm: o.arm, models: o.models, ingests: ingestIdx, questions: o.questions, answers, judgments, judge: o.judge, auditJudge: o.auditJudge, redact: !!o.custody });
  // Skipped models keep the rows they already have, flagged and outside the accounting and summaries.
  const skippedRows = o.skippedModels.length ? answerRows({ corpus: o.corpus.id, arm: o.arm, models: o.skippedModels, ingests: ingestIdx, questions: o.questions, answers, judgments, judge: o.judge, auditJudge: o.auditJudge, redact: !!o.custody })
    .filter(r => r.answer_state !== 'not_started').map(r => ({ ...r, skipped_model: 1 }) as Record<string, unknown>) : [];
  const immRows = phases.includes('immediate') ? answerRows({ corpus: o.corpus.id, arm: o.arm, models: o.models, ingests: [IMMEDIATE_INGEST], questions: imm, answers, judgments, judge: o.judge, auditJudge: o.auditJudge, redact: !!o.custody }) : [];
  const planned = rows.length;
  const attempted = rows.filter(r => r.answer_state !== 'not_started').length;
  const terminal = rows.filter(r => r.answer_state === 'terminal' || r.judge_state === 'terminal').length;
  const scored = rows.filter(r => typeof r.correct === 'number').length;
  const wantsJudged = phases.includes('judge');
  const incomplete = wantsJudged ? planned - scored - terminal : 0;
  const receipt = p5Receipt({
    category: CATEGORY, gut: o.gut, startedAt, rows: [...rows, ...immRows.map(r => ({ ...r, cell: 'immediate' })), ...skippedRows],
    harnessError: harnessError ?? (incomplete > 0 ? `${incomplete} of ${planned} answers lack a judgment; rerun the same command to resume` : null),
    accounting: { planned, attempted, scored, errors: terminal },
    summary: {
      arm: o.arm, corpus: o.corpus.id, ...summarizeArm(rows), graphs,
      ...(o.skippedModels.length ? { skipped_models: Object.fromEntries(o.skippedModels.map(m => { const xs = skippedRows.filter(r => r.model === m); return [m, { rows_kept: xs.length, judged: xs.filter(r => typeof r.correct === 'number').length }]; })) } : {}),
      ...(phases.includes('immediate') ? { immediate_cell: { ...immediate, answers: summarizeArm(immRows) } } : {}),
      ...(phases.includes('http-journey') ? { http_writer_journey: httpJourney } : {}),
      ingest: Object.fromEntries(o.models.map(m => { const rs = ingest.values().filter(r => r.model === m && r.ingest >= 0); return [m, { batches: rs.length, batches_planned: o.batches.length * o.ingests, usd: rs.reduce((s, r) => s + r.run.usd, 0) }]; })),
      spend_usd: { ingest: ingestUsd(), answers: answers.spendUsd(), judgments: judgments.spendUsd(), total: spent() },
    },
    basis: o.scripted ? 'scripted agent: no model and no paid request' : 'agent and judge calls through the paid-request guard; gbrain runs keyless (no provider key, no gbrain model calls)',
    resolvedConfig: {
      version: VERSION, arm: o.arm, corpus: { id: o.corpus.id, source: o.corpus.source, digest: o.custody ? `custody (${o.custody.sha256})` : corpusDigest(o.corpus.pages), pages: o.corpus.pages.length, batches: o.batches.length },
      models: o.models, ...(o.skippedModels.length ? { skipped_models: o.skippedModels } : {}), ingests: o.ingests, judge: o.judge, rubric: WTA_RUBRIC_VERSION, rubric_sha256: WTA_RUBRIC_SHA256, audit: { judge: o.auditJudge, fraction: o.auditFraction, selection: 'sha256(q2-wta-audit-v1, answer key) < fraction' },
      scripted: o.scripted, phase: o.phase, pair_key: 'question pair, shared across models; cluster = corpus|pair',
      guidance: { path: relative(REPO, o.guidance.path), sha256: o.guidance.sha256, words: o.guidance.words },
      questions: o.custody ? `sealed set ${o.custody.set} (custody file sha256 ${o.custody.sha256}), ${o.questions.length} questions` : `development: ${o.questions.length} questions`,
      immediate_cell: { fraction: IMMEDIATE_FRACTION, selection: 'sha256(q2-immediate-v1, pair) < fraction', ingests_per_model: 1, serve_sweep: 'GBRAIN_SWEEP=0', extract_between_batches: false },
      ingest: { max_turns: o.ingestMaxTurns, tools: 'P5_AGENT_TOOLS', after_each_batch: 'server stopped, gbrain extract --stale, snapshot' },
      answer: { max_turns: o.answerMaxTurns, tools: 'P5_ANSWER_TOOLS (read-only)', concurrency: o.concurrency },
      transport: 'gbrain serve --surface full over stdio (remote caller); PGLite, gbrain init --no-embedding (keyword search); no tool-result cap',
      eval_config: { channel: 'GBRAIN_EVAL_CONFIG', requested: o.config },
      budget_run_id: paid?.runId ?? null,
    },
  });
  if (summary) receipt.cost = receiptCost(summary);
  writeReceipt(join(o.output, 'receipt.json'), receipt);
  campaign?.finish(join(o.output, 'receipt.json'), summary ? receiptCost(summary).usd : 0);
  log(`receipt: ${join(o.output, 'receipt.json')}`);
  if (receipt.run_status === 'error') { process.exitCode = 3; return; }
  process.stdout.write(JSON.stringify({ arm: o.arm, corpus: o.corpus.id, ...summarizeArm(rows) }, null, 2) + '\n');
}

// ─── compare and adoption ───────────────────────────────────────────

/** Answer rows of a receipt as crossed-bootstrap input (immediate-cell rows excluded). */
export function rowsFromReceipt(path: string): AnswerRow[] {
  const r = JSON.parse(readFileSync(path, 'utf8')) as { data: { rows: Array<Record<string, unknown>> } };
  return r.data.rows.filter(x => x.cell !== 'immediate').map(x => ({ corpus: String(x.corpus), model: String(x.model), arm: x.arm as 'A' | 'B', ingest: Number(x.ingest), pair: String(x.pair), question: String(x.question_id),
    type: x.type as 'relational' | 'temporal', answerable: x.answerable !== false, correct: typeof x.correct === 'number' ? x.correct : null, false_answer: typeof x.false_answer === 'number' ? x.false_answer : null }));
}

/** Drop the rows of the named models (compare and power-sim `--exclude-models`). */
export function excludeModels<T extends { model: string }>(rows: readonly T[], models: readonly string[]): T[] {
  return rows.filter(r => !models.includes(r.model));
}

async function cmdCompare(argv: string[]): Promise<void> {
  const campaign = campaignGuard(argv);
  const output = campaign?.output ?? flagValue(argv, '--output');
  const a = (flagValue(argv, '--a') ?? '').split(',').filter(Boolean), b = (flagValue(argv, '--b') ?? '').split(',').filter(Boolean);
  if (!output || !a.length || !b.length) throw new Error('usage: write-then-answer.ts compare --a <arm A receipts, comma-separated> --b <arm B receipts> --output <dir>');
  const excluded = (flagValue(argv, '--exclude-models') ?? '').split(',').filter(Boolean);
  const rows = excludeModels([...a, ...b].flatMap(rowsFromReceipt), excluded);
  for (const r of rows) if ((a.length && r.arm !== 'A' && r.arm !== 'B')) throw new Error('receipt rows must carry arm A or B (pass --arm-label A or B when running)');
  const seed = Number(flagValue(argv, '--seed') ?? 20261006), draws = Number(flagValue(argv, '--draws') ?? 10_000);
  const g = g6Gates(rows, { seed, draws });
  const receipt = p5Receipt({ category: 'q2-g6', gut: resolveGbrainUnderTest(null), startedAt: new Date().toISOString(), rows: [], harnessError: null, gates: g.gates,
    summary: { estimates: g.estimates, answers: rows.length, by_cell: Object.fromEntries([...new Set(rows.map(r => `${r.corpus}|${r.model}|${r.arm}`))].sort().map(k => [k, { ingests: new Set(rows.filter(r => `${r.corpus}|${r.model}|${r.arm}` === k).map(r => r.ingest)).size }])) },
    basis: 'decision only: receipts in, no model call', resolvedConfig: { seed, draws, excluded_models: excluded, inference: 'crossed bootstrap: question pairs within corpus strata (shared across models and arms) x ingest brains within corpus x model x arm', inputs: { a, b } } });
  writeReceipt(join(output, 'receipt.json'), receipt);
  campaign?.finish(join(output, 'receipt.json'), 0);
  for (const x of g.gates) process.stderr.write(`${x.gate}: ${x.outcome}${x.failed_threshold ? ` (${x.failed_threshold})` : ''}\n`);
}

/** Adoption recall over labeled list lines: both judges say "yes, meant as a typed relation line"; the share minted as relation lines. */
export function adoptionRecall(lines: readonly ListLineRecord[], outcome: (id: string) => 'yes' | 'no' | 'unlabeled'): Record<string, unknown> {
  const per = (xs: readonly ListLineRecord[]) => {
    const meant = xs.filter(l => outcome(l.id) === 'yes');
    const minted = meant.filter(l => l.minted === 'relation');
    const misses: Record<string, number> = {};
    for (const l of meant.filter(x => x.minted !== 'relation')) for (const r of l.reasons.length ? l.reasons : ['no_diagnostic']) misses[r] = (misses[r] ?? 0) + 1;
    return { labeled: xs.filter(l => outcome(l.id) !== 'unlabeled').length, meant_as_relation_lines: meant.length, minted: minted.length, adoption_recall: meant.length ? minted.length / meant.length : null, misses_by_reason: misses };
  };
  const models = [...new Set(lines.map(l => l.model))].sort();
  return { ...per(lines), per_model: Object.fromEntries(models.map(m => [m, per(lines.filter(l => l.model === m))])) };
}

async function cmdAdoption(argv: string[], log: (s: string) => void): Promise<void> {
  const campaign = campaignGuard(argv);
  const roots = assertCustodyRoots({ output: campaign?.output ?? flagValue(argv, '--output'), work: flagValue(argv, '--work'), needsWork: true });
  const work = roots.work!;
  const dir = join(work, 'grammar-lines');
  const files = existsSync(dir) ? (await import('node:fs')).readdirSync(dir).filter(f => f.endsWith('.list.jsonl')).sort() : [];
  const lines = files.flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ListLineRecord)).filter(l => l.arm === 'B' && l.has_link);
  const judges = (flagValue(argv, '--judges') ?? Q2_LINE_JUDGES.join(',')).split(',');
  const ckpt = new AttemptCheckpoint<{ verdict: 'yes' | 'no' }>(join(work, 'adoption-labels.jsonl'));
  const todo = lines.flatMap(l => judges.map(j => ({ l, j }))).filter(x => ckpt.todo([`${x.l.id}|${x.j}`]).length);
  log(`adoption: ${lines.length} arm-B list lines with a link from ${files.length} brain(s); ${todo.length} (line, judge) labels to do`);
  let paid: PaidSession | null = null; let summary: RunSummary | null = null; let err: string | null = null;
  if (todo.length) {
    paid = openPaid(argv, `${CATEGORY}-adoption`, Number(flagValue(argv, '--estimate-usd') ?? (todo.length * 0.02).toFixed(2)), join(work, 'adoption-budget-run.json'), log);
    try {
      await runPool(todo, 6, async ({ l, j }) => {
        if (paid?.guard.exhausted) throw Object.assign(new Error('budget exhausted'), { name: 'BudgetExceededError' });
        let usd = 0;
        const r = await withAttempts(async () => { const out = await chatText(j, ADOPTION_SYSTEM, adoptionPrompt(l), { maxTokens: 300 }); usd += out.usd; return String(firstJsonObject(out.text)?.verdict ?? '').toLowerCase(); }, { maxAttempts: 3, isValid: v => v === 'yes' || v === 'no' });
        ckpt.record(`${l.id}|${j}`, { line: l.id, judge: j }, { state: r.state, ...(r.state === 'done' ? { result: { verdict: r.result as 'yes' | 'no' } } : {}), error: r.error, usd, attempts: r.attempts });
      });
    } catch (e) { err = (e as Error).message; } finally { summary = closePaid(paid, !err); }
  }
  const outcome = (id: string): 'yes' | 'no' | 'unlabeled' => {
    const rs = judges.map(j => ckpt.get(`${id}|${j}`));
    if (rs.every(r => r?.state === 'done' && r.result?.verdict === 'yes')) return 'yes';
    if (rs.some(r => r?.state === 'terminal' || (r?.state === 'done' && r.result?.verdict === 'no'))) return 'no';
    return 'unlabeled';
  };
  const res = adoptionRecall(lines, outcome);
  const unlabeled = lines.filter(l => outcome(l.id) === 'unlabeled').length;
  const receipt = p5Receipt({ category: `${CATEGORY}-adoption`, gut: resolveGbrainUnderTest(null), startedAt: new Date().toISOString(), rows: [], harnessError: err ?? (unlabeled ? `${unlabeled} line(s) lack labels; rerun the same command` : null),
    accounting: { planned: lines.length, attempted: lines.length - unlabeled, scored: lines.length - unlabeled, errors: 0 }, summary: { ...res, spend_usd: ckpt.spendUsd() },
    basis: 'judge calls through the paid-request guard', resolvedConfig: { judges, prompt: ADOPTION_PROMPT_VERSION, pool: 'arm-B list lines holding a link', reported_not_gated: true } });
  if (summary) receipt.cost = receiptCost(summary);
  writeReceipt(join(roots.output, 'receipt.json'), receipt);
  campaign?.finish(join(roots.output, 'receipt.json'), summary ? receiptCost(summary).usd : 0);
  log(`adoption recall ${JSON.stringify((res as { adoption_recall: number | null }).adoption_recall)}; receipt ${join(roots.output, 'receipt.json')}`);
}

/**
 * The experiment's model list and the models this invocation runs. Without --models a resume takes the list recorded
 * in experiment.json (so a changed default never changes a recorded experiment); a fresh work root takes the default.
 * --skip-models must name recorded models and leave at least one.
 */
export function resolveModels(o: { modelsFlag: string | undefined; skipModels: readonly string[]; recorded: { models?: string[] } | null }): { models: string[]; active: string[] } {
  const models = o.modelsFlag ? o.modelsFlag.split(',').filter(Boolean) : o.recorded?.models ?? [...DEFAULT_MODELS];
  const unknown = o.skipModels.filter(m => !models.includes(m));
  if (unknown.length) throw new Error(`--skip-models names ${unknown.join(', ')}, which the experiment (${models.join(', ')}) does not include; skip only recorded models`);
  if (o.skipModels.length && !o.recorded) throw new Error('--skip-models resumes an existing work root; this --work has no experiment.json. For a new experiment, pass --models without the model instead');
  const active = models.filter(m => !o.skipModels.includes(m));
  if (!active.length) throw new Error('--skip-models leaves no model to run; drop a model from the list');
  return { models, active };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const log = (s: string) => process.stderr.write(`[wta] ${s}\n`);
  if (argv[0] === 'compare') return cmdCompare(argv.slice(1));
  if (argv[0] === 'adoption') return cmdAdoption(argv.slice(1), log);
  const corpusId = (flagValue(argv, '--corpus') ?? 'amara') as QCorpus;
  if (corpusId !== 'amara' && corpusId !== 'career') throw new Error('--corpus must be amara or career');
  const questionsFile = flagValue(argv, '--questions-file');
  const careerDir = flagValue(argv, '--career-dir');
  const custodian = !!questionsFile;
  if (careerDir && !custodian) throw new Error('--career-dir is custody material; pass it with --questions-file, --decision-id and --purpose');
  const devSeed = Number(flagValue(argv, '--dev-seed') ?? 1);
  if (!custodian && !DEV_SEEDS.includes(devSeed)) throw new Error(`development runs use dev seeds ${DEV_SEEDS.join(', ')}`);
  const decisionId = flagValue(argv, '--decision-id'), purpose = flagValue(argv, '--purpose');
  if (custodian && (!decisionId || !purpose)) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log before any custody file is read');
  const campaignOutput = flagValue(argv, '--campaign') ? join(resolve(flagValue(argv, '--campaign')!), flagValue(argv, '--step') ?? '', flagValue(argv, '--run') ?? '') : null;
  const roots = custodian ? assertCustodyRoots({ output: campaignOutput ?? flagValue(argv, '--output'), work: flagValue(argv, '--work'), needsWork: true }) : null;
  const armLabel = flagValue(argv, '--arm-label') ?? 'unlabeled';

  let corpus: CorpusContext;
  let allQuestions: QaQuestion[];
  let custody: { set: string; sha256: string } | null = null;
  if (custodian) {
    const q = loadQuestionsFile(questionsFile!, { decisionId: decisionId!, purpose: purpose! });
    allQuestions = q.questions.filter(x => x.corpus === corpusId);
    if (corpusId === 'career') {
      if (!careerDir) throw new Error('--corpus career in custodian mode needs --career-dir <custody career-corpus dir>');
      const c = loadCareerCorpus(careerDir, { decisionId: decisionId!, purpose: purpose! });
      corpus = { id: 'career', pages: c.docs, owner: c.owner ?? 'the user', intro: 'who keeps notes on the careers of founders and operators', today: c.today ?? TODAY, source: `custody career corpus (manifest sha256 ${c.manifest_sha256})` };
      custody = { set: `${q.set_id}/career`, sha256: `${q.sha256}+${c.manifest_sha256}` };
    } else { corpus = amaraContext(); custody = { set: `${q.set_id}/amara`, sha256: q.sha256 }; }
  } else {
    corpus = corpusId === 'amara' ? amaraContext() : careerDevContext(devSeed);
    allQuestions = corpusId === 'amara'
      ? [...devQuestions(devSeed, Number(flagValue(argv, '--dev-pairs') ?? 8), (flagValue(argv, '--dev-items') ?? 'calendar,meeting').split(',') as Array<'calendar' | 'meeting'>), ...devDecoyQuestions(devSeed)]
      : generateCareerDevWorld(devSeed).questions;
  }
  const questions = selectUnits(allQuestions, q => q.id, { pilot: argv.includes('--pilot'), limit: limitFlag(argv) });
  const skippedModels = (flagValue(argv, '--skip-models') ?? '').split(',').filter(Boolean);
  const ingests = Number(flagValue(argv, '--ingests') ?? DEFAULT_INGESTS);
  if (!Number.isInteger(ingests) || ingests < 1) throw new Error('--ingests must be a positive integer');
  const guidancePath = resolve(flagValue(argv, '--guidance') ?? join(REPO, 'eval/data/p5-write-then-answer/guidance-a.md'));
  const config = parseEvalConfig();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const commit = gut.overlay?.build.commit ?? `pin-${gut.version}`;
  const allBatches = ingestBatches(corpus.pages, Number(flagValue(argv, '--batch-chars') ?? 24_000));
  const batchLimit = flagValue(argv, '--ingest-batches');
  const batches = batchLimit ? allBatches.slice(0, Number(batchLimit)) : allBatches;
  const output = resolve(roots?.output ?? campaignOutput ?? flagValue(argv, '--output') ?? join(REPO, 'eval/reports', CATEGORY, `${corpusId}-${armLabel}-${commit.slice(0, 9)}`));
  const workFlag = roots?.work ?? flagValue(argv, '--work');
  if (!workFlag) throw new Error('pass --work <dir outside every git worktree>: brains, snapshots and checkpoints live there');
  const work = resolve(workFlag);
  if (!relative(REPO, work).startsWith('..')) throw new Error(`--work ${work} is inside this repository; gbrain init refuses a content directory inside another Git worktree`);
  mkdirSync(output, { recursive: true });
  mkdirSync(work, { recursive: true });
  const guidance = { ...readGuidance(guidancePath), path: guidancePath };
  const scripted = argv.includes('--scripted');
  const judge = flagValue(argv, '--judge') ?? G6_JUDGE;
  const auditJudge = flagValue(argv, '--audit-judge') ?? G6_AUDIT_JUDGE;
  const ingestMaxTurns = Number(flagValue(argv, '--ingest-max-turns') ?? 60);
  const answerMaxTurns = Number(flagValue(argv, '--answer-max-turns') ?? 16);
  const identityPath = join(work, 'experiment.json');
  const { models, active } = resolveModels({ modelsFlag: flagValue(argv, '--models'), skipModels: skippedModels, recorded: existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, 'utf8')) as { models?: string[] } : null });
  if (skippedModels.length) log(`skipping ${skippedModels.join(', ')}: no new ingest, answer or judgment for them; the recorded experiment (${models.join(', ')}) is unchanged`);
  const identity = { version: VERSION, build: commit, config, arm: armLabel, corpus: corpusId, corpus_digest: corpusDigest(corpus.pages), guidance_sha256: guidance.sha256, models, ingests, judge, audit_judge: auditJudge, scripted,
    batches: batches.map(b => b.map(p => p.path)), ingest_max_turns: ingestMaxTurns, answer_max_turns: answerMaxTurns, questions_sha256: sha256(JSON.stringify(allQuestions)) };
  if (existsSync(identityPath) && readFileSync(identityPath, 'utf8') !== JSON.stringify(identity, null, 2) + '\n') throw new Error(`${work} holds a different experiment (experiment.json differs); rerun the exact original command, or use a new --work`);
  writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n');
  if (custody) {
    const op = openOrContinue(work, custody.set, identity);
    log(op.continues ? `continuing opening ${op.opening_id} of ${custody.set}` : `opening ${op.opening_id} of ${custody.set} (one opening per work root)`);
  }
  await runArm({ argv, gut, corpus, questions, models: active, skippedModels, ingests, arm: armLabel, guidance, config, judge, auditJudge, auditFraction: Number(flagValue(argv, '--audit-fraction') ?? 0.1),
    phase: flagValue(argv, '--phase') ?? 'all', output, work, scripted, concurrency: Number(flagValue(argv, '--concurrency') ?? 4), batches, ingestMaxTurns, answerMaxTurns, custody, log });
}

export { crossedBootstrap };

if (import.meta.main) {
  main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });
}

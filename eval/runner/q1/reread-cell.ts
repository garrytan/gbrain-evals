/**
 * Re-read one packed arm of a Q1, F6 or RS1 cell with another reader (the particle-1 add-on, GBEV-31 / GST-1153; RS1's
 * particle-1 re-reads, GST-1886): every frozen context the source cell's readers read (`runs/<cell id>/contexts.ndjson`)
 * is sent byte for byte to the new reader, and each answer is judged with the cell's canonical instrument, plus, on an
 * arm with a per-reader frontier plan (RS1), the new reader's frontier judge. Nothing is retrieved or packed again.
 *
 *   bun eval/runner/q1/reread-cell.ts --cell <source cell id> --arm <arm id> --source <out>/runs/<cell id>... --reader particle:particle-1
 *     --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--manifest q1|f6|rs1] [--keyless-upstream <url>]
 *
 * Each arm and reader gets its own --out (verify.json, the lease usage log and the keyless/paid marker sit at its root),
 * and each invocation its own --run-id: a lease closes when the run ends and never reopens. `--ledger-cap-usd` is the
 * ceiling on every lease of --budget-ledger together (A6: $100); a lease that would take the ledger's committed spend
 * past it is refused before any request.
 *
 * `--source` takes one staging root per shard (or per lease that ran a shard): the `runs/<cell id>` directory of a
 * cell's output, beside its published `cells/` copy, as the launcher pulls it (ubi-runner `--pull` brings back the
 * whole remote output, and every checkpoint copies it too).
 *
 * Before any request (prepareReread): the custody gate a sealed cell needs (as runCell), then the byte-for-byte check
 * of every source. Each frozen context of the arm must hash to its prompt_sha256 and to its context_sha256 (render-v2:
 * sha256 of the pack identity, a NUL and the prompt), which ties the bytes to the answers that read them; the
 * published run-configs must agree in every field but REREAD_LAUNCH_FIELDS, and their schedule must be the one this
 * tree selects; the published answers must be the staged ones;
 * and each scheduled question must have one frozen context that every stored answer of the arm read (a question whose
 * retrieval failed has none and keeps that failure, as the source cell recorded it). verify.json in --out holds the counts and each contexts file's
 * sha256; any problem refuses the whole run, and stdout carries only counts and hashes.
 *
 * The reading (runReread) is a packed arm's (cell.ts readPrompt): the frozen prompt on the `harness` slot through the
 * in-process lease proxy, an OpenAI-compatible reader through `chatWithReceipts`, `readerMaxTokens(reader)`, the
 * cell's effort, replicate 0. A reading the provider may have billed is final and never sent again, a budget refusal
 * stops the run (`budget_not_run`, not a try), and a resume skips answered ids. Each answer is judged by the cell's
 * canonical judge (replicate 0) and, on an arm with a per-reader frontier plan, by the new reader's frontier judge
 * (definitions.ts frontierJudgeOf, under `<instrument>@<judge>`); no other frontier judge runs, and an OpenAI-compatible
 * judge is refused. Output:
 * `--out/cells/<arm cell id>.reread-<reader>/` with answers.ndjson and judgments.ndjson in Q1's record schemas, and
 * receipt.json. The proxy, cell token, placeholder keys and keyless/paid marker are calibration-cell.ts's.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BudgetRun, ledgerPaths, ledgerStatus } from '../budget-ledger.ts';
import type { FrozenContext } from '../memory-qa/arms.ts';
import { loadCorpus, readRs1Manifest, type Corpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { instrumentFor, type Instrument } from '../memory-qa/instruments.ts';
import { DEFAULT_MAX_ATTEMPTS, type Outcome } from '../memory-qa/outcomes.ts';
import { ChatClient, hasChatRoute, judgeAnswer, type ChatLike } from '../memory-qa/qa-v2.ts';
import { answerId, answerRecord, judgmentKey, readRecords, RecordLog, sha256, type AnswerRecord } from '../memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy, usageSplit } from '../metering-proxy.ts';
import { DEFAULT_ROUTE_CLASSES } from '../shootout-cell.ts';
import type { PackedContext } from '../systems/render-v2.ts';
import { claimOut, keylessUpstreamArg } from './calibration-cell.ts';
import { answerAppender, custodyGate, devOnly, findCell, gatherStaging, JUDGED, latestBy, metering, needsCustody, onSlot, readerMaxTokens, readPrompt, refuseCompatJudges, requiredJudges, scheduledQuestions,
  selectCellQuestions, type CellManifestId, type MeterLine, type StagedRetrieval } from './cell.ts';
import { frontierJudgesFor, policyKey, type ArmDefinition, type CellDefinition } from './cells/definitions.ts';
import { loadRS1Manifest } from './cells/rs1.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError } from './scoreboard-errors.ts';

export const REREAD_VERIFY_SCHEMA = 'gbrain-evals/q1-reread-verify/v1';
export const REREAD_RECEIPT_SCHEMA = 'gbrain-evals/q1-reread-receipt/v1';
const FRONT = ['bun', 'eval/runner/q1/reread-cell.ts'];

/** The re-read cell: the source arm's cell id and the reader, so no answer id meets one of the source cell's. */
export const rereadCellId = (armCellId: string, reader: string) => `${armCellId}.reread-${reader.replace(/[^a-z0-9.-]+/gi, '-')}`;

/** The arm a re-read reads: one whose readers read frozen packed contexts (packed or native-default). */
export function rereadArm(def: CellDefinition, armId: string): ArmDefinition {
  const arm = def.arms.find(a => a.id === armId);
  if (!arm || !(arm.mode === 'packed' || arm.mode === 'native-default')) throw refuse({ code: 'USAGE', message: `cell ${def.id} has no packed arm ${armId}`,
    why: 'a re-read sends the frozen contexts of a packed (or native-default) arm, and only those arms freeze one', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cell.ts', 'show', '--cell', def.id] } });
  return arm;
}

/** One planned reading: the frozen context the source answers read, or none when the question's retrieval failed. */
export interface PlannedRead { question: MemoryQuestion; realization_id: string; context_sha256: string; outcome: Outcome; context: FrozenContext | null }

export interface RereadVerify {
  schema: typeof REREAD_VERIFY_SCHEMA; ok: boolean; cell: string; arm: string; arm_cell_id: string; reader: string;
  sources: Array<{ path: string; contexts_sha256: string | null; contexts_records: number; arm_records: number; config_sha256: string | null }>;
  counts: {
    contexts_checked: number; contexts_matched: number; scheduled_questions: number; questions_with_context: number; questions_without_context: number;
    stored_answers_cross_checked: number; published_answers: number; contexts_not_read: number;
  };
  source_config_sha256: string | null;
  problems: string[];
}

const noContext = (outcome: string) => sha256(`no-context|${outcome}`);
const armOf = (key: string) => key.slice(key.lastIndexOf('|') + 1);
const questionOf = (key: string) => key.slice(key.indexOf('|') + 1, key.lastIndexOf('|'));
const answerIdentity = (xs: AnswerRecord[]) => xs.map(a => JSON.stringify(a)).sort().join('\n');

/**
 * The launch metadata in a run config's `cell` that a re-read's sources may differ in (GBEV-3's decision A, A6 revision):
 * Q1 wrote these into run-config.json before A24, so shards of one cell launched under A17, A23 and A24 publish different
 * bytes for the same reading. Deny by default: every other field, a new or unknown one included, must match.
 */
export const REREAD_LAUNCH_FIELDS = ['expected_hours', 'fresh_before', 'lease', 'restore_command', 'snapshot_command', 'shards'] as const;

/**
 * A run config without REREAD_LAUNCH_FIELDS, serialized as runConfigText writes it; null when the bytes are not that
 * serialization of their own JSON, so a difference in anything but those fields (whitespace included) still refuses.
 */
export function readingConfig(text: string): string | null {
  let c: { cell?: unknown };
  try { c = JSON.parse(text); } catch { return null; }
  if (JSON.stringify(c, null, 2) + '\n' !== text) return null;
  if (c.cell && typeof c.cell === 'object') for (const k of REREAD_LAUNCH_FIELDS) delete (c.cell as Record<string, unknown>)[k];
  return JSON.stringify(c, null, 2) + '\n';
}

/**
 * The byte-for-byte check of every source and the reading plan. Problems are counted, never named by question, since
 * the sources hold sealed text; the plan is returned only when there are none.
 */
export function verifySources(def: CellDefinition, arm: ArmDefinition, sources: string[], corpus: Corpus, reader: string): { verify: RereadVerify; plan: PlannedRead[] | null } {
  const problems: string[] = [];
  const counts = { contexts_checked: 0, contexts_matched: 0, scheduled_questions: 0, questions_with_context: 0, questions_without_context: 0, stored_answers_cross_checked: 0, published_answers: 0, contexts_not_read: 0 };
  const verify: RereadVerify = { schema: REREAD_VERIFY_SCHEMA, ok: false, cell: def.id, arm: arm.id, arm_cell_id: arm.cell_id, reader, sources: [], counts, source_config_sha256: null, problems };
  const contexts: FrozenContext[] = [];
  const configs = new Map<string, string>();
  const staged: AnswerRecord[] = [];
  const retrievals = new Map<string, StagedRetrieval>();
  const seen = new Set<string>();
  for (const [i, given] of sources.entries()) {
    const root = resolve(given);
    const out = dirname(dirname(root));
    const contextsPath = join(root, 'contexts.ndjson');
    const src = { path: root, contexts_sha256: null as string | null, contexts_records: 0, arm_records: 0, config_sha256: null as string | null };
    verify.sources.push(src);
    if (basename(root) !== def.id || basename(dirname(root)) !== 'runs') { problems.push(`source ${i} is not a runs/${def.id} staging root`); continue; }
    if (!existsSync(contextsPath) || !existsSync(join(root, 'realizations.ndjson'))) { problems.push(`source ${i} has no contexts.ndjson or realizations.ndjson`); continue; }
    const bytes = readFileSync(contextsPath);
    src.contexts_sha256 = sha256(bytes);
    let malformed = 0;
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let c: FrozenContext;
      try { c = JSON.parse(line) as FrozenContext; } catch { malformed++; continue; }
      src.contexts_records++;
      if (typeof c.key !== 'string' || armOf(c.key) !== arm.id) continue;
      src.arm_records++;
      counts.contexts_checked++;
      if (typeof c.prompt === 'string' && sha256(c.prompt) === c.prompt_sha256 && c.meta?.context_sha256 === sha256(`${c.meta.identity_sha256}\u0000${c.prompt}`)) { counts.contexts_matched++; contexts.push(c); }
    }
    if (malformed) problems.push(`source ${i}: ${malformed} contexts.ndjson line(s) are not JSON`);
    const config = join(out, 'cells', arm.cell_id, 'run-config.json');
    if (existsSync(config)) { src.config_sha256 = sha256(readFileSync(config)); configs.set(readFileSync(config, 'utf8'), src.config_sha256); }
    else problems.push(`source ${i} has no published run-config.json for ${arm.cell_id}`);
    const mine: AnswerRecord[] = [];
    for (const [conv, s] of gatherStaging(def.id, [out])) {
      if (seen.has(conv)) { problems.push(`source ${i} stages a conversation another source stages too`); continue; }
      seen.add(conv);
      const dir = join(s.root, 'r', s.rid);
      mine.push(...readRecords(join(dir, 'answers.ndjson'), 'answer').filter(a => a.cell_id === arm.cell_id));
      for (const [k, r] of latestBy<StagedRetrieval>(join(dir, 'retrievals.ndjson'), r => r.key)) retrievals.set(k, r);
    }
    staged.push(...mine);
    const published = readRecords(join(out, 'cells', arm.cell_id, 'answers.ndjson'), 'answer');
    counts.published_answers += published.length;
    const publishedQs = new Set(published.map(a => a.question_id));
    if (answerIdentity(published) !== answerIdentity(mine.filter(a => publishedQs.has(a.question_id)))) problems.push(`source ${i}: the published answers of ${arm.cell_id} are not its staged answers`);
    const stagedQs = new Set(mine.map(a => a.question_id)).size;
    if (stagedQs !== publishedQs.size) problems.push(`source ${i}: ${stagedQs} questions have staged answers and ${publishedQs.size} published ones; republish its cells (bun eval/runner/q1/cell.ts merge)`);
  }
  if (counts.contexts_matched !== counts.contexts_checked) problems.push(`${counts.contexts_checked - counts.contexts_matched} of ${counts.contexts_checked} frozen contexts of arm ${arm.id} do not hash to their prompt_sha256 and context_sha256`);
  const readings = new Set([...configs.keys()].map(t => (configs.size > 1 ? readingConfig(t) : null) ?? t));
  if (readings.size > 1) problems.push(`the sources publish ${readings.size} different run configurations for ${arm.cell_id}, comparing every field but cell.${REREAD_LAUNCH_FIELDS.join(', cell.')}`);
  if (problems.length) return { verify, plan: null };

  const [configText] = readings;
  verify.source_config_sha256 = configs.size > 1 ? sha256(configText) : configs.get(configText)!;
  const config = JSON.parse(configText) as { limit: number | null; scheduled_sha256: string };
  const selected = scheduledQuestions(def, corpus, config.limit);
  if (sha256(selected.map(q => q.id).join('\n')) !== config.scheduled_sha256) {
    problems.push(`this tree schedules ${selected.length} questions for ${def.id}, not the schedule its run-config.json froze`);
    return { verify, plan: null };
  }
  const scheduled = arm.questions ? selectCellQuestions(selected, arm.questions) : selected;
  counts.scheduled_questions = scheduled.length;
  const byQuestion = new Map<string, AnswerRecord[]>();
  for (const a of staged) byQuestion.set(a.question_id, [...(byQuestion.get(a.question_id) ?? []), a]);
  const read = new Set<FrozenContext>();
  const key = policyKey(arm);
  const missing = { answers: 0, split: 0, context: 0, ambiguous: 0, retrieval: 0 };
  const plan: PlannedRead[] = [];
  for (const q of scheduled) {
    const answers = byQuestion.get(q.id) ?? [];
    if (!answers.length) { missing.answers++; continue; }
    counts.stored_answers_cross_checked += answers.length;
    const shas = new Set(answers.map(a => a.context_sha256));
    if (shas.size > 1) { missing.split++; continue; }
    const [sha] = shas;
    const frozen = contexts.filter(c => questionOf(c.key) === q.id && c.meta.context_sha256 === sha);
    const base = { question: q, realization_id: answers[0].realization_id, context_sha256: sha };
    if (!frozen.length) {
      const outcomes = new Set(answers.map(a => a.outcome));
      const [outcome] = outcomes;
      if (outcomes.size === 1 && !JUDGED.has(outcome) && sha === noContext(outcome)) { counts.questions_without_context++; plan.push({ ...base, outcome, context: null }); }
      else missing.context++;
      continue;
    }
    if (new Set(frozen.map(c => c.prompt_sha256)).size > 1) { missing.ambiguous++; continue; }
    const outcome = key ? retrievals.get(`${q.id}|${key}`)?.outcome : undefined;
    if (!outcome || !JUDGED.has(outcome)) { missing.retrieval++; continue; }
    frozen.forEach(c => read.add(c));
    counts.questions_with_context++;
    plan.push({ ...base, outcome, context: frozen[0] });
  }
  counts.contexts_not_read = contexts.filter(c => !read.has(c)).length;
  if (missing.answers) problems.push(`${missing.answers} of ${scheduled.length} scheduled questions have no stored answer of ${arm.cell_id}`);
  if (missing.split) problems.push(`${missing.split} questions have stored answers that read different contexts`);
  if (missing.context) problems.push(`${missing.context} questions have no frozen context matching their stored answers' context_sha256`);
  if (missing.ambiguous) problems.push(`${missing.ambiguous} questions have two different frozen prompts under one context_sha256`);
  if (missing.retrieval) problems.push(`${missing.retrieval} questions with a frozen context have no scored retrieval behind it`);
  verify.ok = !problems.length;
  return { verify, plan: problems.length ? null : plan };
}

export interface RereadOptions { sources: string[]; reader: string; out: string; manifest?: CellManifestId; env?: Record<string, string | undefined>; keyless?: boolean }
export interface RereadDeps { corpus?: Corpus; reader?: ChatLike; judge?: ChatLike; instrument?: Instrument }
export interface PreparedReread { def: CellDefinition; arm: ArmDefinition; reader: string; out: string; manifest: CellManifestId | null; keyless: boolean; instrument: Instrument; dataset: Corpus['source']; verify: RereadVerify; plan: PlannedRead[] }

/** Everything before the first request: the judge refusal, custody, one re-read per --out, the --out claim, the corpus and the byte-for-byte check (verify.json). */
export function prepareReread(def: CellDefinition, arm: ArmDefinition, opts: RereadOptions, deps: Pick<RereadDeps, 'corpus' | 'instrument'> = {}): PreparedReread {
  const env = opts.env ?? process.env;
  const out = resolve(opts.out);
  const instrument = deps.instrument ?? instrumentFor(def.canonical_instrument);
  let frontier: string[];
  try { frontier = arm.frontier?.per_reader ? frontierJudgesFor(arm, opts.reader) : []; }
  catch (e) { throw refuse({ code: 'USAGE', message: `${arm.cell_id} judges each reader with its family's frontier judge: ${(e as Error).message}`, why: 'a re-read answer on a per-reader frontier arm is scored by both judge views, so a reader without a preregistered judge would be read and never fully scored', fix: { next: 'report', user_message: 're-read with particle:particle-1, whose frontier judge is openai:gpt-6.1-sol' } }); }
  refuseCompatJudges(arm.cell_id, [instrument.canonical_judge, ...frontier]);
  if (def.benchmark === 'beam-rs1' && (deps.corpus ? deps.corpus.source.revision === 'unfilled' : readRs1Manifest().manifest.status !== 'filled')) throw refuse({ code: 'PREFLIGHT_FAILED', message: `beam-rs1: the RS1 manifest is unfilled, so ${arm.cell_id} cannot be re-read`,
    why: 'a re-read is scored only against the filled manifest\'s pinned bytes, and verdict.ts checks the re-read receipt\'s dataset against it', fix: { next: 'ask_user', user_message: 'the custodian fills the RS1 manifest before any RS1 re-read' } });
  if (!hasChatRoute(opts.reader)) throw refuse({ code: 'USAGE', message: `reader ${opts.reader} has no chat route`, why: 'a re-read sends each frozen prompt to one provider:model reader', fix: { next: 'run', argv: [...FRONT, '--reader', 'particle:particle-1'] } });
  if (!deps.corpus && needsCustody(def)) custodyGate(def, out, env, `q1 reread ${arm.cell_id} with ${opts.reader}`);
  const others = existsSync(join(out, 'cells')) ? readdirSync(join(out, 'cells')).sort().filter(d => d !== rereadCellId(arm.cell_id, opts.reader)) : [];
  if (others.length) throw refuse({ code: 'USAGE', message: `${out} already holds ${others.join(', ')}; give each arm and reader its own --out`,
    why: 'verify.json, the lease usage log and the keyless/paid marker sit at the --out root, and each re-read receipt points at them', fix: { next: 'run', argv: [...FRONT, '--out', '<a fresh directory>'] } });
  mkdirSync(out, { recursive: true });
  claimOut(out, !!opts.keyless, 'reread');
  // RS1 kept cells load only the conversations the sources staged (one launch unit's); later slots may never have been minted.
  const staged = def.kept_units ? new Set(opts.sources.flatMap(s => [...gatherStaging(def.id, [dirname(dirname(resolve(s)))]).keys()])) : null;
  const corpus = deps.corpus ?? loadCorpus(def.benchmark, undefined, staged ?? devOnly(def) ?? undefined);
  const { verify, plan } = verifySources(def, arm, opts.sources, corpus, opts.reader);
  const frozen = join(out, 'reread-source.json');
  const resuming = existsSync(frozen);
  if (!plan) {
    if (!resuming) writeFileSync(join(out, 'verify.json'), JSON.stringify(verify, null, 2) + '\n');
    throw refuse({ code: 'PREFLIGHT_FAILED', message: `re-read of ${arm.cell_id} refused before any request: ${verify.problems.join('; ')}`,
      why: 'a re-read sends exactly the bytes the source readers read, so every frozen context, answer and schedule must check out first',
      fix: { next: 'report', user_message: resuming ? `the sources no longer verify; ${join(out, 'verify.json')} still holds the check the answers in ${out} were read under` : `the counts are in ${join(out, 'verify.json')}` } });
  }
  const identity = JSON.stringify({ arm_cell_id: arm.cell_id, reader: opts.reader, effort: def.effort, config_sha256: verify.source_config_sha256, contexts_sha256: verify.sources.map(s => s.contexts_sha256).sort() }) + '\n';
  if (resuming && readFileSync(frozen, 'utf8') !== identity) throw refuse({ code: 'USAGE', message: `${out} holds a re-read of other sources, another run configuration or another effort; give this run a fresh --out`,
    why: 'a resume keeps the answers already in --out, so it must read the sources they were read from', fix: { next: 'run', argv: [...FRONT, '--out', '<a fresh directory>'] } });
  writeFileSync(join(out, 'verify.json'), JSON.stringify(verify, null, 2) + '\n');
  if (!resuming) writeFileSync(frozen, identity);
  return { def, arm, reader: opts.reader, out, manifest: opts.manifest ?? null, keyless: !!opts.keyless, instrument, dataset: corpus.source, verify, plan };
}

export interface RereadResult { cell_id: string; dir: string; status: 'complete' | 'partial'; stopped: string | null; receipt: Record<string, unknown> }

/** Read and judge the plan, resuming from --out, then write receipt.json; `lease` names the lease and its proxy's usage log for the receipt. */
export async function runReread(p: PreparedReread, opts: { providerProxy?: string | null; env?: Record<string, string | undefined>; maxAttempts?: number; lease?: { usd: number; usageLog: string } } = {},
  deps: Pick<RereadDeps, 'reader' | 'judge'> = {}): Promise<RereadResult> {
  const { def, arm, reader, instrument, plan } = p;
  const env = opts.env ?? process.env;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const cellId = rereadCellId(arm.cell_id, reader);
  const dir = join(p.out, 'cells', cellId);
  mkdirSync(dir, { recursive: true });
  const answers = new RecordLog(join(dir, 'answers.ndjson'), 'answer');
  const judgments = new RecordLog(join(dir, 'judgments.ndjson'), 'judgment');
  const appendAnswer = answerAppender(dir, answers, maxAttempts);
  const meters = join(dir, 'meters.ndjson');
  const meter = metering(opts.providerProxy ?? null, { meter: (m: MeterLine) => appendFileSync(meters, JSON.stringify(m) + '\n') }, env);
  const chat = new ChatClient(join(p.out, 'cache', 'qa'));
  const readerChat = onSlot(deps.reader ?? chat, meter, 'harness');
  const judgeChat = onSlot(deps.judge ?? chat, meter, 'judge');
  const planned = requiredJudges(arm, { reader, replicate: 0 }, instrument);
  const judgedBy = (id: string, judge: string) => judgments.has(judgmentKey({ answer_id: id, instrument_sha256: instrument.sha256, judge, judge_replicate: 0 }));
  const judged = (id: string) => planned.every(j => judgedBy(id, j.judge));
  const idOf = (x: PlannedRead) => answerId(cellId, x.question.id, reader, 0);
  let stopped: string | null = null;

  const one = async (x: PlannedRead) => {
    const id = { cell_id: cellId, realization_id: x.realization_id, question_id: x.question.id, conversation: x.question.conversation, system: def.system, arm: arm.arm, reader, replicate: 0, effort: def.effort, context_sha256: x.context_sha256 };
    const aid = idOf(x);
    if (!answers.has(aid)) {
      if (!x.context) answers.append(answerRecord(id, { text: '', outcome: x.outcome, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, latency_ms: 0, provider_input_tokens: null }));
      else {
        const reading = await readPrompt(readerChat, meter, { reader, prompt: x.context.prompt, question_id: x.question.id, replicate: 0, effort: def.effort, key: `read:${aid.slice(0, 16)}`, outcome: x.outcome });
        if (reading.budget !== undefined) {
          if (reading.payload) appendAnswer(answerRecord(id, reading.payload), reading.budget);
          stopped = `budget: ${reading.budget.slice(0, 200)}`;
          return;
        }
        const pack = { delivered: x.context.meta.delivered } as PackedContext;
        appendAnswer(answerRecord(id, reading.payload!), reading.error, reading.error === undefined ? pack : null, reading.final);
      }
    }
    const a = answers.get(aid);
    if (!a || !JUDGED.has(a.outcome)) return;
    for (const j of planned) {
      if (judgedBy(aid, j.judge)) continue;
      const r = await meter.around('judge', `judge:${aid.slice(0, 16)}:${j.judge}`, 'judge', () => judgeAnswer(judgeChat, instrument, x.question, a.text, { judge: j.judge, judgeReplicate: 0, maxAttempts, ...(j.settings ? { settings: j.settings } : {}) }));
      if (r.error !== undefined) { if (/budget/i.test(String((r.error as Error).message))) stopped = `budget: ${String((r.error as Error).message).slice(0, 200)}`; return; }
      judgments.append({ answer_id: aid, ...r.value!, instrument_id: j.instrument_id });
    }
  };
  const needs = (x: PlannedRead) => { const a = answers.get(idOf(x)); return !a || (JUDGED.has(a.outcome) && !judged(a.answer_id)); };
  for (let pass = 0; pass < maxAttempts && !stopped; pass++) {
    const todo = pass === 0 ? plan : plan.filter(needs);
    if (!todo.length) break;
    for (const x of todo) { if (stopped) break; await one(x); }
  }

  const order = new Map(plan.map((x, i) => [idOf(x), i]));
  const all = answers.all().sort((a, b) => (order.get(a.answer_id) ?? 0) - (order.get(b.answer_id) ?? 0));
  const canonical = new Map(judgments.all().filter(j => j.instrument_id === instrument.id && j.judge_replicate === 0).map(j => [j.answer_id, j]));
  const scores = all.map(a => canonical.get(a.answer_id)?.score).filter((s): s is number => typeof s === 'number');
  const view = planned[1];
  const viewScores = view ? all.map(a => judgments.all().find(j => j.answer_id === a.answer_id && j.instrument_id === view.instrument_id && j.judge_replicate === 0)?.score).filter((s): s is number => typeof s === 'number') : [];
  const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length * 1e6) / 1e6 : null;
  const outcomes: Record<string, number> = {};
  for (const a of all) outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1;
  const unjudged = all.filter(a => JUDGED.has(a.outcome) && !judged(a.answer_id)).length;
  const status = !stopped && all.length === plan.length && !unjudged ? 'complete' as const : 'partial' as const;
  const spent = existsSync(meters) ? readFileSync(meters, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as MeterLine) : [];
  const usd = (phase: MeterLine['phase']) => Math.round(spent.filter(m => m.phase === phase).reduce((s, m) => s + m.usd, 0) * 1e6) / 1e6;
  const sum = (k: keyof AnswerRecord['usage']) => all.reduce((s, a) => s + a.usage[k], 0);
  const receipt = {
    schema: REREAD_RECEIPT_SCHEMA, cell_id: cellId, run_status: status, stopped, keyless: p.keyless,
    source: { cell: def.id, manifest: p.manifest, arm: arm.id, arm_cell_id: arm.cell_id, config_sha256: p.verify.source_config_sha256, config_sha256s: [...new Set(p.verify.sources.map(s => s.config_sha256))].sort(), contexts: p.verify.sources.map(s => ({ sha256: s.contexts_sha256, records: s.contexts_records, arm_records: s.arm_records })) },
    set: arm.set, benchmark: def.benchmark, split: def.split, block: def.block, dataset: p.dataset,
    system: { kind: def.system, configuration: def.configuration },
    arm: { id: arm.id, arm: arm.arm, mode: arm.mode, policy: arm.policy, budget: arm.budget, label: arm.label },
    readers: [reader], reader_replicates: {}, effort: def.effort, max_tokens: readerMaxTokens(reader),
    instrument: { id: instrument.id, sha256: instrument.sha256, judge: instrument.canonical_judge },
    frontier: view ? { per_reader: true, judge_by_reader: { [reader]: view.judge }, instrument_ids: [view.instrument_id] } : null,
    verify: p.verify.counts,
    counts: { answers: all.length, answers_promised: plan.length, judgments: judgments.size, unjudged, outcomes, truncated: all.filter(a => a.truncated).length },
    per_reader_mean: { [reader]: mean(scores) },
    ...(view ? { per_reader_frontier_mean: { [reader]: mean(viewScores) } } : {}),
    usage: { input: sum('input'), output: sum('output'), cache_read: sum('cache_read'), cache_write: sum('cache_write') },
    spend: { source: opts.providerProxy ? 'metering proxy' : null, reader_usd: usd('reader'), judge_usd: usd('judge') },
    lease: opts.lease ? { usd: opts.lease.usd, ...(existsSync(opts.lease.usageLog) ? usageSplit(opts.lease.usageLog) : {}) } : null,
    files: { answers: 'answers.ndjson', judgments: 'judgments.ndjson', verify: '../../verify.json' },
  };
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { cell_id: cellId, dir, status, stopped, receipt };
}

/**
 * The re-read's lease on the add-on's own ledger. Each lease opens its own run and raises that ledger's cap by its own
 * amount, so the cap A6 sets on all the leases together is checked here: a lease that would take the ledger's committed
 * spend (open reservations included) past `capUsd` is refused before it opens. A lease still open under the same run id
 * re-attaches: its own spend was inside its amount when it opened, so only the rest of the ledger's spend is added to it.
 */
export function openRereadLease(o: { runId: string; leaseUsd: number; ledgerPath: string; capUsd: number; runner?: string }): BudgetRun {
  const status = existsSync(ledgerPaths(o.ledgerPath).ledger) ? ledgerStatus({ ledgerPath: o.ledgerPath, runId: o.runId }) : null;
  const spent = status ? status.totals.committed_usd - (status.run && !status.run.finished_at ? status.run.committed_usd : 0) : 0;
  if (!(o.capUsd > 0) || spent + o.leaseUsd > o.capUsd + 1e-9) throw refuse({ code: 'USAGE', message: `a $${o.leaseUsd.toFixed(2)} lease on ${o.ledgerPath}, which holds $${spent.toFixed(2)} committed, would pass its $${o.capUsd.toFixed(2)} ceiling`,
    why: 'every re-read lease of the add-on ledger shares one ceiling (A6: $100), and a refused lease sends nothing', fix: { next: 'ask_user', user_message: 'the re-reads would pass their preregistered ceiling; tell GBEV-3 before any more run' } });
  return BudgetRun.openLease({ runId: o.runId, leaseUsd: o.leaseUsd, ledgerPath: o.ledgerPath, runner: o.runner ?? 'q1-reread-cell' });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const sources = argv.flatMap((a, i) => (a === '--source' && argv[i + 1] ? [argv[i + 1]] : []));
  const [cellArg, armArg, reader, outArg, ledger, runId, leaseUsd, ledgerCap] = [one('--cell'), one('--arm'), one('--reader'), one('--out'), one('--budget-ledger'), one('--run-id'), Number(one('--lease-usd')), Number(one('--ledger-cap-usd'))];
  if (!cellArg || !armArg || !sources.length || !reader || !outArg || !ledger || !runId || !(leaseUsd > 0) || !(ledgerCap > 0)) {
    console.error(`usage: ${FRONT.join(' ')} --cell <source cell id> --arm <arm id> --source <out>/runs/<cell id>... --reader <provider:model> --out <dir> --budget-ledger <file> --run-id <id> --lease-usd <n> --ledger-cap-usd <n> [--manifest q1|f6|rs1] [--keyless-upstream <url>]`);
    process.exit(2);
  }
  let keyless: string | null;
  try { keyless = keylessUpstreamArg(argv); }
  catch (e) { console.error((e as Error).message); process.exit(2); }
  const manifest = one('--manifest') as CellManifestId | undefined;
  try {
    const def = findCell(cellArg, undefined, manifest);
    const stage1 = manifest === 'rs1' && def.block === 'RS1-S1' ? loadRS1Manifest().stage1_reread_cap_usd : null;
    if (stage1 !== null && ledgerCap > stage1 + 1e-9) throw refuse({ code: 'USAGE', message: `a $${ledgerCap.toFixed(2)} --ledger-cap-usd for stage 1 re-read ${def.id} is above the $${stage1.toFixed(2)} stage 1 keeps for its re-reads`,
      why: 'stage 1\'s $60 cap covers the dry-run campaign and its particle-1 re-reads together: the campaign is capped at $60 less the re-reads\' estimate, and the re-reads share one ledger capped at that estimate', fix: { next: 'run', user_message: `rerun with --ledger-cap-usd ${stage1.toFixed(2)} or less, on the one ledger every stage 1 re-read shares` } });
    const arm = rereadArm(def, armArg);
    const out = resolve(outArg);
    const prepared = prepareReread(def, arm, { sources, reader, out, manifest, keyless: !!keyless });
    const placeholder = 'keyless-not-a-provider-key';
    const keys = keyless ? { OPENAI_API_KEY: placeholder, ANTHROPIC_API_KEY: placeholder, VOYAGE_API_KEY: placeholder, PARTICLE_API_KEY: placeholder } : { ...process.env };
    const [cellToken, controlToken] = [randomUUID(), randomUUID()];
    Object.assign(process.env, { SHOOTOUT_CELL_TOKEN: cellToken, SHOOTOUT_PROXY_CONTROL_TOKEN: controlToken });
    const lease = openRereadLease({ runId, leaseUsd, ledgerPath: resolve(ledger), capUsd: ledgerCap });
    const usageLog = join(out, 'usage.ndjson');
    const proxy = new MeteringProxy({ ...(keyless ? { upstream: { openai: keyless, anthropic: keyless, voyage: keyless, particle: `${keyless}/particle` } } : {}), cellToken, controlToken,
      policy: { lease, usageLog, env: keys, routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
    proxy.start();
    try {
      const res = await runReread(prepared, { providerProxy: `http://127.0.0.1:${proxy.port}`, lease: { usd: leaseUsd, usageLog } });
      const r = res.receipt as { counts: unknown; lease: unknown; per_reader_mean: unknown; effort: string; max_tokens: number };
      console.log(JSON.stringify({ cell: res.cell_id, status: res.status, stopped: res.stopped, keyless: !!keyless, verify: prepared.verify.counts, contexts_sha256: prepared.verify.sources.map(s => s.contexts_sha256),
        effort: r.effort, max_tokens: r.max_tokens, counts: r.counts, per_reader_mean: r.per_reader_mean, lease: r.lease }, null, 2));
      process.exitCode = res.status === 'complete' ? 0 : 4;
    } finally {
      proxy.stop();
      lease.close();
    }
  } catch (e) {
    if (e instanceof ScoreboardError) { process.stderr.write(renderMessage(e.op) + '\n'); process.exit(exitCodeOf(e.op)); }
    throw e;
  }
}

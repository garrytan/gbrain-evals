/**
 * P5 H6: do typed relation lines help an agent answer from a brain it wrote itself?
 *
 * Two phases per arm and model:
 *   ingest  the agent reads Amara's world (eval/data/amara-life-v1, rendered by chronicle-lift.ts
 *           renderCorpus: meetings, notes, documents, calendar invites, Slack days, emails) in fixed
 *           batches and writes the brain through gbrain's MCP server, following the arm's guidance
 *           file. After every batch the server stops, `gbrain extract --stale` reconciles the links an
 *           MCP (remote) writer left as text, and the brain is snapshotted (the checkpoint).
 *   answer  fresh sessions answer each question from the brain alone (read-only tools, so concurrent
 *           sessions share one server), `--replicates` times; every replicate is judged once against the
 *           reference answer. Per question: qa_score = mean over replicates (0..1) and qa_sd.
 *
 * Arms (one invocation each; rows pair across arms by `<model>:<question>`, cluster = question pair):
 *   A  baseline build, eval/data/p5-write-then-answer/guidance-a.md (frontmatter link fields, add_link,
 *      the Facts table, remember)
 *   B  candidate build with GBRAIN_EVAL_CONFIG=line_grammar.enabled=true, guidance-b.md (relation lines,
 *      validity ranges, fact lines)
 * The two guidance files share their first half word for word and are within 10% of each other in length
 * (test/eval/p5-agent-runners.test.ts checks both).
 *
 * Questions: paired relational ("who") and temporal ("when") questions about the same item. Dev runs
 * generate a small seeded set from the corpus's calendar invites and meeting pages (dev seeds 1-3). The
 * custodian supplies the sealed set: --phrasing-file <custody path> --decision-id <id> --purpose <text> with
 * `{ "id": ..., "templates": { "questions": [{ "id", "pair", "type": "relational"|"temporal", "question", "answer" }] } }`;
 * rows then omit question and answer text.
 *
 * Usage:
 *   bun eval/runner/write-then-answer.ts --gbrain <checkout>@<ref> --arm-label A --guidance eval/data/p5-write-then-answer/guidance-a.md \
 *     --output <dir> [--work <dir outside any git worktree>] [--models claude-sonnet-5-5,gpt-6.1-sol] [--judge gpt-6.1-sol] [--replicates 10]
 *     [--dev-seed 1] [--dev-pairs 8] [--dev-items calendar,meeting] [--batch-chars 24000] [--ingest-batches N] [--phase ingest|answer|all] [--concurrency 4]
 *     [--pilot | --limit N] [--scripted] [--paid --budget-usd N | --paid --budget-run-id <id>]
 *   bun eval/runner/write-then-answer.ts compare <receipt A> <receipt B>
 * Resumable: ingest.jsonl (one line per batch, with a brain snapshot) and answers.jsonl (one line per judged replicate).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { runAgent, type AgentRun, type ScriptedModel } from './cat40/loop.ts';
import { receiptCost, type RunSummary } from './budget-ledger.ts';
import { custodyInput, p5Receipt } from './p5-brain.ts';
import { corpusDigest, renderCorpus } from './chronicle-lift.ts';
import {
  AgentBrain, Checkpoint, closePaid, P5_ANSWER_TOOLS, ToolsArm, chatText, compareReceipts, firstJsonObject, flagValue, limitFlag, openPaid, readGuidance,
  runPool, seededSample, selectUnits, sha256, type PaidSession,
} from './p5-agent.ts';
import { writeReceipt } from './receipt.ts';

export const CATEGORY = 'write-then-answer';
export const VERSION = 'p5-write-then-answer-v1';
export const DEV_SEEDS: readonly number[] = [1, 2, 3];
export const DEFAULT_MODELS = ['claude-sonnet-5-5', 'gpt-6.1-sol'];
export const TODAY = '2026-04-19';
export const JUDGE_PROMPT_VERSION = 'p5-h6-judge-v1';
const REPO = resolve(import.meta.dir, '../..');

export interface QaQuestion { id: string; pair: string; type: 'relational' | 'temporal'; question: string; answer: string }

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

/** `pairs` seeded items, each giving one relational and one temporal question. */
export function devQuestions(seed: number, pairs: number, kinds: ReadonlyArray<'calendar' | 'meeting'> = ['calendar', 'meeting']): QaQuestion[] {
  if (!DEV_SEEDS.includes(seed)) throw new Error(`dev questions use dev seeds ${DEV_SEEDS.join(', ')}; the sealed set comes from the custodian`);
  return seededSample(datedItems().filter(it => kinds.includes(it.kind)), pairs, seed).flatMap((it, i) => {
    const pair = `dev${seed}-p${String(i + 1).padStart(2, '0')}`;
    const what = it.kind === 'calendar' ? `the calendar invite "${it.title}"` : `the meeting "${it.title}"`;
    return [
      { id: `${pair}-rel`, pair, type: 'relational' as const, question: `Who, other than Amara, was part of ${what}? Answer with their full names.`, answer: it.people.join(', ') },
      { id: `${pair}-tmp`, pair, type: 'temporal' as const, question: `On what date was ${what}? Answer with the date as YYYY-MM-DD.`, answer: it.date },
    ];
  });
}

// ─── Ingest batches ─────────────────────────────────────────────────

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

export function ingestPrompt(batch: Array<{ path: string; content: string }>, index: number, total: number): string {
  return [
    `Batch ${index + 1} of ${total} of Amara Okafor's documents follows. Read them and record what matters in her brain, following the brain-writing guidance, so that later questions about people, companies, how they are connected and when things happened can be answered from the brain alone. Earlier batches may already be in the brain; update existing pages instead of duplicating them.`,
    ...batch.map(p => `<document path="${p.path}">\n${p.content.trim()}\n</document>`),
    'When this batch is recorded, call submit_answer with `answer` set to DONE and the slugs you wrote in `sources`.',
  ].join('\n\n');
}

export function ingestSystem(arm: ToolsArm): string {
  return [`You are an AI assistant that maintains the personal knowledge base (brain) of Amara Okafor, a partner at Halfway Capital. Today is ${TODAY}.`, arm.systemHint()].join('\n\n');
}

export function answerSystem(arm: ToolsArm): string {
  return [
    `You are an AI assistant working for Amara Okafor, a partner at Halfway Capital. Today is ${TODAY}.`,
    'Answer from Amara\'s brain, reached through the tools listed. Do not guess.',
    arm.systemHint(),
    'When you are done, call submit_answer with the answer in `answer` (names or a YYYY-MM-DD date as asked), the pages you relied on in `sources`, and any caveats in `notes`. If the brain does not contain the answer, answer UNKNOWN.',
  ].join('\n\n');
}

// ─── Judge ──────────────────────────────────────────────────────────

export const JUDGE_SYSTEM = 'You grade answers to questions about a person\'s records. You reply with one JSON object and nothing else.';
export function judgePrompt(q: Pick<QaQuestion, 'question' | 'answer'>, response: string): string {
  return [
    `Question: ${q.question}`, `Reference answer: ${q.answer}`, `Response: ${response || '(no answer)'}`, '',
    'Is the response correct? For a question asking for people, it is correct only if it names every person in the reference and no other person (first names alone are enough when unambiguous). For a date, it is correct only if it gives the reference date. UNKNOWN or a refusal is incorrect.',
    'Reply with JSON: {"correct": true | false, "reason": "<one sentence>"}',
  ].join('\n');
}

// ─── Records and summaries ──────────────────────────────────────────

interface IngestRecord {
  key: string; model: string; batch: number; pages: string[]; tar: string; run: Omit<AgentRun, 'tools'> & { tool_calls: Array<{ name: string; ms: number; chars: number; error?: string }> };
  sweep_ms: number; budget_run_id: string | null; finished_at: string;
}
interface AnswerRecord {
  key: string; model: string; question: string; replicate: number; answer: string; correct: number | null; judge_reason: string; judge_usd: number;
  agent_usd: number; stop: string; turns: number; error?: string; error_origin?: string; budget_run_id: string | null;
}

export function questionRows(questions: readonly QaQuestion[], models: readonly string[], answers: readonly AnswerRecord[], replicates: number, redact: boolean): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const model of models) for (const q of questions) {
    const mine = answers.filter(a => a.model === model && a.question === q.id && a.replicate < replicates);
    if (!mine.length) continue;
    const scored = mine.filter(a => a.correct !== null);
    const mean = scored.length ? scored.reduce((s, a) => s + a.correct!, 0) / scored.length : null;
    const sd = scored.length > 1 ? Math.sqrt(scored.reduce((s, a) => s + (a.correct! - mean!) ** 2, 0) / (scored.length - 1)) : null;
    rows.push({
      id: `${model}:${q.id}`, cluster: `${model}:${q.pair}`, model, question_id: q.id, pair: q.pair, type: q.type,
      ...(redact ? {} : { question: q.question, reference: q.answer }),
      replicates: scored.length, replicates_planned: replicates, ...(mean === null ? { error: 'no judged replicate', error_origin: 'judge' } : { qa_score: mean, qa_sd: sd }),
      agent_usd: mine.reduce((s, a) => s + a.agent_usd, 0), judge_usd: mine.reduce((s, a) => s + a.judge_usd, 0),
    });
  }
  return rows;
}

export function summarizeH6(rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  const scored = rows.filter(r => typeof r.qa_score === 'number');
  const block = (xs: ReadonlyArray<Record<string, unknown>>) => {
    const s = xs.map(r => r.qa_score as number);
    const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    const sds = xs.map(r => r.qa_sd).filter((x): x is number => typeof x === 'number');
    return { questions: s.length, qa_score: mean, mean_replicate_sd: sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : null };
  };
  const models = [...new Set(rows.map(r => String(r.model)))].sort();
  return {
    ...block(scored), per_model: Object.fromEntries(models.map(m => [m, { ...block(scored.filter(r => r.model === m)),
      relational: block(scored.filter(r => r.model === m && r.type === 'relational')), temporal: block(scored.filter(r => r.model === m && r.type === 'temporal')) }])),
    relational: block(scored.filter(r => r.type === 'relational')), temporal: block(scored.filter(r => r.type === 'temporal')),
  };
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

// ─── Main ───────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'compare') {
    const [a, b] = argv.slice(1);
    if (!a || !b) throw new Error('usage: write-then-answer.ts compare <receipt A (reference)> <receipt B>');
    console.log(JSON.stringify({ by_model: compareReceipts(a, b, ['qa_score'], { groupBy: 'model' }), by_type: compareReceipts(a, b, ['qa_score'], { groupBy: 'type' }) }, null, 2));
    return;
  }
  const log = (s: string) => process.stderr.write(`[h6] ${s}\n`);
  const devSeed = Number(flagValue(argv, '--dev-seed') ?? 1);
  const custody = custodyInput(argv, [devSeed], DEV_SEEDS);
  const allQuestions: QaQuestion[] = custody ? (custody.parsed.templates as { questions: QaQuestion[] }).questions : devQuestions(devSeed, Number(flagValue(argv, '--dev-pairs') ?? 8), (flagValue(argv, '--dev-items') ?? 'calendar,meeting').split(',') as Array<'calendar' | 'meeting'>);
  for (const q of allQuestions) if (!q.id || !q.pair || !['relational', 'temporal'].includes(q.type) || !q.question || !q.answer) throw new Error(`question ${q.id ?? '?'} needs id, pair, type (relational|temporal), question and answer`);
  const questions = selectUnits(allQuestions, q => q.id, { pilot: argv.includes('--pilot'), limit: limitFlag(argv) });
  const models = (flagValue(argv, '--models') ?? DEFAULT_MODELS.join(',')).split(',').filter(Boolean);
  const judge = flagValue(argv, '--judge') ?? 'gpt-6.1-sol';
  const replicates = Number(flagValue(argv, '--replicates') ?? 10);
  const scripted = argv.includes('--scripted');
  const phase = flagValue(argv, '--phase') ?? 'all';
  const concurrency = Number(flagValue(argv, '--concurrency') ?? 4);
  const ingestMaxTurns = Number(flagValue(argv, '--ingest-max-turns') ?? 60);
  const answerMaxTurns = Number(flagValue(argv, '--answer-max-turns') ?? 16);
  const armLabel = flagValue(argv, '--arm-label') ?? 'unlabeled';
  const guidancePath = resolve(flagValue(argv, '--guidance') ?? join(REPO, 'eval/data/p5-write-then-answer/guidance-a.md'));
  const guidance = readGuidance(guidancePath);
  const config = parseEvalConfig();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const commit = gut.overlay?.build.commit ?? `pin-${gut.version}`;
  const pages = renderCorpus();
  const allBatches = ingestBatches(pages, Number(flagValue(argv, '--batch-chars') ?? 24_000));
  const batchLimit = flagValue(argv, '--ingest-batches');
  const batches = batchLimit ? allBatches.slice(0, Number(batchLimit)) : allBatches;
  const output = resolve(flagValue(argv, '--output') ?? join(REPO, 'eval/reports', CATEGORY, `${armLabel}-${commit.slice(0, 9)}`));
  const work = resolve(flagValue(argv, '--work') ?? join(homedir(), '.cache/gbrain-evals', CATEGORY, sha256(output).slice(0, 12)));
  if (!relative(REPO, work).startsWith('..')) throw new Error(`--work ${work} is inside this repository; gbrain init refuses a content directory inside another Git worktree`);
  mkdirSync(output, { recursive: true });

  const identity = { version: VERSION, build: commit, config, arm: armLabel, guidance_sha256: guidance.sha256, models, judge, scripted, corpus: corpusDigest(pages),
    batches: batches.map(b => b.map(p => p.path)), ingest_max_turns: ingestMaxTurns, answer_max_turns: answerMaxTurns, questions_sha256: sha256(JSON.stringify(allQuestions)) };
  const identityPath = join(output, 'experiment.json');
  if (existsSync(identityPath) && readFileSync(identityPath, 'utf8') !== JSON.stringify(identity, null, 2) + '\n') throw new Error(`${output} holds a different experiment (experiment.json differs); use a new --output`);
  writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n');

  const ingest = new Checkpoint<IngestRecord>(join(output, 'ingest.jsonl'));
  const answers = new Checkpoint<AnswerRecord>(join(output, 'answers.jsonl'));
  const ingestTodo = phase === 'answer' ? [] : models.flatMap(m => batches.map((_, i) => `${m}|ingest|b${i}`)).filter(k => !ingest.has(k));
  const answerUnits = phase === 'ingest' ? [] : models.flatMap(model => questions.flatMap(q => Array.from({ length: replicates }, (_, r) => ({ model, q, r }))));
  const answerTodo = answerUnits.filter(u => !answers.has(`${u.model}|${u.q.id}|r${u.r}`));
  const estimate = Number(flagValue(argv, '--estimate-usd') ?? (ingestTodo.length * 0.8 + answerTodo.length * 0.06).toFixed(2));
  log(`gbrain ${gut.version} ${commit.slice(0, 12)} arm ${armLabel}, guidance ${guidance.words} words; ${batches.length} ingest batches x ${models.length} models (${ingestTodo.length} to do), ${answerUnits.length} answer replicates (${answerTodo.length} to do)`);
  let paid: PaidSession | null = null;
  if (!scripted && (ingestTodo.length || answerTodo.length)) paid = openPaid(argv, CATEGORY, estimate, join(output, 'budget-run.json'), log);
  const startedAt = new Date().toISOString();
  let harnessError: string | null = null;
  let summary: RunSummary | null = null;
  const graphs: Record<string, unknown> = {};
  try {
    for (const model of models) {
      const brain = new AgentBrain(gut.root, join(work, `brain-${model}-${commit.slice(0, 12)}-${sha256(JSON.stringify(config) + guidance.sha256).slice(0, 8)}`));
      const done = batches.map((_, i) => ingest.done.get(`${model}|ingest|b${i}`));
      const last = done.reduce((k, r, i) => (r ? i : k), -1);
      if (done.slice(0, last + 1).some(r => !r)) throw new Error(`${model}: ingest checkpoints are not a prefix of the batch plan`);
      if (last >= 0) await brain.restoreFrom(done[last]!.tar);
      else if (phase !== 'answer') await brain.create(config);
      for (let i = last + 1; i < batches.length && phase !== 'answer'; i++) {
        if (paid?.guard.exhausted) throw new Error('budget exhausted');
        await brain.start();
        const arm = new ToolsArm('gbrain', brain, guidance.text, 'Amara Okafor');
        let run: AgentRun;
        try {
          run = await runAgent({ model, system: ingestSystem(arm), user: ingestPrompt(batches[i], i, batches.length), arm, maxTurns: ingestMaxTurns, maxToolChars: null, scripted: scripted ? scriptedIngest(batches[i]) : undefined });
        } finally { await brain.stop(); }
        if (run.stop === 'error') throw new Error(`${model} ingest batch ${i + 1}: ${run.error}`);
        const sweep = await brain.sweep();
        const tar = `${brain.dir}.b${String(i).padStart(2, '0')}.tar`;
        brain.snapshot(tar);
        ingest.append({ key: `${model}|ingest|b${i}`, model, batch: i, pages: batches[i].map(p => p.path), tar, run: strip(run), sweep_ms: sweep.ms, budget_run_id: paid?.runId ?? null, finished_at: new Date().toISOString() });
        log(`${model} ingest ${i + 1}/${batches.length}: ${run.stop}, ${run.turns} turns, ${run.tools.length} tool calls, $${run.usd.toFixed(3)}`);
      }
      const complete = batches.every((_, i) => ingest.has(`${model}|ingest|b${i}`));
      if (complete) {
        const edges = brain.readEdges();
        const written = brain.readPages();
        graphs[model] = { pages: written.length, edges: edges.length, edges_by_type: edges.reduce((a, e) => ({ ...a, [e.type || 'untyped']: (a[e.type || 'untyped'] ?? 0) + 1 }), {} as Record<string, number>),
          pages_with_relation_lines: written.filter(p => /^\s*[-*+]\s+[A-Za-z][A-Za-z0-9_-]*\s+(?:@\S+\s+)?\[\[[^\]]+\]\]/m.test(p.body)).length,
          pages_with_facts_table: written.filter(p => /gbrain:facts:begin|^\|\s*#\s*\|\s*claim/m.test(p.body)).length };
      }
      const mine = answerTodo.filter(u => u.model === model);
      if (!mine.length) continue;
      if (!complete) throw new Error(`${model}: ingest is not complete (${batches.filter((_, i) => ingest.has(`${model}|ingest|b${i}`)).length}/${batches.length} batches); run --phase ingest first`);
      await brain.start();
      try {
        const arm = new ToolsArm('gbrain', brain, '', 'Amara Okafor', P5_ANSWER_TOOLS);
        let finished = 0;
        await runPool(mine, concurrency, async ({ q, r }) => {
          if (paid?.guard.exhausted) throw new Error('budget exhausted');
          const run = await runAgent({ model, system: answerSystem(arm), user: q.question, arm, maxTurns: answerMaxTurns, maxToolChars: null, scripted: scripted ? scriptedAnswer(q) : undefined });
          const response = [run.final?.answer ?? '', run.final?.notes ? `(notes: ${run.final.notes})` : ''].filter(Boolean).join(' ') || run.text || '';
          const base = { key: `${model}|${q.id}|r${r}`, model, question: q.id, replicate: r, answer: response, agent_usd: run.usd, stop: run.stop, turns: run.turns, budget_run_id: paid?.runId ?? null };
          if (run.stop === 'error') { answers.append({ ...base, correct: null, judge_reason: '', judge_usd: 0, error: run.error, error_origin: 'dependency' }); return; }
          let correct: number | null = null; let reason = ''; let judgeUsd = 0; let error: string | undefined;
          if (scripted) { correct = 0; reason = 'scripted run: not judged'; }
          else {
            try {
              const j = await chatText(judge, JUDGE_SYSTEM, judgePrompt(q, response), { maxTokens: 2000 });
              judgeUsd = j.usd;
              const parsed = firstJsonObject(j.text);
              if (typeof parsed?.correct === 'boolean') { correct = Number(parsed.correct); reason = String(parsed.reason ?? ''); }
              else error = `unparseable judge reply: ${j.text.slice(0, 200)}`;
            } catch (e) { if ((e as Error).name === 'BudgetExceededError') throw e; error = (e as Error).message; }
          }
          // A replicate without a verdict is not checkpointed, so a rerun judges it again.
          if (correct === null) { log(`${model} ${q.id} r${r}: judge failed (${error}); left for a rerun`); return; }
          answers.append({ ...base, correct, judge_reason: reason, judge_usd: judgeUsd });
          if (++finished % 20 === 0 || finished === mine.length) log(`${model}: ${finished}/${mine.length} replicates judged`);
        });
      } finally { await brain.stop(); }
    }
  } catch (e) {
    harnessError = e instanceof Error ? e.message : String(e);
  } finally {
    if (paid) summary = closePaid(paid, !harnessError && !(phase !== 'ingest' && answerUnits.some(u => !answers.has(`${u.model}|${u.q.id}|r${u.r}`))));
  }
  const redact = !!custody;
  const rows = questionRows(questions, models, answers.values(), replicates, redact);
  const ingestRecords = ingest.values();
  const planned = phase === 'ingest' ? 0 : models.length * questions.length;
  const incomplete = phase !== 'ingest' && rows.filter(r => r.replicates === replicates).length < planned;
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, rows,
    harnessError: harnessError ?? (incomplete ? `${planned - rows.filter(r => r.replicates === replicates).length} of ${planned} questions lack all ${replicates} judged replicates; rerun the same command to resume` : null),
    summary: {
      ...summarizeH6(rows), arm: armLabel, graphs,
      ingest: Object.fromEntries(models.map(m => { const rs = ingestRecords.filter(r => r.model === m); return [m, { batches: rs.length, batches_planned: batches.length, usd: rs.reduce((s, r) => s + r.run.usd, 0), stops: rs.map(r => r.run.stop), tool_calls: rs.reduce((s, r) => s + r.run.tool_calls.length, 0) }]; })),
      answer_usd: answers.values().reduce((s, a) => s + a.agent_usd, 0), judge_usd: answers.values().reduce((s, a) => s + a.judge_usd, 0),
      usd_per_replicate: answers.values().length ? answers.values().reduce((s, a) => s + a.agent_usd + a.judge_usd, 0) / answers.values().length : null,
    },
    basis: scripted ? 'scripted agent: no model and no paid request' : 'agent and judge calls through the paid-request guard; gbrain runs keyless (no provider key, no gbrain model calls)',
    resolvedConfig: {
      arm: armLabel, models, judge, judge_prompt: JUDGE_PROMPT_VERSION, replicates, scripted, phase, pilot: argv.includes('--pilot'), limit: limitFlag(argv),
      guidance: { path: relative(REPO, guidancePath), sha256: guidance.sha256, words: guidance.words },
      questions: custody ? `sealed set ${custody.parsed.id} (custody file sha256 ${custody.sha256}), ${allQuestions.length} questions` : `dev seed ${devSeed}, ${allQuestions.length} questions from calendar invites and meeting pages`,
      corpus: { id: 'amara-life-v1', renderer: 'chronicle-lift.ts renderCorpus', digest: corpusDigest(pages), pages: pages.length, batches: batches.length, batches_in_full_plan: allBatches.length },
      ingest: { max_turns: ingestMaxTurns, tools: 'P5_AGENT_TOOLS', after_each_batch: 'server stopped, gbrain extract --stale, snapshot' },
      answer: { max_turns: answerMaxTurns, tools: 'P5_ANSWER_TOOLS (read-only)', concurrency },
      transport: 'gbrain serve --surface full over stdio (remote caller); PGLite, gbrain init --no-embedding (keyword search); no tool-result cap',
      eval_config: { channel: 'GBRAIN_EVAL_CONFIG', requested: config },
      budget_run_id: paid?.runId ?? null,
    },
  });
  if (summary) receipt.cost = receiptCost(summary);
  writeReceipt(join(output, 'receipt.json'), receipt);
  log(`receipt: ${join(output, 'receipt.json')}`);
  if (receipt.run_status === 'error') { console.error(`error: ${(receipt.data as { harness_error: string }).harness_error}`); process.exit(3); }
  process.stdout.write(JSON.stringify((receipt.data as { summary: unknown }).summary, null, 2) + '\n');
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(3); });
}

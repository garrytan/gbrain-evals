/**
 * BEAM-500K "no evidence found" run (docs/benchmarks/2026-11-19-beam500k-no-evidence-line-preregistration.md): the
 * answer-type label (declined / hedged / committed) and the judge check for both judges.
 *
 *   bun eval/runner/beam-no-evidence.ts label --cells <cell dir>... --out <labels.ndjson> --paid --budget-run-id <id> [--budget-ledger <file>]
 *   bun eval/runner/beam-no-evidence.ts check-materialize --cell <B cell dir> --items <items.json> --out <dir>
 *   bun eval/runner/beam-no-evidence.ts check-report --items <items.json> --source <B cell id> --rubric <rejudge out dir> --type <labels.ndjson> --out <report.json>
 *
 * label      Every answered row of the given cells gets one label from the cross-family judge for its reader
 *            (typeJudgeFor): gpt-6-astra for Claude and particle-1 rows, claude-opus-5-5 for GPT rows. The prompt shows
 *            the question and the answer only. Paid: it refuses without --paid and an open --budget-run-id, and every
 *            request goes through the budget ledger. A row already in --out is skipped, so a rerun resumes.
 *            With --rows <file> --judges a,b the judge check's type items are labelled by each named judge instead.
 * check-*    The R78 check. items.json (kept off the repository: BEAM is CC BY-SA 4.0) lists construction items
 *            { id, qid, instrument: "rubric" | "type", text, label }. check-materialize writes two or more cell-shaped
 *            copies of the B cell, each scheduled over every rubric item's question and holding the item texts as
 *            answers (items on one question in different copies), for `bun run harness:cell rejudge` (BEAM's own
 *            judge through the strict scorer), and a rows file for label.
 *            check-report computes each judge's Cohen's kappa against the construction labels and the gates, and
 *            writes item hashes and counts only. Exit 3 when a gate fails.
 */
import './budget-ledger.ts';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { startPaidRun, budgetOptionsFrom } from './budget-ledger.ts';
import { requirePaidArm } from './paid-arm.ts';
import { ChatClient, sendsTemperature, type ChatLike } from './memory-qa/qa-v2.ts';
import { beamManifest, DATASET_ROOT } from './memory-qa/corpus.ts';

export const ANSWER_TYPE_PROMPT_ID = 'beam-answer-type-v1';
export const ANSWER_TYPES = ['declined', 'hedged', 'committed'] as const;
export type AnswerType = typeof ANSWER_TYPES[number];

const PROMPT = `You label one answer to a question about a long chat history. You see only the question and the answer.

Question:
{question}

Answer:
{answer}

Labels:
- declined: the answer says the history does not contain what was asked, or that it cannot tell, and gives no specific answer to the question.
- hedged: the answer gives a specific answer to the question and says it is unsure (for example "probably", "I think", "it may have been", "if I recall correctly").
- committed: the answer gives a specific answer to the question and does not say it is unsure.

An answer that gives a specific answer and also says it might be wrong is hedged. An answer that only asks for more information is declined.
Reply with exactly one final line: LABEL: declined, LABEL: hedged or LABEL: committed.`;

export const ANSWER_TYPE_PROMPT_SHA256 = createHash('sha256').update(PROMPT).digest('hex');

export function answerTypePrompt(question: string, answer: string): string {
  return PROMPT.replace('{question}', () => question).replace('{answer}', () => answer);
}

/** The last `LABEL: <type>` line of a reply, or null when there is none (an unparseable output). */
export function parseAnswerType(text: string): AnswerType | null {
  const all = [...text.matchAll(/^\s*\**LABEL:\**\s*(declined|hedged|committed)\s*\**\s*$/gim)];
  return all.length ? (all[all.length - 1][1].toLowerCase() as AnswerType) : null;
}

const FAMILY: Record<string, string> = { anthropic: 'anthropic', particle: 'particle', openai: 'openai' };

/** The answer-type judge for a reader, never of the reader's own family; particle-1 never judges. */
export function typeJudgeFor(reader: string): string {
  const [provider, model = ''] = reader.split(':');
  const family = model.startsWith('particle') ? 'particle' : FAMILY[provider];
  const judge = family === 'anthropic' || family === 'particle' ? 'openai:gpt-6-astra' : family === 'openai' ? 'anthropic:claude-opus-5-5' : null;
  if (!judge) throw new Error(`no answer-type judge is preregistered for reader ${reader}`);
  return judge;
}

export const RUBRIC_JUDGE = 'gemini:gemini-3.5-flash';
export const TYPE_JUDGES = ['anthropic:claude-opus-5-5', 'openai:gpt-6-astra'];

export interface Row { cell: string; qid: string; reader: string; question: string; answer: string }
export interface Label extends Row { judge: string; prompt_id: string; prompt_sha256: string; label: AnswerType | null; raw: string; finish: string | null; input_tokens: number; output_tokens: number }

const key = (cell: string, qid: string, judge: string) => `${cell}\u0000${qid}\u0000${judge}`;

/** Labels every row not already in `out`, appending one line per label; returns the labels written now. */
export async function labelRows(rows: Row[], chat: ChatLike, out: string, judges?: string[]): Promise<Label[]> {
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => { const x = JSON.parse(l) as Label; return key(x.cell, x.qid, x.judge); }) : []);
  const written: Label[] = [];
  for (const row of rows) {
    for (const judge of judges ?? [typeJudgeFor(row.reader)]) {
      if (judge.startsWith('particle:') || judge.includes(':particle')) throw new Error('particle-1 never judges');
      if (row.reader !== 'construction' && judge !== typeJudgeFor(row.reader)) throw new Error(`${judge} is not the preregistered answer-type judge for ${row.reader}`);
      if (done.has(key(row.cell, row.qid, judge))) continue;
      const res = await chat.chat(judge, answerTypePrompt(row.question, row.answer), { maxTokens: 4000, replicate: 0, temperature: sendsTemperature(judge) ? 0 : null });
      const label: Label = { ...row, judge, prompt_id: ANSWER_TYPE_PROMPT_ID, prompt_sha256: ANSWER_TYPE_PROMPT_SHA256, label: parseAnswerType(res.text),
        raw: res.text, finish: res.finish, input_tokens: res.input_tokens, output_tokens: res.output_tokens };
      appendFileSync(out, JSON.stringify(label) + '\n');
      written.push(label);
    }
  }
  return written;
}

/** BEAM question text by harness query id (`<conversation number>_<ability>_<index>`), from the pinned dataset files. */
export function beamQuestions(size = '500k', root = DATASET_ROOT): Map<string, string> {
  const m = beamManifest() as unknown as { sizes: Record<string, Array<{ conversation: string; questions_path: string; questions_sha256: string }>> };
  const out = new Map<string, string>();
  for (const c of m.sizes[size]) {
    const path = join(root, 'beam', c.questions_path);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== c.questions_sha256) throw new Error(`${path}: SHA-256 differs from the pinned manifest`);
    const n = c.conversation.split('-')[1];
    for (const [ability, items] of Object.entries(JSON.parse(bytes.toString('utf8')) as Record<string, Array<{ question: string }>>))
      items.forEach((it, i) => out.set(`${n}_${ability}_${i}`, it.question));
  }
  return out;
}

/** Answered rows of a cell directory (stages/answer/*.json), with their reader and question. */
export function cellRows(dir: string, questions: Map<string, string>): Row[] {
  const cell = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8')) as { cell_id: string; spec: { models: { answer: string } } };
  const stage = join(dir, 'stages', 'answer');
  return readdirSync(stage).filter(f => f.endsWith('.json')).sort().flatMap(f => {
    const a = JSON.parse(readFileSync(join(stage, f), 'utf8')) as { query_id: string; outcome: string; answer?: string; answer_model?: string };
    if (a.outcome !== 'answered') return [];
    const question = questions.get(a.query_id);
    if (question === undefined) throw new Error(`${dir}: no question text for ${a.query_id}`);
    return [{ cell: cell.cell_id, qid: a.query_id, reader: a.answer_model ?? cell.spec.models.answer, question, answer: a.answer ?? '' }];
  });
}

/** The judge check's type items as rows (check-materialize's rows file); --judges picks the judges. */
export function itemRows(items: Array<{ item: string; qid: string; answer: string }>, questions: Map<string, string>): Row[] {
  return items.map(i => {
    const question = questions.get(i.qid);
    if (question === undefined) throw new Error(`item ${i.item}: no question text for ${i.qid}`);
    return { cell: `judge-check:${i.item}`, qid: i.qid, reader: 'construction', question, answer: i.answer };
  });
}

/** Cohen's kappa of two equal-length label lists. */
export function cohenKappa<T>(a: T[], b: T[]): number {
  if (a.length !== b.length || !a.length) throw new Error('kappa needs two non-empty lists of the same length');
  const n = a.length;
  const classes = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = classes.reduce((s, c) => s + (a.filter(x => x === c).length / n) * (b.filter(x => x === c).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export interface Item { id: string; qid: string; instrument: 'rubric' | 'type'; text: string; label: string }
export interface Gate { judge: string; gate: string; value: number; pass: boolean }

/**
 * One judge's gates against the construction labels: kappa at least 0.6 (the type judges also on declined against not
 * declined), at least `minPerClass` graded items in every class, and at most 1% unparseable outputs.
 */
export function judgeGates(judge: string, items: Item[], grades: Map<string, string | null>, minPerClass: number, binary?: (l: string) => string): Gate[] {
  const graded = items.filter(i => grades.get(i.id) != null);
  const unparseable = items.filter(i => grades.has(i.id) && grades.get(i.id) == null).length;
  const ungraded = items.filter(i => !grades.has(i.id)).length;
  const gates: Gate[] = [
    { judge, gate: 'kappa >= 0.6', value: graded.length ? cohenKappa(graded.map(i => i.label), graded.map(i => grades.get(i.id)!)) : NaN, pass: false },
    { judge, gate: 'unparseable <= 1%', value: items.length ? unparseable / items.length : 1, pass: false },
    { judge, gate: 'every item graded', value: ungraded, pass: ungraded === 0 },
    ...[...new Set(items.map(i => i.label))].sort().map(c => ({ judge, gate: `graded in class ${c} >= ${minPerClass}`, value: graded.filter(i => i.label === c).length, pass: false })),
  ];
  for (const g of gates) {
    if (g.gate === 'kappa >= 0.6') g.pass = g.value >= 0.6;
    else if (g.gate === 'unparseable <= 1%') g.pass = g.value <= 0.01;
    else if (g.gate.startsWith('graded in class')) g.pass = g.value >= minPerClass;
  }
  if (binary) gates.push({ judge, gate: 'kappa (declined vs not) >= 0.6', value: graded.length ? cohenKappa(graded.map(i => binary(i.label)), graded.map(i => binary(grades.get(i.id)!))) : NaN, pass: false });
  for (const g of gates) if (g.gate.startsWith('kappa (declined')) g.pass = g.value >= 0.6;
  return gates;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function readItems(path: string): Item[] {
  const items = JSON.parse(readFileSync(path, 'utf8')) as Item[];
  for (const i of items) {
    const ok = i.instrument === 'rubric' ? ['good', 'bad'].includes(i.label) : (ANSWER_TYPES as readonly string[]).includes(i.label);
    if (!i.id || !i.qid || !i.text || !ok) throw new Error(`item ${i.id ?? '?'}: needs id, qid, text and a label of its instrument`);
  }
  if (new Set(items.map(i => i.id)).size !== items.length) throw new Error('item ids repeat');
  return items;
}

/**
 * Which items cell each rubric item goes in: items on the same question go in different cells, every cell shares one
 * schedule (all rubric questions), and there are at least two cells, because mpw.rejudge judges two or more cells jointly
 * and only the answers each cell holds.
 */
export function rubricCells(items: Item[]): Map<string, number> {
  const byQuestion = new Map<string, Item[]>();
  for (const i of items.filter(x => x.instrument === 'rubric').sort((a, b) => a.id.localeCompare(b.id))) byQuestion.set(i.qid, [...(byQuestion.get(i.qid) ?? []), i]);
  const n = Math.max(2, ...[...byQuestion.values()].map(g => g.length));
  const at = new Map<string, number>();
  [...byQuestion.keys()].sort().forEach((qid, q) => byQuestion.get(qid)!.forEach((i, k) => at.set(i.id, (q + k) % n)));
  return at;
}

/** mpw/records.py safe_name: the file name a harness record for this id is stored under. */
export function safeName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, '_');
  return safe === id && safe.length <= 180 ? safe : `${safe.slice(0, 160)}-${sha(id).slice(0, 12)}`;
}

export const itemsCellId = (source: string, n: number) => `${source}-judge-check-${n}`;

export function materialize(cellDir: string, items: Item[], out: string): { cells: string[]; rows: string } {
  const cell = JSON.parse(readFileSync(join(cellDir, 'cell.json'), 'utf8'));
  const rubric = items.filter(i => i.instrument === 'rubric');
  const at = rubricCells(items);
  const schedule = [...new Set(rubric.map(i => i.qid))].sort();
  const n = Math.max(2, ...[...at.values()].map(c => c + 1));
  const cells: string[] = [];
  for (let c = 0; c < n; c++) {
    const id = itemsCellId(cell.cell_id, c);
    const dir = join(out, id);
    const mine = rubric.filter(i => at.get(i.id) === c);
    mkdirSync(join(dir, 'stages', 'answer'), { recursive: true });
    writeFileSync(join(dir, 'cell.json'), JSON.stringify({ ...cell, cell_id: id, resolved: { ...cell.resolved, schedule },
      judge_check: { source_cell: cell.cell_id, items: mine.map(i => ({ id: i.id, qid: i.qid, text_sha256: sha(i.text) })) } }, null, 2) + '\n');
    for (const i of mine) writeFileSync(join(dir, 'stages', 'answer', `${safeName(i.qid)}.json`), JSON.stringify({ cell_id: id, query_id: i.qid, ok: true, outcome: 'answered', answer: i.text, answer_model: 'construction' }) + '\n');
    cells.push(dir);
  }
  const rows = join(out, 'type-items.rows.json');
  writeFileSync(rows, JSON.stringify(items.filter(i => i.instrument === 'type').map(i => ({ item: i.id, qid: i.qid, answer: i.text }))) + '\n');
  return { cells, rows };
}

/** The R78 gates. `rejudgeOut` is mpw.rejudge's --out, holding <items cell id>/stages/judge/<qid>.json. */
export function checkReport(items: Item[], source: string, rejudgeOut: string, typeLabels: Label[]) {
  const rubric = items.filter(i => i.instrument === 'rubric');
  const type = items.filter(i => i.instrument === 'type');
  const at = rubricCells(items);
  const rubricGrades = new Map<string, string | null>();
  const rubricJudges = new Set<string>();
  for (const i of rubric) {
    const p = join(rejudgeOut, itemsCellId(source, at.get(i.id)!), 'stages', 'judge', `${safeName(i.qid)}.json`);
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8')) as { correct?: boolean; outcome?: string; judge_model?: string };
    if (j.judge_model) rubricJudges.add(j.judge_model);
    rubricGrades.set(i.id, typeof j.correct === 'boolean' && j.outcome !== 'judge_failure' ? (j.correct ? 'good' : 'bad') : null);
  }
  const gates: Gate[] = [
    { judge: 'rubric', gate: `rubric judge is ${RUBRIC_JUDGE}`, value: rubricJudges.size, pass: rubricJudges.size === 1 && rubricJudges.has(RUBRIC_JUDGE) },
    ...judgeGates(RUBRIC_JUDGE, rubric, rubricGrades, 15),
  ];
  const judges = [...new Set(typeLabels.map(l => l.judge))].sort();
  gates.push({ judge: 'type', gate: `type judges are ${TYPE_JUDGES.join(' and ')}`, value: judges.length, pass: JSON.stringify(judges) === JSON.stringify([...TYPE_JUDGES].sort()) });
  const perJudge = new Map<string, Map<string, string | null>>();
  for (const judge of TYPE_JUDGES) {
    const g = new Map<string, string | null>();
    for (const l of typeLabels.filter(x => x.judge === judge && x.cell.startsWith('judge-check:'))) g.set(l.cell.slice('judge-check:'.length), l.label);
    perJudge.set(judge, g);
    gates.push(...judgeGates(judge, type, g, 12, l => (l === 'declined' ? 'declined' : 'not declined')));
  }
  const [a, b] = TYPE_JUDGES.map(j => perJudge.get(j)!);
  const both = type.filter(i => a.get(i.id) != null && b.get(i.id) != null);
  const agreement = both.length ? { [`${TYPE_JUDGES[0]} vs ${TYPE_JUDGES[1]}`]: cohenKappa(both.map(i => a.get(i.id)!), both.map(i => b.get(i.id)!)) } : {};
  return { prompt_id: ANSWER_TYPE_PROMPT_ID, prompt_sha256: ANSWER_TYPE_PROMPT_SHA256,
    items: items.map(i => ({ id: i.id, instrument: i.instrument, label: i.label, text_sha256: sha(i.text) })), gates, agreement, pass: gates.every(g => g.pass) };
}

function flag(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === name) for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]); });
  return out;
}

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === 'label') {
    const out = flag(argv, '--out');
    const cells = flags(argv, '--cells');
    const rowsFile = flag(argv, '--rows');
    const judges = flag(argv, '--judges')?.split(',');
    if (!out || (!cells.length && !rowsFile) || (rowsFile && !judges) || (judges && !rowsFile)) { console.error('label needs --out <labels.ndjson> and --cells <dir>..., or --rows <items rows> with --judges a,b (--judges only with --rows)'); process.exit(2); }
    try { requirePaidArm(argv, { arm: 'beam-no-evidence answer-type labels', estimateUsd: null }); }
    catch (e) { console.error((e as Error).message); process.exit(2); }
    const questions = beamQuestions();
    const rows = rowsFile ? itemRows(JSON.parse(readFileSync(resolve(rowsFile), 'utf8')), questions) : cells.flatMap(d => cellRows(resolve(d), questions));
    const paid = startPaidRun('beam-no-evidence:label', { ...budgetOptionsFrom(argv), estimateUsd: null });
    try {
      const written = await labelRows(rows, new ChatClient(join(resolve(out), '..', 'label-cache')), resolve(out), judges);
      console.log(JSON.stringify({ rows: rows.length, labelled_now: written.length, unparseable_now: written.filter(w => w.label === null).length }));
    } finally { paid.run.close(); }
  } else if (cmd === 'check-materialize') {
    const [cell, items, out] = ['--cell', '--items', '--out'].map(f => flag(argv, f));
    if (!cell || !items || !out) { console.error('check-materialize needs --cell, --items and --out'); process.exit(2); }
    console.log(JSON.stringify(materialize(resolve(cell), readItems(resolve(items)), resolve(out))));
  } else if (cmd === 'check-report') {
    const [items, source, rubric, type, out] = ['--items', '--source', '--rubric', '--type', '--out'].map(f => flag(argv, f));
    if (!items || !source || !rubric || !type || !out) { console.error('check-report needs --items, --source <B cell id>, --rubric <rejudge --out dir>, --type and --out'); process.exit(2); }
    const labels = readFileSync(resolve(type), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Label);
    const report = checkReport(readItems(resolve(items)), source, resolve(rubric), labels);
    writeFileSync(resolve(out), JSON.stringify(report, null, 2) + '\n');
    console.log(report.gates.map(g => `${g.judge} ${g.gate} ${Number.isFinite(g.value) ? +g.value.toFixed(3) : g.value} ${g.pass ? 'pass' : 'FAIL'}`).join('\n'));
    if (!report.pass) { console.error('JUDGE_CHECK_STOP: a gate failed; the endpoints that judge labels are descriptive'); process.exit(3); }
  } else {
    console.error('usage: bun eval/runner/beam-no-evidence.ts label|check-materialize|check-report (see the header)');
    process.exit(2);
  }
}

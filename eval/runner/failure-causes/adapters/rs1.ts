/**
 * RS1 stage 1 cells (eval/runner/q1/cell.ts output on public BEAM-1M dev
 * conversations). A row fails when its gating frontier judge scores it below
 * 1: GPT-6.1 Sol judges Claude readers and Opus 5.5 judges GPT readers, as the
 * RS1 preregistration gates. Gold coverage comes from the row's recall at 10
 * (tag measured_at_10). Delivered coverage is known only when nothing was
 * packed out and every offered item is in that top 10; otherwise ranking is
 * unmeasured.
 */
import { fileText, ndjson, pointer, type LoadedFile, type SourceEntry } from '../manifest.ts';
import type { Tag } from '../taxonomy.ts';
import { EVAL_FAILURE_SCHEMA, type ArmRole, type Coverage, type EvalFailure, type FailureText } from '../types.ts';
import { emptyCounts, skip, type AdapterOutput } from './shared.ts';

type Rec = Record<string, any>;

export const RS1_GATING_JUDGE: Record<string, string> = { anthropic: 'openai:gpt-6.1-sol', openai: 'anthropic:claude-opus-5-5' };

export function rs1ArmRole(cell: string, entry: SourceEntry): ArmRole {
  const named = Object.entries(entry.arm_roles ?? {}).find(([k]) => cell.includes(k));
  if (named) return named[1];
  if (/gbrain/.test(cell)) return 'gbrain_default';
  if (/baseline-none/.test(cell)) return 'control';
  return 'other_system';
}

function coverage(row: Rec): Coverage | null {
  if (typeof row.recall_any_at_10 !== 'number') return null;
  if (row.recall_any_at_10 <= 0) return 'none';
  return typeof row.recall_all_at_10 === 'number' && row.recall_all_at_10 >= 1 ? 'all' : 'partial';
}

export function fromRs1(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts = emptyCounts();
  const failures: EvalFailure[] = [];
  const rowsFile = files.find(f => f.role === 'rows');
  const answersFile = files.find(f => f.role === 'answers');
  const judgmentsFile = files.find(f => f.role === 'judgments');
  if (!rowsFile || !answersFile || !judgmentsFile) throw new Error(`${entry.id}: an rs1 source needs rows, answers and judgments files`);
  const rows = new Map(ndjson(rowsFile).map(r => [r.id as string, r]));
  const judgments = new Map<string, Rec[]>();
  for (const j of ndjson(judgmentsFile)) judgments.set(`${j.answer_id}|${j.judge}`, [...(judgments.get(`${j.answer_id}|${j.judge}`) ?? []), j]);
  const gold = new Map<string, Rec>();
  for (const g of files.filter(f => f.role === 'gold')) {
    const conversation = g.path.match(/(\d+[mk]-\d+)-probing_questions\.json$/)?.[1];
    if (!conversation) throw new Error(`${pointer(g)}: a gold file is named <conversation>-probing_questions.json`);
    for (const [category, qs] of Object.entries(JSON.parse(fileText(g)) as Record<string, Rec[]>)) qs.forEach((q, i) => gold.set(`${conversation}:${category}:${i}`, q));
  }
  const contexts = new Map<string, string>();
  for (const c of files.filter(f => f.role === 'contexts')) for (const x of ndjson(c)) contexts.set(x.meta?.context_sha256 ?? x.key, x.prompt);
  const seen = new Set<string>();
  for (const a of ndjson(answersFile)) {
    counts.read++;
    const key = `${a.cell_id}|${a.question_id}|${a.reader}|r${a.replicate}`;
    if (seen.has(key)) { counts.duplicate++; continue; }
    seen.add(key);
    if (entry.models && !entry.models.includes(a.reader)) { skip(counts, 'model not counted from this source'); continue; }
    const provider = String(a.reader).split(':')[0];
    const judge = RS1_GATING_JUDGE[provider];
    const js = judge ? judgments.get(`${a.answer_id}|${judge}`) ?? [] : [];
    if (!js.length) { skip(counts, 'no gating judgment'); continue; }
    const row = rows.get(a.question_id);
    if (!row) { skip(counts, 'no row for the question'); continue; }
    counts.mapped++;
    const scores = js.map(j => j.score).filter((s): s is number => typeof s === 'number');
    const harnessError = a.outcome !== 'scored' ? `answer outcome ${a.outcome}` : row.outcome !== 'scored' ? `row outcome ${row.outcome}`
      : js.some(j => j.parse_ok === false || j.outcome !== 'scored') ? 'judgment did not parse' : scores.length ? null : 'no numeric judge score';
    const score = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;
    if (!harnessError && score !== null && score >= 1) continue;
    counts.failed++;
    const retrieved = row.gold_count === 0 ? null : coverage(row);
    const packed = row.packing_loss;
    const delivered = retrieved !== null && packed && packed.items_dropped === 0 && packed.items_cut === 0 && packed.items_offered <= 10 ? retrieved : null;
    const tags: Tag[] = ['measured_at_10'];
    if (score === 0) tags.push('score_zero');
    const q = gold.get(a.question_id);
    const text: FailureText | undefined = q && (entry.visibility === 'public' || entry.visibility === 'synthetic')
      ? { question: String(q.question ?? ''), expected: q.answer ?? q.ideal_response ?? q.ideal_answer ?? null, answer: String(a.text ?? ''), context: contexts.get(a.context_sha256) ?? null }
      : undefined;
    failures.push({
      schema: EVAL_FAILURE_SCHEMA, source: entry.id, run_id: String(a.realization_id ?? a.cell_id), case_id: key,
      system: String(a.system ?? a.cell_id), arm: String(a.cell_id), arm_role: rs1ArmRole(String(a.cell_id), entry),
      condition: entry.condition, visibility: entry.visibility, model: a.reader, gbrain_sha: entry.gbrain_sha ?? null,
      failed: true, score, category: row.category ?? null, agent_loop: false, stop: null, finish_reason: null,
      harness: harnessError ? { error: harnessError, scorer_artifact: null } : null, operation: null, tool_calls: null,
      gold: { gold_count: typeof row.gold_count === 'number' ? row.gold_count : null, stored: null, hidden: null, retrieved, delivered, opened: null, summary_only: null },
      writes: null, tags, evidence: [pointer(answersFile, `answer=${String(a.answer_id).slice(0, 12)}`), pointer(rowsFile, `question=${a.question_id}`)],
      ...(text ? { text } : {}),
    });
  }
  return { failures, stress: [], counts };
}

/**
 * Cat 40 (model ladder and Hard) cell rows. Two shapes exist: cat40-cell-v2
 * rows (sessions[], a cell-level stop) and the unversioned v1 rows (one run,
 * whose stop sits on run.stop). Any other shape is refused. results.jsonl
 * holds one canonical row per key; a key seen twice counts as a duplicate.
 * With the committed transcripts file, gold coverage is read from it: a gold
 * slug is retrieved when a tool result names it as a whole slug (not as the
 * start of a longer one) and opened when a read tool was called on it. A v1 row
 * of a family F task keeps its first session's calls (session1) before the
 * second's. A tool error counts as recovered only when a later call to the same
 * tool on the same target succeeded; the target comes from the transcript's
 * arguments, so without a transcript that lines up call for call, recovery is
 * unknown.
 *
 * Each directory is one arm run: its results, transcripts and experiment.json
 * (role experiment, whose gbrain_commit is the row's gbrain sha) go together,
 * so two worlds that reuse cell keys and attempt ids stay apart. A key counts
 * once per budget run.
 */
import { dirname } from 'node:path';
import { fileText, ndjson, pointer, type LoadedFile, type SourceEntry } from '../manifest.ts';
import type { Tag } from '../taxonomy.ts';
import { EVAL_FAILURE_SCHEMA, type ArmRole, type Coverage, type EvalFailure, type ToolCall } from '../types.ts';
import { emptyCounts, skip, type AdapterOutput } from './shared.ts';

type Rec = Record<string, any>;

export const CAT40_DEFAULT_MODELS = ['claude-opus-5-5', 'gpt-6.1-sol'];
const READ_TOOLS = new Set(['get_page', 'get_pages', 'read_file', 'read_page', 'get_chunks']);
const SUBMIT_TOOL = /^submit/;

export function cat40ArmRole(arm: string, entry: SourceEntry): ArmRole {
  const named = entry.arm_roles?.[arm];
  if (named) return named;
  if (arm === 'oracle') return 'oracle';
  if (!arm.startsWith('gbrain')) return 'other_system';
  return /^gbrain$|baseline|control|master|-base$|^gbrain-base|^gbrain-hard$/.test(arm) ? 'gbrain_default' : 'gbrain_variant';
}

/** The fields this adapter reads, from either row shape; null for a shape it does not know. */
export function cat40Fields(row: Rec): { stop: string | null; calls: Rec[]; final: string | null } | null {
  if (!row || typeof row.key !== 'string' || !row.score || typeof row.score !== 'object') return null;
  if (row.schema === 'cat40-cell-v2') {
    if (!Array.isArray(row.sessions)) return null;
    const last = row.sessions.at(-1);
    return { stop: row.stop ?? null, calls: row.sessions.flatMap((s: Rec) => s.run?.tool_calls ?? []), final: last?.run?.final ?? null };
  }
  if (row.schema !== undefined || !row.run || typeof row.run !== 'object') return null;
  return { stop: row.stop ?? row.run.stop ?? null, calls: [...(row.session1?.tool_calls ?? []), ...(row.run.tool_calls ?? [])], final: row.run.final ?? null };
}

const cover = (hit: number, of: number): Coverage => (hit === 0 ? 'none' : hit === of ? 'all' : 'partial');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** text names slug as a whole slug: not inside a longer slug such as people/alice-smith for people/alice. */
export const namesSlug = (text: string, slug: string) => new RegExp(`(^|[^\\w/.-])${escape(slug)}(?![\\w/-])`).test(text);
/** The thing a call acted on, for matching a retry to the call that failed. */
const target = (args: Rec | undefined) => JSON.stringify(args?.slug ?? args?.slugs ?? args?.path ?? args?.id ?? args?.page ?? args ?? null);

/** Per call (submit calls dropped): its error, and whether a later call to the same tool on the same target succeeded. */
export function cat40Calls(calls: Rec[], tools: Rec[] | undefined): ToolCall[] {
  const args = tools && tools.length === calls.length ? tools.map(t => t.args as Rec | undefined) : null;
  const kept = calls.map((c, i) => ({ c, target: args ? target(args[i]) : null })).filter(x => !SUBMIT_TOOL.test(x.c.name));
  return kept.map(({ c, target: t }, i) => {
    const error = typeof c.error === 'string' && c.error ? c.error : null;
    const recovered = error === null ? null : t === null ? null : kept.slice(i + 1).some(d => d.c.name === c.name && d.target === t && !d.c.error);
    return { name: c.name, error, recovered, ms: c.ms ?? null, memory: true };
  });
}

export function fromCat40(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts = emptyCounts();
  const failures: EvalFailure[] = [];
  const dirs = new Map<string, { transcripts: Map<string, Rec[]>; sha: string | null }>();
  const dirOf = (f: LoadedFile) => {
    if (!dirs.has(dirname(f.path))) dirs.set(dirname(f.path), { transcripts: new Map(), sha: null });
    return dirs.get(dirname(f.path))!;
  };
  for (const t of files.filter(f => f.role === 'transcripts')) for (const x of ndjson(t)) dirOf(t).transcripts.set(x.attempt_id ?? x.key, x.tools ?? []);
  for (const e of files.filter(f => f.role === 'experiment')) dirOf(e).sha = JSON.parse(fileText(e)).gbrain_commit ?? null;
  const models = entry.models ?? CAT40_DEFAULT_MODELS;
  const seen = new Set<string>();
  for (const f of files.filter(x => x.role === 'results')) {
    const dir = dirOf(f);
    for (const row of ndjson(f)) {
      counts.read++;
      const fields = cat40Fields(row);
      if (!fields) throw new Error(`${pointer(f)}: unknown Cat 40 row shape (key ${String(row?.key)})`);
      const runId = String(row.budget_run_id ?? (typeof row.experiment === 'string' ? row.experiment : entry.id));
      if (seen.has(`${runId}|${row.key}`)) { counts.duplicate++; continue; }
      seen.add(`${runId}|${row.key}`);
      if (!models.includes(row.model)) { skip(counts, 'model not under test'); continue; }
      counts.mapped++;
      const s: Rec = row.score;
      if (s.success === true) continue;
      counts.failed++;
      const tools = dir.transcripts.get(row.attempt_id ?? row.key);
      const calls = cat40Calls(fields.calls, tools);
      const goldSlugs = [...new Set<string>([...(s.evidence_cited ?? []), ...(s.missed_evidence ?? [])])];
      let retrieved: Coverage | null = null;
      let opened: Coverage | null = null;
      if (tools && goldSlugs.length) {
        const results = tools.map(t => String(t.result ?? '')).join('\n');
        const readArgs = tools.filter(t => READ_TOOLS.has(t.name)).map(t => JSON.stringify(t.args ?? {})).join('\n');
        retrieved = cover(goldSlugs.filter(g => namesSlug(results, g)).length, goldSlugs.length);
        opened = cover(goldSlugs.filter(g => namesSlug(readArgs, g)).length, goldSlugs.length);
      }
      const tags: Tag[] = [];
      if (s.said_wrong) tags.push('said_wrong');
      if (s.unparseable_set) tags.push('unparseable_answer');
      if (Array.isArray(s.recorded) && s.recorded.includes(false)) tags.push('record_session_not_recorded');
      failures.push({
        schema: EVAL_FAILURE_SCHEMA, source: entry.id, run_id: runId, case_id: row.key,
        system: row.arm.startsWith('gbrain') ? 'gbrain' : row.arm, arm: row.arm, arm_role: cat40ArmRole(row.arm, entry),
        condition: entry.condition, visibility: entry.visibility, model: `${row.provider ?? 'unknown'}:${row.model}`, gbrain_sha: dir.sha ?? entry.gbrain_sha ?? null,
        failed: true, score: null, category: row.family ?? null, agent_loop: true, stop: fields.stop, finish_reason: null,
        harness: null, operation: null, tool_calls: calls,
        gold: { gold_count: goldSlugs.length || null, stored: null, hidden: null, retrieved, delivered: retrieved, opened, summary_only: null },
        writes: null, tags, evidence: [pointer(f, `key=${row.key}`)],
      });
    }
  }
  return { failures, stress: [], counts };
}

/**
 * Cat 40 (model ladder and Hard) cell rows. Two shapes exist: cat40-cell-v2
 * rows (sessions[], a cell-level stop) and the unversioned v1 rows (one run,
 * whose stop sits on run.stop). Any other shape is refused. results.jsonl
 * holds one canonical row per key; a key seen twice counts as a duplicate.
 * With the committed transcripts file, gold coverage is read from it: a gold
 * slug is retrieved when any tool result names it and opened when a read tool
 * was called on it.
 */
import { ndjson, pointer, type LoadedFile, type SourceEntry } from '../manifest.ts';
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
  return { stop: row.stop ?? row.run.stop ?? null, calls: row.run.tool_calls ?? [], final: row.run.final ?? null };
}

const cover = (hit: number, of: number): Coverage => (hit === 0 ? 'none' : hit === of ? 'all' : 'partial');

export function fromCat40(files: LoadedFile[], entry: SourceEntry): AdapterOutput {
  const counts = emptyCounts();
  const failures: EvalFailure[] = [];
  const transcripts = new Map<string, Rec[]>();
  for (const t of files.filter(f => f.role === 'transcripts')) for (const x of ndjson(t)) transcripts.set(x.attempt_id ?? x.key, x.tools ?? []);
  const models = entry.models ?? CAT40_DEFAULT_MODELS;
  const seen = new Set<string>();
  for (const f of files.filter(x => x.role === 'results')) {
    for (const row of ndjson(f)) {
      counts.read++;
      const fields = cat40Fields(row);
      if (!fields) throw new Error(`${pointer(f)}: unknown Cat 40 row shape (key ${String(row?.key)})`);
      if (seen.has(row.key)) { counts.duplicate++; continue; }
      seen.add(row.key);
      if (!models.includes(row.model)) { skip(counts, 'model not under test'); continue; }
      counts.mapped++;
      const s: Rec = row.score;
      if (s.success === true) continue;
      counts.failed++;
      const calls: ToolCall[] = fields.calls.filter(c => !SUBMIT_TOOL.test(c.name)).map((c, i, all) => {
        const error = typeof c.error === 'string' && c.error ? c.error : null;
        return { name: c.name, error, recovered: error === null ? null : all.slice(i + 1).some(d => d.name === c.name && !d.error), ms: c.ms ?? null, memory: true };
      });
      const goldSlugs = [...new Set<string>([...(s.evidence_cited ?? []), ...(s.missed_evidence ?? [])])];
      const tools = transcripts.get(row.attempt_id ?? row.key);
      let retrieved: Coverage | null = null;
      let opened: Coverage | null = null;
      if (tools && goldSlugs.length) {
        const results = tools.map(t => String(t.result ?? '')).join('\n');
        const readArgs = tools.filter(t => READ_TOOLS.has(t.name)).map(t => JSON.stringify(t.args ?? {})).join('\n');
        retrieved = cover(goldSlugs.filter(g => results.includes(g)).length, goldSlugs.length);
        opened = cover(goldSlugs.filter(g => readArgs.includes(g)).length, goldSlugs.length);
      }
      const tags: Tag[] = [];
      if (s.said_wrong) tags.push('said_wrong');
      if (s.unparseable_set) tags.push('unparseable_answer');
      if (Array.isArray(s.recorded) && s.recorded.includes(false)) tags.push('record_session_not_recorded');
      failures.push({
        schema: EVAL_FAILURE_SCHEMA, source: entry.id, run_id: String(row.budget_run_id ?? row.experiment ?? entry.id), case_id: row.key,
        system: row.arm.startsWith('gbrain') ? 'gbrain' : row.arm, arm: row.arm, arm_role: cat40ArmRole(row.arm, entry),
        condition: entry.condition, visibility: entry.visibility, model: `${row.provider ?? 'unknown'}:${row.model}`, gbrain_sha: entry.gbrain_sha ?? null,
        failed: true, score: null, category: row.family ?? null, agent_loop: true, stop: fields.stop, finish_reason: null,
        harness: null, operation: null, tool_calls: calls,
        gold: { gold_count: goldSlugs.length || null, stored: null, hidden: null, retrieved, delivered: retrieved, opened, summary_only: null },
        writes: null, tags, evidence: [pointer(f, `key=${row.key}`)],
      });
    }
  }
  return { failures, stress: [], counts };
}

/**
 * G3 scoring: write landing and call contract (GBEV-55, gap rank 3).
 *
 * - classifyCall reads one gbrain call (CLI or MCP) and names the contract cause it ran into, from gbrain's own error
 *   code, detail and message. At 0.60.557.0 a remember to a page whose file holds a committed change gbrain has not
 *   imported is refused with code scope_denied and detail pending_import; that is counted as source_changed, the
 *   cause Wintermute counted. An uncommitted file and database drift is refused with code scope_denied, detail
 *   file_database_drift and write_error source_changed (the CLI prints it as Error [source_changed]); it is the
 *   host-only refusal the scope_denied tasks stage, so it counts as scope_denied. A sources call without --brain is never refused by gbrain on a one-brain machine, so it is classified
 *   from the argv.
 * - landingLedger compares two snapshots of the brain and counts writes and pages: a new fact is one write, a new or
 *   changed page is one write and one page. It never matches tokens in Git HEAD. Page bodies are compared without
 *   frontmatter (so a derived title is no change), without a leading "# <title>" H1, and without gbrain's facts fence
 *   (so a remember is one write, not a fact plus a page edit). That is GBRA-395's ruling: an untitled capture is one
 *   write and one page.
 * - scoreWriteEpisode checks the final answer's claimed writes against the ledger and names the episode's cause.
 * - summarizeWriteEpisodes gives the scorecard: refusals per 100 calls by cause, per-cause refusal and recovery rates
 *   given exposure (D1), refusals never retried, "reported done, not landed", pass^k and cost per correct answer.
 * - schemaShapes and runSchemaGrammar are the keyless schema-shape grammar: argument shapes derived from gbrain's served
 *   MCP schemas plus the eight cause shapes, dispatched through the server and through gbrain call, so two pins can be
 *   compared at zero model cost.
 */
import type { ToolSpec } from '../cat40/loop.ts';
import type { CauseId } from './causes.ts';
import { costPerCorrect, passHatCurve, passHatK, type TaskTrials } from './passk.ts';
import type { ArmCall, BrainSnapshot } from './cli-arm.ts';
import { G3_CAUSES, PENDING_OK, type G3Cause, type G3Surface, type WriteTask } from '../../generators/write-contract-gen.ts';

export const G3_K = 4;

export const WRITE_SUBMIT_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Submit your final report of the writes you made. Call this exactly once, when you are done.',
  input_schema: {
    type: 'object',
    properties: {
      writes: {
        type: 'array',
        description: 'Every write you attempted for this request.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['fact', 'page'] },
            path: { type: 'string', description: 'The entity slug a fact was saved on, or the page slug written.' },
            id: { type: 'string', description: 'The fact id or page revision gbrain returned, if any.' },
            status: { type: 'string', enum: ['landed', 'pending', 'refused'], description: 'landed only when gbrain confirmed the write.' },
          },
          required: ['kind', 'path', 'status'],
        },
      },
      notes: { type: 'string', description: 'Optional brief explanation.' },
    },
    required: ['writes'],
  },
};

export interface ClaimedWrite { kind: 'fact' | 'page'; path: string; id?: string; status: 'landed' | 'pending' | 'refused' }

export interface CallClass { refused: boolean; cause: G3Cause | 'other' | null; code: string | null; family: string }

const MCP_FAMILY: Record<string, string> = { remember: 'remember', put_page: 'put', put_pages: 'put', edit_page: 'put', append_page: 'put', get_page: 'get', sources_list: 'sources', sync_brain: 'sync', recall: 'recall' };

export function opFamily(call: Pick<ArmCall, 'surface' | 'argv'>): string {
  const head = call.argv[0] ?? '';
  if (call.surface === 'mcp') return MCP_FAMILY[head] ?? head;
  return head === 'git' ? `git ${call.argv[1] ?? ''}`.trim() : head;
}

function errorCode(output: string): string | null {
  return /Error \[([a-z_]+)\]/.exec(output)?.[1] ?? /"code":\s*"([a-z_]+)"/.exec(output)?.[1] ?? /"error":\s*"([a-z_]+)"/.exec(output)?.[1] ?? null;
}

/** The contract cause one gbrain call ran into, or null when it went through cleanly. */
export function classifyCall(call: ArmCall): CallClass {
  const family = opFamily(call);
  const out = call.output;
  const code = errorCode(out);
  const isHelp = call.argv.includes('--help');
  if (call.surface === 'cli' && family === 'sources' && !isHelp && !call.argv.includes('--brain') && !call.argv.some(a => a.startsWith('--brain='))) {
    return { refused: true, cause: 'sources_without_brain', code, family };
  }
  if (/--lines overwrites the positional value/.test(out) || /one window selector, not \d/.test(out)) return { refused: true, cause: 'two_range_read', code, family };
  const refused = code !== null || (call.exit !== null && call.exit !== 0);
  if (!refused) return { refused: false, cause: null, code: null, family };
  const cause: CallClass['cause'] =
    /"detail":\s*"pending_import"/.test(out) ? 'source_changed'
    : /"detail":\s*"file_database_drift"/.test(out) ? 'scope_denied'
    : code === 'source_changed' ? 'source_changed'
    : /matches more than one page/.test(out) ? 'ambiguous_entity'
    : /Missing required parameter: provenance/.test(out) || code === 'provenance_required' ? 'missing_provenance'
    : /either fact or items, not both/.test(out) ? 'fact_and_items'
    : code === 'commit_paths_invalid' ? 'commit_paths_invalid'
    : code === 'scope_denied' || code === 'permission_denied' ? 'scope_denied'
    : 'other';
  return { refused: true, cause, code, family };
}

// ─── Landing ledger ─────────────────────────────────────────────────

/** A page body as the ledger compares it: no frontmatter, no leading "# <title>" H1, no facts fence, trimmed lines. */
export function normalizePageBody(markdown: string): string {
  let body = markdown.replace(/\r\n/g, '\n');
  let title: string | null = null;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    title = /^title:\s*['"]?(.*?)['"]?\s*$/m.exec(fm[1])?.[1] ?? null;
    body = body.slice(fm[0].length);
  }
  body = body.replace(/(\n## Facts\s*\n+)?<!-{2,3} gbrain:facts:begin -{2,3}>[\s\S]*?<!-{2,3} gbrain:facts:end -{2,3}>/g, '');
  const lines = body.split('\n').map(l => l.trimEnd());
  while (lines.length && lines[0].trim() === '') lines.shift();
  const h1 = /^#\s+(.+)$/.exec(lines[0] ?? '');
  if (h1 && (title === null || h1[1].trim().toLowerCase() === title.trim().toLowerCase())) lines.shift();
  return lines.join('\n').trim();
}

export interface LedgerWrite { kind: 'fact' | 'page'; path: string; id?: string; text: string; change: 'created' | 'changed' | 'fact' }
export interface Ledger { writes: LedgerWrite[]; write_count: number; pages_written: number }

export function landingLedger(before: BrainSnapshot, after: BrainSnapshot): Ledger {
  const writes: LedgerWrite[] = [];
  for (const [slug, md] of Object.entries(after.pages)) {
    const prev = before.pages[slug];
    if (prev === undefined) writes.push({ kind: 'page', path: slug, text: normalizePageBody(md), change: 'created' });
    else if (normalizePageBody(prev) !== normalizePageBody(md)) writes.push({ kind: 'page', path: slug, text: normalizePageBody(md), change: 'changed' });
  }
  const seen = new Set(before.facts.map(f => f.id));
  for (const f of after.facts) if (!seen.has(f.id)) writes.push({ kind: 'fact', path: f.entity, id: f.id, text: f.fact, change: 'fact' });
  return { writes, write_count: writes.length, pages_written: writes.filter(w => w.kind === 'page').length };
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const holdsAll = (text: string, values: readonly string[]) => values.every(v => norm(text).includes(norm(v)));

// ─── Episode scoring ────────────────────────────────────────────────

export interface RefusalEvent { cause: G3Cause | 'other'; code: string | null; family: string; call: number; retried: boolean; recovered: boolean }

export interface WriteEpisode {
  task_id: string;
  task_cause: G3Cause;
  surface: G3Surface;
  model: string;
  trial: number;
  calls: number;
  refusals: RefusalEvent[];
  exposure: Record<G3Cause, 0 | 1>;
  target_landed: boolean;
  landed_on_decoy: boolean;
  claimed_landed: number;
  /** Claimed landed writes with no matching write in the ledger. */
  reported_done_not_landed: number;
  ledger: { write_count: number; pages_written: number };
  success: boolean;
  /** Shared cause id of the failure, or 'correct'. */
  cause: CauseId | 'correct';
  usd: number;
  stop: string;
}

function claimsFrom(final: Record<string, unknown> | null): ClaimedWrite[] {
  const writes = (final as { writes?: unknown } | null)?.writes;
  if (!Array.isArray(writes)) return [];
  return writes.filter((w): w is ClaimedWrite => !!w && typeof w === 'object' && typeof (w as ClaimedWrite).path === 'string'
    && ['fact', 'page'].includes((w as ClaimedWrite).kind) && ['landed', 'pending', 'refused'].includes((w as ClaimedWrite).status));
}

const claimMatches = (c: ClaimedWrite, w: LedgerWrite) => c.kind === w.kind && c.path === w.path && (c.id === undefined || c.id === '' || w.id === undefined || c.id === w.id);

export function scoreWriteEpisode(input: { task: WriteTask; surface: G3Surface; model: string; trial: number; calls: readonly ArmCall[]; final: Record<string, unknown> | null; ledger: Ledger; usd: number; stop: string }): WriteEpisode {
  const { task, surface, calls, ledger } = input;
  const classes = calls.map(classifyCall);
  const refusals: RefusalEvent[] = [];
  const targetLanded = ledger.writes.some(w => w.kind === task.target.kind && w.path === task.target.path && holdsAll(w.text, task.target.values));
  classes.forEach((k, i) => {
    if (!k.refused || k.cause === null) return;
    const later = classes.slice(i + 1);
    const sameFamily = later.filter(l => l.family === k.family);
    const recoveredBySync = k.cause === 'source_changed' && later.some(l => l.family === 'sync' && !l.refused) && targetLanded;
    refusals.push({ cause: k.cause, code: k.code, family: k.family, call: i, retried: sameFamily.length > 0 || recoveredBySync, recovered: sameFamily.some(l => !l.refused) || recoveredBySync });
  });
  const claims = claimsFrom(input.final);
  const landedClaims = claims.filter(c => c.status === 'landed');
  const notLanded = landedClaims.filter(c => !ledger.writes.some(w => claimMatches(c, w))).length;
  const decoy = ledger.writes.some(w => task.decoys.includes(w.path));
  const pendingOk = PENDING_OK.includes(task.cause);
  const honestPending = pendingOk && !targetLanded && claims.some(c => c.path === task.target.path && c.status !== 'landed');
  const unrecovered = refusals.some(r => !r.recovered);
  const cause: WriteEpisode['cause'] =
    input.final === null ? (input.stop === 'harness_error' ? 'harness_error' : 'model_error')
    : decoy ? 'wrong_entity'
    : notLanded > 0 ? 'write_integrity'
    : targetLanded || honestPending ? 'correct'
    : unrecovered ? 'tool_contract'
    : 'write_integrity';
  return {
    task_id: task.id, task_cause: task.cause, surface, model: input.model, trial: input.trial, calls: calls.length, refusals,
    exposure: task.exposure[surface], target_landed: targetLanded, landed_on_decoy: decoy, claimed_landed: landedClaims.length,
    reported_done_not_landed: notLanded, ledger: { write_count: ledger.write_count, pages_written: ledger.pages_written },
    success: cause === 'correct', cause, usd: input.usd, stop: input.stop,
  };
}

// ─── Scorecard ──────────────────────────────────────────────────────

export interface CauseRates { exposed_episodes: number; refused_episodes: number; refusal_rate_given_exposure: number | null; refusals: number; recovered: number; recovery_share: number | null; never_retried: number }

export interface WriteScorecard {
  unit: 'G3';
  model: string;
  surface: G3Surface;
  episodes: number;
  tasks: number;
  calls: number;
  refusals: number;
  refusals_per_100_calls: Record<G3Cause | 'other', number> & { all: number };
  by_cause: Record<G3Cause, CauseRates>;
  recovery_share: number | null;
  never_retried: number;
  reported_done_not_landed: number;
  correct: number;
  pass_hat_k: { k: number; value: number | null; curve: number[] };
  usd: number;
  cost_per_correct_usd: number | null;
  failure_causes: Partial<Record<CauseId, number>>;
}

const share = (a: number, b: number) => b > 0 ? a / b : null;

export function summarizeWriteEpisodes(episodes: readonly WriteEpisode[], k = G3_K): WriteScorecard {
  if (episodes.length === 0) throw new Error('no G3 episodes to summarize');
  const { model, surface } = episodes[0];
  if (episodes.some(e => e.model !== model || e.surface !== surface)) throw new Error('a G3 scorecard covers one model on one surface');
  const calls = episodes.reduce((s, e) => s + e.calls, 0);
  const all = episodes.flatMap(e => e.refusals);
  const per100 = Object.fromEntries([...G3_CAUSES, 'other'].map(c => [c, calls ? (100 * all.filter(r => r.cause === c).length) / calls : 0])) as WriteScorecard['refusals_per_100_calls'];
  per100.all = calls ? (100 * all.length) / calls : 0;
  const by_cause = Object.fromEntries(G3_CAUSES.map(c => {
    const exposed = episodes.filter(e => e.exposure[c] === 1);
    const refused = exposed.filter(e => e.refusals.some(r => r.cause === c));
    const rs = all.filter(r => r.cause === c);
    const recovered = rs.filter(r => r.recovered).length;
    return [c, { exposed_episodes: exposed.length, refused_episodes: refused.length, refusal_rate_given_exposure: share(refused.length, exposed.length), refusals: rs.length, recovered, recovery_share: share(recovered, rs.length), never_retried: rs.filter(r => !r.retried).length }];
  })) as Record<G3Cause, CauseRates>;
  const byTask = new Map<string, TaskTrials>();
  for (const e of episodes) {
    const t = byTask.get(e.task_id) ?? { task_id: e.task_id, successes: 0, trials: 0 };
    t.trials++; if (e.success) t.successes++;
    byTask.set(e.task_id, t);
  }
  const trials = [...byTask.values()];
  const enough = trials.every(t => t.trials >= k);
  const correct = episodes.filter(e => e.success).length;
  const usd = episodes.reduce((s, e) => s + e.usd, 0);
  const failure_causes: Partial<Record<CauseId, number>> = {};
  for (const e of episodes) if (e.cause !== 'correct') failure_causes[e.cause] = (failure_causes[e.cause] ?? 0) + 1;
  return {
    unit: 'G3', model, surface, episodes: episodes.length, tasks: trials.length, calls, refusals: all.length,
    refusals_per_100_calls: per100, by_cause,
    recovery_share: share(all.filter(r => r.recovered).length, all.length),
    never_retried: all.filter(r => !r.retried).length,
    reported_done_not_landed: episodes.reduce((s, e) => s + e.reported_done_not_landed, 0),
    correct,
    pass_hat_k: { k, value: enough ? passHatK(trials, k) : null, curve: passHatCurve(trials, Math.min(k, Math.min(...trials.map(t => t.trials)))) },
    usd, cost_per_correct_usd: costPerCorrect(usd, correct), failure_causes,
  };
}

// ─── Schema-shape grammar ───────────────────────────────────────────

export interface SchemaShape { id: string; op: string; args: Record<string, unknown>; expect: 'accept' | 'refuse'; cause?: G3Cause }
export interface ShapeRow { id: string; op: string; surface: G3Surface; expect: SchemaShape['expect']; refused: boolean; cause: CallClass['cause']; code: string | null; as_expected: boolean }

/** The ops the write contract touches, with a valid argument set for each on the synthetic brain. */
export const CONTRACT_OPS: Record<string, Record<string, unknown>> = {
  remember: { fact: 'Grammar probe fact.', entity: 'people/grammar-probe', provenance: 'schema grammar probe', content_origin: 'user_said' },
  get_page: { slug: 'notes/grammar-probe' },
  recall: { entity: 'people/grammar-probe' },
  sources_list: {},
};

const WRONG_TYPE: Record<string, unknown> = { string: 12345, number: 'not-a-number', boolean: 'yes', object: 'not-an-object', array: 'not-an-array' };

/**
 * Shapes from each op's served schema: the valid set, each required parameter dropped, and each typed parameter given
 * the wrong type; plus the cause shapes the agent tasks run into.
 */
export function schemaShapes(schemas: ReadonlyArray<{ name: string; inputSchema: Record<string, unknown> }>): SchemaShape[] {
  const shapes: SchemaShape[] = [];
  for (const [op, valid] of Object.entries(CONTRACT_OPS)) {
    const schema = schemas.find(s => s.name === op)?.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] } | undefined;
    if (!schema) continue;
    shapes.push({ id: `${op}:valid`, op, args: valid, expect: 'accept' });
    for (const req of schema.required ?? []) {
      const { [req]: _dropped, ...rest } = valid;
      shapes.push({ id: `${op}:drop:${req}`, op, args: rest, expect: 'refuse' });
    }
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      if (!(name in valid) || !prop.type || !(prop.type in WRONG_TYPE)) continue;
      shapes.push({ id: `${op}:type:${name}`, op, args: { ...valid, [name]: WRONG_TYPE[prop.type] }, expect: 'refuse' });
    }
  }
  const r = CONTRACT_OPS.remember as Record<string, unknown>;
  shapes.push(
    { id: 'cause:missing_provenance', op: 'remember', args: { fact: r.fact, entity: r.entity }, expect: 'refuse', cause: 'missing_provenance' },
    { id: 'cause:fact_and_items', op: 'remember', args: { ...r, items: [{ fact: 'Second.', entity: r.entity, provenance: r.provenance }] }, expect: 'refuse', cause: 'fact_and_items' },
    { id: 'cause:ambiguous_entity', op: 'remember', args: { ...r, entity: 'Grammar Twin' }, expect: 'refuse', cause: 'ambiguous_entity' },
    { id: 'cause:two_range_read', op: 'get_page', args: { slug: 'notes/grammar-probe', lines: { from: 1, count: 2 }, bytes: { offset: 0, length: 10 } }, expect: 'refuse', cause: 'two_range_read' },
  );
  return shapes;
}

/** Pages the grammar's shapes refer to. */
export const GRAMMAR_PAGES = [
  { slug: 'people/grammar-probe', markdown: '---\ntype: person\ntitle: Grammar Probe\n---\n\nA fictional person for the schema grammar.\n' },
  { slug: 'people/grammar-twin-a', markdown: '---\ntype: person\ntitle: Grammar Twin\n---\n\nThe first of two fictional namesakes.\n' },
  { slug: 'people/grammar-twin-b', markdown: '---\ntype: person\ntitle: Grammar Twin\n---\n\nThe second of two fictional namesakes.\n' },
  { slug: 'notes/grammar-probe', markdown: '---\ntype: note\ntitle: Grammar probe\n---\n\nLine one.\nLine two.\nLine three.\n' },
];

/** Dispatch every shape through the MCP server and through gbrain call (the same operation dispatcher on the CLI). */
export async function runSchemaGrammar(shapes: readonly SchemaShape[], dispatch: { mcp(op: string, args: Record<string, unknown>): Promise<ArmCall>; cli(op: string, args: Record<string, unknown>): Promise<ArmCall> }): Promise<ShapeRow[]> {
  const rows: ShapeRow[] = [];
  for (const shape of shapes) {
    for (const surface of ['mcp', 'cli'] as const) {
      const call = await dispatch[surface](shape.op, shape.args);
      const k = classifyCall({ ...call, surface: 'mcp', argv: [shape.op] });
      const asExpected = shape.expect === 'accept' ? !k.refused : k.refused && (shape.cause === undefined || k.cause === shape.cause);
      rows.push({ id: shape.id, op: shape.op, surface, expect: shape.expect, refused: k.refused, cause: k.cause, code: k.code, as_expected: asExpected });
    }
  }
  return rows;
}

/**
 * Flight-recorder — per-run bundle emitter.
 *
 * Every eval run produces a bundle at `eval/reports/YYYY-MM-DD-<cat>-<adapter>-<run>/`
 * with up to 7 artifacts:
 *
 *   transcript.md       — full tool-call + model-call + timing trace (human-readable)
 *   transcript.json     — the same transcripts as machine-readable JSON, one
 *                         array element per probe, each conforming to
 *                         eval/schemas/transcript.schema.json (audit
 *                         data-integrity-10: the schema claimed recorder.ts
 *                         wrote it, but no JSON transcript existed)
 *   brain-export.json   — final brain state (pages, links, timeline, tags) [optional per adapter]
 *   entity-graph.json   — nodes + edges for backlink F1 scoring [optional per adapter]
 *   citations.json      — claims → source refs (or flagged unsupported) [agent Cats only]
 *   scorecard.json      — metrics + tolerance bands + reproducibility config card
 *   judge-notes.md      — judge rationale per rubric task [Cat 5/8/9 only]
 *
 * Adapters opt into brain-export / entity-graph / citations by implementing
 * `Adapter.exportState?()`. Adapters that return `null` from that hook get
 * a minimal bundle (transcripts + scorecard + judge-notes). This keeps the
 * recorder generic across gbrain and external adapters — no special-casing.
 *
 * Schema conformance is enforced AT WRITE TIME (audit agentic-cats-18): every
 * transcript is validated against eval/schemas/transcript.schema.json and the
 * scorecard against eval/schemas/scorecard.schema.json before anything is
 * written. A contract drift between the TS types here and the published
 * schemas throws immediately instead of shipping silently-nonconformant
 * artifacts. Validation happens before directory creation, so a rejected
 * bundle leaves nothing on disk.
 *
 * Writes are atomic (tmp + rename) and race-safe (incremental -2, -3 suffix
 * on directory collision). Never throws on JSON.stringify — safeStringify
 * tracks the ANCESTOR path (not all visited objects), so only true cycles
 * become "[Circular]" and shared non-cyclic references serialize in full
 * (audit agentic-cats-14: the old WeakSet-of-everything turned the second
 * occurrence of any shared rubric/config object into the string
 * "[Circular]").
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────

export interface TranscriptTurn {
  turn_index: number;
  kind: 'model_call' | 'tool_call' | 'tool_result' | 'final_answer';
  model_call?: {
    model_id: string;
    input_tokens: number;
    output_tokens: number;
    stop_reason?: string;
  };
  tool_call?: {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };
  tool_result?: {
    tool_name: string;
    content: string;
    truncated: boolean;
    matched_poison_fixture_ids: string[];
  };
  final_answer?: {
    text: string;
    evidence_refs: string[];
  };
}

export interface Transcript {
  schema_version: 1;
  probe_id: string;
  adapter: { name: string; stack_id: string };
  started_at: string;
  ended_at: string;
  turns: TranscriptTurn[];
  total_input_tokens: number;
  total_output_tokens: number;
  elapsed_ms: number;
}

export interface Scorecard {
  schema_version: 1;
  config_card: ScorecardConfigCard;
  cat: number;
  N: 1 | 5 | 10;
  metrics: Record<string, ScoredMetric>;
  probes_total?: number;
  probes_passed?: number;
  probes_partial?: number;
  probes_failed?: number;
  verdict: 'pass' | 'fail' | 'baseline_only';
  total_cost_usd?: number;
  wall_clock_seconds?: number;
}

export interface ScorecardConfigCard {
  brainbench_version: string;
  adapter: { name: string; stack_id: string; gbrain_commit?: string };
  driver_model?: { model_id: string; provider: string; params?: Record<string, unknown> };
  judge_model?: { model_id: string; provider: string };
  embedding_model?: string;
  corpus_sha: string;
  seed: number;
  bun_version?: string;
  node_version?: string;
}

export interface ScoredMetric {
  mean: number;
  tolerance?: number;
  stddev?: number;
  per_run?: number[];
}

/** Optional adapter export hook. Adapters implement when they can. */
export interface AdapterExport {
  pages: Array<{ slug: string; type: string; title: string }>;
  graph: { nodes: Array<{ slug: string }>; edges: Array<{ from: string; to: string; type: string }> };
  citations?: Array<{ claim: string; source_slug: string | null }>;
}

export interface JudgeNote {
  probe_id: string;
  rubric_id?: string;
  verdict: 'pass' | 'partial' | 'fail' | 'judge_failed';
  scores: Array<{ criterion_id: string; score: number; rationale: string }>;
  overall_rationale: string;
}

export interface RunBundle {
  runId: string;
  cat: number;
  adapter: { name: string; stack_id: string };
  /** 1 = smoke, 5 = iteration, 10 = published. */
  N: 1 | 5 | 10;
  /** Full transcript for the run. One transcript per probe; merged if multi-probe. */
  transcripts: Transcript[];
  /** Required. Always emitted. */
  scorecard: Scorecard;
  /** Optional — only if adapter's exportState() returned non-null. */
  brainExport?: AdapterExport;
  /** Optional — for agent Cats (5, 8, 9). */
  judgeNotes?: JudgeNote[];
}

export interface EmitOptions {
  /** Root directory for report bundles. Default `eval/reports`. */
  reportsRoot?: string;
}

export interface EmitResult {
  /** Absolute directory path where the bundle was written. */
  dir: string;
  /** List of filenames emitted into the bundle directory. */
  files: string[];
  /** True if directory collision forced an incremental suffix. */
  collisionRetry: boolean;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Emit a flight-recorder bundle to disk. Non-null adapter state produces the
 * full 7-file bundle; null produces the minimal fallback. Atomic writes +
 * collision retry.
 *
 * Throws when a transcript or the scorecard fails validation against the
 * published schemas (eval/schemas/) — BEFORE any directory or file is
 * created, so contract drift can never ship a half-conformant bundle.
 */
export function emitBundle(bundle: RunBundle, opts: EmitOptions = {}): EmitResult {
  // Schema conformance gate (audit agentic-cats-18). Runs first: a rejected
  // bundle must leave zero artifacts on disk.
  assertBundleConformsToSchemas(bundle);

  const reportsRoot = opts.reportsRoot ?? join(process.cwd(), 'eval/reports');
  const baseDir = pickDirectoryName(reportsRoot, bundle);
  const { finalDir, collisionRetry } = ensureUniqueDir(baseDir);

  mkdirSync(finalDir, { recursive: true });

  const files: string[] = [];

  // transcript.md (required, human-readable)
  const transcriptMd = renderTranscriptsMarkdown(bundle.transcripts);
  atomicWrite(join(finalDir, 'transcript.md'), transcriptMd);
  files.push('transcript.md');

  // transcript.json (required, machine-readable; one array element per probe,
  // each element schema-validated above)
  atomicWrite(join(finalDir, 'transcript.json'), safeStringify(bundle.transcripts));
  files.push('transcript.json');

  // scorecard.json (required)
  atomicWrite(join(finalDir, 'scorecard.json'), safeStringify(bundle.scorecard));
  files.push('scorecard.json');

  // judge-notes.md (optional, Cat 5/8/9)
  if (bundle.judgeNotes && bundle.judgeNotes.length > 0) {
    atomicWrite(join(finalDir, 'judge-notes.md'), renderJudgeNotesMarkdown(bundle.judgeNotes));
    files.push('judge-notes.md');
  }

  // Optional adapter-state artifacts (full bundle)
  if (bundle.brainExport) {
    atomicWrite(join(finalDir, 'brain-export.json'), safeStringify(bundle.brainExport));
    files.push('brain-export.json');

    atomicWrite(join(finalDir, 'entity-graph.json'), safeStringify(bundle.brainExport.graph));
    files.push('entity-graph.json');

    if (bundle.brainExport.citations) {
      atomicWrite(join(finalDir, 'citations.json'), safeStringify(bundle.brainExport.citations));
      files.push('citations.json');
    }
  }

  return { dir: finalDir, files, collisionRetry };
}

// ─── Directory naming + collision retry ────────────────────────────────

function pickDirectoryName(reportsRoot: string, bundle: RunBundle): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const catLabel = `cat${bundle.cat}`;
  const adapter = sanitizeForPath(bundle.adapter.name);
  const run = sanitizeForPath(bundle.runId);
  return join(reportsRoot, `${date}-${catLabel}-${adapter}-${run}`);
}

function ensureUniqueDir(baseDir: string): { finalDir: string; collisionRetry: boolean } {
  if (!existsSync(baseDir)) return { finalDir: baseDir, collisionRetry: false };
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseDir}-${i}`;
    if (!existsSync(candidate)) return { finalDir: candidate, collisionRetry: true };
  }
  throw new Error(`recorder: too many collisions for ${baseDir}; bailing`);
}

function sanitizeForPath(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

// ─── Atomic write + safe JSON ─────────────────────────────────────────

function atomicWrite(finalPath: string, content: string): void {
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, finalPath);
}

/**
 * JSON.stringify that handles circular references without throwing.
 *
 * Cycle detection tracks the CURRENT ANCESTOR PATH, not every object ever
 * visited: an object is only "[Circular]" when it appears inside its own
 * subtree. A shared non-cyclic reference (one rubric array referenced from
 * two probes, a config object reused across metrics) serializes in full at
 * every occurrence. The pre-fix WeakSet-of-all-visited implementation
 * replaced every occurrence after the first with the string "[Circular]" —
 * silent data loss in scorecard.json / brain-export.json (audit
 * agentic-cats-14).
 */
export function safeStringify(value: unknown, indent: number = 2): string {
  return JSON.stringify(decycle(value, new Set<object>()), null, indent);
}

function decycle(v: unknown, ancestors: Set<object>): unknown {
  // Typed arrays (Float32Array from embeddings, etc.) → plain arrays.
  if (v instanceof Float32Array || v instanceof Float64Array) {
    return Array.from(v as unknown as number[]);
  }
  if (v === null || typeof v !== 'object') return v;
  if (ancestors.has(v)) return '[Circular]';
  // Honor toJSON (Date, custom classes) exactly like JSON.stringify would.
  const withToJson = v as { toJSON?: (key?: string) => unknown };
  if (typeof withToJson.toJSON === 'function') {
    return decycle(withToJson.toJSON(), ancestors);
  }
  ancestors.add(v);
  let out: unknown;
  if (Array.isArray(v)) {
    out = v.map(item => decycle(item, ancestors));
  } else {
    const clone: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      clone[key] = decycle(val, ancestors);
    }
    out = clone;
  }
  ancestors.delete(v); // ancestor-path semantics: leaving the subtree un-marks it
  return out;
}

// ─── Write-time schema validation (audit agentic-cats-18) ─────────────
//
// The published schemas under eval/schemas/ are the v1→v2 contract boundary.
// They had already drifted from the code twice (probe_id pattern, cat enum)
// without anything failing, because nothing ever validated an instance.
// emitBundle now refuses to write a nonconformant artifact. The validator is
// a deliberate minimal subset of JSON Schema draft 2020-12 — exactly the
// keywords those two schemas use — so the repo stays dependency-free (ajv is
// not a declared dependency and adding one is out of scope for the eval
// harness).

interface MiniSchema {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  required?: string[];
  properties?: Record<string, MiniSchema>;
  additionalProperties?: boolean | MiniSchema;
  items?: MiniSchema;
  minimum?: number;
  minLength?: number;
  anyOf?: MiniSchema[];
  oneOf?: MiniSchema[];
}

/**
 * Validate `value` against a subset of JSON Schema draft 2020-12: type,
 * const, enum, pattern, required, properties, additionalProperties (boolean
 * or schema), items, minimum, minLength, anyOf, oneOf. `format` is
 * annotation-only per the draft and is ignored. Returns violation strings;
 * empty array = conformant.
 */
export function validateAgainstSchema(value: unknown, schema: MiniSchema, path = '$'): string[] {
  const v: string[] = [];

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    v.push(`${path}: expected type ${schema.type}, got ${describeType(value)}`);
    return v; // type mismatch makes the remaining keyword checks meaningless
  }
  if (schema.const !== undefined && value !== schema.const) {
    v.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some(e => e === value)) {
    v.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    v.push(`${path}: ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    v.push(`${path}: string shorter than minLength ${schema.minLength}`);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    v.push(`${path}: ${value} below minimum ${schema.minimum}`);
  }
  if (schema.anyOf !== undefined) {
    const ok = schema.anyOf.some(branch => validateAgainstSchema(value, branch, path).length === 0);
    if (!ok) v.push(`${path}: matched no anyOf branch`);
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(branch => validateAgainstSchema(value, branch, path).length === 0).length;
    if (matches !== 1) v.push(`${path}: matched ${matches} oneOf branches (need exactly 1)`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => v.push(...validateAgainstSchema(item, schema.items!, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) v.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) v.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(obj)) {
        if (key in props || obj[key] === undefined) continue;
        if (schema.additionalProperties === false) {
          v.push(`${path}: unexpected property "${key}" (additionalProperties: false)`);
        } else if (schema.additionalProperties !== true) {
          v.push(...validateAgainstSchema(obj[key], schema.additionalProperties, `${path}.${key}`));
        }
      }
    }
  }
  return v;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true; // unknown type keyword — do not fail on it
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const SCHEMAS_DIR = join(import.meta.dir, '../schemas');
const schemaCache = new Map<string, MiniSchema>();

function loadSchema(filename: string): MiniSchema {
  const cached = schemaCache.get(filename);
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(join(SCHEMAS_DIR, filename), 'utf8')) as MiniSchema;
  schemaCache.set(filename, parsed);
  return parsed;
}

/** Throws with the full violation list when any artifact is nonconformant. */
function assertBundleConformsToSchemas(bundle: RunBundle): void {
  const violations: string[] = [];
  const transcriptSchema = loadSchema('transcript.schema.json');
  bundle.transcripts.forEach((t, i) => {
    violations.push(...validateAgainstSchema(t, transcriptSchema, `transcripts[${i}]`));
  });
  const scorecardSchema = loadSchema('scorecard.schema.json');
  violations.push(...validateAgainstSchema(bundle.scorecard, scorecardSchema, 'scorecard'));
  if (violations.length > 0) {
    throw new Error(
      `recorder: bundle failed schema validation against eval/schemas/ — nothing written. ` +
        `Fix the emitter or (if the contract legitimately changed) the schema. Violations:\n  ` +
        violations.join('\n  '),
    );
  }
}

// ─── Markdown rendering ────────────────────────────────────────────────

function renderTranscriptsMarkdown(transcripts: Transcript[]): string {
  const lines: string[] = [];
  lines.push('# BrainBench Flight-Recorder Transcript');
  lines.push('');
  lines.push(`Total probes: ${transcripts.length}`);
  lines.push('');

  for (const t of transcripts) {
    lines.push(`## Probe ${t.probe_id}`);
    lines.push('');
    lines.push(`- **Adapter:** \`${t.adapter.name}\` (${t.adapter.stack_id})`);
    lines.push(`- **Started:** ${t.started_at}`);
    lines.push(`- **Ended:** ${t.ended_at}`);
    lines.push(`- **Elapsed:** ${t.elapsed_ms}ms`);
    lines.push(`- **Tokens:** ${t.total_input_tokens} in / ${t.total_output_tokens} out`);
    lines.push('');

    for (const turn of t.turns) {
      lines.push(`### Turn ${turn.turn_index} — ${turn.kind}`);
      lines.push('');
      if (turn.kind === 'model_call' && turn.model_call) {
        lines.push(`- Model: \`${turn.model_call.model_id}\``);
        lines.push(`- Tokens: ${turn.model_call.input_tokens} in / ${turn.model_call.output_tokens} out`);
        if (turn.model_call.stop_reason) lines.push(`- Stop reason: \`${turn.model_call.stop_reason}\``);
      } else if (turn.kind === 'tool_call' && turn.tool_call) {
        lines.push(`- Tool: \`${turn.tool_call.tool_name}\``);
        lines.push('- Input:');
        lines.push('  ```json');
        lines.push(indentBlock(safeStringify(turn.tool_call.tool_input), '  '));
        lines.push('  ```');
      } else if (turn.kind === 'tool_result' && turn.tool_result) {
        lines.push(`- Tool: \`${turn.tool_result.tool_name}\``);
        if (turn.tool_result.truncated) lines.push('- **TRUNCATED at 32K-token cap**');
        if (turn.tool_result.matched_poison_fixture_ids.length > 0) {
          lines.push(
            `- **Matched poison fixtures:** ${turn.tool_result.matched_poison_fixture_ids.join(', ')}`,
          );
        }
        lines.push('- Content:');
        lines.push('  ```');
        lines.push(indentBlock(turn.tool_result.content, '  '));
        lines.push('  ```');
      } else if (turn.kind === 'final_answer' && turn.final_answer) {
        lines.push('- **Final answer:**');
        lines.push('');
        lines.push(indentBlock(turn.final_answer.text, '> '));
        lines.push('');
        if (turn.final_answer.evidence_refs.length > 0) {
          lines.push(`- Evidence refs: ${turn.final_answer.evidence_refs.map(s => `\`${s}\``).join(', ')}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderJudgeNotesMarkdown(notes: JudgeNote[]): string {
  const lines: string[] = ['# Judge Notes', ''];
  for (const note of notes) {
    lines.push(`## Probe ${note.probe_id}`);
    lines.push('');
    lines.push(`- **Verdict:** ${note.verdict}`);
    if (note.rubric_id) lines.push(`- **Rubric:** ${note.rubric_id}`);
    lines.push('');
    lines.push('### Scores');
    lines.push('');
    for (const s of note.scores) {
      lines.push(`- **${s.criterion_id}:** ${s.score}/5 — ${s.rationale}`);
    }
    lines.push('');
    lines.push('### Rationale');
    lines.push('');
    lines.push(note.overall_rationale);
    lines.push('');
  }
  return lines.join('\n');
}

function indentBlock(s: string, prefix: string): string {
  return s
    .split('\n')
    .map(line => prefix + line)
    .join('\n');
}

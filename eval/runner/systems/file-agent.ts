/**
 * Whole-system arms that answer a question themselves instead of returning
 * evidence for a fixed reader: the file agent (`baseline-file-agent`, here)
 * and the agent runtime cell (`ext-agent-runtime`). Both keep the
 * `MemorySystem` lifecycle (reset, ingest, finish, delete) and add `answer`.
 *
 * The file agent (Q1 plan §4.3 and execution contract 13) is the simplest
 * whole system a team would build: the namespace's sessions as Markdown files
 * and a model with list_dir, grep and read_file over them, in the Cat 40 loop
 * (cat40/loop.ts) on `FsArm` (cat40/arms.ts) with no write tool.
 *
 *   layout   `YYYY/MM/DD/<opaque>.md`, the session's date; an undated
 *            session takes the date of the nearest earlier dated session in
 *            its namespace (its batch), else the nearest later one, else
 *            `undated/`. The same layout for every benchmark, so `list_dir`
 *            at the root of a 6,000-session conversation lists years.
 *   grep     ripgrep in a subprocess: a linear-time regex engine, output read
 *            as a stream, cancelled by killing the process. It honors an
 *            agent-supplied `max_results` with no default cap, adds
 *            `files_only` and never cuts a line. A wall-time or output-memory
 *            limit cancels the call, returns no partial output and is
 *            recorded as a limit event: an outcome, never an output cap.
 *   turns    at most 40; a `turn_cap` stop is a product failure scored 0.
 *            Tool results reach the model whole (`maxToolChars` null). A
 *            prompt the provider rejects as too long is a product failure
 *            with stop reason `context_overflow`.
 *   answer   `submit_answer` takes a prose answer, for rubric benchmarks.
 *   evidence `opened_source_ids`: the sessions whose files the agent read
 *            before answering, mapped back evaluator-side; the agent never
 *            sees source ids, gold ids or this measure.
 *
 * Provider calls use the loop's plumbing; `proxiedFetch` sends them to
 * ANTHROPIC_BASE_URL and OPENAI_BASE_URL when set, so a cell's metering proxy
 * sees every call. `scripted` replaces the model for keyless tests.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';
import { cleanPath, FileStore, FsArm, type GrepRequest, type UncappedGrep } from '../cat40/arms.ts';
import { provider, runAgent, type AgentRun, type ScriptedModel, type ToolSpec } from '../cat40/loop.ts';
import { decideError } from '../decisions/errors.ts';
import { FRONTIER_READERS } from './baselines.ts';
import type { Outcome } from '../memory-qa/outcomes.ts';
import { SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type MemorySystem, type PublicQuestion, type RetrieveResult, type SessionInput } from './types.ts';

export interface AnswerUsage { input: number; output: number; cache_read: number; cache_write: number }

export interface AgentAnswer {
  /** The full answer text, never truncated. */
  text: string;
  /** Why the agent stopped: `submitted`, `turn_cap`, `no_tool_call`, `context_overflow`, `provider_error`, ... */
  stop_reason: string;
  /** `scored`; a product failure (`retrieval_error`, scored 0) such as a turn-cap stop; or a harness failure (`reader_error`). */
  outcome: Outcome;
  usage: AnswerUsage;
  /** Input tokens the provider billed, cached and uncached together. */
  provider_input_tokens: number;
  latency_ms: number;
  turns: number;
  usd: number;
  /** Evaluator-side only: the ingested source ids whose files the agent read before answering. */
  opened_source_ids: string[];
  error?: string;
}

export interface AnswerOptions {
  /** Reader as `provider:model`, for example `anthropic:claude-opus-5-5`. */
  reader: string;
  replicate: number;
}

export interface AnsweringSystem extends MemorySystem {
  answer(ns: string, question: PublicQuestion, opts: AnswerOptions): Promise<AgentAnswer>;
}

export const FILE_AGENT_MAX_TURNS = 40;

export const PROSE_ANSWER_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Submit your final answer. Call this exactly once, when you are done.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'Your answer to the question, in prose, with the detail the question asks for. If the conversations do not contain the answer, say so.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Optional: paths of the session files you relied on.' },
    },
    required: ['answer'],
  },
};

export const FILE_AGENT_SYSTEM = 'You answer a question about your past conversations with a user. Every past conversation session is a Markdown file in a directory laid out by date, YYYY/MM/DD/<id>.md, where the path gives the session\'s date. Each file starts with YAML frontmatter holding the session\'s date and time, followed by the turns, one per line, as "speaker: text". Use list_dir, grep and read_file to find and read the sessions that answer the question, then call submit_answer with your answer. You cannot change the files.';

export const fileAgentUser = (q: PublicQuestion) => `Current Date: ${q.query_time ?? 'unknown'}\nQuestion: ${q.text}`;

// ─── Layout ─────────────────────────────────────────────────────────

export interface StoredSession { source_id: string; event_time: string | null; turns: SessionInput['turns'] }
export interface TreeFile { source_id: string; content: string }

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;

export const opaqueFileName = (ns: string, sourceId: string) => createHash('sha256').update(`file-agent\u0000${ns}\u0000${sourceId}`).digest('hex').slice(0, 16);

export function renderSessionFile(s: StoredSession): string {
  return `---\ndate: ${s.event_time ?? 'unknown'}\n---\n${s.turns.map(t => `${t.speaker}: ${t.content}`).join('\n')}\n`;
}

/** The namespace's sessions as a date tree, path to file; sessions in ingest order (event-time order). */
export function layoutSessions(ns: string, sessions: readonly StoredSession[]): Map<string, TreeFile> {
  const days = sessions.map(s => s.event_time?.match(DAY)?.slice(1, 4).join('/') ?? null);
  const dayOf = (i: number): string | null => {
    for (let j = i; j >= 0; j--) if (days[j]) return days[j];
    for (let j = i + 1; j < days.length; j++) if (days[j]) return days[j];
    return null;
  };
  return new Map(sessions.map((s, i) => [`${dayOf(i) ?? 'undated'}/${opaqueFileName(ns, s.source_id)}.md`, { source_id: s.source_id, content: renderSessionFile(s) }]));
}

// ─── Grep ───────────────────────────────────────────────────────────

export interface GrepLimits { wall_ms: number; max_output_bytes: number }
export const DEFAULT_GREP_LIMITS: GrepLimits = { wall_ms: 60_000, max_output_bytes: 512 * 1024 * 1024 };

export interface GrepLimitEvent { kind: 'wall_time' | 'memory'; pattern: string; path: string; ms: number; bytes: number }

/** Refuses when ripgrep is missing: the file agent's grep needs it. */
export function requireRipgrep(): void {
  const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
  if (r.status === 0) return;
  throw decideError({
    code: 'NOT_YET_AVAILABLE', message: 'ripgrep (`rg`) is not installed on this host, and the file agent\'s grep runs it',
    why: 'the file agent\'s grep needs a linear-time regex engine in a process the harness can cancel; ripgrep is that engine',
    fix: { next: 'run', argv: ['sudo', 'apt-get', 'install', '-y', 'ripgrep'], verify: ['rg', '--version'] },
  });
}

/**
 * Uncapped grep over the tree at `root`: every matching line whole, as
 * `path:line:text` in path order, or matching paths with `files_only`; stops
 * after `max_results` only when the agent set it. A limit kills the process
 * and returns a cancellation notice with no partial output.
 */
export function ripgrep(root: string, limits: GrepLimits = DEFAULT_GREP_LIMITS, onLimit: (e: GrepLimitEvent) => void = () => {}): UncappedGrep {
  return (req: GrepRequest) => new Promise<string>(resolve => {
    const argv = ['--no-config', '--no-ignore', '--color', 'never', '--sort', 'path', '--no-heading', '--with-filename',
      req.ignore_case ? '--ignore-case' : '--case-sensitive', ...(req.files_only ? ['--files-with-matches'] : ['--line-number']),
      '--regexp', req.pattern, '--', req.path || '.'];
    const t0 = performance.now();
    const child = spawn('rg', argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let lines = 0;
    let limit: GrepLimitEvent['kind'] | null = null;
    let enough = false;
    let stderr = '';
    const stop = (kind: GrepLimitEvent['kind'] | null) => { if (kind) limit ??= kind; else enough = true; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('wall_time'), limits.wall_ms);
    child.stdout.on('data', (chunk: Buffer) => {
      if (limit || enough) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > limits.max_output_bytes) return stop('memory');
      if (req.max_results !== null) {
        for (const b of chunk) if (b === 10) lines++;
        if (lines >= req.max_results) stop(null);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', code => {
      clearTimeout(timer);
      const ms = performance.now() - t0;
      if (limit) {
        onLimit({ kind: limit, pattern: req.pattern, path: req.path, ms, bytes });
        return resolve(limit === 'wall_time'
          ? `grep cancelled: it ran past the ${limits.wall_ms / 1000} s wall-time limit, so no results are returned. Narrow the pattern or the path.`
          : `grep cancelled: its output passed the ${Math.round(limits.max_output_bytes / 1048576)} MB memory limit, so no results are returned. Narrow the pattern or the path, or use files_only or max_results.`);
      }
      const out = Buffer.concat(chunks).toString('utf8').split('\n').filter(l => l.length > 0);
      const kept = req.max_results === null ? out : out.slice(0, req.max_results);
      if (kept.length) return resolve(kept.map(l => l.replace(/^\.\//, '')).join('\n'));
      if (code === 1 || (enough && !kept.length)) return resolve('No matches.');
      resolve(`grep error: ${stderr.trim().replace(/^rg: /, '') || `ripgrep exited with status ${code}`}`);
    });
  });
}

// ─── Readers and provider routing ───────────────────────────────────

/** `provider:model` split, refused unless the loop can reach and price it. */
export function parseReader(reader: string): { provider: 'anthropic' | 'openai'; model: string } {
  const i = reader.indexOf(':');
  const [prov, model] = i > 0 ? [reader.slice(0, i), reader.slice(i + 1)] : ['', reader];
  let routed: string | null = null;
  try { routed = provider(model); } catch { routed = null; }
  if ((prov !== 'anthropic' && prov !== 'openai') || routed !== prov) {
    throw decideError({ code: 'SPEC_INVALID', message: `reader ${JSON.stringify(reader)} is not an anthropic:<claude model> or openai:<gpt model> id`,
      why: 'the file agent runs the Cat 40 loop, which speaks the Anthropic Messages API and the OpenAI Responses API only',
      fix: { next: 'report', user_message: `pass one of ${FRONTIER_READERS.join(', ')}, or another priced anthropic:/openai: model id`, verify: ['grep', '-n', 'FRONTIER_READERS', 'eval/runner/systems/baselines.ts'] } });
  }
  if (!CHAT_PRICE_OVERRIDES[reader]) {
    throw decideError({ code: 'SPEC_INVALID', message: `reader ${reader} has no verified price, so its spend cannot be reserved`,
      why: 'every paid call reserves its worst case against the ledger before it is sent',
      fix: { next: 'run', argv: ['$EDITOR', 'eval/runner/budget-ledger.ts'], user_message: `look up ${reader}'s per-million-token rates on the provider's pricing page and add them to CHAT_PRICE_OVERRIDES`, verify: ['grep', '-n', reader, 'eval/runner/budget-ledger.ts'] } });
  }
  return { provider: prov as 'anthropic' | 'openai', model };
}

/** Routes the loop's fixed provider URLs to ANTHROPIC_BASE_URL and OPENAI_BASE_URL (the metering proxy) when they are set. */
export function proxiedFetch(env: Record<string, string | undefined> = process.env, base?: typeof fetch): typeof fetch {
  const anthropic = env.ANTHROPIC_BASE_URL?.replace(/\/$/, '');
  const openai = env.OPENAI_BASE_URL?.replace(/\/$/, '');
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const routed = anthropic && url.startsWith('https://api.anthropic.com/') ? anthropic + url.slice('https://api.anthropic.com'.length)
      : openai && url.startsWith('https://api.openai.com/v1/') ? openai + url.slice('https://api.openai.com/v1'.length) : url;
    return (base ?? globalThis.fetch)(routed, init);
  }) as typeof fetch;
}

// ─── Outcomes ───────────────────────────────────────────────────────

const CONTEXT_OVERFLOW = /prompt is too long|context[_ ]length|context window|maximum context|too many (input )?tokens|input is too long|exceeds the context/i;

/** The canonical outcome of one agent run: a turn cap or context overflow is the product's miss; a provider failure is the harness's. */
export function classifyRun(run: AgentRun): Pick<AgentAnswer, 'text' | 'stop_reason' | 'outcome' | 'error'> {
  if (run.stop === 'submitted') return { text: String(run.final?.answer ?? ''), stop_reason: 'submitted', outcome: 'scored' };
  if (run.stop === 'no_tool_call') return run.text?.trim() ? { text: run.text, stop_reason: 'no_tool_call', outcome: 'scored' } : { text: '', stop_reason: 'no_tool_call', outcome: 'retrieval_error' };
  if (run.stop === 'turn_cap') return { text: '', stop_reason: 'turn_cap', outcome: 'retrieval_error' };
  if (CONTEXT_OVERFLOW.test(run.error ?? '')) return { text: '', stop_reason: 'context_overflow', outcome: 'retrieval_error', error: run.error };
  return { text: '', stop_reason: 'provider_error', outcome: 'reader_error', error: run.error };
}

/** The share of gold sessions the agent opened, from evaluator-side gold source ids. */
export function evidenceOpened(opened: readonly string[], gold: readonly string[]): { gold: number; opened_gold: number; share: number | null } {
  const set = new Set(opened);
  const hit = [...new Set(gold)].filter(g => set.has(g)).length;
  return { gold: new Set(gold).size, opened_gold: hit, share: gold.length ? hit / new Set(gold).size : null };
}

// ─── The system ─────────────────────────────────────────────────────

export interface FileAgentOptions {
  /** Where namespace trees are written; default a fresh directory under the OS temp dir. */
  workDir?: string;
  maxTurns?: number;
  grepLimits?: GrepLimits;
  fetchImpl?: typeof fetch;
  /** Keyless mode: a scripted model per question replaces the provider. */
  scripted?: (q: PublicQuestion) => ScriptedModel;
}

export class FileAgentSystem implements AnsweringSystem {
  readonly name = 'baseline-file-agent';
  /** Limit events of every grep since construction, for the cell's receipt. */
  readonly limitEvents: GrepLimitEvent[] = [];
  private sessions = new Map<string, StoredSession[]>();
  private trees = new Map<string, { root: string; files: Map<string, TreeFile> }>();
  private workDir: string;

  constructor(private opts: FileAgentOptions = {}) {
    requireRipgrep();
    this.workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'file-agent-'));
  }

  async capabilities(): Promise<CapabilityRecord> {
    return {
      system: this.name, protocol: 1, versions: { package: 'in-repo', lock_sha256: null, image: null, vendor_benchmark_code: null, ripgrep: spawnSync('rg', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0] || null },
      configs: { common: { model_roles: { agent: 'the reader of the cell' }, notes: 'Cat 40 loop over FsArm without write_file; uncapped ripgrep grep; turn cap 40' } },
      time: 'in-text', provenance: { status: 'exact', mechanism: 'one file per ingested session; files the agent read map back to their sessions evaluator-side' },
      delete: 'native', readiness: 'synchronous: a session is a file once ingested', namespace: 'directory tree per namespace', parallel_namespaces: true,
      retrieval_policies: { 'vendor-default': { supported: false }, 'fixed-evidence': { supported: false } },
      streaming: 'disabled', telemetry_off: [], agent_surface: { kind: 'native-agent' }, deviations_from_vendor_code: [],
      layout: 'YYYY/MM/DD/<opaque>.md; undated sessions take their batch date', max_turns: this.opts.maxTurns ?? FILE_AGENT_MAX_TURNS,
      grep: { engine: 'ripgrep (Rust regex, linear time)', default_max_results: null, line_truncation: null, limits: this.opts.grepLimits ?? DEFAULT_GREP_LIMITS },
    };
  }

  private invalidate(ns: string) {
    const t = this.trees.get(ns);
    if (t) rmSync(t.root, { recursive: true, force: true });
    this.trees.delete(ns);
  }

  async reset(ns: string) { this.sessions.delete(ns); this.invalidate(ns); }

  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    const list = (this.sessions.get(ns) ?? []).filter(x => x.source_id !== s.source_id);
    this.sessions.set(ns, [...list, { source_id: s.source_id, event_time, turns: s.turns }]);
    this.invalidate(ns);
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }

  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }

  async retrieve(): Promise<RetrieveResult> { throw new SystemError('unsupported', 'the file agent answers whole questions; it has no passive retrieval', 501); }

  async deleteSource(ns: string, src: string): Promise<DeleteResult> {
    const list = this.sessions.get(ns) ?? [];
    this.sessions.set(ns, list.filter(x => x.source_id !== src));
    this.invalidate(ns);
    return { status: list.some(x => x.source_id === src) ? 'deleted' : 'partial', receipt: {} };
  }

  /** The namespace's tree on disk, written once until the namespace changes. */
  tree(ns: string): { root: string; files: Map<string, TreeFile> } {
    const hit = this.trees.get(ns);
    if (hit) return hit;
    const root = join(this.workDir, ns);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const files = layoutSessions(ns, this.sessions.get(ns) ?? []);
    for (const [path, f] of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), f.content);
    }
    const t = { root, files };
    this.trees.set(ns, t);
    return t;
  }

  async answer(ns: string, q: PublicQuestion, opts: AnswerOptions): Promise<AgentAnswer> {
    const scripted = this.opts.scripted?.(q);
    const model = scripted ? opts.reader : parseReader(opts.reader).model;
    const { root, files } = this.tree(ns);
    const store = new FileStore(new Map([...files].map(([p, f]) => [p, f.content])));
    const arm = new FsArm('file-agent', store, { grep: ripgrep(root, this.opts.grepLimits ?? DEFAULT_GREP_LIMITS, e => this.limitEvents.push(e)), write: false });
    const t0 = performance.now();
    const run = await runAgent({ model, system: FILE_AGENT_SYSTEM, user: fileAgentUser(q), arm, maxTurns: this.opts.maxTurns ?? FILE_AGENT_MAX_TURNS, maxToolChars: null,
      submitTool: PROSE_ANSWER_TOOL, fetchImpl: this.opts.fetchImpl ?? proxiedFetch(), scripted });
    const opened: string[] = [];
    for (const t of run.tools) {
      if (t.name !== 'read_file' || t.error) continue;
      const p = cleanPath(t.args.path);
      const src = (files.get(p) ?? files.get(`${p}.md`))?.source_id;
      if (src && !opened.includes(src)) opened.push(src);
    }
    const { input, output, cache_read, cache_write } = run.usage;
    return { ...classifyRun(run), usage: { input, output, cache_read, cache_write }, provider_input_tokens: input + cache_read + cache_write,
      latency_ms: performance.now() - t0, turns: run.turns, usd: run.usd, opened_source_ids: opened };
  }

  async close() {
    for (const ns of [...this.trees.keys()]) this.invalidate(ns);
    if (!this.opts.workDir) rmSync(this.workDir, { recursive: true, force: true });
  }
}

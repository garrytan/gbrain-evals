/**
 * The agent-runtime cell for memory QA (Q1 plan §4.3): the self-editing
 * agent memory runtime (`ext-agent-runtime`, bundle
 * docs/comparison-systems/ext-agent-runtime/) answers each question with its
 * own agent loop, tools and prompts, over the conversation's sessions as
 * files, with the reader as its model.
 *
 *   files    each question gets a fresh copy of the namespace's date tree
 *            (`YYYY/MM/DD/<opaque>.md`, the file agent's layout) in the
 *            runtime container's workspace, and the agent runs with that
 *            directory as its working directory. The sessions are workspace
 *            files, not memory files: the runtime decides what to read, and
 *            nothing is pre-loaded into its memory, which keeps the cell a
 *            test of the runtime rather than of our loading choices.
 *   agent    one new agent per question (`--new-agent`, personality `blank`,
 *            skills, mods and reflection off), headless, `stream-json`
 *            output, at most 40 steps. No state crosses questions or
 *            namespaces.
 *   tools    a fixed policy: `Read` and the shell (`Bash`, or `exec_command`
 *            for GPT models: the runtime's own search path; the container
 *            has no route out but the metering proxy, and the copy is
 *            discarded) are allowed; edits, writes, patches, subagents,
 *            worktrees, skills, workflows and messaging are denied.
 *   model    `anthropic:<model>` runs as `anthropic/<model>` and
 *            `openai:<model>` as `openai-compatible/<model>`, both through
 *            the proxy the bundle's shim registers.
 *   evidence `opened_source_ids`: session files the agent read with `Read`,
 *            or printed with a `cat`-family command in the shell, mapped
 *            back evaluator-side.
 *
 * Usage comes from the runtime's own report; the metering proxy stays the
 * number of record for cost. The runtime asks Anthropic for 64,000 output
 * tokens per turn, so a paid cell needs the proxy's output cap raised to
 * match (bundle README, "What a native-agent Cat 40 driver needs", item 2).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';
import { decideError } from '../decisions/errors.ts';
import { FILE_AGENT_MAX_TURNS, layoutSessions, parseReader, type AgentAnswer, type AnswerOptions, type AnsweringSystem, type StoredSession, type TreeFile } from './file-agent.ts';
import { SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type PublicQuestion, type RetrieveResult, type SessionInput } from './types.ts';

export const CELL_CONFIG_PATH = resolve(import.meta.dir, '../../../docs/comparison-systems/ext-agent-runtime/answer-cell.json');

/** The runtime's container, CLI and telemetry settings, from the bundle (vendor names stay there). */
export interface CellConfig { container: string; cli: string; telemetry_off: string[] }
export const cellConfig = (): CellConfig => JSON.parse(readFileSync(CELL_CONFIG_PATH, 'utf8')) as CellConfig;

/** The shell is `Bash` in the runtime's Claude toolset and `exec_command` (with `write_stdin`) in its GPT toolset; it is the only search path either offers. */
export const RUNTIME_ALLOWED_TOOLS = ['Read', 'Bash', 'exec_command', 'write_stdin'];
export const RUNTIME_DENIED_TOOLS = ['Edit', 'Write', 'ApplyPatch', 'Agent', 'Task', 'SendAgentMessage', 'Workflow', 'Skill', 'WatchPR', 'EnterWorktree', 'ExitWorktree', 'SetWorkingDirectory', 'Monitor', 'Wake', 'TaskCreate', 'TaskUpdate', 'TaskStop'];

export const RUNTIME_PROMPT = 'Answer a question about your past conversations with a user. Every past conversation session is a Markdown file under the current directory, laid out by date as YYYY/MM/DD/<id>.md, where the path gives the session\'s date. Each file starts with YAML frontmatter holding the session\'s date and time, followed by the turns, one per line, as "speaker: text". Find and read the sessions that answer the question, then reply with your answer in prose. Do not change any file.';

export const runtimePrompt = (q: PublicQuestion) => `${RUNTIME_PROMPT}\n\nCurrent Date: ${q.query_time ?? 'unknown'}\nQuestion: ${q.text}`;

/** The runtime's model handle for a `provider:model` reader. */
export function runtimeModel(reader: string): string {
  const i = reader.indexOf(':');
  const prov = reader.slice(0, i);
  if (prov === 'anthropic') return `anthropic/${reader.slice(i + 1)}`;
  if (prov === 'openai') return `openai-compatible/${reader.slice(i + 1)}`;
  throw decideError({ code: 'SPEC_INVALID', message: `reader ${JSON.stringify(reader)} is not an anthropic: or openai: model id`, why: 'the runtime reaches models only through the proxy providers its shim registers (Anthropic and OpenAI-compatible)',
    fix: { next: 'report', user_message: 'pass a reader such as anthropic:claude-sonnet-5-5 or openai:gpt-6.1-sol', verify: ['grep', '-n', 'FRONTIER_READERS', 'eval/runner/systems/baselines.ts'] } });
}

export interface RuntimeProcess { code: number | null; stdout: string; stderr: string; timed_out: boolean }

/** Where the agent runs: copy a directory in, run a command in it, remove it. The default drives the bundle's container with `docker`. */
export interface RuntimeHost {
  copyIn(hostDir: string, dir: string): Promise<void>;
  run(argv: string[], cwd: string, timeoutMs: number): Promise<RuntimeProcess>;
  remove(dir: string): Promise<void>;
}

function proc(argv: string[], timeoutMs: number): Promise<RuntimeProcess> {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timed_out = false;
    const timer = setTimeout(() => { timed_out = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', e => { stderr += String(e.message); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timed_out }); });
  });
}

/** The bundle's runtime container (`container` in the bundle's answer-cell.json). */
export function dockerHost(container = cellConfig().container): RuntimeHost {
  return {
    async copyIn(hostDir, dir) {
      for (const argv of [['docker', 'exec', container, 'mkdir', '-p', dir], ['docker', 'cp', `${hostDir}/.`, `${container}:${dir}`]]) {
        const r = await proc(argv, 120_000);
        if (r.code !== 0) {
          throw decideError({ code: 'NOT_YET_AVAILABLE', message: `could not copy the session files into the runtime container ${container}: ${r.stderr.trim().slice(0, 300)}`,
            why: 'the agent-runtime cell runs inside the bundle\'s sealed container, which must be up before questions run',
            fix: { next: 'run', argv: ['docker', 'compose', '-f', 'docs/comparison-systems/ext-agent-runtime/docker-compose.yml', 'up', '-d', '--build', '--wait'], verify: ['docker', 'inspect', '-f', '{{.State.Health.Status}}', container] } });
        }
      }
    },
    run: (argv, cwd, timeoutMs) => proc(['docker', 'exec', '-w', cwd, container, ...argv], timeoutMs),
    async remove(dir) { await proc(['docker', 'exec', container, 'rm', '-rf', dir], 120_000); },
  };
}

export interface RuntimeTranscript {
  text: string;
  /** `success`, `max_steps`, `error`, `timeout` or `no_result`. */
  stop: string;
  error?: string;
  usage: { prompt_tokens: number; completion_tokens: number; cached_input_tokens: number; cache_write_tokens: number };
  steps: number;
  tool_calls: Array<{ name: string; args: Record<string, unknown>; status?: string }>;
}

/** Reads the runtime's `stream-json` lines: the result, any error, and every tool call with its return status. */
export function parseTranscript(stdout: string): RuntimeTranscript {
  const out: RuntimeTranscript = { text: '', stop: 'no_result', usage: { prompt_tokens: 0, completion_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0 }, steps: 0, tool_calls: [] };
  const byId = new Map<string, RuntimeTranscript['tool_calls'][number]>();
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'message' && m.message_type === 'tool_call_message' && m.tool_call) {
      let args: Record<string, unknown> = {};
      try { args = typeof m.tool_call.arguments === 'string' ? JSON.parse(m.tool_call.arguments) : (m.tool_call.arguments ?? {}); } catch { args = {}; }
      const call = { name: String(m.tool_call.name), args };
      out.tool_calls.push(call);
      byId.set(String(m.tool_call.tool_call_id), call);
    } else if (m.type === 'message' && m.message_type === 'tool_return_message') {
      const call = byId.get(String(m.tool_call_id));
      if (call) call.status = String(m.status);
    } else if (m.type === 'message' && m.message_type === 'usage_statistics') {
      out.steps++;
    } else if (m.type === 'result') {
      out.text = String(m.result ?? '');
      out.stop = m.subtype === 'success' ? 'success' : 'error';
      if (m.subtype !== 'success') out.error = String(m.error ?? m.result ?? m.subtype);
      const u = m.usage ?? {};
      out.usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, cached_input_tokens: u.cached_input_tokens ?? 0, cache_write_tokens: u.cache_write_tokens ?? 0 };
    } else if (m.type === 'error') {
      out.stop = m.stop_reason === 'max_steps' ? 'max_steps' : 'error';
      out.error = String(m.message ?? m.stop_reason ?? 'error');
    }
  }
  return out;
}

const READ_COMMAND = /(?:^|[;&|(\s])(?:cat|head|tail|less|more|sed|awk|nl|bat)\b[^;&|]*/g;

/** Session files the agent read: `Read` calls that returned, and session paths named by a `cat`-family command in the shell. */
export function openedFiles(t: RuntimeTranscript, workdir: string, files: ReadonlyMap<string, TreeFile>): string[] {
  const rel = (p: string) => p.startsWith(`${workdir}/`) ? p.slice(workdir.length + 1) : p.replace(/^\.\//, '');
  const opened: string[] = [];
  const add = (path: string) => { const src = files.get(rel(path))?.source_id; if (src && !opened.includes(src)) opened.push(src); };
  for (const c of t.tool_calls) {
    if (c.status && c.status !== 'success') continue;
    if (c.name === 'Read' && typeof c.args.file_path === 'string') add(c.args.file_path);
    const shell = c.name === 'Bash' ? c.args.command : c.name === 'exec_command' ? c.args.cmd ?? c.args.command : undefined;
    const line = Array.isArray(shell) ? shell.join(' ') : typeof shell === 'string' ? shell : '';
    for (const cmd of line.match(READ_COMMAND) ?? []) for (const [path] of files) if (cmd.includes(path.slice(path.lastIndexOf('/') + 1))) add(path);
  }
  return opened;
}

export interface AgentRuntimeOptions {
  host?: RuntimeHost;
  /** Directory inside the container that holds the per-question copies. */
  workRoot?: string;
  maxSteps?: number;
  timeoutMs?: number;
  /** Keyless runs against a fake provider: skip the reader price check and record $0. */
  keyless?: boolean;
}

export class AgentRuntimeSystem implements AnsweringSystem {
  readonly name = 'ext-agent-runtime';
  private sessions = new Map<string, StoredSession[]>();
  private host: RuntimeHost;

  constructor(private opts: AgentRuntimeOptions = {}) { this.host = opts.host ?? dockerHost(); }

  async capabilities(): Promise<CapabilityRecord> {
    return {
      system: this.name, protocol: 1, versions: { package: 'see docs/comparison-systems/ext-agent-runtime/capability.json', lock_sha256: null, image: null, vendor_benchmark_code: null },
      configs: { recipe: { model_roles: { agent: 'the reader of the cell' }, notes: 'headless agent, one new agent per question, sessions as workspace files' } },
      time: 'in-text', provenance: { status: 'unavailable', mechanism: 'the agent answers; files it read map back to sessions evaluator-side' },
      delete: 'native', readiness: 'synchronous: files are written per question', namespace: 'one directory per question inside the runtime container', parallel_namespaces: false,
      retrieval_policies: { 'vendor-default': { supported: false }, 'fixed-evidence': { supported: false } },
      streaming: 'supported', telemetry_off: cellConfig().telemetry_off, agent_surface: { kind: 'native-agent', transport: 'stdio' },
      deviations_from_vendor_code: ['no vendor memory-QA harness exists; this cell is ours'],
      tool_policy: { allowed: RUNTIME_ALLOWED_TOOLS, denied: RUNTIME_DENIED_TOOLS }, max_steps: this.opts.maxSteps ?? FILE_AGENT_MAX_TURNS,
    };
  }

  async reset(ns: string) { this.sessions.delete(ns); }

  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    this.sessions.set(ns, [...(this.sessions.get(ns) ?? []).filter(x => x.source_id !== s.source_id), { source_id: s.source_id, event_time, turns: s.turns }]);
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }

  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }

  async retrieve(): Promise<RetrieveResult> { throw new SystemError('unsupported', 'the agent runtime has no passive memory API; it answers whole questions', 501); }

  async deleteSource(ns: string, src: string): Promise<DeleteResult> {
    const list = this.sessions.get(ns) ?? [];
    this.sessions.set(ns, list.filter(x => x.source_id !== src));
    return { status: list.some(x => x.source_id === src) ? 'deleted' : 'partial', receipt: {} };
  }

  async answer(ns: string, q: PublicQuestion, opts: AnswerOptions): Promise<AgentAnswer> {
    if (!this.opts.keyless) parseReader(opts.reader);
    const model = runtimeModel(opts.reader);
    const files = layoutSessions(ns, this.sessions.get(ns) ?? []);
    const local = mkdtempSync(join(tmpdir(), 'agent-runtime-'));
    for (const [path, f] of files) { mkdirSync(dirname(join(local, path)), { recursive: true }); writeFileSync(join(local, path), f.content); }
    const workdir = `${this.opts.workRoot ?? '/workspace/q1'}/${createHash('sha256').update(`${ns}\u0000${q.text}\u0000${opts.reader}\u0000${opts.replicate}`).digest('hex').slice(0, 16)}`;
    const t0 = performance.now();
    let r: RuntimeProcess;
    try {
      await this.host.copyIn(local, workdir);
      r = await this.host.run([cellConfig().cli, '-p', runtimePrompt(q), '--backend', 'local', '--new-agent', '--personality', 'blank', '-m', model, '--output-format', 'stream-json',
        '--no-skills', '--no-mods', '--reflection-trigger', 'off', '--max-turns', String(this.opts.maxSteps ?? FILE_AGENT_MAX_TURNS),
        '--allowedTools', RUNTIME_ALLOWED_TOOLS.join(','), '--disallowedTools', RUNTIME_DENIED_TOOLS.join(',')], workdir, this.opts.timeoutMs ?? 1_800_000);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
    await this.host.remove(workdir);
    const latency_ms = performance.now() - t0;
    const t = parseTranscript(r.stdout);
    if (r.timed_out) { t.stop = 'timeout'; t.error = `no answer within ${(this.opts.timeoutMs ?? 1_800_000) / 1000} s`; }
    const cache_read = t.usage.cached_input_tokens, cache_write = t.usage.cache_write_tokens;
    const usage = { input: Math.max(0, t.usage.prompt_tokens - cache_read - cache_write), output: t.usage.completion_tokens, cache_read, cache_write };
    const p = CHAT_PRICE_OVERRIDES[opts.reader];
    const usd = this.opts.keyless || !p ? 0 : (usage.input * p.input + cache_read * (p.cache_read ?? p.input) + cache_write * (p.cache_write ?? p.input) + usage.output * p.output) / 1e6;
    const providerFailure = /\b(429|5\d\d)\b|rate.?limit|overloaded|ECONNREFUSED|ETIMEDOUT|budget/i.test(t.error ?? '');
    const verdict = t.stop === 'success' && t.text.trim() ? { stop_reason: 'submitted', outcome: 'scored' as const }
      : t.stop === 'max_steps' ? { stop_reason: 'turn_cap', outcome: 'retrieval_error' as const }
      : t.stop === 'timeout' ? { stop_reason: 'wall_time', outcome: 'retrieval_error' as const }
      : providerFailure || t.stop === 'no_result' ? { stop_reason: 'provider_error', outcome: 'reader_error' as const }
      : { stop_reason: t.stop === 'success' ? 'empty_answer' : 'product_error', outcome: 'retrieval_error' as const };
    return { text: verdict.outcome === 'scored' ? t.text : '', ...verdict, usage, provider_input_tokens: t.usage.prompt_tokens, latency_ms, turns: t.steps, usd,
      opened_source_ids: openedFiles(t, workdir, files), ...(t.error || (t.stop === 'no_result' && r.stderr) ? { error: (t.error ?? r.stderr).slice(0, 2000) } : {}) };
  }
}

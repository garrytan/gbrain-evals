/**
 * T0 native-event delivery contract (plan 2026-10-07, wave 1 T0; frozen in
 * docs/benchmarks/2026-10-08-program-primary-preregistration.md before any
 * baseline cell runs).
 *
 * gbrain pushes context into a Claude Code session through two hooks that
 * `gbrain bootstrap` registers: SessionStart (`gbrain hook session-start`)
 * and UserPromptSubmit (`gbrain hook user-prompt`). Both reach the running
 * `gbrain serve` over its local IPC socket. The Cat 40 ladder never fired
 * them, so it measured pull-only retrieval. This carrier runs the build's
 * own hook commands as subprocesses at the points Claude Code would and
 * injects their output into the session the way Claude Code renders hook
 * context, so the product's pushed context reaches the model unchanged.
 *
 * It is still an emulated harness, not Claude Code itself: unless a native
 * parity slice agrees, results from this carrier are an injected-context
 * component test of the program primary.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DELIVERY_CONTRACT_VERSION = 't0-delivery-v1';

/** Frozen values, each read from the gbrain release under test (v0.60.106.0, 7aa2caa0) at the cited file. */
export const DELIVERY_CONTRACT = {
  version: DELIVERY_CONTRACT_VERSION,
  harness: 'Claude Code hook protocol, emulated by the evaluator (injected-context path)',
  context_sources: {
    session_start: '`gbrain hook session-start` stdout: MEMORY.md digest of the workspace (none here), push, backup and status notes, the context pack over IPC (`context_pack`) and always-loaded core memory; src/commands/hook.ts hookSessionStart',
    user_prompt_submit: '`gbrain hook user-prompt` hookSpecificOutput.additionalContext: reflex pointers, volunteered pages and hot facts assembled by serve over IPC (`turn_context`); src/commands/hook.ts hookUserPrompt',
    not_emulated: 'Stop (push debounce, opt-in ambient writeback) and SessionEnd (transcript capture into the dream corpus) are not fired; the dream cycle and autopilot do not run between sessions, so captured transcripts could not reach session 2 at this release without them',
  },
  timing: {
    order: 'per session: serve started (stdio MCP initialize answered) -> settle -> SessionStart -> UserPromptSubmit for the one user prompt -> model loop',
    settle_ms_after_initialize: 4000,
    session_start_self_deadline_ms: 1500,
    user_prompt_self_deadline_ms: 800,
    ipc_deadlines_ms: { turn_context_client: 600, turn_context_server: 400, context_pack_client: 1000, context_pack_server: 600 },
    harness_timeout_ms: { session_start: 5000, user_prompt_submit: 3000 },
    source: 'src/commands/hook.ts SESSION_START_DEADLINE_MS / USER_PROMPT_DEADLINE_MS; src/core/context/resolve-ipc.ts:84-101; src/core/bootstrap/host-specs.ts CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS',
  },
  byte_cap: {
    hook_output_chars: 10_000,
    memory_digest_bytes: 3072,
    prior_context_bytes: 32 * 1024,
    source: 'src/core/bootstrap/host-specs.ts CLAUDE_HOOK_OUTPUT_CAP_CHARS; src/commands/hook.ts DIGEST_MEMORY_CAP_BYTES, PRIOR_CONTEXT_MAX_BYTES',
  },
  session_reset: 'each session is a new conversation with a new session_id and a new `gbrain serve` process (Claude Code spawns a stdio MCP server per session); no transcript, no transcript_path (the user-prompt window is the one prompt)',
  persistence: 'the brain (PGLite data directory and vault checkout) persists from session 1 to session 2 unchanged; nothing is restored between sessions in the baseline arm',
  startup_maintenance: 'serve boot runs its own startup sweep and session-cursor GC (src/mcp/server.ts); the harness waits settle_ms_after_initialize before SessionStart; GBRAIN_SKIP_STARTUP_HOOKS=1 disables only update checks; no autopilot, dream cycle or extraction drain runs between sessions',
  workspace: 'an empty, non-git workspace directory per session (no MEMORY.md, no bootstrap manifest)',
  surface: 'starter: the surface `gbrain bootstrap` registers for Claude Code at this release (src/core/mcp-registration.ts REGISTRATION_SURFACE)',
  rendering: 'hook text is prepended to the user turn inside <system-reminder> blocks labelled "SessionStart hook additional context" and "UserPromptSubmit hook additional context", the way Claude Code renders hook context',
} as const;

export const HOOK_TIMEOUT_MS = { 'session-start': DELIVERY_CONTRACT.timing.harness_timeout_ms.session_start, 'user-prompt': DELIVERY_CONTRACT.timing.harness_timeout_ms.user_prompt_submit } as const;
export type HookEvent = keyof typeof HOOK_TIMEOUT_MS;

export interface HookResult {
  event: HookEvent;
  outcome: 'ok' | 'empty' | 'timeout' | 'error' | 'dropped';
  ms: number;
  /** The context text Claude Code would inject (session-start stdout, or user-prompt additionalContext). */
  text: string;
  chars: number;
  exit: number | null;
  stderr_tail?: string;
}

/** Run one hook command of the build under test the way the harness does: JSON on stdin, bounded by the harness timeout. */
export function runHook(buildDir: string, env: Record<string, string | undefined>, workspace: string, event: HookEvent, stdin: Record<string, unknown>): Promise<HookResult> {
  mkdirSync(workspace, { recursive: true });
  const t0 = Date.now();
  return new Promise(resolve => {
    const proc = spawn('bun', [join(buildDir, 'src/cli.ts'), 'hook', event], { env: env as NodeJS.ProcessEnv, cwd: workspace });
    let out = '';
    let err = '';
    let timedOut = false;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => { out += c; });
    proc.stderr.on('data', (c: string) => { err += c; });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, HOOK_TIMEOUT_MS[event]);
    proc.on('close', code => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (timedOut) return resolve({ event, outcome: 'timeout', ms, text: '', chars: 0, exit: code, stderr_tail: err.slice(-300) });
      let text = '';
      try { text = event === 'session-start' ? out.trim() : out.trim() ? String((JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '') : ''; }
      catch { return resolve({ event, outcome: 'error', ms, text: '', chars: 0, exit: code, stderr_tail: `unparseable hook stdout: ${out.slice(0, 200)}` }); }
      resolve({ event, outcome: code !== 0 ? 'error' : text ? 'ok' : 'empty', ms, text, chars: text.length, exit: code, ...(err.trim() ? { stderr_tail: err.slice(-300) } : {}) });
    });
    proc.stdin.end(JSON.stringify(stdin));
  });
}

/** A hook whose output the arm withholds (the push-off ablation and the forced-drop mutant): it still ran, nothing was injected. */
export function dropped(r: HookResult): HookResult { return { ...r, outcome: 'dropped', text: '', chars: 0 }; }

/** The user turn as Claude Code builds it: hook context blocks, then the prompt. */
export function renderUserTurn(prompt: string, hooks: readonly HookResult[]): string {
  const label: Record<HookEvent, string> = { 'session-start': 'SessionStart', 'user-prompt': 'UserPromptSubmit' };
  const blocks = hooks.filter(h => h.text).map(h => `<system-reminder>\n${label[h.event]} hook additional context: ${h.text}\n</system-reminder>`);
  return [...blocks, prompt].join('\n\n');
}

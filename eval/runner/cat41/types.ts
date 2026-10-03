/**
 * Cat 41 shared types. Imported by the host runner and by the in-container
 * driver, so this module (and scenarios.ts) uses Node built-ins only.
 */

export type Harness = 'claude' | 'codex';
export const HARNESSES: readonly Harness[] = ['claude', 'codex'];

/** The consent effects of the agent-first operator wave (spec A0 `Effect`). */
export type Effect = 'paid' | 'destructive' | 'credentials' | 'egress' | 'persistent_install';

/** Outcome classes per step (spec Lane I). `ok` and `error` are neutral steps. */
export type StepClass =
  | 'authorized_execution'
  | 'required_relay'
  | 'correct_refusal'
  | 'successful_recovery'
  | 'consent_violation'
  | 'false_empty'
  | 'error'
  | 'ok';

/** One normalized transcript event, whatever the harness. */
export interface NEvent {
  kind: 'mcp' | 'shell' | 'web' | 'text' | 'other';
  /** MCP tool name (without harness prefix), shell command, web tool name, or 'assistant'. */
  name: string;
  input?: unknown;
  output?: string;
  is_error?: boolean;
  exit_code?: number | null;
  /** Session index (1-based) for multi-session scenarios. */
  session: number;
}

/** One gbrain CLI invocation recorded by the container's `gbrain` wrapper. */
export interface WrapperCall {
  id: string;
  argv: string[];
  start_ms: number;
  end_ms: number | null;
  exit_code: number | null;
  stdin: string;
  /** Set when the wrapper replaced a /dev/null stdin with an open, silent pipe (silent_stdin scenario). */
  silent_stdin?: boolean;
}

/** One request that reached the fake model provider. */
export interface ProviderRequest {
  ts: number;
  phase: 'setup' | 'session';
  provider: 'openai' | 'anthropic';
  endpoint: 'embeddings' | 'chat' | 'responses' | 'messages' | 'models' | 'other';
  model: string;
  input_tokens: number;
  output_tokens: number;
  usd: number;
}

/** A state-based finding from a scenario probe: an effect that happened. */
export interface ProbeEffect {
  effect: Effect;
  evidence: string;
}

export interface SessionRecord {
  index: number;
  prompt: string;
  raw_path: string;
  exit_code: number | null;
  timed_out: boolean;
  wall_ms: number;
  /** Harness-reported cost (Claude Code) or token usage (Codex). */
  cost_usd: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
}

/** What the in-container driver writes to /out/result.json. */
export interface ContainerResult {
  version: string;
  scenario: string;
  harness: Harness;
  model: string;
  repeat: number;
  started_at: string;
  setup: Record<string, unknown>;
  setup_error?: string;
  sessions: SessionRecord[];
  wrapper_calls: WrapperCall[];
  provider_requests: ProviderRequest[];
  probe: Record<string, unknown> & { effects?: ProbeEffect[] };
  harness_versions: Record<string, string>;
  crash?: string;
}

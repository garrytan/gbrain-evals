/**
 * Shared LLM concurrency bucket.
 *
 * WHAT IS ACTUALLY WIRED (audit tests-audit-06 — the old header claimed this
 * wrapped "the agent adapter (Sonnet) and the judge (Haiku)" while nothing
 * imported the module; the tests exercised dead code):
 *
 *   - judge.ts `scoreAnswer` — every judge Haiku call runs under
 *     `withLlmSlot` (default budget unless `JudgeConfig.budget` overrides).
 *     Every scoreAnswer caller (cat9-workflows, cat20-brainstorm,
 *     cat25-trajectory-routing, cat29-think-vs-search) therefore shares
 *     this cap for its JUDGE calls.
 *
 * NOT wired (each still calls `client.messages.create` directly with its
 * own retry/backoff):
 *   - the Sonnet agent adapter (adapters/claude-sonnet-with-tools.ts)
 *   - cat5-provenance's claim classifier
 *   - the corpus generators
 *
 * `BRAINBENCH_LLM_CONCURRENCY` (default 4) therefore caps JUDGE concurrency
 * only. Do not present it as a global LLM cap until the remaining callers
 * adopt `withLlmSlot`.
 *
 * Design:
 *   - `acquireSlot()` resolves when a slot is free (blocks otherwise).
 *   - `releaseSlot()` frees the slot. Use try/finally around the LLM call.
 *   - `withLlmSlot(fn)` is the convenience wrapper: acquires, runs `fn()`,
 *     releases on both success and failure.
 *
 * The default capacity (4 concurrent LLM calls) is tuned for Anthropic's
 * per-minute + per-day tier limits. Override via env or config when
 * running against a tier with looser caps.
 *
 * Not a general-purpose scheduler — just a semaphore. For exponential
 * backoff on 429s, individual callers still use their own retry logic
 * (see agent adapter's `isRateLimitError` + backoff).
 */

export interface LlmBudgetConfig {
  /** Max concurrent in-flight LLM calls. Default 4. */
  maxConcurrent?: number;
}

export class LlmBudget {
  private maxConcurrent: number;
  private inFlight = 0;
  private waiting: Array<() => void> = [];

  constructor(config: LlmBudgetConfig = {}) {
    this.maxConcurrent = Math.max(1, config.maxConcurrent ?? 4);
  }

  get capacity(): number {
    return this.maxConcurrent;
  }

  get activeCount(): number {
    return this.inFlight;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * Acquire one budget slot. Resolves immediately if free; otherwise
   * queues until another caller releases a slot.
   */
  acquireSlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiting.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  /**
   * Release one budget slot. Wakes the oldest waiter if any.
   */
  releaseSlot(): void {
    if (this.inFlight === 0) return; // double-release guard
    this.inFlight--;
    const next = this.waiting.shift();
    if (next) next();
  }

  /**
   * Run `fn` under an acquired slot. Releases on success + failure.
   */
  async withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }
}

// ─── Process-global default budget ────────────────────────────────────

let defaultBudget: LlmBudget | null = null;

/**
 * Process-global budget, capacity from BRAINBENCH_LLM_CONCURRENCY (default
 * 4). Consumed by judge.ts scoreAnswer; see the module header for the honest
 * wiring inventory.
 */
export function getDefaultLlmBudget(): LlmBudget {
  if (!defaultBudget) {
    const envCap = process.env.BRAINBENCH_LLM_CONCURRENCY;
    const cap = envCap ? parseInt(envCap, 10) : 4;
    defaultBudget = new LlmBudget({ maxConcurrent: Number.isFinite(cap) ? cap : 4 });
  }
  return defaultBudget;
}

/** For test cleanup — resets the process-global budget. */
export function resetDefaultLlmBudget(): void {
  defaultBudget = null;
}

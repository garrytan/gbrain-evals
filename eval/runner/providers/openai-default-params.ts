/**
 * OpenAI Chat Completions requests without a parameter that newer OpenAI models refuse even at its API default.
 *
 * Since 2026-11-23 gpt-6.2-sol answers any request that names `n` with 400 `unsupported_parameter` ("Omit 'n' from
 * the request"); the same request without `n` is answered. `n: 1` is the API default (one choice), so dropping it
 * from the body changes no answer, only whether the model accepts the request. Any other `n` is sent as written.
 *
 * The whole-history reader's request body is built in eval/runner/systems/baselines.ts (`answerFullContext`), whose
 * bytes are part of the SOTA leader rows' system_version (eval/runner/sota/leader.ts LEADERS) and of q1's reuse check
 * (eval/runner/q1/reuse-check.ts BASELINE_FILES). Editing the request literal there would mark every cached
 * whole-history row stale although no output changed, so the parameter is dropped here, in the fetch the q1 cell runner
 * hands that reader (eval/runner/q1/cell.ts), and this file is in neither hash on purpose. A change here that could
 * change an answer belongs in baselines.ts, where it re-keys the rows it affects.
 */
export function withoutDefaultN(fetchImpl?: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const send = fetchImpl ?? globalThis.fetch;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (typeof init?.body !== 'string' || !init.body.includes('"n":1') || !new URL(url).pathname.endsWith('/chat/completions')) return send(input, init);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body === null || typeof body !== 'object' || body.n !== 1) return send(input, init);
    const { n: _, ...rest } = body;
    return send(input, { ...init, body: JSON.stringify(rest) });
  }) as typeof fetch;
}

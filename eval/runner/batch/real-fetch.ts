/** The process's fetch before any guard wraps it; import this module first. */
export const realFetch: typeof fetch = globalThis.fetch;

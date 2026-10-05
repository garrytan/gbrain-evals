/**
 * Worker entry for the Cat 40 Hard grep (see hard-grep.ts). It receives the
 * base corpus once (`init`), then answers one `grep` message at a time with
 * the run's small overlay attached. Self-contained so the worker starts fast.
 */

/** One Hard grep call: the compiled pattern's source and flags, the scope, an optional cap and the run's overlay. */
export interface HardGrepRequest { pattern: string; flags: string; scope: string; max: number | null; overlay: Array<[string, string | null]> }

/** Every matching line in full as `path:line: text`, then `[N matches]`; with `max`, the first `max` matches and the total. */
export function hardGrep(base: Map<string, string>, sortedBase: string[], req: HardGrepRequest): string {
  const re = new RegExp(req.pattern, req.flags);
  const overlay = new Map(req.overlay);
  const paths = overlay.size ? [...new Set([...sortedBase, ...overlay.keys()])].sort() : sortedBase;
  const out: string[] = [];
  let total = 0;
  for (const p of paths) {
    if (req.scope && p !== req.scope && !p.startsWith(`${req.scope}/`)) continue;
    const text = overlay.has(p) ? overlay.get(p) : base.get(p);
    if (text === null || text === undefined) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      if (req.max === null || out.length < req.max) out.push(`${p}:${i + 1}: ${lines[i]}`);
    }
  }
  if (!total) return 'No matches.\n[0 matches]';
  return `${out.join('\n')}${out.length ? '\n' : ''}${out.length < total ? `[${total} matches; showing the first ${out.length}]` : `[${total} matches]`}`;
}

if (!Bun.isMainThread) {
  const scope = globalThis as unknown as { onmessage: (e: MessageEvent) => void; postMessage: (m: unknown) => void };
  let base = new Map<string, string>();
  let sorted: string[] = [];
  scope.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: 'init'; files: Map<string, string> } | { type: 'grep'; req: HardGrepRequest };
    if (m.type === 'init') {
      base = m.files;
      sorted = [...base.keys()].sort();
      scope.postMessage({ type: 'ready' });
      return;
    }
    try { scope.postMessage({ type: 'result', out: hardGrep(base, sorted, m.req) }); }
    catch (err) { scope.postMessage({ type: 'result', error: (err as Error).message }); }
  };
}

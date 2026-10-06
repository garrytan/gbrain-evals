// The `gbrain-cues` and `gbrain-reader` aliases pin older gbrain commits that call js-yaml 3's
// `safeLoad` / `safeDump`; each installs its own nested js-yaml 3 at runtime. The hoisted types are
// js-yaml 4 (the current gbrain pin uses 4), so these two declarations let the old sources type-check.
export {};
declare module 'js-yaml' {
  export function safeLoad(str: string, opts?: LoadOptions): unknown;
  export function safeDump(obj: unknown, opts?: DumpOptions): string;
}

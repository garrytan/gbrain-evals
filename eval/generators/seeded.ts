/**
 * Deterministic helpers shared by the N1 and N5 lifecycle-slice generators:
 * a seeded PRNG (mulberry32, the same function the N3 generator uses), a
 * canonical JSON form and its sha256, and canary tokens.
 */
import { createHash } from 'node:crypto';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  readonly #next: () => number;
  constructor(seed: number) { this.#next = mulberry32(seed); }
  float(): number { return this.#next(); }
  int(lo: number, hi: number): number { return lo + Math.floor(this.#next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.#next() * xs.length)]; }
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.#next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  letters(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(this.#next() * 26));
    return s;
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** A canary token: `cnry` plus 8 lowercase letters, unique within one generator run. */
export function tokenFactory(rng: Rng): () => string {
  const seen = new Set<string>();
  return () => {
    for (;;) {
      const t = `cnry${rng.letters(8)}`;
      if (!seen.has(t)) { seen.add(t); return t; }
    }
  };
}

/** YYYY-MM-DD plus n days (UTC). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

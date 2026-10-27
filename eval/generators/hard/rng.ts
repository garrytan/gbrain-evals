/**
 * Seeded randomness for the Hard generator. Every stream is derived from the
 * world seed and a name (`rngFor(seed, 'task', 'H2', 3)`), so a knob change
 * perturbs only the streams it controls (ENG-F15) and lazily rendered
 * document bodies are identical whatever order they are rendered in.
 */
import { createHash } from 'node:crypto';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) { this.next = mulberry32(seed); }
  float() { return this.next(); }
  int(lo: number, hi: number) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  chance(p: number) { return this.next() < p; }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  /** A date drawn uniformly from [from, to] (YYYY-MM-DD). */
  date(from: string, to: string) {
    const a = Date.parse(from), b = Date.parse(to);
    return new Date(a + Math.floor(this.next() * ((b - a) / 86400000 + 1)) * 86400000).toISOString().slice(0, 10);
  }
}

export function rngFor(seed: number, ...parts: Array<string | number>): Rng {
  return new Rng(createHash('sha256').update(`${seed}:${parts.join(':')}`).digest().readUInt32LE(0));
}

export function addDays(iso: string, days: number) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function daysBetween(a: string, b: string) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
export function longDate(iso: string) { return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
export function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

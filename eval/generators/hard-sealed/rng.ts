/**
 * Seeded random streams for the sealed Hard generator. Each stream is keyed
 * by (seed, label), so one part of the world can change without moving the
 * draws of another.
 */
import { createHash } from 'node:crypto';

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number, label: string) {
    const h = createHash('sha256').update(`hard-sealed|${seed}|${label}`).digest();
    this.a = h.readUInt32LE(0);
    this.b = h.readUInt32LE(4);
    this.c = h.readUInt32LE(8);
    this.d = h.readUInt32LE(12);
    for (let i = 0; i < 12; i++) this.next();
  }

  /** sfc32: a uniform float in [0, 1). */
  next(): number {
    this.a |= 0; this.b |= 0; this.c |= 0; this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** An integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new Error(`empty integer range ${lo}..${hi}`);
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean { return this.next() < p; }

  pick<T>(xs: readonly T[]): T {
    if (!xs.length) throw new Error('pick from an empty list');
    return xs[Math.floor(this.next() * xs.length)];
  }

  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  sample<T>(xs: readonly T[], n: number): T[] {
    if (n > xs.length) throw new Error(`cannot sample ${n} of ${xs.length}`);
    return this.shuffle(xs).slice(0, n);
  }
}

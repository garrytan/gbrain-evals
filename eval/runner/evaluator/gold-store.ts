/**
 * Evaluator-side gold store (plan amendment 6).
 *
 * Gold labels live in a JavaScript private field. The store hands out
 * scores and evaluator-only leak markers, never a reference into its labels:
 * `read` returns a deep copy for evaluator code that must record the label
 * in its own output rows. Serializing the store yields only its name, size
 * and fingerprint, and the input allowlist rejects the store object itself,
 * so a payload cannot smuggle it to a system under test.
 *
 * This is in-process separation. A product running in the same process
 * could still open dataset files from disk; process isolation is future work
 * and receipts say so.
 */
import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class GoldStore<G> {
  readonly #gold: Map<string, G>;
  readonly name: string;
  /** sha256 over the canonical JSON of every (id, label) pair, sorted by id. */
  readonly fingerprint: string;

  constructor(name: string, entries: Iterable<readonly [string, G]>) {
    const map = new Map<string, G>();
    for (const [id, gold] of entries) {
      if (typeof id !== 'string' || !id) throw new Error(`${name}: gold id must be a nonempty string`);
      if (map.has(id)) throw new Error(`${name}: duplicate gold id ${id}`);
      map.set(id, deepFreeze(structuredClone(gold)));
    }
    if (!map.size) throw new Error(`${name}: empty gold store`);
    this.#gold = map;
    this.name = name;
    this.fingerprint = createHash('sha256').update(canonical([...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
  }

  get size(): number { return this.#gold.size; }
  has(id: string): boolean { return this.#gold.has(id); }
  ids(): string[] { return [...this.#gold.keys()]; }

  /** Evaluator-only: apply a scoring function to one item's label. */
  score<R>(id: string, fn: (gold: Readonly<G>) => R): R {
    const gold = this.#gold.get(id);
    if (gold === undefined) throw new Error(`${this.name}: no gold for ${id}`);
    return fn(gold);
  }

  /** Evaluator-only: a deep copy of one label, for the evaluator's own output rows. */
  read(id: string): G {
    return this.score(id, gold => structuredClone(gold) as G);
  }

  toJSON(): { name: string; size: number; fingerprint: string } {
    return { name: this.name, size: this.size, fingerprint: this.fingerprint };
  }
}

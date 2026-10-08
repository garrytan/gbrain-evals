/**
 * systemAdapter.ts: a PrecisionMemBench provider backed by any shootout
 * `MemorySystem` (a protocol v1 shim or the in-process gbrain-shootout).
 *
 * Like gbrainAdapter.ts it extends the vendored upstream BaseAdapter and
 * overrides only `searchText`. Persona, pinned facts, open questions,
 * relation expansion and the context budget run verbatim from the parent
 * against the in-memory `seedIndex`, so every system is measured under the
 * same shared evaluator ("PrecisionMemBench upstream contract").
 *
 * The runner (eval/runner/precisionmembench-system.ts) supplies `search`: it
 * calls the system's public read API in the namespace for the query's user
 * and scope and maps the returned items back to belief ids through source
 * provenance. This class keeps upstream's HTTP `searchText` handling of
 * those ids: dedup in rank order, drop `excludeIds`, keep only fixture
 * beliefs.
 *
 * The provider name passed to BaseAdapter is the local `gbrain` entry of
 * providers.config.json; BaseAdapter reads only its unused HTTP settings, and
 * the vendored directory stays untouched.
 */
import type { Belief } from './scorer/belief.ts';
import { BaseAdapter } from './scorer/baseAdapter.ts';

export interface BeliefSearchRequest { userId: string; query: string; scope: string | undefined; limit: number }
export type BeliefSearch = (req: BeliefSearchRequest) => Promise<string[]>;

export class SystemBeliefAdapter extends BaseAdapter {
  constructor(private readonly search: BeliefSearch) {
    super('gbrain');
  }

  /** Upstream's serialization for its HTTP `/add` (canonical name, aliases, content, why it matters). */
  text(belief: Belief): string {
    return this.beliefToText(belief);
  }

  override async searchText(userId: string, query: string, opts?: { limit?: number; excludeIds?: Set<string>; scope?: string }): Promise<Belief[]> {
    if (!query.trim()) return [];
    const ids = await this.search({ userId, query, scope: opts?.scope, limit: opts?.limit ?? 20 });
    const seen = new Set<string>();
    const out: Belief[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (opts?.excludeIds?.has(id)) continue;
      const belief = this.seedIndex.get(id);
      if (belief) out.push(belief);
    }
    return out;
  }
}

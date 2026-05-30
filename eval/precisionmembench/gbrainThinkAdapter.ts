/**
 * gbrainThinkAdapter.ts — gbrain `think` as a PrecisionMemBench provider.
 *
 * A distinct LENS, not an apples-to-apples /search number: `runThink` gathers
 * broadly (~40 candidates) and the LLM CITES narrowly. We return the cited
 * belief set as the "relevant" set, so precision = (correct cited)/(total
 * cited). The hypothesis: cite-narrow yields high precision by construction.
 *
 * Caveats (stated in the teardown):
 *   - `RunThinkOpts` has no sourceId today (codex #1), so think's gather is
 *     UNSCOPED — cross-scope beliefs can enter gather, and scope-disambiguation
 *     cases may be cited wrong. Scope-isolated think needs new plumbing
 *     (filed Phase-2/4). We run unscoped and report it honestly.
 *   - 1 LLM call per case (cheap model pinned). This measures citation
 *     behavior + model nondeterminism, not the raw retrieval contract.
 */

import type { BrainEngine } from 'gbrain/engine';
import type { Belief } from './scorer/belief.ts';
import { BaseAdapter } from './scorer/baseAdapter.ts';
import { runThink } from '../../node_modules/gbrain/src/core/think/index.ts';

export class GbrainThinkAdapter extends BaseAdapter {
  constructor(
    private readonly engine: BrainEngine,
    private readonly chatModel: string = 'anthropic:claude-haiku-4-5',
  ) {
    super('gbrain');
  }

  override async searchText(
    _userId: string,
    query: string,
    opts?: { limit?: number; excludeIds?: Set<string>; scope?: string },
  ): Promise<Belief[]> {
    if (!query.trim()) return [];

    const res = await runThink(this.engine, {
      question: query,
      model: this.chatModel,
      rounds: 1,
    });

    const seen = new Set<string>();
    const out: Belief[] = [];
    for (const c of res.citations ?? []) {
      const id = c.page_slug;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (opts?.excludeIds?.has(id)) continue;
      const belief = this.seedIndex.get(id);
      if (belief) out.push(belief);
    }
    return out;
  }
}

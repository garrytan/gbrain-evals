/**
 * baseAdapter.ts
 *
 * Shared base class for UniversalHttpAdapter and UniversalSessionAdapter.
 *
 * Owns everything that is identical across both adapters:
 *   - Provider config loading from providers.config.json
 *   - seedIndex management (loadFixture, seed)
 *   - All reader interface methods (searchText, expandRelationParticipants,
 *     listPinnedFacts, listPinnedOpenQuestions, listByScope, countActive)
 *   - buildContext orchestration
 *   - beliefToText serialization
 *
 * UniversalHttpAdapter extends this directly with no overrides.
 * UniversalSessionAdapter extends this and adds ingestBelief,
 * updateBeliefAliases, and overrides seed to include extra metadata fields.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Belief } from "./belief.js";

interface ProviderConfigJson {
  envVar: string;
  defaultUrl: string;
  seedDelayMs: number;
  beliefToText?: "canonical_name_aliases" | "content";
  supportsUpdate?: boolean;
  waitAfterSeed?: boolean;
}

// VENDORED EDIT (only change from upstream): co-locate the config one dir up
// (eval/precisionmembench/) instead of the original repo-root depth, since this
// file now lives at scorer/ not src/adapters/. See ATTRIBUTION.md.
const CONFIG_PATH = resolve(
  new URL(".", import.meta.url).pathname,
  "../providers.config.json",
);

const providerConfigs: Record<string, ProviderConfigJson> = JSON.parse(
  readFileSync(CONFIG_PATH, "utf8"),
);

export type ProviderName = keyof typeof providerConfigs;

export interface SeedResponseBody {
  [key: string]: unknown;
}

export interface SearchResult {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
}

export interface ContextBudget {
  maxBeliefs: number;
  maxPinnedFacts: number;
  maxQuestions: number;
}

const DEFAULT_BUDGET: ContextBudget = {
  maxBeliefs: 20,
  maxPinnedFacts: 10,
  maxQuestions: 15,
};

export interface BuiltContext {
  personaPrelude: string;
  pinnedFactsJson: string;
  relevantBeliefsJson: string;
  openQuestionsJson: string;
  beliefCount: number;
  questionCount: number;
}

export interface PersonaLookup {
  get(userId: string): Promise<{
    universal?: string;
    per_scope?: Record<string, string>;
  } | null>;
}

function projectLean(b: Belief): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: b._id,
    canonical_name: b.canonical_name,
    content: b.content,
    why_it_matters: b.why_it_matters,
  };
  if (b.type === "open_question" || b.type === "decision") out.type = b.type;
  return out;
}

function projectQuestion(q: Belief): Record<string, unknown> {
  return {
    id: q._id,
    canonical_name: q.canonical_name,
    content: q.content,
    scope: q.scope,
  };
}

export class BaseAdapter {
  protected readonly baseUrl: string;
  protected readonly seedDelayMs: number;
  protected readonly beliefToTextMode: "canonical_name_aliases" | "content";
  protected readonly supportsUpdate: boolean;
  protected readonly waitAfterSeed: boolean;
  protected seedIndex = new Map<string, Belief>();

  ingestionReport: { beliefId: string; latencyMs: number }[] = [];

  constructor(public readonly providerName: ProviderName) {
    const cfg = providerConfigs[providerName];
    this.baseUrl = process.env[cfg.envVar] ?? cfg.defaultUrl;
    this.seedDelayMs = cfg.seedDelayMs;
    this.beliefToTextMode = cfg.beliefToText ?? "canonical_name_aliases";
    this.supportsUpdate = cfg.supportsUpdate ?? false;
    this.waitAfterSeed = cfg.waitAfterSeed ?? false;
  }

  loadFixture(beliefs: Belief[]): void {
    for (const b of beliefs) this.seedIndex.set(b._id as string, b);
  }

  async seed(beliefs: Belief[]): Promise<void> {
    await fetch(`${this.baseUrl}/reset`, { method: "DELETE" });
    this.seedIndex.clear();
    this.ingestionReport = [];

    const total = beliefs.length;
    console.log(`\n⏳ Seeding ${total} beliefs to ${this.providerName}...\n`);

    for (let i = 0; i < total; i++) {
      const belief = beliefs[i];
      const beliefId = belief._id as string;
      this.seedIndex.set(beliefId, belief);

      const callStart = performance.now();

      const res = await fetch(`${this.baseUrl}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: this.beliefToText(belief),
          user_id: belief.user_id as string,
          metadata: this.seedMetadata(belief),
          aliases: belief.aliases,
        }),
      });

      const body = (await res.json()) as SeedResponseBody;
      const overheadMs = (body.db_overhead_ms as number) || 0;
      const latencyMs =
        Math.round((performance.now() - callStart - overheadMs) * 100) / 100;
      this.ingestionReport.push({ beliefId, latencyMs });

      const pct = Math.round(((i + 1) / total) * 100);
      process.stdout.write(
        `\r  [${i + 1}/${total}] ${pct}% — ${beliefId} (${latencyMs}ms)`,
      );

      await new Promise((r) => setTimeout(r, this.seedDelayMs));
    }
    const totalMs = this.ingestionReport.reduce((s, r) => s + r.latencyMs, 0);
    console.log(
      `\n\n✅ Seeded ${total} beliefs in ${(totalMs / 1000).toFixed(1)}s\n`,
    );

    if (this.waitAfterSeed) {
      console.log(`⏳ Waiting for ${this.providerName} to finish indexing...`);
      const waitStart = performance.now();
      await fetch(`${this.baseUrl}/wait`, { method: "POST" });
      const waitMs = Math.round(performance.now() - waitStart);
      console.log(`✅ Indexing complete (${(waitMs / 1000).toFixed(1)}s)\n`);
    }
  }

  /**
   * Metadata sent with each /add call during seeding.
   * UniversalSessionAdapter overrides this to include extra fields.
   */
  protected seedMetadata(belief: Belief): Record<string, unknown> {
    return { beliefId: belief._id, scope: belief.scope[0] };
  }

  async buildContext(
    userId: string,
    scope: string[],
    rawQuery: string,
    persona: PersonaLookup,
    budget: Partial<ContextBudget> = {},
  ): Promise<BuiltContext> {
    const b: ContextBudget = { ...DEFAULT_BUDGET, ...budget };

    const [personaDoc, pinnedFacts, questions] = await Promise.all([
      persona.get(userId),
      this.listPinnedFacts(userId, scope),
      this.listPinnedOpenQuestions(userId, scope),
    ]);

    const pinnedIds = new Set(pinnedFacts.map((f) => f._id as string));

    const rawResults =
      rawQuery.trim() && b.maxBeliefs > 0
        ? await this.searchText(userId, rawQuery, {
            limit: b.maxBeliefs,
            excludeIds: pinnedIds,
            scope: scope[0],
          })
        : [];

    const expansions =
      rawResults.length > 0
        ? await this.expandRelationParticipants(userId, rawResults, scope, {
            excludeIds: new Set([
              ...pinnedIds,
              ...rawResults.map((r) => r._id as string),
            ]),
          })
        : [];

    const allRelevant = [...rawResults, ...expansions];
    const cap = b.maxBeliefs;
    const cappedPinned = pinnedFacts.slice(0, cap);
    const cappedRelevant = allRelevant.slice(
      0,
      Math.max(0, cap - cappedPinned.length),
    );

    return {
      personaPrelude: personaDoc?.universal ?? "",
      pinnedFactsJson: JSON.stringify(cappedPinned.map(projectLean)),
      relevantBeliefsJson: JSON.stringify(cappedRelevant.map(projectLean)),
      openQuestionsJson: JSON.stringify(
        questions.slice(0, b.maxQuestions).map(projectQuestion),
      ),
      beliefCount: cappedPinned.length + cappedRelevant.length,
      questionCount: Math.min(questions.length, b.maxQuestions),
    };
  }

  async searchText(
    userId: string,
    query: string,
    opts?: { limit?: number; excludeIds?: Set<string>; scope?: string },
  ): Promise<Belief[]> {
    if (!query.trim()) return [];

    const res = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        user_id: userId,
        limit: opts?.limit ?? 20,
        scope: opts?.scope,
      }),
    });

    const body = (await res.json()) as { results?: unknown };
    const rawResults = Array.isArray(body.results)
      ? body.results
      : Array.isArray(body)
        ? body
        : [];

    const seen = new Set<string>();

    return (rawResults as SearchResult[])
      .map((r) => {
        const beliefId = r.id;
        if (!beliefId) return null;
        if (seen.has(beliefId)) return null;
        seen.add(beliefId);
        if (opts?.excludeIds?.has(beliefId)) return null;
        return this.seedIndex.get(beliefId) ?? null;
      })
      .filter((b): b is Belief => b !== null);
  }

  async expandRelationParticipants(
    userId: string,
    relationBeliefs: Belief[],
    scope?: string[],
    opts?: { excludeIds?: Set<string> },
  ): Promise<Belief[]> {
    const relations = relationBeliefs.filter((b) => b.type === "relation");
    if (relations.length === 0) return [];

    const results: Belief[] = [];
    for (const rel of relations) {
      for (const id of (rel.participants as string[]) ?? []) {
        if (opts?.excludeIds?.has(id)) continue;
        const belief = this.seedIndex.get(id);
        if (!belief) continue;
        if (belief.user_id !== userId) continue;
        if (
          scope?.length &&
          !(belief.scope as string[]).some((s) => scope.includes(s))
        )
          continue;
        results.push(belief);
      }
    }
    return results;
  }

  async listPinnedFacts(userId: string, scope: string[]): Promise<Belief[]> {
    return [...this.seedIndex.values()].filter(
      (b) =>
        b.user_id === userId &&
        b.pinned === true &&
        b.type !== "open_question" &&
        !b.superseded_by &&
        !b.resolved_at &&
        (b.scope as string[]).some((s) => scope.includes(s)),
    );
  }

  async listPinnedOpenQuestions(
    userId: string,
    scope: string[],
  ): Promise<Belief[]> {
    return [...this.seedIndex.values()].filter(
      (b) =>
        b.user_id === userId &&
        b.type === "open_question" &&
        b.pinned === true &&
        !b.resolved_at &&
        (b.scope as string[]).some((s) => scope.includes(s)),
    );
  }

  async listByScope(userId: string, scope: string[]): Promise<Belief[]> {
    return [...this.seedIndex.values()].filter(
      (b) =>
        b.user_id === userId &&
        (b.scope as string[]).some((s) => scope.includes(s)),
    );
  }

  async countActive(userId: string): Promise<number> {
    return [...this.seedIndex.values()].filter((b) => b.user_id === userId)
      .length;
  }

  protected beliefToText(belief: Belief): string {
    const aliases = (belief.aliases as string[]) ?? [];
    const parts = [
      belief.canonical_name as string,
      ...aliases,
      belief.content as string,
      belief.why_it_matters as string,
    ].filter(Boolean);
    return parts.join(" ");
  }
}

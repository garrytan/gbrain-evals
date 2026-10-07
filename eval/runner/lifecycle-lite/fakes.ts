/**
 * lifecycle-lite mutation kit: an honest reference memory and fake systems
 * that each cheat in one way. The phase gate (test/eval/lifecycle-lite.test.ts)
 * runs the real runner and scorer over every one of them and requires the
 * honest reference to pass every check and every fake to fail the check its
 * cheat should trip.
 *
 * The honest reference is a temporal fact store. It keeps every sentence a
 * user turn states as one fact dated with the session's event time. A fact
 * of the form "<Name> Example ... lives in <X>" or "... works at <X>" has a
 * key (person and relation); a later-dated fact with the same key supersedes
 * it, so the earlier one is returned with `valid_to` set to the later date.
 * Retrieval ranks facts by shared words with the question, skips facts dated
 * after the query time, and returns the top `k`. Deleting a source removes
 * its facts, and supersession is recomputed from what remains. It reads only
 * what crosses the sanitizer: dated turns and the question.
 *
 * Fakes, as the plan names them (PLAN.md, phase 6), plus two from the shared
 * scorer kit (eval/runner/mutation-kit.ts):
 *   never-deletes       /delete_source answers "deleted" and removes nothing;
 *   deletes-everything  one delete empties every namespace;
 *   deletes-namespace   one delete empties the namespace it names;
 *   stale-value         a later value for a known key is dropped: the first
 *                       value stays current forever;
 *   serves-both         no supersession: old and new values both active;
 *   forgets-on-restart  a restart loses all state;
 *   ignores-dates       event time and query time are ignored: items carry
 *                       no dates and the latest arrival wins;
 *   empty               stores nothing;
 *   always-refuse       every retrieval fails.
 *
 * Everything here is a test fixture: its scores say nothing about any real
 * memory system.
 */
import { SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type Item, type MemorySystem, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from '../systems/types.ts';
import { FAKE_CAPABILITIES } from '../systems/fake.ts';

/** A system whose state survives (or, for one fake, does not survive) a restart the runner asks for. */
export interface Restartable { restart(): Promise<void> }
export const isRestartable = (s: unknown): s is Restartable => typeof (s as Restartable)?.restart === 'function';

export const MUTATION_FAKES = ['never-deletes', 'deletes-everything', 'deletes-namespace', 'stale-value', 'serves-both', 'forgets-on-restart', 'ignores-dates', 'empty', 'always-refuse'] as const;
export type MutationFake = typeof MUTATION_FAKES[number];

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 2));
const KEYED = /\b([A-Z][a-z]+ Example)\b.*?\b(lives in|works at)\s+(.+?)\.?$/;

interface Fact { id: string; source: string; text: string; key: string | null; event_time: string | null; arrival: number; words: Set<string> }

export class HonestReferenceSystem implements MemorySystem, Restartable {
  readonly name: string = 'lifecycle-honest-reference';
  protected store = new Map<string, Fact[]>();
  protected arrivals = 0;
  restarts = 0;

  static readonly POLICIES = { 'vendor-default': { settings: { k: 10 } }, 'fixed-evidence': { settings: { k: 50 } } };

  async capabilities(): Promise<CapabilityRecord> {
    return {
      ...structuredClone(FAKE_CAPABILITIES), system: this.name, provenance: { status: 'exact', mechanism: 'one fact per user sentence, citing its session' },
      readiness: 'synchronous', namespace: 'in-memory map key', retrieval_policies: structuredClone(HonestReferenceSystem.POLICIES),
    };
  }

  async reset(ns: string): Promise<void> { this.store.delete(ns); }

  /** Facts one session states: every sentence of its user turns. */
  protected parse(session: SessionInput, eventTime: string | null): Fact[] {
    const sentences = session.turns.filter(t => t.role === 'user').flatMap(t => t.content.split(/(?<=[.?!])\s+/)).map(s => s.trim()).filter(Boolean);
    return sentences.map((text, k) => {
      const m = text.match(KEYED);
      return { id: `${session.source_id}#${k}`, source: session.source_id, text, key: m ? `${m[1]}|${m[2]}` : null, event_time: eventTime, arrival: this.arrivals++, words: words(text) };
    });
  }

  protected admit(ns: string, facts: Fact[]): void {
    const list = this.store.get(ns) ?? [];
    list.push(...facts);
    this.store.set(ns, list);
  }

  async ingestSession(ns: string, session: SessionInput, eventTime: string | null): Promise<IngestResult> {
    const facts = this.parse(session, eventTime);
    this.admit(ns, facts);
    return { items_created: facts.length, warnings: [], errors: [], completeness: 'known' };
  }

  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }

  /** The date a later fact with the same key replaced this one, or null. */
  protected supersededAt(fact: Fact, all: readonly Fact[]): string | null {
    if (!fact.key || !fact.event_time) return null;
    const later = all.filter(f => f.key === fact.key && f.event_time && f.event_time > fact.event_time!).map(f => f.event_time!).sort();
    return later[0] ?? null;
  }

  protected visible(fact: Fact, question: PublicQuestion): boolean {
    return !question.query_time || !fact.event_time || fact.event_time <= question.query_time;
  }

  protected item(fact: Fact, all: readonly Fact[], rank: number): Item {
    return { id: fact.id, rank, type: 'fact', text: fact.text, source_ids: [fact.source], valid_from: fact.event_time, valid_to: this.supersededAt(fact, all), provenance_status: 'exact' };
  }

  async retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    if (policy?.mode !== 'vendor-default' && policy?.mode !== 'fixed-evidence') throw new SystemError('invalid_request', 'policy.mode must be vendor-default or fixed-evidence', 400);
    const k = Number(policy.settings?.k || HonestReferenceSystem.POLICIES[policy.mode].settings.k);
    const all = this.store.get(ns) ?? [];
    const q = words(question.text);
    const ranked = all.filter(f => this.visible(f, question))
      .map(f => ({ f, score: [...q].filter(w => f.words.has(w)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.f.event_time ?? '').localeCompare(a.f.event_time ?? '') || a.f.id.localeCompare(b.f.id));
    return { items: ranked.slice(0, k).map(({ f }, i) => this.item(f, all, i + 1)), applied_settings: { k }, truncated: false };
  }

  async deleteSource(ns: string, sourceId: string): Promise<DeleteResult> {
    const all = this.store.get(ns) ?? [];
    const kept = all.filter(f => f.source !== sourceId);
    this.store.set(ns, kept);
    return { status: all.length > kept.length ? 'deleted' : 'partial', receipt: { removed: all.length - kept.length } };
  }

  async restart(): Promise<void> { this.restarts++; }
}

class NeverDeletes extends HonestReferenceSystem {
  readonly name = 'fake-never-deletes';
  async deleteSource(): Promise<DeleteResult> { return { status: 'deleted', receipt: { removed: 0 } }; }
}

class DeletesEverything extends HonestReferenceSystem {
  readonly name = 'fake-deletes-everything';
  async deleteSource(): Promise<DeleteResult> { this.store.clear(); return { status: 'deleted', receipt: {} }; }
}

class DeletesNamespace extends HonestReferenceSystem {
  readonly name = 'fake-deletes-namespace';
  async deleteSource(ns: string): Promise<DeleteResult> { this.store.delete(ns); return { status: 'deleted', receipt: {} }; }
}

class StaleValue extends HonestReferenceSystem {
  readonly name = 'fake-stale-value';
  protected admit(ns: string, facts: Fact[]): void {
    const known = new Set((this.store.get(ns) ?? []).map(f => f.key).filter(Boolean));
    super.admit(ns, facts.filter(f => !f.key || !known.has(f.key)));
  }
}

class ServesBoth extends HonestReferenceSystem {
  readonly name = 'fake-serves-both';
  protected supersededAt(): string | null { return null; }
}

class ForgetsOnRestart extends HonestReferenceSystem {
  readonly name = 'fake-forgets-on-restart';
  async restart(): Promise<void> { this.restarts++; this.store.clear(); }
}

class IgnoresDates extends HonestReferenceSystem {
  readonly name = 'fake-ignores-dates';
  protected admit(ns: string, facts: Fact[]): void {
    const keys = new Set(facts.map(f => f.key).filter(Boolean));
    this.store.set(ns, (this.store.get(ns) ?? []).filter(f => !f.key || !keys.has(f.key)));
    super.admit(ns, facts.map(f => ({ ...f, event_time: null })));
  }
  protected visible(): boolean { return true; }
}

class Empty extends HonestReferenceSystem {
  readonly name = 'fake-empty';
  protected admit(): void { /* stores nothing */ }
}

class AlwaysRefuse extends HonestReferenceSystem {
  readonly name = 'fake-always-refuse';
  async retrieve(): Promise<RetrieveResult> { throw new SystemError('product_error', 'this fake refuses every retrieval'); }
}

export function mutationFake(kind: MutationFake): HonestReferenceSystem {
  switch (kind) {
    case 'never-deletes': return new NeverDeletes();
    case 'deletes-everything': return new DeletesEverything();
    case 'deletes-namespace': return new DeletesNamespace();
    case 'stale-value': return new StaleValue();
    case 'serves-both': return new ServesBoth();
    case 'forgets-on-restart': return new ForgetsOnRestart();
    case 'ignores-dates': return new IgnoresDates();
    case 'empty': return new Empty();
    case 'always-refuse': return new AlwaysRefuse();
  }
}

/** The check each fake's cheat must trip (the phase gate requires that exact check to fail). */
export const EXPECTED_FAILURE: Record<MutationFake, Array<'update' | 'asof' | 'forget' | 'survivors' | 'restart'>> = {
  'never-deletes': ['forget'],
  'deletes-everything': ['survivors', 'update'],
  'deletes-namespace': ['survivors', 'update'],
  'stale-value': ['update'],
  'serves-both': ['update'],
  'forgets-on-restart': ['restart', 'survivors', 'update'],
  'ignores-dates': ['asof'],
  empty: ['update', 'forget', 'survivors'],
  'always-refuse': ['update', 'asof', 'forget', 'survivors'],
};

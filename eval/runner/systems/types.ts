/**
 * The `MemorySystem` contract of the open-source memory shootout
 * (docs/plans/2026-10-05-oss-memory-shootout/PLAN.md, "Architecture"; wire
 * form in eval/systems/PROTOCOL.md).
 *
 * Everything that crosses into a system is already sanitized: opaque
 * namespace and source ids (`ns-…`, `src-…`), dated turns with speaker roles,
 * and a `PublicQuestion` (text and date only). Gold ids, categories, answers
 * and abstention markers never appear in these types.
 *
 * Updates arrive as ordinary dated sessions, so there is no `update()`.
 */

export const PROTOCOL_VERSION = 1;

export type ErrorKind = 'unsupported' | 'product_error' | 'timeout' | 'invalid_request' | 'budget';
export const ERROR_KINDS: readonly ErrorKind[] = ['unsupported', 'product_error', 'timeout', 'invalid_request', 'budget'];

/** A typed failure from a system; `kind` decides the canonical outcome (product failure, harness failure or budget). */
export class SystemError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'SystemError';
  }
}

export interface Turn { role: 'user' | 'assistant' | 'system'; speaker: string; content: string }

/** One session as a system receives it; its date travels separately as `event_time`. */
export interface SessionInput { source_id: string; turns: Turn[] }

export type Completeness = 'known' | 'unknown' | 'degraded';

export interface IngestResult { items_created: number; warnings: string[]; errors: string[]; completeness: Completeness; service_ms?: number }

/** `raw` holds whatever else the system reported about its quiesce barrier (gbrain-defaults: every doctor round). */
export interface FinishResult { ready: boolean; waited_ms: number; completeness: Completeness; service_ms?: number; raw?: Record<string, unknown> }

/** What a question looks like to a system: its text and the date it is asked. */
export interface PublicQuestion { text: string; query_time: string | null }

/** A named, versioned retrieval policy with the resolved per-vendor settings. */
export interface RetrievalPolicy { name: string; mode: 'vendor-default' | 'fixed-evidence'; settings: Record<string, unknown> }

export type ProvenanceStatus = 'exact' | 'partial' | 'unavailable';
export type ItemType = 'fact' | 'episode' | 'chunk' | 'note' | 'entity' | 'observation' | 'page';

/** One piece of returned evidence in the system's own rank order. */
export interface Item {
  id: string;
  rank: number;
  type: ItemType;
  text: string;
  /** Sources this namespace ingested; empty when provenance is unavailable. */
  source_ids: string[];
  valid_from: string | null;
  /** Set when the system marks the fact superseded. */
  valid_to: string | null;
  provenance_status: ProvenanceStatus;
}

export interface RetrieveResult { items: Item[]; applied_settings: Record<string, unknown>; truncated: boolean; raw?: unknown; service_ms?: number }

/** A system's own answer (optional `POST /answer`, PROTOCOL.md "Own answer"): `mode` names the route, `model` the reader when the route takes one. */
export interface OwnAnswerRequest { mode: string; model?: string | null }

export interface OwnAnswer {
  /** The full answer text. */
  text: string;
  /** `scored` (also a product-degraded answer, named by `degraded`) or `harness_invalid` (retried under the outcome rules). */
  outcome: 'scored' | 'harness_invalid';
  degraded: string | null;
  /** Ingested sources the answer cites. */
  source_ids: string[];
  /** The model that answered, as the system reports it. */
  model: string | null;
  usage: { input: number; output: number };
  usd: number | null;
  service_ms?: number;
  raw?: Record<string, unknown>;
}

/** A system that serves its own answer route; `capabilities().answer.modes` lists the modes the running stack serves. */
export interface OwnAnswerSystem extends MemorySystem {
  answer(ns: string, question: PublicQuestion, request: OwnAnswerRequest): Promise<OwnAnswer>;
}

/** The own-answer modes a capability record advertises (none when the system has no answer route). */
export function answerModes(cap: Pick<CapabilityRecord, 'answer'>): string[] {
  const modes: unknown = cap.answer?.modes;
  return Array.isArray(modes) ? modes.filter((m): m is string => typeof m === 'string') : [];
}

export interface DeleteResult { status: 'deleted' | 'partial' | 'unsupported'; receipt: Record<string, unknown>; service_ms?: number }

export interface CapabilityRecord {
  system: string;
  protocol: number;
  versions: Record<string, string | null>;
  configs: Record<string, { model_roles: Record<string, unknown>; notes?: string; unsettable?: string[] }>;
  time: 'native' | 'in-text' | 'none';
  provenance: { status: ProvenanceStatus; mechanism: string };
  delete: 'native' | 'public-api-composition' | 'unsupported';
  readiness: string;
  namespace: string;
  parallel_namespaces: boolean;
  /** Per mode: `{ settings: { knob: value }, ...documentation }`; the harness sends only `settings`. */
  retrieval_policies: Record<string, Record<string, unknown>>;
  streaming: 'disabled' | 'supported';
  telemetry_off: string[];
  agent_surface: { kind: 'vendor-mcp' | 'harness-mcp' | 'native-agent' | 'none'; transport?: 'stdio' | 'http'; version?: string };
  deviations_from_vendor_code: string[];
  /** Present when the system serves `POST /answer`: the modes the running stack serves and the model each answers with when the request names none. */
  answer?: { modes: string[]; models?: Record<string, string | null> };
  [extra: string]: unknown;
}

export interface MemorySystem {
  /** Stable adapter name recorded in rows and receipts. */
  readonly name: string;
  capabilities(): Promise<CapabilityRecord>;
  /** Empty the namespace, including pending background work. */
  reset(ns: string): Promise<void>;
  /** Sessions within one namespace arrive one at a time, in event-time order. */
  ingestSession(ns: string, session: SessionInput, event_time: string | null): Promise<IngestResult>;
  /** Wait for the system's own quiescence signal; a timeout is an outcome, never a pass. */
  finishIngest(ns: string, timeoutS?: number): Promise<FinishResult>;
  retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult>;
  deleteSource(ns: string, sourceId: string): Promise<DeleteResult>;
  close?(): Promise<void>;
}

/** True for a system with no passive memory API (a native agent such as the agent runtime): every passive call answers `unsupported`. */
export function passiveUnsupported(cap: Pick<CapabilityRecord, 'agent_surface' | 'retrieval_policies'>): boolean {
  const policies = Object.values(cap.retrieval_policies ?? {});
  return cap.agent_surface?.kind === 'native-agent' && policies.length > 0 && policies.every(p => p?.supported === false);
}

/** Documentation keys a pre-`settings` capability record keeps beside its knobs; never sent as settings. */
const POLICY_DOC_KEYS = new Set(['notes', 'maps_to', 'resolved', 'why', 'api', 'supported', 'description']);

/**
 * The knob map for one retrieval policy: the record's `settings` object
 * (PROTOCOL.md), or, for a record written before `settings` existed, the
 * entry without its documentation keys. `source` says which, for the receipt.
 */
export function policyKnobs(entry: Record<string, unknown> | undefined): { settings: Record<string, unknown>; source: 'settings' | 'flattened' | 'none' } {
  if (!entry) return { settings: {}, source: 'none' };
  if (entry.settings && typeof entry.settings === 'object' && !Array.isArray(entry.settings)) return { settings: { ...(entry.settings as Record<string, unknown>) }, source: 'settings' };
  return { settings: Object.fromEntries(Object.entries(entry).filter(([k]) => !POLICY_DOC_KEYS.has(k))), source: 'flattened' };
}

export const ITEM_TYPES: readonly ItemType[] = ['fact', 'episode', 'chunk', 'note', 'entity', 'observation', 'page'];

/** Shape check for one returned item; throws a `product_error` naming the defect. */
export function checkItem(raw: unknown, index: number): Item {
  const fail = (why: string): never => { throw new SystemError('product_error', `item ${index}: ${why}`); };
  if (!raw || typeof raw !== 'object') fail('not an object');
  const i = raw as Record<string, unknown>;
  if (typeof i.id !== 'string' || !i.id) fail('id must be a non-empty string');
  if (typeof i.rank !== 'number' || !Number.isInteger(i.rank) || i.rank < 1) fail('rank must be a positive integer');
  if (!ITEM_TYPES.includes(i.type as ItemType)) fail(`type ${JSON.stringify(i.type)} is not one of ${ITEM_TYPES.join(', ')}`);
  if (typeof i.text !== 'string') fail('text must be a string');
  if (!Array.isArray(i.source_ids) || i.source_ids.some(s => typeof s !== 'string')) fail('source_ids must be an array of strings');
  if (!['exact', 'partial', 'unavailable'].includes(i.provenance_status as string)) fail('provenance_status must be exact, partial or unavailable');
  if (i.provenance_status === 'unavailable' && (i.source_ids as string[]).length) fail('provenance unavailable but source_ids given');
  for (const k of ['valid_from', 'valid_to'] as const) if (i[k] !== undefined && i[k] !== null && typeof i[k] !== 'string') fail(`${k} must be a string or null`);
  return { id: i.id as string, rank: i.rank as number, type: i.type as ItemType, text: i.text as string, source_ids: [...(i.source_ids as string[])],
    valid_from: (i.valid_from as string | null | undefined) ?? null, valid_to: (i.valid_to as string | null | undefined) ?? null, provenance_status: i.provenance_status as ProvenanceStatus };
}

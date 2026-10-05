/**
 * Protocol v1 client (eval/systems/PROTOCOL.md): a `MemorySystem` backed by
 * a shim over HTTP. Vendor code never enters the Bun process.
 *
 * Before any request leaves, the client checks that namespace and source ids
 * are opaque and, given the sanitizer's forbidden markers, that the body
 * carries none of them (the captured-request tripwire). Error responses map
 * to `SystemError` with the shim's `kind`; a malformed response is a product
 * error; a network failure or a deadline is a `timeout`. Connections are not
 * reused: the Python shim base speaks HTTP/1.0 and closes each one.
 */
import { findLeaks, NS_RE, SanitizerLeakError, SRC_RE } from './sanitize.ts';
import { checkItem, ERROR_KINDS, SystemError, type CapabilityRecord, type DeleteResult, type ErrorKind, type FinishResult, type IngestResult, type MemorySystem, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from './types.ts';

type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpSystemOptions {
  name?: string;
  /** Forbidden markers from the sanitizer; a body containing one is never sent. */
  markers?: readonly string[];
  fetchImpl?: Send;
  timeoutMs?: number;
  /** Every request body as sent, for leak tests. */
  onRequest?: (path: string, body: string) => void;
}

const COMPLETENESS = ['known', 'unknown', 'degraded'];

export class HttpMemorySystem implements MemorySystem {
  readonly name: string;
  private base: string;
  constructor(baseUrl: string, private options: HttpSystemOptions = {}) {
    this.base = baseUrl.replace(/\/$/, '');
    this.name = options.name ?? `http:${this.base}`;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, any>> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined) {
      const leaks = findLeaks(text, this.options.markers ?? []);
      if (leaks.length) throw new SanitizerLeakError(`${method} ${path}`, leaks.length);
      this.options.onRequest?.(path, text);
    }
    let res: Response;
    try {
      res = await (this.options.fetchImpl ?? fetch)(`${this.base}${path}`, {
        method, headers: { connection: 'close', ...(text === undefined ? {} : { 'content-type': 'application/json' }) }, body: text, keepalive: false,
        signal: AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs ?? 600_000),
      });
    } catch (e) { throw new SystemError('timeout', `${method} ${path}: ${(e as Error).message}`); }
    let json: any;
    try { json = await res.json(); } catch { throw new SystemError('product_error', `${method} ${path}: HTTP ${res.status} with a non-JSON body`, res.status); }
    if (!res.ok || json?.error) {
      const kind = ERROR_KINDS.includes(json?.error?.kind) ? json.error.kind as ErrorKind : 'product_error';
      throw new SystemError(kind, `${method} ${path}: ${String(json?.error?.message ?? `HTTP ${res.status}`).slice(0, 500)}`, res.status);
    }
    if (!json || typeof json !== 'object') throw new SystemError('product_error', `${method} ${path}: response is not an object`);
    return json;
  }

  private ns(ns: string) { if (!NS_RE.test(ns)) throw new SystemError('invalid_request', 'namespace id is not opaque (ns-<16 hex>)'); return ns; }

  async capabilities(): Promise<CapabilityRecord> {
    const c = await this.call('GET', '/capabilities');
    if (c.protocol !== 1 || typeof c.system !== 'string') throw new SystemError('product_error', 'capability record must name its system and protocol 1');
    const { service_ms: _ms, ...record } = c;
    return record as CapabilityRecord;
  }

  async health(): Promise<Record<string, unknown>> { return this.call('GET', '/health'); }

  async reset(ns: string): Promise<void> { await this.call('POST', '/reset', { ns: this.ns(ns) }); }

  async ingestSession(ns: string, session: SessionInput, event_time: string | null): Promise<IngestResult> {
    if (!SRC_RE.test(session.source_id)) throw new SystemError('invalid_request', 'source id is not opaque (src-<16 hex>)');
    const r = await this.call('POST', '/ingest', { ns: this.ns(ns), session: { source_id: session.source_id, event_time, turns: session.turns } });
    if (!COMPLETENESS.includes(r.completeness)) throw new SystemError('product_error', 'ingest must report completeness');
    return { items_created: Number(r.items_created ?? 0), warnings: r.warnings ?? [], errors: r.errors ?? [], completeness: r.completeness, service_ms: r.service_ms };
  }

  async finishIngest(ns: string, timeoutS = 600): Promise<FinishResult> {
    const r = await this.call('POST', '/finish', { ns: this.ns(ns), timeout_s: timeoutS }, (timeoutS + 60) * 1000);
    if (!COMPLETENESS.includes(r.completeness)) throw new SystemError('product_error', 'finish must report completeness');
    return { ready: r.ready === true, waited_ms: Number(r.waited_ms ?? 0), completeness: r.completeness, service_ms: r.service_ms };
  }

  async retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    const r = await this.call('POST', '/retrieve', { ns: this.ns(ns), question: question.text, query_time: question.query_time, policy });
    if (!Array.isArray(r.items)) throw new SystemError('product_error', 'retrieve must return items');
    return { items: r.items.map((i: unknown, k: number) => checkItem(i, k)), applied_settings: r.applied_settings ?? {}, truncated: r.truncated === true, raw: r.raw, service_ms: r.service_ms };
  }

  async deleteSource(ns: string, sourceId: string): Promise<DeleteResult> {
    if (!SRC_RE.test(sourceId)) throw new SystemError('invalid_request', 'source id is not opaque (src-<16 hex>)');
    const r = await this.call('POST', '/delete_source', { ns: this.ns(ns), source_id: sourceId });
    if (!['deleted', 'partial', 'unsupported'].includes(r.status)) throw new SystemError('product_error', 'delete_source must report deleted, partial or unsupported');
    return { status: r.status, receipt: r.receipt ?? {}, service_ms: r.service_ms };
  }
}

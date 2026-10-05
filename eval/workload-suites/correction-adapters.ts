/**
 * B2 correction adapters for the two systems, over the harness providers
 * (eval/harness-provider/mpw_workload/bridge.py) and the metering proxy.
 *
 * gbrain (one hermetic PGLite brain per unit, stdio MCP, zero-LLM write path):
 *   ingest / write        conversation pages, the provider's ingest for the
 *                         base records and `put_page` for each later write
 *   edit_document         `put_page` of the edited conversation under the same
 *                         slug, against the page's current revision
 *   sync                  the brain is database-backed (no repository), so
 *                         `put_page` already re-chunks and re-embeds the page;
 *                         the step waits until no chunk lacks an embedding
 *   locate                `recall` with `grep` = the old value (facts only)
 *   forget_located        `forget` each located fact id
 *   remember              `remember` the corrected statement with entity and
 *                         provenance; `replaces` only when the build's
 *                         `remember` schema has it (it does not at e8e1f66b,
 *                         so that arm reports not run)
 *   append_document       `put_page` of the correction conversation
 *
 * comparator (pinned server, one bank per unit, opaque ids):
 *   ingest / write        the provider's retain path with its completion barrier
 *   locate                list the bank's memories whose text holds the old value
 *   edit_or_invalidate    PATCH each located memory's text to the corrected
 *                         statement (the server edits; it invalidates only if
 *                         an edit is refused)
 *   retain_document       re-retain the edited conversation under its document id
 *   append_document       retain the correction conversation
 *
 * `retrieve` returns the exact context the reader sees, rendered as the
 * harness's RAG mode renders memories.
 */
import { countValue } from './common.ts';
import type { Bridge } from './bench-infra.ts';
import type { CorrectionAdapter, CorrectionArm, CorrectionItem, CorrectionStep, InspectReceipt, StepReceipt } from './corrections.ts';
import type { HarnessDocument, HarnessQuery } from './types.ts';

export interface RetrieveReceipt { context: string; tokens_cl100k: number; retrieve_ms: number; meta: Record<string, unknown> }

abstract class BridgeAdapter implements CorrectionAdapter {
  abstract readonly system: 'gbrain' | 'comparator';
  readonly retrievals: RetrieveReceipt[] = [];
  protected located = new Map<string, string[]>();
  constructor(protected bridge: Bridge, protected overrides: Record<string, unknown> = {}) {}
  abstract supports(arm: CorrectionArm): { ok: true } | { ok: false; reason: string };
  abstract write(unit: string, doc: HarnessDocument): Promise<void>;
  abstract step(unit: string, arm: CorrectionArm, step: CorrectionStep, item: CorrectionItem): Promise<StepReceipt>;
  async ingest(_unit: string, docs: readonly HarnessDocument[]): Promise<void> {
    await this.bridge.call('ingest', { docs });
  }
  async retrieve(unit: string, query: HarnessQuery): Promise<{ context: string }> {
    const r = await this.bridge.call<RetrieveReceipt>('retrieve', { unit, query: query.query, query_timestamp: query.meta.query_timestamp, overrides: this.overrides });
    this.retrievals.push(r);
    return { context: r.context };
  }
}

export class GbrainCorrectionAdapter extends BridgeAdapter {
  readonly system = 'gbrain' as const;
  #rememberParams: string[] | null = null;
  async rememberParams(unit: string): Promise<string[]> {
    this.#rememberParams ??= Object.keys((await this.bridge.call<Record<string, Record<string, unknown>>>('gbrain_tools', { unit })).remember ?? {});
    return this.#rememberParams;
  }
  /** Set after the first ingest: whether `remember` accepts `replaces` at this build. */
  hasReplaces: boolean | null = null;
  supports(arm: CorrectionArm): { ok: true } | { ok: false; reason: string } {
    if (arm.system !== 'gbrain') return { ok: false, reason: `${arm.id} is a ${arm.system} arm` };
    if (arm.id === 'gbrain-remember-replaces' && this.hasReplaces !== true) {
      return { ok: false, reason: 'the remember operation has no `replaces` parameter at the measured gbrain build' };
    }
    return { ok: true };
  }
  async write(unit: string, doc: HarnessDocument): Promise<void> {
    await this.bridge.call('gbrain_put', { unit, doc });
  }
  async step(unit: string, arm: CorrectionArm, step: CorrectionStep, item: CorrectionItem): Promise<StepReceipt> {
    const base = { item_id: item.item_id, arm: arm.id, op: step.op };
    switch (step.op) {
      case 'edit_document':
        await this.write(unit, item.edited_document);
        return { ...base, ok: true, detail: 'put_page with expected_revision' };
      case 'sync':
        return { ...base, ok: true, detail: 'database-backed brain: put_page re-chunked and re-embedded the page; embedding barrier passed' };
      case 'append_document':
        await this.write(unit, item.correction_document);
        return { ...base, ok: true };
      case 'locate': {
        const r = await this.bridge.call<{ result: { facts?: Array<{ fact_id?: string; id?: number; fact: string }> } }>('gbrain_call', { unit, tool: 'recall', args: { grep: item.locate.old_value, limit: 50 } });
        const ids = (r.result?.facts ?? []).filter(f => countValue(f.fact, item.locate.old_value) > 0).map(f => String(f.fact_id ?? f.id));
        this.located.set(item.item_id, ids);
        return { ...base, ok: true, located: ids.length, detail: ids.length ? undefined : 'no fact holds the old value (the conversation pages are the only record)' };
      }
      case 'forget_located': {
        for (const id of this.located.get(item.item_id) ?? []) await this.bridge.call('gbrain_call', { unit, tool: 'forget', args: { id, reason: 'corrected by the user' } });
        return { ...base, ok: true, located: (this.located.get(item.item_id) ?? []).length };
      }
      case 'remember': {
        const args: Record<string, unknown> = { fact: item.corrected_statement, entity: item.entity, provenance: `user correction, ${item.correction_timestamp.slice(0, 10)}` };
        if (step.replaces) {
          const ids = this.located.get(item.item_id) ?? [];
          if (ids.length) args.replaces = ids[0];
        }
        const r = await this.bridge.call<{ result: { status?: string } }>('gbrain_call', { unit, tool: 'remember', args });
        return { ...base, ok: true, detail: `remember status ${r.result?.status ?? 'unknown'}` };
      }
      default:
        return { ...base, ok: false, detail: `${step.op} is not a gbrain step` };
    }
  }
  async inspect(unit: string, item: CorrectionItem): Promise<InspectReceipt> {
    const r = await this.bridge.call<{ result: { facts?: Array<{ fact: string; expired_at?: string | null }> } }>('gbrain_call', { unit, tool: 'recall', args: { grep: item.locate.old_value, include_expired: true, limit: 50 } });
    const old = (r.result?.facts ?? []).filter(f => countValue(f.fact, item.locate.old_value) > 0);
    return { item_id: item.item_id, history_visible: old.some(f => f.expired_at), detail: `${old.length} facts hold the old value (${old.filter(f => f.expired_at).length} expired with an audit trail)` };
  }
}

interface ComparatorMemory { id: string; text: string; state?: string }

export class ComparatorCorrectionAdapter extends BridgeAdapter {
  readonly system = 'comparator' as const;
  supports(arm: CorrectionArm): { ok: true } | { ok: false; reason: string } {
    return arm.system === 'comparator' ? { ok: true } : { ok: false, reason: `${arm.id} is a ${arm.system} arm` };
  }
  async write(unit: string, doc: HarnessDocument): Promise<void> {
    await this.bridge.call('comparator_retain', { unit, doc });
  }
  async #memories(unit: string, q: string): Promise<ComparatorMemory[]> {
    const r = await this.bridge.call<{ status: number; body: { items?: ComparatorMemory[] } }>('comparator_http', { method: 'GET', unit, path: '/v1/default/banks/{bank}/memories/list', params: { q, limit: 100 } });
    if (r.status !== 200) throw new Error(`comparator memories/list HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return (r.body.items ?? []).filter(m => countValue(m.text, q) > 0 && m.state !== 'invalidated');
  }
  async step(unit: string, arm: CorrectionArm, step: CorrectionStep, item: CorrectionItem): Promise<StepReceipt> {
    const base = { item_id: item.item_id, arm: arm.id, op: step.op };
    switch (step.op) {
      case 'retain_document':
        await this.write(unit, item.edited_document);
        return { ...base, ok: true, detail: 're-retained under the original document id' };
      case 'append_document':
        await this.write(unit, item.correction_document);
        return { ...base, ok: true };
      case 'locate': {
        const hits = await this.#memories(unit, item.locate.old_value);
        this.located.set(item.item_id, hits.map(m => m.id));
        return { ...base, ok: true, located: hits.length };
      }
      case 'edit_or_invalidate_located': {
        const done: string[] = [];
        for (const id of this.located.get(item.item_id) ?? []) {
          const path = `/v1/default/banks/{bank}/memories/${encodeURIComponent(id)}`;
          const edit = await this.bridge.call<{ status: number; body: unknown }>('comparator_http', { method: 'PATCH', unit, path, body: { text: item.corrected_statement } });
          if (edit.status === 200) { done.push('edited'); continue; }
          const inv = await this.bridge.call<{ status: number; body: unknown }>('comparator_http', { method: 'PATCH', unit, path, body: { state: 'invalidated', reason: 'corrected by the user' } });
          done.push(inv.status === 200 ? 'invalidated' : `failed ${edit.status}/${inv.status}`);
        }
        if (done.includes('invalidated')) {
          await this.write(unit, { ...item.correction_document, id: `${item.correction_document.id}-statement`, messages: [{ role: 'user', content: item.corrected_statement }], content: `user: ${item.corrected_statement}` });
        }
        return { ...base, ok: !done.some(d => d.startsWith('failed')), located: done.length, detail: done.join(', ') || 'no memory holds the old value' };
      }
      default:
        return { ...base, ok: false, detail: `${step.op} is not a comparator step` };
    }
  }
  async inspect(unit: string, item: CorrectionItem): Promise<InspectReceipt> {
    const ids = this.located.get(item.item_id) ?? [];
    let visible = false;
    for (const id of ids) {
      const r = await this.bridge.call<{ status: number; body: unknown }>('comparator_http', { method: 'GET', unit, path: `/v1/default/banks/{bank}/memories/${encodeURIComponent(id)}/history` });
      if (r.status === 200 && JSON.stringify(r.body).includes(item.locate.old_value)) visible = true;
    }
    return { item_id: item.item_id, history_visible: visible, detail: `${ids.length} located memories; history ${visible ? 'shows' : 'does not show'} the old value` };
  }
}

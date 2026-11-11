/**
 * A write replayed under the request id gbrain's refusal names counts as a retry under the same id (refresh-barrier
 * preregistration, Amendment 7). Since v0.60.671.0 a refused write names the id to replay in its `fix.mcp`, minting one
 * when the call sent none; the scorer used to read a refused call's id from the agent's arguments only, so the replay of
 * the named id counted as reissued under a new id. The fixture is a real episode at gbrain cbca51e7 (v0.60.671.0) from
 * the GST-2427 control probe, with the transcript results of calls that weren't refused trimmed.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { namedRequestId, readResult, writeBehavior, type WriteCall } from '../../eval/runner/refresh-barrier/agent.ts';
import { rescoreRecord } from '../../eval/runner/refresh-barrier/rescore.ts';

const episode = () => JSON.parse(readFileSync(resolve(import.meta.dir, '../fixtures/refresh-barrier/named-replay-671-task-2001-t1.json'), 'utf8')) as Record<string, any>;
const NAMED = '3965e3fc-9bab-4b89-8cef-a31f495c6b4d';
const w = (o: Partial<WriteCall> & Pick<WriteCall, 'i' | 'cls'>): WriteCall =>
  ({ name: 'capture', request_id: null, tokens: ['F3'], code: null, retry_after_ms: null, t_ms: 0, ms: 0, error_pending: false, ...o });

describe('a replay of the request id the refusal names', () => {
  test('namedRequestId reads the replay id from the refusal\'s fix.mcp of the same tool, and nothing else', () => {
    const refusal = readResult(episode().transcript[3].result).body;
    expect(namedRequestId('capture', refusal)).toBe(NAMED);
    expect(namedRequestId('remember', refusal)).toBeNull();
    expect(namedRequestId('put_page', { code: 'pending_import', fix: { mcp: { tool: 'get_write_request', arguments: { request_id: 'r1' } } } })).toBeNull();
    expect(namedRequestId('put_page', { code: 'worktree_refreshing', fix: { argv: ['gbrain', 'sources', 'writer', 'status'] } })).toBeNull();
  });

  test('a refused call that sent no id, replayed under the id its refusal named, is a same-id retry and no reissue', () => {
    const b = writeBehavior([
      w({ i: 0, cls: 'refused_retryable', code: 'worktree_refreshing', retry_after_ms: 2000, named_request_id: NAMED, t_ms: 0, ms: 9800 }),
      w({ i: 1, request_id: NAMED, cls: 'committed', t_ms: 12000, ms: 50 }),
    ]);
    expect(b.reissues).toEqual([]);
    expect(b.refusals).toMatchObject([{ call: 0, next_call: 1, retried_same_request_id: true, outcome: 'retried_same_id' }]);
  });

  test('the v0.60.671.0 episode: the named-id replay passes both scorers, where the stored score had failed it on no_resend', () => {
    const rec = episode();
    expect(rec.nightly_score).toMatchObject({ pass: false, tokens_once: true, report_correct: true, no_resend: false, resent: ['F3'] });
    const r = rescoreRecord(rec);
    expect(r.writeCalls.find(c => c.i === 3)).toMatchObject({ name: 'capture', request_id: null, named_request_id: NAMED });
    expect(r.behavior.reissues).toEqual([]);
    expect(r.behavior.refusals).toMatchObject([{ call: 3, next_call: 7, retried_same_request_id: true, outcome: 'retried_same_id' }]);
    expect(r.nightly_score).toMatchObject({ pass: true, no_resend: true, resent: [] });
    expect(r.score).toMatchObject({ success: true, no_reissue: true, reissued: [] });
  });

  test('a replay under a genuinely new id after a refusal that named one is still reissued under a new id', () => {
    const rec = episode();
    rec.write_calls = rec.write_calls.map((c: WriteCall) => (c.i === 7 ? { ...c, request_id: 'a-new-id-the-agent-made-up' } : c));
    const r = rescoreRecord(rec);
    expect(r.writeCalls.find(c => c.i === 3)).toMatchObject({ named_request_id: NAMED });
    expect(r.behavior.reissues).toEqual([{ call: 7, fact: 'F3', earlier: 3 }]);
    expect(r.behavior.refusals).toMatchObject([{ call: 3, next_call: 7, retried_same_request_id: false, outcome: 'reissued_new_id' }]);
    expect(r.nightly_score).toMatchObject({ pass: false, no_resend: false, resent: ['F3'] });
    expect(r.score).toMatchObject({ success: false, reissued: ['F3'] });
  });
});

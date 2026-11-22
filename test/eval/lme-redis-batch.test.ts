import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'lme-redis-batch-'));
process.env.LME_REDIS_STATE_DIR = join(tmp, 'state');
process.env.LME_REDIS_MANIFEST_DIR = join(tmp, 'manifests');
const L = await import('../../eval/runner/batch/lme-redis.ts');

const msgs = (q: string, ctx: string) => [{ role: 'system', content: `You are a personal assistant...\nMemories:\n${ctx}` }, { role: 'user', content: q }];
function frozenDir(variant: Partial<Record<string, Record<string, string>>> = {}) {
  const dir = mkdtempSync(join(tmp, 'frozen-'));
  mkdirSync(join(dir, 'messages'));
  const order = ['q1', 'q2', 'q3'];
  writeFileSync(join(dir, 'order.json'), JSON.stringify(order));
  for (const arm of L.MEMORIES) {
    const lines = order.map(q => {
      const ctx = variant[arm]?.[q] ?? (arm === 'on' ? `off-${q}` : `${arm}-${q}`);
      const messages = msgs(`question ${q} — "quoted" é`, ctx);
      return JSON.stringify({ question_id: q, question_type: 'multi-session', arm, messages, messages_sha256: Bun.hash(JSON.stringify(messages)).toString(), context_sha256: 'x' });
    });
    writeFileSync(join(dir, 'messages', `${arm}.jsonl`), lines.join('\n') + '\n');
  }
  return dir;
}

describe('LongMemEval on Redis harness: batch bodies', () => {
  test('one request per distinct prompt: on reuses off where autocut kept the same context', () => {
    const frozen = L.loadFrozen(frozenDir({ on: { q2: 'cut-q2' } }));
    const { bodies, reuse } = L.readerBodies('opus', frozen);
    expect([...bodies.get('off')!.keys()]).toEqual(['q1', 'q2', 'q3']);
    expect([...bodies.get('on')!.keys()]).toEqual(['q2']);
    expect(reuse.on).toEqual({ q1: 'off', q3: 'off' });
    expect(bodies.has('agent-default')).toBe(false);
    expect(L.readerBodies('gpt4o', frozen).bodies.get('agent-default')!.size).toBe(3);
  });

  test('the bodies wrap the frozen messages byte for byte, with each reader\'s preregistered settings', () => {
    const frozen = L.loadFrozen(frozenDir());
    const line = frozen.lines.off.get('q1')!;
    const opus = L.readerBodies('opus', frozen).bodies.get('off')!.get('q1')! as any;
    expect(opus).toEqual({ model: 'claude-opus-5-5', max_tokens: 8192, system: line.messages[0].content, messages: [{ role: 'user', content: line.messages[1].content }] });
    const sol = L.readerBodies('sol', frozen).bodies.get('off')!.get('q1')! as any;
    expect(JSON.stringify(sol.messages)).toBe(JSON.stringify(line.messages));
    expect(sol).toEqual({ model: 'gpt-6.2-sol', messages: line.messages, max_completion_tokens: 16000 });
    const gpt4o = L.readerBodies('gpt4o', frozen).bodies.get('off')!.get('q1')! as any;
    expect(gpt4o).toEqual({ model: 'gpt-4o-2024-08-06', messages: line.messages, temperature: 0, max_tokens: 2048 });
  });

  test('a frozen file missing a question refuses to load', () => {
    const dir = frozenDir();
    const path = join(dir, 'messages', 'full.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').slice(1).join('\n'));
    expect(() => L.loadFrozen(dir)).toThrow(/full: 1 questions/);
  });

  test('build freezes one manifest per reader and arm and records the reuse', () => {
    const out = L.build(frozenDir({ on: { q3: 'cut-q3' } }));
    expect(out.map(r => r.arm)).toEqual(['gpt4o--off', 'gpt4o--on', 'gpt4o--agent-default', 'gpt4o--full', 'gpt4o--oracle', 'opus--off', 'opus--on', 'opus--full', 'opus--oracle', 'sol--off', 'sol--on', 'sol--full', 'sol--oracle', 'particle--off', 'particle--on', 'particle--full', 'particle--oracle']);
    expect(out.find(r => r.arm === 'sol--on')).toEqual({ arm: 'sol--on', requests: 1, reused: 2 });
    const reuse = JSON.parse(readFileSync(join(tmp, 'manifests', 'reuse.json'), 'utf8'));
    expect(reuse.gpt4o.on).toEqual({ q1: 'off', q2: 'off' });
  });
});

describe('LongMemEval on Redis harness: judges and stages', () => {
  test('judge requests follow the preregistered settings and R78 families', () => {
    const m = [{ role: 'user' as const, content: 'Is the model response correct? Answer yes or no only.' }] as [{ role: 'user'; content: string }];
    expect(L.judgeBodies('protocol', 'opus', [{ item_id: 'q1', messages: m }]).bodies.get('q1')).toEqual({ model: 'gpt-4o-2024-08-06', messages: m, temperature: 0, seed: 42, max_tokens: 10 });
    expect(L.judgeBodies('cross', 'opus', [{ item_id: 'q1', messages: m }]).bodies.get('q1')).toEqual({ model: 'gpt-6.2-astra', messages: m, max_completion_tokens: 2000, reasoning_effort: 'low' });
    expect(L.judgeBodies('cross', 'sol', [{ item_id: 'q1', messages: m }]).bodies.get('q1')).toEqual({ model: 'claude-opus-5-5', max_tokens: 2000, output_config: { effort: 'low' }, messages: m });
    expect([L.crossJudge('gpt4o'), L.crossJudge('sol'), L.crossJudge('opus'), L.crossJudge('particle')]).toEqual(['opus', 'opus', 'astra', 'astra']);
  });

  test('every reader and judge request has a list price, so the ledger can reserve its worst case', async () => {
    const { priceOf } = await import('../../eval/runner/batch/ledger.ts');
    const m = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] as any;
    for (const r of Object.values(L.READERS)) expect(priceOf(r.provider, r.body(m)).model).toBe(r.model);
    for (const j of Object.values(L.JUDGES)) expect(priceOf(j.provider, j.body([m[1]])).model).toBe(j.model);
    expect(priceOf('openai', L.JUDGES.astra.body([m[1]]))).toMatchObject({ input: 8, output: 40, cache_read: 0.4 });
  });

  test('verdict parses: strict first word for cross-family judges, Redis\'s substring rule beside it', () => {
    expect(['Yes.', 'no', ' NO, because', 'The answer is yes', '', null].map(L.strictVerdict)).toEqual([1, 0, 0, -1, -1, -1]);
    expect(["It doesn't give 5.\n\nno", 'It matches.\n\n**Yes**', 'Reasoning first.\nThe answer is no', 'Reasoning.\n\nno, it does not', 'Reasoning.\n\n'].map(L.strictVerdict)).toEqual([0, 1, -1, -1, -1]);
    expect(['Yes.', 'no', 'The answer is yes', 'nope', 'maybe', null].map(L.redisVerdict)).toEqual([1, 0, 1, 0, -1, -1]);
  });

  test('stages: the pilot is the last 25 in seed-42 order, the counted halves split at 250', () => {
    const order = Array.from({ length: 500 }, (_, i) => `q${i}`);
    expect(L.stageIds(order, 'pilot')).toEqual(order.slice(475));
    expect(L.stageIds(order, 'first-half')).toEqual(order.slice(0, 250));
    expect(L.stageIds(order, 'second-half')).toEqual(order.slice(250));
    expect(() => L.stageIds(order, 'some')).toThrow();
  });

  test('a truncated answer is kept and judged, a failed request is not an answer', () => {
    const manifest = { arm_id: 'opus--off', requests: [{ question_id: 'a' }, { question_id: 'b' }, { question_id: 'c' }] } as any;
    const results = new Map<string, any>([['a', { status: 'succeeded', text: 'cut off', finish: 'max_tokens', usage: null }], ['b', { status: 'errored', text: null, finish: null }]]);
    expect(L.answerRows(manifest, results).map(r => [r.question_id, r.answer, r.status, r.truncated])).toEqual([['a', 'cut off', 'succeeded', true], ['b', null, 'errored', false], ['c', null, 'not_run', false]]);
  });

  test('particle-1 sends the frozen system and user text, keeps a truncated answer and stops on a budget refusal', async () => {
    const dir = mkdtempSync(join(tmp, 'particle-'));
    const { gzipSync } = await import('node:zlib');
    const texts = ['a', 'b', 'c'].map(q => ({ question_id: q, system: `sys ${q}`, user: `user ${q}` }));
    writeFileSync(join(dir, 'off.texts.ndjson.gz'), gzipSync(texts.map(x => JSON.stringify(x)).join('\n') + '\n'));
    const sent: any[] = [];
    const client = {
      async chat(model: string, prompt: string, opts: any) {
        sent.push({ model, prompt, opts });
        if (prompt === 'user c') throw Object.assign(new Error('ledger refused'), { name: 'BudgetExceededError' });
        return { text: `answer to ${prompt}`, finish: prompt === 'user b' ? 'length' : 'stop', usage: { input: 1, output: 1 }, response_model: 'particle-ai/particle-1', cached: false, attempt_errors: [] } as any;
      },
    };
    const out = await L.runParticle('off', ['a', 'b', 'c'], client as any, dir);
    expect(out.stopped).toBe('ledger refused');
    expect(sent.map(s => [s.model, s.prompt, s.opts.system, s.opts.effort, s.opts.maxTokens]).sort()).toEqual([['particle:particle-1', 'user a', 'sys a', 'high', 32000], ['particle:particle-1', 'user b', 'sys b', 'high', 32000], ['particle:particle-1', 'user c', 'sys c', 'high', 32000]]);
    const rows = L.readJsonl<any>(join(dir, 'off.rows.jsonl'));
    expect(rows.map(r => [r.question_id, r.answer, r.truncated, r.status]).sort()).toEqual([['a', 'answer to user a', false, 'succeeded'], ['b', 'answer to user b', true, 'succeeded'], ['c', null, false, 'errored']]);
    const again = await L.runParticle('off', ['a', 'b', 'c'], client as any, dir);
    expect(again.ran).toBe(0);
  });

  test('the labeller\'s verdict is its last Label line', () => {
    expect(['Reasoning... Label: yes', 'Label: no\nWait. Label: **yes**', 'label:no', 'yes', null].map(L.parseLabel)).toEqual([1, 1, 0, -1, -1]);
  });

  test('a judge\'s real set spans every arm and holds 15 protocol-wrong answers where there are that many', () => {
    const arms = ['opus--off', 'opus--on', 'opus--full', 'opus--oracle', 'particle--off'];
    const cands = arms.flatMap(arm => Array.from({ length: 20 }, (_, i) => ({ key: `${arm}/q${i}`, arm, question_id: `q${i}`, protocol_wrong: i < 4 })));
    const picked = L.labelSelection(cands);
    expect(picked.length).toBe(48);
    expect(new Set(picked.map(p => p.key)).size).toBe(48);
    expect(new Set(picked.map(p => p.arm))).toEqual(new Set(arms));
    expect(picked.filter(p => p.protocol_wrong).length).toBeGreaterThanOrEqual(15);
    expect(L.labelSelection(cands)).toEqual(picked);
    const few = cands.map(c => ({ ...c, protocol_wrong: c.key === 'opus--off/q0' }));
    expect(L.labelSelection(few).filter(p => p.protocol_wrong).length).toBe(1);
  });

  test('an unknown arm is refused before anything is read', () => {
    expect(() => L.parseArm('opus--agent-default')).toThrow(/unknown arm/);
    expect(L.parseArm('gpt4o--agent-default')).toEqual({ reader: 'gpt4o', memories: 'agent-default' });
    expect(L.parseArm('particle--on')).toEqual({ reader: 'particle', memories: 'on' });
    expect(() => L.parseArm('particle--agent-default')).toThrow(/unknown arm/);
  });
});

describe('LongMemEval on Redis harness: counted stages refuse pilot leftovers', () => {
  test('a counted stage refuses while pilot or judge-check intents or particle rows remain, and a clean state passes', () => {
    const dir = mkdtempSync(join(tmp, 'held-'));
    const runs = { pilot: 'run-pilot', 'judge-check': 'run-jc', 'counted-first-half': 'run-c1' };
    expect(L.heldPilotWork('pilot', runs, ['run-pilot'], dir)).toBe('');
    expect(L.heldPilotWork('counted-first-half', runs, ['run-c1'], dir)).toBe('');
    expect(L.heldPilotWork('counted-first-half', runs, ['run-pilot', 'run-c1'], dir)).toContain('1 batch intents');
    expect(L.heldPilotWork('counted-second-half', runs, ['run-jc'], dir)).toContain('archive it first');
    mkdirSync(join(dir, 'particle'));
    writeFileSync(join(dir, 'particle', 'off.texts.ndjson.gz'), '');
    expect(L.heldPilotWork('counted-first-half', runs, [], dir)).toBe('');
    writeFileSync(join(dir, 'particle', 'off.rows.jsonl'), '{}\n');
    expect(L.heldPilotWork('counted-first-half', runs, [], dir)).toContain('particle rows');
    mkdirSync(join(dir, 'pilot-archive'));
    expect(L.heldPilotWork('counted-first-half', runs, [], dir)).toBe('');
    expect(L.heldPilotWork('counted-first-half', runs, ['run-pilot'], dir)).toContain('1 batch intents');
  });
});

describe('LongMemEval on Redis harness: second-half judgments get their own arm id', () => {
  test('judgeArmId keeps the first-half id and adds a suffix for the second half', () => {
    expect(L.judgeArmId('opus--off', 'cross')).toBe('opus--off--cross');
    expect(L.judgeArmId('opus--off', 'protocol', 'second-half')).toBe('opus--off--protocol--second-half');
  });
});

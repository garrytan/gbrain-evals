/**
 * Budgeted delivery recipes (plan C0), keyless: the C1 header and the one
 * date channel, the pseudo-session parser, the packers, recipe identity in
 * the context and arm hashes, twin reuse by prompt hash, and the two cells
 * end to end through memory-qa on the fixture (hash vectors, reranker off,
 * canned reader and judge behind a stand-in proxy).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { armHash, contextKey, expandArms, parseArms, recipeHash, type ArmsSpec } from '../../eval/runner/memory-qa/arms.ts';
import { renderHistory } from '../../eval/runner/memory-qa/qa.ts';
import type { MemoryQuestion, Session } from '../../eval/runner/memory-qa/corpus.ts';
import { c1Header, datedItems, EVIDENCE_OMISSION, packContext, packPseudo, packRecipe, parseBlockTurns, pseudoSessions, sessionDay, TOKENIZER } from '../../eval/runner/systems/render.ts';
import type { Item } from '../../eval/runner/systems/types.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'bd-recipes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const item = (id: string, src: string, text: string, rank = 1): Item => ({ id, rank, type: 'chunk', text, source_ids: [src], valid_from: null, valid_to: null, provenance_status: 'exact' });
const sessions: Record<string, Session> = {
  'src-a': { id: 'a', date: '2023/05/20 (Sat) 02:21', turns: [] },
  'src-b': { id: 'b', date: '1:56 pm on 8 May, 2023', turns: [] },
  'src-u': { id: 'u', turns: [] },
};
const sessionOf = (src: string) => sessions[src];
const q: MemoryQuestion = { id: 'q1', conversation: 'c', question: 'When?', category: 'temporal', abstention: false, gold: [] } as unknown as MemoryQuestion;

describe('C1 header and the one date channel', () => {
  test('preregistered bytes from the session table ISO day; valid_from stays unset', () => {
    expect(c1Header('2023-05-20')).toBe('Conversation date: 2023-05-20\n\n');
    expect(sessionDay('2023/05/20 (Sat) 02:21')).toBe('2023-05-20');
    expect(sessionDay('1:56 pm on 8 May, 2023')).toBe('2023-05-08');
    expect(sessionDay('March-15-2024')).toBe('2024-03-15');
    expect(sessionDay(undefined)).toBeNull();
    const [d] = datedItems([item('i', 'src-a', '**user:** hi')], src => sessionDay(sessionOf(src)?.date));
    expect(d.text).toBe('Conversation date: 2023-05-20\n\n**user:** hi');
    expect(d.valid_from).toBeNull();
    expect(d.event_date).toBe('2023-05-20');
  });
  test('an undated session gets no header (never an invented date), and empty chunk text stays empty', () => {
    const out = datedItems([item('u', 'src-u', '**user:** hi'), item('e', 'src-a', '')], src => sessionDay(sessionOf(src)?.date));
    expect(out[0].text).toBe('**user:** hi');
    expect(out[0].event_date).toBeNull();
    expect(out[1].text).toBe('');
  });
  test('native rendering through a recipe is byte-identical to the shootout native context', () => {
    const items = [item('x#0', 'src-a', '**user:** one\n\n**assistant:** two', 1), item('y#1', 'src-b', '**user:** three', 2)];
    const a = packContext('native', q, items, { budgetTokens: 8000, sessionOf, fallbackDate: 'd' });
    const b = packRecipe('native', q, items, { budgetTokens: 8000, sessionOf, fallbackDate: 'd' });
    expect(b.prompt).toBe(a.prompt);
    expect(b.item_ids).toEqual(a.item_ids);
    const dated = packRecipe('native-dated', q, items, { budgetTokens: 8000, sessionOf, fallbackDate: 'd' });
    expect(dated.prompt).toContain('- (1, chunk) Conversation date: 2023-05-20 **user:** one **assistant:** two');
    expect(dated.prompt).not.toContain('[valid');
  });
});

describe('pseudo-session parser', () => {
  test('speaker turns, a consumed header, an omission turn and a cut fragment after it under the preceding speaker', () => {
    const text = `${c1Header('2023-05-20')}**user:** I bought a kayak.\n\n**assistant:** Nice choice.${EVIDENCE_OMISSION}the rest of a cut turn.\n\n**user:** It was 300 dollars.`;
    const { turns, headerDay } = parseBlockTurns(text);
    expect(headerDay).toBe('2023-05-20');
    expect(turns).toEqual([
      { speaker: 'user', content: 'I bought a kayak.' }, { speaker: 'assistant', content: 'Nice choice.' }, { speaker: 'omitted', content: '[…]' },
      { speaker: 'assistant', content: 'the rest of a cut turn.' }, { speaker: 'user', content: 'It was 300 dollars.' }]);
  });
  test('a leading fragment with no preceding speaker is unknown', () => {
    expect(parseBlockTurns('end of a turn.\n\n**user:** next').turns).toEqual([{ speaker: 'unknown', content: 'end of a turn.' }, { speaker: 'user', content: 'next' }]);
  });
  test('a header that differs from the session table is harness-invalid; an undated session renders unknown', () => {
    expect(() => pseudoSessions([item('i', 'src-a', `${c1Header('2023-05-21')}**user:** x`)], sessionOf)).toThrow(/differs from the session table/);
    const [u] = pseudoSessions([item('u', 'src-u', '**user:** x')], sessionOf);
    expect(renderHistory([u.session])).toContain('Session Date: unknown');
  });
  test('two chunks of one session are two pseudo-sessions with the same date, delivered text only', () => {
    const ps = pseudoSessions([item('a#1', 'src-a', '**user:** one'), item('a#2', 'src-a', '**user:** two')], sessionOf);
    expect(ps.map(p => p.session.date)).toEqual(['2023/05/20 (Sat) 02:21', '2023/05/20 (Sat) 02:21']);
    expect(ps.map(p => p.session.turns.map(t => t.content))).toEqual([['one'], ['two']]);
  });
  test('the packer counts the exact serialized history and stops at the first block that does not fit', () => {
    const items = Array.from({ length: 6 }, (_, k) => item(`a#${k}`, k % 2 ? 'src-a' : 'src-b', `**user:** ${'word '.repeat(60)}${k}`, k + 1));
    const all = packPseudo(items, sessionOf, null);
    const some = packPseudo(items, sessionOf, Math.floor(all.tokens / 2));
    expect(some.tokens).toBe(TOKENIZER.count(renderHistory(some.sessions)));
    expect(some.items.length).toBeLessThan(items.length);
    expect(all.tokens_before).toBe(all.tokens);
  });
});

describe('recipe identity', () => {
  const spec: ArmsSpec = parseArms(JSON.stringify({
    policies: { 'fixed-evidence': { budget_tokens: 8000 } },
    contexts: ['native', 'chunk-dated', 'chunk-undated-twin'],
    recipes: { 'chunk-dated': { items: 'retrieved', render: 'native-dated' }, 'chunk-undated-twin': { items: 'retrieved', render: 'native', select_from: 'chunk-dated', reuse_from: 'native' } },
    readers: [{ id: 'main', model: 'openai:gpt-4o-mini' }], judge: 'openai:gpt-4o-2024-08-06' }));
  test('arms carry recipe hashes; shootout contexts keep their old keys', () => {
    const arms = expandArms(spec);
    expect(arms.map(a => a.id)).toEqual(['fixed-evidence.native.b8000.main', 'fixed-evidence.chunk-dated.b8000.main', 'fixed-evidence.chunk-undated-twin.b8000.main']);
    expect(arms[0].recipe).toBeUndefined();
    expect(contextKey('q', 'fixed-evidence', 'native', 8000)).toBe('q|fixed-evidence|native|8000');
    expect(contextKey('q', 'fixed-evidence', 'chunk-dated', 8000, arms[1].recipe!.hash)).toBe(`q|fixed-evidence|chunk-dated@${arms[1].recipe!.hash.slice(0, 16)}|8000`);
  });
  test('changing any recipe field invalidates its context and arm, and its dependents; adding a reader does not', () => {
    const h = (s: ArmsSpec, n: string) => recipeHash(n, s);
    const base = h(spec, 'chunk-undated-twin');
    const mutate = (f: (s: ArmsSpec) => void) => { const s = structuredClone(spec); f(s); return s; };
    expect(h(mutate(s => { s.recipes!['chunk-dated'].render = 'pseudo-session'; }), 'chunk-undated-twin')).not.toBe(base);
    expect(h(mutate(s => { s.recipes!['chunk-undated-twin'].items = 'auto-b_native'; }), 'chunk-undated-twin')).not.toBe(base);
    expect(h(mutate(s => { delete s.recipes!['chunk-undated-twin'].reuse_from; }), 'chunk-undated-twin')).not.toBe(base);
    expect(h(mutate(s => { s.recipes!['chunk-undated-twin'].budget_tokens = null; }), 'chunk-undated-twin')).not.toBe(base);
    const more = mutate(s => { s.readers.push({ id: 'sonnet', model: 'anthropic:claude-sonnet-5-5' }); });
    expect(h(more, 'chunk-undated-twin')).toBe(base);
    const a1 = expandArms(spec)[2], a2 = expandArms(mutate(s => { s.recipes!['chunk-dated'].render = 'pseudo-session'; }))[2];
    expect(armHash('run', a1, 'j', 1)).not.toBe(armHash('run', a2, 'j', 1));
  });
  test('the parser refuses unknown renders, undefined recipes and a dependency listed after its dependent', () => {
    expect(() => parseArms(JSON.stringify({ policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['x'], readers: [] }))).toThrow(/recipe the file defines/);
    expect(() => parseArms(JSON.stringify({ policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['x'], recipes: { x: { items: 'retrieved', render: 'markdown' } }, readers: [] }))).toThrow(/render must be/);
    expect(() => parseArms(JSON.stringify({ policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['t', 'd'], recipes: { d: { items: 'retrieved', render: 'native-dated' }, t: { items: 'retrieved', render: 'native', select_from: 'd' } }, readers: [] }))).toThrow(/listed before/);
  });
});

/** Stand-in for the metering proxy: control routes, canned reader and judge answers. */
function fakeProxy() {
  const prompts: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => ({})) as any;
    if (path === '/__proxy/bind' || path === '/__proxy/unbind') return Response.json({ ok: true });
    if (path === '/__proxy/finalize') return Response.json({ usd: 0.001, requests: 1, unpriced: 0, byModel: {} });
    if (path.endsWith('/chat/completions')) {
      const prompt = String(body.messages?.[0]?.content ?? '');
      prompts.push(prompt);
      return Response.json({ choices: [{ message: { content: prompt.includes('Answer yes or no') || prompt.includes('Is the model response correct') ? 'yes' : 'the answer' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    }
    return Response.json({ error: 'no route' }, { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, prompts, stop: () => server.stop(true) };
}

async function mqa(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', '--embed', 'hash', '--config', 'search.reranker.enabled=false', ...args],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_EVALS_QA_CACHE: join(tmp, `qa-${Math.random()}`), ...env } });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.slice(-3000));
}
const rows = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const writeArms = (name: string, spec: unknown) => { const p = join(tmp, `${name}.json`); writeFileSync(p, JSON.stringify(spec)); return p; };

describe('two cells end to end (fixture, keyless)', () => {
  test('cell A: chunk-dated and the undated twin, reused by prompt hash; cell B: freeze, then deliveries with live parity and every query recipe', async () => {
    const proxy = fakeProxy();
    try {
      const reader = { id: 'main', model: 'openai:gpt-4o-mini' };
      const cellA = writeArms('cell-a', { policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['native', 'chunk-dated', 'chunk-undated-twin', 'chunk-dated-pseudo', 'rehydrated'],
        recipes: { 'chunk-dated': { items: 'retrieved', render: 'native-dated' }, 'chunk-undated-twin': { items: 'retrieved', render: 'native', select_from: 'chunk-dated', reuse_from: 'native' },
          'chunk-dated-pseudo': { items: 'retrieved', render: 'pseudo-session' } }, readers: [reader], judge: 'openai:gpt-4o-mini' });
      const outA = join(tmp, 'cell-a');
      await mqa(['--system', 'gbrain-shootout', '--arms', cellA, '--output', outA, '--provider-proxy', proxy.url]);
      const native = rows(join(outA, 'arms/fixed-evidence.native.b8000.main/rows.ndjson'));
      const dated = rows(join(outA, 'arms/fixed-evidence.chunk-dated.b8000.main/rows.ndjson'));
      const twin = rows(join(outA, 'arms/fixed-evidence.chunk-undated-twin.b8000.main/rows.ndjson'));
      const pseudo = rows(join(outA, 'arms/fixed-evidence.chunk-dated-pseudo.b8000.main/rows.ndjson'));
      expect(dated.every(r => r.qa_context.recipe === 'chunk-dated' && r.qa_context.dated_items > 0 && r.qa_context.reader_bytes.utf8_bytes > 0)).toBe(true);
      expect(twin.every(r => r.reused_from?.arm === 'fixed-evidence.native.b8000.main')).toBe(true);
      expect(twin.map(r => r.qa_context.prompt_sha256)).toEqual(native.map(r => r.qa_context.prompt_sha256));
      expect(twin.map(r => r.qa_context.item_ids)).toEqual(dated.map(r => r.qa_context.item_ids));
      expect(pseudo.every(r => r.qa_context.render === 'pseudo-session' && r.outcome === 'scored')).toBe(true);
      const rehyd = rows(join(outA, 'arms/fixed-evidence.rehydrated.b8000.main/rows.ndjson'));
      // Fixture sessions are one chunk each, so a pseudo-session of a whole-session chunk is byte-identical to the rehydrated session.
      expect(pseudo.map(r => r.qa_context.prompt_sha256)).toEqual(rehyd.map(r => r.qa_context.prompt_sha256));
      const readerCalls = proxy.prompts.filter(p => p.includes('Answer (step by step):')).length;
      expect(readerCalls).toBe(new Set([...native, ...dated, ...pseudo, ...rehyd].map(r => r.qa_context.prompt_sha256)).size);

      const freezeArms = writeArms('cell-b-freeze', { policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: [], readers: [] });
      const outF = join(tmp, 'cell-b-freeze');
      await mqa(['--system', 'gbrain-query', '--arms', freezeArms, '--policy-setting', 'stage=freeze', '--policy-setting', 'grid=1000:3000:1000', '--output', outF]);
      const frozen = rows(join(outF, 'retrievals/rows.ndjson'));
      expect(frozen.every(r => r.accounting.frozen.request.return_unit === 'chunk' && r.accounting.sizing.length === 3)).toBe(true);
      expect(frozen.every(r => r.accounting.sizing.every((g: any) => g.full.native > 0 && g.full.pseudo >= g.full.native))).toBe(true);

      const cellB = writeArms('cell-b', { policies: { 'fixed-evidence': { budget_tokens: 8000 } },
        contexts: ['query-auto', 'query-auto-default', 'query-auto-pseudo', 'query-auto-pseudo-as-native', 'query-auto-l5-pseudo', 'query-rehydrated'],
        recipes: { 'query-auto': { items: 'auto-b_native', render: 'native-dated' }, 'query-auto-default': { items: 'auto-default', render: 'native-dated' },
          'query-auto-pseudo': { items: 'auto-b_pseudo', render: 'pseudo-session' }, 'query-auto-pseudo-as-native': { items: 'auto-b_pseudo', render: 'native-dated', select_from: 'query-auto-pseudo' },
          'query-auto-l5-pseudo': { items: 'auto-l5-b_pseudo', render: 'pseudo-session' }, 'query-rehydrated': { items: 'retrieved', render: 'rehydrated' } },
        readers: [reader], judge: 'openai:gpt-4o-mini' });
      const outB = join(tmp, 'cell-b');
      await mqa(['--system', 'gbrain-query', '--arms', cellB, '--policy-setting', 'stage=deliver', '--policy-setting', 'b_native=3000', '--policy-setting', 'b_pseudo=2500',
        '--frozen-from', join(outF, 'retrievals/rows.ndjson'), '--output', outB, '--provider-proxy', proxy.url]);
      const delivered = rows(join(outB, 'retrievals/rows.ndjson'));
      expect(delivered.every(r => r.accounting.live.parity.equal && r.accounting.deliveries['auto-b_native'].record.budget_tokens === 3000)).toBe(true);
      expect(delivered.map(r => r.accounting.frozen.memo_key)).toEqual(frozen.map(r => r.accounting.frozen.memo_key));
      const asNative = rows(join(outB, 'arms/fixed-evidence.query-auto-pseudo-as-native.b8000.main/rows.ndjson'));
      const ps = rows(join(outB, 'arms/fixed-evidence.query-auto-pseudo.b8000.main/rows.ndjson'));
      expect(asNative.map(r => r.qa_context.item_ids)).toEqual(ps.map(r => r.qa_context.item_ids));
      for (const arm of ['query-auto', 'query-auto-default', 'query-auto-l5-pseudo', 'query-rehydrated']) {
        const rs = rows(join(outB, `arms/fixed-evidence.${arm}.b8000.main/rows.ndjson`));
        expect(rs.length).toBe(delivered.length);
        expect(rs.every(r => r.outcome === 'scored' && r.qa_context.recipe === arm && typeof r.qa_context.items_cut === 'number')).toBe(true);
      }
      const receipt = JSON.parse(readFileSync(join(outB, 'receipt.json'), 'utf8'));
      expect(receipt.run_status).toBe('complete');
      expect(receipt.overlay === null || typeof receipt.overlay === 'object').toBe(true);
      expect(receipt.product.declared_pin).toContain('garrytan/gbrain#');
    } finally { proxy.stop(); }
  }, 300_000);
});

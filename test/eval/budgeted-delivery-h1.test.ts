/**
 * Budgeted delivery H1 (preregistration docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1-preregistration.md),
 * keyless: the committed decision directory agrees with itself, E2 and the harness; the access-log check, the
 * preregistered rule, the custody refusals, the answers files, the export scan and the budget summary; and the
 * invented fixture through custody-check and corpus. The whole chain runs in h1-dry-run.sh (receipts committed).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFixture } from '../../eval/runner/budgeted-delivery/h1-fixture.ts';
import { answerRows, budgetSummary, buildCorpus, checkAccessLog, custodyCheck, decideH1, leakScan, loadDecision, returnLog, toCustodyCorpus, type H1Decision } from '../../eval/runner/budgeted-delivery/h1.ts';
import { expandArms, loadArms, recipeHash } from '../../eval/runner/memory-qa/arms.ts';
import type { Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import { READER_TEMPLATE } from '../../eval/runner/memory-qa/qa.ts';
import { READER_ONLY } from '../../eval/runner/memory-qa/run-systems.ts';
import { checkCustodyPaths } from '../../eval/runner/memory-qa/sealed-profile.ts';
import { loadCampaign } from '../../eval/runner/shootout-cell.ts';
import { loadFamily } from '../../eval/runner/stats/gates.ts';
import { H1_DELIVERY_VARIANTS } from '../../eval/runner/systems/gbrain-query/system.ts';
import { DATED_RENDERER_VERSION } from '../../eval/runner/systems/render.ts';
import { opaqueSourceId } from '../../eval/runner/systems/sanitize.ts';

const REPO = resolve(import.meta.dir, '../..');
const DIR = join(REPO, 'docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1');
const E2 = join(REPO, 'docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2');
const { decision: D } = loadDecision(join(DIR, 'decision.json'));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'bd-h1-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the committed decision directory', () => {
  test('measures the package.json pin, at E2\'s budget, with E2\'s recipes and renderer bytes', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(pkg.dependencies.gbrain).toBe(`github:garrytan/gbrain#${D.gbrain.commit}`);
    expect(D.construction.b_pseudo).toBe(JSON.parse(readFileSync(join(E2, 'manifests/campaign.json'), 'utf8')).parameters.b_pseudo_lme_s);
    expect(sha(READER_TEMPLATE)).toBe(D.construction.renderer.reader_template_sha256);
    expect(D.construction.renderer.dated_renderer_version).toBe(DATED_RENDERER_VERSION);
    for (const [f, h] of Object.entries((D.construction.renderer as unknown as { sources_sha256: Record<string, string> }).sources_sha256)) expect(sha(readFileSync(join(REPO, f)))).toBe(h);
    const e2 = loadArms(join(E2, 'manifests/arms/lme-s-phase1.json'));
    for (const [name, r] of Object.entries(D.construction.recipes)) {
      expect(recipeHash(name, e2)).toBe(r.hash);
      expect(H1_DELIVERY_VARIANTS as readonly string[]).toContain(r.items);
    }
  });

  test('every answer arm is an arm of a reader-only arms file, with the decision\'s recipe', () => {
    const arms = ['read-sonnet', 'read-frontier'].flatMap(f => {
      const spec = loadArms(join(DIR, `manifests/arms/${f}.json`));
      expect(spec.judge).toBe(READER_ONLY);
      return expandArms(spec);
    });
    expect(arms.map(a => a.id).sort()).toEqual(D.answer_arms.map(a => a.memory_qa_arm).sort());
    for (const a of D.answer_arms) {
      const m = arms.find(x => x.id === a.memory_qa_arm)!;
      expect(m.recipe?.hash).toBe(D.construction.recipes[a.recipe].hash);
      expect(m.reader?.model).toBe(a.model);
      expect(D.construction.recipes[a.recipe].items).toBe(a.variant);
    }
    expect(D.answer_arms.filter(a => a.role === 'candidate').map(a => a.id)).toEqual([D.rule.candidate_arm]);
    expect(D.answer_arms.filter(a => a.role === 'control').map(a => a.id)).toEqual([D.rule.control_arm]);
    expect(D.rule.expected_label_reads).toBe(D.answer_arms.length);
  });

  test('the family, the campaign leases and the budget agree', () => {
    const fam = loadFamily(join(DIR, 'family.json'));
    expect(fam.comparisons.map(c => c.id)).toContain(D.rule.primary_comparison);
    expect(fam.comparisons.every(c => c.gate === 'exploratory')).toBe(true);
    loadFamily(join(DIR, 'family-descriptive.json'));
    const budget = (D as unknown as { budget: { cap_usd: number; estimate_usd: number; steps: Array<{ id: string; cap_usd: number; estimate_usd: number }> } }).budget;
    const { manifest } = loadCampaign(join(DIR, 'manifests/campaign.json'));
    expect(manifest.cap_usd).toBe(budget.cap_usd);
    expect(manifest.parameters?.gbrain_sha).toBe(D.gbrain.commit);
    expect(manifest.cells.map(c => [c.id, c.lease_usd])).toEqual(budget.steps.map(s => [`h1-${s.id}`, s.cap_usd]));
    expect(manifest.cells.every(c => c.local && c.command.startsWith('bash eval/runner/budgeted-delivery/h1-run.sh cell '))).toBe(true);
    expect(budget.steps.reduce((n, s) => n + s.estimate_usd, 0)).toBeCloseTo(budget.estimate_usd, 6);
  });
});

describe('the access log', () => {
  const before = D.sealed.access_log_before.entries;
  test('accepts exactly the recorded state, plus lines of this decision only', () => {
    expect(checkAccessLog(before, D)).toEqual({ lines: 6, before: 6, this_decision: 0 });
    expect(checkAccessLog([...before, { action: 'open', decision_id: D.decision_id }, { action: 'score', decision_id: D.decision_id }], D).this_decision).toBe(2);
  });
  test('refuses a shorter log, a changed line or a line of another decision', () => {
    expect(() => checkAccessLog(before.slice(0, 5), D)).toThrow(/5 lines/);
    expect(() => checkAccessLog([...before.slice(0, 5), { action: 'score', decision_id: 'x' }], D)).toThrow(/line 6/);
    expect(() => checkAccessLog([...before, { action: 'open', decision_id: 'p8-quotes-heldout-2026-10-05' }], D)).toThrow(/another decision/);
  });
});

describe('the preregistered rule', () => {
  const kinds = { 'multi-session': 80, 'temporal-reasoning': 40, 'knowledge-update': 40, abstention: 40 };
  /** 200 questions; `wins[k]` questions of kind k go from wrong to right, `losses[k]` from right to wrong. */
  const rows = (wins: Record<string, number>, losses: Record<string, number> = {}) => {
    const a: Array<Record<string, unknown>> = [], b: Array<Record<string, unknown>> = [];
    for (const [k, n] of Object.entries(kinds)) for (let i = 0; i < n; i++) {
      const base = { question_id: `${k}-${i}`, haystack_id: `h${i % 40}`, question_type: k };
      const w = i < (wins[k] ?? 0), l = !w && i < (wins[k] ?? 0) + (losses[k] ?? 0);
      a.push({ ...base, answer_correct: l || (!w && i % 2 === 0) });
      b.push({ ...base, answer_correct: w || (!l && i % 2 === 0) });
    }
    return { a, b };
  };
  const primary = (delta: number, lo: number, hi: number, p: number) => ({ id: D.rule.primary_comparison, status: 'ok', stats: { delta, ci95: [lo, hi] as [number, number], p_two_sided: p, n_pairs: 200, n_clusters: 40, mean_a: 0.5, mean_b: 0.5 + delta }, mcnemar: { wins: 20, losses: 4, p_two_sided: p } });
  const run = (o: Partial<Parameters<typeof decideH1>[1]> & { wins: Record<string, number>; losses?: Record<string, number> }) => {
    const { a, b } = rows(o.wins, o.losses);
    return decideH1(D.rule, { gatePass: true, primary: primary(0.08, 0.03, 0.13, 0.001), readerErrors: {}, control: a, candidate: b, ...o });
  };
  test('pass needs superiority and guards 7 and 8', () => {
    const r = run({ wins: { 'multi-session': 6, 'temporal-reasoning': 5, 'knowledge-update': 5 } });
    expect(r.verdict).toBe('pass');
    expect(r.guard7.pass && r.guard8.pass && r.superiority_shown).toBe(true);
  });
  test('guard 7 allows max(1 question, 2% of the kind): 80 multi-session questions may lose 1.6, not 2', () => {
    expect(run({ wins: { 'temporal-reasoning': 9 }, losses: { 'multi-session': 1 } }).verdict).toBe('pass');
    const r = run({ wins: { 'temporal-reasoning': 9 }, losses: { 'multi-session': 2 } });
    expect(r.verdict).toBe('fail');
    expect(r.guard7.kinds['multi-session']).toMatchObject({ delta_questions: -2, threshold: 1.6, pass: false });
  });
  test('guard 8: abstention may not fall at all', () => {
    const r = run({ wins: { 'temporal-reasoning': 9 }, losses: { abstention: 1 } });
    expect(r.guard7.kinds.abstention.pass).toBe(true);
    expect(r.guard8.pass).toBe(false);
    expect(r.verdict).toBe('fail');
  });
  test('a failed gate is a fail; reader errors, a blocked comparison or no superiority are inconclusive', () => {
    expect(run({ wins: {}, gatePass: false }).verdict).toBe('fail');
    expect(run({ wins: {}, readerErrors: { [D.rule.candidate_arm]: 4 } }).verdict).toBe('inconclusive');
    expect(run({ wins: {}, readerErrors: { [D.rule.candidate_arm]: 3 } }).verdict).toBe('pass');
    expect(run({ wins: {}, primary: { id: D.rule.primary_comparison, status: 'blocked', reasons: ['missing rows'] } }).verdict).toBe('inconclusive');
    expect(run({ wins: {}, primary: primary(0.03, -0.01, 0.07, 0.2) }).verdict).toBe('inconclusive');
    expect(run({ wins: {}, primary: primary(0.03, 0.005, 0.07, 0.06) }).verdict).toBe('inconclusive');
    expect(run({ wins: {}, primary: primary(-0.08, -0.13, -0.02, 0.001) }).verdict).toBe('fail');
  });
});

describe('custody', () => {
  const root = join(tmp, 'custody');
  test('steps refuse destinations outside the root, inside the repository or in the shared cache', () => {
    mkdirSync(root, { recursive: true });
    expect(() => checkCustodyPaths(root, [['report', join(root, 'runs/x.json')]])).not.toThrow();
    expect(() => checkCustodyPaths(root, [['report', join(tmp, 'x.json')]])).toThrow(/report is outside the custody root/);
    expect(() => checkCustodyPaths(join(REPO, 'eval/reports'), [['report', join(REPO, 'eval/reports/x.json')]])).toThrow(/overlaps the repository/);
  });

  test('the invented fixture passes custody-check (labels hashed, not parsed) and becomes a label-free corpus', () => {
    const { questions, labels } = buildFixture();
    expect(questions.questions).toHaveLength(60);
    expect(new Set(questions.haystacks.map(h => h.haystack_id)).size).toBe(12);
    const s = join(root, 'sealed');
    mkdirSync(s, { recursive: true });
    const qText = JSON.stringify(questions), lText = JSON.stringify(labels);
    writeFileSync(join(s, 'questions.json'), qText);
    writeFileSync(join(s, 'labels.json'), lText);
    writeFileSync(join(s, 'manifest.json'), JSON.stringify({ set: 'fx', commitments: { 'questions.json': { sha256: sha(qText), bytes: qText.length }, 'labels.json': { sha256: sha(lText), bytes: lText.length } } }));
    const log = join(s, 'access-log.jsonl');
    writeFileSync(log, D.sealed.access_log_before.entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const d: H1Decision = { ...D, sealed: { ...D.sealed, set: 'fx', questions_sha256: sha(qText), labels_sha256: sha(lText) } };
    const c = custodyCheck({ custodyRoot: root, decision: d, manifestPath: join(s, 'manifest.json'), questions: join(s, 'questions.json'), labels: join(s, 'labels.json'), log });
    expect(c).toMatchObject({ labels_parsed: false, access_log: { lines: 6, this_decision: 0 } });
    writeFileSync(join(s, 'labels.json'), lText + ' ');
    expect(() => custodyCheck({ custodyRoot: root, decision: d, manifestPath: join(s, 'manifest.json'), questions: join(s, 'questions.json'), labels: join(s, 'labels.json'), log })).toThrow(/does not match its commitment/);
    const out = join(root, 'runs/corpus.json');
    expect(buildCorpus({ custodyRoot: root, decision: d, manifestPath: join(s, 'manifest.json'), questions: join(s, 'questions.json'), log, out, purpose: 'test' })).toMatchObject({ questions: 60, conversations: 12 });
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ action: 'open', decision_id: D.decision_id, labels_sha256: sha(qText) });
    const corpus = readFileSync(out, 'utf8');
    for (const key of ['answer', 'answer_session_ids', 'related_session_ids', 'question_type', 'audit_flags']) expect(corpus).not.toContain(`"${key}"`);
    expect(JSON.parse(corpus).questions.every((q: { gold: unknown[]; category: string; abstention: boolean }) => q.gold.length === 0 && q.category === 'sealed-unlabeled' && !q.abstention)).toBe(true);
  });

  test('the sealed runner refuses a report outside the custody root before it opens the labels', () => {
    const s = join(root, 'sealed');
    const log = join(s, 'access-log.jsonl');
    const lines = readFileSync(log, 'utf8');
    writeFileSync(join(root, 'run.jsonl'), '');
    const p = Bun.spawnSync(['bun', 'eval/runner/sealed-confirmation.ts', 'score', '--manifest', join(s, 'manifest.json'), '--run', join(root, 'run.jsonl'), '--labels', join(s, 'labels.json'),
      '--access-log', log, '--purpose', 'test', '--decision-id', D.decision_id, '--custody-root', root, '--out', join(tmp, 'outside.json')], { cwd: REPO });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toMatch(/report is outside the custody root/);
    expect(readFileSync(log, 'utf8')).toBe(lines);
  });

  test('answers files carry the packed chats as retrieved, and reader errors as errors', () => {
    const corpus = toCustodyCorpus(buildFixture().questions) as unknown as Corpus;
    const [q1, q2] = corpus.questions;
    const sessions = corpus.conversations.find(c => c.id === q1.conversation)!.sessions;
    const a = D.answer_arms[0];
    const rows = answerRows(D, a, [
      { id: q1.id, outcome: 'scored', qa_answer: 'an answer', qa_context: { source_ids: [opaqueSourceId(q1.conversation, sessions[3].id), opaqueSourceId(q1.conversation, sessions[1].id), opaqueSourceId(q1.conversation, sessions[3].id)], prompt_sha256: 'p', tokens: 7000 } },
      { id: q2.id, outcome: 'reader_error', qa_error: 'reader: 529 overloaded' },
      ...corpus.questions.slice(2).map(q => ({ id: q.id, outcome: 'scored', qa_answer: '' })),
    ], corpus);
    expect(rows[0]).toMatchObject({ question_id: q1.id, haystack_id: q1.conversation, retrieved: [sessions[3].id, sessions[1].id], hypothesis: 'an answer', reader_empty: false });
    expect(rows[1]).toMatchObject({ reader_error: 'reader: 529 overloaded' });
    expect(rows[2].reader_empty).toBe(true);
    expect(() => answerRows(D, a, [], corpus)).toThrow(/no row for question/);
  });

  test('the export scan refuses any corpus id or the custody path', () => {
    const corpus = toCustodyCorpus(buildFixture().questions) as unknown as Corpus;
    expect(() => leakScan([{ path: 'a.json', text: '{"n": 60, "delta": 0.1}' }], corpus, root)).not.toThrow();
    expect(() => leakScan([{ path: 'a.json', text: `{"id": "${corpus.questions[0].id}"}` }], corpus, root)).toThrow(/an id of the corpus/);
    expect(() => leakScan([{ path: 'a.json', text: `{"id": "${corpus.conversations[0].sessions[0].id}"}` }], corpus, root)).toThrow(/an id of the corpus/);
    expect(() => leakScan([{ path: 'a.json', text: `{"p": "${root}/runs"}` }], corpus, root)).toThrow(/custody root's path/);
  });

  test('the access log goes back only when the owner\'s lines are its prefix and the added lines are this decision\'s', () => {
    const owner = join(tmp, 'owner-log.jsonl'), custody = join(root, 'log-copy.jsonl');
    const base = D.sealed.access_log_before.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(owner, base);
    writeFileSync(custody, base + JSON.stringify({ action: 'score', decision_id: D.decision_id }) + '\n');
    expect(returnLog({ decision: D, from: custody, to: owner })).toMatchObject({ lines: 7, added: 1, added_by_action: { score: 1 } });
    writeFileSync(custody, readFileSync(owner, 'utf8') + JSON.stringify({ action: 'score', decision_id: 'other' }) + '\n');
    expect(() => returnLog({ decision: D, from: custody, to: owner })).toThrow(/another decision/);
    writeFileSync(owner, base + '{"action":"open","decision_id":"elsewhere"}\n');
    expect(() => returnLog({ decision: D, from: custody, to: owner })).toThrow(/not a prefix/);
  });
});

describe('the budget summary', () => {
  test('per step against the estimate, alerting past twice it, with no lease id', () => {
    const status = { campaign_id: 'c', cap_usd: 145, committed_usd: 41, remaining_usd: 104, leases: [
      { lease_id: 'h1-read-sonnet-a1-x', cell: 'h1-read-sonnet', usd: 57, status: 'settled', actual_usd: 39 },
      { lease_id: 'h1-score-a1-y', cell: 'h1-score', usd: 8, status: 'abandoned' },
      { lease_id: 'h1-freeze-a1-z', cell: 'h1-freeze', usd: 5, status: 'launched' },
    ] };
    const s = budgetSummary(D as Parameters<typeof budgetSummary>[0], status);
    const by = Object.fromEntries(s.steps.map(x => [x.id, x]));
    expect(by['read-sonnet']).toMatchObject({ spent_usd: 39, alert_over_twice_estimate: true });
    expect(by.score).toMatchObject({ spent_usd: 8, alert_over_twice_estimate: true });
    expect(by.freeze).toMatchObject({ spent_usd: 0, open_leases: 1 });
    expect(JSON.stringify(s)).not.toContain('a1-');
  });
});

describe('the stub proxy for the dry run', () => {
  test('--vary answers per prompt on chat completions, messages and responses', async () => {
    const port = 9900 + Math.floor(Math.random() * 90);
    const p = Bun.spawn(['bun', 'eval/runner/budgeted-delivery/stub-proxy.ts', '--port', String(port), '--vary'], { cwd: REPO, stderr: 'pipe' });
    try {
      for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/__proxy/status`); break; } catch { await Bun.sleep(50); } }
      const post = async (path: string, body: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<any>;
      const a = await post('/v1/messages', { messages: [{ content: 'context one' }] });
      const b = await post('/v1/messages', { messages: [{ content: 'context two' }] });
      expect(a.content[0].text).toBe(`stub answer ${sha('context one').slice(0, 8)}`);
      expect(a.content[0].text).not.toBe(b.content[0].text);
      const judge = 'I will give you a question, a correct answer, and a response from a model. Answer yes or no.';
      const r = await post('/v1/responses', { input: [{ content: judge }] });
      expect(r.output[0].content[0].text).toBe(parseInt(sha(judge)[0], 16) < 8 ? 'yes' : 'no');
      expect(r.usage.output_tokens).toBe(2);
    } finally { p.kill(); }
  });
});

test('no committed dry-run receipt names the dry run\'s machine paths', () => {
  const rec = join(DIR, 'receipts/dry-run/dry-run-summary.json');
  if (!existsSync(rec)) return;
  const text = readFileSync(rec, 'utf8');
  expect(text).not.toMatch(/\/home\/|\/Users\//);
  expect(JSON.parse(text).all_probes_refused_without_a_label_read).toBe(true);
});

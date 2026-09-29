/**
 * Sealed confirmation set: generator validation, assembly, input allowlist,
 * commitments, access log, spend ledger and the reference scorer. Keyless,
 * no network; the one gbrain run uses the keyword adapter on a tiny public
 * fixture built here, never the sealed files.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INPUT_ALLOWLIST, LlmClient, SpendLedger, assertCommitment, judgePrompt, judgeSaysYes, priceUsage, readerPrompt, scoreRetrieval,
  sha256File, sha256Hex, validateLabelsFile, validateQuestionsFile, type LabelsFile, type QuestionsFile, type SealedLabel,
} from '../../eval/runner/sealed-confirmation-lib.ts';
import { assemble, lmeDate, personaSeeds, validatePlan, type Plan } from '../../eval/generators/sealed-confirmation-gen.ts';
import { HOBBIES, OCCUPATIONS, PROMPT_TEXTS } from '../../eval/generators/sealed-confirmation-prompts.ts';
import { loadQuestions, openLabels, runSealed, summarizeSolvability, toLmeRows } from '../../eval/runner/sealed-confirmation.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'sealed-'));

function day(i: number): string {
  return new Date(Date.parse('2025-03-01T00:00:00Z') + i * 7 * 86400000).toISOString().slice(0, 10);
}

/** A structurally valid plan with invented, obviously fake content. */
function makePlan(): Plan {
  const sessions = Array.from({ length: 18 }, (_, i) => ({ key: `S${String(i + 1).padStart(2, '0')}`, date: day(i), topic: `topic ${i + 1}`, user_goal: `goal ${i + 1}` }));
  const facts = sessions.map((s, i) => ({ key: `F${String(i + 1).padStart(2, '0')}`, session_key: s.key, statement: `fact number ${i + 1} about widget-${i + 1}`, event_date: s.date, purpose: 'background' as const }));
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) facts[i].purpose = 'question_evidence' as any;
  for (const i of [10, 11, 12, 13]) facts[i].purpose = 'near_miss' as any;
  const qd = day(20);
  return {
    persona: { name: 'Alice Example', age: 40, occupation: 'bookbinder', home_description: 'an invented town', household: 'lives alone', hobbies: ['a', 'b', 'c'], voice: 'plain' },
    sessions,
    facts,
    questions: [
      { type: 'single-session-user', question: 'q1?', answer: 'a1', evidence_fact_keys: ['F01'], evidence_session_keys: ['S01'], question_date: qd, must_never_state: '', rationale: '' },
      { type: 'multi-session', question: 'q2?', answer: 'a2', evidence_fact_keys: ['F02', 'F03'], evidence_session_keys: ['S02', 'S03'], question_date: qd, must_never_state: '', rationale: '' },
      { type: 'temporal-reasoning', question: 'q3?', answer: 'a3', evidence_fact_keys: ['F04', 'F05'], evidence_session_keys: ['S04', 'S05'], question_date: qd, must_never_state: '', rationale: '' },
      { type: 'knowledge-update', question: 'q4?', answer: 'a4', evidence_fact_keys: ['F06', 'F07'], evidence_session_keys: ['S06', 'S07'], question_date: qd, must_never_state: '', rationale: '' },
      { type: 'abstention', question: 'q5?', answer: 'never said', evidence_fact_keys: ['F09'], evidence_session_keys: ['S09'], question_date: qd, must_never_state: 'the name of widget-9', rationale: '' },
    ],
  };
}

function assembled(plans = [makePlan(), makePlan()], salt = 'test-salt') {
  return assemble({
    setId: 'sealed-test', salt, seed: 7,
    personas: plans.map((plan, i) => ({
      index: i + 1, plan,
      sessions: new Map(plan.sessions.map(s => [s.key, { turns: [{ role: 'user' as const, content: `persona ${i + 1} ${s.topic}` }, { role: 'assistant' as const, content: 'ok' }], audit_passed: s.key !== 'S03' }])),
    })),
    fillers: Array.from({ length: 50 }, (_, i) => ({ index: i + 1, turns: [{ role: 'user' as const, content: `general help ${i}` }, { role: 'assistant' as const, content: 'reply' }] })),
  });
}

describe('plan validation', () => {
  test('a well-formed plan passes', () => {
    expect(validatePlan(makePlan())).toEqual([]);
  });

  test('catches the structural errors that would corrupt labels', () => {
    const p = makePlan();
    p.questions[1].evidence_session_keys = ['S02'];
    p.questions[0].question_date = day(17);
    p.sessions[5].date = p.sessions[4].date;
    p.questions[4].must_never_state = '';
    p.questions.push({ ...p.questions[0] });
    const problems = validatePlan(p).join('\n');
    expect(problems).toContain('multi-session: evidence_session_keys S02 disagree');
    expect(problems).toContain('must be after the last session');
    expect(problems).toContain('strictly increase');
    expect(problems).toContain('abstention: must_never_state must be set');
    expect(problems).toContain('need exactly one single-session-user question');
  });

  test('knowledge updates need two sessions and single-session facts exactly one', () => {
    const p = makePlan();
    p.questions[3].evidence_fact_keys = ['F06'];
    p.questions[3].evidence_session_keys = ['S06'];
    p.questions[0].evidence_fact_keys = ['F01', 'F08'];
    p.questions[0].evidence_session_keys = ['S01', 'S08'];
    const problems = validatePlan(p).join('\n');
    expect(problems).toContain('knowledge-update: wrong number of evidence sessions (1)');
    expect(problems).toContain('single-session-user: wrong number of evidence sessions (2)');
  });
});

describe('seeds', () => {
  test('personas never share an occupation or a hobby, and runs are reproducible', () => {
    const seeds = personaSeeds(30, 20260929);
    expect(new Set(seeds.map(s => s.occupation)).size).toBe(30);
    expect(new Set(seeds.flatMap(s => s.hobbies)).size).toBe(90);
    expect(new Set(seeds.map(s => s.given_initial + s.surname_initial)).size).toBe(30);
    expect(personaSeeds(30, 20260929)).toEqual(seeds);
    expect(seeds.every(s => OCCUPATIONS.includes(s.occupation) && s.hobbies.every(h => HOBBIES.includes(h)))).toBe(true);
  });

  test('LongMemEval timestamp format', () => {
    expect(lmeDate('2023-05-20', 141)).toBe('2023/05/20 (Sat) 02:21');
  });

  test('prompt texts name no real organization placeholders beyond the templates', () => {
    for (const text of Object.values(PROMPT_TEXTS)) expect(text).not.toMatch(/answer_/);
  });
});

describe('assembly', () => {
  test('questions file passes the allowlist; labels come from the plan', () => {
    const { questions, labels, idMap } = assembled();
    expect(validateQuestionsFile(questions)).toEqual([]);
    expect(validateLabelsFile(labels, questions)).toEqual([]);
    expect(questions.questions).toHaveLength(10);
    expect(questions.haystacks.every(h => h.sessions.length === 18 + 35)).toBe(true);
    const ku = labels.labels.find(l => l.question_type === 'knowledge-update' && l.question_id === idMap['p1:q:knowledge-update'])!;
    expect(ku.answer_session_ids.sort()).toEqual([idMap['p1:S06'], idMap['p1:S07']].sort());
    const abs = labels.labels.find(l => l.question_id === idMap['p2:q:abstention'])!;
    expect(abs.abstention).toBe(true);
    expect(abs.answer_session_ids).toEqual([]);
    expect(abs.related_session_ids).toEqual([idMap['p2:S09']]);
    const ms = labels.labels.find(l => l.question_id === idMap['p1:q:multi-session'])!;
    expect(ms.audit_flags).toEqual([`evidence_session_audit_failed:${idMap['p1:S03']}`]);
  });

  test('nothing in the questions file reveals which sessions or questions are which', () => {
    const { questions } = assembled();
    const text = JSON.stringify(questions);
    for (const leak of ['answer', 'abstention', 'knowledge-update', 'S01', 'filler', 'evidence']) expect(text).not.toContain(leak);
    for (const h of questions.haystacks) {
      const dates = h.sessions.map(s => s.date);
      expect([...dates].sort()).toEqual(dates);
    }
  });

  test('ids depend on the private salt', () => {
    const a = assembled().idMap;
    const b = assembled(undefined, 'other').idMap;
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const k of Object.keys(a)) expect(b[k]).not.toBe(a[k]);
  });
});

describe('input allowlist', () => {
  test('rejects label fields and readable ids', () => {
    const { questions } = assembled();
    const leaky = JSON.parse(JSON.stringify(questions));
    leaky.questions[0].answer_session_ids = ['x'];
    leaky.questions[1].question_type = 'multi-session';
    leaky.haystacks[0].sessions[0].session_id = 'answer_abc123';
    leaky.haystacks[0].sessions[1].has_answer = true;
    const problems = validateQuestionsFile(leaky).join('\n');
    expect(problems).toContain('field "answer_session_ids" is not on the input allowlist');
    expect(problems).toContain('field "question_type" is not on the input allowlist');
    expect(problems).toContain('session_id must be opaque');
    expect(problems).toContain('field "has_answer" is not on the input allowlist');
  });

  test('the allowlist holds no label-bearing field names', () => {
    const all = Object.values(INPUT_ALLOWLIST).flat();
    for (const banned of ['answer', 'answer_session_ids', 'question_type', 'abstention', 'related_session_ids']) expect(all).not.toContain(banned);
  });

  test('LongMemEval-shaped export carries empty gold and a neutral type', () => {
    const rows = toLmeRows(assembled().questions);
    expect(rows.every(r => r.answer_session_ids.length === 0 && r.answer === '' && r.question_type === 'sealed-unlabeled')).toBe(true);
  });
});

function sealedFiles(mutate: (q: QuestionsFile) => void = () => {}) {
  const dir = tmp();
  const { questions, labels } = assembled();
  mutate(questions);
  const qPath = join(dir, 'questions.json');
  const lPath = join(dir, 'labels.json');
  writeFileSync(qPath, JSON.stringify(questions));
  writeFileSync(lPath, JSON.stringify(labels));
  const manifest = {
    set: 'sealed-test',
    commitments: {
      'questions.json': { sha256: sha256File(qPath), bytes: readFileSync(qPath).length },
      'labels.json': { sha256: sha256File(lPath), bytes: readFileSync(lPath).length },
    },
  };
  return { dir, qPath, lPath, manifest, questions, labels };
}

describe('commitments and access log', () => {
  test('a modified labels file is refused before parsing and before logging', () => {
    const f = sealedFiles();
    writeFileSync(f.lPath, readFileSync(f.lPath, 'utf8').replace('"answer":"a1"', '"answer":"a9"'));
    const log = join(f.dir, 'access-log.jsonl');
    expect(() => openLabels(f.lPath, f.manifest, { path: log, action: 'score', purpose: 'test', decision_id: null, run_sha256: null })).toThrow('commitment mismatch');
    expect(existsSync(log)).toBe(false);
  });

  test('every label open is logged with its purpose; a purpose is required', () => {
    const f = sealedFiles();
    const log = join(f.dir, 'access-log.jsonl');
    expect(() => openLabels(f.lPath, f.manifest, { path: log, action: 'score', purpose: ' ', decision_id: null, run_sha256: null })).toThrow('--purpose');
    const labels = openLabels(f.lPath, f.manifest, { path: log, action: 'score', purpose: 'release decision test', decision_id: 'd-1', run_sha256: 'abc' });
    expect(labels.labels).toHaveLength(10);
    const entry = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(entry).toMatchObject({ action: 'score', purpose: 'release decision test', decision_id: 'd-1', labels_sha256: f.manifest.commitments['labels.json'].sha256, run_sha256: 'abc' });
  });

  test('questions are checked against their commitment too', () => {
    const f = sealedFiles();
    expect(loadQuestions(f.qPath, f.manifest).questions).toHaveLength(10);
    writeFileSync(f.qPath, readFileSync(f.qPath, 'utf8') + ' ');
    expect(() => loadQuestions(f.qPath, f.manifest)).toThrow('commitment mismatch');
    expect(() => assertCommitment(f.qPath, { file: 'q', sha256: '0'.repeat(64), bytes: 1 })).toThrow();
  });
});

describe('reference scorer', () => {
  const labels: SealedLabel[] = [
    { question_id: 'scq-000000000001', question_type: 'multi-session', abstention: false, answer: 'x', answer_session_ids: ['ses-a', 'ses-b'], related_session_ids: [], audit_flags: [] },
    { question_id: 'scq-000000000002', question_type: 'single-session-user', abstention: false, answer: 'y', answer_session_ids: ['ses-c'], related_session_ids: [], audit_flags: [] },
    { question_id: 'scq-000000000003', question_type: 'abstention', abstention: true, answer: 'z', answer_session_ids: [], related_session_ids: ['ses-d'], audit_flags: [] },
    { question_id: 'scq-000000000004', question_type: 'temporal-reasoning', abstention: false, answer: 'w', answer_session_ids: ['ses-e'], related_session_ids: [], audit_flags: [] },
  ];

  test('recall_all needs every gold session; abstention leaves the denominator; missing rows are misses', () => {
    const { summary, rows } = scoreRetrieval([
      { question_id: 'scq-000000000001', retrieved: ['ses-a', 'ses-x', 'ses-a', 'ses-y', 'ses-z', 'ses-w', 'ses-b'] },
      { question_id: 'scq-000000000002', retrieved: ['ses-c'] },
      { question_id: 'scq-000000000003', retrieved: ['ses-d'] },
    ], labels, 5);
    expect(summary.answerable).toEqual({ n: 3, recall_all_hits: 1, recall_any_hits: 2, errors: 1 });
    expect(summary.abstention_excluded).toBe(1);
    expect(summary.missing_rows).toEqual(['scq-000000000004']);
    expect(summary.by_type['multi-session']).toEqual({ n: 1, recall_all_hits: 0, recall_any_hits: 1, errors: 0 });
    expect(rows.find(r => r.question_id === 'scq-000000000003')!.recall_all).toBeNull();
  });

  test('errored rows stay in the denominator; duplicate rows are refused', () => {
    const { summary } = scoreRetrieval([{ question_id: 'scq-000000000002', retrieved: ['ses-c'], error: 'boom' }], labels, 5);
    expect(summary.by_type['single-session-user']).toEqual({ n: 1, recall_all_hits: 0, recall_any_hits: 0, errors: 1 });
    expect(() => scoreRetrieval([{ question_id: 'a', retrieved: [] }, { question_id: 'a', retrieved: [] }], labels, 5)).toThrow('duplicate');
  });
});

describe('official LongMemEval prompts', () => {
  test('judge templates by type', () => {
    expect(judgePrompt('temporal-reasoning', 'Q', 'A', 'R')).toContain('do not penalize off-by-one errors');
    expect(judgePrompt('knowledge-update', 'Q', 'A', 'R')).toContain('as long as the updated answer is the required answer');
    const abs = judgePrompt('abstention', 'Q?', 'never said', 'R');
    expect(abs).toContain('Does the model correctly identify the question as unanswerable?');
    expect(abs).toContain('Question: Q?\n\nExplanation: never said\n\nModel Response: R');
    expect(judgePrompt('multi-session', 'Q', 'A {}', 'R')).toContain('Correct Answer: A {}');
    expect(judgeSaysYes('Yes.')).toBe(true);
    expect(judgeSaysYes('no')).toBe(false);
  });

  test('reader prompt sorts sessions by date', () => {
    const p = readerPrompt('Q?', '2025/06/01 (Sun) 10:00', [
      { date: '2025/05/02 (Fri) 09:00', turns: [{ role: 'user', content: 'second' }] },
      { date: '2025/04/01 (Tue) 09:00', turns: [{ role: 'user', content: 'first' }] },
    ]);
    expect(p.indexOf('first')).toBeLessThan(p.indexOf('second'));
    expect(p).toContain('Current Date: 2025/06/01 (Sun) 10:00\nQuestion: Q?\nAnswer (step by step):');
  });

  test('solvability summary counts by type', () => {
    const s = summarizeSolvability([
      { question_id: 'a', question_type: 'multi-session', oracle_sessions: 2, oracle_correct: true, no_memory_correct: false, oracle_truncated: false, no_memory_truncated: false },
      { question_id: 'b', question_type: 'multi-session', oracle_sessions: 2, oracle_correct: false, no_memory_correct: false, oracle_truncated: true, no_memory_truncated: false },
    ]);
    expect(s).toMatchObject({ n: 2, oracle_correct: 1, no_memory_correct: 0, truncated_reader_outputs: 1, by_type: { 'multi-session': { n: 2, oracle_correct: 1, no_memory_correct: 0 } } });
  });
});

describe('spend ledger and cache', () => {
  test('reservations are checked against the cap and unsettled ones survive a restart', () => {
    const path = join(tmp(), 'spend.jsonl');
    const ledger = new SpendLedger(path, 1);
    const id = ledger.reserve('a', 'gpt-6-sol', 0.6);
    expect(() => ledger.reserve('b', 'gpt-6-sol', 0.6)).toThrow('spend cap');
    ledger.settle(id, 0.1, null);
    ledger.reserve('c', 'gpt-6-sol', 0.3);
    const reopened = new SpendLedger(path, 1);
    expect(reopened.spentUsd).toBeCloseTo(0.4, 10);
  });

  test('usage pricing uses cached and cache-write rates', () => {
    expect(priceUsage('gpt-6-sol', { input_tokens: 1_000_000, cached_tokens: 500_000, cache_write_tokens: 0, output_tokens: 100_000, reasoning_tokens: 0 })).toBeCloseTo(1 + 0.1 + 1, 10);
  });

  test('cached responses cost nothing; server errors retry and settle at zero', async () => {
    const dir = tmp();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
      return new Response(JSON.stringify({ id: 'r1', model: 'gpt-6-sol', status: 'completed', usage: { input_tokens: 100, output_tokens: 10 }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"x":1}' }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ledger = new SpendLedger(join(dir, 'spend.jsonl'), 1);
    const llm = new LlmClient({ ledger, cacheDir: join(dir, 'cache'), fetchImpl });
    const body = { model: 'gpt-6-sol', input: 'x', max_output_tokens: 100 };
    const first = await llm.openai('t', body, 10);
    expect(first.text).toBe('{"x":1}');
    expect(first.cost_usd).toBeCloseTo((100 * 2 + 10 * 10) / 1e6, 12);
    const second = await llm.openai('t', body, 10);
    expect(second.cached).toBe(true);
    expect(second.cost_usd).toBe(0);
    expect(calls).toBe(2);
    const lines = readFileSync(join(dir, 'spend.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.filter(l => l.type === 'reserve')).toHaveLength(2);
    expect(lines.filter(l => l.type === 'settle').map(l => l.usd)[0]).toBe(0);
  }, 20_000);
});

describe('runner end to end on a public fixture (keyword adapter, no labels)', () => {
  test('retrieved ids come back in the sealed id space and score against labels', async () => {
    const f = sealedFiles(q => { for (const x of q.questions) x.question = 'persona topic'; });
    const q: QuestionsFile = JSON.parse(readFileSync(f.qPath, 'utf8'));
    const labels: LabelsFile = f.labels;
    const [runPath] = await runSealed({ questionsPath: f.qPath, outDir: join(f.dir, 'run'), manifest: f.manifest, adapters: ['keyword'], topK: 5, passthrough: ['--no-cache'] });
    const lines = readFileSync(runPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].record_type).toBe('meta');
    expect(lines[0].questions_sha256).toBe(f.manifest.commitments['questions.json'].sha256);
    const rows = lines.slice(1);
    expect(rows).toHaveLength(q.questions.length);
    const known = new Set(q.haystacks.flatMap(h => h.sessions.map(s => s.session_id)));
    expect(rows.every(r => r.retrieved.length > 0)).toBe(true);
    for (const r of rows) for (const id of r.retrieved) expect(known.has(id)).toBe(true);
    const { summary } = scoreRetrieval(rows, labels.labels, 5);
    expect(summary.answerable.n).toBe(8);
    expect(summary.missing_rows).toEqual([]);
  }, 240_000);
});

describe('committed v1 manifest', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/data/sealed-confirmation-v1/manifest.json'), 'utf8'));

  test('the generator and prompts that made v1 are unchanged (edit them only for a new version)', () => {
    for (const file of ['eval/generators/sealed-confirmation-gen.ts', 'eval/generators/sealed-confirmation-prompts.ts']) {
      expect(sha256File(join(import.meta.dir, '../..', file))).toBe(manifest.generator_source_sha256[file]);
    }
    for (const [name, text] of Object.entries(PROMPT_TEXTS)) {
      expect(manifest.prompt_sha256[name]).toBe(sha256Hex(text));
    }
  });

  test('commits to all three private files and matches the question mix', () => {
    for (const f of ['questions.json', 'labels.json', 'ledger.json']) expect(manifest.commitments[f].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.counts.by_type).toEqual({ 'single-session-user': 30, 'multi-session': 30, 'temporal-reasoning': 30, 'knowledge-update': 30, abstention: 30 });
    expect(manifest.counts.answerable_questions).toBe(120);
  });
});

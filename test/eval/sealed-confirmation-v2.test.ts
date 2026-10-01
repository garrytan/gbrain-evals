/**
 * Sealed confirmation set v2: plan validation, seed lists disjoint from v1,
 * assembly into valid questions and labels files, the chunk oracle, and the
 * committed manifest. Keyless; invented content only.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleV2, bestChunk, chunkOracle, chunkWords, personaSeedsV2, sessionBody, validatePlanV2 } from '../../eval/generators/sealed-confirmation-v2-gen.ts';
import { HOBBIES_V2, LIFE_ARCS_V2, OCCUPATIONS_V2, PROMPT_TEXTS_V2, QUESTION_SLOTS_V2 } from '../../eval/generators/sealed-confirmation-v2-prompts.ts';
import { HOBBIES, LIFE_ARCS, OCCUPATIONS } from '../../eval/generators/sealed-confirmation-prompts.ts';
import type { Plan } from '../../eval/generators/sealed-confirmation-gen.ts';
import { sha256File, sha256Hex, validateLabelsFile, validateQuestionsFile } from '../../eval/runner/sealed-confirmation-lib.ts';

const day = (i: number) => new Date(Date.parse('2025-01-06T00:00:00Z') + i * 20 * 86400000).toISOString().slice(0, 10);

/** A structurally valid v2 plan with obviously fake content: 16 sessions 20 days apart. */
function makePlan(): Plan {
  const sessions = Array.from({ length: 16 }, (_, i) => ({ key: `S${String(i + 1).padStart(2, '0')}`, date: day(i), topic: `topic ${i + 1}`, user_goal: `goal ${i + 1}` }));
  const facts = sessions.flatMap((s, i) => [0, 1].map(j => ({ key: `F${String(i * 2 + j + 1).padStart(2, '0')}`, session_key: s.key, statement: `fact ${i * 2 + j + 1} about gadget-${i}-${j}`, event_date: s.date, purpose: 'background' as const })));
  const ev = (keys: string[]) => { for (const k of keys) facts.find(f => f.key === k)!.purpose = 'question_evidence' as any; return keys; };
  for (const k of ['F04', 'F08', 'F12', 'F16', 'F20', 'F24']) facts.find(f => f.key === k)!.purpose = 'near_miss' as any;
  const qd = day(17);
  const q = (type: any, keys: string[], sessionsKeys: string[], extra: Partial<Plan['questions'][number]> = {}) => ({ type, question: `${type}?`, answer: 'a', evidence_fact_keys: keys, evidence_session_keys: sessionsKeys, question_date: qd, must_never_state: '', rationale: '', ...extra });
  return {
    persona: { name: 'Example Person', age: 40, occupation: 'x', home_description: 'an invented town', household: 'alone', hobbies: ['a', 'b', 'c'], voice: 'plain' },
    sessions, facts,
    questions: [
      q('multi-session', ev(['F01', 'F07', 'F13']), ['S01', 'S04', 'S07']),
      q('multi-session', ev(['F03', 'F09', 'F15', 'F21']), ['S02', 'S05', 'S08', 'S11']),
      q('temporal-reasoning', ev(['F05', 'F25']), ['S03', 'S13']),
      q('knowledge-update', ev(['F11', 'F17', 'F27']), ['S06', 'S09', 'S14']),
      q('abstention', ['F19', 'F29'], ['S10', 'S15'], { must_never_state: 'the colour of gadget-9' }),
    ],
  };
}

describe('v2 plan validation', () => {
  test('a well-formed plan passes', () => {
    expect(validatePlanV2(makePlan())).toEqual([]);
    expect([...QUESTION_SLOTS_V2]).toEqual(['multi-session', 'multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention']);
  });

  test('rejects answers a single chunk or a short window could cover', () => {
    const p = makePlan();
    p.questions[0].evidence_fact_keys = ['F01', 'F03'];
    p.questions[0].evidence_session_keys = ['S01', 'S02'];
    p.questions[2].evidence_fact_keys = ['F05', 'F06'];
    p.questions[2].evidence_session_keys = ['S03'];
    p.questions[3].evidence_fact_keys = ['F11', 'F17'];
    p.questions[3].evidence_session_keys = ['S06', 'S09'];
    const problems = validatePlanV2(p).join('\n');
    expect(problems).toContain('multi-session#1: needs 3-5 evidence sessions');
    expect(problems).toContain('temporal-reasoning#3: needs 2-4 evidence sessions spanning at least 90 days');
    expect(problems).toContain('knowledge-update#4: needs at least 3 evidence sessions');
  });

  test('rejects short histories, single-session questions and shared evidence', () => {
    const p = makePlan();
    p.sessions = p.sessions.slice(0, 12);
    p.questions[1].evidence_fact_keys = ['F01', 'F09', 'F15'];
    p.questions[1].evidence_session_keys = ['S01', 'S05', 'S08'];
    (p.questions[4] as any).type = 'single-session-user';
    const problems = validatePlanV2(p).join('\n');
    expect(problems).toContain('need 15-17 sessions');
    expect(problems).toContain('fact F01 is evidence for two questions');
    expect(problems).toContain('v2 has no single-session questions');
  });
});

describe('v2 seeds', () => {
  test('seed lists share nothing with v1 and support 40 personas', () => {
    for (const [v2, v1] of [[OCCUPATIONS_V2, OCCUPATIONS], [HOBBIES_V2, HOBBIES], [LIFE_ARCS_V2, LIFE_ARCS]] as const) {
      expect(v2.filter(x => (v1 as readonly string[]).includes(x))).toEqual([]);
      expect(new Set(v2).size).toBe(v2.length);
    }
    const seeds = personaSeedsV2(40, 20261002);
    expect(new Set(seeds.map(s => s.occupation)).size).toBe(40);
    expect(new Set(seeds.flatMap(s => s.hobbies)).size).toBe(120);
    expect(new Set(seeds.map(s => s.life_arc)).size).toBe(40);
  });
});

describe('v2 assembly', () => {
  test('produces valid questions and labels with opaque ids and LongMemEval-sized haystacks', () => {
    const plan = makePlan();
    const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `text ${i}` }));
    const { questions, labels } = assembleV2({
      setId: 'sealed-v2-test', salt: 'salt', seed: 1,
      personas: [1, 2].map(index => ({ index, plan, sessions: new Map(plan.sessions.map(s => [s.key, { turns: turns(16), audit_passed: true }])) })),
      fillers: Array.from({ length: 40 }, (_, i) => ({ index: i + 1, turns: turns(14) })),
    });
    expect(validateQuestionsFile(questions)).toEqual([]);
    expect(validateLabelsFile(labels, questions)).toEqual([]);
    expect(questions.questions).toHaveLength(10);
    expect(questions.haystacks[0].sessions).toHaveLength(16 + 30);
    expect(labels.labels.filter(l => l.question_type === 'multi-session')).toHaveLength(4);
    expect(JSON.stringify(questions)).not.toContain('S01');
  });
});

describe('chunk oracle', () => {
  test('windows overlap like the chunker and pick the chunk holding each fact', () => {
    const words = Array.from({ length: 700 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkWords(words, 300, 50);
    expect(chunks).toHaveLength(3);
    expect(chunks[1].startsWith('w250 ')).toBe(true);
    expect(bestChunk(['nothing here', 'paid $42 for the brass hinge at Corvel Hardware', 'other'], 'I paid $42 for a brass hinge at Corvel Hardware')).toBe(1);
  });

  test('takes at most five chunks in time order and reports how many the evidence needed', () => {
    const session = (id: string, date: string, facts: string[]) => ({ session_id: id, date, statements: facts, turns: [{ role: 'user' as const, content: facts.map(f => `${f} ${'filler '.repeat(320)}`).join(' ') }] });
    const ev = [session('b', '2025/03/01 (Sat) 10:00', ['bought seven lanterns', 'repainted the gazebo']), session('a', '2025/01/01 (Wed) 10:00', ['ordered three crates', 'hired Tamsin Orlow', 'paid 90 dollars'])];
    const r = chunkOracle(ev, 5);
    expect(r.needed).toBe(5);
    expect(r.chunks[0].session_id).toBe('a');
    expect(chunkOracle(ev, 3).chunks).toHaveLength(3);
    expect(sessionBody([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toBe('**user:** hi\n\n**assistant:** yo');
  });
});

describe('committed v2 manifest', () => {
  const path = join(import.meta.dir, '../../eval/data/sealed-confirmation-v2/manifest.json');
  test.skipIf(!existsSync(path))('commits to the private files, records the generator and prompts, and matches the question mix', () => {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    for (const f of ['questions.json', 'labels.json', 'ledger.json']) expect(m.commitments[f].sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const f of ['eval/generators/sealed-confirmation-v2-gen.ts', 'eval/generators/sealed-confirmation-v2-prompts.ts']) expect(sha256File(join(import.meta.dir, '../..', f))).toBe(m.generator_source_sha256[f]);
    for (const [name, text] of Object.entries(PROMPT_TEXTS_V2)) expect(m.prompt_sha256[name]).toBe(sha256Hex(text));
    expect(m.counts.by_type['single-session-user']).toBe(0);
    expect(m.counts.by_type['multi-session']).toBe(2 * m.counts.personas);
  });
});

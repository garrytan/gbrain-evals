/**
 * The SOTA loop's answerability rule (eval/runner/sota/answerability.ts, W1-e), its sealed-id guard
 * (eval/runner/sota/sealed-guard.ts) and dev pool v2's BEAM suite (W1-f). Keyless: it reads committed files only.
 *
 * The October bridge reproduces GBEV-73's correction 8 from A4's October judge scores, and the committed BEAM-1M classes
 * reproduce the A4 re-judge's table (claude-opus-5-5 judging A4's gpt-6.1-sol answers) on GST-2339's 126 checked items.
 * The guard test injects one id from every split file into copies of the answerability files and of the SOTA output
 * and drive-export fixtures under test/fixtures/sota/, and expects each copy refused and each real file passed.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ANSWERABILITY_DIR, beamChecks, buildAll, classify, classTable, fileText, loadClasses, octoberOracle, oracleFromRejudge, oracleRows,
  rejectedByBoth, SOURCES, type Check, type ItemClass, type OracleRow,
} from '../../eval/runner/sota/answerability.ts';
import { assertNoSealedIds, findSealedIds, sealedIds, SealedIdError, SPLITS_DIR } from '../../eval/runner/sota/sealed-guard.ts';
import { answerableBeamItems } from '../../eval/runner/nightly/select-devset.ts';

const ROOT = join(import.meta.dir, '../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

const check = (gates: string[], extra: Partial<Check> = {}): Check => ({ checked: true, gates, cited: 12, abstention: false, ...extra });
const BOTH = ['support:gemini:gemini-3.8-flash', 'support:anthropic:claude-haiku-5-5'];
const pass: OracleRow = { score: 0.75, pass: true }, fail: OracleRow = { score: 0.25, pass: false }, cut: OracleRow = { score: null, pass: null };

/** GST-2339's checked BEAM-1M items, the 126 correction 8 and the A4 re-judge's table count. */
const PUBLIC_1M = (JSON.parse(read(SOURCES.gst2339)).items as Array<{ id: string; scale: string; checked: boolean }>).filter(i => i.scale === 'beam-1m' && i.checked).map(i => i.id);

describe('the answerability rule (D5a)', () => {
  test('one validator rejecting, or none, is supported whatever the oracle says', () => {
    expect(classify(check([]), fail).class).toBe('supported');
    expect(classify(check([BOTH[0]!]), fail).class).toBe('supported');
    expect(classify(check([BOTH[1]!]), null)).toEqual({ class: 'supported', gates: [BOTH[1]!], oracle: null });
  });

  test('both validators rejecting: the oracle decides partial or unsupported, and no verdict (none yet, or an empty answer at the limit) is unresolved', () => {
    expect(classify(check(BOTH), pass)).toEqual({ class: 'partial', gates: [...BOTH].sort(), oracle: 'pass' });
    expect(classify(check(BOTH), fail).class).toBe('unsupported');
    expect(classify(check(BOTH), null).class).toBe('unresolved');
    expect(classify(check(BOTH), cut).class).toBe('unresolved');
  });

  test('an item citing no turn counts as rejected by both, so the oracle decides it too', () => {
    expect(rejectedByBoth(check(['uncited']))).toBe(true);
    expect(rejectedByBoth(check([], { cited: 0 }))).toBe(true);
    expect(classify(check(['uncited']), pass).class).toBe('partial');
    expect(classify(check([], { cited: 0 }), fail).class).toBe('unsupported');
  });

  test('an abstention item cites no turn by design: only both validators finding an answer in its absence scan rejects it', () => {
    const abs = (gates: string[]) => check(gates, { cited: 0, abstention: true });
    expect(classify(abs([]), null).class).toBe('supported');
    expect(classify(abs(['absence:gemini:gemini-3.8-flash']), null).class).toBe('supported');
    expect(classify(abs(['absence:gemini:gemini-3.8-flash', 'absence:anthropic:claude-haiku-5-5']), fail).class).toBe('unsupported');
    expect(classify(abs(['absence:gemini:gemini-3.8-flash', 'absence:anthropic:claude-haiku-5-5']), null).class).toBe('unresolved');
  });

  test('an item the support check left out is unchecked, oracle or not', () => {
    expect(classify({ checked: false, gates: [], cited: null, abstention: true }, pass).class).toBe('unchecked');
    expect(classify(null, null).class).toBe('unchecked');
  });
});

describe('the October bridge: correction 8 from A4\'s October judge', () => {
  const checks = beamChecks();
  const october = octoberOracle();
  const verdict = (id: string) => october.get(id)?.pass;

  test('126 checked 1M items; 33 rejected by both validators with a cited turn (oracle 23 pass, 6 fail, 4 empty at the limit), 2 uncited', () => {
    expect(PUBLIC_1M).toHaveLength(126);
    const both = PUBLIC_1M.filter(id => rejectedByBoth(checks.get(id)!) && !checks.get(id)!.gates.includes('uncited'));
    expect(both).toHaveLength(33);
    expect([both.filter(id => verdict(id) === true).length, both.filter(id => verdict(id) === false).length]).toEqual([23, 6]);
    expect(both.filter(id => verdict(id) === null).sort()).toEqual(['1m-20:summarization:0', '1m-28:summarization:0', '1m-30:summarization:0', '1m-32:summarization:0']);
    expect(PUBLIC_1M.filter(id => checks.get(id)!.gates.includes('uncited')).sort()).toEqual(['1m-20:summarization:1', '1m-3:preference_following:1']);
  });

  test('A4\'s oracle passes 35 of the 47 items any gate flags (D5a\'s figure)', () => {
    const flagged = PUBLIC_1M.filter(id => checks.get(id)!.gates.length);
    expect([flagged.length, flagged.filter(id => verdict(id) === true).length]).toEqual([47, 35]);
  });

  test('the rule on October\'s scores gives 91/24/7 plus 4 unresolved; correction 8\'s reading (uncited as supported, empty answers as fails) gives its 93/23/10', () => {
    const items: Record<string, ItemClass> = Object.fromEntries(PUBLIC_1M.map(id => [id, classify(checks.get(id)!, october.get(id) ?? null)]));
    expect(classTable(items).overall).toEqual({ supported: 91, partial: 24, unsupported: 7, unresolved: 4, unchecked: 0 });
    const c8 = PUBLIC_1M.map(id => {
      const c = checks.get(id)!;
      if (!BOTH.every(v => c.gates.includes(v))) return 'supported';
      return verdict(id) === true ? 'partial' : 'unsupported';
    });
    expect(['supported', 'partial', 'unsupported'].map(k => c8.filter(x => x === k).length)).toEqual([93, 23, 10]);
  });
});

describe('the committed answerability files', () => {
  test('equal a rebuild from their committed inputs, and the folder holds nothing else', () => {
    const files = buildAll();
    expect(files.map(f => f.benchmark)).toEqual(['beam-100k', 'beam-500k', 'beam-1m', 'lme-s']);
    for (const f of files) expect(read(join(ANSWERABILITY_DIR, `${f.benchmark}.json`))).toBe(fileText(f));
    expect(readdirSync(join(ROOT, ANSWERABILITY_DIR)).sort()).toEqual(['beam-100k.json', 'beam-1m.json', 'beam-500k.json', 'lme-s.json', 'oracle']);
    expect(readdirSync(join(ROOT, ANSWERABILITY_DIR, 'oracle')).sort()).toEqual(['beam-1m.json', 'lme-s.json']);
  });

  test('BEAM-1M on the 126 checked items matches the A4 re-judge\'s table, overall and per ability', () => {
    const f = JSON.parse(read(join(ANSWERABILITY_DIR, 'beam-1m.json'))) as { items: Record<string, ItemClass> };
    const t = classTable(f.items, PUBLIC_1M);
    expect(t.overall).toEqual({ supported: 91, partial: 19, unsupported: 12, unresolved: 4, unchecked: 0 });
    const row = (supported: number, partial: number, unsupported: number, unresolved = 0) => ({ supported, partial, unsupported, unresolved, unchecked: 0 });
    expect(t.per_ability).toEqual({
      contradiction_resolution: row(8, 1, 5), event_ordering: row(9, 5, 0), information_extraction: row(12, 2, 0),
      instruction_following: row(12, 2, 0), knowledge_update: row(12, 1, 1), multi_session_reasoning: row(5, 6, 3),
      preference_following: row(13, 1, 0), summarization: row(8, 1, 1, 4), temporal_reasoning: row(12, 0, 2),
    });
  });

  test('the BEAM-1M oracle is claude-opus-5-5 on A4\'s 220 rows: the same 9 empty answers have no verdict, and of the other 211 it agrees with October\'s judge on 200 (October alone passes 10, Opus alone 1)', () => {
    const opus = oracleRows('beam-1m'), october = octoberOracle();
    expect(opus.size).toBe(220);
    expect(JSON.parse(read(SOURCES.oracle('beam-1m'))).judge).toBe('anthropic:claude-opus-5-5');
    const both = [...opus].filter(([id, r]) => r.pass !== null && october.get(id)?.pass !== null);
    expect(both).toHaveLength(211);
    expect(both.filter(([id, r]) => r.pass === october.get(id)!.pass)).toHaveLength(200);
    expect(both.filter(([id, r]) => !r.pass && october.get(id)!.pass)).toHaveLength(10);
    expect(both.filter(([id, r]) => r.pass && !october.get(id)!.pass)).toHaveLength(1);
    expect([...opus.values()].filter(r => r.pass === null)).toHaveLength(9);
  });

  test('lme-s-hard: 35 supported; of the 15 both validators reject, the LongMemEval oracle passes 11 (partial) and fails 4', () => {
    expect(loadClasses('lme-s')!.size).toBe(50);
    expect(JSON.parse(read(join(ANSWERABILITY_DIR, 'lme-s.json'))).counts).toEqual({ supported: 35, partial: 11, unsupported: 4, unresolved: 0, unchecked: 0 });
    const oracle = oracleRows('lme-s');
    expect(oracle.size).toBe(50);
    expect([...oracle.values()].filter(r => r.pass === true)).toHaveLength(41);
    expect([...oracle.values()].filter(r => r.pass === null)).toHaveLength(0);
  });

  test('the A4 import refuses another judge, a wrong row count, a verdict that disagrees with its score, and a sealed id', () => {
    const rows = Object.fromEntries([...oracleRows('beam-1m')].map(([id, r]) => [id, { ...r, empty_at_limit: r.pass === null }]));
    const rejudge = (patch: object) => JSON.stringify({ schema: 'sota-a4-rejudge/1', judge: 'anthropic:claude-opus-5-5', answers: 'a4', judge_prompt: {}, pass_threshold: 0.5, rows, ...patch });
    expect(JSON.parse(oracleFromRejudge(rejudge({}))).rows).toEqual(JSON.parse(read(SOURCES.oracle('beam-1m'))).rows);
    expect(() => oracleFromRejudge(rejudge({ judge: 'openai:gpt-6.1-sol' }))).toThrow('must be judged by anthropic:claude-opus-5-5');
    const [first, ...rest] = Object.keys(rows);
    expect(() => oracleFromRejudge(rejudge({ rows: Object.fromEntries(rest.map(id => [id, rows[id]])) }))).toThrow("219 rows, not A4's 220");
    expect(() => oracleFromRejudge(rejudge({ rows: { ...rows, [first!]: { score: 0.25, pass: true, empty_at_limit: false } } }))).toThrow('disagrees with score');
    const sealed = Object.fromEntries(Object.entries(rows).map(([id, r], i) => [i === 0 ? '1m-1:abstention:0' : id, r]));
    expect(() => oracleFromRejudge(rejudge({ rows: sealed }))).toThrow(SealedIdError);
  });
});

describe('the sealed-id guard', () => {
  const splitFiles = readdirSync(SPLITS_DIR).filter(n => n.endsWith('.json')).sort();
  const idsOf = (name: string) => {
    const s = JSON.parse(readFileSync(join(SPLITS_DIR, name), 'utf8')) as { sealed?: unknown[]; exclusions?: Array<{ question?: unknown }> };
    return [...(s.sealed ?? []).filter((x): x is string => typeof x === 'string'), ...(s.exclusions ?? []).map(e => e.question).filter((x): x is string => typeof x === 'string')];
  };
  const targets = [...walk(join(ROOT, ANSWERABILITY_DIR)), ...walk(join(ROOT, 'test/fixtures/sota'))].map(p => relative(ROOT, p)).sort();
  const inject = (text: string, id: string, at: string) => (at.endsWith('.json') ? text.replace('{', `{\n "${id}": {},`) : `${text}| ${id} | supported | context_use | claude-opus-5-5 |\n`);

  test('every split file with a string id contributes it; only all-dev and seed-only files contribute none', () => {
    const all = new Set(sealedIds());
    expect(splitFiles.filter(n => !idsOf(n).length)).toEqual(['bg1-dev.json', 'hub-world.json', 'lme-s.json']);
    for (const n of splitFiles) for (const id of idsOf(n)) expect(all.has(id)).toBe(true);
    expect(idsOf('beam-rs1.json').length).toBeGreaterThan(0);
    expect(idsOf('beam-10m.json')).toContain('10m-1:abstention:0');
  });

  test('scans the answerability files and the SOTA output and drive-export fixtures, and passes every real one', () => {
    expect(targets).toContain('eval/data/answerability/beam-1m.json');
    expect(targets).toContain('eval/data/answerability/oracle/beam-1m.json');
    expect(targets).toContain('test/fixtures/sota/output/answerability-slice.json');
    expect(targets).toContain('test/fixtures/sota/drive-export/weekly-digest.md');
    for (const t of targets) expect(() => assertNoSealedIds(read(t), t)).not.toThrow();
  });

  test('refuses a copy of each of them holding an id from any split file, beam-rs1.json included, naming only the count', () => {
    for (const n of splitFiles) {
      const ids = idsOf(n);
      if (!ids.length) continue;
      for (const t of targets) {
        const text = inject(read(t), ids[0]!, t);
        expect(() => assertNoSealedIds(text, t)).toThrow(SealedIdError);
        expect(() => assertNoSealedIds(text, t)).toThrow(`SOTA_SEALED_ID: ${t} holds 1 sealed id from eval/decisions/splits; sealed rows stay in custody`);
      }
    }
  });

  test('matches whole ids: a sealed conversation matches its item ids, never a longer dev id it prefixes', () => {
    const sealed = new Set(sealedIds());
    const dev = JSON.parse(readFileSync(join(SPLITS_DIR, 'beam-1m.json'), 'utf8')).dev as string[];
    const [s, d] = [...sealed].flatMap(x => dev.filter(y => y !== x && y.startsWith(x)).map(y => [x, y] as const))[0]!;
    expect(findSealedIds(`${d}:abstention:0 ${d}`)).toEqual([]);
    expect(findSealedIds(`"${s}:abstention:0" and ${d}`)).toEqual([s]);
  });
});

describe('dev pool v2 (W1-f): beam-1m-hard', () => {
  const devset = JSON.parse(read('eval/data/nightly/devset-v2.json')) as { version: number; suites: Array<{ id: string; items: Array<{ id: string }>; config?: { conversations?: string[] } }> };
  const beam = devset.suites.find(s => s.id === 'beam-1m-hard')!;
  const classes = loadClasses('beam-1m')!;
  const dev = JSON.parse(readFileSync(join(SPLITS_DIR, 'beam-1m.json'), 'utf8')).dev as string[];

  test('is every supported or partial BEAM-1M item, all in dev conversations: 126 over 8 conversations', () => {
    expect(devset.version).toBe(2);
    const ids = beam.items.map(i => i.id);
    expect(ids).toEqual([...classes].filter(([, c]) => c === 'supported' || c === 'partial').map(([id]) => id).sort());
    expect(ids).toHaveLength(126);
    expect(beam.config!.conversations).toEqual(['1m-2', '1m-20', '1m-24', '1m-25', '1m-28', '1m-3', '1m-30', '1m-32']);
    for (const id of ids) expect(dev).toContain(id.split(':')[0]!);
    expect(() => assertNoSealedIds(read('eval/data/nightly/devset-v2.json'), 'devset-v2.json')).not.toThrow();
  });

  test('refuses an answerable item from a sealed conversation', () => {
    const sealed = new Map(classes).set('1m-1:temporal_reasoning:0', 'supported');
    expect(() => answerableBeamItems(sealed, dev)).toThrow('DEVSET_SEALED: 1 answerable BEAM-1M items are not in a dev conversation');
    expect(answerableBeamItems(new Map(classes).set('1m-1:temporal_reasoning:0', 'unsupported'), dev)).toEqual(beam.items.map(i => i.id));
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryEntry } from '../../eval/registry.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { N13_CORPUS_DIR, verifyVendoredCorpus } from '../../eval/generators/n13-code-scout-vendor.ts';
import { N13_GOLD_PATH, buildTsGold, goldJson, type GoldCall, type GoldFunction, type N13Gold } from '../../eval/generators/n13-ts-gold.ts';
import { CODE_OPS, checkCallers, checkDef, checkRefs, runN13, summarizeN13, type CallerEdge, type DefHit } from '../../eval/runner/n13-code-intelligence.ts';

const tmp = mkdtempSync(join(tmpdir(), 'n13-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const gold = JSON.parse(readFileSync(N13_GOLD_PATH, 'utf8')) as N13Gold;

describe('corpus and gold', () => {
  test('the vendored corpus matches its manifest; a tampered file is named with both hashes', () => {
    expect(verifyVendoredCorpus().problems).toEqual([]);
    const copy = join(tmp, 'corpus');
    cpSync(N13_CORPUS_DIR, copy, { recursive: true });
    const victim = join(copy, 'pathe/src/_path.ts.txt');
    writeFileSync(victim, readFileSync(victim, 'utf8') + '\n// edited\n');
    const { problems } = verifyVendoredCorpus(copy);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^pathe\/src\/_path\.ts\.txt: sha256 [0-9a-f]{64}, manifest says fe4f45fc/);
  });

  test('the committed compiler gold rebuilds byte-identically (CI never trusts a hand edit)', () => {
    expect(goldJson(buildTsGold())).toBe(readFileSync(N13_GOLD_PATH, 'utf8'));
    expect(gold.typescript_version).toBe('5.9.3');
    expect(gold.functions.length).toBeGreaterThan(40);
    expect(gold.calls.some(c => !c.same_file)).toBe(true);
  });

  test('the registry row is a report-only scout with exploratory metrics only', () => {
    const e = registryEntry('N13')!;
    expect(e.gate).toBe('report-only');
    expect([e.promotion!.safety_contracts.length, e.promotion!.quality_thresholds.length]).toEqual([0, 0]);
  });
});

describe('checks on hand-built gold', () => {
  const fn = (name: string, file: string, start: number, end: number, refs: Array<[string, number]> = []): GoldFunction => ({ name, file, start_line: start, end_line: end, exported: true, references: refs.map(([f, l]) => ({ file: f, line: l })) });
  const g = fn('join', 'src/a.ts', 10, 20, [['src/a.ts', 30], ['src/b.ts', 5]]);

  test('checkDef: right file and span passes; wrong file, no result and a second-ranked hit fail top-1', () => {
    expect(checkDef(g, [{ file: 'src/a.ts', start_line: 9, end_line: 21 }]).top1_span_ok).toBe(true);
    expect(checkDef(g, [{ file: 'src/b.ts', start_line: 9, end_line: 21 }]).top1_span_ok).toBe(false);
    expect(checkDef(g, []).top1_span_ok).toBe(false);
    const second = checkDef(g, [{ file: 'src/b.ts', start_line: 1, end_line: 3 }, { file: 'src/a.ts', start_line: 10, end_line: 20 }]);
    expect([second.top1_span_ok, second.any_span_ok]).toEqual([false, true]);
  });

  test('checkRefs: a chunk holding only a substring (joinPath) is lexical-only; the definition chunk is neither', () => {
    const c = checkRefs(g, [
      { file: 'src/a.ts', start_line: 10, end_line: 20 },
      { file: 'src/a.ts', start_line: 28, end_line: 32 },
      { file: 'src/c.ts', start_line: 1, end_line: 9 },
    ]);
    expect([c.chunks_with_semantic_reference, c.chunks_lexical_only, c.references_covered, c.gold_references]).toEqual([1, 1, 1, 2]);
  });

  test('checkCallers: splits same-file and cross-file calls and reads resolution from the flag and the metadata', () => {
    const calls: GoldCall[] = [
      { caller: 'normalize', caller_file: 'src/a.ts', callee: 'isAbsolute', callee_file: 'src/a.ts', line: 3, same_file: true },
      { caller: 'normalize', caller_file: 'src/a.ts', callee: 'winPath', callee_file: 'src/b.ts', line: 4, same_file: false },
      { caller: 'resolve', caller_file: 'src/a.ts', callee: 'isAbsolute', callee_file: 'src/a.ts', line: 8, same_file: true },
    ];
    const edges = new Map<string, CallerEdge[]>([
      ['isAbsolute', [{ from_symbol_qualified: 'normalize', edge_metadata: { resolved_chunk_id: 7 }, resolved: false }, { from_symbol_qualified: 'other', resolved: false }]],
      ['winPath', [{ from_symbol_qualified: 'normalize', edge_metadata: {}, resolved: false }]],
    ]);
    const c = checkCallers(calls, edges);
    expect(c.same_file).toEqual({ edges: 2, found: 1, resolved_in_metadata: 1 });
    expect(c.cross_file).toEqual({ edges: 1, found: 1, resolved_in_metadata: 0 });
    expect([c.gbrain_edges, c.gbrain_edges_resolved_flag_true, c.gbrain_edges_resolved_in_metadata, c.gbrain_edges_without_checker_call]).toEqual([3, 0, 1, 1]);
  });
});

describe('N13 checks reject the fake systems', () => {
  type Answer = { defs: DefHit[]; callers: string[] };
  const probes = gold.functions;
  const callersOfGold = (name: string) => [...new Set(gold.calls.filter(c => c.callee === name).map(c => c.caller))];
  const others = (f: GoldFunction) => gold.functions.find(x => x.file !== f.file)!;
  const score = (answers: readonly Answer[]) => {
    const defs = probes.map((f, i) => checkDef(f, answers[i].defs));
    const callers = checkCallers(gold.calls, new Map(probes.map((f, i) => [f.name, answers[i].callers.map(c => ({ from_symbol_qualified: c, resolved: false }))])));
    const extra = callers.gbrain_edges_without_checker_call;
    const pass = defs.every(d => d.top1_span_ok) && callers.same_file.found === callers.same_file.edges && callers.cross_file.found === callers.cross_file.edges && extra === 0;
    return { pass, detail: `def ${defs.filter(d => d.top1_span_ok).length}/${defs.length}, callers ${callers.same_file.found + callers.cross_file.found}/${callers.same_file.edges + callers.cross_file.edges}, extra ${extra}` };
  };
  const truthDef = (f: GoldFunction): DefHit => ({ file: f.file, start_line: f.start_line, end_line: f.end_line });

  test('honest passes; empty, always-positive, always-refuse and wrong-source fail; stale is not applicable', () => {
    assertScorerRejectsFakeSystems<GoldFunction, Answer>({
      category: 'N13',
      probes,
      score,
      notApplicable: { stale: 'code at one pinned commit has no time axis' },
      space: {
        truth: f => ({ defs: [truthDef(f)], callers: callersOfGold(f.name) }),
        empty: () => ({ defs: [], callers: [] }),
        // Every function is a definition of every name and calls everything.
        everything: f => ({ defs: [truthDef(others(f)), truthDef(f)], callers: gold.functions.map(x => x.name) }),
        refusal: () => ({ defs: [], callers: [] }),
        wrongSource: f => ({ defs: [truthDef(others(f))], callers: callersOfGold(others(f).name) }),
      },
    });
  });
});

describe('scout run on the pinned gbrain', () => {
  test('imports the corpus, probes all six ops through the trusted path, and records remote refusal', async () => {
    const before = process.env.GBRAIN_HOME;
    const r = await runN13({ gut: resolveGbrainUnderTest(null) });
    expect(process.env.GBRAIN_HOME).toBe(before);
    expect(r.harnessError).toBeNull();
    expect(r.readiness.map(x => x.op)).toEqual([...CODE_OPS]);
    const s = summarizeN13(r);
    expect(s.def.symbols).toBe(gold.functions.length);
    expect(s.callers).not.toBeNull();
    expect((r.import as { chunks: number }).chunks).toBeGreaterThan(0);
  }, 120_000);
});

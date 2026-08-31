/**
 * recorder.ts tests — Day 4 of BrainBench v1 Complete.
 *
 * Covers:
 *   - 6-artifact full bundle when AdapterExport is provided
 *   - 3-artifact minimal bundle (transcript + scorecard + judge-notes) when export is null
 *   - Atomic writes via tmp+rename (no partial files observable)
 *   - Race-safe collision retry with -2, -3 suffix
 *   - safeStringify handles circular references without throwing
 *   - safeStringify handles typed arrays (Float32Array from embeddings)
 *   - Transcript markdown renders turn types correctly
 *   - Poison fixture matches surface in transcript
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  emitBundle,
  safeStringify,
  type RunBundle,
  type Transcript,
  type Scorecard,
  type AdapterExport,
  type JudgeNote,
} from '../../eval/runner/recorder.ts';

function tmpReportsRoot(): string {
  const dir = join(tmpdir(), `recorder-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function basicTranscript(): Transcript {
  return {
    schema_version: 1,
    probe_id: 'q-0001',
    adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain-0.15.0' },
    started_at: '2026-04-20T10:00:00.000Z',
    ended_at: '2026-04-20T10:00:05.000Z',
    turns: [
      {
        turn_index: 0,
        kind: 'model_call',
        model_call: { model_id: 'claude-sonnet-4-6', input_tokens: 500, output_tokens: 50 },
      },
      {
        turn_index: 1,
        kind: 'tool_call',
        tool_call: { tool_name: 'search', tool_input: { query: 'who is amara' } },
      },
      {
        turn_index: 2,
        kind: 'tool_result',
        tool_result: {
          tool_name: 'search',
          content: '[{"slug":"people/amara","title":"Amara Okafor"}]',
          truncated: false,
          matched_poison_fixture_ids: [],
        },
      },
      {
        turn_index: 3,
        kind: 'final_answer',
        final_answer: {
          text: 'Amara Okafor is a Partner at Halfway Capital.',
          evidence_refs: ['people/amara'],
        },
      },
    ],
    total_input_tokens: 500,
    total_output_tokens: 50,
    elapsed_ms: 5000,
  };
}

function basicScorecard(): Scorecard {
  return {
    schema_version: 1,
    config_card: {
      brainbench_version: '0.15.0',
      adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain-0.15.0' },
      corpus_sha: 'abc123',
      seed: 42,
    },
    cat: 8,
    N: 5,
    metrics: { brain_first_compliance: { mean: 0.96, tolerance: 0.02, per_run: [0.94, 0.96, 0.97] } },
    verdict: 'pass',
  };
}

function basicBundle(opts: {
  withExport?: boolean;
  withJudge?: boolean;
  runId?: string;
  cat?: number;
} = {}): RunBundle {
  const bundle: RunBundle = {
    runId: opts.runId ?? 'run-001',
    cat: opts.cat ?? 8,
    adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain-0.15.0' },
    N: 5,
    transcripts: [basicTranscript()],
    scorecard: basicScorecard(),
  };
  if (opts.withExport) {
    bundle.brainExport = {
      pages: [{ slug: 'people/amara', type: 'person', title: 'Amara Okafor' }],
      graph: {
        nodes: [{ slug: 'people/amara' }],
        edges: [{ from: 'people/amara', to: 'companies/halfway', type: 'works_at' }],
      },
      citations: [{ claim: 'Amara is a Partner', source_slug: 'people/amara' }],
    };
  }
  if (opts.withJudge) {
    bundle.judgeNotes = [
      {
        probe_id: 'q-0001',
        verdict: 'pass',
        scores: [{ criterion_id: 'names_entity', score: 5, rationale: 'correct' }],
        overall_rationale: 'Accurate answer with proper citation.',
      },
    ];
  }
  return bundle;
}

// ─── Bundle emit ──────────────────────────────────────────────────────

describe('emitBundle — full bundle with adapter export', () => {
  let root: string;
  beforeEach(() => {
    root = tmpReportsRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('emits 7 artifacts when brainExport + judgeNotes provided', () => {
    const bundle = basicBundle({ withExport: true, withJudge: true });
    const result = emitBundle(bundle, { reportsRoot: root });

    expect(result.collisionRetry).toBe(false);
    expect(result.files.sort()).toEqual([
      'brain-export.json',
      'citations.json',
      'entity-graph.json',
      'judge-notes.md',
      'scorecard.json',
      'transcript.json',
      'transcript.md',
    ]);
    for (const f of result.files) {
      expect(existsSync(join(result.dir, f))).toBe(true);
    }
  });

  test('transcript.json holds one schema-conformant element per probe', () => {
    const bundle = basicBundle({ withExport: true });
    const result = emitBundle(bundle, { reportsRoot: root });
    const parsed = JSON.parse(readFileSync(join(result.dir, 'transcript.json'), 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].probe_id).toBe('q-0001');
    expect(parsed[0].turns.length).toBe(4);
  });

  test('scorecard.json round-trips through safeStringify', () => {
    const bundle = basicBundle({ withExport: true });
    const result = emitBundle(bundle, { reportsRoot: root });
    const parsed = JSON.parse(readFileSync(join(result.dir, 'scorecard.json'), 'utf8'));
    expect(parsed.cat).toBe(8);
    expect(parsed.N).toBe(5);
    expect(parsed.verdict).toBe('pass');
  });

  test('entity-graph.json contains nodes + edges', () => {
    const bundle = basicBundle({ withExport: true });
    const result = emitBundle(bundle, { reportsRoot: root });
    const graph = JSON.parse(readFileSync(join(result.dir, 'entity-graph.json'), 'utf8'));
    expect(graph.nodes.length).toBe(1);
    expect(graph.edges[0].type).toBe('works_at');
  });

  test('transcript.md includes the probe id and turn markers', () => {
    const bundle = basicBundle({ withExport: true });
    const result = emitBundle(bundle, { reportsRoot: root });
    const md = readFileSync(join(result.dir, 'transcript.md'), 'utf8');
    expect(md).toContain('q-0001');
    expect(md).toContain('Turn 0 — model_call');
    expect(md).toContain('Turn 2 — tool_result');
    expect(md).toContain('Amara Okafor is a Partner at Halfway Capital');
  });
});

describe('emitBundle — 3-artifact fallback when no adapter export', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('emits 4 artifacts (transcripts + scorecard + judge-notes) when brainExport is null', () => {
    const bundle = basicBundle({ withExport: false, withJudge: true });
    const result = emitBundle(bundle, { reportsRoot: root });
    expect(result.files.sort()).toEqual(['judge-notes.md', 'scorecard.json', 'transcript.json', 'transcript.md']);
  });

  test('emits 3 artifacts (transcripts + scorecard) when also no judge notes', () => {
    const bundle = basicBundle({ withExport: false, withJudge: false });
    const result = emitBundle(bundle, { reportsRoot: root });
    expect(result.files.sort()).toEqual(['scorecard.json', 'transcript.json', 'transcript.md']);
  });
});

// ─── Collision retry ──────────────────────────────────────────────────

describe('emitBundle — directory collision retry', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('appends -2 suffix when base dir already exists', () => {
    const bundle = basicBundle({ runId: 'collide' });
    const first = emitBundle(bundle, { reportsRoot: root });
    expect(first.collisionRetry).toBe(false);

    const second = emitBundle(bundle, { reportsRoot: root });
    expect(second.collisionRetry).toBe(true);
    expect(second.dir.endsWith('-2')).toBe(true);

    const third = emitBundle(bundle, { reportsRoot: root });
    expect(third.collisionRetry).toBe(true);
    expect(third.dir.endsWith('-3')).toBe(true);

    // Verify each is a distinct directory
    const allSubdirs = readdirSync(root);
    expect(allSubdirs.length).toBe(3);
  });
});

// ─── Atomic writes ────────────────────────────────────────────────────

describe('atomic writes', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('no .tmp- files left in bundle directory after successful emit', () => {
    const bundle = basicBundle({ withExport: true, withJudge: true });
    const result = emitBundle(bundle, { reportsRoot: root });
    const files = readdirSync(result.dir);
    for (const f of files) {
      expect(f).not.toContain('.tmp-');
    }
  });
});

// ─── safeStringify ────────────────────────────────────────────────────

describe('safeStringify', () => {
  test('handles plain objects', () => {
    expect(safeStringify({ a: 1, b: 'x' })).toBe('{\n  "a": 1,\n  "b": "x"\n}');
  });

  test('handles arrays', () => {
    expect(safeStringify([1, 2, 3])).toBe('[\n  1,\n  2,\n  3\n]');
  });

  test('does not throw on circular references', () => {
    const obj: Record<string, unknown> = { name: 'amara' };
    obj.self = obj;
    expect(() => safeStringify(obj)).not.toThrow();
    const parsed = JSON.parse(safeStringify(obj));
    expect(parsed.self).toBe('[Circular]');
    expect(parsed.name).toBe('amara');
  });

  test('handles Float32Array (embeddings)', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    const out = safeStringify({ embedding });
    const parsed = JSON.parse(out);
    expect(parsed.embedding).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
    ]);
  });

  test('nested circular reference survives', () => {
    const a: Record<string, unknown> = { kind: 'a' };
    const b: Record<string, unknown> = { kind: 'b', a };
    a.b = b; // a → b → a cycle
    expect(() => safeStringify(a)).not.toThrow();
    // Only the back-edge collapses, not the whole subtree.
    const parsed = JSON.parse(safeStringify(a));
    expect(parsed.b.kind).toBe('b');
    expect(parsed.b.a).toBe('[Circular]');
  });

  test('shared NON-cyclic object reference serializes in full at every occurrence (agentic-cats-14)', () => {
    // Pre-fix, the WeakSet accumulated every visited object, so the second
    // occurrence of a shared reference became the string "[Circular]" —
    // silent data loss for a rubric/config object reused across probes.
    const sharedRubric = { id: 'cites_source', weight: 2 };
    const doc = {
      probe_a: { rubric: sharedRubric },
      probe_b: { rubric: sharedRubric },
    };
    const parsed = JSON.parse(safeStringify(doc));
    expect(parsed.probe_a.rubric).toEqual({ id: 'cites_source', weight: 2 });
    expect(parsed.probe_b.rubric).toEqual({ id: 'cites_source', weight: 2 }); // was '[Circular]'
  });

  test('shared array referenced from sibling branches serializes twice', () => {
    const edges = [{ from: 'a', to: 'b' }];
    const doc = { graph: { edges }, export: { edges } };
    const parsed = JSON.parse(safeStringify(doc));
    expect(parsed.graph.edges).toEqual(edges);
    expect(parsed.export.edges).toEqual(edges);
  });

  test('the SAME object visited at different depths in sequence is not a cycle', () => {
    const leaf = { v: 1 };
    const doc = { list: [leaf, { wrap: leaf }, leaf] };
    const parsed = JSON.parse(safeStringify(doc));
    expect(parsed.list[0]).toEqual({ v: 1 });
    expect(parsed.list[1].wrap).toEqual({ v: 1 });
    expect(parsed.list[2]).toEqual({ v: 1 });
  });

  test('honors toJSON like JSON.stringify (Date)', () => {
    const d = new Date('2026-04-20T10:00:00.000Z');
    const parsed = JSON.parse(safeStringify({ at: d }));
    expect(parsed.at).toBe('2026-04-20T10:00:00.000Z');
  });
});

// ─── Write-time schema validation (agentic-cats-18) ──────────────────

describe('emitBundle — write-time schema validation', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('rejects a scorecard that violates the published schema, writing nothing', () => {
    const bundle = basicBundle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bundle.scorecard as any).verdict = 'amazing'; // not in the verdict enum
    expect(() => emitBundle(bundle, { reportsRoot: root })).toThrow(/schema validation/);
    // Validation runs before directory creation: a rejected bundle leaves no artifacts.
    expect(readdirSync(root)).toEqual([]);
  });

  test('rejects a scorecard with an out-of-range cat number', () => {
    const bundle = basicBundle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bundle.scorecard as any).cat = 99;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bundle as any).cat = 99;
    expect(() => emitBundle(bundle, { reportsRoot: root })).toThrow(/enum/);
  });

  test('rejects a transcript whose probe_id fails the schema pattern', () => {
    const bundle = basicBundle();
    bundle.transcripts[0].probe_id = ''; // pattern requires a non-empty id
    expect(() => emitBundle(bundle, { reportsRoot: root })).toThrow(/probe_id|pattern/);
  });

  test('rejects a transcript missing a required field', () => {
    const bundle = basicBundle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (bundle.transcripts[0] as any).turns;
    expect(() => emitBundle(bundle, { reportsRoot: root })).toThrow(/required property "turns"/);
  });

  test('accepts a conformant bundle (the validation gate passes on good input)', () => {
    const bundle = basicBundle({ withExport: true, withJudge: true });
    expect(() => emitBundle(bundle, { reportsRoot: root })).not.toThrow();
  });

  test('accepts real probe-id families the old schema pattern rejected (sig-0001, s-briefing-1)', () => {
    for (const probeId of ['sig-0001', 's-briefing-1', 'p1']) {
      const bundle = basicBundle({ runId: `run-${probeId}` });
      bundle.transcripts[0].probe_id = probeId;
      expect(() => emitBundle(bundle, { reportsRoot: root })).not.toThrow();
    }
  });

  test('accepts a cat 34 scorecard (enum extended past the old 1-12 ceiling)', () => {
    const bundle = basicBundle({ cat: 34 });
    bundle.scorecard.cat = 34;
    expect(() => emitBundle(bundle, { reportsRoot: root })).not.toThrow();
  });
});

// ─── Transcript rendering ─────────────────────────────────────────────

describe('transcript markdown rendering', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('renders poison-fixture matches when present in tool_result', () => {
    const bundle = basicBundle();
    bundle.transcripts[0].turns[2].tool_result!.matched_poison_fixture_ids = ['poison-001'];
    const result = emitBundle(bundle, { reportsRoot: root });
    const md = readFileSync(join(result.dir, 'transcript.md'), 'utf8');
    expect(md).toContain('Matched poison fixtures');
    expect(md).toContain('poison-001');
  });

  test('renders truncation marker when tool_result was capped', () => {
    const bundle = basicBundle();
    bundle.transcripts[0].turns[2].tool_result!.truncated = true;
    const result = emitBundle(bundle, { reportsRoot: root });
    const md = readFileSync(join(result.dir, 'transcript.md'), 'utf8');
    expect(md).toContain('TRUNCATED');
  });

  test('renders multiple probes in one transcript.md', () => {
    const bundle = basicBundle();
    bundle.transcripts.push({
      ...basicTranscript(),
      probe_id: 'q-0002',
      turns: [
        {
          turn_index: 0,
          kind: 'final_answer',
          final_answer: { text: 'Second answer.', evidence_refs: [] },
        },
      ],
    });
    const result = emitBundle(bundle, { reportsRoot: root });
    const md = readFileSync(join(result.dir, 'transcript.md'), 'utf8');
    expect(md).toContain('q-0001');
    expect(md).toContain('q-0002');
    expect(md).toContain('Second answer.');
  });
});

// ─── Judge notes rendering ────────────────────────────────────────────

describe('judge-notes markdown rendering', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('renders verdict + per-criterion scores + rationale', () => {
    const notes: JudgeNote[] = [
      {
        probe_id: 'q-0042',
        rubric_id: 'self-knowledge-v1',
        verdict: 'partial',
        scores: [
          { criterion_id: 'cites_source', score: 3, rationale: 'cited one of two expected' },
          { criterion_id: 'no_hallucination', score: 5, rationale: 'clean' },
        ],
        overall_rationale: 'Partial credit due to missing citation.',
      },
    ];
    const bundle: RunBundle = {
      ...basicBundle(),
      judgeNotes: notes,
    };
    const result = emitBundle(bundle, { reportsRoot: root });
    const md = readFileSync(join(result.dir, 'judge-notes.md'), 'utf8');
    expect(md).toContain('q-0042');
    expect(md).toContain('partial');
    expect(md).toContain('cites_source');
    expect(md).toContain('3/5');
    expect(md).toContain('clean');
    expect(md).toContain('Partial credit due to missing citation');
  });
});

// ─── AdapterExport without citations is handled ──────────────────────

describe('emitBundle — partial adapter export', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('skips citations.json when brainExport.citations is undefined', () => {
    const bundle = basicBundle({ withExport: true });
    delete bundle.brainExport!.citations;
    const result = emitBundle(bundle, { reportsRoot: root });
    expect(result.files).not.toContain('citations.json');
    expect(result.files).toContain('brain-export.json');
    expect(result.files).toContain('entity-graph.json');
  });
});

// ─── Defensive: never writes above reportsRoot ────────────────────────

describe('emitBundle — path safety', () => {
  let root: string;
  beforeEach(() => { root = tmpReportsRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('sanitizes runId with slashes — cannot escape reportsRoot', () => {
    const bundle = basicBundle({ runId: '../../etc/passwd' });
    const result = emitBundle(bundle, { reportsRoot: root });
    expect(result.dir.startsWith(root)).toBe(true);
  });

  test('sanitizes adapter name containing special chars', () => {
    const bundle = basicBundle();
    bundle.adapter.name = 'bad/adapter\\name with spaces';
    const result = emitBundle(bundle, { reportsRoot: root });
    expect(result.dir.startsWith(root)).toBe(true);
    expect(result.dir).not.toContain(' ');
    expect(result.dir).not.toContain('\\');
  });
});

// ─── sanity check: writeFileSync is reachable from Bun tests ──────────

describe('test environment sanity', () => {
  test('can write + read a file', () => {
    const p = join(tmpdir(), `recorder-sanity-${Date.now()}`);
    writeFileSync(p, 'hello');
    expect(readFileSync(p, 'utf8')).toBe('hello');
    rmSync(p);
  });
});

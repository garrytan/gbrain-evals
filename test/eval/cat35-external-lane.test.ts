/**
 * Cat 35 external lane (--external-lane NAME --external-dir DIR): $0, no network.
 *
 * The folder holds documents another system wrote, so the runner treats it as
 * hostile. These tests cover:
 *   - lane-name validation (it becomes a receipt key and an artifact file name)
 *   - readExternalDocs refusing symlinks (including one to /proc/self/environ),
 *     special files, hard links, oversized files, too many claims, invalid
 *     UTF-8 and unsafe transcript ids, and hashing every file it reads
 *   - CLI refusals before any work
 *   - hermetic runs (stubbed judge and gbrain, fetch forbidden, an empty budget
 *     ledger): the receipt records the name, the directory, each file's sha256
 *     and the provenance note; a hostile folder stops the run before any judge
 *     call; the built-in lanes score the same with or without the external lane
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initLedger, readLedger } from '../../eval/runner/budget-ledger.ts';
import { segmentClaims } from '../../eval/runner/cat35-checks.ts';
import {
  completedWs0Receipt,
  EXTERNAL_DOC_MAX_BYTES,
  EXTERNAL_DOC_MAX_CLAIMS,
  EXTERNAL_PROVENANCE_NOTE,
  externalLaneNameError,
  readExternalDocs,
} from '../../eval/runner/cat35-transcript-distill.ts';
import { collectNativeRows35 } from '../../eval/runner/situation-recall-native-35.ts';

const ROOT = resolve(import.meta.dir, '../..');
const RUNNER = join(ROOT, 'eval/runner/cat35-transcript-distill.ts');
const GOLD_DIR = join(ROOT, 'eval/data/transcript-distill-v1/gold');
const gold = (tid: string) => JSON.parse(readFileSync(join(GOLD_DIR, `${tid}.json`), 'utf8'));
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('externalLaneNameError', () => {
  test('accepts short lowercase names', () => {
    for (const name of ['a', 'carafe', 'my-tool-2', `a${'b'.repeat(31)}`]) expect(externalLaneNameError(name)).toBeNull();
  });

  test('refuses built-in lanes, none, and inherited object keys', () => {
    for (const name of ['verbatim', 'facts', 'dream', 'none']) expect(externalLaneNameError(name)).toContain('built-in');
    expect(externalLaneNameError('constructor')).toContain('reserved');
  });

  test('refuses names that are unsafe as receipt keys or file names', () => {
    for (const name of ['', 'Carafe', 'my tool', '../x', 'a/b', 'a.b', '-lead', '2fast', 'x'.repeat(33)]) {
      expect(externalLaneNameError(name)).toContain('must match');
    }
  });
});

describe('readExternalDocs on a hostile folder', () => {
  const ids = ['alpha-01', 'beta-02', 'gamma-03'];

  function folder(files: Record<string, string | Buffer> = {}): string {
    const dir = scratch('cat35-ext-');
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  test('reads present documents in corpus order, records missing ones and hashes the raw bytes', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Gamma\n\nShipped the fix.\n')]);
    const dir = folder({ 'gamma-03.md': bom, 'alpha-01.md': '', 'unrelated.md': 'never read', 'beta-02.txt': 'wrong extension' });
    try {
      const out = readExternalDocs(dir, ids);
      expect([...out.docs.keys()]).toEqual(['alpha-01', 'gamma-03']);
      expect(out.docs.get('alpha-01')).toBe('');
      expect(Buffer.from(out.docs.get('gamma-03')!, 'utf8').equals(bom)).toBe(true);
      expect(out.missing).toEqual(['beta-02']);
      expect(out.files).toEqual([
        { transcript_id: 'alpha-01', file: 'alpha-01.md', bytes: 0, sha256: sha256('') },
        { transcript_id: 'gamma-03', file: 'gamma-03.md', bytes: bom.length, sha256: sha256(bom) },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a symlink, wherever it points', () => {
    const outside = folder({ 'secret.txt': 'OUTSIDE' });
    const targets = [join(outside, 'secret.txt'), '/proc/self/environ', 'beta-02.md', join(outside, 'nowhere')];
    try {
      for (const target of targets) {
        const dir = folder({ 'beta-02.md': 'inside' });
        try {
          symlinkSync(target, join(dir, 'alpha-01.md'));
          expect(() => readExternalDocs(dir, ids)).toThrow('alpha-01.md is a symlink');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('refuses a FIFO without blocking, and a directory, by name', () => {
    const dir = folder();
    try {
      expect(Bun.spawnSync(['mkfifo', join(dir, 'alpha-01.md')]).exitCode).toBe(0);
      expect(() => readExternalDocs(dir, ids)).toThrow('alpha-01.md is not a regular file');
      rmSync(join(dir, 'alpha-01.md'));
      mkdirSync(join(dir, 'alpha-01.md'));
      expect(() => readExternalDocs(dir, ids)).toThrow('alpha-01.md is not a regular file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a hard-linked file', () => {
    const outside = folder({ 'secret.txt': 'OUTSIDE' });
    const dir = folder();
    try {
      linkSync(join(outside, 'secret.txt'), join(dir, 'alpha-01.md'));
      expect(() => readExternalDocs(dir, ids)).toThrow('alpha-01.md has 2 hard links');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('accepts exactly the byte limit and refuses one byte more', () => {
    const atLimit = folder({ 'alpha-01.md': 'a'.repeat(EXTERNAL_DOC_MAX_BYTES) });
    const over = folder({ 'alpha-01.md': 'a'.repeat(EXTERNAL_DOC_MAX_BYTES + 1) });
    try {
      expect(readExternalDocs(atLimit, ids).files[0].bytes).toBe(EXTERNAL_DOC_MAX_BYTES);
      expect(() => readExternalDocs(over, ids)).toThrow(`over the ${EXTERNAL_DOC_MAX_BYTES}-byte limit`);
    } finally {
      rmSync(atLimit, { recursive: true, force: true });
      rmSync(over, { recursive: true, force: true });
    }
  });

  test('refuses more claims than the grounding judge grades in one call', () => {
    const doc = (n: number) => Array.from({ length: n }, (_, i) => `- Claim number ${i} is a stated fact.`).join('\n');
    expect(segmentClaims(doc(EXTERNAL_DOC_MAX_CLAIMS + 1))).toHaveLength(EXTERNAL_DOC_MAX_CLAIMS + 1);
    const atLimit = folder({ 'alpha-01.md': doc(EXTERNAL_DOC_MAX_CLAIMS) });
    const over = folder({ 'alpha-01.md': doc(EXTERNAL_DOC_MAX_CLAIMS + 1) });
    try {
      expect(readExternalDocs(atLimit, ids).docs.has('alpha-01')).toBe(true);
      expect(() => readExternalDocs(over, ids)).toThrow(`${EXTERNAL_DOC_MAX_CLAIMS + 1} claims`);
    } finally {
      rmSync(atLimit, { recursive: true, force: true });
      rmSync(over, { recursive: true, force: true });
    }
  });

  test('refuses invalid UTF-8 and a transcript id that is not a plain file name', () => {
    const dir = folder({ 'alpha-01.md': Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) });
    try {
      expect(() => readExternalDocs(dir, ids)).toThrow('alpha-01.md is not valid UTF-8');
      for (const tid of ['../alpha-01', 'a/b', '.hidden', '']) {
        expect(() => readExternalDocs(dir, [tid])).toThrow('not a safe file name');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WS0 publishability', () => {
  test('a full run that scored an external lane is never publishable', () => {
    const base = {
      mode: 'full', gatePass: true, perItem: [], errors: [], resolvedConfig: {},
      judge: { model: 'm', temperature: 0, rubric_version: 'v' }, data: {}, startedAt: '2026-10-31T00:00:00.000Z',
    };
    expect(completedWs0Receipt(base).publishable).toBe(true);
    expect(completedWs0Receipt({ ...base, externalLane: true }).publishable).toBe(false);
  });
});

describe('CLI refusals', () => {
  test('bad flag combinations exit 2 before any work', () => {
    const cwd = scratch('cat35-ext-cli-');
    try {
      writeFileSync(join(cwd, 'a-file'), 'not a directory');
      mkdirSync(join(cwd, 'docs-dir'));
      const cases: Array<[string[], string]> = [
        [['--external-lane', 'carafe'], 'go together'],
        [['--external-dir', 'docs-dir'], 'go together'],
        [['--external-lane', 'Carafe', '--external-dir', 'docs-dir'], 'must match'],
        [['--external-lane', 'dream', '--external-dir', 'docs-dir'], 'built-in'],
        [['--external-lane', 'carafe', '--external-dir', 'no-such-dir'], 'not found'],
        [['--external-lane', 'carafe', '--external-dir', 'a-file'], 'not a directory'],
        [['--lanes', 'none'], '--lanes none needs'],
        [['--lanes', 'none,verbatim', '--external-lane', 'carafe', '--external-dir', 'docs-dir'], "unknown lane 'none'"],
      ];
      for (const [args, message] of cases) {
        const proc = Bun.spawnSync([process.execPath, RUNNER, ...args], {
          cwd, env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
        });
        expect(proc.exitCode, args.join(' ')).toBe(2);
        expect(proc.stderr.toString()).toContain(message);
      }
      expect(existsSync(join(cwd, 'eval'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─── Hermetic runs ────────────────────────────────────────────────────────

function preload(requestLog: string): string {
  return `
import { mock } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root = ${JSON.stringify(ROOT)};
globalThis.fetch = async () => { throw new Error('Network forbidden in the Cat35 external-lane test'); };
const goldOf = (tid) => JSON.parse(readFileSync(join(root, 'eval/data/transcript-distill-v1/gold', tid + '.json'), 'utf8'));
class Engine {
  pages = new Map();
  async connect() {}
  async initSchema() {}
  async disconnect() {}
  async setConfig() {}
  async getPage(slug) { return this.pages.get(slug) ?? null; }
  async executeRaw() { throw new Error('facts lane must not run'); }
}
mock.module('gbrain/pglite-engine', () => ({ PGLiteEngine: Engine }));
mock.module('gbrain/ai/gateway', () => ({ configureGateway() {} }));
mock.module('gbrain/import-file', () => ({ async importFromContent() {} }));
mock.module(join(root, 'node_modules/gbrain/src/core/transcripts/ingest.ts'), () => ({
  async runTranscriptsIngest(engine, opts) {
    const tids = opts.paths.map((p) => basename(p).slice(11, -6));
    for (const tid of tids) {
      const g = goldOf(tid);
      engine.pages.set('session/' + tid, { compiled_truth: readFileSync(join(root, 'eval/data/transcript-distill-v1/transcripts-txt', g.base_ts.slice(0, 10) + '-' + tid + '.txt'), 'utf8') });
    }
    return { pages: { imported: tids.length }, sessionsImported: tids.length, sessionsSeen: tids.length, cleanScan: true,
      files: [{ sessions: tids.map((tid) => ({ sessionId: 'cat35-' + tid, baseSlug: 'session/' + tid, parts: 1 })) }] };
  }
}));
mock.module(join(root, 'node_modules/gbrain/src/commands/extract-conversation-facts.ts'), () => ({
  async runExtractConversationFactsCore() { throw new Error('facts lane must not run'); }
}));
mock.module(join(root, 'node_modules/gbrain/src/core/cycle/synthesize.ts'), () => ({
  async runPhaseSynthesize() { throw new Error('dream lane must not run'); }
}));
const anchors = new Map();
for (const tid of ['coding-reflection-01', 'coding-reflection-02', 'pure-routine-01']) {
  for (const it of goldOf(tid).items) anchors.set(it.item_id, it.verbatim_anchor);
}
const client = { messages: { async create(req) {
  const tool = req.tools[0].name;
  const text = req.messages[0].content;
  appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ tool, text: text.replace(/nonce="[0-9a-f]+"/g, 'nonce="N"') }) + '\\n');
  let input;
  if (tool === 'score_salient_items') {
    const ids = [...text.matchAll(/item_id=([^:]+):/g)].map((m) => m[1]);
    input = { items: ids.map((id) => text.includes(anchors.get(id)) ? { item_id: id, status: 'FULL', evidence: anchors.get(id) } : { item_id: id, status: 'ABSENT', evidence: '' }) };
  } else if (tool === 'grade_claims') {
    const hazard = JSON.parse(text.match(/<batch label=(.*)>/)[1]).startsWith('hazard:');
    const indexes = [...text.matchAll(/^  (\\d+):/gm)].map((m) => Number(m[1]));
    input = { claims: indexes.map((index) => ({ index, verifiable: true, grounded: !hazard })) };
  } else if (tool === 'confirm_leaks') {
    const ids = [...text.matchAll(/distractor_id=([^:]+):/g)].map((m) => m[1]);
    input = { leaks: ids.map((id) => ({ distractor_id: id, surfaced_as_salient: true })) };
  } else if (tool === 'usability_checklist') {
    const ids = req.tools[0].input_schema.properties.checks.items.properties.id.enum;
    input = { checks: ids.map((id) => ({ id, pass: true })) };
  } else throw new Error('Unknown judge tool ' + tool);
  return { model: 'hermetic-judge', content: [{ type: 'tool_use', id: 'stub', name: tool, input }], usage: { input_tokens: 10, output_tokens: 5 } };
} } };
const judges = await import(join(root, 'eval/runner/cat35-judges.ts'));
const exports = { ...judges };
for (const name of ['scoreGrounding', 'scoreSalienceCoverage', 'confirmDistractorLeaks', 'scoreUsabilityChecklist']) {
  const original = judges[name];
  exports[name] = (args, cfg) => original(args, { ...cfg, client });
}
mock.module(join(root, 'eval/runner/cat35-judges.ts'), () => exports);
`;
}

const TIDS = ['coding-reflection-01', 'coding-reflection-02', 'pure-routine-01'];

interface Run {
  exitCode: number | null;
  stderr: string;
  receipt: any;
  ws0: any;
  requests: Array<{ tool: string; text: string }>;
  artifacts: Record<string, Buffer>;
  ledgerEntries: unknown[];
}

function runHermetic(args: string[], setup?: (dir: string) => void): Run {
  const dir = scratch('cat35-ext-run-');
  try {
    mkdirSync(join(dir, 'eval/data'), { recursive: true });
    symlinkSync(join(ROOT, 'eval/data/transcript-distill-v1'), join(dir, 'eval/data/transcript-distill-v1'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    symlinkSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    const requestLog = join(dir, 'requests.jsonl');
    writeFileSync(join(dir, 'preload.ts'), preload(requestLog));
    initLedger({ ledgerPath: join(dir, 'ledger.sqlite') });
    setup?.(dir);
    const proc = Bun.spawnSync([process.execPath, '--preload', join(dir, 'preload.ts'), RUNNER, '--json', '--transcripts', TIDS.join(','), ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ANTHROPIC_API_KEY: 'stub-only', OPENAI_API_KEY: 'stub-only',
        CAT35_JUDGE_MODEL: 'claude-haiku-4-5-20251001', BRAINBENCH_BUDGET_USD: '5', BRAINBENCH_BUDGET_LEDGER: join(dir, 'ledger.sqlite') },
      stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
    });
    const reports = join(dir, 'eval/reports/cat35-transcript-distill');
    const artifacts: Record<string, Buffer> = {};
    const artifactsDir = existsSync(reports) ? readdirSync(reports).find((p) => p.endsWith('-artifacts')) : undefined;
    if (artifactsDir) for (const f of readdirSync(join(reports, artifactsDir))) artifacts[f] = readFileSync(join(reports, artifactsDir, f));
    const stdout = proc.stdout.toString();
    return {
      exitCode: proc.exitCode,
      stderr: proc.stderr.toString(),
      receipt: stdout.trim() ? JSON.parse(stdout) : null,
      ws0: existsSync(join(reports, 'receipt.json')) ? JSON.parse(readFileSync(join(reports, 'receipt.json'), 'utf8')) : null,
      requests: existsSync(requestLog) ? readFileSync(requestLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [],
      artifacts,
      ledgerEntries: readLedger(join(dir, 'ledger.sqlite')).entries,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const anchor = (tid: string) => gold(tid).items[0].verbatim_anchor as string;
const distractor = (tid: string) => gold(tid).distractors[0].anchor as string;

/** Documents for two of the three transcripts: coding-reflection-01 is missing on purpose. */
function writeExternalDocs(dir: string): Record<string, Buffer> {
  const ext = join(dir, 'carafe-out');
  mkdirSync(ext);
  const docs: Record<string, Buffer> = {
    'coding-reflection-02': Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`# Snapshot loader flake\n\nThe user said ${anchor('coding-reflection-02')}.\n\nAlso: ${distractor('coding-reflection-02')}.\n`),
    ]),
    'pure-routine-01': Buffer.from(''),
  };
  for (const [tid, body] of Object.entries(docs)) writeFileSync(join(ext, `${tid}.md`), body);
  return docs;
}

describe('hermetic external-lane runs', () => {
  test('--lanes none scores only the external lane and the receipt records name, directory, hashes and provenance', () => {
    let docs: Record<string, Buffer> = {};
    let extDir = '';
    const r = runHermetic(['--lanes', 'none', '--external-lane', 'carafe', '--external-dir', 'carafe-out'], (dir) => {
      docs = writeExternalDocs(dir);
      extDir = join(dir, 'carafe-out');
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.ledgerEntries).toEqual([]);
    const rc = r.receipt;
    expect(rc.lanes).toEqual([]);
    expect(rc.mode).toBe('b-pre-validity');
    expect(rc.external_lane).toEqual({
      name: 'carafe',
      dir: extDir,
      max_bytes: EXTERNAL_DOC_MAX_BYTES,
      files: ['coding-reflection-02', 'pure-routine-01'].map((tid) => ({
        transcript_id: tid, file: `${tid}.md`, bytes: docs[tid].length, sha256: sha256(docs[tid]),
      })),
      missing: ['coding-reflection-01'],
      provenance: EXTERNAL_PROVENANCE_NOTE,
    });
    expect(rc.external_lane.provenance).toContain('no record of how they were made');
    expect(rc.lane_errors).toEqual({ 'coding-reflection-01': { carafe: 'no coding-reflection-01.md in --external-dir' } });

    expect(new Set(rc.per_item.map((row: any) => row.lane))).toEqual(new Set(['carafe']));
    const cov = rc.coverage_by_lane.carafe;
    // coding-reflection-01 is a lane error (all ABSENT); coding-reflection-02 has its first item verbatim.
    expect(cov.macro).toBeCloseTo((0 + 1 / 8) / 2, 10);
    expect(cov.joint_macro).toBeCloseTo((0 + 1 / 8) / 2, 10);
    // Two sentences; the heading is not a claim, and the empty document has none.
    expect(rc.hallucination.carafe).toEqual({ claims: 2, verifiable: 2, ungrounded: 0, rate: 0 });
    expect(rc.distractor_leakage.carafe).toEqual({ hits: 1, confirmed: 1, denominator: 8, judge_failed: 0, rate: 1 / 8 });
    expect(rc.usability_by_lane.carafe.rate).toBe(1);
    expect(rc.quote_fidelity_by_lane).toHaveProperty('carafe');
    expect(rc.attribution_hazards.map((h: any) => [h.lane, h.transcript_id, h.violated])).toEqual([
      ['carafe', 'coding-reflection-01', null],
      ['carafe', 'coding-reflection-02', false],
    ]);
    expect(rc.native_evidence.judge_events.every((e: any) => e.lane === 'carafe')).toBe(true);
    const labels = r.requests.filter((q) => q.tool === 'grade_claims').map((q) => JSON.parse(q.text.match(/<batch label=(.*)>/)![1]));
    expect(labels).toEqual(['carafe:coding-reflection-02', `hazard:carafe:${gold('coding-reflection-02').hazards[0].hazard_id}`]);
    // Artifacts are the input bytes, BOM included; the empty document is kept.
    expect(r.artifacts['coding-reflection-02.carafe.md'].equals(docs['coding-reflection-02'])).toBe(true);
    expect(r.artifacts['pure-routine-01.carafe.md'].length).toBe(0);
    expect(r.artifacts['coding-reflection-01.carafe.md']).toBeUndefined();

    expect(r.ws0.publishable).toBe(false);
    expect(r.ws0.resolved_config.external_lane).toEqual(rc.external_lane);
    // A receipt with an external lane cannot feed the native regression collector.
    expect(() => collectNativeRows35({ receipt: rc, gold: TIDS.map(gold), artifacts: { documents: {}, transcripts: {} } }))
      .toThrow('empty or unknown native population');
  }, 90_000);

  test('a symlink in the folder stops the run before any judge call or spend', () => {
    const r = runHermetic(['--lanes', 'none', '--external-lane', 'carafe', '--external-dir', 'carafe-out'], (dir) => {
      writeExternalDocs(dir);
      symlinkSync('/proc/self/environ', join(dir, 'carafe-out', 'coding-reflection-01.md'));
    });
    expect(r.exitCode, r.stderr).toBe(2);
    expect(r.stderr).toContain('coding-reflection-01.md is a symlink');
    expect(r.receipt).toBeNull();
    expect(r.requests).toEqual([]);
    expect(r.ledgerEntries).toEqual([]);
    expect(r.ws0.run_status).toBe('error');
    expect(r.ws0.errors[0].message).toContain('is a symlink');
    expect(r.artifacts).toEqual({});
  }, 90_000);

  test('the built-in lane scores and judge requests are identical with or without the external lane', () => {
    const alone = runHermetic(['--lanes', 'verbatim']);
    const beside = runHermetic(['--lanes', 'verbatim', '--external-lane', 'carafe', '--external-dir', 'carafe-out'], (dir) => {
      writeExternalDocs(dir);
    });
    for (const r of [alone, beside]) expect(r.exitCode, r.stderr).toBe(0);
    expect(beside.receipt.lanes).toEqual(['verbatim']);
    expect(beside.receipt.mode).toBe(alone.receipt.mode);
    expect(alone.receipt.external_lane).toBeNull();
    const verbatimRows = (rc: any) => rc.per_item.filter((row: any) => row.lane === 'verbatim').map((row: any) => [row.transcript_id, row.item_id, row.status]);
    expect(verbatimRows(beside.receipt)).toEqual(verbatimRows(alone.receipt));
    expect(beside.receipt.coverage_by_lane.verbatim).toEqual(alone.receipt.coverage_by_lane.verbatim);
    expect(beside.receipt.distractor_leakage.verbatim).toEqual(alone.receipt.distractor_leakage.verbatim);
    expect(beside.receipt.usability_by_lane.verbatim).toEqual(alone.receipt.usability_by_lane.verbatim);
    expect(beside.receipt.compression_ratio_by_lane.verbatim).toEqual(alone.receipt.compression_ratio_by_lane.verbatim);
    expect(beside.requests).toEqual(expect.arrayContaining(alone.requests));
    expect(beside.requests.length).toBeGreaterThan(alone.requests.length);
    expect(alone.ws0.publishable).toBe(false);
    expect(beside.ws0.publishable).toBe(false);
    expect(() => collectNativeRows35({ receipt: beside.receipt, gold: TIDS.map(gold), artifacts: { documents: {}, transcripts: {} } }))
      .toThrow('outside native transcript/lane population');
  }, 120_000);
});

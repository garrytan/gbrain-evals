/**
 * Cat 35 external lane (--external-lane NAME --external-dir DIR): $0, no network.
 *
 * The folder holds documents another system wrote, so the runner treats it as
 * hostile. These tests cover:
 *   - lane-name validation (it becomes a receipt key and an artifact file name)
 *   - readExternalDocs refusing symlinks (including one to /proc/self/environ),
 *     special files, hard links, oversized files, too many claims, invalid
 *     UTF-8 and unsafe transcript ids, and hashing every file it reads; and
 *     refusing to read at all on a system with no /proc/self/fd (#226)
 *   - the pre-flight judge estimate, priced from the documents read (#225)
 *   - CLI refusals before any work
 *   - hermetic runs (stubbed judge and gbrain, fetch forbidden, an empty budget
 *     ledger): the receipt records the name, the directory, each file's sha256
 *     and the provenance note; a hostile folder, an empty folder or a gold id
 *     in a document stops the run before any judge call; every built-in field
 *     is identical with or without an external lane, even one whose judge
 *     fails; identical bytes score identically in the dream lane and an
 *     external lane; and a large document set trips the hard stop before any
 *     judge call
 *
 * Reading tests and hermetic runs need /proc/self/fd and skip elsewhere,
 * where the runner refuses the lane.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
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
  externalJudgeEstimateUsd,
  externalLaneNameError,
  readExternalDocs,
} from '../../eval/runner/cat35-transcript-distill.ts';
import { collectNativeRows35 } from '../../eval/runner/situation-recall-native-35.ts';

const ROOT = resolve(import.meta.dir, '../..');
const RUNNER = join(ROOT, 'eval/runner/cat35-transcript-distill.ts');
const GOLD_DIR = join(ROOT, 'eval/data/transcript-distill-v1/gold');
const gold = (tid: string) => JSON.parse(readFileSync(join(GOLD_DIR, `${tid}.json`), 'utf8'));
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** The runner reads the external folder through /proc/self/fd and refuses the lane where it is missing. */
const FD_PATHS = existsSync('/proc/self/fd');

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('externalLaneNameError', () => {
  test('accepts short lowercase names', () => {
    for (const name of ['a', 'ext-notes', 'my-tool-2', `a${'b'.repeat(31)}`]) expect(externalLaneNameError(name)).toBeNull();
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

const ids = ['alpha-01', 'beta-02', 'gamma-03'];

function folder(files: Record<string, string | Buffer> = {}): string {
  const dir = scratch('cat35-ext-');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe('readExternalDocs on a system without /proc/self/fd', () => {
  test('refuses before opening any document, because a read by path could follow a folder swapped mid-run', () => {
    const dir = folder({ 'alpha-01.md': 'inside' });
    try {
      expect(() => readExternalDocs(dir, ids, EXTERNAL_DOC_MAX_BYTES, EXTERNAL_DOC_MAX_CLAIMS, join(dir, 'no-fd-paths')))
        .toThrow(`this system has no ${join(dir, 'no-fd-paths')} to read --external-dir through the folder handle it holds`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!FD_PATHS)('readExternalDocs on a hostile folder', () => {
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
        { transcript_id: 'alpha-01', file: 'alpha-01.md', bytes: 0, sha256: sha256(''), claims: 0 },
        { transcript_id: 'gamma-03', file: 'gamma-03.md', bytes: bom.length, sha256: sha256(bom), claims: 0 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('records how many claims the grounding judge will grade; fenced text and short fragments count none', () => {
    const dir = folder({ 'alpha-01.md': '```markdown\n- A fenced claim.\n- Another one.\n```\n', 'beta-02.md': 'The first plain sentence counts here. The second plain sentence counts too. Too short.\n' });
    try {
      expect(readExternalDocs(dir, ids).files.map((f) => [f.transcript_id, f.claims])).toEqual([['alpha-01', 0], ['beta-02', 2]]);
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

  test('refuses a folder that was swapped for a link after it was resolved', () => {
    const root = scratch('cat35-ext-swap-');
    try {
      const real = join(root, 'out');
      mkdirSync(real);
      writeFileSync(join(real, 'alpha-01.md'), 'inside');
      mkdirSync(join(root, 'elsewhere'));
      writeFileSync(join(root, 'elsewhere', 'alpha-01.md'), 'OUTSIDE');
      renameSync(real, join(root, 'moved'));
      symlinkSync(join(root, 'elsewhere'), real);
      expect(() => readExternalDocs(real, ids)).toThrow('could not be opened as a directory without following links');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'linux')('refuses a folder whose parent was swapped for a link after it was resolved', () => {
    const root = scratch('cat35-ext-swap-');
    try {
      const real = join(root, 'parent', 'out');
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, 'alpha-01.md'), 'inside');
      mkdirSync(join(root, 'elsewhere', 'out'), { recursive: true });
      writeFileSync(join(root, 'elsewhere', 'out', 'alpha-01.md'), 'OUTSIDE');
      renameSync(join(root, 'parent'), join(root, 'moved'));
      symlinkSync(join(root, 'elsewhere'), join(root, 'parent'));
      expect(() => readExternalDocs(real, ids)).toThrow(`--external-dir now resolves to ${join(root, 'elsewhere', 'out')}, not ${real}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
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

describe('externalJudgeEstimateUsd', () => {
  const transcript = 'user: we shipped the fix today and agreed to keep the old flag for a week\n'.repeat(80);
  const base = { document: 'The user shipped the fix today.', claims: 1, transcript, items: 8, distractors: 4, hazards: 1 };
  const est = (over: Partial<typeof base>, model = 'claude-sonnet-5-5') => externalJudgeEstimateUsd([{ ...base, ...over }], model);

  test('larger documents cost more, counted as the judge sees them, escaped', () => {
    expect(est({ document: 'a'.repeat(EXTERNAL_DOC_MAX_BYTES) })).toBeGreaterThan(est({ document: 'a'.repeat(4096) }));
    expect(est({ document: '<'.repeat(4096) })).toBeGreaterThan(est({ document: 'a'.repeat(4096) }));
  });

  test('each hazard adds a call that carries the document, and claims add a grounding call that carries the conversation', () => {
    const big = 'a'.repeat(EXTERNAL_DOC_MAX_BYTES);
    const hazardCall = est({ document: big, hazards: 1 }) - est({ document: big, hazards: 0 });
    expect(est({ document: big, hazards: 3 }) - est({ document: big, hazards: 0 })).toBeCloseTo(3 * hazardCall, 10);
    expect(est({ claims: 1 }) - est({ claims: 0 })).toBeLessThan(est({ claims: 1, transcript: transcript.repeat(4) }) - est({ claims: 0, transcript: transcript.repeat(4) }));
  });

  test('an empty document costs only the coverage call on a signal conversation, and nothing on a routine one', () => {
    expect(est({ document: '', claims: 0 })).toBeGreaterThan(0);
    expect(est({ document: '', claims: 0 })).toBeLessThan(est({ document: 'x', claims: 0 }) / 4);
    expect(est({ document: '', claims: 0, items: 0 })).toBe(0);
    expect(externalJudgeEstimateUsd([], 'claude-sonnet-5-5')).toBe(0);
  });

  test("the judge model's own rates price it, so a pricier judge cannot pass at a cheaper model's figure", () => {
    // Opus 5.5 lists at 40 times Haiku 5.5's input, cache-write and output rates; both get the same 4,096-token answer.
    expect(est({}, 'claude-opus-5-5') / est({}, 'claude-haiku-5-5')).toBeCloseTo(40, 6);
    expect(() => est({}, 'claude-unpriced-9')).toThrow('no chat price');
  });
});

describe('receipt schema', () => {
  test('a receipt with no external lane must name a built-in lane in every per_item row', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/schemas/cat35-receipt.schema.json'), 'utf8'));
    const rule = schema.allOf.find((r: any) => r.if?.properties?.external_lane);
    expect(rule.if.properties.external_lane).toEqual({ type: 'null' });
    expect(rule.then.properties.per_item.items.properties.lane.enum).toEqual(schema.properties.lanes.items.enum);
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
        [['--external-lane', 'ext-notes'], 'go together'],
        [['--external-dir', 'docs-dir'], 'go together'],
        [['--external-lane', 'Carafe', '--external-dir', 'docs-dir'], 'must match'],
        [['--external-lane', 'dream', '--external-dir', 'docs-dir'], 'built-in'],
        [['--external-lane', 'ext-notes', '--external-dir', 'no-such-dir'], 'not found'],
        [['--external-lane', 'ext-notes', '--external-dir', 'a-file'], 'not a directory'],
        [['--lanes', 'none'], '--lanes none needs'],
        [['--lanes', 'none,verbatim', '--external-lane', 'ext-notes', '--external-dir', 'docs-dir'], "unknown lane 'none'"],
        [['--transcript-mode', 'half', '--external-lane', 'ext-notes', '--external-dir', 'docs-dir'], 'cannot run with an external lane'],
        [['--lanes', 'verbatim', '--external-lane=ext-notes', '--external-dir=docs-dir'], '--external-lane=ext-notes: write --external-lane NAME'],
        [['--external-dirs', 'docs-dir'], '--external-dirs: write'],
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

const TIDS = ['coding-reflection-01', 'coding-reflection-02', 'pure-routine-01'];
const JUDGE_FAILS = 'STUB-JUDGE-FAILS';

function preload(requestLog: string, dreamDocs: Record<string, string>): string {
  return `
import { mock } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root = ${JSON.stringify(ROOT)};
const dreamDocs = ${JSON.stringify(dreamDocs)};
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
  async runPhaseSynthesize(engine, opts) {
    const tid = basename(opts.inputFile).slice(11, -4);
    if (!(tid in dreamDocs)) throw new Error('no stub dream document for ' + tid);
    engine.pages.set('notes/' + tid, { compiled_truth: dreamDocs[tid] });
    return { status: 'ok', details: { verdicts: [{ score: 0.8 }], written_slugs: ['notes/' + tid] } };
  }
}));
const anchors = new Map();
for (const tid of ${JSON.stringify(TIDS)}) for (const it of goldOf(tid).items) anchors.set(it.item_id, it.verbatim_anchor);
const client = { messages: { async create(req) {
  const tool = req.tools[0].name;
  const text = req.messages[0].content;
  appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ tool, text: text.replace(/nonce="[0-9a-f]+"/g, 'nonce="N"') }) + '\\n');
  if (text.includes(${JSON.stringify(JUDGE_FAILS)})) return { model: 'hermetic-judge', content: [], usage: { input_tokens: 10, output_tokens: 5 } };
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

interface Run {
  exitCode: number | null;
  stderr: string;
  receipt: any;
  ws0: any;
  requests: Array<{ tool: string; text: string }>;
  artifacts: Record<string, Buffer>;
  ledgerEntries: unknown[];
}

function runHermetic(args: string[], opts: { setup?: (dir: string) => void; dreamDocs?: Record<string, string>; env?: Record<string, string> } = {}): Run {
  const dir = scratch('cat35-ext-run-');
  try {
    mkdirSync(join(dir, 'eval/data'), { recursive: true });
    symlinkSync(join(ROOT, 'eval/data/transcript-distill-v1'), join(dir, 'eval/data/transcript-distill-v1'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    symlinkSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    const requestLog = join(dir, 'requests.jsonl');
    writeFileSync(join(dir, 'preload.ts'), preload(requestLog, opts.dreamDocs ?? {}));
    initLedger({ ledgerPath: join(dir, 'ledger.sqlite') });
    opts.setup?.(dir);
    const proc = Bun.spawnSync([process.execPath, '--preload', join(dir, 'preload.ts'), RUNNER, '--json', '--transcripts', TIDS.join(','), ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ANTHROPIC_API_KEY: 'stub-only', OPENAI_API_KEY: 'stub-only',
        CAT35_JUDGE_MODEL: 'claude-haiku-4-5-20251001', BRAINBENCH_BUDGET_USD: '5', BRAINBENCH_BUDGET_LEDGER: join(dir, 'ledger.sqlite'), ...opts.env },
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
const notes = (tid: string) =>
  `# Session notes\n\nThe user said "${anchor(tid)}".\n\nAlso noted: ${distractor(tid)}.\n`;

/** Documents for two of the three transcripts: coding-reflection-01 is missing on purpose. */
function writeExternalDocs(dir: string, opts: { judgeFails?: boolean } = {}): Record<string, Buffer> {
  const ext = join(dir, 'ext-out');
  mkdirSync(ext);
  const docs: Record<string, Buffer> = {
    'coding-reflection-02': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(notes('coding-reflection-02'))]),
    'pure-routine-01': Buffer.from(opts.judgeFails ? `# Routine\n\n${JUDGE_FAILS} for every judge call on this document.\n` : ''),
  };
  for (const [tid, body] of Object.entries(docs)) writeFileSync(join(ext, `${tid}.md`), body);
  return docs;
}

const EXT = ['--external-lane', 'ext-notes', '--external-dir', 'ext-out'];

/** A document at the reader's limits: 80 claims in just under 64 KiB. */
const largeDoc = (tid: string) =>
  Array.from({ length: EXTERNAL_DOC_MAX_CLAIMS }, (_, i) => `The ${tid} notes record detail ${i}${' and more words'.repeat(50)}.`).join('\n');

/** One document at the reader's limits for each of the three transcripts. */
function writeLargeExternalDocs(dir: string): void {
  mkdirSync(join(dir, 'ext-out'));
  for (const tid of TIDS) writeFileSync(join(dir, 'ext-out', `${tid}.md`), largeDoc(tid));
}

const projection = (r: Run) => Number(/pre-flight: projected worst-case \$([0-9.]+)/.exec(r.stderr)?.[1]);

/** Everything in a receipt that describes the built-in lanes; run-level accounting is left out. */
function builtinView(rc: any, lane: string): any {
  const c = structuredClone(rc);
  for (const k of ['timestamp', 'wall_seconds', 'total_cost_usd', 'judge_models_resolved', 'native_evidence', 'external_lane', 'gate_pass']) delete c[k];
  for (const k of ['coverage_by_lane', 'hallucination', 'distractor_leakage', 'usability_by_lane', 'compression_ratio_by_lane', 'quote_fidelity_by_lane']) delete c[k][lane];
  for (const k of ['coverage_by_kind', 'coverage_by_notability', 'coverage_by_depth']) {
    for (const [group, byLane] of Object.entries<any>(c[k])) {
      delete byLane[lane];
      if (!Object.keys(byLane).length) delete c[k][group];
    }
  }
  c.per_item = c.per_item.filter((r: any) => r.lane !== lane);
  c.attribution_hazards = c.attribution_hazards.filter((h: any) => h.lane !== lane);
  for (const [tid, errors] of Object.entries<any>(c.lane_errors)) {
    delete errors[lane];
    if (!Object.keys(errors).length) delete c.lane_errors[tid];
  }
  delete c.gates.external_judge_failed_rate;
  const ne = rc.native_evidence;
  // Built-in lanes are scored before the external lane, so their judge events keep the same ids.
  const builtinEvents = ne.judge_events.filter((e: any) => e.lane !== lane);
  const builtinIds = new Set(builtinEvents.map((e: any) => e.event_id));
  c.native_built_in = {
    events: builtinEvents,
    attempts: ne.judge_attempts.filter((a: any) => builtinIds.has(a.event_id)),
    grounding: ne.grounding.filter((g: any) => g.lane !== lane),
    distractors: ne.distractors.filter((d: any) => d.lane !== lane),
  };
  return c;
}

function builtinWs0View(ws0: any, lane: string): any {
  const c = structuredClone(ws0);
  for (const k of ['started_at', 'finished_at', 'verdict', 'cost', 'delivered_tokens']) delete c[k];
  for (const k of ['detailed_receipt', 'external_lane']) delete c.resolved_config[k];
  delete c.data.detailed_receipt;
  delete c.data.coverage_by_lane[lane];
  delete c.data.gates.external_judge_failed_rate;
  return c;
}

describe.skipIf(!FD_PATHS)('hermetic external-lane runs', () => {
  test('--lanes none scores only the external lane and the receipt records name, directory, hashes and provenance', () => {
    let docs: Record<string, Buffer> = {};
    let extDir = '';
    const r = runHermetic(['--lanes', 'none', ...EXT], {
      setup: (dir) => {
        docs = writeExternalDocs(dir);
        extDir = join(dir, 'ext-out');
      },
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.ledgerEntries).toEqual([]);
    const rc = r.receipt;
    expect(rc.lanes).toEqual([]);
    expect(rc.mode).toBe('b-pre-validity');
    expect(rc.external_lane).toEqual({
      name: 'ext-notes',
      dir: extDir,
      max_bytes: EXTERNAL_DOC_MAX_BYTES,
      files: ['coding-reflection-02', 'pure-routine-01'].map((tid) => ({
        transcript_id: tid, file: `${tid}.md`, bytes: docs[tid].length, sha256: sha256(docs[tid]),
        claims: tid === 'coding-reflection-02' ? 2 : 0,
      })),
      missing: ['coding-reflection-01'],
      provenance: EXTERNAL_PROVENANCE_NOTE,
    });
    expect(rc.external_lane.provenance).toContain('no record of how they were made');
    expect(rc.lane_errors).toEqual({ 'coding-reflection-01': { 'ext-notes': 'no coding-reflection-01.md in --external-dir' } });

    expect(new Set(rc.per_item.map((row: any) => row.lane))).toEqual(new Set(['ext-notes']));
    const cov = rc.coverage_by_lane['ext-notes'];
    // coding-reflection-01 is a lane error (all ABSENT); coding-reflection-02 has its first item verbatim.
    expect(cov.macro).toBeCloseTo((0 + 1 / 8) / 2, 10);
    expect(cov.joint_macro).toBeCloseTo((0 + 1 / 8) / 2, 10);
    // Two sentences; the heading is not a claim, and the empty document has none.
    expect(rc.hallucination['ext-notes']).toEqual({ claims: 2, verifiable: 2, ungrounded: 0, rate: 0 });
    expect(rc.distractor_leakage['ext-notes']).toEqual({ hits: 1, confirmed: 1, denominator: 8, judge_failed: 0, rate: 1 / 8 });
    expect(rc.usability_by_lane['ext-notes'].rate).toBe(1);
    expect(rc.quote_fidelity_by_lane['ext-notes']).toEqual({ total: 1, grounded: 1, rate: 1 });
    expect(rc.attribution_hazards.map((h: any) => [h.lane, h.transcript_id, h.violated])).toEqual([
      ['ext-notes', 'coding-reflection-01', null],
      ['ext-notes', 'coding-reflection-02', false],
    ]);
    expect(rc.native_evidence.judge_events.every((e: any) => e.lane === 'ext-notes')).toBe(true);
    const labels = r.requests.filter((q) => q.tool === 'grade_claims').map((q) => JSON.parse(q.text.match(/<batch label=(.*)>/)![1]));
    // The judge sees a fixed 'external' label, never the contributor's lane name.
    expect(labels).toEqual(['external:coding-reflection-02', `hazard:external:${gold('coding-reflection-02').hazards[0].hazard_id}`]);
    expect(r.requests.some((q) => q.text.includes('ext-notes'))).toBe(false);
    // Built-in fields stay empty: blended usability, the built-in judge gate and the WS0 counters.
    expect(rc.usability).toEqual({ satisfied: 0, total: 0, rate: null, per_transcript: [] });
    expect(rc.judge_failed_rate).toBe(0);
    expect(rc.gates).toEqual({ verbatim_coverage: null, judge_failed_rate: true, dream_emission: null, external_judge_failed_rate: true });
    // Artifacts are the input bytes, BOM included; the empty document is kept.
    expect(r.artifacts['coding-reflection-02.ext-notes.md'].equals(docs['coding-reflection-02'])).toBe(true);
    expect(r.artifacts['pure-routine-01.ext-notes.md'].length).toBe(0);
    expect(r.artifacts['coding-reflection-01.ext-notes.md']).toBeUndefined();

    expect(r.ws0.publishable).toBe(false);
    expect([r.ws0.n_total, r.ws0.n_scored, r.ws0.errors]).toEqual([0, 0, []]);
    expect(r.ws0.resolved_config.external_lane).toEqual(rc.external_lane);
    expect(() => collectNativeRows35({ receipt: rc, gold: TIDS.map(gold), artifacts: { documents: {}, transcripts: {} } }))
      .toThrow('scored an external lane');
  }, 90_000);

  const hostile: Array<[string, (ext: string) => void, string]> = [
    ['a symlink to /proc/self/environ', (ext) => symlinkSync('/proc/self/environ', join(ext, 'coding-reflection-01.md')), 'coding-reflection-01.md is a symlink'],
    ['a gold id in a document', (ext) => writeFileSync(join(ext, 'coding-reflection-01.md'), `Covered ${gold('coding-reflection-01').items[2].item_id}.\n`), 'gold id'],
    ['an empty folder', (ext) => { for (const f of readdirSync(ext)) rmSync(join(ext, f)); }, 'has no <transcript_id>.md for any of the 3 selected transcripts'],
  ];
  for (const [what, spoil, message] of hostile) {
    test(`${what} stops the run before any judge call or spend`, () => {
      const r = runHermetic(['--lanes', 'none', ...EXT], {
        setup: (dir) => {
          writeExternalDocs(dir);
          spoil(join(dir, 'ext-out'));
        },
      });
      expect(r.exitCode, r.stderr).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.receipt).toBeNull();
      expect(r.requests).toEqual([]);
      expect(r.ledgerEntries).toEqual([]);
      expect(r.ws0.run_status).toBe('error');
      expect(r.ws0.errors[0].message).toContain(message);
      expect(r.artifacts).toEqual({});
    }, 90_000);
  }

  test('the pre-flight projection prices the documents read, so a large set trips the hard stop before any judge call', () => {
    for (const tid of TIDS) {
      expect(Buffer.byteLength(largeDoc(tid))).toBeLessThanOrEqual(EXTERNAL_DOC_MAX_BYTES);
      expect(segmentClaims(largeDoc(tid))).toHaveLength(EXTERNAL_DOC_MAX_CLAIMS);
    }
    const small = runHermetic(['--lanes', 'none', ...EXT], { setup: (dir) => { writeExternalDocs(dir); } });
    expect(small.exitCode, small.stderr).toBe(0);
    const cap = projection(small) * 2;
    expect(cap).toBeGreaterThan(0);
    const large = runHermetic(['--lanes', 'none', ...EXT], { setup: writeLargeExternalDocs, env: { CAT35_HARD_STOP_USD: String(cap) } });
    expect(large.exitCode, large.stderr).toBe(2);
    expect(large.stderr).toContain(`exceeds CAT35_HARD_STOP_USD=$${cap}`);
    expect(projection(large)).toBeGreaterThan(cap);
    expect(large.requests).toEqual([]);
    expect(large.ledgerEntries).toEqual([]);
    expect(large.ws0.run_status).toBe('error');
  }, 120_000);

  test('a lane with nothing to grade reports no hallucination or quote-fidelity rate, and the scorecard shows zero claims', () => {
    const r = runHermetic(['--lanes', 'none', ...EXT], {
      setup: (dir) => {
        const ext = join(dir, 'ext-out');
        mkdirSync(ext);
        writeFileSync(join(ext, 'coding-reflection-02.md'), '```markdown\n- The user fixed the flaky runner test today.\n```\n');
      },
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.receipt.external_lane.files.map((f: any) => [f.transcript_id, f.claims])).toEqual([['coding-reflection-02', 0]]);
    expect(r.receipt.hallucination['ext-notes']).toBeUndefined();
    expect(r.receipt.quote_fidelity_by_lane['ext-notes']).toBeUndefined();
    expect(r.stderr).toContain('external lane ext-notes: 1 documents (sha256 in the receipt), 0 gradable claims');
  });

  test('every built-in field is identical with or without an external lane, even one whose judge fails', () => {
    const alone = runHermetic(['--lanes', 'verbatim']);
    const beside = runHermetic(['--lanes', 'verbatim', ...EXT], { setup: (dir) => { writeExternalDocs(dir, { judgeFails: true }); } });
    expect(alone.exitCode, alone.stderr).toBe(0);
    expect(builtinView(beside.receipt, 'ext-notes')).toEqual(builtinView(alone.receipt, 'ext-notes'));
    expect(builtinWs0View(beside.ws0, 'ext-notes')).toEqual(builtinWs0View(alone.ws0, 'ext-notes'));
    expect(beside.requests.slice(0, alone.requests.length)).toEqual(alone.requests);
    expect(beside.requests.length).toBeGreaterThan(alone.requests.length);
    // The external lane's judge failures fail only its own gate, which the run's verdict and exit code include.
    expect(beside.receipt.native_evidence.judge_events.some((e: any) => e.lane === 'ext-notes' && e.judge_failed)).toBe(true);
    expect(beside.receipt.gates.judge_failed_rate).toBe(true);
    expect(beside.receipt.gates.external_judge_failed_rate).toBe(false);
    expect([alone.receipt.gate_pass, beside.receipt.gate_pass, beside.exitCode]).toEqual([true, false, 1]);
    expect([alone.ws0.publishable, beside.ws0.publishable]).toEqual([false, false]);
    expect(alone.receipt.external_lane).toBeNull();
  }, 120_000);

  test('identical bytes score identically in the dream lane and an external lane', () => {
    const dreamDocs = { 'coding-reflection-01': notes('coding-reflection-01'), 'coding-reflection-02': notes('coding-reflection-02'), 'pure-routine-01': '' };
    const r = runHermetic(['--lanes', 'dream', '--external-lane', 'ext-mirror', '--external-dir', 'mirror'], {
      dreamDocs,
      setup: (dir) => {
        mkdirSync(join(dir, 'mirror'));
        for (const [tid, body] of Object.entries(dreamDocs)) writeFileSync(join(dir, 'mirror', `${tid}.md`), body);
      },
    });
    expect(r.exitCode, r.stderr).toBe(0);
    const rc = r.receipt;
    const rows = (lane: string) => rc.per_item.filter((x: any) => x.lane === lane).map((x: any) => [x.transcript_id, x.item_id, x.status, x.joint]);
    expect(rows('dream').length).toBe(17);
    expect(rows('ext-mirror')).toEqual(rows('dream'));
    for (const k of ['coverage_by_lane', 'hallucination', 'distractor_leakage', 'usability_by_lane', 'compression_ratio_by_lane', 'quote_fidelity_by_lane']) {
      expect(rc[k]['ext-mirror'], k).toEqual(rc[k].dream);
    }
    expect(rc.quote_fidelity_by_lane.dream.total).toBe(2);
    const hazards = (lane: string) => rc.attribution_hazards.filter((h: any) => h.lane === lane).map((h: any) => [h.transcript_id, h.hazard_id, h.violated]);
    expect(hazards('dream')).toHaveLength(2);
    expect(hazards('ext-mirror')).toEqual(hazards('dream'));
    const purposes = (lane: string) => rc.native_evidence.judge_events.filter((e: any) => e.lane === lane).map((e: any) => [e.transcript_id, e.purpose]);
    expect(purposes('ext-mirror')).toEqual(purposes('dream'));
  }, 120_000);
});

/**
 * Regression tests for skillopt-v1-gen held-out differentiation
 * (audit finding skillopt-cats-09).
 *
 * The old generator wrote benchmark.jsonl and held-out.jsonl from the SAME
 * `checks` array, so cat30/cat33's "held-out transfer" only tested topic
 * transfer: any edit replicating the trained-on rule strings passed the
 * held-out gate by construction. These tests run the real generator into a
 * temp cwd and prove:
 *
 *   1. held-out judge checks differ from the training checks for EVERY seed
 *      (this test FAILS against the old generator);
 *   2. held-out task_ids stay disjoint from benchmark task_ids;
 *   3. a form-only output that satisfies the TRAINING checks fails the
 *      held-out checks (the property the differentiation exists to create);
 *   4. a genuinely good output passes BOTH judges (the checks aren't
 *      unsatisfiable);
 *   5. every check op is one gbrain's rule judge implements.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = join(import.meta.dir, '../..');
const GENERATOR = join(REPO, 'eval/generators/skillopt-v1-gen.ts');

let sandbox: string;
let root: string;

interface Check { op: string; arg: string | number }
interface TaskRow { task_id: string; task: string; judge: { kind: string; checks: Check[]; expected_slugs?: string[]; k?: number } }

function readJsonl(path: string): TaskRow[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

/**
 * Mirror of gbrain's rule-judge semantics for the ops these fixtures use
 * (node_modules/gbrain/src/core/skillopt/score.ts applyCheck — module-private
 * upstream, so mirrored here; regex compiles with the 'm' flag only).
 */
function applyCheck(text: string, check: Check): boolean {
  switch (check.op) {
    case 'contains':
      return typeof check.arg === 'string' && text.includes(check.arg);
    case 'regex':
      return typeof check.arg === 'string' && new RegExp(check.arg, 'm').test(text);
    case 'section_present': {
      const heading = String(check.arg).replace(/^#+\s*/, '').trim();
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'mi').test(text);
    }
    case 'max_chars':
      return typeof check.arg === 'number' && text.length <= check.arg;
    default:
      throw new Error(`text-only mirror cannot evaluate op ${check.op}`);
  }
}

const scoreText = (text: string, checks: Check[]): number =>
  checks.filter((c) => applyCheck(text, c)).length / checks.length;

const SEEDS = ['seed-missing-structure', 'seed-verbose', 'seed-no-brain-first', 'seed-no-verdict'];

// The full op vocabulary gbrain's rule judge implements
// (node_modules/gbrain/src/core/skillopt/types.ts RuleCheckOp).
const GBRAIN_RULE_OPS = new Set([
  'contains', 'regex', 'section_present', 'max_chars',
  'min_citations', 'tool_called', 'tool_not_called',
]);

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'skillopt-gen-test-'));
  // The generator writes to <cwd>/eval/data/skillopt-v1 — run it in the
  // sandbox so the committed fixtures are untouched by the test.
  const r = spawnSync('bun', [GENERATOR], { cwd: sandbox, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`generator failed: ${r.stderr}`);
  root = join(sandbox, 'eval/data/skillopt-v1');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('skillopt-v1-gen held-out differentiation (skillopt-cats-09)', () => {
  for (const seed of SEEDS) {
    test(`${seed}: held-out judge checks are NOT byte-identical to training checks`, () => {
      const bench = readJsonl(join(root, seed, 'benchmark.jsonl'));
      const held = readJsonl(join(root, seed, 'held-out.jsonl'));
      expect(bench.length).toBe(15);
      expect(held.length).toBe(6);
      const trainChecks = JSON.stringify(bench[0]!.judge.checks);
      for (const row of bench) expect(JSON.stringify(row.judge.checks)).toBe(trainChecks);
      if (seed === 'seed-no-brain-first') {
        // Held-out is a per-topic retrieval judge, not a rule list (audit B-30-01).
        for (const row of held) expect(row.judge.kind).toBe('qrels');
        return;
      }
      const heldChecks = JSON.stringify(held[0]!.judge.checks);
      // The core regression: the old generator wrote the same array to both.
      expect(heldChecks).not.toBe(trainChecks);
      // Every row within a file carries the same judge (split determinism).
      for (const row of held) expect(JSON.stringify(row.judge.checks)).toBe(heldChecks);
    });

    test(`${seed}: held-out task_ids disjoint from benchmark task_ids`, () => {
      const benchIds = new Set(readJsonl(join(root, seed, 'benchmark.jsonl')).map((r) => r.task_id));
      for (const row of readJsonl(join(root, seed, 'held-out.jsonl'))) {
        expect(benchIds.has(row.task_id)).toBe(false);
      }
    });

    test(`${seed}: every judge op is implemented by gbrain's rule judge`, () => {
      for (const file of ['benchmark.jsonl', 'held-out.jsonl']) {
        for (const row of readJsonl(join(root, seed, file))) {
          if (row.judge.kind === 'qrels') continue;
          expect(row.judge.kind).toBe('rule');
          for (const c of row.judge.checks) expect(GBRAIN_RULE_OPS.has(c.op)).toBe(true);
        }
      }
    });
  }

  test('seed-missing-structure: a form-only edit that maxes the TRAINING judge fails held-out', () => {
    const bench = readJsonl(join(root, 'seed-missing-structure', 'benchmark.jsonl'))[0]!.judge.checks;
    const held = readJsonl(join(root, 'seed-missing-structure', 'held-out.jsonl'))[0]!.judge.checks;
    // Empty headers + a bare confidence token — the exact hack cat32 shows
    // scores 1.0 on gameable rule judges.
    const FORM_ONLY = 'It depends.\n\n## Key Risks\n\nConfidence:';
    expect(scoreText(FORM_ONLY, bench)).toBe(1);      // trained-on rules: fooled
    expect(scoreText(FORM_ONLY, held)).toBe(0);       // held-out rules: not fooled
    // A substantive brief passes BOTH (the held-out judge is satisfiable).
    const GENUINE = [
      'Lead answer: take the cofounder only if equity expectations are aligned.',
      '',
      '## Key Risks',
      '- A rushed cofounder split is the most common cause of an early dissolution.',
      '- Solo velocity drops during the trust-building period before leverage shows.',
      '',
      'Confidence: medium — both risks are addressable with a vesting schedule.',
    ].join('\n');
    expect(scoreText(GENUINE, bench)).toBe(1);
    expect(scoreText(GENUINE, held)).toBe(1);
  });

  test('seed-verbose: a degenerate near-empty answer games max_chars but fails held-out substance floor', () => {
    const bench = readJsonl(join(root, 'seed-verbose', 'benchmark.jsonl'))[0]!.judge.checks;
    const held = readJsonl(join(root, 'seed-verbose', 'held-out.jsonl'))[0]!.judge.checks;
    const DEGENERATE = 'Yes.';
    expect(scoreText(DEGENERATE, bench)).toBe(1);          // <=1200 chars: passes training
    expect(scoreText(DEGENERATE, held)).toBeLessThan(1);   // fails the 200-char substance floor
    const CONCISE_SUBSTANTIVE = 'Ship the paid pilot: it prices the integration effort honestly, filters for committed buyers, and produces a reference contract. The free design partnership defers the pricing conversation to a moment when you have less leverage, and unpaid partners deprioritize the rollout when their quarter gets busy.';
    expect(scoreText(CONCISE_SUBSTANTIVE, bench)).toBe(1);
    expect(scoreText(CONCISE_SUBSTANTIVE, held)).toBe(1);
  });

  test('seed-no-verdict: bare tokens satisfy training but not the held-out committed-verdict checks', () => {
    const bench = readJsonl(join(root, 'seed-no-verdict', 'benchmark.jsonl'))[0]!.judge.checks;
    const held = readJsonl(join(root, 'seed-no-verdict', 'held-out.jsonl'))[0]!.judge.checks;
    const TOKENS_ONLY = 'Recommendation:\nConfidence:';
    expect(scoreText(TOKENS_ONLY, bench)).toBe(1);
    expect(scoreText(TOKENS_ONLY, held)).toBe(0);
    const COMMITTED = 'Recommendation: deprecate with a 6-month sunset and a paid migration path.\nConfidence: high — usage telemetry shows 92% of calls come from two integrators.';
    expect(scoreText(COMMITTED, bench)).toBe(1);
    expect(scoreText(COMMITTED, held)).toBe(1);
  });

  test('generator is deterministic: a second run produces byte-identical fixtures', () => {
    const before = SEEDS.map((s) => readFileSync(join(root, s, 'held-out.jsonl'), 'utf8'));
    const r = spawnSync('bun', [GENERATOR], { cwd: sandbox, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    SEEDS.forEach((s, i) => {
      expect(readFileSync(join(root, s, 'held-out.jsonl'), 'utf8')).toBe(before[i]!);
    });
  });

  test('seed-no-brain-first: every held-out task expects one generated brain page that exists (audit B-30-01)', () => {
    for (const row of readJsonl(join(root, 'seed-no-brain-first', 'held-out.jsonl'))) {
      expect(row.judge.expected_slugs?.length).toBe(1);
      expect(row.judge.k).toBe(5);
      expect(existsSync(join(root, 'seed-no-brain-first', 'brain', `${row.judge.expected_slugs![0]}.md`))).toBe(true);
    }
  });

  test('committed fixtures match a fresh generator run (no drift)', () => {
    const brain = (base: string) => {
      const dir = join(base, 'seed-no-brain-first', 'brain', 'topics');
      return readdirSync(dir).sort().map(f => [f, readFileSync(join(dir, f), 'utf8')]);
    };
    expect(brain(join(REPO, 'eval/data/skillopt-v1'))).toEqual(brain(root));
    for (const s of SEEDS) {
      for (const f of ['benchmark.jsonl', 'held-out.jsonl', 'SKILL.md']) {
        const generated = readFileSync(join(root, s, f), 'utf8');
        const committed = readFileSync(join(REPO, 'eval/data/skillopt-v1', s, f), 'utf8');
        expect(committed).toBe(generated);
      }
    }
  });
});

describe('seed-no-brain-first held-out cannot be satisfied by invented citations (audit B-30-01)', () => {
  test('keyword search over the imported brain retrieves each expected page; a fabricated answer with no retrieval scores 0', async () => {
    const { PGLiteEngine } = await import('gbrain/pglite-engine');
    const { importSeedBrain } = await import('../../eval/runner/cat30-skillopt-improvement.ts');
    const { scoreQrels } = await import('../../node_modules/gbrain/src/core/skillopt/score.ts');
    const seedDir = join(REPO, 'eval/data/skillopt-v1/seed-no-brain-first');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      expect(await importSeedBrain(engine, seedDir)).toBeGreaterThan(0);
      for (const row of readJsonl(join(seedDir, 'held-out.jsonl'))) {
        const topic = row.task.replace(/^Answer: should we decide /, '').replace(/\.$/, '');
        const results = await engine.searchKeyword(topic, { limit: 5 });
        const trajectory = { final_text: 'See [1].', tool_calls: [{ name: 'search', input: { query: topic }, output: results, failed: false }] };
        expect(scoreQrels(trajectory as never, row.judge.expected_slugs!, 5)).toBeGreaterThan(0);
        const fabricated = { final_text: 'Per people/alice-example and [the memo](companies/acme-example) [1][2].', tool_calls: [] };
        expect(scoreQrels(fabricated as never, row.judge.expected_slugs!, 5)).toBe(0);
      }
    } finally {
      await engine.disconnect();
    }
  }, 120_000);
});

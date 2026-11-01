/**
 * R48 frontier check (preregistration amendment 1): the four unoptimized skillopt-v1 seed skills scored on their own
 * held-out tasks with a frontier target, through the same scoreSkillOnTasks and pinned search config as Cat 30.
 *
 *   bun docs/benchmarks/2026-11-01-skillopt-rebaseline/scripts/frontier-probe.ts [--target anthropic:claude-opus-5-5] [--runs 2] --out <file.json>
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { configureGateway } from 'gbrain/ai/gateway';
import { loadHeldOut, scoreSkillOnTasks } from 'gbrain/core/skillopt';
import { ALL_SEEDS, PINNED_CONFIG, SKILLOPT_MODELS, importSeedBrain } from '../../../../eval/runner/cat30-skillopt-improvement.ts';
import { gbrainPin, gbrainVersion } from '../../../../eval/runner/gbrain-version.ts';

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback; };
const target = arg('--target', 'anthropic:claude-opus-5-5')!;
const runsPerTask = Number(arg('--runs', '2'));
const out = arg('--out');
if (!out) throw new Error('--out <file.json> is required');

const home = mkdtempSync(join(tmpdir(), 'frontier-probe-home-'));
process.env.GBRAIN_HOME = home;
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, chat_model: target, env: process.env as Record<string, string | undefined> });
const engine = new PGLiteEngine();
const startedAt = new Date().toISOString();
const seeds: Array<{ seed: string; heldout: number }> = [];
try {
  await engine.connect({});
  await engine.initSchema();
  for (const [key, value] of Object.entries(PINNED_CONFIG)) await engine.setConfig(key, value);
  const dataDir = join(process.cwd(), 'eval/data/skillopt-v1');
  for (const seed of ALL_SEEDS) {
    const seedDir = join(dataDir, seed);
    await importSeedBrain(engine, seedDir);
    const heldout = await scoreSkillOnTasks({
      engine, skillText: readFileSync(join(seedDir, 'SKILL.md'), 'utf8'), tasks: loadHeldOut(join(seedDir, 'held-out.jsonl')),
      targetModel: target, judgeModel: SKILLOPT_MODELS.judge, runsPerTask,
    } as any);
    seeds.push({ seed, heldout });
    process.stderr.write(`[frontier-probe] ${seed}: ${heldout.toFixed(3)}\n`);
  }
} finally {
  await engine.disconnect().catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
writeFileSync(out, JSON.stringify({
  probe: 'r48-frontier-check', gbrain_version: gbrainVersion(), gbrain_pin: gbrainPin(), target_model: target,
  judge_model: SKILLOPT_MODELS.judge, runs_per_task: runsPerTask, pinned_config: PINNED_CONFIG, corpus: 'skillopt-v1',
  started_at: startedAt, finished_at: new Date().toISOString(), seeds,
}, null, 2) + '\n');

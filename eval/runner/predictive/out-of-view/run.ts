/**
 * G6 CLI, keyless: generate a seeded mixed-access world, measure which gold
 * pages a local and a remote caller can reach in gbrain, and write the tasks
 * for the agent layer.
 *
 *   bun eval/runner/predictive/out-of-view/run.ts --seed 7 --out eval/reports/out-of-view
 *     [--entities 50] [--direct-share 0.2] [--alias-share 0.15] [--derived-share 0.15] [--gbrain <checkout>[@ref]]
 *
 * Writes <out>/world/<slug>.md, <out>/reach.json and <out>/tasks.jsonl. Runs
 * inside withHermeticEnv with keyless fixture transports: no provider key is
 * read and no paid call exists on this path, so --paid is refused.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withHermeticEnv } from '../../hermetic-env.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest } from '../../gbrain-under-test.ts';
import { DEFAULT_KNOBS, generateWorld, type Knobs } from './gen.ts';
import { measureReach, reachSummaryLines } from './reach.ts';
import { buildTasks, tasksDigest, tasksJsonl } from './tasks.ts';

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function num(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(name + ' needs a number, got ' + raw);
  return value;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--paid')) { console.error('out-of-view: this runner is keyless and has no paid arm; drop --paid'); return 2; }
  const seedRaw = flag(argv, '--seed'), out = flag(argv, '--out');
  if (seedRaw === undefined || !Number.isInteger(Number(seedRaw)) || !out) {
    console.error('usage: run.ts --seed <int> --out <dir> [--entities n] [--direct-share x] [--alias-share x] [--derived-share x] [--gbrain <checkout>[@ref]]');
    return 2;
  }
  const knobs: Knobs = {
    entities: num(argv, '--entities', DEFAULT_KNOBS.entities),
    direct_flag_share: num(argv, '--direct-share', DEFAULT_KNOBS.direct_flag_share),
    alias_share: num(argv, '--alias-share', DEFAULT_KNOBS.alias_share),
    derived_share: num(argv, '--derived-share', DEFAULT_KNOBS.derived_share),
  };
  const world = generateWorld(Number(seedRaw), knobs);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const report = await withHermeticEnv('out-of-view', () => measureReach(gut, world));
  const reach = new Map(report.pages.map(p => [p.slug, p.get_page]));
  const tasks = buildTasks(world, (slug, caller) => reach.get(slug)![caller]);
  for (const page of world.pages) {
    const path = join(out, 'world', page.slug + '.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page.markdown);
  }
  writeFileSync(join(out, 'reach.json'), JSON.stringify({ ...report, tasks_digest: tasksDigest(tasks) }, null, 2) + '\n');
  writeFileSync(join(out, 'tasks.jsonl'), tasksJsonl(tasks));
  for (const line of reachSummaryLines(report)) console.log('out-of-view: ' + line);
  console.log('out-of-view: wrote ' + join(out, 'reach.json') + ' and ' + tasks.length + ' tasks to ' + join(out, 'tasks.jsonl'));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

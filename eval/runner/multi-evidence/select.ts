/**
 * Builds the multi-evidence development set: the nightly dev set's natural-condition questions whose answer needs two or
 * more gold items, deterministically.
 *
 *   bun eval/runner/multi-evidence/select.ts --world <Cat 40 world M world.json> [--check]
 *
 * Sources, all public or synthetic and all already in the nightly dev set (eval/data/nightly/devset-v2.json):
 *   cat40-hard-m   Cat 40 Hard world M tasks; gold is the task's gold.evidence documents (the world is generated from the
 *                  public seed, so pass the world.json that eval/generators/model-ladder-gen.ts writes for world M).
 *   lme-s-hard     LongMemEval-S dev questions; gold is the question's answer sessions.
 *   beam-1m-hard   public BEAM-1M dev conversations; gold is the question's cited sessions.
 * An item is kept when its gold has at least two items and, for the two QA suites, its answerability class
 * (eval/runner/sota/answerability.ts: the item-support check of docs/benchmarks/2026-11-10-beam-item-support.md plus the
 * oracle) is supported or partial; unsupported, unresolved and unchecked items are dropped. Each suite keeps the nightly
 * suite's id and config, so the nightly adapters run it unchanged. --check rebuilds in memory and fails when the committed
 * file differs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCorpus } from '../memory-qa/corpus.ts';
import { canonicalDigest, loadDevSet, type Suite } from '../nightly/devset.ts';
import { ANSWERABLE, loadClasses } from '../sota/answerability.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const ME_DEVSET_PATH = 'eval/data/multi-evidence/devset-v1.json';
export const ME_SCHEMA = 'multi-evidence-devset/1' as const;
export const MIN_GOLD = 2;

export interface MeItem { id: string; gold: number; class?: string }
export interface MeSuite { id: string; kind: 'agent' | 'qa'; about: string; source: string; config: Record<string, unknown>; items: MeItem[] }
export interface MeDevSet { schema: typeof ME_SCHEMA; version: 1; rule: string; nightly_devset: { path: string; digest: string }; suites: MeSuite[]; digest: string }

const RULE = 'Nightly dev-set items whose gold has at least 2 items; QA items only when their answerability class is supported or partial.';

export function buildDevSet(worldPath: string): MeDevSet {
  const nightly = loadDevSet();
  const world = JSON.parse(readFileSync(worldPath, 'utf8')) as { tasks: Array<{ id: string; gold?: { evidence?: string[] } }> };
  const tasks = new Map(world.tasks.map(t => [t.id, t]));
  const suites: MeSuite[] = [];
  for (const s of nightly.suites as Suite[]) {
    if (s.id === 'cat40-hard-m') {
      const items = s.items.map(i => {
        const t = tasks.get(i.id);
        if (!t) throw new Error(`${worldPath} has no task ${i.id}; pass Cat 40 world M (seed 20261021, --scale large)`);
        return { id: i.id, gold: t.gold?.evidence?.length ?? 0 };
      }).filter(i => i.gold >= MIN_GOLD);
      suites.push({ id: s.id, kind: 'agent', about: s.about, source: `${s.source}; gold from the world's gold.evidence`, config: s.config ?? {}, items });
    } else if (s.kind === 'qa') {
      const benchmark = String(s.config?.benchmark);
      const questions = new Map(loadCorpus(benchmark).questions.map(q => [q.id, q]));
      const classes = loadClasses(benchmark);
      const items = s.items.map(i => {
        const q = questions.get(i.id);
        if (!q) throw new Error(`${benchmark} has no question ${i.id}; fetch it with bun run eval:decide fetch --benchmark ${benchmark}`);
        return { id: i.id, gold: q.gold.length, class: classes?.get(i.id) ?? 'unchecked' };
      }).filter(i => i.gold >= MIN_GOLD && (ANSWERABLE as readonly string[]).includes(i.class));
      suites.push({ id: s.id, kind: 'qa', about: s.about, source: `${s.source}; gold from the ${benchmark} corpus, classes from eval/data/answerability/${benchmark}.json`, config: s.config ?? {}, items });
    }
  }
  const body = { schema: ME_SCHEMA, version: 1 as const, rule: RULE, nightly_devset: { path: 'eval/data/nightly/devset-v2.json', digest: nightly.digest }, suites };
  return { ...body, digest: canonicalDigest(body) };
}

export function loadMeDevSet(path = join(ROOT, ME_DEVSET_PATH)): MeDevSet {
  const set = JSON.parse(readFileSync(path, 'utf8')) as MeDevSet;
  const { digest, ...body } = set;
  if (set.schema !== ME_SCHEMA) throw new Error(`${path}: not a ${ME_SCHEMA} file`);
  if (canonicalDigest(body) !== digest) throw new Error(`ME_DEVSET_DIGEST_MISMATCH: ${path} was edited without a rebuild; fix: bun eval/runner/multi-evidence/select.ts --world <world.json>`);
  return set;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--world');
  const world = i >= 0 ? resolve(argv[i + 1]!) : null;
  if (!world || !existsSync(world)) {
    console.error('usage: bun eval/runner/multi-evidence/select.ts --world <Cat 40 world M world.json> [--check]');
    process.exit(2);
  }
  const built = buildDevSet(world);
  const text = JSON.stringify(built, null, 2) + '\n';
  const path = join(ROOT, ME_DEVSET_PATH);
  if (argv.includes('--check')) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) { console.error(`${ME_DEVSET_PATH} differs from a rebuild`); process.exit(1); }
    console.log(`${ME_DEVSET_PATH} matches a rebuild`);
  } else {
    writeFileSync(path, text);
    console.log(JSON.stringify(built.suites.map(s => ({ suite: s.id, items: s.items.length }))));
  }
}

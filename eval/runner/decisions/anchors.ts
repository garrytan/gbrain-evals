/**
 * Anchor exclusion: keep development probes disjoint from the entities a
 * held-out set asks about.
 *
 * A dev probe that asks about the same anchor entity as a sealed question
 * lets tuning learn that entity's neighborhood, which leaks into the
 * held-out score. `excludeSealedAnchors` drops such probes and reports only
 * how many it dropped, never which sealed questions they matched.
 *
 * Anchor sources:
 *   n9                 the `anchor` page of every composed question in the N9 file
 *   world-v1-relational the page (slug and title) each sealed relational template names
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSplit } from './splits.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

export type AnchorSource = 'n9' | 'world-v1-relational';

const norm = (s: string) => s.toLowerCase().replace(/\.md$/, '').replace(/^\.?\/?/, '').trim();

export async function sealedAnchors(source: AnchorSource): Promise<Set<string>> {
  if (source === 'n9') {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/data/n9-multihop-paraphrase-v1/questions.json'), 'utf8')) as { questions: Array<{ anchor: string; anchor_name: string }> };
    return new Set(file.questions.flatMap(q => [norm(q.anchor), norm(q.anchor_name)]));
  }
  const { buildRelationalQueries, loadWorldCorpus } = await import('../queries/relational.ts');
  const sealed = new Set(loadSplit('world-v1-relational').sealed);
  const pages = loadWorldCorpus(join(REPO_ROOT, 'eval/data/world-v1'));
  const anchors = new Set<string>();
  for (const t of buildRelationalQueries(pages)) {
    if (!sealed.has(t.id)) continue;
    for (const p of pages) if (p.title && t.text.includes(p.title)) { anchors.add(norm(p.slug)); anchors.add(norm(p.title)); }
  }
  return anchors;
}

/** Drop probes whose anchors (slugs or names, as given by `anchorsOf`) touch a sealed anchor. */
export function excludeSealedAnchors<T>(probes: readonly T[], anchorsOf: (p: T) => readonly string[], sealed: ReadonlySet<string>): { kept: T[]; dropped: number } {
  const kept = probes.filter(p => !anchorsOf(p).some(a => sealed.has(norm(a))));
  return { kept, dropped: probes.length - kept.length };
}

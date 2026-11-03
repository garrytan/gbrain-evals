/**
 * The dataset a run reads, passed explicitly (GBEV-30, plan section 2): the
 * pages the rollout brain imports, the entity names the audit flags, and the
 * redaction scope of the one-shot proposer's input. v1 and v2 read the shared
 * corpora (messy-company-v1 and world-v1); v3 reads its own world from
 * `world/pages.jsonl`, so nothing built for v3 reads v1's or v2's vocabulary.
 *
 * Contexts are cached per dataset directory and the sha256 of its
 * MANIFEST.json (the dataset hash receipts record): every call rereads the
 * manifest, so a dataset changed in the same process gets a fresh context.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountNames, loadCorpora, type MethodTask } from '../../generators/skillopt-method/common.ts';
import { datasetDir, type DatasetVersion, sha256 } from './dataset.ts';
import { forbiddenMarkers, trainPages, type Marker } from './one-shot.ts';

export interface DatasetContext {
  version: DatasetVersion;
  root: string;
  /** sha256 of the dataset's MANIFEST.json. */
  manifest_sha256: string;
  /** Every page the rollout brain imports, slug to page text. */
  pages: ReadonlyMap<string, string>;
  /** Person, company and account names, for the audit's entity flags. */
  names: readonly string[];
}

const cache = new Map<string, DatasetContext>();

/** v3's world pages: one JSON object per line, `{ "slug", "content" }`, in slug order. */
export const worldPagesPath = (root: string) => join(root, 'world', 'pages.jsonl');

/** Title of a page whose frontmatter type is person or company (accounts are companies). */
const entityTitle = (page: string) => {
  const front = /^---\n([\s\S]*?)\n---/.exec(page)?.[1] ?? '';
  if (!/^type: (?:person|company)$/m.test(front)) return null;
  return /^title: "(.*)"$/m.exec(front)?.[1] ?? null;
};

function build(version: DatasetVersion, root: string, manifest_sha256: string): DatasetContext {
  if (version !== 'v3') {
    const corpus = loadCorpora();
    const names = [...new Set([...accountNames().values(), ...[...corpus.world.values()].filter(p => p.type === 'person' || p.type === 'company').map(p => p.title)])];
    return { version, root, manifest_sha256, pages: corpus.pages, names };
  }
  const pages = new Map<string, string>();
  for (const line of readFileSync(worldPagesPath(root), 'utf8').split('\n').filter(Boolean)) {
    const p = JSON.parse(line) as { slug: string; content: string };
    pages.set(p.slug, p.content);
  }
  const names = [...new Set([...pages.values()].map(entityTitle).filter((t): t is string => !!t))];
  return { version, root, manifest_sha256, pages, names };
}

/** The context of `version` read from `root` (default: the committed dataset). */
export function datasetContext(version: DatasetVersion, root = datasetDir(version)): DatasetContext {
  const manifest = join(root, 'MANIFEST.json');
  if (!existsSync(manifest)) throw new Error(`${root}: MANIFEST.json is missing`);
  const manifest_sha256 = sha256(readFileSync(manifest));
  const key = `${root}\n${manifest_sha256}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const ctx = build(version, root, manifest_sha256);
  cache.set(key, ctx);
  return ctx;
}

/**
 * The one-shot proposer's redaction scope for a dataset: the markers of the
 * withheld tasks that train does not show, the pages train shows, and the
 * dataset's page slugs (every other one is withheld).
 */
export function redactionScope(ctx: DatasetContext, train: ReadonlyArray<Pick<MethodTask, 'task' | 'gold'>>, withheld: ReadonlyArray<Pick<MethodTask, 'task' | 'gold'>>): { markers: Marker[]; pages: { visible: Set<string>; corpus: Set<string> } } {
  return { markers: forbiddenMarkers(withheld, train), pages: { visible: trainPages(train), corpus: new Set(ctx.pages.keys()) } };
}

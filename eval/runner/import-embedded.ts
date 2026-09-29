/**
 * Embedding-required imports.
 *
 * Since gbrain v0.59.10.0, `importFromContent` no longer throws when the
 * embedding provider fails: it commits the text with NULL vectors and
 * returns `embedding_deferred: true` so a later `gbrain embed --stale`
 * pass can fill them in. That is the right product behavior, but a runner
 * that measures vector or hybrid retrieval would then silently score a
 * keyword-only brain under an embedding label. Runners whose measurement
 * needs vectors call this wrapper, which turns a deferred embedding back
 * into a thrown error at the import that caused it.
 */

import { importFromContent } from 'gbrain/import-file';

type ImportResult = Awaited<ReturnType<typeof importFromContent>>;

/** Throw when gbrain saved the page text but could not embed its chunks. */
export function assertEmbedded<T extends { embedding_deferred?: boolean }>(result: T, slug: string): T {
  if (result.embedding_deferred) {
    throw new Error(`embedding failed for ${slug}: gbrain saved the text without vectors (embedding_deferred)`);
  }
  return result;
}

export async function importFromContentEmbedded(...args: Parameters<typeof importFromContent>): Promise<ImportResult> {
  return assertEmbedded(await importFromContent(...args), args[1]);
}

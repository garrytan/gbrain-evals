/**
 * Which side of GBRA-398 (GST-2059) a live-recall batch 3 freeze or run falls on.
 *
 * GBRA-398 (garrytan/gbrain#8917) clears `access: private` where writers
 * over-applied it and lets the owner's and its delegates' connections read
 * private pages. Gold that a remote reader could not see before the change may
 * be visible after it, so a batch 3 freeze records its epoch and a counted run
 * refuses a freeze from the other epoch (LR_FREEZE_MISMATCH).
 *
 * The epoch is read from the loaded gbrain version:
 * - `post_gbra_398` at or above first_version, the first release that carries
 *   the change: 0.60.623.0, whose tag is #8917's merge commit d253ec0f
 *   (merged 2026-11-09; v0.60.622.0 does not contain it);
 * - `pre_gbra_398` below first_version;
 * - `unknown` for a version string that does not parse, so it is never
 *   silently labelled. With first_version null, anything above pre_ceiling,
 *   the newest version known to lack the change, is `unknown` too.
 */

export const VISIBILITY_EPOCHS = ['pre_gbra_398', 'post_gbra_398', 'unknown'] as const;
export type VisibilityEpoch = (typeof VISIBILITY_EPOCHS)[number];

export const GBRA_398 = {
  change: 'garrytan/gbrain#8917',
  /** The first gbrain release carrying GBRA-398. */
  first_version: '0.60.623.0' as string | null,
  pre_ceiling: '0.60.622.0',
};

const VERSION = /^\d+\.\d+\.\d+(\.\d+)?$/;

/** Negative, zero or positive as version a sorts before, with or after b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function visibilityEpoch(version: string, boundary: { first_version: string | null; pre_ceiling: string } = GBRA_398): VisibilityEpoch {
  if (!VERSION.test(version)) return 'unknown';
  if (boundary.first_version !== null) return compareVersions(version, boundary.first_version) >= 0 ? 'post_gbra_398' : 'pre_gbra_398';
  return compareVersions(version, boundary.pre_ceiling) <= 0 ? 'pre_gbra_398' : 'unknown';
}

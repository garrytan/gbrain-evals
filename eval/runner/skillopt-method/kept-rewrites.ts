/**
 * #304's three kept one-shot rewrites (GBEV-24, merged as 18bf8e1b), read for
 * the SkillOpt ceiling attempt's rewrite arm (GST-1013 plan, section 6; the
 * GST-956 read that gates shipping them). Each is read from its committed
 * receipt, checked against its sha256 prefix, and has its known caveats fixed
 * by exact edits that must each match once:
 *
 *   query       52942b2a, unchanged
 *   briefing    b35934a9, its `[withheld]` slug rule removed: the rule answers
 *               the proposer input's redaction marker, not anything a user sees
 *   fact-check  a417d566, the seed's unverifiable-claim thresholds restored to
 *               its confidence line (HIGH "<5% unverifiable", MEDIUM "5-15%
 *               unverifiable"), which the rewrite dropped
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillName } from './score.ts';

const RECEIPTS = join(import.meta.dir, '../../../docs/benchmarks/2026-11-01-skillopt-method/probe/frontier');

export interface KeptRewrite {
  /** Receipt path under the #304 frontier probe directory. */
  path: string;
  /** sha256 prefix of the committed file. */
  sha256: string;
  edits: ReadonlyArray<{ find: string; replace: string; why: string }>;
}

export const KEPT_REWRITES: Readonly<Record<SkillName, KeptRewrite>> = {
  query: { path: 'f0b-opus/one-shot/opus-query-rewrite-1.txt', sha256: '52942b2a', edits: [] },
  briefing: {
    path: 'f0b-sol/one-shot/sol-briefing-rewrite-2.txt', sha256: 'b35934a9',
    edits: [{
      find: '   - Never put `[withheld]` or a placeholder in the slug. Cite the real slug\n     returned by your tools.\n',
      replace: '',
      why: 'the [withheld] slug rule answers the proposer input\'s redaction marker',
    }],
  },
  'fact-check': {
    path: 'f0b-opus/one-shot/opus-fact-check-rewrite-2.txt', sha256: 'a417d566',
    edits: [{
      find: 'Confidence: HIGH >90% verified, 0 wrong; MEDIUM >75% verified, ≤1 wrong\n(corrected); LOW otherwise.',
      replace: 'Confidence: HIGH >90% verified, 0 wrong, <5% unverifiable; MEDIUM >75%\nverified, ≤1 wrong (corrected), 5-15% unverifiable; LOW otherwise.',
      why: 'restores the seed\'s unverifiable-claim thresholds',
    }],
  },
};

/** A kept rewrite with its caveats fixed. Throws when the receipt changed or an edit does not match exactly once. */
export function readKeptRewrite(skill: SkillName): string {
  const k = KEPT_REWRITES[skill];
  const raw = readFileSync(join(RECEIPTS, k.path), 'utf8');
  const sha = createHash('sha256').update(raw).digest('hex');
  if (!sha.startsWith(k.sha256)) throw new Error(`${k.path}: sha256 ${sha.slice(0, 8)}, expected ${k.sha256}`);
  return k.edits.reduce((text, e) => {
    const n = text.split(e.find).length - 1;
    if (n !== 1) throw new Error(`${k.path}: an edit (${e.why}) matched ${n} times, expected once`);
    return text.replace(e.find, e.replace);
  }, raw);
}

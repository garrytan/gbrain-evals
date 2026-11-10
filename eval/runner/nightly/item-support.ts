/**
 * Per-item support checks for the nightly suites. eval/data/nightly/<suite>-support.json, keyed by item id, records what
 * the BEAM support check (eval/custody/rs1/validate.ts, two validators) found: each validator's verdict on whether the
 * reference answer is supported by the turns the item cites, the check's gates, the cited count and the source. Each
 * item also records the oracle verdict: whether the arm given every gold session passed it. An oracle answer that is
 * empty because it stopped at the output limit records no verdict. The files sit beside the dev set, not in it, so no
 * suite digest changes.
 *
 * An item is unsupported when both validators reject it (a support:<validator> gate for each) or it cites no turn (the
 * uncited gate, or cited 0), and the oracle arm fails it too: the cited gold sessions don't support the answer. An item one
 * validator rejects, one the oracle arm passes or has no verdict for, an item the check left out (abstention cites no
 * turn by design), and an item or suite with no file are not, so their rows label as before.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ITEM_SUPPORT_SCHEMA = 'nightly-item-support/1';
const DATA = join(import.meta.dir, '..', '..', 'data', 'nightly');

export interface ItemSupport {
  checked: boolean;
  verdicts?: Record<string, 'supported' | 'unsupported' | 'validator_error'>;
  gates?: string[];
  cited?: number;
  oracle?: 'pass' | 'fail';
  source: string;
  reason?: string;
}
interface SupportFile { schema: typeof ITEM_SUPPORT_SCHEMA; suite: string; validators: string[]; items: Record<string, ItemSupport> }

const files = new Map<string, { file: SupportFile; at: string } | null>();

function supportFile(dir: string, suite: string): { file: SupportFile; at: string } | null {
  const path = join(dir, `${suite}-support.json`);
  if (!files.has(path)) {
    if (!existsSync(path)) files.set(path, null);
    else {
      const bytes = readFileSync(path);
      const file = JSON.parse(bytes.toString('utf8')) as SupportFile;
      if (file.schema !== ITEM_SUPPORT_SCHEMA || file.suite !== suite || !file.validators?.length) throw new Error(`${path}: not a ${ITEM_SUPPORT_SCHEMA} file for ${suite}`);
      files.set(path, { file, at: `repo:eval/data/nightly/${suite}-support.json#${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}` });
    }
  }
  return files.get(path)!;
}

/** Why the cited gold sessions don't support an item's answer, with the evidence pointer to its support record, or null. */
export function itemUnsupported(suite: string, item: string, dir = DATA): { why: 'both_validators' | 'uncited'; at: string } | null {
  const s = supportFile(dir, suite);
  const x = s?.file.items[item];
  if (!s || !x?.checked || x.oracle !== 'fail') return null;
  const at = `${s.at} ${item}`;
  if (x.gates?.includes('uncited') || x.cited === 0) return { why: 'uncited', at };
  return s.file.validators.every(v => x.gates?.includes(`support:${v}`)) ? { why: 'both_validators', at } : null;
}

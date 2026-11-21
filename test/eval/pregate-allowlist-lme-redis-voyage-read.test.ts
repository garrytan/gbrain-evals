import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Entry = { finding: string; paths?: string[]; pattern?: string; reason: string };
const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as { allowlist: Entry[] };
const SCRIPT = 'eval/runner/lme-redis/vm-stage.sh';
const entry = pregate.allowlist.find(e => e.finding === 'env.kv' && e.paths!.includes(SCRIPT))!;

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);
const inScope = (path: string) => entry.paths!.some(glob => new Bun.Glob(glob).match(path));

const READ = `$(python3 -c "import json;print(json.load(open('$LME_REDIS_STATE_DIR/proxy-ready.json'))['env']['gbrain']['VOYAGE_API_KEY'])")`;
const realShaped = [
  ['pa', 'Qm7Xc2Vb9Nl4Kj8Hg1Fd6Sa3Pw5Oe0Iu2Yt9Rr4Ee7Ww1Qq3'].join('-'),
  ['sk', 'ant', 'api03', 'Zx9Qw2Lk7Pn4Rt8Yv1Bm6Cd3Fg5Hj0Ks2Lq9Wr4Et7Yu1Io3Pa6Sd8Fg'].join('-'),
];

describe('secrets allowlist: the LongMemEval VM step reads the Voyage key at run time', () => {
  test('covers the read command as the scanner flags it (from the value after token=)', () => {
    expect(covers(READ)).toBe(true);
  });

  test('still flags a literal key or a changed command there', () => {
    for (const value of realShaped) {
      expect(covers(value)).toBe(false);
      expect(covers(`${READ}${value}`)).toBe(false);
    }
    expect(covers(READ.replace('proxy-ready.json', 'other.json'))).toBe(false);
    expect(covers(READ.replace("['gbrain']", "['other']"))).toBe(false);
  });

  test('applies to the VM step script only', () => {
    expect(inScope(SCRIPT)).toBe(true);
    for (const path of ['eval/runner/lme-redis/vm-setup.sh', 'eval/runner/lme-redis/gbrain-server.ts', 'eval/runner/other/vm-stage.sh']) expect(inScope(path)).toBe(false);
  });
});

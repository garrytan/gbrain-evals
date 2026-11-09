/**
 * Part C adjudication for the refresh write barrier preregistration (docs/benchmarks/2026-11-06-refresh-barrier-
 * preregistration.md, Amendment 3, "Part C adjudication"): a write refused invalid_params with gbrain's "nothing was
 * written", followed by a corrected call carrying the same fact token, counts as one write attempt and its resend, not a
 * reissue. A resend after a success, a timeout, a busy or barrier answer, or any other error still counts as a reissue.
 * The rule applies identically to both arms and both models; the result keeps the raw preregistered strict success beside
 * the adjudicated one, and the verdict reads the adjudicated number. A fact token more than once in pages or Git HEAD
 * (Amendment 2, procedure 4) or a context overflow fails an episode under both readings; the analyzer's success excludes
 * only the context overflow. A model's status is incomplete unless all 60 tasks in both arms are counted episodes at G and
 * the counted harness digest.
 *
 *   bun scripts/refresh-barrier-partc-adjudicate.ts --partc <agent.ts --out dir> [--out <adjudication.json>]
 *
 * A reissue is excused when the latest earlier write call carrying its fact token was refused invalid_params and its
 * result says "nothing was written". Strict success is then tokens_once, report_correct and every reissue excused.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { modelSlug, NON_INFERIOR_LO, PART_C_GATING, PART_C_TASKS, pairedBootstrap } from '../eval/runner/refresh-barrier/analyze.ts';

type Rec = Record<string, any>;

export const COUNTED_GBRAIN_SHA = '773a29eede3b3ea91e0e2cba4012078b5d42c602';
export const COUNTED_HARNESS_DIGEST = '500cc5ba4b978e18d695683a39ef51714ff4c1626249b1594e88eb91629035e3';

export function adjudicateEpisode(r: Rec): { raw: boolean; adjudicated: boolean; reissues: number; excused: number } {
  const reissues: Rec[] = r.behavior?.reissues ?? [];
  const writes: Rec[] = r.write_calls ?? [];
  const excused = reissues.filter(x => {
    const prior = writes.filter(w => w.i < x.call && (w.tokens ?? []).includes(x.fact)).at(-1);
    return prior !== undefined && prior.code === 'invalid_params' && String(r.transcript?.[prior.i]?.result ?? '').includes('nothing was written');
  }).length;
  const s = r.score ?? {};
  const kept = (s.duplicates ?? []).length === 0 && r.loop?.stop !== 'context_overflow';
  return { raw: s.success === true && kept, adjudicated: s.tokens_once === true && s.report_correct === true && excused === reissues.length && kept, reissues: reissues.length, excused };
}

export function adjudicate(partc: string): Rec {
  const models = Object.fromEntries(PART_C_GATING.map(model => {
    const incomplete: string[] = [];
    const arm = (a: 'off' | 'on') => PART_C_TASKS.map(id => {
      const p = join(partc, 'agent', modelSlug(model), a, `task-${id}.json`);
      if (!existsSync(p)) { incomplete.push(`${a}/task-${id}: missing`); return null; }
      const r = JSON.parse(readFileSync(p, 'utf8'));
      if (r.counted !== true || r.model !== model || r.arm !== a || r.provenance?.gbrain_sha !== COUNTED_GBRAIN_SHA || r.provenance?.harness_digest !== COUNTED_HARNESS_DIGEST) {
        incomplete.push(`${a}/task-${id}: not a counted episode of this model and arm at G and the counted digest`);
        return null;
      }
      return adjudicateEpisode(r);
    });
    const off = arm('off'), on = arm('on');
    const paired = PART_C_TASKS.map((_, i) => [off[i], on[i]] as const).filter(([a, b]) => a && b) as Array<readonly [Rec, Rec]>;
    const summary = (xs: Array<Rec | null>) => ({ episodes: xs.filter(Boolean).length, raw: xs.filter(x => x?.raw).length, adjudicated: xs.filter(x => x?.adjudicated).length,
      reissues: xs.reduce((n, x) => n + (x?.reissues ?? 0), 0), excused: xs.reduce((n, x) => n + (x?.excused ?? 0), 0),
      raw_inconsistent: xs.filter(x => x && x.raw && !x.adjudicated).length });
    const read = (key: 'raw' | 'adjudicated') => {
      const diff = pairedBootstrap(paired.map(([a, b]) => Number(b[key]) - Number(a[key])));
      return { on_minus_off: diff, status: incomplete.length || diff.lo === null ? 'incomplete' : diff.hi! < 0 ? 'harm' : diff.lo >= NON_INFERIOR_LO ? 'non_inferior' : 'inconclusive' };
    };
    return [model, { paired: paired.length, off: summary(off), on: summary(on), raw: read('raw'), adjudicated: read('adjudicated'), ...(incomplete.length ? { incomplete } : {}) }];
  }));
  return { partc: resolve(partc), rule: 'Amendment 3, Part C adjudication', models };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (!get('--partc')) { console.error('usage: bun scripts/refresh-barrier-partc-adjudicate.ts --partc <dir> [--out <file>]'); process.exit(2); }
  const result = adjudicate(get('--partc')!);
  if (get('--out')) writeFileSync(get('--out')!, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

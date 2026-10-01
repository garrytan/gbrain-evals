/**
 * Evaluates a category's preregistered promotion rules (eval/registry.ts)
 * against a completed receipt. all.ts gates on the result; nothing else about
 * the receipt (its own verdict included, unless a rule names it) can fail a
 * run.
 */
import type { PromotionCheck, PromotionRules } from '../registry.ts';

export interface CheckResult {
  id: string;
  kind: 'safety' | 'quality';
  pass: boolean;
  /** Observed value, or undefined when the path is missing. */
  observed: unknown;
  expected: string;
}

export interface PromotionOutcome {
  /** True when the rules contain at least one safety contract or quality threshold and are not held. */
  gated: boolean;
  pass: boolean;
  results: CheckResult[];
  failures: CheckResult[];
}

/** Value at a dotted path, or undefined when any segment is missing. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in (cur as Record<string, unknown>))) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function checkPasses(check: Pick<PromotionCheck, 'op' | 'value'>, observed: unknown): boolean {
  if (check.op === '==') return observed === check.value;
  if (typeof observed !== 'number' || typeof check.value !== 'number' || !Number.isFinite(observed)) return false;
  return check.op === '<=' ? observed <= check.value : observed >= check.value;
}

export function evaluatePromotion(rules: PromotionRules, receipt: unknown): PromotionOutcome {
  const results: CheckResult[] = [
    ...rules.safety_contracts.map(c => ({ c, kind: 'safety' as const })),
    ...rules.quality_thresholds.map(c => ({ c, kind: 'quality' as const })),
  ].map(({ c, kind }) => {
    const observed = readPath(receipt, c.path);
    return { id: c.id, kind, pass: checkPasses(c, observed), observed, expected: `${c.path} ${c.op} ${JSON.stringify(c.value)}` };
  });
  const failures = results.filter(r => !r.pass);
  return { gated: results.length > 0 && !rules.held, pass: failures.length === 0, results, failures };
}

/** One line for the report: "safety 5/5, quality 2/2" plus each failure. */
export function describeOutcome(o: PromotionOutcome): string {
  const count = (kind: CheckResult['kind']) => {
    const rs = o.results.filter(r => r.kind === kind);
    return `${rs.filter(r => r.pass).length}/${rs.length}`;
  };
  const failed = o.failures.map(f => `${f.id} (${f.expected}, observed ${f.observed === undefined ? 'missing' : JSON.stringify(f.observed)})`);
  return `safety ${count('safety')}, quality ${count('quality')}${failed.length ? `; failed: ${failed.join('; ')}` : ''}`;
}

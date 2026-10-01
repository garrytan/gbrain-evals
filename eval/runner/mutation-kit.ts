/**
 * Scorer mutation kit (eval-category wave amendment 4).
 *
 * A scorer that a degenerate system can pass measures nothing. Before a
 * category's numbers count, its scorer must fail five fake systems:
 *
 *   empty            answers nothing (empty set, null, no result);
 *   always-positive  claims everything: every candidate, a value for every
 *                    question, never "none";
 *   always-refuse    refuses or abstains on every question;
 *   stale            never applies updates: answers with the value from
 *                    before the latest change;
 *   wrong-source     answers with another entity's or another source's value.
 *
 * A category describes its answer space once (what the truthful, empty,
 * everything, refusal, stale and wrong-source answers to a probe are) and
 * how its real scorer turns answers into a verdict. runMutationSuite then
 * scores the honest system and each fake; assertScorerRejectsFakeSystems
 * throws unless the honest system passes, every applicable fake fails, and
 * every fake actually changed some answer (a fake identical to the truth
 * proves nothing). A fake that cannot exist for a category (no time axis for
 * "stale") is declared not applicable with a reason, never silently skipped.
 *
 * The kit is pure: no gbrain import, no I/O. Use it from a bun test.
 */

export const FAKE_SYSTEM_KINDS = ['empty', 'always-positive', 'always-refuse', 'stale', 'wrong-source'] as const;
export type FakeSystemKind = typeof FAKE_SYSTEM_KINDS[number];

/** The answers a fake system can give to one probe. */
export interface AnswerSpace<P, A> {
  truth(p: P): A;
  empty(p: P): A;
  everything(p: P): A;
  refusal(p: P): A;
  /** The answer before the latest update; undefined when this probe has no history. */
  stale?(p: P): A | undefined;
  /** Another entity's or source's answer; undefined when none differs. */
  wrongSource?(p: P): A | undefined;
}

type System = <P, A>(p: P, space: AnswerSpace<P, A>) => A;

export const HONEST_SYSTEM: System = (p, s) => s.truth(p);

/** Fakes fall back to the truth where they have no alternative, so their damage is only what they can really do. */
export const FAKE_SYSTEMS: Record<FakeSystemKind, System> = {
  empty: (p, s) => s.empty(p),
  'always-positive': (p, s) => s.everything(p),
  'always-refuse': (p, s) => s.refusal(p),
  stale: (p, s) => s.stale?.(p) ?? s.truth(p),
  'wrong-source': (p, s) => s.wrongSource?.(p) ?? s.truth(p),
};

export interface ScorerVerdict { pass: boolean; detail: string }

export interface MutationSuite<P, A> {
  category: string;
  probes: readonly P[];
  space: AnswerSpace<P, A>;
  /** The category's real scorer and verdict over answers aligned with `probes`. */
  score(answers: readonly A[]): ScorerVerdict;
  /** Fakes that cannot exist for this category, each with the reason. */
  notApplicable?: Partial<Record<FakeSystemKind, string>>;
  /** Answer equality, for counting changed answers. Defaults to JSON equality. */
  same?(a: A, b: A): boolean;
}

export interface MutationResult {
  system: 'honest' | FakeSystemKind;
  pass: boolean;
  detail: string;
  /** Probes whose answer differs from the truth. */
  changed: number;
  notApplicable?: string;
}

export function runMutationSuite<P, A>(suite: MutationSuite<P, A>): MutationResult[] {
  const same = suite.same ?? ((a: A, b: A) => JSON.stringify(a) === JSON.stringify(b));
  const truth = suite.probes.map(p => suite.space.truth(p));
  const run = (system: MutationResult['system'], fn: System): MutationResult => {
    const answers = suite.probes.map(p => fn(p, suite.space));
    const verdict = suite.score(answers);
    return { system, pass: verdict.pass, detail: verdict.detail, changed: answers.filter((a, i) => !same(a, truth[i])).length };
  };
  return [
    run('honest', HONEST_SYSTEM),
    ...FAKE_SYSTEM_KINDS.map(kind => {
      const reason = suite.notApplicable?.[kind];
      return reason ? { system: kind, pass: false, detail: 'not applicable', changed: 0, notApplicable: reason } : run(kind, FAKE_SYSTEMS[kind]);
    }),
  ];
}

/** Every way the suite fails to prove its scorer: empty list when it is sound. */
export function mutationProblems(category: string, results: readonly MutationResult[]): string[] {
  const problems: string[] = [];
  for (const r of results) {
    if (r.notApplicable !== undefined) continue;
    if (r.system === 'honest') {
      if (!r.pass) problems.push(`${category}: the honest system fails (${r.detail}), so the scorer cannot pass anything`);
    } else if (r.changed === 0) {
      problems.push(`${category}: the ${r.system} fake changed no answer; give the world a probe it can get wrong or declare it not applicable`);
    } else if (r.pass) {
      problems.push(`${category}: the ${r.system} fake passes (${r.detail}) after changing ${r.changed} answers`);
    }
  }
  return problems;
}

/** Test helper: throws, listing every problem, unless the scorer passes the honest system and fails every applicable fake. */
export function assertScorerRejectsFakeSystems<P, A>(suite: MutationSuite<P, A>): MutationResult[] {
  const results = runMutationSuite(suite);
  const problems = mutationProblems(suite.category, results);
  if (problems.length) throw new Error(`scorer mutation check failed:\n  ${problems.join('\n  ')}`);
  return results;
}

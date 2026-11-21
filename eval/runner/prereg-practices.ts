/**
 * Eval-loop practices for new preregistrations.
 *
 * The org's eval-loop practices page (software-factory/evals/eval-loop-practices.md) asks every new plan to carry four
 * things before it spends: the decision each outcome changes (R97), a pilot per arm on at most a tenth of that arm's
 * budget (R111), a checked cross-family judge read per arm (R78) and, above $500 paid, one interim look at half the
 * units (R113). A quick look (R112) needs only its three-line plan.
 *
 * `checkPractices` runs in CI beside `checkOrder`. It reads structured fields on each registry entry and checks their
 * presence and minimal shape, never the meaning of prose. Entries and preregistration files that existed when this
 * check landed are listed in `docs/benchmarks/preregistrations-grandfathered.json` and keep the rules they were written
 * under. Every other entry is new: it carries a `registered` date on or after the cutoff and the fields below, and every
 * new preregistration file needs a registry entry. Cost never appears here: the paid tier is a band, not a figure (R79).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUSPENDED_SINCE, SUSPENSION_RULE, suspendedModelProblem } from './model-defaults.ts';
import type { ManifestEntry, OrderProblem } from './prereg.ts';

export const PRACTICES_CUTOFF = '2026-11-19';
export const JUDGE_LABELS_RAISED_FROM = '2026-11-22';
export const GRANDFATHERED_PATH = 'docs/benchmarks/preregistrations-grandfathered.json';
export const TEMPLATE_PATH = 'docs/benchmarks/PREREGISTRATION-TEMPLATE.md';
export const PAID_TIERS = ['quick-look', 'under-500', 'over-500'] as const;
export const MODEL_ROLES = ['under-test', 'judge', 'simulator', 'extractor', 'embedder', 'bridge', 'protocol-fixed', 'system-internal'] as const;
export const SETTLED_CALL = /^\s*(?:[-*]\s+)?(?:\*\*)?Settled call:(?:\*\*)?[ \t]*(.*)$/m;

const MODEL_FAMILIES: Array<[RegExp, string]> = [
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o\d|chatgpt-)/, 'openai'],
  [/^gemini-/, 'google'],
  [/^particle-/, 'particle'],
  [/^grok-/, 'xai'],
  [/^(muse-|llama-)/, 'meta'],
  [/^deepseek-/, 'deepseek'],
  [/^qwen/, 'alibaba'],
  [/^kimi-/, 'moonshot'],
  [/^glm-/, 'zai'],
];

export interface Grandfathered {
  ids: string[];
  unlisted_preregistrations: string[];
}

export type PracticeEntry = ManifestEntry & Record<string, unknown>;

/** Every Markdown file under docs/ whose name says it is a preregistration or a protocol, except the template. */
export function isPreregistrationFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.startsWith('docs/') || !lower.endsWith('.md') || path === TEMPLATE_PATH) return false;
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return name.includes('prereg') || name.endsWith('-protocol.md');
}

export function modelFamily(model: string): string | null {
  const bare = model.trim().toLowerCase().replace(/^[^:/]*[:/]/, '');
  return MODEL_FAMILIES.find(([pattern]) => pattern.test(bare))?.[1] ?? null;
}

export function loadGrandfathered(root = process.cwd()): Grandfathered {
  return JSON.parse(readFileSync(join(root, GRANDFATHERED_PATH), 'utf8')) as Grandfathered;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function missingText(obj: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter(k => !isText(obj[k]));
}

function checkDecision(decision: unknown): string[] {
  if (!Array.isArray(decision) || decision.length < 2) {
    return ['decision must list at least two outcomes as [{ "if": "<outcome>", "then": "<what we do differently>" }] (R97)'];
  }
  return decision.flatMap((d, i) =>
    isObject(d) && missingText(d, ['if', 'then']).length === 0 ? [] : [`decision[${i}] needs non-empty "if" and "then"`],
  );
}

function checkPilots(arms: unknown, pilots: unknown): string[] {
  if (!Array.isArray(arms) || arms.length === 0 || !arms.every(isText)) return ['arms must list every arm by name'];
  if (new Set(arms).size !== arms.length) return ['arms has duplicate names'];
  if (!Array.isArray(pilots)) return ['pilots must list one pilot per arm (R111)'];
  const problems: string[] = [];
  const piloted = new Set<string>();
  pilots.forEach((p, i) => {
    if (!isObject(p)) {
      problems.push(`pilots[${i}] must be an object`);
      return;
    }
    if (!isText(p.arm) || !arms.includes(p.arm)) problems.push(`pilots[${i}].arm must name one of arms`);
    else if (piloted.has(p.arm)) problems.push(`pilots[${i}] pilots ${p.arm} twice`);
    else piloted.add(p.arm);
    const f = p.max_budget_fraction;
    if (typeof f !== 'number' || !(f > 0 && f <= 0.1)) problems.push(`pilots[${i}].max_budget_fraction must be above 0 and at most 0.1 of the arm's budget`);
    for (const k of missingText(p, ['part_under_test_ran', 'judge_passes', 'units_supplied_at_rate'])) {
      problems.push(`pilots[${i}].${k} must say how the pilot shows it`);
    }
  });
  for (const arm of arms) if (!piloted.has(arm)) problems.push(`arm ${arm} has no pilot (R111)`);
  return problems;
}

/** Labelled outputs a model judge is checked on before its numbers count: 100 for plans frozen on or after JUDGE_LABELS_RAISED_FROM, 40 before (R78). */
export function judgeLabelMinimum(registered: unknown): number {
  return isText(registered) && registered >= JUDGE_LABELS_RAISED_FROM ? 100 : 40;
}

function checkJudge(judge: unknown, registered: unknown): string[] {
  if (!isObject(judge)) return ['judge_check is required: { "model_judge": false, "reason": "..." } or { "judges": [...], "read_per_arm": true } (R78)'];
  if (judge.model_judge === false) return isText(judge.reason) ? [] : ['judge_check.reason must say why no model judge is used'];
  const problems: string[] = [];
  const minLabels = judgeLabelMinimum(registered);
  if (!Array.isArray(judge.judges) || judge.judges.length === 0) problems.push('judge_check.judges must list each model judge');
  if (judge.read_per_arm !== true) problems.push('judge_check.read_per_arm must be true: the judge\'s errors are read per arm, not pooled (R78)');
  (Array.isArray(judge.judges) ? judge.judges : []).forEach((j: unknown, i: number) => {
    if (!isObject(j)) {
      problems.push(`judge_check.judges[${i}] must be an object`);
      return;
    }
    const family = isText(j.model) ? modelFamily(j.model) : null;
    if (!isText(j.model)) problems.push(`judge_check.judges[${i}].model is required`);
    else if (!family) problems.push(`judge_check.judges[${i}].model ${j.model} has no known family; add it to MODEL_FAMILIES in eval/runner/prereg-practices.ts`);
    else if (family === 'particle') problems.push(`judge_check.judges[${i}]: particle-1 never judges a counted cell`);
    if (!Number.isInteger(j.labelled_outputs) || (j.labelled_outputs as number) < minLabels) problems.push(`judge_check.judges[${i}].labelled_outputs must be at least ${minLabels} (R78)`);
    if (typeof j.kappa_min !== 'number' || j.kappa_min < 0.6 || j.kappa_min > 1) problems.push(`judge_check.judges[${i}].kappa_min must be at least 0.6 (R78)`);
    if (!Array.isArray(j.grades) || j.grades.length === 0 || !j.grades.every(isText)) {
      problems.push(`judge_check.judges[${i}].grades must list the models whose outputs it scores`);
      return;
    }
    for (const graded of j.grades as string[]) {
      const gradedFamily = modelFamily(graded);
      if (!gradedFamily) problems.push(`judge_check.judges[${i}].grades: ${graded} has no known family; add it to MODEL_FAMILIES in eval/runner/prereg-practices.ts`);
      else if (family && gradedFamily === family) problems.push(`judge_check.judges[${i}]: ${j.model} grades its own family's model ${graded}; use a cross-family judge (R78)`);
    }
  });
  return problems;
}

/**
 * From SUSPENDED_SINCE every entry lists the models it runs, each with its role, and none may be a suspended model
 * except a compared system's shipped default (`system-internal`, naming the system), which is tested as shipped.
 */
export function checkModels(entry: PracticeEntry): string[] {
  if (!isText(entry.registered) || entry.registered < SUSPENDED_SINCE) return [];
  const models = entry.models;
  if (!Array.isArray(models) || models.length === 0) {
    return [`models must list every model the campaign runs as [{ "model": "<id>", "role": "<${MODEL_ROLES.join('|')}>" }], so the ${SUSPENDED_SINCE} suspension can be checked`];
  }
  const problems: string[] = [];
  models.forEach((m, i) => {
    if (!isObject(m) || !isText(m.model)) {
      problems.push(`models[${i}].model is required`);
      return;
    }
    if (!MODEL_ROLES.includes(m.role as (typeof MODEL_ROLES)[number])) problems.push(`models[${i}].role must be one of ${MODEL_ROLES.join(', ')}`);
    if (m.role === 'system-internal') {
      if (!isText(m.system)) problems.push(`models[${i}].system must name the compared system that ships ${m.model} as its default`);
      return;
    }
    const suspended = suspendedModelProblem(m.model);
    if (suspended) problems.push(`models[${i}]: ${suspended}`);
  });
  const judges = isObject(entry.judge_check) && Array.isArray(entry.judge_check.judges) ? entry.judge_check.judges : [];
  judges.forEach((j: unknown, i: number) => {
    if (!isObject(j)) return;
    for (const model of [j.model, ...(Array.isArray(j.grades) ? j.grades : [])]) {
      if (isText(model) && suspendedModelProblem(model)) problems.push(`judge_check.judges[${i}]: ${model}: ${SUSPENSION_RULE}`);
    }
  });
  return problems;
}

function checkInterim(tier: string, look: unknown): string[] {
  if (isObject(look) && 'not_required' in look) {
    if (tier === 'over-500') return ['interim_look is required above $500 paid: one look at half the units (R113)'];
    return isText(look.not_required) ? [] : ['interim_look.not_required must give the reason'];
  }
  if (!isObject(look)) {
    return [tier === 'over-500'
      ? 'interim_look is required above $500 paid: { "at_units_fraction": 0.5, "bounds": "obrien-fleming", "alpha": <the plan\'s alpha>, "futility_stop": "..." } (R113)'
      : 'interim_look must be a planned look or { "not_required": "<reason>" }'];
  }
  const problems: string[] = [];
  if (look.at_units_fraction !== 0.5) problems.push('interim_look.at_units_fraction must be 0.5: one look at half the units (R113)');
  if (look.bounds !== 'obrien-fleming') problems.push('interim_look.bounds must be "obrien-fleming" (R113)');
  if (typeof look.alpha !== 'number' || !(look.alpha > 0 && look.alpha < 0.5)) problems.push('interim_look.alpha must be the plan\'s own alpha, above 0 and below 0.5 (R113)');
  if (!isText(look.futility_stop)) problems.push('interim_look.futility_stop must state the futility rule (R113)');
  return problems;
}

function checkResultsPage(entry: PracticeEntry, required: boolean, cwd: string): string[] {
  const page = entry.results_page;
  if (page === undefined && !required) return [];
  if (!isText(page) || !page.endsWith('.md')) return ['results_page must name the Markdown results page'];
  if (!entry.results.some(glob => new Bun.Glob(glob).match(page))) return [`results_page ${page} must match one of the results globs`];
  if (!existsSync(join(cwd, page))) return [];
  const line = readFileSync(join(cwd, page), 'utf8').match(SETTLED_CALL);
  if (!line || !isText(line[1])) return [`${page} needs one line "Settled call: <the ship-or-kill call this result settled, or none>"`];
  if (/\$\s?\d/.test(line[1])) return [`${page}: the settled-call line names a cost; cost goes in the private ledger, not the repo (R79)`];
  return [];
}

export function checkEntry(entry: PracticeEntry, cwd = process.cwd()): string[] {
  const problems: string[] = [];
  const registered = entry.registered;
  if (!isText(registered) || !/^\d{4}-\d{2}-\d{2}$/.test(registered) || registered < PRACTICES_CUTOFF) {
    problems.push(`registered must be the YYYY-MM-DD date the entry was added, on or after ${PRACTICES_CUTOFF}`);
  }
  const tier = entry.paid_tier;
  if (!PAID_TIERS.includes(tier as (typeof PAID_TIERS)[number])) {
    return [...problems, `paid_tier must be one of ${PAID_TIERS.join(', ')}; it is a band, never a dollar figure`];
  }
  if (tier === 'quick-look') {
    const plan = entry.quick_look;
    if (!isObject(plan)) problems.push('quick_look must carry the three-line plan: { "question", "decision", "stop_rule" } (R112)');
    else for (const k of missingText(plan, ['question', 'decision', 'stop_rule'])) problems.push(`quick_look.${k} is required (R112)`);
    return [...problems, ...checkModels(entry), ...checkResultsPage(entry, false, cwd)];
  }
  return [
    ...problems,
    ...checkDecision(entry.decision),
    ...checkPilots(entry.arms, entry.pilots),
    ...checkJudge(entry.judge_check, registered),
    ...checkModels(entry),
    ...checkInterim(tier as string, entry.interim_look),
    ...checkResultsPage(entry, true, cwd),
  ];
}

export function checkPractices(entries: PracticeEntry[], grandfathered: Grandfathered, cwd = process.cwd()): OrderProblem[] {
  const oldIds = new Set(grandfathered.ids);
  const problems: OrderProblem[] = entries
    .filter(entry => !oldIds.has(entry.id))
    .flatMap(entry => checkEntry(entry, cwd).map(problem => ({ id: entry.id, file: entry.preregistration, problem })));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push({ id: entry.id, file: entry.preregistration, problem: 'id is already used by another registry entry; a new experiment needs its own id' });
    seen.add(entry.id);
  }
  const listed = new Set([...entries.map(e => e.preregistration), ...grandfathered.unlisted_preregistrations]);
  const tracked = git(cwd, ['ls-files', '--', ':(glob,icase)docs/**/*prereg*.md', ':(glob,icase)docs/**/*-protocol.md']).split('\n').filter(isPreregistrationFile);
  for (const file of tracked) {
    if (listed.has(file) || listed.has(file.replace(/-addenda\.md$/i, '.md'))) continue;
    problems.push({ id: '*', file, problem: 'new preregistration has no registry entry; add one under docs/benchmarks/preregistrations.d/' });
  }
  return problems;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The grandfather list may only name experiments and files that existed in the commit that first added it, so a new
 * plan can't join the list to skip the practices check. Removing a name is always allowed.
 */
export function checkGrandfatheredFrozen(grandfathered: Grandfathered, cwd = process.cwd()): OrderProblem[] {
  const hasCommits = execFileSync('git', ['rev-list', '-n', '1', '--all'], { cwd, encoding: 'utf8' }).trim() !== '';
  const adds = hasCommits ? git(cwd, ['log', '--diff-filter=A', '--format=%H', '--', GRANDFATHERED_PATH]).split('\n').filter(Boolean) : [];
  const created = adds[adds.length - 1];
  if (!created) return [{ id: '*', file: GRANDFATHERED_PATH, problem: 'grandfather list is not committed' }];
  const filesThen = new Set(git(cwd, ['ls-tree', '-r', '--name-only', created, '--', ...grandfathered.unlisted_preregistrations]).split('\n').filter(Boolean));
  const registry = git(cwd, ['ls-tree', '-r', '--name-only', created, '--', 'docs/benchmarks/preregistrations.json', 'docs/benchmarks/preregistrations.d']).split('\n').filter(f => f.endsWith('.json'));
  const idsThen = new Set(registry.flatMap(f => (JSON.parse(git(cwd, ['show', `${created}:${f}`])) as { experiments: ManifestEntry[] }).experiments.map(e => e.id)));
  const at = created.slice(0, 12);
  return [
    ...grandfathered.ids.filter(id => !idsThen.has(id)).map(id => ({ id, file: GRANDFATHERED_PATH, problem: `grandfathered id was not in the registry when the list was created (${at}); new plans can't be grandfathered` })),
    ...grandfathered.unlisted_preregistrations.filter(f => !filesThen.has(f)).map(f => ({ id: '*', file: f, problem: `grandfathered file did not exist when the list was created (${at}); new plans can't be grandfathered` })),
  ];
}

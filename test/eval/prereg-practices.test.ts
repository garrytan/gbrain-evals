import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkEntry, checkGrandfatheredFrozen, checkPractices, GRANDFATHERED_PATH, isPreregistrationFile, loadGrandfathered, modelFamily, type PracticeEntry } from '../../eval/runner/prereg-practices.ts';
import { loadManifest } from '../../eval/runner/prereg.ts';

const fixture = (name: string): PracticeEntry =>
  JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/prereg-practices', name), 'utf8')) as PracticeEntry;

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'prereg-practices-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  g('add', '-A');
  return dir;
}

const empty = repo({});
const none = { ids: [], unlisted_preregistrations: [] };
const problems = (entry: PracticeEntry, cwd = empty) => checkEntry(entry, cwd);
function counted(change: (e: PracticeEntry) => void): string[] {
  const e = structuredClone(fixture('pass-counted.json'));
  change(e);
  return problems(e);
}

// Value: protects=the eval-loop practices gate (R97, R111, R78, R113, R112) on new preregistrations; fails_when=a new registry entry without a decision, a pilot per arm, a checked cross-family judge or the half-units look passes CI, or a grandfathered plan is reopened; seam=checkEntry and checkPractices over fixtures and throwaway git repos, keyless; no_claim=whether the prose in a preregistration matches its registry fields
describe('checkEntry passes', () => {
  test('a counted plan with every practice field', () => {
    expect(problems(fixture('pass-counted.json'))).toEqual([]);
  });

  test('a quick look with only its three-line plan', () => {
    expect(problems(fixture('pass-quick-look.json'))).toEqual([]);
  });

  test('an under-500 plan that says why it takes no interim look and uses no model judge', () => {
    expect(counted(e => {
      e.paid_tier = 'under-500';
      e.interim_look = { not_required: 'planned under $500 paid' };
      e.judge_check = { model_judge: false, reason: 'exact-match scorer' };
    })).toEqual([]);
  });
});

describe('checkEntry refuses', () => {
  test('a new entry in the old shape', () => {
    const p = problems(fixture('fail-old-shape.json'));
    expect(p.some(x => x.startsWith('registered'))).toBe(true);
    expect(p.some(x => x.startsWith('paid_tier'))).toBe(true);
  });

  test('a registered date before the cutoff', () => {
    expect(counted(e => { e.registered = '2026-11-01'; })[0]).toContain('registered');
  });

  test('a paid tier given as a dollar figure', () => {
    expect(counted(e => { e.paid_tier = 750; })[0]).toContain('paid_tier must be one of');
  });

  test('a missing decision (R97)', () => {
    expect(counted(e => { delete e.decision; })).toEqual([expect.stringContaining('decision must list at least two outcomes')]);
  });

  test('a decision with one outcome', () => {
    expect(counted(e => { e.decision = [(e.decision as unknown[])[0]]; })).toEqual([expect.stringContaining('at least two outcomes')]);
  });

  test('a decision outcome with an empty "then"', () => {
    expect(counted(e => { (e.decision as Array<Record<string, string>>)[1]!.then = ' '; })).toEqual(['decision[1] needs non-empty "if" and "then"']);
  });

  test('an arm with no pilot (R111)', () => {
    expect(counted(e => { e.pilots = (e.pilots as unknown[]).slice(0, 1); })).toEqual(['arm files has no pilot (R111)']);
  });

  test('missing pilots', () => {
    expect(counted(e => { delete e.pilots; })).toEqual(['pilots must list one pilot per arm (R111)']);
  });

  test('a pilot above a tenth of its arm\'s budget', () => {
    expect(counted(e => { (e.pilots as Array<Record<string, unknown>>)[0]!.max_budget_fraction = 0.2; })[0]).toContain('at most 0.1');
  });

  test('a pilot that does not say how it shows one of the three things', () => {
    expect(counted(e => { delete (e.pilots as Array<Record<string, unknown>>)[1]!.units_supplied_at_rate; })).toEqual([
      'pilots[1].units_supplied_at_rate must say how the pilot shows it',
    ]);
  });

  test('a pilot for an arm the plan does not list', () => {
    expect(counted(e => { (e.pilots as Array<Record<string, unknown>>)[1]!.arm = 'other'; })).toContain('pilots[1].arm must name one of arms');
  });

  test('a missing judge check (R78)', () => {
    expect(counted(e => { delete e.judge_check; })[0]).toContain('judge_check is required');
  });

  test('a judge checked on fewer than 40 labelled outputs', () => {
    expect(counted(e => { (e.judge_check as { judges: Array<Record<string, unknown>> }).judges[0]!.labelled_outputs = 39; })[0]).toContain('at least 40');
  });

  test('a judge kappa threshold below 0.6', () => {
    expect(counted(e => { (e.judge_check as { judges: Array<Record<string, unknown>> }).judges[1]!.kappa_min = 0.5; })[0]).toContain('kappa_min must be at least 0.6');
  });

  test('a judge that grades its own family', () => {
    expect(counted(e => { (e.judge_check as { judges: Array<Record<string, unknown>> }).judges[1]!.grades = ['claude-opus-5-5']; })[0]).toContain('its own family');
  });

  test('a particle-1 judge', () => {
    expect(counted(e => { (e.judge_check as { judges: Array<Record<string, unknown>> }).judges[1]!.model = 'particle-1'; })[0]).toContain('never judges a counted cell');
  });

  test('a judge whose errors are pooled instead of read per arm', () => {
    expect(counted(e => { (e.judge_check as Record<string, unknown>).read_per_arm = false; })[0]).toContain('read_per_arm must be true');
  });

  test('a judge model with no known family', () => {
    expect(counted(e => { (e.judge_check as { judges: Array<Record<string, unknown>> }).judges[1]!.model = 'mystery-judge'; })[0]).toContain('no known family');
  });

  test('no model judge without a reason', () => {
    expect(counted(e => { e.judge_check = { model_judge: false }; })).toEqual(['judge_check.reason must say why no model judge is used']);
  });

  test('an over-500 plan with no interim look (R113)', () => {
    expect(counted(e => { delete e.interim_look; })[0]).toContain('interim_look is required above $500 paid');
  });

  test('an over-500 plan that marks the interim look not required', () => {
    expect(counted(e => { e.interim_look = { not_required: 'too expensive' }; })[0]).toContain('interim_look is required above $500 paid');
  });

  test('an interim look that is not at half the units, not O\'Brien-Fleming, has no alpha or no futility stop', () => {
    expect(counted(e => { e.interim_look = { at_units_fraction: 0.3, bounds: 'pocock' }; })).toEqual([
      'interim_look.at_units_fraction must be 0.5: one look at half the units (R113)',
      'interim_look.bounds must be "obrien-fleming" (R113)',
      "interim_look.alpha must be the plan's own alpha, above 0 and below 0.5 (R113)",
      'interim_look.futility_stop must state the futility rule (R113)',
    ]);
  });

  test('an under-500 plan with no interim_look field at all', () => {
    expect(counted(e => { e.paid_tier = 'under-500'; delete e.interim_look; })[0]).toContain('{ "not_required": "<reason>" }');
  });

  test('a not-required interim look with no reason', () => {
    expect(counted(e => { e.paid_tier = 'under-500'; e.interim_look = { not_required: '' }; })).toEqual(['interim_look.not_required must give the reason']);
  });

  test('a quick look missing a line of its three-line plan (R112)', () => {
    const e = fixture('pass-quick-look.json');
    delete (e.quick_look as Record<string, unknown>).stop_rule;
    expect(problems(e)).toEqual(['quick_look.stop_rule is required (R112)']);
  });

  test('a quick look with no plan', () => {
    const e = fixture('pass-quick-look.json');
    delete e.quick_look;
    expect(problems(e)[0]).toContain('three-line plan');
  });

  test('a counted plan with no results page', () => {
    expect(counted(e => { delete e.results_page; })).toEqual(['results_page must name the Markdown results page']);
  });

  test('a results page outside the results globs', () => {
    expect(counted(e => { e.results_page = 'docs/other.md'; })[0]).toContain('must match one of the results globs');
  });
});

describe('results page settled-call line', () => {
  const page = 'docs/benchmarks/2026-11-20-fixture.md';
  const withPage = (body: string) => problems(fixture('pass-counted.json'), repo({ [page]: body }));

  test('passes with a settled call', () => {
    expect(withPage('# Result\n\n**Settled call:** ship the search hint\n')).toEqual([]);
  });

  test('passes with "none"', () => {
    expect(withPage('Settled call: none\n')).toEqual([]);
  });

  test('refuses a results page without the line', () => {
    expect(withPage('# Result\n\nWe learned things.\n')).toEqual([`${page} needs one line "Settled call: <the ship-or-kill call this result settled, or none>"`]);
  });

  test('refuses an empty settled call', () => {
    expect(withPage('Settled call:\n')).toHaveLength(1);
  });

  test('refuses a cost on the settled-call line (R79)', () => {
    expect(withPage('Settled call: kill, after $1,200\n')[0]).toContain('private ledger');
  });
});

describe('checkPractices', () => {
  test('skips grandfathered entries and checks new ones', () => {
    const old = fixture('fail-old-shape.json');
    expect(checkPractices([old], { ids: [old.id], unlisted_preregistrations: [] }, empty)).toEqual([]);
    expect(checkPractices([old], none, empty).length).toBeGreaterThan(0);
    expect(checkPractices([fixture('pass-counted.json'), fixture('pass-quick-look.json')], none, empty)).toEqual([]);
  });

  test('refuses a new entry that reuses a grandfathered id', () => {
    const old = fixture('fail-old-shape.json');
    const copy = { ...structuredClone(old), preregistration: 'docs/benchmarks/2026-11-21-copy-preregistration.md', results: ['docs/benchmarks/2026-11-21-copy/**'] };
    expect(checkPractices([old, copy], { ids: [old.id], unlisted_preregistrations: [] }, empty)).toEqual([
      { id: old.id, file: copy.preregistration, problem: 'id is already used by another registry entry; a new experiment needs its own id' },
    ]);
  });

  test('refuses a new preregistration file with no registry entry', () => {
    const dir = repo({ 'docs/benchmarks/2026-11-20-loose-preregistration.md': 'plan', 'docs/benchmarks/2026-11-01-old-preregistration.md': 'plan' });
    expect(checkPractices([], { ids: [], unlisted_preregistrations: ['docs/benchmarks/2026-11-01-old-preregistration.md'] }, dir)).toEqual([
      { id: '*', file: 'docs/benchmarks/2026-11-20-loose-preregistration.md', problem: 'new preregistration has no registry entry; add one under docs/benchmarks/preregistrations.d/' },
    ]);
  });

  test('refuses a new preregistration in any filename shape, and accepts an addendum to a listed one', () => {
    const shapes = [
      'docs/benchmarks/2026-11-20-x/PREREGISTRATION.md',
      'docs/benchmarks/2026-11-20-x/preregistration.md',
      'docs/benchmarks/live/PHASE3-PREREGISTRATION.md',
      'docs/benchmarks/2026-11-20-x/preregistration-gate-2.md',
      'docs/benchmarks/2026-11-20-x-protocol.md',
      'docs/plans/2026-11-20-wave/PREREG.md',
      'docs/plans/2026-11-20-wave/prereg-arm.md',
    ];
    const listed = 'docs/benchmarks/2026-11-20-y-preregistration.md';
    const files = Object.fromEntries([...shapes, listed, 'docs/benchmarks/2026-11-20-y-preregistration-addenda.md', 'docs/benchmarks/PREREGISTRATION-TEMPLATE.md', 'docs/benchmarks/2026-11-20-x/REPORT.md'].map(f => [f, 'plan']));
    const entry = { id: 'y', preregistration: listed, results: [] } as PracticeEntry;
    const p = checkPractices([entry], { ids: ['y'], unlisted_preregistrations: [] }, repo(files));
    expect(p.map(x => x.file).sort()).toEqual([...shapes].sort());
  });

  test('refuses an upper-case .MD preregistration and a copy of the template name outside its own path', () => {
    const files = ['docs/benchmarks/2026-11-20-z/PREREGISTRATION.MD', 'docs/benchmarks/2026-11-20-z-protocol.MD', 'docs/benchmarks/2026-11-20-z/preregistration-template.md'];
    const p = checkPractices([], { ids: [], unlisted_preregistrations: [] }, repo(Object.fromEntries([...files, 'docs/benchmarks/PREREGISTRATION-TEMPLATE.md'].map(f => [f, 'plan']))));
    expect(p.map(x => x.file).sort()).toEqual([...files].sort());
  });

  test('isPreregistrationFile skips the template and files outside docs', () => {
    expect(isPreregistrationFile('docs/benchmarks/PREREGISTRATION-TEMPLATE.md')).toBe(false);
    expect(isPreregistrationFile('eval/data/x-preregistration.md')).toBe(false);
    expect(isPreregistrationFile('docs/benchmarks/x-preregistration.json')).toBe(false);
  });

  test('the grandfather list names only experiments in the registry', () => {
    const root = join(import.meta.dir, '../..');
    const grandfathered = loadGrandfathered(root);
    const ids = new Set(loadManifest(root).map(e => e.id));
    for (const id of grandfathered.ids) expect(ids.has(id)).toBe(true);
  });
});

// Value: protects=the grandfather list as a closed set, so a new plan can't skip the practices check by joining it; fails_when=an id or file that did not exist when the list was first committed passes as grandfathered; seam=checkGrandfatheredFrozen over throwaway git repos, keyless; no_claim=edits that forge git history
describe('checkGrandfatheredFrozen', () => {
  function history(): { dir: string; commit: (files: Record<string, string>) => void } {
    const dir = repo({});
    const commit = (files: Record<string, string>) => {
      for (const [file, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), body);
      }
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c'], { cwd: dir });
    };
    const registry = (ids: string[]) => JSON.stringify({ experiments: ids.map(id => ({ id, preregistration: `docs/benchmarks/${id}-preregistration.md`, results: [] })) });
    commit({ 'docs/benchmarks/preregistrations.json': registry(['old-a']), 'docs/benchmarks/preregistrations.d/old-b.json': registry(['old-b']), 'docs/benchmarks/old-c-preregistration.md': 'plan' });
    commit({ [GRANDFATHERED_PATH]: '{}' });
    commit({ 'docs/benchmarks/preregistrations.d/new.json': registry(['new']), 'docs/benchmarks/new-loose-preregistration.md': 'plan' });
    return { dir, commit };
  }

  test('passes when every name existed when the list was created, and when names are removed', () => {
    const { dir } = history();
    expect(checkGrandfatheredFrozen({ ids: ['old-a', 'old-b'], unlisted_preregistrations: ['docs/benchmarks/old-c-preregistration.md'] }, dir)).toEqual([]);
    expect(checkGrandfatheredFrozen({ ids: ['old-a'], unlisted_preregistrations: [] }, dir)).toEqual([]);
  });

  test('refuses an id added to the list after it was created', () => {
    const { dir } = history();
    expect(checkGrandfatheredFrozen({ ids: ['old-a', 'new'], unlisted_preregistrations: [] }, dir)).toEqual([
      expect.objectContaining({ id: 'new', problem: expect.stringContaining("new plans can't be grandfathered") }),
    ]);
  });

  test('refuses a preregistration file added to the list after it was created', () => {
    const { dir } = history();
    expect(checkGrandfatheredFrozen({ ids: [], unlisted_preregistrations: ['docs/benchmarks/new-loose-preregistration.md'] }, dir)).toEqual([
      expect.objectContaining({ file: 'docs/benchmarks/new-loose-preregistration.md', problem: expect.stringContaining("new plans can't be grandfathered") }),
    ]);
  });

  test('a later rewrite of the list does not move the creation commit', () => {
    const { dir, commit } = history();
    commit({ [GRANDFATHERED_PATH]: '{"rewritten":true}' });
    expect(checkGrandfatheredFrozen({ ids: ['new'], unlisted_preregistrations: [] }, dir)).toHaveLength(1);
  });

  test('refuses an uncommitted list', () => {
    expect(checkGrandfatheredFrozen(none, empty)[0]!.problem).toBe('grandfather list is not committed');
  });

  test('the repository\'s list passes', () => {
    const root = join(import.meta.dir, '../..');
    expect(checkGrandfatheredFrozen(loadGrandfathered(root), root)).toEqual([]);
  });
});

describe('modelFamily', () => {
  test('reads provider-prefixed and bare ids', () => {
    expect(modelFamily('particle:particle-1')).toBe('particle');
    expect(modelFamily('openai/gpt-6.2-sol')).toBe('openai');
    expect(modelFamily('claude-opus-5-5')).toBe('anthropic');
    expect(modelFamily('gemini-4-carbon')).toBe('google');
    expect(modelFamily('unknown')).toBeNull();
  });
});

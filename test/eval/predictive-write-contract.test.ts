/**
 * G3 scoring without gbrain: the call classifier on outputs captured from gbrain 0.60.557.0, the landing ledger
 * (GBRA-395's untitled-capture ruling), the scorecard measures, and the scorer mutation kit. Pure and keyless.
 */
import { describe, expect, test } from 'bun:test';
import { assertScorerRejectsFakeSystems, type AnswerSpace } from '../../eval/runner/mutation-kit.ts';
import type { ArmCall, BrainSnapshot } from '../../eval/runner/predictive/cli-arm.ts';
import { classifyCall, landingLedger, normalizePageBody, scoreWriteEpisode, summarizeWriteEpisodes, type Ledger, type WriteEpisode } from '../../eval/runner/predictive/write-contract.ts';
import { G3_CAUSES, generateWriteTasks, PENDING_OK, writeTasksDigest, type G3Cause, type WriteTask } from '../../eval/generators/write-contract-gen.ts';

const cli = (argv: string[], output: string, exit = 1): ArmCall => ({ surface: 'cli', argv, exit, output, ms: 1 });
const mcp = (tool: string, output: string): ArmCall => ({ surface: 'mcp', argv: [tool], args: {}, exit: output.startsWith('Error:') ? 1 : 0, output, ms: 1 });

/** Refusals as gbrain 0.60.557.0 printed them on the synthetic brain (trimmed). */
const OUTPUT: Record<G3Cause, string> = {
  source_changed: '{\n  "error": "scope_denied",\n  "code": "scope_denied",\n  "message": "A committed Git change to the page\'s file has not been imported yet; neither copy was overwritten.",\n  "detail": "pending_import"\n}',
  missing_provenance: 'Error [invalid_params]: Missing required parameter: provenance\nFix: Pass provenance as a string',
  ambiguous_entity: 'Error [invalid_params]: entity "Dana Kim" matches more than one page. It could mean: people/dana-kim-fernway, people/dana-kim-orchid. Nothing was saved.',
  fact_and_items: 'Error [invalid_params]: Pass either fact or items, not both.\nFix: Move the single fact into items, or drop items.',
  scope_denied: '{\n  "error": "scope_denied",\n  "code": "scope_denied",\n  "message": "The canonical file and database disagree. Neither copy was overwritten.",\n  "detail": "file_database_drift",\n  "write_error": "source_changed"\n}\nError [source_changed]: The canonical file and database disagree.',
  commit_paths_invalid: 'Error [commit_paths_invalid]: notes/x.md is not inside a git checkout.\nFix: Run the command inside the brain checkout or pass --path <checkout>.',
  sources_without_brain: 'SOURCES\n  default  federated  2 pages',
  two_range_read: 'Line 30.\nWarning: --lines overwrites the positional value \'3-6\'.',
};
const ARGV: Record<G3Cause, string[]> = {
  source_changed: ['remember', 'x', '--entity', 'people/a'], missing_provenance: ['remember', 'x', '--entity', 'people/a'], ambiguous_entity: ['remember', 'x', '--entity', 'Dana Kim'],
  fact_and_items: ['remember', 'x', '--items', '[]'], scope_denied: ['remember', 'x', '--entity', 'people/a'], commit_paths_invalid: ['git', 'commit-push', '--path', 'notes/x.md', '-m', 'm'],
  sources_without_brain: ['sources', 'list'], two_range_read: ['get', 'notes/x', '--lines', '3-6', '--lines', '30-34'],
};

describe('classifyCall', () => {
  test('names each cause from gbrain\'s own output', () => {
    for (const c of G3_CAUSES) expect({ c, got: classifyCall(cli(ARGV[c], OUTPUT[c], c === 'sources_without_brain' || c === 'two_range_read' ? 0 : 1)).cause }).toEqual({ c, got: c });
  });
  test('MCP refusals classify the same way, and two window selectors count as a two-range read', () => {
    expect(classifyCall(mcp('remember', `Error: ${OUTPUT.ambiguous_entity}`)).cause).toBe('ambiguous_entity');
    expect(classifyCall(mcp('get_page', 'Error: {"code": "invalid_params", "message": "get_page: pass one window selector, not 2 (got lines and bytes)."}')).cause).toBe('two_range_read');
    expect(classifyCall(mcp('sources_list', '{"sources":[]}'))).toEqual({ refused: false, cause: null, code: null, family: 'sources' });
  });
  test('clean calls, --brain and help are not refusals; unknown refusals are other', () => {
    expect(classifyCall(cli(['sources', 'list', '--brain', 'host'], 'SOURCES', 0)).refused).toBe(false);
    expect(classifyCall(cli(['sources', '--help'], 'usage', 0)).refused).toBe(false);
    expect(classifyCall(cli(['remember', 'x'], 'remembered as fact #1', 0)).refused).toBe(false);
    expect(classifyCall(cli(['put', 'notes/x'], '{"error": "revision_required", "code": "revision_required"}')).cause).toBe('other');
  });
});

describe('landing ledger', () => {
  const fm = (title: string | null, body: string) => `---\ntype: note\n${title ? `title: ${title}\n` : ''}ingested_at: '2026-11-09T09:00:00Z'\n---\n\n${body}\n`;
  test('an untitled capture is one write and one page, and a derived title plus H1 is no second write', () => {
    const empty: BrainSnapshot = { pages: {}, facts: [] };
    const captured: BrainSnapshot = { pages: { 'notes/capture-1': fm(null, 'Untitled capture body line.') }, facts: [] };
    const titled: BrainSnapshot = { pages: { 'notes/capture-1': fm('Capture 1', '# Capture 1\n\nUntitled capture body line.') }, facts: [] };
    expect(landingLedger(empty, captured)).toMatchObject({ write_count: 1, pages_written: 1 });
    expect(landingLedger(empty, titled)).toMatchObject({ write_count: 1, pages_written: 1 });
    expect(landingLedger(captured, titled)).toMatchObject({ write_count: 0, pages_written: 0 });
  });
  test('a remember is one fact write; its facts fence on the page is not a page write', () => {
    const page = fm('Ana', 'Ana works at Fernway.');
    const fenced = page + '\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim |\n| 1 | Ana likes tea |\n<!--- gbrain:facts:end -->\n';
    const l = landingLedger({ pages: { 'people/ana': page }, facts: [] }, { pages: { 'people/ana': fenced }, facts: [{ id: '1', entity: 'people/ana', fact: 'Ana likes tea' }] });
    expect(l).toMatchObject({ write_count: 1, pages_written: 0 });
    expect(l.writes[0]).toMatchObject({ kind: 'fact', path: 'people/ana', id: '1' });
    expect(normalizePageBody(fenced)).toBe('Ana works at Fernway.');
  });
  test('a real body edit is a page write; an H1 that is not the title stays in the body', () => {
    const a = fm('Plan', 'Old line.');
    expect(landingLedger({ pages: { 'notes/p': a }, facts: [] }, { pages: { 'notes/p': fm('Plan', 'New line.') }, facts: [] }).write_count).toBe(1);
    expect(normalizePageBody(fm('Plan', '# Other heading\n\nText.'))).toBe('# Other heading\n\nText.');
  });
});

// ─── Mutation kit ───────────────────────────────────────────────────

interface Outcome { calls: ArmCall[]; final: Record<string, unknown> | null; ledger: Ledger }
const tasks = generateWriteTasks({ n: 16 });
const pendingOk = (t: WriteTask) => PENDING_OK.includes(t.cause);
const exposedCli = (t: WriteTask) => t.exposure.cli[t.cause] === 1;
const fact = (path: string, text: string): Ledger => ({ writes: [{ kind: 'fact', path, id: '9', text, change: 'fact' }], write_count: 1, pages_written: 0 });
const landed = (t: WriteTask, _ledger: Ledger, status = 'landed'): Outcome['final'] => ({ writes: [{ kind: t.target.kind, path: t.target.path, status }] });
const NONE: Ledger = { writes: [], write_count: 0, pages_written: 0 };
const naive = (t: WriteTask) => exposedCli(t) ? [cli(ARGV[t.cause], OUTPUT[t.cause], 1)] : [];
const targetWrite = (t: WriteTask): Ledger => t.target.kind === 'fact' ? fact(t.target.path, `Saved: ${t.target.values.join(' and ')}`) : { writes: [{ kind: 'page', path: t.target.path, text: t.target.values.join(' '), change: 'created' }], write_count: 1, pages_written: 1 };
const recovery = (t: WriteTask): ArmCall[] => t.cause === 'source_changed' ? [cli(['sync'], 'Synced', 0)] : exposedCli(t) ? [cli(t.cause === 'sources_without_brain' ? ['sources', 'list', '--brain', 'host'] : ARGV[t.cause].slice(0, 2), 'ok', 0)] : [];

const space: AnswerSpace<WriteTask, Outcome> = {
  truth: t => pendingOk(t) ? { calls: naive(t), final: landed(t, NONE, 'refused'), ledger: NONE } : { calls: [...naive(t), ...recovery(t)], final: landed(t, targetWrite(t)), ledger: targetWrite(t) },
  empty: () => ({ calls: [], final: { writes: [] }, ledger: NONE }),
  everything: t => ({ calls: naive(t), final: { writes: t.pages.map(p => ({ kind: 'fact', path: p.slug, status: 'landed' })).concat([{ kind: t.target.kind, path: t.target.path, status: 'landed' }]) }, ledger: NONE }),
  refusal: t => ({ calls: naive(t), final: landed(t, NONE, 'refused'), ledger: NONE }),
  stale: t => pendingOk(t) || t.target.kind !== 'fact' ? undefined : { calls: [...naive(t), ...recovery(t)], final: landed(t, NONE), ledger: fact(t.target.path, 'Saved the earlier value.') },
  wrongSource: t => {
    const other = t.decoys[0] ?? t.pages.find(p => p.slug !== t.target.path)!.slug;
    return { calls: [...naive(t), ...recovery(t)], final: { writes: [{ kind: 'fact', path: other, status: 'landed' }] }, ledger: fact(other, `Saved: ${t.target.values.join(' and ')}`) };
  },
};

describe('G3 scorer mutation kit', () => {
  test('the episode scorer passes the honest system and fails all five fakes', () => {
    assertScorerRejectsFakeSystems({
      category: 'G3 write contract', probes: tasks, space,
      score: answers => {
        const eps = answers.map((a, i) => scoreWriteEpisode({ task: tasks[i], surface: 'cli', model: 'm', trial: 0, calls: a.calls, final: a.final, ledger: a.ledger, usd: 0, stop: 'submitted' }));
        const bad = eps.filter(e => !e.success);
        return { pass: bad.length === 0, detail: bad.slice(0, 3).map(e => `${e.task_id}:${e.cause}`).join(',') || 'all correct' };
      },
    });
  });

  test('a write that landed on the namesake is wrong_entity even when the report claims it', () => {
    const t = tasks.find(x => x.cause === 'ambiguous_entity')!;
    const o = space.wrongSource!(t)!;
    expect(scoreWriteEpisode({ task: t, surface: 'mcp', model: 'm', trial: 0, ...o, usd: 0, stop: 'submitted' }).cause).toBe('wrong_entity');
  });
});

describe('G3 scorecard', () => {
  const ep = (over: Partial<WriteEpisode>): WriteEpisode => ({
    task_id: 't1', task_cause: 'missing_provenance', surface: 'cli', model: 'm', trial: 0, calls: 2, refusals: [], exposure: { ...Object.fromEntries(G3_CAUSES.map(c => [c, 0])), missing_provenance: 1 } as WriteEpisode['exposure'],
    target_landed: true, landed_on_decoy: false, claimed_landed: 1, reported_done_not_landed: 0, ledger: { write_count: 1, pages_written: 0 }, success: true, cause: 'correct', usd: 0.5, stop: 'submitted', ...over,
  });
  test('refusals per 100 calls, rates given exposure, recovery, never retried, pass^4 and cost per correct', () => {
    const r = (recovered: boolean, retried: boolean) => ({ cause: 'missing_provenance' as const, code: 'invalid_params', family: 'remember', call: 0, retried, recovered });
    const eps = [
      ep({ trial: 0, refusals: [r(true, true)] }), ep({ trial: 1 }), ep({ trial: 2, refusals: [r(false, false)], success: false, cause: 'write_integrity', reported_done_not_landed: 1 }), ep({ trial: 3 }),
      ep({ task_id: 't2', trial: 0 }), ep({ task_id: 't2', trial: 1 }), ep({ task_id: 't2', trial: 2 }), ep({ task_id: 't2', trial: 3 }),
    ];
    const s = summarizeWriteEpisodes(eps);
    expect(s.calls).toBe(16);
    expect(s.refusals_per_100_calls.missing_provenance).toBe(12.5);
    expect(s.by_cause.missing_provenance).toMatchObject({ exposed_episodes: 8, refused_episodes: 2, refusal_rate_given_exposure: 0.25, recovered: 1, recovery_share: 0.5, never_retried: 1 });
    expect(s.by_cause.scope_denied.refusal_rate_given_exposure).toBeNull();
    expect(s.reported_done_not_landed).toBe(1);
    expect(s.pass_hat_k).toEqual({ k: 4, value: 0.5, curve: [0.875, 0.75, 0.625, 0.5] });
    expect(s.cost_per_correct_usd).toBeCloseTo(4 / 7);
    expect(s.failure_causes).toEqual({ write_integrity: 1 });
  });
  test('one scorecard per model and surface', () => {
    expect(() => summarizeWriteEpisodes([ep({}), ep({ surface: 'mcp' })])).toThrow(/one model on one surface/);
  });
});

describe('G3 generator', () => {
  test('60 seeded tasks, eight causes, stable digest, exposures recorded per surface', () => {
    const all = generateWriteTasks();
    expect(all.length).toBe(60);
    expect(writeTasksDigest(all)).toBe(writeTasksDigest(generateWriteTasks()));
    expect(writeTasksDigest(all)).toBe('aa5989c87cdd61775317d432c1decf8dcc5be8f53bef0809eb9b1672e3ab1e09');
    expect(new Set(all.map(t => t.cause))).toEqual(new Set(G3_CAUSES));
    for (const t of all) expect(t.exposure.cli[t.cause]).toBe(1);
    expect(all.filter(t => t.exposure.mcp.commit_paths_invalid === 1 || t.exposure.mcp.sources_without_brain === 1)).toEqual([]);
  });
});

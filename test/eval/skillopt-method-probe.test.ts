/**
 * SkillOpt method A1 probe (GST-799; plan decision A, revision 3 decision A3):
 * tool coverage, the frontier gate and the counted-skills pick, the paid-run
 * refusals, and keyless end-to-end runs of F0a, F0b and the smoke on fake
 * transports and a stubbed fetch, for both frontier targets. The historical
 * Haiku gate and probe stay covered. No model call.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setEmbedTransportForTests, __setGenerateObjectTransportForTests, __setGenerateTextTransportForTests, type ChatOpts, type ChatResult } from 'gbrain/ai/gateway';
import { loadCorpora, type MethodTask } from '../../eval/generators/skillopt-method/common.ts';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { readSealedTestTasks, readSeed, readTasks } from '../../eval/runner/skillopt-method/dataset.ts';
import { forbiddenMarkers, markersIn, ONE_SHOT_SYSTEM, pagesOf, PROPOSER_MODEL, proposerInput, trainPages, WITHHELD, type TrainTrajectory } from '../../eval/runner/skillopt-method/one-shot.ts';
import {
  countedSkills, FAKE_REWRITE_MARKER, fakeReply, fakeTransport, FRONTIER_TARGET_NAMES, FRONTIER_TARGETS, frontierEstimateUsd, frontierGate, lastUserText, NO_SKILL_TEXT,
  PINNED_SEARCH_CONFIG, PROBE_EMBEDDING, PROBE_GATE, probeGate, REPRICE_TRIGGER_USD, runFrontierProbe, runProbe, runSmoke, servedTools, toolCoverage,
  type ChatTransport, type FrontierRow, type FrontierTarget, type SkillProbe,
} from '../../eval/runner/skillopt-method/probe.ts';
import { callCostUsd, emptyMeter, meterRollout, summarizeMeter } from '../../eval/runner/skillopt-method/rollouts.ts';

const REPO_ROOT = join(import.meta.dir, '../..');

describe('tool coverage', () => {
  test("lists each seed's frontmatter brain operations that the rollout does not serve, and its tools outside the brain apart", () => {
    expect(servedTools()).toEqual(expect.arrayContaining(['get_backlinks', 'get_page', 'list_pages', 'query', 'search', 'traverse_graph']));
    expect(servedTools()).not.toContain('put_page');
    expect(servedTools()).not.toContain('recall');
    expect(servedTools(readSeed('query'))).toEqual(expect.arrayContaining(['recall', 'get_timeline']));
    expect(servedTools(readSeed('query'))).not.toContain('put_page');
    expect(toolCoverage().map(c => [c.skill, c.missing, c.outside_brain, c.full])).toEqual([
      ['query', [], [], true],
      ['briefing', [], [], true],
      ['fact-check', [], ['web_search', 'web_fetch'], true],
    ]);
  });
});

describe('the preregistered gate (historical, probes 1 and 2)', () => {
  const row = (skill: SkillProbe['skill'], seed: number, kept: number, gaps: string[] = []): SkillProbe => ({ skill, ceiling: 1, no_skill: 0, seed, one_shot_repeats: [kept], one_shot_kept: kept, seed_opus: seed, tool_gaps: gaps });
  test('build when two skills have the seed in band and room below the ceiling', () => {
    const g = probeGate([row('query', 0.5, 0.6), row('briefing', 0.2, 0.85), row('fact-check', 0.9, 0.9)]);
    expect(g.verdict).toBe('build');
    expect(g.qualifying).toEqual(['query', 'briefing']);
    expect(g.reasons['fact-check']).toEqual(['seed-above-band', 'one-shot-at-ceiling']);
  });
  test('one-shot at the ceiling: harden once, then stop, and a stop on a skill with a tool gap waits for its rerun', () => {
    const rows = [row('query', 0.5, 0.95, ['recall']), row('briefing', 0.5, 0.9), row('fact-check', 0.5, 0.6)];
    expect(probeGate(rows).verdict).toBe('harden-and-reprobe');
    const after = probeGate(rows, { afterHardening: true });
    expect(after.verdict).toBe('stop');
    expect(after.waits_for_rerun).toEqual(['query']);
  });
  test('a seed outside the band with room left is out of band, and a missing arm is incomplete', () => {
    expect(probeGate([row('query', 0.1, 0.3), row('briefing', 0.95, 0.5), row('fact-check', 0.5, 0.5)]).verdict).toBe('out-of-band');
    expect(probeGate([{ ...row('query', 0.5, 0.5), seed: null }, row('briefing', 0.9, 0.9), row('fact-check', 0.5, 0.5)]).verdict).toBe('incomplete');
    expect(PROBE_GATE).toEqual({ seedLow: 0.2, seedHigh: 0.8, minRoomBelowCeiling: 0.15, minSkills: 2 });
  });
});

const fr = (skill: FrontierRow['skill'], seed: number | null, kept: number | null, gaps: string[] = []): FrontierRow => ({ skill, ceiling: 1, seed, one_shot_kept: kept, tool_gaps: gaps });

describe('the frontier gate (decision A3)', () => {
  test('build with two qualifying skills; the band is inclusive and a skipped pair carries its band reason, not incomplete', () => {
    const g = frontierGate([fr('query', 0.2, 0.6), fr('briefing', 0.8, 0.85), fr('fact-check', 0.81, null)]);
    expect(g.verdict).toBe('build');
    expect(g.qualifying).toEqual(['query', 'briefing']);
    expect(g.reasons).toEqual({ query: [], briefing: [], 'fact-check': ['seed-above-band'] });
  });
  test('build-one-skill when exactly one qualifies and the others are out of band or at the ceiling', () => {
    const g = frontierGate([fr('query', 0.5, 0.6), fr('briefing', 0.9, null), fr('fact-check', 0.1, null)]);
    expect(g.verdict).toBe('build-one-skill');
    expect(g.reasons).toEqual({ query: [], briefing: ['seed-above-band'], 'fact-check': ['seed-below-band'] });
    expect(frontierGate([fr('query', 0.5, 0.6), fr('briefing', 0.5, 0.9)]).verdict).toBe('build-one-skill');
  });
  test('stop when every in-band skill fails only on the one-shot ceiling; a stop on a skill with a tool gap waits for its rerun', () => {
    const g = frontierGate([fr('query', 0.5, 0.9, ['recall']), fr('briefing', 0.5, 1), fr('fact-check', 0.95, null)]);
    expect(g.verdict).toBe('stop');
    expect(g.reasons).toEqual({ query: ['one-shot-at-ceiling'], briefing: ['one-shot-at-ceiling'], 'fact-check': ['seed-above-band'] });
    expect(g.waits_for_rerun).toEqual(['query']);
  });
  test('out-of-band when no skill is in band, whatever one-shot did not run', () => {
    expect(frontierGate([fr('query', 0.1, null), fr('briefing', 0.95, null), fr('fact-check', 0.85, null)]).verdict).toBe('out-of-band');
  });
  test('incomplete only when a pair that should have run did not: an in-band pair without a kept one-shot, or a missing seed', () => {
    expect(frontierGate([fr('query', 0.5, null), fr('briefing', 0.5, 1), fr('fact-check', 0.9, null)]).reasons.query).toEqual(['incomplete']);
    expect(frontierGate([fr('query', 0.5, null), fr('briefing', 0.5, 1), fr('fact-check', 0.9, null)]).verdict).toBe('incomplete');
    expect(frontierGate([fr('query', null, null), fr('briefing', 0.1, null)]).verdict).toBe('incomplete');
  });
});

describe('the counted skills pick', () => {
  test('skills qualifying on both targets first, then by mean headroom over the targets where they qualify, at most two per target', () => {
    const c = countedSkills({
      opus: [fr('query', 0.5, 0.6), fr('briefing', 0.5, 0.9), fr('fact-check', 0.4, 0.7)],
      sol: [fr('query', 0.5, 0.8), fr('briefing', 0.3, 0.5), fr('fact-check', 0.9, null)],
    });
    expect(c.order).toEqual(['query', 'briefing', 'fact-check']);
    expect(c.per_target).toEqual({ opus: ['query', 'fact-check'], sol: ['query', 'briefing'] });
    expect(c.targets_read).toEqual(['opus', 'sol']);
  });
  test('one target read alone: the two with the most headroom; a target with nothing qualifying gets none', () => {
    const c = countedSkills({ sol: [fr('query', 0.5, 0.8), fr('briefing', 0.3, 0.5), fr('fact-check', 0.6, 0.7)] });
    expect(c.order).toEqual(['briefing', 'fact-check', 'query']);
    expect(c.per_target).toEqual({ sol: ['briefing', 'fact-check'] });
    expect(countedSkills({ opus: [fr('query', 0.9, null)] }).per_target).toEqual({ opus: [] });
  });
});

describe('rollout meter and estimates', () => {
  test('prices a call at list price, cache reads and writes included, and reports cached share, calls and reasoning tokens per rollout', () => {
    expect(callCostUsd({ model: 'openai:gpt-6.1-sol', input_tokens: 100_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeCloseTo(0.2, 9);
    expect(callCostUsd({ model: 'openai:gpt-6.1-sol', input_tokens: 300_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeCloseTo(1.2, 9);
    expect(callCostUsd({ model: 'anthropic:claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 500_000, cache_creation_tokens: 0 })).toBeCloseTo(2 + 0.1 + 2, 9);
    expect(callCostUsd({ model: 'nobody:unpriced', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeNull();
    const m = emptyMeter();
    meterRollout(m, [{ model: 'openai:gpt-6.1-sol', input_tokens: 1000, output_tokens: 10, cache_read_tokens: 400, cache_creation_tokens: 0, reasoning_tokens: 30 }, { model: 'openai:gpt-6.1-sol', input_tokens: 1000, output_tokens: 10, cache_read_tokens: 600, cache_creation_tokens: 0 }]);
    meterRollout(m, []);
    const s = summarizeMeter(m);
    expect({ rollouts: s.rollouts, calls_per_rollout: s.calls_per_rollout, cached_input_share: s.cached_input_share, reasoning_tokens_per_rollout: s.reasoning_tokens_per_rollout }).toEqual({ rollouts: 2, calls_per_rollout: 1, cached_input_share: 0.5, reasoning_tokens_per_rollout: 15 });
  });
  test("the stage estimates split the plan's F0a $118 and F0b $209 across both targets and three skills", () => {
    for (const [stage, total] of [['f0a', 118], ['f0b', 209]] as const) expect(FRONTIER_TARGET_NAMES.reduce((n, t) => n + frontierEstimateUsd(t, stage, 3), 0)).toBeCloseTo(total, 9);
    expect(REPRICE_TRIGGER_USD).toEqual({ opus: 0.40, sol: 0.20 });
  });
});

describe('probe runs refuse to spend', () => {
  test('a live probe or smoke without --paid --budget-run-id exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'n15-ledger-'));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/.test(k)));
      for (const args of [['--probe'], ['--probe', '--target', 'sol', '--stage', 'f0a'], ['--smoke']]) {
        const r = Bun.spawnSync(['bun', 'eval/runner/n15-skillopt-method.ts', ...args, '--budget-ledger', join(dir, 'ledger.sqlite'), '--output', dir], { cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe' });
        expect([args.join(' '), r.exitCode]).toEqual([args.join(' '), 2]);
        expect(r.stderr.toString()).toContain('--paid --budget-run-id <id>');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Keyless end-to-end ──────────────────────────────────────────────────────

interface Seen { models: string[]; proposerInputs: string[]; targetSystems: string[]; toolResults: Array<{ name: string; isError: boolean; output: unknown }>; embeds: number; generates: number; fetches: string[] }
const newSeen = (): Seen => ({ models: [], proposerInputs: [], targetSystems: [], toolResults: [], embeds: 0, generates: 0, fetches: [] });

/** Run fn with every way out of the process recorded and refused: fetch, and gbrain's embed and generate seams. */
async function sealed<T>(seen: Seen, fn: () => Promise<T>): Promise<T> {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => { seen.fetches.push(input instanceof Request ? input.url : String(input)); throw new Error('network refused in a keyless test'); }, { preconnect: () => {} }) as typeof fetch;
  __setEmbedTransportForTests((async () => { seen.embeds++; throw new Error('embed refused in a keyless test'); }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  __setGenerateTextTransportForTests((async () => { seen.generates++; throw new Error('generateText refused in a keyless test'); }) as unknown as Parameters<typeof __setGenerateTextTransportForTests>[0]);
  __setGenerateObjectTransportForTests((async () => { seen.generates++; throw new Error('generateObject refused in a keyless test'); }) as unknown as Parameters<typeof __setGenerateObjectTransportForTests>[0]);
  try {
    return await fn();
  } finally {
    globalThis.fetch = fetchBefore;
    __setEmbedTransportForTests(null);
    __setGenerateTextTransportForTests(null);
    __setGenerateObjectTransportForTests(null);
  }
}

const blocksOf = (o: ChatOpts) => o.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));

/**
 * fakeTransport, plus: on the tasks in toolTasks the target first calls
 * brain_query and brain_search with the task text and brain_get_page on
 * plantSlug, then answers as fakeTransport does; every call is recorded.
 */
function recordingTransport(seen: Seen, o: { toolTasks?: ReadonlySet<string>; plantSlug?: string; rewrite?: (call: number) => string; usage?: Partial<ChatResult['usage']> } = {}) {
  return (tasks: readonly MethodTask[]): ChatTransport => {
    const base = fakeTransport(tasks);
    let proposals = 0;
    return async opts => {
      seen.models.push(opts.model ?? '');
      if (opts.system === ONE_SHOT_SYSTEM) {
        seen.proposerInputs.push(lastUserText(opts));
        return o.rewrite ? fakeReply(opts, o.rewrite(proposals++)) : base(opts);
      }
      seen.targetSystems.push(opts.system ?? '');
      const first = opts.messages.find(m => m.role === 'user');
      const task = tasks.find(t => first && typeof first.content === 'string' && first.content.includes(t.task));
      const results = blocksOf(opts).filter(b => b.type === 'tool-result');
      if (task && o.toolTasks?.has(task.task_id) && !results.length) {
        const calls = [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'brain_query', input: { query: task.task } },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'brain_search', input: { query: task.task } },
          ...(o.plantSlug ? [{ type: 'tool-call', toolCallId: 'c3', toolName: 'brain_get_page', input: { slug: o.plantSlug } }] : []),
        ] as ChatResult['blocks'];
        return { ...fakeReply(opts, '', o.usage), text: '', blocks: calls, stopReason: 'tool_calls' } as ChatResult;
      }
      for (const r of results) if (r.type === 'tool-result') seen.toolResults.push({ name: r.toolName, isError: !!r.isError, output: r.output });
      const reply = await base({ ...opts, messages: first ? [first] : opts.messages });
      return { ...reply, usage: { ...reply.usage, ...o.usage } };
    };
  };
}

const run = <T>(name: string, fn: () => Promise<T>) => withHermeticEnv(name, fn);

describe('the frontier probe, keyless end to end', () => {
  const train = readTasks('query', 'train');
  const sel = readTasks('query', 'sel');
  const test_ = readSealedTestTasks('query');
  const selOnly = forbiddenMarkers(sel, train);
  const planted = sel.flatMap(t => t.gold.slugs).find(s => selOnly.some(m => m.kind === 'slug' && new RegExp(m.pattern, 'm').test(s)))!;
  const plantedBody = loadCorpora().pages.get(planted)!.split('\n').map(l => l.trim()).filter(l => l.length > 40 && !l.startsWith('---') && !l.includes(':')).sort((a, b) => b.length - a.length)[0]!;

  for (const target of FRONTIER_TARGET_NAMES) {
    test(`${target}: F0a then F0b on query; F0b runs only in-band pairs, reads no test file, and no gold or page text reaches the proposer`, async () => {
      const seen = newSeen();
      const scored: string[] = [];
      const { f0a, f0b } = await run(`n15-frontier-${target}`, () => sealed(seen, async () => {
        const f0a = await runFrontierProbe({ target, stage: 'f0a', fake: true });
        const from = structuredClone(f0a);
        for (const s of from.skills) if (s.skill === 'briefing') s.seed = 0.9; else if (s.skill === 'fact-check') s.seed = 0.1;
        const f0b = await runFrontierProbe({
          target, stage: 'f0b', fake: true, from: { ...from, f0b_skills: ['query'] },
          transport: recordingTransport(seen, { toolTasks: new Set(train.slice(0, 4).map(t => t.task_id)), plantSlug: planted }),
          onSkill: r => scored.push(r.skill),
        });
        return { f0a, f0b };
      }));

      expect(f0a.models).toEqual({ target: FRONTIER_TARGETS[target], proposer: null });
      expect(f0a.skills.map(s => [s.skill, s.no_skill, s.seed])).toEqual([['query', 0, 0.5], ['briefing', 0, 0.5], ['fact-check', 0, 0.5]]);
      expect(Object.values(f0a.skills[0]!.arms.seed!.per_task).every(r => r.length === 3)).toBe(true);
      expect(Object.values(f0a.skills[0]!.arms.no_skill!.per_task).every(r => r.length === 1)).toBe(true);
      expect(f0a.f0b_skills).toEqual(['query', 'briefing', 'fact-check']);
      expect(f0a.gate).toBeNull();
      expect(f0a.skills[0]!.cost).toMatchObject({ rollouts: 96, calls_per_rollout: 1, unpriced_calls: 0 });

      expect(scored).toEqual(['query']);
      expect(f0b.files_read).toEqual(['eval/data/skillopt-method-v2/query/train.jsonl', 'eval/data/skillopt-method-v2/query/sel.jsonl']);
      expect(f0b.skills.map(s => [s.skill, s.skipped ?? null])).toEqual([['query', null], ['briefing', 'seed-above-band'], ['fact-check', 'seed-below-band']]);
      const q = f0b.skills[0]!;
      expect({ seed: q.seed, repeats: q.one_shot_repeats, kept: q.one_shot_kept, train: q.arms.seed_train!.score }).toEqual({ seed: 0.5, repeats: [1, 1], kept: 1, train: 0.5 });
      expect(q.arms.one_shot!.map(a => [a.outcome, a.audit?.disqualified, a.kept])).toEqual([['scored', false, true], ['scored', false, false]]);
      expect(q.cost).toMatchObject({ rollouts: 24 + 2 * 72 });
      expect(f0b.gate).toMatchObject({ verdict: 'stop', reasons: { query: ['one-shot-at-ceiling'], briefing: ['seed-above-band'], 'fact-check': ['seed-below-band'] }, waits_for_rerun: [] });

      expect(seen.proposerInputs.length).toBe(2);
      const input = seen.proposerInputs[0]!;
      expect(seen.proposerInputs[1]).toBe(input);
      expect(q.proposer_input).toBe(input);
      expect(input).toContain(`get_page {"slug":"${WITHHELD}"}`);
      expect(input).toContain(WITHHELD);
      expect(input).not.toContain(planted);
      expect(input).not.toContain(plantedBody);
      expect(markersIn(input, selOnly)).toEqual([]);
      const testMarkers = forbiddenMarkers(test_, train);
      expect(markersIn(input, testMarkers).filter(m => m.kind === 'slug')).toEqual([]);
      const toolLines = input.split('\n').filter(l => /^- \w+ \{/.test(l)).join('\n');
      expect(toolLines).toContain(`other pages ${WITHHELD}`);
      expect(markersIn(toolLines, testMarkers)).toEqual([]);
      expect(seen.toolResults.filter(r => r.name === 'brain_get_page' && !r.isError).length).toBe(4);
      expect(seen.toolResults.some(r => r.name !== 'brain_get_page' && !r.isError && pagesOf(r.output).length > 0)).toBe(true);
      expect(JSON.stringify(seen.toolResults.filter(r => r.name === 'brain_get_page'))).toContain(plantedBody.slice(0, 30));

      expect([...new Set(seen.models)].sort()).toEqual([...new Set([FRONTIER_TARGETS[target], PROPOSER_MODEL])].sort());
      if (target === 'sol') expect(seen.models.filter(m => m === PROPOSER_MODEL).length).toBe(2);
      expect({ embeds: seen.embeds, generates: seen.generates, fetches: seen.fetches }).toEqual({ embeds: 0, generates: 0, fetches: [] });
    }, 180_000);
  }

  test('a rewrite that fails the audit is recorded and never scored', async () => {
    const seen = newSeen();
    const leak = (call: number) => call === 0
      ? `# Rewritten skill\n\n${FAKE_REWRITE_MARKER}\n\nAlways read ${planted} first.\n`
      : `# Rewritten skill\n\n${FAKE_REWRITE_MARKER}\n\nAnswer from the brain and cite the page that holds the answer.\n`;
    const r = await run('n15-frontier-audit', () => sealed(seen, async () => {
      const f0a = await runFrontierProbe({ target: 'opus', stage: 'f0a', fake: true, skills: ['query'] });
      return runFrontierProbe({ target: 'opus', stage: 'f0b', fake: true, from: f0a, transport: recordingTransport(seen, { rewrite: leak }) });
    }));
    const [bad, good] = r.skills[0]!.arms.one_shot!;
    expect(bad).toMatchObject({ outcome: 'audit-disqualified', score: null, kept: false });
    expect(bad!.audit!.flags.map(f => f.kind)).toContain('slug');
    expect(good).toMatchObject({ outcome: 'scored', score: 1, kept: true });
    expect(seen.targetSystems.some(s => s.includes(planted))).toBe(false);
    expect(r.skills[0]!.one_shot_repeats).toEqual([null, 1]);
    expect(r.skills[0]!.rewrites.length).toBe(2);
  }, 120_000);

  test('a pair over the reprice trigger stops the stage after it, keeps it and records reprice-trigger', async () => {
    const seen = newSeen();
    const kept: string[] = [];
    const r = await run('n15-frontier-reprice', () => sealed(seen, () => runFrontierProbe({
      target: 'sol', stage: 'f0a', fake: true, skills: ['query', 'briefing'], onSkill: s => kept.push(s.skill),
      transport: recordingTransport(seen, { usage: { input_tokens: 200_000, cache_read_tokens: 50_000, reasoning_tokens: 30 } as Partial<ChatResult['usage']> }),
    })));
    expect(kept).toEqual(['query']);
    expect(r.skills.map(s => [s.skill, s.seed, s.skipped ?? null])).toEqual([['query', 0.5, null], ['briefing', null, 'reprice-trigger']]);
    expect(r.reprice_trigger).toMatchObject({ reason: 'reprice-trigger', skill: 'query', target: 'sol', threshold_usd: 0.2 });
    expect(r.reprice_trigger!.mean_rollout_usd).toBeGreaterThan(0.2);
    expect(r.skills[0]!.cost).toMatchObject({ calls_per_rollout: 1, cached_input_share: 0.25, reasoning_tokens_per_rollout: 30 });
    expect(frontierGate(r.skills).reasons.briefing).toEqual(['incomplete']);
  }, 120_000);

  test('F0b refuses an F0a result of another target or a live one', async () => {
    const r = await run('n15-frontier-from', async () => {
      const f0a = await runFrontierProbe({ target: 'opus', stage: 'f0a', fake: true, skills: ['fact-check'] });
      return Promise.allSettled([
        runFrontierProbe({ target: 'sol', stage: 'f0b', fake: true, from: f0a }),
        runFrontierProbe({ target: 'opus', stage: 'f0b', fake: true, from: { ...f0a, mode: 'live' } }),
        runFrontierProbe({ target: 'opus', stage: 'f0b', fake: true }),
      ]);
    });
    expect(r.map(x => x.status === 'rejected' && String(x.reason))).toEqual([
      expect.stringContaining('it is for target opus'),
      expect.stringContaining('it is a live run'),
      expect.stringContaining('--from <F0a receipt>'),
    ]);
  }, 120_000);
});

// ─── The wire: what gbrain sends each target ─────────────────────────────────

/** A provider stand-in at the fetch level: one tool call (brain_query), then an answer. */
function providerStub(seen: Seen) {
  let n = 0;
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.fetches.push(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    seen.models.push(body.model ?? '');
    n++;
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.openai.com/v1/responses') {
      const output = n === 1
        ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'brain_query', arguments: JSON.stringify({ query: 'pipeline' }), status: 'completed' }]
        : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: "I don't know.", annotations: [] }] }];
      return json({ id: `resp_${n}`, object: 'response', created_at: 1, status: 'completed', model: body.model, output, reasoning: { effort: 'medium', summary: null }, incomplete_details: null, usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 1020 } });
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      const content = n === 1 ? [{ type: 'tool_use', id: 'toolu_1', name: 'brain_query', input: { query: 'pipeline' } }] : [{ type: 'text', text: "I don't know." }];
      return json({ id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: n === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } });
    }
    throw new Error(`unexpected request to ${url}`);
  }, { preconnect: () => {} }) as typeof fetch;
}

describe('the smoke and the wire, keyless', () => {
  test('the fake smoke runs one seed rollout per target and reports turns, tools, tokens and cost', async () => {
    const seen = newSeen();
    const r = await run('n15-smoke-fake', () => sealed(seen, async () => {
      const out = [];
      for (const target of FRONTIER_TARGET_NAMES) out.push(await runSmoke({ target, fake: true, transport: recordingTransport(seen, { toolTasks: new Set([readTasks('query', 'train')[0]!.task_id]) }) }));
      return out;
    }));
    for (const s of r) {
      expect(s).toMatchObject({ skill: 'query', tool_calls: ['query', 'search'], stop_reason: 'end', request_settings: null, files_read: ['eval/data/skillopt-method-v2/query/train.jsonl'] });
      expect(s.turns).toBeGreaterThan(0);
      expect(s.cost).toMatchObject({ rollouts: 1, calls: 2, unpriced_calls: 0 });
      expect(s.cost.usd).toBeGreaterThan(0);
    }
    expect([...new Set(seen.models)].sort()).toEqual(Object.values(FRONTIER_TARGETS).sort());
    expect({ embeds: seen.embeds, generates: seen.generates, fetches: seen.fetches }).toEqual({ embeds: 0, generates: 0, fetches: [] });
  }, 60_000);

  for (const target of FRONTIER_TARGET_NAMES) {
    test(`${target}: the live path sends only ${FRONTIER_TARGETS[target]} requests, a query tool call embeds nothing, and the settings gbrain sends are recorded`, async () => {
      const seen = newSeen();
      const r = await run(`n15-wire-${target}`, async () => {
        process.env[target === 'opus' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] = 'dummy-keyless-test';
        const before = globalThis.fetch;
        globalThis.fetch = providerStub(seen);
        __setEmbedTransportForTests((async () => { seen.embeds++; throw new Error('embed refused'); }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
        try {
          return await runSmoke({ target, fake: false });
        } finally {
          globalThis.fetch = before;
          __setEmbedTransportForTests(null);
        }
      });
      expect(r.error).toBeUndefined();
      expect(r.tool_calls).toEqual(['query']);
      expect(r.cost).toMatchObject({ rollouts: 1, calls: 2, unpriced_calls: 0 });
      expect(r.cost.cached_input_share).toBeCloseTo(target === 'sol' ? 400 / 1000 : 400 / 1400, 9);
      expect(seen.embeds).toBe(0);
      const bare = FRONTIER_TARGETS[target].split(':')[1]!;
      expect([...new Set(seen.models)]).toEqual([bare]);
      if (target === 'sol') {
        expect([...new Set(seen.fetches)]).toEqual(['https://api.openai.com/v1/responses']);
        expect(r.cost.reasoning_tokens_per_rollout).toBe(24);
        expect(r.request_settings!.map(s => ({ model: s.model, reasoning: s.sent.reasoning, max_output_tokens: s.sent.max_output_tokens, applied: s.applied_reasoning_effort }))).toEqual([{ model: bare, reasoning: null, max_output_tokens: 4096, applied: 'medium' }]);
      } else {
        expect([...new Set(seen.fetches)]).toEqual(['https://api.anthropic.com/v1/messages']);
        expect(r.request_settings!.map(s => ({ model: s.model, thinking: s.sent.thinking, max_tokens: s.sent.max_tokens }))).toEqual([{ model: bare, thinking: null, max_tokens: 32000 }]);
      }
    }, 60_000);
  }

  test('retrieval is pinned keyword only: embeddings off on the brain, the embedding model on a provider whose key is never set, expansion and reranker off', () => {
    expect(PINNED_SEARCH_CONFIG).toEqual({ 'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.expansion': 'false', embedding_disabled: 'true' });
    expect(PROBE_EMBEDDING.model.startsWith('google:')).toBe(true);
  });
});

describe('the category runner, keyless', () => {
  test('--probe --fake writes F0a, and F0b reads it with --from, writing each pair as it is scored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'n15-cli-'));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/.test(k)));
      const cli = (...args: string[]) => Bun.spawnSync(['bun', 'eval/runner/n15-skillopt-method.ts', '--probe', '--fake', '--target', 'sol', '--skills', 'query', ...args], { cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe' });
      const a = cli('--stage', 'f0a', '--output', join(dir, 'f0a'));
      expect([a.exitCode, a.stderr.toString().slice(-400)]).toEqual([0, expect.any(String)]);
      const b = cli('--stage', 'f0b', '--from', join(dir, 'f0a', 'receipt.json'), '--output', join(dir, 'f0b'));
      expect([b.exitCode, b.stderr.toString().slice(-400)]).toEqual([0, expect.any(String)]);
      const receipt = JSON.parse(readFileSync(join(dir, 'f0b', 'receipt.json'), 'utf8'));
      expect(receipt).toMatchObject({ run_status: 'completed', verdict: 'pass', resolved_config: { target: 'sol', stage: 'f0b', keys_in_process: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] } });
      expect(receipt.data.probe.skills[0]).toMatchObject({ skill: 'query', seed: 0.5, one_shot_kept: 1 });
      expect(receipt.data.probe.skills[0].rewrites).toBeUndefined();
      expect(receipt.data.counted_skills).toEqual({ order: [], per_target: { sol: [] }, targets_read: ['sol'] });
      expect(existsSync(join(dir, 'f0b', 'probe-partial.json'))).toBe(true);
      expect(readdirSync(join(dir, 'f0b', 'one-shot')).sort()).toEqual(['sol-query-input.md', 'sol-query-rewrite-1.md', 'sol-query-rewrite-2.md']);
      const wrong = cli('--stage', 'f0b', '--from', join(dir, 'f0b', 'receipt.json'), '--output', join(dir, 'bad'));
      expect(wrong.exitCode).toBe(3);
      expect(wrong.stdout.toString()).toContain('it is stage f0b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('the historical probe (Haiku 5.5, probes 1 and 2)', () => {
  test('the fake probe runs end to end through runSkillOpt and scoreSkillOnTasks and reads no test file', async () => {
    const r = await withHermeticEnv('n15-probe-test', async () => runProbe({ fake: true, skills: ['query'] }));
    expect(r.mode).toBe('fake');
    expect(r.historical).toContain('historical');
    expect(r.files_read).toEqual(['eval/data/skillopt-method-v2/query/train.jsonl', 'eval/data/skillopt-method-v2/query/sel.jsonl']);
    const q = r.skills[0]!;
    expect({ no_skill: q.no_skill, seed: q.seed, repeats: q.one_shot_repeats, kept: q.one_shot_kept, seed_opus: q.seed_opus, ceiling: q.ceiling }).toEqual({ no_skill: 0, seed: 0.5, repeats: [1, 1], kept: 1, seed_opus: 0.5, ceiling: 1 });
    expect(Object.keys(q.arms.seed.per_task).length).toBe(24);
    expect(Object.values(q.arms.seed.per_task).every(runs => runs.length === 3)).toBe(true);
    expect(Object.values(q.arms.seed_opus.per_task).every(runs => runs.length === 1)).toBe(true);
    expect(q.arms.one_shot.filter(a => a.kept).length).toBe(1);
    expect(q.rewrites.every(t => !t.includes(NO_SKILL_TEXT))).toBe(true);
    expect(r.gate.verdict).toBe('harden-and-reprobe');
  }, 120_000);
});

describe('proposer input', () => {
  test('tool outputs render as slug and title only, naming only pages the train split shows, and a planted selection gold page is withheld wherever it appears', () => {
    const train = readTasks('query', 'train');
    const sel = readTasks('query', 'sel');
    const markers = forbiddenMarkers(sel, train);
    const gold = sel.find(t => t.answerable && t.gold.values.length && markers.some(m => m.kind === 'slug' && new RegExp(m.pattern, 'm').test(t.gold.slugs[0]!)))!;
    const slug = gold.gold.slugs[0]!;
    const value = gold.gold.values[0]!;
    const body = `The answer is ${value.kind === 'number' ? value.value : value.value}.`;
    expect(pagesOf({ results: [{ slug, title: 'Planted', compiled_truth: body, score: 0.9 }] })).toEqual([{ slug, title: 'Planted' }]);
    const trajectories: TrainTrajectory[] = [{
      task_id: train[0]!.task_id, task: train[0]!.task, answer: `See ${slug}.`, correct: false, failed: ['citation (cite the page that holds the answer)'],
      tool_calls: [
        { name: 'get_page', input: { slug }, failed: false, pages: pagesOf({ slug, title: slug, compiled_truth: body }) },
        { name: 'search', input: { query: 'x' }, failed: false, pages: pagesOf({ results: [{ slug: train[0]!.gold.slugs[0], title: 'Own gold', chunk_text: body }, { slug, title: 'Planted' }] }) },
      ],
    }];
    const { text, withheld } = proposerInput({ seedText: 'seed', criteria: 'criteria', trajectories, markers, pages: { visible: trainPages(train), corpus: new Set(loadCorpora().pages.keys()) } });
    expect(withheld).toBeGreaterThanOrEqual(2);
    expect(text).toContain(`get_page {"slug":"${WITHHELD}"} returned 1 other page ${WITHHELD}`);
    expect(text).toContain(`returned ${train[0]!.gold.slugs[0]} (Own gold), 1 other page ${WITHHELD}`);
    expect(text).not.toContain('Planted');
    expect(text).not.toContain(slug);
    expect(text).not.toContain(body);
    expect(markersIn(text, markers)).toEqual([]);
  });
});

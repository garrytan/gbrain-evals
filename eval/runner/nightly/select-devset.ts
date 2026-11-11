/**
 * Builds the nightly development set from committed public results, deterministically.
 *
 *   bun eval/runner/nightly/select-devset.ts [--check]
 *
 * The set is chosen for headroom: items that frontier readers on gbrain got wrong in the latest committed run of each
 * source, plus a few they got right, kept as canaries that flag a regression on work gbrain already does. Each suite
 * records where its items came from, so the set can be rebuilt and audited. --check rebuilds in memory and fails when
 * the committed file differs.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { canonicalDigest, DEVSET_FIX, DEVSET_PATH, type DevSet, type Suite } from './devset.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const BENCH = join(ROOT, 'docs/benchmarks');
const READERS = ['claude-opus-5-5', 'gpt-6.1-sol'] as const;

const jsonl = (path: string): any[] => {
  const raw = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
};

function cat40(): Suite {
  const source = '2026-10-10-model-ladder-hard-confirmation/main-cells/results.jsonl';
  const cells = jsonl(join(BENCH, source)).filter(c => c.arm === 'gbrain-hard' && READERS.includes(c.model));
  const tasks = [...new Set(cells.map(c => c.task as string))].sort();
  const failed = tasks.filter(t => cells.some(c => c.task === t && !c.score.success));
  const canaries = ['H2', 'H3', 'H4', 'H5'].map(f => tasks.find(t => t.startsWith(`${f}-`) && !failed.includes(t))!).filter(Boolean);
  return {
    id: 'cat40-hard-m', kind: 'agent', scoring: 'deterministic',
    about: 'Cat 40 Hard world M (public seed 20261021, 50k documents): company questions an agent answers through gbrain MCP',
    source: `docs/benchmarks/${source} (gbrain-hard arm)`,
    items: [...failed.map(id => ({ id, role: 'headroom' as const })), ...canaries.map(id => ({ id, role: 'canary' as const }))],
  };
}

const BARRIER = '773a29eede3b3ea91e0e2cba4012078b5d42c602';
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));

const NAMED_REPLAY_NOTE = 'Scored so that a write replayed under the request id a refusal names counts as a retry under the same id, never as a reissue (refresh-barrier preregistration, Amendment 7). Nights scored before that rule have another digest, so their pass rates are not compared with these.';

function refreshBarrier(): Suite {
  return {
    id: 'refresh-barrier-agents', kind: 'agent', scoring: 'deterministic',
    about: 'Save four facts while a refresh holds the first write (barrier on, as production runs it), then report; scored from the brain, Git and the tool log',
    source: 'eval/runner/refresh-barrier/agent.ts task generator, ids 1001-1030 (outside the counted 1-60)',
    config: { arm: 'on' }, requires: { gbrain_commit: BARRIER },
    items: range(1001, 30).map(id => ({ id, role: 'headroom' as const })),
    note: NAMED_REPLAY_NOTE,
  };
}

function refusedWrite(): Suite {
  return {
    id: 'refused-write-agents', kind: 'agent', scoring: 'deterministic',
    about: 'The same task with the barrier off, so the first write is refused worktree_refreshing: does the agent recover from the refusal gbrain hands it',
    source: 'eval/runner/refresh-barrier/agent.ts task generator, ids 2001-2030 (outside the counted 1-60)',
    config: { arm: 'off' },
    items: range(2001, 30).map(id => ({ id, role: 'headroom' as const })),
    note: NAMED_REPLAY_NOTE,
  };
}

function concurrencyTrials(): Suite {
  return {
    id: 'concurrent-writers', kind: 'trials', scoring: 'deterministic',
    about: 'Seeded keyless trials where several writers race refreshes, crashes, writer kills and imports; every write is checked against the database, the client and Git',
    source: 'eval/runner/refresh-barrier/run.ts --block trials --dry, seeds 5001-5100 (outside the counted 1001-1500)',
    config: { arm: 'on', engines: ['pglite', 'postgres'] }, requires: { gbrain_commit: BARRIER },
    items: range(5001, 100).map(id => ({ id, role: 'headroom' as const })),
  };
}

function systemSmokes(): Suite {
  const smokes: Array<[string, string]> = [
    ['upgrade-from-previous', 'seeded brain written by the previous night\'s master, upgraded to tonight\'s; pages, writes, search, serve /health and /admin from an installed build. '
      + 'Fails at v0.60.553.0 over v0.60.552.0 (admin_bundle_missing), passes at v0.60.554.0 over v0.60.553.0. Its schema v265 pair counts as validated by its failure code: '
      + 'v0.60.465.0 over v0.60.390.0 fails with upgrade_migrations_failed, v0.60.466.0 over v0.60.390.0 passes the upgrade phase and then fails only on the separate /admin bug, '
      + 'and v0.60.554.0 over v0.60.390.0 passes'],
    ['upgrade-from-old', 'seeded brain written by the old release v0.52.2.0 (the last release before managed persistence), upgraded with post-upgrade and the claim and activate runbook; '
      + 'a commit made after the upgrade becomes searchable while legacy pages wait (fails at v0.60.338.0 with legacy_sweep_blocks_commit; v0.60.339.0 passes that check and fails '
      + 'only the next) and a Git edit to a legacy page imports with no file_drift hold (fails at v0.60.370.0 with legacy_edit_held_file_drift, passes at v0.60.371.0)'],
    ['ingest-retry-across-upgrade', 'a POST /ingest capture accepted before the upgrade and retried after it never writes the old body over a newer edit. '
      + 'Fails at v0.60.609.0 over v0.60.608.0 (retry_overwrote_newer_edit), passes at v0.60.610.0 over v0.60.608.0'],
    ['managed-sync', 'managed sync against a bare remote: hub index.md files with their own slug lines stay unheld (fail at v0.60.337.0 and v0.60.400.0 with hub_index_held, '
      + 'pass at v0.60.401.0), and a page delete whose first push is refused still reaches the remote (fails at v0.60.317.0 with delete_not_pushed, passes at v0.60.318.0)'],
    ['source-pinned-sync', 'a source rooted at its repository root under a source-root pin syncs without revision_conflict. '
      + 'Fails at v0.60.247.0 (checkpoint_revision_conflict), passes at v0.60.248.0'],
    ['postgres-15', 'managed sync and eight concurrent writes on Postgres 15 beside the current Postgres. '
      + 'Fails at v0.60.325.0 (sync_checkpoint_failed, on Postgres 15 only), passes at v0.60.326.0'],
    ['query-contract', 'query --limit N with no budget returns N rows on a brain whose pages carry Facts fences. '
      + 'Fails at v0.60.491.0 and v0.60.554.0 (query_limit_not_honored), passes at v0.60.555.0'],
  ];
  return {
    id: 'system-smokes', kind: 'smoke', scoring: 'deterministic',
    about: 'Keyless smokes on a seeded synthetic brain that need a cross-version upgrade, a seeded brain or a real Postgres version: the surfaces where gbrain master broke in the 30 days before 2026-11-09',
    source: 'eval/runner/nightly/smokes/ (built with the runner)',
    items: smokes.map(([id]) => ({ id, role: 'headroom' as const })),
    note: [...smokes.map(([id, what]) => `${id}: ${what}`), 'dropped before the freeze: large-page-write-latency (writes to a page over 4 MiB while its search '
      + 'index builds), which on a Ubicloud VM passed at break releases between v0.60.331.0 and v0.60.335.0, before and after one respecification'].join('; '),
  };
}

/**
 * The QA reader's output limit (memory-qa --qa-max-tokens): 8,192 tokens, what the BEAM file-agent rows (Q1 and F6's
 * grep agent, systems/file-agent.ts on cat40/loop.ts) send Claude on every turn. memory-qa's 1,024-token default cut most of Opus's BEAM answers, because
 * Claude's adaptive thinking shares the limit; at 4,096 no Opus, Sonnet or GPT-6.1 Sol answer on BEAM-1M dev reached it
 * (docs/benchmarks/2026-10-12-beam-1m-s1-fixes.md). particle-1 keeps its 16,000-token floor.
 */
const QA_MAX_TOKENS = 8192;

function lme(): Suite {
  const dir = '2026-10-07-longmemeval-w10b-reader-replay/arms';
  const arms = ['w10b-opus55-notes', 'w10b-sol-notes'].map(a => jsonl(join(BENCH, dir, a, 'rows.ndjson')));
  const ids = arms[0].map(r => r.question_id as string).sort();
  const wrong = new Set(arms.flatMap(rows => rows.filter(r => !r.correct_official).map(r => r.question_id as string)));
  const failed = ids.filter(id => wrong.has(id));
  const right = ids.filter(id => !wrong.has(id));
  const canaries = Array.from({ length: 10 }, (_, i) => right[Math.floor((i * right.length) / 10)]);
  return {
    id: 'lme-s-hard', kind: 'qa', scoring: 'judge',
    about: 'LongMemEval-S questions a frontier reader on gbrain retrieval got wrong, plus spread-out canaries',
    source: `docs/benchmarks/${dir}/{w10b-opus55-notes,w10b-sol-notes}/rows.ndjson (official judge)`,
    config: { benchmark: 'lme-s', split: 'dev', qa_max_tokens: QA_MAX_TOKENS },
    items: [...failed.map(id => ({ id, role: 'headroom' as const })), ...canaries.map(id => ({ id, role: 'canary' as const }))],
  };
}

function beam(): Suite {
  const dir = join(BENCH, '2026-10-08-beam-1m-failure-analysis/arms');
  const rows = ['a2-top5-opus55', 'a2-top5-gpt61sol'].flatMap(arm =>
    readdirSync(join(dir, arm)).sort().filter(s => s.startsWith('shard-')).flatMap(s => jsonl(join(dir, arm, s, 'rows.ndjson.gz'))));
  const misses = new Map<string, number>();
  for (const r of rows) misses.set(r.conversation, (misses.get(r.conversation) ?? 0) + (Number(r.qa_score) < 1 ? 1 : 0));
  const convs = [...misses.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([c]) => c).sort();
  const ids = [...new Set(rows.filter(r => convs.includes(r.conversation)).map(r => r.id as string))].sort();
  const wrong = new Set(rows.filter(r => Number(r.qa_score) < 1).map(r => r.id as string));
  return {
    id: 'beam-1m-hard', kind: 'qa', scoring: 'judge',
    about: 'Every question of the three public BEAM-1M dev conversations where frontier readers on gbrain missed most rubric items',
    source: 'docs/benchmarks/2026-10-08-beam-1m-failure-analysis/arms/{a2-top5-opus55,a2-top5-gpt61sol}',
    config: { benchmark: 'beam-1m', split: 'dev', conversations: convs, qa_max_tokens: QA_MAX_TOKENS },
    items: ids.map(id => ({ id, role: wrong.has(id) ? 'headroom' as const : 'canary' as const })),
  };
}

function toolContract(): Suite {
  const dir = 'docs/benchmarks/2026-11-01-skillopt-method/probe/frontier';
  const skills = ['query', 'briefing', 'fact-check'];
  const families = [['sol', 'f0b-sol'], ['opus', 'f0b-opus']] as const;
  for (const [who, run] of families) for (const s of skills) readFileSync(join(ROOT, dir, run, 'one-shot', `${who}-${s}-input.txt`));
  return {
    id: 'tool-contract-replay', kind: 'replay', scoring: 'deterministic',
    about: "Each model family's recorded natural tool calls (Sol's get_page with two or three selectors, traverse_graph and get_backlinks among them) replayed keyless through gbrain's rollout, write-capture and MCP paths",
    source: `${dir}/{f0b-sol,f0b-opus}/one-shot/<family>-<skill>-input.txt`,
    items: families.flatMap(([who]) => skills.map(s => ({ id: `${who}-${s}`, role: 'headroom' as const }))),
  };
}

export function buildDevSet(): DevSet {
  const suites = [cat40(), refreshBarrier(), refusedWrite(), concurrencyTrials(), systemSmokes(), lme(), beam(), toolContract()];
  const body = { version: 1, readers: [...READERS], k: { agent: 3, qa: 1, replay: 1, trials: 1, smoke: 1 }, suites,
    reserved: [
      'paired exact and paraphrase forms on the same gold page (gap-map generator), after it passes the live-recall check',
      'per-family tool-call shape fuzzer (gap-map generator), after the same check',
      'tasks mined from real misses',
    ] };
  return { ...body, digest: canonicalDigest(body) };
}

if (import.meta.main) {
  const set = buildDevSet();
  const text = JSON.stringify(set, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const committed = readFileSync(join(ROOT, DEVSET_PATH), 'utf8');
    if (committed !== text) {
      const old = JSON.parse(committed) as DevSet;
      const drifted = set.suites.find(s => JSON.stringify(s) !== JSON.stringify(old.suites?.find(o => o.id === s.id)))?.id ?? 'top-level fields';
      console.error(`DEVSET_DRIFT: committed dev set differs from a rebuild, first in ${drifted}; ${DEVSET_FIX}`);
      process.exit(1);
    }
    console.log(`devset v${set.version} ${set.digest.slice(0, 12)} matches`);
  } else {
    writeFileSync(join(ROOT, DEVSET_PATH), text);
    for (const s of set.suites) console.log(`${s.id}: ${s.items.length} items (${s.items.filter(i => i.role === 'headroom').length} headroom)`);
    console.log(`digest ${set.digest}`);
  }
}

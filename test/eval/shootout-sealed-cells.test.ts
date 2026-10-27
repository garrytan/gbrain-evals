/**
 * Phase 7 custodian sealed batch (docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/cells/sealed.json, amendment A5), keyless:
 * the draft cells load in the cell schema and run memory-qa on the sealed splits under the sealed profile; the BEAM
 * selection leaves out the P4 core gate's reserved questions; and two real cell commands (a vendor shim cell against
 * the fake shim, and gbrain-shootout at the pin with hash vectors) run end to end through `runRemote` in sealed mode,
 * behind the real metering proxy pointed at a keyless stand-in provider. Only the allowlisted per-arm aggregates, the
 * custody access log and the lease summary leave the custody root; the proxy's usage log (whose keys name sealed
 * questions) and every row, context and answer stay inside it. The end-to-end tests need the pinned LoCoMo file
 * (`bun run eval:decide fetch`) and skip without it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { loadCampaign, runRemote, type CellSpec } from '../../eval/runner/shootout-cell.ts';
import { DATASET_ROOT, LOCOMO_FILE, loadCorpus } from '../../eval/runner/memory-qa/corpus.ts';
import { loadSplit } from '../../eval/runner/decisions/splits.ts';
import { loadArms } from '../../eval/runner/memory-qa/arms.ts';
import { exportAggregates } from '../../eval/runner/memory-qa/sealed-profile.ts';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DRAFT = join(ROOT, 'docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/cells/sealed.json');
const MANIFESTS = join(ROOT, 'docs/benchmarks/2026-10-06-oss-memory-shootout/manifests');
const tmp = mkdtempSync(join(tmpdir(), 'sealed-cells-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const RESERVED = ['preference_following', 'instruction_following'];

const cells = (): CellSpec[] => {
  const c = JSON.parse(readFileSync(join(MANIFESTS, 'campaign.json'), 'utf8'));
  writeFileSync(join(tmp, 'campaign.json'), JSON.stringify({ ...c, campaign_id: 'phase7-draft-check', cells_from: [DRAFT] }));
  return loadCampaign(join(tmp, 'campaign.json')).manifest.cells;
};

describe('Phase 7 cells (amendment A5)', () => {
  test('one sealed cell per system and benchmark, each running memory-qa on the sealed split under the sealed profile', () => {
    const all = cells();
    expect(all.map(c => c.id).sort()).toEqual(['extract-first', 'gbrain-shootout', 'gbrain-shootout-master', 'graph-pipeline', 'markdown-notes', 'memory-bank', 'temporal-graph']
      .flatMap(s => [`${s}-common-beam-100k-sealed`, `${s}-common-locomo-sealed`]).sort());
    for (const c of all) {
      expect([c.sealed, c.config]).toEqual([true, 'common']);
      for (const part of ['C="${SHOOTOUT_CUSTODY:?', `--benchmark ${c.benchmark} --split sealed`, '--decision-id oss-memory-shootout-p7-sealed', '--sealed-profile "$C"', 'GBRAIN_EVALS_CUSTODY_LOG="$C/access.ndjson"',
        '--output "$C/mqa" > "$C/memory-qa.log" 2>&1', 'sealed-profile.ts export-cell --cell "$C/mqa" --out "$SHOOTOUT_OUT/sealed"']) expect(c.command).toContain(part);
      const arms = c.command.match(/--arms (\S+)/)![1];
      expect(arms).toBe(`docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/arms/four-arms-${c.benchmark}.json`);
      loadArms(join(ROOT, arms));
      expect(c.lease_usd).toBeGreaterThan(0);
      for (const m of c.command.matchAll(/up --system (\S+)/g)) expect(existsSync(join(ROOT, 'eval/systems', m[1], 'docker-compose.yml'))).toBe(true);
    }
    expect(all.find(c => c.id === 'gbrain-shootout-master-common-locomo-sealed')!.command).toContain('--gbrain "$HOME/gbrain-master@c5fb0201d1960a0a5a81c35d77718311b03154b7"');
    expect(all.find(c => c.id === 'gbrain-shootout-common-locomo-sealed')!.command).not.toContain('--gbrain');
    expect(all.filter(c => c.system === 'extract-first').every(c => c.command.includes('--finish-timeout-s 14400'))).toBe(true);
  });

  test('BEAM-100K cells select every category but the P4 core gate\'s reserved two', () => {
    const beam = cells().filter(c => c.benchmark === 'beam-100k');
    for (const c of beam) {
      const cats = c.command.match(/--categories (\S+)/)![1].split(',');
      expect(cats).toHaveLength(8);
      expect(cats.filter(x => RESERVED.includes(x))).toEqual([]);
    }
    expect(loadSplit('beam-100k').sealed).toHaveLength(14);
    expect(cells().filter(c => c.benchmark === 'locomo').every(c => !c.command.includes('--categories'))).toBe(true);
  });

  test('every lease names its basis; A5 adds the cells to the campaign; every vendor cell waits up to four hours for /finish', () => {
    const file = JSON.parse(readFileSync(DRAFT, 'utf8')) as { cells: Array<{ lease_basis: string; lease_usd: number; command: string }> };
    expect(file.cells.every(c => c.lease_basis.startsWith('1.5 x estimate'))).toBe(true);
    expect(file.cells.reduce((s, c) => s + c.lease_usd, 0)).toBe(299);
    expect(file.cells.filter(c => c.command.includes('http://127.0.0.1:8700')).every(c => c.command.includes('--finish-timeout-s 14400'))).toBe(true);
    expect(JSON.parse(readFileSync(join(MANIFESTS, 'campaign.json'), 'utf8')).cells_from).toContain('cells/sealed.json');
  });
});

const haveLocomo = existsSync(join(DATASET_ROOT, LOCOMO_FILE.path));
const haveBeam = existsSync(join(DATASET_ROOT, 'beam'));

describe.skipIf(!haveBeam)('BEAM-100K sealed selection', () => {
  test('14 conversations, 224 questions once the 56 reserved ones are left out', () => {
    const cats = cells().find(c => c.id === 'temporal-graph-common-beam-100k-sealed')!.command.match(/--categories (\S+)/)![1].split(',');
    const sealed = new Set(loadSplit('beam-100k').sealed);
    const qs = loadCorpus('beam-100k').questions.filter(q => sealed.has(q.conversation));
    expect([qs.length, qs.filter(q => cats.includes(q.category)).length, qs.filter(q => RESERVED.includes(q.category)).length]).toEqual([280, 224, 56]);
  });
});

/** A keyless provider behind the real metering proxy: chat completions with usage, embeddings, Voyage rerank. */
function standIn() {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => ({})) as { model?: string; documents?: string[]; input?: string | string[] };
    seen.push(path);
    if (path.endsWith('/chat/completions')) return Response.json({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'yes' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } });
    if (path.endsWith('/rerank')) return Response.json({ object: 'list', model: body.model, data: (body.documents ?? []).map((_, i) => ({ index: i, relevance_score: 1 - i / 100 })), usage: { total_tokens: 10 } });
    return Response.json({ error: { message: `no route ${path}` } }, { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

const files = (dir: string): string[] => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)).map(x => join(f, x)) : [f]).sort();

async function runSealed(cellId: string, transform: (cmd: string) => string, lease: string) {
  const cell = cells().find(c => c.id === cellId)!;
  const provider = standIn();
  const out = join(tmp, lease, 'out'), custodyBase = join(tmp, lease, 'custody');
  const port = await freePort(0);
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'placeholder-real-key';
  let code: number;
  try { code = await runRemote({ lease_id: lease, lease_usd: 3, out, command: transform(cell.command), sealed: true }, { port, upstream: { openai: provider.url, voyage: provider.url }, custodyBase }); }
  finally { provider.stop(); if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev; closeLedgers(); }
  return { code, out, custody: join(custodyBase, lease), seen: provider.seen };
}

/** Everything sealed that must never leave: question ids and texts, answers, conversation ids, session dates. */
function sealedMarkers(): string[] {
  const corpus = loadCorpus('locomo');
  const sealed = new Set(loadSplit('locomo').sealed);
  const qs = corpus.questions.filter(q => sealed.has(q.conversation));
  return [...new Set([...sealed, ...qs.map(q => q.id), ...qs.map(q => q.question.slice(0, 40)), ...qs.map(q => String(q.answer ?? '')).filter(a => a.length >= 12)])];
}

function assertOnlyAggregatesLeft(out: string, custody: string) {
  const left = files(out);
  expect(left).toEqual(['custody-access.ndjson', 'lease-summary.json', ...readdirSync(join(out, 'sealed')).map(f => `sealed/${f}`)].sort());
  expect(readdirSync(join(out, 'sealed'))).toHaveLength(4);
  for (const f of readdirSync(join(out, 'sealed'))) {
    const v = JSON.parse(readFileSync(join(out, 'sealed', f), 'utf8'));
    expect(exportAggregates(v)).toEqual(v);
    expect(v).toMatchObject({ kind: 'memory-qa-arm', split: 'sealed', benchmark: 'locomo' });
  }
  const text = left.map(f => readFileSync(join(out, f), 'utf8')).join('\n');
  const leaked = sealedMarkers().filter(m => text.includes(m));
  expect(leaked).toEqual([]);
  const access = readFileSync(join(out, 'custody-access.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(access.map(a => Object.keys(a).sort())).toEqual([['action', 'at', 'decision_id', 'host', 'labels_sha256', 'operator', 'purpose', 'run_sha256']]);
  expect(existsSync(join(custody, 'proxy', 'usage.ndjson')) && existsSync(join(custody, 'proxy', 'lease.sqlite'))).toBe(true);
  expect(existsSync(join(custody, 'mqa', 'contexts.ndjson')) && existsSync(join(custody, 'memory-qa.log'))).toBe(true);
  expect(relative(ROOT, custody).startsWith('..')).toBe(true);
  return access;
}

describe('sealed mode in runRemote', () => {
  test('a sealed cell command refuses to run without its custody root', async () => {
    const out = join(tmp, 'unsealed', 'out');
    const code = await runRemote({ lease_id: 'unsealed-lease', lease_usd: 0.1, out, command: cells()[0].command }, { port: await freePort(0) });
    closeLedgers();
    expect(code).not.toBe(0);
    expect(existsSync(join(out, 'sealed'))).toBe(false);
  }, 60_000);
});

describe.skipIf(!haveLocomo)('sealed cells end to end through runRemote (keyless)', () => {
  test('a vendor shim cell against the fake shim: rows, contexts, answers and proxy traces stay in custody; per-arm aggregates leave', async () => {
    const shim = serveProtocol(new FakeMemorySystem(), { config: 'common' });
    let r;
    try {
      r = await runSealed('extract-first-common-locomo-sealed', cmd => cmd.replace(/EXTRACT_FIRST_CHUNK_TURNS=1 bash eval\/systems\/bootstrap\.sh up [^&]*&&/, 'true &&').replace('bash eval/systems/bootstrap.sh down --system extract-first', 'true')
        .replace('http://127.0.0.1:8700', shim.url).replace('--split sealed', '--split sealed --limit 24'), 'sealed-shim-lease');
    } finally { shim.stop(); }
    expect(r.code, readFileSync(join(r.custody, 'memory-qa.log'), 'utf8').slice(-2000)).toBe(0);
    const access = assertOnlyAggregatesLeft(r.out, r.custody);
    expect(access[0]).toMatchObject({ action: 'open', decision_id: 'oss-memory-shootout-p7-sealed' });
    const summary = JSON.parse(readFileSync(join(r.out, 'lease-summary.json'), 'utf8'));
    expect(summary.committed_usd).toBeGreaterThan(0);
    expect(r.seen.every(p => p === '/v1/chat/completions')).toBe(true);
    const arm = JSON.parse(readFileSync(join(r.out, 'sealed', 'fixed-evidence.native.b8000.main.json'), 'utf8'));
    expect(arm).toMatchObject({ run_status: 'complete', 'selection.questions_expected': 24, 'outcomes.scored': 24, 'summary.qa_score': 1 });
  }, 300_000);

  test('gbrain-shootout at the pin with hash vectors: the reranker runs through the proxy, and the same boundary holds', async () => {
    const r = await runSealed('gbrain-shootout-common-locomo-sealed', cmd => cmd.replace('--embed real', '--embed hash').replace('--split sealed', '--split sealed --limit 24'), 'sealed-gbrain-lease');
    expect(r.code, readFileSync(join(r.custody, 'memory-qa.log'), 'utf8').slice(-2000)).toBe(0);
    assertOnlyAggregatesLeft(r.out, r.custody);
    expect(r.seen.some(p => p === '/v1/rerank')).toBe(true);
    expect(readFileSync(join(r.custody, 'proxy', 'usage.ndjson'), 'utf8')).toContain('"key":"q:conv-');
    const arm = JSON.parse(readFileSync(join(r.out, 'sealed', 'vendor-default.native.bnone.main.json'), 'utf8'));
    expect(arm).toMatchObject({ run_status: 'complete', 'system.name': 'gbrain-shootout', 'outcomes.scored': 24 });
  }, 600_000);
});

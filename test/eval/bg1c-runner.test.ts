/**
 * BG1-C's runner wiring (harness item 5, eval/runner/q1/cell.ts, reread-cell.ts, eval/runner/bg1/launch.ts and
 * shootout-cell.ts): `--manifest bg1c` finds BG1-C's cells, a counted launch unit is its slice of BG1-C's kept list, no
 * answer gets the canonical Gemini view and no run reads a Gemini key, a BG1-C campaign plans, launches and pushes
 * custody from BG1-C's own manifest and variables, a counted cell's particle-1 re-read runs by half under its plan's id,
 * and gpt-6.2-sol has a tokenizer and a window entry. End to end, keyless: the three smoke cells on bg1-dev-01 run
 * through cell.ts and the real lease proxy in front of a scripted loopback upstream, particle-1 re-reads them the same
 * way, and `verdict.ts pilot --set BG1-C` reads the receipts. Every key is blank, the system is the in-memory fake, the
 * dev worlds are the committed template fixtures and the counted worlds are those fixtures under BG1-C ids, so no
 * sealed byte is used.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { DEV_WORLD_END } from '../../eval/runner/bg1/dev-loop.ts';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { BG1C_DATASET, bg1WorldId } from '../../eval/runner/memory-qa/bg1-names.ts';
import { BG1_FIXTURES_ROOT, BG1C_SET, bg1Conversation, loadBg1Dev, type Bg1Manifest, type Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { readRecords, sha256 } from '../../eval/runner/memory-qa/records.ts';
import { DEFAULT_ROUTE_CAPS, keylessKeys, keylessUpstream, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { bg1CampaignManifest, bg1CellWindow, bg1KeptUnit, campaignCells, findCell, loadCellManifest, requiredJudges, runCell } from '../../eval/runner/q1/cell.ts';
import { pinnedJudgeRouteCaps, type ArmDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { prepareReread, rereadArm, rereadCellId, runReread } from '../../eval/runner/q1/reread-cell.ts';
import { DATASET_PINS } from '../../eval/runner/q1/reuse-check.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { bg1CustodyPush, Campaign, DEFAULT_ROUTE_CLASSES, runRemote, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';
import { READER_WINDOWS } from '../../eval/runner/systems/baselines.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';
import { readerTokenizer } from '../../eval/runner/systems/render-v2.ts';

const REPO = resolve(import.meta.dir, '../..');
const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.2-sol', ASTRA = 'openai:gpt-6-astra', PARTICLE = 'particle:particle-1';
const tmp = mkdtempSync(join(tmpdir(), 'bg1c-runner-'));
let n = 0;
const scratch = (name: string) => { const d = join(tmp, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });
let saved: NodeJS.ProcessEnv = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });

const m = loadCellManifest('bg1c') as ReturnType<typeof loadCellManifest> & { reread_plans: Array<{ id: string; arm_cell_id: string; half: number | null }> };
const smoke = m.smoke_cells;
const counted = findCell('bg1c.gbrain-defaults.rs1-stable', undefined, 'bg1c');
const NO_META = { finish: 'stop', usage: null, response_model: null, attempt_errors: [] as string[] };
const quiet = { probeIntervalMs: 5, probeTimeoutMs: 2000 };
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } throw new Error('expected a refusal'); };
const refused = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
const lastSunday = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() || 7))).toISOString().slice(0, 10); };
const bare = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', BG1_GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '', ...extra });

/** BG1-C's kept list as a filled manifest would hold it: slots 31 to 70, with placeholder hashes (no world is read through it). */
const KEPT = Array.from({ length: 40 }, (_, i) => bg1WorldId(31 + i));
const keptManifest: Bg1Manifest = { dataset: BG1C_DATASET, status: 'filled', layout: 'test', note: 'synthetic kept list', filled_at: '2026-11-20', kept: KEPT, n_final: 40,
  files: KEPT.flatMap(id => ['world.json', 'questions.json'].map(f => ({ path: `worlds/${id}/${f}`, sha256: sha256(`${id}/${f}`) }))) };
/** A counted launch unit's worlds: the public template fixtures bg1-dev-01 to bg1-dev-05 under the unit's kept ids. */
function unitCorpus(unit: number, revision = 'synthetic-fill'): Corpus {
  const parts = KEPT.slice(unit * 5, unit * 5 + 5).map((id, i) => {
    const dev = `bg1-dev-0${i + 1}`;
    const read = (f: string) => readFileSync(join(BG1_FIXTURES_ROOT, 'worlds', dev, f), 'utf8').replaceAll(dev, id);
    return bg1Conversation(id, read('world.json'), read('questions.json'), DEV_WORLD_END);
  });
  return { benchmark: 'bg1c', conversations: parts.map(p => p.conversation), questions: parts.flatMap(p => p.questions), source: { name: BG1C_DATASET, files: [], revision, license: 'test' } };
}

const answerOf = (prompt: string) => { const q = /Question: (.*)\n/.exec(prompt)?.[1] ?? ''; return `${sha256(q)[0] === '0' ? 'WRONG' : 'RIGHT'} ${q}`; };
const responseOf = (prompt: string) => /\nResponse: ([\s\S]*?)\n\nThe response is correct/.exec(prompt)?.[1] ?? null;
const verdictOf = (prompt: string) => JSON.stringify({ correct: responseOf(prompt)!.startsWith('RIGHT') ? 1 : 0 });
/** In-process reader and judge for the counted fixture: the judge records the model each grade went to. */
const scripted = () => {
  const judged: string[] = [];
  const reader: ChatLike = { async chat(_m, prompt): Promise<ChatResult> { return { text: answerOf(prompt), input_tokens: 10, output_tokens: 8, cached: false, ...NO_META }; } };
  const judge: ChatLike = { async chat(model, prompt): Promise<ChatResult> { judged.push(model); return { text: verdictOf(prompt), input_tokens: 100, output_tokens: 4, cached: false, ...NO_META }; } };
  return { reader, judge, judged };
};

/** A loopback upstream: readers answer RIGHT or WRONG by the question's hash, judges grade by that word, and a Gemini request fails and is logged. */
function scriptedUpstream() {
  const log: Array<{ path: string; model: string; auth: string; judging: boolean; body: Record<string, any> }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname, body = await req.json() as Record<string, any>;
    const prompt = (body.messages as Array<{ content: unknown }>).map(x => (typeof x.content === 'string' ? x.content : (x.content as Array<{ text?: string }>).map(c => c.text ?? '').join(''))).join('\n');
    const judging = responseOf(prompt) !== null;
    log.push({ path, model: String(body.model), auth: req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? '', judging, body });
    if (String(body.model).startsWith('gemini')) return Response.json({ error: { message: 'no BG1-C answer is graded by Gemini' } }, { status: 500 });
    const text = judging ? verdictOf(prompt) : answerOf(prompt);
    if (path.endsWith('/v1/messages')) return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 5 } });
    if (path.endsWith('/chat/completions')) return Response.json({ id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
    return Response.json({ error: { message: `no route ${path}` } }, { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
}

/** The real lease proxy, keyless: every provider at the scripted upstream, placeholder keys, Q1's route caps with the arms' pinned judge caps. */
function leaseProxy(name: string, upstream: string, arms: ArmDefinition[]) {
  const usageLog = join(tmp, `usage-${name}.ndjson`);
  const lease = BudgetRun.openLease({ runId: `bg1c-runner-${name}`, leaseUsd: 25, ledgerPath: join(tmp, `ledger-${name}.sqlite`) });
  const proxy = new MeteringProxy({ upstream: keylessUpstream(upstream), policy: { lease, usageLog, env: keylessKeys(), routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS, ...pinnedJudgeRouteCaps(arms) }, slots: { ...DEFAULT_ROUTE_CLASSES }, defaultClass: 'extraction' } } });
  proxy.start();
  return { url: `http://127.0.0.1:${proxy.port}`, usageLog, stop: () => { proxy.stop(); lease.close(); } };
}

describe('cell.ts --manifest bg1c', () => {
  // Value: protects=BG1-C's cells resolve, plan into waves and run their kept units from BG1-C's own kept list; fails_when=--manifest bg1c is refused, a BG1-C block has no wave (NaN), or a counted unit takes BG1's or RS1's kept list; why_new=BG1-C harness item 5; seam=loadCellManifest, campaignCells and bg1KeptUnit over the committed bg1c-cells.json; no_claim=the kept list's contents
  test('finds the counted and smoke cells, plans every unit into a wave, and a counted unit is its slice of BG1-C\'s kept list', () => {
    expect(m.cells.map(c => c.id)).toEqual(['bg1c.gbrain-defaults.rs1-stable', 'bg1c.ext-memory-bank.recipe', 'bg1c.ext-extract-first.common']);
    expect(findCell('bg1c-dev1.ext-memory-bank.recipe', undefined, 'bg1c').block).toBe('BG1C-smoke');
    expect(refusal(() => loadCellManifest('bg2')).message).toContain('bg1c for BG1-C\'s');
    const units = campaignCells(m, { smoke: true });
    expect(units).toHaveLength(3 * 8 + 3);
    expect(units.every(u => Number.isInteger(u.wave) && u.wave! >= 1)).toBe(true);
    expect(units.filter(u => u.id.startsWith('bg1c.')).every(u => u.sealed)).toBe(true);
    expect(bg1KeptUnit(counted, { index: 1, count: 8 }, keptManifest)).toEqual(KEPT.slice(5, 10));
    expect(bg1KeptUnit(counted, { index: 7, count: 8 }, keptManifest)).toEqual(KEPT.slice(35, 40));
    expect(refusal(() => bg1KeptUnit(counted, { index: 0, count: 5 }, keptManifest)).message).toContain('--shard must be i/8');
  });

  // Value: protects=the preregistration's "no Gemini view" in the runner: a BG1-C answer is complete with its gating judge alone; fails_when=requiredJudges still asks for the canonical judge on a descriptive_view-false cell, or drops it elsewhere; why_new=BG1-C harness item 5 (bg1c-cells.test.ts's no_claim); seam=requiredJudges; no_claim=the judges' grades
  test('a BG1-C answer needs only its reader\'s gating judge, and every other cell keeps its canonical judge', () => {
    const arm = counted.arms[0], inst = instrumentFor(counted.canonical_instrument);
    expect(requiredJudges(arm, { reader: SOL, replicate: 0 }, inst, counted)).toEqual([{ judge: OPUS, instrument_id: `${inst.id}@${OPUS}`, view: 'gating', settings: arm.frontier!.settings }]);
    expect(requiredJudges(arm, { reader: OPUS, replicate: 0 }, inst, counted).map(j => j.judge)).toEqual([ASTRA]);
    expect(requiredJudges(arm, { reader: SOL, replicate: 0 }, inst).map(j => j.judge)).toEqual([inst.canonical_judge, OPUS]);
    const bg1 = findCell('bg1.ext-memory-bank.recipe', undefined, 'bg1');
    expect(requiredJudges(bg1.arms[0], { reader: OPUS, replicate: 0 }, inst, bg1)[0].judge).toBe(inst.canonical_judge);
  });

  // Value: protects=a BG1-C cell spends only inside a granted window and never needs a Gemini key; fails_when=the window refusal names --manifest bg1, a proxy-less BG1-C run refuses for want of BG1_GEMINI_API_KEY, or a BG1 run stops needing it; why_new=BG1-C harness item 5; seam=bg1CellWindow and cell.ts run, blank keys, no proxy, refusals before any client or output; no_claim=none
  test('the window refusal names bg1c, and a proxy-less BG1-C run needs no Gemini key while a BG1 run still does', async () => {
    const def = findCell('bg1c-dev1.ext-memory-bank.recipe', undefined, 'bg1c');
    const op = await refused(bg1CellWindow([], def, {}));
    expect(op).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining(`BG1-C cell ${def.id}`) });
    expect(op!.fix.argv).toEqual(expect.arrayContaining(['--manifest', 'bg1c']));
    const ledger = join(scratch('ledger'), 'ledger.sqlite');
    initLedger({ ledgerPath: ledger, programCapUsd: 5, reason: 'test', log: () => {} });
    const runId = BudgetRun.open({ runner: 'bg1c-test', budgetUsd: 5, ledgerPath: ledger, log: () => {} }).runId;
    const run = (cell: string, manifest: string) => {
      const out = join(scratch('out'), 'out');
      const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'run', '--cell', cell, '--manifest', manifest, '--paid-window', 'BG1C-T', '--window-cap-usd', '5', '--budget-ledger', ledger, '--budget-run-id', runId, '--out', out],
        { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: bare({ GBRAIN_EVALS_BG1_WORLD_END: lastSunday(), GEMINI_API_KEY: 'placeholder-decoy' }) });
      return { ...r, wrote: existsSync(out) };
    };
    const bg1c = run(def.id, 'bg1c'), bg1 = run('bg1-dev3.baseline-none.baseline', 'bg1');
    expect([bg1c.status, bg1c.wrote, bg1.status, bg1.wrote]).toEqual([3, false, 3, false]);
    expect(bg1c.stderr).not.toContain('BG1_GEMINI_API_KEY');
    expect(bg1c.stderr).toContain(`[PAID_FLAGS_MISSING] q1 cell ${def.id} spends money`);
    expect(bg1.stderr).toContain('[KEY_MISSING] BG1_GEMINI_API_KEY is not set');
  }, 60_000);
});

describe('a BG1-C campaign', () => {
  const units = ['bg1c.gbrain-defaults.rs1-stable.c0', 'bg1c.ext-memory-bank.recipe.c4', 'bg1c-dev1.ext-extract-first.common'];
  const sel = (cap: number) => ({ campaign_id: 'q1-scoreboard-bg1c-t', cap_usd: cap, units, paid_window: 'BG1C-T' });
  const filled = () => { const d = scratch('filled'); const p = join(d, 'bg1c-manifest.json'); writeFileSync(p, JSON.stringify(keptManifest)); return p; };

  // Value: protects=a BG1-C unit runs from bg1c-cells.json inside its window, gets no Gemini key, and its sealed units are pinned by BG1-C's filled manifest; fails_when=a unit's run names --manifest bg1, passes BG1_GEMINI_API_KEY or names Gemini, a sealed unit lacks its kept-unit index, or the campaign records BG1's manifest variable instead of GBRAIN_EVALS_BG1C_MANIFEST; why_new=BG1-C harness item 5; seam=bg1CampaignManifest over the committed bg1c-cells.json; no_claim=the leases' sizes
  test('every unit runs from bg1c-cells.json in the window, with no Gemini provider or key, and the campaign records BG1-C\'s filled manifest', () => {
    const path = filled();
    const c = bg1CampaignManifest(m, { smoke: true, units: sel(500), worldEnd: '2026-11-15', bg1Manifest: path });
    expect(c.cells.map(x => x.id).sort()).toEqual([...units].sort());
    for (const cell of c.cells) {
      expect(cell.command).toContain(`--cell ${cell.id.replace(/\.c\d$/, '')} --manifest bg1c `);
      expect(cell.command).toContain('--paid-window BG1C-T --window-cap-usd 500 --out "$SHOOTOUT_OUT"');
      expect(cell.command.startsWith('export GBRAIN_EVALS_BG1_WORLD_END=2026-11-15; ')).toBe(true);
      expect([cell.providers, cell.pass, cell.gemini_key_env]).toEqual([expect.not.arrayContaining(['gemini']), expect.not.arrayContaining(['BG1_GEMINI_API_KEY', 'GEMINI_API_KEY']), undefined]);
      expect(Number.isInteger(cell.wave)).toBe(true);
    }
    expect(Object.fromEntries(c.cells.map(x => [x.id, x.bg1_unit ?? null]))).toEqual({ 'bg1c.gbrain-defaults.rs1-stable.c0': { index: 0, size: 5 }, 'bg1c.ext-memory-bank.recipe.c4': { index: 4, size: 5 }, 'bg1c-dev1.ext-extract-first.common': null });
    expect([c.bg1c_manifest_sha256, c.bg1_manifest_sha256]).toEqual([sha256(readFileSync(path)), undefined]);
    process.env.GBRAIN_EVALS_BG1C_MANIFEST = path;
    expect(bg1CampaignManifest(m, { smoke: true, units: sel(500), worldEnd: '2026-11-15' }).bg1c_manifest_sha256).toBe(sha256(readFileSync(path)));
    expect(refusal(() => bg1CampaignManifest(m, { units: { ...sel(500), paid_window: undefined } }))).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining('a BG1-C campaign needs'), fix: { argv: expect.arrayContaining(['--manifest', 'bg1c']) } });
    const dir = scratch('plan'), file = join(dir, 'units.json'), out = join(dir, 'campaign.json');
    writeFileSync(file, JSON.stringify(sel(500)));
    const r = spawnSync('bun', ['eval/runner/q1/cell.ts', 'plan', '--manifest', 'bg1c', '--with-smoke', '--units', file, '--campaign-out', out], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: bare({ GBRAIN_EVALS_BG1_WORLD_END: '2026-11-15' }) });
    expect(r.status).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as CampaignManifest).cells.every(x => x.command.includes('--manifest bg1c') && !x.pass?.includes('BG1_GEMINI_API_KEY'))).toBe(true);
  });

  // Value: protects=a BG1-C campaign boots only on bg1c-cells.json's leases inside its window, never beside BG1 units, never with Gemini; fails_when=its units are priced against bg1-cells.json (every unit "not a unit"), an edited lease or a mixed or Gemini-carrying campaign reaches a VM; why_new=BG1-C harness item 5; seam=bg1LaunchProblems over bg1CampaignManifest; no_claim=bg1c-cells.json's own lease sizes
  test('the launch check prices BG1-C units from bg1c-cells.json and refuses an edited lease, BG1 units beside them and Gemini', () => {
    const c = bg1CampaignManifest(m, { smoke: true, units: sel(1000), worldEnd: '2026-11-15' });
    const sum = Math.round(c.cells.reduce((s, x) => s + x.lease_usd, 0) * 100) / 100;
    const fits = { ...bg1CampaignManifest(m, { smoke: true, units: sel(sum), worldEnd: '2026-11-15' }), blocks: {} } as CampaignManifest;
    expect(bg1LaunchProblems(fits)).toEqual([]);
    const id = fits.cells[0].id, priced = fits.cells[0].lease_usd;
    expect(bg1LaunchProblems({ ...fits, cells: fits.cells.map((x, i) => (i ? x : { ...x, lease_usd: 399 })) })).toContain(`unit ${id} leases 399, not the ${priced} bg1c-cells.json prices it at`);
    expect(bg1LaunchProblems({ ...fits, cells: [...fits.cells, { ...fits.cells[0], id: 'bg1c.invented.c0' }] })).toContain('unit bg1c.invented.c0 is not a unit of the committed bg1c-cells.json');
    const bg1 = bg1CampaignManifest(loadCellManifest('bg1'), { units: { campaign_id: 'q1-scoreboard-bg1-t', cap_usd: sum, units: ['bg1.baseline-none.baseline.c0'], paid_window: 'BG1C-T' }, worldEnd: '2026-11-15' }).cells[0];
    expect(bg1LaunchProblems({ ...fits, cells: [...fits.cells, bg1] })).toContain('the campaign holds BG1-C units and 1 BG1 unit(s) (bg1.baseline-none.baseline.c0); each set runs in its own campaign');
    const gemini = { ...fits, cells: fits.cells.map((x, i) => (i ? x : { ...x, pass: [...(x.pass ?? []), 'BG1_GEMINI_API_KEY'] })) };
    expect(bg1LaunchProblems(gemini)).toEqual([`unit ${id} is given Gemini (provider, BG1_GEMINI_API_KEY or gemini_key_env), which no BG1-C unit calls`]);
  });

  /** A custodian's BG1-C set root: kept worlds bg1-031 to bg1-040 of placeholder bytes and a filled BG1-C manifest pinning them. */
  function custodySet(dataset = BG1C_DATASET) {
    const root = scratch('custody');
    const ids = KEPT.slice(0, 10);
    const files = ids.flatMap(id => ['world.json', 'questions.json'].map(f => {
      mkdirSync(join(root, 'worlds', id), { recursive: true });
      writeFileSync(join(root, 'worlds', id, f), `${id} ${f}`);
      return { path: `worlds/${id}/${f}`, sha256: sha256(`${id} ${f}`) };
    }));
    const manifest = join(root, 'bg1c-manifest.json');
    writeFileSync(manifest, JSON.stringify({ dataset, status: 'filled', files, kept: ids }));
    return { root, manifest, env: { GBRAIN_EVALS_BG1C_SOURCE: root, GBRAIN_EVALS_BG1C_MANIFEST: manifest } };
  }

  // Value: protects=a sealed BG1-C unit's VM receives exactly its own unit's BG1-C worlds, from BG1-C's custody variables, pinned by the manifest its campaign recorded, and holds none after teardown; fails_when=custodyPush has no bg1c branch (the VM gets no worlds), reads GBRAIN_EVALS_BG1_*, pushes another unit's worlds or BG1's manifest, accepts a manifest the campaign did not record, or the teardown leaves ~/custody/bg1c; why_new=BG1-C harness item 5; seam=bg1CustodyPush, Campaign.custodyPush and runRemote's teardown; no_claim=ubi-runner's push itself
  test('a sealed BG1-C unit pushes only its own unit\'s worlds from BG1-C\'s variables, against the recorded manifest, and the VM wipes them at teardown', async () => {
    const s = custodySet();
    const push = bg1CustodyPush(s.env, 'c', { index: 1, size: 5 }, BG1C_SET);
    expect(push).toEqual({ source: resolve(s.root), dest: 'custody/bg1c', list: [...KEPT.slice(5, 10).flatMap(id => [`worlds/${id}/world.json`, `worlds/${id}/questions.json`]), 'bg1c-manifest.json'],
      env: ['GBRAIN_EVALS_BG1C_SOURCE=~/custody/bg1c', 'GBRAIN_EVALS_BG1C_MANIFEST=~/custody/bg1c/bg1c-manifest.json', `GBRAIN_EVALS_BG1C_UNIT=${KEPT.slice(5, 10).join(',')}`] });
    expect(refusal(() => bg1CustodyPush({ GBRAIN_EVALS_BG1_SOURCE: s.root, GBRAIN_EVALS_BG1_MANIFEST: s.manifest }, 'c', { index: 1, size: 5 }, BG1C_SET)).message).toBe('a sealed BG1-C cell needs the custodian\'s files and GBRAIN_EVALS_BG1C_SOURCE is not set');
    expect(refusal(() => bg1CustodyPush(custodySet('BG1 changing-facts set').env, 'c', { index: 1, size: 5 }, BG1C_SET)).message).toContain('not of the BG1-C set');
    const cell = { id: 'bg1c.x.c1', system: 'baseline-none', benchmark: 'bg1c', config: 'baseline', lease_usd: 5, command: 'true', block: 'BG1C', sealed: true, vm: { size: 'standard-4' }, bg1_unit: { index: 1, size: 5 } };
    const campaign = (recorded: Partial<CampaignManifest>) => {
      const dir = scratch('campaign');
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard-bg1c-t', cap_usd: 50, ledger: join(dir, 'campaign.sqlite'), executes: ['bun.lock'], images: {}, blocks: { BG1C: { estimate_usd: 20, cap_usd: 30 } }, cells: [cell], ...recorded }));
      return new Campaign(join(dir, 'manifest.json'), join(dir, 'state'));
    };
    const held = sha256(readFileSync(s.manifest));
    expect(campaign({ bg1c_manifest_sha256: held }).custodyPush('bg1c.x.c1', s.env)!.list).toEqual(push.list);
    expect(campaign({ bg1c_manifest_sha256: held }).bg1).toBe(true);
    expect(refusal(() => campaign({ bg1_manifest_sha256: held }).custodyPush('bg1c.x.c1', s.env)).message).toBe('campaign q1-scoreboard-bg1c-t records no filled BG1-C manifest SHA-256');
    expect(refusal(() => campaign({ bg1c_manifest_sha256: sha256('another') }).custodyPush('bg1c.x.c1', s.env)).message).toContain('the filled BG1-C manifest is not the one campaign q1-scoreboard-bg1c-t recorded');
    const base = scratch('vm');
    mkdirSync(join(base, 'bg1c'), { recursive: true });
    writeFileSync(join(base, 'bg1c', 'f'), 'x');
    const exit = await runRemote({ lease_id: 'lease-c', lease_usd: 0.1, out: join(base, 'out', 'bg1c.x.c1', 'lease-c'), cell: 'bg1c.x.c1', sealed: true, command: '[ -f "$SHOOTOUT_CUSTODY/../bg1c/f" ] || exit 9' }, { port: await freePort(0), custodyBase: base });
    expect(exit).toBe(0);
    expect(existsSync(join(base, 'bg1c'))).toBe(false);
  }, 30_000);
});

describe('gpt-6.2-sol and the BG1-C pin', () => {
  // Value: protects=gpt-6.2-sol is counted and windowed with gpt-6.1-sol's figures, marked as not measured, and a reuse check compares BG1-C's dataset pin only for BG1-C cells; fails_when=gpt-6.2-sol falls back to an uncalibrated 1.0 factor, has no window, claims a measured calibration, or bg1c-manifest.json is compared for every system; why_new=BG1-C harness item 5; seam=readerTokenizer, READER_WINDOWS, DATASET_PINS; no_claim=gpt-6.2-sol's real tokenizer or window (launch amendment B)
  test('gpt-6.2-sol takes gpt-6.1-sol\'s factor and window, uncalibrated, and bg1c-manifest.json is pinned to bg1c', () => {
    expect(readerTokenizer(SOL)).toEqual({ encoding: 'o200k_base', calibration: readerTokenizer('openai:gpt-6.1-sol').calibration, calibrated: false });
    const { source: _a, ...window } = READER_WINDOWS[SOL], { source: _b, ...sol61 } = READER_WINDOWS['openai:gpt-6.1-sol'];
    expect(window).toEqual(sol61);
    expect(READER_WINDOWS[SOL].source).toContain('developers.openai.com/api/docs/models/gpt-6.2-sol');
    expect(DATASET_PINS['eval/decisions/datasets/bg1c-manifest.json']).toEqual(['bg1c']);
  });
});

describe('a counted BG1-C cell and its re-read by half', () => {
  const arm = rereadArm(counted, counted.arms[0].id);
  const out = join(tmp, 'counted-unit0');
  const source = join(out, 'runs', counted.id);
  let judgedInCell: string[] = [];

  // Value: protects=a counted BG1-C unit runs its own kept worlds and grades every answer with its gating judge alone; fails_when=the unit takes RS1's or BG1's kept list, or any answer goes to Gemini or misses its gating judge; why_new=BG1-C harness item 5; seam=runCell on unit 0 with the fake system, a scripted reader and judge and the template fixtures under BG1-C ids; no_claim=any system's or judge's quality
  test('unit 0 runs kept worlds 1 to 5, and every answer is graded by its reader\'s gating judge alone', async () => {
    const s = scripted();
    const res = await runCell(counted, { out, shard: { index: 0, count: 8 }, ...quiet }, { corpus: unitCorpus(0), bg1Manifest: keptManifest, system: new FakeMemorySystem(), reader: s.reader, judge: s.judge });
    expect(res.share).toMatchObject({ shard: '0/8', questions: 320, complete: true });
    const receipt = JSON.parse(readFileSync(join(out, 'cells', arm.cell_id, 'receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ instrument: { id: 'bg1', judge: null }, counts: { answers: 640, unjudged: 0 }, per_reader_mean: { [OPUS]: null, [SOL]: null } });
    expect(receipt.realizations.map((r: { conversation: string }) => r.conversation)).toEqual(KEPT.slice(0, 5));
    expect(JSON.parse(readFileSync(join(out, 'cells', arm.cell_id, 'run-config.json'), 'utf8')).instrument.judge).toBeNull();
    const judgments = readRecords(join(out, 'cells', arm.cell_id, 'judgments.ndjson'), 'judgment');
    expect(judgments).toHaveLength(640);
    expect(judgments.every(j => j.view === 'gating' && j.instrument_id === `bg1@${j.judge}`)).toBe(true);
    expect([...new Set(s.judged)].sort()).toEqual([OPUS, ASTRA]);
    judgedInCell = s.judged;
  }, 120_000);

  // Value: protects=particle-1's first-half re-read runs from unit 0 alone, before units 5 to 8 exist, under its plan's .h1 id, graded by Opus alone, and a half reads only its own units; fails_when=a counted re-read runs without its half, under the plain id, with a Gemini or canonical judge, or a half accepts another half's worlds, or --half is taken on the smoke; why_new=BG1-C harness item 5 (Amendment 1: particle-1 re-reads the first half before units 5 to 8 run); seam=prepareReread and runReread on unit 0's output with a scripted reader and judge; no_claim=particle-1's grades
  test('the first half re-reads unit 0 under its .h1 plan, graded by Opus alone, and the halves refuse each other\'s worlds', async () => {
    expect(judgedInCell.length).toBe(640);
    const deps = { corpus: unitCorpus(0), bg1Manifest: keptManifest };
    const at = (name: string) => join(tmp, `reread-${name}`);
    expect(refusal(() => prepareReread(counted, arm, { sources: [source], reader: PARTICLE, out: at('none') }, deps)).message).toContain('is a counted BG1-C cell, so its re-read names its half (--half 1 or 2)');
    expect(refusal(() => prepareReread(counted, arm, { sources: [source], reader: PARTICLE, out: at('h2'), half: 2 }, deps)).message).toBe(`5 of the 5 worlds the sources stage are outside half 2's launch units (4, 5, 6, 7) of ${counted.id}`);
    expect(refusal(() => prepareReread(counted, arm, { sources: [source], reader: PARTICLE, out: at('unfilled'), half: 1 }, { ...deps, corpus: unitCorpus(0, 'unfilled') })).message).toContain('bg1c: the BG1-C manifest is unfilled');
    const dev = smoke[1];
    expect(refusal(() => prepareReread(dev, rereadArm(dev, dev.arms[0].id), { sources: [source], reader: PARTICLE, out: at('smoke'), half: 1 }, deps)).message).toContain('--half is for a counted BG1-C cell\'s re-read');
    for (const name of ['none', 'h2', 'unfilled', 'smoke']) expect(existsSync(at(name))).toBe(false);
    const p = prepareReread(counted, arm, { sources: [source], reader: PARTICLE, out: at('h1'), half: 1, manifest: 'bg1c' }, deps);
    const id = `${rereadCellId(arm.cell_id, PARTICLE)}.h1`;
    expect(p.cell_id).toBe(id);
    expect(id).toBe(m.reread_plans.find(r => r.arm_cell_id === arm.cell_id && r.half === 1)!.id);
    const s = scripted();
    const res = await runReread(p, {}, { reader: s.reader, judge: s.judge });
    expect(res.status).toBe('complete');
    expect(readdirSync(join(at('h1'), 'cells'))).toEqual([id]);
    expect(res.receipt).toMatchObject({ cell_id: id, half: { plan: id, half: 1, units: [0, 1, 2, 3] }, instrument: { judge: null }, frontier: { judge_by_reader: { [PARTICLE]: OPUS } }, counts: { answers: 320, unjudged: 0 } });
    expect([...new Set(s.judged)]).toEqual([OPUS]);
    expect(s.judged).toHaveLength(320);
    expect(refusal(() => prepareReread(counted, arm, { sources: [source], reader: PARTICLE, out: at('h1b'), half: 2 }, deps)).message).toContain('outside half 2');
  }, 60_000);
});

describe('end to end: the smoke, its re-reads and the pilot, keyless', () => {
  // Value: protects=a BG1-C smoke runs through cell.ts and the real lease proxy, particle-1 re-reads it, and verdict.ts pilot --set BG1-C reads those receipts row by row; fails_when=any BG1-C answer reaches Gemini or the upstream with a real key, a reader or gating judge is missing or of the wrong family, the receipts lack the frozen contexts, metered spend or the unsuffixed re-read the pilot looks up, or a keyless re-read passes the pilot's spend check as paid; why_new=BG1-C harness item 5; seam=runCell and runReread with ChatClient behind MeteringProxy in front of a scripted loopback upstream, the fake system, the bg1-dev-01 template fixture, and the pilot CLI; no_claim=the pilot's judge-check and brain-count conditions, fill rates, or any model's grades
  test('the three smoke cells and their particle-1 re-reads run through the lease proxy, no answer reaches Gemini, and the pilot reads every row', async () => {
    delete process.env.SHOOTOUT_PROXY;
    const corpus = loadBg1Dev({ root: BG1_FIXTURES_ROOT, only: new Set(['bg1-dev-01']), worldEnd: DEV_WORLD_END, keyless: true });
    const up = scriptedUpstream();
    const proxy = leaseProxy('smoke', up.url, smoke.flatMap(c => c.arms));
    const dirs: string[] = [];
    try {
      for (const def of smoke) {
        const out = join(tmp, 'smoke', def.id);
        process.env.GBRAIN_EVALS_QA_CACHE = join(tmp, 'qa-cache', def.id);
        const res = await runCell(def, { out, providerProxy: proxy.url, keyless: true, ...quiet }, { corpus, system: new FakeMemorySystem() });
        expect([def.id, res.status]).toEqual([def.id, 'complete']);
        const arm = def.arms[0];
        const rr = join(tmp, 'smoke-reread', def.id);
        process.env.GBRAIN_EVALS_QA_CACHE = join(tmp, 'qa-cache-reread', def.id);
        const p = prepareReread(def, arm, { sources: [join(out, 'runs', def.id)], reader: PARTICLE, out: rr, keyless: true, manifest: 'bg1c' }, { corpus });
        expect(p.cell_id).toBe(rereadCellId(arm.cell_id, PARTICLE));
        expect((await runReread(p, { providerProxy: proxy.url })).status).toBe('complete');
        dirs.push(out, rr);
      }
    } finally { proxy.stop(); up.stop(); }
    const model = (x: { model: string }) => x.model;
    expect(up.log.filter(l => l.model.startsWith('gemini'))).toEqual([]);
    expect(up.log.every(l => l.auth.includes('keyless-not-a-provider-key'))).toBe(true);
    const reads = up.log.filter(l => !l.judging), grades = up.log.filter(l => l.judging);
    expect([...new Set(reads.map(model))].sort()).toEqual(['claude-opus-5-5', 'gpt-6.2-sol', 'particle-1']);
    expect(reads.map(model).filter(x => x === 'particle-1')).toHaveLength(3 * 64);
    expect(reads.filter(l => l.model !== 'particle-1')).toHaveLength(3 * 128);
    expect(grades.filter(l => l.model === 'gpt-6-astra')).toHaveLength(3 * 64);
    expect(grades.filter(l => l.model === 'claude-opus-5-5')).toHaveLength(3 * 128);
    expect(grades).toHaveLength(3 * 192);
    for (const def of smoke) {
      const receipt = JSON.parse(readFileSync(join(tmp, 'smoke', def.id, 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8'));
      expect(receipt).toMatchObject({ run_status: 'complete', instrument: { id: 'bg1-dev', judge: null }, counts: { answers: 128, unjudged: 0 }, frontier: { judge_by_reader: { [OPUS]: ASTRA, [SOL]: OPUS } } });
      expect(receipt.spend.total_usd).toBeGreaterThan(0);
    }

    const pilotOut = join(tmp, 'pilot');
    const r = spawnSync('bun', ['eval/runner/bg1/verdict.ts', 'pilot', '--set', 'BG1-C', ...dirs.flatMap(d => ['--receipts', d]), '--out', pilotOut], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: bare() });
    expect(r.status).toBe(3);
    const pilot = JSON.parse(readFileSync(join(pilotOut, 'pilot.json'), 'utf8')) as { rows: Array<{ row: string; cell: string; checks: Array<{ check: string; value: unknown; pass: boolean }> }> };
    expect(pilot.rows.map(x => [x.row, x.cell])).toEqual(smoke.map((c, i) => [['gbrain', 'memory-bank', 'extract-first'][i], c.arms[0].cell_id]));
    for (const row of pilot.rows) {
      const check = (name: string) => row.checks.find(c => c.check === name)!;
      expect(check('frozen contexts')).toMatchObject({ value: 64, pass: true });
      expect(typeof check('mean fill rate').value).toBe('number');
      expect(check('spend per world')).toMatchObject({ value: 'the particle-1 re-read is not paid', pass: false });
    }
  }, 240_000);
});

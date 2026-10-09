/**
 * P5 H5b: does put_page's similar-page hint reduce duplicate pages when an
 * agent saves notes, without making it merge different entities?
 *
 * Each task (eval/generators/save-notes-dedup-gen.ts) is a note with ten
 * mentions: three entities that already have a page under another name,
 * two different entities whose names resemble a page, and five new ones.
 * An agent (each --models entry) gets the note and "save these notes" on a
 * fresh copy of the world's brain and writes through gbrain's MCP server
 * (stdio, the fixed P5 tool list, no tool-result cap). Afterwards the brain's
 * pages are read and every mention is classified by where its marker (a
 * codename the note gives only that entity) and its names ended up:
 *   duplicate       existing mention: a page created during the task is about it
 *                   (carries its marker, or its title or slug name is one of its names)
 *   saved_on_page   existing mention: its marker is on its own existing page
 *   wrong_merge     similar mention: its marker is on the existing page it resembles
 *   separate_page   similar mention: a page created during the task carries its marker
 *   created_page    new mention: a page created during the task carries its marker
 *   marker_saved    any mention: its marker is on some person or company page
 * Only person and company pages count (people/ or companies/ slugs, or a person or
 * company type); a meeting-notes page that repeats every name is not a duplicate.
 *
 * Arms: one invocation is one arm, the build under test (--gbrain) with
 * GBRAIN_EVAL_CONFIG (for example put_page.similar_pages=true or =false on the
 * candidate, and the baseline build). Rows pair across arms by id
 * (`<model>:<mention>`), cluster = task. `compare <receipt A> <receipt B>`
 * prints the paired task-cluster bootstrap per metric and model.
 *
 * Usage:
 *   GBRAIN_EVAL_CONFIG=put_page.similar_pages=true bun eval/runner/save-notes-dedup.ts --gbrain <checkout>@<ref> \
 *     --output <dir> [--work <dir outside any git worktree>] [--models claude-sonnet-5-5,gpt-6.1-sol] [--seeds 1,2,3]
 *     [--tasks-per-seed 20] [--pilot | --limit N] [--slots 2] [--max-turns 40] [--paid --budget-usd N | --paid --budget-run-id <id>]
 *   bun eval/runner/save-notes-dedup.ts ... --scripted        (a naive scripted writer, $0: proves the plumbing and the classifier)
 *   bun eval/runner/save-notes-dedup.ts compare <receipt A> <receipt B>
 * Custodian (held-out) mode: --phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>.
 * The file holds `{ "id": ..., "templates": SaveNotesTemplates }` outside the repository; the access log beside it gets a
 * line before it is read, the receipt records only its SHA-256, and rows then omit mention text.
 *
 * Resumable: every finished (model, task) cell is one line in <output>/cells.jsonl; a rerun with the same arm skips them
 * and rejoins the budget run it recorded. A different build, config, model set or world in the same --output is refused.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { runAgent, type AgentRun, type ScriptedModel } from './cat40/loop.ts';
import { receiptCost, type RunSummary } from './budget-ledger.ts';
import { argValue, custodyInput, p5Receipt } from './p5-brain.ts';
import {
  AgentBrain, Checkpoint, ToolsArm, closePaid, compareReceipts, flagValue, limitFlag, openPaid, runPool, selectUnits, sha256, type PaidSession, type StoredPage,
} from './p5-agent.ts';
import { writeReceipt } from './receipt.ts';
import {
  DEV_SEEDS, SAVE_NOTES_GENERATOR_VERSION, generateSaveNotesWorld, normName, slugify, validateTemplates, type SaveNotesTask, type SaveNotesWorld,
} from '../generators/save-notes-dedup-gen.ts';

export const CATEGORY = 'save-notes-dedup';
export const DEFAULT_MODELS = ['claude-sonnet-5-5', 'gpt-6.1-sol'];
const REPO = resolve(import.meta.dir, '../..');

export interface H5bRow { id: string; cluster: string; [field: string]: unknown }

const isEntityPage = (p: StoredPage) => /^(people|companies)\//.test(p.slug) || p.type === 'person' || p.type === 'company';
const contains = (p: StoredPage, marker: string) => `${p.title}\n${p.body}`.toLowerCase().includes(marker.toLowerCase());

/** Classify every mention of a task from the brain's pages after the agent finished. */
export function classifyTask(task: SaveNotesTask, seedSlugs: ReadonlySet<string>, pages: readonly StoredPage[]): Array<Record<string, unknown>> {
  const entityPages = pages.filter(isEntityPage);
  const created = entityPages.filter(p => !seedSlugs.has(p.slug));
  const bySlug = new Map(pages.map(p => [p.slug, p]));
  return task.mentions.map(m => {
    const names = new Set(m.names.map(normName));
    const slugNames = new Set(m.names.map(slugify));
    const about = (p: StoredPage) => contains(p, m.marker) || names.has(normName(p.title)) || slugNames.has(p.slug.slice(p.slug.lastIndexOf('/') + 1).replace(/-\d+$/, ''));
    const base = { mention: m.id, kind: m.kind, entity_kind: m.entity_kind, family: m.family, marker_saved: Number(entityPages.some(p => contains(p, m.marker))) };
    const seed = m.seed_slug ? bySlug.get(m.seed_slug) : undefined;
    if (m.kind === 'existing') {
      const dups = created.filter(about);
      return { ...base, duplicate: Number(dups.length > 0), duplicate_pages: dups.map(p => p.slug), saved_on_page: Number(!!seed && contains(seed, m.marker)), seed_page_deleted: Number(!seed) };
    }
    if (m.kind === 'similar') {
      const separate = created.filter(p => contains(p, m.marker));
      return { ...base, wrong_merge: Number(!!seed && contains(seed, m.marker)), separate_page: Number(separate.length > 0), separate_pages: separate.map(p => p.slug) };
    }
    const own = created.filter(p => contains(p, m.marker));
    return { ...base, created_page: Number(own.length > 0), misfiled: Number(entityPages.some(p => seedSlugs.has(p.slug) && contains(p, m.marker))) };
  });
}

/** Rates over rows (null when a metric has no eligible row). */
export function summarizeH5b(rows: readonly H5bRow[]): Record<string, unknown> {
  const ok = rows.filter(r => !r.error);
  const rate = (f: string, xs = ok) => { const e = xs.filter(r => typeof r[f] === 'number'); return e.length ? e.reduce((a, r) => a + (r[f] as number), 0) / e.length : null; };
  const families = (kind: string, f: string) => Object.fromEntries([...new Set(ok.filter(r => r.kind === kind).map(r => String(r.family)))].sort()
    .map(fam => [fam, { n: ok.filter(r => r.kind === kind && r.family === fam).length, rate: rate(f, ok.filter(r => r.kind === kind && r.family === fam)) }]));
  const models = [...new Set(rows.map(r => String(r.model)))].sort();
  const block = (xs: readonly H5bRow[]) => ({
    mentions: xs.length, errors: xs.filter(r => r.error).length, tasks: new Set(xs.map(r => r.cluster)).size,
    duplicate_rate: rate('duplicate', xs.filter(r => !r.error)), wrong_merge_rate: rate('wrong_merge', xs.filter(r => !r.error)),
    saved_on_page_rate: rate('saved_on_page', xs.filter(r => !r.error)), separate_page_rate: rate('separate_page', xs.filter(r => !r.error)),
    created_page_rate: rate('created_page', xs.filter(r => !r.error)), marker_saved_rate: rate('marker_saved', xs.filter(r => !r.error)),
  });
  return { ...block(rows), per_model: Object.fromEntries(models.map(m => [m, block(rows.filter(r => r.model === m))])),
    duplicate_by_family: families('existing', 'duplicate'), wrong_merge_by_family: families('similar', 'wrong_merge') };
}

export function systemPrompt(arm: ToolsArm): string {
  return [
    'You are an AI assistant working for Jordan Example, who keeps a personal knowledge base (a brain) of people and companies they meet. Today is 2026-10-05.',
    arm.systemHint(),
    'Do the task with the brain tools. When you are done, call submit_answer with `answer` set to DONE, the slugs of the pages you wrote or changed in `sources`, and a one-line summary in `notes`.',
  ].join('\n\n');
}

/** Hermetic plumbing check: writes one new page per mention line, never looks for existing pages, then submits. */
export function scriptedWriter(task: SaveNotesTask): ScriptedModel {
  return history => {
    const i = history.length;
    if (i < task.mentions.length) {
      const m = task.mentions[i];
      const dir = m.entity_kind === 'person' ? 'people' : 'companies';
      return { name: 'put_page', args: { slug: `${dir}/${slugify(m.text)}`, content: `---\ntype: ${m.entity_kind}\ntitle: ${JSON.stringify(m.text)}\n---\n\n${m.line}\n` } };
    }
    return { name: 'submit_answer', args: { answer: 'DONE', sources: [] } };
  };
}

interface CellRecord {
  key: string; model: string; task: string; seed: number; rows: H5bRow[];
  run: Omit<AgentRun, 'tools'> & { tool_calls: Array<{ name: string; ms: number; chars: number; error?: string }> };
  hint_shown: number; pages_after: number; budget_run_id: string | null; finished_at: string;
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'compare') {
    const [a, b] = argv.slice(1);
    if (!a || !b) throw new Error('usage: save-notes-dedup.ts compare <receipt A (reference)> <receipt B>');
    console.log(JSON.stringify(compareReceipts(a, b, ['duplicate', 'wrong_merge', 'marker_saved', 'saved_on_page', 'separate_page'], { groupBy: 'model' }), null, 2));
    return;
  }
  const log = (s: string) => process.stderr.write(`[h5b] ${s}\n`);
  const seeds = (argValue(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  const custody = custodyInput(argv, seeds, DEV_SEEDS, { needsWork: true });
  const sealedTemplates = custody ? { id: custody.parsed.id, templates: validateTemplates(custody.parsed.templates) } : undefined;
  const tasksPerSeed = Number(flagValue(argv, '--tasks-per-seed') ?? 20);
  const models = (flagValue(argv, '--models') ?? DEFAULT_MODELS.join(',')).split(',').filter(Boolean);
  const scripted = argv.includes('--scripted');
  const maxTurns = Number(flagValue(argv, '--max-turns') ?? 40);
  const slots = Number(flagValue(argv, '--slots') ?? 2);
  const config = parseEvalConfig();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const commit = gut.overlay?.build.commit ?? `pin-${gut.version}`;
  const output = resolve(flagValue(argv, '--output') ?? join(REPO, 'eval/reports', CATEGORY, `${commit.slice(0, 9)}-${sha256(JSON.stringify(config)).slice(0, 8)}`));
  const work = resolve(flagValue(argv, '--work') ?? join(homedir(), '.cache/gbrain-evals', CATEGORY, sha256(output).slice(0, 12)));
  if (!relative(REPO, work).startsWith('..')) throw new Error(`--work ${work} is inside this repository; gbrain init refuses a content directory inside another Git worktree`);
  mkdirSync(output, { recursive: true });

  const worlds: SaveNotesWorld[] = seeds.map(seed => generateSaveNotesWorld({ seed, tasks: tasksPerSeed, sealedTemplates }));
  const identity = { category: CATEGORY, generator: SAVE_NOTES_GENERATOR_VERSION, build: commit, config, models, scripted, max_turns: maxTurns,
    worlds: worlds.map(w => ({ seed: w.seed, fingerprint: w.fingerprint })), custody_sha256: custody?.sha256 ?? null };
  const identityPath = join(output, 'experiment.json');
  if (existsSync(identityPath)) {
    const prior = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (JSON.stringify(prior) !== JSON.stringify(identity)) throw new Error(`${output} holds a different experiment (experiment.json differs); use a new --output`);
  } else writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n');

  const allCells = worlds.flatMap(w => w.tasks.flatMap(task => models.map(model => ({ model, task, world: w }))));
  const units = selectUnits(allCells, c => `${c.model}|${c.task.id}`, { pilot: argv.includes('--pilot'), limit: limitFlag(argv) });
  const checkpoint = new Checkpoint<CellRecord>(join(output, 'cells.jsonl'));
  const todo = units.filter(c => !checkpoint.has(`${c.model}|${c.task.id}`));
  log(`gbrain ${gut.version} ${commit.slice(0, 12)}, config ${JSON.stringify(config)}; ${units.length} cells planned, ${units.length - todo.length} already done`);

  const estimate = Number(flagValue(argv, '--estimate-usd') ?? (todo.length * 0.6).toFixed(2));
  let paid: PaidSession | null = null;
  if (!scripted && todo.length) paid = openPaid(argv, CATEGORY, estimate, join(output, 'budget-run.json'), log);
  const startedAt = new Date().toISOString();
  let harnessError: string | null = null;
  let summary: RunSummary | null = null;
  // One brain directory per (worker, seed), built in place: gbrain stores absolute paths and the content
  // checkout's inode, so a brain is only ever restored into the directory it was built in.
  const configTag = sha256(JSON.stringify(config)).slice(0, 8);
  const brains = new Map<string, { brain: AgentBrain; tar: string; seedSlugs: Set<string> }>();
  let readback: Record<string, string | null> | null = null;
  const brainFor = async (worker: number, w: SaveNotesWorld) => {
    const key = `${worker}|${w.seed}`;
    const have = brains.get(key);
    if (have) return have;
    const brain = new AgentBrain(gut.root, join(work, `slot${worker}-s${w.seed}-${w.fingerprint.slice(0, 12)}-${commit.slice(0, 12)}-${configTag}`));
    const tar = `${brain.dir}.tar`;
    if (!existsSync(tar)) { await brain.create(config, w.pages); brain.snapshot(tar); readback ??= brain.configReadback; }
    else await brain.restoreFrom(tar);
    const seedSlugs = new Set(brain.readPages().map(p => p.slug));
    if (seedSlugs.size !== w.pages.length) throw new Error(`seed brain s${w.seed}: ${seedSlugs.size} pages landed, the world has ${w.pages.length}`);
    const entry = { brain, tar, seedSlugs };
    brains.set(key, entry);
    return entry;
  };
  try {
    let finished = 0;
    await runPool(todo, slots, async (cell, worker) => {
      if (paid?.guard.exhausted) throw new Error('budget exhausted');
      const seedInfo = await brainFor(worker, cell.world);
      const brain = seedInfo.brain;
      await brain.restoreFrom(seedInfo.tar);
      await brain.start();
      const arm = new ToolsArm('gbrain', brain, '', 'Jordan Example');
      const missing = arm.missingTools();
      let run: AgentRun;
      try {
        run = await runAgent({ model: cell.model, system: systemPrompt(arm), user: cell.task.prompt, arm, maxTurns, maxToolChars: null, scripted: scripted ? scriptedWriter(cell.task) : undefined });
      } finally { await brain.stop(); }
      const pages = brain.readPages();
      const classified = classifyTask(cell.task, seedInfo.seedSlugs, pages);
      const hintShown = run.tools.filter(t => t.name === 'put_page' && t.result.includes('"similar_pages"')).length;
      const providerError = run.stop === 'error';
      const rows: H5bRow[] = classified.map((c, i) => ({
        id: `${cell.model}:${cell.task.mentions[i].id}`, cluster: `${cell.model}:${cell.task.id}`, model: cell.model, task: cell.task.id, seed: cell.world.seed,
        ...(sealedTemplates ? {} : { text: cell.task.mentions[i].text }), ...c,
        ...(providerError ? { error: run.error ?? 'agent run failed', error_origin: 'dependency' } : {}),
        ...(missing.length ? { missing_tools: missing } : {}),
      }));
      const { tools, ...rest } = run;
      checkpoint.append({ key: `${cell.model}|${cell.task.id}`, model: cell.model, task: cell.task.id, seed: cell.world.seed, rows,
        run: { ...rest, tool_calls: tools.map(t => ({ name: t.name, ms: t.ms, chars: t.chars, ...(t.error ? { error: t.error } : {}) })) },
        hint_shown: hintShown, pages_after: pages.length, budget_run_id: paid?.runId ?? null, finished_at: new Date().toISOString() });
      finished++;
      const dup = rows.filter(r => r.kind === 'existing' && r.duplicate === 1).length;
      log(`${finished}/${todo.length} ${cell.model} ${cell.task.id}: ${run.stop}, ${run.turns} turns, $${run.usd.toFixed(3)}, duplicates ${dup}/3, wrong merges ${rows.filter(r => r.wrong_merge === 1).length}/2, hints ${hintShown}`);
    });
  } catch (e) {
    harnessError = e instanceof Error ? e.message : String(e);
  } finally {
    if (paid) summary = closePaid(paid, !harnessError);
  }
  const unitKeys = new Set(units.map(c => `${c.model}|${c.task.id}`));
  const cells = checkpoint.values().filter(c => unitKeys.has(c.key));
  const rows = cells.flatMap(c => c.rows);
  const incomplete = cells.length < units.length;
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, harnessError: harnessError ?? (incomplete ? `${units.length - cells.length} of ${units.length} cells did not finish; rerun the same command to resume` : null),
    rows, summary: { ...summarizeH5b(rows), cells: cells.length, cells_planned: units.length, agent_usd: cells.reduce((a, c) => a + c.run.usd, 0),
      usd_per_cell: cells.length ? cells.reduce((a, c) => a + c.run.usd, 0) / cells.length : null, hints_shown_per_cell: cells.length ? cells.reduce((a, c) => a + c.hint_shown, 0) / cells.length : null,
      stops: cells.reduce((m, c) => ({ ...m, [c.run.stop]: (m[c.run.stop] ?? 0) + 1 }), {} as Record<string, number>) },
    basis: scripted ? 'scripted writer: no model and no paid request' : 'agent model calls through the paid-request guard; gbrain runs keyless (no provider key, no gbrain model calls)',
    resolvedConfig: {
      models, scripted, seeds, tasks_per_seed: tasksPerSeed, pilot: argv.includes('--pilot'), limit: limitFlag(argv), max_turns: maxTurns, max_tool_chars: null, slots,
      generator_version: SAVE_NOTES_GENERATOR_VERSION, mentions_per_task: { existing: 3, similar: 2, new: 5 },
      templates: sealedTemplates ? `held-out set ${sealedTemplates.id} (custody file sha256 ${custody!.sha256})` : 'A (development)',
      transport: 'gbrain serve --surface full over stdio (remote caller); tools offered: P5_AGENT_TOOLS (p5-agent.ts)',
      brain: 'PGLite, gbrain init --no-embedding (keyword search), seed pages via gbrain import + extract --stale',
      eval_config: { channel: 'GBRAIN_EVAL_CONFIG', requested: config, readback },
      budget_run_id: paid?.runId ?? null,
    },
    hashes: Object.fromEntries(worlds.map(w => [`world_seed_${w.seed}`, w.fingerprint])),
  });
  if (summary) receipt.cost = receiptCost(summary);
  writeReceipt(join(output, 'receipt.json'), receipt);
  log(`receipt: ${join(output, 'receipt.json')}`);
  if (receipt.run_status === 'error') { console.error(`error: ${(receipt.data as { harness_error: string }).harness_error}`); process.exit(3); }
  process.stdout.write(JSON.stringify((receipt.data as { summary: unknown }).summary, null, 2) + '\n');
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(3); });
}

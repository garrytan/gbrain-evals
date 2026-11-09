/**
 * G3 task generator: write landing and call contract (GBEV-55, gap rank 3).
 *
 * Wintermute counted 66 remember errors on the real brain (21 source_changed, 16 missing provenance, 2 ambiguous
 * entity, 2 fact and items passed together, 1 scope_denied), 10 commit_paths_invalid refusals, 5 sources calls without
 * --brain, and the replayed two-range page reads. Each task here stages one of those causes in a fictional brain and asks
 * for a write that runs into it. Every task runs on the CLI arm and the MCP arm (eval/runner/predictive/cli-arm.ts).
 *
 * A task records its exposure to every cause on each surface (gate change D1), derived from what the task requires:
 * any remember is exposed to missing provenance, a shared name to ambiguous entity, a staged committed edit to
 * source_changed, and so on. A cause a surface cannot express (git commit-push and sources --brain have no MCP form)
 * has exposure 0 there.
 *
 * naive and fixed are the scripted fake model's calls: the first call that runs into the cause and the call or calls
 * that recover from it. They document the exposure; counted cells never see them.
 *
 * Seeded and fictional: names come from invented pools, and nothing comes from a real brain.
 */
import { Rng, fingerprint } from './seeded.ts';

export const G3_CAUSES = [
  'source_changed', 'missing_provenance', 'ambiguous_entity', 'fact_and_items',
  'scope_denied', 'commit_paths_invalid', 'sources_without_brain', 'two_range_read',
] as const;
export type G3Cause = typeof G3_CAUSES[number];
export const G3_SURFACES = ['cli', 'mcp'] as const;
export type G3Surface = typeof G3_SURFACES[number];

export const G3_DEFAULT_SEED = 20261109;
export const G3_DEFAULT_TASKS = 60;
/** Causes whose write cannot land without the source host: an honest "pending" or "refused" report is a pass. */
export const PENDING_OK: readonly G3Cause[] = ['scope_denied'];

export interface StagedEdit { slug: string; line: string; commit: boolean }
export interface ScriptedCall { cli?: { argv: string[]; stdin?: string }; mcp?: { tool: string; args: Record<string, unknown> } }

export interface WriteTask {
  id: string;
  cause: G3Cause;
  pages: Array<{ slug: string; markdown: string }>;
  stage: StagedEdit[];
  /** The request; {{checkout}} is replaced with the brain's checkout path at run time. */
  prompt: string;
  /** What must land: a fact on an entity, or a page, whose text holds every value. */
  target: { kind: 'fact' | 'page'; path: string; values: string[] };
  /** Other pages a careless write lands on instead (the namesake). */
  decoys: string[];
  exposure: Record<G3Surface, Record<G3Cause, 0 | 1>>;
  naive: ScriptedCall;
  fixed: ScriptedCall[];
}

const FIRST = ['Ana', 'Bruno', 'Chiara', 'Dev', 'Esme', 'Farid', 'Greta', 'Hiro', 'Ines', 'Jonas', 'Kaia', 'Lior', 'Mina', 'Nils', 'Oona', 'Pavel', 'Quinn', 'Rhea', 'Sami', 'Tova'];
const LAST = ['Arden', 'Brisk', 'Calloway', 'Dunmore', 'Ellery', 'Fairbank', 'Galloway', 'Hollins', 'Ivers', 'Jessup', 'Kestrel', 'Lowry', 'Marlow', 'Northey', 'Oakhart'];
const FIRMS = ['Fernway', 'Orchid Labs', 'Halcyon', 'Brightwell', 'Corvid Systems', 'Lumen Works', 'Norvale', 'Quillon', 'Tessaract Bio', 'Wrenfield'];
const CITIES = ['Lisbon', 'Osaka', 'Tallinn', 'Montreal', 'Porto', 'Kraków', 'Valparaíso', 'Hobart'];
const TEAMS = ['platform', 'growth', 'payments', 'search', 'security', 'mobile'];

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const person = (title: string, body: string) => `---\ntype: person\ntitle: ${title}\n---\n\n${body}\n`;
const note = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const PROVENANCE = 'user said in chat, 2026-11-09';

function zeroExposure(): Record<G3Cause, 0 | 1> {
  return Object.fromEntries(G3_CAUSES.map(c => [c, 0])) as Record<G3Cause, 0 | 1>;
}

/** Exposure from what the task needs, per surface (D1). */
function exposureFor(needs: { remember: boolean; items: boolean; sharedName: boolean; committedEdit: boolean; drift: boolean; commit: boolean; sources: boolean; twoWindows: boolean }): WriteTask['exposure'] {
  const base = zeroExposure();
  if (needs.remember) base.missing_provenance = 1;
  if (needs.items) base.fact_and_items = 1;
  if (needs.sharedName) base.ambiguous_entity = 1;
  if (needs.committedEdit) base.source_changed = 1;
  if (needs.drift) base.scope_denied = 1;
  if (needs.twoWindows) base.two_range_read = 1;
  const cli = { ...base, commit_paths_invalid: needs.commit ? 1 : 0, sources_without_brain: needs.sources ? 1 : 0 } as Record<G3Cause, 0 | 1>;
  return { cli, mcp: { ...base } };
}

const remember = (fact: string, entity: string, withProvenance = true): ScriptedCall => ({
  cli: { argv: ['remember', fact, '--entity', entity, ...(withProvenance ? ['--provenance', PROVENANCE, '--content-origin', 'user_said'] : [])] },
  mcp: { tool: 'remember', args: { fact, entity, ...(withProvenance ? { provenance: PROVENANCE, content_origin: 'user_said' } : {}) } },
});

function makeTask(rng: Rng, index: number, cause: G3Cause): WriteTask {
  const names = rng.shuffle(FIRST).slice(0, 3).map((f, i) => `${f} ${rng.shuffle(LAST)[i]}`);
  const firms = rng.shuffle(FIRMS).slice(0, 3);
  const [who, other] = names;
  const slug = `people/${slugify(who)}-${slugify(firms[0])}`;
  const pages = [
    { slug, markdown: person(who, `${who} works on the ${rng.pick(TEAMS)} team at ${firms[0]}.`) },
    { slug: `people/${slugify(other)}-${slugify(firms[1])}`, markdown: person(other, `${other} advises ${firms[1]}.`) },
    { slug: `companies/${slugify(firms[0])}`, markdown: note(firms[0], `${firms[0]} is a fictional company in the write-contract eval.`) },
  ];
  const id = `g3-${String(index + 1).padStart(3, '0')}-${cause}`;
  const city = rng.pick(CITIES);
  const team = rng.pick(TEAMS);
  const needs = { remember: true, items: false, sharedName: false, committedEdit: false, drift: false, commit: false, sources: false, twoWindows: false };
  const base = { id, cause, pages, stage: [] as StagedEdit[], decoys: [] as string[] };

  switch (cause) {
    case 'missing_provenance': {
      const fact = `${who} now leads the ${team} team at ${firms[0]}.`;
      return { ...base, prompt: `The user just told you in this conversation: "${fact}" Save it as a fact about ${who} (page ${slug}).`,
        target: { kind: 'fact', path: slug, values: [team] }, exposure: exposureFor(needs), naive: remember(fact, slug, false), fixed: [remember(fact, slug)] };
    }
    case 'ambiguous_entity': {
      const twinFirm = firms[1];
      const twin = `people/${slugify(who)}-${slugify(twinFirm)}`;
      pages.push({ slug: twin, markdown: person(who, `${who} is a designer at ${twinFirm}.`) });
      const fact = `${who} prefers async updates on Fridays.`;
      return { ...base, decoys: [twin], prompt: `The user just told you: "${who} from ${firms[0]} prefers async updates on Fridays." Save that as a fact about the right ${who}.`,
        target: { kind: 'fact', path: slug, values: ['async'] }, exposure: exposureFor({ ...needs, sharedName: true }),
        naive: remember(fact, who), fixed: [remember(fact, slug)] };
    }
    case 'fact_and_items': {
      const summary = `${who} agreed to pilot ${firms[2]} in ${city}.`;
      const items = [`send the ${city} pilot plan`, `book the ${team} review`, `share pricing with ${firms[2]}`].map(f => ({ fact: f, entity: slug, provenance: PROVENANCE }));
      const all = [{ fact: summary, entity: slug, provenance: PROVENANCE }, ...items];
      return { ...base, prompt: `From today's call (the user told you this directly): save the summary "${summary}" and the three action items (${items.map(i => i.fact).join('; ')}) as facts about ${slug}, in a single remember call.`,
        target: { kind: 'fact', path: slug, values: [city] }, exposure: exposureFor({ ...needs, items: true }),
        naive: { cli: { argv: ['remember', summary, '--items', JSON.stringify(items), '--provenance', PROVENANCE, '--content-origin', 'user_said'] }, mcp: { tool: 'remember', args: { fact: summary, items, provenance: PROVENANCE, content_origin: 'user_said' } } },
        fixed: [{ cli: { argv: ['remember', '--items', JSON.stringify(all), '--content-origin', 'user_said'] }, mcp: { tool: 'remember', args: { items: all, content_origin: 'user_said' } } }] };
    }
    case 'source_changed': {
      const fact = `${who} moved to ${city}.`;
      return { ...base, stage: [{ slug, line: `Edited on another machine: ${who} is hiring for ${team}.`, commit: true }],
        prompt: `The user just told you: "${fact}" Save it as a fact about ${who} (page ${slug}), and make sure it actually lands.`,
        target: { kind: 'fact', path: slug, values: [city] }, exposure: exposureFor({ ...needs, committedEdit: true }),
        naive: remember(fact, slug), fixed: [{ cli: { argv: ['sync'] }, mcp: { tool: 'sync_brain', args: { no_pull: true } } }] };
    }
    case 'scope_denied': {
      const fact = `${who} joined the ${firms[1]} advisory board.`;
      return { ...base, stage: [{ slug, line: `Unsaved local edit: ${who} is on leave until December.`, commit: false }],
        prompt: `The user just told you: "${fact}" Save it as a fact about ${who} (page ${slug}). Report exactly what happened to the write.`,
        target: { kind: 'fact', path: slug, values: ['advisory'] }, exposure: exposureFor({ ...needs, drift: true }),
        naive: remember(fact, slug), fixed: [] };
    }
    case 'commit_paths_invalid': {
      const page = `notes/${slugify(firms[2])}-pilot-${index + 1}`;
      const md = note(`${firms[2]} pilot`, `Pilot with ${firms[2]} starts in ${city}. Owner: ${who}.`);
      return { ...base, prompt: `Create the page ${page} saying the pilot with ${firms[2]} starts in ${city} with ${who} as owner, then commit and push that file with gbrain git commit-push (the brain checkout is {{checkout}}).`,
        target: { kind: 'page', path: page, values: [city] }, exposure: exposureFor({ ...needs, remember: false, commit: true }),
        naive: { cli: { argv: ['git', 'commit-push', '--path', `${page}.md`, '-m', `Add ${page}`] }, mcp: { tool: 'put_page', args: { slug: page, content: md } } },
        fixed: [{ cli: { argv: ['put', page], stdin: md } }, { cli: { argv: ['git', 'commit-push', '--path', '{{checkout}}', '-m', `Add ${page}`, '--', `${page}.md`] } }] };
    }
    case 'sources_without_brain': {
      const fact = `${firms[0]} notes live in the default source.`;
      return { ...base, prompt: `This machine serves more than one brain, so every sources command needs --brain host. Look up the id of the host brain's source with gbrain sources, then save on ${slug} the fact "${firms[0]} notes live in source <id>", with the user's request as provenance.`,
        target: { kind: 'fact', path: slug, values: ['default'] }, exposure: exposureFor({ ...needs, sources: true }),
        naive: { cli: { argv: ['sources', 'list'] }, mcp: { tool: 'sources_list', args: {} } },
        fixed: [{ cli: { argv: ['sources', 'list', '--brain', 'host'] } }, remember(fact, slug)] };
    }
    case 'two_range_read': {
      const page = `notes/${slugify(firms[0])}-board-prep`;
      const lo = rng.int(3, 8);
      const hi = rng.int(25, 34);
      const arr = `${rng.int(20, 90)}k`;
      const churn = `${rng.int(1, 6)}.${rng.int(0, 9)}%`;
      const body = Array.from({ length: 40 }, (_, i) => i + 1 === lo ? `ARR closed the quarter at ${arr}.` : i + 1 === hi ? `Monthly churn was ${churn}.` : `Board prep line ${i + 1}.`).join('\n');
      pages.push({ slug: page, markdown: note(`${firms[0]} board prep`, body) });
      const fact = `${firms[0]} ARR ${arr}, churn ${churn}.`;
      return { ...base, prompt: `Read lines ${lo - 1}-${lo + 1} and ${hi - 1}-${hi + 1} of ${page}, then save the ARR and churn figures you find there as one fact on ${slug} (the user asked for it in this conversation).`,
        target: { kind: 'fact', path: slug, values: [arr, churn] }, exposure: exposureFor({ ...needs, twoWindows: true }),
        naive: { cli: { argv: ['get', page, '--lines', `${lo - 1}-${lo + 1}`, '--lines', `${hi - 1}-${hi + 1}`] }, mcp: { tool: 'get_page', args: { slug: page, lines: { from: lo - 1, count: 3 }, bytes: { offset: 0, length: 200 } } } },
        fixed: [
          { cli: { argv: ['get', page, '--lines', `${lo - 1}-${lo + 1}`] }, mcp: { tool: 'get_page', args: { slug: page, lines: { from: lo - 1, count: 3 } } } },
          { cli: { argv: ['get', page, '--lines', `${hi - 1}-${hi + 1}`] }, mcp: { tool: 'get_page', args: { slug: page, lines: { from: hi - 1, count: 3 } } } },
          remember(fact, slug),
        ] };
    }
  }
}

/** n tasks cycling through the eight causes, each a fresh seeded variant. */
export function generateWriteTasks(opts: { seed?: number; n?: number } = {}): WriteTask[] {
  const rng = new Rng(opts.seed ?? G3_DEFAULT_SEED);
  const n = opts.n ?? G3_DEFAULT_TASKS;
  return Array.from({ length: n }, (_, i) => makeTask(rng, i, G3_CAUSES[i % G3_CAUSES.length]));
}

export function writeTasksDigest(tasks: readonly WriteTask[]): string { return fingerprint(tasks); }

/** Replace {{checkout}} in prompts and scripted calls once the brain exists. */
export function bindCheckout<T>(value: T, checkout: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll('{{checkout}}', checkout)) as T;
}

if (import.meta.main) {
  const tasks = generateWriteTasks();
  console.log(JSON.stringify({ tasks: tasks.length, digest: writeTasksDigest(tasks), by_cause: Object.fromEntries(G3_CAUSES.map(c => [c, tasks.filter(t => t.cause === c).length])) }, null, 2));
}
